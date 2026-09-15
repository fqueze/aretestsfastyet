/**
 * `index.html`, migrated onto `lib/` — the site's landing page.
 *
 * | file | contains | tested by |
 * | --- | --- | --- |
 * | `lib/formats/stats.ts` | the file format, shared with the CLI | `test/formats.test.ts` |
 * | `lib/query/summary.ts` | the CLI's 7-day topline over the same file | `test/query.test.ts` |
 * | `site/index-view.ts` | this page's windows, merge, rows and traces | `test/index-view.test.ts`, no DOM |
 * | this file | the renderer, the lazy charts and the interactions | `test/index-page.test.ts` + the browser run |
 * | — | the page against `fx-tests summary` | `test/index-parity.test.ts` |
 *
 * ## `lib/query/summary.ts` is imported, and it does **not** drive the table
 *
 * The brief's instruction was to use it, and this file does — but not where a
 * reader would first expect, so the judgement is stated here rather than left
 * to be inferred from the imports.
 *
 * `computeSummary` computes a 7-day window with a prior-period comparison. The
 * page's table is also 7 days, and **two of its four rates are computed
 * differently** (divergences 1 and 2 below), so rendering the table from
 * `computeSummary` would change two of the eight numbers a visitor sees on the
 * landing page. That is a product decision, not a migration's to make, so the
 * table keeps the page's arithmetic in `site/index-view.ts` and
 * `test/index-parity.test.ts` asserts the two differences — and asserts the
 * other two rates agree exactly, so a future drift in *those* is a failure.
 *
 * Where `computeSummary` **is** used is the thing the page was missing: the
 * prior-period comparison. The file has 199 dates of history and the table
 * showed one week of it with nothing to compare against. Each harness row now
 * carries the change against the prior 7 days, from the shared query, as a
 * `title` tooltip — see divergence 6, which is the one deliberate product
 * change on this list.
 *
 * ## The three time windows are now labelled on the page
 *
 * The single most confusing property of the original, and it was invisible: the
 * summary table is 7 days (`old/index.html:524`), the four charts are the *entire*
 * file unsliced (`:632-640`, `:649-668`, `:677-686`, `:695-723`), and the
 * summary's own links go to a 21-day view (`:487`). Measured on the pinned
 * files, the table covers **7** dates and the charts cover **199** (xpcshell)
 * and **198** (mochitest) — a 28-fold difference with nothing on screen saying
 * so.
 *
 * `site/index-view.ts`'s header carries the table. What this file does about it
 * is divergence 5: each chart's existing `.info-text` gains the span it
 * actually covers, read from the data rather than written down.
 *
 * ## Declared divergences from `index.html`
 *
 * `PARITY.md` §4: byte-identical is the default and every exception is
 * declared. **This list is the whole set.** One enumerated list; no prose
 * elsewhere carrying a further entry.
 *
 *  1. **The Flaky Job Failures column divides by a corrected denominator.** A
 *     bug fix, and the largest number on this page that changes.
 *
 *     Upstream computes `(failedJobs − invalidJobs) / processedJobCount`
 *     (`old/index.html:476`, `:479`), removing the invalid jobs from the numerator
 *     while also leaving them out of the denominator. The generator says the
 *     numerator never contained them: `failedJobs` is counted over every
 *     non-ignored job of the day (`fetch-test-data.js:1821`), and
 *     `processedJobCount` and `invalidJobs` are the two disjoint branches that
 *     population splits into (`:267-282`). So the numerator was being reduced
 *     by a set it did not contain, and divided by a population short of its
 *     own. `site/index-view.ts`'s `summaryRow` carries the full derivation.
 *
 *     Both this page and `lib/query/summary.ts` now compute
 *     `failedJobs / (processedJobCount + invalidJobs)` — the CLI's old form
 *     had the right numerator and the same short denominator. Measured on the
 *     pinned files, last 7 dates:
 *
 *     | | page before | CLI before | both now |
 *     | --- | --- | --- | --- |
 *     | xpcshell | 11.83% (883 / 7,464) | 12.30% (918 / 7,464) | **12.24%** (918 / 7,499) |
 *     | mochitest | 2.66% (4,494 / 169,142) | 2.99% (5,049 / 169,142) | **2.98%** (5,049 / 169,697) |
 *
 *     The cell's second line moves with the rate — it now reads
 *     `918 / 7,499`, the two numbers the percentage is actually made of.
 *
 *     Upstream's `// Only test-related failures` comment (`:476`) is **not**
 *     carried across: it names an intent the arithmetic never achieved. The
 *     `.info-text` under the *chart* (`:256`) still says "excludes invalid
 *     jobs" and that remains accurate — the chart keeps upstream's
 *     `failedJobs − invalidJobs` series, which this change does not touch.
 *
 *     This also retires the negative-rate hazard the port previously measured
 *     and pinned. With no subtraction in the numerator, no combination of
 *     counters produces a negative percentage.
 *
 *     A **flavor** row is not the same expression and deliberately so: a flavor
 *     carries no `invalidJobs` field at all (`fetch-test-data.js:2833-2838`)
 *     and its `processedJobCount` is `jc.total`, the raw non-ignored job count
 *     for that flavor (`:2769`), which is already the population its
 *     `failedJobs` was drawn from. See `summaryRow`.
 *
 *  2. **The Skip Rate column is unchanged, and the CLI was corrected to
 *     match.** Listed because a reader diffing `fx-tests summary` against this
 *     page across this change will see the CLI's number move.
 *
 *     Upstream divides by `totalTestRuns` (`old/index.html:480`) and that is right:
 *     `totalTestRuns += runCount` runs *before* the status dispatch
 *     (`fetch-test-data.js:2733`) and `SKIP` is one of the branches below it,
 *     so the skips are already inside it. The CLI's
 *     `totalTestRuns + skippedTestRuns` counted them twice. Measured, last 7
 *     dates:
 *
 *     | | page (unchanged) | CLI before | CLI now |
 *     | --- | --- | --- | --- |
 *     | xpcshell | **4.72%** (743,332 / 15,739,304) | 4.51% (/ 16,482,636) | **4.72%** |
 *     | mochitest | **5.28%** (3,174,265 / 60,119,846) | 5.02% (/ 63,294,111) | **5.28%** |
 *
 *     The cell's second line already showed `skipped / totalTestRuns`, so it
 *     and the percentage were consistent all along.
 *
 *  3. **A short file now says how short.** The one place a *label* changed
 *     rather than a number.
 *
 *     `getRecentStats` narrows to `Math.min(days, dates.length)`
 *     (`old/index.html:445`) while the heading keeps saying "Summary (Last 7 Days)"
 *     (`:203`), so a file with 5 dates shows 5 days of data under a 7-day
 *     heading with nothing indicating it. The arithmetic is unchanged here; the
 *     heading is rewritten to `Summary (Last 5 Days)` when the window actually
 *     narrowed.
 *
 *     Not reachable on the pinned files — 199 and 198 dates — which is why it
 *     is covered by a test with a 3-date file rather than by the browser run.
 *
 *  4. **`markerCounts` is dropped from the merged file instead of being
 *     corrupted into 198 nulls.** A bug fix, in a field this page never reads.
 *
 *     `markerCounts` is an object of named series. Upstream's merge excludes
 *     only `metadata`, `dates` and `flavors` from its per-day array handling
 *     (`old/index.html:353-354`), so `markerCounts` is passed to `mergeArray` and
 *     indexed as if it were an array. Measured: the merged mochitest
 *     `markerCounts` is **an array of 198 `null`s**, having been an object of 5
 *     named series.
 *
 *     Invisible upstream because this page never reads it — `grep -c
 *     markerCounts index.html` is **0** — and the merged object is not stored
 *     anywhere the CLI can see. Fixed rather than reproduced because
 *     reproducing it means writing code whose only effect is to produce a
 *     wrong-shaped value; the merged result now omits the field, so a consumer
 *     asking for it gets `undefined` rather than 198 nulls that look like a
 *     real empty series.
 *
 *  5. **Each chart's `.info-text` now names the span it covers.** The fix for
 *     the three-windows problem, and the smallest one that works.
 *
 *     Upstream's four charts plot the entire file and say nothing about it,
 *     directly under a table headed "Last 7 Days". Each `.info-text` keeps its
 *     existing sentence and gains ` Covering 199 days, 2026-01-16 to
 *     2026-08-03.` — read off the data, so it cannot drift from what is
 *     plotted. Where the two harnesses differ the longer span is named with
 *     both, since one chart carries both series.
 *
 *     The markup is unchanged: the text is appended to the `<p>` that is
 *     already there.
 *
 *  6. **The two harness rows carry a prior-period comparison in their
 *     tooltip.** The one deliberate product change on this list.
 *
 *     `{harness}-stats.json` is the only file with real history — 199 dates for
 *     xpcshell — and the landing page showed one week of it against nothing.
 *     `lib/query/summary.ts` already computes the comparison for
 *     `fx-tests summary`, weekend-mix reasoning and all, so the page can have
 *     it for the cost of the call.
 *
 *     Each harness row's four cells keep their existing `title` sentence and
 *     gain a second line: `Job failure rate: 12.24%, prior 7d 7.54% (+4.70
 *     points).` The CLI's rate is quoted there, and since divergence 1 it is
 *     the **same** number as the cell above it — as are the other three. The
 *     line still names its metric, so the tooltip reads as a comparison of a
 *     named quantity rather than as a bare second percentage.
 *
 *     A change is reported only when the two *rendered* rates differ. The
 *     browser run caught the alternative: xpcshell's test failure rate went
 *     from 0.16540648605255448% to 0.17227572451742468%, which at two decimals
 *     printed `0.17%, prior 7d 0.17% (+0.01 points)` — every number correctly
 *     rounded, the line as a whole nonsense. It now reads `(unchanged at this
 *     precision)`. Measured: that fires on 1 of the 8 harness/metric pairs and
 *     the other 7 print a change, and `test/index-page.test.ts` asserts both
 *     branches so neither is left unexercised.
 *
 *     Flavor rows get no comparison: `computeSummary` reads a `StatsFile` and a
 *     flavor is not one — it has no `invalidJobs` and no `markerCounts` — and
 *     synthesizing one to get a per-flavor delta would be inventing a file
 *     shape to feed a query, which is how the CLI's numbers stopped matching
 *     the pages the first time.
 *
 *  7. **Inline handler attributes become `addEventListener`, and the two in the
 *     markup now throw once each.** The same arrangement `site/crashes.html`,
 *     `site/failures.html` and `site/errors.html` already ship, for the same
 *     reason: the markup is byte-identical, so `onclick="setDisplayMode(…)"` on
 *     the two toggle buttons (`old/index.html:192-193`) is still an attribute, and
 *     a module has no globals — so the attribute handler is a `ReferenceError`
 *     and the listener attached by this file does the work.
 *
 *     Measured in Chrome on the pinned snapshot: clicking Raw Counts logs
 *     exactly one `Uncaught ReferenceError: setDisplayMode is not defined` and
 *     the charts redraw in count mode. Listed rather than fixed because fixing
 *     it means editing the markup.
 *
 *     Every handler the page *generates* is gone: upstream's summary rows are
 *     built by concatenating HTML into `innerHTML` (`:483-514`, `:555`) and
 *     this file builds nodes, which answers the escaping question once. No
 *     `on*` attribute appears under `#statsSummary` on either page — upstream
 *     emits none there either, so this is a change of mechanism and not of DOM.
 *
 *  8. **`green.html#${kind}` still does not carry the dev parameters, and that
 *     is reproduced.** `old/index.html:487` wraps the issues link in
 *     `withDevParams()` and `:495` builds the green link without it, on the
 *     same row, two lines apart.
 *
 *     Checked rather than assumed to be an oversight: `green.html` does not
 *     load `fetch-utils.js` at all (`grep -c fetch-utils green.html` is **0**),
 *     so it has no `withDevParams`, reads no `?data-source=`, and fetches
 *     nothing that the parameter could redirect. Propagating the parameter
 *     would put a query string on a page that ignores it. Reproduced as-is.
 *
 *     The `#${kind}` fragment is `xpcshell` or `mochitest` — a bare fragment,
 *     unlike the issues link's `#date=21days`.
 *
 * ## What is *not* on the list, having been checked
 *
 * - **The `</h2>` typos at `:274` and `:276`.** Two `<h3>` elements are closed
 *   with `</h2>`. Parsed in jsdom to see what it actually costs: HTML5 error
 *   recovery closes the `h3` correctly, and
 *   `#xpcshellBreakdownContainer`'s children are `DIV H3 DIV H3 DIV` on both
 *   pages. So the markup is byte-identical, the parse is identical, and the
 *   only consequence is that the two are `h3` and the anchor handler selects
 *   `h2[id]` — so they are not click-to-anchor. That is a property of the
 *   *selector*, not of the typo: fixing the tags would not make them
 *   clickable. Left alone; the brief's "decide deliberately" is decided as
 *   "the markup is out of scope and the typo is inert".
 * - **`common-test-data.js`.** Not loaded, and was not before:
 *   `grep -c common-test-data index.html` is **0**.
 * - **URL state.** The page reads none — no `URLSearchParams`, no
 *   `location.hash` read anywhere in the file. It only *writes* a hash, on an
 *   `h2[id]` click (`:781-787`). Reproduced exactly: no read added, and adding
 *   one would be a new feature.
 */

import { type StatsFile } from '../lib/formats/stats.ts';
import { DEFAULT_SUMMARY_DAYS, type Summary, computeSummary } from '../lib/query/summary.ts';
import {
    type BreakdownPoint,
    type DisplayMode,
    type MergedStats,
    type RatePoint,
    type SummaryRow,
    HARNESS_COLORS,
    INITIAL_DISPLAY_MODE,
    MOCHITEST_FLAVORS,
    SUMMARY_DAYS,
    SUMMARY_LINK_HASH,
    breakdownSeries,
    displayValue,
    droppedDates,
    holeCount,
    mergeBackfillStats,
    rateSeries,
    summaryRows,
    testFailedJobSeries,
    unlistedFlavors,
} from './index-view.ts';

declare global {
    /**
     * `fetch-utils.js` — fetches a published artifact by name.
     *
     * `date` is an optional `YYYY-MM-DD` pushdate naming an *older* published
     * run to read instead of the latest one. Omit it for the current data.
     */
    function fetchData(filename: string, date?: string): Promise<Response>;
    /**
     * `fetch-utils.js:41` — propagates `?data-source=` and `?profiler=` onto an
     * outgoing link.
     */
    function withDevParams(url: string): string;
    /** `dashboards.js:268` — the featured-dashboard chips. */
    function renderDashboardTeaser(container: HTMLElement): void;
    /** `shared.js:270` — debounced `Plotly.Plots.resize` on every `.chart-container`. */
    function setupWindowResize(): void;
}

/**
 * The slice of Plotly 2.27.0 this page uses.
 *
 * Read off `window` rather than declared as a global `const Plotly`, for the
 * reason `site/issues.ts:310-320` records for Chart.js: `tsconfig.site.json`
 * compiles all of `site/**` as one program, so a second global declaration of
 * the same name would be a redeclaration error. Reading it off the window also
 * states the truth about where it comes from — a CDN `<script>` tag — and is
 * what lets a test substitute it.
 */
interface PlotlyApi {
    newPlot(
        target: string | HTMLElement,
        traces: readonly Record<string, unknown>[],
        layout: Record<string, unknown>,
        config: Record<string, unknown>
    ): Promise<unknown>;
}

const plotly = (): PlotlyApi | undefined =>
    (window as unknown as { Plotly?: PlotlyApi }).Plotly;

// --- page state -----------------------------------------------------------

/** The merged xpcshell file, or `null` when it could not be loaded. */
let xpcshellStats: MergedStats | null = null;
/** The merged mochitest file, or `null`. */
let mochitestStats: MergedStats | null = null;
/** The CLI's summary per harness, for the prior-period tooltips. Divergence 6. */
const summaries = new Map<string, Summary>();
let currentDisplayMode: DisplayMode = INITIAL_DISPLAY_MODE;

/** Which chart containers have been drawn since the last data change. */
const createdCharts = new Set<string>();
/** Which chart containers the observer currently considers visible. */
const visibleContainers = new Set<string>();
let dataReady = false;

// --- small DOM helpers ----------------------------------------------------

/**
 * Builds an element. The same helper `site/drilldown-render.ts` exports, and it
 * is re-stated rather than imported because that module is the crashes/failures
 * drill-down and this page shares nothing else with it — importing it would
 * pull a 831-line renderer in for six lines.
 *
 * Assigning `textContent` and the `title` *property* is what answers the
 * escaping question once, and it is why this page has no `escapeHtml`.
 */
function el(
    tag: string,
    options: { className?: string; text?: string; title?: string } = {},
    children: readonly Node[] = []
): HTMLElement {
    const node = document.createElement(tag);
    if (options.className !== undefined) {
        node.className = options.className;
    }
    if (options.text !== undefined) {
        node.textContent = options.text;
    }
    if (options.title !== undefined) {
        node.title = options.title;
    }
    for (const child of children) {
        node.append(child);
    }
    return node;
}

/**
 * A rate as the page writes it: two decimals and a `%`.
 *
 * **Rounded once, here, from the raw ratio.** `site/index-view.ts` carries
 * percentages unrounded for exactly this reason — a `toFixed` in the view model
 * and another here is the double-round that shipped `14.37%` where the page
 * showed `14.38%`.
 *
 * `null` renders as `0.00%`, which is upstream's behaviour (`old/index.html:478-481`
 * returns the string `'0.00'` when the denominator is zero) and is reproduced
 * even though the view model distinguishes the two cases.
 */
function percent(value: number | null): string {
    return `${(value ?? 0).toFixed(2)}%`;
}

/** `n / N`, both localized. `old/index.html:490`. */
function counts(numerator: number, denominator: number): string {
    return `${numerator.toLocaleString()} / ${denominator.toLocaleString()}`;
}

// --- the summary table ----------------------------------------------------

/** The four column tooltips, in column order. `old/index.html:486`, `:494`, `:502`, `:508`. */
const COLUMN_TITLES = [
    'Percentage of test runs that failed',
    // The second half is appended only on a harness row, as upstream does.
    'Percentage of jobs that failed',
    'Percentage of test runs that were skipped (excludes platform-irrelevant skips like run-if)',
    'Percentage of jobs that failed to produce valid results due to infrastructure issues',
] as const;

/**
 * The metric labels the prior-period tooltip uses, in column order.
 * Divergence 6.
 *
 * These name the CLI's metric, and all four are now the same number as the
 * cell above them — `test/index-parity.test.ts` asserts each of the four to
 * full float precision. The two that used to need a disambiguating suffix
 * ("all failed jobs", "of everything scheduled") no longer do, because the
 * numbers they were disambiguating from are gone.
 */
const DELTA_LABELS = [
    'Test failure rate',
    'Job failure rate',
    'Skip rate',
    'Invalid job rate',
] as const;

/** The `Summary` fields matching `DELTA_LABELS`, in column order. */
const DELTA_KEYS = [
    'testFailureRate',
    'jobFailureRate',
    'skipRate',
    'invalidJobRate',
] as const;

/**
 * The prior-period line for one cell, or `''` when there is no comparison.
 *
 * Points, not percent-of-percent, matching `lib/query/summary.ts`'s `delta`.
 *
 * ## Why the change is dropped when the two rounded rates read the same
 *
 * Found in the browser run, not by reading. The xpcshell test-failure rate went
 * from 0.16540648605255448% to 0.17227572451742468%, and rendering each part
 * independently at two decimals produced:
 *
 *     Test failure rate: 0.17%, prior 7d 0.17% (+0.01 points).
 *
 * Every number there is correctly rounded and the line as a whole is nonsense —
 * it shows two identical rates and a change between them. This is the same
 * class as the double-round trap, one level up: the *parts* are each rounded
 * once, but a reader compares the rendered parts and the arithmetic no longer
 * holds among them.
 *
 * The rule is to report a change only when the reader could see one, i.e. when
 * the two rounded rates differ. Below that the line says the rate held steady,
 * which is what "0.17% then 0.17%" actually means at the precision shown.
 * Measured on the pinned files: this fires on **1 of the 8** harness/metric
 * pairs — xpcshell's test failure rate — and the other seven print a change.
 */
function priorLine(summary: Summary | undefined, column: number): string {
    if (summary === undefined || summary.prior === null) {
        return '';
    }
    const key = DELTA_KEYS[column]!;
    const current = summary.current[key];
    const prior = summary.prior[key];
    const change = summary.delta[key];
    if (current === null || prior === null || change === null) {
        return '';
    }
    const currentText = current.toFixed(2);
    const priorText = prior.toFixed(2);
    const label = `\n${DELTA_LABELS[column]!}: ${currentText}%, prior ${summary.prior.dayCount}d `;
    if (currentText === priorText) {
        return `${label}${priorText}% (unchanged at this precision).`;
    }
    const sign = change >= 0 ? '+' : '−';
    return `${label}${priorText}% (${sign}${Math.abs(change).toFixed(2)} points).`;
}

/** One `.stat-cell`: the big percentage over the raw counts. */
function statCell(value: string, secondary: string | null): HTMLElement {
    const children = [el('div', { className: 'stat-value', text: value })];
    if (secondary !== null) {
        children.push(el('div', { className: 'stat-secondary', text: secondary }));
    }
    return el('div', { className: 'stat-cell' }, children);
}

/**
 * One cell, wrapped in a link on a harness row and bare on a flavor row.
 * `old/index.html:487`, `:492`, `:495`, `:500`.
 */
function linkedCell(cell: HTMLElement, href: string | null): Node {
    if (href === null) {
        return cell;
    }
    const anchor = el('a', { className: 'stat-link' }, [cell]);
    (anchor as HTMLAnchorElement).href = href;
    return anchor;
}

/** One row of the summary table. A port of `renderSummaryRow`, `old/index.html:469-515`. */
function renderSummaryRow(row: SummaryRow): HTMLElement {
    const tr = el('tr', row.isFlavor ? { className: 'flavor-row' } : {});
    tr.append(el('td', { className: 'harness-name', text: row.name }));
    const summary = row.isFlavor ? undefined : summaries.get(row.kind);

    const title = (column: number, extra = ''): string =>
        `${COLUMN_TITLES[column]!}${extra}${priorLine(summary, column)}`;

    // 1. Flaky Test Failures — links to the 21-day issues view. Third window.
    const testCell = el('td', { title: title(0) });
    testCell.append(
        linkedCell(
            statCell(
                percent(row.testFailureRate),
                counts(row.totals.failedTestRuns, row.totals.totalTestRuns)
            ),
            row.isFlavor
                ? null
                : withDevParams(`issues.html?kind=${row.kind}${SUMMARY_LINK_HASH}`)
        )
    );
    tr.append(testCell);

    // 2. Flaky Job Failures — `failedJobs / jobPopulation`, matching the CLI.
    // Divergence 1. The second line shows the same two numbers as the rate, so
    // the cell does not contradict itself.
    // `green.html` gets no dev params, deliberately. Divergence 8.
    const jobCell = el('td', { title: title(1, row.isFlavor ? '' : ' due to test flakiness') });
    jobCell.append(
        linkedCell(
            statCell(
                percent(row.jobFailureRate),
                counts(row.totals.failedJobs, row.jobPopulation)
            ),
            row.isFlavor ? null : `green.html#${row.kind}`
        )
    );
    tr.append(jobCell);

    // 3. Skip Rate — `skipped / totalTestRuns`, unchanged from upstream and now
    // also what the CLI computes.
    const skipCell = el('td', { title: title(2) });
    skipCell.append(
        statCell(
            percent(row.skipRate),
            counts(row.totals.skippedTestRuns, row.totals.totalTestRuns)
        )
    );
    tr.append(skipCell);

    // 4. Invalid Jobs — a dash on a flavor row: flavors carry no `invalidJobs`.
    const invalidCell = el('td', { title: title(3) });
    invalidCell.append(
        row.isFlavor
            ? statCell('—', null)
            : statCell(
                  percent(row.invalidJobRate),
                  counts(row.totals.invalidJobs, row.totals.processedJobCount)
              )
    );
    tr.append(invalidCell);

    return tr;
}

/**
 * Rebuilds the summary table. A port of `updateStatsSummary`,
 * `old/index.html:517-556`.
 *
 * Also rewrites the heading when the window narrowed (divergence 3) and warns
 * when the merge left a hole in the window — see `sumSeries` for why a hole
 * silently biases a rate rather than excluding a day.
 */
function updateStatsSummary(): void {
    const tbody = document.getElementById('statsSummary');
    if (tbody === null) {
        return;
    }
    const rows = summaryRows(xpcshellStats, mochitestStats);
    tbody.replaceChildren(...rows.map(renderSummaryRow));

    // Divergence 3: say how short the window actually is.
    const heading = document.getElementById('summary');
    const dayCount = rows[0]?.totals.dates.length ?? SUMMARY_DAYS;
    if (heading !== null) {
        heading.textContent = `Summary (Last ${dayCount} Day${dayCount === 1 ? '' : 's'})`;
    }

    for (const [name, stats] of namedStats()) {
        const holes = holeCount(stats.totalTestRuns.slice(-SUMMARY_DAYS));
        if (holes > 0) {
            console.warn(
                `${name}: ${holes} of the last ${SUMMARY_DAYS} dates have no totalTestRuns. ` +
                    'Those days count as 0 in both the numerator and the denominator of every ' +
                    'rate in the summary table, which biases the rate rather than excluding ' +
                    'the day.'
            );
        }
    }
}

/** The loaded files with their harness names, skipping the ones that failed. */
function namedStats(): [string, MergedStats][] {
    const loaded: [string, MergedStats][] = [];
    if (xpcshellStats !== null) {
        loaded.push(['xpcshell', xpcshellStats]);
    }
    if (mochitestStats !== null) {
        loaded.push(['mochitest', mochitestStats]);
    }
    return loaded;
}

// --- the charts -----------------------------------------------------------

/** A Plotly line trace over a rate series. A port of `createPercentageTrace`, `:558-591`. */
function rateTrace(
    points: readonly RatePoint[],
    name: string,
    color: string
): Record<string, unknown> {
    return {
        x: points.map((point) => point.date),
        y: points.map((point) => displayValue(point, currentDisplayMode)),
        type: 'scatter',
        mode: 'lines+markers',
        name,
        line: { color, width: 2 },
        marker: { size: 6 },
        customdata: points.map((point) => ({
            numerator: point.numerator.toLocaleString(),
            denominator: point.denominator.toLocaleString(),
            // Rounded once, from the raw ratio the view model carries.
            percentage: point.percentage.toFixed(2),
        })),
        hovertemplate:
            '<b>%{fullData.name}</b><br>' +
            'Date: %{x}<br>' +
            'Percentage: %{customdata.percentage}%<br>' +
            'Count: %{customdata.numerator} / %{customdata.denominator}<br>' +
            '<extra></extra>',
    };
}

/**
 * Restyles a trace as a per-flavor one. `old/index.html:621-624`, `:663-666`.
 *
 * `visible: 'legendonly'` is what makes the eight flavor traces start hidden
 * and appear on a legend click — the interaction the browser run exercises.
 */
function asFlavorTrace(trace: Record<string, unknown>): Record<string, unknown> {
    return {
        ...trace,
        line: { ...(trace['line'] as Record<string, unknown>), width: 1.5, dash: 'dot' },
        marker: { size: 4 },
        visible: 'legendonly',
    };
}

/** The shared layout. A port of `chartLayout`, `old/index.html:593-610`. */
function chartLayout(yLabel: string): Record<string, unknown> {
    return {
        xaxis: { title: 'Date', type: 'date' },
        yaxis: { title: yLabel, rangemode: 'tozero' },
        hovermode: 'closest',
        showlegend: true,
        margin: { l: 60, r: 40, t: 20, b: 60 },
        hoverlabel: {
            bgcolor: '#2a2a2a',
            bordercolor: '#2a2a2a',
            font: {
                size: 15,
                color: 'white',
                family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            },
        },
    };
}

/** `Plotly.newPlot`, tolerating a page where the CDN script did not load. */
function draw(
    id: string,
    traces: readonly Record<string, unknown>[],
    yLabel: string
): void {
    const api = plotly();
    if (api === undefined) {
        console.warn(`Plotly is not loaded; ${id} was not drawn.`);
        return;
    }
    void api.newPlot(id, traces, chartLayout(yLabel), { responsive: true });
}

/** The label the y axis takes in each mode. */
function yLabel(percentageLabel: string, countLabel: string): string {
    return currentDisplayMode === 'percentage' ? percentageLabel : countLabel;
}

/**
 * The per-flavor traces for a chart keyed on two top-level series names.
 * A port of `addMochitestFlavorTraces`, `old/index.html:612-627`.
 */
function flavorTraces(
    numeratorKey: 'failedTestRuns' | 'skippedTestRuns' | 'failedJobs',
    denominatorKey: 'totalTestRuns' | 'processedJobCount'
): Record<string, unknown>[] {
    const stats = mochitestStats;
    if (stats?.flavors === undefined) {
        return [];
    }
    const traces: Record<string, unknown>[] = [];
    for (const flavor of MOCHITEST_FLAVORS) {
        const counters = stats.flavors[flavor.key];
        // Upstream's guard is on the *denominator* being present, not the
        // flavor: `:616`, `:658`.
        if (counters === undefined || counters[denominatorKey] === undefined) {
            continue;
        }
        traces.push(
            asFlavorTrace(
                rateTrace(
                    rateSeries(stats.dates, counters[numeratorKey], counters[denominatorKey]),
                    flavor.name,
                    flavor.color
                )
            )
        );
    }
    return traces;
}

/** Flaky Test Failures. `old/index.html:629-645`. */
function createTestFailureChart(): void {
    const traces: Record<string, unknown>[] = [];
    for (const [name, stats] of namedStats()) {
        traces.push(
            rateTrace(
                rateSeries(stats.dates, stats.failedTestRuns, stats.totalTestRuns),
                harnessLabel(name),
                HARNESS_COLORS[name]!
            )
        );
        if (name === 'mochitest') {
            traces.push(...flavorTraces('failedTestRuns', 'totalTestRuns'));
        }
    }
    draw('testFailureChart', traces, yLabel('Failure Percentage (%)', 'Failed Test Runs'));
}

/** Flaky Job Failures. `old/index.html:647-673`. */
function createJobFailureChart(): void {
    const traces: Record<string, unknown>[] = [];
    for (const [name, stats] of namedStats()) {
        traces.push(
            rateTrace(
                rateSeries(stats.dates, testFailedJobSeries(stats), stats.processedJobCount),
                harnessLabel(name),
                HARNESS_COLORS[name]!
            )
        );
    }
    // The flavor traces come after *both* harnesses here, not interleaved:
    // upstream's loop over the two harnesses closes before the flavor block
    // (`:649-654` then `:655-669`). The legend order differs from the other two
    // charts because of it.
    traces.push(...flavorTraces('failedJobs', 'processedJobCount'));
    draw('jobFailureChart', traces, yLabel('Failure Percentage (%)', 'Failed Jobs'));
}

/** Test Skips. `old/index.html:675-691`. */
function createSkipRateChart(): void {
    const traces: Record<string, unknown>[] = [];
    for (const [name, stats] of namedStats()) {
        traces.push(
            rateTrace(
                rateSeries(stats.dates, stats.skippedTestRuns, stats.totalTestRuns),
                harnessLabel(name),
                HARNESS_COLORS[name]!
            )
        );
        if (name === 'mochitest') {
            traces.push(...flavorTraces('skippedTestRuns', 'totalTestRuns'));
        }
    }
    draw('skipRateChart', traces, yLabel('Skip Percentage (%)', 'Skipped Test Runs'));
}

/** The legend label for a harness. `old/index.html:634`, `:639`. */
function harnessLabel(harness: string): string {
    return harness === 'xpcshell' ? 'XPCShell' : 'Mochitest';
}

/** One stacked band of a breakdown chart. A port of `makeStackTrace`, `:698-717`. */
function stackTrace(
    name: string,
    color: string,
    points: readonly BreakdownPoint[]
): Record<string, unknown> {
    return {
        x: points.map((point) => point.date),
        y: points.map((point) =>
            currentDisplayMode === 'percentage' ? point.percentage : point.count
        ),
        name,
        type: 'scatter',
        mode: 'lines',
        stackgroup: 'one',
        line: { color, width: 0 },
        fillcolor: color,
        customdata: points.map((point) => ({
            count: point.count !== null ? point.count.toLocaleString() : '0',
            total: point.total.toLocaleString(),
            percentage: point.percentage !== null ? point.percentage.toFixed(2) : '0.00',
        })),
        hovertemplate:
            `<b>${name}</b><br>Date: %{x}<br>Percentage: %{customdata.percentage}%<br>` +
            'Count: %{customdata.count} / %{customdata.total}<br><extra></extra>',
    };
}

/** One harness's failure breakdown. A port of `createBreakdownChart`, `:693-725`. */
function createBreakdownChart(chartId: string, stats: MergedStats | null): void {
    if (stats === null) {
        return;
    }
    draw(
        chartId,
        [
            stackTrace('Intermittent', '#ff9500', breakdownSeries(stats, testFailedJobSeries(stats))),
            stackTrace('Invalid', '#888', breakdownSeries(stats, stats.invalidJobs)),
            stackTrace('Backout', '#0060df', breakdownSeries(stats, stats.ignoredJobs)),
        ],
        yLabel('Percentage of Total Jobs (%)', 'Job Count')
    );
}

/** Both breakdown charts, drawn by one observer entry. `old/index.html:727-730`. */
function createBreakdownCharts(): void {
    createBreakdownChart('xpcshellBreakdownChart', xpcshellStats);
    createBreakdownChart('mochitestBreakdownChart', mochitestStats);
}

/** Container id → the function that draws its chart. `old/index.html:734-739`. */
const CHART_CREATORS = new Map<string, () => void>([
    ['testFailureContainer', createTestFailureChart],
    ['jobFailureContainer', createJobFailureChart],
    ['skipRateContainer', createSkipRateChart],
    ['xpcshellBreakdownContainer', createBreakdownCharts],
]);

// --- divergence 5: label the chart window ---------------------------------

/**
 * Appends the span each chart covers to its `.info-text`. Divergence 5.
 *
 * Read off the data rather than written down, so it cannot drift from what is
 * plotted. Every chart plots the whole file, so every chart gets the same
 * sentence — but it is computed per container rather than once, because the
 * breakdown container holds both harnesses and a future chart might hold one.
 */
function labelChartWindows(): void {
    const loaded = namedStats();
    if (loaded.length === 0) {
        return;
    }
    const spans = loaded.map(
        ([name, stats]) =>
            `${harnessLabel(name)} ${stats.dates.length} days, ` +
            `${stats.dates[0]!} to ${stats.dates[stats.dates.length - 1]!}`
    );
    const sentence = ` Covering the full history: ${spans.join('; ')}.`;
    for (const id of CHART_CREATORS.keys()) {
        const info = document.getElementById(id)?.querySelector('.info-text');
        if (info !== null && info !== undefined && !info.textContent!.includes('Covering')) {
            info.textContent = `${info.textContent!}${sentence}`;
        }
    }
}

// --- loading --------------------------------------------------------------

/**
 * Fetches one harness's stats and merges its committed backfill.
 *
 * Both fetches are started by the caller before this is awaited, matching the
 * page's own arrangement (`old/index.html:8-16`): the four requests go out before
 * Plotly's CDN script has loaded, so the merge costs no extra latency.
 *
 * The backfill is best-effort — a 404 or a parse failure yields the live data
 * unchanged (`:390-400`) — because only mochitest has one committed. Measured:
 * `ls *-stats-backfill.json` is a single entry, so the xpcshell fetch 404s on
 * every load and always has.
 */
async function loadHarness(
    harness: string,
    livePromise: Promise<Response>,
    backfillPromise: Promise<Response>
): Promise<MergedStats | null> {
    const response = await livePromise;
    if (!response.ok) {
        return null;
    }
    const live = (await response.json()) as StatsFile;

    // The CLI's summary, for the prior-period tooltips. Computed from the
    // *live* file, not the merged one: `computeSummary` takes a `StatsFile`,
    // and the merged shape admits nulls it would mis-sum. The two agree over
    // the last 7 dates anyway — the merge only adds older dates — which
    // `test/index-parity.test.ts` asserts rather than assumes.
    try {
        summaries.set(harness, computeSummary(live));
    } catch (error) {
        console.warn(`No ${harness} period comparison:`, (error as Error).message);
    }

    let backfill: StatsFile | null = null;
    try {
        const backfillResponse = await backfillPromise;
        if (backfillResponse.ok) {
            backfill = (await backfillResponse.json()) as StatsFile;
        }
    } catch (error) {
        console.log(`No usable ${harness} backfill:`, (error as Error).message);
    }

    const { stats, warnings } = mergeBackfillStats(backfill, live);
    if (warnings.length > 0) {
        console.warn(
            `${harness}: committed backfill disagrees with live artifact on ` +
                `${warnings.length} value(s) over overlapping dates (live wins):\n` +
                warnings
                    .map((entry) => `${entry.date} ${entry.key}: backfill=${entry.backfill} live=${entry.live}`)
                    .join('\n')
        );
    }
    const unlisted = unlistedFlavors(live);
    if (unlisted.length > 0) {
        console.warn(
            `${harness}: the data has flavors this page does not show: ${unlisted.join(', ')}. ` +
                'Add them to MOCHITEST_FLAVORS in site/index-view.ts.'
        );
    }
    console.log(`Loaded ${harness} stats:`, stats.dates.length, 'days');
    return stats;
}

/** Redraws everything after a data or mode change. A port of `updateDisplay`, `:762-778`. */
function updateDisplay(): void {
    if (xpcshellStats === null && mochitestStats === null) {
        return;
    }
    dataReady = true;

    requestAnimationFrame(() => {
        updateStatsSummary();
        labelChartWindows();
        // Recreate the visible charts; reset the created set so an off-screen
        // one is rebuilt when it scrolls in. `old/index.html:770-776`.
        createdCharts.clear();
        setTimeout(() => {
            for (const id of visibleContainers) {
                CHART_CREATORS.get(id)?.();
                createdCharts.add(id);
            }
        }, 0);
    });
}

/** The percentage/raw-counts toggle. A port of `setDisplayMode`, `:434-440`. */
function setDisplayMode(mode: DisplayMode): void {
    currentDisplayMode = mode;
    document.getElementById('btnPercentage')?.classList.remove('active');
    document.getElementById('btnCount')?.classList.remove('active');
    document
        .getElementById(mode === 'percentage' ? 'btnPercentage' : 'btnCount')
        ?.classList.add('active');
    updateDisplay();
}

/**
 * Wires the toggle buttons, the `h2` anchors and the lazy-chart observer.
 *
 * The observer's `rootMargin: '200px'` is upstream's (`:756`) and matters for
 * the browser run: a container 200px below the fold is already "visible", so
 * the first two charts draw without any scrolling on a normal window.
 */
function setupInteractions(): void {
    // Divergence 7: the markup's `onclick` attributes throw; these do the work.
    document
        .getElementById('btnPercentage')
        ?.addEventListener('click', () => setDisplayMode('percentage'));
    document.getElementById('btnCount')?.addEventListener('click', () => setDisplayMode('count'));

    // Writes a hash; reads none. `old/index.html:781-787`. The two `<h3>` in the
    // breakdown container are deliberately not included — see the note above
    // the divergence list.
    for (const header of document.querySelectorAll('h2[id]')) {
        header.addEventListener('click', () => {
            window.location.hash = `#${header.id}`;
        });
    }

    // `IntersectionObserver` does not exist in jsdom. The page's charts are
    // *entirely* observer-driven, so a test that wants one drawn calls
    // `window.__drawChart` instead; in a browser this branch never runs.
    if (typeof IntersectionObserver === 'undefined') {
        return;
    }
    const observer = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    visibleContainers.add(entry.target.id);
                    if (dataReady && !createdCharts.has(entry.target.id)) {
                        CHART_CREATORS.get(entry.target.id)?.();
                        createdCharts.add(entry.target.id);
                    }
                } else {
                    visibleContainers.delete(entry.target.id);
                }
            }
        },
        { rootMargin: '200px' }
    );
    for (const id of CHART_CREATORS.keys()) {
        const container = document.getElementById(id);
        if (container !== null) {
            observer.observe(container);
        }
    }
}

declare global {
    interface Window {
        /** The rendered view model, for the browser parity harness. */
        __view?: () => unknown;
        /**
         * Draws one chart container's chart, bypassing the observer.
         *
         * jsdom has no `IntersectionObserver` and a background browser tab
         * never fires one, so without this the charts are unreachable from a
         * test. It calls the *same* creator the observer would, so a test using
         * it exercises the real trace-building path.
         */
        __drawChart?: (containerId: string) => void;
        /** The current display mode, for the browser harness. */
        __displayMode?: () => DisplayMode;
    }
}

/**
 * Starts the page.
 *
 * Exported and called from `site/index-main.ts` rather than run on import, so a
 * test can import this module without attaching listeners and fetching data —
 * the property `site/crashes-main.ts` documents and the reason 2,598 lines of
 * the crashes/failures migration once had no test importing them.
 */
export async function start(): Promise<void> {
    const teaser = document.getElementById('dashboardTeaser');
    if (teaser !== null) {
        renderDashboardTeaser(teaser);
    }
    setupWindowResize();
    setupInteractions();

    window.__view = (): unknown => ({
        displayMode: currentDisplayMode,
        summaryDays: summaryRows(xpcshellStats, mochitestStats)[0]?.totals.dates.length ?? 0,
        rows: summaryRows(xpcshellStats, mochitestStats),
        chartDates: Object.fromEntries(
            namedStats().map(([name, stats]) => [name, stats.dates.length])
        ),
        dropped: Object.fromEntries(
            namedStats().map(([name, stats]) => [
                name,
                droppedDates(stats.dates, stats.failedTestRuns, stats.totalTestRuns),
            ])
        ),
    });
    window.__drawChart = (containerId: string): void => {
        visibleContainers.add(containerId);
        CHART_CREATORS.get(containerId)?.();
        createdCharts.add(containerId);
    };
    window.__displayMode = (): DisplayMode => currentDisplayMode;

    // All four requests go out before anything is awaited, matching
    // `old/index.html:8-16`. The backfill is a plain `fetch` of a committed sibling,
    // not a published artifact, so it does not go through `fetchData`.
    const xpcshellLive = fetchData('xpcshell-stats.json');
    const mochitestLive = fetchData('mochitest-stats.json');
    // build-optional: xpcshell-stats-backfill.json — no xpcshell backfill is
    // committed and none is expected. The backfill repairs a mochitest-only
    // data loss, so this request has 404'd on every load since the page was
    // written, and `tools/page-assets.ts` would otherwise fail the build over a
    // file that is meant to be absent. `mochitest-stats-backfill.json` has no
    // such marker, so the build copies it into `dist-site/` and stops if it
    // ever goes missing — which is the bug this marker's absence used to hide.
    const xpcshellBackfill = fetch('./xpcshell-stats-backfill.json');
    const mochitestBackfill = fetch('./mochitest-stats-backfill.json');

    try {
        [xpcshellStats, mochitestStats] = await Promise.all([
            loadHarness('xpcshell', xpcshellLive, xpcshellBackfill),
            loadHarness('mochitest', mochitestLive, mochitestBackfill),
        ]);
        if (xpcshellStats === null && mochitestStats === null) {
            throw new Error('No stats data available');
        }
        updateDisplay();
    } catch (error) {
        console.error('Failed to load stats:', error);
        const message = document.getElementById('errorMessage');
        if (message !== null) {
            message.textContent =
                'Error: Could not load statistics. Generate stats by running: ' +
                'node fetch-test-data.js --harness xpcshell --days 30 && ' +
                'node fetch-test-data.js --harness mochitest --days 30';
            message.style.display = 'block';
        }
    }
}

/** Re-exported so `test/index-parity.test.ts` can assert the two windows agree. */
export { DEFAULT_SUMMARY_DAYS };
