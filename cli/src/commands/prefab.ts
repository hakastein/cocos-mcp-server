import type { Driver } from '@cocos-cli/shared';
import { Command } from 'commander';
import { unwrap, withClient } from './shared.ts';
import { spellingOf } from '../property/reference-target.ts';
import {
    applyLinkageOptions, establishedLinkage, linkageVerdict, prefabSavePath
} from '../prefab-linkage.ts';
import { requireAssetUrl } from '../asset/query.ts';
import { resolveNode } from './node.ts';
import type { AssetRecord } from '../asset/query.ts';
import type { CreateNodeOptions } from '../prefab-linkage.ts';
import type { Report } from '../render/present.ts';
import type { Resolved } from '../resolve.ts';

/**
 * A prefab is addressed the way the editor names it: a `db://` url or a uuid. A node path does not
 * work here, and a spelling that looks like one is refused here rather than turned into an asset
 * query by node name.
 */
async function resolvePrefabUuid(client: Driver, asset: string): Promise<string> {
    const spelling = spellingOf(asset);
    if (spelling.kind === 'uuid') return spelling.uuid;
    if (spelling.kind === 'nodePath') {
        throw new Error(`'${asset}' looks like neither a prefab db:// url nor its uuid`);
    }
    const uuid = await client.editor.assetDb.queryUuid(spelling.url).catch(() => undefined);
    if (typeof uuid !== 'string' || !uuid) {
        throw new Error(`the asset database does not know '${spelling.url}'`);
    }
    return uuid;
}

export async function prefabDump(client: Driver, asset: string): Promise<Report> {
    const uuid = await resolvePrefabUuid(client, asset);
    return {
        kind: 'prefabDump',
        dump: await unwrap(client.scene.call('dumpPrefabAsset', uuid), 'dumpPrefabAsset')
    };
}

export async function prefabOverrides(client: Driver, target: string): Promise<Report> {
    const nodeUuid = await resolveNode(client, target);
    return {
        kind: 'prefabOverrides',
        overrides: await unwrap(
            client.scene.call('listPrefabOverrides', nodeUuid), 'listPrefabOverrides')
    };
}

/**
 * For FBX/glTF the main asset is not what instantiates — its `gltf-scene` sub-asset is; that one
 * also answers `cc.Prefab`, so it links the same way an ordinary `.prefab` does.
 */
async function instantiableAsset(
    client: Driver, url: string
): Promise<{ uuid: string; type: string | null; name: string; fromModel: boolean }> {
    const info = await client.editor.assetDb.queryAssetInfo(url).catch(() => null) as AssetRecord | null;
    if (!info) throw new Error(`the asset database does not know '${url}'`);

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
    client: Driver, asset: string,
    options: { parent?: string; name?: string; pos?: string; unlink?: boolean }
): Promise<Report> {
    const url = requireAssetUrl(asset, 'the prefab');
    const target = await instantiableAsset(client, url);
    const unlink = options.unlink === true;

    const payload: CreateNodeOptions = applyLinkageOptions({ assetUuid: target.uuid }, target.type, unlink);
    if (options.parent) payload.parent = await resolveNode(client, options.parent);
    payload.name = options.name || (target.fromModel ? target.name : target.name);
    if (options.pos) {
        const [x, y, z] = options.pos.split(',').map(Number);
        payload.dump = { position: { value: { x, y, z } } };
    }

    const created = await client.editor.scene.createNode(payload);
    const uuid = Array.isArray(created) ? created[0] : created;
    if (typeof uuid !== 'string' || !uuid) {
        throw new Error(`create-node produced no node for '${url}' (asset ${target.uuid})`
            + (target.fromModel
                ? '; the gltf-scene sub-asset that was found turned out not to instantiate'
                : '; an FBX/glTF main asset does not instantiate, and no gltf-scene sub-asset was found'));
    }

    const linkage = await unwrap(client.scene.call('nodePrefabLinkage', uuid), 'nodePrefabLinkage');
    const verdict = linkageVerdict(linkage, target.type, unlink);
    return {
        kind: 'action',
        verdict: verdict.verdict,
        summary: `${payload.name} from ${url}  ${uuid}`
            + (target.fromModel ? '  (through the gltf-scene sub-asset)' : ''),
        note: verdict.detail
    };
}

/**
 * The prefab data comes from the editor's own serializer: a hand-rolled one dropped mesh and
 * material references and produced prefabs that rendered empty.
 */
export async function prefabCreate(
    client: Driver, target: string, savePath: string, name?: string
): Promise<Report> {
    const nodeUuid = await resolveNode(client, target);
    const generated = await unwrap(
        client.scene.call('createPrefabFromNode2', nodeUuid), 'createPrefabFromNode2');
    if (!generated.prefabData) {
        throw new Error(`the editor produced no prefab data for ${target}`);
    }

    const path = prefabSavePath(requireAssetUrl(savePath, 'the prefab path'), generated.nodeName, name);
    await client.editor.assetDb.createAsset(path.url, generated.prefabData, { overwrite: true });
    const written = await client.editor.assetDb.queryAssetInfo(path.url).catch(() => null) as
        AssetRecord | null;
    if (!written) {
        return { kind: 'action', verdict: 'FAILED', summary: `${path.url} did not appear in the asset database` };
    }

    return {
        kind: 'action',
        verdict: 'ok',
        summary: `${target} written to ${written.url}  ${written.uuid}`,
        note: 'the source node did not become an instance — unlike a drag into the Assets panel; '
            + `linking it to the asset takes a fresh 'cocos prefab instantiate'`
    };
}

export function registerPrefab(program: Command, resolve: () => Promise<Resolved>): void {
    const prefab = program.command('prefab').description('prefabs: asset contents and instances in the scene');

    prefab
        .command('dump <asset>')
        .description('tree of a .prefab asset: nodes and components under their registered names')
        .option('--json', 'print the structural form instead of text')
        .action((asset: string, options: { json?: boolean }) =>
            withClient(resolve, client => prefabDump(client, asset), { json: options.json }));

    prefab
        .command('instantiate <asset>')
        .description('put a prefab into the open scene as a linked instance; FBX/glTF goes through '
            + 'its own gltf-scene sub-asset')
        .option('--parent <path>', 'parent node; without it, the scene root')
        .option('--name <name>', 'name of the new node; without it, the asset name')
        .option('--pos <x,y,z>', 'local position')
        .option('--unlink', 'make a flat copy: the node stops tracking the asset')
        .action((asset: string, options: {
            parent?: string; name?: string; pos?: string; unlink?: boolean
        }) => withClient(resolve, client => prefabInstantiate(client, asset, options)));

    prefab
        .command('create <node> <savePath>')
        .description('write a .prefab asset from a node of the open scene')
        .option('--name <name>', 'prefab name, when savePath is a folder')
        .action((target: string, savePath: string, options: { name?: string }) =>
            withClient(resolve, client => prefabCreate(client, target, savePath, options.name)));

    prefab
        .command('info <path>')
        .description('whether a node is linked to a prefab and whether that link survives a save')
        .action((target: string) => withClient(resolve, async client => {
            const nodeUuid = await resolveNode(client, target);
            const report = await unwrap(client.scene.call('nodePrefabLinkage', nodeUuid), 'nodePrefabLinkage');
            if (!report.linked) {
                return { kind: 'action', verdict: 'ok', summary: `${target} is not linked to a prefab` };
            }
            return {
                kind: 'action',
                verdict: establishedLinkage(report).verdict,
                summary: [
                    `${target}  prefab ${report.asset || 'unknown'}`,
                    report.instanceRoot ? 'instance root' : 'inside an instance',
                    `fileId=${report.fileId || 'none'}`,
                    report.persistenceChecked ? `persisted=${report.persisted}` : 'persisted=unknown'
                ].join('  '),
                note: report.persistenceReason || undefined
            };
        }));

    prefab
        .command('overrides <path>')
        .description('what an instance holds on top of its prefab')
        .option('--json', 'print the structural form instead of text')
        .action((target: string, options: { json?: boolean }) =>
            withClient(resolve, client => prefabOverrides(client, target), { json: options.json }));

    prefab
        .command('rm-override <path> <property>')
        .description('remove one override from an instance, leaving the rest alone')
        .option('--index <n>', 'which one, when several share the property path')
        .option('--local-id <id>', 'the same, by the target localID')
        .action((target: string, property: string, options: { index?: string; localId?: string }) =>
            withClient(resolve, async client => {
                const nodeUuid = await resolveNode(client, target);
                const removal = await unwrap(
                    client.scene.call('removePrefabOverride', nodeUuid, property, options.localId,
                        options.index === undefined ? undefined : Number(options.index)),
                    'removePrefabOverride');
                return {
                    kind: 'action',
                    verdict: 'ok',
                    summary: `override ${removal.removed.propertyPath} removed from ${target}`
                        + `  remaining: ${removal.remaining}`
                };
            }));

    prefab
        .command('apply <path>')
        .description('write the state of an instance into its prefab asset')
        .action((target: string) => withClient(resolve, async client => {
            const nodeUuid = await resolveNode(client, target);
            const report = await unwrap(client.scene.call('applyPrefabToAsset', nodeUuid), 'applyPrefabToAsset');
            return {
                kind: 'action',
                verdict: 'ok',
                summary: `${report.nodeName} written into prefab ${report.prefabAsset || 'unknown'}`
                    + (report.accepted === null
                        ? '  (the editor did not say whether it accepted)'
                        : `  accepted=${report.accepted}`)
            };
        }));

    prefab
        .command('revert <path>')
        .description('return an instance to its prefab, dropping every override')
        .action((target: string) => withClient(resolve, async client => {
            const nodeUuid = await resolveNode(client, target);
            const report = await unwrap(client.scene.call('revertPrefabInstance', nodeUuid), 'revertPrefabInstance');
            return {
                kind: 'action',
                verdict: 'ok',
                summary: `${report.nodeName} returned to prefab ${report.prefabAsset || 'unknown'}`
                    + (report.accepted === null
                        ? '  (the editor did not say whether it accepted)'
                        : `  accepted=${report.accepted}`)
            };
        }));
}
