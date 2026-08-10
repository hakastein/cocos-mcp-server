import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import toolModule from '../dist/tool.js';
import registryModule from '../dist/registry.js';
import nodePathModule from '../dist/node-path.js';

const { UUID_OR_PATH_KEY } = nodePathModule;
const { defineTool } = toolModule;
const { ToolRegistry } = registryModule;

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
    assert.match(result.error.hint, /tools\/list/);
});

test('an unknown name close to a registered one is answered with that suggestion', async () => {
    const result = await new ToolRegistry([echoTool()]).invoke('echoo', {}, context);
    assert.match(result.error.hint, /Did you mean 'echo'\?/);
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

test('an alias shadowing a declared parameter is rejected at definition time', () => {
    assert.throws(() => defineTool({
        name: 'find_owners',
        description: 'Finds owners',
        schema: z.object({ className: z.string(), name: z.string().optional() }),
        aliases: { name: 'className' },
        handler: async () => ({ success: true, data: null })
    }), /find_owners.*'name'/s);
});

test('an alias aimed at a parameter the schema never declares is rejected at definition time', () => {
    assert.throws(() => defineTool({
        name: 'find_owners',
        description: 'Finds owners',
        schema: z.object({ className: z.string() }),
        aliases: { type: 'componentType' },
        handler: async () => ({ success: true, data: null })
    }), /find_owners.*'componentType'/s);
});

test('an accepted alias is advertised on the parameter it stands for', () => {
    const tool = defineTool({
        name: 'echo',
        description: 'Echoes its arguments',
        schema: z.object({ text: z.string() }),
        aliases: { message: 'text', body: 'text' },
        handler: async (args) => ({ success: true, data: args.text })
    });
    const schema = new ToolRegistry([tool]).list()[0].inputSchema;
    assert.deepEqual(schema.properties.text['x-aliases'], ['message', 'body']);
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

test('list hands out deep copies, down to the schema a caller could otherwise rewrite', () => {
    const registry = new ToolRegistry([echoTool()]);
    const advertised = registry.list()[0];
    advertised.description = 'rewritten';
    advertised.inputSchema.properties.text.type = 'number';
    delete advertised.inputSchema.required;

    const fresh = registry.list()[0];
    assert.equal(fresh.description, 'Echoes its arguments');
    assert.equal(fresh.inputSchema.properties.text.type, 'string');
    assert.deepEqual(fresh.inputSchema.required, ['text']);
});

test('a tool under a category prefix is augmented through its bare name', async () => {
    let seen;
    const tool = defineTool({
        name: 'node_probe_tool',
        description: 'Probes a node',
        schema: z.object({ nodeUuid: z.string() }),
        handler: async (args) => {
            seen = args;
            return { success: true, data: null };
        }
    });
    const registry = new ToolRegistry([tool]);
    assert.equal(registry.list()[0].inputSchema.properties.nodePath.type, 'string');

    const sceneScript = sceneScriptReturning({ 'Root/Pad': { uuid: 'uuid-1', matchedPath: 'Root/Pad' } });
    await registry.invoke('node_probe_tool', { nodePath: 'Root/Pad' }, { ...context, sceneScript });
    assert.deepEqual(seen, { nodeUuid: 'uuid-1' });
});

test('a native tool spelling a node argument as bare uuid is recognised under its bare name', () => {
    const tool = defineTool({
        name: 'node_get_node_info',
        description: 'Reads a node',
        schema: z.object({ uuid: z.string() }),
        handler: async () => ({ success: true, data: null })
    });
    const schema = new ToolRegistry([tool]).list()[0].inputSchema;

    assert.equal(schema.properties.nodePath.type, 'string');
    assert.deepEqual(schema[UUID_OR_PATH_KEY], [
        { uuid: 'uuid', path: 'nodePath', array: false, required: true }
    ]);
});

test('a bare uuid on a tool that is not a node tool is left alone', () => {
    const tool = defineTool({
        name: 'project_get_asset_details',
        description: 'Reads an asset',
        schema: z.object({ uuid: z.string() }),
        handler: async () => ({ success: true, data: null })
    });
    const schema = new ToolRegistry([tool]).list()[0].inputSchema;

    assert.equal(schema.properties.nodePath, undefined);
    assert.deepEqual(schema.required, ['uuid']);
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
