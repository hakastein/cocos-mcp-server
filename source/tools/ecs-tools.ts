import * as fs from 'fs';
import * as path from 'path';
import { ToolDefinition, ToolResponse, ToolExecutor } from '../types';
import { runCensus, CensusSource, KeyReport } from '../ecs-census';

/**
 * The kit's ECS ledger. `component_census` reads the project's TypeScript and answers, per
 * component key, who reads it, who writes it, who adds it and who removes it — and flags the keys
 * that have readers and no writer, which is a feature that silently never runs and which no unit
 * test can fail on.
 */
export class EcsTools implements ToolExecutor {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'component_census',
                description: 'Per-component-key read/write/add/remove census over the project\'s TypeScript, ' +
                    'built from real syntax trees (the TypeScript parser, not text matching). Keys come from every ' +
                    '`declare module` augmentation of `interface Entity`. Flags keys that are read but never written ' +
                    'or added (a system whose query is empty forever), keys written but never read, and keys declared ' +
                    'and never touched. Reports its own blind spots in `limits` and `unresolved` rather than guessing.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        root: {
                            type: 'string',
                            description: 'Directory to scan: a db:// url (e.g. db://assets/shared/scripts) or an absolute path. Default: db://assets',
                            'x-aliases': ['dir', 'scriptsRoot', 'assetPath']
                        },
                        key: {
                            type: 'string',
                            description: 'Report this component key only. Omit for the whole kit.'
                        },
                        includeSites: {
                            type: 'boolean',
                            description: 'Include every file:line site per key. Default true; false returns counts only.'
                        },
                        maxFiles: {
                            type: 'number',
                            description: 'Cap on .ts files read. Default 1500. When hit, the payload says so via truncated/filesSkipped.'
                        }
                    },
                    required: []
                }
            }
        ];
    }

    async execute(toolName: string, args: any): Promise<ToolResponse> {
        switch (toolName) {
            case 'component_census':
                return await this.componentCensus(args || {});
            default:
                throw new Error(`Unknown tool: ${toolName}`);
        }
    }

    private async componentCensus(args: any): Promise<ToolResponse> {
        try {
            const root = await this.resolveRoot(args.root || 'db://assets');
            const maxFiles = Number.isFinite(Number(args.maxFiles)) ? Math.max(1, Math.floor(Number(args.maxFiles))) : 1500;
            const includeSites = args.includeSites !== false;

            const files = collectTypeScriptFiles(root, maxFiles + 1);
            const truncated = files.length > maxFiles;
            const kept = truncated ? files.slice(0, maxFiles) : files;

            const sources: CensusSource[] = [];
            const unreadable: { file: string; message: string }[] = [];
            for (const file of kept) {
                try {
                    sources.push({ path: relativeTo(root, file), text: fs.readFileSync(file, 'utf8') });
                } catch (err: any) {
                    unreadable.push({ file: relativeTo(root, file), message: err?.message || String(err) });
                }
            }

            const census = runCensus(sources, {
                keyFilter: typeof args.key === 'string' && args.key ? args.key : undefined,
                filesSkipped: (truncated ? files.length - maxFiles : 0) + unreadable.length,
                truncated,
            });

            const data: any = {
                root,
                ...census,
                keys: includeSites ? census.keys : census.keys.map(stripSites),
                readWithoutWriter: includeSites ? census.readWithoutWriter : census.readWithoutWriter.map(stripSites),
                writtenNeverRead: includeSites ? census.writtenNeverRead : census.writtenNeverRead.map(stripSites),
                unreadableFiles: unreadable,
            };

            const flagged = census.readWithoutWriter.length;
            return {
                success: true,
                data,
                message: `${census.keysDeclared} keys across ${census.filesAnalysed} files; ` +
                    `${flagged} read without a writer, ${census.writtenNeverRead.length} written but never read, ` +
                    `${census.declaredNeverUsed.length} declared and never touched.`,
                ...(truncated ? { warning: `Scanned ${maxFiles} of ${files.length} files — raise maxFiles for a complete census.` } : {})
            };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    }

    /** A db:// url resolves through the asset database; anything else is taken as an on-disk path. */
    private async resolveRoot(root: string): Promise<string> {
        if (!root.startsWith('db://')) {
            const resolved = path.resolve(root);
            if (!fs.existsSync(resolved)) throw new Error(`Directory not found: ${resolved}`);
            return resolved;
        }
        let queried: string | null = null;
        try {
            queried = await Editor.Message.request('asset-db', 'query-path', root);
        } catch {
            // asset-db declines a directory url in some editor builds; the project layout still answers
        }
        const raw = queried
            ? (queried.startsWith('file://') ? queried.slice('file://'.length) : queried)
            : path.join(Editor.Project.path, root.slice('db://'.length));
        const resolved = path.resolve(decodeURIComponent(raw));
        if (!fs.existsSync(resolved)) throw new Error(`Could not resolve an on-disk directory for ${root} (tried ${resolved})`);
        return resolved;
    }
}

function stripSites(report: KeyReport): KeyReport {
    return { ...report, readers: [], writers: [], adders: [], removers: [] };
}

function relativeTo(root: string, file: string): string {
    return path.relative(root, file).split(path.sep).join('/');
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'library', 'temp', 'build', 'dist', '.git']);

export function collectTypeScriptFiles(root: string, limit: number): string[] {
    const found: string[] = [];
    const walk = (directory: string): void => {
        if (found.length >= limit) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (found.length >= limit) return;
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
                walk(full);
            } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
                found.push(full);
            }
        }
    };
    walk(root);
    return found;
}
