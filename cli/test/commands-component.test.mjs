import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { componentSet } from '../src/commands/component.ts';
import { present } from '../src/render/present.ts';
import { MemoryDriver } from '../src/driver/memory.ts';

const fixtures = JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/descriptors.json', import.meta.url)), 'utf8')
);

/** A command answers with a report; the presenter turns it into lines and an exit code. */
const setOutput = async (...args) => present(await componentSet(...args));

const white = () => ({ ...fixtures.color, value: { r: 255, g: 255, b: 255, a: 255 } });

const spriteScene = (component = {}) => ({
    nodes: [{ name: 'Canvas', children: [{ name: 'Bg', components: [
        { type: 'cc.Sprite', props: { color: white() }, ...component }
    ] }] }]
});

const writeOf = (driver) => driver.calls.find(call => call.name === 'scene.setProperty').args[0];

test('a write is wrapped in an undo bracket', async () => {
    const driver = new MemoryDriver(spriteScene());
    await componentSet(driver, { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ffffff' });
    const names = driver.calls.map(call => call.name);
    assert.ok(names.indexOf('scene.beginRecording') < names.indexOf('scene.setProperty'));
    assert.ok(names.indexOf('scene.setProperty') < names.indexOf('scene.endRecording'));
    assert.ok(!names.includes('scene.cancelRecording'));
});

test('the result arrives on stdout as a report rather than as a raw object', async () => {
    const output = await setOutput(new MemoryDriver(spriteScene()),
        { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ffffff' });
    assert.match(output.stdout, /^ok/);
    assert.match(output.stdout, /cc\.Sprite\.color/);
    assert.match(output.stdout, /persisted=true/);
    assert.equal(output.failed, false);
});

test('a write accepts the prefixed spelling and names the registered class', async () => {
    const output = await setOutput(new MemoryDriver(spriteScene()),
        { node: 'Canvas/Bg', component: 'cc.Sprite', property: 'color', value: '#ffffff' });
    assert.match(output.stdout, /cc\.Sprite\.color/);
});

test('a node without the requested component gives a refusal naming what it does carry', async () => {
    await assert.rejects(
        () => componentSet(new MemoryDriver(spriteScene()),
            { node: 'Canvas/Bg', component: 'Label', property: 'string', value: 'hi' }),
        /Sprite/);
});

test('cc.Color gets the type hint and the value arrives parsed', async () => {
    const driver = new MemoryDriver(spriteScene());
    await componentSet(driver, { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ff0000' });
    assert.equal(writeOf(driver).dump.type, 'cc.Color');
    assert.deepEqual(writeOf(driver).dump.value, { r: 255, g: 0, b: 0, a: 255 });
});

test('the serializer emits a different value — persisted=false and a non-zero outcome', async () => {
    // The shape the serializer really emits for cc.Color is a channel object; here it is BLACK
    // against a written WHITE, that is, a genuine divergence.
    const driver = new MemoryDriver(spriteScene({ serialized: { color: { r: 0, g: 0, b: 0, a: 255 } } }));
    const output = await setOutput(driver,
        { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ffffff' });
    assert.match(output.stdout, /persisted=false/);
    assert.equal(output.stdout.split('  ')[0], 'UNPERSISTED');
    assert.equal(output.failed, true);
});

test('the serializer knows the property only under its backing-field name — both tries, found', async () => {
    const driver = new MemoryDriver({
        nodes: [{ name: 'Canvas', children: [{ name: 'Bg', components: [{
            type: 'cc.UIOpacity',
            props: { opacity: { name: 'opacity', type: 'Number', value: 255 } },
            serialized: { _opacity: 128 }
        }] }] }]
    });
    const output = await setOutput(driver,
        { node: 'Canvas/Bg', component: 'UIOpacity', property: 'opacity', value: 128 });
    assert.match(output.stdout, /persisted=true/);
});

test('a node without the requested property gives a refusal naming the properties it has', async () => {
    await assert.rejects(
        () => componentSet(new MemoryDriver(spriteScene()),
            { node: 'Canvas/Bg', component: 'Sprite', property: 'spriteFrame', value: 'x' }),
        /color/);
});

// ----- References --------------------------------------------------------------------------

const emptyRef = () => ({ ...fixtures.nodeRef, value: { uuid: '' } });

const npcScene = (extra = {}) => ({
    nodes: [
        { name: 'Canvas', children: [{ name: 'Bg', components: [{ type: 'Npc', props: { target: emptyRef() } }] }] },
        { name: 'Characters', children: [{ name: 'hero' }] }
    ],
    ...extra
});

const targetOf = (driver) => driver.componentsOf(driver.uuidOf('Canvas/Bg'))[0].props.target.value.uuid;

test('a node path reaches the scene as a resolved uuid rather than as the path string', async () => {
    const driver = new MemoryDriver(npcScene());
    const hero = driver.uuidOf('Characters/hero');
    const output = await setOutput(driver,
        { node: 'Canvas/Bg', component: 'Npc', property: 'target', value: 'Characters/hero' });

    const plan = driver.calls.find(call => call.name === 'resolveComponentReference');
    assert.equal(plan.args[0].targetUuid, hero);
    assert.match(output.stdout, /^ok/);
    assert.equal(output.failed, false);
});

test('a reference goes to the editor as a dump carrying a uuid, not as the raw --value', async () => {
    const driver = new MemoryDriver(npcScene());
    const hero = driver.uuidOf('Characters/hero');
    await componentSet(driver,
        { node: 'Canvas/Bg', component: 'Npc', property: 'target', value: 'Characters/hero' });

    assert.deepEqual(writeOf(driver).dump, { type: 'cc.Node', value: { uuid: hero } });
    assert.equal(targetOf(driver), hero);
});

test('a uuid in --value is accepted like a path and is not looked up in the scene', async () => {
    const driver = new MemoryDriver(npcScene());
    const hero = driver.uuidOf('Characters/hero');
    await componentSet(driver, { node: 'Canvas/Bg', component: 'Npc', property: 'target', value: hero });

    assert.ok(!driver.calls.some(call => call.name === 'resolveNodePaths' && call.args[0][0] === hero));
    assert.equal(targetOf(driver), hero);
});

test('an unresolvable path is refused BEFORE the write: the slot keeps its previous value', async () => {
    const driver = new MemoryDriver(npcScene());
    const hero = driver.uuidOf('Characters/hero');
    await componentSet(driver, { node: 'Canvas/Bg', component: 'Npc', property: 'target', value: hero });

    await assert.rejects(
        () => componentSet(driver,
            { node: 'Canvas/Bg', component: 'Npc', property: 'target', value: 'Characters/gone' }),
        /does not resolve/);
    assert.equal(targetOf(driver), hero);
});

test('a uuid absent from the scene is refused by the scene, and the slot stays untouched', async () => {
    const driver = new MemoryDriver(npcScene());
    const hero = driver.uuidOf('Characters/hero');
    await componentSet(driver, { node: 'Canvas/Bg', component: 'Npc', property: 'target', value: hero });
    const writesBefore = driver.calls.filter(call => call.name === 'scene.setProperty').length;

    const output = await setOutput(driver,
        { node: 'Canvas/Bg', component: 'Npc', property: 'target', value: 'zZzZzZzZzZzZzZzZzZzZzZ' });
    assert.equal(output.stdout.split('  ')[0], 'FAILED');
    assert.equal(output.failed, true);
    assert.equal(driver.calls.filter(call => call.name === 'scene.setProperty').length, writesBefore);
    assert.equal(targetOf(driver), hero);
});

test('an asset reference is taken by db:// path through the asset database', async () => {
    const driver = new MemoryDriver({
        nodes: [{ name: 'Canvas', children: [{ name: 'Bg', components: [{
            type: 'cc.Sprite', props: { spriteFrame: { ...fixtures.emptySpriteFrame } }
        }] }] }],
        assets: { 'db://assets/ui/icon.png/spriteFrame': 'a_icon' }
    });
    await componentSet(driver, {
        node: 'Canvas/Bg', component: 'Sprite', property: 'spriteFrame',
        value: 'db://assets/ui/icon.png/spriteFrame'
    });

    assert.deepEqual(writeOf(driver).dump, { type: 'cc.SpriteFrame', value: { uuid: 'a_icon' } });
});

test('an asset is not looked up by node name — refused before the write', async () => {
    const driver = new MemoryDriver({
        nodes: [{ name: 'Canvas', children: [{ name: 'Bg', components: [{
            type: 'cc.Sprite', props: { spriteFrame: { ...fixtures.spriteFrame } }
        }] }] }]
    });
    await assert.rejects(
        () => componentSet(driver,
            { node: 'Canvas/Bg', component: 'Sprite', property: 'spriteFrame', value: 'Canvas/Bg' }),
        /db:/);
    assert.ok(!driver.calls.some(call => call.name === 'scene.setProperty'));
});
