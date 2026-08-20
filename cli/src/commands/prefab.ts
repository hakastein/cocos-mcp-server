import { Command } from 'commander';
import { unwrap, withClient } from './shared';
import {
    prefabDumpSummary, prefabOverridesSummary, renderPrefabDump, renderPrefabOverrides
} from '../render/prefab';
import { spellingOf } from '../property/reference-target';
import { applyLinkageOptions, linkageVerdict, prefabSavePath } from '../prefab-linkage';
import { requireAssetUrl } from '../asset/query';
import { resolveNode } from './node';
import type { AssetRecord } from '../asset/query';
import type { CreateNodeOptions } from '../prefab-linkage';
import type { CommandOutput } from './shared';
import type { DriverClient } from '../driver-client';
import type { Resolved } from '../resolve';

/**
 * Префаб адресуется тем же, чем его называет редактор: db://-путём или uuid. Путь узла сюда не
 * годится, и написание, похожее на него, отваливается здесь, а не запросом ассета по имени узла.
 */
async function resolvePrefabUuid(client: DriverClient, asset: string): Promise<string> {
    const spelling = spellingOf(asset);
    if (spelling.kind === 'uuid') return spelling.uuid;
    if (spelling.kind === 'nodePath') {
        throw new Error(`'${asset}' не похоже ни на db://-путь префаба, ни на его uuid`);
    }
    const uuid = await client.editor.assetDb.queryUuid(spelling.url).catch(() => undefined);
    if (typeof uuid !== 'string' || !uuid) {
        throw new Error(`база ассетов не знает '${spelling.url}'`);
    }
    return uuid;
}

export async function prefabDump(
    client: DriverClient, asset: string, json?: boolean
): Promise<CommandOutput> {
    const uuid = await resolvePrefabUuid(client, asset);
    const dump = await unwrap(client.scene.call('dumpPrefabAsset', uuid), 'dumpPrefabAsset');
    return {
        stdout: json ? JSON.stringify(dump) : renderPrefabDump(dump),
        stderr: prefabDumpSummary(dump)
    };
}

export async function prefabOverrides(
    client: DriverClient, target: string, json?: boolean
): Promise<CommandOutput> {
    const nodeUuid = await resolveNode(client, target);
    const report = await unwrap(client.scene.call('listPrefabOverrides', nodeUuid), 'listPrefabOverrides');
    return {
        stdout: json ? JSON.stringify(report) : renderPrefabOverrides(report),
        stderr: prefabOverridesSummary(report)
    };
}

/**
 * У FBX/glTF инстанцируется не главный ассет, а его саб-ассет `gltf-scene`; он тоже отвечает
 * `cc.Prefab`, поэтому связывается тем же путём, что и обычный `.prefab`.
 */
async function instantiableAsset(
    client: DriverClient, url: string
): Promise<{ uuid: string; type: string | null; name: string; fromModel: boolean }> {
    const info = await client.editor.assetDb.queryAssetInfo(url).catch(() => null) as AssetRecord | null;
    if (!info) throw new Error(`база ассетов не знает '${url}'`);

    const meta = await client.editor.assetDb.queryAssetMeta(info.uuid).catch(() => null) as
        { subMetas?: Record<string, { importer?: string; uuid?: string }> } | null;
    for (const subId of Object.keys((meta && meta.subMetas) || {})) {
        const sub = meta!.subMetas![subId];
        if (!sub || sub.importer !== 'gltf-scene') continue;
        const uuid = sub.uuid || `${info.uuid}@${subId}`;
        const subInfo = await client.editor.assetDb.queryAssetInfo(uuid).catch(() => null) as
            AssetRecord | null;
        return { uuid, type: (subInfo && subInfo.type) || null, name: info.name, fromModel: true };
    }
    return { uuid: info.uuid, type: info.type || null, name: info.name, fromModel: false };
}

export async function prefabInstantiate(
    client: DriverClient, asset: string,
    options: { parent?: string; name?: string; pos?: string; unlink?: boolean }
): Promise<CommandOutput> {
    const url = requireAssetUrl(asset, 'префаб');
    const target = await instantiableAsset(client, url);
    const unlink = options.unlink === true;

    const payload: CreateNodeOptions = applyLinkageOptions({ assetUuid: target.uuid }, target.type, unlink);
    if (options.parent) payload.parent = await resolveNode(client, options.parent);
    payload.name = options.name || (target.fromModel ? target.name : target.name);
    if (options.pos) {
        const [x, y, z] = options.pos.split(',').map(Number);
        payload.dump = { position: { value: { x, y, z } } };
    }

    const created = await client.editor.scene.createNode(payload as never);
    const uuid = Array.isArray(created) ? created[0] : created;
    if (typeof uuid !== 'string' || !uuid) {
        throw new Error(`create-node не дал узла для '${url}' (ассет ${target.uuid})`
            + (target.fromModel
                ? '; найденный саб-ассет gltf-scene оказался неинстанцируемым'
                : '; у FBX/glTF главный ассет не инстанцируется, а саб-ассета gltf-scene не нашлось'));
    }

    const linkage = await unwrap(client.scene.call('nodePrefabLinkage', uuid), 'nodePrefabLinkage');
    const verdict = linkageVerdict(linkage, target.type, unlink);
    return {
        stdout: `${verdict.head}  ${payload.name} из ${url}  ${uuid}`
            + (target.fromModel ? '  (через саб-ассет gltf-scene)' : ''),
        stderr: verdict.detail,
        failed: verdict.failed
    };
}

/**
 * Данные префаба выдаёт сериализатор самого редактора: свой, написанный руками, терял ссылки на
 * меши и материалы и делал префабы, которые рендерятся пустыми.
 */
export async function prefabCreate(
    client: DriverClient, target: string, savePath: string, name?: string
): Promise<CommandOutput> {
    const nodeUuid = await resolveNode(client, target);
    const generated = await unwrap(
        client.scene.call('createPrefabFromNode2', nodeUuid), 'createPrefabFromNode2');
    if (!generated.prefabData) {
        throw new Error(`редактор не выдал данных префаба для ${target}`);
    }

    const path = prefabSavePath(requireAssetUrl(savePath, 'путь префаба'), generated.nodeName, name);
    await client.editor.assetDb.createAsset(path.url, generated.prefabData, { overwrite: true });
    const written = await client.editor.assetDb.queryAssetInfo(path.url).catch(() => null) as
        AssetRecord | null;
    if (!written) {
        return { stdout: `НЕ СДЕЛАНО  ${path.url} не появился в базе ассетов`, failed: true };
    }

    return {
        stdout: `ok  ${target} записан в ${written.url}  ${written.uuid}`,
        stderr: 'исходный узел инстансом не стал — в отличие от перетаскивания в панель Assets; '
            + `связать его с ассетом можно только заново, через 'cocos prefab instantiate'`
    };
}

export function registerPrefab(program: Command, resolve: () => Promise<Resolved>): void {
    const prefab = program.command('prefab').description('префабы: содержимое ассета и инстансы в сцене');

    prefab
        .command('dump <asset>')
        .description('дерево .prefab-ассета: узлы и компоненты под зарегистрированными именами')
        .option('--json', 'выдать структурную форму вместо текста')
        .action((asset: string, options: { json?: boolean }) =>
            withClient(resolve, client => prefabDump(client, asset, options.json)));

    prefab
        .command('instantiate <asset>')
        .description('поставить префаб в открытую сцену связанным инстансом; FBX/glTF идёт через '
            + 'свой саб-ассет gltf-scene')
        .option('--parent <path>', 'родительский узел; без него — корень сцены')
        .option('--name <name>', 'имя нового узла; без него — имя ассета')
        .option('--pos <x,y,z>', 'локальная позиция')
        .option('--unlink', 'сделать плоскую копию: узел перестанет следить за ассетом')
        .action((asset: string, options: {
            parent?: string; name?: string; pos?: string; unlink?: boolean
        }) => withClient(resolve, client => prefabInstantiate(client, asset, options)));

    prefab
        .command('create <node> <savePath>')
        .description('записать .prefab-ассет из узла открытой сцены')
        .option('--name <name>', 'имя префаба, когда savePath — папка')
        .action((target: string, savePath: string, options: { name?: string }) =>
            withClient(resolve, client => prefabCreate(client, target, savePath, options.name)));

    prefab
        .command('info <path>')
        .description('связан ли узел с префабом и переживёт ли эта связь сохранение')
        .action((target: string) => withClient(resolve, async client => {
            const nodeUuid = await resolveNode(client, target);
            const report = await unwrap(client.scene.call('nodePrefabLinkage', nodeUuid), 'nodePrefabLinkage');
            if (!report.linked) return { stdout: `${target} не связан с префабом` };
            const persisted = !report.persistenceChecked
                ? 'persisted=unknown'
                : `persisted=${report.persisted}`;
            return {
                stdout: [
                    `${target}  префаб ${report.asset || 'не назван'}`,
                    report.instanceRoot ? 'корень инстанса' : 'внутри инстанса',
                    `fileId=${report.fileId || 'нет'}`,
                    persisted
                ].join('  '),
                stderr: report.persistenceReason || ''
            };
        }));

    prefab
        .command('overrides <path>')
        .description('что инстанс держит поверх префаба')
        .option('--json', 'выдать структурную форму вместо текста')
        .action((target: string, options: { json?: boolean }) =>
            withClient(resolve, client => prefabOverrides(client, target, options.json)));

    prefab
        .command('rm-override <path> <property>')
        .description('снять один оверрайд с инстанса, остальные не трогая')
        .option('--index <n>', 'какой именно, когда путь свойства совпадает у нескольких')
        .option('--local-id <id>', 'то же, но через localID цели')
        .action((target: string, property: string, options: { index?: string; localId?: string }) =>
            withClient(resolve, async client => {
                const nodeUuid = await resolveNode(client, target);
                const removal = await unwrap(
                    client.scene.call('removePrefabOverride', nodeUuid, property, options.localId,
                        options.index === undefined ? undefined : Number(options.index)),
                    'removePrefabOverride');
                return { stdout: `ok  снят оверрайд ${removal.removed.propertyPath} с ${target}`
                    + `  осталось: ${removal.remaining}` };
            }));

    prefab
        .command('apply <path>')
        .description('записать состояние инстанса в префаб-ассет')
        .action((target: string) => withClient(resolve, async client => {
            const nodeUuid = await resolveNode(client, target);
            const report = await unwrap(client.scene.call('applyPrefabToAsset', nodeUuid), 'applyPrefabToAsset');
            return { stdout: `ok  ${report.nodeName} записан в префаб ${report.prefabAsset || 'не назван'}`
                + (report.accepted === null ? '  (редактор не сказал, принял ли)' : `  accepted=${report.accepted}`) };
        }));

    prefab
        .command('revert <path>')
        .description('вернуть инстанс к префабу, сняв все оверрайды')
        .action((target: string) => withClient(resolve, async client => {
            const nodeUuid = await resolveNode(client, target);
            const report = await unwrap(client.scene.call('revertPrefabInstance', nodeUuid), 'revertPrefabInstance');
            return { stdout: `ok  ${report.nodeName} возвращён к префабу ${report.prefabAsset || 'не назван'}`
                + (report.accepted === null ? '  (редактор не сказал, принял ли)' : `  accepted=${report.accepted}`) };
        }));
}
