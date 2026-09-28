/**
 * `crashes.html`'s **view model**: what is left of the page's decisions once
 * the drill-down it shares with `failures.html` has been factored out.
 *
 * Almost everything structural lives in `site/drilldown-view.ts` — the tree, the
 * ranking, the path collapse, the totals, the URL state. This file is the part
 * that is *only* true of the crashes page:
 *
 * - the row unit is a **crash signature**, and an unsymbolized one is dropped;
 * - a row has **two raw-count columns and no rate column**;
 * - an occurrence can carry a **minidump**, which is what makes a row a link
 *   into the crash viewer rather than into the profiler.
 *
 * ## Why so little is here
 *
 * That is the point of doing the two pages as one job. An earlier plan would
 * have produced a `crashes-view.ts` and a `failures-view.ts` each carrying its
 * own copy of `expandGroup`, `sortRows`, `totalsOf` and the occurrence walk, and
 * then a third change to reconcile them. What genuinely differs between the two
 * pages turns out to be small and mostly about links, so that is what these two
 * files hold.
 *
 * ## This file must stay DOM-free
 *
 * Enforced indirectly: `test/crashes-view.test.ts` imports it, the root project
 * compiles `test/**`, and the root project has no DOM lib.
 */

import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import {
    type GroupNode,
    type GroupRow,
    type Occurrence,
    type SortState,
    buildGroups,
    crashExtractor,
    filterGroupsByMatch,
    rowsOf,
    sortRows,
} from './drilldown-view.ts';

/** The word the per-test tooltip uses. `old/crashes.html:721`. */
export const CRASH_NOUN = 'signature';

/**
 * Builds the signature tree for a loaded file.
 *
 * `startTime` is `metadata.startTime`, which both file families carry and which
 * the 21-day files' day indices are relative to.
 */
export function buildCrashGroups(
    file: DecodedTimingFile,
    startTime: number
): Map<string, GroupNode> {
    // No `withComponent`: this page has no bug-filing button, so the component
    // would be read and never used. `failures.html` is the page that needs it.
    return buildGroups(file, startTime, crashExtractor);
}

/**
 * The ranked, searched list of signature rows.
 *
 * The search is `filterGroupsByMatch` — whole rows in or out, each surviving row
 * keeping its pre-filter counts. See that function for why the crashes and
 * failures pages get different search functions rather than one with a flag.
 */
export function crashRows(
    groups: Map<string, GroupNode>,
    searchTerm: string,
    sort: SortState
): GroupRow[] {
    return sortRows(filterGroupsByMatch(rowsOf(groups), searchTerm), sort);
}

/**
 * Whether a single-occurrence row opens the crash viewer when clicked.
 *
 * `old/crashes.html:650-655`: a `test-row single-crash` carries `data-crash-url`,
 * and clicking anywhere on it opens that URL — but only when there *is* one. A
 * row for a crash with no dump has `data-crash-url=""` and the click handler's
 * `if (crashUrl)` makes it inert. The row still looks clickable, because the
 * `cursor: pointer` is on `.crash-row`/`.test-row` in the stylesheet.
 *
 * This is the crashes page's counterpart to the failures page's row click, and
 * the two differ: a failure row always has a task page to open, so it is never
 * inert.
 */
export function singleCrashOpensViewer(occurrence: Occurrence): boolean {
    return Boolean(occurrence.minidump);
}
