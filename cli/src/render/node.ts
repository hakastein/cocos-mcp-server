import type { NodeType } from '../node-type';

export interface AppliedWrite {
    property: string;
    value: unknown;
}

export interface UnappliedWrite {
    property: string;
    expected: unknown;
    observed: unknown;
}

export interface NodeWriteReport {
    target: string;
    applied: AppliedWrite[];
    unapplied?: UnappliedWrite;
    warnings: string[];
    nodeType?: NodeType;
    undoNote?: string;
}

export function nodeWriteFailed(report: NodeWriteReport): boolean {
    return report.unapplied !== undefined;
}

/**
 * Первое слово — вердикт, как и у `component set`. Запись, которая до узла не дошла, получает своё
 * слово, а не `ok` с оговоркой в хвосте: хвост никто не читает.
 */
export function renderNodeWrite(report: NodeWriteReport): string {
    if (report.unapplied) {
        const { property, expected, observed } = report.unapplied;
        return `НЕ ЗАПИСАНО  ${report.target}.${property} = ${JSON.stringify(expected)}`
            + `  узел по-прежнему отвечает ${JSON.stringify(observed)}`
            + (report.applied.length
                ? `  (успело лечь: ${report.applied.map(write => write.property).join(', ')})`
                : '');
    }
    if (!report.applied.length) return `нечего писать  ${report.target}`;

    const written = report.applied
        .map(write => `${write.property}=${JSON.stringify(write.value)}`)
        .join('  ');
    return `ok  ${report.target}  ${written}`
        + (report.nodeType ? `  ${report.nodeType}` : '')
        + (report.undoNote ? `  ${report.undoNote}` : '  undo=1');
}

/** Обнулённая ось у 2D-узла — не деталь оформления: молча испорченный трансформ читается как успех. */
export function nodeWriteNote(report: NodeWriteReport): string {
    return report.warnings.join('\n');
}
