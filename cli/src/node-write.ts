import { readBackMismatches } from './property/writers.ts';
import { nodeSnapshotOf } from './node-snapshot.ts';
import type {
    Driver, PrefabOverrideRecord, SceneResult, SerializedValue, WriteReport
} from '@cocos-cli/shared';

/**
 * The names the serializer emits a node's own properties under, which is what `serializedNodeValue`
 * answers by. `rotation` maps to `_euler` rather than to `_lrot`: the file carries both, and the
 * quaternion is the one the dump does NOT show, so comparing a write against it would report every
 * rotation as dropped.
 */
export const NODE_STORAGE = {
    name: '_name',
    active: '_active',
    layer: '_layer',
    position: '_lpos',
    rotation: '_euler',
    scale: '_lscale',
    parent: '_parent'
} as const;

export type NodeStoredProperty = keyof typeof NODE_STORAGE;

/**
 * A node inside a prefab instance is absent from the scene file: the next load rebuilds it from the
 * asset and replays the instance's property overrides, so those decide persistence there instead.
 */
export async function withNodePersistence(
    report: WriteReport, ctx: Driver, uuid: string, property: NodeStoredProperty, expected: unknown
): Promise<WriteReport> {
    const stored = NODE_STORAGE[property];

    let found: SceneResult<SerializedValue>;
    try {
        found = await ctx.scene.call('serializedNodeValue', uuid, stored);
    } catch (error) {
        return withDetail(report, `the serialized form was not read (${messageOf(error)})`);
    }
    if (!found || found.success !== true) {
        return withDetail(report,
            `the serialized form was not read (${(found && found.error) || 'no answer'})`);
    }

    const data = found.data;
    if (data.found && !data.unnamedReference) {
        const emitted = property === 'parent' ? parentAddress(data.value) : data.value;
        const mismatches = readBackMismatches(expected, emitted, property);
        return mismatches.length === 0
            ? persisted(report, true)
            : withDetail({ ...report, persisted: false },
                `a save would not carry this write — the serializer emits ${mismatches.join('; ')}`);
    }
    if (data.inPrefabInstance) return await withOverrideVerdict(report, ctx, uuid, stored);
    if (data.found) {
        return withDetail(report, `the serializer emits '${stored}' as a reference to a node the file `
            + 'names by position alone, so a save carrying the value is unconfirmed');
    }
    return withDetail(report, `the serializer does not emit '${stored}'`
        + `${data.reason ? ` — ${data.reason}` : ''}, so a save carrying the value is unconfirmed`);
}

/**
 * The serializer names a parent NODE by uuid and the SCENE by its whole record — `cc.Scene` is not a
 * `cc.Node`, so the back-reference gets expanded instead of shortened. The dump names that same
 * parent by the scene's `_id`, which is what the two sides are then compared on: without this every
 * duplicate of a root node reads as a write a save would drop.
 */
function parentAddress(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    const holder = value as { uuid?: unknown; _id?: unknown };
    if ('uuid' in holder) return { uuid: holder.uuid };
    return typeof holder._id === 'string' ? { uuid: holder._id } : value;
}

async function withOverrideVerdict(
    report: WriteReport, ctx: Driver, uuid: string, stored: string
): Promise<WriteReport> {
    let carrier: PrefabOverrideRecord | undefined;
    try {
        const instance = await instanceRootOf(ctx, uuid);
        if (!instance) {
            return withDetail(report, 'the scene file carries none of this node\'s properties and the '
                + 'prefab instance holding it was not found, so a save carrying the value is unconfirmed');
        }
        const overrides = await ctx.scene.call('listPrefabOverrides', instance.root);
        if (!overrides || overrides.success !== true) {
            return withDetail(report, 'the prefab overrides behind this write were not read '
                + `(${(overrides && overrides.error) || 'no answer'})`);
        }
        carrier = overrides.data.overrides.find(record =>
            record.propertyPath === stored && record.localID[record.localID.length - 1] === instance.fileId);
    } catch (error) {
        return withDetail(report,
            `the prefab overrides behind this write were not read (${messageOf(error)})`);
    }

    if (!carrier) {
        return withDetail({ ...report, persisted: false },
            `no prefab property override carries this write, so the next load rebuilds '${stored}' `
            + 'from the prefab asset');
    }
    return {
        ...persisted(report, true),
        prefabOverride: { targetPath: (carrier.target && carrier.target.path) || stored }
    };
}

interface EnclosingInstance {
    root: string;
    /** The node's own id inside the prefab, which is what an override record points at. */
    fileId: string | null;
}

/**
 * The instance root is the node itself or an ancestor: the CLI walks up because the override list
 * hangs off the root alone, and a nested instance would answer for the wrong one.
 */
async function instanceRootOf(ctx: Driver, uuid: string): Promise<EnclosingInstance | null> {
    const linkage = await ctx.scene.call('nodePrefabLinkage', uuid);
    if (!linkage || linkage.success !== true || !linkage.data.linked) return null;
    const fileId = linkage.data.fileId;

    for (let at: string | null = uuid; at; at = await parentOf(ctx, at)) {
        const found = at === uuid ? linkage : await ctx.scene.call('nodePrefabLinkage', at);
        if (found && found.success === true && found.data.instanceRoot) return { root: at, fileId };
    }
    return null;
}

async function parentOf(ctx: Driver, uuid: string): Promise<string | null> {
    const snapshot = nodeSnapshotOf(await ctx.editor.scene.queryNode(uuid), uuid);
    return snapshot ? snapshot.parent : null;
}

function persisted(report: WriteReport, carried: boolean): WriteReport {
    return report.persisted === null ? { ...report, persisted: carried } : report;
}

function withDetail(report: WriteReport, detail: string): WriteReport {
    return { ...report, detail: report.detail ? `${report.detail}; ${detail}` : detail };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
