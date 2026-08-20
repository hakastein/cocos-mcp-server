import type { EditorApi } from './editor-api.ts';
import type { SceneMethods } from '@cocos-cli/shared';

export const SCENE_SCRIPT_NAME = 'cocos-mcp-server';

export class SceneScriptClient {
    private readonly editor: EditorApi;

    constructor(editor: EditorApi) {
        this.editor = editor;
    }

    async call<K extends keyof SceneMethods>(
        method: K,
        ...args: Parameters<SceneMethods[K]>
    ): Promise<Awaited<ReturnType<SceneMethods[K]>>> {
        const result = await this.editor.scene.executeSceneScript({
            name: SCENE_SCRIPT_NAME,
            method: method as string,
            args
        });
        return result as Awaited<ReturnType<SceneMethods[K]>>;
    }
}
