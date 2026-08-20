import test from 'node:test';
import assert from 'node:assert/strict';

import q from '../lib/asset/query.js';

const { assetQuery, selectAssets, matchesAssetName, requireAssetUrl, isAssetUrl, commonAssetFolder } = q;

test('the all filter globs the folder without an extension', () => {
    assert.deepEqual(assetQuery('db://assets', 'all'), { pattern: 'db://assets/**/*' });
});

test('a trailing slash does not double up in the pattern', () => {
    assert.equal(assetQuery('db://assets/framework/', 'all').pattern, 'db://assets/framework/**/*');
});

test('script matches both extensions in one brace group', () => {
    assert.equal(assetQuery('db://assets', 'script').pattern, 'db://assets/**/*.{ts,js}');
});

test('spriteFrame narrows by cc type, because its assets carry no extension of their own', () => {
    assert.deepEqual(assetQuery('db://assets', 'spriteFrame'),
        { pattern: 'db://assets/**/*', ccType: 'cc.SpriteFrame' });
});

test('an unknown type is refused rather than globbing the whole project', () => {
    assert.throws(() => assetQuery('db://assets', 'shader'), /shader/);
});

test('matchesAssetName ignores case as a substring and respects it exactly', () => {
    assert.equal(matchesAssetName('TargetPolicy', 'target', false), true);
    assert.equal(matchesAssetName('TargetPolicy', 'target', true), false);
    assert.equal(matchesAssetName('TargetPolicy', 'TargetPolicy', true), true);
});

test('selectAssets counts the full match set before the cut, so a truncated list says so', () => {
    const assets = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    const selection = selectAssets(assets, { maxResults: 2 });
    assert.deepEqual(selection.assets, [{ name: 'a' }, { name: 'b' }]);
    assert.equal(selection.total, 3);
    assert.equal(selection.truncated, true);
});

test('a list that fits under the cap is not reported as truncated', () => {
    const selection = selectAssets([{ name: 'a' }], { maxResults: 2 });
    assert.equal(selection.total, 1);
    assert.equal(selection.truncated, false);
});

test('an empty name filter keeps every asset instead of matching none', () => {
    assert.equal(selectAssets([{ name: 'a' }, { name: 'b' }], { name: '' }).total, 2);
});

test('isAssetUrl holds for db:// and for nothing else', () => {
    assert.equal(isAssetUrl('db://assets/a.ts'), true);
    assert.equal(isAssetUrl('assets/a.ts'), false);
    assert.equal(isAssetUrl('D:\\cocos\\a.ts'), false);
});

test('requireAssetUrl names the argument a bare TypeError from the database would not', () => {
    assert.throws(() => requireAssetUrl('assets/a.ts', 'the folder to refresh'), /the folder to refresh/);
});

test('requireAssetUrl strips a trailing slash without eating the scheme', () => {
    assert.equal(requireAssetUrl('db://assets/framework/', 'x'), 'db://assets/framework');
    assert.throws(() => requireAssetUrl('db://', 'x'));
});

test('two assets in one folder settle over that folder', () => {
    assert.equal(
        commonAssetFolder('db://assets/npc/a.ts', 'db://assets/npc/b.ts'),
        'db://assets/npc');
});

test('a move across folders settles over the folder covering both', () => {
    assert.equal(
        commonAssetFolder('db://assets/framework/npc/Npc.ts', 'db://assets/framework/targeting/TargetPolicy.ts'),
        'db://assets/framework');
});

test('a move between separate roots falls back to the asset root rather than to db:', () => {
    assert.equal(commonAssetFolder('db://assets/a.ts', 'db://internal/b.ts'), 'db://assets');
});
