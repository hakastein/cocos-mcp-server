import type { NodeType } from '../node-type';
import type { Verdict } from './verdict';

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

export function nodeWriteVerdict(report: NodeWriteReport): Verdict {
    return report.unapplied ? 'FAILED' : 'ok';
}

export function renderNodeWrite(report: NodeWriteReport): string {
    const head = nodeWriteVerdict(report);
    if (report.unapplied) {
        const { property, expected, observed } = report.unapplied;
        return `${head}  ${report.target}.${property} = ${JSON.stringify(expected)}`
            + `  узел по-прежнему отвечает ${JSON.stringify(observed)}`
            + (report.applied.length
                ? `  (успело лечь: ${report.applied.map(write => write.property).join(', ')})`
                : '');
    }
    if (!report.applied.length) return `${head}  ${report.target}  нечего писать`;

    const written = report.applied
        .map(write => `${write.property}=${JSON.stringify(write.value)}`)
        .join('  ');
    return `${head}  ${report.target}  ${written}`
        + (report.nodeType ? `  ${report.nodeType}` : '')
        + (report.undoNote ? `  ${report.undoNote}` : '  undo=1');
}

export function nodeWriteNote(report: NodeWriteReport): string {
    return report.warnings.join('\n');
}
