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

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function legacyFailure(record: Record<string, unknown>): ToolResult {
    const error = textOf(record.error);
    const message = textOf(record.message);
    const spelled = [error, message === error ? undefined : message].filter(Boolean).join(' — ');
    return fail('legacy', spelled || 'the tool reported a failure without naming it',
        textOf(record.instruction));
}

function legacySuccess(record: Record<string, unknown>): ToolResult {
    const { success, message, ...rest } = record;
    const { data, ...siblings } = rest;
    const siblingCount = Object.keys(siblings).length;
    const payload = isPlainObject(data) && siblingCount
        ? { ...data, ...siblings }
        : (siblingCount === 0 && 'data' in rest ? data : rest);
    return typeof message === 'string' ? ok(payload, message) : ok(payload);
}

function toToolResult(raw: unknown): ToolResult {
    if (!isPlainObject(raw)) return ok(raw);
    if (raw.success === false) return legacyFailure(raw);
    if (raw.success !== true) return ok(raw);
    return legacySuccess(raw);
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
