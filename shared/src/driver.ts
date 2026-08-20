import type { EditorMethods } from './editor-contract';
import type { SceneMethods } from './scene-contract';

export interface SceneFacade {
    call<K extends keyof SceneMethods>(
        method: K, ...args: Parameters<SceneMethods[K]>
    ): Promise<Awaited<ReturnType<SceneMethods[K]>>>;
}

export interface Driver {
    readonly editor: EditorMethods;
    readonly scene: SceneFacade;
}
