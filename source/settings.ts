import * as fs from 'fs';
import * as path from 'path';
import { MCPServerSettings } from './types';

export const DEFAULT_SETTINGS: MCPServerSettings = {
    port: 3000,
    autoStart: false,
    enableDebugLog: false,
    allowedOrigins: ['*'],
    maxConnections: 10
};

function getSettingsDir(): string {
    return path.join(Editor.Project.path, 'settings');
}

function ensureSettingsDir(): void {
    const dir = getSettingsDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function getSettingsPath(): string {
    return path.join(getSettingsDir(), 'mcp-server.json');
}

export function readSettings(): MCPServerSettings {
    try {
        ensureSettingsDir();
        const filePath = getSettingsPath();
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            return { ...DEFAULT_SETTINGS, ...JSON.parse(content) };
        }
    } catch (e) {
        console.error('[Settings] Failed to read server settings:', e);
    }
    return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings: MCPServerSettings): void {
    try {
        ensureSettingsDir();
        fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
    } catch (e) {
        console.error('[Settings] Failed to save server settings:', e);
        throw e;
    }
}
