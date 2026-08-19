import test from 'node:test';
import assert from 'node:assert/strict';

import { componentSet } from '../lib/commands/component.js';

const recorder = (over = {}) => {
    const calls = [];
    return {
        calls,
        editor: {
            scene: {
                beginRecording: async () => { calls.push(['beginRecording']); return 'r1'; },
                endRecording: async () => { calls.push(['endRecording']); },
                cancelRecording: async () => { calls.push(['cancelRecording']); },
                setProperty: async (...a) => { calls.push(['setProperty', ...a]); return true; },
                queryNode: async () => {
                    calls.push(['queryNode']);
                    return { __comps__: [{ __type__: 'cc.Sprite' }] };
                },
                ...over.scene
            }
        },
        scene: {
            call: async (method, ...a) => {
                calls.push([method, ...a]);
                if (method === 'resolveNodePaths') {
                    return { success: true, data: { resolutions: { 'Canvas/Bg': { uuid: 'u_bg' } } } };
                }
                if (method === 'getNodeInfo') {
                    return { success: true, data: { name: 'Bg', uuid: 'u_bg', active: true,
                        components: [{ type: 'Sprite', enabled: true }] } };
                }
                if (method === 'serializedComponentValue') {
                    return { success: true, data: { found: true, value: '#ffffff' } };
                }
                return { success: true, data: {} };
            }
        }
    };
};

test('запись обёрнута в скобку undo', async () => {
    const driver = recorder();
    await componentSet(driver, { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ffffff' });
    const names = driver.calls.map(c => c[0]);
    assert.ok(names.indexOf('beginRecording') < names.indexOf('setProperty'));
    assert.ok(names.indexOf('setProperty') < names.indexOf('endRecording'));
    assert.ok(!names.includes('cancelRecording'));
});

test('результат приходит строкой отчёта, а не сырым объектом', async () => {
    const text = await componentSet(recorder(),
        { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ffffff' });
    assert.equal(typeof text, 'string');
    assert.match(text, /Sprite\.color/);
    assert.match(text, /persisted=/);
});

test('узел без запрошенного компонента — отказ, называющий, что там есть', async () => {
    await assert.rejects(
        () => componentSet(recorder(),
            { node: 'Canvas/Bg', component: 'Label', property: 'string', value: 'hi' }),
        /Sprite/);
});

test('провал записи снимает скобку', async () => {
    const driver = recorder({ scene: { setProperty: async () => { throw new Error('отказ редактора'); } } });
    await assert.rejects(
        () => componentSet(driver,
            { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#fff' }),
        /отказ редактора/);
    assert.ok(driver.calls.map(c => c[0]).includes('cancelRecording'));
});

test('сериализатор отдаёт другое значение — persisted=false, не тихий ok', async () => {
    const driver = {
        editor: {
            scene: {
                beginRecording: async () => 'r1',
                endRecording: async () => { },
                cancelRecording: async () => { },
                setProperty: async () => true,
                queryNode: async () => ({ __comps__: [{ __type__: 'cc.Sprite' }] })
            }
        },
        scene: {
            call: async (method) => {
                if (method === 'resolveNodePaths') {
                    return { success: true, data: { resolutions: { 'Canvas/Bg': { uuid: 'u_bg' } } } };
                }
                if (method === 'getNodeInfo') {
                    return { success: true, data: { name: 'Bg', uuid: 'u_bg', active: true,
                        components: [{ type: 'Sprite', enabled: true }] } };
                }
                if (method === 'serializedComponentValue') {
                    return { success: true, data: { found: true, value: '#000000' } };
                }
                return { success: true, data: {} };
            }
        }
    };
    const text = await componentSet(driver,
        { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ffffff' });
    assert.match(text, /persisted=false/);
});
