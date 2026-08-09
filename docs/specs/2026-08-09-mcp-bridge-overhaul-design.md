# Перестройка MCP-моста: спека

Дата: 2026-08-09. Статус: одобрено по секциям, ждёт ревью целиком.

## 1. Цель и рамки

Форк `hakastein/cocos-mcp-server` правился агентами сотни раз поверх чужой основы. Итог:
дубли тулз, тулзы-обманки, ~1900 мёртвых строк, 121 копия ручной промис-обёртки, 17
switch-простыней по имени тулзы, четыре словаря верификации, разнобой форм ответа. Цель —
упаковать **текущий** функционал в каркас, в котором баги не приходится чинить по десять раз
в день.

Рамки:

- Внешняя поверхность меняется свободно: имена, схемы, количество тулз. Скилл `cocos-mcp`
  и файлы памяти обновляются в фазе 4.
- Новый функционал не добавляется, с тремя одобренными исключениями (§7): честная реализация
  `validate_asset_references`, обёртка записей в undo-recording, слияния тулз.
- Балласт удаляется, история git его хранит.
- Панель урезается до статуса сервера (порт, запущен/нет). Слоты конфигураций, поштучные
  тогглы тулз, импорт/экспорт конфигов удаляются; все тулзы всегда включены.

Не-цели: новые тулзы, поддержка версий Cocos кроме 3.8.x, обратная совместимость имён.

## 2. Опорные факты о среде

- Редактор: Cocos Creator 3.8.8, Electron 31.3.1, **Node 20.14** — официальный
  `@modelcontextprotocol/sdk` (требует Node ≥18) работает.
- Расширение собирается esbuild-бандлом; ESM-only зависимости допустимы.
- Живая проверка возможна только в открытом редакторе; перезагрузка расширения — ручной
  тоггл OFF/ON в менеджере расширений (кэш require ничем другим не сбрасывается).
- Два процесса: main (транспорт, Editor.Message) и scene-процесс (единственное место с `cc`),
  связь через `execute-scene-script`.
- В коде два слоя. Чистые модули — `node-path`, `prefab-json`, `prefab-value`,
  `prefab-linkage`, `reference-projection`, `serialized-diff`, `scene-signature`,
  `tool-args` (алиасы), `json-arg`, `log-search`, `project-log`, `preview-log-store`,
  `ecs-census`, `batch-plan` — корректны, покрыты 19 тестами, переживают перестройку без
  правок и становятся зависимостями шлюзов. Всё остальное — оболочка на замену.

## 3. Архитектура

Четыре слоя, зависимости вниз, сборка в одной точке композиции (`main.ts` — единственное
место с `new`). Инъекция конструкторная, руками; DI-контейнера нет — в графе порядка десяти
объектов.

```
main.ts (composition root)
├─ транспорт   @modelcontextprotocol/sdk: McpServer + StreamableHTTPServerTransport.
│              Самописный mcp-server.ts (449 строк: JSON-RPC, SSE, сессии) удаляется.
│              isError ставит SDK. Роуты /preview-log и /preview-console.js остаются
│              нашими поверх того же http-сервера.
├─ реестр      ToolRegistry: Map имя→Tool + конвейер препроцессинга (алиасы аргументов,
│              резолв nodePath→uuid). Switch-ей по имени не существует.
├─ тулзы       defineTool({ name, description, inputSchema: zod, handler }).
│              Тип args выводится из zod-схемы. Группировка по доменным модулям
│              (scene.ts, prefab.ts, …), модуль экспортирует Tool[].
└─ шлюзы       ToolContext — всё, что доступно хендлерам:
                 ctx.editor      EditorApi
                 ctx.sceneScript SceneScriptClient
                 ctx.assets      дисковая хирургия (prefab-json / asset-json)
                 ctx.logs        LogStore (инстанс; модульный синглтон умирает)
                 ctx.settings    Settings
```

**EditorApi** — типизированные методы, по одному на каждое реально используемое сообщение
редактора (`editor.assetDb.queryAssetInfo(uuid)`, `editor.scene.setProperty(dump)`, …);
на сегодня ~40 методов, интерфейс растёт по мере переноса. Внутри — единственное место с
`Editor.Message.request`, единый маппинг ошибок. Заменяет 121 ручную промис-обёртку.

**SceneScriptClient** — общий контракт с engine-половиной:

```ts
// scene-contract.ts, виден обеим сторонам
export interface SceneMethods {
    dump(opts: DumpOptions): SceneDump;
    setNodeProperty(req: NodePropertyWrite): WriteReport;
    // ...
}
```

Engine-сторона обязана реализовать (`const methods: SceneMethods` — tsc ловит пропуск),
мост зовёт через `call<K extends keyof SceneMethods>(k, …args)`. Имя метода не пишется
руками ни в одном вызове. Список методов в `package.json` для execute-scene-script не
load-bearing (диспетчеризация идёт по экспортированному объекту) — инструкция «поддерживать
список» из CLAUDE.md форка удаляется.

Engine-половина (нынешний `scene.ts`, 1850 строк) распадается на модули по концернам,
вместе реализующие `SceneMethods`. Все асинхронные операции awaited; fire-and-forget
загрузка ассета с присвоением строки-uuid в типизированное поле при ошибке
(scene.ts:937–975) становится невыразимой: метод возвращает `WriteReport`.

**Библиотеки.** Правило: всё, что закрывается либой, закрывается либой.
`@modelcontextprotocol/sdk` (транспорт+протокол), `zod` (схемы: валидация + вывод типов +
JSON Schema), `p-wait-for` (поллинг-settle), `p-queue` (сериализация move-ов вместо
самодельного `moveChain`), `uuid` (уже стоит). Один дефолтный порт в одном месте
(settings) — сейчас в коде их четыре: 3000, 4000, 8585×2.

## 4. Запись свойств и верификация

У редактора два канала записи с разными гарантиями:

| канал | механизм | оверрайды префабов | переживает сохранение | достаёт |
|---|---|---|---|---|
| editor | `scene:set-property` и родня | пишет | да | не всё |
| live | присваивание в scene-процессе | нет | нет | всё |

Сейчас канал выбирается молча; честно его моделирует один `set_component_ref`. В новом
мосте канал — явное свойство результата:

```ts
interface WriteReport {
    written: boolean;            // операция прошла
    verified: boolean;           // read-back совпал с намерением
    persisted: boolean;          // канал editor: переживёт сохранение
    prefabOverride?: OverrideInfo;
    detail?: string;
}
```

Один словарь на все записи; четыре нынешних (`changeVerified` / `verified` /
`prefabLinked` / `componentVerified`) сливаются в него.

**Выбор способа записи.** Дескриптор свойства из дампа редактора один раз проходит через
резолвер и получает `PropertyKind` (enum: `gradient | curve | classArray | nestedClass |
assetRef | nodeRef | componentRef | plain | …`). Строковые сравнения `'cc.Vec3'`-подобных
типов живут только внутри резолвера. Дальше полиморфизм:

```ts
interface PropertyWriter {
    readonly kind: PropertyKind;
    write(target: WriteTarget, value: unknown): Promise<WriteReport>;
}
interface PropertyReader {
    readonly kind: PropertyKind;
    project(dumpValue: unknown): unknown; // компактное представление для агента
}
```

Реестр писателей — один декларативный упорядоченный массив в одном файле. Заменяет:
8-веточный каскад `setComponentProperty` (component-tools.ts:989–1067, порядок веток
load-bearing и нигде не записан), 90-строчный `buildTypedDump` (18 последовательных if),
спецкейсы по имени свойства в scene.ts:925 (`spriteFrame && cc.Sprite`, `material`,
`mesh`). Резолвер — чистая функция над данными дескриптора, тестируется без редактора.

**Верификация — один сервис:** запись → `settle(предикат, таймаут)` → read-back →
`WriteReport`. Поллинг через p-wait-for вместо 15 магических `setTimeout` (100–300 мс;
корректный поллинг сейчас есть в 2 местах из 15). Дорогая сверка сцены с файлом на диске
(`sceneDirtyAgainstDisk`, сейчас полная сериализация сцены на каждую запись) становится
опцией `verify: 'disk'` и финальным шагом батча.

**Undo.** Записи канала editor оборачиваются в `scene:begin-recording` /
`end-recording` — механизм в редакторе рабочий, мост его просто никогда не звал. После
этого Ctrl+Z берёт правки моста, `_undoMgr.isDirty()` честен, редактор спрашивает про
сохранение при закрытии. Структурные операции (`create-node`, `create-component`,
`remove-node`) пишут undo сами — их не оборачивать. Ошибка внутри обёрнутой записи →
`cancel-recording`.

## 5. Формат ответа

- Один тип `ToolResult`; конструкторы `ok(data, message?)` / `fail(code, message, hint?)`.
- `message` только на верхнем уровне. `data` одной формы на тулзу; фолбэк возвращает тот же
  тип или `fail` (сейчас `component_get_components` в фолбэке отдаёт голый массив вместо
  `{components}` — ломается ровно когда редактор тормозит).
- `success:true` с ошибкой внутри невыразим: `fail` — единственный канал неудачи, SDK
  ставит протокольный `isError`.
- `fail.hint` — дом для накопленных подсказок (bare uuid для asset-ссылок, адресация
  `nodeUuid + __comps__.N`, …), сейчас размазанных по текстам сообщений.
- Записи возвращают `WriteReport` в `data`.
- Мост логирует решения, не только ошибки: выбранный писатель, канал, исход settle.
  Пустой `catch` без комментария в новом коде не живёт (сейчас их 47).

## 6. Инвентарь: 192 → ~80

### Категории под снос целиком (50)

`broadcast` (5 — слушателя не существует, «Started listening» — ложь), `preferences` (7),
`referenceImage` (12), `sceneView` (17), `server` (6 — это device-preview редактора,
читается как статус моста), `validation` (3 — клиентское жонглирование строками,
`fixJsonString` ломает апострофы).

### Удаляемые поштучно

| Тулза | Причина |
|---|---|
| `sceneAdvanced_restore_prefab` | байт-в-байт дубль `prefab_restore_prefab_node` |
| `sceneAdvanced_execute_scene_script` | сырой обход валидации всех тулз |
| `scene_get_scene_hierarchy`, `node_get_all_nodes`, `debug_get_node_tree` | остаётся один читатель дерева — `scene_dump` |
| `scene_save_scene_as` | молча сохраняет текущую сцену поверх её файла, потом копирует; дубликат — `project_copy_asset` |
| `scene_snapshot`, `scene_snapshot_abort` | редакторский undo-снапшот под вводящим в заблуждение именем |
| `sceneAdvanced_query_component_has_script` | булев, покрытый `query_scene_classes` |
| `debug_get_console_logs`, `debug_clear_console` | «memory+project.log» — буфер памяти никогда не заполняется |
| `component_get_available_components` | захардкоженные ~35 имён, кастомных скриптов не видит; правда — `query_scene_components` |
| `prefab_get_prefab_info` | читает из меты поля, которых в мете Cocos нет (undefined-метаданные) |
| `prefab_load_prefab` | прогрев кэша без наблюдаемого эффекта |
| `prefab_duplicate_prefab` | делает работу и безусловно возвращает «temporarily unavailable» |
| `assetAdvanced_get_asset_dependencies`, `get_unused_assets`, `compress_textures` | стабы, всегда `success:false` |
| `assetAdvanced_export_asset_manifest` | «экспорт», который ничего не пишет |
| `assetAdvanced_open_asset_external` | запуск OS-приложения на чужом десктопе, ноль информации |
| `assetAdvanced_batch_import/delete_assets` | `success:true` при полностью проваленном батче; батчи — `batch_run` |
| `project_start/stop_preview_server` | стабы (при этом сообщение `run_project` ссылается на них — поправить) |
| `project_query_asset_uuid`, `query_asset_url` | identity покрыта `get_asset_info` |
| `debug_get_project_logs` | второй, неверный классификатор уровней рядом с правильным |
| `debug_get_log_file_info` | сливается в лог-читатель |
| `node_detect_node_type` | вердикт и объяснение считаются по разным спискам UI-типов и противоречат друг другу; переезжает блоком в `get_node_info` |

Плюс мёртвый код: prefab-tools.ts:852–2538 и 2562–3037 (~1900 строк — три брошенных
сериализатора, self-fetch на `localhost:8585`, вторая неверная `compressUuid`),
`main.getFilteredToolsList`/`getSettings` (недостижимы по IPC), фолбэк на несуществующий
scene-метод `findNodes` (node-tools.ts:942).

### Слияния

| Из | В | Примечания |
|---|---|---|
| `node_find_node_by_name` | `node_find_nodes` | параметр `exactMatch` |
| `node_create_primitive` | `node_create_node` | параметр `primitive` |
| `node_detect_node_type` | `node_get_node_info` | блок `nodeType` + `transformConstraints`, **единый** список UI-типов, общий с `set_node_transform` (сейчас три разъехавшихся копии) |
| `component_attach_script` | `component_add_component` | путь `db://` переключает сверку на uuid скрипт-ассета (`__scriptAsset`); двухпопыточное создание с защитой от двойного добавления переносится дословно; settle 300 мс → поллинг |
| `component_set_component_ref`, `component_set_materials`, `component_get_materials` | `component_set_component_property` / дамп компонента | цепочка писателей даёт вердикт уровня `set_component_ref` всем записям; материалы — слот `sharedMaterials` через канал editor |
| `project_find_asset_by_name` | `project_get_assets` | `name?`, `exactMatch?`, `maxResults?`, `includeDetails?`; чинится `spriteFrame`-фильтр (сейчас молча `**/*`) и N+1 за `maxResults` |
| `project_get_asset_info` + `get_asset_details` + `query_asset_path` | `project_get_asset_info` | uuid, url, тип, размер, **дисковый путь** одним вызовом |
| `debug_search_project_logs` + file-info | `debug_project_logs` | `query?`, `level?`; в ответе всегда `{logFilePath, fileSize, lastModified}` — «файл мёртв» отличим от «ничего не залогировано» |

### Остаются (переезд на каркас, поведение прежнее)

- **scene:** `dump` (единственный читатель дерева), `open`, `save`, `close` (+предупреждение
  в описании: несохранённое гибнет молча — до выкатки undo-обёртки), `create`
  (в описании честно: пустой шаблон без Canvas/камеры/света; убрать пост-глоб
  `sceneVerified`), `get_current`, `get_list`, `checksum`, `find_component_owners`,
  `query_dirty`, `query_ready`, `soft_reload`.
- **undo:** `begin/end/cancel_undo_recording` — остаются и как тулзы, и становятся
  внутренней обвязкой записей (§4).
- **node:** `create`, `delete`, `duplicate`, `move`, `find_nodes`, `get_node_info`,
  `set_property`, `set_transform`, `list_builtin_meshes`, `copy/cut/paste_node`,
  `move/remove_array_element`, `reset_node_transform/property`, `reset_component`.
- **component:** `add`, `remove`, `get_components`, `get_component_info`, `set_property`,
  `execute_component_method`.
- **интроспекция:** `query_scene_classes` (фильтр `extends`), `query_scene_components`
  (истина про доступные классы, включая кастомные), `query_nodes_by_asset_uuid`.
- **prefab:** `dump`, `get/set_component_property`, `add/remove_component`, `create`,
  `instantiate` (резолв FBX `gltf-scene` суб-ассета — общий код с `node_create` по
  `assetUuid`), `update` (=apply), `revert`, `restore_prefab_node` (сверить конвенцию
  вызова с доками 3.8 — соседние `scene:*-prefab` зовутся то объектом, то позиционно,
  один может тихо no-op'ить), `list_overrides`, `remove_override`, `validate`,
  `get_prefab_list`.
- **assets/project:** `get_assets`, `get_asset_info`, `create_asset` (поведение при
  коллизии — явный параметр; сейчас `rename: !overwrite` молча переименовывает),
  `delete_asset`, `copy_asset`, `move_asset` (через p-queue), `import_asset`,
  `reimport_asset`, `refresh_assets`, `save_asset`, `save_asset_meta`,
  `generate_available_url` (пре-флайт коллизий), `query_asset_db_ready`,
  `find_asset_by_name`→слито, `get_project_info`, `get_project_settings`.
- **build/preview:** `build_project`, `check_builder_status`, `get_build_settings`,
  `open_build_panel`, `run_project`.
- **debug:** `execute_script`, `get_preview_logs`, `clear_preview_logs`, `project_logs`
  (слитый), `validate_scene`, `get_editor_info`, `get_performance_stats` (честный `fail`
  в edit-режиме вместо `success:true`).
- **batch:** `batch_run` — сохранить дословно: резолв `nodePath` в момент под-вызова
  (свойство, делающее «создай ноду → адресуй её по пути» рабочим в одном батче),
  типизированные whole-token `{{0.data.uuid}}` против строкового embedded, `stopOnError`
  по умолчанию `true`, `skipped: true` у неисполненных. Починить: провал резолва шаблона
  должен записывать `prior`-запись, чтобы поздняя ссылка падала с «call 2 failed», а не
  «no earlier call '2'».
- **ecs:** `ecs_component_census`.
- **skeletalAnimation:** `add_socket`, `list_sockets`, `remove_socket`.

## 7. Одобренные исключения из «без нового функционала»

1. **`validate_asset_references` реализуется честно** — сейчас перечисляет ассеты и всегда
   отвечает `brokenReferences: 0`, не проверив ни одной ссылки; CLAUDE.md репо плейблов
   опирается на него после истории с `materialDumpDir`. Честная реализация: пройти
   сериализованные ассеты (сцены, префабы, материалы, меты моделей), собрать uuid-ссылки,
   сверить с базой ассетов; для FBX с `dumpMaterials` — проверить существование
   `materialDumpDir`-целей. Плюс проверка «материал модели несёт Texture2D» по мотивам
   гочи из CLAUDE.md.
2. **Undo-обёртка записей** (§4).
3. **Слияния тулз** (§6) — поведение поглощаемых сохраняется параметрами поглотителя.

## 8. Тесты

**Каждый тест пишется только после загрузки скилла `/writing-unit-tests` — без исключений,
в том числе сабагентами (вписывать в бриф).** Тестируется поведение, доступное снаружи
модуля; тесты на содержимое приватных структур не пишутся.

- 19 существующих тестов чистых модулей переживают без правок.
- Добавляются: резолвер `PropertyKind` (чистая функция над дескрипторами), порядок и
  непересечение цепочки писателей, контрактный тест реестра (уникальность имён, валидность
  zod-схем).
- Слой шлюзов и engine-половина тестами не покрываются — их проверяет живой редактор.
  Кейс «case есть — тулзы нет» умирает по построению (определение и хендлер — одно
  значение).
- `npm test` остаётся `node --test` над `dist/` после tsc.

## 9. Порядок миграции

По одному ручному тогглу расширения (OFF/ON) на фазу; каждая фаза — коммит(ы) в форк.

1. **Снос.** Категории-балласт, поштучные удаления, мёртвый код, машинерия конфигураций
   панели (ToolManager-слоты, импорт/экспорт; панель — только статус). Ни одна живая тулза
   не меняется. Проверка: сборка, тоггл, список тулз, несколько чтений на открытом плейбле.
2. **Каркас + пилот.** SDK-транспорт, реестр, `EditorApi`, `SceneScriptClient` + контракт,
   `ok/fail`, `settle`, единый порт. Категория `scene` переезжает целиком как пилот формы.
   Живой смоук.
3. **Перенос ядра.** Порядок: `node` → `component` (цепочка писателей, `WriteReport`,
   undo-обёртка) → `prefab` → `project/assets` → `debug/логи` → `batch`, `ecs`,
   `skeletal`. Категория = коммит + живой смоук.
4. **Хвосты.** Честный `validate_asset_references`; README и CLAUDE.md форка переписываются
   под новую архитектуру; в репо плейблов обновляются скилл `cocos-mcp`, файлы памяти
   (отзыв «сохранение — только руками», ревизия «no undo step», новые имена тулз) и
   упоминания тулз в CLAUDE.md.

Риски: конвенции вызова `scene:*-prefab` сверить с доками 3.8 до слияния restore/revert
(один вариант может тихо no-op'ить); SDK-транспорт поднять рядом с нашими роутами
`/preview-log` до удаления старого сервера; после каждой фазы кэшированные uuid нод в
живых сессиях устаревают (перезагрузка расширения перезагружает сцену).
