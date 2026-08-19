/**
 * Дерево — форма, в которой сцена попадает в контекст агента. Вложенность заменяет parentUuid,
 * path и childCount, поэтому проверяется, что структура восстанавливается из плоского списка
 * в любом порядке, а неактивный узел помечен.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTree } from '../lib/render/tree.js';

const node = (uuid, name, parentUuid, components = [], active = true) =>
    ({ uuid, name, parentUuid, active, components: components.map(type => ({ type })) });

const scene = [
    node('u_canvas', 'Canvas', 'u_root', ['UITransform', 'Canvas']),
    node('u_bg', 'Bg', 'u_canvas', ['Sprite']),
    node('u_btn', 'Btn', 'u_canvas', ['Button'], false),
    node('u_label', 'Label', 'u_btn', ['Label'])
];

test('корнем становится узел, чьего родителя нет в списке', () => {
    const text = renderTree(scene);
    assert.match(text.split('\n')[0], /^Canvas/);
});

test('типы компонентов идут в скобках через запятую', () => {
    assert.match(renderTree(scene), /Canvas {2}\[UITransform,Canvas\]/);
});

test('неактивный узел помечен, активный — нет', () => {
    const text = renderTree(scene);
    assert.match(text, /Btn.*\(off\)/);
    assert.doesNotMatch(text.split('\n').find(l => l.includes('Bg')), /\(off\)/);
});

test('вложенность восстанавливается независимо от порядка в списке', () => {
    const shuffled = [scene[3], scene[1], scene[0], scene[2]];
    assert.equal(renderTree(shuffled).split('\n').length, renderTree(scene).split('\n').length);
    assert.match(renderTree(shuffled).split('\n')[0], /^Canvas/);
});

test('узел без компонентов идёт без скобок', () => {
    assert.match(renderTree([node('u_a', 'Empty', 'u_root')]), /^Empty$/m);
});

test('uuid показывается только когда его попросили', () => {
    assert.doesNotMatch(renderTree(scene), /u_canvas/);
    assert.match(renderTree(scene, { uuid: true }), /u_canvas/);
});

test('цикл в родителях не вешает рендер', () => {
    const cyclic = [
        node('r', 'R', 'missing'),
        node('a', 'A', 'r'),
        node('b', 'B', 'a'),
        node('a', 'A2', 'b')
    ];
    assert.equal(typeof renderTree(cyclic), 'string');
});

test('многокорневое дерево рендерится с правильным порядком', () => {
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
