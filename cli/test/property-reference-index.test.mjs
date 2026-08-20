import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReferenceIndex, referencedUuids } from '../lib/property/reference-index.js';

const nodes = () => [
    {
        uuid: 'node-game', name: 'Game', path: 'Game',
        components: [
            { uuid: 'comp-root', className: 'GameRoot', type: 'GameRoot' },
            { uuid: 'comp-boot', className: '', type: 'GameBootstrap' }
        ]
    },
    { uuid: 'node-hero', name: 'cc_hero', path: 'Characters/cc_hero', components: [] }
];

const reading = (kind, value) => ({ name: 'ref', type: '', kind, value, label: null });

test('узел индексируется по своему адресу в сцене', () => {
    assert.deepEqual(buildReferenceIndex(nodes()).get('node-hero'), {
        kind: 'node', path: 'Characters/cc_hero'
    });
});

test('компонент индексируется адресом узла и своим классом', () => {
    assert.deepEqual(buildReferenceIndex(nodes()).get('comp-root'), {
        kind: 'component', path: 'Game', className: 'GameRoot'
    });
});

test('зарегистрированного имени у компонента нет — берётся имя класса JS', () => {
    assert.equal(buildReferenceIndex(nodes()).get('comp-boot').className, 'GameBootstrap');
});

test('узел без адреса зовётся своим именем', () => {
    const index = buildReferenceIndex([{ uuid: 'node-x', name: 'Loose', path: '' }]);
    assert.equal(index.get('node-x').path, 'Loose');
});

test('ссылки на сцену и на ассеты разведены по разным спискам', () => {
    const wanted = referencedUuids([
        reading('nodeRef', 'node-hero'),
        reading('componentRef', 'comp-root'),
        reading('assetRef', 'asset-mesh')
    ]);
    assert.deepEqual(wanted.scene, ['node-hero', 'comp-root']);
    assert.deepEqual(wanted.assets, ['asset-mesh']);
});

test('массив ссылок разворачивается, повторы и пустые слоты отбрасываются', () => {
    const wanted = referencedUuids([
        reading('assetRef', ['asset-a', 'asset-b', 'asset-a', null, ''])
    ]);
    assert.deepEqual(wanted.assets, ['asset-a', 'asset-b']);
});

test('обычное значение ссылкой не считается', () => {
    const wanted = referencedUuids([reading('plain', 'похоже-на-uuid'), reading('enum', 1)]);
    assert.deepEqual(wanted, { scene: [], assets: [] });
});
