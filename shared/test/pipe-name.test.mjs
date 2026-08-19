import test from 'node:test';
import assert from 'node:assert/strict';

import { PIPE_PREFIX, instanceKey, pipePath, pipeDirectory } from '../dist/pipe-name.js';

test('один путь даёт один и тот же ключ при каждом вызове', () => {
    const a = instanceKey('D:/cocos/games/CyberCore', 'win32');
    const b = instanceKey('D:/cocos/games/CyberCore', 'win32');
    assert.equal(a, b);
    assert.equal(a.length, 12);
});

test('разные проекты дают разные ключи', () => {
    assert.notEqual(
        instanceKey('D:/cocos/games/CyberCore', 'win32'),
        instanceKey('D:/cocos/games/tl_weedmanager1a', 'win32'));
});

test('на windows регистр пути не разводит проекты, на posix разводит', () => {
    assert.equal(
        instanceKey('D:/Cocos/Games/CyberCore', 'win32'),
        instanceKey('d:/cocos/games/cybercore', 'win32'));
    assert.notEqual(
        instanceKey('/home/u/Games/Core', 'linux'),
        instanceKey('/home/u/games/core', 'linux'));
});

test('на windows это канал в пространстве имён, на posix — сокет во временном каталоге', () => {
    const key = instanceKey('D:/cocos/games/CyberCore', 'win32');
    assert.equal(pipePath('D:/cocos/games/CyberCore', 'win32'), `\\\\.\\pipe\\${PIPE_PREFIX}${key}`);
    assert.equal(
        pipePath('/home/u/game', 'linux', '/tmp'),
        `/tmp/cocos-cli/${instanceKey('/home/u/game', 'linux')}.sock`);
});

test('каталог поиска — то место, которое CLI перечисляет', () => {
    assert.equal(pipeDirectory('win32'), '\\\\.\\pipe\\');
    assert.equal(pipeDirectory('linux', '/tmp'), '/tmp/cocos-cli');
});
