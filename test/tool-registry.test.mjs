/**
 * Every tool category reaches the advertised list.
 *
 * ToolManager's saved configuration is what `tools/list` filters by, and it used to be built from
 * its own copy of the category list. A category in MCPServer's list and not in ToolManager's was
 * discovered by nobody, saved into no configuration, and advertised to no client — it shipped,
 * ran, and could not be called. `skeletalAnimation_*` was invisible that way once, and
 * `ecs_component_census` was invisible that way while CLAUDE.md documented it as the tool for
 * finding a component with readers and no writer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolInstances } from '../dist/tool-registry.js';

test('the registry is the only category list, and it carries ecs', () => {
    const categories = Object.keys(createToolInstances());
    const expected = ['scene', 'node', 'component', 'prefab', 'project', 'assetAdvanced', 'sceneAdvanced', 'skeletalAnimation', 'debug', 'ecs', 'batch'];
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
