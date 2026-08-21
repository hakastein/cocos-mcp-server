import type { Driver } from '@cocos-cli/shared';
import { Command } from 'commander';
import { unwrap, withClient } from './shared.ts';
import { numberFlag } from './flags.ts';
import {
    ASSET_TYPES, assetQuery, commonAssetFolder, requireAssetUrl, selectAssets
} from '../asset/query.ts';
import type { AssetType } from '../asset/query.ts';
import {
    addressOf, queryAssets, queryOne, requireOne, settleAssetDb, snapshot, whereIs
} from '../asset/db.ts';
import type { WaitOptions } from '../asset/db.ts';
import { copiedAddress, diffAssets, diffClasses } from '../asset/settle.ts';
import type { AssetReport, DbSnapshot } from '../asset/settle.ts';
import type { Report } from '../render/present.ts';
import type { Resolved } from '../resolve.ts';

const DEFAULT_FOLDER = 'db://assets';
const DEFAULT_MAX_RESULTS = 200;

const WAIT = {
    timeoutMs: 60000,
    quietForMs: 1500,
    intervalMs: 400
};

/** `--timeout` is in seconds because a wait a human types is in seconds; everything below is in ms. */
export function waitOptions(options: { timeout?: string; quietFor?: string }): WaitOptions {
    const timeoutSeconds = numberFlag('--timeout', options.timeout);
    const quietForMs = numberFlag('--quiet-for', options.quietFor);
    return {
        timeoutMs: timeoutSeconds === undefined ? WAIT.timeoutMs : timeoutSeconds * 1000,
        quietForMs: quietForMs === undefined ? WAIT.quietForMs : quietForMs,
        intervalMs: WAIT.intervalMs,
        now: () => Date.now()
    };
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

export async function assetRefresh(
    client: Driver, spec: { target: string } & WaitOptions
): Promise<Report> {
    const url = requireAssetUrl(spec.target, 'the folder to refresh');
    const before = await snapshot(client, url);
    await client.editor.assetDb.refreshAsset(url);
    return outputOf(await afterOperation(client, {
        action: 'refreshed', target: url, scope: url, landing: () => addressOf(client, url)
    }, before, spec), spec);
}

export async function assetReimport(
    client: Driver, spec: { target: string } & WaitOptions
): Promise<Report> {
    const url = requireAssetUrl(spec.target, 'the asset to reimport');
    if (!await queryOne(client, url)) {
        throw new Error(`the asset database does not know '${url}'; if the file appeared on disk past the `
            + `editor, run 'cocos asset refresh <folder>' first`);
    }
    const before = await snapshot(client, url);
    await client.editor.assetDb.reimportAsset(url);
    return outputOf(await afterOperation(client, {
        action: 'reimported', target: url, scope: url, landing: () => addressOf(client, url)
    }, before, spec), spec);
}

export async function assetMove(
    client: Driver, spec: { source: string; target: string; overwrite?: boolean } & WaitOptions
): Promise<Report> {
    const from = requireAssetUrl(spec.source, 'the source asset');
    const to = requireAssetUrl(spec.target, 'the target address');
    const moving = await requireOne(client, from);

    const scope = commonAssetFolder(from, to);
    const before = await snapshot(client, scope);
    await client.editor.assetDb.moveAsset(from, to, {
        overwrite: spec.overwrite === true, rename: spec.overwrite !== true
    });

    const settledReport = await afterOperation(client, {
        action: `moved from ${from}`, target: to, scope,
        landing: () => whereIs(client, moving.uuid)
    }, before, spec);

    const report: AssetReport = settledReport.landedAt === null
        ? { ...settledReport, failure: `${from} is at no address in the database after the move` }
        : settledReport;
    return outputOf(report, spec,
        'a uuid survives the move, and absolute db:// paths inside an importer .meta do not: '
            + 'materialDumpDir on a model with dumped materials keeps naming the old folder');
}

export async function assetGet(
    client: Driver, spec: { target: string; field?: string }
): Promise<Report> {
    return { kind: 'assetInfo', asset: await requireOne(client, spec.target), field: spec.field };
}

export interface ListSpec {
    folder?: string;
    type?: string;
    name?: string;
    exact?: boolean;
    max?: number;
}

export async function assetList(client: Driver, spec: ListSpec): Promise<Report> {
    const root = requireAssetUrl(spec.folder || DEFAULT_FOLDER, 'the folder to search');
    const type = (spec.type || 'all') as AssetType;
    if (ASSET_TYPES.indexOf(type) === -1) {
        throw new Error(`asset type '${type}' is not known; the known ones: ${ASSET_TYPES.join(', ')}`);
    }
    const selection = selectAssets(await queryAssets(client, assetQuery(root, type)), {
        name: spec.name, exactMatch: spec.exact === true,
        maxResults: spec.max === undefined ? DEFAULT_MAX_RESULTS : spec.max
    });
    return { kind: 'assetList', assets: selection.assets, total: selection.total };
}

/**
 * The editor answers node uuids, and it answers for both ways a node can depend on an asset: an
 * instance of a prefab, and a component field holding the uuid. The scene dump is what turns those
 * uuids into paths; a uuid it does not name still counts as a user and prints by uuid alone.
 */
export async function assetUsers(client: Driver, spec: { target: string }): Promise<Report> {
    const asset = await requireOne(client, spec.target);
    const uuids = await client.editor.scene.queryNodesByAssetUuid(asset.uuid);
    const dump = await unwrap(client.scene.call('dumpSceneNodes'), 'dumpSceneNodes');
    const paths = new Map((dump.nodes || []).map(node => [node.uuid, node.path]));
    return {
        kind: 'assetUsers',
        users: {
            asset: asset.url,
            nodes: (uuids || []).map(uuid => ({ path: paths.get(uuid) ?? null, uuid }))
        }
    };
}

export async function assetReady(client: Driver): Promise<Report> {
    const ready = await client.editor.assetDb.queryReady();
    return ready === true
        ? { kind: 'action', verdict: 'ok', summary: 'the asset database is ready' }
        : { kind: 'action', verdict: 'FAILED', summary: 'the asset database is not ready yet' };
}

/**
 * The copy is a new asset the importer has not seen yet, so the wait is part of the command: without
 * it the next command against the copy is a race. Under the default rename-on-conflict the address
 * asked for can still hold the original, and the copy is then wherever the database gained one.
 */
export async function assetCopy(
    client: Driver, spec: { source: string; target: string; overwrite?: boolean } & WaitOptions
): Promise<Report> {
    const from = requireAssetUrl(spec.source, 'the source asset');
    const to = requireAssetUrl(spec.target, 'the target address');
    await requireOne(client, from);

    const scope = commonAssetFolder(from, to);
    const before = await snapshot(client, scope);
    await client.editor.assetDb.copyAsset(from, to, {
        overwrite: spec.overwrite === true, rename: spec.overwrite !== true
    });

    const report = await afterOperation(client, {
        action: `copied from ${from}`, target: to, scope,
        landing: settledReport => copiedAddress(to, settledReport.assets.added)
    }, before, spec);

    return outputOf(report.landedAt === null
        ? { ...report, failure: `no copy of ${from} appeared in the database` }
        : report, spec);
}

export async function assetRemove(
    client: Driver, spec: { target: string } & WaitOptions
): Promise<Report> {
    const url = requireAssetUrl(spec.target, 'the asset to delete');
    const existing = await requireOne(client, url);
    const before = await snapshot(client, url);
    await client.editor.assetDb.deleteAsset(url);

    const report = await afterOperation(client, {
        action: `deleted ${existing.uuid}`, target: url, scope: url,
        landing: () => whereIs(client, existing.uuid)
    }, before, spec);

    return outputOf(report.landedAt === null
        ? report
        : { ...report, failure: `${existing.uuid} is still at ${report.landedAt}` }, spec);
}

export async function assetMkdir(
    client: Driver, spec: { folder: string } & WaitOptions
): Promise<Report> {
    const url = requireAssetUrl(spec.folder, 'the folder to create');
    const before = await snapshot(client, url);
    await client.editor.assetDb.createAsset(url, null);

    const report = await afterOperation(client, {
        action: 'created', target: url, scope: url, landing: () => addressOf(client, url)
    }, before, spec);
    if (report.landedAt === null) {
        return outputOf({ ...report, failure: `${url} did not appear in the database` }, spec);
    }
    const created = await queryOne(client, url);
    return outputOf(report, spec,
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
            withClient(resolve, client => assetGet(client, { target, field: options.field }),
                { json: options.json }));

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
        }) => withClient(resolve, client => assetList(client, {
            folder, type: options.type, name: options.name, exact: options.exact,
            max: numberFlag('--max', options.max)
        }), { json: options.json }));

    waitFlags(asset
        .command('refresh <folder>')
        .description('rescan a folder and wait for the import to finish — this is what carries an edit '
            + 'made past the editor into the project'))
        .action((folder: string, options: { timeout?: string; quietFor?: string }) =>
            withClient(resolve, client => assetRefresh(client, {
                target: folder, ...waitOptions(options)
            })));

    waitFlags(asset
        .command('reimport <path>')
        .description('rerun the importer on one asset and wait for it to finish'))
        .action((target: string, options: { timeout?: string; quietFor?: string }) =>
            withClient(resolve, client => assetReimport(client, {
                target, ...waitOptions(options)
            })));

    waitFlags(asset
        .command('mv <source> <target>')
        .description('move or rename an asset; the uuid survives and references stay intact')
        .option('--overwrite', 'replace a taken address instead of renaming'))
        .action((source: string, target: string, options: {
            overwrite?: boolean; timeout?: string; quietFor?: string
        }) => withClient(resolve, client => assetMove(client, {
            source, target, overwrite: options.overwrite, ...waitOptions(options)
        })));

    waitFlags(asset
        .command('cp <source> <target>')
        .description('copy an asset and wait for the import to finish; the copy is a new asset with '
            + 'a new uuid that nothing references')
        .option('--overwrite', 'replace a taken address instead of renaming'))
        .action((source: string, target: string, options: {
            overwrite?: boolean; timeout?: string; quietFor?: string
        }) => withClient(resolve, client => assetCopy(client, {
            source, target, overwrite: options.overwrite, ...waitOptions(options)
        })));

    waitFlags(asset
        .command('rm <path>')
        .description('delete an asset or a whole folder and wait for the database to settle'))
        .action((target: string, options: { timeout?: string; quietFor?: string }) =>
            withClient(resolve, client => assetRemove(client, { target, ...waitOptions(options) })));

    waitFlags(asset
        .command('mkdir <folder>')
        .description('create a folder in the asset database and wait for it to be imported'))
        .action((folder: string, options: { timeout?: string; quietFor?: string }) =>
            withClient(resolve, client => assetMkdir(client, { folder, ...waitOptions(options) })));

    asset
        .command('users <path>')
        .description('nodes of the open scene that depend on an asset — as an instance of it, or '
            + 'through a component field holding it')
        .option('--json', 'print the structural form instead of text')
        .action((target: string, options: { json?: boolean }) =>
            withClient(resolve, client => assetUsers(client, { target }), { json: options.json }));

    asset
        .command('ready')
        .description('whether the asset database finished starting up — anything read before that is about a half-imported project')
        .action(() => withClient(resolve, assetReady));
}
