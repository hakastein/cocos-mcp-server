/**
 * Contract tests over the REAL tool schemas, exercising the exact call shapes that failed
 * in the field. These import the shipped tool classes, so a schema edit that reintroduces
 * either bug fails here rather than in a live editor session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import ta from '../dist/tool-args.js';
import { debugTools } from '../dist/tools-v2/debug.js';
import { assetTools } from '../dist/tools-v2/asset.js';
import { buildTools } from '../dist/tools-v2/build.js';
import { sceneTools } from '../dist/tools-v2/scene.js';
import { nodeTools } from '../dist/tools-v2/node.js';
import { componentTools } from '../dist/tools-v2/component.js';
import { prefabTools } from '../dist/tools-v2/prefab.js';
import { sceneOpsTools } from '../dist/tools-v2/scene-ops.js';

const { normalizeToolArgs } = ta;

test('Bug 1: the query spellings a caller reaches for are advertised on debug_project_logs', () => {
    const schema = debugTools.find(tool => tool.name === 'debug_project_logs').inputSchema;
    assert.deepEqual(schema.required, undefined, 'a tail read takes no arguments at all');
    for (const spelling of ['keyword', 'pattern', 'search', 'filterKeyword']) {
        assert.ok(schema.properties.query['x-aliases'].includes(spelling), `query drops the ${spelling} spelling`);
    }
    for (const spelling of ['maxResults', 'max', 'lines']) {
        assert.ok(schema.properties.limit['x-aliases'].includes(spelling), `limit drops the ${spelling} spelling`);
    }
});

const assetToolNamed = (name) => {
    const tool = assetTools.find(t => t.name === name);
    assert.ok(tool, `tool ${name} not found`);
    return tool;
};

const recordingAssetDb = (answers = {}) => ({
    calls: [],
    ...Object.fromEntries(['reimportAsset', 'queryAssetInfo', 'queryAssets', 'createAsset', 'moveAsset']
        .map(method => [method, function (...args) {
            this.calls.push({ method, args });
            const answer = answers[method];
            return Promise.resolve(typeof answer === 'function' ? answer(...args) : answer);
        }]))
});

test('Bug 2: reimport_asset accepts the assetPath spelling that crashed the editor', async () => {
    const assetDb = recordingAssetDb();
    const result = await assetToolNamed('project_reimport_asset')
        .invoke({ assetPath: 'db://assets/shared/scripts/core/di/serviceTag.ts' }, { editor: { assetDb } });
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(assetDb.calls[0],
        { method: 'reimportAsset', args: ['db://assets/shared/scripts/core/di/serviceTag.ts'] });
});

test('Bug 2: a genuinely wrong argument name is a validation error naming the expected one', async () => {
    const assetDb = recordingAssetDb();
    const result = await assetToolNamed('project_reimport_asset')
        .invoke({ assetUri: 'db://assets/x.ts' }, { editor: { assetDb } });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'invalid_args');
    assert.match(result.error.message, /url/);
    assert.doesNotMatch(result.error.message, /startsWith/);
    assert.deepEqual(assetDb.calls, []);
});

test('reimport_asset refuses a path that is not a db:// url instead of handing it to the editor', async () => {
    const assetDb = recordingAssetDb();
    const result = await assetToolNamed('project_reimport_asset')
        .invoke({ url: 'D:/cocos/cocos-playables/framework/core/world.ts' }, { editor: { assetDb } });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'invalid_url');
    assert.deepEqual(assetDb.calls, []);
});

test('propertyType stays optional and open-ended — a closed enum read as "no such capability"', () => {
    const schema = componentTools.find(t => t.name === 'component_set_component_property').inputSchema;
    assert.equal(schema.required.includes('propertyType'), false);
    assert.equal(schema.required.includes('value'), false, 'targetUuid/targetUuids/clear can supply it');
    assert.equal(schema.properties.propertyType.enum, undefined);
    assert.match(schema.properties.propertyType.description, /OPTIONAL/);
    assert.match(schema.properties.propertyType.description, /cc\.\* class name/);
    assert.deepEqual(schema.properties.value.type,
        ['object', 'array', 'string', 'number', 'boolean', 'null']);
});

const sceneToolNamed = (name) => {
    const tool = sceneTools.find(t => t.name === name);
    assert.ok(tool, `tool ${name} not found`);
    return tool;
};

const recordingSceneScript = () => ({
    calls: [],
    call(method, options) {
        this.calls.push({ method, options });
        return Promise.resolve({ success: true, data: { owners: [] } });
    }
});

test('find_component_owners accepts the class name under the spellings a caller will guess', async () => {
    const tool = sceneToolNamed('scene_find_component_owners');
    for (const spelling of ['className', 'componentType', 'component', 'type', 'name']) {
        const sceneScript = recordingSceneScript();
        const result = await tool.invoke({ [spelling]: 'CharacterAnimator' }, { sceneScript });
        assert.equal(result.success, true, `${spelling}: ${JSON.stringify(result.error)}`);
        assert.equal(sceneScript.calls[0].options.className, 'CharacterAnimator');
    }
});

test('find_component_owners without a class name is a clear validation error', async () => {
    const result = await sceneToolNamed('scene_find_component_owners').invoke({}, {});
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'invalid_args');
    assert.match(result.error.message, /className/);
});

const advertisedSchemas = () =>
    [...sceneTools, ...nodeTools, ...componentTools, ...prefabTools, ...sceneOpsTools,
        ...assetTools, ...buildTools, ...debugTools]
        .map(tool => ({ name: tool.name, inputSchema: tool.inputSchema || {} }));

test('every declared required argument is actually reachable under its own name', () => {
    // guards the defect class: a schema advertising one name while the handler reads another
    for (const { name: toolName, inputSchema } of advertisedSchemas()) {
        const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
        if (!required.length) continue;
        const props = Object.keys(inputSchema.properties || {});
        for (const name of required) {
            assert.ok(props.includes(name), `${toolName}: required '${name}' is not declared in properties`);
        }
        // a call supplying exactly the required set must validate
        const args = Object.fromEntries(required.map(n => [n, 'x']));
        const r = normalizeToolArgs(toolName, inputSchema, args);
        assert.ok(r.ok || /must be of type/.test(r.error),
            `${toolName}: supplying all required args was rejected: ${r.error}`);
    }
});

test('no two aliases on one tool collide with a different declared parameter', () => {
    for (const { name: toolName, inputSchema } of advertisedSchemas()) {
        const props = inputSchema.properties || {};
        const names = Object.keys(props);
        const seen = new Map();
        for (const [name, def] of Object.entries(props)) {
            for (const alias of (def && def['x-aliases']) || []) {
                assert.ok(!names.includes(alias),
                    `${toolName}: alias '${alias}' on '${name}' shadows a real parameter`);
                assert.ok(!seen.has(alias),
                    `${toolName}: alias '${alias}' claimed by both '${seen.get(alias)}' and '${name}'`);
                seen.set(alias, name);
            }
        }
    }
});
