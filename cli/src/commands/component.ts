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
    /** Which component of the target node to take when the field is declared without a type. */
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
        throw new Error(`the node carries no component '${type}'; it carries: ${
            componentClassNames(components).join(', ') || '(none)'}`);
    }
    return { ...choice, dump: components[choice.index] };
}

/**
 * A caller spells a reference the way the tree and the asset database show it: a node path, a
 * `db://` url or a uuid. All of that becomes a uuid HERE, before the first write — an address that
 * resolves to nothing has to be refused rather than set as a value the editor silently turns into
 * null.
 */
async function targetUuid(
    client: DriverClient, kind: PropertyKind, target: TargetSpelling
): Promise<string> {
    if (target.kind === 'uuid') return target.uuid;
    if (target.kind === 'assetUrl') {
        const uuid = await client.editor.assetDb.queryUuid(target.url).catch(() => undefined);
        if (typeof uuid !== 'string' || !uuid) {
            throw new Error(`the asset database does not know '${target.url}'`);
        }
        return uuid;
    }
    if (kind === 'assetRef') {
        throw new Error(
            `'${target.path}' looks like neither an asset's db:// url nor its uuid; an asset `
            + 'reference is spelled as one of the two');
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
 * `writeReference` checks nodes and components: it asks the scene what the next load will build,
 * and for a reference into a prefab instance that is the only correct answer — the scene file holds
 * null there and the value lives in an override. Every other kind gets its persistence verdict from
 * the serializer.
 */
function verificationFor(kind: PropertyKind): VerifiedWriteOptions {
    return kind === 'nodeRef' || kind === 'componentRef' ? {} : { verify: 'serializer' };
}

export async function componentSet(client: DriverClient, spec: SetSpec): Promise<Report> {
    const nodeUuid = await resolveNode(client, spec.node);
    const component = await findComponent(client, nodeUuid, spec.component);
    const descriptor = descriptorOf(component.dump, spec.property);
    if (!descriptor) {
        throw new Error(`component '${component.className}' has no property '${spec.property}' in the live dump; it has: ${
            propertyNames(component.dump).join(', ') || '(the live dump is unavailable)'}`);
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
        throw new Error(`nothing can write property '${spec.property}' of kind '${kind}'`);
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
            note = `node references print as bare uuids: the scene could not be enumerated — ${
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
            throw new Error(`component '${component.className}' has no property '${spec.property}'; it has: ${
                propertyNames(component.dump).join(', ') || '(none)'}`);
        }
        const { index, note } = await resolveReferences(client, [reading]);
        return { kind: 'componentProperty', address, reading, references: index, note };
    }

    const { readings, hidden } = readComponentProperties(component.dump);
    const { index, note } = await resolveReferences(client, readings);
    return { kind: 'componentProperties', address, readings, hidden, references: index, note };
}

export function registerComponent(program: Command, resolve: () => Promise<Resolved>): void {
    const component = program.command('component').description('components on nodes');

    component
        .command('get <path> <type>')
        .description('read the properties of a component as the inspector holds them')
        .option('--prop <name>', 'this property only')
        .option('--json', 'print the structural form instead of text')
        .action((target: string, type: string, options: { prop?: string; json?: boolean }) =>
            withClient(resolve, client => componentGet(client, {
                node: target, component: type, property: options.prop
            }), { json: options.json }));

    component
        .command('add <path> <type>')
        .description('add a component to a node, checking that it appeared')
        .action((target: string, type: string) => withClient(resolve, async client => {
            const uuid = await resolveNode(client, target);
            const outcome = await addComponent(client, uuid, type);
            return {
                kind: 'action',
                verdict: 'ok',
                summary: outcome.alreadyPresent
                    ? `${outcome.type} already on ${target}`
                    : `${outcome.type} added to ${target}`
            };
        }));

    component
        .command('rm <path> <type>')
        .description('remove a component from a node')
        .action((target: string, type: string) => withClient(resolve, async client => {
            const uuid = await resolveNode(client, target);
            const component = await findComponent(client, uuid, type);
            const owners = await unwrap(
                client.scene.call('findComponentOwners', { className: component.className }),
                'findComponentOwners');
            const owner = owners.owners.find(entry => entry.nodeUuid === uuid);
            if (!owner) {
                throw new Error(
                    `component '${component.className}' is visible on the node, but its uuid is not among the owners of the class`);
            }
            await client.editor.scene.removeComponent({ uuid: owner.componentUuid });
            return {
                kind: 'action', verdict: 'ok', summary: `${component.className} removed from ${target}`
            };
        }));

    component
        .command('set <path> <type>')
        .description('write a component property and check whether the write survives a save')
        .requiredOption('--prop <name>', 'property name')
        .requiredOption('--value <json>', 'the value; JSON, or a string as typed; a reference is a node '
            + 'path, an asset db:// url or a uuid, and null clears it')
        .option('--target-component <type>', 'which component of the target node to take when the '
            + 'field is declared without a type')
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
