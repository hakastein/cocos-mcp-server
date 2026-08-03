/**
 * The value-shaping half of set_component_property, over the descriptor shape the editor
 * really emits for `WaveSpawner.waves: WaveEntry[]` (captured from a live 3.8.8 dump).
 *
 * The field failure these lock down: an array of a serializable @ccclass was written with the
 * asset reference inlined in the element dump, the editor dropped the uuid, and the call still
 * reported success. So the assertions are about where a reference ends up (a second pass keyed
 * by dotted path, never the inline dump) and about the read-back disagreeing loudly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ComponentTools } from '../dist/tools/component-tools.js';

const tools = new ComponentTools();
const call = (method, ...args) => ComponentTools.prototype[method].apply(tools, args);

const numberField = (name, value) => ({
    name, value, default: value, type: 'Number',
    readonly: false, visible: true, animatable: true, extends: []
});

const prefabField = () => ({
    name: 'prefab', value: { uuid: '' }, default: null, type: 'cc.Prefab',
    readonly: false, visible: true, animatable: true,
    extends: ['cc.Asset', 'Eventified', 'cc.Object']
});

/** WaveSquad = { prefab: cc.Prefab, count: number } */
const squadTemplate = {
    value: { prefab: prefabField(), count: numberField('count', 3) },
    type: 'WaveSquad', readonly: false, visible: true, animatable: true, extends: []
};

/** WaveEntry = { squads: WaveSquad[], spawnInterval: number, startDelay: number } */
const entryTemplate = {
    value: {
        squads: {
            name: 'squads', value: [], default: [], type: 'WaveSquad',
            readonly: false, visible: true, animatable: true,
            isArray: true, elementTypeData: squadTemplate, extends: []
        },
        spawnInterval: numberField('spawnInterval', 0.8),
        startDelay: numberField('startDelay', 0.5)
    },
    type: 'WaveEntry', readonly: false, visible: true, animatable: true, extends: []
};

const wavesDescriptor = {
    name: 'waves', value: [], default: [], type: 'WaveEntry',
    readonly: false, visible: true, animatable: true,
    isArray: true, elementTypeData: entryTemplate, extends: []
};

const squadsDescriptor = entryTemplate.value.squads;
const SLIM = '5965dcc0-7042-42a8-90ac-df7df5ede667';
const THUG = '00ddadd8-f075-44c2-a68a-1af43bee2802';

test('an array of a serializable class is recognised from its element descriptor', () => {
    assert.equal(call('isClassArrayDescriptor', wavesDescriptor), true);
    assert.equal(call('isClassArrayDescriptor', squadsDescriptor), true);
});

test('an array of assets, nodes, numbers or a scalar class field is not a class array', () => {
    const prefabArray = { isArray: true, type: 'cc.Prefab', value: [], elementTypeData: prefabField() };
    const nodeArray = {
        isArray: true, type: 'cc.Node', value: [],
        elementTypeData: { type: 'cc.Node', value: { uuid: '' }, extends: ['Eventified', 'cc.Object'] }
    };
    const numberArray = { isArray: true, type: 'Number', value: [], elementTypeData: numberField('n', 0) };
    const color = { type: 'cc.Color', value: { r: 255, g: 0, b: 0, a: 255 }, extends: [] };
    for (const descriptor of [prefabArray, nodeArray, numberArray, color, undefined]) {
        assert.equal(call('isClassArrayDescriptor', descriptor), false);
    }
});

test('the flat form and the editor dump form normalise to the same element', () => {
    const flat = { prefab: SLIM, count: 10 };
    const semiFlat = { prefab: { uuid: SLIM }, count: 10 };
    const dumpForm = {
        type: 'WaveSquad',
        value: { prefab: { value: { uuid: SLIM } }, count: { value: 10 } }
    };
    assert.deepEqual(call('unwrapDumpValue', flat), { prefab: SLIM, count: 10 });
    assert.deepEqual(call('unwrapDumpValue', semiFlat), { prefab: { uuid: SLIM }, count: 10 });
    assert.deepEqual(call('unwrapDumpValue', dumpForm), { prefab: { uuid: SLIM }, count: 10 });
});

test('an asset field is written by dotted path, never inlined into the element dump', () => {
    const built = call('buildClassElement', squadTemplate,
        { prefab: SLIM, count: 10 }, '__comps__.0.waves.0.squads.0');

    assert.deepEqual(built.dump, { type: 'WaveSquad', value: { count: { type: 'Number', value: 10 } } });
    assert.equal('prefab' in built.dump.value, false);
    assert.deepEqual(built.refs, [{
        path: '__comps__.0.waves.0.squads.0.prefab', type: 'cc.Prefab', uuid: SLIM
    }]);
    assert.deepEqual(built.expected, { prefab: { uuid: SLIM }, count: 10 });
});

test('an omitted field takes the element type declared default, so the array is a replacement', () => {
    const built = call('buildClassElement', squadTemplate, { prefab: THUG }, 'p.0');
    assert.deepEqual(built.dump.value.count, { type: 'Number', value: 3 });
    const cleared = call('buildClassElement', squadTemplate, { count: 4 }, 'p.0');
    assert.deepEqual(cleared.refs, [{ path: 'p.0.prefab', type: 'cc.Prefab', uuid: '' }]);
});

test('references nested two class levels deep carry their own full path', () => {
    const built = call('buildClassElement', entryTemplate, {
        squads: [{ prefab: SLIM, count: 10 }, { prefab: THUG, count: 2 }],
        spawnInterval: 0.6
    }, '__comps__.0.waves.0');

    assert.deepEqual(built.refs.map(r => r.path), [
        '__comps__.0.waves.0.squads.0.prefab',
        '__comps__.0.waves.0.squads.1.prefab'
    ]);
    assert.deepEqual(built.refs.map(r => r.uuid), [SLIM, THUG]);
    assert.equal(built.dump.value.squads.value.length, 2);
    assert.deepEqual(built.dump.value.squads.value[0], { type: 'WaveSquad', value: { count: { type: 'Number', value: 10 } } });
    assert.deepEqual(built.dump.value.spawnInterval, { type: 'Number', value: 0.6 });
    assert.deepEqual(built.dump.value.startDelay, { type: 'Number', value: 0.5 });
    assert.deepEqual(built.expected.squads[1], { prefab: { uuid: THUG }, count: 2 });
});

test('a lost reference is a named mismatch, not a silent success', () => {
    const expected = [{ prefab: { uuid: SLIM }, count: 10 }];
    const asWritten = [{ prefab: { uuid: SLIM }, count: 10 }];
    const asDropped = [{ prefab: { uuid: '' }, count: 10 }];

    let out = [];
    call('collectMismatches', expected, asWritten, 'waves.0.squads', out);
    assert.deepEqual(out, []);

    out = [];
    call('collectMismatches', expected, asDropped, 'waves.0.squads', out);
    assert.equal(out.length, 1);
    assert.match(out[0], /waves\.0\.squads\.0\.prefab/);
    assert.match(out[0], new RegExp(SLIM));
});

test('a short read-back array is reported by length, not by element', () => {
    const out = [];
    call('collectMismatches', [{ count: 1 }, { count: 2 }], [{ count: 1 }], 'squads', out);
    assert.equal(out.length, 1);
    assert.match(out[0], /expected 2 element\(s\), read 1/);
});

test('float read-back is compared with tolerance, so 0.8 does not fail against 0.8000001', () => {
    const out = [];
    call('collectMismatches', { spawnInterval: 0.8 }, { spawnInterval: 0.8000001 }, 'waves.0', out);
    assert.deepEqual(out, []);
});

test('a wrong value shape is refused with the expected form and an example for THIS property', () => {
    const description = call('describeClassArrayForm', squadsDescriptor);
    assert.match(description, /ARRAY of WaveSquad/);
    assert.match(description, /"prefab":"<cc\.Prefab asset uuid>"/);
    assert.match(description, /"count":3/);

    const nested = call('describeClassArrayForm', wavesDescriptor);
    assert.match(nested, /ARRAY of WaveEntry/);
    assert.match(nested, /"squads":\[\{"prefab":"<cc\.Prefab asset uuid>","count":3\}\]/);
});

test('propertyType is no longer required, and its list is documented as open-ended', () => {
    const schema = tools.getTools().find(t => t.name === 'set_component_property').inputSchema;
    assert.equal(schema.required.includes('propertyType'), false);
    assert.ok(schema.required.includes('value'));
    // a closed `enum` is what made a caller read "no such capability" into a class name
    assert.equal(schema.properties.propertyType.enum, undefined);
    assert.match(schema.properties.propertyType.description, /OPTIONAL/);
    assert.match(schema.properties.propertyType.description, /@ccclass/);
});

test('get_component_info declares the properties filter it is asked to honour', () => {
    const schema = tools.getTools().find(t => t.name === 'get_component_info').inputSchema;
    assert.equal(schema.properties.properties.type, 'array');
    assert.deepEqual(call('normalizePropertyFilter', ['waves.0.squads']), ['waves.0.squads']);
    assert.deepEqual(call('normalizePropertyFilter', '["waves","spread"]'), ['waves', 'spread']);
    assert.equal(call('normalizePropertyFilter', undefined), null);
    assert.equal(call('normalizePropertyFilter', []), null);
});

test('the properties filter resolves dotted paths and names a miss instead of dumping everything', () => {
    const populatedWaves = {
        ...wavesDescriptor,
        value: [{ type: 'WaveEntry', value: { ...entryTemplate.value, spawnInterval: numberField('spawnInterval', 1.5) } }]
    };
    const properties = { waves: populatedWaves, spread: numberField('spread', 2) };
    const picked = call('pickProperties', properties, ['spread', 'waves.0.spawnInterval', 'nope']);

    assert.deepEqual(Object.keys(picked), ['spread', 'waves.0.spawnInterval', 'nope']);
    assert.equal(picked.spread.value, 2);
    assert.equal(picked['waves.0.spawnInterval'].value, 1.5);
    assert.match(picked.nope.error, /not present/);
    assert.deepEqual(picked.nope.availableProperties, ['waves', 'spread']);
});
