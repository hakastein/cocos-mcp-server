import test from 'node:test';
import assert from 'node:assert/strict';

import { scriptCidsInAssetText, verdictForCid } from '../dist/missing-scripts.js';

const DEAD_CID = '9fb48HdBvVH5r+06SDaDATr';
const DEAD_UUID = '9fb481dd-06f5-47e6-bfb4-e920da0c04eb';
const LIVE_CID = 'f4495HPHHJMDLKkcno3q1FR';

test('an absent script asset is the only case that reads as missing', () => {
    const verdict = verdictForCid(DEAD_CID, false);
    assert.equal(verdict.verdict, 'missing');
    assert.equal(verdict.scriptUuid, DEAD_UUID);
});

test('a script whose asset still exists is refused — a compile error deserializes every script as missing', () => {
    assert.equal(verdictForCid(LIVE_CID, true).verdict, 'script_exists');
});

test('a class id that is not a packed uuid cannot be proven absent', () => {
    const verdict = verdictForCid('cc.Sprite', null);
    assert.equal(verdict.verdict, 'unverifiable');
    assert.equal(verdict.scriptUuid, null);
});

test('a packed cid nobody looked up stays unverifiable rather than defaulting to missing', () => {
    assert.equal(verdictForCid(DEAD_CID, null).verdict, 'unverifiable');
});

test('script cids are lifted out of asset text and deduped, builtins ignored', () => {
    const text = JSON.stringify([
        { __type__: 'cc.Node' },
        { __type__: DEAD_CID },
        { __type__: 'cc.Sprite' },
        { __type__: DEAD_CID },
        { __type__: LIVE_CID }
    ]);
    assert.deepEqual(scriptCidsInAssetText(text), [DEAD_CID, LIVE_CID]);
});

test('a 23-char __type__ that is not packed-shaped is not taken for a script cid', () => {
    assert.deepEqual(scriptCidsInAssetText('{"__type__":"zzzzzNotAPackedCid12345"}'), []);
});
