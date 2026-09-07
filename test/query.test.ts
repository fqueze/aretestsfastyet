/**
 * The query layer, against the checked-in fixtures.
 *
 * Golden values are written as literals and were derived from the fixtures
 * rather than from the code under test — every one of them is re-derivable by
 * summing the raw JSON, and several are cross-checked against a second,
 * independent path in the assertions below.
 *
 * The four things these tests are really defending:
 *
 * 1. **Reconciliation.** A test's per-config run counts must sum to its total
 *    run count. The two are computed by different code over different shapes
 *    (`durations` groups carry a job name, `task-ids` groups need a `taskInfo`
 *    hop), so agreeing is evidence rather than tautology.
 * 2. **The family asymmetry.** A skip count means a different thing per family
 *    (`FORMATS.md`), and the fixtures reproduce it exactly: 2,147 `run-if`
 *    skips in the daily file, zero in every aggregate. A regression that
 *    applied the filter in the wrong place would move one of those numbers.
 * 3. **The coverage states.** ran-and-passed and ran-and-skipped are what
 *    `--coverage` exists to separate — both are recorded facts, and a
 *    failure-only view shows neither. The test asserts a real test that has
 *    both. Configs the test was *not* scheduled on are deliberately absent:
 *    see `lib/query/coverage.ts`.
 * 4. **The recent window's exact width.** Sized by run count rather than by
 *    days, and inclusive at both ends. An off-by-one there reports an 11-day
 *    window as 10 days — a plausible-looking wrong number, which is the
 *    failure mode this data keeps producing.
 *
 * Where a branch is reachable by the format but absent from today's data —
 * an `EXPECTED-FAIL` carrying a message, a config with both a `skip-if` and a
 * `run-if`, a day on which CI did not run — the input is built by hand and
 * says so. Those are the cases a fixture cannot supply and a mutation would
 * otherwise survive.
 */

import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeBucket, type BucketFile } from '../lib/formats/buckets.ts';
import { decodeDaily, type DailyFile } from '../lib/formats/daily.ts';
import {
    decodeIssues,
    decodeIssuesWithTaskIds,
    type IssuesFile,
    type IssuesWithTaskIdsFile,
} from '../lib/formats/issues.ts';
import type { StatsFile } from '../lib/formats/stats.ts';
import { classifyStatus } from '../lib/model/status.ts';
import { stripChunkSuffix } from '../lib/model/job-name.ts';
import {
    computeTestStats,
    configFilter,
    configTargetsOfEntry,
    crashSignatureCounts,
    failureMessageCounts,
    inDayRange,
    jobNameOfEntry,
    narrowEntryToConfig,
} from '../lib/query/test-stats.ts';
import {
    canAttributeConfigs,
    computeConfigStats,
} from '../lib/query/config-stats.ts';
import {
    coverageOf,
    coveragePlatforms,
    platformsCovered,
    platformsInFile,
} from '../lib/query/coverage.ts';
import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import type { TestIdentity } from '../lib/formats/tables.ts';
import { findIssues, findSkips, groupIssues } from '../lib/query/issues.ts';
import { groupFailuresByMessage } from '../lib/query/failures.ts';
import { groupCrashesBySignature } from '../lib/query/crashes.ts';
import { computeSummary, markerTotals } from '../lib/query/summary.ts';
import {
    type TestLookupLoaders,
    type TestPathsSource,
    CANDIDATE_LIMIT,
    collectTestPaths,
    matchTestPaths,
    resolveTest,
} from '../lib/query/test-lookup.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

async function fixture<T>(name: string): Promise<T> {
    return JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8')) as T;
}

const bucket = decodeBucket(await fixture<BucketFile>('xpcshell-00.json'));
const mochitestBucket = decodeBucket(await fixture<BucketFile>('mochitest-00.json'));
const issues = decodeIssues(await fixture<IssuesFile>('xpcshell-issues.json'));
const issuesWithTaskIds = decodeIssuesWithTaskIds(
    await fixture<IssuesWithTaskIdsFile>('xpcshell-issues-with-taskids.json')
);
const daily = decodeDaily(await fixture<DailyFile>('xpcshell-2026-08-03.json'));
const xpcshellStats = await fixture<StatsFile>('xpcshell-stats.json');
const mochitestStats = await fixture<StatsFile>('mochitest-stats.json');

/**
 * A Windows-only crash-reporter test, chosen because it exercises the coverage
 * states at once: it runs and is intermittent on 5 Windows configs, runs clean
 * on 4, and is `skip-if`-skipped on 13 others — including every Android config
 * it is scheduled on. The file also holds mac configs it is not scheduled on
 * at all, which is what makes it a check on `--coverage` reporting only what
 * the data records.
 */
const WINDOWS_TEST = 'toolkit/crashreporter/test/unit/test_crash_win64cfi_push_nonvol.js';

// --- test-stats ----------------------------------------------------------

test('computeTestStats totals a test by status kind', () => {
    const identity = bucket.findTest(WINDOWS_TEST);
    assert.ok(identity, `fixture is missing ${WINDOWS_TEST}`);
    assert.equal(identity.component, 'Toolkit :: Crash Reporting');

    const stats = computeTestStats(bucket, identity.testId);
    assert.deepEqual(stats, {
        family: 'bucket',
        runCount: 1265,
        passCount: 1254,
        failCount: 9,
        timeoutCount: 2,
        crashCount: 0,
        expectedFailCount: 0,
        unknownCount: 0,
        skipCount: 1365,
        runIfSkipCount: 0,
        passRate: (1254 / 1265) * 100,
    });
    // The verdict axis: 11 of 1265 runs did not pass, so this is intermittent
    // rather than broken, and the rate is the number a caller would print.
    assert.equal(stats.failCount + stats.timeoutCount + stats.crashCount, 11);
});

test('runCount excludes skips and passRate is null when nothing ran', () => {
    // Skips are not runs: a test skipped everywhere has no pass rate at all,
    // and reporting 0% would claim it ran and failed.
    const empty = computeTestStats(bucket, bucket.testCount - 1, {
        jobFilter: () => false,
    });
    assert.equal(empty.runCount, 0);
    assert.equal(empty.passRate, null);
});

test('the day range filters the aggregate rather than refetching', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const all = computeTestStats(bucket, identity.testId);
    const lastThree = computeTestStats(bucket, identity.testId, {
        dayRange: { from: 18, to: 20 },
    });
    assert.ok(lastThree.runCount > 0, 'the last three days should have runs');
    assert.ok(
        lastThree.runCount < all.runCount,
        'a three-day slice must be smaller than the whole 21-day window'
    );

    // Slicing the window into two halves must partition it exactly: nothing
    // double-counted at the boundary, nothing dropped.
    const lower = computeTestStats(bucket, identity.testId, { dayRange: { from: 0, to: 9 } });
    const upper = computeTestStats(bucket, identity.testId, { dayRange: { from: 10, to: 20 } });
    assert.equal(lower.runCount + upper.runCount, all.runCount);
    assert.equal(lower.skipCount + upper.skipCount, all.skipCount);
});

test('a daily file ignores the day range, because it is one day', () => {
    // Entries of a daily file carry `day === null`. Filtering them out would
    // make `--day` against a daily file return nothing at all.
    assert.equal(inDayRange(null, { from: 5, to: 6 }), true);
    assert.equal(inDayRange(3, { from: 5, to: 6 }), false);
    assert.equal(inDayRange(5, { from: 5, to: 6 }), true);

    const withRange = computeTestStats(daily, 0, { dayRange: { from: 0, to: 0 } });
    const without = computeTestStats(daily, 0);
    assert.deepEqual(withRange, without);
});

test('configFilter unions the includes and applies the excludes after', () => {
    const linuxNotDebug = configFilter(['linux'], ['debug']);
    assert.equal(linuxNotDebug('test-linux2404-64/opt-xpcshell'), true);
    assert.equal(linuxNotDebug('test-linux2404-64/debug-xpcshell'), false);
    assert.equal(linuxNotDebug('test-windows11-64/opt-xpcshell'), false);

    const union = configFilter(['linux', 'windows11']);
    assert.equal(union('test-linux2404-64/opt-xpcshell'), true);
    assert.equal(union('test-windows11-64-25h2/opt-xpcshell'), true);
    assert.equal(union('test-macosx1470-64/opt-xpcshell'), false);

    // No includes means everything, which is what "all configs" has to mean.
    assert.equal(configFilter()('anything'), true);
});

/**
 * A test whose failing entries hold tasks from more than one configuration.
 *
 * The shape a per-entry config filter gets wrong, and the reason it is a fixture
 * test rather than a hand-built input: two of this test's failing entries span
 * two configs each, and in both of them one of the two configs is reachable only
 * as the *second* task in the bucket.
 * `test-android-em-14-x86_64-shippable-lite/…-nofis`
 * appears only at index 1 of a two-task FAIL-PARALLEL entry, so a filter reading
 * `taskIdIndexes[0]` drops its one failure while `computeConfigStats`, which
 * attributes per task, keeps it. That is what made `test --config` print `0 fail`
 * in its header beside `2` in its own per-config table.
 */
const MULTI_CONFIG_ENTRY_TEST =
    'toolkit/components/extensions/test/xpcshell/test_ext_contentscript_scriptCreated.js';

test('a config filter attributes a multi-config entry per task, not per entry', () => {
    const identity = bucket.findTest(MULTI_CONFIG_ENTRY_TEST)!;
    const entries = [...bucket.runsOfTest(identity.testId)];

    // The premise, asserted so this test cannot quietly become vacuous if the
    // fixture is regenerated: an entry with tasks on two configs exists, and
    // one config is reachable only past index 0.
    const spanning = entries
        .map((entry) => configTargetsOfEntry(bucket, entry))
        .filter((targets) => targets.length > 1);
    assert.equal(spanning.length, 2, 'the fixture must still hold multi-config entries');
    const lateOnly = spanning.some((targets) =>
        targets.some(
            (target) =>
                target.jobName ===
                    'test-android-em-14-x86_64-shippable-lite/opt-geckoview-xpcshell-nofis' &&
                !target.indexes.includes(0)
        )
    );
    assert.ok(lateOnly, 'the config that only appears past index 0 must still do so');

    // The invariant. For every config the test failed on, the header totals and
    // the per-config table have to report the same number of failures.
    const configs = computeConfigStats(bucket, identity.testId);
    for (const config of configs) {
        const jobFilter = configFilter([config.jobName]);
        const totals = computeTestStats(bucket, identity.testId, { jobFilter });
        const filtered = computeConfigStats(bucket, identity.testId, { jobFilter });
        const tableFails = filtered.reduce((sum, row) => sum + row.failCount, 0);
        assert.equal(
            totals.failCount + totals.timeoutCount + totals.crashCount,
            tableFails,
            `${config.jobName}: header totals and per-config table disagree`
        );
        const messages = failureMessageCounts(bucket, identity.testId, { jobFilter });
        assert.equal(
            [...messages.values()].reduce((sum, n) => sum + n, 0),
            totals.failCount,
            `${config.jobName}: the message list must cover every counted failure`
        );
    }

    // The one that used to read 0. `--config` on this substring matches one
    // config, whose single failure sits at index 1 of its entry.
    const lateFilter = configFilter([
        'test-android-em-14-x86_64-shippable-lite/opt-geckoview-xpcshell-nofis',
    ]);
    assert.equal(computeTestStats(bucket, identity.testId, { jobFilter: lateFilter }).failCount, 1);
});

test('the parallel-array invariant narrowing relies on holds in every family', () => {
    // `narrowEntryToConfig` indexes an entry's arrays positionally and throws if
    // one is not `count` long. That is an assertion rather than a guard, so the
    // premise is checked here: across these fixtures every array is exactly
    // `count` long. Measured the same way over ~105M entries in ~110 real files
    // while writing it, also with zero exceptions.
    for (const file of [bucket, mochitestBucket, daily]) {
        for (let testId = 0; testId < file.testCount; testId++) {
            for (const entry of file.runsOfTest(testId)) {
                for (const field of [
                    'taskIds',
                    'taskIdIndexes',
                    'durations',
                    'timestamps',
                    'minidumps',
                ] as const) {
                    const values = entry[field];
                    if (values !== undefined) {
                        assert.equal(
                            values.length,
                            entry.count,
                            `${file.family} ${entry.status}: ${field} is not parallel to count`
                        );
                    }
                }
            }
        }
    }
});

test('narrowEntryToConfig refuses an entry whose arrays are not parallel', () => {
    // The assertion itself, on a hand-built entry: no real file produces this
    // shape (see the test above), so it cannot be reached from a fixture, and a
    // silent `.filter()` here would shift task attribution rather than fail.
    const identity = bucket.findTest(MULTI_CONFIG_ENTRY_TEST)!;
    const failing = [...bucket.runsOfTest(identity.testId)].find(
        (entry) => configTargetsOfEntry(bucket, entry).length > 1
    )!;
    // A filter keeping *one* of the entry's configs, so narrowing actually runs:
    // when it keeps them all, `count` is unchanged and the entry is returned
    // as-is without touching the arrays.
    const oneConfig = configFilter([configTargetsOfEntry(bucket, failing)[0]!.jobName]);
    assert.ok(narrowEntryToConfig(bucket, failing, oneConfig) !== null, 'the filter must match');

    const truncated = { ...failing, taskIds: failing.taskIds!.slice(0, 1) };
    assert.throws(
        () => narrowEntryToConfig(bucket, truncated, oneConfig),
        /taskIds for \d+ runs; narrowing by configuration needs them parallel/
    );
});

test('narrowEntryToConfig keeps the parallel arrays in step with the count', () => {
    const identity = bucket.findTest(MULTI_CONFIG_ENTRY_TEST)!;
    const jobFilter = configFilter([
        'test-android-em-14-x86_64-shippable-lite/opt-geckoview-xpcshell-nofis',
    ]);
    const narrowed = [...bucket.runsOfTest(identity.testId)]
        .map((entry) => narrowEntryToConfig(bucket, entry, jobFilter))
        .filter((entry) => entry !== null);

    assert.ok(narrowed.length > 0, 'the filter must keep something');
    for (const entry of narrowed) {
        // The property every per-task renderer depends on: a task-ID list, a
        // rerun count and a profile list built from this entry all describe the
        // same runs the count claims.
        if (entry.taskIds !== undefined) {
            assert.equal(entry.taskIds.length, entry.count, entry.status);
            assert.equal(entry.taskIdIndexes?.length, entry.count, entry.status);
            for (const taskIdIndex of entry.taskIdIndexes!) {
                assert.ok(
                    jobFilter(bucket.jobNameOfTaskIndex(taskIdIndex)!),
                    'a narrowed entry must hold no task from another config'
                );
            }
        }
    }
});

test('a failing entry resolves its job through taskInfo, not through jobName', () => {
    // The two attribution paths. `durations` and `skip-counts` groups name a
    // job directly; the failing shapes carry only task-ID indices, so their
    // configuration has to be looked up through `taskInfo.jobNameIds`. Losing
    // that hop would leave every fail, timeout and crash unattributed — the
    // failure and crash groupings would report no configurations at all, and
    // `computeConfigStats` would drop the failures from its rows.
    let viaJobName = 0;
    let viaTaskIndex = 0;
    for (let testId = 0; testId < bucket.testCount; testId++) {
        for (const entry of bucket.runsOfTest(testId)) {
            const jobName = jobNameOfEntry(bucket, entry);
            assert.notEqual(jobName, null, `${entry.status} entry resolved to no job`);
            if (entry.jobName !== undefined) {
                viaJobName += 1;
            } else {
                assert.notEqual(entry.taskIdIndexes, undefined);
                viaTaskIndex += 1;
                // Only the non-passing shapes take this path.
                const { kind } = classifyStatus(entry.status);
                assert.ok(
                    kind === 'fail' || kind === 'timeout' || kind === 'crash',
                    `${entry.status} should not need a taskInfo hop`
                );
            }
        }
    }
    assert.equal(viaJobName, 11250);
    assert.equal(viaTaskIndex, 55, 'the failing shapes must go through taskInfo');

    // And the resolved names reach the groupings that depend on them.
    const crashes = groupCrashesBySignature(bucket);
    assert.ok(crashes.length > 0);
    for (const group of crashes) {
        assert.ok(group.jobNames.size > 0, 'a crash group must know its configs');
    }
});

test('failure messages and crash signatures are counted separately', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const messages = failureMessageCounts(bucket, identity.testId);
    const total = [...messages.values()].reduce((sum, n) => sum + n, 0);
    // Every FAIL run is accounted for by exactly one message bucket, and
    // timeouts contribute nothing because their groups carry no messageIds.
    assert.equal(total, computeTestStats(bucket, identity.testId).failCount);

    // A crashing test: signatures come off `crashSignatureIds`, never off
    // messages, because CRASH groups carry no messageIds at all.
    const crashing = bucket.findTest('dom/indexedDB/test/unit/test_setVersion_exclusion.js')!;
    const signatures = crashSignatureCounts(bucket, crashing.testId);
    const signatureTotal = [...signatures.values()].reduce((sum, n) => sum + n, 0);
    assert.equal(signatureTotal, computeTestStats(bucket, crashing.testId).crashCount);
    assert.equal(signatureTotal, 10);
});

// --- the family asymmetry ------------------------------------------------

test('the 21-day aggregates drop run-if skips and the daily files keep them', () => {
    // `FORMATS.md`'s central measured finding, reproduced on the fixtures. A
    // change that applied the filter in the wrong place moves one of these.
    const totals = (file: typeof bucket): { skipped: number; runIf: number } => {
        let skipped = 0;
        let runIf = 0;
        for (let testId = 0; testId < file.testCount; testId++) {
            const stats = computeTestStats(file, testId);
            skipped += stats.skipCount;
            runIf += stats.runIfSkipCount;
        }
        return { skipped, runIf };
    };

    assert.deepEqual(totals(daily), { skipped: 765, runIf: 2147 });
    assert.deepEqual(totals(bucket), { skipped: 11444, runIf: 0 });
    assert.deepEqual(totals(issues), { skipped: 17787, runIf: 0 });

    // The point of the asymmetry: on a daily file most skips are `run-if`, so
    // reporting the unfiltered count would overstate by nearly 4x here. On an
    // aggregate the filter is a no-op, because the generator already ran it.
    assert.equal(totals(daily).runIf > totals(daily).skipped, true);
    assert.equal(totals(bucket).runIf, 0);
});

test('a query never sums across file families', () => {
    // `issues`, `issues-with-taskids` and the 64 buckets are three encodings
    // of the same 21 days, so adding them multiplies the population. The
    // defence is structural — every query takes one file — and this asserts
    // the encodings agree rather than compose.
    let compared = 0;
    for (let testId = 0; testId < issues.testCount; testId++) {
        const path = issues.testAt(testId).fullPath;
        const inTaskIds = issuesWithTaskIds.findTest(path);
        if (inTaskIds === null) {
            continue;
        }
        compared += 1;
        const a = computeTestStats(issues, testId);
        const b = computeTestStats(issuesWithTaskIds, inTaskIds.testId);
        // Same runs, different shapes: `counts` on one side, `task-ids` on the
        // other for the failing groups. Byte-identical totals, so the two are
        // one population encoded twice and never a pair to add together.
        assert.equal(a.runCount, b.runCount, path);
        assert.equal(a.passCount, b.passCount, path);
        assert.equal(a.failCount, b.failCount, path);
        assert.equal(a.crashCount, b.crashCount, path);
        assert.equal(a.timeoutCount, b.timeoutCount, path);
        assert.equal(a.skipCount, b.skipCount, path);
        assert.equal(a.family, 'issues');
        assert.equal(b.family, 'issues-with-taskids');
    }
    assert.equal(compared, 10, 'the two issues fixtures should share every test');
});

// --- config-stats --------------------------------------------------------

test('computeConfigStats reconciles with the test total', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const configs = computeConfigStats(bucket, identity.testId);
    const stats = computeTestStats(bucket, identity.testId);

    // The reconciliation that makes this a real check: per-config runs are
    // attributed two different ways — `durations` groups name a job, failing
    // groups go through `taskInfo` — and must still sum to the total.
    const summed = configs.reduce((sum, config) => sum + config.runCount, 0);
    assert.equal(summed, stats.runCount);
    assert.equal(
        configs.reduce((sum, config) => sum + config.failCount, 0),
        stats.failCount + stats.timeoutCount + stats.crashCount
    );

    assert.equal(configs.length, 9);
    // Sorted by descending failure rate, which is what puts a perma-fail at
    // the top rather than the config that merely runs most.
    for (let i = 1; i < configs.length; i++) {
        assert.ok(configs[i - 1]!.failRate >= configs[i]!.failRate);
    }

    // And it holds for every test in the fixture, not just the chosen one —
    // otherwise this asserts a property of one well-behaved test.
    for (let testId = 0; testId < bucket.testCount; testId++) {
        const perConfig = computeConfigStats(bucket, testId);
        const totals = computeTestStats(bucket, testId);
        const path = bucket.testAt(testId).fullPath;
        assert.equal(
            perConfig.reduce((sum, config) => sum + config.runCount, 0),
            totals.runCount,
            path
        );
        assert.equal(
            perConfig.reduce((sum, config) => sum + config.failCount, 0),
            totals.failCount + totals.timeoutCount + totals.crashCount,
            path
        );
    }
});

test('every config shares one recent window, sized by run count', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const configs = computeConfigStats(bucket, identity.testId);

    // The load-bearing property: one window for all configs, so their recent
    // rates cover the same period and are comparable. Sized by runs and not by
    // days, because weekend push volume drops several-fold.
    const widths = new Set(configs.map((config) => config.recentDays));
    assert.equal(widths.size, 1, 'all configs must share one window');
    const [windowDays] = [...widths];
    assert.equal(windowDays, 10);

    // The window is wide enough that at least one config reached the minimum,
    // which is what sized it.
    assert.ok(
        configs.some((config) => config.recentRunCount >= 20),
        'the window should be sized by a config that reached minRecentRuns'
    );
});

test('the recent window covers exactly the days it claims to', () => {
    // The off-by-one this module's own comment calls the one "most likely to
    // be simplified away", and the number `CLI.md`'s "recent (7d)" column
    // prints. `from = newestDay - windowDays + 1` is inclusive at both ends:
    // a 10-day window ending on day 20 starts at day 11, not day 10.
    //
    // The expectation is recomputed here from the entries rather than read off
    // the function, so it is evidence and not a copy of the answer. Dropping
    // the `+ 1` would widen the window to 11 days while still reporting
    // `recentDays: 10` — a wrong number that looks right, which is the failure
    // mode this project keeps warning about.
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const configs = computeConfigStats(bucket, identity.testId);
    const windowDays = configs[0]!.recentDays;
    assert.equal(windowDays, 10);

    // Independent per-day tally of everything that counts as a run.
    const perDay = new Map<number, number>();
    for (const entry of bucket.runsOfTest(identity.testId)) {
        const { kind } = classifyStatus(entry.status);
        if (kind === 'skip' || kind === 'unknown') {
            continue;
        }
        assert.notEqual(entry.day, null, 'a bucket file always carries days');
        perDay.set(entry.day!, (perDay.get(entry.day!) ?? 0) + entry.count);
    }
    const newestDay = Math.max(...perDay.keys());
    assert.equal(newestDay, 20);

    const runsSince = (from: number): number => {
        let total = 0;
        for (const [day, count] of perDay) {
            if (day >= from) {
                total += count;
            }
        }
        return total;
    };

    // Hand-checked: 637 runs fall in days 11..20, and 724 in days 10..20. The
    // gap between them is what an off-by-one silently absorbs.
    assert.equal(runsSince(newestDay - windowDays + 1), 637);
    assert.equal(runsSince(newestDay - windowDays), 724);

    const reported = configs.reduce((sum, config) => sum + config.recentRunCount, 0);
    assert.equal(reported, 637, 'the reported window must be the inclusive one');
    assert.notEqual(reported, 724, 'an 11-day window must not be reported as 10 days');

    // Per config, so the boundary is pinned on each row and not only in total.
    assert.deepEqual(
        configs.map((config) => [config.jobName, config.recentRunCount]),
        [
            ['test-windows11-64-25h2-shippable/opt-xpcshell', 26],
            ['test-windows10-64-2009-qr/debug-xpcshell', 138],
            ['test-windows10-64-2009-qr/opt-xpcshell', 120],
            ['test-windows11-64-25h2/opt-xpcshell', 109],
            ['test-windows11-64-25h2/debug-xpcshell', 150],
            ['test-windows11-64-24h2-artifact/opt-xpcshell', 25],
            ['test-windows11-64-24h2-artifact/debug-xpcshell', 25],
            ['test-windows11-64-25h2-ccov/opt-xpcshell', 23],
            ['test-windows10-64-2009-shippable-qr/opt-xpcshell', 21],
        ]
    );
});

test('a config too sparse for the minimum gets null, not zero', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    // A minimum no config can reach in the window leaves every recent rate
    // unknown — "not enough data to say" is not "0% failures".
    const configs = computeConfigStats(bucket, identity.testId, {
        minRecentRuns: 1_000_000,
    });
    assert.ok(configs.length > 0);
    for (const config of configs) {
        assert.equal(config.recentFailRate, null);
        assert.equal(config.recentSameMsgFailRate, null);
    }
    // And it did not widen the window for everyone: unreachable minimums leave
    // the default width of 1 rather than stretching to the whole file.
    assert.equal(configs[0]!.recentDays, 1);
});

test('a day range re-anchors the recent window to the filtered days', () => {
    // Worth pinning because it is easy to assume otherwise: the window is
    // derived from whatever days survived the filter and is anchored to the
    // newest of *those*, not to the newest day in the file. So `--since` and
    // `--day` narrow the recent window too rather than leaving it dangling
    // past the end of the requested range.
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const full = computeConfigStats(bucket, identity.testId);
    const sliced = computeConfigStats(bucket, identity.testId, { dayRange: { from: 0, to: 5 } });

    assert.equal(full[0]!.recentDays, 10);
    assert.equal(sliced[0]!.recentDays, 4);
    assert.ok(
        sliced.reduce((sum, config) => sum + config.runCount, 0) <
            full.reduce((sum, config) => sum + config.runCount, 0)
    );
    // The window can never exceed the slice it was derived from.
    for (const config of sliced) {
        assert.ok(config.recentDays <= 6, 'the window must fit inside the requested range');
    }
});

test('--recent-days overrides the derived window', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const configs = computeConfigStats(bucket, identity.testId, { recentDays: 3 });
    for (const config of configs) {
        assert.equal(config.recentDays, 3);
    }
});

test('same-message rates separate "fails" from "fails this way"', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const all = computeConfigStats(bucket, identity.testId);
    const failing = all.filter((config) => config.failCount > 0);
    assert.ok(failing.length > 0);

    // With no try messages supplied, nothing matches: a test that fails for
    // some other reason is not exonerated by failing at all.
    for (const config of all) {
        assert.equal(config.sameMsgFailCount, 0);
    }

    // Feeding back the messages this test actually produced makes them match,
    // which is the "this failure is pre-existing" path in `fx-tests try`.
    const messages = [...failureMessageCounts(bucket, identity.testId).keys()].filter(
        (message): message is string => message !== null
    );
    assert.ok(messages.length > 0, 'the test should have failure messages');
    const matched = computeConfigStats(bucket, identity.testId, { tryMessages: messages });
    const matchedTotal = matched.reduce((sum, config) => sum + config.sameMsgFailCount, 0);
    assert.equal(matchedTotal, computeTestStats(bucket, identity.testId).failCount);
});

test('config rows are chunk-stripped, so chunks of one config aggregate', () => {
    // The daily files keep the chunk suffix and the aggregates do not, so
    // without stripping the same configuration splits into one row per chunk
    // on one family and not on the other. On this test the raw job names
    // number 85 and the configurations 34 — a table 2.5x too long, with every
    // rate computed over a chunk's runs instead of a config's.
    const identity = daily.findTest(
        'toolkit/components/extensions/test/xpcshell/test_ext_geckoProfiler_control.js'
    )!;

    // Chunked job names, counting only entries that reach a verdict — skips
    // are not runs and `computeConfigStats` excludes configs that only ever
    // skipped, so collecting every status here would compare two different
    // populations. 85 names appear in total, 47 of them on runs.
    const rawJobNames = new Set<string>();
    const runJobNames = new Set<string>();
    for (const entry of daily.runsOfTest(identity.testId)) {
        const { kind } = classifyStatus(entry.status);
        const names: string[] = [];
        if (entry.jobName !== undefined) {
            names.push(entry.jobName);
        } else if (entry.taskIdIndexes !== undefined) {
            for (const taskIdIndex of entry.taskIdIndexes) {
                const jobName = daily.jobNameOfTaskIndex(taskIdIndex);
                if (jobName !== null) {
                    names.push(jobName);
                }
            }
        }
        for (const name of names) {
            rawJobNames.add(name);
            if (kind !== 'skip' && kind !== 'unknown') {
                runJobNames.add(name);
            }
        }
    }
    assert.equal(rawJobNames.size, 85, 'the daily file names each chunk separately');
    assert.equal(runJobNames.size, 47, '47 chunked job names actually ran this test');

    const configs = computeConfigStats(daily, identity.testId);
    assert.equal(configs.length, 34, 'chunks of one config must collapse into one row');

    // No reported row may carry a chunk suffix, and every raw name must strip
    // onto one of them — the property that makes 85 become 34.
    const reported = new Set(configs.map((config) => config.jobName));
    for (const jobName of reported) {
        assert.equal(jobName, stripChunkSuffix(jobName), jobName);
    }
    for (const raw of runJobNames) {
        assert.ok(reported.has(stripChunkSuffix(raw)), `${raw} has no config row`);
    }
    // Stripping is exactly what collapses 47 onto 34 — asserted as a set
    // identity so a stripping rule that merged too much also fails.
    assert.deepEqual(
        [...new Set([...runJobNames].map(stripChunkSuffix))].sort(),
        [...reported].sort()
    );
});

test('crashes match a try push on their signature, not on a message', () => {
    // CRASH groups carry `crashSignatureIds` and no `messageIds` at all, so
    // matching them against a try push has to read the signature. Reading
    // `message` instead would find nothing and report every crash as new —
    // the "is this crash pre-existing?" path in `fx-tests try`.
    const identity = bucket.findTest('dom/indexedDB/test/unit/test_setVersion_exclusion.js')!;
    const stats = computeTestStats(bucket, identity.testId);
    assert.equal(stats.crashCount, 10);

    const signatures = [...crashSignatureCounts(bucket, identity.testId).keys()].filter(
        (signature): signature is string => signature !== null
    );
    assert.equal(signatures.length, 1);

    const matched = computeConfigStats(bucket, identity.testId, { tryMessages: signatures });
    assert.equal(
        matched.reduce((sum, config) => sum + config.sameMsgFailCount, 0),
        10,
        'every crash with a known signature must count as the same failure'
    );

    // A signature that is not in the push matches nothing, so the count is
    // discriminating rather than always-on.
    const unmatched = computeConfigStats(bucket, identity.testId, {
        tryMessages: ['@ something_that_never_crashed'],
    });
    assert.equal(
        unmatched.reduce((sum, config) => sum + config.sameMsgFailCount, 0),
        0
    );
});

test('a configuration that has stopped running gets no recent rate', () => {
    // The feedback loop this guards. A config that retires mid-window still
    // reaches `minRecentRuns` by reaching back into the days it was alive, so
    // it stretches the shared window wide enough to contain its own death — and
    // then its old runs are "recent" by construction. Measured on
    // browser_aboutdebugging_connect_toggle_usb_devices.js, where a skip-if
    // landing on day 6 of 20 left three mac configs reporting a 15-day recent
    // rate computed entirely from runs that stopped a fortnight earlier.
    //
    // Synthetic because the shape depends on *when* a config stops relative to
    // the window, which no fixture pins down.
    const days = 21;
    const retiredDays: number[] = [];
    const liveDays: number[] = [];
    // The retired config runs 5x/day for the first six days, then never again:
    // 30 runs, enough to reach the minimum only by going 15 days back.
    for (let day = 0; day <= 5; day++) {
        for (let n = 0; n < 5; n++) {
            retiredDays.push(day);
        }
    }
    // The live config runs 5x/day throughout, so on its own it needs 4 days.
    for (let day = 0; day < days; day++) {
        for (let n = 0; n < 5; n++) {
            liveDays.push(day);
        }
    }

    const synthetic = decodeBucket({
        metadata: {
            startDate: '2026-07-14',
            endDate: '2026-08-03',
            days,
            startTime: 0,
            generatedAt: '',
            totalTestCount: 1,
            testsWithFailures: 1,
            aggregatedFrom: [],
            totalBuckets: 64,
            bucketIndex: 0,
        },
        tables: {
            jobNames: ['test-mac/opt-retired', 'test-linux/opt-live'],
            testPaths: ['a/b'],
            testNames: ['test_x.js'],
            repositories: ['mozilla-central'],
            statuses: ['PASS'],
            taskIds: [],
            messages: [],
            crashSignatures: [],
            components: ['Core :: X'],
            commitIds: ['abc'],
        },
        taskInfo: { repositoryIds: [], jobNameIds: [], commitIds: [], chunks: [] },
        testInfo: { testPathIds: [0], testNameIds: [0], componentIds: [0] },
        testRuns: [
            [
                {
                    days: [...retiredDays, ...liveDays],
                    durations: [...retiredDays, ...liveDays].map(() => [100, 100, 100]),
                    jobNameIds: [
                        ...retiredDays.map(() => 0),
                        ...liveDays.map(() => 1),
                    ],
                },
            ],
        ],
    } as unknown as BucketFile);

    const configs = computeConfigStats(synthetic, 0);
    const retired = configs.find((config) => config.jobName === 'test-mac/opt-retired')!;
    const live = configs.find((config) => config.jobName === 'test-linux/opt-live')!;

    // The retired config's runs *are* inside the stretched window — that is the
    // trap — so this is not the pre-existing "too few runs" case.
    assert.ok(
        retired.recentRunCount >= 20,
        `the window must enclose the retired config's runs: ${retired.recentRunCount}`
    );
    assert.equal(retired.recentFailRate, null, 'a retired config states no recent rate');
    assert.equal(retired.recentSameMsgFailRate, null);

    // And the config that is still running is unaffected: the fix must narrow
    // who gets a percentage, not empty the column.
    assert.notEqual(live.recentFailRate, null, 'a live config keeps its recent rate');

    // The window itself is untouched — item 12 rules out changing the sizing.
    assert.equal(retired.recentDays, live.recentDays, 'one shared window, as before');
});

test('an expected-fail is never counted as a matching failure', () => {
    // `EXPECTED-FAIL` groups in the published files carry no messages, so this
    // guard cannot be exercised from a fixture. A test annotated `fail-if`
    // that failed did what it was told, and letting its message match a try
    // push's would report an annotation working as a pre-existing failure.
    // Built by hand because the case is reachable by the format and simply
    // absent from today's data.
    const synthetic = decodeBucket({
        metadata: {
            startDate: '2026-07-14',
            endDate: '2026-08-03',
            days: 21,
            startTime: 0,
            generatedAt: '',
            totalTestCount: 1,
            testsWithFailures: 1,
            aggregatedFrom: [],
            totalBuckets: 64,
            bucketIndex: 0,
        },
        tables: {
            jobNames: ['test-linux2404-64/opt-xpcshell'],
            testPaths: ['a/b'],
            testNames: ['test_x.js'],
            repositories: ['mozilla-central'],
            statuses: ['PASS', 'EXPECTED-FAIL', 'FAIL'],
            taskIds: ['AAA.0', 'BBB.0'],
            messages: ['annotated failure', 'real failure'],
            crashSignatures: [],
            components: ['Core :: X'],
            commitIds: ['abc'],
        },
        taskInfo: {
            repositoryIds: [0, 0],
            jobNameIds: [0, 0],
            commitIds: [0, 0],
            chunks: [null, null],
        },
        testInfo: { testPathIds: [0], testNameIds: [0], componentIds: [0] },
        testRuns: [
            [
                { days: [20], durations: [[100, 100, 100]], jobNameIds: [0] },
                { days: [20], taskIdIds: [[0]], messageIds: [0] },
                { days: [20], taskIdIds: [[1]], messageIds: [1] },
            ],
        ],
    } as unknown as BucketFile);

    // Sanity: the synthetic file really does put a message on the
    // EXPECTED-FAIL group, or this test would pass vacuously.
    const statuses = new Map<string, string | null | undefined>();
    for (const entry of synthetic.runsOfTest(0)) {
        statuses.set(entry.status, entry.message);
    }
    assert.equal(statuses.get('EXPECTED-FAIL'), 'annotated failure');

    // The annotated message must not match: the run behaved as annotated.
    const annotated = computeConfigStats(synthetic, 0, { tryMessages: ['annotated failure'] });
    assert.equal(annotated[0]!.sameMsgFailCount, 0);
    // A real failure with the same shape does match, so the zero above is the
    // guard and not an inert code path.
    const real = computeConfigStats(synthetic, 0, { tryMessages: ['real failure'] });
    assert.equal(real[0]!.sameMsgFailCount, 1);

    // And `expected-fail` is not a failure: 5 runs, one of which failed.
    assert.equal(annotated[0]!.runCount, 5);
    assert.equal(annotated[0]!.failCount, 1);
});

test('timeouts and crashes match on the status, since they record no message', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const stats = computeTestStats(bucket, identity.testId);
    assert.ok(stats.timeoutCount > 0, 'the chosen test should have timeouts');

    // A timeout group carries no messageIds at all, so a message-based match
    // can never find it. `matchAnyTimeout` is what makes it matchable.
    const withoutFlag = computeConfigStats(bucket, identity.testId, { tryMessages: [] });
    const withFlag = computeConfigStats(bucket, identity.testId, {
        tryMessages: [],
        matchAnyTimeout: true,
    });
    const total = (configs: typeof withFlag): number =>
        configs.reduce((sum, config) => sum + config.sameMsgFailCount, 0);
    assert.equal(total(withoutFlag), 0);
    assert.equal(total(withFlag), stats.timeoutCount);
});

test('the issues family cannot attribute configs, and says so', () => {
    // `{harness}-issues.json` has no taskInfo and no jobNameIds: the question
    // has no answer there, which is different from "no configs failed".
    assert.equal(canAttributeConfigs(issues), false);
    assert.equal(canAttributeConfigs(bucket), true);
    assert.equal(canAttributeConfigs(issuesWithTaskIds), true);
    assert.deepEqual(computeConfigStats(issues, 0), []);
});

// --- coverage ------------------------------------------------------------

test('coverage separates ran-and-passed from ran-and-skipped', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const coverage = coverageOf(bucket, identity.testId);
    assert.equal(coverage.attributedPasses, true);

    const byState = new Map<string, number>();
    for (const config of coverage.configs) {
        byState.set(config.state, (byState.get(config.state) ?? 0) + 1);
    }
    // The states that look alike in a failure-only view, all present on one
    // test: a Windows-only crash-reporter test.
    assert.deepEqual(Object.fromEntries([...byState].sort()), {
        intermittent: 5,
        ok: 4,
        skipped: 13,
    });

    // The skipped rows carry the reason, which is what makes them actionable.
    const android = coverage.configs.find((config) => config.jobName.includes('android'));
    assert.ok(android, 'the fixture should have an android config');
    assert.equal(android.state, 'skipped');
    assert.equal(android.runCount, 0);
    assert.deepEqual([...android.skipMessages.keys()], ["os == 'android'"]);
});

test('every coverage row is a config the test itself was scheduled on', () => {
    // The property that replaced the never-scheduled universe. `--coverage`
    // reports what the data records and nothing else, so a reader can take a
    // missing platform as the answer rather than as a gap in the report.
    //
    // Checked against the test's own runs, independently of `coverageOf`: the
    // set of job names it produces must be exactly the set reachable from
    // `runsOfTest`, with no row added from anywhere else.
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const scheduled = new Set<string>();
    for (const entry of bucket.runsOfTest(identity.testId)) {
        const jobName = jobNameOfEntry(bucket, entry);
        if (jobName !== null) {
            scheduled.add(stripChunkSuffix(jobName));
        }
    }
    assert.ok(scheduled.size > 0, 'the fixture test must have runs');

    const reported = new Set(coverageOf(bucket, identity.testId).configs.map((c) => c.jobName));
    assert.deepEqual([...reported].sort(), [...scheduled].sort());

    // And the file holds configs this test never touched, so the equality
    // above is a real constraint rather than one the fixture satisfies by
    // having nothing else in it.
    const everyConfig = new Set<string>();
    for (let testId = 0; testId < bucket.testCount; testId++) {
        for (const entry of bucket.runsOfTest(testId)) {
            const jobName = jobNameOfEntry(bucket, entry);
            if (jobName !== null) {
                everyConfig.add(stripChunkSuffix(jobName));
            }
        }
    }
    assert.ok(
        everyConfig.size > reported.size,
        'the fixture must contain configs this test never ran, or the check is vacuous'
    );
});

test('coveragePlatforms separates ran from scheduled-but-skipped', () => {
    // The two cannot be folded together. A platform where every config was
    // scheduled and skipped is not covered — but it is also not a platform CI
    // declines to schedule, and only one of those is someone's `skip-if` to
    // fix.
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const coverage = coverageOf(bucket, identity.testId);
    const platforms = coveragePlatforms(coverage);

    // Every config in the matrix lands in exactly one bucket of exactly one
    // platform: the rollup may not lose or duplicate a row.
    const total = platforms.reduce(
        (sum, entry) => sum + entry.ranCount + entry.skippedCount,
        0
    );
    assert.equal(total, coverage.configs.length);

    // A Windows-only test: windows is where it ran, and the android configs
    // were scheduled and skipped rather than absent.
    const windows = platforms.find((entry) => entry.platform === 'windows')!;
    assert.ok(windows.ranCount > 0, 'it runs on windows');
    const android = platforms.find((entry) => entry.platform === 'android')!;
    assert.equal(android.ranCount, 0, 'it never ran on android');
    assert.ok(
        android.skippedCount > 0,
        'android scheduled it and skipped it, which is not the same as not scheduling it'
    );

    // The tiebreak: both platforms have 11 configs here, so only the name
    // decides, and it must be the name rather than whatever order the configs
    // happened to be visited in — which is windows-then-android.
    assert.deepEqual(
        platforms.map((entry) => `${entry.platform}:${entry.ranCount + entry.skippedCount}`),
        ['android:11', 'windows:11']
    );
});

test('the coverage rollup leads with the platform most of the test is on', () => {
    // A separate test with a separate fixture, because the Windows-only test
    // above ties on every platform and so can only exercise the tiebreak. This
    // one is scheduled on four platforms with four different counts.
    //
    // The rollup is the last thing on screen and a reader takes the top row as
    // the main story, so the order has to be the size of the answer and not the
    // order the configs were visited in. Here those differ: linux has the most
    // configs, `android` sorts first by name, and neither is the visit order.
    const identity = mochitestBucket.findTest(
        'dom/canvas/test/webgl-mochitest/test_webgl_constant_vendor_fpp.html'
    )!;
    const platforms = coveragePlatforms(coverageOf(mochitestBucket, identity.testId));
    assert.deepEqual(
        platforms.map((entry) => `${entry.platform}:${entry.ranCount + entry.skippedCount}`),
        ['linux:14', 'windows:7', 'mac:6', 'android:2']
    );
});

test('coveragePlatforms has no row for a platform with nothing scheduled', () => {
    // The whole point of dropping the universe: a platform the test is not
    // scheduled on produces no row at all, not a zero row. A reader takes the
    // absence as the answer, so a `mac 0/0` row would be noise at best and, on
    // a platform that has never existed in this data, an invention.
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const coverage = coverageOf(bucket, identity.testId);
    const platforms = coveragePlatforms(coverage);
    for (const entry of platforms) {
        assert.ok(
            entry.ranCount + entry.skippedCount > 0,
            `${entry.platform} has a row but nothing scheduled on it`
        );
    }
    // And a platform present in the file but not on this test is simply not
    // named — the file has mac configs, this Windows-only test does not.
    assert.ok(platformsInFile(bucket).has('mac'), 'the fixture file must have mac configs');
    assert.equal(
        platforms.find((entry) => entry.platform === 'mac'),
        undefined,
        'a mac row would be a claim the data does not make'
    );
});

test('platformsInFile is the platforms, not the configs', () => {
    // What replaced `configUniverse()`. The default view needs a set to
    // subtract from for its "not android" clause, and the coarse platform is
    // the widest thing the data supports: the file either has configs on a
    // platform or it does not. Configs were the level that had no boundary.
    const platforms = platformsInFile(bucket);
    assert.deepEqual([...platforms].sort(), ['android', 'linux', 'mac', 'windows']);
});

test('a job name that does not parse is not a platform called "unknown"', () => {
    // Built by hand, and the reason is worth stating: no config in any fixture,
    // and none in five real bucket files (2,663 configs), has an unparseable
    // job name — so the guard cannot be reached from recorded data and a
    // mutation removing it survived the whole suite until this existed.
    //
    // What it prevents is a sentence: `platformsInFile` feeds the default
    // view's "Runs on N configs across … — not android" clause, so an
    // `unknown` entry there becomes the CLI telling a reader the test does not
    // run on "unknown". That is a parse failure reported as a place.
    const file = decodeDaily({
        metadata: {
            date: '2026-08-03',
            startTime: 0,
            jobCount: 2,
            processedJobCount: 2,
            invalidJobCount: 0,
        },
        tables: {
            // Index 1 has no `/`, so it has no platform to speak of.
            jobNames: ['test-linux2404-64/opt-xpcshell', 'some-unparseable-name'],
            testPaths: ['a/b'],
            testNames: ['test_x.js'],
            repositories: ['mozilla-central'],
            taskIds: ['AAA.0', 'BBB.0'],
            components: ['Core :: X'],
            commitIds: ['abc'],
            statuses: ['PASS'],
            messages: [],
            crashSignatures: [],
        },
        taskInfo: { repositoryIds: [0, 0], jobNameIds: [0, 1], commitIds: [0, 0] },
        testInfo: { testPathIds: [0], testNameIds: [0], componentIds: [0] },
        testRuns: [
            [{ taskIdIds: [0, 1], durations: [1, 1], timestamps: [0, 0], messageIds: [null, null] }],
        ],
    } as unknown as DailyFile);

    assert.deepEqual([...platformsInFile(file)], ['linux']);
});

test('coverage row counts reconcile with the test totals', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const coverage = coverageOf(bucket, identity.testId);
    const stats = computeTestStats(bucket, identity.testId);
    const sum = (pick: (row: (typeof coverage.configs)[number]) => number): number =>
        coverage.configs.reduce((total, row) => total + pick(row), 0);

    assert.equal(sum((row) => row.passCount), stats.passCount);
    assert.equal(sum((row) => row.failCount), stats.failCount);
    assert.equal(sum((row) => row.timeoutCount), stats.timeoutCount);
    assert.equal(sum((row) => row.skipCount), stats.skipCount);
    assert.equal(sum((row) => row.runCount), stats.runCount);
});

test('a config that never passed is perma-fail, not intermittent', () => {
    // The highest-signal thing the matrix says: a config where the test ran
    // and *never* passed is broken there, not flaky there, and `CLI.md`'s try
    // triage keys its top section ("these are almost certainly yours") on the
    // distinction. Collapsing the two would put a perma-fail in the same
    // bucket as a 1-in-400 intermittent.
    const permaFails: { test: string; jobName: string; runCount: number }[] = [];
    let intermittent = 0;
    for (let testId = 0; testId < daily.testCount; testId++) {
        for (const config of coverageOf(daily, testId).configs) {
            if (config.state === 'perma-fail') {
                permaFails.push({
                    test: daily.testAt(testId).fullPath,
                    jobName: config.jobName,
                    runCount: config.runCount,
                });
                // The defining property: it ran, and not one run passed.
                assert.ok(config.runCount > 0);
                assert.equal(config.passCount, 0);
                assert.equal(
                    config.failCount + config.timeoutCount + config.crashCount,
                    config.runCount
                );
            }
            if (config.state === 'intermittent') {
                // The contrast: it ran, failed at least once, and passed at
                // least once.
                assert.ok(config.passCount > 0);
                assert.ok(config.failCount + config.timeoutCount + config.crashCount > 0);
                intermittent += 1;
            }
        }
    }

    // Hand-checked against the fixture. Note the failure modes differ — two
    // crashed every run, one failed, one timed out — so the state is about
    // never passing rather than about any single non-passing status.
    assert.deepEqual(permaFails, [
        {
            test: 'toolkit/components/extensions/test/xpcshell/test_ext_background_early_shutdown.js',
            jobName: 'test-linux2404-64-ccov/opt-xpcshell',
            runCount: 2,
        },
        {
            test: 'toolkit/components/extensions/test/xpcshell/test_ext_background_early_shutdown.js',
            jobName: 'test-linux2404-64-ccov/opt-xpcshell-nofis',
            runCount: 2,
        },
        {
            test: 'toolkit/components/extensions/test/xpcshell/test_ext_dnr_dynamic_rules.js',
            jobName: 'test-linux2404-64-shippable/opt-xpcshell-nofis',
            runCount: 1,
        },
        {
            test: 'toolkit/components/extensions/test/xpcshell/test_ext_downloads_cookies.js',
            jobName: 'test-windows11-32-25h2-shippable/opt-xpcshell',
            runCount: 1,
        },
    ]);
    assert.equal(intermittent, 51, 'the two states must stay distinct, not merge');
});

test('a run-if-only config reads as not-applicable, not as skipped', () => {
    // Only reachable from a daily file: the aggregates drop `run-if` skips
    // upstream, so a config that appears solely through one is invisible
    // there. Labelling it "skipped" would read as "someone disabled this
    // here", which is the opposite of what a `run-if` says.
    let notApplicable = 0;
    let skipped = 0;
    for (let testId = 0; testId < daily.testCount; testId++) {
        for (const config of coverageOf(daily, testId).configs) {
            if (config.state === 'not-applicable') {
                notApplicable += 1;
                assert.equal(config.skipCount, 0);
                assert.ok(config.runIfSkipCount > 0);
                assert.equal(config.runCount, 0);
            }
            if (config.state === 'skipped') {
                skipped += 1;
                assert.ok(config.skipCount > 0);
            }
        }
    }
    assert.equal(notApplicable, 11, 'the daily fixture has 11 run-if-only configs');
    // A concrete count, not `>= 0`: the two states have to be distinguished
    // from each other, so asserting only the interesting one would still pass
    // if every `skip-if` row were relabelled.
    assert.equal(skipped, 50, 'the daily fixture has 50 genuinely disabled configs');

    // The aggregates cannot produce the state at all, because the generator
    // already filtered those rows out — and they still have skipped rows, so
    // the absence is about `run-if` and not about skips in general.
    let aggregateSkipped = 0;
    for (let testId = 0; testId < bucket.testCount; testId++) {
        for (const config of coverageOf(bucket, testId).configs) {
            assert.notEqual(config.state, 'not-applicable');
            if (config.state === 'skipped') {
                aggregateSkipped += 1;
            }
        }
    }
    assert.equal(aggregateSkipped, 25);
});

test('a config with both a skip-if and a run-if reads as disabled', () => {
    // The precedence rule inside `stateOf`. No row in the real data has both
    // annotations at once — a config either scopes the test out or disables
    // it — so this is built by hand rather than found: it is reachable by the
    // format and would be mislabelled if the `skipCount === 0` guard were
    // dropped, reporting a disabled config as merely "scoped elsewhere".
    //
    // A `skip-if` is work someone owes and a `run-if` is the annotation
    // working, so when both are present the reportable one has to win.
    const synthetic = decodeDaily({
        metadata: {
            date: '2026-08-03',
            startTime: 0,
            generatedAt: '',
            jobCount: 1,
            processedJobCount: 1,
            invalidJobCount: 0,
        },
        tables: {
            jobNames: ['test-linux2404-64/opt-xpcshell'],
            testPaths: ['a/b'],
            testNames: ['test_x.js'],
            repositories: ['mozilla-central'],
            taskIds: ['AAA.0', 'BBB.0'],
            components: ['Core :: X'],
            commitIds: ['abc'],
            statuses: ['SKIP'],
            messages: ["skip-if: os == 'linux'", "run-if: os == 'win'"],
            crashSignatures: [],
        },
        taskInfo: { repositoryIds: [0, 0], jobNameIds: [0, 0], commitIds: [0, 0] },
        testInfo: { testPathIds: [0], testNameIds: [0], componentIds: [0] },
        testRuns: [
            [
                {
                    taskIdIds: [0, 1],
                    durations: [0, 0],
                    timestamps: [0, 0],
                    messageIds: [0, 1],
                },
            ],
        ],
    } as unknown as DailyFile);

    const [row] = coverageOf(synthetic, 0).configs;
    assert.ok(row);
    // Both annotations landed on the one config, which is what makes the
    // precedence question live rather than hypothetical.
    assert.equal(row.skipCount, 1);
    assert.equal(row.runIfSkipCount, 1);
    assert.equal(row.runCount, 0);
    assert.equal(row.state, 'skipped', 'a reportable skip outranks a run-if');

    // With the `skip-if` removed the same row is correctly not-applicable, so
    // the assertion above is about precedence and not about the state being
    // unreachable.
    const runIfOnly = decodeDaily({
        metadata: {
            date: '2026-08-03',
            startTime: 0,
            generatedAt: '',
            jobCount: 1,
            processedJobCount: 1,
            invalidJobCount: 0,
        },
        tables: {
            jobNames: ['test-linux2404-64/opt-xpcshell'],
            testPaths: ['a/b'],
            testNames: ['test_x.js'],
            repositories: ['mozilla-central'],
            taskIds: ['AAA.0'],
            components: ['Core :: X'],
            commitIds: ['abc'],
            statuses: ['SKIP'],
            messages: ["run-if: os == 'win'"],
            crashSignatures: [],
        },
        taskInfo: { repositoryIds: [0], jobNameIds: [0], commitIds: [0] },
        testInfo: { testPathIds: [0], testNameIds: [0], componentIds: [0] },
        testRuns: [[{ taskIdIds: [0], durations: [0], timestamps: [0], messageIds: [0] }]],
    } as unknown as DailyFile);
    assert.equal(coverageOf(runIfOnly, 0).configs[0]!.state, 'not-applicable');
});

test('coverage reports when a family cannot attribute passing runs', () => {
    // On the issues families the pass-like groups are `counts` with no job
    // attribution, so a coverage table there would show only failing configs —
    // exactly the partial view `--coverage` exists to replace.
    const coverage = coverageOf(issues, 0);
    assert.equal(coverage.attributedPasses, false);
    assert.deepEqual(coverage.configs, []);

    // Even `issues-with-taskids` cannot: despite the name, its pass-like
    // groups keep the `counts` shape and have no task IDs.
    assert.equal(coverageOf(issuesWithTaskIds, 0).attributedPasses, false);
});

test('platformsCovered counts only configs the test ran on', () => {
    const identity = bucket.findTest(WINDOWS_TEST)!;
    const coverage = coverageOf(bucket, identity.testId);
    const platforms = platformsCovered(coverage);
    // A Windows-only test: it runs on windows and nowhere else, even though
    // android rows exist (scheduled and skipped).
    assert.deepEqual([...platforms.keys()], ['windows']);
    assert.equal(platforms.get('windows'), 9);
});

// --- issues / skips ------------------------------------------------------

test('findIssues reports only tests with a non-passing outcome', () => {
    const rows = findIssues(bucket);
    assert.ok(rows.length > 0);
    for (const row of rows) {
        assert.ok(
            row.failCount + row.timeoutCount + row.crashCount > 0,
            `${row.fullPath} has no non-passing outcome but was reported`
        );
    }
    // Sorted by descending failure rate: rate ranks the worst tests, count
    // would rank the ones that merely run most.
    for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i - 1]!.failRate >= rows[i]!.failRate);
    }

    // Each row's totals must match the per-test query over the same file.
    for (const row of rows) {
        const stats = computeTestStats(bucket, row.testId);
        assert.equal(row.runCount, stats.runCount, row.fullPath);
        assert.equal(row.failCount, stats.failCount, row.fullPath);
        assert.equal(row.skipCount, stats.skipCount, row.fullPath);
    }
});

test('findIssues filters by path, component, type and rate', () => {
    const all = findIssues(bucket);

    const scoped = findIssues(bucket, { pathPrefix: 'dom/indexedDB' });
    assert.ok(scoped.length > 0 && scoped.length < all.length);
    for (const row of scoped) {
        assert.ok(row.fullPath.startsWith('dom/indexedDB'));
    }

    // Crashes only: every row must have one, and the set must be a subset.
    const crashesOnly = findIssues(bucket, { types: ['crash'] });
    assert.ok(crashesOnly.length > 0);
    for (const row of crashesOnly) {
        assert.ok(row.crashCount > 0);
    }
    assert.ok(crashesOnly.length <= all.length);

    // A rate threshold above everything present yields nothing rather than
    // silently ignoring the filter.
    assert.deepEqual(findIssues(bucket, { minRate: 100 }), []);

    const byComponent = findIssues(bucket, { component: 'crash reporting' });
    assert.ok(byComponent.length > 0, 'component match should be case-insensitive');
    for (const row of byComponent) {
        assert.match(row.component ?? '', /Crash Reporting/i);
    }
});

test('groupIssues aggregates rows without double-counting', () => {
    const rows = findIssues(bucket);
    const groups = groupIssues(rows, 'component');
    assert.equal(
        groups.reduce((sum, group) => sum + group.testCount, 0),
        rows.length
    );
    assert.equal(
        groups.reduce((sum, group) => sum + group.failCount, 0),
        rows.reduce((sum, row) => sum + row.failCount, 0)
    );

    const byDirectory = groupIssues(rows, 'directory');
    assert.equal(
        byDirectory.reduce((sum, group) => sum + group.testCount, 0),
        rows.length
    );
});

/**
 * A minimal file with two tests in one component: one failing, one clean.
 *
 * The checked-in fixtures all have an issue on every test, so a group's
 * denominator is the same whether or not clean tests are kept — which is
 * precisely the distinction that needs testing, and precisely what the real
 * data does exercise (a component with 396 tests of which 393 have issues).
 */
function fileWithCleanTest(): DecodedTimingFile {
    return syntheticFile([
        { fullPath: 'dom/test_broken.js', runs: [['PASS', 90], ['FAIL', 10]] },
        { fullPath: 'dom/test_clean.js', runs: [['PASS', 400]] },
    ]);
}

/** A file whose one interesting test only ever skipped, so it has no runs. */
function fileWithSkipOnlyTest(): DecodedTimingFile {
    return syntheticFile([
        { fullPath: 'dom/test_never_runs.js', runs: [['SKIP', 300]] },
        { fullPath: 'dom/test_ordinary.js', runs: [['PASS', 50], ['FAIL', 5]] },
    ]);
}

/** Builds the minimal `DecodedTimingFile` the query layer reads. */
function syntheticFile(
    tests: readonly { fullPath: string; runs: readonly (readonly [string, number])[] }[]
): DecodedTimingFile {
    const identity = (testId: number): TestIdentity => {
        const fullPath = tests[testId]!.fullPath;
        const cut = fullPath.lastIndexOf('/');
        return {
            testId,
            fullPath,
            directory: fullPath.slice(0, cut),
            name: fullPath.slice(cut + 1),
            component: 'Core :: DOM',
        };
    };
    return {
        family: 'issues',
        days: 21,
        endDate: '2026-08-03',
        statuses: [...new Set(tests.flatMap((test) => test.runs.map(([status]) => status)))],
        testCount: tests.length,
        findTest: (fullPath: string) =>
            tests.some((test) => test.fullPath === fullPath)
                ? identity(tests.findIndex((test) => test.fullPath === fullPath))
                : null,
        testAt: identity,
        *runsOfTest(testId: number) {
            for (const [status, count] of tests[testId]!.runs) {
                yield {
                    status,
                    statusId: 0,
                    count,
                    day: 0,
                    // A SKIP with no message is not a `run-if`, so it counts.
                    message: undefined,
                };
            }
        },
        totalsByStatus: (testId: number) =>
            new Map(tests[testId]!.runs.map(([status, count]) => [status, count])),
        jobOfTask: () => null,
    } as unknown as DecodedTimingFile;
}

test('keepClean gives a group the runs of its issue-free tests', () => {
    // `old/issues.html:2010` accumulates a component's `runCount` over **every**
    // test in it and only then (`:2016`) decides which to list, so a clean test
    // is in the denominator but not in the list. Dropping it first inflates the
    // rate — measured on the real file, WebExtensions :: General reported
    // 6,087,719 runs instead of 6,131,520, turning 8.7% into 8.8%.
    // Built rather than taken from a fixture: every checked-in file happens to
    // have an issue on every test, so the case this guards would be untestable
    // against them — and it is exactly the case the real data does have.
    const file = fileWithCleanTest();
    const withClean = findIssues(file, { keepClean: true });
    const withoutClean = findIssues(file);
    assert.ok(
        withClean.length > withoutClean.length,
        'the constructed file must contain at least one issue-free test'
    );
    assert.ok(
        withClean.some((row) => row.issueCount === 0),
        'keepClean must actually keep a row with no issue'
    );
    assert.ok(
        withoutClean.every((row) => row.issueCount > 0),
        'the default must still drop clean tests'
    );

    const grouped = groupIssues(withClean, 'component');
    const narrow = groupIssues(withoutClean, 'component');

    // The listed-test count is the same either way — a clean test is never
    // listed — but the run totals differ, which is the whole point.
    const byKey = new Map(narrow.map((group) => [group.key, group]));
    let sawWider = false;
    for (const group of grouped) {
        const tight = byKey.get(group.key);
        if (tight === undefined) {
            continue;
        }
        assert.equal(
            group.testCount,
            tight.testCount,
            `${group.key}: keepClean must not change how many tests have issues`
        );
        assert.ok(
            group.runCount >= tight.runCount,
            `${group.key}: keeping clean tests cannot lose runs`
        );
        if (group.runCount > tight.runCount) {
            sawWider = true;
            // A wider denominator over the same numerator is a lower rate.
            assert.ok(
                group.issueRate < tight.issueRate,
                `${group.key}: the wider denominator must lower the rate ` +
                    `(${group.issueRate} vs ${tight.issueRate})`
            );
        }
        assert.ok(
            group.totalTestCount > group.testCount ||
                group.totalTestCount === group.testCount,
            `${group.key}: totalTestCount counts every test in the group`
        );
    }
    assert.ok(sawWider, 'a clean test must widen some group denominator, or this proves nothing');

    // The "N with issues, out of M" the page prints. Without the clean test the
    // two are equal and the distinction disappears.
    const group = grouped.find((candidate) => candidate.key === 'Core :: DOM')!;
    assert.equal(group.testCount, 1, 'one of the two tests has an issue');
    assert.equal(group.totalTestCount, 2, 'both are counted in the "out of" total');
    // 10 failures over 490 runs, not over the 100 runs of the failing test.
    assert.equal(group.issueCount, 10);
    assert.equal(group.runCount, 500);
    assert.ok(
        Math.abs(group.issueRate - 2) < 1e-9,
        `10/500 is 2%, got ${group.issueRate}`
    );
});

test('a skip-only test does not report a 0% issue rate', () => {
    // The sharp case for the row-level denominator (`old/issues.html:1079`):
    // `runCount` excludes skips, so a test that only ever skipped has 0 runs.
    // Dividing by `runCount` alone gives 0/0 → 0%, reporting the healthiest
    // possible number for a test that never ran once. The real file has such
    // tests — `test_ext_unload_frame.js`, 24,826 skips and no runs.
    const file = fileWithSkipOnlyTest();
    const rows = findIssues(file);
    const skipOnly = rows.find((row) => row.fullPath === 'dom/test_never_runs.js')!;
    assert.equal(skipOnly.runCount, 0, 'runCount excludes skips');
    assert.equal(skipOnly.skipCount, 300);
    assert.equal(skipOnly.issueCount, 300);
    assert.equal(skipOnly.issueRate, 100, 'a test that only ever skipped is 100% skipped');
});

test('groupIssues rates divide by the runs the numerator could come from', () => {
    // `old/issues.html:1079` / `:2046-2048`: skips are added back to the
    // denominator exactly when they are counted in the numerator.
    const rows = findIssues(bucket, { keepClean: true });
    for (const group of groupIssues(rows, 'component')) {
        const expected =
            (group.issueCount / (group.runCount + group.skipCount)) * 100;
        assert.ok(
            Math.abs(group.issueRate - expected) < 1e-9,
            `${group.key}: ${group.issueRate} is not ${expected}`
        );
    }
    // With skips out of the union they leave the denominator too.
    const noSkips = findIssues(bucket, { keepClean: true, types: ['fail', 'timeout', 'crash'] });
    for (const group of groupIssues(noSkips, 'component', ['fail', 'timeout', 'crash'])) {
        const expected = group.runCount > 0 ? (group.issueCount / group.runCount) * 100 : 0;
        assert.ok(
            Math.abs(group.issueRate - expected) < 1e-9,
            `${group.key}: with skips off the denominator is runCount alone`
        );
    }
});

test('findSkips excludes run-if by default and includes it on request', () => {
    // On an aggregate the flag changes nothing, because the generator already
    // dropped `run-if`. On a daily file it changes the count substantially,
    // and that difference is the asymmetry itself.
    const aggregateDefault = findSkips(bucket).reduce((sum, row) => sum + row.skipCount, 0);
    const aggregateWithRunIf = findSkips(bucket, { includeRunIf: true }).reduce(
        (sum, row) => sum + row.skipCount,
        0
    );
    assert.equal(aggregateDefault, 11444);
    assert.equal(aggregateWithRunIf, 11444);

    const dailyDefault = findSkips(daily).reduce((sum, row) => sum + row.skipCount, 0);
    const dailyWithRunIf = findSkips(daily, { includeRunIf: true }).reduce(
        (sum, row) => sum + row.skipCount,
        0
    );
    assert.equal(dailyDefault, 765);
    assert.equal(dailyWithRunIf, 765 + 2147);
});

test('skip rows carry the condition and the configs', () => {
    const rows = findSkips(bucket);
    assert.ok(rows.length > 0);
    const withMessages = rows.find((row) => row.messages.size > 0);
    assert.ok(withMessages, 'some skip should record a condition');
    // The `skip-if: ` prefix is stripped for display; the condition is the
    // informative part and is the same on every message otherwise.
    for (const message of withMessages.messages.keys()) {
        assert.ok(!message.startsWith('skip-if:'), message);
    }
    // The bucket files' SKIP groups carry `jobNameIds`, so the configs are
    // known — which is what "what is turned off on Windows?" needs.
    assert.ok(withMessages.jobNames.size > 0);
});

// --- failures / crashes --------------------------------------------------

test('failures group by message and count distinct tests', () => {
    const groups = groupFailuresByMessage(bucket);
    assert.ok(groups.length > 0);

    // Every failing run in the file is in exactly one group.
    let expected = 0;
    for (let testId = 0; testId < bucket.testCount; testId++) {
        expected += computeTestStats(bucket, testId).failCount;
    }
    assert.equal(
        groups.reduce((sum, group) => sum + group.count, 0),
        expected
    );

    // Sorted by occurrences, descending.
    for (let i = 1; i < groups.length; i++) {
        assert.ok(groups[i - 1]!.count >= groups[i]!.count);
    }

    // The test-spread count is the ambient-vs-specific discriminator, and it
    // is exact even when the `tests` list is capped.
    for (const group of groups) {
        assert.ok(group.testCount >= 1);
        assert.ok(group.tests.length <= group.testCount);
        assert.equal(
            group.tests.reduce((sum, entry) => sum + entry.count, 0) <= group.count,
            true
        );
    }
});

test('maxTestsPerGroup 0 keeps every test, and testsTruncated says which it did', () => {
    // A cap of 1 forces the truncated case on any group with a spread, so both
    // states of the flag are exercised against the same fixture.
    const capped = groupFailuresByMessage(bucket, { maxTestsPerGroup: 1 });
    const uncapped = groupFailuresByMessage(bucket, { maxTestsPerGroup: 0 });
    assert.ok(capped.length > 0);
    assert.equal(capped.length, uncapped.length);

    let sawTruncation = false;
    for (const [i, group] of uncapped.entries()) {
        // The point of `0`: the array is the count, so a consumer reading one
        // cannot be short of the other.
        assert.equal(group.tests.length, group.testCount, group.message ?? '(none)');
        assert.equal(group.testsTruncated, false);

        const short = capped[i]!;
        assert.equal(short.testsTruncated, short.testCount > 1);
        if (short.testsTruncated) {
            sawTruncation = true;
            assert.equal(short.tests.length, 1);
        }
    }
    assert.ok(sawTruncation, 'the fixture must have one message across several tests');
});

test('failures filter by message substring, case-insensitively', () => {
    const all = groupFailuresByMessage(bucket);
    const first = all.find((group) => group.message !== null);
    assert.ok(first?.message);
    const needle = first.message.slice(0, 12).toUpperCase();
    const filtered = groupFailuresByMessage(bucket, { message: needle });
    assert.ok(filtered.length > 0 && filtered.length <= all.length);
    for (const group of filtered) {
        assert.match(group.message ?? '', new RegExp(escapeRegExp(needle), 'i'));
    }
});

test('crashes group by signature, not by message', () => {
    const groups = groupCrashesBySignature(bucket);
    assert.ok(groups.length > 0);

    let expected = 0;
    for (let testId = 0; testId < bucket.testCount; testId++) {
        expected += computeTestStats(bucket, testId).crashCount;
    }
    assert.equal(
        groups.reduce((sum, group) => sum + group.count, 0),
        expected
    );

    // CRASH groups carry no messageIds at all, so grouping them by message
    // would put every crash in one `(no message)` bucket. Signatures are what
    // they do carry.
    for (const group of groups) {
        assert.ok(group.signature === null || typeof group.signature === 'string');
        for (const dump of group.minidumps) {
            assert.match(dump.taskId, /^[\w-]+$/);
            assert.ok(Number.isInteger(dump.retryId) && dump.retryId >= 0);
            assert.ok(dump.minidumpId.length > 0);
        }
    }
});

test('a crash group can have occurrences and no minidump to fetch', () => {
    // Mochitest has 58 crashes whose dump was never uploaded, always the same
    // entries as the null signatures. A group with a count and an empty
    // `minidumps` is that case, not a bug.
    const groups = groupCrashesBySignature(mochitestBucket);
    for (const group of groups) {
        assert.ok(group.count > 0);
        assert.ok(group.minidumps.length <= group.count);
    }
});

// --- summary -------------------------------------------------------------

test('computeSummary compares a period against the one before it', () => {
    const summary = computeSummary(xpcshellStats);
    assert.equal(summary.harness, 'xpcshell');
    assert.equal(summary.current.dayCount, 7);
    assert.ok(summary.prior, 'the stats file reaches back far enough for a prior period');
    assert.equal(summary.prior.dayCount, 7);

    // The periods must not overlap, or the comparison compares a window with
    // itself.
    assert.ok(summary.prior.endDate < summary.current.startDate);

    // Rates are rates, and the delta is in percentage points.
    for (const rate of [
        summary.current.testFailureRate,
        summary.current.jobFailureRate,
        summary.current.skipRate,
        summary.current.invalidJobRate,
    ]) {
        assert.ok(rate !== null && rate >= 0 && rate <= 100, `implausible rate ${rate}`);
    }
    assert.equal(
        summary.delta.testFailureRate,
        summary.current.testFailureRate! - summary.prior.testFailureRate!
    );
});

test('the skip rate divides by totalTestRuns, which already contains the skips', () => {
    // `fetch-test-data.js:2733` does `totalTestRuns += runCount` *before*
    // dispatching on status, and `SKIP` is one of the branches below it — so
    // adding `skippedTestRuns` to the denominator counts every skip twice. The
    // expected value is computed from the two counters, not from `skipRate`.
    const summary = computeSummary(xpcshellStats);
    const { skippedTestRuns, totalTestRuns, skipRate } = summary.current;
    assert.equal(skipRate, (skippedTestRuns / totalTestRuns) * 100);
    assert.ok(skippedTestRuns > 0 && skippedTestRuns < totalTestRuns);
    // The old double-counting form is a strictly smaller number, so this fails
    // if it ever comes back rather than only if the rate goes out of range.
    assert.ok(skipRate! > (skippedTestRuns / (totalTestRuns + skippedTestRuns)) * 100);
    assert.ok(skipRate! <= 100);
});

test('the job failure rate divides by both branches of the fetch', () => {
    // `failedJobs` is counted over every non-ignored job of the day
    // (`fetch-test-data.js:1821`), and `processedJobCount` and `invalidJobs`
    // are the disjoint success/failure branches that population splits into
    // (`:267-282`). Dividing by `processedJobCount` alone is short by the
    // invalid jobs.
    const summary = computeSummary(xpcshellStats);
    const { failedJobs, processedJobCount, invalidJobs, jobFailureRate } = summary.current;
    assert.ok(invalidJobs > 0, 'the window must have invalid jobs for this to be a real check');
    assert.equal(jobFailureRate, (failedJobs / (processedJobCount + invalidJobs)) * 100);
    // Below the old form, which used the narrower denominator.
    assert.ok(jobFailureRate! < (failedJobs / processedJobCount) * 100);
    // The numerator is not a subtraction any more, so the rate cannot go
    // negative for any counters at all.
    assert.ok(jobFailureRate! >= 0 && jobFailureRate! <= 100);
});

test('computeSummary rejects a date the file does not have', () => {
    assert.throws(
        () => computeSummary(xpcshellStats, { endDate: '1999-01-01' }),
        /has no date 1999-01-01/
    );
    // And it honours one it does, rather than silently using the newest.
    const middle = xpcshellStats.dates[xpcshellStats.dates.length - 3]!;
    assert.equal(computeSummary(xpcshellStats, { endDate: middle }).current.endDate, middle);
});

test('a period with no prior window reports null rather than inventing one', () => {
    // A window as wide as the file leaves nothing before it. A partial prior
    // period would have a different weekday mix, so it is refused outright.
    const summary = computeSummary(xpcshellStats, { days: xpcshellStats.dates.length });
    assert.equal(summary.prior, null);
    assert.deepEqual(summary.delta, {
        testFailureRate: null,
        jobFailureRate: null,
        skipRate: null,
        invalidJobRate: null,
    });
});

test('a period with no runs reports null rates, not 0%', () => {
    // "No data" and "0% failures" are different claims, and the second is the
    // one that reads as good news. A day on which CI did not run — a closed
    // tree, an outage — produces zero denominators; none of the 199 real dates
    // in the fixture does, so the case is built rather than found.
    const empty: StatsFile = {
        metadata: { generatedAt: '', harness: 'xpcshell' },
        dates: ['2026-08-01', '2026-08-02'],
        totalTestRuns: [0, 0],
        failedTestRuns: [0, 0],
        skippedTestRuns: [0, 0],
        processedJobCount: [0, 0],
        failedJobs: [0, 0],
        ignoredJobs: [0, 0],
        invalidJobs: [0, 0],
        markerCounts: {},
    };
    const summary = computeSummary(empty, { days: 1 });
    assert.equal(summary.current.testFailureRate, null);
    assert.equal(summary.current.jobFailureRate, null);
    assert.equal(summary.current.skipRate, null);
    assert.equal(summary.current.invalidJobRate, null);
    // Explicitly not zero: `0` would print as "0.00%", which claims the tree
    // was green on a day nothing ran.
    assert.notEqual(summary.current.testFailureRate, 0);
    assert.notEqual(summary.current.jobFailureRate, 0);

    // A null on either side makes the delta unknown rather than a swing from
    // or to zero.
    assert.deepEqual(summary.delta, {
        testFailureRate: null,
        jobFailureRate: null,
        skipRate: null,
        invalidJobRate: null,
    });

    // The counters themselves are still reported, so a caller can tell an
    // empty period from a missing one.
    assert.equal(summary.current.totalTestRuns, 0);
    assert.equal(summary.current.dayCount, 1);

    // And the real file, whose denominators are all non-zero, yields numbers
    // rather than nulls — so the nulls above are the zero-denominator path and
    // not a rate that never computes.
    const real = computeSummary(xpcshellStats);
    assert.notEqual(real.current.testFailureRate, null);
    assert.notEqual(real.current.jobFailureRate, null);
});

test('marker totals come from the file, and the kinds differ by harness', () => {
    const xpcshell = markerTotals(xpcshellStats);
    const mochitest = markerTotals(mochitestStats);
    assert.ok(xpcshell.size > 0 && mochitest.size > 0);

    // `TSan Error` is mochitest-only — it comes from instrumented builds — so
    // the kind list is data and must not be hardcoded.
    assert.ok(mochitest.has('TSan Error'));
    assert.ok(!xpcshell.has('TSan Error'));

    // Sorted by descending count, so the loudest kind leads.
    const counts = [...mochitest.values()];
    for (let i = 1; i < counts.length; i++) {
        assert.ok(counts[i - 1]! >= counts[i]!);
    }
});

// --- the resolution ladder -----------------------------------------------
//
// `resolveTest` is what `fx-tests test` and `test.html` both walk, and the two
// steps under test here are the ones the CLI used to lack: the other harness at
// the same bucket index, and a unique substring match. The loaders are synthetic
// rather than the fixtures because the fixtures cannot supply the case the hole
// is about — a mochitest whose filename `detectHarness` calls xpcshell — and
// because what the fetching does on a miss is half of what is being asserted.

/**
 * Loaders over a hand-built two-harness world.
 *
 * `served` records every (harness, path) the ladder asked for, in order, which
 * is how "step 2 was not taken" is distinguished from "step 2 found nothing".
 */
function fakeLoaders(world: Record<'xpcshell' | 'mochitest', string[]>): TestLookupLoaders<null> & {
    served: string[];
    listReads: number;
} {
    const served: string[] = [];
    const state = { served, listReads: 0 };
    return {
        ...state,
        async loadBucket(harness, testPath) {
            served.push(`${harness}:${testPath}`);
            const paths = world[harness];
            const testId = paths.indexOf(testPath);
            if (testId === -1) {
                return null;
            }
            const name = testPath.split('/').pop()!;
            return {
                raw: null,
                decoded: {
                    findTest: (fullPath: string) =>
                        fullPath === testPath
                            ? {
                                  testId,
                                  fullPath: testPath,
                                  directory: testPath.slice(0, -name.length - 1),
                                  name,
                                  component: null,
                              }
                            : null,
                } as unknown as DecodedTimingFile,
            };
        },
        async loadAllTestPaths() {
            state.listReads++;
            return [...world.xpcshell, ...world.mochitest].sort();
        },
    };
}

/** A mochitest whose name `detectHarness` classifies as xpcshell. */
const MISCLASSIFIED = 'dom/base/test/test_bug1013412.js';
/** An unremarkable xpcshell path, for the steps that are about the ladder. */
const LADDER_PATH = 'dom/indexedDB/test/unit/test_rename_objectStore_errors.js';

test('a path found in the first harness reads no other file', async () => {
    const loaders = fakeLoaders({ xpcshell: [LADDER_PATH], mochitest: [] });
    const resolution = await resolveTest(LADDER_PATH, undefined, loaders);
    assert.equal(resolution.kind, 'found');
    assert.equal(loaders.served.length, 1, 'no second harness, no test list');
    assert.equal(loaders.listReads, 0);
    if (resolution.kind === 'found') {
        assert.equal(resolution.viaOtherHarness, false);
        assert.equal(resolution.resolvedFrom, null);
    }
});

test('the other harness at the same index covers detectHarness\'s hole', async () => {
    const loaders = fakeLoaders({ xpcshell: [], mochitest: [MISCLASSIFIED] });
    const resolution = await resolveTest(MISCLASSIFIED, undefined, loaders);
    assert.equal(resolution.kind, 'found');
    if (resolution.kind === 'found') {
        // The filename says xpcshell; the data says mochitest, and the flag is
        // what lets a front-end say the badge is not what was asked for.
        assert.equal(resolution.harness, 'mochitest');
        assert.equal(resolution.viaOtherHarness, true);
    }
    assert.deepEqual(loaders.served, [
        `xpcshell:${MISCLASSIFIED}`,
        `mochitest:${MISCLASSIFIED}`,
    ]);
    // Found in a bucket, so the multi-megabyte test list was never read.
    assert.equal(loaders.listReads, 0);
});

test('an explicit harness stops at that harness', async () => {
    const loaders = fakeLoaders({ xpcshell: [], mochitest: [MISCLASSIFIED] });
    const resolution = await resolveTest(MISCLASSIFIED, 'xpcshell', loaders);
    // A caller who named a harness asked about that harness: answering about
    // the other one would be the same class of wrong the ladder exists to fix.
    assert.notEqual(resolution.kind, 'found');
    assert.ok(!loaders.served.includes(`mochitest:${MISCLASSIFIED}`));
});

test('a basename with one match resolves, and says what it resolved from', async () => {
    const loaders = fakeLoaders({ xpcshell: [LADDER_PATH], mochitest: [] });
    const resolution = await resolveTest('test_rename_objectStore_errors.js', undefined, loaders);
    assert.equal(resolution.kind, 'found');
    if (resolution.kind === 'found') {
        assert.equal(resolution.testPath, LADDER_PATH);
        assert.equal(resolution.resolvedFrom, 'test_rename_objectStore_errors.js');
    }
});

test('several matches are candidates, not a resolution', async () => {
    const loaders = fakeLoaders({
        xpcshell: ['dom/a/test_one.js', 'dom/b/test_two.js'],
        mochitest: [],
    });
    const resolution = await resolveTest('dom', undefined, loaders);
    assert.equal(resolution.kind, 'ambiguous');
    if (resolution.kind === 'ambiguous') {
        assert.deepEqual(resolution.candidates, ['dom/a/test_one.js', 'dom/b/test_two.js']);
        assert.equal(resolution.total, 2);
        assert.equal(resolution.truncated, false);
    }
});

test('the candidate list is capped but the count is not', async () => {
    const many = Array.from({ length: CANDIDATE_LIMIT + 5 }, (_, i) => `dom/test_${i}.js`);
    const loaders = fakeLoaders({ xpcshell: many, mochitest: [] });
    const resolution = await resolveTest('dom/test_', undefined, loaders);
    assert.equal(resolution.kind, 'ambiguous');
    if (resolution.kind === 'ambiguous') {
        assert.equal(resolution.candidates.length, CANDIDATE_LIMIT);
        // The count is the whole point: a renderer deriving "how many more" from
        // the capped array gets zero and prints a complete-looking list. The
        // first version of this shipped with exactly that bug, because this
        // assertion was on `truncated` alone.
        assert.equal(resolution.total, CANDIDATE_LIMIT + 5);
        assert.equal(resolution.truncated, true);
    }
});

test('a unique match equal to what was typed does not claim to be a resolution', async () => {
    // Steps 1–2 miss and step 3's re-lookup hits: the stale-then-fresh shape a
    // CDN produces for real. `resolvedFrom` must stay null, or a front-end that
    // redirects on it redirects to the page it is already on.
    let firstPass = true;
    const loaders = fakeLoaders({ xpcshell: [LADDER_PATH], mochitest: [] });
    const inner = loaders.loadBucket.bind(loaders);
    loaders.loadBucket = async (harness, path) => {
        if (firstPass) {
            firstPass = false;
            return null;
        }
        return inner(harness, path);
    };
    const resolution = await resolveTest(LADDER_PATH, 'xpcshell', loaders);
    assert.equal(resolution.kind, 'found');
    if (resolution.kind === 'found') {
        assert.equal(resolution.testPath, LADDER_PATH);
        assert.equal(resolution.resolvedFrom, null);
    }
});

test('an unmatched query is unknown, and names what was searched', async () => {
    const loaders = fakeLoaders({ xpcshell: [LADDER_PATH], mochitest: [] });
    const resolution = await resolveTest('test_no_such_thing.js', undefined, loaders);
    assert.equal(resolution.kind, 'unknown');
    if (resolution.kind === 'unknown') {
        assert.deepEqual(resolution.searched, ['xpcshell', 'mochitest']);
        // Non-null: the list was read, so "nothing matches" is a checked claim.
        assert.notEqual(resolution.allTests, null);
    }
});

test('a list that cannot be read is not reported as "nothing matches"', async () => {
    const loaders = fakeLoaders({ xpcshell: [LADDER_PATH], mochitest: [] });
    loaders.loadAllTestPaths = async (): Promise<string[]> => {
        throw new Error('no list');
    };
    const resolution = await resolveTest('test_no_such_thing.js', undefined, loaders);
    assert.equal(resolution.kind, 'unknown');
    if (resolution.kind === 'unknown') {
        assert.equal(resolution.allTests, null);
    }
});

test('a path in the list but not in its bucket is neither found nor unknown', async () => {
    const loaders = fakeLoaders({ xpcshell: [], mochitest: [] });
    loaders.loadAllTestPaths = async (): Promise<string[]> => [LADDER_PATH];
    const resolution = await resolveTest(LADDER_PATH, undefined, loaders);
    // The path is real. Calling it unknown would be the false conclusion the
    // ladder exists to remove, in a rarer case.
    assert.equal(resolution.kind, 'not-in-file');
    if (resolution.kind === 'not-in-file') {
        assert.equal(resolution.testPath, LADDER_PATH);
    }
});

test('every space-separated term has to appear, in any order', () => {
    const paths = [
        'netwerk/test/unit/test_cookies_async_failure.js',
        'netwerk/test/unit/test_cookies.js',
        'dom/tests/test_async.js',
    ];
    // The rule `test.html`'s dropdown documents, and the reason a two-word
    // query is useful at all.
    assert.deepEqual(matchTestPaths(paths, 'cookies async', 50).matches, [
        'netwerk/test/unit/test_cookies_async_failure.js',
    ]);
    assert.deepEqual(matchTestPaths(paths, 'ASYNC COOKIES', 50).matches, [
        'netwerk/test/unit/test_cookies_async_failure.js',
    ]);
    // An empty query matches nothing rather than everything: `[].every()` is
    // true for every path, which would offer the whole tree.
    assert.deepEqual(matchTestPaths(paths, '   ', 50).matches, []);
});

test('the cap bounds the array without bounding the count', () => {
    const paths = ['a/test_1.js', 'a/test_2.js', 'a/test_3.js'];
    const capped = matchTestPaths(paths, 'a/test_', 2);
    assert.deepEqual(capped.matches, ['a/test_1.js', 'a/test_2.js']);
    assert.equal(capped.total, 3, 'the scan continues past the cap to count');
    assert.equal(capped.truncated, true);

    // At exactly the cap, nothing is hidden and `truncated` must not fire — an
    // off-by-one here prints "and 0 more".
    const exact = matchTestPaths(paths, 'a/test_', 3);
    assert.equal(exact.total, 3);
    assert.equal(exact.matches.length, 3);
    assert.equal(exact.truncated, false);
});

test('the path list is the union of both harnesses, sorted and deduplicated', () => {
    const source = (dirs: string[], names: string[]): TestPathsSource => ({
        tables: { testPaths: dirs, testNames: names },
        testInfo: {
            testPathIds: names.map((_, i) => Math.min(i, dirs.length - 1)),
            testNameIds: names.map((_, i) => i),
        },
    });
    const paths = collectTestPaths([
        source(['b/test'], ['test_two.js']),
        source(['a/test'], ['test_one.js']),
        // A test both harnesses record — one entry, not two.
        source(['b/test'], ['test_two.js']),
        null,
    ]);
    assert.deepEqual(paths, ['a/test/test_one.js', 'b/test/test_two.js']);
});

test('a test at the root of the tree keeps its bare name', () => {
    // `joinTestPath` gives the bare name for an empty directory, and an
    // out-of-range path id means the same thing.
    const paths = collectTestPaths([
        {
            tables: { testPaths: [''], testNames: ['test_root.js', 'test_missing_dir.js'] },
            testInfo: { testPathIds: [0, 99], testNameIds: [0, 1] },
        },
    ]);
    assert.deepEqual(paths, ['test_missing_dir.js', 'test_root.js']);
});

/** Escapes a string for use inside a RegExp. */
function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
