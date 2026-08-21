import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRun, buildStatus } from '../src/commands/build.ts';
import { MemoryDriver } from '../src/driver/memory.ts';
import { present } from '../src/render/present.ts';

const SHOWCASE = {
    id: '1785322023936',
    state: 'success',
    message: 'build finished',
    options: { platform: 'web-mobile', name: 'SHOWCASE', debug: false, sourceMaps: false }
};
const DEBUG = {
    id: '1785322023937',
    state: 'success',
    options: { platform: 'web-mobile', name: 'debug', debug: true, sourceMaps: true }
};
const ANDROID = {
    id: '1785322023938', state: 'processing', progress: 0.42,
    options: { platform: 'android', name: 'android' }
};

const clone = task => JSON.parse(JSON.stringify(task));
const driverWith = builder => new MemoryDriver({ builder });
const built = driver => driver.calls.filter(call => call.name === 'builder.addTask');

test('status names the worker and the rows the Build panel holds', async () => {
    const report = await buildStatus(driverWith({ idle: true, tasks: [clone(SHOWCASE), clone(ANDROID)] }));
    assert.equal(report.kind, 'builderStatus');
    assert.equal(report.status.ready, true);
    assert.deepEqual(report.status.tasks.map(task => task.id), [SHOWCASE.id, ANDROID.id]);
    assert.equal(report.status.tasks[1].progress, 0.42);
});

test('a worker that is not up is a reading, not a failure of the command', async () => {
    const output = present(await buildStatus(driverWith({ ready: false, tasks: [] })));
    assert.match(output.stdout, /worker not ready/);
    assert.equal(output.failed, false);
});

test('the only task of a platform is rebuilt in place, keeping its id', async () => {
    const driver = driverWith({ tasks: [clone(SHOWCASE)] });
    const report = await buildRun(driver, { platform: 'web-mobile' });

    assert.equal(report.kind, 'buildRun');
    assert.equal(report.run.taskId, SHOWCASE.id);
    assert.equal(report.run.rebuiltExistingTask, true);
    assert.equal(built(driver).length, 1);
});

test('a build the exit code and the task state both call a success is ok', async () => {
    const output = present(await buildRun(driverWith({ tasks: [clone(SHOWCASE)] }), { platform: 'web-mobile' }));
    assert.match(output.stdout, /^ok {2}web-mobile {2}BUILD_SUCCESS\(36\)/m);
    assert.equal(output.failed, false);
});

test('an exit code that is not BUILD_SUCCESS fails the command', async () => {
    const driver = driverWith({ tasks: [clone(SHOWCASE)], exitCode: 34, finalState: 'failure' });
    const output = present(await buildRun(driver, { platform: 'web-mobile' }));
    assert.match(output.stdout, /^FAILED {2}web-mobile {2}BUILD_FAILED\(34\)/m);
    assert.equal(output.failed, true);
});

test('a platform with two tasks refuses to pick, and builds nothing', async () => {
    const driver = driverWith({ tasks: [clone(SHOWCASE), clone(DEBUG)] });
    const output = present(await buildRun(driver, { platform: 'web-mobile' }));

    assert.match(output.stdout, /^FAILED {2}web-mobile has 2 build tasks/m);
    assert.match(output.stderr, /1785322023936/);
    assert.match(output.stderr, /1785322023937/);
    assert.equal(built(driver).length, 0);
});

test('--task names which of them to rebuild', async () => {
    const driver = driverWith({ tasks: [clone(SHOWCASE), clone(DEBUG)] });
    const report = await buildRun(driver, { platform: 'web-mobile', taskId: DEBUG.id });
    assert.equal(report.run.taskId, DEBUG.id);
});

test('a task id belonging to another platform says so rather than building it', async () => {
    const driver = driverWith({ tasks: [clone(SHOWCASE), clone(ANDROID)] });
    const output = present(await buildRun(driver, { platform: 'web-mobile', taskId: ANDROID.id }));

    assert.match(output.stdout, /FAILED/);
    assert.match(output.stderr, /android task, not web-mobile/);
    assert.equal(built(driver).length, 0);
});

test('an override that disagrees with the saved task refuses and names both values', async () => {
    const driver = driverWith({ tasks: [clone(DEBUG)] });
    const output = present(await buildRun(driver, { platform: 'web-mobile', debug: false }));

    assert.match(output.stdout, /^FAILED {2}building web-mobile would overwrite/m);
    assert.match(output.stderr, /debug=true/);
    assert.match(output.stderr, /debug=false/);
    assert.equal(built(driver).length, 0);
});

test('an override equal to the saved value is no conflict at all', async () => {
    const driver = driverWith({ tasks: [clone(DEBUG)] });
    const report = await buildRun(driver, { platform: 'web-mobile', debug: true });
    assert.deepEqual(report.run.modifiedTaskSettings, []);
    assert.equal(built(driver).length, 1);
});

test('--allow-task-edit lets the overwrite through, and the report names what it wrote', async () => {
    const driver = driverWith({ tasks: [clone(DEBUG)] });
    const report = await buildRun(driver, { platform: 'web-mobile', debug: false, allowTaskEdit: true });

    assert.deepEqual(report.run.modifiedTaskSettings, ['debug']);
    assert.match(present(report).stderr, /wrote onto the task: debug/);
});

test('the edit really lands on the task — the next read gets the new value back', async () => {
    const driver = driverWith({ tasks: [clone(DEBUG)] });
    await buildRun(driver, { platform: 'web-mobile', debug: false, allowTaskEdit: true });

    const task = await driver.editor.builder.queryTask(DEBUG.id);
    assert.equal(task.options.debug, false);
});

test('--new-task adds a row instead of touching the ones that are there', async () => {
    const driver = driverWith({ tasks: [clone(SHOWCASE), clone(DEBUG)] });
    const report = await buildRun(driver, { platform: 'web-mobile', newTask: true, debug: true });

    assert.equal(report.run.rebuiltExistingTask, false);
    const info = await driver.editor.builder.queryTasksInfo();
    assert.deepEqual(info.list.map(task => task.options.name),
        ['SHOWCASE', 'debug', undefined]);
    assert.equal(info.list[0].options.debug, false);
    assert.equal(info.list[2].options.debug, true);
});

test('--new-task and --task contradict each other and neither wins', async () => {
    const driver = driverWith({ tasks: [clone(SHOWCASE)] });
    const output = present(await buildRun(driver, { platform: 'web-mobile', newTask: true, taskId: SHOWCASE.id }));

    assert.match(output.stdout, /FAILED/);
    assert.equal(built(driver).length, 0);
});

test('a platform with no task of its own builds off the settings the project saved', async () => {
    const driver = driverWith({
        tasks: [clone(SHOWCASE)],
        profile: { 'android.builder.common': { buildPath: 'project://build', outputName: 'droid' } }
    });
    const report = await buildRun(driver, { platform: 'android' });

    assert.equal(report.run.rebuiltExistingTask, false);
    assert.equal(report.run.outputName, 'droid');
});

test('a wait that runs out answers TIMEOUT without asking the driver anything more', async () => {
    const driver = driverWith({ tasks: [clone(SHOWCASE)], buildTakesMs: 50 });
    const output = present(await buildRun(driver, { platform: 'web-mobile', timeoutMs: 1 }));

    assert.match(output.stdout, /^TIMEOUT {2}web-mobile {2}no exit code {2}state=unknown/m);
    assert.match(output.stderr, /still running in the editor/);
    assert.equal(output.failed, true);
    assert.equal(driver.calls.filter(call => call.name === 'builder.queryTask').length, 0);
    assert.match(output.stdout, /^task 1785322023936 "SHOWCASE"/m);
});

test('a worker that is not ready is refused before anything is written', async () => {
    const driver = driverWith({ ready: false, tasks: [clone(SHOWCASE)] });
    const output = present(await buildRun(driver, { platform: 'web-mobile' }));

    assert.match(output.stdout, /^FAILED {2}the build worker is not ready/m);
    assert.equal(built(driver).length, 0);
});

test('a task list the editor refuses to answer stops the build — an empty panel it is not', async () => {
    const driver = new MemoryDriver({
        builder: { tasks: [clone(SHOWCASE)] },
        refuses: { queryTasksInfo: 'the builder is restarting' }
    });

    await assert.rejects(buildRun(driver, { platform: 'web-mobile' }), /the builder is restarting/);
    assert.equal(built(driver).length, 0);
});

test('a new task landing on an existing row output names the task whose artefacts it replaces', async () => {
    const driver = driverWith({
        tasks: [clone(SHOWCASE)],
        profile: {
            'web-mobile.builder.common': { buildPath: 'project://build', outputName: 'web-mobile' }
        }
    });
    const report = await buildRun(driver, { platform: 'web-mobile', newTask: true });
    assert.equal(report.run.overwrites, null);

    const onto = driverWith({
        tasks: [{ ...clone(SHOWCASE), options: { ...SHOWCASE.options, buildPath: 'project://build', outputName: 'shared' } }],
        profile: { 'web-mobile.builder.common': { buildPath: 'project://build', outputName: 'shared' } }
    });
    assert.equal((await buildRun(onto, { platform: 'web-mobile', newTask: true })).run.overwrites,
        SHOWCASE.id);
});
