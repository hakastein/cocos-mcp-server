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

export async function sceneTree(client: Driver, spec: { uuid?: boolean }): Promise<Report> {
    const dump = await unwrap(client.scene.call('dumpSceneNodes'), 'dumpSceneNodes');
    return {
        kind: 'sceneTree',
        nodes: (dump.nodes || []).map(toDumpNode),
        options: { uuid: spec.uuid }
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

export async function sceneOwners(
    client: Driver, spec: { className: string; activeOnly?: boolean }
): Promise<Report> {
    return {
        kind: 'sceneOwners',
        owners: await unwrap(
            client.scene.call('findComponentOwners',
                { className: spec.className, includeInactive: spec.activeOnly !== true }),
            'findComponentOwners')
    };
}

export async function sceneDirty(client: Driver): Promise<Report> {
    return {
        kind: 'sceneDirty',
        dirty: await unwrap(client.scene.call('sceneDirtyAgainstDisk'), 'sceneDirtyAgainstDisk')
    };
}

export async function sceneMissing(client: Driver, spec: { root?: string }): Promise<Report> {
    const rootUuid = spec.root === undefined ? undefined : await resolveNode(client, spec.root);
    return {
        kind: 'sceneMissing',
        missing: await unwrap(
            client.scene.call('dumpMissingScripts', rootUuid === undefined ? {} : { rootUuid }),
            'dumpMissingScripts')
    };
}

export async function sceneOpen(client: Driver, spec: { target: string }): Promise<Report> {
    await client.editor.scene.openScene(spec.target);
    return { kind: 'action', verdict: 'ok', summary: `opened ${spec.target}` };
}

export async function sceneSave(client: Driver): Promise<Report> {
    await client.editor.scene.saveScene();
    return { kind: 'action', verdict: 'ok', summary: 'scene saved' };
}

export async function sceneClose(client: Driver): Promise<Report> {
    const closed = await client.editor.scene.closeScene();
    return closed === true
        ? { kind: 'action', verdict: 'ok', summary: 'scene closed' }
        : {
            kind: 'action',
            verdict: 'FAILED',
            summary: 'the editor did not close the scene',
            note: 'checked live 2026-08-21 on a scene carrying unsaved changes: `close-scene` '
                + 'answered false and left the scene open'
        };
}

/**
 * A soft reload rebuilds the live components and keeps the scene around them. Checked live
 * 2026-08-21: a position written and not saved was still there afterwards, uuids and all.
 */
export async function sceneReload(client: Driver): Promise<Report> {
    await client.editor.scene.softReload();
    return {
        kind: 'action',
        verdict: 'ok',
        summary: 'components of the open scene reloaded',
        note: 'the scene itself is kept: node uuids and writes not yet saved both survive this'
    };
}

/**
 * The class registry of the engine the scene runs. It is a wider set than the Add Component menu
 * `component types` answers — abstract bases and deprecated aliases are registered and not offered
 * — and a base outside `cc.Component` answers classes that are no components at all.
 */
export async function sceneClasses(client: Driver, spec: { base: string }): Promise<Report> {
    const classes = await client.editor.scene.queryClasses({ extends: spec.base });
    return {
        kind: 'classList',
        classes: (classes || []).map(entry => ({ name: entry.name })),
        base: spec.base
    };
}

export function registerScene(program: Command, resolve: () => Promise<Resolved>): void {
    const scene = program.command('scene').description('the open scene as a whole');

    scene
        .command('tree')
        .description('hierarchy of the open scene')
        .option('--uuid', 'show node uuids')
        .action((options: { uuid?: boolean }) =>
            withClient(resolve, client => sceneTree(client, { uuid: options.uuid })));

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
            withClient(resolve, client => sceneOwners(client, {
                className, activeOnly: options.activeOnly
            }), { json: options.json }));

    scene
        .command('dirty')
        .description('whether the open scene differs from the file on disk, and where')
        .option('--json', 'print the structural form instead of text')
        .action((options: { json?: boolean }) =>
            withClient(resolve, sceneDirty, { json: options.json }));

    scene
        .command('missing')
        .description('components whose script no longer resolves — that slot crashes preview')
        .option('--root <path>', 'look only under this node')
        .option('--json', 'print the structural form instead of text')
        .action((options: { root?: string; json?: boolean }) =>
            withClient(resolve, client => sceneMissing(client, { root: options.root }),
                { json: options.json }));

    scene
        .command('open <path>')
        .description('open a scene by its db:// url or uuid')
        .action((target: string) => withClient(resolve, client => sceneOpen(client, { target })));

    scene
        .command('save')
        .description('save the open scene')
        .action(() => withClient(resolve, sceneSave));

    scene
        .command('close')
        .description('close the open scene, leaving the editor with none')
        .action(() => withClient(resolve, sceneClose));

    scene
        .command('reload')
        .description('rebuild the live components of the open scene — what carries a recompiled '
            + 'script into it without reopening; the scene itself is kept')
        .action(() => withClient(resolve, sceneReload));

    scene
        .command('classes <base>')
        .description('classes the engine registers under a base class; the other listing is '
            + `'component types', what the editor offers to add`)
        .option('--json', 'print the structural form instead of text')
        .action((base: string, options: { json?: boolean }) =>
            withClient(resolve, client => sceneClasses(client, { base }), { json: options.json }));
}
