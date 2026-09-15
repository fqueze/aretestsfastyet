/**
 * `manifests.html`, migrated onto `lib/`.
 *
 * | file | contains | tested by |
 * | --- | --- | --- |
 * | `lib/formats/manifests.ts` | the file format, shared with the CLI | `test/formats.test.ts` |
 * | `lib/query/manifest-stats.ts` | the CLI's answer to the same question | `test/step5-query.test.ts` |
 * | `site/manifests-view.ts` | this page's view model — aggregation, sorting, filtering, paging, URL state | `test/manifests-view.test.ts`, no DOM |
 * | this file | the renderer, the Plotly charts and the interactions | `test/manifests-page.test.ts` + the browser run |
 * | | the two sides against each other | `test/manifests-parity.test.ts` |
 *
 * ## The shared drill-down was considered and **not** used
 *
 * `site/drilldown-view.ts` / `drilldown-render.ts` were extracted for
 * `crashes.html` and `failures.html`. The judgement, with the table of shape
 * differences behind it, is at the top of `site/manifests-view.ts`. In one
 * line: that drill-down's bottom level is an **occurrence rendered as a table
 * row**, and this page's bottom level is a **`<td colspan=5>` holding a Plotly
 * scatter** — there is no per-run row here at all. Add to that two search
 * boxes rather than one, fixed 50-row paging rather than virtualization,
 * duration statistics with a genuine absent case rather than counts, and a
 * middle level that is a job name with no path structure to collapse.
 *
 * What **is** reused, because it really is page-independent: `drilldown-render`'s
 * `el()` and `noData()`, and its `declare global` block describing the shared
 * scripts. `el()` is the one that earns its keep — it answers the escaping
 * question once, which is what lets this file delete the old page's
 * `escapeHtml`/`escapeAttr` pair and its eleven `innerHTML` assignments.
 *
 * ## What the migration removes
 *
 * **The string-concatenation renderer.** Upstream builds each cell by
 * concatenating HTML into `innerHTML` (`old/manifests.html:651`, `:664`, `:702`,
 * `:741`, and six more), which is what forces `escapeHtml` (`:866`) and
 * `escapeAttr` (`:872`). `escapeAttr` is **dead on this page** — measured:
 * `grep -c escapeAttr manifests.html` is 1, its own definition, and no call
 * site exists. Both are gone.
 *
 * **The global functions the markup calls.** `sortBy`, `prevPage`, `nextPage`,
 * `clearSearch`, `updateClearButtons` and `filterManifests` are `onclick=` /
 * `oninput=` attributes in upstream's markup, which is why they had to be
 * globals. See divergence 2 for what happens to them here.
 *
 * `common-test-data.js` is **not** loaded, and was not loaded before either:
 * `grep -c common-test-data manifests.html` is **0**.
 *
 * ## Plotly stays, and the charts are ported
 *
 * The brief asked for this to be a deliberate decision rather than a default,
 * and it was made by measuring the old page rather than by reading it: driven
 * in Chrome against the pinned 2026-08-04 file, expanding a manifest and then a
 * job produces **one** element carrying Plotly's `js-plotly-plot` class and a
 * `modebar`, so the chart is live and worth having rather than decoration.
 *
 * So the CDN tag stays (`site/manifests.html:7`, byte-identical to
 * `old/manifests.html:7`), the third level is ported, and the two click handlers on
 * it — plain click opens the resource profile, Alt+click the error summary —
 * are ported with it. Nothing here emits a chart element that never draws;
 * that mistake has been made twice on this project and the check against it is
 * `test/manifests-page.test.ts`'s assertion that a chart container is only ever
 * created together with a `Plotly.newPlot` call for the **same** id, plus the
 * browser run's count of `.js-plotly-plot` elements.
 *
 * `Plotly` is a CDN global here, exactly as it is upstream. Under jsdom there
 * is no CDN and no WebGL, so `test/manifests-page.test.ts` installs a recorder
 * in its place and asserts on what the page handed it — the same exception, and
 * for the same reason, that `test/dom-harness.ts` documents for Chart.js.
 *
 * ## Declared divergences from `manifests.html`
 *
 * `PARITY.md` §4: byte-identical is the default and every exception is
 * declared. **This list is the whole set** — one enumerated list, with no prose
 * elsewhere carrying an extra entry.
 *
 *  1. **The keystroke sort-flip is fixed, and with it the page's first paint.**
 *     This is the one behaviour change that a reader will see immediately, so
 *     it is first and it is measured.
 *
 *     Upstream's `filterManifests()` ends with `sortBy(currentSortColumn)`
 *     (`:611`). `sortBy` toggles the direction when handed the column already
 *     selected (`:488-490`), so *every* call flips the sort. `filterManifests`
 *     is called from `oninput` on both boxes (`:285`, `:295`), from
 *     `clearSearch` (`:563`) and from `loadData` (`:909`); `popstate` does the
 *     same thing inline (`:937`).
 *
 *     Measured in Chrome, pinned 2026-08-04, comparing the Median header's
 *     indicator and the first rows:
 *
 *     | step | old | new |
 *     | --- | --- | --- |
 *     | first paint | `▲` ascending | `▼` descending |
 *     | first paint, rows reading `SKIP` | **50 of 50** | **0 of 50** |
 *     | first paint, top row | `dom/payments/test/mochitest.toml`, SKIP | `/html/cross-origin-opener-policy`, 16m 2s |
 *     | typing `browser` | `▲` | `▼` |
 *     | one more key, `browsers` | `▼` | `▼` |
 *     | `history.back()` | `▼` → `▲` | `▼` |
 *
 *     The first paint is the reason this is fixed rather than reproduced. The
 *     302 manifests that ran nowhere have no median; upstream stores `0` for
 *     them, so an ascending sort puts all 302 first and they fill **six** pages
 *     of 50. The page exists to answer "which manifest is eating the budget",
 *     and it was opening on seven pages of manifests that did not run, under a
 *     header claiming the default was descending (`:361`).
 *
 *     The fix is in two parts, both in this file: filtering does not sort
 *     (`applyFilters` re-applies the *current* sort rather than calling the
 *     toggle), and a skipped manifest's sort value is `-1` rather than `0`
 *     (`columnValue` in the view model), so it sorts last under either
 *     direction rather than first under one of them.
 *
 *  2. **Inline handler attributes become `addEventListener`, and the eight in
 *     the markup now throw once each on use.** The markup is byte-identical, so
 *     `oninput="updateClearButtons(); filterManifests()"` on the two inputs,
 *     `onclick="clearSearch(…)"` on the two × spans, `onclick="sortBy(…)"` on
 *     the five headers and `onclick="prevPage()"` / `nextPage()` on the two
 *     buttons are all still attributes — but a module has no globals, so each
 *     is a `ReferenceError` and the listener attached by this file does the
 *     work.
 *
 *     Measured in Chrome on the pinned file: clicking a header logs exactly one
 *     `Uncaught ReferenceError: sortBy is not defined` and the table re-sorts
 *     correctly; typing one character logs one
 *     `updateClearButtons is not defined` and the table re-filters. This is the
 *     arrangement `site/crashes.html`, `site/failures.html` and
 *     `site/errors.html` already ship, and it is listed rather than fixed
 *     because fixing it means editing the markup, which the brief forbids.
 *
 *     Every handler the old page *generates* is gone: `row.onclick`
 *     (`:648`), `jobRow.onclick` (`:696`). Those were properties rather than
 *     attributes, so they do not appear in a count of `on*` attributes — the
 *     honest measurement is that the old page's rendered `#manifestTableBody`
 *     carries **0** `on*` attributes and this one also carries 0, and the
 *     difference is that upstream attaches one closure per row per render
 *     while this file attaches **one** delegated listener to the `<tbody>` for
 *     the life of the page.
 *
 *  3. **Next is disabled on an empty result.** Upstream computes
 *     `totalPages = Math.ceil(0 / 50) = 0`, renders `Page 1 of 0`, and disables
 *     Next only when `currentPage === totalPages` (`:757`) — which is `1 === 0`,
 *     false. Measured in Chrome: searching `zzzzznotamanifestzzzzz` leaves Next
 *     **enabled**, and clicking it does nothing at all, because `nextPage`
 *     guards separately with `currentPage < totalPages` (`:859-860`). A control
 *     that is enabled and inert is worse than a disabled one — a
 *     `DOM diff cannot tell a working control from an inert one`, which is
 *     exactly why this was found by clicking it rather than by reading it. The
 *     comparison is `>=` here. The `Page 1 of 0` text is **unchanged**.
 *
 *  4. **`currentPage = 1` takes effect before the render, not after.**
 *     Upstream assigns it *after* `sortBy` has already re-rendered
 *     (`:611-612`, and again at `:937-938`), so the first paint after a search
 *     or a `popstate` shows the old page number against the new result. Measured
 *     in Chrome: with `?job=wdspec` narrowed to 5 pages, going to page 2 and
 *     then pressing Back renders **"Page 2 of 5"** — the pager label, the
 *     disabled states and the 50 rows shown are all page 2 of a result the page
 *     has just decided starts at page 1. Any later render corrects it, which is
 *     what makes this hard to see and worth fixing. Here the page number is
 *     part of the state the render reads, so there is no window.
 *
 *  5. **The `manifest-row` / `job-row` click targets are delegated, and a click
 *     on a job row no longer needs `stopPropagation`.** Upstream attaches a
 *     handler to the manifest row and another to the job row, and the job
 *     handler must call `e.stopPropagation()` (`:697`) or expanding a job would
 *     also collapse its manifest. One delegated listener on the `<tbody>`
 *     resolves the *nearest* row and acts on that, so the two cannot both fire.
 *     Same behaviour, one listener; the `stopPropagation` is gone because there
 *     is nothing left to stop.
 *
 *  6. **Expansion state survives a re-render by identity, not by re-lookup.**
 *     Upstream re-renders the whole `<tbody>` on every toggle (`:636`) and
 *     re-derives which rows are open from two `Set`s of strings. This file does
 *     the same — the sets are the state — but the row elements are held in a
 *     `Map` to their rows so the click handler never has to find a row again by
 *     selector. No behaviour change; recorded because it is the mechanism the
 *     crashes/failures migration found a real quoting defect in.
 *
 *  7. **No tie-break is added to either sort.** Upstream's manifest comparator
 *     (`:495-506`) and job comparator (`:447-450`) both leave equal rows in
 *     input order, and `lib/query/manifest-stats.ts` breaks ties on the name.
 *     The page's behaviour is kept: adding a tie-break would reorder real rows
 *     against the page being compared, and the input order is deterministic
 *     (the file's own) so nothing reshuffles between reloads. This is a
 *     declared *non*-change, listed because the CLI comparison will show the
 *     two orders differing on ties.
 *
 *  8. **The median rule differs from the CLI's, and both are kept.** The page
 *     takes the upper middle element, `summarize` the nearest-rank quantile —
 *     the lower middle for an even sample. Measured on the pinned 2026-08-04
 *     file: **3,122 of 6,227** manifests get a different overall median. Not a
 *     divergence this migration introduces; it is a divergence this migration
 *     is the first to *measure*, and `test/manifests-parity.test.ts` pins it so
 *     it cannot drift into an accident. See the note at `medianOf`.
 *
 *     `test/framing.test.ts:437-440` says the opposite — "The CLI's `medianOf`
 *     matches it deliberately". There is no function called `medianOf` in
 *     `lib/` or `cli/` (there is now one in `site/manifests-view.ts`, added by
 *     this migration), and `test/step5-query.test.ts:401` pins the CLI's rule
 *     to nearest-rank with `[10 … 100] → 50`, where this page gives 60. That
 *     comment is wrong and is left alone only because `test/framing.test.ts`
 *     is outside this migration's write scope; it is reported rather than
 *     edited.
 *
 *  9. **Duration formatting stays the page's, which is not the CLI's.**
 *     `formatDuration` floors the seconds of a minute value and has no hour
 *     form, so `1m 59s` and `120m 0s`; `cli/commands/manifests.ts:459` rounds,
 *     pads, and has one. Presentation only — the underlying milliseconds are
 *     compared in the parity test, not the strings.
 *
 * 10. **The chart element id keeps its non-injective slug.** Two manifest names
 *     of the 6,227 collide under `[^a-z0-9] → -`. Kept; see `chartElementId`.
 *
 * 11. **The four stat cards are unchanged, and two of them do not describe the
 *     table.** Total Jobs is the length of the `jobNames` string table (4,165)
 *     where only 859 job names appear on a run, and Total Runs (494,380)
 *     counts the 78,957 zero-duration runs that every Runs cell excludes. This
 *     is upstream's meaning, reproduced exactly, and recorded because the
 *     numbers invite a comparison with the table that they do not survive.
 */

import type { ManifestsFile } from '../lib/formats/manifests.ts';
import { bindFilterShortcut, el, noData } from './drilldown-render.ts';
import {
    type Filters,
    type JobStats,
    type ManifestRow,
    type SortColumn,
    type SortState,
    DEFAULT_SORT,
    SORT_COLUMNS,
    buildManifestRows,
    chartElementId,
    errorSummaryUrl,
    filterJobs,
    filterRows,
    filtersToSearch,
    formatDuration,
    headlineStats,
    jobKey,
    nextSort,
    pageSlice,
    pageState,
    parseFilters,
    profilerUrl,
    scatterPoints,
    sortRows,
} from './manifests-view.ts';

// --- the globals this page uses, as they are ------------------------------
//
// `Plotly` is a CDN `<script>` tag (`site/manifests.html:7`), and the rest are
// the shared scripts the page loads by name. Declared rather than imported, for
// the reason `site/drilldown-render.ts` records: up to 22 unmigrated pages
// depend on these files as they are.

declare global {
    /** `shared.js:32` — the profiler origin, honouring `?profiler=`. */
    function getProfilerOrigin(): string;
    /**
     * `shared.js:270` — re-lays-out Plotly charts after a window resize.
     *
     * Called at startup, as upstream does (`old/manifests.html:941`). It looks up
     * `.chart-container`, and **this page has none** — `grep -c chart-container
     * manifests.html` is 0 — so its handler finds nothing on either side and
     * the charts are resized by Plotly's own `responsive: true` instead. Called
     * anyway, so that a future markup change gets the same behaviour the other
     * Plotly pages get, and recorded here so the next reader does not go
     * looking for what it does.
     */
    function setupWindowResize(): void;

    /** The CDN's Plotly, narrowed to what this page calls. */
    const Plotly: {
        newPlot(
            id: string,
            traces: readonly unknown[],
            layout: Record<string, unknown>,
            config: Record<string, unknown>
        ): Promise<unknown>;
    };
}

/** A Plotly graph div: `newPlot` decorates the element with an `on` method. */
interface PlotlyDiv extends HTMLElement {
    on?: (event: string, handler: (data: PlotlyClickData) => void) => void;
}

/** What a `plotly_click` hands back, narrowed to what is read. */
interface PlotlyClickData {
    points: { customdata?: { taskId: string; prefix: string } }[];
    event: { altKey: boolean };
}

// --- the page's state -----------------------------------------------------

/**
 * Everything the render reads.
 *
 * One object rather than eight module-level `let`s, which is what makes
 * divergence 4 impossible to reintroduce: the page number is *in* the state the
 * renderer reads, so there is no way to update it after a render the way
 * `:612` does.
 */
interface PageModel {
    /** Every manifest, unfiltered and unsorted. Built once. */
    all: ManifestRow[];
    /** The current result: filtered and sorted. */
    visible: ManifestRow[];
    filters: Filters;
    sort: SortState;
    /** 1-based. */
    page: number;
    /** Manifest paths whose job rows are showing. */
    expandedManifests: Set<string>;
    /** `manifest|||job` keys whose chart is showing. */
    expandedJobs: Set<string>;
}

let model: PageModel | null = null;

/** The elements the controller holds on to, looked up once in `start()`. */
interface Elements {
    manifestSearch: HTMLInputElement;
    jobSearch: HTMLInputElement;
    clearManifest: HTMLElement;
    clearJob: HTMLElement;
    tbody: HTMLElement;
    headers: HTMLElement[];
    pageInfo: HTMLElement;
    prev: HTMLButtonElement;
    next: HTMLButtonElement;
    loading: HTMLElement;
    error: HTMLElement;
    content: HTMLElement;
}

let dom: Elements | null = null;

/** Throws rather than returning null: a missing id is a broken page, loudly. */
function need<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (element === null) {
        throw new Error(`site/manifests.html is missing #${id}`);
    }
    return element as T;
}

// --- rendering ------------------------------------------------------------

/** A duration cell, or `SKIP` when the row has no runtime at all. */
function durationCell(ms: number | null): HTMLElement {
    return el('td', {
        children: [
            ms === null
                ? // `SKIP`, not `0ms`. The whole all-zero rule in one cell.
                  el('span', { class: 'time-value skip-label', text: 'SKIP' })
                : el('span', { class: 'time-value', text: formatDuration(ms) }),
        ],
    });
}

/** One manifest row. `old/manifests.html:646-679`. */
function manifestRowElement(row: ManifestRow, expanded: boolean): HTMLElement {
    return el('tr', {
        class: `manifest-row${expanded ? ' expanded' : ''}`,
        children: [
            el('td', {
                children: [
                    el('div', {
                        class: 'manifest-name',
                        children: [
                            el('span', {
                                class: `expand-icon${expanded ? ' expanded' : ''}`,
                            }),
                            el('span', { text: row.manifest }),
                        ],
                    }),
                ],
            }),
            // Plain text, no `.time-value` — as upstream (`:660`), which uses
            // `textContent` for this one cell and `innerHTML` for the rest.
            el('td', { text: row.totalJobs.toLocaleString() }),
            el('td', {
                children: [el('span', { class: 'time-value', text: row.totalRuns.toLocaleString() })],
            }),
            durationCell(row.overallMedian),
            durationCell(row.overallMean),
        ],
    });
}

/** One job row under an expanded manifest. `old/manifests.html:694-728`. */
function jobRowElement(job: JobStats, expanded: boolean): HTMLElement {
    return el('tr', {
        class: 'job-row',
        children: [
            el('td', {
                children: [
                    el('div', {
                        class: 'job-name-wrapper',
                        children: [
                            el('span', {
                                class: `job-expand-icon${expanded ? ' expanded' : ''}`,
                            }),
                            el('span', { class: 'job-name', text: job.jobName }),
                        ],
                    }),
                ],
            }),
            // Deliberately empty: a job row has no Job Types of its own, and
            // upstream sets `textContent = ''` (`:711`) rather than omitting
            // the cell, which is what keeps the five columns aligned.
            el('td', { text: '' }),
            el('td', {
                children: [el('span', { class: 'time-value', text: job.runCount.toLocaleString() })],
            }),
            durationCell(job.median),
            durationCell(job.mean),
        ],
    });
}

/**
 * The chart row for an expanded job. `old/manifests.html:734-744`.
 *
 * Returns the `<tr>` and the container the chart draws into, so the caller can
 * hand the *element* to Plotly's caller without a second `getElementById`. The
 * id is still set, because `Plotly.newPlot` takes an id (`:809`) and because
 * the browser comparison reads it.
 */
function chartRowElement(
    row: ManifestRow,
    job: JobStats
): { tr: HTMLElement; container: HTMLElement } {
    const container = el('div', { id: chartElementId(row.manifest, job.jobName) });
    container.style.height = '400px';
    return {
        tr: el('tr', {
            class: 'chart-row',
            children: [el('td', { attrs: { colspan: '5' }, children: [container] })],
        }),
        container,
    };
}

/**
 * Draws the per-run scatter. `old/manifests.html:760-822`.
 *
 * Called from a `queueMicrotask` after the row is in the document, because
 * Plotly measures the container and a detached div has no width. Upstream uses
 * `setTimeout(…, 0)` (`:747`) for the same reason; a microtask is the same
 * guarantee, sooner.
 */
function drawChart(container: HTMLElement, row: ManifestRow, job: JobStats): void {
    // `newPlot` needs the element in the document to size it. A job collapsed
    // again before the microtask ran leaves an orphan, and drawing into it
    // would be the "chart element that never draws" mistake in reverse.
    if (!container.isConnected) {
        return;
    }
    const points = scatterPoints(job);
    const trace = {
        x: points.map((point) => point.x),
        y: points.map((point) => point.y),
        type: 'scatter',
        mode: 'markers',
        marker: { size: 8, color: '#0060df' },
        customdata: points.map((point) => ({ taskId: point.taskId, prefix: point.prefix })),
        hovertemplate:
            '<b>Run %{x}</b><br>' +
            'Duration: %{y}ms<br>' +
            'Task: %{customdata.taskId}<br>' +
            '<br>' +
            '<i>Click: resource profile</i><br>' +
            '<i>Alt+Click: error summary</i>' +
            '<extra></extra>',
    };
    const layout = {
        xaxis: { title: 'Run Number' },
        yaxis: { title: 'Runtime (ms)' },
        hovermode: 'closest',
        margin: { l: 60, r: 40, t: 20, b: 60 },
    };
    void Plotly.newPlot(container.id, [trace], layout, { responsive: true });

    // Plotly adds `on` to the graph div during `newPlot`. Attached after,
    // because the method does not exist before.
    const graph = container as PlotlyDiv;
    graph.on?.('plotly_click', (data) => {
        const point = data.points[0];
        if (point?.customdata === undefined) {
            return;
        }
        const { taskId, prefix } = point.customdata;
        // Alt+click is the error summary, a plain click the resource profile —
        // `old/manifests.html:817-821`, and the hover template says so.
        const url = data.event.altKey
            ? errorSummaryUrl(taskId, prefix)
            : profilerUrl(getProfilerOrigin(), taskId, row.manifest, job.jobName);
        window.open(url, '_blank');
    });
}

/** Row elements back to the row they render, so a click needs no selector. */
const manifestOf = new WeakMap<HTMLElement, ManifestRow>();
const jobOf = new WeakMap<HTMLElement, { row: ManifestRow; job: JobStats }>();

/** Rebuilds the table body. `old/manifests.html:634-758`. */
function renderTable(): void {
    const state = model;
    const elements = dom;
    if (state === null || elements === null) {
        return;
    }
    const { tbody } = elements;
    tbody.replaceChildren();

    const pending: { container: HTMLElement; row: ManifestRow; job: JobStats }[] = [];

    for (const row of pageSlice(state.visible, state.page)) {
        const expanded = state.expandedManifests.has(row.manifest);
        const tr = manifestRowElement(row, expanded);
        manifestOf.set(tr, row);
        tbody.append(tr);

        if (!expanded) {
            continue;
        }
        // The job needle narrows the sub-rows too, so an expanded row under a
        // job search shows only the jobs that matched. `:686-688`.
        for (const job of filterJobs(row, state.filters)) {
            const key = jobKey(row.manifest, job.jobName);
            const jobExpanded = state.expandedJobs.has(key);
            const jobTr = jobRowElement(job, jobExpanded);
            jobOf.set(jobTr, { row, job });
            tbody.append(jobTr);

            if (jobExpanded) {
                const { tr: chartTr, container } = chartRowElement(row, job);
                tbody.append(chartTr);
                pending.push({ container, row, job });
            }
        }
    }

    // Every chart container that was emitted gets drawn, and nothing else is
    // emitted. The two happen in one place so they cannot drift apart — the
    // "emit an element that never draws" mistake needs them to be separable.
    for (const { container, row, job } of pending) {
        queueMicrotask(() => drawChart(container, row, job));
    }

    renderPager();
}

/** The pager, and the two buttons' disabled states. `old/manifests.html:753-757`. */
function renderPager(): void {
    const state = model;
    const elements = dom;
    if (state === null || elements === null) {
        return;
    }
    const pager = pageState(state.visible.length, state.page);
    elements.pageInfo.textContent = pager.label;
    elements.prev.disabled = pager.prevDisabled;
    elements.next.disabled = pager.nextDisabled;
}

/** The sort arrows and the `sorted` class. `old/manifests.html:512-539`. */
function renderSortIndicators(): void {
    const state = model;
    const elements = dom;
    if (state === null || elements === null) {
        return;
    }
    for (const [index, header] of elements.headers.entries()) {
        const indicator = header.querySelector('.sort-indicator');
        const active = SORT_COLUMNS[index] === state.sort.column;
        header.classList.toggle('sorted', active);
        if (indicator !== null) {
            // Every header shows `▼` when it is not the active one, which is
            // upstream's reset (`:518`) rather than a blank.
            indicator.textContent = active ? (state.sort.ascending ? '▲' : '▼') : '▼';
        }
    }
}

/** The × buttons, shown only when their box has text. `old/manifests.html:541-558`. */
function renderClearButtons(): void {
    const state = model;
    const elements = dom;
    if (state === null || elements === null) {
        return;
    }
    elements.clearManifest.classList.toggle('visible', state.filters.manifest !== '');
    elements.clearJob.classList.toggle('visible', state.filters.job !== '');
}

/** The four cards. `old/manifests.html:890-893`. */
function renderStats(file: ManifestsFile): void {
    const stats = headlineStats(file);
    need('statManifests').textContent = stats.manifests.toLocaleString();
    need('statJobs').textContent = stats.jobs.toLocaleString();
    need('statRuns').textContent = stats.runs.toLocaleString();
    need('statDate').textContent = stats.date;
}

// --- state transitions ----------------------------------------------------

/**
 * Re-filters, re-sorts and re-renders, keeping the sort as it is.
 *
 * The fix for divergence 1 lives in the second line: upstream calls
 * `sortBy(currentSortColumn)` here, which toggles. This applies the sort the
 * page is already on.
 *
 * `page` is reset **before** the render, not after — divergence 4.
 */
function applyFilters(): void {
    const state = model;
    if (state === null) {
        return;
    }
    state.visible = sortRows(filterRows(state.all, state.filters), state.sort);
    state.page = 1;
    renderClearButtons();
    renderTable();
}

/** A header click. `old/manifests.html:487-510`. */
function onSortClick(column: SortColumn): void {
    const state = model;
    if (state === null) {
        return;
    }
    state.sort = nextSort(state.sort, column);
    state.visible = sortRows(state.visible, state.sort);
    // Upstream does not reset the page on a sort (`:487-510` never touches
    // `currentPage`), so page 3 of a descending sort becomes page 3 of an
    // ascending one. Reproduced: the row count has not changed, so the page
    // number is still meaningful, and resetting it would lose a reader's place.
    renderSortIndicators();
    renderTable();
}

/**
 * Writes the two searches into the URL. `old/manifests.html:566-596`.
 *
 * The push/replace dance is upstream's, and the reason for it is worth keeping:
 * one `pushState` for the first keystroke of a burst, then `replaceState` for
 * the rest, so a typed word is **one** history entry rather than one per
 * character. 500 ms of quiet commits the entry.
 */
let pushStateTimer: ReturnType<typeof setTimeout> | null = null;

function syncFiltersToUrl(): void {
    const state = model;
    if (state === null) {
        return;
    }
    const url = new URL(location.href);
    url.search = filtersToSearch(url.search, state.filters);
    if (pushStateTimer === null) {
        history.pushState(null, '', url.href);
    } else {
        clearTimeout(pushStateTimer);
        history.replaceState(null, '', url.href);
    }
    pushStateTimer = setTimeout(() => {
        pushStateTimer = null;
    }, 500);
}

/** A keystroke in either box, or a × click. */
function onFiltersChanged(): void {
    const state = model;
    const elements = dom;
    if (state === null || elements === null) {
        return;
    }
    state.filters = {
        manifest: elements.manifestSearch.value,
        job: elements.jobSearch.value,
    };
    syncFiltersToUrl();
    applyFilters();
}

/** Toggles a manifest's job rows. `old/manifests.html:615-622`. */
function toggleManifest(row: ManifestRow): void {
    const state = model;
    if (state === null) {
        return;
    }
    if (!state.expandedManifests.delete(row.manifest)) {
        state.expandedManifests.add(row.manifest);
    }
    renderTable();
}

/** Toggles a job's chart. `old/manifests.html:624-632`. */
function toggleJob(row: ManifestRow, job: JobStats): void {
    const state = model;
    if (state === null) {
        return;
    }
    const key = jobKey(row.manifest, job.jobName);
    if (!state.expandedJobs.delete(key)) {
        state.expandedJobs.add(key);
    }
    renderTable();
}

// --- wiring ---------------------------------------------------------------

/**
 * One delegated listener for both row levels.
 *
 * The nearest row wins, so a click on a job row toggles the job and not its
 * manifest — which is what upstream needs `e.stopPropagation()` for
 * (`:697`). Divergence 5.
 */
function onTableClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) {
        return;
    }
    const jobRow = target.closest('.job-row');
    if (jobRow instanceof HTMLElement) {
        const entry = jobOf.get(jobRow);
        if (entry !== undefined) {
            toggleJob(entry.row, entry.job);
        }
        return;
    }
    const manifestRow = target.closest('.manifest-row');
    if (manifestRow instanceof HTMLElement) {
        const row = manifestOf.get(manifestRow);
        if (row !== undefined) {
            toggleManifest(row);
        }
    }
    // A click on the chart row falls through to nothing, which is right: the
    // chart handles its own clicks and a stray one must not collapse the job
    // under the reader's cursor.
}

/** Attaches every listener. Called once. */
function wire(): void {
    const elements = dom;
    if (elements === null) {
        return;
    }
    for (const input of [elements.manifestSearch, elements.jobSearch]) {
        input.addEventListener('input', onFiltersChanged);
    }
    // `f` focuses the manifest filter — the same shortcut the other dashboards
    // got through `searchBox()`, which this page cannot use because it has two
    // filter inputs in markup of its own. The manifest box and not the job one
    // because it is the page's primary filter; Escape leaves either.
    bindFilterShortcut('manifestSearch');
    elements.clearManifest.addEventListener('click', () => {
        elements.manifestSearch.value = '';
        onFiltersChanged();
    });
    elements.clearJob.addEventListener('click', () => {
        elements.jobSearch.value = '';
        onFiltersChanged();
    });
    for (const [index, header] of elements.headers.entries()) {
        const column = SORT_COLUMNS[index];
        if (column === undefined) {
            continue;
        }
        header.addEventListener('click', () => onSortClick(column));
    }
    elements.prev.addEventListener('click', () => {
        const state = model;
        if (state !== null && state.page > 1) {
            state.page -= 1;
            renderTable();
        }
    });
    elements.next.addEventListener('click', () => {
        const state = model;
        if (state !== null && state.page < pageState(state.visible.length, state.page).totalPages) {
            state.page += 1;
            renderTable();
        }
    });
    elements.tbody.addEventListener('click', onTableClick);

    window.addEventListener('popstate', () => {
        const state = model;
        if (state === null) {
            return;
        }
        // Reads the URL back into the boxes and re-filters **without** pushing
        // a new entry — upstream's `:922-939`, minus its sort flip.
        state.filters = parseFilters(location.search);
        elements.manifestSearch.value = state.filters.manifest;
        elements.jobSearch.value = state.filters.job;
        applyFilters();
    });
}

// --- startup --------------------------------------------------------------

/** Fetches `manifests.json` from its own index. `old/manifests.html:363-369`. */
async function fetchManifestData(): Promise<ManifestsFile> {
    // `manifest-timings`, not a harness's index: this file has its own.
    const response = await fetchFromCI('manifest-timings', 'manifests.json');
    if (!response.ok) {
        throw new Error(`Failed to fetch manifest data: ${response.status}`);
    }
    return (await response.json()) as ManifestsFile;
}

declare global {
    /** `fetch-utils.js:63` — an artifact from a `test-info-*` index. */
    function fetchFromCI(indexName: string, filename: string): Promise<Response>;
}

/**
 * Starts the page.
 *
 * Exported and **not** called on import, so a test can drive the controller
 * without the module fetching anything — the arrangement `site/crashes-main.ts`
 * records the reason for. `site/manifests-main.ts` is the three lines that call
 * it.
 */
export async function start(): Promise<void> {
    dom = {
        manifestSearch: need<HTMLInputElement>('manifestSearch'),
        jobSearch: need<HTMLInputElement>('jobSearch'),
        clearManifest: need('clearManifest'),
        clearJob: need('clearJob'),
        tbody: need('manifestTableBody'),
        headers: [...document.querySelectorAll<HTMLElement>('.manifest-table th')],
        pageInfo: need('pageInfo'),
        prev: need<HTMLButtonElement>('btnPrev'),
        next: need<HTMLButtonElement>('btnNext'),
        loading: need('loadingMessage'),
        error: need('errorMessage'),
        content: need('contentArea'),
    };
    wire();
    // Upstream calls this at `:941`. It looks for `.chart-container`, which
    // this page has none of — see the declaration above.
    setupWindowResize();

    const elements = dom;
    try {
        elements.loading.style.display = 'block';
        elements.content.style.display = 'none';
        elements.error.style.display = 'none';

        const file = await fetchManifestData();
        renderStats(file);

        // The searches come from the URL before the first render, so a shared
        // `?q=` link paints its result once rather than painting everything
        // and then narrowing. `old/manifests.html:896-905`.
        const filters = parseFilters(location.search);
        elements.manifestSearch.value = filters.manifest;
        elements.jobSearch.value = filters.job;

        model = {
            all: buildManifestRows(file),
            visible: [],
            filters,
            sort: DEFAULT_SORT,
            page: 1,
            expandedManifests: new Set(),
            expandedJobs: new Set(),
        };
        // Not `onFiltersChanged`: that would push a history entry for a state
        // the reader arrived in. Upstream has the same split.
        applyFilters();
        renderSortIndicators();

        if (model.all.length === 0) {
            elements.tbody.append(
                el('tr', { children: [el('td', { attrs: { colspan: '5' }, children: [noData('No manifest data.')] })] })
            );
        }

        elements.loading.style.display = 'none';
        elements.content.style.display = 'block';
    } catch (error) {
        console.error('Error loading data:', error);
        elements.error.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
        elements.error.style.display = 'block';
        elements.loading.style.display = 'none';
    }
}

/** For the tests: the current view model, or `null` before `start()`. */
export function currentModel(): PageModel | null {
    return model;
}

/** For the tests: drops the page's state so each case starts clean. */
export function resetForTest(): void {
    model = null;
    dom = null;
    if (pushStateTimer !== null) {
        clearTimeout(pushStateTimer);
        pushStateTimer = null;
    }
}
