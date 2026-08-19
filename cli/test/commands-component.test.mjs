import test from 'node:test';
import assert from 'node:assert/strict';

import { componentSet } from '../lib/commands/component.js';

const COLOR_DESCRIPTOR = { type: 'cc.Color', value: { r: 255, g: 255, b: 255, a: 255 } };

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
                    return { __comps__: [{ __type__: 'cc.Sprite', value: { color: COLOR_DESCRIPTOR } }] };
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
                queryNode: async () => ({ __comps__: [{ __type__: 'cc.Sprite', value: { color: COLOR_DESCRIPTOR } }] })
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
                    // Форма, которую реально отдаёт сериализатор для cc.Color — объект каналов,
                    // не строка; здесь это ЧЁРНЫЙ, при записанном БЕЛОМ — настоящее расхождение.
                    return { success: true, data: { found: true, value: { r: 0, g: 0, b: 0, a: 255 } } };
                }
                return { success: true, data: {} };
            }
        }
    };
    const text = await componentSet(driver,
        { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ffffff' });
    assert.match(text, /persisted=false/);
});

test('сериализатор знает свойство только под именем backing-поля — обе попытки, найдено', async () => {
    // 'opacity' — то, что пишет пользователь; сериализатор в этом дампе отдаёт только '_opacity'.
    // Числовой kind изолирует случай от расхождения формы (C1б) — только проверка спеллинга (C1а).
    const driver = {
        editor: {
            scene: {
                beginRecording: async () => 'r1',
                endRecording: async () => { },
                cancelRecording: async () => { },
                setProperty: async () => true,
                queryNode: async () => ({ __comps__: [{ __type__: 'cc.UIOpacity',
                    value: { opacity: { type: 'Number', value: 255 } } }] })
            }
        },
        scene: {
            call: async (method, ...args) => {
                if (method === 'resolveNodePaths') {
                    return { success: true, data: { resolutions: { 'Canvas/Bg': { uuid: 'u_bg' } } } };
                }
                if (method === 'getNodeInfo') {
                    return { success: true, data: { name: 'Bg', uuid: 'u_bg', active: true,
                        components: [{ type: 'UIOpacity', enabled: true }] } };
                }
                if (method === 'serializedComponentValue') {
                    const property = args[2];
                    if (property === '_opacity') return { success: true, data: { found: true, value: 128 } };
                    return { success: true, data: { found: false, reason: `сериализатор не отдаёт '${property}'` } };
                }
                return { success: true, data: {} };
            }
        }
    };
    const text = await componentSet(driver,
        { node: 'Canvas/Bg', component: 'UIOpacity', property: 'opacity', value: 128 });
    assert.match(text, /persisted=true/);
});

test('typedDump превращает ввод в структуру — сравнение идёт по спроецированной форме, не по сырой', async () => {
    // Сериализатор отвечает найденным на первую же попытку ('color'), так что сценарий не задевает
    // подбор спеллинга (C1а) — здесь только форма значения (C1б): '#ff0000' против {r,g,b,a}.
    const driver = {
        editor: {
            scene: {
                beginRecording: async () => 'r1',
                endRecording: async () => { },
                cancelRecording: async () => { },
                setProperty: async () => true,
                queryNode: async () => ({ __comps__: [{ __type__: 'cc.Sprite', value: { color: COLOR_DESCRIPTOR } }] })
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
                    return { success: true, data: { found: true, value: { r: 255, g: 0, b: 0, a: 255 } } };
                }
                return { success: true, data: {} };
            }
        }
    };
    const text = await componentSet(driver,
        { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ff0000' });
    assert.match(text, /persisted=true/);
});

test('узел без запрошенного свойства — отказ, называющий, какие свойства есть', async () => {
    await assert.rejects(
        () => componentSet(recorder(),
            { node: 'Canvas/Bg', component: 'Sprite', property: 'spriteFrame', value: 'x' }),
        /color/);
});

test('cc.Color получает подсказку типа, и значение доезжает разобранным', async () => {
    const driver = recorder();
    await componentSet(driver, { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ff0000' });
    const setPropertyCall = driver.calls.find(c => c[0] === 'setProperty');
    assert.equal(setPropertyCall[1].dump.type, 'cc.Color');
    assert.deepEqual(setPropertyCall[1].dump.value, { r: 255, g: 0, b: 0, a: 255 });
});
