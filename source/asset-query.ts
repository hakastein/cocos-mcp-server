import type { QueryAssetsOption } from '@cocos/creator-types/editor/packages/asset-db/@types/public';

export const ASSET_TYPES = [
    'all', 'scene', 'prefab', 'script', 'texture', 'material', 'mesh', 'audio', 'animation', 'spriteFrame'
] as const;

export type AssetType = typeof ASSET_TYPES[number];

interface TypeFilter {
    extension?: string;
    ccType?: string;
}

/**
 * A type with neither key would glob the whole folder, which is what `spriteFrame` did while
 * being absent from the table: every asset in the project came back as a sprite frame.
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

export function assetQuery(folder: string, type: AssetType): QueryAssetsOption {
    const filter = TYPE_FILTERS[type];
    if (!filter) {
        throw new Error(`asset type '${type}' has no filter; known types: ${ASSET_TYPES.join(', ')}`);
    }
    const root = String(folder).trim().replace(/\/+$/, '');
    const query: QueryAssetsOption = { pattern: `${root}/**/*${filter.extension ?? ''}` };
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

export function selectAssets<T extends { name: string }>(
    assets: T[],
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
