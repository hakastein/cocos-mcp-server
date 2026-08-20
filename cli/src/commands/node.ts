import { Command } from 'commander';
import { addComponent, unwrap, withClient } from './shared';
import { withUndoBracket } from '../undo-bracket';
import { settle } from '../settle';
import { classifyNode } from '../node-type';
import { nodePropertyOf, nodeSnapshotOf } from '../node-snapshot';
import {
    TRANSFORM_KINDS, normalizedTransform, parseVec3, sameVec3
} from '../node-transform';
import { nodeWriteFailed, nodeWriteNote, renderNodeWrite } from '../render/node';
import type { NodeProperty, NodeSnapshot } from '../node-snapshot';
import type { TransformKind, Vec3Parts } from '../node-transform';
import type { NodeWriteReport } from '../render/node';
import type { CommandOutput } from './shared';
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

async function snapshotOf(client: DriverClient, uuid: string): Promise<NodeSnapshot> {
    const snapshot = nodeSnapshotOf(await client.editor.scene.queryNode(uuid), uuid);
    if (!snapshot) throw new Error(`узла ${uuid} нет в открытой сцене`);
    return snapshot;
}

export interface SetSpec {
    name?: string;
    active?: boolean;
    layer?: number;
    position?: Vec3Parts;
    rotation?: Vec3Parts;
    scale?: Vec3Parts;
}

/**
 * Скалярные свойства и трансформ пишутся одной скобкой: `--name` вместе с `--pos` должны отходить
 * одним Ctrl+Z, а не двумя. Каждая запись читается обратно, и первая же не дошедшая обрывает
 * остальные — дописывать поверх узла, который не принял предыдущее, значит копить расхождение.
 */
export async function nodeSet(
    client: DriverClient, target: string, spec: SetSpec,
    pollOptions?: { timeoutMs?: number; intervalMs?: number }
): Promise<CommandOutput> {
    const uuid = await resolveNode(client, target);
    const before = await snapshotOf(client, uuid);
    const nodeType = classifyNode(before.componentTypes, before.layer).nodeType;

    const report: NodeWriteReport = { target, applied: [], warnings: [], nodeType };

    const { undoNote } = await withUndoBracket(client, uuid, async () => {
        const scalars: Array<[NodeProperty, unknown]> = [];
        if (spec.name !== undefined) scalars.push(['name', spec.name]);
        if (spec.active !== undefined) scalars.push(['active', spec.active]);
        if (spec.layer !== undefined) scalars.push(['layer', spec.layer]);

        for (const [property, value] of scalars) {
            await client.editor.scene.setProperty({ uuid, path: property, dump: { value } as never });
            let observed: unknown;
            const landed = await settle(async () => {
                observed = nodePropertyOf(await snapshotOf(client, uuid), property);
                return observed === value;
            }, pollOptions);
            if (!landed) {
                report.unapplied = { property, expected: value, observed };
                return;
            }
            report.applied.push({ property, value });
        }

        for (const kind of TRANSFORM_KINDS) {
            const given = spec[kind as TransformKind];
            if (!given) continue;
            const current = await snapshotOf(client, uuid);
            const normalized = normalizedTransform(given, current[kind], kind, nodeType);
            if (normalized.warning) report.warnings.push(normalized.warning);

            await client.editor.scene.setProperty({
                uuid, path: kind, dump: { type: 'cc.Vec3', value: normalized.value } as never
            });
            let observed = current[kind];
            const landed = await settle(async () => {
                observed = (await snapshotOf(client, uuid))[kind];
                return sameVec3(observed, normalized.value);
            }, pollOptions);
            if (!landed) {
                report.unapplied = { property: kind, expected: normalized.value, observed };
                return;
            }
            report.applied.push({ property: kind, value: normalized.value });
        }
    });
    if (undoNote) report.undoNote = undoNote;

    const note = nodeWriteNote(report);
    return {
        stdout: renderNodeWrite(report),
        stderr: note || undefined,
        failed: nodeWriteFailed(report)
    };
}

/**
 * Редактор применяет репарент асинхронно и часть из них молча игнорирует, поэтому новый родитель
 * опрашивается до тех пор, пока не встанет; не вставший называет того, кто у узла на самом деле.
 */
export async function nodeMove(
    client: DriverClient, target: string, parent: string, keepWorldTransform: boolean,
    pollOptions?: { timeoutMs?: number; intervalMs?: number }
): Promise<CommandOutput> {
    const uuid = await resolveNode(client, target);
    const parentUuid = await resolveNode(client, parent);
    if (uuid === parentUuid) throw new Error(`${target} не может быть родителем самому себе`);

    const { undoNote } = await withUndoBracket(client, uuid, () =>
        client.editor.scene.setParent({ parent: parentUuid, uuids: [uuid], keepWorldTransform }));

    let actual: string | null = null;
    const moved = await settle(async () => {
        actual = (await snapshotOf(client, uuid)).parent;
        return actual === parentUuid;
    }, pollOptions);
    if (!moved) {
        return {
            stdout: `НЕ ПЕРЕНЕСЁН  ${target}  родитель по-прежнему ${actual || 'неизвестен'}`
                + `, ожидался ${parentUuid}`,
            failed: true
        };
    }
    return {
        stdout: `ok  ${target} перенесён под ${parent}  ${uuid}`
            + (keepWorldTransform ? '  мировой трансформ сохранён' : '')
            + (undoNote ? `  ${undoNote}` : '  undo=1')
    };
}

export async function nodeDuplicate(
    client: DriverClient, target: string,
    pollOptions?: { timeoutMs?: number; intervalMs?: number }
): Promise<CommandOutput> {
    const uuid = await resolveNode(client, target);
    const { result, undoNote } = await withUndoBracket(client, uuid, () =>
        client.editor.scene.duplicateNode(uuid));
    const created = Array.isArray(result) ? result[0] : result;
    if (typeof created !== 'string' || !created) {
        throw new Error(`редактор не назвал uuid копии ${target}`);
    }

    const appeared = await settle(
        () => snapshotOf(client, created).then(() => true, () => false), pollOptions);
    if (!appeared) {
        return {
            stdout: `НЕ СКОПИРОВАН  редактор ответил uuid ${created}, но такого узла в сцене нет`,
            failed: true
        };
    }
    const copy = await snapshotOf(client, created);
    return {
        stdout: `ok  ${target} скопирован как ${copy.name}  ${created}`
            + (undoNote ? `  ${undoNote}` : '  undo=1')
    };
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
        .command('set <path>')
        .description('записать свойства самого узла — имя, active, слой, трансформ — одним шагом undo')
        .option('--name <name>', 'переименовать узел')
        .option('--active <bool>', 'включить или выключить узел')
        .option('--layer <n>', 'слой узла')
        .option('--pos <x,y,z>', 'локальная позиция; пустая ось остаётся как была (1,,3)')
        .option('--rot <x,y,z>', 'локальный поворот в углах Эйлера')
        .option('--scale <x,y,z>', 'локальный масштаб')
        .action((target: string, options: {
            name?: string; active?: string; layer?: string; pos?: string; rot?: string; scale?: string
        }) => withClient(resolve, client => {
            if (options.active !== undefined && options.active !== 'true' && options.active !== 'false') {
                throw new Error(`--active принимает true или false; получено ${JSON.stringify(options.active)}`);
            }
            const layer = options.layer === undefined ? undefined : Number(options.layer);
            if (layer !== undefined && !Number.isFinite(layer)) {
                throw new Error(`--layer принимает число; получено ${JSON.stringify(options.layer)}`);
            }
            return nodeSet(client, target, {
                name: options.name,
                active: options.active === undefined ? undefined : options.active === 'true',
                layer,
                position: options.pos === undefined ? undefined : parseVec3(options.pos),
                rotation: options.rot === undefined ? undefined : parseVec3(options.rot),
                scale: options.scale === undefined ? undefined : parseVec3(options.scale)
            });
        }));

    node
        .command('mv <path>')
        .description('перевесить узел под другого родителя')
        .requiredOption('--parent <path>', 'новый родитель')
        .option('--keep-world', 'сохранить мировой трансформ вместо локального')
        .action((target: string, options: { parent: string; keepWorld?: boolean }) =>
            withClient(resolve, client =>
                nodeMove(client, target, options.parent, options.keepWorld === true)));

    node
        .command('dup <path>')
        .description('скопировать узел вместе с поддеревом, соседом оригинала')
        .action((target: string) =>
            withClient(resolve, client => nodeDuplicate(client, target)));

    node
        .command('rm <path>')
        .description('удалить узел')
        .action((target: string) => withClient(resolve, async client => {
            const uuid = await resolveNode(client, target);
            await client.editor.scene.removeNode({ uuid });
            return { stdout: `ok  удалён ${target}` };
        }));
}
