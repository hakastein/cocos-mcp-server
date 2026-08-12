import { PACKED_CID, decompressUuid } from './prefab-json';

export type MissingVerdict = 'missing' | 'script_exists' | 'unverifiable';

export interface ScriptCidVerdict {
    cid: string;
    scriptUuid: string | null;
    verdict: MissingVerdict;
    reason: string;
}

/**
 * `cc.MissingScript` stands in both for a deleted script and for one the editor failed to load, and
 * a compile error produces the second for EVERY script at once. Only the asset database separates
 * them, so an unanswered lookup stays unverifiable instead of defaulting either way.
 */
export function verdictForCid(cid: string, assetExists: boolean | null): ScriptCidVerdict {
    if (!PACKED_CID.test(cid)) {
        return {
            cid,
            scriptUuid: null,
            verdict: 'unverifiable',
            reason: `'${cid}' is not a packed script uuid, so no asset can be looked up for it`
        };
    }
    const scriptUuid = decompressUuid(cid);
    if (assetExists === null) {
        return { cid, scriptUuid, verdict: 'unverifiable', reason: `the asset database was not asked about ${scriptUuid}` };
    }
    return assetExists
        ? { cid, scriptUuid, verdict: 'script_exists', reason: `${scriptUuid} is still in the asset database` }
        : { cid, scriptUuid, verdict: 'missing', reason: `no asset at ${scriptUuid}` };
}

const TYPE_FIELD = /"__type__"\s*:\s*"([^"]{23})"/g;

export function scriptCidsInAssetText(text: string): string[] {
    const found: string[] = [];
    const seen = new Set<string>();
    for (const match of text.matchAll(TYPE_FIELD)) {
        const cid = match[1];
        if (!PACKED_CID.test(cid) || seen.has(cid)) continue;
        seen.add(cid);
        found.push(cid);
    }
    return found;
}
