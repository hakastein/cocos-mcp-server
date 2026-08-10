import test from 'node:test';
import assert from 'node:assert/strict';

import { composeTools, createToolInstances } from '../dist/tool-registry.js';

test('the registry is the only category list, and it carries ecs', () => {
    const categories = Object.keys(createToolInstances());
    const expected = ['project', 'assetAdvanced', 'skeletalAnimation', 'debug', 'ecs', 'batch'];
    assert.deepEqual(categories.sort(), expected.slice().sort());
});

test('ecs_component_census is a real tool with a schema, not just a class', () => {
    const tools = createToolInstances().ecs.getTools();
    const census = tools.find(tool => tool.name === 'component_census');
    assert.ok(census, `EcsTools advertises ${tools.map(t => t.name).join(', ')} — no component_census`);
    assert.ok(census.inputSchema && census.inputSchema.type === 'object');
});

test('every category answers getTools() with named, described tools', () => {
    for (const [category, executor] of Object.entries(createToolInstances())) {
        const tools = executor.getTools();
        assert.ok(Array.isArray(tools) && tools.length, `${category} advertises nothing`);
        for (const tool of tools) {
            assert.ok(tool.name, `${category}: a tool has no name`);
            assert.ok(tool.description, `${category}_${tool.name} has no description`);
        }
    }
});

test('the whole advertised surface composes with no name collision across categories', () => {
    const names = composeTools().list().map(tool => tool.name);

    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes('scene_dump'), 'the migrated scene category is missing from the surface');
    assert.ok(names.includes('node_create_node'), 'the migrated node category is missing from the surface');
    assert.ok(names.includes('component_set_component_property'),
        'the migrated component category is missing from the surface');
    assert.ok(names.includes('prefab_set_component_property'),
        'the migrated prefab category is missing from the surface');
    assert.ok(names.includes('sceneAdvanced_move_array_element'),
        'the migrated scene-ops category is missing from the surface');
});

test('the tools the node category replaced are gone from the surface', () => {
    const names = composeTools().list().map(tool => tool.name);
    for (const retired of [
        'node_create_primitive', 'node_find_node_by_name', 'node_detect_node_type',
        'sceneAdvanced_copy_node', 'sceneAdvanced_cut_node', 'sceneAdvanced_paste_node',
        'component_attach_script', 'component_set_component_ref',
        'component_set_materials', 'component_get_materials',
        'sceneAdvanced_execute_component_method'
    ]) {
        assert.ok(!names.includes(retired), `${retired} is still advertised`);
    }
});
