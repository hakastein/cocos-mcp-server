import test from 'node:test';
import assert from 'node:assert/strict';

import { sceneTree, sceneInfo } from '../lib/commands/scene.js';
import { present } from '../lib/render/present.js';

const treeOutput = async (...args) => present(await sceneTree(...args));

const driver = (answers) => ({
    editor: { scene: {} },
    scene: { call: async (method) => answers[method] ?? { success: false, error: `no answer for ${method}` } }
});

const DUMP = {
    success: true,
    data: {
        sceneName: 'main',
        nodeCount: 2,
        nodes: [
            { uuid: 'a', name: 'Canvas', parentUuid: 'root', active: true, components: [{ type: 'Canvas' }] },
            { uuid: 'b', name: 'Bg', parentUuid: 'a', active: true, components: [{ type: 'Sprite' }] }
        ]
    }
};

test('the tree is built from the dump and reports the node count', async () => {
    const output = await treeOutput(driver({ dumpSceneNodes: DUMP }), {});
    assert.equal(output.stderr, 'nodes: 2');
    assert.match(output.stdout, /Canvas {2}\[Canvas\]/);
    assert.match(output.stdout, /Bg {2}\[Sprite\]/);
});

test('a refusal from the scene script surfaces as an error carrying its own text', async () => {
    await assert.rejects(
        () => sceneTree(driver({ dumpSceneNodes: { success: false, error: 'no scene is open' } }), {}),
        /no scene is open/);
});

test('a dump with no nodes does not pretend to be a tree', async () => {
    const output = await treeOutput(
        driver({ dumpSceneNodes: { success: true, data: { nodes: [] } } }), {});
    assert.equal(output.stderr, 'nodes: 0');
    assert.match(output.stdout, /empty|no nodes/i);
});

test('info names the scene and its node count on one line', async () => {
    const text = present(await sceneInfo(driver({
        getCurrentSceneInfo: { success: true, data: { name: 'main', uuid: 'u1', nodeCount: 42 } }
    }))).stdout;
    assert.match(text, /main/);
    assert.match(text, /42/);
});
