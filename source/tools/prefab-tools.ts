import { ToolDefinition, ToolResponse, ToolExecutor, PrefabInfo } from '../types';
import { readAssetJson, writeAssetJson } from '../asset-json';
import { ANY_VALUE_TYPE, coerceJsonArg } from '../json-arg';
import {
    compressUuid,
    dumpPrefabTree,
    addComponentToPrefabData,
    removeComponentFromPrefabData,
    setComponentPropertyInPrefabData,
    getComponentPropertyInPrefabData,
    nodeRefInPrefabData,
    componentRefInPrefabData
} from '../prefab-json';
import { DeclaredProperty, planPrefabValue } from '../prefab-value';
import { applyLinkageOptions, linkageVerdict, queryAssetType, verifyPrefabLinkage } from '../prefab-linkage';

export class PrefabTools implements ToolExecutor {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'get_prefab_list',
                description: 'Get all prefabs in the project',
                inputSchema: {
                    type: 'object',
                    properties: {
                        folder: {
                            type: 'string',
                            description: 'Folder path to search (optional)',
                            default: 'db://assets'
                        }
                    }
                }
            },
            {
                name: 'instantiate_prefab',
                description: 'Instantiate a prefab in the scene as a LINKED instance: the node keeps a '
                    + 'PrefabInfo, the saved scene carries its `_prefab` block, and later edits to the '
                    + 'prefab asset propagate to it. Works for a .prefab and for an FBX/glTF model (its '
                    + 'gltf-scene sub-asset). The result reports prefabLinked (live node) and '
                    + 'prefabLinkagePersisted (what the editor serializer emits) separately, and fails '
                    + 'rather than returning a flat copy as a success.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        prefabPath: {
                            type: 'string',
                            description: 'Prefab asset path'
                        },
                        parentUuid: {
                            type: 'string',
                            description: 'Parent node UUID (optional)'
                        },
                        position: {
                            type: 'object',
                            description: 'Initial position',
                            properties: {
                                x: { type: 'number' },
                                y: { type: 'number' },
                                z: { type: 'number' }
                            }
                        },
                        unlinkPrefab: {
                            type: 'boolean',
                            description: 'Produce a flat, unlinked copy instead of an instance. The node '
                                + 'stops tracking the asset and prefab edits no longer reach it.',
                            default: false
                        }
                    },
                    required: ['prefabPath']
                }
            },
            {
                name: 'create_prefab',
                description: 'Create a prefab from a node with all children and components',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: {
                            type: 'string',
                            description: 'Source node UUID'
                        },
                        savePath: {
                            type: 'string',
                            description: 'Path to save the prefab (e.g., db://assets/prefabs/MyPrefab.prefab)'
                        },
                        prefabName: {
                            type: 'string',
                            description: 'Prefab name'
                        }
                    },
                    required: ['nodeUuid', 'savePath', 'prefabName']
                }
            },
            {
                name: 'update_prefab',
                description: 'Update an existing prefab',
                inputSchema: {
                    type: 'object',
                    properties: {
                        prefabPath: {
                            type: 'string',
                            description: 'Prefab asset path'
                        },
                        nodeUuid: {
                            type: 'string',
                            description: 'Node UUID with changes'
                        }
                    },
                    required: ['prefabPath', 'nodeUuid']
                }
            },
            {
                name: 'revert_prefab',
                description: 'Revert prefab instance to original',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: {
                            type: 'string',
                            description: 'Prefab instance node UUID'
                        }
                    },
                    required: ['nodeUuid']
                }
            },
            {
                name: 'validate_prefab',
                description: 'Validate a prefab file format',
                inputSchema: {
                    type: 'object',
                    properties: {
                        prefabPath: {
                            type: 'string',
                            description: 'Prefab asset path'
                        }
                    },
                    required: ['prefabPath']
                }
            },
            {
                name: 'restore_prefab_node',
                description: 'Restore prefab node using prefab asset (built-in undo record)',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: {
                            type: 'string',
                            description: 'Prefab instance node UUID'
                        },
                        assetUuid: {
                            type: 'string',
                            description: 'Prefab asset UUID'
                        }
                    },
                    required: ['nodeUuid', 'assetUuid']
                }
            },
            {
                name: 'dump',
                description: 'The node tree of a .prefab ASSET: every node\'s path, name and active flag, plus each ' +
                    'component with its resolved CLASS NAME. Use this to answer "what components are on this prefab" — ' +
                    'reading the .prefab file cannot answer it, because script components are stored as compressed ' +
                    'uuids, never as class names, so searching the file for a class name is always a false negative.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        prefabPath: { type: 'string', description: 'db:// path of the .prefab asset' }
                    },
                    required: ['prefabPath']
                }
            },
            {
                name: 'add_component',
                description: 'Add a component to a node inside a .prefab ASSET on disk (not a scene node). Rewrites the ' +
                    'prefab JSON directly, so every existing fileId is preserved and instances keep their overrides. ' +
                    'componentType is either a builtin ("cc.MeshRenderer") or a script class name, whose script asset ' +
                    'is resolved by name (pass scriptPath when the name is ambiguous). Do not have the prefab open in ' +
                    'prefab-edit mode while calling this.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        prefabPath: { type: 'string', description: 'db:// path of the .prefab asset' },
                        componentType: { type: 'string', description: 'Builtin type (cc.X) or script class name' },
                        scriptPath: { type: 'string', description: 'db:// path of the .ts for a script component (disambiguates)' },
                        nodePath: { type: 'string', description: 'Slash path inside the prefab, e.g. "Root/Muzzle" (default: root node)' },
                        nodeName: { type: 'string', description: 'Node name inside the prefab; must be unique' },
                        properties: { type: 'object', description: 'Serialized property values to write on the new component' }
                    },
                    required: ['prefabPath', 'componentType']
                }
            },
            {
                name: 'remove_component',
                description: 'Remove a component from a node inside a .prefab ASSET on disk. Splices the component and its ' +
                    'CompPrefabInfo out of the prefab JSON and rewrites every other __id__ so all remaining references ' +
                    'stay valid. Returns the removed fileId — scenes holding instances of this prefab may still carry ' +
                    'overrides keyed to it.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        prefabPath: { type: 'string', description: 'db:// path of the .prefab asset' },
                        componentType: { type: 'string', description: 'Builtin type (cc.X) or script class name' },
                        scriptPath: { type: 'string', description: 'db:// path of the .ts for a script component (disambiguates)' },
                        nodePath: { type: 'string', description: 'Slash path inside the prefab (default: root node)' },
                        nodeName: { type: 'string', description: 'Node name inside the prefab; must be unique' },
                        occurrence: { type: 'number', description: 'Which one to remove when the node has several of the class (default 0)' },
                        mounted: { type: 'boolean', description: 'Target a component MOUNTED onto a nested prefab instance. Those hang off MountedComponentsInfo instead of a node\'s _components, and the node they land on takes its name from the nested prefab, so nodePath/nodeName cannot reach them. With this on, occurrence indexes the mounted ones across the whole prefab in document order.' }
                    },
                    required: ['prefabPath', 'componentType']
                }
            },
            {
                name: 'set_component_property',
                description: 'Write one serialized property on a component inside a .prefab ASSET on disk. Values go in ' +
                    'raw serialized form: scalars as-is, asset refs as {"__uuid__":"<uuid>"}, in-prefab node refs as ' +
                    '{"__id__":<entry index>}. Returns the previous value. A value that arrives as TEXT is read ' +
                    'against the property\'s declared type instead of being stored verbatim: "true" on a boolean ' +
                    'becomes true, "null" on a reference becomes null, a bare uuid on an asset field becomes ' +
                    '{"__uuid__":…}, and a NODE PATH inside this prefab (e.g. "char_hero/mixamorig_Spine Socket") is ' +
                    'resolved to the entry it names — which is how a node or component reference is set here. Text ' +
                    'that cannot be read as the declared type is refused and nothing is written.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        prefabPath: { type: 'string', description: 'db:// path of the .prefab asset' },
                        componentType: { type: 'string', description: 'Builtin type (cc.X) or script class name' },
                        scriptPath: { type: 'string', description: 'db:// path of the .ts for a script component (disambiguates)' },
                        nodePath: { type: 'string', description: 'Slash path inside the prefab (default: root node)' },
                        nodeName: { type: 'string', description: 'Node name inside the prefab; must be unique' },
                        property: { type: 'string', description: 'Serialized property name (e.g. _shadowCastingMode, damage)' },
                        value: { type: ANY_VALUE_TYPE, description: 'Serialized value to write' },
                        occurrence: { type: 'number', description: 'Which component when the node has several of the class (default 0)' }
                    },
                    required: ['prefabPath', 'componentType', 'property']
                }
            },
            {
                name: 'get_component_property',
                description: 'Read one serialized property off a component inside a .prefab ASSET on disk, as the ' +
                    'file holds it — the counterpart of set_component_property, and the way to check a write ' +
                    'landed with the type it was meant to have (a boolean stored as the string "true" is visible ' +
                    'here and nowhere else). A `{"__id__"}` reference is reported with the node path and class it ' +
                    'names, so a node reference reads as an address rather than an array index.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        prefabPath: { type: 'string', description: 'db:// path of the .prefab asset' },
                        componentType: { type: 'string', description: 'Builtin type (cc.X) or script class name' },
                        scriptPath: { type: 'string', description: 'db:// path of the .ts for a script component (disambiguates)' },
                        nodePath: { type: 'string', description: 'Slash path inside the prefab (default: root node)' },
                        nodeName: { type: 'string', description: 'Node name inside the prefab; must be unique' },
                        property: { type: 'string', description: 'Serialized property name (e.g. _shadowCastingMode, damage)' },
                        occurrence: { type: 'number', description: 'Which component when the node has several of the class (default 0)' }
                    },
                    required: ['prefabPath', 'componentType', 'property']
                }
            },
            {
                name: 'list_overrides',
                description: 'Every property override on a prefab-instance node in the CURRENT SCENE: the property path, ' +
                    'which node or component inside the instance it targets, the value, and for an asset reference whether ' +
                    'that uuid still resolves in the asset database. Overrides are appended as the scene is edited and are ' +
                    'never re-derived on save, so a record survives a reimport that revoked the sub-uuid it points at — the ' +
                    'source of "The asset <uuid>@<sub> is missing!" at every preview run. Judge liveness by assetExists, ' +
                    'not by the value shown: the engine cache still hands back reimported assets under their old uuid. ' +
                    'Pass the INSTANCE ROOT node; the error names it if you pass a node inside the instance.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: { type: 'string', description: 'UUID of the prefab instance root node in the open scene' }
                    },
                    required: ['nodeUuid']
                }
            },
            {
                name: 'remove_override',
                description: 'Remove ONE property override from a prefab instance by property path, leaving every other ' +
                    'override in place — unlike restore_prefab_node, which discards the whole ' +
                    'set including the designer\'s transform, materials and added components. The record is spliced off the ' +
                    'live instance and the editor reserialises the scene, so __id__ numbering is regenerated rather than ' +
                    'hand-patched. Saves the scene unless save:false. When one path matches several records (the same ' +
                    'property on two child nodes) the call is refused and lists the candidates — disambiguate with localID ' +
                    'or index, both from list_overrides.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: { type: 'string', description: 'UUID of the prefab instance root node in the open scene' },
                        propertyPath: {
                            type: 'string',
                            description: 'Dot-joined path exactly as list_overrides reports it, e.g. "_clips.2" or "_lpos"'
                        },
                        localID: {
                            type: 'string',
                            description: 'targetInfo fileId of the node/component to disambiguate between same-path records'
                        },
                        index: {
                            type: 'number',
                            description: 'Override index from list_overrides — the other way to disambiguate'
                        },
                        save: {
                            type: 'boolean',
                            default: true,
                            description: 'Save the scene after removing. Pass false to batch several removals and save once.'
                        }
                    },
                    required: ['nodeUuid', 'propertyPath']
                }
            }
        ];
    }

    async execute(toolName: string, args: any): Promise<ToolResponse> {
        switch (toolName) {
            case 'get_prefab_list':
                return await this.getPrefabList(args.folder);
            case 'instantiate_prefab':
                return await this.instantiatePrefab(args);
            case 'create_prefab':
                return await this.createPrefab(args);
            case 'update_prefab':
                return await this.updatePrefab(args.prefabPath, args.nodeUuid);
            case 'revert_prefab':
                return await this.revertPrefab(args.nodeUuid);
            case 'validate_prefab':
                return await this.validatePrefab(args.prefabPath);
            case 'restore_prefab_node':
                return await this.restorePrefabNode(args.nodeUuid, args.assetUuid);
            case 'dump':
                return await this.dumpPrefabAsset(args.prefabPath);
            case 'add_component':
                return await this.addComponentToAsset(args);
            case 'remove_component':
                return await this.removeComponentFromAsset(args);
            case 'set_component_property':
                return await this.setComponentPropertyOnAsset(args);
            case 'get_component_property':
                return await this.getComponentPropertyOnAsset(args);
            case 'list_overrides':
                return await this.listOverrides(args.nodeUuid);
            case 'remove_override':
                return await this.removeOverride(args);
            default:
                throw new Error(`Unknown tool: ${toolName}`);
        }
    }

    /**
     * Property overrides of a scene prefab instance, each asset reference checked against the asset
     * database. Liveness cannot be judged in the scene process: the engine keeps a reimported asset
     * cached under the uuid it used to have, so a revoked sub-uuid still resolves to a live object
     * there while the runtime loader — and every preview run — reports it missing.
     */
    private async listOverrides(nodeUuid: string): Promise<ToolResponse> {
        const res = await this.runSceneMethod('listPrefabOverrides', [nodeUuid]);
        if (!res.success || !res.data) return res;
        const overrides: any[] = res.data.overrides || [];
        const uuids = Array.from(new Set(overrides.map(o => o.assetUuid).filter(Boolean)));
        const known = new Map<string, any>();
        for (const uuid of uuids) {
            try {
                known.set(uuid, await Editor.Message.request('asset-db', 'query-asset-info', uuid));
            } catch {
                known.set(uuid, null);
            }
        }
        let deadCount = 0;
        for (const o of overrides) {
            if (!o.assetUuid) continue;
            const info = known.get(o.assetUuid);
            o.assetExists = !!info;
            o.assetUrl = info ? info.url : null;
            if (!info) deadCount++;
        }
        return { success: true, data: { ...res.data, deadAssetRefs: deadCount } };
    }

    /** Remove one override record and, by default, save the scene so the record stops being serialised. */
    private async removeOverride(args: any): Promise<ToolResponse> {
        const res = await this.runSceneMethod('removePrefabOverride', [
            args.nodeUuid, args.propertyPath, args.localID, args.index
        ]);
        if (!res.success) return res;
        const save = args.save !== false;
        if (!save) return { success: true, data: { ...res.data, saved: false } };
        try {
            await Editor.Message.request('scene', 'save-scene');
        } catch (err: any) {
            return { success: false, error: `Override removed but saving the scene failed: ${err.message || String(err)}` };
        }
        return { success: true, data: { ...res.data, saved: true } };
    }

    /** Route to a scene.ts method (engine context) and pass its ToolResponse straight through. */
    private async runSceneMethod(method: string, args: any[]): Promise<ToolResponse> {
        try {
            const result: any = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'cocos-mcp-server',
                method,
                args
            });
            if (result && typeof result === 'object' && 'success' in result) {
                return result as ToolResponse;
            }
            return { success: true, data: result };
        } catch (err: any) {
            return { success: false, error: err.message || String(err) };
        }
    }

    /** `__type__` is the plain name for builtins and the compressed script-asset uuid for user scripts. */
    private async resolveComponentCid(componentType: string, scriptPath?: string): Promise<string> {
        if (componentType.startsWith('cc.')) return componentType;
        let info: any = null;
        if (scriptPath) {
            info = await Editor.Message.request('asset-db', 'query-asset-info', scriptPath);
            if (!info) throw new Error(`Script not found: ${scriptPath}`);
        } else {
            const matches: any[] = await Editor.Message.request('asset-db', 'query-assets', {
                pattern: `db://assets/**/${componentType}.ts`
            });
            if (!matches || !matches.length) {
                throw new Error(`No script named '${componentType}.ts' under db://assets — pass scriptPath`);
            }
            if (matches.length > 1) {
                throw new Error(`${matches.length} scripts named '${componentType}.ts' (${matches.map((m: any) => m.url).join(', ')}) — pass scriptPath`);
            }
            info = matches[0];
        }
        if (!info.uuid) throw new Error(`Script asset has no uuid: ${scriptPath || componentType}`);
        return compressUuid(info.uuid);
    }

    private selectorOf(args: any): any {
        return { nodePath: args.nodePath, nodeName: args.nodeName, nodeId: args.nodeId };
    }

    private async readPrefabArray(prefabPath: string): Promise<any[]> {
        const data = await readAssetJson(prefabPath);
        if (!Array.isArray(data)) throw new Error(`${prefabPath} is not a prefab array`);
        return data;
    }

    /** Script components carry only a compressed uuid; turn it back into the .ts file's class name. */
    private async resolveScriptClassNames(tree: any[]): Promise<void> {
        const cache = new Map<string, string>();
        for (const node of tree) {
            for (const comp of node.components) {
                if (!comp.scriptUuid) {
                    comp.className = comp.type;
                    continue;
                }
                if (!cache.has(comp.scriptUuid)) {
                    let name: string = comp.type;
                    try {
                        const url: string | null = await Editor.Message.request('asset-db', 'query-url', comp.scriptUuid);
                        if (url) name = url.split('/').pop()!.replace(/\.ts$/, '');
                    } catch {
                        // unresolvable script asset: fall back to the raw id
                    }
                    cache.set(comp.scriptUuid, name);
                }
                comp.className = cache.get(comp.scriptUuid);
            }
        }
    }

    private async dumpPrefabAsset(prefabPath: string): Promise<ToolResponse> {
        try {
            const data = await this.readPrefabArray(prefabPath);
            const tree = dumpPrefabTree(data);
            await this.resolveScriptClassNames(tree);
            return {
                success: true,
                data: {
                    prefabPath,
                    nodeCount: tree.length,
                    componentCount: tree.reduce((n, node) => n + node.components.length, 0),
                    nodes: tree
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message || String(error) };
        }
    }

    private async addComponentToAsset(args: any): Promise<ToolResponse> {
        try {
            const data = await this.readPrefabArray(args.prefabPath);
            const cid = await this.resolveComponentCid(args.componentType, args.scriptPath);
            const result = addComponentToPrefabData(data, this.selectorOf(args), cid, args.properties || {});
            await writeAssetJson(args.prefabPath, result.data);
            await Editor.Message.request('asset-db', 'refresh-asset', args.prefabPath);
            return {
                success: true,
                data: {
                    prefabPath: args.prefabPath,
                    componentType: args.componentType,
                    cid,
                    componentId: result.componentId,
                    fileId: result.fileId,
                    entryCount: result.data.length
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message || String(error) };
        }
    }

    private async removeComponentFromAsset(args: any): Promise<ToolResponse> {
        try {
            const data = await this.readPrefabArray(args.prefabPath);
            const cid = await this.resolveComponentCid(args.componentType, args.scriptPath);
            const result = removeComponentFromPrefabData(data, this.selectorOf(args), cid, args.occurrence || 0, args.mounted === true);
            await writeAssetJson(args.prefabPath, result.data);
            await Editor.Message.request('asset-db', 'refresh-asset', args.prefabPath);
            return {
                success: true,
                data: {
                    prefabPath: args.prefabPath,
                    componentType: args.componentType,
                    cid,
                    removedFileId: result.removedFileId,
                    removedIds: result.removedIds,
                    entryCount: result.data.length,
                    warning: result.removedFileId
                        ? `Scenes instancing this prefab may still hold overrides keyed to fileId ${result.removedFileId} — grep the scenes for it.`
                        : undefined
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message || String(error) };
        }
    }

    private async setComponentPropertyOnAsset(args: any): Promise<ToolResponse> {
        try {
            if (!('value' in args)) {
                return { success: false, error: 'value is required — omitting it would delete the property from the prefab' };
            }
            const { value: given, coerced } = coerceJsonArg(args.value);
            const data = await this.readPrefabArray(args.prefabPath);
            const cid = await this.resolveComponentCid(args.componentType, args.scriptPath);

            // What the property is has to be settled before the write: text that arrived for a
            // boolean, a reference or an asset is not the value, and storing it would be a wrong
            // write the tool could only report as a success.
            const previous = getComponentPropertyInPrefabData(
                data, this.selectorOf(args), cid, args.property, args.occurrence || 0
            );
            const declared = args.property.includes('.')
                ? null
                : await this.declaredProperty(args.componentType, args.property);
            const plan = planPrefabValue(given, declared, previous, args.property);
            if (plan.kind === 'error') return { success: false, error: plan.error };

            let value: any;
            let resolvedFrom: string | undefined;
            if (plan.kind === 'reference') {
                value = plan.expects === 'component' && plan.componentType
                    ? componentRefInPrefabData(data, plan.nodePath, await this.resolveComponentCid(plan.componentType))
                    : nodeRefInPrefabData(data, plan.nodePath);
                resolvedFrom = plan.nodePath;
            } else {
                value = plan.value;
            }

            const result = setComponentPropertyInPrefabData(
                data, this.selectorOf(args), cid, args.property, value, args.occurrence || 0
            );
            await writeAssetJson(args.prefabPath, result.data);
            await Editor.Message.request('asset-db', 'refresh-asset', args.prefabPath);
            return {
                success: true,
                data: {
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
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message || String(error) };
        }
    }

    private async getComponentPropertyOnAsset(args: any): Promise<ToolResponse> {
        try {
            const data = await this.readPrefabArray(args.prefabPath);
            const cid = await this.resolveComponentCid(args.componentType, args.scriptPath);
            const value = getComponentPropertyInPrefabData(
                data, this.selectorOf(args), cid, args.property, args.occurrence || 0
            );
            const declared = args.property.includes('.')
                ? null
                : await this.declaredProperty(args.componentType, args.property);
            return {
                success: true,
                data: {
                    prefabPath: args.prefabPath,
                    componentType: args.componentType,
                    property: args.property,
                    exists: value !== undefined,
                    value: value === undefined ? null : value,
                    valueType: value === null ? 'null' : (Array.isArray(value) ? 'array' : typeof value),
                    ...(this.describeRef(data, value) || {}),
                    declaredType: declared && declared.found ? (declared.ctorName || declared.scalar) : null
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message || String(error) };
        }
    }

    /** A `{__id__}` reference spelled as the node path and class it names, rather than an index. */
    private describeRef(data: any[], value: any): { references: any } | null {
        if (!value || typeof value !== 'object' || typeof value.__id__ !== 'number') return null;
        const entry = data[value.__id__];
        if (!entry) return { references: { entry: value.__id__, resolves: false } };
        const node = dumpPrefabTree(data).find(
            (n) => n.id === value.__id__ || n.components.some((comp) => comp.id === value.__id__)
        );
        const component = node && node.components.find((comp) => comp.id === value.__id__);
        return {
            references: {
                entry: value.__id__,
                type: entry.__type__,
                nodePath: node ? node.path : null,
                component: component ? component.type : null
            }
        };
    }

    /** The property's declared type from the scene process; null when it could not be asked. */
    private async declaredProperty(componentType: string, property: string): Promise<DeclaredProperty | null> {
        const res = await this.runSceneMethod('declaredComponentProperty', [componentType, property]);
        return (res && res.success && res.data) ? (res.data as DeclaredProperty) : null;
    }

    private async getPrefabList(folder: string = 'db://assets'): Promise<ToolResponse> {
        return new Promise((resolve) => {
            const pattern = folder.endsWith('/') ?
                `${folder}**/*.prefab` : `${folder}/**/*.prefab`;

            Editor.Message.request('asset-db', 'query-assets', {
                pattern: pattern
            }).then((results: any[]) => {
                const prefabs: PrefabInfo[] = results.map(asset => ({
                    name: asset.name,
                    path: asset.url,
                    uuid: asset.uuid,
                    folder: asset.url.substring(0, asset.url.lastIndexOf('/'))
                }));
                resolve({ success: true, data: prefabs });
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async instantiatePrefab(args: any): Promise<ToolResponse> {
        return new Promise(async (resolve) => {
            try {
                // An FBX/glTF's main asset is not instantiable; the drop target is its 'gltf-scene' sub-asset.
                const assetInfo = await Editor.Message.request('asset-db', 'query-asset-info', args.prefabPath);
                if (!assetInfo) {
                    throw new Error('Asset not found');
                }

                let assetUuid: string = assetInfo.uuid;
                let usedModelPrefab = false;
                let modelSubId: string | null = null;
                try {
                    const meta: any = await Editor.Message.request('asset-db', 'query-asset-meta', assetInfo.uuid);
                    const subMetas = (meta && meta.subMetas) ? meta.subMetas : {};
                    for (const sid of Object.keys(subMetas)) {
                        const sm = subMetas[sid];
                        // 'gltf-scene' is the model's embedded prefab (what dragging the FBX creates).
                        if (sm && sm.importer === 'gltf-scene') {
                            assetUuid = sm.uuid || `${assetInfo.uuid}@${sid}`;
                            modelSubId = sid;
                            usedModelPrefab = true;
                            break;
                        }
                    }
                } catch { /* no meta / not a model container — instantiate the main asset */ }

                // Tell create-node what the asset is. Without it the editor strips the PrefabInfo
                // and the instance is a flat copy — see prefab-linkage.ts.
                const assetType = await queryAssetType(assetUuid);
                const unlinkPrefab = !!args.unlinkPrefab;
                const createNodeOptions: any = applyLinkageOptions({ assetUuid }, assetType, unlinkPrefab);
                if (args.parentUuid) {
                    createNodeOptions.parent = args.parentUuid;
                }
                // For a model prefab let create-node use the model's own name (e.g. "Weapon_Crusher_Hammer"),
                // not the ".fbx" file name. For a plain prefab keep the previous naming behaviour.
                if (args.name) {
                    createNodeOptions.name = args.name;
                } else if (!usedModelPrefab && assetInfo.name) {
                    createNodeOptions.name = assetInfo.name;
                }
                if (args.position) {
                    createNodeOptions.dump = { position: { value: args.position } };
                }

                const nodeUuid = await Editor.Message.request('scene', 'create-node', createNodeOptions);
                const uuid = Array.isArray(nodeUuid) ? nodeUuid[0] : nodeUuid;

                // Verify a node was actually created. create-node returns null for a non-instantiable
                // asset — report that as a failure instead of a misleading success with no nodeUuid.
                if (!uuid) {
                    resolve({
                        success: false,
                        error: `create-node produced no node for '${args.prefabPath}' (asset uuid ${assetUuid}). ` +
                            (usedModelPrefab
                                ? 'The resolved gltf-scene sub-asset was not instantiable.'
                                : 'If this is an FBX/glTF model, its main asset is not directly instantiable and no gltf-scene sub-asset was found to instantiate.'),
                        data: { prefabPath: args.prefabPath, assetUuidTried: assetUuid }
                    });
                    return;
                }

                // Linkage is reported, never assumed, and from both the live node and the
                // serializer — reporting success for a flat copy is what kept this invisible.
                const linkage = await verifyPrefabLinkage(uuid);
                const verdict = linkageVerdict(linkage, assetType, unlinkPrefab);
                resolve({
                    success: !verdict.failed,
                    ...(verdict.failed ? { error: 'Prefab instantiated as an UNLINKED copy' } : {}),
                    data: {
                        nodeUuid: uuid,
                        prefabPath: args.prefabPath,
                        assetUuid,
                        assetType,
                        modelPrefab: usedModelPrefab,
                        modelSubId,
                        parentUuid: args.parentUuid,
                        position: args.position,
                        ...verdict.fields,
                        message: verdict.failed
                            ? 'Prefab instantiated as an UNLINKED copy.'
                            : (usedModelPrefab
                                ? `Model prefab instantiated from FBX/glTF sub-asset (${assetUuid}).`
                                : 'Prefab instantiated successfully.')
                    }
                });
            } catch (err: any) {
                resolve({
                    success: false,
                    error: `Prefab instantiation failed: ${err.message}`,
                    instruction: 'Please check that the prefab path is correct and the prefab file format is valid'
                });
            }
        });
    }


    private async createPrefab(args: any): Promise<ToolResponse> {
        // Faithful prefab creation via the editor's OWN serializer
        // (cce.Prefab.generatePrefabDataFromNode, run in the scene process). The previous
        // hand-rolled serializer spread the editor *dump* form of components straight into
        // the prefab JSON, which dropped MeshRenderer `_mesh`/`_materials` (and every other
        // asset ref) — the produced prefab rendered as an untextured/empty node. The engine
        // serializer emits the exact `__uuid__`/`__id__` graph the editor writes on drag-to-
        // Assets, so all refs survive.
        try {
            const pathParam = args.savePath || args.prefabPath;
            if (!args.nodeUuid || !pathParam) {
                return { success: false, error: 'createPrefab requires nodeUuid and a savePath (or prefabPath).' };
            }
            const prefabName = args.prefabName || (pathParam.split('/').pop() || 'NewPrefab').replace(/\.prefab$/i, '');
            const url = pathParam.endsWith('.prefab') ? pathParam : `${pathParam}/${prefabName}.prefab`;

            let gen: any;
            try {
                gen = await Editor.Message.request('scene', 'execute-scene-script', {
                    name: 'cocos-mcp-server',
                    method: 'createPrefabFromNode2',
                    args: [args.nodeUuid]
                });
            } catch (err: any) {
                return { success: false, error: `Prefab data generation failed: ${err.message}` };
            }
            if (!gen || !gen.success || !gen.data?.prefabData) {
                return { success: false, error: gen?.error || 'Editor returned no prefab data for the node' };
            }

            const existed = await Editor.Message.request('asset-db', 'query-uuid', url).catch(() => null);
            let assetInfo: any;
            try {
                assetInfo = await (Editor.Message.request as any)('asset-db', 'create-asset', url, gen.data.prefabData, { overwrite: true });
            } catch (err: any) {
                return { success: false, error: `Failed to write prefab asset '${url}': ${err.message}` };
            }
            const prefabUuid = assetInfo?.uuid || await Editor.Message.request('asset-db', 'query-uuid', url).catch(() => null);

            // Counted from the generated content: this editor build has no asset-db `read-asset`
            // message, and the on-disk file may not have flushed yet.
            const refCheck = this.countPrefabRefs(gen.data.prefabData);

            // HONEST linkage reporting: this writes the .prefab asset but does NOT convert the
            // source node into a linked prefab instance (unlike dragging a node to the assets
            // panel in the editor). Verify and surface that, so callers are not misled into
            // thinking the source node now tracks the asset.
            const srcLinkage = await verifyPrefabLinkage(args.nodeUuid);
            return {
                success: true,
                data: {
                    prefabPath: url,
                    prefabUuid,
                    sourceNodeUuid: args.nodeUuid,
                    overwritten: !!existed,
                    meshRefs: refCheck.meshRefs,
                    materialRefs: refCheck.materialRefs,
                    refsPreserved: refCheck.ok,
                    sourceNodeLinked: srcLinkage.linked,
                    message: `Prefab created at ${url} (mesh refs: ${refCheck.meshRefs}, material refs: ${refCheck.materialRefs}).` +
                        (srcLinkage.linked
                            ? ' Source node is linked to the prefab.'
                            : ' NOTE: the source node is NOT converted into a linked prefab instance — it stays a plain node with no `_prefab` block, so it will not track the new asset.')
                }
            };
        } catch (error: any) {
            return { success: false, error: `Error occurred while creating prefab: ${error.message || error}` };
        }
    }

    /**
     * Count preserved mesh/material refs in generated prefab content so a caller can
     * confirm the serializer did not drop them. Operates on the JSON string directly.
     */
    private countPrefabRefs(content: string): { ok: boolean; meshRefs: number; materialRefs: number } {
        try {
            const meshRefs = (content.match(/"_mesh"\s*:/g) || []).length;
            const materialRefs = (content.match(/"_materials"\s*:/g) || []).length;
            let ok = false;
            try { ok = Array.isArray(JSON.parse(content)); } catch { ok = false; }
            return { ok, meshRefs, materialRefs };
        } catch {
            return { ok: false, meshRefs: 0, materialRefs: 0 };
        }
    }

    private async updatePrefab(prefabPath: string, nodeUuid: string): Promise<ToolResponse> {
        return new Promise((resolve) => {
            Editor.Message.request('asset-db', 'query-asset-info', prefabPath).then((assetInfo: any) => {
                if (!assetInfo) {
                    throw new Error('Prefab not found');
                }

                return Editor.Message.request('scene', 'apply-prefab', {
                    node: nodeUuid,
                    prefab: assetInfo.uuid
                });
            }).then(() => {
                resolve({
                    success: true,
                    message: 'Prefab updated successfully'
                });
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async revertPrefab(nodeUuid: string): Promise<ToolResponse> {
        return new Promise((resolve) => {
            Editor.Message.request('scene', 'revert-prefab', {
                node: nodeUuid
            }).then(() => {
                resolve({
                    success: true,
                    message: 'Prefab instance reverted successfully'
                });
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async validatePrefab(prefabPath: string): Promise<ToolResponse> {
        let prefabData: any;
        try {
            prefabData = await readAssetJson(prefabPath);
        } catch (error: any) {
            const message = error && error.message ? error.message : String(error);
            if (message.startsWith('Asset not found')) {
                return { success: false, error: 'Prefab file does not exist' };
            }
            if (error instanceof SyntaxError) {
                return { success: false, error: 'Prefab file format error, unable to parse JSON' };
            }
            return { success: false, error: `Failed to read prefab file: ${message}` };
        }

        const validationResult = this.validatePrefabFormat(prefabData);
        return {
            success: true,
            data: {
                isValid: validationResult.isValid,
                issues: validationResult.issues,
                nodeCount: validationResult.nodeCount,
                componentCount: validationResult.componentCount,
                message: validationResult.isValid ? 'Prefab format is valid' : 'Prefab format has issues'
            }
        };
    }

    private validatePrefabFormat(prefabData: any): { isValid: boolean; issues: string[]; nodeCount: number; componentCount: number } {
        const issues: string[] = [];
        let nodeCount = 0;
        let componentCount = 0;

        // Check basic structure
        if (!Array.isArray(prefabData)) {
            issues.push('Prefab data must be in array format');
            return { isValid: false, issues, nodeCount, componentCount };
        }

        if (prefabData.length === 0) {
            issues.push('Prefab data is empty');
            return { isValid: false, issues, nodeCount, componentCount };
        }

        // Check that the first element is a prefab asset
        const firstElement = prefabData[0];
        if (!firstElement || firstElement.__type__ !== 'cc.Prefab') {
            issues.push('The first element must be of type cc.Prefab');
        }

        // Count nodes and components
        prefabData.forEach((item: any, index: number) => {
            if (item.__type__ === 'cc.Node') {
                nodeCount++;
            } else if (item.__type__ && item.__type__.includes('cc.')) {
                componentCount++;
            }
        });

        // Check required fields
        if (nodeCount === 0) {
            issues.push('Prefab must contain at least one node');
        }

        return {
            isValid: issues.length === 0,
            issues,
            nodeCount,
            componentCount
        };
    }

    private async restorePrefabNode(nodeUuid: string, assetUuid: string): Promise<ToolResponse> {
        return new Promise((resolve) => {
            // Use official restore-prefab API to restore prefab node
            (Editor.Message.request as any)('scene', 'restore-prefab', nodeUuid, assetUuid).then(() => {
                resolve({
                    success: true,
                    data: {
                        nodeUuid: nodeUuid,
                        assetUuid: assetUuid,
                        message: 'Prefab node restored successfully'
                    }
                });
            }).catch((error: any) => {
                resolve({
                    success: false,
                    error: `Prefab node restore failed: ${error.message}`
                });
            });
        });
    }

}
