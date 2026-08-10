import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    WRITERS, writerFor, buildClassElement, buildClassPatch, readBackMatches, readBackMismatches
} from '../dist/property/writers.js';
import { withoutUuidWrappers } from '../dist/property/verified-write.js';

const fixtures = JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/descriptors.json', import.meta.url)), 'utf8')
);

const PREFAB = '5965dcc0-7042-42a8-90ac-df7df5ede667';
const CLIP = '5965dcc0-7042-42a8-90ac-df7df5ede667';
const NODE = 'cd6e4f10-8a11-4d0e-8c22-0b3a9e77aa01';

const VALUES = {
    number: 2.5,
    string: 'backOut',
    boolean: true,
    vec3: { x: 2, y: 2, z: 2 },
    vec2: { x: 0.5, y: 0.5 },
    size: { width: 100, height: 40 },
    color: { r: 255, g: 128, b: 0, a: 200 },
    spriteFrame: PREFAB,
    emptySpriteFrame: PREFAB,
    materialArray: [PREFAB, PREFAB],
    materialArrayDescriptorElements: [PREFAB, PREFAB],
    nodeRef: NODE,
    nodeArray: [NODE],
    nodeArrayDescriptorElements: [NODE],
    componentRef: NODE,
    nestedClass: { duration: 1.25 },
    classArray: [{ spawnInterval: 1 }],
    assetClassArray: [{ count: 2 }],
    gradient: { colorKeys: [{ color: { r: 255, g: 0, b: 0, a: 255 }, time: 0 }] },
    curve: { keyframes: [{ time: 0, value: 1 }] },
    enum: 1,
    bitmask: 1108344832
};

function targetFor(name, overrides = {}) {
    const descriptor = fixtures[name];
    return {
        nodeUuid: 'node-1',
        componentType: 'TestComp',
        componentIndex: 2,
        propertyPath: descriptor.name || name,
        descriptor,
        ...overrides
    };
}

test('the writer order is the cascade order, declared in one array', () => {
    assert.deepEqual(WRITERS.map(writer => writer.name), [
        'gradient', 'curve', 'ui-transform-pair', 'class-array', 'nested-class',
        'asset-ref', 'node-ref', 'component-ref',
        'typed:color', 'typed:vec', 'typed:enum', 'typed:bitmask', 'typed:plain'
    ]);
});

test('every descriptor the editor emits is claimed by exactly one writer', () => {
    const claimed = {};
    for (const name of Object.keys(fixtures)) {
        const claimants = WRITERS.filter(writer => writer.claims(targetFor(name), VALUES[name]));
        assert.equal(claimants.length, 1,
            `${name} was claimed by [${claimants.map(writer => writer.name).join(', ')}]`);
        claimed[name] = claimants[0].name;
    }
    assert.deepEqual(claimed, {
        number: 'typed:plain',
        string: 'typed:plain',
        boolean: 'typed:plain',
        vec3: 'typed:vec',
        vec2: 'typed:vec',
        size: 'typed:vec',
        color: 'typed:color',
        spriteFrame: 'asset-ref',
        emptySpriteFrame: 'asset-ref',
        materialArray: 'asset-ref',
        materialArrayDescriptorElements: 'asset-ref',
        nodeRef: 'node-ref',
        nodeArray: 'node-ref',
        nodeArrayDescriptorElements: 'node-ref',
        componentRef: 'component-ref',
        nestedClass: 'nested-class',
        classArray: 'class-array',
        assetClassArray: 'class-array',
        gradient: 'gradient',
        curve: 'curve',
        enum: 'typed:enum',
        bitmask: 'typed:bitmask'
    });
});

test('an array field reaches the same writer as its element, which then reads isArray itself', () => {
    assert.equal(writerFor(targetFor('materialArray'), VALUES.materialArray).name,
        writerFor(targetFor('spriteFrame'), VALUES.spriteFrame).name);
    assert.equal(writerFor(targetFor('nodeArray'), VALUES.nodeArray).name,
        writerFor(targetFor('nodeRef'), VALUES.nodeRef).name);
});

test('a gradient or curve value without keys is patched member-wise, never replaced wholesale', () => {
    assert.equal(writerFor(targetFor('curve'), { constant: 5 }).name, 'nested-class');
    assert.equal(writerFor(targetFor('curve'), { mode: 0, multiplier: 2 }).name, 'nested-class');
    assert.equal(writerFor(targetFor('gradient'), { mode: 0, color: { r: 1, g: 2, b: 3 } }).name, 'nested-class');

    assert.equal(writerFor(targetFor('curve'), VALUES.curve).name, 'curve');
    assert.equal(writerFor(targetFor('curve'), [{ time: 0, value: 1 }]).name, 'curve');
    assert.equal(writerFor(targetFor('gradient'), { alphaKeys: [{ alpha: 0, time: 1 }] }).name, 'gradient');
});

test('the curve writer claims only the spelling its own body reads', () => {
    assert.equal(writerFor(targetFor('curve'), { keys: [{ time: 0, value: 1 }] }).name, 'nested-class');
    assert.equal(writerFor(targetFor('curve'), { spline: { keyFrames: [] } }).name, 'nested-class');
});

test('the UITransform pair is claimed by component and property, not by shape alone', () => {
    const pair = targetFor('size', { componentType: 'cc.UITransform', propertyPath: 'contentSize' });
    const underscored = targetFor('vec2', { componentType: 'cc.UITransform', propertyPath: '_anchorPoint' });
    const elsewhere = targetFor('size', { componentType: 'MyPanel', propertyPath: 'contentSize' });
    const otherVec = targetFor('vec3', { componentType: 'cc.UITransform', propertyPath: 'offset' });
    const nested = targetFor('size', { componentType: 'cc.UITransform', propertyPath: 'layout.contentSize' });

    assert.equal(writerFor(pair, VALUES.size).name, 'ui-transform-pair');
    assert.equal(writerFor(underscored, VALUES.vec2).name, 'ui-transform-pair');
    assert.equal(writerFor(elsewhere, VALUES.size).name, 'typed:vec');
    assert.equal(writerFor(otherVec, VALUES.vec3).name, 'typed:vec');
    assert.equal(writerFor(nested, VALUES.size).name, 'typed:vec');
});

test('a property with no descriptor still finds the plain writer', () => {
    const bare = { nodeUuid: 'node-1', componentType: 'TestComp', componentIndex: 0, propertyPath: 'speed', descriptor: {} };
    assert.equal(writerFor(bare, 7).name, 'typed:plain');
});

test('a read-back that agrees produces no mismatch, numbers within 1e-5 included', () => {
    assert.deepEqual(readBackMismatches(0.5, 0.5000001), []);
    assert.deepEqual(readBackMismatches('backOut', 'backOut'), []);
    assert.deepEqual(readBackMismatches(null, null), []);
    assert.deepEqual(readBackMismatches(2, '2'), []);
    assert.equal(readBackMatches({ x: 1, y: 2 }, { x: 1, y: 2, z: 0 }), true);
});

test('a read-back that disagrees names the path, the request and what was read', () => {
    assert.deepEqual(readBackMismatches(1, 2, 'count'), ['count: expected 1, read 2']);
    assert.deepEqual(readBackMismatches(0.5, 0.51, 'enter.duration'),
        ['enter.duration: expected 0.5, read 0.51']);
    assert.deepEqual(readBackMismatches('uuid-a', null, 'prefab'),
        ['prefab: expected "uuid-a", read null']);
    assert.equal(readBackMatches(1, 2), false);
});

test('a boolean is compared as a boolean: false is not 0, not "" and not "false"', () => {
    assert.deepEqual(readBackMismatches(false, 0, 'loop'), ['loop: expected false, read 0']);
    assert.deepEqual(readBackMismatches(true, 1, 'loop'), ['loop: expected true, read 1']);
    assert.deepEqual(readBackMismatches(false, '', 'loop'), ['loop: expected false, read ""']);
    assert.deepEqual(readBackMismatches(false, 'false', 'loop'), ['loop: expected false, read "false"']);
    assert.deepEqual(readBackMismatches(false, false), []);
    assert.deepEqual(readBackMismatches('', 0, 'label'), ['label: expected "", read 0']);
});

test('an array is compared by length and then element by element', () => {
    assert.deepEqual(readBackMismatches([1, 2], [1], 'waves'), ['waves: expected 2 element(s), read 1']);
    assert.deepEqual(readBackMismatches([1, 2], 7, 'waves'), ['waves: expected an array of 2, read 7']);
    assert.deepEqual(readBackMismatches([1, 2], [1, 3], 'waves'), ['waves.1: expected 2, read 3']);
});

test('only the members the write asked for are compared, so a patch is judged as a patch', () => {
    assert.deepEqual(readBackMismatches({ duration: 1.25 }, { duration: 1.25, easing: 'backOut' }), []);
    assert.deepEqual(readBackMismatches({ duration: 1.25 }, { duration: 2, easing: 'backOut' }, 'enter'),
        ['enter.duration: expected 1.25, read 2']);
    assert.deepEqual(readBackMismatches({ duration: 1 }, null, 'enter'),
        ['enter: expected {"duration":1}, read null']);
    assert.deepEqual(readBackMismatches(undefined, 'anything'), []);
});

test('a read-back the dump does not expose is a mismatch, not a silent pass', () => {
    assert.deepEqual(readBackMismatches('uuid-a', undefined, 'prefab'),
        ['prefab: expected "uuid-a", read undefined']);
});

test('a class array element keeps its references out of the inline dump and writes them by path', () => {
    const built = buildClassElement(
        fixtures.classArray.elementTypeData,
        { squads: [{ prefab: PREFAB, count: 5 }], spawnInterval: 1.5 },
        '__comps__.2.waves.0'
    );

    const squad = built.dump.value.squads.value[0];
    assert.equal('prefab' in squad.value, false);
    assert.equal(squad.value.count.value, 5);
    assert.deepEqual(built.refs, [
        { path: '__comps__.2.waves.0.squads.0.prefab', type: 'cc.Prefab', uuid: PREFAB }
    ]);
    assert.deepEqual(built.expected, {
        squads: [{ prefab: PREFAB, count: 5 }],
        spawnInterval: 1.5
    });
});

test('an element field the caller omitted takes the declared default, so an array is replaced whole', () => {
    const built = buildClassElement(fixtures.classArray.elementTypeData, {}, '__comps__.2.waves.0');
    assert.deepEqual(built.expected, { squads: [], spawnInterval: 0.8 });
    assert.deepEqual(built.refs, []);
});

test('an inline @ccclass is patched: untouched members keep their value, references leave the dump', () => {
    const patch = buildClassPatch(fixtures.nestedClass, { duration: 1.25, clip: CLIP }, '__comps__.1.enter');

    assert.equal('clip' in patch.dump.value, false);
    assert.equal(patch.dump.value.duration.value, 1.25);
    assert.equal(patch.dump.value.easing.value, 'backOut');
    assert.deepEqual(patch.refs, [
        { path: '__comps__.1.enter.clip', type: 'cc.AudioClip', uuid: CLIP }
    ]);
    assert.deepEqual(patch.expected, { duration: 1.25, clip: CLIP });
    assert.deepEqual(patch.unknown, []);
});

test('a member the class does not declare is named instead of written', () => {
    const patch = buildClassPatch(fixtures.nestedClass, { duration: 1, spin: 4 }, '__comps__.1.enter');
    assert.deepEqual(patch.unknown, ['spin']);
});

test('a reference reads the same on both sides of the serializer check, wrapper or bare uuid', () => {
    assert.equal(withoutUuidWrappers({ __uuid__: PREFAB }), PREFAB);
    assert.equal(withoutUuidWrappers({ uuid: PREFAB }), PREFAB);
    assert.equal(withoutUuidWrappers({ uuid: '' }), null);
    assert.deepEqual(withoutUuidWrappers({ duration: 0.5, clip: { __uuid__: CLIP } }),
        { duration: 0.5, clip: CLIP });
    assert.deepEqual(withoutUuidWrappers([{ uuid: PREFAB }, null]), [PREFAB, null]);
});

test('an object that only looks like a reference keeps its members', () => {
    assert.deepEqual(withoutUuidWrappers({ uuid: PREFAB, count: 3 }), { uuid: PREFAB, count: 3 });
    assert.deepEqual(withoutUuidWrappers({ x: 1, y: 2 }), { x: 1, y: 2 });
    assert.deepEqual(withoutUuidWrappers({}), {});
});

const writerNamed = (name) => WRITERS.find(writer => writer.name === name);

function referenceCtx({ projectionChecked = true, projected = [NODE], refuseSetProperty = false } = {}) {
    const answers = {
        resolveComponentReference: {
            success: true,
            data: {
                componentIndex: 2, property: 'target', isArray: false, dumpType: 'cc.Node',
                uuids: [NODE], expected: [NODE], assignedKind: 'node', assignedNames: [''],
                assignedTypes: [''], declaredType: 'cc.Node', inferredType: null
            }
        },
        applyComponentReference: { success: true, data: { property: 'target', assigned: [NODE] } },
        pruneComponentReferenceOverrides: { success: true, data: { removed: 0, paths: [] } },
        componentReferenceOutcome: {
            success: true,
            data: {
                live: [NODE], serialized: projected, projected, projectionChecked,
                componentInSceneGraph: true, overrides: []
            }
        }
    };
    return {
        sceneScript: { call: async (method) => answers[method] },
        editor: {
            scene: {
                setProperty: async () => {
                    if (refuseSetProperty) throw new Error('set-property refused');
                    return true;
                }
            }
        }
    };
}

test('a reference the next load rebuilds intact is persisted, and the editor channel is named', async () => {
    const report = await writerNamed('node-ref').write(targetFor('nodeRef'), NODE, referenceCtx());
    assert.equal(report.persisted, true);
    assert.equal(report.channel, 'editor');
    assert.equal(report.verified, true);
});

test('a reference the next load loses is persisted:false — proven, so a caller may fail on it', async () => {
    const report = await writerNamed('node-ref')
        .write(targetFor('nodeRef'), NODE, referenceCtx({ projected: [null] }));
    assert.equal(report.persisted, false);
    assert.equal(report.channel, 'editor');
    assert.match(report.detail, /the next load builds/);
});

test('an unreadable prefab asset is persisted:null — nobody looked, which is not "it is lost"', async () => {
    const report = await writerNamed('node-ref')
        .write(targetFor('nodeRef'), NODE, referenceCtx({ projectionChecked: false }));
    assert.equal(report.persisted, null);
    assert.equal(report.channel, 'editor');
    assert.match(report.detail, /NOT established/);
});

test('the live fallback is persisted:false on the live channel, which is that channel working', async () => {
    const report = await writerNamed('node-ref')
        .write(targetFor('nodeRef'), NODE, referenceCtx({ refuseSetProperty: true }));
    assert.equal(report.persisted, false);
    assert.equal(report.channel, 'live');
});

test('the editor channel alone claims nothing about a save: persisted stays null until checked', async () => {
    const target = targetFor('number');
    let written;
    const ctx = {
        editor: {
            scene: {
                setProperty: async ({ dump }) => { written = dump.value; return true; },
                queryNode: async () => ({
                    __comps__: [{}, {}, { value: { [target.propertyPath]: { type: 'Number', value: written } } }]
                })
            }
        }
    };
    const report = await writerNamed('typed:plain').write(target, 2.5, ctx);
    assert.equal(report.verified, true);
    assert.equal(report.persisted, null);
    assert.equal(report.channel, 'editor');
});
