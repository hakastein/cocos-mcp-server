/**
 * The tree is the shape a scene reaches an agent's context in. Nesting replaces parentUuid, path
 * and childCount, so what is checked is that the structure rebuilds from a flat list in any order
 * and that an inactive node is marked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTree } from '../src/render/tree.ts';

const node = (uuid, name, parentUuid, components = [], active = true) =>
    ({ uuid, name, parentUuid, active, components: components.map(className => ({ className })) });

const scene = [
    node('u_canvas', 'Canvas', 'u_root', ['UITransform', 'Canvas']),
    node('u_bg', 'Bg', 'u_canvas', ['Sprite']),
    node('u_btn', 'Btn', 'u_canvas', ['Button'], false),
    node('u_label', 'Label', 'u_btn', ['Label'])
];

test('a node whose parent is absent from the list becomes a root', () => {
    const text = renderTree(scene);
    assert.match(text.split('\n')[0], /^Canvas/);
});

test('the registered class name goes in brackets, comma-separated', () => {
    assert.match(renderTree(scene), /Canvas {2}\[UITransform,Canvas\]/);
});

test('an inactive node is marked and an active one is not', () => {
    const text = renderTree(scene);
    assert.match(text, /Btn.*\(off\)/);
    assert.doesNotMatch(text.split('\n').find(l => l.includes('Bg')), /\(off\)/);
});

test('nesting rebuilds regardless of the order in the list', () => {
    const shuffled = [scene[3], scene[1], scene[0], scene[2]];
    assert.equal(renderTree(shuffled).split('\n').length, renderTree(scene).split('\n').length);
    assert.match(renderTree(shuffled).split('\n')[0], /^Canvas/);
});

test('a node with no components goes without brackets', () => {
    assert.match(renderTree([node('u_a', 'Empty', 'u_root')]), /^Empty$/m);
});

test('a uuid shows only when it was asked for', () => {
    assert.doesNotMatch(renderTree(scene), /u_canvas/);
    assert.match(renderTree(scene, { uuid: true }), /u_canvas/);
});

test('a cycle in the parents does not hang the render', () => {
    const cyclic = [
        node('r', 'R', 'missing'),
        node('a', 'A', 'r'),
        node('b', 'B', 'a'),
        node('a', 'A2', 'b')
    ];
    assert.equal(typeof renderTree(cyclic), 'string');
});

test('a multi-root tree renders in the right order', () => {
    const multiRoot = [
        node('root1', 'Light', 'none1'),
        node('child1', 'SomeNode', 'root1'),
        node('root2', 'Camera', 'none2'),
        node('child2', 'AnotherNode', 'root2')
    ];
    const text = renderTree(multiRoot);
    const lines = text.split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^Light/);
    assert.match(lines[1], /SomeNode/);
    assert.match(lines[2], /^Camera/);
    assert.match(lines[3], /AnotherNode/);
});

test('same-named siblings are labelled #1, #2 — the resolver accepts a path off the tree', () => {
    const crowd = [
        node('u_root', 'gizmoRoot', 'u_scene'),
        node('u_i1', 'IconController', 'u_root'),
        node('u_i2', 'IconController', 'u_root'),
        node('u_solo', 'Grid', 'u_root')
    ];
    const lines = renderTree(crowd).split('\n');
    assert.match(lines[1], /IconController#1$/);
    assert.match(lines[2], /IconController#2$/);
    assert.match(lines[3], /Grid$/);
});

test('siblings are counted per child list, separately', () => {
    const twoParents = [
        node('u_root', 'Root', 'u_scene'),
        node('u_a', 'A', 'u_root'),
        node('u_b', 'B', 'u_root'),
        node('u_a1', 'Pad', 'u_a'),
        node('u_a2', 'Pad', 'u_a'),
        node('u_b1', 'Pad', 'u_b')
    ];
    const lines = renderTree(twoParents).split('\n');
    assert.match(lines[2], /Pad#1$/);
    assert.match(lines[3], /Pad#2$/);
    assert.match(lines[5], /Pad$/);
});

test('same-named roots count as one sibling list', () => {
    const roots = [
        node('u_1', 'Canvas', 'u_scene'),
        node('u_2', 'Canvas', 'u_scene')
    ];
    assert.deepEqual(renderTree(roots).split('\n'), ['Canvas#1', 'Canvas#2']);
});

test('an empty node list gives an empty string', () => {
    assert.equal(renderTree([]), '');
});
