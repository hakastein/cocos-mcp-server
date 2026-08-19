import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { createHash } from 'crypto';
import split2 from 'split2';
import PQueue from 'p-queue';
import { JSONRPCServer } from 'json-rpc-2.0';
import { ALL_METHODS, Hello, pipePath } from '@cocos-cli/shared';
import { resolveMethod } from './method-table';
import type { EditorApi } from './editor-api';
import type { SceneScriptClient } from './scene-script-client';
import type { DriverSettings, DriverStatus } from './types';

const VERSION = '2.0.0';

function surfaceChecksum(): string {
    return createHash('sha1').update(ALL_METHODS.join('\n')).digest('hex').slice(0, 12);
}

export class PipeServer {
    private server: net.Server | null = null;
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
     * бы редактор в записи навсегда. Открытая скобка снимается вместе с сокетом — по undoId,
     * который вернул сам beginRecording, а не по факту его вызова: cancelRecording требует
     * этот id аргументом, поэтому снятие держится на разборе ответа, а не на имени метода.
     */
    private serve(socket: net.Socket): void {
        let undoId: string | null = null;
        socket.pipe(split2()).on('data', async (line: string) => {
            if (!line.trim()) return;
            let request: any;
            try { request = JSON.parse(line); } catch { return; }

            const response = await this.rpc.receive(request);

            if (request.method === 'editor.scene.beginRecording') {
                undoId = response && response.result !== undefined ? String(response.result) : null;
            } else if (request.method === 'editor.scene.endRecording'
                || request.method === 'editor.scene.cancelRecording') {
                undoId = null;
            }

            if (response && !socket.destroyed) socket.write(JSON.stringify(response) + '\n');
        });
        socket.on('close', () => {
            if (!undoId) return;
            this.editor.scene.cancelRecording(undoId).catch(
                (error: unknown) => console.warn('[cocos-cli] dangling undo bracket:', error));
        });
        socket.on('error', () => socket.destroy());
    }
}
