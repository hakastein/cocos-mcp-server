import type { EditorApi } from './editor-api';
import type { SceneMethods } from '@cocos-cli/shared/dist/scene-contract';

export const SCENE_SCRIPT_NAME = 'cocos-mcp-server';

export class SceneScriptClient {
    constructor(private readonly editor: EditorApi) {}

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
