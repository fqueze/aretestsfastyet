/**
 * `tests.html`'s **view model**: every decision the page makes, as plain
 * functions over plain data.
 *
 * The page sits between `issues.html` and `test.html`. `issues.html` ranks the
 * whole tree by component and drills down; `test.html` shows one test's whole
 * history with a day filter. This page fixes the *folder* and keeps the day
 * filter: one directory's worth of tests, ranked worst first, over a day range
 * the reader picks off the timeline.
 *
 * ## Why a third page rather than a mode on one of the other two
 *
 * The question it answers is not either page's. `issues.html` asks "where in
 * the tree is the work", which is a ranking over everything and is answered
 * before you know which folder you are fixing. `test.html` asks "what is wrong
 * with this one test", which is answered after. Between them is the question a
 * burndown actually runs on — *"I fixed six tests in this folder last week; what
 * is left?"* — and neither page can answer it, for one reason each:
 *
 * - `issues.html` has no day range at all. Its window is a single day or the
 *   whole 21, so "since the fixes landed" is not expressible.
 * - `test.html` has the range (its day chart is already a shift-click range
 *   selector) but only ever holds one test, so it cannot list what remains.
 *
 * ## The seam
 *
 * `lib/` holds the data and the derivations; this file holds the view model,
 * *including anything naming an element id, a CSS class or a UI glyph*. It
 * imports no DOM — the root `tsconfig.json` compiles `test/**` with no DOM lib,
 * so a `document` reach here fails `npm run typecheck` rather than at runtime.
 *
 * Almost nothing here is new arithmetic. The counters, the ranking and the
 * issue lines are `lib/query/issues.ts` and `lib/query/test-issues.ts`, which
 * `fx-tests issues` and `fx-tests test` already run on; what this file adds is
 * the *folder* and the *range* — and both of those were already parameters of
 * those functions (`IssuesOptions.pathPrefix`, `IssuesOptions.dayRange`),
 * waiting for a caller. That is why this page is small.
 */

import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import { type IssueRow, findIssues } from '../lib/query/issues.ts';
import { type IssueFilters, encodeFilters, typesOf } from './issue-filters.ts';
import { type FlakyDay, dateOfDay, startDateOf } from '../lib/query/flakiness.ts';
import { type TestIssue, buildTestIssues } from '../lib/query/test-issues.ts';
import { computeTestStats } from '../lib/query/test-stats.ts';
import { classifyStatus } from '../lib/model/status.ts';
import { skipReason } from '../lib/model/skips.ts';

// --- the day range -------------------------------------------------------

/**
 * A closed range of absolute day indices, day 0 being the **oldest**.
 *
 * Both ends inclusive, which is `lib/query`'s convention throughout
 * (`inDayRange`, `lib/query/test-stats.ts:109`) and not a choice this page
 * gets to make: the range is handed to `findIssues` and `buildTestIssues`
 * unchanged, so a half-open range here would silently drop a day there.
 *
 * `null` means the whole window, and is distinct from a range covering every
 * day: the status line says "all 21 days" rather than naming two dates, and the
 * hash carries no `from`/`to`. A reader who has not touched the timeline should
 * not get a URL that pins the range they happen to be looking at, because
 * tomorrow that URL means a different window.
 */
export interface DayRange {
    from: number;
    to: number;
}

/**
 * The range as `lib/query` wants it, or `undefined` for the whole window.
 *
 * `exactOptionalPropertyTypes` is on, so `{ dayRange: undefined }` and `{}` are
 * different types and the spread has to be conditional at each call site. This
 * returns the value rather than the wrapper so each caller spreads
 * `...(range === null ? {} : { dayRange: range })` once.
 */
export function queryRange(range: DayRange | null): DayRange | undefined {
    return range === null ? undefined : range;
}

/**
 * The range a reader's two clicks mean, whichever order they clicked in.
 *
 * Normalizing here rather than at the click site is what lets the timeline
 * treat "anchor" and "extend" symmetrically: dragging right to left is the same
 * range as left to right, and neither the renderer nor the hash has to know
 * which end was clicked first.
 */
export function rangeOf(anchor: number, other: number): DayRange {
    return { from: Math.min(anchor, other), to: Math.max(anchor, other) };
}

/**
 * The range clamped to the days a file actually has, or `null` if it cannot be.
 *
 * A hash is user input and outlives the data it was written against: `#from=40`
 * on a 21-day file, or a URL shared last month, are both ordinary rather than
 * exceptional. Clamping matches `flakinessByFolder`'s treatment of `fromDay`
 * (`lib/query/flakiness.ts:735`, "clamped rather than refused") — asking for
 * days that are not there is a reasonable thing to type and the answer is the
 * days that exist.
 *
 * `null` when the range misses the file entirely, so the caller falls back to
 * the whole window instead of showing an empty list that looks like a clean
 * folder.
 */
export function clampRange(range: DayRange, days: number): DayRange | null {
    if (days <= 0) {
        return null;
    }
    const last = days - 1;
    const from = Math.max(0, Math.min(range.from, last));
    const to = Math.max(0, Math.min(range.to, last));
    if (range.to < 0 || range.from > last) {
        return null;
    }
    return { from: Math.min(from, to), to: Math.max(from, to) };
}

/** How many days a range covers. */
export function rangeLength(range: DayRange): number {
    return range.to - range.from + 1;
}

/** Whether a range is the file's whole window, so the hash can omit it. */
export function isWholeWindow(range: DayRange | null, days: number): boolean {
    return range === null || (range.from <= 0 && range.to >= days - 1);
}

// --- the harnesses -------------------------------------------------------

/** Which harness's data a file describes. */
export type Harness = 'xpcshell' | 'mochitest';

/** Both harnesses, in the order they are shown. */
export const HARNESSES: readonly Harness[] = ['xpcshell', 'mochitest'];

/**
 * How a harness reads in the heading.
 *
 * There is no harness *selector* any more: the page loads both aggregates and
 * merges them, so `?kind=` only ever meant "show me less" — and picking a
 * single harness left the dropdown with one option and no way back to both.
 * What is left is the label, for stating which harnesses a path actually has
 * tests in.
 */
export const SCOPE_LABEL: Record<Harness, string> = {
    xpcshell: 'XPCShell',
    mochitest: 'Mochitest',
};

/** One harness's loaded file, and the dates it covers. */
export interface LoadedHarness {
    harness: Harness;
    file: DecodedTimingFile;
    /** The window's dates, oldest first, indexed by day. */
    dates: string[];
}

/**
 * Which harnesses actually have tests under a folder.
 *
 * The answer to "detect which harness makes sense for a folder": ask the data
 * rather than the path. `detectHarness` (`lib/model/harness.ts`) guesses from a
 * *filename* and cannot be asked about a directory at all — and its own comment
 * records that `test_foo.js` is ambiguous between the two harnesses, so even
 * per-file it is a heuristic with a documented hole.
 *
 * A folder with no tests in either is reported as empty rather than defaulted,
 * so the page can say so instead of showing a clean folder that does not exist.
 */
export function harnessesWithTests(
    loaded: readonly LoadedHarness[],
    folder: string
): Harness[] {
    const prefix = pathPrefixOf(folder);
    return loaded
        .filter(({ file }) => {
            for (let testId = 0; testId < file.testCount; testId++) {
                const path = file.testAt(testId).fullPath;
                if (prefix === undefined || path.startsWith(prefix)) {
                    return true;
                }
            }
            return false;
        })
        .map(({ harness }) => harness);
}

// --- the timeline --------------------------------------------------------

/** One day of the timeline, with whether the current range covers it. */
export interface TimelineDay {
    day: number;
    /** `YYYY-MM-DD`. */
    date: string;
    flaky: number;
    skipped: number;
    stable: number;
    total: number;
    /** Inside the selected range. Every day, when nothing is selected. */
    selected: boolean;
    /**
     * A day whose population is too thin to be a measurement.
     *
     * `lib/query/flakiness.ts`'s `thinDays`, carried onto the day so the
     * renderer can leave a gap rather than plot a notch to the axis — see
     * `THIN_DAY_SHARE` for the one published day this describes.
     */
    thin: boolean;
}

/** The timeline as the renderer wants it. */
export interface Timeline {
    days: TimelineDay[];
    /** Chart labels, `MM-DD` or `YYYY-MM-DD` — see `axisLabels`. */
    labels: string[];
    /**
     * Flaky counts, `null` on a thin day so the line breaks.
     *
     * A count and not a percentage: this page is scoped to one folder, where
     * the denominator is a few dozen tests and a percentage of it swings on one
     * test. The tree-wide percentage view belongs to `flaky.html`, which has
     * thousands of tests under it.
     */
    flaky: (number | null)[];
    skipped: (number | null)[];
}

/**
 * The timeline over a folder's whole window, with the range marked on it.
 *
 * **The series is never clipped to the range**, which is the point of having a
 * timeline at all: a burndown reader picks the range *by looking at the shape*,
 * and a chart showing only what they already selected cannot tell them the
 * fixes landed on the 4th. So the range is a highlight over a full-window
 * series, not a filter on it — the filter applies to the list below.
 */
export function timeline(
    days: readonly FlakyDay[],
    thin: readonly boolean[],
    range: DayRange | null
): Timeline {
    const rows: TimelineDay[] = days.map((day, index) => ({
        day: day.day,
        date: day.date,
        flaky: day.flaky,
        skipped: day.skipped,
        stable: day.stable,
        total: day.total,
        selected: range === null || (day.day >= range.from && day.day <= range.to),
        thin: thin[index] ?? false,
    }));
    return {
        days: rows,
        labels: axisLabels(rows.map((row) => row.date)),
        // `null` and not 0 on a thin day, with `spanGaps: false` on the
        // dataset: 2026-07-11 ran 128 of ~4,600 xpcshell tests, and plotted as
        // 0 it reads as a fixed folder rather than as a day the tree did not
        // run. `flaky.html` reached the same conclusion the same way.
        flaky: rows.map((row) => (row.thin ? null : row.flaky)),
        skipped: rows.map((row) => (row.thin ? null : row.skipped)),
    };
}

/**
 * Date labels, carrying the year only when the window spans more than one.
 *
 * `flaky.html`'s rule (`site/flaky-view.ts:chartSeries`): `12-21` followed by
 * `01-10` is ambiguous, and a 21-day window never needs the year.
 */
export function axisLabels(dates: readonly string[]): string[] {
    const years = new Set(dates.map((date) => date.slice(0, 4)));
    return years.size > 1 ? [...dates] : dates.map((date) => date.slice(5));
}

// --- the issue-count timeline --------------------------------------------

/** One day of the issue-count chart. */
export interface IssueDay {
    day: number;
    date: string;
    failures: number;
    timeouts: number;
    crashes: number;
    skips: number;
    /** Runs that reached a verdict, for the tooltip's denominator. */
    executed: number;
    /** Inside the selected range. */
    selected: boolean;
}

/** The issue-count chart, and the per-test overlay when one is hovered. */
export interface IssueTimeline {
    days: IssueDay[];
    labels: string[];
    failures: number[];
    timeouts: number[];
    crashes: number[];
    skips: number[];
    /** Whether any day has a non-skip issue, so the chart is worth drawing. */
    hasIssues: boolean;
    /** Whether any day has a skip. */
    hasSkips: boolean;
}

/**
 * Per-day issue **counts** for a folder, across every loaded harness.
 *
 * This is `issues.html`'s question rather than `flaky.html`'s, and the two
 * genuinely differ: that page counts *tests* that were flaky on a day, this
 * counts *occurrences*. A folder where one test fails 400 times a day and a
 * folder where 400 tests fail once each read identically on the first chart and
 * nothing alike on this one, and a burndown needs both — the first says how
 * many things are broken, the second says how loud they are.
 *
 * Counts, not percentages. `issues.html` plots a rate because it compares
 * components of wildly different sizes; here the population is one folder and
 * fixed, so a count is directly readable and a rate would hide that 3,700
 * failures became 400.
 */
export function issueTimeline(
    loaded: readonly LoadedHarness[],
    folder: string,
    range: DayRange | null,
    dates: readonly string[]
): IssueTimeline {
    const days: IssueDay[] = dates.map((date, day) => ({
        day,
        date,
        failures: 0,
        timeouts: 0,
        crashes: 0,
        skips: 0,
        executed: 0,
        selected: range === null || (day >= range.from && day <= range.to),
    }));

    for (const { file } of loaded) {
        forEachIssueEntry(file, folder, (day, kind, count) => {
            const bucket = days[day];
            if (bucket === undefined) {
                return;
            }
            switch (kind) {
                case 'fail':
                    bucket.failures += count;
                    bucket.executed += count;
                    break;
                case 'timeout':
                    bucket.timeouts += count;
                    bucket.executed += count;
                    break;
                case 'crash':
                    bucket.crashes += count;
                    bucket.executed += count;
                    break;
                case 'skip':
                    // A skip is not an executed run, so it stays out of the
                    // denominator — `issues.html`'s rule, and the reason its
                    // two charts have two denominators.
                    bucket.skips += count;
                    break;
                case 'other':
                    bucket.executed += count;
                    break;
            }
        });
    }

    return {
        days,
        labels: axisLabels(dates),
        failures: days.map((day) => day.failures),
        timeouts: days.map((day) => day.timeouts),
        crashes: days.map((day) => day.crashes),
        skips: days.map((day) => day.skips),
        hasIssues: days.some((day) => day.failures + day.timeouts + day.crashes > 0),
        hasSkips: days.some((day) => day.skips > 0),
    };
}

/**
 * One test's own contribution to each day, for the hover overlay.
 *
 * What `test.html` does when the reader hovers a cell — show the hovered
 * thing's share of the same bars — applied to a folder's rows. Returned as
 * plain arrays so the renderer can hand them to Chart.js as a second, brighter
 * dataset stacked under the remainder, and so a test can assert the numbers
 * without a canvas.
 */
export interface TestContribution {
    failures: number[];
    timeouts: number[];
    crashes: number[];
    skips: number[];
}

/** The per-day counts of a single test, over the same days as the chart. */
export function testContribution(
    loaded: readonly LoadedHarness[],
    testPath: string,
    dayCount: number
): TestContribution {
    const zero = (): number[] => new Array<number>(dayCount).fill(0);
    const out: TestContribution = {
        failures: zero(),
        timeouts: zero(),
        crashes: zero(),
        skips: zero(),
    };
    for (const { file } of loaded) {
        const identity = file.findTest(testPath);
        if (identity === null) {
            continue;
        }
        for (const entry of file.runsOfTest(identity.testId)) {
            if (entry.day === null || entry.day < 0 || entry.day >= dayCount) {
                continue;
            }
            const kind = issueKindOf(entry.status, entry.message);
            const target =
                kind === 'fail'
                    ? out.failures
                    : kind === 'timeout'
                      ? out.timeouts
                      : kind === 'crash'
                        ? out.crashes
                        : kind === 'skip'
                          ? out.skips
                          : null;
            if (target !== null) {
                target[entry.day] = (target[entry.day] ?? 0) + entry.count;
            }
        }
    }
    return out;
}

/** What one run entry counts as, for the issue charts. */
type IssueKind = 'fail' | 'timeout' | 'crash' | 'skip' | 'other';

/**
 * Classifies one entry for the count charts.
 *
 * `run-if` skips are not issues — the annotation says the test is scoped to
 * another platform, so it not running here is the annotation working. Every
 * other kind comes straight from `classifyStatus`, so this page and
 * `issues.html` agree by calling the same function rather than by both
 * spelling out a prefix chain.
 */
function issueKindOf(status: string, message: string | null | undefined): IssueKind {
    switch (classifyStatus(status).kind) {
        case 'fail':
            return 'fail';
        case 'timeout':
            return 'timeout';
        case 'crash':
            return 'crash';
        case 'skip':
            return skipReason(message) === 'run-if' ? 'other' : 'skip';
        default:
            return 'other';
    }
}

/** Walks every run entry of every test under a folder. */
function forEachIssueEntry(
    file: DecodedTimingFile,
    folder: string,
    visit: (day: number, kind: IssueKind, count: number) => void
): void {
    const prefix = pathPrefixOf(folder);
    for (let testId = 0; testId < file.testCount; testId++) {
        if (prefix !== undefined && !file.testAt(testId).fullPath.startsWith(prefix)) {
            continue;
        }
        for (const entry of file.runsOfTest(testId)) {
            if (entry.day === null) {
                continue;
            }
            visit(entry.day, issueKindOf(entry.status, entry.message), entry.count);
        }
    }
}

// --- the worklist --------------------------------------------------------

/** The page's sortable columns. */
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
 * Most issues first — the burndown order.
 *
 * The same initial sort as `issues.html`, and for the same reason: the row a
 * reader wants is the worst one, and ranking by rate instead puts a test that
 * ran twice and failed once above one that failed 400 times.
 */
export const INITIAL_SORT: SortState = { field: 'issueCount', direction: 'desc' };

/**
 * The stat columns, in header order.
 *
 * `issues.html`'s seven, minus nothing: the columns are per-test there too, so
 * a reader moving between the pages reads the same row. `name` is not here
 * because it is the left-aligned path button rather than a stat cell.
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
 * The next sort after a header click.
 *
 * `issues.html`'s rule, including its exception: a new column starts descending
 * except `name` and `issuePercentage`, which start ascending. Ascending on a
 * rate surfaces the tests that are nearly clean, which is a real question and a
 * different one from "who is worst".
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

/** The sortable quantity of one row. */
function testValue(row: IssueRow, field: SortField): number {
    switch (field) {
        case 'runCount':
            return row.runCount;
        // The **raw ratio**, not the rounded percentage the cell shows: two
        // tests displaying `8%` are ordered by the digits behind the rounding
        // rather than arbitrarily. `issues.html` sorts the same quantity.
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

/**
 * The worklist, sorted. Ties break on path, so the order is total.
 *
 * Generic over the row so a `WorklistRow`'s `harness` survives the sort: a
 * signature returning `IssueRow[]` would widen it away and the badge column
 * would have nothing to read.
 */
export function sortTests<T extends IssueRow>(tests: readonly T[], sort: SortState): T[] {
    const sorted: T[] = [...tests];
    sorted.sort((a, b) => {
        if (sort.field === 'name') {
            return sort.direction === 'asc'
                ? a.fullPath.localeCompare(b.fullPath)
                : b.fullPath.localeCompare(a.fullPath);
        }
        const difference =
            sort.direction === 'asc'
                ? testValue(a, sort.field) - testValue(b, sort.field)
                : testValue(b, sort.field) - testValue(a, sort.field);
        // A stable tie-break, so re-rendering the same data cannot reorder rows
        // and two tests with identical counts keep a readable order.
        return difference !== 0 ? difference : a.fullPath.localeCompare(b.fullPath);
    });
    return sorted;
}

// The four checkboxes and their URL encoding live in `site/issue-filters.ts`,
// shared with `issues.html`; re-exported so this page's consumers have one
// import.
export {
    type IssueFilters,
    ALL_FILTERS,
    FILTER_IDS,
    decodeFilters,
    encodeFilters,
    typesOf,
} from './issue-filters.ts';

/** One row of the worklist: a test, its counts, and which harness ran it. */
export interface WorklistRow extends IssueRow {
    /** Which harness's file this row came from. */
    harness: Harness;
}

/** The folder's worklist and the numbers above it. */
export interface Worklist {
    /** Tests with at least one issue of an enabled type, sorted. */
    tests: WorklistRow[];
    /** Every test in the folder, clean ones included. */
    totalTestCount: number;
    /** Tests with an issue, before the search narrowed anything. */
    testsWithIssues: number;
    /** Sum of the rows' `issueCount`. */
    issueCount: number;
    /** Runs over every test in the folder, clean ones included. */
    runCount: number;
    skipCount: number;
    failCount: number;
    timeoutCount: number;
    crashCount: number;
    /** `issueCount` over the same denominator a row uses. */
    issueRate: number;
    /** Which harnesses contributed rows, for the badge column. */
    harnesses: Harness[];
}

/**
 * The prefix `findIssues` needs to mean "this folder and below".
 *
 * The trailing separator is the whole content of this function and the reason
 * it exists rather than being inlined: `dom/base` without it also selects
 * `dom/baseline`, which is a different folder and a wrong answer nobody would
 * notice in a list of 40 tests. `flakinessOfPath` documents the same trap on
 * the other side of the page.
 *
 * The empty folder is the whole tree, and gets no prefix at all — a
 * `startsWith('/')` would select nothing.
 */
export function pathPrefixOf(folder: string): string | undefined {
    const trimmed = folder.replace(/\/+$/, '');
    return trimmed === '' ? undefined : `${trimmed}/`;
}

/**
 * The folder's worklist over a day range, across every loaded harness.
 *
 * The order of operations is the substance, and it is `issues.html`'s
 * (`buildComponentRows`), which bought it with a measurement: **every** test is
 * counted into the denominators first, and only then is the list narrowed to
 * the ones with an issue. Dropping the clean tests first inflates every rate —
 * on WebExtensions :: General it read 6,087,719 runs instead of 6,131,520,
 * turning 8.7% into 8.8%.
 *
 * So `keepClean: true` here is not a spare flag: it is what makes "12 of 402
 * tests" and the Issue% column mean what they say.
 *
 * **Merging two harnesses is a concatenation, not a sum.** A test belongs to
 * exactly one harness's file, so the row sets are disjoint and the totals add;
 * there is no test to deduplicate and no run counted twice. What the merge does
 * need is the `harness` on each row, because two harnesses can hold a
 * same-named file in one directory and a reader has to be able to tell which
 * row is which.
 */
export function worklist(
    loaded: readonly LoadedHarness[],
    folder: string,
    filters: IssueFilters,
    range: DayRange | null,
    sort: SortState,
    searchTerm = ''
): Worklist {
    const types = typesOf(filters);
    const prefix = pathPrefixOf(folder);
    const dayRange = queryRange(range);

    const totals = {
        runCount: 0,
        skipCount: 0,
        failCount: 0,
        timeoutCount: 0,
        crashCount: 0,
    };
    let totalTestCount = 0;
    let testsWithIssues = 0;
    const listed: WorklistRow[] = [];
    const contributing: Harness[] = [];

    const term = searchTerm.trim().toLowerCase();
    for (const { harness, file } of loaded) {
        const rows = findIssues(file, {
            types,
            // Honest denominators — see the note above.
            keepClean: true,
            ...(prefix === undefined ? {} : { pathPrefix: prefix }),
            ...(dayRange === undefined ? {} : { dayRange }),
        });
        if (rows.length > 0) {
            contributing.push(harness);
        }
        totalTestCount += rows.length;
        for (const row of rows) {
            totals.runCount += row.runCount;
            totals.skipCount += row.skipCount;
            totals.failCount += row.failCount;
            totals.timeoutCount += row.timeoutCount;
            totals.crashCount += row.crashCount;
            if (row.issueCount > 0) {
                testsWithIssues++;
                if (term === '' || row.fullPath.toLowerCase().includes(term)) {
                    listed.push({ ...row, harness });
                }
            }
        }
    }

    // Recomputed from the enabled types over the folder's own totals, so the
    // header and a row are the same function of the same counters.
    const issueCount =
        (filters.skips ? totals.skipCount : 0) +
        (filters.failures ? totals.failCount : 0) +
        (filters.timeouts ? totals.timeoutCount : 0) +
        (filters.crashes ? totals.crashCount : 0);
    // `runCount` excludes skips, so a skipped run is added back only when skips
    // are one of the counted types — otherwise it would be in the numerator and
    // missing from the denominator. `issues.html`'s denominator exactly.
    const denominator = totals.runCount + (filters.skips ? totals.skipCount : 0);

    return {
        tests: sortTests(listed, sort),
        totalTestCount,
        testsWithIssues,
        issueCount,
        ...totals,
        issueRate: denominator > 0 ? (issueCount / denominator) * 100 : 0,
        harnesses: contributing,
    };
}

/**
 * One test's issue lines over the range, ranked.
 *
 * `lib/query/test-issues.ts`, which is what `test.html`'s Issue Details list
 * and `fx-tests test` both render — so a line here says what the same line on
 * `test.html` says, rather than agreeing by coincidence. It takes the range as
 * a `TestStatsOptions`, which is why this page's range reaches the messages and
 * not only the counts.
 *
 * Filtered **after** the library's sort, so unchecking a box leaves the
 * surviving lines in the order the reader already saw.
 */
export function issueLines(
    file: DecodedTimingFile,
    testId: number,
    filters: IssueFilters,
    range: DayRange | null
): TestIssue[] {
    const dayRange = queryRange(range);
    const options = dayRange === undefined ? {} : { dayRange };
    const stats = computeTestStats(file, testId, options);
    return buildTestIssues(file, testId, stats, options).filter((issue) =>
        isEnabled(issue.type, filters)
    );
}

/** Whether an issue line's type is one the reader asked for. */
export function isEnabled(type: TestIssue['type'], filters: IssueFilters): boolean {
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

/** The badge class for an issue type. `issues.html`'s four. */
export const BADGE_CLASS: Record<TestIssue['type'], string> = {
    SKIP: 'badge-skip',
    FAIL: 'badge-fail',
    CRASH: 'badge-crash',
    TIMEOUT: 'badge-timeout',
};

// --- presentation --------------------------------------------------------

/** A percentage cell: what it reads, and the colour band it lands in. */
export interface PercentageDisplay {
    displayValue: string;
    cssClass: string;
}

/**
 * The Issue% cell.
 *
 * `issues.html`'s treatment, bands included, so the same folder reads the same
 * colour on both pages. `<1%` rather than `0%` for a non-zero rate is the part
 * that matters: a folder with three skips in a million runs is not clean, and
 * rounding it to `0%` says it is.
 */
export function percentageDisplay(rate: number): PercentageDisplay {
    if (rate === 0) {
        return { displayValue: '0%', cssClass: 'zero' };
    }
    if (rate < 1) {
        return { displayValue: '<1%', cssClass: '' };
    }
    // Rounded once, from the raw ratio. Rounding a rounded value is how a
    // percentage on these dashboards shipped a wrong digit before.
    const rounded = Math.round(rate);
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

/** The `test.html` link for a test path. */
export function testPageUrl(fullPath: string): string {
    return `test.html?test=${encodeURIComponent(fullPath)}`;
}

/**
 * The `tests.html` link for a path.
 *
 * The entry point from `flaky.html`, `issues.html` and `test.html`.
 *
 * ## Why `?path=` and not `#path=`
 *
 * The path is what the page *is*, the way `?test=` is what `test.html` is —
 * not a view setting like the day range or the search term. A query parameter
 * is what the other pages use for that, and it is what a server or a crawler
 * sees.
 *
 * Named `path` rather than `folder` because these are prefixes: `dom` selects
 * everything under it, not a leaf directory's own tests.
 *
 * ## No harness in the link
 *
 * There used to be a `?kind=`, and it had to travel because `fetch-utils.js`
 * reads that key off the search string. The selector is gone — the page loads
 * both harnesses and merges them, so naming one was only a way to see less —
 * so a link carries the path and nothing else about the data.
 *
 * `date` is passed through rather than defaulted so a caller showing a
 * particular window hands it over; it stays in the hash, with the range and
 * the search, because it is a view setting.
 */
export function folderPageUrl(
    folder: string,
    options: { date?: string | undefined } = {}
): string {
    const search = new URLSearchParams({ path: folder });
    const url = `tests.html?${search.toString()}`;
    return options.date === undefined || options.date === ''
        ? url
        : `${url}#date=${encodeURIComponent(options.date)}`;
}

/** Each ancestor of a folder, root first, for the breadcrumb. */
export function breadcrumb(folder: string): { name: string; path: string }[] {
    const parts = folder.split('/').filter((part) => part !== '');
    const crumbs: { name: string; path: string }[] = [];
    let path = '';
    for (const part of parts) {
        path = path === '' ? part : `${path}/${part}`;
        crumbs.push({ name: part, path });
    }
    return crumbs;
}

/**
 * The line above the list saying what is being counted, over which days.
 *
 * Every number on this page depends on the range, and a reader comparing two
 * screenshots of a burndown has no other way to tell which window each was.
 * So the window is stated in words next to the counts rather than left to the
 * highlight on the chart.
 */
export function scopeLine(list: Worklist, range: DayRange | null, dates: readonly string[]): string {
    const tests =
        list.testsWithIssues === 1
            ? '1 test with issues'
            : `${list.testsWithIssues.toLocaleString()} tests with issues`;
    const outOf = `out of ${list.totalTestCount.toLocaleString()}`;
    const parts = [`${tests} ${outOf}`, rangeLabel(range, dates)];
    if (list.harnesses.length > 1) {
        // Only when the merge is actually doing something. Saying "xpcshell +
        // mochitest" over a folder that only has one would be noise, and worse,
        // would imply the other harness had been checked and was clean.
        parts.push(list.harnesses.map((harness) => SCOPE_LABEL[harness]).join(' + '));
    }
    return parts.join(' · ');
}

/**
 * The window in words.
 *
 * A single day names itself rather than reading "2026-09-04 → 2026-09-04",
 * and the whole window says so rather than naming its ends — a reader who has
 * not selected anything should not have to compare two dates to find that out.
 */
export function rangeLabel(range: DayRange | null, dates: readonly string[]): string {
    if (range === null || dates.length === 0) {
        return dates.length === 0 ? 'no data' : `all ${dates.length} days`;
    }
    const from = dates[range.from];
    const to = dates[range.to];
    if (from === undefined || to === undefined) {
        return `all ${dates.length} days`;
    }
    if (from === to) {
        return from;
    }
    const length = rangeLength(range);
    return `${from} → ${to} (${length} days)`;
}

/**
 * The dates the loaded harnesses share, oldest first.
 *
 * The two aggregates are generated by the same job on the same schedule, so in
 * practice they cover the same 21 days — but "in practice" is not something to
 * plot on, so this takes the **shortest** window and requires the end dates to
 * match. If they ever diverge, a chart built on the longer one would align
 * mochitest day 0 with xpcshell day 1 and silently attribute every failure to
 * the wrong date.
 *
 * Returns the dates plus whether the windows actually agreed, so the page can
 * say so rather than quietly dropping a day.
 */
export function mergedWindow(loaded: readonly LoadedHarness[]): {
    dates: string[];
    aligned: boolean;
} {
    const windows = loaded.map(({ dates }) => dates).filter((dates) => dates.length > 0);
    const first = windows[0];
    if (first === undefined) {
        return { dates: [], aligned: true };
    }
    const shortest = windows.reduce((a, b) => (b.length < a.length ? b : a), first);
    // Aligned when every window ends on the same date: the aggregates are
    // built backwards from "today", so a shared end date means a shared day
    // numbering once trimmed to the shortest.
    const end = first.at(-1);
    const aligned = windows.every((dates) => dates.at(-1) === end);
    return { dates: [...shortest], aligned };
}

/** The dates of a file's window, oldest first, indexed by day. */
export function windowDates(file: DecodedTimingFile): string[] {
    const days = file.days;
    if (days === null) {
        // A daily file is one day, and its entries carry a `null` day index —
        // there is nothing to range over, so the timeline is a single point.
        return [file.endDate];
    }
    const start = startDateOf(file);
    const dates: string[] = [];
    for (let day = 0; day < days; day++) {
        dates.push(dateOfDay(start, day));
    }
    return dates;
}

// --- URL state -----------------------------------------------------------

/**
 * The state this page reads and writes.
 *
 * `folder` and `kind` live in the **search string**, the rest in the hash —
 * see `folderPageUrl` for why. `readUrlState` takes both so a caller does not
 * have to know which half a key is in.
 */
export interface UrlState {
    /** The path being shown. From `?path=`. */
    folder?: string | undefined;
    /** The harness scope. From `?kind=`. */
    kind?: string | undefined;
    /** `21days`, or a `YYYY-MM-DD`. */
    date?: string | undefined;
    /** The search term. */
    q?: string | undefined;
    /** The range's first day, as an absolute index. */
    from?: string | undefined;
    /** The range's last day. */
    to?: string | undefined;
    /** The expanded test's path. */
    open?: string | undefined;
    /** Which issue types are counted, as `encodeFilters` writes them. */
    issues?: string | undefined;
    /**
     * How many days of history to load, from `#days=`.
     *
     * Absent means the one published window, which is the default. A larger
     * number means backfill older aggregates until the timeline is at least
     * this long, so a shared link shows the same span the sender was looking
     * at — and `from`/`to` are *absolute day indices*, so without this a
     * shared range would land on entirely different dates.
     */
    days?: string | undefined;
}

/** The value `date` takes for the 21-day window, matching `issues.html`. */
export const HISTORICAL_DATE = '21days';

/**
 * Whether a `date` hash value means the 21-day aggregate.
 *
 * An absent date is the aggregate. This page is a burndown view, so a window is
 * the only thing it can show progress over — and it is the default the owner
 * asked for on `issues.html`, which this page is read alongside.
 */
export function isHistoricalDate(date: string | undefined): boolean {
    return date === undefined || date === '' || date === HISTORICAL_DATE;
}

/**
 * Reads the URL into state.
 *
 * Two parameter sets, because this page's state lives in two places: `search`
 * holds what the page *is* and `hash` holds how it is being viewed. Reading
 * `path` from the search only is deliberate — a stray `#path=` from an old
 * link should not override `?path=`, and silently honouring both would make
 * two URLs that look different mean the same thing.
 */
export function readUrlState(hash: URLSearchParams, search?: URLSearchParams): UrlState {
    const read = (params: URLSearchParams, key: string): string | undefined => {
        const value = params.get(key);
        return value === null || value === '' ? undefined : value;
    };
    const query = search ?? new URLSearchParams();
    return {
        folder: read(query, 'path'),
        kind: read(query, 'kind'),
        date: read(hash, 'date'),
        q: read(hash, 'q'),
        from: read(hash, 'from'),
        to: read(hash, 'to'),
        open: read(hash, 'open'),
        issues: read(hash, 'issues'),
        days: read(hash, 'days'),
    };
}

/**
 * The range a hash names, or `null` for the whole window.
 *
 * Both ends must parse, because half a range is not a range: `#from=3` alone
 * would otherwise silently mean "day 3 to the end", which is a window the
 * reader never selected and cannot see is different from what they meant.
 */
export function parseRange(state: UrlState): DayRange | null {
    const from = Number(state.from);
    const to = Number(state.to);
    if (
        state.from === undefined ||
        state.to === undefined ||
        !Number.isInteger(from) ||
        !Number.isInteger(to)
    ) {
        return null;
    }
    return rangeOf(from, to);
}

/**
 * The hash for the current state, with defaults left out.
 *
 * `initUrlHashManager` drops falsy values, so every default has to serialize to
 * `''` rather than to its value — that is what keeps a reader who changed
 * nothing on `?path=dom/base` instead of growing an `&from=0&to=20`
 * that pins today's window into a URL they might share next month.
 */
export function urlStateOf(options: {
    search: string;
    range: DayRange | null;
    days: number;
    open: string | null;
    filters: IssueFilters;
    /**
     * The days one published aggregate covers, so a timeline that has not been
     * backfilled writes no `days=` at all. Omitted means "do not mention it",
     * which is what keeps an ordinary URL clean.
     */
    windowDays?: number | undefined;
}): Record<string, string> {
    const whole = isWholeWindow(options.range, options.days);
    const window = options.windowDays;
    return {
        q: options.search.trim(),
        from: whole || options.range === null ? '' : String(options.range.from),
        to: whole || options.range === null ? '' : String(options.range.to),
        open: options.open ?? '',
        issues: encodeFilters(options.filters),
        // Only once it is more than one window's worth: the default needs no
        // saying, and a `days=21` on every link would be noise.
        days:
            window === undefined || options.days <= window ? '' : String(options.days),
    };
}

/**
 * How many days a shared link asks for, or `null` for the default window.
 *
 * Clamped to something a page can actually fetch: the value goes into a loop
 * that fetches an aggregate per 20 days, so a hand-edited `#days=99999` would
 * otherwise sit there downloading until it ran out of published runs. The
 * ceiling is past the whole published record — which starts 2026-01-31 — so it
 * bounds the loop without bounding anything a reader could legitimately ask
 * for. Worth raising as the record grows.
 */
export function parseBackfillDays(state: UrlState): number | null {
    const raw = state.days;
    if (raw === undefined || raw === '') {
        return null;
    }
    const days = Number.parseInt(raw, 10);
    if (!Number.isFinite(days) || days <= 0) {
        return null;
    }
    return Math.min(days, MAX_BACKFILL_DAYS);
}

/**
 * The days one published aggregate covers.
 *
 * Load-bearing in `backfillPushdates`: consecutive runs overlap by one day, so
 * the step between pushdates is `WINDOW_DAYS - 1`. Getting it wrong by one
 * leaves a gap or a redundant fetch at every seam.
 */
export const WINDOW_DAYS = 21;

/** `date` shifted by `days`, as `YYYY-MM-DD`. */
export function shiftDate(date: string, days: number): string {
    const time = Date.parse(`${date}T00:00:00Z`);
    if (Number.isNaN(time)) {
        return date;
    }
    return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Every pushdate needed to reach `wanted` days, computed without fetching.
 *
 * Each published run's window ends on its pushdate and overlaps its newer
 * neighbour by one day, so a run adds exactly `WINDOW_DAYS - 1` days and the
 * pushdates are the current span's oldest date stepping back by that much at a
 * time. Being pure arithmetic is the point: it is what lets a page fetch the
 * whole set **in parallel** instead of discovering each pushdate from the
 * previous fetch, which is what made a shared link visibly settle through 21
 * then 41 then 61 days.
 *
 * The button's own path stays sequential, because it asks for one more window
 * and has to see the result to know whether another exists. A shared link
 * names its span up front, so it does not.
 */
export function backfillPushdates(oldest: string, have: number, wanted: number): string[] {
    const step = WINDOW_DAYS - 1;
    const steps = Math.ceil((wanted - have) / step);
    const dates: string[] = [];
    for (let index = 0; index < steps; index++) {
        dates.push(shiftDate(oldest, -index * step));
    }
    return dates;
}

/** The ceiling on `#days=`. Past the whole published archive. */
export const MAX_BACKFILL_DAYS = 400;

export type { IssueRow, TestIssue };
