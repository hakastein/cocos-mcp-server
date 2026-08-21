/**
 * A Cocos project keeps a second copy of every script under `library/`, so a walk that reads both
 * counts every site twice — which is why the walk is checked against a fixture tree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_KIT, kitRoot, readKit } from '../src/ecs/kit.ts';

const PROJECT = path.resolve('/projects/CyberCore');
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ecs-project', 'assets');

test('the default kit is the project\'s own asset tree', () => {
    assert.equal(kitRoot(PROJECT, DEFAULT_KIT), path.join(PROJECT, 'assets'));
});

test('a db:// url under assets resolves against the project, segment by segment', () => {
    assert.equal(kitRoot(PROJECT, 'db://assets/shared/ecs'), path.join(PROJECT, 'assets', 'shared', 'ecs'));
});

test('a db:// url outside assets is refused rather than guessed at', () => {
    assert.throws(() => kitRoot(PROJECT, 'db://internal/effects'), /db:\/\/assets/);
});

test('a url that merely starts with the same letters is not treated as being under assets', () => {
    assert.throws(() => kitRoot(PROJECT, 'db://assets-backup/ecs'), /db:\/\/assets/);
});

test('an absolute path is taken as written', () => {
    const absolute = path.resolve('/elsewhere/kit');
    assert.equal(kitRoot(PROJECT, absolute), absolute);
});

test('a relative path resolves against the shell, not against the project', () => {
    assert.equal(kitRoot(PROJECT, 'ecs'), path.resolve('ecs'));
});

test('every .ts file under the root is read, addressed relative to it with forward slashes', () => {
    const scan = readKit(FIXTURE);
    assert.deepEqual(scan.sources.map(source => source.path).sort(), [
        'assembly.ts', 'entity.ts', 'systems/combat.ts', 'systems/shield.ts'
    ]);
    assert.deepEqual(scan.unreadable, []);
});

test('a declaration file carries no implementation, so it is not part of the census', () => {
    const scan = readKit(FIXTURE);
    assert.equal(scan.sources.some(source => source.path.endsWith('.d.ts')), false);
});

test('library/ is the editor\'s own copy of the same scripts and is not walked', () => {
    const scan = readKit(FIXTURE);
    assert.equal(scan.sources.some(source => source.path.startsWith('library/')), false);
});

test('a root that is not there names itself in the refusal', () => {
    const missing = path.join(FIXTURE, 'no-such-kit');
    assert.throws(() => readKit(missing), error => error.message.includes(missing));
});

/** A junction, not a plain symlink: that is what a Cocos project uses and what needs no elevation. */
function junctionProject(name) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
    fs.mkdirSync(path.join(root, 'assets'));
    fs.mkdirSync(path.join(root, 'kit', 'systems'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kit', 'systems', 'aim.ts'), 'const q = world.with(\'aim\');\n');
    fs.symlinkSync(path.join(root, 'kit'), path.join(root, 'assets', 'framework'), 'junction');
    return root;
}

test('a kit mounted into assets as a junction is walked, not stopped at', t => {
    const root = junctionProject('cocos-kit-junction-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.deepEqual(readKit(path.join(root, 'assets')).sources.map(source => source.path),
        ['framework/systems/aim.ts']);
});

test('a link that points back up the tree is walked once rather than forever', t => {
    const root = junctionProject('cocos-kit-cycle-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.symlinkSync(path.join(root, 'assets'), path.join(root, 'kit', 'back'), 'junction');
    assert.deepEqual(readKit(path.join(root, 'assets')).sources.map(source => source.path),
        ['framework/systems/aim.ts']);
});
