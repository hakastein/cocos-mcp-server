import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function withProject(run) {
    const path = mkdtempSync(join(tmpdir(), 'driver-settings-'));
    const previous = globalThis.Editor;
    globalThis.Editor = { Project: { path } };
    try {
        return run(path);
    } finally {
        globalThis.Editor = previous;
    }
}

const { DEFAULT_SETTINGS, readSettings, saveSettings, SETTINGS_FILE } = await import('../src/settings.ts');

test('a project that was never opened by this extension reads the defaults', () => {
    const settings = withProject(() => readSettings());
    assert.deepEqual(settings, { enableDebugLog: false });
});

test('a saved setting reads back from the project settings directory', () => {
    withProject((path) => {
        saveSettings({ enableDebugLog: true });
        assert.deepEqual(readSettings(), { enableDebugLog: true });
        assert.equal(
            readFileSync(join(path, 'settings', SETTINGS_FILE), 'utf-8'),
            JSON.stringify({ enableDebugLog: true }, null, 2));
    });
});

test('a settings file naming no key answers the default for it', () => {
    withProject((path) => {
        mkdirSync(join(path, 'settings'));
        writeFileSync(join(path, 'settings', SETTINGS_FILE), '{}');
        assert.deepEqual(readSettings(), DEFAULT_SETTINGS);
    });
});

test('the file the previous name wrote is not read', () => {
    withProject((path) => {
        mkdirSync(join(path, 'settings'));
        writeFileSync(join(path, 'settings', 'mcp-server.json'), JSON.stringify({ enableDebugLog: true }));
        assert.deepEqual(readSettings(), { enableDebugLog: false });
    });
});
