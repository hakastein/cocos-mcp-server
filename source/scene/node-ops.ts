import type { SceneMethods } from '../scene-contract';
import { findNodeByUuid, requireActiveScene } from './engine';

// `cce` is the editor-side engine facade available in the scene process (it exposes
// Prefab / PreviewPlay helpers the public `cc` module does not). Declared here so this
// TS file compiles; it is a real global inside the running scene worker.
declare const cce: any;

export const setNodeProperty: SceneMethods['setNodeProperty'] = (nodeUuid, property, value) => {
    try {
        const scene = requireActiveScene();
        const node = findNodeByUuid(scene, nodeUuid);

        switch (property) {
            case 'position': node.setPosition(value.x ?? 0, value.y ?? 0, value.z ?? 0); break;
            case 'rotation': node.setRotationFromEuler(value.x ?? 0, value.y ?? 0, value.z ?? 0); break;
            case 'scale':    node.setScale(value.x ?? 1, value.y ?? 1, value.z ?? 1); break;
            case 'active':   node.active = value; break;
            case 'name':     node.name = value; break;
            default:         (node as any)[property] = value;
        }

        return { success: true, message: `Property '${property}' updated successfully` };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
};

export const previewPlay: SceneMethods['previewPlay'] = (action) => {
    try {
        if (typeof cce === 'undefined' || !cce?.PreviewPlay) {
            return { success: false, error: 'cce.PreviewPlay is unavailable in this editor build' };
        }
        const pp = cce.PreviewPlay;
        if (action === 'stop') {
            if (typeof pp.stop === 'function') pp.stop();
            return { success: true, message: 'Preview stopped' };
        }
        if (typeof pp.start !== 'function') return { success: false, error: 'PreviewPlay.start not available' };
        const r = pp.start();
        if (r && typeof r.then === 'function') {
            // Fire-and-forget: the editor keeps playing; we report the launch.
            r.catch(() => {});
        }
        return { success: true, message: 'In-editor preview started' };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
};
