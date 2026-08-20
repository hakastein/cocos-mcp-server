import test from 'node:test';
import assert from 'node:assert/strict';

import { addComponent } from '../lib/commands/shared.js';

const FAST = { timeoutMs: 30, intervalMs: 5 };

// The engine registers a class under the spelling it accepted: an engine one as `cc.MeshRenderer`,
// a user one under its own name. The node dump answers exactly that, so the component list here is
// kept as registered names.
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
                        components.get(options.uuid).push(options.component);
                    }
                },
                queryNode: async uuid => {
                    calls.push(['queryNode', uuid]);
                    const types = components.get(uuid) || [];
                    return { __comps__: types.map(type => ({ type, value: {} })) };
                }
            }
        },
        scene: {
            call: async (method, ...args) => {
                calls.push([method, ...args]);
                if (method === 'addComponentToNode') {
                    const [uuid, type] = args;
                    if (!sceneAccepts(type)) return { success: false, error: `Component type not found: ${type}` };
                    components.get(uuid).push(type);
                    return { success: true, data: { componentId: 'c1' } };
                }
                return { success: true, data: {} };
            }
        }
    };
}

test('a component that appeared through the editor message is not alreadyPresent', async () => {
    const driver = makeDriver('n1', [], { editorAccepts: () => true });
    const outcome = await addComponent(driver, 'n1', 'Sprite', FAST);
    assert.equal(outcome.type, 'Sprite');
    assert.equal(outcome.alreadyPresent, false);
});

test('the report names the registered class name rather than the spelling from the request', async () => {
    const driver = makeDriver('n1', [], { editorAccepts: () => true });
    const outcome = await addComponent(driver, 'n1', 'cc.MeshRenderer', FAST);
    assert.equal(outcome.type, 'cc.MeshRenderer');
});

test('the editor silently ignores the bare name — the scene-method fallback adds it under the cc. spelling', async () => {
    const driver = makeDriver('n1', [], {
        editorAccepts: type => type.startsWith('cc.'),
        sceneAccepts: type => type.startsWith('cc.')
    });
    const outcome = await addComponent(driver, 'n1', 'MeshRenderer', FAST);
    assert.equal(outcome.type, 'cc.MeshRenderer');
    const tried = driver.calls.filter(c => c[0] === 'createComponent').map(c => c[1]);
    assert.ok(tried.includes('MeshRenderer'));
    assert.ok(tried.includes('cc.MeshRenderer'));
});

test('a component that appeared under no spelling is refused rather than passed off as ok', async () => {
    const driver = makeDriver('n1', ['Sprite'], { editorAccepts: () => false, sceneAccepts: () => false });
    await assert.rejects(
        () => addComponent(driver, 'n1', 'Nope', FAST),
        error => /Nope/.test(error.message) && /Sprite/.test(error.message));
});

test('already on the node — not added twice, and the report names what is already there', async () => {
    const driver = makeDriver('n1', ['cc.Sprite'], {});
    const outcome = await addComponent(driver, 'n1', 'cc.Sprite', FAST);
    assert.equal(outcome.alreadyPresent, true);
    assert.equal(outcome.type, 'cc.Sprite');
    assert.ok(!driver.calls.some(c => c[0] === 'createComponent'));
});

test('already on the node is recognized by the bare spelling too, not only by the registered one', async () => {
    const driver = makeDriver('n1', ['cc.Sprite'], {});
    const outcome = await addComponent(driver, 'n1', 'Sprite', FAST);
    assert.equal(outcome.alreadyPresent, true);
    assert.equal(outcome.type, 'cc.Sprite');
    assert.ok(!driver.calls.some(c => c[0] === 'createComponent'));
});
