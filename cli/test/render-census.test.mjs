import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCensus } from '../src/ecs/census.ts';
import { readKit } from '../src/ecs/kit.ts';
import { censusSummary, censusVerdict, renderCensus } from '../src/render/census.ts';

const KIT = readKit(path.join(
    path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ecs-project', 'assets')).sources;
const DECLARING = KIT.find(source => source.path === 'entity.ts');

const census = runCensus(KIT);
const lines = renderCensus(census, []).split('\n');
const lineFor = key => lines.find(line => line.startsWith(key));

test('a key with readers and no writer is named on its own line, with the words as the tail', () => {
    assert.match(lineFor('shieldTimer'), /read without a writer$/);
});

test('the counts that produced the finding are on the same line', () => {
    assert.match(lineFor('shieldTimer'), /readers 2 {2}writers 0 {2}adders 0 {2}removers 0/);
});

test('the readers of a starved key are listed under it, so the systems it feeds are named', () => {
    const at = lines.indexOf(lineFor('shieldTimer'));
    assert.equal(lines[at + 1], '  query  systems/shield.ts:1  <module>    world.with(\'shieldTimer\')');
    assert.equal(lines[at + 2], '  read   systems/shield.ts:4  tickShield  entity.shieldTimer');
});

test('a key written and never read names its writers instead of its readers', () => {
    const at = lines.indexOf(lineFor('wavesReported'));
    assert.match(lineFor('wavesReported'), /written never read$/);
    assert.equal(lines[at + 1], '  add  assembly.ts:3  spawnHero  commands.add(entity, \'wavesReported\', true)');
});

test('a key nothing touches at all is named and carries no sites', () => {
    const at = lines.indexOf(lineFor('legacyFlag'));
    assert.match(lines[at], /never used$/);
    assert.equal(lines[at + 1].startsWith('  '), false);
});

test('a key that is read and written carries no finding word', () => {
    assert.match(lineFor('health'), /removers 0 {2}entity\.ts:3$/);
});

test('where the parser saw a key argument and could not name it is printed, not dropped', () => {
    const blind = runCensus([
        DECLARING,
        {
            path: 'copy.ts',
            text: 'function copy(key: keyof Entity) { world.addComponent(target, key, source[key]); }\n'
        }
    ]);
    const text = renderCensus(blind, []);
    assert.match(text, /^unresolved$/m);
    assert.match(text, /^ {2}copy\.ts:1 {2}copy {2}.*not a literal/m);
});

test('a property in an entity literal that no Entity declares is named', () => {
    const typo = runCensus([
        DECLARING,
        { path: 'seed.ts', text: 'function seed() { world.add({ helth: 100 }); }\n' }
    ]);
    const text = renderCensus(typo, []);
    assert.match(text, /^not a declared key$/m);
    assert.match(text, /"helth" is not a declared Entity key$/m);
});

test('a kit declaring no Entity says so instead of printing an empty table', () => {
    assert.equal(
        renderCensus(runCensus([{ path: 'lone.ts', text: 'export const x = 1;\n' }]), []),
        'no interface Entity is declared under this kit');
});

test('a file the parser threw on is named, so the count on stderr can be acted on', () => {
    const text = renderCensus({ ...census, parseErrors: [{ file: 'broken.ts', message: 'boom' }] }, []);
    assert.match(text, /^unparsed$/m);
    assert.match(text, /^ {2}broken\.ts {2}boom$/m);
});

test('a file the walk could not open is named the same way', () => {
    const text = renderCensus(runCensus(KIT, { filesSkipped: 1 }),
        [{ file: 'systems/locked.ts', message: 'EACCES: permission denied' }]);
    assert.match(text, /^unread$/m);
    assert.match(text, /^ {2}systems\/locked\.ts {2}EACCES: permission denied$/m);
});

test('a sweep that read every file of the whole asset tree is ok', () => {
    assert.equal(censusVerdict(census, false), 'ok');
});

test('a file the walk could not read leaves the census unconfirmed rather than complete', () => {
    assert.equal(censusVerdict(runCensus(KIT, { filesSkipped: 1 }), false), 'UNVERIFIED');
});

test('a file the parser threw on leaves the census unconfirmed too', () => {
    assert.equal(
        censusVerdict({ ...census, parseErrors: [{ file: 'x.ts', message: 'boom' }] }, false), 'UNVERIFIED');
});

test('a sweep narrowed by --kit is unconfirmed: the writer it did not look for is the same hole', () => {
    assert.equal(censusVerdict(census, true), 'UNVERIFIED');
});

test('the summary leads with the verdict and the directory that was swept', () => {
    assert.match(censusSummary(census, 'D:/CyberCore/assets', false),
        /^ok {2}D:\/CyberCore\/assets {2}keys 4 in 4 files/);
});

test('the summary counts each finding, so the head line answers without the listing', () => {
    assert.match(censusSummary(census, 'x', false),
        /read without a writer: 1 {2}written never read: 1 {2}never used: 1/);
});

test('a partial sweep says how much of it was missed', () => {
    assert.match(censusSummary(runCensus(KIT, { filesSkipped: 2 }), 'x', false), /files skipped: 2/);
});

test('the summary says the analysis is structural on every run, complete or not', () => {
    assert.match(censusSummary(census, 'x', false), /\nstructural analysis, no type checker/);
});

test('a sweep of the whole asset tree claims nothing about a narrower scope', () => {
    assert.equal(censusSummary(census, 'x', false).includes('narrowed'), false);
});

test('a sweep narrowed by --kit says that a writer outside it was never looked for', () => {
    assert.match(censusSummary(census, 'x', true),
        /\nthe sweep was narrowed to --kit: a writer outside it is not counted/);
});
