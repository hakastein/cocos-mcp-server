import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BuildExitCode, describeTask, exitCodeName, freshestTask, outputCollision, platformTasks,
    settingConflicts
} from '../src/build-task.ts';

const fields = (saved, overrides) => settingConflicts(saved, overrides).map(conflict => conflict.field);

// The task pair this guards: one release, one debug, same platform, different settings.
const SHOWCASE = {
    platform: 'web-mobile', name: 'SHOWCASE', debug: false, sourceMaps: false, outputName: 'web-mobile'
};
const DEBUG = {
    platform: 'web-mobile', name: 'debug', debug: true, sourceMaps: true, outputName: 'web-mobile-debug'
};

test('no overrides is never a conflict — the plain rebuild path', () => {
    assert.deepEqual(fields(DEBUG, {}), []);
});

test('an override equal to the saved value is not a conflict', () => {
    assert.deepEqual(fields(DEBUG, { debug: true }), []);
    assert.deepEqual(fields(SHOWCASE, { debug: false, sourceMaps: false }), []);
});

test('debug:false against the debug task is a conflict, and both values are named', () => {
    assert.deepEqual(settingConflicts(DEBUG, { debug: false }),
        [{ field: 'debug', saved: true, requested: false }]);
});

test('a field the task does not carry counts as a change, not as a match', () => {
    assert.deepEqual(fields({ debug: true }, { sourceMaps: false }), ['sourceMaps']);
});

test('every differing field is named, so the refusal can list them', () => {
    assert.deepEqual(
        fields(SHOWCASE, { debug: true, sourceMaps: true, outputName: 'web-mobile' }).sort(),
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
    const described = describeTask({ id: 1785322023936, options: DEBUG });
    assert.equal(described.taskId, '1785322023936');
    assert.equal(described.taskName, 'debug');
    assert.equal(described.debug, true);
    assert.equal(described.outputName, 'web-mobile-debug');
});

test('36 is the builder saying SUCCESS, and an undocumented code is named as such', () => {
    assert.equal(BuildExitCode.BUILD_SUCCESS, 36);
    assert.equal(exitCodeName(36), 'BUILD_SUCCESS');
    assert.equal(exitCodeName(34), 'BUILD_FAILED');
    assert.equal(exitCodeName(99), 'UNDOCUMENTED_99');
});

test('the rows of one platform come back oldest first, and no other platform comes with them', () => {
    const tasks = [
        { id: '3', options: { platform: 'android' } },
        { id: '2', options: { platform: 'web-mobile' } },
        { id: '1', options: { platform: 'web-mobile' } }
    ];
    assert.deepEqual(platformTasks(tasks, 'web-mobile').map(task => task.id), ['1', '2']);
});

test('a task with no options at all is nobody\'s platform', () => {
    assert.deepEqual(platformTasks([{ id: '1' }], 'web-mobile'), []);
});

test('the task a build produced is the one that appeared', () => {
    const before = new Set(['1', '2']);
    const after = [{ id: '1' }, { id: '2' }, { id: '9' }];
    assert.equal(freshestTask(after, before).id, '9');
});

test('a task rebuilt in place appeared nowhere, so the newest row is the one that ran', () => {
    assert.equal(freshestTask([{ id: '1' }, { id: '7' }], new Set(['1', '7'])).id, '7');
    assert.equal(freshestTask([], new Set()), null);
});

test('a new task writing where another one writes is a collision — artefacts, not settings', () => {
    const tasks = [{ id: '1', options: { buildPath: 'project://build', outputName: 'web-mobile' } }];
    assert.equal(
        outputCollision(tasks, { buildPath: 'project://build', outputName: 'web-mobile' }).id, '1');
    assert.equal(
        outputCollision(tasks, { buildPath: 'project://build', outputName: 'other' }), undefined);
});
