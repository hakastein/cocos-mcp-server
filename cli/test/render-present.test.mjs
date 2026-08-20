import test from 'node:test';
import assert from 'node:assert/strict';

import { present } from '../src/render/present.ts';
import { verdictFailed } from '../src/render/verdict.ts';

// The closed set exists for this table: the exit code is decided once here instead of being
// reassembled in every command body.
test('exactly ok and UNVERIFIED exit zero', () => {
    assert.equal(verdictFailed('ok'), false);
    assert.equal(verdictFailed('UNVERIFIED'), false);
    assert.equal(verdictFailed('UNPERSISTED'), true);
    assert.equal(verdictFailed('FAILED'), true);
    assert.equal(verdictFailed('TIMEOUT'), true);
});

test('an outcome starts with its verdict and leaves the tail free text', () => {
    const output = present({ kind: 'action', verdict: 'FAILED', summary: 'Guard not moved' });
    assert.equal(output.stdout, 'FAILED  Guard not moved');
    assert.equal(output.failed, true);
});

test('an empty note does not become an empty line on stderr', () => {
    assert.equal(present({ kind: 'action', verdict: 'ok', summary: 'scene saved' }).stderr, undefined);
});

const writeReport = (over = {}) => ({
    kind: 'propertyWrite',
    component: 'cc.Sprite',
    property: 'color',
    value: '#ffffff',
    report: { written: true, verified: true, persisted: true, channel: 'editor', ...over }
});

// The verdict is computed from the report's data: a command never passes it and so cannot drift
// from what gets printed.
test('a write a save will drop gets UNPERSISTED and a one', () => {
    const output = present(writeReport({ persisted: false }));
    assert.equal(output.stdout.split('  ')[0], 'UNPERSISTED');
    assert.equal(output.failed, true);
});

test('on the live channel persisted=false stays ok', () => {
    const output = present(writeReport({ persisted: false, channel: 'live' }));
    assert.equal(output.stdout.split('  ')[0], 'ok');
    assert.equal(output.failed, false);
});

const settle = (over = {}) => ({
    kind: 'assetSettle',
    settle: {
        action: 'refreshed', target: 'db://assets/f', elapsedMs: 60000, settled: true,
        assets: { added: [], removed: [], changed: [] }, classes: { added: [], removed: [] }, ...over
    },
    timeoutMs: 60000
});

test('a database that did not go quiet within the timeout is TIMEOUT with a one', () => {
    const output = present(settle({ settled: false }));
    assert.equal(output.stdout.split('  ')[0], 'TIMEOUT');
    assert.equal(output.failed, true);
    assert.match(output.stderr, /60s/);
});

test('the command note arrives alongside the settle note rather than instead of it', () => {
    const output = present({ ...settle({ classes: null }), note: 'db:// paths inside a .meta do not move' });
    assert.match(output.stderr, /delta is unknown/);
    assert.match(output.stderr, /\.meta do not move/);
});

const ASSET = { name: 'rifle', type: 'cc.Prefab', uuid: 'u-1', url: 'db://assets/rifle.prefab' };

test('--json prints the structural form instead of text', () => {
    const output = present({ kind: 'assetInfo', asset: ASSET }, { json: true });
    assert.deepEqual(JSON.parse(output.stdout), ASSET);
});

// `--field` exists to be substituted into a shell variable, and a JSON wrapper breaks that.
test('--field overrides --json and answers a bare value', () => {
    const output = present({ kind: 'assetInfo', asset: ASSET, field: 'uuid' }, { json: true });
    assert.equal(output.stdout, 'u-1');
});

test('--json on a report with no structural form answers the same text, not emptiness', () => {
    const output = present({ kind: 'action', verdict: 'ok', summary: 'removed Canvas/Bg' }, { json: true });
    assert.equal(output.stdout, 'ok  removed Canvas/Bg');
});

const missing = (entries) => ({ kind: 'sceneMissing', missing: { entries } });

test('a dead component in the scene is an outcome rather than a calm report', () => {
    const found = present(missing([{ nodePath: 'a', nodeUuid: 'u', componentUuid: 'c', cid: null }]));
    assert.equal(found.failed, true);
    assert.match(found.stderr, /^FAILED/);
    assert.equal(present(missing([])).failed, false);
});

const reading = (over = {}) => ({
    name: 'target', type: 'cc.Node', kind: 'nodeRef', value: 'u-hero', label: null,
    differsFromDefault: false, hiddenInInspector: false, ...over
});

const address = {
    nodePath: 'Canvas/Bg', nodeUuid: 'u-bg',
    choice: { index: 0, className: 'Npc', cid: null, enabled: true, sameClassCount: 1 }
};

test('a reference prints as the node name rather than a bare uuid when the index knows it', () => {
    const output = present({
        kind: 'componentProperty',
        address,
        reading: reading(),
        references: new Map([['u-hero', { kind: 'node', path: 'Characters/hero' }]])
    });
    assert.match(output.stdout, /Characters\/hero {2}u-hero/);
    assert.match(output.stderr, /Npc\.target {2}cc\.Node/);
});

test('a property that drifted from the default is named in the note', () => {
    const output = present({
        kind: 'componentProperty',
        address,
        reading: reading({ differsFromDefault: true }),
        references: new Map()
    });
    assert.match(output.stderr, /differs from the default/);
});

test('the hidden properties and the read count reach the note', () => {
    const output = present({
        kind: 'componentProperties',
        address,
        readings: [reading(), reading({ name: 'speed', type: 'Number', kind: 'scalar', value: 3 })],
        hidden: ['_id'],
        references: new Map()
    });
    assert.match(output.stderr, /properties: 2/);
    assert.match(output.stderr, /hidden: 1/);
});
