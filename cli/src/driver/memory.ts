import { EDITOR_METHODS, buildPathIndex, resolvePathInIndex } from '@cocos-cli/shared';
import type {
    ComponentOwner, ComponentOwnerReport, Driver, DumpedComponent, EditorMethods, NodeDump,
    NodeInfo, PathIndexNode, PathResolution, PrefabOverrideOutcome, PropertyDump,
    ReferenceOutcomeReport, ReferencePlanReport, SceneDump, SceneFacade, SceneInfo, SceneMethods,
    SceneNodeEntry, SceneResult, SerializedValue, Vec3Like
} from '@cocos-cli/shared';
import { isDumpDescriptor, resolveKind } from '../property/kind.ts';
import { projectValue } from '../property/readers.ts';
import type { PropertyDescriptor } from '../property/kind.ts';

/**
 * A `Driver` over a scene held as data. Writes land in that scene and reads answer from it, which
 * a recorded set of editor answers cannot do — a write command's whole job is to read its own write
 * back. Only the primitives a command exercises are modelled; the rest refuse by name.
 */
export class MemoryDriver implements Driver {
    readonly editor: EditorMethods;
    readonly scene: SceneFacade;
    readonly calls: MemoryCall[] = [];

    private readonly spec: MemoryScene | null;
    private readonly roots: LiveNode[] = [];
    private readonly byUuid = new Map<string, LiveNode>();
    private readonly assets: Record<string, string>;
    private readonly refuses: MemoryRefusals;

    constructor(spec?: MemoryScene) {
        this.spec = spec || null;
        this.assets = (spec && spec.assets) || {};
        this.refuses = (spec && spec.refuses) || {};
        for (const node of (spec && spec.nodes) || []) this.roots.push(this.adopt(node, null));

        this.editor = this.buildEditor();
        this.scene = { call: this.buildSceneFacade() };
    }

    /** The live components of a node, as the scene holds them after every write so far. */
    componentsOf(uuid: string): LiveComponent[] {
        const node = this.byUuid.get(uuid);
        return node ? node.components : [];
    }

    /** The uuid this scene gave the node at `path` — the spelling `resolveNodePaths` answers with. */
    uuidOf(path: string): string {
        const resolution = resolvePathInIndex(buildPathIndex({ children: this.indexRoots() }), path);
        if ('error' in resolution) throw new Error(resolution.error);
        return resolution.uuid;
    }

    // ----- The scene as data -----------------------------------------------------------------

    private adopt(spec: MemoryNode, parent: LiveNode | null): LiveNode {
        const node: LiveNode = {
            uuid: spec.uuid || this.mintUuid(parent ? `${parent.name}${spec.name}` : spec.name),
            name: spec.name,
            active: spec.active !== false,
            layer: spec.layer === undefined ? LAYER_DEFAULT : spec.layer,
            position: spec.position || { x: 0, y: 0, z: 0 },
            rotation: spec.rotation || { x: 0, y: 0, z: 0 },
            scale: spec.scale || { x: 1, y: 1, z: 1 },
            prefab: spec.prefab || null,
            parent,
            children: [],
            components: []
        };
        this.byUuid.set(node.uuid, node);
        for (const component of spec.components || []) this.attach(node, component);
        for (const child of spec.children || []) node.children.push(this.adopt(child, node));
        return node;
    }

    /** The shape of the editor's own compressed uuid, so `resolveNode` reads a minted one as a uuid. */
    private mintUuid(seed: string): string {
        const base = `${seed.replace(/[^A-Za-z0-9]/g, '')}0000000000000000000000`.slice(0, 22);
        let uuid = base;
        for (let nth = 1; this.byUuid.has(uuid); nth++) {
            uuid = `${base.slice(0, 22 - String(nth).length)}${nth}`;
        }
        return uuid;
    }

    private pathOf(node: LiveNode): string {
        const labels: string[] = [];
        for (let at: LiveNode | null = node; at; at = at.parent) labels.push(this.labelOf(at));
        return labels.reverse().join('/');
    }

    /** Same-named siblings carry `#N`, exactly as `buildPathIndex` labels them. */
    private labelOf(node: LiveNode): string {
        const siblings = node.parent ? node.parent.children : this.roots;
        const sameName = siblings.filter(sibling => sibling.name === node.name);
        return sameName.length > 1 ? `${node.name}#${sameName.indexOf(node) + 1}` : node.name;
    }

    private indexRoots(): PathIndexNode[] {
        const asIndexNode = (node: LiveNode): PathIndexNode => ({
            name: node.name, uuid: node.uuid, children: node.children.map(asIndexNode)
        });
        return this.roots.map(asIndexNode);
    }

    private everyNode(): LiveNode[] {
        const all: LiveNode[] = [];
        const walk = (node: LiveNode) => { all.push(node); node.children.forEach(walk); };
        this.roots.forEach(walk);
        return all;
    }

    private requireNode(uuid: string): LiveNode {
        const node = this.byUuid.get(uuid);
        if (!node) throw new Error(`node ${uuid} is not in the open scene`);
        return node;
    }

    /** The engine holds a fixed set of registered classes; a scene that names none registers any. */
    private registers(type: string): boolean {
        const classes = this.spec && this.spec.classes;
        return !classes || classes.includes(type);
    }

    private attach(node: LiveNode, component: MemoryComponent): void {
        node.components.push({
            uuid: `${node.uuid}.c${node.components.length}`,
            type: component.type,
            enabled: component.enabled !== false,
            props: component.props ? { ...component.props } : {},
            serialized: component.serialized || null
        });
    }

    /**
     * The dump `queryNode` answers with is rebuilt from the scene on every call, so a write has to
     * reach the scene rather than the dump it was addressed through.
     */
    private applyWrite(node: LiveNode, path: string, written: PropertyDump): void {
        const segments = path.split('.');
        if (segments[0] !== '__comps__') {
            writeNodeField(node, segments, path, written);
            return;
        }
        const component = node.components[Number(segments[1])];
        if (!component) throw new Error(`set-property refused '${path}': the node has no such component`);
        writeIntoDescriptors(component.props, segments.slice(2), path, written);
    }

    private dumpOf(node: LiveNode): NodeDump {
        return {
            uuid: { value: node.uuid },
            name: { value: node.name },
            active: { value: node.active },
            layer: { value: node.layer },
            position: { value: node.position },
            rotation: { value: node.rotation },
            scale: { value: node.scale },
            parent: { value: node.parent ? { uuid: node.parent.uuid } : null },
            __comps__: node.components.map(component => ({
                __type__: component.type,
                value: { enabled: { value: component.enabled }, ...component.props }
            }))
        };
    }

    // ----- The editor half -------------------------------------------------------------------

    private buildEditor(): EditorMethods {
        const modelled: ModelledEditor = {
            scene: {
                queryNode: async uuid => {
                    const node = this.byUuid.get(uuid);
                    return node ? this.dumpOf(node) : null;
                },
                setProperty: async ({ uuid, path, dump }) => {
                    if (this.refuses.setProperty) throw new Error(this.refuses.setProperty);
                    this.applyWrite(this.requireNode(uuid), path, dump);
                    return true;
                },
                createNode: async options => {
                    const parent = this.requireNode(String(options.parent));
                    const child = this.adopt({ name: String(options.name || 'New Node') }, parent);
                    parent.children.push(child);
                    return child.uuid;
                },
                createComponent: async options => {
                    const node = this.requireNode(options.uuid);
                    if (this.registers(options.component)) this.attach(node, { type: options.component });
                },
                beginRecording: async () => {
                    if (this.refuses.beginRecording) throw new Error(this.refuses.beginRecording);
                    return `undo-${this.calls.length}`;
                },
                endRecording: async () => {
                    if (this.refuses.endRecording) throw new Error(this.refuses.endRecording);
                },
                cancelRecording: async () => { }
            },
            assetDb: {
                queryUuid: async url => this.assets[url],
                queryUrl: async uuid =>
                    Object.keys(this.assets).find(url => this.assets[url] === uuid) as string
            }
        };

        const groups: Record<string, Record<string, (...args: never[]) => Promise<never>>> = {};
        for (const name of EDITOR_METHODS) {
            const [group, method] = name.split('.');
            groups[group] = groups[group] || {};
            groups[group][method] = () =>
                Promise.reject(new Error(`the memory scene does not model editor.${name}`));
        }
        for (const [group, methods] of Object.entries(modelled)) {
            for (const [method, implementation] of Object.entries(methods)) {
                groups[group][method] = this.logged(`${group}.${method}`, implementation);
            }
        }
        return groups as unknown as EditorMethods;
    }

    private logged(
        name: string, implementation: (...args: never[]) => unknown
    ): (...args: never[]) => Promise<never> {
        return (...args: never[]) => {
            this.calls.push({ name, args });
            return Promise.resolve(implementation(...args)) as Promise<never>;
        };
    }

    // ----- The scene-script half -------------------------------------------------------------

    private buildSceneFacade(): SceneFacade['call'] {
        const modelled: Record<string, (args: unknown[]) => unknown> = {
            resolveNodePaths: ([paths]) => this.resolveNodePaths(paths as string[]),
            getNodeInfo: ([uuid]) => this.nodeInfo(uuid as string),
            getCurrentSceneInfo: () => this.sceneInfo(),
            dumpSceneNodes: () => this.sceneNodes(),
            addComponentToNode: ([uuid, type]) => this.addComponentToNode(uuid as string, type as string),
            findComponentOwners: ([options]) =>
                this.componentOwners(String((options as { className?: unknown }).className)),
            serializedComponentValue: ([uuid, cid, property]) =>
                this.serializedValue(uuid as string, cid as string, property as string),
            prefabInstancePropertyOutcome: ([uuid, cid, property]) =>
                this.overrideOutcome(uuid as string, cid as string, property as string),
            resolveComponentReference: ([args]) => this.referencePlan(args as ReferenceArgs),
            applyComponentReference: ([args]) => this.applyReference(args as ReferenceArgs),
            componentReferenceOutcome: ([uuid, index, property]) =>
                this.referenceOutcome(uuid as string, index as number, property as string),
            pruneComponentReferenceOverrides: () => ({ success: true, data: { removed: 0, paths: [] } })
        };

        return <K extends keyof SceneMethods>(method: K, ...args: Parameters<SceneMethods[K]>) => {
            this.calls.push({ name: method, args });
            const answer = modelled[method];
            if (!answer) {
                return Promise.reject(new Error(`the memory scene does not model scene.${method}`));
            }
            if (!this.spec) {
                return Promise.resolve({ success: false, error: 'no scene is open' } as
                    Awaited<ReturnType<SceneMethods[K]>>);
            }
            return Promise.resolve(answer(args) as Awaited<ReturnType<SceneMethods[K]>>);
        };
    }

    private resolveNodePaths(paths: string[]): SceneResult<{
        sceneName: string; nodeCount: number; resolutions: Record<string, PathResolution>;
    }> {
        const index = buildPathIndex({ children: this.indexRoots() });
        const resolutions: Record<string, PathResolution> = {};
        for (const path of paths) resolutions[path] = resolvePathInIndex(index, path);
        return { success: true, data: { ...this.sceneHeader(), resolutions } };
    }

    private sceneHeader(): { sceneName: string; nodeCount: number } {
        return {
            sceneName: (this.spec && this.spec.name) || 'main',
            nodeCount: this.everyNode().length
        };
    }

    private nodeInfo(uuid: string): SceneResult<NodeInfo> {
        const node = this.requireNode(uuid);
        return {
            success: true,
            data: {
                uuid: node.uuid, name: node.name, active: node.active,
                position: node.position,
                rotation: { ...node.rotation, w: 1 },
                scale: node.scale,
                parent: node.parent ? node.parent.uuid : undefined,
                children: node.children.map(child => child.uuid),
                components: node.components.map(component => ({
                    type: component.type, enabled: component.enabled
                }))
            }
        };
    }

    private sceneInfo(): SceneResult<SceneInfo> {
        const header = this.sceneHeader();
        return {
            success: true,
            data: {
                name: header.sceneName,
                uuid: (this.spec && this.spec.uuid) || 'scene-uuid',
                nodeCount: header.nodeCount
            }
        };
    }

    private sceneNodes(): SceneResult<SceneDump> {
        const nodes: SceneNodeEntry[] = this.everyNode().map(node => ({
            uuid: node.uuid,
            name: node.name,
            path: this.pathOf(node),
            parentUuid: node.parent ? node.parent.uuid : null,
            active: node.active,
            activeInHierarchy: node.active,
            childCount: node.children.length,
            components: node.components.map((component): DumpedComponent => ({
                type: component.type, className: component.type,
                uuid: component.uuid, enabled: component.enabled
            })),
            position: node.position, rotation: node.rotation, scale: node.scale
        }));
        return { success: true, data: { ...this.sceneHeader(), nodes } };
    }

    private addComponentToNode(uuid: string, type: string): SceneResult<{ componentId: string }> {
        const node = this.requireNode(uuid);
        if (!this.registers(type)) return { success: false, error: `Component type not found: ${type}` };
        this.attach(node, { type });
        return { success: true, data: { componentId: node.components[node.components.length - 1].uuid } };
    }

    private componentOwners(className: string): SceneResult<ComponentOwnerReport> {
        const owners: ComponentOwner[] = [];
        for (const node of this.everyNode()) {
            for (const component of node.components) {
                if (component.type !== className) continue;
                owners.push({
                    nodePath: this.pathOf(node), nodeUuid: node.uuid, nodeName: node.name,
                    active: node.active, activeInHierarchy: node.active,
                    componentUuid: component.uuid, className: component.type,
                    enabled: component.enabled
                });
            }
        }
        return {
            success: true,
            data: {
                className, ...this.sceneHeader(), nodesScanned: this.everyNode().length,
                ownerCount: owners.length, owners
            }
        };
    }

    /**
     * The serializer answers under the names IT emits, which for an accessor is the backing field.
     * A component inside a prefab instance is absent from the scene file altogether, and its
     * overrides are what decide instead.
     */
    private serializedValue(uuid: string, cid: string, property: string): SceneResult<SerializedValue> {
        const missing = (reason: string): SceneResult<SerializedValue> =>
            ({ success: true, data: { found: false, value: null, reason } });
        const component = this.findComponent(uuid, cid);
        if (!component) return missing(`no component '${cid}' sits on the node`);
        if (this.requireNode(uuid).prefab) {
            return {
                success: true,
                data: {
                    found: false, value: null, inPrefabInstance: true,
                    reason: 'the scene file carries none of this component\'s properties'
                }
            };
        }
        if (component.serialized) {
            return property in component.serialized
                ? { success: true, data: { found: true, value: component.serialized[property] } }
                : missing(`the serializer does not emit '${property}'`);
        }
        const descriptor = component.props[property];
        return isDumpDescriptor(descriptor)
            ? { success: true, data: { found: true, value: descriptor.value } }
            : missing(`the serializer does not emit '${property}'`);
    }

    private overrideOutcome(
        uuid: string, cid: string, property: string
    ): SceneResult<PrefabOverrideOutcome> {
        const node = this.requireNode(uuid);
        const blank = {
            instanceRoot: null, prefabAsset: null, overridePaths: [], uncovered: [], untyped: []
        };
        if (!node.prefab) {
            return {
                success: true,
                data: { inPrefabInstance: false, known: false, carried: false, ...blank }
            };
        }
        const placed = { ...blank, instanceRoot: node.uuid, prefabAsset: node.prefab.asset };
        if (node.prefab.readable === false) {
            return {
                success: true,
                data: {
                    inPrefabInstance: true, known: false, carried: false, ...placed,
                    reason: 'the prefab asset behind this instance could not be read'
                }
            };
        }
        return node.prefab.recordsOverrides
            ? {
                success: true,
                data: {
                    inPrefabInstance: true, known: true, carried: true, ...placed,
                    overridePaths: [`${cid}.${property}`]
                }
            }
            : {
                success: true,
                data: {
                    inPrefabInstance: true, known: true, carried: false, ...placed,
                    uncovered: [property]
                }
            };
    }

    // ----- References ------------------------------------------------------------------------

    private referencePlan(args: ReferenceArgs): SceneResult<ReferencePlanReport> {
        const node = this.requireNode(args.nodeUuid);
        const componentIndex = node.components
            .findIndex(component => component.type === args.componentType);
        if (componentIndex < 0) {
            return { success: false, error: `the node carries no component '${args.componentType}'` };
        }
        const descriptor = node.components[componentIndex].props[args.property];
        if (!isDumpDescriptor(descriptor)) {
            return {
                success: false,
                error: `component '${args.componentType}' has no property '${args.property}'`
            };
        }

        const wanted = args.clear === true
            ? []
            : args.targetUuids || (args.targetUuid === undefined ? [] : [args.targetUuid]);
        const targets: LiveNode[] = [];
        for (const uuid of wanted) {
            const target = this.byUuid.get(uuid) || this.ownerOfComponent(uuid);
            if (!target) {
                return { success: false, error: `Target uuid '${uuid}' matched no node and no component` };
            }
            targets.push(target);
        }

        const declared = typeof descriptor.type === 'string' ? descriptor.type : null;
        return {
            success: true,
            data: {
                componentIndex,
                property: args.property,
                isArray: descriptor.isArray === true || Array.isArray(descriptor.value),
                dumpType: declared || 'cc.Node',
                uuids: wanted,
                expected: wanted.length ? wanted : [null],
                assignedKind: wanted.length && this.byUuid.has(wanted[0]) ? 'node' : 'component',
                assignedNames: targets.map(target => target.name),
                assignedTypes: targets.map(() => 'Node'),
                declaredType: declared,
                inferredType: null
            }
        };
    }

    private ownerOfComponent(uuid: string): LiveNode | undefined {
        return this.everyNode()
            .find(node => node.components.some(component => component.uuid === uuid));
    }

    private applyReference(
        args: ReferenceArgs
    ): SceneResult<{ property: string; assigned: Array<string | null> }> {
        const plan = this.referencePlan(args);
        if (!plan.success) return plan;
        const node = this.requireNode(args.nodeUuid);
        const descriptor = node.components[plan.data.componentIndex]
            .props[args.property] as PropertyDescriptor;
        const { uuids, isArray } = plan.data;
        descriptor.value = isArray ? uuids.map(uuid => ({ uuid })) : { uuid: uuids[0] || '' };
        return { success: true, data: { property: args.property, assigned: uuids.length ? uuids : [null] } };
    }

    /**
     * `serialized` and `projected` diverge from `live` only inside a prefab instance: the scene file
     * holds null there, and an override is what puts the value back after the next load.
     */
    private referenceOutcome(
        uuid: string, componentIndex: number, property: string
    ): SceneResult<ReferenceOutcomeReport> {
        const node = this.requireNode(uuid);
        const component = node.components[componentIndex];
        if (!component) return { success: false, error: `no component at index ${componentIndex}` };
        const live = referencedSlots(component.props[property]);
        const lost = live.map(() => null);
        const prefab = node.prefab;
        const outcome = (report: Partial<ReferenceOutcomeReport>): SceneResult<ReferenceOutcomeReport> => ({
            success: true,
            data: {
                live, serialized: live, projected: live, projectionChecked: true,
                componentInSceneGraph: true, overrides: [], ...report
            }
        });

        if (!prefab) return outcome({});
        if (prefab.readable === false) {
            return outcome({ serialized: lost, projected: lost, projectionChecked: false });
        }
        return prefab.recordsOverrides
            ? outcome({
                serialized: lost,
                overrides: live.map((slot, index) => ({ index, uuid: slot, prefabInstance: node.uuid }))
            })
            : outcome({ serialized: lost, projected: lost });
    }

    private findComponent(uuid: string, cid: string): LiveComponent | undefined {
        const node = this.byUuid.get(uuid);
        return node && node.components.find(component => component.type === cid);
    }
}

export interface MemoryCall {
    name: string;
    args: unknown[];
}

export interface MemoryComponent {
    /** The name the class is REGISTERED under, which is what the editor's dump names it by. */
    type: string;
    enabled?: boolean;
    /** Property descriptors as the editor's dump carries them — see `test/fixtures/descriptors.json`. */
    props?: Record<string, unknown>;
    /** What the serializer emits, under the names IT emits; absent mirrors the live dump. */
    serialized?: Record<string, unknown>;
}

export interface MemoryPrefabInstance {
    asset: string;
    /** `false` is an asset the scene cannot read, so nothing may be concluded about the next load. */
    readable?: boolean;
    /** Whether the editor records an override; without one the next load rebuilds the asset's value. */
    recordsOverrides?: boolean;
}

export interface MemoryNode {
    name: string;
    uuid?: string;
    active?: boolean;
    layer?: number;
    position?: Vec3Like;
    rotation?: Vec3Like;
    scale?: Vec3Like;
    components?: MemoryComponent[];
    children?: MemoryNode[];
    prefab?: MemoryPrefabInstance;
}

/** Editor messages that refuse, each carrying the refusal it answers with. */
export interface MemoryRefusals {
    setProperty?: string;
    beginRecording?: string;
    endRecording?: string;
}

export interface MemoryScene {
    name?: string;
    uuid?: string;
    nodes?: MemoryNode[];
    /** `db://` url → uuid, the asset database's whole contents. */
    assets?: Record<string, string>;
    /** The class names the engine registers; a scene naming none registers every spelling. */
    classes?: string[];
    refuses?: MemoryRefusals;
}

interface LiveComponent {
    uuid: string;
    type: string;
    enabled: boolean;
    props: Record<string, unknown>;
    serialized: Record<string, unknown> | null;
}

interface LiveNode {
    uuid: string;
    name: string;
    active: boolean;
    layer: number;
    position: Vec3Like;
    rotation: Vec3Like;
    scale: Vec3Like;
    parent: LiveNode | null;
    children: LiveNode[];
    components: LiveComponent[];
    prefab: MemoryPrefabInstance | null;
}

interface ReferenceArgs {
    nodeUuid: string;
    componentType: string;
    property: string;
    targetUuid?: string;
    targetUuids?: string[];
    clear?: boolean;
}

type ModelledEditor = { [G in keyof EditorMethods]?: Partial<EditorMethods[G]> };

/** 1 << 30, the value of cc.Layers.Enum.DEFAULT. */
const LAYER_DEFAULT = 1073741824;

/** The uuids a reference descriptor holds now, one slot per element for an array. */
function referencedSlots(descriptor: unknown): Array<string | null> {
    if (!isDumpDescriptor(descriptor)) return [null];
    const projected = projectValue(resolveKind(descriptor), descriptor.value);
    const slot = (value: unknown) => (typeof value === 'string' && value ? value : null);
    return Array.isArray(projected) ? projected.map(slot) : [slot(projected)];
}

const NODE_FIELDS = ['name', 'active', 'layer', 'position', 'rotation', 'scale'] as const;

function writeNodeField(
    node: LiveNode, segments: string[], path: string, written: PropertyDump
): void {
    const field = NODE_FIELDS.find(known => known === segments[0]);
    if (!field || segments.length > 1) {
        throw new Error(`set-property refused '${path}': a node carries no such property`);
    }
    Object.assign(node, { [field]: written.value });
}

/**
 * `set-property` addresses one leaf through the descriptor tree the dump exposes, so the path walks
 * the same `{value}` wrappers: `waves.0.squads.0.prefab` steps through three descriptors and an
 * array. A missing step is a refusal rather than a slot invented on the way down.
 */
function writeIntoDescriptors(
    props: Record<string, unknown>, segments: string[], path: string, written: PropertyDump
): void {
    let container: unknown = props;
    for (const segment of segments.slice(0, -1)) {
        const child = Array.isArray(container)
            ? container[Number(segment)]
            : (container as Record<string, unknown>)[segment];
        if (child === undefined || child === null) {
            throw new Error(`set-property refused '${path}': nothing sits at '${segment}'`);
        }
        container = child && typeof child === 'object' && !Array.isArray(child) && 'value' in child
            ? (child as { value: unknown }).value
            : child;
    }

    const leaf = segments[segments.length - 1];
    if (Array.isArray(container)) {
        const slot = Number(leaf);
        const existing = container[slot];
        container[slot] = isDumpDescriptor(existing) ? { ...existing, value: written.value } : written.value;
        return;
    }
    const holder = container as Record<string, unknown>;
    const existing = holder[leaf];
    holder[leaf] = {
        ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}),
        ...(written.type === undefined ? {} : { type: written.type }),
        value: written.value
    };
}
