/**
 * What `builder.add-task` resolves with. Declared in the editor's own
 * builtin/builder/@types/protected/options.d.ts, which ships outside the public typings — so
 * 36 reads like a failure to anyone who assumes 0 means success. It means BUILD_SUCCESS.
 */
export enum BuildExitCode {
    PARAM_ERROR = 32,
    BUILD_FAILED = 34,
    BUILD_SUCCESS = 36,
    BUILD_BUSY = 37,
    UNKNOWN_ERROR = 50,
}

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
    return BuildExitCode[code] ?? `UNDOCUMENTED_${code}`;
}

/** Key order must not read as a difference. */
export function stableJson(value: any): string {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

/** A task as the caller needs to see it to choose between several. */
export function describeTask(task: any): BuildTaskDescription {
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
 * Which caller overrides would change the task's saved settings. Building a task writes its
 * options back, so every difference here is a permanent edit to that Build-panel row — the
 * user's `web-mobile-debug` task lost its Debug flag to a `{platform, debug:false}` call that
 * meant nothing by it.
 */
export function settingConflicts(saved: any, overrides: Record<string, any>): SettingConflict[] {
    return Object.entries(overrides)
        .filter(([field, requested]) => stableJson(saved?.[field]) !== stableJson(requested))
        .map(([field, requested]) => ({ field, saved: saved?.[field], requested }));
}
