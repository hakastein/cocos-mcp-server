/**
 * Buffer for console output forwarded from a running preview page.
 *
 * The preview runs in an external browser; its console never reaches temp/logs/project.log,
 * so nothing an agent can call says anything about the running game. `preview-console-client`
 * is injected into the preview page and POSTs here; the `get_preview_logs` tool reads this
 * buffer. Kept free of `fs`, `http` and the editor globals so the filtering is testable.
 */

import { LogLevel, levelAtLeast, filterEntries, ProjectLogEntry } from './project-log';

export interface PreviewLogEntry {
    /** Monotonic per-store id; survives page reloads so callers can page forward. */
    seq: number;
    /** Page-side timestamp, epoch ms. */
    ts: number;
    /** Bridge-side arrival time, epoch ms — the clock `since` is compared against. */
    receivedAt: number;
    level: LogLevel;
    message: string;
    stack?: string;
    /** Per-page-load id; a change means the preview reloaded. */
    session: string;
    /** Page url the entry came from. */
    url?: string;
}

export interface PreviewSession {
    session: string;
    firstSeen: number;
    lastSeen: number;
    count: number;
    url?: string;
}

const LEVELS: LogLevel[] = ['debug', 'log', 'info', 'warn', 'error'];

function normalizeLevel(raw: any): LogLevel {
    const v = String(raw || 'log').toLowerCase();
    return (LEVELS as string[]).includes(v) ? v as LogLevel : 'log';
}

function clampText(value: any, max: number): string {
    const s = typeof value === 'string' ? value : String(value ?? '');
    return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars]` : s;
}

export interface PreviewLogQuery {
    limit?: number;
    /** Minimum severity, e.g. 'warn' keeps warn and error. */
    minLevel?: string;
    /** Exact severity. */
    level?: string;
    /** Epoch ms; entries received before this are dropped. */
    sinceMs?: number;
    /** Only entries after this seq (for polling without re-reading). */
    afterSeq?: number;
    /** Case-insensitive substring match on the message. */
    contains?: string;
    /** Only entries from this page-load. */
    session?: string;
}

/** Pure filter over already-collected entries. */
export function filterPreviewLogs(entries: PreviewLogEntry[], q: PreviewLogQuery): PreviewLogEntry[] {
    const needle = q.contains ? q.contains.toLowerCase() : null;
    return entries.filter((e) => {
        if (q.minLevel && !levelAtLeast(e.level, q.minLevel)) return false;
        if (q.level && normalizeLevel(q.level) !== e.level) return false;
        if (q.sinceMs !== undefined && e.receivedAt < q.sinceMs) return false;
        if (q.afterSeq !== undefined && e.seq <= q.afterSeq) return false;
        if (q.session && e.session !== q.session) return false;
        if (needle && !e.message.toLowerCase().includes(needle)) return false;
        return true;
    });
}

/** Normalize one wire-format record into a stored entry. Returns null for unusable input. */
export function toEntry(raw: any, seq: number, receivedAt: number, session: string, maxMessage: number): PreviewLogEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const message = clampText(raw.message, maxMessage);
    if (!message) return null;
    const ts = Number(raw.ts);
    const entry: PreviewLogEntry = {
        seq,
        ts: Number.isFinite(ts) ? ts : receivedAt,
        receivedAt,
        level: normalizeLevel(raw.level),
        message,
        session
    };
    if (raw.stack) entry.stack = clampText(raw.stack, maxMessage);
    if (raw.url) entry.url = clampText(raw.url, 500);
    return entry;
}

export class PreviewLogStore {
    private entries: PreviewLogEntry[] = [];
    private seq = 0;
    private dropped = 0;
    private sessions = new Map<string, PreviewSession>();

    constructor(private capacity = 5000, private maxMessage = 8000) {}

    /** Ingest one posted batch. Returns how many entries were accepted. */
    ingest(payload: any, receivedAt: number): number {
        const session = String(payload?.session || 'unknown');
        const url = payload?.url ? String(payload.url) : undefined;
        const list = Array.isArray(payload?.entries) ? payload.entries : [];
        let accepted = 0;
        for (const raw of list) {
            const entry = toEntry(raw, this.seq + 1, receivedAt, session, this.maxMessage);
            if (!entry) continue;
            this.seq++;
            this.entries.push(entry);
            accepted++;
        }
        if (accepted) {
            const s = this.sessions.get(session);
            if (s) {
                s.lastSeen = receivedAt;
                s.count += accepted;
            } else {
                this.sessions.set(session, { session, firstSeen: receivedAt, lastSeen: receivedAt, count: accepted, url });
            }
        }
        if (this.entries.length > this.capacity) {
            const excess = this.entries.length - this.capacity;
            this.entries.splice(0, excess);
            this.dropped += excess;
        }
        return accepted;
    }

    query(q: PreviewLogQuery): { entries: PreviewLogEntry[]; matched: number; truncated: boolean } {
        const matched = filterPreviewLogs(this.entries, q);
        const limit = Number.isFinite(q.limit as number) ? Math.max(1, Math.min(2000, Math.floor(q.limit as number))) : 200;
        // Most recent wins when capped — a log tail is read from the end.
        const entries = matched.slice(-limit);
        return { entries, matched: matched.length, truncated: matched.length > entries.length };
    }

    stats() {
        return {
            buffered: this.entries.length,
            capacity: this.capacity,
            /** Entries evicted because the buffer was full. */
            droppedOldest: this.dropped,
            highestSeq: this.seq,
            sessions: Array.from(this.sessions.values()).sort((a, b) => a.firstSeen - b.firstSeen)
        };
    }

    clear(): void {
        this.entries = [];
        this.sessions.clear();
        this.dropped = 0;
    }
}

export { filterEntries, ProjectLogEntry };
