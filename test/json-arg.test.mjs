import test from 'node:test';
import assert from 'node:assert/strict';
import ja from '../dist/json-arg.js';

const { coerceJsonArg, ANY_VALUE_TYPE } = ja;

test('a stringified object is parsed back', () => {
    const r = coerceJsonArg('{"__id__": 184}');
    assert.deepEqual(r.value, { __id__: 184 });
    assert.equal(r.coerced, true);
});

test('a stringified array is parsed back', () => {
    const r = coerceJsonArg('[1, {"__uuid__":"abc"}]');
    assert.deepEqual(r.value, [1, { __uuid__: 'abc' }]);
    assert.equal(r.coerced, true);
});

test('leading and trailing whitespace does not hide the JSON', () => {
    assert.deepEqual(coerceJsonArg('  \n {"a":1} \t ').value, { a: 1 });
});

test('native values pass through untouched', () => {
    for (const v of [{ __id__: 7 }, [1, 2], 42, true, false, null, undefined]) {
        const r = coerceJsonArg(v);
        assert.equal(r.value, v);
        assert.equal(r.coerced, false);
    }
});

test('a plain string is never reinterpreted', () => {
    for (const s of ['hello', '', 'db://assets/x.prefab', '#FF0000', 'a1b2-c3d4']) {
        const r = coerceJsonArg(s);
        assert.equal(r.value, s);
        assert.equal(r.coerced, false);
    }
});

test('stringified JSON scalars stay strings — only objects and arrays are recovered', () => {
    for (const s of ['42', 'true', 'null', '"quoted"']) {
        const r = coerceJsonArg(s);
        assert.equal(r.value, s);
        assert.equal(r.coerced, false);
    }
});

test('brace-leading text that is not valid JSON is left raw', () => {
    for (const s of ['{not json}', '{"a":', '[1,', '{{token}}']) {
        const r = coerceJsonArg(s);
        assert.equal(r.value, s);
        assert.equal(r.coerced, false);
    }
});

test('the permissive schema type admits objects and arrays', () => {
    assert.ok(Array.isArray(ANY_VALUE_TYPE));
    for (const t of ['object', 'array', 'string', 'number', 'boolean', 'null']) {
        assert.ok(ANY_VALUE_TYPE.includes(t), `missing ${t}`);
    }
});
