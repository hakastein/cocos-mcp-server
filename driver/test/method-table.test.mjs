import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMethod } from '../src/method-table.ts';

const editor = {
    scene: { createNode: () => 'created', beginRecording: () => 'begun' },
    assetDb: { queryUuid: () => 'uuid' },
    builder: { addTask: () => 'task' },
    project: { queryConfig: () => 'config' }
};
const scene = { call: (method) => `scene:${method}` };

test('a name from the editor namespace resolves to a function of its group', () => {
    const fn = resolveMethod('editor.scene.createNode', editor, scene);
    assert.equal(typeof fn, 'function');
    assert.equal(fn(), 'created');
});

test('a name from the scene namespace goes to the scene-script client under that name', () => {
    const fn = resolveMethod('scene.dumpSceneNodes', editor, scene);
    assert.equal(fn(), 'scene:dumpSceneNodes');
});

test('a name outside the list of 87 matches nothing', () => {
    assert.equal(resolveMethod('editor.scene.deleteEverything', editor, scene), null);
    assert.equal(resolveMethod('scene.wipeProject', editor, scene), null);
    assert.equal(resolveMethod('editor.queryConfig', editor, scene), null);
});

test('reaching the prototype does not get through, even when the object has such a name', () => {
    assert.equal(resolveMethod('editor.scene.constructor', editor, scene), null);
    assert.equal(resolveMethod('editor.__proto__.toString', editor, scene), null);
    assert.equal(resolveMethod('__proto__', editor, scene), null);
});

test('a known name the editor gave no function for also yields null', () => {
    assert.equal(resolveMethod('editor.scene.saveScene', { scene: {} }, scene), null);
});
