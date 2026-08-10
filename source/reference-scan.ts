import { decompressUuid } from './prefab-json';

export interface ReferenceSite {
    ref: string;
    where: string;
}

export interface DbPathSite {
    where: string;
    path: string;
}

export interface ModelMetaScan {
    refs: ReferenceSite[];
    dbPaths: DbPathSite[];
    dumpMaterials: boolean;
}

const DASHED_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ASSET_REF = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(@[0-9a-zA-Z]+)?$/;
const PACKED_CID = /^[0-9a-f]{5}[0-9a-zA-Z+/]{18}$/;

const META_REF_FIELDS = [
    /^userData\.assetFinder\.(materials|textures)\[\d+\]$/,
    /^userData\.imageMetas\[\d+\]\.uri$/,
    /\.imageUuidOrDatabaseUri$/
];

function unpackScriptUuid(type: unknown): string | null {
    if (typeof type !== 'string' || !PACKED_CID.test(type)) return null;
    const uuid = decompressUuid(type);
    return DASHED_UUID.test(uuid) ? uuid : null;
}

function join(where: string, key: string): string {
    return where ? `${where}.${key}` : key;
}

class SiteSet {
    private readonly seen = new Set<string>();
    readonly sites: ReferenceSite[] = [];

    add(ref: string, where: string): void {
        if (this.seen.has(ref)) return;
        this.seen.add(ref);
        this.sites.push({ ref, where });
    }
}

export function scanReferenceSites(assetJson: unknown): ReferenceSite[] {
    const found = new SiteSet();
    const walk = (value: unknown, where: string): void => {
        if (Array.isArray(value)) {
            value.forEach((item, index) => walk(item, `${where}[${index}]`));
            return;
        }
        if (!value || typeof value !== 'object') return;
        const record = value as Record<string, unknown>;
        for (const key of Object.keys(record)) {
            const child = record[key];
            const at = join(where, key);
            if (key === '__uuid__') {
                if (typeof child === 'string' && child.trim() !== '') found.add(child, at);
                continue;
            }
            if (key === '__type__') {
                const script = unpackScriptUuid(child);
                if (script) found.add(script, at);
                continue;
            }
            walk(child, at);
        }
    };
    walk(assetJson, '');
    return found.sites;
}

export function scanReferences(assetJson: unknown): string[] {
    return scanReferenceSites(assetJson).map(site => site.ref);
}

export function baseUuidOf(ref: string): string {
    const at = ref.indexOf('@');
    return at < 0 ? ref : ref.slice(0, at);
}

export function subIdOf(ref: string): string | null {
    const at = ref.indexOf('@');
    return at < 0 ? null : ref.slice(at + 1);
}

export function findBroken(refs: string[], known: Set<string>): string[] {
    const broken: string[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        if (known.has(ref)) continue;
        broken.push(ref);
    }
    return broken;
}

export function findMissingSubAssets(refs: string[], subAssetsByBase: Map<string, Set<string>>): string[] {
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        const sub = subIdOf(ref);
        if (!sub) continue;
        const known = subAssetsByBase.get(baseUuidOf(ref));
        if (!known || known.size === 0) continue;
        if (!known.has(sub)) missing.push(ref);
    }
    return missing;
}

export function scanModelMeta(meta: unknown): ModelMetaScan {
    const refs = new SiteSet();
    const dbPaths: DbPathSite[] = [];
    const walk = (value: unknown, where: string): void => {
        if (Array.isArray(value)) {
            value.forEach((item, index) => walk(item, `${where}[${index}]`));
            return;
        }
        if (typeof value === 'string') {
            if (value.startsWith('db://')) {
                dbPaths.push({ where, path: value });
            } else if (ASSET_REF.test(value) && META_REF_FIELDS.some(field => field.test(where))) {
                refs.add(value, where);
            }
            return;
        }
        if (!value || typeof value !== 'object') return;
        const record = value as Record<string, unknown>;
        for (const key of Object.keys(record)) walk(record[key], join(where, key));
    };
    walk(meta, '');

    const userData = (meta && typeof meta === 'object' ? (meta as any).userData : null) || {};
    return { refs: refs.sites, dbPaths, dumpMaterials: userData.dumpMaterials === true };
}
