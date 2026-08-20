import type { Driver } from '@cocos-cli/shared';
import { Command } from 'commander';
import { settle } from '../settle.ts';
import { withClient } from './shared.ts';
import {
    ASSET_TYPES, assetQuery, commonAssetFolder, requireAssetUrl, selectAssets
} from '../asset/query.ts';
import type { AssetQuery, AssetRecord, AssetType } from '../asset/query.ts';
import {
    copiedAddress, diffAssets, diffClasses, fingerprintOf, settled, snapshotKey
} from '../asset/settle.ts';
import type { AssetReport, DbSnapshot, Sample } from '../asset/settle.ts';
import type { Report } from '../render/present.ts';
import type { Resolved } from '../resolve.ts';

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

async function queryAssets(client: Driver, query: AssetQuery): Promise<AssetRecord[]> {
    const found = await client.editor.assetDb.queryAssets(query).catch(() => []);
    return Array.isArray(found) ? found as AssetRecord[] : [];
}

async function queryOne(client: Driver, urlOrUuid: string): Promise<AssetRecord | null> {
    const info = await client.editor.assetDb.queryAssetInfo(urlOrUuid).catch(() => null);
    return info ? info as AssetRecord : null;
}

async function requireOne(client: Driver, urlOrUuid: string): Promise<AssetRecord> {
    const info = await queryOne(client, urlOrUuid);
    if (!info) throw new Error(`the asset database does not know '${urlOrUuid}'`);
    return info;
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
async function snapshot(client: Driver, url: string): Promise<DbSnapshot> {
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

interface Operation {
    /** What the editor was told to do, in the past tense. */
    action: string;
    /** The address the operation was aimed at. */
    target: string;
    /** The folder to wait on, which for a move covers both ends. */
    scope: string;
    /** Where the asset is once the database is quiet, asked of the database rather than assumed. */
    landing: (settled: AssetReport) => Promise<string | null> | string | null;
}

/**
 * The operation ran; this is the part that waits for the importer and then asks the database what
 * actually happened. Every asset command ends here, so `settled` is a real answer for all of them
 * rather than a constant for some.
 */
async function afterOperation(
    client: Driver, operation: Operation, before: DbSnapshot, options: WaitOptions
): Promise<AssetReport> {
    const outcome = await settleAssetDb(client, operation.scope, options);
    const report: AssetReport = {
        action: operation.action,
        target: operation.target,
        landedAt: null,
        elapsedMs: outcome.elapsedMs,
        settled: outcome.settled,
        assets: diffAssets(before.assets, outcome.final.assets),
        classes: diffClasses(before.classes, outcome.final.classes)
    };
    return { ...report, landedAt: await operation.landing(report) };
}

function outputOf(report: AssetReport, options: WaitOptions, extraNote?: string): Report {
    return { kind: 'asset', asset: report, timeoutMs: options.timeoutMs, note: extraNote };
}

/**
 * `move-asset`, `copy-asset`, `create-asset` and `delete-asset` answer with nothing on a successful
 * operation too — checked live: the move went through, the file landed in its new folder, the uuid
 * survived, and the answer was `null`. So their answer is never read: where the asset ended up is
 * asked of the database by its uuid.
 */
async function whereIs(client: Driver, uuid: string): Promise<string | null> {
    const url = await client.editor.assetDb.queryUrl(uuid).catch(() => null);
    return typeof url === 'string' && url ? url : null;
}

export async function assetRefresh(
    client: Driver, target: string, options: WaitOptions
): Promise<Report> {
    const url = requireAssetUrl(target, 'the folder to refresh');
    const before = await snapshot(client, url);
    await client.editor.assetDb.refreshAsset(url);
    return outputOf(await afterOperation(client, {
        action: 'refreshed', target: url, scope: url, landing: () => addressOf(client, url)
    }, before, options), options);
}

/** The address itself, when the database still knows it; a folder that vanished answers `null`. */
async function addressOf(client: Driver, url: string): Promise<string | null> {
    const found = await queryOne(client, url);
    return found ? found.url : null;
}

export async function assetReimport(
    client: Driver, target: string, options: WaitOptions
): Promise<Report> {
    const url = requireAssetUrl(target, 'the asset to reimport');
    if (!await queryOne(client, url)) {
        throw new Error(`the asset database does not know '${url}'; if the file appeared on disk past the `
            + `editor, run 'cocos asset refresh <folder>' first`);
    }
    const before = await snapshot(client, url);
    await client.editor.assetDb.reimportAsset(url);
    return outputOf(await afterOperation(client, {
        action: 'reimported', target: url, scope: url, landing: () => addressOf(client, url)
    }, before, options), options);
}

export async function assetMove(
    client: Driver, source: string, target: string,
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

    const settledReport = await afterOperation(client, {
        action: `moved from ${from}`, target: to, scope,
        landing: () => whereIs(client, moving.uuid)
    }, before, options);

    const report: AssetReport = settledReport.landedAt === null
        ? { ...settledReport, failure: `${from} is at no address in the database after the move` }
        : settledReport;
    return outputOf(report, options,
        'a uuid survives the move, and absolute db:// paths inside an importer .meta do not: '
            + 'materialDumpDir on a model with dumped materials keeps naming the old folder');
}

export async function assetGet(
    client: Driver, target: string, options: { field?: string }
): Promise<Report> {
    return { kind: 'assetInfo', asset: await requireOne(client, target), field: options.field };
}

export async function assetList(
    client: Driver, folder: string,
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

/**
 * The copy is a new asset the importer has not seen yet, so the wait is part of the command: without
 * it the next command against the copy is a race. Under the default rename-on-conflict the address
 * asked for can still hold the original, and the copy is then wherever the database gained one.
 */
export async function assetCopy(
    client: Driver, source: string, target: string,
    options: WaitOptions & { overwrite?: boolean }
): Promise<Report> {
    const from = requireAssetUrl(source, 'the source asset');
    const to = requireAssetUrl(target, 'the target address');
    await requireOne(client, from);

    const scope = commonAssetFolder(from, to);
    const before = await snapshot(client, scope);
    await client.editor.assetDb.copyAsset(from, to, {
        overwrite: options.overwrite === true, rename: options.overwrite !== true
    });

    const report = await afterOperation(client, {
        action: `copied from ${from}`, target: to, scope,
        landing: settledReport => copiedAddress(to, settledReport.assets.added)
    }, before, options);

    return outputOf(report.landedAt === null
        ? { ...report, failure: `no copy of ${from} appeared in the database` }
        : report, options);
}

export async function assetRemove(
    client: Driver, target: string, options: WaitOptions
): Promise<Report> {
    const url = requireAssetUrl(target, 'the asset to delete');
    const existing = await requireOne(client, url);
    const before = await snapshot(client, url);
    await client.editor.assetDb.deleteAsset(url);

    const report = await afterOperation(client, {
        action: `deleted ${existing.uuid}`, target: url, scope: url,
        landing: () => whereIs(client, existing.uuid)
    }, before, options);

    return outputOf(report.landedAt === null
        ? report
        : { ...report, failure: `${existing.uuid} is still at ${report.landedAt}` }, options);
}

export async function assetMkdir(
    client: Driver, folder: string, options: WaitOptions
): Promise<Report> {
    const url = requireAssetUrl(folder, 'the folder to create');
    const before = await snapshot(client, url);
    await client.editor.assetDb.createAsset(url, null);

    const report = await afterOperation(client, {
        action: 'created', target: url, scope: url, landing: () => addressOf(client, url)
    }, before, options);
    if (report.landedAt === null) {
        return outputOf({ ...report, failure: `${url} did not appear in the database` }, options);
    }
    const created = await queryOne(client, url);
    return outputOf(report, options,
        created && created.isDirectory === true ? undefined : `${url} is not a folder`);
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

    waitFlags(asset
        .command('cp <source> <target>')
        .description('copy an asset and wait for the import to finish; the copy is a new asset with '
            + 'a new uuid that nothing references')
        .option('--overwrite', 'replace a taken address instead of renaming'))
        .action((source: string, target: string, options: {
            overwrite?: boolean; timeout?: string; quietFor?: string
        }) => withClient(resolve, client => assetCopy(
            client, source, target, { ...waitOptions(options), overwrite: options.overwrite })));

    waitFlags(asset
        .command('rm <path>')
        .description('delete an asset or a whole folder and wait for the database to settle'))
        .action((target: string, options: { timeout?: string; quietFor?: string }) =>
            withClient(resolve, client => assetRemove(client, target, waitOptions(options))));

    waitFlags(asset
        .command('mkdir <folder>')
        .description('create a folder in the asset database and wait for it to be imported'))
        .action((folder: string, options: { timeout?: string; quietFor?: string }) =>
            withClient(resolve, client => assetMkdir(client, folder, waitOptions(options))));

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
