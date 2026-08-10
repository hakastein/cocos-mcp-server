import test from 'node:test';
import assert from 'node:assert/strict';

import { assetTools } from '../dist/tools-v2/asset.js';

const toolNamed = (name) => {
    const tool = assetTools.find(t => t.name === name);
    assert.ok(tool, `tool ${name} not found`);
    return tool;
};

const asset = (name, extra = {}) => ({
    name, uuid: `uuid-${name}`, url: `db://assets/${name}`, type: 'cc.Asset', isDirectory: false, ...extra
});

const ctxOf = (assetDb) => ({ editor: { assetDb } });

test('get_assets asks the database for the sprite-frame cc type, not for the whole folder', async () => {
    let query;
    const result = await toolNamed('project_get_assets').invoke({ type: 'spriteFrame' }, ctxOf({
        queryAssets: async (q) => { query = q; return []; }
    }));
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(query, { pattern: 'db://assets/**/*', ccType: 'cc.SpriteFrame' });
});

test('get_assets fetches details only for the assets that survived maxResults', async () => {
    const detailed = [];
    const result = await toolNamed('project_get_assets').invoke(
        { name: 'hat', maxResults: 2, includeDetails: true },
        ctxOf({
            queryAssets: async () => ['hat_a', 'hat_b', 'hat_c', 'hat_d', 'boot'].map(n => asset(n)),
            queryAssetInfo: async (uuid) => { detailed.push(uuid); return asset(uuid.replace('uuid-', '')); },
            queryPath: async () => 'D:/project/assets/x'
        }));

    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(detailed, ['uuid-hat_a', 'uuid-hat_b']);
    assert.equal(result.data.count, 2);
    assert.equal(result.data.total, 4);
    assert.equal(result.data.truncated, true);
    assert.ok(result.data.assets[0].details.diskPath);
});

test('get_assets without includeDetails asks the database exactly once', async () => {
    let infoCalls = 0;
    const result = await toolNamed('project_get_assets').invoke({}, ctxOf({
        queryAssets: async () => [asset('a'), asset('b')],
        queryAssetInfo: async () => { infoCalls++; return null; }
    }));
    assert.equal(result.success, true);
    assert.equal(infoCalls, 0);
    assert.equal(result.data.truncated, false);
});

test('create_asset defaults to refusing a taken url, and writes nothing', async () => {
    let created = false;
    const result = await toolNamed('project_create_asset').invoke(
        { url: 'db://assets/a.json', content: '{}' },
        ctxOf({
            queryAssetInfo: async () => asset('a.json'),
            createAsset: async () => { created = true; return null; }
        }));
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'asset_exists');
    assert.equal(created, false);
});

test('onConflict overwrite and rename reach the database as the options they mean', async () => {
    const options = [];
    const db = {
        queryAssetInfo: async () => asset('a.json'),
        createAsset: async (url, content, opts) => { options.push(opts); return asset('a.json', { url }); }
    };
    await toolNamed('project_create_asset')
        .invoke({ url: 'db://assets/a.json', content: '{}', onConflict: 'overwrite' }, ctxOf(db));
    await toolNamed('project_create_asset')
        .invoke({ url: 'db://assets/a.json', content: '{}', onConflict: 'rename' }, ctxOf(db));
    assert.deepEqual(options, [
        { overwrite: true, rename: false },
        { overwrite: false, rename: true }
    ]);
});

test('a rename is reported with the url the asset actually landed on', async () => {
    const result = await toolNamed('project_create_asset').invoke(
        { url: 'db://assets/a.json', content: '{}', onConflict: 'rename' },
        ctxOf({
            queryAssetInfo: async () => asset('a.json'),
            createAsset: async () => asset('a-001.json', { url: 'db://assets/a-001.json' })
        }));
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.data.renamed, true);
    assert.equal(result.data.url, 'db://assets/a-001.json');
    assert.equal(result.data.requestedUrl, 'db://assets/a.json');
});

test('a null from create-asset is a failure, not a success with no uuid', async () => {
    const result = await toolNamed('project_create_asset').invoke(
        { url: 'db://assets/missing/a.json', content: '{}' },
        ctxOf({ queryAssetInfo: async () => null, createAsset: async () => null }));
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'create_failed');
});

test('delete_asset on an url that holds nothing is an error, not a silent success', async () => {
    let deleted = false;
    const result = await toolNamed('project_delete_asset').invoke({ url: 'db://assets/ghost.json' },
        ctxOf({
            queryAssetInfo: async () => null,
            deleteAsset: async () => { deleted = true; return null; }
        }));
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'asset_not_found');
    assert.equal(deleted, false);
});

test('concurrent moves reach the asset database one at a time', async () => {
    let active = 0;
    let peak = 0;
    const ctx = ctxOf({
        moveAsset: async (source, target) => {
            peak = Math.max(peak, ++active);
            await new Promise(resolve => setTimeout(resolve, 15));
            active--;
            return asset('moved', { url: target });
        }
    });
    const move = toolNamed('project_move_asset');
    const results = await Promise.all([
        move.invoke({ source: 'db://assets/a.png', target: 'db://assets/out/a.png' }, ctx),
        move.invoke({ source: 'db://assets/b.png', target: 'db://assets/out/b.png' }, ctx)
    ]);
    assert.deepEqual(results.map(r => r.success), [true, true]);
    assert.equal(peak, 1);
});

test('a move onto a taken name is reported as a rename, not as a plain move', async () => {
    const result = await toolNamed('project_move_asset').invoke(
        { source: 'db://assets/a.png', target: 'db://assets/out/a.png' },
        ctxOf({ moveAsset: async () => asset('a-001', { url: 'db://assets/out/a-001.png' }) }));
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.data.renamed, true);
    assert.equal(result.data.url, 'db://assets/out/a-001.png');
});

test('get_asset_info answers uuid, url, disk path and grouped sub-assets in one call', async () => {
    const result = await toolNamed('project_get_asset_info').invoke({ uuid: 'uuid-model' }, ctxOf({
        queryAssetInfo: async () => ({
            name: 'model', uuid: 'uuid-model', url: 'db://assets/model.fbx', type: 'cc.Mesh',
            importer: 'fbx', isDirectory: false, file: 'D:/project/assets/model.fbx', subAssets: {}
        }),
        queryAssetMeta: async () => ({
            subMetas: {
                'a1b2': { name: 'model_mesh', importer: 'gltf-mesh', uuid: 'uuid-mesh' },
                'c3d4': { name: 'model', importer: 'gltf-scene', uuid: 'uuid-scene' }
            }
        })
    }));
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.data.uuid, 'uuid-model');
    assert.equal(result.data.url, 'db://assets/model.fbx');
    assert.equal(result.data.diskPath, 'D:/project/assets/model.fbx');
    assert.deepEqual(result.data.grouped.meshes.map(m => m.uuid), ['uuid-mesh']);
    assert.equal(result.data.grouped.modelPrefab.uuid, 'uuid-scene');
});

test('get_asset_info on an unknown asset names it instead of answering an empty record', async () => {
    const result = await toolNamed('project_get_asset_info')
        .invoke({ assetPath: 'db://assets/nope.prefab' }, ctxOf({ queryAssetInfo: async () => null }));
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'asset_not_found');
    assert.match(result.error.message, /nope\.prefab/);
});
