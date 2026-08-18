/**
 * What a node/component reference field is worth after the next load, and which target overrides
 * the field's current contents contradict.
 *
 * The field failure these lock down: `set_component_ref` assigned `CtaController.targets` on the
 * live engine object, read the uuids straight back off the object it had just written, and reported
 * success with verified:true. Two of the three targets lived inside the `Packshot_v3` prefab
 * instance, so the scene file held null for them and no target override existed — the buttons were
 * dead the next time the scene opened, and the read-back could never have noticed, because it never
 * consulted anything but its own assignment.
 *
 * So the assertions are about the serialized value and the overrides deciding the answer together,
 * about an override past the end of an array growing it back, and about a leftover override being
 * named as contradicted rather than left to win silently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    projectAfterReload, contradictedOverrides, liveNodesBySerializedIndex
} from '../dist/reference-projection.js';
import { plainSerialized } from '../dist/scene/engine.js';

const CARD_LEFT = 'f0rQc7yj9Gpqltg+gTq5ZA';      // inside the Packshot_v3 prefab instance
const PACKSHOT_BUTTON = 'ebC5PeFPVI1oNkWKN6VSm1'; // inside the Packshot_v3 prefab instance
const TOPBAR_BUTTON = '99gxqM8oBECrpz9BMNxeS6';   // a mounted child, written into the scene itself
const ICON = '8b5jDUQ4NEDa6X8GXJ8iAX';

test('a reference into a prefab instance is worth its override, not the null in the file', () => {
    const projected = projectAfterReload(
        [null, null, TOPBAR_BUTTON],
        [{ index: 0, uuid: CARD_LEFT }, { index: 1, uuid: PACKSHOT_BUTTON }]
    );
    assert.deepEqual(projected, [CARD_LEFT, PACKSHOT_BUTTON, TOPBAR_BUTTON]);
});

test('with no override the file wins, so a live-only assignment projects to nothing', () => {
    assert.deepEqual(projectAfterReload([null, null, TOPBAR_BUTTON], []), [null, null, TOPBAR_BUTTON]);
});

test('an override that resolves to nothing is skipped, exactly as applyTargetOverrides skips it', () => {
    const projected = projectAfterReload([null, null], [{ index: 0, uuid: CARD_LEFT }, { index: 1, uuid: null }]);
    assert.deepEqual(projected, [CARD_LEFT, null]);
});

test('a single-reference field is one slot and takes the index-less override', () => {
    assert.deepEqual(projectAfterReload([null], [{ index: null, uuid: CARD_LEFT }]), [CARD_LEFT]);
});

test('an override past the end grows the array back, and the gap reads as empty', () => {
    const projected = projectAfterReload([null, null, TOPBAR_BUTTON], [{ index: 4, uuid: ICON }]);
    assert.deepEqual(projected, [null, null, TOPBAR_BUTTON, null, ICON]);
});

test('overrides matching what the field holds are left alone', () => {
    const live = [CARD_LEFT, PACKSHOT_BUTTON, TOPBAR_BUTTON];
    const overrides = [{ index: 0, uuid: CARD_LEFT }, { index: 1, uuid: PACKSHOT_BUTTON }];
    assert.deepEqual(contradictedOverrides(live, overrides), []);
});

test('an override for a slot the field no longer has is contradicted', () => {
    const live = [CARD_LEFT, PACKSHOT_BUTTON, TOPBAR_BUTTON];
    const overrides = [{ index: 0, uuid: CARD_LEFT }, { index: 3, uuid: ICON }];
    assert.deepEqual(contradictedOverrides(live, overrides), [1]);
});

test('an override for a slot now pointing elsewhere is contradicted', () => {
    const live = [CARD_LEFT, TOPBAR_BUTTON];
    const overrides = [{ index: 1, uuid: PACKSHOT_BUTTON }];
    assert.deepEqual(contradictedOverrides(live, overrides), [0]);
});

test('a dead override over a slot that is empty anyway is not contradicted', () => {
    assert.deepEqual(contradictedOverrides([CARD_LEFT, null], [{ index: 1, uuid: null }]), []);
});

test('pruning what the field contradicts makes the projection agree with the field', () => {
    const live = [CARD_LEFT, PACKSHOT_BUTTON, TOPBAR_BUTTON];
    const serialized = [null, null, TOPBAR_BUTTON];
    const overrides = [
        { index: 0, uuid: CARD_LEFT },
        { index: 1, uuid: PACKSHOT_BUTTON },
        { index: 2, uuid: PACKSHOT_BUTTON },  // left behind by an earlier write to this slot
        { index: 3, uuid: ICON }              // left behind by a longer earlier array
    ];
    assert.notDeepEqual(projectAfterReload(serialized, overrides), live);

    const doomed = new Set(contradictedOverrides(live, overrides));
    assert.deepEqual([...doomed], [2, 3]);
    const kept = overrides.filter((_, position) => !doomed.has(position));
    assert.deepEqual(projectAfterReload(serialized, kept), live);
});

// ----- pairing serialized entries with the live nodes they came from ---------------------

/**
 * The scene as the serializer writes it: ordinary nodes carry `_id`, a prefab instance ROOT is a
 * stub with none, and its subtree is not in the file at all. Shapes taken from the real scene where
 * `WeedFlow.padCashShop` pointed at the `CashPad_Shop` instance root and was reported lost.
 */
function sceneObjects() {
    return [
        { __type__: 'cc.Scene', _id: 'scene-uuid', _children: [{ __id__: 1 }] },
        { __type__: 'cc.Node', _id: 'points-uuid', _name: 'InteractivePoints', _children: [{ __id__: 2 }, { __id__: 3 }] },
        { __type__: 'cc.Node', _id: 'plain-uuid', _name: 'Plain', _children: [] },
        // the instance root: no _id, no _name, no _children — identity lives in _prefab
        { __type__: 'cc.Node', _parent: { __id__: 1 }, _prefab: { __id__: 4 }, __editorExtras__: {} },
        { __type__: 'cc.PrefabInfo', fileId: '338ErnAkRKXL/BWr6q9Lzw', instance: { __id__: 5 } },
        { __type__: 'cc.PrefabInstance', fileId: 'b3OpleIppKkJ/NHDxzqUe+' }
    ];
}

const liveScene = () => ({
    uuid: 'scene-uuid',
    children: [{
        uuid: 'points-uuid',
        children: [
            { uuid: 'plain-uuid', children: [] },
            { uuid: 'cashpad-uuid', children: [{ uuid: 'inside-the-instance', children: [] }] }
        ]
    }]
});

test('a prefab instance root, which serializes without a uuid, is still named', () => {
    const map = liveNodesBySerializedIndex(sceneObjects(), 0, liveScene());
    assert.equal(map.get(3).uuid, 'cashpad-uuid');
    assert.equal(map.get(2).uuid, 'plain-uuid');
    assert.equal(map.get(1).uuid, 'points-uuid');
});

test('nothing inside the instance is claimed — the file does not carry it', () => {
    const map = liveNodesBySerializedIndex(sceneObjects(), 0, liveScene());
    assert.equal([...map.values()].some(node => node.uuid === 'inside-the-instance'), false);
});

test('a branch whose _id disagrees with the node it paired with is abandoned', () => {
    const objects = sceneObjects();
    objects[2]._id = 'somebody-else';
    const map = liveNodesBySerializedIndex(objects, 0, liveScene());
    assert.equal(map.has(2), false);
    // the sibling stub is unaffected: the walk drops the disagreeing branch, not the level
    assert.equal(map.get(3).uuid, 'cashpad-uuid');
});

test('no scene entry, or no live scene, yields an empty map rather than a guess', () => {
    assert.equal(liveNodesBySerializedIndex(sceneObjects(), -1, liveScene()).size, 0);
    assert.equal(liveNodesBySerializedIndex(sceneObjects(), 0, null).size, 0);
});

// ----- reading a reference back out of the serialized form -------------------------------

/**
 * `plainSerialized` is what the serializer verdict compares against the live component, so an
 * entry it cannot name is a write reported as one a save would drop. That is the second half of
 * the same blindness: the reference-write path paired the stub through the map above while this
 * one expanded it into a plain object, and `GameBootstrap.hero -> Characters/cc_hero` failed with
 * `write_not_persisted` while the `.scene` file held the link.
 */
const naming = (objects) => ({ nodes: liveNodesBySerializedIndex(objects, 0, liveScene()), unnamed: [] });

test('a reference to a prefab instance root is read as that root, not expanded as an object', () => {
    const objects = sceneObjects();
    const record = naming(objects);
    assert.deepEqual(plainSerialized(objects, { __id__: 3 }, 0, record), { uuid: 'cashpad-uuid' });
    assert.deepEqual(record.unnamed, []);
});

test('a reference to an ordinary node is still read off its own _id', () => {
    const objects = sceneObjects();
    assert.deepEqual(plainSerialized(objects, { __id__: 2 }, 0, naming(objects)), { uuid: 'plain-uuid' });
});

test('an instance root the pairing could not answer for is recorded, not reported as empty', () => {
    const objects = sceneObjects();
    const record = { nodes: new Map(), unnamed: [] };
    assert.deepEqual(plainSerialized(objects, { __id__: 3 }, 0, record), { uuid: null });
    assert.deepEqual(record.unnamed, [3]);
});

test('an entry that is not a node keeps being expanded', () => {
    const objects = sceneObjects();
    assert.deepEqual(plainSerialized(objects, { __id__: 5 }, 0, naming(objects)), { fileId: 'b3OpleIppKkJ/NHDxzqUe+' });
});

test('references nested in an array and an inline block are named the same way', () => {
    const objects = sceneObjects();
    const record = naming(objects);
    assert.deepEqual(
        plainSerialized(objects, { slots: [{ __id__: 3 }, { __id__: 2 }] }, 0, record),
        { slots: [{ uuid: 'cashpad-uuid' }, { uuid: 'plain-uuid' }] });
});
