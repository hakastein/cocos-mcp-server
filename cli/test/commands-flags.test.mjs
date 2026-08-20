import test from 'node:test';
import assert from 'node:assert/strict';

import { booleanFlag, jsonFlag, numberFlag, vec3Flag, vec3PartsFlag } from '../src/commands/flags.ts';

test('a flag nobody typed stays undefined rather than becoming a value', () => {
    assert.equal(booleanFlag('--active', undefined), undefined);
    assert.equal(numberFlag('--layer', undefined), undefined);
    assert.equal(vec3Flag('--pos', undefined), undefined);
    assert.equal(vec3PartsFlag('--pos', undefined), undefined);
});

test('--active takes the two words it documents', () => {
    assert.equal(booleanFlag('--active', 'true'), true);
    assert.equal(booleanFlag('--active', 'false'), false);
});

test('a word that is neither is refused, naming the flag and quoting what was typed', () => {
    assert.throws(() => booleanFlag('--active', 'yes'), /--active takes true or false; got "yes"/);
});

test('a number flag answers the number', () => {
    assert.equal(numberFlag('--layer', '33554432'), 33554432);
    assert.equal(numberFlag('--max', '0'), 0);
});

// `Number('')` and `Number(' ')` are both 0, so an empty flag would silently write layer 0.
test('an empty number flag is refused rather than read as zero', () => {
    assert.throws(() => numberFlag('--layer', ''), /--layer takes a number; got ""/);
    assert.throws(() => numberFlag('--layer', ' '), /--layer takes a number/);
});

test('a number flag that is not a number is refused, naming the flag', () => {
    assert.throws(() => numberFlag('--layer', 'ui'), /--layer takes a number; got "ui"/);
});

test('an empty axis keeps its value where there is a value to keep', () => {
    assert.deepEqual(vec3PartsFlag('--pos', '1,,3'), { x: 1, z: 3 });
});

test('a vector spelled with the wrong number of axes names the flag it came from', () => {
    assert.throws(() => vec3PartsFlag('--pos', '1,2'), /--pos/);
    assert.throws(() => vec3PartsFlag('--rot', '1,2'), /--rot/);
});

test('a whole vector takes all three axes', () => {
    assert.deepEqual(vec3Flag('--pos', '1,2,3'), { x: 1, y: 2, z: 3 });
});

// A node being created has no previous position, so an empty axis has nothing to keep and would
// otherwise reach the editor as undefined.
test('an empty axis in a whole vector is refused, naming the axis left out', () => {
    assert.throws(() => vec3Flag('--pos', '1,,3'), /--pos.*y/s);
});

test('a whole vector refuses an axis that is not a number instead of writing NaN', () => {
    assert.throws(() => vec3Flag('--pos', '1,up,3'), /--pos/);
});

test('a value flag reads JSON when the text is JSON', () => {
    assert.equal(jsonFlag('42'), 42);
    assert.equal(jsonFlag('true'), true);
    assert.equal(jsonFlag('null'), null);
    assert.deepEqual(jsonFlag('{"hp":3}'), { hp: 3 });
    assert.deepEqual(jsonFlag('[1,2]'), [1, 2]);
});

test('text that is not JSON is the string that was typed', () => {
    assert.equal(jsonFlag('Ready'), 'Ready');
    assert.equal(jsonFlag('db://assets/a.png'), 'db://assets/a.png');
});
