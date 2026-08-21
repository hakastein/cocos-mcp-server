import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ecsCensus } from '../src/commands/ecs.ts';
import { present } from '../src/render/present.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, 'fixtures', 'ecs-project');
const FIXTURE = path.join(PROJECT, 'assets');

const keys = report => report.result.keys.map(entry => entry.key).sort();

test('the key a system reads and nothing writes is what the report leads with', async () => {
    const report = await ecsCensus({ projectPath: PROJECT, kit: FIXTURE });
    assert.equal(report.kind, 'census');
    assert.deepEqual(report.result.readWithoutWriter.map(entry => entry.key), ['shieldTimer']);
});

test('that key is on stdout, so the answer survives a pipe', async () => {
    const output = present(await ecsCensus({ projectPath: PROJECT }));
    assert.match(output.stdout, /^shieldTimer.*read without a writer$/m);
    assert.match(output.stderr, /^ok {2}.*read without a writer: 1/m);
    assert.equal(output.failed, false);
});

test('naming a kit narrows the sweep, so the same findings come back unconfirmed', async () => {
    const output = present(await ecsCensus({ projectPath: PROJECT, kit: FIXTURE }));
    assert.match(output.stderr, /^UNVERIFIED {2}.*read without a writer: 1/m);
    assert.equal(output.failed, false);
});

test('the census is over the kit as it is on disk — a declaration file declares no key of it', async () => {
    const report = await ecsCensus({ projectPath: PROJECT, kit: FIXTURE });
    assert.deepEqual(keys(report), ['health', 'legacyFlag', 'shieldTimer', 'wavesReported']);
});

test('the root the sweep actually walked is in the report', async () => {
    const report = await ecsCensus({ projectPath: PROJECT, kit: FIXTURE });
    assert.equal(report.root, FIXTURE);
});

test('--json carries the sites and the limits the text leaves out', async () => {
    const output = present(await ecsCensus({ projectPath: PROJECT, kit: FIXTURE }), { json: true });
    const payload = JSON.parse(output.stdout);
    assert.equal(payload.root, FIXTURE);
    assert.match(payload.limits[0], /^Structural analysis only: no type checker runs/);
    assert.deepEqual(
        payload.keys.find(entry => entry.key === 'shieldTimer').readers.map(site => site.kind),
        ['query', 'read']);
});

test('with no kit named the sweep is the open project\'s own asset tree', async () => {
    const report = await ecsCensus({ projectPath: PROJECT });
    assert.equal(report.root, FIXTURE);
    assert.deepEqual(keys(report), ['health', 'legacyFlag', 'shieldTimer', 'wavesReported']);
});

test('a kit that is not there names the directory it looked in', async () => {
    const missing = path.join(FIXTURE, 'nowhere');
    await assert.rejects(
        ecsCensus({ projectPath: PROJECT, kit: missing }), error => error.message.includes(missing));
});

test('a sweep of a named kit is marked narrowed, the default sweep is not', async () => {
    assert.equal((await ecsCensus({ projectPath: PROJECT, kit: FIXTURE })).narrowed, true);
    assert.equal((await ecsCensus({ projectPath: PROJECT })).narrowed, false);
    assert.equal((await ecsCensus({ projectPath: PROJECT, kit: 'db://assets' })).narrowed, false);
});
