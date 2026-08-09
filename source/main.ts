import { MCPServer } from './mcp-server';
import { readSettings, saveSettings } from './settings';
import { MCPServerSettings } from './types';

let mcpServer: MCPServer | null = null;

export const methods: { [key: string]: (...any: any) => any } = {
    openPanel() {
        Editor.Panel.open('cocos-mcp-server');
    },

    async startServer() {
        if (!mcpServer) {
            console.warn('[MCP] mcpServer is not initialized');
            return;
        }
        await mcpServer.start();
    },

    async stopServer() {
        if (!mcpServer) {
            console.warn('[MCP] mcpServer is not initialized');
            return;
        }
        mcpServer.stop();
    },

    getServerStatus() {
        const status = mcpServer ? mcpServer.getStatus() : { running: false, port: 0, clients: 0 };
        const settings = mcpServer ? mcpServer.getSettings() : readSettings();
        return { ...status, settings };
    },

    updateSettings(settings: MCPServerSettings) {
        saveSettings(settings);
        if (mcpServer) {
            mcpServer.stop();
        }
        mcpServer = new MCPServer(settings);
        mcpServer.start();
    }
};

export function load() {
    console.log('[MCP] Extension loaded');

    const settings = readSettings();
    mcpServer = new MCPServer(settings);

    if (settings.autoStart) {
        mcpServer.start().catch(err => {
            console.error('[MCP] Auto-start failed:', err);
        });
    }
}

export function unload() {
    if (mcpServer) {
        mcpServer.stop();
        mcpServer = null;
    }
}
