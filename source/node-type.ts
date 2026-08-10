export const UI_COMPONENT_TYPES: readonly string[] = [
    'cc.UITransform', 'cc.Canvas', 'cc.Sprite', 'cc.Label', 'cc.RichText',
    'cc.Button', 'cc.Layout', 'cc.Widget', 'cc.Mask', 'cc.Graphics',
    'cc.ScrollView', 'cc.ProgressBar', 'cc.Toggle', 'cc.Slider', 'cc.EditBox'
];

export const SPATIAL_COMPONENT_TYPES: readonly string[] = [
    'cc.MeshRenderer', 'cc.SkinnedMeshRenderer', 'cc.Camera', 'cc.ParticleSystem'
];

/** 1 << 25, the value of cc.Layers.Enum.UI_2D. */
export const LAYER_UI_2D = 33554432;

export type NodeType = '2d' | '3d';

export interface NodeClassification {
    nodeType: NodeType;
    reasons: string[];
}

export interface TransformConstraints {
    position: string;
    rotation: string;
    scale: string;
}

function isUiType(componentType: string): boolean {
    return UI_COMPONENT_TYPES.includes(componentType);
}

function isSpatialType(componentType: string): boolean {
    return SPATIAL_COMPONENT_TYPES.includes(componentType) || /(^|\.)\w*Light$/.test(componentType);
}

export function classifyNode(componentTypes: string[], layer?: number): NodeClassification {
    const types = (componentTypes || []).filter(type => typeof type === 'string' && type);
    const ui = types.filter(isUiType);
    const spatial = types.filter(isSpatialType);
    const onUiLayer = layer === LAYER_UI_2D;

    const reasons: string[] = [];
    if (ui.length) reasons.push(`Has 2D/UI components: ${ui.join(', ')}`);
    if (spatial.length) reasons.push(`Has 3D components: ${spatial.join(', ')}`);
    if (onUiLayer) reasons.push('Node is on the UI_2D layer (2D)');
    if (!reasons.length) {
        reasons.push('No 2D/UI signals found; treated as a 3D node (full x/y/z transform)');
    }

    if (ui.length) return { nodeType: '2d', reasons };
    if (spatial.length) return { nodeType: '3d', reasons };
    return { nodeType: onUiLayer ? '2d' : '3d', reasons };
}

export function transformConstraintsOf(nodeType: NodeType): TransformConstraints {
    return nodeType === '2d'
        ? {
            position: 'x, y only (z ignored)',
            rotation: 'z only (x, y ignored)',
            scale: 'x, y main, z typically 1'
        }
        : { position: 'x, y, z all used', rotation: 'x, y, z all used', scale: 'x, y, z all used' };
}
