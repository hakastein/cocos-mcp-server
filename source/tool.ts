import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { fail, ToolResult } from './result';
import type { ToolContext } from './context';

export interface RegisteredTool {
    name: string;
    description: string;
    inputSchema: object;
    invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolDefinition<S extends z.ZodRawShape> {
    name: string;
    description: string;
    schema: z.ZodObject<S>;
    aliases?: Record<string, string>;
    handler(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolResult>;
}

function isMissing(value: unknown): boolean {
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function applyAliases(
    args: Record<string, unknown>,
    aliases: Record<string, string> | undefined
): Record<string, unknown> {
    if (!aliases) return args;
    const out = { ...args };
    for (const [alias, canonical] of Object.entries(aliases)) {
        if (!(alias in out)) continue;
        if (isMissing(out[canonical])) out[canonical] = out[alias];
        delete out[alias];
    }
    return out;
}

/** Called with its own signature from a function generic over the shape, tsc reports TS2589. */
const toJsonSchema = zodToJsonSchema as unknown as
    (schema: z.ZodTypeAny, options?: { $refStrategy?: string }) => object;

function jsonSchemaOf(schema: z.ZodTypeAny): object {
    return toJsonSchema(schema, { $refStrategy: 'none' });
}

function describeIssues(error: z.ZodError): string {
    return error.issues
        .map(issue => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
        .join('; ');
}

export function defineTool<S extends z.ZodRawShape>(def: ToolDefinition<S>): RegisteredTool {
    return {
        name: def.name,
        description: def.description,
        inputSchema: jsonSchemaOf(def.schema as unknown as z.ZodTypeAny),
        async invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
            const parsed = def.schema.safeParse(applyAliases(args, def.aliases));
            if (!parsed.success) {
                return fail('invalid_args', `${def.name}: ${describeIssues(parsed.error)}`);
            }
            return def.handler(parsed.data, ctx);
        }
    };
}
