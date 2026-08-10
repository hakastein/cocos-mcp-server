import { ok, fail, ToolResult } from '../result';
import { ANY_VALUE_TYPE } from '../json-arg';
import type { RegisteredTool } from '../tool';
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

export function anyValued(tool: RegisteredTool, parameter: string): RegisteredTool {
    const declared = (tool.inputSchema as any)?.properties?.[parameter];
    if (declared) declared.type = ANY_VALUE_TYPE;
    return tool;
}
