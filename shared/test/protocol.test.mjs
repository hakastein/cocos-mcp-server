/**
 * Список методов — это и есть граница драйвера: всё, чего в нём нет, наружу не проходит.
 * Проверяется размер обоих пространств, отсутствие дублей и то, что резолвер имени
 * отвергает чужое.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EDITOR_METHODS, SCENE_METHODS, ALL_METHODS, isKnownMethod } from '../dist/protocol.js';

test('пространство editor держит ровно 58 методов, без дублей', () => {
    assert.equal(EDITOR_METHODS.length, 58);
    assert.equal(new Set(EDITOR_METHODS).size, 58);
});

test('пространство scene держит ровно 30 методов, без дублей', () => {
    assert.equal(SCENE_METHODS.length, 30);
    assert.equal(new Set(SCENE_METHODS).size, 30);
});

test('каждое имя editor несёт группу через точку, имена scene — плоские', () => {
    for (const name of EDITOR_METHODS) {
        assert.match(name, /^(scene|assetDb|builder|project)\.[a-zA-Z]+$/, name);
    }
    for (const name of SCENE_METHODS) assert.doesNotMatch(name, /\./, name);
});

test('общий список — объединение обоих с префиксами пространств', () => {
    assert.equal(ALL_METHODS.length, 88);
    assert.ok(ALL_METHODS.includes('editor.scene.createNode'));
    assert.ok(ALL_METHODS.includes('scene.dumpSceneNodes'));
});

test('имя вне списка не признаётся, включая правдоподобное', () => {
    assert.equal(isKnownMethod('editor.scene.createNode'), true);
    assert.equal(isKnownMethod('scene.dumpSceneNodes'), true);
    assert.equal(isKnownMethod('editor.scene.deleteEverything'), false);
    assert.equal(isKnownMethod('scene.evalInScene '), false);
    assert.equal(isKnownMethod('__proto__'), false);
});
