import { readSettings, saveSettings } from './settings';
import { DriverSettings } from './types';
import { EditorApi } from './editor-api';
import { SceneScriptClient } from './scene-script-client';
import { PipeServer } from './pipe-server';

let settings: DriverSettings = readSettings();
let server: PipeServer | null = null;

export const methods: { [key: string]: (...any: any) => any } = {
    openPanel() {
        Editor.Panel.open('cocos-mcp-server');
    },

    getDriverStatus() {
        const status = server ? server.getStatus() : { listening: false, pipePath: '', project: '' };
        return { ...status, settings };
    },

    async updateSettings(next: DriverSettings) {
        saveSettings(next);
        settings = next;
    }
};

export async function load() {
    settings = readSettings();
    const editor = new EditorApi();
    server = new PipeServer(editor, new SceneScriptClient(editor), settings);
    await server.start();
}

export async function unload() {
    if (server) {
        await server.stop();
        server = null;
    }
}
