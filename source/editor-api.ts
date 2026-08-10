import type {
    AssetInfo as EditorAssetInfo,
    AssetOperationOption,
} from '@cocos/creator-types/editor/packages/asset-db/@types/public';
import type {
    CreateComponentOptions,
    CreateNodeOptions,
    CutNodeOptions,
    ExecuteComponentMethodOptions,
    INode,
    PasteNodeOptions,
    RemoveComponentOptions,
    RemoveNodeOptions,
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

        softReload: (): Promise<void> =>
            this.request('scene', 'soft-reload'),

        saveScene: (): Promise<string | undefined> =>
            this.request('scene', 'save-scene'),

        closeScene: (): Promise<boolean> =>
            this.request('scene', 'close-scene'),

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

        queryAssets: (pattern: string): Promise<EditorAssetInfo[]> =>
            this.request('asset-db', 'query-assets', { pattern }),

        createAsset: (url: string, content: string | null, opts?: AssetOperationOption): Promise<EditorAssetInfo | null> =>
            opts === undefined
                ? this.request('asset-db', 'create-asset', url, content)
                : this.request('asset-db', 'create-asset', url, content, opts),

        refreshAsset: (url: string): Promise<void> =>
            this.request('asset-db', 'refresh-asset', url),
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
