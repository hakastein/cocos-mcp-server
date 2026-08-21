import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectLogPath, readProjectLog, splitLogLines } from '../src/log/file.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(HERE, 'fixtures', 'log-project');

test('the log of an open project is the one under its own temp/logs', () => {
    assert.equal(projectLogPath(PROJECT), path.join(PROJECT, 'temp', 'logs', 'project.log'));
});

test('the file is read as lines, and its size and mtime come back with them', () => {
    const file = readProjectLog(PROJECT);
    assert.equal(file.path, projectLogPath(PROJECT));
    assert.equal(file.lines[0], 'Editor startup banner, written before the first timestamp');
    assert.equal(file.lines[5], '27.07.2026 09:05:12 - warn: texture not compressed');
    assert.ok(file.size > 0);
    assert.match(file.modified, /^\d{4}-\d{2}-\d{2}T/);
});

test('a project the editor never wrote a log for names the path it looked at', () => {
    const empty = path.join(HERE, 'fixtures', 'ecs-project');
    assert.throws(() => readProjectLog(empty), error => error.message.includes(projectLogPath(empty)));
});

test('the editor writes the log with CRLF, and a carriage return is not part of the line', () => {
    assert.deepEqual(splitLogLines('first\r\nsecond\r\n'), ['first', 'second', '']);
    assert.deepEqual(splitLogLines('first\nsecond'), ['first', 'second']);
});
