import type { WriteReport } from '@cocos-cli/shared';
import { worstVerdict } from './verdict.ts';
import type { Verdict } from './verdict.ts';

export interface RenderedWrite {
    /** What the property sits on: a component's registered class name, or a node's path. */
    target: string;
    property: string;
    value?: unknown;
    report: WriteReport;
}

/** Every write of one undo bracket, which is what a command performs at most one of. */
export interface WriteBatch {
    target: string;
    writes: RenderedWrite[];
    undoNote: string | null;
}

/**
 * `persisted: false` means something only on the editor channel: there a save really does drop the
 * value, while live serializes nothing by construction. `persisted: null` is unchecked rather than
 * disproven, so it is judged by the read-back instead of by the save.
 */
export function writeVerdict(report: WriteReport): Verdict {
    if (!report.written) return 'FAILED';
    if (report.persisted === false && report.channel !== 'live') return 'UNPERSISTED';
    return report.verified ? 'ok' : 'UNVERIFIED';
}

export function writesVerdict(writes: readonly RenderedWrite[]): Verdict {
    return worstVerdict(writes.map(write => writeVerdict(write.report)));
}

/**
 * The one spelling of an undo bracket's outcome. Before this it was written out in three places —
 * folded into a write report's detail, carried as a field of the node write, and pasted onto a
 * summary string — and the three did not say the same thing.
 */
export function undoDetail(undoNote: string | null): string {
    return undoNote === null ? 'undo=1' : undoNote;
}

/**
 * One write is one line. Several get a head line naming the node, because the head word has to be
 * the worst of them and a reader takes it from the first line.
 */
export function renderWrites(batch: WriteBatch): string {
    const detail = undoDetail(batch.undoNote);
    if (!batch.writes.length) return `ok  ${batch.target}  nothing to write  ${detail}`;
    if (batch.writes.length === 1) return renderWriteReport(batch.writes[0], detail);

    const head = `${writesVerdict(batch.writes)}  ${batch.target}  ${batch.writes.length} writes  ${detail}`;
    return [head, ...batch.writes.map(write => `  ${writeLine(write.property, write)}`)].join('\n');
}

export function renderWriteReport(write: RenderedWrite, tail?: string): string {
    return writeLine(`${write.target}.${write.property}`, write, tail);
}

function writeLine(label: string, write: RenderedWrite, tail?: string): string {
    const { report } = write;
    const persisted = report.persisted === null ? 'unknown' : String(report.persisted);
    const value = write.value === undefined ? '' : ` = ${JSON.stringify(write.value)}`;

    const parts = [
        `${writeVerdict(report)}  ${label}${value}`,
        report.verified ? 'verified' : 'unverified',
        `persisted=${persisted}`,
        `channel=${report.channel || 'unknown'}`
    ];

    if (report.persisted === false && report.channel === 'live') {
        parts.push('(expected on live: the channel serializes nothing)');
    }
    if (report.prefabOverride) parts.push(`override on ${report.prefabOverride.targetPath}`);
    if (report.detail) parts.push(report.detail);
    if (tail) parts.push(tail);

    return parts.join('  ');
}
