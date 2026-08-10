import { z } from 'zod';
import { booleanArg, defineTool } from '../tool';
import { ok, fail, ToolFail, ToolResult } from '../result';
import { anyValued, fromScene, textOf } from './shared';
import { readAssetJson, writeAssetJson } from '../asset-json';
import { coerceJsonArg } from '../json-arg';
import {
    componentRefInPrefabData,
    compressUuid,
    dumpPrefabTree,
    addComponentToPrefabData,
    getComponentPropertyInPrefabData,
    nodeRefInPrefabData,
    removeComponentFromPrefabData,
    setComponentPropertyInPrefabData,
    NodeSelector,
    PrefabDumpNode
} from '../prefab-json';
import { planPrefabValue } from '../prefab-value';
import { applyLinkageOptions, linkageVerdict, queryAssetType, verifyPrefabLinkage } from '../prefab-linkage';
import type { DeclaredProperty } from '../prefab-value';
import type { RegisteredTool } from '../tool';
import type { ToolContext } from '../context';
import type { PrefabSyncReport, SceneResult } from '../scene-contract';

const FILE_TOOL_NOTE = 'nodePath/nodeName address a node INSIDE THE PREFAB FILE, not in the open scene — '
    + 'this tool never touches the scene and takes no node uuid.';

interface ResolvedCid {
    cid: string;
}

function selectorOf(args: { nodePath?: string; nodeName?: string }): NodeSelector {
    return { nodePath: args.nodePath, nodeName: args.nodeName };
}

async function readPrefabArray(prefabPath: string): Promise<any[]> {
    const data = await readAssetJson(prefabPath);
    if (!Array.isArray(data)) throw new Error(`${prefabPath} is not a prefab array`);
    return data;
}

/**
 * Reading the file and addressing something inside it are different failures with different fixes,
 * and the pure machinery throws the same Error type for both — so they are split by WHERE the throw
 * happened: everything after a successful parse is the caller's address, not the file.
 */
async function loadPrefab(prefabPath: string): Promise<{ data: any[] } | { failure: ToolFail }> {
    try {
        return { data: await readPrefabArray(prefabPath) };
    } catch (error) {
        return { failure: fail('prefab_unreadable', `${prefabPath}: ${textOf(error)}`) };
    }
}

function addressMiss(prefabPath: string, error: unknown): ToolFail {
    return fail('prefab_path_miss', `${prefabPath}: ${textOf(error)}`,
        'prefab_dump lists every node path in this prefab and the components on each of them.');
}

/** `__type__` is the plain name for builtins and the compressed script-asset uuid for user scripts. */
async function resolveComponentCid(
    ctx: ToolContext,
    componentType: string,
    scriptPath?: string
): Promise<ResolvedCid | { failure: ToolFail }> {
    if (componentType.startsWith('cc.')) return { cid: componentType };

    let uuid: string | undefined;
    if (scriptPath) {
        const info = await ctx.editor.assetDb.queryAssetInfo(scriptPath).catch(() => null);
        if (!info) return { failure: fail('script_not_found', `Script not found: ${scriptPath}`) };
        uuid = info.uuid;
    } else {
        const matches = await ctx.editor.assetDb
            .queryAssets({ pattern: `db://assets/**/${componentType}.ts` }).catch(() => []);
        if (!matches.length) {
            return {
                failure: fail('script_not_found',
                    `No script named '${componentType}.ts' under db://assets`,
                    'Pass scriptPath with the db:// path of the .ts declaring this class.')
            };
        }
        if (matches.length > 1) {
            return {
                failure: fail('script_ambiguous',
                    `${matches.length} scripts named '${componentType}.ts' `
                    + `(${matches.map(match => match.url).join(', ')})`,
                    'Pass scriptPath to say which one.')
            };
        }
        uuid = matches[0].uuid;
    }
    if (!uuid) {
        return { failure: fail('script_not_found', `Script asset has no uuid: ${scriptPath || componentType}`) };
    }
    return { cid: compressUuid(uuid) };
}

interface NamedComponent {
    type: string;
    scriptUuid: string | null;
    fileId: string | null;
    id: number;
    className?: string;
}

/** Script components carry only a compressed uuid; turn it back into the .ts file's class name. */
async function resolveScriptClassNames(ctx: ToolContext, tree: PrefabDumpNode[]): Promise<void> {
    const cache = new Map<string, string>();
    for (const node of tree) {
        for (const component of node.components as NamedComponent[]) {
            if (!component.scriptUuid) {
                component.className = component.type;
                continue;
            }
            if (!cache.has(component.scriptUuid)) {
                const url = await ctx.editor.assetDb.queryUrl(component.scriptUuid).catch(() => null);
                cache.set(component.scriptUuid,
                    url ? url.split('/').pop()!.replace(/\.ts$/, '') : component.type);
            }
            component.className = cache.get(component.scriptUuid);
        }
    }
}

/** The property's declared type from the scene process; null when it could not be asked. */
async function declaredProperty(
    ctx: ToolContext,
    componentType: string,
    property: string
): Promise<DeclaredProperty | null> {
    const result = await ctx.sceneScript.call('declaredComponentProperty', componentType, property)
        .catch(() => null);
    return (result && result.success) ? (result.data as unknown as DeclaredProperty) : null;
}

/** A `{__id__}` reference spelled as the node path and class it names, rather than an index. */
function describeRef(data: any[], value: any): { references: unknown } | null {
    if (!value || typeof value !== 'object' || typeof value.__id__ !== 'number') return null;
    const entry = data[value.__id__];
    if (!entry) return { references: { entry: value.__id__, resolves: false } };
    const node = dumpPrefabTree(data).find(
        candidate => candidate.id === value.__id__
            || candidate.components.some(component => component.id === value.__id__)
    );
    const component = node && node.components.find(candidate => candidate.id === value.__id__);
    return {
        references: {
            entry: value.__id__,
            type: entry.__type__,
            nodePath: node ? node.path : null,
            component: component ? component.type : null
        }
    };
}

const fileSelectorSchema = {
    prefabPath: z.string().describe('db:// path of the .prefab asset'),
    componentType: z.string().describe('Builtin type (cc.X) or script class name'),
    scriptPath: z.string().optional()
        .describe('db:// path of the .ts for a script component (disambiguates)'),
    nodePath: z.string().optional()
        .describe('Slash path of a node INSIDE THE PREFAB FILE, e.g. "Root/Muzzle" (default: root node)'),
    nodeName: z.string().optional()
        .describe('Name of a node inside the prefab file; must be unique there')
};

const fileSelectorAliases = { nodePathInPrefab: 'nodePath', assetPath: 'prefabPath' };

export const prefabGetPrefabList = defineTool({
    name: 'prefab_get_prefab_list',
    description: 'Every .prefab asset under a folder as name + db:// path + uuid + folder. One asset-db '
        + 'glob, so it stays cheap on a big project — this is the way to find out which prefabs exist '
        + 'rather than guessing a path.',
    schema: z.object({
        folder: z.string().optional().describe('Folder to search under (default db://assets)')
    }),
    async handler(args, ctx) {
        const folder = args.folder || 'db://assets';
        const pattern = folder.endsWith('/') ? `${folder}**/*.prefab` : `${folder}/**/*.prefab`;
        const assets = await ctx.editor.assetDb.queryAssets({ pattern });
        return ok(assets.map(asset => ({
            name: asset.name,
            path: asset.url,
            uuid: asset.uuid,
            folder: asset.url.substring(0, asset.url.lastIndexOf('/'))
        })));
    }
});

export const prefabDump = defineTool({
    name: 'prefab_dump',
    description: 'The node tree of a .prefab ASSET: every node\'s path, name and active flag, plus each '
        + 'component with its resolved CLASS NAME. Use this to answer "what components are on this prefab" — '
        + 'reading the .prefab file cannot answer it, because script components are stored as compressed '
        + 'uuids, never as class names, so searching the file for a class name is always a false negative.',
    schema: z.object({
        prefabPath: z.string().describe('db:// path of the .prefab asset')
    }),
    aliases: { assetPath: 'prefabPath' },
    async handler(args, ctx) {
        let tree: PrefabDumpNode[];
        try {
            tree = dumpPrefabTree(await readPrefabArray(args.prefabPath));
        } catch (error) {
            return fail('prefab_unreadable', `${args.prefabPath}: ${textOf(error)}`);
        }
        await resolveScriptClassNames(ctx, tree);
        return ok({
            prefabPath: args.prefabPath,
            nodeCount: tree.length,
            componentCount: tree.reduce((count, node) => count + node.components.length, 0),
            nodes: tree
        });
    }
});

export const prefabAddComponent = defineTool({
    name: 'prefab_add_component',
    description: 'Add a component to a node inside a .prefab ASSET on disk (not a scene node). Rewrites the '
        + 'prefab JSON directly, so every existing fileId is preserved and instances keep their overrides. '
        + 'componentType is either a builtin ("cc.MeshRenderer") or a script class name, whose script asset '
        + 'is resolved by name (pass scriptPath when the name is ambiguous). Do not have the prefab open in '
        + `prefab-edit mode while calling this. ${FILE_TOOL_NOTE}`,
    schema: z.object({
        ...fileSelectorSchema,
        properties: z.record(z.any()).optional()
            .describe('Serialized property values to write on the new component')
    }),
    aliases: fileSelectorAliases,
    async handler(args, ctx) {
        const resolved = await resolveComponentCid(ctx, args.componentType, args.scriptPath);
        if ('failure' in resolved) return resolved.failure;
        const loaded = await loadPrefab(args.prefabPath);
        if ('failure' in loaded) return loaded.failure;

        let result;
        try {
            result = addComponentToPrefabData(loaded.data, selectorOf(args), resolved.cid, args.properties || {});
        } catch (error) {
            return addressMiss(args.prefabPath, error);
        }
        try {
            await writeAssetJson(args.prefabPath, result.data);
            await ctx.editor.assetDb.refreshAsset(args.prefabPath);
        } catch (error) {
            return fail('prefab_write_failed', `${args.prefabPath}: ${textOf(error)}`);
        }
        return ok({
            prefabPath: args.prefabPath,
            componentType: args.componentType,
            cid: resolved.cid,
            componentId: result.componentId,
            fileId: result.fileId,
            entryCount: result.data.length
        }, `'${args.componentType}' added to ${args.prefabPath}`);
    }
});

export const prefabRemoveComponent = defineTool({
    name: 'prefab_remove_component',
    description: 'Remove a component from a node inside a .prefab ASSET on disk. Splices the component and '
        + 'its CompPrefabInfo out of the prefab JSON and rewrites every other __id__ so all remaining '
        + 'references stay valid. Returns the removed fileId — scenes holding instances of this prefab may '
        + `still carry overrides keyed to it. ${FILE_TOOL_NOTE}`,
    schema: z.object({
        ...fileSelectorSchema,
        occurrence: z.coerce.number().optional()
            .describe('Which one to remove when the node has several of the class (default 0)'),
        mounted: booleanArg.optional().describe('Target a component MOUNTED onto a nested prefab instance. '
            + 'Those hang off MountedComponentsInfo instead of a node\'s _components, and the node they land '
            + 'on takes its name from the nested prefab, so nodePath/nodeName cannot reach them. With this '
            + 'on, occurrence indexes the mounted ones across the whole prefab in document order.')
    }),
    aliases: fileSelectorAliases,
    async handler(args, ctx) {
        const resolved = await resolveComponentCid(ctx, args.componentType, args.scriptPath);
        if ('failure' in resolved) return resolved.failure;
        const loaded = await loadPrefab(args.prefabPath);
        if ('failure' in loaded) return loaded.failure;

        let result;
        try {
            result = removeComponentFromPrefabData(
                loaded.data, selectorOf(args), resolved.cid, args.occurrence || 0, args.mounted === true
            );
        } catch (error) {
            return addressMiss(args.prefabPath, error);
        }
        try {
            await writeAssetJson(args.prefabPath, result.data);
            await ctx.editor.assetDb.refreshAsset(args.prefabPath);
        } catch (error) {
            return fail('prefab_write_failed', `${args.prefabPath}: ${textOf(error)}`);
        }
        return ok({
            prefabPath: args.prefabPath,
            componentType: args.componentType,
            cid: resolved.cid,
            removedFileId: result.removedFileId,
            removedIds: result.removedIds,
            entryCount: result.data.length,
            ...(result.removedFileId
                ? {
                    warning: 'Scenes instancing this prefab may still hold overrides keyed to fileId '
                        + `${result.removedFileId} — grep the scenes for it.`
                }
                : {})
        }, `'${args.componentType}' removed from ${args.prefabPath}`);
    }
});

export const prefabGetComponentProperty = defineTool({
    name: 'prefab_get_component_property',
    description: 'Read one serialized property off a component inside a .prefab ASSET on disk, as the file '
        + 'holds it — the counterpart of prefab_set_component_property, and the way to check a write landed '
        + 'with the type it was meant to have (a boolean stored as the string "true" is visible here and '
        + 'nowhere else). A `{"__id__"}` reference is reported with the node path and class it names, so a '
        + `node reference reads as an address rather than an array index. ${FILE_TOOL_NOTE}`,
    schema: z.object({
        ...fileSelectorSchema,
        property: z.string().describe('Serialized property name (e.g. _shadowCastingMode, damage)'),
        occurrence: z.coerce.number().optional()
            .describe('Which component when the node has several of the class (default 0)')
    }),
    aliases: fileSelectorAliases,
    async handler(args, ctx) {
        const resolved = await resolveComponentCid(ctx, args.componentType, args.scriptPath);
        if ('failure' in resolved) return resolved.failure;
        const loaded = await loadPrefab(args.prefabPath);
        if ('failure' in loaded) return loaded.failure;
        const data = loaded.data;
        let value: any;
        try {
            value = getComponentPropertyInPrefabData(
                data, selectorOf(args), resolved.cid, args.property, args.occurrence || 0
            );
        } catch (error) {
            return addressMiss(args.prefabPath, error);
        }
        const declared = args.property.includes('.')
            ? null
            : await declaredProperty(ctx, args.componentType, args.property);
        return ok({
            prefabPath: args.prefabPath,
            componentType: args.componentType,
            property: args.property,
            exists: value !== undefined,
            value: value === undefined ? null : value,
            valueType: value === null ? 'null' : (Array.isArray(value) ? 'array' : typeof value),
            ...(describeRef(data, value) || {}),
            declaredType: declared && declared.found ? (declared.ctorName || declared.scalar) : null
        });
    }
});

export const prefabSetComponentProperty = anyValued(defineTool({
    name: 'prefab_set_component_property',
    description: 'Write one serialized property on a component inside a .prefab ASSET on disk. Values go in '
        + 'raw serialized form: scalars as-is, asset refs as {"__uuid__":"<uuid>"}, in-prefab node refs as '
        + '{"__id__":<entry index>}. Returns the previous value. A value that arrives as TEXT is read '
        + 'against the property\'s declared type instead of being stored verbatim: "true" on a boolean '
        + 'becomes true, "null" on a reference becomes null, a bare uuid on an asset field becomes '
        + '{"__uuid__":…}, and a NODE PATH inside this prefab (e.g. "char_hero/mixamorig_Spine Socket") is '
        + 'resolved to the entry it names — which is how a node or component reference is set here. Text '
        + 'that cannot be read as the declared type is refused and nothing is written. '
        + `${FILE_TOOL_NOTE}`,
    schema: z.object({
        ...fileSelectorSchema,
        property: z.string().describe('Serialized property name (e.g. _shadowCastingMode, damage)'),
        value: z.any().optional().describe('Serialized value to write'),
        occurrence: z.coerce.number().optional()
            .describe('Which component when the node has several of the class (default 0)')
    }),
    aliases: fileSelectorAliases,
    async handler(args, ctx) {
        if (args.value === undefined) {
            return fail('value_required',
                'value is required — omitting it would delete the property from the prefab',
                'Pass null explicitly to clear a reference.');
        }
        const resolved = await resolveComponentCid(ctx, args.componentType, args.scriptPath);
        if ('failure' in resolved) return resolved.failure;

        const { value: given, coerced } = coerceJsonArg(args.value);
        const loaded = await loadPrefab(args.prefabPath);
        if ('failure' in loaded) return loaded.failure;
        const data = loaded.data;
        let previous: any;
        try {
            previous = getComponentPropertyInPrefabData(
                data, selectorOf(args), resolved.cid, args.property, args.occurrence || 0
            );
        } catch (error) {
            return addressMiss(args.prefabPath, error);
        }

        const declared = args.property.includes('.')
            ? null
            : await declaredProperty(ctx, args.componentType, args.property);
        const plan = planPrefabValue(given, declared, previous, args.property);
        if (plan.kind === 'error') return fail('value_refused', plan.error);

        let value: any;
        let resolvedFrom: string | undefined;
        let result;
        try {
            if (plan.kind === 'reference') {
                if (plan.expects === 'component' && plan.componentType) {
                    const target = await resolveComponentCid(ctx, plan.componentType);
                    if ('failure' in target) return target.failure;
                    value = componentRefInPrefabData(data, plan.nodePath, target.cid);
                } else {
                    value = nodeRefInPrefabData(data, plan.nodePath);
                }
                resolvedFrom = plan.nodePath;
            } else {
                value = plan.value;
            }
            result = setComponentPropertyInPrefabData(
                data, selectorOf(args), resolved.cid, args.property, value, args.occurrence || 0
            );
        } catch (error) {
            return addressMiss(args.prefabPath, error);
        }
        try {
            await writeAssetJson(args.prefabPath, result.data);
            await ctx.editor.assetDb.refreshAsset(args.prefabPath);
        } catch (error) {
            return fail('prefab_write_failed', `${args.prefabPath}: ${textOf(error)}`);
        }
        return ok({
            prefabPath: args.prefabPath,
            componentType: args.componentType,
            property: args.property,
            previous: result.previous,
            value,
            componentId: result.componentId,
            declaredType: declared && declared.found ? (declared.ctorName || declared.scalar) : null,
            ...(resolvedFrom ? { resolvedFromPath: resolvedFrom } : {}),
            ...(plan.kind === 'value' && plan.coercedFrom
                ? { typedFrom: declared && declared.found ? 'the declared type' : 'the value already in the prefab' }
                : {}),
            ...(coerced ? { valueParsedFromString: true } : {})
        }, `${args.componentType}.${args.property} written in ${args.prefabPath}`);
    }
}), 'value');

export const prefabValidatePrefab = defineTool({
    name: 'prefab_validate_prefab',
    description: 'Structural check of a .prefab file: that it parses, is an array, opens with a cc.Prefab '
        + 'entry and holds at least one node. Reports the node and component counts with the issues found. '
        + 'It judges the file\'s SHAPE only — a prefab that passes here can still reference assets that no '
        + 'longer exist.',
    schema: z.object({
        prefabPath: z.string().describe('db:// path of the .prefab asset')
    }),
    aliases: { assetPath: 'prefabPath' },
    async handler(args) {
        let data: any;
        try {
            data = await readAssetJson(args.prefabPath);
        } catch (error) {
            const message = textOf(error);
            if (message.startsWith('Asset not found')) {
                return fail('prefab_not_found', `Prefab file does not exist: ${args.prefabPath}`);
            }
            if (error instanceof SyntaxError) {
                return fail('prefab_unparsable', `${args.prefabPath} is not valid JSON: ${message}`);
            }
            return fail('prefab_unreadable', `Failed to read ${args.prefabPath}: ${message}`);
        }

        const issues: string[] = [];
        let nodeCount = 0;
        let componentCount = 0;
        if (!Array.isArray(data)) {
            issues.push('Prefab data must be in array format');
        } else if (!data.length) {
            issues.push('Prefab data is empty');
        } else {
            if (!data[0] || data[0].__type__ !== 'cc.Prefab') {
                issues.push('The first element must be of type cc.Prefab');
            }
            for (const entry of data) {
                if (entry && entry.__type__ === 'cc.Node') nodeCount++;
                else if (entry && typeof entry.__type__ === 'string' && entry.__type__.includes('cc.')) {
                    componentCount++;
                }
            }
            if (!nodeCount) issues.push('Prefab must contain at least one node');
        }

        return ok({
            prefabPath: args.prefabPath,
            isValid: !issues.length,
            issues,
            nodeCount,
            componentCount
        }, issues.length ? 'Prefab format has issues' : 'Prefab format is valid');
    }
});

export const prefabInstantiatePrefab = defineTool({
    name: 'prefab_instantiate_prefab',
    description: 'Instantiate a prefab in the OPEN SCENE as a LINKED instance: the node keeps a PrefabInfo, '
        + 'the saved scene carries its `_prefab` block, and later edits to the prefab asset propagate to it. '
        + 'Works for a .prefab and for an FBX/glTF model, whose main asset is not instantiable — its '
        + '`gltf-scene` sub-asset is resolved from the meta and used instead. The result reports prefabLinked '
        + '(live node) and prefabLinkagePersisted (what the editor serializer emits) separately, and fails '
        + 'rather than returning a flat copy as a success.',
    schema: z.object({
        prefabPath: z.string().describe('Prefab (or FBX/glTF) asset path'),
        parentUuid: z.string().optional().describe('Parent node UUID; scene root when omitted'),
        name: z.string().optional().describe('Name for the new node; defaults to the asset\'s own name'),
        position: z.object({
            x: z.coerce.number().optional(),
            y: z.coerce.number().optional(),
            z: z.coerce.number().optional()
        }).optional().describe('Initial local position'),
        unlinkPrefab: booleanArg.optional().describe('Produce a flat, unlinked copy instead of an instance. '
            + 'The node stops tracking the asset and prefab edits no longer reach it.')
    }),
    aliases: { assetPath: 'prefabPath' },
    async handler(args, ctx) {
        const assetInfo = await ctx.editor.assetDb.queryAssetInfo(args.prefabPath).catch(() => null);
        if (!assetInfo) return fail('asset_not_found', `Asset not found: ${args.prefabPath}`);

        let assetUuid = assetInfo.uuid;
        let modelSubId: string | null = null;
        const meta = await ctx.editor.assetDb.queryAssetMeta(assetInfo.uuid).catch(() => null);
        for (const subId of Object.keys(meta?.subMetas || {})) {
            const sub = meta!.subMetas[subId];
            if (sub?.importer !== 'gltf-scene') continue;
            assetUuid = sub.uuid || `${assetInfo.uuid}@${subId}`;
            modelSubId = subId;
            break;
        }
        const usedModelPrefab = modelSubId !== null;

        const assetType = await queryAssetType(assetUuid);
        const unlinkPrefab = !!args.unlinkPrefab;
        const options: Record<string, any> = applyLinkageOptions({ assetUuid }, assetType, unlinkPrefab);
        if (args.parentUuid) options.parent = args.parentUuid;
        if (args.name) options.name = args.name;
        else if (!usedModelPrefab && assetInfo.name) options.name = assetInfo.name;
        if (args.position) options.dump = { position: { value: args.position } };

        let created;
        try {
            created = await ctx.editor.scene.createNode(options as any);
        } catch (error) {
            return fail('instantiate_failed',
                `Prefab instantiation failed for '${args.prefabPath}': ${textOf(error)}`,
                'Check that the path names a real asset and that a scene is open.');
        }
        const uuid = Array.isArray(created) ? created[0] : created;
        if (!uuid) {
            return fail('instantiate_failed',
                `create-node produced no node for '${args.prefabPath}' (asset uuid ${assetUuid})`,
                usedModelPrefab
                    ? 'The resolved gltf-scene sub-asset was not instantiable.'
                    : 'If this is an FBX/glTF model, its main asset is not directly instantiable and no '
                        + 'gltf-scene sub-asset was found to instantiate.',
                { prefabPath: args.prefabPath, assetUuidTried: assetUuid });
        }

        const verdict = linkageVerdict(await verifyPrefabLinkage(uuid), assetType, unlinkPrefab);
        const data = {
            nodeUuid: uuid,
            prefabPath: args.prefabPath,
            assetUuid,
            assetType,
            modelPrefab: usedModelPrefab,
            modelSubId,
            parentUuid: args.parentUuid ?? null,
            position: args.position ?? null,
            ...verdict.fields
        };
        if (verdict.failed) {
            return fail('prefab_unlinked', 'Prefab instantiated as an UNLINKED copy', undefined, data);
        }
        return ok(data, usedModelPrefab
            ? `Model prefab instantiated from FBX/glTF sub-asset (${assetUuid})`
            : 'Prefab instantiated successfully');
    }
});

/** Counted from the generated content: this editor build has no asset-db `read-asset` message. */
function countPrefabRefs(content: string): { ok: boolean; meshRefs: number; materialRefs: number } {
    const meshRefs = (content.match(/"_mesh"\s*:/g) || []).length;
    const materialRefs = (content.match(/"_materials"\s*:/g) || []).length;
    let parsed = false;
    try {
        parsed = Array.isArray(JSON.parse(content));
    } catch {
        parsed = false;
    }
    return { ok: parsed, meshRefs, materialRefs };
}

export const prefabCreatePrefab = defineTool({
    name: 'prefab_create_prefab',
    description: 'Write a .prefab asset from a node in the open scene, using the EDITOR\'S OWN serializer '
        + '(cce.Prefab.generatePrefabDataFromNode) — which is what preserves mesh, material and every other '
        + 'asset reference; a hand-rolled serializer dropped them and produced prefabs that rendered empty. '
        + 'The source node is NOT converted into a linked instance (unlike dragging it into the Assets '
        + 'panel), and the result says so via sourceNodeLinked.',
    schema: z.object({
        nodeUuid: z.string().describe('Source node UUID in the open scene'),
        savePath: z.string().describe('Where to write it: a full db://assets/prefabs/My.prefab, or a '
            + 'folder, in which case prefabName.prefab is appended'),
        prefabName: z.string().optional().describe('Prefab name; taken from savePath when omitted')
    }),
    aliases: { prefabPath: 'savePath' },
    async handler(args, ctx) {
        const prefabName = args.prefabName
            || (args.savePath.split('/').pop() || 'NewPrefab').replace(/\.prefab$/i, '');
        const url = args.savePath.endsWith('.prefab')
            ? args.savePath
            : `${args.savePath}/${prefabName}.prefab`;

        let generated;
        try {
            generated = await ctx.sceneScript.call('createPrefabFromNode2', args.nodeUuid);
        } catch (error) {
            return fail('prefab_data_failed', `Prefab data generation failed: ${textOf(error)}`);
        }
        if (!generated?.success || !generated.data?.prefabData) {
            return fail('prefab_data_failed',
                `The editor produced no prefab data for node ${args.nodeUuid}`
                + (generated && generated.success === false ? `: ${generated.error}` : ''));
        }

        const existed = await ctx.editor.assetDb.queryUuid(url).catch(() => null);
        let assetInfo;
        try {
            assetInfo = await ctx.editor.assetDb.createAsset(url, generated.data.prefabData, { overwrite: true });
        } catch (error) {
            return fail('prefab_write_failed', `Failed to write prefab asset '${url}': ${textOf(error)}`);
        }
        const prefabUuid = assetInfo?.uuid
            || await ctx.editor.assetDb.queryUuid(url).catch(() => null);

        const refs = countPrefabRefs(generated.data.prefabData);
        const sourceLinkage = await verifyPrefabLinkage(args.nodeUuid);
        return ok({
            prefabPath: url,
            prefabUuid,
            sourceNodeUuid: args.nodeUuid,
            overwritten: !!existed,
            meshRefs: refs.meshRefs,
            materialRefs: refs.materialRefs,
            refsPreserved: refs.ok,
            sourceNodeLinked: sourceLinkage.linked
        }, `Prefab created at ${url} (mesh refs: ${refs.meshRefs}, material refs: ${refs.materialRefs}).`
            + (sourceLinkage.linked
                ? ' Source node is linked to the prefab.'
                : ' NOTE: the source node is NOT converted into a linked prefab instance — it stays a plain '
                    + 'node with no `_prefab` block, so it will not track the new asset.'));
    }
});

const SYNC_CHANNEL_NOTE = 'Runs through cce.Prefab in the scene process, not through a scene message: '
    + '`scene:revert-prefab` is not a message this editor registers at all (it appears nowhere in the '
    + 'editor bundle), and `scene:apply-prefab` is registered but non-public, undocumented and absent from '
    + 'the typed message map, so its argument shape cannot be checked — the object the old implementation '
    + 'sent had no basis. Like every other write from this bridge, it records no undo step. The editor '
    + 'declines some of these outright and says so by ANSWERING false rather than throwing, so a refusal '
    + 'fails the call; `accepted: null` means it answered with no verdict at all and the result is '
    + 'unproven, not good.';

function syncOutcome(
    result: SceneResult<PrefabSyncReport>,
    code: string,
    verb: string
): ToolResult {
    if (!result?.success) return fromScene(result);
    const report = result.data;
    if (report.accepted === false) {
        return fail(code,
            `The editor refused to ${verb} '${report.nodeName}' (${report.nodeUuid}). Nothing was changed.`,
            'cce.Prefab answers false when it will not carry the operation out — a circular prefab '
            + 'reference, an instance the editor does not consider applicable, or a scene still loading. '
            + 'prefab_list_overrides on the same node says what the instance actually holds.',
            report);
    }
    return ok(report, report.accepted === null
        ? `Asked the editor to ${verb} '${report.nodeName}', and it answered with no verdict — confirm `
            + 'with prefab_dump or prefab_list_overrides before relying on it.'
        : `Told the editor to ${verb} '${report.nodeName}'.`);
}

export const prefabUpdatePrefab = defineTool({
    name: 'prefab_update_prefab',
    description: 'Apply a prefab INSTANCE\'s current state back onto the prefab asset it tracks, so every '
        + 'other instance of that asset picks the change up. Pass the instance ROOT node; a node that '
        + `carries no PrefabInstance is refused and the error names the root to pass. ${SYNC_CHANNEL_NOTE}`,
    schema: z.object({
        nodeUuid: z.string().describe('UUID of the prefab instance root node in the open scene'),
        prefabPath: z.string().optional().describe('The asset you expect the instance to track. Optional; '
            + 'when given, an instance tracking a different asset is refused instead of applied.')
    }),
    async handler(args, ctx) {
        if (args.prefabPath) {
            const expected = await ctx.editor.assetDb.queryUuid(args.prefabPath).catch(() => null);
            if (!expected) return fail('asset_not_found', `Prefab not found: ${args.prefabPath}`);
            const linkage = await ctx.sceneScript.call('nodePrefabLinkage', args.nodeUuid).catch(() => null);
            const tracked = linkage?.success ? linkage.data.asset : null;
            if (tracked && tracked !== expected) {
                return fail('prefab_mismatch',
                    `Node ${args.nodeUuid} tracks prefab ${tracked}, not ${args.prefabPath} (${expected})`,
                    'Drop prefabPath to apply onto the asset the instance actually tracks.');
            }
        }
        return syncOutcome(
            await ctx.sceneScript.call('applyPrefabToAsset', args.nodeUuid),
            'apply_refused', 'apply');
    }
});

export const prefabRevertPrefab = defineTool({
    name: 'prefab_revert_prefab',
    description: 'Throw away a prefab instance\'s local changes and return it to the asset\'s state. This '
        + 'discards the whole override set — the designer\'s transform, materials and added components '
        + 'included; prefab_remove_override drops one record instead. Pass the instance ROOT node. '
        + `${SYNC_CHANNEL_NOTE}`,
    schema: z.object({
        nodeUuid: z.string().describe('UUID of the prefab instance root node in the open scene')
    }),
    async handler(args, ctx) {
        return syncOutcome(
            await ctx.sceneScript.call('revertPrefabInstance', args.nodeUuid),
            'revert_refused', 'revert');
    }
});

export const prefabRestorePrefabNode = defineTool({
    name: 'prefab_restore_prefab_node',
    description: 'Rebuild a prefab-instance node from a prefab asset through the editor\'s own '
        + '`scene:restore-prefab`, which is the one prefab operation here that DOES record an undo step. '
        + 'The message is called POSITIONALLY (nodeUuid, assetUuid) — as the editor\'s own documented '
        + 'example spells it. `@cocos/creator-types` declares it taking a single {uuid} object, a copy of '
        + 'the reset-component entry above it in the same map; that declaration is wrong and following it '
        + 'would drop the asset uuid. Like revert, this discards local changes to the instance.',
    schema: z.object({
        nodeUuid: z.string().describe('Prefab instance node UUID in the open scene'),
        assetUuid: z.string().describe('Prefab asset UUID to restore from')
    }),
    async handler(args, ctx) {
        let answer: unknown;
        try {
            answer = await ctx.editor.scene.restorePrefab(args.nodeUuid, args.assetUuid);
        } catch (error) {
            return fail('restore_failed', `Prefab node restore failed: ${textOf(error)}`);
        }
        const accepted = typeof answer === 'boolean' ? answer : null;
        const report = { nodeUuid: args.nodeUuid, assetUuid: args.assetUuid, accepted };
        if (accepted === false) {
            return fail('restore_refused',
                `The editor refused to restore node ${args.nodeUuid} from prefab ${args.assetUuid}. `
                + 'Nothing was changed.',
                'restore-prefab answers false when the node is not an instance of that asset, or the asset '
                + 'uuid does not resolve. Check both against prefab_list_overrides and prefab_get_prefab_list.',
                report);
        }
        return ok(report, accepted === null
            ? 'Asked the editor to restore the prefab node, and it answered with no verdict — confirm the '
                + 'node before relying on it.'
            : 'Prefab node restored');
    }
});

export const prefabListOverrides = defineTool({
    name: 'prefab_list_overrides',
    description: 'Every property override on a prefab-instance node in the CURRENT SCENE: the property path, '
        + 'which node or component inside the instance it targets, the value, and for an asset reference '
        + 'whether that uuid still resolves in the asset database. Overrides are appended as the scene is '
        + 'edited and are never re-derived on save, so a record survives a reimport that revoked the sub-uuid '
        + 'it points at — the source of "The asset <uuid>@<sub> is missing!" at every preview run. Judge '
        + 'liveness by assetExists, not by the value shown: the engine cache still hands back reimported '
        + 'assets under their old uuid. Pass the INSTANCE ROOT node; the error names it if you pass a node '
        + 'inside the instance.',
    schema: z.object({
        nodeUuid: z.string().describe('UUID of the prefab instance root node in the open scene')
    }),
    async handler(args, ctx) {
        const result = await ctx.sceneScript.call('listPrefabOverrides', args.nodeUuid);
        if (!result?.success) return fromScene(result);

        const overrides: any[] = result.data.overrides || [];
        const uuids = Array.from(new Set(overrides.map(entry => entry.assetUuid).filter(Boolean)));
        const known = new Map<string, unknown>();
        for (const uuid of uuids) {
            known.set(uuid, await ctx.editor.assetDb.queryAssetInfo(uuid).catch(() => null));
        }
        let deadAssetRefs = 0;
        for (const entry of overrides) {
            if (!entry.assetUuid) continue;
            const info: any = known.get(entry.assetUuid);
            entry.assetExists = !!info;
            entry.assetUrl = info ? info.url : null;
            if (!info) deadAssetRefs++;
        }
        return ok({ ...result.data, deadAssetRefs });
    }
});

export const prefabRemoveOverride = defineTool({
    name: 'prefab_remove_override',
    description: 'Remove ONE property override from a prefab instance by property path, leaving every other '
        + 'override in place — unlike prefab_restore_prefab_node and prefab_revert_prefab, which discard the '
        + 'whole set including the designer\'s transform, materials and added components. The record is '
        + 'spliced off the live instance and the editor reserialises the scene, so __id__ numbering is '
        + 'regenerated rather than hand-patched. Saves the scene unless save:false. When one path matches '
        + 'several records (the same property on two child nodes) the call is refused and lists the '
        + 'candidates — disambiguate with localID or index, both from prefab_list_overrides.',
    schema: z.object({
        nodeUuid: z.string().describe('UUID of the prefab instance root node in the open scene'),
        propertyPath: z.string()
            .describe('Dot-joined path exactly as prefab_list_overrides reports it, e.g. "_clips.2" or "_lpos"'),
        localID: z.string().optional()
            .describe('targetInfo fileId of the node/component, to disambiguate between same-path records'),
        index: z.coerce.number().optional()
            .describe('Override index from prefab_list_overrides — the other way to disambiguate'),
        save: booleanArg.optional()
            .describe('Save the scene after removing (default true). Pass false to batch several removals.')
    }),
    async handler(args, ctx) {
        const result = await ctx.sceneScript.call(
            'removePrefabOverride', args.nodeUuid, args.propertyPath, args.localID, args.index
        );
        if (!result?.success) return fromScene(result);
        if (args.save === false) return ok({ ...result.data, saved: false });
        try {
            await ctx.editor.scene.saveScene();
        } catch (error) {
            return fail('save_failed', `Override removed but saving the scene failed: ${textOf(error)}`,
                undefined, { ...result.data, saved: false });
        }
        return ok({ ...result.data, saved: true });
    }
});

export const prefabTools: RegisteredTool[] = [
    prefabGetPrefabList,
    prefabDump,
    prefabAddComponent,
    prefabRemoveComponent,
    prefabGetComponentProperty,
    prefabSetComponentProperty,
    prefabValidatePrefab,
    prefabInstantiatePrefab,
    prefabCreatePrefab,
    prefabUpdatePrefab,
    prefabRevertPrefab,
    prefabRestorePrefabNode,
    prefabListOverrides,
    prefabRemoveOverride
];
