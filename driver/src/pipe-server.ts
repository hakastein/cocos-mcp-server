import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { createHash } from 'crypto';
import split2 from 'split2';
import PQueue from 'p-queue';
import { JSONRPCServer } from 'json-rpc-2.0';
import { ALL_METHODS, pipePath } from '@cocos-cli/shared';
import type { Hello } from '@cocos-cli/shared';
import { resolveMethod } from './method-table.ts';
import type { EditorApi } from './editor-api.ts';
import type { SceneScriptClient } from './scene-script-client.ts';
import type { DriverSettings, DriverStatus } from './types/index.ts';

const VERSION = '2.0.0';

const BEGIN_RECORDING = 'editor.scene.beginRecording';
const END_RECORDING = 'editor.scene.endRecording';
const CANCEL_RECORDING = 'editor.scene.cancelRecording';

function surfaceChecksum(): string {
    return createHash('sha1').update(ALL_METHODS.join('\n')).digest('hex').slice(0, 12);
}

export class PipeServer {
    private server: net.Server | null = null;
    private readonly sockets = new Set<net.Socket>();
    private readonly queue = new PQueue({ concurrency: 1 });
    private readonly rpc = new JSONRPCServer<net.Socket>();
    private readonly address = pipePath(Editor.Project.path);

    // bracketOwner blocks other sockets' calls while a bracket is open; the queue alone can't, since it sits empty between an undo bracket's round-trips.
    private bracketOwner: net.Socket | null = null;
    private bracketUndoId: string | null = null;
    private bracketGate: Promise<void> = Promise.resolve();
    private releaseBracketGate: (() => void) | null = null;

    private readonly editor: EditorApi;
    private readonly scene: SceneScriptClient;
    private readonly settings: DriverSettings;

    constructor(editor: EditorApi, scene: SceneScriptClient, settings: DriverSettings) {
        this.editor = editor;
        this.scene = scene;
        this.settings = settings;
        this.rpc.addMethod('hello', async (): Promise<Hello> => ({
            project: path.basename(Editor.Project.path),
            projectPath: Editor.Project.path,
            pid: process.pid,
            version: VERSION,
            surfaceChecksum: surfaceChecksum()
        }));

        for (const name of ALL_METHODS) {
            this.rpc.addMethod(name, async (params: unknown, socket: net.Socket) => {
                // Waiting outside queue.add, not inside it, so the owner's own calls still get the sole concurrency:1 slot.
                while (this.bracketOwner && this.bracketOwner !== socket) {
                    await this.bracketGate;
                }
                if (name === BEGIN_RECORDING && this.bracketOwner === null) {
                    this.holdBracket(socket);
                }

                return this.queue.add(async () => {
                    const fn = resolveMethod(name, this.editor, this.scene);
                    if (!fn) throw new Error(`driver does not carry '${name}'`);
                    try {
                        const result = await fn(...(Array.isArray(params) ? params : []));
                        if (name === BEGIN_RECORDING) {
                            if (this.bracketOwner === socket) {
                                this.bracketUndoId = result as string;
                            } else {
                                // The close handler already freed the bracket without this id, because
                                // it ran before beginRecording resolved. Cancel with the id it now has.
                                this.editor.scene.cancelRecording(result as string).catch(
                                    (error: unknown) => console.warn('[cocos-cli] dangling undo bracket:', error));
                            }
                        }
                        return result;
                    } catch (error) {
                        if (name === BEGIN_RECORDING && this.bracketOwner === socket) this.freeBracket();
                        throw error;
                    } finally {
                        if ((name === END_RECORDING || name === CANCEL_RECORDING)
                            && this.bracketOwner === socket) {
                            this.freeBracket();
                        }
                    }
                });
            });
        }
    }

    private holdBracket(owner: net.Socket): void {
        this.bracketOwner = owner;
        this.bracketUndoId = null;
        this.bracketGate = new Promise<void>(resolve => { this.releaseBracketGate = resolve; });
    }

    private freeBracket(): void {
        this.bracketOwner = null;
        this.bracketUndoId = null;
        this.releaseBracketGate?.();
        this.releaseBracketGate = null;
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
        // `once` above only covers the listen race; left alone it would eat the next fault and leave none for the one after, which Node then throws as fatal.
        server.on('error', (error: Error) => console.error('[cocos-cli] pipe server error:', error));
        this.server = server;
        console.log(`[cocos-cli] listening on ${this.address}`);
    }

    async stop(): Promise<void> {
        const server = this.server;
        this.server = null;
        if (!server) return;
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
     * An undo bracket survives several requests, so a connection dropped mid-bracket would
     * otherwise leave the editor recording forever. It is released with the socket, using the
     * undoId beginRecording actually returned — cancelRecording takes that as an argument, not
     * the fact that beginRecording was merely called.
     */
    private serve(socket: net.Socket): void {
        this.sockets.add(socket);
        socket.pipe(split2()).on('data', async (line: string) => {
            if (!line.trim()) return;
            let request: any;
            try { request = JSON.parse(line); } catch { return; }

            try {
                const response = await this.rpc.receive(request, socket);
                if (response && !socket.destroyed) socket.write(JSON.stringify(response) + '\n');
            } catch (error) {
                console.error('[cocos-cli] request handling failed:', error);
            }
        });
        socket.on('close', () => {
            this.sockets.delete(socket);
            if (this.bracketOwner !== socket) return;
            const undoId = this.bracketUndoId;
            this.freeBracket();
            if (undoId) {
                this.editor.scene.cancelRecording(undoId).catch(
                    (error: unknown) => console.warn('[cocos-cli] dangling undo bracket:', error));
            }
        });
        socket.on('error', () => socket.destroy());
    }
}
