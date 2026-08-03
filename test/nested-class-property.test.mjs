/**
 * Writing a serializable @ccclass a component holds INLINE — `enter` on a StagingTween, not an
 * array element — over the descriptor shape 3.8.8 really emits (captured from a live dump of
 * TransformTweenSpec).
 *
 * The field failure these lock down: `property: 'enter'` with a flat object made the editor walk
 * into a raw number looking for `.value` and throw `Cannot use 'in' operator to search for
 * 'value' in 0.5`, so an authored block could not be written at all; and a dotted write that the
 * live component accepted was reported as verified without anyone asking whether a save would
 * keep it. So the assertions are about the recursive dump shape, about members left alone staying
 * untouched, and about persistence being a separate verdict from the live read-back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ComponentTools } from '../dist/tools/component-tools.js';
import { NodeTools } from '../dist/tools/node-tools.js';
import { ProjectTools } from '../dist/tools/project-tools.js';
import { pairsOf, augmentToolDefinition } from '../dist/node-path.js';
import ta from '../dist/tool-args.js';

const { normalizeToolArgs } = ta;
const tools = new ComponentTools();
const call = (method, ...args) => ComponentTools.prototype[method].apply(tools, args);

const field = (name, value, type) => ({
    name, value, default: value, type,
    readonly: false, visible: true, animatable: true, extends: []
});

const vec3 = (name, x, y, z) => ({
    name, value: { x, y, z }, default: { x: 0, y: 0, z: 0 }, type: 'cc.Vec3',
    readonly: false, visible: true, animatable: true, extends: ['cc.ValueType']
});

/** TransformTweenSpec, as the editor dumps it for StagingTween.enter */
const tweenSpec = () => ({
    name: 'enter',
    value: {
        duration: field('duration', 0.5, 'Number'),
        easing: field('easing', 'backOut', 'String'),
        animatesScale: field('animatesScale', true, 'Boolean'),
        animatesPosition: field('animatesPosition', false, 'Boolean'),
        fromScale: vec3('fromScale', 0, 0, 0),
        toScale: vec3('toScale', 2, 2, 2),
        arc: field('arc', 0, 'Number'),
        endsShown: field('endsShown', true, 'Boolean')
    },
    type: 'TransformTweenSpec', readonly: false, visible: true, animatable: true, extends: []
});

const BASE = '__comps__.0.enter';

test('an inline @ccclass is recognised, and is not mistaken for a class array', () => {
    assert.equal(call('isClassDescriptor', tweenSpec()), true);
    assert.equal(call('isClassArrayDescriptor', tweenSpec()), false);
});

test('every member goes out as its own {value,type} descriptor, never a raw number', () => {
    const built = call('buildClassPatch', tweenSpec(), { duration: 0.25 }, BASE);

    assert.deepEqual(built.unknown, []);
    assert.equal(built.dump.type, 'TransformTweenSpec');
    // the shape the editor threw on: a bare 0.25 under `duration`
    assert.equal(typeof built.dump.value.duration, 'object');
    assert.equal(built.dump.value.duration.value, 0.25);
    assert.equal(built.dump.value.duration.type, 'Number');
    assert.deepEqual(built.expected, { duration: 0.25 });
});

test('a member the caller did not name keeps its current value, so a block write is a patch', () => {
    const built = call('buildClassPatch', tweenSpec(), { duration: 0.25 }, BASE);

    assert.equal(built.dump.value.easing.value, 'backOut');
    assert.deepEqual(built.dump.value.toScale.value, { x: 2, y: 2, z: 2 });
    assert.equal(built.dump.value.endsShown.value, true);
    // untouched members are not claimed as written
    assert.deepEqual(Object.keys(built.expected), ['duration']);
});

test('a cc.Vec3 member keeps its raw {x,y,z} value and its cc.Vec3 type', () => {
    const built = call('buildClassPatch', tweenSpec(), { toScale: { x: 3, y: 3, z: 3 } }, BASE);

    assert.equal(built.dump.value.toScale.type, 'cc.Vec3');
    assert.deepEqual(built.dump.value.toScale.value, { x: 3, y: 3, z: 3 });
});

test('the source descriptor is not mutated, so a failed write cannot corrupt the next one', () => {
    const descriptor = tweenSpec();
    call('buildClassPatch', descriptor, { duration: 9, toScale: { x: 9, y: 9, z: 9 } }, BASE);

    assert.equal(descriptor.value.duration.value, 0.5);
    assert.deepEqual(descriptor.value.toScale.value, { x: 2, y: 2, z: 2 });
});

test('a misspelled member is named instead of silently writing nothing', () => {
    const built = call('buildClassPatch', tweenSpec(), { duraton: 0.25, easing: 'linear' }, BASE);
    assert.deepEqual(built.unknown, ['duraton']);
});

test('a reference member is written by dotted path and never inlined into the block dump', () => {
    const UUID = '5965dcc0-7042-42a8-90ac-df7df5ede667';
    const withRef = tweenSpec();
    withRef.value.clip = {
        name: 'clip', value: { uuid: '' }, default: null, type: 'cc.AudioClip',
        readonly: false, visible: true, animatable: true, extends: ['cc.Asset', 'cc.Object']
    };

    const built = call('buildClassPatch', withRef, { clip: UUID, duration: 1 }, BASE);

    assert.equal('clip' in built.dump.value, false);
    assert.deepEqual(built.refs, [{ path: `${BASE}.clip`, type: 'cc.AudioClip', uuid: UUID }]);
    assert.deepEqual(built.expected.clip, { uuid: UUID });
});

test('an untouched reference is stripped from the dump and not written, so it is left alone', () => {
    const UUID = '00ddadd8-f075-44c2-a68a-1af43bee2802';
    const withRef = tweenSpec();
    withRef.value.clip = {
        name: 'clip', value: { uuid: UUID }, default: null, type: 'cc.AudioClip',
        readonly: false, visible: true, animatable: true, extends: ['cc.Asset', 'cc.Object']
    };

    const built = call('buildClassPatch', withRef, { duration: 1 }, BASE);

    assert.equal('clip' in built.dump.value, false);
    assert.deepEqual(built.refs, []);
    assert.equal('clip' in built.expected, false);
});

test('persistence is reported separately from the live read-back, and never implied', () => {
    const live = { found: true, actual: 0.25, mismatches: [] };

    const unchecked = call('persistenceReport',
        { ...live, persistence: { checked: false, found: false, actual: undefined, mismatches: [], reason: 'no scene' } },
        'exit.duration');
    assert.equal(unchecked.persistenceVerified, false);
    assert.match(unchecked.persistenceNote, /NOT verified against the saved form/);
    assert.match(unchecked.persistenceNote, /no scene/);

    const missing = call('persistenceReport',
        { ...live, persistence: { checked: true, found: false, actual: undefined, mismatches: [] } },
        'exit.duration');
    assert.equal(missing.persistenceVerified, false);
    assert.match(missing.persistenceNote, /does not emit 'exit\.duration'/);

    const good = call('persistenceReport',
        { ...live, persistence: { checked: true, found: true, actual: 0.25, mismatches: [] } },
        'exit.duration');
    assert.deepEqual(good, { persistenceVerified: true, persistedValue: 0.25 });
});

test('a value the save would drop is a mismatch even when the live component agrees', () => {
    // exactly the reported failure: live says 0.25, the serialized form still says 0.5
    const out = [];
    call('collectMismatches', 0.25, 0.5, 'exit.duration', out);
    assert.equal(out.length, 1);
    assert.match(out[0], /exit\.duration: expected 0\.25, read 0\.5/);
});

const augmentedSchema = (executor, name) =>
    augmentToolDefinition(executor.getTools().find(t => t.name === name)).inputSchema;

test('set_node_transform takes a nodePath, while a bare uuid meaning an ASSET does not', () => {
    const nodeSchema = augmentedSchema(new NodeTools(), 'set_node_transform');
    assert.ok(nodeSchema.properties.nodePath, 'set_node_transform should accept nodePath');
    assert.equal(nodeSchema.required.includes('uuid'), false, 'the path alone is enough');
    assert.deepEqual(pairsOf(nodeSchema).find(p => p.uuid === 'uuid'),
        { uuid: 'uuid', path: 'nodePath', array: false, required: true });

    const r = normalizeToolArgs('node_set_node_transform', nodeSchema,
        { nodePath: 'Stage_3_Hookah/Hookah_model_v2', scale: { x: 1, y: 1, z: 1 } });
    assert.equal(r.ok, true, r.error);

    // `uuid` also spells an asset and a component; those must not sprout a node path
    const assetSchema = augmentedSchema(new ProjectTools(), 'query_asset_url');
    assert.equal(assetSchema.properties.nodePath, undefined);
    assert.equal(pairsOf(assetSchema).length, 0);
});
