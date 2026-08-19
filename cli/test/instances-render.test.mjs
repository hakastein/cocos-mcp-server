import test from 'node:test';
import assert from 'node:assert/strict';

import { renderInstances } from '../lib/render/instances.js';

const hello = (project, projectPath, pid) => ({
    project, projectPath, pid, version: '2.0.0', surfaceChecksum: 'abc'
});

test('строка на инстанс, с проектом, путём и pid', () => {
    const text = renderInstances([
        hello('CyberCore', 'D:/cocos/games/CyberCore', 111),
        hello('tl_weedmanager1a', 'D:/cocos/games/tl_weedmanager1a', 222)
    ]);
    assert.match(text, /CyberCore/);
    assert.match(text, /tl_weedmanager1a/);
    assert.match(text, /111/);
    assert.match(text, /222/);
    assert.match(text, /D:\/cocos\/games\/CyberCore/);
});

test('пустой список говорит словами, а не пустой таблицей', () => {
    assert.match(renderInstances([]), /ни одного/i);
});

test('одноимённые проекты различимы по пути', () => {
    const text = renderInstances([
        hello('Game', 'D:/a/Game', 1),
        hello('Game', 'D:/b/Game', 2)
    ]);
    assert.match(text, /D:\/a\/Game/);
    assert.match(text, /D:\/b\/Game/);
});
