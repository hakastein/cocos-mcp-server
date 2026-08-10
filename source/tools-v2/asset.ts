import * as fs from 'fs';
import * as path from 'path';
import PQueue from 'p-queue';
import { z } from 'zod';
import { booleanArg, defineTool } from '../tool';
import { ok, fail } from '../result';
import { textOf } from './shared';
import { ASSET_TYPES, assetQuery, selectAssets } from '../asset-query';
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
    assetAdvancedQueryAssetDbReady
];
