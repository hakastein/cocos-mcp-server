import type { Driver } from '@cocos-cli/shared';
import { settle } from '../settle.ts';
import { assetQuery } from './query.ts';
import type { AssetQuery, AssetRecord } from './query.ts';
import { fingerprintOf, snapshotKey, settled } from './settle.ts';
import type { DbSnapshot, Sample } from './settle.ts';

export interface WaitOptions {
    timeoutMs: number;
    quietForMs: number;
    intervalMs: number;
    now: () => number;
}

export async function queryAssets(client: Driver, query: AssetQuery): Promise<AssetRecord[]> {
    const found = await client.editor.assetDb.queryAssets(query).catch(() => []);
    return Array.isArray(found) ? found as AssetRecord[] : [];
}

export async function queryOne(client: Driver, urlOrUuid: string): Promise<AssetRecord | null> {
    const info = await client.editor.assetDb.queryAssetInfo(urlOrUuid).catch(() => null);
    return info ? info as AssetRecord : null;
}

export async function requireOne(client: Driver, urlOrUuid: string): Promise<AssetRecord> {
    const info = await queryOne(client, urlOrUuid);
    if (!info) throw new Error(`the asset database does not know '${urlOrUuid}'`);
    return info;
}

/** The address itself, when the database still knows it; a folder that vanished answers `null`. */
export async function addressOf(client: Driver, url: string): Promise<string | null> {
    const found = await queryOne(client, url);
    return found ? found.url : null;
}

/**
 * `move-asset`, `copy-asset`, `create-asset` and `delete-asset` answer with nothing on a successful
 * operation too — checked live: the move went through, the file landed in its new folder, the uuid
 * survived, and the answer was `null`. So their answer is never read: where the asset ended up is
 * asked of the database by its uuid.
 */
export async function whereIs(client: Driver, uuid: string): Promise<string | null> {
    const url = await client.editor.assetDb.queryUrl(uuid).catch(() => null);
    return typeof url === 'string' && url ? url : null;
}

/**
 * The classes the editor currently registers components under. This is the answer to `did the editor
 * notice the new @ccclass` — the question a `refresh` is run for, while a files-only report talks
 * about the disk when the class was what was asked about.
 */
async function registeredClasses(client: Driver): Promise<string[] | null> {
    const components = await client.editor.scene.queryComponents().catch(() => null);
    if (!Array.isArray(components)) return null;
    return (components as Array<{ name?: string }>)
        .map(component => component.name || '')
        .filter(name => name !== '');
}

/**
 * The fingerprint is taken both of the address itself and of the tree under it, so a folder the
 * database does not know yet does not disturb the wait: before the `refresh` it is simply absent
 * from both halves.
 */
export async function snapshot(client: Driver, url: string): Promise<DbSnapshot> {
    const under = await queryAssets(client, assetQuery(url, 'all'));
    const self = await queryOne(client, url);
    const byUuid = new Map<string, AssetRecord>();
    for (const asset of self ? [self, ...under] : under) byUuid.set(asset.uuid, asset);
    return {
        assets: Array.from(byUuid.values()).map(fingerprintOf),
        classes: await registeredClasses(client)
    };
}

export interface SettleOutcome {
    settled: boolean;
    elapsedMs: number;
    final: DbSnapshot;
}

/**
 * `refresh-asset` and `reimport-asset` return before the import finishes — on this project some
 * eight seconds before it — so the waiting lives here rather than in the caller.
 */
export async function settleAssetDb(
    client: Driver, url: string, options: WaitOptions
): Promise<SettleOutcome> {
    const started = options.now();
    const samples: Sample[] = [];
    let final = await snapshot(client, url);

    const reached = await settle(async () => {
        const ready = await client.editor.assetDb.queryReady().catch(() => false);
        final = await snapshot(client, url);
        samples.push({ key: snapshotKey(final), ready: ready === true, at: options.now() });
        return settled(samples, options.quietForMs);
    }, { timeoutMs: options.timeoutMs, intervalMs: options.intervalMs });

    return { settled: reached, elapsedMs: options.now() - started, final };
}
