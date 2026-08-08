import { ToolDefinition, ToolResponse, ToolExecutor } from '../types';

/**
 * Sockets attach a node to a skeleton bone while keeping `useBakedAnimation = true`.
 * The editor's socket `+` button creates a `SkeletalAnimation.Socket` (a `{path, target}` pair
 * whose `target` is an editor-managed node that tracks the bone). That structure — an array of
 * objects holding a node reference, plus the target-node creation — cannot be produced through
 * `component_set_component_property`, so these tools drive the engine directly via the scene
 * script (`SkeletalAnimation.createSocket`). Parent a weapon/model under the returned target uuid.
 */
export class SkeletalAnimationTools implements ToolExecutor {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'add_socket',
                description: 'Attach a SkeletalAnimation socket to a bone (keeps useBakedAnimation working). ' +
                    'Creates the socket and its editor-managed target node (parented under the SkeletalAnimation ' +
                    'node, named by targetName or else "<lastBone> Socket") and returns the target node uuid — ' +
                    'parent a weapon/model under it so it follows the bone. Idempotent: reuses an existing socket ' +
                    'for the same bone path, and renames its target when targetName asks for a different name.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: {
                            type: 'string',
                            description: 'UUID of the node that has the cc.SkeletalAnimation component'
                        },
                        bonePath: {
                            type: 'string',
                            description: 'Full bone path from the SkeletalAnimation node, slash-separated by bone node ' +
                                'names, e.g. "mixamorig_Hips/mixamorig_Spine/.../mixamorig_RightHand".',
                            'x-aliases': ['path', 'bone', 'socketPath']
                        },
                        targetName: {
                            type: 'string',
                            description: 'Name for the created socket node. Omitted, it is "<lastBone> Socket" — the ' +
                                'editor\'s own spelling, which a scene then refers to by a name nobody chose.'
                        }
                    },
                    required: ['nodeUuid', 'bonePath']
                }
            },
            {
                name: 'list_sockets',
                description: 'List the sockets on a node\'s cc.SkeletalAnimation: each bone path and its tracked target node uuid/name.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: {
                            type: 'string',
                            description: 'UUID of the node that has the cc.SkeletalAnimation component'
                        }
                    },
                    required: ['nodeUuid']
                }
            },
            {
                name: 'remove_socket',
                description: 'Remove a SkeletalAnimation socket by bone path: drops the socket entry and destroys its target node (and anything parented under it).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: {
                            type: 'string',
                            description: 'UUID of the node that has the cc.SkeletalAnimation component'
                        },
                        bonePath: {
                            type: 'string',
                            description: 'Bone path of the socket to remove (must match an existing socket path exactly)'
                        }
                    },
                    required: ['nodeUuid', 'bonePath']
                }
            }
        ];
    }

    async execute(toolName: string, args: any): Promise<ToolResponse> {
        switch (toolName) {
            case 'add_socket':
                return await this.runSceneMethod('addSkeletalSocket', [args.nodeUuid, args.bonePath, args.targetName]);
            case 'list_sockets':
                return await this.runSceneMethod('listSkeletalSockets', [args.nodeUuid]);
            case 'remove_socket':
                return await this.runSceneMethod('removeSkeletalSocket', [args.nodeUuid, args.bonePath]);
            default:
                throw new Error(`Unknown tool: ${toolName}`);
        }
    }

    /** Route to a scene.ts method (engine context) and pass its ToolResponse straight through. */
    private async runSceneMethod(method: string, args: any[]): Promise<ToolResponse> {
        try {
            const result = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'cocos-mcp-server',
                method,
                args
            });
            if (result && typeof result === 'object' && 'success' in result) {
                return result as ToolResponse;
            }
            return { success: true, data: result };
        } catch (err: any) {
            return { success: false, error: err.message || String(err) };
        }
    }
}
