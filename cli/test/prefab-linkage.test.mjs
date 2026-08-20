import test from 'node:test';
import assert from 'node:assert/strict';

import l from '../lib/prefab-linkage.js';

const { applyLinkageOptions, expectsLinkage, linkageVerdict, prefabSavePath, PREFAB_ASSET_TYPE } = l;

const linkage = (over = {}) => ({
    linked: true, asset: 'a-1', fileId: 'f-1', instanceRoot: true,
    persistenceChecked: true, persisted: true, persistedAsset: 'a-1', ...over
});

test('a prefab asset gets the type the editor branch reads, which is what establishes linkage', () => {
    assert.deepEqual(
        applyLinkageOptions({ assetUuid: 'u' }, PREFAB_ASSET_TYPE, false),
        { assetUuid: 'u', type: 'cc.Prefab' });
});

test('a non-prefab asset gets no type — createNodeFromAsset returns no node at all for one it cannot make', () => {
    assert.deepEqual(
        applyLinkageOptions({ assetUuid: 'u' }, 'cc.Mesh', false),
        { assetUuid: 'u' });
});

test('unlinkPrefab rides along and still leaves the type on a prefab', () => {
    assert.deepEqual(
        applyLinkageOptions({ assetUuid: 'u' }, PREFAB_ASSET_TYPE, true),
        { assetUuid: 'u', type: 'cc.Prefab', unlinkPrefab: true });
});

test('linkage is expected only for a prefab that was not asked to be unlinked', () => {
    assert.equal(expectsLinkage(PREFAB_ASSET_TYPE, false), true);
    assert.equal(expectsLinkage(PREFAB_ASSET_TYPE, true), false);
    assert.equal(expectsLinkage('cc.Mesh', false), false);
    assert.equal(expectsLinkage(null, false), false);
});

test('a linked prefab confirmed against the serializer passes', () => {
    const verdict = linkageVerdict(linkage(), PREFAB_ASSET_TYPE, false);
    assert.equal(verdict.failed, false);
    assert.equal(verdict.head, 'ok');
    assert.match(verdict.detail, /persisted=true/);
});

test('a prefab that came back without a PrefabInfo is a failure, not a quiet copy', () => {
    const verdict = linkageVerdict(linkage({ linked: false }), PREFAB_ASSET_TYPE, false);
    assert.equal(verdict.failed, true);
    assert.equal(verdict.head, 'НЕ СВЯЗАН');
});

test('a live link the serializer drops is a failure — the save turns it into a flat copy', () => {
    const verdict = linkageVerdict(linkage({ persisted: false }), PREFAB_ASSET_TYPE, false);
    assert.equal(verdict.failed, true);
    assert.equal(verdict.head, 'СВЯЗЬ НЕ СОХРАНИТСЯ');
});

test('an unreached serializer leaves the question open rather than answering no', () => {
    const verdict = linkageVerdict(
        linkage({ persistenceChecked: false, persisted: false, persistenceReason: 'сцена молчит' }),
        PREFAB_ASSET_TYPE, false);
    assert.equal(verdict.failed, false);
    assert.equal(verdict.head, 'СВЯЗАН, НЕ ПРОВЕРЕНО');
    assert.match(verdict.detail, /сцена молчит/);
});

test('an unlinked copy that was asked for is not judged on a link it never wanted', () => {
    const verdict = linkageVerdict(linkage({ linked: false }), PREFAB_ASSET_TYPE, true);
    assert.equal(verdict.failed, false);
    assert.match(verdict.detail, /--unlink/);
});

test('a non-prefab asset is not judged on linkage either', () => {
    const verdict = linkageVerdict(linkage({ linked: false }), 'cc.Mesh', false);
    assert.equal(verdict.failed, false);
    assert.match(verdict.detail, /cc\.Mesh/);
});

test('a full .prefab path is taken as it stands', () => {
    assert.deepEqual(
        prefabSavePath('db://assets/p/Rifle.prefab', 'SourceNode'),
        { url: 'db://assets/p/Rifle.prefab', name: 'Rifle' });
});

test('a folder takes the node name, and --name outranks it', () => {
    assert.deepEqual(prefabSavePath('db://assets/p', 'Guard'),
        { url: 'db://assets/p/Guard.prefab', name: 'Guard' });
    assert.deepEqual(prefabSavePath('db://assets/p', 'Guard', 'Sentry'),
        { url: 'db://assets/p/Sentry.prefab', name: 'Sentry' });
});

test('a trailing slash does not double up in the written url', () => {
    assert.equal(prefabSavePath('db://assets/p/', 'Guard').url, 'db://assets/p/Guard.prefab');
});

test('a folder with no name to take is refused rather than writing .prefab', () => {
    assert.throws(() => prefabSavePath('db://assets/p', ''), /--name/);
});
