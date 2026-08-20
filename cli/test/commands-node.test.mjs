/**
 * Addressing a node by path is the only way an agent names nodes, so an ambiguous path has to be a
 * loud refusal. Creation is checked by the sequence of calls: the undo bracket covers both the
 * structural step and the setup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    nodeCreate, nodeDuplicate, nodeGet, nodeMove, nodeSet, resolveNode
} from '../src/commands/node.ts';
import { present } from '../src/render/present.ts';
import { MemoryDriver } from '../src/driver/memory.ts';

const printed = async (report) => present(await report).stdout;

const FAST = { timeoutMs: 30, intervalMs: 5 };

const scene = (extra = {}) => new MemoryDriver({
    nodes: [
        {
            name: 'Canvas',
            children: [
                { name: 'Bg', components: [{ type: 'Sprite' }] },
                { name: 'Btn' },
                { name: 'Btn' }
            ]
        },
        { name: 'Reference-Image-Canvas' }
    ],
    ...extra
});

const called = (driver, name) => driver.calls.filter(call => call.name === name);

test('a path becomes a uuid through the scene script', async () => {
    const driver = scene();
    assert.equal(await resolveNode(driver, 'Canvas/Bg'), driver.uuidOf('Canvas/Bg'));
});

test('an ambiguous path is refused, naming both candidates', async () => {
    await assert.rejects(() => resolveNode(scene(), 'Canvas/Btn'), /Canvas\/Btn#1, Canvas\/Btn#2/);
});

test('a path that exists nowhere is refused, quoted back', async () => {
    await assert.rejects(() => resolveNode(scene(), 'Nope'), /Nope/);
});

test('a uuid already in hand passes without reaching the scene', async () => {
    const driver = scene();
    const uuid = 'f0rQc7yj9Gpqltg+gTq5ZA'; // the shape of a real compressed Cocos uuid: 22 base64 chars
    assert.equal(await resolveNode(driver, uuid), uuid);
    assert.equal(driver.calls.length, 0);
});

test('a node name of the same length and alphabet as a uuid still resolves as a path', async () => {
    const driver = scene();
    assert.equal(await resolveNode(driver, 'Reference-Image-Canvas'),
        driver.uuidOf('Reference-Image-Canvas'));
    assert.equal(called(driver, 'resolveNodePaths').length, 1);
});

test('get answers one line with the name, the state and the components', async () => {
    const text = await printed(nodeGet(scene(), 'Canvas/Bg'));
    assert.match(text, /Bg/);
    assert.match(text, /Sprite/);
});

test('creating with a component fits in one undo bracket', async () => {
    const driver = scene();
    await nodeCreate(driver, { parent: 'Canvas/Bg', name: 'New', components: ['Sprite'] }, FAST);
    const names = driver.calls.map(call => call.name);
    assert.equal(names[0], 'resolveNodePaths');
    assert.equal(names[1], 'scene.beginRecording');
    assert.equal(names[names.length - 1], 'scene.endRecording');
    assert.ok(names.includes('scene.createNode'));
    assert.ok(names.includes('scene.createComponent'));
});

test('the report names the registered component name rather than the one asked for (L3)', async () => {
    const driver = scene({ classes: ['cc.MeshRenderer'] });
    const text = await printed(nodeCreate(
        driver, { parent: 'Canvas/Bg', name: 'New', components: ['MeshRenderer'] }, FAST));
    assert.match(text, /\[cc\.MeshRenderer\]/);
});

test('a component the engine never registered is refused rather than passed off as ok', async () => {
    await assert.rejects(
        () => nodeCreate(scene({ classes: [] }),
            { parent: 'Canvas/Bg', name: 'New', components: ['Nope'] }, FAST),
        /Nope/);
});

test('a failure while adding a component drops the bracket instead of leaving it open', async () => {
    const driver = scene({ classes: [] });
    await assert.rejects(
        () => nodeCreate(driver, { parent: 'Canvas/Bg', name: 'New', components: ['Nope'] }, FAST));
    assert.equal(called(driver, 'scene.cancelRecording').length, 1);
});

test('get marks an inactive node and a disabled component as (off)', async () => {
    const driver = new MemoryDriver({
        nodes: [{ name: 'Bg', active: false, components: [{ type: 'Sprite', enabled: false }] }]
    });
    const text = await printed(nodeGet(driver, 'Bg'));
    assert.match(text, /Bg {2}\(off\)/);
    assert.match(text, /Sprite\(off\)/);
});

test('creating with a position writes it inside that same undo bracket, not after it', async () => {
    const driver = scene();
    await nodeCreate(driver, { parent: 'Canvas/Bg', name: 'New', components: [], pos: [1, 2, 3] });
    const names = driver.calls.map(call => call.name);
    const beginIdx = names.indexOf('scene.beginRecording');
    const endIdx = names.indexOf('scene.endRecording');
    const setPropertyIdx = names.indexOf('scene.setProperty');
    assert.ok(setPropertyIdx > beginIdx, 'setProperty is not after beginRecording');
    assert.ok(setPropertyIdx < endIdx, 'setProperty landed after endRecording — outside the bracket');
    assert.deepEqual(called(driver, 'scene.setProperty')[0].args[0].dump.value, { x: 1, y: 2, z: 3 });
});

const guard = (extra = {}) => new MemoryDriver({
    nodes: [{ name: 'Environment', children: [{ name: 'Guard' }] }, { name: 'Bunker' }],
    ...extra
});

const instanced = (prefab) => new MemoryDriver({
    nodes: [{
        name: 'Environment',
        children: [{ name: 'cc_scene', prefab, children: [{ name: 'Guard' }] }]
    }]
});

test('a write to a plain node is proven to survive a save', async () => {
    const output = present(await nodeSet(guard(), 'Environment/Guard', { position: { x: 1, y: 2, z: 3 } }, FAST));
    assert.match(output.stdout, /^ok/);
    assert.match(output.stdout, /persisted=true/);
    assert.equal(output.failed, false);
});

// The defect the unified write report exists for: the scene file carries nothing for a node inside
// a prefab instance, so without an override the next load rebuilds the old position.
test('a write inside a prefab instance that records no override is UNPERSISTED', async () => {
    const output = present(await nodeSet(
        instanced({ asset: 'p-1' }), 'Environment/cc_scene/Guard', { position: { x: 1, y: 2, z: 3 } }, FAST));
    assert.equal(output.stdout.split('  ')[0], 'UNPERSISTED');
    assert.match(output.stdout, /_lpos/);
    assert.equal(output.failed, true);
});

test('the same write is ok once the editor records the override that carries it', async () => {
    const output = present(await nodeSet(
        instanced({ asset: 'p-1', recordsOverrides: true }), 'Environment/cc_scene/Guard',
        { position: { x: 1, y: 2, z: 3 } }, FAST));
    assert.match(output.stdout, /^ok/);
    assert.match(output.stdout, /persisted=true/);
    assert.match(output.stdout, /override on Environment\/cc_scene\/Guard/);
});

test('a prefab whose overrides cannot be read leaves persistence unknown rather than false', async () => {
    const output = present(await nodeSet(
        instanced({ asset: 'p-1', readable: false }), 'Environment/cc_scene/Guard',
        { position: { x: 1, y: 2, z: 3 } }, FAST));
    assert.match(output.stdout, /persisted=unknown/);
    assert.equal(output.failed, false);
});

// The head word is read off the first line, so the worst of the writes has to be there.
test('several writes lead with the one a save would drop, not with the one that landed', async () => {
    const driver = instanced({ asset: 'p-1' });
    const output = present(await nodeSet(
        driver, 'Environment/cc_scene', { name: 'Sentry', position: { x: 1, y: 2, z: 3 } }, FAST));
    const lines = output.stdout.split('\n');
    assert.equal(lines[0].split('  ')[0], 'UNPERSISTED');
    assert.match(lines[1], /^ {2}\w+ {2}name = "Sentry"/);
    assert.match(lines[2], /^ {2}UNPERSISTED {2}position/);
    assert.equal(output.failed, true);
});

test('the instance root keeps its own parent in the file, so a move of it is proven', async () => {
    const driver = guard();
    const output = present(await nodeMove(driver, 'Environment/Guard', 'Bunker', false, FAST));
    assert.match(output.stdout, /^ok {2}Environment\/Guard\.parent = "Bunker"/);
    assert.match(output.stdout, /persisted=true/);
    assert.equal(driver.uuidOf('Bunker/Guard'), driver.uuidOf('Bunker/Guard'));
});

test('a move is one undo step and the copy question is asked of the file, not of the tree', async () => {
    const driver = guard();
    await nodeMove(driver, 'Environment/Guard', 'Bunker', false, FAST);
    const names = driver.calls.map(call => call.name);
    assert.ok(names.indexOf('scene.beginRecording') < names.indexOf('scene.setParent'));
    assert.ok(names.indexOf('scene.setParent') < names.indexOf('scene.endRecording'));
    assert.ok(names.indexOf('serializedNodeValue') > names.indexOf('scene.endRecording'));
});

test('a duplicate names the new uuid and answers whether the file will hold it', async () => {
    const driver = guard();
    const output = present(await nodeDuplicate(driver, 'Environment/Guard', FAST));
    assert.match(output.stdout, /^ok {2}Guard\.parent/);
    assert.match(output.stdout, /copy of Environment\/Guard, uuid \S+/);
    assert.match(output.stdout, /persisted=true/);
});

test('a value the node did not take cuts the rest of the writes short', async () => {
    const driver = new MemoryDriver({
        nodes: [{ name: 'Guard' }], refuses: { setProperty: 'the node is locked' }
    });
    await assert.rejects(
        () => nodeSet(driver, 'Guard', { name: 'Sentry', active: false }, FAST), /locked/);
    assert.equal(called(driver, 'scene.cancelRecording').length, 1);
});

// The serializer shortens a parent NODE to its uuid and expands the SCENE into its whole record, so
// without projecting the two onto one spelling every duplicate of a root node reads as UNPERSISTED.
test('a copy of a root node is proven to survive, not reported as dropped on save', async () => {
    const output = present(await nodeDuplicate(guard(), 'Bunker', FAST));
    assert.match(output.stdout, /^ok {2}Bunker\.parent/);
    assert.match(output.stdout, /persisted=true/);
    assert.equal(output.failed, false);
});
