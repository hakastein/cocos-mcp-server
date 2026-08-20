import type { PrefabAssetDump, PrefabAssetNode, PrefabOverrideRecord, PrefabOverrideReport } from '@cocos-cli/shared';

const DEAD = '!DEAD';

/**
 * A dead slot prints as its own word rather than as a gap in the list: it is what gets looked for
 * when an `@ccclass` is renamed, and it is what crashes preview on scene load.
 */
function componentLabel(component: PrefabAssetNode['components'][number]): string {
    if (!component.missing) return component.enabled ? component.className : `${component.className}(off)`;
    return `${DEAD} ${component.cid || component.className}`;
}

function nodeLine(node: PrefabAssetNode): string {
    const components = node.components.map(componentLabel).join(',');
    return `${node.path}${node.active ? '' : '  (off)'}${components ? `  [${components}]` : ''}`;
}

export function renderPrefabDump(dump: PrefabAssetDump): string {
    return dump.nodes.map(nodeLine).join('\n');
}

export function prefabDumpSummary(dump: PrefabAssetDump): string {
    return [
        `${dump.rootName}  nodes: ${dump.nodeCount}  components: ${dump.componentCount}`,
        dump.missingCount
            ? `dead components: ${dump.missingCount} — such a slot crashes preview on scene load`
            : ''
    ].filter(Boolean).join('  ');
}

/** The property and its value as `describeOverrideValue` named them on the scene side. */
function overrideValue(record: PrefabOverrideRecord): string {
    switch (record.valueKind) {
        case 'null': return '(empty)';
        case 'array': return `[${record.length} items]`;
        case 'asset': return `${record.assetName || record.valueType || 'asset'}  ${record.assetUuid || '?'}`;
        case 'node': return `${record.refName || 'node'}  ${record.refUuid || '?'}`;
        case 'component': return `${record.valueType || 'component'} on ${record.refName || '?'}  ${record.refUuid || '?'}`;
        case 'valueType': return `${record.valueType}  ${JSON.stringify(record.value)}`;
        case 'object': return record.valueType || 'object';
        default: return JSON.stringify(record.value);
    }
}

function overrideTarget(record: PrefabOverrideRecord): string {
    if (!record.target) return `localID ${record.localID.join('/') || '?'}`;
    return record.target.kind === 'component'
        ? `${record.target.type} on ${record.target.path}`
        : record.target.path;
}

export function renderPrefabOverrides(report: PrefabOverrideReport): string {
    if (!report.overrides.length) return 'no overrides';
    const indexColumn = Math.max(...report.overrides.map(record => String(record.index).length));
    const pathColumn = Math.max(...report.overrides.map(record => record.propertyPath.length));
    return report.overrides
        .map(record => [
            String(record.index).padStart(indexColumn),
            record.propertyPath.padEnd(pathColumn),
            overrideTarget(record),
            overrideValue(record)
        ].join('  '))
        .join('\n');
}

export function prefabOverridesSummary(report: PrefabOverrideReport): string {
    return [
        `${report.nodeName}  overrides: ${report.overrideCount}`,
        `prefab: ${report.prefabAsset || 'unknown'}`,
        report.removedComponents ? `removed components: ${report.removedComponents}` : '',
        report.mountedChildren ? `mounted children: ${report.mountedChildren}` : ''
    ].filter(Boolean).join('  ');
}
