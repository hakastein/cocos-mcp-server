import { Command } from 'commander';
import { addComponent, queryComponents, unwrap, withClient } from './shared';
import { verifiedWrite } from '../property/verified-write';
import { writerFor } from '../property/writers';
import {
    componentClassNames, descriptorOf, findProperty, propertyNames, readComponentProperties,
    selectComponent
} from '../property/component-dump';
import { buildReferenceIndex, referencedUuids } from '../property/reference-index';
import { isReferenceKind, referenceRequest } from '../property/reference-target';
import { resolveKind } from '../property/kind';
import { resolveNode } from './node';
import type { ComponentAddress, Report } from '../render/present';
import type { DriverClient } from '../driver-client';
import type { Resolved } from '../resolve';
import type { PropertyKind } from '../property/kind';
import type { WriteTarget } from '../property/writers';
import type { VerifiedWriteOptions } from '../property/verified-write';
import type { TargetSpelling } from '../property/reference-target';
import type { ComponentChoice, ComponentDump, PropertyReading } from '../property/component-dump';
import type { ReferenceLabel } from '../property/reference-index';

export interface SetSpec {
    node: string;
    component: string;
    property: string;
    value: unknown;
    /** Какой компонент целевого узла брать, когда поле объявлено без типа. */
    targetComponent?: string;
}

export interface GetSpec {
    node: string;
    component: string;
    property?: string;
}

interface ComponentMatch extends ComponentChoice {
    dump: ComponentDump;
}

/**
 * The class id, the property descriptors and the registered class name all live in the editor's
 * live `query-node` dump, and the dump names a class the way it is registered — `cc.Camera`, never
 * the bare `Camera` a caller may type. One query and one selection rule serve every subcommand, so
 * a spelling a read accepts is a spelling a write accepts.
 */
async function findComponent(client: DriverClient, nodeUuid: string, type: string): Promise<ComponentMatch> {
    const components = await queryComponents(client, nodeUuid);
    const choice = selectComponent(components, type);
    if (!choice) {
        throw new Error(`на узле нет компонента '${type}'; есть: ${
            componentClassNames(components).join(', ') || '(ни одного)'}`);
    }
    return { ...choice, dump: components[choice.index] };
}

/**
 * Ссылку каллер пишет так, как её видит в дереве и в базе ассетов: путём узла, db://-путём или
 * uuid. Всё это превращается в uuid ЗДЕСЬ, до первой записи, — неразрешённый адрес обязан отвалиться
 * отказом, а не набором свойства мусором, который редактор молча превращает в null.
 */
async function targetUuid(
    client: DriverClient, kind: PropertyKind, target: TargetSpelling
): Promise<string> {
    if (target.kind === 'uuid') return target.uuid;
    if (target.kind === 'assetUrl') {
        const uuid = await client.editor.assetDb.queryUuid(target.url).catch(() => undefined);
        if (typeof uuid !== 'string' || !uuid) {
            throw new Error(`база ассетов не знает '${target.url}'`);
        }
        return uuid;
    }
    if (kind === 'assetRef') {
        throw new Error(
            `'${target.path}' не похоже ни на db://-путь ассета, ни на его uuid; ссылка на ассет `
            + 'задаётся одним из них');
    }
    return resolveNode(client, target.path);
}

async function resolveReferenceValue(
    client: DriverClient, kind: PropertyKind, value: unknown
): Promise<unknown> {
    const request = referenceRequest(value);
    if ('error' in request) throw new Error(request.error);
    const uuids: string[] = [];
    for (const target of request.targets) uuids.push(await targetUuid(client, kind, target));
    if (!uuids.length) return request.array ? [] : null;
    return request.array ? uuids : uuids[0];
}

/**
 * Узлы и компоненты проверяет `writeReference`: он спрашивает сцену, что построит следующая
 * загрузка, и для ссылки внутрь инстанса префаба это единственный верный ответ — файл сцены там
 * держит null, а значение живёт в оверрайде. Всем остальным видам вердикт о сохранении даёт
 * сериализатор.
 */
function verificationFor(kind: PropertyKind): VerifiedWriteOptions {
    return kind === 'nodeRef' || kind === 'componentRef' ? {} : { verify: 'serializer' };
}

export async function componentSet(client: DriverClient, spec: SetSpec): Promise<Report> {
    const nodeUuid = await resolveNode(client, spec.node);
    const component = await findComponent(client, nodeUuid, spec.component);
    const descriptor = descriptorOf(component.dump, spec.property);
    if (!descriptor) {
        throw new Error(`у компонента '${component.className}' нет свойства '${spec.property}' в живом дампе; есть: ${
            propertyNames(component.dump).join(', ') || '(живой дамп недоступен)'}`);
    }
    const kind = resolveKind(descriptor);
    const target: WriteTarget = {
        nodeUuid,
        componentType: component.className,
        componentIndex: component.index,
        propertyPath: spec.property,
        descriptor,
        ...(spec.targetComponent ? { refOptions: { targetComponentType: spec.targetComponent } } : {})
    };

    const value = isReferenceKind(kind) ? await resolveReferenceValue(client, kind, spec.value) : spec.value;
    if (!writerFor(target, value)) {
        throw new Error(`свойство '${spec.property}' вида '${kind}' записывать нечем`);
    }

    return {
        kind: 'propertyWrite',
        component: component.className,
        property: spec.property,
        value: spec.value,
        report: await verifiedWrite(target, value, client, verificationFor(kind))
    };
}

interface ResolvedReferences {
    index: Map<string, ReferenceLabel>;
    note?: string;
}

/**
 * One scene dump names every node and component reference at once; an asset costs one call each.
 * A lookup that fails leaves the uuid bare and says so on stderr.
 */
async function resolveReferences(
    client: DriverClient, readings: PropertyReading[]
): Promise<ResolvedReferences> {
    const wanted = referencedUuids(readings);
    const index = new Map<string, ReferenceLabel>();
    let note: string | undefined;

    if (wanted.scene.length) {
        try {
            const dump = await unwrap(client.scene.call('dumpSceneNodes'), 'dumpSceneNodes');
            const scene = buildReferenceIndex(dump.nodes);
            for (const uuid of wanted.scene) {
                const label = scene.get(uuid);
                if (label) index.set(uuid, label);
            }
        } catch (error) {
            note = `ссылки на узлы напечатаны голыми uuid: сцену не удалось перечислить — ${
                error instanceof Error ? error.message : String(error)}`;
        }
    }
    for (const uuid of wanted.assets) {
        const url = await client.editor.assetDb.queryUrl(uuid).catch(() => undefined);
        if (typeof url === 'string' && url) index.set(uuid, { kind: 'asset', path: url });
    }
    return { index, note };
}

export async function componentGet(client: DriverClient, spec: GetSpec): Promise<Report> {
    const nodeUuid = await resolveNode(client, spec.node);
    const component = await findComponent(client, nodeUuid, spec.component);
    const address: ComponentAddress = { nodePath: spec.node, nodeUuid, choice: component };

    if (spec.property) {
        const reading = findProperty(component.dump, spec.property);
        if (!reading) {
            throw new Error(`у компонента '${component.className}' нет свойства '${spec.property}'; есть: ${
                propertyNames(component.dump).join(', ') || '(ни одного)'}`);
        }
        const { index, note } = await resolveReferences(client, [reading]);
        return { kind: 'componentProperty', address, reading, references: index, note };
    }

    const { readings, hidden } = readComponentProperties(component.dump);
    const { index, note } = await resolveReferences(client, readings);
    return { kind: 'componentProperties', address, readings, hidden, references: index, note };
}

export function registerComponent(program: Command, resolve: () => Promise<Resolved>): void {
    const component = program.command('component').description('компоненты на узлах');

    component
        .command('get <path> <type>')
        .description('прочитать свойства компонента такими, какими их держит инспектор')
        .option('--prop <name>', 'только это свойство')
        .option('--json', 'выдать структурную форму вместо текста')
        .action((target: string, type: string, options: { prop?: string; json?: boolean }) =>
            withClient(resolve, client => componentGet(client, {
                node: target, component: type, property: options.prop
            }), { json: options.json }));

    component
        .command('add <path> <type>')
        .description('навесить компонент на узел, проверив, что он появился')
        .action((target: string, type: string) => withClient(resolve, async client => {
            const uuid = await resolveNode(client, target);
            const outcome = await addComponent(client, uuid, type);
            return {
                kind: 'action',
                verdict: 'ok',
                summary: outcome.alreadyPresent
                    ? `${outcome.type} уже на ${target}`
                    : `${outcome.type} навешен на ${target}`
            };
        }));

    component
        .command('rm <path> <type>')
        .description('снять компонент с узла')
        .action((target: string, type: string) => withClient(resolve, async client => {
            const uuid = await resolveNode(client, target);
            const component = await findComponent(client, uuid, type);
            const owners = await unwrap(
                client.scene.call('findComponentOwners', { className: component.className }),
                'findComponentOwners');
            const owner = owners.owners.find(entry => entry.nodeUuid === uuid);
            if (!owner) {
                throw new Error(
                    `компонент '${component.className}' виден на узле, но его uuid не нашёлся среди владельцев класса`);
            }
            await client.editor.scene.removeComponent({ uuid: owner.componentUuid });
            return {
                kind: 'action', verdict: 'ok', summary: `${component.className} снят с ${target}`
            };
        }));

    component
        .command('set <path> <type>')
        .description('записать свойство компонента и проверить, переживёт ли запись сохранение')
        .requiredOption('--prop <name>', 'имя свойства')
        .requiredOption('--value <json>', 'значение; JSON, либо строка как есть; ссылка — путь узла, '
            + 'db://-путь ассета или uuid, null очищает')
        .option('--target-component <type>', 'какой компонент целевого узла брать, когда поле '
            + 'объявлено без типа')
        .action((target: string, type: string,
            options: { prop: string; value: string; targetComponent?: string }) =>
            withClient(resolve, async client => {
                let value: unknown = options.value;
                try { value = JSON.parse(options.value); } catch { }
                return componentSet(client, {
                    node: target, component: type, property: options.prop, value,
                    targetComponent: options.targetComponent
                });
            }));
}
