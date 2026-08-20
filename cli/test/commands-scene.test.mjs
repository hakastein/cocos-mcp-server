import test from 'node:test';
import assert from 'node:assert/strict';

import { sceneTree, sceneInfo } from '../src/commands/scene.ts';
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
