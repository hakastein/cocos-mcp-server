import type { SceneNodeEntry } from '@cocos-cli/shared';

const UI_TRANSFORM = 'cc.UITransform';

export interface NodePlacement {
    /** The path the node actually has, in the spelling `resolveNodePaths` takes back. */
    path: string;
    parentUuid: string | null;
    /** null when the node sits at the scene root. */
    parentPath: string | null;
    components: string[];
}

export function placementOf(
    nodes: readonly SceneNodeEntry[], uuid: string
): NodePlacement | null {
    const entry = nodes.find(node => node.uuid === uuid);
    if (!entry) return null;
    const cut = entry.path.lastIndexOf('/');
    return {
        path: entry.path,
        parentUuid: entry.parentUuid,
        parentPath: cut < 0 ? null : entry.path.slice(0, cut),
        components: (entry.components || []).map(component => component.className)
    };
}

/**
 * A root node's `parentUuid` is the scene's own uuid rather than nothing, so the scene root is
 * read off the path instead of compared as a parent.
 */
export function placementHeld(
    placement: NodePlacement, requestedParentUuid: string | undefined
): boolean {
    return requestedParentUuid === undefined
        ? placement.parentPath === null
        : placement.parentUuid === requestedParentUuid;
}

/**
 * `createNodeFromAsset` reparents a node carrying `cc.UITransform` under the nearest Canvas and
 * drops the `parent` it was given. A 2D node outside a Canvas draws nothing, so the move is the
 * editor's intent and moving the node back is not what this reports.
 */
export function misplacedDetail(placement: NodePlacement, requestedParent: string): string {
    const reason = placement.components.includes(UI_TRANSFORM)
        ? `it carries ${UI_TRANSFORM}, and createNodeFromAsset moves such a node under the nearest `
            + 'Canvas, which is where a 2D node has to be to draw at all'
        : 'the editor named no reason';
    return `asked for under ${requestedParent}, and the editor put it at ${placement.path} — ${reason}. `
        + `The node is in the scene: address it as ${placement.path} or by its uuid, and `
        + `'cocos node rm' takes it back out`;
}
