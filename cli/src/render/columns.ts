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
