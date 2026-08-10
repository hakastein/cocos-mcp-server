import test from 'node:test';
import assert from 'node:assert/strict';

import { composeTools } from '../dist/tools-v2/index.js';

test('the whole advertised surface composes with no name collision across categories', () => {
    const names = composeTools().list().map(tool => tool.name);

    assert.equal(new Set(names).size, names.length);
    assert.equal(names.length, 88, `the surface is ${names.length} tools: ${names.join(', ')}`);
    assert.ok(names.includes('scene_dump'), 'the migrated scene category is missing from the surface');
    assert.ok(names.includes('node_create_node'), 'the migrated node category is missing from the surface');
    assert.ok(names.includes('component_set_component_property'),
        'the migrated component category is missing from the surface');
    assert.ok(names.includes('prefab_set_component_property'),
        'the migrated prefab category is missing from the surface');
    assert.ok(names.includes('sceneAdvanced_move_array_element'),
        'the migrated scene-ops category is missing from the surface');
    assert.ok(names.includes('project_get_assets'),
        'the migrated asset category is missing from the surface');
    assert.ok(names.includes('assetAdvanced_save_asset_meta'),
        'the asset-advanced survivors are missing from the surface');
    assert.ok(names.includes('assetAdvanced_validate_asset_references'),
        'the reference validator is missing from the surface');
    assert.ok(names.includes('project_build_project'),
        'the migrated build category is missing from the surface');
    assert.ok(names.includes('debug_execute_script'),
        'the migrated debug category is missing from the surface');
    assert.ok(names.includes('debug_project_logs'),
        'the merged project-log reader is missing from the surface');
    assert.ok(names.includes('batch_run'), 'the migrated batch category is missing from the surface');
    assert.ok(names.includes('ecs_component_census'), 'the migrated ecs category is missing from the surface');
    for (const socket of ['add_socket', 'list_sockets', 'remove_socket']) {
        assert.ok(names.includes(`skeletalAnimation_${socket}`),
            `skeletalAnimation_${socket} is missing from the surface`);
    }
});

test('the tools the migrated categories replaced are gone from the surface', () => {
    const names = composeTools().list().map(tool => tool.name);
    for (const retired of [
        'node_create_primitive', 'node_find_node_by_name', 'node_detect_node_type',
        'sceneAdvanced_copy_node', 'sceneAdvanced_cut_node', 'sceneAdvanced_paste_node',
        'component_attach_script', 'component_set_component_ref',
        'component_set_materials', 'component_get_materials',
        'sceneAdvanced_execute_component_method',
        'project_find_asset_by_name', 'project_get_asset_details', 'project_query_asset_path',
        'project_query_asset_uuid', 'project_query_asset_url',
        'debug_search_project_logs', 'debug_get_project_logs', 'debug_get_log_file_info'
    ]) {
        assert.ok(!names.includes(retired), `${retired} is still advertised`);
    }
});

test('a batch call reaches the composed registry, and an unknown tool inside it fails only that call', async () => {
    const registry = composeTools();
    const result = await registry.invoke('batch_run', {
        calls: [{ tool: 'no_such_tool' }, { tool: 'debug_clear_preview_logs' }]
    }, { logs: { clear() {} }, settings: { enableDebugLog: false } });

    assert.equal(result.success, false);
    assert.equal(result.error.code, 'batch_failed');
    assert.equal(result.data.results[0].error.code, 'unknown_tool');
    assert.deepEqual(result.data.results[1], { index: 1, label: undefined, tool: 'debug_clear_preview_logs', skipped: true });
});
