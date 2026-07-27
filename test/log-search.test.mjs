import test from 'node:test';
import assert from 'node:assert/strict';
import ls from '../dist/log-search.js';

const { searchLines } = ls;

// Shaped like the head of a real temp/logs/project.log, with the interesting lines buried
// far enough down that a head-of-file bug is obvious.
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
    const r = searchLines(LINES, { pattern: '_sealed' });
    assert.equal(r.totalMatches, 2);
    assert.deepEqual(r.matches.map(m => m.lineNumber), [5, 7]);
    for (const m of r.matches) assert.match(m.matchedLine.toLowerCase(), /_sealed/);
});

test('the head of the file is not returned when nothing matches', () => {
    const r = searchLines(LINES, { pattern: 'definitely-absent-token' });
    assert.equal(r.totalMatches, 0);
    assert.deepEqual(r.matches, []);
});

test('an empty or blank pattern is an error, never a match-all', () => {
    // this is the exact degradation of Bug 1: new RegExp(undefined) === /(?:)/
    for (const bad of ['', '   ', undefined, null]) {
        assert.throws(() => searchLines(LINES, { pattern: bad }), /non-empty/i);
    }
});

test('matching is case-insensitive by default and exact under caseSensitive', () => {
    assert.equal(searchLines(LINES, { pattern: '_SEALED' }).totalMatches, 2);
    assert.equal(searchLines(LINES, { pattern: '_SEALED', caseSensitive: true }).totalMatches, 1);
});

test('maxResults caps returned matches but totalMatches reports the real count', () => {
    const r = searchLines(LINES, { pattern: '_sealed', maxResults: 1 });
    assert.equal(r.matches.length, 1);
    assert.equal(r.totalMatches, 2);
    assert.equal(r.truncated, true);
});

test('a non-truncated search is flagged as complete', () => {
    const r = searchLines(LINES, { pattern: '_sealed', maxResults: 50 });
    assert.equal(r.truncated, false);
    assert.equal(r.matches.length, 2);
});

test('regex metacharacters are literal unless regex mode is requested', () => {
    const lines = ['value a.b here', 'value axb here'];
    assert.equal(searchLines(lines, { pattern: 'a.b' }).totalMatches, 1);          // literal
    assert.equal(searchLines(lines, { pattern: 'a.b', regex: true }).totalMatches, 2); // regex
});

test('an invalid regex is reported rather than silently reinterpreted as literal text', () => {
    assert.throws(() => searchLines(LINES, { pattern: '([unclosed', regex: true }), /invalid regular expression/i);
});

test('context lines surround the match and only the match is flagged', () => {
    const r = searchLines(LINES, { pattern: '_sealed', contextLines: 1, maxResults: 1 });
    const ctx = r.matches[0].context;
    assert.deepEqual(ctx.map(c => c.lineNumber), [4, 5, 6]);
    assert.deepEqual(ctx.map(c => c.isMatch), [false, true, false]);
});

test('context is clamped at the file edges', () => {
    const r = searchLines(['hit', 'b', 'c'], { pattern: 'hit', contextLines: 5 });
    assert.deepEqual(r.matches[0].context.map(c => c.lineNumber), [1, 2, 3]);
});

test('a global-flag regex does not skip alternate matches', () => {
    // RegExp.test with /g advances lastIndex; reusing one across lines drops every other hit
    const lines = ['err one', 'err two', 'err three', 'err four'];
    assert.equal(searchLines(lines, { pattern: 'err', regex: true }).totalMatches, 4);
});
