import { ToolDefinition, ToolResponse, ToolExecutor, ConsoleMessage, PerformanceStats, ValidationResult, ValidationIssue } from '../types';
import * as fs from 'fs';
import * as path from 'path';

export class DebugTools implements ToolExecutor {
    private consoleMessages: ConsoleMessage[] = [];

    getTools(): ToolDefinition[] {
        return [
            {
                name: 'get_console_logs',
                description: 'Get editor console logs',
                inputSchema: {
                    type: 'object',
                    properties: {
                        limit: {
                            type: 'number',
                            description: 'Number of recent logs to retrieve',
                            default: 100
                        },
                        filter: {
                            type: 'string',
                            description: 'Filter logs by type',
                            enum: ['all', 'log', 'warn', 'error', 'info'],
                            default: 'all'
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
                description: 'Execute JavaScript in scene context',
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
                description: 'Search for specific patterns or errors in project logs',
                inputSchema: {
                    type: 'object',
                    properties: {
                        pattern: {
                            type: 'string',
                            description: 'Search pattern (supports regex)'
                        },
                        maxResults: {
                            type: 'number',
                            description: 'Maximum number of matching results',
                            default: 20,
                            minimum: 1,
                            maximum: 100
                        },
                        contextLines: {
                            type: 'number',
                            description: 'Number of context lines to show around each match',
                            default: 2,
                            minimum: 0,
                            maximum: 10
                        }
                    },
                    required: ['pattern']
                }
            }
        ];
    }

    async execute(toolName: string, args: any): Promise<ToolResponse> {
        switch (toolName) {
            case 'get_console_logs':   return this.getConsoleLogs(args.limit, args.filter);
            case 'clear_console':      return this.clearConsole();
            case 'execute_script':     return this.executeScript(args.script);
            case 'get_node_tree':      return this.getNodeTree(args.rootUuid, args.maxDepth);
            case 'get_performance_stats': return this.getPerformanceStats();
            case 'validate_scene':     return this.validateScene(args);
            case 'get_editor_info':    return this.getEditorInfo();
            case 'get_project_logs':   return this.getProjectLogs(args.lines, args.filterKeyword, args.logLevel);
            case 'get_log_file_info':  return this.getLogFileInfo();
            case 'search_project_logs': return this.searchProjectLogs(args.pattern, args.maxResults, args.contextLines);
            default: throw new Error(`Unknown tool: ${toolName}`);
        }
    }

    private getConsoleLogs(limit: number = 100, filter: string = 'all'): ToolResponse {
        const memLogs: any[] = filter === 'all'
            ? this.consoleMessages
            : this.consoleMessages.filter(m => m.type === filter);

        // The in-memory buffer misses scene-executor and script compile/import errors,
        // which the editor only writes to temp/logs/project.log. Surface those too, so
        // errors like `Module "../Joystick" not found` are visible here (previously they
        // only showed up via get_project_logs).
        const fileLogs: any[] = [];
        try {
            const p = this.findLogFile();
            if (p) {
                const lines = fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim());
                for (const line of lines.slice(-Math.max(limit, 300))) {
                    const type = this.classifyLogLevel(line);
                    if (filter === 'all' || filter === type) {
                        fileLogs.push({ type, message: line, source: 'project.log' });
                    }
                }
            }
        } catch { /* ignore log-read failures */ }

        const combined = [...memLogs, ...fileLogs];
        const recent = combined.slice(-limit);
        return {
            success: true,
            data: {
                total: combined.length,
                returned: recent.length,
                source: fileLogs.length ? 'memory+project.log' : 'memory',
                logs: recent
            }
        };
    }

    /** Best-effort log-level classification for a raw project.log line. */
    private classifyLogLevel(line: string): 'error' | 'warn' | 'info' | 'log' {
        if (/\[ERROR\]|\berror\b|exception|failed|not found|cannot find/i.test(line)) return 'error';
        if (/\[WARN\]|\bwarn(ing)?\b/i.test(line)) return 'warn';
        if (/\[INFO\]|\binfo\b/i.test(line)) return 'info';
        return 'log';
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

    private searchProjectLogs(pattern: string, maxResults: number = 20, contextLines: number = 2): ToolResponse {
        const logFilePath = this.findLogFile();
        if (!logFilePath) {
            return { success: false, error: 'Project log file not found at temp/logs/project.log' };
        }
        try {
            const logLines = fs.readFileSync(logFilePath, 'utf8').split('\n');
            let regex: RegExp;
            try {
                regex = new RegExp(pattern, 'gi');
            } catch {
                regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            }

            const matches: any[] = [];
            for (let i = 0; i < logLines.length && matches.length < maxResults; i++) {
                regex.lastIndex = 0;
                if (!regex.test(logLines[i])) continue;
                const start = Math.max(0, i - contextLines);
                const end = Math.min(logLines.length - 1, i + contextLines);
                matches.push({
                    lineNumber: i + 1,
                    matchedLine: logLines[i],
                    context: Array.from({ length: end - start + 1 }, (_, j) => ({
                        lineNumber: start + j + 1,
                        content: logLines[start + j],
                        isMatch: start + j === i
                    }))
                });
            }
            return {
                success: true,
                data: { pattern, totalMatches: matches.length, maxResults, contextLines, logFilePath, matches }
            };
        } catch (err: any) {
            return { success: false, error: `Failed to search project logs: ${err.message}` };
        }
    }

    private formatFileSize(bytes: number): string {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) { size /= 1024; unitIndex++; }
        return `${size.toFixed(2)} ${units[unitIndex]}`;
    }
}
