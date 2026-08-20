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
            message: `no open Cocos editor with this extension found in ${pipeDirectory()}`
        };
    }

    if (!wanted) {
        if (candidates.length === 1) return { ok: true, chosen: candidates[0] };
        return {
            ok: false,
            message: 'several editors are open, name one with --project:\n'
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
            message: `'${wanted}' matches no open editor:\n`
                + candidates.map(h => `  ${label(h)}`).join('\n')
        };
    }
    return {
        ok: false,
        message: `several editors match '${wanted}', narrow it down:\n`
            + matched.map(h => `  ${label(h)}`).join('\n')
    };
}

export async function discover(
    probe: (address: string) => Promise<Hello | null>,
    list: () => string[] = listAddresses
): Promise<Hello[]> {
    const found = await Promise.allSettled(
        list().filter(name => name.startsWith(PIPE_PREFIX)).map(name => probe(addressOf(name))));
    return found
        .filter((r): r is PromiseFulfilledResult<Hello | null> => r.status === 'fulfilled')
        .map(r => r.value)
        .filter((hello): hello is Hello => hello !== null);
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
 * A POSIX socket outlives the editor that crashed; a Windows pipe does not. An address that does
 * not answer is dropped on a timeout, so a stale file does not hold up discovery.
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
