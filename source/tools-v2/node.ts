import { z } from 'zod';
import { booleanArg, defineTool } from '../tool';
import { ok, fail, ToolResult } from '../result';
import { fromScene, textOf } from './shared';
import { settle } from '../settle';
import { siblingLabels } from '../node-path';
import { coerceJsonArg } from '../json-arg';
import {
    LAYER_UI_2D, NodeType, UI_COMPONENT_TYPES, classifyNode, transformConstraintsOf
} from '../node-type';
import { applyLinkageOptions, linkageVerdict, queryAssetType, verifyPrefabLinkage } from '../prefab-linkage';
import { ComponentTools } from '../tools/component-tools';
import type { RegisteredTool } from '../tool';
import type { ToolContext } from '../context';

const PRIMITIVES_FBX = 'db://internal/primitives.fbx';
const PRIMITIVE_NAMES = ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'plane', 'quad', 'torus'] as const;

const LAYER_DEFAULT = 1073741824;

const componentTools = new ComponentTools();

const vec3Arg = z.object({
    x: z.coerce.number().optional(),
    y: z.coerce.number().optional(),
    z: z.coerce.number().optional()
});

const uuidListArg = z.preprocess(
    value => (typeof value === 'string' ? [value] : value),
    z.array(z.string())
);

type Vec3Arg = z.infer<typeof vec3Arg>;
interface Vec3 { x: number; y: number; z: number }

interface ComponentSummary { type: string; className?: string; enabled: boolean }

interface NodeSnapshot {
    uuid: string;
    name: string;
    active: boolean;
    position: Vec3;
    rotation: Vec3;
    scale: Vec3;
    parent: string | null;
    children: unknown[];
    components: ComponentSummary[];
    layer: number;
    mobility: number;
}

function vec3Of(value: any, fallback: Vec3): Vec3 {
    if (!value || typeof value !== 'object') return fallback;
    return {
        x: typeof value.x === 'number' ? value.x : fallback.x,
        y: typeof value.y === 'number' ? value.y : fallback.y,
        z: typeof value.z === 'number' ? value.z : fallback.z
    };
}

function componentsOf(raw: any): ComponentSummary[] {
    return (raw?.__comps__ || []).map((comp: any) => {
        const named = comp.value?.name?.value ?? comp.name?.value;
        const match = typeof named === 'string' ? named.match(/<([^>]+)>\s*$/) : null;
        const className = match ? match[1] : undefined;
        return {
            type: comp.__type__ || comp.cid || className || 'Unknown',
            className,
            enabled: comp.enabled !== undefined ? comp.enabled : true
        };
    });
}

async function snapshotOf(ctx: ToolContext, uuid: string): Promise<NodeSnapshot | null> {
    const raw: any = await ctx.editor.scene.queryNode(uuid);
    if (!raw) return null;
    return {
        uuid: raw.uuid?.value || uuid,
        name: raw.name?.value || 'Unknown',
        active: raw.active?.value !== undefined ? raw.active.value : true,
        position: vec3Of(raw.position?.value, { x: 0, y: 0, z: 0 }),
        rotation: vec3Of(raw.rotation?.value, { x: 0, y: 0, z: 0 }),
        scale: vec3Of(raw.scale?.value, { x: 1, y: 1, z: 1 }),
        parent: raw.parent?.value?.uuid || null,
        children: raw.children || [],
        components: componentsOf(raw),
        layer: raw.layer?.value ?? LAYER_DEFAULT,
        mobility: raw.mobility?.value || 0
    };
}

function carriesComponent(snapshot: NodeSnapshot, requested: string): boolean {
    const bare = requested.startsWith('cc.') ? requested.slice(3) : requested;
    return snapshot.components.some(component =>
        component.type === requested || component.className === requested || component.className === bare);
}

function classificationOf(snapshot: NodeSnapshot) {
    const verdict = classifyNode(snapshot.components.map(component => component.type), snapshot.layer);
    return { ...verdict, transformConstraints: transformConstraintsOf(verdict.nodeType) };
}

type TransformKind = 'position' | 'rotation' | 'scale';

function normalizedTransform(
    given: Vec3Arg, current: Vec3, kind: TransformKind, nodeType: NodeType
): { value: Vec3; warning?: string } {
    const value: Vec3 = {
        x: given.x !== undefined ? given.x : current.x,
        y: given.y !== undefined ? given.y : current.y,
        z: given.z !== undefined ? given.z : current.z
    };
    if (nodeType !== '2d') return { value };

    if (kind === 'position') {
        const forced = value.z;
        value.z = 0;
        if (given.z !== undefined && Math.abs(given.z) > 0.001) {
            return { value, warning: `2D node: z position (${given.z}) ignored, set to 0` };
        }
        if (Math.abs(forced) > 0.001) {
            return { value, warning: `2D node: z position was ${forced} and is forced to 0 by this write` };
        }
        return { value };
    }
    if (kind === 'rotation') {
        const forced = { x: value.x, y: value.y };
        value.x = 0;
        value.y = 0;
        if ((given.x !== undefined && Math.abs(given.x) > 0.001)
            || (given.y !== undefined && Math.abs(given.y) > 0.001)) {
            return { value, warning: '2D node: x,y rotations ignored, only z rotation applied' };
        }
        if (Math.abs(forced.x) > 0.001 || Math.abs(forced.y) > 0.001) {
            return {
                value,
                warning: `2D node: x,y rotation was (${forced.x}, ${forced.y}) and is forced to (0, 0) `
                    + 'by this write'
            };
        }
        return { value };
    }
    return { value };
}

function sameVec3(observed: Vec3, expected: Vec3): boolean {
    return Math.abs(observed.x - expected.x) < 0.001
        && Math.abs(observed.y - expected.y) < 0.001
        && Math.abs(observed.z - expected.z) < 0.001;
}

interface TransformOutcome {
    applied: TransformKind[];
    warnings: string[];
    unapplied?: { kind: TransformKind; expected: Vec3; observed: Vec3 | null };
}

async function writeTransform(
    ctx: ToolContext,
    uuid: string,
    requested: Partial<Record<TransformKind, Vec3Arg | undefined>>,
    snapshot: NodeSnapshot,
    nodeType: NodeType
): Promise<TransformOutcome> {
    const outcome: TransformOutcome = { applied: [], warnings: [] };
    for (const kind of ['position', 'rotation', 'scale'] as TransformKind[]) {
        const given = requested[kind];
        if (!given) continue;
        const normalized = normalizedTransform(given, snapshot[kind], kind, nodeType);
        if (normalized.warning) outcome.warnings.push(normalized.warning);

        await ctx.editor.scene.setProperty({ uuid, path: kind, dump: { value: normalized.value } as any });

        let observed: Vec3 | null = null;
        const settled = await settle(async () => {
            const fresh = await snapshotOf(ctx, uuid);
            observed = fresh ? fresh[kind] : null;
            return !!observed && sameVec3(observed, normalized.value);
        });
        if (!settled) {
            outcome.unapplied = { kind, expected: normalized.value, observed };
            return outcome;
        }
        outcome.applied.push(kind);
    }
    return outcome;
}

async function resolveBuiltinMeshes(ctx: ToolContext): Promise<Record<string, string>> {
    const uuid = await ctx.editor.assetDb.queryUuid(PRIMITIVES_FBX).catch(() => null);
    if (!uuid) throw new Error(`${PRIMITIVES_FBX} not found`);
    const meshes: Record<string, string> = {};

    const meta: any = await ctx.editor.assetDb.queryAssetMeta(uuid).catch(() => null);
    for (const subId of Object.keys(meta?.subMetas || {})) {
        const sub = meta.subMetas[subId];
        if (sub?.importer !== 'gltf-mesh') continue;
        const key = String(sub.name || '').replace(/\.mesh$/i, '').toLowerCase();
        if (key) meshes[key] = sub.uuid || `${uuid}@${subId}`;
    }

    if (!Object.keys(meshes).length) {
        const info: any = await ctx.editor.assetDb.queryAssetInfo(uuid).catch(() => null);
        for (const subId of Object.keys(info?.subAssets || {})) {
            const sub = info.subAssets[subId];
            const kind = sub?.importer || sub?.type;
            if (kind !== 'gltf-mesh' && kind !== 'cc.Mesh') continue;
            const key = String(sub?.name || subId).replace(/\.mesh$/i, '').toLowerCase();
            if (key) meshes[key] = sub?.uuid || `${uuid}@${subId}`;
        }
    }

    if (!Object.keys(meshes).length) {
        throw new Error('Could not resolve any primitive meshes from primitives.fbx metadata');
    }
    return meshes;
}

async function ensureColorMaterial(ctx: ToolContext, color: number[], unlit: boolean): Promise<string | null> {
    const channel = (raw: unknown) => Math.max(0, Math.min(255, Math.round(Number(raw) || 0)));
    const [r, g, b] = [channel(color[0]), channel(color[1]), channel(color[2])];
    const effectUrl = unlit
        ? 'db://internal/effects/builtin-unlit.effect'
        : 'db://internal/effects/builtin-standard.effect';
    const effectUuid = await ctx.editor.assetDb.queryUuid(effectUrl).catch(() => null);
    if (!effectUuid) throw new Error(`Effect not found: ${effectUrl}`);

    const hex = [r, g, b].map(value => value.toString(16).padStart(2, '0')).join('');
    const folder = 'db://assets/materials';
    const url = `${folder}/${unlit ? 'Unlit' : 'Std'}_${hex}.mtl`;

    const existing = await ctx.editor.assetDb.queryUuid(url).catch(() => null);
    if (existing) return existing;

    // create-asset on an existing path opens a blocking "overwrite?" dialog in the editor.
    const folderExists = await ctx.editor.assetDb.queryUuid(folder).catch(() => null);
    if (!folderExists) {
        await ctx.editor.assetDb.createAsset(folder, null).catch(() => null);
    }

    const props: Record<string, unknown> = { mainColor: { __type__: 'cc.Color', r, g, b, a: 255 } };
    if (!unlit) {
        props.roughness = 0.9;
        props.metallic = 0.0;
    }
    const material = {
        __type__: 'cc.Material', _name: '', _objFlags: 0, _native: '',
        _effectAsset: { __uuid__: effectUuid }, _techIdx: 0, _defines: [], _props: [props]
    };
    const created = await ctx.editor.assetDb.createAsset(url, JSON.stringify(material, null, 2));
    return created?.uuid || await ctx.editor.assetDb.queryUuid(url).catch(() => null);
}

async function setLayer(ctx: ToolContext, uuid: string, layer: number): Promise<void> {
    await ctx.editor.scene.setProperty({ uuid, path: 'layer', dump: { value: layer } as any });
}

async function hasCanvasAncestor(ctx: ToolContext, uuid: string): Promise<boolean> {
    let current: string | null = uuid;
    for (let depth = 0; current && depth < 64; depth++) {
        const snapshot: NodeSnapshot | null = await snapshotOf(ctx, current).catch(() => null);
        if (!snapshot) return false;
        if (snapshot.components.some(component => component.type === 'cc.Canvas')) return true;
        current = snapshot.parent;
    }
    return false;
}

async function findComponentIndex(ctx: ToolContext, uuid: string, type: string): Promise<number> {
    const raw: any = await ctx.editor.scene.queryNode(uuid).catch(() => null);
    const comps: any[] = raw?.__comps__ || [];
    return comps.findIndex(comp => (comp.__type__ || comp.cid || comp.type) === type);
}

async function setupCanvas(ctx: ToolContext, canvasUuid: string): Promise<string | null> {
    await setLayer(ctx, canvasUuid, LAYER_UI_2D);

    const canvasInfo: any = await componentTools.execute('get_component_info', {
        nodeUuid: canvasUuid, componentType: 'cc.Canvas'
    });
    const properties: any = canvasInfo?.data?.properties || {};
    if (properties.cameraComponent?.value?.uuid || properties._cameraComponent?.value?.uuid) return null;

    const created = await ctx.editor.scene.createNode({ name: 'Camera', parent: canvasUuid });
    const cameraUuid = Array.isArray(created) ? created[0] : created;
    await settle(async () => !!(await snapshotOf(ctx, cameraUuid).catch(() => null)));
    await setLayer(ctx, cameraUuid, LAYER_UI_2D);

    await ctx.editor.scene.createComponent({ uuid: cameraUuid, component: 'cc.Camera' });
    let cameraIndex = -1;
    await settle(async () => {
        cameraIndex = await findComponentIndex(ctx, cameraUuid, 'cc.Camera');
        return cameraIndex >= 0;
    });
    if (cameraIndex >= 0) {
        const write = (property: string, value: number) => ctx.editor.scene.setProperty({
            uuid: cameraUuid, path: `__comps__.${cameraIndex}.${property}`, dump: { value } as any
        });
        await write('projection', 0);
        await write('clearFlags', 6);
        await write('visibility', 41943040);
        await write('priority', 1073741824);
        await write('near', 1);
        await write('far', 2000);
    }

    if (cameraIndex < 0) {
        return `The UI camera node ${cameraUuid} carries no cc.Camera, so the Canvas has nothing to wire`;
    }
    const wired: any = await componentTools.execute('set_component_property', {
        nodeUuid: canvasUuid, componentType: 'cc.Canvas',
        property: 'cameraComponent', propertyType: 'component', value: cameraUuid
    });
    if (!wired?.success) {
        return `cc.Canvas.cameraComponent was not wired to the UI camera ${cameraUuid}: `
            + `${wired?.error || 'unknown'} — the UI renders invisibly until it is`;
    }
    return null;
}

async function ensureUiSetup(ctx: ToolContext, uuid: string, components: string[]): Promise<string | null> {
    if (components.includes('cc.Canvas')) {
        return await setupCanvas(ctx, uuid);
    }
    const carriesUi = components.some(component => UI_COMPONENT_TYPES.includes(component));
    if (carriesUi || await hasCanvasAncestor(ctx, uuid)) {
        await setLayer(ctx, uuid, LAYER_UI_2D);
    }
    return null;
}

function orphan(uuid: string, code: string, message: string, hint?: string): ToolResult {
    return fail(code, message,
        `${hint ? `${hint} ` : ''}The node ${uuid} WAS created and is still in the scene — delete it with `
        + 'node_delete_node or finish the step by hand; it is not rolled back.',
        { uuid, created: true });
}

export const nodeCreateNode = defineTool({
    name: 'node_create_node',
    description: 'Create a node: empty, with components, instantiated from an asset, or as a builtin 3D '
        + 'primitive (pass `primitive`). A node made from a prefab asset comes out as a LINKED instance and '
        + 'the result reports prefabLinked (live node) and prefabLinkagePersisted (what the serializer '
        + 'emits) separately, failing rather than passing a flat copy off as a success. Every step after '
        + 'creation — components, transform — is verified against the scene, and a step that did not apply '
        + 'fails the call while naming the uuid of the node that was already created. Always pass parentUuid '
        + '(or parentPath); without one the node lands at the scene root.',
    schema: z.object({
        name: z.string().optional().describe('Node name (defaults to the primitive name, or "Node")'),
        parentUuid: z.string().optional().describe('Parent node UUID; scene root when omitted'),
        nodeType: z.enum(['Node', '2DNode', '3DNode']).optional().describe('2DNode adds a cc.UITransform, '
            + 'which is what makes a node 2D; 3DNode and Node add nothing'),
        components: z.array(z.string()).optional().describe('Component type names to add, e.g. '
            + '["cc.Sprite", "cc.Button"]'),
        assetUuid: z.string().optional().describe('Asset UUID to instantiate from (e.g. a prefab)'),
        assetPath: z.string().optional().describe('Asset path to instantiate from, e.g. '
            + '"db://assets/prefabs/MyPrefab.prefab". Alternative to assetUuid.'),
        unlinkPrefab: booleanArg.optional().describe('Produce a flat, unlinked copy instead of a prefab '
            + 'instance. The node stops tracking the asset and prefab edits no longer reach it.'),
        keepWorldTransform: booleanArg.optional().describe('Keep the world transform when parenting'),
        primitive: z.enum(PRIMITIVE_NAMES).optional().describe('Create a cc.MeshRenderer carrying this '
            + 'builtin mesh. Sub-asset uuids are resolved from db://internal/primitives.fbx, never hardcoded.'),
        color: z.array(z.coerce.number()).optional().describe('RGB 0-255 for a primitive, e.g. [221,68,68]. '
            + 'Creates or reuses a .mtl under db://assets/materials.'),
        unlit: booleanArg.optional().describe('Build the primitive material on builtin-unlit instead of '
            + 'builtin-standard'),
        position: vec3Arg.optional().describe('Initial local position; axes left out keep their created value'),
        rotation: vec3Arg.optional().describe('Initial local euler rotation'),
        scale: vec3Arg.optional().describe('Initial local scale'),
        initialTransform: z.object({
            position: vec3Arg.optional(),
            rotation: vec3Arg.optional(),
            scale: vec3Arg.optional()
        }).optional().describe('The same three, grouped; the top-level spelling wins when both are given')
    }),
    async handler(args, ctx) {
        const parentUuid = args.parentUuid
            || (await ctx.editor.scene.queryNodeTree().catch(() => null))?.uuid
            || undefined;

        let assetUuid = args.assetUuid;
        if (args.assetPath && !assetUuid) {
            const info = await ctx.editor.assetDb.queryAssetInfo(args.assetPath).catch(() => null);
            if (!info?.uuid) return fail('asset_not_found', `Asset not found at path: ${args.assetPath}`);
            assetUuid = info.uuid;
        }

        let meshUuid: string | null = null;
        if (args.primitive) {
            const meshes = await resolveBuiltinMeshes(ctx);
            meshUuid = meshes[args.primitive] || null;
            if (!meshUuid) {
                return fail('unknown_primitive',
                    `Unknown primitive '${args.primitive}'. Available: ${Object.keys(meshes).join(', ')}`);
            }
        }

        const components = [...(args.components || [])];
        if (args.primitive && !components.includes('cc.MeshRenderer')) components.push('cc.MeshRenderer');
        if (args.nodeType === '2DNode' && !components.includes('cc.UITransform')) {
            components.push('cc.UITransform');
        }

        const name = args.name || args.primitive || 'Node';
        const options: Record<string, unknown> = { name };
        if (parentUuid) options.parent = parentUuid;
        if (args.keepWorldTransform) options.keepWorldTransform = true;

        let assetType: string | null = null;
        const unlinkPrefab = !!args.unlinkPrefab;
        if (assetUuid) {
            options.assetUuid = assetUuid;
            assetType = await queryAssetType(assetUuid);
            applyLinkageOptions(options, assetType, unlinkPrefab);
        }

        const created = await ctx.editor.scene.createNode(options as any);
        const uuid = Array.isArray(created) ? created[0] : created;
        if (!uuid) return fail('create_failed', `The editor created no node for '${name}'`);

        let snapshot = await snapshotOf(ctx, uuid).catch(() => null);
        if (!snapshot) {
            const appeared = await settle(async () => {
                snapshot = await snapshotOf(ctx, uuid).catch(() => null);
                return !!snapshot;
            });
            if (!appeared || !snapshot) {
                return fail('create_unverified',
                    `The editor answered with uuid ${uuid} but no such node is in the scene`);
            }
        }

        for (const component of components) {
            const before = await snapshotOf(ctx, uuid).catch(() => null);
            if (before && carriesComponent(before, component)) continue;
            try {
                await ctx.editor.scene.createComponent({ uuid, component });
            } catch (error) {
                return orphan(uuid, 'component_failed',
                    `Component '${component}' could not be added: ${textOf(error)}`);
            }
            const added = await settle(async () => {
                const fresh = await snapshotOf(ctx, uuid).catch(() => null);
                return !!fresh && carriesComponent(fresh, component);
            });
            if (!added) {
                return orphan(uuid, 'component_unverified',
                    `Component '${component}' is not on the node after adding it`,
                    'The editor accepted the call without registering the component — check the spelling '
                    + 'against component_get_components.');
            }
        }

        let materialUuid: string | null = null;
        if (meshUuid) {
            const meshWrite: any = await componentTools.execute('set_component_property', {
                nodeUuid: uuid, componentType: 'cc.MeshRenderer',
                property: 'mesh', propertyType: 'asset', value: meshUuid
            });
            if (!meshWrite?.success) {
                return orphan(uuid, 'mesh_failed',
                    `Primitive mesh '${args.primitive}' was not assigned: ${meshWrite?.error || 'unknown'}`);
            }
            if (args.color && args.color.length >= 3) {
                materialUuid = await ensureColorMaterial(ctx, args.color, !!args.unlit);
                if (materialUuid) {
                    const materialWrite: any = await componentTools.execute('set_component_property', {
                        nodeUuid: uuid, componentType: 'cc.MeshRenderer',
                        property: 'sharedMaterials', propertyType: 'asset', value: materialUuid
                    });
                    if (!materialWrite?.success) {
                        return orphan(uuid, 'material_failed',
                            `Material ${materialUuid} was not assigned: ${materialWrite?.error || 'unknown'}`);
                    }
                }
            }
        }

        const requested = {
            position: args.position || args.initialTransform?.position,
            rotation: args.rotation || args.initialTransform?.rotation,
            scale: args.scale || args.initialTransform?.scale
        };
        let transform: TransformOutcome = { applied: [], warnings: [] };
        if (requested.position || requested.rotation || requested.scale) {
            const fresh = await snapshotOf(ctx, uuid);
            if (!fresh) return orphan(uuid, 'transform_failed', 'The node vanished before its transform was set');
            transform = await writeTransform(ctx, uuid, requested, fresh, classificationOf(fresh).nodeType);
            if (transform.unapplied) {
                const { kind, expected, observed } = transform.unapplied;
                return orphan(uuid, 'transform_unapplied',
                    `${kind} did not reach the node: expected ${JSON.stringify(expected)}, `
                    + `the scene still reports ${JSON.stringify(observed)}`);
            }
        }

        try {
            const uiError = await ensureUiSetup(ctx, uuid, components);
            if (uiError) return orphan(uuid, 'ui_setup_failed', uiError);
        } catch (error) {
            return orphan(uuid, 'ui_setup_failed',
                `The UI wiring for this node did not complete: ${textOf(error)}`);
        }

        const linkage = assetUuid ? await verifyPrefabLinkage(uuid) : null;
        const verdict = linkage ? linkageVerdict(linkage, assetType, unlinkPrefab) : null;
        const data = {
            uuid,
            name,
            parentUuid: parentUuid ?? null,
            nodeType: args.nodeType || 'Node',
            components,
            fromAsset: !!assetUuid,
            assetUuid: assetUuid ?? null,
            ...(assetType ? { assetType } : {}),
            ...(args.primitive ? { primitive: args.primitive, meshUuid, materialUuid } : {}),
            appliedTransform: transform.applied,
            ...(transform.warnings.length ? { warnings: transform.warnings } : {}),
            ...(verdict ? verdict.fields : {}),
            node: await snapshotOf(ctx, uuid).catch(() => null)
        };

        if (verdict?.failed) {
            return fail('prefab_unlinked', `Node '${name}' was created as an UNLINKED copy of the prefab`,
                undefined, data);
        }
        return ok(data, assetUuid
            ? `Node '${name}' instantiated from asset successfully`
            : `Node '${name}' created successfully`);
    }
});

export const nodeGetNodeInfo = defineTool({
    name: 'node_get_node_info',
    description: 'One node in full: name, active, local position/rotation(euler)/scale, parent, children, '
        + 'components, layer and mobility, plus the 2D/3D verdict — `nodeType`, the `reasons` behind it, and '
        + 'the `transformConstraints` those imply. The verdict comes from the same classifier '
        + 'node_set_node_transform obeys, so what it says about z/x/y is what a write will actually do.',
    schema: z.object({
        uuid: z.string().describe('Node UUID')
    }),
    async handler(args, ctx) {
        const snapshot = await snapshotOf(ctx, args.uuid);
        if (!snapshot) return fail('node_not_found', `No node ${args.uuid} in the open scene`);
        return ok({ ...snapshot, ...classificationOf(snapshot) });
    }
});

export const nodeFindNodes = defineTool({
    name: 'node_find_nodes',
    description: 'Every node whose name matches, as uuid + name + the SCENE PATH that addresses it — '
        + 'same-named siblings suffixed #1/#2/#3 exactly as scene_dump prints them, so a path from here can '
        + 'be passed straight back as a nodePath. Substring, case-insensitive by default; pass '
        + 'exactMatch to compare the whole name.',
    schema: z.object({
        pattern: z.string().describe('Name or substring to search for'),
        exactMatch: booleanArg.optional().describe('Compare the whole name instead of a substring '
            + '(default false)')
    }),
    aliases: { name: 'pattern' },
    async handler(args, ctx) {
        const tree: any = await ctx.editor.scene.queryNodeTree();
        if (!tree) return fail('no_scene', 'No scene data available');

        const found: Array<{ uuid: string; name: string; path: string }> = [];
        const needle = args.pattern.toLowerCase();
        const walk = (parent: any, prefix: string) => {
            const children: any[] = (parent.children || []).filter(Boolean);
            const labels = siblingLabels(children);
            children.forEach((child, index) => {
                const path = prefix ? `${prefix}/${labels[index]}` : labels[index];
                const matches = args.exactMatch
                    ? child.name === args.pattern
                    : String(child.name).toLowerCase().includes(needle);
                if (matches) found.push({ uuid: child.uuid, name: child.name, path });
                walk(child, path);
            });
        };
        walk(tree, '');

        return ok({ count: found.length, nodes: found }, found.length
            ? `${found.length} node(s) match '${args.pattern}'`
            : `No node matches '${args.pattern}'`);
    }
});

export const nodeSetNodeProperty = defineTool({
    name: 'node_set_node_property',
    description: 'Write one property of the node itself — name, active, layer, mobility. Position, rotation '
        + 'and scale belong to node_set_node_transform, which knows what a 2D node may not carry. The write '
        + 'is read back: a property the node dump exposes and that did not change is reported as a failure, '
        + 'not as a success.',
    schema: z.object({
        uuid: z.string().describe('Node UUID'),
        property: z.string().describe('Property name, e.g. active, name, layer'),
        value: z.any().describe('Property value (required)')
    }),
    async handler(args, ctx) {
        if (args.value === undefined) {
            return fail('invalid_args', 'node_set_node_property: value: Required');
        }
        const value = coerceJsonArg(args.value).value;
        try {
            await ctx.editor.scene.setProperty({ uuid: args.uuid, path: args.property, dump: { value } as any });
        } catch (error) {
            const fallback = await ctx.sceneScript
                .call('setNodeProperty', args.uuid, args.property, value)
                .catch(() => null);
            if (!fallback) {
                return fail('set_property_failed',
                    `Neither the editor nor the scene script wrote '${args.property}': ${textOf(error)}`);
            }
            return fromScene(fallback);
        }

        const raw: any = await ctx.editor.scene.queryNode(args.uuid).catch(() => null);
        const observed = raw && Object.prototype.hasOwnProperty.call(raw, args.property)
            ? raw[args.property]?.value
            : undefined;
        const data = { uuid: args.uuid, property: args.property, value, observed };
        const differs = typeof value === 'object' && value !== null
            ? JSON.stringify(observed) !== JSON.stringify(value)
            : observed !== value;
        if (observed !== undefined && differs) {
            return fail('property_unapplied',
                `'${args.property}' still reads ${JSON.stringify(observed)} after writing `
                + `${JSON.stringify(value)}`, undefined, data);
        }
        return ok(data, observed === undefined
            ? `'${args.property}' was written; the node dump does not expose it, so it is unverified`
            : `Property '${args.property}' updated`);
    }
});

export const nodeSetNodeTransform = defineTool({
    name: 'node_set_node_transform',
    description: 'Set local position, rotation (euler) and/or scale. An axis left out keeps the value the '
        + 'node already has — EXCEPT on a 2D node, where writing position forces z to 0 and writing rotation '
        + 'forces x and y to 0 whether or not you passed them: a 2D node has no other transform. Which kind '
        + 'of node it is comes from the classifier node_get_node_info reports. Every forced zero that '
        + 'changed a value is reported in `warnings`. Each write is read back and a value that did not land '
        + 'fails the call.',
    schema: z.object({
        uuid: z.string().describe('Node UUID'),
        position: vec3Arg.optional().describe('Local position; z ignored on a 2D node'),
        rotation: vec3Arg.optional().describe('Local euler rotation; only z is used on a 2D node'),
        scale: vec3Arg.optional().describe('Local scale')
    }),
    async handler(args, ctx) {
        if (!args.position && !args.rotation && !args.scale) {
            return fail('nothing_to_do', 'Pass at least one of position, rotation or scale');
        }
        const snapshot = await snapshotOf(ctx, args.uuid);
        if (!snapshot) return fail('node_not_found', `No node ${args.uuid} in the open scene`);

        const classification = classificationOf(snapshot);
        const outcome = await writeTransform(
            ctx, args.uuid,
            { position: args.position, rotation: args.rotation, scale: args.scale },
            snapshot, classification.nodeType
        );
        const data = {
            uuid: args.uuid,
            nodeType: classification.nodeType,
            reasons: classification.reasons,
            transformConstraints: classification.transformConstraints,
            appliedProperties: outcome.applied,
            ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}),
            before: { position: snapshot.position, rotation: snapshot.rotation, scale: snapshot.scale },
            after: await snapshotOf(ctx, args.uuid).catch(() => null)
        };
        if (outcome.unapplied) {
            const { kind, expected, observed } = outcome.unapplied;
            return fail('transform_unapplied',
                `${kind} did not reach the node: expected ${JSON.stringify(expected)}, `
                + `the scene still reports ${JSON.stringify(observed)}`, undefined, data);
        }
        return ok(data, `Transform updated: ${outcome.applied.join(', ')} (${classification.nodeType} node)`);
    }
});

export const nodeDeleteNode = defineTool({
    name: 'node_delete_node',
    description: 'Remove a node and its whole subtree from the open scene. The removal is read back, so a '
        + 'node the editor declined to delete is reported instead of being called a success.',
    schema: z.object({
        uuid: z.string().describe('Node UUID to delete')
    }),
    async handler(args, ctx) {
        await ctx.editor.scene.removeNode({ uuid: args.uuid });
        const gone = await settle(async () => !(await snapshotOf(ctx, args.uuid).catch(() => null)));
        if (!gone) {
            return fail('delete_unverified', `Node ${args.uuid} is still in the scene after remove-node`);
        }
        return ok({ uuid: args.uuid }, 'Node deleted');
    }
});

export const nodeMoveNode = defineTool({
    name: 'node_move_node',
    description: 'Reparent a node. The editor applies a reparent asynchronously and silently ignores some '
        + 'of them, so the new parent is polled until it takes; a move that never landed is reported with '
        + 'the parent the node actually has.',
    schema: z.object({
        nodeUuid: z.string().describe('Node UUID to move'),
        newParentUuid: z.string().describe('New parent node UUID'),
        keepWorldTransform: booleanArg.optional().describe('Keep the world transform across the move '
            + '(default false)')
    }),
    async handler(args, ctx) {
        try {
            await ctx.editor.scene.setParent({
                parent: args.newParentUuid,
                uuids: [args.nodeUuid],
                keepWorldTransform: !!args.keepWorldTransform
            });
        } catch (error) {
            return fail('set_parent_failed', `set-parent failed: ${textOf(error)}`);
        }

        let actualParent: string | null = null;
        const moved = await settle(async () => {
            actualParent = (await snapshotOf(ctx, args.nodeUuid).catch(() => null))?.parent ?? null;
            return actualParent === args.newParentUuid;
        });
        if (!moved) {
            return fail('reparent_unapplied',
                `Reparent not applied: the node's parent is '${actualParent ?? 'unknown'}', expected `
                + `'${args.newParentUuid}'`, undefined,
                { nodeUuid: args.nodeUuid, newParentUuid: args.newParentUuid, actualParent });
        }
        return ok({ nodeUuid: args.nodeUuid, newParentUuid: args.newParentUuid, verifiedParent: actualParent },
            'Node reparented');
    }
});

export const nodeDuplicateNode = defineTool({
    name: 'node_duplicate_node',
    description: 'Duplicate a node with its whole subtree, as a sibling of the original. Returns the new '
        + 'node\'s uuid.',
    schema: z.object({
        uuid: z.string().describe('Node UUID to duplicate')
    }),
    async handler(args, ctx) {
        const result = await ctx.editor.scene.duplicateNode(args.uuid);
        const newUuid = Array.isArray(result) ? result[0] : (result as any)?.uuid || result;
        if (!newUuid || typeof newUuid !== 'string') {
            return fail('duplicate_failed', `The editor returned no uuid for the copy of ${args.uuid}`);
        }
        const appeared = await settle(async () => !!(await snapshotOf(ctx, newUuid).catch(() => null)));
        if (!appeared) {
            return fail('duplicate_unverified',
                `The editor answered with uuid ${newUuid} but no such node is in the scene`);
        }
        return ok({ uuid: args.uuid, newUuid }, 'Node duplicated');
    }
});

export const nodeListBuiltinMeshes = defineTool({
    name: 'node_list_builtin_meshes',
    description: 'The builtin primitive meshes with their sub-asset uuids, e.g. {"box":"<uuid>@a804a"}. '
        + 'Read out of db://internal/primitives.fbx\'s import metadata, where the sub-ids are an artifact of '
        + 'that import — never hardcode them.',
    schema: z.object({}),
    async handler(_args, ctx) {
        try {
            return ok({ source: PRIMITIVES_FBX, meshes: await resolveBuiltinMeshes(ctx) });
        } catch (error) {
            return fail('primitives_unavailable', textOf(error));
        }
    }
});

export const nodeCopyNode = defineTool({
    name: 'node_copy_node',
    description: 'Put nodes on the editor\'s clipboard for a later node_paste_node. The scene is not '
        + 'changed.',
    schema: z.object({
        targetUuids: uuidListArg.describe('Node UUIDs to copy')
    }),
    aliases: { uuids: 'targetUuids' },
    async handler(args, ctx) {
        const copied = await ctx.editor.scene.copyNode(args.targetUuids);
        return ok({ copiedUuids: copied }, 'Node(s) copied');
    }
});

export const nodeCutNode = defineTool({
    name: 'node_cut_node',
    description: 'Put nodes on the editor\'s clipboard marked for a move: the following node_paste_node '
        + 'relocates them instead of copying.',
    schema: z.object({
        targetUuids: uuidListArg.describe('Node UUIDs to cut')
    }),
    aliases: { uuids: 'targetUuids' },
    async handler(args, ctx) {
        await ctx.editor.scene.cutNode(args.targetUuids);
        return ok({ cutUuids: args.targetUuids }, 'Node(s) cut');
    }
});

export const nodePasteNode = defineTool({
    name: 'node_paste_node',
    description: 'Paste clipboard nodes under a parent and return the uuids they got. Pass the same uuids '
        + 'that were copied or cut.',
    schema: z.object({
        parentUuid: z.string().describe('Parent node UUID to paste under'),
        targetUuids: uuidListArg.describe('The node UUIDs that were copied or cut'),
        keepWorldTransform: booleanArg.optional().describe('Keep the world transform (default false)')
    }),
    aliases: { target: 'parentUuid', uuids: 'targetUuids' },
    async handler(args, ctx) {
        const pasted = await ctx.editor.scene.pasteNode({
            target: args.parentUuid,
            uuids: args.targetUuids,
            keepWorldTransform: !!args.keepWorldTransform
        });
        return ok({ newUuids: pasted }, 'Node(s) pasted');
    }
});

export const nodeTools: RegisteredTool[] = [
    nodeCreateNode,
    nodeGetNodeInfo,
    nodeFindNodes,
    nodeSetNodeProperty,
    nodeSetNodeTransform,
    nodeDeleteNode,
    nodeMoveNode,
    nodeDuplicateNode,
    nodeListBuiltinMeshes,
    nodeCopyNode,
    nodeCutNode,
    nodePasteNode
];
