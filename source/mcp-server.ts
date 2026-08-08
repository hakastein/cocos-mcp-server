import * as http from 'http';
import * as url from 'url';
import { MCPServerSettings, ServerStatus, ToolDefinition } from './types';
import { createToolInstances } from './tool-registry';
import { normalizeToolArgs } from './tool-args';
import { augmentToolDefinition, applyResolvedPaths, requestedPaths, PathResolution } from './node-path';
import { previewLogStore } from './preview-log-store';
import { previewConsoleClient } from './preview-console-client';

export class MCPServer {
    private settings: MCPServerSettings;
    private httpServer: http.Server | null = null;
    private tools: Record<string, any> = {};
    private toolsList: ToolDefinition[] = [];
    private enabledTools: any[] = [];
    /**
     * Lazily built `{category}_{tool}` -> definition index, holding the path-augmented copy of
     * every tool. Definitions are static, and both the advertised list and argument validation
     * must read the same one — a client offered `nodePath` by `tools/list` and then validated
     * against the un-augmented schema would be rejected for supplying what it was told to.
     */
    private definitionIndex: Map<string, ToolDefinition> | null = null;

    constructor(settings: MCPServerSettings) {
        this.settings = settings;
        this.initializeTools();
    }

    private initializeTools(): void {
        try {
            this.tools = createToolInstances((toolName, args) => this.executeToolCall(toolName, args));
        } catch (error) {
            console.error('[MCPServer] Failed to initialize tools:', error);
            throw error;
        }
    }

    public async start(): Promise<void> {
        if (this.httpServer) {
            return;
        }

        try {
            this.httpServer = http.createServer(this.handleHttpRequest.bind(this));

            await new Promise<void>((resolve, reject) => {
                this.httpServer!.listen(this.settings.port, '127.0.0.1', () => {
                    console.log(`[MCPServer] Started on http://127.0.0.1:${this.settings.port}`);
                    resolve();
                });
                this.httpServer!.on('error', (err: any) => {
                    if (err.code === 'EADDRINUSE') {
                        console.error(`[MCPServer] Port ${this.settings.port} is already in use`);
                    }
                    reject(err);
                });
            });

            this.rebuildToolsList();
        } catch (error) {
            this.httpServer = null;
            throw error;
        }
    }

    public stop(): void {
        if (this.httpServer) {
            this.httpServer.close();
            this.httpServer = null;
            console.log('[MCPServer] Stopped');
        }
    }

    public getStatus(): ServerStatus {
        return {
            running: !!this.httpServer,
            port: this.settings.port,
            clients: 0
        };
    }

    public getSettings(): MCPServerSettings {
        return this.settings;
    }

    public getAvailableTools(): ToolDefinition[] {
        return this.toolsList;
    }

    public getFilteredTools(enabledTools: any[]): ToolDefinition[] {
        if (!enabledTools || enabledTools.length === 0) {
            return this.toolsList;
        }
        const enabledSet = new Set(enabledTools.map(t => `${t.category}_${t.name}`));
        return this.toolsList.filter(tool => enabledSet.has(tool.name));
    }

    public updateEnabledTools(enabledTools: any[]): void {
        this.enabledTools = enabledTools;
        this.rebuildToolsList();
    }

    public async executeToolCall(toolName: string, args: any): Promise<any> {
        // Tool names are structured as "{category}_{toolMethodName}".
        // We split on the first underscore only to get the category key,
        // then rejoin the rest as the method name (method names may contain underscores).
        const underscoreIdx = toolName.indexOf('_');
        if (underscoreIdx === -1) {
            throw new Error(`Invalid tool name format: ${toolName}`);
        }
        const category = toolName.substring(0, underscoreIdx);
        const methodName = toolName.substring(underscoreIdx + 1);

        if (!this.tools[category]) {
            throw new Error(`Unknown tool category: ${category}`);
        }

        // Validate before dispatch. A handler that reads an argument the caller spelled
        // differently otherwise sees `undefined` and degrades silently — a match-all regex,
        // or a TypeError thrown from inside the editor. Both look like tool bugs to the
        // caller and neither says which parameter was wrong. See ./tool-args.
        const schema = this.schemaFor(category, methodName);
        if (schema) {
            const normalized = normalizeToolArgs(toolName, schema, args);
            if (!normalized.ok) {
                return { success: false, error: normalized.error };
            }
            args = normalized.args;
            if (normalized.renamed.length && this.settings.enableDebugLog) {
                const pairs = normalized.renamed.map(r => `${r.from} -> ${r.to}`).join(', ');
                console.log(`[MCPServer] ${toolName}: accepted alias argument(s) ${pairs}`);
            }

            // Paths become uuids here and nowhere earlier. Resolving at dispatch is what makes a
            // path immune to the churn a uuid suffers: whatever happened to the scene since the
            // caller last looked at it, this resolution reads the tree as it is now.
            const paths = requestedPaths(schema, args);
            const lookup = paths.length
                ? await this.resolveScenePaths(paths)
                : { ok: true as const, resolutions: {} };
            if (!lookup.ok) {
                return { success: false, error: `${toolName}: ${lookup.error}` };
            }
            const applied = applyResolvedPaths(toolName, schema, args, lookup.resolutions);
            if (!applied.ok) {
                return { success: false, error: applied.error };
            }
            args = applied.args;
            if (applied.resolved.length && this.settings.enableDebugLog) {
                const spelled = applied.resolved
                    .map(r => `${r.parameter}='${r.path}' -> ${r.uuid} (${r.matchedPath})`).join(', ');
                console.log(`[MCPServer] ${toolName}: resolved ${spelled}`);
            }
        }

        return await this.tools[category].execute(methodName, args);
    }

    /**
     * Ask the scene script to turn paths into uuids. A transport failure is reported as such
     * rather than degrading to "path not found": the two need different fixes, and conflating
     * them sends the caller hunting through a scene that was never consulted.
     */
    private async resolveScenePaths(paths: string[]): Promise<
        { ok: true; resolutions: Record<string, PathResolution> } | { ok: false; error: string }
    > {
        let result: any;
        try {
            result = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'cocos-mcp-server',
                method: 'resolveNodePaths',
                args: [paths]
            });
        } catch (err: any) {
            return {
                ok: false,
                error: `could not resolve node path(s) — the scene script did not answer: ${(err && err.message) || String(err)}`
            };
        }
        if (!result || result.success !== true || !result.data) {
            return { ok: false, error: `could not resolve node path(s): ${(result && result.error) || 'no scene is open'}` };
        }
        return { ok: true, resolutions: (result.data.resolutions || {}) as Record<string, PathResolution> };
    }

    /**
     * Input schema for a tool, by category and method name. Indexed across every registered
     * category regardless of the enabled-tools filter, so validation does not depend on
     * which tools the current configuration exposes.
     */
    private schemaFor(category: string, methodName: string): any | undefined {
        const def = this.definitions().get(`${category}_${methodName}`);
        return def && def.inputSchema;
    }

    /** `{category}_{tool}` -> the path-augmented definition, built once. */
    private definitions(): Map<string, ToolDefinition> {
        if (!this.definitionIndex) {
            this.definitionIndex = new Map();
            for (const [category, toolSet] of Object.entries(this.tools)) {
                for (const tool of toolSet.getTools()) {
                    const augmented = augmentToolDefinition(tool);
                    this.definitionIndex.set(`${category}_${tool.name}`, {
                        name: `${category}_${tool.name}`,
                        description: augmented.description,
                        inputSchema: augmented.inputSchema
                    });
                }
            }
        }
        return this.definitionIndex;
    }

    private rebuildToolsList(): void {
        const enabledSet = this.enabledTools.length > 0
            ? new Set(this.enabledTools.map(t => `${t.category}_${t.name}`))
            : null;

        this.toolsList = [];
        for (const definition of this.definitions().values()) {
            if (!enabledSet || enabledSet.has(definition.name)) {
                this.toolsList.push(definition);
            }
        }
    }

    private async readRequestBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', () => resolve(body));
            req.on('error', reject);
        });
    }

    private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const parsedUrl = url.parse(req.url || '', true);
        const pathname = parsedUrl.pathname;

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        try {
            if (pathname === '/mcp' && req.method === 'POST') {
                await this.handleMCPRequest(req, res);
            } else if (pathname === '/mcp') {
                // Any non-POST to /mcp (GET stream, DELETE session): we offer no
                // server-initiated SSE stream and are sessionless, so there is
                // nothing here. Spec-compliant MCP clients treat 405 as "stream
                // not offered" and continue cleanly; a 404 does NOT get that
                // special-case and can surface as a transport error mid-handshake.
                res.setHeader('Allow', 'POST');
                res.writeHead(405);
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: null,
                    error: { code: -32000, message: 'Method Not Allowed' }
                }));
            } else if (pathname === '/preview-console.js' && req.method === 'GET') {
                // Served from the bridge so the injected client has one source of truth and the
                // port it posts to cannot drift from the port it was fetched from.
                res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                res.setHeader('Cache-Control', 'no-store');
                res.writeHead(200);
                res.end(previewConsoleClient({ port: this.settings.port }));
            } else if (pathname === '/preview-log' && req.method === 'POST') {
                await this.handlePreviewLog(req, res);
            } else if (pathname === '/health' && req.method === 'GET') {
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'ok', tools: this.toolsList.length }));
            } else if (pathname === '/api/tools' && req.method === 'GET') {
                res.writeHead(200);
                res.end(JSON.stringify({ tools: this.getSimplifiedToolsList() }));
            } else if (pathname?.startsWith('/api/') && req.method === 'POST') {
                await this.handleSimpleAPIRequest(req, res, pathname);
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Not found' }));
            }
        } catch (error) {
            console.error('[MCPServer] Unhandled request error:', error);
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }

    /**
     * Ingest a batch of console entries from a preview page. Always answers 200 — the page
     * must never learn that logging failed, or its own error handling becomes another source
     * of log traffic.
     */
    private async handlePreviewLog(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        let accepted = 0;
        try {
            const body = await this.readRequestBody(req);
            accepted = previewLogStore.ingest(JSON.parse(body), Date.now());
        } catch {
            // malformed batch: drop it, the page gets a 200 regardless
        }
        res.writeHead(200);
        res.end(JSON.stringify({ accepted }));
    }

    private async handleMCPRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const body = await this.readRequestBody(req);
        let message: any;
        try {
            message = JSON.parse(body);
        } catch (parseError: any) {
            res.writeHead(400);
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: `Parse error: ${parseError.message}` }
            }));
            return;
        }

        // JSON-RPC notifications carry no `id` and expect no response. Per MCP
        // Streamable HTTP the server returns 202 Accepted with an empty body —
        // NOT a JSON-RPC error. The client sends `notifications/initialized`
        // right after `initialize`; answering it with an error body (our old
        // `default`-case behavior) breaks the handshake on spec-strict clients.
        if (message && message.method !== undefined && message.id === undefined) {
            res.writeHead(202);
            res.end();
            return;
        }

        const response = await this.handleMessage(message);
        res.writeHead(200);
        res.end(JSON.stringify(response));
    }

    private async handleMessage(message: any): Promise<any> {
        const { id, method, params } = message;
        try {
            let result: any;
            switch (method) {
                case 'initialize':
                    result = {
                        protocolVersion: '2024-11-05',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'cocos-mcp-server', version: '1.0.0' }
                    };
                    break;
                case 'tools/list':
                    result = { tools: this.getAvailableTools() };
                    break;
                case 'tools/call': {
                    const { name, arguments: args } = params;
                    const toolResult = await this.executeToolCall(name, args);
                    result = { content: [{ type: 'text', text: JSON.stringify(toolResult) }] };
                    break;
                }
                default:
                    throw new Error(`Unknown method: ${method}`);
            }
            return { jsonrpc: '2.0', id, result };
        } catch (error: any) {
            return {
                jsonrpc: '2.0',
                id,
                error: { code: -32603, message: error.message }
            };
        }
    }

    private async handleSimpleAPIRequest(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
        const body = await this.readRequestBody(req);

        const pathParts = pathname.split('/').filter(p => p);
        if (pathParts.length < 3) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid API path. Use /api/{category}/{tool_name}' }));
            return;
        }

        const category = pathParts[1];
        const toolName = pathParts[2];
        const fullToolName = `${category}_${toolName}`;

        let params: any;
        try {
            params = body ? JSON.parse(body) : {};
        } catch (parseError: any) {
            res.writeHead(400);
            res.end(JSON.stringify({
                error: 'Invalid JSON in request body',
                details: parseError.message
            }));
            return;
        }

        try {
            const result = await this.executeToolCall(fullToolName, params);
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, tool: fullToolName, result }));
        } catch (error: any) {
            res.writeHead(500);
            res.end(JSON.stringify({ success: false, error: error.message, tool: fullToolName }));
        }
    }

    private getSimplifiedToolsList(): any[] {
        return this.toolsList.map(tool => {
            const underscoreIdx = tool.name.indexOf('_');
            const category = tool.name.substring(0, underscoreIdx);
            const toolName = tool.name.substring(underscoreIdx + 1);
            return {
                name: tool.name,
                category,
                toolName,
                description: tool.description,
                apiPath: `/api/${category}/${toolName}`,
                curlExample: this.generateCurlExample(category, toolName, tool.inputSchema)
            };
        });
    }

    private generateCurlExample(category: string, toolName: string, schema: any): string {
        const sampleParams = this.generateSampleParams(schema);
        const jsonString = JSON.stringify(sampleParams, null, 2);
        return `curl -X POST http://127.0.0.1:${this.settings.port}/api/${category}/${toolName} \\\n  -H "Content-Type: application/json" \\\n  -d '${jsonString}'`;
    }

    private generateSampleParams(schema: any): any {
        if (!schema || !schema.properties) return {};
        const sample: any = {};
        for (const [key, prop] of Object.entries(schema.properties as Record<string, any>)) {
            switch (prop.type) {
                case 'string':  sample[key] = prop.default ?? 'example_string'; break;
                case 'number':  sample[key] = prop.default ?? 0; break;
                case 'boolean': sample[key] = prop.default ?? true; break;
                case 'object':  sample[key] = prop.default ?? { x: 0, y: 0, z: 0 }; break;
                default:        sample[key] = 'example_value';
            }
        }
        return sample;
    }
}
