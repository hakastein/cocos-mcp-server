import type { AssetRecord } from '../asset/query';
import type { AssetDiff, ClassDiff } from '../asset/settle';
import { assetDiffEmpty } from '../asset/settle';

export const ASSET_FIELDS = [
    'name', 'type', 'uuid', 'url', 'importer', 'imported', 'invalid', 'isDirectory', 'file', 'subAssets'
] as const;

export type AssetField = typeof ASSET_FIELDS[number];

/** Одно значение на stdout — то, что уходит в переменную оболочки. */
export function assetField(asset: AssetRecord, field: string): string {
    switch (field) {
        case 'name': return asset.name;
        case 'type': return asset.type;
        case 'uuid': return asset.uuid;
        case 'url': return asset.url;
        case 'importer': return asset.importer ?? '';
        case 'imported': return String(asset.imported === true);
        case 'invalid': return String(asset.invalid === true);
        case 'isDirectory': return String(asset.isDirectory === true);
        case 'file': return asset.file ?? '';
        case 'subAssets': return String(Object.keys(asset.subAssets || {}).length);
        default:
            throw new Error(`у ассета нет поля '${field}'; есть: ${ASSET_FIELDS.join(', ')}`);
    }
}

function padRight(text: string, width: number): string {
    return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function renderAssetInfo(asset: AssetRecord): string {
    const rows: Array<[string, string]> = [
        ['name', asset.name],
        ['type', asset.type],
        ['uuid', asset.uuid],
        ['url', asset.url]
    ];
    if (asset.importer) rows.push(['importer', asset.importer]);
    rows.push(['imported', String(asset.imported === true)]);
    if (asset.invalid === true) rows.push(['invalid', 'true']);
    if (asset.isDirectory === true) rows.push(['isDirectory', 'true']);
    if (asset.file) rows.push(['file', asset.file]);
    const subAssets = Object.keys(asset.subAssets || {}).length;
    if (subAssets) rows.push(['subAssets', String(subAssets)]);

    const width = rows.reduce((widest, row) => Math.max(widest, row[0].length), 0);
    return rows.map(([key, value]) => `${padRight(key, width)}  ${value}`).join('\n');
}

/**
 * Столбцы выравниваются пробелами, а не рамкой: список ассетов читают грепом, и рамка попадает в
 * каждую вытащенную строку.
 */
export function renderAssetList(assets: readonly AssetRecord[]): string {
    if (!assets.length) return 'ни одного ассета не подошло';
    const typeWidth = assets.reduce((widest, asset) => Math.max(widest, (asset.type || '').length), 0);
    return assets
        .map(asset => `${padRight(asset.type || '', typeWidth)}  ${
            asset.isDirectory === true ? `${asset.url}/` : asset.url}  ${asset.uuid}`)
        .join('\n');
}

export function assetListSummary(shown: number, total: number): string {
    return shown === total
        ? `ассетов: ${shown}`
        : `ассетов: ${total}, показано ${shown} — подними --max или сузь поиск`;
}

export interface SettleReport {
    /** Что редактору велели сделать, в прошедшем времени: «обновлено», «переимпортировано». */
    action: string;
    target: string;
    elapsedMs: number;
    settled: boolean;
    /** Провал самой операции, отдельный от «база не улеглась»: обещанного не произошло. */
    failure?: string;
    assets: AssetDiff;
    classes: ClassDiff | null;
}

const DEFAULT_LIST_CAP = 40;

function listed(urls: readonly string[], mark: string, cap: number): string[] {
    const shown = urls.slice(0, cap).map(url => `  ${mark} ${url}`);
    if (urls.length > cap) shown.push(`  ${mark} … и ещё ${urls.length - cap}`);
    return shown;
}

/**
 * Первое слово — вердикт: `refresh` и `reimport` возвращают управление до конца импорта, поэтому
 * «команда отработала» и «база доимпортировала» — разные новости, и вторая стоит в заголовке.
 */
export function renderSettleReport(report: SettleReport, cap: number = DEFAULT_LIST_CAP): string {
    const head = report.failure ? 'НЕ СДЕЛАНО' : report.settled ? 'ok' : 'НЕ УЛЕГЛОСЬ';
    const seconds = (report.elapsedMs / 1000).toFixed(1);
    const { added, removed, changed } = report.assets;
    const quiet = assetDiffEmpty(report.assets);

    const lines = [
        `${head}  ${report.target}  ${report.action} за ${seconds}с${quiet ? '  без изменений' : ''}`
    ];
    if (!quiet) {
        lines.push(`ассеты: +${added.length}  -${removed.length}  ~${changed.length}`);
        lines.push(...listed(added, '+', cap));
        lines.push(...listed(removed, '-', cap));
        lines.push(...listed(changed, '~', cap));
    }
    if (report.failure) lines.push(report.failure);
    if (report.classes && (report.classes.added.length || report.classes.removed.length)) {
        const marks = report.classes.added.map(name => `+${name}`)
            .concat(report.classes.removed.map(name => `-${name}`));
        lines.push(`классы компонентов: ${marks.join('  ')}`);
    }
    return lines.join('\n');
}

/**
 * `null` у классов значит, что сцена не ответила: молчание о дельте классов и пустая дельта — разные
 * ответы, и первый надо назвать, иначе «класс не появился» прочтут как «класс не изменился».
 */
export function settleNote(report: SettleReport, timeoutMs: number): string {
    if (!report.settled && !report.failure) {
        return `база ассетов не улеглась за ${(timeoutMs / 1000).toFixed(0)}с — импорт мог не закончиться`;
    }
    return report.classes === null
        ? 'сцена не ответила о зарегистрированных классах — их дельта неизвестна'
        : '';
}
