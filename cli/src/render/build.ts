import { BuildExitCode, taskIsRunning } from '../build-task.ts';
import { table } from './columns.ts';
import type { BuildRunReport, BuilderStatus } from '../build-task.ts';
import type { Verdict } from './verdict.ts';

/**
 * The exit code table is the editor's own, so a code that is not BUILD_SUCCESS is a build that did
 * not happen. `unknown` is the state of a task nobody could read back, and only that answers
 * `UNVERIFIED`: a row that says anything other than `success` has read the build back and
 * contradicted it, which is the same difference `persisted: null` keeps from `persisted: false`.
 */
export function buildVerdict(run: BuildRunReport): Verdict {
    if (run.timedOut) return 'TIMEOUT';
    if (run.exitCode !== null && run.exitCode !== BuildExitCode.BUILD_SUCCESS) return 'FAILED';
    if (run.state === 'unknown') return 'UNVERIFIED';
    return run.state === 'success' ? 'ok' : 'FAILED';
}

export function renderBuildRun(run: BuildRunReport): string {
    const lines = [[
        `${buildVerdict(run)}  ${run.platform}`,
        run.exitName === null ? 'no exit code' : `${run.exitName}(${run.exitCode})`,
        `state=${run.state}`,
        `${(run.elapsedMs / 1000).toFixed(1)}s`
    ].join('  ')];

    if (run.taskId !== null) {
        lines.push(`task ${run.taskId}${run.taskName ? ` "${run.taskName}"` : ''}  ${
            run.rebuiltExistingTask ? 'rebuilt in place' : 'added as a new task'}`);
    }
    if (run.buildPath || run.outputName) {
        lines.push(`output ${run.buildPath || '?'}/${run.outputName || '?'}`);
    }
    if (run.builderMessage) lines.push(run.builderMessage);
    return lines.join('\n');
}

export function buildRunSummary(run: BuildRunReport): string {
    const contradicted = run.exitCode !== null && run.state !== 'success' && run.state !== 'unknown';
    return [
        `${buildVerdict(run)}  ${run.platform}  debug=${run.debug === undefined ? 'unknown' : run.debug}`,
        run.modifiedTaskSettings.length
            ? `wrote onto the task: ${run.modifiedTaskSettings.join(', ')} — that edit is permanent, `
                + 'the same as changing those fields in the Build panel'
            : '',
        contradicted
            ? `the builder returned ${run.exitName} but its task state is "${run.state}"`
            : '',
        run.overwrites
            ? `this new task writes to the same folder as task ${run.overwrites}: `
                + `${run.buildPath}/${run.outputName} — that task's build output is replaced, its `
                + 'settings are not. Pass --options to keep them apart'
            : '',
        run.timedOut ? 'the build is still running in the editor; watch it with `cocos build status`' : ''
    ].filter(Boolean).join('\n');
}

export function renderBuilderStatus(status: BuilderStatus): string {
    const worker = [
        status.ready ? 'worker ready' : 'worker not ready',
        status.idle === null ? '' : status.idle ? 'idle' : 'busy'
    ].filter(Boolean).join('  ');

    if (!status.tasks.length) {
        return `${worker}\nno build tasks — the Build panel has no rows to rebuild`;
    }
    return [worker, ...table(status.tasks.map(task => [
        task.id, task.platform, task.state, task.name,
        task.progress === null || task.progress >= 1
            ? task.message
            : `${Math.round(task.progress * 100)}% ${task.message}`.trim()
    ]))].join('\n');
}

export function builderStatusSummary(status: BuilderStatus): string {
    return `tasks: ${status.tasks.length}  running: ${
        status.tasks.filter(task => taskIsRunning(task.state)).length}`;
}
