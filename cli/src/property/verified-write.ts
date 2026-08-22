import {
    componentCid, componentPath, kindOf, readBack, readBackMismatches, writerFor
} from './writers.ts';
import type { WriteTarget } from './writers.ts';
import { projectValue } from './readers.ts';
import { propertySpellings } from './spelling.ts';
import { withUndoBracket } from '../undo-bracket.ts';
import type {
    Driver, PrefabOverrideOutcome, SceneDirtyReport, SceneResult, SerializedValue, WriteReport
} from '@cocos-cli/shared';

export interface VerifiedWriteOptions {
    verify?: 'readback' | 'disk' | 'serializer';
}

export interface VerifiedWrite {
    report: WriteReport;
    /** The bracket's own outcome, which the presenter spells; `null` is a step that held. */
    undoNote: string | null;
}

export async function verifiedWrite(
    target: WriteTarget,
    value: unknown,
    ctx: Driver,
    opts: VerifiedWriteOptions = {}
): Promise<VerifiedWrite> {
    const writer = writerFor(target, value);
    if (!writer) {
        return {
            report: {
                written: false, verified: false, persisted: false,
                detail: `no writer claims ${componentPath(target)} (kind '${kindOf(target)}')`
            },
            undoNote: null
        };
    }

    const { result, undoNote } = await withUndoBracket(ctx, target.nodeUuid,
        () => writer.write(target, value, ctx));

    if (opts.verify === 'disk') return { report: addDetail(result, await diskVerdict(ctx)), undoNote };
    if (opts.verify === 'serializer') {
        return { report: await withSerializerVerdict(result, target, ctx), undoNote };
    }
    return { report: result, undoNote };
}

/**
 * Save writes exactly what `EditorExtends.serialize` emits, so a property the Inspector dump shows
 * and the serializer does not is a write that reads back perfectly and reaches no file.
 */
export async function withSerializerVerdict(
    report: WriteReport, target: WriteTarget, ctx: Driver
): Promise<WriteReport> {
    const cid = await componentCid(target, ctx);
    if (cid === undefined) {
        return addDetail(report, `no component sits at ${componentPath(target)}, so the serialized form `
            + 'was not read');
    }

    let found: SerializedLookup;
    try {
        found = await serializedValue(target, cid, ctx);
    } catch (error) {
        return addDetail(report, `the serialized form was not read (${messageOf(error)})`);
    }
    if ('problem' in found) {
        return found.inPrefabInstance
            ? await withOverrideVerdict(report, target, cid, ctx)
            : addDetail(report, found.problem);
    }

    const serialized = withoutUuidWrappers(projectValue(kindOf(target), found.value));
    const live = withoutUuidWrappers(await readBack(target, ctx));
    const mismatches = readBackMismatches(serialized, live, target.propertyPath);
    if (mismatches.length === 0) {
        return report.persisted === null ? { ...report, persisted: true } : report;
    }
    return addDetail({ ...report, persisted: false },
        `a save would not carry this write — the serializer emits ${mismatches.join('; ')}`);
}

async function overrideOutcome(
    target: WriteTarget, cid: string, property: string, ctx: Driver
): Promise<PrefabOverrideOutcome | string> {
    let result: SceneResult<PrefabOverrideOutcome>;
    try {
        result = await ctx.scene.call('prefabInstancePropertyOutcome', target.nodeUuid, cid, property);
    } catch (error) {
        return `the prefab override behind this write was not read (${messageOf(error)})`;
    }
    if (!result || result.success !== true) {
        return 'the prefab override behind this write was not read '
            + `(${(result && result.error) || 'no answer'})`;
    }
    return result.data;
}

/**
 * A component inside a prefab instance is absent from the scene file: the next load rebuilds it from
 * the asset and replays the overrides, which the editor records under the SERIALIZER's name — so a
 * write spelled as the accessor has to look for its own override under the backing field too.
 */
async function withOverrideVerdict(
    report: WriteReport, target: WriteTarget, cid: string, ctx: Driver
): Promise<WriteReport> {
    const spellings = propertySpellings(target.propertyPath);
    const asked = await overrideOutcome(target, cid, spellings[0], ctx);
    if (typeof asked === 'string') return addDetail(report, asked);

    let outcome = asked;
    for (const property of spellings.slice(1)) {
        if (outcome.carried) break;
        const stored = await overrideOutcome(target, cid, property, ctx);
        // An override naming nothing says the serializer's spelling does not diverge from the asset,
        // which answers about that spelling and not about the one the caller wrote.
        if (typeof stored !== 'string' && stored.carried && stored.overridePaths.length) outcome = stored;
    }
    if (!outcome.inPrefabInstance || !outcome.known) {
        return addDetail(report, `the scene file carries none of this component's properties and `
            + `${outcome.reason || 'the prefab behind it could not be read'}, so a save carrying the value `
            + 'is unconfirmed');
    }
    if (outcome.carried) {
        const carried: WriteReport = report.persisted === null ? { ...report, persisted: true } : report;
        return outcome.overridePaths.length
            ? { ...carried, prefabOverride: { targetPath: outcome.overridePaths.join(', ') } }
            : carried;
    }
    const untyped = outcome.untyped.length
        ? '. The editor recorded none because the two sides hold objects of DIFFERENT CLASSES at '
            + `${outcome.untyped.join('; ')} — a value stored in the prefab without its \`__type__\` loads `
            + 'as a plain object, and the editor diffs only same-class pairs. The property has to be '
            + 'rewritten on the prefab asset itself, so that it is stored with its `__type__`, and then '
            + 'written here again — no `cocos` command reaches into a prefab asset, so that first step is '
            + "the editor's own inspector on the opened prefab"
        : '';
    return addDetail({ ...report, persisted: false },
        'no prefab property override carries this write, so the next load rebuilds '
        + `${outcome.uncovered.join(', ')} from the prefab asset${untyped}`);
}

type SerializedLookup = { value: unknown } | { problem: string; inPrefabInstance?: boolean };

/**
 * The serializer writes backing fields, so the accessor `color` is emitted as `_color` and asking
 * for the accessor name alone reports a property nothing carries.
 */
async function serializedValue(target: WriteTarget, cid: string, ctx: Driver): Promise<SerializedLookup> {
    const spellings = propertySpellings(target.propertyPath);

    let problem = '';
    let inPrefabInstance = false;
    for (const property of spellings) {
        const result = await ctx.scene.call('serializedComponentValue', target.nodeUuid, cid, property);
        if (!result || result.success !== true) {
            problem = `the serialized form was not read (${(result && result.error) || 'no answer'})`;
            continue;
        }
        if (result.data.found && !result.data.unnamedReference) return { value: result.data.value };
        if (result.data.found) {
            problem = `the serializer emits '${property}' as a reference to a node the file names by `
                + 'position alone, and that position could not be paired with a node in the open scene, '
                + 'so a save carrying the value is unconfirmed';
            continue;
        }
        if (result.data.inPrefabInstance) inPrefabInstance = true;
        problem = `the serializer does not emit '${property}'`
            + `${result.data.reason ? ` — ${result.data.reason}` : ''}, so a save carrying the value is unconfirmed`;
    }
    return inPrefabInstance ? { problem, inPrefabInstance } : { problem };
}

/**
 * The live dump projects a reference to its uuid string, the serialized form keeps the object it
 * is stored as. Undo that difference on both sides, or every @ccclass holding a reference reads
 * as a write a save would drop.
 */
export function withoutUuidWrappers(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(item => withoutUuidWrappers(item));
    if (!value || typeof value !== 'object') return value;
    const entries = Object.entries(value as Record<string, unknown>);
    const uuidOnly = entries.length > 0 && entries.every(([key]) => key === 'uuid' || key === '__uuid__');
    if (uuidOnly) {
        const uuid = entries[0][1];
        return typeof uuid === 'string' ? (uuid || null) : uuid;
    }
    const plain: Record<string, unknown> = {};
    for (const [key, member] of entries) plain[key] = withoutUuidWrappers(member);
    return plain;
}

/**
 * `sceneDirtyAgainstDisk` compares the open scene with the file, which the editor's own dirty
 * flag does not: it counts undo steps.
 */
async function diskVerdict(ctx: Driver): Promise<string> {
    let result: SceneResult<SceneDirtyReport>;
    try {
        result = await ctx.scene.call('sceneDirtyAgainstDisk');
    } catch (error) {
        return `the scene was not compared with the file on disk (${messageOf(error)})`;
    }
    if (!result || result.success !== true) {
        return `the scene was not compared with the file on disk (${(result && result.error) || 'no answer'})`;
    }
    return result.data.differsFromDisk
        ? `the open scene differs from ${result.data.scenePath || 'the file on disk'} in `
            + `${result.data.diffs.length} place(s) and needs saving`
        : 'the open scene matches the file on disk, so this write changed nothing that a save would carry';
}

function addDetail(report: WriteReport, detail: string): WriteReport {
    return { ...report, detail: report.detail ? `${report.detail}; ${detail}` : detail };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
