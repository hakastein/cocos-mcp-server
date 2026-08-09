import type {
    AssetInfo,
    AssetOperationOption,
} from '@cocos/creator-types/editor/packages/asset-db/@types/public';

export type { AssetInfo, AssetOperationOption };

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

export class EditorApi {
    readonly scene = {
        querySceneReady: (): Promise<boolean> =>
            this.request<boolean>('scene', 'query-is-ready'),

        queryDirty: (): Promise<boolean> =>
            this.request<boolean>('scene', 'query-dirty'),

        openScene: (uuid: string): Promise<void> =>
            this.request<void>('scene', 'open-scene', uuid),

        saveScene: (): Promise<string | undefined> =>
            this.request<string | undefined>('scene', 'save-scene'),

        closeScene: (): Promise<boolean> =>
            this.request<boolean>('scene', 'close-scene'),

        executeSceneScript: (payload: SceneScriptCall): Promise<unknown> =>
            this.request<unknown>('scene', 'execute-scene-script', payload),

        beginRecording: (uuids: string | string[]): Promise<string> =>
            this.request<string>('scene', 'begin-recording', uuids),

        endRecording: (undoId: string): Promise<void> =>
            this.request<void>('scene', 'end-recording', undoId),

        cancelRecording: (undoId: string): Promise<void> =>
            this.request<void>('scene', 'cancel-recording', undoId),
    };

    readonly assetDb = {
        queryAssetInfo: (uuidOrUrl: string): Promise<AssetInfo | null> =>
            this.request<AssetInfo | null>('asset-db', 'query-asset-info', uuidOrUrl),

        queryUuid: (url: string): Promise<string | null> =>
            this.request<string | null>('asset-db', 'query-uuid', url),

        queryPath: (uuidOrUrl: string): Promise<string | null> =>
            this.request<string | null>('asset-db', 'query-path', uuidOrUrl),

        queryAssets: (pattern: string): Promise<AssetInfo[]> =>
            this.request<AssetInfo[]>('asset-db', 'query-assets', { pattern }),

        createAsset: (url: string, content: string | null, opts?: AssetOperationOption): Promise<AssetInfo | null> =>
            opts === undefined
                ? this.request<AssetInfo | null>('asset-db', 'create-asset', url, content)
                : this.request<AssetInfo | null>('asset-db', 'create-asset', url, content, opts),

        refreshAsset: (url: string): Promise<void> =>
            this.request<void>('asset-db', 'refresh-asset', url),
    };

    private async request<T>(pkg: string, msg: string, ...args: unknown[]): Promise<T> {
        try {
            return await Editor.Message.request(pkg, msg, ...args);
        } catch (cause) {
            throw new EditorRequestError(pkg, msg, cause);
        }
    }
}
