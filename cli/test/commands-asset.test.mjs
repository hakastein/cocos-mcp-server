import test from 'node:test';
import assert from 'node:assert/strict';

import {
    assetCopy, assetMkdir, assetMove, assetRefresh, assetRemove
} from '../src/commands/asset.ts';
import { present } from '../src/render/present.ts';
import { MemoryDriver } from '../src/driver/memory.ts';

/** The clock the wait is judged by: real time never advances far enough inside one test. */
const wait = (over = {}) => {
    let now = 0;
    return { timeoutMs: 2000, quietForMs: 1000, intervalMs: 1, now: () => (now += 1000), ...over };
};

const db = (assets) => new MemoryDriver({ nodes: [], assets });

const project = () => db({
    'db://assets/props': 'u-props',
    'db://assets/props/rifle.prefab': 'u-rifle',
    'db://assets/crates': 'u-crates'
});

test('a refresh that changed nothing says so and exits zero', async () => {
    const output = present(await assetRefresh(project(), 'db://assets/props', wait()));
    assert.match(output.stdout, /^ok {2}db:\/\/assets\/props {2}refreshed in/);
    assert.match(output.stdout, /no changes/);
    assert.equal(output.failed, false);
});

test('a move names where the asset actually is, and the uuid survives it', async () => {
    const driver = project();
    const output = present(await assetMove(
        driver, 'db://assets/props/rifle.prefab', 'db://assets/crates/rifle.prefab', wait()));
    assert.match(output.stdout, /^ok/);
    assert.doesNotMatch(output.stdout, /landed at/);
    assert.equal(await driver.editor.assetDb.queryUrl('u-rifle'), 'db://assets/crates/rifle.prefab');
});

// Rename-on-conflict is the default, so the address asked for is not the address reached, and a
// following command run against the asked-for one would touch the wrong asset.
test('a move onto a taken address names the renamed address it reached', async () => {
    const driver = db({
        'db://assets/props/rifle.prefab': 'u-rifle',
        'db://assets/crates/rifle.prefab': 'u-other'
    });
    const output = present(await assetMove(
        driver, 'db://assets/props/rifle.prefab', 'db://assets/crates/rifle.prefab', wait()));
    assert.match(output.stdout, /landed at db:\/\/assets\/crates\/rifle-001\.prefab/);
    assert.equal(await driver.editor.assetDb.queryUrl('u-rifle'), 'db://assets/crates/rifle-001.prefab');
});

test('an asset the database lost track of after the move is a failure rather than a quiet ok', async () => {
    const driver = project();
    driver.editor.assetDb.moveAsset = async () => null;
    driver.editor.assetDb.queryUrl = async () => undefined;
    const output = present(await assetMove(
        driver, 'db://assets/props/rifle.prefab', 'db://assets/crates/rifle.prefab', wait()));
    assert.equal(output.stdout.split('  ')[0], 'FAILED');
    assert.match(output.stdout, /at no address/);
});

test('a copy waits for the database and reports the new asset, not the original', async () => {
    const driver = project();
    const output = present(await assetCopy(
        driver, 'db://assets/props/rifle.prefab', 'db://assets/crates/rifle.prefab', wait()));
    assert.match(output.stdout, /^ok/);
    assert.match(output.stdout, /\+ db:\/\/assets\/crates\/rifle\.prefab/);
    assert.notEqual(await driver.editor.assetDb.queryUuid('db://assets/crates/rifle.prefab'), 'u-rifle');
});

test('a copy the database renamed around a taken address names the address it reached', async () => {
    const driver = db({
        'db://assets/props/rifle.prefab': 'u-rifle',
        'db://assets/crates/rifle.prefab': 'u-other'
    });
    const output = present(await assetCopy(
        driver, 'db://assets/props/rifle.prefab', 'db://assets/crates/rifle.prefab', wait()));
    assert.match(output.stdout, /landed at db:\/\/assets\/crates\/rifle-001\.prefab/);
    assert.equal(output.failed, false);
});

test('a delete reports the assets that went and leaves the uuid at no address', async () => {
    const driver = project();
    const output = present(await assetRemove(driver, 'db://assets/props', wait()));
    assert.match(output.stdout, /^ok/);
    assert.match(output.stdout, /- db:\/\/assets\/props\/rifle\.prefab/);
    assert.equal(await driver.editor.assetDb.queryUrl('u-rifle'), undefined);
});

test('a folder the database still holds after the delete is a failure, not a silent ok', async () => {
    const driver = project();
    driver.editor.assetDb.deleteAsset = async () => null;
    const output = present(await assetRemove(driver, 'db://assets/props', wait()));
    assert.equal(output.stdout.split('  ')[0], 'FAILED');
    assert.match(output.stdout, /still at db:\/\/assets\/props/);
});

test('mkdir waits for the folder to be imported before answering', async () => {
    const driver = project();
    const output = present(await assetMkdir(driver, 'db://assets/props/decals', wait()));
    assert.match(output.stdout, /^ok {2}db:\/\/assets\/props\/decals {2}created in/);
    assert.match(output.stdout, /\+ db:\/\/assets\/props\/decals/);
    assert.equal(output.failed, false);
});

// `settled` is a real answer for every asset command, which is why `persisted` has no place in the
// report: the file is written at once and outside the undo stack.
test('a database that never goes quiet is a TIMEOUT rather than a copy reported as done', async () => {
    const driver = project();
    driver.editor.assetDb.queryReady = async () => false;
    const output = present(await assetCopy(
        driver, 'db://assets/props/rifle.prefab', 'db://assets/crates/rifle.prefab',
        wait({ timeoutMs: 60 })));
    assert.equal(output.stdout.split('  ')[0], 'TIMEOUT');
    assert.equal(output.failed, true);
});

test('a copy the database never gained is a failure rather than an address invented for it', async () => {
    const driver = project();
    driver.editor.assetDb.copyAsset = async () => null;
    const output = present(await assetCopy(
        driver, 'db://assets/props/rifle.prefab', 'db://assets/crates/rifle.prefab', wait()));
    assert.equal(output.stdout.split('  ')[0], 'FAILED');
    assert.match(output.stdout, /no copy of db:\/\/assets\/props\/rifle\.prefab appeared/);
});
