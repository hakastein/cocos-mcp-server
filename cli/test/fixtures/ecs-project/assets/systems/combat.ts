const hurt = world.with('health');

export function applyDamage(entity: Entity, amount: number): void {
    entity.health.current -= amount;
}
