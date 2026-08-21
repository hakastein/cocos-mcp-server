import test from 'node:test';
import assert from 'node:assert/strict';

import { groupLogLines } from '../src/log/entries.ts';
import { searchLines } from '../src/log/search.ts';
import {
    logSearchSummary, logTailSummary, renderLogEntries, renderLogMatches
} from '../src/render/log.ts';

const LINES = [
    'Startup banner with no timestamp',
    '27.07.2026 09:05:10 - log: [Scene] built on Thug',
    '27.07.2026 09:05:11 - error: Module "../Joystick" not found',
    '    at SkinnedMeshRenderer._tryBindAnimation (index.js:115295:23)',
    '    at Scene._activate (index.js:63356:44)'
];

const FILE = { path: 'D:/p/temp/logs/project.log', size: 4096, modified: '2026-08-21T09:00:00.000Z', totalLines: 5 };
const WINDOW = { entriesInWindow: 3, entriesTotal: 3 };

test('an entry line carries its line number, time, level and message', () => {
    const text = renderLogEntries(groupLogLines(LINES), false);
    assert.match(text, /^3 +27\.07\.2026 09:05:11 +error +Module "\.\.\/Joystick" not found/m);
});

test('the frames of an entry are counted, not printed, until --detail asks for them', () => {
    assert.match(renderLogEntries(groupLogLines(LINES), false), /not found +\+2 lines$/m);

    const detailed = renderLogEntries(groupLogLines(LINES), true);
    assert.match(detailed, /^ {4}at Scene\._activate \(index\.js:63356:44\)$/m);
    assert.doesNotMatch(detailed, /\+2 lines/);
});

test('an entry the editor wrote without a timestamp still gets its line', () => {
    assert.match(renderLogEntries(groupLogLines(LINES), false), /^1 +log +Startup banner/m);
});

test('an empty window says so instead of printing nothing', () => {
    assert.match(renderLogEntries([], false), /nothing in the log/);
});

test('the tail summary names the file, what it returned and what the window held', () => {
    const summary = logTailSummary(FILE, WINDOW, 3);
    assert.match(summary, /D:\/p\/temp\/logs\/project\.log {2}4096 bytes {2}modified 2026-08-21T09:00:00\.000Z/);
    assert.match(summary, /^entries: 3 of 3 in the window, 3 in the file$/m);
});

test('a narrowed window names the level and the cutoff it was narrowed by', () => {
    const summary = logTailSummary(
        FILE, { level: 'warn', since: '2026-08-21T08:00:00.000Z', entriesInWindow: 1, entriesTotal: 9 }, 1);
    assert.match(summary, /entries: 1 of 1 in the window, 9 in the file {2}level>=warn {2}since 2026-08-21T08:00:00\.000Z/);
});

test('a matched line is marked and its context is not', () => {
    const text = renderLogMatches(searchLines(LINES, { pattern: 'Joystick', contextLines: 1 }));
    assert.match(text, /^> {2}3 {2}27\.07\.2026 09:05:11 - error: Module "\.\.\/Joystick" not found$/m);
    assert.match(text, /^ {3}2 {2}27\.07\.2026 09:05:10 - log: \[Scene\] built on Thug$/m);
});

test('a search that matched nothing says so rather than printing an empty page', () => {
    assert.match(renderLogMatches(searchLines(LINES, { pattern: 'absent' })), /no line matches/);
});

test('the search summary reports the true total, not the capped page', () => {
    const result = searchLines(['err', 'err', 'err'], { pattern: 'err', maxResults: 1 });
    const summary = logSearchSummary(FILE, WINDOW, result);
    assert.match(summary, /matches: 1 of 3 {2}pattern 'err'/);
    assert.match(summary, /raise -n/);
});

test('a complete search does not tell the caller to raise the cap', () => {
    const result = searchLines(['err'], { pattern: 'err' });
    assert.doesNotMatch(logSearchSummary(FILE, WINDOW, result), /raise -n/);
});

test('regex and case-sensitivity are named, because they change what a zero-result means', () => {
    const result = searchLines(['a.b'], { pattern: 'a.b', regex: true, caseSensitive: true });
    assert.match(logSearchSummary(FILE, WINDOW, result), /regex {2}case-sensitive/);
});
