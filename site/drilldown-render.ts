/**
 * The **shared renderer** for `crashes.html` and `failures.html`: turns
 * `site/drilldown-view.ts`'s decisions into elements.
 *
 * The companion to that module. `drilldown-view.ts` answers *what rows exist and
 * in what order*; this answers *what elements they are*, for the parts of the
 * two pages whose markup is the same.
 *
 * ## What "the same" means here, and how the differences are handled
 *
 * The two pages' markup is not identical — the stylesheet distinguishes them.
 * `common-data-view.css` styles `.single-crash` and `.single-failure`,
 * `.crash-job-name` and `.failure-job-name`, `.test-crash-count` and
 * `.test-failure-count`, `.stat-value.crash` and `.stat-value.fail` as separate
 * rules. The stylesheet is not being modified, so those names have to be emitted
 * exactly as they are today.
 *
 * They are therefore a **`Vocabulary`**: one record of the class names and
 * labels a page uses, passed in once. That is the alternative to the thing the
 * brief warned against — a shared helper taking three booleans — because a
 * vocabulary is data the page owns, not a switch inside a function that has to
 * know which page called it.
 *
 * There is **one** exception, and it is deliberate: `inlineLinksCell` tests
 * `vocab.kind` because the two pages emit genuinely different element trees
 * there — `td > span.view-links` against a bare `td.view-links` — which no
 * amount of vocabulary can express, since the difference is in the shape and
 * not in a name. It is documented at that function. One structural branch is
 * worth more than a hook nothing else would use; the claim to hold onto is that
 * it is the only one, not that there are none.
 *
 * The genuinely per-page work — what links an occurrence gets, whether a test
 * row carries a bug button, whether the row label is linkified — is a set of
 * **callbacks** on `RenderHooks`, for the same reason: this module would
 * otherwise have to know about minidumps and Bugzilla components, which are not
 * shared concepts.
 *
 * ## Elements, not strings
 *
 * Both old pages build HTML by concatenation and assign `innerHTML`, which is
 * what forces their `escapeHtml`/`escapeAttr` calls — 40-odd of them across the
 * two files — and their `onclick="…"` attributes, which need global functions.
 * Building nodes answers the escaping question once, at `el()`, and lets a
 * listener be attached to the element it belongs to.
 *
 * It also removes a real defect rather than a theoretical one, and this one was
 * measured in Chrome on the old page rather than argued from the source.
 *
 * Both pages write their row key into an attribute with `escapeAttr`
 * (`common-ui.js:14`) and then *find the row again by selector* built with the
 * same function — `document.querySelector('[data-message="' + escapeAttr(msg) +
 * '"]')` (`old/failures.html:683`, `old/crashes.html:597`). That round-trip is what
 * re-attaches an expanded row's subtree after a re-render. It does not survive a
 * quote: `escapeAttr` turns `"` into `&quot;`, the HTML parser decodes that back
 * to `"` in the attribute *value*, and the CSS selector — which does no entity
 * decoding — then looks for a value containing the literal text `&quot;`.
 *
 * **Measured on the pinned 21-day xpcshell snapshot, in Chrome:**
 *
 * ```
 * failures.html   1848 of 2841 rows cannot find themselves   (65%)
 * crashes.html       0 of   90 rows                          (0%)
 * ```
 *
 * The crashes page is unaffected because a crash signature is a symbol name and
 * contains no quotes; the failures page is affected on two rows in three,
 * because a failure message quotes the values it compared.
 *
 * And it is live, not latent. Expanding the row
 * `Unexpected exception TypeError: can't access property "resumed", …` gives it
 * 2 sub-rows; clicking a column header to re-sort leaves the same row with the
 * `expanded` class, `expandedMessage` still set to it, and **0 sub-rows** — a
 * highlighted row with nothing underneath, which then needs two clicks to
 * expand. A control row with no quotes behaves correctly under the same steps.
 *
 * Here the elements are held in a `Map` keyed by the raw string and there is no
 * attribute round-trip, so the class of bug is gone rather than reproduced. It
 * is on both pages' declared-divergence lists.
 */

import type {
    GroupRow,
    Occurrence,
    SortColumn,
    SortState,
    SubRow,
    TestNode,
    Totals,
} from './drilldown-view.ts';
import { occurrenceRows } from './drilldown-view.ts';

// --- the shared scripts, as they are --------------------------------------
//
// Declared rather than imported: these are `<script src=…>` globals from files
// up to 22 unmigrated pages depend on, which the build copies next to the page.

declare global {
    /** `common-links.js:15` — the Firefox Profiler URL for a run. */
    function getProfilerUrl(
        instance: { taskId?: string; retryId?: string | number; jobName?: string },
        testName?: string | null
    ): string;
    /** `common-links.js:31` — the crash viewer URL, or `''` with no minidump. */
    function getCrashViewerUrl(crashInstance: {
        taskId: string;
        retryId: string | number;
        minidump?: string | null | undefined;
    }): string;
    /** `common-links.js:43` — the Treeherder URL, or `null`. */
    function getTreeherderJobUrl(
        instance: { taskId: string; retryId: string | number },
        currentData: unknown
    ): string | null;
    /** `common-links.js:104` — the Searchfox URL for a test path. */
    function getSearchfoxUrl(testPath: string, message?: string | null): string;
    /** `common-links.js:126` — the Bugzilla filing URL. */
    function getBugzillaUrl(options: {
        testPath: string;
        summary: string;
        component: string;
        stats?: {
            failureCount?: number;
            totalRuns?: number;
            firstDate?: string | null;
            lastDate?: string | null;
        };
    }): string;
    /** `common-links.js:186` — the file's first and last dates. */
    function getDataDateRange(data: unknown): {
        firstDate: string | null;
        lastDate: string | null;
    };
    /** `common-charts.js:98` — a test's non-SKIP runs in the 21-day file. */
    function getTestTotalRuns(
        historicalData: unknown,
        dirPath: string,
        testName: string
    ): number;
    /** `common-charts.js:149` — daily event/run counts for a set of tests. */
    function countDailyRunsForTests(
        historicalData: unknown,
        testIds: Set<string>,
        targetValueId: number,
        valueField: string,
        statusName: string,
        days: number,
        startTime: number
    ): { day: number; date: string; events: number; totalRuns: number }[];
    /** `common-charts.js:333` — the Chart.js bar chart. */
    function createRateChart(
        canvasId: string,
        dailyData: unknown[],
        label: string,
        eventLabel?: string
    ): unknown;
    /** `common-charts.js:377` — a DOM-safe id built from strings. */
    function makeChartId(prefix: string, ...parts: string[]): string;
    /**
     * `common-ui.js:44` — wires a search box, its clear button and a debounce.
     *
     * Declared as returning `unknown` because `site/try.ts` already declares
     * this global with that return type, and `declare global` blocks *merge*
     * across the project rather than shadowing each other — two declarations of
     * the same function with different signatures is an error. `searchBox()`
     * below narrows it in one place so the call sites do not each cast.
     */
    function initSearchBox(options: {
        searchBoxId: string;
        searchClearId: string;
        onSearch: () => void;
        updateUrlHash: () => void;
        debounceMs?: number;
    }): unknown;
    /** `common-ui.js:110` — fills the date `<select>` from `index.json`. */
    function populateDateSelector(options: {
        selectId: string;
        statusTextId: string;
        fetchData: (filename: string) => Promise<Response>;
    }): Promise<boolean>;
    /** `common-ui.js:194` — the 21-days/single-day toggle button. */
    function initHistoricalToggle(options: {
        buttonId: string;
        selectId: string;
        statusTextId: string;
        fetchData: (filename: string) => Promise<Response>;
        onToggle: (isHistorical: boolean, data: unknown) => Promise<void>;
        updateUrlHash: () => void;
        historicalDataFile?: string;
    }): { toggle: () => Promise<void> };
    /** `common-ui.js:298` — reads and writes the `#date=…&q=…` hash. */
    function initUrlHashManager(options: {
        getState: () => Record<string, string>;
        onHashChange?: (state: Record<string, string>) => Promise<void>;
    }): {
        updateHash: () => void;
        loadFromHash: () => Record<string, string>;
        getParams: () => URLSearchParams;
    };
    /** `common-ui.js:508` — replaces the `<h1>` with a harness dropdown. */
    function initHarnessSwitcher(suffix: string): void;
    /** `fetch-utils.js:5` — the `?kind=` harness, defaulting to `xpcshell`. */
    function getHarnessType(): string;
    /**
     * `fetch-utils.js` — fetches a data file, honouring `?data-source=`.
     *
     * `date` is an optional `YYYY-MM-DD` pushdate naming an *older* published
     * run to read instead of the latest one. Omit it for the current data.
     */
    function fetchData(filename: string, date?: string): Promise<Response>;
}

/** What `initSearchBox` returns. `common-ui.js:89`. */
export interface SearchBoxManager {
    getValue: () => string;
    setValue: (value: string) => void;
    setNavigating: (value: boolean) => void;
    updateClearButton: () => void;
}

/** `initSearchBox` with its real return type. See the `declare global` above. */
export function searchBox(options: {
    searchBoxId: string;
    searchClearId: string;
    onSearch: () => void;
    updateUrlHash: () => void;
}): SearchBoxManager {
    const manager = initSearchBox(options) as SearchBoxManager;
    bindFilterShortcut(options.searchBoxId);
    return manager;
}

/**
 * `f` focuses the page's filter box; Escape leaves it.
 *
 * Exported as well as used by `searchBox()`, for `manifests.html`: it has
 * **two** filter inputs in markup of its own and never goes through that
 * wrapper, so it binds this directly on the one a bare `f` should reach.
 *
 * Wired here rather than per page because every page with a filter box already
 * goes through `searchBox()` — `crashes`, `failures`, `errors`, `flaky`,
 * `issues`, `tests` and `try` — so this is the one place that reaches all of
 * them, and a seventh copy of a `keydown` listener is how they come to disagree
 * about the key.
 *
 * ## What it must not do
 *
 * **Not fire while the reader is typing.** An `f` in a search box, a folder
 * path or any other field is an `f`, so the handler ignores the event when the
 * target is an input, a textarea, a select or anything `contenteditable`. This
 * page family has two text inputs on one page (`tests.html`'s filter and its
 * editable folder path), so "already focused somewhere" is the common case and
 * not an edge one.
 *
 * **Not swallow a modified key.** `Ctrl+F`, `Cmd+F` and `Alt+F` belong to the
 * browser — find-in-page is a different and legitimate thing to want — so only
 * a bare `f` is taken.
 *
 * Escape blurs and is deliberately *not* a clear: the value is in the URL on
 * most of these pages, so clearing on Escape would throw away state a reader
 * may have arrived with.
 */
export function bindFilterShortcut(searchBoxId: string): void {
    document.addEventListener('keydown', (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        const typing =
            tag === 'INPUT' ||
            tag === 'TEXTAREA' ||
            tag === 'SELECT' ||
            target?.isContentEditable === true;

        if (event.key === 'Escape' && typing && target?.id === searchBoxId) {
            (target as HTMLInputElement).blur();
            return;
        }
        if (event.key !== 'f' || typing) {
            return;
        }
        const box = document.getElementById(searchBoxId);
        if (box === null) {
            return;
        }
        // Not a hidden box. `try.html` keeps its filter hidden until a
        // revision is loaded, and focusing something invisible loses the
        // reader's keystrokes with nothing to show why.
        //
        // Walked by `display` rather than read off `offsetParent`, which is
        // the usual trick and is wrong here: jsdom does no layout, so
        // `offsetParent` is *always* null there and the shortcut would be dead
        // in every test while working in a browser — the kind of difference
        // that makes a test suite say the opposite of the truth.
        for (let node: HTMLElement | null = box; node !== null; node = node.parentElement) {
            if (node.style.display === 'none') {
                return;
            }
        }
        // Prevented so the `f` does not also land in the box it just focused.
        event.preventDefault();
        (box as HTMLInputElement).focus();
        (box as HTMLInputElement).select();
    });
}

// --- small DOM helpers ----------------------------------------------------

/**
 * Applies the newline normalization the HTML parser would have applied.
 *
 * Not a nicety — the parsed-DOM diff found this and it took a browser probe to
 * explain. The old pages write `title="${escapeAttr(message)}"` into a string
 * and hand it to `insertAdjacentHTML`, so the **parser** builds the attribute,
 * and the HTML spec has it normalize a literal CR (and CRLF) in an attribute
 * value to a single LF. Assigning `element.title` bypasses the parser and keeps
 * the CR.
 *
 * **Measured in Chrome**, the three cases side by side:
 *
 * ```
 * innerHTML with a literal CRLF      -> "a\n b"      (normalized)
 * innerHTML with &#13;&#10;          -> "a\r\n b"    (entities are not)
 * element.title = "a\r\nb"           -> "a\r\n b"    (not normalized)
 * ```
 *
 * So the property assignment matches the *entity* form and not the form the old
 * pages actually emit. Without this the two pages disagree on the `title` of any
 * row whose message contains a CR.
 *
 * **How often that is:** 1 of 2,263 mochitest messages, 0 of 2,888 xpcshell
 * ones — the single row
 * `Shouldn't have coalesced the initial touchmove - Structures begin differing
 * at: …`. One row, on one harness, in a tooltip. It is fixed rather than
 * declared because the fix is three characters and a declared divergence is a
 * thing a reviewer has to carry forever.
 *
 * ## The three pages that adopted this helper later
 *
 * `try.ts`, `test.ts` and `crash-viewer.ts` each carried a private copy of
 * `el()` that skipped this call. Replacing them with this one is a no-op on
 * their rendered output, measured rather than assumed:
 *
 * - **test**: the CR-bearing message above is in today's
 *   `mochitest-issues.json` (`tables.messages[1290]`, 1 of 23,859 strings) and
 *   the page *does* render it — for
 *   `dom/events/test/test_coalesce_touchmove.html` it is the text of an
 *   `.issue-message`. But it reaches `textContent`, never a `title`: loaded in
 *   Chrome, that page has 54 titled elements, 0 with a CR, and no CR anywhere
 *   in the serialized DOM. The test page's titles are counts and skip
 *   conditions, not failure messages.
 * - **try**: its message titles come from Treeherder `bug_suggestions` at
 *   runtime, not from a published file. Sampled 250 failing jobs across
 *   autoland and mozilla-central: 0 of 1,982 `search` strings contain a CR.
 * - **crash-viewer**: titles are thread headings and `tid:` labels, built by
 *   this repo from numbers. 202 titled elements on `win32-mfcdm`, 0 with a CR.
 *
 * So this is a widening of the fix's reach, not a behaviour change to those
 * three. If a CR ever does reach one of their titles, they now match the old
 * pages instead of diverging from them.
 */
function normalizeAttrNewlines(value: string): string {
    return value.replace(/\r\n?/g, '\n');
}

/** `document.createElement` with class, text and attributes in one call. */
export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options: {
        class?: string | undefined;
        text?: string | undefined;
        title?: string | undefined;
        id?: string | undefined;
        href?: string | undefined;
        attrs?: Record<string, string> | undefined;
        children?: (Node | string | null)[] | undefined;
    } = {}
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (options.class !== undefined && options.class !== '') {
        node.className = options.class;
    }
    if (options.text !== undefined) {
        // `textContent`, never `innerHTML`: a failure message legitimately
        // contains `<` and `&`, and this answers the escaping question once
        // rather than at each of the old pages' `escapeHtml` calls.
        node.textContent = options.text;
    }
    if (options.title !== undefined) {
        node.title = normalizeAttrNewlines(options.title);
    }
    if (options.id !== undefined) {
        node.id = options.id;
    }
    if (options.href !== undefined) {
        node.setAttribute('href', options.href);
    }
    for (const [name, value] of Object.entries(options.attrs ?? {})) {
        node.setAttribute(name, value);
    }
    for (const child of options.children ?? []) {
        if (child === null) {
            continue;
        }
        node.append(child);
    }
    return node;
}

/** An external link that does not bubble its click to the row underneath. */
export function externalLink(href: string, text: string, className?: string): HTMLAnchorElement {
    const anchor = el('a', { href, text, ...(className === undefined ? {} : { class: className }) });
    anchor.target = '_blank';
    // The old pages write `onclick="event.stopPropagation();"` as an attribute
    // for exactly this. Attaching it is the same behaviour without the global.
    anchor.addEventListener('click', (event) => event.stopPropagation());
    return anchor;
}

// --- the page's vocabulary ------------------------------------------------

/**
 * The class names and labels one page uses.
 *
 * Every field is a string the stylesheet or the reader sees, and none of them
 * can be derived from the other page's — `common-data-view.css` has separate
 * rules for each pair. Passing them as one record is what keeps the *naming*
 * out of the renderer's control flow; `kind` is read once, by
 * `inlineLinksCell`, where the two pages differ in element shape rather than in
 * a name. See the note at the top of this file.
 */
export interface Vocabulary {
    /** `crash` or `failure`. The prefix of the row and stats classes. */
    kind: 'crash' | 'failure';
    /** `crash-row` / `failure-row`. */
    rowClass: string;
    /** `crash-signature` / `failure-message` — the label cell, and the list header. */
    labelClass: string;
    /** `crash-stats` / `failure-stats`. */
    statsClass: string;
    /** `crash-list` / `failure-list`. */
    listClass: string;
    /** The `stat-value` modifier for the count column: `crash` or `fail`. */
    countClass: string;
    /** `single-crash` / `single-failure`. */
    singleClass: string;
    /** `crash-job-name` / `failure-job-name`. */
    jobNameClass: string;
    /** `test-crash-count` / `test-failure-count`. */
    testCountClass: string;
    /** The header of the label column: `Crash Signature` / `Failure Message`. */
    labelHeader: string;
    /** The header of the count column: `Crashes` / `Failures`. */
    countHeader: string;
    /** What the empty state says. */
    emptyText: string;
}

/** The per-page decisions this renderer cannot make for itself. */
export interface RenderHooks {
    /**
     * The contents of a row's label cell.
     *
     * A crash signature is plain text; a failure message may be part anchor.
     * Returning nodes rather than a string is what keeps the linkified case from
     * going through `innerHTML`.
     */
    labelNodes(key: string): (Node | string)[];
    /** The `title` on the label cell, or `undefined` for none. */
    labelTitle(key: string): string | undefined;
    /** The links shown for one occurrence, already built. */
    occurrenceLinks(occurrence: Occurrence, testName: string): HTMLElement[];
    /** The main link a job name points at. */
    jobNameHref(occurrence: Occurrence, testName: string): string;
    /**
     * Anything appended after a test row's name — the 🐛 button on failures,
     * nothing on crashes.
     */
    testNameSuffix(dirPath: string, test: TestNode, key: string): Node | null;
    /** What a single-occurrence row does when clicked, or `null` for inert. */
    singleRowHref(occurrence: Occurrence, testName: string): string | null;
    /** A test's non-SKIP runs, for the tooltip. 0 outside historical mode. */
    totalRunsOf(dirPath: string, testName: string): number;
    /** The tooltip on a test row's count cell. */
    tooltipOf(count: number, totalRuns: number): string;
}

// --- the list -------------------------------------------------------------

/** What `renderList` produces, so the caller can find its rows again. */
export interface RenderedList {
    root: HTMLElement;
    /** key → its row element, for expansion without an attribute round-trip. */
    rowsByKey: Map<string, HTMLElement>;
}

/**
 * Renders the whole ranked list: header, total row, one row per group.
 *
 * `renderCrashList` (`old/crashes.html:551-592`) and `renderFailureList`
 * (`old/failures.html:624-678`), which are the same markup with different names in
 * it.
 */
export function renderList(
    rows: readonly GroupRow[],
    totals: Totals,
    sort: SortState,
    vocab: Vocabulary,
    hooks: RenderHooks,
    onSort: (column: SortColumn) => void,
    expandedKey: string | null
): RenderedList {
    const root = el('div', { class: vocab.listClass });
    const rowsByKey = new Map<string, HTMLElement>();

    root.append(renderHeader(sort, vocab, onSort));
    root.append(renderTotalRow(totals, vocab));

    for (const row of rows) {
        const element = el('div', {
            class: `${vocab.rowClass}${row.key === expandedKey ? ' expanded' : ''}`,
        });
        element.append(
            el('div', {
                class: vocab.labelClass,
                ...(hooks.labelTitle(row.key) === undefined
                    ? {}
                    : { title: hooks.labelTitle(row.key) }),
                children: hooks.labelNodes(row.key),
            })
        );
        element.append(
            el('div', {
                class: vocab.statsClass,
                children: [
                    statItem(String(row.testCount)),
                    statItem(String(row.count), vocab.countClass),
                ],
            })
        );
        root.append(element);
        rowsByKey.set(row.key, element);
    }

    return { root, rowsByKey };
}

/** The sortable column header. `old/crashes.html:554-569`. */
function renderHeader(
    sort: SortState,
    vocab: Vocabulary,
    onSort: (column: SortColumn) => void
): HTMLElement {
    const header = el('div', { class: 'sort-header' });
    header.append(el('div', { class: vocab.labelClass, text: vocab.labelHeader }));
    header.append(
        el('div', {
            class: vocab.statsClass,
            children: [
                sortItem('tests', 'Tests', sort, onSort),
                sortItem('count', vocab.countHeader, sort, onSort),
            ],
        })
    );
    return header;
}

/**
 * One sortable column button.
 *
 * The arrow is a `<span class="sort-arrow">` that is **present but empty** on
 * the inactive column, which is upstream's markup (`old/crashes.html:559`) and is
 * what keeps the two columns the same width.
 *
 * Upstream's button text is the label preceded by whitespace and a newline, from
 * the template literal's indentation. Here the arrow and the label are two
 * children with a space between them; the rendered text differs only in
 * collapsible whitespace, which HTML collapses to the same single space.
 */
function sortItem(
    column: SortColumn,
    label: string,
    sort: SortState,
    onSort: (column: SortColumn) => void
): HTMLElement {
    const active = sort.column === column;
    const button = el('button', {
        class: `sort-button${active ? ' active' : ''}`,
        children: [
            el('span', { class: 'sort-arrow', text: active ? (sort.ascending ? '▲' : '▼') : '' }),
            ' ',
            label,
        ],
    });
    button.addEventListener('click', () => onSort(column));
    return el('div', { class: 'stat-item', children: [button] });
}

/** The `📊 Total` row. `old/crashes.html:572-577`. */
function renderTotalRow(totals: Totals, vocab: Vocabulary): HTMLElement {
    return el('div', {
        class: `${vocab.rowClass} total-row`,
        children: [
            el('div', { class: vocab.labelClass, text: '📊 Total' }),
            el('div', {
                class: vocab.statsClass,
                children: [
                    statItem(String(totals.tests)),
                    statItem(String(totals.count), vocab.countClass),
                ],
            }),
        ],
    });
}

/** One right-aligned number. */
function statItem(text: string, modifier?: string): HTMLElement {
    return el('div', {
        class: 'stat-item',
        children: [
            el('span', { class: modifier === undefined ? 'stat-value' : `stat-value ${modifier}`, text }),
        ],
    });
}

// --- the expanded subtree -------------------------------------------------

/**
 * Renders the rows under an expanded group or path.
 *
 * The three `SubRow` kinds map to the three shapes both old pages emit: a
 * `path-row` with two counts, a `test-row` with an expandable count, and a
 * `test-row single-*` carrying its one occurrence in an inline table.
 */
export function renderSubRows(
    subRows: readonly SubRow[],
    key: string,
    vocab: Vocabulary,
    hooks: RenderHooks
): HTMLElement[] {
    return subRows.map((subRow) => {
        switch (subRow.kind) {
            case 'path':
                return renderPathRow(subRow, vocab);
            case 'test':
                return renderTestRow(subRow.dirPath, subRow.test, subRow.direct, key, vocab, hooks);
            case 'single':
                return renderSingleRow(
                    subRow.dirPath,
                    subRow.test,
                    subRow.occurrence,
                    subRow.direct,
                    key,
                    vocab,
                    hooks
                );
        }
    });
}

/**
 * A directory row. `old/crashes.html:730-735`.
 *
 * `'(root)'` is what an empty path displays as — a test file directly at the
 * repository root — and is upstream's (`old/crashes.html:731`).
 */
function renderPathRow(
    subRow: Extract<SubRow, { kind: 'path' }>,
    vocab: Vocabulary
): HTMLElement {
    const row = el('div', { class: 'path-row' });
    // Carried so the click handler can find the path again, and so a reader
    // inspecting the DOM can see which row is which. Unlike upstream these are
    // not used as a *selector*, so they need no escaping round-trip.
    row.dataset['path'] = subRow.dirPath;
    row.append(el('div', { class: vocab.labelClass, text: subRow.dirPath || '(root)' }));
    row.append(
        el('div', {
            class: vocab.statsClass,
            children: [
                statItem(String(subRow.testCount)),
                statItem(String(subRow.count), vocab.countClass),
            ],
        })
    );
    return row;
}

/** An expandable test row. `old/crashes.html:723-726` / `:780-783`. */
function renderTestRow(
    dirPath: string,
    test: TestNode,
    direct: boolean,
    key: string,
    vocab: Vocabulary,
    hooks: RenderHooks
): HTMLElement {
    const row = el('div', { class: `test-row${direct ? ' direct-child' : ''}` });
    row.dataset['path'] = dirPath;
    row.dataset['test'] = test.testName;

    // A direct child shows its full path because the directory row that would
    // have carried it was collapsed away; a row under a path row shows only the
    // file name. `old/crashes.html:724` against `:781`.
    const label = direct ? `${dirPath}/${test.testName}` : test.testName;
    const suffix = hooks.testNameSuffix(dirPath, test, key);
    row.append(el('div', { class: 'test-name', children: [label, suffix] }));

    const totalRuns = hooks.totalRunsOf(dirPath, test.testName);
    const tooltip = hooks.tooltipOf(test.totalCount, totalRuns);
    row.append(
        el('div', {
            class: vocab.statsClass,
            children: [
                el('div', { class: 'stat-item' }),
                el('div', {
                    class: vocab.testCountClass,
                    title: tooltip,
                    text: String(test.totalCount),
                }),
            ],
        })
    );
    return row;
}

/**
 * A test row whose single occurrence is shown inline.
 *
 * `old/crashes.html:707-715` / `old/failures.html:799-811`. The two differ in what the
 * row does when clicked and in which links it carries, both of which are hooks.
 */
function renderSingleRow(
    dirPath: string,
    test: TestNode,
    occurrence: Occurrence,
    direct: boolean,
    key: string,
    vocab: Vocabulary,
    hooks: RenderHooks
): HTMLElement {
    const row = el('div', {
        class: `test-row ${vocab.singleClass}${direct ? ' direct-child' : ''}`,
    });

    const label = direct ? `${dirPath}/${test.testName}` : test.testName;
    const suffix = hooks.testNameSuffix(dirPath, test, key);
    row.append(el('div', { class: 'test-name', children: [label, suffix] }));

    const href = hooks.singleRowHref(occurrence, test.testName);
    if (href !== null) {
        // Upstream expresses this two different ways — a `data-crash-url` the
        // delegated handler reads (`old/crashes.html:707`) and an inline
        // `onclick="window.open(…)"` (`old/failures.html:799`) — for the same
        // behaviour. One listener does both, and the inert case (a crash with no
        // dump) is `null` rather than an empty attribute.
        row.addEventListener('click', () => window.open(href, '_blank'));
    }

    const jobCell = el('td', { class: vocab.jobNameClass });
    jobCell.append(
        externalLink(hooks.jobNameHref(occurrence, test.testName), occurrence.jobName)
    );

    const links = hooks.occurrenceLinks(occurrence, test.testName);
    const tr = el('tr', {
        children: [
            el('td', { class: 'run-date', text: occurrence.date || '' }),
            jobCell,
            inlineLinksCell(links, vocab),
        ],
    });
    row.append(table('inline-instance', [tr]));
    return row;
}

/**
 * The links cell of a single-occurrence row, which the two pages nest
 * differently.
 *
 * Upstream builds this cell from two different helpers and they do not produce
 * the same tree:
 *
 * - **crashes** calls `renderCrashLinks` (`common-links.js:76`), which returns
 *   `<span class="view-links">View: …</span>`, and drops it into a **bare**
 *   `<td>` (`old/crashes.html:713`). So the class is on a `span` inside the cell.
 * - **failures** builds the links inline and puts them in a
 *   `<td class="view-links">` (`old/failures.html:809`), with no `span`.
 *
 * `common-data-view.css` styles `.inline-instance .view-links` either way, so
 * the two render alike — but the trees differ by one element, which a parsed-DOM
 * diff sees. Reproduced rather than unified, because unifying would mean
 * changing one page's markup for no reader-visible gain.
 */
function inlineLinksCell(links: readonly HTMLElement[], vocab: Vocabulary): HTMLElement {
    if (vocab.kind === 'crash') {
        const span = el('span', { class: 'view-links' });
        span.append('View: ');
        appendSpaced(span, links);
        return el('td', { children: [span] });
    }
    const cell = el('td', { class: 'view-links' });
    cell.append('View: ');
    appendSpaced(cell, links);
    return cell;
}

/**
 * The occurrence table under an expanded test.
 *
 * `generateTestExpandedContent` (`old/crashes.html:804-823`,
 * `old/failures.html:908-922`). Identical structure; the links differ.
 */
export function renderOccurrenceTable(
    test: TestNode,
    vocab: Vocabulary,
    hooks: RenderHooks
): HTMLElement {
    const rows: HTMLElement[] = [];
    for (const { occurrence, showDate } of occurrenceRows(test)) {
        const jobCell = el('td', { class: vocab.jobNameClass });
        // Deliberately *not* an `externalLink`: upstream's job-name anchor in
        // this table has no `onclick="event.stopPropagation()"`
        // (`old/crashes.html:819` against `:712`), and on the crashes page the row
        // itself is clickable, so the difference is observable — clicking the
        // job name there both follows the link and opens the crash viewer. It is
        // reproduced rather than tidied.
        const anchor = el('a', {
            href: hooks.jobNameHref(occurrence, test.testName),
            text: occurrence.jobName,
        });
        anchor.target = '_blank';
        jobCell.append(anchor);

        // Always a `<td class="view-links">` here, on both pages
        // (`old/crashes.html:820`, `old/failures.html:919`) — unlike the inline
        // single-occurrence cell, which they build differently. See
        // `inlineLinksCell`.
        const linksCell = el('td', { class: 'view-links' });
        linksCell.append('View: ');
        appendSpaced(linksCell, hooks.occurrenceLinks(occurrence, test.testName));

        rows.push(
            el('tr', {
                class: `${vocab.kind}-instance-row`,
                children: [
                    el('td', { class: 'run-date', text: showDate ? occurrence.date : '' }),
                    jobCell,
                    linksCell,
                ],
            })
        );
    }
    return table('instance-table', rows);
}

/**
 * A `<table>` with the `<tbody>` the HTML parser would have inserted.
 *
 * Not cosmetic, and it was caught by the parsed-DOM diff rather than by
 * reading. The old pages build their tables as strings and assign them through
 * `insertAdjacentHTML`, so the parser applies its own tree construction and
 * **synthesizes a `<tbody>`** around the rows. `document.createElement('table')`
 * followed by `append(tr)` does not: the `<tr>` becomes a direct child of the
 * `<table>`.
 *
 * The rendered result is the same, but the trees are not, and anything walking
 * `children` sees a different shape — which is exactly what the parity diff
 * reported: `TABLE > TBODY > TR > TD` upstream against `TABLE > TR` here, 24
 * node differences on a single expanded row.
 */
function table(className: string, rows: readonly HTMLElement[]): HTMLTableElement {
    const body = el('tbody', { children: [...rows] });
    return el('table', { class: className, children: [body] });
}

/** Appends links with a single space between them, as `links.join(' ')` does. */
function appendSpaced(into: HTMLElement, links: readonly HTMLElement[]): void {
    links.forEach((link, index) => {
        if (index > 0) {
            into.append(' ');
        }
        into.append(link);
    });
}

// --- the historical chart -------------------------------------------------

/** The `<div class="historical-chart">` wrapper with its canvas. */
export function renderChartSlot(canvasId: string): HTMLElement {
    return el('div', {
        class: 'historical-chart',
        children: [el('canvas', { id: canvasId, class: 'historical-chart-canvas' })],
    });
}

// --- the empty state ------------------------------------------------------

/** `<div class="no-data">…</div>`, which both pages use for empty and error. */
export function noData(text: string): HTMLElement {
    return el('div', { class: 'no-data', text });
}

// --- expansion bookkeeping ------------------------------------------------

/**
 * Removes the rows an expansion inserted after a row.
 *
 * Both pages walk `nextElementSibling` and delete until they reach a row that
 * belongs to a higher level, with a slightly different stop condition at each
 * of the three levels (`old/crashes.html:841`, `:888`, `:929`). Reproduced as one
 * function taking the class names that *end* the run, because the walk itself
 * is the same and getting it subtly wrong at one level is how an expansion
 * leaks rows.
 */
export function removeFollowing(row: Element, stopWhen: (element: Element) => boolean): void {
    let next = row.nextElementSibling;
    while (next !== null && !stopWhen(next)) {
        const toRemove = next;
        next = next.nextElementSibling;
        toRemove.remove();
    }
}

/**
 * Inserts elements immediately after a row, keeping their order.
 *
 * `insertAdjacentHTML('afterend', …)` with a string of several rows inserts them
 * in order; doing the same with nodes needs the anchor to move.
 */
export function insertAfter(row: Element, elements: readonly Element[]): void {
    let anchor: Element = row;
    for (const element of elements) {
        anchor.after(element);
        anchor = element;
    }
}
