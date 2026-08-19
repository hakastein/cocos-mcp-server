import { Command } from 'commander';
import type { SceneResult } from '@cocos-cli/shared/dist/scene-contract';
import { EXIT } from '../exit';
import { withUndoBracket } from '../undo-bracket';
import type { DriverClient } from '../driver-client';
import type { Resolved } from '../resolve';

const UUID_LIKE = /^[A-Za-z0-9+/_-]{20,}$/;

/**
 * `client.scene.call` is typed by `SceneMethods`, so unwrapping it once here — as `scene.ts`
 * already does — is the only place a `SceneResult` gets turned into a value or a thrown error.
 * No local re-declaration of the answer shape, no `as`.
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

export async function resolveNode(client: DriverClient, pathOrUuid: string): Promise<string> {
    if (UUID_LIKE.test(pathOrUuid) && !pathOrUuid.includes('/')) return pathOrUuid;

    const resolved = await unwrap(client.scene.call('resolveNodePaths', [pathOrUuid]), 'resolveNodePaths');
    const resolution = resolved.resolutions[pathOrUuid];
    if (!resolution) {
        throw new Error(`'${pathOrUuid}' не был разрешён сцена-скриптом`);
    }
    if ('error' in resolution) {
        throw new Error(resolution.error);
    }
    return resolution.uuid;
}

export async function nodeGet(client: DriverClient, pathOrUuid: string): Promise<string> {
    const uuid = await resolveNode(client, pathOrUuid);
    const info = await unwrap(client.scene.call('getNodeInfo', uuid), 'getNodeInfo');
    const components = (info.components || [])
        .map(component => component.enabled === false ? `${component.type}(off)` : component.type)
        .join(',');
    return `${info.name}${info.active ? '' : '  (off)'}`
        + (components ? `  [${components}]` : '')
        + `  ${info.uuid}`;
}

export interface CreateSpec {
    parent: string;
    name: string;
    components: string[];
    pos?: [number, number, number];
}

/**
 * Скобка охватывает и структурный шаг, и настройку, чтобы созданный узел откатывался одним
 * Ctrl+Z. Провал любого шага снимает скобку: оставленная открытой запись пережила бы процесс.
 */
export async function nodeCreate(client: DriverClient, spec: CreateSpec): Promise<string> {
    const parentUuid = await resolveNode(client, spec.parent);

    const { result: created, undoNote } = await withUndoBracket(client, parentUuid, async () => {
        const createdUuid = await client.editor.scene.createNode({
            parent: parentUuid, name: spec.name
        }) as string;
        for (const type of spec.components) {
            await client.editor.scene.createComponent({ uuid: createdUuid, component: type });
        }
        if (spec.pos) {
            await client.editor.scene.setProperty({
                uuid: createdUuid,
                path: 'position',
                dump: { type: 'cc.Vec3', value: { x: spec.pos[0], y: spec.pos[1], z: spec.pos[2] } }
            });
        }
        return createdUuid;
    });

    return `ok  создан ${spec.parent}/${spec.name}  ${created}`
        + (spec.components.length ? `  [${spec.components.join(',')}]` : '')
        + (undoNote ? `  ${undoNote}` : '  undo=1');
}

export function registerNode(program: Command, resolve: () => Promise<Resolved>): void {
    const node = program.command('node').description('узлы открытой сцены');

    const withClient = async (run: (client: DriverClient) => Promise<string>) => {
        const resolved = await resolve();
        if (!resolved.ok) {
            process.stderr.write(resolved.message + '\n');
            process.exitCode = EXIT.NO_EDITOR;
            return;
        }
        try {
            process.stdout.write(await run(resolved.client) + '\n');
        } catch (error: unknown) {
            process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
            process.exitCode = EXIT.FAILED;
        } finally {
            resolved.client.close();
        }
    };

    node
        .command('get <path>')
        .description('имя, состояние и компоненты узла')
        .action((target: string) => withClient(client => nodeGet(client, target)));

    node
        .command('create')
        .description('создать узел, навесить компоненты и поставить позицию одним шагом undo')
        .requiredOption('--parent <path>', 'родительский узел')
        .requiredOption('--name <name>', 'имя нового узла')
        .option('--component <type...>', 'компоненты, которые навесить', [])
        .option('--pos <x,y,z>', 'позиция')
        .action((options: { parent: string; name: string; component: string[]; pos?: string }) =>
            withClient(client => nodeCreate(client, {
                parent: options.parent,
                name: options.name,
                components: options.component,
                pos: options.pos
                    ? options.pos.split(',').map(Number) as [number, number, number]
                    : undefined
            })));

    node
        .command('rm <path>')
        .description('удалить узел')
        .action((target: string) => withClient(async client => {
            const uuid = await resolveNode(client, target);
            await client.editor.scene.removeNode({ uuid });
            return `ok  удалён ${target}`;
        }));
}
