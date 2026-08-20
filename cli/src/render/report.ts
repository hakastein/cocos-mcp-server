import type { WriteReport } from '@cocos-cli/shared';
import type { Verdict } from './verdict';

export interface RenderedWrite {
    component: string;
    property: string;
    value?: unknown;
    report: WriteReport;
    undoNote?: string;
}

/**
 * `persisted: false` значим только на канале editor: там сохранение действительно уронит значение,
 * а live ничего не сериализует по устройству канала. `persisted: null` — не проверено, а не
 * опровергнуто, поэтому оно судится обратным чтением, а не сохранением.
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
        parts.push('(для live это ожидаемо: канал ничего не сериализует)');
    }
    if (report.prefabOverride) parts.push(`override на ${report.prefabOverride.targetPath}`);
    if (report.detail) parts.push(report.detail);
    if (write.undoNote) parts.push(write.undoNote);

    return parts.join('  ');
}
