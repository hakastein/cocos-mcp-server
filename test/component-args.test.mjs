// A field DECLARED String must keep JSON-looking text: parsing it rewrites authored content.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    canonicalClassName, classNameOf, coerceValueArg, componentMatches, hintedDescriptor, matchesOf,
    propertyFilterOf, resolveDumpPath, valueFromArgs
} from '../dist/tools-v2/component.js';
import { resolveKind, isArrayDescriptor } from '../dist/property/kind.js';

const STRING_FIELD = { name: 'label', type: 'String', value: 'hi', extends: [] };
const STRING_ARRAY = {
    name: 'lines', type: 'String', value: [], isArray: true, extends: [],
    elementTypeData: { type: 'String', value: '' }
};
const VEC3_FIELD = { name: 'offset', type: 'cc.Vec3', value: { x: 0, y: 0, z: 0 }, extends: ['cc.ValueType'] };
const NUMBER_FIELD = { name: 'speed', type: 'Number', value: 1, extends: [] };

const UUID = '5965dcc0-7042-42a8-90ac-df7df5ede667';

test('a declared String field keeps JSON-looking text verbatim', () => {
    assert.equal(coerceValueArg('{"hp":10}', STRING_FIELD), '{"hp":10}');
    assert.equal(coerceValueArg('[1,2]', STRING_FIELD), '[1,2]');
});

test('an ARRAY of strings is still parsed — the verbatim rule is about one string, not a list', () => {
    assert.deepEqual(coerceValueArg('["a","b"]', STRING_ARRAY), ['a', 'b']);
});

test('a stringified object on any other field is parsed back into the object', () => {
    assert.deepEqual(coerceValueArg('{"x":1,"y":2,"z":3}', VEC3_FIELD), { x: 1, y: 2, z: 3 });
    assert.deepEqual(coerceValueArg('[{"count":2}]', undefined), [{ count: 2 }]);
});

test('a native value is handed on untouched, whatever the descriptor says', () => {
    const native = { x: 1, y: 2, z: 3 };
    assert.equal(coerceValueArg(native, VEC3_FIELD), native);
    assert.equal(coerceValueArg(false, STRING_FIELD), false);
    assert.equal(coerceValueArg(42, NUMBER_FIELD), 42);
    assert.equal(coerceValueArg(null, VEC3_FIELD), null);
});

test('a bare uuid and other non-JSON text are never reinterpreted', () => {
    assert.equal(coerceValueArg(UUID, undefined), UUID);
    assert.equal(coerceValueArg('42', NUMBER_FIELD), '42');
    assert.equal(coerceValueArg('#FF0000', undefined), '#FF0000');
});

test('malformed JSON text stays the text it was, instead of failing the call', () => {
    assert.equal(coerceValueArg('{"x":', VEC3_FIELD), '{"x":');
});

test('a hint the dump cannot express decides the kind: gradient and curve', () => {
    assert.equal(resolveKind(hintedDescriptor(undefined, 'gradient')), 'gradient');
    assert.equal(resolveKind(hintedDescriptor(NUMBER_FIELD, 'curve')), 'curve');
});

test('the reference hints resolve to the three reference kinds', () => {
    assert.equal(resolveKind(hintedDescriptor(undefined, 'node')), 'nodeRef');
    assert.equal(resolveKind(hintedDescriptor(undefined, 'component')), 'componentRef');
    for (const hint of ['asset', 'prefab', 'spriteFrame']) {
        assert.equal(resolveKind(hintedDescriptor(undefined, hint)), 'assetRef', hint);
    }
    assert.equal(hintedDescriptor(undefined, 'prefab').type, 'cc.Prefab');
    assert.equal(hintedDescriptor(undefined, 'spriteFrame').type, 'cc.SpriteFrame');
});

test('an array keyword makes an array of that element, not one scalar', () => {
    const nodes = hintedDescriptor(undefined, 'nodeArray');
    assert.equal(isArrayDescriptor(nodes), true);
    assert.equal(resolveKind(nodes), 'nodeRef');
    assert.equal(resolveKind(hintedDescriptor(undefined, 'colorArray')), 'color');
    assert.equal(resolveKind(hintedDescriptor(undefined, 'numberArray')), 'plain');
});

test('an array keyword beats an element type the dump already carries', () => {
    const numbers = { name: 'ids', type: 'Number', value: [], isArray: true, extends: [], elementTypeData: NUMBER_FIELD };
    assert.equal(resolveKind(hintedDescriptor(numbers, 'nodeArray')), 'nodeRef');
});

test('a scalar keyword keeps the members the dump described, so a patch template survives', () => {
    const hinted = hintedDescriptor(VEC3_FIELD, 'vec3');
    assert.equal(hinted.type, 'cc.Vec3');
    assert.deepEqual(hinted.value, { x: 0, y: 0, z: 0 });
});

test('a propertyType nobody declared leaves an existing descriptor alone', () => {
    assert.equal(hintedDescriptor(VEC3_FIELD, 'WaveSquad'), VEC3_FIELD);
    assert.equal(hintedDescriptor(STRING_FIELD, ''), STRING_FIELD);
    assert.equal(hintedDescriptor(undefined, ''), undefined);
});

test('an unknown cc.* name with no dump entry is taken as an asset reference', () => {
    const hinted = hintedDescriptor(undefined, 'cc.Material');
    assert.equal(resolveKind(hinted), 'assetRef');
    assert.equal(hinted.type, 'cc.Material');
});

test('an asset hint says only THAT the field is an asset — the class stays the dump\'s', () => {
    const mesh = { name: 'mesh', type: 'cc.Mesh', value: { uuid: '' }, extends: ['cc.Asset', 'cc.Object'] };
    for (const hint of ['asset', 'prefab', 'spriteFrame', 'cc.Prefab']) {
        const hinted = hintedDescriptor(mesh, hint);
        assert.equal(hinted.type, 'cc.Mesh', hint);
        assert.equal(resolveKind(hinted), 'assetRef', hint);
    }
});

test('a hint spelled as a keyword and as its cc.* class name mean the same thing', () => {
    assert.equal(resolveKind(hintedDescriptor(undefined, 'cc.Color')), 'color');
    assert.equal(resolveKind(hintedDescriptor(undefined, 'cc.Vec2')), 'vec');
    assert.equal(resolveKind(hintedDescriptor(undefined, 'cc.Node')), 'nodeRef');
    assert.equal(hintedDescriptor(undefined, 'integer').type, 'Number');
    assert.equal(hintedDescriptor(undefined, 'boolean').type, 'Boolean');
});

test('the string hint reaches the verbatim rule, so hinted text is never parsed', () => {
    assert.equal(coerceValueArg('{"a":1}', hintedDescriptor(undefined, 'string')), '{"a":1}');
});

test('clear wins over everything, and an explicit null clears too', () => {
    assert.deepEqual(valueFromArgs({ clear: true, value: 5, targetUuid: UUID }), { value: null });
    assert.deepEqual(valueFromArgs({ value: null }), { value: null });
});

test('the reference spellings supply the value, an array staying an array', () => {
    assert.deepEqual(valueFromArgs({ targetUuid: UUID }), { value: UUID });
    assert.deepEqual(valueFromArgs({ targetUuids: [UUID] }), { value: [UUID] });
    assert.deepEqual(valueFromArgs({ value: 3 }), { value: 3 });
});

test('a call naming no value at all is an error, not a write of undefined', () => {
    const answer = valueFromArgs({});
    assert.match(answer.error, /value/);
    assert.equal('value' in answer, false);
});

const properties = {
    waves: {
        name: 'waves', type: 'WaveEntry', isArray: true, extends: [],
        value: [{ type: 'WaveEntry', value: { spawnInterval: { type: 'Number', value: 1.5 } } }]
    },
    speed: NUMBER_FIELD,
    empty: { name: 'empty', type: 'cc.Prefab', value: null, extends: ['cc.Asset'] }
};

test('a dotted path walks array indices and nested members', () => {
    assert.equal(resolveDumpPath(properties, 'speed'), NUMBER_FIELD);
    assert.equal(resolveDumpPath(properties, 'waves.0.spawnInterval').value, 1.5);
});

test('a path the dump does not carry answers undefined instead of a half-built object', () => {
    assert.equal(resolveDumpPath(properties, 'nope'), undefined);
    assert.equal(resolveDumpPath(properties, 'waves.0.nope'), undefined);
    assert.equal(resolveDumpPath(properties, 'speed.deeper'), undefined);
});

test('the property filter takes a list, a JSON list or one name, and nothing means everything', () => {
    assert.deepEqual(propertyFilterOf(['waves.0.squads']), ['waves.0.squads']);
    assert.deepEqual(propertyFilterOf('["waves","speed"]'), ['waves', 'speed']);
    assert.deepEqual(propertyFilterOf('speed'), ['speed']);
    assert.equal(propertyFilterOf(undefined), null);
    assert.equal(propertyFilterOf([]), null);
    assert.equal(propertyFilterOf('  '), null);
});

const builtin = { __type__: 'cc.Sprite', value: { name: { value: 'Icon<Sprite>' }, uuid: { value: 'comp-1' } } };
const script = {
    __type__: 'a1a43ZGW/xLp7dGgTuz1r4Y', cid: 'a1a43ZGW/xLp7dGgTuz1r4Y',
    value: { name: { value: 'Hero<Locomotion>' }, uuid: { value: 'comp-2' } }
};

test('a component answers to its cid, its class name and the cc. spelling of it', () => {
    assert.equal(componentMatches(builtin, 'cc.Sprite'), true);
    assert.equal(componentMatches(builtin, 'Sprite'), true);
    assert.equal(componentMatches(script, 'a1a43ZGW/xLp7dGgTuz1r4Y'), true);
    assert.equal(componentMatches(script, 'Locomotion'), true);
    assert.equal(componentMatches(script, 'cc.Sprite'), false);
    assert.equal(componentMatches(builtin, ''), false);
});

test('same-class components are listed in node order, so index 1 is the second one', () => {
    const other = { __type__: 'cc.Sprite', value: { name: { value: 'Icon2<Sprite>' } } };
    assert.deepEqual(matchesOf([builtin, script, other], 'cc.Sprite'), [0, 2]);
    assert.deepEqual(matchesOf([builtin, script, other], 'Locomotion'), [1]);
    assert.deepEqual(matchesOf([builtin, script, other], 'cc.Label'), []);
});

test('the name handed to the scene process is a class the engine can look up, never a cid', () => {
    assert.equal(canonicalClassName(builtin), 'cc.Sprite');
    assert.equal(canonicalClassName(script), 'Locomotion');
    assert.equal(classNameOf(builtin), 'Sprite');
    assert.equal(classNameOf(script), 'Locomotion');
    assert.equal(classNameOf({ value: {} }), null);
});
