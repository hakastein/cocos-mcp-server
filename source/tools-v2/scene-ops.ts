import { z } from 'zod';
import { defineTool } from '../tool';
import { ok, fail } from '../result';
import { textOf } from './shared';
import type { ToolFail } from '../result';
import type { RegisteredTool } from '../tool';

/**
 * `false` from one of these messages is the editor declining the edit, not an error it throws —
 * `move-array-element` declines a reorder inside a prefab asset (canModifySibling), and reporting
 * that as a success is how a "moved" element stays where it was.
 */
function refused(code: string, what: string, hint: string, data: Record<string, unknown>): ToolFail {
    return fail(code, `The editor refused: ${what}. Nothing was changed.`, hint, data);
}

const PREFAB_SIBLING_HINT = 'The commonest cause is a prefab: the editor does not let an instance '
    + 'reorder or restructure what the prefab asset owns (canModifySibling). Edit the .prefab asset '
    + 'itself, or unlink the instance.';

export const sceneAdvancedResetNodeProperty = defineTool({
    name: 'sceneAdvanced_reset_node_property',
    description: 'Reset ONE property of a node to the default its class declares — or, on a prefab '
        + 'instance, back to the prefab\'s value, which is how the override on that property is dropped. '
        + 'The property is addressed the way the editor dumps it: "position", "rotation", "scale", "layer".',
    schema: z.object({
        uuid: z.string().describe('Node UUID'),
        path: z.string().describe('Property path, e.g. position, rotation, scale')
    }),
    aliases: { property: 'path' },
    async handler(args, ctx) {
        const target = { uuid: args.uuid, path: args.path };
        let accepted: boolean;
        try {
            accepted = await ctx.editor.scene.resetProperty({ ...target, dump: { value: null } as any });
        } catch (error) {
            return fail('reset_failed', `'${args.path}' was not reset on ${args.uuid}: ${textOf(error)}`);
        }
        if (accepted === false) {
            return refused('reset_refused', `'${args.path}' on node ${args.uuid} was not reset`,
                'Check the property spelling against node_get_node_info — the editor also answers false '
                + `for a property it does not own. ${PREFAB_SIBLING_HINT}`, target);
        }
        return ok(target, `Property '${args.path}' reset to its default`);
    }
});

export const sceneAdvancedResetNodeTransform = defineTool({
    name: 'sceneAdvanced_reset_node_transform',
    description: 'Reset a node\'s position, rotation and scale in one call, leaving every other property '
        + 'alone. On a prefab instance this drops the transform overrides the designer made.',
    schema: z.object({
        uuid: z.string().describe('Node UUID')
    }),
    async handler(args, ctx) {
        let accepted: boolean;
        try {
            accepted = await ctx.editor.scene.resetNode({ uuid: args.uuid });
        } catch (error) {
            return fail('reset_failed', `Transform was not reset on ${args.uuid}: ${textOf(error)}`);
        }
        if (accepted === false) {
            return refused('reset_refused', `the transform of node ${args.uuid} was not reset`,
                PREFAB_SIBLING_HINT, { uuid: args.uuid });
        }
        return ok({ uuid: args.uuid }, 'Node transform reset to default');
    }
});

export const sceneAdvancedResetComponent = defineTool({
    name: 'sceneAdvanced_reset_component',
    description: 'Reset every property of a component to its declared defaults. `uuid` is the COMPONENT\'s '
        + 'own uuid (component_get_components reports it as `uuid`), not the node\'s — which is why this '
        + 'tool takes no node path.',
    schema: z.object({
        uuid: z.string().describe('Component UUID')
    }),
    aliases: { componentUuid: 'uuid' },
    async handler(args, ctx) {
        try {
            await ctx.editor.scene.resetComponent({ uuid: args.uuid });
            return ok({ uuid: args.uuid }, 'Component reset to default values');
        } catch (error) {
            return fail('reset_failed', `Component ${args.uuid} was not reset: ${textOf(error)}`);
        }
    }
});

export const sceneAdvancedMoveArrayElement = defineTool({
    name: 'sceneAdvanced_move_array_element',
    description: 'Move one element of an array property to another position, by its ORIGINAL index plus a '
        + 'signed offset. The array is named by its dumped path ("_clips", "__comps__" for the component '
        + 'list itself).',
    schema: z.object({
        uuid: z.string().describe('Node UUID'),
        path: z.string().describe('Array property path, e.g. __comps__'),
        target: z.coerce.number().describe('Original index of the element to move'),
        offset: z.coerce.number().describe('How far to move it; negative moves it earlier')
    }),
    async handler(args, ctx) {
        const move = { uuid: args.uuid, path: args.path, target: args.target, offset: args.offset };
        let accepted: boolean;
        try {
            accepted = await ctx.editor.scene.moveArrayElement(move);
        } catch (error) {
            return fail('move_failed', `'${args.path}[${args.target}]' was not moved: ${textOf(error)}`);
        }
        if (accepted === false) {
            return refused('move_refused',
                `'${args.path}[${args.target}]' on node ${args.uuid} was not moved by ${args.offset}`,
                `${PREFAB_SIBLING_HINT} An index outside the array is refused the same way.`, move);
        }
        return ok(move, `Array element at index ${args.target} moved by ${args.offset}`);
    }
});

export const sceneAdvancedRemoveArrayElement = defineTool({
    name: 'sceneAdvanced_remove_array_element',
    description: 'Remove the element at an index of an array property. There is deliberately no '
        + 'add_array_element: component_set_component_property writes a whole array in one call — including '
        + 'an array of a serializable @ccclass with asset references inside its elements — so adding or '
        + 'inserting is read the array, edit it, set it back.',
    schema: z.object({
        uuid: z.string().describe('Node UUID'),
        path: z.string().describe('Array property path'),
        index: z.coerce.number().describe('Index of the element to remove')
    }),
    async handler(args, ctx) {
        const target = { uuid: args.uuid, path: args.path, index: args.index };
        let accepted: boolean;
        try {
            accepted = await ctx.editor.scene.removeArrayElement(target);
        } catch (error) {
            return fail('remove_failed', `'${args.path}[${args.index}]' was not removed: ${textOf(error)}`);
        }
        if (accepted === false) {
            return refused('remove_refused',
                `'${args.path}[${args.index}]' on node ${args.uuid} was not removed`,
                `${PREFAB_SIBLING_HINT} An index outside the array is refused the same way.`, target);
        }
        return ok(target, `Array element at index ${args.index} removed`);
    }
});

export const sceneAdvancedQuerySceneClasses = defineTool({
    name: 'sceneAdvanced_query_scene_classes',
    description: 'Every class registered with the engine in the open scene, optionally only those extending '
        + 'a given base — "cc.Component" for the component classes, an @ccclass name for a hierarchy of your '
        + 'own. This is the list of names the editor will actually accept, so it settles whether a script '
        + 'compiled and registered under the name you think it did.',
    schema: z.object({
        extends: z.string().optional().describe('Only classes extending this base, e.g. cc.Component')
    }),
    aliases: { base: 'extends', extendsClass: 'extends' },
    async handler(args, ctx) {
        const classes = await ctx.editor.scene.queryClasses(args.extends ? { extends: args.extends } : {});
        return ok({ classes, count: classes.length, extendsFilter: args.extends ?? null });
    }
});

export const sceneAdvancedQuerySceneComponents = defineTool({
    name: 'sceneAdvanced_query_scene_components',
    description: 'Every component type the editor offers for the open scene: display name, cid, its place in '
        + 'the Add Component menu, and the script asset uuid for a user script. The cid is the spelling a '
        + 'component is stored under in a .scene/.prefab file, so this is how a class name is turned into '
        + 'one without decompressing uuids by hand.',
    schema: z.object({}),
    async handler(_args, ctx) {
        const components = await ctx.editor.scene.queryComponents();
        return ok({ components, count: components.length });
    }
});

export const sceneAdvancedQueryNodesByAssetUuid = defineTool({
    name: 'sceneAdvanced_query_nodes_by_asset_uuid',
    description: 'Every node in the open scene that references a given asset uuid — the way to answer "who '
        + 'uses this material/mesh/prefab" before moving or deleting it. Answers uuids only; pair it with '
        + 'node_get_node_info or scene_dump to turn them into paths.',
    schema: z.object({
        assetUuid: z.string().describe('Asset UUID to search for')
    }),
    aliases: { uuid: 'assetUuid' },
    async handler(args, ctx) {
        const nodeUuids = await ctx.editor.scene.queryNodesByAssetUuid(args.assetUuid);
        return ok({ assetUuid: args.assetUuid, nodeUuids, count: nodeUuids.length },
            `Found ${nodeUuids.length} node(s) using asset ${args.assetUuid}`);
    }
});

export const sceneOpsTools: RegisteredTool[] = [
    sceneAdvancedResetNodeProperty,
    sceneAdvancedResetNodeTransform,
    sceneAdvancedResetComponent,
    sceneAdvancedMoveArrayElement,
    sceneAdvancedRemoveArrayElement,
    sceneAdvancedQuerySceneClasses,
    sceneAdvancedQuerySceneComponents,
    sceneAdvancedQueryNodesByAssetUuid
];
