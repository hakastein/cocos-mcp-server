import test from 'node:test';
import assert from 'node:assert/strict';
import store from '../dist/preview-log-store.js';
import client from '../dist/preview-console-client.js';

const { PreviewLogStore, filterPreviewLogs } = store;
const { previewConsoleClient } = client;

function batch(session, entries) {
    return { session, url: 'http://localhost:7456/', entries };
}

test('ingested entries get sequential ids and are queryable', () => {
    const s = new PreviewLogStore();
    const n = s.ingest(batch('a', [
        { level: 'log', message: 'hero spawned', ts: 10 },
        { level: 'error', message: 'cannot read property of undefined', ts: 11, stack: 'at Foo' }
    ]), 100);
    assert.equal(n, 2);
    const { entries, matched } = s.query({});
    assert.equal(matched, 2);
    assert.deepEqual(entries.map(e => e.seq), [1, 2]);
    assert.equal(entries[1].stack, 'at Foo');
    assert.equal(entries[0].receivedAt, 100);
});

test('level and minLevel filters', () => {
    const s = new PreviewLogStore();
    s.ingest(batch('a', [
        { level: 'log', message: 'a' },
        { level: 'warn', message: 'b' },
        { level: 'error', message: 'c' }
    ]), 1);
    assert.deepEqual(s.query({ level: 'error' }).entries.map(e => e.message), ['c']);
    assert.deepEqual(s.query({ minLevel: 'warn' }).entries.map(e => e.message), ['b', 'c']);
});

test('afterSeq lets a caller poll without re-reading', () => {
    const s = new PreviewLogStore();
    s.ingest(batch('a', [{ level: 'log', message: 'first' }]), 1);
    s.ingest(batch('a', [{ level: 'log', message: 'second' }]), 2);
    assert.deepEqual(s.query({ afterSeq: 1 }).entries.map(e => e.message), ['second']);
});

test('since is compared against arrival time', () => {
    const s = new PreviewLogStore();
    s.ingest(batch('a', [{ level: 'log', message: 'old' }]), 100);
    s.ingest(batch('a', [{ level: 'log', message: 'new' }]), 500);
    assert.deepEqual(s.query({ sinceMs: 200 }).entries.map(e => e.message), ['new']);
});

test('sessions separate one page-load from the next', () => {
    const s = new PreviewLogStore();
    s.ingest(batch('run1', [{ level: 'log', message: 'before reload' }]), 1);
    s.ingest(batch('run2', [{ level: 'log', message: 'after reload' }]), 2);
    assert.deepEqual(s.query({ session: 'run2' }).entries.map(e => e.message), ['after reload']);
    assert.deepEqual(s.stats().sessions.map(x => x.session), ['run1', 'run2']);
});

test('the buffer drops the oldest and says so', () => {
    const s = new PreviewLogStore(3);
    for (let i = 0; i < 5; i++) s.ingest(batch('a', [{ level: 'log', message: `m${i}` }]), i);
    const stats = s.stats();
    assert.equal(stats.buffered, 3);
    assert.equal(stats.droppedOldest, 2);
    assert.equal(stats.highestSeq, 5);
    assert.deepEqual(s.query({}).entries.map(e => e.message), ['m2', 'm3', 'm4']);
});

test('the limit keeps the most recent entries', () => {
    const s = new PreviewLogStore();
    for (let i = 0; i < 10; i++) s.ingest(batch('a', [{ level: 'log', message: `m${i}` }]), i);
    const r = s.query({ limit: 3 });
    assert.deepEqual(r.entries.map(e => e.message), ['m7', 'm8', 'm9']);
    assert.equal(r.matched, 10);
    assert.equal(r.truncated, true);
});

test('oversized messages are clamped rather than buffered whole', () => {
    const s = new PreviewLogStore(10, 50);
    s.ingest(batch('a', [{ level: 'log', message: 'x'.repeat(500) }]), 1);
    const [e] = s.query({}).entries;
    assert.ok(e.message.length < 120);
    assert.match(e.message, /\+450 chars/);
});

test('malformed records are skipped, not stored as empty entries', () => {
    const s = new PreviewLogStore();
    const n = s.ingest(batch('a', [null, {}, { level: 'log', message: 'ok' }, 42]), 1);
    assert.equal(n, 1);
    assert.deepEqual(s.query({}).entries.map(e => e.message), ['ok']);
});

test('a batch with no entries array does not throw', () => {
    const s = new PreviewLogStore();
    assert.equal(s.ingest({}, 1), 0);
    assert.equal(s.ingest(null, 1), 0);
});

test('clear empties the buffer and the session list', () => {
    const s = new PreviewLogStore();
    s.ingest(batch('a', [{ level: 'log', message: 'x' }]), 1);
    s.clear();
    assert.equal(s.stats().buffered, 0);
    assert.equal(s.stats().sessions.length, 0);
});

test('filterPreviewLogs matches messages case-insensitively', () => {
    const entries = [
        { seq: 1, ts: 0, receivedAt: 0, level: 'log', message: 'Hero Spawned', session: 'a' },
        { seq: 2, ts: 0, receivedAt: 0, level: 'log', message: 'enemy spawned', session: 'a' }
    ];
    assert.equal(filterPreviewLogs(entries, { contains: 'HERO' }).length, 1);
});

test('the generated client is valid JS and posts to the configured port', () => {
    const src = previewConsoleClient({ port: 4123 });
    assert.match(src, /http:\/\/127\.0\.0\.1:4123\/preview-log/);
    assert.doesNotMatch(src, /\$\{/, 'unresolved template placeholder in the generated client');
    // Parse it. A syntax error here would only ever show up as a silently dead preview page.
    assert.doesNotThrow(() => new Function(src));
});
