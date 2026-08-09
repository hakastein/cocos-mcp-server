import test from 'node:test';
import assert from 'node:assert/strict';

import r from '../dist/result.js';

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

test('isOk distinguishes ok from fail', () => {
    assert.equal(isOk(ok(1)), true);
    assert.equal(isOk(fail('E', 'm')), false);
});
