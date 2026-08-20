import test from 'node:test';
import assert from 'node:assert/strict';

import { formatReading, renderComponentReading } from '../lib/render/property.js';

const LABELS = {
    'node-hero': { kind: 'node', path: 'Characters/cc_hero' },
    'comp-grid': { kind: 'component', path: 'Game/Enemies', className: 'NavGridProvider' },
    'asset-mesh': { kind: 'asset', path: 'db://assets/model/cc_scene.fbx' }
};
const lookup = uuid => LABELS[uuid];

const reading = (over = {}) => ({
    name: 'prop', type: 'Number', kind: 'plain', value: 1, label: null,
    differsFromDefault: null, hiddenInInspector: false, ...over
});

test('ссылка на узел печатается адресом и uuid', () => {
    assert.equal(
        formatReading(reading({ kind: 'nodeRef', value: 'node-hero' }), lookup),
        'Characters/cc_hero  node-hero');
});

test('ссылка на компонент называет класс и узел, на котором он висит', () => {
    assert.equal(
        formatReading(reading({ kind: 'componentRef', value: 'comp-grid' }), lookup),
        'NavGridProvider на Game/Enemies  comp-grid');
});

test('ссылка, которой нет в индексе, печатается голым uuid', () => {
    assert.equal(formatReading(reading({ kind: 'nodeRef', value: 'node-gone' }), lookup), 'node-gone');
});

test('невыставленная ссылка печатается как пусто, а не как ложь про uuid', () => {
    assert.equal(formatReading(reading({ kind: 'assetRef', value: null }), lookup), '(пусто)');
});

test('массив ассетов печатается поэлементно, каждый со своим db:// адресом', () => {
    assert.equal(
        formatReading(reading({ kind: 'assetRef', value: ['asset-mesh', null] }), lookup),
        '[db://assets/model/cc_scene.fbx  asset-mesh, (пусто)]');
});

test('цвет печатается шестнадцатеричным rgba', () => {
    assert.equal(
        formatReading(reading({ kind: 'color', value: { r: 255, g: 128, b: 0, a: 200 } }), lookup),
        '#ff8000c8');
});

test('вектор печатается по осям в порядке x, y, z, а не в порядке ключей', () => {
    assert.equal(
        formatReading(reading({ kind: 'vec', value: { z: 3, x: 1, y: 2 } }), lookup),
        '(1, 2, 3)');
});

test('enum печатается числом и именем члена', () => {
    assert.equal(
        formatReading(reading({ kind: 'enum', value: 1, label: 'PERSPECTIVE' }), lookup),
        '1 (PERSPECTIVE)');
});

test('строка печатается в кавычках, чтобы пустая была видна', () => {
    assert.equal(formatReading(reading({ value: '' }), lookup), '""');
    assert.equal(formatReading(reading({ value: 'backOut' }), lookup), '"backOut"');
});

test('звёздочкой отмечено только расхождение с умолчанием, но не отсутствие вердикта', () => {
    const text = renderComponentReading([
        reading({ name: 'waypointRadius', value: 0.7, differsFromDefault: true }),
        reading({ name: 'prewarm', value: 8, differsFromDefault: false }),
        reading({ name: 'fov', value: 45, differsFromDefault: null })
    ], lookup);
    const marked = text.split('\n').filter(line => line.includes('*'));
    assert.equal(marked.length, 1);
    assert.match(marked[0], /^waypointRadius/);
});

test('имена и типы выровнены в колонки, значение идёт последним', () => {
    const text = renderComponentReading([
        reading({ name: 'a', type: 'Number', value: 1 }),
        reading({ name: 'longer', type: 'Boolean', value: true })
    ], lookup);
    const [first, second] = text.split('\n');
    assert.equal(first.indexOf('Number'), second.indexOf('Boolean'));
    assert.ok(first.endsWith('1'));
    assert.ok(second.endsWith('true'));
});
