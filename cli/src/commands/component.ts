import { Command } from 'commander';
import { addComponent, unwrap, withClient } from './shared';
import { withUndoBracket } from '../undo-bracket';
import { renderWriteReport } from '../render/report';
import { readBackMatches, typedDump } from '../property/writers';
import { projectValue } from '../property/readers';
import { isDumpDescriptor, resolveKind } from '../property/kind';
import { resolveNode } from './node';
import type { DriverClient } from '../driver-client';
import type { Resolved } from '../resolve';
import type { PropertyDescriptor } from '../property/kind';

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

interface ComponentSnapshot {
    cid: string | undefined;
    descriptor: PropertyDescriptor | undefined;
    properties: string[];
}

/**
 * The registered class id and a property's own dump descriptor both live only in the editor's
 * live `query-node` snapshot — `getNodeInfo` (the typed scene method) carries neither. One query
 * answers both, the same route `property/writers.ts`'s `componentCid`/`readBack` already read.
 */
async function queryComponentSnapshot(
    client: DriverClient, nodeUuid: string, componentIndex: number, property: string
): Promise<ComponentSnapshot> {
    const node = await client.editor.scene.queryNode(nodeUuid) as {
        __comps__?: Array<Record<string, unknown> & { value?: Record<string, unknown> }>;
    };
    const component = node && node.__comps__ && node.__comps__[componentIndex];
    if (!component) return { cid: undefined, descriptor: undefined, properties: [] };
    const cid = component.__type__ ?? component.cid ?? component.type;
    const properties = component.value ? Object.keys(component.value) : [];
    const raw = component.value && component.value[property];
    return {
        cid: typeof cid === 'string' ? cid : undefined,
        descriptor: isDumpDescriptor(raw) ? raw : undefined,
        properties
    };
}

/**
 * The serializer writes backing fields, so the accessor `color` is emitted as `_color`; asking
 * for the accessor name alone answers `found:false` for a property the file does carry. Same
 * fallback `property/verified-write.ts`'s `serializedValue` uses.
 */
function propertySpellings(property: string): string[] {
    const underscored = property.replace(/(^|\.)([^.]+)$/, '$1_$2');
    return underscored === property || /(^|\.)_/.test(property) ? [property] : [property, underscored];
}

interface SerializedLookup {
    found: boolean;
    value?: unknown;
    unnamedReference?: boolean;
    problem?: string;
}

async function findSerializedValue(
    client: DriverClient, nodeUuid: string, cid: string, property: string
): Promise<SerializedLookup> {
    let problem = '';
    for (const spelling of propertySpellings(property)) {
        const answer = await client.scene.call('serializedComponentValue', nodeUuid, cid, spelling);
        if (answer.success !== true) { problem = answer.error; continue; }
        if (answer.data.found) return { found: true, value: answer.data.value, unnamedReference: answer.data.unnamedReference };
        problem = answer.data.reason || `сериализатор не отдаёт свойство '${spelling}'`;
    }
    return { found: false, problem };
}

export async function componentSet(client: DriverClient, spec: SetSpec): Promise<string> {
    const nodeUuid = await resolveNode(client, spec.node);
    const component = await findComponent(client, nodeUuid, spec.component);
    const snapshot = await queryComponentSnapshot(client, nodeUuid, component.index, spec.property);
    if (!snapshot.descriptor) {
        throw new Error(`у компонента '${spec.component}' нет свойства '${spec.property}' в живом дампе; есть: ${
            snapshot.properties.join(', ') || '(живой дамп недоступен)'}`);
    }
    const kind = resolveKind(snapshot.descriptor);
    const dump = typedDump(snapshot.descriptor, kind, spec.value) as { value: unknown };

    const { result: written, undoNote } = await withUndoBracket(client, nodeUuid, () =>
        client.editor.scene.setProperty({
            uuid: nodeUuid,
            path: `__comps__.${component.index}.${spec.property}`,
            dump
        }));

    let persisted: boolean | null = null;
    let detail: string | undefined;
    if (snapshot.cid === undefined) {
        detail = 'класс компонента не удалось прочитать из живого дампа, вывод о сохранении не делается';
    } else {
        const found = await findSerializedValue(client, nodeUuid, snapshot.cid, spec.property);
        if (!found.found) {
            detail = found.problem || 'сериализатор не отдаёт это свойство';
        } else if (found.unnamedReference) {
            detail = 'сериализатор ссылается на узел по позиции без сопоставления, вывод о сохранении не делается';
        } else {
            // Both sides projected the same way: `dump.value` is what setProperty actually sent, the
            // raw `spec.value` a caller typed ('#ff0000') is not what the serializer ever echoes back.
            const expected = projectValue(kind, dump.value);
            const actual = projectValue(kind, found.value);
            persisted = readBackMatches(expected, actual);
            if (!persisted) detail = `сериализатор отдаёт другое значение: ${JSON.stringify(actual)}`;
        }
    }

    return renderWriteReport({
        component: spec.component,
        property: spec.property,
        value: spec.value,
        report: { written: written === true, verified: persisted !== null, persisted, channel: 'editor', detail },
        undoNote: undoNote ?? undefined
    });
}

export function registerComponent(program: Command, resolve: () => Promise<Resolved>): void {
    const component = program.command('component').description('компоненты на узлах');

    component
        .command('add <path> <type>')
        .description('навесить компонент на узел, проверив, что он появился')
        .action((target: string, type: string) => withClient(resolve, async client => {
            const uuid = await resolveNode(client, target);
            const outcome = await addComponent(client, uuid, type);
            return { stdout: outcome.alreadyPresent
                ? `ok  ${outcome.type} уже на ${target}`
                : `ok  ${outcome.type} навешен на ${target}` };
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
