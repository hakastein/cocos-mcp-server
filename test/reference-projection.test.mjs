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

import { projectAfterReload, contradictedOverrides } from '../dist/reference-projection.js';

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
