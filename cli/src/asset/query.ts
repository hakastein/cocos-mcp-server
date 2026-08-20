/**
 * Что отвечают `asset-db:query-assets` и `asset-db:query-asset-info`, сужённое до полей, которые
 * читает CLI. Фасад `client.editor` не типизирован, а тянуть в `cli` пакет типов редактора ради
 * одного интерфейса — заводить незаявленную зависимость.
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
 * Тип без единого ключа сглобил бы всю папку — так и вело себя `spriteFrame`, пока его не было в
 * таблице: спрайт-фреймами возвращался весь проект.
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
        throw new Error(`тип ассета '${type}' не имеет фильтра; известные: ${ASSET_TYPES.join(', ')}`);
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
 * `total` считается до среза, поэтому урезанный список не выдаёт себя за весь набор.
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
 * База ассетов зовёт `.startsWith` на том, что ей дали, поэтому не-db:// значение всплывает голым
 * TypeError, не называющим аргумент. Отказ здесь называет.
 */
export function requireAssetUrl(text: string, what: string): string {
    const rest = isAssetUrl(text) ? text.slice(ASSET_URL_PREFIX.length).replace(/\/+$/, '') : '';
    if (!rest) {
        throw new Error(`${what} задаётся db://-путём (например db://assets/scripts/foo.ts); получено ${
            JSON.stringify(text)}`);
    }
    return ASSET_URL_PREFIX + rest;
}

/**
 * Папка, накрывающая оба адреса, — область, по которой имеет смысл ждать импорт после переноса:
 * работа импортёра ложится и на исходную ветку, и на целевую.
 */
export function commonAssetFolder(source: string, target: string): string {
    const left = source.split('/');
    const right = target.split('/');
    const shared: string[] = [];
    // Последний сегмент — имя самого ассета, папкой он не бывает.
    const limit = Math.min(left.length, right.length) - 1;
    for (let index = 0; index < limit; index++) {
        if (left[index] !== right[index]) break;
        shared.push(left[index]);
    }
    return shared.length >= 3 ? shared.join('/') : 'db://assets';
}
