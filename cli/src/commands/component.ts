import type { Driver } from '@cocos-cli/shared';
import { Command } from 'commander';
import { unwrap, withClient } from './shared.ts';
import { addComponent, queryComponents } from '../component-add.ts';
import { jsonFlag, requiredNumberFlag } from './flags.ts';
import { verifiedWrite, withSerializerVerdict } from '../property/verified-write.ts';
import { readBack, readBackMismatches, componentPath, writerFor } from '../property/writers.ts';
import { withUndoBracket } from '../undo-bracket.ts';
import {
    componentClassNames, descriptorOf, findProperty, propertyNames, readComponentProperties,
    selectComponent
} from '../property/component-dump.ts';
import { buildReferenceIndex, referencedUuids } from '../property/reference-index.ts';
import { isReferenceKind, referenceRequest } from '../property/reference-target.ts';
import { resolveKind } from '../property/kind.ts';
import { resolveNode } from './node.ts';
import type { PollOptions } from '../component-add.ts';
import type { WriteReport } from '@cocos-cli/shared';
import type { ComponentAddress, RenderedWrite, Report } from '../render/present.ts';
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

export async function componentRemove(
    client: Driver, spec: { node: string; component: string }
): Promise<Report> {
    const uuid = await resolveNode(client, spec.node);
    const component = await findComponent(client, uuid, spec.component);
    await client.editor.scene.removeComponent({
        uuid: await componentUuid(client, uuid, component.className)
    });
    return {
        kind: 'action', verdict: 'ok',
        summary: `${component.className} removed from ${spec.node}`
    };
}

/**
 * `remove-component` and `reset-component` both take the component's OWN uuid, which the node dump
 * does not carry — only the class-owner listing does.
 */
async function componentUuid(
    client: Driver, nodeUuid: string, className: string
): Promise<string> {
    const owners = await unwrap(
        client.scene.call('findComponentOwners', { className }), 'findComponentOwners');
    const owner = owners.owners.find(entry => entry.nodeUuid === nodeUuid);
    if (!owner) {
        throw new Error(`component '${className}' is visible on the node, but its uuid is not `
            + 'among the owners of the class');
    }
    return owner.componentUuid;
}

function changedProperties(before: PropertyReading[], after: PropertyReading[]): PropertyReading[] {
    const was = new Map(before.map(reading => [reading.name, JSON.stringify(reading.value)]));
    return after.filter(reading =>
        was.has(reading.name) && was.get(reading.name) !== JSON.stringify(reading.value));
}

/**
 * The editor answers nothing at all for `reset-component`, so what it did is read off the dump:
 * the properties whose value moved are the whole outcome, and each of them is then asked of the
 * serializer. That question is not idle here — checked live 2026-08-21 on `cc_hero`, a prefab
 * instance: resetting `Health.maxHp` moved the live value and recorded NO override, so the next
 * load rebuilds the prefab's value and the reset is gone. That reads as `UNPERSISTED`.
 */
export async function componentReset(
    client: Driver, spec: { node: string; component: string }
): Promise<Report> {
    const nodeUuid = await resolveNode(client, spec.node);
    const component = await findComponent(client, nodeUuid, spec.component);
    const uuid = await componentUuid(client, nodeUuid, component.className);
    const before = readComponentProperties(component.dump).readings;

    const { undoNote } = await withUndoBracket(client, nodeUuid,
        () => client.editor.scene.resetComponent({ uuid }));

    const reset = await findComponent(client, nodeUuid, spec.component);
    const changed = changedProperties(before, readComponentProperties(reset.dump).readings);

    const writes: RenderedWrite[] = [];
    for (const reading of changed) {
        const descriptor = descriptorOf(reset.dump, reading.name);
        const report: WriteReport = {
            written: true, verified: true, persisted: null, channel: 'editor'
        };
        writes.push({
            target: component.className,
            property: reading.name,
            value: reading.value,
            report: descriptor === null ? report : await withSerializerVerdict(report, {
                nodeUuid,
                componentType: component.className,
                componentIndex: component.index,
                propertyPath: reading.name,
                descriptor
            }, client)
        });
    }

    return { kind: 'write', target: component.className, writes, undoNote };
}

export interface ArraySpec {
    node: string;
    component: string;
    property: string;
    index: number;
}

export interface ArrayMoveSpec extends ArraySpec {
    offset: number;
}

interface ArrayEdit {
    target: WriteTarget;
    className: string;
    elements: unknown[];
}

async function arrayEdit(client: Driver, spec: ArraySpec): Promise<ArrayEdit> {
    const nodeUuid = await resolveNode(client, spec.node);
    const component = await findComponent(client, nodeUuid, spec.component);
    const descriptor = descriptorOf(component.dump, spec.property);
    if (!descriptor) {
        throw new Error(`component '${component.className}' has no property '${spec.property}'; it has: ${
            propertyNames(component.dump).join(', ') || '(the live dump is unavailable)'}`);
    }
    const target: WriteTarget = {
        nodeUuid,
        componentType: component.className,
        componentIndex: component.index,
        propertyPath: spec.property,
        descriptor
    };
    const elements = await readBack(target, client);
    if (!Array.isArray(elements)) {
        throw new Error(`'${component.className}.${spec.property}' is not an array`);
    }
    if (!Number.isInteger(spec.index) || spec.index < 0 || spec.index >= elements.length) {
        throw new Error(`--index ${spec.index} is outside '${component.className}.${spec.property}', `
            + `which holds ${elements.length} element(s)`);
    }
    return { target, className: component.className, elements };
}

/**
 * Both array messages answer `true` for an index they then ignore — checked live 2026-08-21, a
 * remove at index 99 of a three-element array answered `true` and removed nothing. So the answer
 * is not read: the array is read back and compared against the order this edit asked for.
 */
interface ArrayOutcome {
    /** The order the array holds if the edit landed, which is what the read-back is judged against. */
    expected: unknown[];
    /** What the edit did, in the past tense, for the tail of the printed line. */
    detail: string;
    issue: () => Promise<unknown>;
}

async function arrayWrite(
    client: Driver, edit: ArrayEdit, outcome: ArrayOutcome
): Promise<Report> {
    const { undoNote } = await withUndoBracket(client, edit.target.nodeUuid, outcome.issue);

    const observed = await readBack(edit.target, client);
    const mismatches = readBackMismatches(outcome.expected, observed, edit.target.propertyPath);
    const written: WriteReport = mismatches.length === 0
        ? { written: true, verified: true, persisted: null, channel: 'editor', detail: outcome.detail }
        : {
            written: true, verified: false, persisted: null, channel: 'editor',
            detail: `${outcome.detail}; read-back disagrees — ${mismatches.join('; ')}`
        };

    return {
        kind: 'write',
        target: edit.className,
        writes: [{
            target: edit.className,
            property: edit.target.propertyPath,
            report: written.verified
                ? await withSerializerVerdict(written, edit.target, client)
                : written
        }],
        undoNote
    };
}

export async function componentArrayMove(client: Driver, spec: ArrayMoveSpec): Promise<Report> {
    const edit = await arrayEdit(client, spec);
    const landing = spec.index + spec.offset;
    if (landing < 0 || landing >= edit.elements.length) {
        throw new Error(`--offset ${spec.offset} takes element ${spec.index} outside `
            + `'${edit.className}.${spec.property}', which holds ${edit.elements.length} element(s)`);
    }
    const expected = edit.elements.slice();
    expected.splice(landing, 0, expected.splice(spec.index, 1)[0]);

    return arrayWrite(client, edit, {
        expected,
        detail: `element ${spec.index} moved to ${landing} of ${edit.elements.length}`,
        issue: () => client.editor.scene.moveArrayElement({
            uuid: edit.target.nodeUuid,
            path: componentPath(edit.target),
            target: spec.index,
            offset: spec.offset
        })
    });
}

export async function componentArrayRemove(client: Driver, spec: ArraySpec): Promise<Report> {
    const edit = await arrayEdit(client, spec);
    const expected = edit.elements.filter((unused, at) => at !== spec.index);

    return arrayWrite(client, edit, {
        expected,
        detail: `element ${spec.index} removed, ${expected.length} left`,
        issue: () => client.editor.scene.removeArrayElement({
            uuid: edit.target.nodeUuid,
            path: componentPath(edit.target),
            index: spec.index
        })
    });
}

/**
 * What the editor offers in its Add Component menu. `scene classes` answers the class registry,
 * which is a wider set: abstract bases and deprecated aliases are registered and not offered.
 */
export async function componentTypes(client: Driver): Promise<Report> {
    const offered = await client.editor.scene.queryComponents();
    return {
        kind: 'classList',
        classes: (offered || []).map(entry => ({
            name: entry.name,
            ...(entry.cid ? { cid: entry.cid } : {}),
            ...(entry.path ? { path: entry.path } : {}),
            ...(entry.assetUuid ? { assetUuid: entry.assetUuid } : {})
        }))
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
        .command('reset <path> <type>')
        .description('return every property of a component to its default, in one undo step')
        .action((target: string, type: string) =>
            withClient(resolve, client => componentReset(client, { node: target, component: type })));

    component
        .command('types')
        .description('what the editor offers to add; the class registry is a wider set, and '
            + `'cocos scene classes cc.Component' is what answers it`)
        .option('--json', 'print the structural form instead of text')
        .action((options: { json?: boolean }) =>
            withClient(resolve, componentTypes, { json: options.json }));

    const array = component.command('array').description('elements of an array property');

    array
        .command('mv <path> <type>')
        .description('move one element of an array property and check the new order')
        .requiredOption('--prop <name>', 'the array property')
        .requiredOption('--index <n>', 'which element to move')
        .requiredOption('--offset <n>', 'how far to move it; negative moves it towards the front')
        .action((target: string, type: string,
            options: { prop: string; index: string; offset: string }) =>
            withClient(resolve, client => componentArrayMove(client, {
                node: target, component: type, property: options.prop,
                index: requiredNumberFlag('--index', options.index),
                offset: requiredNumberFlag('--offset', options.offset)
            })));

    array
        .command('rm <path> <type>')
        .description('remove one element of an array property and check what is left')
        .requiredOption('--prop <name>', 'the array property')
        .requiredOption('--index <n>', 'which element to remove')
        .action((target: string, type: string, options: { prop: string; index: string }) =>
            withClient(resolve, client => componentArrayRemove(client, {
                node: target, component: type, property: options.prop,
                index: requiredNumberFlag('--index', options.index)
            })));

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
