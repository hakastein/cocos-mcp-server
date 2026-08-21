/**
 * 84% of the lines in a real project.log are continuation lines — stack frames belonging to the
 * entry above them. Reading the level off the line's own `- <level>:` field rather than off words
 * like "error" in it is what keeps a frame under a harmless log from being promoted, and the frames
 * under a real error from being read as harmless.
 */

export type LogLevel = 'debug' | 'log' | 'info' | 'warn' | 'error';

export interface ProjectLogEntry {
    /** 1-based line number of the entry's header line. */
    lineNumber: number;
    /** 1-based line number of the last line belonging to this entry (blank lines may sit inside it). */
    endLine: number;
    /** Epoch ms, or null for a line the editor wrote without a timestamp. */
    ts: number | null;
    time: string | null;
    level: LogLevel;
    message: string;
    /** Continuation lines (stack frames, wrapped text) that followed the header. */
    detail?: string[];
}

const HEADER = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2}) - ([a-zA-Z]+): ?([\s\S]*)$/;

/** `log` and `info` are distinct so a minLevel of `info` can exclude chatter. */
const RANK: Record<LogLevel, number> = { debug: 0, log: 1, info: 2, warn: 3, error: 4 };

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'log', 'info', 'warn', 'error'];

function normalizeLevel(raw: string): LogLevel {
    const level = raw.toLowerCase();
    if (level === 'error' || level === 'err' || level === 'fatal') return 'error';
    if (level === 'warn' || level === 'warning') return 'warn';
    if (level === 'info') return 'info';
    if (level === 'debug' || level === 'trace' || level === 'verbose') return 'debug';
    return 'log';
}

export function levelRank(level: string): number {
    const rank = RANK[normalizeLevel(level)];
    return rank === undefined ? RANK.log : rank;
}

export function levelAtLeast(level: string, minLevel: string): boolean {
    return levelRank(level) >= levelRank(minLevel);
}

/**
 * `DD.MM.YYYY HH:MM:SS` in the editor's local time — the editor writes local time with no zone
 * marker, so it is read back as local rather than UTC.
 */
export function parseLogTimestamp(
    y: string, mo: string, d: string, h: string, mi: string, s: string
): number {
    return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
}

/**
 * Fold raw log lines into entries. Lines before the first header (the editor's own startup banner)
 * become one entry with a null timestamp rather than being dropped.
 */
export function groupLogLines(lines: readonly string[]): ProjectLogEntry[] {
    const entries: ProjectLogEntry[] = [];
    let current: ProjectLogEntry | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const header = HEADER.exec(line);
        if (header) {
            current = {
                lineNumber: i + 1,
                endLine: i + 1,
                ts: parseLogTimestamp(header[3], header[2], header[1], header[4], header[5], header[6]),
                time: `${header[1]}.${header[2]}.${header[3]} ${header[4]}:${header[5]}:${header[6]}`,
                level: normalizeLevel(header[7]),
                message: header[8]
            };
            entries.push(current);
            continue;
        }
        if (!line.trim()) continue;
        if (!current) {
            current = { lineNumber: i + 1, endLine: i + 1, ts: null, time: null, level: 'log', message: line };
            entries.push(current);
            continue;
        }
        (current.detail ||= []).push(line);
        current.endLine = i + 1;
    }
    return entries;
}

/**
 * Resolve a `since` argument to epoch ms: a relative age (`15m`, `2h`, `90s`, `1d`), an absolute
 * date string, or epoch ms. An unparseable value throws instead of silently widening the window
 * back to the beginning of the file — a log search that quietly ignores its time filter is the
 * failure this argument exists to prevent.
 */
export function parseSince(value: unknown, nowMs: number): number {
    if (value === undefined || value === null || value === '') {
        throw new Error('parseSince: no value');
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;

    const text = String(value).trim();
    const relative = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i.exec(text);
    if (relative) {
        const unit: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
        return nowMs - Number(relative[1]) * unit[relative[2].toLowerCase()];
    }
    if (/^\d+$/.test(text)) return Number(text);

    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return parsed;
    throw new Error(
        `Cannot read 'since' value ${JSON.stringify(value)}. Use a relative age like "15m", "2h" `
        + 'or "1d", an ISO date, or epoch milliseconds.');
}

export interface EntryFilter {
    /** Minimum severity, e.g. 'warn' keeps warn and error. */
    minLevel?: string;
    /** Epoch ms; entries older than this are dropped. Entries with no timestamp are kept. */
    sinceMs?: number;
    /** Case-insensitive substring the header line must contain. */
    contains?: string;
}

/** Which part of the file a reading was taken from, so a zero-result is readable. */
export interface LogWindow {
    level?: string;
    /** ISO-8601 cutoff, when `--since` narrowed the window. */
    since?: string;
    contains?: string;
    entriesInWindow: number;
    entriesTotal: number;
}

/**
 * A copy of `lines` where every line outside the kept entries is blanked. Blanking rather than
 * removing preserves 1-based line numbers and the surrounding-context slices of a search.
 */
export function maskOutsideEntries(
    lines: readonly string[], kept: readonly ProjectLogEntry[]
): string[] {
    const masked: string[] = new Array(lines.length).fill('');
    for (const entry of kept) {
        for (let i = entry.lineNumber - 1; i < entry.endLine && i < lines.length; i++) {
            masked[i] = lines[i];
        }
    }
    return masked;
}

export function filterEntries(
    entries: readonly ProjectLogEntry[], filter: EntryFilter
): ProjectLogEntry[] {
    const needle = filter.contains ? filter.contains.toLowerCase() : null;
    return entries.filter(entry => {
        if (filter.minLevel && !levelAtLeast(entry.level, filter.minLevel)) return false;
        // A timestampless entry is the editor's startup banner; a time window is about recency and
        // cannot judge it, so it is kept rather than silently discarded.
        if (filter.sinceMs !== undefined && entry.ts !== null && entry.ts < filter.sinceMs) return false;
        if (needle && !entry.message.toLowerCase().includes(needle)) return false;
        return true;
    });
}
