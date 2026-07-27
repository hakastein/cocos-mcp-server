import test from 'node:test';
import assert from 'node:assert/strict';
import ta from '../dist/tool-args.js';

const { normalizeToolArgs, ALIAS_KEY } = ta;

const SEARCH_SCHEMA = {
    type: 'object',
    properties: {
        pattern: { type: 'string', [ALIAS_KEY]: ['keyword', 'query'], description: 'Search text' },
        maxResults: { type: 'number', [ALIAS_KEY]: ['limit'], description: 'Cap' },
        regex: { type: 'boolean', description: 'Regex mode' }
    },
    required: ['pattern']
};

const REIMPORT_SCHEMA = {
    type: 'object',
    properties: {
        url: { type: 'string', [ALIAS_KEY]: ['assetPath', 'path'], description: 'Asset URL' }
    },
    required: ['url']
};

test('a missing required argument is rejected, never passed through as undefined', () => {
    const r = normalizeToolArgs('debug_search_project_logs', SEARCH_SCHEMA, {});
    assert.equal(r.ok, false);
    assert.match(r.error, /missing required argument/i);
    assert.match(r.error, /pattern/);
});

test('the reported Bug 1 call shape resolves keyword -> pattern and limit -> maxResults', () => {
    const r = normalizeToolArgs('debug_search_project_logs', SEARCH_SCHEMA, { keyword: '_sealed', limit: 6 });
    assert.equal(r.ok, true);
    assert.equal(r.args.pattern, '_sealed');
    assert.equal(r.args.maxResults, 6);
    // the alias spelling must not survive alongside the canonical one
    assert.ok(!('keyword' in r.args));
    assert.ok(!('limit' in r.args));
});

test('the reported Bug 2 call shape resolves assetPath -> url', () => {
    const r = normalizeToolArgs('project_reimport_asset', REIMPORT_SCHEMA, {
        assetPath: 'db://assets/shared/scripts/core/di/serviceTag.ts'
    });
    assert.equal(r.ok, true);
    assert.equal(r.args.url, 'db://assets/shared/scripts/core/di/serviceTag.ts');
});

test('an unknown argument name yields a validation error naming the expected parameter', () => {
    const r = normalizeToolArgs('project_reimport_asset', REIMPORT_SCHEMA, { assetUrlPath: 'db://assets/x.ts' });
    assert.equal(r.ok, false);
    assert.match(r.error, /assetUrlPath/);      // names what was received
    assert.match(r.error, /url/);               // names what was expected
    assert.match(r.error, /did you mean/i);     // and suggests the fix
});

test('the error lists the full expected parameter set so a caller can self-correct', () => {
    const r = normalizeToolArgs('debug_search_project_logs', SEARCH_SCHEMA, { nope: 1 });
    assert.equal(r.ok, false);
    assert.match(r.error, /pattern/);
    assert.match(r.error, /maxResults/);
    assert.match(r.error, /regex/);
});

test('a null or empty-string required argument counts as missing', () => {
    for (const bad of [{ pattern: null }, { pattern: undefined }, { pattern: '   ' }]) {
        const r = normalizeToolArgs('t', SEARCH_SCHEMA, bad);
        assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
    }
});

test('a blank required argument is reported as empty, not as absent', () => {
    const r = normalizeToolArgs('t', SEARCH_SCHEMA, { pattern: '   ' });
    assert.equal(r.ok, false);
    assert.match(r.error, /supplied but empty/i);
    // it must not claim the argument was missing when the caller did pass the name
    assert.doesNotMatch(r.error, /missing required argument/i);
});

test('a near-miss argument name is suggested even across word boundaries', () => {
    const r = normalizeToolArgs('project_reimport_asset', REIMPORT_SCHEMA, { assetUri: 'db://assets/x.ts' });
    assert.equal(r.ok, false);
    assert.match(r.error, /did you mean 'url'/i);
});

test('an unrecognised argument is listed as such', () => {
    const r = normalizeToolArgs('t', SEARCH_SCHEMA, { totallyUnrelated: 1 });
    assert.equal(r.ok, false);
    assert.match(r.error, /unrecognised argument/i);
    assert.match(r.error, /totallyUnrelated/);
});

test('numeric and boolean strings from the REST surface are coerced to their declared type', () => {
    const r = normalizeToolArgs('t', SEARCH_SCHEMA, { pattern: 'x', limit: '6', regex: 'true' });
    assert.equal(r.ok, true);
    assert.equal(r.args.maxResults, 6);
    assert.equal(r.args.regex, true);
});

test('a value that cannot satisfy its declared type is a clear error, not a silent cast', () => {
    const r = normalizeToolArgs('t', SEARCH_SCHEMA, { pattern: 'x', maxResults: 'abc' });
    assert.equal(r.ok, false);
    assert.match(r.error, /maxResults/);
});

test('an object handed to a declared string parameter is rejected', () => {
    const r = normalizeToolArgs('t', REIMPORT_SCHEMA, { url: { db: 'x' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /url/);
});

test('an explicit canonical value wins over an alias spelling of the same parameter', () => {
    const r = normalizeToolArgs('t', SEARCH_SCHEMA, { pattern: 'real', keyword: 'ignored' });
    assert.equal(r.ok, true);
    assert.equal(r.args.pattern, 'real');
});

test('undeclared extras are tolerated when every required argument is present', () => {
    // handlers such as scene_dump/set_component_ref take the whole args object and read
    // fields their schema does not enumerate — validation must not break them
    const r = normalizeToolArgs('t', SEARCH_SCHEMA, { pattern: 'x', undocumentedButUsed: true });
    assert.equal(r.ok, true);
    assert.equal(r.args.undocumentedButUsed, true);
});

test('a schema with no required list accepts an empty call', () => {
    const r = normalizeToolArgs('t', { type: 'object', properties: { a: { type: 'string' } } }, {});
    assert.equal(r.ok, true);
});

test('null or non-object args are treated as an empty argument set', () => {
    assert.equal(normalizeToolArgs('t', SEARCH_SCHEMA, null).ok, false);       // pattern still required
    assert.equal(normalizeToolArgs('t', { type: 'object' }, null).ok, true);   // nothing required
});
