import type { WriteReport } from '@cocos-cli/shared';
import type { Verdict } from './verdict.ts';

export interface RenderedWrite {
    component: string;
    property: string;
    value?: unknown;
    report: WriteReport;
    undoNote?: string;
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

export function renderWriteReport(write: RenderedWrite): string {
    const { report } = write;
    const persisted = report.persisted === null ? 'unknown' : String(report.persisted);
    const target = `${write.component}.${write.property}`;
    const value = write.value === undefined ? '' : ` = ${JSON.stringify(write.value)}`;

    const parts = [
        `${writeVerdict(report)}  ${target}${value}`,
        report.verified ? 'verified' : 'unverified',
        `persisted=${persisted}`,
        `channel=${report.channel || 'unknown'}`
    ];

    if (report.persisted === false && report.channel === 'live') {
        parts.push('(expected on live: the channel serializes nothing)');
    }
    if (report.prefabOverride) parts.push(`override on ${report.prefabOverride.targetPath}`);
    if (report.detail) parts.push(report.detail);
    if (write.undoNote) parts.push(write.undoNote);

    return parts.join('  ');
}
