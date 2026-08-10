import { readSettings, saveSettings } from './settings';
import { MCPServerSettings } from './types';
import { EditorApi } from './editor-api';
import { SceneScriptClient } from './scene-script-client';
import { PreviewLogStore } from './preview-log-store';
import { composeTools } from './tools-v2';
import { BridgeServer } from './server';
import type { ToolContext } from './context';

/** Outlives every server instance, so a settings change does not discard buffered preview output. */
const previewLogs = new PreviewLogStore();

let settings: MCPServerSettings = readSettings();
let server: BridgeServer | null = null;

function compose(settings: MCPServerSettings): BridgeServer {
    const editor = new EditorApi();
    const ctx: ToolContext = {
        editor,
        sceneScript: new SceneScriptClient(editor),
        logs: previewLogs,
        settings
    };

    return new BridgeServer(composeTools({ ctx }), ctx, settings);
}

export const methods: { [key: string]: (...any: any) => any } = {
    openPanel() {
        Editor.Panel.open('cocos-mcp-server');
    },

    async startServer() {
        if (!server) {
            console.warn('[MCP] server is not initialized');
            return;
        }
        await server.start();
    },

    async stopServer() {
        if (!server) {
            console.warn('[MCP] server is not initialized');
            return;
        }
        await server.stop();
    },

    getServerStatus() {
        const status = server ? server.getStatus() : { running: false, port: settings.port, clients: 0 };
        return { ...status, settings };
    },

    async updateSettings(next: MCPServerSettings) {
        saveSettings(next);
        settings = next;
        if (server) {
            await server.stop();
        }
        server = compose(next);
        await server.start();
    }
};

export function load() {
    console.log('[MCP] Extension loaded');

    settings = readSettings();
    server = compose(settings);

    if (settings.autoStart) {
        server.start().catch(err => {
            console.error('[MCP] Auto-start failed:', err);
        });
    }
}

export async function unload() {
    if (server) {
        await server.stop();
        server = null;
    }
}
