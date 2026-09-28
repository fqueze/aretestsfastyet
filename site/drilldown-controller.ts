/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The **controller** the crashes and failures pages share: page state, the
 * expansion state machine, data loading, the URL hash, and startup.
 *
 * ## Where this sits
 *
 * The migration already split these two pages three ways — `lib/` for the file
 * formats, `site/drilldown-view.ts` for the view model, `site/drilldown-render.ts`
 * for the renderer — and then left the controllers alone. They were 897 and 922
 * lines that a normalized diff put at 82% identical. This file is the fourth
 * piece:
 *
 * | file | contains |
 * | --- | --- |
 * | `site/drilldown-view.ts` | the tree, the ranking, the collapse, the totals, the URL state |
 * | `site/drilldown-render.ts` | the elements, given a `Vocabulary` and `RenderHooks` |
 * | this file | the state, the clicks, the fetches and the hash |
 * | `site/crashes.ts` / `site/failures.ts` | one `PageSpec` each, and what only that page does |
 *
 * It belongs in `site/` and not in `lib/`, under this project's seam rule: it
 * names `#content`, `#statusText`, `#dateSelect`, `#searchBox`, `.path-row`,
 * `.test-row`, `sort-header`, `total-row`, `expanded` and `historical-chart`.
 * `lib/` gains nothing from this change.
 *
 * ## The seam
 *
 * `PageSpec` extends the pattern `Vocabulary`/`RenderHooks` already established:
 * a record of the decisions the shared code cannot make. It deliberately has
 * **no booleans**. This codebase's rule is that a helper needing three flags to
 * serve its callers is several functions, and the two places the pages genuinely
 * disagree are both expressed as *values the page supplies* rather than as
 * branches here:
 *
 * - **What a row expands to.** `PageSpec.rank` returns the ranked rows *and* the
 *   `expandable` map every expansion reads. The crashes page returns the whole
 *   unfiltered tree, so its rows expand to everything regardless of the search;
 *   the failures page returns the search-rewritten subtrees, so its rows expand
 *   to what matched. That is the entire asymmetry, and it is one map rather than
 *   an `if`. See `RankedList`.
 * - **Which series a chart gets.** `PageSpec.chartSeries` is handed the level, the
 *   key, the path and the search term and returns a series. The crashes page
 *   ignores the term; the failures page has two search-filtered variants. See
 *   `ChartRequest`.
 *
 * ## What is *not* here, and why
 *
 * `loadFromUrlHash` and the `onHashChange` body are **not** shared. The two
 * pages disagree about them on purpose and it is on both files' declared
 * divergence lists: the failures page clears a stale search box (`state.q ?? ''`)
 * and re-renders on a hash change while in the 21-day view, and the crashes page
 * reproduces upstream's bug of doing neither. Sharing them would need two flags
 * to reconstruct exactly the pair of behaviours the divergence lists promise, so
 * each page keeps its own — and each keeps the paragraph explaining why, next to
 * the code.
 *
 * ## Tested through the pages
 *
 * There is no `test/drilldown-controller.test.ts`, deliberately: this module has
 * no meaningful behaviour without a `PageSpec`, and a test that supplied a
 * hand-made one would be asserting against a spec its own author wrote.
 * `test/crashes-page.test.ts` and `test/failures-page.test.ts` drive it through
 * the two real specs in jsdom against pinned fixtures, which is what makes a
 * mistake here fail in both suites at once.
 */

import type { DailyFile } from '../lib/formats/daily.ts';
import type { IssuesWithTaskIdsFile } from '../lib/formats/issues.ts';
import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import { decodeDaily } from '../lib/formats/daily.ts';
import { decodeIssuesWithTaskIds } from '../lib/formats/issues.ts';
import {
    type GroupNode,
    type GroupRow,
    type PathNode,
    type SortColumn,
    type SortState,
    type UrlState,
    INITIAL_SORT,
    expandGroup,
    expandPath,
    isHistoricalDate,
    nextSort,
    readUrlState,
    totalsOf,
} from './drilldown-view.ts';
import {
    type RenderHooks,
    type SearchBoxManager,
    type Vocabulary,
    insertAfter,
    noData,
    removeFollowing,
    renderChartSlot,
    renderList,
    renderOccurrenceTable,
    renderSubRows,
    searchBox,
} from './drilldown-render.ts';

/** The series `common-charts.js` hands back, and `createRateChart` takes. */
export type DailySeries = ReturnType<typeof countDailyRunsForTests>;

/**
 * A ranked list and the subtrees its rows expand to.
 *
 * The two maps are the two pages' search semantics, and returning the map with
 * the rows is what lets the shared controller have one state accessor instead of
 * a `filtered` flag:
 *
 * - **crashes** returns `key → group.paths` for *every* group in the file, not
 *   only the rows that survived the search. That reproduces `old/crashes.html:858`,
 *   which expands out of `currentData.crashData` — a row's expansion is never
 *   narrowed by the search, and the re-attach after a re-render reads the same
 *   unfiltered tree the click path does.
 * - **failures** returns `rewriteGroupsBySearch`'s output, keyed by message.
 *   That reproduces `filteredFailureData` (`old/failures.html:101`) — a row's
 *   expansion shows only what matched, and the counts on the row are the counts
 *   of what expanding it will reveal.
 */
export interface RankedList {
    rows: GroupRow[];
    /** key → the subtree that row expands to. */
    expandable: Map<string, Map<string, PathNode>>;
}

/** Which level of the tree a chart is being drawn for. */
export type ChartLevel = 'key' | 'path' | 'test';

/**
 * Everything a page needs in order to choose a chart's series.
 *
 * Passed as a record rather than as four positional arguments because the
 * crashes page reads two of the fields and the failures page reads all five, and
 * a positional signature would leave the crashes page writing `_term` and
 * `_paths` placeholders for arguments it has no use for.
 */
export interface ChartRequest {
    level: ChartLevel;
    key: string;
    /** The directory, at the `path` and `test` levels. */
    dirPath: string | null;
    /** The test name, at the `test` level. */
    testName: string | null;
    /**
     * The subtree being expanded — the page's own `expandable` entry, so on the
     * failures page it is already search-rewritten. `null` at the `test` level.
     */
    paths: Map<string, PathNode> | PathNode | null;
    /** The search box's value, lower-cased. */
    term: string;
}

/**
 * The decisions the shared controller cannot make for itself.
 *
 * Note what is *not* a field: there is no `hasSearchFilteredCharts`, no
 * `expandsFromFilteredTree`, no `clearsStaleSearch`. Each of those would have
 * been a boolean standing in for a behaviour, and each is instead either a value
 * the page computes (`rank`, `chartSeries`) or a function the page keeps to
 * itself (`loadFromUrlHash`).
 */
export interface PageSpec {
    /** The class names and labels. */
    vocab: Vocabulary;
    /** The per-page render callbacks. */
    hooks: RenderHooks;
    /** The `<h1>` suffix `initHarnessSwitcher` writes. */
    heading: string;
    /**
     * The `makeChartId` prefix for a top-level row: `signature` or `message`.
     *
     * It reaches the DOM as part of a canvas id, and the two pages' ids differ,
     * so it cannot be derived from `vocab.kind`.
     */
    keyChartPrefix: string;
    /** The `eventLabel` `createRateChart` is given: `crash` or `failure`. */
    chartEventLabel: string;
    /** Builds this page's tree from a decoded file. */
    buildGroups(file: DecodedTimingFile, startTime: number): Map<string, GroupNode>;
    /** Ranks and searches, and says what the rows expand to. */
    rank(groups: Map<string, GroupNode>, term: string, sort: SortState): RankedList;
    /** The daily series for one chart, or `null` when there is nothing to draw. */
    chartSeries(request: ChartRequest): DailySeries | null;
    /**
     * Applies the URL hash to the page.
     *
     * Kept per-page: the two disagree about the stale-search-box guard, and that
     * disagreement is a declared divergence on both pages rather than an
     * accident. `state` gives the page the parsed hash without making it reach
     * for the manager itself.
     */
    applyUrlState(state: Partial<UrlState>): Promise<void>;
    /**
     * What to do after a hash change that did not leave the 21-day view.
     *
     * The crashes page does nothing, reproducing upstream. The failures page
     * re-renders, which is what makes its search-box fix observable rather than
     * cosmetic. A one-line difference, but a real one, so it is a hook rather
     * than a flag.
     */
    onHashChangeInHistorical(): void;
}

/**
 * The page state and the operations on it.
 *
 * A class rather than a module of `let`s, because two pages now run this code
 * and module-scope state would make them share one set of variables. Each
 * controller owns its own instance; the pages are separate documents, so only
 * one ever exists at a time in a browser, but a node test builds one per case.
 */
export class DrilldownController {
    private readonly spec: PageSpec;

    /**
     * The raw parsed file, kept because two shared functions need it as-is.
     *
     * `getTestTotalRuns` and `countDailyRunsForTests` both take the untyped JSON and index into `tables`/`taskInfo`/`testRuns`
     * themselves. They are `common-links.js` and `common-charts.js`, which this
     * migration keeps, so the raw object has to survive alongside the decoded
     * one.
     */
    rawData: unknown = null;
    /** The decoded view of `rawData`. */
    decoded: DecodedTimingFile | null = null;
    /** `metadata.startTime`, which the day indices are relative to. */
    startTime = 0;
    /** The key tree, as built from the loaded file. */
    groups: Map<string, GroupNode> = new Map();
    /** The raw 21-day file, kept for the charts and the run totals. */
    historicalData: unknown = null;
    isHistoricalMode = false;

    /** The open top-level row's key, or `null`. Only ever one at a time. */
    expandedKey: string | null = null;
    private readonly expandedPaths = new Set<string>();
    private readonly expandedTests = new Set<string>();
    currentSort: SortState = { ...INITIAL_SORT };

    /** What the rows of the last render expand to. See `RankedList`. */
    private expandable = new Map<string, Map<string, PathNode>>();
    /** The row elements of the last render, keyed by raw key. */
    private rowsByKey = new Map<string, HTMLElement>();
    /** The rows of the last render, for `window.__view` and the label hook. */
    renderedRows: GroupRow[] = [];

    searchBoxManager!: SearchBoxManager;
    private hashManager: ReturnType<typeof initUrlHashManager> | undefined;
    private historicalToggleManager!: { toggle: () => Promise<void> };

    constructor(spec: PageSpec) {
        this.spec = spec;
    }

    // --- the elements the page owns ---------------------------------------

    private content(): HTMLElement {
        return document.getElementById('content')!;
    }

    private statusText(): HTMLElement {
        return document.getElementById('statusText')!;
    }

    dateSelect(): HTMLSelectElement {
        return document.getElementById('dateSelect') as HTMLSelectElement;
    }

    /** The search box's value, lower-cased, as every search path wants it. */
    private term(): string {
        return this.searchBoxManager.getValue().toLowerCase();
    }

    // --- rendering --------------------------------------------------------

    /** `renderCrashList` (`old/crashes.html:484`) / `renderFailureList` (`:526`). */
    render = (): void => {
        const target = this.content();
        target.textContent = '';

        if (this.decoded === null || this.groups.size === 0) {
            target.append(noData(this.spec.vocab.emptyText));
            return;
        }

        const ranked = this.spec.rank(this.groups, this.term(), this.currentSort);
        this.renderedRows = ranked.rows;
        this.expandable = ranked.expandable;

        const rendered = renderList(
            ranked.rows,
            totalsOf(ranked.rows),
            this.currentSort,
            this.spec.vocab,
            this.spec.hooks,
            this.onSortClicked,
            this.expandedKey
        );
        this.rowsByKey = rendered.rowsByKey;
        target.append(rendered.root);

        // Re-attach the open row's subtree after a full re-render. Upstream does
        // this by selector (`old/crashes.html:597`, `old/failures.html:683`) and this by
        // Map lookup; see each page's divergence 2.
        //
        // It reads the same `expandable` the click path reads, which is what
        // makes the two pages differ here without a branch: on crashes that is
        // the unfiltered tree, matching upstream, and on failures it is the
        // filtered one, which upstream inconsistently was not — see
        // `site/failures.ts`.
        if (this.expandedKey !== null) {
            const row = this.rowsByKey.get(this.expandedKey);
            const paths = this.expandable.get(this.expandedKey);
            if (row !== undefined && paths !== undefined) {
                this.openKey(row, this.expandedKey, paths);
            }
        }
    };

    private onSortClicked = (column: SortColumn): void => {
        this.currentSort = nextSort(this.currentSort, column);
        this.render();
    };

    // --- expansion --------------------------------------------------------

    /**
     * Whether an element ends the run of rows belonging to an expanded key.
     *
     * `old/crashes.html:841`, `old/failures.html:940`. A key's subtree runs until the
     * next top-level row.
     */
    private endsKey = (element: Element): boolean =>
        element.classList.contains(this.spec.vocab.rowClass) ||
        element.classList.contains('sort-header') ||
        element.classList.contains('total-row');

    /**
     * Whether an element ends the run of rows belonging to an expanded path.
     *
     * `old/crashes.html:888`, `old/failures.html:994`, which stop on *anything that is
     * not* one of these — so the predicate is the negation.
     */
    private static endsPath(element: Element): boolean {
        return !(
            element.classList.contains('test-row') ||
            element.classList.contains('historical-chart') ||
            element.classList.contains('instance-table')
        );
    }

    /** `old/crashes.html:929`, `old/failures.html:1042`. */
    private static endsTest(element: Element): boolean {
        return !(
            element.classList.contains('historical-chart') ||
            element.classList.contains('instance-table')
        );
    }

    /**
     * Draws one rate chart.
     *
     * `createCrashChart` (`old/crashes.html:474`) and `createFailureChart`
     * (`old/failures.html:516`) each rename `events` to their own noun before
     * handing the series to `createRateChart`. Nothing reads the renamed field —
     * `createRateChart` uses `events` and `totalRuns` (`common-charts.js:338`,
     * `:367`) — so both renames are dropped and the series goes through as it is.
     */
    private drawChart(canvasId: string, series: DailySeries | null, label: string): void {
        if (series === null) {
            return;
        }
        createRateChart(canvasId, series, label, this.spec.chartEventLabel);
    }

    /** Inserts a key's subtree and draws its chart. `old/crashes.html:863`. */
    private openKey(row: HTMLElement, key: string, paths: Map<string, PathNode>): void {
        const elements: HTMLElement[] = [];
        const chartId = this.isHistoricalMode
            ? makeChartId(this.spec.keyChartPrefix, key)
            : null;
        if (chartId !== null) {
            elements.push(renderChartSlot(`${chartId}-canvas`));
        }
        elements.push(...renderSubRows(expandGroup(paths), key, this.spec.vocab, this.spec.hooks));
        insertAfter(row, elements);
        this.wireSubRows(elements, key);
        if (chartId !== null) {
            const series = this.spec.chartSeries({
                level: 'key',
                key,
                dirPath: null,
                testName: null,
                paths,
                term: this.term(),
            });
            this.drawChart(`${chartId}-canvas`, series, key);
        }
    }

    /** `toggleCrash` (`old/crashes.html:828`) / `toggleFailure` (`:927`). */
    private toggleKey(key: string, row: HTMLElement): void {
        const wasExpanded = this.expandedKey === key;

        if (this.expandedKey !== null) {
            const open = wasExpanded ? row : this.rowsByKey.get(this.expandedKey);
            if (open !== undefined) {
                open.classList.remove('expanded');
                removeFollowing(open, this.endsKey);
            }
            this.expandedKey = null;
            this.expandedPaths.clear();
            this.expandedTests.clear();
        }

        if (!wasExpanded) {
            this.expandedKey = key;
            row.classList.add('expanded');
            const paths = this.expandable.get(key);
            if (paths !== undefined) {
                this.openKey(row, key, paths);
            }
        }
    }

    /** `togglePath` (`old/crashes.html:878`, `old/failures.html:984`). */
    private togglePath(key: string, dirPath: string, row: HTMLElement): void {
        const stateKey = `${key}|||${dirPath}`;
        const wasExpanded = this.expandedPaths.has(stateKey);
        row.classList.toggle('expanded', !wasExpanded);

        if (wasExpanded) {
            this.expandedPaths.delete(stateKey);
            removeFollowing(row, DrilldownController.endsPath);
            return;
        }

        this.expandedPaths.add(stateKey);
        const path = this.expandable.get(key)?.get(dirPath);
        if (path === undefined) {
            return;
        }

        const elements: HTMLElement[] = [];
        const chartId = this.isHistoricalMode ? makeChartId('path', key, dirPath) : null;
        if (chartId !== null) {
            elements.push(renderChartSlot(`${chartId}-canvas`));
        }
        elements.push(...renderSubRows(expandPath(path), key, this.spec.vocab, this.spec.hooks));
        insertAfter(row, elements);
        this.wireSubRows(elements, key);
        if (chartId !== null) {
            const series = this.spec.chartSeries({
                level: 'path',
                key,
                dirPath,
                testName: null,
                paths: path,
                term: this.term(),
            });
            this.drawChart(`${chartId}-canvas`, series, `${key} in ${dirPath}`);
        }
    }

    /** `toggleTest` (`old/crashes.html:919`, `old/failures.html:1032`). */
    private toggleTest(key: string, dirPath: string, testName: string, row: HTMLElement): void {
        const stateKey = `${key}|||${dirPath}|||${testName}`;
        const wasExpanded = this.expandedTests.has(stateKey);
        row.classList.toggle('expanded', !wasExpanded);

        if (wasExpanded) {
            this.expandedTests.delete(stateKey);
            removeFollowing(row, DrilldownController.endsTest);
            return;
        }

        this.expandedTests.add(stateKey);
        const test = this.expandable.get(key)?.get(dirPath)?.tests.get(testName);
        if (test === undefined) {
            return;
        }

        const elements: HTMLElement[] = [];
        const chartId = this.isHistoricalMode
            ? makeChartId('test', key, dirPath, testName)
            : null;
        if (chartId !== null) {
            elements.push(renderChartSlot(`${chartId}-canvas`));
        }
        elements.push(renderOccurrenceTable(test, this.spec.vocab, this.spec.hooks));
        insertAfter(row, elements);
        if (chartId !== null) {
            // Neither page has a search-filtered variant at this level —
            // `old/crashes.html:942`, `old/failures.html:1063` — because a single test
            // either matched or is not on screen. `chartSeries` is still asked,
            // so the rule lives in one place per page rather than here.
            const series = this.spec.chartSeries({
                level: 'test',
                key,
                dirPath,
                testName,
                paths: null,
                term: this.term(),
            });
            this.drawChart(`${chartId}-canvas`, series, `${key} in ${testName}`);
        }
    }

    /**
     * Attaches the click behaviour to freshly inserted path and test rows.
     *
     * Upstream uses one delegated listener on `#content` that walks up from the
     * event target and reads `dataset` (`old/crashes.html:619-679`). That works
     * because the data it needs is in attributes; here the rows are elements the
     * renderer just built, so the listener closes over the values directly and
     * there is no attribute to read back. The single-occurrence rows already
     * carry their own listener from the renderer, and `old/failures.html:734`
     * excludes them from the expandable branch for the same reason.
     */
    private wireSubRows(elements: readonly HTMLElement[], key: string): void {
        for (const element of elements) {
            if (element.classList.contains('path-row')) {
                const dirPath = element.dataset['path']!;
                element.addEventListener('click', () => this.togglePath(key, dirPath, element));
            } else if (
                element.classList.contains('test-row') &&
                !element.classList.contains(this.spec.vocab.singleClass)
            ) {
                const dirPath = element.dataset['path']!;
                const testName = element.dataset['test']!;
                element.addEventListener('click', () =>
                    this.toggleTest(key, dirPath, testName, element)
                );
            }
        }
    }

    // --- data loading -----------------------------------------------------

    /** `loadSelectedDate` (`old/crashes.html:187`, `old/failures.html:169`). */
    loadSelectedDate = async (): Promise<void> => {
        const date = this.dateSelect().value;
        if (!date) {
            return;
        }

        try {
            this.statusText().textContent = 'Loading...';
            const harness = getHarnessType();
            const response = await fetchData(`${harness}-${date}.json`);
            if (!response.ok) {
                throw new Error('Failed to load data');
            }
            const file = (await response.json()) as DailyFile;
            this.rawData = file;
            this.decoded = decodeDaily(file);
            this.startTime = file.metadata.startTime;
            this.groups = this.spec.buildGroups(this.decoded, this.startTime);
            this.render();
            const jobCount = file.metadata.jobCount ?? 0;
            this.statusText().textContent = `${jobCount.toLocaleString()} test jobs`;
        } catch (error) {
            console.error('Error loading data:', error);
            const target = this.content();
            target.textContent = '';
            target.append(noData(error instanceof Error ? error.message : String(error)));
            this.statusText().textContent = 'Error loading data';
        }
    };

    /**
     * Enters or leaves the 21-day view.
     *
     * The button, the date selector's disabled state and the status text are
     * `common-ui.js`'s `initHistoricalToggle`; this is only the data side of the
     * callback. `old/crashes.html:159-178`, `old/failures.html:141-160`.
     */
    private onHistoricalToggled = async (isHistorical: boolean, data: unknown): Promise<void> => {
        this.isHistoricalMode = isHistorical;
        if (isHistorical) {
            this.historicalData = data;
            this.rawData = data;
            const file = data as IssuesWithTaskIdsFile;
            this.decoded = decodeIssuesWithTaskIds(file);
            this.startTime = file.metadata.startTime;
            this.groups = this.spec.buildGroups(this.decoded, this.startTime);
            this.render();
        } else {
            await this.loadSelectedDate();
        }
        this.updateUrlHash();
    };

    // --- URL state --------------------------------------------------------

    updateUrlHash = (): void => {
        this.hashManager?.updateHash();
    };

    /**
     * The hash as the page's `applyUrlState` wants it, or `null` before startup.
     *
     * Returning `null` rather than throwing reproduces both pages' guard: their
     * `loadFromUrlHash` opened with `if (hashManager === undefined) return;`,
     * which is reachable because `start()` calls it and a test can import the
     * module without calling `start()`.
     */
    urlState(): Partial<UrlState> | null {
        if (this.hashManager === undefined) {
            return null;
        }
        return readUrlState(this.hashManager.getParams());
    }

    /**
     * Enters or leaves the 21-day view to match a hash, and sets the date.
     *
     * Shared because both pages' `loadFromUrlHash` do exactly this after their
     * differing search-box guard: `old/crashes.html:993-1006`,
     * `old/failures.html:1104-1117`.
     */
    async applyDateState(date: string | undefined): Promise<void> {
        if (isHistoricalDate(date)) {
            if (!this.isHistoricalMode) {
                await this.historicalToggleManager.toggle();
            }
        } else {
            if (this.isHistoricalMode) {
                await this.historicalToggleManager.toggle();
            }
            if (this.dateSelect().value !== date) {
                this.dateSelect().value = date!;
            }
        }
    }

    // --- startup ----------------------------------------------------------

    private initializeUI(): void {
        initHarnessSwitcher(this.spec.heading);

        this.searchBoxManager = searchBox({
            searchBoxId: 'searchBox',
            searchClearId: 'searchClear',
            onSearch: this.render,
            updateUrlHash: this.updateUrlHash,
        });

        this.hashManager = initUrlHashManager({
            getState: () => ({
                date: this.isHistoricalMode ? '21days' : this.dateSelect().value,
                q: this.searchBoxManager.getValue().trim(),
            }),
            onHashChange: async () => {
                this.searchBoxManager.setNavigating(true);
                await this.loadFromUrlHash();
                if (!this.isHistoricalMode) {
                    await this.loadSelectedDate();
                } else {
                    this.spec.onHashChangeInHistorical();
                }
                this.searchBoxManager.setNavigating(false);
            },
        });

        const harness = getHarnessType();
        this.historicalToggleManager = initHistoricalToggle({
            buttonId: 'historicalButton',
            selectId: 'dateSelect',
            statusTextId: 'statusText',
            fetchData,
            historicalDataFile: `${harness}-issues-with-taskids.json`,
            onToggle: this.onHistoricalToggled,
            updateUrlHash: this.updateUrlHash,
        });

        // The `<select>`'s own `onchange="loadSelectedDate()"` attribute is in
        // the markup upstream; here both the reload and the hash update are
        // listeners.
        this.dateSelect().addEventListener('change', () => {
            this.updateUrlHash();
            void this.loadSelectedDate();
        });
    }

    /** Runs the page's own `applyUrlState`, once the hash is readable. */
    private async loadFromUrlHash(): Promise<void> {
        const state = this.urlState();
        if (state === null) {
            return;
        }
        await this.spec.applyUrlState(state);
    }

    /**
     * Delegated clicks on the top-level rows.
     *
     * Only the top-level rows need delegation — they are re-created on every
     * render — and the sub-rows get their listeners from `wireSubRows` when they
     * are inserted. Upstream delegates all four levels through one handler
     * (`old/crashes.html:619`).
     */
    private setupClickHandlers(): void {
        this.content().addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element) || target.tagName === 'A') {
                return;
            }
            const row = target.closest(`.${this.spec.vocab.rowClass}`);
            if (row === null || row.classList.contains('total-row')) {
                return;
            }
            for (const [key, element] of this.rowsByKey) {
                if (element === row) {
                    this.toggleKey(key, element);
                    return;
                }
            }
        });
    }

    /**
     * Wires the page up and loads it. Called by the page, not by importing it.
     *
     * This used to be a bare `setupClickHandlers()` and an awaited IIFE at
     * module scope in each controller, which meant importing either file
     * *started the page* — it attached listeners, populated the date selector
     * and fetched data. That is why nothing tested them: `drilldown-render.ts`
     * and the two controllers were 2,598 lines, 60% of the migration, that no
     * test could import, and inverting the page branch in `inlineLinksCell`
     * passed both `npm test` and `tsc`.
     *
     * Exporting the entry point is the whole fix. `site/crashes-main.ts` and
     * `site/failures-main.ts` are the two callers.
     */
    async start(): Promise<void> {
        this.setupClickHandlers();
        this.initializeUI();

        const hasData = await populateDateSelector({
            selectId: 'dateSelect',
            statusTextId: 'statusText',
            fetchData,
        });

        if (hasData) {
            const select = this.dateSelect();
            if (!select.value && select.options.length > 0) {
                select.selectedIndex = 0;
            }
            await this.loadFromUrlHash();
            if (!this.isHistoricalMode) {
                await this.loadSelectedDate();
            }
        }
    }

    /**
     * The view model, for the browser parity harness.
     *
     * `PARITY.md` §2: a page that builds strings has no seam to compare against.
     * This is the seam — the ranked rows and the totals as plain values, so the
     * comparison can assert on decisions rather than on pixels. `try.html`
     * exposes `window.failures` for the same reason.
     */
    view(): unknown {
        return {
            sort: this.currentSort,
            historical: this.isHistoricalMode,
            search: this.searchBoxManager?.getValue() ?? '',
            totals: totalsOf(this.renderedRows),
            rows: this.renderedRows.map((row) => ({
                key: row.key,
                testCount: row.testCount,
                count: row.count,
            })),
        };
    }
}

declare global {
    interface Window {
        __view?: () => unknown;
    }
}
