import test from 'node:test';
import assert from 'node:assert/strict';

import { unwrap, withClient } from '../src/commands/shared.ts';
import { MemoryDriver } from '../src/driver/memory.ts';

/** The two process streams and the exit code are the only place a command's output can be read. */
async function capture(body) {
    const out = [];
    const err = [];
    const stdout = process.stdout.write;
    const stderr = process.stderr.write;
    const exitCodeBefore = process.exitCode;
    process.stdout.write = chunk => { out.push(String(chunk)); return true; };
    process.stderr.write = chunk => { err.push(String(chunk)); return true; };
    try {
        await body();
        return { stdout: out.join(''), stderr: err.join(''), exitCode: process.exitCode };
    } finally {
        process.stdout.write = stdout;
        process.stderr.write = stderr;
        process.exitCode = exitCodeBefore;
    }
}

const connected = () => {
    const client = new MemoryDriver({ nodes: [] });
    let closed = false;
    client.close = () => { closed = true; };
    return { resolve: async () => ({ ok: true, client }), closed: () => closed };
};

const noEditor = () => async () => ({ ok: false, message: 'no editor is running' });

test('a report reaches stdout and leaves the exit code alone', async () => {
    const editor = connected();
    const seen = await capture(() => withClient(editor.resolve,
        async () => ({ kind: 'action', verdict: 'ok', summary: 'the scene was saved' })));
    assert.equal(seen.stdout, 'ok  the scene was saved\n');
    assert.equal(seen.stderr, '');
    assert.equal(seen.exitCode, undefined);
});

test('a failing verdict becomes the exit code, and the line still prints', async () => {
    const editor = connected();
    const seen = await capture(() => withClient(editor.resolve,
        async () => ({ kind: 'action', verdict: 'FAILED', summary: 'the node is gone' })));
    assert.equal(seen.stdout, 'FAILED  the node is gone\n');
    assert.equal(seen.exitCode, 1);
});

test('a thrown error is a message on stderr and a non-zero exit, with nothing on stdout', async () => {
    const editor = connected();
    const seen = await capture(() => withClient(editor.resolve, async () => {
        throw new Error('the scene script did not answer setNodeProperty');
    }));
    assert.equal(seen.stdout, '');
    assert.equal(seen.stderr, 'the scene script did not answer setNodeProperty\n');
    assert.equal(seen.exitCode, 1);
});

test('the connection is closed whether the command answered or threw', async () => {
    const answered = connected();
    await capture(() => withClient(answered.resolve,
        async () => ({ kind: 'action', verdict: 'ok', summary: 'done' })));
    assert.equal(answered.closed(), true);

    const threw = connected();
    await capture(() => withClient(threw.resolve, async () => { throw new Error('refused'); }));
    assert.equal(threw.closed(), true);
});

test('no editor to talk to is its own exit code, and the command body never runs', async () => {
    let ran = false;
    const seen = await capture(() => withClient(noEditor(), async () => {
        ran = true;
        return { kind: 'action', verdict: 'ok', summary: 'unreachable' };
    }));
    assert.equal(ran, false);
    assert.equal(seen.stderr, 'no editor is running\n');
    assert.equal(seen.stdout, '');
    assert.equal(seen.exitCode, 3);
});

test('--json reaches the presenter rather than the command body', async () => {
    const editor = connected();
    const asset = { uuid: 'u-rifle', url: 'db://assets/props/rifle.prefab' };
    const seen = await capture(() => withClient(editor.resolve,
        async () => ({ kind: 'assetList', assets: [asset], total: 1 }), { json: true }));
    assert.equal(seen.stdout, JSON.stringify([asset]) + '\n');
});

test('unwrap answers with the data the scene script sent', async () => {
    assert.deepEqual(await unwrap({ success: true, data: { name: 'Hero' } }, 'getNodeInfo'),
        { name: 'Hero' });
});

test("unwrap throws the scene script's own refusal rather than a message of its own", async () => {
    await assert.rejects(
        () => unwrap({ success: false, error: "Node 'Hero' has no 'cc.Sprite' component" }, 'getNodeInfo'),
        error => error.message === "Node 'Hero' has no 'cc.Sprite' component");
});

test('a scene answer carrying no data names the method that stayed silent', async () => {
    await assert.rejects(() => unwrap({ success: true }, 'serializedNodeValue'),
        error => error.message === 'the scene script did not answer serializedNodeValue');
});
