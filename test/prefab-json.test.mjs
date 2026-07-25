import test from 'node:test';
import assert from 'node:assert/strict';
import pj from '../dist/prefab-json.js';

const {
    compressUuid,
    decompressUuid,
    dumpPrefabTree,
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

test('decompressUuid inverts compressUuid on real pairs', () => {
    assert.equal(decompressUuid('322d5IOKZ1EM4K3zUQeplxM'), '322d520e-299d-4433-82b7-cd441ea65c4c');
    for (const uuid of ['80308d3b-9c6d-4158-8395-a4e01dfbea3c', 'fc8653ee-6dda-41e9-adfc-9b86afcdc334', 'bae7849c-3e15-4017-a207-382b3e21e7c5']) {
        assert.equal(decompressUuid(compressUuid(uuid)), uuid);
    }
    assert.equal(decompressUuid('not-a-cid'), 'not-a-cid');
});

test('dumpPrefabTree returns node paths with their components', () => {
    const tree = dumpPrefabTree(fixture());
    assert.deepEqual(tree.map((n) => n.path), ['Root', 'Root/Child']);
    assert.equal(tree[0].components.length, 1);
    assert.equal(tree[0].components[0].type, 'cc.MeshRenderer');
    assert.equal(tree[0].components[0].scriptUuid, null);
    assert.equal(tree[0].components[0].fileId, 'aaaaaaaaaaaaaaaaaaaaaa');
    assert.deepEqual(tree[1].components, []);
});

test('dumpPrefabTree decodes a script component id to its asset uuid', () => {
    const data = addComponentToPrefabData(fixture(), { nodePath: 'Root/Child' }, compressUuid('80308d3b-9c6d-4158-8395-a4e01dfbea3c')).data;
    const child = dumpPrefabTree(data).find((n) => n.path === 'Root/Child');
    assert.equal(child.components[0].scriptUuid, '80308d3b-9c6d-4158-8395-a4e01dfbea3c');
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

test('removing a component nulls positional ref arrays but splices _components', () => {
    const data = fixture();
    data[5]._components = [{ __id__: 7 }];
    data.push({ __type__: 'Holder', node: { __id__: 5 }, __prefab: { __id__: 8 }, _slots: [{ __id__: 2 }, { __id__: 6 }] });
    data.push({ __type__: 'cc.CompPrefabInfo', fileId: 'eeeeeeeeeeeeeeeeeeeeee' });

    const out = removeComponentFromPrefabData(data, { nodePath: 'Root' }, 'cc.MeshRenderer').data;

    const holder = out.find((e) => e.__type__ === 'Holder');
    assert.equal(holder._slots.length, 2, 'positional array must keep its length');
    assert.equal(holder._slots[0], null, 'the removed ref becomes null, not a hole');
    assert.equal(out[holder._slots[1].__id__].__type__, 'cc.PrefabInfo');
    assert.deepEqual(out[1]._components, [], '_components is spliced, not nulled');
});

test('addComponentToPrefabData never lets properties clobber the structural wiring', () => {
    const res = addComponentToPrefabData(fixture(), { nodePath: 'Root' }, CID, { node: { __id__: 999 }, __prefab: { __id__: 999 }, _id: 'x' });
    const comp = res.data[res.componentId];
    assert.equal(comp.node.__id__, 1);
    assert.equal(comp.__prefab.__id__, res.componentId + 1);
});

test('setComponentPropertyInPrefabData writes scalars and asset refs, returning the previous value', () => {
    const first = setComponentPropertyInPrefabData(fixture(), { nodePath: 'Root' }, 'cc.MeshRenderer', '_shadowCastingMode', 0);
    assert.equal(first.previous, 1);
    assert.equal(first.data[2]._shadowCastingMode, 0);

    const second = setComponentPropertyInPrefabData(first.data, { nodePath: 'Root' }, 'cc.MeshRenderer', '_materials', [{ __uuid__: 'u1' }]);
    assert.deepEqual(second.data[2]._materials, [{ __uuid__: 'u1' }]);
    assert.equal(second.previous, undefined);
});
