import test from 'node:test';
import assert from 'node:assert/strict';

import { searchLines } from '../src/log/search.ts';

// Shaped like the head of a real temp/logs/project.log, with the interesting lines buried far
// enough down that a head-of-file bug is obvious.
const LINES = [
    'Load engine in 1234ms',
    'Register native engine module',
    'Request namespace: device-list',
    'Startup finished',
    'assets/scripts/core/di/serviceTag.ts: property _sealed is not defined',
    'plain line',
    'another _SEALED mention in different case',
    'trailing line'
];

test('only lines containing the keyword come back', () => {
    const found = searchLines(LINES, { pattern: '_sealed' });
    assert.equal(found.totalMatches, 2);
    assert.deepEqual(found.matches.map(match => match.lineNumber), [5, 7]);
    for (const match of found.matches) assert.match(match.matchedLine.toLowerCase(), /_sealed/);
});

test('the head of the file is not returned when nothing matches', () => {
    const found = searchLines(LINES, { pattern: 'definitely-absent-token' });
    assert.equal(found.totalMatches, 0);
    assert.deepEqual(found.matches, []);
});

test('an empty or blank pattern is an error, never a match-all', () => {
    for (const blank of ['', '   ', undefined, null]) {
        assert.throws(() => searchLines(LINES, { pattern: blank }), /non-empty/i);
    }
});

test('matching is case-insensitive by default and exact under caseSensitive', () => {
    assert.equal(searchLines(LINES, { pattern: '_SEALED' }).totalMatches, 2);
    assert.equal(searchLines(LINES, { pattern: '_SEALED', caseSensitive: true }).totalMatches, 1);
});

test('maxResults caps returned matches but totalMatches reports the real count', () => {
    const found = searchLines(LINES, { pattern: '_sealed', maxResults: 1 });
    assert.equal(found.matches.length, 1);
    assert.equal(found.totalMatches, 2);
    assert.equal(found.truncated, true);
});

test('a non-truncated search is flagged as complete', () => {
    const found = searchLines(LINES, { pattern: '_sealed', maxResults: 50 });
    assert.equal(found.truncated, false);
    assert.equal(found.matches.length, 2);
});

test('regex metacharacters are literal unless regex mode is requested', () => {
    const lines = ['value a.b here', 'value axb here'];
    assert.equal(searchLines(lines, { pattern: 'a.b' }).totalMatches, 1);
    assert.equal(searchLines(lines, { pattern: 'a.b', regex: true }).totalMatches, 2);
});

test('an invalid regex is reported rather than silently reinterpreted as literal text', () => {
    assert.throws(
        () => searchLines(LINES, { pattern: '([unclosed', regex: true }),
        /invalid regular expression/i);
});

test('context lines surround the match and only the match is flagged', () => {
    const found = searchLines(LINES, { pattern: '_sealed', contextLines: 1, maxResults: 1 });
    const context = found.matches[0].context;
    assert.deepEqual(context.map(line => line.lineNumber), [4, 5, 6]);
    assert.deepEqual(context.map(line => line.isMatch), [false, true, false]);
});

test('context is clamped at the file edges', () => {
    const found = searchLines(['hit', 'b', 'c'], { pattern: 'hit', contextLines: 5 });
    assert.deepEqual(found.matches[0].context.map(line => line.lineNumber), [1, 2, 3]);
});

test('a global-flag regex does not skip alternate matches', () => {
    const lines = ['err one', 'err two', 'err three', 'err four'];
    assert.equal(searchLines(lines, { pattern: 'err', regex: true }).totalMatches, 4);
});
