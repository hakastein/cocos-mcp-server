import { ToolDefinition, ToolResponse, ToolExecutor, ProjectInfo, AssetInfo } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import { ALIAS_KEY } from '../tool-args';

/**
 * A db:// asset location is spelled `url` here but `assetPath` on get_asset_details and
 * `prefabPath` in prefab-tools, so callers reasonably guess the wrong one. Accepting the
 * alternates costs nothing and removes a whole class of "parameter error" dead ends —
 * `reimport_asset` given `assetPath` used to reach the editor as `undefined` and come back
 * as "Cannot read properties of undefined (reading 'startsWith')".
 */
const ASSET_URL_ALIASES = ['assetPath', 'path', 'assetUrl'];

/**
 * What `builder.add-task` resolves with. Declared in the editor's own
 * builtin/builder/@types/protected/options.d.ts, which ships outside the public typings — so
 * 36 reads like a failure to anyone who assumes 0 means success. It means BUILD_SUCCESS.
 */
const enum BuildExitCode {
    PARAM_ERROR = 32,
    BUILD_FAILED = 34,
    BUILD_SUCCESS = 36,
    BUILD_BUSY = 37,
    UNKNOWN_ERROR = 50,
}

const BUILD_EXIT_CODES: Record<number, string> = {
    32: 'PARAM_ERROR',
    34: 'BUILD_FAILED',
    36: 'BUILD_SUCCESS',
    37: 'BUILD_BUSY',
    50: 'UNKNOWN_ERROR',
};

export class ProjectTools implements ToolExecutor {
    // Serialises asset moves. Parallel move-asset requests into the same destination folder
    // race inside the editor asset-db: with rename-on-conflict enabled, two concurrent moves
    // each compute the same free name before either finishes, producing duplicates / corruption.
    // Chaining every move through this promise makes them run strictly one-at-a-time in-server.
    private moveChain: Promise<any> = Promise.resolve();

    getTools(): ToolDefinition[] {
        return [
            {
                name: 'run_project',
                description: 'Run the project in preview mode',
                inputSchema: {
                    type: 'object',
                    properties: {
                        platform: {
                            type: 'string',
                            description: 'Target platform',
                            enum: ['browser', 'simulator', 'preview'],
                            default: 'browser'
                        }
                    }
                }
            },
            {
                name: 'build_project',
                description: 'Run a real build and wait for it to finish. Returns the build state (success/failure), '
                    + 'the output directory and the builder\'s own message — so a build can actually gate a task. '
                    + 'Rebuilds the platform\'s EXISTING build task in place — the same row the Build panel shows, with '
                    + 'the settings it is configured with — instead of piling up a new task per build. CAN MODIFY SAVED '
                    + 'SETTINGS: rebuilding writes the options back onto that task, so `debug`/`options` that disagree '
                    + 'with it would permanently edit that Build-panel row. The call REFUSES in that case unless '
                    + 'allowTaskEdit:true, and refuses to guess when the platform has several tasks unless taskId says '
                    + 'which. Every refusal happens before anything is written. Builds take minutes; raise timeoutMs '
                    + 'for a cold build.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        platform: {
                            type: 'string',
                            description: 'Build platform',
                            enum: ['web-mobile', 'web-desktop', 'ios', 'android', 'windows', 'mac', 'huawei-quick-game',
                                'alipay-mini-game', 'bytedance-mini-game', 'wechatgame', 'oppo-mini-game', 'vivo-mini-game',
                                'xiaomi-quick-game', 'link-sure', 'cocos-play', 'baidu-mini-game', 'taobao-creative-app']
                        },
                        debug: {
                            type: 'boolean',
                            description: 'Debug build. Omit it to build the task exactly as configured. If it disagrees '
                                + 'with the target task the call refuses rather than rewriting the task — see allowTaskEdit.'
                        },
                        options: {
                            type: 'object',
                            description: 'Extra IBuildTaskOption fields merged over the target task\'s own options, e.g. '
                                + '{"sourceMaps":false,"buildPath":"project://build"}. Fields that disagree with the task '
                                + 'refuse the call the same way `debug` does. Merged shallowly: a nested object replaces '
                                + 'the saved one whole.'
                        },
                        taskId: {
                            type: 'string',
                            description: 'Rebuild this specific task (ids come from check_builder_status). Required once '
                                + 'the platform has more than one task — the tool will not pick for you.'
                        },
                        newTask: {
                            type: 'boolean',
                            description: 'Add a NEW build task with these settings instead of rebuilding an existing one. '
                                + 'Leaves every existing task untouched, at the cost of another permanent row in the '
                                + 'Build panel. Off by default.'
                        },
                        allowTaskEdit: {
                            type: 'boolean',
                            description: 'Permit this call to overwrite the target task\'s saved settings with `debug`/'
                                + '`options`. Off by default. The change is permanent and indistinguishable from editing '
                                + 'those fields in the Build panel, so only pass it when changing that task IS the intent.'
                        },
                        timeoutMs: {
                            type: 'number',
                            description: 'How long to wait for the build to finish before giving up on WAITING (the build '
                                + 'itself keeps running in the editor)',
                            default: 900000,
                            minimum: 10000
                        }
                    },
                    required: ['platform']
                }
            },
            {
                name: 'get_project_info',
                description: 'Get project information',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'get_project_settings',
                description: 'Get project settings',
                inputSchema: {
                    type: 'object',
                    properties: {
                        category: {
                            type: 'string',
                            description: 'Settings category',
                            enum: ['general', 'physics', 'render', 'assets'],
                            default: 'general'
                        }
                    }
                }
            },
            {
                name: 'refresh_assets',
                description: 'Refresh asset database',
                inputSchema: {
                    type: 'object',
                    properties: {
                        folder: {
                            type: 'string',
                            description: 'Specific folder to refresh (optional)'
                        }
                    }
                }
            },
            {
                name: 'import_asset',
                description: 'Import an asset file',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sourcePath: {
                            type: 'string',
                            description: 'Source file path'
                        },
                        targetFolder: {
                            type: 'string',
                            description: 'Target folder in assets'
                        }
                    },
                    required: ['sourcePath', 'targetFolder']
                }
            },
            {
                name: 'get_asset_info',
                description: 'Get asset information',
                inputSchema: {
                    type: 'object',
                    properties: {
                        assetPath: {
                            type: 'string',
                            description: 'Asset path (db://assets/...)'
                        }
                    },
                    required: ['assetPath']
                }
            },
            {
                name: 'get_assets',
                description: 'Get assets by type',
                inputSchema: {
                    type: 'object',
                    properties: {
                        type: {
                            type: 'string',
                            description: 'Asset type filter',
                            enum: ['all', 'scene', 'prefab', 'script', 'texture', 'material', 'mesh', 'audio', 'animation'],
                            default: 'all'
                        },
                        folder: {
                            type: 'string',
                            description: 'Folder to search in',
                            default: 'db://assets'
                        }
                    }
                }
            },
            {
                name: 'get_build_settings',
                description: 'Get build settings - shows current limitations',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'open_build_panel',
                description: 'Open the build panel in the editor',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'check_builder_status',
                description: 'Builder worker readiness plus the build tasks that exist, queued, running or finished. '
                    + '"ready" means the worker process is up — it says nothing about whether a build succeeded; that is '
                    + 'what build_project returns. Task ids listed here are what build_project takes as `taskId`.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'create_asset',
                description: 'Create a new asset file or folder',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            [ALIAS_KEY]: ASSET_URL_ALIASES,
                            description: 'Asset URL (e.g., db://assets/newfile.json)'
                        },
                        content: {
                            type: 'string',
                            description: 'File content (null for folder)',
                            default: null
                        },
                        overwrite: {
                            type: 'boolean',
                            description: 'Overwrite existing file',
                            default: false
                        }
                    },
                    required: ['url']
                }
            },
            {
                name: 'copy_asset',
                description: 'Copy an asset to another location',
                inputSchema: {
                    type: 'object',
                    properties: {
                        source: {
                            type: 'string',
                            description: 'Source asset URL'
                        },
                        target: {
                            type: 'string',
                            description: 'Target location URL'
                        },
                        overwrite: {
                            type: 'boolean',
                            description: 'Overwrite existing file',
                            default: false
                        }
                    },
                    required: ['source', 'target']
                }
            },
            {
                name: 'move_asset',
                description: 'Move an asset to another location',
                inputSchema: {
                    type: 'object',
                    properties: {
                        source: {
                            type: 'string',
                            description: 'Source asset URL'
                        },
                        target: {
                            type: 'string',
                            description: 'Target location URL'
                        },
                        overwrite: {
                            type: 'boolean',
                            description: 'Overwrite existing file',
                            default: false
                        }
                    },
                    required: ['source', 'target']
                }
            },
            {
                name: 'delete_asset',
                description: 'Delete an asset',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            [ALIAS_KEY]: ASSET_URL_ALIASES,
                            description: 'Asset URL to delete (db://assets/...)'
                        }
                    },
                    required: ['url']
                }
            },
            {
                name: 'save_asset',
                description: 'Save asset content',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            [ALIAS_KEY]: ASSET_URL_ALIASES,
                            description: 'Asset URL (db://assets/...)'
                        },
                        content: {
                            type: 'string',
                            description: 'Asset content'
                        }
                    },
                    required: ['url', 'content']
                }
            },
            {
                name: 'reimport_asset',
                description: 'Reimport an asset',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            [ALIAS_KEY]: ASSET_URL_ALIASES,
                            description: 'Asset URL to reimport (db://assets/...)'
                        }
                    },
                    required: ['url']
                }
            },
            {
                name: 'query_asset_path',
                description: 'Get asset disk path',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            [ALIAS_KEY]: ASSET_URL_ALIASES,
                            description: 'Asset URL (db://assets/...)'
                        }
                    },
                    required: ['url']
                }
            },
            {
                name: 'query_asset_uuid',
                description: 'Get asset UUID from URL',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            [ALIAS_KEY]: ASSET_URL_ALIASES,
                            description: 'Asset URL (db://assets/...)'
                        }
                    },
                    required: ['url']
                }
            },
            {
                name: 'query_asset_url',
                description: 'Get asset URL from UUID',
                inputSchema: {
                    type: 'object',
                    properties: {
                        uuid: {
                            type: 'string',
                            description: 'Asset UUID'
                        }
                    },
                    required: ['uuid']
                }
            },
            {
                name: 'find_asset_by_name',
                description: 'Find assets by name (supports partial matching and multiple results)',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Asset name to search for (supports partial matching)'
                        },
                        exactMatch: {
                            type: 'boolean',
                            description: 'Whether to use exact name matching',
                            default: false
                        },
                        assetType: {
                            type: 'string',
                            description: 'Filter by asset type',
                            enum: ['all', 'scene', 'prefab', 'script', 'texture', 'material', 'mesh', 'audio', 'animation', 'spriteFrame'],
                            default: 'all'
                        },
                        folder: {
                            type: 'string',
                            description: 'Folder to search in',
                            default: 'db://assets'
                        },
                        maxResults: {
                            type: 'number',
                            description: 'Maximum number of results to return',
                            default: 20,
                            minimum: 1,
                            maximum: 100
                        }
                    },
                    required: ['name']
                }
            },
            {
                name: 'get_asset_details',
                description: 'Get detailed asset information including sub-assets. For an FBX/glTF model the sub-assets ' +
                    'are grouped into meshes / materials / animationClips / skeletons / textures / modelPrefab so a ' +
                    'MeshRenderer can be built from a mesh or a clip resolved without guessing. Accepts a db:// url ' +
                    'or a uuid under any of: assetPath, url, path, uuid.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        assetPath: {
                            type: 'string',
                            description: 'Asset db:// url (db://assets/...) or a uuid. Aliases: url, path, uuid.'
                        },
                        url: { type: 'string', description: 'Alias for assetPath (db:// url).' },
                        path: { type: 'string', description: 'Alias for assetPath (db:// url).' },
                        uuid: { type: 'string', description: 'Asset uuid (alternative to a db:// url).' },
                        includeSubAssets: {
                            type: 'boolean',
                            description: 'Include sub-assets like meshes, materials, clips, spriteFrame, texture',
                            default: true
                        }
                    }
                }
            }
        ];
    }

    async execute(toolName: string, args: any): Promise<ToolResponse> {
        switch (toolName) {
            case 'run_project':
                return await this.runProject(args.platform);
            case 'build_project':
                return await this.buildProject(args);
            case 'get_project_info':
                return await this.getProjectInfo();
            case 'get_project_settings':
                return await this.getProjectSettings(args.category);
            case 'refresh_assets':
                return await this.refreshAssets(args.folder);
            case 'import_asset':
                return await this.importAsset(args.sourcePath, args.targetFolder);
            case 'get_asset_info':
                return await this.getAssetInfo(args.assetPath);
            case 'get_assets':
                return await this.getAssets(args.type, args.folder);
            case 'get_build_settings':
                return await this.getBuildSettings();
            case 'open_build_panel':
                return await this.openBuildPanel();
            case 'check_builder_status':
                return await this.checkBuilderStatus();
            case 'create_asset':
                return await this.createAsset(args.url, args.content, args.overwrite);
            case 'copy_asset':
                return await this.copyAsset(args.source, args.target, args.overwrite);
            case 'move_asset':
                return await this.moveAsset(args.source, args.target, args.overwrite);
            case 'delete_asset':
                return await this.deleteAsset(args.url);
            case 'save_asset':
                return await this.saveAsset(args.url, args.content);
            case 'reimport_asset':
                return await this.reimportAsset(args.url);
            case 'query_asset_path':
                return await this.queryAssetPath(args.url);
            case 'query_asset_uuid':
                return await this.queryAssetUuid(args.url);
            case 'query_asset_url':
                return await this.queryAssetUrl(args.uuid);
            case 'find_asset_by_name':
                return await this.findAssetByName(args);
            case 'get_asset_details': {
                // Accept assetPath / url / path / uuid — passing e.g. { url } used to reach
                // query-asset-info as `undefined` and fail with a bare "parameter error".
                const ref = args.assetPath ?? args.url ?? args.path ?? args.uuid;
                return await this.getAssetDetails(ref, args.includeSubAssets);
            }
            default:
                throw new Error(`Unknown tool: ${toolName}`);
        }
    }

    private async runProject(platform: string = 'browser'): Promise<ToolResponse> {
        // Prefer launching the in-editor preview (the Play button) via the editor facade
        // (cce.PreviewPlay) run in the scene process — this actually starts the game so an
        // agent/human can validate behaviour, instead of merely opening the build panel.
        try {
            const res: any = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'cocos-mcp-server',
                method: 'previewPlay',
                args: ['start']
            });
            if (res && res.success) {
                return {
                    success: true,
                    message: 'In-editor preview started (Play). Use the editor Stop button to end it.',
                    data: { mode: 'in-editor-preview' }
                };
            }
            // Fall through to the build panel if the preview facade is unavailable.
            await (Editor.Message.request as any)('builder', 'open');
            return {
                success: true,
                message: `Preview facade unavailable (${res?.error || 'unknown'}); opened the build panel instead.`,
                data: { mode: 'build-panel' }
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Options the Build panel would use for this platform, from the project profile
     * (`profiles/v2/packages/<platform>.json` → `builder.taskOptionsMap`). Building from the
     * bridge with hand-written options would silently ignore everything the project has
     * configured — bundle compression, included modules, the start scene — and produce a
     * package unlike the one the panel makes.
     */
    private async savedBuildOptions(platform: string): Promise<any> {
        let common: any = {};
        try {
            // `builder.common` is the platform's IBuildTaskOption: buildPath, outputName,
            // startScene, scenes, buildMode, module overrides — everything that decides what
            // the package contains.
            const saved = await Editor.Profile.getProject(platform, 'builder.common');
            if (saved && typeof saved === 'object') common = { ...saved };
        } catch {
            // never built for this platform: the builder fills defaults below
        }

        try {
            // Platform-plugin options (useWebGPU, orientation, …) are stored separately, keyed
            // by build-task id rather than by platform, and belong under `packages[platform]`.
            // The newest task is the closest thing to "what the panel is set to".
            const map = await Editor.Profile.getProject(platform, 'builder.taskOptionsMap');
            const ids = map && typeof map === 'object' ? Object.keys(map) : [];
            if (ids.length) {
                const newest = ids.sort()[ids.length - 1];
                common.packages = { ...(common.packages || {}), [platform]: { ...(common.packages || {})[platform], ...map[newest] } };
            }
        } catch {
            // platform options unavailable: build with the common config alone
        }

        return common;
    }

    /**
     * The build tasks this platform has, i.e. the rows the Build panel shows, oldest first.
     * `add-task` without an `options.taskId` mints a task per call, so every bridge build used to
     * leave another permanent entry in the panel behind it. Read-only.
     */
    private async platformTasks(platform: string): Promise<any[]> {
        try {
            const info: any = await (Editor.Message.request as any)('builder', 'query-tasks-info', { type: 'build' });
            const list: any[] = Array.isArray(info?.list) ? info.list : [];
            // Task ids are creation timestamps.
            return list.filter((t) => t?.options?.platform === platform).sort((a, b) => Number(a.id) - Number(b.id));
        } catch {
            return [];
        }
    }

    /** A task as the caller needs to see it to choose between several. */
    private static describeTask(t: any): any {
        const o = t?.options || {};
        return {
            taskId: String(t?.id),
            taskName: o.name ?? o.taskName ?? t?.taskName,
            platform: o.platform,
            debug: o.debug,
            sourceMaps: o.sourceMaps,
            buildPath: o.buildPath,
            outputName: o.outputName
        };
    }

    /** Key order must not read as a difference. */
    private static stable(v: any): string {
        if (v === undefined) return 'undefined';
        if (v === null || typeof v !== 'object') return JSON.stringify(v);
        if (Array.isArray(v)) return `[${v.map((x) => ProjectTools.stable(x)).join(',')}]`;
        return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${ProjectTools.stable(v[k])}`).join(',')}}`;
    }

    /**
     * Which caller overrides would change the task's saved settings. Building a task writes its
     * options back, so every difference here is a permanent edit to that Build-panel row — the
     * user's `web-mobile-debug` task lost its Debug flag to a `{platform, debug:false}` call that
     * meant nothing by it.
     */
    private static settingConflicts(saved: any, overrides: Record<string, any>): Array<{ field: string; saved: any; requested: any }> {
        return Object.entries(overrides)
            .filter(([field, requested]) => ProjectTools.stable(saved?.[field]) !== ProjectTools.stable(requested))
            .map(([field, requested]) => ({ field, saved: saved?.[field], requested }));
    }

    /**
     * Run a build to completion.
     *
     * `builder.open` only opens the panel; it was what this tool used to do, and it returned
     * success without a build ever running. The real verb is `add-task`, whose second argument
     * makes the editor resolve the request only once the task has finished.
     */
    private async buildProject(args: any): Promise<ToolResponse> {
        const platform = args.platform;
        const timeoutMs = Number.isFinite(Number(args.timeoutMs)) ? Number(args.timeoutMs) : 900000;

        let ready: boolean;
        try {
            ready = await Editor.Message.request('builder', 'query-worker-ready');
        } catch (err: any) {
            return { success: false, error: `Cannot reach the builder: ${err.message}` };
        }
        if (!ready) {
            return {
                success: false,
                error: 'The build worker is not ready yet. It starts with the editor; retry in a few seconds.'
            };
        }

        const overrides: Record<string, any> = {};
        if (args.debug !== undefined) overrides.debug = args.debug;
        if (args.options && typeof args.options === 'object') Object.assign(overrides, args.options);

        if (args.newTask === true && args.taskId) {
            return {
                success: false,
                error: 'newTask and taskId contradict each other: one adds a task, the other rebuilds an existing one.'
            };
        }

        // Everything from here to the `add-task` below is read-only on purpose. A call that ends in
        // a refusal must leave the Build panel exactly as it found it — the settings write is part
        // of the build, never a precondition of deciding whether to run one.
        const existing = await this.platformTasks(platform);
        const listed = existing.map((t) => ProjectTools.describeTask(t));
        let target: any;

        if (args.newTask !== true) {
            if (args.taskId) {
                target = existing.find((t) => String(t.id) === String(args.taskId));
                if (!target) {
                    const elsewhere = await this.queryTask(args.taskId);
                    return {
                        success: false,
                        error: elsewhere
                            ? `Build task ${args.taskId} is a ${elsewhere?.options?.platform} task, not ${platform}.`
                            : `No build task with id ${args.taskId}. List them with check_builder_status.`,
                        data: { platform, tasks: listed }
                    };
                }
            } else if (existing.length > 1) {
                return {
                    success: false,
                    error: `${platform} has ${existing.length} build tasks holding different settings, and picking one for `
                        + 'you is how a configuration gets destroyed. Pass taskId to name the one to rebuild, or '
                        + 'newTask:true to build a separate task. Nothing was built and nothing was changed.',
                    data: { platform, tasks: listed }
                };
            } else {
                target = existing[0];
            }
        }

        const conflicts = target ? ProjectTools.settingConflicts(target.options, overrides) : [];
        if (conflicts.length && args.allowTaskEdit !== true) {
            const d = ProjectTools.describeTask(target);
            const shape = (pick: 'saved' | 'requested') =>
                conflicts.map((c) => `${c.field}=${JSON.stringify(c[pick])}`).join(', ');
            return {
                success: false,
                error: `Build task ${d.taskId} ("${d.taskName}") is configured with ${shape('saved')}, and this call asks `
                    + `for ${shape('requested')}. Building it would write those values onto the task and overwrite its `
                    + 'saved settings for good. Drop the override to rebuild the task as configured, pass newTask:true to '
                    + 'build a separate task with these settings, or pass allowTaskEdit:true to really change this one. '
                    + 'Nothing was built and nothing was changed.',
                data: { platform, task: d, conflicts, tasks: listed }
            };
        }

        // Past this line the call writes: `add-task` stores whatever options it is given onto the
        // task it names. A target task carries the options it was last built with — the panel's own
        // state for that row, and a better base than anything reassembled from the profile.
        const options: any = target
            ? { ...JSON.parse(JSON.stringify(target.options || {})), platform, taskId: String(target.id) }
            : { ...(await this.savedBuildOptions(platform)), platform };
        Object.assign(options, overrides);

        // Lets the builder fill in and migrate anything still missing. Not in the public
        // message typings, so a build must not depend on it succeeding.
        let completed = options;
        try {
            const checked = await (Editor.Message.request as any)('builder', 'check-and-complete-options', options);
            if (checked && typeof checked === 'object') completed = checked;
        } catch {
            // older/newer editor without this message: build with what we assembled
        }

        if (!completed.taskName) completed.taskName = platform;

        // A new task inherits its output path from the saved profile, which mirrors whichever task
        // was configured last — so it can land on top of another task's build without saying so.
        // Settings survive; the artefacts in that folder do not.
        const collision = target ? undefined : existing.find((t) =>
            t?.options?.buildPath === completed.buildPath && t?.options?.outputName === completed.outputName);
        const overwrites = collision
            ? `This new task writes to the same folder as task ${collision.id} `
                + `("${ProjectTools.describeTask(collision).taskName}"): ${completed.buildPath}/${completed.outputName}. `
                + 'That task\'s build output is replaced; its settings are not. Set options.outputName to keep them apart.'
            : undefined;

        // The task list before the build, so the task this call creates can be told apart from
        // earlier ones afterwards.
        const before = new Set(await this.buildTaskIds());

        const startedAt = Date.now();
        let result: any;
        try {
            result = await this.withTimeout(
                (Editor.Message.request as any)('builder', 'add-task', completed, true),
                timeoutMs,
                `Build did not finish within ${timeoutMs}ms. It is still running in the editor — `
                    + 'watch it with check_builder_status, or raise timeoutMs.'
            );
        } catch (err: any) {
            return { success: false, error: err.message, data: { platform, elapsedMs: Date.now() - startedAt } };
        }

        // `add-task` answers with a BuildExitCode — 36 is SUCCESS, not a failure. The value is
        // absent from the public typings, so it is decoded here and cross-checked against the
        // task's own state; a disagreement is reported rather than silently resolved.
        const exitCode = typeof result === 'number' ? result : undefined;
        const exitName = exitCode === undefined ? undefined : (BUILD_EXIT_CODES[exitCode] || `UNDOCUMENTED_${exitCode}`);
        // A rebuilt task is not new, so it cannot be found by diffing the task list.
        const task = (completed.taskId ? await this.queryTask(completed.taskId) : undefined)
            || await this.findFinishedTask(before);
        const state = task?.state ?? 'unknown';

        const codeSaysOk = exitCode === undefined ? undefined : exitCode === BuildExitCode.BUILD_SUCCESS;
        const stateSaysOk = state === 'unknown' ? undefined : state === 'success';
        const succeeded = codeSaysOk === undefined ? stateSaysOk === true
            : stateSaysOk === undefined ? codeSaysOk
            : codeSaysOk && stateSaysOk;
        const disagreement = codeSaysOk !== undefined && stateSaysOk !== undefined && codeSaysOk !== stateSaysOk
            ? `The builder returned ${exitName} but its task state is "${state}" — treat this build as suspect.`
            : undefined;

        return {
            success: !!succeeded,
            error: succeeded ? undefined
                : disagreement
                || (state !== 'unknown'
                    ? `Build ${state} (${exitName || 'no exit code'}): ${task?.message || task?.detailMessage || 'no message from the builder'}`
                    : `Build finished with ${exitName} and no task could be found. Check the Build panel.`),
            message: succeeded ? (task?.message || `Build finished for ${platform}`) : undefined,
            data: {
                platform,
                state,
                exitCode,
                exitName,
                taskId: task?.id,
                rebuiltExistingTask: !!target,
                modifiedTaskSettings: conflicts.length ? conflicts.map((c) => c.field) : undefined,
                overwrites,
                elapsedMs: Date.now() - startedAt,
                buildPath: completed.buildPath,
                outputName: completed.outputName,
                debug: completed.debug,
                builderMessage: task?.message,
                builderDetail: task?.detailMessage,
                disagreement
            }
        } as ToolResponse;
    }

    private async queryTask(id: string): Promise<any> {
        try {
            return await (Editor.Message.request as any)('builder', 'query-task', String(id));
        } catch {
            return undefined;
        }
    }

    private async buildTaskIds(): Promise<string[]> {
        try {
            const info: any = await (Editor.Message.request as any)('builder', 'query-tasks-info', { type: 'build' });
            return Array.isArray(info?.list) ? info.list.map((t: any) => String(t.id)) : [];
        } catch {
            return [];
        }
    }

    /** The task this build created: the one that is new since `before`, else the most recent. */
    private async findFinishedTask(before: Set<string>): Promise<any> {
        let list: any[] = [];
        try {
            const info: any = await (Editor.Message.request as any)('builder', 'query-tasks-info', { type: 'build' });
            list = Array.isArray(info?.list) ? info.list : [];
        } catch {
            return undefined;
        }
        const fresh = list.filter((t) => !before.has(String(t.id)));
        const candidates = fresh.length ? fresh : list;
        // Task ids are creation timestamps, so the largest is the newest.
        return candidates.sort((a, b) => Number(a.id) - Number(b.id)).pop();
    }

    private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
        let timer: any;
        return Promise.race([
            promise.finally(() => clearTimeout(timer)),
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), ms);
            })
        ]);
    }

    private async getProjectInfo(): Promise<ToolResponse> {
        return new Promise((resolve) => {
            const info: ProjectInfo = {
                name: Editor.Project.name,
                path: Editor.Project.path,
                uuid: Editor.Project.uuid,
                version: (Editor.Project as any).version || '1.0.0',
                cocosVersion: (Editor as any).versions?.cocos || 'Unknown'
            };

            // Note: 'query-info' API doesn't exist, using 'query-config' instead
            Editor.Message.request('project', 'query-config', 'project').then((additionalInfo: any) => {
                if (additionalInfo) {
                    Object.assign(info, { config: additionalInfo });
                }
                resolve({ success: true, data: info });
            }).catch(() => {
                // Return basic info even if detailed query fails
                resolve({ success: true, data: info });
            });
        });
    }

    private async getProjectSettings(category: string = 'general'): Promise<ToolResponse> {
        return new Promise((resolve) => {
            // Query project config via project API
            const configMap: Record<string, string> = {
                general: 'project',
                physics: 'physics',
                render: 'render',
                assets: 'asset-db'
            };

            const configName = configMap[category] || 'project';

            Editor.Message.request('project', 'query-config', configName).then((settings: any) => {
                resolve({
                    success: true,
                    data: {
                        category: category,
                        config: settings,
                        message: `${category} settings retrieved successfully`
                    }
                });
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async refreshAssets(folder?: string): Promise<ToolResponse> {
        return new Promise((resolve) => {
            // Refresh assets via asset-db API
            const targetPath = folder || 'db://assets';
            
            Editor.Message.request('asset-db', 'refresh-asset', targetPath).then(() => {
                resolve({
                    success: true,
                    message: `Assets refreshed in: ${targetPath}`
                });
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async importAsset(sourcePath: string, targetFolder: string): Promise<ToolResponse> {
        return new Promise((resolve) => {
            if (!fs.existsSync(sourcePath)) {
                resolve({ success: false, error: 'Source file not found' });
                return;
            }

            const fileName = path.basename(sourcePath);
            const targetPath = targetFolder.startsWith('db://') ?
                targetFolder : `db://assets/${targetFolder}`;

            Editor.Message.request('asset-db', 'import-asset', sourcePath, `${targetPath}/${fileName}`).then((result: any) => {
                resolve({
                    success: true,
                    data: {
                        uuid: result.uuid,
                        path: result.url,
                        message: `Asset imported: ${fileName}`
                    }
                });
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async getAssetInfo(assetPath: string): Promise<ToolResponse> {
        return new Promise((resolve) => {
            Editor.Message.request('asset-db', 'query-asset-info', assetPath).then((assetInfo: any) => {
                if (!assetInfo) {
                    throw new Error('Asset not found');
                }

                const info: AssetInfo = {
                    name: assetInfo.name,
                    uuid: assetInfo.uuid,
                    path: assetInfo.url,
                    type: assetInfo.type,
                    size: assetInfo.size,
                    isDirectory: assetInfo.isDirectory
                };

                if (assetInfo.meta) {
                    info.meta = {
                        ver: assetInfo.meta.ver,
                        importer: assetInfo.meta.importer
                    };
                }

                resolve({ success: true, data: info });
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async getAssets(type: string = 'all', folder: string = 'db://assets'): Promise<ToolResponse> {
        return new Promise((resolve) => {
            let pattern = `${folder}/**/*`;
            
            // Apply type filter
            if (type !== 'all') {
                const typeExtensions: Record<string, string> = {
                    'scene': '.scene',
                    'prefab': '.prefab',
                    'script': '.{ts,js}',
                    'texture': '.{png,jpg,jpeg,gif,tga,bmp,psd}',
                    'material': '.mtl',
                    'mesh': '.{fbx,obj,dae}',
                    'audio': '.{mp3,ogg,wav,m4a}',
                    'animation': '.{anim,clip}'
                };
                
                const extension = typeExtensions[type];
                if (extension) {
                    pattern = `${folder}/**/*${extension}`;
                }
            }

            // Note: query-assets API parameters corrected based on documentation
            Editor.Message.request('asset-db', 'query-assets', { pattern: pattern }).then((results: any[]) => {
                const assets = results.map(asset => ({
                    name: asset.name,
                    uuid: asset.uuid,
                    path: asset.url,
                    type: asset.type,
                    size: asset.size || 0,
                    isDirectory: asset.isDirectory || false
                }));
                
                resolve({ 
                    success: true, 
                    data: {
                        type: type,
                        folder: folder,
                        count: assets.length,
                        assets: assets
                    }
                });
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async getBuildSettings(): Promise<ToolResponse> {
        return new Promise((resolve) => {
            // Check if builder worker is ready
            Editor.Message.request('builder', 'query-worker-ready').then((ready: boolean) => {
                resolve({
                    success: true,
                    data: {
                        builderReady: ready,
                        message: 'build_project rebuilds the platform\'s existing Build-panel task with the options that '
                            + 'task holds, falling back to the saved project profile when the platform has no task yet. '
                            + 'It refuses to choose when a platform has several tasks (pass taskId) and refuses to build '
                            + 'when `debug`/`options` disagree with the task, because building writes them onto it.',
                        availableActions: [
                            'Run a build with build_project (waits for the result)',
                            'Check worker readiness and running tasks with check_builder_status',
                            'Open the build panel with open_build_panel'
                        ]
                    }
                });
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async openBuildPanel(): Promise<ToolResponse> {
        return new Promise((resolve) => {
            (Editor.Message.request as any)('builder', 'open').then(() => {
                resolve({
                    success: true,
                    message: 'Build panel opened successfully'
                });
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async checkBuilderStatus(): Promise<ToolResponse> {
        let ready: boolean;
        try {
            ready = await Editor.Message.request('builder', 'query-worker-ready');
        } catch (err: any) {
            return { success: false, error: err.message };
        }

        let tasks: any;
        try {
            tasks = await (Editor.Message.request as any)('builder', 'query-tasks-info', { type: 'build' });
        } catch {
            // task listing unavailable on this editor build; readiness alone still answers
        }

        const list = Array.isArray(tasks?.list) ? tasks.list : [];
        const running = list.filter((t: any) => t.state === 'processing' || t.state === 'waiting');
        return {
            success: true,
            data: {
                ready,
                status: ready ? 'Builder worker is ready' : 'Builder worker is not ready',
                idle: tasks?.free,
                runningTasks: running.map((t: any) => ({
                    id: t.id, state: t.state, progress: t.progress, message: t.message, platform: t.options?.platform
                })),
                recentTasks: list.slice(-5).map((t: any) => ({
                    id: t.id, state: t.state, message: t.message, platform: t.options?.platform, time: t.time
                })),
                note: 'Readiness is not a build result — run build_project to actually build.'
            }
        };
    }

    private async createAsset(url: string, content: string | null = null, overwrite: boolean = false): Promise<ToolResponse> {
        return new Promise((resolve) => {
            const options = {
                overwrite: overwrite,
                rename: !overwrite
            };

            Editor.Message.request('asset-db', 'create-asset', url, content, options).then((result: any) => {
                if (result && result.uuid) {
                    resolve({
                        success: true,
                        data: {
                            uuid: result.uuid,
                            url: result.url,
                            message: content === null ? 'Folder created successfully' : 'File created successfully'
                        }
                    });
                } else {
                    resolve({
                        success: true,
                        data: {
                            url: url,
                            message: content === null ? 'Folder created successfully' : 'File created successfully'
                        }
                    });
                }
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async copyAsset(source: string, target: string, overwrite: boolean = false): Promise<ToolResponse> {
        return new Promise((resolve) => {
            const options = {
                overwrite: overwrite,
                rename: !overwrite
            };

            Editor.Message.request('asset-db', 'copy-asset', source, target, options).then((result: any) => {
                if (result && result.uuid) {
                    resolve({
                        success: true,
                        data: {
                            uuid: result.uuid,
                            url: result.url,
                            message: 'Asset copied successfully'
                        }
                    });
                } else {
                    resolve({
                        success: true,
                        data: {
                            source: source,
                            target: target,
                            message: 'Asset copied successfully'
                        }
                    });
                }
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async moveAsset(source: string, target: string, overwrite: boolean = false): Promise<ToolResponse> {
        // Enqueue on the serialisation chain so concurrent moves never run against the asset-db
        // at the same time. Errors are swallowed for the *chain* (so one failed move does not
        // wedge the queue) but still returned to *this* caller via the awaited run promise.
        const run = this.moveChain.then(() => this.doMoveAsset(source, target, overwrite));
        this.moveChain = run.then(() => undefined, () => undefined);
        return run;
    }

    private async doMoveAsset(source: string, target: string, overwrite: boolean = false): Promise<ToolResponse> {
        return new Promise((resolve) => {
            const options = {
                overwrite: overwrite,
                rename: !overwrite
            };

            Editor.Message.request('asset-db', 'move-asset', source, target, options).then((result: any) => {
                if (result && result.uuid) {
                    resolve({
                        success: true,
                        data: {
                            uuid: result.uuid,
                            url: result.url,
                            message: 'Asset moved successfully'
                        }
                    });
                } else {
                    resolve({
                        success: true,
                        data: {
                            source: source,
                            target: target,
                            message: 'Asset moved successfully'
                        }
                    });
                }
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async deleteAsset(url: string): Promise<ToolResponse> {
        return new Promise((resolve) => {
            Editor.Message.request('asset-db', 'delete-asset', url).then((result: any) => {
                resolve({
                    success: true,
                    data: {
                        url: url,
                        message: 'Asset deleted successfully'
                    }
                });
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async saveAsset(url: string, content: string): Promise<ToolResponse> {
        return new Promise((resolve) => {
            Editor.Message.request('asset-db', 'save-asset', url, content).then((result: any) => {
                if (result && result.uuid) {
                    resolve({
                        success: true,
                        data: {
                            uuid: result.uuid,
                            url: result.url,
                            message: 'Asset saved successfully'
                        }
                    });
                } else {
                    resolve({
                        success: true,
                        data: {
                            url: url,
                            message: 'Asset saved successfully'
                        }
                    });
                }
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async reimportAsset(url: string): Promise<ToolResponse> {
        // The asset-db calls .startsWith on whatever it is handed, so a non-db:// value
        // surfaces as a bare TypeError with no hint of which argument was wrong.
        if (typeof url !== 'string' || !url.startsWith('db://')) {
            return {
                success: false,
                error: `reimport_asset: 'url' must be a db:// asset url (e.g. db://assets/scripts/foo.ts), `
                    + `received ${JSON.stringify(url)}. The db:// url is also accepted as assetPath / path / assetUrl.`
            };
        }
        return new Promise((resolve) => {
            Editor.Message.request('asset-db', 'reimport-asset', url).then(() => {
                resolve({
                    success: true,
                    data: {
                        url: url,
                        message: 'Asset reimported successfully'
                    }
                });
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async queryAssetPath(url: string): Promise<ToolResponse> {
        return new Promise((resolve) => {
            Editor.Message.request('asset-db', 'query-path', url).then((path: string | null) => {
                if (path) {
                    resolve({
                        success: true,
                        data: {
                            url: url,
                            path: path,
                            message: 'Asset path retrieved successfully'
                        }
                    });
                } else {
                    resolve({ success: false, error: 'Asset path not found' });
                }
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async queryAssetUuid(url: string): Promise<ToolResponse> {
        return new Promise((resolve) => {
            Editor.Message.request('asset-db', 'query-uuid', url).then((uuid: string | null) => {
                if (uuid) {
                    resolve({
                        success: true,
                        data: {
                            url: url,
                            uuid: uuid,
                            message: 'Asset UUID retrieved successfully'
                        }
                    });
                } else {
                    resolve({ success: false, error: 'Asset UUID not found' });
                }
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async queryAssetUrl(uuid: string): Promise<ToolResponse> {
        return new Promise((resolve) => {
            Editor.Message.request('asset-db', 'query-url', uuid).then((url: string | null) => {
                if (url) {
                    resolve({
                        success: true,
                        data: {
                            uuid: uuid,
                            url: url,
                            message: 'Asset URL retrieved successfully'
                        }
                    });
                } else {
                    resolve({ success: false, error: 'Asset URL not found' });
                }
            }).catch((err: Error) => {
                resolve({ success: false, error: err.message });
            });
        });
    }

    private async findAssetByName(args: any): Promise<ToolResponse> {
        const { name, exactMatch = false, assetType = 'all', folder = 'db://assets', maxResults = 20 } = args;
        
        return new Promise(async (resolve) => {
            try {
                // Get all assets in the specified folder
                const allAssetsResponse = await this.getAssets(assetType, folder);
                if (!allAssetsResponse.success || !allAssetsResponse.data) {
                    resolve({
                        success: false,
                        error: `Failed to get assets: ${allAssetsResponse.error}`
                    });
                    return;
                }
                
                const allAssets = allAssetsResponse.data.assets as any[];
                let matchedAssets: any[] = [];
                
                // Search for matching assets
                for (const asset of allAssets) {
                    const assetName = asset.name;
                    let matches = false;
                    
                    if (exactMatch) {
                        matches = assetName === name;
                    } else {
                        matches = assetName.toLowerCase().includes(name.toLowerCase());
                    }
                    
                    if (matches) {
                        // Get detailed asset info if needed
                        try {
                            const detailResponse = await this.getAssetInfo(asset.path);
                            if (detailResponse.success) {
                                matchedAssets.push({
                                    ...asset,
                                    details: detailResponse.data
                                });
                            } else {
                                matchedAssets.push(asset);
                            }
                        } catch {
                            matchedAssets.push(asset);
                        }
                        
                        if (matchedAssets.length >= maxResults) {
                            break;
                        }
                    }
                }
                
                resolve({
                    success: true,
                    data: {
                        searchTerm: name,
                        exactMatch,
                        assetType,
                        folder,
                        totalFound: matchedAssets.length,
                        maxResults,
                        assets: matchedAssets,
                        message: `Found ${matchedAssets.length} assets matching '${name}'`
                    }
                });
                
            } catch (error: any) {
                resolve({
                    success: false,
                    error: `Asset search failed: ${error.message}`
                });
            }
        });
    }
    
    private async getAssetDetails(assetPath: string, includeSubAssets: boolean = true): Promise<ToolResponse> {
        return new Promise(async (resolve) => {
            try {
                if (!assetPath) {
                    resolve({ success: false, error: 'Provide the asset as assetPath / url / path (db:// url) or uuid.' });
                    return;
                }
                // Get basic asset info (query-asset-info accepts either a db:// url or a uuid).
                const assetInfoResponse = await this.getAssetInfo(assetPath);
                if (!assetInfoResponse.success) {
                    resolve(assetInfoResponse);
                    return;
                }
                
                const assetInfo = assetInfoResponse.data;
                const detailedInfo: any = {
                    ...assetInfo,
                    subAssets: []
                };
                
                if (includeSubAssets && assetInfo?.uuid) {
                    // Enumerate sub-assets GENERICALLY from the import metadata (subMetas),
                    // which covers meshes (importer 'gltf-mesh'), gltf-materials, and
                    // image spriteFrame/texture sub-assets — dynamically, with no hardcoded
                    // sub-id suffixes. The sub-id is an artifact of the import, so it must
                    // be read, not guessed.
                    try {
                        const meta: any = await Editor.Message.request('asset-db', 'query-asset-meta', assetInfo.uuid);
                        const subMetas = meta?.subMetas || {};
                        for (const sid of Object.keys(subMetas)) {
                            const sm = subMetas[sid];
                            if (!sm) continue;
                            detailedInfo.subAssets.push({
                                id: sid,
                                name: sm.name || sm.displayName || sid,
                                importer: sm.importer,
                                uuid: sm.uuid || `${assetInfo.uuid}@${sid}`
                            });
                        }
                    } catch { /* no meta / not a container asset */ }

                    // Fallback: query-asset-info sub-assets if the meta yielded none.
                    if (detailedInfo.subAssets.length === 0) {
                        try {
                            const info: any = await Editor.Message.request('asset-db', 'query-asset-info', assetInfo.uuid);
                            const subs = info?.subAssets || {};
                            for (const sid of Object.keys(subs)) {
                                const sub = subs[sid];
                                detailedInfo.subAssets.push({
                                    id: sid,
                                    name: sub?.name || sid,
                                    importer: sub?.importer || sub?.type,
                                    uuid: sub?.uuid || `${assetInfo.uuid}@${sid}`
                                });
                            }
                        } catch { /* ignore */ }
                    }
                }
                
                // Group sub-assets by importer so a caller can pick a mesh / material / clip / the
                // model prefab directly instead of guessing sub-id suffixes. FBX/glTF importers:
                // gltf-mesh, gltf-material, gltf-animation, gltf-skeleton, gltf-scene (embedded prefab).
                const byImporter: Record<string, any[]> = {};
                for (const sa of detailedInfo.subAssets) {
                    const imp = sa.importer || 'unknown';
                    (byImporter[imp] = byImporter[imp] || []).push(sa);
                }
                detailedInfo.grouped = {
                    meshes: byImporter['gltf-mesh'] || [],
                    materials: byImporter['gltf-material'] || [],
                    animationClips: byImporter['gltf-animation'] || [],
                    skeletons: byImporter['gltf-skeleton'] || [],
                    textures: [...(byImporter['texture'] || []), ...(byImporter['image'] || [])],
                    spriteFrames: byImporter['sprite-frame'] || [],
                    // The embedded model prefab — instantiate THIS (not the .fbx main asset) to drop the model in a scene.
                    modelPrefab: (byImporter['gltf-scene'] || [])[0] || null
                };

                resolve({
                    success: true,
                    data: {
                        assetPath,
                        includeSubAssets,
                        ...detailedInfo,
                        message: `Asset details retrieved. Found ${detailedInfo.subAssets.length} sub-assets.`
                    }
                });
                
            } catch (error: any) {
                resolve({
                    success: false,
                    error: `Failed to get asset details: ${error.message}`
                });
            }
        });
    }
}