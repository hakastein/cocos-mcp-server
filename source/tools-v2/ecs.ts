import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { booleanArg, defineTool } from '../tool';
import { ok, fail } from '../result';
import { textOf } from './shared';
import { runCensus } from '../ecs-census';
import type { CensusSource, KeyReport } from '../ecs-census';
import type { ToolContext } from '../context';
import type { RegisteredTool } from '../tool';

const DEFAULT_ROOT = 'db://assets';
const DEFAULT_MAX_FILES = 1500;

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

function stripSites(report: KeyReport): KeyReport {
    return { ...report, readers: [], writers: [], adders: [], removers: [] };
}

function relativeTo(root: string, file: string): string {
    return path.relative(root, file).split(path.sep).join('/');
}

async function resolveRoot(ctx: ToolContext, root: string): Promise<string> {
    if (!root.startsWith('db://')) {
        const resolved = path.resolve(root);
        if (!fs.existsSync(resolved)) throw new Error(`Directory not found: ${resolved}`);
        return resolved;
    }
    let queried: string | null = null;
    try {
        queried = await ctx.editor.assetDb.queryPath(root);
    } catch {
        // asset-db declines a directory url in some editor builds; the project layout still answers
    }
    const raw = queried
        ? (queried.startsWith('file://') ? queried.slice('file://'.length) : queried)
        : path.join(Editor.Project.path, root.slice('db://'.length));
    const resolved = path.resolve(decodeURIComponent(raw));
    if (!fs.existsSync(resolved)) {
        throw new Error(`Could not resolve an on-disk directory for ${root} (tried ${resolved})`);
    }
    return resolved;
}

export const ecsComponentCensus = defineTool({
    name: 'ecs_component_census',
    description: 'Per-component-key read/write/add/remove census over the project\'s TypeScript, '
        + 'built from real syntax trees (the TypeScript parser, not text matching). Keys come from every '
        + '`declare module` augmentation of `interface Entity`. Flags keys that are read but never written '
        + 'or added (a system whose query is empty forever), keys written but never read, and keys declared '
        + 'and never touched. Reports its own blind spots in `limits` and `unresolved` rather than guessing.',
    schema: z.object({
        root: z.string().optional().describe('Directory to scan: a db:// url (e.g. '
            + `db://assets/shared/scripts) or an absolute path. Default: ${DEFAULT_ROOT}`),
        key: z.string().optional().describe('Report this component key only. Omit for the whole kit.'),
        includeSites: booleanArg.optional()
            .describe('Include every file:line site per key. Default true; false returns counts only.'),
        maxFiles: z.coerce.number().min(1).optional().describe('Cap on .ts files read. Default '
            + `${DEFAULT_MAX_FILES}. When hit, the payload says so via truncated/filesSkipped.`)
    }),
    aliases: { dir: 'root', scriptsRoot: 'root', assetPath: 'root' },
    async handler(args, ctx) {
        let root: string;
        try {
            root = await resolveRoot(ctx, args.root || DEFAULT_ROOT);
        } catch (error) {
            return fail('root_not_found', textOf(error),
                'Pass a db:// url inside the open project, or an absolute directory path.');
        }

        const maxFiles = Math.floor(args.maxFiles ?? DEFAULT_MAX_FILES);
        const includeSites = args.includeSites !== false;

        let files: string[];
        try {
            files = collectTypeScriptFiles(root, maxFiles + 1);
        } catch (error) {
            return fail('root_unreadable', `Could not walk ${root}: ${textOf(error)}`);
        }
        const truncated = files.length > maxFiles;
        const kept = truncated ? files.slice(0, maxFiles) : files;

        const sources: CensusSource[] = [];
        const unreadableFiles: Array<{ file: string; message: string }> = [];
        for (const file of kept) {
            try {
                sources.push({ path: relativeTo(root, file), text: fs.readFileSync(file, 'utf8') });
            } catch (error) {
                unreadableFiles.push({ file: relativeTo(root, file), message: textOf(error) });
            }
        }

        const census = runCensus(sources, {
            keyFilter: args.key || undefined,
            filesSkipped: (truncated ? files.length - maxFiles : 0) + unreadableFiles.length,
            truncated
        });

        return ok({
            root,
            ...census,
            keys: includeSites ? census.keys : census.keys.map(stripSites),
            readWithoutWriter: includeSites ? census.readWithoutWriter : census.readWithoutWriter.map(stripSites),
            writtenNeverRead: includeSites ? census.writtenNeverRead : census.writtenNeverRead.map(stripSites),
            unreadableFiles,
            ...(truncated
                ? { warning: `Scanned ${maxFiles} of ${files.length} files — raise maxFiles for a complete census.` }
                : {})
        }, `${census.keysDeclared} keys across ${census.filesAnalysed} files; `
            + `${census.readWithoutWriter.length} read without a writer, `
            + `${census.writtenNeverRead.length} written but never read, `
            + `${census.declaredNeverUsed.length} declared and never touched.`);
    }
});

export const ecsTools: RegisteredTool[] = [ecsComponentCensus];
