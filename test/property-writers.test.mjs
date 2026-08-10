import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    WRITERS, writerFor, buildClassElement, buildClassPatch, readBackMatches, readBackMismatches
} from '../dist/property/writers.js';

const fixtures = JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/descriptors.json', import.meta.url)), 'utf8')
);

const PREFAB = '5965dcc0-7042-42a8-90ac-df7df5ede667';
const CLIP = '5965dcc0-7042-42a8-90ac-df7df5ede667';

function targetFor(name, overrides = {}) {
    const descriptor = fixtures[name];
    return {
        nodeUuid: 'node-1',
        componentType: 'TestComp',
        componentIndex: 2,
        propertyPath: descriptor.name || name,
        descriptor,
        ...overrides
    };
}

test('the writer order is the cascade order, declared in one array', () => {
    assert.deepEqual(WRITERS.map(writer => writer.name), [
        'gradient', 'curve', 'ui-transform-pair', 'class-array', 'nested-class',
        'asset-ref', 'node-ref', 'component-ref',
        'typed:color', 'typed:vec', 'typed:enum', 'typed:bitmask', 'typed:plain'
    ]);
});

test('every descriptor the editor emits is claimed by exactly one writer', () => {
    const claimed = {};
    for (const name of Object.keys(fixtures)) {
        const claimants = WRITERS.filter(writer => writer.claims(targetFor(name)));
        assert.equal(claimants.length, 1,
            `${name} was claimed by [${claimants.map(writer => writer.name).join(', ')}]`);
        claimed[name] = claimants[0].name;
    }
    assert.deepEqual(claimed, {
        number: 'typed:plain',
        string: 'typed:plain',
        boolean: 'typed:plain',
        vec3: 'typed:vec',
        vec2: 'typed:vec',
        size: 'typed:vec',
        color: 'typed:color',
        spriteFrame: 'asset-ref',
        emptySpriteFrame: 'asset-ref',
        materialArray: 'asset-ref',
        materialArrayDescriptorElements: 'asset-ref',
        nodeRef: 'node-ref',
        nodeArray: 'node-ref',
        nodeArrayDescriptorElements: 'node-ref',
        componentRef: 'component-ref',
        nestedClass: 'nested-class',
        classArray: 'class-array',
        assetClassArray: 'class-array',
        gradient: 'gradient',
        curve: 'curve',
        enum: 'typed:enum',
        bitmask: 'typed:bitmask'
    });
});

test('an array field reaches the same writer as its element, which then reads isArray itself', () => {
    assert.equal(writerFor(targetFor('materialArray')).name, writerFor(targetFor('spriteFrame')).name);
    assert.equal(writerFor(targetFor('nodeArray')).name, writerFor(targetFor('nodeRef')).name);
});

test('the UITransform pair is claimed by component and property, not by shape alone', () => {
    const pair = targetFor('size', { componentType: 'cc.UITransform', propertyPath: 'contentSize' });
    const underscored = targetFor('vec2', { componentType: 'cc.UITransform', propertyPath: '_anchorPoint' });
    const elsewhere = targetFor('size', { componentType: 'MyPanel', propertyPath: 'contentSize' });
    const otherVec = targetFor('vec3', { componentType: 'cc.UITransform', propertyPath: 'offset' });

    assert.equal(writerFor(pair).name, 'ui-transform-pair');
    assert.equal(writerFor(underscored).name, 'ui-transform-pair');
    assert.equal(writerFor(elsewhere).name, 'typed:vec');
    assert.equal(writerFor(otherVec).name, 'typed:vec');
});

test('a property with no descriptor still finds the plain writer', () => {
    const bare = { nodeUuid: 'node-1', componentType: 'TestComp', componentIndex: 0, propertyPath: 'speed', descriptor: {} };
    assert.equal(writerFor(bare).name, 'typed:plain');
});

test('a read-back that agrees produces no mismatch, numbers within 1e-5 included', () => {
    assert.deepEqual(readBackMismatches(0.5, 0.5000001), []);
    assert.deepEqual(readBackMismatches('backOut', 'backOut'), []);
    assert.deepEqual(readBackMismatches(null, null), []);
    assert.deepEqual(readBackMismatches(2, '2'), []);
    assert.equal(readBackMatches({ x: 1, y: 2 }, { x: 1, y: 2, z: 0 }), true);
});

test('a read-back that disagrees names the path, the request and what was read', () => {
    assert.deepEqual(readBackMismatches(1, 2, 'count'), ['count: expected 1, read 2']);
    assert.deepEqual(readBackMismatches(0.5, 0.51, 'enter.duration'),
        ['enter.duration: expected 0.5, read 0.51']);
    assert.deepEqual(readBackMismatches('uuid-a', null, 'prefab'),
        ['prefab: expected "uuid-a", read null']);
    assert.equal(readBackMatches(1, 2), false);
});

test('an array is compared by length and then element by element', () => {
    assert.deepEqual(readBackMismatches([1, 2], [1], 'waves'), ['waves: expected 2 element(s), read 1']);
    assert.deepEqual(readBackMismatches([1, 2], 7, 'waves'), ['waves: expected an array of 2, read 7']);
    assert.deepEqual(readBackMismatches([1, 2], [1, 3], 'waves'), ['waves.1: expected 2, read 3']);
});

test('only the members the write asked for are compared, so a patch is judged as a patch', () => {
    assert.deepEqual(readBackMismatches({ duration: 1.25 }, { duration: 1.25, easing: 'backOut' }), []);
    assert.deepEqual(readBackMismatches({ duration: 1.25 }, { duration: 2, easing: 'backOut' }, 'enter'),
        ['enter.duration: expected 1.25, read 2']);
    assert.deepEqual(readBackMismatches({ duration: 1 }, null, 'enter'),
        ['enter: expected {"duration":1}, read null']);
    assert.deepEqual(readBackMismatches(undefined, 'anything'), []);
});

test('a read-back the dump does not expose is a mismatch, not a silent pass', () => {
    assert.deepEqual(readBackMismatches('uuid-a', undefined, 'prefab'),
        ['prefab: expected "uuid-a", read undefined']);
});

test('a class array element keeps its references out of the inline dump and writes them by path', () => {
    const built = buildClassElement(
        fixtures.classArray.elementTypeData,
        { squads: [{ prefab: PREFAB, count: 5 }], spawnInterval: 1.5 },
        '__comps__.2.waves.0'
    );

    const squad = built.dump.value.squads.value[0];
    assert.equal('prefab' in squad.value, false);
    assert.equal(squad.value.count.value, 5);
    assert.deepEqual(built.refs, [
        { path: '__comps__.2.waves.0.squads.0.prefab', type: 'cc.Prefab', uuid: PREFAB }
    ]);
    assert.deepEqual(built.expected, {
        squads: [{ prefab: PREFAB, count: 5 }],
        spawnInterval: 1.5
    });
});

test('an element field the caller omitted takes the declared default, so an array is replaced whole', () => {
    const built = buildClassElement(fixtures.classArray.elementTypeData, {}, '__comps__.2.waves.0');
    assert.deepEqual(built.expected, { squads: [], spawnInterval: 0.8 });
    assert.deepEqual(built.refs, []);
});

test('an inline @ccclass is patched: untouched members keep their value, references leave the dump', () => {
    const patch = buildClassPatch(fixtures.nestedClass, { duration: 1.25, clip: CLIP }, '__comps__.1.enter');

    assert.equal('clip' in patch.dump.value, false);
    assert.equal(patch.dump.value.duration.value, 1.25);
    assert.equal(patch.dump.value.easing.value, 'backOut');
    assert.deepEqual(patch.refs, [
        { path: '__comps__.1.enter.clip', type: 'cc.AudioClip', uuid: CLIP }
    ]);
    assert.deepEqual(patch.expected, { duration: 1.25, clip: CLIP });
    assert.deepEqual(patch.unknown, []);
});

test('a member the class does not declare is named instead of written', () => {
    const patch = buildClassPatch(fixtures.nestedClass, { duration: 1, spin: 4 }, '__comps__.1.enter');
    assert.deepEqual(patch.unknown, ['spin']);
});
