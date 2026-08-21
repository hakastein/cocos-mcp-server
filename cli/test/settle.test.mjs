import test from 'node:test';
import assert from 'node:assert/strict';

import * as s from '../src/settle.ts';

const { raceTimeout, settle } = s;

test('predicate already true resolves true on the first check', async () => {
    const result = await settle(() => true, { timeoutMs: 200, intervalMs: 10 });
    assert.equal(result, true);
});

test('predicate true on the second poll resolves true', async () => {
    let calls = 0;
    const predicate = () => {
        calls += 1;
        return calls >= 2;
    };
    const result = await settle(predicate, { timeoutMs: 200, intervalMs: 10 });
    assert.equal(result, true);
    assert.equal(calls, 2);
});

test('predicate always false resolves false after the timeout, not throws', async () => {
    const result = await settle(() => false, { timeoutMs: 60, intervalMs: 10 });
    assert.equal(result, false);
});

test('raceTimeout answers the promise when it settles inside the window', async () => {
    assert.equal(await raceTimeout(Promise.resolve(36), 1000), 36);
});

test('raceTimeout answers the marker when it does not, and the promise is left running', async () => {
    let settled = false;
    const slow = new Promise(resolve => setTimeout(() => { settled = true; resolve(36); }, 40));

    assert.equal(await raceTimeout(slow, 1), 'timed out');
    assert.equal(settled, false);
    await slow;
    assert.equal(settled, true);
});

test('a rejection after the caller stopped waiting does not reach the process', async () => {
    const doomed = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('gone')), 10));
    assert.equal(await raceTimeout(doomed, 1), 'timed out');
    await new Promise(resolve => setTimeout(resolve, 30));
});
