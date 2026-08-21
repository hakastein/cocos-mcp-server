/**
 * The scene-vs-file comparison behind `scene dirty`.
 *
 * The editor's own dirty flag reports `_undoMgr.isDirty()`, which counts undo steps rather than
 * file contents: it stays set once a write has been undone by writing the old value back, and a
 * write the undo bracket did not carry never moves it. This walk is what answers instead, and its
 * two load-bearing behaviours are pinned here: the SceneAsset name is ignored, everything else is
 * not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { diffSerialized, BENIGN_DIFF_PATHS } from '../dist/serialized-diff.js';

const scene = (cellSize) => ([
    { __type__: 'cc.SceneAsset', _name: '', scene: { __id__: 1 } },
    { __type__: 'cc.Scene', _name: '2a', _children: [{ __id__: 2 }] },
    { __type__: 'NavGridProvider', cellSize }
]);

test('a saved scene and its file compare equal', () => {
    const live = scene(0.4);
    const disk = scene(0.4);
    disk[0]._name = '2a';
    assert.deepEqual(diffSerialized(live, disk), []);
});

test('the SceneAsset name the importer fills in is the only ignored path', () => {
    assert.deepEqual(BENIGN_DIFF_PATHS, ['.0._name']);
    const live = scene(0.4);
    const disk = scene(0.4);
    disk[0]._name = '2a';
    disk[1]._name = 'renamed';
    assert.deepEqual(diffSerialized(live, disk).map(d => d.path), ['.1._name']);
});

test('the property write that the editor reported as clean is found', () => {
    const live = scene(0.4);
    const disk = scene(0.2);
    disk[0]._name = '2a';
    const diffs = diffSerialized(live, disk);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].path, '.2.cellSize');
    assert.equal(diffs[0].live, '0.4');
    assert.equal(diffs[0].disk, '0.2');
});

test('a key present on one side only is a difference, not a skipped entry', () => {
    const live = [{ a: 1, added: true }];
    const disk = [{ a: 1 }];
    assert.deepEqual(diffSerialized(live, disk, []), [
        { path: '.0.added', live: 'true', disk: 'undefined' }
    ]);
});

test('null against an object is a difference rather than a walk into null', () => {
    assert.deepEqual(diffSerialized([{ node: null }], [{ node: { __id__: 3 } }], []), [
        { path: '.0.node', live: 'null', disk: '{"__id__":3}' }
    ]);
});

test('a wholesale mismatch stops at the limit instead of reporting every entry', () => {
    const live = Array.from({ length: 50 }, (_, i) => ({ v: i }));
    const disk = Array.from({ length: 50 }, (_, i) => ({ v: i + 1 }));
    assert.equal(diffSerialized(live, disk, [], 20).length, 20);
    assert.equal(diffSerialized(live, disk, [], 3).length, 3);
});

test('a long value is briefed, so one differing array cannot flood the report', () => {
    const long = Array.from({ length: 200 }, (_, i) => i);
    const [diff] = diffSerialized([{ ids: long }], [{ ids: 'x' }], []);
    assert.equal(diff.path, '.0.ids');
    assert.equal(diff.live.length, 120);
});
