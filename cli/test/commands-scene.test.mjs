import test from 'node:test';
import assert from 'node:assert/strict';

import {
    sceneClasses, sceneClose, sceneDirty, sceneInfo, sceneMissing, sceneOpen, sceneOwners,
    sceneReload, sceneSave, sceneTree
} from '../src/commands/scene.ts';
import { present } from '../src/render/present.ts';
import { MemoryDriver } from '../src/driver/memory.ts';

const treeOutput = async (...args) => present(await sceneTree(...args));

const TWO_NODES = {
    name: 'main',
    nodes: [{ name: 'Canvas', components: [{ type: 'Canvas' }],
        children: [{ name: 'Bg', components: [{ type: 'Sprite' }] }] }]
};

test('the tree is built from the dump and reports the node count', async () => {
    const output = await treeOutput(new MemoryDriver(TWO_NODES), {});
    assert.equal(output.stderr, 'nodes: 2');
    assert.match(output.stdout, /Canvas {2}\[Canvas\]/);
    assert.match(output.stdout, /Bg {2}\[Sprite\]/);
});

test('a refusal from the scene script surfaces as an error carrying its own text', async () => {
    await assert.rejects(() => sceneTree(new MemoryDriver(), {}), /no scene is open/);
});

test('a dump with no nodes does not pretend to be a tree', async () => {
    const output = await treeOutput(new MemoryDriver({ nodes: [] }), {});
    assert.equal(output.stderr, 'nodes: 0');
    assert.match(output.stdout, /empty|no nodes/i);
});

test('info names the scene and its node count on one line', async () => {
    const nodes = Array.from({ length: 42 }, (unused, index) => ({ name: `N${index}` }));
    const text = present(await sceneInfo(new MemoryDriver({ name: 'main', nodes }))).stdout;
    assert.match(text, /main/);
    assert.match(text, /42/);
});

const dirtyScene = () => new MemoryDriver({
    nodes: [{ name: 'Canvas', components: [{ type: 'Canvas' }] }],
    dirty: {
        differsFromDisk: true,
        scenePath: 'db://assets/main.scene',
        diffs: [{ path: 'Canvas._lpos', kind: 'changed', disk: 0, live: 12 }]
    }
});

test('owners asks with the class and takes the active-only flag as its inverse', async () => {
    const driver = new MemoryDriver({
        nodes: [{ name: 'Canvas', components: [{ type: 'Canvas' }] }]
    });
    const output = present(await sceneOwners(driver, { className: 'Canvas', activeOnly: true }));
    assert.match(output.stdout, /Canvas/);
    const asked = driver.calls.find(call => call.name === 'findComponentOwners');
    assert.deepEqual(asked.args[0], { className: 'Canvas', includeInactive: false });
});

test('without --active-only the listing includes nodes switched off', async () => {
    const driver = new MemoryDriver({ nodes: [{ name: 'Canvas', components: [{ type: 'Canvas' }] }] });
    await sceneOwners(driver, { className: 'Canvas' });
    assert.equal(driver.calls.find(call => call.name === 'findComponentOwners').args[0].includeInactive, true);
});

test('dirty names the file the open scene differs from and where', async () => {
    const output = present(await sceneDirty(dirtyScene()));
    assert.match(output.stdout, /differs from disk/);
    assert.match(output.stdout, /Canvas\._lpos/);
});

test('a scene matching its file says so instead of listing nothing', async () => {
    const output = present(await sceneDirty(new MemoryDriver({ nodes: [] })));
    assert.doesNotMatch(output.stdout, /differs from disk/);
});

test('missing lists the component slots whose script no longer resolves', async () => {
    const driver = new MemoryDriver({
        nodes: [{ name: 'Canvas' }],
        missingScripts: [{
            nodePath: 'Canvas', nodeUuid: 'n-1', componentUuid: 'c-1', cid: 'abc'
        }]
    });
    assert.match(present(await sceneMissing(driver, {})).stdout, /Canvas/);
});

// --root is a node path, and the scene script takes a uuid: an unresolved path would scan the
// whole scene and answer about nodes nobody asked about.
test('--root reaches the scene as a resolved uuid rather than as the path', async () => {
    const driver = new MemoryDriver({
        nodes: [{ name: 'Canvas', children: [{ name: 'Bg' }] }], missingScripts: []
    });
    await sceneMissing(driver, { root: 'Canvas/Bg' });
    const asked = driver.calls.find(call => call.name === 'dumpMissingScripts');
    assert.deepEqual(asked.args[0], { rootUuid: driver.uuidOf('Canvas/Bg') });
});

test('without --root the scene is scanned whole, with no rootUuid invented for it', async () => {
    const driver = new MemoryDriver({ nodes: [{ name: 'Canvas' }], missingScripts: [] });
    await sceneMissing(driver, {});
    assert.deepEqual(driver.calls.find(call => call.name === 'dumpMissingScripts').args[0], {});
});

test('open tells the editor the address it was given and names it back', async () => {
    const driver = new MemoryDriver({ nodes: [] });
    const output = present(await sceneOpen(driver, { target: 'db://assets/main.scene' }));
    assert.match(output.stdout, /^ok {2}opened db:\/\/assets\/main\.scene/);
    assert.equal(driver.calls.find(call => call.name === 'scene.openScene').args[0],
        'db://assets/main.scene');
});

test('save goes through the editor rather than writing the file itself', async () => {
    const driver = new MemoryDriver({ nodes: [] });
    assert.match(present(await sceneSave(driver)).stdout, /^ok {2}scene saved/);
    assert.equal(driver.calls.filter(call => call.name === 'scene.saveScene').length, 1);
});

test('close says so when the editor closed the scene', async () => {
    const output = present(await sceneClose(new MemoryDriver({ nodes: [] })));
    assert.match(output.stdout, /^ok/);
    assert.equal(output.failed, false);
});

// `close-scene` answers a boolean and the editor says `false` when it keeps the scene open; an
// unread answer would print `ok` over a scene that is still there.
test('close refused by the editor is a failure, not an ok', async () => {
    const output = present(await sceneClose(new MemoryDriver({ nodes: [], closeScene: false })));
    assert.match(output.stdout, /^FAILED/);
    assert.equal(output.failed, true);
});

test('reload says the scene is kept, since the name reads like a reopen and it is not one', async () => {
    const output = present(await sceneReload(new MemoryDriver({ nodes: [] })));
    assert.match(output.stdout, /^ok {2}components of the open scene reloaded$/);
    assert.match(output.stderr, /node uuids and writes not yet saved both survive/);
});

const registry = () => new MemoryDriver({
    nodes: [],
    registeredClasses: { 'cc.Component': ['cc.Component', 'cc.Sprite', 'cc.SpriteComponent'] }
});

test('classes lists what the engine registers under the base, the base included', async () => {
    const output = present(await sceneClasses(registry(), { base: 'cc.Component' }));
    assert.match(output.stdout, /cc\.SpriteComponent/);
    assert.match(output.stdout, /cc\.Component/);
    assert.match(output.stderr, /cc\.Component: 3/);
});

test('a base nothing extends answers an empty listing rather than the whole registry', async () => {
    const output = present(await sceneClasses(registry(), { base: 'cc.Asset' }));
    assert.equal(output.stdout, 'no class matched');
    assert.match(output.stderr, /cc\.Asset: 0/);
});
