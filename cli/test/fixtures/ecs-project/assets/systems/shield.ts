const shielded = world.with('shieldTimer');

export function tickShield(entity: Entity): void {
    if (entity.shieldTimer.left > 0) glow(entity);
}
