/**
 * `test.html`, migrated onto `lib/`.
 *
 * The second of the three page migrations, following the split
 * `site/crash-viewer.ts` settled:
 *
 * | file | contains | tested by |
 * | --- | --- | --- |
 * | `lib/` | data and derivations: stats, coverage, the bucket hash, status classification | node tests, shared with the CLI |
 * | `site/test-view.ts` | the view model — every decision, and everything naming an id, a class or a glyph | `test/test-view.test.ts`, no DOM |
 * | this file | turning those decisions into elements, and the interactions | the browser parity run |
 *
 * ## What the migration actually removes
 *
 * `common-test-data.js` — the *data* logic, of which `lib/` already had a
 * typed, tested version. The page no longer loads it. Everything it provided
 * has a replacement that was verified against it on real data before being
 * used, and the table is in `site/test-view.ts`'s comment: 775 tests across
 * four bucket files, every field of `computeTestStats` equal and every job of
 * `calculateJobNameBreakdown` equal.
 *
 * The other five shared scripts **stay, loaded by name**. `fetch-utils.js`,
 * `dashboards.js`, `common-ui.js`, `common-links.js` and `shared.js` are UI
 * plumbing with no `lib/` equivalent and up to 22 unmigrated pages depend on
 * them; `tools/build-pages.ts` copies them next to the built page. They are
 * consumed here through `declare global`, which is the price of them being
 * script-tag globals rather than modules — and it is a deliberate price, since
 * turning them into modules would touch every page that loads them.
 *
 * ## Why this builds elements instead of concatenating HTML
 *
 * The old page builds strings and assigns `innerHTML`, which is what forces its
 * `onclick="handleCellClick(this, event)"` attributes to reach global
 * functions, and what forces `originalCellContent` — a `WeakMap` of each cell's
 * original HTML, re-parsed with `innerHTML` every time a day filter is cleared
 * (`old/test.html:2267`). Building nodes removes the need for both: a listener is
 * attached to the element it belongs to, and clearing a filter restores values
 * rather than re-parsing markup.
 *
 * It also removes the escaping question. The old page is careful and, as far as
 * the corpus shows, correct — but it also contains
 * `class="issue-badge badge-fail "data-type="fail"` (`old/test.html:2769`), a
 * missing space that makes `data-type` part of the class attribute's value.
 *
 * ## Declared divergences from `test.html`
 *
 * `PARITY.md` §4: byte-identical is the default and every exception is
 * declared.
 *
 * **This list is the whole set.** It used to be four entries plus a paragraph
 * of prose, and the largest divergence of all — entry 5 — lived only in the
 * prose and was missed by a reviewer checking the list. Anything that makes a
 * parsed-DOM diff non-empty belongs here as a numbered entry, so that a
 * reviewer can check the diff off against it item by item.
 *
 *  1. **The malformed badge attribute is fixed.** `old/test.html:2769`, `:2773`
 *     and `:2777` write `badge-fail "data-type="fail"` — no space before
 *     `data-type`, inside the quoted class value. The browser parses that as
 *     `class="issue-badge badge-fail "` followed by a bare attribute
 *     `data-type=` with value `"fail"`… no: it parses as class
 *     `issue-badge badge-fail` then attribute `data-type` with value `fail`,
 *     because the quote closes the class value and `data-type=` starts a new
 *     attribute. **Measured in Chrome on the real page:** the fail badge's
 *     `className` is `issue-badge badge-fail ` (trailing space) and its
 *     `dataset.type` is `fail`, so the markup is accidentally valid and the
 *     only observable difference is the trailing space in `className`. The new
 *     page emits `issue-badge badge-fail` with no trailing space. Nothing reads
 *     the class string, only `classList`, so this changes no behaviour — it is
 *     listed because a DOM diff sees it.
 *  2. **A day filter restores values, not markup.** Upstream snapshots each
 *     cell's `innerHTML` before any filtering and re-assigns it to clear
 *     (`old/test.html:3171`, `:2267`), which discards the min-widths it just
 *     applied to `.badge-pct` and re-applies them never. Here the badges are
 *     elements the renderer holds, so clearing a filter sets their text and
 *     visibility back. The rendered result is the same; the min-width survives,
 *     which upstream loses.
 *  3. **`copyTestPath` reads a real event.** Upstream's
 *     `copyTestPath(testPath)` uses the implicit global `event`
 *     (`old/test.html:1054`) to find the button. Here the listener has the button.
 *     Same behaviour, no reliance on a deprecated global.
 *  4. **The `?kind=` parameter still does not select the harness.** Preserved
 *     deliberately, because it is a framing property the audit flags: the
 *     harness comes from the *filename* (`detectHarness`), and `?kind=` is read
 *     only by `fetch-utils.js`'s `getHarnessType()` for `index.json`. A test
 *     can therefore render under a harness the user never asked for, via the
 *     fallback in `loadTestData`.
 *  5. **Inline handler attributes become `addEventListener`.** The largest DOM
 *     difference by far, and the reason this list exists as a list. Upstream
 *     emits `onclick="handleCellClick(this, event)"`,
 *     `onmouseenter="showCellRuntime(this)"`,
 *     `onmouseleave="showOverallRuntime()"`,
 *     `onclick="toggleIssueRuns(this, event)"`, `onmouseenter="hoverIssue(this)"`,
 *     `onmouseleave="unhoverIssue()"` and
 *     `onclick="copyTestPath('…')"` as **attributes**, one per cell, per issue
 *     row and per button; this page attaches the same handlers with
 *     `addEventListener` and emits none of them.
 *
 *     **Measured in Chrome, both pages on the pinned snapshot**, counting
 *     `on*` attributes in the live DOM across the eight comparison tests:
 *
 *     ```
 *     test_ext_permissions_api.js   old 195   new 48
 *     test_trr_confirmation.js      old 148   new 27
 *     browser_extension_correction  old 113   new 10
 *     test_private_field_xrays.js   old  90   new  2
 *     browser_refreshBlocker.js     old  88   new  3
 *     test_ext_alarms.js            old  87   new  6
 *     test_root_icons.js            old  78   new  2
 *     test_content_phc.js           old  58   new  1
 *                                   ---------------
 *                             total old 857   new 99
 *     ```
 *
 *     Every one of the 857 is an attribute the new page does not write, and
 *     they account for **all 42-43 node differences the parsed-DOM diff
 *     reports on each page** — with them excluded the two trees are identical.
 *
 *     The new page's remaining `onclick`s are not this page's: they are the
 *     🐛 bug-filing buttons, whose markup comes from `common-links.js:216`
 *     (`onclick="event.stopPropagation();"`), a shared script this migration
 *     deliberately keeps. Their count therefore tracks the number of FAIL
 *     issues rather than the number of cells.
 *
 *     This is behaviour-preserving but it is not invisible: an inline handler
 *     needs a *global* function, which is what tied the old page's rendering to
 *     module-scope globals, and removing them is what lets this file be a
 *     module at all.
 *
 * Everything else — the section order, the two-level row sort, the badge
 * denominator excluding skips, the `run-if` exclusion, the search-form
 * fallback, the unique-substring auto-redirect — is reproduced, and the
 * reasoning for each lives next to the code that does it in
 * `site/test-view.ts`.
 */

import { bucketFileSuffix, bucketIndexForPath, decodeBucket } from '../lib/formats/buckets.ts';
import type { BucketFile } from '../lib/formats/buckets.ts';
import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import { parseTaskId } from '../lib/formats/tables.ts';
import { detectHarness } from '../lib/model/harness.ts';
import { classifyStatus } from '../lib/model/status.ts';
import { displaySkipMessage } from '../lib/model/skips.ts';
import {
    type TestPathsSource,
    CANDIDATE_LIMIT,
    collectTestPaths,
    matchTestPaths,
    resolveTest,
    searchTerms,
} from '../lib/query/test-lookup.ts';
import { computeTestStats } from '../lib/query/test-stats.ts';
import { el } from './drilldown-render.ts';
import { copyToClipboard } from './test-link.ts';
// The `tests.html` URL builders, from the page that owns that URL shape.
import { folderPageUrl } from './tests-view.ts';
import { type ChartColour, CHART_COLOURS } from './chart-colours.ts';
import {
    type CellBadge,
    type DailyRate,
    type DisplayMappings,
    type Histogram,
    type Issue,
    type IssueAttribution,
    type JobCell,
    type Outcomes,
    type RuntimePanel,
    type Selection,
    type SummaryStat,
    type TestView,
    CRASH_NO_SIGNATURE,
    FAILURE_NO_MESSAGE,
    buildDayCellMatrix,
    buildIssueAttribution,
    buildRuntimePanel,
    buildTestView,
    cellKey,
    collectDurations,
    computeHistogramBins,
    dateOfDay,
    displayPlatformOf,
    displayVariantOf,
    filterIssues,
    filteredCell,
    formatCount,
    issueFilterNotice,
    runtimeTitleFor,
} from './test-view.ts';

// --- the shared scripts, as they are ------------------------------------
//
// Declared rather than imported: these are `<script src=...>` globals from
// files up to 22 unmigrated pages depend on, which the build copies next to
// this page. Typing them here is what lets the rest of this file be checked.

declare global {
    /** `common-ui.js:22` — turns `[path:123]` in a failure message into a link. */
    function linkifyFailureMessage(message: string, testPath: string): string;
    /** `common-ui.js:488` — sorts runs newest first and adds `dateHtml`. */
    function prepareRunsForDisplay(runs: { date: string | null; dateHtml?: string }[]): void;
    /** `common-links.js:43` — the Treeherder URL for one job. */
    function getTreeherderJobUrl(
        instance: { taskId: string; retryId: string },
        data: unknown
    ): string | null;
    /** `common-links.js:126` — the Bugzilla filing URL for a failure. */
    function getBugzillaUrl(options: {
        testPath: string;
        summary: string;
        component: string;
        stats: {
            failureCount: number;
            totalRuns: number;
            firstDate: string | null;
            lastDate: string | null;
        };
        addSearchHash: boolean;
    }): string;
    /** `common-links.js:186` — the first and last date the data covers. */
    function getDataDateRange(data: unknown): { firstDate: string | null; lastDate: string | null };
    /** `common-links.js:215` — the 🐞 button's markup. */
    function getBugButton(bugUrl: string, tooltipText?: string): string;
    /** `fetch-utils.js:172` — fetches a data file, honouring `?data-source=`. */
    function fetchData(filename: string): Promise<Response>;
    /** `fetch-utils.js:41` — carries `?data-source=`/`?profiler=` onto a link. */
    function withDevParams(url: string): string;
    /** `shared.js:3` — recolours the favicon. */
    function setFavicon(color: string): void;
    /** `shared.js:32` — the profiler front end to link to. */
    function getProfilerOrigin(): string;
    /** Chart.js, loaded from a CDN on demand. */
    const Chart: ChartConstructor;
}

/** The slice of Chart.js this page uses. */
interface ChartConstructor {
    new (canvas: HTMLCanvasElement, config: ChartConfig): ChartInstance;
    register(plugin: ChartPlugin): void;
    getChart(canvas: HTMLCanvasElement): ChartInstance | undefined;
}

interface ChartDataset {
    label: string;
    data: number[];
    backgroundColor: string;
    borderColor: string;
    borderWidth: number;
    /** The unfiltered series, kept so a filter can be cleared. */
    _origData?: number[];
    /** Which field of a rate row this dataset draws. */
    _rateField?: RateField;
    /** True for the dimmed "everything else" half of a pair. */
    _isRemainder?: boolean;
}

interface ChartConfig {
    type: string;
    data: { labels: string[]; datasets: ChartDataset[] };
    options: Record<string, unknown>;
}

interface ChartInstance {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    data: { labels: string[]; datasets: ChartDataset[] };
    chartArea: { top: number; bottom: number; left: number; right: number };
    scales: Record<string, ChartScale | undefined>;
    update(mode?: string): void;
    destroy(): void;
    /** Set by this page, read by the day-highlight plugin. */
    _hoveredDay?: number | null;
    _clickedDays?: ReadonlySet<number> | null;
    _cellDailyData?: Outcomes[] | null;
    _lastHighlightKey?: string;
}

interface ChartScale {
    width: number;
    left: number;
    ticks: unknown[];
    display?: boolean;
    getPixelForValue(value: number): number;
}

interface ChartPlugin {
    id: string;
    beforeDatasetsDraw(chart: ChartInstance): void;
}

/** Which per-day rate a chart dataset draws. */
type RateField = 'failureRate' | 'timeoutRate' | 'crashRate' | 'skipRate';

// --- small DOM helpers ---------------------------------------------------

/** An element the page's own markup guarantees exists. */
function requireElement(id: string): HTMLElement {
    const node = document.getElementById(id);
    if (node === null) {
        throw new Error(`${id} is missing from the page`);
    }
    return node;
}

// --- page state ----------------------------------------------------------
//
// The interactions are hover-driven and share state; this is the same set the
// old page keeps in module-scope `let`s, held in one object so that what an
// interaction reads is visible at a glance.

/** Everything the interactions need after the initial render. */
interface PageState {
    raw: BucketFile;
    file: DecodedTimingFile;
    testId: number;
    testPath: string;
    view: TestView;
    mappings: DisplayMappings;
    /** `[day][cellKey] -> outcomes`. */
    matrix: Map<string, Outcomes>[];
    attribution: IssueAttribution[];
    /** The cell elements, so a filter can update them without re-parsing. */
    cells: RenderedCell[];
    /** Every pass duration, and the same split by cell. */
    durations: { all: number[]; byCell: Map<string, number[]> };
    overallRange: { min: number; max: number } | null;
    overallBins: number[] | null;
    /** Hover and click, kept apart because clicks persist and hovers do not. */
    hoveredCell: string | null;
    hoveredDay: number | null;
    hoveredIssueIndex: number | null;
    clickedCells: Set<string>;
    clickedDays: Set<number>;
    shiftAnchorDay: number | null;
    failureRateChart: ChartInstance | null;
    skipRateChart: ChartInstance | null;
    /** The rendered issue rows, for the filter. */
    issueRows: RenderedIssue[];
    /** Cache keys, so a mouse move that changes nothing does no work. */
    lastRuntimeKey: string;
}

/** One rendered job-table cell and the elements a filter touches. */
interface RenderedCell {
    cell: JobCell;
    td: HTMLTableCellElement;
    naLayer: HTMLElement | null;
    prefixLayer: HTMLElement | null;
    badgesLayer: HTMLElement | null;
    badges: Map<CellBadge['kind'], { element: HTMLElement; percent: HTMLElement | null }>;
    /** Whether a day filter is currently applied to this cell. */
    dayFiltered: boolean;
}

/** One rendered issue row and the elements the filter touches. */
interface RenderedIssue {
    issue: Issue;
    item: HTMLElement;
    countSpan: HTMLElement;
    chart: HTMLElement | null;
    runs: HTMLElement | null;
}

/** The live state, or `null` before a test has loaded. */
let state: PageState | null = null;

/** The cells contributing to the filter: clicked, plus whatever is hovered. */
function activeCells(s: PageState): Set<string> {
    const cells = new Set(s.clickedCells);
    if (s.hoveredCell !== null) {
        cells.add(s.hoveredCell);
    }
    return cells;
}

/** The days contributing to the filter. */
function activeDays(s: PageState): Set<number> {
    const days = new Set(s.clickedDays);
    if (s.hoveredDay !== null) {
        days.add(s.hoveredDay);
    }
    return days;
}

/** The current selection, as the view model wants it. */
function currentSelection(s: PageState): Selection {
    return { cells: activeCells(s), days: activeDays(s) };
}

// --- the header ----------------------------------------------------------

/**
 * The test header: name, harness badge, path, copy button, component.
 *
 * Rendered twice — once as a placeholder before the data arrives and once for
 * real — so it is one function taking the component as a parameter. The
 * placeholder passes a live element it can fill in later.
 */
function renderHeader(
    testPath: string,
    harness: string,
    component: string | Node | null
): HTMLElement {
    const testName = testPath.split('/').pop() ?? testPath;
    const heading = el('h1', { text: testName });
    heading.append(
        el('span', { class: `harness-badge harness-${harness}`, text: harness })
    );

    const pathLine = el('div', { class: 'test-path-line' });
    // The path, split at the separators: each directory segment links to that
    // folder's burndown, and the filename keeps the Searchfox link the whole
    // path used to carry.
    //
    // Split rather than given a button of its own. A "📉 Folder" button beside
    // the path duplicated information the path already showed, and only offered
    // the *immediate* parent — whereas the question after reading one test is
    // often about a subsystem two or three levels up. The segments answer both
    // and add no chrome.
    pathLine.append(...pathSegments(testPath));

    // The copy button holds its own listener rather than an `onclick` attribute
    // reaching a global, so it also no longer depends on the implicit `event`
    // global that `copyTestPath` reads (`old/test.html:1054`).
    //
    // The clipboard write and the ✓ flash come from `site/test-link.ts`, which
    // holds the one copy of both; only the button is this page's, because this
    // one sits in the header rather than in a row — there is no row to keep a
    // click from reaching, and no `test.html` to link to, since this is it.
    const copyButton = el('button', {
        class: 'copy-btn',
        text: '📋 Copy',
        title: 'Copy test path',
    });
    copyButton.addEventListener('click', () => {
        void copyToClipboard(testPath, copyButton);
    });
    pathLine.append(copyButton);

    const header = el('div', { class: 'test-header', children: [heading, pathLine] });
    if (component !== null) {
        const line = el('div', { class: 'component-line' });
        if (typeof component === 'string') {
            // One text node, not two. Upstream writes `Bugzilla: ${component}`
            // as a single interpolation, so the DOM has one child; appending
            // the label and the value separately splits it, which the parsed-DOM
            // diff reports as a child-count difference. Found exactly that way.
            line.textContent = `Bugzilla: ${component}`;
        } else {
            line.append(document.createTextNode('Bugzilla: '), component);
        }
        header.append(line);
    }
    return header;
}

/**
 * A test path as linked segments: each folder, then the filename.
 *
 * `dom/base/test/test_foo.html` becomes four links — `dom`, `base` and `test`
 * to each folder's burndown, and `test_foo.html` to Searchfox. So a reader can
 * ask "do this test's siblings fail the same way" at whichever level the
 * question actually lives, which is not always the immediate parent.
 *
 * The separators are their own nodes so the path still reads as a path and a
 * double-click selects one segment rather than the whole line.
 */
function pathSegments(testPath: string): Node[] {
    const parts = testPath.split('/');
    const fileName = parts.pop() ?? testPath;
    const nodes: Node[] = [];
    let prefix = '';
    for (const part of parts) {
        prefix = prefix === '' ? part : `${prefix}/${part}`;
        const link = el('a', {
            class: 'path-segment',
            text: part,
            title: `Tests in ${prefix}`,
            href: folderPageUrl(prefix),
        });
        nodes.push(link, el('span', { class: 'path-sep', text: '/' }));
    }
    nodes.push(
        el('a', {
            class: 'path-file',
            text: fileName,
            title: 'Open in Searchfox',
            attrs: {
                href: `https://searchfox.org/mozilla-central/source/${testPath}`,
                target: '_blank',
            },
        })
    );
    return nodes;
}

/** One figure of the summary bar. */
function renderSummaryStat(stat: SummaryStat): HTMLElement {
    return el('div', {
        class: 'summary-stat',
        children: [
            el('span', {
                class: `summary-stat-value${stat.cssClass === '' ? '' : ` ${stat.cssClass}`}`,
                text: stat.value,
            }),
            el('span', { class: 'summary-stat-label', text: stat.label }),
        ],
    });
}

/** The summary bar. */
function renderSummary(stats: SummaryStat[]): HTMLElement {
    return el('div', {
        class: 'summary-stats',
        children: stats.map(renderSummaryStat),
    });
}

// --- the job table -------------------------------------------------------

/**
 * The `Pass/Fail by Job` table.
 *
 * A pivot: one row per job variant, one column per platform
 * (`old/test.html:2670`). The row order and the badge contents are the view
 * model's; this only draws them and wires the hover and click.
 */
function renderJobTable(s: PageState): HTMLElement | null {
    const { jobTable } = s.view;
    if (jobTable.rows.length === 0) {
        return null;
    }

    // `Pass/Fail by Job ` with a trailing space when the date span follows:
    // upstream writes `Pass/Fail by Job${dateInfo ? ' <span…' : ''}`
    // (`old/test.html:2709`), so the space belongs to the heading's own text node
    // rather than being a separator node of its own. Appending it separately
    // splits one text node into two, which the parsed-DOM diff reports and a
    // reader cannot see. Found that way.
    const heading = el('h2', {
        text: s.view.jobTableDateInfo === '' ? 'Pass/Fail by Job' : 'Pass/Fail by Job ',
    });
    if (s.view.jobTableDateInfo !== '') {
        heading.append(
            el('span', {
                text: `(${s.view.jobTableDateInfo})`,
                attrs: { style: 'font-size: 12px; color: #888; font-weight: normal;' },
            })
        );
    }

    const headRow = el('tr', { children: [el('th', { text: 'Job' })] });
    for (const header of jobTable.platformHeaders) {
        headRow.append(el('th', { text: header }));
    }

    const body = el('tbody');
    for (const row of jobTable.rows) {
        const tr = el('tr');
        tr.append(
            el('td', {
                text: row.variant,
                attrs: { style: 'font-family: monospace; font-size: 12px;' },
            })
        );
        for (const cell of row.cells) {
            tr.append(renderJobCell(s, cell));
        }
        body.append(tr);
    }

    const table = el('table', {
        class: 'platform-table job-table',
        children: [el('thead', { children: [headRow] }), body],
    });
    return el('div', { class: 'section', children: [heading, table] });
}

/**
 * One cell: three stacked layers, of which two start hidden.
 *
 * The stack is upstream's (`old/test.html:2749`) and exists because a day filter
 * has to be able to replace the badges with an em-dash or a bare `PASS` without
 * re-laying-out the table. All three occupy the same grid area.
 */
function renderJobCell(s: PageState, cell: JobCell): HTMLTableCellElement {
    if (cell.outcomes === null) {
        // No `data-variant`, so this cell is not selectable and not hoverable —
        // there is nothing to select.
        return el('td', {
            class: 'job-cell',
            children: [el('span', { class: 'job-na', text: '—' })],
        });
    }

    const td = el('td', {
        class: 'job-cell',
        attrs: { 'data-variant': cell.variant, 'data-platform': cell.platform },
    });

    const naLayer = el('span', {
        class: 'cell-layer job-na',
        text: '—',
        attrs: { 'data-type': 'na', style: 'display:none' },
    });

    const prefixLayer = cell.hasPassPrefixLayer
        ? el('span', {
              class: 'cell-layer issue-badge badge-pass',
              text: 'PASS',
              attrs: { 'data-type': 'pass', 'data-prefix': '1', style: 'display:none' },
          })
        : null;

    const badgesLayer = el('div', { class: 'cell-layer badges-layer' });
    const badges = new Map<CellBadge['kind'], { element: HTMLElement; percent: HTMLElement | null }>();
    for (const [index, badge] of cell.badges.entries()) {
        if (index > 0) {
            // Upstream joins the badges with `<br>`, which is what stacks them.
            badgesLayer.append(el('br'));
        }
        const element = el('span', {
            // Upstream writes `badge-fail "data-type=` with no space, which
            // leaves a trailing space in the class value. See divergence 1.
            class: `issue-badge badge-${badge.kind}`,
            title: badge.tooltip,
            attrs: { 'data-type': badge.kind },
        });
        let percent: HTMLElement | null = null;
        if (badge.percentText === null) {
            element.textContent = badge.label;
        } else {
            element.append(el('span', { text: badge.label }));
            percent = el('span', { class: 'badge-pct', text: badge.percentText });
            element.append(percent);
        }
        badgesLayer.append(element);
        badges.set(badge.kind, { element, percent });
    }

    const stack = el('div', { class: 'cell-stack' });
    stack.append(naLayer);
    if (prefixLayer !== null) {
        stack.append(prefixLayer);
    }
    stack.append(badgesLayer);
    td.append(stack);

    if (cell.noHover) {
        td.classList.add('no-hover');
    }

    td.addEventListener('mouseenter', () => {
        if (td.classList.contains('no-hover')) {
            return;
        }
        if (s.hoveredCell === cell.key) {
            return;
        }
        s.hoveredCell = cell.key;
        updateSelection(s);
    });
    td.addEventListener('mouseleave', () => {
        if (s.hoveredCell === null) {
            return;
        }
        s.hoveredCell = null;
        updateSelection(s);
    });
    td.addEventListener('click', (event) => {
        event.stopPropagation();
        handleCellClick(s, cell.key, event);
    });

    s.cells.push({
        cell,
        td,
        naLayer,
        prefixLayer,
        badgesLayer,
        badges,
        dayFiltered: false,
    });
    return td;
}

/**
 * Clicking a cell.
 *
 * `handleCellClick` (`old/test.html:1824`). Ctrl/Cmd toggles one cell in or out of
 * the set; a plain click selects only that cell, or clears the selection if it
 * was already the only one — so clicking the same cell twice returns to the
 * unfiltered view, which is the affordance that makes the filter safe to try.
 */
function handleCellClick(s: PageState, key: string, event: MouseEvent): void {
    if (event.ctrlKey || event.metaKey) {
        if (s.clickedCells.has(key)) {
            s.clickedCells.delete(key);
        } else {
            s.clickedCells.add(key);
        }
    } else if (s.clickedCells.size === 1 && s.clickedCells.has(key)) {
        s.clickedCells.clear();
    } else {
        s.clickedCells.clear();
        s.clickedCells.add(key);
    }
    updateSelection(s);
}

/**
 * Clicking a day in the chart.
 *
 * `handleDayClick` (`old/test.html:1848`). Shift extends from the anchor, which is
 * the last day clicked without shift; Ctrl/Cmd toggles; a plain click behaves
 * like a cell click. Shift **without** ctrl clears first, so shift-clicking a
 * new range replaces the old one rather than accumulating.
 */
function handleDayClick(s: PageState, dayIndex: number, event: MouseEvent): void {
    if (event.shiftKey && s.shiftAnchorDay !== null) {
        const start = Math.min(s.shiftAnchorDay, dayIndex);
        const end = Math.max(s.shiftAnchorDay, dayIndex);
        if (!event.ctrlKey && !event.metaKey) {
            s.clickedDays.clear();
        }
        for (let d = start; d <= end; d++) {
            s.clickedDays.add(d);
        }
    } else if (event.ctrlKey || event.metaKey) {
        if (s.clickedDays.has(dayIndex)) {
            s.clickedDays.delete(dayIndex);
        } else {
            s.clickedDays.add(dayIndex);
        }
        s.shiftAnchorDay = dayIndex;
    } else {
        if (s.clickedDays.size === 1 && s.clickedDays.has(dayIndex)) {
            s.clickedDays.clear();
        } else {
            s.clickedDays.clear();
            s.clickedDays.add(dayIndex);
        }
        s.shiftAnchorDay = dayIndex;
    }
    updateSelection(s);
}

// --- the runtime panel ---------------------------------------------------

/** The runtime panel's shell, whose contents are replaced on selection. */
function renderRuntimePanel(panel: RuntimePanel | null): HTMLElement {
    const content = el('div', { id: 'runtime-panel-content' });
    fillRuntimePanel(content, panel);
    return el('div', {
        class: 'section runtime-panel',
        children: [el('h2', { text: 'Run Times' }), content],
    });
}

/** Fills the panel, or says there is no duration data. */
function fillRuntimePanel(container: HTMLElement, panel: RuntimePanel | null): void {
    container.replaceChildren();
    if (panel === null) {
        container.append(el('div', { class: 'runtime-panel-title', text: 'No duration data' }));
        return;
    }
    container.append(el('div', { class: 'runtime-panel-title', text: panel.title }));
    container.append(el('div', { class: 'runtime-panel-subtitle', text: panel.subtitle }));

    const stats = el('div', { class: 'runtime-panel-stats' });
    for (const item of panel.items) {
        stats.append(
            el('div', {
                class: 'timing-item',
                children: [
                    el('span', { class: 'timing-value', text: item.value }),
                    el('span', { class: 'timing-label', text: item.label }),
                ],
            })
        );
    }
    container.append(stats);

    const histogram = renderHistogram(panel.histogram);
    if (histogram !== null) {
        container.append(...histogram);
    }
}

/** The two-layer histogram, or `null` when there is nothing to draw. */
function renderHistogram(histogram: Histogram | null): Node[] | null {
    if (histogram === null) {
        return null;
    }
    const bars = el('div', { class: 'histogram' });
    for (const bar of histogram.bars) {
        const column = el('div', { class: 'histogram-col', title: bar.tooltip });
        if (bar.hasBackground) {
            column.append(
                el('div', {
                    class: 'histogram-bar-bg',
                    attrs: { style: `height: ${bar.backgroundPercent}%;` },
                })
            );
        }
        if (bar.hasForeground) {
            column.append(
                el('div', {
                    class: 'histogram-bar-fg',
                    attrs: { style: `height: ${bar.foregroundPercent}%;` },
                })
            );
        }
        bars.append(column);
    }
    const labels = el('div', {
        class: 'histogram-labels',
        children: histogram.labels.map((label) => el('span', { text: label })),
    });
    return [bars, labels];
}

// --- issue details -------------------------------------------------------

/**
 * The `Issue Details` section, or `null` when the test has no issues.
 *
 * Returning nothing rather than an empty section is upstream
 * (`old/test.html:2549`), and it is the right call: a heading over nothing reads as
 * a loading failure.
 */
function renderIssueDetails(s: PageState): HTMLElement | null {
    const { issues } = s.view;
    if (issues.length === 0) {
        return null;
    }

    const notice = el('span', {
        class: 'issue-filter-notice',
        id: 'issue-filter-notice',
        attrs: { style: 'display: none;' },
    });
    const heading = el('h2', { text: 'Issue Details' });
    heading.append(notice);

    const list = el('div', { class: 'issue-section' });
    for (const [index, issue] of issues.entries()) {
        list.append(...renderIssue(s, issue, index));
    }

    return el('div', {
        class: 'section',
        id: 'issue-details-section',
        children: [heading, list],
    });
}

/** One issue row, plus its collapsed chart and run list when expandable. */
function renderIssue(s: PageState, issue: Issue, index: number): Node[] {
    const countSpan = el('span', { class: 'issue-count', text: String(issue.count) });
    if (issue.countTooltip !== null) {
        countSpan.title = issue.countTooltip;
    }

    const message = el('span', { class: 'issue-message' });
    if (issue.type === 'FAIL') {
        // `linkifyFailureMessage` escapes its own input and may return a link,
        // so this is one of the two places markup is assigned rather than text.
        message.innerHTML = linkifyFailureMessage(issue.message, s.testPath);
    } else {
        message.textContent = issue.message;
    }

    // The bug-filing button, for failures on a test with a real component.
    const component = s.view.component;
    if (issue.type === 'FAIL' && component !== null && component.includes(' :: ')) {
        const { firstDate, lastDate } = getDataDateRange(s.raw);
        const bugUrl = getBugzillaUrl({
            testPath: s.testPath,
            summary: issue.message,
            component,
            stats: {
                failureCount: issue.count,
                totalRuns: s.view.stats.runCount,
                firstDate,
                lastDate,
            },
            addSearchHash: false,
        });
        const holder = el('span');
        holder.innerHTML = getBugButton(bugUrl, 'File bug for this failure');
        // `getBugButton` returns one element's markup; move it rather than
        // leaving the wrapper span in the tree, which would change the DOM.
        message.append(...holder.childNodes);
    }

    const item = el('div', {
        class: 'issue-item',
        children: [
            countSpan,
            el('span', { class: `issue-badge ${issue.badgeClass}`, text: issue.type }),
            message,
        ],
    });
    item.dataset['issueIndex'] = String(index);

    item.addEventListener('mouseenter', () => {
        if (s.hoveredIssueIndex === index) {
            return;
        }
        s.hoveredIssueIndex = index;
        updateChartHighlight(s);
    });
    item.addEventListener('mouseleave', () => {
        if (s.hoveredIssueIndex === null) {
            return;
        }
        s.hoveredIssueIndex = null;
        updateChartHighlight(s);
    });

    if (!issue.expandable) {
        // A SKIP has no runs to list: the run never happened.
        item.style.cursor = 'default';
        s.issueRows.push({ issue, item, countSpan, chart: null, runs: null });
        return [item];
    }

    item.dataset['issueId'] = issue.id;
    const canvas = el('canvas', {
        class: 'historical-chart-canvas',
        id: `${issue.id}-canvas`,
    });
    const chart = el('div', {
        class: 'historical-chart',
        id: `${issue.id}-chart`,
        attrs: { style: 'display: none; margin-left: 50px;' },
        children: [canvas],
    });
    const runs = el('div', {
        class: 'issue-runs',
        id: `${issue.id}-runs`,
        attrs: { style: 'display: none;' },
    });

    item.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleIssueRuns(s, issue, chart, runs);
    });

    s.issueRows.push({ issue, item, countSpan, chart, runs });
    return [item, chart, runs];
}

/**
 * Expands or collapses one issue's runs, and its per-issue chart.
 *
 * The run list is built on demand rather than up front: a test with 40 issues
 * and 2,000 failing runs would otherwise render 2,000 table rows nobody asked
 * for.
 */
function toggleIssueRuns(
    s: PageState,
    issue: Issue,
    chart: HTMLElement,
    runs: HTMLElement
): void {
    if (runs.style.display === 'none') {
        renderIssueRuns(s, issue, runs);
        runs.style.display = 'block';
        chart.style.display = 'block';
        drawIssueChart(s, issue);
    } else {
        runs.style.display = 'none';
        chart.style.display = 'none';
    }
}

/** One run of one issue, as the expanded list shows it. */
interface RunInfo {
    jobName: string;
    date: string | null;
    dateHtml?: string;
    profileLink: string;
    crashLink: string | null;
    treeherderLink: string | null;
}

/**
 * The runs behind one issue, honouring the current selection.
 *
 * `getIssueRuns` (`old/test.html:912`). Filtered by the same day and cell selection
 * as everything else, so expanding an issue while a cell is selected lists that
 * cell's runs rather than all of them.
 *
 * Skips are the exception and are never listed: a skip has no task, so there is
 * nothing to link to. The old page has a SKIP branch here but never reaches it,
 * because a SKIP row is not expandable (`old/test.html:2562`) — reproduced by
 * simply not having the branch.
 */
function renderIssueRuns(s: PageState, issue: Issue, container: HTMLElement): void {
    const selection = currentSelection(s);
    const hasDays = selection.days.size > 0;
    const hasCells = selection.cells.size > 0;
    const runs: RunInfo[] = [];

    for (const entry of s.file.runsOfTest(s.testId)) {
        if (entry.day === null || entry.day >= s.view.rates.length) {
            continue;
        }
        if (!issueMatchesEntryForRuns(entry.status, entry.message, entry.crashSignature, issue)) {
            continue;
        }
        if (hasDays && !selection.days.has(entry.day)) {
            continue;
        }
        const taskIdIndexes = entry.taskIdIndexes ?? [];
        for (const [i, taskIdIndex] of taskIdIndexes.entries()) {
            const jobName = s.file.jobNameOfTaskIndex(taskIdIndex);
            if (jobName === null) {
                continue;
            }
            if (hasCells) {
                const key = cellKey(
                    displayVariantOf(s.mappings, jobName),
                    displayPlatformOf(s.mappings, jobName)
                );
                if (!selection.cells.has(key)) {
                    continue;
                }
            }
            const rawTaskId = entry.taskIds?.[i];
            if (rawTaskId === undefined) {
                continue;
            }
            runs.push(
                buildRunInfo(s, taskIdIndex, rawTaskId, entry.day, issue.type, entry.minidumps?.[i])
            );
        }
    }

    container.replaceChildren();
    if (runs.length === 0) {
        container.append(el('span', { text: 'No matching runs found' }));
        return;
    }

    // `prepareRunsForDisplay` sorts newest first and computes the date cell's
    // markup, showing a date only on the first row of each day.
    prepareRunsForDisplay(runs);

    const table = el('table');
    for (const run of runs) {
        const tr = el('tr');
        // The date cell is `common-ui.js`'s markup, a `<td>` this row needs as
        // its own child; parsing it through a template is what keeps it one.
        const dateCell = document.createElement('template');
        dateCell.innerHTML = run.dateHtml ?? '<td class="run-date"></td>';
        tr.append(...dateCell.content.childNodes);

        const mainLink = issue.type === 'CRASH' && run.crashLink !== null
            ? run.crashLink
            : run.profileLink;
        tr.append(
            el('td', {
                class: 'run-job-name',
                children: [
                    el('a', {
                        text: run.jobName,
                        attrs: { href: mainLink, target: '_blank' },
                    }),
                ],
            })
        );

        const links: Node[] = [];
        const push = (text: string, href: string): void => {
            if (links.length > 0) {
                links.push(document.createTextNode(' '));
            }
            links.push(el('a', { text, attrs: { href, target: '_blank' } }));
        };
        push('Profile', run.profileLink);
        if (run.crashLink !== null) {
            push('Crash', run.crashLink);
        }
        if (run.treeherderLink !== null) {
            push('Job', run.treeherderLink);
        }
        const viewCell = el('td', { class: 'view-links' });
        viewCell.append(document.createTextNode('View: '), ...links);
        tr.append(viewCell);
        table.append(tr);
    }
    container.append(table);
}

/**
 * Whether one entry is an occurrence of one issue, for the run list.
 *
 * The same predicate the view model's `entryMatchesIssue` applies, restated
 * here because the run list works from raw entries rather than from the
 * attribution maps — it needs the task IDs, which the maps do not keep.
 */
function issueMatchesEntryForRuns(
    status: string,
    message: string | null | undefined,
    crashSignature: string | null | undefined,
    issue: Issue
): boolean {
    const { kind } = classifyStatus(status);
    switch (issue.type) {
        case 'TIMEOUT':
            return kind === 'timeout';
        case 'CRASH':
            if (kind !== 'crash') {
                return false;
            }
            return crashSignature === null || crashSignature === undefined
                ? issue.message === CRASH_NO_SIGNATURE
                : crashSignature === issue.message;
        case 'FAIL': {
            if (kind !== 'fail') {
                return false;
            }
            const text = message ?? '';
            return issue.message === FAILURE_NO_MESSAGE ? text === '' : text === issue.message;
        }
        case 'SKIP': {
            if (kind !== 'skip') {
                return false;
            }
            const clean = message ? displaySkipMessage(message) : '';
            return clean === issue.message;
        }
    }
}

/**
 * The links for one run.
 *
 * `createRunInfo` (`old/test.html:869`). The job name gets its chunk suffix back
 * from `taskInfo.chunks` — bucket files strip it from `tables.jobNames` and
 * keep it as a parallel array, so a run's *actual* job name has to be
 * reassembled to be recognizable in Treeherder.
 */
function buildRunInfo(
    s: PageState,
    taskIdIndex: number,
    rawTaskId: string,
    day: number,
    issueType: Issue['type'],
    minidump: string | null | undefined
): RunInfo {
    const baseJobName = s.file.jobNameOfTaskIndex(taskIdIndex) ?? '';
    const chunk = s.raw.taskInfo.chunks?.[taskIdIndex];
    const jobName = chunk === null || chunk === undefined ? baseJobName : `${baseJobName}-${chunk}`;
    const { taskId, retryId } = parseTaskId(rawTaskId);

    const date = dateOfDay(s.raw.metadata.startTime, day);
    const profileUrl =
        `https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/${taskId}` +
        `/runs/${retryId}/artifacts/public/test_info/profile_resource-usage.json`;
    const profileName = `${jobName} (${rawTaskId})`;
    const testName = s.testPath.split('/').pop() ?? s.testPath;
    const profileLink =
        `${getProfilerOrigin()}/from-url/${encodeURIComponent(profileUrl)}` +
        `?profileName=${encodeURIComponent(profileName)}` +
        `&markerSearch=${encodeURIComponent(testName)}`;

    let crashLink: string | null = null;
    if (issueType === 'CRASH' && minidump !== null && minidump !== undefined) {
        const jsonUrl =
            `https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/${taskId}` +
            `/runs/${retryId}/artifacts/public/test_info/${minidump}.json`;
        crashLink = `crash-viewer.html?url=${encodeURIComponent(jsonUrl)}`;
    }

    return {
        jobName,
        date,
        profileLink,
        crashLink,
        treeherderLink: getTreeherderJobUrl({ taskId, retryId: String(retryId) }, s.raw),
    };
}

// --- charts --------------------------------------------------------------

/**
 * The chart colours, per issue type. `old/test.html:1578`.
 *
 * The values live in `site/chart-colours.ts`, which is the one copy shared with
 * `tests.html`; this maps them onto *this* page's type names. The mapping is
 * the page's, the palette is not.
 */
const ISSUE_CHART_COLOURS: Record<Issue['type'], ChartColour> = {
    SKIP: CHART_COLOURS.skip,
    FAIL: CHART_COLOURS.fail,
    TIMEOUT: CHART_COLOURS.timeout,
    CRASH: CHART_COLOURS.crash,
};

/** Chart.js options shared by all three charts. `old/test.html:1167`. */
function commonChartOptions(
    yAxisLabel: string,
    tooltipCallback: (context: TooltipContext) => string | null,
    extra: { stacked?: boolean; hideXAxis?: boolean; tooltipFooter?: (items: { dataIndex: number }[]) => string } = {}
): Record<string, unknown> {
    const scales: Record<string, Record<string, unknown>> = {
        x: {},
        y: {
            beginAtZero: true,
            title: { display: true, text: yAxisLabel },
            ticks: { callback: (value: number) => `${value}%` },
        },
    };
    if (extra.stacked === true) {
        scales['x']!['stacked'] = true;
        scales['y']!['stacked'] = true;
    }
    if (extra.hideXAxis === true) {
        scales['x']!['display'] = false;
    }
    const tooltip: Record<string, unknown> = {
        animation: false,
        callbacks: extra.tooltipFooter === undefined
            ? { label: tooltipCallback }
            : { label: tooltipCallback, footer: extra.tooltipFooter },
    };
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { title: { display: false }, legend: { display: false }, tooltip },
        scales,
    };
}

/** What Chart.js hands a tooltip callback. */
interface TooltipContext {
    dataset: ChartDataset;
    dataIndex: number;
    chart: ChartInstance;
    parsed: { y: number };
}

/**
 * A dataset and its dimmed remainder.
 *
 * `makeDatasetPair` (`old/test.html:1207`). The pair is what makes a cell filter
 * legible: the bright half shows the selection's contribution and the dim half
 * shows what the rest of the runs contributed, stacked on top, so the total bar
 * height stays the same and the selection reads as a share of it.
 */
function makeDatasetPair(
    label: string,
    data: number[],
    origBg: string,
    dimBg: string,
    origBorder: string,
    rateField: RateField
): ChartDataset[] {
    return [
        {
            label,
            data: [...data],
            backgroundColor: origBg,
            borderColor: origBorder,
            borderWidth: 1,
            _origData: data,
            _rateField: rateField,
        },
        {
            label: `${label} (other)`,
            data: new Array<number>(data.length).fill(0),
            backgroundColor: dimBg,
            borderColor: dimBg,
            borderWidth: 0,
            _origData: data,
            _rateField: rateField,
            _isRemainder: true,
        },
    ];
}

/** The per-day rates the charts plot. */
interface RateRow {
    failureRate: number;
    timeoutRate: number;
    crashRate: number;
    skipRate: number;
}

/**
 * Per-day rates from the daily totals.
 *
 * Two denominators, and the difference is the point: the failure, timeout and
 * crash rates divide by runs that *happened* (skips excluded), while the skip
 * rate divides by runs that were *scheduled* (skips included). A skip is not a
 * failed run, and a run that was skipped was still scheduled — so neither
 * denominator works for both.
 */
function rateRows(rates: readonly DailyRate[]): RateRow[] {
    return rates.map((d) => {
        const totalNonSkip = d.passes + d.failures + d.timeouts + d.crashes;
        const totalWithSkips = totalNonSkip + d.skips;
        return {
            failureRate: totalNonSkip > 0 ? (d.failures / totalNonSkip) * 100 : 0,
            timeoutRate: totalNonSkip > 0 ? (d.timeouts / totalNonSkip) * 100 : 0,
            crashRate: totalNonSkip > 0 ? (d.crashes / totalNonSkip) * 100 : 0,
            skipRate: totalWithSkips > 0 ? (d.skips / totalWithSkips) * 100 : 0,
        };
    });
}

/** Whether the pointer is inside the chart area; see `chartHover`. */
let chartPointerInside = false;

/**
 * Builds the two daily-rate charts and wires the whole chart area.
 *
 * `createFailureRateChart` (`old/test.html:1233`). The hover target is the
 * containing `#daily-chart-area`, not just the canvases, so the x-axis labels
 * and the gap between the two charts also select a day — without that, moving
 * the pointer down from a bar to read its date loses the selection.
 */
function createDailyCharts(s: PageState): void {
    const rates = s.view.rates;
    const labels = rates.map((d) => d.date);
    const percentages = rateRows(rates);

    const canvas = document.getElementById('daily-rate-canvas');
    const skipCanvas = document.getElementById('daily-skips-canvas');

    const chartHover = (event: { native?: MouseEvent }, elements: { index: number }[]): void => {
        // Chart.js fires `onHover` from `chart.update()` too, which lands here
        // after the pointer has already left. Upstream guards with the same
        // flag (`old/test.html:1249`).
        if (!chartPointerInside) {
            return;
        }
        if (event.native) {
            (event.native.target as HTMLElement).style.cursor =
                elements.length > 0 ? 'pointer' : '';
        }
        const dayIndex = elements.length > 0 ? elements[0]!.index : null;
        if (s.hoveredDay !== dayIndex) {
            s.hoveredDay = dayIndex;
            updateSelection(s);
        }
    };
    const chartClick = (event: { native?: MouseEvent }, elements: { index: number }[]): void => {
        if (elements.length === 0 || event.native === undefined) {
            return;
        }
        handleDayClick(s, elements[0]!.index, event.native);
    };

    if (canvas instanceof HTMLCanvasElement) {
        const datasets = [
            ...makeDatasetPair(
                'Failure %',
                percentages.map((d) => d.failureRate),
                CHART_COLOURS.fail.bg,
                'rgba(200, 180, 160, 0.18)',
                CHART_COLOURS.fail.border,
                'failureRate'
            ),
            ...makeDatasetPair(
                'Timeout %',
                percentages.map((d) => d.timeoutRate),
                CHART_COLOURS.timeout.bg,
                'rgba(200, 185, 140, 0.18)',
                CHART_COLOURS.timeout.border,
                'timeoutRate'
            ),
            ...makeDatasetPair(
                'Crash %',
                percentages.map((d) => d.crashRate),
                CHART_COLOURS.crash.bg,
                'rgba(190, 150, 150, 0.18)',
                CHART_COLOURS.crash.border,
                'crashRate'
            ),
        ];

        const options = commonChartOptions(
            '% failures',
            (context) => dailyTooltipLabel(context, rates),
            {
                stacked: true,
                tooltipFooter: (items) =>
                    `Passes: ${formatCount(rates[items[0]!.dataIndex]!.passes)}`,
            }
        );
        options['onHover'] = chartHover;
        options['onClick'] = chartClick;
        s.failureRateChart = new Chart(canvas, { type: 'bar', data: { labels, datasets }, options });
    }

    if (skipCanvas instanceof HTMLCanvasElement) {
        const skipDatasets = makeDatasetPair(
            'Skip %',
            percentages.map((d) => d.skipRate),
            CHART_COLOURS.skip.bg,
            'rgba(160, 160, 160, 0.15)',
            '#6c757d',
            'skipRate'
        );
        const skipOptions = commonChartOptions(
            '% skips',
            (context) => {
                if (context.dataset._isRemainder === true) {
                    return null;
                }
                const data = rates[context.dataIndex]!;
                if (data.skips === 0) {
                    return null;
                }
                const total =
                    data.passes + data.failures + data.timeouts + data.crashes + data.skips;
                return (
                    `${formatCount(data.skips)} ${data.skips === 1 ? 'skip' : 'skips'} out of ` +
                    `${formatCount(total)} scheduled runs (${context.parsed.y.toFixed(1)}%)`
                );
            },
            // The x-axis is drawn once, under whichever chart is lowest. When
            // both exist the failure chart above carries it.
            { stacked: true, hideXAxis: canvas instanceof HTMLCanvasElement }
        );
        skipOptions['onHover'] = chartHover;
        skipOptions['onClick'] = chartClick;
        s.skipRateChart = new Chart(skipCanvas, {
            type: 'bar',
            data: { labels, datasets: skipDatasets },
            options: skipOptions,
        });
    }

    wireChartArea(s);
}

/**
 * The failure/timeout/crash chart's tooltip line.
 *
 * One line per non-zero series, plus the selected cells' share of it when a
 * cell filter is on — which is what lets a reader see "12 failures that day, 9
 * of them on this config" without switching views.
 */
function dailyTooltipLabel(context: TooltipContext, rates: readonly DailyRate[]): string | null {
    if (context.dataset._isRemainder === true) {
        return null;
    }
    const data = rates[context.dataIndex];
    if (data === undefined) {
        return null;
    }
    const cellData = context.chart._cellDailyData?.[context.dataIndex];
    let count = 0;
    let typeName = '';
    let cellCount: number | undefined;
    if (context.dataset.label === 'Failure %') {
        count = data.failures;
        typeName = count === 1 ? 'failure' : 'failures';
        cellCount = cellData?.failures;
    } else if (context.dataset.label === 'Timeout %') {
        count = data.timeouts;
        typeName = count === 1 ? 'timeout' : 'timeouts';
        cellCount = cellData?.timeouts;
    } else if (context.dataset.label === 'Crash %') {
        count = data.crashes;
        typeName = count === 1 ? 'crash' : 'crashes';
        cellCount = cellData?.crashes;
    }
    if (count === 0) {
        return null;
    }
    const total = data.passes + data.failures + data.timeouts + data.crashes;
    const percentage = (total > 0 ? (count / total) * 100 : 0).toFixed(1);
    let line = `${formatCount(count)} ${typeName} out of ${formatCount(total)} runs (${percentage}%)`;
    if (cellCount !== undefined) {
        // Upstream's plural here is inverted — `cellCount !== count ? '' : 's'`
        // (`old/test.html:1318`) — so it says "job" when the counts differ and
        // "jobs" when they match. Reproduced: it is cosmetic, it is what the
        // page says today, and changing it silently would make the parity
        // comparison's remaining differences harder to trust.
        line += ` — ${formatCount(cellCount)} from selected job${cellCount !== count ? '' : 's'}`;
    }
    return line;
}

/**
 * Makes the whole chart section a hover and click target.
 *
 * `old/test.html:1370`. Chart.js only reports hits inside its plot area, so the
 * x-axis labels and the gap between the two charts would otherwise be dead
 * space that clears the selection as the pointer crosses it.
 */
function wireChartArea(s: PageState): void {
    const chartArea = document.getElementById('daily-chart-area');
    if (chartArea === null) {
        return;
    }
    const refChart = s.failureRateChart ?? s.skipRateChart;

    const dayFromEvent = (event: MouseEvent): number => {
        if (refChart === null) {
            return -1;
        }
        const xScale = refChart.scales['x'];
        if (xScale === undefined) {
            return -1;
        }
        const rect = refChart.canvas.getBoundingClientRect();
        // **The width of one day, not of one tick.** `xScale.ticks` holds the
        // *rendered* labels, and this axis sets `maxTicksLimit` with `autoSkip`
        // on, so a 21-day window draws about 11 of them: dividing by that made
        // a day "twice as wide" as it is, and a click past the middle of the
        // plot resolved to roughly half the intended index. The day count is
        // `rates.length`, which is what the axis is actually divided into.
        const columns = Math.max(1, refChart.data.labels.length);
        const dayWidth = xScale.width / columns;
        const dayIndex = Math.floor((event.clientX - rect.left - xScale.left) / dayWidth);
        return dayIndex >= 0 && dayIndex < columns ? dayIndex : -1;
    };

    /** True when Chart.js is already handling this event itself. */
    const insidePlotArea = (event: MouseEvent): boolean => {
        if (!(event.target instanceof HTMLCanvasElement)) {
            return false;
        }
        const chart =
            event.target === s.failureRateChart?.canvas
                ? s.failureRateChart
                : event.target === s.skipRateChart?.canvas
                  ? s.skipRateChart
                  : null;
        if (chart === null) {
            return false;
        }
        const rect = chart.canvas.getBoundingClientRect();
        const y = event.clientY - rect.top;
        return y >= chart.chartArea.top && y <= chart.chartArea.bottom;
    };

    chartArea.addEventListener('mousemove', (event) => {
        chartPointerInside = true;
        if (insidePlotArea(event)) {
            return;
        }
        const dayIndex = dayFromEvent(event);
        if (dayIndex >= 0 && s.hoveredDay !== dayIndex) {
            s.hoveredDay = dayIndex;
            updateSelection(s);
        }
    });
    chartArea.addEventListener('mouseleave', () => {
        chartPointerInside = false;
        if (s.hoveredDay !== null) {
            s.hoveredDay = null;
            updateSelection(s);
        }
    });
    chartArea.addEventListener('click', (event) => {
        if (insidePlotArea(event)) {
            return;
        }
        const dayIndex = dayFromEvent(event);
        if (dayIndex >= 0) {
            handleDayClick(s, dayIndex, event);
        }
    });
}

/**
 * The per-issue chart under an expanded issue.
 *
 * `calculateIssueMessageDailyRates` (`old/test.html:1441`) plus
 * `createIssueMessageChart` (`:1568`). The denominator is every run that day,
 * with skips included only when the issue itself is a skip — the same
 * scheduled-versus-happened distinction the main charts make.
 */
function drawIssueChart(s: PageState, issue: Issue): void {
    const canvas = document.getElementById(`${issue.id}-canvas`);
    if (!(canvas instanceof HTMLCanvasElement) || typeof Chart === 'undefined') {
        return;
    }
    Chart.getChart(canvas)?.destroy();

    const cells = activeCells(s);
    const hasCellFilter = cells.size > 0;
    const days = s.view.rates.length;
    const counts = new Array<number>(days).fill(0);
    const totals = new Array<number>(days).fill(0);

    for (const entry of s.file.runsOfTest(s.testId)) {
        if (entry.day === null || entry.day >= days) {
            continue;
        }
        const { kind } = classifyStatus(entry.status);
        if (kind === 'unknown') {
            continue;
        }
        // Skips are outside the denominator unless this issue is a skip.
        const inDenominator = issue.type === 'SKIP' || kind !== 'skip';
        const matches = issueMatchesEntryForRuns(
            entry.status,
            entry.message,
            entry.crashSignature,
            issue
        );
        if (!inDenominator && !matches) {
            continue;
        }

        if (!hasCellFilter) {
            if (inDenominator) {
                totals[entry.day]! += entry.count;
            }
            if (matches) {
                counts[entry.day]! += entry.count;
            }
            continue;
        }
        // With a cell filter, attribute per job rather than per entry.
        if (entry.jobName !== undefined) {
            const key = cellKey(
                displayVariantOf(s.mappings, entry.jobName),
                displayPlatformOf(s.mappings, entry.jobName)
            );
            if (cells.has(key)) {
                if (inDenominator) {
                    totals[entry.day]! += entry.count;
                }
                if (matches) {
                    counts[entry.day]! += entry.count;
                }
            }
            continue;
        }
        for (const taskIdIndex of entry.taskIdIndexes ?? []) {
            const jobName = s.file.jobNameOfTaskIndex(taskIdIndex);
            if (jobName === null) {
                continue;
            }
            const key = cellKey(
                displayVariantOf(s.mappings, jobName),
                displayPlatformOf(s.mappings, jobName)
            );
            if (!cells.has(key)) {
                continue;
            }
            if (inDenominator) {
                totals[entry.day]! += 1;
            }
            if (matches) {
                counts[entry.day]! += 1;
            }
        }
    }

    const colours = ISSUE_CHART_COLOURS[issue.type];
    const yAxisLabel =
        issue.type === 'FAIL'
            ? '% failures'
            : issue.type === 'TIMEOUT'
              ? '% timeouts'
              : issue.type === 'CRASH'
                ? '% crashes'
                : '% skips';

    new Chart(canvas, {
        type: 'bar',
        data: {
            labels: s.view.rates.map((d) => d.date),
            datasets: [
                {
                    label: 'Occurrence Rate',
                    data: counts.map((count, i) =>
                        totals[i]! > 0 ? (count / totals[i]!) * 100 : 0
                    ),
                    backgroundColor: colours.bg,
                    borderColor: colours.border,
                    borderWidth: 1,
                },
            ],
        },
        options: commonChartOptions(yAxisLabel, (context) => {
            const count = counts[context.dataIndex] ?? 0;
            if (count === 0) {
                return null;
            }
            const noun =
                issue.type === 'FAIL'
                    ? count === 1 ? 'failure' : 'failures'
                    : issue.type === 'TIMEOUT'
                      ? count === 1 ? 'timeout' : 'timeouts'
                      : issue.type === 'CRASH'
                        ? count === 1 ? 'crash' : 'crashes'
                        : count === 1 ? 'skip' : 'skips';
            return (
                `${formatCount(count)} ${noun} out of ` +
                `${formatCount(totals[context.dataIndex] ?? 0)} runs ` +
                `(${context.parsed.y.toFixed(1)}%)`
            );
        }),
    });
}

/** The Chart.js plugin that shades the hovered and clicked day columns. */
const DAY_COLUMN_HIGHLIGHT: ChartPlugin = {
    id: 'dayColumnHighlight',
    beforeDatasetsDraw(chart) {
        const hovered = chart._hoveredDay ?? null;
        const clicked = chart._clickedDays ?? null;
        if (hovered === null && clicked === null) {
            return;
        }
        const xScale = chart.scales['x'];
        if (xScale === undefined) {
            return;
        }
        const { ctx, chartArea } = chart;
        // One day's width, for the reason `dayFromEvent` records: the tick
        // count is the *labels drawn*, not the columns, so this band was about
        // twice as wide as the day it marked and spilled over its neighbours.
        const columns = Math.max(1, chart.data.labels.length);
        const barWidth = xScale.width / columns;
        ctx.save();
        if (clicked !== null) {
            ctx.fillStyle = '#d0e4fd';
            for (const dayIdx of clicked) {
                const x = xScale.getPixelForValue(dayIdx);
                ctx.fillRect(x - barWidth / 2, chartArea.top, barWidth, chartArea.bottom - chartArea.top);
            }
        }
        // A hovered day that is also clicked keeps the clicked colour.
        if (hovered !== null && (clicked === null || !clicked.has(hovered))) {
            ctx.fillStyle = '#e8f0fe';
            const x = xScale.getPixelForValue(hovered);
            ctx.fillRect(x - barWidth / 2, chartArea.top, barWidth, chartArea.bottom - chartArea.top);
        }
        ctx.restore();
    },
};

// --- selection updates ---------------------------------------------------

/** Everything a selection change touches. */
function updateSelection(s: PageState): void {
    updateChartHighlight(s);
    updateTableHighlight(s);
    updateIssueListFilter(s);
    updateRuntimeForSelection(s);
}

/**
 * The charts' response to the current selection.
 *
 * `updateChartHighlight` (`old/test.html:2168`). Hovering an *issue* overrides a
 * cell filter, and it only drives the chart the issue's type belongs to — a
 * SKIP issue redraws the skip chart and leaves the failure chart alone, because
 * a skip contributes to neither of the failure chart's series.
 */
function updateChartHighlight(s: PageState): void {
    if (s.hoveredIssueIndex !== null) {
        const issue = s.view.issues[s.hoveredIssueIndex];
        if (issue !== undefined) {
            const rates = issueFilteredRates(s, s.hoveredIssueIndex, issue);
            const isSkip = issue.type === 'SKIP';
            applyChartHighlight(s, s.failureRateChart, true, isSkip ? null : rates);
            applyChartHighlight(s, s.skipRateChart, true, isSkip ? rates : null);
            return;
        }
    }

    const cells = activeCells(s);
    const { hasIssues, hasSkips } = cells.size > 0
        ? activeCellIssueTypes(s, cells)
        : { hasIssues: false, hasSkips: false };

    // A chart whose series the selected cells never contribute to is left
    // unfiltered: dimming every bar to zero would say the cells had no skips,
    // when the truth is that skips are not what this chart is about.
    applyChartHighlight(s, s.failureRateChart, cells.size > 0 && !hasIssues, undefined);
    applyChartHighlight(s, s.skipRateChart, cells.size > 0 && !hasSkips, undefined);
}

/** Whether the selected cells have any issues, and any skips, on any day. */
function activeCellIssueTypes(
    s: PageState,
    cells: ReadonlySet<string>
): { hasIssues: boolean; hasSkips: boolean } {
    let hasIssues = false;
    let hasSkips = false;
    for (const dayData of s.matrix) {
        for (const key of cells) {
            const cd = dayData.get(key);
            if (cd === undefined) {
                continue;
            }
            if (cd.failures > 0 || cd.crashes > 0 || cd.timeouts > 0) {
                hasIssues = true;
            }
            if (cd.skips > 0) {
                hasSkips = true;
            }
            if (hasIssues && hasSkips) {
                return { hasIssues, hasSkips };
            }
        }
    }
    return { hasIssues, hasSkips };
}

/** Per-day rates for one issue, against the overall denominators. */
function issueFilteredRates(s: PageState, index: number, issue: Issue): RateRow[] {
    const attribution = s.attribution[index];
    return s.view.rates.map((overall, day) => {
        const count = attribution?.byDay.get(day) ?? 0;
        const totalNonSkip = overall.passes + overall.failures + overall.timeouts + overall.crashes;
        const totalWithSkips = totalNonSkip + overall.skips;
        return {
            failureRate:
                issue.type === 'FAIL' && totalNonSkip > 0 ? (count / totalNonSkip) * 100 : 0,
            timeoutRate:
                issue.type === 'TIMEOUT' && totalNonSkip > 0 ? (count / totalNonSkip) * 100 : 0,
            crashRate:
                issue.type === 'CRASH' && totalNonSkip > 0 ? (count / totalNonSkip) * 100 : 0,
            skipRate:
                issue.type === 'SKIP' && totalWithSkips > 0 ? (count / totalWithSkips) * 100 : 0,
        };
    });
}

/** Per-day rates for the selected cells, against the overall denominators. */
function cellFilteredRates(s: PageState, cells: ReadonlySet<string>): RateRow[] {
    return s.view.rates.map((overall, day) => {
        let failures = 0;
        let timeouts = 0;
        let crashes = 0;
        let skips = 0;
        const dayData = s.matrix[day];
        if (dayData !== undefined) {
            for (const key of cells) {
                const cd = dayData.get(key);
                if (cd !== undefined) {
                    failures += cd.failures;
                    timeouts += cd.timeouts;
                    crashes += cd.crashes;
                    skips += cd.skips;
                }
            }
        }
        // The **overall** denominator, so the bright bar reads as this
        // selection's share of the whole day rather than as its own rate.
        const totalNonSkip = overall.passes + overall.failures + overall.timeouts + overall.crashes;
        const totalWithSkips = totalNonSkip + overall.skips;
        return {
            failureRate: totalNonSkip > 0 ? (failures / totalNonSkip) * 100 : 0,
            timeoutRate: totalNonSkip > 0 ? (timeouts / totalNonSkip) * 100 : 0,
            crashRate: totalNonSkip > 0 ? (crashes / totalNonSkip) * 100 : 0,
            skipRate: totalWithSkips > 0 ? (skips / totalWithSkips) * 100 : 0,
        };
    });
}

/**
 * Applies a filter to one chart, or clears it.
 *
 * `updateSingleChartHighlight` (`old/test.html:2089`). The cache key is not an
 * optimization detail — `chart.update()` on every mouse move over a 21-bar
 * chart is what makes hovering feel heavy, and Chart.js's own `onHover` fires
 * again from inside `update()`, so without the guard a redraw can retrigger
 * itself.
 */
function applyChartHighlight(
    s: PageState,
    chart: ChartInstance | null,
    skipCellFilter: boolean,
    overrideRates: RateRow[] | null | undefined
): void {
    if (chart === null) {
        return;
    }
    const cells = activeCells(s);
    const days = activeDays(s);
    const hasCellFilter = cells.size > 0 && !skipCellFilter;
    const hasOverride = overrideRates !== undefined && overrideRates !== null;

    const cellKeyPart = hasOverride
        ? `issue${s.hoveredIssueIndex}`
        : hasCellFilter
          ? [...cells].sort().join(',')
          : '';
    const dayKeyPart =
        days.size > 0 ? `${s.hoveredDay}|${[...s.clickedDays].join(',')}` : '';
    const cacheKey = `${cellKeyPart}/${dayKeyPart}`;
    if (chart._lastHighlightKey === cacheKey) {
        return;
    }
    chart._lastHighlightKey = cacheKey;

    if (hasOverride || hasCellFilter) {
        const filtered = hasOverride ? overrideRates : cellFilteredRates(s, cells);
        if (filtered !== null) {
            for (const dataset of chart.data.datasets) {
                const orig = dataset._origData;
                const field = dataset._rateField;
                if (orig === undefined || field === undefined) {
                    continue;
                }
                dataset.data = dataset._isRemainder === true
                    ? orig.map((value, i) => Math.max(0, value - (filtered[i]?.[field] ?? 0)))
                    : filtered.map((row) => row[field]);
            }
        }
        // The raw per-day counts behind the tooltip's "N from selected jobs".
        // Not set for an issue hover: the tooltip would then describe a
        // selection the user did not make.
        chart._cellDailyData = hasOverride
            ? null
            : s.matrix.map((dayData) => {
                  const totals: Outcomes = {
                      passes: 0,
                      failures: 0,
                      timeouts: 0,
                      crashes: 0,
                      skips: 0,
                  };
                  for (const key of cells) {
                      const cd = dayData.get(key);
                      if (cd !== undefined) {
                          totals.failures += cd.failures;
                          totals.timeouts += cd.timeouts;
                          totals.crashes += cd.crashes;
                          totals.skips += cd.skips;
                      }
                  }
                  return totals;
              });
    } else {
        for (const dataset of chart.data.datasets) {
            const orig = dataset._origData;
            if (orig === undefined) {
                continue;
            }
            dataset.data = dataset._isRemainder === true
                ? new Array<number>(orig.length).fill(0)
                : [...orig];
        }
        chart._cellDailyData = null;
    }

    chart._hoveredDay = s.hoveredDay;
    chart._clickedDays = s.clickedDays.size > 0 ? s.clickedDays : null;
    chart.update('none');
}

/**
 * The job table's response to the current selection.
 *
 * `updateTableHighlight` (`old/test.html:2190`). Two independent things happen: the
 * clicked cells get a background, and — if any *day* is selected — every cell's
 * badges are recomputed over just those days.
 *
 * Restoring is where this differs from upstream, which re-assigns a snapshot of
 * each cell's `innerHTML` (divergence 2). Here the badges are elements the
 * renderer kept, so restoring sets their text and visibility back.
 */
function updateTableHighlight(s: PageState): void {
    const days = activeDays(s);
    const hasDayFilter = days.size > 0;

    for (const rendered of s.cells) {
        rendered.td.classList.toggle('cell-selected', s.clickedCells.has(rendered.cell.key));

        if (hasDayFilter) {
            rendered.dayFiltered = true;
            const filtered = filteredCell(rendered.cell, s.matrix, days);

            if (rendered.naLayer !== null) {
                rendered.naLayer.style.display = filtered.noData ? '' : 'none';
            }
            if (rendered.prefixLayer !== null) {
                const show = filtered.allIssuesHidden && filtered.outcomes.passes > 0 && !filtered.noData;
                rendered.prefixLayer.style.display = show ? '' : 'none';
                if (show) {
                    const passes = filtered.outcomes.passes;
                    rendered.prefixLayer.title = `${passes} run${passes !== 1 ? 's' : ''}`;
                }
            }
            if (rendered.badgesLayer !== null) {
                rendered.badgesLayer.style.visibility = filtered.badgesHidden ? 'hidden' : '';
            }
            for (const [kind, badge] of rendered.badges) {
                const target = filtered.badges.get(kind);
                if (target === undefined) {
                    continue;
                }
                badge.element.style.visibility = target.visible ? '' : 'hidden';
                if (!target.visible) {
                    continue;
                }
                badge.element.title = target.tooltip;
                if (target.percentText !== null && badge.percent !== null) {
                    badge.percent.textContent = target.percentText;
                }
            }
            rendered.td.classList.toggle('no-hover', filtered.noHover);
        } else if (rendered.dayFiltered) {
            rendered.dayFiltered = false;
            restoreCell(rendered);
        }
    }
}

/** Puts a cell back to its unfiltered state. */
function restoreCell(rendered: RenderedCell): void {
    if (rendered.naLayer !== null) {
        rendered.naLayer.style.display = 'none';
    }
    if (rendered.prefixLayer !== null) {
        rendered.prefixLayer.style.display = 'none';
    }
    if (rendered.badgesLayer !== null) {
        rendered.badgesLayer.style.visibility = '';
    }
    for (const badge of rendered.cell.badges) {
        const target = rendered.badges.get(badge.kind);
        if (target === undefined) {
            continue;
        }
        target.element.style.visibility = '';
        target.element.title = badge.tooltip;
        if (badge.percentText !== null && target.percent !== null) {
            target.percent.textContent = badge.percentText;
        }
    }
    rendered.td.classList.toggle('no-hover', rendered.cell.noHover);
}

/**
 * The issue list's response to the current selection.
 *
 * `updateIssueListFilter` (`old/test.html:2273`). An expanded issue's runs and
 * chart are rebuilt so they keep matching the filter — expanding an issue and
 * then selecting a day should narrow the list already on screen, not leave a
 * stale one under a filtered count.
 */
function updateIssueListFilter(s: PageState): void {
    const selection = currentSelection(s);
    const filtered = filterIssues(s.view.issues, s.attribution, selection);

    let visibleCount = 0;
    for (const [index, rendered] of s.issueRows.entries()) {
        const result = filtered[index];
        if (result === undefined) {
            continue;
        }
        rendered.item.classList.toggle('issue-hidden', !result.visible);
        rendered.countSpan.textContent = String(result.count);
        if (result.visible) {
            visibleCount++;
        }
        if (rendered.chart !== null) {
            rendered.chart.classList.toggle('issue-hidden', !result.visible);
        }
        if (rendered.runs !== null) {
            rendered.runs.classList.toggle('issue-hidden', !result.visible);
            if (result.visible && rendered.runs.style.display !== 'none') {
                renderIssueRuns(s, rendered.issue, rendered.runs);
                if (rendered.chart !== null && rendered.chart.style.display !== 'none') {
                    drawIssueChart(s, rendered.issue);
                }
            }
        }
    }

    const notice = document.getElementById('issue-filter-notice');
    if (notice === null) {
        return;
    }
    const text = issueFilterNotice(visibleCount, s.issueRows.length, selection, s.view.rates);
    if (text === null) {
        notice.style.display = 'none';
    } else {
        notice.style.display = '';
        notice.textContent = text;
    }
}

/**
 * The runtime panel's response to a cell selection.
 *
 * `updateRuntimeForSelection` (`old/test.html:2401`). Days are deliberately not a
 * filter here: durations are recorded per pass entry and the panel's question
 * is "how long does this take on this config", which a three-day slice answers
 * with too few samples to be worth a percentile. Upstream makes the same
 * choice — `activeCells` only.
 *
 * A selection whose cells have **no** durations leaves the panel showing what
 * it showed before, rather than emptying: upstream's `if (combined.length > 0)`
 * guard (`old/test.html:2423`). Preserved, though it does mean the panel can
 * describe a different selection than the one highlighted.
 */
function updateRuntimeForSelection(s: PageState): void {
    const panel = document.getElementById('runtime-panel-content');
    if (panel === null) {
        return;
    }
    const cells = activeCells(s);
    const key = cells.size === 0 ? 'overall' : [...cells].sort().join(',');
    if (key === s.lastRuntimeKey) {
        return;
    }
    s.lastRuntimeKey = key;

    if (cells.size === 0) {
        if (s.durations.all.length > 0) {
            fillRuntimePanel(
                panel,
                buildRuntimePanel('Overall', s.durations.all, {
                    overallRange: s.overallRange,
                    overallBins: s.overallBins,
                })
            );
        }
        return;
    }

    const combined: number[] = [];
    for (const cellId of cells) {
        const list = s.durations.byCell.get(cellId);
        if (list !== undefined) {
            combined.push(...list);
        }
    }
    if (combined.length === 0) {
        return;
    }
    fillRuntimePanel(
        panel,
        buildRuntimePanel(runtimeTitleFor(cells), combined, {
            overallRange: s.overallRange,
            overallBins: s.overallBins,
        })
    );
}

// --- the search form -----------------------------------------------------

/**
 * The union of every test path in both harnesses' 21-day aggregates.
 *
 * `loadAllTestPaths` (`old/test.html:2814`). Both files, because the autocomplete
 * should find a test whichever harness runs it — and because `detectHarness`
 * cannot be trusted to have guessed right, which is the same reason the loader
 * has a fallback.
 */
async function loadAllTestPaths(): Promise<string[]> {
    const files = await Promise.all(
        ['xpcshell-issues.json', 'mochitest-issues.json'].map((name) =>
            fetchData(name).then((r) => (r.ok ? (r.json() as Promise<TestPathsSource>) : null))
        )
    );
    return collectTestPaths(files);
}

/**
 * The search form, which is what the page becomes with no `?test=`.
 *
 * `showSearchForm` (`old/test.html:2833`). A framing property the audit calls out:
 * this page has no default listing, because there is no useful ranking of
 * 100,000 tests — the page's whole job is one test at a time, so with no test
 * named it asks for one.
 *
 * Reached three ways: no `?test=` at all, a `?test=` that matches nothing but
 * where the test list did load, and a `?test=` that matched several tests.
 */
function showSearchForm(options: { initialValue?: string; preloadedTests?: string[] } = {}): void {
    const initialValue = options.initialValue ?? '';
    const preloaded = options.preloadedTests ?? null;
    const contentEl = requireElement('content');

    const input = el('input', {
        id: 'test-input',
        attrs: {
            name: 'test',
            type: 'text',
            autocomplete: 'off',
            placeholder: 'e.g. browser/components/.../browser_foo.js',
            style:
                'width: 100%; padding: 8px 10px; font-family: monospace; font-size: 13px; ' +
                'border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;',
        },
    });
    input.value = initialValue;

    const dropdown = el('div', {
        id: 'ac-dropdown',
        attrs: {
            style:
                'display: none; position: absolute; top: 100%; left: 0; right: 0; ' +
                'max-height: 300px; overflow-y: auto; background: white; border: 1px solid #ccc; ' +
                'border-top: none; border-radius: 0 0 4px 4px; z-index: 10; ' +
                'box-shadow: 0 4px 8px rgba(0,0,0,0.1);',
        },
    });

    const status = el('div', {
        id: 'test-list-status',
        text: preloaded === null ? 'Loading test list...' : '',
        attrs: { style: 'margin-top: 6px; font-size: 12px; color: #888;' },
    });

    const form = el('form', {
        id: 'test-form',
        attrs: { action: 'test.html', method: 'get', style: 'margin-top: 12px;' },
        children: [
            el('label', {
                text: 'Enter test path:',
                attrs: { for: 'test-input', style: 'font-size: 14px; color: #555;' },
            }),
            el('div', {
                attrs: {
                    style: 'position: relative; display: flex; gap: 8px; margin-top: 6px;',
                },
                children: [
                    el('div', {
                        attrs: { style: 'flex: 1; position: relative;' },
                        children: [input, dropdown],
                    }),
                    el('button', {
                        text: 'Go',
                        attrs: {
                            type: 'submit',
                            style:
                                'padding: 8px 16px; background: #007bff; color: white; ' +
                                'border: none; border-radius: 4px; cursor: pointer; font-size: 13px;',
                        },
                    }),
                ],
            }),
        ],
    });

    contentEl.replaceChildren(
        el('div', {
            class: 'test-header',
            children: [el('h1', { text: 'Test Info' }), form, status],
        })
    );
    contentEl.style.display = 'block';
    input.focus();
    if (initialValue !== '') {
        input.select();
    }

    let allTests: string[] = preloaded ?? [];
    let selectedIdx = -1;

    /**
     * Navigates through `withDevParams` rather than letting the form submit.
     * A plain GET form would drop `?data-source=`, which is the whole reason
     * the submit handler exists.
     */
    const navigate = (path: string): void => {
        window.location.href = withDevParams(`test.html?test=${encodeURIComponent(path)}`);
    };

    const items = (): HTMLElement[] => [...dropdown.querySelectorAll<HTMLElement>('.ac-item')];

    const updateHighlight = (): void => {
        const list = items();
        list.forEach((element, i) => {
            element.style.background = i === selectedIdx ? '#007bff' : '';
            element.style.color = i === selectedIdx ? 'white' : '';
        });
        if (selectedIdx >= 0) {
            list[selectedIdx]?.scrollIntoView({ block: 'nearest' });
        }
    };

    /**
     * Bolds every occurrence of every search term.
     *
     * Upstream builds this as escaped HTML; here the runs are text nodes and
     * `<b>` elements, which needs no escaping at all. A bitmap of which
     * characters are inside a match is what allows overlapping terms to merge
     * into one bold run rather than producing nested tags.
     */
    const highlighted = (text: string, terms: string[]): Node[] => {
        const bold = new Uint8Array(text.length);
        const lower = text.toLowerCase();
        for (const term of terms) {
            let pos = lower.indexOf(term);
            while (pos !== -1) {
                for (let i = pos; i < pos + term.length; i++) {
                    bold[i] = 1;
                }
                pos = lower.indexOf(term, pos + 1);
            }
        }
        const nodes: Node[] = [];
        let start = 0;
        while (start < text.length) {
            const isBold = bold[start] === 1;
            let end = start;
            while (end < text.length && (bold[end] === 1) === isBold) {
                end++;
            }
            const run = text.slice(start, end);
            nodes.push(isBold ? el('b', { text: run }) : document.createTextNode(run));
            start = end;
        }
        return nodes;
    };

    const showMatches = (): void => {
        const query = input.value.toLowerCase();
        if (query === '' || allTests.length === 0) {
            dropdown.style.display = 'none';
            selectedIdx = -1;
            return;
        }
        // Every whitespace-separated term must appear somewhere in the path, in
        // any order — so `cookies async` finds `test_cookies_async_failure.js`.
        const terms = searchTerms(query);
        const { matches } = matchTestPaths(allTests, query, CANDIDATE_LIMIT);
        if (matches.length === 0) {
            dropdown.style.display = 'none';
            selectedIdx = -1;
            return;
        }
        selectedIdx = -1;
        dropdown.replaceChildren(
            ...matches.map((match, i) => {
                const item = el('div', {
                    class: 'ac-item',
                    attrs: {
                        style:
                            'padding: 6px 10px; font-family: monospace; font-size: 12px; ' +
                            'cursor: pointer; white-space: nowrap; overflow: hidden; ' +
                            'text-overflow: ellipsis;',
                    },
                    children: highlighted(match, terms),
                });
                item.dataset['idx'] = String(i);
                return item;
            })
        );
        dropdown.style.display = 'block';
    };

    input.addEventListener('input', showMatches);
    input.addEventListener('keydown', (event) => {
        const list = items();
        if (list.length === 0 || dropdown.style.display === 'none') {
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            selectedIdx = Math.min(selectedIdx + 1, list.length - 1);
            updateHighlight();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            selectedIdx = Math.max(selectedIdx - 1, 0);
            updateHighlight();
        } else if (event.key === 'Enter' && selectedIdx >= 0) {
            event.preventDefault();
            navigate(list[selectedIdx]!.textContent ?? '');
        } else if (event.key === 'Enter' && list.length === 1) {
            // One match and nothing highlighted: Enter takes it anyway, which
            // is what makes typing a full path and pressing Enter work.
            event.preventDefault();
            navigate(list[0]!.textContent ?? '');
        } else if (event.key === 'Escape') {
            dropdown.style.display = 'none';
            selectedIdx = -1;
        }
    });

    dropdown.addEventListener('mousedown', (event) => {
        const item = (event.target as HTMLElement | null)?.closest('.ac-item');
        if (item !== null && item !== undefined) {
            // `mousedown` rather than `click`, and prevented, so the input's
            // blur handler does not hide the dropdown before the click lands.
            event.preventDefault();
            navigate(item.textContent ?? '');
        }
    });
    dropdown.addEventListener('mouseover', (event) => {
        const item = (event.target as HTMLElement | null)?.closest<HTMLElement>('.ac-item');
        if (item !== null && item !== undefined) {
            selectedIdx = Number(item.dataset['idx']);
            updateHighlight();
        }
    });

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (input.value !== '') {
            navigate(input.value);
        }
    });

    input.addEventListener('blur', () => {
        // The delay is what lets a click on a dropdown item register first.
        setTimeout(() => {
            dropdown.style.display = 'none';
        }, 150);
    });
    input.addEventListener('focus', () => {
        if (input.value !== '') {
            showMatches();
        }
    });

    const announce = (): void => {
        status.textContent = `${allTests.length.toLocaleString()} tests available for autocomplete`;
    };

    if (preloaded !== null) {
        announce();
        if (input.value !== '') {
            showMatches();
        }
        return;
    }
    loadAllTestPaths()
        .then((tests) => {
            allTests = tests;
            announce();
            if (input.value !== '') {
                showMatches();
            }
        })
        .catch(() => {
            status.textContent = 'Could not load test list for autocomplete.';
        });
}

// --- loading -------------------------------------------------------------

/**
 * The page's whole flow.
 *
 * `loadTestData` (`old/test.html:3005`). The sequence, and why each step is where
 * it is:
 *
 * 1. **No `?test=`** → the search form. There is no default listing.
 * 2. **Header first, data second.** The name, path and harness badge come from
 *    the URL alone, so they are drawn before the ~3 MB fetch starts. Upstream
 *    does this and it matters: the fetch is the slow part.
 * 3. **The bucket file**, chosen by hashing the path into 64 buckets.
 * 4. **The other harness, same bucket index**, if the test was not in the
 *    first. This is what covers `detectHarness`'s `test_*.js` hole, and it is
 *    why the harness badge can end up saying something the caller did not ask
 *    for.
 * 5. **A unique substring match** → redirect to it. A path typed into the URL
 *    bar is often a fragment, and one match is not ambiguous.
 * 6. **Otherwise the search form**, seeded with what was typed.
 *
 * Steps 3-5 are `resolveTest` in `lib/query/test-lookup.ts`.
 */
async function loadTestData(): Promise<void> {
    const testPath = new URLSearchParams(window.location.search).get('test');
    if (testPath === null || testPath === '') {
        showSearchForm();
        return;
    }

    const harness = detectHarness(testPath);
    const testName = testPath.split('/').pop() ?? testPath;
    document.title = `${testName} - Test Info`;

    // The header, drawn from the URL before anything is fetched.
    const contentEl = requireElement('content');
    const componentValue = el('span', { id: 'component-value', text: '...' });
    const statusLine = el('div', {
        class: 'status-line',
        id: 'status-line',
        text: `Loading ${harness} data...`,
    });
    contentEl.replaceChildren(
        renderHeader(testPath, harness, componentValue),
        statusLine,
        // Non-breaking spaces, so the six boxes have their final height before
        // the numbers arrive and the page does not jump when they do.
        renderSummary(
            ['Runs', 'Pass %', 'Failures', 'Timeouts', 'Crashes', 'Skips'].map((label) => ({
                label,
                value: ' ',
                cssClass: '',
            }))
        )
    );
    contentEl.style.display = 'block';

    try {
        const resolution = await resolveTest<BucketFile>(testPath, undefined, {
            async loadBucket(bucketHarness, path) {
                const chunkHex = bucketFileSuffix(bucketIndexForPath(path));
                const response = await fetchData(`${bucketHarness}-${chunkHex}.json`);
                if (!response.ok) {
                    return null;
                }
                const raw = (await response.json()) as BucketFile;
                return { raw, decoded: decodeBucket(raw) };
            },
            loadAllTestPaths,
            onStep: (message) => {
                statusLine.textContent = message;
            },
        });

        if (resolution.kind === 'found') {
            if (resolution.resolvedFrom !== null) {
                // `replace`, not `assign`: the fragment the user typed is not a
                // page worth having in the back stack. `resolvedFrom` is null
                // when the match is what is already in the URL, which is what
                // stops this redirecting to the page it is on.
                window.location.replace(
                    withDevParams(`test.html?test=${encodeURIComponent(resolution.testPath)}`)
                );
                return;
            }
            render(
                resolution.file.raw,
                resolution.file.decoded,
                resolution.identity.testId,
                resolution.testPath,
                resolution.identity.component,
                resolution.harness
            );
            return;
        }

        if (resolution.allTests !== null) {
            document.title = 'Test Info';
            showSearchForm({ initialValue: testPath, preloadedTests: resolution.allTests });
            return;
        }
        statusLine.textContent =
            `Test not found: ${testPath}. It may not have been run in the last 21 days, ` +
            'or the path may be incorrect.';
        statusLine.style.color = '#dc3545';
    } catch (error) {
        console.error('Error loading test data:', error);
        const message = error instanceof Error ? error.message : String(error);
        statusLine.textContent = `Error loading data: ${message}`;
        statusLine.style.color = '#dc3545';
    }
}

/**
 * Draws the whole page for a test that was found.
 *
 * The section order is upstream's (`old/test.html:2452`): header, status line,
 * summary, Daily Issue Rates, the job table and runtime panel side by side,
 * Issue Details.
 */
function render(
    raw: BucketFile,
    file: DecodedTimingFile,
    testId: number,
    testPath: string,
    component: string | null,
    harness: string
): void {
    const stats = computeTestStats(file, testId);
    const view = buildTestView(file, {
        testId,
        testPath,
        component,
        harness,
        stats,
        metadata: {
            days: raw.metadata.days,
            startTime: raw.metadata.startTime,
            startDate: raw.metadata.startDate,
            endDate: raw.metadata.endDate,
        },
    });

    const durations = collectDurations(file, testId, view.mappings);
    let overallRange: { min: number; max: number } | null = null;
    let overallBins: number[] | null = null;
    if (durations.all.length > 0) {
        let min = Infinity;
        let max = -Infinity;
        for (const d of durations.all) {
            if (d < min) {
                min = d;
            }
            if (d > max) {
                max = d;
            }
        }
        overallRange = { min, max };
        overallBins = computeHistogramBins(durations.all, 20, min, max);
    }

    const s: PageState = {
        raw,
        file,
        testId,
        testPath,
        view,
        mappings: view.mappings,
        matrix: buildDayCellMatrix(file, testId, view.mappings, { days: view.rates.length }),
        attribution: buildIssueAttribution(file, testId, view.issues, view.mappings, {
            days: view.rates.length,
        }),
        cells: [],
        durations,
        overallRange,
        overallBins,
        hoveredCell: null,
        hoveredDay: null,
        hoveredIssueIndex: null,
        clickedCells: new Set(),
        clickedDays: new Set(),
        shiftAnchorDay: null,
        failureRateChart: null,
        skipRateChart: null,
        issueRows: [],
        lastRuntimeKey: 'overall',
    };
    state = s;

    setFavicon(view.healthy ? '#4caf50' : '#ff9500');

    const contentEl = requireElement('content');
    contentEl.replaceChildren();
    contentEl.append(renderHeader(testPath, harness, component));
    if (view.dateRangeText !== '') {
        contentEl.append(el('div', { class: 'status-line', text: view.dateRangeText }));
    }
    contentEl.append(renderSummary(view.summary));

    // The chart section exists only when there is something to plot, and each
    // canvas only when its own series is non-empty.
    if (view.charts.hasIssues || view.charts.hasSkips) {
        const area = el('div', { class: 'historical-chart', id: 'daily-chart-area' });
        if (view.charts.hasIssues) {
            area.append(
                el('div', {
                    class: 'chart-wrap',
                    children: [el('canvas', { id: 'daily-rate-canvas' })],
                })
            );
        }
        if (view.charts.hasSkips) {
            area.append(
                el('div', {
                    // The skip chart drops its own x-axis when the failure
                    // chart above already draws one.
                    class: `chart-wrap skips${view.charts.hasIssues ? ' no-x-axis' : ''}`,
                    children: [el('canvas', { id: 'daily-skips-canvas' })],
                })
            );
        }
        contentEl.append(
            el('div', {
                class: 'section',
                children: [el('h2', { text: 'Daily Issue Rates' }), area],
            })
        );
    }

    // The job table and the runtime panel, inside the `#runtime-sections`
    // wrapper. The wrapper is emitted unconditionally and even when empty,
    // matching upstream (`old/test.html:2499`), which reserves it in `renderPage`
    // and fills it afterwards. Keeping it is not cosmetic: it is a stable
    // anchor a bookmark or a future selector can reach, and its absence was
    // the first structural difference the browser diff reported.
    const runtimeSections = el('div', { id: 'runtime-sections' });
    const jobTable = renderJobTable(s);
    if (jobTable !== null) {
        if (durations.all.length > 0) {
            runtimeSections.append(
                el('div', {
                    class: 'runtime-layout',
                    children: [
                        jobTable,
                        renderRuntimePanel(
                            buildRuntimePanel('Overall', durations.all, {
                                overallRange,
                                overallBins,
                            })
                        ),
                    ],
                })
            );
        } else {
            runtimeSections.append(jobTable);
        }
    }
    contentEl.append(runtimeSections);

    const issueDetails = renderIssueDetails(s);
    if (issueDetails !== null) {
        contentEl.append(issueDetails);
    }

    // Lock the `.badge-pct` width to the widest value it can hold, so the
    // badges do not resize as a day filter changes their percentages. Measured
    // rather than guessed, because the font is the platform's.
    //
    // These two forced layouts — this `offsetWidth` and the `offsetHeight`
    // below — were the suspects in an investigation into chart click/hover
    // being intermittently dead on first load, on the theory that they run
    // just before Chart.js binds and could race it. **They do not, and the
    // ordering is not close.** Instrumented over 10 fresh-profile loads
    // (`artifacts/defects/`), the last forced layout completes at 129-183ms
    // and the `Chart` global does not even exist until 190-244ms — a gap of
    // 58-64ms every time, because Chart.js is fetched from a CDN by
    // `loadChartJs` below and cannot bind before it arrives.
    //
    // So there is nothing to reorder here, and a `try.html` copying this
    // structure does not need to. What the investigation did find was a bug in
    // the *measuring harness*: the canvas is 300x150 until Chart.js resizes it
    // to its container, so a pointer target computed from the element box
    // before that lands below the plot area and Chart.js correctly ignores it.
    // Re-measure the target after `Chart.getChart()` returns an instance.
    const measure = el('span', {
        class: 'badge-pct',
        text: '100.0%',
        attrs: {
            style:
                'position:absolute;visibility:hidden;font-size:10px;font-weight:bold;' +
                'font-variant-numeric:tabular-nums;display:inline-block;text-align:right;',
        },
    });
    document.body.append(measure);
    const pctMinWidth = `${measure.offsetWidth}px`;
    measure.remove();
    for (const rendered of s.cells) {
        for (const badge of rendered.badges.values()) {
            if (badge.percent !== null) {
                badge.percent.style.minWidth = pctMinWidth;
            }
        }
    }

    // Freeze the issue section's height so filtering it does not move the page
    // under the pointer that is doing the filtering.
    if (issueDetails !== null) {
        issueDetails.style.minHeight = `${issueDetails.offsetHeight}px`;
    }

    if (view.charts.hasIssues || view.charts.hasSkips) {
        loadChartJs(() => {
            Chart.register(DAY_COLUMN_HIGHLIGHT);
            createDailyCharts(s);
        });
    }
}

/**
 * Loads Chart.js from the CDN, then runs `onReady`.
 *
 * Deferred rather than in the page head, because a test with no issues and no
 * skips draws no chart and should not pay for a 200 kB library to find that
 * out.
 */
function loadChartJs(onReady: () => void): void {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
    script.async = true;
    script.addEventListener('load', onReady);
    document.head.append(script);
}

/**
 * Exposed for the parity harness, per `PARITY.md` §2.
 *
 * The view model *is* the seam, so this is a property rather than a retrofit:
 * the old page had to be interrogated through the DOM, and this one can be
 * asked what it decided.
 */
declare global {
    interface Window {
        __testView?: TestView;
        __testState?: () => PageState | null;
    }
}
window.__testState = () => state;

void loadTestData().then(() => {
    if (state !== null) {
        window.__testView = state.view;
    }
});
