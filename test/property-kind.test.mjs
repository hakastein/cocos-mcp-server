import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveKind } from '../dist/property/kind.js';
import { projectValue, projectDescriptor } from '../dist/property/readers.js';

const fixtures = JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/descriptors.json', import.meta.url)), 'utf8')
);

const SPRITE_FRAME = '8f4d0a80-1e5c-4a2b-9c31-6b5f2a7de011';
const PREFAB = '5965dcc0-7042-42a8-90ac-df7df5ede667';
const CLIP = '5965dcc0-7042-42a8-90ac-df7df5ede667';

test('every descriptor shape the editor emits resolves to its kind', () => {
    const expected = {
        number: 'plain',
        string: 'plain',
        boolean: 'plain',
        vec3: 'vec',
        vec2: 'vec',
        size: 'vec',
        color: 'color',
        spriteFrame: 'assetRef',
        emptySpriteFrame: 'assetRef',
        materialArray: 'assetRef',
        nodeRef: 'nodeRef',
        nodeArray: 'nodeRef',
        componentRef: 'componentRef',
        nestedClass: 'nestedClass',
        classArray: 'classArray',
        assetClassArray: 'classArray',
        gradient: 'gradient',
        curve: 'curve',
        enum: 'enum',
        bitmask: 'bitmask'
    };
    const resolved = Object.fromEntries(
        Object.keys(expected).map(name => [name, resolveKind(fixtures[name])])
    );
    assert.deepEqual(resolved, expected);
});

test('a gradient and a curve are named before the structural nested-class check sees them', () => {
    // both dump a map of field descriptors, which is exactly what a nested @ccclass looks like
    const gradientMembers = Object.keys(fixtures.gradient.value);
    assert.deepEqual(gradientMembers, ['mode', 'color', 'gradient']);
    assert.equal(resolveKind({ type: 'cc.Gradient', value: fixtures.gradient.value.gradient.value }), 'gradient');
    assert.equal(resolveKind({ type: 'cc.RealCurve', value: {} }), 'curve');
    assert.equal(resolveKind({ type: 'cc.AnimationCurve', value: {} }), 'curve');
});

test('an array is judged by its element, so an asset array is not collapsed into one reference', () => {
    // the array descriptor itself carries the element's `extends`, which is what made the scalar
    // asset branch match it
    assert.equal(fixtures.materialArray.extends.includes('cc.Asset'), true);
    assert.equal(resolveKind(fixtures.materialArray), 'assetRef');
    assert.deepEqual(projectValue('assetRef', fixtures.materialArray.value), [
        '1a2b3c4d-0001-4a2b-9c31-6b5f2a7de011',
        '1a2b3c4d-0002-4a2b-9c31-6b5f2a7de011'
    ]);

    // and an array of a serializable class stays a class array even when the array descriptor
    // inherits cc.Asset
    assert.equal(resolveKind(fixtures.assetClassArray), 'classArray');
});

test('an array with no element descriptor falls back to its own declared type', () => {
    assert.equal(resolveKind({ isArray: true, type: 'cc.Node', value: [] }), 'nodeRef');
    assert.equal(resolveKind({ isArray: true, type: 'Number', value: [1, 2] }), 'plain');
    assert.equal(resolveKind({ isArray: true, type: 'cc.Color', value: [] }), 'color');
});

test('a node reference, a component reference and an asset reference are told apart by declaration', () => {
    assert.equal(resolveKind({ type: 'cc.Node', value: { uuid: '' }, extends: ['Eventified', 'cc.Object'] }), 'nodeRef');
    assert.equal(resolveKind({ type: 'Locomotion', value: { uuid: '' }, extends: ['cc.Component', 'cc.Object'] }), 'componentRef');
    // a name that spells an asset decides nothing: cc.Animation is a component, not an AnimationClip
    assert.equal(resolveKind({ name: 'clip', type: 'cc.Animation', value: { uuid: '' }, extends: ['cc.Component'] }), 'componentRef');
    assert.equal(resolveKind({ name: 'target', type: 'cc.AudioClip', value: { uuid: '' }, extends: ['cc.Asset'] }), 'assetRef');
});

test('an unknown or absent descriptor is plain, never a guess', () => {
    assert.equal(resolveKind(undefined), 'plain');
    assert.equal(resolveKind({}), 'plain');
    assert.equal(resolveKind({ type: 'Unknown', value: 7 }), 'plain');
});

test('a vec keeps its own axes as numbers, and a missing axis reads zero', () => {
    assert.deepEqual(projectValue('vec', fixtures.vec3.value), { x: 2, y: 2, z: 2 });
    assert.deepEqual(projectValue('vec', fixtures.vec2.value), { x: 0.5, y: 0.5 });
    assert.deepEqual(projectValue('vec', fixtures.size.value), { width: 100, height: 40 });
    assert.deepEqual(projectValue('vec', { x: '3', y: null, z: 4 }), { x: 3, y: 0, z: 4 });
    assert.equal(projectValue('vec', null), null);
});

test('a colour is clamped to 0..255 and an omitted alpha reads opaque', () => {
    assert.deepEqual(projectValue('color', fixtures.color.value), { r: 255, g: 128, b: 0, a: 200 });
    assert.deepEqual(projectValue('color', { r: 300, g: -5, b: 12 }), { r: 255, g: 0, b: 12, a: 255 });
    assert.equal(projectValue('color', null), null);
});

test('a reference projects to its uuid, and an unset one to null instead of an empty string', () => {
    assert.equal(projectValue('assetRef', fixtures.spriteFrame.value), SPRITE_FRAME);
    assert.equal(projectValue('assetRef', fixtures.emptySpriteFrame.value), null);
    assert.equal(projectValue('assetRef', { __uuid__: SPRITE_FRAME }), SPRITE_FRAME);
    assert.equal(projectValue('assetRef', SPRITE_FRAME), SPRITE_FRAME);
    assert.equal(projectValue('nodeRef', fixtures.nodeRef.value), 'cd6e4f10-8a11-4d0e-8c22-0b3a9e77aa01');
    assert.deepEqual(projectValue('nodeRef', fixtures.nodeArray.value), [
        'cd6e4f10-0001-4d0e-8c22-0b3a9e77aa01',
        'cd6e4f10-0002-4d0e-8c22-0b3a9e77aa01'
    ]);
    assert.equal(projectValue('componentRef', fixtures.componentRef.value), '7fa1b220-9c33-4c8e-b1a4-2d5e6f0c9911');
    assert.equal(projectValue('nodeRef', null), null);
    assert.equal(projectValue('nodeRef', { uuid: '' }), null);
});

test('an enum and a bitmask read as their number, never as the descriptor around it', () => {
    assert.equal(projectValue('enum', fixtures.enum.value), 1);
    assert.equal(projectValue('bitmask', fixtures.bitmask.value), 1108344832);
    assert.equal(projectValue('enum', '2'), 2);
    assert.equal(projectValue('enum', null), null);
});

test('a plain value passes through untouched', () => {
    assert.equal(projectValue('plain', 2.5), 2.5);
    assert.equal(projectValue('plain', 'backOut'), 'backOut');
    assert.equal(projectValue('plain', true), true);
    assert.deepEqual(projectValue('plain', [1, 2, 3]), [1, 2, 3]);
    assert.equal(projectValue('plain', null), null);
});

test('a nested @ccclass reads as its members, each projected by its own kind', () => {
    assert.deepEqual(projectValue('nestedClass', fixtures.nestedClass.value), {
        duration: 0.5,
        easing: 'backOut',
        animatesScale: true,
        toScale: { x: 2, y: 2, z: 2 },
        clip: CLIP
    });
});

test('a class array lists its elements, references included, all the way down', () => {
    assert.deepEqual(projectValue('classArray', fixtures.classArray.value), [
        { squads: [{ prefab: PREFAB, count: 10 }], spawnInterval: 0.8 }
    ]);
});

test('a gradient reads as its keys, not as a wall of descriptors', () => {
    assert.deepEqual(projectValue('gradient', fixtures.gradient.value), {
        mode: 1,
        color: { r: 255, g: 255, b: 255, a: 255 },
        gradient: { colorKeys: [{ color: { r: 255, g: 0, b: 0, a: 255 }, time: 0 }] }
    });
    assert.deepEqual(projectValue('curve', fixtures.curve.value), { mode: 0, constant: 5, multiplier: 1 });
});

test('projectDescriptor pairs the two, so a whole dump entry reads in one call', () => {
    assert.equal(projectDescriptor(fixtures.spriteFrame), SPRITE_FRAME);
    assert.deepEqual(projectDescriptor(fixtures.vec3), { x: 2, y: 2, z: 2 });
    assert.deepEqual(projectDescriptor(fixtures.materialArray), [
        '1a2b3c4d-0001-4a2b-9c31-6b5f2a7de011',
        '1a2b3c4d-0002-4a2b-9c31-6b5f2a7de011'
    ]);
    assert.deepEqual(projectDescriptor(fixtures.classArray), [
        { squads: [{ prefab: PREFAB, count: 10 }], spawnInterval: 0.8 }
    ]);
});
