/**
 * The issue-type filters, and how they travel in a URL.
 *
 * Shared by `issues.html` and `tests.html`, which have the same four
 * checkboxes over the same four `lib/query/issues.ts` types. `tests.html`
 * needed them in the URL — a burndown view is something you share and come
 * back to, and arriving at a page that silently re-checks Skips answers a
 * different question from the one the link was about — and duplicating the
 * encoding to give `issues.html` the same thing is how the two drift.
 */

import type { IssueType } from '../lib/query/issues.ts';

/** Which non-passing outcomes count, as the four checkboxes say it. */
export interface IssueFilters {
    failures: boolean;
    timeouts: boolean;
    crashes: boolean;
    skips: boolean;
}

/** All four on, which is how both pages load. */
export const ALL_FILTERS: IssueFilters = {
    failures: true,
    timeouts: true,
    crashes: true,
    skips: true,
};

/** Each filter and the checkbox id it reads, for wiring and for tests. */
export const FILTER_IDS: readonly (readonly [keyof IssueFilters, string])[] = [
    ['failures', 'filter-failures'],
    ['timeouts', 'filter-timeouts'],
    ['crashes', 'filter-crashes'],
    ['skips', 'filter-skips'],
];

/**
 * The page's filter vocabulary translated to the library's.
 *
 * The one place `failures` becomes `fail`. These are not row-visibility
 * filters: unchecking one changes the numerator *and* the denominator of every
 * number, and changes which tests appear at all — a test is listed only when
 * its `issueCount` is above zero.
 */
export function typesOf(filters: IssueFilters): IssueType[] {
    const types: IssueType[] = [];
    if (filters.failures) {
        types.push('fail');
    }
    if (filters.timeouts) {
        types.push('timeout');
    }
    if (filters.crashes) {
        types.push('crash');
    }
    if (filters.skips) {
        types.push('skip');
    }
    return types;
}

/**
 * The short letter each filter takes in a URL.
 *
 * Letters rather than `skips=0&crashes=1`: all four in one key keeps the hash
 * readable next to the range and the search term, and `#issues=ftc` says what
 * it means on sight.
 */
const FILTER_LETTERS: readonly (readonly [keyof IssueFilters, string])[] = [
    ['failures', 'f'],
    ['timeouts', 't'],
    ['crashes', 'c'],
    ['skips', 's'],
];

/**
 * The filters as one URL value, or `''` when they are all on.
 *
 * Empty for the default, because the hash managers drop falsy values — so a
 * reader who has touched nothing gets no key, and a shared URL stays about the
 * thing it was shared for.
 */
export function encodeFilters(filters: IssueFilters): string {
    if (FILTER_LETTERS.every(([key]) => filters[key])) {
        return '';
    }
    const on = FILTER_LETTERS.filter(([key]) => filters[key]).map(([, letter]) => letter);
    // `none` rather than `''` for "all four off": the empty string means
    // "default" to every hash manager here, so it would silently re-check all
    // four — which is the opposite of what the reader asked for.
    return on.length === 0 ? 'none' : on.join('');
}

/**
 * The filters a URL value names, defaulting to all four on.
 *
 * Unknown letters are ignored rather than rejected: a hash outlives the code
 * that wrote it, and a fifth issue type added later should leave the four that
 * still exist working.
 */
export function decodeFilters(value: string | undefined): IssueFilters {
    if (value === undefined || value === '') {
        return { ...ALL_FILTERS };
    }
    if (value === 'none') {
        return { failures: false, timeouts: false, crashes: false, skips: false };
    }
    const letters = new Set(value);
    const filters = { failures: false, timeouts: false, crashes: false, skips: false };
    for (const [key, letter] of FILTER_LETTERS) {
        filters[key] = letters.has(letter);
    }
    return filters;
}
