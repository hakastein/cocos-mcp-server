import type { SceneResult } from '@cocos-cli/shared';
import { EXIT } from '../exit';
import type { DriverClient } from '../driver-client';
import type { Resolved } from '../resolve';

/**
 * `client.scene.call` типизирован контрактом `SceneMethods`, поэтому метод, его аргументы и форма
 * ответа проверяются компилятором. Здесь остаётся одно: развернуть `SceneResult` в значение или
 * в отказ. Своих интерфейсов для ответа сцены не заводи и `as` не пиши — контракт уже есть.
 */
export async function unwrap<T>(
    answer: SceneResult<T> | Promise<SceneResult<T>>, method: string
): Promise<T> {
    const settled = await answer;
    if (!settled || settled.success !== true || settled.data === undefined) {
        throw new Error(
            (settled && settled.success === false && settled.error) || `scene-скрипт не ответил на ${method}`);
    }
    return settled.data;
}

export interface CommandOutput {
    stdout?: string;
    stderr?: string;
}

/**
 * Resolve, run, print, close — the four things every command group's action does, gathered in
 * one place instead of once per action body. `run` reports what it wants on each stream instead
 * of writing directly, so this stays the only spot that touches `process.stdout`/`process.stderr`
 * for command output; the connection closes in every branch, success or thrown.
 */
export async function withClient(
    resolve: () => Promise<Resolved>, run: (client: DriverClient) => Promise<CommandOutput>
): Promise<void> {
    const resolved = await resolve();
    if (!resolved.ok) {
        process.stderr.write(resolved.message + '\n');
        process.exitCode = EXIT.NO_EDITOR;
        return;
    }
    try {
        const output = await run(resolved.client);
        if (output.stdout !== undefined) process.stdout.write(output.stdout + '\n');
        if (output.stderr !== undefined) process.stderr.write(output.stderr + '\n');
    } catch (error) {
        process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
        process.exitCode = EXIT.FAILED;
    } finally {
        resolved.client.close();
    }
}
