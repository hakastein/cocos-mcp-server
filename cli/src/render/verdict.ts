/**
 * Пять слов, которыми начинается строка исхода, и то, чем каждое оборачивается в коде выхода.
 * Набор закрыт нарочно: вид отчёта, не назвавший слово отсюда, не компилируется, — а до этого
 * первые слова расходились по восьми файлам и нигде не были объявлены.
 */
export type Verdict = 'ok' | 'UNVERIFIED' | 'UNPERSISTED' | 'FAILED' | 'TIMEOUT';

/**
 * `UNVERIFIED` выходит нулём: сделанное сделано, а проверка не подтвердила — на этом цепочку
 * через `&&` не обрывают.
 */
export function verdictFailed(verdict: Verdict): boolean {
    return verdict === 'UNPERSISTED' || verdict === 'FAILED' || verdict === 'TIMEOUT';
}
