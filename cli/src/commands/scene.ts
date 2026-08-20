import { Command } from 'commander';
import type { Driver, SceneNodeEntry } from '@cocos-cli/shared';
import { unwrap, withClient } from './shared.ts';
import { resolveNode } from './node.ts';
import type { DumpNode, Report } from '../render/present.ts';
import type { Resolved } from '../resolve.ts';

/** `parentUuid` is really `null` only for the scene root itself, which never reaches the dump; the
 * contract type allows it anyway, and `renderTree` compares parentUuid as an ordinary Map/Set key. */
function toDumpNode(node: SceneNodeEntry): DumpNode {
    return {
        uuid: node.uuid,
        name: node.name,
        parentUuid: node.parentUuid ?? '',
        active: node.active,
        components: node.components
    };
}

export async function sceneTree(
    client: Driver, options: { uuid?: boolean }
): Promise<Report> {
    const dump = await unwrap(client.scene.call('dumpSceneNodes'), 'dumpSceneNodes');
    return {
        kind: 'sceneTree',
        nodes: (dump.nodes || []).map(toDumpNode),
        options: { uuid: options.uuid }
    };
}

export async function sceneInfo(client: Driver): Promise<Report> {
    const info = await unwrap(client.scene.call('getCurrentSceneInfo'), 'getCurrentSceneInfo');
    return {
        kind: 'action',
        verdict: 'ok',
        summary: `${info.name}  ${info.uuid}  nodes: ${info.nodeCount}`
    };
}

export function registerScene(program: Command, resolve: () => Promise<Resolved>): void {
    const scene = program.command('scene').description('the open scene as a whole');

    scene
        .command('tree')
        .description('hierarchy of the open scene')
        .option('--uuid', 'show node uuids')
        .action((options: { uuid?: boolean }) => withClient(resolve, client => sceneTree(client, options)));

    scene
        .command('info')
        .description('name, uuid and size of the open scene')
        .action(() => withClient(resolve, sceneInfo));

    scene
        .command('owners <class>')
        .description('which nodes of the open scene carry this component class')
        .option('--active-only', 'skip nodes switched off in the hierarchy')
        .option('--json', 'print the structural form instead of text')
        .action((className: string, options: { activeOnly?: boolean; json?: boolean }) =>
            withClient(resolve, async client => ({
                kind: 'sceneOwners',
                owners: await unwrap(
                    client.scene.call('findComponentOwners',
                        { className, includeInactive: options.activeOnly !== true }),
                    'findComponentOwners')
            }), { json: options.json }));

    scene
        .command('dirty')
        .description('whether the open scene differs from the file on disk, and where')
        .option('--json', 'print the structural form instead of text')
        .action((options: { json?: boolean }) => withClient(resolve, async client => ({
            kind: 'sceneDirty',
            dirty: await unwrap(client.scene.call('sceneDirtyAgainstDisk'), 'sceneDirtyAgainstDisk')
        }), { json: options.json }));

    scene
        .command('missing')
        .description('components whose script no longer resolves — that slot crashes preview')
        .option('--root <path>', 'look only under this node')
        .option('--json', 'print the structural form instead of text')
        .action((options: { root?: string; json?: boolean }) => withClient(resolve, async client => {
            const rootUuid = options.root === undefined
                ? undefined
                : await resolveNode(client, options.root);
            return {
                kind: 'sceneMissing',
                missing: await unwrap(
                    client.scene.call('dumpMissingScripts', rootUuid === undefined ? {} : { rootUuid }),
                    'dumpMissingScripts')
            };
        }, { json: options.json }));

    scene
        .command('open <path>')
        .description('open a scene by its db:// url or uuid')
        .action((target: string) => withClient(resolve, async client => {
            await client.editor.scene.openScene(target);
            return { kind: 'action', verdict: 'ok', summary: `opened ${target}` };
        }));

    scene
        .command('save')
        .description('save the open scene')
        .action(() => withClient(resolve, async client => {
            await client.editor.scene.saveScene();
            return { kind: 'action', verdict: 'ok', summary: 'scene saved' };
        }));
}
