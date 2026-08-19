import test from 'node:test';
import assert from 'node:assert/strict';

import r from '../lib/result.js';

const { ok, fail, isOk } = r;

test('ok carries data and message at the top level', () => {
    const result = ok({ uuid: 'abc' }, 'saved');
    assert.equal(result.success, true);
    assert.deepEqual(result.data, { uuid: 'abc' });
    assert.equal(result.message, 'saved');
});

test('ok without a message omits the message key', () => {
    const result = ok({ uuid: 'abc' });
    assert.equal(result.success, true);
    assert.deepEqual(result.data, { uuid: 'abc' });
    assert.equal('message' in result, false);
});

test('fail carries code, message and hint under error, and success:false', () => {
    const result = fail('NOT_FOUND', 'node missing', 'check the uuid');
    assert.equal(result.success, false);
    assert.deepEqual(result.error, { code: 'NOT_FOUND', message: 'node missing', hint: 'check the uuid' });
});

test('fail without a hint omits the hint key', () => {
    const result = fail('NOT_FOUND', 'node missing');
    assert.equal(result.success, false);
    assert.deepEqual(result.error, { code: 'NOT_FOUND', message: 'node missing' });
});

test('fail carries a payload beside the error when one is given', () => {
    const result = fail('legacy', 'two steps failed', undefined, { failed: 2, results: [1, 2] });
    assert.equal(result.success, false);
    assert.deepEqual(result.error, { code: 'legacy', message: 'two steps failed' });
    assert.deepEqual(result.data, { failed: 2, results: [1, 2] });
});

test('fail without a payload omits the data key', () => {
    assert.equal('data' in fail('NOT_FOUND', 'node missing'), false);
    assert.equal('data' in fail('NOT_FOUND', 'node missing', 'check the uuid'), false);
});

test('isOk distinguishes ok from fail', () => {
    assert.equal(isOk(ok(1)), true);
    assert.equal(isOk(fail('E', 'm')), false);
});
