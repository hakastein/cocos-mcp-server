/**
 * The census exists to catch a component that is read and never written — the failure no unit test
 * over the systems themselves can see. So the tests that matter here are the negative controls: a
 * kit missing one writer must have that key named, and the shapes that legitimately supply a writer
 * (an object literal at assembly, a command buffer, a key-forwarding wrapper) must all count.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runCensus } from '../src/ecs/census.ts';

const declaring = (...keys) => ({
    path: 'components.ts',
    text: `declare module './core/world' {\n    interface Entity {\n${keys.map((k) => `        ${k}?: true;`).join('\n')}\n    }\n}\n`,
});

const flagged = (result) => result.readWithoutWriter.map((report) => report.key);

test('a key with readers and no writer is flagged', () => {
    const result = runCensus([
        declaring('cooldown'),
        { path: 'systems.ts', text: `const q = world.with('cooldown');\nfunction run() { if (entity.cooldown) doThing(); }\n` },
    ]);
    assert.deepEqual(flagged(result), ['cooldown']);
});

test('the same key is not flagged once a command buffer adds it', () => {
    const result = runCensus([
        declaring('cooldown'),
        { path: 'systems.ts', text: `const q = world.with('cooldown');\nfunction run() { commands.add(entity, 'cooldown', true); }\n` },
    ]);
    assert.deepEqual(flagged(result), []);
    assert.equal(result.keys[0].counts.adders, 1);
});

test('an entity object literal at assembly counts as an adder', () => {
    const result = runCensus([
        declaring('frozen'),
        { path: 'assembly.ts', text: `const q = world.with('frozen');\nfunction seed() { world.add({ frozen: true }); }\n` },
    ]);
    assert.deepEqual(flagged(result), []);
});

test('a key-forwarding wrapper carries the add through to its call sites', () => {
    const result = runCensus([
        declaring('iconSwapView'),
        {
            path: 'assembly.ts',
            text: `const q = world.with('iconSwapView');\n`
                + `function claim<K extends keyof Entity>(world: GameWorld, entity: Entity, key: K, value: NonNullable<Entity[K]>): void {\n`
                + `    if (entity[key] !== undefined) return;\n`
                + `    world.addComponent(entity, key, value as never);\n`
                + `}\n`
                + `function seed() { claim(world, point, 'iconSwapView', view); }\n`,
        },
    ]);
    assert.deepEqual(flagged(result), []);
    assert.equal(result.wrappers.find((w) => w.name === 'claim').effects.includes('add'), true);
});

test('a named list of keys expands, so a bulk remove is not lost', () => {
    const result = runCensus([
        declaring('seeking', 'attacking'),
        {
            path: 'death.ts',
            text: `const STRIPPED = ['seeking', 'attacking'];\n`
                + `function die() { for (const key of STRIPPED) commands.remove(entity, STRIPPED[0]); }\n`,
        },
    ]);
    const seeking = result.keys.find((report) => report.key === 'seeking');
    assert.equal(seeking.counts.removers, 1);
    assert.equal(result.keys.find((report) => report.key === 'attacking').counts.removers, 1);
});

test('`this.node` in an engine component is not a read of the `node` component', () => {
    const result = runCensus([
        declaring('node'),
        { path: 'Mountable.ts', text: `class Mountable extends Component {\n    play() { this.node.active = true; }\n}\n` },
    ]);
    assert.equal(result.keys[0].counts.readers, 0);
    assert.equal(result.keys[0].counts.writers, 0);
    assert.equal(result.declaredNeverUsed.length, 1);
});

test('destructuring a component does not read the keys its fields happen to share a name with', () => {
    const result = runCensus([
        declaring('contact', 'damage'),
        {
            path: 'impact.ts',
            text: `const q = world.with('contact');\n`
                + `function impact() { const { hit, damage } = entity.contact; use(hit, damage); }\n`
                + `function seed() { commands.spawn({ contact: { damage: 1 } }); }\n`,
        },
    ]);
    const damage = result.keys.find((report) => report.key === 'damage');
    assert.equal(damage.counts.readers, 0, 'entity.contact.damage is a field of contact, not the damage component');
    assert.equal(damage.counts.adders, 0, 'a field inside a component literal is not an added component');
    assert.deepEqual(flagged(result), []);
});

test('a field write is a write, and the slot assignment is reported separately', () => {
    const result = runCensus([
        declaring('intent'),
        {
            path: 'locomotion.ts',
            text: `const q = world.with('intent');\n`
                + `function assemble() { entity.intent = { vel: v3() }; }\n`
                + `function move() { entity.intent.vel.x = 1; }\n`,
        },
    ]);
    const intent = result.keys[0];
    assert.deepEqual(intent.writers.map((site) => site.kind).sort(), ['fieldWrite', 'set']);
    assert.deepEqual(flagged(result), []);
});

test('a key argument the parser cannot name is reported, not guessed', () => {
    const result = runCensus([
        declaring('frozen'),
        { path: 'assembly.ts', text: `function copy(key: keyof Entity) { world.addComponent(target, key, source[key]); }\n` },
    ]);
    assert.equal(result.unresolved.length, 1);
    assert.match(result.unresolved[0].reason, /not a literal/);
});

test('a key written but never read is reported apart from the flagged list', () => {
    const result = runCensus([
        declaring('wavesReported'),
        { path: 'waves.ts', text: `function report() { commands.add(entity, 'wavesReported', true); }\n` },
    ]);
    assert.deepEqual(flagged(result), []);
    assert.deepEqual(result.writtenNeverRead.map((report) => report.key), ['wavesReported']);
});
