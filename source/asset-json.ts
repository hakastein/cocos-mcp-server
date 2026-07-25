import * as fs from 'fs';
import * as path from 'path';

/** This editor build has no `asset-db` `read-asset` message; resolve the on-disk path and read it. */
export async function resolveAssetFile(assetPath: string): Promise<string> {
    const info: any = await Editor.Message.request('asset-db', 'query-asset-info', assetPath);
    if (!info) throw new Error(`Asset not found: ${assetPath}`);
    if (!info.source) throw new Error(`Asset has no on-disk source: ${assetPath}`);
    const raw = info.source.startsWith('file://') ? info.source.slice('file://'.length) : info.source;
    return path.resolve(decodeURIComponent(raw));
}

export async function readAssetText(assetPath: string): Promise<string> {
    return fs.readFileSync(await resolveAssetFile(assetPath), 'utf8');
}

export async function readAssetJson(assetPath: string): Promise<any> {
    return JSON.parse(await readAssetText(assetPath));
}

export async function writeAssetJson(assetPath: string, data: any): Promise<void> {
    await Editor.Message.request('asset-db', 'save-asset', assetPath, JSON.stringify(data, null, 2));
}
