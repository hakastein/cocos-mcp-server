import test from 'node:test';
import assert from 'node:assert/strict';

import { renderInstances } from '../lib/render/instances.js';

const hello = (project, projectPath, pid) => ({
    project, projectPath, pid, version: '2.0.0', surfaceChecksum: 'abc'
});

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

function rowByPid(text, pid) {
    const lines = stripAnsi(text).split('\n');
    const matches = lines.filter(line => new RegExp(`\\b${pid}\\b`).test(line));
    assert.equal(matches.length, 1, `ожидалась одна строка с pid ${pid}, найдено ${matches.length}`);
    return matches[0];
}

test('строка на инстанс, с проектом, путём и pid, в одной и той же строке', () => {
    const text = renderInstances([
        hello('CyberCore', 'D:/cocos/games/CyberCore', 111),
        hello('tl_weedmanager1a', 'D:/cocos/games/tl_weedmanager1a', 222)
    ]);

    const cyberRow = rowByPid(text, 111);
    assert.match(cyberRow, /CyberCore/);
    assert.match(cyberRow, /D:\/cocos\/games\/CyberCore/);

    const weedRow = rowByPid(text, 222);
    assert.match(weedRow, /tl_weedmanager1a/);
    assert.match(weedRow, /D:\/cocos\/games\/tl_weedmanager1a/);
});

test('пустой список говорит словами, а не пустой таблицей', () => {
    assert.match(renderInstances([]), /ни одного/i);
});

test('одноимённые проекты различимы по пути в своей же строке', () => {
    const text = renderInstances([
        hello('Game', 'D:/a/Game', 1),
        hello('Game', 'D:/b/Game', 2)
    ]);

    assert.match(rowByPid(text, 1), /D:\/a\/Game/);
    assert.match(rowByPid(text, 2), /D:\/b\/Game/);
});
