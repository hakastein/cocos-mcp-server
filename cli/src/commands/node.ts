import { Command } from 'commander';
import { addComponent, unwrap, withClient } from './shared';
import { withUndoBracket } from '../undo-bracket';
import type { DriverClient } from '../driver-client';
import type { Resolved } from '../resolve';

// Cocos compresses a node/component uuid to exactly 22 chars of standard base64
// (`A-Za-z0-9+/`, no `-`/`_`) — see shared/test/reference-projection.test.mjs's fixture uuids.
// A node NAME can land in this same alphabet and length, so both constraints matter.
const UUID_LIKE = /^[A-Za-z0-9+/]{22}$/;

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
 *
 * `componentPollOptions` тюнингует только опрос `addComponent` после навешивания — тестовый
 * рычаг, боевой вызов его не передаёт и получает предустановленный таймаут `settle`.
 */
export async function nodeCreate(
    client: DriverClient, spec: CreateSpec, componentPollOptions?: { timeoutMs?: number; intervalMs?: number }
): Promise<string> {
    const parentUuid = await resolveNode(client, spec.parent);

    const { result, undoNote } = await withUndoBracket(client, parentUuid, async () => {
        const createdUuid = await client.editor.scene.createNode({
            parent: parentUuid, name: spec.name
        }) as string;
        const registered: string[] = [];
        for (const type of spec.components) {
            registered.push((await addComponent(client, createdUuid, type, componentPollOptions)).type);
        }
        if (spec.pos) {
            await client.editor.scene.setProperty({
                uuid: createdUuid,
                path: 'position',
                dump: { type: 'cc.Vec3', value: { x: spec.pos[0], y: spec.pos[1], z: spec.pos[2] } }
            });
        }
        return { createdUuid, registered };
    });

    return `ok  создан ${spec.parent}/${spec.name}  ${result.createdUuid}`
        + (result.registered.length ? `  [${result.registered.join(',')}]` : '')
        + (undoNote ? `  ${undoNote}` : '  undo=1');
}

export function registerNode(program: Command, resolve: () => Promise<Resolved>): void {
    const node = program.command('node').description('узлы открытой сцены');

    node
        .command('get <path>')
        .description('имя, состояние и компоненты узла')
        .action((target: string) => withClient(resolve, async client => ({ stdout: await nodeGet(client, target) })));

    node
        .command('create')
        .description('создать узел, навесить компоненты и поставить позицию одним шагом undo')
        .requiredOption('--parent <path>', 'родительский узел')
        .requiredOption('--name <name>', 'имя нового узла')
        .option('--component <type...>', 'компоненты, которые навесить', [])
        .option('--pos <x,y,z>', 'позиция')
        .action((options: { parent: string; name: string; component: string[]; pos?: string }) =>
            withClient(resolve, async client => ({
                stdout: await nodeCreate(client, {
                    parent: options.parent,
                    name: options.name,
                    components: options.component,
                    pos: options.pos
                        ? options.pos.split(',').map(Number) as [number, number, number]
                        : undefined
                })
            })));

    node
        .command('rm <path>')
        .description('удалить узел')
        .action((target: string) => withClient(resolve, async client => {
            const uuid = await resolveNode(client, target);
            await client.editor.scene.removeNode({ uuid });
            return { stdout: `ok  удалён ${target}` };
        }));
}
