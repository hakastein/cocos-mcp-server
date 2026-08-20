import test from 'node:test';
import assert from 'node:assert/strict';

import { componentSet } from '../lib/commands/component.js';
import { present } from '../lib/render/present.js';

/** A command answers with a report; the presenter turns it into lines and an exit code. */
const setOutput = async (...args) => present(await componentSet(...args));

const HERO_UUID = 'aQ1wErTyUiOpAsDfGhJkL2';

/**
 * `set-property` editing the node dump is exactly what the editor does when it accepts a write.
 * Without it the double answers a read with what was there before the write, and the read-back
 * check fails through the double's fault rather than the code's.
 */
function applySetProperty(components, path, dump) {
    const parts = path.split('.');
    let holder = components[Number(parts[1])].value;
    for (let at = 2; at < parts.length - 1; at++) holder = holder[parts[at]].value;
    const leaf = parts[parts.length - 1];
    holder[leaf] = { ...(holder[leaf] || {}), ...(dump.type ? { type: dump.type } : {}), value: dump.value };
}

/** A serializer that carries everything: it answers what the live dump does. A divergence is set explicitly where needed. */
function mirrorSerializer(components) {
    return property => {
        const descriptor = components[0].value[property];
        return descriptor
            ? { found: true, value: descriptor.value }
            : { found: false, reason: `the serializer does not emit '${property}'` };
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

test('a write is wrapped in an undo bracket', async () => {
    const driver = driverDouble({ components: sprite() });
    await componentSet(driver, { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ffffff' });
    const names = driver.calls.map(call => call[0]);
    assert.ok(names.indexOf('beginRecording') < names.indexOf('setProperty'));
    assert.ok(names.indexOf('setProperty') < names.indexOf('endRecording'));
    assert.ok(!names.includes('cancelRecording'));
});

test('the result arrives on stdout as a report rather than as a raw object', async () => {
    const output = await setOutput(driverDouble({ components: sprite() }),
        { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ffffff' });
    assert.match(output.stdout, /^ok/);
    assert.match(output.stdout, /cc\.Sprite\.color/);
    assert.match(output.stdout, /persisted=true/);
    assert.equal(output.failed, false);
});

test('a write accepts the prefixed spelling and names the registered class', async () => {
    const output = await setOutput(driverDouble({ components: sprite() }),
        { node: 'Canvas/Bg', component: 'cc.Sprite', property: 'color', value: '#ffffff' });
    assert.match(output.stdout, /cc\.Sprite\.color/);
});

test('a node without the requested component gives a refusal naming what it does carry', async () => {
    await assert.rejects(
        () => componentSet(driverDouble({ components: sprite() }),
            { node: 'Canvas/Bg', component: 'Label', property: 'string', value: 'hi' }),
        /Sprite/);
});

test('cc.Color gets the type hint and the value arrives parsed', async () => {
    const driver = driverDouble({ components: sprite() });
    await componentSet(driver, { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ff0000' });
    const call = driver.calls.find(entry => entry[0] === 'setProperty');
    assert.equal(call[1].dump.type, 'cc.Color');
    assert.deepEqual(call[1].dump.value, { r: 255, g: 0, b: 0, a: 255 });
});

test('the serializer emits a different value — persisted=false and a non-zero outcome', async () => {
    const output = await setOutput(
        driverDouble({
            components: sprite(),
            // The shape the serializer really emits for cc.Color is a channel object; here it is
            // BLACK against a written WHITE, that is, a genuine divergence.
            serializer: () => ({ found: true, value: { r: 0, g: 0, b: 0, a: 255 } })
        }),
        { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ffffff' });
    assert.match(output.stdout, /persisted=false/);
    assert.equal(output.stdout.split('  ')[0], 'UNPERSISTED');
    assert.equal(output.failed, true);
});

test('the serializer knows the property only under its backing-field name — both tries, found', async () => {
    const driver = driverDouble({
        components: [{ __type__: 'cc.UIOpacity', value: { opacity: { type: 'Number', value: 255 } } }],
        serializer: property => property === '_opacity'
            ? { found: true, value: 128 }
            : { found: false, reason: `the serializer does not emit '${property}'` }
    });
    const output = await setOutput(driver,
        { node: 'Canvas/Bg', component: 'UIOpacity', property: 'opacity', value: 128 });
    assert.match(output.stdout, /persisted=true/);
});

test('a node without the requested property gives a refusal naming the properties it has', async () => {
    await assert.rejects(
        () => componentSet(driverDouble({ components: sprite() }),
            { node: 'Canvas/Bg', component: 'Sprite', property: 'spriteFrame', value: 'x' }),
        /color/);
});

// ----- References --------------------------------------------------------------------------

const npc = () => [{
    __type__: 'Npc',
    value: { target: { type: 'cc.Node', value: { uuid: '' } } }
}];

/** A scene script answering a reference write the way the live one does: first a plan, then an outcome. */
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

test('a node path reaches the scene as a resolved uuid rather than as the path string', async () => {
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

test('a reference goes to the editor as a dump carrying a uuid, not as the raw --value', async () => {
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

test('a uuid in --value is accepted like a path and is not looked up in the scene', async () => {
    const components = npc();
    const driver = driverDouble({ components, references: referenceScript(components) });
    await componentSet(driver,
        { node: 'Canvas/Bg', component: 'Npc', property: 'target', value: HERO_UUID });

    assert.ok(!driver.calls.some(entry => entry[0] === 'resolveNodePaths' && entry[1][0] === HERO_UUID));
    assert.equal(components[0].value.target.value.uuid, HERO_UUID);
});

test('an unresolvable path is refused BEFORE the write: the slot keeps its previous value', async () => {
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

test('a uuid absent from the scene is refused by the scene, and the slot stays untouched', async () => {
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

test('an asset reference is taken by db:// path through the asset database', async () => {
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

test('an asset is not looked up by node name — refused before the write', async () => {
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
