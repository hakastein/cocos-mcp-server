import test from 'node:test';
import assert from 'node:assert/strict';

import {
    filterEntries, groupLogLines, levelAtLeast, maskOutsideEntries, parseSince
} from '../src/log/entries.ts';

// Shaped like a real temp/logs/project.log: a header line, then stack frames that belong to it.
const LINES = [
    'Startup banner with no timestamp',
    '27.07.2026 09:05:10 - log: [Scene] built on Thug',
    '27.07.2026 09:05:11 - error: Module "../Joystick" not found',
    '    at SkinnedMeshRenderer._tryBindAnimation (index.js:115295:23)',
    '    at Scene._activate (index.js:63356:44)',
    '',
    '    at Director.runSceneImmediate (index.js:15538:17)',
    '27.07.2026 09:05:12 - warn: texture not compressed',
    '27.07.2026 09:05:13 - log: Use preview template'
];

test('continuation lines fold into the entry above them', () => {
    const entries = groupLogLines(LINES);
    assert.equal(entries.length, 5);
    const failure = entries.find(entry => entry.level === 'error');
    assert.equal(failure.message, 'Module "../Joystick" not found');
    assert.equal(failure.detail.length, 3);
    // the blank line sits inside the entry, so the span is wider than the detail count
    assert.equal(failure.lineNumber, 3);
    assert.equal(failure.endLine, 7);
});

test('a stack frame does not become its own error', () => {
    assert.equal(groupLogLines(LINES).filter(entry => entry.level === 'error').length, 1);
});

test('level comes from the line field, not from words in the text', () => {
    const entries = groupLogLines([
        '27.07.2026 09:05:10 - log: checking whether the error handler failed to load',
        '27.07.2026 09:05:11 - error: real failure'
    ]);
    assert.equal(entries[0].level, 'log');
    assert.equal(entries[1].level, 'error');
});

test('lines before the first header are kept, with no timestamp', () => {
    const entries = groupLogLines(LINES);
    assert.equal(entries[0].message, 'Startup banner with no timestamp');
    assert.equal(entries[0].ts, null);
});

test('minLevel keeps everything at least as severe', () => {
    assert.deepEqual(
        filterEntries(groupLogLines(LINES), { minLevel: 'warn' }).map(entry => entry.level),
        ['error', 'warn']);
});

test('since drops older entries but keeps timestampless ones', () => {
    const cutoff = new Date(2026, 6, 27, 9, 5, 12).getTime();
    const kept = filterEntries(groupLogLines(LINES), { sinceMs: cutoff });
    assert.equal(kept.some(entry => entry.message.includes('built on Thug')), false);
    assert.equal(kept.some(entry => entry.ts === null), true);
    assert.equal(kept.some(entry => entry.level === 'warn'), true);
});

test('contains narrows on the header line, not on the frames under it', () => {
    const kept = filterEntries(groupLogLines(LINES), { contains: 'JOYSTICK' });
    assert.deepEqual(kept.map(entry => entry.lineNumber), [3]);
});

test('relative since values resolve against now', () => {
    const now = 1_000_000_000;
    assert.equal(parseSince('15m', now), now - 15 * 60000);
    assert.equal(parseSince('2h', now), now - 2 * 3600000);
    assert.equal(parseSince('90s', now), now - 90000);
    assert.equal(parseSince('1d', now), now - 86400000);
});

test('absolute since values are accepted', () => {
    assert.equal(parseSince('2026-07-27T00:00:00Z', 0), Date.parse('2026-07-27T00:00:00Z'));
    assert.equal(parseSince(1753000000000, 0), 1753000000000);
});

test('an unreadable since is an error, not a silently ignored filter', () => {
    assert.throws(() => parseSince('last tuesday', 0), /Cannot read 'since' value/);
});

test('masking blanks the lines outside the kept entries and leaves the others in place', () => {
    const kept = filterEntries(groupLogLines(LINES), { contains: 'texture' });
    const masked = maskOutsideEntries(LINES, kept);

    assert.equal(masked.length, LINES.length);
    assert.equal(masked[7], '27.07.2026 09:05:12 - warn: texture not compressed');
    assert.deepEqual(masked.filter(line => line !== ''), [masked[7]]);
});

test('a kept entry keeps its stack frames, blank line inside the span included', () => {
    const kept = filterEntries(groupLogLines(LINES), { contains: 'Joystick' });

    assert.deepEqual(maskOutsideEntries(LINES, kept), [
        '', '',
        '27.07.2026 09:05:11 - error: Module "../Joystick" not found',
        '    at SkinnedMeshRenderer._tryBindAnimation (index.js:115295:23)',
        '    at Scene._activate (index.js:63356:44)',
        '',
        '    at Director.runSceneImmediate (index.js:15538:17)',
        '', ''
    ]);
});

test('severity ordering', () => {
    assert.equal(levelAtLeast('error', 'warn'), true);
    assert.equal(levelAtLeast('log', 'warn'), false);
    assert.equal(levelAtLeast('warn', 'warn'), true);
    assert.equal(levelAtLeast('debug', 'log'), false);
});
