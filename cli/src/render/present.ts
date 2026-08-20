import type {
    ComponentOwnerReport, Hello, MissingScriptDump, PrefabAssetDump, PrefabOverrideReport,
    SceneDirtyReport
} from '@cocos-cli/shared';
import { verdictFailed } from './verdict.ts';
import {
    assetField, assetListSummary, assetNote, assetVerdict, renderAssetInfo, renderAssetList,
    renderAssetReport
} from './asset.ts';
import { renderWrites, undoDetail, writesVerdict } from './report.ts';
import { renderTree } from './tree.ts';
import { renderInstances } from './instances.ts';
import { formatReading, renderComponentReading } from './property.ts';
import { prefabDumpSummary, prefabOverridesSummary, renderPrefabDump, renderPrefabOverrides } from './prefab.ts';
import {
    componentOwnersSummary, renderComponentOwners, renderMissingScripts, renderSceneDirty, sceneDirtyNote
} from './scene.ts';
import type { Verdict } from './verdict.ts';
import type { AssetReport } from '../asset/settle.ts';
import type { RenderedWrite } from './report.ts';
import type { DumpNode, TreeOptions } from './tree.ts';
import type { AssetRecord } from '../asset/query.ts';
import type { ComponentChoice, PropertyReading } from '../property/component-dump.ts';
import type { ReferenceLabel } from '../property/reference-index.ts';

export type { RenderedWrite } from './report.ts';
export type { DumpNode } from './tree.ts';

export interface CommandOutput {
    stdout?: string;
    stderr?: string;
    /** The command ran and its outcome is not a success: see `verdictFailed`. */
    failed?: boolean;
}

export interface PresentOptions {
    json?: boolean;
}

/** The node and component a report is about, spelled the way `--json` names them. */
export interface ComponentAddress {
    nodePath: string;
    nodeUuid: string;
    choice: ComponentChoice;
}

/**
 * A report names what happened; `present` decides what that becomes on the two streams and in the
 * exit code. The union is tagged by `kind`, so a new report kind cannot be added without naming its
 * verdict — which is what the union is for.
 */
export type Report =
    /** An outcome with no structure beyond one line: a verdict and a free-text tail. */
    | { kind: 'action'; verdict: Verdict; summary: string; note?: string; undoNote?: string | null }
    /** Every write of one undo bracket, each judged on whether a save carries it. */
    | { kind: 'write'; target: string; writes: RenderedWrite[]; undoNote: string | null; note?: string }
    | { kind: 'asset'; asset: AssetReport; timeoutMs: number; note?: string }
    | { kind: 'assetInfo'; asset: AssetRecord; field?: string }
    | { kind: 'assetList'; assets: AssetRecord[]; total: number }
    | { kind: 'sceneTree'; nodes: DumpNode[]; options: TreeOptions }
    | { kind: 'sceneOwners'; owners: ComponentOwnerReport }
    | { kind: 'sceneDirty'; dirty: SceneDirtyReport }
    | { kind: 'sceneMissing'; missing: MissingScriptDump }
    | {
        kind: 'componentProperty'; address: ComponentAddress; reading: PropertyReading;
        references: Map<string, ReferenceLabel>; note?: string;
    }
    | {
        kind: 'componentProperties'; address: ComponentAddress; readings: PropertyReading[];
        hidden: string[]; references: Map<string, ReferenceLabel>; note?: string;
    }
    | { kind: 'prefabDump'; dump: PrefabAssetDump }
    | { kind: 'prefabOverrides'; overrides: PrefabOverrideReport }
    | { kind: 'instances'; instances: Hello[] };

interface Rendered {
    verdict: Verdict;
    text: string;
    /** What `--json` prints; its absence means the report has no structural form. */
    json?: unknown;
    note?: string;
}

function joined(parts: Array<string | false | undefined>, separator = '  '): string {
    return parts.filter(part => part).join(separator);
}

function addressJson(address: ComponentAddress): Record<string, unknown> {
    return {
        node: { path: address.nodePath, uuid: address.nodeUuid },
        component: {
            className: address.choice.className, cid: address.choice.cid,
            enabled: address.choice.enabled, index: address.choice.index
        }
    };
}

function referencesJson(index: Map<string, ReferenceLabel>): Record<string, ReferenceLabel> {
    const references: Record<string, ReferenceLabel> = {};
    for (const [uuid, label] of index) references[uuid] = label;
    return references;
}

function render(report: Report): Rendered {
    switch (report.kind) {
        case 'action':
            return {
                verdict: report.verdict,
                text: joined([
                    `${report.verdict}  ${report.summary}`,
                    report.undoNote !== undefined && undoDetail(report.undoNote)
                ]),
                note: report.note
            };

        case 'write':
            return {
                verdict: writesVerdict(report.writes),
                text: renderWrites(report),
                note: report.note
            };

        case 'asset':
            return {
                verdict: assetVerdict(report.asset),
                text: renderAssetReport(report.asset),
                note: joined([assetNote(report.asset, report.timeoutMs), report.note], '\n')
            };

        case 'assetInfo':
            return report.field
                ? { verdict: 'ok', text: assetField(report.asset, report.field) }
                : { verdict: 'ok', text: renderAssetInfo(report.asset), json: report.asset };

        case 'assetList':
            return {
                verdict: 'ok',
                text: renderAssetList(report.assets),
                json: report.assets,
                note: assetListSummary(report.assets.length, report.total)
            };

        case 'sceneTree':
            return {
                verdict: 'ok',
                text: report.nodes.length ? renderTree(report.nodes, report.options) : 'the scene is empty — no nodes',
                note: `nodes: ${report.nodes.length}`
            };

        case 'sceneOwners':
            return {
                verdict: 'ok',
                text: renderComponentOwners(report.owners),
                json: report.owners,
                note: componentOwnersSummary(report.owners)
            };

        case 'sceneDirty':
            return {
                verdict: 'ok',
                text: renderSceneDirty(report.dirty),
                json: report.dirty,
                note: sceneDirtyNote(report.dirty)
            };

        case 'sceneMissing': {
            const verdict: Verdict = report.missing.entries.length ? 'FAILED' : 'ok';
            return {
                verdict,
                text: renderMissingScripts(report.missing),
                json: report.missing,
                note: `${verdict}  dead components: ${report.missing.entries.length}`
            };
        }

        case 'componentProperty': {
            const { address, reading, references } = report;
            return {
                verdict: 'ok',
                text: formatReading(reading, uuid => references.get(uuid)),
                json: {
                    ...addressJson(address), property: reading, references: referencesJson(references)
                },
                note: joined([
                    `${address.choice.className}.${reading.name}  ${reading.type || 'type not declared'}`,
                    reading.differsFromDefault === true && 'differs from the default',
                    reading.hiddenInInspector && 'the inspector does not draw it, the file holds it',
                    report.note
                ])
            };
        }

        case 'componentProperties': {
            const { address, readings, hidden, references } = report;
            return {
                verdict: 'ok',
                text: renderComponentReading(readings, uuid => references.get(uuid)),
                json: {
                    ...addressJson(address), properties: readings, hidden,
                    references: referencesJson(references)
                },
                note: joined([
                    `${address.choice.className} on ${address.nodePath}  enabled=${
                        address.choice.enabled === null ? 'unknown' : address.choice.enabled}`,
                    `properties: ${readings.length}`,
                    hidden.length > 0
                        && `hidden: ${hidden.length} (internal fields and backing duplicates, each readable with --prop)`,
                    readings.some(reading => reading.differsFromDefault === true)
                        && '* — differs from the default',
                    address.choice.sameClassCount > 1
                        && `the node carries ${address.choice.sameClassCount} components of this class, the first was read`,
                    report.note
                ])
            };
        }

        case 'prefabDump':
            return {
                verdict: 'ok',
                text: renderPrefabDump(report.dump),
                json: report.dump,
                note: prefabDumpSummary(report.dump)
            };

        case 'prefabOverrides':
            return {
                verdict: 'ok',
                text: renderPrefabOverrides(report.overrides),
                json: report.overrides,
                note: prefabOverridesSummary(report.overrides)
            };

        case 'instances':
            return {
                verdict: 'ok',
                text: renderInstances(report.instances),
                json: report.instances
            };
    }
}

export function present(report: Report, options: PresentOptions = {}): CommandOutput {
    const rendered = render(report);
    return {
        stdout: options.json && rendered.json !== undefined
            ? JSON.stringify(rendered.json)
            : rendered.text,
        stderr: rendered.note || undefined,
        failed: verdictFailed(rendered.verdict)
    };
}
