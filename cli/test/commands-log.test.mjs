import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { logSearch, logTail } from '../src/commands/log.ts';
import { present } from '../src/render/present.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, 'fixtures', 'log-project');
const NO_LOG = path.join(HERE, 'fixtures', 'ecs-project');

const messages = report => report.entries.map(entry => entry.message);

test('the tail is every entry of the log, the stack frames folded into the one they belong to', async () => {
    const report = await logTail({ projectPath: PROJECT });
    assert.equal(report.kind, 'logTail');
    assert.deepEqual(messages(report), [
        'Editor startup banner, written before the first timestamp',
        '[Scene] built on Thug',
        'Module "../Joystick" not found',
        'texture not compressed',
        'Use preview template'
    ]);
    assert.deepEqual(report.entries[2].detail, [
        '    at SkinnedMeshRenderer._tryBindAnimation (index.js:115295:23)',
        '    at Scene._activate (index.js:63356:44)'
    ]);
});

test('-n takes the newest entries, not the first ones in the file', async () => {
    assert.deepEqual(await logTail({ projectPath: PROJECT, limit: 2 }).then(messages),
        ['texture not compressed', 'Use preview template']);
});

test('a level filter keeps the entry, so the frames under an error come with it', async () => {
    const report = await logTail({ projectPath: PROJECT, level: 'warn' });
    assert.deepEqual(messages(report), ['Module "../Joystick" not found', 'texture not compressed']);
    assert.equal(report.entries[0].detail[0],
        '    at SkinnedMeshRenderer._tryBindAnimation (index.js:115295:23)');
});

test('a cutoff drops what is older and keeps the entry the editor wrote without a timestamp', async () => {
    const report = await logTail({ projectPath: PROJECT, since: '2026-07-27T09:05:12' });
    assert.deepEqual(messages(report), [
        'Editor startup banner, written before the first timestamp',
        'texture not compressed',
        'Use preview template'
    ]);
});

test('the window says how much of the file it covers, so a thin answer is readable', async () => {
    const report = await logTail({ projectPath: PROJECT, level: 'error' });
    assert.deepEqual(report.window, {
        level: 'error', since: undefined, contains: undefined, entriesInWindow: 1, entriesTotal: 5
    });
});

test('the entries are on stdout and the file it read is on stderr', async () => {
    const output = present(await logTail({ projectPath: PROJECT, level: 'error' }));
    assert.match(output.stdout, /^3 .*error {2}Module "\.\.\/Joystick" not found {2}\+2 lines$/m);
    assert.match(output.stderr, /project\.log/);
    assert.equal(output.failed, false);
});

test('search returns the matching lines with their surrounding context', async () => {
    const report = await logSearch({ projectPath: PROJECT, pattern: 'Joystick' });
    assert.equal(report.kind, 'logSearch');
    assert.deepEqual(report.result.matches.map(match => match.lineNumber), [3]);
});

test('a pattern the log does not carry answers empty rather than the head of the file', async () => {
    const report = await logSearch({ projectPath: PROJECT, pattern: 'definitely-absent-token' });
    assert.equal(report.result.totalMatches, 0);
    assert.deepEqual(report.result.matches, []);
});

test('a search narrowed by level looks only inside the entries that survived it', async () => {
    const wide = await logSearch({ projectPath: PROJECT, pattern: 'preview' });
    assert.equal(wide.result.totalMatches, 1);

    const narrow = await logSearch({ projectPath: PROJECT, pattern: 'preview', level: 'error' });
    assert.equal(narrow.result.totalMatches, 0);
});

test('a frame under a matching entry is searchable — masking keeps the whole span', async () => {
    const report = await logSearch({ projectPath: PROJECT, pattern: '_tryBindAnimation', level: 'error' });
    assert.deepEqual(report.result.matches.map(match => match.lineNumber), [4]);
});

test('an unreadable since is refused rather than widening the search to the whole file', async () => {
    await assert.rejects(
        logSearch({ projectPath: PROJECT, pattern: 'preview', since: 'last tuesday' }),
        /Cannot read 'since' value/);
});

test('a project the editor wrote no log for names the path it looked at', async () => {
    await assert.rejects(logTail({ projectPath: NO_LOG }), /project\.log/);
});
