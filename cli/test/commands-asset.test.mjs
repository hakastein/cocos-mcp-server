import test from 'node:test';
import assert from 'node:assert/strict';

import {
    assetCopy, assetGet, assetList, assetMkdir, assetMove, assetReady, assetRefresh, assetReimport,
    assetRemove
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
    const output = present(await assetRefresh(project(), { target: 'db://assets/props', ...wait() }));
    assert.match(output.stdout, /^ok {2}db:\/\/assets\/props {2}refreshed in/);
    assert.match(output.stdout, /no changes/);
    assert.equal(output.failed, false);
});

test('a move names where the asset actually is, and the uuid survives it', async () => {
    const driver = project();
    const output = present(await assetMove(driver, {
        source: 'db://assets/props/rifle.prefab', target: 'db://assets/crates/rifle.prefab', ...wait() }));
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
    const output = present(await assetMove(driver, {
        source: 'db://assets/props/rifle.prefab', target: 'db://assets/crates/rifle.prefab', ...wait() }));
    assert.match(output.stdout, /landed at db:\/\/assets\/crates\/rifle-001\.prefab/);
    assert.equal(await driver.editor.assetDb.queryUrl('u-rifle'), 'db://assets/crates/rifle-001.prefab');
});

test('an asset the database lost track of after the move is a failure rather than a quiet ok', async () => {
    const driver = project();
    driver.editor.assetDb.moveAsset = async () => null;
    driver.editor.assetDb.queryUrl = async () => undefined;
    const output = present(await assetMove(driver, {
        source: 'db://assets/props/rifle.prefab', target: 'db://assets/crates/rifle.prefab', ...wait() }));
    assert.equal(output.stdout.split('  ')[0], 'FAILED');
    assert.match(output.stdout, /at no address/);
});

test('a copy waits for the database and reports the new asset, not the original', async () => {
    const driver = project();
    const output = present(await assetCopy(driver, {
        source: 'db://assets/props/rifle.prefab', target: 'db://assets/crates/rifle.prefab', ...wait() }));
    assert.match(output.stdout, /^ok/);
    assert.match(output.stdout, /\+ db:\/\/assets\/crates\/rifle\.prefab/);
    assert.notEqual(await driver.editor.assetDb.queryUuid('db://assets/crates/rifle.prefab'), 'u-rifle');
});

test('a copy the database renamed around a taken address names the address it reached', async () => {
    const driver = db({
        'db://assets/props/rifle.prefab': 'u-rifle',
        'db://assets/crates/rifle.prefab': 'u-other'
    });
    const output = present(await assetCopy(driver, {
        source: 'db://assets/props/rifle.prefab', target: 'db://assets/crates/rifle.prefab', ...wait() }));
    assert.match(output.stdout, /landed at db:\/\/assets\/crates\/rifle-001\.prefab/);
    assert.equal(output.failed, false);
});

test('a delete reports the assets that went and leaves the uuid at no address', async () => {
    const driver = project();
    const output = present(await assetRemove(driver, { target: 'db://assets/props', ...wait() }));
    assert.match(output.stdout, /^ok/);
    assert.match(output.stdout, /- db:\/\/assets\/props\/rifle\.prefab/);
    assert.equal(await driver.editor.assetDb.queryUrl('u-rifle'), undefined);
});

test('a folder the database still holds after the delete is a failure, not a silent ok', async () => {
    const driver = project();
    driver.editor.assetDb.deleteAsset = async () => null;
    const output = present(await assetRemove(driver, { target: 'db://assets/props', ...wait() }));
    assert.equal(output.stdout.split('  ')[0], 'FAILED');
    assert.match(output.stdout, /still at db:\/\/assets\/props/);
});

test('mkdir waits for the folder to be imported before answering', async () => {
    const driver = project();
    const output = present(await assetMkdir(driver, { folder: 'db://assets/props/decals', ...wait() }));
    assert.match(output.stdout, /^ok {2}db:\/\/assets\/props\/decals {2}created in/);
    assert.match(output.stdout, /\+ db:\/\/assets\/props\/decals/);
    assert.equal(output.failed, false);
});

// `settled` is a real answer for every asset command, which is why `persisted` has no place in the
// report: the file is written at once and outside the undo stack.
test('a database that never goes quiet is a TIMEOUT rather than a copy reported as done', async () => {
    const driver = project();
    driver.editor.assetDb.queryReady = async () => false;
    const output = present(await assetCopy(driver, {
        source: 'db://assets/props/rifle.prefab', target: 'db://assets/crates/rifle.prefab',
        ...wait({ timeoutMs: 60 }) }));
    assert.equal(output.stdout.split('  ')[0], 'TIMEOUT');
    assert.equal(output.failed, true);
});

test('a copy the database never gained is a failure rather than an address invented for it', async () => {
    const driver = project();
    driver.editor.assetDb.copyAsset = async () => null;
    const output = present(await assetCopy(driver, {
        source: 'db://assets/props/rifle.prefab', target: 'db://assets/crates/rifle.prefab', ...wait() }));
    assert.equal(output.stdout.split('  ')[0], 'FAILED');
    assert.match(output.stdout, /no copy of db:\/\/assets\/props\/rifle\.prefab appeared/);
});

test('get names the asset by its db:// url and by its uuid alike', async () => {
    const driver = project();
    assert.match(present(await assetGet(driver, { target: 'db://assets/props/rifle.prefab' })).stdout,
        /u-rifle/);
    assert.match(present(await assetGet(driver, { target: 'u-rifle' })).stdout,
        /db:\/\/assets\/props\/rifle\.prefab/);
});

test('--field prints one value bare, for a shell to read', async () => {
    const output = present(await assetGet(
        project(), { target: 'db://assets/props/rifle.prefab', field: 'uuid' }));
    assert.equal(output.stdout, 'u-rifle');
});

test('an address the database does not know is refused rather than printed empty', async () => {
    await assert.rejects(
        () => assetGet(project(), { target: 'db://assets/props/none.prefab' }), /does not know/);
});

test('ls lists what is under the folder it was given', async () => {
    const output = present(await assetList(project(), { folder: 'db://assets/props' }));
    assert.match(output.stdout, /rifle\.prefab/);
    assert.doesNotMatch(output.stdout, /crates/);
});

test('--name narrows the listing and the summary still names the full count', async () => {
    const driver = db({
        'db://assets/props/rifle.prefab': 'u-rifle',
        'db://assets/props/pistol.prefab': 'u-pistol'
    });
    const output = present(await assetList(driver, { folder: 'db://assets/props', name: 'rifle' }));
    assert.match(output.stdout, /rifle\.prefab/);
    assert.doesNotMatch(output.stdout, /pistol/);
});

// The cap is on the listing, not on the count: a summary that shrank with it would say the project
// holds fewer assets than it does.
test('--max cuts the listing while the summary keeps the whole count', async () => {
    const driver = db({
        'db://assets/props/a.prefab': 'u-a',
        'db://assets/props/b.prefab': 'u-b',
        'db://assets/props/c.prefab': 'u-c'
    });
    const output = present(await assetList(driver, { folder: 'db://assets/props', max: 1 }));
    assert.equal(output.stdout.split('\n').length, 1);
    assert.match(output.stderr, /3/);
});

test('a type outside the known list is refused, naming the ones that are known', async () => {
    await assert.rejects(
        () => assetList(project(), { folder: 'db://assets/props', type: 'blueprint' }),
        /blueprint.*is not known/);
});

test('reimport reruns the importer on the asset and waits for the database to go quiet', async () => {
    const driver = project();
    const output = present(await assetReimport(
        driver, { target: 'db://assets/props/rifle.prefab', ...wait() }));
    assert.match(output.stdout, /^ok {2}db:\/\/assets\/props\/rifle\.prefab {2}reimported in/);
    assert.equal(driver.calls.find(call => call.name === 'assetDb.reimportAsset').args[0],
        'db://assets/props/rifle.prefab');
});

// A file that appeared past the editor is not in the database yet, and a reimport of it would
// answer about nothing at all.
test('an asset the database does not know is refused, pointing at refresh', async () => {
    await assert.rejects(
        () => assetReimport(project(), { target: 'db://assets/props/new.prefab', ...wait() }),
        /cocos asset refresh/);
});

test('ready answers whether the database finished starting up', async () => {
    assert.match(present(await assetReady(project())).stdout, /^ok {2}the asset database is ready/);
});

test('a database still starting up is a non-zero exit rather than a quiet no', async () => {
    const driver = project();
    driver.editor.assetDb.queryReady = async () => false;
    const output = present(await assetReady(driver));
    assert.equal(output.stdout.split('  ')[0], 'FAILED');
    assert.equal(output.failed, true);
});
