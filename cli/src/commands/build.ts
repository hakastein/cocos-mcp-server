import { Command, Option } from 'commander';
import {
    BUILD_PLATFORMS, describeTask, exitCodeName, freshestTask, outputCollision, platformTasks,
    settingConflicts, taskRow
} from '../build-task.ts';
import { raceTimeout } from '../settle.ts';
import { booleanFlag, jsonFlag, numberFlag } from './flags.ts';
import { withClient } from './shared.ts';
import type { BuildTask, BuildTaskOptions, Driver } from '@cocos-cli/shared';
import type { BuildTaskDescription, SettingConflict } from '../build-task.ts';
import type { Report } from '../render/present.ts';
import type { Resolved } from '../resolve.ts';

const DEFAULT_BUILD_TIMEOUT_MS = 900000;

export interface BuildRunSpec {
    platform: string;
    taskId?: string;
    newTask?: boolean;
    debug?: boolean;
    options?: Record<string, unknown>;
    allowTaskEdit?: boolean;
    timeoutMs?: number;
}

function refusal(summary: string, note?: string): Report {
    return { kind: 'action', verdict: 'FAILED', summary, note };
}

/**
 * A task list this refuses to answer would read as a platform with no rows, and `buildRun` would
 * then add a permanent one — so before a build the refusal propagates rather than becoming `[]`.
 */
async function tasksOf(client: Driver): Promise<BuildTask[]> {
    const info = await client.editor.builder.queryTasksInfo();
    return Array.isArray(info?.list) ? info.list : [];
}

export async function buildStatus(client: Driver): Promise<Report> {
    const ready = await client.editor.builder.queryWorkerReady();
    const info = await client.editor.builder.queryTasksInfo().catch(() => null);
    return {
        kind: 'builderStatus',
        status: {
            ready: ready === true,
            idle: typeof info?.free === 'boolean' ? info.free : null,
            tasks: (Array.isArray(info?.list) ? info.list : []).map(taskRow)
        }
    };
}

export async function buildPanel(client: Driver): Promise<Report> {
    await client.editor.builder.openPanel();
    return {
        kind: 'action',
        verdict: 'ok',
        summary: 'build panel opened',
        note: 'this only shows the panel to whoever is at the editor; it starts no build'
    };
}

function listTasks(tasks: readonly BuildTask[]): string {
    return tasks.map(task => {
        const described = describeTask(task);
        return `  ${described.taskId}  "${described.taskName}"  debug=${described.debug}`
            + `  ${described.buildPath || '?'}/${described.outputName || '?'}`;
    }).join('\n');
}

function conflictRefusal(
    described: BuildTaskDescription, platform: string, conflicts: readonly SettingConflict[]
): Report {
    const spelled = (pick: 'saved' | 'requested') =>
        conflicts.map(conflict => `${conflict.field}=${JSON.stringify(conflict[pick])}`).join(', ');
    return refusal(
        `building ${platform} would overwrite the saved settings of task ${described.taskId}`,
        `task ${described.taskId} ("${described.taskName}") is configured with ${spelled('saved')}, `
        + `and this call asks for ${spelled('requested')}. Building it writes those values onto the `
        + 'task for good. Nothing was built and nothing was changed.\n'
        + 'Drop the override to rebuild the task as configured, pass --new-task to build a separate '
        + 'task with these settings, or pass --allow-task-edit to really change this one.');
}

/**
 * Options the Build panel would use for this platform. Hand-written options would silently ignore
 * everything the project has configured — bundle compression, included modules, the start scene —
 * and produce a package unlike the one the panel makes.
 */
async function savedBuildOptions(client: Driver, platform: string): Promise<BuildTaskOptions> {
    const common: BuildTaskOptions = {};
    const saved = await client.editor.project.profile(platform, 'builder.common').catch(() => null);
    if (saved && typeof saved === 'object') Object.assign(common, saved);

    // Platform-plugin options (useWebGPU, orientation, …) are keyed by task id, not by platform.
    const map = await client.editor.project.profile(platform, 'builder.taskOptionsMap').catch(() => null);
    const ids = map && typeof map === 'object' ? Object.keys(map) : [];
    if (ids.length) {
        const newest = ids.sort()[ids.length - 1];
        common.packages = {
            ...(common.packages || {}),
            [platform]: { ...(common.packages || {})[platform], ...map[newest] }
        };
    }
    return common;
}

/**
 * Rebuilds the platform's EXISTING Build-panel row with the options that row holds, because
 * building writes the options back onto the task: every override that disagrees with it is a
 * permanent edit to that row, and the call refuses rather than making one unasked.
 */
export async function buildRun(client: Driver, spec: BuildRunSpec): Promise<Report> {
    if (await client.editor.builder.queryWorkerReady() !== true) {
        return refusal('the build worker is not ready',
            'it starts with the editor; retry in a few seconds');
    }
    if (spec.newTask === true && spec.taskId !== undefined) {
        return refusal('--new-task and --task contradict each other',
            'one adds a task, the other rebuilds an existing one');
    }

    const overrides: Record<string, unknown> = { ...spec.options };
    if (spec.debug !== undefined) overrides.debug = spec.debug;

    // Everything up to `addTask` is read-only on purpose: a call ending in a refusal must leave the
    // Build panel exactly as it found it.
    const all = await tasksOf(client);
    const existing = platformTasks(all, spec.platform);
    let target: BuildTask | undefined;

    if (spec.newTask !== true) {
        if (spec.taskId !== undefined) {
            target = existing.find(task => String(task.id) === spec.taskId);
            if (!target) {
                const elsewhere = all.find(task => String(task.id) === spec.taskId);
                return refusal(`no ${spec.platform} build task with id ${spec.taskId}`,
                    elsewhere
                        ? `build task ${spec.taskId} is a ${elsewhere.options?.platform} task, not `
                            + `${spec.platform}`
                        : `list them with \`cocos build status\`:\n${listTasks(existing)}`);
            }
        } else if (existing.length > 1) {
            return refusal(
                `${spec.platform} has ${existing.length} build tasks holding different settings`,
                'picking one is how a configuration gets destroyed. Pass --task to name the one to '
                + 'rebuild, or --new-task to build a separate task. Nothing was built.\n'
                + listTasks(existing));
        } else {
            target = existing[0];
        }
    }

    const conflicts = target ? settingConflicts(target.options, overrides) : [];
    if (conflicts.length && spec.allowTaskEdit !== true) {
        return conflictRefusal(describeTask(target), spec.platform, conflicts);
    }

    // Past this line the call writes. A target task carries the options it was last built with —
    // the panel's own state for that row.
    const options: BuildTaskOptions = target
        ? { ...JSON.parse(JSON.stringify(target.options || {})), platform: spec.platform, taskId: String(target.id) }
        : { ...(await savedBuildOptions(client, spec.platform)), platform: spec.platform };
    Object.assign(options, overrides);

    // Not in the public message typings, so a build must not depend on it succeeding.
    const checked = await client.editor.builder.checkAndCompleteOptions(options).catch(() => null);
    const completed: BuildTaskOptions = checked && typeof checked === 'object' ? checked : options;
    if (!completed.taskName) completed.taskName = spec.platform;

    const collision = target ? undefined : outputCollision(existing, completed);
    const knownBefore = new Set(all.map(task => String(task.id)));
    const startedAt = Date.now();
    const answer = await raceTimeout(
        client.editor.builder.addTask(completed, true), spec.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS);

    const timedOut = answer === 'timed out';
    const exitCode = typeof answer === 'number' ? answer : null;
    // Nothing is asked after a timeout: the driver serves one request at a time, so the read-back
    // would queue behind the build that is still running and the wait would not end after all.
    // A rebuilt task is not new, so it cannot be found by diffing the task list.
    const built = timedOut ? null : (completed.taskId
        ? await client.editor.builder.queryTask(completed.taskId).catch(() => null)
        : null) || freshestTask(await tasksOf(client).catch(() => []), knownBefore);

    return {
        kind: 'buildRun',
        run: {
            platform: spec.platform,
            taskId: built ? String(built.id) : completed.taskId ?? null,
            taskName: describeTask(built ?? target).taskName,
            rebuiltExistingTask: target !== undefined,
            exitCode,
            exitName: exitCode === null ? null : exitCodeName(exitCode),
            state: built?.state || 'unknown',
            buildPath: completed.buildPath,
            outputName: completed.outputName,
            debug: completed.debug,
            builderMessage: built?.message || built?.detailMessage,
            elapsedMs: Date.now() - startedAt,
            modifiedTaskSettings: conflicts.map(conflict => conflict.field),
            overwrites: collision ? String(collision.id) : null,
            timedOut
        }
    };
}

export function registerBuild(program: Command, resolve: () => Promise<Resolved>): void {
    const build = program.command('build')
        .description(`the editor's builder: its worker, its Build-panel rows, and running one`);

    build.command('status')
        .description('whether the build worker is up, and the tasks the Build panel holds')
        .option('--json', 'print the structural form instead of text')
        .action((options: { json?: boolean }) =>
            withClient(resolve, buildStatus, { json: options.json }));

    build.command('panel')
        .description('open the editor Build panel for whoever is sitting at it; starts no build')
        .action(() => withClient(resolve, buildPanel));

    build.command('run')
        .description('rebuild the platform\'s existing Build-panel task and wait for it to finish')
        .addOption(new Option('--platform <name>', 'which platform to build')
            .choices([...BUILD_PLATFORMS]).makeOptionMandatory())
        .option('--task <id>', 'rebuild this task; required once the platform has more than one')
        .option('--new-task', 'add a new task with these settings instead of rebuilding one')
        .option('--debug <bool>', 'debug build; omit it to build the task exactly as configured')
        .option('--options <json>', 'extra IBuildTaskOption fields merged over the task\'s own')
        .option('--allow-task-edit', 'permit this build to overwrite the task\'s saved settings')
        .option('--timeout <ms>', `how long to wait for the build (default ${DEFAULT_BUILD_TIMEOUT_MS})`)
        .option('--json', 'print the structural form instead of text')
        .action((options: {
            platform: string; task?: string; newTask?: boolean; debug?: string; options?: string;
            allowTaskEdit?: boolean; timeout?: string; json?: boolean;
        }) => withClient(resolve, client => buildRun(client, {
            platform: options.platform,
            taskId: options.task,
            newTask: options.newTask,
            debug: booleanFlag('--debug', options.debug),
            options: options.options === undefined
                ? undefined
                : jsonFlag(options.options) as Record<string, unknown>,
            allowTaskEdit: options.allowTaskEdit,
            timeoutMs: numberFlag('--timeout', options.timeout)
        }), { json: options.json }));
}
