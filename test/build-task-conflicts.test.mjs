import test from 'node:test';
import assert from 'node:assert/strict';
import bt from '../dist/build-task.js';

const { settingConflicts, describeTask, exitCodeName } = bt;
const conflicts = (saved, overrides) => settingConflicts(saved, overrides);
const fields = (saved, overrides) => conflicts(saved, overrides).map((c) => c.field);

// The task pair this guards: one release, one debug, same platform, different settings.
const SHOWCASE = { platform: 'web-mobile', name: 'SHOWCASE', debug: false, sourceMaps: false, outputName: 'web-mobile' };
const DEBUG = { platform: 'web-mobile', name: 'debug', debug: true, sourceMaps: true, outputName: 'web-mobile-debug' };

test('no overrides is never a conflict — the plain rebuild path', () => {
    assert.deepEqual(fields(DEBUG, {}), []);
});

test('an override equal to the saved value is not a conflict', () => {
    assert.deepEqual(fields(DEBUG, { debug: true }), []);
    assert.deepEqual(fields(SHOWCASE, { debug: false, sourceMaps: false }), []);
});

test('the reported bug: debug:false against the debug task is a conflict', () => {
    const found = conflicts(DEBUG, { debug: false });
    assert.deepEqual(found, [{ field: 'debug', saved: true, requested: false }]);
});

test('a field the task does not carry counts as a change, not as a match', () => {
    assert.deepEqual(fields({ debug: true }, { sourceMaps: false }), ['sourceMaps']);
});

test('every differing field is named, so the refusal can list them', () => {
    assert.deepEqual(fields(SHOWCASE, { debug: true, sourceMaps: true, outputName: 'web-mobile' }).sort(),
        ['debug', 'sourceMaps']);
});

test('key order in a nested object is not a difference', () => {
    const saved = { packages: { 'web-mobile': { orientation: 'portrait', useWebGPU: false } } };
    const same = { packages: { 'web-mobile': { useWebGPU: false, orientation: 'portrait' } } };
    assert.deepEqual(fields(saved, same), []);
});

test('a real difference inside a nested object is caught', () => {
    const saved = { packages: { 'web-mobile': { useWebGPU: false } } };
    const changed = { packages: { 'web-mobile': { useWebGPU: true } } };
    assert.deepEqual(fields(saved, changed), ['packages']);
});

test('array order is a difference — scene lists are ordered', () => {
    assert.deepEqual(fields({ scenes: ['a', 'b'] }, { scenes: ['b', 'a'] }), ['scenes']);
    assert.deepEqual(fields({ scenes: ['a', 'b'] }, { scenes: ['a', 'b'] }), []);
});

test('false, 0 and null are compared by value, not by truthiness', () => {
    assert.deepEqual(fields({ debug: false }, { debug: false }), []);
    assert.deepEqual(fields({ x: 0 }, { x: false }), ['x']);
    assert.deepEqual(fields({ x: null }, { x: undefined }), ['x']);
});

test('a missing task carries no settings, so every override is a change', () => {
    assert.deepEqual(fields(undefined, { debug: true }), ['debug']);
});

test('describeTask surfaces what a caller needs to tell two tasks apart', () => {
    const d = describeTask({ id: 1785322023936, options: DEBUG });
    assert.equal(d.taskId, '1785322023936');
    assert.equal(d.taskName, 'debug');
    assert.equal(d.debug, true);
    assert.equal(d.outputName, 'web-mobile-debug');
});

test('36 is the builder saying SUCCESS, and an undocumented code is named as such', () => {
    assert.equal(exitCodeName(36), 'BUILD_SUCCESS');
    assert.equal(exitCodeName(34), 'BUILD_FAILED');
    assert.equal(exitCodeName(99), 'UNDOCUMENTED_99');
});
