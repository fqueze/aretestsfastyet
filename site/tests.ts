/**
 * `tests.html` — one folder's remaining issues, over a day range you pick.
 *
 * | file | contains | tested by |
 * | --- | --- | --- |
 * | `lib/query/issues.ts` | the per-test counters, shared with `fx-tests issues` | `test/query.test.ts` |
 * | `lib/query/test-issues.ts` | the issue lines, shared with `fx-tests test` | `test/query.test.ts` |
 * | `site/tests-view.ts` | this page's view model — range, ranking, URL state | `test/tests-view.test.ts`, no DOM |
 * | this file | the renderer and the interactions | `test/tests-page.test.ts` |
 *
 * ## What this page is for
 *
 * Flakiness burndown. A reader has fixed some tests in a folder and wants to
 * know what is left — which is a question about a *window*, not about a day or
 * about all 21 days, and no existing page can express it. The rationale for a
 * third page rather than a mode on `issues.html` or `test.html` is at the top
 * of `site/tests-view.ts`.
 *
 * ## The range is a filter on the list, not on the chart
 *
 * The timeline always draws the folder's whole window and highlights the
 * selection; only the worklist below it is filtered. That asymmetry is the
 * feature: a reader picks the range *by looking at the shape*, so a chart
 * clipped to the current selection would hide the very day they are trying to
 * find. `timeline()` carries `selected` per day for the highlight.
 *
 * ## Why the range interaction is `test.html`'s, character for character
 *
 * The day selector is shift-click-to-extend, which is what `test.html`'s day
 * chart already does (`site/test.ts:673`, `handleDayClick`) — click a day,
 * shift-click another to extend, click the selected day again to clear. The
 * owner's requirement on this was explicit: the two pages must match, and
 * without duplicating the code. Adopting the interaction `test.html` already
 * ships satisfies both today, and `rangeOf()` in the view model is the one
 * place the two clicks become a range.
 *
 * A drag-to-select brush was the other candidate and is deliberately **not**
 * here: it would be a second interaction on this page only, which is the
 * mismatch the requirement rules out. Landing it means extracting `test.html`'s
 * chart-area pointer handling — `dayFromEvent`/`insidePlotArea`/
 * `DAY_COLUMN_HIGHLIGHT` (`site/test.ts:1456-1516`, `:1654-1684`) — into a
 * module both pages call, and is a follow-up the owner asked to keep separate.
 *
 * ## The two files, and the one this page does not load
 *
 * `{harness}-issues.json` (2.8 MB, counts only, no `taskInfo`) is what every
 * number here is computed from. `{harness}-issues-with-taskids.json` (15.9 MB)
 * is the same 21 days with task attribution, fetched **only** when a reader
 * expands a test — that is the one thing on this page that needs it, since a
 * failure message has no runs to list without it. Four properties of
 * `issues.html`'s loader are reproduced: historical mode only, at most one
 * fetch, a failure is a warning rather than an error, and nothing awaits it.
 *
 * A daily file (`{harness}-<date>.json`) carries task IDs already, and its
 * entries have `day === null` — so on a single day there is no range to select
 * and the timeline is one point. The page says so rather than drawing a chart
 * with one bar and a dead selector.
 */

import { decodeIssues, decodeIssuesWithTaskIds } from '../lib/formats/issues.ts';
import type { IssuesFile, IssuesWithTaskIdsFile } from '../lib/formats/issues.ts';
import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import {
    type StitchWindow,
    isDecodableAggregate,
    stitchWindows,
} from '../lib/formats/stitch.ts';
import { parseTaskId } from '../lib/formats/tables.ts';
import { type FlakyDay, flakinessOfPath, thinDays } from '../lib/query/flakiness.ts';
import {
    type DayRange,
    type Harness,
    type IssueFilters,
    type IssueTimeline,
    type LoadedHarness,
    type SortField,
    type SortState,
    type TestIssue,
    type Timeline,
    type Worklist,
    type WorklistRow,
    ALL_FILTERS,
    BADGE_CLASS,
    FILTER_IDS,
    decodeFilters,
    HARNESSES,
    INITIAL_SORT,
    SCOPE_LABEL,
    STAT_COLUMNS,
    breadcrumb,
    clampRange,
    folderPageUrl,
    harnessesWithTests,
    issueLines,
    issueTimeline,
    mergedWindow,
    nextSort,
    parseRange,
    percentageDisplay,
    rangeOf,
    readUrlState,
    scopeLine,
    testContribution,
    timeline,
    WINDOW_DAYS,
    backfillPushdates,
    parseBackfillDays,
    urlStateOf,
    windowDates,
    worklist,
} from './tests-view.ts';
import { matchesIssueLine } from './issues-view.ts';
import {
    type SearchBoxManager,
    el,
    externalLink,
    insertAfter,
    noData,
    removeFollowing,
    searchBox,
} from './drilldown-render.ts';
import { testRowLink } from './test-link.ts';
import { CHART_COLOURS, withAlpha } from './chart-colours.ts';

// Declared next to the calls rather than relied on from another `site/` file:
// `tsconfig.site.json` compiles all of `site/**` as one program, so a
// declaration elsewhere would cover these calls there and not in the root
// project, which pulls in only what a test imports.
declare global {
    /** `common-ui.js:18` — `toLocaleString()`. */
    function formatNumber(value: number): string;
    /** `common-ui.js:22` — turns `[path:123]` in a failure message into a link. */
    function linkifyFailureMessage(message: string, testPath: string): string;
}

/**
 * The slice of Chart.js this page uses.
 *
 * Read off `window` rather than declared as a global `const Chart`: all of
 * `site/**` is one program, so a second global declaration of that name is a
 * redeclaration error however compatible the shapes are. It also states the
 * truth about where it comes from — a CDN `<script>` tag, not an import — and
 * is what lets a test substitute it.
 */
interface ChartJs {
    /**
     * The instance is used, not discarded: `wireDayClicks` reads its `scales.x`
     * and `chartArea` to turn a click's pixel into a day. Typed as the two
     * members this page touches rather than as `unknown`, so that reading them
     * is checked instead of cast at the use site.
     */
    new (
        canvas: HTMLCanvasElement,
        config: Record<string, unknown>
    ): {
        scales?: Record<string, { getValueForPixel?: (pixel: number) => number }>;
        chartArea?: { left: number; right: number };
        data?: { labels?: unknown[] };
        /** The canvas it was drawn on, for turning a page x into a plot x. */
        canvas?: HTMLCanvasElement;
    };
    getChart(canvas: HTMLCanvasElement): { destroy(): void } | undefined;
}

/**
 * Shades the selected days' columns, behind the bars.
 *
 * `test.html`'s `DAY_COLUMN_HIGHLIGHT` (`site/test.ts:1703`), colours included:
 * `#d0e4fd` for a selected day and `#e8f0fe` for a hovered one, painted in
 * `beforeDatasetsDraw` so the band sits *behind* the data.
 *
 * This replaces desaturating the out-of-range bars, which was this page's own
 * invention and looked nothing like the other pages: dimming the *data* makes
 * a quiet day and an out-of-range day hard to tell apart, and it made the
 * whole chart change colour when a range was picked. A band behind
 * full-strength bars marks the selection without touching what the bars say.
 */
const DAY_COLUMN_HIGHLIGHT = {
    id: 'folderDayHighlight',
    beforeDatasetsDraw(chart: {
        scales?: Record<string, { getPixelForValue(v: number): number; width: number }>;
        data?: { labels?: unknown[] };
        ctx?: CanvasRenderingContext2D;
        chartArea?: { top: number; bottom: number };
    }): void {
        // Read from module state rather than off the instance: the first draw
        // happens *inside* `new Chart(...)`, before any property could be
        // assigned to the instance, so an instance field left the band unpainted
        // until something else forced a redraw.
        const selected = selectedDaySet();
        const dayCount = chart.data?.labels?.length ?? 0;
        const xScale = chart.scales?.['x'];
        const { ctx, chartArea } = chart;
        if (selected === null || xScale === undefined || ctx === undefined || chartArea === undefined) {
            return;
        }
        // **The width of one day, not of one tick.** `xScale.ticks` holds the
        // *rendered* labels, and with `maxTicksLimit: 14` and `autoSkip` on, a
        // 21-day axis draws about 11 of them — so dividing by that made every
        // band roughly twice as wide as the day it marked, spilling over its
        // neighbours. `test.html` had the same bug in both of its copies
        // (`DAY_COLUMN_HIGHLIGHT` and `dayFromEvent`); both now divide by the
        // column count too.
        //
        // The data length is the number of columns the axis actually divides
        // into, whatever it chose to label.
        const columns = Math.max(1, dayCount);
        const dayWidth = xScale.width / columns;
        // One rect for the whole contiguous run rather than one per day, so
        // there is no seam between adjacent bands where the edges meet.
        const days = [...selected].sort((a, b) => a - b);
        const first = days[0];
        const last = days.at(-1);
        if (first === undefined || last === undefined) {
            return;
        }
        ctx.save();
        ctx.fillStyle = '#d0e4fd';
        const left = xScale.getPixelForValue(first) - dayWidth / 2;
        const right = xScale.getPixelForValue(last) + dayWidth / 2;
        ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);
        ctx.restore();
    },
};

/**
 * The selected days, as the plugin wants them, or `null` for the whole window.
 *
 * `null` rather than every day: with nothing selected there is no selection to
 * mark, and banding all 21 columns would read as one solid blue block.
 */
function selectedDaySet(): ReadonlySet<number> | null {
    if (range === null) {
        return null;
    }
    const days = new Set<number>();
    for (let day = range.from; day <= range.to; day++) {
        days.add(day);
    }
    return days;
}

/** Chart.js if the CDN tag loaded, `undefined` if it was blocked. */
function chartJs(): ChartJs | undefined {
    return (window as unknown as { Chart?: ChartJs }).Chart;
}

// --- page state ----------------------------------------------------------

/**
 * The loaded harnesses, in display order, every number computed from these.
 *
 * A list rather than one file because a *directory* is not a harness's unit: a
 * directory in mozilla-central routinely holds an xpcshell manifest and a
 * mochitest one side by side, and a page that showed half of it would answer
 * "what is left to fix here" with the wrong number.
 */
let loaded: LoadedHarness[] = [];
/**
 * The raw parsed file per harness, which `getTreeherderJobUrl` indexes itself.
 *
 * Keyed by harness because the run list has to hand `getTreeherderJobUrl` the
 * raw file the *row* came from — passing the other harness's would resolve the
 * task against the wrong `taskInfo` and produce a plausible, wrong link.
 */
const rawByHarness = new Map<Harness, unknown>();
/**
 * Which harnesses actually have tests under this path, for the heading.
 *
 * Not a *control*: the page always loads both aggregates and merges them. The
 * old `?kind=` selector is gone — once two harnesses can be shown as one
 * ranked list, picking one of them is only a way to see less, and it had a
 * trap: choosing a single harness meant only that file loaded, so `present`
 * came back with one entry, the dropdown disappeared and there was no way back
 * to `both` except editing the URL.
 */
let present: Harness[] = [];
/** The folder being shown. `''` is the whole tree. */
let folder = '';
/** The selected range, or `null` for the whole window. */
let range: DayRange | null = null;
/**
 * The day a shift-click extends from: the last day clicked without shift.
 *
 * `test.html`'s `shiftAnchorDay` (`site/test.ts:329`) and the same rule, so the
 * two pages' timelines behave identically.
 */
let anchorDay: number | null = null;
let filters: IssueFilters = { ...ALL_FILTERS };
let currentSort: SortState = { ...INITIAL_SORT };
/** The expanded test's path, or `null`. At most one is open. */
let openTest: string | null = null;
/** The dates of the loaded window, indexed by day. */
let dates: string[] = [];
/**
 * The chart currently on the timeline canvas, for the click listener.
 *
 * Held in a variable rather than captured, because the listener is attached
 * once and the chart is replaced on every render — see `wireDayClicks`.
 */
let liveChart: InstanceType<ChartJs> | null = null;
/** Whether the canvas already has its click listener. */
let dayClicksWired = false;

let searchBoxManager: SearchBoxManager | null = null;
let hashManager: ReturnType<typeof initUrlHashManager> | null = null;

// The detail-file guards, `issues.html`'s three. Per harness, because the two
// files are fetched independently and one may be absent.
const detailedLoaded = new Set<Harness>();
let loadingDetailed = false;
let detailedLoad: Promise<void> | null = null;
/** The test path whose row is hovered, for the chart overlay. */
let hoveredTest: string | null = null;

/** The last computed worklist, for the tests and for a re-sort without a refetch. */
let currentList: Worklist | null = null;

/**
 * Every window fetched per harness, newest first, before stitching.
 *
 * `loaded[].file` is the *stitched* result, which is what every query reads.
 * The pieces are kept because each backfill re-stitches from scratch: joining
 * an already-joined file to a third window would have to reason about which of
 * its days were seam-resolved, and re-stitching the whole list cannot get that
 * wrong.
 */
const windowsByHarness = new Map<Harness, StitchWindow[]>();
/** The pushdate of the oldest window fetched, or `null` before the first load. */
let oldestPushdate: string | null = null;
/** Guards the backfill against a second click while a fetch is in flight. */
let backfilling = false;
/** Set once a backfill finds nothing usable: stop offering it. */
let backfillExhausted = false;
/**
 * Why the history stops, for the label.
 *
 * Worth distinguishing: "no older data" is the start of the published record,
 * while the older publishing format is a limit of this page's decoders and not
 * of what Taskcluster still holds.
 */
let backfillLimit: 'start-of-data' | 'format' | null = null;
/**
 * Harnesses whose history has run out, so they are no longer fetched.
 *
 * Per harness rather than one flag, because the two aggregates are separate
 * files: one can reach the older publishing format while the other still has
 * windows to give.
 */
const exhaustedHarnesses = new Set<Harness>();
/** Dates the stitched timeline could not fill, for the note under the chart. */
let missingDates: string[] = [];

// --- small DOM helpers ---------------------------------------------------

function byId<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (element === null) {
        throw new Error(`Missing element #${id}`);
    }
    return element as T;
}

/**
 * The decoded file a row came from.
 *
 * A row knows its harness, and the two harnesses are separate files: looking a
 * test up in the wrong one finds nothing, or — worse, since the same filename
 * can exist under both — finds a different test's runs.
 */
function fileOf(row: { harness: Harness }): DecodedTimingFile | null {
    return loaded.find(({ harness }) => harness === row.harness)?.file ?? null;
}

/**
 * The window text on the heading line.
 *
 * Tolerates the element being absent: it is created by
 * the heading's markup, and is empty until `loadWindow` fills it.
 */
function setStatusText(text: string): void {
    const element = document.getElementById('status-text');
    if (element !== null) {
        element.textContent = text;
    }
}

function showError(message: string, showNoData = false): void {
    const error = byId('error');
    error.textContent = message;
    error.style.display = 'block';
    byId('worklist-container').style.display = 'none';
    byId('no-data').style.display = showNoData ? 'block' : 'none';
}

function hideError(): void {
    byId('error').style.display = 'none';
}

// --- the folder autocomplete ---------------------------------------------

/** The folder list, fetched once and shared by both inputs that complete on it. */
let folderList: string[] | null = null;
let folderListLoad: Promise<string[]> | null = null;

/** Every directory holding tests, fetched at most once per page load. */
function folders(): Promise<string[]> {
    if (folderList !== null) {
        return Promise.resolve(folderList);
    }
    folderListLoad ??= loadFolderList().then((list) => {
        folderList = list;
        return list;
    });
    return folderListLoad;
}

/**
 * Wires folder completion onto an input.
 *
 * Shared by the heading's editable path and the no-folder search form: both ask
 * the same question of the same list, and a second copy of the arrow-key and
 * blur handling is how the two come to behave differently.
 */
function wireFolderComplete(
    input: HTMLInputElement,
    dropdown: HTMLElement,
    options: { onPick?: (path: string) => void } = {}
): void {
    const go = (path: string): void => {
        if (options.onPick !== undefined) {
            options.onPick(path);
            return;
        }
        window.location.href = folderPageUrl(path);
    };

    let selected = -1;
    const items = (): HTMLElement[] => [...dropdown.querySelectorAll<HTMLElement>('.ac-item')];
    const highlight = (): void => {
        items().forEach((item, index) => {
            item.style.background = index === selected ? '#e7f3ff' : 'white';
        });
    };
    const hide = (): void => {
        dropdown.style.display = 'none';
        selected = -1;
    };

    const show = (): void => {
        const terms = input.value.trim().toLowerCase().split(/\s+/).filter((t) => t !== '');
        if (terms.length === 0 || folderList === null) {
            hide();
            return;
        }
        const matches = folderList
            .filter((path) => terms.every((term) => path.toLowerCase().includes(term)))
            // Shortest first: typing `urlbar` wants the folder itself above its
            // six subdirectories.
            .sort((a, b) => a.length - b.length || a.localeCompare(b))
            .slice(0, 50);
        selected = -1;
        if (matches.length === 0) {
            hide();
            return;
        }
        dropdown.replaceChildren(
            ...matches.map((path, index) => {
                const item = el('div', {
                    class: 'ac-item',
                    text: path,
                    attrs: {
                        style:
                            'padding: 6px 10px; font-family: monospace; font-size: 12px; ' +
                            'cursor: pointer; white-space: nowrap; overflow: hidden; ' +
                            'text-overflow: ellipsis; background: white;',
                    },
                });
                item.dataset['idx'] = String(index);
                return item;
            })
        );
        dropdown.style.display = 'block';
    };

    input.addEventListener('input', () => {
        // The list may still be in flight on the first keystroke.
        void folders().then(show);
    });
    input.addEventListener('focus', () => {
        void folders();
    });
    input.addEventListener('keydown', (event) => {
        const list = items();
        if (event.key === 'Enter') {
            event.preventDefault();
            const picked = selected >= 0 ? list[selected]?.textContent : input.value.trim();
            if (picked !== undefined && picked !== '') {
                go(picked);
            }
            return;
        }
        if (list.length === 0 || dropdown.style.display === 'none') {
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            selected = Math.min(selected + 1, list.length - 1);
            highlight();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            selected = Math.max(selected - 1, 0);
            highlight();
        } else if (event.key === 'Escape') {
            hide();
        }
    });
    dropdown.addEventListener('mousedown', (event) => {
        const item = (event.target as HTMLElement | null)?.closest('.ac-item');
        if (item !== null && item !== undefined) {
            // `mousedown` rather than `click`, and prevented, so the input's
            // blur does not hide the dropdown before the click lands.
            event.preventDefault();
            go(item.textContent ?? '');
        }
    });
    input.addEventListener('blur', () => {
        // After the dropdown's own `mousedown`, so a pick still registers.
        window.setTimeout(hide, 150);
    });
}

// --- the no-folder search form -------------------------------------------

/**
 * What the page shows with no `?path=`.
 *
 * **The same layout as the page with one**, which is the point: the heading,
 * its path input and the controls stay exactly where they are, and only the
 * charts and the table are replaced by a short hint. Arriving with no path
 * used to swap in a whole different page — its own form, its own label, its
 * own button — so the two states looked like two pages and the input a reader
 * needed was somewhere new.
 *
 * So there is no form to submit: the heading's input *is* the control, already
 * focused, and picking a completion navigates. One input, one place, whether
 * or not a path is loaded.
 */
function showPathPrompt(): void {
    document.title = 'Tests by path';
    for (const selector of ['#charts-box', '#worklist-container']) {
        const element = document.querySelector<HTMLElement>(selector);
        if (element !== null) {
            element.style.display = 'none';
        }
    }
    byId('scope-line').textContent = '';
    setStatusText('');

    const prompt = byId('folder-search');
    prompt.replaceChildren(
        el('p', {
            class: 'path-prompt',
            children: [
                document.createTextNode('Type a path above to see its tests — or pick a '),
                el('a', { text: 'folder to burn down', href: 'flaky.html#date=21days' }),
                document.createTextNode(' from the tree-wide ranking.'),
            ],
        })
    );
    prompt.style.display = '';

    const input = document.getElementById('folder-path-input') as HTMLInputElement | null;
    if (input !== null) {
        input.focus();
        // Warm the completion list so the first keystroke has it.
        void folders().then((list) => {
            const status = document.getElementById('status-text');
            if (status !== null && list.length > 0) {
                status.textContent = `${list.length.toLocaleString()} folders with tests`;
            }
        });
    }
}

/**
 * Every directory that holds a test, from both harnesses.
 *
 * The directories rather than the test paths: this page takes a folder, and
 * offering 100,000 test files to choose a folder from would be the wrong list.
 * Ancestors are included, so `dom` is offerable even though every test sits
 * further down — a burndown often starts at a subsystem rather than at a leaf.
 */
async function loadFolderList(): Promise<string[]> {
    const files = await Promise.all(
        HARNESSES.map((harness) =>
            fetchData(`${harness}-issues.json`)
                .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
                .catch(() => null)
        )
    );
    const folders = new Set<string>();
    for (const raw of files) {
        if (raw === null) {
            continue;
        }
        const tables = (raw as { tables?: { testPaths?: readonly string[] } }).tables;
        for (const directory of tables?.testPaths ?? []) {
            // Every ancestor, so a subsystem is offerable and not only a leaf.
            const parts = directory.split('/');
            for (let depth = 1; depth <= parts.length; depth++) {
                folders.add(parts.slice(0, depth).join('/'));
            }
        }
    }
    return [...folders].sort();
}

// --- the heading line -----------------------------------------------------

/**
 * One harness named as the table names it.
 *
 * Shared by the heading and the row badge so the two cannot drift: the
 * heading's `SCOPE_LABEL` text and the row's raw `harness` were two spellings
 * of one fact.
 */
function harnessBadge(harness: Harness): HTMLElement {
    return el('span', {
        class: `harness-badge harness-${harness}`,
        text: harness,
    });
}

/**
 * Fills the heading's values, leaving its shape alone.
 *
 * The markup already holds the label, the input and the two spans (see
 * `tests.html`), so this assigns text and never replaces nodes — which is what
 * keeps the line from moving as the data arrives. It also means the input
 * keeps focus and any half-typed path across a re-render.
 */
function renderHeading(): void {
    const input = document.getElementById('folder-path-input') as HTMLInputElement | null;
    if (input !== null && document.activeElement !== input) {
        // Not while the reader is typing in it. The width is fixed in CSS, so
        // nothing about the heading moves when the value lands.
        input.value = folder;
    }

    // Which harnesses contributed, stated rather than chosen. A path with both
    // says so; one with a single harness says which, because "these are
    // xpcshell tests" is worth knowing and costs no control.
    //
    // As the same badges the rows use, not as words: the heading and the
    // per-row badge name the same thing, so they should look like the same
    // thing. A reader who sees `mochitest` on a row and `mochitest` in the
    // heading should not have to check whether the two mean the same.
    const harnesses = document.getElementById('heading-harness');
    if (harnesses !== null) {
        harnesses.replaceChildren(...present.map(harnessBadge));
    }

    document.title = folder === '' ? 'Tests by path' : `Tests in ${folder}`;
}

// --- the breadcrumb -------------------------------------------------------

/**
 * The breadcrumb, each segment a link to that folder.
 *
 * The ancestors are links because a burndown reader who finds a folder clean
 * moves *up*, not back to `flaky.html` — the parent is the next place to look
 * and making it a click keeps the loop on this page.
 */
function folderPathLinks(): HTMLElement {
    const container = el('span', { class: 'crumb-path' });

    // The separators carry no surrounding spaces, so the breadcrumb reads as a
    // path exactly as `test.html`'s does — the spaces made it a list of words.
    for (const crumb of breadcrumb(folder)) {
        if (container.childNodes.length > 0) {
            container.append(el('span', { class: 'crumb-sep', text: '/' }));
        }
        if (crumb.path === folder) {
            container.append(el('span', { class: 'crumb-current', text: crumb.name }));
        } else {
            container.append(
                el('a', {
                    class: 'crumb-link',
                    text: crumb.name,
                    title: `Tests in ${crumb.path}`,
                    href: folderPageUrl(crumb.path),
                })
            );
        }
    }
    if (container.childNodes.length === 0) {
        container.append(el('span', { class: 'crumb-current', text: 'All tests' }));
    }

    // Searchfox, for the folder rather than for a test: the reader is about to
    // read the manifest, which is where a skip-if annotation lives.
    if (folder !== '') {
        const searchfox = externalLink(
            `https://searchfox.org/mozilla-central/source/${folder}`,
            '🔍',
            'action-button'
        );
        searchfox.title = 'See this folder on searchfox';
        container.append(searchfox);
    }
    return container;
}

// --- the timeline --------------------------------------------------------

/** The timeline series for the current folder, or `null` with no window. */
function timelineSeries(): Timeline | null {
    if (loaded.length === 0 || dates.length < 2) {
        return null;
    }
    // Summed across harnesses, day by day. `flakinessOfPath` matches a test's
    // **directory** with a trailing separator, so `dom/base` does not select
    // `dom/baseline`.
    const merged: FlakyDay[] = dates.map((date, day) => ({
        day,
        date,
        flaky: 0,
        stable: 0,
        skipped: 0,
        total: 0,
    }));
    for (const { file } of loaded) {
        if (file.days === null) {
            continue;
        }
        for (const entry of flakinessOfPath(file, folder).days) {
            const bucket = merged[entry.day];
            if (bucket === undefined) {
                continue;
            }
            // A test belongs to one harness, so the per-day counts of the two
            // are over disjoint populations and add.
            bucket.flaky += entry.flaky;
            bucket.stable += entry.stable;
            bucket.skipped += entry.skipped;
            bucket.total += entry.total;
        }
    }
    return timeline(merged, thinDays(merged), range);
}

/** The issue-count series, or `null` with no window to plot. */
function issueSeries(): IssueTimeline | null {
    if (loaded.length === 0 || dates.length < 2) {
        return null;
    }
    return issueTimeline(loaded, folder, range, dates);
}

/**
 * Draws the timeline and wires the day selection.
 *
 * Two datasets, counts rather than percentages: this page is one folder, where
 * a percentage of three dozen tests swings on a single test. `flaky.html` has
 * the percentage view, over thousands.
 */
function drawTimeline(series: Timeline | null): void {
    const box = byId('timeline-box');
    if (series === null) {
        box.style.display = 'none';
        return;
    }
    box.style.display = '';
    // The axis legend is painted into the canvas and cannot carry a `title`,
    // so the tooltip goes on the plot that legend labels — replacing the title
    // row that used to sit above it.
    box.title =
        'Counts tests, once a day each however often they failed. Flaky: failed at ' +
        'least once. Skipped: disabled somewhere, and did not fail.';

    const Chart = chartJs();
    const canvas = byId<HTMLCanvasElement>('timeline-canvas');
    if (Chart === undefined) {
        // The CDN tag was blocked. The list below is the substance and works
        // without a chart; hiding the box silently would read as "no history".
        box.style.display = 'none';
        return;
    }
    Chart.getChart(canvas)?.destroy();

    // Every bar at full strength, whatever the range: the selection is a band
    // behind the columns (`DAY_COLUMN_HIGHLIGHT`), which is what `test.html`
    // does. Dimming the bars instead made a quiet day and an out-of-range day
    // look alike.
    const chart = new Chart(canvas, {
        type: 'bar',
        // Per chart, not `Chart.register`: a globally registered plugin is only
        // consulted by charts created *after* the call, so registering from
        // inside a draw left the band silently unpainted — the set was on the
        // instance and nothing read it. An inline `plugins` array is scoped to
        // the chart that needs it and cannot be ordered wrongly.
        plugins: [DAY_COLUMN_HIGHLIGHT],
        data: {
            labels: series.labels,
            datasets: [
                {
                    label: 'Flaky',
                    data: series.flaky,
                    backgroundColor: CHART_COLOURS.flaky.bg,
                    borderColor: CHART_COLOURS.flaky.border,
                    borderWidth: 1,
                    // A thin day is `null`, not 0 — see `timeline()`. Without
                    // this Chart.js would bridge the gap and the day would read
                    // as a fixed folder rather than a day the tree did not run.
                    spanGaps: false,
                },
                {
                    label: 'Skipped',
                    data: series.skipped,
                    backgroundColor: CHART_COLOURS.skip.bg,
                    borderColor: CHART_COLOURS.skip.border,
                    borderWidth: 1,
                    spanGaps: false,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    stacked: true,
                    ticks: { maxTicksLimit: 14, autoSkip: true, maxRotation: 45 },
                    grid: { display: false },
                },
                y: {
                    stacked: true,
                    beginAtZero: true,
                    title: { display: true, text: 'Tests' },
                },
            },
            plugins: {
                legend: { display: true, position: 'bottom' },
                tooltip: {
                    callbacks: {
                        afterTitle: (items: { dataIndex: number }[]): string => {
                            const index = items[0]?.dataIndex;
                            if (index === undefined) {
                                return '';
                            }
                            const day = series.days[index];
                            if (day === undefined) {
                                return '';
                            }
                            if (day.thin) {
                                return 'the tree barely ran';
                            }
                            return `of ${day.total.toLocaleString()} tests run`;
                        },
                    },
                },
            },
        },
    });
    wireDayClicks(chart);
}

/**
 * Makes every day clickable on **both** charts, by asking the x axis.
 *
 * ## Why not Chart.js's `onClick`
 *
 * Measured rather than assumed: it is only called when the interaction found an
 * element, and a day with no issues draws a bar of *zero height*, so there is
 * nothing to find. On the live 21-day aggregate for
 * `devtools/client/memory/test/xpcshell`, **18 of 21 days** had `height: 0`;
 * clicking any of them — or, it turns out, any day at all on such a chart — got
 * no callback, with `mode: 'index'` and `intersect: false` set. A minimal
 * three-bar chart with all-zero data reproduced it, which is what says the
 * cause is Chart.js and not this page's options.
 *
 * Those empty days are exactly the ones a burndown reader clicks: they are the
 * days after the fixes landed. So the selector cannot depend on there being a
 * bar under the cursor.
 *
 * ## Why the listener is on the container
 *
 * One listener on the box that holds both charts, rather than one per canvas.
 * The two charts share an x axis by construction — same labels, same day
 * indices — so a click at a given x means the same day on either, and a reader
 * should not have to know which chart is the interactive one. This is also what
 * `test.html` does (`site/test.ts:1449`, `wireChartArea`): it listens on the
 * chart *area* rather than the canvas, for the neighbouring reason that
 * Chart.js reports no hit outside the plot area, leaving the axis labels and
 * the gap between charts dead space.
 *
 * The pixel is resolved against whichever chart is live, and clicks outside the
 * plot area are ignored, so the y-axis gutter and the right-hand padding are
 * not a selection.
 */
function wireDayClicks(chart: InstanceType<ChartJs>): void {
    // The live chart, read at click time. A canvas outlives every chart drawn
    // on it, so the listener must not close over one: the charts are destroyed
    // and rebuilt on every render, and a listener holding an old instance would
    // read a stale `chartArea`.
    liveChart = chart;
    if (dayClicksWired) {
        return;
    }
    const container = document.getElementById('charts-box');
    if (container === null) {
        return;
    }
    // **Attached exactly once.** Wiring it per render instead made the
    // listeners accumulate, so one physical click ran the handler N times and
    // the toggle raced itself: after a render or two, clicking the selected day
    // cleared it and immediately reselected, and clicking a *new* day selected
    // then cleared. Measured in a browser — one dispatched click, one `click`
    // event, and a range that ended up `null` instead of the day clicked.
    // `render()` runs on every filter, sort and selection change, so this
    // compounds quickly.
    dayClicksWired = true;
    container.addEventListener('click', (event) => {
        const scale = liveChart?.scales?.['x'];
        const area = liveChart?.chartArea;
        const canvas = liveChart?.canvas;
        if (scale?.getValueForPixel === undefined || area === undefined || canvas == null) {
            return;
        }
        // A click on the notes, the title or the range button is not a day.
        const target = event.target as HTMLElement | null;
        if (target === null || target.closest('.chart-click-area') === null) {
            return;
        }
        const pixel = event.clientX - canvas.getBoundingClientRect().left;
        if (pixel < area.left || pixel > area.right) {
            // The y-axis gutter and the right-hand padding are not days.
            return;
        }
        const day = Math.round(scale.getValueForPixel(pixel));
        const count = liveChart?.data?.labels?.length ?? 0;
        if (!Number.isFinite(day) || day < 0 || day >= count) {
            return;
        }
        handleDayClick(day, event);
    });
}

/**
 * Draws the issue-count chart, with the hovered test's share highlighted.
 *
 * Stacked failures / timeouts / crashes / skips, as **counts**. The hover
 * overlay is `test.html`'s trick (`makeDatasetPair`): each series becomes two
 * datasets — the hovered test's contribution, bright, and the remainder, dim,
 * stacked on top — so the total bar height never moves and the hovered test
 * reads as a share of it. With nothing hovered the bright half holds the whole
 * count and the dim half is zero, so the chart looks the same as it would with
 * one dataset per series.
 */
function drawIssueChart(series: IssueTimeline | null): void {
    const box = byId('issue-chart-area');
    // Whether anything *of a counted type* happened. Asking `hasIssues` alone
    // would keep the chart up for a folder whose only issues are skips after
    // the reader has unchecked skips.
    const anyCounted =
        series !== null &&
        ((filters.failures && series.hasIssues) ||
            (filters.timeouts && series.hasIssues) ||
            (filters.crashes && series.hasIssues) ||
            (filters.skips && series.hasSkips));
    if (series === null || !anyCounted) {
        box.style.display = 'none';
        return;
    }
    box.style.display = '';
    // The axis legend is painted *into the canvas*, so it cannot carry a
    // `title` of its own; the tooltip goes on the plot that legend labels,
    // which is the smallest element a reader can hover to ask "what is this
    // counting".
    // Says which way round the two charts count, because that is the one thing
    // a reader can get wrong here. An earlier version had it backwards — it
    // claimed the two scenarios looked alike *below* and different here, which
    // is exactly inverted: this chart sums occurrences, so 400 failures is 400
    // whether it was one test or four hundred, and the chart below counts each
    // test once a day, so the same two days read 1 and 400.
    box.title =
        'Counts every failure, so one test failing 400 times reads the same as 400 ' +
        'tests failing once. The chart below tells those apart. Hover a row to see ' +
        'that test’s share.';
    const Chart = chartJs();
    const canvas = byId<HTMLCanvasElement>('issue-chart-canvas');
    if (Chart === undefined) {
        box.style.display = 'none';
        return;
    }
    Chart.getChart(canvas)?.destroy();

    const dayCount = series.days.length;
    const mine =
        hoveredTest === null
            ? null
            : testContribution(loaded, hoveredTest, dayCount);

    /**
     * One series as a bright/dim pair. See the note above.
     *
     * The *hover* remainder is dimmed, and only that: the pale half is "the
     * other tests", which is a different quantity from the bright half and has
     * to be told apart from it. The **range** is not expressed by dimming —
     * that is the column band — so a bar is full strength whether or not it is
     * in the selected range, exactly as on `test.html`.
     */
    const pair = (
        label: string,
        totals: readonly number[],
        own: readonly number[] | undefined,
        colour: { bg: string; border: string }
    ): Record<string, unknown>[] => {
        const ownData = own ?? new Array<number>(dayCount).fill(0);
        return [
            {
                label,
                data: totals.map((total, index) =>
                    mine === null ? total : (ownData[index] ?? 0)
                ),
                backgroundColor: colour.bg,
                borderColor: colour.border,
                borderWidth: 1,
                stack: 'issues',
            },
            {
                label: `${label} (other tests)`,
                data: totals.map((total, index) =>
                    mine === null ? 0 : Math.max(0, total - (ownData[index] ?? 0))
                ),
                // `test.html`'s remainder alpha for the same purpose.
                backgroundColor: withAlpha(colour.bg, 0.18),
                borderWidth: 0,
                stack: 'issues',
            },
        ];
    };

    // **Only the counted types are plotted.** Unchecking one takes it out of
    // the chart as well as out of the numbers, which is the point of the
    // control: skips outnumber failures by an order of magnitude in most
    // folders, so with them shown the failures are a sliver and the chart
    // cannot answer "did the failures go down".
    const datasets = [
        ...(filters.failures
            ? pair('Failures', series.failures, mine?.failures, CHART_COLOURS.fail)
            : []),
        ...(filters.timeouts
            ? pair('Timeouts', series.timeouts, mine?.timeouts, CHART_COLOURS.timeout)
            : []),
        ...(filters.crashes
            ? pair('Crashes', series.crashes, mine?.crashes, CHART_COLOURS.crash)
            : []),
        ...(filters.skips ? pair('Skips', series.skips, mine?.skips, CHART_COLOURS.skip) : []),
    ];
    if (datasets.length === 0) {
        // Every type unchecked: there is nothing to plot, and an empty axis
        // reads as "no issues" rather than "you asked for none".
        box.style.display = 'none';
        return;
    }

    new Chart(canvas, {
        type: 'bar',
        plugins: [DAY_COLUMN_HIGHLIGHT],
        data: { labels: series.labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    stacked: true,
                    ticks: { maxTicksLimit: 14, autoSkip: true, maxRotation: 45 },
                    grid: { display: false },
                },
                y: {
                    stacked: true,
                    beginAtZero: true,
                    // The axis legend is the chart's label now: the title row
                    // above it was a third of a 150px box spent on one word.
                    // Its tooltip (`#issue-chart-area`'s `title`, set below)
                    // carries the sentence the heading used to spell out.
                    title: { display: true, text: 'Issues' },
                },
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: {
                        // The `(other tests)` halves are the same four
                        // categories again; listing eight entries for four
                        // colours reads as eight series.
                        filter: (item: { text?: string }): boolean =>
                            !(item.text ?? '').includes('(other tests)'),
                    },
                },
                tooltip: {
                    callbacks: {
                        label: (context: {
                            dataset: { label?: string };
                            parsed: { y: number };
                        }): string | null => {
                            const label = context.dataset.label ?? '';
                            const value = context.parsed.y;
                            if (value === 0) {
                                // A category that did not happen is not worth a
                                // line — `issues.html`'s rule for the same chart.
                                return null;
                            }
                            // The unit, on the line itself: `Failures: 400` is
                            // the number a reader mistakes for a test count,
                            // and the plot's own tooltip is not on screen while
                            // a bar is hovered.
                            return `${label}: ${value.toLocaleString()} ${
                                value === 1 ? 'time' : 'times'
                            }`;
                        },
                    },
                },
            },
        },
    });
}

/**
 * Hovering a test row highlights its share of the issue chart.
 *
 * What `test.html` does when a reader hovers one of its cells, applied to a
 * folder's rows: the question "is this the test causing the spike on the 4th?"
 * is answered by pointing at the row rather than by opening it.
 *
 * Only the issue chart redraws. The tests-per-day chart counts *tests*, where
 * one test is one unit on the days it was flaky and highlighting it would be a
 * bar of height 1 — true but not worth a repaint on every mouse move.
 */
function setHoveredTest(path: string | null): void {
    if (hoveredTest === path) {
        return;
    }
    hoveredTest = path;
    drawIssueChart(issueSeries());
}

/**
 * Clicking a day in the timeline.
 *
 * `test.html`'s `handleDayClick` (`site/test.ts:673-700`), reduced to the
 * contiguous case this page needs: shift extends from the anchor, a plain click
 * selects one day, and clicking the one selected day clears back to the whole
 * window. `test.html` additionally lets ctrl toggle a *discontiguous* set of
 * days, which this page has no use for — a burndown range is "since the fixes
 * landed", which is contiguous by construction, and `DayRange` is a pair rather
 * than a set precisely so the range can go in the URL and into
 * `findIssues`'s `dayRange`.
 */
function handleDayClick(dayIndex: number, event: MouseEvent | undefined): void {
    if (event?.shiftKey === true && anchorDay !== null) {
        range = rangeOf(anchorDay, dayIndex);
    } else if (
        range !== null &&
        range.from === dayIndex &&
        range.to === dayIndex
    ) {
        // The same affordance as `test.html`'s: clicking the selected day again
        // returns to the unfiltered view, which is what makes the filter safe
        // to try.
        range = null;
        anchorDay = null;
    } else {
        range = { from: dayIndex, to: dayIndex };
        anchorDay = dayIndex;
    }
    // The expanded test's lines were computed over the old range.
    openTest = null;
    render();
    updateUrlHash();
}

/** Clears the range, from the "see all N days" link on the scope line. */
function clearRange(): void {
    if (range === null) {
        return;
    }
    range = null;
    anchorDay = null;
    openTest = null;
    render();
    updateUrlHash();
}

// --- the worklist --------------------------------------------------------

/** One stat cell. */
function statItem(
    label: string,
    value: string,
    valueClass: string,
    title?: string
): HTMLElement {
    const cell = el('div', {
        class: 'stat-item',
        children: [
            el('span', {
                class: `stat-value${valueClass === '' ? '' : ` ${valueClass}`}`,
                text: value,
            }),
            el('span', { class: 'stat-label', text: label }),
        ],
    });
    if (title !== undefined) {
        cell.title = title;
    }
    return cell;
}

/** A count cell, greyed when zero so the eye lands on what is non-zero. */
function countCell(label: string, value: number, kind: string): HTMLElement {
    return statItem(
        label,
        formatNumber(value),
        value === 0 ? 'zero' : kind
    );
}

/** The seven stat cells of a row, in header order. */
function statCells(row: {
    runCount: number;
    issueRate: number;
    issueCount: number;
    skipCount: number;
    failCount: number;
    timeoutCount: number;
    crashCount: number;
}): HTMLElement[] {
    const percent = percentageDisplay(row.issueRate);
    return [
        statItem('Runs', formatNumber(row.runCount), 'muted'),
        statItem('Issue %', percent.displayValue, percent.cssClass),
        countCell('Issues', row.issueCount, ''),
        countCell('Skips', row.skipCount, 'skip'),
        countCell('Failures', row.failCount, 'fail'),
        countCell('Timeouts', row.timeoutCount, 'timeout'),
        countCell('Crashes', row.crashCount, 'fail'),
    ];
}

/** The sortable column header. */
function sortHeader(): HTMLElement {
    const stats = el('div', { class: 'tree-stats' });
    for (const [field, label] of STAT_COLUMNS) {
        const active = currentSort.field === field;
        const button = el('button', {
            class: `sort-button${active ? ' active' : ''}`,
            children: [
                el('span', {
                    class: 'sort-arrow',
                    text: active ? (currentSort.direction === 'asc' ? '▲' : '▼') : '',
                }),
                document.createTextNode(label),
            ],
        });
        button.addEventListener('click', () => {
            currentSort = nextSort(currentSort, field);
            render();
        });
        stats.append(el('div', { class: 'stat-item', children: [button] }));
    }

    const nameActive = currentSort.field === 'name';
    const nameButton = el('button', {
        class: `sort-button is-name${nameActive ? ' active' : ''}`,
        children: [
            el('span', {
                class: 'sort-arrow',
                text: nameActive ? (currentSort.direction === 'asc' ? '▲' : '▼') : '',
            }),
            document.createTextNode('Test'),
        ],
    });
    nameButton.addEventListener('click', () => {
        currentSort = nextSort(currentSort, 'name');
        render();
    });

    return el('div', {
        class: 'tree-row sort-header',
        children: [
            el('div', { class: 'tree-name', children: [nameButton] }),
            stats,
        ],
    });
}

/**
 * The folder's own totals, above the rows — and the way *up* the tree.
 *
 * The path here is the linked one: each ancestor segment navigates to that
 * folder's burndown. Together with the subfolder segments on the test rows
 * below (`displayName`), that is a complete two-way walk of the tree from
 * inside the table — up through this row, down through a test's own path — and
 * it is why the heading no longer carries links of its own.
 */
function totalRow(list: Worklist): HTMLElement {
    return el('div', {
        class: 'tree-row total-row',
        children: [
            el('div', {
                class: 'tree-name',
                children: [
                    folderPathLinks(),
                    el('span', {
                        class: 'folder-count',
                        text: `(${list.totalTestCount.toLocaleString()} tests)`,
                    }),
                ],
            }),
            el('div', { class: 'tree-stats', children: statCells(list) }),
        ],
    });
}

/**
 * The count of tests under this path with nothing wrong with them.
 *
 * Not a row: it is the folder's remainder, not a thing to sort or click, so it
 * carries no stat cells and no hover chart.
 *
 * Counted before the search narrowed the list, like the "N tests with issues"
 * on the scope line, so filtering the table does not make the folder look as
 * though it grew a clean test.
 */
function cleanTestsNote(clean: number): HTMLElement {
    return el('div', {
        class: 'clean-note',
        text: `+ ${clean.toLocaleString()} test${clean === 1 ? '' : 's'} without issue.`,
    });
}

/** One test row. */
function testRow(test: WorklistRow, showHarness: boolean): HTMLElement {
    const label: (Node | string)[] = [
        el('span', { class: 'test-icon' }),
        ...testNameNodes(test.fullPath, test.component),
    ];
    if (showHarness) {
        // Only when both harnesses contributed rows. On a single-harness
        // folder the badge would be the same word on every row, which says
        // nothing and costs the filename its space.
        label.push(harnessBadge(test.harness));
    }

    const element = el('div', {
        class: `tree-row test-row${openTest === test.fullPath ? ' expanded' : ''}`,
        attrs: { 'data-path': test.fullPath, 'data-harness': test.harness },
        children: [
            el('div', { class: 'tree-name', children: label }),
            el('div', { class: 'tree-stats', children: statCells(test) }),
        ],
    });
    element.addEventListener('click', () => toggleTest(element, test));
    // The chart overlay. `mouseenter`/`mouseleave` rather than `mouseover`, so
    // moving between a row's own children does not redraw the chart.
    element.addEventListener('mouseenter', () => setHoveredTest(test.fullPath));
    element.addEventListener('mouseleave', () => setHoveredTest(null));
    return element;
}

/**
 * What a row calls a test, with its subfolders as links.
 *
 * The path relative to the folder, because the folder is already on the total
 * row above and repeating it on 180 rows pushes the filename — the only part
 * that differs — off the readable left edge.
 *
 * The **subfolder segments are links** to those folders' burndowns, which is
 * the way *down* the tree: a reader looking at
 * `browser/browser_ext_foo.js` under `.../extensions/test` can jump straight
 * into `.../extensions/test/browser` and see only its siblings. The filename
 * itself stays the `test.html` link it has always been, so the two
 * destinations are distinguishable by where you click.
 */
function testNameNodes(fullPath: string, component: string | null): Node[] {
    const relative = displayName(fullPath);
    const parts = relative.split('/');
    const fileName = parts.pop() ?? relative;
    const nodes: Node[] = [];
    let prefix = folder;
    for (const part of parts) {
        prefix = prefix === '' ? part : `${prefix}/${part}`;
        const link = el('a', {
            class: 'subfolder-link',
            text: part,
            title: `Tests in ${prefix}`,
            href: folderPageUrl(prefix),
        });
        // Not the row's click, which expands the test's issue list.
        link.addEventListener('click', (event) => event.stopPropagation());
        nodes.push(link, el('span', { class: 'crumb-sep', text: '/' }));
    }
    // The filename keeps the shared treatment: a `test.html` link, then 📋 and
    // 🔍. The tooltip says where the link goes and names the component, which
    // the row has no column for — a reader triaging a folder wants to know
    // whose tests these are without opening each one.
    const title =
        component === null
            ? `Test details for ${fullPath}`
            : `Test details for ${fullPath}\nComponent: ${component}`;
    nodes.push(...testRowLink(fullPath, { text: fileName, title }));
    return nodes;
}

/** The path relative to the folder being shown. */
function displayName(fullPath: string): string {
    if (folder === '') {
        return fullPath;
    }
    const prefix = `${folder}/`;
    return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
}

// --- expansion -----------------------------------------------------------

/**
 * Opens or closes one test's issue list.
 *
 * At most one test is open at a time, which is `issues.html`'s rule for the
 * same level. Opening one starts the detail fetch in the background — not
 * awaited, because the issue lines come from the file already loaded and only
 * the per-run links need the larger one.
 */
function toggleTest(row: HTMLElement, test: WorklistRow): void {
    if (openTest === test.fullPath) {
        openTest = null;
        row.classList.remove('expanded');
        removeFollowing(row, (element) => element.classList.contains('tree-row'));
        updateUrlHash();
        return;
    }
    // Close whatever else is open, and drop its detail rows.
    for (const open of document.querySelectorAll('.issue-details-row')) {
        open.remove();
    }
    for (const open of document.querySelectorAll('.tree-row.expanded')) {
        open.classList.remove('expanded');
    }
    openTest = test.fullPath;
    row.classList.add('expanded');
    void loadDetailedData();
    if (fileOf(test) !== null) {
        insertAfter(row, [issueDetails(test)]);
    }
    updateUrlHash();
}

/** One test's expanded issue list. */
function issueDetails(test: WorklistRow): HTMLElement {
    const file = fileOf(test)!;
    const lines = issueLines(file, test.testId, filters, range);
    const content = el('div', { class: 'issue-details-content' });

    if (lines.length === 0) {
        // The two messages are distinct on purpose, as they are on
        // `issues.html`: a test with no issues in this range reads differently
        // from one whose issues are all of unchecked types, and in a burndown
        // the first means "fixed" and the second means "you hid it".
        const unfiltered = issueLines(file, test.testId, ALL_FILTERS, range);
        content.append(
            el('p', {
                class: 'issue-empty',
                text:
                    unfiltered.length === 0
                        ? 'No issues for this test in the selected range.'
                        : 'No issues of the selected types for this test in the selected range.',
            })
        );
    } else {
        const section = el('div', { class: 'issue-section' });
        for (const line of lines) {
            section.append(issueLine(test, line));
        }
        content.append(section);
    }

    return el('div', { class: 'issue-details-row', children: [content] });
}

/** One issue line: a count, a type badge and the message. */
function issueLine(test: WorklistRow, issue: TestIssue): HTMLElement {
    const count = el('span', { class: 'issue-count', text: String(issue.count) });
    const badge = el('span', {
        class: `issue-badge ${BADGE_CLASS[issue.type]}`,
        text: issue.type,
    });
    const message = el('span', { class: 'issue-message' });
    if (issue.type === 'FAIL') {
        // The one place this renderer assigns `innerHTML`: it is
        // `common-ui.js`'s output, which turns `[path:123]` into a Searchfox
        // link, and the alternative is re-implementing its parsing here.
        // Every other type's text goes in as text.
        message.innerHTML = linkifyFailureMessage(issue.message, test.fullPath);
    } else {
        message.textContent = issue.message;
    }

    const item = el('div', {
        class: 'issue-item',
        children: [count, badge, message],
    });

    // Only a type with task attribution can list runs. A SKIP has none — it
    // never ran — so the row is inert rather than expanding to "no runs found".
    if (issue.type !== 'SKIP') {
        item.classList.add('has-runs');
        const runs = el('div', { class: 'issue-runs', attrs: { style: 'display: none;' } });
        item.addEventListener('click', (event) => {
            event.stopPropagation();
            void toggleIssueRuns(test, issue, runs);
        });
        return el('div', { class: 'issue-block', children: [item, runs] });
    }
    return item;
}

/**
 * Opens or closes one issue line's run list.
 *
 * Awaits the detail fetch if it is in flight: the reader has clicked the thing
 * that needs it, so "Loading runs…" is the honest state rather than an empty
 * table that fills in later or not at all.
 */
async function toggleIssueRuns(
    test: WorklistRow,
    issue: TestIssue,
    container: HTMLElement
): Promise<void> {
    if (container.style.display !== 'none') {
        container.style.display = 'none';
        container.replaceChildren();
        return;
    }
    container.style.display = '';
    container.replaceChildren(el('span', { class: 'loading', text: 'Loading runs…' }));
    void loadDetailedData();
    if (detailedLoad !== null) {
        await detailedLoad;
    }
    const rows = runRows(test, issue);
    container.replaceChildren();
    if (rows.length === 0) {
        container.append(
            el('span', {
                class: 'loading',
                text: 'No runs recorded for this issue in the selected range.',
            })
        );
        return;
    }
    const table = el('table');
    table.append(...rows);
    container.append(table);
}

/**
 * The runs behind one issue line, newest first.
 *
 * `issues.html`'s `runRows`, plus the range: an occurrence outside the selected
 * window is not one of the occurrences the line counted, and listing it would
 * contradict the count right next to it.
 */
function runRows(test: WorklistRow, issue: TestIssue): HTMLElement[] {
    const file = fileOf(test);
    if (file === null) {
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

    for (const run of file.runsOfTest(test.testId)) {
        if (!matchesIssueLine(run, issue.type, issue.message)) {
            continue;
        }
        // The same range the counts used. A `null` day is a daily file, which
        // is one day and is never filtered — `inDayRange`'s rule, applied here
        // because this loop reads raw entries rather than going through it.
        if (range !== null && run.day !== null && (run.day < range.from || run.day > range.to)) {
            continue;
        }
        const taskIds = run.taskIds;
        if (taskIds === undefined) {
            // A counts-only file: no attribution to list.
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
                taskIdIndex === undefined ? '' : (file.jobNameOfTaskIndex(taskIdIndex) ?? '');
            const minidump = run.minidumps?.[index] ?? null;
            runs.push({
                date: run.day === null ? null : (dates[run.day] ?? null),
                jobName,
                profileUrl: getProfilerUrl(
                    { taskId, retryId: String(retryId), jobName },
                    test.fullPath
                ),
                // `getCrashViewerUrl` returns `''` with no minidump; `|| null`
                // keeps the two cases one value.
                crashUrl:
                    issue.type === 'CRASH'
                        ? getCrashViewerUrl({ taskId, retryId: String(retryId), minidump }) || null
                        : null,
                jobUrl: getTreeherderJobUrl(
                    { taskId, retryId: String(retryId) },
                    rawByHarness.get(test.harness) ?? null
                ),
            });
        }
    }

    // Newest first, and the date printed only on the first row of a day —
    // `prepareRunsForDisplay`'s two rules, applied here because it builds a
    // `<td>` as a string this renderer has no use for.
    runs.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

    let lastDate: string | null = null;
    return runs.map((run) => {
        const showDate = run.date !== null && run.date !== lastDate;
        lastDate = run.date;
        const dateCell = el('td', { class: 'run-date', text: showDate ? run.date! : '' });
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

// --- rendering -----------------------------------------------------------

/** Rebuilds the page from the current state. */
function render(): void {
    if (loaded.length === 0) {
        return;
    }
    hideError();
    renderHeading();

    const series = timelineSeries();
    drawTimeline(series);
    drawIssueChart(issueSeries());

    const list = worklist(
        loaded,
        folder,
        filters,
        range,
        currentSort,
        searchBoxManager?.getValue() ?? ''
    );
    currentList = list;

    const scopeEl = byId('scope-line');
    renderBackfillControl(backfilling ? 'loading…' : undefined);

    scopeEl.textContent = scopeLine(list, range, dates);
    if (range !== null && dates.length > 0) {
        // The escape from a range, on the line that already states it — rather
        // than a button above the charts next to a second copy of the range.
        const reset = el('button', {
            class: 'scope-reset',
            text: `see all ${dates.length} days`,
        });
        reset.addEventListener('click', clearRange);
        scopeEl.append(el('span', { class: 'crumb-sep', text: ' · ' }), reset);
    }

    const container = byId('worklist-container');
    container.style.display = '';
    const table = byId('worklist-table');
    table.replaceChildren();

    if (list.totalTestCount === 0) {
        table.append(
            noData(
                folder === ''
                    ? 'No tests in this file.'
                    : `No tests under ${folder}. Check the path, or pick a parent above.`
            )
        );
        return;
    }

    table.append(sortHeader(), totalRow(list));

    if (list.tests.length === 0) {
        // The distinction a burndown lives on: nothing left to fix here, versus
        // a search or a filter hiding what is.
        const search = (searchBoxManager?.getValue() ?? '').trim();
        table.append(
            noData(
                search !== ''
                    ? `No test under ${folder === '' ? 'the tree' : folder} matching “${search}” has an issue in this range.`
                    : list.testsWithIssues > 0
                      ? 'No issues of the selected types in this range. Check the boxes above.'
                      : '🎉 No issues in this range — every test here passed everywhere it ran.'
            )
        );
        return;
    }

    // The badge column only when the merge is actually mixing two harnesses.
    const showHarness = new Set(list.tests.map((test) => test.harness)).size > 1;
    for (const test of list.tests) {
        table.append(testRow(test, showHarness));
    }

    // A table where every row has an issue reads as "everything here is
    // broken". The clean tests are the rest of the folder and the reason the
    // rate above is what it is, so the count says so — `flaky.html` closes its
    // folders the same way.
    const clean = list.totalTestCount - list.testsWithIssues;
    if (clean > 0) {
        table.append(cleanTestsNote(clean));
    }

    // Reopen whatever was open, so a re-sort or a filter change does not
    // collapse the row the reader is reading.
    if (openTest !== null) {
        const row = table.querySelector<HTMLElement>(`[data-path="${cssEscape(openTest)}"]`);
        if (row !== null) {
            insertAfter(row, [issueDetails(list.tests.find((t) => t.fullPath === openTest)!)]);
        } else {
            // It was filtered out of the new list.
            openTest = null;
        }
    }
}

/**
 * A test path as a CSS attribute-selector value.
 *
 * `CSS.escape` where it exists — a test path holds `/`, `.` and occasionally a
 * `[`, all of which are selector syntax. jsdom has it, so the fallback is for
 * an old browser rather than for the tests.
 */
function cssEscape(value: string): string {
    const api = (window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS;
    return api?.escape === undefined ? value.replace(/["\\]/g, '\\$&') : api.escape(value);
}

// --- loading -------------------------------------------------------------

/**
 * Loads every harness the scope asks for, for the current window.
 *
 * Both files are fetched **in parallel and independently**: a folder that only
 * exists in one harness gets a 404 for the other, which is not an error but the
 * answer. A scope of `both` with only one file present therefore still renders,
 * and `harnessesWithTests` is what decides whether the other one had anything
 * to say.
 *
 * Replaces `common-ui.js`'s `initHistoricalToggle`, which fetches exactly one
 * `historicalDataFile` and hands it back — an interface that cannot express a
 * merge. The button, the date select and the status text are driven here
 * instead; that is the whole reason this page does not use the shared helper.
 */
async function loadWindow(): Promise<void> {
    setStatusText('Loading data...');
    hideError();
    const wanted = [...HARNESSES];

    try {
        const results = await Promise.all(
            wanted.map(async (harness): Promise<LoadedHarness | null> => {
                const response = await fetchData(`${harness}-issues.json`);
                if (!response.ok) {
                    // Not an error: a harness with no data, or none for this
                    // window. The other one may still have plenty.
                    return null;
                }
                const raw = (await response.json()) as IssuesFile;
                rawByHarness.set(harness, raw);
                const file = decodeIssues(raw);
                const window: StitchWindow = { file, dates: windowDates(file) };
                // The first window is also the oldest so far, and the list a
                // backfill will re-stitch from.
                windowsByHarness.set(harness, [window]);
                return {
                    harness,
                    file,
                    dates: [...window.dates],
                };
            })
        );
        loaded = results.filter((entry): entry is LoadedHarness => entry !== null);
        if (loaded.length === 0) {
            showError(
                `No data for ${wanted.map((h) => SCOPE_LABEL[h]).join(' or ')}.`,
                true
            );
            return;
        }

        const merged = mergedWindow(loaded);
        dates = merged.dates;
        // Where a backfill starts counting back from. The published windows are
        // per-harness but generated by one job on one schedule, so the merged
        // window's oldest date is the right anchor for both.
        oldestPushdate = merged.dates[0] ?? null;
        backfillExhausted = false;
        backfillLimit = null;
        exhaustedHarnesses.clear();
        missingDates = [];
        if (!merged.aligned) {
            // The two aggregates are generated by one job on one schedule, so
            // this should not happen — and if it does, aligning day 0 of one
            // with day 1 of the other would attribute every failure to the
            // wrong date. Say so rather than plot it.
            console.warn('The harness windows do not share an end date; charts may be misaligned.');
        }
        present = harnessesWithTests(loaded, folder);
        openTest = null;
        if (pendingDays !== null && pendingDays > dates.length) {
            // A link asked for a longer span, so this window is not what the
            // reader is here to see. Drawing it first made the charts settle
            // through 21 → 41 → 61 days, each step a full repaint of a chart
            // nobody asked for. `restoreBackfill` renders once, with the whole
            // span; the status line says what is happening meanwhile.
            setStatusText(`Loading ${pendingDays} days…`);
            return;
        }
        render();
        setStatusText(windowStatus());
    } catch (error) {
        showError(
            `Error loading data: ${error instanceof Error ? error.message : String(error)}`,
            true
        );
    }
}

/**
 * The pushdate to ask for next, given the oldest date already held.
 *
 * One day *inside* the current span, not one day before it. Each archived run
 * publishes a 21-day window ending on its pushdate, so asking for the day
 * before the span would make that run's `endDate` day — the unreliable one,
 * undercounted because the run is generated while jobs are still landing —
 * the seam. Asking for the span's own oldest date instead puts the seam on a
 * date the window already holds, so `stitchWindows` resolves it in favour of
 * the newer run and the 20 genuinely new days are all interior.
 *
 * See `lib/formats/stitch.ts` for the measurement behind that.
 */
function nextBackfillPushdate(oldest: string): string {
    return oldest;
}


/**
 * Fetches the previous window per harness and re-stitches the timeline.
 *
 * A failure is not an error banner: "nothing older" is an ordinary answer, so
 * the button retires itself rather than complaining. Measured 2026-09-15: the
 * oldest pushdate that answers is 2026-01-31 and 2026-01-30 is a 404 — the day
 * this data started being produced, not an expiry, so the floor stays put.
 */
/**
 * Fetches one harness's aggregate for a pushdate.
 *
 * `null` when nothing is published there, `'too-old'` when the file exists but
 * predates the format this codebase decodes. The two are distinguished because
 * they mean different things to the reader — one is the end of the record, the
 * other a limit of this page.
 */
async function fetchBackfillWindow(
    harness: Harness,
    pushdate: string
): Promise<StitchWindow | null | 'too-old'> {
    if (exhaustedHarnesses.has(harness)) {
        return 'too-old';
    }
    const response = await fetchData(`${harness}-issues.json`, pushdate);
    if (!response.ok) {
        return null;
    }
    const raw = (await response.json()) as unknown;
    // Runs older than about 2026-02-16 key their per-day arrays `hours`
    // instead of `days`, a shape no decoder here knows. Checked before
    // decoding: the decoder only inspects a group when it iterates one, so
    // such a file loads without complaint and then throws inside the render.
    if (!isDecodableAggregate(raw)) {
        return 'too-old';
    }
    const file = decodeIssues(raw as IssuesFile);
    return { file, dates: windowDates(file) };
}

/**
 * Files a fetched window under its harness, reporting whether it was new.
 *
 * A window already held is dropped rather than appended: re-stitching is
 * idempotent, but a duplicate would be counted as a seam on every one of its
 * days.
 */
function addWindow(harness: Harness, window: StitchWindow): boolean {
    const windows = windowsByHarness.get(harness);
    if (windows === undefined) {
        return false;
    }
    if (windows.some((held) => held.dates[0] === window.dates[0])) {
        return false;
    }
    windows.push(window);
    return true;
}

/**
 * Rebuilds every harness's timeline from the windows held, and the merged span.
 *
 * Always from the full list, never incrementally: joining an already-joined
 * file to another window would have to reason about which of its days were
 * seam-resolved, and re-stitching from scratch cannot get that wrong.
 */
function restitch(): void {
    const missing = new Set<string>();
    for (const entry of loaded) {
        const windows = windowsByHarness.get(entry.harness);
        if (windows === undefined || windows.length === 0) {
            continue;
        }
        const stitched = stitchWindows(windows);
        entry.file = stitched.file;
        entry.dates = stitched.dates;
        for (const date of stitched.missing) {
            missing.add(date);
        }
        // The detailed file describes the newest window only, so a stitched
        // timeline no longer matches it. Drop the flag so a reopened row
        // re-fetches rather than resolving task indices against a file that
        // covers a fraction of the days.
        detailedLoaded.delete(entry.harness);
    }
    const merged = mergedWindow(loaded);
    dates = merged.dates;
    oldestPushdate = merged.dates[0] ?? oldestPushdate;
    missingDates = [...missing].sort();
}

/**
 * Fetches the previous window per harness and re-stitches the timeline.
 *
 * One step, because the button asks for one more window and cannot know
 * whether another exists without seeing this one's result. `restoreBackfill`
 * takes the parallel path instead: a shared link names its whole span up
 * front, so the pushdates are known without fetching.
 *
 * A failure is not an error banner: "nothing older" is an ordinary answer, so
 * the button retires itself rather than complaining. Measured 2026-09-15: the
 * oldest pushdate that answers is 2026-01-31 and 2026-01-30 is a 404 — the day
 * this data started being produced, not an expiry, so the floor stays put.
 */
async function backfillOlderWindow(): Promise<void> {
    if (backfilling || backfillExhausted || oldestPushdate === null || loaded.length === 0) {
        return;
    }
    backfilling = true;
    const pushdate = nextBackfillPushdate(oldestPushdate);
    renderBackfillControl(`loading ${pushdate}…`);

    try {
        const before = dates.length;
        const fetched = await Promise.all(
            loaded.map(async ({ harness }) => ({
                harness,
                window: await fetchBackfillWindow(harness, pushdate),
            }))
        );

        let added = 0;
        for (const { harness, window } of fetched) {
            if (window === null) {
                continue;
            }
            // A harness whose next window predates the format change will
            // never yield another one, so stop fetching it. Without this,
            // every later click re-downloads the same unusable file.
            if (window === 'too-old') {
                exhaustedHarnesses.add(harness);
                continue;
            }
            if (addWindow(harness, window)) {
                added++;
            }
        }
        if (added === 0) {
            // Nothing usable at that pushdate: the start of the published
            // record, a day the job did not run, or — going back far enough —
            // the older published format. All three mean the history stops.
            backfillExhausted = true;
            backfillLimit = fetched.some(({ window }) => window === 'too-old')
                ? 'format'
                : 'start-of-data';
            return;
        }

        restitch();
        if (dates.length <= before) {
            // The window did not get longer, so asking again with the same
            // anchor would fetch the same thing. Stop rather than loop.
            backfillExhausted = true;
        }

        // A range picked against the old numbering means different dates now:
        // the stitch prepends days, so every index shifted. Clamping keeps it
        // inside the file; the dates it names are the reader's to re-pick.
        range = range === null ? null : clampRange(range, dates.length);
        anchorDay = null;
        present = harnessesWithTests(loaded, folder);
        render();
        setStatusText(windowStatus());
        updateUrlHash();
    } catch (error) {
        console.warn('Backfill failed:', error);
    } finally {
        backfilling = false;
        renderBackfillControl();
    }
}

/**
 * The backfill button's label and its note.
 *
 * Says what it will do in days rather than in dates: a reader deciding whether
 * to spend the fetch cares that the chart gets 20 days longer, not which
 * pushdate names the run.
 */
function renderBackfillControl(busy?: string): void {
    const button = document.getElementById('backfill-button') as HTMLButtonElement | null;
    const note = document.getElementById('backfill-note');
    if (button === null || note === null) {
        return;
    }
    if (dates.length === 0) {
        button.style.display = 'none';
        note.textContent = '';
        return;
    }
    button.style.display = '';
    if (busy !== undefined) {
        button.disabled = true;
        button.textContent = busy;
    } else if (backfillExhausted) {
        button.disabled = true;
        button.textContent =
            backfillLimit === 'format' ? 'older data uses a format this page cannot read' : 'no older data';
    } else {
        button.disabled = false;
        button.textContent = '← load 20 more days';
    }
    // Only worth saying once there is more than one window in the chart.
    const spanned = dates.length > WINDOW_DAYS ? `${dates.length} days loaded` : '';
    const gaps =
        missingDates.length === 0
            ? ''
            : `${missingDates.length} day${missingDates.length === 1 ? '' : 's'} missing`;
    note.textContent = [spanned, gaps].filter((part) => part !== '').join(', ');
}

/** What the status text says about the loaded window. */
function windowStatus(): string {
    if (dates.length === 0) {
        return 'No data';
    }
    return `${dates.length} days (${dates[0]} to ${dates.at(-1)})`;
}

/**
 * Fetches the `-with-taskids` aggregates and swaps them in.
 *
 * `issues.html`'s loader and its four properties: historical mode only, at most
 * one fetch per harness, a failure is a `console.warn` rather than an error,
 * and nothing awaits it. Each file is decoded into a new `DecodedTimingFile`
 * and swapped in with one assignment, so a harness holds either the old file or
 * the new one and never a mixture — a partial merge would resolve task indices
 * against the wrong table and show silently wrong job names.
 *
 * The displayed numbers do not move across the swap: the two files describe the
 * same days with identical run totals, the second one merely says *which task*.
 */
async function loadDetailedData(): Promise<void> {
    if (loadingDetailed) {
        return;
    }
    const wanted = loaded.filter(({ harness }) => !detailedLoaded.has(harness));
    if (wanted.length === 0) {
        return;
    }
    loadingDetailed = true;
    const load = (async (): Promise<void> => {
        try {
            await Promise.all(
                wanted.map(async ({ harness }) => {
                    const response = await fetchData(`${harness}-issues-with-taskids.json`);
                    if (!response.ok) {
                        console.warn(`Detailed data not available for ${harness}`);
                        return;
                    }
                    const raw = (await response.json()) as IssuesWithTaskIdsFile;
                    const entry = loaded.find((candidate) => candidate.harness === harness);
                    if (entry === undefined) {
                        return;
                    }
                    rawByHarness.set(harness, raw);
                    entry.file = decodeIssuesWithTaskIds(raw);
                    detailedLoaded.add(harness);
                })
            );
        } catch (error) {
            console.warn('Error loading detailed data:', error);
        } finally {
            loadingDetailed = false;
        }
    })();
    detailedLoad = load;
    await load;
}

// --- URL state -----------------------------------------------------------

/**
 * Writes the view state to the hash, keeping the query string.
 *
 * **Not `initUrlHashManager`'s `updateHash`**, which this page cannot use for
 * writing: when the state is empty it calls
 * `replaceState(null, '', window.location.pathname)` (`common-ui.js:315`),
 * dropping the search string — and this page's `?path=` lives there. So
 * clearing the last range would have navigated the reader from
 * `tests.html?path=dom/base` to `tests.html`, i.e. to the path prompt,
 * with no way back but the back button.
 *
 * The *reading* half of that helper is still used: `getParams()` and the
 * `hashchange` listener are unaffected by this.
 */
function updateUrlHash(): void {
    const state = urlStateOf({
        search: searchBoxManager?.getValue() ?? '',
        range,
        days: dates.length,
        open: openTest,
        filters,
        windowDays: WINDOW_DAYS,
    });
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(state)) {
        // Falsy means "default", and a default is left out — the convention
        // `initUrlHashManager` established and that keeps a shared URL clean.
        if (value) {
            params.set(key, value);
        }
    }
    const hash = params.toString();
    window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}${hash === '' ? '' : `#${hash}`}`
    );
}

/**
 * Applies the hash to the page.
 *
 * The range is clamped to the loaded window rather than trusted: a hash
 * outlives the data it was written against, and `#from=40` on a 21-day file is
 * ordinary rather than exceptional. `clampRange` returning `null` means the
 * range missed the file entirely, and the whole window is a better answer than
 * an empty list that reads as a clean folder.
 */
function loadFromUrl(): void {
    if (hashManager === null) {
        return;
    }
    const search = new URLSearchParams(window.location.search);
    const state = readUrlState(hashManager.getParams(), search);
    folder = (state.folder ?? '').replace(/\/+$/, '');

    const box = document.getElementById('search-box');
    if (document.activeElement !== box) {
        // An absent `q` clears the box, so the back button restores the state
        // the URL describes rather than leaving a stale filter applied.
        searchBoxManager?.setValue(state.q ?? '');
    }

    openTest = state.open ?? null;
    pendingRange = parseRange(state);
    // The URL is the source of truth for the checkboxes, not the DOM: a
    // browser restores checkbox state across a reload, so a link carrying
    // `#issues=ftc` would otherwise be overridden by whatever the previous
    // visit left checked.
    filters = decodeFilters(state.issues);
    for (const [key, id] of FILTER_IDS) {
        const box = document.getElementById(id) as HTMLInputElement | null;
        if (box !== null) {
            box.checked = filters[key];
        }
    }
    pendingDays = parseBackfillDays(state);
    // `date` is read and ignored: the page has one window, so an old
    // `#date=2026-08-03` link lands on the 21 days rather than on an error.
}

/**
 * The history a shared link asks for, held until the first window is loaded.
 *
 * Like `pendingRange`, and for the same reason plus a stronger one: backfilling
 * needs a loaded window to count back from, and the range in the same hash is
 * expressed in *absolute day indices*, so it can only be applied once the
 * timeline is as long as the sender's was.
 */
let pendingDays: number | null = null;

/**
 * Backfills until the timeline covers the days a shared link asked for.
 *
 * Sequential rather than parallel: each step's pushdate is derived from the
 * oldest date currently held, so the fetches genuinely depend on one another.
 *
 * Stops on the first step that does not grow the window — the archive's far
 * end, or the older publishing format — rather than looping. `backfillExhausted`
 * is the same flag the button reads, so a link asking for more history than
 * exists lands on everything there is and says so.
 */
async function restoreBackfill(): Promise<void> {
    const wanted = pendingDays;
    pendingDays = null;
    const oldest = dates[0];
    if (wanted === null || oldest === undefined || wanted <= dates.length) {
        // Nothing to fetch. `loadWindow` skipped its render when a longer span
        // was pending, so draw it here rather than leaving a blank page — this
        // is the path a `#days=21` link or a too-short one takes.
        if (wanted !== null && dates.length > 0) {
            render();
            setStatusText(windowStatus());
        }
        return;
    }

    // Every pushdate at once, rather than a window at a time. The sequence is
    // arithmetic (see `backfillPushdates`), so nothing here depends on an
    // earlier fetch — and fetching one at a time made the page *show* each
    // intermediate span, so a `#days=61` link visibly settled through 21 then
    // 41 then 61. A reader following a shared link should see the span it
    // named, once.
    backfilling = true;
    renderBackfillControl('loading history…');
    try {
        const pushdates = backfillPushdates(oldest, dates.length, wanted);

        const fetched = await Promise.all(
            pushdates.flatMap((pushdate) =>
                loaded.map(async ({ harness }) => ({
                    harness,
                    window: await fetchBackfillWindow(harness, pushdate),
                }))
            )
        );

        let added = 0;
        let tooOld = false;
        for (const { harness, window } of fetched) {
            if (window === null) {
                continue;
            }
            if (window === 'too-old') {
                // Not `exhaustedHarnesses` here. These fetches are parallel, so
                // a `too-old` may be the *deepest* pushdate asked for while
                // nearer ones are fine — retiring the harness on it would also
                // retire the windows that did arrive. `restitch` establishes
                // the real span, and the limit below is read from that.
                tooOld = true;
                continue;
            }
            if (addWindow(harness, window)) {
                added++;
            }
        }
        if (added > 0) {
            restitch();
        }
        // Short of what the link asked for — possibly nothing at all arrived.
        // Everything older than this either is not published or predates the
        // decodable format, so the button has nothing left to offer either.
        // Not a `return`: the render below is the only one this load gets.
        if (dates.length < wanted) {
            backfillExhausted = true;
            backfillLimit = tooOld ? 'format' : 'start-of-data';
        }
    } catch (error) {
        // `loadWindow` skipped its render because a longer span was pending,
        // so swallowing this would leave the reader on a blank page. Draw what
        // did arrive — which is at least the published window — and say so.
        console.warn('Loading the shared history failed:', error);
        backfillExhausted = true;
    } finally {
        backfilling = false;
    }
    // One render, with the whole span in hand.
    range = range === null ? null : clampRange(range, dates.length);
    anchorDay = null;
    present = harnessesWithTests(loaded, folder);
    render();
    setStatusText(windowStatus());
    updateUrlHash();
}

/**
 * The range from the hash, held until a file is loaded.
 *
 * The hash is read before the data arrives, and a range cannot be clamped
 * against a window that is not there yet. So it is parked here and applied by
 * `applyPendingRange` once `dates` is known.
 */
let pendingRange: DayRange | null = null;

/** Applies a hash range to the loaded window. */
function applyPendingRange(): void {
    if (pendingRange === null) {
        return;
    }
    const clamped = loaded.length === 0 ? null : clampRange(pendingRange, dates.length);
    pendingRange = null;
    if (clamped === null) {
        return;
    }
    range = clamped;
    anchorDay = clamped.from;
    render();
}

// --- startup -------------------------------------------------------------

/**
 * Reads the four checkboxes into `filters`.
 *
 * Read from the DOM rather than tracked in JS: a browser restores checkbox
 * state across a reload, so a mirror initialized to `ALL_FILTERS` would
 * disagree with what the reader sees.
 */
function updateFiltersFromDom(): void {
    for (const [key, id] of FILTER_IDS) {
        // A cast rather than `instanceof HTMLInputElement`: the interface
        // constructors are properties of a *window*, and a page's module does
        // not necessarily have that window as its global — an `instanceof`
        // here threw `HTMLInputElement is not defined` under the node test
        // harness. `site/issues.ts` reads its four boxes the same way.
        const box = document.getElementById(id) as HTMLInputElement | null;
        if (box !== null) {
            filters[key] = box.checked;
        }
    }
}

/** A checkbox changed: re-read all four, repaint, and record it in the URL. */
function updateFilters(): void {
    updateFiltersFromDom();
    // The whole page, not just the rows: the filters move every number,
    // including the totals, the charts and the lines under the open test.
    render();
    updateUrlHash();
}

function initializeUI(): void {
    // The heading's path input completes on the folder list, wired once — it
    // is in the markup, so it is not rebuilt per render.
    // A cast, not `instanceof HTMLInputElement`: the interface constructors are
    // properties of a *window*, and a page's module does not necessarily have
    // that window as its global — an `instanceof` here throws
    // `HTMLInputElement is not defined` under the node test harness. Recorded
    // once already in `updateFiltersFromDom`; this is the second time.
    const pathInput = document.getElementById('folder-path-input') as HTMLInputElement | null;
    const pathDropdown = document.getElementById('folder-path-dropdown');
    if (pathInput !== null && pathDropdown !== null) {
        wireFolderComplete(pathInput, pathDropdown);
    }

    // **No `initHarnessSwitcher`.** It writes its own two-option dropdown and
    // a "<harness> <suffix>" string into the `<h1>`, which this page then
    // replaced on its first render — so the heading visibly flashed
    // "XPCShell Folder Burndown" with a dropdown beside it before settling.
    // It is also the wrong control here: this page merges both harnesses, so
    // there is nothing to switch.

    // Re-read from the DOM rather than assumed: a browser restores checkbox
    // state across a reload, so the JS mirror has to be taken from the boxes.
    updateFiltersFromDom();
    for (const [, id] of FILTER_IDS) {
        document.getElementById(id)?.addEventListener('change', updateFilters);
    }

    searchBoxManager = searchBox({
        searchBoxId: 'search-box',
        searchClearId: 'search-clear',
        onSearch: render,
        updateUrlHash,
    });

    // Wired once, like the day clicks: `render()` runs on every filter and
    // sort change, and a listener added per render would fire N times per
    // click and launch N overlapping fetches.
    document.getElementById('backfill-button')?.addEventListener('click', () => {
        void backfillOlderWindow();
    });

    hashManager = initUrlHashManager({
        // `getState` is required by the helper but never used for writing —
        // `updateUrlHash` does that, so the query string survives. Kept
        // truthful rather than stubbed, so the two cannot disagree.
        getState: () =>
            urlStateOf({
                search: searchBoxManager?.getValue() ?? '',
                range,
                days: dates.length,
                open: openTest,
                filters,
                windowDays: WINDOW_DAYS,
            }),
        onHashChange: async () => {
            searchBoxManager?.setNavigating(true);
            const previousFolder = folder;
            loadFromUrl();
            // Mostly nothing to reload: the hash's range, search and expanded
            // row are all computed from the file already in hand, and the
            // folder is in the search string so changing it is a navigation.
            if (folder !== previousFolder) {
                present = harnessesWithTests(loaded, folder);
            }
            // `#days=` is the exception — it asks for data the page does not
            // have. Only ever *more*: going back to a shorter span keeps the
            // days already fetched rather than throwing them away, since the
            // range in the same hash still refers to absolute indices in the
            // longer timeline.
            await restoreBackfill();
            render();
            applyPendingRange();
            searchBoxManager?.setNavigating(false);
        },
    });

}

/**
 * Starts the page.
 *
 * With no `?path=` there is nothing to show — a burndown of the whole
 * tree is `flaky.html`, which already ranks it — so the page asks for one,
 * exactly as `test.html` does with no `?test=`. That is the framing property:
 * this page is about one folder at a time, and with none named it says so
 * rather than guessing.
 */
export async function start(): Promise<void> {
    initializeUI();

    const search = new URLSearchParams(window.location.search);
    const requested = search.get('path');
    if (requested === null || requested === '') {
        showPathPrompt();
        return;
    }

    // **The path is shown before anything is fetched.** It is in the URL, so
    // there is nothing to wait for — and leaving the field on its placeholder
    // for the length of a 9 MB fetch asked the reader where they were while
    // the answer was in the address bar. `renderHeading` sets it again later;
    // this is the same assignment, only not deferred.
    folder = requested.replace(/\/+$/, '');
    renderHeading();

    // No `populateDateSelector`: there is no date to select. That helper
    // fetches `index.json` to fill a `<select>` this page does not have, and
    // with the single-day view gone it was one request for an element that no
    // longer exists — `dateSelect()` threw on it.
    loadFromUrl();

    // Both aggregates, always: a path is not a harness's unit, and merging
    // them into one ranked list is what this page does. `present` then says
    // which of the two actually had tests here, for the heading.
    await loadWindow();

    // Before the range: a shared `#from=`/`#to=` is in absolute day indices,
    // and backfilling prepends days, so applying the range first would put it
    // on entirely different dates than the sender saw.
    await restoreBackfill();

    applyPendingRange();
    updateUrlHash();
}

// --- the test seam -------------------------------------------------------

/**
 * What `test/tests-page.test.ts` reads instead of re-deriving it.
 *
 * `__detailedLoad` is the handle on the un-awaited detail fetch — without it a
 * test has to poll, which is how a flaky test gets written.
 */
declare global {
    interface Window {
        __testsView?: () => {
            folder: string;
            range: DayRange | null;
            dates: readonly string[];
            filters: IssueFilters;
            sort: SortState;
            openTest: string | null;
            list: Worklist | null;
            timeline: Timeline | null;
        };
        __testsDetailedLoad?: () => Promise<void> | null;
        __testsClickDay?: (day: number, shift?: boolean) => void;
    }
}

window.__testsView = () => ({
    folder,
    range,
    dates,
    filters,
    sort: currentSort,
    openTest,
    list: currentList,
    timeline: timelineSeries(),
});
window.__testsDetailedLoad = () => detailedLoad;
// The day selection, reachable without synthesising a Chart.js click — the
// chart's `onClick` is the only other way in and a test would have to fake its
// element array.
window.__testsClickDay = (day, shift = false) => {
    handleDayClick(day, { shiftKey: shift } as MouseEvent);
};

export type { SortField };
