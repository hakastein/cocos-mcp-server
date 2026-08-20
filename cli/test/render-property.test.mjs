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

test('a node reference prints as an address and a uuid', () => {
    assert.equal(
        formatReading(reading({ kind: 'nodeRef', value: 'node-hero' }), lookup),
        'Characters/cc_hero  node-hero');
});

test('a component reference names the class and the node carrying it', () => {
    assert.equal(
        formatReading(reading({ kind: 'componentRef', value: 'comp-grid' }), lookup),
        'NavGridProvider on Game/Enemies  comp-grid');
});

test('a reference missing from the index prints as a bare uuid', () => {
    assert.equal(formatReading(reading({ kind: 'nodeRef', value: 'node-gone' }), lookup), 'node-gone');
});

test('an unset reference prints as empty rather than as a lie about a uuid', () => {
    assert.equal(formatReading(reading({ kind: 'assetRef', value: null }), lookup), '(empty)');
});

test('an asset array prints element by element, each with its own db:// address', () => {
    assert.equal(
        formatReading(reading({ kind: 'assetRef', value: ['asset-mesh', null] }), lookup),
        '[db://assets/model/cc_scene.fbx  asset-mesh, (empty)]');
});

test('a color prints as hexadecimal rgba', () => {
    assert.equal(
        formatReading(reading({ kind: 'color', value: { r: 255, g: 128, b: 0, a: 200 } }), lookup),
        '#ff8000c8');
});

test('a vector prints by axis in x, y, z order rather than in key order', () => {
    assert.equal(
        formatReading(reading({ kind: 'vec', value: { z: 3, x: 1, y: 2 } }), lookup),
        '(1, 2, 3)');
});

test('an enum prints as a number and the member name', () => {
    assert.equal(
        formatReading(reading({ kind: 'enum', value: 1, label: 'PERSPECTIVE' }), lookup),
        '1 (PERSPECTIVE)');
});

test('a string prints quoted, so an empty one stays visible', () => {
    assert.equal(formatReading(reading({ value: '' }), lookup), '""');
    assert.equal(formatReading(reading({ value: 'backOut' }), lookup), '"backOut"');
});

test('the star marks only a drift from the default, never a missing verdict', () => {
    const text = renderComponentReading([
        reading({ name: 'waypointRadius', value: 0.7, differsFromDefault: true }),
        reading({ name: 'prewarm', value: 8, differsFromDefault: false }),
        reading({ name: 'fov', value: 45, differsFromDefault: null })
    ], lookup);
    const marked = text.split('\n').filter(line => line.includes('*'));
    assert.equal(marked.length, 1);
    assert.match(marked[0], /^waypointRadius/);
});

test('names and types line up in columns, with the value last', () => {
    const text = renderComponentReading([
        reading({ name: 'a', type: 'Number', value: 1 }),
        reading({ name: 'longer', type: 'Boolean', value: true })
    ], lookup);
    const [first, second] = text.split('\n');
    assert.equal(first.indexOf('Number'), second.indexOf('Boolean'));
    assert.ok(first.endsWith('1'));
    assert.ok(second.endsWith('true'));
});
