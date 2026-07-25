import { createHash } from 'crypto';

export interface SignatureNode {
    path: string;
    active: boolean;
    activeInHierarchy: boolean;
    components?: { type: string }[];
}

export interface SignatureDiff {
    added: string[];
    removed: string[];
    changed: { path: string; before: string; after: string }[];
}

export function signatureOf(nodes: SignatureNode[]): Record<string, string> {
    const sig: Record<string, string> = {};
    for (const n of nodes) {
        const comps = (n.components || []).map((c) => c.type).sort().join(',');
        sig[n.path] = `a=${n.active ? 1 : 0} ah=${n.activeInHierarchy ? 1 : 0} c=${comps}`;
    }
    return sig;
}

export function hashSignature(sig: Record<string, string>): string {
    const canonical = Object.keys(sig).sort().map((k) => `${k}\t${sig[k]}`).join('\n');
    return createHash('sha1').update(canonical).digest('hex');
}

export function diffSignatures(before: Record<string, string>, after: Record<string, string>): SignatureDiff {
    return {
        added: Object.keys(after).filter((k) => !(k in before)).sort(),
        removed: Object.keys(before).filter((k) => !(k in after)).sort(),
        changed: Object.keys(after)
            .filter((k) => k in before && before[k] !== after[k])
            .sort()
            .map((path) => ({ path, before: before[path], after: after[path] }))
    };
}
