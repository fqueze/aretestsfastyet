/**
 * `issues.html`, migrated onto `lib/`.
 *
 * The last and largest of the page migrations, and the only one with a
 * deliberate behaviour change (divergence 1 below).
 *
 * | file | contains | tested by |
 * | --- | --- | --- |
 * | `lib/query/issues.ts` | the per-test counters and the component grouping, shared with the CLI | `test/query.test.ts` |
 * | `site/issues-view.ts` | this page's view model — rows, sort, search, expansion, URL state | `test/issues-view.test.ts`, no DOM |
 * | this file | the renderer and the interactions | `test/issues-page.test.ts` + the browser run |
 *
 * The judgement on whether to reuse `site/drilldown-view.ts`, with the table of
 * shape differences behind it, is at the top of `site/issues-view.ts`. In one
 * line: that drill-down is *key → dirPath → test → occurrence* with a two-number
 * row and a path-collapse rule, and this page is *component → test → issue
 * message → occurrence* with nine numbers a row and no path level at all.
 * `drilldown-render.ts`'s small DOM helpers **are** reused.
 *
 * ## What the migration removes
 *
 * **A second, private `computeTestStats`.** `old/issues.html:944-1097` is a
 * 150-line fork that is not `common-test-data.js`'s — the page never loads that
 * file (`grep -c common-test-data issues.html` is 0; its `<script>` tags are
 * `:7-10`). The fork and `lib/query/issues.ts` were compared per test and field
 * by field on 4,838 xpcshell tests, 21,016 mochitest tests and two daily files
 * before either was reused: **zero mismatches** on every displayed number. The
 * table and the one non-displayed difference (`EXPECTED-FAIL`, folded into
 * `passCount` by the page and named separately by the library) are documented
 * at the top of `site/issues-view.ts`, together with the Issue% denominator.
 *
 * **The string-concatenation renderer**, and with it the `escapeHtml`/
 * `escapeAttr` calls and the `onclick=` attributes that a global function had to
 * satisfy. Building nodes answers escaping once, at `el()`.
 *
 * The five shared scripts **stay, loaded by name**: `fetch-utils.js`,
 * `dashboards.js`, `common-ui.js`, `common-links.js` and `shared.js`. They are
 * UI plumbing with no `lib/` equivalent and up to 22 unmigrated pages depend on
 * them; `tools/build-pages.ts` copies them next to the built page. Chart.js
 * comes from the same CDN tag the old page uses (`old/issues.html:3820`), moved
 * ahead of the module script because a `type="module"` script is deferred and
 * the CDN one is not — so `Chart` is defined before any of this runs, which is
 * the ordering the old page gets for free from an inline `<script>`.
 *
 * ## The two files the 21-day view loads
 *
 * `{harness}-issues.json` is 2.8 MB of **counts only**: every status group is
 * the `counts` shape, there is no `taskInfo` key, and nothing in it says which
 * job saw a failure. It is what the page renders its numbers from.
 *
 * `{harness}-issues-with-taskids.json` is the same 21 days at 15.9 MB, with
 * `taskIdIds` on the non-passing groups and a `taskInfo` to resolve them
 * through. `loadDetailedData` fetches it in the background when a component is
 * opened and swaps it in, which is what upstream does (`old/issues.html:3403`) and
 * what three features need: the run list under a failure message, the
 * per-issue-message chart, and the platform tooltips. Without it those three
 * have nothing to show.
 *
 * **The swap does not move a displayed number.** Measured on the live 21-day
 * xpcshell pair rather than assumed: `testInfo`, `tables.statuses` and
 * `tables.messages` are byte-identical between the two files, both describe the
 * same 4,838 tests, and all **58,056** status groups have identical run totals.
 * `test/issues-page.test.ts` asserts the rendered rows are unchanged across the
 * merge on the fixtures, which is what would catch the day the two files drift.
 *
 * ## Declared divergences from `issues.html`
 *
 * `PARITY.md` §4: byte-identical is the default and every exception is
 * declared. **This list is the whole set** — one enumerated list, no prose
 * carrying an extra entry, because that is exactly how an entry went missing on
 * an earlier migration.
 *
 *  1. **The default window is the 21-day aggregate, not the single most recent
 *     day.** The one deliberate behaviour change on this migration, and the
 *     reason this page was sequenced last.
 *
 *     `issues.html` opens on one day: with no hash, `:3709-3712` calls
 *     `loadData()`, which reads the `date-select`'s first option. (The
 *     `isHistoricalMode = false` at `:666` is not itself the cause — it
 *     describes the state before the first load — so the real default lives in
 *     that branch rather than in the initializer.) This page treats an absent
 *     `date` as `21days` and loads `{harness}-issues.json`.
 *
 *     Requested by the owner — *"I always use the issues page with
 *     #date=21days in the url"*, and 21 days being the default *"would be an
 *     improvement"* — and already recorded as this migration's acceptance
 *     criterion by `test/framing.test.ts`, whose `issues`/`window` divergence
 *     said it "closes when the page migrates". That entry has been updated;
 *     see the note under "framing" below.
 *
 *     **Measured on the pinned xpcshell data**, which is what makes this a
 *     change of substance rather than of default:
 *
 *     | | 21-day aggregate | 2026-08-04 alone |
 *     | --- | --- | --- |
 *     | components with an issue | **133** | **87** |
 *     | tests in the file | 4,838 | 4,836 |
 *     | rank 1 | WebExtensions :: General, 584,427 | WebExtensions :: General, 32,349 |
 *     | rank 6 / 7 | Add-ons Manager, then Crash Reporting | **Crash Reporting, then Add-ons Manager** |
 *
 *     The top ten are the same ten components, so the change is not a different
 *     answer — it is a steadier one: 46 components that had a quiet day
 *     reappear, and a component that had one bad night stops out-ranking a
 *     component that is broken every day.
 *
 *     **Both windows still work.** `#date=2026-08-04` selects that day and
 *     loads the daily file, the "Show Single Day" button leaves the aggregate,
 *     and the two shapes are different files with different structures —
 *     `{harness}-issues.json` (counts only, no `taskInfo`) against
 *     `{harness}-<date>.json`. `test/issues-page.test.ts` drives both.
 *
 *  2. **Inline handler attributes become `addEventListener`, and the three in
 *     the markup now throw once each.** The markup is byte-identical, so
 *     `onchange="loadData()"` on the `<select>` (`:611`),
 *     `onclick="toggleHistoricalData()"` on the button (`:614`) and
 *     `onchange="updateIssueFilters()"` on the four checkboxes (`:626-638`) are
 *     still attributes — but a module has no globals, so each attribute handler
 *     is a `ReferenceError` and the listener attached by this file does the
 *     work. This is the arrangement `site/crashes.html`, `site/failures.html`
 *     and `site/errors.html` already ship, and it is listed rather than fixed
 *     because fixing it means editing markup the brief holds byte-identical.
 *
 *     Every handler the page *generates* is gone: `onclick="changeSortOrder(…)"`
 *     on each of the 8 sort buttons (`:1153`, `:1168`),
 *     `onclick="copyTestName(…); event.stopPropagation();"` and
 *     `onclick="event.stopPropagation();"` on each test row's two buttons
 *     (`:844`, `:850`), and `onclick="toggleIssueRuns(this, event)"` on each
 *     issue line (`:3070`).
 *
 *     **Measured in Chrome on the pinned snapshot**, counting `on*` attributes
 *     in the live DOM under `#tree-container`:
 *
 *     | state | old | new |
 *     | --- | --- | --- |
 *     | first paint, 21-day xpcshell, 133 components collapsed | **8** | **0** |
 *     | WebExtensions :: General expanded (393 test rows) | **794** | **0** |
 *     | one test expanded on top of that (7 issue lines) | **801** | **0** |
 *
 *     The 8 at first paint are the sort buttons; the 786 added by one expansion
 *     are two per test row.
 *
 *     Re-measured on the 2026-08-04 pinned snapshot after the detailed file was
 *     restored, in case emitting the tooltip cells had brought an attribute
 *     back: first paint **8 → 0**, `Core :: Networking` expanded (628 test
 *     rows) **1,264 → 0**. The tooltip cells carry `data-*` and no `on*`.
 *
 *  3. **`data-path` is no longer how a row is found again.** Upstream writes
 *     `data-path="${escapeHtml(componentName)}"` on each component row
 *     (`:2094`) and the raw test path on each test row (`:2166`), then resolves
 *     a click through `row.dataset.path` into `aggregatedData[path]`
 *     (`:2206`, `:2354`). Here the row elements are held in a `Map` to their
 *     rows, so nothing is resolved through an attribute. The attributes are
 *     still emitted with the same values, because the stylesheet and a reader's
 *     devtools both use them.
 *
 *     Unlike the same change on `failures.html` this fixes nothing measurable:
 *     a component name is `Product :: Component` and a test path is a file
 *     path, and **0 of the 136 component names and 0 of the 4,838 test paths**
 *     on the pinned snapshot contain a quote. It is listed because a reader of
 *     the code sees a different mechanism.
 *
 *  4. **`buildTotalSummaryRow` is not ported, because nothing calls it.**
 *     `old/issues.html:1833-1875` builds a `📊 Total` row. Verified rather than
 *     assumed, as the brief asked: `grep -n "buildTotalSummaryRow" issues.html`
 *     returns **exactly one line — the definition at `:1833`** and no call
 *     site; and driving the old page in Chrome through first paint, expansion,
 *     search, every checkbox and every column header never produces an element
 *     matching `.total-row`. So the migrated page has no total row, which is
 *     what the old page shows. (Contrast `crashes.html` and `failures.html`,
 *     whose total rows *are* rendered and are ported.)
 *
 *  5. **A component's chart is drawn from its *listed* tests, and the id it
 *     carries can collide.** The daily-rate charts, the platform tooltips and
 *     the run lists are all ported; what remains is two details of how the
 *     component chart is keyed and fed.
 *
 *     `calculateComponentDailyFailureRates` is handed `group.tests`
 *     (`:2192`) — the tests the search kept **and** that have an issue
 *     (`:2016`) — so a component's chart is not its whole population: the
 *     passes of its clean tests are not in the denominator, and typing in the
 *     search box narrows the chart as well as the rows. Both are reproduced
 *     rather than corrected, because the chart sits directly above the list of
 *     exactly those tests and charting a different set would not match it.
 *
 *     The chart's DOM id is `component-chart-${name.replace(/[^a-zA-Z0-9]/g,
 *     '-')}` (`:2136`), which maps `Core :: DOM` and `Core - DOM` to one id.
 *     Reproduced, and harmless on both pages for different reasons: upstream
 *     resolves the canvas by `getElementById` and would draw two components'
 *     charts into one canvas, while this page holds the canvas element and
 *     never looks it up by id. Measured on the pinned 21-day xpcshell file:
 *     **0 collisions among the 136 component names**, so neither page is
 *     currently wrong — the id is emitted because a reader's devtools sees it.
 *
 *  6. **The per-issue-message chart counts every matching status, not just the
 *     first.** This is the one place the migrated page deliberately computes a
 *     different number from `issues.html`, and it is a bug fix.
 *
 *     `calculateIssueMessageDailyRates` resolves an issue type to a single
 *     `targetStatusId` and `break`s (`:2574-2590`), then charts only that one
 *     group. `tables.statuses` on the pinned file is ordered `PASS-PARALLEL,
 *     SKIP, PASS-SEQUENTIAL, PASS, TIMEOUT-PARALLEL, FAIL-PARALLEL,
 *     EXPECTED-FAIL, CRASH, FAIL-SEQUENTIAL, TIMEOUT, FAIL,
 *     TIMEOUT-SEQUENTIAL` — so every FAIL line charts `FAIL-PARALLEL` alone and
 *     every TIMEOUT line charts `TIMEOUT-PARALLEL` alone.
 *
 *     **Measured on the live 21-day xpcshell aggregate**: 2,792 of the 3,788
 *     tests with any failure have more than one `FAIL*` group, and 214 have
 *     more than one `TIMEOUT*` group.
 *     `toolkit/components/backgroundtasks/tests/xpcshell/test_backgroundtask_automaticrestart.js`
 *     saw `[test_backgroundtask_automatic_restart : 23] 0 == 3` 48 times under
 *     `FAIL-PARALLEL` and 3 times under `FAIL`; upstream's chart accounts for
 *     48 of the 51.
 *
 *     Upstream is not *choosing* the first status here — it contradicts itself.
 *     The count printed on the issue line sums every `FAIL*` group, and the run
 *     list the same click opens explicitly collects **all** `FAIL*` status ids
 *     (`:3168-3172`). Only the chart uses one. Reproducing it would put a bar
 *     totalling 48 under a line reading 51 above a list of 51 rows, so the
 *     chart is made to agree with its neighbours instead. See
 *     `messageDailyRates` in `site/issues-view.ts`.
 *
 *  7. **A test row's Runs cell no longer turns red at zero.**
 *     `generateStatsHtml` (`:815`) passes `'fail'` when `runCount === 0`, and
 *     the component header's equivalent (`:2121`) passes nothing. A test with
 *     zero runs and an issue is a test that was **only** skipped, and colouring
 *     its Runs cell red says "this is broken" about a number that is correctly
 *     zero. Measured on the pinned 21-day xpcshell file: **312 of the 4,256
 *     tests with an issue** have `runCount === 0`, every one of them
 *     skip-only — so this is not a rare cell. The class is dropped and the
 *     Skips cell next to it, which is populated, is what tells the reader what
 *     happened.
 *
 *  8. **A test row's path is a link to `test.html`.** Upstream renders it as a
 *     bare `<span>` (`:2168`), so the page that answers "what has this test
 *     been doing" was reachable from `try.html` and from `flaky.html` but not
 *     from here.
 *
 *     The 📋 and 🔍 buttons beside it are upstream's two, unchanged in
 *     behaviour, and the component tooltip upstream puts on the span moves onto
 *     the anchor that replaced it. All three now come from
 *     `site/test-link.ts`, which `try.html` renders too — including the
 *     `execCommand` fallback and the ✓ flash, which `site/issues.ts`,
 *     `site/test.ts` and `xpcshell-timings.html` each held a copy of. The one
 *     surviving copy colours the ✓ green, as `site/test.ts`'s and the
 *     unmigrated page's did and this page's did not.
 *
 *  9. **Three "Show as" radios, where the page had no view control.**
 *     `getCurrentView()` returned the constant `'components'`
 *     (`old/issues.html:887-890`) with a comment reading "Always use components
 *     view for issues page", so `view` was never written to the hash and never
 *     read back (`:901`). The radios, their three modes and their three labels
 *     are `xpcshell-timings.html:355-372`'s, verbatim — that page has had this
 *     control all along, and this is the same control on the page whose
 *     renderer was already the components one.
 *
 *     **The default does not move**: `components` is `checked` in the markup
 *     and `DEFAULT_VIEW`, which is what both pages already opened on.
 *
 *     **No new aggregation.** The three modes are three groupings
 *     `lib/query/issues.ts` already had for `fx-tests issues`:
 *
 *     | radio | grouping | CLI |
 *     | --- | --- | --- |
 *     | bugzilla components | `groupIssues(rows, 'component')` | `--group-by component` |
 *     | source tree | `groupIssues(rows, 'directory')` | `--group-by directory` |
 *     | list | `findIssues`, no grouping | `--group-by test` |
 *
 *     So the two grouped modes are the *same* renderer and the same two passes
 *     with a different key (`buildComponentRows`' `groupBy`), and the list is
 *     `buildTestRows`. See `site/issues-view.ts` for what `directory` is and is
 *     not: it is the flat one-row-per-leaf-directory ranking the CLI prints,
 *     **not** `xpcshell-timings.html`'s nested folder tree (`:1754-1825`).
 *
 *     `view=` goes in the **hash**, next to `date` and `q`, because that is
 *     where this page's state lives; `#view=components` is omitted, which is
 *     `xpcshell-timings.html:572`'s `if (view !== 'components')` and keeps the
 *     owner's usual `#date=21days` free of a redundant key. The
 *     components-unavailable fallback (`:3050-3061`) is ported too — see
 *     `updateViewAvailability`.
 *
 * Everything else — the row unit of the default view, the sort fields and their
 * per-column default directions, the four checkboxes changing numerator and
 * denominator rather than visibility, the search's two-level match, the
 * `(N tests with issues, out of M)` header, the issue-line ordering and its two
 * synthetic "not recorded" lines, the `?try=` short-circuit and the
 * `#date=…&q=…` state — is reproduced, and the reasoning for each lives next to
 * the code that does it in `site/issues-view.ts`.
 */

import { decodeDaily } from '../lib/formats/daily.ts';
import type { DailyFile } from '../lib/formats/daily.ts';
import { decodeIssues, decodeIssuesWithTaskIds } from '../lib/formats/issues.ts';
import type { IssuesFile, IssuesWithTaskIdsFile } from '../lib/formats/issues.ts';
import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import { parseTaskId } from '../lib/formats/tables.ts';
import {
    type ComponentRow,
    type DailyMessageRate,
    type DailyOutcomes,
    type IssueEntry,
    type IssueFilters,
    type IssueRow,
    type SortField,
    type SortState,
    type TooltipLine,
    type TooltipType,
    type ViewMode,
    ALL_FILTERS,
    DEFAULT_VIEW,
    FILTER_IDS,
    HISTORICAL_DATE,
    INITIAL_SORT,
    STAT_COLUMNS,
    TOOLTIP_HEADING,
    VIEW_MODES,
    buildComponentRows,
    buildTestRows,
    chartVisibility,
    componentDailyOutcomes,
    dayLabel,
    effectiveView,
    failureTooltip,
    groupingOf,
    hasComponentData,
    headerCounts,
    isHistoricalDate,
    issueEntries,
    matchesIssueLine,
    messageDailyRates,
    nextSort,
    percentageDisplay,
    platformBreakdown,
    readUrlState,
    sortComponents,
    sortTests,
    testDailyOutcomes,
    tooltipLines,
} from './issues-view.ts';
import {
    type SearchBoxManager,
    el,
    externalLink,
    insertAfter,
    removeFollowing,
    renderChartSlot,
    searchBox,
} from './drilldown-render.ts';
import { testRowLinkInIcon } from './test-link.ts';

// Declared here, next to the calls, rather than relied on from another
// `site/` file. `tsconfig.site.json` compiles all of `site/**` as one program,
// so a declaration in `site/test.ts` would cover these calls there and *not*
// in the root project, which pulls in only the files a test imports —
// `test/dom-harness.ts` records the same trap catching `getBugButton`.
declare global {
    /** `common-ui.js:18` — `toLocaleString()`. */
    function formatNumber(value: number): string;
    /** `common-links.js:216` — the 🐛 bug-filing button, as markup. */
    function getBugButton(url: string, title: string): string;
    /** `common-ui.js:22` — turns `[path:123]` in a failure message into a link. */
    function linkifyFailureMessage(message: string, testPath: string): string;
    /** `shared.js:70` — a job name's platform: linux, windows, mac, android. */
    function extractPlatform(jobName: string): string;
}

/**
 * The slice of Chart.js 4.4.0 this page uses.
 *
 * Read off `window` rather than declared as a global `const Chart`, which is
 * what `site/test.ts:218` already does: `tsconfig.site.json` compiles all of
 * `site/**` as one program, so a second global declaration of the same name is
 * a redeclaration error however compatible the two shapes are. Reading it off
 * the window also states the truth about where it comes from — a CDN
 * `<script>` tag, not an import — and it is what makes the tests able to
 * substitute it.
 */
interface ChartJs {
    new (canvas: HTMLCanvasElement, config: Record<string, unknown>): unknown;
    getChart(canvas: HTMLCanvasElement): { destroy(): void } | undefined;
}

/** Chart.js if the CDN tag loaded, `undefined` if it was blocked. */
function chartJs(): ChartJs | undefined {
    return (window as unknown as { Chart?: ChartJs }).Chart;
}

// --- page state -----------------------------------------------------------

/** The decoded file every number is computed from. */
let decoded: DecodedTimingFile | null = null;
/** The raw parsed file, which `getDataDateRange` indexes itself. */
let rawData: unknown = null;
let isHistoricalMode = false;
/**
 * `metadata.startTime`, Unix seconds of the window's first day.
 *
 * The charts label their bars with it and nothing else does, which is why it
 * is a field here rather than on `DecodedTimingFile` — a decoded file is
 * family-independent and the daily files have no day axis to be relative to.
 */
let startTime = 0;

// --- the detailed file ----------------------------------------------------

/**
 * Whether `{harness}-issues-with-taskids.json` has been merged in.
 *
 * `detailedData !== null` upstream (`old/issues.html:668`). Only the fact is kept:
 * the object itself is held by `decoded`, so keeping a second reference to a
 * 15.9 MB parse would double the page's peak footprint for nothing.
 */
let detailedLoaded = false;
/** `isLoadingDetailedData` (`old/issues.html:669`) — one fetch at a time. */
let loadingDetailed = false;
/**
 * Resolves when the in-flight detailed fetch settles, for the tests.
 *
 * The load is deliberately not awaited by anything the reader touches — see
 * `loadDetailedData` — so without a handle a test would have to poll. Exposed
 * through `window.__detailedLoad` rather than returned, because the caller
 * that starts it is a click handler.
 */
let detailedLoad: Promise<void> | null = null;

let filters: IssueFilters = { ...ALL_FILTERS };
let currentSort: SortState = { ...INITIAL_SORT };
/** Which group rows are open. Keyed by the row's key. `old/issues.html:662`. */
const expandedComponents = new Set<string>();

/** The group rows of the last render, for the parity seam. Empty in list mode. */
let renderedRows: ComponentRow[] = [];
/** The test rows of the last render in list mode. Empty in the grouped modes. */
let renderedTests: IssueRow[] = [];
/** The group row elements of the last render, keyed by the row's key. */
let rowsByKey = new Map<string, HTMLElement>();

let searchBoxManager: SearchBoxManager;
let hashManager: ReturnType<typeof initUrlHashManager>;
let historicalToggleManager: { toggle: () => Promise<void> };

const treeTable = (): HTMLElement => document.getElementById('tree-table')!;
const treeContainer = (): HTMLElement => document.getElementById('tree-container')!;
const noDataBox = (): HTMLElement => document.getElementById('no-data')!;
const errorBox = (): HTMLElement => document.getElementById('error')!;
const statusText = (): HTMLElement => document.getElementById('status-text')!;
const dateSelect = (): HTMLSelectElement =>
    document.getElementById('date-select') as HTMLSelectElement;
const viewRadio = (id: string): HTMLInputElement =>
    document.getElementById(id) as HTMLInputElement;

/**
 * The selected radio's mode.
 *
 * `getCurrentView` (`xpcshell-timings.html:550-561`) without its two
 * components-availability fallbacks: those need the loaded file, so they live
 * in `effectiveView` and are applied at the one place that branches on a mode.
 * A page where no radio is checked cannot happen — one is `checked` in the
 * markup and setting another unchecks it — but the default is returned rather
 * than asserted, which is upstream's final `return` too (`:560`).
 */
function selectedView(): ViewMode {
    for (const [mode, id] of VIEW_MODES) {
        if (viewRadio(id).checked) {
            return mode;
        }
    }
    return DEFAULT_VIEW;
}

/** The mode actually rendered: `selectedView`, plus the components fallback. */
function currentView(): ViewMode {
    return effectiveView(selectedView(), decoded);
}

/** Checks one radio, which unchecks the other two. `xpcshell-timings.html:3147`. */
function checkViewRadio(view: ViewMode): void {
    for (const [mode, id] of VIEW_MODES) {
        viewRadio(id).checked = mode === view;
    }
}

/**
 * Shows or hides the components radio, according to what the file supports.
 *
 * `xpcshell-timings.html:3050-3061`, verbatim in behaviour: the label is hidden
 * on a file with no component data, and a `components` selection is moved to
 * `tree` so the reader is not left on a checked radio they cannot see. Called
 * after every load rather than once, because the three families this page loads
 * are three different files and the reader switches between them.
 *
 * Measured on the checked-in fixtures, both of which carry components: the
 * label stays visible and nothing is moved. So this is the branch that exists
 * for a file the page has not been shown yet, which is why it is ported rather
 * than left out — `tables.components` and `testInfo.componentIds` are optional
 * fields in the format (`lib/formats/tables.ts:105`, `:113`).
 */
function updateViewAvailability(): void {
    const available = decoded !== null && hasComponentData(decoded);
    const label = document.getElementById('components-view-label');
    if (label !== null) {
        label.style.display = available ? '' : 'none';
    }
    if (!available && selectedView() === 'components') {
        checkViewRadio('tree');
    }
}

/** `showError` (`old/issues.html:865`). */
function showError(message: string, showNoData = false): void {
    const box = errorBox();
    box.style.display = 'block';
    box.textContent = message;
    if (showNoData) {
        noDataBox().style.display = 'block';
    }
}

/** `hideError` (`old/issues.html:875`). */
function hideError(): void {
    errorBox().style.display = 'none';
    noDataBox().style.display = 'none';
}

/** `setStatusText` (`old/issues.html:881`). */
function setStatusText(text: string): void {
    statusText().textContent = text;
}

// --- the stat cells -------------------------------------------------------

/**
 * One `<div class="stat-item">` with its label and value.
 *
 * `generateStatItem` (`old/issues.html:805-810`) in element form. The `hideable-zero`
 * container class is what fades a zero to 15% opacity until the row is hovered
 * (`:62-70`), which is how seven columns stay readable on a row where five of
 * them are zero.
 */
function statItem(
    label: string,
    value: string,
    valueClass = '',
    containerClass = ''
): HTMLElement {
    return el('div', {
        class: containerClass === '' ? 'stat-item' : `stat-item ${containerClass}`,
        children: [
            el('span', { class: 'stat-label', text: label }),
            el('span', {
                class: valueClass === '' ? 'stat-value' : `stat-value ${valueClass}`,
                text: value,
            }),
        ],
    });
}

/**
 * The seven stat cells shared by a component row and a test row.
 *
 * `generateStatsHtml` (`old/issues.html:813-840`) and the component header's own
 * copy (`:2121-2127`) unified — they emit the same seven cells in the same
 * order with the same colour rules, and the two differences are parameters:
 *
 * - A component header passes no `fail` class on a zero `runCount`; a test row
 *   does (`:815`). That difference is **dropped** — see divergence 7.
 * - **Only a test row's Skips, Failures and Timeouts cells are hoverable**
 *   (`:824-833`, where the class is on `generateStatsHtml`'s cells and not on
 *   the component header's). `test` carries the row when there is one, and the
 *   component header passes nothing.
 *
 * The Crashes cell gets a `data-tooltip-type` upstream (`:837`) and never the
 * `lazy-tooltip` class that `:2210` binds the handler to, so it has **no hover
 * on either page**. Measured in Chrome on the pinned 21-day xpcshell file, on
 * `netwerk/test/unit/test_webtransport_stop_sending.js`, whose Crashes cell
 * reads 16: the old page's cell has `data-tooltip-type="crashes"`, does *not*
 * have `lazy-tooltip`, and dispatching `mouseenter` on it adds no
 * `.dynamic-tooltip` to the document. The attribute is not emitted here,
 * because emitting it would say "this cell has a tooltip" about a cell that
 * does not.
 */
function statCells(
    stats: {
        runCount: number;
        issueCount: number;
        skipCount: number;
        failCount: number;
        timeoutCount: number;
        crashCount: number;
    },
    test?: IssueRow
): HTMLElement[] {
    const percentage = percentageDisplay(stats, filters);
    /** A cell that is hoverable when it is non-zero and belongs to a test. */
    const hoverable = (
        label: string,
        value: number,
        valueClass: string,
        type: TooltipType
    ): HTMLElement => {
        const cell = statItem(
            label,
            formatNumber(value),
            valueClass,
            value === 0 ? 'hideable-zero' : test === undefined ? '' : 'lazy-tooltip'
        );
        if (value > 0 && test !== undefined) {
            cell.dataset['testPath'] = test.fullPath;
            cell.dataset['tooltipType'] = type;
            bindTooltip(cell, test, type);
        }
        return cell;
    };

    return [
        statItem('Runs', formatNumber(stats.runCount)),
        statItem('Issue %', percentage.displayValue, percentage.cssClass),
        statItem(
            'Issues',
            formatNumber(stats.issueCount),
            stats.issueCount > 0 ? 'fail' : 'zero',
            stats.issueCount === 0 ? 'hideable-zero' : ''
        ),
        hoverable('Skips', stats.skipCount, 'skip', 'skips'),
        hoverable('Failures', stats.failCount, stats.failCount > 0 ? 'fail' : 'zero', 'failures'),
        hoverable(
            'Timeouts',
            stats.timeoutCount,
            stats.timeoutCount > 0 ? 'timeout' : 'zero',
            'timeouts'
        ),
        statItem(
            'Crashes',
            formatNumber(stats.crashCount),
            stats.crashCount > 0 ? 'fail' : 'zero',
            stats.crashCount === 0 ? 'hideable-zero' : ''
        ),
    ];
}

// --- the platform-breakdown tooltips --------------------------------------

/**
 * Attaches the hover that builds one cell's platform breakdown.
 *
 * `:2210-2213` binds `mouseenter`/`mouseleave` to every `.lazy-tooltip`, and
 * `handleTooltipMouseEnter` (`:2216-2252`) does the work on hover rather than
 * on render — which is the whole point of the name: the breakdown walks every
 * run of the test, and doing that for the 393 rows of an expanded component
 * would cost the expansion what a reader saves by never hovering most of them.
 *
 * **A tooltip with no lines is not shown at all** (`:2249`), which is the
 * behaviour that matters before the detailed file arrives: the aggregate
 * attributes no run to a task, `tooltipLines` is empty, and the cell behaves
 * like a plain one. It becomes hoverable the moment the merge lands, with no
 * re-render — the handler reads `decoded` when it fires.
 */
function bindTooltip(cell: HTMLElement, test: IssueRow, type: TooltipType): void {
    cell.addEventListener('mouseenter', () => {
        if (decoded === null) {
            return;
        }
        const lines = tooltipLines(
            platformBreakdown(decoded, test.testId, extractPlatform),
            type
        );
        if (lines.length === 0) {
            return;
        }
        showTooltip(cell, lines, type, test);
    });
    cell.addEventListener('mouseleave', hideTooltip);
}

/**
 * Puts one tooltip on the page, positioned above the cell.
 *
 * `showTooltip` (`old/issues.html:2271-2313`) — appended to `<body>` rather than to
 * the cell so it is not clipped by the row's `overflow`, positioned in page
 * coordinates, and nudged back inside the viewport on all four edges.
 */
function showTooltip(
    cell: HTMLElement,
    lines: TooltipLine[],
    type: TooltipType,
    test?: IssueRow
): void {
    hideTooltip();
    const tooltip = el('div', { class: 'dynamic-tooltip' });
    tooltip.append(el('strong', { text: TOOLTIP_HEADING[type] }), el('br'));
    for (const line of lines) {
        tooltip.append(
            el('div', {
                class: 'tooltip-platform',
                children: [
                    el('span', { class: 'tooltip-platform-name', text: `${line.platform}:` }),
                    el('span', { text: `${line.count} (${line.percentage}%)` }),
                ],
            })
        );
    }
    // The second half of a skips or failures tooltip: the messages behind the
    // count, with their own counts (`old/issues.html:1670-1702`). Built from
    // `issueEntries`, which is the same list the test's expansion renders — so
    // the tooltip and the rows under the row cannot disagree.
    if (test !== undefined && decoded !== null && type !== 'timeouts') {
        const wanted = type === 'skips' ? 'SKIP' : 'FAIL';
        const entries = issueEntries(decoded, test, ALL_FILTERS).filter(
            (entry) => entry.type === wanted
        );
        if (entries.length > 0) {
            // Styled inline, as upstream is (`:1674`, `:1679-1681`). The
            // stylesheet is held byte-identical by divergence 2, and these
            // rules exist nowhere in it — upstream writes them on the elements.
            const section = el('div');
            section.style.marginTop = '8px';
            section.style.paddingTop = '8px';
            section.style.borderTop = '1px solid #555';
            section.append(
                el('strong', { text: type === 'skips' ? 'Skip reasons:' : 'Failure messages:' }),
                el('br')
            );
            for (const entry of entries) {
                const row = el('div');
                row.style.fontSize = '11px';
                row.style.marginTop = '4px';
                row.style.color = '#ccc';
                const text = el('span', {
                    // `truncateMessage(message, 100)` (`:1695`) on the failures
                    // side; skip reasons are shown whole (`:1678`).
                    text:
                        wanted === 'FAIL' && entry.message.length > 100
                            ? `${entry.message.slice(0, 100)}...`
                            : entry.message,
                });
                text.style.fontFamily = 'monospace';
                if (wanted === 'FAIL') {
                    text.style.wordBreak = 'break-word';
                }
                const count = el('span', { text: ` (${entry.count})` });
                count.style.color = '#999';
                row.append(text, count);
                section.append(row);
            }
            tooltip.append(section);
        }
    }
    document.body.append(tooltip);

    const rect = cell.getBoundingClientRect();
    const size = tooltip.getBoundingClientRect();
    const scrollLeft = window.pageXOffset;
    const scrollTop = window.pageYOffset;
    let left = rect.left + scrollLeft + rect.width / 2 - size.width / 2;
    let top = rect.top + scrollTop - size.height - 8;
    if (left - scrollLeft < 8) {
        left = scrollLeft + 8;
    }
    if (left - scrollLeft + size.width > window.innerWidth - 8) {
        left = scrollLeft + window.innerWidth - size.width - 8;
    }
    if (top - scrollTop < 8) {
        top = rect.bottom + scrollTop + 8;
    }
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
}

/** `hideTooltip` (`old/issues.html:2260-2265`). */
function hideTooltip(): void {
    document.querySelector('.dynamic-tooltip')?.remove();
}

// --- the sort header ------------------------------------------------------

/**
 * The header row of eight sort buttons.
 *
 * `buildSortHeader` (`old/issues.html:1148-1184`). The arrow is `↑`/`↓` on the
 * active column and a **space** on every other (`:1151`) — a space rather than
 * an empty string so the label does not shift by the arrow's width when the
 * sort moves, which is why it is reproduced exactly rather than omitted.
 */
function sortHeader(): HTMLElement {
    const button = (field: SortField, label: string, leftAlign: boolean): HTMLElement => {
        const isActive = currentSort.field === field;
        const arrow = isActive ? (currentSort.direction === 'asc' ? '↑' : '↓') : ' ';
        const node = el('button', {
            class: isActive ? 'sort-button active' : 'sort-button',
            attrs: { 'data-field': field },
            children: [el('span', { class: 'sort-arrow', text: arrow }), label],
        });
        if (leftAlign) {
            node.style.justifyContent = 'flex-start';
        }
        node.addEventListener('click', () => {
            currentSort = nextSort(currentSort, field);
            render();
        });
        return node;
    };

    return el('div', {
        class: 'sort-header',
        children: [
            el('div', {
                class: 'tree-name',
                children: [button('name', 'Component / Test', true)],
            }),
            el('div', {
                class: 'tree-stats',
                children: STAT_COLUMNS.map(([field, label]) =>
                    el('div', { class: 'stat-item', children: [button(field, label, false)] })
                ),
            }),
        ],
    });
}

// --- rendering ------------------------------------------------------------

/**
 * Draws the table in whichever mode the radios are on.
 *
 * `changeView` (`xpcshell-timings.html:2941-2954`) dispatches to one of three
 * renderers; here the two grouped modes are the *same* renderer with a
 * different grouping key, because they differ only in what a row's key is —
 * `renderComponentsView` (`old/issues.html:1933`) is what both of them are.
 * Only the flat list is a second walk, and it is the one that has no group row.
 *
 * Both `renderedRows` and `renderedTests` are reset on every render, so the
 * parity seam cannot report last mode's rows alongside this mode's.
 */
function render(): void {
    if (decoded === null) {
        noDataBox().style.display = 'block';
        treeContainer().style.display = 'none';
        return;
    }
    noDataBox().style.display = 'none';
    treeContainer().style.display = 'block';

    const searchTerm = searchBoxManager.getValue().toLowerCase().trim();
    const groupBy = groupingOf(currentView());
    renderedRows = [];
    renderedTests = [];
    rowsByKey = new Map();

    const table = el('div', { class: 'tree-table' });
    table.append(sortHeader());

    if (groupBy === null) {
        renderedTests = sortTests(buildTestRows(decoded, filters, searchTerm), currentSort);
        for (const test of renderedTests) {
            table.append(testRow(test, 0));
        }
    } else {
        renderedRows = sortComponents(
            buildComponentRows(decoded, filters, searchTerm, groupBy),
            currentSort,
            filters
        );
        for (const row of renderedRows) {
            const isExpanded = expandedComponents.has(row.key);
            const hasIssues = row.tests.length > 0;
            const header = componentHeader(row, searchTerm, isExpanded, hasIssues);
            rowsByKey.set(row.key, header);
            table.append(header);

            if (isExpanded) {
                for (const element of testRows(row)) {
                    table.append(element);
                }
            }
        }
    }

    const target = treeTable();
    target.textContent = '';
    target.append(table);
}

/**
 * Re-renders after a radio changed, and writes the new mode to the hash.
 *
 * `changeView` (`xpcshell-timings.html:2941-2954`), whose first two statements
 * are exactly these. The expansion state is dropped: a component key and a
 * directory key name different rows, so carrying `expandedComponents` across a
 * mode change would leave a set of keys that match nothing — and on a switch
 * back it would re-open rows the reader closed in between.
 *
 * The sort is **kept**, unlike `site/errors.ts:onViewChange`, which resets it.
 * The eight columns are the same eight in all three modes here, so the sort a
 * reader chose still names a column that exists; errors.ts resets because its
 * three views have different column sets.
 */
function onViewChange(): void {
    expandedComponents.clear();
    updateUrlHash();
    render();
}

/**
 * One group header row — a component or a directory. `old/issues.html:2094-2130`.
 *
 * Identical in both grouped modes, including the 🧩 icon — the CSS puts it
 * there by class (`.folder-icon::before` in `site/issues.html`), so the tree
 * mode's directory rows carry it too. Left rather than given a 📁 of their own:
 * the icon marks "this row expands", which is what it means in both modes.
 */
function componentHeader(
    row: ComponentRow,
    searchTerm: string,
    isExpanded: boolean,
    hasIssues: boolean
): HTMLElement {
    const counts = headerCounts(row, searchTerm);
    // `(N tests with issues, out of M)`, `(N tests with issues)` or
    // `(M tests)` — the three cases at `:2098-2113`.
    let label: string;
    if (counts.withIssues === 0) {
        const total = counts.outOf ?? 0;
        label = ` (${total} test${total !== 1 ? 's' : ''})`;
    } else {
        const plural = counts.withIssues !== 1 ? 's' : '';
        label =
            counts.outOf === null
                ? ` (${counts.withIssues} test${plural} with issues)`
                : ` (${counts.withIssues} test${plural} with issues, out of ${counts.outOf})`;
    }

    const note = el('span', { text: label });
    note.style.color = '#888';

    const element = el('div', {
        class: hasIssues ? 'tree-row folder-row' : 'tree-row folder-row non-clickable',
        attrs: { 'data-path': row.key },
        children: [
            el('div', {
                class: 'tree-name',
                children: [
                    el('span', { class: isExpanded ? 'folder-icon expanded' : 'folder-icon' }),
                    el('strong', { text: row.key }),
                    note,
                ],
            }),
            el('div', { class: 'tree-stats', children: statCells(row.stats) }),
        ],
    });

    if (hasIssues) {
        element.addEventListener('click', () => toggleComponent(row.key));
    }
    return element;
}

/** The test rows under an expanded group row. `old/issues.html:2144-2177`. */
function testRows(row: ComponentRow): HTMLElement[] {
    return sortTests(row.tests, currentSort).map((test) => testRow(test, 1));
}

/**
 * One test row, at the given tree level. `old/issues.html:2166-2176`.
 *
 * `level` is 1 under a group row, which is upstream's `data-level="1"` and its
 * 20px indent, and 0 in the flat list, where the row *is* the top level —
 * `xpcshell-timings.html:2183` writes `data-level="0"` and emits no indent span
 * for its list rows. The indent is dropped rather than set to `0px` so the
 * markup says which of the two a row is.
 */
function testRow(test: IssueRow, level: 0 | 1): HTMLElement {
    const label: (Node | string)[] = [];
    if (level > 0) {
        const indent = el('span', { class: 'tree-indent' });
        indent.style.width = `${level * 20}px`;
        label.push(indent);
    }
    label.push(
        // The shared treatment (`site/test-link.ts`): copy, the path as a
        // `test.html` link, Searchfox. Upstream's 📋 and 🔍 are the same two
        // buttons; the link is new, and the component tooltip upstream puts on
        // the path (`old/issues.html:2168`) moves onto the anchor that
        // replaced it. The `InIcon` variant nests the 📋 in the row's 📄 span,
        // which the page's CSS cross-fades on hover — see `issues.html`.
        ...testRowLinkInIcon(test.fullPath, 'test-icon', {
            ...(test.component === null ? {} : { title: `Component: ${test.component}` }),
        })
    );

    const element = el('div', {
        class: 'tree-row test-row list-row',
        attrs: { 'data-path': test.fullPath, 'data-level': String(level) },
        children: [
            el('div', { class: 'tree-name', children: label }),
            el('div', { class: 'tree-stats', children: statCells(test, test) }),
        ],
    });
    element.addEventListener('click', () => toggleTestDetails(element, test));
    return element;
}

// --- expansion ------------------------------------------------------------

/**
 * Opens or closes a component. `toggleFolder` (`old/issues.html:2317-2339`).
 *
 * Upstream re-renders the whole table and then restores `window.scrollY`,
 * because its renderer is one `innerHTML` assignment. Here the rows are
 * elements, so an expansion inserts or removes only its own test rows and the
 * scroll position never moves — there is nothing to restore.
 *
 * Opening a component starts the detailed fetch in the background
 * (`:2330-2332`), for the reason upstream's comment gives: it buys the large
 * file the time between "a reader opened a component" and "a reader clicked a
 * failure inside it". The call is deliberately **not** awaited — the test rows
 * and the chart below go in immediately, off the file already loaded.
 */
function toggleComponent(key: string): void {
    const row = rowsByKey.get(key);
    const model = renderedRows.find((candidate) => candidate.key === key);
    if (row === undefined || model === undefined) {
        return;
    }
    if (expandedComponents.has(key)) {
        expandedComponents.delete(key);
        row.classList.remove('expanded');
        row.querySelector('.folder-icon')?.classList.remove('expanded');
        // Everything down to the next component row belongs to this one.
        removeFollowing(row, (element) => element.classList.contains('folder-row'));
        return;
    }
    expandedComponents.add(key);
    row.classList.add('expanded');
    row.querySelector('.folder-icon')?.classList.add('expanded');
    if (isHistoricalMode) {
        void loadDetailedData();
    }

    // The chart slot goes in **before** the test rows (`old/issues.html:2135-2141`
    // emits it first), and is drawn into **after** it is in the document
    // (`:2186-2197` is a second pass over the same components, for the reason
    // Chart.js needs: a detached canvas has no size to lay a chart out in).
    const chartId = isHistoricalMode && decoded !== null ? componentChartId(key) : null;
    const body: HTMLElement[] = [];
    if (chartId !== null) {
        body.push(outcomeChartSlot(chartId, '20px'));
    }
    body.push(...testRows(model));
    insertAfter(row, body);
    if (chartId !== null) {
        drawOutcomeCharts(chartId, componentDailyOutcomes(decoded!, model.tests, startTime));
    }
}

/**
 * Opens or closes one test's issue list.
 *
 * `toggleIssueDetails` (`old/issues.html:2342-2370`), including its two rules:
 * clicking an open test closes it, and opening one **closes every other**
 * (`:2349-2351`) — so at most one test is expanded at a time, unlike the
 * components, of which any number can be open.
 */
function toggleTestDetails(row: HTMLElement, test: IssueRow): void {
    const next = row.nextElementSibling;
    if (next !== null && next.classList.contains('issue-details-row')) {
        next.remove();
        return;
    }
    for (const open of document.querySelectorAll('.issue-details-row')) {
        open.remove();
    }
    if (decoded === null) {
        return;
    }
    insertAfter(row, [issueDetails(test)]);
    // After insertion, for the same reason the component chart is: Chart.js
    // measures the canvas. `old/issues.html:2361-2368` does it in the same order.
    if (isHistoricalMode) {
        drawOutcomeCharts(
            testChartId(test.testId),
            testDailyOutcomes(decoded, test.testId, startTime)
        );
    }
}

/**
 * One test's expanded issue list.
 *
 * `generateIssueDetailsHtml` (`old/issues.html:2951-3108`). The two "nothing to
 * show" messages are upstream's and are distinct on purpose: a test with no
 * issues at all reads differently from one whose issues are all of unchecked
 * types (`:3034` and `:3049`).
 *
 * The chart slot goes first, before the issue list, and **outside** the
 * `allIssues.length === 0` branch (`:2956-2962` precedes `:3033`) — so a test
 * whose issues are all filtered out still shows its 21-day history.
 */
function issueDetails(test: IssueRow): HTMLElement {
    const entries = issueEntries(decoded!, test, filters);
    const content = el('div', { class: 'issue-details-content' });

    if (isHistoricalMode) {
        content.append(outcomeChartSlot(testChartId(test.testId)));
    }

    if (entries.length === 0) {
        // Distinguishing the two needs the unfiltered list: if it is empty the
        // test has no issues, and if it is not, the filters hid them all.
        const unfiltered = issueEntries(decoded!, test, ALL_FILTERS);
        content.append(
            el('div', {
                class: 'issue-section',
                children: [
                    el('p', {
                        text:
                            unfiltered.length === 0
                                ? 'No issues found for this test.'
                                : 'No issues of the selected types found for this test.',
                    }),
                ],
            })
        );
    } else {
        const section = el('div', { class: 'issue-section' });
        for (const entry of entries) {
            section.append(issueLine(test, entry));
        }
        content.append(section);
    }

    return el('div', { class: 'issue-details-row', children: [content] });
}

/** The badge class for an issue type. `old/issues.html:3054-3056`. */
const BADGE_CLASS: Record<IssueEntry['type'], string> = {
    SKIP: 'badge-skip',
    FAIL: 'badge-fail',
    CRASH: 'badge-crash',
    TIMEOUT: 'badge-timeout',
};

/**
 * One issue line: a count, a type badge and the message.
 *
 * `old/issues.html:3070-3093`. Two details are upstream's:
 *
 * - **Only a FAIL line's count carries a tooltip** (`:3063`), and its
 *   denominator is `runCount` rather than the Issue% denominator — see
 *   `failureTooltip`.
 * - **Only a FAIL message is linkified** (`:3073`); every other type's text is
 *   inserted as text. `linkifyFailureMessage` returns a string of HTML, which
 *   is why this is the one place the renderer assigns `innerHTML` — it is
 *   `common-ui.js`'s output, and the alternative is re-implementing its
 *   `[path:line]` parsing here.
 */
function issueLine(test: IssueRow, entry: IssueEntry): HTMLElement {
    const count = el('span', { class: 'issue-count', text: String(entry.count) });
    if (entry.type === 'FAIL') {
        const tooltip = failureTooltip(entry.count, test.runCount);
        if (tooltip !== '') {
            count.title = tooltip;
        }
    }

    const message = el('span', { class: 'issue-message' });
    if (entry.type === 'FAIL') {
        message.innerHTML = linkifyFailureMessage(entry.message, test.fullPath);
    } else {
        message.textContent = entry.message;
    }

    // The 🐛 button, on FAIL lines whose test has a real component. `:3075-3091`.
    if (entry.type === 'FAIL' && test.component !== null && test.component.includes(' :: ')) {
        const { firstDate, lastDate } = getDataDateRange(rawData);
        const url = getBugzillaUrl({
            testPath: test.fullPath,
            summary: entry.message,
            component: test.component,
            stats: {
                failureCount: entry.count,
                totalRuns: test.runCount,
                firstDate,
                lastDate,
            },
        });
        // `getBugButton` returns markup, like `linkifyFailureMessage`.
        const holder = el('span');
        holder.innerHTML = getBugButton(url, 'File bug for this failure');
        const button = holder.firstElementChild;
        if (button !== null) {
            button.addEventListener('click', (event) => event.stopPropagation());
            message.append(button);
        }
    }

    const line = el('div', {
        class: 'issue-item',
        attrs: {
            'data-test-path': test.fullPath,
            'data-test-id': String(test.testId),
            'data-issue-type': entry.type,
            'data-issue-message': entry.message,
        },
        children: [
            count,
            el('span', { class: `issue-badge ${BADGE_CLASS[entry.type]}`, text: entry.type }),
            message,
        ],
    });

    // The per-message chart slot and the run table, both hidden until the line
    // is clicked. `old/issues.html:3131-3141` toggles the two together.
    const chartId = isHistoricalMode ? messageChartId(test.testId, entry) : null;
    const chart = chartId === null ? null : renderChartSlot(`${chartId}-canvas`);
    if (chart !== null) {
        chart.style.display = 'none';
        chart.style.marginLeft = '50px';
    }

    const runs = el('div', { class: 'issue-runs' });
    runs.style.display = 'none';

    line.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleIssueRuns(runs, chart, test, entry);
    });

    const wrapper = el('div');
    wrapper.append(line);
    if (chart !== null) {
        wrapper.append(chart);
    }
    wrapper.append(runs);
    return wrapper;
}

/**
 * Opens or closes the per-run table and the per-message chart under one issue
 * line.
 *
 * `toggleIssueRuns` (`old/issues.html:3111-3145`). Collapsing hides both without
 * clearing them, and expanding rebuilds the run table each time — which matters
 * now that the detailed file can arrive between two clicks: the second click
 * shows the runs the first could not.
 */
function toggleIssueRuns(
    runs: HTMLElement,
    chart: HTMLElement | null,
    test: IssueRow,
    entry: IssueEntry
): void {
    if (runs.style.display !== 'none') {
        runs.style.display = 'none';
        if (chart !== null) {
            chart.style.display = 'none';
        }
        return;
    }
    runs.textContent = '';
    const rows = runRows(test, entry);
    if (rows.length === 0) {
        // Upstream has two texts here and they say different things: no status
        // group at all for the test (`:3150`), against a group that held no
        // entry matching this line (`:3229`). This page cannot reach the first
        // — a line only exists because `issueEntries` found runs behind it —
        // so the second is what an unattributed file produces, and it is the
        // one shown. It is reachable exactly while the detailed file has not
        // been merged; after the merge every line has rows.
        runs.append(el('span', { text: 'No matching runs found' }));
    } else {
        const table = el('table');
        for (const row of rows) {
            table.append(row);
        }
        runs.append(table);
    }
    runs.style.display = 'block';

    if (chart !== null && decoded !== null) {
        chart.style.display = 'block';
        const chartId = messageChartId(test.testId, entry);
        drawMessageChart(
            `${chartId}-canvas`,
            messageDailyRates(decoded, test.testId, entry.type, entry.message, startTime),
            entry.type
        );
    }
}

/**
 * The per-run rows for one issue line.
 *
 * `getIssueRuns` (`old/issues.html:3148-3261`). Upstream branches on the issue type
 * to pick the status groups to walk and then reads `taskIdIds` out of each;
 * `runsOfTest` has resolved the shape already, so the branch is `matchesEntry`
 * and the rest is one loop.
 *
 * **Which runs have rows.** A row needs a task ID. `{harness}-issues.json` is
 * the `counts` shape throughout and carries none, so before the detailed file
 * is merged this returns nothing and the caller says so; after the merge the
 * non-passing groups are the `task-ids` shape and every issue line has rows.
 * The daily files are the `flat` shape and have always had them.
 *
 * Upstream's row is `date | job name (linked) - duration | View: …`. The
 * duration is **not** emitted here and that is a property of the data, not a
 * choice: `run.duration` is `null` at every one of upstream's five
 * `createRunInfo` call sites (`:3164`, `:3184`, `:3202`, `:3216` — the
 * parameter defaults to `null` and none passes it), so upstream's
 * `showDuration` is false on every row of this page. Measured on the pinned
 * aggregate: the `task-ids` shape carries no `durations` array at all.
 */
function runRows(test: IssueRow, entry: IssueEntry): HTMLElement[] {
    if (decoded === null) {
        return [];
    }
    interface Run {
        date: string | null;
        jobName: string;
        profileUrl: string;
        crashUrl: string | null;
        jobUrl: string | null;
    }
    const runs: Run[] = [];

    for (const run of decoded.runsOfTest(test.testId)) {
        if (!matchesIssueLine(run, entry.type, entry.message)) {
            continue;
        }
        const taskIds = run.taskIds;
        if (taskIds === undefined) {
            continue;
        }
        for (let index = 0; index < taskIds.length; index++) {
            const raw = taskIds[index];
            if (raw === undefined) {
                continue;
            }
            const { taskId, retryId } = parseTaskId(raw);
            const taskIdIndex = run.taskIdIndexes?.[index];
            const jobName =
                taskIdIndex === undefined ? '' : (decoded.jobNameOfTaskIndex(taskIdIndex) ?? '');
            // The crash viewer, for a crash whose dump was uploaded
            // (`:3208-3211`). `minidumps` is parallel to the bucket's task IDs.
            const minidump = run.minidumps?.[index] ?? null;
            runs.push({
                // A daily file's entries have no day (`day === null`), which is
                // upstream's `dayIndex != null ? … : null` (`:3268`).
                date: run.day === null ? null : dayLabel(startTime, run.day),
                jobName,
                profileUrl: getProfilerUrl(
                    { taskId, retryId: String(retryId), jobName },
                    test.fullPath
                ),
                // `getCrashViewerUrl` returns `''` with no minidump
                // (`common-links.js:32`), which is upstream's own guard at
                // `:3208` written a second way; `|| null` keeps the two cases
                // one value here.
                crashUrl:
                    entry.type === 'CRASH'
                        ? getCrashViewerUrl({ taskId, retryId: String(retryId), minidump }) ||
                          null
                        : null,
                jobUrl: getTreeherderJobUrl({ taskId, retryId: String(retryId) }, rawData),
            });
        }
    }

    // `prepareRunsForDisplay` (`common-ui.js:488`): newest day first, and the
    // date printed only on the first row of a day. That function builds a
    // `<td>` as a *string*, which this renderer has no use for, so the two
    // rules are applied here — the sort is its `localeCompare` on `date ?? ''`
    // and the blanking its `run.date !== lastDate`, both verbatim, and
    // `test/issues-page.test.ts` asserts the resulting cells against it.
    runs.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

    let lastDate: string | null = null;
    return runs.map((run) => {
        const showDate = run.date !== null && run.date !== lastDate;
        lastDate = run.date;
        const dateCell = el('td', { class: 'run-date', text: showDate ? run.date! : '' });

        // The job name links to the crash viewer for a crash and to the
        // profiler otherwise (`:3236-3237`).
        const mainUrl = run.crashUrl ?? run.profileUrl;
        const nameCell = el('td', {
            class: 'run-job-name',
            children: [externalLink(mainUrl, run.jobName)],
        });

        const links = el('td', { class: 'view-links' });
        links.append('View: ', externalLink(run.profileUrl, 'Profile'));
        if (run.crashUrl !== null) {
            links.append(' ', externalLink(run.crashUrl, 'Crash'));
        }
        if (run.jobUrl !== null) {
            links.append(' ', externalLink(run.jobUrl, 'Job'));
        }

        return el('tr', { children: [dateCell, nameCell, links] });
    });
}

// --- the charts -----------------------------------------------------------

/**
 * The DOM id of a component's chart pair. `old/issues.html:2136`.
 *
 * Ids are still built and still collide the same way upstream's do: two
 * components differing only in punctuation map to the same id, because every
 * non-alphanumeric character becomes `-`. Nothing here resolves a chart
 * *through* its id — the canvas elements are held directly — so the id is
 * cosmetic, and it is reproduced so a reader's devtools sees what the old page
 * shows.
 */
function componentChartId(component: string): string {
    return `component-chart-${component.replace(/[^a-zA-Z0-9]/g, '-')}`;
}

/** The DOM id of a test's chart pair. `old/issues.html:2364`, `:2957`. */
function testChartId(testId: number): string {
    return `test-chart-${testId}`;
}

/**
 * The DOM id of one issue line's chart. `old/issues.html:3057`.
 *
 * Upstream keys it on the test *path* and the line's index within the rendered
 * list (`issue-${path…}-${index}`), which changes when a checkbox reorders the
 * list. This uses the test id and the line's identity, which does not — the id
 * is not resolved through anyway, for the reason `componentChartId` gives.
 */
function messageChartId(testId: number, entry: IssueEntry): string {
    return `issue-${testId}-${entry.type}-${entry.message.replace(/[^a-zA-Z0-9]/g, '-')}`;
}

/**
 * The two-canvas slot a component or test chart draws into.
 *
 * `old/issues.html:2137-2140` and `:2958-2961` — one `.historical-chart` holding
 * `{id}-canvas` and `{id}-skips-canvas`. `renderChartSlot` builds the one-canvas
 * version the crashes page uses, so the second canvas is appended to it rather
 * than the whole thing being rebuilt.
 */
function outcomeChartSlot(chartId: string, marginLeft?: string): HTMLElement {
    const slot = renderChartSlot(`${chartId}-canvas`);
    slot.append(
        el('canvas', { id: `${chartId}-skips-canvas`, class: 'historical-chart-canvas' })
    );
    if (marginLeft !== undefined) {
        slot.style.marginLeft = marginLeft;
    }
    return slot;
}

/**
 * Draws a component's or a test's two charts.
 *
 * `createFailureRateChart` (`old/issues.html:2813-2941`). The stacked
 * failure/timeout/crash chart and the skips chart are independent: each canvas
 * is shown only if the window holds something for it (`:2827-2828`), and the
 * skips canvas loses its x-axis when the other one above it already has one
 * (`:2909-2914`, the `no-x-axis` class).
 *
 * **The percentages have two different denominators, and that is upstream's**
 * (`:2818-2825`): a failure/timeout/crash rate is over the runs that executed,
 * a skip rate is over the runs that were *scheduled* — executed plus skipped.
 * A skipped run could not have failed, so putting it in the failure
 * denominator would depress the rate by however many platforms disabled the
 * test.
 */
function drawOutcomeCharts(chartId: string, series: DailyOutcomes[]): void {
    const canvas = document.getElementById(`${chartId}-canvas`) as HTMLCanvasElement | null;
    const skipCanvas = document.getElementById(
        `${chartId}-skips-canvas`
    ) as HTMLCanvasElement | null;
    if (canvas === null) {
        return;
    }
    const visible = chartVisibility(series);
    const labels = series.map((day) => day.date);
    const executed = series.map(
        (day) => day.passes + day.failures + day.timeouts + day.crashes
    );
    const rate = (count: number, total: number): number => (total > 0 ? (count / total) * 100 : 0);

    if (visible.issues) {
        canvas.style.display = 'block';
        drawChart(canvas, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Failure %',
                        data: series.map((day, i) => rate(day.failures, executed[i]!)),
                        backgroundColor: 'rgba(255, 140, 0, 0.7)',
                        borderColor: '#ff8c00',
                        borderWidth: 1,
                    },
                    {
                        label: 'Timeout %',
                        data: series.map((day, i) => rate(day.timeouts, executed[i]!)),
                        backgroundColor: 'rgba(255, 193, 7, 0.7)',
                        borderColor: '#ffc107',
                        borderWidth: 1,
                    },
                    {
                        label: 'Crash %',
                        data: series.map((day, i) => rate(day.crashes, executed[i]!)),
                        backgroundColor: 'rgba(220, 53, 69, 0.7)',
                        borderColor: '#dc3545',
                        borderWidth: 1,
                    },
                ],
            },
            options: chartOptions('% failures', {
                stacked: true,
                label: (context: ChartTooltipContext): string | null => {
                    const day = series[context.dataIndex];
                    if (day === undefined) {
                        return null;
                    }
                    const counts: Record<string, [number, string, string]> = {
                        'Failure %': [day.failures, 'failure', 'failures'],
                        'Timeout %': [day.timeouts, 'timeout', 'timeouts'],
                        'Crash %': [day.crashes, 'crash', 'crashes'],
                    };
                    const found = counts[context.dataset.label];
                    if (found === undefined || found[0] === 0) {
                        // Upstream returns null for a zero so the tooltip does
                        // not list two series that did not happen (`:2884`).
                        return null;
                    }
                    const [count, singular, plural] = found;
                    const total = executed[context.dataIndex] ?? 0;
                    return `${formatNumber(count)} ${count === 1 ? singular : plural} out of ${formatNumber(total)} runs (${context.parsed.y.toFixed(1)}%)`;
                },
                footer: (items: ChartTooltipContext[]): string => {
                    const day = series[items[0]?.dataIndex ?? 0];
                    return `Passes: ${formatNumber(day?.passes ?? 0)}`;
                },
            }),
        });
    } else {
        canvas.style.display = 'none';
    }

    if (skipCanvas === null) {
        return;
    }
    if (!visible.skips) {
        skipCanvas.style.display = 'none';
        return;
    }
    skipCanvas.style.display = 'block';
    skipCanvas.classList.toggle('no-x-axis', visible.issues);
    const scheduled = series.map((day, i) => executed[i]! + day.skips);
    drawChart(skipCanvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Skip %',
                    data: series.map((day, i) => rate(day.skips, scheduled[i]!)),
                    backgroundColor: 'rgba(108, 117, 125, 0.7)',
                    borderColor: '#6c757d',
                    borderWidth: 1,
                },
            ],
        },
        options: chartOptions('% skips', {
            hideXAxis: visible.issues,
            label: (context: ChartTooltipContext): string | null => {
                const day = series[context.dataIndex];
                if (day === undefined || day.skips === 0) {
                    return null;
                }
                const total = scheduled[context.dataIndex] ?? 0;
                const word = day.skips === 1 ? 'skip' : 'skips';
                return `${formatNumber(day.skips)} ${word} out of ${formatNumber(total)} scheduled runs (${context.parsed.y.toFixed(1)}%)`;
            },
        }),
    });
}

/** The colours and the y-axis label for one issue type. `old/issues.html:2750-2771`. */
const MESSAGE_CHART_STYLE: Record<IssueEntry['type'], [string, string, string]> = {
    SKIP: ['rgba(108, 117, 125, 0.7)', '#6c757d', '% skips'],
    FAIL: ['rgba(255, 140, 0, 0.7)', '#ff8c00', '% failures'],
    TIMEOUT: ['rgba(255, 193, 7, 0.7)', '#ffc107', '% timeouts'],
    CRASH: ['rgba(220, 53, 69, 0.7)', '#dc3545', '% crashes'],
};

/** The plural noun one issue type's tooltip uses. `old/issues.html:2789-2801`. */
const MESSAGE_CHART_NOUN: Record<IssueEntry['type'], [string, string]> = {
    SKIP: ['skip', 'skips'],
    FAIL: ['failure', 'failures'],
    TIMEOUT: ['timeout', 'timeouts'],
    CRASH: ['crash', 'crashes'],
};

/** Draws one issue line's chart. `createIssueMessageChart` (`old/issues.html:2743`). */
function drawMessageChart(
    canvasId: string,
    series: DailyMessageRate[],
    type: IssueEntry['type']
): void {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (canvas === null) {
        return;
    }
    const [background, border, axisLabel] = MESSAGE_CHART_STYLE[type];
    const [singular, plural] = MESSAGE_CHART_NOUN[type];
    drawChart(canvas, {
        type: 'bar',
        data: {
            labels: series.map((day) => day.date),
            datasets: [
                {
                    label: 'Occurrence Rate',
                    data: series.map((day) =>
                        day.totalRuns > 0 ? (day.count / day.totalRuns) * 100 : 0
                    ),
                    backgroundColor: background,
                    borderColor: border,
                    borderWidth: 1,
                },
            ],
        },
        options: chartOptions(axisLabel, {
            label: (context: ChartTooltipContext): string | null => {
                const day = series[context.dataIndex];
                if (day === undefined || day.count === 0) {
                    return null;
                }
                const word = day.count === 1 ? singular : plural;
                return `${formatNumber(day.count)} ${word} out of ${formatNumber(day.totalRuns)} runs (${context.parsed.y.toFixed(1)}%)`;
            },
        }),
    });
}

/** What a Chart.js tooltip callback is handed. Only the fields read here. */
interface ChartTooltipContext {
    dataIndex: number;
    dataset: { label: string };
    parsed: { y: number };
}

/**
 * The chart options every chart on this page shares.
 *
 * `getCommonChartOptions` (`old/issues.html:2700-2740`), including
 * `animation: false` on both the chart and the tooltip — the old page turns
 * animation off so a chart appearing under an expanded row does not shift the
 * rows below it while it grows.
 */
function chartOptions(
    yAxisLabel: string,
    callbacks: {
        label: (context: ChartTooltipContext) => string | null;
        footer?: (items: ChartTooltipContext[]) => string;
        stacked?: boolean;
        hideXAxis?: boolean;
    }
): Record<string, unknown> {
    const x: Record<string, unknown> = {};
    if (callbacks.stacked === true) {
        x['stacked'] = true;
    }
    if (callbacks.hideXAxis === true) {
        x['display'] = false;
    }
    const tooltipCallbacks: Record<string, unknown> = { label: callbacks.label };
    if (callbacks.footer !== undefined) {
        tooltipCallbacks['footer'] = callbacks.footer;
    }
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            title: { display: false },
            legend: { display: false },
            tooltip: { animation: false, callbacks: tooltipCallbacks },
        },
        scales: {
            x,
            y: {
                beginAtZero: true,
                stacked: callbacks.stacked === true,
                title: { display: true, text: yAxisLabel },
                ticks: { callback: (value: number): string => `${value}%` },
            },
        },
    };
}

/**
 * Hands one chart configuration to Chart.js.
 *
 * The single point where this page touches Chart.js, and it exists for a
 * problem upstream has and does not solve: `new Chart(canvas, …)` throws
 * `Canvas is already in use. Chart with ID '0' must be destroyed` when a chart
 * is still attached to that canvas. Upstream reaches it by re-expanding a
 * component — its renderer rebuilds the whole table by `innerHTML`, which
 * *detaches* the old canvas without destroying its chart, and Chart.js keeps
 * the registry entry alive. Here the canvas element is genuinely reused, so
 * `Chart.getChart` is asked for the survivor and it is destroyed first.
 *
 * `Chart` is the global the CDN `<script>` defines. It is the seam the tests
 * substitute — jsdom has no 2D canvas context, so no real chart can be
 * constructed there and the assertion has to be on *what was handed to it*,
 * which is the part this page is responsible for.
 */
function drawChart(canvas: HTMLCanvasElement, config: Record<string, unknown>): void {
    const chart = chartJs();
    if (chart === undefined) {
        // Chart.js is loaded by a CDN `<script>` with no `defer`, so it is
        // there before any of this runs. Missing means the CDN is blocked, and
        // the page is more useful without a chart than blank.
        return;
    }
    chart.getChart(canvas)?.destroy();
    new chart(canvas, config);
}

// --- the issue-type checkboxes -------------------------------------------

/**
 * Re-reads the four checkboxes and re-renders.
 *
 * `updateIssueFilters` (`old/issues.html:3455-3472`). Upstream also deletes every
 * cached `stats` object (`:3462-3466`) because it memoizes them onto
 * `aggregatedData`; here `buildComponentRows` recomputes from the decoded file
 * each time, so there is no cache to invalidate — which is what makes it
 * impossible for a stale number to survive a filter change.
 */
function updateIssueFilters(): void {
    for (const [key, id] of FILTER_IDS) {
        const box = document.getElementById(id) as HTMLInputElement | null;
        if (box !== null) {
            filters[key] = box.checked;
        }
    }
    if (decoded !== null) {
        render();
    }
}

// --- data loading ---------------------------------------------------------

/** `loadData` (`old/issues.html:3475-3513`). */
async function loadSelectedDate(): Promise<void> {
    setStatusText('Loading data...');
    hideError();
    try {
        const date = dateSelect().value;
        if (!date) {
            throw new Error('No date selected');
        }
        const harness = getHarnessType();
        const response = await fetchData(`${harness}-${date}.json`);
        if (!response.ok) {
            throw new Error('No data available');
        }
        const file = (await response.json()) as DailyFile;
        rawData = file;
        decoded = decodeDaily(file);
        startTime = file.metadata.startTime;
        expandedComponents.clear();
        updateViewAvailability();
        render();
        const jobCount = file.metadata.jobCount ?? 0;
        setStatusText(`${jobCount.toLocaleString()} test jobs`);
    } catch (error) {
        showError(`Error loading data: ${error instanceof Error ? error.message : String(error)}`, true);
    }
}

/**
 * Fetches `{harness}-issues-with-taskids.json` and merges it in.
 *
 * `loadDetailedData` (`old/issues.html:3403-3452`), and the reason this page has it
 * at all: the 21-day aggregate the page opens on carries **no task
 * attribution** — `{harness}-issues.json` is the `counts` shape throughout —
 * so without this file a failure message has no runs to list and the
 * per-message chart has nothing to bucket. The detailed file is the same 21
 * days with `taskIdIds` on the non-passing groups.
 *
 * ## The four properties this reproduces
 *
 * **Historical mode only** (`:3405`). The daily files already carry task IDs.
 *
 * **At most one fetch** (`:3408`), guarded by `loadingDetailed` and
 * `detailedLoaded` — 15.9 MB is not a request to make twice, and expanding a
 * second component while the first fetch is in flight is the ordinary case.
 *
 * **A failure is a warning, not an error** (`:3417`, `:3449`). The page keeps
 * working on the counts-only file, which is what it was already showing.
 *
 * **Nothing waits for it.** The caller does not await; the reader's expansion
 * has already rendered.
 *
 * ## What the merge replaces, and what it cannot
 *
 * Upstream swaps four tables and `taskInfo` into the *live* `currentData`
 * object (`:3428-3444`) — and since `currentData === historicalData` (`:3561`),
 * the charts see the swap too. Two things follow that this page has to match:
 *
 * - **The displayed numbers must not move.** They do not, and that is measured
 *   rather than assumed: on the live 21-day xpcshell pair, all 58,056 status
 *   groups across 4,838 tests have identical run totals in the two files, and
 *   the `testInfo`, `statuses` and `messages` tables are byte-identical. The
 *   fixtures were checked the same way — `test/issues-page.test.ts` asserts the
 *   rendered rows are unchanged across the merge, which is what would catch a
 *   file that had drifted.
 * - **A partial merge must not be reachable.** Upstream's is: it assigns
 *   `testRuns` and `taskInfo` unconditionally and each table only
 *   `if (detailedData.tables.X)`, so a file with `taskIdIds` and no
 *   `tables.taskIds` leaves the page resolving task indices against the *old*
 *   table — silently wrong job names rather than an error. Here the file is
 *   decoded into a new `DecodedTimingFile` and swapped in with one assignment,
 *   so the page holds either the old file or the new one and never a mixture.
 *   `decodeIssuesWithTaskIds` is what fails loudly if the tables are missing.
 *
 * The re-render at the end is upstream's *absence*: upstream does not re-render
 * either (`:3446` just logs), because the numbers are the same and the reader
 * is looking at the page. What has changed is only what a *later* click finds.
 */
async function loadDetailedData(): Promise<void> {
    if (!isHistoricalMode || loadingDetailed || detailedLoaded) {
        return;
    }
    loadingDetailed = true;
    const load = (async (): Promise<void> => {
        try {
            const harness = getHarnessType();
            const response = await fetchData(`${harness}-issues-with-taskids.json`);
            if (!response.ok) {
                console.warn('Detailed data not available');
                return;
            }
            const file = (await response.json()) as IssuesWithTaskIdsFile;
            // Between the fetch starting and it landing the reader may have
            // left the 21-day view, in which case `decoded` is a daily file and
            // overwriting it would replace what they are looking at.
            if (!isHistoricalMode) {
                return;
            }
            rawData = file;
            decoded = decodeIssuesWithTaskIds(file);
            startTime = file.metadata.startTime;
            detailedLoaded = true;
        } catch (error) {
            console.warn('Error loading detailed data:', error);
        } finally {
            loadingDetailed = false;
        }
    })();
    detailedLoad = load;
    await load;
}

/**
 * Enters or leaves the 21-day view.
 *
 * The button, the date selector's disabled state and the status text are
 * `common-ui.js`'s `initHistoricalToggle`; this is the data half of the
 * callback. `old/issues.html:3516-3598`.
 *
 * Note which file this is: `{harness}-issues.json`, the counts-only aggregate
 * (`:3555`) — a **different file with a different shape** from the daily
 * `{harness}-<date>.json`, and different again from the `-with-taskids`
 * variant `crashes.html` loads. `lib/formats/issues.ts` and
 * `lib/formats/daily.ts` decode them into the same interface, which is what
 * lets everything above this line be shape-independent.
 *
 * The detailed file is **not** fetched here. Upstream clears it on both edges
 * of the toggle (`:3535-3536`, `:3551-3552`) and fetches it only when a
 * component is opened; both are reproduced, so entering the 21-day view costs
 * one 2.8 MB request and not 18.7 MB.
 */
async function onHistoricalToggled(isHistorical: boolean, data: unknown): Promise<void> {
    isHistoricalMode = isHistorical;
    // Both edges: whatever was merged describes the window being left.
    detailedLoaded = false;
    loadingDetailed = false;
    if (isHistorical) {
        rawData = data;
        decoded = decodeIssues(data as IssuesFile);
        startTime = (data as IssuesFile).metadata.startTime;
        expandedComponents.clear();
        hideError();
        updateViewAvailability();
        render();
        const metadata = (data as IssuesFile).metadata;
        const days = metadata.days ?? 21;
        setStatusText(`${days} days (${metadata.startDate} to ${metadata.endDate})`);
    } else {
        await loadSelectedDate();
    }
    hashManager?.updateHash();
}

/**
 * `?try=<rev>`, which short-circuits everything else.
 *
 * `loadTryRevision` (`old/issues.html:3359-3400`), reached from the startup branch
 * at `:3699-3701` before the date selector is even populated. The file is a
 * daily-shaped one, so it decodes the same way.
 */
async function loadTryRevision(revision: string): Promise<void> {
    setStatusText('Loading try revision...');
    hideError();
    try {
        const harness = getHarnessType();
        const response = await fetchData(`${harness}-try-${revision}.json`);
        if (!response.ok) {
            throw new Error(
                `Try revision data not found. Run: node fetch-test-data.js --harness ${harness} --try ${revision}`
            );
        }
        const file = (await response.json()) as DailyFile;
        rawData = file;
        decoded = decodeDaily(file);
        startTime = file.metadata.startTime;
        dateSelect().value = '';
        const jobCount = file.metadata.jobCount ?? 0;
        setStatusText(`Try: ${revision.substring(0, 12)} (${jobCount.toLocaleString()} jobs)`);
        const url = new URL(window.location.href);
        url.searchParams.set('try', revision);
        window.history.replaceState({}, '', url);
        updateViewAvailability();
        render();
    } catch (error) {
        showError(error instanceof Error ? error.message : String(error));
        setStatusText('');
    }
}

// --- URL state ------------------------------------------------------------

function updateUrlHash(): void {
    hashManager?.updateHash();
}

/**
 * Applies the hash to the page. `loadFromUrlHash` (`old/issues.html:3747-3777`).
 *
 * The one behavioural change is here: `isHistoricalDate` treats an **absent**
 * `date` as the 21-day view, where upstream treats it as "use the date select".
 * See divergence 1.
 *
 * The `q` handling is upstream's, including that a hash with no `q` **clears**
 * the box (`:3774`, `search || ''`) — unlike `crashes.html`, which only writes
 * a truthy value and leaves a stale term behind. This page is the one that gets
 * it right, so there is nothing to reproduce-as-a-bug here.
 *
 * The `view` handling is `xpcshell-timings.html:3146-3147`: an absent `view`
 * means `components`, and the radio is checked by value. Written on **every**
 * hash load rather than only when the parameter is present, for the reason the
 * four checkboxes above are: a reader who navigates from `#view=list` back to a
 * hash with no `view` must land on the default and not stay where they were.
 */
async function loadFromUrlHash(): Promise<void> {
    if (hashManager === undefined) {
        return;
    }
    const state = readUrlState(hashManager.getParams());
    const box = document.getElementById('search-box');
    if (document.activeElement !== box) {
        searchBoxManager.setValue(state.q ?? '');
    }

    checkViewRadio(state.view ?? DEFAULT_VIEW);

    if (isHistoricalDate(state.date)) {
        if (!isHistoricalMode) {
            await historicalToggleManager.toggle();
        }
        return;
    }
    if (isHistoricalMode) {
        await historicalToggleManager.toggle();
    }
    if (state.date !== undefined && dateSelect().value !== state.date) {
        dateSelect().value = state.date;
    }
}

// --- startup --------------------------------------------------------------

function initializeUI(): void {
    initHarnessSwitcher('Issues');

    // `:3686-3689` — re-read rather than trusted, because a browser restores
    // checkbox state across a reload and the JS mirror at `:672-677` would
    // otherwise disagree with what the reader can see.
    updateIssueFilters();
    for (const [, id] of FILTER_IDS) {
        document.getElementById(id)?.addEventListener('change', updateIssueFilters);
    }

    searchBoxManager = searchBox({
        searchBoxId: 'search-box',
        searchClearId: 'search-clear',
        onSearch: render,
        updateUrlHash,
    });

    hashManager = initUrlHashManager({
        getState: () => ({
            date: isHistoricalMode ? HISTORICAL_DATE : dateSelect().value,
            q: searchBoxManager.getValue().trim(),
            // `''` for the default, not `'components'`: `initUrlHashManager`
            // writes only truthy values (`common-ui.js:306`), so an empty
            // string keeps `view` out of the hash exactly as
            // `xpcshell-timings.html:572` does with its
            // `if (view !== 'components')`. The owner's usual
            // `#date=21days` therefore stays that and does not grow a
            // `&view=components`.
            //
            // `selectedView()` and not `currentView()`: what the reader picked
            // is what the URL should say, so a file with no components does not
            // silently rewrite their `components` selection to `tree` — the
            // same hash then works as they meant it on a file that has them.
            view: selectedView() === DEFAULT_VIEW ? '' : selectedView(),
        }),
        onHashChange: async () => {
            searchBoxManager.setNavigating(true);
            const wasHistorical = isHistoricalMode;
            const previousDate = dateSelect().value;
            await loadFromUrlHash();
            if (!isHistoricalMode) {
                if (dateSelect().value !== previousDate || wasHistorical !== isHistoricalMode) {
                    await loadSelectedDate();
                } else {
                    render();
                }
            } else if (wasHistorical) {
                // Already in the 21-day view and staying: nothing reloaded, so
                // nothing has re-rendered. `loadFromUrlHash` has just applied
                // this hash's `q` and `view` to the controls, and without this
                // the table would still be showing the previous ones — which is
                // what the back button produces. Not needed on the branch
                // above, where `loadSelectedDate` or `render` runs; and not
                // needed when `wasHistorical` is false, because
                // `historicalToggleManager.toggle()` has re-rendered as part of
                // entering the view.
                render();
            }
            searchBoxManager.setNavigating(false);
        },
    });

    const harness = getHarnessType();
    historicalToggleManager = initHistoricalToggle({
        buttonId: 'historical-button',
        selectId: 'date-select',
        statusTextId: 'status-text',
        fetchData,
        historicalDataFile: `${harness}-issues.json`,
        onToggle: onHistoricalToggled,
        updateUrlHash,
    });

    dateSelect().addEventListener('change', () => {
        updateUrlHash();
        void loadSelectedDate();
    });

    // The radios carry **no** `onchange=` attribute, unlike the six controls
    // divergence 2 lists: that markup is upstream's and held as it is, while
    // this control is new here, so copying `xpcshell-timings.html:358`'s
    // `onchange="changeView()"` would be writing a `ReferenceError` on purpose.
    for (const [, id] of VIEW_MODES) {
        viewRadio(id).addEventListener('change', onViewChange);
    }
}

/**
 * Wires the page up and loads it. Called by the page, not by importing it.
 *
 * Exporting the entry point rather than running at module scope is what lets
 * `test/issues-page.test.ts` exist: importing this file declares things and
 * fetches nothing. `site/crashes-main.ts` records why that mattered — three
 * files and 2,598 lines of an earlier migration had no test importing them
 * because importing a controller started the page.
 */
export async function start(): Promise<void> {
    initializeUI();

    const revision = new URLSearchParams(window.location.search).get('try');
    if (revision !== null && revision !== '') {
        await loadTryRevision(revision);
        return;
    }

    const hasData = await populateDateSelector({
        selectId: 'date-select',
        statusTextId: 'status-text',
        fetchData,
    });
    if (!hasData) {
        showError('No data available. Please run: node fetch-xpcshell-data.js', true);
        return;
    }

    const select = dateSelect();
    if (!select.value && select.options.length > 0) {
        select.selectedIndex = 0;
    }

    // The 21-day default. `loadFromUrlHash` toggles into historical mode when
    // the hash names no date, which is divergence 1.
    await loadFromUrlHash();
    if (!isHistoricalMode) {
        await loadSelectedDate();
    }
    updateUrlHash();
}

/**
 * The view model, for the browser parity harness.
 *
 * `PARITY.md` §2: a page that builds strings has no seam to compare against.
 * This is the seam — the ranked rows and their numbers as plain values, so the
 * old-vs-new comparison can assert on decisions rather than on pixels.
 */
declare global {
    interface Window {
        __view?: () => unknown;
        /**
         * The in-flight detailed fetch, or `null`.
         *
         * The load is started by a click handler and awaited by nobody, which
         * is the behaviour under test — so a test that needs to observe the
         * page *after* the merge has no other handle on it. Exposed as the
         * promise rather than as a "is it done" flag so a test cannot pass by
         * checking a flag that was never set.
         */
        __detailedLoad?: () => Promise<void> | null;
    }
}
window.__detailedLoad = () => detailedLoad;
window.__view = () => ({
    sort: currentSort,
    historical: isHistoricalMode,
    detailedLoaded,
    filters: { ...filters },
    search: searchBoxManager?.getValue() ?? '',
    expanded: [...expandedComponents],
    // The mode the table was drawn in, which is `currentView()` and not
    // `selectedView()`: a comparison of what is on screen has to see the
    // components-to-tree fallback if it fired, or the rows below would look
    // like the wrong grouping's.
    view: currentView(),
    rows: renderedRows.map((row) => ({
        key: row.key,
        runCount: row.stats.runCount,
        issueCount: row.stats.issueCount,
        issueRate: row.stats.issueRate,
        skipCount: row.stats.skipCount,
        failCount: row.stats.failCount,
        timeoutCount: row.stats.timeoutCount,
        crashCount: row.stats.crashCount,
        testsWithIssues: row.tests.length,
        totalTestCount: row.totalTestCount,
    })),
    // The flat list's rows, populated only in `list` mode — where `rows` is
    // empty, because that mode has no group row. Kept as a second key rather
    // than folded into `rows`: a per-test row has no `testsWithIssues` and a
    // group row has no path, so one array of both would have half its fields
    // null on every element.
    tests: renderedTests.map((test) => ({
        fullPath: test.fullPath,
        runCount: test.runCount,
        issueCount: test.issueCount,
        issueRate: test.issueRate,
        skipCount: test.skipCount,
        failCount: test.failCount,
        timeoutCount: test.timeoutCount,
        crashCount: test.crashCount,
    })),
});

export type { ComponentRow, IssueEntry, IssueRow };
