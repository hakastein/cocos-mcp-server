import type {
    ComponentOwnerReport, Hello, MissingScriptDump, PrefabAssetDump, PrefabOverrideReport,
    SceneDirtyReport, WriteReport
} from '@cocos-cli/shared';
import { verdictFailed } from './verdict';
import {
    assetField, assetListSummary, renderAssetInfo, renderAssetList, renderSettleReport, settleNote,
    settleVerdict
} from './asset';
import { nodeWriteNote, nodeWriteVerdict, renderNodeWrite } from './node';
import { renderWriteReport, writeVerdict } from './report';
import { renderTree } from './tree';
import { renderInstances } from './instances';
import { formatReading, renderComponentReading } from './property';
import { prefabDumpSummary, prefabOverridesSummary, renderPrefabDump, renderPrefabOverrides } from './prefab';
import {
    componentOwnersSummary, renderComponentOwners, renderMissingScripts, renderSceneDirty, sceneDirtyNote
} from './scene';
import type { Verdict } from './verdict';
import type { SettleReport } from './asset';
import type { NodeWriteReport } from './node';
import type { DumpNode, TreeOptions } from './tree';
import type { AssetRecord } from '../asset/query';
import type { ComponentChoice, PropertyReading } from '../property/component-dump';
import type { ReferenceLabel } from '../property/reference-index';

export type { SettleReport } from './asset';
export type { AppliedWrite, NodeWriteReport, UnappliedWrite } from './node';
export type { DumpNode } from './tree';

export interface CommandOutput {
    stdout?: string;
    stderr?: string;
    /** Команда отработала, но её результат — не успех: см. `verdictFailed`. */
    failed?: boolean;
}

export interface PresentOptions {
    json?: boolean;
}

/** Узел и компонент, о которых отчёт, в том виде, в каком их называет `--json`. */
export interface ComponentAddress {
    nodePath: string;
    nodeUuid: string;
    choice: ComponentChoice;
}

/**
 * Отчёт называет, что произошло; во что это превращается на двух потоках и в коде выхода, решает
 * `present`. Объединение размечено `kind`, поэтому новый вид отчёта не добавить, не назвав его
 * вердикт, — на это и заведено.
 */
export type Report =
    /** Исход, у которого нет структуры сверх одной строки: вердикт и свободный хвост. */
    | { kind: 'action'; verdict: Verdict; summary: string; note?: string }
    | {
        kind: 'propertyWrite'; component: string; property: string; value?: unknown;
        report: WriteReport; undoNote?: string;
    }
    | { kind: 'nodeWrite'; write: NodeWriteReport }
    | { kind: 'assetSettle'; settle: SettleReport; timeoutMs: number; note?: string }
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
    /** Что печатает `--json`; отсутствие означает, что структурной формы у отчёта нет. */
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
                text: `${report.verdict}  ${report.summary}`,
                note: report.note
            };

        case 'propertyWrite':
            return { verdict: writeVerdict(report.report), text: renderWriteReport(report) };

        case 'nodeWrite':
            return {
                verdict: nodeWriteVerdict(report.write),
                text: renderNodeWrite(report.write),
                note: nodeWriteNote(report.write)
            };

        case 'assetSettle':
            return {
                verdict: settleVerdict(report.settle),
                text: renderSettleReport(report.settle),
                note: joined([settleNote(report.settle, report.timeoutMs), report.note], '\n')
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
                text: report.nodes.length ? renderTree(report.nodes, report.options) : 'сцена пуста — нет узлов',
                note: `узлов: ${report.nodes.length}`
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
                note: `${verdict}  мёртвых компонентов: ${report.missing.entries.length}`
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
                    `${address.choice.className}.${reading.name}  ${reading.type || 'тип не объявлен'}`,
                    reading.differsFromDefault === true && 'отличается от умолчания',
                    reading.hiddenInInspector && 'инспектор его не рисует, в файле оно есть',
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
                    `${address.choice.className} на ${address.nodePath}  enabled=${
                        address.choice.enabled === null ? 'unknown' : address.choice.enabled}`,
                    `свойств: ${readings.length}`,
                    hidden.length > 0
                        && `скрыто: ${hidden.length} (служебные поля и дубли-хранилища, каждое читается через --prop)`,
                    readings.some(reading => reading.differsFromDefault === true)
                        && '* — отличается от умолчания',
                    address.choice.sameClassCount > 1
                        && `на узле ${address.choice.sameClassCount} компонента этого класса, прочитан первый`,
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
