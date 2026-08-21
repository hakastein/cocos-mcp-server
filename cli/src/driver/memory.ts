import { EDITOR_METHODS, buildPathIndex, resolvePathInIndex } from '@cocos-cli/shared';
import type {
    AddedSkeletalSocket, BuildTask, BuildTaskOptions, BuildTasksInfo, ComponentOwner,
    ComponentOwnerReport, Driver, DumpedComponent,
    EditorMethods, GeneratedPrefab, MissingScriptEntry, NodeDump, NodeInfo, PathIndexNode,
    PathResolution, PrefabAssetDump, PrefabLinkageReport, PrefabOverrideOutcome,
    PrefabOverrideRecord, PrefabOverrideRemoval, PrefabOverrideReport, PrefabSyncReport,
    PropertyDump, ReferenceOutcomeReport, ReferencePlanReport, RemovedSkeletalSocket,
    SceneDirtyReport, SceneDump, SceneFacade, SceneInfo, SceneMethods, SceneNodeEntry, SceneResult,
    SerializedValue, SkeletalSocket, SkeletalSocketList, Vec3Like
} from '@cocos-cli/shared';
import { isDumpDescriptor, resolveKind } from '../property/kind.ts';
import { projectValue } from '../property/readers.ts';
import { NODE_STORAGE } from '../node-write.ts';
import { MemoryAssetDb } from './memory-assets.ts';
import type { PropertyDescriptor } from '../property/kind.ts';
import type { NodeStoredProperty } from '../node-write.ts';

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
    private readonly assets: MemoryAssetDb;
    private readonly builder: MemoryBuilder;
    private readonly refuses: MemoryRefusals;
    /** Property overrides the editor recorded, keyed by the uuid of the instance root holding them. */
    private readonly overrides = new Map<string, PrefabOverrideRecord[]>();

    constructor(spec?: MemoryScene) {
        this.spec = spec || null;
        this.assets = new MemoryAssetDb((spec && spec.assets) || {});
        this.builder = (spec && spec.builder) || {};
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
            fileId: '',
            parent,
            children: [],
            components: [],
            sockets: []
        };
        node.fileId = `${node.uuid}.f`;
        this.byUuid.set(node.uuid, node);
        for (const component of spec.components || []) this.attach(node, component);
        for (const child of spec.children || []) node.children.push(this.adopt(child, node));
        for (const socket of spec.sockets || []) this.attachSocket(node, socket);
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

    /**
     * The prefab instance this node belongs to, which is the node itself when it is the instance
     * root. A node inside one carries none of its own properties in the scene file.
     */
    private instanceOf(node: LiveNode): LiveNode | null {
        for (let at: LiveNode | null = node; at; at = at.parent) if (at.prefab) return at;
        return null;
    }

    /**
     * Writing any property inside a prefab instance makes the editor record an override on the
     * instance root — checked live. Without one the next load rebuilds the value from the asset.
     */
    private recordOverride(node: LiveNode, property: NodeStoredProperty): void {
        const instance = this.instanceOf(node);
        if (!instance || instance.prefab!.recordsOverrides !== true) return;
        const records = this.overrides.get(instance.uuid) || [];
        records.push({
            index: records.length,
            propertyPath: NODE_STORAGE[property],
            propertyPathParts: [NODE_STORAGE[property]],
            localID: [node.fileId],
            target: { kind: 'node', name: node.name, path: this.pathOf(node), type: 'cc.Node' },
            valueKind: 'primitive'
        });
        this.overrides.set(instance.uuid, records);
    }

    /** The engine holds a fixed set of registered classes; a scene that names none registers any. */
    private registers(type: string): boolean {
        if (this.gainedFor(type)) return true;
        const classes = this.spec && this.spec.classes;
        return !classes || classes.includes(type);
    }

    private gainedFor(spelling: string): string[] | undefined {
        const attaches = this.spec && this.spec.attaches;
        return attaches ? attaches[spelling] : undefined;
    }

    private attachRequested(node: LiveNode, spelling: string): void {
        for (const type of this.gainedFor(spelling) || [spelling]) {
            if (!node.components.some(component => component.type === type)) {
                this.attach(node, { type });
            }
        }
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
            this.recordOverride(node, writeNodeField(node, segments, path, written));
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
            parent: { value: { uuid: node.parent ? node.parent.uuid : this.sceneUuid() } },
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
                    const parent = options.parent === undefined
                        ? null
                        : this.requireNode(String(options.parent));
                    // `createNodeFromAsset` keeps the PrefabInfo only on the `cc.Prefab` branch that
                    // was not asked to unlink; every other call gets a flat copy, silently.
                    const linked = options.assetUuid !== undefined
                        && options.type === 'cc.Prefab' && options.unlinkPrefab !== true;
                    const child = this.adopt({
                        name: String(options.name || 'New Node'),
                        prefab: linked ? { asset: String(options.assetUuid) } : undefined,
                        position: dumpedPosition(options)
                    }, parent);
                    (parent ? parent.children : this.roots).push(child);
                    return child.uuid;
                },
                setParent: async ({ parent, uuids }) => {
                    const target = this.requireNode(String(parent));
                    for (const uuid of uuids as string[]) {
                        const node = this.requireNode(uuid);
                        const siblings = node.parent ? node.parent.children : this.roots;
                        siblings.splice(siblings.indexOf(node), 1);
                        node.parent = target;
                        target.children.push(node);
                    }
                    return uuids as string[];
                },
                duplicateNode: async uuid => {
                    const node = this.requireNode(String(uuid));
                    const parent = node.parent;
                    const copy = this.adopt(this.asSpec(node), parent);
                    (parent ? parent.children : this.roots).push(copy);
                    return copy.uuid;
                },
                createComponent: async options => {
                    const node = this.requireNode(options.uuid);
                    if (this.registers(options.component)) this.attachRequested(node, options.component);
                },
                removeComponent: async ({ uuid }) => {
                    for (const node of this.everyNode()) {
                        const at = node.components.findIndex(component => component.uuid === uuid);
                        if (at >= 0) { node.components.splice(at, 1); return; }
                    }
                    throw new Error(`no component ${uuid} is in the open scene`);
                },
                resetProperty: async ({ uuid, path }) => {
                    this.resetNodeProperty(this.requireNode(uuid), path);
                    return true;
                },
                resetNode: async ({ uuid }) => {
                    for (const one of Array.isArray(uuid) ? uuid : [uuid]) {
                        const node = this.requireNode(one);
                        for (const kind of TRANSFORM_PROPERTIES) this.resetNodeProperty(node, kind);
                    }
                    return true;
                },
                resetComponent: async ({ uuid }) => {
                    const component = this.componentByUuid(uuid);
                    if (!component) throw new Error(`no component ${uuid} is in the open scene`);
                    for (const descriptor of Object.values(component.props)) {
                        if (isDumpDescriptor(descriptor) && 'default' in descriptor) {
                            descriptor.value = descriptor.default;
                        }
                    }
                },
                // Both array messages answer `true` for an index outside the array and change
                // nothing — checked live 2026-08-21, which is why a command reads the array back.
                moveArrayElement: async ({ uuid, path, target, offset }) => {
                    const array = this.arrayAt(this.requireNode(uuid), path);
                    const landing = target + offset;
                    if (inRange(array, target) && inRange(array, landing)) {
                        array.splice(landing, 0, array.splice(target, 1)[0]);
                    }
                    return true;
                },
                removeArrayElement: async ({ uuid, path, index }) => {
                    const array = this.arrayAt(this.requireNode(uuid), path);
                    if (inRange(array, index)) array.splice(index, 1);
                    return true;
                },
                queryComponents: async () => ((this.spec && this.spec.offeredComponents) || []) as never,
                queryClasses: async options => {
                    const base = (options as { extends?: string }).extends;
                    const registry = (this.spec && this.spec.registeredClasses) || {};
                    const names = base === undefined ? [] : registry[base] || [];
                    return names
                        .filter(name => (options as { excludeSelf?: boolean }).excludeSelf !== true
                            || name !== base)
                        .map(name => ({ name }));
                },
                queryNodesByAssetUuid: async assetUuid => this.everyNode()
                    .filter(node => this.usesAsset(node, assetUuid))
                    .map(node => node.uuid),
                closeScene: async () => !this.spec || this.spec.closeScene !== false,
                softReload: async () => undefined,
                removeNode: async ({ uuid }) => {
                    const node = this.requireNode(String(uuid));
                    const siblings = node.parent ? node.parent.children : this.roots;
                    siblings.splice(siblings.indexOf(node), 1);
                    const forget = (gone: LiveNode) => {
                        this.byUuid.delete(gone.uuid);
                        gone.children.forEach(forget);
                    };
                    forget(node);
                },
                openScene: async () => undefined,
                saveScene: async () => undefined,
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
                queryUuid: async url => this.assets.uuidOf(url) as string,
                queryUrl: async uuid => this.assets.urlOf(uuid) as string,
                queryAssetInfo: async urlOrUuid => this.assets.find(urlOrUuid) as never,
                queryAssets: async query => this.assets.under(
                    (query as { pattern: string }).pattern) as never,
                queryReady: async () => true,
                refreshAsset: async () => undefined,
                reimportAsset: async () => undefined,
                moveAsset: async (...args) => {
                    this.assets.move(args[0], args[1], args[2] || {});
                    return null as never;
                },
                copyAsset: async (...args) => {
                    this.assets.copy(args[0], args[1], args[2] || {});
                    return null as never;
                },
                createAsset: async (...args) => {
                    this.assets.create(args[0]);
                    return null as never;
                },
                deleteAsset: async url => {
                    this.assets.remove(url);
                    return null as never;
                }
            },
            builder: {
                queryWorkerReady: async () => this.builder.ready !== false,
                openPanel: async () => { },
                queryTasksInfo: async (): Promise<BuildTasksInfo> => {
                    if (this.refuses.queryTasksInfo) throw new Error(this.refuses.queryTasksInfo);
                    return { list: this.buildTasks(), free: this.builder.idle };
                },
                queryTask: async taskId =>
                    this.buildTasks().find(task => String(task.id) === String(taskId)) || null,
                checkAndCompleteOptions: async options =>
                    this.builder.completesOptions === false ? null : options,
                addTask: async options => {
                    if (this.builder.buildTakesMs) await sleep(this.builder.buildTakesMs);
                    return this.runBuild(options);
                }
            },
            project: {
                profile: async (platform, key) => (this.builder.profile || {})[`${platform}.${key}`]
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

    // ----- The build panel as data -------------------------------------------------------------

    private buildTasks(): BuildTask[] {
        return this.builder.tasks || (this.builder.tasks = []);
    }

    /**
     * Building a task writes the options it was given back onto that task — the fact the whole
     * conflict refusal exists for, so the scene models it rather than answering an exit code alone.
     */
    private runBuild(options: BuildTaskOptions): number {
        const tasks = this.buildTasks();
        const existing = tasks.find(task => String(task.id) === String(options.taskId));
        const task = existing || { id: options.taskId || `task-${tasks.length + 1}` };
        if (!existing) tasks.push(task);
        task.options = { ...task.options, ...options };
        task.state = this.builder.finalState === undefined ? 'success' : this.builder.finalState;
        task.message = this.builder.message;
        return this.builder.exitCode === undefined ? 36 : this.builder.exitCode;
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
            pruneComponentReferenceOverrides: () => ({ success: true, data: { removed: 0, paths: [] } }),
            serializedNodeValue: ([uuid, property]) =>
                this.serializedNode(uuid as string, property as string),
            nodePrefabLinkage: ([uuid]) => this.prefabLinkage(uuid as string),
            listPrefabOverrides: ([uuid]) => this.prefabOverrides(uuid as string),
            removePrefabOverride: ([uuid, property, localID, index]) => this.removeOverride(
                uuid as string, property as string, localID as string | undefined,
                index as number | undefined),
            applyPrefabToAsset: ([uuid]) => this.prefabSync(uuid as string),
            revertPrefabInstance: ([uuid]) => this.prefabSync(uuid as string),
            createPrefabFromNode2: ([uuid]) => this.generatedPrefab(uuid as string),
            dumpPrefabAsset: ([uuid]) => this.prefabAssetDump(uuid as string),
            sceneDirtyAgainstDisk: () => ({
                success: true,
                data: (this.spec && this.spec.dirty)
                    || { differsFromDisk: false, scenePath: null, diffs: [] }
            }),
            dumpMissingScripts: () => ({
                success: true, data: { entries: (this.spec && this.spec.missingScripts) || [] }
            }),
            listSkeletalSockets: ([uuid]) => this.socketList(uuid as string),
            addSkeletalSocket: ([uuid, bonePath, targetName]) =>
                this.addSocket(uuid as string, bonePath as string, targetName as string | undefined),
            removeSkeletalSocket: ([uuid, bonePath]) =>
                this.removeSocket(uuid as string, bonePath as string)
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

    /** A root node's parent is the scene itself, which the dump names by uuid like any other. */
    private sceneUuid(): string {
        return (this.spec && this.spec.uuid) || 'scene-uuid';
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
                    className: component.type, enabled: component.enabled
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
                uuid: this.sceneUuid(),
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
                className: component.type, uuid: component.uuid, enabled: component.enabled
            })),
            position: node.position, rotation: node.rotation, scale: node.scale
        }));
        return { success: true, data: { ...this.sceneHeader(), nodes } };
    }

    private addComponentToNode(uuid: string, type: string): SceneResult<{ componentId: string }> {
        const node = this.requireNode(uuid);
        if (!this.registers(type)) return { success: false, error: `Component type not found: ${type}` };
        this.attachRequested(node, type);
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

    /**
     * What the serializer emits for a node's own property. Everything inside a prefab instance is
     * absent from the scene file — except the instance root's `_parent`, which the stub does carry.
     */
    private serializedNode(uuid: string, property: string): SceneResult<SerializedValue> {
        const node = this.requireNode(uuid);
        const field = STORED_FIELDS[property];
        if (!field) return { success: true, data: { found: false, value: undefined } };

        const instance = this.instanceOf(node);
        if (instance && !(node.prefab && field === 'parent')) {
            return {
                success: true,
                data: {
                    found: false,
                    value: undefined,
                    inPrefabInstance: true,
                    reason: instance === node
                        ? `'${node.name}' is the root of a prefab instance`
                        : `'${node.name}' is inside the prefab instance '${instance.name}'`
                }
            };
        }
        return {
            success: true,
            data: { found: true, value: field === 'parent' ? this.serializedParent(node) : node[field] }
        };
    }

    /**
     * A parent NODE is named by uuid; the scene is expanded into its own record, because the
     * serializer shortens back-references to `cc.Node` entries alone.
     */
    private serializedParent(node: LiveNode): unknown {
        if (node.parent) return { uuid: node.parent.uuid };
        return {
            _name: this.sceneHeader().sceneName,
            _children: this.roots.map(root => ({ uuid: root.uuid })),
            _id: this.sceneUuid()
        };
    }

    private prefabLinkage(uuid: string): SceneResult<PrefabLinkageReport> {
        const node = this.requireNode(uuid);
        const instance = this.instanceOf(node);
        return {
            success: true,
            data: {
                linked: instance !== null,
                asset: instance ? instance.prefab!.asset : null,
                fileId: instance ? node.fileId : null,
                instanceRoot: node.prefab !== null,
                persistenceChecked: true,
                persisted: instance !== null,
                persistedAsset: instance ? instance.prefab!.asset : null
            }
        };
    }

    private prefabOverrides(uuid: string): SceneResult<PrefabOverrideReport> {
        const node = this.requireNode(uuid);
        if (!node.prefab) return { success: false, error: `Node '${node.name}' carries no PrefabInstance` };
        if (node.prefab.readable === false) {
            return { success: false, error: 'the prefab asset behind this instance could not be read' };
        }
        const overrides = this.overrides.get(node.uuid) || [];
        return {
            success: true,
            data: {
                nodeUuid: node.uuid,
                nodeName: node.name,
                prefabAsset: node.prefab.asset,
                overrideCount: overrides.length,
                removedComponents: 0,
                mountedChildren: 0,
                overrides
            }
        };
    }

    /**
     * `index` is the position in the WHOLE override list, the way the scene script reads it, and an
     * ambiguous property with neither `index` nor `localID` is refused rather than resolved to the
     * first match — a caller that removed the wrong override would never learn of it.
     */
    private removeOverride(
        uuid: string, property: string, localID?: string, index?: number
    ): SceneResult<PrefabOverrideRemoval> {
        const node = this.requireNode(uuid);
        const records = this.overrides.get(node.uuid) || [];
        const matching = records.filter((record, at) => {
            if (index !== undefined && at !== index) return false;
            if (record.propertyPath !== property) return false;
            const chain = record.localID || [];
            return !localID || chain[chain.length - 1] === localID;
        });
        if (!matching.length) {
            return { success: false, error: `no override of '${property}' is on '${node.name}'` };
        }
        if (matching.length > 1) {
            return {
                success: false,
                error: `'${property}' matches ${matching.length} overrides — pass localID or index`
            };
        }
        const removed = matching[0];
        records.splice(records.indexOf(removed), 1);
        return { success: true, data: { nodeUuid: node.uuid, removed, remaining: records.length } };
    }

    /** `apply` and `revert` answer the same shape, and both leave the memory scene as it was: what a
     * command decides about either is read off the answer, never off the tree. */
    private prefabSync(uuid: string): SceneResult<PrefabSyncReport> {
        const node = this.requireNode(uuid);
        if (!node.prefab) return { success: false, error: `Node '${node.name}' carries no PrefabInstance` };
        return {
            success: true,
            data: {
                nodeUuid: node.uuid,
                nodeName: node.name,
                prefabAsset: node.prefab.asset,
                instanceRoot: true,
                accepted: node.prefab.syncAccepted === undefined ? true : node.prefab.syncAccepted
            }
        };
    }

    private generatedPrefab(uuid: string): SceneResult<GeneratedPrefab> {
        const node = this.requireNode(uuid);
        return {
            success: true,
            data: { prefabData: `[serialized ${node.name}]`, nodeName: node.name }
        };
    }

    private prefabAssetDump(prefabUuid: string): SceneResult<PrefabAssetDump> {
        const dump = ((this.spec && this.spec.prefabAssets) || {})[prefabUuid];
        if (!dump) return { success: false, error: `no prefab asset ${prefabUuid} could be read` };
        return { success: true, data: dump };
    }

    /** A copy is built through `adopt`, so it gets its own uuids and file ids just as the original did. */
    private asSpec(node: LiveNode): MemoryNode {
        return {
            name: node.name,
            active: node.active,
            layer: node.layer,
            position: { ...node.position },
            rotation: { ...node.rotation },
            scale: { ...node.scale },
            prefab: node.prefab || undefined,
            components: node.components.map(component => ({
                type: component.type,
                enabled: component.enabled,
                props: { ...component.props },
                serialized: component.serialized || undefined
            })),
            children: node.children.map(child => this.asSpec(child))
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

    private componentByUuid(uuid: string): LiveComponent | undefined {
        for (const node of this.everyNode()) {
            const found = node.components.find(component => component.uuid === uuid);
            if (found) return found;
        }
        return undefined;
    }

    // ----- Resets ----------------------------------------------------------------------------

    /**
     * The declared class default, wherever the node sits — checked live 2026-08-21: a node inside a
     * prefab instance resets to the default too, and the editor records THAT as an override rather
     * than dropping the one it had.
     */
    private resetNodeProperty(node: LiveNode, property: string): void {
        const field = NODE_FIELDS.find(known => known === property);
        if (!field) throw new Error(`reset-property refused '${property}': a node carries no such property`);
        const restored = NODE_DEFAULTS[field];
        if (restored === undefined) {
            throw new Error(`the engine declares no default for '${property}'`);
        }
        Object.assign(node, { [field]: restored });
        this.recordOverride(node, field);
    }

    // ----- Arrays ----------------------------------------------------------------------------

    /** The array a `__comps__.<index>.<property>` path addresses, inside the descriptor tree itself. */
    private arrayAt(node: LiveNode, path: string): unknown[] {
        const segments = path.split('.');
        if (segments[0] !== '__comps__') {
            throw new Error(`the memory scene models array edits on component properties only, not '${path}'`);
        }
        const component = node.components[Number(segments[1])];
        if (!component) throw new Error(`'${path}' addresses a component the node does not carry`);
        let held: unknown = component.props;
        for (const segment of segments.slice(2)) {
            const child = (held as Record<string, unknown>)[segment];
            held = isDumpDescriptor(child) ? child.value : child;
        }
        if (!Array.isArray(held)) throw new Error(`'${path}' is not an array`);
        return held;
    }

    // ----- Assets a node depends on ----------------------------------------------------------

    /** By instance, or by any component field holding the uuid — the editor answers both. */
    private usesAsset(node: LiveNode, assetUuid: string): boolean {
        if (node.prefab && node.prefab.asset === assetUuid) return true;
        return node.components.some(component => Object.values(component.props)
            .some(descriptor => referencedSlots(descriptor).includes(assetUuid)));
    }

    // ----- Skeletal sockets ------------------------------------------------------------------

    private attachSocket(node: LiveNode, spec: MemorySocket): void {
        const target = this.adopt({ name: spec.targetName || socketNameFor(spec.path) }, node);
        node.children.push(target);
        node.sockets.push({ path: spec.path, target });
    }

    /**
     * Every socket call goes through the live `cc.SkeletalAnimation` component, so a node without
     * one is refused rather than answered with an empty list.
     */
    private skeletalOf(uuid: string): LiveNode | { error: string } {
        const node = this.requireNode(uuid);
        return node.components.some(component => component.type === SKELETAL_ANIMATION)
            ? node
            : { error: 'Node has no cc.SkeletalAnimation component' };
    }

    private socketList(uuid: string): SceneResult<SkeletalSocketList> {
        const node = this.skeletalOf(uuid);
        if ('error' in node) return { success: false, error: node.error };
        return {
            success: true,
            data: {
                nodeUuid: node.uuid,
                useBakedAnimation: this.bakedAnimation(node),
                sockets: node.sockets.map((socket): SkeletalSocket => ({
                    path: socket.path,
                    targetUuid: socket.target.uuid,
                    targetName: socket.target.name,
                    targetChildren: socket.target.children.map(child => child.name)
                }))
            }
        };
    }

    private bakedAnimation(node: LiveNode): boolean {
        const component = node.components.find(one => one.type === SKELETAL_ANIMATION);
        const descriptor = component && component.props.useBakedAnimation;
        return isDumpDescriptor(descriptor) ? descriptor.value !== false : true;
    }

    /** Idempotent, and a bone path naming no descendant is refused: the driver does both. */
    private addSocket(
        uuid: string, bonePath: string, targetName?: string
    ): SceneResult<AddedSkeletalSocket> {
        const node = this.skeletalOf(uuid);
        if ('error' in node) return { success: false, error: node.error };
        if (!bonePath) return { success: false, error: 'bonePath must be a non-empty bone path string' };

        const wanted = targetName && targetName.trim() ? targetName.trim() : null;
        const existing = node.sockets.find(socket => socket.path === bonePath);
        if (existing) {
            const renamed = !!wanted && existing.target.name !== wanted;
            if (wanted) existing.target.name = wanted;
            return {
                success: true,
                data: {
                    targetUuid: existing.target.uuid, targetName: existing.target.name,
                    bonePath, created: false, renamed, socketCount: node.sockets.length
                }
            };
        }
        if (!this.jointAt(node, bonePath)) {
            return {
                success: false,
                error: `Bone path '${bonePath}' does not resolve to a child joint of node '${node.name}'`
            };
        }
        this.attachSocket(node, { path: bonePath, targetName: wanted || undefined });
        const created = node.sockets[node.sockets.length - 1];
        return {
            success: true,
            data: {
                targetUuid: created.target.uuid, targetName: created.target.name,
                bonePath, created: true, renamed: !!wanted, socketCount: node.sockets.length
            }
        };
    }

    private removeSocket(uuid: string, bonePath: string): SceneResult<RemovedSkeletalSocket> {
        const node = this.skeletalOf(uuid);
        if ('error' in node) return { success: false, error: node.error };
        const match = node.sockets.find(socket => socket.path === bonePath);
        if (!match) {
            return { success: false, error: `No socket with bone path '${bonePath}' on this node` };
        }
        node.sockets.splice(node.sockets.indexOf(match), 1);
        node.children.splice(node.children.indexOf(match.target), 1);
        this.byUuid.delete(match.target.uuid);
        return {
            success: true,
            data: { bonePath, removedTargetUuid: match.target.uuid, socketCount: node.sockets.length }
        };
    }

    /** A bone path is a chain of child names under the node, the way `getChildByPath` walks it. */
    private jointAt(node: LiveNode, bonePath: string): LiveNode | undefined {
        let at: LiveNode | undefined = node;
        for (const name of bonePath.split('/')) {
            at = at && at.children.find(child => child.name === name);
        }
        return at;
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
    /** What `apply`/`revert` answer as `accepted`; `null` is the editor not saying either way. */
    syncAccepted?: boolean | null;
}

/** A socket of the node's `cc.SkeletalAnimation`, with the child node that tracks the bone. */
export interface MemorySocket {
    /** The bone path, which has to name a chain of descendants for an add to be accepted. */
    path: string;
    targetName?: string;
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
    sockets?: MemorySocket[];
}

/** Editor messages that refuse, each carrying the refusal it answers with. */
export interface MemoryRefusals {
    setProperty?: string;
    queryTasksInfo?: string;
    beginRecording?: string;
    endRecording?: string;
}

/** The Build panel held as data: the worker, its rows, and what a build of one resolves with. */
export interface MemoryBuilder {
    ready?: boolean;
    idle?: boolean;
    tasks?: BuildTask[];
    /** What `add-task` resolves with; 36 is the editor's BUILD_SUCCESS. */
    exitCode?: number;
    /** The state the built task carries afterwards. */
    finalState?: string;
    /** How long `add-task` takes to resolve, for a build the caller stops waiting for. */
    buildTakesMs?: number;
    message?: string;
    /** `check-and-complete-options` is outside the public typings and may answer nothing. */
    completesOptions?: boolean;
    /** `<platform>.<key>` → what `Editor.Profile.getProject` answers for it. */
    profile?: Record<string, unknown>;
}

export interface MemoryScene {
    name?: string;
    uuid?: string;
    nodes?: MemoryNode[];
    /** `db://` url → uuid, the asset database's whole contents. */
    assets?: Record<string, string>;
    /** The class names the engine registers; a scene naming none registers every spelling. */
    classes?: string[];
    /**
     * What a node GAINS when an add is given this spelling, in the order the editor attaches it: a
     * class that declares a requirement gets that requirement attached ahead of itself. A spelling
     * absent from here attaches itself alone, and one present here registers whatever `classes` says.
     */
    attaches?: Record<string, string[]>;
    refuses?: MemoryRefusals;
    /** What the scene answers when asked how it differs from the file on disk. */
    dirty?: SceneDirtyReport;
    missingScripts?: MissingScriptEntry[];
    /** Prefab asset uuid → the dump `dumpPrefabAsset` answers for it. */
    prefabAssets?: Record<string, PrefabAssetDump>;
    /** What the editor offers in its Add Component menu, which is not the class registry below. */
    offeredComponents?: Array<{ name: string; cid?: string; path?: string; assetUuid?: string }>;
    /** Base class → the classes the engine registers under it; `query-classes` reads no other way. */
    registeredClasses?: Record<string, string[]>;
    /** What `close-scene` answers; the editor says `false` when it will not close the scene. */
    closeScene?: boolean;
    builder?: MemoryBuilder;
}

interface LiveComponent {
    uuid: string;
    type: string;
    enabled: boolean;
    props: Record<string, unknown>;
    serialized: Record<string, unknown> | null;
}

interface LiveSocket {
    path: string;
    target: LiveNode;
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
    /** The node's id inside its prefab, which is what an override record points at. */
    fileId: string;
    sockets: LiveSocket[];
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

function dumpedPosition(options: unknown): Vec3Like | undefined {
    const dump = (options as { dump?: { position?: { value?: Vec3Like } } }).dump;
    return dump && dump.position && dump.position.value ? dump.position.value : undefined;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

type NodeField = typeof NODE_FIELDS[number];

/** What `reset-node` returns, checked live 2026-08-21: the transform alone, the name untouched. */
const TRANSFORM_PROPERTIES = ['position', 'rotation', 'scale'] as const;

/** Only the four the editor declares a default for; `name` and `active` carry `default: null`. */
const NODE_DEFAULTS: Partial<Record<NodeField, unknown>> = {
    layer: LAYER_DEFAULT,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 }
};

const SKELETAL_ANIMATION = 'cc.SkeletalAnimation';

/** `createSocket` names the target node after the last bone of the path. */
function socketNameFor(bonePath: string): string {
    const bones = bonePath.split('/');
    return `${bones[bones.length - 1]} Socket`;
}

function inRange(array: readonly unknown[], index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < array.length;
}

/** The serializer's spelling back to the field the live node holds it in. */
const STORED_FIELDS: Record<string, NodeStoredProperty> = Object.fromEntries(
    Object.entries(NODE_STORAGE).map(([field, stored]) => [stored, field as NodeStoredProperty]));

function writeNodeField(
    node: LiveNode, segments: string[], path: string, written: PropertyDump
): NodeStoredProperty {
    const field = NODE_FIELDS.find(known => known === segments[0]);
    if (!field || segments.length > 1) {
        throw new Error(`set-property refused '${path}': a node carries no such property`);
    }
    Object.assign(node, { [field]: written.value });
    return field;
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
