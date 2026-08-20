import test from 'node:test';
import assert from 'node:assert/strict';

import { componentSet } from '../lib/commands/component.js';
import { present } from '../lib/render/present.js';

/** Команда отвечает отчётом; строки и код выхода из него делает presenter. */
const setOutput = async (...args) => present(await componentSet(...args));

const HERO_UUID = 'aQ1wErTyUiOpAsDfGhJkL2';

/**
 * Правка `set-property` в дампе узла — ровно то, что делает редактор, принимая запись. Без этого
 * дубль отвечает на чтение тем, что лежало до записи, и проверка read-back проваливается по вине
 * дубля, а не кода.
 */
function applySetProperty(components, path, dump) {
    const parts = path.split('.');
    let holder = components[Number(parts[1])].value;
    for (let at = 2; at < parts.length - 1; at++) holder = holder[parts[at]].value;
    const leaf = parts[parts.length - 1];
    holder[leaf] = { ...(holder[leaf] || {}), ...(dump.type ? { type: dump.type } : {}), value: dump.value };
}

/** Сериализатор, несущий всё: отдаёт то же, что живой дамп. Расхождение задаётся явно, где нужно. */
function mirrorSerializer(components) {
    return property => {
        const descriptor = components[0].value[property];
        return descriptor
            ? { found: true, value: descriptor.value }
            : { found: false, reason: `сериализатор не отдаёт '${property}'` };
    };
}

function driverDouble({ components, serializer, assets = {}, nodes = {}, references } = {}) {
    const calls = [];
    const serialize = serializer || mirrorSerializer(components);
    const knownNodes = { 'Canvas/Bg': 'u_bg', ...nodes };

    return {
        calls,
        components,
        editor: {
            scene: {
                beginRecording: async () => { calls.push(['beginRecording']); return 'r1'; },
                endRecording: async () => { calls.push(['endRecording']); },
                cancelRecording: async () => { calls.push(['cancelRecording']); },
                setProperty: async args => {
                    calls.push(['setProperty', args]);
                    applySetProperty(components, args.path, args.dump);
                    return true;
                },
                queryNode: async () => ({ __comps__: components })
            },
            assetDb: {
                queryUuid: async url => { calls.push(['queryUuid', url]); return assets[url]; }
            }
        },
        scene: {
            call: async (method, ...args) => {
                calls.push([method, ...args]);
                if (method === 'resolveNodePaths') {
                    const [path] = args[0];
                    const uuid = knownNodes[path];
                    return {
                        success: true,
                        data: {
                            resolutions: {
                                [path]: uuid ? { uuid } : { error: `path '${path}' does not resolve` }
                            }
                        }
                    };
                }
                if (method === 'serializedComponentValue') {
                    return { success: true, data: serialize(args[2]) };
                }
                if (references && references[method]) return references[method](...args);
                return { success: true, data: {} };
            }
        }
    };
}

const sprite = () => [{
    __type__: 'cc.Sprite',
    value: { color: { type: 'cc.Color', value: { r: 255, g: 255, b: 255, a: 255 } } }
}];

test('запись обёрнута в скобку undo', async () => {
    const driver = driverDouble({ components: sprite() });
    await componentSet(driver, { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ffffff' });
    const names = driver.calls.map(call => call[0]);
    assert.ok(names.indexOf('beginRecording') < names.indexOf('setProperty'));
    assert.ok(names.indexOf('setProperty') < names.indexOf('endRecording'));
    assert.ok(!names.includes('cancelRecording'));
});

test('результат приходит отчётом на stdout, а не сырым объектом', async () => {
    const output = await setOutput(driverDouble({ components: sprite() }),
        { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ffffff' });
    assert.match(output.stdout, /^ok/);
    assert.match(output.stdout, /cc\.Sprite\.color/);
    assert.match(output.stdout, /persisted=true/);
    assert.equal(output.failed, false);
});

test('запись принимает приставочное написание и называет зарегистрированный класс', async () => {
    const output = await setOutput(driverDouble({ components: sprite() }),
        { node: 'Canvas/Bg', component: 'cc.Sprite', property: 'color', value: '#ffffff' });
    assert.match(output.stdout, /cc\.Sprite\.color/);
});

test('узел без запрошенного компонента — отказ, называющий, что там есть', async () => {
    await assert.rejects(
        () => componentSet(driverDouble({ components: sprite() }),
            { node: 'Canvas/Bg', component: 'Label', property: 'string', value: 'hi' }),
        /Sprite/);
});

test('cc.Color получает подсказку типа, и значение доезжает разобранным', async () => {
    const driver = driverDouble({ components: sprite() });
    await componentSet(driver, { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ff0000' });
    const call = driver.calls.find(entry => entry[0] === 'setProperty');
    assert.equal(call[1].dump.type, 'cc.Color');
    assert.deepEqual(call[1].dump.value, { r: 255, g: 0, b: 0, a: 255 });
});

test('сериализатор отдаёт другое значение — persisted=false и ненулевой исход', async () => {
    const output = await setOutput(
        driverDouble({
            components: sprite(),
            // Форма, которую реально отдаёт сериализатор для cc.Color — объект каналов; здесь это
            // ЧЁРНЫЙ при записанном БЕЛОМ, то есть настоящее расхождение.
            serializer: () => ({ found: true, value: { r: 0, g: 0, b: 0, a: 255 } })
        }),
        { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ffffff' });
    assert.match(output.stdout, /persisted=false/);
    assert.equal(output.stdout.split('  ')[0], 'UNPERSISTED');
    assert.equal(output.failed, true);
});

test('сериализатор знает свойство только под именем backing-поля — обе попытки, найдено', async () => {
    const driver = driverDouble({
        components: [{ __type__: 'cc.UIOpacity', value: { opacity: { type: 'Number', value: 255 } } }],
        serializer: property => property === '_opacity'
            ? { found: true, value: 128 }
            : { found: false, reason: `сериализатор не отдаёт '${property}'` }
    });
    const output = await setOutput(driver,
        { node: 'Canvas/Bg', component: 'UIOpacity', property: 'opacity', value: 128 });
    assert.match(output.stdout, /persisted=true/);
});

test('узел без запрошенного свойства — отказ, называющий, какие свойства есть', async () => {
    await assert.rejects(
        () => componentSet(driverDouble({ components: sprite() }),
            { node: 'Canvas/Bg', component: 'Sprite', property: 'spriteFrame', value: 'x' }),
        /color/);
});

// ----- Ссылки ------------------------------------------------------------------------------

const npc = () => [{
    __type__: 'Npc',
    value: { target: { type: 'cc.Node', value: { uuid: '' } } }
}];

/** Сцена-скрипт, отвечающий на ссылочную запись так же, как живой: сперва планом, потом исходом. */
function referenceScript(state) {
    return {
        resolveComponentReference: args => {
            const uuids = args.targetUuids || (args.targetUuid ? [args.targetUuid] : []);
            if (args.clear !== true && !uuids.every(uuid => uuid === HERO_UUID)) {
                return { success: false, error: `Target uuid '${uuids[0]}' matched no node and no component` };
            }
            const assigned = args.clear === true ? [] : uuids;
            return {
                success: true,
                data: {
                    componentIndex: 0, property: 'target', isArray: false, dumpType: 'cc.Node',
                    uuids: assigned, expected: assigned.length ? assigned : [null],
                    assignedKind: 'node', assignedNames: ['Hero'], assignedTypes: ['Node'],
                    declaredType: 'cc.Node', inferredType: null
                }
            };
        },
        componentReferenceOutcome: () => {
            const written = state[0].value.target.value.uuid || null;
            return {
                success: true,
                data: {
                    live: [written], serialized: [written], projected: [written],
                    projectionChecked: true, componentInSceneGraph: true, overrides: []
                }
            };
        }
    };
}

test('путь узла доезжает до сцены разрешённым uuid, а не строкой пути', async () => {
    const components = npc();
    const driver = driverDouble({
        components,
        nodes: { 'Characters/hero': HERO_UUID },
        references: referenceScript(components)
    });
    const output = await setOutput(driver,
        { node: 'Canvas/Bg', component: 'Npc', property: 'target', value: 'Characters/hero' });

    const plan = driver.calls.find(entry => entry[0] === 'resolveComponentReference');
    assert.equal(plan[1].targetUuid, HERO_UUID);
    assert.match(output.stdout, /^ok/);
    assert.equal(output.failed, false);
});

test('ссылка уходит в редактор дампом с uuid, а не сырым значением --value', async () => {
    const components = npc();
    const driver = driverDouble({
        components,
        nodes: { 'Characters/hero': HERO_UUID },
        references: referenceScript(components)
    });
    await componentSet(driver,
        { node: 'Canvas/Bg', component: 'Npc', property: 'target', value: 'Characters/hero' });

    const write = driver.calls.find(entry => entry[0] === 'setProperty');
    assert.deepEqual(write[1].dump, { type: 'cc.Node', value: { uuid: HERO_UUID } });
    assert.equal(components[0].value.target.value.uuid, HERO_UUID);
});

test('uuid в --value принимается наравне с путём и по сцене не ищется', async () => {
    const components = npc();
    const driver = driverDouble({ components, references: referenceScript(components) });
    await componentSet(driver,
        { node: 'Canvas/Bg', component: 'Npc', property: 'target', value: HERO_UUID });

    assert.ok(!driver.calls.some(entry => entry[0] === 'resolveNodePaths' && entry[1][0] === HERO_UUID));
    assert.equal(components[0].value.target.value.uuid, HERO_UUID);
});

test('неразрешимый путь — отказ ДО записи: слот остаётся с прежним значением', async () => {
    const components = npc();
    components[0].value.target.value.uuid = HERO_UUID;
    const driver = driverDouble({ components, references: referenceScript(components) });

    await assert.rejects(
        () => componentSet(driver,
            { node: 'Canvas/Bg', component: 'Npc', property: 'target', value: 'Characters/gone' }),
        /does not resolve/);
    assert.ok(!driver.calls.some(entry => entry[0] === 'setProperty'));
    assert.equal(components[0].value.target.value.uuid, HERO_UUID);
});

test('uuid, которого в сцене нет, — отказ сцены, слот не тронут', async () => {
    const components = npc();
    components[0].value.target.value.uuid = HERO_UUID;
    const driver = driverDouble({ components, references: referenceScript(components) });

    const output = await setOutput(driver,
        { node: 'Canvas/Bg', component: 'Npc', property: 'target', value: 'zZzZzZzZzZzZzZzZzZzZzZ' });
    assert.equal(output.stdout.split('  ')[0], 'FAILED');
    assert.equal(output.failed, true);
    assert.ok(!driver.calls.some(entry => entry[0] === 'setProperty'));
    assert.equal(components[0].value.target.value.uuid, HERO_UUID);
});

test('ассетная ссылка берётся db://-путём через базу ассетов', async () => {
    const components = [{
        __type__: 'cc.Sprite',
        value: { spriteFrame: { type: 'cc.SpriteFrame', extends: ['cc.Asset'], value: { uuid: '' } } }
    }];
    const driver = driverDouble({
        components,
        assets: { 'db://assets/ui/icon.png/spriteFrame': 'a_icon' }
    });
    await componentSet(driver, {
        node: 'Canvas/Bg', component: 'Sprite', property: 'spriteFrame',
        value: 'db://assets/ui/icon.png/spriteFrame'
    });

    const write = driver.calls.find(entry => entry[0] === 'setProperty');
    assert.deepEqual(write[1].dump, { type: 'cc.SpriteFrame', value: { uuid: 'a_icon' } });
});

test('ассет по имени узла не ищется — отказ до записи', async () => {
    const components = [{
        __type__: 'cc.Sprite',
        value: { spriteFrame: { type: 'cc.SpriteFrame', extends: ['cc.Asset'], value: { uuid: 'a_old' } } }
    }];
    const driver = driverDouble({ components });
    await assert.rejects(
        () => componentSet(driver,
            { node: 'Canvas/Bg', component: 'Sprite', property: 'spriteFrame', value: 'Canvas/Bg' }),
        /db:/);
    assert.ok(!driver.calls.some(entry => entry[0] === 'setProperty'));
});
