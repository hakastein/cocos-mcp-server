import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { EXTENSION_NAME } from '../src/extension-name.ts';

const driverDir = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(driverDir, 'package.json'), 'utf-8'));
const require = createRequire(import.meta.url);

const i18nKeys = (locale) => Object.keys(require(join(driverDir, 'i18n', `${locale}.js`)));

function ownReferences() {
    return i18nReferences(manifest).filter((ref) => !ref.startsWith('menu.'));
}

function i18nReferences(value, found = []) {
    if (typeof value === 'string' && value.startsWith('i18n:')) found.push(value.slice('i18n:'.length));
    else if (Array.isArray(value)) for (const item of value) i18nReferences(item, found);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) i18nReferences(item, found);
    return found;
}

test('the name the code opens the panel and addresses messages by is the name the editor registers', () => {
    assert.equal(manifest.name, EXTENSION_NAME);
});

test('every i18n reference the manifest makes is addressed to this extension', () => {
    const namespaces = ownReferences().map((ref) => ref.split('.')[0]);
    assert.deepEqual([...new Set(namespaces)], [EXTENSION_NAME]);
});

test('every key those references name is declared in both locales', () => {
    const keys = ownReferences().map((ref) => ref.slice(ref.indexOf('.') + 1));
    assert.ok(keys.length > 0);
    for (const locale of ['en', 'zh']) {
        const declared = i18nKeys(locale);
        for (const key of keys) assert.ok(declared.includes(key), `${locale}.js declares no ${key}`);
    }
});
