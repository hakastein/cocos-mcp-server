import test from 'node:test';
import assert from 'node:assert/strict';

import s from '../dist/settle.js';

const { settle } = s;

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
