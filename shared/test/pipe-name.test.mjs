import test from 'node:test';
import assert from 'node:assert/strict';

import { PIPE_PREFIX, instanceKey, pipePath, pipeDirectory } from '../dist/pipe-name.js';

test('one path gives the same key on every call', () => {
    const a = instanceKey('D:/cocos/games/CyberCore', 'win32');
    const b = instanceKey('D:/cocos/games/CyberCore', 'win32');
    assert.equal(a, b);
    assert.equal(a.length, 12);
});

test('different projects give different keys', () => {
    assert.notEqual(
        instanceKey('D:/cocos/games/CyberCore', 'win32'),
        instanceKey('D:/cocos/games/tl_weedmanager1a', 'win32'));
});

test('on windows path case does not split projects, on posix it does', () => {
    assert.equal(
        instanceKey('D:/Cocos/Games/CyberCore', 'win32'),
        instanceKey('d:/cocos/games/cybercore', 'win32'));
    assert.notEqual(
        instanceKey('/home/u/Games/Core', 'linux'),
        instanceKey('/home/u/games/core', 'linux'));
});

test('on windows it is a named pipe, on posix a socket in the temp directory', () => {
    const key = instanceKey('D:/cocos/games/CyberCore', 'win32');
    assert.equal(pipePath('D:/cocos/games/CyberCore', 'win32'), `\\\\.\\pipe\\${PIPE_PREFIX}${key}`);
    const linuxKey = instanceKey('/home/u/game', 'linux');
    assert.equal(
        pipePath('/home/u/game', 'linux', '/tmp'),
        `/tmp/cocos-cli/${PIPE_PREFIX}${linuxKey}.sock`);
});

test('the search directory is the place the CLI enumerates', () => {
    assert.equal(pipeDirectory('win32'), '\\\\.\\pipe\\');
    assert.equal(pipeDirectory('linux', '/tmp'), '/tmp/cocos-cli');
});

test('back and forward slashes in one path give one key', () => {
    assert.equal(
        instanceKey('D:\\cocos\\games\\CyberCore', 'win32'),
        instanceKey('D:/cocos/games/CyberCore', 'win32'));
});

test('a trailing slash and repeated separators leave the key unchanged', () => {
    const base = instanceKey('D:/cocos/games/CyberCore', 'win32');
    assert.equal(
        instanceKey('D:/cocos/games/CyberCore/', 'win32'),
        base);
    assert.equal(
        instanceKey('D:/cocos//games/CyberCore', 'win32'),
        base);
});

test('relative segments collapse to one key', () => {
    assert.equal(
        instanceKey('D:/cocos/games/Other/../CyberCore', 'win32'),
        instanceKey('D:/cocos/games/CyberCore', 'win32'));
});

test('a POSIX path carries the prefix in the file name', () => {
    const path = pipePath('/home/u/game', 'linux', '/tmp');
    const basename = path.split('/').pop();
    assert(basename.startsWith(PIPE_PREFIX), `basename ${basename} has to start with ${PIPE_PREFIX}`);
});
