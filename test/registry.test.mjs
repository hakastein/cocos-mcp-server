import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import toolModule from '../dist/tool.js';
import registryModule from '../dist/registry.js';
import adapterModule from '../dist/legacy-adapter.js';

const { defineTool } = toolModule;
const { ToolRegistry } = registryModule;
const { legacyTools } = adapterModule;

const context = { settings: { enableDebugLog: false } };

function sceneScriptReturning(resolutions) {
    return {
        calls: [],
        call(method, paths) {
            this.calls.push({ method, paths });
            return Promise.resolve({
                success: true,
                data: { sceneName: 'main', nodeCount: 3, resolutions }
            });
        }
    };
}

function echoTool(overrides = {}) {
    return defineTool({
        name: 'echo',
        description: 'Echoes its arguments',
        schema: z.object({ text: z.string(), count: z.number().optional() }),
        handler: async (args) => ({ success: true, data: args }),
        ...overrides
    });
}

test('a duplicate tool name is rejected at construction', () => {
    assert.throws(() => new ToolRegistry([echoTool(), echoTool()]), /echo/);
});

test('an unknown tool name fails with code unknown_tool', async () => {
    const registry = new ToolRegistry([echoTool()]);
    const result = await registry.invoke('nope', {}, context);
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'unknown_tool');
    assert.match(result.error.message, /nope/);
});

test('valid arguments reach the handler, parsed, together with the context', async () => {
    let seen;
    const tool = defineTool({
        name: 'echo',
        description: 'Echoes its arguments',
        schema: z.object({ text: z.string(), count: z.number().optional() }),
        handler: async (args, ctx) => {
            seen = { args, ctx };
            return { success: true, data: args.text };
        }
    });
    const registry = new ToolRegistry([tool]);
    const result = await registry.invoke('echo', { text: 'hi', count: 2 }, context);

    assert.deepEqual(seen.args, { text: 'hi', count: 2 });
    assert.equal(seen.ctx, context);
    assert.deepEqual(result, { success: true, data: 'hi' });
});

test('an alias is rewritten to the declared parameter before validation', async () => {
    let seen;
    const tool = defineTool({
        name: 'echo',
        description: 'Echoes its arguments',
        schema: z.object({ text: z.string() }),
        aliases: { message: 'text' },
        handler: async (args) => {
            seen = args;
            return { success: true, data: args.text };
        }
    });
    const registry = new ToolRegistry([tool]);
    const result = await registry.invoke('echo', { message: 'aliased' }, context);

    assert.deepEqual(seen, { text: 'aliased' });
    assert.equal(result.success, true);
});

test('an explicit parameter wins over its alias', async () => {
    let seen;
    const tool = defineTool({
        name: 'echo',
        description: 'Echoes its arguments',
        schema: z.object({ text: z.string() }),
        aliases: { message: 'text' },
        handler: async (args) => {
            seen = args;
            return { success: true, data: args.text };
        }
    });
    await new ToolRegistry([tool]).invoke('echo', { text: 'declared', message: 'aliased' }, context);
    assert.deepEqual(seen, { text: 'declared' });
});

test('arguments failing the schema fail with code invalid_args and never reach the handler', async () => {
    let handlerRan = false;
    const tool = defineTool({
        name: 'echo',
        description: 'Echoes its arguments',
        schema: z.object({ text: z.string(), count: z.number().optional() }),
        handler: async () => {
            handlerRan = true;
            return { success: true, data: null };
        }
    });
    const registry = new ToolRegistry([tool]);
    const result = await registry.invoke('echo', { count: 'many' }, context);

    assert.equal(handlerRan, false);
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'invalid_args');
    assert.match(result.error.message, /text/);
    assert.match(result.error.message, /count/);
});

test('list advertises the JSON Schema of every tool', () => {
    const registry = new ToolRegistry([echoTool()]);
    assert.deepEqual(registry.list(), [{
        name: 'echo',
        description: 'Echoes its arguments',
        inputSchema: registry.list()[0].inputSchema
    }]);
    const schema = registry.list()[0].inputSchema;
    assert.equal(schema.properties.text.type, 'string');
    assert.equal(schema.properties.count.type, 'number');
    assert.deepEqual(schema.required, ['text']);
});

test('a node argument is advertised with its path spelling and stops being required', () => {
    const tool = defineTool({
        name: 'touch_node',
        description: 'Touches a node',
        schema: z.object({ nodeUuid: z.string() }),
        handler: async () => ({ success: true, data: null })
    });
    const schema = new ToolRegistry([tool]).list()[0].inputSchema;

    assert.equal(schema.properties.nodePath.type, 'string');
    assert.deepEqual(schema.required, []);
});

test('a scene path is resolved to a uuid before the handler runs', async () => {
    let seen;
    const tool = defineTool({
        name: 'touch_node',
        description: 'Touches a node',
        schema: z.object({ nodeUuid: z.string() }),
        handler: async (args) => {
            seen = args;
            return { success: true, data: args.nodeUuid };
        }
    });
    const sceneScript = sceneScriptReturning({ 'Root/Pad': { uuid: 'uuid-1', matchedPath: 'Root/Pad' } });
    const registry = new ToolRegistry([tool]);
    const result = await registry.invoke('touch_node', { nodePath: 'Root/Pad' }, { ...context, sceneScript });

    assert.deepEqual(sceneScript.calls, [{ method: 'resolveNodePaths', paths: ['Root/Pad'] }]);
    assert.deepEqual(seen, { nodeUuid: 'uuid-1' });
    assert.deepEqual(result, { success: true, data: 'uuid-1' });
});

test('a path matching nothing fails with the resolver message and never reaches the handler', async () => {
    let handlerRan = false;
    const tool = defineTool({
        name: 'touch_node',
        description: 'Touches a node',
        schema: z.object({ nodeUuid: z.string() }),
        handler: async () => {
            handlerRan = true;
            return { success: true, data: null };
        }
    });
    const sceneScript = sceneScriptReturning({ 'Root/Gone': { error: "path 'Root/Gone' does not resolve" } });
    const result = await new ToolRegistry([tool])
        .invoke('touch_node', { nodePath: 'Root/Gone' }, { ...context, sceneScript });

    assert.equal(handlerRan, false);
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'node_path');
    assert.match(result.error.message, /Root\/Gone/);
});

test('naming neither the uuid nor the path of a required node argument fails without a scene call', async () => {
    const tool = defineTool({
        name: 'touch_node',
        description: 'Touches a node',
        schema: z.object({ nodeUuid: z.string() }),
        handler: async () => ({ success: true, data: null })
    });
    const sceneScript = sceneScriptReturning({});
    const result = await new ToolRegistry([tool]).invoke('touch_node', {}, { ...context, sceneScript });

    assert.deepEqual(sceneScript.calls, []);
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'node_path');
    assert.match(result.error.message, /nodeUuid.*nodePath/s);
});

test('a scene script that does not answer is reported as a transport failure', async () => {
    const tool = defineTool({
        name: 'touch_node',
        description: 'Touches a node',
        schema: z.object({ nodeUuid: z.string() }),
        handler: async () => ({ success: true, data: null })
    });
    const sceneScript = { call: () => Promise.reject(new Error('scene worker is gone')) };
    const result = await new ToolRegistry([tool])
        .invoke('touch_node', { nodePath: 'Root/Pad' }, { ...context, sceneScript });

    assert.equal(result.success, false);
    assert.equal(result.error.code, 'node_path');
    assert.match(result.error.message, /scene worker is gone/);
});

function legacyExecutor(execute) {
    return {
        getTools: () => [{
            name: 'reimport_asset',
            description: 'Reimports an asset',
            inputSchema: {
                type: 'object',
                properties: {
                    url: { type: 'string', 'x-aliases': ['assetPath'] },
                    depth: { type: 'number' }
                },
                required: ['url']
            }
        }],
        execute
    };
}

test('a legacy tool is registered under its category prefix and answers in the new envelope', async () => {
    const seen = [];
    const registry = new ToolRegistry(legacyTools('project', legacyExecutor(async (name, args) => {
        seen.push({ name, args });
        return { success: true, data: { url: args.url }, message: 'reimported' };
    })));

    assert.deepEqual(registry.list().map(t => t.name), ['project_reimport_asset']);
    const result = await registry.invoke('project_reimport_asset', { url: 'db://assets/a.png' }, context);

    assert.deepEqual(seen, [{ name: 'reimport_asset', args: { url: 'db://assets/a.png' } }]);
    assert.deepEqual(result, { success: true, data: { url: 'db://assets/a.png' }, message: 'reimported' });
});

test('a legacy alias is applied and a declared scalar is coerced before the executor runs', async () => {
    let seen;
    const registry = new ToolRegistry(legacyTools('project', legacyExecutor(async (name, args) => {
        seen = args;
        return { success: true, data: null };
    })));
    await registry.invoke('project_reimport_asset', { assetPath: 'db://assets/a.png', depth: '3' }, context);

    assert.deepEqual(seen, { url: 'db://assets/a.png', depth: 3 });
});

test('a legacy call missing a required argument fails with invalid_args and never reaches the executor', async () => {
    let executorRan = false;
    const registry = new ToolRegistry(legacyTools('project', legacyExecutor(async () => {
        executorRan = true;
        return { success: true, data: null };
    })));
    const result = await registry.invoke('project_reimport_asset', { depth: 1 }, context);

    assert.equal(executorRan, false);
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'invalid_args');
    assert.match(result.error.message, /url/);
});

test('a legacy failure becomes a fail with code legacy carrying its error text', async () => {
    const registry = new ToolRegistry(legacyTools('project', legacyExecutor(async () => ({
        success: false, error: 'asset not found'
    }))));
    const result = await registry.invoke('project_reimport_asset', { url: 'db://assets/a.png' }, context);

    assert.equal(result.success, false);
    assert.deepEqual(result.error, { code: 'legacy', message: 'asset not found' });
});

test('a legacy failure spelling its reason as a message is not reported as empty', async () => {
    const registry = new ToolRegistry(legacyTools('project', legacyExecutor(async () => ({
        success: false, message: 'no scene is open'
    }))));
    const result = await registry.invoke('project_reimport_asset', { url: 'db://assets/a.png' }, context);

    assert.equal(result.error.message, 'no scene is open');
});

test('a legacy throw becomes a fail with code legacy_throw', async () => {
    const registry = new ToolRegistry(legacyTools('project', legacyExecutor(async () => {
        throw new Error('editor said no');
    })));
    const result = await registry.invoke('project_reimport_asset', { url: 'db://assets/a.png' }, context);

    assert.equal(result.success, false);
    assert.deepEqual(result.error, { code: 'legacy_throw', message: 'editor said no' });
});

test('a legacy answer carrying fields beside data keeps every one of them', async () => {
    const registry = new ToolRegistry(legacyTools('project', legacyExecutor(async () => ({
        success: true, data: { uuid: 'u1' }, warning: 'partial', updatedProperties: ['position']
    }))));
    const result = await registry.invoke('project_reimport_asset', { url: 'db://assets/a.png' }, context);

    assert.deepEqual(result, {
        success: true,
        data: { data: { uuid: 'u1' }, warning: 'partial', updatedProperties: ['position'] }
    });
});

test('a legacy node tool takes a scene path through the same resolution', async () => {
    let seen;
    const executor = {
        getTools: () => [{
            name: 'get_node_info',
            description: 'Reads a node',
            inputSchema: { type: 'object', properties: { uuid: { type: 'string' } }, required: ['uuid'] }
        }],
        execute: async (name, args) => {
            seen = args;
            return { success: true, data: null };
        }
    };
    const sceneScript = sceneScriptReturning({ 'Root/Pad': { uuid: 'uuid-1', matchedPath: 'Root/Pad' } });
    const registry = new ToolRegistry(legacyTools('node', executor));

    assert.equal(registry.list()[0].inputSchema.properties.nodePath.type, 'string');
    assert.match(registry.list()[0].description, /SCENE PATH/);
    await registry.invoke('node_get_node_info', { nodePath: 'Root/Pad' }, { ...context, sceneScript });
    assert.deepEqual(seen, { uuid: 'uuid-1' });
});
