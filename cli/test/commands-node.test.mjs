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
            'Nope': { error: "path 'Nope' does not resolve — not even its first segment 'Nope'." },
            'Reference-Image-Canvas': { uuid: 'u_ric', matchedPath: 'Reference-Image-Canvas' }
        }
    }
};

// getNodeInfo здесь стейтфул: addComponent опрашивает его до и после навешивания. `accept`
// решает, регистрирует ли движок данное написание — по умолчанию любое.
const bareType = type => type.startsWith('cc.') ? type.slice(3) : type;
const FAST = { timeoutMs: 30, intervalMs: 5 };

const recorder = (overrides = {}) => {
    const calls = [];
    const components = new Map([['u_bg', ['Sprite']]]);
    const accept = overrides.acceptComponent || (() => true);

    return {
        calls,
        editor: {
            scene: {
                beginRecording: async (...a) => { calls.push(['beginRecording', ...a]); return 'r1'; },
                endRecording: async (...a) => { calls.push(['endRecording', ...a]); },
                cancelRecording: async () => { calls.push(['cancelRecording']); },
                createNode: async (...a) => {
                    calls.push(['createNode', ...a]);
                    components.set('u_new', []);
                    return 'u_new';
                },
                createComponent: async (options) => {
                    calls.push(['createComponent', options]);
                    if (!accept(options.component)) return;
                    components.get(options.uuid).push(bareType(options.component));
                },
                setProperty: async (...a) => { calls.push(['setProperty', ...a]); return true; }
            }
        },
        scene: {
            call: async (method, ...a) => {
                calls.push([method, ...a]);
                if (method === 'resolveNodePaths') return TREE;
                if (method === 'getNodeInfo') {
                    if (overrides.getNodeInfo) return overrides.getNodeInfo;
                    const [uuid] = a;
                    const types = components.get(uuid) || [];
                    return { success: true, data: { name: uuid === 'u_new' ? 'New' : 'Bg', uuid, active: true,
                        components: types.map(type => ({ type, enabled: true })) } };
                }
                if (method === 'addComponentToNode') {
                    const [uuid, type] = a;
                    if (!accept(type)) return { success: false, error: `Component type not found: ${type}` };
                    components.get(uuid).push(bareType(type));
                    return { success: true, data: { componentId: 'c1' } };
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
    const uuid = 'f0rQc7yj9Gpqltg+gTq5ZA'; // форма настоящего сжатого uuid Cocos: 22 base64-символа
    assert.equal(await resolveNode(driver, uuid), uuid);
    assert.equal(driver.calls.length, 0);
});

test('имя узла той же длины и алфавита, что uuid, всё равно разрешается путём', async () => {
    const driver = recorder();
    assert.equal(await resolveNode(driver, 'Reference-Image-Canvas'), 'u_ric');
    assert.ok(driver.calls.some(call => call[0] === 'resolveNodePaths'));
});

test('get отдаёт одну строку с именем, состоянием и компонентами', async () => {
    const text = await nodeGet(recorder(), 'Canvas/Bg');
    assert.match(text, /Bg/);
    assert.match(text, /Sprite/);
});

test('создание с компонентом укладывается в одну скобку undo', async () => {
    const driver = recorder();
    await nodeCreate(driver, { parent: 'Canvas/Bg', name: 'New', components: ['Sprite'] }, FAST);
    const names = driver.calls.map(c => c[0]);
    assert.equal(names[0], 'resolveNodePaths');
    assert.equal(names[1], 'beginRecording');
    assert.equal(names[names.length - 1], 'endRecording');
    assert.ok(names.includes('createNode'));
    assert.ok(names.includes('createComponent'));
});

test('отчёт называет зарегистрированное имя компонента, а не то, что попросили (L3)', async () => {
    const driver = recorder();
    const text = await nodeCreate(
        driver, { parent: 'Canvas/Bg', name: 'New', components: ['cc.MeshRenderer'] }, FAST);
    assert.match(text, /\[MeshRenderer\]/);
    assert.ok(!text.includes('cc.MeshRenderer'));
});

test('компонент, который движок так и не зарегистрировал, — отказ, а не тихий ok', async () => {
    const driver = recorder({ acceptComponent: () => false });
    await assert.rejects(
        () => nodeCreate(driver, { parent: 'Canvas/Bg', name: 'New', components: ['Nope'] }, FAST),
        /Nope/);
});

test('падение при добавлении компонента снимает скобку, а не оставляет её открытой', async () => {
    const driver = recorder({ acceptComponent: () => false });
    await assert.rejects(
        () => nodeCreate(driver, { parent: 'Canvas/Bg', name: 'New', components: ['Nope'] }, FAST));
    assert.ok(driver.calls.map(c => c[0]).includes('cancelRecording'));
});

test('get помечает неактивный узел и выключенный компонент как (off)', async () => {
    const text = await nodeGet(recorder({
        getNodeInfo: { success: true, data: { name: 'Bg', uuid: 'u_bg', active: false,
            components: [{ type: 'Sprite', enabled: false }] } }
    }), 'Canvas/Bg');
    assert.match(text, /Bg {2}\(off\)/);
    assert.match(text, /Sprite\(off\)/);
});

test('создание с позицией пишет её внутри той же скобки undo, а не после неё', async () => {
    const driver = recorder();
    await nodeCreate(driver, { parent: 'Canvas/Bg', name: 'New', components: [], pos: [1, 2, 3] });
    const names = driver.calls.map(c => c[0]);
    const beginIdx = names.indexOf('beginRecording');
    const endIdx = names.indexOf('endRecording');
    const setPropertyIdx = names.indexOf('setProperty');
    assert.ok(setPropertyIdx > beginIdx, 'setProperty не найден после beginRecording');
    assert.ok(setPropertyIdx < endIdx, 'setProperty оказался после endRecording — вне скобки');
    const setPropertyCall = driver.calls.find(c => c[0] === 'setProperty');
    assert.deepEqual(setPropertyCall[1].dump.value, { x: 1, y: 2, z: 3 });
});
