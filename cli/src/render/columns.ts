/**
 * Listings are padded with spaces rather than boxed: they are read with grep, and a box border
 * lands in every line pulled out of one.
 */
export function padRight(text: string, width: number): string {
    return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function columnWidth(rows: ReadonlyArray<readonly string[]>, column: number): number {
    return rows.reduce((widest, row) => Math.max(widest, (row[column] || '').length), 0);
}

/** The last column is left ragged: padding it would only put trailing spaces on every line. */
export function table(rows: ReadonlyArray<readonly string[]>): string[] {
    const columns = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
    const widths = Array.from({ length: Math.max(columns - 1, 0) }, (_, column) => columnWidth(rows, column));
    return rows.map(row => row
        .map((cell, column) => column < widths.length ? padRight(cell, widths[column]) : cell)
        .join('  ')
        .trimEnd());
}
