import type { Driver, WriteReport } from '@cocos-cli/shared';
import { Command } from 'commander';
import { unwrap, withClient } from './shared.ts';
import { addComponent } from '../component-add.ts';
import { booleanFlag, numberFlag, vec3Flag, vec3PartsFlag } from './flags.ts';
import { withUndoBracket } from '../undo-bracket.ts';
import { settle } from '../settle.ts';
import { classifyNode } from '../node-type.ts';
import { nodePropertyOf, nodeSnapshotOf } from '../node-snapshot.ts';
import { TRANSFORM_KINDS, normalizedTransform, sameVec3 } from '../node-transform.ts';
import type { PollOptions } from '../component-add.ts';
import type { NodeProperty, NodeSnapshot } from '../node-snapshot.ts';
import type { TransformKind, Vec3, Vec3Parts } from '../node-transform.ts';
import { withNodePersistence } from '../node-write.ts';
import type { NodeStoredProperty } from '../node-write.ts';
import type { RenderedWrite, Report } from '../render/present.ts';
import type { Resolved } from '../resolve.ts';

// Cocos compresses a node/component uuid to exactly 22 chars of standard base64
// (`A-Za-z0-9+/`, no `-`/`_`) — see shared/test/reference-projection.test.mjs's fixture uuids.
// A node NAME can land in this same alphabet and length, so both constraints matter.
const UUID_LIKE = /^[A-Za-z0-9+/]{22}$/;

export async function resolveNode(client: Driver, pathOrUuid: string): Promise<string> {
    if (UUID_LIKE.test(pathOrUuid) && !pathOrUuid.includes('/')) return pathOrUuid;

    const resolved = await unwrap(client.scene.call('resolveNodePaths', [pathOrUuid]), 'resolveNodePaths');
    const resolution = resolved.resolutions[pathOrUuid];
    if (!resolution) {
        throw new Error(`the scene script did not resolve '${pathOrUuid}'`);
    }
    if ('error' in resolution) {
        throw new Error(resolution.error);
    }
    return resolution.uuid;
}

export async function nodeGet(client: Driver, spec: { target: string }): Promise<Report> {
    const uuid = await resolveNode(client, spec.target);
    const info = await unwrap(client.scene.call('getNodeInfo', uuid), 'getNodeInfo');
    const components = (info.components || [])
        .map(component => component.enabled === false ? `${component.type}(off)` : component.type)
        .join(',');
    return {
        kind: 'action',
        verdict: 'ok',
        summary: `${info.name}${info.active ? '' : '  (off)'}`
            + (components ? `  [${components}]` : '')
            + `  ${info.uuid}`
    };
}

export interface CreateSpec {
    parent: string;
    name: string;
    components: string[];
    pos?: Vec3;
    /** How long an added component is polled for before it counts as not having appeared. */
    poll?: PollOptions;
}

/**
 * The bracket covers both the structural step and the setup, so a created node comes back on one
 * Ctrl+Z. A failure at any step drops the bracket: a recording left open would outlive the process.
 */
export async function nodeCreate(client: Driver, spec: CreateSpec): Promise<Report> {
    const parentUuid = await resolveNode(client, spec.parent);

    const { result, undoNote } = await withUndoBracket(client, parentUuid, async () => {
        const createdUuid = await client.editor.scene.createNode({
            parent: parentUuid, name: spec.name
        }) as string;
        const registered: string[] = [];
        for (const type of spec.components) {
            registered.push((await addComponent(client, createdUuid, type, spec.poll)).type);
        }
        if (spec.pos) {
            await client.editor.scene.setProperty({
                uuid: createdUuid,
                path: 'position',
                dump: { type: 'cc.Vec3', value: spec.pos }
            });
        }
        return { createdUuid, registered };
    });

    return {
        kind: 'action',
        verdict: 'ok',
        summary: `created ${spec.parent}/${spec.name}  ${result.createdUuid}`
            + (result.registered.length ? `  [${result.registered.join(',')}]` : ''),
        undoNote
    };
}

async function snapshotOf(client: Driver, uuid: string): Promise<NodeSnapshot> {
    const snapshot = nodeSnapshotOf(await client.editor.scene.queryNode(uuid), uuid);
    if (!snapshot) throw new Error(`node ${uuid} is not in the open scene`);
    return snapshot;
}

export interface SetSpec {
    target: string;
    name?: string;
    active?: boolean;
    layer?: number;
    position?: Vec3Parts;
    rotation?: Vec3Parts;
    scale?: Vec3Parts;
    /** How long each write is polled for before it counts as not having landed. */
    poll?: PollOptions;
}

/**
 * Scalar properties and the transform are written under one bracket: `--name` together with `--pos`
 * has to come back on one Ctrl+Z rather than two. Every write is read back, and the first one that
 * does not land cuts the rest short — writing further onto a node that refused the previous value
 * only piles up drift.
 */
export async function nodeSet(client: Driver, spec: SetSpec): Promise<Report> {
    const target = spec.target;
    const uuid = await resolveNode(client, target);
    const before = await snapshotOf(client, uuid);
    const nodeType = classifyNode(before.componentTypes, before.layer).nodeType;

    const writes: NodeWrite[] = [];
    const warnings: string[] = [];

    const { undoNote } = await withUndoBracket(client, uuid, async () => {
        const scalars: Array<[NodeProperty, string | boolean | number]> = [];
        if (spec.name !== undefined) scalars.push(['name', spec.name]);
        if (spec.active !== undefined) scalars.push(['active', spec.active]);
        if (spec.layer !== undefined) scalars.push(['layer', spec.layer]);

        for (const [property, value] of scalars) {
            await client.editor.scene.setProperty({ uuid, path: property, dump: { value } });
            let observed: unknown;
            const landed = await settle(async () => {
                observed = nodePropertyOf(await snapshotOf(client, uuid), property);
                return observed === value;
            }, spec.poll);
            writes.push({
                target, property, value, expected: value,
                report: readBackReport(landed, property, observed)
            });
            if (!landed) return;
        }

        for (const kind of TRANSFORM_KINDS) {
            const given = spec[kind as TransformKind];
            if (!given) continue;
            const current = await snapshotOf(client, uuid);
            const normalized = normalizedTransform(given, current[kind], kind, nodeType);
            if (normalized.warning) warnings.push(normalized.warning);

            await client.editor.scene.setProperty({
                uuid, path: kind, dump: { type: 'cc.Vec3', value: normalized.value }
            });
            let observed = current[kind];
            const landed = await settle(async () => {
                observed = (await snapshotOf(client, uuid))[kind];
                return sameVec3(observed, normalized.value);
            }, spec.poll);
            writes.push({
                target, property: kind, value: normalized.value, expected: normalized.value,
                report: readBackReport(landed, kind, observed)
            });
            if (!landed) return;
        }
    });

    return {
        kind: 'write',
        target,
        writes: await judged(client, uuid, writes),
        undoNote,
        note: [`${target} is a ${nodeType} node`, ...warnings].join('\n')
    };
}

interface NodeWrite extends RenderedWrite {
    property: NodeStoredProperty;
    /** What the serializer has to hold for the write to survive, which for a parent is not the path
     * the line shows but the uuid the file stores. */
    expected: unknown;
}

/**
 * The editor took the message, so the write was issued; a node that still answers the old value is
 * UNVERIFIED rather than FAILED, for the same reason a component write is.
 */
function readBackReport(landed: boolean, property: string, observed: unknown): WriteReport {
    const report: WriteReport = { written: true, verified: landed, persisted: null, channel: 'editor' };
    return landed ? report : {
        ...report,
        detail: `read-back disagrees — ${property}: the node still answers ${JSON.stringify(observed)}`
    };
}

/**
 * Asked after the bracket closes: reading what the serializer emits is no part of the undo step,
 * and a write that never landed has nothing to ask about.
 */
async function judged(client: Driver, uuid: string, writes: NodeWrite[]): Promise<NodeWrite[]> {
    const answered: NodeWrite[] = [];
    for (const write of writes) {
        answered.push(write.report.verified
            ? {
                ...write,
                report: await withNodePersistence(write.report, client, uuid, write.property, write.expected)
            }
            : write);
    }
    return answered;
}

export interface MoveSpec {
    target: string;
    parent: string;
    keepWorldTransform?: boolean;
    /** How long the reparent is polled for before it counts as not having landed. */
    poll?: PollOptions;
}

/**
 * The editor applies a reparent asynchronously and silently ignores some of them, so the new parent
 * is polled until it takes; one that never takes names the parent the node actually has.
 */
export async function nodeMove(client: Driver, spec: MoveSpec): Promise<Report> {
    const target = spec.target;
    const keepWorldTransform = spec.keepWorldTransform === true;
    const uuid = await resolveNode(client, target);
    const parentUuid = await resolveNode(client, spec.parent);
    if (uuid === parentUuid) throw new Error(`${target} cannot be its own parent`);

    const { undoNote } = await withUndoBracket(client, uuid, () =>
        client.editor.scene.setParent({ parent: parentUuid, uuids: [uuid], keepWorldTransform }));

    let actual: string | null = null;
    const moved = await settle(async () => {
        actual = (await snapshotOf(client, uuid)).parent;
        return actual === parentUuid;
    }, spec.poll);
    const write: NodeWrite = {
        target, property: 'parent', value: spec.parent, expected: { uuid: parentUuid },
        report: moved
            ? { written: true, verified: true, persisted: null, channel: 'editor' }
            : {
                written: true, verified: false, persisted: null, channel: 'editor',
                detail: `read-back disagrees — the parent is still ${actual || 'unknown'}, `
                    + `expected ${parentUuid}`
            }
    };

    return {
        kind: 'write',
        target,
        writes: await judged(client, uuid, [write]),
        undoNote,
        note: keepWorldTransform ? 'the world transform was kept, so the local one changed' : undefined
    };
}

export interface DuplicateSpec {
    target: string;
    /** How long the copy is polled for before it counts as never having appeared. */
    poll?: PollOptions;
}

export async function nodeDuplicate(client: Driver, spec: DuplicateSpec): Promise<Report> {
    const target = spec.target;
    const uuid = await resolveNode(client, target);
    const { result, undoNote } = await withUndoBracket(client, uuid, () =>
        client.editor.scene.duplicateNode(uuid));
    const created = Array.isArray(result) ? result[0] : result;
    if (typeof created !== 'string' || !created) {
        throw new Error(`the editor named no uuid for the copy of ${target}`);
    }

    const appeared = await settle(
        () => snapshotOf(client, created).then(() => true, () => false), spec.poll);
    if (!appeared) {
        return {
            kind: 'write',
            target,
            writes: [{
                target, property: 'parent',
                report: {
                    written: true, verified: false, persisted: null, channel: 'editor',
                    detail: `the editor answered uuid ${created}, and no such node is in the scene`
                }
            }],
            undoNote
        };
    }

    const copy = await snapshotOf(client, created);
    const write: NodeWrite = {
        target: copy.name, property: 'parent', expected: { uuid: copy.parent },
        report: {
            written: true, verified: true, persisted: null, channel: 'editor',
            detail: `copy of ${target}, uuid ${created}`
        }
    };
    return {
        kind: 'write', target: copy.name, writes: await judged(client, created, [write]), undoNote
    };
}

export async function nodeRemove(client: Driver, spec: { target: string }): Promise<Report> {
    const uuid = await resolveNode(client, spec.target);
    await client.editor.scene.removeNode({ uuid });
    return { kind: 'action', verdict: 'ok', summary: `removed ${spec.target}` };
}

export function registerNode(program: Command, resolve: () => Promise<Resolved>): void {
    const node = program.command('node').description('nodes of the open scene');

    node
        .command('get <path>')
        .description('name, state and components of a node')
        .action((target: string) => withClient(resolve, client => nodeGet(client, { target })));

    node
        .command('create')
        .description('create a node, add components and set its position in one undo step')
        .requiredOption('--parent <path>', 'parent node')
        .requiredOption('--name <name>', 'name of the new node')
        .option('--component <type...>', 'components to add', [])
        .option('--pos <x,y,z>', 'position')
        .action((options: { parent: string; name: string; component: string[]; pos?: string }) =>
            withClient(resolve, client => nodeCreate(client, {
                parent: options.parent,
                name: options.name,
                components: options.component,
                pos: vec3Flag('--pos', options.pos)
            })));

    node
        .command('set <path>')
        .description('write properties of the node itself — name, active, layer, transform — in one undo step')
        .option('--name <name>', 'rename the node')
        .option('--active <bool>', 'switch the node on or off')
        .option('--layer <n>', 'node layer')
        .option('--pos <x,y,z>', 'local position; an empty axis keeps its value (1,,3)')
        .option('--rot <x,y,z>', 'local rotation in Euler angles')
        .option('--scale <x,y,z>', 'local scale')
        .action((target: string, options: {
            name?: string; active?: string; layer?: string; pos?: string; rot?: string; scale?: string
        }) => withClient(resolve, client => nodeSet(client, {
            target,
            name: options.name,
            active: booleanFlag('--active', options.active),
            layer: numberFlag('--layer', options.layer),
            position: vec3PartsFlag('--pos', options.pos),
            rotation: vec3PartsFlag('--rot', options.rot),
            scale: vec3PartsFlag('--scale', options.scale)
        })));

    node
        .command('mv <path>')
        .description('move a node under another parent')
        .requiredOption('--parent <path>', 'new parent')
        .option('--keep-world', 'keep the world transform instead of the local one')
        .action((target: string, options: { parent: string; keepWorld?: boolean }) =>
            withClient(resolve, client => nodeMove(client, {
                target, parent: options.parent, keepWorldTransform: options.keepWorld === true
            })));

    node
        .command('dup <path>')
        .description('duplicate a node with its subtree, as a sibling of the original')
        .action((target: string) =>
            withClient(resolve, client => nodeDuplicate(client, { target })));

    node
        .command('rm <path>')
        .description('remove a node')
        .action((target: string) => withClient(resolve, client => nodeRemove(client, { target })));
}
