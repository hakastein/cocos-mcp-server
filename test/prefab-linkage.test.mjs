/**
 * Prefab linkage: the create-node options that decide whether an instantiated node is a real
 * instance or a flat copy, and how the two observations about it are reported.
 *
 * Both halves are pure, so the branch that silently produced unlinked copies for every prefab
 * this bridge ever instantiated is pinned here without an editor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PREFAB_ASSET_TYPE, LINKAGE_WARNING,
    applyLinkageOptions, expectsLinkage, linkageVerdict
} from '../dist/prefab-linkage.js';

const linkage = (over = {}) => ({
    linked: false, asset: null, fileId: null, instanceRoot: false,
    persistenceChecked: false, persisted: false, persistedAsset: null, ...over
});

const LINKED = linkage({
    linked: true, asset: 'asset-uuid', fileId: 'file-id', instanceRoot: true,
    persistenceChecked: true, persisted: true, persistedAsset: 'asset-uuid'
});

test('a prefab asset gets its type forwarded — the option the editor reads', () => {
    assert.deepEqual(
        applyLinkageOptions({ assetUuid: 'u' }, PREFAB_ASSET_TYPE, false),
        { assetUuid: 'u', type: PREFAB_ASSET_TYPE }
    );
});

test('an unlink request keeps the type and asks for the flat copy explicitly', () => {
    assert.deepEqual(
        applyLinkageOptions({ assetUuid: 'u' }, PREFAB_ASSET_TYPE, true),
        { assetUuid: 'u', type: PREFAB_ASSET_TYPE, unlinkPrefab: true }
    );
});

test('a non-prefab asset gets no type: createNodeFromAsset refuses types outside its creatable list', () => {
    for (const type of ['cc.Mesh', 'cc.SpriteFrame', null, undefined]) {
        assert.deepEqual(applyLinkageOptions({ assetUuid: 'u' }, type, false), { assetUuid: 'u' });
    }
});

test('linkage is expected only for a prefab asset that was not asked to be unlinked', () => {
    assert.equal(expectsLinkage(PREFAB_ASSET_TYPE, false), true);
    assert.equal(expectsLinkage(PREFAB_ASSET_TYPE, true), false);
    assert.equal(expectsLinkage('cc.Mesh', false), false);
    assert.equal(expectsLinkage(null, false), false);
});

test('linked and serialized is the only clean pass', () => {
    const { failed, fields } = linkageVerdict(LINKED, PREFAB_ASSET_TYPE, false);
    assert.equal(failed, false);
    assert.equal(fields.prefabLinked, true);
    assert.equal(fields.prefabLinkagePersisted, true);
    assert.equal(fields.prefabAsset, 'asset-uuid');
    assert.equal(fields.prefabInstanceRoot, true);
    assert.equal(fields.warning, undefined);
});

test('no PrefabInfo on the live node is a failure, not a success with a note', () => {
    const { failed, fields } = linkageVerdict(linkage(), PREFAB_ASSET_TYPE, false);
    assert.equal(failed, true);
    assert.equal(fields.prefabLinked, false);
    assert.equal(fields.prefabLinkagePersisted, false);
    assert.equal(fields.warning, LINKAGE_WARNING);
    assert.match(fields.prefabLinkageNote, /NO PrefabInfo/);
});

test('a live link the serializer drops is a failure: the save would flatten it', () => {
    const { failed, fields } = linkageVerdict(
        linkage({ linked: true, asset: 'a', persistenceChecked: true, persisted: false }),
        PREFAB_ASSET_TYPE, false
    );
    assert.equal(failed, true);
    assert.equal(fields.prefabLinked, true);
    assert.equal(fields.prefabLinkagePersisted, false);
    assert.equal(fields.warning, LINKAGE_WARNING);
});

test('an unreachable serializer leaves persistence unproven without calling it a failure', () => {
    const { failed, fields } = linkageVerdict(
        linkage({ linked: true, asset: 'a', persistenceReason: 'scene script unavailable' }),
        PREFAB_ASSET_TYPE, false
    );
    assert.equal(failed, false);
    assert.equal(fields.prefabLinked, true);
    assert.equal(fields.prefabLinkagePersisted, false);
    assert.equal(fields.warning, undefined);
    assert.match(fields.prefabLinkageNote, /scene script unavailable/);
});

test('a requested flat copy is reported as intended, never as a linkage failure', () => {
    const { failed, fields } = linkageVerdict(linkage(), PREFAB_ASSET_TYPE, true);
    assert.equal(failed, false);
    assert.equal(fields.warning, undefined);
    assert.match(fields.prefabLinkageNote, /unlinkPrefab was requested/);
});

test('a non-prefab asset is never judged on linkage', () => {
    const { failed, fields } = linkageVerdict(linkage(), 'cc.Mesh', false);
    assert.equal(failed, false);
    assert.equal(fields.warning, undefined);
    assert.match(fields.prefabLinkageNote, /cc\.Mesh/);
});
