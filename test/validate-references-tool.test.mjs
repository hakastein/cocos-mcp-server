import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { assetTools } from '../dist/tools-v2/asset.js';

const tool = assetTools.find(t => t.name === 'assetAdvanced_validate_asset_references');

const EFFECT = 'c8f66d17-351a-48da-a12c-0212d28575c4';
const IMAGE = '2b7e5ee4-3e5c-476d-964c-5c81b01f680e';
const TEXTURE = `${IMAGE}@6c48a`;
const MATERIAL = 'b4e820bb-d6f9-4ac8-8ccc-3c43064d5a40';
const GONE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DUMP_DIR = 'db://assets/character/material';

function project(t, entries) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refscan-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const assets = entries.map(entry => {
        const inside = entry.url.slice('db://'.length).split('/').join(path.sep);
        const file = entry.mounted
            ? path.join(root, 'behind-a-mount', path.basename(entry.url))
            : path.join(root, inside);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, entry.meta === undefined ? JSON.stringify(entry.content ?? {}) : '');
        if (entry.meta !== undefined) fs.writeFileSync(`${file}.meta`, JSON.stringify(entry.meta));
        return {
            name: path.basename(entry.url), uuid: entry.uuid, url: entry.url, type: 'cc.Asset',
            isDirectory: false, file, subAssets: entry.subAssets || {}
        };
    });
    assets.root = root;
    return assets;
}

function assetDb(assets, database = {}) {
    const asked = [];
    return {
        asked,
        queryAssets: async ({ pattern }) => {
            if (pattern.startsWith('db://internal')) return [];
            const prefix = pattern.slice(0, pattern.indexOf('/**/'));
            const braced = /\*\*\/\*\.\{([^}]*)\}$/.exec(pattern);
            const single = /\*\*\/\*\.([a-z]+)$/.exec(pattern);
            const extensions = braced ? braced[1].split(',') : single ? [single[1]] : null;
            return assets.filter(asset => asset.url.startsWith(`${prefix}/`)
                && (!extensions || extensions.some(extension => asset.url.endsWith(`.${extension}`))));
        },
        queryAssetInfo: async (ref) => {
            asked.push(ref);
            const entry = database[ref];
            return entry ? { uuid: ref, url: ref, subAssets: entry.subAssets || {} } : null;
        },
        queryAssetMeta: async () => null,
        queryPath: async () => null
    };
}

const material = (refs) => ({
    __type__: 'cc.Material',
    _effectAsset: { __uuid__: refs.effect, __expectedType__: 'cc.EffectAsset' },
    _props: [{ roughness: 1, mainTexture: { __uuid__: refs.texture, __expectedType__: 'cc.Texture2D' } }]
});

const hero = (refs, subAssets) => (
    { url: 'db://assets/mat/m_hero.mtl', uuid: 'mat-uuid', content: material(refs), subAssets }
);

test('a reference nothing answers is named with the file and the field holding it', async (t) => {
    const assets = project(t, [hero({ effect: EFFECT, texture: GONE })]);
    const result = await tool.invoke({}, { editor: { assetDb: assetDb(assets, { [EFFECT]: {} }) } });

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.data.scanned, 1);
    assert.equal(result.data.references, 2);
    assert.deepEqual(result.data.brokenReferences, [{
        asset: 'db://assets/mat/m_hero.mtl',
        ref: GONE,
        where: '_props[0].mainTexture.__uuid__',
        occurrences: 1,
        reason: 'asset_missing'
    }]);
});

test('an asset used by several files is counted, and reported at the first of them', async (t) => {
    const assets = project(t, [
        hero({ effect: EFFECT, texture: GONE }),
        { url: 'db://assets/mat/m_boss.mtl', uuid: 'boss-uuid', content: material({ effect: EFFECT, texture: GONE }) }
    ]);
    const result = await tool.invoke({}, { editor: { assetDb: assetDb(assets, { [EFFECT]: {} }) } });

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(result.data.brokenReferences.map(broken => [broken.asset, broken.occurrences]),
        [['db://assets/mat/m_hero.mtl', 2]]);
});

test('an asset the listing never carried is confirmed with the database before being called broken', async (t) => {
    const assets = project(t, [hero({ effect: EFFECT, texture: TEXTURE })]);
    const db = assetDb(assets, { [EFFECT]: {}, [TEXTURE]: {} });
    const result = await tool.invoke({}, { editor: { assetDb: db } });

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(result.data.brokenReferences, []);
    assert.deepEqual(db.asked.slice().sort(), [EFFECT, TEXTURE].sort());
});

test('a sub-id its own asset does not carry is reported as the sub-asset being gone', async (t) => {
    const assets = project(t, [hero({ effect: EFFECT, texture: TEXTURE })]);
    const db = assetDb(assets, { [EFFECT]: {}, [IMAGE]: { subAssets: { '9d1f2': {} } } });
    const result = await tool.invoke({}, { editor: { assetDb: db } });

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(result.data.brokenReferences, [{
        asset: 'db://assets/mat/m_hero.mtl',
        ref: TEXTURE,
        where: '_props[0].mainTexture.__uuid__',
        occurrences: 1,
        reason: 'sub_asset_missing'
    }]);
});

test('knowing the image is there does not clear a sub-id the image does not have', async (t) => {
    const assets = project(t, [
        hero({ effect: EFFECT, texture: TEXTURE }),
        { url: 'db://assets/tex/hero.jpg', uuid: IMAGE, subAssets: { '9d1f2': {} } }
    ]);
    const db = assetDb(assets, { [EFFECT]: {} });
    const result = await tool.invoke({}, { editor: { assetDb: db } });

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(result.data.brokenReferences.map(broken => [broken.ref, broken.reason]),
        [[TEXTURE, 'sub_asset_missing']]);
    assert.equal(db.asked.includes(TEXTURE), false, 'the listing already answered; no query was needed');
});

test('a sub-id the listing does carry costs no database query at all', async (t) => {
    const assets = project(t, [
        hero({ effect: EFFECT, texture: TEXTURE }),
        { url: 'db://assets/tex/hero.jpg', uuid: IMAGE, subAssets: { '6c48a': {} } }
    ]);
    const db = assetDb(assets, { [EFFECT]: {} });
    const result = await tool.invoke({}, { editor: { assetDb: db } });

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(result.data.brokenReferences, []);
    assert.equal(db.asked.includes(TEXTURE), false);
});

const fbxMeta = (over = {}) => ({
    importer: 'fbx',
    uuid: 'fbx-uuid',
    userData: {
        assetFinder: { meshes: ['fbx-uuid@a6f6c'], materials: [MATERIAL], textures: [] },
        dumpMaterials: true,
        materialDumpDir: DUMP_DIR,
        ...over
    }
});

const model = (meta) => ({ url: 'db://assets/model/hero.fbx', uuid: 'fbx-uuid', meta });

test('a materialDumpDir that no longer exists is the finding — the models render flat', async (t) => {
    const assets = project(t, [model(fbxMeta())]);
    const result = await tool.invoke({}, { editor: { assetDb: assetDb(assets, { [MATERIAL]: {} }) } });

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(result.data.dumpDirsMissing, [{
        fbx: 'db://assets/model/hero.fbx',
        materialDumpDir: DUMP_DIR,
        where: 'userData.materialDumpDir'
    }]);
    assert.deepEqual(result.data.brokenReferences, []);
});

test('a dump directory that is there on disk is not a finding', async (t) => {
    const assets = project(t, [model(fbxMeta())]);
    fs.mkdirSync(path.join(assets.root, 'assets', 'character', 'material'), { recursive: true });
    const result = await tool.invoke({}, { editor: { assetDb: assetDb(assets, { [MATERIAL]: {} }) } });

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(result.data.dumpDirsMissing, []);
    assert.deepEqual(result.data.unverifiedPaths, []);
});

test('a model that dumps no materials has no dump directory to miss', async (t) => {
    const assets = project(t, [model(fbxMeta({ dumpMaterials: false }))]);
    const result = await tool.invoke({}, { editor: { assetDb: assetDb(assets, { [MATERIAL]: {} }) } });

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(result.data.dumpDirsMissing, []);
    assert.deepEqual(result.data.missingImporterPaths, []);
});

test('a source image the importer points at is a missing importer path, not a missing dump dir', async (t) => {
    const meta = fbxMeta({ imageMetas: [{ uri: 'db://assets/tex/gone.jpg' }] });
    const assets = project(t, [model(meta)]);
    fs.mkdirSync(path.join(assets.root, 'assets', 'character', 'material'), { recursive: true });
    const result = await tool.invoke({}, { editor: { assetDb: assetDb(assets, { [MATERIAL]: {} }) } });

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(result.data.dumpDirsMissing, []);
    assert.deepEqual(result.data.missingImporterPaths, [{
        asset: 'db://assets/model/hero.fbx',
        path: 'db://assets/tex/gone.jpg',
        where: 'userData.imageMetas[0].uri'
    }]);
});

test('a db:// path the layout cannot place is unverified, never accused', async (t) => {
    const assets = project(t, [{ ...model(fbxMeta()), mounted: true }]);
    const result = await tool.invoke({}, { editor: { assetDb: assetDb(assets, { [MATERIAL]: {} }) } });

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(result.data.dumpDirsMissing, []);
    assert.deepEqual(result.data.unverifiedPaths, [{
        asset: 'db://assets/model/hero.fbx',
        path: DUMP_DIR,
        where: 'userData.materialDumpDir'
    }]);
    assert.ok(result.data.limits.some(limit => limit.includes('unverifiedPaths')));
});

test('kinds narrows what is opened: asking for materials never reads the model meta', async (t) => {
    const assets = project(t, [hero({ effect: EFFECT, texture: TEXTURE }), model(fbxMeta())]);
    const db = assetDb(assets, { [EFFECT]: {}, [TEXTURE]: {} });
    const result = await tool.invoke({ kinds: ['material'] }, { editor: { assetDb: db } });

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.data.scanned, 1);
    assert.equal(db.asked.includes(MATERIAL), false);
    assert.deepEqual(result.data.dumpDirsMissing, []);
});

test('an asset that cannot be parsed is reported as unread, not as a clean scan', async (t) => {
    const assets = project(t, [hero({ effect: EFFECT, texture: TEXTURE })]);
    fs.writeFileSync(assets[0].file, '{ not json');
    const result = await tool.invoke({}, { editor: { assetDb: assetDb(assets, {}) } });

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.data.scanned, 0);
    assert.equal(result.data.unreadable.length, 1);
    assert.equal(result.data.unreadable[0].asset, 'db://assets/mat/m_hero.mtl');
    assert.ok(result.data.limits.some(limit => limit.includes('could not be read')));
});
