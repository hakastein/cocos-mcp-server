/**
 * The write a stringified `value` turns into.
 *
 * Every case here was observed as a wrong write that reported success: a boolean stored as
 * "true", a cleared reference stored as "null", and a Node field holding a path string that
 * `typeof` proved at runtime, one `addChild` away from a crash.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { planPrefabValue, shapeOfDeclared, shapeOfSerialized } from '../dist/prefab-value.js';
import {
    getComponentPropertyInPrefabData,
    setComponentPropertyInPrefabData,
    nodeRefInPrefabData,
    componentRefInPrefabData
} from '../dist/prefab-json.js';

const declared = (over) => ({
    found: true, ctorName: null, isNode: false, isComponent: false,
    isAsset: false, isArray: false, scalar: null, ...over
});
const NO_DECLARATION = { found: false };

test('a boolean sent as text is written as a boolean', () => {
    const plan = planPrefabValue('true', declared({ scalar: 'boolean' }), false, 'slideObstacles');
    assert.deepEqual(plan, { kind: 'value', value: true, coercedFrom: 'string' });
    assert.equal(planPrefabValue('false', declared({ scalar: 'boolean' }), true, 'x').value, false);
});

test('text that does not spell a boolean is refused, not stored', () => {
    const plan = planPrefabValue('yes', declared({ scalar: 'boolean' }), false, 'slideObstacles');
    assert.equal(plan.kind, 'error');
    assert.match(plan.error, /boolean/);
    assert.match(plan.error, /Nothing was written/);
});

test('a number sent as text is written as a number', () => {
    assert.equal(planPrefabValue('12.5', declared({ scalar: 'number' }), 0, 'perProp').value, 12.5);
    assert.equal(planPrefabValue('abc', declared({ scalar: 'number' }), 0, 'perProp').kind, 'error');
});

test('"null" on a reference field clears it instead of storing the word', () => {
    const plan = planPrefabValue('null', declared({ isNode: true, ctorName: 'cc.Node' }), null, 'slot');
    assert.deepEqual(plan, { kind: 'value', value: null, coercedFrom: 'string' });
});

test('a node path on a Node field is a reference to resolve, never a string', () => {
    const plan = planPrefabValue(
        'char_hero/mixamorig_Spine Socket', declared({ isNode: true, ctorName: 'cc.Node' }), null, 'slot'
    );
    assert.equal(plan.kind, 'reference');
    assert.equal(plan.expects, 'node');
    assert.equal(plan.nodePath, 'char_hero/mixamorig_Spine Socket');
});

test('a component field carries the class its path must resolve to', () => {
    const plan = planPrefabValue('Body/Rig', declared({ isComponent: true, ctorName: 'Locomotion' }), null, 'motor');
    assert.equal(plan.kind, 'reference');
    assert.equal(plan.expects, 'component');
    assert.equal(plan.componentType, 'Locomotion');
});

test('a bare uuid on an asset field becomes {__uuid__}, other text is refused', () => {
    const asset = declared({ isAsset: true, ctorName: 'cc.Prefab' });
    assert.deepEqual(
        planPrefabValue('c9007b52-a3f1-474c-aa8a-5cc43c9c90c3', asset, null, 'prop').value,
        { __uuid__: 'c9007b52-a3f1-474c-aa8a-5cc43c9c90c3' }
    );
    assert.equal(planPrefabValue('db://assets/x.prefab', asset, null, 'prop').kind, 'error');
});

test('a genuine string property keeps its text, quotes and all', () => {
    const plan = planPrefabValue('true', declared({ scalar: 'string' }), '', 'label');
    assert.deepEqual(plan, { kind: 'value', value: 'true' });
});

test('a value that kept its JSON type passes through untouched', () => {
    for (const value of [true, false, 0, 12, null, { __uuid__: 'x' }, [1, 2]]) {
        assert.deepEqual(planPrefabValue(value, null, undefined, 'x'), { kind: 'value', value });
    }
});

test('with no declaration the value already in the prefab decides the type', () => {
    assert.equal(planPrefabValue('true', NO_DECLARATION, false, 'x').value, true);
    assert.equal(planPrefabValue('7', NO_DECLARATION, 3, 'x').value, 7);
    assert.equal(planPrefabValue('true', NO_DECLARATION, 'off', 'x').value, 'true');
    assert.deepEqual(planPrefabValue('null', NO_DECLARATION, { __id__: 12 }, 'slot').value, null);
});

test('text spelling a JSON scalar with nothing to type it against is refused', () => {
    for (const text of ['true', 'false', 'null', '42', '-3.5']) {
        const plan = planPrefabValue(text, NO_DECLARATION, undefined, 'mystery');
        assert.equal(plan.kind, 'error', `${text} was accepted`);
        assert.match(plan.error, /JSON type/);
    }
    // ordinary text is not ambiguous and stays a string
    assert.equal(planPrefabValue('walk', NO_DECLARATION, undefined, 'clipName').value, 'walk');
});

test('a single string is never the whole of an array property', () => {
    const plan = planPrefabValue('a', declared({ isArray: true }), [], 'clips');
    assert.equal(plan.kind, 'error');
    assert.match(plan.error, /array/);
});

test('shape helpers agree with the two sources they read', () => {
    assert.equal(shapeOfDeclared(declared({ isNode: true })), 'node');
    assert.equal(shapeOfDeclared(declared({ isArray: true, isNode: true })), 'array');
    assert.equal(shapeOfDeclared(NO_DECLARATION), 'unknown');
    assert.equal(shapeOfSerialized({ __uuid__: 'x' }), 'asset');
    assert.equal(shapeOfSerialized({ __id__: 4 }), 'node');
    assert.equal(shapeOfSerialized(null), 'unknown');
});

// ----- the prefab-JSON side of the same write ------------------------------------------

/** Root node with one child and a script component carrying the fields under test. */
const CID = 'aaaaaScriptCid00000000';
function fixture() {
    return [
        { __type__: 'cc.Prefab', data: { __id__: 1 } },
        { __type__: 'cc.Node', _name: 'char_hero', _children: [{ __id__: 2 }], _components: [{ __id__: 3 }] },
        { __type__: 'cc.Node', _name: 'Spine Socket', _children: [], _components: [] },
        { __type__: CID, node: { __id__: 1 }, slot: null, slideObstacles: false }
    ];
}

test('a node path resolves to the entry index the prefab stores', () => {
    assert.deepEqual(nodeRefInPrefabData(fixture(), 'char_hero/Spine Socket'), { __id__: 2 });
});

test('an unresolvable node path names the paths that do exist', () => {
    assert.throws(
        () => nodeRefInPrefabData(fixture(), 'char_hero/Nope'),
        /Known paths: char_hero, char_hero\/Spine Socket/
    );
});

test('a component reference resolves to the component entry, not the node', () => {
    assert.deepEqual(componentRefInPrefabData(fixture(), 'char_hero', CID), { __id__: 3 });
    assert.throws(() => componentRefInPrefabData(fixture(), 'char_hero/Spine Socket', CID), /has no/);
});

test('reading a property does not trip the write-time refusals', () => {
    const data = fixture();
    assert.equal(getComponentPropertyInPrefabData(data, { nodePath: 'char_hero' }, CID, 'slideObstacles'), false);
    assert.equal(getComponentPropertyInPrefabData(data, { nodePath: 'char_hero' }, CID, 'slot'), null);
    assert.equal(getComponentPropertyInPrefabData(data, { nodePath: 'char_hero' }, CID, 'absent'), undefined);
});

test('a reference replaces a reference instead of being read as a nested block', () => {
    let data = fixture();
    data = setComponentPropertyInPrefabData(data, { nodePath: 'char_hero' }, CID, 'slot', { __id__: 2 }).data;
    assert.deepEqual(data[3].slot, { __id__: 2 });
    // and again, over the reference now sitting there
    const next = setComponentPropertyInPrefabData(data, { nodePath: 'char_hero' }, CID, 'slot', { __id__: 1 });
    assert.deepEqual(next.data[3].slot, { __id__: 1 });
    assert.deepEqual(next.previous, { __id__: 2 });
});

test('clearing a reference to null is an assignment, not a block edit', () => {
    let data = fixture();
    data = setComponentPropertyInPrefabData(data, { nodePath: 'char_hero' }, CID, 'slot', { __id__: 2 }).data;
    const cleared = setComponentPropertyInPrefabData(data, { nodePath: 'char_hero' }, CID, 'slot', null);
    assert.equal(cleared.data[3].slot, null);
    assert.deepEqual(cleared.previous, { __id__: 2 });
});

test('a component reference is repointed and cleared the same way a node one is', () => {
    let data = fixture();
    data = setComponentPropertyInPrefabData(data, { nodePath: 'char_hero' }, CID, 'slot', { __id__: 3 }).data;
    assert.deepEqual(data[3].slot, { __id__: 3 });
    assert.equal(setComponentPropertyInPrefabData(data, { nodePath: 'char_hero' }, CID, 'slot', null).data[3].slot, null);
});

/** An inline @ccclass — its own entry, no `node` back-link — is still patched member by member. */
test('a nested @ccclass block keeps its entry and refuses a scalar', () => {
    const data = fixture();
    data.push({ __type__: 'TuningBlock', speed: 1, radius: 2 });
    data[3].tuning = { __id__: 4 };
    const patched = setComponentPropertyInPrefabData(data, { nodePath: 'char_hero' }, CID, 'tuning', { speed: 9 });
    assert.deepEqual(patched.data[3].tuning, { __id__: 4 });
    assert.deepEqual(patched.data[4], { __type__: 'TuningBlock', speed: 9, radius: 2 });
    assert.throws(
        () => setComponentPropertyInPrefabData(data, { nodePath: 'char_hero' }, CID, 'tuning', null),
        /takes an object of its members/
    );
});
