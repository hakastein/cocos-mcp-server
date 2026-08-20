import test from 'node:test';
import assert from 'node:assert/strict';

import * as s from '../src/asset/settle.ts';

const { fingerprintOf, snapshotKey, settled, diffAssets, diffClasses, assetDiffEmpty } = s;

const asset = (over = {}) => ({
    uuid: 'u1', url: 'db://assets/a.ts', type: 'cc.Script', name: 'a', mtime: 100, imported: true, ...over
});

test('fingerprintOf turns a missing mtime into null, not into 0', () => {
    assert.equal(fingerprintOf(asset({ mtime: undefined })).mtime, null);
    assert.equal(fingerprintOf(asset({ mtime: 0 })).mtime, 0);
});

test('fingerprintOf reads a missing imported flag as not imported', () => {
    assert.equal(fingerprintOf(asset({ imported: undefined })).imported, false);
});

test('snapshotKey ignores the order the database listed the assets in', () => {
    const one = fingerprintOf(asset({ uuid: 'u1' }));
    const two = fingerprintOf(asset({ uuid: 'u2', url: 'db://assets/b.ts' }));
    assert.equal(
        snapshotKey({ assets: [one, two], classes: ['A'] }),
        snapshotKey({ assets: [two, one], classes: ['A'] }));
});

test('snapshotKey changes when an mtime changes', () => {
    const before = { assets: [fingerprintOf(asset())], classes: [] };
    const after = { assets: [fingerprintOf(asset({ mtime: 101 }))], classes: [] };
    assert.notEqual(snapshotKey(before), snapshotKey(after));
});

test('snapshotKey changes when an asset is still importing', () => {
    const before = { assets: [fingerprintOf(asset({ imported: false }))], classes: [] };
    const after = { assets: [fingerprintOf(asset({ imported: true }))], classes: [] };
    assert.notEqual(snapshotKey(before), snapshotKey(after));
});

test('snapshotKey tells an unanswered class list from an empty one', () => {
    assert.notEqual(
        snapshotKey({ assets: [], classes: null }),
        snapshotKey({ assets: [], classes: [] }));
});

test('snapshotKey changes when a component class registers', () => {
    assert.notEqual(
        snapshotKey({ assets: [], classes: ['A'] }),
        snapshotKey({ assets: [], classes: ['A', 'B'] }));
});

test('nothing sampled yet is not settled', () => {
    assert.equal(settled([], 1500), false);
});

test('a single sample is not settled while the quiet period is non-zero', () => {
    assert.equal(settled([{ key: 'k', ready: true, at: 1000 }], 1500), false);
});

test('a database reporting not ready is not settled however long the key held', () => {
    const samples = [
        { key: 'k', ready: true, at: 0 },
        { key: 'k', ready: true, at: 2000 },
        { key: 'k', ready: false, at: 4000 }
    ];
    assert.equal(settled(samples, 1500), false);
});

test('a key that held ready for the whole quiet period is settled', () => {
    const samples = [
        { key: 'old', ready: true, at: 0 },
        { key: 'k', ready: true, at: 400 },
        { key: 'k', ready: true, at: 1900 }
    ];
    assert.equal(settled(samples, 1500), true);
});

test('a key one poll short of the quiet period is not settled', () => {
    const samples = [
        { key: 'k', ready: true, at: 400 },
        { key: 'k', ready: true, at: 1899 }
    ];
    assert.equal(settled(samples, 1500), false);
});

test('a not-ready poll inside the run cuts the quiet period rather than being skipped over', () => {
    const samples = [
        { key: 'k', ready: true, at: 0 },
        { key: 'k', ready: false, at: 1000 },
        { key: 'k', ready: true, at: 1600 }
    ];
    assert.equal(settled(samples, 1500), false);
});

test('diffAssets reports an asset the database did not have before as added', () => {
    const after = fingerprintOf(asset({ uuid: 'new', url: 'db://assets/new.ts' }));
    assert.deepEqual(diffAssets([], [after]),
        { added: ['db://assets/new.ts'], removed: [], changed: [] });
});

test('diffAssets reports an asset the database no longer has as removed', () => {
    const before = fingerprintOf(asset());
    assert.deepEqual(diffAssets([before], []),
        { added: [], removed: ['db://assets/a.ts'], changed: [] });
});

test('a moved asset keeps its uuid, so it is one change and not a delete plus an add', () => {
    const before = fingerprintOf(asset({ url: 'db://assets/old/a.ts' }));
    const after = fingerprintOf(asset({ url: 'db://assets/new/a.ts' }));
    assert.deepEqual(diffAssets([before], [after]),
        { added: [], removed: [], changed: ['db://assets/new/a.ts'] });
});

test('diffAssets reports a rewritten file by its mtime', () => {
    assert.deepEqual(
        diffAssets([fingerprintOf(asset())], [fingerprintOf(asset({ mtime: 200 }))]),
        { added: [], removed: [], changed: ['db://assets/a.ts'] });
});

test('an untouched asset is reported neither changed nor anything else', () => {
    const same = fingerprintOf(asset());
    assert.deepEqual(diffAssets([same], [fingerprintOf(asset())]),
        { added: [], removed: [], changed: [] });
});

test('assetDiffEmpty holds only while every bucket is empty', () => {
    assert.equal(assetDiffEmpty({ added: [], removed: [], changed: [] }), true);
    assert.equal(assetDiffEmpty({ added: [], removed: [], changed: ['db://assets/a.ts'] }), false);
});

test('diffClasses names the class that registered and the one that went away', () => {
    assert.deepEqual(diffClasses(['A', 'Npc'], ['A', 'TargetPolicy']),
        { added: ['TargetPolicy'], removed: ['Npc'] });
});

test('an unanswered class list on either side leaves the delta unknown rather than empty', () => {
    assert.equal(diffClasses(null, ['A']), null);
    assert.equal(diffClasses(['A'], null), null);
});

test('diffClasses names a class once even when the editor listed it twice', () => {
    assert.deepEqual(diffClasses([], ['A', 'A']), { added: ['A'], removed: [] });
});
