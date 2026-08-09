import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolInstances } from '../dist/tool-registry.js';

test('the registry is the only category list, and it carries ecs', () => {
    const categories = Object.keys(createToolInstances());
    const expected = ['node', 'component', 'prefab', 'project', 'assetAdvanced', 'sceneAdvanced', 'skeletalAnimation', 'debug', 'ecs', 'batch'];
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
