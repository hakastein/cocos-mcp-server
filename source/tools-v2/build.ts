import { z } from 'zod';
import { booleanArg, defineTool } from '../tool';
import { ok, fail } from '../result';
import { textOf } from './shared';
import { coerceJsonArg } from '../json-arg';
import { BuildExitCode, describeTask, exitCodeName, settingConflicts } from '../build-task';
import type { BuildTask, BuildTaskOptions } from '../editor-api';
import type { RegisteredTool } from '../tool';
import type { ToolContext } from '../context';

const BUILD_PLATFORMS = [
    'web-mobile', 'web-desktop', 'ios', 'android', 'windows', 'mac', 'huawei-quick-game',
    'alipay-mini-game', 'bytedance-mini-game', 'wechatgame', 'oppo-mini-game', 'vivo-mini-game',
    'xiaomi-quick-game', 'link-sure', 'cocos-play', 'baidu-mini-game', 'taobao-creative-app'
] as const;

const DEFAULT_BUILD_TIMEOUT_MS = 900000;

const objectArg = z.preprocess(value => coerceJsonArg(value).value, z.record(z.any()));

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise<T>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms);
        })
    ]);
}

/** The rows the Build panel shows for this platform, oldest first; task ids are timestamps. */
async function platformTasks(ctx: ToolContext, platform: string): Promise<BuildTask[]> {
    const info = await ctx.editor.builder.queryTasksInfo().catch(() => null);
    const list = Array.isArray(info?.list) ? info!.list! : [];
    return list.filter(task => task?.options?.platform === platform)
        .sort((a, b) => Number(a.id) - Number(b.id));
}

async function buildTaskIds(ctx: ToolContext): Promise<Set<string>> {
    const info = await ctx.editor.builder.queryTasksInfo().catch(() => null);
    return new Set(Array.isArray(info?.list) ? info!.list!.map(task => String(task.id)) : []);
}

async function finishedTask(ctx: ToolContext, before: Set<string>): Promise<BuildTask | undefined> {
    const info = await ctx.editor.builder.queryTasksInfo().catch(() => null);
    const list = Array.isArray(info?.list) ? info!.list! : [];
    const fresh = list.filter(task => !before.has(String(task.id)));
    return (fresh.length ? fresh : list).sort((a, b) => Number(a.id) - Number(b.id)).pop();
}

/**
 * Options the Build panel would use for this platform. Hand-written options would silently
 * ignore everything the project has configured — bundle compression, included modules, the
 * start scene — and produce a package unlike the one the panel makes.
 */
async function savedBuildOptions(ctx: ToolContext, platform: string): Promise<BuildTaskOptions> {
    const common: BuildTaskOptions = {};
    const saved = await ctx.editor.project.profile(platform, 'builder.common').catch(() => null);
    if (saved && typeof saved === 'object') Object.assign(common, saved);

    // Platform-plugin options (useWebGPU, orientation, …) are keyed by task id, not by platform.
    const map = await ctx.editor.project.profile(platform, 'builder.taskOptionsMap').catch(() => null);
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

export const projectBuildProject = defineTool({
    name: 'project_build_project',
    description: 'Run a real build and wait for it to finish. Returns the build state '
        + '(success/failure), the output directory and the builder\'s own message — so a build can '
        + 'actually gate a task. Rebuilds the platform\'s EXISTING build task in place — the same row '
        + 'the Build panel shows, with the settings it is configured with — instead of piling up a new '
        + 'task per build. CAN MODIFY SAVED SETTINGS: rebuilding writes the options back onto that '
        + 'task, so `debug`/`options` that disagree with it would permanently edit that Build-panel '
        + 'row. The call REFUSES in that case unless allowTaskEdit:true, and refuses to guess when the '
        + 'platform has several tasks unless taskId says which. Every refusal happens before anything '
        + 'is written. Builds take minutes; raise timeoutMs for a cold build.',
    schema: z.object({
        platform: z.enum(BUILD_PLATFORMS).describe('Build platform'),
        debug: booleanArg.optional().describe('Debug build. Omit it to build the task exactly as '
            + 'configured. If it disagrees with the target task the call refuses rather than rewriting '
            + 'the task — see allowTaskEdit.'),
        options: objectArg.optional().describe('Extra IBuildTaskOption fields merged over the target '
            + 'task\'s own options, e.g. {"sourceMaps":false,"buildPath":"project://build"}. Fields '
            + 'that disagree with the task refuse the call the same way `debug` does. Merged shallowly: '
            + 'a nested object replaces the saved one whole.'),
        taskId: z.string().optional().describe('Rebuild this specific task (ids come from '
            + 'project_check_builder_status). Required once the platform has more than one task — the '
            + 'tool will not pick for you.'),
        newTask: booleanArg.optional().describe('Add a NEW build task with these settings instead of '
            + 'rebuilding an existing one. Leaves every existing task untouched, at the cost of another '
            + 'permanent row in the Build panel. Off by default.'),
        allowTaskEdit: booleanArg.optional().describe('Permit this call to overwrite the target task\'s '
            + 'saved settings with `debug`/`options`. Off by default. The change is permanent and '
            + 'indistinguishable from editing those fields in the Build panel.'),
        timeoutMs: z.coerce.number().min(10000).optional()
            .describe(`How long to wait for the build to finish before giving up on WAITING; the build itself keeps running in the editor (default ${DEFAULT_BUILD_TIMEOUT_MS})`)
    }),
    async handler(args, ctx) {
        const platform = args.platform;
        const timeoutMs = args.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;

        let ready: boolean;
        try {
            ready = await ctx.editor.builder.queryWorkerReady();
        } catch (error) {
            return fail('builder_unreachable', `Cannot reach the builder: ${textOf(error)}`);
        }
        if (!ready) {
            return fail('builder_not_ready',
                'The build worker is not ready yet. It starts with the editor; retry in a few seconds.');
        }

        if (args.newTask === true && args.taskId) {
            return fail('contradictory_args',
                'newTask and taskId contradict each other: one adds a task, the other rebuilds an existing one.');
        }

        const overrides: Record<string, any> = {};
        if (args.debug !== undefined) overrides.debug = args.debug;
        if (args.options) Object.assign(overrides, args.options);

        // Everything up to `add-task` is read-only on purpose: a call ending in a refusal must
        // leave the Build panel exactly as it found it.
        const existing = await platformTasks(ctx, platform);
        const listed = existing.map(describeTask);
        let target: BuildTask | undefined;

        if (args.newTask !== true) {
            if (args.taskId) {
                target = existing.find(task => String(task.id) === String(args.taskId));
                if (!target) {
                    const elsewhere = await ctx.editor.builder.queryTask(args.taskId).catch(() => null);
                    return fail('task_not_found',
                        elsewhere
                            ? `Build task ${args.taskId} is a ${elsewhere.options?.platform} task, not ${platform}.`
                            : `No build task with id ${args.taskId}. List them with project_check_builder_status.`,
                        undefined, { platform, tasks: listed });
                }
            } else if (existing.length > 1) {
                return fail('ambiguous_task',
                    `${platform} has ${existing.length} build tasks holding different settings, and picking one `
                    + 'for you is how a configuration gets destroyed. Pass taskId to name the one to rebuild, or '
                    + 'newTask:true to build a separate task. Nothing was built and nothing was changed.',
                    undefined, { platform, tasks: listed });
            } else {
                target = existing[0];
            }
        }

        const conflicts = target ? settingConflicts(target.options, overrides) : [];
        if (conflicts.length && args.allowTaskEdit !== true) {
            const described = describeTask(target);
            const shape = (pick: 'saved' | 'requested') =>
                conflicts.map(conflict => `${conflict.field}=${JSON.stringify(conflict[pick])}`).join(', ');
            return fail('task_settings_conflict',
                `Build task ${described.taskId} ("${described.taskName}") is configured with ${shape('saved')}, `
                + `and this call asks for ${shape('requested')}. Building it would write those values onto the `
                + 'task and overwrite its saved settings for good. Nothing was built and nothing was changed.',
                'Drop the override to rebuild the task as configured, pass newTask:true to build a separate '
                + 'task with these settings, or pass allowTaskEdit:true to really change this one.',
                { platform, task: described, conflicts, tasks: listed });
        }

        // Past this line the call writes. A target task carries the options it was last built
        // with — the panel's own state for that row.
        const options: BuildTaskOptions = target
            ? { ...JSON.parse(JSON.stringify(target.options || {})), platform, taskId: String(target.id) }
            : { ...(await savedBuildOptions(ctx, platform)), platform };
        Object.assign(options, overrides);

        // Not in the public message typings, so a build must not depend on it succeeding.
        const checked = await ctx.editor.builder.checkAndCompleteOptions(options).catch(() => null);
        const completed: BuildTaskOptions = checked && typeof checked === 'object' ? checked : options;
        if (!completed.taskName) completed.taskName = platform;

        // A new task inherits its output path from the saved profile, so it can land on top of
        // another task's build output without saying so; settings survive, artefacts do not.
        const collision = target ? undefined : existing.find(task =>
            task?.options?.buildPath === completed.buildPath && task?.options?.outputName === completed.outputName);
        const overwrites = collision
            ? `This new task writes to the same folder as task ${collision.id} `
                + `("${describeTask(collision).taskName}"): ${completed.buildPath}/${completed.outputName}. `
                + 'That task\'s build output is replaced; its settings are not. Set options.outputName to keep them apart.'
            : undefined;

        const before = await buildTaskIds(ctx);
        const startedAt = Date.now();
        let result: unknown;
        try {
            result = await withTimeout(
                ctx.editor.builder.addTask(completed, true),
                timeoutMs,
                `Build did not finish within ${timeoutMs}ms. It is still running in the editor — `
                    + 'watch it with project_check_builder_status, or raise timeoutMs.'
            );
        } catch (error) {
            return fail('build_failed', textOf(error), undefined,
                { platform, elapsedMs: Date.now() - startedAt });
        }

        const exitCode = typeof result === 'number' ? result : undefined;
        const exitName = exitCode === undefined ? undefined : exitCodeName(exitCode);
        // A rebuilt task is not new, so it cannot be found by diffing the task list.
        const task = (completed.taskId
            ? await ctx.editor.builder.queryTask(completed.taskId).catch(() => undefined)
            : undefined) || await finishedTask(ctx, before);
        const state = task?.state ?? 'unknown';

        const codeSaysOk = exitCode === undefined ? undefined : exitCode === BuildExitCode.BUILD_SUCCESS;
        const stateSaysOk = state === 'unknown' ? undefined : state === 'success';
        const succeeded = codeSaysOk === undefined ? stateSaysOk === true
            : stateSaysOk === undefined ? codeSaysOk
            : codeSaysOk && stateSaysOk;
        const disagreement = codeSaysOk !== undefined && stateSaysOk !== undefined && codeSaysOk !== stateSaysOk
            ? `The builder returned ${exitName} but its task state is "${state}" — treat this build as suspect.`
            : undefined;

        const report = {
            platform,
            state,
            exitCode,
            exitName,
            taskId: task?.id,
            rebuiltExistingTask: !!target,
            modifiedTaskSettings: conflicts.length ? conflicts.map(conflict => conflict.field) : undefined,
            overwrites,
            elapsedMs: Date.now() - startedAt,
            buildPath: completed.buildPath,
            outputName: completed.outputName,
            debug: completed.debug,
            builderMessage: task?.message,
            builderDetail: task?.detailMessage,
            disagreement
        };

        if (!succeeded) {
            return fail('build_failed',
                disagreement
                || (state !== 'unknown'
                    ? `Build ${state} (${exitName || 'no exit code'}): ${task?.message || task?.detailMessage || 'no message from the builder'}`
                    : `Build finished with ${exitName} and no task could be found. Check the Build panel.`),
                undefined, report);
        }
        return ok(report, task?.message || `Build finished for ${platform}`);
    }
});

export const projectCheckBuilderStatus = defineTool({
    name: 'project_check_builder_status',
    description: 'Builder worker readiness plus the build tasks that exist, queued, running or '
        + 'finished. "ready" means the worker process is up — it says nothing about whether a build '
        + 'succeeded; that is what project_build_project returns. Task ids listed here are what '
        + 'project_build_project takes as `taskId`.',
    schema: z.object({}),
    async handler(_args, ctx) {
        let ready: boolean;
        try {
            ready = await ctx.editor.builder.queryWorkerReady();
        } catch (error) {
            return fail('builder_unreachable', `Cannot reach the builder: ${textOf(error)}`);
        }

        const info = await ctx.editor.builder.queryTasksInfo().catch(() => null);
        const list = Array.isArray(info?.list) ? info!.list! : [];
        const running = list.filter(task => task.state === 'processing' || task.state === 'waiting');

        return ok({
            ready,
            status: ready ? 'Builder worker is ready' : 'Builder worker is not ready',
            idle: info?.free,
            runningTasks: running.map(task => ({
                id: task.id, state: task.state, progress: task.progress,
                message: task.message, platform: task.options?.platform
            })),
            recentTasks: list.slice(-5).map(task => ({
                id: task.id, state: task.state, message: task.message,
                platform: task.options?.platform, time: task.time
            })),
            note: 'Readiness is not a build result — run project_build_project to actually build.'
        });
    }
});

export const projectGetBuildSettings = defineTool({
    name: 'project_get_build_settings',
    description: 'How building through this bridge behaves, plus whether the build worker is up. The '
        + 'build configuration itself is not editable from here: it lives in the Build panel and, for '
        + 'this repo, in the committed per-build config file.',
    schema: z.object({}),
    async handler(_args, ctx) {
        let ready: boolean;
        try {
            ready = await ctx.editor.builder.queryWorkerReady();
        } catch (error) {
            return fail('builder_unreachable', `Cannot reach the builder: ${textOf(error)}`);
        }
        return ok({
            builderReady: ready,
            message: 'project_build_project rebuilds the platform\'s existing Build-panel task with the '
                + 'options that task holds, falling back to the saved project profile when the platform '
                + 'has no task yet. It refuses to choose when a platform has several tasks (pass taskId) '
                + 'and refuses to build when `debug`/`options` disagree with the task, because building '
                + 'writes them onto it.',
            availableActions: [
                'Run a build with project_build_project (waits for the result)',
                'Check worker readiness and running tasks with project_check_builder_status',
                'Open the build panel with project_open_build_panel'
            ]
        });
    }
});

export const projectOpenBuildPanel = defineTool({
    name: 'project_open_build_panel',
    description: 'Open the editor\'s Build panel. This only shows the panel to the person at the '
        + 'editor — it starts no build; project_build_project does that.',
    schema: z.object({}),
    async handler(_args, ctx) {
        try {
            await ctx.editor.builder.openPanel();
        } catch (error) {
            return fail('open_failed', `The build panel did not open: ${textOf(error)}`);
        }
        return ok(undefined, 'Build panel opened');
    }
});

export const projectRunProject = defineTool({
    name: 'project_run_project',
    description: 'Start the in-editor preview — the editor\'s own Play button — so the game actually '
        + 'runs and can be judged. Stopping it is the editor\'s Stop button. Preview output is read '
        + 'with debug_get_preview_logs.',
    schema: z.object({}),
    async handler(_args, ctx) {
        let started;
        try {
            started = await ctx.sceneScript.call('previewPlay', 'start');
        } catch (error) {
            return fail('preview_unavailable', `The preview could not be started: ${textOf(error)}`);
        }
        if (!started?.success) {
            return fail('preview_unavailable',
                `The preview facade did not start the game: ${started?.error || 'no answer from the scene script'}`,
                'Open the Build panel with project_open_build_panel and press Play there instead.');
        }
        return ok({ mode: 'in-editor-preview' },
            'In-editor preview started (Play). Use the editor Stop button to end it.');
    }
});

export const projectGetProjectInfo = defineTool({
    name: 'project_get_project_info',
    description: 'Which project the editor has open: name, disk path, project uuid, and the Cocos '
        + 'Creator version running it. The first thing to ask when a scene or an asset is not where it '
        + 'was expected — the bridge talks to whichever project this editor opened.',
    schema: z.object({}),
    async handler(_args, ctx) {
        const info: Record<string, unknown> = {
            name: Editor.Project.name,
            path: Editor.Project.path,
            uuid: Editor.Project.uuid,
            version: (Editor.Project as any).version || '1.0.0',
            cocosVersion: (Editor as any).versions?.cocos || 'Unknown'
        };
        const config = await ctx.editor.project.queryConfig('project').catch(() => null);
        if (config) info.config = config;
        return ok(info, `${info.name} (${info.path})`);
    }
});

const SETTINGS_CATEGORIES: Record<string, string> = {
    general: 'project',
    physics: 'physics',
    render: 'render',
    assets: 'asset-db'
};

export const projectGetProjectSettings = defineTool({
    name: 'project_get_project_settings',
    description: 'One category of the project settings as the editor holds it: general (project), '
        + 'physics, render, or assets (asset-db).',
    schema: z.object({
        category: z.enum(['general', 'physics', 'render', 'assets']).optional()
            .describe('Settings category (default general)')
    }),
    async handler(args, ctx) {
        const category = args.category ?? 'general';
        try {
            const config = await ctx.editor.project.queryConfig(SETTINGS_CATEGORIES[category]);
            return ok({ category, config }, `${category} settings retrieved`);
        } catch (error) {
            return fail('settings_unavailable', `${category} settings could not be read: ${textOf(error)}`);
        }
    }
});

export const buildTools: RegisteredTool[] = [
    projectBuildProject,
    projectCheckBuilderStatus,
    projectGetBuildSettings,
    projectOpenBuildPanel,
    projectRunProject,
    projectGetProjectInfo,
    projectGetProjectSettings
];
