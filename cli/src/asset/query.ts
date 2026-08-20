/**
 * What `asset-db:query-assets` and `asset-db:query-asset-info` answer, narrowed to the fields the
 * CLI reads. The `client.editor` facade is untyped, and pulling the editor's typings package into
 * `cli` for one interface would add an undeclared dependency.
 */
export interface AssetRecord {
    name: string;
    uuid: string;
    url: string;
    type: string;
    importer?: string;
    imported?: boolean;
    invalid?: boolean;
    isDirectory?: boolean;
    file?: string;
    mtime?: number;
    subAssets?: Record<string, unknown>;
}

export interface AssetQuery {
    pattern: string;
    ccType?: string;
}

export const ASSET_TYPES = [
    'all', 'scene', 'prefab', 'script', 'texture', 'material', 'mesh', 'audio', 'animation', 'spriteFrame'
] as const;

export type AssetType = typeof ASSET_TYPES[number];

interface TypeFilter {
    extension?: string;
    ccType?: string;
}

/**
 * A type with no key at all would glob the whole folder — which is how `spriteFrame` behaved while
 * it was missing from this table: the entire project came back as sprite frames.
 */
const TYPE_FILTERS: Record<AssetType, TypeFilter> = {
    all: {},
    scene: { extension: '.scene' },
    prefab: { extension: '.prefab' },
    script: { extension: '.{ts,js}' },
    texture: { extension: '.{png,jpg,jpeg,gif,tga,bmp,psd}' },
    material: { extension: '.mtl' },
    mesh: { extension: '.{fbx,obj,dae}' },
    audio: { extension: '.{mp3,ogg,wav,m4a}' },
    animation: { extension: '.{anim,clip}' },
    spriteFrame: { ccType: 'cc.SpriteFrame' }
};

export function assetQuery(folder: string, type: AssetType): AssetQuery {
    const filter = TYPE_FILTERS[type];
    if (!filter) {
        throw new Error(`asset type '${type}' has no filter; the known ones: ${ASSET_TYPES.join(', ')}`);
    }
    const root = String(folder).trim().replace(/\/+$/, '');
    const query: AssetQuery = { pattern: `${root}/**/*${filter.extension ?? ''}` };
    if (filter.ccType) query.ccType = filter.ccType;
    return query;
}

export interface AssetSelection<T> {
    assets: T[];
    total: number;
    truncated: boolean;
}

export interface AssetSelectOptions {
    name?: string;
    exactMatch?: boolean;
    maxResults?: number;
}

export function matchesAssetName(assetName: string, query: string, exactMatch: boolean): boolean {
    return exactMatch
        ? assetName === query
        : String(assetName).toLowerCase().includes(query.toLowerCase());
}

/**
 * `total` is counted before the cut, so a truncated listing does not pass itself off as the whole set.
 */
export function selectAssets<T extends { name: string }>(
    assets: readonly T[],
    options: AssetSelectOptions = {}
): AssetSelection<T> {
    const query = options.name;
    const matched = query === undefined || query === ''
        ? assets.slice()
        : assets.filter(asset => matchesAssetName(asset.name, query, options.exactMatch === true));
    const limit = options.maxResults;
    const cut = limit !== undefined && limit >= 0 && matched.length > limit
        ? matched.slice(0, limit)
        : matched;
    return { assets: cut, total: matched.length, truncated: cut.length < matched.length };
}

const ASSET_URL_PREFIX = 'db://';

export function isAssetUrl(text: string): boolean {
    return text.indexOf(ASSET_URL_PREFIX) === 0;
}

/**
 * The asset database calls `.startsWith` on whatever it is handed, so a non-`db://` value surfaces
 * as a bare TypeError that names no argument. The refusal here names it.
 */
export function requireAssetUrl(text: string, what: string): string {
    const rest = isAssetUrl(text) ? text.slice(ASSET_URL_PREFIX.length).replace(/\/+$/, '') : '';
    if (!rest) {
        throw new Error(`${what} is spelled as a db:// url (for example db://assets/scripts/foo.ts); got ${
            JSON.stringify(text)}`);
    }
    return ASSET_URL_PREFIX + rest;
}

/**
 * The folder covering both addresses is the scope worth waiting on after a move: the importer's work
 * falls on the source branch and on the target one alike.
 */
export function commonAssetFolder(source: string, target: string): string {
    const left = source.split('/');
    const right = target.split('/');
    const shared: string[] = [];
    // The last segment is the asset's own name, which is never a folder.
    const limit = Math.min(left.length, right.length) - 1;
    for (let index = 0; index < limit; index++) {
        if (left[index] !== right[index]) break;
        shared.push(left[index]);
    }
    return shared.length >= 3 ? shared.join('/') : 'db://assets';
}
