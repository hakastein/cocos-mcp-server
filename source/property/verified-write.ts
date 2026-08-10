import { WriteTarget, componentPath, kindOf, writerFor } from './writers';
import type { ToolContext } from '../context';
import type { SceneDirtyReport, SceneResult, WriteReport } from '../scene-contract';

export interface VerifiedWriteOptions {
    verify?: 'readback' | 'disk';
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
    const writer = writerFor(target);
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
    await endRecording(undo, ctx);

    if (undo.id === null) {
        report = addDetail(report, `the editor refused to record an undo step (${undo.reason}), `
            + 'so Ctrl+Z does not take this write back');
    }
    if (opts.verify === 'disk') {
        report = addDetail(report, await diskVerdict(ctx));
    }
    return report;
}

async function beginRecording(nodeUuid: string, ctx: ToolContext): Promise<UndoBracket> {
    try {
        return { id: await ctx.editor.scene.beginRecording(nodeUuid) };
    } catch (error) {
        return { id: null, reason: messageOf(error) };
    }
}

async function endRecording(undo: UndoBracket, ctx: ToolContext): Promise<void> {
    if (undo.id === null) return;
    try {
        await ctx.editor.scene.endRecording(undo.id);
    } catch {
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
