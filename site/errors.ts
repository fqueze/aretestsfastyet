/**
 * `errors.html`, migrated onto `lib/`.
 *
 * | file | contains | tested by |
 * | --- | --- | --- |
 * | `lib/formats/errors.ts` | the file format, shared with the CLI | `test/formats.test.ts` |
 * | `lib/query/error-ranking.ts` | the CLI's ranking of the same data | `test/step5-query.test.ts` |
 * | `site/errors-view.ts` | this page's view model — grouping, sorting, filtering, expansion, URL state | `test/errors-view.test.ts`, no DOM |
 * | this file | the renderer, the virtualized list, and the interactions | `test/errors-parity.test.ts` + the browser run |
 *
 * ## The shared drill-down was considered and **not** used
 *
 * `site/drilldown-view.ts` / `drilldown-render.ts` were extracted for
 * `crashes.html` and `failures.html`. The judgement, with the table of shape
 * differences behind it, is at the top of `site/errors-view.ts`. In one line:
 * that drill-down is *key → dirPath → test → occurrence* with a fixed row unit,
 * fixed columns and a path-collapse rule, and this page is *group → sub → task*
 * where the row unit, the sub-row unit and the column set are all chosen by a
 * `<select>`. Serving both would have meant adding `msgCount`, `kindMask` and a
 * nullable key to `GroupRow`, two members to `SubRow`, and a synthetic
 * always-single `PathNode` level — the "three new booleans" signal, three times.
 *
 * What **is** reused, because it really is page-independent: `drilldown-render`'s
 * `el`, `externalLink`, `insertAfter`, `removeFollowing`, `noData` and
 * `searchBox`, and its `declare global` block describing the shared scripts.
 * That is a genuine saving — the escaping question, the CR-in-attribute
 * normalization and the `<tbody>` synthesis are all answered once, and all three
 * are things this page would otherwise have had to rediscover.
 *
 * ## What the migration removes
 *
 * **The string-concatenation renderer.** Upstream builds every row by
 * concatenating HTML and assigning `innerHTML`, which is what forces its
 * `escapeHtml`/`escapeAttr` calls and its `onclick=` attributes. Building nodes
 * answers escaping once, at `el()`.
 *
 * `common-test-data.js` is **not** loaded, and was not loaded before either:
 * `grep -c common-test-data errors.html` is **0**, and none of its seven globals
 * appears in the page. So the brief's requirement is satisfied with nothing
 * removed, and the page was loaded with the file absent from `dist-site/` to
 * confirm it — `tools/build-pages.ts` only copies the assets a page references,
 * and `ls dist-site/common-test-data.js` is a miss.
 *
 * The five shared scripts stay, loaded by name: `shared.js`, `fetch-utils.js`,
 * `dashboards.js`, `common-ui.js`, `common-links.js`.
 *
 * **The Chart.js CDN tag is gone**, and it is the one script tag this migration
 * drops. Upstream loads it (`old/errors.html:211`) for `createDayChart`
 * (`:975-1014`), its own bar chart — this page never loaded
 * `common-charts.js` or called `createRateChart`. That chart drew only in
 * 21-day mode, which is omitted (divergence 6), so the tag was a third-party
 * request for a library nothing could reach.
 *
 * ## Declared divergences from `errors.html`
 *
 * `PARITY.md` §4: byte-identical is the default and every exception is declared.
 * **This list is the whole set.** One enumerated list, no prose carrying an
 * extra entry.
 *
 *  1. **Inline handler attributes become `addEventListener`, and the two that
 *     are in the markup now throw once each.** The markup is byte-identical, so
 *     `onchange="onKindFilterChange()"` on the seven checkboxes and
 *     `onchange="onViewChange()"` on the `<select>` are still attributes — but a
 *     module has no globals, so the attribute handler is a `ReferenceError` and
 *     the listener attached by this file does the work. Measured in Chrome on
 *     the pinned snapshot: toggling one checkbox logs exactly one
 *     `Uncaught ReferenceError: onKindFilterChange is not defined` and the list
 *     re-filters correctly; changing the view logs one
 *     `onViewChange is not defined` and the view changes. This is the same
 *     arrangement `site/crashes.html` and `site/failures.html` already ship for
 *     their `onchange="loadSelectedDate()"`, and it is listed rather than fixed
 *     because fixing it means editing the markup, which the brief forbids.
 *
 *     Every handler this page *generates* — `onclick="sortBy('count')"` on each
 *     header, `onclick="event.stopPropagation();"` on each Searchfox and each
 *     occurrence link — is gone. Measured in Chrome by counting `on*`
 *     attributes in the live DOM under `#content`:
 *
 *     | state | old | new |
 *     | --- | --- | --- |
 *     | first paint, xpcshell 2026-08-04, message view | **47** | **0** |
 *     | first paint, mochitest 2026-08-03, message view | 37 | 0 |
 *     | either, in the test view (no per-row links) | 3 | 0 |
 *     | one mochitest test-view sub-row expanded (16,849 sub-rows) | **27,829** | **0** |
 *     | one mochitest component-view sub-row expanded (18,069 sub-rows) | 36,061 | 0 |
 *
 *     The message view's 47 is 3 sort buttons plus one `stopPropagation` per
 *     Searchfox link in the 50 rendered rows — 44 of the 50 rows carry a
 *     `file:line`. The number tracks what is on screen rather than the row
 *     count, because the list is virtualized.
 *
 *  2. **`data-group` is no longer an index into `currentResult.visible`.**
 *     Upstream writes `data-group="${idx}"` and the click handler does
 *     `currentResult.visible[+target.dataset.group]` (`:810`, `:1032`), so the
 *     attribute is a position in an array that is rebuilt by every filter, sort
 *     and view change. Here the row elements are held in a `WeakMap` to their
 *     rows, so there is no index to go stale. The attribute is still emitted,
 *     with the same value, because the virtualization reads it to know which
 *     chunk a row is in — but nothing resolves a row *through* it.
 *
 *     This is not a bug fix: upstream drops every expansion on re-render
 *     (`:713-715`), so the stale index is never read. It is listed because a DOM
 *     diff sees the attribute unchanged and a reader of the code sees a
 *     different mechanism.
 *
 *  3. **The total row's per-view "Tests"/"Messages" numbers are unchanged, and
 *     they are distinct counts, not sums of the column.** Worth stating because
 *     it is the *opposite* of `crashes.html` and `failures.html`, whose total
 *     rows overcount by summing each row's test count. This page's totals come
 *     from `seenTid`/`seenMid` — one flag per test and per message over the
 *     whole pass — so they are exact. Measured on the pinned xpcshell
 *     2026-08-04 file, message view, all kinds on: **the Total row shows 624
 *     tests where the rows' test counts sum to 7,519**, a 12.0× difference, and
 *     624 really is the number of distinct test IDs in the file. Nothing changed
 *     here; it is on the list so a reviewer comparing the three migrated
 *     drill-down pages does not read the difference as a regression in the
 *     other direction.
 *
 *  4. **The percentage tooltips still ignore the search term — reproduced, not
 *     fixed.** `pctTitle(count, currentResult.total)` divides by the grand
 *     total, and `currentResult.total` is only ever recomputed by a re-group or
 *     by the message view's kind-toggle path (`:686-695`). A search re-picks
 *     which rows are visible and touches no number.
 *
 *     **Measured in Chrome on the old page, pinned xpcshell 2026-08-04, message
 *     view, search `NS_ENSURE_TRUE`:**
 *
 *     | | value |
 *     | --- | --- |
 *     | rows matching | 100 of 1,078 |
 *     | their occurrences | 20,922 of 315,376 |
 *     | Total row, before the search | `624` / `315 376` |
 *     | Total row, **during** the search | `624` / `315 376` — unchanged |
 *     | top row | `NS_ENSURE_TRUE(mNameHashtable.Get(aName, &index)) failed`, 15,281 |
 *     | its tooltip | **`4.85% of all occurrences`** |
 *     | 15,281 / 20,922, the share of what is on screen | 73.04% |
 *
 *     So the top row of a searched list reads 4.85% while being nearly
 *     three-quarters of everything the reader can see, and the Total above it
 *     is fifteen times the sum of the visible column.
 *
 *     **Why reproduced rather than fixed**, deliberately: the tooltip says
 *     *"of all occurrences"*, and that is the question it answers correctly —
 *     "this message is 4.85% of everything xpcshell logged today" is a useful
 *     and true statement, and arguably the more useful of the two. Changing the
 *     denominator to the filtered total would make the *wording* false unless
 *     the wording changed too, and rewording a tooltip a human reads is a
 *     product decision rather than a migration's to make. The Total row has the
 *     same property and is visibly not the sum of the column under it, which is
 *     the honest signal that these numbers are file-scoped. Filed here rather
 *     than fixed silently; the fix is one argument at the two `pctTitle` call
 *     sites in `render`/`renderSubRow` plus a string change, and it should be
 *     made on both pages at once or neither.
 *
 *  5. **A message with a line and no file still renders without either.**
 *     `groupName` nests the line inside the file (`:493-494`), so a message the
 *     grouping distinguished *by line* is displayed by its text alone.
 *     Measured: **16 of the 1,078 messageIds** on the pinned xpcshell
 *     2026-08-04 file have a line and no file. Reproduced, because changing it
 *     changes the row label a reader compares against the old page. Note the
 *     sort by name is affected too: two such rows sort as equal.
 *
 *  6. **The "Show Last 21 Days" and "Load task details" buttons are deliberately
 *     omitted, because the data they ask for does not exist.** This is the one
 *     entry on this list that is an *intentional departure from the markup*
 *     rather than a difference in how the same markup is driven, and `PARITY.md`
 *     §4 requires it be declared with its reason. It is stated here and nowhere
 *     else.
 *
 *     Upstream has both buttons at `old/errors.html:173-174`. `initHistoricalToggle`
 *     fetches `{harness}-errors.json` (`:1190`) and `loadTaskDetails` fetches
 *     `{harness}-errors-with-taskids.json` (`:1098`).
 *
 *     **Measured against the published artifacts on 2026-08-05, over the
 *     Taskcluster index the page's own `fetchData` resolves
 *     (`test-info-{harness}-timings`):**
 *
 *     | file | xpcshell | mochitest |
 *     | --- | --- | --- |
 *     | `{harness}-errors.json` | **404** | **404** |
 *     | `{harness}-errors-with-taskids.json` | **404** | **404** |
 *     | `{harness}-2026-08-04-errors.json` | 200 | 200 |
 *
 *     And over every one of the 21 dates `index.json` offers, fetching each
 *     daily errors file and reading its `markers`: **6 of 21 exist per harness,
 *     and `hasDays` is false on all 6 while `hasTasks` is true on all 6.** So
 *     neither aggregate shape is reachable from either harness, by either page.
 *
 *     **What the old page does when the button is clicked**: `common-ui.js:234`
 *     throws on the non-ok response, and its `catch` writes
 *     `Historical data not available` into `#content` and sets the status text
 *     to `Error loading data` — so the control's only effect is to replace the
 *     list with an error. The "Load task details" button is never even shown:
 *     its display is driven by `hasTasks` being false (`:1198`), and `hasTasks`
 *     is true on every file that loads.
 *
 *     **Why omitted rather than reproduced.** Emitting a control that cannot
 *     work satisfies a DOM diff and turns a known gap into a hidden one — the
 *     mistake `try.html` made with its Reproduce button. A reader cannot tell a
 *     button that is broken from one that is waiting for data. Removing it says
 *     what is true: this page shows one day, and there is no aggregate to show.
 *
 *     **What went with them**, all of it reachable only from these two buttons:
 *     `isHistoricalMode`, the `initHistoricalToggle` call and its
 *     `onHistoricalToggled` callback, `loadTaskDetails`, the per-day chart
 *     (`createDayChart`, `:975-1014`) with its `historical-chart` wrapper, the
 *     Chart.js CDN tag that existed only to draw it, and `__view`'s `historical`
 *     field. `#date=21days` in a bookmarked URL is handled rather than dropped
 *     — see `loadFromUrlHash`.
 *
 *     **What stayed, because it serves the live page**: `hasDays` and
 *     `numDays` in `site/errors-view.ts` are file-shape probes, and `hasDays`
 *     still picks which of two sources a task's date comes from in
 *     `instancesOf`. `buildDetail` still computes `dayCounts`, which is `null`
 *     on every file above. `isHistoricalDate` stayed and gained a second caller
 *     — it is now what recognizes a stale `#date=21days`.
 *
 *  7. **A job name the file cannot resolve renders as empty, not `"undefined"`.**
 *     Same class as `crashes.html`'s entry 6. Upstream indexes
 *     `tables.jobNames[taskInfo.jobNameIds[id]]` with no guard. Not reachable on
 *     the pinned files — every task index resolves — so this differs only in a
 *     branch neither page takes.
 *
 *  8. **A tooltip whose message contains an HTML entity now shows the message,
 *     not the decoded entity — and this fixes a live defect.** Found by the
 *     browser diff rather than by reading, which is why it is worth stating how.
 *
 *     `escapeAttr` (`common-ui.js:14`) escapes `"` and `'` and **not `&`**.
 *     Upstream writes `title="${escapeAttr(text)}"` into a string and lets the
 *     HTML parser build the attribute, so a message whose text literally
 *     contains `&nbsp;` arrives in the parser as an entity reference and is
 *     **decoded**: the old page's tooltip shows a non-breaking space where the
 *     message says `&nbsp;`. Probed in Chrome to be sure of the mechanism rather
 *     than inferring it:
 *
 *     ```
 *     innerHTML, & unescaped   ->  "a b"   (decoded; what the old page does)
 *     innerHTML, & escaped     ->  "a&nbsp;b"   (what escapeAttr does NOT do)
 *     element.title = raw      ->  "a&nbsp;b"   (what this page does)
 *     ```
 *
 *     **Measured on the pinned files**, counting message texts containing a
 *     parsable entity reference: **13 of 35,474 mochitest rows (1,586
 *     occurrences of 67,840,668), and 0 of 1,078 xpcshell rows.** So it is live
 *     on mochitest and unreachable on xpcshell. The concrete row is a
 *     `NS_ENSURE_TRUE(entry && …) failed` warning quoting editor content
 *     `#text("&nbsp;X")`, where the old page's tooltip silently turns the
 *     literal source text into whitespace — losing exactly the detail a reader
 *     hovering a truncated message is looking for.
 *
 *     Fixed rather than reproduced, because reproducing it would mean
 *     re-introducing an entity-decoding round-trip on purpose, and because the
 *     new page cannot easily reproduce it: `el()` assigns the property. The
 *     browser harness normalizes it so the rest of the `title` comparison still
 *     runs. Note the *rendered row text* is unaffected on both pages — upstream
 *     uses `escapeHtml` there, which does escape `&` — so only the tooltip
 *     differs.
 *
 *  9. **The message view's row unit drops the component, and every row now
 *     carries a component summary.** The one entry on this list that is a
 *     **deliberate product change** rather than a migration decision — the rest
 *     describe how the same behaviour is reached; this one changes what the
 *     page shows, on purpose.
 *
 *     Upstream's row is one **`messageId`**, which the format defines as a
 *     distinct (kind, text, file, line, **component**) tuple. But the component
 *     is not a property of the message: the message is emitted at a `file:line`,
 *     and the component is whichever test happened to be running when it
 *     printed. Keying on it splits one message into several rows for a reason
 *     that says nothing about the message — and the page already has a separate
 *     component view for the component question.
 *
 *     **Measured on the pinned xpcshell 2026-08-04 file:**
 *
 *     | | old | new |
 *     | --- | --- | --- |
 *     | message-view rows | **1,078** | **870** |
 *     | rows for `TargetingContextRecorder: Could not get "addonsInfo"` | 9, of 30,856 / 232 / 140 / 12 / 10 / 9 / 7 / 3 / 2 | **1, of 31,271** |
 *     | rows for `uncaught exception: Object` at that location | 61 | **1, of 3,437** |
 *
 *     36 keys hold more than one messageId, and **0 of the 36** differ by
 *     anything other than the component — so the merge loses nothing but the
 *     split. Occurrences are conserved exactly: both groupings sum to 315,376.
 *
 *     What replaces the split is a **component summary on the row**, in the
 *     component column upstream already had. One component reads as itself; a
 *     row where one component holds a strict majority reads
 *     `Firefox :: Nimbus Desktop Client  +8 more`; a row where none does reads
 *     `61 components` and names nobody. The `title` carries the full breakdown,
 *     biggest first, capped at twelve with a line saying how many components
 *     and how many occurrences were dropped. The threshold and the cap are
 *     documented with the distributions they came from in
 *     `lib/query/error-ranking.ts`, which is where the rule lives so that
 *     `fx-tests errors` shows the same words on the same row.
 *
 *     The other two views are untouched: the test view still groups by test
 *     path and the component view still groups by component, and
 *     `test/errors-parity.test.ts` asserts both against `--group-by test` and
 *     `--group-by component`.
 *
 * Two things worth naming that are **not** divergences, both measured rather
 * than assumed:
 *
 * - **The status line still reads `N test jobs · 0 markers`.**
 *   `old/errors.html:1076` reads `meta.markerCount`, and the published files carry
 *   `markerCounts` (a per-kind object) and no `markerCount`. So `(undefined ||
 *   0).toLocaleString()` is `"0"` on both pages: the pinned xpcshell 2026-08-04
 *   file shows `1,301 test jobs · 0 markers` where the file holds 315,376
 *   markers. Reproduced exactly — fixing it would change a number on screen,
 *   and it is a defect in the page rather than in the migration. It is not on
 *   the divergence list because both pages print the same wrong string.
 * - **The virtualized list.** Kept, including its 50-row chunks, its 600px
 *   observer margin, its measured row height and its pinned chunk. It is not
 *   decoration: the pinned mochitest 2026-08-03 file produces **31,530
 *   message-view rows**, and the list is what keeps the DOM small — measured at
 *   first paint on the *xpcshell* 2026-08-04 page (870 rows), **529 elements
 *   under `#content` for the 50 rows actually rendered**. Both pages render the
 *   same 50, which is why every `renderedRows` in the browser comparison reads
 *   50 rather than the row count.
 *
 * Everything else — the `message` default view, the count-descending default
 * sort re-asserted on every view change, the `ascending = column === 'name'`
 * rule, the seven checkboxes and their view-dependent meaning, the double-click
 * solo, the single-day default window, the absence of any run-count
 * normalization, and the `#date&q&view&hide` state including `q` clearing the
 * box — is reproduced.
 */

import type { ErrorsFile } from '../lib/formats/errors.ts';
import {
    type ErrorGroupRow,
    type ErrorView,
    type Instance,
    type PreparedErrors,
    type SortColumn,
    type SortState,
    type SubGroup,
    type Totals,
    type ViewColumn,
    INITIAL_SORT,
    KIND_SLUG,
    KIND_SLUGS,
    VIEW_COLS,
    VIEW_NAME_LABEL,
    buildDetail,
    buildGroupRows,
    colValue,
    componentBreakdown,
    componentBreakdownTitle,
    componentSummary,
    ensureHaystacks,
    formatHidden,
    groupName,
    instanceRows,
    instancesOf,
    isHistoricalDate,
    kindMask,
    kindStates,
    messageTotals,
    nextSort,
    parseHidden,
    pctTitle,
    prepareErrors,
    readUrlState,
    representativeMid,
    soloKind,
    sortRows,
    visibleRows,
} from './errors-view.ts';
import {
    type SearchBoxManager,
    el,
    externalLink,
    insertAfter,
    noData,
    removeFollowing,
    searchBox,
} from './drilldown-render.ts';
import { taskPageUrl } from './test-link.ts';

// --- page state -----------------------------------------------------------

let data: PreparedErrors | null = null;
/** Which kinds are on, indexed by the file's `markerNameId`. */
let kindOn: boolean[] = [];
let currentSort: SortState = { ...INITIAL_SORT };

/** Every row of the current grouping, ranked. */
let allRows: ErrorGroupRow[] = [];
/** The rows a reader can see, after the kind mask and the search. */
let visible: ErrorGroupRow[] = [];
/** The Total row's numbers. */
let totals: Totals = { count: 0, tests: null, messages: null };

let searchBoxManager: SearchBoxManager;
let hashManager: ReturnType<typeof initUrlHashManager>;

const content = (): HTMLElement => document.getElementById('content')!;
const statusText = (): HTMLElement => document.getElementById('statusText')!;
const dateSelect = (): HTMLSelectElement =>
    document.getElementById('dateSelect') as HTMLSelectElement;
const viewSelect = (): HTMLSelectElement =>
    document.getElementById('viewSelect') as HTMLSelectElement;
const kindBox = (slug: string): HTMLInputElement =>
    document.getElementById(`kind-${slug}`) as HTMLInputElement;

/** The active view. `getView()` (`old/errors.html:599`). */
const view = (): ErrorView => viewSelect().value as ErrorView;

/** The trimmed, lowercased search term — what every filter compares against. */
const term = (): string => searchBoxManager.getValue().trim().toLowerCase();

/** The slugs whose checkbox is unchecked. `getDisabledKindSlugs` (`:1113`). */
function disabledSlugs(): Set<string> {
    return new Set(KIND_SLUGS.filter((slug) => !kindBox(slug).checked));
}

// =========================================================================
// Expansion state
// =========================================================================

/**
 * The one open top-level row, and the sub-rows open under it.
 *
 * One group at a time, like `failures.html`. Both are dropped by every
 * re-render, which is upstream's behaviour (`:713-715`) and is why a stale
 * `data-group` index is never read — see divergence 2.
 */
let expandedRow: ErrorGroupRow | null = null;
let expandedElement: HTMLElement | null = null;
const expandedSubs = new Set<number>();

/**
 * ### Where upstream's `g.subArr` cache went
 *
 * `old/errors.html:881` caches an expanded row's detail **on the row object**
 * (`g.subArr = buildGroupDetail(g).subArr`) and `buildGroupDetail` itself caches
 * on `g.detail` (`:505`). Neither cache is kept here, and there is no field for
 * them: `renderSubRow` closes over the `SubGroup` it is rendering, so the click
 * path never needs to look the detail up again, and the detail is rebuilt when a
 * row is reopened.
 *
 * That is a **behaviour fix**, not just a refactor, and it is small enough to be
 * stated here rather than on the divergence list because upstream's caches are
 * unreachable: `g.detail` is keyed on nothing but the row, so a row expanded,
 * collapsed, searched and reopened would upstream reuse a `subArr` built under
 * the *old* search term (`buildGroupDetail` applies the term at `:527`). It does
 * not happen only because `renderVirtualList` rebuilds `allRows` on every filter
 * change and the cached objects are dropped with the old array. Rebuilding
 * unconditionally makes that an invariant rather than a coincidence, at the cost
 * of one walk of the row's CSR run — 11,943 sub-rows on the pinned mochitest
 * file's widest row, which is the same walk that produced the row's count.
 */

/** Row element → its row, so a click resolves without an index. */
let rowOf = new WeakMap<HTMLElement, ErrorGroupRow>();
/** Sub-row element → its sub, likewise. */
let subOf = new WeakMap<HTMLElement, { sub: SubGroup; index: number }>();

// =========================================================================
// Rendering
// =========================================================================

/**
 * Full rebuild: re-group, re-sort, re-filter, re-render.
 *
 * `renderList` (`old/errors.html:652-660`). Used on data load, on a view change,
 * and — test and component views only — on a kind change.
 */
function renderList(): void {
    if (data === null) {
        replaceContent(noData('No data available'));
        return;
    }
    kindOn = kindStates(data.markerNames, disabledSlugs());
    const result = buildGroupRows(data, view(), kindOn, currentSort);
    allRows = result.rows;
    totals = result.totals;
    applyFilter();
}

/**
 * Cheap path: re-pick the visible rows and re-render, without re-grouping.
 *
 * `applyFilter` (`old/errors.html:666-698`). A message-view kind toggle and every
 * search change come through here.
 */
function applyFilter(): void {
    if (data === null) {
        return;
    }
    kindOn = kindStates(data.markerNames, disabledSlugs());
    const currentView = view();
    const searchTerm = term();
    if (searchTerm !== '') {
        ensureHaystacks(data, currentView, allRows);
    }
    visible = visibleRows(currentView, allRows, kindMask(kindOn), searchTerm);

    // The message view does not re-group on a kind toggle, so its Total row (and
    // therefore every percentage tooltip) has to be refreshed from the per-kind
    // aggregates. See `messageTotals`.
    if (currentView === 'message') {
        totals = messageTotals(data, kindOn);
    }

    renderVirtualList();
}

/** Swaps `#content`'s children for one element. */
function replaceContent(node: Node): void {
    const target = content();
    target.textContent = '';
    target.append(node);
}

// --- the virtualized list -------------------------------------------------

/**
 * The virtualized group list.
 *
 * Ported unchanged in behaviour from `old/errors.html:709-798`, and it is load
 * bearing rather than decorative: the pinned mochitest 2026-08-03 file produces
 * 35,474 message-view rows and 20,345 test-view rows. Every chunk is a placeholder
 * `<div>` sized to its rows; an `IntersectionObserver` fills it while it (or its
 * 600px margin) is on screen and empties it again when it scrolls away.
 */
const VCHUNK = 50;
let observer: IntersectionObserver | null = null;
/** Measured height of one collapsed row, px. The initial 29 is upstream's. */
let rowHeight = 29;
/** The chunk holding the expanded row, kept filled while it scrolls away. */
let pinnedChunk: Element | null = null;

/** `renderVirtualList` (`old/errors.html:709`). */
function renderVirtualList(): void {
    const currentView = view();
    const cols = VIEW_COLS[currentView];

    expandedRow = null;
    expandedElement = null;
    expandedSubs.clear();
    rowOf = new WeakMap();
    subOf = new WeakMap();
    if (observer !== null) {
        observer.disconnect();
        observer = null;
    }
    pinnedChunk = null;

    if (visible.length === 0) {
        replaceContent(noData('No errors or warnings match the current filters.'));
        return;
    }

    const list = el('div', { class: 'marker-list' });
    list.append(renderSortHeader(currentView, cols));
    list.append(renderTotalRow(cols));

    const chunkCount = Math.ceil(visible.length / VCHUNK);
    const vlist = el('div', { class: 'vlist' });
    for (let c = 0; c < chunkCount; c++) {
        const chunk = el('div', { class: 'vchunk' });
        chunk.dataset['chunk'] = String(c);
        vlist.append(chunk);
    }
    list.append(vlist);
    replaceContent(list);

    // Measure a real row from the always-present total row, then size each
    // placeholder so the scrollbar matches the full, unrendered list.
    const totalRow = list.querySelector('.total-row');
    if (totalRow !== null) {
        rowHeight = totalRow.getBoundingClientRect().height;
    }
    const chunks = list.querySelectorAll('.vchunk');
    for (const chunk of chunks) {
        (chunk as HTMLElement).style.height = `${chunkRowCount(chunkIndex(chunk)) * rowHeight}px`;
    }

    observer = new IntersectionObserver(onChunkIntersect, { rootMargin: '600px 0px' });
    for (const chunk of chunks) {
        observer.observe(chunk);
    }
}

const chunkIndex = (chunk: Element): number => Number((chunk as HTMLElement).dataset['chunk']);

/** Rows in chunk `c`; the last one may be short. `chunkRowCount` (`:766`). */
function chunkRowCount(c: number): number {
    return Math.min(VCHUNK, visible.length - c * VCHUNK);
}

function onChunkIntersect(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
        if (entry.isIntersecting) {
            fillChunk(entry.target as HTMLElement);
        } else {
            clearChunk(entry.target as HTMLElement);
        }
    }
}

/**
 * Renders a chunk's rows. `fillChunk` (`old/errors.html:780`).
 *
 * Upstream's comment is worth keeping because it is the invariant that makes
 * this correct: a freshly visible chunk never holds the expanded row, because
 * expanding requires clicking a row that was already on screen and its chunk is
 * then pinned. So no expansion needs restoring here.
 */
function fillChunk(chunk: HTMLElement): void {
    if (chunk.dataset['filled'] === '1' || data === null) {
        return;
    }
    const currentView = view();
    const c = chunkIndex(chunk);
    const start = c * VCHUNK;
    const end = Math.min(start + VCHUNK, visible.length);
    for (let i = start; i < end; i++) {
        chunk.append(renderGroupRow(currentView, visible[i]!, i));
    }
    chunk.style.height = 'auto';
    chunk.dataset['filled'] = '1';
}

function clearChunk(chunk: HTMLElement): void {
    if (chunk.dataset['filled'] !== '1' || chunk === pinnedChunk) {
        return;
    }
    chunk.style.height = `${chunkRowCount(chunkIndex(chunk)) * rowHeight}px`;
    chunk.textContent = '';
    chunk.dataset['filled'] = '0';
}

// --- the rows -------------------------------------------------------------

/** The sortable header. `old/errors.html:728-734`. */
function renderSortHeader(currentView: ErrorView, cols: readonly ViewColumn[]): HTMLElement {
    const header = el('div', { class: 'sort-header' });

    const nameButton = sortButton('name', VIEW_NAME_LABEL[currentView]);
    // Upstream sets these two properties as an inline `style=` attribute on the
    // name button only (`:729`), so the name header left-aligns and sizes to its
    // text while the numeric headers stay in their fixed columns. Reproduced as
    // the same two declarations.
    nameButton.style.width = 'auto';
    nameButton.style.justifyContent = 'flex-start';
    header.append(el('div', { class: 'marker-main', children: [nameButton] }));

    const stats = el('div', { class: 'marker-stats' });
    for (const col of cols) {
        stats.append(el('div', { class: 'marker-stat-h', children: [sortButton(col.key, col.label)] }));
    }
    header.append(stats);
    return header;
}

/**
 * One column header button.
 *
 * The arrow is a `<span class="sort-arrow">` that is **present but empty** on
 * the inactive columns, which is upstream's markup (`:729`, `:732`) and what
 * keeps the columns from shifting when the sort moves.
 */
function sortButton(column: SortColumn, label: string): HTMLElement {
    const active = currentSort.column === column;
    const button = el('button', {
        class: `sort-button ${active ? 'active' : ''}`,
        children: [
            el('span', {
                class: 'sort-arrow',
                text: active ? (currentSort.ascending ? '▲' : '▼') : '',
            }),
            label,
        ],
    });
    button.addEventListener('click', () => sortBy(column));
    return button;
}

/**
 * The `📊 Total` row. `old/errors.html:737-741`.
 *
 * `non-clickable` and no percentage tooltip: `statsHtml` is called without a
 * `total` here (`:738`), so `pctTitle` is never reached for this row even though
 * it has an occurrences cell. Reproduced — the total's own share of the total
 * would be a tooltip reading `100.00%`, which upstream chose not to emit.
 */
function renderTotalRow(cols: readonly ViewColumn[]): HTMLElement {
    const row = el('div', { class: 'data-row total-row non-clickable' });
    row.append(
        el('div', {
            class: 'marker-main',
            children: [el('span', { class: 'marker-message', text: '📊 Total' })],
        })
    );
    row.append(
        renderStats(
            cols.map((col) =>
                col.key === 'count'
                    ? totals.count
                    : col.key === 'tests'
                      ? (totals.tests ?? 0)
                      : (totals.messages ?? 0)
            ),
            cols,
            null
        )
    );
    return row;
}

/** One top-level row. `renderGroupRow` (`old/errors.html:800-811`). */
function renderGroupRow(currentView: ErrorView, row: ErrorGroupRow, index: number): HTMLElement {
    const element = el('div', { class: 'data-row marker-row' });
    // Kept because the virtualization and a reader inspecting the DOM both use
    // it, but nothing resolves a row through it any more — see divergence 2.
    element.dataset['group'] = String(index);

    if (currentView === 'message') {
        // `row.gid` is a location id, so the diagnostic's kind, text, file and
        // line come off any of its messageIds — they are the key. Only the
        // component varies, and that is what the summary span answers.
        element.append(diagnosticMain(representativeMid(data!, row.gid), summaryComponentSpan(row)));
    } else {
        // `g.key || '(no test)'` — an empty label, which the component view's
        // sentinel and a root-level test path can both produce. The `title`
        // carries the raw key, so an empty one gives an empty title, matching
        // `escapeAttr(g.key)` on the empty string. `:806-807`.
        const label = row.key || (currentView === 'test' ? '(no test)' : '(none)');
        element.append(
            el('div', {
                class: 'marker-main',
                children: [
                    el('span', { class: 'marker-message', title: row.key ?? '', text: label }),
                ],
            })
        );
    }

    const cols = VIEW_COLS[currentView];
    element.append(
        renderStats(
            cols.map((col) => colValue(data!, row, col.key) as number),
            cols,
            totals.count,
            visibleOccurrences()
        )
    );
    rowOf.set(element, row);
    return element;
}

/**
 * The occurrence count across the rows a search left on screen.
 *
 * Memoized on the `visible` array itself rather than recomputed per row: rows
 * are rendered in chunks of `VCHUNK` as the reader scrolls, so summing 35,474
 * rows inside each row's own render would be quadratic on the mochitest file.
 * `visible` is replaced wholesale by `applyFilters`, never mutated, so identity
 * is a sound cache key.
 */
let visibleTotalFor: ErrorGroupRow[] | null = null;
let visibleTotalValue = 0;
function visibleOccurrences(): number {
    if (visibleTotalFor !== visible) {
        visibleTotalValue = visible.reduce((sum, row) => sum + row.count, 0);
        visibleTotalFor = visible;
    }
    return visibleTotalValue;
}

/**
 * The stats area. `statsHtml` (`old/errors.html:638-646`).
 *
 * `total` enables the percentage tooltip on the occurrences cell only; passing
 * `null` suppresses it, which is what the Total row does.
 *
 * `visibleTotal` is the sum over the rows a search left on screen. Upstream had
 * no such argument and always divided by the grand total, so a searched row
 * reported its share of a population the reader could not see — see `pctTitle`
 * for the measurement.
 */
function renderStats(
    values: readonly number[],
    cols: readonly ViewColumn[],
    total: number | null,
    visibleTotal?: number
): HTMLElement {
    const stats = el('div', { class: 'marker-stats' });
    for (let i = 0; i < values.length; i++) {
        const tooltip =
            cols[i]!.key === 'count' && total !== null
                ? pctTitle(values[i]!, total, visibleTotal)
                : null;
        stats.append(
            el('div', {
                class: 'marker-stat',
                ...(tooltip === null ? {} : { title: tooltip }),
                text: values[i]!.toLocaleString(),
            })
        );
    }
    return stats;
}

/**
 * The badge + message + `file:line` + component area for one diagnostic.
 *
 * `diagnosticMain` (`old/errors.html:616-629`). Used for message-view top rows and
 * for test/component-view sub-rows — the same element in both places, which is
 * why it takes a `messageId` rather than a row.
 *
 * The **component span is the one part the two callers disagree about**, so it
 * is passed in rather than read here. A sub-row under a test or a component row
 * really is one `messageId`, so it names that one component and nothing else. A
 * message-view row is a source location that several components may have hit,
 * and reading `msgComp` off any single one of its messageIds would print an
 * arbitrary pick as though it were the answer — see `componentSummary`.
 */
function diagnosticMain(messageId: number, component: HTMLElement): HTMLElement {
    const d = data!;
    const kind = d.markerNames[d.msgKindId[messageId]!]!;
    const file = d.msgFile[messageId];
    const line = d.msgLine[messageId];
    const text = d.msgText[messageId]!;

    const main = el('div', { class: 'marker-main' });
    // `KIND_SLUG[kind] || ''` — a kind the table does not name gets
    // `class="kind-badge kind-"`, which the stylesheet does not colour. Upstream
    // (`:609`); unreachable on the pinned files, where every kind is named.
    main.append(
        el('span', { class: `kind-badge kind-${KIND_SLUG[kind] ?? ''}`, text: kind })
    );
    main.append(el('span', { class: 'marker-message', title: text, text }));
    if (file) {
        main.append(el('span', { class: 'marker-loc', children: [searchfoxLink(file, line)] }));
    }
    main.append(component);
    return main;
}

/** The component span for one messageId: its component, and nothing else. */
function oneComponentSpan(messageId: number): HTMLElement {
    return el('span', { class: 'marker-component', text: data!.msgComp[messageId]! });
}

/**
 * The component span for a message-view row: the summary, with the full
 * breakdown as its tooltip.
 *
 * The breakdown is computed here rather than on the row because it walks the
 * row's CSR run, and the virtualized list only ever renders the ~50 rows on
 * screen — doing it for all 31,530 mochitest rows at grouping time would be
 * work for rows the reader never scrolls to.
 */
function summaryComponentSpan(row: ErrorGroupRow): HTMLElement {
    const shares = componentBreakdown(data!, row);
    const summary = componentSummary(shares);
    const title = componentBreakdownTitle(shares);
    return el('span', {
        class: `marker-component${shares.length > 1 ? ' marker-component-many' : ''}`,
        ...(title === null ? {} : { title }),
        text: summary ?? '',
    });
}

/** The Searchfox link on a `file:line`. `searchfoxFileLink` (`old/errors.html:601`). */
function searchfoxLink(file: string, line: number | null | undefined): HTMLAnchorElement {
    let url = `https://searchfox.org/mozilla-central/source/${file}`;
    if (line != null) {
        url += `#${line}`;
    }
    // `externalLink` attaches the `stopPropagation` upstream writes as an
    // `onclick=` attribute, so clicking the location does not expand the row.
    return externalLink(url, line != null ? `${file}:${line}` : file);
}

// =========================================================================
// Sorting
// =========================================================================

/** `sortBy` (`old/errors.html:818-828`). Re-sorts and re-filters; never re-groups. */
function sortBy(column: SortColumn): void {
    if (data === null) {
        return;
    }
    currentSort = nextSort(currentSort, column);
    sortRows(data, allRows, currentSort);
    applyFilter();
}

// =========================================================================
// Expansion
// =========================================================================

/** A top-level row's subtree runs until the next one. `old/errors.html:845`. */
const endsGroup = (element: Element): boolean =>
    element.classList.contains('marker-row') ||
    element.classList.contains('sort-header') ||
    element.classList.contains('total-row');

/** A sub-row's subtree also ends at the next sub-row. `old/errors.html:916`. */
const endsSub = (element: Element): boolean =>
    endsGroup(element) || element.classList.contains('sub-row');

/** `toggleGroup` (`old/errors.html:841-874`). */
function toggleGroup(row: ErrorGroupRow, element: HTMLElement): void {
    if (expandedRow === row) {
        element.classList.remove('expanded');
        removeFollowing(element, endsGroup);
        expandedRow = null;
        expandedElement = null;
        expandedSubs.clear();
        pinnedChunk = null;
        return;
    }

    // Close any previously open row. Upstream finds it with
    // `querySelector('.marker-row[data-group="N"]')`; the element is held
    // directly here, which also means a previously open row whose chunk was
    // emptied is simply gone rather than being a failed selector.
    if (expandedElement !== null) {
        expandedElement.classList.remove('expanded');
        removeFollowing(expandedElement, endsGroup);
        expandedSubs.clear();
    }

    expandedRow = row;
    expandedElement = element;
    element.classList.add('expanded');

    const detail = buildDetail(data!, view(), row, kindOn, term());

    // `old/errors.html:846-871` inserts a per-day bar chart above the sub-rows when
    // `isHistoricalMode && data.hasDays`. Omitted with the 21-day control — see
    // divergence 6. `detail.dayCounts` is still built by `buildDetail`, and is
    // `null` on every file this page can load.
    const inserted: HTMLElement[] = [];
    for (let s = 0; s < detail.subs.length; s++) {
        inserted.push(renderSubRow(view(), detail.subs[s]!, s));
    }
    insertAfter(element, inserted);

    // Keep this chunk filled even when scrolled off screen, so the open row
    // survives scrolling. `:868`.
    pinnedChunk = element.closest('.vchunk');
}

/** One sub-row. `renderSubRow` (`old/errors.html:894-909`). */
function renderSubRow(currentView: ErrorView, sub: SubGroup, index: number): HTMLElement {
    const clickable = data!.hasTasks;
    const element = el('div', {
        class: `data-row test-row direct-child sub-row${clickable ? '' : ' non-clickable'}`,
    });
    element.dataset['group'] = expandedElement?.dataset['group'] ?? '';
    element.dataset['sub'] = String(index);

    if (currentView === 'message') {
        // The sub is a test.
        const testFull = data!.testFull[sub.key]!;
        element.append(
            el('div', {
                class: 'marker-main',
                children: [el('span', { class: 'marker-message', title: testFull, text: testFull })],
            })
        );
    } else {
        // The sub is a diagnostic — one messageId, so one component.
        element.append(diagnosticMain(sub.key, oneComponentSpan(sub.key)));
    }

    const tooltip = pctTitle(sub.count, totals.count);
    element.append(
        el('div', {
            class: 'marker-stats',
            children: [
                el('div', {
                    class: 'marker-stat',
                    ...(tooltip === null ? {} : { title: tooltip }),
                    text: sub.count.toLocaleString(),
                }),
            ],
        })
    );

    subOf.set(element, { sub, index });
    if (clickable) {
        element.addEventListener('click', (event) => {
            if ((event.target as Element).tagName === 'A') {
                return;
            }
            toggleSub(sub, index, element);
        });
    }
    return element;
}

/** `toggleSub` (`old/errors.html:911-933`). */
function toggleSub(sub: SubGroup, index: number, element: HTMLElement): void {
    if (!data!.hasTasks) {
        return;
    }

    if (expandedSubs.has(index)) {
        element.classList.remove('expanded');
        removeFollowing(element, endsSub);
        expandedSubs.delete(index);
        return;
    }

    expandedSubs.add(index);
    element.classList.add('expanded');

    // The test name the profiler's marker search is seeded with. Known in the
    // message view (the sub *is* a test) and in the test view (the row is), and
    // **null in the component view**, where neither level names one — so a
    // component-view profile link has no `markerSearch`. `old/errors.html:927-930`.
    const currentView = view();
    const testName =
        currentView === 'message'
            ? data!.testFull[sub.key]!
            : currentView === 'test'
              ? (expandedRow?.key ?? null)
              : null;

    insertAfter(element, [renderInstances(sub, testName)]);
}

/** The per-task table under an expanded sub-row. `renderInstances` (`:935`). */
function renderInstances(sub: SubGroup, testName: string | null): HTMLElement {
    const raw = data!.raw;
    const rows: HTMLElement[] = [];

    for (const { instance, showDate } of instanceRows(instancesOf(data!, sub))) {
        const profilerUrl = getProfilerUrl(instance, testName);

        const links: HTMLElement[] = [externalLink(profilerUrl, 'Profile')];
        const jobUrl = getTreeherderJobUrl(instance, raw);
        if (jobUrl !== null) {
            links.push(externalLink(jobUrl, 'Job'));
        }

        const jobCell = el('td', { class: 'failure-job-name' });
        // Deliberately not an `externalLink`: upstream's job-name anchor here
        // carries no `onclick="event.stopPropagation()"` (`:964`), unlike the
        // two links in the next cell (`:957`, `:960`). The difference is
        // unobservable on this page — the row's own listener returns early on an
        // `A` target — but it is upstream's markup and is reproduced.
        const anchor = el('a', {
            href: taskPageUrl(instance.taskId, instance.retryId, testName),
            text: instance.jobName,
        });
        anchor.target = '_blank';
        jobCell.append(anchor);

        const linksCell = el('td', { class: 'view-links' });
        linksCell.append('View: ');
        links.forEach((link, i) => {
            if (i > 0) {
                linksCell.append(' ');
            }
            linksCell.append(link);
        });

        rows.push(
            el('tr', {
                class: 'failure-instance-row',
                children: [
                    el('td', { class: 'run-date', text: showDate ? instance.date : '' }),
                    jobCell,
                    // `×N` only above 1, so a task that saw the message once
                    // shows an empty cell rather than `×1`. `:965`.
                    el('td', {
                        class: 'run-count',
                        text: instance.count > 1 ? `×${instance.count.toLocaleString()}` : '',
                    }),
                    linksCell,
                ],
            })
        );
    }

    // The `<tbody>` the HTML parser would have synthesized around the rows.
    // `site/drilldown-render.ts` documents why this is not cosmetic: upstream
    // builds the table as a string and `insertAdjacentHTML` runs it through the
    // parser, which inserts one; `createElement('table').append(tr)` does not,
    // and a parsed-DOM diff sees `TABLE > TR` against `TABLE > TBODY > TR`.
    const table = el('table', {
        class: 'instance-table',
        children: [el('tbody', { children: rows })],
    });
    return el('div', { class: 'inst-block', children: [table] });
}

// =========================================================================
// Click handling
// =========================================================================

/**
 * Delegated clicks on the top-level rows. `setupClickHandlers` (`:1018-1038`).
 *
 * Only the top-level rows need delegation: they are created by the chunk filler
 * as the reader scrolls, so a listener attached at render time would have to be
 * re-attached per chunk. The sub-rows get their listeners when they are
 * inserted, in `renderSubRow`.
 */
function setupClickHandlers(): void {
    content().addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element) || target.tagName === 'A') {
            return;
        }
        // `.sub-row` is checked first, and by `closest`, so a click on a
        // sub-row's inner span does not walk up to the group row behind it.
        // Upstream's loop has the same ordering (`:1025` before `:1031`).
        if (target.closest('.sub-row') !== null) {
            return;
        }
        const row = target.closest('.marker-row');
        if (row === null || row.classList.contains('total-row')) {
            return;
        }
        const model = rowOf.get(row as HTMLElement);
        if (model !== undefined) {
            toggleGroup(model, row as HTMLElement);
        }
    });
}

// =========================================================================
// Filter / view change handlers
// =========================================================================

/**
 * `onKindFilterChange` (`old/errors.html:1042-1049`).
 *
 * The branch is the page's most important behavioural detail: a message-view row
 * is one kind, so a checkbox only shows or hides rows (and refreshes the Total),
 * while a test- or component-view row mixes kinds, so its counts and therefore
 * its rank change and it must re-group. See `buildGroupRows`.
 */
function onKindFilterChange(): void {
    updateUrlHash();
    if (view() === 'message') {
        applyFilter();
    } else {
        renderList();
    }
}

/** `onViewChange` (`old/errors.html:1051-1056`). Resets the sort to the default. */
function onViewChange(): void {
    currentSort = { ...INITIAL_SORT };
    updateUrlHash();
    renderList();
}

// =========================================================================
// Data loading
// =========================================================================

/** `loadSelectedDate` (`old/errors.html:1060-1084`). */
async function loadSelectedDate(): Promise<void> {
    const date = dateSelect().value;
    if (!date) {
        return;
    }

    try {
        statusText().textContent = 'Loading...';
        const harness = getHarnessType();
        const response = await fetchData(`${harness}-${date}-errors.json`);
        if (!response.ok) {
            // The message a reader sees for a date with no errors file, which is
            // most of them: 15 of the 21 dates in `index.json` 404 (measured
            // 2026-08-05 — only 2026-07-30 … 2026-08-04 exist).
            throw new Error(`No error/warning data for ${date}.`);
        }
        data = prepareErrors((await response.json()) as ErrorsFile);
        renderList();

        const meta = data.raw.metadata as { jobCount?: number; markerCount?: number };
        const jobs = (meta.jobCount ?? 0).toLocaleString();
        // `markerCount` (singular) is not a field the published files carry —
        // they have `markerCounts`, a per-kind object — so this reads 0 on every
        // real file. Reproduced; see the note above the divergence list.
        const markers = (meta.markerCount ?? 0).toLocaleString();
        statusText().textContent = `${jobs} test jobs · ${markers} markers`;
    } catch (error) {
        console.error('Error loading data:', error);
        data = null;
        const message = error instanceof Error ? error.message : String(error);
        replaceContent(noData(message));
        statusText().textContent = message;
    }
}

// =========================================================================
// URL state
// =========================================================================

function updateUrlHash(): void {
    hashManager?.updateHash();
}

/**
 * Applies the hash to the page. `loadFromUrlHash` (`old/errors.html:1122-1154`).
 *
 * Note this page **already** clears a stale search box — `setValue(state.q ||
 * '')` at `:1141`, with no `&& state.q` guard — so it does not have the bug
 * `failures.html` had and `site/failures.ts` fixed. Nothing to change; stated
 * because the two pages look alike here and a reviewer would check.
 *
 * The date default is the other way round from the crashes/failures pages: an
 * absent `date` means the **most recent single day**, not 21 days. See
 * `isHistoricalDate`.
 *
 * ## `#date=21days` in a bookmarked URL
 *
 * The 21-day control is not on this page (divergence 6), so there is no mode to
 * enter. Such a hash is **treated as no date at all** — the selector keeps the
 * day it is on, which at startup is the most recent — and this function then
 * calls `updateUrlHash` to rewrite the hash to that day. Chosen over silently
 * leaving `21days` in the address bar, which would leave the URL naming a view
 * the page is not in and would be re-read on the next reload. `updateUrlHash`
 * is called here rather than left to a caller because `loadSelectedDate` does
 * not update the hash.
 */
async function loadFromUrlHash(): Promise<void> {
    if (hashManager === undefined) {
        return;
    }
    const state = readUrlState(hashManager.getParams());

    // The view, validated — `#view=bogus` leaves the current one alone.
    if (state.view !== undefined) {
        viewSelect().value = state.view;
    }

    // The checkboxes. An absent `hide` means all on, which is why every box is
    // written on every hash load rather than only the named ones.
    const hidden = parseHidden(state.hide);
    for (const slug of KIND_SLUGS) {
        kindBox(slug).checked = !hidden.has(slug);
    }

    const box = document.getElementById('searchBox');
    if (document.activeElement !== box) {
        searchBoxManager.setValue(state.q ?? '');
    }

    // `#date=21days` names a mode this page does not have — see the note above
    // and divergence 6. It is dropped rather than half-applied: the selector
    // keeps whatever day it is on (the most recent, at startup) and the hash is
    // rewritten to that day below, so the URL stops claiming the 21-day view.
    const staleHistorical = isHistoricalDate(state.date);

    // Only a date the selector actually offers is applied, so a hash naming a
    // date outside the window leaves the current selection. `:1149-1152`.
    const select = dateSelect();
    if (
        !staleHistorical &&
        state.date !== undefined &&
        state.date !== '' &&
        select.value !== state.date &&
        select.querySelector(`option[value="${CSS.escape(state.date)}"]`) !== null
    ) {
        select.value = state.date;
    }

    if (staleHistorical) {
        updateUrlHash();
    }
}

// =========================================================================
// Startup
// =========================================================================

function initializeUI(): void {
    initHarnessSwitcher('Errors & Warnings');

    searchBoxManager = searchBox({
        searchBoxId: 'searchBox',
        searchClearId: 'searchClear',
        onSearch: applyFilter,
        updateUrlHash,
    });

    hashManager = initUrlHashManager({
        // `date` is always a day: upstream writes `21days` here while the
        // toggle is on, and this page has no toggle. Divergence 6.
        getState: () => ({
            date: dateSelect().value,
            q: searchBoxManager.getValue().trim(),
            view: view(),
            hide: formatHidden(disabledSlugs()),
        }),
        onHashChange: async () => {
            searchBoxManager.setNavigating(true);
            await loadFromUrlHash();
            await loadSelectedDate();
            searchBoxManager.setNavigating(false);
        },
    });

    // The seven checkboxes' `onchange="onKindFilterChange()"` attributes are in
    // the markup, which is kept byte-identical; a module has no globals, so each
    // one throws a `ReferenceError` and these listeners do the work. Divergence 1.
    for (const slug of KIND_SLUGS) {
        kindBox(slug).addEventListener('change', onKindFilterChange);
    }
    viewSelect().addEventListener('change', onViewChange);

    // Double-clicking a kind filter solos it. The two clicks of the double-click
    // first toggle the box (firing `change`, hence a re-filter each time); the
    // `dblclick` then forces the solo state and re-filters again. Upstream's
    // sequence exactly (`:1211-1223`), including its redundant `updateUrlHash`
    // before `onKindFilterChange`, which also updates it.
    document.querySelector('.marker-kind-filters')!.addEventListener('dblclick', (event) => {
        const label = (event.target as Element).closest('label.filter-checkbox');
        const box = label?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
        if (box === null || box === undefined) {
            return;
        }
        const solo = soloKind(box.id.slice('kind-'.length));
        for (const slug of KIND_SLUGS) {
            kindBox(slug).checked = !solo.has(slug);
        }
        updateUrlHash();
        onKindFilterChange();
    });

    dateSelect().addEventListener('change', () => {
        updateUrlHash();
        void loadSelectedDate();
    });
}

setupClickHandlers();

await (async () => {
    initializeUI();

    const hasData = await populateDateSelector({
        selectId: 'dateSelect',
        statusTextId: 'statusText',
        fetchData,
    });

    if (hasData) {
        const select = dateSelect();
        if (!select.value && select.options.length > 0) {
            select.selectedIndex = 0;
        }
        await loadFromUrlHash();
        await loadSelectedDate();
    }
})();

/**
 * The view model, for the browser parity harness.
 *
 * `PARITY.md` §4: the new page exposes what it decided so a comparison can be
 * made against values rather than against pixels. Deliberately includes the
 * things a DOM diff cannot see — which sort is active — and caps the row list,
 * because the mochitest message view has 35,474 rows and serializing them all
 * over CDP takes longer than the comparison.
 *
 * No `historical` field: the old page's `__view` reported the toggle's mode,
 * and this page has no toggle (divergence 6). Reporting a hardcoded `false`
 * would be asserting a constant rather than observing the page.
 */
window.__view = () => ({
    view: view(),
    sort: currentSort,
    search: searchBoxManager?.getValue() ?? '',
    hide: formatHidden(disabledSlugs()),
    totals,
    rowCount: visible.length,
    rows: visible.slice(0, 200).map((row) => ({
        name: data === null ? '' : groupName(data, row),
        count: row.count,
        tests: row.testCount,
        messages: row.msgCount,
    })),
});

export type { ErrorGroupRow, Instance, SubGroup };
