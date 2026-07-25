import * as fs from 'fs';
import * as path from 'path';

/** This editor build has no `asset-db` `read-asset` message; resolve the on-disk path and read it. */
export async function resolveAssetFile(assetPath: string): Promise<string> {
    const info: any = await Editor.Message.request('asset-db', 'query-asset-info', assetPath);
    if (!info) throw new Error(`Asset not found: ${assetPath}`);
    // `info.source` is the db:// url; the absolute path is `info.file`.
    let file: string | null = info.file || null;
    if (!file) {
        file = await Editor.Message.request('asset-db', 'query-path', assetPath);
    }
    if (!file) throw new Error(`Could not resolve an on-disk path for: ${assetPath}`);
    const raw = file.startsWith('file://') ? file.slice('file://'.length) : file;
    return path.resolve(decodeURIComponent(raw));
}

export async function readAssetText(assetPath: string): Promise<string> {
    return fs.readFileSync(await resolveAssetFile(assetPath), 'utf8');
}

export async function readAssetJson(assetPath: string): Promise<any> {
    return JSON.parse(await readAssetText(assetPath));
}

export async function writeAssetJson(assetPath: string, data: any): Promise<void> {
    // Cocos writes these files with CRLF on Windows; keep whatever the file already uses so an
    // edit does not rewrite every line ending. JSON.stringify escapes newlines inside strings,
    // so only the formatting newlines are affected.
    let eol = '\n';
    try {
        if ((await readAssetText(assetPath)).includes('\r\n')) eol = '\r\n';
    } catch {
        // new file: default to LF
    }
    const text = JSON.stringify(data, null, 2).replace(/\n/g, eol);
    await Editor.Message.request('asset-db', 'save-asset', assetPath, text);
}
