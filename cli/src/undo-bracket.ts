import type { DriverClient } from './driver-client';

interface OpenBracket {
    id: string | null;
    reason?: string;
}

export interface Bracketed<T> {
    result: T;
    undoNote: string | null;
}

export async function withUndoBracket<T>(
    ctx: DriverClient, nodeUuid: string, write: () => Promise<T>
): Promise<Bracketed<T>> {
    const bracket = await beginRecording(nodeUuid, ctx);
    let result: T;
    try {
        result = await write();
    } catch (error) {
        await cancelRecording(bracket, ctx);
        throw error;
    }
    return { result, undoNote: undoNoteFor(bracket, await endRecording(bracket, ctx)) };
}

function undoNoteFor(bracket: OpenBracket, leftOpen: string | null): string | null {
    if (bracket.id === null) {
        return `the editor refused to record an undo step (${bracket.reason}), so Ctrl+Z does not take `
            + 'this write back';
    }
    if (leftOpen !== null) {
        return `the undo step was left open (${leftOpen}), so Ctrl+Z may take back more than this write`;
    }
    return null;
}

async function beginRecording(nodeUuid: string, ctx: DriverClient): Promise<OpenBracket> {
    try {
        return { id: await ctx.editor.scene.beginRecording(nodeUuid) as string };
    } catch (error) {
        return { id: null, reason: messageOf(error) };
    }
}

async function endRecording(bracket: OpenBracket, ctx: DriverClient): Promise<string | null> {
    if (bracket.id === null) return null;
    try {
        await ctx.editor.scene.endRecording(bracket.id);
        return null;
    } catch (error) {
        return messageOf(error);
    }
}

async function cancelRecording(bracket: OpenBracket, ctx: DriverClient): Promise<void> {
    if (bracket.id === null) return;
    try {
        await ctx.editor.scene.cancelRecording(bracket.id);
    } catch {
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
