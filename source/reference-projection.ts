/**
 * What a node/component reference field will hold the NEXT time the scene is opened.
 *
 * A reference that crosses into a prefab instance is never written into the scene file: the
 * serializer emits null for it, and the link survives only as a `cc.TargetOverrideInfo` that
 * `Prefab._utils.applyTargetOverrides` replays after the load. Reading the field back off the live
 * engine object therefore proves that the setter ran and nothing else — it is the same object the
 * write just touched, and it agrees whether or not anything was recorded.
 *
 * These two functions are that reconciliation, kept free of the engine so they can be tested: one
 * builds the post-load value, the other names the overrides the field's current contents
 * contradict.
 */

/** One `cc.TargetOverrideInfo`, reduced to what decides the outcome. */
export interface ReferenceOverride {
    /** Array index it writes; null for a single-reference field. */
    index: number | null;
    /** What it resolves to in the scene as it stands, or null when it resolves to nothing. */
    uuid: string | null;
}

/**
 * The field as the next load builds it: the deserialized value first, then every override that
 * still resolves. An override past the end of the array grows the array, exactly as the engine's
 * plain assignment does — which is how an array shortened through the editor comes back longer.
 */
export function projectAfterReload(
    serialized: Array<string | null>,
    overrides: ReferenceOverride[]
): Array<string | null> {
    const projected: Array<string | null | undefined> = serialized.slice();
    for (const override of overrides) {
        if (override.uuid === null) continue;
        projected[override.index === null ? 0 : override.index] = override.uuid;
    }
    return Array.from(projected, (uuid) => (uuid === undefined ? null : uuid));
}

/**
 * Positions in `overrides` that the field's current contents contradict. The editor records one
 * override per slot it writes and never takes one away, so whatever is left behind wins over the
 * serialized value on the next load: a slot repointed at a node outside the instance snaps back to
 * the old target, and a shortened array grows back.
 */
export function contradictedOverrides(
    live: Array<string | null>,
    overrides: ReferenceOverride[]
): number[] {
    const positions: number[] = [];
    overrides.forEach((override, position) => {
        const index = override.index === null ? 0 : override.index;
        if (index >= live.length || live[index] !== override.uuid) positions.push(position);
    });
    return positions;
}
