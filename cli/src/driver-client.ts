import * as net from 'net';
import split2 from 'split2';
import { JSONRPCClient } from 'json-rpc-2.0';
import { EDITOR_METHODS } from '@cocos-cli/shared';
import type { SceneMethods } from '@cocos-cli/shared/dist/scene-contract';

export interface SceneFacade {
    call<K extends keyof SceneMethods>(
        method: K, ...args: Parameters<SceneMethods[K]>
    ): Promise<Awaited<ReturnType<SceneMethods[K]>>>;
}

export type EditorFacade = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;

export class DriverClient {
    readonly editor: EditorFacade;
    readonly scene: SceneFacade;
    private isClosed = false;

    private constructor(
        private readonly socket: net.Socket,
        private readonly rpc: JSONRPCClient
    ) {
        const editor: EditorFacade = {};
        for (const name of EDITOR_METHODS) {
            const [group, method] = name.split('.');
            editor[group] = editor[group] || {};
            editor[group][method] = (...args: unknown[]) => Promise.resolve(this.rpc.request(`editor.${name}`, args));
        }
        this.editor = editor;
        this.scene = {
            call: <K extends keyof SceneMethods>(method: K, ...args: Parameters<SceneMethods[K]>) =>
                Promise.resolve(this.rpc.request(`scene.${method}`, args)) as
                    Promise<Awaited<ReturnType<SceneMethods[K]>>>
        };
    }

    static connect(address: string): Promise<DriverClient> {
        return new Promise((resolve, reject) => {
            const socket = net.connect(address);
            const rpc = new JSONRPCClient(request => {
                if (socket.destroyed) {
                    return Promise.reject(new Error('соединение с редактором закрыто'));
                }
                socket.write(JSON.stringify(request) + '\n');
                return Promise.resolve();
            });
            socket.pipe(split2()).on('data', (line: string) => {
                if (!line.trim()) return;
                try { rpc.receive(JSON.parse(line)); } catch { }
            });
            socket.once('error', reject);
            socket.on('close', () =>
                rpc.rejectAllPendingRequests('соединение с редактором закрылось'));
            socket.once('connect', () => resolve(new DriverClient(socket, rpc)));
        });
    }

    close(): void {
        this.isClosed = true;
        this.socket.destroy();
    }
}
