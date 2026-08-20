import type { AssetRecord } from '../asset/query.ts';

export interface CopyOptions {
    overwrite?: boolean;
    rename?: boolean;
}

/**
 * The asset database of `MemoryDriver`, held as data so a command reads back what it wrote. The
 * editor's own operations answer `null` on success, so what happened is asked of the database
 * afterwards — which only works against a database that actually moved.
 */
export class MemoryAssetDb {
    private readonly byUrl = new Map<string, AssetRecord>();
    private clock = 1;

    constructor(assets: Record<string, string>) {
        for (const [url, uuid] of Object.entries(assets)) this.byUrl.set(url, this.record(url, uuid));
    }

    find(urlOrUuid: string): AssetRecord | null {
        const byUrl = this.byUrl.get(urlOrUuid);
        if (byUrl) return byUrl;
        for (const asset of this.byUrl.values()) if (asset.uuid === urlOrUuid) return asset;
        return null;
    }

    urlOf(uuid: string): string | undefined {
        const found = this.find(uuid);
        return found ? found.url : undefined;
    }

    uuidOf(url: string): string | undefined {
        const found = this.byUrl.get(url);
        return found ? found.uuid : undefined;
    }

    /** The `${root}/**\/*${extension}` glob `assetQuery` builds, matched on the url alone. */
    under(pattern: string): AssetRecord[] {
        const split = pattern.indexOf('/**/*');
        if (split < 0) return [];
        const root = pattern.slice(0, split);
        const extension = pattern.slice(split + '/**/*'.length);
        const plain = extension && !extension.includes('{') ? extension : '';
        return Array.from(this.byUrl.values())
            .filter(asset => asset.url.startsWith(`${root}/`))
            .filter(asset => !plain || asset.url.endsWith(plain));
    }

    move(from: string, to: string, options: CopyOptions): void {
        const moving = this.byUrl.get(from);
        if (!moving) return;
        const landing = this.free(to, options);
        if (landing === null) return;
        this.byUrl.delete(from);
        this.byUrl.set(landing, { ...moving, ...this.record(landing, moving.uuid) });
    }

    copy(from: string, to: string, options: CopyOptions): void {
        const original = this.byUrl.get(from);
        if (!original) return;
        const landing = this.free(to, options);
        if (landing === null) return;
        this.byUrl.set(landing, this.record(landing, `${original.uuid}-copy${this.clock++}`));
    }

    create(url: string): void {
        if (this.byUrl.has(url)) return;
        this.byUrl.set(url, this.record(url, `uuid-${this.clock++}`));
    }

    remove(url: string): void {
        for (const key of Array.from(this.byUrl.keys())) {
            if (key === url || key.startsWith(`${url}/`)) this.byUrl.delete(key);
        }
    }

    /**
     * The address an operation actually gets: the one asked for when it is free, a suffixed one
     * under the default rename-on-conflict, and `null` when a taken address may be neither replaced
     * nor renamed around.
     */
    private free(url: string, options: CopyOptions): string | null {
        if (!this.byUrl.has(url)) return url;
        if (options.overwrite === true) return url;
        if (options.rename !== true) return null;

        const dot = url.lastIndexOf('.');
        const stem = dot > url.lastIndexOf('/') ? url.slice(0, dot) : url;
        const extension = dot > url.lastIndexOf('/') ? url.slice(dot) : '';
        for (let nth = 1; ; nth++) {
            const candidate = `${stem}-${String(nth).padStart(3, '0')}${extension}`;
            if (!this.byUrl.has(candidate)) return candidate;
        }
    }

    private record(url: string, uuid: string): AssetRecord {
        const name = url.slice(url.lastIndexOf('/') + 1);
        const dot = name.lastIndexOf('.');
        return {
            name,
            uuid,
            url,
            type: dot > 0 ? assetType(name.slice(dot + 1)) : 'cc.Asset',
            imported: true,
            isDirectory: dot <= 0,
            mtime: this.clock++
        };
    }
}

/** The editor names a prefab `cc.Prefab`; the extension it is spelled with is lower case. */
function assetType(extension: string): string {
    return extension.toLowerCase() === 'prefab'
        ? 'cc.Prefab'
        : `cc.${extension}`;
}
