import type { PrefabAssetDump, PrefabAssetNode, PrefabOverrideRecord, PrefabOverrideReport } from '@cocos-cli/shared';

const DEAD = '!МЁРТВЫЙ';

/**
 * Мёртвый слот печатается отдельным словом, а не пропуском в списке: именно его ищут, когда
 * переименовывают `@ccclass`, и именно он роняет превью на загрузке сцены.
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
        `${dump.rootName}  узлов: ${dump.nodeCount}  компонентов: ${dump.componentCount}`,
        dump.missingCount
            ? `МЁРТВЫХ КОМПОНЕНТОВ: ${dump.missingCount} — такой слот роняет превью на загрузке сцены`
            : ''
    ].filter(Boolean).join('  ');
}

/** Свойство и его значение так, как их назвал `describeOverrideValue` на стороне сцены. */
function overrideValue(record: PrefabOverrideRecord): string {
    switch (record.valueKind) {
        case 'null': return '(пусто)';
        case 'array': return `[${record.length} эл.]`;
        case 'asset': return `${record.assetName || record.valueType || 'ассет'}  ${record.assetUuid || '?'}`;
        case 'node': return `${record.refName || 'узел'}  ${record.refUuid || '?'}`;
        case 'component': return `${record.valueType || 'компонент'} на ${record.refName || '?'}  ${record.refUuid || '?'}`;
        case 'valueType': return `${record.valueType}  ${JSON.stringify(record.value)}`;
        case 'object': return record.valueType || 'объект';
        default: return JSON.stringify(record.value);
    }
}

function overrideTarget(record: PrefabOverrideRecord): string {
    if (!record.target) return `localID ${record.localID.join('/') || '?'}`;
    return record.target.kind === 'component'
        ? `${record.target.type} на ${record.target.path}`
        : record.target.path;
}

export function renderPrefabOverrides(report: PrefabOverrideReport): string {
    if (!report.overrides.length) return 'оверрайдов нет';
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
        `${report.nodeName}  оверрайдов: ${report.overrideCount}`,
        `префаб: ${report.prefabAsset || 'не назван'}`,
        report.removedComponents ? `снятых компонентов: ${report.removedComponents}` : '',
        report.mountedChildren ? `добавленных детей: ${report.mountedChildren}` : ''
    ].filter(Boolean).join('  ');
}
