import { Command, Option } from 'commander';
import { LOG_LEVELS, filterEntries, groupLogLines, maskOutsideEntries, parseSince } from '../log/entries.ts';
import { readProjectLog } from '../log/file.ts';
import { searchLines } from '../log/search.ts';
import { numberFlag } from './flags.ts';
import { withProject } from './shared.ts';
import type { LogWindow, ProjectLogEntry } from '../log/entries.ts';
import type { LogFileInfo, ProjectLogFile } from '../log/file.ts';
import type { Report } from '../render/present.ts';
import type { ResolvedProject } from '../resolve.ts';

const DEFAULT_TAIL = 100;
const DEFAULT_MATCHES = 20;

export interface LogWindowSpec {
    projectPath: string;
    level?: string;
    since?: string;
    contains?: string;
}

export interface LogTailSpec extends LogWindowSpec {
    limit?: number;
    detail?: boolean;
}

export interface LogSearchSpec extends LogWindowSpec {
    pattern: string;
    limit?: number;
    contextLines?: number;
    regex?: boolean;
    caseSensitive?: boolean;
}

interface ReadWindow {
    file: ProjectLogFile;
    info: LogFileInfo;
    kept: ProjectLogEntry[];
    window: LogWindow;
    /** Whether anything narrowed the file at all — nothing did, so the search reads it whole. */
    narrowed: boolean;
}

function readWindow(spec: LogWindowSpec): ReadWindow {
    const file = readProjectLog(spec.projectPath);
    const { lines, ...info } = file;
    const entries = groupLogLines(lines);
    const sinceMs = spec.since === undefined ? undefined : parseSince(spec.since, Date.now());
    const kept = filterEntries(entries, { minLevel: spec.level, sinceMs, contains: spec.contains });
    return {
        file,
        info,
        kept,
        window: {
            level: spec.level,
            since: sinceMs === undefined ? undefined : new Date(sinceMs).toISOString(),
            contains: spec.contains,
            entriesInWindow: kept.length,
            entriesTotal: entries.length
        },
        narrowed: sinceMs !== undefined || spec.level !== undefined || spec.contains !== undefined
    };
}

export async function logTail(spec: LogTailSpec): Promise<Report> {
    const read = readWindow(spec);
    return {
        kind: 'logTail',
        file: read.info,
        window: read.window,
        entries: read.kept.slice(-(spec.limit ?? DEFAULT_TAIL)),
        detail: spec.detail === true
    };
}

/**
 * A narrowed search runs over the masked file rather than the kept entries: the blanked copy keeps
 * the file's own line numbers, so a match still reports where it sits in `project.log`.
 */
export async function logSearch(spec: LogSearchSpec): Promise<Report> {
    const read = readWindow(spec);
    return {
        kind: 'logSearch',
        file: read.info,
        window: read.window,
        result: searchLines(
            read.narrowed ? maskOutsideEntries(read.file.lines, read.kept) : read.file.lines,
            {
                pattern: spec.pattern,
                maxResults: spec.limit ?? DEFAULT_MATCHES,
                contextLines: spec.contextLines,
                regex: spec.regex,
                caseSensitive: spec.caseSensitive
            })
    };
}

function levelOption(): Option {
    return new Option('--level <level>', 'minimum severity of the entry; a frame inherits the '
        + 'severity of the entry it belongs to').choices([...LOG_LEVELS]);
}

export function registerLog(program: Command, resolve: () => Promise<ResolvedProject>): void {
    const log = program.command('log')
        .description(`the editor's own temp/logs/project.log — imports, compile errors, scene errors`);

    log.command('tail')
        .description('the most recent entries of the log')
        .option('-n, --limit <count>', `how many entries (default ${DEFAULT_TAIL})`)
        .addOption(levelOption())
        .option('--since <age>', 'only entries newer than this: "15m", "2h", "1d", an ISO date, or epoch ms')
        .option('--contains <text>', 'only entries whose header line carries this text')
        .option('--detail', 'print the stack frames of each entry instead of counting them')
        .option('--json', 'print the structural form instead of text')
        .action(async (options: {
            limit?: string; level?: string; since?: string; contains?: string;
            detail?: boolean; json?: boolean;
        }) => {
            await withProject(resolve, async hello => logTail({
                projectPath: hello.projectPath,
                limit: numberFlag('-n', options.limit),
                level: options.level,
                since: options.since,
                contains: options.contains,
                detail: options.detail
            }), { json: options.json });
        });

    log.command('search <pattern>')
        .description('lines of the log matching a pattern, with the lines around each one')
        .option('-n, --limit <count>', `how many matches (default ${DEFAULT_MATCHES})`)
        .option('--context <count>', 'lines of context around each match (default 2)')
        .option('--regex', 'read the pattern as a regular expression instead of literal text')
        .option('--case-sensitive', 'match case exactly')
        .addOption(levelOption())
        .option('--since <age>', 'only entries newer than this: "15m", "2h", "1d", an ISO date, or epoch ms')
        .option('--contains <text>', 'only entries whose header line carries this text')
        .option('--json', 'print the structural form instead of text')
        .action(async (pattern: string, options: {
            limit?: string; context?: string; regex?: boolean; caseSensitive?: boolean;
            level?: string; since?: string; contains?: string; json?: boolean;
        }) => {
            await withProject(resolve, async hello => logSearch({
                projectPath: hello.projectPath,
                pattern,
                limit: numberFlag('-n', options.limit),
                contextLines: numberFlag('--context', options.context),
                regex: options.regex,
                caseSensitive: options.caseSensitive,
                level: options.level,
                since: options.since,
                contains: options.contains
            }), { json: options.json });
        });
}
