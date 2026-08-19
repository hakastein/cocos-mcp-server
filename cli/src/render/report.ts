import type { WriteReport } from '@cocos-cli/shared/dist/scene-contract';

export interface RenderedWrite {
    component: string;
    property: string;
    value?: unknown;
    report: WriteReport;
    undoNote?: string;
}

/**
 * `persisted: null` означает, что сохранение никто не проверял — печатать его как `false` значит
 * выдать непроверенное за опровергнутое; та же логика разводит и три исхода заголовка.
 */
export function renderWriteReport(write: RenderedWrite): string {
    const { report } = write;
    const head = !report.written ? 'НЕ ЗАПИСАНО' : report.verified ? 'ok' : 'ЗАПИСАНО, НЕ ПРОВЕРЕНО';
    const persisted = report.persisted === null ? 'unknown' : String(report.persisted);
    const target = `${write.component}.${write.property}`;
    const value = write.value === undefined ? '' : ` = ${JSON.stringify(write.value)}`;

    const parts = [
        `${head}  ${target}${value}`,
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
