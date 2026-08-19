import { Command } from 'commander';
import type { SceneResult, SceneNodeEntry } from '@cocos-cli/shared/dist/scene-contract';
import { renderTree, DumpNode } from '../render/tree';
import { EXIT } from '../exit';
import type { DriverClient } from '../driver-client';
import type { Resolved } from '../resolve';

/**
 * `client.scene.call` типизирован контрактом `SceneMethods`, поэтому метод, его аргументы и форма
 * ответа проверяются компилятором. Здесь остаётся одно: развернуть `SceneResult` в значение или
 * в отказ. Своих интерфейсов для ответа сцены не заводи и `as` не пиши — контракт уже есть.
 */
async function unwrap<T>(
    answer: SceneResult<T> | Promise<SceneResult<T>>, method: string
): Promise<T> {
    const settled = await answer;
    if (!settled || settled.success !== true || settled.data === undefined) {
        throw new Error(
            (settled && settled.success === false && settled.error) || `scene-скрипт не ответил на ${method}`);
    }
    return settled.data;
}

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

async function withClient(
    resolve: () => Promise<Resolved>, run: (client: DriverClient) => Promise<void>
): Promise<void> {
    const resolved = await resolve();
    if (!resolved.ok) {
        process.stderr.write(resolved.message + '\n');
        process.exitCode = EXIT.NO_EDITOR;
        return;
    }
    try {
        await run(resolved.client);
    } catch (error) {
        process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
        process.exitCode = EXIT.FAILED;
    } finally {
        resolved.client.close();
    }
}

export function registerScene(program: Command, resolve: () => Promise<Resolved>): void {
    const scene = program.command('scene').description('сцена целиком');

    scene
        .command('tree')
        .description('иерархия открытой сцены')
        .option('--uuid', 'показать uuid узлов')
        .action(async (options: { uuid?: boolean }) => withClient(resolve, async client => {
            const result = await sceneTree(client, options);
            process.stdout.write(result.text + '\n');
            process.stderr.write(`узлов: ${result.count}\n`);
        }));

    scene
        .command('info')
        .description('имя, uuid и размер открытой сцены')
        .action(async () => withClient(resolve, async client => {
            process.stdout.write(await sceneInfo(client) + '\n');
        }));

    scene
        .command('open <path>')
        .description('открыть сцену по db:// пути или uuid')
        .action(async (target: string) => withClient(resolve, async client => {
            await client.editor.scene.openScene(target);
            process.stderr.write(`открыта ${target}\n`);
        }));

    scene
        .command('save')
        .description('сохранить открытую сцену')
        .action(async () => withClient(resolve, async client => {
            await client.editor.scene.saveScene();
            process.stderr.write('сцена сохранена\n');
        }));
}
