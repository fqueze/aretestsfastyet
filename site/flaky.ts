/**
 * `flaky.html` — how flaky the tree is, over time and by folder.
 *
 * | file | contains | tested by |
 * | --- | --- | --- |
 * | `lib/query/flakiness.ts` | the classification, the folder rollup, the running average | `test/flakiness.test.ts` |
 * | `site/flaky-view.ts` | the view model — rows, sort, search, colour bands, URL state | `test/flaky-view.test.ts`, no DOM |
 * | this file | the renderer and the interactions | `test/flaky-page.test.ts` |
 *
 * A new page, not a migration: there is no old page to be byte-identical to, so
 * the reasoning below is about what the page *should* do rather than about what
 * an existing one already did.
 *
 * ## The data it reads
 *
 * The same two files as `issues.html`, deliberately not the third, plus one
 * committed sibling:
 *
 * - `{harness}-issues.json` — the 2.8 MB counts-only 21-day aggregate, which is
 *   what the page opens on. Every number here is a count of runs per day, which
 *   is exactly what this page needs.
 * - `{harness}-<date>.json` — one day, when a date is selected.
 * - `{harness}-flaky-backfill.json` — a 21-27 kB committed file holding four
 *   integers per day for the ~250 days before the aggregate's window. It feeds
 *   the two charts at the top and nothing else; see `chartDays` for why the
 *   tiles and the table cannot use it, and `lib/formats/flaky-backfill.ts` for
 *   the merge rule.
 * - **not** `{harness}-issues-with-taskids.json`. That file exists to name the
 *   job behind a failure, and nothing on this page does: a folder row is a
 *   count, not a list of runs. Skipping it saves 15.9 MB per visit.
 *
 * ## Two charts, and what the first one contains
 *
 * Counts on top, percentages below, rather than one chart with two y axes: a
 * dual-axis plot makes the reader work out which series belongs to which scale
 * before they can read either, and the two questions — how many tests are in
 * trouble, and what share of the tree that is — are separate.
 *
 * The counts chart plots flaky and skipped always, and stable **once the window
 * is long enough for its growth to be the point** — `STABLE_CHART_DAYS` holds
 * the measurements. Over the 21-day artifact alone it stays out, which is what
 * it did before the backfill existed.
 *
 * The percentage chart carries the raw flaky rate, its **centred** 7-day mean —
 * so a bump sits over the day that caused it — and the skip rate.
 *
 * Both charts are hidden outright in single-day mode: one day is one point, and
 * an empty plot area reads as a page that failed to load.
 *
 * ## The two things the table can count
 *
 * A row is a folder or a test file, and in both table modes **a test counts
 * once**. The window view classifies a test by the worst state it reached on
 * any day rather than adding one count per day it ran — the latter made a
 * single test worth 21 rows, counted the same test as both flaky and stable,
 * and turned a column headed "Tests" from 4,805 into 100,716. See
 * `FolderOptions.allDays`.
 */

import { decodeDaily } from '../lib/formats/daily.ts';
import type { DailyFile } from '../lib/formats/daily.ts';
import { decodeIssues } from '../lib/formats/issues.ts';
import type { IssuesFile } from '../lib/formats/issues.ts';
import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import {
    type FlakyBackfillFile,
    type FlakyBackfillMerge,
    mergeFlakyBackfill,
} from '../lib/formats/flaky-backfill.ts';
import {
    DEFAULT_MIN_WINDOW_FAILURES,
    MIN_FILTERABLE_DAYS,
    type FlakinessSeries,
    type FlakyDay,
    type FolderNode,
    flakinessByFolder,
    flakinessOfPath,
    flakinessOverTime,
    flakyPercentage,
} from '../lib/query/flakiness.ts';
import {
    type ChartSeries,
    type FolderRow,
    type ListRow,
    type SortState,
    type TableMode,
    AVERAGE_WINDOW,
    COLUMNS,
    DEFAULT_TABLE_MODE,
    HISTORICAL_DATE,
    INITIAL_SORT,
    ancestorPaths,
    chartScopeNote,
    chartSeries,
    countChartNote,
    findFolder,
    flakyBand,
    formatPercent,
    headline,
    hiddenCleanTests,
    inlineChartVisible,
    isHistoricalDate,
    listRows,
    nextSort,
    parseOpen,
    parseTableMode,
    readUrlState,
    testPageUrl,
    testsOfFolder,
    tileTooltips,
    totalColumnLabel,
    visibleRows,
} from './flaky-view.ts';
// The `tests.html` URL builders, from the page that owns that URL shape
// rather than copied here — the same reason `issues.ts` takes its `test.html`
// link from `site/test-link.ts` instead of writing the query string again.
import { folderPageUrl } from './tests-view.ts';
import { CHART_COLOURS, SOLID, withAlpha } from './chart-colours.ts';
import { type SearchBoxManager, el, externalLink, searchBox } from './drilldown-render.ts';

/**
 * The slice of Chart.js this page uses.
 *
 * Read off `window` rather than declared as a global `const Chart`, for the
 * reason `site/issues.ts` records: `tsconfig.site.json` compiles all of
 * `site/**` as one program, so a second global declaration of the same name is
 * a redeclaration error however compatible the two shapes are.
 */
interface ChartJs {
    new (canvas: HTMLCanvasElement, config: Record<string, unknown>): { destroy(): void };
    getChart(canvas: HTMLCanvasElement): { destroy(): void } | undefined;
}

function chartJs(): ChartJs | undefined {
    return (window as unknown as { Chart?: ChartJs }).Chart;
}

// --- page state -----------------------------------------------------------

/** The decoded file every number comes from. */
let decoded: DecodedTimingFile | null = null;
let isHistoricalMode = false;
/** The per-day series of the loaded file. */
let series: FlakinessSeries | null = null;
/** The folder tree of the day the table is showing. */
let tree: FolderNode | null = null;
/** Which day the table is built on: an absolute index, or `null` for all days. */
let tableDay: number | null = null;
/** Whether the table aggregates the whole window instead of one day. */
let tableAllDays = false;
/** The noise threshold in force. */
let minWindowFailures = DEFAULT_MIN_WINDOW_FAILURES;
/**
 * The committed history for the loaded harness, or `null` if there is none.
 *
 * Loaded once at startup and never refetched: it is a committed sibling of the
 * page, so switching harness reloads the page anyway.
 */
let backfill: FlakyBackfillFile | null = null;
/** Whether `reportSeam` has already logged for this backfill. */
let seamReported = false;

const expanded = new Set<string>();
let currentSort: SortState = { ...INITIAL_SORT };
let renderedRows: FolderRow[] = [];
let renderedList: ListRow[] = [];
/** Whether the table is the drillable tree or the flat ranked list. */
let tableMode: TableMode = DEFAULT_TABLE_MODE;

let searchBoxManager: SearchBoxManager;
let hashManager: ReturnType<typeof initUrlHashManager>;
let historicalToggleManager: { toggle: () => Promise<void> };

const byId = (id: string): HTMLElement => document.getElementById(id)!;
const dateSelect = (): HTMLSelectElement => byId('date-select') as HTMLSelectElement;

function showError(message: string): void {
    const box = byId('error');
    box.style.display = 'block';
    box.textContent = message;
}

function hideError(): void {
    byId('error').style.display = 'none';
}

function setStatusText(text: string): void {
    byId('status-text').textContent = text;
}

// --- the headline ---------------------------------------------------------

/**
 * The three summary tiles and the trend sentence.
 *
 * The tiles are the most recent day's counts, because "how flaky are we" is a
 * question about now; the trend underneath is the 7-day average's movement
 * across the window, which is the question the chart answers.
 */
function renderHeadline(): void {
    const target = byId('headline');
    target.textContent = '';
    if (series === null) {
        return;
    }
    const summary = headline(series.days);
    const latest = summary.latest;
    if (latest === null) {
        target.append(el('p', { class: 'headline-empty', text: 'No tests ran in this window.' }));
        return;
    }

    // The tiles show the N-day average, not the most recent day. Before this
    // they showed one day (923 flaky, 19%) directly above a table total for the
    // whole window (3,867, 80%) with nothing saying the two measured different
    // things — the mismatch the page was rightly called out for.
    const shown = summary.average ?? {
        flaky: latest.flaky,
        stable: latest.stable,
        skipped: latest.skipped,
        total: latest.total,
        days: 1,
    };

    // Said before the numbers, because it is what makes them readable.
    target.append(
        el('p', {
            class: 'headline-scope',
            text:
                shown.days > 1
                    ? `Average over the last ${shown.days} days, of ${formatNumber(shown.total)} tests a day:`
                    : `On ${latest.date}, of ${formatNumber(shown.total)} tests:`,
        })
    );

    // The wording follows the threshold actually applied, so a tile cannot
    // promise "passed every time" while the filter is forgiving one failure.
    const tips = tileTooltips(series.minWindowFailures, shown.days);

    const tile = (
        label: string,
        value: string,
        note: string,
        modifier: string,
        tooltip: string
    ): HTMLElement =>
        el('div', {
            class: `headline-tile ${modifier}`,
            title: tooltip,
            children: [
                el('div', { class: 'headline-value', text: value }),
                el('div', {
                    class: 'headline-label',
                    children: [label, el('span', { class: 'headline-help', text: 'ⓘ' })],
                }),
                el('div', { class: 'headline-note', text: note }),
            ],
        });

    // Stable first, so flaky and skipped — the two the reader is comparing —
    // sit next to each other rather than with the big green number between
    // them.
    const tiles = el('div', { class: 'headline-tiles' });
    tiles.append(
        tile(
            'Stable',
            formatPercent(shown.total > 0 ? (shown.stable / shown.total) * 100 : 0),
            `${formatNumber(shown.stable)} tests`,
            'is-stable',
            tips.stable
        ),
        tile(
            'Flaky',
            formatPercent(shown.total > 0 ? (shown.flaky / shown.total) * 100 : 0),
            `${formatNumber(shown.flaky)} tests`,
            'is-flaky',
            tips.flaky
        ),
        tile(
            'Skipped',
            formatPercent(shown.total > 0 ? (shown.skipped / shown.total) * 100 : 0),
            `${formatNumber(shown.skipped)} tests`,
            'is-skipped',
            tips.skipped
        )
    );
    target.append(tiles);

    const caption = el('p', { class: 'headline-caption' });
    // The most recent day, named — the tiles are an average, so the latest day
    // is a separate fact and is reported as one rather than implied.
    caption.append(
        `Most recent day, ${latest.date}: ${formatPercent(summary.flakyPercent)} flaky ` +
            `(${formatNumber(latest.flaky)} of ${formatNumber(latest.total)} tests). `
    );
    if (summary.trend !== null && series.days.length > 1) {
        const direction = summary.trend > 0 ? 'up' : summary.trend < 0 ? 'down' : 'flat';
        const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '▬';
        const trend = el('span', {
            class: `headline-trend is-${direction}`,
            text: `${arrow} ${Math.abs(summary.trend).toFixed(1)} points`,
        });
        caption.append('The ', String(AVERAGE_WINDOW), '-day average moved ', trend);
        caption.append(' across the window.');
    }
    target.append(caption);

    if (series.neutralisedTests > 0) {
        target.append(
            el('p', {
                class: 'headline-note-line',
                text:
                    `${formatNumber(series.neutralisedTests)} tests failed no more than ` +
                    `${series.minWindowFailures} time${series.minWindowFailures === 1 ? '' : 's'} ` +
                    'in the whole window and are counted as passing.',
            })
        );
    } else if (series.days.length < MIN_FILTERABLE_DAYS && minWindowFailures > 0) {
        // The reader has a threshold set and it is not being applied. Saying so
        // is the whole point: silently ignoring it made a single day read 562
        // flaky where the same day inside the window reads 923.
        target.append(
            el('p', {
                class: 'headline-note-line',
                text:
                    'The noise filter needs more than one day to judge a run against, ' +
                    'so it is not applied to a single-day view.',
            })
        );
    }
}

// --- the chart ------------------------------------------------------------

/** The colours the chart and the table share. Kept next to the chart config. */
const COLOURS = {
    // Orange, not red: a flaky test is a nuisance to be burned down, and red is
    // reserved on these dashboards for something broken. It also keeps the
    // counts chart's two bands — orange and grey — clearly distinct.
    //
    // **The shared failure orange**, from `site/chart-colours.ts`. This page
    // used `#e8834a`, a slightly redder orange of its own; `tests.html` puts a
    // flaky-tests chart directly under a failures chart, and two
    // near-identical oranges there read as a mistake rather than a
    // distinction. The hue is the one `test.html` and `issues.html` already
    // use for failures.
    flaky: SOLID.flaky,
    /** The raw daily rate, under its own 7-day average. */
    flakyFaint: withAlpha(CHART_COLOURS.flaky.bg, 0.35),
    stable: SOLID.stable,
    /**
     * The counts chart's stable band, over months.
     *
     * The **same green** as the tiles and the table, at 0.30 alpha rather than a
     * different hue: the band is 80% of the plot's area, and a saturated fill
     * that large stops being a band and becomes the background, taking the two
     * bands beneath it with it. Alpha keeps the colour identity — green is
     * "stable" everywhere on this page — while letting the grid read through.
     *
     * A new hue was the alternative and is the worse one. Running the three
     * plotted fills through the palette validator, the flaky↔skipped pair is
     * already the tightest at ΔE 14.5 (normal vision); adding a fourth hue
     * tightens it further, whereas the existing green sits at ΔE 8.6 from grey
     * under deuteranopia, the best-separated pair of the three.
     */
    stableFaint: 'rgba(92, 184, 92, 0.30)',
    skipped: SOLID.skipped,
};

/**
 * Options shared by both charts, so the two read as one figure.
 *
 * **The x axis caps its ticks at 14.** Chart.js labels every category it can fit
 * and rotates them to make room; over the 21-day artifact that is 21 readable
 * `MM-DD` labels, but over the ~257-day merged series it produced 65 rotated
 * `YYYY-MM-DD` labels that were unreadable and took a third of the plot's height
 * for themselves — measured in the browser on the real merged data. 14 leaves a
 * tick roughly every fortnight over a year and still labels most days of a
 * 21-day window, so one number serves both without the chart having to know
 * which it is drawing.
 */
function baseOptions(yTitle: string, asPercent: boolean): Record<string, unknown> {
    return {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
            x: {
                grid: { display: false },
                ticks: { maxTicksLimit: 14, autoSkip: true, maxRotation: 45 },
            },
            y: {
                stacked: !asPercent,
                beginAtZero: true,
                title: { display: true, text: yTitle },
                ...(asPercent
                    ? { ticks: { callback: (value: number) => `${value}%` } }
                    : {}),
            },
        },
        plugins: {
            legend: { position: 'bottom' },
            tooltip: {
                callbacks: {
                    label: (item: {
                        dataset: { label?: string };
                        parsed: { y: number | null };
                    }): string => {
                        const value = item.parsed.y;
                        if (value === null) {
                            return `${item.dataset.label ?? ''}: n/a`;
                        }
                        return asPercent
                            ? `${item.dataset.label ?? ''}: ${value.toFixed(1)}%`
                            : `${item.dataset.label ?? ''}: ${formatNumber(value)}`;
                    },
                },
            },
        },
    };
}

/**
 * Draws the two charts: counts on top, percentages below.
 *
 * **Whether the counts chart stacks stable depends on how wide the window is**,
 * and `STABLE_CHART_DAYS` holds the reasoning with the numbers behind it. Short
 * version: over the 21-day artifact stable is ~80% of every day and stacking it
 * squeezes the two bands the reader came for into the bottom third, while the
 * population it would show moves 0.6%; over the ~250 days the committed backfill
 * adds, that population grows 7.7% and the stack's top edge is the only place on
 * the page that growth appears. So the same chart drops it on one window and
 * draws it on the other, and the axis title says which.
 */
function drawCharts(data: ChartSeries): void {
    const Chart = chartJs();
    if (Chart === undefined) {
        // The CDN tag was blocked. The table below is the page's substance and
        // still works, so this is a note rather than an error.
        byId('charts').style.display = 'none';
        return;
    }

    const counts = byId('flaky-count-chart') as HTMLCanvasElement;
    Chart.getChart(counts)?.destroy();
    // `border` defaults to `fill` so the two-band chart is unchanged. The stable
    // band passes both, because its fill is deliberately transparent and its
    // *top edge* is the population line — the one thing that band is there to
    // show — which a 30%-alpha stroke would lose.
    const area = (
        label: string,
        values: (number | null)[],
        fill: string,
        border = fill
    ): Record<string, unknown> => ({
        label,
        data: values,
        backgroundColor: fill,
        borderColor: border,
        borderWidth: 1,
        fill: true,
        stack: 'counts',
        pointRadius: 0,
        tension: 0.2,
        // A `null` day is a hole in the data, not a zero, so the band breaks
        // there rather than being drawn through. Without this the one thin day in
        // the published history — 2026-07-11, 128 of ~4,600 xpcshell tests — was
        // a spike to the axis in the middle of the plot that read as a rendering
        // fault. See `THIN_DAY_SHARE`.
        spanGaps: false,
    });
    new Chart(counts, {
        type: 'line',
        data: {
            labels: data.labels,
            datasets: [
                area('Flaky', data.flaky, COLOURS.flaky),
                area('Skipped', data.skipped, COLOURS.skipped),
                // Stable goes on **top** of the stack, not under it. The two
                // bands below are the ones being compared and they keep the
                // axis's zero; putting the big one underneath would lift them
                // both off the baseline and make their height the only readable
                // thing about them. On top, the stack's outline is the total
                // test count and each lower band still starts at 0.
                ...(data.showStable
                    ? [area('Stable', data.stable, COLOURS.stableFaint, COLOURS.stable)]
                    : []),
            ],
        },
        options: baseOptions(
            data.showStable ? 'Tests that ran' : 'Tests (flaky + skipped)',
            false
        ),
    });
    // The caption follows the chart rather than the markup, so it cannot claim
    // stable is omitted while the plot above it draws stable. See
    // `countChartNote`.
    byId('count-chart-note').textContent = countChartNote(data);

    const percent = byId('flaky-percent-chart') as HTMLCanvasElement;
    Chart.getChart(percent)?.destroy();
    new Chart(percent, {
        type: 'line',
        data: {
            labels: data.labels,
            datasets: [
                {
                    // Orange, matching the counts chart, the tiles and the
                    // table: "flaky" is one colour everywhere on the page. The
                    // faint version is the raw daily rate and the solid one is
                    // its average, so the pair reads as one series smoothed.
                    label: 'Flaky %',
                    data: data.flakyPercent,
                    borderColor: COLOURS.flakyFaint,
                    backgroundColor: COLOURS.flakyFaint,
                    borderWidth: 1,
                    pointRadius: 0,
                    fill: false,
                    // Same reason as the counts chart's bands: a thin day is a
                    // gap, not a 0%.
                    spanGaps: false,
                },
                {
                    label: `Flaky %, ${AVERAGE_WINDOW}-day average`,
                    data: data.average,
                    borderColor: COLOURS.flaky,
                    backgroundColor: COLOURS.flaky,
                    borderWidth: 2,
                    pointRadius: 0,
                    // A gap where the average is undefined, rather than a line
                    // drawn through it.
                    spanGaps: false,
                    fill: false,
                    tension: 0.3,
                },
                {
                    label: 'Skipped %',
                    data: data.skippedPercent,
                    borderColor: COLOURS.skipped,
                    backgroundColor: COLOURS.skipped,
                    borderWidth: 1,
                    borderDash: [4, 3],
                    pointRadius: 0,
                    fill: false,
                    spanGaps: false,
                },
            ],
        },
        options: baseOptions('Share of tests', true),
    });

    // Why the charts and the table below disagree about how long "the window" is.
    // Empty when they do not, so the no-backfill page gains no sentence.
    const scope = chartScopeNote(data.labels.length, series?.days.length ?? data.labels.length);
    byId('chart-scope-note').textContent = scope ?? '';
}

/**
 * Shows or hides the charts.
 *
 * A single day has one data point, and a one-point line chart shows nothing a
 * headline tile does not already say — while an empty plot area reads as a page
 * that failed to load. So the charts are hidden outright rather than drawn
 * degenerate.
 */
function setChartsVisible(visible: boolean): void {
    byId('charts').style.display = visible ? '' : 'none';
}

// --- the folder table -----------------------------------------------------

/** The header row, with the three sortable numeric columns. */
function tableHeader(): HTMLElement {
    const button = (field: (typeof COLUMNS)[number][0], label: string): HTMLElement => {
        const active = currentSort.field === field;
        const node = el('button', {
            class: active ? 'sort-button active' : 'sort-button',
            attrs: { 'data-field': field },
            children: [
                el('span', {
                    class: 'sort-arrow',
                    text: active ? (currentSort.ascending ? '↑' : '↓') : ' ',
                }),
                label,
            ],
        });
        node.addEventListener('click', () => {
            currentSort = nextSort(currentSort, field);
            renderTable();
        });
        return node;
    };

    const name = button('name', tableMode === 'list' ? 'Folder (flat)' : 'Folder / test');
    name.style.justifyContent = 'flex-start';

    // The Skipped column counts a flaky-and-skipped test too, so it overlaps
    // Flaky and the columns do not add up to Tests. Said on the header rather
    // than left for a reader to discover by adding them up — on the pinned
    // window the overlap is 800 of 4,807 tests.
    const skipHint =
        'Counts every test skipped on at least one configuration, including tests that ' +
        'also failed. It therefore overlaps Flaky, and the columns do not sum to Tests.';

    return el('div', {
        class: 'sort-header folder-row',
        children: [
            el('div', { class: 'folder-name', children: [name] }),
            el('div', {
                class: 'folder-bar-cell',
                children: [el('span', { class: 'folder-bar-header', text: 'Split' })],
            }),
            el('div', {
                class: 'folder-stats',
                children: COLUMNS.map(([field, label]) => {
                    const node = button(
                        field,
                        // The last column counts tests on one day and test-days
                        // over the window. See `totalColumnLabel`.
                        field === 'total' ? totalColumnLabel(tableAllDays) : label
                    );
                    if (field === 'skipped' || field === 'skipPercent') {
                        node.title = skipHint;
                    }
                    return el('div', { class: 'stat-item', children: [node] });
                }),
            }),
        ],
    });
}

/**
 * The three-part bar showing a folder's flaky / stable / skipped split.
 *
 * The percentages colour the row's background band, and this shows the whole
 * split — a row that is 30% flaky is also either mostly stable or mostly
 * skipped, and those are very different folders.
 */
function splitBar(row: {
    flakyPercent: number;
    stablePercent: number;
    skippedPercent: number;
}): HTMLElement {
    const bar = el('div', { class: 'folder-bar' });
    const segment = (percent: number, modifier: string, label: string): void => {
        if (percent <= 0) {
            return;
        }
        const part = el('div', { class: `folder-bar-part is-${modifier}` });
        part.style.width = `${percent}%`;
        part.title = `${label}: ${formatPercent(percent)}`;
        bar.append(part);
    };
    // The bar shows the **exclusive** split, so its three parts still fill it
    // exactly once. The Skipped *column* deliberately overlaps Flaky (a test
    // that failed and is disabled somewhere is in both), and drawing that
    // overlap here would make the bar overflow its own width and stop being a
    // proportion — so the bar keeps the charts' definition and the columns keep
    // the table's. `stablePercent` is what the exclusive skipped share is
    // recoverable from: 100 − flaky − stable.
    // Flaky, then skipped, then stable — the same order as the headline tiles
    // put them in, so the two bad states are adjacent and the big green one is
    // at the end rather than wedged between them.
    segment(row.flakyPercent, 'flaky', 'Flaky');
    segment(
        Math.max(0, 100 - row.flakyPercent - row.stablePercent),
        'skipped',
        'Skipped (not also flaky)'
    );
    segment(row.stablePercent, 'stable', 'Stable');
    return bar;
}

/** The five numeric cells every row carries. */
function statCells(counts: {
    flaky: number;
    skipped: number;
    total: number;
    flakyPercent: number;
    skippedPercent: number;
}): HTMLElement {
    const cell = (text: string, cls: string): HTMLElement =>
        el('div', { class: 'stat-item', children: [el('span', { class: cls, text })] });
    return el('div', {
        class: 'folder-stats',
        children: [
            cell(
                formatNumber(counts.flaky),
                counts.flaky > 0 ? 'stat-value is-flaky' : 'stat-value is-zero'
            ),
            cell(
                formatPercent(counts.flakyPercent),
                counts.flaky > 0 ? 'stat-value' : 'stat-value is-zero'
            ),
            cell(
                formatNumber(counts.skipped),
                counts.skipped > 0 ? 'stat-value is-skipped' : 'stat-value is-zero'
            ),
            cell(
                formatPercent(counts.skippedPercent),
                counts.skipped > 0 ? 'stat-value' : 'stat-value is-zero'
            ),
            cell(formatNumber(counts.total), 'stat-value is-muted'),
        ],
    });
}

/** One row of the tree: a folder, or a test file inside one. */
function folderRow(row: FolderRow): HTMLElement {
    const name = el('div', { class: 'folder-name' });
    const indent = el('span', { class: 'folder-indent' });
    // 16px a level: deep enough to read as a tree, shallow enough that
    // `dom/base/test/chrome` still leaves room for the name.
    //
    // A test row's `depth` is **already** one deeper than the folder holding
    // it, because `visibleRows` emits a folder's own files from inside the
    // recursion that opened it. Adding a step for `kind === 'test'` here as
    // well double-indented every file by 16px, which lined a folder's tests up
    // under its *subfolders* rather than under the folder itself.
    indent.style.width = `${row.depth * 16}px`;
    name.append(indent);

    if (row.kind === 'test') {
        name.append(el('span', { class: 'test-icon' }));
        // No link to the folder holding it. A `…/` was tried and removed: a
        // test row only ever appears under the folder row that was expanded to
        // show it, and that row's name is already the link — so the `…/`
        // duplicated a link one line above itself, as two cryptic characters.
        // The test name is a link to `test.html`, which is the page that
        // answers "why is this one flaky". A new tab, because the reader is
        // working down a list of candidates here and following one in place
        // would lose their expanded tree and their place in it.
        //
        // `externalLink` is reused for exactly this: it sets `target=_blank`
        // and stops the click from reaching the row underneath.
        const link = externalLink(testPageUrl(row.path), row.name, 'folder-label test-link');
        name.append(link);
        if (row.test?.neutralised === true) {
            name.append(
                el('span', {
                    class: 'folder-count is-note',
                    title:
                        `Failed ${formatNumber(row.test.windowFailures)} time(s) in the whole ` +
                        'window, so the noise filter counts those runs as passes.',
                    text: 'noise-filtered',
                })
            );
        }
    } else {
        name.append(
            el('span', {
                class: row.expandable
                    ? row.expanded
                        ? 'folder-icon expanded'
                        : 'folder-icon'
                    : 'folder-icon leaf',
            })
        );
        // The folder's **name is the link** to its tests, rather than an icon
        // beside it: the name already says the destination is a folder, and a
        // row carrying a 🔍 and a 📉 next to its name stops reading as a name.
        // The row still expands on click — `folderLink` stops the anchor's
        // click from reaching it, so the two actions are distinguishable by
        // where you click.
        name.append(folderLink(row.path, row.name, 'folder-label'));
        name.append(
            el('span', {
                class: 'folder-count',
                text: `${formatNumber(row.testCount)} test${row.testCount === 1 ? '' : 's'}`,
            })
        );
    }
    name.append(searchfoxLink(row.path));

    const element = el('div', {
        class:
            `folder-row band-${flakyBand(row.flakyPercent)}` +
            `${row.kind === 'test' ? ' test-row' : ''}${row.expandable ? '' : ' is-leaf'}`,
        attrs: {
            'data-path': row.path,
            'data-depth': String(row.depth),
            'data-kind': row.kind,
        },
        children: [name, el('div', { class: 'folder-bar-cell', children: [splitBar(row)] }), statCells(row)],
    });
    // Flaky, then skipped, then stable — the order the tiles and the split bar
    // use, so the two states a reader is comparing are adjacent instead of
    // having the big stable number between them.
    //
    // `skipped` overlaps `flaky` here (see `OverlappingCounts`), so the three
    // deliberately do not add up to `total`; each is stated as a share of the
    // population rather than run together as if they partitioned it.
    element.title =
        `${row.path}\n` +
        `${formatNumber(row.flaky)} flaky, ` +
        `${formatNumber(row.skipped)} skipped, ` +
        `${formatNumber(row.stable)} always passing — of ${formatNumber(row.total)} ` +
        `test${row.total === 1 ? '' : 's'}`;

    if (row.expandable) {
        element.addEventListener('click', () => toggleFolder(row.path));
    }
    return element;
}

/**
 * One row of the flat list.
 *
 * The numbers here are the folder's **own** tests, not its subtree's — see
 * `listRows`. The subtree total is still shown, as the muted "in tree" note, so
 * a reader can tell a directory holding 40 flaky tests from one whose children
 * hold them.
 */
function listRow(row: ListRow): HTMLElement {
    const isExpanded = expanded.has(row.path);
    const name = el('div', { class: 'folder-name' });
    // The list is flat, but a row still opens — to its own test files and its
    // history. Without this a burndown candidate named a folder and then made
    // the reader switch to the tree and walk down to it to see what was in it.
    name.append(el('span', { class: isExpanded ? 'folder-icon expanded' : 'folder-icon' }));
    name.append(folderLink(row.path, row.path, 'folder-label'));
    if (row.flaky !== row.selfFlaky) {
        name.append(
            el('span', {
                class: 'folder-count',
                title: 'Flaky tests in this folder and everything below it.',
                text: `${formatNumber(row.flaky)} in tree`,
            })
        );
    }
    name.append(searchfoxLink(row.path));

    // The bar shows the subtree's split, which is the one whose three parts sum
    // to 100% — the `self*` counters are flaky-vs-rest and have no skip share
    // of their own to draw.
    const element = el('div', {
        class: `folder-row band-${flakyBand(row.selfFlakyPercent)}`,
        attrs: { 'data-path': row.path, 'data-kind': 'list' },
        children: [
            name,
            el('div', {
                class: 'folder-bar-cell',
                children: [
                    splitBar({
                        flakyPercent: row.total > 0 ? (row.flaky / row.total) * 100 : 0,
                        stablePercent: row.total > 0 ? (row.stable / row.total) * 100 : 0,
                        skippedPercent: row.skippedPercent,
                    }),
                ],
            }),
            statCells({
                flaky: row.selfFlaky,
                skipped: row.skipped,
                total: row.selfTotal,
                flakyPercent: row.selfFlakyPercent,
                skippedPercent: row.skippedPercent,
            }),
        ],
    });
    // The tooltip only says what is true of *this* row.
    //
    // It used to always mention "in the whole subtree" and "click to list
    // them" — but most rows in the flat list are leaf directories with no
    // subfolders, so the subtree sentence repeated the same number twice, and a
    // folder whose flaky tests are all clean-filtered has nothing to list.
    const lines = [row.path];
    lines.push(
        `${formatNumber(row.selfFlaky)} of ${formatNumber(row.selfTotal)} tests here were flaky.`
    );
    if (row.flaky !== row.selfFlaky) {
        // Only worth saying when the subtree holds more than this folder does.
        lines.push(`${formatNumber(row.flaky)} flaky in this folder and everything below it.`);
    }
    const listable = tree !== null && (findFolder(tree, row.path)?.tests.some(
        (leaf) => leaf.flaky > 0 || leaf.skipped > 0
    ) ?? false);
    if (listable) {
        lines.push('Click to list them and show this folder’s history.');
    }
    element.title = lines.join('\n');
    if (listable) {
        element.addEventListener('click', () => toggleFolder(row.path));
    } else {
        // Nothing to open: no pointer cursor and no dead click.
        element.classList.add('is-leaf');
        const icon = element.querySelector('.folder-icon');
        icon?.classList.add('leaf');
    }
    return element;
}

/** The 🔍 Searchfox link for a folder. */
function searchfoxLink(path: string): HTMLElement {
    const link = externalLink(
        `https://searchfox.org/mozilla-central/source/${path}`,
        '🔍',
        'action-button'
    );
    link.title = `Open ${path} in Searchfox`;
    return link;
}

/**
 * A folder's name, linking to its tests on `tests.html`.
 *
 * This page ranks the tree and says *where* the work is; `tests.html` answers
 * the next question for one path — which of its tests still fail, over a range
 * of days a reader picks. So the link is on the thing that named the folder.
 *
 * **The name itself, not an icon beside it.** A 📉 was tried and is worse: the
 * name already says the destination is a folder, and a row with a 🔍 and a 📉
 * trailing it reads as a row of buttons rather than as a path. The colour is
 * the page's link blue only on hover, so the table still reads as a list of
 * folders.
 *
 * The click is stopped from reaching the row, which expands it — so clicking
 * the name navigates and clicking anywhere else opens in place.
 */
function folderLink(path: string, text: string, className: string): HTMLElement {
    const link = el('a', {
        class: `${className} folder-link`,
        text,
        title: `Tests in ${path}`,
        href: folderPageUrl(path),
    });
    link.addEventListener('click', (event) => event.stopPropagation());
    return link;
}

/** The total row, which is the tree's root. */
function totalRow(root: FolderNode): HTMLElement {
    const percent = flakyPercentage(root);
    return el('div', {
        class: 'folder-row total-row',
        children: [
            el('div', {
                class: 'folder-name',
                children: [
                    el('span', { class: 'folder-label', text: '📊 All folders' }),
                    el('span', {
                        class: 'folder-count',
                        text: `${formatNumber(root.testCount)} tests`,
                    }),
                    // Which window this row covers, spelled out next to the
                    // number. The table is the whole window and the tiles above
                    // are an average of the last few days, so the two totals
                    // legitimately differ — 3,867 against 923 on the pinned
                    // file — and each has to say which it is.
                    el('span', {
                        class: 'folder-scope',
                        title:
                            'The table counts a test as flaky if it was flaky on any day of ' +
                            'this window. The tiles at the top average the last few days ' +
                            'instead, so they are a smaller number.',
                        text:
                            tableAllDays && series !== null
                                ? `flaky on any of ${series.days.length} days`
                                : 'this day',
                    }),
                ],
            }),
            el('div', {
                class: 'folder-bar-cell',
                children: [
                    splitBar({
                        flakyPercent: percent,
                        stablePercent: root.total > 0 ? (root.stable / root.total) * 100 : 0,
                        skippedPercent: root.total > 0 ? (root.skipped / root.total) * 100 : 0,
                    }),
                ],
            }),
            statCells({
                flaky: root.flaky,
                skipped: root.skipped,
                total: root.total,
                flakyPercent: percent,
                skippedPercent: root.total > 0 ? (root.skipped / root.total) * 100 : 0,
            }),
        ],
    });
}

/** Rebuilds the folder table, in whichever mode is active. */
function renderTable(): void {
    const target = byId('folder-table');
    target.textContent = '';
    if (tree === null) {
        return;
    }

    const searchTerm = searchBoxManager?.getValue() ?? '';
    target.append(tableHeader());
    target.append(totalRow(tree));

    pendingCharts = [];

    if (tableMode === 'list') {
        renderedRows = [];
        renderedList = listRows(tree, currentSort, searchTerm);
        if (renderedList.length === 0) {
            target.append(emptyState(searchTerm));
            return;
        }
        for (const row of renderedList) {
            target.append(listRow(row));
            // An expanded row shows its history and the tests behind its count.
            if (expanded.has(row.path)) {
                const chart = inlineChart(row.path);
                if (chart !== null) {
                    target.append(chart);
                }
                for (const test of testsOfFolder(tree, row.path, currentSort)) {
                    target.append(folderRow({ ...test, depth: 1 }));
                }
                const node = findFolder(tree, row.path);
                if (node !== null) {
                    const hidden = hiddenCleanTests(node);
                    if (hidden > 0) {
                        target.append(cleanTestsNote(hidden, 1));
                    }
                }
            }
        }
        drawPendingCharts();
        return;
    }

    renderedList = [];
    renderedRows = visibleRows(tree, expanded, currentSort, searchTerm);
    if (renderedRows.length === 0) {
        target.append(emptyState(searchTerm));
        return;
    }
    for (const [index, row] of renderedRows.entries()) {
        target.append(folderRow(row));
        // The chart goes directly under the folder it describes, before that
        // folder's children — the placement `issues.html` uses.
        //
        // Only for a folder the **reader** opened. A search opens the branches
        // down to its matches, and drawing a chart for each of those turned one
        // search for `browser` into 33 charts nobody asked for.
        if (row.kind === 'folder' && row.expanded && expanded.has(row.path)) {
            const chart = inlineChart(row.path);
            if (chart !== null) {
                target.append(chart);
            }
        }
        // The "N clean tests not listed" note belongs after the **last** test
        // row of the folder that owns them, which is the row before the next
        // one at the same depth or shallower. Emitting it with the folder
        // instead would put it above its own tests.
        if (row.kind === 'test') {
            const next = renderedRows[index + 1];
            const isLastOfFolder =
                next === undefined || next.kind !== 'test' || next.depth !== row.depth;
            if (isLastOfFolder) {
                const hidden = hiddenCleanTests(row.node);
                if (hidden > 0) {
                    target.append(cleanTestsNote(hidden, row.depth));
                }
            }
        }
    }
    drawPendingCharts();
}

/**
 * The inline history chart for one expanded folder.
 *
 * The equivalent of `issues.html`'s per-component chart, and what replaced the
 * per-day table selector. Two lines on one small plot — the folder's flaky share
 * and its skip share, day by day — because that is the comparison a reader
 * opening a folder is making, and a stacked count chart at this size would show
 * the folder's population rather than its trend.
 *
 * Drawn **after** the element is in the document, for the reason Chart.js
 * needs: a detached canvas has no size to lay a chart out in. `issues.html`
 * does the same in two passes for the same reason.
 */
function inlineChart(path: string): HTMLElement | null {
    if (decoded === null || series === null || !inlineChartVisible(series.days)) {
        return null;
    }
    const own = flakinessOfPath(decoded, path, { minWindowFailures });
    if (!inlineChartVisible(own.days)) {
        return null;
    }
    const id = `inline-chart-${path.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const holder = el('div', {
        class: 'inline-chart',
        children: [
            el('div', {
                class: 'inline-chart-title',
                text: `${path} — ${own.days.length}-day history`,
            }),
            el('canvas', { id, class: 'inline-chart-canvas' }),
        ],
    });
    // The series is attached so the draw pass after insertion does not recompute
    // it — walking every test under a deep folder twice is the expensive part.
    pendingCharts.push({ id, days: own.days });
    return holder;
}

/** Charts whose canvas is in the document but not yet drawn into. */
let pendingCharts: { id: string; days: FlakyDay[] }[] = [];

/** Draws every chart queued by `inlineChart`, now that the DOM is in place. */
function drawPendingCharts(): void {
    const Chart = chartJs();
    const queued = pendingCharts;
    pendingCharts = [];
    if (Chart === undefined) {
        return;
    }
    for (const { id, days } of queued) {
        const canvas = document.getElementById(id) as HTMLCanvasElement | null;
        if (canvas === null) {
            continue;
        }
        Chart.getChart(canvas)?.destroy();
        const line = (
            label: string,
            values: number[],
            colour: string,
            dashed = false
        ): Record<string, unknown> => ({
            label,
            data: values,
            borderColor: colour,
            backgroundColor: colour,
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
            tension: 0.3,
            ...(dashed ? { borderDash: [4, 3] } : {}),
        });
        const flaky = days.map((day) => (day.total > 0 ? (day.flaky / day.total) * 100 : 0));
        const skipped = days.map((day) => (day.total > 0 ? (day.skipped / day.total) * 100 : 0));
        // Headroom over the data rather than a fixed 0-100 axis.
        //
        // Two lines on a 0-100 axis read as two parts of one whole — a line at
        // 68% and one at 14% look like a stacked bar, which is what made these
        // charts look broken even though `flaky + skipped` ranges from 14% to
        // 83% here and varies per folder. Scaling to the data makes the two
        // lines' independence visible, and the axis maximum is rounded up to a
        // multiple of 10 so neighbouring folders' charts still compare.
        const peak = Math.max(...flaky, ...skipped, 1);
        const suggestedMax = Math.min(100, Math.ceil((peak * 1.15) / 10) * 10);

        new Chart(canvas, {
            type: 'line',
            data: {
                labels: days.map((day) => day.date.slice(5)),
                datasets: [
                    line('Flaky %', flaky, COLOURS.flaky),
                    line('Skipped %', skipped, COLOURS.skipped, true),
                ],
            },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } },
                    y: {
                        beginAtZero: true,
                        suggestedMax,
                        ticks: { callback: (value: number) => `${value}%`, maxTicksLimit: 4 },
                    },
                },
                plugins: {
                    legend: { display: true, position: 'bottom', labels: { boxWidth: 10 } },
                    tooltip: {
                        callbacks: {
                            label: (item: {
                                dataset: { label?: string };
                                parsed: { y: number | null };
                            }): string =>
                                `${item.dataset.label ?? ''}: ${(item.parsed.y ?? 0).toFixed(1)}%`,
                        },
                    },
                },
            },
        });
    }
}

/**
 * The "N tests are not listed because they passed" line.
 *
 * A listing shorter than the count on the folder row above it is a discrepancy
 * a reader will otherwise try to explain — and the honest explanation is short,
 * so it is stated in place rather than left to the page's preamble.
 */
function cleanTestsNote(hidden: number, depth: number): HTMLElement {
    const note = el('div', {
        class: 'clean-note',
        text: `${formatNumber(hidden)} more test${hidden === 1 ? '' : 's'} here passed everywhere — not listed.`,
    });
    note.style.paddingLeft = `${12 + (depth + 1) * 16}px`;
    return note;
}

/** What the table shows when nothing matches. */
function emptyState(searchTerm: string): HTMLElement {
    return el('div', {
        class: 'no-data',
        text:
            searchTerm.trim() === ''
                ? 'No folders to show.'
                : `Nothing matches “${searchTerm.trim()}”.`,
    });
}

/**
 * Opens or closes a folder.
 *
 * The whole table is re-rendered rather than the subtree spliced in, unlike
 * `issues.html`'s expansion. The reason is the sort: a row's children are
 * ordered by the active column, and a splice would have to reproduce the
 * ordering logic that `visibleRows` already owns. The tables are small — the
 * pinned window's deepest fully-expanded xpcshell tree is a few thousand rows
 * and only ever a few hundred are open at once — so rebuilding is imperceptible
 * and there is one code path for what the table looks like.
 */
function toggleFolder(path: string): void {
    if (expanded.has(path)) {
        // Closing a folder closes everything under it, so reopening it does not
        // restore a subtree the reader had left in a state they cannot see.
        for (const open of [...expanded]) {
            if (open === path || open.startsWith(`${path}/`)) {
                expanded.delete(open);
            }
        }
    } else {
        expanded.add(path);
    }
    renderTable();
    updateUrlHash();
}

// --- the day selector under the chart -------------------------------------

/**
 * Rebuilds the "which day is the table showing" control.
 *
 * The chart is the window and the table is one day of it, which is a
 * relationship the page has to make explicit or the two read as disagreeing:
 * the chart's last point and the table's totals are the same numbers, and a
 * reader who does not know that will think one of them is wrong.
 */
function renderTableControls(): void {
    const target = byId('table-controls');
    target.textContent = '';
    if (series === null || decoded === null) {
        return;
    }

    // The tree/list switch, which applies in every mode.
    const modes = el('div', { class: 'mode-switch' });
    for (const [mode, label, hint] of [
        ['tree', 'Tree', 'Drill down through the directory tree.'],
        ['list', 'Flat list', 'Every folder ranked by its own flaky tests — burndown candidates.'],
    ] as const) {
        const button = el('button', {
            class: tableMode === mode ? 'mode-button active' : 'mode-button',
            attrs: { 'data-mode': mode },
            title: hint,
            text: label,
        });
        button.addEventListener('click', () => {
            if (tableMode === mode) {
                return;
            }
            tableMode = mode;
            renderTableControls();
            renderTable();
            updateUrlHash();
        });
        modes.append(button);
    }
    target.append(modes);

    // What window the table covers, as a statement rather than a control.
    //
    // There used to be a per-day `<select>` here. It went because it answered
    // the wrong question: a reader comparing a folder's history had to re-read
    // the whole table once per date and hold the numbers in their head. The
    // inline chart under an expanded row answers it directly, so the table
    // covers one window — the whole file — and the history is per folder.
    if (!isHistoricalMode) {
        target.append(
            el('span', {
                class: 'table-scope',
                text: `Showing ${series.days[0]?.date ?? decoded.endDate}.`,
            })
        );
        return;
    }
    target.append(
        el('span', {
            class: 'table-scope',
            text: `Showing all ${series.days.length} days.`,
        })
    );
    target.append(
        el('span', {
            class: 'table-scope-note',
            text: 'Each test counts once, flaky if it was flaky on any day. Open a folder for its history.',
        })
    );
}

// --- deriving ---------------------------------------------------------------

/** Recomputes the folder tree for the current day selection. */
function rebuildTree(): void {
    if (decoded === null) {
        tree = null;
        return;
    }
    tree = flakinessByFolder(decoded, {
        minWindowFailures,
        ...(tableAllDays ? { allDays: true } : { day: tableDay ?? undefined }),
    });
}

/**
 * Logs what the merge found where the two sources overlap.
 *
 * The overlap is the **only** place the committed file and the live artifact can
 * be compared, so it is checked rather than silently resolved — the same
 * reasoning `mergeBackfillStats` states for `index.html`, where the check found
 * 446 real disagreements and told the reader which direction they went.
 *
 * A disagreement here is expected to be small and is not an error: the two
 * sources classify a shared date over *different* 21 days, and the noise filter
 * reads a test's failures over the whole window, so a test that failed once in
 * one window can have failed twice in the other. Measured between two published
 * xpcshell aggregates sharing 19 dates, the flaky count differs by 0–24 tests,
 * median 2. The largest gap is logged with the count so that "a few tests" and
 * "a few hundred" — the second of which would be a decoding bug — do not read the
 * same in the console.
 *
 * Once per load, not once per redraw: the noise control and every table
 * interaction call `recompute`, and repeating the same line on each would bury
 * it.
 */
function reportSeam(merge: FlakyBackfillMerge<FlakyDay>): void {
    if (seamReported) {
        return;
    }
    seamReported = true;
    console.log(
        `Flaky charts: ${merge.backfilled} day(s) from the committed backfill, ` +
            `${merge.days.length - merge.backfilled} live, ` +
            `${merge.overlapping} date(s) in both.`
    );
    if (merge.disagreements.length === 0) {
        return;
    }
    const worst = merge.disagreements.reduce((a, b) =>
        Math.abs(a.backfill - a.live) >= Math.abs(b.backfill - b.live) ? a : b
    );
    console.warn(
        `Flaky charts: the committed backfill disagrees with the live artifact on ` +
            `${merge.disagreements.length} value(s) over ${merge.overlapping} overlapping ` +
            `date(s) (live wins). Largest: ${worst.date} ${worst.key} ` +
            `backfill=${worst.backfill} live=${worst.live}. A few tests is the noise ` +
            `filter's window moving; hundreds would be a decoding bug.`
    );
}

/**
 * The days the two charts at the top plot: the live series, with the committed
 * history joined on in front of it.
 *
 * **Only the charts.** The headline tiles average the last 7 days and the table
 * rolls tests up by folder, and both need the *decoded* file — a backfill row is
 * four integers with no tests in it, so there is nothing for a folder to be built
 * from and nothing older than the artifact for a tile to average. Extending the
 * charts is the whole benefit and it is the only part the four numbers support.
 *
 * The backfill is dropped in three cases, each of which would otherwise put a
 * step at the seam that is an artefact rather than a fact:
 *
 * - **a single-day view.** A daily file is one point; there is no chart, and
 *   splicing 250 days of a *different* classification in front of it would draw a
 *   year of history and label it with one date.
 * - **a noise threshold the backfill was not built with.** The filter's answer
 *   depends on the threshold, so at threshold 3 the live days would be filtered
 *   and the backfilled ones would not. `MIN_FILTERABLE_DAYS` measures how far
 *   apart two thresholds can put the same day: 923 against 562.
 * - **a window length that is not the backfill's.** Same argument, for the other
 *   half of the filter's input.
 */
function chartDays(): FlakyDay[] {
    if (series === null) {
        return [];
    }
    const live = series.days;
    if (
        backfill === null ||
        live.length <= 1 ||
        series.minWindowFailures !== backfill.metadata.minWindowFailures ||
        live.length !== backfill.metadata.windowDays
    ) {
        return [...live];
    }
    const merged = mergeFlakyBackfill(backfill.days, live, (row, index) => ({
        ...row,
        day: index,
    }));
    reportSeam(merged);
    return merged.days;
}

/** Recomputes everything from the loaded file and repaints. */
function recompute(): void {
    if (decoded === null) {
        return;
    }
    series = flakinessOverTime(decoded, { minWindowFailures });
    // The table covers whatever window was loaded: the whole aggregate, or the
    // one day a daily file holds. There is no per-day selector any more — see
    // `renderTableControls`.
    tableAllDays = series.days.length > 1;
    tableDay = tableAllDays ? null : 0;
    rebuildTree();
    renderHeadline();
    // One day is one point: there is no trend to draw, and an empty plot reads
    // as a broken page. The tiles and the table carry the whole answer there.
    const hasSeries = series.days.length > 1;
    setChartsVisible(hasSeries);
    if (hasSeries) {
        drawCharts(chartSeries(chartDays()));
    }
    renderTableControls();
    renderTable();
}

// --- the noise control ----------------------------------------------------

/** Wires the noise-threshold input. */
function initNoiseControl(): void {
    const input = byId('noise-threshold') as HTMLInputElement;
    input.value = String(minWindowFailures);
    input.addEventListener('change', () => {
        const value = Number(input.value);
        minWindowFailures = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
        input.value = String(minWindowFailures);
        recompute();
        updateUrlHash();
    });
}

// --- data loading ---------------------------------------------------------

/**
 * The committed history's request, per harness, as a **literal** `fetch`.
 *
 * The obvious spelling is `fetch(`./${harness}-flaky-backfill.json`)`, and it is
 * wrong here in a way that fails silently. `tools/page-assets.ts` discovers the
 * siblings a built page needs by matching `fetch('./name.json')` in the bundle,
 * so a computed URL is invisible to it, the file is never copied into
 * `dist-site/`, and the page's own best-effort handling turns the resulting 404
 * into "there is no backfill". That is precisely the bug `page-assets.ts` was
 * written for — measured there as a chart quietly showing 68 points instead of
 * 200 — and it reproduced here: `npm run pages` copied 7 assets for `flaky.html`
 * and neither backfill was among them.
 *
 * So the two URLs are literals and the harness selects between them. Two lines
 * of duplication buys a build that fails when a file goes missing.
 */
const BACKFILL_FETCHES: Record<string, () => Promise<Response>> = {
    // build-optional: xpcshell-flaky-backfill.json — best-effort history for the
    // charts. Optional because the *page* works without it: a deployment that
    // has not run `tools/build-flaky-backfill.ts` should build with 21-day
    // charts rather than fail.
    xpcshell: () => fetch('./xpcshell-flaky-backfill.json'),
    // build-optional: mochitest-flaky-backfill.json — the same, for the other
    // harness.
    mochitest: () => fetch('./mochitest-flaky-backfill.json'),
};

/**
 * Loads the committed history, best-effort.
 *
 * A plain `fetch` of a sibling and not `fetchData`, because the file travels with
 * the page rather than being published by CI — the arrangement `site/index.ts`
 * already uses for `mochitest-stats-backfill.json`.
 *
 * **Best-effort by design**, matching `loadHarness` in `site/index.ts`: a 404 or
 * an unparseable body leaves `backfill` at `null` and the charts show the 21 days
 * they showed before. Both harnesses have a file committed today, so unlike
 * `index.html`'s xpcshell request this is not *expected* to miss — but a page
 * whose charts silently shorten is a far better failure than one that shows an
 * error box over a working table.
 *
 * The response is validated past `ok`: a static server that answers every path
 * with `index.html` would otherwise put an HTML parse error in the console and,
 * worse, a body with the right keys and wrong meaning would merge. So the
 * harness and the four counters are checked before it is used.
 */
async function loadBackfill(harness: string): Promise<void> {
    const request = BACKFILL_FETCHES[harness];
    if (request === undefined) {
        // A third harness would reach here. Not an error: it means no history
        // has been built for it, which is the same state as a 404.
        console.log(`No flaky backfill is built for ${harness}.`);
        return;
    }
    try {
        const response = await request();
        if (!response.ok) {
            console.log(`No ${harness} flaky backfill: HTTP ${response.status}`);
            return;
        }
        const file = (await response.json()) as FlakyBackfillFile;
        if (file.metadata?.harness !== harness || !Array.isArray(file.days)) {
            console.warn(
                `Ignoring ${harness}-flaky-backfill.json: it says harness ` +
                    `${String(file.metadata?.harness)} and has ${typeof file.days} days.`
            );
            return;
        }
        backfill = file;
        console.log(
            `Loaded ${harness} flaky backfill: ${file.days.length} days ` +
                `${file.metadata.startDate}..${file.metadata.endDate}, ` +
                `${file.metadata.windowDays}-day windows, noise filter ` +
                `${file.metadata.minWindowFailures}.`
        );
    } catch (error) {
        console.log(`No usable ${harness} flaky backfill:`, (error as Error).message);
    }
}

/** Loads one day's file. */
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
        decoded = decodeDaily(file);
        // A daily file is one day: the table has nothing to choose between.
        tableAllDays = false;
        tableDay = 0;
        expanded.clear();
        recompute();
        const jobCount = file.metadata.jobCount ?? 0;
        setStatusText(`${jobCount.toLocaleString()} test jobs`);
    } catch (error) {
        showError(
            `Error loading data: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/** Enters or leaves the 21-day view. */
async function onHistoricalToggled(isHistorical: boolean, data: unknown): Promise<void> {
    isHistoricalMode = isHistorical;
    if (isHistorical) {
        const file = data as IssuesFile;
        decoded = decodeIssues(file);
        tableDay = null;
        expanded.clear();
        hideError();
        recompute();
        const days = file.metadata.days ?? 21;
        setStatusText(`${days} days (${file.metadata.startDate} to ${file.metadata.endDate})`);
    } else {
        await loadSelectedDate();
    }
    hashManager?.updateHash();
}

// --- URL state ------------------------------------------------------------

function updateUrlHash(): void {
    hashManager?.updateHash();
}

/** Applies the hash to the page. */
async function loadFromUrlHash(): Promise<void> {
    if (hashManager === undefined) {
        return;
    }
    const state = readUrlState(hashManager.getParams());

    const box = document.getElementById('search-box');
    if (document.activeElement !== box) {
        searchBoxManager.setValue(state.q ?? '');
    }
    if (state.noise !== undefined) {
        const value = Number(state.noise);
        if (Number.isFinite(value) && value >= 0) {
            minWindowFailures = Math.floor(value);
            (byId('noise-threshold') as HTMLInputElement).value = String(minWindowFailures);
        }
    }
    tableMode = parseTableMode(state.view);
    for (const path of parseOpen(state.open)) {
        // Every ancestor too, or a deep folder would be "open" with no visible
        // parent to have opened it from.
        for (const ancestor of ancestorPaths(path)) {
            expanded.add(ancestor);
        }
    }

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
    initHarnessSwitcher('Flakiness');
    initNoiseControl();

    searchBoxManager = searchBox({
        searchBoxId: 'search-box',
        searchClearId: 'search-clear',
        onSearch: renderTable,
        updateUrlHash,
    });

    hashManager = initUrlHashManager({
        getState: () => {
            const state: Record<string, string> = {
                date: isHistoricalMode ? HISTORICAL_DATE : dateSelect().value,
                q: searchBoxManager.getValue().trim(),
                open: [...expanded].join(','),
            };
            if (minWindowFailures !== DEFAULT_MIN_WINDOW_FAILURES) {
                state['noise'] = String(minWindowFailures);
            }
            if (tableMode !== DEFAULT_TABLE_MODE) {
                state['view'] = tableMode;
            }
            return state;
        },
        onHashChange: async () => {
            searchBoxManager.setNavigating(true);
            const wasHistorical = isHistoricalMode;
            const previousDate = dateSelect().value;
            await loadFromUrlHash();
            if (!isHistoricalMode) {
                if (dateSelect().value !== previousDate || wasHistorical !== isHistoricalMode) {
                    await loadSelectedDate();
                } else {
                    renderTable();
                }
            } else {
                renderTable();
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
}

/** Wires the page up and loads it. Called by the page, not by importing it. */
export async function start(): Promise<void> {
    initializeUI();

    // The backfill request goes out **before** the date selector is awaited, so
    // the two round trips overlap — `site/index.ts` arranges its four the same
    // way and for the same reason. It is a 21-27 kB committed sibling against a
    // 2.8 MB published aggregate, so it is never the request that is waited on.
    const backfillLoaded = loadBackfill(getHarnessType());

    const hasData = await populateDateSelector({
        selectId: 'date-select',
        statusTextId: 'status-text',
        fetchData,
    });
    if (!hasData) {
        showError('No data available. Please run: node fetch-xpcshell-data.js');
        return;
    }

    const select = dateSelect();
    if (!select.value && select.options.length > 0) {
        select.selectedIndex = 0;
    }

    // Awaited before anything draws, so the first paint of the charts already has
    // the history in it. Drawing 21 days and then redrawing 250 would be a
    // visible jump on every load for no gain — the fetch has been in flight
    // since the top of this function.
    await backfillLoaded;

    // The 21-day window is the default, as on `issues.html` since its migration.
    await loadFromUrlHash();
    if (!isHistoricalMode) {
        await loadSelectedDate();
    }
    updateUrlHash();
}

/** The view model, for the tests. */
declare global {
    interface Window {
        __flakyView?: () => unknown;
    }
}
window.__flakyView = () => ({
    historical: isHistoricalMode,
    minWindowFailures,
    tableAllDays,
    tableDay,
    sort: currentSort,
    expanded: [...expanded],
    days: series?.days ?? [],
    // The charts plot more days than the table and the tiles do — see
    // `chartDays`. Reported separately so a test can assert the seam without
    // having to re-derive the merge.
    chartDays: chartDays().map((day) => day.date),
    backfillDays: backfill?.days.length ?? 0,
    neutralisedTests: series?.neutralisedTests ?? 0,
    rows: renderedRows.map((row) => ({
        path: row.node.path,
        depth: row.depth,
        flaky: row.node.flaky,
        stable: row.node.stable,
        skipped: row.node.skipped,
        total: row.node.total,
        percent: row.flakyPercent,
        band: flakyBand(row.flakyPercent),
    })),
});
