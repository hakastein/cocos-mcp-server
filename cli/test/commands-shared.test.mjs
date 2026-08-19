import test from 'node:test';
import assert from 'node:assert/strict';

import { addComponent } from '../lib/commands/shared.js';

const FAST = { timeoutMs: 30, intervalMs: 5 };
const bareType = type => type.startsWith('cc.') ? type.slice(3) : type;

function makeDriver(nodeUuid, initialTypes, behavior = {}) {
    const calls = [];
    const components = new Map([[nodeUuid, [...initialTypes]]]);
    const editorAccepts = behavior.editorAccepts || (() => true);
    const sceneAccepts = behavior.sceneAccepts || (() => false);

    return {
        calls,
        editor: {
            scene: {
                createComponent: async options => {
                    calls.push(['createComponent', options.component]);
                    if (editorAccepts(options.component)) {
                        components.get(options.uuid).push(bareType(options.component));
                    }
                }
            }
        },
        scene: {
            call: async (method, ...args) => {
                calls.push([method, ...args]);
                if (method === 'getNodeInfo') {
                    const [uuid] = args;
                    const types = components.get(uuid) || [];
                    return { success: true, data: { name: 'N', uuid, active: true,
                        components: types.map(type => ({ type, enabled: true })) } };
                }
                if (method === 'addComponentToNode') {
                    const [uuid, type] = args;
                    if (!sceneAccepts(type)) return { success: false, error: `Component type not found: ${type}` };
                    components.get(uuid).push(bareType(type));
                    return { success: true, data: { componentId: 'c1' } };
                }
                return { success: true, data: {} };
            }
        }
    };
}

test('компонент появился через редакторское сообщение — не alreadyPresent', async () => {
    const driver = makeDriver('n1', [], { editorAccepts: () => true });
    const outcome = await addComponent(driver, 'n1', 'Sprite', FAST);
    assert.equal(outcome.type, 'Sprite');
    assert.equal(outcome.alreadyPresent, false);
});

test('запрошено с cc.-префиксом, а движок регистрирует голое имя — отчёт называет то, что реально появилось', async () => {
    const driver = makeDriver('n1', [], { editorAccepts: () => true });
    const outcome = await addComponent(driver, 'n1', 'cc.MeshRenderer', FAST);
    assert.equal(outcome.type, 'MeshRenderer');
});

test('голое имя редактор молча игнорирует — запасной путь через scene-метод добавляет под cc.-написанием', async () => {
    const driver = makeDriver('n1', [], {
        editorAccepts: type => type.startsWith('cc.'),
        sceneAccepts: type => type.startsWith('cc.')
    });
    const outcome = await addComponent(driver, 'n1', 'MeshRenderer', FAST);
    assert.equal(outcome.type, 'MeshRenderer');
    const tried = driver.calls.filter(c => c[0] === 'createComponent').map(c => c[1]);
    assert.ok(tried.includes('MeshRenderer'));
    assert.ok(tried.includes('cc.MeshRenderer'));
});

test('компонент так и не появился ни под одним написанием — отказ, а не тихий ok', async () => {
    const driver = makeDriver('n1', ['Sprite'], { editorAccepts: () => false, sceneAccepts: () => false });
    await assert.rejects(
        () => addComponent(driver, 'n1', 'Nope', FAST),
        error => /Nope/.test(error.message) && /Sprite/.test(error.message));
});

test('уже на узле — не добавляется повторно, отчёт называет то, что уже есть', async () => {
    const driver = makeDriver('n1', ['Sprite'], {});
    const outcome = await addComponent(driver, 'n1', 'cc.Sprite', FAST);
    assert.equal(outcome.alreadyPresent, true);
    assert.equal(outcome.type, 'Sprite');
    assert.ok(!driver.calls.some(c => c[0] === 'createComponent'));
});
