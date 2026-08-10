import type { SceneMethods } from '../scene-contract';
import { findComponentClass, findNodeByUuid, requireActiveScene } from './engine';

export const addComponentToNode: SceneMethods['addComponentToNode'] = (nodeUuid, componentType) => {
    try {
        const scene = requireActiveScene();
        const node = findNodeByUuid(scene, nodeUuid);
        const ComponentClass = findComponentClass(componentType);
        const component = node.addComponent(ComponentClass);
        return {
            success: true,
            message: `Component ${componentType} added successfully`,
            data: { componentId: component.uuid }
        };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
};

/**
 * Populate a particle GradientRange's colour/alpha gradient via the ENGINE API.
 * The editor `set-property` channel cannot write GradientColorKey/GradientAlphaKey
 * arrays (they always read back empty), so we build real `cc.ColorKey`/`cc.AlphaKey`
 * instances and call `Gradient.setKeys(...)` on the live component. This mutates the
 * live scene graph; the editor serialises it faithfully on the next scene save.
 *
 * `propertyPath` addresses the GradientRange, dotted for sub-modules, e.g.
 * 'startColor' or 'colorOverLifetimeModule.color'. `mode` defaults to 1 (Gradient).
 */
export const setParticleGradient: SceneMethods['setParticleGradient'] = (
    nodeUuid, componentType, propertyPath, colorKeys, alphaKeys, mode, enableModule,
) => {
    try {
        const cc = require('cc');
        const scene = requireActiveScene();
        const node = findNodeByUuid(scene, nodeUuid);
        const ComponentClass = findComponentClass(componentType);
        const comp = node.getComponent(ComponentClass);
        if (!comp) return { success: false, error: `Component ${componentType} not found on node` };

        // Walk the dotted path to the object that OWNS the GradientRange (so we can
        // optionally enable its containing module) and then to the GradientRange itself.
        const segs = String(propertyPath).split('.');
        let owner: any = comp;
        for (let i = 0; i < segs.length - 1; i++) {
            owner = owner?.[segs[i]];
            if (owner == null) return { success: false, error: `Path segment '${segs[i]}' is null on ${componentType}` };
        }
        if (enableModule && owner && typeof owner === 'object' && 'enable' in owner) {
            owner.enable = true;
        }
        const gr: any = owner?.[segs[segs.length - 1]];
        if (!gr) return { success: false, error: `GradientRange '${propertyPath}' not found on ${componentType}` };
        if (!gr.gradient || typeof gr.gradient.setKeys !== 'function') {
            return { success: false, error: `Property '${propertyPath}' is not a GradientRange` };
        }

        const { Color, ColorKey, AlphaKey } = cc;
        const cks = (colorKeys || []).map((k) => {
            const ck = new ColorKey();
            const c = k.color || {};
            ck.color = new Color(c.r ?? 255, c.g ?? 255, c.b ?? 255, c.a ?? 255);
            ck.time = Number(k.time) || 0;
            return ck;
        });
        const aks = (alphaKeys || []).map((k) => {
            const ak = new AlphaKey();
            ak.alpha = k.alpha != null ? Number(k.alpha) : 255;
            ak.time = Number(k.time) || 0;
            return ak;
        });

        gr.mode = mode != null ? mode : 1; // GradientRange.Mode.Gradient
        gr.gradient.setKeys(cks, aks);

        return {
            success: true,
            data: {
                propertyPath,
                mode: gr.mode,
                colorKeys: gr.gradient.colorKeys.length,
                alphaKeys: gr.gradient.alphaKeys.length,
                moduleEnabled: !!(enableModule && owner && 'enable' in owner),
            },
        };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
};

/**
 * Populate a particle CurveRange's animation curve via the ENGINE API. Like gradients,
 * a CurveRange spline (RealCurve) cannot be written through the editor `set-property`
 * channel, so we set `mode`/`multiplier` and call `spline.assignSorted(...)` on the live
 * component. Persisted on the next scene save.
 *
 * `propertyPath` addresses the CurveRange, dotted for sub-modules, e.g.
 * 'sizeOvertimeModule.size', 'velocityOvertimeModule.speedModifier', 'rateOverTime'.
 * `mode` defaults to 1 (Curve). `keyframes` is [{time,value}] with time in 0..1.
 */
export const setParticleCurve: SceneMethods['setParticleCurve'] = (
    nodeUuid, componentType, propertyPath, keyframes, mode, multiplier, enableModule,
) => {
    try {
        const scene = requireActiveScene();
        const node = findNodeByUuid(scene, nodeUuid);
        const ComponentClass = findComponentClass(componentType);
        const comp = node.getComponent(ComponentClass);
        if (!comp) return { success: false, error: `Component ${componentType} not found on node` };

        const segs = String(propertyPath).split('.');
        let owner: any = comp;
        for (let i = 0; i < segs.length - 1; i++) {
            owner = owner?.[segs[i]];
            if (owner == null) return { success: false, error: `Path segment '${segs[i]}' is null on ${componentType}` };
        }
        if (enableModule && owner && typeof owner === 'object' && 'enable' in owner) {
            owner.enable = true;
        }
        const cr: any = owner?.[segs[segs.length - 1]];
        if (!cr || !cr.spline || typeof cr.spline.assignSorted !== 'function') {
            return { success: false, error: `Property '${propertyPath}' is not a CurveRange` };
        }

        const kf = (keyframes || []).slice().sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
        const times = kf.map((k) => Number(k.time) || 0);
        const values = kf.map((k) => Number(k.value) || 0);
        cr.mode = mode != null ? mode : 1; // CurveRange.Mode.Curve
        if (multiplier != null) cr.multiplier = multiplier;
        // assignSorted(times[], values[]) — the RealCurve accepts a parallel value array.
        cr.spline.assignSorted(times, values);

        return {
            success: true,
            data: {
                propertyPath,
                mode: cr.mode,
                multiplier: cr.multiplier,
                keyCount: times.length,
                eval0: cr.spline.evaluate(0),
                eval1: cr.spline.evaluate(1),
                moduleEnabled: !!(enableModule && owner && 'enable' in owner),
            },
        };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
};

/**
 * Attach a SkeletalAnimation socket to a bone via the ENGINE (`SkeletalAnimation.createSocket`),
 * the exact path the editor's socket `+` button uses. The editor `set-property` channel cannot
 * write `sockets` (a Socket[] whose elements hold a Node reference) nor create the tracked target
 * node the socket needs, so this is done on the live component. `createSocket`:
 *   - creates a child Node under the SkeletalAnimation node named "<lastBone> Socket",
 *   - pushes `new Socket(bonePath, target)` and calls `rebuildSocketAnimations()` so the target
 *     tracks the bone even with `useBakedAnimation = true`.
 * The editor sees both the new node (query-node) and the updated sockets array (query-component),
 * so it serialises them on the next scene/prefab save. Parent a weapon model under the returned
 * target uuid to hang it off the bone. Idempotent: an existing socket for `bonePath` is reused.
 */
export const addSkeletalSocket: SceneMethods['addSkeletalSocket'] = (nodeUuid, bonePath, targetName) => {
    try {
        const scene = requireActiveScene();
        const node = findNodeByUuid(scene, nodeUuid);
        const sk = node.getComponent('cc.SkeletalAnimation');
        if (!sk) return { success: false, error: 'Node has no cc.SkeletalAnimation component' };
        if (typeof sk.createSocket !== 'function') {
            return { success: false, error: 'SkeletalAnimation.createSocket is unavailable in this engine build' };
        }
        if (!bonePath || typeof bonePath !== 'string') {
            return { success: false, error: 'bonePath must be a non-empty bone path string (e.g. "mixamorig_Hips/.../mixamorig_RightHand")' };
        }
        const wantedName = typeof targetName === 'string' && targetName.trim() ? targetName.trim() : null;
        // Reuse an existing socket for the same bone rather than stacking duplicates.
        const existing = (sk.sockets || []).find((s: any) => s && s.path === bonePath);
        if (existing && existing.target) {
            const renamed = !!wantedName && existing.target.name !== wantedName;
            if (renamed) existing.target.name = wantedName;
            return { success: true, data: { targetUuid: existing.target.uuid, targetName: existing.target.name, bonePath, created: false, renamed, socketCount: sk.sockets.length } };
        }
        // Fail loudly if the bone path does not resolve to a joint under this node — otherwise
        // createSocket would silently make a dead target stuck at the node origin.
        const joint = typeof node.getChildByPath === 'function' ? node.getChildByPath(bonePath) : undefined;
        if (joint === null || joint === undefined) {
            return { success: false, error: `Bone path '${bonePath}' does not resolve to a child joint of node '${node.name}'. Pass the full path from the SkeletalAnimation node, e.g. "mixamorig_Hips/mixamorig_Spine/.../mixamorig_RightHand".` };
        }
        const target = sk.createSocket(bonePath);
        if (!target) return { success: false, error: `createSocket returned null for bone path '${bonePath}'` };
        if (wantedName) target.name = wantedName;
        return { success: true, data: { targetUuid: target.uuid, targetName: target.name, bonePath, created: true, renamed: !!wantedName, socketCount: sk.sockets.length } };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
};

export const listSkeletalSockets: SceneMethods['listSkeletalSockets'] = (nodeUuid) => {
    try {
        const scene = requireActiveScene();
        const node = findNodeByUuid(scene, nodeUuid);
        const sk = node.getComponent('cc.SkeletalAnimation');
        if (!sk) return { success: false, error: 'Node has no cc.SkeletalAnimation component' };
        const sockets = (sk.sockets || []).map((s: any) => ({
            path: s.path,
            targetUuid: s.target && s.target.uuid,
            targetName: s.target && s.target.name,
            targetChildren: s.target ? s.target.children.map((c: any) => c.name) : []
        }));
        return { success: true, data: { nodeUuid, useBakedAnimation: sk.useBakedAnimation, sockets } };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
};

/**
 * Remove a SkeletalAnimation socket by bone path: drop the sockets[] entry, destroy its tracked
 * target node (and anything parented under it), and rebuild. Mirrors the socket `-` button.
 */
export const removeSkeletalSocket: SceneMethods['removeSkeletalSocket'] = (nodeUuid, bonePath) => {
    try {
        const scene = requireActiveScene();
        const node = findNodeByUuid(scene, nodeUuid);
        const sk = node.getComponent('cc.SkeletalAnimation');
        if (!sk) return { success: false, error: 'Node has no cc.SkeletalAnimation component' };
        const match = (sk.sockets || []).find((s: any) => s && s.path === bonePath);
        if (!match) return { success: false, error: `No socket with bone path '${bonePath}' on this node` };
        const target = match.target;
        sk.sockets = (sk.sockets || []).filter((s: any) => s !== match);
        if (target && target.isValid) target.destroy();
        if (typeof sk.rebuildSocketAnimations === 'function') sk.rebuildSocketAnimations();
        return { success: true, data: { bonePath, removedTargetUuid: target && target.uuid, socketCount: sk.sockets.length } };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
};
