/**
 * Адресация узла путём — единственный способ, которым агент называет узлы, поэтому неоднозначный
 * путь обязан быть громким отказом. Создание проверяется по составу вызовов: скобка undo
 * охватывает и структурный шаг, и настройку.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveNode, nodeGet, nodeCreate } from '../lib/commands/node.js';

const TREE = {
    success: true,
    data: {
        sceneName: 'main',
        nodeCount: 3,
        resolutions: {
            'Canvas/Bg': { uuid: 'u_bg', matchedPath: 'Canvas/Bg' },
            'Canvas/Btn': {
                error: "path 'Canvas/Btn' matches 2 nodes: Canvas/Btn#1, Canvas/Btn#2. Pass one of "
                    + 'those exact spellings — every member of a same-named sibling group carries its '
                    + 'position as #1, #2, #3 in child order.'
            },
            'Nope': { error: "path 'Nope' does not resolve — not even its first segment 'Nope'." }
        }
    }
};

const recorder = () => {
    const calls = [];
    return {
        calls,
        editor: {
            scene: {
                beginRecording: async (...a) => { calls.push(['beginRecording', ...a]); return 'r1'; },
                endRecording: async (...a) => { calls.push(['endRecording', ...a]); },
                cancelRecording: async () => { calls.push(['cancelRecording']); },
                createNode: async (...a) => { calls.push(['createNode', ...a]); return 'u_new'; },
                createComponent: async (...a) => { calls.push(['createComponent', ...a]); }
            }
        },
        scene: {
            call: async (method, ...a) => {
                calls.push([method, ...a]);
                if (method === 'resolveNodePaths') return TREE;
                if (method === 'getNodeInfo') {
                    return { success: true, data: { name: 'Bg', uuid: 'u_bg', active: true,
                        components: [{ type: 'Sprite', enabled: true }] } };
                }
                return { success: true, data: {} };
            }
        }
    };
};

test('путь превращается в uuid через scene-скрипт', async () => {
    assert.equal(await resolveNode(recorder(), 'Canvas/Bg'), 'u_bg');
});

test('неоднозначный путь — отказ, называющий обоих кандидатов', async () => {
    await assert.rejects(() => resolveNode(recorder(), 'Canvas/Btn'), /Canvas\/Btn/);
});

test('несуществующий путь — отказ, называющий его самого', async () => {
    await assert.rejects(() => resolveNode(recorder(), 'Nope'), /Nope/);
});

test('уже готовый uuid проходит без обращения к сцене', async () => {
    const driver = recorder();
    assert.equal(await resolveNode(driver, 'u_something_long_enough_uuid'), 'u_something_long_enough_uuid');
    assert.equal(driver.calls.length, 0);
});

test('get отдаёт одну строку с именем, состоянием и компонентами', async () => {
    const text = await nodeGet(recorder(), 'Canvas/Bg');
    assert.match(text, /Bg/);
    assert.match(text, /Sprite/);
});

test('создание с компонентом укладывается в одну скобку undo', async () => {
    const driver = recorder();
    await nodeCreate(driver, { parent: 'Canvas/Bg', name: 'New', components: ['Sprite'] });
    const names = driver.calls.map(c => c[0]);
    assert.equal(names[0], 'resolveNodePaths');
    assert.equal(names[1], 'beginRecording');
    assert.equal(names[names.length - 1], 'endRecording');
    assert.ok(names.includes('createNode'));
    assert.ok(names.includes('createComponent'));
});

test('падение посреди создания снимает скобку, а не оставляет её открытой', async () => {
    const driver = recorder();
    driver.editor.scene.createComponent = async () => { throw new Error('нет такого компонента'); };
    await assert.rejects(
        () => nodeCreate(driver, { parent: 'Canvas/Bg', name: 'New', components: ['Nope'] }),
        /нет такого компонента/);
    assert.ok(driver.calls.map(c => c[0]).includes('cancelRecording'));
});
