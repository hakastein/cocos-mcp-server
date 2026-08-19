import { Hello, pipePath } from '@cocos-cli/shared';
import { discover, probeAddress, selectInstance } from './discovery';
import { DriverClient } from './driver-client';

export type Resolved =
    | { ok: true; client: DriverClient; hello: Hello }
    | { ok: false; message: string };

export async function resolveClient(wanted?: string): Promise<Resolved> {
    const candidates = await discover(probeAddress);
    const selection = selectInstance(candidates, wanted);
    if (!selection.ok) return selection;
    const client = await DriverClient.connect(pipePath(selection.chosen.projectPath));
    return { ok: true, client, hello: selection.chosen };
}
