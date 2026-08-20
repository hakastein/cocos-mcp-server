/**
 * The method list is the driver's boundary: anything absent from it never gets through. Checked
 * here: the size of both namespaces, the absence of duplicates, and that the name resolver rejects
 * what does not belong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EDITOR_METHODS, SCENE_METHODS, ALL_METHODS, isKnownMethod } from '../dist/protocol.js';

test('the editor namespace holds exactly 58 methods, with no duplicates', () => {
    assert.equal(EDITOR_METHODS.length, 58);
    assert.equal(new Set(EDITOR_METHODS).size, 58);
});

test('the scene namespace holds exactly 31 methods, with no duplicates', () => {
    assert.equal(SCENE_METHODS.length, 31);
    assert.equal(new Set(SCENE_METHODS).size, 31);
});

test('every editor name carries a group through a dot, scene names are flat', () => {
    for (const name of EDITOR_METHODS) {
        assert.match(name, /^(scene|assetDb|builder|project)\.[a-zA-Z]+$/, name);
    }
    for (const name of SCENE_METHODS) assert.doesNotMatch(name, /\./, name);
});

test('the combined list is the union of both with their namespace prefixes', () => {
    assert.equal(ALL_METHODS.length, 89);
    assert.ok(ALL_METHODS.includes('editor.scene.createNode'));
    assert.ok(ALL_METHODS.includes('scene.dumpSceneNodes'));
});

test('a name outside the list is not recognized, plausible ones included', () => {
    assert.equal(isKnownMethod('editor.scene.createNode'), true);
    assert.equal(isKnownMethod('scene.dumpSceneNodes'), true);
    assert.equal(isKnownMethod('editor.scene.deleteEverything'), false);
    assert.equal(isKnownMethod('scene.evalInScene '), false);
    assert.equal(isKnownMethod('__proto__'), false);
});
