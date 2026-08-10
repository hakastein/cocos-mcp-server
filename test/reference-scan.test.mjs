import test from 'node:test';
import assert from 'node:assert/strict';

import {
    scanReferences, scanReferenceSites, findBroken, findMissingSubAssets, scanModelMeta
} from '../dist/reference-scan.js';

const EFFECT = 'c8f66d17-351a-48da-a12c-0212d28575c4';
const TEXTURE = '2b7e5ee4-3e5c-476d-964c-5c81b01f680e@6c48a';
const MATERIAL = 'b4e820bb-d6f9-4ac8-8ccc-3c43064d5a40';
const FBX = 'b78e12ea-0f20-47c7-ab06-bd30be6feb99';
const SCRIPT = '9f5e6b7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const SCRIPT_CID = '9f5e6t6HC1OP4qbDB0uP0pb';
const PREFAB = 'd1f0a2b3-4c5d-4e6f-8a9b-0c1d2e3f4a5b';

const material = () => ({
    __type__: 'cc.Material',
    _name: '',
    _native: '',
    _effectAsset: { __uuid__: EFFECT, __expectedType__: 'cc.EffectAsset' },
    _techIdx: 0,
    _defines: [{ USE_INSTANCING: true }],
    _props: [{ roughness: 1, mainTexture: { __uuid__: TEXTURE, __expectedType__: 'cc.Texture2D' } }, {}]
});

const sceneEntries = () => ([
    { __type__: 'cc.SceneAsset', _name: 'weedmanager_1a', scene: { __id__: 1 } },
    { __type__: 'cc.Node', _name: 'Root', _children: [{ __id__: 2 }], _components: [] },
    {
        __type__: 'cc.Node',
        _name: 'Char',
        _components: [{ __id__: 3 }, { __id__: 4 }],
        _prefab: { __id__: 5 }
    },
    { __type__: 'cc.MeshRenderer', node: { __id__: 2 }, _materials: [{ __uuid__: MATERIAL }] },
    { __type__: SCRIPT_CID, node: { __id__: 2 }, _enabled: true, speed: 3 },
    { __type__: 'cc.PrefabInfo', asset: { __uuid__: PREFAB }, fileId: 'bbbbbbbbbbbbbbbbbbbbbb' }
]);

test('a material yields its effect and its sub-asset texture, in the order the file holds them', () => {
    assert.deepEqual(scanReferences(material()), [EFFECT, TEXTURE]);
});

test('a reference is reported at the field that holds it, so a broken one can be located', () => {
    assert.deepEqual(scanReferenceSites(material()), [
        { ref: EFFECT, where: '_effectAsset.__uuid__' },
        { ref: TEXTURE, where: '_props[0].mainTexture.__uuid__' }
    ]);
});

test('a scene yields the material, the prefab asset and the script behind a packed __type__', () => {
    assert.deepEqual(scanReferences(sceneEntries()), [MATERIAL, SCRIPT, PREFAB]);
});

test('the packed __type__ is located as itself, not as the uuid it unpacks to', () => {
    const site = scanReferenceSites(sceneEntries()).find(s => s.ref === SCRIPT);
    assert.deepEqual(site, { ref: SCRIPT, where: '[4].__type__' });
});

test('__id__ links, __expectedType__ class names and engine __type__ are not references', () => {
    const refs = scanReferences(sceneEntries());
    assert.equal(refs.includes('cc.MeshRenderer'), false);
    assert.equal(refs.includes('cc.EffectAsset'), false);
    for (const ref of refs) assert.equal(typeof ref, 'string');
    assert.equal(refs.length, 3);
});

test('a 23-character class name is a class name — unpacking it would invent a uuid', () => {
    const entries = [
        { __type__: 'SuperLongClassName12345', node: { __id__: 0 } },
        { __type__: 'cc.PhysicsMaterialXXXXXX', node: { __id__: 0 } }
    ];
    assert.deepEqual(scanReferences(entries), []);
});

test('the same asset referenced twice is one reference, reported at its first site', () => {
    const twice = [
        { __type__: 'cc.MeshRenderer', _materials: [{ __uuid__: MATERIAL }, { __uuid__: MATERIAL }] },
        { __type__: 'cc.MeshRenderer', _materials: [{ __uuid__: MATERIAL }] }
    ];
    assert.deepEqual(scanReferences(twice), [MATERIAL]);
    assert.deepEqual(scanReferenceSites(twice), [{ ref: MATERIAL, where: '[0]._materials[0].__uuid__' }]);
});

test('an empty or non-string __uuid__ is nothing to check', () => {
    assert.deepEqual(scanReferences([{ __uuid__: '' }, { __uuid__: null }, { __uuid__: 12 }]), []);
});

test('a uuid the project does not know is broken', () => {
    assert.deepEqual(findBroken([EFFECT, MATERIAL], new Set([EFFECT])), [MATERIAL]);
});

test('a sub-asset reference is judged by the asset it lives in', () => {
    assert.deepEqual(findBroken([TEXTURE], new Set(['2b7e5ee4-3e5c-476d-964c-5c81b01f680e'])), []);
    assert.deepEqual(findBroken([TEXTURE], new Set([EFFECT])), [TEXTURE]);
});

test('a database that lists the sub-asset uuid itself answers for it', () => {
    assert.deepEqual(findBroken([TEXTURE], new Set([TEXTURE])), []);
});

test('a sub-id its own asset does not carry is missing', () => {
    const subAssets = new Map([['2b7e5ee4-3e5c-476d-964c-5c81b01f680e', new Set(['9d1f2'])]]);
    assert.deepEqual(findMissingSubAssets([TEXTURE], subAssets), [TEXTURE]);
});

test('a sub-id its asset does carry is fine', () => {
    const subAssets = new Map([['2b7e5ee4-3e5c-476d-964c-5c81b01f680e', new Set(['6c48a', '9d1f2'])]]);
    assert.deepEqual(findMissingSubAssets([TEXTURE], subAssets), []);
});

test('an asset whose sub-assets were never resolved is not judged at all', () => {
    assert.deepEqual(findMissingSubAssets([TEXTURE], new Map()), []);
    assert.deepEqual(findMissingSubAssets([TEXTURE], new Map([['2b7e5ee4-3e5c-476d-964c-5c81b01f680e', new Set()]])), []);
});

test('a plain uuid has no sub-id to be missing', () => {
    assert.deepEqual(findMissingSubAssets([MATERIAL], new Map([[MATERIAL, new Set(['6c48a'])]])), []);
});

const fbxMeta = () => ({
    ver: '2.3.14',
    importer: 'fbx',
    uuid: FBX,
    subMetas: {
        a6f6c: { importer: 'gltf-mesh', uuid: `${FBX}@a6f6c`, userData: {} },
        '08c75': { importer: 'texture', uuid: `${FBX}@08c75`, userData: { isUuid: true, imageUuidOrDatabaseUri: TEXTURE } }
    },
    userData: {
        imageMetas: [{ uri: TEXTURE }],
        assetFinder: {
            meshes: [`${FBX}@a6f6c`],
            skeletons: [`${FBX}@438fe`],
            textures: [],
            materials: [MATERIAL],
            scenes: [`${FBX}@333e8`]
        },
        dumpMaterials: true,
        materialDumpDir: 'db://assets/character/material'
    }
});

test('the materials an FBX is bound to are references — the folder move broke exactly these', () => {
    assert.deepEqual(scanModelMeta(fbxMeta()).refs, [
        { ref: TEXTURE, where: 'subMetas.08c75.userData.imageUuidOrDatabaseUri' },
        { ref: MATERIAL, where: 'userData.assetFinder.materials[0]' }
    ]);
});

test('the model\'s own meshes, skeletons and scenes are not treated as outside references', () => {
    const refs = scanModelMeta(fbxMeta()).refs.map(site => site.ref);
    assert.equal(refs.includes(`${FBX}@a6f6c`), false);
    assert.equal(refs.includes(`${FBX}@438fe`), false);
    assert.equal(refs.includes(`${FBX}@333e8`), false);
});

test('the dump directory is reported as a db:// path whose existence has to be checked', () => {
    assert.deepEqual(scanModelMeta(fbxMeta()).dbPaths,
        [{ where: 'userData.materialDumpDir', path: 'db://assets/character/material' }]);
    assert.equal(scanModelMeta(fbxMeta()).dumpMaterials, true);
    assert.equal(scanModelMeta(fbxMeta()).materialDumpDir, 'db://assets/character/material');
});

test('an importer path stored as a db:// uri is a path to check, not a uuid to look up', () => {
    const meta = { userData: { imageMetas: [{ uri: 'db://assets/character/texture/diffuse.jpg' }] } };
    const scan = scanModelMeta(meta);
    assert.deepEqual(scan.refs, []);
    assert.deepEqual(scan.dbPaths,
        [{ where: 'userData.imageMetas[0].uri', path: 'db://assets/character/texture/diffuse.jpg' }]);
});

test('a meta without dumped materials still names what it is bound to', () => {
    const meta = { uuid: FBX, userData: { assetFinder: { materials: [MATERIAL], textures: [TEXTURE] } } };
    const scan = scanModelMeta(meta);
    assert.deepEqual(scan.refs.map(site => site.ref), [MATERIAL, TEXTURE]);
    assert.equal(scan.dumpMaterials, false);
    assert.equal(scan.materialDumpDir, null);
});

test('the meta\'s own uuid is its identity, never a reference to something else', () => {
    const scan = scanModelMeta({ uuid: FBX, subMetas: { a6f6c: { uuid: `${FBX}@a6f6c` } }, userData: {} });
    assert.deepEqual(scan.refs, []);
});
