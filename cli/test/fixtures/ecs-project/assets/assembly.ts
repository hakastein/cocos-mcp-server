export function spawnHero(world: GameWorld, entity: Entity): void {
    world.add({ health: { current: 100 } });
    commands.add(entity, 'wavesReported', true);
}
