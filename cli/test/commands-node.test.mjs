/**
 * Addressing a node by path is the only way an agent names nodes, so an ambiguous path has to be a
 * loud refusal. Creation is checked by the sequence of calls: the undo bracket covers both the
 * structural step and the setup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveNode, nodeGet, nodeCreate } from '../lib/commands/node.js';
import { present } from '../lib/render/present.js';

const printed = async (report) => present(await report).stdout;

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

// The component list here is stateful: `node get` reads it through getNodeInfo and addComponent
// through the node dump, where a class carries its registered name. `accept` decides whether the
// engine registers a given spelling — by default any of them.
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
                    components.get(options.uuid).push(options.component);
                },
                queryNode: async (uuid) => {
                    calls.push(['queryNode', uuid]);
                    return { __comps__: (components.get(uuid) || []).map(type => ({ type, value: {} })) };
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
                    components.get(uuid).push(type);
                    return { success: true, data: { componentId: 'c1' } };
                }
                return { success: true, data: {} };
            }
        }
    };
};

test('a path becomes a uuid through the scene script', async () => {
    assert.equal(await resolveNode(recorder(), 'Canvas/Bg'), 'u_bg');
});

test('an ambiguous path is refused, naming both candidates', async () => {
    await assert.rejects(() => resolveNode(recorder(), 'Canvas/Btn'), /Canvas\/Btn/);
});

test('a path that exists nowhere is refused, quoted back', async () => {
    await assert.rejects(() => resolveNode(recorder(), 'Nope'), /Nope/);
});

test('a uuid already in hand passes without reaching the scene', async () => {
    const driver = recorder();
    const uuid = 'f0rQc7yj9Gpqltg+gTq5ZA'; // the shape of a real compressed Cocos uuid: 22 base64 chars
    assert.equal(await resolveNode(driver, uuid), uuid);
    assert.equal(driver.calls.length, 0);
});

test('a node name of the same length and alphabet as a uuid still resolves as a path', async () => {
    const driver = recorder();
    assert.equal(await resolveNode(driver, 'Reference-Image-Canvas'), 'u_ric');
    assert.ok(driver.calls.some(call => call[0] === 'resolveNodePaths'));
});

test('get answers one line with the name, the state and the components', async () => {
    const text = await printed(nodeGet(recorder(), 'Canvas/Bg'));
    assert.match(text, /Bg/);
    assert.match(text, /Sprite/);
});

test('creating with a component fits in one undo bracket', async () => {
    const driver = recorder();
    await nodeCreate(driver, { parent: 'Canvas/Bg', name: 'New', components: ['Sprite'] }, FAST);
    const names = driver.calls.map(c => c[0]);
    assert.equal(names[0], 'resolveNodePaths');
    assert.equal(names[1], 'beginRecording');
    assert.equal(names[names.length - 1], 'endRecording');
    assert.ok(names.includes('createNode'));
    assert.ok(names.includes('createComponent'));
});

test('the report names the registered component name rather than the one asked for (L3)', async () => {
    const driver = recorder({ acceptComponent: type => type.startsWith('cc.') });
    const text = await printed(nodeCreate(
        driver, { parent: 'Canvas/Bg', name: 'New', components: ['MeshRenderer'] }, FAST));
    assert.match(text, /\[cc\.MeshRenderer\]/);
});

test('a component the engine never registered is refused rather than passed off as ok', async () => {
    const driver = recorder({ acceptComponent: () => false });
    await assert.rejects(
        () => nodeCreate(driver, { parent: 'Canvas/Bg', name: 'New', components: ['Nope'] }, FAST),
        /Nope/);
});

test('a failure while adding a component drops the bracket instead of leaving it open', async () => {
    const driver = recorder({ acceptComponent: () => false });
    await assert.rejects(
        () => nodeCreate(driver, { parent: 'Canvas/Bg', name: 'New', components: ['Nope'] }, FAST));
    assert.ok(driver.calls.map(c => c[0]).includes('cancelRecording'));
});

test('get marks an inactive node and a disabled component as (off)', async () => {
    const text = await printed(nodeGet(recorder({
        getNodeInfo: { success: true, data: { name: 'Bg', uuid: 'u_bg', active: false,
            components: [{ type: 'Sprite', enabled: false }] } }
    }), 'Canvas/Bg'));
    assert.match(text, /Bg {2}\(off\)/);
    assert.match(text, /Sprite\(off\)/);
});

test('creating with a position writes it inside that same undo bracket, not after it', async () => {
    const driver = recorder();
    await nodeCreate(driver, { parent: 'Canvas/Bg', name: 'New', components: [], pos: [1, 2, 3] });
    const names = driver.calls.map(c => c[0]);
    const beginIdx = names.indexOf('beginRecording');
    const endIdx = names.indexOf('endRecording');
    const setPropertyIdx = names.indexOf('setProperty');
    assert.ok(setPropertyIdx > beginIdx, 'setProperty is not after beginRecording');
    assert.ok(setPropertyIdx < endIdx, 'setProperty landed after endRecording — outside the bracket');
    const setPropertyCall = driver.calls.find(c => c[0] === 'setProperty');
    assert.deepEqual(setPropertyCall[1].dump.value, { x: 1, y: 2, z: 3 });
});
