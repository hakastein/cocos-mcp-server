/**
 * The names one property answers to. The serializer stores an accessor under its backing field, so
 * `color` is emitted, dumped and overridden as `_color` — a caller who spelled the accessor is
 * asking about both. A path that already carries an underscored segment is spelled one way only.
 */
export function propertySpellings(propertyPath: string): string[] {
    const underscored = propertyPath.replace(/(^|\.)([^.]+)$/, '$1_$2');
    return underscored === propertyPath || /(^|\.)_/.test(propertyPath)
        ? [propertyPath]
        : [propertyPath, underscored];
}
