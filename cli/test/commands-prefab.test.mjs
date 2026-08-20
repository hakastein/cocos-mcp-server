/**
 * A node made from a prefab is either an instance that tracks the asset or a flat copy that does
 * not, and nothing in the tree tells them apart — which is why every one of these asserts the
 * linkage rather than the fact that a node appeared.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    prefabApply, prefabCreate, prefabDump, prefabInfo, prefabInstantiate, prefabOverrides,
    prefabRemoveOverride, prefabRevert
} from '../src/commands/prefab.ts';
import { nodeSet } from '../src/commands/node.ts';
import { present } from '../src/render/present.ts';
import { MemoryDriver } from '../src/driver/memory.ts';

const RIFLE_DUMP = {
    prefabUuid: 'u-rifle',
    rootName: 'Rifle',
    nodeCount: 2,
    componentCount: 1,
    missingCount: 0,
    nodes: [
        { path: '', name: 'Rifle', active: true, fileId: 'f-root', components: [] },
        {
            path: 'Barrel', name: 'Barrel', active: true, fileId: 'f-barrel',
            components: [{ type: 'cc.MeshRenderer', cid: null, fileId: 'f-mr', enabled: true, missing: false }]
        }
    ]
};

const project = (extra = {}) => new MemoryDriver({
    nodes: [{ name: 'Environment' }],
    assets: { 'db://assets/props': 'u-props', 'db://assets/props/rifle.prefab': 'u-rifle' },
    prefabAssets: { 'u-rifle': RIFLE_DUMP },
    ...extra
});

test('dump reaches the scene with the uuid the db:// url resolves to', async () => {
    const driver = project();
    const output = present(await prefabDump(driver, { asset: 'db://assets/props/rifle.prefab' }));
    assert.match(output.stderr, /Rifle {2}nodes: 2/);
    assert.match(output.stdout, /Barrel/);
    assert.equal(driver.calls.find(call => call.name === 'dumpPrefabAsset').args[0], 'u-rifle');
});

// A node path here would otherwise become an asset query by node name and answer about the wrong
// thing; a prefab is addressed the way the editor names it.
test('a node path is refused as a prefab address', async () => {
    await assert.rejects(
        () => prefabDump(project(), { asset: 'Environment/Rifle' }), /neither a prefab db:\/\/ url/);
});

test('an address the database does not know is refused rather than dumped as empty', async () => {
    await assert.rejects(
        () => prefabDump(project(), { asset: 'db://assets/props/none.prefab' }), /does not know/);
});

test('instantiate puts the node under the named parent as a linked instance', async () => {
    const driver = project();
    const output = present(await prefabInstantiate(driver, {
        asset: 'db://assets/props/rifle.prefab', parent: 'Environment', name: 'Rifle'
    }));
    assert.match(output.stdout, /^ok {2}Rifle from db:\/\/assets\/props\/rifle\.prefab/);
    assert.match(output.stderr, /linked to u-rifle/);
    assert.ok(driver.uuidOf('Environment/Rifle'));
});

// `create-node` forwards `type` verbatim and strips the PrefabInfo for anything but `cc.Prefab`,
// so a call carrying only the asset uuid lands a flat copy without saying so.
test('the create-node payload carries the type that keeps the PrefabInfo', async () => {
    const driver = project();
    await prefabInstantiate(driver, { asset: 'db://assets/props/rifle.prefab' });
    const payload = driver.calls.find(call => call.name === 'scene.createNode').args[0];
    assert.equal(payload.type, 'cc.Prefab');
    assert.equal(payload.assetUuid, 'u-rifle');
    assert.equal(payload.unlinkPrefab, undefined);
});

test('--unlink asks for the flat copy and the line says the link was not expected', async () => {
    const driver = project();
    const output = present(await prefabInstantiate(driver, {
        asset: 'db://assets/props/rifle.prefab', unlink: true
    }));
    assert.match(output.stdout, /^ok/);
    assert.match(output.stderr, /no link by request/);
    assert.equal(driver.calls.find(call => call.name === 'scene.createNode').args[0].unlinkPrefab, true);
});

test('without --name the node takes the asset name', async () => {
    const driver = project();
    await prefabInstantiate(driver, { asset: 'db://assets/props/rifle.prefab' });
    assert.equal(driver.calls.find(call => call.name === 'scene.createNode').args[0].name,
        'rifle.prefab');
});

test('--pos reaches create-node as the dumped position', async () => {
    const driver = project();
    await prefabInstantiate(driver, {
        asset: 'db://assets/props/rifle.prefab', pos: { x: 1, y: 2, z: 3 }
    });
    assert.deepEqual(driver.calls.find(call => call.name === 'scene.createNode').args[0].dump,
        { position: { value: { x: 1, y: 2, z: 3 } } });
});

// An asset that is not a prefab does not instantiate at all; the node the editor answers with for
// one that does is the only proof the call reached the right asset.
test('an asset outside the database is refused before create-node is called', async () => {
    const driver = project();
    await assert.rejects(
        () => prefabInstantiate(driver, { asset: 'db://assets/props/none.prefab' }), /does not know/);
    assert.equal(driver.calls.filter(call => call.name === 'scene.createNode').length, 0);
});

test('create writes the asset the editor serializer produced, under the folder name', async () => {
    const driver = project();
    const output = present(await prefabCreate(driver, {
        target: 'Environment', savePath: 'db://assets/props'
    }));
    assert.match(output.stdout, /^ok {2}Environment written to db:\/\/assets\/props\/Environment\.prefab/);
    const written = driver.calls.find(call => call.name === 'assetDb.createAsset');
    assert.equal(written.args[0], 'db://assets/props/Environment.prefab');
    assert.equal(written.args[1], '[serialized Environment]');
});

test('--name overrides the node name the asset would otherwise be called by', async () => {
    const driver = project();
    await prefabCreate(driver, {
        target: 'Environment', savePath: 'db://assets/props', name: 'Base'
    });
    assert.equal(driver.calls.find(call => call.name === 'assetDb.createAsset').args[0],
        'db://assets/props/Base.prefab');
});

// The database is the only witness that the write landed; `create-asset` answers null either way.
test('an asset the database never gained is FAILED rather than a quiet ok', async () => {
    const driver = project();
    driver.editor.assetDb.createAsset = async () => null;
    const output = present(await prefabCreate(driver, {
        target: 'Environment', savePath: 'db://assets/props'
    }));
    assert.equal(output.stdout.split('  ')[0], 'FAILED');
    assert.equal(output.failed, true);
});

const instance = (prefab = { asset: 'u-rifle', recordsOverrides: true }) => new MemoryDriver({
    nodes: [{ name: 'Environment', children: [{ name: 'Rifle', prefab, children: [{ name: 'Barrel' }] }] }],
    assets: { 'db://assets/props/rifle.prefab': 'u-rifle' }
});

test('info names the asset, the fileId and whether a save keeps the link', async () => {
    const output = present(await prefabInfo(instance(), { target: 'Environment/Rifle' }));
    assert.match(output.stdout, /^ok {2}Environment\/Rifle {2}prefab u-rifle/);
    assert.match(output.stdout, /instance root/);
    assert.match(output.stdout, /persisted=true/);
});

test('a node inside the instance is named as inside it rather than as its root', async () => {
    const output = present(await prefabInfo(instance(), { target: 'Environment/Rifle/Barrel' }));
    assert.match(output.stdout, /inside an instance/);
});

test('a node tracking no prefab says so instead of reporting an empty linkage', async () => {
    const output = present(await prefabInfo(instance(), { target: 'Environment' }));
    assert.match(output.stdout, /^ok {2}Environment is not linked to a prefab/);
});

test('overrides lists what the instance holds on top of its asset', async () => {
    const driver = instance();
    await nodeSet(driver, {
        target: 'Environment/Rifle/Barrel', name: 'Muzzle', poll: { timeoutMs: 30, intervalMs: 5 }
    });
    const output = present(await prefabOverrides(driver, { target: 'Environment/Rifle' }));
    assert.match(output.stdout, /_name/);
    assert.match(output.stderr, /1/);
});

test('rm-override takes one record out and says how many are left', async () => {
    const driver = instance();
    await nodeSet(driver, {
        target: 'Environment/Rifle/Barrel', name: 'Muzzle', active: false,
        poll: { timeoutMs: 30, intervalMs: 5 }
    });
    const output = present(await prefabRemoveOverride(driver, {
        target: 'Environment/Rifle', property: '_name'
    }));
    assert.match(output.stdout, /^ok {2}override _name removed from Environment\/Rifle {2}remaining: 1/);
});

test('a property with no override on the instance is refused rather than reported removed', async () => {
    await assert.rejects(
        () => prefabRemoveOverride(instance(), { target: 'Environment/Rifle', property: '_name' }),
        /no override of '_name'/);
});

test('apply names the asset the instance was written into', async () => {
    const output = present(await prefabApply(instance(), { target: 'Environment/Rifle' }));
    assert.match(output.stdout, /^ok {2}Rifle written into prefab u-rifle {2}accepted=true/);
});

// The editor answers `undefined` for these often enough that a silent `accepted=false` would be a
// different claim from `it did not say`.
test('an editor that said nothing about accepting is not reported as having refused', async () => {
    const output = present(await prefabApply(
        instance({ asset: 'u-rifle', syncAccepted: null }), { target: 'Environment/Rifle' }));
    assert.match(output.stdout, /did not say whether it accepted/);
    assert.doesNotMatch(output.stdout, /accepted=/);
});

test('revert names the asset the instance was returned to', async () => {
    const output = present(await prefabRevert(instance(), { target: 'Environment/Rifle' }));
    assert.match(output.stdout, /^ok {2}Rifle returned to prefab u-rifle {2}accepted=true/);
});

test('a node carrying no instance is refused by both apply and revert', async () => {
    await assert.rejects(
        () => prefabApply(instance(), { target: 'Environment' }), /no PrefabInstance/);
    await assert.rejects(
        () => prefabRevert(instance(), { target: 'Environment' }), /no PrefabInstance/);
});

// The scene script refuses an ambiguous property rather than removing whichever came first, and
// --index counts into the whole override list, not into the matching subset.
test('a property matching several overrides is refused until index or local-id picks one', async () => {
    const driver = instance();
    await nodeSet(driver, {
        target: 'Environment/Rifle/Barrel', name: 'Muzzle', active: false,
        poll: { timeoutMs: 30, intervalMs: 5 }
    });
    await nodeSet(driver, {
        target: 'Environment/Rifle', active: false, poll: { timeoutMs: 30, intervalMs: 5 }
    });
    await assert.rejects(
        () => prefabRemoveOverride(driver, { target: 'Environment/Rifle', property: '_active' }),
        /matches 2 overrides/);
    const output = present(await prefabRemoveOverride(driver, {
        target: 'Environment/Rifle', property: '_active', index: 1
    }));
    assert.match(output.stdout, /remaining: 2/);
});
