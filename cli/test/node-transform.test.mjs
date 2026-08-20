import test from 'node:test';
import assert from 'node:assert/strict';

import * as t from '../src/node-transform.ts';

const { parseVec3, normalizedTransform, sameVec3 } = t;

test('parseVec3 reads all three axes', () => {
    assert.deepEqual(parseVec3('1,2,3'), { x: 1, y: 2, z: 3 });
});

test('an empty axis is left out, so it keeps its value instead of being set to zero', () => {
    assert.deepEqual(parseVec3('1,,3'), { x: 1, z: 3 });
    assert.deepEqual(parseVec3('1,0,3'), { x: 1, y: 0, z: 3 });
});

test('a negative and a fractional axis both parse', () => {
    assert.deepEqual(parseVec3('-1.5, 2 ,0'), { x: -1.5, y: 2, z: 0 });
});

test('a vector without three parts is refused rather than half-read', () => {
    assert.throws(() => parseVec3('1,2'), /x,y,z/);
    assert.throws(() => parseVec3('1,2,3,4'), /x,y,z/);
});

test('a non-numeric axis is named rather than silently becoming NaN', () => {
    assert.throws(() => parseVec3('1,two,3'), /axis y/);
});

test('an axis the caller left out keeps the value the node already has', () => {
    const current = { x: 7, y: 8, z: 9 };
    assert.deepEqual(normalizedTransform({ x: 1 }, current, 'position', '3d').value,
        { x: 1, y: 8, z: 9 });
});

test('a 3d node keeps every axis it was given, with no warning', () => {
    const written = normalizedTransform({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 0 }, 'position', '3d');
    assert.deepEqual(written.value, { x: 1, y: 2, z: 3 });
    assert.equal(written.warning, undefined);
});

test('a 2d node forces z of position to zero and says so when z was asked for', () => {
    const written = normalizedTransform({ x: 1, z: 5 }, { x: 0, y: 0, z: 0 }, 'position', '2d');
    assert.equal(written.value.z, 0);
    assert.match(written.warning, /position z \(5\)/);
});

test('a 2d node warns when the write silently zeroes a z it was not asked about', () => {
    const written = normalizedTransform({ x: 1 }, { x: 0, y: 0, z: 4 }, 'position', '2d');
    assert.equal(written.value.z, 0);
    assert.match(written.warning, /was 4/);
});

test('a 2d node whose z was already zero gets no warning about it', () => {
    const written = normalizedTransform({ x: 1 }, { x: 0, y: 0, z: 0 }, 'position', '2d');
    assert.equal(written.warning, undefined);
});

test('a 2d node keeps only z of rotation', () => {
    const written = normalizedTransform({ x: 30, y: 40, z: 50 }, { x: 0, y: 0, z: 0 }, 'rotation', '2d');
    assert.deepEqual(written.value, { x: 0, y: 0, z: 50 });
    assert.match(written.warning, /rotation x,y/);
});

test('scale is untouched on a 2d node — it is the one transform 2d keeps whole', () => {
    const written = normalizedTransform({ x: 2, y: 3, z: 4 }, { x: 1, y: 1, z: 1 }, 'scale', '2d');
    assert.deepEqual(written.value, { x: 2, y: 3, z: 4 });
    assert.equal(written.warning, undefined);
});

test('sameVec3 tolerates float noise but not a real difference', () => {
    assert.equal(sameVec3({ x: 1, y: 2, z: 3 }, { x: 1.0001, y: 2, z: 3 }), true);
    assert.equal(sameVec3({ x: 1, y: 2, z: 3 }, { x: 1.01, y: 2, z: 3 }), false);
});
