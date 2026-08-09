/**
 * Contract tests over the REAL tool schemas, exercising the exact call shapes that failed
 * in the field. These import the shipped tool classes, so a schema edit that reintroduces
 * either bug fails here rather than in a live editor session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import ta from '../dist/tool-args.js';
import { DebugTools } from '../dist/tools/debug-tools.js';
import { ProjectTools } from '../dist/tools/project-tools.js';
import { NodeTools } from '../dist/tools/node-tools.js';
import { ComponentTools } from '../dist/tools/component-tools.js';
import { PrefabTools } from '../dist/tools/prefab-tools.js';
import { SceneTools } from '../dist/tools/scene-tools.js';

const { normalizeToolArgs } = ta;

const schemaOf = (executor, toolName) => {
    const tool = executor.getTools().find(t => t.name === toolName);
    assert.ok(tool, `tool ${toolName} not found`);
    return tool.inputSchema;
};

test('Bug 1: search_project_logs accepts the keyword/limit spelling that silently match-alled', () => {
    const schema = schemaOf(new DebugTools(), 'search_project_logs');
    const r = normalizeToolArgs('debug_search_project_logs', schema, { keyword: '_sealed', limit: 6 });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.args.pattern, '_sealed');
    assert.equal(r.args.maxResults, 6);
});

test('Bug 1: search_project_logs with no pattern is rejected instead of returning the file head', () => {
    const schema = schemaOf(new DebugTools(), 'search_project_logs');
    const r = normalizeToolArgs('debug_search_project_logs', schema, { limit: 6 });
    assert.equal(r.ok, false);
    assert.match(r.error, /missing required argument/i);
    assert.match(r.error, /pattern/);
});

test('Bug 2: reimport_asset accepts the assetPath spelling that crashed the editor', () => {
    const schema = schemaOf(new ProjectTools(), 'reimport_asset');
    const r = normalizeToolArgs('project_reimport_asset', schema, {
        assetPath: 'db://assets/shared/scripts/core/di/serviceTag.ts'
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.args.url, 'db://assets/shared/scripts/core/di/serviceTag.ts');
});

test('Bug 2: a genuinely wrong argument name is a validation error naming the expected one', () => {
    const schema = schemaOf(new ProjectTools(), 'reimport_asset');
    const r = normalizeToolArgs('project_reimport_asset', schema, { assetUri: 'db://assets/x.ts' });
    assert.equal(r.ok, false);
    assert.match(r.error, /assetUri/);
    assert.match(r.error, /'url'/);
    assert.doesNotMatch(r.error, /startsWith/);
});

test('find_component_owners accepts the class name under the spellings a caller will guess', () => {
    const schema = schemaOf(new SceneTools(), 'find_component_owners');
    for (const spelling of ['className', 'componentType', 'component', 'type', 'name']) {
        const r = normalizeToolArgs('scene_find_component_owners', schema, { [spelling]: 'CharacterAnimator' });
        assert.equal(r.ok, true, `${spelling}: ${r.error}`);
        assert.equal(r.args.className, 'CharacterAnimator');
    }
});

test('find_component_owners without a class name is a clear validation error', () => {
    const schema = schemaOf(new SceneTools(), 'find_component_owners');
    const r = normalizeToolArgs('scene_find_component_owners', schema, {});
    assert.equal(r.ok, false);
    assert.match(r.error, /className/);
});

test('every declared required argument is actually reachable under its own name', () => {
    // guards the defect class: a schema advertising one name while the handler reads another
    const executors = {
        debug: new DebugTools(),
        project: new ProjectTools(),
        node: new NodeTools(),
        component: new ComponentTools(),
        prefab: new PrefabTools(),
        scene: new SceneTools()
    };
    for (const [category, ex] of Object.entries(executors)) {
        for (const tool of ex.getTools()) {
            const schema = tool.inputSchema || {};
            const required = Array.isArray(schema.required) ? schema.required : [];
            if (!required.length) continue;
            const props = Object.keys(schema.properties || {});
            for (const name of required) {
                assert.ok(
                    props.includes(name),
                    `${category}_${tool.name}: required '${name}' is not declared in properties`
                );
            }
            // a call supplying exactly the required set must validate
            const args = Object.fromEntries(required.map(n => [n, 'x']));
            const r = normalizeToolArgs(`${category}_${tool.name}`, schema, args);
            assert.ok(r.ok || /must be of type/.test(r.error),
                `${category}_${tool.name}: supplying all required args was rejected: ${r.error}`);
        }
    }
});

test('no two aliases on one tool collide with a different declared parameter', () => {
    const executors = [new DebugTools(), new ProjectTools(),
                       new NodeTools(), new ComponentTools(), new PrefabTools(), new SceneTools()];
    for (const ex of executors) {
        for (const tool of ex.getTools()) {
            const props = (tool.inputSchema || {}).properties || {};
            const names = Object.keys(props);
            const seen = new Map();
            for (const [name, def] of Object.entries(props)) {
                for (const alias of (def && def['x-aliases']) || []) {
                    assert.ok(!names.includes(alias),
                        `${tool.name}: alias '${alias}' on '${name}' shadows a real parameter`);
                    assert.ok(!seen.has(alias),
                        `${tool.name}: alias '${alias}' claimed by both '${seen.get(alias)}' and '${name}'`);
                    seen.set(alias, name);
                }
            }
        }
    }
});
