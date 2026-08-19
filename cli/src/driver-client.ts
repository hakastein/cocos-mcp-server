import * as net from 'net';
import split2 from 'split2';
import { JSONRPCClient } from 'json-rpc-2.0';
import { EDITOR_METHODS } from '@cocos-cli/shared';

export interface SceneFacade {
    call(method: string, ...args: unknown[]): Promise<unknown>;
}

export type EditorFacade = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;

export class DriverClient {
    readonly editor: EditorFacade;
    readonly scene: SceneFacade;

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
        this.scene = { call: (method, ...args) => Promise.resolve(this.rpc.request(`scene.${method}`, args)) };
    }

    static connect(address: string): Promise<DriverClient> {
        return new Promise((resolve, reject) => {
            const socket = net.connect(address);
            const rpc = new JSONRPCClient(request => {
                socket.write(JSON.stringify(request) + '\n');
                return Promise.resolve();
            });
            socket.pipe(split2()).on('data', (line: string) => {
                if (!line.trim()) return;
                try { rpc.receive(JSON.parse(line)); } catch { }
            });
            socket.on('error', reject);
            socket.on('close', () =>
                rpc.rejectAllPendingRequests('соединение с редактором закрылось'));
            socket.on('connect', () => resolve(new DriverClient(socket, rpc)));
        });
    }

    close(): void {
        this.socket.destroy();
    }
}
