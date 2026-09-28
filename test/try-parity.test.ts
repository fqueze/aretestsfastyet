/**
 * New page vs CLI for `try`: `site/try.html?rev=…` ↔ `fx-tests try <rev>`.
 *
 * `PARITY.md` §5, and the sequencing step §6.4 asks for "per page, as each
 * lands". Both sides are driven over the **same pinned push**
 * (`test/fixtures/try-7d16bff81bb1.json`) and compared on the three classes
 * §1 names: values, order, framing.
 *
 * ## Why this is not `test/framing.test.ts`
 *
 * That file asserts **CLI vs the old page**, and its page column is a *source
 * audit* — facts read off `try.html` with a `file:line` citation each. It
 * cannot execute the page, so it can say "`old/try.html:1749` sorts on
 * `instances.length`" but not "the two produce the same 26 rows in the same
 * order".
 *
 * This file complements it rather than extending it, and the reason is that
 * they cannot share a table: framing.test.ts's page side is *read*, this one's
 * is *run*. Merging them would put a literal transcribed from a line number
 * next to a value computed at test time and give the reader no way to tell
 * which kind of claim a failure was. The two do overlap deliberately in one
 * place — the tie-break divergence is declared in both — because it is the one
 * that has to stay declared no matter which side is compared.
 *
 * ## What each side is
 *
 * - **Page**: `site/try-view.ts`'s `aggregateFailures` / `sortTests` /
 *   `splitTables`, driven exactly as `site/try.ts` drives them. Same setup as
 *   `test/try-view.test.ts`, which is why that file's helpers are followed
 *   rather than re-derived.
 * - **CLI**: a real `run()` invocation with a fake Treeherder client and
 *   synthesized profiles (`test/parity-harness.ts`). Offline, no browser.
 *
 * The synthesis is the one construction worth being suspicious of, so it is
 * checked before anything is claimed from it: the first test below re-parses
 * every synthesized profile through the CLI's own `parseTestMarkers` and
 * compares the result to the fixture's timings field by field. 178 of the
 * push's 180 timings come back identical, and the two that do not are the two
 * divergences declared at the bottom of this file.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { TreeherderJob } from '../lib/sources/treeherder.ts';
import { normalizeMessage } from '../lib/model/failure-message.ts';
import {
    isTestFilePath,
    normalizeTestPath,
    stripManifestPrefix,
} from '../lib/model/test-path.ts';
import { type DroppedMarker, parseTestMarkers } from '../cli/commands/try.ts';
import { sampleProfile } from './task-fixture.ts';
import {
    type FailingTest,
    type Timing,
    aggregateFailures,
    extractBuildTypes,
    extractPlatform,
    initialSort,
    selectTryJobs,
    sortTests,
    splitTables,
    tagIntermittent,
} from '../site/try-view.ts';
import {
    type Divergence,
    type PushFixture,
    assertDeclaredDivergences,
    assertSameOrder,
    fakeTreeherder,
    fixtureJson,
    fixtureSource,
    invoke,
    json,
    pushProfileFetcher,
    runKey,
    synthProfile,
    timingsByRun,
} from './parity-harness.ts';

const PUSH = fixtureJson<PushFixture>('try-7d16bff81bb1.json');

// =========================================================================
// The page side, driven as site/try.ts drives it
// =========================================================================

// The page's default selection, through the same call `site/try.ts` makes.
const PAGE_SELECTION = selectTryJobs(PUSH.jobs, { readPassingJobs: false });
const FAILED_TEST_JOBS = PAGE_SELECTION.failedTestJobs;
const SUCCESSFUL_TEST_JOBS = PAGE_SELECTION.successfulTestJobs;

/** The page's failure aggregation over the pinned push. */
function pageFailures(): ReturnType<typeof aggregateFailures> {
    // `tagIntermittent` mutates, so it gets its own copies.
    const timings = PUSH.timings.map((timing) => ({ ...timing })) as unknown as Timing[];
    tagIntermittent(timings, {
        jobsToProcess: PAGE_SELECTION.jobsToProcess,
        successfulJobNames: PAGE_SELECTION.successfulJobNames,
    });

    const globalPlatforms = new Set<string>();
    const globalBuildTypes = new Set<string>();
    for (const job of PAGE_SELECTION.jobsToProcess) {
        globalPlatforms.add(extractPlatform(job.jobName));
        for (const buildType of extractBuildTypes(job.jobName)) {
            globalBuildTypes.add(buildType);
        }
    }
    return aggregateFailures(timings, {
        globalPlatforms,
        globalBuildTypes,
        jobRunCounts: PAGE_SELECTION.runsPerJobName,
    });
}

const PAGE = pageFailures();

/** The page's default table order: `sortTests` on `initialSort()`. */
const PAGE_ORDER: readonly FailingTest[] = sortTests(PAGE.tests, initialSort(), () => null);

// =========================================================================
// The CLI side, one real invocation
// =========================================================================

/** One row of the CLI's `--json`. */
interface CliFailure {
    path: string;
    jobNames: string[];
    failureCount: number;
    failedRuns: number;
    /** Executions — the page's `totalRuns`. */
    totalRuns: number;
    /** Task runs of the failed configs — the page's `totalJobs`. */
    totalJobs: number;
    everyRunFailed: boolean;
    statuses: string[];
    messages: string[];
    /** Item 18's full set, with a per-execution count each. */
    allMessages: { message: string; count: number }[];
}

interface CliTry {
    pushId: number;
    jobCount: number;
    failedJobCount: number;
    profilesRead: number;
    readPassingJobs: boolean;
    passingTestJobCount: number;
    unblamedJobCount: number;
    permaFails: CliFailure[];
    knownIntermittents: CliFailure[];
    newIntermittents: CliFailure[];
}

/** Runs `fx-tests try` over the pinned push. Cached: one invocation, many tests. */
let cliResult: CliTry | undefined;
async function cli(): Promise<CliTry> {
    if (cliResult === undefined) {
        cliResult = json<CliTry>(
            await invoke(['try', '7d16bff81bb1', '--json'], {
                treeherder: fakeTreeherder(PUSH.jobs),
                fetchUrl: pushProfileFetcher(PUSH),
                source: fixtureSource(),
            })
        );
    }
    return cliResult;
}

/** Every CLI row, in the order the command emitted them across its sections. */
function cliRows(result: CliTry): CliFailure[] {
    return [...result.permaFails, ...result.knownIntermittents, ...result.newIntermittents];
}

/**
 * The CLI's single ranked sequence, **merged from the emitted order**.
 *
 * The command splits its output into three sections, each already in the order
 * the command produced, so concatenating them is not the whole-population
 * ranking — a low-count perma-fail precedes a high-count intermittent. Merging
 * them is what makes the page's single table comparable.
 *
 * A *merge*, deliberately, and not a re-sort. An earlier draft called
 * `.sort(comparator)` here, and it was wrong for a reason worth recording: a
 * mutation flipping the command's comparator to ascending left this test green,
 * because re-sorting threw away the very sequence under test and replaced it
 * with one this file had computed. That is `PARITY.md` §1's failure mode inside
 * the parity harness itself — the test deriving its expected value from
 * something other than what the command emitted.
 *
 * So each section is taken in its emitted order, asserted to be descending on
 * its own, and the three are then merged by repeatedly taking whichever section
 * head ranks first. The merge preserves each section's order rather than
 * imposing one, so a section emitted backwards comes out backwards and fails.
 */
function cliRanked(result: CliTry): CliFailure[] {
    const sections = [result.permaFails, result.knownIntermittents, result.newIntermittents].map(
        (section) => [...section]
    );
    for (const section of sections) {
        for (let i = 1; i < section.length; i++) {
            assert.ok(
                section[i - 1]!.failureCount >= section[i]!.failureCount,
                `a CLI section is not emitted count-descending: ${section[i - 1]!.path} ` +
                    `(${section[i - 1]!.failureCount}) then ${section[i]!.path} ` +
                    `(${section[i]!.failureCount})`
            );
        }
    }

    const merged: CliFailure[] = [];
    for (;;) {
        let best = -1;
        for (const [index, section] of sections.entries()) {
            const head = section[0];
            if (head === undefined) {
                continue;
            }
            const incumbent = best === -1 ? undefined : sections[best]![0];
            if (
                incumbent === undefined ||
                head.failureCount > incumbent.failureCount ||
                (head.failureCount === incumbent.failureCount &&
                    head.path.localeCompare(incumbent.path) < 0)
            ) {
                best = index;
            }
        }
        if (best === -1) {
            return merged;
        }
        merged.push(sections[best]!.shift()!);
    }
}

// =========================================================================
// The synthesis is what it claims to be
// =========================================================================

test('the synthesized profiles re-parse to the pinned push, bar the two divergences', async () => {
    // Checked before any parity claim rests on it. The fixture holds the page
    // worker's *output*; `synthProfile` rebuilds a marker stream from it and
    // this re-parses that stream with the CLI's parser. If the reconstruction
    // drifted — a message landing on the wrong marker, a retry range covering
    // the wrong executions — every comparison below would be of two things
    // neither side would produce, and this is what says it did not.
    const byRun = timingsByRun(PUSH);
    const jobByRun = new Map<string, TreeherderJob>(PUSH.jobs.map((job) => [runKey(job), job]));

    const reparsed: { path: string; status: string; run: string; rerun: boolean; message: string }[] =
        [];
    for (const [key, timings] of byRun) {
        const job = jobByRun.get(key);
        assert.ok(job !== undefined, `no job for run ${key}`);
        for (const timing of parseTestMarkers(synthProfile(timings), job)) {
            reparsed.push({
                path: timing.path,
                status: timing.status,
                run: runKey(timing),
                rerun: timing.isRerun,
                message: timing.message ?? '',
            });
        }
    }

    // The page side, read straight off the fixture — not through
    // `site/try-view.ts`, so the two paths are genuinely independent.
    const pageSide = PUSH.timings.map((timing) => ({
        path: timing.path,
        status: timing.status,
        run: runKey(timing),
        rerun: timing.isRetry === true,
        message: timing.allMessages[0]?.message ?? timing.message ?? '',
    }));

    const encode = (entry: { path: string; status: string; run: string; rerun: boolean; message: string }): string =>
        `${entry.path}|${entry.status}|${entry.run}|${entry.rerun}|${entry.message}`;
    const remaining = new Map<string, number>();
    for (const entry of pageSide) {
        const key = encode(entry);
        remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    const cliOnly: string[] = [];
    for (const entry of reparsed) {
        const key = encode(entry);
        const count = remaining.get(key) ?? 0;
        if (count > 0) {
            remaining.set(key, count - 1);
        } else {
            cliOnly.push(key);
        }
    }
    const pageOnly = [...remaining].filter(([, count]) => count > 0).map(([key]) => key);

    // Measured on this push: 180 page timings, 178 CLI ones, and the symmetric
    // difference is four entries — two paired rows for the claimed-crash
    // message and two manifest rows the CLI drops. Both are declared below.
    assert.equal(PUSH.timings.length, 180, 'the pinned push changed');
    assert.equal(reparsed.length, 178);
    assert.equal(
        cliOnly.length,
        2,
        `unexpected CLI-only timings, so the synthesis no longer round-trips:\n  ${cliOnly.join('\n  ')}`
    );
    assert.equal(
        pageOnly.length,
        4,
        `unexpected page-only timings:\n  ${pageOnly.join('\n  ')}`
    );
    // The two CLI-only rows are the claimed-crash pair, differing only in the
    // message — so each has a page-only twin with the same path and run.
    for (const key of cliOnly) {
        const [path, status, run] = key.split('|');
        assert.equal(status, 'CRASH');
        assert.ok(
            pageOnly.some((other) => other.startsWith(`${path}|${status}|${run}|`)),
            `${key} has no page twin, so it is a new difference rather than the declared one`
        );
    }
});

test('the pinned push carries no execution-mode suffix, which the synthesis relies on', () => {
    // `synthProfile` emits no `parallel` Text marker. Both parsers append
    // `-PARALLEL`/`-SEQUENTIAL` to a FAIL/TIMEOUT/CRASH/PASS **only when such a
    // range exists**, so emitting one would rewrite every status in the push
    // and the comparison would be of statuses neither side's real data has.
    // Skipping it is only safe while the fixture has none, so that is asserted
    // rather than assumed.
    for (const timing of PUSH.timings) {
        assert.doesNotMatch(
            timing.status,
            /-(PARALLEL|SEQUENTIAL)$/,
            'the pinned push now contains an execution-mode suffix; synthProfile must emit a ' +
                'parallel range or this comparison is against rewritten statuses'
        );
    }
});

// =========================================================================
// 1. Value parity
// =========================================================================

test('the two sides produce the same row set, bar the manifest pseudo-tests', async () => {
    const result = await cli();
    const pagePaths = new Set(PAGE.tests.map((row) => row.path));
    const cliPaths = new Set(cliRows(result).map((row) => row.path));

    assert.deepEqual(
        [...cliPaths].filter((path) => !pagePaths.has(path)),
        [],
        'the CLI invented a row the page does not have'
    );
    // The page's extra rows are the declared manifest divergence and nothing
    // else. Asserted as the exact set, so a *third* page-only row fails here
    // rather than being absorbed by a "the CLI has fewer rows" allowance.
    assert.deepEqual(
        [...pagePaths].filter((path) => !cliPaths.has(path)).sort(),
        [
            'devtools/client/debugger/test/mochitest/sourcemaps/browser.toml',
            'toolkit/components/ml/tests/browser/browser.toml',
        ]
    );
    assert.equal(PAGE.tests.length, 28);
    assert.equal(cliPaths.size, 26);
});

/**
 * The two run units, pinned as literals on named tests.
 *
 * `test/framing.test.ts` could not express this axis: its page column is prose
 * read off `try.html`, and a prose field cannot disagree with itself — which is
 * how `--all-jobs` survived a table that claimed to compare the two sides. The
 * fix is to pin *quantities*, so the numbers below are computed here from
 * `PUSH.timings` and `PUSH.jobs` by arithmetic written out in this file, and
 * then asserted as literals against both implementations.
 *
 * The literals matter more than usual here because the defect was two wrong
 * quantities that agreed with each other. `19 !== 13` is the whole finding: the
 * page reported 19 executions, the CLI reported 13 job runs under the same
 * field name, and the old version of the field-by-field test above compared
 * `cli.totalRuns` to `page.totalJobs` and passed.
 *
 * 24 of the 28 rows in the pinned push have `totalRuns !== totalJobs`, so this
 * is the common case and not a corner.
 */
test('both sides report the same executions and the same job runs, pinned', async () => {
    // The two rules, written out here rather than imported, so this file does
    // not ask the code under test what a failure or a run is.
    const rawIsFailure = (status: string): boolean =>
        ['FAIL', 'TIMEOUT', 'CRASH', 'ERROR', 'UNEXPECTED-PASS'].includes(
            status.replace(/-(PARALLEL|SEQUENTIAL)$/, '')
        );
    const rawJobRuns = (jobName: string): number =>
        PUSH.jobs.filter(
            (job) =>
                job.state === 'completed' &&
                job.jobName === jobName &&
                ['mochitest', 'xpcshell'].some((harness) => job.jobName.includes(harness))
        ).length;

    // Ground truth, computed WITHOUT either implementation: for each config the
    // test failed on, every parsed execution in it, plus one per run of that
    // config with no parsed run at all (old/try.html:1565-1580).
    const groundTruth = (path: string): { totalRuns: number; totalJobs: number } => {
        const failedConfigs = new Set(
            PUSH.timings
                .filter((timing) => timing.path === path && rawIsFailure(timing.status))
                .map((timing) => timing.jobName)
        );
        let totalRuns = 0;
        let totalJobs = 0;
        for (const config of failedConfigs) {
            const jobRuns = rawJobRuns(config);
            totalJobs += jobRuns;
            const inConfig = PUSH.timings.filter(
                (timing) => timing.path === path && timing.jobName === config
            );
            const parsedRuns = new Set(inConfig.map((timing) => runKey(timing)));
            totalRuns += inConfig.length + Math.max(0, jobRuns - parsedRuns.size);
        }
        return { totalRuns, totalJobs };
    };

    // Read off the fixture once and written down, so a change to the fixture
    // fails here rather than quietly moving every expectation.
    const PINNED: Record<string, { totalRuns: number; totalJobs: number }> = {
        'browser/extensions/formautofill/test/browser/browser_ml_heuristics.js': {
            totalRuns: 19,
            totalJobs: 13,
        },
        'accessible/tests/browser/events/browser_test_panel.js': {
            totalRuns: 18,
            totalJobs: 12,
        },
        'browser/extensions/formautofill/test/browser/browser_autocomplete_footer.js': {
            totalRuns: 20,
            totalJobs: 13,
        },
    };

    const result = await cli();
    const cliByPath = new Map(cliRows(result).map((row) => [row.path, row]));
    const pageByPath = new Map(PAGE.tests.map((row) => [row.path, row]));

    for (const [path, expected] of Object.entries(PINNED)) {
        // The literals are what the fixture says, checked by this file's own
        // arithmetic before either side is consulted.
        assert.deepEqual(groundTruth(path), expected, `${path}: the fixture no longer says this`);

        const page = pageByPath.get(path);
        const command = cliByPath.get(path);
        assert.ok(page !== undefined, `${path} is missing from the page`);
        assert.ok(command !== undefined, `${path} is missing from the CLI`);

        assert.equal(page.totalRuns, expected.totalRuns, `${path}: page executions`);
        assert.equal(command.totalRuns, expected.totalRuns, `${path}: CLI executions`);
        assert.equal(page.totalJobs, expected.totalJobs, `${path}: page job runs`);
        assert.equal(command.totalJobs, expected.totalJobs, `${path}: CLI job runs`);

        // And the two units are genuinely different on these rows, so an
        // implementation that conflated them could not satisfy both lines.
        assert.notEqual(
            expected.totalRuns,
            expected.totalJobs,
            `${path} no longer distinguishes the two units; pin a row that does`
        );
    }
});

test('every shared row agrees field by field', async () => {
    // The value-parity check `PARITY.md` §5 asks for: "asserted field by
    // field", over all 26 shared rows rather than a spot check.
    //
    // Both sides are on `lib/`… except that they are not, for `try`: the push
    // is parsed by `site/try.ts`'s worker on one side and
    // `cli/commands/try.ts`'s `parseTestMarkers` on the other, and the
    // aggregation is `site/try-view.ts`'s `aggregateFailures` against the
    // command's own inline accumulation. So this is a genuine two-implementation
    // comparison and not a tautology — which is why 0 differences over 26 rows
    // and four fields is worth asserting.
    const result = await cli();
    const cliByPath = new Map(cliRows(result).map((row) => [row.path, row]));

    let compared = 0;
    for (const row of PAGE.tests) {
        const other = cliByPath.get(row.path);
        if (other === undefined) {
            continue; // the declared manifest divergence, asserted above
        }
        compared++;
        assert.equal(
            other.failureCount,
            row.instances.length,
            `${row.path}: failing executions differ — the page's # column is ` +
                `instances.length (old/try.html:1749) and the CLI's failureCount must be the same ` +
                'quantity'
        );
        // Two fields, two units, compared to their own counterparts. This
        // assertion used to read `other.totalRuns === row.totalJobs`, which
        // passed only because the CLI's `totalRuns` WAS job runs — the parity
        // test encoded the defect it should have caught. `old/try.html:1557-1558`
        // names the two apart and `1e8b867` made the displayed ratio the
        // executions one, so comparing them crosswise is what let `18/18`
        // survive a field-by-field check.
        assert.equal(
            other.totalRuns,
            row.totalRuns,
            `${row.path}: the EXECUTION count differs. Both count every parsed execution in ` +
                'each run of the failed configs, plus one per unparsed run (old/try.html:1565-1580)'
        );
        assert.equal(
            other.totalJobs,
            row.totalJobs,
            `${row.path}: the JOB RUN count differs. Both count only the configs the test ` +
                'FAILED on (old/try.html:1563), so a difference means one side folded in a clean config'
        );
        assert.deepEqual(
            [...other.jobNames].sort(),
            [...row.jobs].sort(),
            `${row.path}: the affected configurations differ`
        );
        assert.deepEqual(
            [...other.statuses].sort(),
            [...row.statuses].sort(),
            `${row.path}: the status set differs`
        );
    }
    assert.equal(compared, 26, 'all 26 shared rows must be compared, or this is a spot check');
});

test('the push-level totals agree', async () => {
    const result = await cli();
    // Read off the fixture directly, not from either side's report.
    assert.equal(result.jobCount, PUSH.jobs.length);
    assert.equal(result.failedJobCount, FAILED_TEST_JOBS.length);
    assert.equal(FAILED_TEST_JOBS.length, 46);
    // 46 failed test jobs, 33 of which yielded timings: the other 13 had no
    // readable profile. The page counts the same population as "not analyzed".
    const runsWithTimings = timingsByRun(PUSH).size;
    assert.equal(runsWithTimings, 33);
    assert.equal(result.unblamedJobCount, FAILED_TEST_JOBS.length - runsWithTimings + 2);
});

// =========================================================================
// 2. Order parity — the full ranked sequence
// =========================================================================

/** Groups of adjacent equal-count entries, each sorted, so ties compare equal. */
function normalizeTies(paths: readonly string[], countOf: (path: string) => number): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < paths.length) {
        let j = i;
        while (j < paths.length && countOf(paths[j]!) === countOf(paths[i]!)) {
            j++;
        }
        out.push(...paths.slice(i, j).sort());
        i = j;
    }
    return out;
}

test('the full ranked sequence matches, with ties normalized', async () => {
    // §5: "as a full ranked sequence — not a spot check. The sort-key bug
    // produced the same set in a different order and would pass any set
    // comparison." So this compares all 26 positions.
    //
    // Ties are normalized because the page's tie order is genuinely
    // non-deterministic — `allTimings` is pushed in worker-completion order, so
    // across four pinned reloads of this push the old page disagreed with
    // itself at 104-166 of 431 positions. Comparing raw tie order would be
    // comparing against a coin flip. What is *not* normalized away is any pair
    // with unequal counts: that is the next test.
    const result = await cli();
    const cliPaths = new Set(cliRows(result).map((row) => row.path));
    const cliByPath = new Map(cliRows(result).map((row) => [row.path, row]));
    const pageByPath = new Map(PAGE.tests.map((row) => [row.path, row]));

    const pageSequence = PAGE_ORDER.map((row) => row.path).filter((path) => cliPaths.has(path));
    const cliSequence = cliRanked(result).map((row) => row.path);

    assert.equal(pageSequence.length, 26);
    assertSameOrder(
        normalizeTies(pageSequence, (path) => pageByPath.get(path)!.instances.length),
        normalizeTies(cliSequence, (path) => cliByPath.get(path)!.failureCount),
        'the ranked sequences differ at a position ties cannot explain'
    );
});

test('no pair with unequal counts is ever out of order between the two sides', async () => {
    // The assertion the tie normalization must not be allowed to weaken. A sort
    // key that changed — the exact defect `PARITY.md` §1 records as invisible
    // to a value diff — reorders pairs with *different* counts, and no amount
    // of tie normalization hides that. Checked over every pair, not adjacent
    // ones: a key change can move a row past several others at once.
    const result = await cli();
    const cliSequence = cliRanked(result).map((row) => row.path);
    const cliRank = new Map(cliSequence.map((path, index) => [path, index]));
    const cliByPath = new Map(cliRows(result).map((row) => [row.path, row]));
    const pageByPath = new Map(PAGE.tests.map((row) => [row.path, row]));
    const pageSequence = PAGE_ORDER.map((row) => row.path).filter((path) => cliRank.has(path));

    let unequalPairs = 0;
    for (let i = 0; i < pageSequence.length; i++) {
        for (let j = i + 1; j < pageSequence.length; j++) {
            const earlier = pageSequence[i]!;
            const later = pageSequence[j]!;
            if (
                pageByPath.get(earlier)!.instances.length ===
                pageByPath.get(later)!.instances.length
            ) {
                continue;
            }
            unequalPairs++;
            assert.ok(
                cliRank.get(earlier)! < cliRank.get(later)!,
                `${earlier} (${pageByPath.get(earlier)!.instances.length} executions) precedes ` +
                    `${later} (${pageByPath.get(later)!.instances.length}) on the page but ` +
                    `follows it in the CLI, where they are ` +
                    `${cliByPath.get(earlier)!.failureCount} and ` +
                    `${cliByPath.get(later)!.failureCount}. Ties are normalized elsewhere; an ` +
                    'unequal-count inversion is a sort-key difference.'
            );
        }
    }
    // The fixture has to contain unequal pairs or the loop above proves
    // nothing. 26 rows over five distinct counts leaves plenty.
    assert.ok(unequalPairs > 200, `only ${unequalPairs} unequal-count pairs to check`);
});

test('the raw tie order really does differ, so the normalization is not decorative', async () => {
    // The other half: if the two sides happened to agree on ties, normalizing
    // them would be dead code and the declared divergence stale. Measured on
    // this push — 11 of 26 positions differ before normalization — so the
    // normalization is load-bearing and the divergence is live.
    const result = await cli();
    const cliSequence = cliRanked(result).map((row) => row.path);
    const cliPaths = new Set(cliSequence);
    const pageSequence = PAGE_ORDER.map((row) => row.path).filter((path) => cliPaths.has(path));

    let differing = 0;
    for (let i = 0; i < pageSequence.length; i++) {
        if (pageSequence[i] !== cliSequence[i]) {
            differing++;
        }
    }
    assert.equal(
        differing,
        11,
        'the raw tie order between the page and the CLI changed. 11 of 26 positions is what ' +
            'this push measures; if it became 0 the path tiebreak has been adopted by the page ' +
            'and the divergence below must be deleted.'
    );
});

// =========================================================================
// 3. Framing parity — grouping, sort key, direction
// =========================================================================

test('both sides rank on failing executions, descending', async () => {
    // Direction asserted on the emitted sequence rather than on a flag: a
    // command reporting `sort: "count"` while emitting ascending order would
    // pass a label check. And executions rather than distinct job runs, which
    // is the pair `PARITY.md` §1 says a value diff cannot separate.
    const result = await cli();
    const cliSequence = cliRanked(result);
    for (let i = 1; i < cliSequence.length; i++) {
        assert.ok(
            cliSequence[i - 1]!.failureCount >= cliSequence[i]!.failureCount,
            `the CLI is not descending at ${i}`
        );
    }
    const pageCounts = PAGE_ORDER.map((row) => row.instances.length);
    for (let i = 1; i < pageCounts.length; i++) {
        assert.ok(pageCounts[i - 1]! >= pageCounts[i]!, `the page is not descending at ${i}`);
    }

    // Executions, not job runs — shown by the two disagreeing on this push. A
    // ranking on distinct failing job runs produces a *different sequence*, and
    // both sides reject it.
    const failingRuns = (path: string): number => {
        const runs = new Set<string>();
        for (const timing of PUSH.timings) {
            if (timing.path === path && isFailureStatusRaw(timing.status)) {
                runs.add(runKey(timing));
            }
        }
        return runs.size;
    };
    const byJobRuns = [...cliSequence].sort(
        (a, b) => failingRuns(b.path) - failingRuns(a.path) || a.path.localeCompare(b.path)
    );
    assert.notDeepEqual(
        byJobRuns.map((row) => row.path),
        cliSequence.map((row) => row.path),
        'ranking by distinct job runs gives the same order on this push, so neither side is ' +
            'shown to rank on executions'
    );
});

/** The failure statuses, spelled out here rather than imported from either side. */
function isFailureStatusRaw(status: string): boolean {
    const bare = status.replace(/-(PARALLEL|SEQUENTIAL)$/, '');
    return ['FAIL', 'TIMEOUT', 'CRASH', 'ERROR', 'UNEXPECTED-PASS'].includes(bare);
}

test('the perma-fail grouping picks out the same tests on both sides', async () => {
    // The grouping dimension. The two sides compute it *differently*: the page
    // splits on `intermittentCount !== instances.length` — a test with any
    // non-intermittent execution — and the CLI on `everyRunFailed`, a
    // per-configuration "failed in every run and the rerun never passed". Two
    // rules, and they must select the same three tests or one of them is
    // answering a different question.
    const result = await cli();
    const { permanent } = splitTables(PAGE.tests);
    assert.deepEqual(
        [...permanent.map((row) => row.path)].sort(),
        [...result.permaFails.map((row) => row.path)].sort(),
        'the page\'s "Permanent failures" table and the CLI\'s PERMA-FAILS section must hold ' +
            'the same tests; the two rules that produce them are not the same rule'
    );
    // Three, and the section is not empty — an empty one on both sides would
    // make the assertion vacuous.
    assert.equal(result.permaFails.length, 3);
    // And the CLI's other two sections partition the rest, so no row is lost or
    // counted twice between the groupings.
    const rest = new Set([
        ...result.knownIntermittents.map((row) => row.path),
        ...result.newIntermittents.map((row) => row.path),
    ]);
    assert.equal(rest.size, 23);
    for (const row of result.permaFails) {
        assert.ok(!rest.has(row.path), `${row.path} is in two sections`);
    }
});

test('the CLI splits intermittents by central history where the page does not', async () => {
    // A grouping the page has no counterpart for, and it is not a divergence
    // in the values: `knownIntermittents ∪ newIntermittents` is exactly the
    // page's intermittent table. Asserted because a future change that started
    // *filtering* on central rather than splitting on it would shrink the
    // population, which is the defect the CLI already had once (`try.ts:379`
    // records it reporting 0 perma-fails where the dashboard reported 3).
    const result = await cli();
    const { intermittent } = splitTables(PAGE.tests);
    const cliPaths = new Set(cliRows(result).map((row) => row.path));
    const pageIntermittent = intermittent.map((row) => row.path).filter((path) => cliPaths.has(path));
    assert.deepEqual(
        [...pageIntermittent].sort(),
        [
            ...result.knownIntermittents.map((row) => row.path),
            ...result.newIntermittents.map((row) => row.path),
        ].sort()
    );
    // No central data is served to this invocation, so everything lands in
    // `newIntermittents`. Stated so the empty `knownIntermittents` reads as a
    // property of the fixture rather than of the split.
    assert.equal(result.knownIntermittents.length, 0);
});

/**
 * Both sides read the same jobs, and `--all-jobs` widens by the same set.
 *
 * The one parity dimension that is about **which data is read** rather than
 * what is done with it, and the one the framing table could not express until
 * `universe` was added to it. It is checked here as a count on each side
 * because a count is the thing a display filter cannot change.
 *
 * The expectations are literals read off this fixture's job list — 46 failed
 * test jobs and 1,538 successful ones, the same two numbers
 * `test/try-view.test.ts` pins for the page.
 *
 * ## What this stopped proving, and what it still proves
 *
 * When this test was written the two sides ran different code, and "they agree"
 * was the finding. They now both call `selectTryJobs`, so agreement is a
 * property of `===` and is worth nothing — a parity test that passes because
 * both sides call one function proves only that the function was called twice.
 *
 * What it still proves is the part that was never about agreement: that 46 and
 * 1,584 are the **right** numbers. Both are literals read off the fixture's job
 * list, and the CLI's side of each is `profilesRead` from a real `run()` — a
 * count of artifacts a display filter cannot change, taken at the far end of
 * the command from the selection. Between `selectTryJobs` and that number sit
 * the flag parsing, the progress line and the fetch loop, any of which can lose
 * the widening; `cde2ebd` records a mutation where exactly one of them did.
 *
 * The claim that both sides *reach* the shared code is not assertable here at
 * all. It is a mutation check, recorded at the bottom of `test/try-jobs.test.ts`.
 */
test('the page and the CLI put the same jobs in the universe', async () => {
    assert.equal(FAILED_TEST_JOBS.length, 46, 'the pinned push has 46 failed test jobs');
    assert.equal(SUCCESSFUL_TEST_JOBS.length, 1538, 'and 1,538 that passed');

    const byDefault = json<CliTry>(
        await invoke(['try', '7d16bff81bb1', '--json'], {
            treeherder: fakeTreeherder(PUSH.jobs),
            fetchUrl: pushProfileFetcher(PUSH),
            source: fixtureSource(),
        })
    );
    assert.equal(byDefault.profilesRead, 46, 'the default reads the failed test jobs, as the page does');
    assert.equal(byDefault.readPassingJobs, false);
    assert.equal(byDefault.passingTestJobCount, 1538);

    const widened = json<CliTry>(
        await invoke(['try', '7d16bff81bb1', '--json', '--all-jobs'], {
            treeherder: fakeTreeherder(PUSH.jobs),
            fetchUrl: pushProfileFetcher(PUSH),
            source: fixtureSource(),
        })
    );
    // 46 + 1538. Written as the sum rather than as 1584 so a change to either
    // side of it names which one moved.
    assert.equal(widened.profilesRead, 46 + 1538, '--all-jobs adds exactly the successful test jobs');
    assert.equal(widened.readPassingJobs, true);

    // The row set does not change on THIS push, and the reason is a property
    // of the fixture rather than of the flag: its `timings` were captured from
    // the 46 failed jobs only, so the 1,538 added reads answer `null` and
    // contribute nothing. `test/try-view.test.ts` records the same limitation
    // for the page side. The behaviour the flag exists for is asserted in
    // `test/framing.test.ts` against a profile built to contain it, and was
    // measured against the live push: 90 further tests, all `passedOnRerun`.
    assert.deepEqual(
        cliRows(widened).map((row) => row.path).sort(),
        cliRows(byDefault).map((row) => row.path).sort(),
        'no fixture profile exists for a passing job, so no new row can appear here'
    );
});

// =========================================================================
// Declared divergences
// =========================================================================

/**
 * Where the page and the CLI differ on purpose.
 *
 * Same discipline as `test/framing.test.ts`: both sides' measured values are
 * recorded, and an entry whose sides have converged fails. The values here are
 * the ones the tests above observed, not descriptions of them.
 */
const DIVERGENCES: Divergence[] = [
    {
        what: 'manifest-path pseudo-tests',
        reason:
            'A crash during manifest teardown is recorded against the `.toml`, with no running ' +
            'test to attribute it to. The page emits it as a synthetic row keyed on that path ' +
            "(`site/try.ts:565-580` keeps `c.testPath` unconditionally), so a manifest appears " +
            "in a table of tests. The CLI re-checks the test extension and drops it " +
            '(`cli/commands/try.ts:828`): the path cannot be joined against the central ' +
            'aggregates, so every per-test column the command would print for it — flakiness, ' +
            'pre-existing rate, run counts — is unanswerable, and a row of blanks reads as ' +
            '"never fails on central" rather than "not a test". Measured on this push: 2 rows.',
        page: [
            'devtools/client/debugger/test/mochitest/sourcemaps/browser.toml',
            'toolkit/components/ml/tests/browser/browser.toml',
        ],
        cli: [],
    },
    {
        what: 'tie order among rows with equal failure counts',
        reason:
            'The CLI breaks ties on the path (`cli/commands/try.ts:1034`); the page leaves them ' +
            'in insertion order, which is the order eight web workers finished parsing profiles ' +
            'fetched 64 at a time. That is a network race, and it is measured rather than ' +
            'assumed: across four pinned reloads of 717fc67feaa071 the old page disagreed with ' +
            'itself at 104-166 of 431 positions, every unstable index an adjacent pair with ' +
            'equal counts. A command whose output is diffed and pasted into bugs cannot be ' +
            'non-deterministic. On this push the two orders differ at 11 of 26 positions, all ' +
            'within tie groups — asserted above, along with the fact that no unequal-count pair ' +
            'is ever inverted.',
        page: 'insertion order (worker completion)',
        cli: 'path, ascending',
    },
    {
        what: "the message on a crash the profile attributed to a running test",
        reason:
            'FOUND BY THIS FILE, and not previously declared. When a `Crash` marker falls inside ' +
            "a test's execution range, the CLI sets `message ??= signature` " +
            '(`cli/commands/try.ts:797`) while the page records the signature only in ' +
            "`crashSignature` and leaves `message` unset (`site/try.ts:552-556`), so " +
            '`messagesOf` returns nothing for it. Both do set the message for an *unclaimed* ' +
            'crash, so the two branches disagree with each other as well as across the sides. ' +
            'Measured on this push: 2 of the 4 crash timings, on ' +
            '`test_suspend_media_by_inactive_docshell.html` and ' +
            '`test_nsIEditorSpellCheck_ReplaceWord.html`. Recorded rather than fixed because ' +
            'the fix is in `site/` or `cli/`, outside this change\'s scope, and because which ' +
            'side is right is a real question: the signature is the only description a crash ' +
            'has, and the CLI\'s `messageComparable` (`try.ts:1015`) already treats a CRASH as ' +
            'comparable without one. It changes no count above — the row set, the execution ' +
            'counts and the ranking are unaffected — but it changes what the same-message ' +
            'comparison against central is given to match on.',
        page: 0,
        cli: 2,
    },
];

test('every declared divergence still diverges', () => {
    assertDeclaredDivergences('try', DIVERGENCES);
});

test('the claimed-crash message divergence is exactly as large as declared', async () => {
    // The allow-list entry above says "2 of the 4 crash timings". An entry
    // carrying a number that nothing checks is a comment; this is what makes it
    // an assertion, and what makes a *third* affected crash fail rather than
    // being absorbed.
    const byRun = timingsByRun(PUSH);
    const jobByRun = new Map<string, TreeherderJob>(PUSH.jobs.map((job) => [runKey(job), job]));

    const cliMessages = new Map<string, string | null>();
    for (const [key, timings] of byRun) {
        for (const timing of parseTestMarkers(synthProfile(timings), jobByRun.get(key)!)) {
            if (timing.status.startsWith('CRASH')) {
                cliMessages.set(`${timing.path}|${runKey(timing)}`, timing.message);
            }
        }
    }

    const crashes = PUSH.timings.filter((timing) => timing.status === 'CRASH');
    assert.equal(crashes.length, 4, 'the pinned push has four crash timings');

    let claimedWithoutPageMessage = 0;
    for (const crash of crashes) {
        const pageMessage = crash.allMessages[0]?.message ?? crash.message ?? null;
        const cliMessage = cliMessages.get(`${crash.path}|${runKey(crash)}`) ?? null;
        if (pageMessage === null && cliMessage !== null) {
            claimedWithoutPageMessage++;
            // And it is the signature, not some other string — which is what
            // identifies the difference as this one rather than a new one.
            assert.equal(cliMessage, crash.crashSignature);
        }
    }
    assert.equal(
        claimedWithoutPageMessage,
        2,
        'the claimed-crash message divergence changed size. Re-measure it and update the entry ' +
            'in DIVERGENCES, or delete the entry if it is gone.'
    );

    const declared = DIVERGENCES.find((entry) => entry.what.includes('crash the profile'));
    assert.ok(declared !== undefined);
    assert.equal(declared.cli, claimedWithoutPageMessage);
});

// --- normalizeMessage: the shared rule, and the worker's copy of it --------

/**
 * ## Why the worker gets its own assertions
 *
 * `site/try.ts`'s profile worker is a `String.raw` template compiled from a
 * Blob, so it cannot import `lib/model/failure-message.ts` and has to carry a
 * copy of `normalizeMessage`. A copy is exactly the thing that produced the
 * divergence in the first place — upstream's two call sites disagreed about
 * CRLF for as long as the page existed — so the copy is pinned here against
 * the shared function on inputs chosen to separate them.
 *
 * The worker's source is read out of `site/try.ts` and evaluated, rather than
 * reimplemented in this file. Reimplementing it would be the defect this
 * repository names as dominant: the expected value would derive from a
 * second-guess at the thing under test, and both could be wrong together.
 */
const WORKER_SOURCE = readFileSync(
    new URL('../site/try.ts', import.meta.url),
    'utf8'
);

/** The worker's own `normalizeMessage`, lifted out of the template literal. */
function workerNormalizeMessage(): (message: string | null | undefined) => string | null {
    const start = WORKER_SOURCE.indexOf('function normalizeMessage(message) {');
    assert.ok(start > 0, 'the worker still defines normalizeMessage');
    const end = WORKER_SOURCE.indexOf('\n}', start);
    assert.ok(end > start);
    const source = WORKER_SOURCE.slice(start, end + 2);
    // The worker's copy returns `undefined` for absent input, the shared one
    // `null`; the wrapper folds that so the comparisons below are about the
    // substitutions. The difference itself is asserted separately.
    const fn = new Function(`${source}; return normalizeMessage;`)() as (
        m: string | null | undefined
    ) => string | undefined;
    return (message) => fn(message) ?? null;
}

/**
 * The worker's own path helpers, lifted out of the template literal.
 *
 * Same technique as `workerNormalizeMessage` and for the same reason: evaluating
 * the shipped source beats restating it, because a restatement can be wrong in
 * the same way the copy is and then both agree on nothing.
 */
function workerPathHelpers(): {
    stripManifestPrefix: (id: string) => string;
    isTestFilePath: (path: string) => boolean;
    normalizeTestPath: (id: string | null | undefined) => string | null;
} {
    const start = WORKER_SOURCE.indexOf('function stripManifestPrefix(id) {');
    assert.ok(start > 0, 'the worker still defines stripManifestPrefix');
    const end = WORKER_SOURCE.indexOf('function extractTextRanges', start);
    assert.ok(end > start, 'the three path helpers are still contiguous');
    const source = WORKER_SOURCE.slice(start, end);
    for (const name of ['isTestFilePath', 'normalizeTestPath']) {
        assert.ok(source.includes(`function ${name}(`), `the worker still defines ${name}`);
    }
    return new Function(
        `${source}; return { stripManifestPrefix, isTestFilePath, normalizeTestPath };`
    )() as ReturnType<typeof workerPathHelpers>;
}

/**
 * ## Why this test exists, and what it caught
 *
 * The worker's comment claimed this file pinned its copies of the path rule. It
 * did not — grepping this file for the three symbols returned nothing — so the
 * copies could drift freely, which is the exact condition that produced the
 * `normalizeMessage` divergence upstream. A comment asserting coverage that does
 * not exist is worse than no comment, so either the assertion or the claim had to
 * go; this is the assertion.
 *
 * The inputs are chosen to separate the anchored rule from the two unanchored
 * spellings that preceded it, because that is where a silent drift would land:
 * a URL and a Windows path both carry a colon, and both survive the extension
 * filter, so getting them wrong emits a corrupted path rather than dropping it.
 */
test('the worker copies of the path rule match the shared ones', () => {
    const worker = workerPathHelpers();
    const cases: string[] = [
        // The prefix the rule is for, bare filename and full-path spellings.
        'xpcshell-remote.toml:toolkit/x/test_a.js',
        'mochitest.ini:dom/base/test/test_b.html',
        'browser/components/urlbar/tests/browser-tips/browser-nova.toml:browser/x/browser.toml',
        // The two shapes an unanchored rule corrupts.
        'http://mochi.test:8888/tests/dom/test_x.html',
        'C:/builds/foo/test_a.js',
        // The suffix, and both together.
        'dom/base/test/test_c.html (finished)',
        'xpcshell.toml:toolkit/x/test_d.js (finished)',
        // Not test paths.
        'toolkit/components/extensions/test/xpcshell/xpcshell.toml',
        'testAddTaskSkip',
        'replaying full log for dom/base/test/test_e.html',
        '',
    ];
    for (const input of cases) {
        assert.equal(
            worker.stripManifestPrefix(input),
            stripManifestPrefix(input),
            `stripManifestPrefix disagrees on ${JSON.stringify(input)}`
        );
        assert.equal(
            worker.isTestFilePath(input),
            isTestFilePath(input),
            `isTestFilePath disagrees on ${JSON.stringify(input)}`
        );
        assert.equal(
            worker.normalizeTestPath(input),
            normalizeTestPath(input),
            `normalizeTestPath disagrees on ${JSON.stringify(input)}`
        );
    }
    // The absent spellings, which only `normalizeTestPath` accepts.
    assert.equal(worker.normalizeTestPath(null), normalizeTestPath(null));
    assert.equal(worker.normalizeTestPath(undefined), normalizeTestPath(undefined));
});

/**
 * The anchoring, stated as the values it protects.
 *
 * Separate from the parity test above: that one asserts the two copies agree,
 * which they would also do if both were wrong. This one asserts what the rule
 * must produce, so a change that "fixes" both copies the same wrong way fails.
 */
test('a colon that is not a manifest prefix is left alone', () => {
    // Stripped: the prefix is a filename ending .toml/.ini.
    assert.equal(
        normalizeTestPath('xpcshell-remote.toml:toolkit/x/test_a.js'),
        'toolkit/x/test_a.js'
    );
    assert.equal(
        normalizeTestPath('mochitest.ini:dom/base/test/test_b.html'),
        'dom/base/test/test_b.html'
    );
    // Not stripped: a URL scheme and a Windows drive letter. Both used to lose
    // their head and still pass the extension filter, so both were emitted as
    // paths that match nothing in central — item 15's symptom, reintroduced.
    assert.equal(
        normalizeTestPath('http://mochi.test:8888/tests/dom/test_x.html'),
        'http://mochi.test:8888/tests/dom/test_x.html'
    );
    assert.equal(normalizeTestPath('C:/builds/foo/test_a.js'), 'C:/builds/foo/test_a.js');
    // The manifest part may contain `/`: every colon-carrying id in the corpus
    // spells it as a full path, so a `/`-free anchor would strip nothing at all.
    assert.equal(
        normalizeTestPath('dom/serviceworkers/test/browser-dFPI.toml:dom/x/test_y.html'),
        'dom/x/test_y.html'
    );
});

/**
 * The `Text` branch, which nothing else exercises.
 *
 * This change newly routes `site/try.ts`'s free-form `Text` marker through the
 * shared stripper, where it previously did not strip at all. The corpus contains
 * only colon-free range markers on that branch, so no fixture covers it and the
 * URL shape above is latent there rather than absent. Asserted directly on the
 * worker, since the CLI has no `Text` branch to compare against.
 */
test('the Text branch strips a manifest prefix and keeps a URL intact', () => {
    const extract = workerExtractTestTimings();
    const textProfile = (text: string): unknown => ({
        meta: { startTime: 0 },
        threads: [
            {
                stringArray: ['test'],
                markers: {
                    length: 1,
                    name: [0],
                    data: [{ type: 'Text', text }],
                    startTime: [10],
                    endTime: [20],
                },
            },
        ],
    });
    const pathsOf = (text: string): string[] =>
        extract(textProfile(text)).map((timing) => timing.path);

    // A prefixed path on the Text branch: stripped, which upstream did not do.
    assert.deepEqual(pathsOf('xpcshell-remote.toml:toolkit/x/test_a.js'), [
        'toolkit/x/test_a.js',
    ]);
    // A URL: kept whole. Under the unanchored rule this was
    // '//mochi.test:8888/tests/dom/test_x.html'.
    assert.deepEqual(pathsOf('http://mochi.test:8888/tests/dom/test_x.html'), [
        'http://mochi.test:8888/tests/dom/test_x.html',
    ]);
    // A range marker: not a path, so no row.
    assert.deepEqual(pathsOf('parallel'), []);
    assert.deepEqual(pathsOf('selftests'), []);
});

test('the worker copy of normalizeMessage matches the shared one', () => {
    const worker = workerNormalizeMessage();
    // Inputs chosen so that a missing substitution shows up as an inequality
    // rather than being absorbed. The CRLF cases are the ones that used to
    // differ; the literals are written out here, not generated.
    const cases: string[] = [
        'assertion failed\r\nRejection date: Mon Jan 01 2026\r\ntail',
        'assertion failed\nRejection date: Mon Jan 01 2026\ntail',
        'uncaught rejection\r\nRejection date: Tue Jan 02 2026 11:22:33 GMT',
        'timed out in task_12345 after a while',
        'Test ran for 42s and gave up',
        'plain failure with no per-run parts',
        'crlf only\r\nsecond line',
        '',
    ];
    for (const input of cases) {
        assert.equal(
            worker(input),
            normalizeMessage(input),
            `worker and lib disagree on ${JSON.stringify(input)}`
        );
    }
});

test('CRLF and LF spellings of one failure normalize to one message', () => {
    // The defect, stated as the thing it broke: the same failure reported from
    // a Windows job and a Linux job has to be ONE message group, or it is two
    // rows that render identically and neither matches central.
    const lf = 'uncaught rejection\nRejection date: Mon Jan 01 2026\nstack frame';
    const crlf = 'uncaught rejection\r\nRejection date: Mon Jan 01 2026\r\nstack frame';

    assert.equal(normalizeMessage(lf), 'uncaught rejection\nstack frame');
    assert.equal(normalizeMessage(crlf), 'uncaught rejection\nstack frame');
    assert.equal(normalizeMessage(lf), normalizeMessage(crlf), 'one failure, one group');

    // And the worker agrees, which is the half that used to be wrong.
    const worker = workerNormalizeMessage();
    assert.equal(worker(crlf), 'uncaught rejection\nstack frame');
    assert.equal(worker(lf), worker(crlf));

    // Without the CRLF pass the two differ by exactly the carriage return —
    // asserted so the test states what the old behaviour WAS, and fails if
    // someone reintroduces it thinking it made no difference.
    const withoutCrlfPass = (message: string): string =>
        message
            .replace(/task_\d+/g, 'task_id')
            .replace(/\nRejection date: [^\n]+/g, '')
            .replace(/Test ran for \d+s/g, 'Test ran for Xs');
    assert.equal(withoutCrlfPass(lf), 'uncaught rejection\nstack frame');
    assert.equal(withoutCrlfPass(crlf), 'uncaught rejection\r\nstack frame');
    assert.notEqual(withoutCrlfPass(lf), withoutCrlfPass(crlf));
});

test('absence normalizes to null, whichever way it is spelled', () => {
    // The CLI returned `null` for `null` and THREW on `undefined`; the page
    // returned `undefined` for both. A marker with no `message` field is
    // `undefined`, so the CLI's contract was one optional-chain away from a
    // crash on real input.
    assert.equal(normalizeMessage(null), null);
    assert.equal(normalizeMessage(undefined), null);
    // An empty message is a message, and must not collapse into absence.
    assert.equal(normalizeMessage(''), '');
});

// --- UNEXPECTED-PASS: derived on both sides, or on neither ----------------

/**
 * ## The divergence this closes
 *
 * `FAILURE_STATUSES` lists `UNEXPECTED-PASS` and both sides read the shared
 * constant, so both *classify* one as a failure. Only the page could ever
 * *produce* one: `data.expected` appeared zero times in `cli/commands/try.ts`,
 * so a now-wrong `fail-if` annotation was a row on `try.html` and invisible in
 * `fx-tests try`. Matching constants, different universes — the same shape as
 * the `--all-jobs` defect, and made worse by the hoist, because a shared
 * constant looks authoritative while one consumer cannot reach one of its
 * values.
 *
 * ## Why the CLI derives it rather than the constant being unshared
 *
 * The alternative was to stop sharing `FAILURE_STATUSES`. Rejected: the two
 * sides genuinely answer the same question ("is this a row in the failures
 * table"), and the set differing between them is what the hoist existed to
 * prevent. The gap was in the *producer*, not the classifier, so the producer
 * is what was fixed.
 *
 * ## What the corpus says, and why the test is synthetic anyway
 *
 * Measured over the 972 cached profiles of push 7d16bff81bb1: 371 parsed,
 * 135,712 `Test` markers, and **zero** carrying an `expected` field — the only
 * keys present are `color, message, name, status, test, type`. So this status
 * is unreachable on both sides for this push, and no fixture can exercise it.
 * That is a reason to synthesize the marker, not a reason to skip it: the
 * annotation is real, the page has always handled it, and an untested branch
 * on one side is how the two drifted.
 */
test('both sides turn an unexpected PASS into the same status', () => {
    // The page's derivation still exists and is still spelled the way the
    // hand-evaluated rule below assumes. Read off the source, so deleting the
    // branch fails here rather than silently making the two agree on nothing.
    assert.ok(
        WORKER_SOURCE.includes(
            "} else if (status === 'PASS' && data.expected && data.expected !== 'PASS') {"
        ),
        'the page still derives UNEXPECTED-PASS from an unexpected PASS'
    );

    // The page's rule, evaluated from its own source rather than restated.
    const pageStatus = new Function(
        'data',
        `let status = data.status || 'UNKNOWN';
         if (status === 'FAIL' && data.color === 'green') { status = 'EXPECTED-FAIL'; }
         else if (status === 'PASS' && data.expected && data.expected !== 'PASS') {
             status = 'UNEXPECTED-PASS';
         }
         return status;`
    ) as (data: Record<string, unknown>) => string;

    // And the CLI's, through its real parser, on the same three markers.
    const cliStatus = (data: Record<string, unknown>): string => {
        const profile = {
            meta: { startTime: 0 },
            threads: [
                {
                    stringArray: ['test'],
                    markers: {
                        length: 1,
                        name: [0],
                        data: [{ type: 'Test', test: 'a/b/test_x.js', ...data }],
                        startTime: [1],
                        endTime: [2],
                    },
                },
            ],
        };
        const job = { jobName: 'test-linux/opt-xpcshell', taskId: 'T', retryId: 0 };
        return parseTestMarkers(profile, job as TreeherderJob)[0]!.status;
    };

    const cases: Record<string, unknown>[] = [
        { status: 'PASS', expected: 'FAIL' },
        { status: 'PASS', expected: 'TIMEOUT' },
        { status: 'PASS', expected: 'PASS' },
        { status: 'PASS' },
        { status: 'FAIL', color: 'green' },
        { status: 'FAIL' },
    ];
    // The expected values are written out, not taken from either side.
    const expected = [
        'UNEXPECTED-PASS',
        'UNEXPECTED-PASS',
        'PASS',
        'PASS',
        'EXPECTED-FAIL',
        'FAIL',
    ];
    for (const [index, data] of cases.entries()) {
        const label = JSON.stringify(data);
        assert.equal(cliStatus(data), expected[index], `CLI on ${label}`);
        assert.equal(pageStatus({ status: 'PASS', ...data }), expected[index], `page on ${label}`);
    }
});

// --- the manifest prefix: one rule for both, and for all three markers ------

/**
 * The worker's whole `extractTestTimings`, lifted out of the template literal.
 *
 * `workerNormalizeMessage` above lifts one function; this lifts the parser, so a
 * page-side path assertion is made against the code the page actually ships
 * rather than against a restatement of it. `self.onmessage` is cut because it
 * references a worker global.
 */
function workerExtractTestTimings(): (profile: unknown) => {
    path: string;
    status: string;
}[] {
    const start = WORKER_SOURCE.indexOf('const WORKER_CODE = String.raw`');
    assert.ok(start > 0, 'the worker source is still a String.raw template');
    const bodyStart = WORKER_SOURCE.indexOf('`', start) + 1;
    const bodyEnd = WORKER_SOURCE.indexOf('\n`;', bodyStart);
    assert.ok(bodyEnd > bodyStart);
    const body = WORKER_SOURCE.slice(bodyStart, bodyEnd).replace(/self\.onmessage[\s\S]*$/, '');
    return new Function(`${body}; return extractTestTimings;`)() as (profile: unknown) => {
        path: string;
        status: string;
    }[];
}

/**
 * A job whose only failure is a crash recorded against a prefixed test id.
 *
 * The shape measured on try push `e2cf4a2c4039c5e0b594e351e604eaaf88c4ca57`: a
 * `Test` marker at `CRASH` claims the crash inside its own range, and the *other*
 * crash markers against the same id fall outside it and become synthetic entries.
 * Those synthetic ones are what carried the prefix to `try.html`, so the profile
 * has two crashes and one `Test` marker.
 */
function prefixedCrashProfile(): unknown {
    const id =
        'xpcshell-remote.toml:toolkit/components/extensions/test/xpcshell/' +
        'test_ext_background_early_shutdown.js';
    const strings = ['test', 'Crash'];
    return {
        meta: { startTime: 0 },
        threads: [
            {
                stringArray: strings,
                markers: {
                    length: 3,
                    name: [1, 1, 0],
                    data: [
                        // Inside the Test marker's range: claimed.
                        { type: 'Crash', test: id, signature: 'sig-claimed', minidump: null },
                        // Outside it: this is the one that became a synthetic entry.
                        { type: 'Crash', test: id, signature: 'sig-unclaimed', minidump: null },
                        { type: 'Test', test: id, status: 'CRASH' },
                    ],
                    startTime: [10, 100, 10],
                    endTime: [10, 100, 20],
                },
            },
        ],
    };
}

/**
 * ## The divergence this closes
 *
 * Item 15 of `FX_TESTS_SUMMARY.md`, reported by the repository owner against
 * <https://tests.firefox.dev/try.html?rev=e2cf4a2c4039c5e0b594e351e604eaaf88c4ca57>:
 * two known intermittents shown as new failures, because their path kept its
 * manifest prefix and so matched nothing in central.
 *
 * `site/try.ts` stripped the prefix in the `Test` branch only. The synthetic
 * crash loop and the `Text` branch did not, and the crash loop is what produced
 * the owner's two rows: running the shipped worker over that push's six cached
 * profiles emitted 31,578 timings of which 60 still carried a colon, 54 for
 * `test_ext_background_early_shutdown.js` and 6 for
 * `test_ext_storage_session_on_crash.js`. `cli/commands/try.ts` stripped in its
 * copy of the same loop, so the two front-ends spelled one test two ways.
 *
 * The reported CLI half — "it drops the affected tests entirely" — did **not**
 * reproduce, and that is asserted below rather than left as an absence: the CLI
 * emits the same one path the page does.
 */
test('a prefixed crash id yields the same bare path on both sides', () => {
    const bare =
        'toolkit/components/extensions/test/xpcshell/test_ext_background_early_shutdown.js';
    const profile = prefixedCrashProfile();

    const pagePaths = workerExtractTestTimings()(profile).map((timing) => timing.path);
    const cliPaths = parseTestMarkers(profile, {
        jobName: 'test-linux2404-64-ccov/opt-xpcshell',
        taskId: 'T',
        retryId: 0,
    } as TreeherderJob).map((timing) => timing.path);

    // Two entries each: the claimed CRASH and the synthetic one. The synthetic
    // entry is the one that used to differ.
    assert.deepEqual(pagePaths, [bare, bare], 'the page emits the bare path twice');
    assert.deepEqual(cliPaths, [bare, bare], 'and so does the CLI — it drops neither');
    assert.deepEqual(pagePaths, cliPaths, 'one test, one spelling, both front-ends');
});

test('no emitted path carries a manifest prefix, on either side', () => {
    // The fixture push first: mochitest, so no path in it has a prefix, and the
    // assertion is that neither parser invents one. Then the synthetic prefixed
    // profile, which is where the two used to disagree.
    const pageExtract = workerExtractTestTimings();
    for (const [key, timings] of timingsByRun(PUSH)) {
        const job = { jobName: key.split('|')[0]!, taskId: 'T', retryId: 0 } as TreeherderJob;
        const profile = synthProfile(timings);
        for (const timing of pageExtract(profile)) {
            assert.ok(!timing.path.includes(':'), `page emitted ${timing.path}`);
        }
        for (const timing of parseTestMarkers(profile, job)) {
            assert.ok(!timing.path.includes(':'), `CLI emitted ${timing.path}`);
        }
    }
    // And the expected count is present, which is the other half of item 15's
    // asserted invariant: a normaliser that dropped the rows instead of fixing
    // them would satisfy the colon check alone. 178 rather than 180 because two
    // of the push's rows are crashes recorded against a `.toml` manifest, which
    // the CLI drops on purpose — the same two the round-trip test above counts
    // and the divergence list declares, not a loss introduced here.
    assert.equal(PUSH.timings.length, 180, 'the pinned push changed');
    const cliTotal = [...timingsByRun(PUSH)].reduce(
        (total, [key, timings]) =>
            total +
            parseTestMarkers(synthProfile(timings), {
                jobName: key.split('|')[0]!,
                taskId: 'T',
                retryId: 0,
            } as TreeherderJob).length,
        0
    );
    assert.equal(cliTotal, 178, 'every fixture timing but the two manifests survives');

    for (const timing of pageExtract(prefixedCrashProfile())) {
        assert.ok(!timing.path.includes(':'), `page emitted ${timing.path}`);
    }
});

/**
 * The drop is a recorded entry, not a `continue`.
 *
 * Item 15's fix asks for this explicitly. The subject is a crash recorded against
 * a `.toml` manifest — real, and deliberately not reported as a test failure
 * because it has no path to compare against central, which is a thing the command
 * should be able to say rather than a row a reader has to notice is absent.
 */
test('a crash against a manifest is recorded as a drop, with its reason', () => {
    const profile = {
        meta: { startTime: 0 },
        threads: [
            {
                stringArray: ['test', 'Crash'],
                markers: {
                    length: 1,
                    name: [1],
                    data: [
                        {
                            type: 'Crash',
                            test: 'toolkit/components/extensions/test/xpcshell/xpcshell.toml',
                            signature: 'shutdownhang | Foo',
                            minidump: null,
                        },
                    ],
                    startTime: [10],
                    endTime: [10],
                },
            },
        ],
    };
    const dropped: DroppedMarker[] = [];
    const timings = parseTestMarkers(
        profile,
        { jobName: 'test-linux/opt-xpcshell', taskId: 'T', retryId: 0 } as TreeherderJob,
        dropped
    );
    assert.equal(timings.length, 0, 'a manifest is not a test path, so no row');
    assert.deepEqual(dropped, [
        {
            kind: 'Crash',
            id: 'toolkit/components/extensions/test/xpcshell/xpcshell.toml',
            reason: 'not-a-test-path',
            status: 'CRASH',
            minidump: null,
        },
    ]);
});

/**
 * A `Test` marker whose id is not a path drops silently *by design*.
 *
 * The xpcshell selftest job's markers are 63 bare function names, all `PASS`, six
 * jobs — 378 drops that mean nothing. Only a failing marker is recorded, so the
 * one that matters is not buried. Asserted in both directions so the filter
 * cannot be widened back by accident.
 */
test('only a failing Test marker records its drop', () => {
    const markerProfile = (status: string): unknown => ({
        meta: { startTime: 0 },
        threads: [
            {
                stringArray: ['test'],
                markers: {
                    length: 1,
                    name: [0],
                    data: [{ type: 'Test', test: 'testAddTaskSkip', status }],
                    startTime: [10],
                    endTime: [20],
                },
            },
        ],
    });
    const job = { jobName: 'test-linux/opt-xpcshell', taskId: 'T', retryId: 0 } as TreeherderJob;
    for (const [status, expected] of [
        ['PASS', 0],
        ['SKIP', 0],
        ['FAIL', 1],
        ['TIMEOUT', 1],
        ['CRASH', 1],
        ['ERROR', 1],
    ] as [string, number][]) {
        const dropped: DroppedMarker[] = [];
        assert.equal(parseTestMarkers(markerProfile(status), job, dropped).length, 0);
        assert.equal(dropped.length, expected, `${status} drop recorded ${dropped.length} times`);
    }
});

// --- item 18's count, which is the whole feature -------------------------

/**
 * ## Why an arithmetic test, on rendered text
 *
 * Item 18's default row says how many messages it is not showing. That number is
 * the feature — it is what tells a reader to pass `--messages` — so a wrong one
 * defeats it silently, and review found two ways it was wrong.
 *
 * `messages` and `allMessages` are **not nested**, which is the trap:
 *
 * - a synthetic `CRASH` row has its signature in `messages` and nothing at all in
 *   `allMessages` (a crash marker carries no `TestStatus` messages), so
 *   `allMessages.length - shown.length` went *negative* and the hint vanished;
 * - a message carried on the `Test` marker rather than a `TestStatus` one is
 *   likewise in `messages` only, so it was subtracted from a total that never
 *   counted it.
 *
 * Asserted on the rendered lines rather than on the JSON, because the defect was
 * in the renderer and the JSON was right both times.
 */
test('the +N more count matches the messages that exist, crashes included', async () => {
    const text = (
        await invoke(['try', '7d16bff81bb1', '--limit', '0'], {
            treeherder: fakeTreeherder(PUSH.jobs),
            fetchUrl: pushProfileFetcher(PUSH),
            source: fixtureSource(),
        })
    ).stdout;
    const result = await cli();
    const rows = [
        ...result.permaFails,
        ...result.knownIntermittents,
        ...result.newIntermittents,
    ];
    assert.ok(rows.length > 0, 'the pinned push still has failures to check');

    let checkedHints = 0;
    let checkedNested = 0;
    // The shape that made the old arithmetic go negative, counted over the rows
    // themselves rather than over the rendered blocks — on this push both such
    // rows land in a compact section, which prints no messages, so counting them
    // inside the render loop below would count zero and the control would be
    // measuring the wrong thing.
    const notNested = rows.filter(
        (row) => row.allMessages.length === 0 && row.messages.length > 0
    );
    assert.deepEqual(
        notNested.map((row) => row.statuses.join(',')),
        ['CRASH', 'CRASH'],
        'the two not-nested rows on this push are its synthetic crashes'
    );
    for (const row of notNested) {
        // `allMessages.length - min(messages.length, 2)` was -1 here, so the
        // union is what the count has to be taken over.
        const union = new Set<string>([
            ...row.messages,
            ...row.allMessages.map((entry) => entry.message),
        ]);
        for (const message of row.messages.slice(0, 2)) {
            union.delete(message);
        }
        assert.equal(union.size, 0, `${row.path}: a crash row has nothing left to hint at`);
    }

    for (const row of rows) {
        // The union is the population the hint must describe: every distinct
        // message this test recorded anywhere, minus the ones the row printed.
        const union = new Set<string>([
            ...row.messages,
            ...row.allMessages.map((entry) => entry.message),
        ]);
        for (const message of row.messages.slice(0, 2)) {
            union.delete(message);
        }
        // The row's own block of the output, from its path to the blank line.
        // Only the detailed sections print one, so a compact row has none.
        const start = text.indexOf(`  ${row.path}\n`);
        if (start < 0) {
            continue;
        }
        const end = text.indexOf('\n\n', start);
        const block = text.slice(start, end < 0 ? undefined : end);
        const hint = /\(\+(\d+) more messages? for this test; --messages to see them\)/.exec(block);

        if (union.size === 0) {
            assert.equal(hint, null, `${row.path}: a hint with nothing left to show`);
        } else {
            assert.ok(hint !== null, `${row.path}: ${union.size} unshown messages and no hint`);
            assert.equal(
                Number(hint[1]),
                union.size,
                `${row.path}: the hint miscounts the unshown messages`
            );
            checkedHints++;
        }
        if (row.allMessages.length > row.messages.length) {
            checkedNested++;
        }
    }
    // Positive controls: the corpus must actually contain the shapes this test
    // claims to cover, or it passes by never reaching its assertions — the
    // failure mode review flagged in the item 15 probe, which had no control.
    assert.ok(checkedHints > 0, 'no rendered row exercised the +N hint');
    assert.ok(checkedNested > 0, 'no rendered row had more messages than it showed');
});

/**
 * A failure line's stack, the same text on both sides.
 *
 * `lib/model/test-markers.ts` resolves a `TestStatus` marker's stack for
 * `task.html` with a port of the worker's `resolveStack`; the worker is a code
 * string that cannot import, so the two copies are pinned here instead. The
 * profile is `task.html`'s fixture: one leak with a two-frame stack whose inner
 * frame has a file and a line, and a retry of it with none.
 */
test('a failure line carries the same stack on both sides', () => {
    type PageTiming = { path: string; allMessages: { message: string; stack?: string }[] };
    const profile = sampleProfile();
    const page = (workerExtractTestTimings()(profile) as unknown as PageTiming[])
        .filter((timing) => timing.path === 'a/browser_twice.js')
        .flatMap((timing) => timing.allMessages)
        .filter((entry) => !entry.message.includes('profile uploaded in'))
        .map((entry) => [entry.message, entry.stack ?? null]);
    const cli = parseTestMarkers(profile, {
        jobName: 'test-linux/opt-mochitest-1',
        taskId: 'T',
        retryId: 0,
    } as TreeherderJob)
        .filter((timing) => timing.path === 'a/browser_twice.js')
        .flatMap((timing) => timing.details)
        .map((detail) => [detail.message, detail.stack]);
    assert.deepEqual(cli, [
        [
            'leaked 1 window(s)',
            'run @ chrome://mochitests/content/browser/a/browser_twice.js:12\n' +
                'observe — JS Function - observe @  0x1f',
        ],
        ['leaked 1 window(s)', null],
    ]);
    assert.deepEqual(page, cli, 'the worker resolves the same stacks');
});
