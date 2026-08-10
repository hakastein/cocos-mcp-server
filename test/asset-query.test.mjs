import test from 'node:test';
import assert from 'node:assert/strict';

import aq from '../dist/asset-query.js';

const { assetQuery, selectAssets, matchesAssetName, ASSET_TYPES } = aq;

test('a type filters by its extension inside the folder', () => {
    assert.deepEqual(assetQuery('db://assets', 'prefab'), { pattern: 'db://assets/**/*.prefab' });
    assert.deepEqual(assetQuery('db://assets/ui', 'script'), { pattern: 'db://assets/ui/**/*.{ts,js}' });
});

test('spriteFrame filters by cc type — the sub-asset has no extension of its own', () => {
    assert.deepEqual(assetQuery('db://assets', 'spriteFrame'),
        { pattern: 'db://assets/**/*', ccType: 'cc.SpriteFrame' });
});

test("'all' is the only type that globs everything", () => {
    assert.deepEqual(assetQuery('db://assets', 'all'), { pattern: 'db://assets/**/*' });
});

test('a type absent from the table throws instead of silently globbing everything', () => {
    assert.throws(() => assetQuery('db://assets', 'spriteframe'), /spriteframe/);
    assert.throws(() => assetQuery('db://assets', 'shader'), /shader/);
});

test('every advertised type resolves to a query narrower than the whole folder', () => {
    for (const type of ASSET_TYPES) {
        const query = assetQuery('db://assets', type);
        if (type === 'all') continue;
        assert.ok(query.pattern !== 'db://assets/**/*' || query.ccType,
            `${type} resolves to a bare folder glob`);
    }
});

test('a trailing slash on the folder does not double up in the pattern', () => {
    assert.equal(assetQuery('db://assets/', 'scene').pattern, 'db://assets/**/*.scene');
});

const asset = (name) => ({ name, uuid: `uuid-${name}` });
const names = (selection) => selection.assets.map(a => a.name);

test('name matching is a case-insensitive substring, and exactMatch is identity', () => {
    assert.equal(matchesAssetName('CharGirl', 'girl', false), true);
    assert.equal(matchesAssetName('CharGirl', 'girl', true), false);
    assert.equal(matchesAssetName('CharGirl', 'CharGirl', true), true);
});

test('no name selects everything in the order the database answered', () => {
    const selection = selectAssets([asset('b'), asset('a')]);
    assert.deepEqual(names(selection), ['b', 'a']);
    assert.equal(selection.total, 2);
    assert.equal(selection.truncated, false);
});

test('maxResults cuts the list but total still reports what matched', () => {
    const selection = selectAssets([asset('hat_a'), asset('hat_b'), asset('hat_c')], { name: 'hat', maxResults: 2 });
    assert.deepEqual(names(selection), ['hat_a', 'hat_b']);
    assert.equal(selection.total, 3);
    assert.equal(selection.truncated, true);
});

test('a cap larger than the match count is not reported as a truncation', () => {
    const selection = selectAssets([asset('hat_a')], { name: 'hat', maxResults: 20 });
    assert.equal(selection.total, 1);
    assert.equal(selection.truncated, false);
});

test('exactMatch drops the partial hits the substring match would have kept', () => {
    const all = [asset('hat'), asset('hat_red'), asset('tophat')];
    assert.deepEqual(names(selectAssets(all, { name: 'hat' })), ['hat', 'hat_red', 'tophat']);
    assert.deepEqual(names(selectAssets(all, { name: 'hat', exactMatch: true })), ['hat']);
});
