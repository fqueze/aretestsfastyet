/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * `intermittent.html` against `fx-tests intermittent`, on one recorded window.
 *
 * `docs/PARITY.md` §5: cheap once both sides are on `lib/`, because the page
 * exposes its view model as a design property. The four classes it names are the
 * four sections below — **value**, **order**, **framing** and **universe** — and
 * each has its own reason for existing, taken from the six defects §1 counts:
 *
 * - **Value** — four of the six produced correct numbers, so this is necessary
 *   and not sufficient.
 * - **Order** — the sort-key defect produced *the same set in a different
 *   order*, which no set comparison can see. So the whole ranked sequence is
 *   compared position by position, and each side is separately checked to be
 *   descending — an order that matched while both were wrong would pass the
 *   sequence check alone.
 * - **Framing** — the class §1 says was never tested and where the two worst
 *   reports landed. Asserted partly against the controller's *source*, so a page
 *   that agrees on a label while reading a different thing still fails.
 * - **Universe** — added after `try --all-jobs`, and §1's lesson is the sharp
 *   one: "a field whose two sides are prose can only detect a difference someone
 *   wrote down. Every dimension needs a quantity the CLI emits." The quantity
 *   here is **the number of requests each side makes, by kind**, counted off
 *   recording fakes on both sides rather than described.
 *
 * ## The one thing this file has that the other parity tests do not
 *
 * Both sides read a **live API**, so both are driven through recording fakes
 * over the same fixture — `test/fixtures/intermittents-trunk-2026-08-10.json`,
 * which `test/intermittents-fixture-gen.ts` recorded from real Treeherder and
 * Bugzilla. That is what makes the comparison single-variable in the sense §2
 * requires: identical bytes into both sides, so a disagreement is presentation
 * or framing and cannot be a difference in the data.
 *
 * It also means the **universe** check is unusually strong here. The page
 * deliberately does not make the one request the CLI makes per drilled bug
 * (`/api/failuresbybug/`, measured at 2.2 MB for one row on live trunk), and
 * instead makes one per day of the window. Those are different universes of
 * requests for the same numbers, which is exactly the kind of difference the
 * `filters`-versus-`universe` conflation used to hide — so it is declared, with
 * the quantity behind it.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupPage, fixture } from './dom-harness.ts';
import {
    type Divergence,
    assertDeclaredDivergences,
    assertSameOrder,
    invoke,
    json,
    rankingByDay,
} from './parity-harness.ts';
import { daysOfWindow } from '../site/intermittent-view.ts';
import type {
    BugFailureCount,
    BugFailureDay,
    BugOccurrence,
    DayRange,
    IntermittentsClient,
} from '../lib/sources/intermittents.ts';
import { type BugInfo, BUG_BATCH_SIZE } from '../lib/sources/intermittents.ts';
import type { DataFileName, DataSource } from '../lib/sources/source.ts';
import type { IntermittentListJson } from '../cli/commands/intermittent.ts';
import { DEFAULT_LIMIT } from '../cli/commands/intermittent.ts';

// --- the shared fixture, and the fakes both sides read it through ----------

interface Fixture {
    tree: string;
    startday: string;
    endday: string;
    failures: { bug_id: number | null; bug_count: number }[];
    summaries: Record<string, string>;
    /** Each bug's recorded Bugzilla `status` and `resolution`. */
    bugStates: Record<string, { status: string; resolution: string }>;
    knownTestPaths: { mochitest: string[]; xpcshell: string[] };
    failuresbybug: Record<
        string,
        { bug_id: number | null; push_time: string; test_suite: string; [key: string]: unknown }[]
    >;
}

const raw = fixture<Fixture>('intermittents-trunk-2026-08-10.json');
const RANGE: DayRange = { start: raw.startday, end: raw.endday };

/** How many days the fixture's recorded window spans. */
const WINDOW_DAYS =
    Math.round(
        (Date.parse(`${RANGE.end}T00:00:00Z`) - Date.parse(`${RANGE.start}T00:00:00Z`)) /
            (24 * 60 * 60 * 1000)
    ) + 1;

/**
 * The day both sides' windows end on — **today**, not the fixture's last day.
 *
 * The awkward fact this file has to accommodate: the CLI has no way to be pinned
 * to a past *multi-day* window. `--day` is one day and `--since n` ends at
 * today, so the only range both sides can be made to ask for is "the last
 * `WINDOW_DAYS` days". `resolveRange`'s own tests cover the arithmetic; what
 * matters here is that **both sides ask for the same range**, which is what
 * makes the comparison single-variable.
 *
 * The fixture's recorded rows are then re-dated onto that window by offset —
 * `fixtureClient` does it — so the per-day breakdown still has the shape the
 * recording captured. Nothing here depends on today's date being any particular
 * day, which is the property that keeps this test from failing tomorrow.
 */
const WINDOW_END = new Date().toISOString().slice(0, 10);

/**
 * The fixture through a recording client.
 *
 * One builder for both sides, so "same inputs" is a fact about the code rather
 * than about two fakes a reader has to compare by eye. `calls` is what the
 * universe section counts.
 *
 * **What decides which answer a request gets is the range's width, not its
 * dates.** A request for a whole span gets the recorded ranking; a request for
 * one day gets that day's share of it, split by `rankingByDay` so **the days
 * sum to the window exactly**. That is the relationship live Treeherder really
 * has — measured bug-for-bug and day-for-day, see `rankingFromDays` in
 * `site/intermittent-view.ts` — and it is the relationship the page now depends
 * on, because its ranking *is* those days summed. A fake whose days summed to
 * something else would make the page and the CLI disagree here for a reason
 * Treeherder does not have.
 *
 * `widthOf` is how the two are told apart, and it is deliberately keyed on the
 * *width* rather than on the literal dates: neither side's window can be pinned
 * to the fixture's recorded dates (see `WINDOW_END`), so a fake keyed on dates
 * would answer nothing at all. The per-day split is keyed on the day's **offset
 * back from `WINDOW_END`** for the same reason, so the sliding window sees the
 * same shape whatever today is.
 */
const RANKING_BY_DAY = rankingByDay(
    raw.failures.map((entry) => ({ bugId: entry.bug_id, count: entry.bug_count })),
    daysOfWindow(RANGE)
);

function fixtureClient(): IntermittentsClient & { calls: string[] } {
    const calls: string[] = [];
    const widthOf = (range: DayRange): number =>
        Math.round(
            (Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) /
                (24 * 60 * 60 * 1000)
        ) + 1;
    return {
        calls,
        async rankBugs(_tree: string, range: DayRange): Promise<BugFailureCount[]> {
            const window = widthOf(range) > 1;
            calls.push(window ? 'failures-window' : `failures-day:${range.start}`);
            if (window) {
                return raw.failures.map((entry) => ({
                    bugId: entry.bug_id,
                    count: entry.bug_count,
                }));
            }
            // One day, re-dated onto the fixture's recorded span by its offset
            // back from `WINDOW_END`. A day outside the window gets nothing —
            // a real answer rather than a fake's failure, and what `loadDays`'s
            // missing-day path is written for.
            const offset =
                Date.parse(`${range.start}T00:00:00Z`) - Date.parse(`${WINDOW_END}T00:00:00Z`);
            const recorded = new Date(Date.parse(`${raw.endday}T00:00:00Z`) + offset)
                .toISOString()
                .slice(0, 10);
            return RANKING_BY_DAY.get(recorded) ?? [];
        },
        async occurrencesOfBug(): Promise<BugOccurrence[]> {
            calls.push('failuresbybug');
            return [];
        },
        async failureCountOfBug(): Promise<BugFailureDay[]> {
            calls.push('failurecount');
            return [];
        },
        async runIdsOfJobs(): Promise<Map<number, number>> {
            calls.push('runids');
            return new Map();
        },
        async bugSummaries(bugs: readonly number[]): Promise<Map<number, BugInfo>> {
            for (let i = 0; i < bugs.length; i += BUG_BATCH_SIZE) {
                calls.push('bugzilla-batch');
            }
            return new Map(
                bugs.flatMap((bug) => {
                    const summary = raw.summaries[String(bug)];
                    if (summary === undefined) {
                        return [];
                    }
                    // Recorded, and identical on both sides of the parity
                    // check: the resolution is an input both the page and the
                    // command classify from, so a fake that differed between
                    // them would manufacture a divergence.
                    const state = raw.bugStates[String(bug)];
                    return [
                        [
                            bug,
                            {
                                summary,
                                status: state?.status ?? '',
                                resolution: state?.resolution ?? '',
                            },
                        ] as [number, BugInfo],
                    ];
                })
            );
        },
    };
}

/** The two published test lists, as both sides' `loadHarnessOfPath` reads them. */
function issuesSource(): DataSource & { requested: string[] } {
    const requested: string[] = [];
    return {
        name: 'fixture-issues',
        requested,
        fetch(name: DataFileName): Promise<Uint8Array> {
            requested.push(name.filename);
            const harness = name.filename.startsWith('mochitest') ? 'mochitest' : 'xpcshell';
            const paths = raw.knownTestPaths[harness as 'mochitest' | 'xpcshell'];
            const dirs: string[] = [];
            const names: string[] = [];
            const testPathIds: number[] = [];
            const testNameIds: number[] = [];
            for (const full of paths) {
                const cut = full.lastIndexOf('/');
                const dir = cut === -1 ? '' : full.slice(0, cut);
                if (!dirs.includes(dir)) {
                    dirs.push(dir);
                }
                names.push(cut === -1 ? full : full.slice(cut + 1));
                testPathIds.push(dirs.indexOf(dir));
                testNameIds.push(names.length - 1);
            }
            return Promise.resolve(
                new TextEncoder().encode(
                    JSON.stringify({
                        metadata: { generatedAt: '2026-08-17T00:00:00Z' },
                        tables: { testPaths: dirs, testNames: names },
                        testInfo: { testPathIds, testNameIds },
                    })
                )
            );
        },
    };
}

/** The CLI's ranking for the fixture window, every row, plus what it spent. */
async function cliRanking(extra: string[] = []): Promise<{
    result: IntermittentListJson;
    calls: string[];
    requested: string[];
}> {
    const client = fixtureClient();
    const source = issuesSource();
    const result = await invoke(
        // `--limit 0` is every row: the comparison is over the whole ranking, not
        // over whichever prefix the two sides happen to print. `--since` rather
        // than `--day`, so the CLI covers the same multi-day window the page
        // does — see `WINDOW_END`.
        ['intermittent', '--json', '--limit', '0', '--since', String(WINDOW_DAYS), ...extra],
        { intermittents: client, source }
    );
    assert.equal(result.code, 0, `the command must succeed: ${result.stderr}`);
    return {
        result: json<IntermittentListJson>(result),
        calls: client.calls,
        requested: source.requested,
    };
}

/** The page's ranking for the same window, plus what it spent. */
async function pageRanking(
    tag: string,
    hash = `#date=${WINDOW_DAYS}days`
): Promise<{
    state: ReturnType<typeof import('../site/intermittent.ts').parityState>;
    page: ReturnType<typeof setupPage>;
    calls: string[];
    requested: string[];
}> {
    const page = setupPage({
        page: 'intermittent',
        url: `https://tests.firefox.dev/intermittent.html${hash}`,
    });
    const client = fixtureClient();
    const source = issuesSource();
    const module = (await import(
        `../site/intermittent.ts?parity-${tag}=${Date.now()}-${Math.random()}`
    )) as typeof import('../site/intermittent.ts');
    // No pinned `today`: the CLI's `--since` ends at today and cannot be moved,
    // so the page has to use the same clock for the two windows to coincide.
    await module.start({ client, source });
    return { state: module.parityState(), page, calls: client.calls, requested: source.requested };
}

// =========================================================================
// Value parity
// =========================================================================

test('both sides classify every bug the same way, field by field', async () => {
    const { result } = await cliRanking();
    const { state, page } = await pageRanking('value');
    try {
        // The page draws a capped prefix, so the comparison is over that prefix
        // of the CLI's full ranking — and the cap itself is checked in the
        // framing section rather than smuggled in here.
        const cli = result.rows.slice(0, state.rows.length);
        assert.ok(cli.length > 0, 'the fixture ranks something');
        for (const [index, row] of state.rows.entries()) {
            const other = cli[index]!;
            assert.equal(row.bugId, other.bugId, `row ${index}: bug`);
            assert.equal(row.count, other.count, `row ${index}: annotation count`);
            assert.equal(row.harness, other.harness, `row ${index}: classification`);
            assert.equal(row.test, other.test, `row ${index}: verified test path`);
        }
    } finally {
        page.restore();
    }
});

test('both sides report the same coverage of the window', async () => {
    const { result } = await cliRanking();
    const { state, page } = await pageRanking('coverage');
    try {
        // The whole `ScanCoverage`, not a spot check: this is the block both
        // sides' prose is generated from, so a difference here is a difference
        // in every sentence either side prints about what it ranked.
        assert.deepEqual(state.coverage, result.coverage);
        assert.ok(result.coverage.noBugCount > 0, 'and the fixture has a no-bug group');
    } finally {
        page.restore();
    }
});

test('each harness selection holds the same set on both sides', async () => {
    for (const harness of ['mochitest', 'xpcshell', 'unknown'] as const) {
        const { result } = await cliRanking(['--harness', harness]);
        const { state, page } = await pageRanking(
            `harness-${harness}`,
            `#date=${WINDOW_DAYS}days&harness=${harness}`
        );
        try {
            // The page renders **every** matching row now, where the CLI
            // still caps at `DEFAULT_LIMIT` — a declared divergence, because a
            // terminal cannot usefully scroll a thousand rows and a browser
            // can. So the page's count is the whole match, not a prefix of it.
            assert.equal(
                state.rows.length,
                result.matchCount,
                `--harness ${harness}: row count`
            );
            assert.deepEqual(
                state.rows.map((row) => row.bugId),
                result.rows.slice(0, state.rows.length).map((row) => row.bugId),
                `--harness ${harness}: the same bugs, in the same order`
            );
        } finally {
            page.restore();
        }
    }
});

// =========================================================================
// Order parity
// =========================================================================

test('the ranked sequence is the same, position by position', async () => {
    // Not a set comparison. `PARITY.md` §1: the sort-key defect produced the
    // same set in a different order and would pass any set check.
    const { result } = await cliRanking();
    const { state, page } = await pageRanking('order');
    try {
        assertSameOrder(
            state.rows.map((row) => String(row.bugId)),
            result.rows.slice(0, state.rows.length).map((row) => String(row.bugId)),
            'intermittent: the bug ranking'
        );
        // And it really is descending by annotation count, on both sides. An
        // order that matched while both were wrong would pass the check above.
        for (let i = 1; i < result.rows.length; i++) {
            assert.ok(result.rows[i - 1]!.count >= result.rows[i]!.count, 'CLI descending');
        }
        for (let i = 1; i < state.rows.length; i++) {
            assert.ok(state.rows[i - 1]!.count >= state.rows[i]!.count, 'page descending');
        }
    } finally {
        page.restore();
    }
});

// =========================================================================
// Universe parity
// =========================================================================

test('both sides read the same two published test lists, and only those', async () => {
    const { requested: cli } = await cliRanking();
    const { requested: pageFiles, page } = await pageRanking('universe-files');
    try {
        // Classification asks for exactly two files however deep the ranking
        // goes, on both sides, because `loadHarnessOfPath` reads the aggregates
        // once for the whole run rather than the per-test bucket files.
        assert.deepEqual([...cli].sort(), ['mochitest-issues.json', 'xpcshell-issues.json']);
        assert.deepEqual([...pageFiles].sort(), [...cli].sort());
    } finally {
        page.restore();
    }
});

test('neither side spends a request per bug to classify', async () => {
    const { calls: cli } = await cliRanking();
    const { calls: pageCalls, page } = await pageRanking('universe-perbug');
    try {
        // The quantity, not the prose. `scanBugs` is synchronous, so the whole
        // ranking is classified with no per-bug request — and the number of
        // Bugzilla requests is therefore a count of *batches*, which is the
        // distinction the CLI's own comment warns against collapsing.
        const batches = Math.ceil(
            raw.failures.filter((entry) => entry.bug_id !== null).length / BUG_BATCH_SIZE
        );
        for (const [label, calls] of [
            ['CLI', cli],
            ['page', pageCalls],
        ] as const) {
            assert.equal(
                calls.filter((call) => call === 'bugzilla-batch').length,
                batches,
                `${label}: Bugzilla is batched`
            );
        }
        // **Where the two sides stopped agreeing**, and it is declared below as
        // "how the window ranking is obtained". The CLI asks Treeherder for the
        // window; the page sums the days it already fetches for its charts.
        assert.equal(
            cli.filter((call) => call === 'failures-window').length,
            1,
            'the CLI asks for the window once'
        );
        assert.equal(
            pageCalls.filter((call) => call === 'failures-window').length,
            0,
            'the page asks for no window at all — it sums its days'
        );
    } finally {
        page.restore();
    }
});

test('the page trades one request per bug for one per day, and neither side hides it', async () => {
    const { calls: cli } = await cliRanking();
    const { calls: pageCalls, page } = await pageRanking('universe-days');
    try {
        // **This is the declared universe divergence, as a quantity.** The CLI's
        // ranked list makes no per-day and no per-bug request; the page makes one
        // per day of the window, which is what its charts are built from.
        assert.equal(
            cli.filter((call) => call.startsWith('failures-day:')).length,
            0,
            'the CLI ranked list has no chart and asks for no day'
        );
        assert.equal(
            pageCalls.filter((call) => call.startsWith('failures-day:')).length,
            WINDOW_DAYS,
            'the page asks for every day of the window, exactly once each'
        );
        // And neither side reaches for the per-bug occurrence endpoint on the
        // ranked view: the CLI only does so under `--bug`/`--test`, and the page
        // deliberately never does.
        assert.equal(cli.filter((call) => call === 'failuresbybug').length, 0);
        assert.equal(pageCalls.filter((call) => call === 'failuresbybug').length, 0);
    } finally {
        page.restore();
    }
});

// =========================================================================
// Framing parity
// =========================================================================

test('both sides rank bugs tree-wide over the same window, and say so', async () => {
    const { result } = await cliRanking();
    const { state, page } = await pageRanking('framing-window');
    try {
        assert.equal(result.endday, WINDOW_END, 'the window ends today on both sides');
        assert.deepEqual(state.range, { start: result.startday, end: result.endday },
            'and the page asked for exactly the range the CLI reported');
        assert.equal(result.tree, 'trunk');
        assert.equal(state.tree, 'trunk', 'the same default tree');

        // The row unit really is a bug on both sides, not merely labelled one.
        for (const row of result.rows.slice(0, 20)) {
            assert.equal(typeof row.bugId, 'number');
        }
        for (const row of state.rows) {
            assert.equal(typeof row.bugId, 'number');
        }

        // The page's default window is the one thing framing-divergent here, and
        // it is asserted against the controller's source rather than only against
        // a constant, so a page that agreed on the number while loading something
        // else would still fail.
        const view = readFileSync(new URL('../site/intermittent-view.ts', import.meta.url), 'utf8');
        assert.match(view, /export const DEFAULT_DAYS = 21;/);
        assert.match(view, /export const DEFAULT_WINDOW = '21days';/);
    } finally {
        page.restore();
    }
});

test('both sides name the same selection, and the same tree and window', async () => {
    // ## A divergence, declared: the page has no heading to compare
    //
    // This used to assert `state.title` against the CLI's `rankingTitle`, in
    // its three phrasings. The page owner removed the `<h2>` that carried it —
    // "what's the point of this section title when there's only one section in
    // the entire page?" — so there is no longer a page-side string to hold
    // byte-parity against, and pinning this test to the heading would be
    // asserting an element that does not exist.
    //
    // What framing parity actually requires is that both sides identify **the
    // same list**: the same harness selection, the same tree, the same window.
    // Each of those is still on the page, so each is still asserted — the
    // harness in the `<h1>`, the tree and the window in the scope line beside
    // the dropdown. The CLI keeps its sentence, because a terminal has no
    // dropdown and no control to sit a scope line beside.
    // The page's own option labels, which is what its `<h1>` shows.
    for (const [harness, expected] of [
        [undefined, 'all'],
        ['xpcshell', 'XPCShell'],
        ['unknown', 'Unknown test'],
    ] as const) {
        const { state, page } = await pageRanking(
            `title-${harness ?? 'all'}`,
            `#date=${WINDOW_DAYS}days${harness === undefined ? '' : `&harness=${harness}`}`
        );
        try {
            // The selection, as the page's own title states it.
            assert.ok(
                state.title.startsWith(expected),
                `${harness ?? 'all'}: "${state.title}" should start "${expected}"`
            );
            // And the tree and window, which the removed heading used to carry
            // and which the scope line carries now.
            assert.equal(
                state.scope,
                `${state.tree}, ${state.range.start} to ${state.range.end}`,
                'the scope line names the tree and the window'
            );
            assert.match(state.scope, /^trunk, /, 'the tree the CLI also ranks');
        } finally {
            page.restore();
        }
    }
    // The CLI still prints its own sentence, from its own renderer: the phrase
    // is unchanged on that side, which is what keeps a reader who has run the
    // command recognising the page.
    const client = fixtureClient();
    const text = await invoke(['intermittent', '--since', String(WINDOW_DAYS), '--limit', '1'], {
        intermittents: client,
        source: issuesSource(),
    });
    assert.match(text.stdout, /Sheriff-annotated intermittents on trunk/);
});

test('both sides state their depth, and neither truncates silently', async () => {
    const { result } = await cliRanking();
    const { state, page } = await pageRanking('framing-depth');
    try {
        // The CLI's `--json` carries every matched row and says how many there
        // are, so a machine-readable array is never silently a prefix of its own
        // count.
        assert.equal(result.rows.length, result.matchCount);

        // The page has no cap any more, so "neither truncates silently" is
        // satisfied structurally on its side: every matched row is rendered, so
        // there is no prefix to declare. That is a stronger property than the
        // sentence it replaced, and it is asserted as a count rather than as
        // prose — a page that reintroduced a cap fails here.
        assert.equal(
            state.rows.length,
            result.matchCount,
            'the page renders every matched row'
        );
        const status = (
            page.document.getElementById('status-text')?.textContent ?? ''
        ).replace(/\s+/g, ' ');
        assert.doesNotMatch(status, /not drawn/, 'nothing is withheld, so nothing says so');
        // ## The depth claim, restated where it now lives
        //
        // The page used to print "1,170 classified" and this asserted it. The
        // owner cut that phrase — "I don't see what '1,172 classified' means but
        // it seems useless" — and he is right that with *every* candidate
        // classified it distinguishes nothing.
        //
        // So the property is asserted rather than the prose: the page's own
        // harness-scoped line counts against the full scanned population, which
        // is only true if the classification covered all of it. A page that
        // sampled would show a smaller denominator here and fail.
        const scoped = await pageRanking('framing-depth-scoped', `#harness=xpcshell`);
        try {
            const scopedStatus = (
                scoped.page.document.getElementById('status-text')?.textContent ?? ''
            ).replace(/\s+/g, ' ');
            assert.match(
                scopedStatus,
                new RegExp(`of ${result.coverage.scanned.toLocaleString('en-US')} bugs are for`),
                `the page's denominator is the whole classified population: ${scopedStatus}`
            );
        } finally {
            scoped.page.restore();
        }
    } finally {
        page.restore();
    }
});

// =========================================================================
// The declared divergences
// =========================================================================

const DIVERGENCES: Divergence<string>[] = [
    {
        what: 'the default window',
        page: '21 days',
        cli: '7 days',
        reason:
            'The CLI defaults to 7 for a stated reason that is about whole weeks rather than ' +
            'about seven: weekend push volume drops several-fold, so a window that is not a ' +
            'whole number of weeks ranks a different weekday mix each run. 21 is three weeks ' +
            'and satisfies that reasoning exactly as 7 does. The page takes 21 because it is ' +
            'the window every other page on this site publishes and the one the owner reaches ' +
            'for by habit (`#date=21days` on issues.html), so a reader comparing this page ' +
            'against Test Issues is comparing the same span. Both sides reach the other ' +
            'window: `--since 21` on the CLI, `#date=7days` on the page.',
    },
    {
        what: 'how many rows are shown by default',
        page: 'every matching row, uncapped',
        cli: `${DEFAULT_LIMIT}`,
        reason:
            'A fact about the medium, not a disagreement about the data: twenty rows is what ' +
            'fits on a terminal screen, and a browser has a scrollbar. The page used to cap ' +
            'at 50 and the stated reason was the per-row charts — "a thousand canvases is a ' +
            'page that takes seconds to paint" — which was measured at ~0.9 ms per sparkline, ' +
            'so 1,170 rows would block for ~1.1 s. That is answered by drawing the charts ' +
            'lazily as they scroll into view rather than by hiding 1,120 rows, so the cap is ' +
            'gone. Neither side is silent: the CLI prints "… N more (--limit 0 for all)" and ' +
            'the page states its row count on the coverage line.',
    },
    {
        what: 'the requests made to build a per-day breakdown',
        page: 'one `/api/failures/` per day of the window',
        cli: 'one `/api/failuresbybug/` for the one bug `--bug`/`--history` names',
        reason:
            'The same numbers by two routes, and the routes differ because the questions do. ' +
            'The CLI breaks down one bug a reader already chose, so one request for that bug ' +
            'is the cheapest thing that works. The page charts every row at once, and the ' +
            'per-bug route costs 2.2 MB and 5.4 s for a single row on live trunk — measured on ' +
            'bug 2060167 over 2026-08-23..09-12 — because each occurrence carries its job\'s ' +
            'full log lines. A per-day ranking is ~8 kB and serves every row, so 21 requests ' +
            'replace 50 large ones. Verified equal rather than assumed: per-day `/failures/` ' +
            'against a tally of `/failuresbybug/` agreed on every bug and day checked, live ' +
            'and on this fixture (see `historiesFromDays`).',
    },
    {
        what: 'how the window ranking is obtained',
        page: 'the per-day `/api/failures/` responses summed',
        cli: 'one `/api/failures/` for the whole window',
        reason:
            'Not two rankings — the same one, and that is what allows the split. The page ' +
            'owner asked whether the whole-window response is simply the sum of the per-day ' +
            'ones: measured against live trunk for startday=2026-08-25 endday=2026-09-14, it ' +
            'is exactly. 1,156 distinct bug_ids on both sides, 36,401 annotations on both, the ' +
            'bug_id:null group 3,226 on both, no bug in one side and not the other, and no ' +
            'bug whose counts differ. Neither side is capped or paginated: the response is a ' +
            'bare array, page/limit/count/offset are ignored byte-for-byte, the window\'s tail ' +
            'holds 289 entries of bug_count 1, and 90- and 180-day windows return 2,529 and ' +
            '3,119 entries rather than plateauing. So the page drops a request it was ' +
            'blocking on for data it was about to fetch again — a default 21-day load in ' +
            'headless Chrome, five runs each side, medians 5,597 ms before and 4,885 ms ' +
            'after. The CLI keeps ' +
            'the window request because it makes no per-day ones: it has no sparklines, so ' +
            'summing days would be 21 requests where it makes 1. `rankingFromDays` in ' +
            '`site/intermittent-view.ts` carries the measurement.',
    },
];

test('the declared divergences are real and still differ', () => {
    assertDeclaredDivergences('intermittent: page vs CLI', DIVERGENCES);
});
