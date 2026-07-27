import { ToolDefinition, ToolResponse, ToolExecutor, ConsoleMessage, PerformanceStats, ValidationResult, ValidationIssue } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import { searchLines } from '../log-search';
import { ALIAS_KEY } from '../tool-args';
import { groupLogLines, filterEntries, parseSince, levelAtLeast, ProjectLogEntry } from '../project-log';
import { previewLogStore } from '../preview-log-store';

export class DebugTools implements ToolExecutor {
    private consoleMessages: ConsoleMessage[] = [];

    getTools(): ToolDefinition[] {
        return [
            {
                name: 'get_console_logs',
                description: 'EDITOR console logs (the editor process and temp/logs/project.log). Says nothing about a '
                    + 'running preview — for the game\'s own output use get_preview_logs. Stack-trace lines are folded '
                    + 'into the entry they belong to and carry that entry\'s severity, so filtering by level returns '
                    + 'whole errors rather than the frames that happen to contain the word "error".',
                inputSchema: {
                    type: 'object',
                    properties: {
                        limit: {
                            type: 'number',
                            [ALIAS_KEY]: ['maxResults', 'max', 'lines'],
                            description: 'Number of recent entries to retrieve',
                            default: 100
                        },
                        filter: {
                            type: 'string',
                            [ALIAS_KEY]: ['type', 'level', 'severity', 'logLevel'],
                            description: 'Exact severity to keep, or "all"',
                            enum: ['all', 'log', 'warn', 'error', 'info', 'debug'],
                            default: 'all'
                        },
                        minLevel: {
                            type: 'string',
                            description: 'Minimum severity instead of an exact one: debug < log < info < warn < error',
                            enum: ['debug', 'log', 'info', 'warn', 'error']
                        },
                        since: {
                            type: 'string',
                            [ALIAS_KEY]: ['after', 'newerThan'],
                            description: 'Only entries after this point: a relative age like "10m", an ISO date, or epoch ms'
                        },
                        includeDetail: {
                            type: 'boolean',
                            description: 'Include the stack-trace lines folded under each entry (default false — they are '
                                + 'the bulk of the log)',
                            default: false
                        }
                    }
                }
            },
            {
                name: 'clear_console',
                description: 'Clear editor console',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'execute_script',
                description: 'Execute JavaScript in scene context, with `cc`, `director` and `scene` in scope. '
                    + 'The value is the last expression, as in a console — so `cc.director.getScene().name` returns the '
                    + 'name. A top-level `return` and a top-level `await` also work: the script is re-run inside a '
                    + 'function (or async function) wrapper when plain evaluation rejects them, and the response says '
                    + 'which wrapper was used. No IIFE of your own is needed.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        script: { type: 'string', description: 'JavaScript code to execute' }
                    },
                    required: ['script']
                }
            },
            {
                name: 'get_node_tree',
                description: 'Get detailed node tree for debugging',
                inputSchema: {
                    type: 'object',
                    properties: {
                        rootUuid: {
                            type: 'string',
                            description: 'Root node UUID (uses scene root if omitted)'
                        },
                        maxDepth: {
                            type: 'number',
                            description: 'Maximum tree depth',
                            default: 10
                        }
                    }
                }
            },
            {
                name: 'get_performance_stats',
                description: 'Get performance statistics',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'validate_scene',
                description: 'Validate current scene for issues',
                inputSchema: {
                    type: 'object',
                    properties: {
                        checkMissingAssets: {
                            type: 'boolean',
                            description: 'Check for missing asset references',
                            default: true
                        },
                        checkPerformance: {
                            type: 'boolean',
                            description: 'Check for performance issues',
                            default: true
                        }
                    }
                }
            },
            {
                name: 'get_editor_info',
                description: 'Get editor and environment information',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'get_project_logs',
                description: 'Get project logs from temp/logs/project.log file',
                inputSchema: {
                    type: 'object',
                    properties: {
                        lines: {
                            type: 'number',
                            description: 'Number of lines to read from end of log file',
                            default: 100,
                            minimum: 1,
                            maximum: 10000
                        },
                        filterKeyword: {
                            type: 'string',
                            description: 'Filter logs containing specific keyword (optional)'
                        },
                        logLevel: {
                            type: 'string',
                            description: 'Filter by log level',
                            enum: ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'ALL'],
                            default: 'ALL'
                        }
                    }
                }
            },
            {
                name: 'get_log_file_info',
                description: 'Get information about the project log file',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'search_project_logs',
                description: 'Search temp/logs/project.log for a keyword. Case-insensitive substring match by ' +
                    'default; set regex:true to treat the pattern as a regular expression. Returns only matching ' +
                    'lines with surrounding context, and reports the true total match count even when capped.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        pattern: {
                            type: 'string',
                            [ALIAS_KEY]: ['keyword', 'query', 'search', 'searchTerm', 'filterKeyword'],
                            description: 'Text to search for. Literal substring unless regex:true.'
                        },
                        maxResults: {
                            type: 'number',
                            [ALIAS_KEY]: ['limit', 'max'],
                            description: 'Maximum number of matching results to return',
                            default: 20,
                            minimum: 1,
                            maximum: 1000
                        },
                        contextLines: {
                            type: 'number',
                            [ALIAS_KEY]: ['context'],
                            description: 'Number of context lines to show around each match',
                            default: 2,
                            minimum: 0,
                            maximum: 10
                        },
                        regex: {
                            type: 'boolean',
                            description: 'Treat pattern as a regular expression instead of literal text (default false)',
                            default: false
                        },
                        caseSensitive: {
                            type: 'boolean',
                            description: 'Match case exactly (default false)',
                            default: false
                        },
                        since: {
                            type: 'string',
                            [ALIAS_KEY]: ['after', 'newerThan'],
                            description: 'Only lines logged after this point: a relative age like "15m", "2h", "1d", '
                                + 'an ISO date, or epoch ms. Without it the whole file is searched, so a search for '
                                + '"error" returns matches that are days old.'
                        },
                        minLevel: {
                            type: 'string',
                            [ALIAS_KEY]: ['level', 'severity', 'logLevel'],
                            description: 'Minimum severity of the entry a line belongs to: debug < log < info < warn < error. '
                                + '"warn" keeps warnings and errors. Stack-trace lines inherit the severity of the entry '
                                + 'they belong to.',
                            enum: ['debug', 'log', 'info', 'warn', 'error']
                        }
                    },
                    required: ['pattern']
                }
            },
            {
                name: 'get_preview_logs',
                description: 'Console output of the RUNNING PREVIEW (the game itself), forwarded from the preview page '
                    + 'by the bridge. This is the only way to observe a running playable: the preview runs in an '
                    + 'external browser, so get_console_logs and search_project_logs — which read the editor and its '
                    + 'temp/logs/project.log — never contain a single line from the game. Includes uncaught errors and '
                    + 'unhandled promise rejections. Requires the page to load '
                    + '<script src="http://127.0.0.1:<port>/preview-console.js"> (see the playable\'s preview-template); '
                    + 'if nothing has ever been received, that script tag is missing or the page has not been reloaded '
                    + 'since the bridge started.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        limit: {
                            type: 'number',
                            [ALIAS_KEY]: ['maxResults', 'max', 'lines'],
                            description: 'Maximum entries to return, most recent kept',
                            default: 200,
                            minimum: 1,
                            maximum: 2000
                        },
                        minLevel: {
                            type: 'string',
                            [ALIAS_KEY]: ['severity'],
                            description: 'Minimum severity: debug < log < info < warn < error',
                            enum: ['debug', 'log', 'info', 'warn', 'error']
                        },
                        level: {
                            type: 'string',
                            [ALIAS_KEY]: ['type'],
                            description: 'Exact severity, e.g. "error" for errors only',
                            enum: ['debug', 'log', 'info', 'warn', 'error']
                        },
                        since: {
                            type: 'string',
                            [ALIAS_KEY]: ['after', 'newerThan'],
                            description: 'Only entries received after this point: "30s", "5m", an ISO date, or epoch ms'
                        },
                        afterSeq: {
                            type: 'number',
                            description: 'Only entries with seq greater than this — poll without re-reading what you have'
                        },
                        contains: {
                            type: 'string',
                            [ALIAS_KEY]: ['pattern', 'filter', 'keyword'],
                            description: 'Case-insensitive substring the message must contain'
                        },
                        session: {
                            type: 'string',
                            description: 'Only entries from this page-load. Each preview reload gets a new session id, '
                                + 'so this separates the current run from the previous one.'
                        }
                    }
                }
            },
            {
                name: 'clear_preview_logs',
                description: 'Drop everything buffered from the preview page. Use before a preview reload so the next '
                    + 'get_preview_logs shows only the new run.',
                inputSchema: { type: 'object', properties: {} }
            }
        ];
    }

    async execute(toolName: string, args: any): Promise<ToolResponse> {
        switch (toolName) {
            case 'get_console_logs':   return this.getConsoleLogs(args);
            case 'get_preview_logs':   return this.getPreviewLogs(args);
            case 'clear_preview_logs': return this.clearPreviewLogs();
            case 'clear_console':      return this.clearConsole();
            case 'execute_script':     return this.executeScript(args.script);
            case 'get_node_tree':      return this.getNodeTree(args.rootUuid, args.maxDepth);
            case 'get_performance_stats': return this.getPerformanceStats();
            case 'validate_scene':     return this.validateScene(args);
            case 'get_editor_info':    return this.getEditorInfo();
            case 'get_project_logs':   return this.getProjectLogs(args.lines, args.filterKeyword, args.logLevel);
            case 'get_log_file_info':  return this.getLogFileInfo();
            case 'search_project_logs': return this.searchProjectLogs(args);
            default: throw new Error(`Unknown tool: ${toolName}`);
        }
    }

    private getConsoleLogs(args: any = {}): ToolResponse {
        const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.floor(Number(args.limit))) : 100;
        const filter = args.filter || 'all';
        let sinceMs: number | undefined;
        try {
            if (args.since !== undefined && args.since !== null && args.since !== '') {
                sinceMs = parseSince(args.since, Date.now());
            }
        } catch (err: any) {
            return { success: false, error: err.message };
        }

        const memLogs: any[] = this.consoleMessages
            .filter(m => filter === 'all' || m.type === filter)
            .filter(m => !args.minLevel || levelAtLeast(m.type as string, args.minLevel));

        // The in-memory buffer misses scene-executor and script compile/import errors,
        // which the editor only writes to temp/logs/project.log. Surface those too, so
        // errors like `Module "../Joystick" not found` are visible here.
        let fileLogs: any[] = [];
        let source = 'memory';
        try {
            const p = this.findLogFile();
            if (p) {
                const entries = groupLogLines(fs.readFileSync(p, 'utf8').split('\n'));
                const kept = filterEntries(entries, {
                    level: filter === 'all' ? undefined : filter,
                    minLevel: args.minLevel,
                    sinceMs
                });
                fileLogs = kept.map(e => ({
                    type: e.level,
                    time: e.time,
                    message: e.message,
                    source: 'project.log',
                    ...(e.detail ? (args.includeDetail === true
                        ? { detail: e.detail }
                        : { detailLines: e.detail.length }) : {})
                }));
                source = 'memory+project.log';
            }
        } catch { /* ignore log-read failures */ }

        const combined = [...memLogs, ...fileLogs];
        const recent = combined.slice(-limit);
        return {
            success: true,
            data: {
                total: combined.length,
                returned: recent.length,
                truncated: combined.length > recent.length,
                filter,
                minLevel: args.minLevel,
                since: sinceMs === undefined ? undefined : new Date(sinceMs).toISOString(),
                source,
                logs: recent
            }
        };
    }

    private getPreviewLogs(args: any = {}): ToolResponse {
        let sinceMs: number | undefined;
        try {
            if (args.since !== undefined && args.since !== null && args.since !== '') {
                sinceMs = parseSince(args.since, Date.now());
            }
        } catch (err: any) {
            return { success: false, error: err.message };
        }

        const result = previewLogStore.query({
            limit: args.limit,
            minLevel: args.minLevel,
            level: args.level,
            sinceMs,
            afterSeq: args.afterSeq,
            contains: args.contains,
            session: args.session
        });
        const stats = previewLogStore.stats();

        // Empty with nothing ever received is the one case a caller must not read as "the game
        // logged nothing" — it almost always means the page never loaded the forwarding script.
        const hint = stats.highestSeq === 0
            ? 'No preview output has ever reached the bridge. Check that the preview page loads '
              + '<script src="http://127.0.0.1:' + this.previewPort() + '/preview-console.js"> (the playable\'s '
              + 'preview-template/index.ejs), that the preview is open, and that it was reloaded after the bridge started.'
            : undefined;

        return {
            success: true,
            data: {
                returned: result.entries.length,
                matched: result.matched,
                truncated: result.truncated,
                buffered: stats.buffered,
                highestSeq: stats.highestSeq,
                droppedOldest: stats.droppedOldest,
                sessions: stats.sessions,
                hint,
                logs: result.entries
            }
        };
    }

    private clearPreviewLogs(): ToolResponse {
        previewLogStore.clear();
        return { success: true, message: 'Preview log buffer cleared' };
    }

    /** Port the bridge is listening on, for the hint text only. */
    private previewPort(): number {
        try {
            const settings = JSON.parse(fs.readFileSync(
                path.join(Editor.Project.path, 'settings', 'mcp-server.json'), 'utf8'
            ));
            return settings.port || 4000;
        } catch {
            return 4000;
        }
    }

    private clearConsole(): ToolResponse {
        this.consoleMessages = [];
        try {
            Editor.Message.send('console', 'clear');
            return { success: true, message: 'Console cleared successfully' };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private async executeScript(script: string): Promise<ToolResponse> {
        try {
            // Route through OUR own registered scene-script method rather than the
            // editor-internal `console` package (which is missing in some 3.8.x builds
            // and returns "Scenario scripts do not exist: console").
            const result: any = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'cocos-mcp-server',
                method: 'evalInScene',
                args: [script]
            });
            // evalInScene already returns a ToolResponse-shaped object; pass it through.
            if (result && typeof result === 'object' && 'success' in result) {
                return result;
            }
            return { success: true, data: { result, message: 'Script executed successfully' } };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private async getNodeTree(rootUuid?: string, maxDepth: number = 10): Promise<ToolResponse> {
        // query-node returns an Inspector DUMP: every scalar is wrapped as {value,type,...},
        // components live under `__comps__` (not `components`), and each child is a dump whose
        // uuid sits at `.value.uuid`.
        const plain = (field: any): any => (field && typeof field === 'object' && 'value' in field ? field.value : field);
        const childUuid = (child: any): string => {
            const v = plain(child);
            return typeof v === 'string' ? v : (v && plain(v.uuid));
        };

        const buildTree = async (nodeUuid: string, depth: number = 0): Promise<any> => {
            if (depth >= maxDepth) return { truncated: true };
            try {
                const nodeData: any = await Editor.Message.request('scene', 'query-node', nodeUuid);
                const comps = nodeData.__comps__ ?? [];
                const children = nodeData.children ?? [];
                const tree: any = {
                    uuid: plain(nodeData.uuid),
                    name: plain(nodeData.name),
                    active: plain(nodeData.active),
                    components: comps.map((c: any) => ({
                        type: c.type ?? c.__type__,
                        uuid: plain(plain(c)?.uuid)
                    })),
                    childCount: children.length,
                    children: []
                };
                for (const child of children) {
                    const uuid = childUuid(child);
                    if (uuid) tree.children.push(await buildTree(uuid, depth + 1));
                }
                return tree;
            } catch (err: any) {
                return { error: err.message };
            }
        };

        try {
            if (rootUuid) {
                return { success: true, data: await buildTree(rootUuid) };
            }
            const hierarchy: any = await Editor.Message.request('scene', 'query-hierarchy');
            const roots = (hierarchy?.children ?? []).map((n: any) => n?.uuid ?? childUuid(n)).filter(Boolean);
            const trees = await Promise.all(roots.map((uuid: string) => buildTree(uuid)));
            return { success: true, data: trees };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private async getPerformanceStats(): Promise<ToolResponse> {
        try {
            const stats: any = await Editor.Message.request('scene', 'query-performance');
            const perfStats: PerformanceStats = {
                nodeCount: stats.nodeCount ?? 0,
                componentCount: stats.componentCount ?? 0,
                drawCalls: stats.drawCalls ?? 0,
                triangles: stats.triangles ?? 0,
                memory: stats.memory ?? {}
            };
            return { success: true, data: perfStats };
        } catch {
            return { success: true, data: { message: 'Performance stats not available in edit mode' } };
        }
    }

    private async validateScene(options: any): Promise<ToolResponse> {
        const issues: ValidationIssue[] = [];
        try {
            if (options.checkMissingAssets) {
                const assetCheck: any = await Editor.Message.request('scene', 'check-missing-assets');
                if (assetCheck?.missing?.length) {
                    issues.push({
                        type: 'error',
                        category: 'assets',
                        message: `Found ${assetCheck.missing.length} missing asset references`,
                        details: assetCheck.missing
                    });
                }
            }
            if (options.checkPerformance) {
                const hierarchy: any = await Editor.Message.request('scene', 'query-hierarchy');
                const nodeCount = this.countNodes(hierarchy.children);
                if (nodeCount > 1000) {
                    issues.push({
                        type: 'warning',
                        category: 'performance',
                        message: `High node count: ${nodeCount} nodes (recommended < 1000)`,
                        suggestion: 'Consider using object pooling or scene optimization'
                    });
                }
            }
            const result: ValidationResult = { valid: issues.length === 0, issueCount: issues.length, issues };
            return { success: true, data: result };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private countNodes(nodes: any[]): number {
        return nodes.reduce((count, node) => count + 1 + (node.children ? this.countNodes(node.children) : 0), 0);
    }

    private getEditorInfo(): ToolResponse {
        return {
            success: true,
            data: {
                editor: {
                    version: (Editor as any).versions?.editor ?? 'Unknown',
                    cocosVersion: (Editor as any).versions?.cocos ?? 'Unknown',
                    platform: process.platform,
                    arch: process.arch,
                    nodeVersion: process.version
                },
                project: {
                    name: Editor.Project.name,
                    path: Editor.Project.path,
                    uuid: Editor.Project.uuid
                },
                memory: process.memoryUsage(),
                uptime: process.uptime()
            }
        };
    }

    private findLogFile(): string | null {
        const candidates = [Editor.Project?.path, process.cwd()].filter(Boolean);
        for (const base of candidates) {
            const p = path.join(base, 'temp', 'logs', 'project.log');
            if (fs.existsSync(p)) return p;
        }
        return null;
    }

    private getProjectLogs(lines: number = 100, filterKeyword?: string, logLevel: string = 'ALL'): ToolResponse {
        const logFilePath = this.findLogFile();
        if (!logFilePath) {
            return { success: false, error: 'Project log file not found at temp/logs/project.log' };
        }
        try {
            const allLines = fs.readFileSync(logFilePath, 'utf8').split('\n').filter(l => l.trim());
            let filtered = allLines.slice(-lines);
            if (logLevel !== 'ALL') {
                filtered = filtered.filter(l => l.includes(`[${logLevel}]`) || l.includes(logLevel.toLowerCase()));
            }
            if (filterKeyword) {
                filtered = filtered.filter(l => l.toLowerCase().includes(filterKeyword.toLowerCase()));
            }
            return {
                success: true,
                data: {
                    totalLines: allLines.length,
                    requestedLines: lines,
                    filteredLines: filtered.length,
                    logLevel,
                    filterKeyword: filterKeyword ?? null,
                    logs: filtered,
                    logFilePath
                }
            };
        } catch (err: any) {
            return { success: false, error: `Failed to read project logs: ${err.message}` };
        }
    }

    private getLogFileInfo(): ToolResponse {
        const logFilePath = this.findLogFile();
        if (!logFilePath) {
            return { success: false, error: 'Project log file not found at temp/logs/project.log' };
        }
        try {
            const stats = fs.statSync(logFilePath);
            const lineCount = fs.readFileSync(logFilePath, 'utf8').split('\n').filter(l => l.trim()).length;
            return {
                success: true,
                data: {
                    filePath: logFilePath,
                    fileSize: stats.size,
                    fileSizeFormatted: this.formatFileSize(stats.size),
                    lastModified: stats.mtime.toISOString(),
                    lineCount,
                    created: stats.birthtime.toISOString()
                }
            };
        } catch (err: any) {
            return { success: false, error: `Failed to get log file info: ${err.message}` };
        }
    }

    private searchProjectLogs(args: any): ToolResponse {
        const logFilePath = this.findLogFile();
        if (!logFilePath) {
            return { success: false, error: 'Project log file not found at temp/logs/project.log' };
        }
        let logLines: string[];
        try {
            logLines = fs.readFileSync(logFilePath, 'utf8').split('\n');
        } catch (err: any) {
            return { success: false, error: `Failed to read project log: ${err.message}` };
        }
        try {
            // A `since`/`minLevel` window is applied by masking out the lines of entries that
            // fall outside it, rather than by searching a compacted copy — line numbers stay
            // the ones in the file on disk, and a stack frame is judged by the severity and
            // time of the entry it belongs to, not by its own text.
            let searchable = logLines;
            let window: any;
            if (args.since !== undefined || args.minLevel !== undefined) {
                const sinceMs = args.since === undefined || args.since === null || args.since === ''
                    ? undefined
                    : parseSince(args.since, Date.now());
                const entries = groupLogLines(logLines);
                const kept = filterEntries(entries, { sinceMs, minLevel: args.minLevel });
                searchable = this.maskToEntries(logLines, kept);
                window = {
                    since: sinceMs === undefined ? undefined : new Date(sinceMs).toISOString(),
                    minLevel: args.minLevel,
                    entriesInWindow: kept.length,
                    entriesTotal: entries.length
                };
            }

            // A bad pattern or regex throws, and is reported as such — the old code turned
            // both into a silent full-file match. See ../log-search.
            const result = searchLines(searchable, {
                pattern: args.pattern,
                maxResults: args.maxResults,
                contextLines: args.contextLines,
                regex: args.regex,
                caseSensitive: args.caseSensitive
            });
            return {
                success: true,
                data: { ...result, logFilePath, searchedLines: logLines.length, window }
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    /**
     * A copy of `lines` where every line outside the kept entries is blanked. Blanking rather
     * than removing preserves 1-based line numbers and the surrounding-context slices.
     */
    private maskToEntries(lines: string[], kept: ProjectLogEntry[]): string[] {
        const masked = new Array(lines.length).fill('');
        for (const entry of kept) {
            for (let i = entry.lineNumber - 1; i < entry.endLine && i < lines.length; i++) {
                masked[i] = lines[i];
            }
        }
        return masked;
    }

    private formatFileSize(bytes: number): string {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) { size /= 1024; unitIndex++; }
        return `${size.toFixed(2)} ${units[unitIndex]}`;
    }
}
