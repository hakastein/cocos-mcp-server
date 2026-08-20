import { Command } from 'commander';
import type { SceneNodeEntry } from '@cocos-cli/shared';
import { unwrap, withClient } from './shared';
import { resolveNode } from './node';
import type { DumpNode, Report } from '../render/present';
import type { DriverClient } from '../driver-client';
import type { Resolved } from '../resolve';

/** `parentUuid` реально бывает `null` только у самого корня сцены, который в дамп не попадает; тип
 * контракта его всё же допускает, а `renderTree` сравнивает parentUuid как обычный ключ Map/Set. */
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
    client: DriverClient, options: { uuid?: boolean }
): Promise<Report> {
    const dump = await unwrap(client.scene.call('dumpSceneNodes'), 'dumpSceneNodes');
    return {
        kind: 'sceneTree',
        nodes: (dump.nodes || []).map(toDumpNode),
        options: { uuid: options.uuid }
    };
}

export async function sceneInfo(client: DriverClient): Promise<Report> {
    const info = await unwrap(client.scene.call('getCurrentSceneInfo'), 'getCurrentSceneInfo');
    return {
        kind: 'action',
        verdict: 'ok',
        summary: `${info.name}  ${info.uuid}  узлов: ${info.nodeCount}`
    };
}

export function registerScene(program: Command, resolve: () => Promise<Resolved>): void {
    const scene = program.command('scene').description('сцена целиком');

    scene
        .command('tree')
        .description('иерархия открытой сцены')
        .option('--uuid', 'показать uuid узлов')
        .action((options: { uuid?: boolean }) => withClient(resolve, client => sceneTree(client, options)));

    scene
        .command('info')
        .description('имя, uuid и размер открытой сцены')
        .action(() => withClient(resolve, sceneInfo));

    scene
        .command('owners <class>')
        .description('какие узлы открытой сцены несут этот класс компонента')
        .option('--active-only', 'пропустить узлы, выключенные в иерархии')
        .option('--json', 'выдать структурную форму вместо текста')
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
        .description('расходится ли открытая сцена с файлом на диске, и где именно')
        .option('--json', 'выдать структурную форму вместо текста')
        .action((options: { json?: boolean }) => withClient(resolve, async client => ({
            kind: 'sceneDirty',
            dirty: await unwrap(client.scene.call('sceneDirtyAgainstDisk'), 'sceneDirtyAgainstDisk')
        }), { json: options.json }));

    scene
        .command('missing')
        .description('компоненты, чей скрипт больше не резолвится — этот слот роняет превью')
        .option('--root <path>', 'смотреть только под этим узлом')
        .option('--json', 'выдать структурную форму вместо текста')
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
        .description('открыть сцену по db:// пути или uuid')
        .action((target: string) => withClient(resolve, async client => {
            await client.editor.scene.openScene(target);
            return { kind: 'action', verdict: 'ok', summary: `открыта ${target}` };
        }));

    scene
        .command('save')
        .description('сохранить открытую сцену')
        .action(() => withClient(resolve, async client => {
            await client.editor.scene.saveScene();
            return { kind: 'action', verdict: 'ok', summary: 'сцена сохранена' };
        }));
}
