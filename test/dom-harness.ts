/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * A jsdom page, for the tests of `site/drilldown-render.ts` and the two page
 * controllers.
 *
 * Those three files were 2,598 lines that **no test imported**, because
 * importing a controller used to start the page. `55c9ff1` made the entry point
 * an exported `start()`; this module is the other half — the environment a node
 * test needs in order to call it.
 *
 * ## Why the real shared scripts, and not stubs
 *
 * `common-links.js`, `common-ui.js`, `common-charts.js` and `shared.js` are
 * plain scripts of top-level function declarations that the page loads by
 * `<script src=…>`. They are `eval`'d into the jsdom window here and lifted onto
 * `globalThis` under the names `site/` declares them with.
 *
 * Stubbing them instead would have been easier and worse, for the reason this
 * project keeps hitting: a stub's return value is a value *the test author
 * chose*, so an assertion on a link href would be checking the stub. Running the
 * real `getCrashViewerUrl` means the expected href in a test has to be written
 * out independently, and a controller that picked the wrong link builder fails.
 *
 * Four globals are **not** the real thing and each is a deliberate exception:
 *
 * - `fetchData` — the real one reaches the network. Here it serves
 *   `test/fixtures/`, which is what makes the suite offline.
 * - `createRateChart` — the real one needs Chart.js and a canvas 2D context,
 *   neither of which jsdom has. It is recorded instead, which also makes "was a
 *   chart drawn, with what series" assertable.
 * - `window.Chart` — the same exception one level down, for
 *   `site/issues.ts`, whose two chart kinds are the old page's own and go to
 *   Chart.js directly rather than through `common-charts.js`. Recorded with the
 *   whole configuration, and its `getChart` really does return the last chart
 *   made on a canvas, so a page that stopped destroying a chart before drawing
 *   over it is visible here rather than only in a browser.
 * - `getDataDateRange` is real, but `common-links.js` reads `data.metadata`; it
 *   works unchanged on the fixtures.
 * - `initHarnessSwitcher` is real and needs an `<h1>`, which `PAGE_HTML` has.
 */

import { readFileSync } from 'node:fs';
// jsdom's types are declared by `test/jsdom.d.ts` rather than by
// `@types/jsdom`; that file records the comparison behind the choice.
import { JSDOM } from 'jsdom';

/**
 * This file declares no ambient globals, and that is the point.
 *
 * It used to declare `getBugButton`, because `site/failures.ts` called it
 * without declaring it: `tsconfig.site.json` compiles all of `site/**` as one
 * program, so the declaration in `site/test.ts` covered the call, while the
 * root project pulls in only the files a test imports and did not. The
 * declaration now lives in `site/failures.ts`'s own `declare global` block,
 * where the call is. Every `site/` module was checked for the same shape —
 * each compiled alone against the DOM lib with no other `site/` file in the
 * program — and `getBugButton` was the only one.
 *
 * What is still needed to import `site/` from a node test is the DOM half,
 * which the `/// <reference lib>` lines at the top of each test file supply.
 */

/** The scripts the two pages load, in the order their `<script>` tags do. */
const SHARED_SCRIPTS = [
    'shared.js',
    'fetch-utils.js',
    'common-ui.js',
    'common-charts.js',
    'common-links.js',
] as const;

/**
 * The names `site/drilldown-render.ts` declares in its `declare global` block,
 * plus the two the controllers use directly.
 *
 * Listed explicitly rather than copied wholesale off the window so that a
 * missing one is an error here rather than a `ReferenceError` inside a render.
 */
const GLOBAL_NAMES = [
    'getProfilerUrl',
    'getCrashViewerUrl',
    'getTreeherderJobUrl',
    'getSearchfoxUrl',
    'getBugzillaUrl',
    'getBugButton',
    'getDataDateRange',
    'getTestTotalRuns',
    'countDailyRunsForTests',
    'makeChartId',
    'initSearchBox',
    'populateDateSelector',
    'initHistoricalToggle',
    'initUrlHashManager',
    'initHarnessSwitcher',
    'getHarnessType',
    // `site/issues.ts` uses these two directly: `formatNumber` for every stat
    // cell and `linkifyFailureMessage` for a FAIL line's message. They are the
    // real `common-ui.js` implementations, so an assertion on a rendered
    // number or a linkified message compares against that file rather than
    // against a stub the test author chose.
    'formatNumber',
    'linkifyFailureMessage',
    // `shared.js`'s. `site/issues.ts` names a run's platform with it for the
    // hover tooltips, and using the real one means a test's expected platform
    // names come from that file's rules rather than from a list a test author
    // wrote down.
    'extractPlatform',
    // `fetch-utils.js`'s, reached through `site/test-link.ts`: every test row
    // on `issues.html` now links to `test.html`, and the URL carries the page's
    // `?data-source=` onto it. The real implementation, so an assertion on a
    // row's `href` compares against that file's rules.
    'withDevParams',
] as const;

/**
 * The controls both pages carry, by the ids the controllers look up.
 *
 * Trimmed from `site/crashes.html` and `site/failures.html` to the elements the
 * controllers and the shared scripts actually reach for: the `<h1>`
 * `initHarnessSwitcher` rewrites, the `<label>` `initHistoricalToggle` hides
 * through `previousElementSibling`, and the five ids.
 */
const PAGE_HTML = `<!DOCTYPE html><html><body>
<div class="header"><h1>XPCShell Crashes by Signature</h1></div>
<div class="controls">
  <label for="dateSelect">Select Date: </label>
  <select id="dateSelect"></select>
  <span class="status-text" id="statusText">Loading...</span>
  <button id="historicalButton" class="historical-button">Show Last 21 Days</button>
  <input type="text" id="searchBox" class="search-box">
  <button class="search-clear" id="searchClear">×</button>
</div>
<div id="content"><div class="no-data">Loading crash data...</div></div>
</body></html>`;

/**
 * `site/issues.html`'s controls, by the ids that page's controller looks up.
 *
 * A second constant rather than a parameterization of the first, because the
 * two pages genuinely disagree about every id — `date-select` against
 * `dateSelect`, `search-box` against `searchBox` — and a shared template with
 * eight substitutions would hide exactly the kind of mismatch this harness
 * exists to catch. This is **copied from `site/issues.html`'s own markup**
 * (`:608-655`), trimmed to the elements the controller and the shared scripts
 * reach for, so an id renamed on the page and not here fails as a null
 * dereference in `start()`.
 */
const ISSUES_PAGE_HTML = `<!DOCTYPE html><html><body>
<div class="container">
<h1>Test Issues</h1>
<div class="controls">
  <div class="date-selector">
    <label for="date-select">Select Date: </label>
    <select id="date-select"></select>
    <span id="status-text" class="status-text">Loading data...</span>
    <button id="historical-button" class="historical-button">Show Last 21 Days</button>
  </div>
  <div class="view-selector">
    <label>Show as</label>
    <label id="components-view-label">
      <input id="view-components" type="radio" name="view-mode" value="components" checked>
    </label>
    <label><input id="view-tree" type="radio" name="view-mode" value="tree"></label>
    <label><input id="view-list" type="radio" name="view-mode" value="list"></label>
  </div>
  <div class="search-container">
    <input type="text" class="search-box" id="search-box">
    <button class="search-clear" id="search-clear">×</button>
  </div>
</div>
<div class="explanation">
  <div class="issue-type-filters">
    <label class="filter-checkbox"><input type="checkbox" id="filter-failures" checked></label>
    <label class="filter-checkbox"><input type="checkbox" id="filter-timeouts" checked></label>
    <label class="filter-checkbox"><input type="checkbox" id="filter-crashes" checked></label>
    <label class="filter-checkbox"><input type="checkbox" id="filter-skips" checked></label>
  </div>
</div>
<div id="error" class="error" style="display: none;"></div>
<div id="tree-container" style="display: none;">
  <div class="tree-table" id="tree-table"></div>
</div>
<div id="no-data" class="no-data" style="display: none;">No data available.</div>
</div>
</body></html>`;

/**
 * `site/intermittent.html`'s controls, by the ids that page's controller looks
 * up.
 *
 * A third constant for the same reason there is a second: the ids are that
 * page's own, and a shared template with substitutions would hide the mismatch
 * this harness exists to catch. **Copied from `site/intermittent.html`'s own
 * markup** (`:188-236`), trimmed to the elements the controller reaches for, so
 * an id renamed on the page and not here fails as a null dereference in
 * `start()`.
 *
 * Several things it deliberately does **not** have. There is no `date-select`
 * and no `historical-button`: this page reads a live API, so it has no published
 * dates to fill a `<select>` from and no 21-day artifact to toggle onto — its
 * window is the `window-select` dropdown. There is no `volume-chart` canvas and
 * no `charts` container, because the top chart was removed — `VolumeSeries` in
 * `site/intermittent-view.ts` carries the measurement that decided it.
 *
 * And there is no `.subtitle`, no `volume-note` and no `ranking-title`, because
 * the page owner's review removed all three: the prose was "blah blah", the
 * volume figure moved into `status-text` beside the window dropdown, and the
 * section title had only one section to name. They are absent here rather than
 * kept as empty elements, so a page that started writing into them again would
 * fail as a null dereference — which is what this harness is for.
 *
 * The `<select>`s are left empty, because the controller fills the harness one
 * from `HARNESS_OPTIONS` and a pre-populated copy here would let a page that
 * stopped filling it pass.
 *
 * The harness `<select>` sits **inside the `<h1>`** with the shared
 * `.harness-switcher` class, as it does on the page: the controller writes the
 * title's suffix into `title-suffix`, so an `<h1>` shaped like the old one would
 * pass while the real page threw.
 */
const INTERMITTENT_PAGE_HTML = `<!DOCTYPE html><html><body>
<div class="container">
<h1><select id="harness-select" class="harness-switcher"></select> <span id="title-suffix"></span></h1>
<div class="controls">
  <div class="control-group">
    <label for="window-select">Window:</label>
    <select id="window-select">
      <option value="7days">Last 7 days</option>
      <option value="14days">Last 14 days</option>
      <option value="21days">Last 21 days</option>
      <option value="30days">Last 30 days</option>
    </select>
  </div>
  <span id="status-text" class="status-text">Loading annotations...</span>
</div>
<div id="error" class="error" style="display: none;"></div>
<div id="window-note" style="display: none;"></div>
<div id="coverage"></div>
<div id="ranking-table"></div>
</div>
</body></html>`;

/**
 * `site/tests.html`'s controls, by the ids that page's controller looks up.
 *
 * Copied from that page's markup and trimmed to what the controller and the
 * shared scripts reach for, as `ISSUES_PAGE_HTML` is — so an id renamed on the
 * page and not here fails as a null dereference in `start()` rather than
 * passing against a template this file invented.
 *
 * `#timeline-canvas` is here because the controller destroys and rebuilds a
 * chart on it, which is the seam `chartJs` records.
 */
const TESTS_PAGE_HTML = `<!DOCTYPE html><html><body>
<div class="container">
<h1 id="folder-heading">
  <span class="heading-label">Tests in:</span>
  <span class="heading-folder">
    <input type="text" id="folder-path-input" class="heading-folder-input">
    <div id="folder-path-dropdown" class="ac-dropdown"></div>
  </span>
  <span class="heading-harness" id="heading-harness"></span>
  <span class="heading-window" id="status-text"></span>
</h1>
<div class="controls">
  <div class="controls-filters">
    <div class="issue-type-filters">
      <label class="filter-checkbox"><input type="checkbox" id="filter-failures" checked> Failures</label>
      <label class="filter-checkbox"><input type="checkbox" id="filter-timeouts" checked> Timeouts</label>
      <label class="filter-checkbox"><input type="checkbox" id="filter-crashes" checked> Crashes</label>
      <label class="filter-checkbox"><input type="checkbox" id="filter-skips" checked> Skips</label>
    </div>
    <div class="search-container">
      <input type="text" class="search-box" id="search-box">
      <button class="search-clear" id="search-clear">&times;</button>
    </div>
  </div>
</div>
<div id="error" class="error" style="display: none;"></div>
<div id="folder-search" style="display: none;"></div>
<div class="chart-box" id="charts-box">
  <div class="chart-click-area">
    <div class="chart-stack" id="issue-chart-area" style="display: none;">
      <div class="chart-area"><canvas id="issue-chart-canvas"></canvas></div>
    </div>
    <div class="chart-stack" id="timeline-box">
      <div class="chart-area"><canvas id="timeline-canvas"></canvas></div>
    </div>
  </div>
  <p class="chart-note">Click a day to look at it alone.</p>
</div>
<div id="scope-line"></div>
<div id="worklist-container" style="display: none;"><div id="worklist-table"></div></div>
<div id="no-data" class="no-data" style="display: none;">No data available.</div>
</div>
</body></html>`;

/** Which page's markup a harness should be built with. */
export type PageKind = 'crashes' | 'issues' | 'intermittent' | 'tests';

const MARKUP: Record<PageKind, string> = {
    crashes: PAGE_HTML,
    issues: ISSUES_PAGE_HTML,
    intermittent: INTERMITTENT_PAGE_HTML,
    tests: TESTS_PAGE_HTML,
};

/** Where each page's rendered list goes. */
const CONTENT_ID: Record<PageKind, string> = {
    crashes: 'content',
    issues: 'tree-table',
    intermittent: 'ranking-table',
    tests: 'worklist-table',
};

/** One recorded `createRateChart` call. */
export interface ChartCall {
    canvasId: string;
    /** The daily series, as the controller computed it. */
    series: { day: number; date: string; events: number; totalRuns: number }[];
    label: string;
    eventLabel: string;
}

/**
 * One recorded `new Chart(canvas, config)`.
 *
 * `site/issues.ts` does not go through `common-charts.js` — its two chart kinds
 * are the old page's own `createFailureRateChart` and `createIssueMessageChart`
 * (`old/issues.html:2743`, `:2813`), which live nowhere but that page. So the seam
 * for those is Chart.js itself, which is genuinely a global from a CDN tag.
 *
 * **What is recorded is the whole configuration**, not a summary of it: the
 * assertion a test wants to make is "this canvas was handed these series with
 * these labels", and a summary chosen here would be a value this file picked
 * rather than one the page computed.
 */
export interface ChartJsCall {
    /** The canvas's `id`, which is how a test names the chart it expects. */
    canvasId: string;
    /** Whether the canvas was in the document when the chart was made. */
    attached: boolean;
    type: string;
    labels: string[];
    datasets: { label: string; data: number[] }[];
    options: Record<string, unknown>;
    /** The whole config, for an assertion the fields above do not cover. */
    config: Record<string, unknown>;
}

export interface Harness {
    window: JSDOM['window'];
    document: Document;
    /**
     * Where a render puts its list: `#content` on the crashes page,
     * `#tree-table` on the issues page, `#ranking-table` on the intermittents
     * page. `CONTENT_ID` is the mapping.
     */
    content: HTMLElement;
    /** Every `createRateChart` call since the harness was built, in order. */
    charts: ChartCall[];
    /** Every `new Chart(…)` since the harness was built, in order. */
    chartJs: ChartJsCall[];
    /** Plugins the page registered with `Chart.register`. */
    chartPlugins: unknown[];
    /** Files `fetchData` will serve, by the name the controller asks for. */
    files: Map<string, unknown>;
    /** Names `fetchData` was asked for, in order, including the 404s. */
    requested: string[];
    /**
     * `fetchData` will not resolve a name in this set until `release` is
     * called for it.
     *
     * The 21-day page starts its detailed fetch from a click handler and awaits
     * nobody, so "the merge has not landed yet" is a state that exists for
     * exactly one microtask — too short for a test to observe by luck, and a
     * test that happened to observe it by luck would be a flake. Holding the
     * response makes the state last as long as the test needs.
     */
    hold(filename: string): void;
    /** Lets a held name resolve. */
    release(filename: string): void;
    /** Restores the globals this harness replaced. */
    restore(): void;
}

const FIXTURES = new URL('./fixtures/', import.meta.url);
const ROOT = new URL('../', import.meta.url);

/** A fixture's parsed JSON, for a test that wants to tally it by hand. */
export function fixture<T>(name: string): T {
    return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;
}

/**
 * Installs a jsdom page on `globalThis` and returns the handles a test needs.
 *
 * `url` sets `?kind=` and the `#hash` the controller reads at startup, which is
 * the only way to drive `loadFromUrlHash` from outside — it is module-private.
 */
export function setupPage(
    options: { url?: string; files?: Record<string, unknown>; page?: PageKind } = {}
): Harness {
    const page = options.page ?? 'crashes';
    const dom = new JSDOM(MARKUP[page], {
        url: options.url ?? `https://tests.firefox.dev/${page}.html`,
        runScripts: 'outside-only',
    });

    for (const name of SHARED_SCRIPTS) {
        dom.window.eval(readFileSync(new URL(name, ROOT), 'utf8'));
    }

    const files = new Map<string, unknown>(Object.entries(options.files ?? {}));
    const requested: string[] = [];
    const charts: ChartCall[] = [];
    const chartJs: ChartJsCall[] = [];
    /** Names whose response is being held, to the resolver that releases it. */
    const held = new Map<string, () => void>();

    const scope = globalThis as unknown as Record<string, unknown>;
    const saved = new Map<string, unknown>();
    const set = (name: string, value: unknown): void => {
        if (!saved.has(name)) {
            saved.set(name, scope[name]);
        }
        scope[name] = value;
    };

    set('window', dom.window);
    set('document', dom.window.document);
    // Both controllers' delegated click handler is
    // `if (!(target instanceof Element) …)`, so `Element` has to be the *same*
    // constructor the nodes were made with — the browser has one global and
    // node has none. Without this the handler throws `ReferenceError` on every
    // click and no expansion is reachable from a test.
    for (const name of ['Element', 'Node', 'HTMLElement', 'Event'] as const) {
        set(name, (dom.window as unknown as Record<string, unknown>)[name]);
    }
    for (const name of GLOBAL_NAMES) {
        const value = (dom.window as unknown as Record<string, unknown>)[name];
        if (value === undefined) {
            throw new Error(`${name} is not defined by the shared scripts`);
        }
        set(name, value);
    }

    // Offline. A name with no entry 404s, exactly as the page's own fetch does
    // for a date with no file, so the error path is reachable from a test.
    set('fetchData', async (filename: string): Promise<Response> => {
        requested.push(filename);
        const gate = held.get(filename);
        if (gate !== undefined) {
            await new Promise<void>((resolve) => {
                held.set(filename, resolve);
            });
        }
        const body = files.get(filename);
        if (body === undefined) {
            return new Response('not found', { status: 404 });
        }
        return new Response(JSON.stringify(body), { status: 200 });
    });

    set(
        'createRateChart',
        (canvasId: string, series: ChartCall['series'], label: string, eventLabel: string) => {
            charts.push({ canvasId, series, label, eventLabel });
            return null;
        }
    );

    // Chart.js. jsdom's `<canvas>` has no 2D context, so the real library
    // cannot run here; this records what it was handed. `getChart` returns the
    // last chart made on a canvas, because `site/issues.ts` destroys a survivor
    // before drawing over it and a stub that always returned `undefined` would
    // let a page that never destroyed anything pass.
    const liveCharts = new Map<unknown, { destroy(): void; destroyed: boolean }>();
    /** Plugins the page registered, so a test can assert one was. */
    const registeredPlugins: unknown[] = [];
    class FakeChart {
        constructor(canvas: HTMLCanvasElement, config: Record<string, unknown>) {
            const data = config['data'] as
                | { labels: string[]; datasets: { label: string; data: number[] }[] }
                | undefined;
            chartJs.push({
                canvasId: canvas.id,
                attached: dom.window.document.contains(canvas),
                type: String(config['type']),
                labels: data?.labels ?? [],
                datasets: data?.datasets ?? [],
                options: (config['options'] as Record<string, unknown>) ?? {},
                config,
            });
            const instance = { destroy: (): void => void (instance.destroyed = true), destroyed: false };
            liveCharts.set(canvas, instance);
        }
        static getChart(canvas: HTMLCanvasElement): { destroy(): void } | undefined {
            const found = liveCharts.get(canvas);
            return found === undefined || found.destroyed ? undefined : found;
        }
        /**
         * Records a registered plugin rather than running it.
         *
         * `site/tests.ts` registers a `beforeDatasetsDraw` plugin to paint the
         * selected day range as a band behind the bars — the treatment
         * `test.html` uses. The plugin needs a 2D context, which jsdom has not,
         * but its *registration* has to succeed: without this the page threw
         * `Chart.register is not a function` and reported "Error loading data",
         * having already merged both harnesses correctly.
         */
        static register(plugin: unknown): void {
            registeredPlugins.push(plugin);
        }
    }
    (dom.window as unknown as Record<string, unknown>)['Chart'] = FakeChart;

    return {
        chartPlugins: registeredPlugins,
        window: dom.window,
        document: dom.window.document,
        content: dom.window.document.getElementById(CONTENT_ID[page])!,
        charts,
        chartJs,
        files,
        requested,
        hold(filename: string): void {
            held.set(filename, () => {});
        },
        release(filename: string): void {
            held.get(filename)?.();
            held.delete(filename);
        },
        restore(): void {
            for (const [name, value] of saved) {
                if (value === undefined) {
                    delete scope[name];
                } else {
                    scope[name] = value;
                }
            }
        },
    };
}

// --- reading the rendered tree -------------------------------------------

/** An element's tag and classes, as one comparable string: `div.a.b`. */
export function shape(element: Element): string {
    const classes = [...element.classList].sort();
    return element.tagName.toLowerCase() + classes.map((name) => `.${name}`).join('');
}

/** `shape` for a whole node list, in document order. */
export function shapes(elements: Iterable<Element>): string[] {
    return [...elements].map(shape);
}

/**
 * The path from `root` to `element` as `div.a > span.b`.
 *
 * Written so an assertion can name the *nesting* a page produces, which is the
 * thing `inlineLinksCell` differs on and which a class-only check would miss.
 */
export function pathTo(root: Element, element: Element): string {
    const parts: string[] = [];
    let node: Element | null = element;
    while (node !== null && node !== root) {
        parts.unshift(shape(node));
        node = node.parentElement;
    }
    return parts.join(' > ');
}
