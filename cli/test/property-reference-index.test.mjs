import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReferenceIndex, referencedUuids } from '../src/property/reference-index.ts';

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

test('a node is indexed by its address in the scene', () => {
    assert.deepEqual(buildReferenceIndex(nodes()).get('node-hero'), {
        kind: 'node', path: 'Characters/cc_hero'
    });
});

test('a component is indexed by the node address and its own class', () => {
    assert.deepEqual(buildReferenceIndex(nodes()).get('comp-root'), {
        kind: 'component', path: 'Game', className: 'GameRoot'
    });
});

test('a component with no registered name falls back to the JS class name', () => {
    assert.equal(buildReferenceIndex(nodes()).get('comp-boot').className, 'GameBootstrap');
});

test('a node with no address is called by its name', () => {
    const index = buildReferenceIndex([{ uuid: 'node-x', name: 'Loose', path: '' }]);
    assert.equal(index.get('node-x').path, 'Loose');
});

test('scene references and asset references go into separate lists', () => {
    const wanted = referencedUuids([
        reading('nodeRef', 'node-hero'),
        reading('componentRef', 'comp-root'),
        reading('assetRef', 'asset-mesh')
    ]);
    assert.deepEqual(wanted.scene, ['node-hero', 'comp-root']);
    assert.deepEqual(wanted.assets, ['asset-mesh']);
});

test('an array of references is unrolled, with repeats and empty slots dropped', () => {
    const wanted = referencedUuids([
        reading('assetRef', ['asset-a', 'asset-b', 'asset-a', null, ''])
    ]);
    assert.deepEqual(wanted.assets, ['asset-a', 'asset-b']);
});

test('an ordinary value does not count as a reference', () => {
    const wanted = referencedUuids([reading('plain', 'looks-like-a-uuid'), reading('enum', 1)]);
    assert.deepEqual(wanted, { scene: [], assets: [] });
});
