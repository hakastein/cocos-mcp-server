import { Command } from 'commander';
import { unwrap, withClient } from './shared';
import { withUndoBracket } from '../undo-bracket';
import { renderWriteReport } from '../render/report';
import { readBackMatches } from '../property/writers';
import { resolveNode } from './node';
import type { DriverClient } from '../driver-client';
import type { Resolved } from '../resolve';

export interface SetSpec {
    node: string;
    component: string;
    property: string;
    value: unknown;
}

interface ComponentMatch {
    type: string;
    enabled: boolean;
    index: number;
}

async function findComponent(client: DriverClient, nodeUuid: string, type: string): Promise<ComponentMatch> {
    const info = await unwrap(client.scene.call('getNodeInfo', nodeUuid), 'getNodeInfo');
    const components = info.components || [];
    const index = components.findIndex(component => component.type === type);
    if (index === -1) {
        throw new Error(`на узле нет компонента '${type}'; есть: ${
            components.map(component => component.type).join(', ') || '(ни одного)'}`);
    }
    return { ...components[index], index };
}

async function componentClassId(
    client: DriverClient, nodeUuid: string, componentIndex: number
): Promise<string | undefined> {
    const node = await client.editor.scene.queryNode(nodeUuid) as { __comps__?: Array<Record<string, unknown>> };
    const component = node && node.__comps__ && node.__comps__[componentIndex];
    if (!component) return undefined;
    const cid = component.__type__ ?? component.cid ?? component.type;
    return typeof cid === 'string' ? cid : undefined;
}

export async function componentSet(client: DriverClient, spec: SetSpec): Promise<string> {
    const nodeUuid = await resolveNode(client, spec.node);
    const component = await findComponent(client, nodeUuid, spec.component);

    const { result: written, undoNote } = await withUndoBracket(client, nodeUuid, async () =>
        await client.editor.scene.setProperty({
            uuid: nodeUuid,
            path: `__comps__.${component.index}.${spec.property}`,
            dump: { value: spec.value }
        }) as boolean);

    let persisted: boolean | null = null;
    let detail: string | undefined;
    const cid = await componentClassId(client, nodeUuid, component.index);
    if (cid === undefined) {
        detail = 'класс компонента не удалось прочитать из живого дампа, вывод о сохранении не делается';
    } else {
        const answer = await client.scene.call('serializedComponentValue', nodeUuid, cid, spec.property);
        if (answer.success !== true) {
            detail = answer.error;
        } else if (!answer.data.found) {
            detail = answer.data.reason || 'сериализатор не отдаёт это свойство';
        } else if (answer.data.unnamedReference) {
            detail = 'сериализатор ссылается на узел по позиции без сопоставления, вывод о сохранении не делается';
        } else {
            persisted = readBackMatches(spec.value, answer.data.value);
            if (!persisted) detail = `сериализатор отдаёт другое значение: ${JSON.stringify(answer.data.value)}`;
        }
    }

    return renderWriteReport({
        component: spec.component,
        property: spec.property,
        value: spec.value,
        report: { written, verified: persisted !== null, persisted, channel: 'editor', detail },
        undoNote: undoNote ?? undefined
    });
}

export function registerComponent(program: Command, resolve: () => Promise<Resolved>): void {
    const component = program.command('component').description('компоненты на узлах');

    component
        .command('add <path> <type>')
        .description('навесить компонент на узел')
        .action((target: string, type: string) => withClient(resolve, async client => {
            const uuid = await resolveNode(client, target);
            await client.editor.scene.createComponent({ uuid, component: type });
            return { stdout: `ok  ${type} навешен на ${target}` };
        }));

    component
        .command('rm <path> <type>')
        .description('снять компонент с узла')
        .action((target: string, type: string) => withClient(resolve, async client => {
            const uuid = await resolveNode(client, target);
            await findComponent(client, uuid, type);
            const owners = await unwrap(
                client.scene.call('findComponentOwners', { className: type }), 'findComponentOwners');
            const owner = owners.owners.find(entry => entry.nodeUuid === uuid);
            if (!owner) {
                throw new Error(`компонент '${type}' виден на узле, но его uuid не нашёлся среди владельцев класса`);
            }
            await client.editor.scene.removeComponent({ uuid: owner.componentUuid });
            return { stdout: `ok  ${type} снят с ${target}` };
        }));

    component
        .command('set <path> <type>')
        .description('записать свойство компонента и проверить, переживёт ли запись сохранение')
        .requiredOption('--prop <name>', 'имя свойства')
        .requiredOption('--value <json>', 'значение; JSON, либо строка как есть')
        .action((target: string, type: string, options: { prop: string; value: string }) =>
            withClient(resolve, async client => {
                let value: unknown = options.value;
                try { value = JSON.parse(options.value); } catch { }
                return { stdout: await componentSet(client, {
                    node: target, component: type, property: options.prop, value
                }) };
            }));
}
