import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    componentAdd, componentArrayMove, componentArrayRemove, componentGet, componentRemove,
    componentReset, componentSet, componentTypes
} from '../src/commands/component.ts';
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

const instancedRenderer = (prefab) => new MemoryDriver({
    nodes: [{
        name: 'Bullet',
        prefab: { asset: 'prefab-uuid', ...prefab },
        components: [{
            type: 'cc.MeshRenderer',
            props: { shadowCastingMode: { name: 'shadowCastingMode', type: 'Number', value: 0, default: 0 } }
        }]
    }]
});

const castShadow = { node: 'Bullet', component: 'cc.MeshRenderer', property: 'shadowCastingMode', value: 1 };

// Checked live 2026-08-22 on CyberCore: setting `shadowCastingMode` on a prefab instance made the
// editor record the override as `_shadowCastingMode`, which the write's own spelling never found.
test('a write finds the override the editor recorded under the backing field', async () => {
    const output = await setOutput(
        instancedRenderer({ componentOverrides: { _shadowCastingMode: ['_shadowCastingMode'] } }), castShadow);
    assert.match(output.stdout, /^ok {2}cc\.MeshRenderer\.shadowCastingMode = 1/);
    assert.match(output.stdout, /persisted=true/);
    assert.match(output.stdout, /_shadowCastingMode/);
    assert.equal(output.failed, false);
});

test('the backing field agreeing with the asset carries nothing, so the write stays UNPERSISTED', async () => {
    const output = await setOutput(
        instancedRenderer({ componentOverrides: { _shadowCastingMode: [] } }), castShadow);
    assert.equal(output.stdout.split('  ')[0], 'UNPERSISTED');
    assert.equal(output.failed, true);
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

const FAST = { timeoutMs: 30, intervalMs: 5 };

const withGuard = () => new MemoryDriver({
    nodes: [{ name: 'Guard', components: [{ type: 'cc.Sprite' }] }],
    classes: ['cc.Sprite', 'cc.Camera']
});

test('add names the class the engine registered, not the spelling that was typed', async () => {
    const driver = withGuard();
    const output = present(await componentAdd(driver, {
        node: 'Guard', component: 'Camera', poll: FAST
    }));
    assert.match(output.stdout, /^ok {2}cc\.Camera added to Guard/);
    assert.ok(driver.componentsOf(driver.uuidOf('Guard')).some(one => one.type === 'cc.Camera'));
});

// The editor attaches a declared requirement ahead of the class asked for, so the dependency is
// the first component to appear on the node.
const withDependency = (attaches) => new MemoryDriver({
    nodes: [{ name: 'Guard' }], classes: [], attaches
});

test('add names the class asked for, not the dependency attached ahead of it', async () => {
    const driver = withDependency({ 'cc.Sprite': ['cc.UITransform', 'cc.Sprite'] });
    const output = present(await componentAdd(driver, {
        node: 'Guard', component: 'cc.Sprite', poll: FAST
    }));
    assert.match(output.stdout, /^ok {2}cc\.Sprite added to Guard/);
});

test('an add no spelling of which names what appeared is UNVERIFIED, naming what did', async () => {
    const driver = withDependency({ '2f3aRk1': ['cc.UITransform', 'cc.Sprite'] });
    const output = present(await componentAdd(driver, {
        node: 'Guard', component: '2f3aRk1', poll: FAST
    }));
    assert.equal(output.stdout,
        'UNVERIFIED  2f3aRk1 added to Guard  the node gained cc.UITransform, cc.Sprite'
        + ', nothing named 2f3aRk1 or cc.2f3aRk1');
    assert.equal(output.failed, false);
});

test('a class already on the node is said to be already there rather than added twice', async () => {
    const driver = withGuard();
    const output = present(await componentAdd(driver, {
        node: 'Guard', component: 'cc.Sprite', poll: FAST
    }));
    assert.match(output.stdout, /already on Guard/);
    assert.equal(driver.componentsOf(driver.uuidOf('Guard')).length, 1);
});

test('a class the engine never registered is refused rather than reported as added', async () => {
    const driver = new MemoryDriver({ nodes: [{ name: 'Guard' }], classes: [] });
    await assert.rejects(
        () => componentAdd(driver, { node: 'Guard', component: 'Nope', poll: FAST }), /Nope/);
});

// `remove-component` takes the component's own uuid, which the node dump does not carry — only the
// class-owner listing does, and a removal aimed at the node uuid would take the wrong thing.
test('rm reaches the editor with the component uuid the owner listing named', async () => {
    const driver = withGuard();
    const nodeUuid = driver.uuidOf('Guard');
    const componentUuid = driver.componentsOf(nodeUuid)[0].uuid;
    const output = present(await componentRemove(driver, { node: 'Guard', component: 'cc.Sprite' }));
    assert.match(output.stdout, /^ok {2}cc\.Sprite removed from Guard/);
    assert.equal(driver.calls.find(call => call.name === 'scene.removeComponent').args[0].uuid,
        componentUuid);
    assert.equal(driver.componentsOf(nodeUuid).length, 0);
});

test('a class the node does not carry is refused, naming what it does carry', async () => {
    await assert.rejects(
        () => componentRemove(withGuard(), { node: 'Guard', component: 'cc.Camera' }),
        /cc\.Sprite/);
});

test('get reads the properties of a component the way the inspector holds them', async () => {
    const output = present(await componentGet(new MemoryDriver(spriteScene()),
        { node: 'Canvas/Bg', component: 'Sprite' }));
    assert.match(output.stdout, /color/);
    assert.match(output.stderr, /cc\.Sprite/);
});

test('--prop prints that one value bare, for a shell to read', async () => {
    const output = present(await componentGet(new MemoryDriver(spriteScene()),
        { node: 'Canvas/Bg', component: 'Sprite', property: 'color' }));
    assert.equal(output.stdout, '#ffffffff');
});

test('a property the component does not declare is refused, naming the ones it has', async () => {
    await assert.rejects(
        () => componentGet(new MemoryDriver(spriteScene()),
            { node: 'Canvas/Bg', component: 'Sprite', property: 'tint' }),
        /no property 'tint'.*color/s);
});

const band = (upTo) => ({ name: 'upTo', type: 'Number', value: upTo, default: 0 });

const bandsProp = () => ({
    name: 'bands', type: 'Number', isArray: true, default: [], visible: true, extends: [],
    value: [band(1), band(2), band(3)]
});

const banded = () => new MemoryDriver({
    nodes: [{ name: 'Hero', components: [{ type: 'ClipBands', props: { bands: bandsProp() } }] }]
});

const bandsOf = (driver) =>
    driver.componentsOf(driver.uuidOf('Hero'))[0].props.bands.value.map(entry => entry.value);

test('moving an element forward puts it where the offset asked and reports the new order', async () => {
    const driver = banded();
    const output = present(await componentArrayMove(driver,
        { node: 'Hero', component: 'ClipBands', property: 'bands', index: 0, offset: 1 }));
    assert.deepEqual(bandsOf(driver), [2, 1, 3]);
    assert.match(output.stdout, /^ok/);
    assert.match(output.stdout, /element 0 moved to 1/);
});

test('a negative offset moves an element towards the front', async () => {
    const driver = banded();
    await componentArrayMove(driver,
        { node: 'Hero', component: 'ClipBands', property: 'bands', index: 2, offset: -2 });
    assert.deepEqual(bandsOf(driver), [3, 1, 2]);
});

// `move-array-element` answers `true` for an index it then ignores, so an out-of-range ask has to
// be refused here; forwarded, it would come back as a success that moved nothing.
test('an index outside the array is refused, naming how long the array is', async () => {
    await assert.rejects(
        () => componentArrayMove(banded(),
            { node: 'Hero', component: 'ClipBands', property: 'bands', index: 5, offset: 1 }),
        /3 element/);
});

test('an offset that would land outside the array is refused too', async () => {
    await assert.rejects(
        () => componentArrayMove(banded(),
            { node: 'Hero', component: 'ClipBands', property: 'bands', index: 2, offset: 1 }),
        /--offset 1/);
});

test('a property that is not an array is refused rather than moved as one', async () => {
    const driver = new MemoryDriver(spriteScene());
    await assert.rejects(
        () => componentArrayMove(driver,
            { node: 'Canvas/Bg', component: 'Sprite', property: 'color', index: 0, offset: 1 }),
        /not an array/);
});

test('removing an element drops it and reports what is left', async () => {
    const driver = banded();
    const output = present(await componentArrayRemove(driver,
        { node: 'Hero', component: 'ClipBands', property: 'bands', index: 1 }));
    assert.deepEqual(bandsOf(driver), [1, 3]);
    assert.match(output.stdout, /2 left/);
    assert.match(output.stdout, /persisted=true/);
});

test('an array edit is wrapped in an undo bracket', async () => {
    const driver = banded();
    await componentArrayRemove(driver,
        { node: 'Hero', component: 'ClipBands', property: 'bands', index: 1 });
    const names = driver.calls.map(call => call.name);
    assert.ok(names.indexOf('scene.beginRecording') < names.indexOf('scene.removeArrayElement'));
    assert.ok(names.indexOf('scene.removeArrayElement') < names.indexOf('scene.endRecording'));
});

const resettable = () => new MemoryDriver({
    nodes: [{ name: 'Canvas', children: [{ name: 'Bg', components: [
        { type: 'cc.Sprite', props: { color: white(), sizeMode: { name: 'sizeMode', type: 'Number', value: 2, default: 0 } } }
    ] }] }]
});

test('reset answers for the properties whose value moved, and for no others', async () => {
    const output = present(await componentReset(resettable(), { node: 'Canvas/Bg', component: 'Sprite' }));
    assert.match(output.stdout, /^ok {2}cc\.Sprite\.sizeMode = 0/);
    assert.doesNotMatch(output.stdout, /color/);
});

test('a component already at its defaults says so rather than listing nothing', async () => {
    const driver = resettable();
    await componentReset(driver, { node: 'Canvas/Bg', component: 'Sprite' });
    const output = present(await componentReset(driver, { node: 'Canvas/Bg', component: 'Sprite' }));
    assert.match(output.stdout, /nothing to write/);
    assert.equal(output.failed, false);
});

// Checked live on a prefab instance: `reset-component` moved the value and recorded no override,
// so the next load rebuilds the prefab's and the reset is gone.
test('a reset inside an instance that records no override is UNPERSISTED', async () => {
    const driver = new MemoryDriver({
        nodes: [{
            name: 'Hero',
            prefab: { asset: 'prefab-uuid', recordsOverrides: false },
            components: [{ type: 'Health', props: {
                maxHp: { name: 'maxHp', type: 'Number', value: 7, default: 1 }
            } }]
        }]
    });
    const output = present(await componentReset(driver, { node: 'Hero', component: 'Health' }));
    assert.match(output.stdout, /^UNPERSISTED {2}Health\.maxHp = 1/);
    assert.equal(output.failed, true);
});

test('reset is wrapped in an undo bracket', async () => {
    const driver = resettable();
    await componentReset(driver, { node: 'Canvas/Bg', component: 'Sprite' });
    const names = driver.calls.map(call => call.name);
    assert.ok(names.indexOf('scene.beginRecording') < names.indexOf('scene.resetComponent'));
    assert.ok(names.indexOf('scene.resetComponent') < names.indexOf('scene.endRecording'));
});

test('types lists what the editor offers to add, with the menu path it offers it under', async () => {
    const driver = new MemoryDriver({
        nodes: [],
        offeredComponents: [{ name: 'cc.Camera', cid: 'cc.Camera', path: 'Rendering/Camera' }]
    });
    const output = present(await componentTypes(driver));
    assert.match(output.stdout, /cc\.Camera/);
    assert.match(output.stdout, /Rendering\/Camera/);
    assert.match(output.stderr, /components offered: 1/);
});
