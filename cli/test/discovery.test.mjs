/**
 * Instance selection is the only place the CLI decides which editor to talk to. Covered here: the
 * silent pick of the only one, telling instances apart by substring, and the two loud failures —
 * nothing found, and several found with nothing naming one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EXIT, selectInstance, discover } from '../src/discovery.ts';

const hello = (project, projectPath) => ({
    project, projectPath, pid: 1, version: '2.0.0', surfaceChecksum: 'abc'
});
const CYBER = hello('CyberCore', 'D:/cocos/games/CyberCore');
const WEED = hello('tl_weedmanager1a', 'D:/cocos/games/tl_weedmanager1a');
const WINDOWS = hello('WindowsPath', 'D:\\cocos\\games\\WindowsPath');

test('the only live instance is taken without being named', () => {
    const result = selectInstance([CYBER]);
    assert.equal(result.ok, true);
    assert.equal(result.chosen.project, 'CyberCore');
});

test('no live instance gives a refusal that names where it looked', () => {
    const result = selectInstance([]);
    assert.equal(result.ok, false);
    assert.match(result.message, /no open/i);
});

test('several live instances with none named give a refusal listing both', () => {
    const result = selectInstance([CYBER, WEED]);
    assert.equal(result.ok, false);
    assert.match(result.message, /CyberCore/);
    assert.match(result.message, /tl_weedmanager1a/);
});

test('a substring tells instances apart and ignores case', () => {
    assert.equal(selectInstance([CYBER, WEED], 'weed').chosen.project, 'tl_weedmanager1a');
    assert.equal(selectInstance([CYBER, WEED], 'CYBER').chosen.project, 'CyberCore');
});

test('a substring matches the project path too, not only the name', () => {
    assert.equal(selectInstance([CYBER, WEED], 'games/CyberCore').chosen.project, 'CyberCore');
});

test('a substring matching both gives a refusal rather than the silent first', () => {
    const result = selectInstance([CYBER, WEED], 'cocos/games');
    assert.equal(result.ok, false);
    assert.match(result.message, /several/i);
});

test('a substring matching nothing is quoted back', () => {
    const result = selectInstance([CYBER, WEED], 'zzz');
    assert.equal(result.ok, false);
    assert.match(result.message, /zzz/);
});

test('a channel that did not answer never becomes a candidate', async () => {
    const list = () => ['cocos-cli-aaa', 'cocos-cli-bbb', 'somethingelse'];
    const probe = async (address) => (address.endsWith('aaa') ? CYBER : null);
    const found = await discover(probe, list);
    assert.deepEqual(found.map(h => h.project), ['CyberCore']);
});

test('the exit codes tell a missing editor from a failed operation', () => {
    assert.equal(EXIT.OK, 0);
    assert.equal(EXIT.FAILED, 1);
    assert.equal(EXIT.USAGE, 2);
    assert.equal(EXIT.NO_EDITOR, 3);
    assert.equal(EXIT.PROTOCOL, 4);
});

test('backslashes in a candidate path are normalized while matching', () => {
    assert.equal(
        selectInstance([WINDOWS], 'D:/cocos/games/WindowsPath').chosen.project,
        'WindowsPath');
    assert.equal(
        selectInstance([WINDOWS], 'games\\WindowsPath').chosen.project,
        'WindowsPath');
});
