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
        : path.posix.join(pipeDirectory(platform, tmp), `${key}.sock`);
}
