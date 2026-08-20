import type { Driver } from '@cocos-cli/shared';
import { Command } from 'commander';
import { addComponent, queryComponents, unwrap, withClient } from './shared.ts';
import { jsonFlag } from './flags.ts';
import { verifiedWrite } from '../property/verified-write.ts';
import { writerFor } from '../property/writers.ts';
import {
    componentClassNames, descriptorOf, findProperty, propertyNames, readComponentProperties,
    selectComponent
} from '../property/component-dump.ts';
import { buildReferenceIndex, referencedUuids } from '../property/reference-index.ts';
import { isReferenceKind, referenceRequest } from '../property/reference-target.ts';
import { resolveKind } from '../property/kind.ts';
import { resolveNode } from './node.ts';
import type { PollOptions } from './shared.ts';
import type { ComponentAddress, Report } from '../render/present.ts';
import type { Resolved } from '../resolve.ts';
import type { PropertyKind } from '../property/kind.ts';
import type { WriteTarget } from '../property/writers.ts';
import type { VerifiedWriteOptions } from '../property/verified-write.ts';
import type { TargetSpelling } from '../property/reference-target.ts';
import type { ComponentChoice, ComponentDump, PropertyReading } from '../property/component-dump.ts';
import type { ReferenceLabel } from '../property/reference-index.ts';

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
async function findComponent(client: Driver, nodeUuid: string, type: string): Promise<ComponentMatch> {
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
    client: Driver, kind: PropertyKind, target: TargetSpelling
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
    client: Driver, kind: PropertyKind, value: unknown
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

export async function componentSet(client: Driver, spec: SetSpec): Promise<Report> {
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

    const written = await verifiedWrite(target, value, client, verificationFor(kind));
    return {
        kind: 'write',
        target: component.className,
        writes: [{
            target: component.className, property: spec.property, value: spec.value,
            report: written.report
        }],
        undoNote: written.undoNote
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
    client: Driver, readings: PropertyReading[]
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

export async function componentGet(client: Driver, spec: GetSpec): Promise<Report> {
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

export interface AddSpec {
    node: string;
    component: string;
    /** How long the add is polled for before it counts as not having appeared. */
    poll?: PollOptions;
}

export async function componentAdd(client: Driver, spec: AddSpec): Promise<Report> {
    const uuid = await resolveNode(client, spec.node);
    const outcome = await addComponent(client, uuid, spec.component, spec.poll);
    return {
        kind: 'action',
        verdict: 'ok',
        summary: outcome.alreadyPresent
            ? `${outcome.type} already on ${spec.node}`
            : `${outcome.type} added to ${spec.node}`
    };
}

/**
 * The uuid `remove-component` takes is the component's own, which the node dump does not carry —
 * only the class-owner listing does. A class visible on the node and absent from that listing is
 * refused rather than turned into a removal of some other node's component.
 */
export async function componentRemove(
    client: Driver, spec: { node: string; component: string }
): Promise<Report> {
    const uuid = await resolveNode(client, spec.node);
    const component = await findComponent(client, uuid, spec.component);
    const owners = await unwrap(
        client.scene.call('findComponentOwners', { className: component.className }),
        'findComponentOwners');
    const owner = owners.owners.find(entry => entry.nodeUuid === uuid);
    if (!owner) {
        throw new Error(`component '${component.className}' is visible on the node, but its uuid is `
            + 'not among the owners of the class');
    }
    await client.editor.scene.removeComponent({ uuid: owner.componentUuid });
    return {
        kind: 'action', verdict: 'ok',
        summary: `${component.className} removed from ${spec.node}`
    };
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
        .action((target: string, type: string) =>
            withClient(resolve, client => componentAdd(client, { node: target, component: type })));

    component
        .command('rm <path> <type>')
        .description('remove a component from a node')
        .action((target: string, type: string) =>
            withClient(resolve, client => componentRemove(client, { node: target, component: type })));

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
            withClient(resolve, client => componentSet(client, {
                node: target, component: type, property: options.prop,
                value: jsonFlag(options.value), targetComponent: options.targetComponent
            })));
}
