import { Command } from 'commander';
import { settle } from '../settle';
import { withClient } from './shared';
import {
    ASSET_TYPES, assetQuery, commonAssetFolder, requireAssetUrl, selectAssets
} from '../asset/query';
import type { AssetQuery, AssetRecord, AssetType } from '../asset/query';
import { diffAssets, diffClasses, fingerprintOf, settled, snapshotKey } from '../asset/settle';
import type { DbSnapshot, Sample } from '../asset/settle';
import type { Report, SettleReport } from '../render/present';
import type { DriverClient } from '../driver-client';
import type { Resolved } from '../resolve';

const DEFAULT_FOLDER = 'db://assets';
const DEFAULT_MAX_RESULTS = 200;

const WAIT = {
    timeoutMs: 60000,
    quietForMs: 1500,
    intervalMs: 400
};

export interface WaitOptions {
    timeoutMs: number;
    quietForMs: number;
    intervalMs: number;
    now: () => number;
}

function waitOptions(options: { timeout?: string; quietFor?: string }): WaitOptions {
    return {
        timeoutMs: options.timeout === undefined ? WAIT.timeoutMs : Number(options.timeout) * 1000,
        quietForMs: options.quietFor === undefined ? WAIT.quietForMs : Number(options.quietFor),
        intervalMs: WAIT.intervalMs,
        now: () => Date.now()
    };
}

async function queryAssets(client: DriverClient, query: AssetQuery): Promise<AssetRecord[]> {
    const found = await client.editor.assetDb.queryAssets(query).catch(() => []);
    return Array.isArray(found) ? found as AssetRecord[] : [];
}

async function queryOne(client: DriverClient, urlOrUuid: string): Promise<AssetRecord | null> {
    const info = await client.editor.assetDb.queryAssetInfo(urlOrUuid).catch(() => null);
    return info ? info as AssetRecord : null;
}

async function requireOne(client: DriverClient, urlOrUuid: string): Promise<AssetRecord> {
    const info = await queryOne(client, urlOrUuid);
    if (!info) throw new Error(`the asset database does not know '${urlOrUuid}'`);
    return info;
}

/**
 * The classes the editor currently registers components under. This is the answer to `did the editor
 * notice the new @ccclass` — the question a `refresh` is run for, while a files-only report talks
 * about the disk when the class was what was asked about.
 */
async function registeredClasses(client: DriverClient): Promise<string[] | null> {
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
async function snapshot(client: DriverClient, url: string): Promise<DbSnapshot> {
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
async function settleAssetDb(
    client: DriverClient, url: string, options: WaitOptions
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

async function settleAndDiff(
    client: DriverClient, action: string, target: string, scope: string,
    before: DbSnapshot, options: WaitOptions
): Promise<SettleReport> {
    const outcome = await settleAssetDb(client, scope, options);
    return {
        action,
        target,
        elapsedMs: outcome.elapsedMs,
        settled: outcome.settled,
        assets: diffAssets(before.assets, outcome.final.assets),
        classes: diffClasses(before.classes, outcome.final.classes)
    };
}

function outputOf(report: SettleReport, options: WaitOptions, extraNote?: string): Report {
    return { kind: 'assetSettle', settle: report, timeoutMs: options.timeoutMs, note: extraNote };
}

/**
 * `move-asset`, `copy-asset`, `create-asset` and `delete-asset` answer with nothing on a successful
 * operation too — checked live: the move went through, the file landed in its new folder, the uuid
 * survived, and the answer was `null`. So their answer is never read: where the asset ended up is
 * asked of the database by its uuid.
 */
async function whereIs(client: DriverClient, uuid: string): Promise<string | null> {
    const url = await client.editor.assetDb.queryUrl(uuid).catch(() => null);
    return typeof url === 'string' && url ? url : null;
}

export async function assetRefresh(
    client: DriverClient, target: string, options: WaitOptions
): Promise<Report> {
    const url = requireAssetUrl(target, 'the folder to refresh');
    const before = await snapshot(client, url);
    await client.editor.assetDb.refreshAsset(url);
    return outputOf(await settleAndDiff(client, 'refreshed', url, url, before, options), options);
}

export async function assetReimport(
    client: DriverClient, target: string, options: WaitOptions
): Promise<Report> {
    const url = requireAssetUrl(target, 'the asset to reimport');
    if (!await queryOne(client, url)) {
        throw new Error(`the asset database does not know '${url}'; if the file appeared on disk past the `
            + `editor, run 'cocos asset refresh <folder>' first`);
    }
    const before = await snapshot(client, url);
    await client.editor.assetDb.reimportAsset(url);
    return outputOf(
        await settleAndDiff(client, 'reimported', url, url, before, options), options);
}

export async function assetMove(
    client: DriverClient, source: string, target: string,
    options: WaitOptions & { overwrite?: boolean }
): Promise<Report> {
    const from = requireAssetUrl(source, 'the source asset');
    const to = requireAssetUrl(target, 'the target address');
    const moving = await requireOne(client, from);

    const scope = commonAssetFolder(from, to);
    const before = await snapshot(client, scope);
    await client.editor.assetDb.moveAsset(from, to, {
        overwrite: options.overwrite === true, rename: options.overwrite !== true
    });

    const report = await settleAndDiff(client, 'moved', `${from} → ${to}`, scope, before, options);
    const landed = await whereIs(client, moving.uuid);
    if (landed === null) {
        report.failure = `${from} is at no address in the database after the move`;
    } else if (landed !== to) {
        report.target = `${from} → ${landed}`;
        report.failure = landed === from
            ? `${from} stayed where it was — ${to} is taken and --overwrite was not passed`
            : undefined;
    }
    return outputOf(report, options,
        'a uuid survives the move, and absolute db:// paths inside an importer .meta do not: '
            + 'materialDumpDir on a model with dumped materials keeps naming the old folder');
}

export async function assetGet(
    client: DriverClient, target: string, options: { field?: string }
): Promise<Report> {
    return { kind: 'assetInfo', asset: await requireOne(client, target), field: options.field };
}

export async function assetList(
    client: DriverClient, folder: string,
    options: { type?: string; name?: string; exact?: boolean; max?: string }
): Promise<Report> {
    const root = requireAssetUrl(folder, 'the folder to search');
    const type = (options.type || 'all') as AssetType;
    if (ASSET_TYPES.indexOf(type) === -1) {
        throw new Error(`asset type '${type}' is not known; the known ones: ${ASSET_TYPES.join(', ')}`);
    }
    const maxResults = options.max === undefined ? DEFAULT_MAX_RESULTS : Number(options.max);
    const selection = selectAssets(await queryAssets(client, assetQuery(root, type)), {
        name: options.name, exactMatch: options.exact === true, maxResults
    });
    return { kind: 'assetList', assets: selection.assets, total: selection.total };
}

export function registerAsset(program: Command, resolve: () => Promise<Resolved>): void {
    const asset = program.command('asset').description('the asset database of the project');

    const waitFlags = (command: Command): Command => command
        .option('--timeout <seconds>',
            `how long to wait for the database to go quiet (default ${WAIT.timeoutMs / 1000})`)
        .option('--quiet-for <ms>',
            `how long the database fingerprint must hold unchanged (default ${WAIT.quietForMs})`);

    asset
        .command('get <path>')
        .description('uuid, type, url and importer of an asset, by db:// url or uuid')
        .option('--field <name>', 'print one field as a bare value')
        .option('--json', 'print the structural form instead of text')
        .action((target: string, options: { field?: string; json?: boolean }) =>
            withClient(resolve, client => assetGet(client, target, options), { json: options.json }));

    asset
        .command('ls [folder]')
        .description('list the assets under a folder')
        .option('--type <type>', `narrow by type: ${ASSET_TYPES.join(', ')}`)
        .option('--name <substring>', 'narrow by name')
        .option('--exact', 'match the name exactly instead of as a substring')
        .option('--max <n>',
            `cap on the listing (default ${DEFAULT_MAX_RESULTS}); the summary still names the full count`)
        .option('--json', 'print the structural form instead of text')
        .action((folder: string | undefined, options: {
            type?: string; name?: string; exact?: boolean; max?: string; json?: boolean
        }) => withClient(
            resolve, client => assetList(client, folder || DEFAULT_FOLDER, options),
            { json: options.json }));

    waitFlags(asset
        .command('refresh <folder>')
        .description('rescan a folder and wait for the import to finish — this is what carries an edit '
            + 'made past the editor into the project'))
        .action((folder: string, options: { timeout?: string; quietFor?: string }) =>
            withClient(resolve, client => assetRefresh(client, folder, waitOptions(options))));

    waitFlags(asset
        .command('reimport <path>')
        .description('rerun the importer on one asset and wait for it to finish'))
        .action((target: string, options: { timeout?: string; quietFor?: string }) =>
            withClient(resolve, client => assetReimport(client, target, waitOptions(options))));

    waitFlags(asset
        .command('mv <source> <target>')
        .description('move or rename an asset; the uuid survives and references stay intact')
        .option('--overwrite', 'replace a taken address instead of renaming'))
        .action((source: string, target: string, options: {
            overwrite?: boolean; timeout?: string; quietFor?: string
        }) => withClient(resolve, client => assetMove(
            client, source, target, { ...waitOptions(options), overwrite: options.overwrite })));

    asset
        .command('cp <source> <target>')
        .description('copy an asset; the copy is a new asset with a new uuid that nothing references')
        .option('--overwrite', 'replace a taken address instead of renaming')
        .action((source: string, target: string, options: { overwrite?: boolean }) =>
            withClient(resolve, async client => {
                const from = requireAssetUrl(source, 'the source asset');
                const to = requireAssetUrl(target, 'the target address');
                const original = await requireOne(client, from);
                await client.editor.assetDb.copyAsset(from, to, {
                    overwrite: options.overwrite === true, rename: options.overwrite !== true
                });
                const landed = await queryOne(client, to);
                if (!landed) {
                    return {
                        kind: 'action',
                        verdict: 'FAILED',
                        summary: `${to} did not appear in the database after the copy`
                    };
                }
                if (landed.uuid === original.uuid) {
                    return {
                        kind: 'action',
                        verdict: 'FAILED',
                        summary: `${to} holds ${from} itself, and there is no copy`
                    };
                }
                return {
                    kind: 'action',
                    verdict: 'ok',
                    summary: `copied to ${landed.url}  ${landed.uuid}`
                };
            }));

    asset
        .command('rm <path>')
        .description('delete an asset or a whole folder')
        .action((target: string) => withClient(resolve, async client => {
            const url = requireAssetUrl(target, 'the asset to delete');
            const existing = await requireOne(client, url);
            await client.editor.assetDb.deleteAsset(url);
            const stillThere = await whereIs(client, existing.uuid);
            if (stillThere !== null) {
                return {
                    kind: 'action',
                    verdict: 'FAILED',
                    summary: `${existing.uuid} is still at ${stillThere}`
                };
            }
            return {
                kind: 'action', verdict: 'ok', summary: `deleted ${url}  ${existing.uuid}`
            };
        }));

    asset
        .command('mkdir <folder>')
        .description('create a folder in the asset database')
        .action((folder: string) => withClient(resolve, async client => {
            const url = requireAssetUrl(folder, 'the folder to create');
            await client.editor.assetDb.createAsset(url, null);
            const created = await queryOne(client, url);
            if (!created) {
                return { kind: 'action', verdict: 'FAILED', summary: `${url} did not appear in the database` };
            }
            return {
                kind: 'action',
                verdict: 'ok',
                summary: `created ${created.url}  ${created.uuid}`,
                note: created.isDirectory === true ? undefined : `${url} is not a folder`
            };
        }));

    asset
        .command('ready')
        .description('whether the asset database finished starting up — anything read before that is about a half-imported project')
        .action(() => withClient(resolve, async client => {
            const ready = await client.editor.assetDb.queryReady();
            return ready === true
                ? { kind: 'action', verdict: 'ok', summary: 'the asset database is ready' }
                : { kind: 'action', verdict: 'FAILED', summary: 'the asset database is not ready yet' };
        }));
}
