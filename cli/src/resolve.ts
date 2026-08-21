import { pipePath } from '@cocos-cli/shared';
import type { Driver, Hello } from '@cocos-cli/shared';
import { discover, probeAddress, selectInstance } from './discovery.ts';
import { DriverClient } from './driver/client.ts';

export type Resolved =
    | { ok: true; client: DriverClient; hello: Hello }
    | { ok: false; message: string };

export type ResolvedProject =
    | { ok: true; hello: Hello }
    | { ok: false; message: string };

/** Which editor is meant, without opening a connection to it. */
export async function resolveProject(wanted?: string): Promise<ResolvedProject> {
    const candidates = await discover(probeAddress);
    const selection = selectInstance(candidates, wanted);
    return selection.ok ? { ok: true, hello: selection.chosen } : selection;
}

export async function resolveClient(wanted?: string): Promise<Resolved> {
    const project = await resolveProject(wanted);
    if (!project.ok) return project;
    const client = await DriverClient.connect(pipePath(project.hello.projectPath));
    return { ok: true, client, hello: project.hello };
}
