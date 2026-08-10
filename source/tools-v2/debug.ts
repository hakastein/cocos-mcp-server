import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { booleanArg, defineTool } from '../tool';
import { ok, fail } from '../result';
import { fromScene, textOf } from './shared';
import { searchLines } from '../log-search';
import { filterEntries, groupLogLines, maskOutsideEntries, parseSince } from '../project-log';
import type { ProjectLogEntry } from '../project-log';
import type { RegisteredTool } from '../tool';

const LEVELS = ['debug', 'log', 'info', 'warn', 'error'] as const;

const levelArg = z.preprocess(
    value => (typeof value === 'string' ? value.toLowerCase() : value),
    z.enum(LEVELS)
);

const DEFAULT_TAIL = 100;
const DEFAULT_MATCHES = 20;

interface LogFile {
    logFilePath: string;
    fileSize: number;
    lastModified: string;
    totalLines: number;
}

function logFileCandidates(): string[] {
    return [Editor.Project?.path, process.cwd()]
        .filter(Boolean)
        .map(base => path.join(base as string, 'temp', 'logs', 'project.log'));
}

function describeEntry(entry: ProjectLogEntry, includeDetail: boolean): Record<string, unknown> {
    const described: Record<string, unknown> = {
        lineNumber: entry.lineNumber,
        time: entry.time,
        level: entry.level,
        message: entry.message
    };
    if (entry.detail) {
        if (includeDetail) described.detail = entry.detail;
        else described.detailLines = entry.detail.length;
    }
    return described;
}

export const debugExecuteScript = defineTool({
    name: 'debug_execute_script',
    description: 'Execute JavaScript in scene context, with `cc`, `director` and `scene` in scope. '
        + 'The value is the last expression, as in a console — so `cc.director.getScene().name` returns the '
        + 'name. A top-level `return` and a top-level `await` also work: the script is re-run inside a '
        + 'function (or async function) wrapper when plain evaluation rejects them, and the response says '
        + 'which wrapper was used. No IIFE of your own is needed.',
    schema: z.object({
        script: z.string().describe('JavaScript code to execute')
    }),
    async handler(args, ctx) {
        try {
            return fromScene(await ctx.sceneScript.call('evalInScene', args.script));
        } catch (error) {
            return fail('scene_script', `The scene script did not answer: ${textOf(error)}`,
                'The scene must be open and loaded; check scene_query_ready.');
        }
    }
});

export const debugProjectLogs = defineTool({
    name: 'debug_project_logs',
    description: 'Read temp/logs/project.log — the EDITOR\'s own log (imports, compile errors, scene '
        + 'errors). It holds not one line from a running preview; that is debug_get_preview_logs. Without '
        + '`query` it returns the most recent entries; with one it searches and returns matching lines with '
        + 'surrounding context and the true total match count even when capped. An entry is a header line '
        + 'plus the stack frames under it, and severity is read off the header, so a frame is never mistaken '
        + 'for an error of its own. Every answer reports the file it read, its size and its mtime, so a log '
        + 'that stopped being written is distinguishable from one with nothing to show.',
    schema: z.object({
        query: z.string().optional().describe('Text to search for. Literal substring unless regex:true. '
            + 'Omit it to read the tail of the log instead of searching.'),
        level: levelArg.optional().describe('Minimum severity of the entry: debug < log < info < warn < '
            + 'error. "warn" keeps warnings and errors. Stack-trace lines inherit the severity of the entry '
            + 'they belong to.'),
        limit: z.coerce.number().min(1).max(1000).optional()
            .describe(`Maximum entries (default ${DEFAULT_TAIL}) or, when searching, matches (default ${DEFAULT_MATCHES}) to return`),
        since: z.string().optional().describe('Only entries logged after this point: a relative age like '
            + '"15m", "2h", "1d", an ISO date, or epoch ms. Without it the whole file is read, so a search '
            + 'for "error" returns matches that are days old.'),
        includeDetail: booleanArg.optional()
            .describe('Return each entry\'s stack frames instead of just how many there are (tail only)'),
        contextLines: z.coerce.number().min(0).max(10).optional()
            .describe('Number of context lines to show around each match (default 2, search only)'),
        regex: booleanArg.optional()
            .describe('Treat query as a regular expression instead of literal text (default false)'),
        caseSensitive: booleanArg.optional().describe('Match case exactly (default false)')
    }),
    aliases: {
        pattern: 'query', keyword: 'query', search: 'query', searchTerm: 'query', filterKeyword: 'query',
        contains: 'query',
        maxResults: 'limit', max: 'limit', lines: 'limit',
        minLevel: 'level', severity: 'level', logLevel: 'level', type: 'level',
        after: 'since', newerThan: 'since',
        context: 'contextLines'
    },
    async handler(args) {
        const candidates = logFileCandidates();
        const logFilePath = candidates.find(candidate => fs.existsSync(candidate));
        if (!logFilePath) {
            return fail('log_missing', `No project log at ${candidates.join(' or ')}.`,
                'The editor creates it on startup; a project that was never opened by this editor has none.',
                { searchedPaths: candidates });
        }

        let text: string;
        let stats: fs.Stats;
        try {
            stats = fs.statSync(logFilePath);
            text = fs.readFileSync(logFilePath, 'utf8');
        } catch (error) {
            return fail('log_unreadable', `Could not read ${logFilePath}: ${textOf(error)}`,
                undefined, { logFilePath });
        }

        const lines = text.split('\n');
        const file: LogFile = {
            logFilePath,
            fileSize: stats.size,
            lastModified: stats.mtime.toISOString(),
            totalLines: lines.length
        };

        let sinceMs: number | undefined;
        if (args.since !== undefined && args.since !== '') {
            try {
                sinceMs = parseSince(args.since, Date.now());
            } catch (error) {
                return fail('invalid_since', textOf(error), undefined, file);
            }
        }

        const entries = groupLogLines(lines);
        const narrowed = sinceMs !== undefined || args.level !== undefined;
        const kept = narrowed ? filterEntries(entries, { sinceMs, minLevel: args.level }) : entries;
        const window = {
            since: sinceMs === undefined ? undefined : new Date(sinceMs).toISOString(),
            level: args.level,
            entriesInWindow: kept.length,
            entriesTotal: entries.length
        };

        const query = args.query === undefined ? '' : args.query.trim();
        if (!query) {
            const limit = args.limit ?? DEFAULT_TAIL;
            const tail = kept.slice(-limit);
            return ok({
                ...file,
                mode: 'tail',
                window,
                returned: tail.length,
                truncated: kept.length > tail.length,
                entries: tail.map(entry => describeEntry(entry, args.includeDetail === true))
            }, `${tail.length} of ${kept.length} entries from ${logFilePath}`);
        }

        try {
            const result = searchLines(narrowed ? maskOutsideEntries(lines, kept) : lines, {
                pattern: query,
                maxResults: args.limit ?? DEFAULT_MATCHES,
                contextLines: args.contextLines,
                regex: args.regex,
                caseSensitive: args.caseSensitive
            });
            return ok({ ...file, mode: 'search', window, ...result },
                `${result.returned} of ${result.totalMatches} matching lines in ${logFilePath}`);
        } catch (error) {
            return fail('bad_query', textOf(error), undefined, file);
        }
    }
});

export const debugGetPreviewLogs = defineTool({
    name: 'debug_get_preview_logs',
    description: 'Console output of the RUNNING PREVIEW (the game itself), forwarded from the preview page '
        + 'by the bridge. This is the only way to observe a running playable: the preview runs in an '
        + 'external browser, so debug_project_logs — which reads the editor\'s temp/logs/project.log — never '
        + 'contains a single line from the game. Includes uncaught errors and unhandled promise rejections. '
        + 'Requires the page to load <script src="http://127.0.0.1:<port>/preview-console.js"> (see the '
        + 'playable\'s preview-template); if nothing has ever been received, that script tag is missing or '
        + 'the page has not been reloaded since the bridge started.',
    schema: z.object({
        limit: z.coerce.number().min(1).max(2000).optional()
            .describe('Maximum entries to return, most recent kept (default 200)'),
        minLevel: levelArg.optional().describe('Minimum severity: debug < log < info < warn < error'),
        level: levelArg.optional().describe('Exact severity, e.g. "error" for errors only'),
        since: z.string().optional()
            .describe('Only entries received after this point: "30s", "5m", an ISO date, or epoch ms'),
        afterSeq: z.coerce.number().optional()
            .describe('Only entries with seq greater than this — poll without re-reading what you have'),
        contains: z.string().optional().describe('Case-insensitive substring the message must contain'),
        session: z.string().optional().describe('Only entries from this page-load. Each preview reload gets '
            + 'a new session id, so this separates the current run from the previous one.')
    }),
    aliases: {
        maxResults: 'limit', max: 'limit', lines: 'limit',
        severity: 'minLevel',
        type: 'level',
        after: 'since', newerThan: 'since',
        pattern: 'contains', filter: 'contains', keyword: 'contains'
    },
    async handler(args, ctx) {
        let sinceMs: number | undefined;
        if (args.since !== undefined && args.since !== '') {
            try {
                sinceMs = parseSince(args.since, Date.now());
            } catch (error) {
                return fail('invalid_since', textOf(error));
            }
        }

        const result = ctx.logs.query({
            limit: args.limit,
            minLevel: args.minLevel,
            level: args.level,
            sinceMs,
            afterSeq: args.afterSeq,
            contains: args.contains,
            session: args.session
        });
        const stats = ctx.logs.stats();

        const hint = stats.highestSeq === 0
            ? 'No preview output has ever reached the bridge. Check that the preview page loads '
                + `<script src="http://127.0.0.1:${ctx.settings.port}/preview-console.js"> (the playable's `
                + 'preview-template/index.ejs), that the preview is open, and that it was reloaded after '
                + 'the bridge started.'
            : undefined;

        return ok({
            returned: result.entries.length,
            matched: result.matched,
            truncated: result.truncated,
            buffered: stats.buffered,
            highestSeq: stats.highestSeq,
            droppedOldest: stats.droppedOldest,
            sessions: stats.sessions,
            hint,
            logs: result.entries
        });
    }
});

export const debugClearPreviewLogs = defineTool({
    name: 'debug_clear_preview_logs',
    description: 'Drop everything buffered from the preview page. Use before a preview reload so the next '
        + 'debug_get_preview_logs shows only the new run.',
    schema: z.object({}),
    async handler(_args, ctx) {
        ctx.logs.clear();
        return ok(undefined, 'Preview log buffer cleared');
    }
});

export const debugValidateScene = defineTool({
    name: 'debug_validate_scene',
    description: 'Cheap health check over the open scene\'s node tree: how many nodes it carries and '
        + 'whether that count is past the point where activation cost starts to show. It does NOT check '
        + 'asset references — the editor exposes no missing-asset scan, and a tool claiming one would be '
        + 'lying; read the tree itself with scene_dump.',
    schema: z.object({}),
    async handler(_args, ctx) {
        let tree;
        try {
            tree = await ctx.editor.scene.queryNodeTree();
        } catch (error) {
            return fail('scene_unreadable', `The scene tree could not be read: ${textOf(error)}`,
                'A scene must be open and loaded; check scene_query_ready.');
        }
        if (!tree) {
            return fail('no_scene', 'No scene is open, so there is nothing to validate.');
        }

        const countNodes = (nodes: Array<{ children?: any[] }> = []): number =>
            nodes.reduce((count, node) => count + 1 + countNodes(node.children), 0);
        const nodeCount = countNodes(tree.children);

        const issues = nodeCount > 1000
            ? [{
                type: 'warning',
                category: 'performance',
                message: `High node count: ${nodeCount} nodes (recommended < 1000)`,
                suggestion: 'Consider using object pooling or scene optimization'
            }]
            : [];

        return ok({ valid: issues.length === 0, nodeCount, checks: ['nodeCount'], issueCount: issues.length, issues },
            issues.length ? `${issues.length} issue(s) in ${nodeCount} nodes` : `${nodeCount} nodes, no issues`);
    }
});

export const debugGetEditorInfo = defineTool({
    name: 'debug_get_editor_info',
    description: 'Which editor and which project this bridge is attached to: Creator and engine version, '
        + 'platform, node version, the project\'s name, disk path and uuid, plus the extension process\'s '
        + 'own memory and uptime.',
    schema: z.object({}),
    async handler() {
        return ok({
            editor: {
                version: (Editor as any).versions?.editor ?? 'Unknown',
                cocosVersion: (Editor as any).versions?.cocos ?? 'Unknown',
                platform: process.platform,
                arch: process.arch,
                nodeVersion: process.version
            },
            project: {
                name: Editor.Project.name,
                path: Editor.Project.path,
                uuid: Editor.Project.uuid
            },
            memory: process.memoryUsage(),
            uptime: process.uptime()
        });
    }
});

export const debugGetPerformanceStats = defineTool({
    name: 'debug_get_performance_stats',
    description: 'Renderer counters — draw calls, triangles, memory. The editor keeps none of them in '
        + 'edit mode, so this call refuses rather than answering with zeros: they exist only while the game '
        + 'runs. Start the preview with project_run_project and read what the playable\'s perf panel reports '
        + 'through debug_get_preview_logs. Node counts come from debug_validate_scene.',
    schema: z.object({}),
    async handler() {
        return fail('preview_only',
            'Draw calls, triangles and renderer memory do not exist in edit mode — the editor viewport is '
            + 'not the game, and there are no counters to read.',
            'Run the game (project_run_project) and read its perf output with debug_get_preview_logs; for '
            + 'node counts use debug_validate_scene.');
    }
});

export const debugTools: RegisteredTool[] = [
    debugExecuteScript,
    debugProjectLogs,
    debugGetPreviewLogs,
    debugClearPreviewLogs,
    debugValidateScene,
    debugGetEditorInfo,
    debugGetPerformanceStats
];
