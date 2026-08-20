import test from 'node:test';
import assert from 'node:assert/strict';

import { withUndoBracket } from '../src/undo-bracket.ts';
import { MemoryDriver } from '../src/driver/memory.ts';

const scene = (refuses) => new MemoryDriver({ nodes: [{ name: 'Hero' }], ...(refuses ? { refuses } : {}) });
const names = (driver) => driver.calls.map(call => call.name);

test('a write that lands is bracketed begin-write-end and carries no note', async () => {
    const driver = scene();
    const order = [];
    const bracketed = await withUndoBracket(driver, driver.uuidOf('Hero'), async () => {
        order.push('write');
        return 'written';
    });
    assert.equal(bracketed.result, 'written');
    assert.equal(bracketed.undoNote, null);
    assert.deepEqual(names(driver), ['scene.beginRecording', 'scene.endRecording']);
    assert.deepEqual(order, ['write']);
});

test('a write that throws cancels the step instead of leaving it open, and rethrows', async () => {
    const driver = scene();
    await assert.rejects(
        () => withUndoBracket(driver, driver.uuidOf('Hero'), async () => { throw new Error('refused'); }),
        /refused/);
    assert.deepEqual(names(driver), ['scene.beginRecording', 'scene.cancelRecording']);
});

test('the editor refusing to record still runs the write, and the note says Ctrl+Z will not take it back', async () => {
    const driver = scene({ beginRecording: 'no scene is open' });
    const bracketed = await withUndoBracket(driver, driver.uuidOf('Hero'), async () => 'written');
    assert.equal(bracketed.result, 'written');
    assert.match(bracketed.undoNote, /no scene is open/);
    assert.match(bracketed.undoNote, /Ctrl\+Z does not take/);
});

test('a step that never opened is not cancelled either', async () => {
    const driver = scene({ beginRecording: 'no scene is open' });
    await assert.rejects(
        () => withUndoBracket(driver, driver.uuidOf('Hero'), async () => { throw new Error('refused'); }));
    assert.deepEqual(names(driver), ['scene.beginRecording']);
});

test('a step the editor left open is reported as one Ctrl+Z may take back more than this write', async () => {
    const driver = scene({ endRecording: 'the undo stack is busy' });
    const bracketed = await withUndoBracket(driver, driver.uuidOf('Hero'), async () => 'written');
    assert.equal(bracketed.result, 'written');
    assert.match(bracketed.undoNote, /the undo stack is busy/);
    assert.match(bracketed.undoNote, /take back more than this write/);
});
