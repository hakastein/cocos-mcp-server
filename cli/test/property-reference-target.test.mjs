import test from 'node:test';
import assert from 'node:assert/strict';

import { referenceRequest, spellingOf } from '../lib/property/reference-target.js';

test('a db:// path reads as an address in the asset database', () => {
    assert.deepEqual(spellingOf('db://assets/ui/icon.png/spriteFrame'),
        { kind: 'assetUrl', url: 'db://assets/ui/icon.png/spriteFrame' });
});

test('a compressed node uuid is told apart from a node name', () => {
    assert.deepEqual(spellingOf('255rIRyPxOX5xNSUYxZLLP'), { kind: 'uuid', uuid: '255rIRyPxOX5xNSUYxZLLP' });
});

test('a full asset uuid reads as a uuid rather than as a path', () => {
    assert.deepEqual(spellingOf('0ba73f57-eedc-484a-89e4-20aeef0b73fc'),
        { kind: 'uuid', uuid: '0ba73f57-eedc-484a-89e4-20aeef0b73fc' });
});

test('a sub-asset after the at-sign stays a uuid', () => {
    assert.equal(spellingOf('0ba73f57-eedc-484a-89e4-20aeef0b73fc@f9941').kind, 'uuid');
});

// The compressed-uuid alphabet includes `/`, so length alone is not enough: a path of that same length is a path.
test('a path exactly as long as a compressed uuid stays a path because of the slash', () => {
    assert.deepEqual(spellingOf('Characters/cc_hero1234'),
        { kind: 'nodePath', path: 'Characters/cc_hero1234' });
});

test('an ordinary node name is a path', () => {
    assert.deepEqual(spellingOf('char_hero'), { kind: 'nodePath', path: 'char_hero' });
});

test('null clears the field: no targets and no array claimed', () => {
    assert.deepEqual(referenceRequest(null), { targets: [], array: false });
});

test('an empty string clears the field the same way null does', () => {
    assert.deepEqual(referenceRequest(''), { targets: [], array: false });
});

test('an array is passed as an array, with every element parsed on its own', () => {
    assert.deepEqual(referenceRequest(['char_hero', '255rIRyPxOX5xNSUYxZLLP']), {
        array: true,
        targets: [
            { kind: 'nodePath', path: 'char_hero' },
            { kind: 'uuid', uuid: '255rIRyPxOX5xNSUYxZLLP' }
        ]
    });
});

test('an empty array clears an array field while staying an array', () => {
    assert.deepEqual(referenceRequest([]), { targets: [], array: true });
});

test('an object carrying a uuid is the shape --json answers a reference in', () => {
    assert.deepEqual(referenceRequest({ uuid: 'u1' }), {
        targets: [{ kind: 'uuid', uuid: 'u1' }],
        array: false
    });
});

test('a number cannot be a reference — refused rather than guessed', () => {
    const answer = referenceRequest(42);
    assert.ok('error' in answer);
    assert.match(answer.error, /42/);
});

test('one bad element drops the whole array instead of writing it partially', () => {
    const answer = referenceRequest(['char_hero', true]);
    assert.ok('error' in answer);
});
