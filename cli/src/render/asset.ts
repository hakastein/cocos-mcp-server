import { columnWidth, padRight } from './columns.ts';
import type { AssetRecord } from '../asset/query.ts';
import type { AssetReport } from '../asset/settle.ts';
import { assetDiffEmpty } from '../asset/settle.ts';
import type { Verdict } from './verdict.ts';

export const ASSET_FIELDS = [
    'name', 'type', 'uuid', 'url', 'importer', 'imported', 'invalid', 'isDirectory', 'file', 'subAssets'
] as const;

export type AssetField = typeof ASSET_FIELDS[number];

/** One value on stdout — what a shell variable takes. */
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
            throw new Error(`asset has no field '${field}'; it has: ${ASSET_FIELDS.join(', ')}`);
    }
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

export function renderAssetList(assets: readonly AssetRecord[]): string {
    if (!assets.length) return 'no asset matched';
    const typeWidth = assets.reduce((widest, asset) => Math.max(widest, (asset.type || '').length), 0);
    return assets
        .map(asset => `${padRight(asset.type || '', typeWidth)}  ${
            asset.isDirectory === true ? `${asset.url}/` : asset.url}  ${asset.uuid}`)
        .join('\n');
}

export function assetListSummary(shown: number, total: number): string {
    return shown === total
        ? `assets: ${shown}`
        : `assets: ${total}, showing ${shown} — raise --max or narrow the search`;
}

const DEFAULT_LIST_CAP = 40;

function listed(urls: readonly string[], mark: string, cap: number): string[] {
    const shown = urls.slice(0, cap).map(url => `  ${mark} ${url}`);
    if (urls.length > cap) shown.push(`  ${mark} … and ${urls.length - cap} more`);
    return shown;
}

/**
 * `refresh` and `reimport` return before the import finishes, so `the command ran` and `the database
 * finished importing` are two different pieces of news, and the second decides the verdict.
 */
export function assetVerdict(report: AssetReport): Verdict {
    if (report.failure) return 'FAILED';
    return report.settled ? 'ok' : 'TIMEOUT';
}

export function renderAssetReport(report: AssetReport, cap: number = DEFAULT_LIST_CAP): string {
    const head = assetVerdict(report);
    const seconds = (report.elapsedMs / 1000).toFixed(1);
    const { added, removed, changed } = report.assets;
    const quiet = assetDiffEmpty(report.assets);
    const elsewhere = report.landedAt !== null && report.landedAt !== report.target
        ? `  landed at ${report.landedAt}`
        : '';

    const lines = [
        `${head}  ${report.target}  ${report.action} in ${seconds}s${elsewhere}${quiet ? '  no changes' : ''}`
    ];
    if (!quiet) {
        lines.push(`assets: +${added.length}  -${removed.length}  ~${changed.length}`);
        lines.push(...listed(added, '+', cap));
        lines.push(...listed(removed, '-', cap));
        lines.push(...listed(changed, '~', cap));
    }
    if (report.failure) lines.push(report.failure);
    if (report.classes && (report.classes.added.length || report.classes.removed.length)) {
        const marks = report.classes.added.map(name => `+${name}`)
            .concat(report.classes.removed.map(name => `-${name}`));
        lines.push(`component classes: ${marks.join('  ')}`);
    }
    return lines.join('\n');
}

/**
 * `null` for classes means the scene did not answer: silence about the class delta and an empty
 * delta are different answers, and the first has to be named — otherwise `the class never showed up`
 * reads as `the class did not change`.
 */
export function assetNote(report: AssetReport, timeoutMs: number): string {
    if (!report.settled && !report.failure) {
        return `asset database did not go quiet in ${(timeoutMs / 1000).toFixed(0)}s — the import may still be running`;
    }
    return report.classes === null
        ? 'the scene did not answer about registered classes — their delta is unknown'
        : '';
}

/** A node of the open scene that depends on an asset, whether by instance or by a component field. */
export interface AssetUser {
    /** `null` when the scene dump did not name the uuid: the node still counts as a user. */
    path: string | null;
    uuid: string;
}

export interface AssetUsers {
    asset: string;
    nodes: AssetUser[];
}

export function renderAssetUsers(report: AssetUsers): string {
    if (!report.nodes.length) return `no node in the scene uses ${report.asset}`;
    const rows = report.nodes.map(node => [node.path || UNNAMED_PATH, node.uuid]);
    const width = columnWidth(rows, 0);
    return rows.map(row => `${padRight(row[0], width)}  ${row[1]}`).join('\n');
}

const UNNAMED_PATH = '(path unknown)';

export function assetUsersSummary(report: AssetUsers): string {
    return `${report.asset}  nodes: ${report.nodes.length}`;
}
