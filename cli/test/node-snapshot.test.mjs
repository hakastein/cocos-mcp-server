import test from 'node:test';
import assert from 'node:assert/strict';

import * as s from '../src/node-snapshot.ts';

const { nodeSnapshotOf, nodePropertyOf, LAYER_DEFAULT } = s;

const dump = (over = {}) => ({
    uuid: { value: 'u-1' },
    name: { value: 'Guard' },
    active: { value: true },
    position: { value: { x: 1, y: 2, z: 3 } },
    rotation: { value: { x: 0, y: 90, z: 0 } },
    scale: { value: { x: 1, y: 1, z: 1 } },
    parent: { value: { uuid: 'parent-1' } },
    layer: { value: 1 },
    __comps__: [],
    ...over
});

test('a dump that is not an object yields no snapshot rather than a hollow one', () => {
    assert.equal(nodeSnapshotOf(null, 'u-1'), null);
    assert.equal(nodeSnapshotOf('nope', 'u-1'), null);
});

test('the snapshot unwraps the descriptor values the editor wraps everything in', () => {
    const snapshot = nodeSnapshotOf(dump(), 'fallback');
    assert.equal(snapshot.uuid, 'u-1');
    assert.equal(snapshot.name, 'Guard');
    assert.equal(snapshot.active, true);
    assert.deepEqual(snapshot.position, { x: 1, y: 2, z: 3 });
    assert.equal(snapshot.parent, 'parent-1');
    assert.equal(snapshot.layer, 1);
});

test('the caller uuid stands in when the dump carries none', () => {
    assert.equal(nodeSnapshotOf(dump({ uuid: undefined }), 'fallback').uuid, 'fallback');
});

test('a node with no parent descriptor is a root, not a node parented to undefined', () => {
    assert.equal(nodeSnapshotOf(dump({ parent: { value: null } }), 'u-1').parent, null);
});

test('a missing active reads as on, matching the engine default', () => {
    assert.equal(nodeSnapshotOf(dump({ active: undefined }), 'u-1').active, true);
});

test('a missing layer falls back to the engine default rather than to zero', () => {
    assert.equal(nodeSnapshotOf(dump({ layer: undefined }), 'u-1').layer, LAYER_DEFAULT);
});

test('a missing scale falls back to one, not to zero', () => {
    assert.deepEqual(nodeSnapshotOf(dump({ scale: undefined }), 'u-1').scale, { x: 1, y: 1, z: 1 });
});

test('a half-written vector keeps the axes it does carry', () => {
    assert.deepEqual(
        nodeSnapshotOf(dump({ position: { value: { x: 5 } } }), 'u-1').position,
        { x: 5, y: 0, z: 0 });
});

test('components come through under their registered class names', () => {
    const snapshot = nodeSnapshotOf(dump({
        __comps__: [{ type: 'cc.MeshRenderer' }, { type: 'cc.UITransform' }]
    }), 'u-1');
    assert.deepEqual(snapshot.componentTypes, ['cc.MeshRenderer', 'cc.UITransform']);
});

test('nodePropertyOf reads back the same field the write named', () => {
    const snapshot = nodeSnapshotOf(dump(), 'u-1');
    assert.equal(nodePropertyOf(snapshot, 'name'), 'Guard');
    assert.equal(nodePropertyOf(snapshot, 'active'), true);
    assert.equal(nodePropertyOf(snapshot, 'layer'), 1);
});
