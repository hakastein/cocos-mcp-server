/**
 * Выбор инстанса — единственное место, где CLI решает, с каким редактором говорить. Проверяется
 * молчаливый выбор единственного, разведение по подстроке, и две громкие неудачи: не найдено
 * ничего и найдено несколько без указания.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EXIT, selectInstance, discover } from '../lib/discovery.js';

const hello = (project, projectPath) => ({
    project, projectPath, pid: 1, version: '2.0.0', surfaceChecksum: 'abc'
});
const CYBER = hello('CyberCore', 'D:/cocos/games/CyberCore');
const WEED = hello('tl_weedmanager1a', 'D:/cocos/games/tl_weedmanager1a');
const WINDOWS = hello('WindowsPath', 'D:\\cocos\\games\\WindowsPath');

test('единственный живой инстанс берётся без указания', () => {
    const result = selectInstance([CYBER]);
    assert.equal(result.ok, true);
    assert.equal(result.chosen.project, 'CyberCore');
});

test('ни одного живого — отказ, который называет, что искали', () => {
    const result = selectInstance([]);
    assert.equal(result.ok, false);
    assert.match(result.message, /ни одного/i);
});

test('несколько живых без указания — отказ со списком обоих', () => {
    const result = selectInstance([CYBER, WEED]);
    assert.equal(result.ok, false);
    assert.match(result.message, /CyberCore/);
    assert.match(result.message, /tl_weedmanager1a/);
});

test('подстрока разводит инстансы и не смотрит на регистр', () => {
    assert.equal(selectInstance([CYBER, WEED], 'weed').chosen.project, 'tl_weedmanager1a');
    assert.equal(selectInstance([CYBER, WEED], 'CYBER').chosen.project, 'CyberCore');
});

test('подстрока матчится и по пути проекта, не только по имени', () => {
    assert.equal(selectInstance([CYBER, WEED], 'games/CyberCore').chosen.project, 'CyberCore');
});

test('подстрока, подходящая обоим, — отказ, а не молчаливый первый', () => {
    const result = selectInstance([CYBER, WEED], 'cocos/games');
    assert.equal(result.ok, false);
    assert.match(result.message, /несколько/i);
});

test('подстрока, не подходящая никому, называет её саму', () => {
    const result = selectInstance([CYBER, WEED], 'zzz');
    assert.equal(result.ok, false);
    assert.match(result.message, /zzz/);
});

test('канал, который не ответил, в кандидаты не попадает', async () => {
    const list = () => ['cocos-cli-aaa', 'cocos-cli-bbb', 'somethingelse'];
    const probe = async (address) => (address.endsWith('aaa') ? CYBER : null);
    const found = await discover(probe, list);
    assert.deepEqual(found.map(h => h.project), ['CyberCore']);
});

test('коды выхода различают ненайденный редактор и отказавшую операцию', () => {
    assert.equal(EXIT.OK, 0);
    assert.equal(EXIT.FAILED, 1);
    assert.equal(EXIT.USAGE, 2);
    assert.equal(EXIT.NO_EDITOR, 3);
    assert.equal(EXIT.PROTOCOL, 4);
});

test('обратные слэши в пути кандидата нормализуются при матчинге', () => {
    assert.equal(
        selectInstance([WINDOWS], 'D:/cocos/games/WindowsPath').chosen.project,
        'WindowsPath');
    assert.equal(
        selectInstance([WINDOWS], 'games\\WindowsPath').chosen.project,
        'WindowsPath');
});
