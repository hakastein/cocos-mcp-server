import test from 'node:test';
import assert from 'node:assert/strict';
import pj from '../dist/prefab-json.js';

const {
    compressUuid,
    generateFileId,
    findNodeEntry,
    addComponentToPrefabData,
    removeComponentFromPrefabData,
    setComponentPropertyInPrefabData
} = pj;

function fixture() {
    return [
        { __type__: 'cc.Prefab', _name: 'Root', data: { __id__: 1 } },
        {
            __type__: 'cc.Node',
            _name: 'Root',
            _active: true,
            _parent: null,
            _children: [{ __id__: 5 }],
            _components: [{ __id__: 2 }],
            _prefab: { __id__: 4 }
        },
        { __type__: 'cc.MeshRenderer', node: { __id__: 1 }, _enabled: true, __prefab: { __id__: 3 }, _shadowCastingMode: 1 },
        { __type__: 'cc.CompPrefabInfo', fileId: 'aaaaaaaaaaaaaaaaaaaaaa' },
        { __type__: 'cc.PrefabInfo', root: { __id__: 1 }, asset: { __id__: 0 }, fileId: 'bbbbbbbbbbbbbbbbbbbbbb' },
        {
            __type__: 'cc.Node',
            _name: 'Child',
            _active: true,
            _parent: { __id__: 1 },
            _children: [],
            _components: [],
            _prefab: { __id__: 6 }
        },
        { __type__: 'cc.PrefabInfo', root: { __id__: 1 }, asset: { __id__: 0 }, fileId: 'cccccccccccccccccccccc' }
    ];
}

const CID = 'abcdeFGHIJKLMNOPQRstuvw';

test('compressUuid packs a 32-hex uuid into a 23-char class id', () => {
    const cid = compressUuid('a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6');
    assert.equal(cid.length, 23);
    assert.equal(cid.slice(0, 5), 'a1b2c');
    assert.equal(compressUuid('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'), cid);
});

test('compressUuid matches real script-uuid -> __type__ pairs from a shipped scene', () => {
    assert.equal(compressUuid('80308d3b-9c6d-4158-8395-a4e01dfbea3c'), '8030807nG1BWIOVpOAd++o8');
    assert.equal(compressUuid('fc8653ee-6dda-41e9-adfc-9b86afcdc334'), 'fc865PubdpB6a38m4avzcM0');
    assert.equal(compressUuid('bae7849c-3e15-4017-a207-382b3e21e7c5'), 'bae78ScPhVAF6IHOCs+IefF');
});

test('generateFileId returns 22 base64-alphabet chars', () => {
    const id = generateFileId(() => 0.5);
    assert.equal(id.length, 22);
    assert.match(id, /^[A-Za-z0-9+/]{22}$/);
});

test('findNodeEntry resolves by path and rejects an unknown one', () => {
    const data = fixture();
    assert.equal(findNodeEntry(data, { nodePath: 'Root/Child' }).node._name, 'Child');
    assert.equal(findNodeEntry(data, { nodePath: 'Root' }).id, 1);
    assert.equal(findNodeEntry(data, { nodeName: 'Child' }).node._name, 'Child');
    assert.throws(() => findNodeEntry(data, { nodePath: 'Root/Nope' }), /Nope/);
});

test('addComponentToPrefabData appends the pair, wires ids and preserves existing fileIds', () => {
    const before = fixture();
    const fileIdsBefore = before.filter((e) => e.fileId).map((e) => e.fileId);

    const res = addComponentToPrefabData(before, { nodePath: 'Root/Child' }, CID, { _enabled: false }, 'dddddddddddddddddddddd');
    const data = res.data;

    assert.equal(data.length, 9);
    const comp = data[res.componentId];
    assert.equal(comp.__type__, CID);
    assert.equal(comp._enabled, false);
    assert.equal(comp.node.__id__, 5);
    assert.equal(data[comp.__prefab.__id__].__type__, 'cc.CompPrefabInfo');
    assert.equal(data[comp.__prefab.__id__].fileId, 'dddddddddddddddddddddd');
    assert.deepEqual(data[5]._components, [{ __id__: res.componentId }]);
    assert.deepEqual(data.filter((e) => e.fileId).map((e) => e.fileId).slice(0, 3), fileIdsBefore);
});

test('removeComponentFromPrefabData drops both entries and keeps every other reference valid', () => {
    const data = removeComponentFromPrefabData(fixture(), { nodePath: 'Root' }, 'cc.MeshRenderer').data;

    assert.equal(data.length, 5);
    assert.equal(data.some((e) => e.__type__ === 'cc.MeshRenderer'), false);
    assert.equal(data.some((e) => e.__type__ === 'cc.CompPrefabInfo'), false);

    const root = data[1];
    assert.equal(root._name, 'Root');
    assert.deepEqual(root._components, []);
    assert.equal(data[root._prefab.__id__].fileId, 'bbbbbbbbbbbbbbbbbbbbbb');
    const child = data[root._children[0].__id__];
    assert.equal(child._name, 'Child');
    assert.equal(data[child._prefab.__id__].fileId, 'cccccccccccccccccccccc');
    assert.equal(child._parent.__id__, 1);
});

test('removeComponentFromPrefabData reports the removed fileId', () => {
    const res = removeComponentFromPrefabData(fixture(), { nodePath: 'Root' }, 'cc.MeshRenderer');
    assert.equal(res.removedFileId, 'aaaaaaaaaaaaaaaaaaaaaa');
});

test('removeComponentFromPrefabData throws when the node has no such component', () => {
    assert.throws(() => removeComponentFromPrefabData(fixture(), { nodePath: 'Root/Child' }, 'cc.MeshRenderer'), /no 'cc.MeshRenderer'/);
});

test('setComponentPropertyInPrefabData writes scalars and asset refs, returning the previous value', () => {
    const first = setComponentPropertyInPrefabData(fixture(), { nodePath: 'Root' }, 'cc.MeshRenderer', '_shadowCastingMode', 0);
    assert.equal(first.previous, 1);
    assert.equal(first.data[2]._shadowCastingMode, 0);

    const second = setComponentPropertyInPrefabData(first.data, { nodePath: 'Root' }, 'cc.MeshRenderer', '_materials', [{ __uuid__: 'u1' }]);
    assert.deepEqual(second.data[2]._materials, [{ __uuid__: 'u1' }]);
    assert.equal(second.previous, undefined);
});
