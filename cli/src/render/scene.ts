import type { ComponentOwnerReport, MissingScriptDump, SceneDirtyReport } from '@cocos-cli/shared';

function padRight(text: string, width: number): string {
    return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * `active` и `activeInHierarchy` печатаются раздельно: включённый узел под выключенным родителем
 * в игре мёртв, а по своему флагу выглядит живым, и одна колонка эти два случая слепляет.
 */
export function renderComponentOwners(report: ComponentOwnerReport): string {
    if (!report.owners.length) return `ни один узел сцены не несёт ${report.className}`;
    const width = report.owners.reduce((widest, owner) => Math.max(widest, owner.className.length), 0);
    return report.owners
        .map(owner => {
            const marks = [
                owner.activeInHierarchy ? '' : owner.active ? '(под выключенным)' : '(off)',
                owner.enabled ? '' : '(компонент off)'
            ].filter(mark => mark);
            return `${padRight(owner.className, width)}  ${owner.nodePath}${
                marks.length ? `  ${marks.join(' ')}` : ''}  ${owner.nodeUuid}`;
        })
        .join('\n');
}

export function componentOwnersSummary(report: ComponentOwnerReport): string {
    return `${report.className} в ${report.sceneName}: носителей ${report.ownerCount}`
        + `, просмотрено узлов ${report.nodesScanned}`;
}

/**
 * Редакторский флаг dirty считает шаги undo, поэтому запись мимо скобки он не видит; этот отчёт
 * сравнивает то, что выдал бы сериализатор, с тем, что уже лежит в файле.
 */
export function renderSceneDirty(report: SceneDirtyReport): string {
    if (!report.differsFromDisk) {
        return `совпадает с диском  ${report.scenePath || 'путь неизвестен'}`;
    }
    const lines = [`РАСХОДИТСЯ С ДИСКОМ  ${report.scenePath || 'путь неизвестен'}`
        + `  расхождений: ${report.diffs.length}`];
    for (const diff of report.diffs) {
        lines.push(`  ${diff.path}  сцена ${diff.live}  диск ${diff.disk}`);
    }
    return lines.join('\n');
}

export function sceneDirtyNote(report: SceneDirtyReport): string {
    return report.reason || '';
}

/**
 * Компонент, чей скрипт больше не резолвится: именно этот слот роняет превью на загрузке сцены.
 */
export function renderMissingScripts(dump: MissingScriptDump): string {
    if (!dump.entries.length) return 'мёртвых компонентов в сцене нет';
    return dump.entries
        .map(entry => `${entry.nodePath}  cid=${entry.cid || 'неизвестен'}  ${entry.componentUuid}`)
        .join('\n');
}
