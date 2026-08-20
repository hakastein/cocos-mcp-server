import test from 'node:test';
import assert from 'node:assert/strict';

import { sceneTree, sceneInfo } from '../lib/commands/scene.js';
import { present } from '../lib/render/present.js';

const treeOutput = async (...args) => present(await sceneTree(...args));

const driver = (answers) => ({
    editor: { scene: {} },
    scene: { call: async (method) => answers[method] ?? { success: false, error: `нет ответа на ${method}` } }
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

test('дерево строится из дампа и сообщает число узлов', async () => {
    const output = await treeOutput(driver({ dumpSceneNodes: DUMP }), {});
    assert.equal(output.stderr, 'узлов: 2');
    assert.match(output.stdout, /Canvas {2}\[Canvas\]/);
    assert.match(output.stdout, /Bg {2}\[Sprite\]/);
});

test('отказ scene-скрипта поднимается как ошибка с его же текстом', async () => {
    await assert.rejects(
        () => sceneTree(driver({ dumpSceneNodes: { success: false, error: 'сцена не открыта' } }), {}),
        /сцена не открыта/);
});

test('дамп без узлов не притворяется деревом', async () => {
    const output = await treeOutput(
        driver({ dumpSceneNodes: { success: true, data: { nodes: [] } } }), {});
    assert.equal(output.stderr, 'узлов: 0');
    assert.match(output.stdout, /пусто|нет узлов/i);
});

test('info называет сцену и число узлов одной строкой', async () => {
    const text = present(await sceneInfo(driver({
        getCurrentSceneInfo: { success: true, data: { name: 'main', uuid: 'u1', nodeCount: 42 } }
    }))).stdout;
    assert.match(text, /main/);
    assert.match(text, /42/);
});
