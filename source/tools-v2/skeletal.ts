import { z } from 'zod';
import { defineTool } from '../tool';
import { fail } from '../result';
import { fromScene, textOf } from './shared';
import type { ToolResult } from '../result';
import type { SceneResult } from '../scene-contract';
import type { RegisteredTool } from '../tool';

async function onSkeleton<T>(run: () => Promise<SceneResult<T>>): Promise<ToolResult> {
    try {
        return fromScene(await run());
    } catch (error) {
        return fail('scene_script', `The scene script did not answer: ${textOf(error)}`,
            'The scene must be open and loaded; check scene_query_ready.');
    }
}

const nodeUuidArg = z.string().describe('UUID of the node that has the cc.SkeletalAnimation component');

export const skeletalAnimationAddSocket = defineTool({
    name: 'skeletalAnimation_add_socket',
    description: 'Attach a SkeletalAnimation socket to a bone (keeps useBakedAnimation working). '
        + 'Creates the socket and its editor-managed target node (parented under the SkeletalAnimation '
        + 'node, named by targetName or else "<lastBone> Socket") and returns the target node uuid — '
        + 'parent a weapon/model under it so it follows the bone. Idempotent: reuses an existing socket '
        + 'for the same bone path, and renames its target when targetName asks for a different name.',
    schema: z.object({
        nodeUuid: nodeUuidArg,
        bonePath: z.string().describe('Full bone path from the SkeletalAnimation node, slash-separated '
            + 'by bone node names, e.g. "mixamorig_Hips/mixamorig_Spine/.../mixamorig_RightHand".'),
        targetName: z.string().optional().describe('Name for the created socket node. Omitted, it is '
            + '"<lastBone> Socket" — the editor\'s own spelling, which a scene then refers to by a name '
            + 'nobody chose.')
    }),
    aliases: { path: 'bonePath', bone: 'bonePath', socketPath: 'bonePath' },
    async handler(args, ctx) {
        return onSkeleton(() => ctx.sceneScript.call('addSkeletalSocket', args.nodeUuid, args.bonePath, args.targetName));
    }
});

export const skeletalAnimationListSockets = defineTool({
    name: 'skeletalAnimation_list_sockets',
    description: 'List the sockets on a node\'s cc.SkeletalAnimation: each bone path and its tracked '
        + 'target node uuid/name.',
    schema: z.object({ nodeUuid: nodeUuidArg }),
    async handler(args, ctx) {
        return onSkeleton(() => ctx.sceneScript.call('listSkeletalSockets', args.nodeUuid));
    }
});

export const skeletalAnimationRemoveSocket = defineTool({
    name: 'skeletalAnimation_remove_socket',
    description: 'Remove a SkeletalAnimation socket by bone path: drops the socket entry and destroys '
        + 'its target node (and anything parented under it).',
    schema: z.object({
        nodeUuid: nodeUuidArg,
        bonePath: z.string().describe('Bone path of the socket to remove (must match an existing socket path exactly)')
    }),
    async handler(args, ctx) {
        return onSkeleton(() => ctx.sceneScript.call('removeSkeletalSocket', args.nodeUuid, args.bonePath));
    }
});

export const skeletalTools: RegisteredTool[] = [
    skeletalAnimationAddSocket,
    skeletalAnimationListSockets,
    skeletalAnimationRemoveSocket
];
