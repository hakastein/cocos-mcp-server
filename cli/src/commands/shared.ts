import type { Driver, Hello, SceneResult } from '@cocos-cli/shared';
import { EXIT } from '../exit.ts';
import { present } from '../render/present.ts';
import type { CommandOutput, PresentOptions, Report } from '../render/present.ts';
import type { Resolved, ResolvedProject } from '../resolve.ts';

/**
 * `client.scene.call` is typed by the `SceneMethods` contract, so the method, its arguments and the
 * shape of its answer are compiler-checked. One thing is left here: unwrap a `SceneResult` into a
 * value or a refusal. Do not declare your own interface for a scene answer and do not write `as` —
 * the contract already exists.
 */
export async function unwrap<T>(
    answer: SceneResult<T> | Promise<SceneResult<T>>, method: string
): Promise<T> {
    const settled = await answer;
    if (!settled || settled.success !== true || settled.data === undefined) {
        throw new Error(
            (settled && settled.success === false && settled.error) || `the scene script did not answer ${method}`);
    }
    return settled.data;
}

/** The only place a command's output reaches the process streams. */
export function emit(output: CommandOutput): void {
    if (output.stdout !== undefined) process.stdout.write(output.stdout + '\n');
    if (output.stderr !== undefined) process.stderr.write(output.stderr + '\n');
}

/**
 * Resolve, run, present, close — the four things every command group's action does, gathered in
 * one place instead of once per action body. `run` answers with a `Report`, so neither the two
 * streams nor the exit code are assembled in an action body; the connection closes in every
 * branch, success or thrown.
 */
export async function withClient(
    resolve: () => Promise<Resolved>, run: (client: Driver) => Promise<Report>,
    options?: PresentOptions
): Promise<void> {
    const resolved = await resolve();
    if (!resolved.ok) return noEditor(resolved.message);
    try {
        await report(() => run(resolved.client), options);
    } finally {
        resolved.client.close();
    }
}

/** For a command that needs only which project is open: no connection is opened at all. */
export async function withProject(
    resolve: () => Promise<ResolvedProject>, run: (hello: Hello) => Promise<Report>,
    options?: PresentOptions
): Promise<void> {
    const resolved = await resolve();
    if (!resolved.ok) return noEditor(resolved.message);
    await report(() => run(resolved.hello), options);
}

function noEditor(message: string): void {
    process.stderr.write(message + '\n');
    process.exitCode = EXIT.NO_EDITOR;
}

async function report(run: () => Promise<Report>, options?: PresentOptions): Promise<void> {
    try {
        const output = present(await run(), options);
        emit(output);
        if (output.failed) process.exitCode = EXIT.FAILED;
    } catch (error) {
        process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
        process.exitCode = EXIT.FAILED;
    }
}
