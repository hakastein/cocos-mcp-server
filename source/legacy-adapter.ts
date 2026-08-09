import { ok, fail, ToolResult } from './result';
import { normalizeToolArgs } from './tool-args';
import { augmentToolDefinition } from './node-path';
import type { RegisteredTool } from './tool';
import type { ToolContext } from './context';

export interface LegacyToolDefinition {
    name: string;
    description: string;
    inputSchema: object;
}

export interface LegacyExecutor {
    getTools(): LegacyToolDefinition[];
    execute(name: string, args: unknown): Promise<unknown>;
}

function textOf(value: unknown): string | undefined {
    if (typeof value === 'string') return value.trim() ? value : undefined;
    if (value === undefined || value === null) return undefined;
    return JSON.stringify(value);
}

function toToolResult(raw: unknown): ToolResult {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ok(raw);

    const record = raw as Record<string, unknown>;
    if (record.success === false) {
        return fail('legacy', textOf(record.error) ?? textOf(record.message)
            ?? 'the tool reported a failure without naming it');
    }
    if (record.success !== true) return ok(raw);

    const { success, message, ...rest } = record;
    const keys = Object.keys(rest);
    const data = keys.length === 1 && keys[0] === 'data' ? rest.data : rest;
    return typeof message === 'string' ? ok(data, message) : ok(data);
}

export function legacyTools(category: string, executor: LegacyExecutor): RegisteredTool[] {
    return executor.getTools().map(def => {
        const name = `${category}_${def.name}`;
        const augmented = augmentToolDefinition(def);
        return {
            name,
            description: augmented.description,
            inputSchema: augmented.inputSchema,
            async invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
                const normalized = normalizeToolArgs(name, augmented.inputSchema, args);
                if (!normalized.ok) return fail('invalid_args', normalized.error);
                if (normalized.renamed.length && ctx.settings.enableDebugLog) {
                    const pairs = normalized.renamed.map(r => `${r.from} -> ${r.to}`).join(', ');
                    console.log(`[ToolRegistry] ${name}: accepted alias argument(s) ${pairs}`);
                }
                try {
                    return toToolResult(await executor.execute(def.name, normalized.args));
                } catch (error) {
                    return fail('legacy_throw', error instanceof Error ? error.message : String(error));
                }
            }
        };
    });
}
