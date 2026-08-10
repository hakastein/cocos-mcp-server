/**
 * Parsing for temp/logs/project.log, kept free of `fs` and the editor globals so it can be
 * tested directly.
 *
 * 84% of the lines in a real project.log are continuation lines — stack frames belonging to
 * the entry above them. Treating every line as its own record is what made `type:"error"`
 * come back full of entries typed `log`: the old classifier guessed a level per line from
 * words like "error"/"failed", so a stack frame under a harmless log was promoted, and the
 * frames under a real error were not demoted. Here the level is read from the line's own
 * `- <level>:` field and continuation lines are folded into the entry they belong to.
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

/** Severity order; `log` and `info` are distinct so a minLevel of `info` can exclude chatter. */
const RANK: Record<LogLevel, number> = { debug: 0, log: 1, info: 2, warn: 3, error: 4 };

function normalizeLevel(raw: string): LogLevel {
    const v = raw.toLowerCase();
    if (v === 'error' || v === 'err' || v === 'fatal') return 'error';
    if (v === 'warn' || v === 'warning') return 'warn';
    if (v === 'info') return 'info';
    if (v === 'debug' || v === 'trace' || v === 'verbose') return 'debug';
    return 'log';
}

export function levelRank(level: string): number {
    const r = RANK[normalizeLevel(level)];
    return r === undefined ? RANK.log : r;
}

/** True when `level` is at least as severe as `minLevel`. */
export function levelAtLeast(level: string, minLevel: string): boolean {
    return levelRank(level) >= levelRank(minLevel);
}

/**
 * `DD.MM.YYYY HH:MM:SS` in the editor's local time — the editor writes local time with no
 * zone marker, so it is read back as local rather than UTC.
 */
export function parseLogTimestamp(y: string, mo: string, d: string, h: string, mi: string, s: string): number {
    return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
}

/**
 * Fold raw log lines into entries. Lines before the first header (the editor's own startup
 * banner) become one entry with a null timestamp rather than being dropped.
 */
export function groupLogLines(lines: string[]): ProjectLogEntry[] {
    const entries: ProjectLogEntry[] = [];
    let current: ProjectLogEntry | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = HEADER.exec(line);
        if (m) {
            current = {
                lineNumber: i + 1,
                endLine: i + 1,
                ts: parseLogTimestamp(m[3], m[2], m[1], m[4], m[5], m[6]),
                time: `${m[1]}.${m[2]}.${m[3]} ${m[4]}:${m[5]}:${m[6]}`,
                level: normalizeLevel(m[7]),
                message: m[8]
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
 * Resolve a `since` argument to epoch ms.
 *
 * Accepts a relative age (`"15m"`, `"2h"`, `"90s"`, `"1d"`), an absolute date string, or an
 * epoch-ms number. An unparseable value throws instead of silently widening the window back
 * to the beginning of the file — a log search that quietly ignores its time filter is the
 * failure this argument exists to prevent.
 */
export function parseSince(value: any, nowMs: number): number {
    if (value === undefined || value === null || value === '') {
        throw new Error("parseSince: no value");
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    const text = String(value).trim();
    const rel = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i.exec(text);
    if (rel) {
        const unit: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
        return nowMs - Number(rel[1]) * unit[rel[2].toLowerCase()];
    }
    if (/^\d+$/.test(text)) {
        return Number(text);
    }
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return parsed;
    throw new Error(
        `Cannot read 'since' value ${JSON.stringify(value)}. Use a relative age like "15m", "2h" or "1d", `
        + 'an ISO date, or epoch milliseconds.'
    );
}

export interface EntryFilter {
    /** Minimum severity, e.g. 'warn' keeps warn and error. */
    minLevel?: string;
    /** Exact severity, e.g. 'error' keeps only errors. Applied after minLevel. */
    level?: string;
    /** Epoch ms; entries older than this are dropped. Entries with no timestamp are kept. */
    sinceMs?: number;
    /** Case-insensitive substring the header line must contain. */
    contains?: string;
}

/**
 * A copy of `lines` where every line outside the kept entries is blanked. Blanking rather than
 * removing preserves 1-based line numbers and the surrounding-context slices of a search.
 */
export function maskOutsideEntries(lines: string[], kept: ProjectLogEntry[]): string[] {
    const masked: string[] = new Array(lines.length).fill('');
    for (const entry of kept) {
        for (let i = entry.lineNumber - 1; i < entry.endLine && i < lines.length; i++) {
            masked[i] = lines[i];
        }
    }
    return masked;
}

export function filterEntries(entries: ProjectLogEntry[], f: EntryFilter): ProjectLogEntry[] {
    const needle = f.contains ? f.contains.toLowerCase() : null;
    return entries.filter((e) => {
        if (f.minLevel && !levelAtLeast(e.level, f.minLevel)) return false;
        if (f.level && normalizeLevel(f.level) !== e.level) return false;
        // A timestampless entry is the editor's startup banner; a time window is about recency
        // and cannot judge it, so it is kept rather than silently discarded.
        if (f.sinceMs !== undefined && e.ts !== null && e.ts < f.sinceMs) return false;
        if (needle && !e.message.toLowerCase().includes(needle)) return false;
        return true;
    });
}
