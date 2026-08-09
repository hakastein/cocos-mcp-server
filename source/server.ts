import * as http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { previewConsoleClient } from './preview-console-client';
import type { ToolRegistry } from './registry';
import type { ToolContext } from './context';
import type { MCPServerSettings, ServerStatus } from './types';

const SERVER_INFO = { name: 'cocos-mcp-server', version: '1.0.0' };

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

export class BridgeServer {
    private httpServer: http.Server | null = null;

    constructor(
        private readonly registry: ToolRegistry,
        private readonly ctx: ToolContext,
        private readonly settings: MCPServerSettings
    ) {}

    async start(): Promise<void> {
        if (this.httpServer) return;

        const httpServer = http.createServer((req, res) => {
            this.route(req, res).catch(error => {
                console.error('[MCP] Unhandled request error:', error);
                if (res.writableEnded) return;
                if (res.headersSent) {
                    res.end();
                    return;
                }
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal server error' }));
            });
        });

        await new Promise<void>((resolve, reject) => {
            httpServer.once('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    console.error(`[MCP] Port ${this.settings.port} is already in use`);
                }
                reject(err);
            });
            httpServer.listen(this.settings.port, '127.0.0.1', () => {
                console.log(`[MCP] Bridge listening on http://127.0.0.1:${this.settings.port}/mcp`);
                resolve();
            });
        });

        this.httpServer = httpServer;
    }

    async stop(): Promise<void> {
        const httpServer = this.httpServer;
        this.httpServer = null;
        if (!httpServer) return;
        // Keep-alive sockets would hold `close` open indefinitely, and the next start binds
        // the same port.
        httpServer.closeAllConnections?.();
        await new Promise<void>(resolve => httpServer.close(() => resolve()));
        console.log('[MCP] Bridge stopped');
    }

    getStatus(): ServerStatus {
        return { running: !!this.httpServer, port: this.settings.port, clients: 0 };
    }

    private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
            await this.handleMcp(req, res);
            return;
        }

        if (pathname === '/preview-console.js' && req.method === 'GET') {
            // Served from the bridge so the injected client has one source of truth and the
            // port it posts to cannot drift from the port it was fetched from.
            res.writeHead(200, {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(previewConsoleClient({ port: this.settings.port }));
            return;
        }

        if (pathname === '/preview-log' && req.method === 'POST') {
            await this.ingestPreviewLog(req, res);
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }

    /**
     * A stateless transport in this SDK refuses a second request, so protocol state is built and
     * torn down per call. Nothing here outlives a request: the registry and the context do.
     */
    private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (req.method !== 'POST') {
            // A spec-compliant client reads 405 as "no server-initiated stream offered" and carries
            // on; a 404 gets no such special case and surfaces as a transport error mid-handshake.
            res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32000, message: 'Method Not Allowed' }
            }));
            return;
        }

        const mcp = new Server(SERVER_INFO, { capabilities: { tools: {} } });
        mcp.onerror = error => console.error('[MCP] protocol error:', error);
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.registry.list() }));
        mcp.setRequestHandler(CallToolRequestSchema, async request => {
            const args = (request.params.arguments ?? {}) as Record<string, unknown>;
            const result = await this.registry.invoke(request.params.name, args, this.ctx);
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(result) }],
                isError: !result.success
            };
        });

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true
        });

        try {
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
        } finally {
            await mcp.close();
        }
    }

    /**
     * Always answers 200 — the page must never learn that logging failed, or its own error
     * handling becomes another source of log traffic.
     */
    private async ingestPreviewLog(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        let accepted = 0;
        try {
            accepted = this.ctx.logs.ingest(JSON.parse(await readBody(req)), Date.now());
        } catch {
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted }));
    }
}
