import { isKnownMethod } from '@cocos-cli/shared';

type AnyFn = (...args: unknown[]) => unknown;

export function resolveMethod(name: string, editor: unknown, scene: unknown): AnyFn | null {
    if (!isKnownMethod(name)) return null;

    if (name.startsWith('scene.')) {
        const method = name.slice('scene.'.length);
        const client = scene as { call: (method: string, ...args: unknown[]) => unknown };
        return (...args: unknown[]) => client.call(method, ...args);
    }

    const [, group, method] = name.split('.');
    const owner = (editor as Record<string, unknown>)[group];
    if (!owner || typeof owner !== 'object') return null;
    const fn = (owner as Record<string, unknown>)[method];
    if (typeof fn !== 'function') return null;
    return (...args: unknown[]) => (fn as AnyFn).apply(owner, args);
}
