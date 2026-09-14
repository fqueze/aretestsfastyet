/**
 * `intermittent.html`'s **view model**: every decision the page makes, as plain
 * values, with no DOM.
 *
 * The seam this project holds (`docs/PARITY.md`, and the rule recorded on the
 * earlier migrations): `lib/` holds the data and the derivations, and the page
 * directory holds anything that names an element id, a CSS class or a UI glyph.
 * So `lib/query/intermittents.ts` decides *what a bug is and how it classifies*
 * and this file decides *what the reader sees* — which rows exist, what the
 * harness control offers, and what the page says about its own coverage.
 *
 * ## What this page is
 *
 * A new page rather than a migration: `fx-tests intermittent` had no dashboard,
 * which is why `test/framing.test.ts` listed it under `UNCOVERED_COMMANDS`. So
 * there is no old page to be byte-identical to and no divergence list against
 * one — what there is instead is a framing entry, added with this page, whose
 * `page` side is asserted here and whose `cli` side is asserted against real
 * command output.
 *
 * ## Why this page is unlike every other page in `site/`
 *
 * Every other migrated page reads a **nightly aggregate**: one artifact, fetched
 * once, holding a published window. This one reads Treeherder's **live**
 * sheriff-annotation endpoints, and three consequences follow that shape the
 * whole design.
 *
 * 1. **A row is an annotation, not a failure.** A sheriff attached a bug to a
 *    failing job; a failure nobody triaged has no row at all. So this page ranks
 *    what costs sheriffs time, where `issues.html` and `flaky.html` rank what
 *    fails most. The two are different questions and the page says so on screen
 *    rather than leaving a reader to assume the numbers are comparable.
 * 2. **It is tree-wide, not path-scoped.** There is no folder to drill into and
 *    no harness parameter on the API — see `HARNESS_OPTIONS`.
 * 3. **There is no published window, so no date `<select>`.** The other pages
 *    fill one from `index.json`; here the window is any pair of days the API
 *    will accept, and the page picks a length. See `DEFAULT_DAYS`.
 */

import type { BugFailureCount, DayRange } from '../lib/sources/intermittents.ts';
// `jobsByLine` and `OccurrenceJob` live in `lib/query/intermittents.ts`: the
// grouping has to key by the same normalised failure-message string the
// `lines` tally does (`failureLineDetail`), and that normalisation is a `lib/`
// derivation rather than a rendering decision. Re-exported here so the page
// keeps importing its view types from one module.
export type { OccurrenceJob } from '../lib/query/intermittents.ts';
export { jobsByLine } from '../lib/query/intermittents.ts';
import type {
    BugDrilldown,
    HarnessSelector,
    OccurrenceDay,
    RankedIntermittent,
    ScanResult,
    SuiteCount,
} from '../lib/query/intermittents.ts';

// --- the window -----------------------------------------------------------

/**
 * How many days the page covers, and why it is not the CLI's seven.
 *
 * **21, where `cli/commands/intermittent.ts`'s `DEFAULT_DAYS` is 7.** The CLI's
 * reason for seven is not a reason for seven specifically — it is that the
 * window must be a **whole number of weeks**, because push volume drops
 * several-fold at weekends and a window of 10 days ranks a different weekday mix
 * every time it is run. 21 is three weeks, so it satisfies that constraint
 * exactly as 7 does; the constraint rules out 10 and 17, not 21.
 *
 * 21 rather than 7 because it is the window every other page on this site
 * publishes, and because the owner reaches for `#date=21days` on `issues.html`
 * by habit. A reader moving between the two pages should not have to hold two
 * window lengths in their head to compare two numbers.
 *
 * **It costs more than the CLI's week**, and the page is explicit about that
 * rather than quiet: measured against live `trunk`, a 21-day window ranks 1,167
 * bugs where a 7-day window ranks far fewer, and the per-day requests the charts
 * need scale with the window's length. `scanPlan` is where that cost is
 * stated for the reader.
 */
export const DEFAULT_DAYS = 21;

/**
 * The `date` hash value that means the default window.
 *
 * Named `21days` and not `default`, matching `issues.html`'s `HISTORICAL_DATE`
 * and `flaky.html`'s: the owner's habitual URL is `#date=21days`, the other
 * pages already answer to it, and a third spelling for the same idea on a third
 * page is how a shared link stops working when it is pasted between them.
 */
export const DEFAULT_WINDOW = '21days';

/**
 * A `#date=` value naming a fixed number of days, or `null`.
 *
 * Accepts `21days`, `7days`, `14days` — any `<n>days` — because this page's
 * window is a free parameter of a live API rather than a choice between
 * published artifacts. `issues.html` can only offer `21days` or one date,
 * since those are the only two files that exist; here every `n` is a legal
 * query, so the hash is parsed as a number rather than matched against one
 * literal.
 *
 * **Whole weeks are not enforced here.** A reader who asks for 10 days gets 10
 * days: refusing would be a control that silently disagrees with the URL it was
 * given. What the page does instead is *say* when the window is not a whole
 * number of weeks — see `windowNote` — which is the honest version of the CLI's
 * reasoning in a medium where the reader can see the consequence.
 */
export function parseWindowDays(date: string | undefined): number | null {
    if (date === undefined || date === '') {
        return DEFAULT_DAYS;
    }
    const match = /^(\d+)days$/.exec(date);
    if (match === null) {
        return null;
    }
    const days = Number(match[1]);
    return days > 0 ? days : null;
}

/**
 * The window a number of days ending today (UTC) covers, both ends inclusive.
 *
 * `days - 1`, and UTC, so this agrees with `resolveRange` in
 * `cli/commands/intermittent.ts` day for day: both ends are inclusive on
 * Treeherder's `startday`/`endday`, so "the last 21 days" spans today and the 20
 * before it. An off-by-one here would make every number on the page differ from
 * the command's by one day's worth of annotations, which is exactly the class of
 * disagreement `docs/PARITY.md` exists to catch.
 *
 * `today` is a parameter so a test can pin it; the page passes nothing.
 */
export function windowOf(days: number, today: Date = new Date()): DayRange {
    const end = isoDay(today);
    const start = isoDay(new Date(today.getTime() - (days - 1) * 24 * 60 * 60 * 1000));
    return { start, end };
}

/** A `Date` as `YYYY-MM-DD` in UTC. Mirrors the CLI's `isoDay`. */
function isoDay(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** Every day of a window, `YYYY-MM-DD`, oldest first. */
export function daysOfWindow(range: DayRange): string[] {
    const days: string[] = [];
    for (
        let time = Date.parse(`${range.start}T00:00:00Z`);
        time <= Date.parse(`${range.end}T00:00:00Z`);
        time += 24 * 60 * 60 * 1000
    ) {
        days.push(isoDay(new Date(time)));
    }
    return days;
}

/**
 * What to say when the window is not a whole number of weeks, else `null`.
 *
 * The CLI states this reasoning in `--help` prose and then enforces it by
 * defaulting to 7. A page cannot enforce it — the reader can type any `n` into
 * the URL — so it states the consequence at the moment it applies, and says
 * nothing at all when the window is 7, 14 or 21. A note that is always present
 * is a note nobody reads.
 */
export function windowNote(days: number): string | null {
    if (days % 7 === 0) {
        return null;
    }
    return (
        `${days} days is not a whole number of weeks. Push volume drops several-fold at ` +
        'weekends, so a window like this one ranks a different mix of weekdays each time it ' +
        'is loaded, and two runs a day apart are not comparable. Use 7, 14 or 21 days to ' +
        'compare runs.'
    );
}

// --- the harness control --------------------------------------------------

/**
 * What the harness dropdown offers, in the order it offers it.
 *
 * **Four options for a three-valued classification, and the first is not a
 * harness.** `lib/query/intermittents.ts`'s `HarnessSelector` is
 * `'mochitest' | 'xpcshell' | 'unknown'`, and `selectHarness` takes that *or
 * `undefined`* meaning "every bug, whatever its classification". So the control
 * has four states and `undefined` is the default — which is the honest default
 * for this page, because the ranking is tree-wide and the harness is one column
 * of it rather than a precondition for having a row.
 *
 * **`unknown` is on the same axis as the two harnesses, deliberately**, and the
 * type comment in `lib/query/intermittents.ts` is where that decision is
 * recorded: a row is mochitest, xpcshell or unknown, so the third value belongs
 * in the same dropdown rather than on a separate checkbox. On live `trunk` it is
 * not a corner case — it is regularly the largest of the three groups, holding
 * infrastructure failures and suites this tool does not read.
 *
 * ## Why this is a client-side selection and costs nothing
 *
 * `/api/failures/` has **no harness parameter**: it ranks every harness at once
 * and nothing in its response identifies a mochitest bug. The classification is
 * therefore done here, and `lib/query/intermittents.ts`'s `scanBugs` is
 * **synchronous** — it reads each bug's Bugzilla summary for a test path and
 * checks that path against the published test lists, with no per-bug request.
 *
 * So **changing this dropdown issues no request at all.** The whole ranking is
 * already classified by the time the page first paints, and `selectHarness`
 * filters rows that are in memory. This is worth stating because the CLI's
 * module header still describes `--harness` as "a client-side scan at one
 * request per candidate bug" — that was true of an earlier implementation and is
 * not true of this one. `scanPlan` records what the page actually spends.
 *
 * ## Why the labels read as fragments rather than as descriptions
 *
 * The control sits **inside the page's `<h1>`**, the way `.harness-switcher`
 * does on `issues.html` and `flaky.html`, so each label has to read as part of
 * a sentence: "[all] Intermittent failures", "[Mochitest] Intermittent
 * failures", "[Unknown test] Intermittent failures".
 *
 * That is what fixes the two labels this list used to carry. `All harnesses`
 * read as a heading of its own next to the title's own words; lowercase `all` is
 * a word in the title's sentence. `No known test` was a description of a group
 * and could not be read as a noun phrase in that position; `Unknown test` can.
 * The *meaning* of each option is unchanged — `unknown` is still the bugs whose
 * summary names no test this tool holds, which `coverageLine` spells out beside
 * the window control ("683 of 1,170 bugs name no test this tool knows") rather
 * than relying on two words in a dropdown to do it.
 */
export const HARNESS_OPTIONS: readonly { value: string; label: string }[] = [
    { value: 'all', label: 'all' },
    { value: 'mochitest', label: 'Mochitest' },
    { value: 'xpcshell', label: 'XPCShell' },
    { value: 'unknown', label: 'Unknown test' },
];

/**
 * A `#harness=` value as `selectHarness` wants it.
 *
 * `undefined` for `all`, for an absent key, and for anything unrecognised. The
 * last of those is deliberate: a hash is user-editable text, and the safe answer
 * to `#harness=reftest` is the unfiltered ranking rather than an empty table
 * that looks like "no reftest bugs were annotated".
 */
export function parseHarness(value: string | undefined): HarnessSelector | undefined {
    return value === 'mochitest' || value === 'xpcshell' || value === 'unknown'
        ? value
        : undefined;
}

/** The dropdown value for a selector, inverting `parseHarness`. */
export function harnessValue(harness: HarnessSelector | undefined): string {
    return harness ?? 'all';
}

// --- what the page spends -------------------------------------------------

/**
 * How many requests a window costs, by kind, so the page can say so up front.
 *
 * **This exists because the honest number is not one, and is not obvious.**
 * `docs/PARITY.md` §1 counts four of six user-reported defects as "correct
 * numbers, wrong framing", and the framing defect this page is most exposed to
 * is a progress bar that reaches 100% while the page is still fetching. So the
 * plan is computed before any request is made, shown to the reader, and counted
 * down against.
 *
 * The three kinds, each measured against live `trunk` for a 21-day window ending
 * 2026-09-12:
 *
 * | kind | count | measured cost |
 * | --- | --- | --- |
 * | one `/api/failures/` per day — the ranking *and* the charts | **21** | ~8 kB each |
 * | Bugzilla summaries, batched at `BUG_BATCH_SIZE` = 500 | `ceil(1166/500)` = **3** | 0.7 s each |
 * | the published test lists, for classification | 2 | `{harness}-issues.json` ×2 |
 *
 * A fourth kind was here — a single whole-window `/api/failures/` returning
 * 1,167 rows — and it is gone: `rankingFromDays` carries the measurement
 * showing it is exactly the per-day rows summed.
 *
 * `summaries` is a **count of batches, not of bugs**, and that distinction is
 * carried here rather than collapsed because the CLI's own comment calls it out:
 * "the saving here is against *one per bug*, and understating the real load is
 * how a caller concludes this path is cheaper than it is."
 *
 * **A count of requests, not of round trips.** Most of these now run
 * concurrently — the 3 Bugzilla batches together, and the 21 per-day rankings a
 * few at a time — so the plan's total is what the page *asks for* rather than
 * how long it takes. That is the right number for this line anyway: the reader
 * is being told what the page is spending on their behalf, and a total that
 * shrank because requests were overlapped would understate that.
 *
 * The Bugzilla batches also **overlap the per-day requests** now rather than
 * following them: `summaryDispatcher` in `site/intermittent.ts` sends one as
 * soon as 500 distinct bug numbers are known, which on a live 21-day window is
 * after three of the twenty-one days. That changes nothing here — the count is
 * of requests, and the same requests are made — but it is why two phases can
 * name themselves on the line at once.
 */
export interface ScanPlan {
    /**
     * Per-day requests this run will make — the window's uncached days.
     *
     * These serve both the ranking and the sparklines now; see
     * `rankingFromDays`.
     */
    days: number;
    /** Bugzilla batches, from the candidate count. 0 before the ranking lands. */
    summaryBatches: number;
    /** Total requests the page will make, all kinds. */
    total: number;
}

/** `BUG_BATCH_SIZE` in `lib/sources/intermittents.ts`. Not imported — see below. */
const SUMMARY_BATCH = 500;

/**
 * The plan for a window, given how many candidates the ranking held.
 *
 * `candidates` is 0 on the first call, before the ranking has landed, which is
 * the state the first progress line is drawn from.
 *
 * `SUMMARY_BATCH` is a local constant rather than an import of
 * `BUG_BATCH_SIZE`, and that is the one place this file deliberately restates a
 * `lib/` number. The reason is the rule `test/framing.test.ts` states for its
 * own expectations: "an assertion that imports `DEFAULT_TYPES` and checks the
 * CLI uses `DEFAULT_TYPES` is worth nothing — it passes whatever the constant
 * says." A progress total computed from the same constant the client batches by
 * cannot ever disagree with it, so it would report a batch count that is right
 * by construction and wrong whenever the client's batching changes shape.
 * `test/intermittent-page.test.ts` asserts the predicted total against the
 * requests a real run makes, which is a check that can fail.
 */
export function scanPlan(days: number, candidates: number): ScanPlan {
    const summaryBatches = Math.ceil(candidates / SUMMARY_BATCH);
    // 2 test lists + the batches + one request per day. There is no separate
    // ranking request to count any more: the ranking is the per-day responses
    // summed, so the `1 +` that used to be here would have named a request the
    // page does not make. `rankingFromDays` carries why it is gone.
    return { days, summaryBatches, total: 2 + summaryBatches + days };
}

/**
 * The line shown while the page is loading, counting real requests.
 *
 * Phrased as "n of m requests" rather than a percentage: the reader of this page
 * is usually deciding whether to wait, and "14 of 36" answers that where "39%"
 * does not. `what` names the current kind so a run that stalls says *where* it
 * stalled.
 */
export function progressLine(done: number, plan: ScanPlan, what: string): string {
    return `${what} — ${done} of ${plan.total} requests`;
}

// --- what the page says about its own coverage ----------------------------

/**
 * The one compact line stating what is on screen and what is not.
 *
 * ## Why this is a line and not the five sentences it replaces
 *
 * It used to be `coverageSentences` + `depthSentence`: four or five sentences of
 * prose, ported almost verbatim from `coverageLines` in
 * `cli/commands/intermittent.ts`. That was the wrong move, and the reason is a
 * difference between the two media rather than a difference of opinion about the
 * facts. **A terminal has one shot**: it prints once, nothing is clickable,
 * nothing is beside anything, so it has to say everything in words. **A page has
 * a title, a column header, and the rows themselves** already doing that work —
 * so the same sentences on screen are re-stating what the reader can see, and
 * the page owner's verdict was that it is "way too long for anybody to read".
 *
 * What is kept is exactly the numbers that **change what the reader does**:
 *
 * - **the row count**, because it is the size of the problem;
 * - **how many bugs were classified**, because the harness column is only
 *   meaningful if the reader knows the classification is complete rather than a
 *   sample — this is the CLI's "depth", reduced to the number that carries it;
 * - **the excluded no-bug annotations**, because that is the one population the
 *   table cannot show at all, and leaving it out would make the table look like
 *   the whole of the window.
 *
 * `A · B · C`, which is this site's existing idiom for a status line —
 * `site/errors.ts` writes `${jobs} test jobs · ${markers} markers` the same way.
 *
 * ## What the no-silent-truncation rule became
 *
 * The rule stands and is now satisfied structurally rather than in prose: the
 * table draws **every** matching row (see `tableRows`), so there is no prefix to
 * confess to. The row count is still stated, because "427 rows" is the fact a
 * reader needs; what is gone is "the other 377 are ranked but not drawn",
 * because there is no longer an other.
 *
 * The harness breakdown that used to be here — mochitest / xpcshell / unknown —
 * is not lost either: it is what the dropdown in the title selects between, and
 * selecting one shows its own count in this same line.
 */
export function coverageLine(
    coverage: ScanResult['coverage'],
    harness: HarnessSelector | undefined,
    rows: number
): string {
    // The owner's own phrasing, verbatim as the pattern: "428 of 1,172 bugs are
    // for mochitests". A bare "428 of 1,172 bugs" was read as opaque, and the
    // reason is that the two numbers do not say what separates them — the
    // predicate is the whole point, so it is spelled out.
    const scanned = count(coverage.scanned);
    if (harness === undefined) {
        // Nothing is narrowing the list, so there is no "of" to state: the two
        // numbers would be the same one printed twice.
        const noun = rows === 1 ? 'bug' : 'bugs';
        return `${count(rows)} annotated ${noun}`;
    }
    if (harness === 'unknown') {
        return `${count(rows)} of ${scanned} bugs name no test this tool knows`;
    }
    return `${count(rows)} of ${scanned} bugs are for ${harness}s`;
}

/**
 * The window's volume, next to the window dropdown.
 *
 * `36,240 annotations over 21 days`, and nothing else. This replaced a
 * three-sentence `volumeNote` under the title plus a `27 requests, 2026-08-23 to
 * 2026-09-12` status line, both of which the page owner read and rejected: the
 * request count was "rather unclear" and the busiest-day and
 * "sums-to-less-than-this" sentences were "blah blah".
 *
 * What is kept is the one number that sizes the window, in the one place a
 * reader is already looking when they change the window. The facts that were
 * dropped from the prose are not lost — the no-bug exclusion moved into
 * `annotationsTooltip` below, and the date range and tree moved into
 * `windowScopeLine` — so nothing claims a completeness it does not have.
 */
export function volumeLine(series: VolumeSeries): string {
    const total = series.counts.reduce((sum, value) => sum + value, 0);
    return `${count(total)} annotations over ${series.counts.length} days`;
}

/**
 * Why the table sums to less than the annotations figure.
 *
 * The `3,351 untriaged excluded` fragment was on the coverage line as those
 * three words, and the owner's verdict was "I have no idea what that means, so I
 * can't guess if it's useful". It is useful — it is the one population the table
 * cannot show — so it moved here and is spelled out as a sentence instead: what
 * the annotations are, and the mechanism that keeps them off the table.
 *
 * This is what keeps the no-silent-truncation rule satisfied after the prose was
 * cut. The count stays **reachable** rather than stated in the page's own voice.
 */
export function annotationsTooltip(coverage: ScanResult['coverage']): string {
    if (coverage.noBugCount === 0) {
        return 'Every annotation in this window had a bug attached, so the table below accounts for all of them.';
    }
    return (
        `Includes ${count(coverage.noBugCount)} annotations where a sheriff starred a failure ` +
        'without attaching a bug. Those have no bug summary to read a test path from, so they ' +
        'cannot appear as rows and the table below sums to less than this.'
    );
}

/**
 * The tree and the date range, next to the window dropdown.
 *
 * These two facts were carried by the `<h2>` over the table
 * ("Sheriff-annotated mochitest intermittents on trunk, 2026-08-23 to
 * 2026-09-12"), which the owner removed the point of: "what's the point of this
 * section title when there's only one section in the entire page?". The heading
 * is gone, so the tree and the window's ends live here, beside the control that
 * sets them.
 *
 * The harness is **not** repeated here: it is the `<h1>`'s dropdown and the
 * coverage line's predicate already.
 */
export function windowScopeLine(tree: string, range: DayRange): string {
    return `${tree}, ${range.start} to ${range.end}`;
}

/** What the table says when the harness selection matched nothing. */
export function emptySelectionLine(
    harness: HarnessSelector | undefined,
    coverage: ScanResult['coverage']
): string {
    if (harness === undefined) {
        return 'No bug was annotated in this window.';
    }
    if (harness === 'unknown') {
        return `Every one of the ${count(coverage.scanned)} annotated bugs named a test this tool knows.`;
    }
    return `No bug among the ${count(coverage.scanned)} annotated named a verified ${harness} test.`;
}

// `rankingTitle` was here, building the `<h2>` over the table:
// "Sheriff-annotated mochitest intermittents on trunk, 2026-08-23 to
// 2026-09-12". Removed on the page owner's question — "what's the point of this
// section title when there's only one section in the entire page?" — which the
// `<h1>` and its harness dropdown already answer. The two facts it carried that
// nothing else did, the tree and the window's ends, are `windowScopeLine`.

/**
 * The words after the in-title harness dropdown.
 *
 * `initHarnessSwitcher` in `common-ui.js` builds an `<h1>` as
 * `[select] + ' ' + suffix` — one fixed suffix, whatever the selection — and
 * `issues.html`, `flaky.html` and `errors.html` all pass a constant. This page
 * does the same, and the constant is the owner's wording: the title reads
 * "[Mochitest] Intermittent failures".
 *
 * **Fixed rather than varying with the harness**, unlike `rankingTitle` above,
 * and the two coexist deliberately: the `<h1>` is the page's identity and must
 * not rewrite itself under a reader who changed one filter, while the heading
 * over the table says precisely what the table holds — the harness, the tree
 * and the window — because that is a caption for a specific list. That split is
 * what lets the `<h1>` stay short enough for a dropdown to sit inside it.
 *
 * "failures" and not "intermittents", because the selected word in front of it
 * is a harness or `Unknown test` and "[Mochitest] Intermittent failures" is the
 * phrase the owner asked for; the ranked heading below still says
 * "Sheriff-annotated …" in full, so what a row actually is stays on screen.
 */
export const TITLE_SUFFIX = 'Intermittent failures';

/** The `document.title` for a harness selection, matching the `<h1>`. */
export function documentTitle(harness: HarnessSelector | undefined): string {
    const label = HARNESS_OPTIONS.find((option) => option.value === harnessValue(harness))?.label;
    return `${label ?? 'all'} ${TITLE_SUFFIX}`;
}

// --- the table ------------------------------------------------------------

/**
 * There is **no row cap**, and that is a decision with a measurement behind it.
 *
 * There used to be one — `DEFAULT_ROWS = 50`, taken from the CLI's
 * `DEFAULT_LIMIT` — and the reason given for it was that "a thousand canvases is
 * a page that takes seconds to paint for rows nobody scrolls to". That reason
 * was about the *charts*, not about the rows, and it is answered by drawing the
 * charts lazily instead of by hiding data: `observeSparklines` in
 * `site/intermittent.ts` draws each canvas when it scrolls into view.
 *
 * The cost that reasoning was about, measured in a real browser on this page's
 * own markup (Chart.js, a 21-point series, a 120×28 box):
 *
 * | charts | blocking draw time |
 * | --- | --- |
 * | 50 | 38 ms |
 * | 200 | 178 ms |
 * | 430 | 397 ms |
 * | 800 | 903 ms |
 *
 * ~0.9 ms each, linear. The unfiltered 21-day `trunk` window has **1,170**
 * rows, so drawing every sparkline up front would be ~1.1 s of blocked main
 * thread — which is the jank the cap was avoiding, and is why the charts are
 * lazy rather than eager. The *rows* cost nothing like that: they are table
 * cells.
 *
 * A terminal genuinely cannot scroll a thousand rows, so the CLI keeps its
 * limit; the page has a scrollbar, and a cap there only hides data. This is a
 * declared framing divergence rather than a silent one.
 */

/** One row of the table, with everything the renderer needs. */
export interface IntermittentRow {
    bug: RankedIntermittent;
    /**
     * The bug's annotations per day across the window, oldest first, zero days
     * included — the sparkline's series.
     *
     * Zero days are the point, and `occurrenceHistory` in
     * `lib/query/intermittents.ts` records why at length: "1,116 annotations
     * over two weeks" reads the same whether they were spread evenly or landed
     * in one afternoon, and those are opposite answers — an intermittent to rank
     * against a regression to back out. A sparkline with the empty days dropped
     * would carry exactly that ambiguity into a picture, where it is harder to
     * notice than in a table.
     */
    history: OccurrenceDay[];
}

/**
 * The rows to draw: **every** row of the selection, each with its per-day series.
 *
 * No `limit` parameter, because there is nothing left to pass one for — see the
 * comment above on why the cap went. A one-to-one map rather than a slice, so
 * "the table shows the selection" is a property of this function rather than
 * something the caller has to get right.
 *
 * `histories` is a bug number to its per-day counts. A bug missing from it gets
 * an empty series rather than no row: the row's *count* came from the window
 * ranking and is real whether or not the per-day breakdown arrived, and dropping
 * the row would make a chart failure look like a data absence.
 */
export function tableRows(
    selected: readonly RankedIntermittent[],
    histories: ReadonlyMap<number, OccurrenceDay[]>
): IntermittentRow[] {
    return selected.map((bug) => ({ bug, history: histories.get(bug.bugId) ?? [] }));
}

/**
 * Whether a row's sparkline is worth drawing.
 *
 * A series of one point is not a trend, and a flat line of zeros is a chart that
 * says nothing while occupying a cell and a canvas. Both are drawn as nothing,
 * which leaves the row's count — the number the ranking is on — as the only
 * thing in the cell, which is the honest reading.
 */
export function sparklineVisible(history: readonly OccurrenceDay[]): boolean {
    return history.length > 1 && history.some((day) => day.count > 0);
}

/**
 * A row's own y-axis maximum: its peak, never zero.
 *
 * ## Why the scale is no longer shared across rows
 *
 * It used to be one maximum over every drawn row, so that the reader could
 * compare heights down the column. **Measured on live `trunk` for the default
 * 21-day window (2026-08-23..2026-09-12), that made most of the column
 * unreadable**: the shared maximum is 414 (bug 2064985's worst day), and against
 * it, in a 28px-tall cell,
 *
 * | row | own peak | tallest point drawn |
 * | --- | --- | --- |
 * | #1 bug 2060167 | 193 | 13.1px |
 * | #8 bug 2064985 | 414 | 28.0px |
 * | #10 bug 2021221 | 70 | 4.7px |
 * | #30 bug 2070019 | 47 | 3.2px |
 *
 * and **19 of the 50 drawn rows had their entire series inside 2px** of the
 * 28px cell. A line that never leaves the bottom two pixels has no shape to
 * read, which is the owner's report — "after the first few bugs, the charts look
 * mostly flat" — as a number.
 *
 * ## Per-row rather than a log scale
 *
 * Both fix the flatness. A log axis was rejected for two reasons specific to
 * this data. A count series contains **zeros** — 15 of those 50 rows start with
 * at least one zero day — and zero has no place on a log axis, so every such day
 * would have to be clamped or dropped, which is a decision about the data made
 * to suit the axis. And a log axis silently rescales *shape*: a spike from 3 to
 * 300 and one from 3 to 30 draw nearly the same picture, so the column would
 * stop lying about magnitude and start lying about trend, which is the thing the
 * column is for.
 *
 * ## What stops per-row scaling from misleading
 *
 * Per-row scaling means two rows' line heights are **not** comparable, so the
 * magnitude has to be legible without them. It is, three times over, and this
 * is the condition the change rests on rather than a hope:
 *
 * - the row's `Annotations` cell is the window total, in the column the table is
 *   ranked by, immediately to the left of the chart;
 * - the sparkline's tooltip gives the exact count for the hovered day;
 * - the cell carries the row's own peak as a label (`sparklinePeakLabel`), so
 *   "what does the top of this line mean" is answered in place.
 *
 * `site/flaky.ts`'s inline charts already scale to their own data for the
 * analogous reason recorded there — a shared 0-100 axis "made these charts look
 * broken" — so this is the same answer to the same question rather than a new
 * policy.
 */
export function sparklinePeak(history: readonly OccurrenceDay[]): number {
    return Math.max(1, ...history.map((day) => day.count));
}

/**
 * The label that makes a per-row scale honest: "peak N/day".
 *
 * Required, not decorative. With one maximum per row, the only thing that says
 * what the top of the line is worth is this, and without it a reader comparing
 * two rows' shapes would reasonably read them as comparable heights. Kept to the
 * peak rather than the whole axis because a sparkline has no axis to label.
 */
export function sparklinePeakLabel(history: readonly OccurrenceDay[]): string {
    return `peak ${sparklinePeak(history).toLocaleString('en-US')}/day`;
}

/**
 * How a zero day should be drawn, per the owner's three cases.
 *
 * A zero in this series is not one thing, and the distinction is worth colour
 * because it is the difference between good news and no news:
 *
 * - **`leading`** — zero *before the bug's first annotation in the window*. The
 *   bug was not failing yet, or had not been filed; either way this is the
 *   absence of data rather than an achieved zero. Drawn in grey. 15 of the 50
 *   rows on the measured window have at least one.
 * - **`fixed`** — zero on a **resolved** bug, after it has appeared. Somebody
 *   closed the bug and it stopped failing, which is the outcome a burndown is
 *   for. Drawn in green.
 * - **`quiet`** — zero on an **open** bug after it has appeared. An intermittent
 *   that simply did not fire that day. Drawn in the series colour like any other
 *   point, because nothing has been achieved.
 *
 * **The ambiguous case, and what was chosen.** A zero on a resolved bug that
 * falls *between* two failing days is `fixed` by this rule, which slightly
 * overstates the good news — the bug was still failing the next day. The honest
 * alternative would be to green only the run of zeros that reaches the end of
 * the window. That was rejected because it makes the colour depend on where the
 * window happens to end: a bug fixed yesterday would go green tomorrow and not
 * today. Instead the rule is local and stated, and the row has a count and a
 * tooltip for the reader who wants the detail — a green day in the middle of a
 * spiky line is visibly not a fix, and a green tail on a falling line visibly
 * is.
 *
 * `resolved` is the row's own `resolution !== ''`, so an open bug never draws a
 * green day whatever its shape.
 */
export type ZeroDayKind = 'leading' | 'fixed' | 'quiet';

/** How each day of a row's series should be coloured. `null` where count > 0. */
export function zeroDayKinds(
    history: readonly OccurrenceDay[],
    resolved: boolean
): (ZeroDayKind | null)[] {
    const firstFailure = history.findIndex((day) => day.count > 0);
    return history.map((day, index) => {
        if (day.count > 0) {
            return null;
        }
        // Before the first annotation — or the bug never appears at all, which
        // `findIndex` returns -1 for and which is every day being "leading".
        if (firstFailure === -1 || index < firstFailure) {
            return 'leading';
        }
        return resolved ? 'fixed' : 'quiet';
    });
}

/** The Bugzilla link for a bug number. */
export function bugUrl(bugId: number): string {
    return `https://bugzilla.mozilla.org/show_bug.cgi?id=${bugId}`;
}

// --- the window's overall volume, which is no longer a chart ---------------

/**
 * The window's per-day annotation totals.
 *
 * ## The chart this used to feed, and why it was removed
 *
 * There was a bar chart at the top of the page plotting these totals, one bar a
 * day. It was removed, and the decision was **measured rather than judged**,
 * because the proposal on the table was to keep it and desaturate all but the
 * share attributable to the row under the pointer.
 *
 * That highlight was measured against live `trunk` over
 * 2026-08-23..2026-09-12 — the page's own default window — on the 50 rows the
 * table draws, at the chart's real 200px plot height:
 *
 * | | |
 * | --- | --- |
 * | largest share any single top-50 bug holds of any one day's bar | **15.8%** |
 * | median row's best day, as a share of the tallest bar | **1.80%** (3.6px) |
 * | rows whose highlight would be under 3px on **more than two-thirds** of the bars | **44 of 50** |
 * | rows where at least 7 of the 21 bars would show a ≥3px highlight | **6 of 50** |
 * | median row's highlight, averaged over the 21 bars | **0.8–1.4px** |
 *
 * So for 44 of the 50 rows a reader hovering the row would have seen nothing
 * move. The owner's own guess — "I suspect that will remain a very low part of
 * it" — is what the numbers say, and the reason is structural rather than a
 * matter of scale: the ranking is long-tailed and the largest group of
 * annotations has no bug attached at all (46-59% of a day's bar is outside the
 * drawn rows entirely), so no single row can be a large share of a day.
 *
 * A chart whose only interaction is invisible on 88% of the rows, and which
 * otherwise says "CI is busier on weekdays", does not earn 200px above the
 * table. So it is gone, and what it was actually carrying — the total, and the
 * fact that the no-bug group is in it and not in the table — is now a sentence
 * (`volumeNote`), which is where a fact that never varies belongs.
 *
 * **The per-day requests are still made**, and are not waste: they are what
 * every row's sparkline is built from (`historiesFromDays`), which is the part
 * of the charting the measurement says does work.
 */
export interface VolumeSeries {
    /** `MM-DD`, one per day of the window. */
    labels: string[];
    /** Annotations that day, across every bug and the no-bug group. */
    counts: number[];
    /** The full `YYYY-MM-DD` dates. */
    dates: string[];
}

/**
 * The overall-volume series, from the per-day rankings.
 *
 * **Every annotation of the day, the no-bug group included.** The question is
 * "how much sheriff time did this window cost", and the annotations with no bug
 * attached cost exactly as much as the rest — they are regularly the largest
 * single group (`ScanCoverage.noBugCount`), so excluding them would state a
 * total for a minority and label it as the whole.
 *
 * That makes this total deliberately larger than the sum of the table's rows,
 * and `volumeNote` is where the page says so. A total on screen that disagrees
 * with its own table, with nothing explaining why, is the defect
 * `lib/query/intermittents.ts`'s `summariseBug` comment calls "a header total
 * that disagrees with its own table".
 */
export function volumeSeries(perDay: ReadonlyMap<string, number>, range: DayRange): VolumeSeries {
    const dates = daysOfWindow(range);
    return {
        labels: dates.map((date) => date.slice(5)),
        counts: dates.map((date) => perDay.get(date) ?? 0),
        dates,
    };
}

// `volumeNote` was here: a three-sentence paragraph under the title carrying the
// window total, the no-bug exclusion, the "sums to less than this" caveat and the
// busiest day. The page owner read all four and kept one — see `volumeLine`,
// which is the total alone and sits beside the window dropdown, and
// `annotationsTooltip`, which is where the exclusion went.

/**
 * The window's ranking, summed from the per-day rankings.
 *
 * ## The request this replaces, and the measurement that allowed it
 *
 * The page used to open with `/api/failures/` for the **whole window** — one
 * request whose result named the candidate bugs — and only then start the 21
 * per-day `/api/failures/` requests the sparklines need. The page owner asked
 * whether the first was simply the sum of the others: "Isn't the first one the
 * sum of the individual days, can't we just do the individual day requests and
 * add up their results?"
 *
 * **Measured against live `trunk`, it is.** Whole window
 * `startday=2026-08-25&endday=2026-09-14` against the 21 single-day requests
 * that tile it (`endday` is inclusive, so a day is `startday==endday`; verified
 * because `09-01..09-02` returns 4,685 = 2,287 + 2,398):
 *
 * | | whole window | summed days |
 * | --- | --- | --- |
 * | distinct `bug_id`s | 1,156 | 1,156 |
 * | sum of `bug_count` | 36,401 | 36,401 |
 * | the `bug_id: null` group | 3,226 | 3,226 |
 * | `bug_id`s in one side only | — | 0 |
 * | `bug_id`s whose counts differ | — | 0 |
 *
 * Neither side is capped or paginated: the response is a bare array with no
 * `count`/`next` wrapper, `page`, `limit`, `count` and `offset` are ignored
 * (byte-identical responses), the window's tail holds 289 entries of
 * `bug_count: 1`, and a 90-day window returns 2,529 entries and a 180-day one
 * 3,119 rather than plateauing.
 *
 * So the whole-window request was one round trip the page **blocked on** for
 * data it was about to fetch again, and it is gone. Measured in headless Chrome
 * against live Treeherder on a default 21-day load, five runs each side: the
 * medians are **5,597 ms before and 4,885 ms after**, and the page makes 21
 * `/api/failures/` requests where it made 22.
 *
 * ## Order is not inherited, and does not need to be
 *
 * Treeherder returns the window count-descending. Summing days cannot preserve
 * an upstream tie order — in the window above, bugs 2064983 and 1984528 both
 * read 413 and the two sides ordered that pair differently. It does not matter
 * here: `scanBugs` in `lib/query/intermittents.ts` re-sorts by count descending
 * and its comment already states that the order is its own contract rather than
 * an upstream detail. The counts, which are what the ranking is, are identical.
 *
 * ## Shape
 *
 * `BugFailureCount[]`, the same type `rankBugs` returns, so `scanBugs` takes
 * this with no change: one entry per bug plus the `bugId: null` group when the
 * days carried one, because `ScanCoverage.noBugCount` is computed from it.
 */
export function rankingFromDays(
    perDay: ReadonlyMap<string, ReadonlyMap<number, number>>,
    /** Each day's whole-day total, including its no-bug annotations. */
    totals: ReadonlyMap<string, number>
): BugFailureCount[] {
    const counts = new Map<number, number>();
    for (const day of perDay.values()) {
        for (const [bug, count] of day) {
            counts.set(bug, (counts.get(bug) ?? 0) + count);
        }
    }
    const rows: BugFailureCount[] = [...counts].map(([bugId, count]) => ({ bugId, count }));
    // The no-bug group is the day's total less what its bugs accounted for.
    // Treeherder reports it as a `bug_id: null` row and `volumeSeries` is
    // already totalling every annotation of the day, bug or not, so the
    // difference is exactly that row — no separate source needed.
    let noBug = 0;
    for (const [date, total] of totals) {
        let attributed = 0;
        for (const count of perDay.get(date)?.values() ?? []) {
            attributed += count;
        }
        noBug += total - attributed;
    }
    if (noBug > 0) {
        rows.push({ bugId: null, count: noBug });
    }
    return rows.sort((a, b) => b.count - a.count);
}

/**
 * Per-bug per-day counts, from the same per-day rankings `volumeSeries` totals.
 *
 * **This is the mechanism that makes per-row sparklines affordable**, and it is
 * worth stating precisely because the obvious implementation is far more
 * expensive.
 *
 * There are three ways to get a bug's per-day series from Treeherder, and all
 * three were measured against live `trunk` on a 21-day window. The choice is a
 * cost question only — **they agree on the numbers** (bug 2060167 over
 * 2026-09-01..05 reads 182/193/160/99/17 by every route):
 *
 * | route | cost | scales with |
 * | --- | --- | --- |
 * | `/api/failuresbybug/` per bug | **2.2 MB, 5.4 s** | rows |
 * | `/api/failurecount/?bug=` per bug | 1.2 kB, 0.4-1.5 s | rows |
 * | `/api/failures/` per **day** | ~8-11 kB, 0.5 s each | **days** |
 *
 * **The per-day route is the only one whose cost does not grow with the table**,
 * and that is what decides it: one request per day of the window returns *that
 * day's whole per-bug breakdown*, so 21 requests serve every row at once. The
 * table is now uncapped at 1,170 rows on the default window, so the two per-bug
 * routes would be 1,170 requests — `/api/failurecount/` does not accept
 * `bug=a,b` (HTTP 400, measured), so there is no batching to close that gap.
 *
 * `/api/failuresbybug/` is the most expensive of the three because each
 * occurrence carries its job's full `TEST-UNEXPECTED-FAIL` log lines; fifty rows
 * of it is over a hundred megabytes. It is what
 * `fx-tests intermittent --bug <id> --history` uses and what
 * `occurrenceHistory` in `lib/query/intermittents.ts` is written against, and
 * the page does call it — but only for **one** bug, when a row is expanded,
 * where its per-job and per-platform dimensions are the point.
 *
 * `/api/failurecount/` also carries `test_runs`, a per-day denominator the
 * per-day route does not give, so it is the right source for a *rate*. Without a
 * `bug` it returns the tree-wide daily series in one request — measured at
 * **19.1 s**, so it is not a drop-in for anything the page blocks on.
 *
 * What this does instead: `/api/failures/` for **one day** returns that day's
 * whole per-bug breakdown — 255 rows and ~8 kB, measured on 2026-09-05 — so 21
 * such requests give every bug's per-day series at once. The window's 21 days
 * cost ~180 kB in total and serve every sparkline together.
 *
 * **Verified equal to the expensive path, not assumed.** Against live `trunk`,
 * per-day `/failures/` against a tally of `/failuresbybug/`'s `pushTime`s:
 *
 * | bug | day | per-day ranking | occurrence tally |
 * | --- | --- | --- | --- |
 * | 2060167 | 2026-09-05 | 17 | 17 |
 * | 2060167 | 2026-09-06 | 12 | 12 |
 * | 2060167 | 2026-09-02 | 193 | 193 |
 * | 2021221 | 2026-09-02 | 66 | 66 |
 *
 * The shape returned is `OccurrenceDay[]` — the same type `occurrenceHistory`
 * returns — so the sparkline is fed the type the library already defines for
 * "annotations per day, zero days included" rather than a second one meaning the
 * same thing.
 */
export function historiesFromDays(
    perDayRankings: ReadonlyMap<string, ReadonlyMap<number, number>>,
    range: DayRange
): Map<number, OccurrenceDay[]> {
    const dates = daysOfWindow(range);
    const bugs = new Set<number>();
    for (const day of perDayRankings.values()) {
        for (const bug of day.keys()) {
            bugs.add(bug);
        }
    }
    const histories = new Map<number, OccurrenceDay[]>();
    for (const bug of bugs) {
        histories.set(
            bug,
            // Enumerated over the window rather than over the days that had a
            // row, so a bug that stopped failing has trailing zeros and a bug
            // that started has leading ones. That contrast — new versus fixed —
            // is what the per-row chart is for.
            dates.map((date) => ({ date, count: perDayRankings.get(date)?.get(bug) ?? 0 }))
        );
    }
    return histories;
}

// --- the expanded row's drill-down ----------------------------------------

/**
 * One section of an expanded row: a heading and its count-descending tally.
 *
 * The sections and their **order** are the CLI's, from `renderBugText` in
 * `cli/commands/intermittent.ts`, because the two sides answering "where does
 * this bug fail" in a different order is the framing defect `docs/PARITY.md`
 * §1 names. In particular the failure messages come **first**, ahead of the
 * grouping axes, and the CLI's comment says why: it is what the annotated jobs
 * actually printed, which is the question a drill-down is opened to answer,
 * where the axes are things a reader can already guess.
 */
export interface DrilldownSection {
    heading: string;
    rows: readonly SuiteCount[];
    /**
     * How wide the section is drawn: a column, or the panel's full width.
     *
     * The page owner's report set this split: "it's good to use columns for job
     * names …, platform, build types and tree info. But 'failure messages' and
     * 'Test names' need a much larger width, maybe they should be on their own
     * rather than columns. Currently their cells's content wraps across many
     * lines."
     *
     * So it is a property of the section's **values**, not of its position: a
     * job name, a platform, a build type and a tree name are all short enough to
     * read side by side, while a `TEST-UNEXPECTED-FAIL` line and a test path are
     * long strings that a column's width turns into five wrapped lines.
     */
    width: 'column' | 'full';
    /**
     * What to say when the tally is empty, or `null` to omit the section.
     *
     * Only the tests section has one. The CLI states it rather than printing
     * nothing, for the reason it records: an empty `Tests named` reads as "this
     * bug has no test", which is a claim about Firefox rather than about the
     * data — Treeherder only keeps log lines matching `TEST-UNEXPECTED-FAIL`.
     */
    emptyNote: string | null;
}

/**
 * The sections an expanded row shows, in the CLI's order.
 *
 * **No per-section row cap**, where the CLI has `DRILLDOWN_ROWS = 10`. Its
 * reason is explicitly about a terminal — "the drill-down prints six sections at
 * once, so twenty each would be 120 lines" — and a panel inside a table row
 * scrolls with the page. Same reasoning as the table's own cap: the medium
 * differs, so the number does.
 */
export function drilldownSections(drilldown: BugDrilldown): DrilldownSection[] {
    return [
        // The four short-valued axes first, as a row of columns.
        //
        // `Job names` and not `Job names, chunk numbers merged`: the page owner
        // asked for that suffix to go, and the behaviour it described has not
        // changed — `BugDrilldown.jobNames` is where the chunk stripping is
        // documented, and the heading carries a `title` saying so rather than
        // spending column width on it.
        { heading: 'Job names', rows: drilldown.jobNames, emptyNote: null, width: 'column' },
        { heading: 'Platforms', rows: drilldown.platforms, emptyNote: null, width: 'column' },
        { heading: 'Build types', rows: drilldown.buildTypes, emptyNote: null, width: 'column' },
        { heading: 'Trees', rows: drilldown.trees, emptyNote: null, width: 'column' },
        // Then the two long-valued ones, each on its own full-width row. The
        // failure messages lead, because they are what a drill-down is opened to
        // read — the CLI's own comment for putting them first.
        {
            heading: 'Failure messages, per annotated job',
            rows: drilldown.lines,
            emptyNote: null,
            width: 'full',
        },
        {
            heading: 'Tests named, per annotated job',
            rows: drilldown.tests,
            emptyNote:
                'No occurrence carried a TEST-UNEXPECTED-FAIL line naming a test — the API ' +
                'only keeps lines matching that marker.',
            width: 'full',
        },
    ];
}

/** The `title` explaining what `Job names` merges, now that the heading does not. */
export const JOB_NAMES_TITLE =
    'Chunk numbers are merged: mochitest-browser-chrome-1 … -12 count as one job name.';

/**
 * The line above an expanded row's sections.
 *
 * Mirrors the CLI's `drilldownCountLine`: `127 of 168` when a filter is
 * narrowing and a bare count otherwise, because "a filtered number on its own is
 * indistinguishable from the bug having got quieter". The page applies no
 * filter, so in practice it is the bare count — the branch is kept so the two
 * sides cannot drift if one is ever added.
 *
 * The unclassified count rides along for the reason `BugDrilldown` gives: it
 * keeps "this bug is all mochitest" distinguishable from "some of its jobs were
 * not classified".
 */
export function drilldownCountLine(drilldown: BugDrilldown, tree: string, range: DayRange): string {
    const scope =
        drilldown.occurrences === drilldown.totalOccurrences
            ? `${count(drilldown.occurrences)} sheriff annotations`
            : `${count(drilldown.occurrences)} of ${count(drilldown.totalOccurrences)} ` +
              'sheriff annotations match the filter';
    const line = `${scope} on ${tree}, ${range.start} to ${range.end}`;
    if (drilldown.unclassifiedOccurrences === 0) {
        return line;
    }
    return (
        `${line} · ${count(drilldown.unclassifiedOccurrences)} on a job that is neither ` +
        'mochitest nor xpcshell'
    );
}

/** What an expanded row shows while its occurrences are in flight. */
export function drilldownLoadingLine(bugId: number): string {
    // Named cost, not a bare spinner. `/api/failuresbybug/` was measured at
    // 2.2 MB and 5.4 s for one bug, so a reader who is told nothing reasonably
    // concludes the page is broken before it answers.
    return `Loading every annotated job for bug ${bugId} — this is the page's one large request.`;
}

/** What an expanded row shows when its fetch failed. */
export function drilldownErrorLine(bugId: number, message: string): string {
    // Stated in the panel rather than collapsing the row: a row that springs
    // shut on click is indistinguishable from a broken click handler.
    return `Could not load bug ${bugId}'s annotated jobs: ${message}`;
}

// --- URL state ------------------------------------------------------------

/** The hash state this page carries. */
export interface UrlState {
    /** `21days`, or any `<n>days`. */
    date: string;
    /** `all`, `mochitest`, `xpcshell` or `unknown`. */
    harness: string;
    /** The repository or repo group. */
    tree: string;
}

/**
 * The default tree.
 *
 * `trunk`, matching the CLI's default and Treeherder's own intermittents view.
 * It is a repo *group* rather than a repository — `TREE_GROUPS` in
 * `lib/sources/intermittents.ts` lists the three the API accepts — so the
 * default covers autoland, mozilla-central and the rest of trunk together,
 * which is the population a sheriff is triaging.
 */
export const DEFAULT_TREE = 'trunk';

/** Reads the three keys this page uses out of a parsed hash. */
export function readUrlState(params: URLSearchParams): Partial<UrlState> {
    const state: Partial<UrlState> = {};
    for (const key of ['date', 'harness', 'tree'] as const) {
        const value = params.get(key);
        if (value !== null) {
            state[key] = value;
        }
    }
    return state;
}

/**
 * The hash this page writes, omitting keys that are at their default.
 *
 * Omitted rather than written, so a shared link carries what the sender changed
 * and nothing else — and so `#date=21days` stays a URL a reader can type. The
 * default window is written **explicitly** even though it is the default,
 * because that is the URL the owner pastes between pages and a hash that
 * silently drops it would make the two pages' links look different.
 */
export function writeUrlState(state: UrlState): Record<string, string> {
    const hash: Record<string, string> = { date: state.date };
    if (state.harness !== 'all') {
        hash['harness'] = state.harness;
    }
    if (state.tree !== DEFAULT_TREE) {
        hash['tree'] = state.tree;
    }
    return hash;
}

/**
 * Thousands separators, as the shared scripts' `formatNumber` does.
 *
 * Local rather than a call to that global, because this file has no DOM and no
 * `window`: it is imported by tests that never build a page. The one rule it
 * has to match is the one the CLI's `count()` and `common-ui.js`'s
 * `formatNumber` both implement, and `toLocaleString('en-US')` is what the
 * latter uses.
 */
function count(value: number): string {
    return value.toLocaleString('en-US');
}

export type { HarnessSelector, OccurrenceDay, RankedIntermittent };
