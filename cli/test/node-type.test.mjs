import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyNode, LAYER_UI_2D } from '../src/node-type.ts';

test('a ScrollView-only node is 2D and the reasons say which component decided it', () => {
    const verdict = classifyNode(['cc.ScrollView']);
    assert.equal(verdict.nodeType, '2d');
    assert.deepEqual(verdict.reasons, ['Has 2D/UI components: cc.ScrollView']);
});

test('a node with no components and no UI layer is 3D, and says why', () => {
    const verdict = classifyNode([]);
    assert.equal(verdict.nodeType, '3d');
    assert.deepEqual(verdict.reasons,
        ['No 2D/UI signals found; treated as a 3D node (full x/y/z transform)']);
});

test('a mesh renderer makes a node 3D and is named as the reason', () => {
    const verdict = classifyNode(['cc.MeshRenderer']);
    assert.equal(verdict.nodeType, '3d');
    assert.deepEqual(verdict.reasons, ['Has 3D components: cc.MeshRenderer']);
});

test('every light class counts as a 3D signal', () => {
    const verdict = classifyNode(['cc.DirectionalLight']);
    assert.equal(verdict.nodeType, '3d');
    assert.deepEqual(verdict.reasons, ['Has 3D components: cc.DirectionalLight']);
});

test('the UI_2D layer decides a node that carries no deciding component', () => {
    const verdict = classifyNode(['MyGameplayScript'], LAYER_UI_2D);
    assert.equal(verdict.nodeType, '2d');
    assert.deepEqual(verdict.reasons, ['Node is on the UI_2D layer (2D)']);
});

test('a UI component outranks a 3D one on the same node, and both are reported', () => {
    const verdict = classifyNode(['cc.Sprite', 'cc.Camera']);
    assert.equal(verdict.nodeType, '2d');
    assert.deepEqual(verdict.reasons, [
        'Has 2D/UI components: cc.Sprite',
        'Has 3D components: cc.Camera'
    ]);
});

test('cc.SpriteRenderer is a 3D renderer, not the 2D cc.Sprite it is spelled after', () => {
    const verdict = classifyNode(['cc.SpriteRenderer']);
    assert.equal(verdict.nodeType, '3d');
});
