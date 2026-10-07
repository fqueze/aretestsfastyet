/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * `site/intermittent.ts`, the intermittents page controller, driven end to end
 * in jsdom.
 *
 * ## Where the expected values come from
 *
 * The **recorded fixture** — `test/fixtures/intermittents-trunk-2026-08-10.json`,
 * the same one `test/intermittent.test.ts` runs the CLI against, written by
 * `test/intermittents-fixture-gen.ts` from live Treeherder and Bugzilla. So the
 * summaries these tests classify are Bugzilla's own strings and the suites are
 * Treeherder's; a hand-written fixture would have agreed with whatever the
 * classifier happened to do.
 *
 * Expected counts are tallied off the raw fixture arrays by `handTally` below,
 * which imports nothing from `site/` or `lib/query/`. That is the rule this
 * project keeps relearning: a test whose expected value is produced by the code
 * under test passes whatever that code does.
 *
 * ## What is asserted, and why each one
 *
 * The page's whole risk is the same as the command's — **an answer that looks
 * complete** — plus two risks a page has that a terminal does not: a control
 * that renders enabled and does nothing, and a chart that silently plots the
 * wrong series. So:
 *
 * - the harness dropdown filters, updates the title and the coverage prose, and
 *   **makes no request**, because `scanBugs` classified everything up front;
 * - the request count the page reports matches the requests it actually made,
 *   which is the check `scanPlan`'s comment says has to be able to fail;
 * - the table never truncates silently: when it caps, both numbers are on
 *   screen;
 * - each sparkline plots that bug's own per-day counts, and a bug that stopped
 *   failing keeps its trailing zeros;
 * - the top chart counts the no-bug group, and says that it does.
 *
 * ## The seam, and why it is a parameter
 *
 * `start()` takes an `IntermittentsClient` and a `DataSource`. The harness's
 * `fetchData` serves `test/fixtures/` by filename, which is right for the two
 * published test lists but cannot answer a Treeherder REST URL — and a page test
 * must not reach the network. So the client is a fake over the fixture that
 * **records every call**, which is what lets the request-count assertion be
 * about behaviour rather than about a number this file chose.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupPage, fixture } from './dom-harness.ts';
import { rankingByDay } from './parity-harness.ts';
import type {
    BugFailureCount,
    BugFailureDay,
    BugOccurrence,
    DayRange,
    IntermittentsClient,
} from '../lib/sources/intermittents.ts';
import {
    type BugInfo,
    BUG_BATCH_SIZE,
    UNKNOWN_TASK_ID,
} from '../lib/sources/intermittents.ts';
import type { DataFileName, DataSource } from '../lib/sources/source.ts';
// The view model's own constants, for the two assertions that are about the
// *page's* defaults rather than about what a run rendered.
import { DEFAULT_WINDOW, daysOfWindow } from '../site/intermittent-view.ts';

// --- ground truth, read off the raw fixture -------------------------------

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
        {
            bug_id: number | null;
            test_suite: string;
            platform: string;
            build_type: string;
            revision: string;
            tree: string;
            push_time: string;
            machine_name: string;
            task_id: string;
            job_id: number;
            lines: string[];
        }[]
    >;
    runIds: Record<string, number>;
}

const raw = fixture<Fixture>('intermittents-trunk-2026-08-10.json');

/**
 * The fixture's own numbers, counted here rather than by the page.
 *
 * Nothing in this function imports `scanBugs`, `selectHarness` or the view
 * model. The classification rule is restated — the first path in the summary
 * that appears in `knownTestPaths` — which is what makes a page that classified
 * differently fail here.
 */
function handTally(): {
    ranked: number;
    candidates: number[];
    noBugCount: number;
    /** Every annotation of every day, the no-bug group included. */
    dayTotal: number;
    byHarness: Record<'mochitest' | 'xpcshell' | 'unknown', number[]>;
} {
    const ranked = raw.failures.length;
    const candidates: number[] = [];
    let noBugCount = 0;
    const byHarness: Record<'mochitest' | 'xpcshell' | 'unknown', number[]> = {
        mochitest: [],
        xpcshell: [],
        unknown: [],
    };
    for (const entry of raw.failures) {
        if (entry.bug_id === null) {
            noBugCount += entry.bug_count;
            continue;
        }
        candidates.push(entry.bug_id);
        const summary = raw.summaries[String(entry.bug_id)] ?? '';
        // The paths this fixture holds, longest first so a path that is a suffix
        // of another does not win. `testPathCandidates` does the extraction on
        // the real side; here the fixture's own list is searched directly, which
        // is a different route to the same answer.
        const found = [...raw.knownTestPaths.mochitest, ...raw.knownTestPaths.xpcshell]
            .sort((a, b) => b.length - a.length)
            .find((path) => summary.includes(path));
        if (found === undefined) {
            byHarness.unknown.push(entry.bug_id);
        } else if (raw.knownTestPaths.mochitest.includes(found)) {
            byHarness.mochitest.push(entry.bug_id);
        } else {
            byHarness.xpcshell.push(entry.bug_id);
        }
    }
    // The volume figure's own denominator. The figure sums the **per-day**
    // rankings, and the fake's days tile the recorded window ranking exactly
    // (`rankingByDay`), so the total is that ranking's own sum — the no-bug
    // group included, which is what the figure counts. Summed here straight off
    // `raw.failures`, which is a different route from the page's: the page adds
    // up the day responses, this adds up the window entries they were split
    // from, and the two agreeing is the property being checked.
    const dayTotal = raw.failures.reduce((total, entry) => total + entry.bug_count, 0);
    return { ranked, candidates, noBugCount, dayTotal, byHarness };
}

const TALLY = handTally();

test('the fixture exercises what this suite claims to cover', () => {
    // A vacuity guard. Every assertion below about a harness group, about the
    // no-bug row or about the cap is worthless if the fixture has none of them.
    assert.ok(TALLY.ranked > 0, 'the fixture has a ranking');
    assert.ok(TALLY.noBugCount > 0, 'and a `{"bug_id": null}` group to exclude');
    assert.ok(TALLY.byHarness.mochitest.length > 0, 'and a bug naming a mochitest test');
    assert.ok(TALLY.byHarness.xpcshell.length > 0, 'and one naming an xpcshell test');
    assert.ok(TALLY.byHarness.unknown.length > 0, 'and one naming no known test');
    assert.ok(
        Object.keys(raw.failuresbybug).length > 1,
        'and per-bug occurrences for more than one bug, so a per-day series is not degenerate'
    );
});

// --- the harness ----------------------------------------------------------

/**
 * The window every test runs in.
 *
 * The fixture's own recorded range, so nothing here depends on today's date —
 * the same reason `test/intermittent.test.ts` pins `--day` to `fixture.startday`.
 * Seven days, and the fixture's `failuresbybug` rows fall inside it.
 */
const RANGE: DayRange = { start: raw.startday, end: raw.endday };

/** How many days that is, as the page's `#date=<n>days` would ask for it. */
const WINDOW_DAYS =
    Math.round(
        (Date.parse(`${RANGE.end}T00:00:00Z`) - Date.parse(`${RANGE.start}T00:00:00Z`)) /
            (24 * 60 * 60 * 1000)
    ) + 1;

/**
 * The fixture's window ranking, split across the window's days.
 *
 * The page has no whole-window request any more: it sums these. See
 * `rankingByDay` in `test/parity-harness.ts` for why the fake has to tile the
 * recorded ranking exactly and why the recorded occurrences cannot do it.
 */
const RANKING_BY_DAY = rankingByDay(
    raw.failures.map((entry) => ({ bugId: entry.bug_id, count: entry.bug_count })),
    daysOfWindow({ start: raw.startday, end: raw.endday })
);

/**
 * The fixture served through a client, recording every call.
 *
 * **The per-day rankings tile the recorded window ranking**, which is the
 * relationship measured against live Treeherder and the one the page now
 * depends on for its ranking as well as its sparklines — `rankingFromDays` in
 * `site/intermittent-view.ts` carries the numbers. A fake whose days summed to
 * something else would let a page that mis-sums them pass.
 *
 * A whole-window `rankBugs` is still answered, from `raw.failures`, so a page
 * that started making that request again would be caught by the call log
 * rather than by a rejection — the assertion that it makes none is in
 * "the load makes exactly the requests the plan accounts for".
 *
 * `bugBatches` records the **bug numbers** of each Bugzilla batch, not just its
 * size, because the page now dispatches batches as the per-day responses land
 * rather than once from the finished ranking — so "every bug exactly once" is a
 * property of the union of the batches and can no longer be read off a count.
 */
function fixtureClient(): IntermittentsClient & {
    calls: string[];
    bugBatches: number[][];
} {
    const calls: string[] = [];
    const bugBatches: number[][] = [];
    return {
        calls,
        bugBatches,
        async rankBugs(tree: string, range: DayRange): Promise<BugFailureCount[]> {
            calls.push(`failures:${tree}:${range.start}:${range.end}`);
            if (range.start !== range.end) {
                return raw.failures.map((entry) => ({
                    bugId: entry.bug_id,
                    count: entry.bug_count,
                }));
            }
            return RANKING_BY_DAY.get(range.start) ?? [];
        },
        async occurrencesOfBug(
            tree: string,
            range: DayRange,
            bug: number
        ): Promise<BugOccurrence[]> {
            // Recorded so a test can assert the page never calls it: this is the
            // 2.2 MB-per-row request the page deliberately does not make.
            calls.push(`failuresbybug:${bug}:${tree}:${range.start}:${range.end}`);
            return (raw.failuresbybug[String(bug)] ?? []).map((row) => ({
                bugId: row.bug_id,
                testSuite: row.test_suite,
                platform: row.platform,
                buildType: row.build_type,
                revision: row.revision,
                tree: row.tree,
                pushTime: row.push_time,
                machineName: row.machine_name,
                taskId: row.task_id,
                jobId: row.job_id,
                runId: null,
                lines: row.lines,
            }));
        },
        async failureCountOfBug(
            _tree: string,
            _range: DayRange,
            bug: number
        ): Promise<BugFailureDay[]> {
            // Recorded so a test can assert the page does *not* reach for this
            // on the ranked table's behalf: it is one request per bug, which is
            // 1,170 requests on the default window. `historiesFromDays` carries
            // that comparison.
            calls.push(`failurecount:${bug}`);
            return [];
        },
        async runIdsOfJobs(jobIds: readonly number[]): Promise<Map<number, number>> {
            calls.push(`runids:${jobIds.length}`);
            // The **recorded** run index per job, which is the whole point of
            // this call: a task whose first run ended in `exception` has its
            // annotated failure in run 1, and the fixture records one job at
            // run 5. A fake returning an empty map would make every profile
            // link absent and every assertion about them vacuous.
            const found = new Map<number, number>();
            for (const jobId of jobIds) {
                const runId = raw.runIds[String(jobId)];
                if (runId !== undefined) {
                    found.set(jobId, runId);
                }
            }
            return found;
        },
        async bugSummaries(bugs: readonly number[]): Promise<Map<number, BugInfo>> {
            // One entry per **batch**, as the real client chunks it, so a test
            // can compare the page's predicted batch count against the calls
            // actually made.
            for (let i = 0; i < bugs.length; i += BUG_BATCH_SIZE) {
                const batch = bugs.slice(i, i + BUG_BATCH_SIZE);
                calls.push(`bugzilla:${batch.length}`);
                bugBatches.push([...batch]);
            }
            return new Map(
                bugs.flatMap((bug) => {
                    const summary = raw.summaries[String(bug)];
                    if (summary === undefined) {
                        return [];
                    }
                    // The **recorded** status and resolution, so a test about
                    // the strike-through is about Bugzilla's answer rather than
                    // a value this file chose.
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

/**
 * A source serving just enough `{harness}-issues.json` to classify.
 *
 * The same shape `test/intermittent.test.ts`'s `issuesSource` builds, and for
 * the same reason: only `tables` and `testInfo` are read, so the fixture's path
 * list is enough and the page exercises its **real** loader —
 * `loadHarnessOfPath` — including that it asks for exactly two files.
 */
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
                const base = cut === -1 ? full : full.slice(cut + 1);
                if (!dirs.includes(dir)) {
                    dirs.push(dir);
                }
                names.push(base);
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

/**
 * A page, started on the fixture's own window.
 *
 * The controller holds module-level state, so a test that changes the harness or
 * the window uses `freshPage` rather than this shared one.
 */
async function startPage(
    tag: string,
    /**
     * The hash, or a partial client to override one of the fixture's methods.
     *
     * Overloaded on the argument's shape rather than given a third parameter,
     * so the ~30 existing call sites that pass only a tag are untouched: an
     * object is an override, a string is a hash.
     */
    hashOrOverride: string | Partial<IntermittentsClient> = `#date=${WINDOW_DAYS}days`
): Promise<{
    page: ReturnType<typeof setupPage>;
    client: IntermittentsClient & { calls: string[]; bugBatches: number[][] };
    source: DataSource & { requested: string[] };
    parityState: () => ReturnType<typeof import('../site/intermittent.ts').parityState>;
}> {
    const override = typeof hashOrOverride === 'string' ? {} : hashOrOverride;
    const hash =
        typeof hashOrOverride === 'string' ? hashOrOverride : `#date=${WINDOW_DAYS}days`;
    const page = setupPage({
        page: 'intermittent',
        url: `https://tests.firefox.dev/intermittent.html${hash}`,
    });
    const client = Object.assign(fixtureClient(), override);
    const source = issuesSource();
    const module = (await import(
        `../site/intermittent.ts?${tag}=${Date.now()}-${Math.random()}`
    )) as typeof import('../site/intermittent.ts');
    // The day the fixture's window ends on, so the page asks the API for the
    // dates the fixture holds. Without this the window is computed from the real
    // clock and every per-day request falls outside the recorded range, which
    // makes every chart assertion below vacuously about zeros.
    await module.start({ client, source, today: new Date(`${RANGE.end}T12:00:00Z`) });
    return { page, client, source, parityState: module.parityState };
}

const rowsOf = (page: ReturnType<typeof setupPage>): HTMLTableRowElement[] => [
    ...page.document.querySelectorAll<HTMLTableRowElement>('tr.ranking-row'),
];
/**
 * A row's annotation count, off `.count-total` rather than off the cell's text.
 *
 * The `Annotations` cell holds two lines now — the total, and the sparkline's
 * `peak N/day` label, which moved here out of the chart cell — so
 * `cells(row)[0]` is `"1,234peak 88/day"` and `Number()` of it is `NaN`. Same
 * hazard as `bugOf` below, and the same fix: read the element that holds the
 * one number.
 */
const countOf = (row: HTMLTableRowElement): number =>
    Number((row.querySelector('.count-total')?.textContent ?? '').replace(/,/g, ''));
/**
 * The bug number a row links to, off the link rather than off the cell's text.
 *
 * The `Bug` cell holds a second element on a resolved row — the resolution word
 * — so `cells(row)[2]` is `"2021221FIXED"` there and `Number()` of it is `NaN`.
 * Reading the anchor is what these assertions always meant, and it does not
 * change meaning when something else is added beside it.
 */
const bugOf = (row: HTMLTableRowElement): number =>
    Number(row.querySelector('a.bug-link')?.textContent);
/**
 * The line beside the window dropdown.
 *
 * `coverageText` was here, reading `.coverage-line` above the table. Everything
 * that line carried now sits in `#status-text` next to the window control, on
 * the page owner's instruction — so this is where the volume, the tree, the date
 * range and the harness-scoped count are all read from.
 */
const statusText = (page: ReturnType<typeof setupPage>): string =>
    (page.document.getElementById('status-text')?.textContent ?? '').replace(/\s+/g, ' ').trim();

// --- the first paint ------------------------------------------------------

test('the ranking renders, ordered by annotation count descending', async () => {
    const { page, parityState } = await startPage('first');
    try {
        const rows = rowsOf(page);
        assert.ok(rows.length > 0, 'the fixture ranks something');
        const counts = rows.map((row) => countOf(row));
        for (let i = 1; i < counts.length; i++) {
            assert.ok(counts[i - 1]! >= counts[i]!, `row ${i} is out of order`);
        }
        // The top row is the fixture's own largest *bug* — not its largest
        // entry, which is the no-bug group and has no row.
        const largestBug = raw.failures
            .filter((entry) => entry.bug_id !== null)
            .reduce((best, entry) => (entry.bug_count > best.bug_count ? entry : best));
        assert.equal(bugOf(rows[0]!), largestBug.bug_id);
        assert.equal(counts[0], largestBug.bug_count);
        assert.equal(parityState().rows[0]!.bugId, largestBug.bug_id);
    } finally {
        page.restore();
    }
});

test('the status line beside the window control carries the volume and the scope', async () => {
    // The page owner moved all three of these next to the window dropdown:
    // "'36,240 annotations over 21 days' should be next to the window dropdown,
    // instead of the rather unclear '27 requests, 2026-08-23 to 2026-09-12'".
    const { page } = await startPage('status');
    try {
        const status = statusText(page);
        const n = (value: number): string => value.toLocaleString('en-US');
        // The window's volume, every annotation of it — the no-bug group
        // included, which is why this is larger than the table sums to.
        assert.match(status, new RegExp(`${n(TALLY.dayTotal)} annotations over \\d+ days`));
        // The tree and the window's ends, which the removed `<h2>` carried.
        assert.match(status, /trunk, \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/);
        // The request count is gone: it was an earlier ask for honest depth
        // reporting and the owner found it unclear.
        assert.doesNotMatch(status, /requests/);
    } finally {
        page.restore();
    }
});

test('the untriaged annotations stay reachable, in the figure’s tooltip', async () => {
    // The no-bug group is the one population the table cannot show, so cutting
    // the prose that named it must not make the number unreachable. It is a
    // tooltip on the annotations figure now — the owner's suggestion, "maybe
    // that's something to show in a tooltip when hovering '36,240 annotations
    // over 21 days'".
    const { page } = await startPage('untriaged');
    try {
        const tip =
            page.document.querySelector('.annotations-total')?.getAttribute('title') ?? '';
        assert.match(tip, new RegExp(TALLY.noBugCount.toLocaleString('en-US')));
        // Spelled out rather than the three words "untriaged excluded", which
        // the owner could not interpret.
        assert.match(tip, /without attaching a bug/);
        assert.doesNotMatch(statusText(page), /untriaged excluded/);
    } finally {
        page.restore();
    }
});

test('the harness-scoped count reads as a sentence, and only when scoped', async () => {
    // The owner's own phrasing for what "428 of 1,172 bugs" was trying to say:
    // "I assume the first part means '428 of 1,172 bugs are for mochitests.'"
    const { page } = await startPage('scoped', '#harness=xpcshell');
    try {
        assert.match(statusText(page), /\d+ of [\d,]+ bugs are for xpcshells/);
        // `1,172 classified` is gone: with every bug classified it said nothing,
        // which is the owner's verdict — "it seems useless".
        assert.doesNotMatch(statusText(page), /classified/);
    } finally {
        page.restore();
    }
    // Unfiltered, there is no denominator to state — it would be the same
    // number twice — so the count is the plain one.
    const all = await startPage('scoped-all');
    try {
        assert.match(statusText(all.page), /[\d,]+ annotated bugs/);
        assert.doesNotMatch(statusText(all.page), /are for/);
    } finally {
        all.page.restore();
    }
});

test('the prose above the table is gone, not merely shortened', async () => {
    // The page owner's verdict on the one sentence that survived the previous
    // round: "'A row is a sheriff's judgement, …' = blah blah. Either say
    // something useful, or don't say anything." So this asserts absence.
    const { page } = await startPage('prose');
    try {
        assert.equal(page.document.querySelector('.subtitle'), null, 'no subtitle');
        assert.equal(page.document.querySelector('.volume-note'), null, 'no volume note');
        assert.equal(page.document.querySelector('.coverage-line'), null, 'no coverage line');
        // The section title too: "what's the point of this section title when
        // there's only one section in the entire page?"
        assert.equal(page.document.querySelector('#ranking-title'), null, 'no section title');
        // The old block is gone rather than restyled, so it cannot come back by
        // a CSS change alone.
        assert.equal(page.document.querySelector('.explanation'), null);
        // And none of the sentences that were cut are still on screen.
        const body = page.document.body.textContent ?? '';
        for (const cut of [
            'no folder to drill into',
            'nightly aggregates',
            'A bug is placed by the test path in its summary',
            'placing a bug costs no request',
            'ranked but not drawn',
            'judgement, not a computed rate',
            'sums to less than this',
            'The busiest was',
        ]) {
            assert.ok(!body.includes(cut), `"${cut}" was cut and must not be back`);
        }
    } finally {
        page.restore();
    }
});

test('nothing on screen claims the table was truncated, because it was not', async () => {
    // The no-silent-truncation rule, now satisfied structurally: every matching
    // row is in the table, so there is no prefix to confess to and no "top 50
    // of N" to print. A page that reintroduced a cap without saying so would
    // fail the row-count assertion below rather than this one.
    const { page, parityState } = await startPage('no-truncation');
    try {
        const text = statusText(page);
        assert.doesNotMatch(text, /not drawn/);
        assert.doesNotMatch(text, /top \d/);
        assert.equal(page.document.querySelector('.table-note'), null, 'no cap note');
        // And the rows really are all of them.
        assert.equal(rowsOf(page).length, parityState().rows.length);
        assert.equal(rowsOf(page).length, TALLY.candidates.length, 'every candidate has a row');
    } finally {
        page.restore();
    }
});

test('the load makes exactly the requests the plan accounts for', async () => {
    // The status line no longer states a request count — the page owner found
    // "27 requests, 2026-08-23 to 2026-09-12" unclear, and it is gone. What that
    // assertion was really protecting is still worth protecting: that the page
    // makes one request per day, two test lists and a batched Bugzilla read,
    // and nothing per bug and nothing for the window as a whole. So the
    // composition is asserted directly against the calls rather than against a
    // number on screen.
    const { page, client, source } = await startPage('requests');
    try {
        assert.equal(source.requested.length, 2, 'exactly two published test lists');
        assert.equal(
            client.calls.filter((call) => call.startsWith('bugzilla:')).length,
            Math.ceil(TALLY.candidates.length / BUG_BATCH_SIZE),
            'Bugzilla is batched, and the plan counts batches rather than bugs'
        );
        assert.equal(
            client.calls.filter((call) => call.startsWith('failures:')).length,
            WINDOW_DAYS,
            'one request per day, and nothing else on `/api/failures/`'
        );
        // ## The whole-window request, which is gone
        //
        // The page used to open with `/api/failures/` for the whole range and
        // block on it before starting the per-day ones. The page owner asked
        // whether it was simply their sum; measured against live trunk it is,
        // exactly — `rankingFromDays` in `site/intermittent-view.ts` carries the
        // numbers — so it was one round trip on the critical path for data the
        // page was about to fetch again.
        //
        // The fake still answers it, so this fails as a count rather than as a
        // rejection if it ever comes back.
        assert.deepEqual(
            client.calls.filter((call) => {
                const [kind, , start, end] = call.split(':');
                return kind === 'failures' && start !== end;
            }),
            [],
            'no `/api/failures/` request spans more than one day'
        );
        // The two test lists are the only aggregates the page reads, and they
        // are read for the harness classification (`loadHarnessOfPath`).
        assert.ok(
            source.requested.every((name) => name.endsWith('-issues.json')),
            `only the issues aggregates are fetched: ${source.requested.join(', ')}`
        );
    } finally {
        page.restore();
    }
});

test('every ranked bug is asked of Bugzilla exactly once', async () => {
    // **The invariant the early dispatch has to keep.** Batches go out as the
    // per-day responses land, and the days overlap heavily — measured against
    // live `trunk`, 21 days hold 1,155 distinct bugs and the first 500 are
    // known after three of them — so the same id is *offered* many times and
    // "requested once" stopped being true by construction. The two ways to
    // break it are opposite: dispatching on every offer duplicates, forgetting
    // the trailing partial batch drops.
    const { page, client } = await startPage('bugzilla-once');
    try {
        const asked = client.bugBatches.flat();
        // Checked before the set equality, whose failure diff over 1,155 ids
        // would not say which of the two broke.
        assert.equal(
            new Set(asked).size,
            asked.length,
            `no bug is requested twice: ${asked.length} ids, ${new Set(asked).size} distinct`
        );
        assert.deepEqual(
            [...asked].sort((a, b) => a - b),
            [...TALLY.candidates].sort((a, b) => a - b),
            'the ids asked of Bugzilla are exactly the ranking’s candidates'
        );
        // The no-bug group has no number to ask about, so a `NaN` or `null`
        // reaching a URL is the shape of that defect.
        assert.ok(
            asked.every((bug) => Number.isInteger(bug) && bug > 0),
            'every id asked for is a real bug number'
        );
    } finally {
        page.restore();
    }
});

test('batches go out before the last day, once each, remainder flushed', async () => {
    // Drives `summaryDispatcher` directly: the page fixture holds 14
    // candidates, one batch, so a page load cannot reach the 500 boundary this
    // exists for. The DOM harness is set up only because the module reads
    // `window.location.search` at import.
    const page = setupPage({
        page: 'intermittent',
        url: 'https://tests.firefox.dev/intermittent.html',
    });
    try {
        const { summaryDispatcher, PAGE_BUG_BATCH } = (await import(
            `../site/intermittent.ts?dispatcher=${Date.now()}-${Math.random()}`
        )) as typeof import('../site/intermittent.ts');

        const sent: number[][] = [];
        let release: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const progress = { done: 0, plan: { days: 21, summaryBatches: 0, total: 23 } };
        const dispatcher = summaryDispatcher(
            progress,
            () => {},
            async (bugs) => {
                sent.push([...bugs]);
                // Held open, so `sent` is read while the batch is still in
                // flight — which is what "dispatched early" means.
                await blocked;
                return new Map();
            }
        );

        // 1,155 ids — a live 21-day `trunk` window's count — offered in 21
        // day-shaped chunks that each re-offer 30 of the previous chunk's, so
        // most of each offer is already requested. That overlap is why the
        // dedup exists.
        const all = Array.from({ length: 1155 }, (_, i) => 1900000 + i);
        const batchesAfterDay: number[] = [];
        for (let day = 0; day < 21; day++) {
            const from = Math.floor((day * all.length) / 21);
            const to = Math.floor(((day + 1) * all.length) / 21);
            dispatcher.offer(all.slice(Math.max(0, from - 30), to));
            batchesAfterDay.push(sent.length);
        }

        // **The point of the change.** Measured against live Treeherder, the
        // 500th distinct id is known at 676 ms and the last per-day response
        // lands at 2,973 ms, so batches overlap the days.
        assert.ok(
            batchesAfterDay[batchesAfterDay.length - 2]! >= 1,
            `a batch went out before the final day: ${batchesAfterDay.join(',')}`
        );
        // Full batches only so far, each exactly the size — a longer one is the
        // 414: 1,000 ids is 8,084 URL characters and returns 200, 1,100 is
        // 8,884 and returns 414.
        assert.deepEqual(
            sent.map((batch) => batch.length),
            [PAGE_BUG_BATCH, PAGE_BUG_BATCH],
            'two full batches, no remainder yet, none oversized'
        );

        // The final `offer` with the whole candidate list, as `load` makes it.
        dispatcher.offer(all);
        release!();
        await dispatcher.finish();

        assert.deepEqual(
            sent.map((batch) => batch.length),
            [PAGE_BUG_BATCH, PAGE_BUG_BATCH, 1155 - 2 * PAGE_BUG_BATCH],
            'the remainder is flushed as a third batch'
        );
        const asked = sent.flat();
        assert.deepEqual(
            [...asked].sort((a, b) => a - b),
            all,
            'every id asked exactly once: none duplicated, none dropped'
        );
        assert.equal(progress.done, 3, 'one count per batch, on completion');
    } finally {
        page.restore();
    }
});

test('the progress line’s request total never drops below what it has counted', async () => {
    // **A defect found in a real browser**, predating the early dispatch: the
    // last line of a 21-day load read **"23 of 5 requests"**, because the plan
    // recounted the window's *uncached* days once the ranking landed and the
    // run had by then cached all 21. Asserted over every line the load writes,
    // since a total may grow as the plan sharpens but must never shrink below
    // the count beside it.
    //
    // Sampled from inside the client, the only place to observe the line
    // mid-load: `setStatusText` writes straight to the DOM.
    const seen: string[] = [];
    const sample = (): void => {
        const line = (globalThis.document?.getElementById('status-text')?.textContent ?? '')
            .replace(/\s+/g, ' ')
            .trim();
        if (line !== '' && !seen.includes(line)) {
            seen.push(line);
        }
    };
    const base = fixtureClient();
    const { page } = await startPage('progress-honest', {
        async rankBugs(tree: string, range: DayRange): Promise<BugFailureCount[]> {
            sample();
            const rows = await base.rankBugs(tree, range);
            sample();
            return rows;
        },
        async bugSummaries(bugs: readonly number[]): Promise<Map<number, BugInfo>> {
            sample();
            const found = await base.bugSummaries(bugs);
            // After the batch resolves, so the line written when it was
            // dispatched — the one carrying the re-planned total — is observed.
            await Promise.resolve();
            sample();
            return found;
        },
    });
    try {
        sample();
        const counted = seen
            .map((line) => line.match(/(\d[\d,]*) of (\d[\d,]*) requests/))
            .filter((match): match is RegExpMatchArray => match !== null)
            .map((match) => ({
                line: match[0],
                done: Number(match[1]!.replace(/,/g, '')),
                total: Number(match[2]!.replace(/,/g, '')),
            }));
        assert.ok(counted.length > 0, `the load wrote a counted progress line: ${seen.join(' | ')}`);
        for (const { line, done, total } of counted) {
            assert.ok(done <= total, `"${line}" counts past its own total`);
        }
        // The largest total claimed, not the last: a finished load's final
        // line is the volume sentence and carries no count. Read off `base`,
        // which the overrides delegate to and so where the calls landed.
        const perDay = base.calls.filter((call) => {
            const parts = call.split(':');
            return call.startsWith('failures:') && parts[2] === parts[3];
        }).length;
        const batches = base.bugBatches.length;
        assert.equal(
            Math.max(...counted.map((entry) => entry.total)),
            2 + perDay + batches,
            `the plan's total is the two test lists plus ${perDay} days plus ` +
                `${batches} batches; lines seen: ${seen.join(' | ')}`
        );
    } finally {
        page.restore();
    }
});

test('a window served entirely from the day cache asks each bug once', async () => {
    // `loadDays` offers the cached days before starting the pool, so a 21 -> 7
    // switch — which fetches no day at all — has its batches in flight in the
    // first tick. The risk is a double offer: those days are offered up front
    // and the full candidate list again before `finish`, so a dispatcher that
    // did not deduplicate would ask for every bug twice here.
    const { page, client, parityState } = await startPage('cache-dispatch');
    try {
        const perDayCalls = (): number =>
            client.calls.filter((call) => {
                const parts = call.split(':');
                return call.startsWith('failures:') && parts[2] === parts[3];
            }).length;
        const daysBefore = perDayCalls();
        client.bugBatches.length = 0;

        // 21 -> 7: every day of the narrower window is already held.
        const select = page.document.getElementById('window-select') as HTMLSelectElement;
        select.value = '7days';
        select.dispatchEvent(new page.window.Event('change'));
        await settle();

        assert.equal(perDayCalls(), daysBefore, 'the cached window fetches no day');
        const asked = client.bugBatches.flat();
        assert.ok(asked.length > 0, 'it still reads its summaries');
        assert.equal(
            new Set(asked).size,
            asked.length,
            `no bug is requested twice on a cache-served load: ` +
                `${asked.length} ids, ${new Set(asked).size} distinct`
        );
        // And the set is the 7-day window's own candidates — offering the
        // cached days up front must not pull in a bug the narrower window's
        // ranking does not hold.
        const ranked = new Set(parityState().rows.map((row) => row.bugId));
        assert.ok(
            [...ranked].every((bug) => asked.includes(bug)),
            'every drawn row’s bug was asked of Bugzilla'
        );
    } finally {
        page.restore();
    }
});

test('the page never fetches a bug’s occurrences', async () => {
    const { page, client } = await startPage('no-occurrences');
    try {
        // The one request the CLI makes that this page deliberately does not:
        // measured at 2.2 MB and 5.4 s for a single row on live trunk, because
        // each occurrence carries its job's full log lines. The per-day
        // rankings give the same per-day numbers for the whole table at ~8 kB a
        // day, and `historiesFromDays` carries the verification table.
        assert.deepEqual(
            client.calls.filter((call) => call.startsWith('failuresbybug:')),
            [],
            'a sparkline must not cost a per-bug occurrence fetch'
        );
    } finally {
        page.restore();
    }
});

// --- the harness control --------------------------------------------------

test('the harness dropdown is filled from the view model, not the markup', async () => {
    const { page } = await startPage('harness-options');
    try {
        const select = page.document.getElementById('harness-select') as HTMLSelectElement;
        assert.deepEqual(
            [...select.options].map((option) => option.value),
            ['all', 'mochitest', 'xpcshell', 'unknown'],
            'four states, because `selectHarness` takes three values or `undefined`'
        );
        assert.equal(select.value, 'all', 'the unfiltered ranking is the default');
    } finally {
        page.restore();
    }
});

test('changing the harness filters, retitles, and makes no request', async () => {
    const { page, client, source, parityState } = await startPage('harness-change');
    try {
        const before = { calls: client.calls.length, data: source.requested.length };
        const select = page.document.getElementById('harness-select') as HTMLSelectElement;

        select.value = 'xpcshell';
        select.dispatchEvent(new page.window.Event('change'));

        // The load-bearing assertion of this page's design: `scanBugs` is
        // synchronous and classified every candidate before the first paint, so
        // the filter is over rows already in memory. The CLI's module header
        // still describes `--harness` as one request per candidate bug; that
        // describes an earlier implementation, and this is the check that says
        // so about the page.
        assert.equal(client.calls.length, before.calls, 'no API request');
        assert.equal(source.requested.length, before.data, 'no data request');

        const rows = rowsOf(page);
        assert.equal(rows.length, TALLY.byHarness.xpcshell.length);
        assert.deepEqual(
            rows.map(bugOf).sort((a, b) => a - b),
            [...TALLY.byHarness.xpcshell].sort((a, b) => a - b),
            'exactly the bugs whose summary names a verified xpcshell test'
        );
        // The `<h2>` that used to be retitled here is gone — "what's the point
        // of this section title when there's only one section in the entire
        // page?" — so the selection shows in the `<h1>`'s own suffix and in the
        // status line's scoped count.
        assert.match(
            page.document.getElementById('title-suffix')!.textContent ?? '',
            /Intermittent failures/
        );
        assert.match(
            statusText(page),
            new RegExp(
                `${TALLY.byHarness.xpcshell.length} of ${TALLY.candidates.length} ` +
                    'bugs are for xpcshells'
            ),
            'filtered, the line names what separates the two numbers'
        );
        assert.equal(parityState().harness, 'xpcshell');
    } finally {
        page.restore();
    }
});

test('every harness option selects exactly its own group', async () => {
    const { page } = await startPage('harness-all');
    try {
        const select = page.document.getElementById('harness-select') as HTMLSelectElement;
        for (const harness of ['mochitest', 'xpcshell', 'unknown'] as const) {
            select.value = harness;
            select.dispatchEvent(new page.window.Event('change'));
            assert.deepEqual(
                rowsOf(page)
                    .map(bugOf)
                    .sort((a, b) => a - b),
                [...TALLY.byHarness[harness]].sort((a, b) => a - b),
                `--harness ${harness}`
            );
        }
        // And `all` restores the whole ranking, classified and unknown rows
        // interleaved by count — which is the honest default for a tree-wide
        // ranking whose API has no harness parameter.
        select.value = 'all';
        select.dispatchEvent(new page.window.Event('change'));
        assert.equal(rowsOf(page).length, TALLY.candidates.length);
    } finally {
        page.restore();
    }
});

test('the unknown group’s rows have an empty test cell, not a placeholder', async () => {
    const { page } = await startPage('unknown-cell');
    try {
        const select = page.document.getElementById('harness-select') as HTMLSelectElement;
        select.value = 'unknown';
        select.dispatchEvent(new page.window.Event('change'));
        const rows = rowsOf(page);
        assert.ok(rows.length > 0);
        for (const row of rows) {
            // An absent path is an absent cell. The CLI's `testCell` records why
            // at length: a `(no test named)` marker put the failure text into
            // this column on exactly the rows whose text *is* a failure message,
            // leaving two columns carrying one field between them.
            // Column 4 is the merged `Test and failure` cell (3 is the new
            // assignee column). With no test path there is no first line at
            // all — an absent path is an absent element, not a placeholder —
            // so the cell holds only the failure message.
            assert.equal(row.querySelector('.test-path'), null, 'no placeholder path line');
            assert.ok(
                (row.querySelector('.inline-message')?.textContent ?? '').length > 0,
                'and the failure message carries the text'
            );
        }
    } finally {
        page.restore();
    }
});

// --- the URL ---------------------------------------------------------------

test('the window and harness round-trip through the hash', async () => {
    const { page } = await startPage('hash', `#date=${WINDOW_DAYS}days&harness=mochitest`);
    try {
        const select = page.document.getElementById('harness-select') as HTMLSelectElement;
        assert.equal(select.value, 'mochitest', 'the hash selects the control');
        assert.equal(rowsOf(page).length, TALLY.byHarness.mochitest.length);

        // And changing the control writes the hash back.
        select.value = 'unknown';
        select.dispatchEvent(new page.window.Event('change'));
        assert.match(page.window.location.hash, /harness=unknown/);

        // `all` is the default, so it is dropped rather than written — a shared
        // link carries what the sender changed.
        select.value = 'all';
        select.dispatchEvent(new page.window.Event('change'));
        assert.doesNotMatch(page.window.location.hash, /harness=/);
        assert.match(page.window.location.hash, /date=\d+days/, 'the window is always stated');
    } finally {
        page.restore();
    }
});

test('with no hash the page opens on 21 days and says so in the URL', async () => {
    const { page, client } = await startPage('default-window', '');
    try {
        // The window the owner reaches for by habit on `issues.html`, and the
        // one every other page here publishes. `#date=21days` is written even
        // though it is the default, because that is the URL pasted between
        // pages.
        assert.equal(page.window.location.hash, '#date=21days');
        assert.equal(
            (page.document.getElementById('window-select') as HTMLSelectElement).value,
            '21days'
        );
        // And the window really is 21 days long: 21 per-day requests, which are
        // now the only `/api/failures/` requests the page makes.
        assert.equal(
            client.calls.filter((call) => call.startsWith('failures:')).length,
            21,
            'one request per day, and no whole-window one'
        );
        // A whole number of weeks, so no caveat is shown.
        assert.equal(page.document.getElementById('window-note')!.style.display, 'none');
    } finally {
        page.restore();
    }
});

test('a window that is not a whole number of weeks is annotated on screen', async () => {
    const { page } = await startPage('odd-window', '#date=10days');
    try {
        const note = page.document.getElementById('window-note')!;
        assert.notEqual(note.style.display, 'none', 'the caveat is shown');
        assert.match(note.textContent ?? '', /weekends/);
        // A page cannot enforce whole weeks — the reader can type any `n` — so it
        // states the consequence at the moment it applies instead of refusing.
        assert.equal(
            (page.document.getElementById('window-select') as HTMLSelectElement).value,
            '10days',
            'and the window asked for is the window used'
        );
    } finally {
        page.restore();
    }
});

// --- the charts -----------------------------------------------------------

test('there is no top chart, and the volume is a sentence instead', async () => {
    // The chart was removed after measuring the hover-highlight that was meant
    // to make it useful: on 44 of the 50 drawn rows the highlighted share is
    // under 3px of a 200px plot on more than two-thirds of the bars.
    // `VolumeSeries` in `site/intermittent-view.ts` carries the table.
    //
    // Asserted rather than simply deleted, so that re-adding a chart above the
    // table is a deliberate act with a measurement behind it rather than
    // something that creeps back.
    const { page } = await startPage('volume');
    try {
        assert.equal(
            page.chartJs.find((call) => call.canvasId === 'volume-chart'),
            undefined,
            'no volume chart is drawn'
        );
        assert.equal(
            page.document.getElementById('volume-chart'),
            null,
            'and there is no canvas for one'
        );

        // What the chart was carrying is still on screen, in the status line
        // beside the window dropdown. The three sentences that used to
        // accompany it are gone — the owner's verdict on them was "blah blah" —
        // and the no-bug exclusion they explained is now the figure's tooltip.
        const status = statusText(page);

        // The total is every annotation of every day the fake served, summed
        // here off those per-day responses rather than read back off the page.
        // The fake's days tile the recorded window ranking (`rankingByDay`), so
        // this is also `raw.failures`'s own sum — which is what `TALLY.dayTotal`
        // computes by the other route.
        const total = [...RANKING_BY_DAY.values()]
            .flat()
            .reduce((sum, entry) => sum + entry.count, 0);
        assert.equal(total, TALLY.dayTotal, 'the days tile the recorded ranking');
        assert.match(
            status,
            new RegExp(`\\b${total.toLocaleString('en-US')} annotations over ${WINDOW_DAYS} days`),
            `the status line states the ${total} annotations the days carry: ${status}`
        );
        const tip =
            page.document.querySelector('.annotations-total')?.getAttribute('title') ?? '';
        assert.match(tip, /sums to less than this/, 'and the exclusion is reachable');
    } finally {
        page.restore();
    }
});

test('each row’s sparkline plots that bug’s own per-day counts', async () => {
    const { page, parityState } = await startPage('sparklines');
    try {
        const drawn = page.chartJs.filter((call) => call.canvasId.startsWith('sparkline-'));
        assert.ok(drawn.length > 0, 'sparklines were drawn');
        const histories = parityState().histories;

        for (const call of drawn) {
            const bug = call.canvasId.replace('sparkline-', '');
            // The expected series, read off the per-day responses the fake
            // served rather than off the page — so a page that plotted the
            // wrong bug's series, or the window total, fails here.
            const byDay = new Map<string, number>();
            for (const [date, rows] of RANKING_BY_DAY) {
                const entry = rows.find((row) => String(row.bugId) === bug);
                byDay.set(date, entry?.count ?? 0);
            }
            const expected = call.labels.map(
                (label) => byDay.get(`${raw.startday.slice(0, 4)}-${label}`) ?? 0
            );
            // The **view model** carries the raw counts; the dataset carries
            // what is drawn, which is not the same array any more. A zero day
            // that means something is drawn as a 1px stub rather than as
            // nothing — see `ZERO_DAY_STUB`, which is the colour-blindness
            // channel re-solved for bars — so a drawn value is either the day's
            // count or a sub-1 fraction of the row's peak.
            assert.deepEqual(histories[bug], expected, 'the view model is the raw counts');
            const drawnData = call.datasets[0]!.data as number[];
            assert.equal(drawnData.length, expected.length, 'one bar a day');
            const peak = Math.max(1, ...expected);
            for (const [index, count] of expected.entries()) {
                const drawn = drawnData[index]!;
                if (count > 0) {
                    assert.equal(drawn, count, `bug ${bug} day ${index} plots its own count`);
                } else {
                    // A stub, or nothing at all for a `quiet` zero. Either way
                    // it must not be mistakable for a real annotation.
                    assert.ok(
                        drawn === 0 || drawn === peak / 28,
                        `bug ${bug} day ${index} draws a zero as a stub, not ${drawn}`
                    );
                }
            }
            assert.equal(call.labels.length, WINDOW_DAYS, 'zero days included, so rows line up');
            assert.equal(call.attached, true);
        }
    } finally {
        page.restore();
    }
});

test('each sparkline is scaled to its own peak, and says what that peak is', async () => {
    // The change the owner's report forced. A **shared** maximum is what made
    // the column unreadable: measured on live trunk for the default window, 19
    // of the 50 drawn rows had their whole series inside 2px of the 28px cell.
    // `sparklinePeak` in `site/intermittent-view.ts` carries the numbers.
    //
    // Per-row scaling costs cross-row comparability, so the peak label is not
    // decoration — it is the condition the change rests on, and it is asserted
    // here rather than left to a reviewer's eye.
    const { page, parityState } = await startPage('sparkline-scale');
    try {
        const drawn = page.chartJs.filter((call) => call.canvasId.startsWith('sparkline-'));
        assert.ok(drawn.length > 1, 'more than one sparkline, or "per row" means nothing');
        const histories = parityState().histories;
        // The row's own peak is the **raw history's** maximum, not the drawn
        // data's: a zero day is drawn as a sub-1 stub, so `Math.max` over the
        // dataset would agree by accident on a row that peaks above 1 and
        // disagree on one that does not.
        const peakOf = (canvasId: string): number =>
            Math.max(1, ...(histories[canvasId.replace('sparkline-', '')] ?? []));
        for (const call of drawn) {
            const scales = call.options['scales'] as { y: { max: number } };
            const own = peakOf(call.canvasId);
            assert.equal(
                scales.y.max,
                own,
                `${call.canvasId} is scaled to its own peak of ${own}`
            );
        }

        // The peaks really differ across rows, so this is a behavioural
        // difference from the shared axis rather than a fixture in which every
        // row happens to peak at the same value.
        const maxima = new Set(drawn.map((call) => peakOf(call.canvasId)));
        assert.ok(maxima.size > 1, 'the drawn rows have different peaks');

        // And every row states its own maximum on screen — in the **count**
        // cell now, under the annotation total, which is where the page owner
        // moved it: "the 'peak N/day' thing could go on a second line under the
        // annotation count, reducing the total height of the chart cell
        // content."
        for (const row of rowsOf(page)) {
            const canvas = row.querySelector('canvas.sparkline');
            if (canvas === null) {
                continue;
            }
            assert.equal(
                row.querySelector('.col-chart .count-peak'),
                null,
                'the label is no longer inside the chart cell'
            );
            const label = row.querySelector('.col-count .count-peak')?.textContent ?? '';
            assert.equal(
                label,
                `peak ${peakOf(canvas.id).toLocaleString('en-US')}/day`,
                `bug ${bugOf(row)} labels its peak beside its count`
            );
        }
    } finally {
        page.restore();
    }
});

test('every sparkline canvas sits in a fixed-size box, not straight in the cell', async () => {
    // A real-browser defect, invisible to jsdom's layout because jsdom has
    // none: with the canvas as a direct child of the `<td>`, Chart.js's
    // `responsive: true` measured the table cell — which grows to its content —
    // and resized the canvas to **532px** tall, making each row 557px and the
    // 21-day page 28,872px long. The wrapper is the fix, so its presence is
    // what this asserts; `.sparkline-box`'s own CSS carries the sizes.
    //
    // A structural check rather than a measured one on purpose: jsdom would
    // report 0 for every height, so a test that asserted pixels here would pass
    // while the browser drew 532.
    const { page } = await startPage('sparkline-box');
    try {
        const canvases = [...page.document.querySelectorAll('canvas.sparkline')];
        assert.ok(canvases.length > 0, 'sparklines were drawn');
        for (const canvas of canvases) {
            const parent = canvas.parentElement;
            assert.ok(parent !== null, `${canvas.id} is in the document`);
            assert.ok(
                parent.classList.contains('sparkline-box'),
                `${canvas.id} is wrapped in a .sparkline-box, not placed in the cell`
            );
            assert.equal(
                parent.parentElement?.classList.contains('col-chart'),
                true,
                'and the box is what the cell holds'
            );
        }
    } finally {
        page.restore();
    }
});

test('a row whose bug has no per-day data still has a row, without a chart', async () => {
    // **Every bug in this fixture has recorded occurrences**, so the filter
    // below selects nothing and this test's loop is vacuous against it. Stated
    // rather than papered over with a guard that would simply fail: the case is
    // real on live data — a bug ranked in the window whose per-day request was
    // the one that failed — and `tableRows` is where it is handled. The
    // behaviour is covered non-vacuously by `tableRows` in
    // `test/intermittent-view.test.ts`, which feeds it a bug absent from
    // `histories` directly; what this test adds is that the *rendered* row
    // survives it, for a fixture that ever grows such a bug.
    const { page } = await startPage('flat-rows');
    try {
        const rows = rowsOf(page);
        const withoutHistory = rows.filter(
            (row) => (raw.failuresbybug[String(bugOf(row))] ?? []).length === 0
        );
        for (const row of withoutHistory) {
            // The count came from the window ranking and is real whether or not
            // a per-day breakdown arrived; dropping the row would make a chart
            // failure look like a data absence.
            assert.equal(row.querySelector('canvas.sparkline'), null, 'no chart');
            // And no peak label either: there is no scale to explain.
            assert.equal(row.querySelector('.count-peak'), null, 'and no peak label');
            assert.ok(countOf(row) > 0, 'but the count is there');
        }
        // What *is* non-vacuous here: every drawn row has a chart and a label
        // together, or neither. A row with a canvas and no label is the
        // per-row-scale defect this pair exists to prevent.
        for (const row of rows) {
            assert.equal(
                row.querySelector('canvas.sparkline') === null,
                row.querySelector('.count-peak') === null,
                `bug ${bugOf(row)} has a chart and its peak label together, or neither`
            );
        }
    } finally {
        page.restore();
    }
});

// --- a resolved bug --------------------------------------------------------

/** The fixture's bugs that Bugzilla has resolved, and the ones it has not. */
const RESOLVED = Object.entries(raw.bugStates)
    .filter(([, state]) => state.resolution !== '')
    .map(([bug]) => Number(bug));
const OPEN = Object.entries(raw.bugStates)
    .filter(([, state]) => state.resolution === '')
    .map(([bug]) => Number(bug));

test('the fixture has both resolved and open bugs to tell apart', () => {
    // The vacuity guard for everything below: a fixture in which every bug were
    // open would pass a page that never struck anything through, and one in
    // which every bug were resolved would pass a page that struck everything.
    assert.ok(RESOLVED.length > 0, 'some bugs are resolved');
    assert.ok(OPEN.length > 0, 'and some are open');
});

test('a resolved bug is struck through, and an open one is not', async () => {
    // The owner's first report: "the status of bugs isn't visible, FIXED bugs
    // (or resolved more generally) should be striked through". The class is the
    // seam — the stylesheet turns it into `text-decoration: line-through` — so
    // this asserts the class and the row's own accessible text, which is what
    // survives a stylesheet a jsdom test cannot evaluate.
    const { page } = await startPage('resolved');
    try {
        const rows = rowsOf(page);
        assert.ok(rows.length > 0);
        let sawResolved = 0;
        let sawOpen = 0;
        for (const row of rows) {
            const bug = bugOf(row);
            const state = raw.bugStates[String(bug)];
            assert.ok(state !== undefined, `the fixture has a state for bug ${bug}`);
            if (state.resolution !== '') {
                sawResolved++;
                assert.ok(
                    row.classList.contains('resolved'),
                    `bug ${bug} is ${state.status} ${state.resolution} and must be struck through`
                );
                // Not only colour and a line: the resolution word is on screen,
                // because FIXED and WONTFIX are struck identically and mean
                // different things.
                assert.equal(
                    row.querySelector('.resolution-tag')?.textContent,
                    state.resolution,
                    `bug ${bug} names its resolution`
                );
                // And the full Bugzilla state is legible without the
                // stylesheet, which is the "surface it somewhere legible"
                // requirement.
                assert.match(
                    row.title,
                    new RegExp(`${state.status} ${state.resolution}`),
                    `bug ${bug}'s tooltip names its status: ${row.title}`
                );
            } else {
                sawOpen++;
                assert.ok(
                    !row.classList.contains('resolved'),
                    `bug ${bug} is ${state.status} and must not be struck through`
                );
                assert.equal(row.querySelector('.resolution-tag'), null, 'and carries no tag');
                assert.equal(row.title, '', 'and no status tooltip');
            }
        }
        assert.ok(sawResolved > 0, 'the table drew a resolved bug');
        assert.ok(sawOpen > 0, 'and an open one');
    } finally {
        page.restore();
    }
});

test('a REOPENED bug is not struck through', async () => {
    // Bugzilla clears `resolution` when a bug is reopened, so reading `status`
    // for the string "RESOLVED" would be wrong in both directions — it would
    // miss `VERIFIED` and `CLOSED`, and it would strike a `REOPENED` bug that
    // somebody is actively working on. The fixture has two REOPENED bugs.
    const reopened = Object.entries(raw.bugStates)
        .filter(([, state]) => state.status === 'REOPENED')
        .map(([bug]) => Number(bug));
    assert.ok(reopened.length > 0, 'the fixture records a REOPENED bug');
    const { page } = await startPage('reopened');
    try {
        for (const row of rowsOf(page)) {
            if (reopened.includes(bugOf(row))) {
                assert.ok(!row.classList.contains('resolved'), `bug ${bugOf(row)} is reopened`);
            }
        }
    } finally {
        page.restore();
    }
});

// --- the sparkline's zero days and tooltip ---------------------------------

/**
 * What the `<h1>` reads as, with the dropdown showing only its selected option.
 *
 * `h1.textContent` concatenates every `<option>`'s text — "allMochitestXPCShell
 * Unknown test Intermittent failures" — because that is what the DOM says the
 * element's text content is. What a reader sees is the *selected* option beside
 * the suffix, so that is what is reconstructed here.
 */
function titleReads(page: { document: Document }): string {
    const h1 = page.document.querySelector('h1');
    if (h1 === null) {
        return '';
    }
    return [...h1.childNodes]
        .map((node) => {
            if (node instanceof (node.ownerDocument!.defaultView!).HTMLSelectElement) {
                return node.options[node.selectedIndex]?.textContent ?? '';
            }
            return node.textContent ?? '';
        })
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * A drawn sparkline's per-day colours, as the config carries them.
 *
 * `backgroundColor` and no longer `pointBackgroundColor`: the chart is a bar
 * chart now — the page owner's fourth report, "a bar chart would be better" —
 * and a bar carries its colour on the fill rather than on a point marker.
 */
function barColours(call: { config: Record<string, unknown> }): string[] {
    const data = call.config['data'] as {
        datasets: { backgroundColor?: string[] }[];
    };
    return data.datasets[0]?.backgroundColor ?? [];
}

test('a resolved bug’s zero days are green, and leading zeros are grey', async () => {
    // The owner's fifth report. Three cases, and the colours are the `dataviz`
    // skill's status steps — `ZERO_DAY_COLOURS` in `site/intermittent.ts`
    // records which and why, including the shape channel beside the hue.
    const { page, parityState } = await startPage('zero-days');
    try {
        const histories = parityState().histories;
        const drawn = page.chartJs.filter((call) => call.canvasId.startsWith('sparkline-'));
        assert.ok(drawn.length > 0);
        let sawGreen = 0;
        let sawGrey = 0;
        for (const call of drawn) {
            const bug = Number(call.canvasId.replace('sparkline-', ''));
            const series = histories[String(bug)] ?? [];
            const resolved = (raw.bugStates[String(bug)]?.resolution ?? '') !== '';
            const colours = barColours(call);
            assert.equal(colours.length, series.length, `bug ${bug} colours every day`);
            const firstFailure = series.findIndex((count) => count > 0);
            for (const [index, count] of series.entries()) {
                if (count > 0) {
                    assert.equal(colours[index], '#e8834a', `bug ${bug} day ${index} has failures`);
                } else if (firstFailure === -1 || index < firstFailure) {
                    assert.equal(colours[index], '#898781', `bug ${bug} day ${index} is leading`);
                    sawGrey++;
                } else if (resolved) {
                    assert.equal(colours[index], '#0ca30c', `bug ${bug} day ${index} is fixed`);
                    sawGreen++;
                } else {
                    assert.equal(colours[index], '#e8834a', `bug ${bug} day ${index} is quiet`);
                }
            }
        }
        // Both cases really occur, so neither branch is asserted vacuously.
        assert.ok(sawGreen > 0, 'a resolved bug had a zero day drawn green');
        assert.ok(sawGrey > 0, 'and some row had a leading zero drawn grey');
    } finally {
        page.restore();
    }
});

test('the sparklines are bars, and a meaningful zero still draws a mark', async () => {
    // The page owner's fourth report: "using a line chart with a colored aread
    // for failure counts is weird, a bar chart would be better."
    //
    // The second half of this test is the part worth having. A line chart could
    // carry the colour-blindness channel as a point *shape* (the green/orange
    // pair is ΔE 4.0 under protanopia, inside the band the `dataviz` skill says
    // needs a second channel); a bar of zero height has no shape to set. So the
    // channel is height: a zero that means something draws a 1px stub, and a
    // `quiet` zero draws nothing. `ZERO_DAY_STUB` records the reasoning.
    const { page, parityState } = await startPage('bars');
    try {
        const histories = parityState().histories;
        const drawn = page.chartJs.filter((call) => call.canvasId.startsWith('sparkline-'));
        assert.ok(drawn.length > 0);
        let sawStub = 0;
        for (const call of drawn) {
            assert.equal(call.config['type'], 'bar', `${call.canvasId} is a bar chart`);
            const bug = Number(call.canvasId.replace('sparkline-', ''));
            const series = histories[String(bug)] ?? [];
            const resolved = (raw.bugStates[String(bug)]?.resolution ?? '') !== '';
            const data = (call.datasets[0]!.data as number[]);
            const peak = Math.max(1, ...series);
            const firstFailure = series.findIndex((count) => count > 0);
            for (const [index, count] of series.entries()) {
                if (count > 0) {
                    continue;
                }
                const meaningful = firstFailure === -1 || index < firstFailure || resolved;
                if (meaningful) {
                    // Drawn, and drawn as one pixel of this row's own scale, so
                    // a row peaking at 400 gets a visible tick rather than an
                    // invisible one.
                    assert.equal(
                        data[index],
                        peak / 28,
                        `bug ${bug} day ${index} draws a 1px stub`
                    );
                    sawStub++;
                } else {
                    assert.equal(data[index], 0, `bug ${bug} day ${index} is quiet, so unmarked`);
                }
            }
        }
        assert.ok(sawStub > 0, 'some zero day carried a stub, or the branch is vacuous');
    } finally {
        page.restore();
    }
});

test('an open bug’s zero day is not green', async () => {
    // The rule that makes green mean something: nothing has been achieved by an
    // intermittent that merely did not fire, so only a resolved bug earns it.
    const { page, parityState } = await startPage('open-zero');
    try {
        const histories = parityState().histories;
        for (const call of page.chartJs.filter((c) => c.canvasId.startsWith('sparkline-'))) {
            const bug = Number(call.canvasId.replace('sparkline-', ''));
            if ((raw.bugStates[String(bug)]?.resolution ?? '') !== '') {
                continue;
            }
            assert.ok(
                !barColours(call).includes('#0ca30c'),
                `open bug ${bug} must have no green day`
            );
            // And it does have zero days, or the assertion above is vacuous.
            assert.ok((histories[String(bug)] ?? []).length > 0);
        }
    } finally {
        page.restore();
    }
});

/**
 * Fires a chart's external tooltip handler for one day, and reads the result.
 *
 * The tooltip is no longer Chart.js's own: it is a `<body>`-level element this
 * page positions itself, because the built-in one is drawn **into the canvas**
 * and this canvas is a 28px-tall table cell — so a three-line tooltip was
 * clipped by the chart it described ("only the date is visible in the tooltip,
 * that covers the entire chart"). `showChartTooltip` records the reasoning.
 *
 * So the handler is invoked rather than a callback, and what comes back is the
 * DOM node it filled: that is the thing the reader actually sees.
 */
function hoverDay(
    page: ReturnType<typeof setupPage>,
    call: { canvasId: string; options: Record<string, unknown> },
    dataIndex: number
): { date: string; count: string; element: HTMLElement } {
    const plugins = call.options['plugins'] as {
        tooltip: { enabled: boolean; external(context: unknown): void };
    };
    // `enabled: false` is half the fix — without it Chart.js draws its own
    // clipped tooltip as well as calling this one.
    assert.equal(plugins.tooltip.enabled, false, 'the in-canvas tooltip is off');
    const canvas = page.document.getElementById(call.canvasId)!;
    plugins.tooltip.external({
        chart: { canvas },
        tooltip: { opacity: 1, dataPoints: [{ dataIndex }], caretX: 40, caretY: 14 },
    });
    const element = page.document.querySelector('.chart-tooltip') as HTMLElement;
    assert.ok(element !== null, 'the tooltip element exists');
    return {
        date: element.querySelector('.chart-tooltip-date')?.textContent ?? '',
        count: element.querySelector('.chart-tooltip-count')?.textContent ?? '',
        element,
    };
}

test('the sparkline tooltip names the day and that day’s count, outside the canvas', async () => {
    // The owner's fifth report, first half: "a tooltip on hover showing how many
    // failures was encountered on the hovered day". The handler is invoked here
    // rather than asserted to exist, because a handler that throws or reads the
    // wrong field is exactly the defect a presence check misses.
    const { page, parityState } = await startPage('tooltip');
    try {
        const histories = parityState().histories;
        const call = page.chartJs.find((c) => c.canvasId.startsWith('sparkline-'));
        assert.ok(call !== undefined, 'a sparkline was drawn');
        const bug = Number(call.canvasId.replace('sparkline-', ''));
        const series = histories[String(bug)] ?? [];

        // The full `YYYY-MM-DD`, where the axis is hidden entirely: the tooltip
        // is the only place the day is named.
        const dates = daysOfWindow(RANGE);
        for (const [index, date] of dates.entries()) {
            assert.equal(hoverDay(page, call, index).date, date, `day ${index}`);
        }

        // And the count, as a number the reader asked for.
        const failing = series.findIndex((count) => count > 1);
        assert.ok(failing !== -1, `bug ${bug} has a day with more than one annotation`);
        assert.equal(
            hoverDay(page, call, failing).count,
            `${series[failing]!.toLocaleString('en-US')} annotations`
        );
        // Singular, because "1 annotations" is the kind of thing a reader
        // notices and nothing else on the page would catch.
        const one = series.findIndex((count) => count === 1);
        if (one !== -1) {
            assert.equal(hoverDay(page, call, one).count, '1 annotation');
        }

        // A zero day says what the zero means, which is the whole reason the
        // zero days are coloured at all.
        const leading = series.findIndex((count) => count > 0);
        if (leading > 0) {
            assert.match(
                hoverDay(page, call, 0).count,
                /before this bug's first in the window/
            );
        }
    } finally {
        page.restore();
    }
});

test('the tooltip is attached to the body, so no row can clip it', async () => {
    // The defect itself, as a structural assertion. A tooltip inside the cell,
    // the row or the table is clipped by a 28px-tall cell however it is styled,
    // so what matters is which element it hangs off — and that it is removed
    // from the flow, since a `<body>` child in normal flow would appear at the
    // bottom of the page.
    const { page } = await startPage('tooltip-attach');
    try {
        const call = page.chartJs.find((c) => c.canvasId.startsWith('sparkline-'));
        assert.ok(call !== undefined);
        const { element } = hoverDay(page, call, 0);
        assert.equal(element.parentElement, page.document.body, 'a direct child of <body>');
        assert.equal(element.closest('table'), null, 'and outside the table entirely');
        // Positioned by the handler, in page coordinates.
        assert.match(element.style.left, /^-?\d/, 'left is set');
        assert.match(element.style.top, /^-?\d/, 'top is set');
        assert.equal(element.style.display, 'block', 'and shown');

        // One element for the whole page, not one per chart: there are up to
        // ~1,170 charts and only ever one pointer.
        const another = page.chartJs.filter((c) => c.canvasId.startsWith('sparkline-'))[1];
        if (another !== undefined) {
            hoverDay(page, another, 0);
            assert.equal(
                page.document.querySelectorAll('.chart-tooltip').length,
                1,
                'hovering a second chart reuses the same element'
            );
        }

        // And it hides when the pointer leaves, which Chart.js signals with
        // zero opacity rather than by calling anything else.
        const plugins = call.options['plugins'] as {
            tooltip: { external(context: unknown): void };
        };
        plugins.tooltip.external({
            chart: { canvas: page.document.getElementById(call.canvasId)! },
            tooltip: { opacity: 0, dataPoints: [{ dataIndex: 0 }], caretX: 0, caretY: 0 },
        });
        assert.equal(element.style.display, 'none', 'and hidden on leave');
    } finally {
        page.restore();
    }
});

test('a resolved bug’s zero day says so in the tooltip', async () => {
    const { page, parityState } = await startPage('tooltip-fixed');
    try {
        const histories = parityState().histories;
        for (const call of page.chartJs.filter((c) => c.canvasId.startsWith('sparkline-'))) {
            const bug = Number(call.canvasId.replace('sparkline-', ''));
            if ((raw.bugStates[String(bug)]?.resolution ?? '') === '') {
                continue;
            }
            const series = histories[String(bug)] ?? [];
            const firstFailure = series.findIndex((count) => count > 0);
            const fixedDay = series.findIndex(
                (count, index) => count === 0 && firstFailure !== -1 && index > firstFailure
            );
            if (fixedDay === -1) {
                continue;
            }
            assert.match(
                hoverDay(page, call, fixedDay).count,
                /the bug is resolved/,
                `bug ${bug} day ${fixedDay}`
            );
            return;
        }
        assert.fail('no resolved bug had a zero day after its first failure');
    } finally {
        page.restore();
    }
});

// --- the in-title harness dropdown ----------------------------------------

test('the harness dropdown is inside the title, with the shared switcher class', async () => {
    // The owner's third report: "the drop down to select the harness should
    // match the one we have on issues.html, ie it should be part of the big
    // title." `.harness-switcher` is that shared treatment, defined in
    // `shared.css` and used by `common-ui.js`'s `initHarnessSwitcher`, which
    // this page borrows the look of without borrowing the behaviour — see
    // `site/intermittent.html` for why.
    const { page } = await startPage('title-dropdown');
    try {
        const select = page.document.getElementById('harness-select')!;
        const h1 = page.document.querySelector('h1');
        assert.ok(h1 !== null, 'the page has an h1');
        assert.ok(h1.contains(select), 'the dropdown is inside the title');
        assert.ok(
            select.classList.contains('harness-switcher'),
            'and wears the shared switcher class'
        );
        // The title reads as one phrase: "[all] Intermittent failures".
        assert.equal(titleReads(page), 'all Intermittent failures');
    } finally {
        page.restore();
    }
});

test('the title and the tab both follow the harness selection', async () => {
    const { page } = await startPage('title-follows');
    try {
        const select = page.document.getElementById('harness-select') as HTMLSelectElement;
        const reads = (): string => titleReads(page);

        assert.equal(reads(), 'all Intermittent failures');
        assert.equal(page.document.title, 'all Intermittent failures');

        select.value = 'mochitest';
        select.dispatchEvent(new page.window.Event('change'));
        // The owner's wording, exactly: "[Mochitest] Intermittent failures".
        assert.equal(reads(), 'Mochitest Intermittent failures');
        assert.equal(page.document.title, 'Mochitest Intermittent failures');

        // `No known test` became `Unknown test`, so it reads as a noun phrase
        // in this position rather than as a description of a group.
        select.value = 'unknown';
        select.dispatchEvent(new page.window.Event('change'));
        assert.equal(reads(), 'Unknown test Intermittent failures');
    } finally {
        page.restore();
    }
});

// --- the window dropdown ---------------------------------------------------

test('the window dropdown offers 30 days, and still defaults to 21', async () => {
    // The owner's seventh report. 30 is not a whole number of weeks, so
    // selecting it shows `windowNote`'s caveat — offered anyway, because the
    // URL can ask for it regardless and a control narrower than the page is a
    // control that disagrees with it.
    const { page } = await startPage('window-30');
    try {
        const select = page.document.getElementById('window-select') as HTMLSelectElement;
        // The four offered windows. These tests pin the window to the
        // fixture's own span via the hash, and `initWindowControl` appends an
        // option for a window the markup does not offer — so the expected list
        // is the four plus that one only when the fixture's span is not already
        // one of them.
        const offered = ['7days', '14days', '21days', '30days'];
        const pinned = `${WINDOW_DAYS}days`;
        assert.deepEqual(
            [...select.options].map((option) => option.value),
            offered.includes(pinned) ? offered : [...offered, pinned]
        );
        assert.ok(offered.includes('30days'), 'and 30 days is one of them');
        assert.equal(DEFAULT_WINDOW, '21days', 'and 21 is still the default');
    } finally {
        page.restore();
    }
});

// --- the expanded row's drill-down ----------------------------------------

/**
 * One bug's drill-down, tallied off the raw fixture.
 *
 * Nothing here imports `summariseBug` — the grouping rules are restated, so a
 * page (or a library) that grouped differently fails. The chunk-stripping rule
 * is the one worth restating carefully: `mochitest-browser-chunk-3` and `-12`
 * are one configuration, so a trailing `-<digits>` is dropped, and a variant
 * suffix like `-swr` is not a chunk and survives.
 */
function handDrilldown(bugId: number): {
    occurrences: number;
    platforms: [string, number][];
    jobNames: [string, number][];
    buildTypes: [string, number][];
    trees: [string, number][];
} {
    const rows = raw.failuresbybug[String(bugId)] ?? [];
    const tally = (values: string[]): [string, number][] => {
        const counts = new Map<string, number>();
        for (const value of values) {
            counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    };
    return {
        occurrences: rows.length,
        platforms: tally(rows.map((row) => row.platform)),
        jobNames: tally(rows.map((row) => row.test_suite.replace(/-\d+$/, ''))),
        buildTypes: tally(rows.map((row) => row.build_type)),
        trees: tally(rows.map((row) => row.tree)),
    };
}

/** The bug the fixture has most occurrences for, so the panel is not degenerate. */
const DRILL_BUG = Number(
    Object.entries(raw.failuresbybug).sort((a, b) => b[1].length - a[1].length)[0]![0]
);

/** Clicks a row's count cell — a part of the row that is not a link. */
function clickRow(page: Awaited<ReturnType<typeof startPage>>['page'], bugId: number): void {
    const row = page.document.getElementById(`row-${bugId}`) as HTMLTableRowElement | null;
    assert.ok(row !== null, `bug ${bugId} has a row`);
    const cell = row.querySelector('td.col-count');
    assert.ok(cell !== null, 'the row has a count cell to click');
    cell.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
}

/** Waits for the expand's fetch to settle. */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

test('the fixture has a bug worth expanding', () => {
    const hand = handDrilldown(DRILL_BUG);
    assert.ok(hand.occurrences > 1, `bug ${DRILL_BUG} has occurrences`);
    assert.ok(hand.platforms.length > 1, 'across more than one platform');
});

test('expanding a row shows the drill-down, and its numbers are the fixture’s', async () => {
    const { page } = await startPage('expand');
    try {
        assert.equal(page.document.getElementById(`panel-${DRILL_BUG}`), null, 'collapsed first');
        clickRow(page, DRILL_BUG);
        // The loading state is on screen *before* the fetch resolves, because a
        // 2.2 MB request with nothing on screen reads as a broken click.
        const loading = page.document.getElementById(`panel-${DRILL_BUG}`);
        assert.ok(loading !== null, 'the panel appears immediately');
        assert.match(loading.textContent ?? '', /Loading every annotated job/);

        await settle();
        const panel = page.document.getElementById(`panel-${DRILL_BUG}`);
        assert.ok(panel !== null, 'the panel is still there');
        const text = panel.textContent ?? '';
        const hand = handDrilldown(DRILL_BUG);

        // The header states the population, as the CLI's `drilldownCountLine`
        // does.
        assert.match(text, new RegExp(`${hand.occurrences.toLocaleString('en-US')} sheriff annotations`));

        // The sections, in the layout the page owner asked for: the four
        // short-valued axes as columns, then the two long-valued sections each
        // across the full width, because "'failure messages' and 'Test names'
        // need a much larger width".
        const headings = [...panel.querySelectorAll('.drilldown-heading')].map((n) => n.textContent);
        assert.deepEqual(headings, [
            'Job names',
            'Platforms',
            'Build types',
            'Trees',
            'Failure messages, per annotated job',
            'Tests named, per annotated job',
        ]);
        // The short ones are in the column grid and the long ones are not.
        const widthOf = (heading: string): string => {
            const node = [...panel.querySelectorAll('.drilldown-section')].find(
                (section) => section.querySelector('.drilldown-heading')?.textContent === heading
            )!;
            return node.closest('.drilldown-grid') === null ? 'full' : 'column';
        };
        assert.equal(widthOf('Job names'), 'column');
        assert.equal(widthOf('Platforms'), 'column');
        assert.equal(widthOf('Build types'), 'column');
        assert.equal(widthOf('Trees'), 'column');
        assert.equal(widthOf('Failure messages, per annotated job'), 'full');
        assert.equal(widthOf('Tests named, per annotated job'), 'full');
        // The suffix the owner asked to be dropped is gone from the heading,
        // and the behaviour it described is stated in a tooltip instead.
        const jobHeading = [...panel.querySelectorAll('.drilldown-heading')].find(
            (n) => n.textContent === 'Job names'
        )!;
        assert.match(jobHeading.getAttribute('title') ?? '', /Chunk numbers are merged/);

        // And the tallies are the fixture's own, count-descending.
        const section = (heading: string): [string, number][] => {
            const node = [...panel.querySelectorAll('.drilldown-section')].find(
                (s) => s.querySelector('.drilldown-heading')?.textContent === heading
            );
            assert.ok(node !== undefined, `the ${heading} section exists`);
            return [...node.querySelectorAll('.drilldown-item')].map((item) => [
                item.querySelector('.drilldown-item-name')?.textContent ?? '',
                Number((item.querySelector('.drilldown-item-count')?.textContent ?? '').replace(/,/g, '')),
            ]);
        };
        assert.deepEqual(section('Platforms'), hand.platforms);
        assert.deepEqual(section('Build types'), hand.buildTypes);
        assert.deepEqual(section('Trees'), hand.trees);
        // The chunk-merging rule, restated in `handDrilldown` rather than
        // imported: `mochitest-browser-chrome-1..12` is one row.
        assert.deepEqual(section('Job names'), hand.jobNames);

        // The panel spans the whole table, or it sits under one column of it.
        const cell = panel.querySelector('td') as HTMLTableCellElement;
        assert.equal(cell.colSpan, page.document.querySelectorAll('table.ranking thead th').length);
    } finally {
        page.restore();
    }
});

test('expanding fetches once, and a second expand makes no request', async () => {
    // The cost this caches against was measured at 2.2 MB and 5.4 s for one
    // bug, which is why the ranked table never calls it per row and why a
    // re-expand must not repeat it.
    const { page, client } = await startPage('expand-cache');
    try {
        const occurrenceCalls = (): number =>
            client.calls.filter((call) => call.startsWith(`failuresbybug:${DRILL_BUG}:`)).length;
        assert.equal(occurrenceCalls(), 0, 'nothing is prefetched for the table');

        clickRow(page, DRILL_BUG);
        await settle();
        assert.equal(occurrenceCalls(), 1, 'one fetch on first expand');

        // Collapse and re-expand: served from the cache.
        clickRow(page, DRILL_BUG);
        await settle();
        assert.equal(page.document.getElementById(`panel-${DRILL_BUG}`), null, 'collapsed');
        clickRow(page, DRILL_BUG);
        await settle();
        assert.ok(page.document.getElementById(`panel-${DRILL_BUG}`) !== null, 'expanded again');
        assert.equal(occurrenceCalls(), 1, 'and no second request');
    } finally {
        page.restore();
    }
});

test('two fast expands of the same row do not race two fetches', async () => {
    const { page, client } = await startPage('expand-race');
    try {
        // Two clicks inside one microtask turn: the first starts the fetch, the
        // second collapses. Neither may issue a second request.
        clickRow(page, DRILL_BUG);
        clickRow(page, DRILL_BUG);
        clickRow(page, DRILL_BUG);
        await settle();
        assert.equal(
            client.calls.filter((call) => call.startsWith(`failuresbybug:${DRILL_BUG}:`)).length,
            1,
            'one fetch, however many times the row was clicked'
        );
    } finally {
        page.restore();
    }
});

test('the table prefetches no occurrences and no per-bug failure counts', async () => {
    // The two per-bug routes both cost O(rows): `/api/failuresbybug/` at 2.2 MB
    // each, and `/api/failurecount/` at 1 request per bug with no batching
    // (`bug=a,b` is a 400). With the table uncapped at 1,170 rows, either would
    // be over a thousand requests — so the sparklines come from the per-day
    // route and these two are only ever reached on demand.
    const { page, client } = await startPage('no-prefetch');
    try {
        assert.equal(
            client.calls.filter((call) => call.startsWith('failuresbybug:')).length,
            0,
            'no occurrences fetched for the ranked table'
        );
        assert.equal(
            client.calls.filter((call) => call.startsWith('failurecount:')).length,
            0,
            'and no per-bug failure counts either'
        );
    } finally {
        page.restore();
    }
});

test('a failed expand says so in the panel rather than collapsing', async () => {
    // A row that springs shut on click is indistinguishable from a broken
    // handler, so the error is stated where the reader clicked.
    const { page } = await startPage('expand-error', {
        occurrencesOfBug: () => Promise.reject(new Error('treeherder is down')),
    });
    try {
        clickRow(page, DRILL_BUG);
        await settle();
        const panel = page.document.getElementById(`panel-${DRILL_BUG}`);
        assert.ok(panel !== null, 'the panel stays open');
        assert.match(panel.textContent ?? '', /Could not load bug .* treeherder is down/);
    } finally {
        page.restore();
    }
});

test('clicking the path, the copy button or the bug link does not expand', async () => {
    // The owner's original complaint on try.html, which must not regress here:
    // the links inside a clickable row are their own targets.
    const { page } = await startPage('expand-links');
    try {
        const withTest = rowsOf(page).find((row) => row.querySelector('td.col-test a') !== null);
        assert.ok(withTest !== undefined, 'a row with a test path');
        const bug = bugOf(withTest);

        for (const selector of ['td.col-test a', 'td.col-test button', 'a.bug-link']) {
            const target = withTest.querySelector(selector);
            assert.ok(target !== null, `the row has a ${selector}`);
            target.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
            await settle();
            assert.equal(
                page.document.getElementById(`panel-${bug}`),
                null,
                `clicking ${selector} must not expand the row`
            );
        }

        // And the row itself still does expand, or the guard above is just
        // "nothing works".
        clickRow(page, bug);
        await settle();
        assert.ok(page.document.getElementById(`panel-${bug}`) !== null, 'the row still expands');
    } finally {
        page.restore();
    }
});

test('an expanded row survives a harness change without refetching', async () => {
    const { page, client } = await startPage('expand-rerender');
    try {
        clickRow(page, DRILL_BUG);
        await settle();
        const before = client.calls.filter((c) => c.startsWith('failuresbybug:')).length;

        // Re-render in place: the selection changes and the table is rebuilt.
        const select = page.document.getElementById('harness-select') as HTMLSelectElement;
        const harnessOf = (bug: number): string =>
            TALLY.byHarness.mochitest.includes(bug)
                ? 'mochitest'
                : TALLY.byHarness.xpcshell.includes(bug)
                  ? 'xpcshell'
                  : 'unknown';
        select.value = harnessOf(DRILL_BUG);
        select.dispatchEvent(new page.window.Event('change'));
        await settle();

        assert.ok(
            page.document.getElementById(`panel-${DRILL_BUG}`) !== null,
            'the row the reader opened is still open after the re-render'
        );
        assert.equal(
            client.calls.filter((c) => c.startsWith('failuresbybug:')).length,
            before,
            'rebuilt from the cache, with no new request'
        );
    } finally {
        page.restore();
    }
});

// --- the per-day cache -----------------------------------------------------

test('switching the window refetches only the days it does not already hold', async () => {
    // The page owner's eighth report: "when switching the value of the time
    // window drop down, it seems we redo from scratch all the per-day requests,
    // even though I would expect at a minimum 7 of these to be already
    // available locally." That was exactly what happened — `reload` cleared
    // everything and `loadDays` refetched the whole window.
    //
    // Keyed by (tree, day), which is safe because a past day's annotations are
    // immutable: the window is a different *selection* of days, never different
    // data for one day. See `dayCache`.
    const { page, client } = await startPage('day-cache', '#date=7days');
    try {
        const daysFetched = (): string[] =>
            client.calls.filter((call) => {
                const parts = call.split(':');
                return call.startsWith('failures:') && parts[2] === parts[3];
            });
        const first = daysFetched();
        assert.equal(first.length, 7, 'the 7-day window reads seven days');

        const select = page.document.getElementById('window-select') as HTMLSelectElement;

        // 7 -> 21 fetches only the fourteen days it does not hold.
        select.value = '21days';
        select.dispatchEvent(new page.window.Event('change'));
        await settle();
        const after21 = daysFetched();
        assert.equal(
            after21.length - first.length,
            14,
            `7 -> 21 fetches 14 new days, made ${after21.length - first.length}`
        );
        // And no day is fetched twice across the two loads.
        assert.equal(new Set(after21).size, after21.length, 'no day is requested twice');

        // 21 -> 7 fetches nothing: every day of the narrower window is held.
        select.value = '7days';
        select.dispatchEvent(new page.window.Event('change'));
        await settle();
        assert.equal(
            daysFetched().length,
            after21.length,
            '21 -> 7 makes no per-day request at all'
        );
    } finally {
        page.restore();
    }
});

// --- the failure messages' own expansion -----------------------------------

test('expanding a failure message lists its jobs, and makes no request', async () => {
    // The no-extra-fetch property is the point of this level: the panel already
    // holds every occurrence of the bug, and `BugDrilldown.lines` is a tally
    // over their `lines` — so "which jobs logged this message" is a regrouping
    // of data already in memory. `jobsByLine` records that.
    const { page, client, source } = await startPage('line-expand');
    try {
        clickRow(page, DRILL_BUG);
        await settle();
        const before = { calls: client.calls.length, data: source.requested.length };

        const panel = page.document.getElementById(`panel-${DRILL_BUG}`)!;
        const section = [...panel.querySelectorAll('.drilldown-section')].find(
            (node) =>
                node.querySelector('.drilldown-heading')?.textContent ===
                'Failure messages, per annotated job'
        )!;
        const item = section.querySelector('.drilldown-item.expandable') as HTMLElement;
        assert.ok(item !== null, 'a failure message row is expandable');
        assert.equal(item.getAttribute('aria-expanded'), 'false', 'collapsed first');

        item.dispatchEvent(new page.window.Event('click', { bubbles: true }));
        await settle();

        // Zero requests, which is the assertion this test exists for.
        assert.equal(client.calls.length, before.calls, 'no API request');
        assert.equal(source.requested.length, before.data, 'no data request');

        // The jobs are listed, and each carries the fields the panel promises.
        const reopened = page.document.getElementById(`panel-${DRILL_BUG}`)!;
        const rows = [...reopened.querySelectorAll('.job-list .job-row')];
        assert.ok(rows.length > 0, 'the jobs are listed');
        for (const row of rows) {
            assert.ok(
                (row.querySelector('.job-name')?.textContent ?? '').length > 0,
                'each job is named'
            );
            // Every job offers at least one way out — a job link, or the push
            // when the task id is the sentinel.
            assert.ok(
                row.querySelectorAll('.job-links a').length > 0,
                'each job links somewhere'
            );
        }

        // Clicking again collapses it, still without a request.
        const openItem = reopened.querySelector('.drilldown-item.expandable') as HTMLElement;
        assert.equal(openItem.getAttribute('aria-expanded'), 'true');
        openItem.dispatchEvent(new page.window.Event('click', { bubbles: true }));
        await settle();
        assert.equal(client.calls.length, before.calls, 'and collapsing costs nothing');
        assert.equal(
            page.document.querySelectorAll(`#panel-${DRILL_BUG} .job-list`).length,
            0,
            'collapsed again'
        );
    } finally {
        page.restore();
    }
});

test('a long job list is capped, and the rest is one click away', async () => {
    // Found in a real browser against live trunk: the top bug's most common
    // failure message carried 573 jobs, which put ~570 rows between the reader
    // and the next section. Capped at `JOB_LIST_ROWS` — and because the
    // no-silent-truncation rule holds on this page, the total is stated and the
    // remainder is reachable rather than dropped.
    const { page, client } = await startPage('job-cap');
    try {
        clickRow(page, DRILL_BUG);
        await settle();
        const item = page.document.querySelector(
            `#panel-${DRILL_BUG} .drilldown-item.expandable`
        ) as HTMLElement;
        item.dispatchEvent(new page.window.Event('click', { bubbles: true }));
        await settle();

        const shown = (): number =>
            page.document.querySelectorAll(`#panel-${DRILL_BUG} .job-row`).length;
        const toggle = page.document.querySelector(
            `#panel-${DRILL_BUG} .job-list-more`
        ) as HTMLButtonElement | null;
        if (toggle === null) {
            // The fixture's longest list is under the cap, so there is nothing
            // to disclose. Stated rather than silently passing.
            assert.ok(shown() > 0, 'the jobs are listed');
            return;
        }
        const capped = shown();
        assert.ok(capped <= 12, `capped at 12, showed ${capped}`);
        // The button says how many there are in total, so the cap is visible.
        assert.match(toggle.textContent ?? '', /Show all [\d,]+ jobs/);

        const before = client.calls.length;
        toggle.dispatchEvent(new page.window.Event('click', { bubbles: true }));
        await settle();
        assert.ok(shown() > capped, 'expanding shows more');
        assert.equal(client.calls.length, before, 'and costs no request');
    } finally {
        page.restore();
    }
});

test('a job link points at the run the annotation is in, or is absent', async () => {
    // The `runId` trap, which `BugOccurrence` documents: `/api/failuresbybug/`
    // carries only `task_id`, and a task whose first run ended in `exception` is
    // retried — so the annotated failure is in run 1 and a link built on a
    // guessed run 0 fetches the wrong artifact or none. The page resolves the
    // run through `runIdsOfJobs` rather than assuming, and omits the profile
    // link for a job Treeherder would not answer for.
    const { page } = await startPage('job-links');
    try {
        clickRow(page, DRILL_BUG);
        await settle();
        const item = page.document.querySelector(
            `#panel-${DRILL_BUG} .drilldown-item.expandable`
        ) as HTMLElement;
        item.dispatchEvent(new page.window.Event('click', { bubbles: true }));
        await settle();

        const rows = [...page.document.querySelectorAll(`#panel-${DRILL_BUG} .job-row`)];
        assert.ok(rows.length > 0);
        let sawProfile = 0;
        for (const row of rows) {
            const hrefs = [...row.querySelectorAll('.job-links a')].map((a) =>
                a.getAttribute('href')
            );
            for (const href of hrefs) {
                // Never the sentinel, and never a bare `runs/` with nothing in
                // it: a link on screen addresses something real.
                assert.ok(!(href ?? '').includes(UNKNOWN_TASK_ID), `no sentinel in ${href}`);
                assert.doesNotMatch(href!, /runs%2F(?!\d)/, `a run index is present in ${href}`);
            }
            const profile = hrefs.find((href) => href!.includes('profiler.firefox.com'));
            if (profile !== undefined) {
                sawProfile++;
                // The run the fixture recorded for this job, not 0 by default.
                const parsed = /task%2F([^%]+)%2Fruns%2F(\d+)/.exec(profile ?? '');
                assert.ok(parsed !== null, `the profile URL names a task and a run: ${profile}`);
                // `runIds` is keyed by **job** id, so the expected run is
                // looked up through the occurrence that carries this task.
                const occurrence = (raw.failuresbybug[String(DRILL_BUG)] ?? []).find(
                    (row) => row.task_id === parsed[1]
                );
                assert.ok(occurrence !== undefined, `the fixture records task ${parsed[1]}`);
                assert.equal(
                    Number(parsed[2]),
                    raw.runIds[String(occurrence.job_id)],
                    `the profile link uses the recorded run for job ${occurrence.job_id}`
                );
            }
        }
        assert.ok(sawProfile > 0, 'some job offered a profile link');
    } finally {
        page.restore();
    }
});

// --- links -----------------------------------------------------------------

test('a named test links to test.html, and the bug to Bugzilla', async () => {
    const { page } = await startPage('links');
    try {
        // A row has a test when the merged cell drew its path line — column 3
        // is the assignee now, and the path and the failure message share
        // column 4.
        const withTest = rowsOf(page).filter((row) => row.querySelector('a.test-link') !== null);
        assert.ok(withTest.length > 0, 'the fixture classifies something');
        for (const row of withTest) {
            const link = row.querySelector('a.test-link') as HTMLAnchorElement;
            // The cell's text now leads with the 📋 button's glyph, so the path
            // is read from the link rather than from the cell.
            const path = link.textContent ?? '';
            assert.equal(
                link.getAttribute('href'),
                `test.html?test=${encodeURIComponent(path)}`,
                'relative, so it resolves beside whichever copy of the site is served'
            );
            assert.equal(
                link.target,
                '_blank',
                'a row is a lead, not a destination: following one must not lose the ranking'
            );
            assert.ok(
                row.querySelector('button.action-button') !== null,
                'and the path is copyable without leaving the page'
            );
        }
        const bugLink = rowsOf(page)[0]!.querySelector('a.bug-link') as HTMLAnchorElement;
        assert.match(
            bugLink.getAttribute('href') ?? '',
            /^https:\/\/bugzilla\.mozilla\.org\/show_bug\.cgi\?id=\d+$/
        );
    } finally {
        page.restore();
    }
});

test('no row carries an inline event-handler attribute', async () => {
    const { page } = await startPage('no-handlers');
    try {
        // The migrated pages removed every generated `on*=` attribute; a new page
        // must not add any back. Counted over the whole table rather than
        // spot-checked.
        const table = page.document.getElementById('ranking-table')!;
        const handlers = [...table.querySelectorAll('*')].flatMap((node) =>
            [...node.attributes].filter((attribute) => attribute.name.startsWith('on'))
        );
        assert.deepEqual(
            handlers.map((attribute) => attribute.name),
            []
        );
    } finally {
        page.restore();
    }
});
