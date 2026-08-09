import type {
    AssetInfo as EditorAssetInfo,
    AssetOperationOption,
} from '@cocos/creator-types/editor/packages/asset-db/@types/public';

export type { EditorAssetInfo, AssetOperationOption };

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
            this.request('scene', 'query-is-ready'),

        queryDirty: (): Promise<boolean> =>
            this.request('scene', 'query-dirty'),

        openScene: (uuid: string): Promise<void> =>
            this.request('scene', 'open-scene', uuid),

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
