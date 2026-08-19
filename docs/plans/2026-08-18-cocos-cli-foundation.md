# Cocos CLI: фундамент и ядро — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить MCP-мост на CLI, который находит открытые редакторы Cocos по именованным
каналам и водит их через драйвер из 87 нативных примитивов; довести до рабочего состояния
группы `scene`, `node`, `component`.

**Architecture:** Три пакета npm workspaces. `driver/` — расширение редактора, выставляет
`editor.*` (58 методов поверх `Editor.Message`) и `scene.*` (29 методов поверх scene-скрипта) по
JSON-RPC через именованный канал, логики не содержит. `cli/` — вся логика: разбор команд,
оркестрация многошаговых операций, undo-скобки, проверка записей, рендер вывода. `shared/` —
типы и чистая логика, нужная обеим сторонам.

**Tech Stack:** TypeScript, `json-rpc-2.0`, `split2`, `commander`, `archy`, `cli-table3`,
`picocolors`, `zod` 3.25, `p-queue` ^6, `tsup`, `node:test`.

**Спека:** [docs/specs/2026-08-18-cocos-cli-design.md](../specs/2026-08-18-cocos-cli-design.md)

**Второй план (не входит сюда):** группы `prefab`, `asset`, `build`, `project`, `log`, `ecs`,
`socket`; режим `--stdin`; completion. После этого плана они недоступны — так следует из
решения сносить MCP большим взрывом (спека §12).

## Global Constraints

- Редактор работает на **Node v20.15.1**. `require()` ESM-модуля там не работает. Пакет
  `driver/` берёт только CommonJS-зависимости; `p-queue` остаётся на `^6`.
- Пакет `cli/` собирается бандлером, ESM-зависимости в нём допустимы.
- `driver/` бандлится в самодостаточные файлы без рантайм-зависимости от `node_modules`:
  при npm workspaces зависимости всплывают в корень, а папка расширения копируется в
  `{project}/extensions/` отдельно.
- `zod` остаётся на **3.25**. Апгрейд до v4 запрещён: `require` стоит 67 мс против 7 мс.
- `@oclif/core`, `arktype`, `@sinclair/typebox`, `trpc-cli` отклонены (спека §2).
- TypeScript: `strict: true`, `target: ES2017`, `module: CommonJS` для `driver/` и `shared/`.
- Тесты пишутся только на чистые функции. Тесты на проводку, состояние редактора и UI не
  пишутся. Случай попадает в набор только если мутация продакшн-кода его роняет.
- Комментарии — исключение. То, что видно из кода и имён, не пересказывается.
- Байты экономятся ровно на одной границе: stdout CLI. На линии CLI↔драйвер размер сообщений
  не критерий.

---

## Структура файлов

```
package.json                    корень workspaces, скрипты build/test
shared/
  package.json  tsconfig.json
  src/protocol.ts               имена 87 методов, форма hello, типы запроса
  src/scene-contract.ts         переезд из source/scene-contract.ts
  src/pipe-name.ts              путь проекта -> путь канала (Task 3)
  src/node-path.ts              нужен scene-скрипту и CLI (перенесён в правках Task 2)
  src/serialized-diff.ts        то же
  src/reference-projection.ts   то же
driver/
  package.json                  манифест расширения Cocos: main, panels, contributions
  tsconfig.json  tsup.config.ts
  src/main.ts                   load/unload, композиция
  src/pipe-name.ts              чистый: путь проекта -> путь канала
  src/method-table.ts           чистый: имя -> функция, отвергает всё вне списка
  src/pipe-server.ts            net.createServer + json-rpc-2.0 + split2 + p-queue
  src/editor-api.ts             переезд
  src/scene-script-client.ts    переезд
  src/scene/*.ts                переезд
  src/panels/default/index.ts   урезанная панель
  test/pipe-name.test.mjs
  test/method-table.test.mjs
cli/
  package.json                  bin: { "cocos": "./dist/main.js" }
  tsconfig.json  tsup.config.ts
  src/main.ts                   точка входа, коды выхода
  src/discovery.ts              перечисление каналов, hello, выбор инстанса
  src/driver-client.ts          RPC-клиент + фасады editor/scene
  src/exit.ts                   чистый: коды выхода и их смысл
  src/render/tree.ts            чистый: узлы -> archy
  src/render/report.ts          чистый: WriteReport -> строка
  src/commands/scene.ts
  src/commands/node.ts
  src/commands/component.ts
  src/property/*                переезд
  src/undo-bracket.ts           переезд
  test/*.test.mjs               переезд существующих тестов чистых модулей
```

---

## Task 1: Каркас workspaces и общие типы

**Files:**
- Create: `package.json` (переписать корневой), `shared/package.json`, `shared/tsconfig.json`,
  `shared/src/protocol.ts`, `driver/package.json`, `driver/tsconfig.json`, `cli/package.json`,
  `cli/tsconfig.json`
- Test: `shared/test/protocol.test.mjs`

**Interfaces:**
- Consumes: ничего
- Produces: `EDITOR_METHODS: readonly string[]` (58), `SCENE_METHODS: readonly string[]` (29),
  `ALL_METHODS: readonly string[]` (87), `isKnownMethod(name: string): boolean`,
  `type Hello = { project: string; projectPath: string; pid: number; version: string; surfaceChecksum: string }`

- [ ] **Step 1: Написать падающий тест**

`shared/test/protocol.test.mjs`:

```javascript
/**
 * Список методов — это и есть граница драйвера: всё, чего в нём нет, наружу не проходит.
 * Проверяется размер обоих пространств, отсутствие дублей и то, что резолвер имени
 * отвергает чужое.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EDITOR_METHODS, SCENE_METHODS, ALL_METHODS, isKnownMethod } from '../dist/protocol.js';

test('пространство editor держит ровно 58 методов, без дублей', () => {
    assert.equal(EDITOR_METHODS.length, 58);
    assert.equal(new Set(EDITOR_METHODS).size, 58);
});

test('пространство scene держит ровно 29 методов, без дублей', () => {
    assert.equal(SCENE_METHODS.length, 29);
    assert.equal(new Set(SCENE_METHODS).size, 29);
});

test('каждое имя editor несёт группу через точку, имена scene — плоские', () => {
    for (const name of EDITOR_METHODS) {
        assert.match(name, /^(scene|assetDb|builder|project)\.[a-zA-Z]+$/, name);
    }
    for (const name of SCENE_METHODS) assert.doesNotMatch(name, /\./, name);
});

test('общий список — объединение обоих с префиксами пространств', () => {
    assert.equal(ALL_METHODS.length, 87);
    assert.ok(ALL_METHODS.includes('editor.scene.createNode'));
    assert.ok(ALL_METHODS.includes('scene.dumpSceneNodes'));
});

test('имя вне списка не признаётся, включая правдоподобное', () => {
    assert.equal(isKnownMethod('editor.scene.createNode'), true);
    assert.equal(isKnownMethod('scene.dumpSceneNodes'), true);
    assert.equal(isKnownMethod('editor.scene.deleteEverything'), false);
    assert.equal(isKnownMethod('scene.evalInScene '), false);
    assert.equal(isKnownMethod('__proto__'), false);
});
```

- [ ] **Step 2: Прогнать тест, убедиться что падает**

Run: `npm test --workspace shared`
Expected: FAIL — `Cannot find module '../dist/protocol.js'`

- [ ] **Step 3: Написать корневой package.json**

```json
{
  "name": "cocos-cli-monorepo",
  "private": true,
  "workspaces": ["shared", "driver", "cli"],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "npm run build && npm run test:only --workspaces --if-present"
  },
  "devDependencies": {
    "@types/node": "^18.17.1",
    "typescript": "^5.8.2"
  }
}
```

- [ ] **Step 4: Написать shared/package.json и shared/tsconfig.json**

`shared/package.json`:

```json
{
  "name": "@cocos-cli/shared",
  "version": "1.0.0",
  "private": true,
  "main": "./dist/protocol.js",
  "types": "./dist/protocol.d.ts",
  "scripts": {
    "build": "tsc",
    "test:only": "node --test \"test/**/*.test.mjs\""
  }
}
```

`shared/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "module": "CommonJS",
    "moduleResolution": "node",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 5: Написать shared/src/protocol.ts**

```typescript
export const EDITOR_METHODS = [
    'scene.querySceneReady', 'scene.queryDirty', 'scene.queryNodeTree', 'scene.queryNode',
    'scene.createNode', 'scene.removeNode', 'scene.duplicateNode', 'scene.setParent',
    'scene.setProperty', 'scene.resetProperty', 'scene.resetNode', 'scene.resetComponent',
    'scene.moveArrayElement', 'scene.removeArrayElement', 'scene.queryClasses',
    'scene.queryComponents', 'scene.queryNodesByAssetUuid', 'scene.createComponent',
    'scene.removeComponent', 'scene.executeComponentMethod', 'scene.copyNode', 'scene.cutNode',
    'scene.pasteNode', 'scene.openScene', 'scene.queryCurrentScene', 'scene.softReload',
    'scene.saveScene', 'scene.closeScene', 'scene.restorePrefab', 'scene.executeSceneScript',
    'scene.beginRecording', 'scene.endRecording', 'scene.cancelRecording',
    'assetDb.queryAssetInfo', 'assetDb.queryUuid', 'assetDb.queryPath', 'assetDb.queryUrl',
    'assetDb.queryAssetMeta', 'assetDb.queryAssets', 'assetDb.queryReady', 'assetDb.createAsset',
    'assetDb.importAsset', 'assetDb.copyAsset', 'assetDb.moveAsset', 'assetDb.deleteAsset',
    'assetDb.saveAsset', 'assetDb.saveAssetMeta', 'assetDb.reimportAsset', 'assetDb.refreshAsset',
    'assetDb.generateAvailableUrl',
    'builder.queryWorkerReady', 'builder.openPanel', 'builder.addTask', 'builder.queryTasksInfo',
    'builder.queryTask', 'builder.checkAndCompleteOptions',
    'project.queryConfig', 'project.profile'
] as const;

export const SCENE_METHODS = [
    'declaredComponentProperty', 'addComponentToNode', 'getNodeInfo', 'getCurrentSceneInfo',
    'setNodeProperty', 'evalInScene', 'setParticleGradient', 'setParticleCurve',
    'createPrefabFromNode2', 'previewPlay', 'addSkeletalSocket', 'listSkeletalSockets',
    'removeSkeletalSocket', 'applyPrefabToAsset', 'revertPrefabInstance', 'listPrefabOverrides',
    'removePrefabOverride', 'serializedComponentValue', 'prefabInstancePropertyOutcome',
    'nodePrefabLinkage', 'resolveComponentReference', 'applyComponentReference',
    'componentReferenceOutcome', 'pruneComponentReferenceOverrides', 'resolveNodePaths',
    'dumpSceneNodes', 'dumpMissingScripts', 'findComponentOwners', 'sceneDirtyAgainstDisk'
] as const;

export type EditorMethod = typeof EDITOR_METHODS[number];
export type SceneMethod = typeof SCENE_METHODS[number];

export const ALL_METHODS: readonly string[] = [
    ...EDITOR_METHODS.map(name => `editor.${name}`),
    ...SCENE_METHODS.map(name => `scene.${name}`)
];

const KNOWN = new Set(ALL_METHODS);

export function isKnownMethod(name: string): boolean {
    return KNOWN.has(name);
}

export interface Hello {
    project: string;
    projectPath: string;
    pid: number;
    version: string;
    surfaceChecksum: string;
}
```

- [ ] **Step 6: Написать driver/package.json, driver/tsconfig.json, cli/package.json, cli/tsconfig.json как заготовки**

`driver/package.json` — манифест расширения переносится из нынешнего корневого целиком,
за вычетом `start-server` и `stop-server` из `contributions.messages` и всего блока
зависимостей MCP:

```json
{
  "package_version": 2,
  "name": "cocos-mcp-server",
  "version": "1.0.0",
  "editor": ">=3.8.0",
  "main": "./dist/main.js",
  "scripts": {
    "build": "tsc && tsup",
    "test:only": "node --test \"test/**/*.test.mjs\""
  },
  "dependencies": {
    "json-rpc-2.0": "^1.7.1",
    "split2": "^4.2.0",
    "p-queue": "^6.6.2",
    "fs-extra": "^11.3.0",
    "vue": "^3.1.4"
  },
  "devDependencies": {
    "@cocos/creator-types": "^3.8.6",
    "@types/fs-extra": "^9.0.5",
    "tsup": "^8.0.0"
  }
}
```

`cli/package.json`:

```json
{
  "name": "@cocos-cli/cli",
  "version": "1.0.0",
  "bin": { "cocos": "./bin/cocos.js" },
  "scripts": {
    "build": "tsc && tsup",
    "test:only": "node --test \"test/**/*.test.mjs\""
  },
  "dependencies": {
    "commander": "^15.0.0",
    "json-rpc-2.0": "^1.7.1",
    "split2": "^4.2.0",
    "archy": "^1.0.0",
    "cli-table3": "^0.6.5",
    "picocolors": "^1.1.1",
    "zod": "^3.25.76"
  },
  "devDependencies": { "tsup": "^8.0.0" }
}
```

`driver/tsconfig.json` и `cli/tsconfig.json` копируют `shared/tsconfig.json` с одним отличием:
`"outDir": "./lib"`. У драйвера в `types` добавляется `"@cocos/creator-types/editor"`.

**Две сборки на пакет, и это намеренно.** `tsc` кладёт в `lib/` по файлу на модуль — оттуда
тесты импортируют отдельные модули (`../lib/method-table.js`). `tsup` бандлит в один файл:
драйвер в `dist/` (туда смотрит `main` манифеста Cocos), CLI в `bin/cocos.js` (туда смотрит
`bin`). Одной сборкой не обойтись: бандл не даёт путей к отдельным модулям, а `tsc` не даёт
самодостаточного файла без `node_modules`. У `shared/` бандла нет — его потребляют исходники,
и `tsc` в `dist/` там достаточно.

- [ ] **Step 7: Прогнать тест, убедиться что проходит**

Run: `npm install && npm run build --workspace shared && npm test --workspace shared`
Expected: PASS, 5 тестов

- [ ] **Step 8: Коммит**

```bash
git add package.json shared/ driver/package.json driver/tsconfig.json cli/package.json cli/tsconfig.json
git commit -m "каркас workspaces: shared держит список 87 методов как границу драйвера"
```

---

## Task 2: Переезд расширения в driver/, снос MCP и preview

**Files:**
- Move: `source/editor-api.ts`, `source/scene-script-client.ts`, `source/scene/*`,
  `source/panels/*`, `source/settings.ts`, `source/types/index.ts` → `driver/src/`
- Move: `source/scene-contract.ts` → `shared/src/scene-contract.ts`
- Delete: `source/server.ts`, `source/preview-console-client.ts`, `source/preview-log-store.ts`,
  `test/preview-log-store.test.mjs`
- Create: `driver/tsup.config.ts`
- Modify: `driver/src/panels/default/index.ts`
- Delete: `source/main.ts` (точку входа пишет Task 5)

**Interfaces:**
- Consumes: `shared/src/protocol.ts` из Task 1
- Produces: `driver/src/editor-api.ts` экспортирует `EditorApi` с группами `scene`, `assetDb`,
  `builder`, `project`; `driver/src/scene-script-client.ts` экспортирует
  `SceneScriptClient` с методом `call(method, ...args)`

- [ ] **Step 1: Перенести файлы**

```bash
mkdir -p driver/src/scene driver/src/panels/default driver/src/types
git mv source/editor-api.ts driver/src/editor-api.ts
git mv source/scene-script-client.ts driver/src/scene-script-client.ts
git mv source/scene driver/src/scene
git mv source/panels/default driver/src/panels/default
git mv source/settings.ts driver/src/settings.ts
git rm source/main.ts
git mv source/types/index.ts driver/src/types/index.ts
git mv source/scene-contract.ts shared/src/scene-contract.ts
git rm source/server.ts source/preview-console-client.ts source/preview-log-store.ts
git rm test/preview-log-store.test.mjs
```

- [ ] **Step 2: Поправить импорты контракта сцены**

В `driver/src/scene-script-client.ts` и во всех файлах `driver/src/scene/` заменить
`from '../scene-contract'` и `from './scene-contract'` на `from '@cocos-cli/shared/dist/scene-contract'`.

- [ ] **Step 3: Урезать настройки**

`driver/src/types/index.ts` целиком:

```typescript
export interface DriverSettings {
    enableDebugLog: boolean;
}

export interface DriverStatus {
    listening: boolean;
    pipePath: string;
    project: string;
}
```

`driver/src/settings.ts` — заменить `DEFAULT_SETTINGS` на `{ enableDebugLog: false }`, убрать
`DEFAULT_PORT`, остальное оставить как есть.

- [ ] **Step 4: Урезать панель**

В `driver/src/panels/default/index.ts` заменить тело `setup()` целиком на:

```typescript
            setup() {
                const listening = ref(false);
                const pipePath = ref('');
                const project = ref('');
                const settings = ref<DriverSettings>({ enableDebugLog: false });
                const settingsChanged = ref(false);

                const statusClass = computed(() => ({
                    'status-running': listening.value,
                    'status-stopped': !listening.value
                }));

                const saveSettings = async () => {
                    try {
                        await Editor.Message.request(
                            'cocos-mcp-server', 'update-settings', { ...settings.value });
                        settingsChanged.value = false;
                    } catch (error) {
                        console.error('[cocos-cli Panel] Failed to save settings:', error);
                    }
                };

                const copyPipePath = async () => {
                    try {
                        await navigator.clipboard.writeText(pipePath.value);
                    } catch (error) {
                        console.error('[cocos-cli Panel] Failed to copy pipe path:', error);
                    }
                };

                watch(settings, () => { settingsChanged.value = true; }, { deep: true });

                const poll = async () => {
                    try {
                        const status = await Editor.Message.request(
                            'cocos-mcp-server', 'get-driver-status');
                        if (!status) return;
                        listening.value = status.listening;
                        pipePath.value = status.pipePath;
                        project.value = status.project;
                        if (status.settings) settings.value = { ...status.settings };
                    } catch (error) {
                        console.error('[cocos-cli Panel] Failed to poll driver status:', error);
                    }
                };

                onMounted(() => { poll(); setInterval(poll, 2000); });

                return {
                    listening, pipePath, project, settings, settingsChanged,
                    statusClass, saveSettings, copyPipePath
                };
            }
```

Из шапки файла убрать `import { DEFAULT_PORT } from '../../settings';` и заменить интерфейс
`ServerSettings` на `import type { DriverSettings } from '../../types';`. В шаблоне панели
(`static/template/default/index.html`) убрать поля порта, автостарта и лимита соединений, кнопку
старта/остановки и счётчик клиентов; оставить галочку `enableDebugLog`, строку `project`, строку
`pipePath` с кнопкой копирования и индикатор `listening`.

В `driver/package.json` из `contributions.messages` удалить `start-server` и `stop-server`,
а `get-server-status` переименовать в `get-driver-status` с методом `getDriverStatus`.

- [ ] **Step 5: Написать driver/tsup.config.ts**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/main.ts', 'src/scene/index.ts', 'src/panels/default/index.ts'],
    outDir: 'dist',
    format: ['cjs'],
    target: 'node20',
    platform: 'node',
    noExternal: [/.*/],
    external: ['electron'],
    splitting: false,
    sourcemap: 'inline',
    clean: true
});
```

`noExternal: [/.*/]` вшивает зависимости в бандл: папка расширения копируется в
`{project}/extensions/` без `node_modules`.

- [ ] **Step 6: Убрать MCP из зависимостей**

```bash
npm uninstall @modelcontextprotocol/sdk --workspace driver
```

- [ ] **Step 7: Убедиться, что удалённое больше нигде не упоминается**

Run: `grep -rn "modelcontextprotocol\|preview-log\|previewConsole\|PreviewLogStore" driver/ shared/ cli/ --include=*.ts`
Expected: пусто

- [ ] **Step 8: Коммит**

```bash
git add -A
git commit -m "драйвер переезжает в driver/, MCP-сервер и preview-логи удалены"
```

---

## Task 3: Имя канала

Файл кладётся сразу в `shared/`: имя канала обязано совпадать у драйвера и у CLI, и общий
модуль — единственное, что это гарантирует.

**Files:**
- Create: `shared/src/pipe-name.ts`
- Modify: `shared/src/protocol.ts` (реэкспорт)
- Test: `shared/test/pipe-name.test.mjs`

**Interfaces:**
- Consumes: ничего
- Produces: `PIPE_PREFIX: string`, `instanceKey(projectPath: string, platform?: NodeJS.Platform): string`,
  `pipePath(projectPath: string, platform?: NodeJS.Platform, tmp?: string): string`,
  `pipeDirectory(platform?: NodeJS.Platform, tmp?: string): string`

- [ ] **Step 1: Написать падающий тест**

`shared/test/pipe-name.test.mjs`:

```javascript
/**
 * Имя канала выводится из пути проекта и должно совпадать у драйвера и у CLI, иначе поиск
 * инстанса не сойдётся. Проверяется детерминированность, разведение разных проектов и то,
 * что регистр пути значим на POSIX и незначим на Windows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PIPE_PREFIX, instanceKey, pipePath, pipeDirectory } from '../dist/pipe-name.js';

test('один путь даёт один и тот же ключ при каждом вызове', () => {
    const a = instanceKey('D:/cocos/games/CyberCore', 'win32');
    const b = instanceKey('D:/cocos/games/CyberCore', 'win32');
    assert.equal(a, b);
    assert.equal(a.length, 12);
});

test('разные проекты дают разные ключи', () => {
    assert.notEqual(
        instanceKey('D:/cocos/games/CyberCore', 'win32'),
        instanceKey('D:/cocos/games/tl_weedmanager1a', 'win32'));
});

test('на windows регистр пути не разводит проекты, на posix разводит', () => {
    assert.equal(
        instanceKey('D:/Cocos/Games/CyberCore', 'win32'),
        instanceKey('d:/cocos/games/cybercore', 'win32'));
    assert.notEqual(
        instanceKey('/home/u/Games/Core', 'linux'),
        instanceKey('/home/u/games/core', 'linux'));
});

test('на windows это канал в пространстве имён, на posix — сокет во временном каталоге', () => {
    const key = instanceKey('D:/cocos/games/CyberCore', 'win32');
    assert.equal(pipePath('D:/cocos/games/CyberCore', 'win32'), `\\\\.\\pipe\\${PIPE_PREFIX}${key}`);
    assert.equal(
        pipePath('/home/u/game', 'linux', '/tmp'),
        `/tmp/cocos-cli/${PIPE_PREFIX}${instanceKey('/home/u/game', 'linux')}.sock`);
});

test('каталог поиска — то место, которое CLI перечисляет', () => {
    assert.equal(pipeDirectory('win32'), '\\\\.\\pipe\\');
    assert.equal(pipeDirectory('linux', '/tmp'), '/tmp/cocos-cli');
});
```

- [ ] **Step 2: Прогнать тест, убедиться что падает**

Run: `npm run build --workspace shared && npm run test:only --workspace shared`
Expected: FAIL — `Cannot find module '../dist/pipe-name.js'`

- [ ] **Step 3: Написать shared/src/pipe-name.ts**

```typescript
import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';

export const PIPE_PREFIX = 'cocos-cli-';

export function instanceKey(projectPath: string, platform: NodeJS.Platform = process.platform): string {
    const normalized = path.posix.normalize(projectPath.replace(/\\/g, '/')).replace(/\/+$/, '');
    const keyed = platform === 'win32' ? normalized.toLowerCase() : normalized;
    return createHash('sha1').update(keyed).digest('hex').slice(0, 12);
}

export function pipeDirectory(
    platform: NodeJS.Platform = process.platform, tmp: string = os.tmpdir()
): string {
    return platform === 'win32' ? '\\\\.\\pipe\\' : path.posix.join(tmp, 'cocos-cli');
}

export function pipePath(
    projectPath: string, platform: NodeJS.Platform = process.platform, tmp: string = os.tmpdir()
): string {
    const key = instanceKey(projectPath, platform);
    return platform === 'win32'
        ? `\\\\.\\pipe\\${PIPE_PREFIX}${key}`
        : path.posix.join(pipeDirectory(platform, tmp), `${PIPE_PREFIX}${key}.sock`);
}
```

- [ ] **Step 4: Реэкспортировать из protocol.ts**

В конец `shared/src/protocol.ts` добавить:

```typescript
export { PIPE_PREFIX, instanceKey, pipePath, pipeDirectory } from './pipe-name';
```

- [ ] **Step 5: Прогнать тест, убедиться что проходит**

Run: `npm run build --workspace shared && npm run test:only --workspace shared`
Expected: PASS, 10 тестов (5 из Task 1 + 5 новых)

- [ ] **Step 6: Коммит**

```bash
git add shared/src/pipe-name.ts shared/src/protocol.ts shared/test/pipe-name.test.mjs
git commit -m "имя канала выводится из пути проекта, регистр значим только вне windows"
```

---

## Task 4: Резолвер имени метода

**Files:**
- Create: `driver/src/method-table.ts`
- Test: `driver/test/method-table.test.mjs`

**Interfaces:**
- Consumes: `isKnownMethod` из `@cocos-cli/shared`
- Produces: `resolveMethod(name: string, editor: unknown, scene: unknown): ((...args: unknown[]) => unknown) | null`

- [ ] **Step 1: Написать падающий тест**

`driver/test/method-table.test.mjs`:

```javascript
/**
 * Резолвер — вся валидация, которую делает драйвер. Он обязан пропускать ровно 87 имён и
 * отвергать всё остальное, включая обращения к прототипу и к внутренностям объектов.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMethod } from '../lib/method-table.js';

const editor = {
    scene: { createNode: () => 'created', beginRecording: () => 'begun' },
    assetDb: { queryUuid: () => 'uuid' },
    builder: { addTask: () => 'task' },
    project: { queryConfig: () => 'config' }
};
const scene = { call: (method) => `scene:${method}` };

test('имя из пространства editor резолвится в функцию своей группы', () => {
    const fn = resolveMethod('editor.scene.createNode', editor, scene);
    assert.equal(typeof fn, 'function');
    assert.equal(fn(), 'created');
});

test('имя из пространства scene уходит в клиент scene-скрипта под своим именем', () => {
    const fn = resolveMethod('scene.dumpSceneNodes', editor, scene);
    assert.equal(fn(), 'scene:dumpSceneNodes');
});

test('имени вне списка 87 не соответствует ничего', () => {
    assert.equal(resolveMethod('editor.scene.deleteEverything', editor, scene), null);
    assert.equal(resolveMethod('scene.wipeProject', editor, scene), null);
    assert.equal(resolveMethod('editor.queryConfig', editor, scene), null);
});

test('обращение к прототипу не проходит, даже когда такое имя существует у объекта', () => {
    assert.equal(resolveMethod('editor.scene.constructor', editor, scene), null);
    assert.equal(resolveMethod('editor.__proto__.toString', editor, scene), null);
    assert.equal(resolveMethod('__proto__', editor, scene), null);
});

test('известное имя, для которого редактор не дал функции, тоже даёт null', () => {
    assert.equal(resolveMethod('editor.scene.saveScene', { scene: {} }, scene), null);
});
```

- [ ] **Step 2: Прогнать тест, убедиться что падает**

Run: `npm run build --workspace driver && npm run test:only --workspace driver`
Expected: FAIL — `Cannot find module '../lib/method-table.js'`

- [ ] **Step 3: Написать driver/src/method-table.ts**

```typescript
import { isKnownMethod } from '@cocos-cli/shared';

type AnyFn = (...args: unknown[]) => unknown;

export function resolveMethod(name: string, editor: unknown, scene: unknown): AnyFn | null {
    if (!isKnownMethod(name)) return null;

    if (name.startsWith('scene.')) {
        const method = name.slice('scene.'.length);
        const client = scene as { call: (method: string, ...args: unknown[]) => unknown };
        return (...args: unknown[]) => client.call(method, ...args);
    }

    const [, group, method] = name.split('.');
    const owner = (editor as Record<string, unknown>)[group];
    if (!owner || typeof owner !== 'object') return null;
    const fn = (owner as Record<string, unknown>)[method];
    if (typeof fn !== 'function') return null;
    return (...args: unknown[]) => (fn as AnyFn).apply(owner, args);
}
```

Обращение к прототипу отсекается тем, что `isKnownMethod` проверяется до любого доступа к
свойству: `constructor` и `__proto__` в списке 87 отсутствуют.

- [ ] **Step 4: Прогнать тест, убедиться что проходит**

Run: `npm run build --workspace driver && npm run test:only --workspace driver`
Expected: PASS, 5 тестов (набор driver содержит только method-table — pipe-name живёт в shared)

- [ ] **Step 5: Коммит**

```bash
git add driver/src/method-table.ts driver/test/method-table.test.mjs
git commit -m "резолвер метода: список 87 проверяется до доступа к свойству"
```

---

## Task 5: Сервер канала

**Files:**
- Create: `driver/src/pipe-server.ts`, `driver/src/main.ts`

**Interfaces:**
- Consumes: `resolveMethod` (Task 4), `pipePath` (Task 3), `EditorApi`, `SceneScriptClient`, `Hello`
- Produces: `class PipeServer { constructor(editor, scene, settings); start(): Promise<void>;
  stop(): Promise<void>; getStatus(): DriverStatus }`

Живой код, тестами не покрывается — проверяется прогоном в редакторе (см. Step 5).

**Две ловушки, которые код обязан закрыть.** `stop()` рвёт открытые сокеты до `server.close()`:
тот ждёт закрытия всех соединений, а Node сам их не рвёт, и выключение расширения виснет на
любом живом клиенте. Очередь `p-queue` сериализует отдельные вызовы, но между `beginRecording`
и `endRecording` лежит сетевой round-trip, и на это время очередь пустеет — поэтому нужен ещё и
владелец скобки: пока она открыта, вызовы прочих соединений ждут, а владение снимается по
`endRecording`, `cancelRecording` или обрыву сокета.

- [ ] **Step 1: Написать driver/src/pipe-server.ts**

```typescript
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import split2 from 'split2';
import PQueue from 'p-queue';
import { JSONRPCServer } from 'json-rpc-2.0';
import { ALL_METHODS, Hello } from '@cocos-cli/shared';
import { resolveMethod } from './method-table';
import { pipePath } from './pipe-name';
import type { EditorApi } from './editor-api';
import type { SceneScriptClient } from './scene-script-client';
import type { DriverSettings, DriverStatus } from './types';

const VERSION = '2.0.0';

function surfaceChecksum(): string {
    return require('crypto').createHash('sha1').update(ALL_METHODS.join('\n')).digest('hex').slice(0, 12);
}

export class PipeServer {
    private server: net.Server | null = null;
    private readonly sockets = new Set<net.Socket>();
    private readonly queue = new PQueue({ concurrency: 1 });
    private readonly rpc = new JSONRPCServer();
    private readonly address = pipePath(Editor.Project.path);

    constructor(
        private readonly editor: EditorApi,
        private readonly scene: SceneScriptClient,
        private readonly settings: DriverSettings
    ) {
        this.rpc.addMethod('hello', async (): Promise<Hello> => ({
            project: path.basename(Editor.Project.path),
            projectPath: Editor.Project.path,
            pid: process.pid,
            version: VERSION,
            surfaceChecksum: surfaceChecksum()
        }));

        for (const name of ALL_METHODS) {
            this.rpc.addMethod(name, (params: unknown) => this.queue.add(() => {
                const fn = resolveMethod(name, this.editor, this.scene);
                if (!fn) throw new Error(`driver does not carry '${name}'`);
                return fn(...(Array.isArray(params) ? params : []));
            }));
        }
    }

    async start(): Promise<void> {
        if (this.server) return;
        if (process.platform !== 'win32') {
            fs.mkdirSync(path.dirname(this.address), { recursive: true });
            try { fs.unlinkSync(this.address); } catch { }
        }

        const server = net.createServer(socket => this.serve(socket));
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.address, resolve);
        });
        this.server = server;
        console.log(`[cocos-cli] listening on ${this.address}`);
    }

    async stop(): Promise<void> {
        const server = this.server;
        this.server = null;
        if (!server) return;
        // close() ждёт закрытия всех открытых соединений, а Node сам их не рвёт: без этого
        // выключение расширения виснет на любом живом клиенте.
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }

    getStatus(): DriverStatus {
        return {
            listening: !!this.server,
            pipePath: this.address,
            project: path.basename(Editor.Project.path)
        };
    }

    /**
     * Скобка undo переживает несколько запросов, поэтому обрыв соединения посреди неё оставил
     * бы редактор в записи навсегда. Открытая скобка снимается вместе с сокетом.
     */
    private serve(socket: net.Socket): void {
        let recording = false;
        socket.pipe(split2()).on('data', async (line: string) => {
            if (!line.trim()) return;
            let request: any;
            try { request = JSON.parse(line); } catch { return; }
            if (request.method === 'editor.scene.beginRecording') recording = true;
            if (request.method === 'editor.scene.endRecording'
                || request.method === 'editor.scene.cancelRecording') recording = false;
            const response = await this.rpc.receive(request);
            if (response && !socket.destroyed) socket.write(JSON.stringify(response) + '\n');
        });
        socket.on('close', () => {
            if (!recording) return;
            this.editor.scene.cancelRecording().catch(
                (error: unknown) => console.warn('[cocos-cli] dangling undo bracket:', error));
        });
        socket.on('error', () => socket.destroy());
    }
}
```

- [ ] **Step 2: Написать driver/src/main.ts**

```typescript
import { readSettings, saveSettings } from './settings';
import { DriverSettings } from './types';
import { EditorApi } from './editor-api';
import { SceneScriptClient } from './scene-script-client';
import { PipeServer } from './pipe-server';

let settings: DriverSettings = readSettings();
let server: PipeServer | null = null;

export const methods: { [key: string]: (...any: any) => any } = {
    openPanel() {
        Editor.Panel.open('cocos-mcp-server');
    },

    getDriverStatus() {
        const status = server ? server.getStatus() : { listening: false, pipePath: '', project: '' };
        return { ...status, settings };
    },

    async updateSettings(next: DriverSettings) {
        saveSettings(next);
        settings = next;
    }
};

export async function load() {
    settings = readSettings();
    const editor = new EditorApi();
    server = new PipeServer(editor, new SceneScriptClient(editor), settings);
    await server.start();
}

export async function unload() {
    if (server) {
        await server.stop();
        server = null;
    }
}
```

`PipeServer` появится в Task 5; до тех пор сборка драйвера падает — это ожидаемо и чинится там.

- [ ] **Step 3: Собрать драйвер**

Run: `npm run build --workspace driver`
Expected: сборка зелёная, в `driver/dist/` появились `main.js`, `scene/index.js`,
`panels/default/index.js`

- [ ] **Step 4: Убедиться, что бандл самодостаточен**

Run: `grep -o 'require("[a-z@][^"]*")' driver/dist/main.js | sort -u`
Expected: только встроенные модули Node (`fs`, `net`, `path`, `crypto`, `os`) и `electron`.
Ни `json-rpc-2.0`, ни `split2`, ни `p-queue` в выводе быть не должно.

- [ ] **Step 5: Установить драйвер в проект и перезагрузить расширение**

```bash
cp -r driver "D:/cocos/cocos-playables/games/CyberCore/extensions/cocos-mcp-server"
```

Затем **вручную** выключить и включить расширение в Extension Manager редактора. Ничто другое
не сбрасывает require-кэш Node.

- [ ] **Step 6: Живая проверка канала**

```bash
node -e "
const net=require('net'),B=String.fromCharCode(92);
const dir=B+B+'.'+B+'pipe'+B;
const name=require('fs').readdirSync(dir).find(n=>n.startsWith('cocos-cli-'));
console.log('канал:',name);
const c=net.connect(dir+name);
c.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'hello'})+'\n');
c.on('data',d=>{console.log(d.toString());c.end()});
"
```

Expected: в ответе `result` с `project: \"CyberCore\"`, непустым `projectPath`, `pid` и
`surfaceChecksum`.

- [ ] **Step 7: Живая проверка отказа неизвестному методу**

Тот же скрипт с `method:'editor.scene.deleteEverything'`.
Expected: `error` с кодом `-32601` (метод не зарегистрирован), редактор не падает.

- [ ] **Step 8: Коммит**

```bash
git add driver/src/pipe-server.ts driver/src/main.ts driver/tsup.config.ts
git commit -m "сервер канала: json-rpc поверх сокета, очередь на один запрос, снятие скобки при обрыве"
```

---

## Task 6: Поиск инстанса в CLI

**Files:**
- Create: `cli/src/discovery.ts`, `cli/src/exit.ts`
- Test: `cli/test/discovery.test.mjs`

**Interfaces:**
- Consumes: `PIPE_PREFIX`, `pipeDirectory`, `Hello` из `@cocos-cli/shared` (Task 3)
- Produces: `EXIT: { OK: 0, FAILED: 1, USAGE: 2, NO_EDITOR: 3, PROTOCOL: 4 }` из `cli/src/exit.ts`;
  `selectInstance(candidates: Hello[], wanted?: string): { ok: true; chosen: Hello } | { ok: false; message: string }`,
  `discover(probe: (address: string) => Promise<Hello | null>, list?: () => string[]): Promise<Hello[]>`,
  `probeAddress(address: string, timeoutMs?: number): Promise<Hello | null>` из `cli/src/discovery.ts`

- [ ] **Step 1: Написать падающий тест**

`cli/test/discovery.test.mjs`:

```javascript
/**
 * Выбор инстанса — единственное место, где CLI решает, с каким редактором говорить. Проверяется
 * молчаливый выбор единственного, разведение по подстроке, и две громкие неудачи: не найдено
 * ничего и найдено несколько без указания.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EXIT, selectInstance, discover } from '../lib/discovery.js';

const hello = (project, projectPath) => ({
    project, projectPath, pid: 1, version: '2.0.0', surfaceChecksum: 'abc'
});
const CYBER = hello('CyberCore', 'D:/cocos/games/CyberCore');
const WEED = hello('tl_weedmanager1a', 'D:/cocos/games/tl_weedmanager1a');

test('единственный живой инстанс берётся без указания', () => {
    const result = selectInstance([CYBER]);
    assert.equal(result.ok, true);
    assert.equal(result.chosen.project, 'CyberCore');
});

test('ни одного живого — отказ, который называет, что искали', () => {
    const result = selectInstance([]);
    assert.equal(result.ok, false);
    assert.match(result.message, /ни одного/i);
});

test('несколько живых без указания — отказ со списком обоих', () => {
    const result = selectInstance([CYBER, WEED]);
    assert.equal(result.ok, false);
    assert.match(result.message, /CyberCore/);
    assert.match(result.message, /tl_weedmanager1a/);
});

test('подстрока разводит инстансы и не смотрит на регистр', () => {
    assert.equal(selectInstance([CYBER, WEED], 'weed').chosen.project, 'tl_weedmanager1a');
    assert.equal(selectInstance([CYBER, WEED], 'CYBER').chosen.project, 'CyberCore');
});

test('подстрока матчится и по пути проекта, не только по имени', () => {
    assert.equal(selectInstance([CYBER, WEED], 'games/CyberCore').chosen.project, 'CyberCore');
});

test('подстрока, подходящая обоим, — отказ, а не молчаливый первый', () => {
    const result = selectInstance([CYBER, WEED], 'cocos/games');
    assert.equal(result.ok, false);
    assert.match(result.message, /несколько/i);
});

test('подстрока, не подходящая никому, называет её саму', () => {
    const result = selectInstance([CYBER, WEED], 'zzz');
    assert.equal(result.ok, false);
    assert.match(result.message, /zzz/);
});

test('канал, который не ответил, в кандидаты не попадает', async () => {
    const list = () => ['cocos-cli-aaa', 'cocos-cli-bbb', 'somethingelse'];
    const probe = async (address) => (address.endsWith('aaa') ? CYBER : null);
    const found = await discover(probe, list);
    assert.deepEqual(found.map(h => h.project), ['CyberCore']);
});

test('коды выхода различают ненайденный редактор и отказавшую операцию', () => {
    assert.equal(EXIT.OK, 0);
    assert.equal(EXIT.FAILED, 1);
    assert.equal(EXIT.USAGE, 2);
    assert.equal(EXIT.NO_EDITOR, 3);
    assert.equal(EXIT.PROTOCOL, 4);
});
```

- [ ] **Step 2: Прогнать тест, убедиться что падает**

Run: `npm run build --workspace cli && npm run test:only --workspace cli`
Expected: FAIL — `Cannot find module '../lib/discovery.js'`

- [ ] **Step 3: Написать cli/src/exit.ts**

```typescript
export const EXIT = {
    OK: 0,
    FAILED: 1,
    USAGE: 2,
    NO_EDITOR: 3,
    PROTOCOL: 4
} as const;

export type ExitCode = typeof EXIT[keyof typeof EXIT];
```

- [ ] **Step 4: Написать cli/src/discovery.ts**

```typescript
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import split2 from 'split2';
import { Hello, PIPE_PREFIX, pipeDirectory } from '@cocos-cli/shared';

export { EXIT } from './exit';
export type { ExitCode } from './exit';

export type Selection =
    | { ok: true; chosen: Hello }
    | { ok: false; message: string };

const label = (hello: Hello) => `${hello.project}  ${hello.projectPath}`;

export function selectInstance(candidates: Hello[], wanted?: string): Selection {
    if (!candidates.length) {
        return {
            ok: false,
            message: `ни одного открытого редактора Cocos с этим расширением не найдено в ${pipeDirectory()}`
        };
    }

    if (!wanted) {
        if (candidates.length === 1) return { ok: true, chosen: candidates[0] };
        return {
            ok: false,
            message: 'открыто несколько редакторов, укажите --project:\n'
                + candidates.map(h => `  ${label(h)}`).join('\n')
        };
    }

    const needle = wanted.toLowerCase().replace(/\\/g, '/');
    const matched = candidates.filter(h =>
        h.project.toLowerCase().includes(needle)
        || h.projectPath.toLowerCase().replace(/\\/g, '/').includes(needle));

    if (matched.length === 1) return { ok: true, chosen: matched[0] };
    if (!matched.length) {
        return {
            ok: false,
            message: `'${wanted}' не подходит ни одному открытому редактору:\n`
                + candidates.map(h => `  ${label(h)}`).join('\n')
        };
    }
    return {
        ok: false,
        message: `'${wanted}' подходит нескольким редакторам, уточните:\n`
            + matched.map(h => `  ${label(h)}`).join('\n')
    };
}

export async function discover(
    probe: (address: string) => Promise<Hello | null>,
    list: () => string[] = listAddresses
): Promise<Hello[]> {
    const found = await Promise.all(
        list().filter(name => name.startsWith(PIPE_PREFIX)).map(name => probe(addressOf(name))));
    return found.filter((hello): hello is Hello => hello !== null);
}

function addressOf(name: string): string {
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\${name}`
        : path.posix.join(pipeDirectory(), name);
}

function listAddresses(): string[] {
    try {
        return fs.readdirSync(pipeDirectory());
    } catch {
        return [];
    }
}

/**
 * Сокет на POSIX переживает падение редактора, а канал на Windows нет. Неотвечающий адрес
 * отбрасывается по таймауту, чтобы протухший файл не задерживал поиск.
 */
export function probeAddress(address: string, timeoutMs = 500): Promise<Hello | null> {
    return new Promise(resolve => {
        const socket = net.connect(address);
        const done = (value: Hello | null) => { socket.destroy(); resolve(value); };
        socket.setTimeout(timeoutMs, () => done(null));
        socket.on('error', () => done(null));
        socket.on('connect', () =>
            socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello' }) + '\n'));
        socket.pipe(split2()).on('data', (line: string) => {
            try {
                const parsed = JSON.parse(line);
                done(parsed.result ?? null);
            } catch {
                done(null);
            }
        });
    });
}
```

- [ ] **Step 5: Прогнать тест, убедиться что проходит**

Run: `npm run build && npm run test:only --workspace cli`
Expected: PASS, 9 тестов

- [ ] **Step 6: Коммит**

```bash
git add cli/src/discovery.ts cli/src/exit.ts cli/test/discovery.test.mjs
git commit -m "поиск инстанса: единственный берётся молча, несколько без --project отказывают со списком"
```

---

## Task 7: Клиент драйвера

**Files:**
- Create: `cli/src/driver-client.ts`

**Interfaces:**
- Consumes: `Hello`, `EDITOR_METHODS`, `SCENE_METHODS`
- Produces: `class DriverClient { static connect(address: string): Promise<DriverClient>;
  editor: EditorFacade; scene: SceneFacade; close(): void }`, где
  `EditorFacade` — объект с группами `scene`/`assetDb`/`builder`/`project`, каждый метод которых
  возвращает `Promise<unknown>`, а `SceneFacade` — `call(method: string, ...args: unknown[]): Promise<unknown>`

Живой код, тестами не покрывается — проверяется в Task 8 через `cocos instances`.

- [ ] **Step 1: Написать cli/src/driver-client.ts**

```typescript
import * as net from 'net';
import split2 from 'split2';
import { JSONRPCClient } from 'json-rpc-2.0';
import { EDITOR_METHODS } from '@cocos-cli/shared';

export interface SceneFacade {
    call(method: string, ...args: unknown[]): Promise<unknown>;
}

export type EditorFacade = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;

export class DriverClient {
    readonly editor: EditorFacade;
    readonly scene: SceneFacade;

    private constructor(
        private readonly socket: net.Socket,
        private readonly rpc: JSONRPCClient
    ) {
        const editor: EditorFacade = {};
        for (const name of EDITOR_METHODS) {
            const [group, method] = name.split('.');
            editor[group] = editor[group] || {};
            editor[group][method] = (...args: unknown[]) => this.rpc.request(`editor.${name}`, args);
        }
        this.editor = editor;
        this.scene = { call: (method, ...args) => this.rpc.request(`scene.${method}`, args) };
    }

    static connect(address: string): Promise<DriverClient> {
        return new Promise((resolve, reject) => {
            const socket = net.connect(address);
            const rpc = new JSONRPCClient(request => {
                socket.write(JSON.stringify(request) + '\n');
                return Promise.resolve();
            });
            socket.pipe(split2()).on('data', (line: string) => {
                if (!line.trim()) return;
                try { rpc.receive(JSON.parse(line)); } catch { }
            });
            socket.on('error', reject);
            socket.on('close', () =>
                rpc.rejectAllPendingRequests('соединение с редактором закрылось'));
            socket.on('connect', () => resolve(new DriverClient(socket, rpc)));
        });
    }

    close(): void {
        this.socket.destroy();
    }
}
```

- [ ] **Step 2: Собрать**

Run: `npm run build --workspace cli`
Expected: сборка зелёная

- [ ] **Step 3: Коммит**

```bash
git add cli/src/driver-client.ts
git commit -m "клиент драйвера: фасады editor и scene поверх json-rpc по сокету"
```

---

## Task 8: Каркас CLI и команда instances

**Files:**
- Create: `cli/src/main.ts`, `cli/src/resolve.ts`, `cli/src/render/instances.ts`, `cli/tsup.config.ts`
- Test: `cli/test/instances-render.test.mjs`

**Interfaces:**
- Consumes: `discover`, `probeAddress`, `selectInstance`, `EXIT`, `DriverClient`
- Produces: `renderInstances(instances: Hello[]): string` из `cli/src/render/instances.ts`;
  `type Resolved = { ok: true; client: DriverClient; hello: Hello } | { ok: false; message: string }`
  и `resolveClient(wanted?: string): Promise<Resolved>` из `cli/src/resolve.ts`

`Resolved` объявлен в `resolve.ts`, а не в `main.ts`: команды из задач 11–13 импортируют этот
тип, и объявление в точке входа замкнуло бы импорты в кольцо.

- [ ] **Step 1: Написать падающий тест**

`cli/test/instances-render.test.mjs`:

```javascript
/**
 * Таблица инстансов — первое, что видит человек, когда CLI отказался выбирать сам. Она обязана
 * называть и проект, и путь, иначе два проекта с одинаковым именем неразличимы.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderInstances } from '../lib/render/instances.js';

const hello = (project, projectPath, pid) => ({
    project, projectPath, pid, version: '2.0.0', surfaceChecksum: 'abc'
});

test('строка на инстанс, с проектом, путём и pid', () => {
    const text = renderInstances([
        hello('CyberCore', 'D:/cocos/games/CyberCore', 111),
        hello('tl_weedmanager1a', 'D:/cocos/games/tl_weedmanager1a', 222)
    ]);
    assert.match(text, /CyberCore/);
    assert.match(text, /tl_weedmanager1a/);
    assert.match(text, /111/);
    assert.match(text, /222/);
    assert.match(text, /D:\/cocos\/games\/CyberCore/);
});

test('пустой список говорит словами, а не пустой таблицей', () => {
    assert.match(renderInstances([]), /ни одного/i);
});

test('одноимённые проекты различимы по пути', () => {
    const text = renderInstances([
        hello('Game', 'D:/a/Game', 1),
        hello('Game', 'D:/b/Game', 2)
    ]);
    assert.match(text, /D:\/a\/Game/);
    assert.match(text, /D:\/b\/Game/);
});
```

- [ ] **Step 2: Прогнать тест, убедиться что падает**

Run: `npm run build --workspace cli && npm run test:only --workspace cli`
Expected: FAIL — `renderInstances is not a function`

- [ ] **Step 3: Написать cli/tsup.config.ts**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { cocos: 'src/main.ts' },
    outDir: 'bin',
    format: ['cjs'],
    target: 'node20',
    platform: 'node',
    noExternal: [/.*/],
    splitting: false,
    sourcemap: 'inline',
    clean: true,
    banner: { js: '#!/usr/bin/env node' }
});
```

- [ ] **Step 4: Написать cli/src/render/instances.ts**

```typescript
import Table from 'cli-table3';
import { Hello } from '@cocos-cli/shared';

export function renderInstances(instances: Hello[]): string {
    if (!instances.length) return 'ни одного открытого редактора Cocos не найдено';
    const table = new Table({ head: ['проект', 'путь', 'pid'] });
    for (const hello of instances) table.push([hello.project, hello.projectPath, String(hello.pid)]);
    return table.toString();
}
```

- [ ] **Step 5: Написать cli/src/resolve.ts**

```typescript
import { Hello, pipePath } from '@cocos-cli/shared';
import { discover, probeAddress, selectInstance } from './discovery';
import { DriverClient } from './driver-client';

export type Resolved =
    | { ok: true; client: DriverClient; hello: Hello }
    | { ok: false; message: string };

export async function resolveClient(wanted?: string): Promise<Resolved> {
    const candidates = await discover(probeAddress);
    const selection = selectInstance(candidates, wanted);
    if (!selection.ok) return selection;
    const client = await DriverClient.connect(pipePath(selection.chosen.projectPath));
    return { ok: true, client, hello: selection.chosen };
}
```

- [ ] **Step 6: Написать cli/src/main.ts**

```typescript
import { Command } from 'commander';
import { discover, probeAddress } from './discovery';
import { renderInstances } from './render/instances';
import { resolveClient } from './resolve';
import { EXIT } from './exit';

export function buildProgram(): Command {
    const program = new Command('cocos');
    program
        .description('Драйвер открытых редакторов Cocos Creator')
        .option('-p, --project <substring>', 'какой редактор, если открыто несколько')
        .option('--json', 'выдать структурную форму вместо текста')
        .exitOverride();

    program
        .command('instances')
        .description('перечислить открытые редакторы')
        .action(async () => {
            const found = await discover(probeAddress);
            if (program.opts().json) {
                process.stdout.write(JSON.stringify(found) + '\n');
            } else {
                process.stdout.write(renderInstances(found) + '\n');
            }
            process.exitCode = found.length ? EXIT.OK : EXIT.NO_EDITOR;
        });

    return program;
}

if (require.main === module) {
    buildProgram().parseAsync(process.argv).catch((error: any) => {
        process.stderr.write(String(error?.message || error) + '\n');
        process.exitCode = error?.code === 'commander.unknownCommand' ? EXIT.USAGE : EXIT.PROTOCOL;
    });
}
```

- [ ] **Step 7: Прогнать тест, убедиться что проходит**

Run: `npm run build && npm run test:only --workspace cli`
Expected: PASS, 12 тестов (9 из Task 6 + 3 новых)

- [ ] **Step 8: Живая проверка на двух редакторах**

```bash
npm link --workspace cli
cocos instances
```

Expected: таблица с двумя строками — CyberCore и tl_weedmanager1a, с их путями и разными pid.

- [ ] **Step 9: Коммит**

```bash
git add cli/src/main.ts cli/src/resolve.ts cli/src/render/instances.ts cli/tsup.config.ts cli/test/instances-render.test.mjs
git commit -m "каркас cli на commander, instances перечисляет открытые редакторы"
```

---

## Task 9: Переезд чистых модулей в CLI

**Files:**
- Move: `source/node-type.ts`, `source/property/*`,
  `source/undo-bracket.ts`, `source/settle.ts`, `source/json-arg.ts`, `source/result.ts`,
  `source/tool-args.ts`, `source/scene-signature.ts` → `cli/src/`
- Move: соответствующие файлы из `test/` → `cli/test/`
- Delete: `source/` целиком после переезда, вместе с `source/tools-v2/`, `source/registry.ts`,
  `source/tool.ts`, `source/context.ts`, `source/editor-api.ts` (переехал в Task 2)
- Delete: тесты снесённого — `test/compose-tools.test.mjs`, `test/registry.test.mjs`,
  `test/tool-schema-contract.test.mjs`, `test/component-args.test.mjs`,
  `test/debug-tools.test.mjs`, `test/asset-tools.test.mjs`,
  `test/validate-references-tool.test.mjs`, `test/build-task-conflicts.test.mjs`

**Interfaces:**
- Consumes: `shared/src/scene-contract.ts`
- Produces: те же экспорты, что и раньше, по новым путям. `undo-bracket.ts` — `withUndoBracket`;
  `result.ts` — `ok`, `fail`, `isOk`, `ToolResult`. `node-path`, `serialized-diff` и
  `reference-projection` сюда НЕ переезжают: они живут в `shared/` с правок Task 2, потому что
  их зовёт scene-скрипт в редакторе. Импортируй их из `@cocos-cli/shared`.

Инструменты (`tools-v2/`) не переезжают: команды пишутся заново в задачах 11–13 (спека §12,
большой взрыв).

- [ ] **Step 1: Перенести модули и их тесты**

```bash
mkdir -p cli/src/property cli/test/fixtures
for f in node-type undo-bracket settle json-arg result tool-args scene-signature; do
  git mv "source/$f.ts" "cli/src/$f.ts"
done
git mv source/property cli/src/property
for f in node-type property-kind property-writers settle json-arg result; do
  git mv "test/$f.test.mjs" "cli/test/$f.test.mjs"
done
git mv test/fixtures cli/test/fixtures
```

- [ ] **Step 2: Удалить снесённое**

```bash
git rm -r source/tools-v2 source/registry.ts source/tool.ts source/context.ts
git rm test/compose-tools.test.mjs test/registry.test.mjs test/tool-schema-contract.test.mjs
git rm test/component-args.test.mjs test/debug-tools.test.mjs test/asset-tools.test.mjs
git rm test/validate-references-tool.test.mjs test/build-task-conflicts.test.mjs
```

Оставшиеся в `source/` чистые модули (`prefab-json`, `prefab-value`, `prefab-linkage`,
`reference-scan`, `batch-plan`, `build-task`, `asset-query`, `asset-json`,
`project-log`, `log-search`, `ecs-census`, `missing-scripts`) переезжают во втором плане вместе
со своими группами команд. До тех пор они остаются в `source/` и не собираются.

- [ ] **Step 3: Поправить импорты**

Во всех перенесённых файлах заменить `from './scene-contract'` и `from '../scene-contract'` на
`from '@cocos-cli/shared'`. Заменить `from './context'` на импорт типа из `./driver-client`:

```typescript
import type { DriverClient } from './driver-client';
```

и заменить тип параметра `ctx: ToolContext` на `ctx: DriverClient` в `undo-bracket.ts` и
`property/`.

- [ ] **Step 4: Поправить пути импорта в тестах**

Во всех перенесённых тестах заменить `../dist/X.js` на `../lib/X.js` — `tsc` в пакете `cli/`
кладёт помодульную сборку именно туда. Импорты вида `../dist/tools-v2/...` удалить вместе с
падающими на них случаями.

```bash
sed -i "s|'\.\./dist/|'../lib/|g" cli/test/*.test.mjs
```

- [ ] **Step 5: Прогнать тесты**

Run: `npm run build && npm test`
Expected: PASS. Число тестов меньше прежних 406 — снесены наборы про реестр и схемы
инструментов, которых больше нет.

- [ ] **Step 6: Коммит**

```bash
git add -A
git commit -m "чистые модули ядра переезжают в cli/, реестр и схемы инструментов сняты"
```

---

## Task 10: Рендер дерева

**Files:**
- Create: `cli/src/render/tree.ts`
- Test: `cli/test/render-tree.test.mjs`

**Interfaces:**
- Consumes: ничего
- Produces: `interface DumpNode { uuid: string; name: string; parentUuid: string; active: boolean;
  components?: { type: string }[] }`, `renderTree(nodes: DumpNode[], options?: { uuid?: boolean }): string`

- [ ] **Step 1: Написать падающий тест**

`cli/test/render-tree.test.mjs`:

```javascript
/**
 * Дерево — форма, в которой сцена попадает в контекст агента. Вложенность заменяет parentUuid,
 * path и childCount, поэтому проверяется, что структура восстанавливается из плоского списка
 * в любом порядке, а неактивный узел помечен.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTree } from '../lib/render/tree.js';

const node = (uuid, name, parentUuid, components = [], active = true) =>
    ({ uuid, name, parentUuid, active, components: components.map(type => ({ type })) });

const scene = [
    node('u_canvas', 'Canvas', 'u_root', ['UITransform', 'Canvas']),
    node('u_bg', 'Bg', 'u_canvas', ['Sprite']),
    node('u_btn', 'Btn', 'u_canvas', ['Button'], false),
    node('u_label', 'Label', 'u_btn', ['Label'])
];

test('корнем становится узел, чьего родителя нет в списке', () => {
    const text = renderTree(scene);
    assert.match(text.split('\n')[0], /^Canvas/);
});

test('типы компонентов идут в скобках через запятую', () => {
    assert.match(renderTree(scene), /Canvas {2}\[UITransform,Canvas\]/);
});

test('неактивный узел помечен, активный — нет', () => {
    const text = renderTree(scene);
    assert.match(text, /Btn.*\(off\)/);
    assert.doesNotMatch(text.split('\n').find(l => l.includes('Bg')), /\(off\)/);
});

test('вложенность восстанавливается независимо от порядка в списке', () => {
    const shuffled = [scene[3], scene[1], scene[0], scene[2]];
    assert.equal(renderTree(shuffled).split('\n').length, renderTree(scene).split('\n').length);
    assert.match(renderTree(shuffled).split('\n')[0], /^Canvas/);
});

test('узел без компонентов идёт без скобок', () => {
    assert.match(renderTree([node('u_a', 'Empty', 'u_root')]), /^Empty$/m);
});

test('uuid показывается только когда его попросили', () => {
    assert.doesNotMatch(renderTree(scene), /u_canvas/);
    assert.match(renderTree(scene, { uuid: true }), /u_canvas/);
});

test('цикл в родителях не вешает рендер', () => {
    const cyclic = [node('a', 'A', 'b'), node('b', 'B', 'a')];
    assert.equal(typeof renderTree(cyclic), 'string');
});
```

- [ ] **Step 2: Прогнать тест, убедиться что падает**

Run: `npm run build --workspace cli && npm run test:only --workspace cli`
Expected: FAIL — `Cannot find module '../lib/render/tree.js'`

- [ ] **Step 3: Написать cli/src/render/tree.ts**

```typescript
import archy from 'archy';

export interface DumpNode {
    uuid: string;
    name: string;
    parentUuid: string;
    active: boolean;
    components?: { type: string }[];
}

export interface TreeOptions {
    uuid?: boolean;
}

export function renderTree(nodes: DumpNode[], options: TreeOptions = {}): string {
    const known = new Set(nodes.map(node => node.uuid));
    const children = new Map<string, DumpNode[]>();
    for (const node of nodes) {
        const list = children.get(node.parentUuid) || [];
        list.push(node);
        children.set(node.parentUuid, list);
    }

    const label = (node: DumpNode): string => {
        const types = (node.components || []).map(component => component.type).join(',');
        return node.name
            + (types ? `  [${types}]` : '')
            + (node.active ? '' : '  (off)')
            + (options.uuid ? `  ${node.uuid}` : '');
    };

    // Список приходит плоским и может содержать цикл, если сцена читалась во время правки;
    // посещённые узлы обрывают обход, чтобы рендер не ушёл в бесконечность.
    const seen = new Set<string>();
    const build = (node: DumpNode): archy.Data => {
        if (seen.has(node.uuid)) return { label: label(node), nodes: [] };
        seen.add(node.uuid);
        return { label: label(node), nodes: (children.get(node.uuid) || []).map(build) };
    };

    return nodes
        .filter(node => !known.has(node.parentUuid))
        .map(root => archy(build(root)))
        .join('')
        .replace(/\n+$/, '');
}
```

- [ ] **Step 4: Прогнать тест, убедиться что проходит**

Run: `npm run build --workspace cli && npm run test:only --workspace cli`
Expected: PASS, 7 новых тестов

- [ ] **Step 5: Проверить размер на настоящей сцене**

Run:

```bash
cocos scene tree --project CyberCore | wc -c
```

(команда появится в Task 11; шаг выполняется после неё)
Expected: около 17 000 байт против 148 161 у нынешнего `scene_dump`.

- [ ] **Step 6: Коммит**

```bash
git add cli/src/render/tree.ts cli/test/render-tree.test.mjs
git commit -m "рендер дерева на archy: вложенность заменяет path, parentUuid и childCount"
```

---

## Task 11: Команды группы scene

**Files:**
- Create: `cli/src/commands/scene.ts`
- Modify: `cli/src/main.ts` (подключить группу)
- Test: `cli/test/commands-scene.test.mjs`

**Interfaces:**
- Consumes: `DriverClient`, `renderTree`, `EXIT`
- Produces: `registerScene(program: Command, resolve: () => Promise<Resolved>): void`,
  `sceneTree(client: DriverClient, options: { uuid?: boolean }): Promise<{ text: string; count: number }>`,
  `sceneInfo(client: DriverClient): Promise<string>`

- [ ] **Step 1: Написать падающий тест**

`cli/test/commands-scene.test.mjs`:

```javascript
/**
 * Команды группы scene против поддельного драйвера: проверяется, что отказ сцены поднимается
 * наверх словами, а не пустым выводом, и что дерево строится из того, что вернул дамп.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sceneTree, sceneInfo } from '../lib/commands/scene.js';

const driver = (answers) => ({
    editor: { scene: {} },
    scene: { call: async (method) => answers[method] ?? { success: false, error: `нет ответа на ${method}` } }
});

const DUMP = {
    success: true,
    data: {
        sceneName: 'main',
        nodeCount: 2,
        nodes: [
            { uuid: 'a', name: 'Canvas', parentUuid: 'root', active: true, components: [{ type: 'Canvas' }] },
            { uuid: 'b', name: 'Bg', parentUuid: 'a', active: true, components: [{ type: 'Sprite' }] }
        ]
    }
};

test('дерево строится из дампа и сообщает число узлов', async () => {
    const result = await sceneTree(driver({ dumpSceneNodes: DUMP }), {});
    assert.equal(result.count, 2);
    assert.match(result.text, /Canvas {2}\[Canvas\]/);
    assert.match(result.text, /Bg {2}\[Sprite\]/);
});

test('отказ scene-скрипта поднимается как ошибка с его же текстом', async () => {
    await assert.rejects(
        () => sceneTree(driver({ dumpSceneNodes: { success: false, error: 'сцена не открыта' } }), {}),
        /сцена не открыта/);
});

test('дамп без узлов не притворяется деревом', async () => {
    const result = await sceneTree(driver({ dumpSceneNodes: { success: true, data: { nodes: [] } } }), {});
    assert.equal(result.count, 0);
    assert.match(result.text, /пусто|нет узлов/i);
});

test('info называет сцену и число узлов одной строкой', async () => {
    const text = await sceneInfo(driver({
        getCurrentSceneInfo: { success: true, data: { name: 'main', uuid: 'u1', nodeCount: 42 } }
    }));
    assert.match(text, /main/);
    assert.match(text, /42/);
});
```

- [ ] **Step 2: Прогнать тест, убедиться что падает**

Run: `npm run build --workspace cli && npm run test:only --workspace cli`
Expected: FAIL — `Cannot find module '../lib/commands/scene.js'`

- [ ] **Step 3: Написать cli/src/commands/scene.ts**

```typescript
import { Command } from 'commander';
import { renderTree, DumpNode } from '../render/tree';
import { EXIT } from '../exit';
import type { DriverClient } from '../driver-client';
import type { Resolved } from '../resolve';

interface SceneAnswer<T> { success: boolean; data?: T; error?: string }

async function sceneCall<T>(client: DriverClient, method: string, ...args: unknown[]): Promise<T> {
    const answer = await client.scene.call(method, ...args) as SceneAnswer<T>;
    if (!answer || answer.success !== true || answer.data === undefined) {
        throw new Error(answer?.error || `scene-скрипт не ответил на ${method}`);
    }
    return answer.data;
}

export async function sceneTree(
    client: DriverClient, options: { uuid?: boolean }
): Promise<{ text: string; count: number }> {
    const dump = await sceneCall<{ nodes: DumpNode[] }>(client, 'dumpSceneNodes');
    const nodes = dump.nodes || [];
    return {
        count: nodes.length,
        text: nodes.length ? renderTree(nodes, { uuid: options.uuid }) : 'сцена пуста — нет узлов'
    };
}

export async function sceneInfo(client: DriverClient): Promise<string> {
    const info = await sceneCall<{ name: string; uuid: string; nodeCount: number }>(
        client, 'getCurrentSceneInfo');
    return `${info.name}  ${info.uuid}  узлов: ${info.nodeCount}`;
}

export function registerScene(program: Command, resolve: () => Promise<Resolved>): void {
    const scene = program.command('scene').description('сцена целиком');

    scene
        .command('tree')
        .description('иерархия открытой сцены')
        .option('--uuid', 'показать uuid узлов')
        .action(async (options: { uuid?: boolean }) => {
            const resolved = await resolve();
            if (!resolved.ok) {
                process.stderr.write(resolved.message + '\n');
                process.exitCode = EXIT.NO_EDITOR;
                return;
            }
            try {
                const result = await sceneTree(resolved.client, options);
                process.stdout.write(result.text + '\n');
                process.stderr.write(`узлов: ${result.count}\n`);
            } finally {
                resolved.client.close();
            }
        });

    scene
        .command('info')
        .description('имя, uuid и размер открытой сцены')
        .action(async () => {
            const resolved = await resolve();
            if (!resolved.ok) {
                process.stderr.write(resolved.message + '\n');
                process.exitCode = EXIT.NO_EDITOR;
                return;
            }
            try {
                process.stdout.write(await sceneInfo(resolved.client) + '\n');
            } finally {
                resolved.client.close();
            }
        });

    scene
        .command('open <path>')
        .description('открыть сцену по db:// пути или uuid')
        .action(async (target: string) => {
            const resolved = await resolve();
            if (!resolved.ok) {
                process.stderr.write(resolved.message + '\n');
                process.exitCode = EXIT.NO_EDITOR;
                return;
            }
            try {
                await resolved.client.editor.scene.openScene(target);
                process.stderr.write(`открыта ${target}\n`);
            } finally {
                resolved.client.close();
            }
        });

    scene
        .command('save')
        .description('сохранить открытую сцену')
        .action(async () => {
            const resolved = await resolve();
            if (!resolved.ok) {
                process.stderr.write(resolved.message + '\n');
                process.exitCode = EXIT.NO_EDITOR;
                return;
            }
            try {
                await resolved.client.editor.scene.saveScene();
                process.stderr.write('сцена сохранена\n');
            } finally {
                resolved.client.close();
            }
        });
}
```

- [ ] **Step 4: Подключить группу в cli/src/main.ts**

Добавить импорт `import { registerScene } from './commands/scene';` и внутри `buildProgram()`,
перед `return program`:

```typescript
    registerScene(program, () => resolveClient(program.opts().project));
```

- [ ] **Step 5: Прогнать тест, убедиться что проходит**

Run: `npm run build && npm run test:only --workspace cli`
Expected: PASS, 4 новых теста

- [ ] **Step 6: Живая проверка**

```bash
cocos scene tree --project CyberCore | head -20
cocos scene info --project CyberCore
cocos scene tree --project CyberCore | wc -c
```

Expected: дерево CyberCore, строка с именем сцены, около 17 000 байт.

- [ ] **Step 7: Коммит**

```bash
git add cli/src/commands/scene.ts cli/src/main.ts cli/test/commands-scene.test.mjs
git commit -m "команды scene: tree, info, open, save против живого драйвера"
```

---

## Task 12: Команды группы node

**Files:**
- Create: `cli/src/commands/node.ts`
- Modify: `cli/src/main.ts`
- Test: `cli/test/commands-node.test.mjs`

**Interfaces:**
- Consumes: `DriverClient`; разрешение пути делает scene-метод `resolveNodePaths`, локальный
  разбор дерева CLI не нужен
- Produces: `registerNode(program: Command, resolve: () => Promise<Resolved>): void`,
  `resolveNode(client: DriverClient, pathOrUuid: string): Promise<string>`,
  `nodeGet(client: DriverClient, pathOrUuid: string): Promise<string>`,
  `nodeCreate(client: DriverClient, spec: CreateSpec): Promise<string>`, где
  `interface CreateSpec { parent: string; name: string; components: string[]; pos?: [number, number, number] }`

- [ ] **Step 1: Написать падающий тест**

`cli/test/commands-node.test.mjs`:

```javascript
/**
 * Адресация узла путём — единственный способ, которым агент называет узлы, поэтому неоднозначный
 * путь обязан быть громким отказом. Создание проверяется по составу вызовов: скобка undo
 * охватывает и структурный шаг, и настройку.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveNode, nodeGet, nodeCreate } from '../lib/commands/node.js';

const TREE = {
    success: true,
    data: {
        resolutions: {
            'Canvas/Bg': { uuid: 'u_bg', matchedPath: 'Canvas/Bg' },
            'Canvas/Btn': { ambiguous: ['Canvas/Btn', 'Canvas/Btn'] },
            'Nope': { missing: true }
        }
    }
};

const recorder = () => {
    const calls = [];
    return {
        calls,
        editor: {
            scene: {
                beginRecording: async (...a) => { calls.push(['beginRecording', ...a]); return 'r1'; },
                endRecording: async (...a) => { calls.push(['endRecording', ...a]); },
                cancelRecording: async () => { calls.push(['cancelRecording']); },
                createNode: async (...a) => { calls.push(['createNode', ...a]); return 'u_new'; },
                createComponent: async (...a) => { calls.push(['createComponent', ...a]); }
            }
        },
        scene: {
            call: async (method, ...a) => {
                calls.push([method, ...a]);
                if (method === 'resolveNodePaths') return TREE;
                if (method === 'getNodeInfo') {
                    return { success: true, data: { name: 'Bg', uuid: 'u_bg', active: true,
                        components: [{ type: 'Sprite', enabled: true }] } };
                }
                return { success: true, data: {} };
            }
        }
    };
};

test('путь превращается в uuid через scene-скрипт', async () => {
    assert.equal(await resolveNode(recorder(), 'Canvas/Bg'), 'u_bg');
});

test('неоднозначный путь — отказ, называющий обоих кандидатов', async () => {
    await assert.rejects(() => resolveNode(recorder(), 'Canvas/Btn'), /Canvas\/Btn/);
});

test('несуществующий путь — отказ, называющий его самого', async () => {
    await assert.rejects(() => resolveNode(recorder(), 'Nope'), /Nope/);
});

test('уже готовый uuid проходит без обращения к сцене', async () => {
    const driver = recorder();
    assert.equal(await resolveNode(driver, 'u_something'), 'u_something');
    assert.equal(driver.calls.length, 0);
});

test('get отдаёт одну строку с именем, состоянием и компонентами', async () => {
    const text = await nodeGet(recorder(), 'Canvas/Bg');
    assert.match(text, /Bg/);
    assert.match(text, /Sprite/);
});

test('создание с компонентом укладывается в одну скобку undo', async () => {
    const driver = recorder();
    await nodeCreate(driver, { parent: 'Canvas/Bg', name: 'New', components: ['Sprite'] });
    const names = driver.calls.map(c => c[0]);
    assert.equal(names[0], 'resolveNodePaths');
    assert.equal(names[1], 'beginRecording');
    assert.equal(names[names.length - 1], 'endRecording');
    assert.ok(names.includes('createNode'));
    assert.ok(names.includes('createComponent'));
});

test('падение посреди создания снимает скобку, а не оставляет её открытой', async () => {
    const driver = recorder();
    driver.editor.scene.createComponent = async () => { throw new Error('нет такого компонента'); };
    await assert.rejects(
        () => nodeCreate(driver, { parent: 'Canvas/Bg', name: 'New', components: ['Nope'] }),
        /нет такого компонента/);
    assert.ok(driver.calls.map(c => c[0]).includes('cancelRecording'));
});
```

- [ ] **Step 2: Прогнать тест, убедиться что падает**

Run: `npm run build --workspace cli && npm run test:only --workspace cli`
Expected: FAIL — `Cannot find module '../lib/commands/node.js'`

- [ ] **Step 3: Написать cli/src/commands/node.ts**

```typescript
import { Command } from 'commander';
import { EXIT } from '../exit';
import type { DriverClient } from '../driver-client';
import type { Resolved } from '../resolve';

const UUID_LIKE = /^[A-Za-z0-9+/_-]{20,}$/;

interface Resolution {
    uuid?: string;
    matchedPath?: string;
    ambiguous?: string[];
    missing?: boolean;
}

export async function resolveNode(client: DriverClient, pathOrUuid: string): Promise<string> {
    if (UUID_LIKE.test(pathOrUuid) && !pathOrUuid.includes('/')) return pathOrUuid;

    const answer = await client.scene.call('resolveNodePaths', [pathOrUuid]) as
        { success: boolean; data?: { resolutions: Record<string, Resolution> }; error?: string };
    if (!answer || answer.success !== true || !answer.data) {
        throw new Error(answer?.error || 'сцена не открыта, путь узла не разрешить');
    }

    const resolution = answer.data.resolutions[pathOrUuid];
    if (!resolution || resolution.missing) {
        throw new Error(`'${pathOrUuid}' не соответствует ни одному узлу открытой сцены`);
    }
    if (resolution.ambiguous) {
        throw new Error(
            `'${pathOrUuid}' соответствует нескольким узлам:\n`
            + resolution.ambiguous.map(candidate => `  ${candidate}`).join('\n'));
    }
    if (!resolution.uuid) throw new Error(`'${pathOrUuid}' разрешился без uuid`);
    return resolution.uuid;
}

export async function nodeGet(client: DriverClient, pathOrUuid: string): Promise<string> {
    const uuid = await resolveNode(client, pathOrUuid);
    const answer = await client.scene.call('getNodeInfo', uuid) as
        { success: boolean; data?: any; error?: string };
    if (!answer || answer.success !== true || !answer.data) {
        throw new Error(answer?.error || `узел ${uuid} не прочитан`);
    }
    const info = answer.data;
    const components = (info.components || [])
        .map((component: any) => component.enabled === false ? `${component.type}(off)` : component.type)
        .join(',');
    return `${info.name}${info.active ? '' : '  (off)'}`
        + (components ? `  [${components}]` : '')
        + `  ${info.uuid}`;
}

export interface CreateSpec {
    parent: string;
    name: string;
    components: string[];
    pos?: [number, number, number];
}

/**
 * Скобка охватывает и структурный шаг, и настройку, чтобы созданный узел откатывался одним
 * Ctrl+Z. Провал любого шага снимает скобку: оставленная открытой запись пережила бы процесс.
 */
export async function nodeCreate(client: DriverClient, spec: CreateSpec): Promise<string> {
    const parentUuid = await resolveNode(client, spec.parent);
    await client.editor.scene.beginRecording(parentUuid);
    try {
        const created = await client.editor.scene.createNode({
            parent: parentUuid, name: spec.name
        }) as string;
        for (const type of spec.components) {
            await client.editor.scene.createComponent({ uuid: created, component: type });
        }
        if (spec.pos) {
            await client.editor.scene.setProperty({
                uuid: created,
                path: 'position',
                dump: { type: 'cc.Vec3', value: { x: spec.pos[0], y: spec.pos[1], z: spec.pos[2] } }
            });
        }
        await client.editor.scene.endRecording(parentUuid);
        return `ok  создан ${spec.parent}/${spec.name}`
            + (spec.components.length ? `  [${spec.components.join(',')}]` : '')
            + '  undo=1';
    } catch (error) {
        await client.editor.scene.cancelRecording();
        throw error;
    }
}

export function registerNode(program: Command, resolve: () => Promise<Resolved>): void {
    const node = program.command('node').description('узлы открытой сцены');

    const withClient = async (run: (client: DriverClient) => Promise<string>) => {
        const resolved = await resolve();
        if (!resolved.ok) {
            process.stderr.write(resolved.message + '\n');
            process.exitCode = EXIT.NO_EDITOR;
            return;
        }
        try {
            process.stdout.write(await run(resolved.client) + '\n');
        } catch (error: any) {
            process.stderr.write(String(error?.message || error) + '\n');
            process.exitCode = EXIT.FAILED;
        } finally {
            resolved.client.close();
        }
    };

    node
        .command('get <path>')
        .description('имя, состояние и компоненты узла')
        .action((target: string) => withClient(client => nodeGet(client, target)));

    node
        .command('create')
        .description('создать узел, навесить компоненты и поставить позицию одним шагом undo')
        .requiredOption('--parent <path>', 'родительский узел')
        .requiredOption('--name <name>', 'имя нового узла')
        .option('--component <type...>', 'компоненты, которые навесить', [])
        .option('--pos <x,y,z>', 'позиция')
        .action((options: { parent: string; name: string; component: string[]; pos?: string }) =>
            withClient(client => nodeCreate(client, {
                parent: options.parent,
                name: options.name,
                components: options.component,
                pos: options.pos
                    ? options.pos.split(',').map(Number) as [number, number, number]
                    : undefined
            })));

    node
        .command('rm <path>')
        .description('удалить узел')
        .action((target: string) => withClient(async client => {
            const uuid = await resolveNode(client, target);
            await client.editor.scene.removeNode({ uuid });
            return `ok  удалён ${target}`;
        }));
}
```

- [ ] **Step 4: Подключить группу в cli/src/main.ts**

Добавить `import { registerNode } from './commands/node';` и рядом с `registerScene`:

```typescript
    registerNode(program, () => resolveClient(program.opts().project));
```

- [ ] **Step 5: Прогнать тест, убедиться что проходит**

Run: `npm run build && npm run test:only --workspace cli`
Expected: PASS, 7 новых тестов

- [ ] **Step 6: Живая проверка одного Ctrl+Z**

```bash
cocos node create --project CyberCore --parent Environment --name PlanCrate --component MeshRenderer --pos 0,1,0
cocos node get --project CyberCore Environment/PlanCrate
```

Затем в редакторе нажать Ctrl+Z **один раз** и повторить `cocos node get` — узла быть не должно.
Если узел остался, значит структурная запись редактора в скобку не вложилась; записать
наблюдение в §13 спеки и завести отдельную задачу.

- [ ] **Step 7: Коммит**

```bash
git add cli/src/commands/node.ts cli/src/main.ts cli/test/commands-node.test.mjs
git commit -m "команды node: адресация путём, создание с компонентами в одной скобке undo"
```

---

## Task 13: Команды группы component и отчёт о записи

**Files:**
- Create: `cli/src/commands/component.ts`, `cli/src/render/report.ts`
- Modify: `cli/src/main.ts`
- Test: `cli/test/render-report.test.mjs`, `cli/test/commands-component.test.mjs`

**Interfaces:**
- Consumes: `resolveNode` (Task 12); `WriteReport` из `@cocos-cli/shared` — уже объявлен в
  контракте сцены как `{ written, verified, persisted: boolean | null, channel?: 'editor' | 'live',
  prefabOverride?, detail? }`, переобъявлять его нельзя
- Produces: `interface RenderedWrite { component: string; property: string; value?: unknown;
  report: WriteReport; undoNote?: string }`, `renderWriteReport(write: RenderedWrite): string`,
  `registerComponent(program: Command, resolve: () => Promise<Resolved>): void`,
  `componentSet(client: DriverClient, spec: SetSpec): Promise<string>`, где
  `interface SetSpec { node: string; component: string; property: string; value: unknown }`

- [ ] **Step 1: Написать падающий тест на рендер отчёта**

`cli/test/render-report.test.mjs`:

```javascript
/**
 * Отчёт о записи — единственное, что агент узнаёт про судьбу значения. Трёхзначность persisted
 * обязана дожить до текста: null означает, что никто не смотрел, и путать его с false нельзя.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderWriteReport } from '../lib/render/report.js';

const write = (report = {}, over = {}) => ({
    component: 'Sprite',
    property: 'color',
    report: { written: true, verified: true, persisted: true, channel: 'editor', ...report },
    ...over
});

test('удачная проверенная запись — одна строка с ok', () => {
    const text = renderWriteReport(write({}, { value: '#ffffff' }));
    assert.match(text, /^ok/);
    assert.match(text, /Sprite\.color/);
    assert.match(text, /persisted=true/);
});

test('persisted=null печатается как unknown, а не как false', () => {
    const text = renderWriteReport(write({ persisted: null }));
    assert.match(text, /persisted=unknown/);
    assert.doesNotMatch(text, /persisted=false/);
});

test('persisted=false на канале editor — это потеря значения при сохранении', () => {
    const text = renderWriteReport(write({ persisted: false, channel: 'editor' }));
    assert.match(text, /persisted=false/);
    assert.match(text, /editor/);
});

test('persisted=false на канале live — ожидаемое состояние, а не дефект', () => {
    const text = renderWriteReport(write({ persisted: false, channel: 'live' }));
    assert.match(text, /live/);
    assert.match(text, /ожид|норм/i);
});

test('канал, которого отчёт не назвал, печатается как unknown', () => {
    const text = renderWriteReport(write({ channel: undefined }));
    assert.match(text, /channel=unknown/);
});

test('незаписанное значение не выдаётся за ok', () => {
    const text = renderWriteReport(write({ written: false, verified: false, persisted: null }));
    assert.doesNotMatch(text, /^ok/);
});

test('detail из отчёта доезжает до строки', () => {
    const text = renderWriteReport(write({ detail: 'сериализатор не отдаёт это свойство' }));
    assert.match(text, /сериализатор не отдаёт/);
});

test('отметка про undo попадает в строку, когда редактор не записал шаг', () => {
    const text = renderWriteReport(write({}, { undoNote: 'редактор оставил скобку открытой' }));
    assert.match(text, /скобку открытой/);
});
```

- [ ] **Step 2: Прогнать тест, убедиться что падает**

Run: `npm run build --workspace cli && npm run test:only --workspace cli`
Expected: FAIL — `Cannot find module '../lib/render/report.js'`

- [ ] **Step 3: Написать cli/src/render/report.ts**

```typescript
import type { WriteReport } from '@cocos-cli/shared';

export interface RenderedWrite {
    component: string;
    property: string;
    value?: unknown;
    report: WriteReport;
    undoNote?: string;
}

/**
 * `persisted: null` означает, что сохранение никто не проверял. Печатать его как `false` —
 * значит выдать непроверенное за опровергнутое. `channel` в контракте необязателен, и его
 * отсутствие тоже unknown: без канала неизвестно, что означает `persisted: false`.
 */
export function renderWriteReport(write: RenderedWrite): string {
    const { report } = write;
    const head = report.written && report.verified ? 'ok' : 'НЕ ЗАПИСАНО';
    const persisted = report.persisted === null ? 'unknown' : String(report.persisted);
    const target = `${write.component}.${write.property}`;
    const value = write.value === undefined ? '' : ` = ${JSON.stringify(write.value)}`;

    const parts = [
        `${head}  ${target}${value}`,
        report.verified ? 'verified' : 'unverified',
        `persisted=${persisted}`,
        `channel=${report.channel || 'unknown'}`
    ];

    if (report.persisted === false && report.channel === 'live') {
        parts.push('(для live это ожидаемо: канал ничего не сериализует)');
    }
    if (report.prefabOverride) parts.push(`override на ${report.prefabOverride.targetPath}`);
    if (report.detail) parts.push(report.detail);
    if (write.undoNote) parts.push(write.undoNote);

    return parts.join('  ');
}
```

- [ ] **Step 4: Написать падающий тест на команду**

`cli/test/commands-component.test.mjs`:

```javascript
/**
 * Запись свойства против поддельного драйвера. Проверяется, что скобка undo охватывает запись,
 * что отказ поднимается словами, и что результат приходит строкой отчёта.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { componentSet } from '../lib/commands/component.js';

const recorder = (over = {}) => {
    const calls = [];
    return {
        calls,
        editor: {
            scene: {
                beginRecording: async () => { calls.push(['beginRecording']); return 'r1'; },
                endRecording: async () => { calls.push(['endRecording']); },
                cancelRecording: async () => { calls.push(['cancelRecording']); },
                setProperty: async (...a) => { calls.push(['setProperty', ...a]); return true; },
                ...over.scene
            }
        },
        scene: {
            call: async (method, ...a) => {
                calls.push([method, ...a]);
                if (method === 'resolveNodePaths') {
                    return { success: true, data: { resolutions: { 'Canvas/Bg': { uuid: 'u_bg' } } } };
                }
                if (method === 'getNodeInfo') {
                    return { success: true, data: { name: 'Bg', uuid: 'u_bg', active: true,
                        components: [{ type: 'Sprite', uuid: 'c1', enabled: true }] } };
                }
                if (method === 'serializedComponentValue') {
                    return { success: true, data: { found: true, value: '#ffffff' } };
                }
                return { success: true, data: {} };
            }
        }
    };
};

test('запись обёрнута в скобку undo', async () => {
    const driver = recorder();
    await componentSet(driver, { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ffffff' });
    const names = driver.calls.map(c => c[0]);
    assert.ok(names.indexOf('beginRecording') < names.indexOf('setProperty'));
    assert.equal(names[names.length - 1], 'endRecording');
});

test('результат приходит строкой отчёта, а не сырым объектом', async () => {
    const text = await componentSet(recorder(),
        { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#ffffff' });
    assert.equal(typeof text, 'string');
    assert.match(text, /Sprite\.color/);
    assert.match(text, /persisted=/);
});

test('узел без запрошенного компонента — отказ, называющий, что там есть', async () => {
    await assert.rejects(
        () => componentSet(recorder(),
            { node: 'Canvas/Bg', component: 'Label', property: 'string', value: 'hi' }),
        /Sprite/);
});

test('провал записи снимает скобку', async () => {
    const driver = recorder({ scene: { setProperty: async () => { throw new Error('отказ редактора'); } } });
    await assert.rejects(
        () => componentSet(driver,
            { node: 'Canvas/Bg', component: 'Sprite', property: 'color', value: '#fff' }),
        /отказ редактора/);
    assert.ok(driver.calls.map(c => c[0]).includes('cancelRecording'));
});
```

- [ ] **Step 5: Написать cli/src/commands/component.ts**

```typescript
import { Command } from 'commander';
import { EXIT } from '../exit';
import { renderWriteReport } from '../render/report';
import { resolveNode } from './node';
import type { DriverClient } from '../driver-client';
import type { Resolved } from '../resolve';

export interface SetSpec {
    node: string;
    component: string;
    property: string;
    value: unknown;
}

interface ComponentInfo { type: string; uuid: string; enabled: boolean }

async function findComponent(
    client: DriverClient, nodeUuid: string, type: string
): Promise<ComponentInfo> {
    const answer = await client.scene.call('getNodeInfo', nodeUuid) as
        { success: boolean; data?: { components?: ComponentInfo[] }; error?: string };
    if (!answer || answer.success !== true || !answer.data) {
        throw new Error(answer?.error || `узел ${nodeUuid} не прочитан`);
    }
    const components = answer.data.components || [];
    const found = components.find(component => component.type === type);
    if (found) return found;
    throw new Error(
        `на узле нет компонента '${type}'; есть: ${components.map(c => c.type).join(', ') || '(ни одного)'}`);
}

export async function componentSet(client: DriverClient, spec: SetSpec): Promise<string> {
    const nodeUuid = await resolveNode(client, spec.node);
    const component = await findComponent(client, nodeUuid, spec.component);

    await client.editor.scene.beginRecording(nodeUuid);
    let written = false;
    try {
        written = await client.editor.scene.setProperty({
            uuid: nodeUuid,
            path: `__comps__.${component.uuid}.${spec.property}`,
            dump: { value: spec.value }
        }) as boolean;
        await client.editor.scene.endRecording(nodeUuid);
    } catch (error) {
        await client.editor.scene.cancelRecording();
        throw error;
    }

    const serialized = await client.scene.call(
        'serializedComponentValue', nodeUuid, component.uuid, spec.property) as
        { success: boolean; data?: { found: boolean; value?: unknown; unnamedReference?: boolean } };

    const persisted = !serialized || serialized.success !== true || !serialized.data?.found
        ? null
        : serialized.data.unnamedReference
            ? null
            : JSON.stringify(serialized.data.value) === JSON.stringify(spec.value);

    return renderWriteReport({
        component: spec.component,
        property: spec.property,
        value: spec.value,
        report: {
            written,
            verified: persisted !== null,
            persisted,
            channel: 'editor',
            detail: persisted === null
                ? 'сериализатор не подтвердил значение, вывод о сохранении не делается'
                : undefined
        }
    });
}

export function registerComponent(program: Command, resolve: () => Promise<Resolved>): void {
    const component = program.command('component').description('компоненты на узлах');

    const withClient = async (run: (client: DriverClient) => Promise<string>) => {
        const resolved = await resolve();
        if (!resolved.ok) {
            process.stderr.write(resolved.message + '\n');
            process.exitCode = EXIT.NO_EDITOR;
            return;
        }
        try {
            process.stdout.write(await run(resolved.client) + '\n');
        } catch (error: any) {
            process.stderr.write(String(error?.message || error) + '\n');
            process.exitCode = EXIT.FAILED;
        } finally {
            resolved.client.close();
        }
    };

    component
        .command('add <path> <type>')
        .description('навесить компонент на узел')
        .action((target: string, type: string) => withClient(async client => {
            const uuid = await resolveNode(client, target);
            await client.editor.scene.createComponent({ uuid, component: type });
            return `ok  ${type} навешен на ${target}`;
        }));

    component
        .command('rm <path> <type>')
        .description('снять компонент с узла')
        .action((target: string, type: string) => withClient(async client => {
            const uuid = await resolveNode(client, target);
            const found = await findComponent(client, uuid, type);
            await client.editor.scene.removeComponent({ uuid, component: found.uuid });
            return `ok  ${type} снят с ${target}`;
        }));

    component
        .command('set <path> <type>')
        .description('записать свойство компонента и проверить, переживёт ли запись сохранение')
        .requiredOption('--prop <name>', 'имя свойства')
        .requiredOption('--value <json>', 'значение; JSON, либо строка как есть')
        .action((target: string, type: string, options: { prop: string; value: string }) =>
            withClient(client => {
                let value: unknown = options.value;
                try { value = JSON.parse(options.value); } catch { }
                return componentSet(client,
                    { node: target, component: type, property: options.prop, value });
            }));
}
```

- [ ] **Step 6: Подключить группу в cli/src/main.ts**

Добавить `import { registerComponent } from './commands/component';` и рядом с остальными:

```typescript
    registerComponent(program, () => resolveClient(program.opts().project));
```

- [ ] **Step 7: Прогнать тесты, убедиться что проходят**

Run: `npm run build && npm test`
Expected: PASS, 11 новых тестов (8 на отчёт + 3 на команду)

- [ ] **Step 8: Живая проверка записи и сохранения**

```bash
cocos component set --project CyberCore "Canvas/Bg" Sprite --prop color --value '{"r":255,"g":0,"b":0,"a":255}'
cocos scene save --project CyberCore
```

Expected: строка вида `ok  Sprite.color = ...  verified  persisted=true  channel=editor`.
Затем Ctrl+Z в редакторе один раз возвращает прежний цвет.

- [ ] **Step 9: Коммит**

```bash
git add cli/src/commands/component.ts cli/src/render/report.ts cli/src/main.ts cli/test/render-report.test.mjs cli/test/commands-component.test.mjs
git commit -m "команды component: add, rm, set с проверкой записи и трёхзначным persisted"
```

---

## Task 14: Переписать CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: всё построенное выше
- Produces: документ, описывающий действующую архитектуру

- [ ] **Step 1: Заменить раздел Architecture**

```markdown
## Architecture

Четыре контекста исполнения:

    агент
      │ shell — единственный интерфейс
    CLI                   cli/src/          вся логика: команды, оркестрация, undo, рендер
      │ JSON-RPC по именованному каналу
    драйвер               driver/src/       87 нативных примитивов, логики не содержит
      ├ editor.*          58 методов поверх Editor.Message
      └ scene.*           29 методов поверх scene-скрипта
    scene script          driver/src/scene/ единственное место, где живёт cc.*

`shared/` держит типы и чистую логику, нужную обеим сторонам: контракт сцены, список 87 методов,
форму рукопожатия, имя канала, разбор путей узлов, сравнение сериализованных значений.

**Ключевое ограничение:** `cc.*` существует только в контексте scene-скрипта. Всё, что их
требует, идёт через `scene.*`, никогда через `editor.*`.
```

- [ ] **Step 2: Заменить раздел Build Commands**

```markdown
## Build Commands

    npm install          зависимости всех трёх пакетов
    npm run build        собрать shared, driver, cli
    npm test             собрать и прогнать тесты
    npm link --workspace cli   поставить бинарь `cocos` на PATH
```

- [ ] **Step 3: Заменить процедуру чекпоинта**

```markdown
## Checkpoint Procedure

Правка в `cli/` проверяется так:

1. `npm test`
2. `npm run build --workspace cli`
3. Прогнать затронутые команды на живом редакторе, прочитать ответ.

Правка в `driver/` требует лишнего шага — **выключить и включить расширение руками** в
Extension Manager. Ничто другое не сбрасывает require-кэш Node. Драйвер меняется только когда
нужен новый примитив движка.

Правка пути записи считается проверенной после сохранения сцены и одного Ctrl+Z.
```

- [ ] **Step 4: Заменить таблицу ключевых файлов**

```markdown
| Файл | Роль |
|------|------|
| `shared/src/protocol.ts` | список 87 методов — граница драйвера; форма рукопожатия |
| `shared/src/pipe-name.ts` | путь проекта → путь канала, одинаково у обеих сторон |
| `shared/src/scene-contract.ts` | `SceneMethods` — типизированный контракт со scene-скриптом |
| `driver/src/main.ts` | точка входа расширения: `load`/`unload` |
| `driver/src/pipe-server.ts` | сервер канала, очередь на один запрос, снятие скобки при обрыве |
| `driver/src/method-table.ts` | резолвер имени в функцию; вся валидация драйвера |
| `driver/src/editor-api.ts` | каждый вызов `Editor.Message`, типизированный |
| `driver/src/scene/` | scene-скрипт; `index.ts` собирает `SceneMethods` |
| `cli/src/main.ts` | дерево команд, коды выхода |
| `cli/src/discovery.ts` | перечисление каналов, рукопожатие, выбор инстанса |
| `cli/src/driver-client.ts` | фасады `editor` и `scene` поверх JSON-RPC |
| `cli/src/render/` | дерево и отчёт о записи — то, что видит агент |
```

- [ ] **Step 5: Удалить разделы про MCP**

Убрать `Response Envelope` в части про `isError` и MCP-транспорт, `HTTP Endpoints` целиком,
`Adding a Tool` заменить на `Adding a Command`, `Settings` сократить до `enableDebugLog`.

- [ ] **Step 6: Проверить, что документ не врёт**

Run: `grep -n "MCP\|/mcp\|порт\|port\|4000\|tools/list\|preview-log" CLAUDE.md`
Expected: ни одного упоминания, кроме исторической ссылки на спеку

- [ ] **Step 7: Коммит**

```bash
git add CLAUDE.md
git commit -m "CLAUDE.md описывает CLI поверх канала вместо MCP-моста"
```

---

## Что остаётся второму плану

- Группы команд: `prefab`, `asset`, `build`, `project`, `log`, `ecs`, `socket`, `raw` (evalInScene).
- Переезд чистых модулей `prefab-json`, `prefab-value`, `prefab-linkage`, `reference-scan`,
  `reference-projection`, `batch-plan`, `build-task`, `asset-query`, `asset-json`, `project-log`,
  `log-search`, `ecs-census`, `missing-scripts` из `source/` в `cli/src/` вместе с тестами.
- Режим `--stdin`: команда на строку, `shell-quote`, JSONL на выход, одна скобка на поток.
- Completion через `@pnpm/tabtab`.
- Флаги `--json`, `--quiet` на всех командах.
- Сравнение `surfaceChecksum` при рукопожатии и отказ при рассинхроне версий.
- Удаление каталога `source/` целиком.
