import type { ComponentOwnerReport, MissingScriptDump, SceneDirtyReport } from '@cocos-cli/shared';
import { padRight } from './columns.ts';

/**
 * `active` and `activeInHierarchy` print separately: a node switched on under a parent switched off
 * is dead in the game while its own flag looks alive, and one column glues those two cases together.
 */
export function renderComponentOwners(report: ComponentOwnerReport): string {
    if (!report.owners.length) return `no node in the scene carries ${report.className}`;
    const width = report.owners.reduce((widest, owner) => Math.max(widest, owner.className.length), 0);
    return report.owners
        .map(owner => {
            const marks = [
                owner.activeInHierarchy ? '' : owner.active ? '(under an off parent)' : '(off)',
                owner.enabled ? '' : '(component off)'
            ].filter(mark => mark);
            return `${padRight(owner.className, width)}  ${owner.nodePath}${
                marks.length ? `  ${marks.join(' ')}` : ''}  ${owner.nodeUuid}`;
        })
        .join('\n');
}

export function componentOwnersSummary(report: ComponentOwnerReport): string {
    return `${report.className} in ${report.sceneName}: owners ${report.ownerCount}`
        + `, nodes scanned ${report.nodesScanned}`;
}

/**
 * The editor's own dirty flag counts undo steps, so a write made outside a bracket is invisible to
 * it; this report compares what the serializer would emit against what the file already holds.
 */
export function renderSceneDirty(report: SceneDirtyReport): string {
    if (!report.differsFromDisk) {
        return `matches disk  ${report.scenePath || 'path unknown'}`;
    }
    const lines = [`differs from disk  ${report.scenePath || 'path unknown'}`
        + `  differences: ${report.diffs.length}`];
    for (const diff of report.diffs) {
        lines.push(`  ${diff.path}  scene ${diff.live}  disk ${diff.disk}`);
    }
    return lines.join('\n');
}

export function sceneDirtyNote(report: SceneDirtyReport): string {
    return report.reason || '';
}

/**
 * A component whose script no longer resolves: this slot is what crashes preview on scene load.
 */
export function renderMissingScripts(dump: MissingScriptDump): string {
    if (!dump.entries.length) return 'no dead components in the scene';
    return dump.entries
        .map(entry => `${entry.nodePath}  cid=${entry.cid || 'unknown'}  ${entry.componentUuid}`)
        .join('\n');
}
