import { fail, ToolResult } from './result';
import { augmentToolDefinition, applyResolvedPaths, requestedPaths, PathResolution } from './node-path';
import type { RegisteredTool } from './tool';
import type { ToolContext } from './context';

export interface AdvertisedTool {
    name: string;
    description: string;
    inputSchema: object;
}

interface RegistryEntry {
    tool: RegisteredTool;
    definition: AdvertisedTool;
}

function textOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class ToolRegistry {
    private readonly entries = new Map<string, RegistryEntry>();

    constructor(tools: RegisteredTool[]) {
        for (const tool of tools) {
            if (this.entries.has(tool.name)) {
                throw new Error(`ToolRegistry: duplicate tool name '${tool.name}'`);
            }
            this.entries.set(tool.name, {
                tool,
                definition: augmentToolDefinition({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema
                })
            });
        }
    }

    list(): AdvertisedTool[] {
        return Array.from(this.entries.values(), entry => entry.definition);
    }

    async invoke(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const entry = this.entries.get(name);
        if (!entry) {
            return fail('unknown_tool', `unknown tool '${name}'`,
                `Known tools: ${Array.from(this.entries.keys()).join(', ')}`);
        }

        const schema = entry.definition.inputSchema;
        const given: Record<string, any> = (args && typeof args === 'object' && !Array.isArray(args))
            ? { ...args }
            : {};

        const paths = requestedPaths(schema, given);
        let resolutions: Record<string, PathResolution> = {};
        if (paths.length) {
            const lookup = await this.resolveScenePaths(ctx, paths);
            if (!lookup.ok) return fail('node_path', `${name}: ${lookup.error}`);
            resolutions = lookup.resolutions;
        }

        const applied = applyResolvedPaths(name, schema, given, resolutions);
        if (!applied.ok) return fail('node_path', applied.error);
        if (applied.resolved.length && ctx.settings.enableDebugLog) {
            const spelled = applied.resolved
                .map(r => `${r.parameter}='${r.path}' -> ${r.uuid} (${r.matchedPath})`).join(', ');
            console.log(`[ToolRegistry] ${name}: resolved ${spelled}`);
        }

        return entry.tool.invoke(applied.args, ctx);
    }

    private async resolveScenePaths(ctx: ToolContext, paths: string[]): Promise<
        { ok: true; resolutions: Record<string, PathResolution> } | { ok: false; error: string }
    > {
        let result;
        try {
            result = await ctx.sceneScript.call('resolveNodePaths', paths);
        } catch (error) {
            return {
                ok: false,
                error: `could not resolve node path(s) — the scene script did not answer: ${textOf(error)}`
            };
        }
        if (!result || result.success !== true || !result.data) {
            const reason = (result && result.success === false && result.error) || 'no scene is open';
            return { ok: false, error: `could not resolve node path(s): ${reason}` };
        }
        return { ok: true, resolutions: result.data.resolutions || {} };
    }
}
