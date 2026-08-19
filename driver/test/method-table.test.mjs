import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMethod } from '../lib/method-table.js';

const editor = {
    scene: { createNode: () => 'created', beginRecording: () => 'begun' },
    assetDb: { queryUuid: () => 'uuid' },
    builder: { addTask: () => 'task' },
    project: { queryConfig: () => 'config' }
};
const scene = { call: (method) => `scene:${method}` };

test('имя из пространства editor резолвится в функцию своей группы', () => {
    const fn = resolveMethod('editor.scene.createNode', editor, scene);
    assert.equal(typeof fn, 'function');
    assert.equal(fn(), 'created');
});

test('имя из пространства scene уходит в клиент scene-скрипта под своим именем', () => {
    const fn = resolveMethod('scene.dumpSceneNodes', editor, scene);
    assert.equal(fn(), 'scene:dumpSceneNodes');
});

test('имени вне списка 87 не соответствует ничего', () => {
    assert.equal(resolveMethod('editor.scene.deleteEverything', editor, scene), null);
    assert.equal(resolveMethod('scene.wipeProject', editor, scene), null);
    assert.equal(resolveMethod('editor.queryConfig', editor, scene), null);
});

test('обращение к прототипу не проходит, даже когда такое имя существует у объекта', () => {
    assert.equal(resolveMethod('editor.scene.constructor', editor, scene), null);
    assert.equal(resolveMethod('editor.__proto__.toString', editor, scene), null);
    assert.equal(resolveMethod('__proto__', editor, scene), null);
});

test('известное имя, для которого редактор не дал функции, тоже даёт null', () => {
    assert.equal(resolveMethod('editor.scene.saveScene', { scene: {} }, scene), null);
});
