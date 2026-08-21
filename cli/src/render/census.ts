import { table } from './columns.ts';
import type { Verdict } from './verdict.ts';
import type { CensusResult, KeyReport, UnresolvedSite, UsageSite } from '../ecs/census.ts';
import type { UnreadableFile } from '../ecs/kit.ts';

interface Finding {
    word: string;
    /** The half of the key that is not empty — who is left reading it, or left writing it. */
    sites: UsageSite[];
}

/**
 * The three findings, in the words the listing is grepped by. They are read off the lists the
 * census already drew rather than re-derived from the counts, so the listing and the summary cannot
 * disagree about which keys are flagged.
 */
function findings(result: CensusResult): Map<string, Finding> {
    const found = new Map<string, Finding>();
    for (const report of result.readWithoutWriter) {
        found.set(report.key, { word: 'read without a writer', sites: report.readers });
    }
    for (const report of result.writtenNeverRead) {
        found.set(report.key, { word: 'written never read', sites: [...report.writers, ...report.adders] });
    }
    for (const declaration of result.declaredNeverUsed) {
        found.set(declaration.key, { word: 'never used', sites: [] });
    }
    return found;
}

function countsOf(report: KeyReport): string {
    return `readers ${report.counts.readers}  writers ${report.counts.writers}`
        + `  adders ${report.counts.adders}  removers ${report.counts.removers}`;
}

function indented(rows: ReadonlyArray<readonly string[]>): string[] {
    return table(rows).map(line => `  ${line}`);
}

function blindSection(title: string, sites: readonly UnresolvedSite[]): string[] {
    if (!sites.length) return [];
    return [title, ...indented(
        sites.map(site => [`${site.file}:${site.line}`, site.fn, site.text, site.reason]))];
}

export function renderCensus(result: CensusResult, unreadable: readonly UnreadableFile[]): string {
    if (!result.keysDeclared) return 'no interface Entity is declared under this kit';

    const found = findings(result);
    const lines: string[] = [];
    table(result.keys.map(report => [
        report.key, report.declaredType, countsOf(report), report.declaredIn,
        found.get(report.key)?.word ?? ''
    ])).forEach((line, index) => {
        lines.push(line);
        const sites = found.get(result.keys[index].key)?.sites ?? [];
        if (sites.length) {
            lines.push(...indented(
                sites.map(site => [site.kind, `${site.file}:${site.line}`, site.fn, site.text])));
        }
    });

    lines.push(...blindSection('unresolved', result.unresolved));
    lines.push(...blindSection('not a declared key', result.suspectEntityLiteralProperties));
    if (result.parseErrors.length) {
        lines.push('unparsed', ...indented(result.parseErrors.map(entry => [entry.file, entry.message])));
    }
    if (unreadable.length) {
        lines.push('unread', ...indented(unreadable.map(entry => [entry.file, entry.message])));
    }
    return lines.join('\n');
}

/**
 * A sweep that did not read the whole kit answers about the part it read, and a key can look
 * unwritten because its writer sat in the file that went unread. A `--kit` narrower than the asset
 * tree is that same situation chosen deliberately, and it gets the same word: the caller asking for
 * the narrowing does not make the finding any more confirmed.
 */
export function censusVerdict(result: CensusResult, narrowed: boolean): Verdict {
    return narrowed || result.filesSkipped > 0 || result.parseErrors.length > 0
        ? 'UNVERIFIED'
        : 'ok';
}

export function censusSummary(result: CensusResult, root: string, narrowed: boolean): string {
    return [
        [
            `${censusVerdict(result, narrowed)}  ${root}`,
            `keys ${result.keysDeclared} in ${result.filesAnalysed} files`,
            `read without a writer: ${result.readWithoutWriter.length}`,
            `written never read: ${result.writtenNeverRead.length}`,
            `never used: ${result.declaredNeverUsed.length}`,
            result.filesSkipped ? `files skipped: ${result.filesSkipped}` : '',
            result.parseErrors.length ? `parse errors: ${result.parseErrors.length}` : ''
        ].filter(Boolean).join('  '),
        'structural analysis, no type checker — --json carries the limits and every site',
        narrowed ? 'the sweep was narrowed to --kit: a writer outside it is not counted' : ''
    ].filter(Boolean).join('\n');
}
