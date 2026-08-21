import type { BuildTask, BuildTaskOptions } from '@cocos-cli/shared';

/**
 * What `builder.addTask` resolves with. Declared in the editor's own
 * builtin/builder/@types/protected/options.d.ts, which ships outside the public typings — so 36
 * reads like a failure to anyone who assumes 0 means success. It means BUILD_SUCCESS.
 */
export const BuildExitCode = {
    PARAM_ERROR: 32,
    BUILD_FAILED: 34,
    BUILD_SUCCESS: 36,
    BUILD_BUSY: 37,
    UNKNOWN_ERROR: 50
} as const;

export interface BuildTaskDescription {
    taskId: string;
    taskName: string | undefined;
    platform: string | undefined;
    debug: boolean | undefined;
    sourceMaps: boolean | undefined;
    buildPath: string | undefined;
    outputName: string | undefined;
}

export interface SettingConflict {
    field: string;
    saved: unknown;
    requested: unknown;
}

export function exitCodeName(code: number): string {
    const named = Object.entries(BuildExitCode).find(([, value]) => value === code);
    return named ? named[0] : `UNDOCUMENTED_${code}`;
}

/** Key order must not read as a difference. */
export function stableJson(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
        .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

export function describeTask(task: BuildTask | undefined): BuildTaskDescription {
    const options = task?.options || {};
    return {
        taskId: String(task?.id),
        taskName: options.name ?? options.taskName ?? task?.taskName,
        platform: options.platform,
        debug: options.debug,
        sourceMaps: options.sourceMaps,
        buildPath: options.buildPath,
        outputName: options.outputName
    };
}

/**
 * Which caller overrides would change the task's saved settings. Building a task writes its options
 * back, so every difference here is a permanent edit to that Build-panel row — the user's
 * `web-mobile-debug` task lost its Debug flag to a `{platform, debug:false}` call that meant
 * nothing by it.
 */
export function settingConflicts(
    saved: BuildTaskOptions | undefined, overrides: Record<string, unknown>
): SettingConflict[] {
    return Object.entries(overrides)
        .filter(([field, requested]) => stableJson(saved?.[field]) !== stableJson(requested))
        .map(([field, requested]) => ({ field, saved: saved?.[field], requested }));
}

/** The platforms the editor's own Build panel offers; a typo here would add a junk task instead. */
export const BUILD_PLATFORMS = [
    'web-mobile', 'web-desktop', 'ios', 'android', 'windows', 'mac', 'huawei-quick-game',
    'alipay-mini-game', 'bytedance-mini-game', 'wechatgame', 'oppo-mini-game', 'vivo-mini-game',
    'xiaomi-quick-game', 'link-sure', 'cocos-play', 'baidu-mini-game', 'taobao-creative-app'
] as const;

const RUNNING_STATES = new Set(['processing', 'waiting']);

export interface BuildTaskRow {
    id: string;
    platform: string;
    state: string;
    name: string;
    /** 0..1, or null when the editor reported none. */
    progress: number | null;
    message: string;
}

export interface BuilderStatus {
    ready: boolean;
    /** `query-tasks-info`'s `free`; null when the editor did not answer it. */
    idle: boolean | null;
    tasks: BuildTaskRow[];
}

export interface BuildRunReport {
    platform: string;
    taskId: string | null;
    taskName: string | undefined;
    rebuiltExistingTask: boolean;
    /** The number `add-task` resolved with, or null when it resolved with something else. */
    exitCode: number | null;
    exitName: string | null;
    state: string;
    buildPath: string | undefined;
    outputName: string | undefined;
    debug: boolean | undefined;
    builderMessage: string | undefined;
    elapsedMs: number;
    /** Fields this build wrote onto the task's saved settings — a permanent edit to that panel row. */
    modifiedTaskSettings: string[];
    /** Id of the task whose build output a NEW task lands on top of, when one does. */
    overwrites: string | null;
    /** The wait ran out; the build itself is still going in the editor. */
    timedOut: boolean;
}

export function taskIsRunning(state: string): boolean {
    return RUNNING_STATES.has(state);
}

export function taskRow(task: BuildTask): BuildTaskRow {
    const described = describeTask(task);
    return {
        id: described.taskId,
        platform: described.platform || 'unknown',
        state: task.state || 'unknown',
        name: described.taskName || '',
        progress: typeof task.progress === 'number' ? task.progress : null,
        message: task.message || task.detailMessage || ''
    };
}

/** The rows the Build panel shows for this platform, oldest first; task ids are timestamps. */
export function platformTasks(tasks: readonly BuildTask[], platform: string): BuildTask[] {
    return tasks.filter(task => task?.options?.platform === platform)
        .sort((first, second) => Number(first.id) - Number(second.id));
}

/**
 * The task a build just produced. A task rebuilt in place is not new, so when nothing appeared the
 * newest row of the whole list is the one that ran.
 */
export function freshestTask(
    tasks: readonly BuildTask[], knownBefore: ReadonlySet<string>
): BuildTask | null {
    const fresh = tasks.filter(task => !knownBefore.has(String(task.id)));
    return (fresh.length ? fresh : tasks)
        .slice().sort((first, second) => Number(first.id) - Number(second.id)).pop() || null;
}

/**
 * A new task inherits its output path from the saved profile, so it can land on top of another
 * task's build output without saying so: settings survive, artefacts do not.
 */
export function outputCollision(
    tasks: readonly BuildTask[], options: BuildTaskOptions
): BuildTask | undefined {
    return tasks.find(task => task?.options?.buildPath === options.buildPath
        && task?.options?.outputName === options.outputName);
}
