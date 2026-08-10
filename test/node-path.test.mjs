/**
 * Path addressing: schema augmentation, resolution against a node tree, and the two failures
 * that must be loud — a path that matches nothing and a path that matches several nodes.
 *
 * The tree side is exercised against a plain object tree of the same shape the engine hands
 * the scene script, so the whole matching rule is testable without an editor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import np from '../dist/node-path.js';
import { assetTools } from '../dist/tools-v2/asset.js';
import { prefabTools } from '../dist/tools-v2/prefab.js';
import { sceneTools } from '../dist/tools-v2/scene.js';
import { nodeTools } from '../dist/tools-v2/node.js';
import { componentTools } from '../dist/tools-v2/component.js';
import { ToolRegistry } from '../dist/registry.js';

const {
    augmentToolDefinition, applyResolvedPaths, requestedPaths, pairsOf,
    buildPathIndex, resolvePathInIndex, normalizePath, UUID_OR_PATH_KEY
} = np;

const node = (name, uuid, children = []) => ({ name, uuid, children });

const scene = {
    children: [
        node('InteractivePoints', 'u_points', [
            node('InteractionPad_01', 'u_pad1', [
                node('interactive_frame_progressbar', 'u_bar1'),
                node('interactive_frame', 'u_frame1')
            ]),
            node('InteractionPad_02', 'u_pad2', [
                node('interactive_frame_progressbar', 'u_bar2')
            ])
        ]),
        node('Crowd', 'u_crowd', [
            node('Gangster', 'u_g1', [node('Hat', 'u_h1')]),
            node('Gangster', 'u_g2', [node('Hat', 'u_h2')]),
            node('Gangster', 'u_g3')
        ]),
        node('UICanvas', 'u_canvas', [node('HUD', 'u_hud', [node('Res_cash', 'u_cash')])])
    ]
};

const index = buildPathIndex(scene);

// ----- resolution ---------------------------------------------------------------------

test('an unambiguous path resolves to its uuid', () => {
    const r = resolvePathInIndex(index, 'InteractivePoints/InteractionPad_01');
    assert.equal(r.uuid, 'u_pad1');
    assert.equal(r.matchedPath, 'InteractivePoints/InteractionPad_01');
});

test('a deep path resolves', () => {
    assert.equal(resolvePathInIndex(index, 'UICanvas/HUD/Res_cash').uuid, 'u_cash');
});

test('the same leaf name under different parents stays distinct', () => {
    assert.equal(resolvePathInIndex(index, 'InteractivePoints/InteractionPad_01/interactive_frame_progressbar').uuid, 'u_bar1');
    assert.equal(resolvePathInIndex(index, 'InteractivePoints/InteractionPad_02/interactive_frame_progressbar').uuid, 'u_bar2');
});

test('surrounding slashes and blanks are tolerated', () => {
    assert.equal(normalizePath('  /UICanvas/HUD/  '), 'UICanvas/HUD');
    assert.equal(resolvePathInIndex(index, ' /UICanvas/HUD/ ').uuid, 'u_hud');
});

test('same-named siblings are addressable by their #N suffix, the first one included', () => {
    assert.equal(resolvePathInIndex(index, 'Crowd/Gangster#1').uuid, 'u_g1');
    assert.equal(resolvePathInIndex(index, 'Crowd/Gangster#2').uuid, 'u_g2');
    assert.equal(resolvePathInIndex(index, 'Crowd/Gangster#3/').uuid, 'u_g3');
    assert.equal(resolvePathInIndex(index, 'Crowd/Gangster#2/Hat').uuid, 'u_h2');
});

test('the bare name of same-named siblings is an ambiguity error listing every spelling', () => {
    const r = resolvePathInIndex(index, 'Crowd/Gangster');
    assert.equal(r.uuid, undefined);
    assert.match(r.error, /matches 3 nodes/);
    assert.match(r.error, /Crowd\/Gangster#1, Crowd\/Gangster#2, Crowd\/Gangster#3/);
});

test('an ambiguous path is never silently resolved to the first match', () => {
    // the exact regression: 'Crowd/Gangster/Hat' used to be BOTH the address of the first
    // gangster's hat and the ambiguous name of two, and exactness won without a word
    const r = resolvePathInIndex(index, 'Crowd/Gangster/Hat');
    assert.equal(r.uuid, undefined);
    assert.match(r.error, /matches 2 nodes/);
    assert.match(r.error, /Crowd\/Gangster#1\/Hat, Crowd\/Gangster#2\/Hat/);
});

test('a node whose name is unique among its siblings keeps a bare label', () => {
    assert.equal(resolvePathInIndex(index, 'Crowd').uuid, 'u_crowd');
    assert.equal(resolvePathInIndex(index, 'Crowd#1').uuid, undefined);
});

test('an unresolvable leaf names the deepest existing prefix and its children', () => {
    const r = resolvePathInIndex(index, 'InteractivePoints/InteractionPad_01/progressbar');
    assert.match(r.error, /does not resolve/);
    assert.match(r.error, /'InteractivePoints\/InteractionPad_01' exists/);
    assert.match(r.error, /interactive_frame_progressbar/);
    assert.match(r.error, /interactive_frame/);
});

test('an unresolvable first segment names the scene roots', () => {
    const r = resolvePathInIndex(index, 'Nope/Deeper');
    assert.match(r.error, /not even its first segment 'Nope'/);
    assert.match(r.error, /The scene roots are: InteractivePoints, Crowd, UICanvas\./);
});

test('an empty path is an error, not a match on the scene root', () => {
    assert.match(resolvePathInIndex(index, '   ').error, /empty path/);
    assert.match(resolvePathInIndex(index, '/').error, /empty path/);
});

test('a prefix that is itself ambiguous still reports a usable nearer prefix', () => {
    const r = resolvePathInIndex(index, 'Crowd/Gangster/Boots');
    assert.match(r.error, /does not resolve/);
    assert.match(r.error, /'Crowd' exists/);
});

// ----- schema augmentation ------------------------------------------------------------

const componentToolNamed = (name) => componentTools.find(t => t.name === name);

test('the reference-writing tool gains nodePath, targetPath and targetPaths', () => {
    const augmented = augmentToolDefinition(componentToolNamed('component_set_component_property'));
    const props = augmented.inputSchema.properties;
    for (const name of ['nodePath', 'targetPath', 'targetPaths']) {
        assert.ok(props[name], `${name} missing`);
    }
    assert.equal(props.targetPaths.type, 'array');
    assert.equal(props.targetPath.type, 'string');
});

test('the path parameter says outright that it wins over the uuid', () => {
    const augmented = augmentToolDefinition(componentToolNamed('component_set_component_property'));
    assert.match(augmented.inputSchema.properties.nodePath.description, /WINS when nodeUuid is also given/);
    assert.match(augmented.description, /preferred when both are given/);
});

test('a uuid that was required is no longer required on its own, but the pair still is', () => {
    const original = componentToolNamed('component_set_component_property');
    assert.ok(original.inputSchema.required.includes('nodeUuid'));

    const augmented = augmentToolDefinition(original);
    assert.ok(!augmented.inputSchema.required.includes('nodeUuid'));

    const pair = pairsOf(augmented.inputSchema).find(p => p.uuid === 'nodeUuid');
    assert.equal(pair.required, true);

    const missing = applyResolvedPaths('component_set_component_property', augmented.inputSchema,
        { componentType: 'Purchase', property: 'noMoney' }, {});
    assert.equal(missing.ok, false);
    assert.match(missing.error, /'nodeUuid' or 'nodePath'/);
});

test('a uuid that was optional stays optional', () => {
    const augmented = new ToolRegistry(nodeTools).list().find(t => t.name === 'node_create_node');
    const pair = pairsOf(augmented.inputSchema).find(p => p.uuid === 'parentUuid');
    assert.ok(pair, 'node_create_node should accept parentPath');
    assert.equal(pair.required, false);
    const applied = applyResolvedPaths('node_create_node', augmented.inputSchema, { name: 'X' }, {});
    assert.equal(applied.ok, true, applied.error);
});

test('augmenting a tool with no node arguments changes nothing', () => {
    const original = sceneTools.find(tool => tool.name === 'scene_get_current_scene');
    assert.equal(augmentToolDefinition(original), original);
});

test('every tool taking a node uuid gains the matching path, across all categories', () => {
    const surveyed = [
        ...prefabTools,
        ...sceneTools,
        ...componentTools,
        ...new ToolRegistry(nodeTools).list()
    ];
    let covered = 0;
    for (const tool of surveyed) {
        const uuidParams = Object.keys(tool.inputSchema?.properties || {})
            .filter(n => ['nodeUuid', 'targetUuid', 'targetUuids', 'parentUuid', 'rootUuid'].includes(n));
        if (!uuidParams.length) continue;
        const augmented = augmentToolDefinition(tool);
        for (const uuidParam of uuidParams) {
            const pair = pairsOf(augmented.inputSchema).find(p => p.uuid === uuidParam);
            assert.ok(pair, `${tool.name}: ${uuidParam} got no path spelling`);
            assert.ok(augmented.inputSchema.properties[pair.path], `${tool.name}: ${pair.path} not declared`);
            covered++;
        }
    }
    assert.ok(covered > 15, `the loop found almost nothing to cover (${covered}) — the survey is broken, not the feature`);
});

test('the file-based prefab tools advertise no scene-node argument and no path pair', () => {
    // nodePath scopes these writes to the .prefab file; a resolved scene uuid would land elsewhere
    const advertised = new ToolRegistry(prefabTools).list();
    const sceneUuidParams = [
        'nodeUuid', 'targetUuid', 'targetUuids', 'parentUuid', 'newParentUuid', 'rootUuid', 'uuid'
    ];
    for (const name of [
        'prefab_dump', 'prefab_validate_prefab', 'prefab_add_component', 'prefab_remove_component',
        'prefab_get_component_property', 'prefab_set_component_property'
    ]) {
        const tool = advertised.find(t => t.name === name);
        assert.ok(tool, `${name} is not on the prefab surface`);
        assert.deepEqual(pairsOf(tool.inputSchema), [], `${name} gained a uuid/path pair`);
        assert.deepEqual(
            Object.keys(tool.inputSchema.properties).filter(p => sceneUuidParams.includes(p)),
            [],
            `${name} declares a scene-node argument`
        );
    }
});

// ----- applying resolutions -----------------------------------------------------------

const refSchema = augmentToolDefinition(componentToolNamed('component_set_component_property')).inputSchema;

test('requestedPaths collects singles and arrays without duplicates', () => {
    const paths = requestedPaths(refSchema, {
        nodePath: 'A/B',
        targetPaths: ['A/B', 'C/D']
    });
    assert.deepEqual(paths, ['A/B', 'C/D']);
});

test('a resolved path becomes the uuid argument and the path argument is consumed', () => {
    const applied = applyResolvedPaths('component_set_component_property', refSchema, {
        nodePath: 'InteractivePoints/InteractionPad_01',
        componentType: 'Purchase',
        property: 'noMoney'
    }, {
        'InteractivePoints/InteractionPad_01': { uuid: 'u_pad1', matchedPath: 'InteractivePoints/InteractionPad_01' }
    });
    assert.equal(applied.ok, true, applied.error);
    assert.equal(applied.args.nodeUuid, 'u_pad1');
    assert.equal('nodePath' in applied.args, false);
    assert.deepEqual(applied.resolved[0], {
        parameter: 'nodePath', path: 'InteractivePoints/InteractionPad_01',
        uuid: 'u_pad1', matchedPath: 'InteractivePoints/InteractionPad_01'
    });
});

test('the path wins when both spellings are given', () => {
    const applied = applyResolvedPaths('component_set_component_property', refSchema, {
        nodeUuid: 'a-uuid-that-went-stale',
        nodePath: 'InteractivePoints/InteractionPad_01',
        componentType: 'Purchase', property: 'noMoney'
    }, {
        'InteractivePoints/InteractionPad_01': { uuid: 'u_pad1', matchedPath: 'InteractivePoints/InteractionPad_01' }
    });
    assert.equal(applied.ok, true, applied.error);
    assert.equal(applied.args.nodeUuid, 'u_pad1');
});

test('an array of paths resolves element by element, in order', () => {
    const applied = applyResolvedPaths('component_set_component_property', refSchema, {
        nodeUuid: 'u_pad1', componentType: 'Purchase', property: 'bars',
        targetPaths: ['A/B', 'C/D']
    }, {
        'A/B': { uuid: 'u_b', matchedPath: 'A/B' },
        'C/D': { uuid: 'u_d', matchedPath: 'C/D' }
    });
    assert.equal(applied.ok, true, applied.error);
    assert.deepEqual(applied.args.targetUuids, ['u_b', 'u_d']);
});

test('an unresolvable path fails the call and carries the resolver message through', () => {
    const applied = applyResolvedPaths('component_set_component_property', refSchema, {
        nodePath: 'Nope', componentType: 'Purchase', property: 'noMoney'
    }, {
        Nope: { error: "path 'Nope' does not resolve — not even its first segment 'Nope'. Scene roots are: A, B." }
    });
    assert.equal(applied.ok, false);
    assert.match(applied.error, /nodePath: path 'Nope' does not resolve/);
    assert.match(applied.error, /Scene roots are: A, B/);
});

test('one bad element in an array fails the whole call rather than writing a short array', () => {
    const applied = applyResolvedPaths('component_set_component_property', refSchema, {
        nodeUuid: 'u_pad1', componentType: 'Purchase', property: 'bars',
        targetPaths: ['A/B', 'Nope']
    }, {
        'A/B': { uuid: 'u_b', matchedPath: 'A/B' },
        Nope: { error: "path 'Nope' does not resolve" }
    });
    assert.equal(applied.ok, false);
    assert.match(applied.error, /Nope/);
});

test('both failing paths are reported together', () => {
    const applied = applyResolvedPaths('component_set_component_property', refSchema, {
        nodePath: 'BadOwner', componentType: 'Purchase', property: 'noMoney', targetPath: 'BadTarget'
    }, {
        BadOwner: { error: "path 'BadOwner' does not resolve" },
        BadTarget: { error: "path 'BadTarget' does not resolve" }
    });
    assert.equal(applied.ok, false);
    assert.match(applied.error, /BadOwner/);
    assert.match(applied.error, /BadTarget/);
});

test('the augmented schema carries its pairs under an x- keyword, inert for schema consumers', () => {
    assert.ok(UUID_OR_PATH_KEY.startsWith('x-'));
    assert.ok(Array.isArray(refSchema[UUID_OR_PATH_KEY]));
});

test('set_node_transform takes a nodePath, while a bare uuid meaning an ASSET does not', async () => {
    const registry = new ToolRegistry(nodeTools);
    const nodeSchema = registry.list().find(t => t.name === 'node_set_node_transform').inputSchema;
    assert.ok(nodeSchema.properties.nodePath, 'set_node_transform should accept nodePath');
    assert.equal(nodeSchema.required.includes('uuid'), false, 'the path alone is enough');
    assert.deepEqual(pairsOf(nodeSchema).find(p => p.uuid === 'uuid'),
        { uuid: 'uuid', path: 'nodePath', array: false, required: true });

    const sceneScript = {
        call: () => Promise.resolve({
            success: true,
            data: {
                resolutions: {
                    'Stage_3_Hookah/Hookah_model_v2':
                        { uuid: 'uuid-1', matchedPath: 'Stage_3_Hookah/Hookah_model_v2' }
                }
            }
        })
    };
    let queried;
    const editor = { scene: { queryNode: async (uuid) => { queried = uuid; return null; } } };
    const result = await registry.invoke('node_set_node_transform',
        { nodePath: 'Stage_3_Hookah/Hookah_model_v2', scale: { x: 1, y: 1, z: 1 } },
        { sceneScript, editor, settings: { enableDebugLog: false } });
    assert.equal(queried, 'uuid-1', 'the path reached the handler as the uuid it names');
    assert.equal(result.error.code, 'node_not_found', 'neither validation nor path resolution refused it');

    const assetSchema = new ToolRegistry(assetTools).list()
        .find(t => t.name === 'project_query_asset_url').inputSchema;
    assert.equal(assetSchema.properties.nodePath, undefined);
    assert.equal(pairsOf(assetSchema).length, 0);
});
