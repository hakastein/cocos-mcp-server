import { ok, fail, ToolResult } from '../result';
import type { SceneAckResult, SceneResult } from '../scene-contract';

export function textOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function fromScene<T>(result: SceneResult<T> | SceneAckResult): ToolResult<T | undefined> {
    if (!result || typeof result.success !== 'boolean') {
        return fail('scene_script', 'scene script did not answer; is the extension scene script loaded?');
    }
    if (!result.success) return fail('scene_script', result.error);
    return ok('data' in result ? result.data : undefined, result.message);
}
