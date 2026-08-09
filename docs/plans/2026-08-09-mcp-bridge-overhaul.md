# MCP Bridge Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Упаковать текущий функционал моста (спека `docs/specs/2026-08-09-mcp-bridge-overhaul-design.md`) в каркас на официальном MCP SDK: 192 тулзы → ~80, ноль switch-ей по имени, один формат ответа, один словарь верификации.

**Architecture:** Четыре слоя (транспорт SDK → реестр → тулзы-значения → шлюзы EditorApi/SceneScriptClient), конструкторная инъекция из composition root в `main.ts`. Легаси-категории живут за адаптером и выпиливаются по одной; каждая фаза заканчивается живым смоуком в редакторе.

**Tech Stack:** TypeScript (tsc, без бандлера — сборка как сейчас), `@modelcontextprotocol/sdk`, `zod` + `zod-to-json-schema`, `p-wait-for@^3` (CJS), `p-queue@^6` (CJS), `node --test` над `dist/`.

## Global Constraints

- Node внутри редактора: 20.14 (Electron 31.3.1). Компиляция остаётся tsc → `dist/`; версии зависимостей — CJS-совместимые (p-wait-for@3, p-queue@6; SDK и zod дают CJS сами).
- **Каждый тест пишется только после загрузки скилла `/writing-unit-tests`. Сабагенту это вписывается в бриф явно.** Тестируется поведение снаружи модуля; тесты на приватные структуры не пишутся.
- **Каждый код-комментарий — только после загрузки `/writing-code-comments`.** Дефолт — не писать.
- Слой шлюзов и engine-половина юнит-тестами не покрываются — их проверяет живой редактор на чекпоинтах.
- Дефолтный порт один: **4000**, живёт только в `source/settings.ts`.
- Имена/схемы тулз — по спеке §6; ничего сверх инвентаря спеки не добавлять.
- Перезагрузка расширения = ручной тоггл OFF/ON в редакторе → чекпоинты требуют пользователя; между чекпоинтами живых проверок не планировать.
- Коммиты в репо форка, сообщения по-русски, по образцу истории (`git log --oneline`).
- Чистые модули не трогать (кроме явно указанных задач): `node-path`, `prefab-json`, `prefab-value`, `prefab-linkage`, `reference-projection`, `serialized-diff`, `scene-signature`, `tool-args`, `json-arg`, `log-search`, `project-log`, `preview-log-store`, `ecs-census`, `batch-plan` и их тесты.

---

## Фаза 1 — Снос

### Task 1: Снос категорий-балласта

**Files:**
- Delete: `source/tools/reference-image-tools.ts`, `source/tools/preferences-tools.ts`, `source/tools/server-tools.ts`, `source/tools/broadcast-tools.ts`, `source/tools/validation-tools.ts`, `source/tools/scene-view-tools.ts`
- Modify: `source/tool-registry.ts` (убрать 6 категорий из `createToolInstances`), `source/types/index.ts` (убрать их типы, если объявлены)
- Test: `test/tool-registry.test.mjs` (ожидания по списку категорий)

**Interfaces:**
- Produces: `createToolInstances()` возвращает 11 категорий: `scene, node, component, prefab, project, debug, preferences→нет, …` — точный остаток: `scene, node, component, prefab, project, assetAdvanced, sceneAdvanced, skeletalAnimation, debug, ecs, batch`.

- [ ] **Step 1:** Удалить шесть файлов, убрать их импорты и записи из `createToolInstances` в `source/tool-registry.ts`.
- [ ] **Step 2:** Поправить `test/tool-registry.test.mjs`: список категорий = 11 оставшихся.
- [ ] **Step 3:** `npm run build && npm test` — зелёно.
- [ ] **Step 4:** Commit: `Снос категорий-балласта: broadcast, preferences, referenceImage, sceneView, server, validation`.

### Task 2: Снос поштучных стабов и дублей

**Files:**
- Modify: `source/tools/scene-advanced-tools.ts`, `source/tools/scene-tools.ts`, `source/tools/node-tools.ts`, `source/tools/debug-tools.ts`, `source/tools/component-tools.ts`, `source/tools/prefab-tools.ts`, `source/tools/asset-advanced-tools.ts`, `source/tools/project-tools.ts`
- Test: `test/tool-schema-contract.test.mjs` (перечисления имён, если есть)

Каждое удаление = запись в `getTools()` + `case` в `execute` + приватные методы, которые больше никто не зовёт.

- [ ] **Step 1:** Удалить по списку (причины — спека §6):
  - scene-advanced: `restore_prefab`, `execute_scene_script`, `query_component_has_script`, `scene_snapshot`, `scene_snapshot_abort`
  - scene: `get_scene_hierarchy`, `save_scene_as`
  - node: `get_all_nodes`, `detect_node_type` (вердикт переедет в `get_node_info` в Task 13)
  - debug: `get_node_tree`, `get_console_logs`, `clear_console`, `get_project_logs`, `get_log_file_info`
  - component: `get_available_components`
  - prefab: `get_prefab_info`, `load_prefab`, `duplicate_prefab`
  - assetAdvanced: `get_asset_dependencies`, `get_unused_assets`, `compress_textures`, `export_asset_manifest`, `open_asset_external`, `batch_import_assets`, `batch_delete_assets`, `validate_asset_references` (честная версия появится в Task 21)
  - project: `start_preview_server`, `stop_preview_server` (и убрать ссылку на них из сообщения `run_project`, project-tools.ts:557)
- [ ] **Step 2:** `npm run build && npm test`; упавшие ожидания по удалённым именам — поправить.
- [ ] **Step 3:** Commit: `Снос стабов и дублей: 25 тулз по спеке §6`.

### Task 3: Снос мёртвого кода

**Files:**
- Modify: `source/tools/prefab-tools.ts` (~852–2538 и 2562–3037 — три брошенных сериализатора со свитой: `createPrefabWithAssetDB`, `createPrefabCustom`, `createStandardPrefabData`, `createComponentObject`, `processComponentProperty`, `createEngineStandardNode`, `addSpriteProperties`, `uuidToCompressedId`, `convertNodeToPrefabInstance`, self-fetch на `localhost:8585`), `source/main.ts` (`getFilteredToolsList`, `getSettings` — их нет в `contributions.messages`), `source/tools/node-tools.ts:942` (фолбэк на несуществующий scene-метод `findNodes`), `source/scene.ts` (`createPrefabFromNode` — возвращает успех, ничего не создавая; реальный — `createPrefabFromNode2`), `package.json` (`contributions.scene.methods` — привести к фактическим экспортам или убрать список)
- Modify: `CLAUDE.md` форка (убрать шаг «поддерживать список scene-методов»)

- [ ] **Step 1:** Удалить перечисленное; `prefab_restore_prefab_node` (живой) при этом сохранить.
- [ ] **Step 2:** `npm run build && npm test` — зелёно; `git grep -n "8585"` — ноль вхождений.
- [ ] **Step 3:** Commit: `Снос мёртвого кода: ~1900 строк prefab-tools, ложный createPrefabFromNode, недостижимые IPC-методы`.

### Task 4: Панель → статус, конфигурации долой

**Files:**
- Delete: `source/tools/tool-manager.ts`
- Modify: `source/settings.ts` (остаются `{port, autoStart, enableDebugLog, maxConnections}`; типы конфигураций удалить), `source/types/index.ts` (`ToolConfig`, `ToolConfiguration`, `ToolManagerSettings` удалить), `source/main.ts` (IPC панели: остаются get-server-status/start/stop/update-settings; убрать всё про конфигурации; **баг main.ts:37–44 умирает вместе с `enabledTools`** — сервер всегда отдаёт все тулзы), `source/mcp-server.ts` (убрать фильтр enabledTools), `source/panels/default/index.ts` + `static/` (панель показывает порт и статус, кнопки start/stop; тогглы/слоты/импорт-экспорт удалить), `package.json` (`contributions.messages` синхронизировать)

- [ ] **Step 1:** Удалить машинерию, панель свести к статусу.
- [ ] **Step 2:** `npm run build && npm test`.
- [ ] **Step 3:** Commit: `Панель показывает статус; конфигурации тулз удалены, все тулзы всегда включены`.

### ✋ CHECKPOINT A (пользователь)

Открыть thuglife в Cocos, тоггл расширения OFF/ON. Смоук: `tools/list` (через клиента — количество ≈115), `scene_dump`, `component_get_components` на любой ноде, `debug_execute_script` `1+1`. Ничего из живого не отвалилось → фаза 2.

---

## Фаза 2 — Каркас + пилот

### Task 5: Зависимости и единый порт

**Files:**
- Modify: `package.json` (deps: `@modelcontextprotocol/sdk`, `zod`, `zod-to-json-schema`, `p-wait-for@^3.2.0`, `p-queue@^6.6.2`), `source/settings.ts` (единственная константа `DEFAULT_PORT = 4000`), `source/tools/debug-tools.ts:410-412` (порт из settings)

- [ ] **Step 1:** `npm install` перечисленного; `git grep -nE "3000|8585"` в `source/` — заменить на импорт из settings (в panel — тоже).
- [ ] **Step 2:** `npm run build && npm test`.
- [ ] **Step 3:** Commit: `Зависимости каркаса; дефолтный порт один — 4000 в settings`.

### Task 6: ToolResult — ok/fail

**Files:**
- Create: `source/result.ts`
- Test: `test/result.test.mjs`

**Interfaces:**
- Produces: `ok<T>(data: T, message?: string): ToolOk<T>`, `fail(code: string, message: string, hint?: string): ToolFail`, `type ToolResult<T> = ToolOk<T> | ToolFail`, type guard `isOk(r): r is ToolOk`.

- [ ] **Step 1:** Загрузить `/writing-unit-tests`; тест: `ok` несёт data и message на верхнем уровне; `fail` несёт `{code, message, hint}` и `success:false`; `isOk` различает.
- [ ] **Step 2:** `npm test` — FAIL (модуля нет).
- [ ] **Step 3:**

```ts
// source/result.ts
export interface ToolOk<T = unknown> { success: true; data: T; message?: string }
export interface ToolFail { success: false; error: { code: string; message: string; hint?: string } }
export type ToolResult<T = unknown> = ToolOk<T> | ToolFail;

export function ok<T>(data: T, message?: string): ToolOk<T> {
    return message === undefined ? { success: true, data } : { success: true, data, message };
}
export function fail(code: string, message: string, hint?: string): ToolFail {
    return { success: false, error: hint === undefined ? { code, message } : { code, message, hint } };
}
export function isOk<T>(result: ToolResult<T>): result is ToolOk<T> {
    return result.success;
}
```

- [ ] **Step 4:** `npm test` — PASS. Commit: `ok/fail — единый конверт ответа`.

### Task 7: settle

**Files:**
- Create: `source/settle.ts`
- Test: `test/settle.test.mjs`

**Interfaces:**
- Produces: `settle(predicate: () => Promise<boolean> | boolean, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<boolean>` — `true` когда предикат дал true, `false` по таймауту (не бросает). Дефолты: timeoutMs 2000, intervalMs 50.

- [ ] **Step 1:** `/writing-unit-tests`; тесты: предикат сразу true → true; предикат true со 2-го опроса → true; всегда false → false после ~timeoutMs.
- [ ] **Step 2:** FAIL →

```ts
// source/settle.ts
import pWaitFor from 'p-wait-for';

export async function settle(
    predicate: () => Promise<boolean> | boolean,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
    try {
        await pWaitFor(predicate, { timeout: opts.timeoutMs ?? 2000, interval: opts.intervalMs ?? 50 });
        return true;
    } catch {
        return false;
    }
}
```

- [ ] **Step 3:** PASS. Commit: `settle: поллинг с таймаутом вместо магических слипов`.

### Task 8: EditorApi

**Files:**
- Create: `source/editor-api.ts`
- Test: нет (шлюз — живой чекпоинт)

**Interfaces:**
- Produces:

```ts
// source/editor-api.ts
export class EditorRequestError extends Error { constructor(readonly pkg: string, readonly msg: string, cause: unknown) }
export class EditorApi {
    // единственное место с Editor.Message.request; каждый метод типизирован
    scene: {
        querySceneReady(): Promise<boolean>;
        queryDirty(): Promise<boolean>;
        openScene(uuid: string): Promise<void>;
        saveScene(): Promise<void>;
        closeScene(): Promise<void>;
        executeSceneScript(payload: { name: string; method: string; args: unknown[] }): Promise<unknown>;
        beginRecording(uuids: string[]): Promise<string>;   // undoId
        endRecording(undoId: string): Promise<void>;
        cancelRecording(undoId: string): Promise<void>;
    };
    assetDb: {
        queryAssetInfo(uuidOrUrl: string): Promise<AssetInfo | null>;
        queryUuid(url: string): Promise<string | null>;
        queryPath(uuidOrUrl: string): Promise<string | null>; // абсолютный дисковый путь
        queryAssets(pattern: string): Promise<AssetInfo[]>;
        createAsset(url: string, content: string | null, opts: { overwrite: boolean; rename: boolean }): Promise<AssetInfo>;
        refreshAsset(url: string): Promise<void>;
        // …растёт по мере переноса категорий; метод добавляется В ЗАДАЧЕ категории
    };
}
```

Внутри — один приватный `request<T>(pkg, msg, ...args)`: `Editor.Message.request` + маппинг отказа в `EditorRequestError`. 121 ручная промис-обёртка в переносимых категориях заменяется вызовами этих методов.

- [ ] **Step 1:** Реализовать; `npm run build && npm test`.
- [ ] **Step 2:** Commit: `EditorApi: одно место с Editor.Message.request`.

### Task 9: scene-contract + SceneScriptClient + распил scene.ts

**Files:**
- Create: `source/scene-contract.ts` (интерфейс `SceneMethods` + типы `SceneDump`, `WriteReport`, `NodePropertyWrite`, `DumpOptions` — сигнатуры снять с фактических методов `source/scene.ts`), `source/scene-script-client.ts`, `source/scene/` (распил `scene.ts` по концернам: `dump.ts`, `node-ops.ts`, `component-ops.ts`, `property-write.ts`, `prefab-ops.ts`, `query.ts`, `index.ts` — `index.ts` собирает `const methods: SceneMethods` и `module.exports.methods = methods`)
- Delete: `source/scene.ts` (после распила)
- Modify: `package.json` (`contributions.scene.script` указывает на новый скомпилированный путь)

**Interfaces:**
- Produces: `SceneScriptClient` (конструктор принимает `EditorApi`): `call<K extends keyof SceneMethods>(method: K, ...args: Parameters<SceneMethods[K]>): Promise<Awaited<ReturnType<SceneMethods[K]>>>` — внутри `editorApi.scene.executeSceneScript({name: 'cocos-mcp-server', method, args})`.

```ts
// source/scene-contract.ts (ядро WriteReport — по спеке §4)
export interface WriteReport {
    written: boolean;
    verified: boolean;
    persisted: boolean;
    prefabOverride?: { targetPath: string };
    detail?: string;
}
```

- [ ] **Step 1:** Снять фактические сигнатуры 34 экспортируемых методов `scene.ts`, записать `SceneMethods`; распилить файл по концернам БЕЗ изменения поведения (переезд функций как есть); `index.ts` типизирован `SceneMethods` — tsc ловит пропуск.
- [ ] **Step 2:** Fire-and-forget ветки `setComponentProperty` (бывш. scene.ts:937–975: колбэчная загрузка ассета, присвоение строки-uuid при ошибке, `mesh`-ветка с одним warn) переписать на `await` + честный `WriteReport` (`written:false` при провале загрузки).
- [ ] **Step 3:** `npm run build && npm test`. Commit: `Engine-половина: контракт SceneMethods, распил по концернам, awaited-записи`.

### Task 10: ToolContext + defineTool + ToolRegistry + легаси-адаптер

**Files:**
- Create: `source/context.ts`, `source/tool.ts`, `source/registry.ts`, `source/legacy-adapter.ts`
- Test: `test/registry.test.mjs`

**Interfaces:**
- Consumes: `ToolResult`/`ok`/`fail` (Task 6); `EditorApi` (Task 8); `SceneScriptClient` (Task 9); `resolveNodePaths`/`augmentToolDefinition` из `source/node-path.ts`; `resolveToolArgs` из `source/tool-args.ts`.
- Produces:

```ts
// source/context.ts
export interface ToolContext {
    editor: EditorApi;
    sceneScript: SceneScriptClient;
    logs: PreviewLogStore;
    settings: McpSettings;
}
```

```ts
// source/tool.ts
import { z } from 'zod';
import type { ToolResult } from './result';
import type { ToolContext } from './context';

export interface RegisteredTool {
    name: string;
    description: string;
    inputSchema: object;                       // JSON Schema для tools/list
    invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<S extends z.ZodRawShape>(def: {
    name: string;
    description: string;
    schema: z.ZodObject<S>;
    aliases?: Record<string, string>;          // старое имя аргумента → новое
    handler(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolResult>;
}): RegisteredTool
```

`defineTool.invoke`: применить алиасы → `schema.safeParse` → при ошибке `fail('invalid_args', issues)` → handler. `inputSchema` = `zodToJsonSchema(schema)`.

```ts
// source/registry.ts
export class ToolRegistry {
    constructor(tools: RegisteredTool[]);      // бросает на дубликате имени
    list(): { name: string; description: string; inputSchema: object }[];
    invoke(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
    // invoke: неизвестное имя → fail('unknown_tool', …);
    // перед handler — резолв nodePath→uuid как сейчас в mcp-server.executeToolCall
}
```

```ts
// source/legacy-adapter.ts
export function legacyTools(category: string, executor: {
    getTools(): { name: string; description: string; inputSchema: object }[];
    execute(name: string, args: unknown): Promise<unknown>;
}): RegisteredTool[]
// каждый invoke: executor.execute → toToolResult():
//   {success:true,…} → ok(data, message); {success:false,…} → fail('legacy', error|message);
//   throw → fail('legacy_throw', err.message)
```

- [ ] **Step 1:** `/writing-unit-tests`; тесты registry: дубликат имени бросает; unknown → fail с code `unknown_tool`; defineTool: алиас применяется, невалидные args → fail `invalid_args`, валидные доходят до handler.
- [ ] **Step 2:** FAIL → реализация (zod-валидация, `zodToJsonSchema` из `zod-to-json-schema`).
- [ ] **Step 3:** PASS. Commit: `Каркас тулзы: контекст, defineTool, реестр, адаптер легаси-категорий`.

### Task 11: SDK-транспорт + composition root

**Files:**
- Create: `source/server.ts` (SDK `Server` + `StreamableHTTPServerTransport` поверх `node:http`; наши роуты `/preview-log` (POST, ingest в PreviewLogStore) и `/preview-console.js` переносятся из старого файла как есть)
- Modify: `source/main.ts` (composition root — единственное место с `new`: settings → EditorApi → SceneScriptClient → PreviewLogStore → ToolContext → ToolRegistry → BridgeServer), `source/preview-log-store.ts` (экспорт класса; модульный синглтон убрать, инстанс создаёт main), `source/tool-registry.ts` (сборка: легаси-категории через `legacyTools(...)`), `source/tools/batch-tools.ts` (диспетчер = `registry.invoke` вместо `mcp-server.executeToolCall`)
- Delete: `source/mcp-server.ts`
- Test: нет (транспорт — живой чекпоинт)

**Interfaces:**
- Consumes: `ToolRegistry`, `ToolContext` (Task 10).
- Produces: `class BridgeServer { constructor(registry: ToolRegistry, ctx: ToolContext, settings: McpSettings); start(): Promise<void>; stop(): Promise<void> }`. `CallToolRequest` → `registry.invoke` → `content:[{type:'text', text: JSON.stringify(result)}]`, `isError: !result.success`.

- [ ] **Step 1:** Реализовать `BridgeServer` низкоуровневым SDK `Server` (`setRequestHandler(ListToolsRequestSchema)` ← `registry.list()`, `CallToolRequestSchema` ← `registry.invoke`).
- [ ] **Step 2:** Все 11 категорий завести через `legacyTools`; старый `MCPServer` удалить.
- [ ] **Step 3:** `npm run build && npm test`. Commit: `Транспорт на @modelcontextprotocol/sdk; isError на протокольном уровне; composition root в main`.

### Task 12: Пилот — категория scene на новом каркасе

**Files:**
- Create: `source/tools-v2/scene.ts` (тулзы: `scene_dump`, `scene_open_scene`, `scene_save_scene`, `scene_close_scene`, `scene_create_scene`, `scene_get_current_scene`, `scene_get_scene_list`, `scene_checksum`, `scene_find_component_owners`, `scene_query_dirty`, `scene_query_ready`, `scene_soft_reload`, `scene_begin_undo_recording`, `scene_end_undo_recording`, `scene_cancel_undo_recording` — поведение портируется из `source/tools/scene-tools.ts` и `scene-advanced-tools.ts` соответственно)
- Modify: `source/tool-registry.ts` (scene-тулзы — из `tools-v2/scene`, легаси-классы `SceneTools` больше не регистрируются; sceneAdvanced-остаток пока легаси), `source/tools/scene-advanced-tools.ts` (убрать перенесённые undo/query/soft_reload)
- Delete: `source/tools/scene-tools.ts`

**Interfaces:**
- Consumes: `defineTool`, `ok/fail`, `ctx.editor.scene`, `ctx.sceneScript`.
- Produces: образец формы для всех последующих категорий. Пример полного тула:

```ts
export const sceneQueryDirty = defineTool({
    name: 'scene_query_dirty',
    description: 'Whether the open scene differs from its file on disk (serialized compare, not the undo flag).',
    schema: z.object({}),
    async handler(_args, ctx) {
        const dirty = await ctx.sceneScript.call('sceneDirtyAgainstDisk');
        return ok({ dirty });
    },
});
```

- [ ] **Step 1:** Портировать 15 тулз; у `scene_create_scene` описание честное (пустой шаблон без Canvas/камеры/света) и без пост-глоба `sceneVerified`; у `scene_close_scene` в description предупреждение про молчаливую потерю несохранённого.
- [ ] **Step 2:** `npm run build && npm test` (contract-тест реестра ловит коллизии имён).
- [ ] **Step 3:** Commit: `Пилот каркаса: категория scene на defineTool/EditorApi`.

### ✋ CHECKPOINT B (пользователь)

Тоггл OFF/ON. Смоук: `tools/list`; `scene_dump`; `scene_query_dirty`; `scene_checksum`; правка любого свойства легаси-тулзой `component_set_component_property` (легаси-путь жив); `batch_run` из двух вызовов. Протокол: клиент видит `isError` на заведомо неверном имени тулзы.

---

## Фаза 3 — Перенос ядра

Каждая задача: портировать категорию на `defineTool` + `ctx.editor`/`ctx.sceneScript` (методы EditorApi добавляются здесь же), слить по спеке §6, удалить легаси-класс, `npm run build && npm test`, commit. Поведенческие источники указаны как файл:строки текущего кода — переносить логику, заменяя обвязку.

### Task 13: node

**Files:**
- Create: `source/tools-v2/node.ts`
- Delete: `source/tools/node-tools.ts`
- Test: `test/node-type.test.mjs` (новый — единый список UI-типов)

Тулзы: `node_create_node` (absorbs `create_primitive` параметром `primitive`; цепочка sibling-index → components → transform с `settle` вместо слипов 100/100/150 мс, node-tools.ts:446–493; provисходный silent-continue заменить: неприменённый шаг = `fail`), `node_delete_node`, `node_duplicate_node`, `node_move_node` (поллинг уже правильный — сохранить), `node_find_nodes` (absorbs `find_node_by_name`: `exactMatch?: boolean`), `node_get_node_info` (+блок `nodeType`/`transformConstraints` из бывш. `detect_node_type`), `node_set_node_property`, `node_set_node_transform`, `node_list_builtin_meshes`, `node_copy_node`, `node_cut_node`, `node_paste_node` (порт из scene-advanced-tools).

- [ ] **Step 1:** `/writing-unit-tests`; создать `source/scene/node-type.ts`: один экспортируемый список UI-компонентов и `classifyNode(componentTypes: string[]): {nodeType: '2d'|'3d', reasons: string[]}` — чистая функция; тест: узел со `cc.ScrollView` классифицируется 2D и reasons это объясняют (сейчас вердикт и объяснение расходятся, node-tools.ts:1247 vs 1427).
- [ ] **Step 2:** `set_node_transform` и `get_node_info` используют `classifyNode` — три разъехавшихся списка (node-tools.ts:721, 1247, 1427) умирают.
- [ ] **Step 3:** Порт остальных тулз; build+test; Commit: `Категория node на каркасе; один классификатор 2D/3D`.

### Task 14: PropertyKind + ридеры (дамп)

**Files:**
- Create: `source/property/kind.ts`, `source/property/readers.ts`
- Test: `test/property-kind.test.mjs`

**Interfaces:**
- Produces:

```ts
export type PropertyKind = 'gradient' | 'curve' | 'classArray' | 'nestedClass'
    | 'assetRef' | 'nodeRef' | 'componentRef' | 'color' | 'vec' | 'enum' | 'plain';
export function resolveKind(descriptor: PropertyDescriptor): PropertyKind;
// descriptor = элемент дампа редактора: {type, isArray?, extends?, properties?, …}
export function projectValue(kind: PropertyKind, dumpValue: unknown): unknown;
```

Единственное место строковых сравнений `'cc.Vec3'`-типов — `resolveKind`. Замещает `buildTypedDump` (component-tools.ts:1919–2010, 18 if-ов) и `guessAssetTypeByName` (:2198).

- [ ] **Step 1:** `/writing-unit-tests`; тесты `resolveKind` на реальных дескрипторах (снять фикстуры с дампа: Vec3, Color, SpriteFrame-ссылка, Node-ссылка, компонент-ссылка, массив @ccclass, вложенный @ccclass, gradient/curve частицы — фикстуры положить в `test/fixtures/descriptors.json`).
- [ ] **Step 2:** FAIL → реализация → PASS.
- [ ] **Step 3:** Commit: `PropertyKind: один резолвер типов свойств, проекция дампа`.

### Task 15: Писатели + верификация + undo-скобки

**Files:**
- Create: `source/property/writers.ts` (реестр — один упорядоченный массив), `source/property/verified-write.ts`
- Test: `test/property-writers.test.mjs` (порядок и непересечение: для каждой фикстуры дескриптора ровно один писатель)

**Interfaces:**
- Consumes: `resolveKind`, `settle`, `ctx.editor.scene` (set-property, begin/end/cancelRecording), `ctx.sceneScript`, чистые `prefab-value`/`reference-projection`/`serialized-diff`.
- Produces:

```ts
export interface WriteTarget {
    nodeUuid: string; componentIndex: number; propertyPath: string;
    descriptor: PropertyDescriptor; prefabInstanceRoot?: string;
}
export interface PropertyWriter {
    readonly kind: PropertyKind;
    write(target: WriteTarget, value: unknown, ctx: ToolContext): Promise<WriteReport>;
}
export const WRITERS: readonly PropertyWriter[]; // порядок объявлен здесь и только здесь
export async function verifiedWrite(target: WriteTarget, value: unknown, ctx: ToolContext,
    opts?: { verify?: 'readback' | 'disk' }): Promise<WriteReport>;
```

`verifiedWrite`: `beginRecording([nodeUuid])` → writer → `settle`(read-back совпал) → `endRecording` (при throw — `cancelRecording`) → `WriteReport`. Канал live (только для того, до чего editor-канал не дотягивается) даёт `persisted:false`. `verify:'disk'` — текущий `sceneDirtyAgainstDisk`-механизм, опционально (сейчас он гоняется на каждую запись — component-tools.ts:1778).

Поведенческие источники: каскад component-tools.ts:989–1067 (порядок: gradient/curve → UITransform → classArray → classValue → asset → componentRef → typed — сохранить как порядок WRITERS), запись ссылок :375–414 (`set_component_ref` — эталон вердикта), два шага вложенных @ccclass (память `mcp-nested-ccclass-array-write`), прунинг оверрайдов перед read-back :404–405 (сохранить порядок: write → prune → read).

- [ ] **Step 1:** `/writing-unit-tests`; тест порядка/непересечения WRITERS по фикстурам Task 14.
- [ ] **Step 2:** Реализация писателей портом веток каскада; build+test.
- [ ] **Step 3:** Commit: `Цепочка писателей, verifiedWrite с undo-скобками и WriteReport`.

### Task 16: component

**Files:**
- Create: `source/tools-v2/component.ts`
- Delete: `source/tools/component-tools.ts`

Тулзы: `component_add_component` (absorbs `attach_script`: аргумент `db://…` → сверка по uuid скрипт-ассета из `properties.__scriptAsset.value.uuid`, двухпопыточное создание «по имени класса, затем — только если счётчик компонентов не вырос — по uuid» переносится дословно из component-tools.ts:2211–2286; settle 150/300 мс → `settle`), `component_remove_component` (поллинг уже правильный), `component_get_components` (фолбэк возвращает ту же форму `{nodeUuid, components}` — дефект :766 умирает), `component_get_component_info`, `component_set_component_property` (= `verifiedWrite`; absorbs `set_component_ref` и `set_materials` — материал это `sharedMaterials`-слот через editor-канал), `component_execute_component_method` (порт из scene-advanced-tools).
Убрать шум: три `console.log` на компонент в `extractComponentProperties` (:866–885).

- [ ] **Step 1:** Порт; build+test.
- [ ] **Step 2:** Commit: `Категория component на каркасе; одна запись свойств через verifiedWrite`.

### Task 17: prefab

**Files:**
- Create: `source/tools-v2/prefab.ts`
- Delete: `source/tools/prefab-tools.ts`, `source/tools/scene-advanced-tools.ts` (остаток: `move_array_element`, `remove_array_element`, `reset_component`, `reset_node_property`, `reset_node_transform`, `query_scene_classes`, `query_scene_components`, `query_nodes_by_asset_uuid` — портировать сюда же в `source/tools-v2/scene-ops.ts`)
- Create: `source/tools-v2/scene-ops.ts`

Тулзы prefab: `dump`, `get_component_property`, `set_component_property` (через `verifiedWrite`-аналог для файла — существующая связка `prefab-json`/`prefab-value`/`prefab-linkage` остаётся движком), `add_component`, `remove_component`, `create_prefab` (реальный путь `createPrefabFromNode2`), `instantiate_prefab` (общий код с `node_create_node{assetUuid}`: `applyLinkageOptions` + `verifyPrefabLinkage` + резолв FBX `gltf-scene`), `update_prefab`, `revert_prefab`, `restore_prefab_node`, `list_overrides`, `remove_override`, `validate_prefab`, `get_prefab_list`.

- [ ] **Step 1:** До слияния revert/restore: сверить конвенции вызова `scene:apply-prefab`/`revert-prefab`/`restore-prefab` с доками 3.8 (память `docs-before-engine-sources`); два зовутся объектом, один позиционно — риск тихого no-op (спека §9). Результат сверки записать в описания тулз.
- [ ] **Step 2:** Порт; build+test.
- [ ] **Step 3:** Commit: `Категории prefab и scene-ops на каркасе`.

### Task 18: project/assets

**Files:**
- Create: `source/tools-v2/asset.ts`, `source/tools-v2/build.ts`
- Delete: `source/tools/project-tools.ts`, `source/tools/asset-advanced-tools.ts`

Тулзы asset: `get_assets` (absorbs `find_asset_by_name`: `name?`, `exactMatch?`, `maxResults?`, `includeDetails?`; фикс `spriteFrame`-фильтра — сейчас молча `**/*`, project-tools.ts:1008–1017; `maxResults`-обрезка ДО детальных запросов), `get_asset_info` (absorbs `get_asset_details` + `query_asset_path`: uuid, url, тип, размер, дисковый путь), `create_asset` (коллизия — явный параметр `onConflict: 'fail' | 'overwrite' | 'rename'`, дефолт `fail`; сейчас `rename:!overwrite` молча переименовывает, :1146), `delete_asset`, `copy_asset`, `move_asset` (сериализация через `p-queue` вместо `moveChain`, :41), `import_asset`, `reimport_asset`, `refresh_assets`, `save_asset`, `save_asset_meta`, `generate_available_url`, `query_asset_db_ready`.
Тулзы build: `build_project`, `check_builder_status`, `get_build_settings`, `open_build_panel`, `run_project` (сообщение больше не ссылается на удалённые preview-тулзы), `get_project_info`, `get_project_settings`.

- [ ] **Step 1:** Порт; `test/build-task-conflicts.test.mjs` остаётся зелёным (логика конфликтов билд-тасок не меняется).
- [ ] **Step 2:** Commit: `Категории asset и build на каркасе`.

### Task 19: debug + логи

**Files:**
- Create: `source/tools-v2/debug.ts`
- Delete: `source/tools/debug-tools.ts`

Тулзы: `debug_execute_script` (порт как есть — самая используемая тулза), `debug_project_logs` (слияние get+search: `query?`, `level?`, `limit?`; в ответе всегда `{logFilePath, fileSize, lastModified}`; классификатор уровней — единственный правильный, из `project-log.ts`), `debug_get_preview_logs`, `debug_clear_preview_logs`, `debug_validate_scene`, `debug_get_editor_info`, `debug_get_performance_stats` (edit-mode → `fail('preview_only', …)` вместо `success:true`).

- [ ] **Step 1:** Порт; build+test. Commit: `Категория debug на каркасе; один читатель project.log`.

### Task 20: batch + ecs + skeletal; конец легаси

**Files:**
- Create: `source/tools-v2/batch.ts`, `source/tools-v2/ecs.ts`, `source/tools-v2/skeletal.ts`
- Delete: `source/tools/batch-tools.ts`, `source/tools/ecs-tools.ts`, `source/tools/skeletal-animation-tools.ts`, `source/legacy-adapter.ts`, `source/tools/` (каталог пуст)

`batch_run`: движок остаётся `batch-plan.ts`; сохранить дословно — резолв `nodePath` в момент под-вызова, whole-token vs embedded `{{i.path}}`, `stopOnError:true` дефолт, `skipped:true`. Починить: провал резолва шаблона пишет `prior`-запись, чтобы поздняя ссылка падала «call 2 failed», а не «no earlier call '2'» (batch-tools.ts:102). Диспетчер = `registry.invoke`.

- [ ] **Step 1:** `/writing-unit-tests`; дописать в `test/batch-plan.test.mjs` кейс prior-записи при провале резолва.
- [ ] **Step 2:** Порт; `legacy-adapter` удалить — легаси-путей не осталось; build+test.
- [ ] **Step 3:** Commit: `batch/ecs/skeletal на каркасе; легаси-адаптер удалён`.

### ✋ CHECKPOINT C (пользователь)

Тоггл OFF/ON. Смоук по одной записи каждого рода: plain-свойство, ссылка на компонент, ассет-ссылка, вложенный @ccclass, элемент массива; после каждой — Ctrl+Z в редакторе ОТМЕНЯЕТ правку (новое поведение); `scene_query_dirty` честен; `prefab_set_component_property` в файл префаба; `batch_run` create→address-by-path; превью-логи читаются.

---

## Фаза 4 — Хвосты

### Task 21: Честный validate_asset_references

**Files:**
- Create: `source/reference-scan.ts` (чистый модуль), `source/tools-v2/asset.ts` (тулза `asset_validate_references`)
- Test: `test/reference-scan.test.mjs`

**Interfaces:**
- Produces: `scanReferences(assetJson: unknown): string[]` (все uuid-ссылки из сериализованного ассета: `__uuid__`-поля, включая компрессированные 23-символьные формы — декомпрессия уже есть в `prefab-json.ts`), `findBroken(refs: string[], known: Set<string>): string[]`.
- Тулза: обходит `db://assets/**/*.{scene,prefab,material,mtl,fbx.meta}` (meta моделей — `materialDumpDir`-цели и `materials[]`), собирает ссылки `scanReferences`, сверяет с `queryAssets`-множеством; для FBX с `dumpMaterials:true` — существование целей дампа. Ответ: `{scanned, brokenReferences: [{asset, ref}], dumpDirsMissing: […]}`.

- [ ] **Step 1:** `/writing-unit-tests`; тесты `scanReferences` на фикстурах (фрагмент .scene с `__uuid__`, компрессированный uuid, материал), `findBroken`.
- [ ] **Step 2:** FAIL → реализация → PASS.
- [ ] **Step 3:** Commit: `validate_asset_references проверяет ссылки по-настоящему`.

### Task 22: Документация форка

**Files:**
- Modify: `README.md`, `README.EN.md`, `CLAUDE.md` (архитектура: слои, где добавлять тулзу/метод EditorApi/scene-метод; чекпоинт-процедура; инвентарь — сослаться на спеку)

- [ ] **Step 1:** Переписать под новую архитектуру; удалить инструкции про мёртвое (список scene-методов package.json, конфигурации панели).
- [ ] **Step 2:** Commit: `Доки форка под новый каркас`.

### Task 23: Скилл cocos-mcp + память + CLAUDE.md плейблов

**Files:**
- Modify: `C:\Users\hakastein\.claude\skills\cocos-mcp\SKILL.md` (новые/слитые имена тулз, WriteReport-словарь, undo-поведение), `D:\cocos\cocos-playables\CLAUDE.md` (упоминания `assetAdvanced_validate_asset_references` — тулза теперь честная; `ecs_component_census` без изменений), файлы памяти `mcp-*` (сверить каждый: починенные гочи пометить, мёртвые тулзы убрать; `mcp-writes-leave-no-undo-step` — переписать: поведение исправлено)

- [ ] **Step 1:** Пройти список памяти `mcp-*` из MEMORY.md против нового инвентаря; обновить.
- [ ] **Step 2:** Commit в репо плейблов (только свои пути): `CLAUDE.md: мост после перестройки`.

### ✋ CHECKPOINT D (пользователь)

Финальный прогон: рабочая сессия уровня «собрать кусок сцены» — создать ноду из префаба, навесить компонент, прописать ссылки, префаб-оверрайд, сохранить, `validate_references`, билд. Всё через новые тулзы.
