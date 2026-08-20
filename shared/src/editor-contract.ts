type Params<T> = T extends { params: infer A extends unknown[] } ? A : never;
type Result<T> = T extends { result: infer R } ? R : never;

/** Forwards verbatim: both halves of the signature are Creator's own, so neither can drift from it. */
type Message<P extends keyof EditorMessageMaps, M extends keyof EditorMessageMaps[P]> =
    (...args: Params<EditorMessageMaps[P][M]>) => Promise<Result<EditorMessageMaps[P][M]>>;

/** The arguments stay Creator's; the answer is ours, for a message whose declared result is wrong. */
type Answering<P extends keyof EditorMessageMaps, M extends keyof EditorMessageMaps[P], R> =
    (...args: Params<EditorMessageMaps[P][M]>) => Promise<R>;

/** Any JSON the editor decodes; `IProperty` closes over neither nesting nor an unknown leaf. */
export interface PropertyDump {
    type?: string;
    isArray?: boolean;
    value: unknown;
}

/** Every field is a `{value}` wrapper, and the editor omits the ones it has nothing to say about. */
export interface NodeDump {
    __comps__?: unknown[];
    [field: string]: unknown;
}

export interface PropertyWriteOptions {
    uuid: string;
    path: string;
    dump: PropertyDump;
    record?: boolean;
}

export interface SceneScriptCall {
    name: string;
    method: string;
    args: unknown[];
}

/** What `scene:query-node-tree` actually answers; the message map types it as the dump-shaped INode. */
export interface SceneNodeTree {
    uuid: string;
    name?: string;
    type?: string;
    active?: boolean;
    children?: SceneNodeTree[];
}

/** `IBuildTaskOption` ships outside the public typings; the fields the bridge reads by name. */
export interface BuildTaskOptions {
    platform?: string;
    taskId?: string;
    taskName?: string;
    debug?: boolean;
    buildPath?: string;
    outputName?: string;
    packages?: Record<string, any>;
    [option: string]: any;
}

export interface BuildTask {
    id: string | number;
    state?: string;
    progress?: number;
    message?: string;
    detailMessage?: string;
    time?: string | number;
    options?: BuildTaskOptions;
    taskName?: string;
}

export interface BuildTasksInfo {
    list?: BuildTask[];
    free?: boolean;
}

export interface EditorSceneMethods {
    querySceneReady: Message<'scene', 'query-is-ready'>;
    queryDirty: Message<'scene', 'query-dirty'>;
    queryNodeTree: Answering<'scene', 'query-node-tree', SceneNodeTree | null>;
    /** The map declares `INode`; a uuid the scene does not hold answers `null`. */
    queryNode: Answering<'scene', 'query-node', NodeDump | null>;
    /** Both answer a bare uuid for one node and an array for several; the map declares one shape each. */
    createNode: Answering<'scene', 'create-node', string | string[]>;
    removeNode: Message<'scene', 'remove-node'>;
    duplicateNode: Answering<'scene', 'duplicate-node', string | string[]>;
    setParent: Message<'scene', 'set-parent'>;
    setProperty(options: PropertyWriteOptions): Promise<boolean>;
    resetProperty: Message<'scene', 'reset-property'>;
    resetNode: Message<'scene', 'reset-node'>;
    resetComponent: Message<'scene', 'reset-component'>;
    moveArrayElement: Message<'scene', 'move-array-element'>;
    removeArrayElement: Message<'scene', 'remove-array-element'>;
    queryClasses: Message<'scene', 'query-classes'>;
    queryComponents: Message<'scene', 'query-components'>;
    queryNodesByAssetUuid: Message<'scene', 'query-nodes-by-asset-uuid'>;
    createComponent: Message<'scene', 'create-component'>;
    removeComponent: Message<'scene', 'remove-component'>;
    executeComponentMethod: Message<'scene', 'execute-component-method'>;
    copyNode: Message<'scene', 'copy-node'>;
    cutNode: Message<'scene', 'cut-node'>;
    pasteNode: Message<'scene', 'paste-node'>;
    openScene: Message<'scene', 'open-scene'>;
    queryCurrentScene: Message<'scene', 'query-current-scene'>;
    softReload: Message<'scene', 'soft-reload'>;
    saveScene: Message<'scene', 'save-scene'>;
    closeScene: Message<'scene', 'close-scene'>;
    /** Positional per the editor's own example, against a map that declares one options object. */
    restorePrefab(nodeUuid: string, assetUuid: string): Promise<boolean>;
    executeSceneScript: Answering<'scene', 'execute-scene-script', unknown>;
    /** The three recording messages are undeclared: the map answers for them off its index signature. */
    beginRecording(uuid: string): Promise<string>;
    endRecording(undoId: string): Promise<void>;
    cancelRecording(undoId: string): Promise<void>;
}

export interface EditorAssetDbMethods {
    queryAssetInfo: Message<'asset-db', 'query-asset-info'>;
    queryUuid: Message<'asset-db', 'query-uuid'>;
    queryPath: Message<'asset-db', 'query-path'>;
    queryUrl: Message<'asset-db', 'query-url'>;
    queryAssetMeta: Answering<'asset-db', 'query-asset-meta', Record<string, any> | null>;
    queryAssets: Message<'asset-db', 'query-assets'>;
    queryReady: Message<'asset-db', 'query-ready'>;
    createAsset: Message<'asset-db', 'create-asset'>;
    importAsset: Message<'asset-db', 'import-asset'>;
    copyAsset: Message<'asset-db', 'copy-asset'>;
    moveAsset: Message<'asset-db', 'move-asset'>;
    deleteAsset: Message<'asset-db', 'delete-asset'>;
    saveAsset: Message<'asset-db', 'save-asset'>;
    saveAssetMeta: Message<'asset-db', 'save-asset-meta'>;
    reimportAsset: Message<'asset-db', 'reimport-asset'>;
    refreshAsset: Message<'asset-db', 'refresh-asset'>;
    generateAvailableUrl: Message<'asset-db', 'generate-available-url'>;
}

export interface EditorBuilderMethods {
    queryWorkerReady: Message<'builder', 'query-worker-ready'>;
    /** `builder:open` takes the panel name; this bridge only ever opens the default one. */
    openPanel(): Promise<void>;
    /**
     * `add-task` stores the options it is given onto the task it names, and its second
     * argument makes the editor resolve only once the build has finished.
     */
    addTask(options: BuildTaskOptions, waitForFinish: boolean): Promise<unknown>;
    /** `query-tasks-info` takes a filter; build tasks are the only ones this bridge asks about. */
    queryTasksInfo(): Promise<BuildTasksInfo | null>;
    queryTask(taskId: string): Promise<BuildTask | null>;
    checkAndCompleteOptions(options: BuildTaskOptions): Promise<BuildTaskOptions | null>;
}

export interface EditorProjectMethods {
    queryConfig: Message<'project', 'query-config'>;
    /** Not a message: the Build panel's own per-platform profile, read straight off Editor. */
    profile(platform: string, key: string): Promise<any>;
}

/**
 * The `editor.*` half of the driver surface — the symmetric partner to `SceneMethods`. Two adapters
 * satisfy it: the driver's `EditorApi` over `Editor.Message`, and the CLI's facade over JSON-RPC.
 */
export interface EditorMethods {
    scene: EditorSceneMethods;
    assetDb: EditorAssetDbMethods;
    builder: EditorBuilderMethods;
    project: EditorProjectMethods;
}

export type EditorMethodName = {
    [G in keyof EditorMethods]: `${G & string}.${keyof EditorMethods[G] & string}`
}[keyof EditorMethods];
