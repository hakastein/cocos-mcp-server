import * as fs from 'fs';
import * as path from 'path';
import PQueue from 'p-queue';
import { z } from 'zod';
import { booleanArg, defineTool } from '../tool';
import { ok, fail } from '../result';
import { textOf } from './shared';
import { ASSET_TYPES, assetQuery, selectAssets } from '../asset-query';
import { coerceJsonArg } from '../json-arg';
import {
    baseUuidOf, findBroken, findMissingSubAssets, scanModelMeta, scanReferenceSites, subIdOf
} from '../reference-scan';
import type { ReferenceSite } from '../reference-scan';
import type { AssetOperationOption, EditorAssetInfo } from '../editor-api';
import type { RegisteredTool } from '../tool';
import type { ToolContext } from '../context';

const URL_ALIASES = { assetPath: 'url', path: 'url', assetUrl: 'url' };

const REF_ALIASES = { url: 'assetPath', path: 'assetPath', uuid: 'assetPath', assetUrl: 'assetPath' };

const DEFAULT_MAX_RESULTS = 200;

/**
 * Parallel moves into one folder race inside the asset-db: with rename-on-conflict on, two
 * concurrent moves each compute the same free name before either finishes.
 */
const moveQueue = new PQueue({ concurrency: 1 });

interface AssetSummary {
    name: string;
    uuid: string;
    url: string;
    type: string;
    isDirectory: boolean;
    details?: Record<string, unknown>;
}

function summarize(asset: EditorAssetInfo): AssetSummary {
    return {
        name: asset.name,
        uuid: asset.uuid,
        url: asset.url,
        type: asset.type,
        isDirectory: asset.isDirectory === true
    };
}

function fileSize(diskPath: string | null): number | null {
    if (!diskPath) return null;
    try {
        const stat = fs.statSync(diskPath);
        return stat.isFile() ? stat.size : null;
    } catch {
        return null;
    }
}

async function diskPathOf(ctx: ToolContext, asset: EditorAssetInfo): Promise<string | null> {
    if (asset.file) return asset.file;
    return ctx.editor.assetDb.queryPath(asset.uuid).catch(() => null);
}

function conflictOptions(onConflict: 'fail' | 'overwrite' | 'rename'): AssetOperationOption {
    return { overwrite: onConflict === 'overwrite', rename: onConflict === 'rename' };
}

export const projectGetAssets = defineTool({
    name: 'project_get_assets',
    description: 'List assets under a folder, optionally narrowed by type and by name. This is the '
        + 'project-wide asset search: `name` matches as a case-insensitive substring unless '
        + '`exactMatch` is set, and the answer always carries `total` — how many assets matched '
        + 'before `maxResults` cut the list — so a truncated result is never mistaken for the whole '
        + 'set. Details are fetched only for the assets actually returned.',
    schema: z.object({
        folder: z.string().optional().describe('Folder to search under (default db://assets)'),
        type: z.enum(ASSET_TYPES).optional().describe('Asset type filter (default all). spriteFrame '
            + 'matches the sub-asset by its cc type, every other type by file extension.'),
        name: z.string().optional().describe('Only assets whose name matches this'),
        exactMatch: booleanArg.optional().describe('Match `name` exactly instead of as a substring '
            + '(default false)'),
        maxResults: z.coerce.number().int().min(1).max(2000).optional()
            .describe(`Cap on returned assets (default ${DEFAULT_MAX_RESULTS}); \`total\` still reports the full match count`),
        includeDetails: booleanArg.optional().describe('Add importer, disk path and sub-asset count '
            + 'per returned asset — one editor query each, so only for the assets that survive the cut')
    }),
    aliases: { assetType: 'type', assetName: 'name' },
    async handler(args, ctx) {
        const folder = args.folder || 'db://assets';
        const type = args.type ?? 'all';
        const maxResults = args.maxResults ?? DEFAULT_MAX_RESULTS;

        let found: EditorAssetInfo[];
        try {
            found = await ctx.editor.assetDb.queryAssets(assetQuery(folder, type));
        } catch (error) {
            return fail('query_failed', `Assets under ${folder} could not be listed: ${textOf(error)}`);
        }

        const selection = selectAssets(found, {
            name: args.name,
            exactMatch: args.exactMatch === true,
            maxResults
        });
        const assets = selection.assets.map(summarize);

        if (args.includeDetails === true) {
            for (const asset of assets) {
                const info = await ctx.editor.assetDb.queryAssetInfo(asset.uuid).catch(() => null);
                if (!info) continue;
                asset.details = {
                    importer: info.importer,
                    imported: info.imported,
                    diskPath: await diskPathOf(ctx, info),
                    subAssetCount: Object.keys(info.subAssets || {}).length
                };
            }
        }

        return ok(
            {
                folder,
                type,
                name: args.name ?? null,
                exactMatch: args.exactMatch === true,
                maxResults,
                count: assets.length,
                total: selection.total,
                truncated: selection.truncated,
                assets
            },
            selection.truncated
                ? `${selection.total} assets matched; showing ${assets.length}. Raise maxResults or narrow the search.`
                : `${assets.length} asset(s) matched`
        );
    }
});

export const projectGetAssetInfo = defineTool({
    name: 'project_get_asset_info',
    description: 'Everything the asset database knows about ONE asset, addressed by db:// url or by '
        + 'uuid: uuid, url, type, importer, absolute disk path, byte size, and its sub-assets grouped '
        + 'by importer. For an FBX/glTF model the groups are meshes / materials / animationClips / '
        + 'skeletons / textures / modelPrefab, so a MeshRenderer can be built from a mesh or a clip '
        + 'resolved without guessing sub-id suffixes — instantiate `grouped.modelPrefab`, not the .fbx '
        + 'main asset.',
    schema: z.object({
        assetPath: z.string().describe('Asset db:// url (db://assets/...) or a uuid'),
        includeSubAssets: booleanArg.optional().describe('Enumerate sub-assets (default true)')
    }),
    aliases: REF_ALIASES,
    async handler(args, ctx) {
        let info: EditorAssetInfo | null;
        try {
            info = await ctx.editor.assetDb.queryAssetInfo(args.assetPath);
        } catch (error) {
            return fail('query_failed', `Asset ${args.assetPath} could not be read: ${textOf(error)}`);
        }
        if (!info) {
            return fail('asset_not_found', `No asset at '${args.assetPath}'`,
                'Pass a db:// url or a uuid. project_get_assets finds an asset by name.');
        }

        const diskPath = await diskPathOf(ctx, info);
        const subAssets: Array<{ id: string; name: string; importer: string; uuid: string }> = [];

        if (args.includeSubAssets !== false) {
            // The sub-id is an artifact of the import, so it is read from the meta rather than guessed.
            const meta = await ctx.editor.assetDb.queryAssetMeta(info.uuid).catch(() => null);
            const subMetas = (meta?.subMetas || {}) as Record<string, any>;
            for (const id of Object.keys(subMetas)) {
                const sub = subMetas[id];
                if (!sub) continue;
                subAssets.push({
                    id,
                    name: sub.name || sub.displayName || id,
                    importer: sub.importer,
                    uuid: sub.uuid || `${info.uuid}@${id}`
                });
            }
            if (!subAssets.length) {
                for (const [id, sub] of Object.entries(info.subAssets || {})) {
                    subAssets.push({
                        id,
                        name: sub?.name || id,
                        importer: sub?.importer || sub?.type,
                        uuid: sub?.uuid || `${info.uuid}@${id}`
                    });
                }
            }
        }

        const byImporter: Record<string, typeof subAssets> = {};
        for (const sub of subAssets) {
            const importer = sub.importer || 'unknown';
            (byImporter[importer] = byImporter[importer] || []).push(sub);
        }

        return ok({
            name: info.name,
            uuid: info.uuid,
            url: info.url,
            type: info.type,
            importer: info.importer,
            isDirectory: info.isDirectory === true,
            imported: info.imported,
            diskPath,
            size: fileSize(diskPath),
            meta: info.meta ? { ver: info.meta.ver, importer: info.meta.importer } : undefined,
            subAssets,
            grouped: {
                meshes: byImporter['gltf-mesh'] || [],
                materials: byImporter['gltf-material'] || [],
                animationClips: byImporter['gltf-animation'] || [],
                skeletons: byImporter['gltf-skeleton'] || [],
                textures: [...(byImporter['texture'] || []), ...(byImporter['image'] || [])],
                spriteFrames: byImporter['sprite-frame'] || [],
                modelPrefab: (byImporter['gltf-scene'] || [])[0] || null
            }
        }, `${info.url} (${info.type}), ${subAssets.length} sub-asset(s)`);
    }
});

export const projectCreateAsset = defineTool({
    name: 'project_create_asset',
    description: 'Create a file or a folder in the asset database. `content` omitted means a FOLDER. '
        + 'What happens when the url is taken is stated by `onConflict`, never guessed: `fail` (the '
        + 'default) refuses and changes nothing, `overwrite` replaces the file in place keeping its '
        + 'uuid, `rename` writes alongside it under a free name — which the answer reports as '
        + '`renamed` plus the url actually created.',
    schema: z.object({
        url: z.string().describe('Asset URL, e.g. db://assets/scripts/newfile.json'),
        content: z.string().nullish().describe('File content; omit for a folder'),
        onConflict: z.enum(['fail', 'overwrite', 'rename']).optional()
            .describe('What to do when the url already exists (default fail)')
    }),
    aliases: URL_ALIASES,
    async handler(args, ctx) {
        const onConflict = args.onConflict ?? 'fail';
        const content = args.content ?? null;

        if (onConflict === 'fail') {
            const existing = await ctx.editor.assetDb.queryAssetInfo(args.url).catch(() => null);
            if (existing) {
                return fail('asset_exists', `${args.url} already exists (uuid ${existing.uuid}). Nothing was created.`,
                    'Pass onConflict:"overwrite" to replace it, onConflict:"rename" to write beside it, '
                    + 'or assetAdvanced_generate_available_url to pick a free url first.',
                    { url: args.url, uuid: existing.uuid });
            }
        }

        let created: EditorAssetInfo | null;
        try {
            created = await ctx.editor.assetDb.createAsset(args.url, content, conflictOptions(onConflict));
        } catch (error) {
            return fail('create_failed', `${args.url} was not created: ${textOf(error)}`);
        }
        if (!created) {
            return fail('create_failed', `The asset database did not create ${args.url}`,
                'It answers null when the target folder does not exist, or when the url is taken and '
                + 'neither overwrite nor rename was allowed.');
        }

        const renamed = created.url !== args.url;
        return ok(
            { uuid: created.uuid, url: created.url, requestedUrl: args.url, renamed, isDirectory: created.isDirectory === true },
            renamed
                ? `${args.url} was taken; created ${created.url} instead`
                : `${content === null ? 'Folder' : 'File'} created: ${created.url}`
        );
    }
});

export const projectDeleteAsset = defineTool({
    name: 'project_delete_asset',
    description: 'Delete an asset (or a whole folder) from the asset database. The url is checked '
        + 'first, so deleting something that is not there is an error rather than a silent success. '
        + 'Scenes and prefabs reference assets by uuid — project_get_assets and '
        + 'sceneAdvanced_query_nodes_by_asset_uuid answer who uses it BEFORE it is gone.',
    schema: z.object({
        url: z.string().describe('Asset URL to delete (db://assets/...)')
    }),
    aliases: URL_ALIASES,
    async handler(args, ctx) {
        const existing = await ctx.editor.assetDb.queryAssetInfo(args.url).catch(() => null);
        if (!existing) {
            return fail('asset_not_found', `No asset at '${args.url}'; nothing was deleted.`);
        }
        try {
            await ctx.editor.assetDb.deleteAsset(args.url);
        } catch (error) {
            return fail('delete_failed', `${args.url} was not deleted: ${textOf(error)}`);
        }
        return ok({ url: args.url, uuid: existing.uuid }, `Asset deleted: ${args.url}`);
    }
});

export const projectCopyAsset = defineTool({
    name: 'project_copy_asset',
    description: 'Copy an asset to another db:// location. The copy is a NEW asset with a new uuid, '
        + 'so nothing that referenced the original points at it. With `overwrite` off (the default) a '
        + 'taken target is renamed rather than refused — the answer reports `renamed` and the url the '
        + 'copy actually landed on.',
    schema: z.object({
        source: z.string().describe('Source asset URL'),
        target: z.string().describe('Target location URL'),
        overwrite: booleanArg.optional().describe('Replace the target instead of renaming (default false)')
    }),
    async handler(args, ctx) {
        const options: AssetOperationOption = { overwrite: args.overwrite === true, rename: args.overwrite !== true };
        let copied: EditorAssetInfo | null;
        try {
            copied = await ctx.editor.assetDb.copyAsset(args.source, args.target, options);
        } catch (error) {
            return fail('copy_failed', `${args.source} was not copied: ${textOf(error)}`);
        }
        if (!copied) {
            return fail('copy_failed', `The asset database did not copy ${args.source} to ${args.target}`,
                'It answers null when the source does not exist or the target folder is missing.');
        }
        const renamed = copied.url !== args.target;
        return ok({ uuid: copied.uuid, url: copied.url, source: args.source, requestedTarget: args.target, renamed },
            renamed ? `${args.target} was taken; copied to ${copied.url}` : `Asset copied to ${copied.url}`);
    }
});

export const projectMoveAsset = defineTool({
    name: 'project_move_asset',
    description: 'Move or rename an asset. Uuids SURVIVE the move, so scene and prefab references '
        + 'keep working — but the absolute db://assets/… paths stored inside .meta importer settings '
        + 'do NOT: an FBX with dumped materials keeps a materialDumpDir (and uri / '
        + 'imageUuidOrDatabaseUri) naming the OLD folder. A model whose materialDumpDir no longer '
        + 'exists is re-dumped WITHOUT textures and renders flat, and nothing says so. Rewrite those '
        + 'paths in the same change, before the editor reimports the moved tree. Moves are serialized '
        + 'one at a time: concurrent moves into one folder corrupt each other. With `overwrite` off '
        + '(the default) a taken target is renamed, which the answer reports as `renamed`.',
    schema: z.object({
        source: z.string().describe('Source asset URL'),
        target: z.string().describe('Target location URL'),
        overwrite: booleanArg.optional().describe('Replace the target instead of renaming (default false)')
    }),
    async handler(args, ctx) {
        const options: AssetOperationOption = { overwrite: args.overwrite === true, rename: args.overwrite !== true };
        let moved: EditorAssetInfo | null;
        try {
            moved = await moveQueue.add(() => ctx.editor.assetDb.moveAsset(args.source, args.target, options));
        } catch (error) {
            return fail('move_failed', `${args.source} was not moved: ${textOf(error)}`);
        }
        if (!moved) {
            return fail('move_failed', `The asset database did not move ${args.source} to ${args.target}`,
                'It answers null when the source does not exist or the target folder is missing.');
        }
        const renamed = moved.url !== args.target;
        return ok({ uuid: moved.uuid, url: moved.url, source: args.source, requestedTarget: args.target, renamed },
            renamed ? `${args.target} was taken; moved to ${moved.url}` : `Asset moved to ${moved.url}`);
    }
});

export const projectImportAsset = defineTool({
    name: 'project_import_asset',
    description: 'Copy a file from anywhere on disk into the project and import it. `sourcePath` is '
        + 'an OS path, `targetFolder` a db:// folder; the file keeps its name. The disk file is read '
        + 'before the editor is asked, so a wrong path is reported as such.',
    schema: z.object({
        sourcePath: z.string().describe('Source file path on disk'),
        targetFolder: z.string().describe('Target folder, e.g. db://assets/textures')
    }),
    async handler(args, ctx) {
        if (!fs.existsSync(args.sourcePath)) {
            return fail('source_not_found', `No file at '${args.sourcePath}'`);
        }
        const folder = args.targetFolder.startsWith('db://')
            ? args.targetFolder.replace(/\/+$/, '')
            : `db://assets/${args.targetFolder.replace(/^\/+|\/+$/g, '')}`;
        const url = `${folder}/${path.basename(args.sourcePath)}`;

        let imported: EditorAssetInfo | null;
        try {
            imported = await ctx.editor.assetDb.importAsset(args.sourcePath, url);
        } catch (error) {
            return fail('import_failed', `${args.sourcePath} was not imported: ${textOf(error)}`);
        }
        if (!imported) {
            return fail('import_failed', `The asset database did not import ${args.sourcePath} to ${url}`,
                'It answers null when the target folder does not exist or the url is taken.');
        }
        return ok({ uuid: imported.uuid, url: imported.url, source: args.sourcePath },
            `Asset imported: ${imported.url}`);
    }
});

export const projectReimportAsset = defineTool({
    name: 'project_reimport_asset',
    description: 'Re-run the importer on one asset. This is how an edit made to a file behind the '
        + 'framework mount — which the editor does not notice on its own — reaches the project; '
        + 'project_refresh_assets does the same for a whole folder.',
    schema: z.object({
        url: z.string().describe('Asset URL to reimport (db://assets/...)')
    }),
    aliases: URL_ALIASES,
    async handler(args, ctx) {
        // The asset-db calls .startsWith on whatever it is handed, so a non-db:// value surfaces
        // as a bare TypeError naming no argument.
        if (!args.url.startsWith('db://')) {
            return fail('invalid_url', `'url' must be a db:// asset url (e.g. db://assets/scripts/foo.ts), `
                + `received ${JSON.stringify(args.url)}`);
        }
        try {
            await ctx.editor.assetDb.reimportAsset(args.url);
        } catch (error) {
            return fail('reimport_failed', `${args.url} was not reimported: ${textOf(error)}`);
        }
        return ok({ url: args.url }, `Asset reimported: ${args.url}`);
    }
});

export const projectRefreshAssets = defineTool({
    name: 'project_refresh_assets',
    description: 'Rescan a folder of the asset database, importing what changed on disk. Needed after '
        + 'an edit the editor did not make itself — anything written behind the framework mount, or by '
        + 'a tool outside the editor. Takes a few seconds on db://assets/framework.',
    schema: z.object({
        folder: z.string().optional().describe('Folder to refresh (default db://assets)')
    }),
    aliases: { url: 'folder', path: 'folder' },
    async handler(args, ctx) {
        const folder = args.folder || 'db://assets';
        try {
            await ctx.editor.assetDb.refreshAsset(folder);
        } catch (error) {
            return fail('refresh_failed', `${folder} was not refreshed: ${textOf(error)}`);
        }
        return ok({ folder }, `Assets refreshed in: ${folder}`);
    }
});

export const projectSaveAsset = defineTool({
    name: 'project_save_asset',
    description: 'Overwrite the CONTENT of an existing asset file and reimport it. The uuid is kept. '
        + 'This is the text channel — a .scene or .prefab is never to be hand-written through it; use '
        + 'the scene and prefab tools, which go through the editor.',
    schema: z.object({
        url: z.string().describe('Asset URL (db://assets/...)'),
        content: z.string().describe('New file content')
    }),
    aliases: URL_ALIASES,
    async handler(args, ctx) {
        let saved: EditorAssetInfo | null;
        try {
            saved = await ctx.editor.assetDb.saveAsset(args.url, args.content);
        } catch (error) {
            return fail('save_failed', `${args.url} was not saved: ${textOf(error)}`);
        }
        if (!saved) {
            return fail('save_failed', `The asset database did not save ${args.url}`,
                'It answers null when the asset does not exist — create it with project_create_asset.');
        }
        return ok({ uuid: saved.uuid, url: saved.url }, `Asset saved: ${saved.url}`);
    }
});

export const assetAdvancedSaveAssetMeta = defineTool({
    name: 'assetAdvanced_save_asset_meta',
    description: 'Write a .meta file wholesale. `content` is the COMPLETE serialized meta, not a '
        + 'patch: read the current one first (debug_execute_script over asset-db query-asset-meta), '
        + 'change the field, send the whole object back. A meta is authored by the editor, and its '
        + 'uuid — which every scene and prefab references — lives in it, so a hand-written meta or a '
        + 'regenerated uuid detaches the asset from everything pointing at it.',
    schema: z.object({
        urlOrUUID: z.string().describe('Asset URL or UUID'),
        content: z.string().describe('Complete serialized meta content')
    }),
    aliases: { url: 'urlOrUUID', uuid: 'urlOrUUID', assetPath: 'urlOrUUID' },
    async handler(args, ctx) {
        let saved: EditorAssetInfo | null;
        try {
            saved = await ctx.editor.assetDb.saveAssetMeta(args.urlOrUUID, args.content);
        } catch (error) {
            return fail('save_meta_failed', `Meta of ${args.urlOrUUID} was not saved: ${textOf(error)}`);
        }
        if (!saved) {
            return fail('save_meta_failed', `The asset database did not save the meta of ${args.urlOrUUID}`,
                'It answers null when the asset does not exist, or when the content is not a valid meta.');
        }
        return ok({ uuid: saved.uuid, url: saved.url }, `Asset meta saved: ${saved.url}`);
    }
});

export const assetAdvancedGenerateAvailableUrl = defineTool({
    name: 'assetAdvanced_generate_available_url',
    description: 'The url the asset database would give a new asset at this location: the url itself '
        + 'when it is free, a numbered variant when it is taken. A collision pre-flight — ask this '
        + 'before project_create_asset instead of finding out from a rename.',
    schema: z.object({
        url: z.string().describe('Asset URL to check')
    }),
    aliases: { assetPath: 'url', path: 'url', assetUrl: 'url' },
    async handler(args, ctx) {
        let available: string;
        try {
            available = await ctx.editor.assetDb.generateAvailableUrl(args.url);
        } catch (error) {
            return fail('generate_failed', `No available url could be derived from ${args.url}: ${textOf(error)}`);
        }
        const free = available === args.url;
        return ok({ requestedUrl: args.url, availableUrl: available, free },
            free ? `${args.url} is free` : `${args.url} is taken; ${available} is free`);
    }
});

export const assetAdvancedQueryAssetDbReady = defineTool({
    name: 'assetAdvanced_query_asset_db_ready',
    description: 'Whether the asset database has finished starting up. Every asset answer read while '
        + 'this is false is about a half-imported project.',
    schema: z.object({}),
    async handler(_args, ctx) {
        const ready = await ctx.editor.assetDb.queryReady();
        return ok({ ready }, ready ? 'Asset database is ready' : 'Asset database is not ready');
    }
});

export const projectQueryAssetUuid = defineTool({
    name: 'project_query_asset_uuid',
    description: 'The uuid of the asset at a db:// url. Scenes and prefabs store references as uuids, '
        + 'so this is the translation from a path a human wrote to the identity the files carry.',
    schema: z.object({
        url: z.string().describe('Asset URL (db://assets/...)')
    }),
    aliases: URL_ALIASES,
    async handler(args, ctx) {
        const uuid = await ctx.editor.assetDb.queryUuid(args.url);
        if (!uuid) return fail('asset_not_found', `No asset at '${args.url}'`);
        return ok({ url: args.url, uuid });
    }
});

export const projectQueryAssetUrl = defineTool({
    name: 'project_query_asset_url',
    description: 'The db:// url of an asset uuid — the way a reference read out of a scene or prefab '
        + 'file is turned back into something a human can locate.',
    schema: z.object({
        uuid: z.string().describe('Asset UUID')
    }),
    async handler(args, ctx) {
        const url = await ctx.editor.assetDb.queryUrl(args.uuid);
        if (!url) return fail('asset_not_found', `No asset with uuid '${args.uuid}'`);
        return ok({ uuid: args.uuid, url });
    }
});

const VALIDATE_KINDS = ['scene', 'prefab', 'material', 'model'] as const;

type ValidateKind = typeof VALIDATE_KINDS[number];

const KIND_GLOBS: Record<ValidateKind, string> = {
    scene: '**/*.scene',
    prefab: '**/*.prefab',
    material: '**/*.{mtl,material}',
    model: '**/*.{fbx,gltf,glb}'
};

const DEFAULT_MAX_ASSETS = 400;
const DEFAULT_MAX_CHECKS = 1000;

const DUMP_DIR_FIELD = 'userData.materialDumpDir';

const kindListArg = z.preprocess(value => {
    if (typeof value !== 'string') return value;
    const coerced = coerceJsonArg(value);
    return coerced.coerced ? coerced.value : [value];
}, z.array(z.enum(VALIDATE_KINDS)));

interface BrokenReference {
    asset: string;
    ref: string;
    where: string;
    occurrences: number;
    reason: 'asset_missing' | 'sub_asset_missing';
}

interface DumpDirMissing {
    fbx: string;
    materialDumpDir: string;
    where: string;
}

interface ImporterPath {
    asset: string;
    path: string;
    where: string;
}

function kindOfUrl(url: string): ValidateKind {
    const lower = url.toLowerCase();
    if (lower.endsWith('.scene')) return 'scene';
    if (lower.endsWith('.prefab')) return 'prefab';
    if (lower.endsWith('.mtl') || lower.endsWith('.material')) return 'material';
    return 'model';
}

interface ProjectListing {
    known: Set<string>;
    subIds: Map<string, Set<string>>;
    unlisted: string[];
}

async function listProject(ctx: ToolContext): Promise<ProjectListing> {
    const known = new Set<string>();
    const subIds = new Map<string, Set<string>>();
    const unlisted: string[] = [];
    for (const root of ['db://assets', 'db://internal']) {
        let listed: EditorAssetInfo[];
        try {
            listed = await ctx.editor.assetDb.queryAssets({ pattern: `${root}/**/*` });
        } catch {
            unlisted.push(root);
            continue;
        }
        for (const asset of listed || []) {
            if (!asset || !asset.uuid) continue;
            known.add(asset.uuid);
            const ids = Object.keys(asset.subAssets || {});
            if (!ids.length) continue;
            const bucket = subIds.get(asset.uuid) || new Set<string>();
            for (const id of ids) {
                bucket.add(id);
                known.add(`${asset.uuid}@${id}`);
            }
            subIds.set(asset.uuid, bucket);
        }
    }
    return { known, subIds, unlisted };
}

/** `undefined` is the database declining to answer, and is never evidence that something is gone. */
function assetProbe(ctx: ToolContext) {
    const infos = new Map<string, EditorAssetInfo | null | undefined>();
    const subIds = new Map<string, Set<string>>();
    return {
        async info(ref: string): Promise<EditorAssetInfo | null | undefined> {
            if (!infos.has(ref)) {
                infos.set(ref, await ctx.editor.assetDb.queryAssetInfo(ref).catch(() => undefined));
            }
            return infos.get(ref);
        },
        async subAssetIds(base: string, owner: EditorAssetInfo): Promise<Set<string>> {
            const cached = subIds.get(base);
            if (cached) return cached;
            const ids = new Set(Object.keys(owner.subAssets || {}));
            if (!ids.size) {
                const meta = await ctx.editor.assetDb.queryAssetMeta(base).catch(() => null);
                for (const id of Object.keys(meta?.subMetas || {})) ids.add(id);
            }
            subIds.set(base, ids);
            return ids;
        }
    };
}

type Probe = ReturnType<typeof assetProbe>;

async function confirmMissing(
    probe: Probe,
    ref: string
): Promise<'present' | 'asset_missing' | 'sub_asset_missing' | 'unverified'> {
    const sub = subIdOf(ref);
    const direct = await probe.info(ref);
    if (direct === undefined) return 'unverified';
    if (direct) return 'present';
    if (!sub) return 'asset_missing';

    const base = baseUuidOf(ref);
    const owner = await probe.info(base);
    if (owner === undefined) return 'unverified';
    if (!owner) return 'asset_missing';

    const ids = await probe.subAssetIds(base, owner);
    if (!ids.size) return 'unverified';
    return ids.has(sub) ? 'present' : 'sub_asset_missing';
}

/** The project prefix a db:// url maps to on disk, learned from an asset that is stored under it. */
function diskRootFor(url: string, file: string): string | null {
    if (url.includes('/framework/')) return null;
    const suffix = url.slice('db://'.length).split('/').join(path.sep);
    const normalized = file.split('/').join(path.sep);
    return normalized.endsWith(suffix) ? normalized.slice(0, normalized.length - suffix.length) : null;
}

function settleDiskRoot(votes: Map<string, number>): string | null {
    const ranked = [...votes.entries()].sort((left, right) => right[1] - left[1]);
    if (!ranked.length) return null;
    if (ranked[0][1] >= 2) return ranked[0][0];
    return ranked.length === 1 ? ranked[0][0] : null;
}

async function verifyDbPath(
    probe: Probe,
    diskRoot: string | null,
    dbPath: string
): Promise<'present' | 'missing' | 'unverified'> {
    if (diskRoot && dbPath.startsWith('db://assets/')) {
        const onDisk = diskRoot + dbPath.slice('db://'.length).split('/').join(path.sep);
        return fs.existsSync(onDisk) ? 'present' : 'missing';
    }
    // A null for a FOLDER url is not known to mean absence, so it clears nothing and accuses nothing.
    return (await probe.info(dbPath)) ? 'present' : 'unverified';
}

export const assetAdvancedValidateAssetReferences = defineTool({
    name: 'assetAdvanced_validate_asset_references',
    description: 'Read every uuid reference out of the project\'s serialized assets and name the ones '
        + 'nothing answers. Scenes, prefabs and materials are parsed for `__uuid__` fields and for the '
        + 'packed 23-char `__type__` a script component stores; model .meta files are read for the '
        + 'materials and textures the importer bound and for the absolute db:// paths it keeps — a '
        + 'materialDumpDir that no longer exists is the failure that re-dumps every material without '
        + 'textures and renders the model flat. A `uuid@subId` reference is settled by the sub-id, not by '
        + 'its owning asset being there, and nothing is ever called broken without the asset database '
        + 'confirming it, so a builtin the listing does not carry is never reported as broken. A `suspect` '
        + 'is only a reference the fast project listing did not answer for — a question, not a finding. '
        + 'Findings are split: '
        + '`brokenReferences`, `dumpDirsMissing`, `missingImporterPaths`, and what could not be settled at '
        + 'all in `unverifiedRefs`/`unverifiedPaths`. What was NOT checked is stated in `limits`.',
    schema: z.object({
        folder: z.string().optional().describe('Folder to scan (default db://assets)'),
        kinds: kindListArg.optional()
            .describe(`Asset kinds to read (default all): ${VALIDATE_KINDS.join(', ')}`),
        maxAssets: z.coerce.number().int().min(1).max(5000).optional()
            .describe(`Cap on assets read (default ${DEFAULT_MAX_ASSETS}); the answer reports scanned vs found`),
        maxChecks: z.coerce.number().int().min(1).max(5000).optional()
            .describe(`Cap on database confirmations of suspect references (default ${DEFAULT_MAX_CHECKS})`)
    }),
    aliases: { root: 'folder', path: 'folder', assetPath: 'folder', kind: 'kinds', types: 'kinds' },
    async handler(args, ctx) {
        const folder = (args.folder || 'db://assets').replace(/\/+$/, '');
        const kinds = args.kinds?.length ? [...new Set(args.kinds)] : [...VALIDATE_KINDS];
        const maxAssets = args.maxAssets ?? DEFAULT_MAX_ASSETS;
        const maxChecks = args.maxChecks ?? DEFAULT_MAX_CHECKS;

        const byUuid = new Map<string, EditorAssetInfo>();
        for (const kind of kinds) {
            let listed: EditorAssetInfo[];
            try {
                listed = await ctx.editor.assetDb.queryAssets({ pattern: `${folder}/${KIND_GLOBS[kind]}` });
            } catch (error) {
                return fail('query_failed', `${kind} assets under ${folder} could not be listed: ${textOf(error)}`);
            }
            for (const asset of listed || []) {
                if (asset && asset.uuid && !asset.isDirectory) byUuid.set(asset.uuid, asset);
            }
        }
        const found = [...byUuid.values()];
        const assets = found.slice(0, maxAssets);

        const sightings = new Map<string, { asset: string; where: string; occurrences: number }>();
        const dbPathSites: ImporterPath[] = [];
        const unreadable: Array<{ asset: string; message: string }> = [];
        const rootVotes = new Map<string, number>();
        let scanned = 0;

        for (const asset of assets) {
            const diskPath = await diskPathOf(ctx, asset);
            if (!diskPath) {
                unreadable.push({ asset: asset.url, message: 'the asset database gave no on-disk path' });
                continue;
            }
            const candidate = diskRootFor(asset.url, diskPath);
            if (candidate) rootVotes.set(candidate, (rootVotes.get(candidate) || 0) + 1);
            const kind = kindOfUrl(asset.url);
            const file = kind === 'model' ? `${diskPath}.meta` : diskPath;
            let json: unknown;
            try {
                json = JSON.parse(fs.readFileSync(file, 'utf8'));
            } catch (error) {
                unreadable.push({ asset: asset.url, message: textOf(error) });
                continue;
            }
            scanned++;

            let sites: ReferenceSite[];
            if (kind === 'model') {
                const scan = scanModelMeta(json);
                sites = scan.refs;
                for (const site of scan.dbPaths) {
                    if (site.where === DUMP_DIR_FIELD && !scan.dumpMaterials) continue;
                    dbPathSites.push({ asset: asset.url, path: site.path, where: site.where });
                }
            } else {
                sites = scanReferenceSites(json);
            }
            for (const site of sites) {
                const seen = sightings.get(site.ref);
                if (seen) seen.occurrences++;
                else sightings.set(site.ref, { asset: asset.url, where: site.where, occurrences: 1 });
            }
        }

        const refs = [...sightings.keys()];
        const { known, subIds, unlisted } = await listProject(ctx);
        const suspects = findBroken(refs, known);
        const listedMissing = new Set(findMissingSubAssets(suspects, subIds));
        const settledByListing = (ref: string): boolean => {
            const sub = subIdOf(ref);
            const ids = sub === null ? undefined : subIds.get(baseUuidOf(ref));
            return !!ids && ids.size > 0;
        };

        const probe = assetProbe(ctx);
        const brokenReferences: BrokenReference[] = [];
        const unverifiedRefs: string[] = [];
        let confirmed = 0;
        const report = (ref: string, reason: 'asset_missing' | 'sub_asset_missing'): void => {
            const sighting = sightings.get(ref)!;
            brokenReferences.push({
                asset: sighting.asset, ref, where: sighting.where,
                occurrences: sighting.occurrences, reason
            });
        };

        const skippedByCap: string[] = [];
        for (const ref of suspects) {
            if (settledByListing(ref) && !listedMissing.has(ref)) continue;
            if (confirmed >= maxChecks) {
                skippedByCap.push(ref);
                continue;
            }
            confirmed++;
            const verdict = await confirmMissing(probe, ref);
            if (verdict === 'present') continue;
            if (verdict === 'unverified') unverifiedRefs.push(ref);
            else report(ref, verdict);
        }

        const dumpDirsMissing: DumpDirMissing[] = [];
        const missingImporterPaths: ImporterPath[] = [];
        const unverifiedPaths: ImporterPath[] = [];
        const pathVerdicts = new Map<string, 'present' | 'missing' | 'unverified'>();
        for (const site of dbPathSites) {
            let verdict = pathVerdicts.get(site.path);
            if (!verdict) {
                verdict = await verifyDbPath(probe, settleDiskRoot(rootVotes), site.path);
                pathVerdicts.set(site.path, verdict);
            }
            if (verdict === 'present') continue;
            if (verdict === 'unverified') {
                unverifiedPaths.push(site);
            } else if (site.where === DUMP_DIR_FIELD) {
                dumpDirsMissing.push({ fbx: site.asset, materialDumpDir: site.path, where: site.where });
            } else {
                missingImporterPaths.push(site);
            }
        }

        const limits = [
            'Only .scene, .prefab, .mtl/.material and model (.fbx/.gltf/.glb) .meta files are read; '
            + 'animation clips, textures, binary artifacts and every other importer format are not scanned.',
            'Inside a model .meta only assetFinder.materials/textures, imageMetas[].uri and '
            + 'imageUuidOrDatabaseUri count as references; the model\'s own meshes, skeletons and scenes '
            + 'are not checked.',
            'A packed 23-char `__type__` is checked as a script ASSET uuid: a class renamed or removed '
            + 'inside a script that still exists is invisible here. A class NAME of exactly 23 characters '
            + 'whose first five are hex digits and whose rest are base64 would unpack to a uuid and be '
            + 'reported as a missing script.',
            '`__id__` links and prefab property overrides address entries inside the same file, not '
            + 'assets, and are not reference candidates.',
            'A `uuid@subId` reference is settled against the sub-assets its owning asset reports; when the '
            + 'owner reports none, the sub-id is NOT checked and the reference is listed in unverifiedRefs.',
            'db:// paths from importer settings are read only from the model metas that were scanned, and '
            + 'settled on disk when the project layout could be derived from a scanned asset; otherwise the '
            + 'asset database is asked and a null answer for a FOLDER url counts as unverified, never as '
            + 'missing. Whether query-asset-info answers for directories at all is not yet confirmed '
            + 'against a live editor.'
        ];
        if (found.length > assets.length) {
            limits.push(`${found.length - assets.length} of ${found.length} matched assets were not read `
                + '— raise maxAssets.');
        }
        if (skippedByCap.length) {
            limits.push(`${skippedByCap.length} suspect reference(s) were never asked about: the `
                + `${maxChecks}-confirmation cap was reached — raise maxChecks.`);
        }
        if (unverifiedRefs.length) {
            limits.push(`${unverifiedRefs.length} reference(s) got no answer from the database (it refused `
                + 'the query, or the owning asset reports no sub-assets), so they are neither cleared nor broken.');
        }
        if (unverifiedPaths.length) {
            limits.push(`${unverifiedPaths.length} importer db:// path(s) could not be settled either on `
                + 'disk or by the database; they are listed in unverifiedPaths and accused of nothing.');
        }
        if (unlisted.length) {
            limits.push(`${unlisted.join(', ')} could not be listed, so the fast filter was narrower and `
                + 'more references had to be confirmed one by one.');
        }
        if (unreadable.length) {
            limits.push(`${unreadable.length} asset(s) could not be read or parsed; they are listed in unreadable.`);
        }

        return ok({
            folder,
            kinds,
            found: found.length,
            scanned,
            references: refs.length,
            suspects: suspects.length,
            confirmed,
            brokenReferences,
            dumpDirsMissing,
            missingImporterPaths,
            unverifiedRefs,
            unverifiedPaths,
            skippedByCap,
            unreadable,
            limits
        }, `${scanned} asset(s) read, ${refs.length} distinct reference(s). `
            + `FINDINGS: ${brokenReferences.length} broken, ${dumpDirsMissing.length} missing dump dir(s), `
            + `${missingImporterPaths.length} missing importer path(s). `
            + `${suspects.length} reference(s) the project listing did not answer for went on to be checked `
            + `(${confirmed} asked of the database, ${skippedByCap.length} skipped by the cap) — a suspect `
            + `is a question, not a finding. ${unverifiedRefs.length + unverifiedPaths.length} left unverified.`);
    }
});

export const assetTools: RegisteredTool[] = [
    projectGetAssets,
    projectGetAssetInfo,
    projectCreateAsset,
    projectDeleteAsset,
    projectCopyAsset,
    projectMoveAsset,
    projectImportAsset,
    projectReimportAsset,
    projectRefreshAssets,
    projectSaveAsset,
    projectQueryAssetUuid,
    projectQueryAssetUrl,
    assetAdvancedSaveAssetMeta,
    assetAdvancedGenerateAvailableUrl,
    assetAdvancedQueryAssetDbReady,
    assetAdvancedValidateAssetReferences
];
