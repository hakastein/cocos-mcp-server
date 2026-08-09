import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { fail, ToolResult } from './result';
import { ALIAS_KEY } from './tool-args';
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

function advertiseAliases(schema: object, aliases: Record<string, string> | undefined): object {
    const properties: Record<string, any> = (schema as any).properties;
    if (!aliases || !properties) return schema;
    for (const [alias, canonical] of Object.entries(aliases)) {
        const property = properties[canonical];
        if (!property) continue;
        property[ALIAS_KEY] = [...(property[ALIAS_KEY] || []), alias];
    }
    return schema;
}

function assertAliasesAreFree(name: string, declared: string[], aliases: Record<string, string> | undefined): void {
    if (!aliases) return;
    const shadowed = Object.keys(aliases).filter(alias => declared.includes(alias));
    if (!shadowed.length) return;
    throw new Error(
        `defineTool(${name}): alias ${shadowed.map(alias => `'${alias}'`).join(', ')} is also a declared `
        + 'parameter. An alias is deleted from the arguments once applied, so a caller passing both '
        + 'spellings would silently lose the declared one.'
    );
}

function describeIssues(error: z.ZodError): string {
    return error.issues
        .map(issue => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
        .join('; ');
}

/** `z.coerce.boolean()` is `Boolean(value)`, so a REST client's 'false' would arrive as true. */
export const booleanArg = z.preprocess(value => {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
}, z.boolean());

export function defineTool<S extends z.ZodRawShape>(def: ToolDefinition<S>): RegisteredTool {
    assertAliasesAreFree(def.name, Object.keys(def.schema.shape), def.aliases);
    return {
        name: def.name,
        description: def.description,
        inputSchema: advertiseAliases(jsonSchemaOf(def.schema as unknown as z.ZodTypeAny), def.aliases),
        async invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
            const parsed = def.schema.safeParse(applyAliases(args, def.aliases));
            if (!parsed.success) {
                return fail('invalid_args', `${def.name}: ${describeIssues(parsed.error)}`);
            }
            try {
                return await def.handler(parsed.data, ctx);
            } catch (error) {
                return fail('tool_throw', error instanceof Error ? error.message : String(error));
            }
        }
    };
}
