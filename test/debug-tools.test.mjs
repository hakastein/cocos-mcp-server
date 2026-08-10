import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { debugTools } from '../dist/tools-v2/debug.js';
import { PreviewLogStore } from '../dist/preview-log-store.js';

const toolNamed = (name) => {
    const tool = debugTools.find(candidate => candidate.name === name);
    assert.ok(tool, `tool ${name} not found`);
    return tool;
};

const LOG = [
    '27.07.2026 09:05:10 - log: [Scene] built on Thug',
    '27.07.2026 09:05:11 - error: Module "../Joystick" not found',
    '    at SkinnedMeshRenderer._tryBindAnimation (index.js:115295:23)',
    '27.07.2026 09:05:12 - log: no error here, just the word error in a message',
    '27.07.2026 09:05:13 - warn: texture not compressed',
    ''
].join('\n');

function projectWithLog(content) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-debug-'));
    if (content !== null) {
        fs.mkdirSync(path.join(root, 'temp', 'logs'), { recursive: true });
        fs.writeFileSync(path.join(root, 'temp', 'logs', 'project.log'), content);
    }
    globalThis.Editor = { Project: { path: root, name: 'fixture', uuid: 'fixture-uuid' } };
    return root;
}

const projectLogs = (args) => toolNamed('debug_project_logs').invoke(args, {});

test('without a query the log reads as its most recent entries, with the file it came from', async () => {
    const root = projectWithLog(LOG);
    const result = await projectLogs({});

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.data.mode, 'tail');
    assert.equal(result.data.logFilePath, path.join(root, 'temp', 'logs', 'project.log'));
    assert.equal(result.data.fileSize, Buffer.byteLength(LOG));
    assert.equal(typeof result.data.lastModified, 'string');
    assert.deepEqual(result.data.entries.map(entry => entry.level), ['log', 'error', 'log', 'warn']);
    assert.equal(result.data.entries[1].message, 'Module "../Joystick" not found');
    assert.equal(result.data.entries[1].detailLines, 1);
});

test('level is the entry header severity, so a stack frame is not promoted and a log is not demoted', async () => {
    projectWithLog(LOG);
    const result = await projectLogs({ level: 'error' });

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(result.data.entries.map(entry => entry.message),
        ['Module "../Joystick" not found']);
    assert.equal(result.data.window.entriesInWindow, 1);
    assert.equal(result.data.window.entriesTotal, 4);
});

test('includeDetail returns the frames themselves instead of their count', async () => {
    projectWithLog(LOG);
    const result = await projectLogs({ includeDetail: true, level: 'error' });

    assert.deepEqual(result.data.entries[0].detail,
        ['    at SkinnedMeshRenderer._tryBindAnimation (index.js:115295:23)']);
});

test('a query searches lines and reports where they sit in the file', async () => {
    projectWithLog(LOG);
    const result = await projectLogs({ query: 'Joystick' });

    assert.equal(result.data.mode, 'search');
    assert.equal(result.data.totalMatches, 1);
    assert.equal(result.data.matches[0].lineNumber, 2);
    assert.equal(typeof result.data.lastModified, 'string');
});

test('a level window hides the lines of entries outside it from the search', async () => {
    projectWithLog(LOG);
    const wide = await projectLogs({ query: 'error' });
    const narrow = await projectLogs({ query: 'error', level: 'error' });

    assert.equal(wide.data.totalMatches, 2);
    assert.deepEqual(narrow.data.matches.map(match => match.lineNumber), [2]);
});

test('the keyword and limit spellings that once match-alled resolve to query and limit', async () => {
    projectWithLog(LOG);
    const result = await projectLogs({ keyword: 'texture', maxResults: 5 });

    assert.equal(result.data.mode, 'search');
    assert.equal(result.data.maxResults, 5);
    assert.equal(result.data.matches[0].matchedLine, '27.07.2026 09:05:13 - warn: texture not compressed');
});

test('a blank query reads the tail instead of matching every line', async () => {
    projectWithLog(LOG);
    const result = await projectLogs({ query: '   ' });

    assert.equal(result.data.mode, 'tail');
    assert.equal(result.data.entries.length, 4);
});

test('an unreadable since is refused, and the refusal still names the file', async () => {
    const root = projectWithLog(LOG);
    const result = await projectLogs({ since: 'last tuesday' });

    assert.equal(result.success, false);
    assert.equal(result.error.code, 'invalid_since');
    assert.equal(result.data.logFilePath, path.join(root, 'temp', 'logs', 'project.log'));
});

test('a missing log file is a refusal naming where it was looked for', async () => {
    projectWithLog(null);
    const result = await projectLogs({});

    assert.equal(result.success, false);
    assert.equal(result.error.code, 'log_missing');
    assert.ok(result.data.searchedPaths.some(candidate => candidate.endsWith(path.join('temp', 'logs', 'project.log'))));
});

test('an empty log answers with the file block rather than looking like a dead file', async () => {
    projectWithLog('');
    const result = await projectLogs({});

    assert.equal(result.success, true);
    assert.equal(result.data.fileSize, 0);
    assert.deepEqual(result.data.entries, []);
});

test('preview logs are read out of the buffer the bridge fills', async () => {
    const logs = new PreviewLogStore();
    logs.ingest({ session: 'run-1', entries: [
        { level: 'log', message: 'hello', ts: 1 },
        { level: 'error', message: 'boom', ts: 2 }
    ] }, 1000);

    const result = await toolNamed('debug_get_preview_logs')
        .invoke({ level: 'error' }, { logs, settings: { port: 4000 } });

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(result.data.logs.map(entry => entry.message), ['boom']);
    assert.equal(result.data.hint, undefined);
});

test('an empty buffer says the forwarding script may never have run, naming the bridge port', async () => {
    const result = await toolNamed('debug_get_preview_logs')
        .invoke({}, { logs: new PreviewLogStore(), settings: { port: 4123 } });

    assert.match(result.data.hint, /4123\/preview-console\.js/);
});

test('clearing drops what was buffered', async () => {
    const logs = new PreviewLogStore();
    logs.ingest({ session: 'run-1', entries: [{ level: 'log', message: 'hello', ts: 1 }] }, 1000);

    const result = await toolNamed('debug_clear_preview_logs').invoke({}, { logs });

    assert.equal(result.success, true);
    assert.equal(logs.stats().buffered, 0);
});

test('performance stats refuse in edit mode instead of answering with zeros', async () => {
    const result = await toolNamed('debug_get_performance_stats').invoke({}, {});

    assert.equal(result.success, false);
    assert.equal(result.error.code, 'preview_only');
    assert.match(result.error.hint, /debug_get_preview_logs/);
});

test('validate_scene counts the whole tree and warns once past the node budget', async () => {
    const child = (depth) => (depth === 0 ? {} : { children: [child(depth - 1), child(depth - 1)] });
    const small = { children: [child(3)] };
    const tool = toolNamed('debug_validate_scene');

    const ok = await tool.invoke({}, { editor: { scene: { queryNodeTree: async () => small } } });
    assert.equal(ok.data.nodeCount, 15);
    assert.equal(ok.data.valid, true);

    const huge = { children: Array.from({ length: 1001 }, () => ({})) };
    const warned = await tool.invoke({}, { editor: { scene: { queryNodeTree: async () => huge } } });
    assert.equal(warned.data.valid, false);
    assert.equal(warned.data.issues[0].category, 'performance');
});

test('validate_scene with no scene open is a refusal, not an empty pass', async () => {
    const result = await toolNamed('debug_validate_scene')
        .invoke({}, { editor: { scene: { queryNodeTree: async () => null } } });

    assert.equal(result.success, false);
    assert.equal(result.error.code, 'no_scene');
});

test('execute_script hands the script to the scene and passes its answer back', async () => {
    const calls = [];
    const sceneScript = {
        call(method, ...args) {
            calls.push({ method, args });
            return Promise.resolve({ success: true, data: { result: 'Thug', functionWrapper: true } });
        }
    };

    const result = await toolNamed('debug_execute_script')
        .invoke({ script: 'return cc.director.getScene().name' }, { sceneScript });

    assert.deepEqual(calls, [{ method: 'evalInScene', args: ['return cc.director.getScene().name'] }]);
    assert.deepEqual(result.data, { result: 'Thug', functionWrapper: true });
});

test('a script that threw in the scene comes back as a failure, not a success carrying an error', async () => {
    const sceneScript = { call: async () => ({ success: false, error: 'ReferenceError: nope is not defined' }) };

    const result = await toolNamed('debug_execute_script').invoke({ script: 'nope()' }, { sceneScript });

    assert.equal(result.success, false);
    assert.equal(result.error.message, 'ReferenceError: nope is not defined');
});
