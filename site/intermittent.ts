/**
 * `intermittent.html` — the sheriff-annotated top offenders, tree-wide.
 *
 * | file | contains | tested by |
 * | --- | --- | --- |
 * | `lib/sources/intermittents.ts` | the Treeherder and Bugzilla client, shared with the CLI | `test/intermittent.test.ts` |
 * | `lib/query/intermittents.ts` | the classification and the per-day history, shared with the CLI | `test/intermittent.test.ts` |
 * | `site/intermittent-view.ts` | this page's view model — the window, the harness control, coverage prose, URL state | `test/intermittent-view.test.ts`, no DOM |
 * | this file | the renderer, the sparklines and the interactions | `test/intermittent-page.test.ts` |
 *
 * A new page, not a migration: `fx-tests intermittent` had no dashboard, which
 * is why `test/framing.test.ts` listed it under `UNCOVERED_COMMANDS`. That entry
 * moves into `FRAMING` with this page, because "there is no page here to diverge
 * from" stops being true.
 *
 * ## What it reads, and why that is unlike every other page here
 *
 * Every other page in `site/` reads a **nightly aggregate**: one artifact,
 * fetched once through the shared `fetchData`, holding a published window. This
 * page reads Treeherder's **live** endpoints, through the same
 * `lib/sources/intermittents.ts` client the CLI uses:
 *
 * - `/api/failures/` **once per day of the window**, a few at a time. These are
 *   the page's only Treeherder requests for the ranked view, and they serve two
 *   things at once: every row's sparkline, and — summed — the window ranking
 *   itself. There was a **separate whole-window request** at the front of the
 *   load, awaited before these started; it is gone, because it is exactly their
 *   sum. `rankingFromDays` in `site/intermittent-view.ts` carries the
 *   measurement against live Treeherder.
 * - Bugzilla's REST API for the candidates' summaries and resolutions, batched
 *   at 500 and fetched concurrently. A batch goes out as soon as 500 distinct
 *   bug numbers are known, which is partway through the per-day responses
 *   rather than after all of them — see `summaryDispatcher`.
 * - `{harness}-issues.json` for mochitest and xpcshell, through `fetchData`, so
 *   a path in a bug summary can be checked against a published test list. These
 *   two are the only *aggregates* the page touches, and they are the same files
 *   `issues.html` and `flaky.html` already read, so a warm cache makes them
 *   free.
 *
 * It does **not** call `/api/failuresbybug/`, which is the one request the CLI
 * makes that this page deliberately does not — the charts section says why.
 *
 * ## How `lib/` runs in a browser here
 *
 * `intermittentsClient` takes an injected `FetchLike` (`lib/sources/http.ts`),
 * because `lib/` may not call a global `fetch`. So the page passes the browser's
 * own `fetch`, wrapped only to satisfy that four-member interface. Nothing is
 * forked and nothing is reimplemented.
 *
 * `loadHarnessOfPath` takes a `DataSource`, a two-member interface. The page
 * implements it over the shared `fetchData` — see `pageSource` — rather than
 * over `httpSource`, so the `?data-source=` parameter, the CI index resolution
 * and the local `./data/` mode all keep working exactly as they do on every
 * other page. That is the injection seam the other pages use, reached through
 * the one interface `lib/` asks for.
 *
 * ## The charts, and the request that is not made
 *
 * **Each row with a bug number** gets a sparkline of that bug's own volume over
 * the window's days, so a reader can see at a glance which issues are new and
 * which stopped after a fix. Each is scaled to its own peak and labelled with
 * it; zero days are coloured by what the zero means. `sparklinePeak` and
 * `zeroDayKinds` in `site/intermittent-view.ts` carry both decisions.
 *
 * **There is no top chart.** There was one — the window's overall volume, one
 * bar a day — and it was removed after measuring the hover-highlight that was
 * meant to make it useful: on 44 of the 50 drawn rows the highlighted share is
 * under 3px of a 200px plot on more than two-thirds of the bars. `VolumeSeries`
 * in `site/intermittent-view.ts` carries the table of measurements. The per-day
 * requests are unaffected, because the sparklines are what they were really for.
 *
 * The obvious way to build a row's sparkline is `occurrencesOfBug` — what
 * `fx-tests intermittent --bug <id> --history` does, and what
 * `occurrenceHistory` in `lib/query/intermittents.ts` is written against.
 * Measured against live `trunk` over 2026-08-23..2026-09-12, that is **2.2 MB
 * and 5.4 seconds for one row**, because every occurrence carries its job's full
 * `TEST-UNEXPECTED-FAIL` log lines. Fifty rows would be over a hundred
 * megabytes.
 *
 * So the page does something cheaper that yields the same numbers: it asks
 * `/api/failures/` for **each single day**, which returns that day's whole
 * per-bug breakdown in about 8 kB (255 rows, measured on 2026-09-05). The
 * window's 21 days cost ~180 kB in total and feed every sparkline together, as
 * well as the volume sentence above the table. `historiesFromDays` in
 * `site/intermittent-view.ts` carries the table of measurements showing the two
 * paths agree bug-for-bug and day-for-day.
 *
 * ## What the page says about its own cost
 *
 * The brief this page was built to required that it be honest about scan cost
 * and never silently truncate, and there are three separate statements for it:
 *
 * - **A request plan, before anything is fetched.** `scanPlan` computes how many
 *   requests the window needs, by kind, and the progress line counts down
 *   against it — "14 of 26 requests" rather than a percentage, because the
 *   reader is deciding whether to wait.
 * - **The depth, on every load.** `coverageLine` states how many bugs were
 *   classified, which is the CLI's "depth" reduced to the number that carries
 *   it: the harness column only means something if the classification covered
 *   every candidate rather than a sample.
 * - **No cap to confess to.** The table draws **every** matching row, so there
 *   is no prefix and no "the other N are not drawn" — the row count on the
 *   coverage line is the whole list. The sparklines are drawn lazily instead,
 *   which is where the cap's real cost was; `observeSparklines` has the
 *   measurements.
 *
 * ## Numbered divergences from `fx-tests intermittent`
 *
 * 1. **The window is 21 days, where the CLI's is 7.** Both are whole numbers of
 *    weeks, which is the CLI's actual stated constraint; 21 is the window every
 *    other page here publishes. `DEFAULT_DAYS` in `site/intermittent-view.ts`.
 * 2. **The page reads one `/api/failures/` per day and the CLI's ranked list
 *    reads none.** Same numbers by a cheaper route — see the charts section.
 * 3. **No row limit, where the CLI has `DEFAULT_LIMIT`.** A terminal cannot
 *    usefully scroll a thousand rows and a browser can, so the CLI keeps its
 *    limit and the page renders the whole selection. The cost that a cap was
 *    really avoiding is the per-row charts, and those are lazy now rather than
 *    absent. The CLI's default is unchanged.
 * 4. **The coverage prose is one line, where the CLI prints several
 *    sentences.** A terminal prints once and has to say everything in words; a
 *    page has a title, a column header and the rows doing that work already.
 *    `coverageLine` records what was kept and why.
 *
 * **The harness control costs no request**, and that is worth stating because
 * the CLI's module header still describes `--harness` as "a client-side scan at
 * one request per candidate bug". That describes an earlier implementation:
 * `scanBugs` classifies the whole ranking synchronously from summaries that were
 * already fetched, so switching the dropdown re-filters rows that are in memory.
 * `HARNESS_OPTIONS` records this.
 */

import {
    type BugFailureCount,
    type BugInfo,
    type DayRange,
    type IntermittentsClient,
    inPool,
    intermittentsClient,
} from '../lib/sources/intermittents.ts';
import type { BugDrilldown } from '../lib/query/intermittents.ts';
import type { FetchLike, FetchLikeResponse } from '../lib/sources/http.ts';
import {
    type DataFileName,
    type DataSource,
    DataFetchError,
    DataFileNotFoundError,
} from '../lib/sources/source.ts';
import {
    type HarnessSelector,
    type OccurrenceDay,
    type RankedIntermittent,
    type ScanResult,
    loadHarnessOfPath,
    scanBugs,
    selectHarness,
    summariseBug,
} from '../lib/query/intermittents.ts';
import {
    type IntermittentRow,
    type OccurrenceJob,
    type ScanPlan,
    type VolumeSeries,
    DEFAULT_DAYS,
    DEFAULT_TREE,
    DEFAULT_WINDOW,
    HARNESS_OPTIONS,
    JOB_NAMES_TITLE,
    TITLE_SUFFIX,
    annotationsTooltip,
    bugUrl,
    coverageLine,
    daysOfWindow,
    documentTitle,
    drilldownCountLine,
    drilldownErrorLine,
    drilldownLoadingLine,
    drilldownSections,
    emptySelectionLine,
    harnessValue,
    historiesFromDays,
    jobsByLine,
    parseHarness,
    parseWindowDays,
    progressLine,
    rankingFromDays,
    readUrlState,
    scanPlan,
    sparklinePeak,
    sparklinePeakLabel,
    sparklineVisible,
    tableRows,
    volumeLine,
    volumeSeries,
    windowNote,
    windowOf,
    windowScopeLine,
    writeUrlState,
    zeroDayKinds,
} from './intermittent-view.ts';
import {
    profilerFrontEndUrl,
    resolveProfilerOrigin,
    resourceUsageProfileUrl,
    treeherderJobUrl,
    treeherderPushUrl,
} from '../lib/links.ts';
import { el, externalLink } from './drilldown-render.ts';
import { testRowLink } from './test-link.ts';

/**
 * The slice of Chart.js this page uses.
 *
 * Read off `window` rather than declared as a global `const Chart`, for the
 * reason `site/issues.ts` and `site/flaky.ts` both record: `tsconfig.site.json`
 * compiles all of `site/**` as one program, so a second global declaration of
 * the same name is a redeclaration error however compatible the two shapes are.
 */
interface ChartJs {
    new (canvas: HTMLCanvasElement, config: Record<string, unknown>): { destroy(): void };
    getChart(canvas: HTMLCanvasElement): { destroy(): void } | undefined;
}

function chartJs(): ChartJs | undefined {
    return (window as unknown as { Chart?: ChartJs }).Chart;
}

/**
 * The colour the sparkline's line and fill draw in.
 *
 * **One hue, because a sparkline is one series.** It plots one bug's
 * annotations per day and has no second series to tell apart, so there is no
 * categorical palette here and no legend — the column header names what is
 * plotted. The zero-day markers are a *status* channel over the top of it, not
 * a second series; `ZERO_DAY_COLOURS` records that distinction.
 *
 * The same orange `site/flaky.ts` uses for flakiness, and for the reason
 * recorded there: a sheriff annotation is a nuisance to be burned down, and red
 * is reserved on these dashboards for something broken. Reusing that page's
 * value rather than picking a new one is also what keeps "this is the flakiness
 * colour" true across the site.
 *
 * Validated with the `dataviz` skill's checker rather than by eye, as one slot
 * against the light surface: lightness band PASS, chroma floor PASS, and the
 * CVD and normal-vision pair checks are `n/a` for the line itself because a
 * one-series palette has no adjacent pair to separate. The one finding is a
 * contrast WARN — 2.70:1 against white, measured with the skill's `contrast()`
 * — which the skill says obligates visible labels or a table view rather than
 * being dismissable. Both are present: every day's value is in the tooltip,
 * every sparkline sits in a table row whose `Annotations` cell is the window
 * total and which carries a `peak N/day` label, and the table *is* the page. The
 * line is not carrying a number the reader can only get by eyedropping it.
 */
const CHART_COLOUR = '#e8834a';

// `CHART_FILL` was here — the area wash under the line chart. Bars have no area
// to fill: the mark *is* the magnitude, so the hue is `CHART_COLOUR` at full
// strength and the skill's ~10% area-fill spec no longer applies.

// --- page state -----------------------------------------------------------

/** The client every live request goes through. Built once by `start`. */
let client: IntermittentsClient;
/** The `DataSource` the two published test lists are read through. */
let source: DataSource;

/**
 * The day the window ends on.
 *
 * A variable rather than a call to `new Date()` at each use, and settable by
 * `start`, for two reasons. A test needs the window pinned or it cannot use a
 * recorded fixture at all: the API is queried by date range, so a fixture
 * recorded in August answers nothing when the page asks about today. And within
 * one load every window calculation has to agree — a page that read the clock
 * twice would, at midnight UTC, rank one window and chart another.
 */
let today = new Date();

/** The window the page is showing. */
let range: DayRange = windowOf(DEFAULT_DAYS, today);
/** How many days that is, as the hash asked for it. */
let windowDays = DEFAULT_DAYS;
/** The repository or repo group. */
let tree = DEFAULT_TREE;
/** The harness selection, or `undefined` for every bug. */
let harness: HarnessSelector | undefined;

/** The classified ranking, before any harness selection. */
let scan: ScanResult | null = null;
/** Each bug's annotations per day, from the per-day rankings. */
let histories = new Map<number, OccurrenceDay[]>();
/** The window's overall volume, one entry a day. */
let volume: VolumeSeries | null = null;
/**
 * One day's `/api/failures/` answer, kept across window changes.
 *
 * ## Why this is a safe cache, and why it was not there before
 *
 * The page owner's report: "when switching the value of the time window drop
 * down, it seems we redo from scratch all the per-day requests, even though I
 * would expect at a minimum 7 of these to be already available locally." That
 * was exactly right — `reload` cleared everything and `loadDays` refetched every
 * day of the new window.
 *
 * Keyed by **tree and day**, because the request is
 * `/api/failures/?startday=D&endday=D&tree=T` and nothing else varies. A past
 * day's annotations are immutable, so a cached answer cannot go stale; the
 * window is only ever a different *selection* of days, never different data for
 * one day.
 *
 * **Today is cached too**, and that is a deliberate limit rather than an
 * oversight: sheriffs are still annotating the current day, so its count can
 * grow during a session. Re-fetching it on every window change would cost one
 * request to refresh a number the reader did not ask to refresh, and a reload
 * gets the fresh value. The alternative — evicting today on each switch — was
 * rejected because it makes 21 -> 7 cost a request, which is the case the owner
 * asked to be free.
 *
 * Not the *bug drilldown* cache, which `reload` still clears: that one is keyed
 * by bug and holds occurrences for a whole range, so a new window genuinely
 * invalidates it. These two caches answer different questions and only one of
 * them survives a window change.
 */
const dayCache = new Map<string, { bugs: Map<number, number>; total: number }>();

/** The `dayCache` key for a day of the current tree. */
function cacheKey(date: string): string {
    return `${tree} ${date}`;
}

/** The rows drawn, for the parity harness. */
let renderedRows: IntermittentRow[] = [];

/**
 * Which bugs are expanded, by bug number.
 *
 * **Keyed on the bug number, never on a row index.** `site/try.ts`'s divergence
 * 5 records what keying on an array index costs: the next render writes a
 * different row into that slot and the open panel belongs to the wrong thing.
 * A bug number survives a re-sort, a harness change and a reload.
 */
const expanded = new Set<number>();

/**
 * Each bug's drill-down once fetched, by bug number — the cache.
 *
 * `occurrencesOfBug` is **2.2 MB and 5.4 s for one bug** (measured on live
 * trunk), so it is fetched once per bug and kept for the life of the window.
 * Collapsing and re-expanding is then free, which is what makes the row safe to
 * click twice.
 *
 * `'loading'` while a fetch is in flight and an `Error` when one failed, so the
 * three states a panel can be in are one lookup rather than three parallel
 * maps that can disagree.
 */
const drilldowns = new Map<number, DrilldownState | 'loading' | Error>();

/**
 * Which failure messages are expanded, as `bugId\nmessage`.
 *
 * Page-level rather than per-panel, so a message a reader opened stays open
 * across the re-renders a harness change or the per-day data landing cause —
 * the same promise `expanded` makes for rows. Keyed by the message **text**: see
 * `itemElement` for why an index key would be a bug here.
 */
const expandedLines = new Set<string>();

/**
 * How many jobs a failure message lists before offering the rest.
 *
 * Measured in a real browser against live `trunk`: the top bug's most common
 * message carried **573** jobs, which is ~570 rows between the reader and the
 * next section. 12 is enough to see the shape of the configurations involved —
 * which is what the list is for — while leaving the panel scannable.
 *
 * Larger than the CLI's `DRILLDOWN_ROWS` (10) for the reason every other cap on
 * this page diverges: a terminal prints once and a browser scrolls.
 */
const JOB_LIST_ROWS = 12;

/** Which job lists the reader has asked to see in full, by the same key. */
const expandedJobLists = new Set<string>();

/**
 * The profiler origin, from this page's own `?profiler=` parameter.
 *
 * `lib/` must not read `window`, so the override is resolved here and passed in
 * — the seam `profilerFrontEndUrl` documents. Read once at module scope because
 * it cannot change without a reload.
 */
const profilerOrigin = resolveProfilerOrigin(
    new URLSearchParams(window.location.search).get('profiler')
);

/**
 * An expanded bug's tallies **and** the jobs behind each failure message.
 *
 * The occurrences are kept rather than discarded after `summariseBug`, which is
 * what makes the failure-message level free: expanding a message regroups this
 * array, and makes no request. See `jobsByLine`.
 */
interface DrilldownState {
    summary: BugDrilldown;
    /** Jobs per distinct `TEST-UNEXPECTED-FAIL` line. */
    jobs: Map<string, OccurrenceJob[]>;
}

let hashManager: ReturnType<typeof initUrlHashManager>;

const byId = (id: string): HTMLElement => document.getElementById(id)!;

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

// --- the seams `lib/` is given --------------------------------------------

/**
 * The browser's `fetch`, as the four-member interface `lib/` asks for.
 *
 * `FetchLike` is deliberately narrower than the DOM's `fetch`
 * (`lib/sources/http.ts` says so), so this is an adaptation rather than a cast:
 * the fields are named explicitly, which is what makes it obvious that nothing
 * else of `Response` is relied on.
 */
function browserFetch(url: string): Promise<FetchLikeResponse> {
    return fetch(url).then((response) => ({
        ok: response.ok,
        status: response.status,
        url: response.url,
        arrayBuffer: () => response.arrayBuffer(),
    }));
}

/**
 * A `DataSource` over the page's own `fetchData`.
 *
 * `loadHarnessOfPath` needs one, and the two files it wants are published CI
 * artifacts — exactly what `fetchData` resolves. Implementing the interface over
 * it, rather than reaching for `httpSource`, is what keeps `?data-source=`,
 * the CI index resolution and the local `./data/` mode working here as they do
 * on every other page: those are `fetch-utils.js`'s job, and duplicating that
 * resolution in the page would be a second answer to a question already
 * answered.
 *
 * The two error types are distinguished because the interface says they mean
 * different things, and a caller that collapsed them would report an outage as
 * "this data was never published".
 */
function pageSource(): DataSource {
    return {
        name: 'page',
        async fetch(name: DataFileName): Promise<Uint8Array> {
            const response = await fetchData(name.filename);
            if (response.status === 404) {
                throw new DataFileNotFoundError(name);
            }
            if (!response.ok) {
                throw new DataFetchError(name, `HTTP ${response.status}`);
            }
            return new Uint8Array(await response.arrayBuffer());
        },
    };
}

// --- loading --------------------------------------------------------------

/**
 * Fetches everything the window needs, reporting progress against a plan.
 *
 * ## What starts first, and why that is now the per-day requests
 *
 * There used to be a whole-window `/api/failures/` request at the front of
 * this, awaited before anything else began, because it was what named the
 * candidate bugs. It is gone: `rankingFromDays` in `site/intermittent-view.ts`
 * carries the measurement showing the window ranking is exactly the sum of the
 * per-day ones the page already fetches, so the page now starts the **21
 * per-day requests immediately** and derives the ranking from them.
 *
 * The two published **test lists** depend on nothing at all, so they start in
 * the same tick.
 *
 * The candidates' **summaries** looked like the one thing that could not, since
 * a Bugzilla batch needs bug numbers and those come from the ranking. But it
 * needs only **500** of them, and the per-day responses reach 500 distinct ids
 * after three of the twenty-one days — so the batches overlap the days rather
 * than following them. `summaryDispatcher` carries the measurement.
 *
 * Measured in headless Chrome against live Treeherder, ten runs of each build
 * interleaved so both sample the same network: the median load is 4,707 ms
 * before and **4,429 ms** after, of which the part after the last per-day
 * response is 977 ms before and **839 ms** after, and the same 39 requests are
 * made either way. **The win is modest** — ~280 ms of a ~4.5 s load, because the
 * 21 per-day responses dominate it and this change cannot touch them. What it
 * removes is the serialisation *after* them.
 *
 * **The table is still drawn before the sparklines are.** `render` is called as
 * soon as the classification can be computed; the per-day data the charts read
 * is by then already in hand, since it is what the ranking came from.
 *
 * A rejected `loadDays` is **caught rather than left to reject** where its
 * result is not the thing being awaited. It swallows a failed day internally,
 * so a rejection here is the pool itself failing — and since the ranking now
 * comes from the days, that is a load with no ranking, which `catch` in `start`
 * reports as the error it is.
 */
async function load(): Promise<void> {
    hideError();
    // The counter and the plan are held in one object rather than as two `let`s,
    // so that `loadDays` advances the *same* numbers this line reports. Two
    // copies is how a progress bar comes to sit at "3 of 36" through twenty-one
    // requests, which is the failure this whole block exists to avoid.
    // **Counted once, and reused for the re-plan below.** The pool caches each
    // day as it lands, so recounting after the load answers 0 — which made the
    // last progress line read "23 of 5 requests", a total recomputed as
    // 2 lists + 3 batches + 0 days while `done` had reached 23.
    const days = daysOfWindow(range).filter((date) => !dayCache.has(cacheKey(date))).length;
    const progress = {
        done: 0,
        // `candidates: 0` — the batch count is not known until the ranking has
        // landed, so the first line under-reports the total. A plan that grows
        // is more honest than one that is right only in hindsight.
        plan: scanPlan(days, 0),
    };
    // **One writer for the line, with several phases able to run at once.** Two
    // phases overlapping want to name what each is doing; a line each would
    // flicker between them and the reader would see whichever wrote last rather
    // than what the page is waiting on. So each phase sets its own slot and the
    // line joins the slots that are still outstanding — the count in it is the
    // shared `progress.done` either way, which is the number that actually
    // answers "how much longer".
    const phases = new Map<string, string>();
    const step = (what: string): void => {
        setStatusText(progressLine(progress.done, progress.plan, what));
    };
    const phase = (slot: string, what: string | null): void => {
        if (what === null) {
            phases.delete(slot);
        } else {
            phases.set(slot, what);
        }
        step([...phases.values()].join('; '));
    };

    // Both started in this tick; neither waits on the other. The days are what
    // the ranking is derived from, so they are on the critical path now and
    // start with nothing in front of them.
    //
    // `Promise.all`, not two separate awaits, and that is what keeps the console
    // clean: if `loadDays` rejects while `harnessPending` is awaited on the line
    // after, the second rejection is never awaited at all and an unawaited
    // rejected promise is an `unhandledrejection` — which `docs/DEPLOY.md` §3
    // checks for. `Promise.all` observes both, rejecting with the first, so
    // whichever fails first is the error `start` reports and neither is left
    // unhandled.
    //
    // The dispatcher is passed into `loadDays` so its batches start as the days
    // land rather than after the ranking is complete; `summaryDispatcher`
    // carries the measurement.
    const dispatcher = summaryDispatcher(
        progress,
        (what) => phase('scan', what),
        (bugs) => client.bugSummaries(bugs)
    );

    phase('lists', 'Reading the published test lists');
    const [ranking, harnessOfPath] = await Promise.all([
        loadDays(progress, (what) => phase('days', what), dispatcher),
        loadHarnessOfPath(source),
    ]);
    // The two test lists, counted once both have landed. `loadDays` counts its
    // own days as they complete.
    progress.done += 2;
    phase('days', null);
    phase('lists', null);

    const candidates = ranking
        .filter((row) => row.bugId !== null)
        .map((row) => row.bugId as number);
    progress.plan = scanPlan(days, candidates.length);

    // Offered in full, though `loadDays` already offered each day's bugs: this
    // is the list the classification reads, so passing it is what guarantees
    // nothing the ranking needs was missed. Already-requested ids are skipped.
    dispatcher.offer(candidates);
    const summaries = await dispatcher.finish();
    phase('scan', null);

    // Classification is synchronous and covers every candidate: there is no
    // per-bug request, so there is nothing to economise on by stopping early.
    scan = scanBugs({ ranking, summaries, harnessOfPath });
    render();
    // The status slot is the window's volume now, not a request count: the page
    // owner read "27 requests, 2026-08-23 to 2026-09-12" and found it unclear,
    // and the honest-depth reporting it was doing has served its purpose now
    // that the load is fast. `renderStatusLine` fills it from `volume`, which
    // `loadDays` above is what populates — along with the ranking, which is why
    // there is no longer a separate await for the charts' data here.
    renderStatusLine();
}
/**
 * How many bug numbers go in one Bugzilla request.
 *
 * 500, matching `BUG_BATCH_SIZE` in `lib/sources/intermittents.ts` but not
 * imported from it: a size computed from the same constant the client batches by
 * could never disagree with it, so the test asserting the URLs a real run
 * produces would be right by construction. Measured against live Bugzilla, the
 * 414 boundary is between 1,000 ids (8,084 characters, HTTP 200) and 1,100
 * (8,884, HTTP 414); 500 sends a 4,115-character URL.
 */
export const PAGE_BUG_BATCH = 500;

/**
 * Bugzilla summary batches, sent as the bug numbers become known.
 *
 * The ranking is the sum of 21 per-day `/api/failures/` responses, so the set of
 * bug numbers grows as they land — and it grows fast, because the same few
 * hundred bugs recur across days. Measured against live `trunk` on a default
 * 21-day window: the 500th distinct id is known at **676 ms**, the 1,000th at
 * 2,386 ms, and the last per-day response lands at 2,973 ms. So the first 500
 * are in hand after **three of twenty-one days**, and two of the window's three
 * batches can be in flight before the ranking exists. Before this they were
 * not: the first Bugzilla request went out a median of 10 ms *after* the last
 * per-day response.
 *
 * **Deduplication is required, not a nicety.** Those recurring bugs are why: a
 * day's ids are offered as that day lands, so without `requested` the same bug
 * would be asked for once per day it appeared on.
 *
 * `requested` lives for one load. A window switch builds a new dispatcher and
 * re-asks Bugzilla for its own candidates; this batches requests, it does not
 * cache summaries.
 */
export function summaryDispatcher(
    progress: { done: number; plan: ScanPlan },
    step: (what: string | null) => void,
    /** Injected so a test can drive the 500 boundary; the fixture has 14 bugs. */
    fetchBatch: (bugs: readonly number[]) => Promise<Map<number, BugInfo>>
) {
    const requested = new Set<number>();
    const queued: number[] = [];
    const batches: Promise<Map<number, BugInfo>>[] = [];

    const send = (bugs: number[]): void => {
        batches.push(fetchBatch(bugs));
        step(
            `Reading ${requested.size.toLocaleString('en-US')} bug summaries` +
                ` (${batches.length} ${batches.length === 1 ? 'batch' : 'batches'})`
        );
    };

    return {
        /** Adds ids, sending a request for each full batch they complete. */
        offer(bugs: Iterable<number>): void {
            for (const bug of bugs) {
                if (!requested.has(bug)) {
                    requested.add(bug);
                    queued.push(bug);
                }
            }
            while (queued.length >= PAGE_BUG_BATCH) {
                send(queued.splice(0, PAGE_BUG_BATCH));
            }
        },

        /** Flushes the partial batch and merges every response. */
        async finish(): Promise<Map<number, BugInfo>> {
            if (queued.length > 0) {
                send(queued.splice(0));
            }
            // `Promise.all` attaches a handler to each promise as it is called,
            // so a batch that fails after another already has is still observed
            // rather than becoming an `unhandledrejection`.
            const maps = await Promise.all(batches);
            // Counted on completion, like the days, so the number only ever
            // moves forward.
            progress.done += batches.length;
            const found = new Map<number, BugInfo>();
            for (const map of maps) {
                for (const [bug, info] of map) {
                    found.set(bug, info);
                }
            }
            return found;
        },
    };
}

/**
 * How many per-day requests are in flight at once.
 *
 * **This used to be 1** — the loop below awaited each day in turn — and a 21-day
 * window therefore paid Treeherder's round trip twenty-one times in series,
 * which was most of the page's load time after the ranking had landed.
 *
 * Concurrent now, but **capped rather than unbounded**, for the reason the
 * serial version gave and which still holds: twenty-one simultaneous requests to
 * a shared service from every open tab is a burst this page has no need for. The
 * days are independent of each other and of everything else on the page, so a
 * small pool takes nearly all of the available speed-up — 21 requests in 6 waves
 * of 4 instead of 21 waves of 1 — while the number in flight stays in the range
 * a browser would allow to one origin anyway.
 *
 * 4, matching `BUG_REQUEST_CONCURRENCY` in `lib/sources/intermittents.ts`, so
 * there is one answer on this page to "how hard do we lean on somebody else's
 * API" rather than two.
 */
const DAY_REQUEST_CONCURRENCY = 4;

/**
 * One `/api/failures/` per day — the window's ranking *and* every sparkline.
 *
 * Run through a bounded pool — see `DAY_REQUEST_CONCURRENCY`. The progress line
 * counts days as they **complete** rather than as they start, because with
 * several in flight "reading day 7" would name whichever request was issued last
 * rather than what the page is waiting for; a completed count is a number that
 * only moves forward.
 *
 * Returns the summed ranking (`rankingFromDays`), which is what replaced the
 * whole-window `/api/failures/` request this function's results used to sit
 * behind.
 *
 * A day that fails is **skipped, not fatal**, and what that costs grew with
 * this change: it used to cost one bar and some sparkline resolution, with the
 * ranking unaffected because the ranking came from its own request. Now the
 * ranking is these responses, so a missing day is also missing from every
 * count in it. The alternative is failing the whole page for one day of
 * twenty-one, which throws away the twenty that arrived, and the shortfall is
 * not silent: `volumeSeries` totals only the days that landed, so the
 * annotations figure beside the window dropdown is short by the same amount the
 * counts are.
 *
 * The catch is **inside** the pooled function, which is what keeps that promise:
 * `inPool` rejects on the first rejection like `Promise.all`, so a throw that
 * escaped here would lose the other twenty days as well.
 *
 * It also **feeds the Bugzilla batches while it runs**: each day's bug numbers
 * go to `summaries` as that day lands. See `summaryDispatcher`.
 */
async function loadDays(
    progress: { done: number; plan: ScanPlan },
    /** Names this phase on the progress line; `null` clears it. */
    step: (what: string | null) => void,
    /** Deduplicates, so offering an id on every day it appears on is fine. */
    summaries: { offer: (bugs: Iterable<number>) => void }
): Promise<BugFailureCount[]> {
    const dates = daysOfWindow(range);
    const perDay = new Map<string, Map<number, number>>();
    const totals = new Map<string, number>();
    // Only the days this window needs that are not already held. Switching
    // 7 -> 21 therefore fetches 14 days, and 21 -> 7 fetches none.
    const wanted = dates.filter((date) => !dayCache.has(cacheKey(date)));
    // Before the pool, so a window served entirely from `dayCache` — 21 -> 7,
    // which fetches nothing — still has its batches in flight in this tick.
    for (const date of dates) {
        const cached = dayCache.get(cacheKey(date));
        if (cached !== undefined) {
            summaries.offer(cached.bugs.keys());
        }
    }
    let finished = 0;
    if (wanted.length > 0) {
        step(`Ranking annotated bugs on ${tree} over ${wanted.length} days`);
    }
    await inPool(wanted, DAY_REQUEST_CONCURRENCY, async (date) => {
        try {
            const rows = await client.rankBugs(tree, { start: date, end: date });
            const bugs = new Map<number, number>();
            let total = 0;
            for (const row of rows) {
                total += row.count;
                if (row.bugId !== null) {
                    bugs.set(row.bugId, row.count);
                }
            }
            dayCache.set(cacheKey(date), { bugs, total });
            // This day's contribution to the union, offered before the next day
            // is awaited. A day that threw offers nothing, which is consistent
            // with it being absent from the ranking too.
            summaries.offer(bugs.keys());
        } catch {
            // Not cached, so a later window retries it rather than inheriting a
            // gap for the rest of the session. Every sparkline reads this day as
            // zero and the volume total is short by it, rather than the page
            // failing — which is the pre-existing behaviour.
        }
        progress.done++;
        finished++;
        step(`Read ${finished} of ${wanted.length} days`);
    });
    // Assembled from the cache rather than from this run's responses, so a day
    // an earlier window fetched counts exactly as one fetched just now.
    for (const date of dates) {
        const cached = dayCache.get(cacheKey(date));
        if (cached !== undefined) {
            perDay.set(date, cached.bugs);
            totals.set(date, cached.total);
        }
    }
    histories = historiesFromDays(perDay, range);
    volume = volumeSeries(totals, range);
    // The slot is cleared so the line does not keep naming a finished phase
    // while another is still outstanding.
    step(null);
    return rankingFromDays(perDay, totals);
}

// --- rendering ------------------------------------------------------------

/** Draws the whole page from the state above. */
function render(): void {
    if (scan === null) {
        return;
    }
    const selected = selectHarness(scan.rows, harness);
    renderedRows = tableRows(selected, histories);

    renderCoverage();
    renderStatusLine();
    renderTable();
    observeSparklines();
}

/**
 * The line beside the window dropdown: the volume, the scope, the coverage.
 *
 * Everything the page says about what it is showing now sits here, which is the
 * page owner's arrangement rather than one of mine: the volume figure and the
 * harness-scoped count "should be next to the window dropdown, instead of the
 * rather unclear '27 requests, …'".
 *
 * Three parts, `·`-separated as this site's status lines are:
 *
 * - `36,240 annotations over 21 days`, carrying a `title` that explains the
 *   untriaged annotations the table cannot show (`annotationsTooltip`). The
 *   tooltip is what keeps the excluded population reachable now that the prose
 *   naming it is gone.
 * - `trunk, 2026-08-23 to 2026-09-12` — the tree and the window's ends, which
 *   the removed `<h2>` used to carry and nothing else did.
 * - `428 of 1,172 bugs are for mochitests`, the coverage line, when a harness is
 *   selected.
 *
 * The volume part is absent until the per-day requests land, so the line grows
 * rather than showing a zero that is about to change.
 */
function renderStatusLine(): void {
    const target = byId('status-text');
    target.textContent = '';
    if (volume !== null && scan !== null) {
        target.append(
            el('span', {
                class: 'annotations-total',
                text: volumeLine(volume),
                title: annotationsTooltip(scan.coverage),
            })
        );
        target.append(document.createTextNode(' · '));
    }
    target.append(document.createTextNode(windowScopeLine(tree, range)));
    // The row count, and — when a harness is selected — what separates it from
    // the window's total, in the owner's own phrasing ("428 of 1,172 bugs are
    // for mochitests"). Always present, because "how many rows are below this"
    // is the size of the problem and the table itself does not state it.
    if (scan !== null) {
        target.append(
            document.createTextNode(
                ` · ${coverageLine(scan.coverage, harness, renderedRows.length)}`
            )
        );
    }
}

/**
 * The window note, when the window is not a whole number of weeks.
 *
 * This used to also draw the coverage line into `#coverage`. That line moved up
 * beside the window dropdown (`renderStatusLine`) on the page owner's
 * instruction, so what is left is the caveat — which is a warning box about the
 * numbers rather than a statement of them, and belongs above the table where a
 * reader meets it before reading anything it qualifies.
 */
function renderCoverage(): void {
    const note = windowNote(windowDays);
    byId('window-note').textContent = note ?? '';
    byId('window-note').style.display = note === null ? 'none' : '';
}

/**
 * How many columns the table has, for the expanded panel's `colSpan`.
 *
 * A constant beside the header rather than `row.cells.length` at use, because
 * the panel is built before it is inserted and has no row to count. Asserted
 * against the rendered header in `test/intermittent-page.test.ts`, so adding a
 * column without updating this fails rather than drawing a short panel.
 */
const TABLE_COLUMNS = 5;

/** The ranked table. */
function renderTable(): void {
    const target = byId('ranking-table');
    target.textContent = '';
    if (scan === null) {
        return;
    }
    if (renderedRows.length === 0) {
        target.append(
            el('div', { class: 'no-data', text: emptySelectionLine(harness, scan.coverage) })
        );
        return;
    }
    const table = el('table', { class: 'ranking' });
    table.append(
        el('thead', {
            children: [
                el('tr', {
                    children: [
                        el('th', { class: 'col-count', text: 'Annotations' }),
                        el('th', { class: 'col-chart', text: 'Per day' }),
                        el('th', { class: 'col-bug', text: 'Bug' }),
                        el('th', { class: 'col-assignee', text: 'Assignee' }),
                        // One header for one cell, where this was `Test` and
                        // `Failure`: the two are stacked in a single column now,
                        // which is what stopped the path and its icons wrapping.
                        el('th', { class: 'col-test', text: 'Test and failure' }),
                    ],
                }),
            ],
        })
    );
    const body = el('tbody');
    for (const row of renderedRows) {
        body.append(rowElement(row));
        // A row the reader had open stays open across a re-render — a harness
        // change, or the per-day data landing. The panel is rebuilt from the
        // cache, so it costs no request.
        if (expanded.has(row.bug.bugId)) {
            body.append(panelRow(row.bug.bugId));
        }
    }
    table.append(body);
    target.append(table);
    // No "showing the top N of M" note, because there is no longer a top N:
    // every matching row is in the table above. The row count is on the
    // coverage line, which is the number a reader wants either way.
}

/**
 * One row: the count, its sparkline, the bug, the test and the failure.
 *
 * A **resolved** bug gets `class="resolved"` on the `<tr>`, which strikes the
 * bug link and the failure text through (see the stylesheet for what is
 * deliberately *not* struck), plus the resolution word beside the bug number and
 * the full Bugzilla state in the row's `title`. Three channels for one fact,
 * because it changes what the reader should do about the row: the bug is closed
 * and the test is still failing, so this is a fix that did not hold or a bug
 * closed too early — not a triage queue item.
 */
function rowElement(row: IntermittentRow): HTMLElement {
    const { bug } = row;
    const resolved = bug.resolution !== '';
    const element = el('tr', {
        id: rowId(bug.bugId),
        class: resolved ? 'ranking-row resolved' : 'ranking-row',
        children: [
            // The count, and under it the sparkline's peak. The label moved out
            // of the chart cell on the page owner's instruction — it "could go
            // on a second line under the annotation count, reducing the total
            // height of the chart cell content" — and the reason it exists is
            // unchanged: per-row scaling hides magnitude, so the top of the line
            // has to be stated somewhere. See `sparklinePeak`.
            el('td', {
                class: 'col-count',
                children: [
                    el('div', { class: 'count-total', text: formatNumber(bug.count) }),
                    ...(sparklineVisible(row.history)
                        ? [el('div', { class: 'count-peak', text: sparklinePeakLabel(row.history) })]
                        : []),
                ],
            }),
            el('td', {
                class: 'col-chart',
                children: sparklineCell(row),
            }),
            el('td', {
                class: 'col-bug',
                children: [
                    externalLink(bugUrl(bug.bugId), String(bug.bugId), 'bug-link'),
                    // The word itself, not only the strike: `FIXED` and
                    // `WONTFIX` are struck through identically but mean
                    // different things to somebody deciding whether to expect
                    // the failures to stop.
                    ...(resolved
                        ? [el('span', { class: 'resolution-tag', text: bug.resolution })]
                        : []),
                ],
            }),
            assigneeCell(bug),
            testAndFailureCell(bug),
        ],
    });
    if (resolved) {
        // Both fields, in Bugzilla's own words: `status` distinguishes
        // `RESOLVED` from `VERIFIED` and `CLOSED`, which the one-word tag
        // cannot. The tooltip is the legible-somewhere requirement the brief
        // asks for, over and above the strike.
        element.title = `Bug ${bug.bugId} is ${bug.status} ${bug.resolution} in Bugzilla, and was still being annotated in this window.`;
    }
    // Expand on click, the way `issues.html` and `flaky.html` expand theirs.
    // `aria-expanded` and `role` because a `<tr>` that responds to a click is a
    // control, and a reader on a screen reader has nothing else to go on.
    element.classList.add('expandable');
    element.setAttribute('role', 'button');
    element.setAttribute('aria-expanded', String(expanded.has(bug.bugId)));
    element.addEventListener('click', (event) => {
        // The links and the 📋 button inside the row are **not** the row.
        // `site/test-link.ts` already calls `stopPropagation`, so this is the
        // belt to that braces: an anchor or a button anywhere in the row is its
        // own target, which keeps "click the path" from also toggling the panel.
        // That regression is the owner's original complaint on try.html.
        const target = event.target as HTMLElement | null;
        if (target?.closest('a, button') !== null && target?.closest('a, button') !== undefined) {
            return;
        }
        void toggleRow(bug.bugId);
    });
    return element;
}

/**
 * Opens or closes one bug's panel, fetching its occurrences the first time.
 *
 * **Only the one row is re-rendered**, not the whole table: the table is now
 * unbounded at ~1,170 rows, and rebuilding it would destroy and redraw every
 * sparkline on screen for a click that changed one row. That is the opposite of
 * what `site/flaky.ts` does — it re-renders wholesale, and its comment says why
 * (its sort order owns the row order) — and the difference is that a panel here
 * does not move any other row.
 *
 * The fetch is awaited *after* the panel is on screen, so the loading state is
 * visible rather than the row appearing to hang.
 */
/**
 * The run index per job id, or an empty map if Treeherder would not say.
 *
 * A failed `/api/jobs/` lookup must not fail the panel: the tallies, the job
 * names and the failure messages are all already fetched and are what the panel
 * is mostly for. What is lost is the profile links, which `jobLinks` omits for a
 * `null` run rather than guessing — so the degradation is "no profile link"
 * rather than "a link to the wrong run".
 */
async function runIdsOrNone(jobIds: readonly number[]): Promise<Map<number, number>> {
    try {
        return await client.runIdsOfJobs(jobIds);
    } catch {
        return new Map();
    }
}

async function toggleRow(bugId: number): Promise<void> {
    if (expanded.has(bugId)) {
        expanded.delete(bugId);
        syncRow(bugId);
        return;
    }
    expanded.add(bugId);
    const cached = drilldowns.get(bugId);
    // Already fetched, or already in flight from a click that has not landed
    // yet: either way there is nothing to request. This is what makes a second
    // expand free, and what stops two fast clicks from racing two fetches.
    if (cached !== undefined && cached !== 'loading') {
        syncRow(bugId);
        return;
    }
    if (cached === 'loading') {
        syncRow(bugId);
        return;
    }
    drilldowns.set(bugId, 'loading');
    syncRow(bugId);
    try {
        const occurrences = await client.occurrencesOfBug(tree, range, bugId);
        // **The run index, resolved rather than assumed.** `occurrencesOfBug`
        // leaves `runId` null — `/api/failuresbybug/` carries only `task_id` —
        // and a task whose first run ended in `exception` has its annotated
        // failure in run 1. So a profile link built on a guessed run 0 fetches
        // the wrong artifact or none. One extra batched request buys a correct
        // link for every job; a job Treeherder does not answer for keeps
        // `runId: null` and is rendered without a profile link rather than with
        // a wrong one.
        const runIds = await runIdsOrNone(occurrences.map((row) => row.jobId));
        const withRuns = occurrences.map((row) => ({
            ...row,
            runId: runIds.get(row.jobId) ?? null,
        }));
        drilldowns.set(bugId, {
            summary: summariseBug(bugId, withRuns),
            jobs: jobsByLine(withRuns),
        });
    } catch (error) {
        // Kept as the error rather than deleted, so the panel can say what went
        // wrong instead of springing shut — a row that closes itself on click is
        // indistinguishable from a broken handler.
        drilldowns.set(bugId, error as Error);
    }
    // The row may have been re-rendered, or the reader may have collapsed it
    // while the request was in flight; `syncRow` is a no-op then.
    syncRow(bugId);
}

/** Brings one row's panel into line with the state, without touching the rest. */
function syncRow(bugId: number): void {
    const row = document.getElementById(rowId(bugId)) as HTMLTableRowElement | null;
    if (row === null) {
        return;
    }
    const isOpen = expanded.has(bugId);
    row.setAttribute('aria-expanded', String(isOpen));
    row.classList.toggle('is-expanded', isOpen);
    const existing = document.getElementById(panelId(bugId));
    if (!isOpen) {
        existing?.remove();
        return;
    }
    const panel = panelRow(bugId);
    if (existing === null) {
        row.after(panel);
    } else {
        existing.replaceWith(panel);
    }
}

/** A row's `id`, so `syncRow` can find it without a query over the table. */
function rowId(bugId: number): string {
    return `row-${bugId}`;
}

/** Its panel's `id`. */
function panelId(bugId: number): string {
    return `panel-${bugId}`;
}

/**
 * The expanded panel for one bug: a `<tr>` spanning the table.
 *
 * Built **on expand rather than at render time**, which is the thing that keeps
 * an uncapped table cheap: 1,170 collapsed rows carry no panel DOM at all.
 */
function panelRow(bugId: number): HTMLTableRowElement {
    const state = drilldowns.get(bugId);
    const body = el('div', { class: 'drilldown' });
    if (state === undefined || state === 'loading') {
        body.append(el('p', { class: 'drilldown-status', text: drilldownLoadingLine(bugId) }));
    } else if (state instanceof Error) {
        body.append(
            el('p', {
                class: 'drilldown-status drilldown-error',
                text: drilldownErrorLine(bugId, state.message),
            })
        );
    } else {
        body.append(
            el('p', {
                class: 'drilldown-count',
                text: drilldownCountLine(state.summary, tree, range),
            })
        );
        // Two layouts in one panel, per the page owner's split: the four
        // short-valued axes as a row of columns, then the two long-valued
        // sections each across the full width. `DrilldownSection.width` carries
        // which is which, so the arrangement follows the data rather than the
        // order.
        const sections = drilldownSections(state.summary).filter(
            (section) => section.rows.length > 0 || section.emptyNote !== null
        );
        const columns = sections.filter((section) => section.width === 'column');
        if (columns.length > 0) {
            const grid = el('div', { class: 'drilldown-grid' });
            for (const section of columns) {
                grid.append(sectionElement(section, state, bugId));
            }
            body.append(grid);
        }
        for (const section of sections.filter((section) => section.width === 'full')) {
            body.append(sectionElement(section, state, bugId));
        }
    }
    const cell = el('td', { children: [body] });
    // Every column of the table, so the panel is the full width of the row it
    // belongs to rather than sitting under one column of it.
    cell.colSpan = TABLE_COLUMNS;
    const panel = el('tr', { class: 'drilldown-row', children: [cell] }) as HTMLTableRowElement;
    panel.id = panelId(bugId);
    return panel;
}

/** One section: its heading and its count-descending rows. */
function sectionElement(
    section: ReturnType<typeof drilldownSections>[number],
    state: DrilldownState,
    bugId: number
): HTMLElement {
    const rows = el('div', { class: 'drilldown-rows' });
    // Only the failure messages expand: they are the only tally whose rows map
    // back to a set of jobs. A platform's jobs would be "every job on linux",
    // which is the whole panel again rather than a drill-down.
    const expandable = section.heading.startsWith('Failure messages');
    if (section.rows.length === 0) {
        rows.append(el('p', { class: 'drilldown-empty', text: section.emptyNote ?? '' }));
    } else {
        for (const row of section.rows) {
            const jobs = expandable ? (state.jobs.get(row.name) ?? []) : [];
            rows.append(itemElement(row, jobs, bugId));
        }
    }
    const heading = el('h4', { class: 'drilldown-heading', text: section.heading });
    if (section.heading === 'Job names') {
        // The ", chunk numbers merged" the page owner asked to be dropped from
        // the heading. The behaviour is unchanged, so the explanation moves to a
        // tooltip rather than disappearing.
        heading.title = JOB_NAMES_TITLE;
    }
    return el('div', {
        class: section.width === 'full' ? 'drilldown-section is-full' : 'drilldown-section',
        children: [heading, rows],
    });
}

/**
 * One tallied value, expanding into its jobs when it has any.
 *
 * The third nesting level — row, then panel, then this — so the expansion state
 * is keyed by `bugId` plus the **message text**, never by the row's index in the
 * tally. The tallies are count-descending and two renders can order equal-count
 * rows differently, which is exactly the defect `site/try.ts`'s divergence 5
 * records for index keys.
 */
function itemElement(
    row: { name: string; count: number },
    jobs: readonly OccurrenceJob[],
    bugId: number
): HTMLElement {
    const item = el('div', { class: 'drilldown-item' });
    item.append(
        el('span', { class: 'drilldown-item-count', text: formatNumber(row.count) }),
        // `textContent`, because these are log lines and job names from an
        // API — untrusted text, which the dataviz skill's tooltip rule and this
        // repo's own habit both say never goes through `innerHTML`.
        el('span', { class: 'drilldown-item-name', text: row.name })
    );
    if (jobs.length === 0) {
        return item;
    }
    // A newline separates the two parts: a bug id cannot contain one, so no
    // (bugId, message) pair can collide with another by concatenation.
    const key = `${bugId}\n${row.name}`;
    const isOpen = expandedLines.has(key);
    item.classList.add('expandable');
    item.setAttribute('role', 'button');
    item.setAttribute('aria-expanded', String(isOpen));
    item.title = `Click to see the ${jobs.length} job${jobs.length === 1 ? '' : 's'} that logged this`;
    const wrapper = el('div', { class: 'drilldown-item-wrapper', children: [item] });
    if (isOpen) {
        wrapper.append(jobListElement(jobs, key));
    }
    item.addEventListener('click', (event) => {
        // A link inside the job list is not the toggle. The list is a sibling
        // rather than a child of the clickable element, so this only guards the
        // item's own content.
        event.stopPropagation();
        if (expandedLines.has(key)) {
            expandedLines.delete(key);
        } else {
            expandedLines.add(key);
        }
        // Only this bug's panel is rebuilt, from the cache — no request.
        syncRow(bugId);
    });
    return wrapper;
}

/**
 * The jobs that logged one failure message, each with its links out.
 *
 * Follows `site/issues.ts`'s `View: Profile | Job` idiom rather than inventing
 * one. What differs is which links can honestly be offered:
 *
 * - **Profile** only when the run index resolved. `runId` is `null` when
 *   `/api/jobs/` did not answer for the job, and a resource-usage artifact is
 *   addressed by `runs/<n>` — so a guessed 0 links to the wrong run's artifact
 *   or to nothing. Omitted rather than guessed.
 * - **Job** whenever there is a real task id, built from `tree`, `revision` and
 *   `taskId.runId` through the shared `treeherderJobUrl`. This data carries all
 *   three directly, so unlike `common-links.js:43` there is no data file to
 *   index into.
 * - **Push** as the fallback when the task id is the `UNKNOWN_TASK_ID`
 *   sentinel: the revision is still known, so the push is a correct link where
 *   the job is not addressable.
 */
function jobListElement(jobs: readonly OccurrenceJob[], key: string): HTMLElement {
    const list = el('div', { class: 'job-list' });
    // **Capped, with the rest one click away.** Found in a real browser: the top
    // bug's most common message had **573** jobs, and drawing all of them put
    // ~570 rows between the reader and the next section. The no-silent-truncation
    // rule still holds, so the count is stated and the remainder is reachable
    // rather than dropped — which is why this is a disclosure and not a slice.
    const shown = expandedJobLists.has(key) ? jobs : jobs.slice(0, JOB_LIST_ROWS);
    for (const job of shown) {
        const meta = `${job.platform} ${job.buildType}`;
        const links = el('span', { class: 'job-links' });
        if (job.taskId !== null && job.runId !== null) {
            links.append(
                'View: ',
                externalLink(
                    profilerFrontEndUrl(resourceUsageProfileUrl(job.taskId, job.runId), {
                        profileName: `${job.jobName} (${job.taskId}.${job.runId})`,
                        origin: profilerOrigin,
                    }),
                    'Profile'
                )
            );
        }
        if (job.taskId !== null) {
            links.append(
                links.childNodes.length === 0 ? 'View: ' : ' ',
                externalLink(
                    treeherderJobUrl(job.tree, job.revision, job.taskId, job.runId ?? 0),
                    'Job'
                )
            );
        } else {
            // No addressable task, so the push rather than a URL containing the
            // sentinel. Named "Push" and not "Job", because it is not the job.
            links.append(
                'View: ',
                externalLink(treeherderPushUrl(job.tree, job.revision), 'Push')
            );
        }
        list.append(
            el('div', {
                class: 'job-row',
                children: [
                    el('span', { class: 'job-date', text: job.pushTime.slice(0, 16) }),
                    el('span', { class: 'job-name', text: job.jobName, title: job.machineName }),
                    el('span', { class: 'job-meta', text: meta }),
                    links,
                ],
            })
        );
    }
    if (jobs.length > JOB_LIST_ROWS) {
        const hidden = jobs.length - JOB_LIST_ROWS;
        const toggle = el('button', {
            class: 'job-list-more',
            text: expandedJobLists.has(key)
                ? `Show the first ${JOB_LIST_ROWS} only`
                : `Show all ${formatNumber(jobs.length)} jobs (${formatNumber(hidden)} more)`,
        });
        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            if (expandedJobLists.has(key)) {
                expandedJobLists.delete(key);
            } else {
                expandedJobLists.add(key);
            }
            const row = toggle.closest('tr.drilldown-row');
            const bugId = Number(row?.id.replace('panel-', '') ?? '');
            if (Number.isFinite(bugId)) {
                syncRow(bugId);
            }
        });
        list.append(toggle);
    }
    return list;
}

/**
 * The merged `test and failure` cell: the path on one line, the message under it.
 *
 * ## Why the two columns became one
 *
 * They were `Test` and `Failure`, side by side, and the page owner's report is
 * the whole reason for the change: "the 'test' and 'failure' columns should be
 * merged, with the test name on a first line, then a line break and the failure
 * message on the second line. That would reduce the wrapping, and copy/searchfox
 * icons will look much better than their current wrap."
 *
 * Both columns held long strings — a test path and a `TEST-UNEXPECTED-FAIL`
 * line — so splitting the width between them made both wrap, and the 📋/🔍
 * buttons after the path wrapped onto their own line with it. Stacking them
 * gives each the full column, which is the shape `site/try.ts`'s `.test-info`
 * cell already uses for exactly this pair: a `span.test-path` holding the shared
 * `testRowLink` treatment, then a `div.inline-message` under it.
 *
 * A per-row failure percentage was here, read from the same
 * `{harness}-issues.json` the harness classification reads. The page owner cut
 * it — "the percentages shown on the intermittent.html page make no sense. drop
 * that feature so we can deploy sooner. We'll do it again later." The two files
 * are still fetched, for the classification that was always their first use.
 */
function testAndFailureCell(bug: RankedIntermittent): HTMLElement {
    const cell = el('td', { class: 'col-test' });
    if (bug.test !== null) {
        const pathSpan = el('span', { class: 'test-path' });
        // The shared treatment (`site/test-link.ts`), which `try.html` and
        // `issues.html` render too: the path opens `test.html` in a new tab,
        // followed by the 📋 and 🔍 buttons. The link's and the buttons' own
        // `stopPropagation` is what keeps following one of them from also
        // expanding the row.
        const [anchor, copy, searchfox] = testRowLink(bug.test);
        anchor.classList.add('test-link');
        pathSpan.append(anchor, copy, searchfox);
        cell.append(pathSpan);
    }
    // `failure`, not `bugSummary`: the cell already names the test on the line
    // above, and `RankedIntermittent`'s own comment sets the rule — "if the
    // surrounding output already names the test, use `failure`".
    //
    // The `title` carries the untruncated string, because the line is clamped:
    // a message too long for the column is still readable on hover, which is the
    // same promise `site/try.ts`'s `.inline-message` makes.
    cell.append(
        el('div', { class: 'inline-message', title: bug.failure, text: bug.failure })
    );
    return cell;
}

/**
 * The assignee cell: the bug's owner, or a dash.
 *
 * **On the row rather than in the expanded panel**, which the page owner left to
 * my judgement. A row is a triage decision — who, if anyone, is already on
 * this — and that is exactly the question a reader scans a ranked list for, so
 * hiding it behind a click would mean expanding 428 rows to find the unowned
 * ones. It costs a narrow column because the displayed value is a short human
 * name.
 *
 * **`assigned_to_detail.real_name`, never `assigned_to`**: the latter is an
 * email address, and a page does not need to publish those to say who owns a
 * bug. `lib/sources/intermittents.ts` is where the two are read and where the
 * `nobody@mozilla.org` sentinel is turned into `null` — its `real_name` is the
 * unhelpful string `'Nobody; OK to take it and work on it'`, which is not a
 * name and must not be rendered as one.
 */
function assigneeCell(bug: RankedIntermittent): HTMLElement {
    if (bug.assignee === null) {
        // An em dash, not an empty cell: "nobody is on this" is a fact the
        // reader wants, and a blank cell reads as missing data instead.
        return el('td', { class: 'col-assignee unassigned', text: '—', title: 'Unassigned' });
    }
    return el('td', { class: 'col-assignee', text: bug.assignee, title: bug.assignee });
}

/** Charts whose canvas is in the document but not yet drawn into. */
let pendingSparklines: { id: string; history: OccurrenceDay[]; resolved: boolean }[] = [];

/**
 * A row's sparkline cell: the canvas, and the label that scales it honestly.
 *
 * The canvas is created here and **drawn after insertion**, for the reason
 * Chart.js needs and `site/flaky.ts` records: a detached canvas has no size to
 * lay a chart out in.
 *
 * The `peak N/day` label is **not** here any more: it moved into the count cell
 * (`rowElement`), on the page owner's instruction that it "could go on a second
 * line under the annotation count, reducing the total height of the chart cell
 * content". It is still mandatory rather than decorative — per-row scaling is
 * only honest if the row's maximum is stated — just stated one column left.
 *
 * Still an array, because `el`'s `children` takes one and the cell may hold
 * nothing: an empty array when there is nothing to plot, which leaves the cell
 * blank.
 */
function sparklineCell(row: IntermittentRow): Node[] {
    if (!sparklineVisible(row.history)) {
        return [];
    }
    const id = `sparkline-${row.bug.bugId}`;
    pendingSparklines.push({
        id,
        history: row.history,
        resolved: row.bug.resolution !== '',
    });
    return [
        // The canvas is wrapped in a fixed-size box rather than put straight in
        // the `<td>`, because Chart.js's `responsive: true` sizes it to its
        // offset parent and a table cell grows to its content — see
        // `.sparkline-box` in `site/intermittent.html` for the 532px-tall rows
        // that produced.
        el('div', {
            class: 'sparkline-box',
            children: [el('canvas', { id, class: 'sparkline' })],
        }),
    ];
}

/**
 * How a zero day is marked, by `zeroDayKinds`'s three cases.
 *
 * ## The colours, and where they come from
 *
 * The `dataviz` skill's **status** palette rather than its categorical slots,
 * which is the right family by the skill's own test: these encode a *state* of
 * the bug (fixed / not yet present / quiet), not a series identity, and
 * "when a series *means* good/bad it wears status tokens". `fixed` is the
 * skill's `good` step `#0ca30c` and `leading` is its muted-ink `#898781`.
 *
 * Contrast measured with the skill's own `contrast()` against this page's
 * surfaces — white rows and the `#f9f9f9` hover — rather than against the
 * skill's default surface: green 3.35:1 / 3.19:1 and grey 3.59:1 / 3.41:1, both
 * over the 3:1 a graphical mark needs.
 *
 * ## What the validator said, and what was done about it
 *
 * Running the categorical validator over these three reports **CVD separation
 * FAIL: `#0ca30c`↔`#e8834a` ΔE 4.0 under protanopia** (and a chroma-floor FAIL
 * on the grey, which is what "reads as gray" means and is the intent for a
 * muted-ink slot). The skill's scope note says the six checks do not judge a
 * status colour, but the protan figure is a real reading problem and is treated
 * as one rather than waved away with the scope note:
 *
 * - **Shape, not only hue.** A `fixed` day is drawn as a **triangle** and a
 *   `leading` day as a **circle**, so the two states are distinguishable with no
 *   colour vision at all. That is the "secondary encoding" the skill requires of
 *   anything in or under the CVD band.
 * - **Position.** A `leading` run is at the *start* of the line by construction;
 *   a `fixed` run is not.
 * - **Text.** Every green day sits on a row that is struck through and tagged
 *   with its resolution word, and the tooltip says "the bug is resolved" in
 *   words. The skill's status rule — never colour alone, always icon + label —
 *   is satisfied by that pairing.
 *
 * The orange itself carries a contrast WARN (2.70:1, measured above), which the
 * skill says obligates visible labels rather than being dismissable: the row's
 * `Annotations` cell, the `peak N/day` label and the tooltip are all present, so
 * no number is only recoverable by eyedropping the line.
 */
const ZERO_DAY_COLOURS: Record<'leading' | 'fixed' | 'quiet', string> = {
    leading: '#898781',
    fixed: '#0ca30c',
    // Not a special case — the series' own colour, because an open bug that did
    // not fire has achieved nothing worth colouring.
    quiet: CHART_COLOUR,
};

/**
 * The **height** a zero day is drawn at: the CVD channel, re-solved for bars.
 *
 * ## Why the shape channel had to change
 *
 * The previous implementation was a line chart, and its second channel was
 * `pointStyle` — a triangle for a resolved bug's zero, a circle for a leading
 * one — because the validator reports `#0ca30c`↔`#e8834a` at **ΔE 4.0 under
 * protanopia** (re-run for this change: still 4.0), which is inside the band the
 * skill says is legal *only* with a secondary encoding.
 *
 * Bars removed that channel rather than changing it: **a bar of zero height has
 * no shape to set**, and a point marker floating on a bar chart's baseline is
 * a line chart's vocabulary borrowed into a form that does not have it.
 *
 * ## What replaced it, and why not texture
 *
 * A **1px baseline stub** for the two states that mean something, and nothing at
 * all for `quiet`. So the three cases differ by *height* — a channel bars
 * actually have — before any colour is read:
 *
 * - `fixed` and `leading` draw a visible tick at the baseline;
 * - `quiet` draws nothing, because an open bug that did not fire has achieved
 *   nothing worth marking.
 *
 * That separates the drawn zeros from the undrawn ones without colour. It does
 * **not** separate `fixed` from `leading` by itself, and the honest statement is
 * that for those two the remaining channels are the ones the previous
 * implementation already relied on and which bars do not change: **position**
 * (a `leading` run is at the start of the series by construction, a `fixed` run
 * is not), and **text** (a green day only ever appears on a row that is struck
 * through, tagged with its resolution word, and whose tooltip says "the bug is
 * resolved" in words). The skill's status rule — never colour alone, always
 * icon + label — is met by that pairing rather than by the bar.
 *
 * Texture was considered and rejected on the skill's own rule: it is opt-in for
 * an accessibility setting, print or `forced-colors`, and "texture on by
 * default, or as decoration" is listed in `anti-patterns.md`. A 1px-tall bar is
 * also too small to carry a 45° hatch legibly.
 */
const ZERO_DAY_STUB: Record<'leading' | 'fixed' | 'quiet', number> = {
    leading: 1,
    fixed: 1,
    quiet: 0,
};

/**
 * The sparkline's drawn height in CSS pixels, matching `.sparkline-box`.
 *
 * Here because `ZERO_DAY_STUB`'s 1 is a height in *pixels* and a bar's value is
 * in *annotations*, so the stub has to be converted through the row's own scale:
 * `stub * peak / SPARKLINE_HEIGHT` is the data value that draws one pixel. A row
 * whose peak is 400 and one whose peak is 3 then both get a 1px tick rather than
 * the first getting an invisible one.
 *
 * Kept in step with `site/intermittent.html` by
 * `test/intermittent-page.test.ts`, which reads the stylesheet — a silent
 * disagreement here would only show as zero-day ticks of the wrong height.
 */
const SPARKLINE_HEIGHT = 28;

/** The slice of Chart.js's external-tooltip argument this page reads. */
interface TooltipContext {
    chart: { canvas: HTMLCanvasElement };
    tooltip: {
        opacity: number;
        /** The hovered points, in dataset order. */
        dataPoints?: { dataIndex: number }[];
        caretX: number;
        caretY: number;
    };
}

/**
 * The one tooltip element every sparkline shares.
 *
 * One for the page, not one per chart: there are up to ~1,170 charts and only
 * ever one pointer, so a node per chart would be 1,170 nodes to show one of.
 * Created on first hover and reused.
 */
let chartTooltip: HTMLElement | null = null;

/**
 * Positions and fills the shared tooltip, from Chart.js's `external` hook.
 *
 * ## Why the tooltip is not Chart.js's own
 *
 * Chart.js draws its built-in tooltip **into the canvas it belongs to**. This
 * canvas is 120x28 inside a table cell, so a tooltip with a date and a count
 * cannot fit in it: what the page owner saw was "only the date is visible in the
 * tooltip, that covers the entire chart". Nothing about the *content* was wrong,
 * so no amount of shortening it would have fixed it — the container was the
 * problem, and the fix is to stop drawing inside the container.
 *
 * ## Where it is attached, and why that is `<body>`
 *
 * Appended to `<body>` and positioned in **page coordinates**, rather than
 * positioned inside the cell. A cell, a row and the table all establish clipping
 * and stacking contexts that a 28px-tall cell's tooltip loses to; `<body>` has
 * none above it, so the element cannot be clipped by the row it describes.
 *
 * ## Not being cut off at the table's edges
 *
 * The horizontal placement flips: the tooltip is drawn to the **right** of the
 * pointer normally, and to the **left** when that would overflow the viewport.
 * The chart column is near the left edge of a wide table, so the right-hand
 * placement is the common one; the flip is what the owner's "must not be cut off
 * at the table's edges" needs on a narrow window. It is also clamped vertically,
 * so a chart in the first or last row does not push the tooltip off-screen.
 */
function showChartTooltip(
    context: TooltipContext,
    history: readonly OccurrenceDay[],
    kinds: readonly (ReturnType<typeof zeroDayKinds>[number])[]
): void {
    const { tooltip } = context;
    if (chartTooltip === null) {
        chartTooltip = el('div', { class: 'chart-tooltip' });
        // `aria-hidden`, because this is a pointer affordance duplicating data
        // that is already in the row: the count cell holds the window total and
        // the panel holds the per-day breakdown. A screen reader announcing a
        // floating div on mouse move would be noise, not access.
        chartTooltip.setAttribute('aria-hidden', 'true');
        document.body.append(chartTooltip);
    }
    const node = chartTooltip;
    // Chart.js signals "no longer hovered" with zero opacity rather than by
    // calling anything else, so this is the hide path.
    if (tooltip.opacity === 0) {
        node.style.display = 'none';
        return;
    }
    const index = tooltip.dataPoints?.[0]?.dataIndex;
    const day = index === undefined ? undefined : history[index];
    if (day === undefined) {
        node.style.display = 'none';
        return;
    }
    // The full date, not the `MM-DD` the axis labels carry: the owner asked for
    // the date to be readable, and a sparkline spanning a month boundary is
    // ambiguous without the year.
    const kind = index === undefined ? null : kinds[index];
    const count = `${formatNumber(day.count)} annotation${day.count === 1 ? '' : 's'}`;
    const note =
        kind === 'leading'
            ? " — before this bug's first in the window"
            : kind === 'fixed'
              ? ' — the bug is resolved'
              : '';
    node.textContent = '';
    node.append(
        el('div', { class: 'chart-tooltip-date', text: day.date }),
        el('div', { class: 'chart-tooltip-count', text: `${count}${note}` })
    );
    node.style.display = 'block';

    // Measured after the content is set and displayed, because the flip below
    // needs the real width of this row's text rather than an assumed one.
    const canvas = context.chart.canvas.getBoundingClientRect();
    const size = node.getBoundingClientRect();
    const GAP = 10;
    let left = window.scrollX + canvas.left + tooltip.caretX + GAP;
    if (left + size.width > window.scrollX + document.documentElement.clientWidth - GAP) {
        left = window.scrollX + canvas.left + tooltip.caretX - size.width - GAP;
    }
    // Vertically centred on the hovered bar, then clamped into the viewport so a
    // first- or last-row chart still shows the whole tooltip.
    const top = window.scrollY + canvas.top + tooltip.caretY - size.height / 2;
    const lowest = window.scrollY + GAP;
    const highest = window.scrollY + document.documentElement.clientHeight - size.height - GAP;
    node.style.left = `${Math.max(window.scrollX + GAP, left)}px`;
    node.style.top = `${Math.min(Math.max(lowest, top), Math.max(lowest, highest))}px`;
}

/**
 * Draws one row's sparkline, when it is asked for.
 *
 * **Each row is scaled to its own peak**, which is the change an earlier report
 * forced: a shared maximum left 19 of the 50 drawn rows entirely inside 2px of
 * a 28px cell, measured on live trunk. `sparklinePeak` in
 * `site/intermittent-view.ts` carries the measurements and the reasoning,
 * including why this is not a log axis.
 *
 * **Bar colour carries the zero-day cases** — green where a resolved bug
 * stopped failing, grey before it first appeared — through Chart.js's
 * per-bar-array form for `backgroundColor`. Unlike the line this replaced, a bar
 * chart can colour an individual day without implying anything about the days
 * between: each bar *is* one day, so there is no segment to mis-recolour. That
 * is the second reason bars suit this data, beyond the owner's report.
 *
 * A zero day is drawn as a 1px stub rather than as nothing, for the two cases
 * where the zero means something — see `ZERO_DAY_STUB`, which is also where the
 * colour-blindness channel is re-solved for bars.
 *
 * One chart per call, because `observeSparklines` decides *when* each is drawn.
 */
function drawSparkline(entry: { id: string; history: OccurrenceDay[]; resolved: boolean }): void {
    const Chart = chartJs();
    if (Chart === undefined) {
        return;
    }
    {
        const { id, history, resolved } = entry;
        const canvas = document.getElementById(id) as HTMLCanvasElement | null;
        if (canvas === null) {
            return;
        }
        Chart.getChart(canvas)?.destroy();
        const kinds = zeroDayKinds(history, resolved);
        const peak = sparklinePeak(history);
        new Chart(canvas, {
            // **Bars, not a filled line.** The page owner's report: "using a
            // line chart with a colored aread for failure counts is weird, a
            // bar chart would be better." It is the right form by the skill's
            // own heuristic too — these are 21 discrete daily counts, and a
            // count per category is a bar's job. The area fill under the line
            // was also implying a continuous quantity between days, which a
            // per-day annotation total is not.
            type: 'bar',
            data: {
                labels: history.map((day) => day.date.slice(5)),
                datasets: [
                    {
                        label: 'Annotations',
                        // A zero day draws the 1px stub `ZERO_DAY_STUB` gives
                        // it, so the two states that mean something are visible
                        // marks rather than absent ones. `rawCounts` below is
                        // what the tooltip reads, so the stub never becomes a
                        // number on screen.
                        data: history.map((day, index) => {
                            const kind = kinds[index];
                            return day.count > 0 || kind === null || kind === undefined
                                ? day.count
                                : (ZERO_DAY_STUB[kind] * peak) / SPARKLINE_HEIGHT;
                        }),
                        backgroundColor: kinds.map((kind) =>
                            kind === null ? CHART_COLOUR : ZERO_DAY_COLOURS[kind]
                        ),
                        // No stroke around a bar: the skill's spacer rule is
                        // that the surface gap separates neighbours, and a
                        // border "adds data-weight ink that isn't data".
                        borderWidth: 0,
                        // The skill's bar spec is a 4px rounded data-end, square
                        // at the baseline. At this size 2px is the largest radius
                        // that still reads as a bar rather than a lozenge — the
                        // tallest bar in a 28px cell is 28px, and a 4px radius on
                        // a 3px-wide bar rounds the whole mark away.
                        borderRadius: 2,
                        // The 2px surface gap between adjacent bars, which is
                        // what makes 21 neighbours read as separate marks.
                        categoryPercentage: 0.86,
                        barPercentage: 0.86,
                    },
                ],
            },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: false,
                // `index` with `intersect: false`, so the pointer only has to
                // be over the right *day* rather than on the bar itself — which
                // matters more for a 3px-wide bar than it did for the line.
                interaction: { mode: 'index', intersect: false },
                // A sparkline is a shape, so the scales carry no furniture at
                // all — no ticks, no grid, no axis titles. The row's count cell
                // is the window total, the `peak N/day` label under it is this
                // axis's maximum, and the tooltip is every day.
                scales: {
                    x: { display: false },
                    y: { display: false, beginAtZero: true, min: 0, max: peak },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        // **Rendered outside the canvas.** The page owner's
                        // report: "the tooltips on the chart are impossible to
                        // read, only the date is visible in the tooltip, that
                        // covers the entire chart." The cause is geometry rather
                        // than content — Chart.js draws its tooltip *into the
                        // canvas*, and this canvas is a ~28px-tall cell, so a
                        // three-line tooltip is clipped by the mark it describes.
                        //
                        // `enabled: false` plus `external` hands positioning to
                        // `showChartTooltip`, which owns a single body-level
                        // element — so it is clipped by nothing, and flips near
                        // the viewport's right edge.
                        enabled: false,
                        external: (context: TooltipContext): void => {
                            showChartTooltip(context, history, kinds);
                        },
                    },
                },
            },
        });
    }
}

/** Watches the queued canvases, drawing each as it scrolls into view. */
let sparklineObserver: IntersectionObserver | null = null;

/**
 * Draws the queued sparklines **lazily**, as they scroll into view.
 *
 * ## Why lazily, with the numbers
 *
 * The table has no row cap any more, so the unfiltered 21-day `trunk` window is
 * **1,170 rows**. Chart.js costs ~0.9 ms per sparkline on this page's own markup
 * — measured in a real browser at 38 ms for 50 charts, 178 ms for 200, 397 ms
 * for 430 and 903 ms for 800 — so drawing every one up front would block the
 * main thread for about **1.1 s**. That is the jank the old 50-row cap was
 * avoiding, and drawing on demand answers it without hiding 1,120 rows.
 *
 * Only the charts are deferred. Every **row** is in the DOM from the first
 * paint, so the count, the bug, the test path and the failure text are all
 * there to scroll, search with the browser's own find, and link to.
 *
 * `rootMargin` of 200px so a chart is drawn just before it is needed rather than
 * as it appears, which is what keeps a scroll from showing empty cells.
 *
 * `unobserve` after drawing, so a canvas is drawn once: without it, scrolling a
 * row out and back would redraw it, and `drawSparkline` would have to destroy an
 * existing chart on every pass.
 *
 * **No `IntersectionObserver` is a working page, not a broken one**: jsdom has
 * none, and neither does a very old browser, so the fallback draws everything
 * immediately. That is the pre-existing behaviour and it is correct — just
 * slower on a long table — which is the right way round for a fallback.
 */
function observeSparklines(): void {
    const queued = pendingSparklines;
    pendingSparklines = [];
    sparklineObserver?.disconnect();
    sparklineObserver = null;

    const byCanvasId = new Map(queued.map((entry) => [entry.id, entry]));
    if (typeof IntersectionObserver === 'undefined') {
        for (const entry of queued) {
            drawSparkline(entry);
        }
        return;
    }
    const observer = new IntersectionObserver(
        (entries) => {
            for (const observed of entries) {
                if (!observed.isIntersecting) {
                    continue;
                }
                const canvas = observed.target as HTMLElement;
                const pending = byCanvasId.get(canvas.id);
                if (pending !== undefined) {
                    drawSparkline(pending);
                    byCanvasId.delete(canvas.id);
                }
                observer.unobserve(canvas);
            }
        },
        { rootMargin: '200px 0px' }
    );
    for (const entry of queued) {
        const canvas = document.getElementById(entry.id);
        if (canvas !== null) {
            observer.observe(canvas);
        }
    }
    sparklineObserver = observer;
}

/**
 * Draws every queued sparkline now, for a test or a caller that needs them all.
 *
 * `observeSparklines` is what the page uses, and it draws nothing until a canvas
 * is on screen — which in jsdom, where nothing is ever on screen and there is no
 * `IntersectionObserver` at all, means the fallback path covers it. Exported so
 * the parity harness can ask for the same state a scrolled-to-the-bottom reader
 * would see.
 */
export function drawAllSparklines(): void {
    for (const entry of pendingSparklines) {
        drawSparkline(entry);
    }
    pendingSparklines = [];
}

// --- controls -------------------------------------------------------------

/**
 * Fills the in-title harness dropdown and wires it.
 *
 * The select lives inside the `<h1>` with `common-ui.js`'s `.harness-switcher`
 * class, which `issues.html` and `flaky.html` use through `initHarnessSwitcher`.
 * That helper is not called here — `site/intermittent.html` says why at the
 * markup — so the two things it also does are done explicitly: the suffix text
 * after the select, and `document.title`.
 */
function initHarnessControl(): void {
    const select = byId('harness-select') as HTMLSelectElement;
    select.textContent = '';
    for (const option of HARNESS_OPTIONS) {
        const node = el('option', { text: option.label });
        node.value = option.value;
        select.append(node);
    }
    select.value = harnessValue(harness);
    byId('title-suffix').textContent = TITLE_SUFFIX;
    applyDocumentTitle();
    select.addEventListener('change', () => {
        harness = parseHarness(select.value);
        // No fetch. `scanBugs` classified every candidate before the first
        // paint, so this is a filter over rows already in memory —
        // `HARNESS_OPTIONS` records why the API leaves no choice about that.
        applyDocumentTitle();
        render();
        hashManager.updateHash();
    });
}

/**
 * Keeps the browser tab's title in step with the selection.
 *
 * `initHarnessSwitcher` does this for the pages that use it, and a tab reading
 * "all Intermittent failures" while the page shows only mochitest is the same
 * class of defect as a control that disagrees with its view — it is just in the
 * one place the reader sees when the page is not in front of them.
 */
function applyDocumentTitle(): void {
    document.title = documentTitle(harness);
}

/**
 * Wires the window dropdown, adding the URL's window if it is not an option.
 *
 * The markup offers 7, 14, 21 and 30 days. The first three are the whole-week
 * windows, for the reason `DEFAULT_DAYS` records; **30 is not**, and is offered
 * anyway because it is the month-shaped window a reader reaches for — selecting
 * it shows `windowNote`'s caveat, which is the honest version of refusing it.
 * 21 remains the default.
 *
 * `parseWindowDays` accepts any `<n>days` beyond those four, because this page
 * queries a live API by date range rather than choosing between published files,
 * so `#date=10days` is a legal request.
 *
 * **A `<select>` silently ignores a value it has no option for**, which would
 * leave the control reading "Last 21 days" while the page showed ten — a control
 * that disagrees with the view it is supposed to describe. So an unlisted window
 * gets an option of its own, marked as such, and the page states the whole-weeks
 * caveat beside it (`windowNote`).
 */
function initWindowControl(): void {
    const select = byId('window-select') as HTMLSelectElement;
    const wanted = `${windowDays}days`;
    if (![...select.options].some((option) => option.value === wanted)) {
        const custom = el('option', { text: `Last ${windowDays} days (from the URL)` });
        custom.value = wanted;
        select.append(custom);
    }
    select.value = wanted;
    select.addEventListener('change', () => {
        const days = parseWindowDays(select.value);
        if (days === null) {
            return;
        }
        windowDays = days;
        range = windowOf(days, today);
        hashManager.updateHash();
        // A new window is new data: every request in the plan has to be made
        // again, because the ranking, the summaries and the per-day series are
        // all functions of the range.
        void reload();
    });
}

async function reload(): Promise<void> {
    scan = null;
    histories = new Map();
    volume = null;
    renderedRows = [];
    // A new window is a new population of occurrences, so a cached drill-down
    // for it would answer about the old range. The *expanded* set survives: a
    // reader who opened a bug and changed the window still wants that bug open.
    drilldowns.clear();
    // `dayCache` is deliberately **not** cleared. It is keyed by (tree, day) and
    // a past day's annotations are immutable, so the days a new window shares
    // with the old one are already correct — which is what makes 21 -> 7 cost no
    // request and 7 -> 21 cost only the 14 new days. See `dayCache`.
    byId('ranking-table').textContent = '';
    try {
        await load();
    } catch (error) {
        showError(`Could not load the annotations: ${(error as Error).message}`);
        setStatusText('');
    }
}

/** Reads the hash into the page's state. */
function applyHash(params: URLSearchParams): void {
    const state = readUrlState(params);
    const days = parseWindowDays(state.date);
    if (days !== null) {
        windowDays = days;
        range = windowOf(days, today);
    }
    harness = parseHarness(state.harness);
    tree = state.tree ?? DEFAULT_TREE;
}

// --- startup --------------------------------------------------------------

/**
 * Starts the page.
 *
 * Exported and not run at module scope, for the reason `site/crashes-main.ts`
 * records: a controller that runs on import cannot be imported by a test, which
 * is how an earlier migration ended up with 2,598 lines no test covered.
 *
 * The three seams are parameters with defaults, so a test can hand in a fake
 * client, a fake source and a pinned day without a network. The page passes
 * none of them.
 *
 * `today` is a seam and not only a convenience: the window is a date range on a
 * live API, so a recorded fixture answers nothing unless the day the window ends
 * on can be pinned to the day it was recorded. Without it a page test could
 * assert the layout and nothing about the numbers.
 */
export async function start(
    options: { client?: IntermittentsClient; source?: DataSource; today?: Date } = {}
): Promise<void> {
    client = options.client ?? intermittentsClient({ fetch: browserFetch as FetchLike });
    source = options.source ?? pageSource();
    if (options.today !== undefined) {
        today = options.today;
        range = windowOf(windowDays, today);
    }

    hashManager = initUrlHashManager({
        getState: () =>
            writeUrlState({
                date: `${windowDays}days`,
                harness: harnessValue(harness),
                tree,
            }),
        onHashChange: async (state) => {
            const before = { days: windowDays, tree };
            applyHash(new URLSearchParams(state));
            (byId('harness-select') as HTMLSelectElement).value = harnessValue(harness);
            applyDocumentTitle();
            (byId('window-select') as HTMLSelectElement).value = `${windowDays}days`;
            // Only a changed window or tree needs new data; a changed harness is
            // a filter over what is already loaded.
            if (before.days !== windowDays || before.tree !== tree) {
                await reload();
            } else {
                render();
            }
        },
    });
    applyHash(hashManager.getParams());
    initHarnessControl();
    initWindowControl();
    // Written back immediately, so the default window appears in the URL as
    // `#date=21days` — the form the owner pastes between pages.
    hashManager.updateHash();

    await reload();
}

/**
 * The view model, for the browser parity harness.
 *
 * `docs/PARITY.md` §2: "a page being rewritten onto `lib/` can expose its view
 * model as a design property instead" of having getters retrofitted onto it.
 * This is that property. The fields are the ones a parity check needs — the
 * ranking as drawn, the selection it was cut from, the window, and the
 * classification coverage — and nothing that is only a rendering detail.
 */
export function parityState(): {
    /**
     * The page's `<h1>`, which is what titles the view now.
     *
     * It was the `<h2>` over the table (`rankingTitle`), removed on the page
     * owner's question "what's the point of this section title when there's only
     * one section in the entire page?". The parity question it answers is
     * unchanged — does the page name the same list the CLI names — but the
     * answer now comes from the heading the page actually has, plus the scope
     * line beside the window control, rather than from a heading that is gone.
     */
    title: string;
    /** The tree and window, as the line beside the window dropdown states them. */
    scope: string;
    tree: string;
    range: DayRange;
    harness: HarnessSelector | undefined;
    coverage: ScanResult['coverage'] | null;
    rows: { bugId: number; count: number; harness: string; test: string | null }[];
    histories: Record<string, number[]>;
    volume: VolumeSeries | null;
} {
    return {
        title: documentTitle(harness),
        scope: windowScopeLine(tree, range),
        tree,
        range,
        harness,
        coverage: scan?.coverage ?? null,
        rows: renderedRows.map(({ bug }) => ({
            bugId: bug.bugId,
            count: bug.count,
            harness: bug.harness,
            test: bug.test,
        })),
        histories: Object.fromEntries(
            renderedRows.map(({ bug, history }) => [
                String(bug.bugId),
                history.map((day) => day.count),
            ])
        ),
        volume,
    };
}

export { DEFAULT_WINDOW };
