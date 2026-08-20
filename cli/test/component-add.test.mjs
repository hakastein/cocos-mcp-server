import test from 'node:test';
import assert from 'node:assert/strict';

import { addComponent } from '../src/component-add.ts';
import { MemoryDriver } from '../src/driver/memory.ts';

const FAST = { timeoutMs: 30, intervalMs: 5 };

// The engine registers a class under the spelling it accepted: an engine one as `cc.MeshRenderer`,
// a user one under its own name. The node dump answers exactly that.
const scene = (already, classes) => new MemoryDriver({
    nodes: [{ name: 'Hero', components: already.map(type => ({ type })) }],
    ...(classes === undefined ? {} : { classes })
});

const tried = (driver) => driver.calls
    .filter(call => call.name === 'scene.createComponent')
    .map(call => call.args[0].component);

test('a component that appeared through the editor message is not alreadyPresent', async () => {
    const driver = scene([]);
    const outcome = await addComponent(driver, driver.uuidOf('Hero'), 'Sprite', FAST);
    assert.equal(outcome.type, 'Sprite');
    assert.equal(outcome.alreadyPresent, false);
});

test('the report names the registered class name rather than the spelling from the request', async () => {
    const driver = scene([]);
    const outcome = await addComponent(driver, driver.uuidOf('Hero'), 'cc.MeshRenderer', FAST);
    assert.equal(outcome.type, 'cc.MeshRenderer');
});

test('the editor silently ignores the bare name — the cc. spelling is what registers', async () => {
    const driver = scene([], ['cc.MeshRenderer']);
    const outcome = await addComponent(driver, driver.uuidOf('Hero'), 'MeshRenderer', FAST);
    assert.equal(outcome.type, 'cc.MeshRenderer');
    assert.deepEqual(tried(driver), ['MeshRenderer', 'cc.MeshRenderer']);
});

test('a component that appeared under no spelling is refused rather than passed off as ok', async () => {
    const driver = scene(['Sprite'], []);
    await assert.rejects(
        () => addComponent(driver, driver.uuidOf('Hero'), 'Nope', FAST),
        error => /Nope/.test(error.message) && /Sprite/.test(error.message));
});

test('already on the node — not added twice, and the report names what is already there', async () => {
    const driver = scene(['cc.Sprite']);
    const outcome = await addComponent(driver, driver.uuidOf('Hero'), 'cc.Sprite', FAST);
    assert.equal(outcome.alreadyPresent, true);
    assert.equal(outcome.type, 'cc.Sprite');
    assert.deepEqual(tried(driver), []);
});

test('already on the node is recognized by the bare spelling too, not only by the registered one', async () => {
    const driver = scene(['cc.Sprite']);
    const outcome = await addComponent(driver, driver.uuidOf('Hero'), 'Sprite', FAST);
    assert.equal(outcome.alreadyPresent, true);
    assert.equal(outcome.type, 'cc.Sprite');
    assert.deepEqual(tried(driver), []);
});
