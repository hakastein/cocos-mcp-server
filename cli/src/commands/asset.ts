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
    if (!info) throw new Error(`база ассетов не знает '${urlOrUuid}'`);
    return info;
}

/**
 * Классы, под которыми редактор сейчас регистрирует компоненты. Это и есть ответ на «заметил ли
 * редактор новый `@ccclass`» — ради него запускают `refresh`, а отчёт по одним файлам говорит про
 * диск, тогда как спрашивали про класс.
 */
async function registeredClasses(client: DriverClient): Promise<string[] | null> {
    const components = await client.editor.scene.queryComponents().catch(() => null);
    if (!Array.isArray(components)) return null;
    return (components as Array<{ name?: string }>)
        .map(component => component.name || '')
        .filter(name => name !== '');
}

/**
 * Отпечаток снимается и по самому адресу, и по дереву под ним, поэтому папка, которой база ещё не
 * знает, ожиданию не мешает: до `refresh` её просто нет ни в одной половине.
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
 * `refresh-asset` и `reimport-asset` возвращают управление до конца импорта — на этом проекте
 * порядка восьми секунд до конца, — поэтому ожидание живёт здесь, а не у вызывающего.
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
 * `move-asset`, `copy-asset`, `create-asset` и `delete-asset` отвечают пустотой и на удавшейся
 * операции — проверено живьём: перенос сложился, файл переехал, uuid уцелел, а ответ был `null`.
 * Поэтому их ответ не читается: где ассет оказался, спрашивают у базы по его uuid.
 */
async function whereIs(client: DriverClient, uuid: string): Promise<string | null> {
    const url = await client.editor.assetDb.queryUrl(uuid).catch(() => null);
    return typeof url === 'string' && url ? url : null;
}

export async function assetRefresh(
    client: DriverClient, target: string, options: WaitOptions
): Promise<Report> {
    const url = requireAssetUrl(target, 'папка обновления');
    const before = await snapshot(client, url);
    await client.editor.assetDb.refreshAsset(url);
    return outputOf(await settleAndDiff(client, 'обновлено', url, url, before, options), options);
}

export async function assetReimport(
    client: DriverClient, target: string, options: WaitOptions
): Promise<Report> {
    const url = requireAssetUrl(target, 'переимпортируемый ассет');
    if (!await queryOne(client, url)) {
        throw new Error(`база ассетов не знает '${url}'; если файл появился на диске мимо редактора, `
            + `сначала 'cocos asset refresh <папка>'`);
    }
    const before = await snapshot(client, url);
    await client.editor.assetDb.reimportAsset(url);
    return outputOf(
        await settleAndDiff(client, 'переимпортировано', url, url, before, options), options);
}

export async function assetMove(
    client: DriverClient, source: string, target: string,
    options: WaitOptions & { overwrite?: boolean }
): Promise<Report> {
    const from = requireAssetUrl(source, 'исходный ассет');
    const to = requireAssetUrl(target, 'целевой адрес');
    const moving = await requireOne(client, from);

    const scope = commonAssetFolder(from, to);
    const before = await snapshot(client, scope);
    await client.editor.assetDb.moveAsset(from, to, {
        overwrite: options.overwrite === true, rename: options.overwrite !== true
    });

    const report = await settleAndDiff(client, 'перенесено', `${from} → ${to}`, scope, before, options);
    const landed = await whereIs(client, moving.uuid);
    if (landed === null) {
        report.failure = `${from} после переноса не найден в базе ни по одному адресу`;
    } else if (landed !== to) {
        report.target = `${from} → ${landed}`;
        report.failure = landed === from
            ? `${from} остался на месте — ${to} занят, а --overwrite не задан`
            : undefined;
    }
    return outputOf(report, options,
        'uuid переезд переживает, а абсолютные db://-пути внутри .meta импортёра — нет: '
            + 'materialDumpDir у модели с выгруженными материалами продолжает называть старую папку');
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
    const root = requireAssetUrl(folder, 'папка поиска');
    const type = (options.type || 'all') as AssetType;
    if (ASSET_TYPES.indexOf(type) === -1) {
        throw new Error(`тип ассета '${type}' не известен; есть: ${ASSET_TYPES.join(', ')}`);
    }
    const maxResults = options.max === undefined ? DEFAULT_MAX_RESULTS : Number(options.max);
    const selection = selectAssets(await queryAssets(client, assetQuery(root, type)), {
        name: options.name, exactMatch: options.exact === true, maxResults
    });
    return { kind: 'assetList', assets: selection.assets, total: selection.total };
}

export function registerAsset(program: Command, resolve: () => Promise<Resolved>): void {
    const asset = program.command('asset').description('база ассетов проекта');

    const waitFlags = (command: Command): Command => command
        .option('--timeout <seconds>',
            `сколько ждать, пока база уляжется (по умолчанию ${WAIT.timeoutMs / 1000})`)
        .option('--quiet-for <ms>',
            `сколько отпечаток базы должен не меняться (по умолчанию ${WAIT.quietForMs})`);

    asset
        .command('get <path>')
        .description('uuid, тип, url и импортёр ассета по db://-пути или uuid')
        .option('--field <name>', 'выдать одно поле голым значением')
        .option('--json', 'выдать структурную форму вместо текста')
        .action((target: string, options: { field?: string; json?: boolean }) =>
            withClient(resolve, client => assetGet(client, target, options), { json: options.json }));

    asset
        .command('ls [folder]')
        .description('перечислить ассеты под папкой')
        .option('--type <type>', `сузить по типу: ${ASSET_TYPES.join(', ')}`)
        .option('--name <substring>', 'сузить по имени')
        .option('--exact', 'сравнивать имя точно, а не как подстроку')
        .option('--max <n>',
            `предел выдачи (по умолчанию ${DEFAULT_MAX_RESULTS}); итог всё равно называет полное число`)
        .option('--json', 'выдать структурную форму вместо текста')
        .action((folder: string | undefined, options: {
            type?: string; name?: string; exact?: boolean; max?: string; json?: boolean
        }) => withClient(
            resolve, client => assetList(client, folder || DEFAULT_FOLDER, options),
            { json: options.json }));

    waitFlags(asset
        .command('refresh <folder>')
        .description('пересканировать папку и дождаться конца импорта — правка, сделанная мимо '
            + 'редактора, доходит до проекта этим'))
        .action((folder: string, options: { timeout?: string; quietFor?: string }) =>
            withClient(resolve, client => assetRefresh(client, folder, waitOptions(options))));

    waitFlags(asset
        .command('reimport <path>')
        .description('перезапустить импортёр на одном ассете и дождаться, пока он закончит'))
        .action((target: string, options: { timeout?: string; quietFor?: string }) =>
            withClient(resolve, client => assetReimport(client, target, waitOptions(options))));

    waitFlags(asset
        .command('mv <source> <target>')
        .description('перенести или переименовать ассет; uuid переезд переживает, ссылки не рвутся')
        .option('--overwrite', 'заменить занятый адрес вместо переименования'))
        .action((source: string, target: string, options: {
            overwrite?: boolean; timeout?: string; quietFor?: string
        }) => withClient(resolve, client => assetMove(
            client, source, target, { ...waitOptions(options), overwrite: options.overwrite })));

    asset
        .command('cp <source> <target>')
        .description('скопировать ассет; копия — новый ассет с новым uuid, на неё никто не ссылается')
        .option('--overwrite', 'заменить занятый адрес вместо переименования')
        .action((source: string, target: string, options: { overwrite?: boolean }) =>
            withClient(resolve, async client => {
                const from = requireAssetUrl(source, 'исходный ассет');
                const to = requireAssetUrl(target, 'целевой адрес');
                const original = await requireOne(client, from);
                await client.editor.assetDb.copyAsset(from, to, {
                    overwrite: options.overwrite === true, rename: options.overwrite !== true
                });
                const landed = await queryOne(client, to);
                if (!landed) {
                    return {
                        kind: 'action',
                        verdict: 'FAILED',
                        summary: `${to} не появился в базе после копирования`
                    };
                }
                if (landed.uuid === original.uuid) {
                    return {
                        kind: 'action',
                        verdict: 'FAILED',
                        summary: `по ${to} лежит сам ${from}, копии нет`
                    };
                }
                return {
                    kind: 'action',
                    verdict: 'ok',
                    summary: `скопировано в ${landed.url}  ${landed.uuid}`
                };
            }));

    asset
        .command('rm <path>')
        .description('удалить ассет или папку целиком')
        .action((target: string) => withClient(resolve, async client => {
            const url = requireAssetUrl(target, 'удаляемый ассет');
            const existing = await requireOne(client, url);
            await client.editor.assetDb.deleteAsset(url);
            const stillThere = await whereIs(client, existing.uuid);
            if (stillThere !== null) {
                return {
                    kind: 'action',
                    verdict: 'FAILED',
                    summary: `${existing.uuid} всё ещё лежит по ${stillThere}`
                };
            }
            return {
                kind: 'action', verdict: 'ok', summary: `удалён ${url}  ${existing.uuid}`
            };
        }));

    asset
        .command('mkdir <folder>')
        .description('создать папку в базе ассетов')
        .action((folder: string) => withClient(resolve, async client => {
            const url = requireAssetUrl(folder, 'создаваемая папка');
            await client.editor.assetDb.createAsset(url, null);
            const created = await queryOne(client, url);
            if (!created) {
                return { kind: 'action', verdict: 'FAILED', summary: `${url} не появилась в базе` };
            }
            return {
                kind: 'action',
                verdict: 'ok',
                summary: `создана ${created.url}  ${created.uuid}`,
                note: created.isDirectory === true ? undefined : `${url} — не папка`
            };
        }));

    asset
        .command('ready')
        .description('закончила ли база ассетов запуск — всё, прочитанное до этого, о недоимпортированном проекте')
        .action(() => withClient(resolve, async client => {
            const ready = await client.editor.assetDb.queryReady();
            return ready === true
                ? { kind: 'action', verdict: 'ok', summary: 'база ассетов готова' }
                : { kind: 'action', verdict: 'FAILED', summary: 'база ассетов ещё не готова' };
        }));
}
