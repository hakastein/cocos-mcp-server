import { Command } from 'commander';
import type { SceneNodeEntry } from '@cocos-cli/shared';
import { renderTree, DumpNode } from '../render/tree';
import { unwrap, withClient } from './shared';
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
): Promise<{ text: string; count: number }> {
    const dump = await unwrap(client.scene.call('dumpSceneNodes'), 'dumpSceneNodes');
    const nodes = (dump.nodes || []).map(toDumpNode);
    return {
        count: nodes.length,
        text: nodes.length ? renderTree(nodes, { uuid: options.uuid }) : 'сцена пуста — нет узлов'
    };
}

export async function sceneInfo(client: DriverClient): Promise<string> {
    const info = await unwrap(client.scene.call('getCurrentSceneInfo'), 'getCurrentSceneInfo');
    return `${info.name}  ${info.uuid}  узлов: ${info.nodeCount}`;
}

export function registerScene(program: Command, resolve: () => Promise<Resolved>): void {
    const scene = program.command('scene').description('сцена целиком');

    scene
        .command('tree')
        .description('иерархия открытой сцены')
        .option('--uuid', 'показать uuid узлов')
        .action((options: { uuid?: boolean }) => withClient(resolve, async client => {
            const result = await sceneTree(client, options);
            return { stdout: result.text, stderr: `узлов: ${result.count}` };
        }));

    scene
        .command('info')
        .description('имя, uuid и размер открытой сцены')
        .action(() => withClient(resolve, async client => ({ stdout: await sceneInfo(client) })));

    scene
        .command('open <path>')
        .description('открыть сцену по db:// пути или uuid')
        .action((target: string) => withClient(resolve, async client => {
            await client.editor.scene.openScene(target);
            return { stderr: `открыта ${target}` };
        }));

    scene
        .command('save')
        .description('сохранить открытую сцену')
        .action(() => withClient(resolve, async client => {
            await client.editor.scene.saveScene();
            return { stderr: 'сцена сохранена' };
        }));
}
