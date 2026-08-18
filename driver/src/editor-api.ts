import type {
    AssetInfo as EditorAssetInfo,
    AssetOperationOption,
    QueryAssetsOption,
} from '@cocos/creator-types/editor/packages/asset-db/@types/public';
import type {
    CreateComponentOptions,
    CreateNodeOptions,
    CutNodeOptions,
    ExecuteComponentMethodOptions,
    INode,
    MoveArrayOptions,
    PasteNodeOptions,
    QueryClassesOptions,
    RemoveArrayOptions,
    RemoveComponentOptions,
    RemoveNodeOptions,
    ResetComponentOptions,
    ResetNodeOptions,
    SetPropertyOptions,
} from '@cocos/creator-types/editor/packages/scene/@types/public';

export type { EditorAssetInfo, AssetOperationOption, INode };

export interface SceneScriptCall {
    name: string;
    method: string;
    args: unknown[];
}

export class EditorRequestError extends Error {
    readonly pkg: string;
    readonly msg: string;
    readonly cause: unknown;

    constructor(pkg: string, msg: string, cause: unknown) {
        super(`${pkg}:${msg} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.name = 'EditorRequestError';
        this.pkg = pkg;
        this.msg = msg;
        this.cause = cause;
    }
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

export class EditorApi {
    readonly scene = {
        querySceneReady: (): Promise<boolean> =>
            this.request('scene', 'query-is-ready'),

        queryDirty: (): Promise<boolean> =>
            this.request('scene', 'query-dirty'),

        queryNodeTree: (): Promise<SceneNodeTree | null> =>
            this.request('scene', 'query-node-tree') as unknown as Promise<SceneNodeTree | null>,

        queryNode: (uuid: string): Promise<INode | null> =>
            this.request('scene', 'query-node', uuid) as unknown as Promise<INode | null>,

        createNode: (options: CreateNodeOptions): Promise<string | string[]> =>
            this.request('scene', 'create-node', options) as unknown as Promise<string | string[]>,

        removeNode: (options: RemoveNodeOptions): Promise<void> =>
            this.request('scene', 'remove-node', options),

        duplicateNode: (uuids: string | string[]): Promise<string | string[]> =>
            this.request('scene', 'duplicate-node', uuids) as unknown as Promise<string | string[]>,

        setParent: (options: CutNodeOptions): Promise<string[]> =>
            this.request('scene', 'set-parent', options),

        setProperty: (options: SetPropertyOptions): Promise<boolean> =>
            this.request('scene', 'set-property', options),

        resetProperty: (options: SetPropertyOptions): Promise<boolean> =>
            this.request('scene', 'reset-property', options),

        resetNode: (options: ResetNodeOptions): Promise<boolean> =>
            this.request('scene', 'reset-node', options),

        resetComponent: (options: ResetComponentOptions): Promise<void> =>
            this.request('scene', 'reset-component', options),

        moveArrayElement: (options: MoveArrayOptions): Promise<boolean> =>
            this.request('scene', 'move-array-element', options),

        removeArrayElement: (options: RemoveArrayOptions): Promise<boolean> =>
            this.request('scene', 'remove-array-element', options),

        queryClasses: (options: QueryClassesOptions): Promise<Array<{ name: string }>> =>
            this.request('scene', 'query-classes', options),

        queryComponents: (): Promise<Array<{ name: string; cid: string; path: string; assetUuid: string }>> =>
            this.request('scene', 'query-components'),

        queryNodesByAssetUuid: (assetUuid: string): Promise<string[]> =>
            this.request('scene', 'query-nodes-by-asset-uuid', assetUuid),

        createComponent: (options: CreateComponentOptions): Promise<void> =>
            this.request('scene', 'create-component', options),

        removeComponent: (options: RemoveComponentOptions): Promise<void> =>
            this.request('scene', 'remove-component', options),

        executeComponentMethod: (options: ExecuteComponentMethodOptions): Promise<unknown> =>
            this.request('scene', 'execute-component-method', options),

        copyNode: (uuids: string | string[]): Promise<string[]> =>
            this.request('scene', 'copy-node', uuids),

        cutNode: (uuids: string | string[]): Promise<void> =>
            this.request('scene', 'cut-node', uuids),

        pasteNode: (options: PasteNodeOptions): Promise<string[]> =>
            this.request('scene', 'paste-node', options),

        openScene: (uuid: string): Promise<void> =>
            this.request('scene', 'open-scene', uuid),

        queryCurrentScene: (): Promise<string | null> =>
            this.request('scene', 'query-current-scene'),

        softReload: (): Promise<void> =>
            this.request('scene', 'soft-reload'),

        saveScene: (): Promise<string | undefined> =>
            this.request('scene', 'save-scene'),

        closeScene: (): Promise<boolean> =>
            this.request('scene', 'close-scene'),

        /** Positional per the editor's own example; the cast is because its type map says otherwise. */
        restorePrefab: (nodeUuid: string, assetUuid: string): Promise<boolean> =>
            (this.request as any)('scene', 'restore-prefab', nodeUuid, assetUuid),

        executeSceneScript: (payload: SceneScriptCall): Promise<unknown> =>
            this.request('scene', 'execute-scene-script', payload),

        beginRecording: (uuid: string): Promise<string> =>
            this.request('scene', 'begin-recording', uuid),

        endRecording: (undoId: string): Promise<void> =>
            this.request('scene', 'end-recording', undoId),

        cancelRecording: (undoId: string): Promise<void> =>
            this.request('scene', 'cancel-recording', undoId),
    };

    readonly assetDb = {
        queryAssetInfo: (uuidOrUrl: string): Promise<EditorAssetInfo | null> =>
            this.request('asset-db', 'query-asset-info', uuidOrUrl),

        queryUuid: (url: string): Promise<string | null> =>
            this.request('asset-db', 'query-uuid', url),

        queryPath: (uuidOrUrl: string): Promise<string | null> =>
            this.request('asset-db', 'query-path', uuidOrUrl),

        queryUrl: (uuid: string): Promise<string | null> =>
            this.request('asset-db', 'query-url', uuid),

        queryAssetMeta: (uuidOrUrl: string): Promise<Record<string, any> | null> =>
            this.request('asset-db', 'query-asset-meta', uuidOrUrl) as unknown as
                Promise<Record<string, any> | null>,

        queryAssets: (query: QueryAssetsOption): Promise<EditorAssetInfo[]> =>
            this.request('asset-db', 'query-assets', query),

        queryReady: (): Promise<boolean> =>
            this.request('asset-db', 'query-ready'),

        createAsset: (url: string, content: string | null, opts?: AssetOperationOption): Promise<EditorAssetInfo | null> =>
            opts === undefined
                ? this.request('asset-db', 'create-asset', url, content)
                : this.request('asset-db', 'create-asset', url, content, opts),

        importAsset: (sourcePath: string, url: string, opts?: AssetOperationOption): Promise<EditorAssetInfo | null> =>
            opts === undefined
                ? this.request('asset-db', 'import-asset', sourcePath, url)
                : this.request('asset-db', 'import-asset', sourcePath, url, opts),

        copyAsset: (source: string, target: string, opts?: AssetOperationOption): Promise<EditorAssetInfo | null> =>
            opts === undefined
                ? this.request('asset-db', 'copy-asset', source, target)
                : this.request('asset-db', 'copy-asset', source, target, opts),

        moveAsset: (source: string, target: string, opts?: AssetOperationOption): Promise<EditorAssetInfo | null> =>
            opts === undefined
                ? this.request('asset-db', 'move-asset', source, target)
                : this.request('asset-db', 'move-asset', source, target, opts),

        deleteAsset: (url: string): Promise<EditorAssetInfo | null> =>
            this.request('asset-db', 'delete-asset', url),

        saveAsset: (url: string, content: string): Promise<EditorAssetInfo | null> =>
            this.request('asset-db', 'save-asset', url, content),

        saveAssetMeta: (urlOrUuid: string, content: string): Promise<EditorAssetInfo | null> =>
            this.request('asset-db', 'save-asset-meta', urlOrUuid, content),

        reimportAsset: (url: string): Promise<void> =>
            this.request('asset-db', 'reimport-asset', url),

        refreshAsset: (url: string): Promise<void> =>
            this.request('asset-db', 'refresh-asset', url),

        generateAvailableUrl: (url: string): Promise<string> =>
            this.request('asset-db', 'generate-available-url', url),
    };

    readonly builder = {
        queryWorkerReady: (): Promise<boolean> =>
            this.request('builder', 'query-worker-ready'),

        openPanel: (): Promise<void> =>
            this.request('builder', 'open', 'default'),

        /**
         * `add-task` stores the options it is given onto the task it names, and its second
         * argument makes the editor resolve only once the build has finished.
         */
        addTask: (options: BuildTaskOptions, waitForFinish: boolean): Promise<unknown> =>
            this.request('builder', 'add-task', options, waitForFinish),

        queryTasksInfo: (): Promise<BuildTasksInfo | null> =>
            this.request('builder', 'query-tasks-info', { type: 'build' }),

        queryTask: (taskId: string): Promise<BuildTask | null> =>
            this.request('builder', 'query-task', String(taskId)),

        checkAndCompleteOptions: (options: BuildTaskOptions): Promise<BuildTaskOptions | null> =>
            this.request('builder', 'check-and-complete-options', options),
    };

    readonly project = {
        queryConfig: (name: string): Promise<unknown> =>
            this.request('project', 'query-config', name),

        /** Not a message: the Build panel's own per-platform profile, read straight off Editor. */
        profile: (platform: string, key: string): Promise<any> =>
            Editor.Profile.getProject(platform, key),
    };

    private async request<
        J extends keyof EditorMessageMaps & string,
        K extends keyof EditorMessageMaps[J] & string,
    >(pkg: J, msg: K, ...args: EditorMessageMaps[J][K]['params']): Promise<EditorMessageMaps[J][K]['result']> {
        try {
            return await Editor.Message.request(pkg, msg, ...args);
        } catch (cause) {
            throw new EditorRequestError(pkg, msg, cause);
        }
    }
}
