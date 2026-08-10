import {
    WriteTarget, componentCid, componentPath, kindOf, readBack, readBackMismatches, writerFor
} from './writers';
import { projectValue } from './readers';
import type { ToolContext } from '../context';
import type { SceneDirtyReport, SceneResult, WriteReport } from '../scene-contract';

export interface VerifiedWriteOptions {
    verify?: 'readback' | 'disk' | 'serializer';
}

interface UndoBracket {
    id: string | null;
    reason?: string;
}

export async function verifiedWrite(
    target: WriteTarget,
    value: unknown,
    ctx: ToolContext,
    opts: VerifiedWriteOptions = {}
): Promise<WriteReport> {
    const writer = writerFor(target, value);
    if (!writer) {
        return {
            written: false, verified: false, persisted: false,
            detail: `no writer claims ${componentPath(target)} (kind '${kindOf(target)}')`
        };
    }

    const undo = await beginRecording(target.nodeUuid, ctx);
    let report: WriteReport;
    try {
        report = await writer.write(target, value, ctx);
    } catch (error) {
        await cancelRecording(undo, ctx);
        throw error;
    }

    const ended = await endRecording(undo, ctx);
    if (undo.id === null) {
        report = addDetail(report, `the editor refused to record an undo step (${undo.reason}), `
            + 'so Ctrl+Z does not take this write back');
    } else if (ended !== null) {
        report = addDetail(report, `the undo step was left open (${ended}), so Ctrl+Z may take back `
            + 'more than this write');
    }

    if (opts.verify === 'disk') return addDetail(report, await diskVerdict(ctx));
    if (opts.verify === 'serializer') return await withSerializerVerdict(report, target, ctx);
    return report;
}

async function beginRecording(nodeUuid: string, ctx: ToolContext): Promise<UndoBracket> {
    try {
        return { id: await ctx.editor.scene.beginRecording(nodeUuid) };
    } catch (error) {
        return { id: null, reason: messageOf(error) };
    }
}

async function endRecording(undo: UndoBracket, ctx: ToolContext): Promise<string | null> {
    if (undo.id === null) return null;
    try {
        await ctx.editor.scene.endRecording(undo.id);
        return null;
    } catch (error) {
        return messageOf(error);
    }
}

async function cancelRecording(undo: UndoBracket, ctx: ToolContext): Promise<void> {
    if (undo.id === null) return;
    try {
        await ctx.editor.scene.cancelRecording(undo.id);
    } catch {
    }
}

/**
 * Save writes exactly what `EditorExtends.serialize` emits, so a property the Inspector dump shows
 * and the serializer does not is a write that reads back perfectly and reaches no file.
 */
async function withSerializerVerdict(
    report: WriteReport, target: WriteTarget, ctx: ToolContext
): Promise<WriteReport> {
    const cid = await componentCid(target, ctx);
    if (cid === undefined) {
        return addDetail(report, `no component sits at ${componentPath(target)}, so the serialized form `
            + 'was not read');
    }

    let result;
    try {
        result = await ctx.sceneScript.call('serializedComponentValue', target.nodeUuid, cid, target.propertyPath);
    } catch (error) {
        return addDetail(report, `the serialized form was not read (${messageOf(error)})`);
    }
    if (!result || result.success !== true) {
        return addDetail(report, `the serialized form was not read (${(result && result.error) || 'no answer'})`);
    }
    if (!result.data.found) {
        return addDetail(report, `the serializer does not emit '${target.propertyPath}'`
            + `${result.data.reason ? ` — ${result.data.reason}` : ''}, so a save carrying the value is `
            + 'unconfirmed');
    }

    const serialized = projectValue(kindOf(target), result.data.value);
    const live = await readBack(target, ctx);
    const mismatches = readBackMismatches(serialized, live, target.propertyPath);
    if (mismatches.length === 0) return addDetail(report, 'the serializer emits what the component holds');
    return addDetail({ ...report, persisted: false },
        `a save would not carry this write — the serializer emits ${mismatches.join('; ')}`);
}

/**
 * `sceneDirtyAgainstDisk` compares the open scene with the file, which the editor's own dirty
 * flag does not: it counts undo steps.
 */
async function diskVerdict(ctx: ToolContext): Promise<string> {
    let result: SceneResult<SceneDirtyReport>;
    try {
        result = await ctx.sceneScript.call('sceneDirtyAgainstDisk');
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
