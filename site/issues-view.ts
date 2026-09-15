/**
 * The view model behind `site/issues.html`: what rows exist, in what order,
 * carrying which numbers. No DOM.
 *
 * The last and largest of the page migrations. The split follows the one the
 * four before it settled:
 *
 * | file | contains | tested by |
 * | --- | --- | --- |
 * | `lib/query/issues.ts` | the per-test counters and **all three** groupings, shared with the CLI | `test/query.test.ts` |
 * | this file | the page's view model — the view modes, the row set, the sort, the search, the expansion, the URL state | `test/issues-view.test.ts`, no DOM |
 * | `site/issues.ts` | the renderer and the interactions | `test/issues-page.test.ts` + the browser run |
 *
 * The three "Show as" modes are three groupings the library already had for
 * `fx-tests issues`, not three row builders: `ViewMode` maps to
 * `groupIssues`' `component` and `directory` and to the ungrouped `findIssues`,
 * and `groupingOf` is the one place that mapping lives. See `ViewMode` below
 * and divergence 8 in `site/issues.ts`.
 *
 * ## The shared drill-down was considered and **not** used
 *
 * `site/drilldown-view.ts` and `drilldown-render.ts` were extracted for
 * `crashes.html` and `failures.html`, and `site/errors.ts` already judged them
 * a poor fit for a third page. The same judgement is made here, and for a
 * sharper reason: the shapes disagree at every level.
 *
 * | | shared drill-down | this page |
 * | --- | --- | --- |
 * | row unit | a group key — a signature or a message string | a **Bugzilla component**, or a directory, or a test |
 * | what a row carries | `testCount` and `count` — two numbers | **seven** counters plus a derived rate |
 * | level 2 | directory path, collapsed away when it holds one test | **test**, and only those with `issueCount > 0` |
 * | level 3 | test | **issue message**, grouped by (type, text) |
 * | level 4 | occurrence | occurrence |
 * | the path-collapse rule | central to `expandGroup` | **absent** — there is no path level |
 * | sortable columns | 2 (`count`, `tests`) | **8**, each with its own default direction |
 * | what a filter changes | which rows are visible | the **numerator and denominator** of every number |
 *
 * Serving both from one module would mean widening `GroupRow` from two numbers
 * to nine, giving `SubRow` a fourth member with a different meaning of "test",
 * deleting the path-collapse rule behind a flag, and making the sort column set
 * a type parameter. That is the "three new booleans" signal several times over,
 * and it would put a `skipCount` on the crashes page's rows where it means
 * nothing.
 *
 * What **is** reused, because it genuinely is page-independent, is
 * `drilldown-render.ts`'s `el`, `externalLink`, `insertAfter`,
 * `removeFollowing`, `noData` and `searchBox` — the escaping question and the
 * search-box wiring answered once. See `site/issues.ts`.
 *
 * ## The Issue% denominator, measured
 *
 * `old/issues.html:944` carries its **own** `computeTestStats`, not the one in
 * `common-test-data.js` (which the page never loads — `grep -c
 * common-test-data issues.html` is 0). The fork differs in two ways that
 * matter: its `runCount` **excludes skips** (`:1060`, written as
 * `skip + timeout + fail + crash + pass - skip`), and it adds `issueCount` and
 * `issuePercentage`, which the shared version lacks.
 *
 * `lib/query/issues.ts` implements the same query for the CLI. **The two were
 * compared before either was reused**, per test and field by field, on real
 * data rather than on the fixture alone:
 *
 * | file | tests compared | mismatches |
 * | --- | --- | --- |
 * | `xpcshell-issues.json`, 21-day, full | 4,838 | **0** |
 * | `xpcshell-2026-08-04.json`, one day, full | 4,836 | **0** |
 * | `mochitest-issues.json`, 21-day, full | 21,016 | **0** |
 * | `test/fixtures/xpcshell-issues.json` | 10 | **0** |
 * | `test/fixtures/xpcshell-2026-08-03.json` | 11 | **0** |
 *
 * Compared: `runCount`, `skipCount`, `failCount`, `timeoutCount`,
 * `crashCount`, `issueCount`, and the rate itself. The component-level
 * grouping was compared the same way — 136 page components against the CLI's
 * `groupIssues`, every counter equal.
 *
 * The one field that differs is **`passCount`**, and it differs by exactly the
 * `EXPECTED-FAIL` count: the page folds `EXPECTED-FAIL` into `passCount`
 * (`:1056`, the final `else`), `lib/query/issues.ts` names it
 * `expectedFailCount` and keeps it out. **Both include it in `runCount`**, so
 * no displayed number moves — and `passCount` is accumulated
 * (`old/issues.html:2012`) but never rendered: there is no `generateStatItem` for
 * it anywhere in the page. Measured: 13 of 4,838 xpcshell tests and 7 of
 * 21,016 mochitest tests have a non-zero `EXPECTED-FAIL`, totalling 4,973 runs
 * on the xpcshell aggregate.
 *
 * So `lib/query/issues.ts` is used, unchanged, and this page adds no counting
 * of its own. **The denominator, stated explicitly as the brief requires:**
 *
 * > **Issue% = issueCount / (runCount + (skips enabled ? skipCount : 0))**,
 * > where `runCount` is pass + expected-fail + fail + timeout + crash — every
 * > run that reached a verdict, **excluding skips** — and `issueCount` is the
 * > sum of only the enabled types.
 *
 * Skips are added back to the denominator exactly when they are in the
 * numerator, which is what stops a skip from inflating the rate by being
 * counted above the line and missing below it. This is `old/issues.html:1078` and
 * `:2045-2048` and `lib/query/issues.ts:208`, which were verified to agree.
 *
 * ## This file must stay DOM-free
 *
 * `test/issues-view.test.ts` imports it, the root project compiles `test/**`,
 * and the root project has no DOM lib — so a `document` reach fails
 * `npm run typecheck` rather than being caught by review.
 */

import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import { classifyStatus } from '../lib/model/status.ts';
import { displaySkipMessage, skipReason } from '../lib/model/skips.ts';
import {
    type IssueGroup,
    type IssueRow,
    type IssueType,
    findIssues,
    groupIssues,
} from '../lib/query/issues.ts';

// --- the issue-type filters ----------------------------------------------

/**
 * The four "Count as issues" checkboxes, and their state.
 *
 * `old/issues.html:626-638` — four `<input type="checkbox">`, every one `checked`,
 * mirrored into a JS object at `:672-677` and re-read from the DOM on load at
 * `:3686-3689` in case the browser restored them across a reload.
 *
 * They are **not** row-visibility filters. Unchecking one changes both the
 * numerator and the denominator of every number on the page — `issueCount`
 * (`:1071-1075`), the Issue% denominator (`:1078`), and the component
 * comparator's rate (`:2045-2048`) — and it changes which tests appear as child
 * rows, because a test is listed only when `issueCount > 0` (`:2017`).
 */
// The four checkboxes and their URL encoding live in `site/issue-filters.ts`,
// shared with `tests.html`. Imported for this file's own use, and re-exported
// so this page's consumers and tests keep importing them from here.
import { type IssueFilters, typesOf } from './issue-filters.ts';

export {
    type IssueFilters,
    ALL_FILTERS,
    FILTER_IDS,
    decodeFilters,
    encodeFilters,
    typesOf,
} from './issue-filters.ts';

// --- the view modes -------------------------------------------------------

/**
 * What the three "Show as" radios group by.
 *
 * `xpcshell-timings.html:357-371` carries the same three with the same labels,
 * and `getCurrentView` (`:550-561`) is the accessor. `issues.html` had the
 * control's *effect* hard-coded instead — `getCurrentView()` returns the
 * constant `'components'` (`old/issues.html:887-890`) — so this adds the
 * control to the page whose renderer was already the components one.
 *
 * The three map onto groupings `lib/query/issues.ts` already has, which is why
 * no new aggregation is written here:
 *
 * | mode | grouping | `fx-tests issues` |
 * | --- | --- | --- |
 * | `components` | `groupIssues(rows, 'component')` | `--group-by component`, its default |
 * | `tree` | `groupIssues(rows, 'directory')` | `--group-by directory` |
 * | `list` | none — one row per test, from `findIssues` | `--group-by test` |
 */
export type ViewMode = 'components' | 'tree' | 'list';

/**
 * The mode the page opens on.
 *
 * `components`, which is both radios' default (`xpcshell-timings.html:358`,
 * `checked`) and what this page rendered before the control existed. The
 * owner confirmed it stays.
 */
export const DEFAULT_VIEW: ViewMode = 'components';

/**
 * The radios, in markup order: element id, hash value, label.
 *
 * The labels are `xpcshell-timings.html`'s, verbatim, so a reader who knows one
 * page's control knows this one's.
 */
export const VIEW_MODES: readonly (readonly [ViewMode, string, string])[] = [
    ['components', 'view-components', 'bugzilla components'],
    ['tree', 'view-tree', 'source tree'],
    ['list', 'view-list', 'list'],
];

/** Whether a string names a view mode. */
export function isViewMode(value: string | undefined): value is ViewMode {
    return value === 'components' || value === 'tree' || value === 'list';
}

/**
 * What a mode groups by, or `null` for the flat list.
 *
 * The one place the page's vocabulary is mapped onto `groupIssues`', like
 * `typesOf` is for the checkboxes — so the page and the CLI cannot drift into
 * grouping by different things under the same name.
 */
export function groupingOf(view: ViewMode): 'component' | 'directory' | null {
    switch (view) {
        case 'components':
            return 'component';
        case 'tree':
            return 'directory';
        case 'list':
            return null;
    }
}

/**
 * Whether a file can be grouped by Bugzilla component at all.
 *
 * `hasComponentData` (`xpcshell-timings.html:545-547`), which that page uses to
 * hide the components radio and fall back to the tree when a file carries no
 * `tables.components`/`testInfo.componentIds` — both are optional fields
 * (`lib/formats/tables.ts:105`, `:113`) and `readTest` returns `component:
 * null` when they are absent, so without the check the components view would
 * collapse to one `(no component)` row.
 *
 * Asked of the decoded file rather than of the raw one, because that is what
 * this page holds and because the three families it loads have three different
 * raw shapes. It is a scan rather than a flag: `DecodedTimingFile` has no
 * "were there components" field, and the answer the page needs is "is there a
 * component to group by", which a present-but-all-null table also answers no.
 * It stops at the first test with one, so on a file that has them it reads one
 * test.
 *
 * Measured on the checked-in fixtures: `xpcshell-issues.json` and
 * `xpcshell-2026-08-03.json` both carry a 3-entry `tables.components` and a
 * `componentIds`, so the fallback is not reachable on either — but
 * `FORMATS.md:174` records individual `componentIds` entries being null (2 of
 * 4,838 xpcshell tests), which is the `(no component)` bucket and not this.
 */
export function hasComponentData(file: DecodedTimingFile): boolean {
    for (let testId = 0; testId < file.testCount; testId++) {
        if (file.testAt(testId).component !== null) {
            return true;
        }
    }
    return false;
}

/**
 * The mode to render, given what the reader picked and what the file supports.
 *
 * `getCurrentView`'s two fallbacks (`xpcshell-timings.html:550-561`): a
 * components selection on a file with no components becomes `tree`, and so does
 * an absent selection.
 */
export function effectiveView(view: ViewMode, file: DecodedTimingFile | null): ViewMode {
    if (view !== 'components' || file === null) {
        return view;
    }
    return hasComponentData(file) ? 'components' : 'tree';
}

// --- the rows -------------------------------------------------------------

/**
 * One group row — a component or a directory — with the tests under it.
 *
 * `renderComponentsView` (`old/issues.html:1933`) builds this as two objects — a
 * `componentGroups` entry and a pair of `componentTotalTests` /
 * `componentTotalTestsWithIssues` maps filled by a separate first pass
 * (`:1949-1965`). They are one record here because they describe one row.
 *
 * The name is the components view's, which is the only one `issues.html` had.
 * The `tree` mode's rows are the same record with a directory in `key`: every
 * field below is a count over the row's tests and means the same thing either
 * way, which is why the two modes share one type rather than one being a copy.
 */
export interface ComponentRow {
    /**
     * `Product :: Component` or `(no component)` (`old/issues.html:1954`) in
     * the components view; the test's directory in the tree view.
     */
    key: string;
    /** The group totals, from `lib/query/issues.ts`. */
    stats: IssueGroup;
    /**
     * The tests to list when this row is expanded: those with `issueCount > 0`,
     * already sorted. `old/issues.html:2016-2020` and `:2144-2152`.
     */
    tests: IssueRow[];
    /**
     * Tests in the group that survived the search, issue-free included.
     *
     * The `out of M` in the header (`:2106`). Under a search that matched on
     * test path this is the *matching* count rather than the group's whole
     * population — see `headerCounts`.
     */
    matchingTestCount: number;
    /** Every test in the group, before any search. `:1959`. */
    totalTestCount: number;
    /** Tests with an issue, before any search. `:1963`. */
    totalTestsWithIssues: number;
}

/** Which column the list is ranked on. `old/issues.html:1174`. */
export type SortField =
    | 'name'
    | 'runCount'
    | 'issuePercentage'
    | 'issueCount'
    | 'skipCount'
    | 'failCount'
    | 'timeoutCount'
    | 'crashCount';

/** A column and a direction. */
export interface SortState {
    field: SortField;
    direction: 'asc' | 'desc';
}

/**
 * The sort the page starts on: most issues first.
 *
 * `old/issues.html:663-664`, whose comment reads "Start with descending for
 * failure count (most failing first)".
 */
export const INITIAL_SORT: SortState = { field: 'issueCount', direction: 'desc' };

/**
 * The columns, in the order the header emits them. `old/issues.html:1174`.
 *
 * `name` is separate because it is the left-aligned Path button (`:1179`)
 * rather than one of the seven stat buttons.
 */
export const STAT_COLUMNS: readonly (readonly [SortField, string])[] = [
    ['runCount', 'Runs'],
    ['issuePercentage', 'Issue %'],
    ['issueCount', 'Issues'],
    ['skipCount', 'Skips'],
    ['failCount', 'Failures'],
    ['timeoutCount', 'Timeouts'],
    ['crashCount', 'Crashes'],
];

/**
 * The next sort state after clicking a column header.
 *
 * `changeSortOrder` (`old/issues.html:1187-1200`): the same column flips the
 * direction, a new column starts **descending except `name` and
 * `issuePercentage`**, which start ascending (`:1193-1197`).
 *
 * The `issuePercentage` exception is worth keeping rather than tidying away:
 * ascending on a rate surfaces the components that are nearly clean, which is
 * a different and legitimate question from "who is worst".
 */
export function nextSort(current: SortState, field: SortField): SortState {
    if (current.field === field) {
        return { field, direction: current.direction === 'asc' ? 'desc' : 'asc' };
    }
    return {
        field,
        direction: field === 'name' || field === 'issuePercentage' ? 'asc' : 'desc',
    };
}

/**
 * The sortable quantity of one component row.
 *
 * `old/issues.html:2035-2075`. Note `issuePercentage` sorts on the **raw ratio**
 * (`:2046`, `issueCount / totalCount`, not multiplied by 100 and not rounded),
 * so two components whose displayed percentages both round to `9%` still order
 * by their exact rates. Reproducing that matters: sorting on the rounded value
 * would reorder rows whose displayed numbers are equal, and a reader comparing
 * the two pages would see it.
 */
function componentValue(row: ComponentRow, field: SortField, filters: IssueFilters): number {
    const stats = row.stats;
    switch (field) {
        case 'runCount':
            return stats.runCount;
        case 'issuePercentage': {
            const total = stats.runCount + (filters.skips ? stats.skipCount : 0);
            return total > 0 ? stats.issueCount / total : 0;
        }
        case 'issueCount':
            return stats.issueCount;
        case 'skipCount':
            return stats.skipCount;
        case 'failCount':
            return stats.failCount;
        case 'timeoutCount':
            return stats.timeoutCount;
        case 'crashCount':
            return stats.crashCount;
        case 'name':
            // Unreachable: `sortComponents` branches on `name` before calling
            // this, because a name sort compares strings. Returning 0 rather
            // than throwing keeps the function total.
            return 0;
    }
}

/**
 * Ranks the component rows.
 *
 * `old/issues.html:2032-2082`. `name` compares with `localeCompare` (`:2078`);
 * every other field subtracts, and the descending branch returns
 * `valueB - valueA` (`:2081`).
 *
 * `Array.prototype.sort` is stable, so ties keep the order the components were
 * first seen in — which is the order `testRuns` yields their first test. That
 * is upstream's tie behaviour and is reproduced rather than replaced with a
 * name tiebreak: the CLI adds one (`lib/query/issues.ts:339`) because its
 * output gets diffed, and that difference is a declared page-vs-CLI divergence
 * in `test/issues-parity.test.ts`.
 */
export function sortComponents(
    rows: readonly ComponentRow[],
    sort: SortState,
    filters: IssueFilters
): ComponentRow[] {
    const sorted = [...rows];
    sorted.sort((a, b) => {
        if (sort.field === 'name') {
            return sort.direction === 'asc'
                ? a.key.localeCompare(b.key)
                : b.key.localeCompare(a.key);
        }
        const valueA = componentValue(a, sort.field, filters);
        const valueB = componentValue(b, sort.field, filters);
        return sort.direction === 'asc' ? valueA - valueB : valueB - valueA;
    });
    return sorted;
}

/**
 * Ranks the tests inside an expanded component, by the same field.
 *
 * `sortTestList` (`old/issues.html:1880-1930`). The same comparator as the
 * components with two differences that are upstream's:
 *
 * - `name` sorts on the **full test path** (`:1886`), where a component row
 *   sorts on the component name.
 * - `issuePercentage` reads `stats.issuePercentage` through `parseFloat`
 *   (`:1894`) — the **percentage**, already multiplied by 100, where the
 *   component comparator uses the raw ratio. The two differ by a constant
 *   factor and therefore order identically, so this is a difference in
 *   expression rather than in result; it is written the same way here so the
 *   two functions can be read against their originals.
 */
export function sortTests(
    tests: readonly IssueRow[],
    sort: SortState
): IssueRow[] {
    const sorted = [...tests];
    sorted.sort((a, b) => {
        if (sort.field === 'name') {
            return sort.direction === 'asc'
                ? a.fullPath.localeCompare(b.fullPath)
                : b.fullPath.localeCompare(a.fullPath);
        }
        const valueA = testValue(a, sort.field);
        const valueB = testValue(b, sort.field);
        return sort.direction === 'asc' ? valueA - valueB : valueB - valueA;
    });
    return sorted;
}

function testValue(row: IssueRow, field: SortField): number {
    switch (field) {
        case 'runCount':
            return row.runCount;
        case 'issuePercentage':
            return row.issueRate;
        case 'issueCount':
            return row.issueCount;
        case 'skipCount':
            return row.skipCount;
        case 'failCount':
            return row.failCount;
        case 'timeoutCount':
            return row.timeoutCount;
        case 'crashCount':
            return row.crashCount;
        case 'name':
            return 0;
    }
}

// --- building the row set -------------------------------------------------

/**
 * Every group row for a file, under one filter setting and one search.
 *
 * This is `renderComponentsView`'s two passes (`old/issues.html:1946-2029`) with
 * the rendering taken out. The order of operations is the part that matters and
 * it is upstream's:
 *
 * 1. **Every test is counted into its group's totals**, search or no search
 *    — `componentTotalTests` and `componentTotalTestsWithIssues` are built in a
 *    first pass over the *whole* file (`:1949-1965`), before the search is
 *    consulted.
 * 2. **The search then drops tests** (`:1979-1981`), and the surviving ones
 *    accumulate the row's seven counters (`:2007-2013`).
 * 3. **A test joins the expandable list only if `issueCount > 0`** (`:2016`),
 *    which happens *after* its runs have already gone into the denominator.
 *
 * Step 3 is the one that is easy to get wrong and the reason the CLI has a
 * `keepClean` option: a component's `runCount` includes the tests that never
 * failed, so its rate is over its whole population. Dropping the clean tests
 * first would inflate every rate — measured on WebExtensions :: General,
 * 6,087,719 runs instead of 6,131,520 (`lib/query/issues.ts:99-106`).
 *
 * A component with **no** test that has an issue is still a row (`:2111-2112`
 * renders it as `(N tests)` and `:2094` marks it `non-clickable`). The CLI
 * drops those (`lib/query/issues.ts:329`); measured on the pinned 21-day
 * xpcshell file there are exactly 3 — `Firefox :: Sharing` (5 tests),
 * `Core :: Widget: Cocoa` (1) and `Core :: Layout` (1) — out of 136. That is a
 * declared page-vs-CLI divergence, not an old-vs-new one.
 *
 * ## `groupBy`, for the source-tree mode
 *
 * `component` is the default because it is what `issues.html` did with no
 * control at all, so an existing caller keeps the behaviour it had.
 * `directory` is the `tree` radio, and it changes **only the key** — the two
 * passes, the search, the `keepClean` and the `groupIssues` call are the same
 * code on the same rows, so the tree view's arithmetic cannot disagree with the
 * components view's or with `fx-tests issues --group-by directory`.
 *
 * The directory is `IssueRow.directory`, the test's own leaf directory, so the
 * rows are flat: `netwerk/test/unit` is a row and `netwerk` is not one. That is
 * the grouping `groupIssues` implements and the one the CLI prints, and it is
 * *not* `xpcshell-timings.html`'s tree, which nests folders and collapses
 * single-child ones (`:1754-1825`). Naming it "source tree" and ranking one
 * level of it is the trade this makes: the shared grouping stays shared, and
 * the reader gets the directory rankings the CLI already has.
 */
export function buildComponentRows(
    file: DecodedTimingFile,
    filters: IssueFilters,
    searchTerm: string,
    groupBy: 'component' | 'directory' = 'component'
): ComponentRow[] {
    const types = typesOf(filters);
    // `keepClean` is what reproduces step 3: every test comes back, including
    // the ones with no issue, so the denominators cover the whole population.
    const all = findIssues(file, { types, keepClean: true });
    const needle = searchTerm.toLowerCase().trim();
    const keyOf = (row: IssueRow): string =>
        groupBy === 'component' ? (row.component ?? NO_COMPONENT) : row.directory;

    // Pass 1, over every test: the group's whole population.
    const totalTests = new Map<string, number>();
    const totalWithIssues = new Map<string, number>();
    for (const row of all) {
        const key = keyOf(row);
        totalTests.set(key, (totalTests.get(key) ?? 0) + 1);
        if (row.issueCount > 0) {
            totalWithIssues.set(key, (totalWithIssues.get(key) ?? 0) + 1);
        }
    }

    // Pass 2, over the tests the search kept.
    const kept = new Map<string, IssueRow[]>();
    for (const row of all) {
        const key = keyOf(row);
        if (needle !== '' && !matchesSearch(key, row.fullPath, needle)) {
            continue;
        }
        let list = kept.get(key);
        if (list === undefined) {
            list = [];
            kept.set(key, list);
        }
        list.push(row);
    }

    const rows: ComponentRow[] = [];
    for (const [key, members] of kept) {
        // Recomputed from the kept members rather than from `all`, so a search
        // narrows the row's numbers. `groupIssues` is the same function the CLI
        // uses, which is what keeps the two sides' arithmetic identical.
        const [stats] = groupIssues(members, groupBy, types);
        rows.push({
            key,
            // `groupIssues` drops a group whose every test is clean (`:329`).
            // The page keeps it as a `(N tests)` row, so the totals are rebuilt
            // here when that happens.
            stats: stats ?? emptyGroup(key, members, types, filters),
            tests: members.filter((row) => row.issueCount > 0),
            matchingTestCount: members.length,
            totalTestCount: totalTests.get(key) ?? 0,
            totalTestsWithIssues: totalWithIssues.get(key) ?? 0,
        });
    }

    // The group filter (`old/issues.html:2024-2029`): with a search, a group
    // survives if its *name* matched or if it kept a test with an issue. A
    // group whose only matching tests are clean is dropped — which is why this
    // is not the same as `kept.size`.
    if (needle === '') {
        return rows;
    }
    return rows.filter(
        (row) => row.key.toLowerCase().includes(needle) || row.tests.length > 0
    );
}

/**
 * Every test with an issue, as one flat ranked list — the `list` radio.
 *
 * `findIssues` with no `keepClean`, which is `fx-tests issues --group-by test`
 * exactly: a clean test is not a row anyone wants listed
 * (`cli/commands/issues.ts:420-422`). So unlike the two grouped modes there is
 * no whole-population denominator to preserve here, and no group to rebuild
 * when every member is clean.
 *
 * The search is the **test path only**. `matchesSearch` also matches the
 * component name, which is what makes searching `WebExtensions` keep a
 * component's whole row set in the grouped modes; with no group row to keep,
 * matching on a component would list tests whose paths say nothing about the
 * term — `xpcshell-timings.html:2161` filters its own list view on
 * `test.testPath` alone for the same reason.
 *
 * Unsorted here: `sortTests` ranks it, with the same comparator and the same
 * eight columns the grouped modes' child rows use.
 */
export function buildTestRows(
    file: DecodedTimingFile,
    filters: IssueFilters,
    searchTerm: string
): IssueRow[] {
    const rows = findIssues(file, { types: typesOf(filters) });
    const needle = searchTerm.toLowerCase().trim();
    if (needle === '') {
        return rows;
    }
    return rows.filter((row) => row.fullPath.toLowerCase().includes(needle));
}

/** What the page calls a test with no Bugzilla component. `old/issues.html:1954`. */
export const NO_COMPONENT = '(no component)';

/**
 * Whether a test is kept by the search.
 *
 * `old/issues.html:1974-1981`: the component name **or** the full test path
 * contains the term, case-insensitively. Matching on the component is what
 * makes searching for `WebExtensions` keep every test in it, including the ones
 * whose own paths say nothing about extensions.
 */
function matchesSearch(component: string, fullPath: string, needle: string): boolean {
    return (
        component.toLowerCase().includes(needle) || fullPath.toLowerCase().includes(needle)
    );
}

/**
 * The totals for a component whose every kept test is clean.
 *
 * `groupIssues` returns nothing for one (`lib/query/issues.ts:329`), and the
 * page renders it as a row with zeroes and a `(N tests)` label. Built here
 * rather than by relaxing the library, because "a group with no issues is not a
 * triage row" is correct for the CLI and this is a presentation decision that
 * belongs to the page.
 */
function emptyGroup(
    key: string,
    members: readonly IssueRow[],
    types: readonly IssueType[],
    filters: IssueFilters
): IssueGroup {
    const group: IssueGroup = {
        key,
        testCount: 0,
        totalTestCount: members.length,
        runCount: 0,
        failCount: 0,
        timeoutCount: 0,
        crashCount: 0,
        skipCount: 0,
        failRate: 0,
        issueCount: 0,
        issueRate: 0,
    };
    for (const row of members) {
        group.runCount += row.runCount;
        group.failCount += row.failCount;
        group.timeoutCount += row.timeoutCount;
        group.crashCount += row.crashCount;
        group.skipCount += row.skipCount;
    }
    // Same shape as `groupIssues`, over the enabled types, so a clean row's
    // zeroes come from the same arithmetic as a populated row's numbers.
    const enabled = new Set(types);
    group.issueCount =
        (enabled.has('skip') ? group.skipCount : 0) +
        (enabled.has('fail') ? group.failCount : 0) +
        (enabled.has('timeout') ? group.timeoutCount : 0) +
        (enabled.has('crash') ? group.crashCount : 0);
    const denominator = group.runCount + (filters.skips ? group.skipCount : 0);
    group.issueRate = denominator > 0 ? (group.issueCount / denominator) * 100 : 0;
    const nonPass = group.failCount + group.timeoutCount + group.crashCount;
    group.failRate = group.runCount > 0 ? (nonPass / group.runCount) * 100 : 0;
    return group;
}

// --- what the component header says --------------------------------------

/** The two numbers in a component header's parenthetical. */
export interface HeaderCounts {
    /** Tests with an issue among those kept by the search. */
    withIssues: number;
    /** The `out of M`, or `null` when every kept test has an issue. */
    outOf: number | null;
}

/**
 * The `(N tests with issues, out of M)` in a component header.
 *
 * `old/issues.html:2098-2113`, and it has three cases rather than the one the
 * summary suggests:
 *
 * - **No test has an issue** → `(M tests)`, where M is the component's whole
 *   population (`:2112`). Signalled here by `withIssues === 0`.
 * - **Some do, and M is larger** → `(N tests with issues, out of M)` (`:2106`).
 * - **Some do, and N is all of them** → `(N tests with issues)`, no `out of`
 *   (`:2109`), because `out of N` of N tells a reader nothing.
 *
 * The M is the subtle part (`:2102-2103`): under a search that narrowed the
 * component's tests, it is the **matching** count rather than the whole
 * population — so searching for one test in a 400-test component shows
 * `1 test with issues` and not `out of 400`. The condition upstream uses is
 * `searchTerm && matchingTestsCount < totalTests`, which is reproduced exactly,
 * including that a search matching *every* test in the component falls back to
 * the population figure. The two are equal in that case, so the distinction is
 * invisible — but the branch is upstream's and copying it keeps this function
 * checkable against the line it came from.
 */
export function headerCounts(row: ComponentRow, searchTerm: string): HeaderCounts {
    if (row.tests.length === 0) {
        return { withIssues: 0, outOf: row.totalTestCount };
    }
    const narrowed = searchTerm !== '' && row.matchingTestCount < row.totalTestCount;
    const total = narrowed ? row.matchingTestCount : row.totalTestCount;
    return {
        withIssues: row.tests.length,
        outOf: row.tests.length < total ? total : null,
    };
}

// --- the Issue% cell ------------------------------------------------------

/** A percentage's display string and the class that colours it. */
export interface PercentageDisplay {
    displayValue: string;
    cssClass: string;
}

/**
 * The Issue% cell: what it reads and what colour it is.
 *
 * `getIssuePercentageDisplay` (`old/issues.html:774-802`). Four bands, and the
 * thresholds are on the **rounded** value (`:791-799`) while the `<1%` test is
 * on the **exact** one (`:786`):
 *
 * | exact | shown | class |
 * | --- | --- | --- |
 * | denominator 0, or exactly 0 | `0%` | `zero` |
 * | `0 < p < 1` | `<1%` | none |
 * | rounds to 1 | `1%` | none |
 * | rounds to 2..9 | `N%` | `yellow` |
 * | rounds to 10..19 | `N%` | `orange` |
 * | rounds to >= 20 | `N%` | `fail` |
 *
 * **The rounding happens once, from the raw ratio.** `Math.round` is applied to
 * `(issueCount / totalCount) * 100` and to nothing else — a double-round is
 * what shipped `14.37%` where a page showed `14.38%` on an earlier migration.
 *
 * The `else` at `:797` is upstream's and is unreachable, which is a
 * measurement rather than a reading: reaching it needs `roundedPercentage <= 1`
 * after `exactPercentage >= 1`, and `Math.round` of a value >= 1 is >= 1, so
 * only exactly-1 arrives and `> 1` is false — giving class `''`, which is what
 * the `1%` row above records. It is reproduced as the same empty string.
 */
export function percentageDisplay(
    stats: { issueCount: number; runCount: number; skipCount: number },
    filters: IssueFilters
): PercentageDisplay {
    const totalCount = stats.runCount + (filters.skips ? stats.skipCount : 0);
    if (totalCount === 0) {
        return { displayValue: '0%', cssClass: 'zero' };
    }
    const exact = (stats.issueCount / totalCount) * 100;
    if (exact === 0) {
        return { displayValue: '0%', cssClass: 'zero' };
    }
    if (exact < 1) {
        return { displayValue: '<1%', cssClass: '' };
    }
    const rounded = Math.round(exact);
    let cssClass: string;
    if (rounded >= 20) {
        cssClass = 'fail';
    } else if (rounded >= 10) {
        cssClass = 'orange';
    } else if (rounded > 1) {
        cssClass = 'yellow';
    } else {
        cssClass = '';
    }
    return { displayValue: `${rounded}%`, cssClass };
}

// --- the expanded test's issue list --------------------------------------

/** One line in an expanded test: a count, a type and a message. */
export interface IssueEntry {
    count: number;
    type: 'SKIP' | 'FAIL' | 'CRASH' | 'TIMEOUT';
    message: string;
}

/**
 * What `issues.html` calls a failure that recorded no message.
 *
 * `old/issues.html:680`. Note this is a *different* string from
 * `failures.html`'s `(no failure message)` — the two pages name the same
 * condition differently, and each is reproduced as it is.
 */
export const FAILURE_NO_MESSAGE =
    'Failure details not recorded (likely Android or platform logging issue)';

/** `old/issues.html:3019`. */
export const CRASH_NO_SIGNATURE = 'Crash signature not recorded';

/** `old/issues.html:3029`. */
export const TIMEOUT_MESSAGE = 'Test exceeded time limit';

/**
 * The issue lines for one expanded test, ranked and filtered.
 *
 * `generateIssueDetailsHtml` (`old/issues.html:2951-3053`) with the markup taken
 * out. Four sources, in this order, then one sort and one filter:
 *
 * 1. **Skips**, by message, `run-if` excluded and the `skip-if: ` prefix
 *    stripped for display (`:2968-2976`).
 * 2. **Failures**, by message (`:2979-2989`), plus a synthetic line for the
 *    failures that recorded none — `failCount - (messages seen)`
 *    (`:2993-2999`). That line exists because Android runs report a failure
 *    without a message, and without it the numbers under a test would not add
 *    up to its Failures column.
 * 3. **Crashes**, by signature (`:3004-3010`), plus the same kind of synthetic
 *    line for crashes with no signature (`:3015-3021`).
 * 4. **Timeouts**, as a single line, because the format records no per-timeout
 *    message (`:3025-3031`).
 *
 * Then **sorted by count descending** (`:3037`) and **only then filtered** by
 * the enabled types (`:3040-3046`). The order matters: sorting the whole set
 * before filtering means the surviving lines keep their relative order, which
 * is the same list a reader saw before they unchecked a box.
 */
export function issueEntries(
    file: DecodedTimingFile,
    row: IssueRow,
    filters: IssueFilters
): IssueEntry[] {
    const entries: IssueEntry[] = [];

    const skips = new Map<string, number>();
    const failures = new Map<string, number>();
    const crashes = new Map<string, number>();
    let failWithMessage = 0;
    let crashWithSignature = 0;

    for (const entry of file.runsOfTest(row.testId)) {
        const kind = classifyStatus(entry.status).kind;
        if (kind === 'skip') {
            // `run-if` is not an issue: the annotation says the test is scoped
            // to another platform, so it not running here is the annotation
            // working. `old/issues.html:1005` and `:1519`.
            if (skipReason(entry.message) === 'run-if') {
                continue;
            }
            if (entry.message === undefined || entry.message === null) {
                continue;
            }
            const display = displaySkipMessage(entry.message);
            skips.set(display, (skips.get(display) ?? 0) + entry.count);
        } else if (kind === 'fail') {
            if (entry.message === undefined || entry.message === null) {
                continue;
            }
            failures.set(entry.message, (failures.get(entry.message) ?? 0) + entry.count);
            failWithMessage += entry.count;
        } else if (kind === 'crash') {
            const signature = entry.crashSignature;
            if (signature === undefined || signature === null) {
                continue;
            }
            crashes.set(signature, (crashes.get(signature) ?? 0) + entry.count);
            crashWithSignature += entry.count;
        }
    }

    for (const [message, count] of sortedByCount(skips)) {
        entries.push({ count, type: 'SKIP', message });
    }
    for (const [message, count] of sortedByCount(failures)) {
        entries.push({ count, type: 'FAIL', message });
    }
    if (row.failCount > failWithMessage) {
        entries.push({
            count: row.failCount - failWithMessage,
            type: 'FAIL',
            message: FAILURE_NO_MESSAGE,
        });
    }
    for (const [message, count] of sortedByCount(crashes)) {
        entries.push({ count, type: 'CRASH', message });
    }
    if (row.crashCount > crashWithSignature) {
        entries.push({
            count: row.crashCount - crashWithSignature,
            type: 'CRASH',
            message: CRASH_NO_SIGNATURE,
        });
    }
    if (row.timeoutCount > 0) {
        entries.push({ count: row.timeoutCount, type: 'TIMEOUT', message: TIMEOUT_MESSAGE });
    }

    // Sort first, filter second — upstream's order (`:3037` then `:3040`).
    entries.sort((a, b) => b.count - a.count);
    return entries.filter((entry) => isEnabled(entry.type, filters));
}

/** Whether an issue line's type is one of the checked boxes. `:3041-3045`. */
export function isEnabled(type: IssueEntry['type'], filters: IssueFilters): boolean {
    switch (type) {
        case 'SKIP':
            return filters.skips;
        case 'FAIL':
            return filters.failures;
        case 'CRASH':
            return filters.crashes;
        case 'TIMEOUT':
            return filters.timeouts;
    }
}

/**
 * A message map as count-descending pairs.
 *
 * `getSkipMessageCounts` (`:1527`), `getFailureMessageCounts` (`:1578`) and
 * `getCrashData` (`:1613`) each end with the same sort. `Map` iterates in
 * insertion order and `sort` is stable, so equal counts keep the order the walk
 * first saw them — upstream's behaviour, since it sorts the same kind of array
 * built the same way.
 */
function sortedByCount(counts: Map<string, number>): [string, number][] {
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// --- the per-issue tooltip -----------------------------------------------

/**
 * The `title` on a FAIL line's count, or `''`.
 *
 * `old/issues.html:3063-3068`. Only FAIL lines get one, and only when the test has
 * runs. The percentage is `count / runCount`, **rounded once** with
 * `toFixed(2)` from the raw ratio.
 *
 * Note the denominator is `runCount` — which excludes skips — and not the
 * Issue% denominator. That is upstream's and it is the right one here: the
 * question a reader is asking of a failure message is what share of the runs
 * that actually executed produced it, and a skipped run could not have.
 */
export function failureTooltip(count: number, runCount: number): string {
    if (runCount <= 0) {
        return '';
    }
    const percentage = ((count / runCount) * 100).toFixed(2);
    const occurrenceText = count === 1 ? 'occurrence' : 'occurrences';
    return `${count} ${occurrenceText} of this message out of ${runCount.toLocaleString()} runs (${percentage}%)`;
}

// --- the daily-rate series ------------------------------------------------

/**
 * One day of the per-component and per-test charts.
 *
 * `calculateDailyFailureRates` (`old/issues.html:2373-2464`) and
 * `calculateComponentDailyFailureRates` (`:2467-2510`) build exactly this
 * array, one entry per day the file covers, day 0 the oldest.
 */
export interface DailyOutcomes {
    day: number;
    /** `YYYY-MM-DD`, from `startTime + day * 86400`. `old/issues.html:2385`. */
    date: string;
    passes: number;
    failures: number;
    timeouts: number;
    crashes: number;
    skips: number;
}

/** One day of the per-issue-message chart. `old/issues.html:2513-2698`. */
export interface DailyMessageRate {
    day: number;
    date: string;
    /** Occurrences of this one message on this day. */
    count: number;
    /** The denominator: see `messageDailyRates` for which runs it counts. */
    totalRuns: number;
}

/**
 * The `YYYY-MM-DD` label for a day index.
 *
 * `old/issues.html:2385`, verbatim: `startTime` is Unix **seconds**, a day is
 * 86,400 of them, and the label is the UTC date. Written once rather than
 * three times because all three series build it identically.
 */
export function dayLabel(startTime: number, day: number): string {
    return new Date((startTime + day * 86400) * 1000).toISOString().split('T')[0]!;
}

/** `days` empty buckets, labelled. The head of all three upstream functions. */
function emptyDays<T>(days: number, startTime: number, fill: (day: number, date: string) => T): T[] {
    const out: T[] = [];
    for (let day = 0; day < days; day++) {
        out.push(fill(day, dayLabel(startTime, day)));
    }
    return out;
}

/**
 * How many days a decoded aggregate covers, defaulting to 21.
 *
 * `historicalData.metadata.days || 21` (`old/issues.html:2376`). A daily file's
 * `days` is `null`, and upstream's three functions all return `null` when the
 * page is not in historical mode — the callers here make the same check by
 * asking for the series only in 21-day mode.
 */
export function chartDays(file: DecodedTimingFile): number {
    return file.days ?? 21;
}

/**
 * The per-test outcome series: passes, failures, timeouts, crashes and skips
 * by day.
 *
 * `calculateDailyFailureRates` (`old/issues.html:2373`). Upstream branches on the
 * three status-group shapes it might meet and derives a count from each;
 * `runsOfTest` has already resolved the shape, and `entry.count` is that count
 * in every one of them — which is why the three branches collapse to one loop
 * here rather than being ported three times.
 *
 * The classification is upstream's and it has a hole worth naming:
 * `EXPECTED-FAIL` matches none of `startsWith('PASS')`, `=== 'CRASH'`,
 * `startsWith('TIMEOUT')`, `=== 'SKIP'`, `startsWith('FAIL')`, so upstream
 * silently drops it from both the numerator and the denominator.
 * `classifyStatus` returns `expected-fail` for it, which lands in the same
 * `default` — so the two agree without this file restating the prefix chain.
 * Measured on the pinned 21-day xpcshell aggregate: 13 of 4,838 tests carry a
 * non-zero `EXPECTED-FAIL`, 4,973 runs, all excluded from these charts by both
 * pages.
 *
 * An entry whose `day` is past the end of the window is dropped, as upstream's
 * `if (day < days)` does (`:2404`).
 */
export function testDailyOutcomes(
    file: DecodedTimingFile,
    testId: number,
    startTime: number
): DailyOutcomes[] {
    const days = chartDays(file);
    const series = emptyDays<DailyOutcomes>(days, startTime, (day, date) => ({
        day,
        date,
        passes: 0,
        failures: 0,
        timeouts: 0,
        crashes: 0,
        skips: 0,
    }));
    for (const entry of file.runsOfTest(testId)) {
        const day = entry.day;
        if (day === null || day < 0 || day >= days) {
            continue;
        }
        const bucket = series[day]!;
        switch (classifyStatus(entry.status).kind) {
            case 'pass':
                bucket.passes += entry.count;
                break;
            case 'crash':
                bucket.crashes += entry.count;
                break;
            case 'timeout':
                bucket.timeouts += entry.count;
                break;
            case 'skip':
                bucket.skips += entry.count;
                break;
            case 'fail':
                bucket.failures += entry.count;
                break;
            default:
                // `expected-fail` and `unknown`. Upstream's five-branch chain
                // matches neither, so neither is counted; see above.
                break;
        }
    }
    return series;
}

/**
 * The per-component series: every test in the component, summed day by day.
 *
 * `calculateComponentDailyFailureRates` (`old/issues.html:2467`), which calls the
 * per-test function once per test and adds the five fields. Reproduced as the
 * same loop.
 *
 * **Which tests.** Upstream passes `group.tests` — the component's tests *after
 * the search filtered them*, and only those with an issue, because that is what
 * `renderComponentsView` put in the group (`:2016`). So a search narrows the
 * chart as well as the row, and a clean test contributes no passes to the
 * denominator. Both are upstream's and both are reproduced by the caller
 * passing `row.tests`.
 */
export function componentDailyOutcomes(
    file: DecodedTimingFile,
    tests: readonly IssueRow[],
    startTime: number
): DailyOutcomes[] {
    const days = chartDays(file);
    const series = emptyDays<DailyOutcomes>(days, startTime, (day, date) => ({
        day,
        date,
        passes: 0,
        failures: 0,
        timeouts: 0,
        crashes: 0,
        skips: 0,
    }));
    for (const test of tests) {
        const perTest = testDailyOutcomes(file, test.testId, startTime);
        for (let day = 0; day < days; day++) {
            const into = series[day]!;
            const from = perTest[day]!;
            into.passes += from.passes;
            into.failures += from.failures;
            into.timeouts += from.timeouts;
            into.crashes += from.crashes;
            into.skips += from.skips;
        }
    }
    return series;
}

/**
 * The per-issue-message series: one message's occurrences by day, over the runs
 * that could have produced it.
 *
 * `calculateIssueMessageDailyRates` (`old/issues.html:2513-2698`). Two rules are
 * upstream's and both are reproduced:
 *
 * - **The denominator counts every status group**, `EXPECTED-FAIL` included
 *   (`:2534-2570` has no classification at all, only a SKIP exclusion) — so it
 *   is *not* the `runCount` the row above it shows, and it is not built from
 *   `classifyStatus`. Written as the same unconditional walk.
 * - **SKIP is in the denominator only for a SKIP line** (`:2540-2542`): a skip
 *   rate is over scheduled runs, every other rate is over runs that executed.
 *
 * ## The one divergence: all matching statuses, not the first
 *
 * Upstream resolves the issue type to **one** `targetStatusId` and `break`s out
 * of the search (`:2574-2590`), then counts only that group. With
 * `tables.statuses` ordered `… TIMEOUT-PARALLEL, FAIL-PARALLEL, … CRASH,
 * FAIL-SEQUENTIAL, TIMEOUT, FAIL, TIMEOUT-SEQUENTIAL`, that is `FAIL-PARALLEL`
 * for every FAIL line and `TIMEOUT-PARALLEL` for every TIMEOUT line — the runs
 * recorded under the other suffixes are dropped from the chart.
 *
 * **Measured on the pinned 21-day xpcshell aggregate**: 2,792 of the 3,788
 * tests with any failure have more than one `FAIL*` group, and 214 have more
 * than one `TIMEOUT*` group. A concrete case,
 * `toolkit/components/backgroundtasks/tests/xpcshell/test_backgroundtask_automaticrestart.js`
 * on `[test_backgroundtask_automatic_restart : 23] 0 == 3` — 48 runs under
 * `FAIL-PARALLEL` and 3 under `FAIL`, of which upstream charts 48.
 *
 * This is reproduced as a **fix**, not as a bug, because upstream contradicts
 * itself here rather than making a choice: the count rendered on the issue line
 * (`issueEntries`, from every `FAIL*` group) and the run list under it
 * (`getIssueRuns`, `:3168-3172`, which explicitly collects **all** `FAIL*`
 * status ids) both use the full set, and only the chart uses one. Reproducing
 * the chart's version would put a bar summing to 48 directly beneath a line
 * reading 51 and a list of 51 rows. Declared as divergence **6** in
 * `site/issues.ts` — this pointer said 8 while the list had seven entries, and
 * 8 is now the view control, so it would have pointed at the wrong one.
 */
export function messageDailyRates(
    file: DecodedTimingFile,
    testId: number,
    type: IssueEntry['type'],
    message: string,
    startTime: number
): DailyMessageRate[] {
    const days = chartDays(file);
    const series = emptyDays<DailyMessageRate>(days, startTime, (day, date) => ({
        day,
        date,
        count: 0,
        totalRuns: 0,
    }));

    for (const entry of file.runsOfTest(testId)) {
        const day = entry.day;
        if (day === null || day < 0 || day >= days) {
            continue;
        }
        const bucket = series[day]!;
        const isSkip = entry.status === 'SKIP';

        // The denominator (`:2534-2570`): every group, with SKIP excluded
        // unless this is a SKIP line.
        if (type === 'SKIP' || !isSkip) {
            bucket.totalRuns += entry.count;
        }

        if (matchesIssueLine(entry, type, message)) {
            bucket.count += entry.count;
        }
    }
    return series;
}

/**
 * Whether one decoded run entry belongs to an issue line.
 *
 * The message tests upstream applies inside each of its three shape branches
 * (`:2604-2626` and its two copies), unified — the shapes differ in how a count
 * is read, which `runsOfTest` has already resolved, and not in how a message is
 * matched.
 *
 * A TIMEOUT line matches every run of a timeout status (`:2606`), because the
 * format records no per-timeout message; the synthetic `FAILURE_NO_MESSAGE` and
 * `CRASH_NO_SIGNATURE` lines match the runs whose message or signature is
 * absent, which is how the two "not recorded" lines get a chart at all.
 *
 * **One function for the chart and for the run list.** `getIssueRuns`
 * (`old/issues.html:3148`) applies the same four tests to decide which runs a line
 * lists, with one difference that is an upstream oversight rather than a
 * decision: its FAIL branch tests `message === issueMessage ||
 * (!message && issueMessage === FAILURE_NO_MESSAGE)` (`:3183`) while its CRASH
 * branch tests the matching pair for `CRASH_NO_SIGNATURE` (`:3199`) — so both
 * synthetic lines do list their runs upstream. Sharing this predicate is what
 * keeps the chart's bars summing to the number of rows the same click reveals.
 */
export function matchesIssueLine(
    entry: { status: string; message?: string | null; crashSignature?: string | null },
    type: IssueEntry['type'],
    message: string
): boolean {
    const kind = classifyStatus(entry.status).kind;
    switch (type) {
        case 'TIMEOUT':
            return kind === 'timeout';
        case 'SKIP': {
            if (kind !== 'skip') {
                return false;
            }
            const clean = displaySkipMessage(entry.message ?? '');
            return clean === message;
        }
        case 'FAIL': {
            if (kind !== 'fail') {
                return false;
            }
            const text = entry.message ?? '';
            return message === FAILURE_NO_MESSAGE ? text === '' : text === message;
        }
        case 'CRASH': {
            if (kind !== 'crash') {
                return false;
            }
            const signature = entry.crashSignature ?? '';
            return message === CRASH_NO_SIGNATURE ? signature === '' : signature === message;
        }
    }
}

/**
 * Whether a component or test chart has anything to draw, and on which canvas.
 *
 * `createFailureRateChart` (`old/issues.html:2813`) draws **two** canvases and hides
 * either one independently: the stacked failure/timeout/crash chart when the
 * window holds any of those (`:2827`), and the skips chart when it holds any
 * skip (`:2828`). A test that was only ever skipped therefore shows one chart,
 * not two, and a component with neither shows none.
 *
 * Returned as data rather than decided inside the renderer so
 * `test/issues-view.test.ts` can assert it without a canvas.
 */
export function chartVisibility(series: readonly DailyOutcomes[]): {
    issues: boolean;
    skips: boolean;
} {
    return {
        issues: series.some((d) => d.failures > 0 || d.timeouts > 0 || d.crashes > 0),
        skips: series.some((d) => d.skips > 0),
    };
}

// --- the platform-breakdown tooltips -------------------------------------

/** Which stat cell a hover tooltip describes. `old/issues.html:825`, `:829`, `:833`. */
export type TooltipType = 'skips' | 'failures' | 'timeouts';

/** One platform's counts, for a hover tooltip. `old/issues.html:1210-1216`. */
export interface PlatformCounts {
    platform: string;
    skips: number;
    failures: number;
    timeouts: number;
}

/**
 * A test's runs broken down by platform, for the hover tooltips.
 *
 * `calculateTestPlatformBreakdown` (`old/issues.html:1204-1290`), reduced to the
 * three counters the three tooltips display. It counts only runs the file
 * attributes to a task, which is upstream's `if (!statusGroup.taskIdIds)
 * continue` (`:1222`) — before the detailed file is merged that is every run,
 * and the tooltip is empty.
 *
 * The `run-if` exclusion is upstream's (`:1231-1233`) and is the same rule the
 * Skips column already applies: a test scoped to another platform is not a
 * skip. It is applied through `skipReason` rather than through upstream's
 * `startsWith('run-if')` because that is where this repository keeps the rule.
 *
 * `passes` and `total` are **not** returned. Upstream accumulates both
 * (`:1249-1251`) and no tooltip type reads either — `generateTooltipContent`
 * (`:1330`) uses only `counts[type]` for the type it was asked for. Measured on
 * the live 21-day xpcshell pair, they could not be right if they were: the
 * `-with-taskids` file attributes all 2,370,307 non-passing runs to a task and
 * **none** of the 38,725,638 passing ones, which stay `counts`-shaped. A
 * `passes` counter would therefore read 0 for every platform on every test.
 */
export function platformBreakdown(
    file: DecodedTimingFile,
    testId: number,
    platformOf: (jobName: string) => string
): PlatformCounts[] {
    const byPlatform = new Map<string, PlatformCounts>();
    for (const entry of file.runsOfTest(testId)) {
        const indexes = entry.taskIdIndexes;
        if (indexes === undefined) {
            continue;
        }
        const kind = classifyStatus(entry.status).kind;
        let field: keyof Omit<PlatformCounts, 'platform'>;
        if (kind === 'skip') {
            if (skipReason(entry.message) === 'run-if') {
                continue;
            }
            field = 'skips';
        } else if (kind === 'timeout') {
            field = 'timeouts';
        } else if (kind === 'fail' || kind === 'crash') {
            // Upstream's `isFail` is "not in a list of nine" (`:1219`), which
            // puts CRASH here — the one place on this page that folds crashes
            // into failures. `classifyStatus` names them apart, so the fold is
            // written out where a reader can see it.
            field = 'failures';
        } else {
            continue;
        }
        for (const index of indexes) {
            const jobName = file.jobNameOfTaskIndex(index);
            const platform = jobName === null ? 'unknown' : platformOf(jobName) || 'unknown';
            let counts = byPlatform.get(platform);
            if (counts === undefined) {
                counts = { platform, skips: 0, failures: 0, timeouts: 0 };
                byPlatform.set(platform, counts);
            }
            counts[field] += 1;
        }
    }
    return [...byPlatform.values()];
}

/** One line of a rendered tooltip: a platform, its count and its share. */
export interface TooltipLine {
    platform: string;
    count: number;
    /** `count / (the total across platforms) * 100`, to one decimal. */
    percentage: string;
}

/**
 * The platform lines of a tooltip, ranked and with their shares.
 *
 * `generateTooltipContent`'s count branch (`old/issues.html:1348-1372`): platforms
 * with a zero for this type are dropped (`:1350`), the rest are ranked by count
 * descending (`:1351`), and each share is over the **sum of the surviving
 * platforms** and not over the test's runs (`:1356`) — so the shares add to
 * 100%. Rounded once, with `toFixed(1)`, from the raw ratio.
 *
 * An empty array means no tooltip is shown at all (`:1353`), which is upstream's
 * behaviour and the reason a cell with an unattributed count shows nothing
 * rather than an empty box.
 */
export function tooltipLines(
    breakdown: readonly PlatformCounts[],
    type: TooltipType
): TooltipLine[] {
    const present = breakdown.filter((counts) => counts[type] > 0);
    present.sort((a, b) => b[type] - a[type]);
    const total = present.reduce((sum, counts) => sum + counts[type], 0);
    return present.map((counts) => ({
        platform: counts.platform,
        count: counts[type],
        percentage: ((counts[type] / total) * 100).toFixed(1),
    }));
}

/** The heading above a tooltip's platform lines. `old/issues.html:1357`. */
export const TOOLTIP_HEADING: Record<TooltipType, string> = {
    skips: 'Skips by Platform:',
    failures: 'Failures by Platform:',
    timeouts: 'Timeouts by Platform:',
};

// --- URL state -----------------------------------------------------------

/** The hash state this page carries. */
export interface UrlState {
    date: string;
    q: string;
    /** Which of the three "Show as" radios is selected. */
    view: ViewMode;
    /**
     * Which issue types are counted, as `encodeFilters` writes them.
     *
     * Added with `tests.html`, which needed it: these four boxes change every
     * number on the page, so a shared link that silently re-checks them
     * answers a different question from the one it was sent about.
     */
    issues: string;
}

/** The value that means the 21-day aggregate. `old/issues.html:3755`. */
export const HISTORICAL_DATE = '21days';

/**
 * Whether a hash's `date` means the 21-day view.
 *
 * **This is the deliberate behaviour change, and it is the only one on this
 * migration that changes what a reader sees on load.**
 *
 * `issues.html` defaults to the **single most recent day**: with no hash,
 * `:3709-3712` falls through to `loadData()`, which reads the `date-select`'s
 * first option. The `isHistoricalMode = false` at `:666` is not the reason —
 * it describes the state before the first load — but the effect is that the
 * page opens on one day.
 *
 * The migrated page **defaults to the 21-day aggregate**, which is what
 * `fx-tests issues` already does and what `test/framing.test.ts` recorded as
 * the acceptance criterion for this migration. The rationale, from the owner:
 * *"I always use the issues page with #date=21days in the url"*, and 21 days
 * being the default *"would be an improvement"*.
 *
 * The two windows answer measurably different questions. On the pinned
 * xpcshell data: the 21-day file has **133 components** with an issue against
 * the single day's **87**, and while the top ten components are the same set,
 * the order differs — `Toolkit :: Add-ons Manager` is 6th over 21 days and 7th
 * on 2026-08-04, swapping with `Toolkit :: Crash Reporting`. A component that
 * had one bad night ranks high on a single day and is diluted 21-fold in the
 * aggregate, which is the case the change is for.
 *
 * `#date=<a day>` still selects that day, unchanged — see
 * `test/issues-page.test.ts`, which drives both.
 */
export function isHistoricalDate(date: string | undefined): boolean {
    return date === undefined || date === '' || date === HISTORICAL_DATE;
}

/**
 * Reads the three keys this page uses out of a parsed hash.
 *
 * `view` **is** read now, which is a change: `getCurrentView()` used to return
 * the constant `'components'` (`old/issues.html:887-890`) so the parameter was
 * never written and nothing read it back. The radios make it a real control,
 * and the read follows `xpcshell-timings.html:3146-3147` — that page resolves
 * an absent `view` to `'components'` and looks the radio up by value.
 *
 * Validated rather than trusted, as `site/errors-view.ts:1434-1437` does:
 * `#view=bogus` leaves the page on the view it is on rather than on a view with
 * no renderer. That is the difference between `isViewMode` here and the
 * upstream `querySelector` returning null, which has the same effect by
 * accident.
 */
export function readUrlState(params: URLSearchParams): Partial<UrlState> {
    const state: Partial<UrlState> = {};
    const date = params.get('date');
    if (date !== null) {
        state.date = date;
    }
    const q = params.get('q');
    if (q !== null) {
        state.q = q;
    }
    const view = params.get('view');
    if (view !== null && isViewMode(view)) {
        state.view = view;
    }
    return state;
}

export type { IssueGroup, IssueRow, IssueType };
