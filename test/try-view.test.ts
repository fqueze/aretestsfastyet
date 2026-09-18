/**
 * `try.html`'s view model, against a real pinned try push.
 *
 * ## Why this imports from `site/`
 *
 * `site/try-view.ts` is **page-local** — it names badge classes, count-cell
 * thresholds and tooltip prose, so it is the page's, not `lib/`'s. A node test
 * importing it is the point: the seam is the module boundary, not the directory.
 *
 * The import also enforces the DOM-free rule for free. The root tsconfig
 * compiles `test/**` and has **no DOM lib**, so a `document` reach from the view
 * model is a compile error here even though `tsconfig.site.json` would accept it.
 *
 * ## The fixture, and why it is what it is
 *
 * `test/fixtures/try-7d16bff81bb1.json` is try push 7d16bff81bb1, captured
 * once. Its `timings` were produced by running **the page's own profile-worker
 * source** over the 39 parseable profiles of that push's 46 failed test jobs
 * (7 were unreadable, and are recorded as such by their absence — which is
 * itself part of what `notAnalyzed` counts). Its `jobs` is the complete
 * Treeherder job list, 1,731 entries, so `jobRunCounts` is the real one.
 *
 * It is real data through the real parser, which matters for the trap this
 * project has now hit three times: **a test that feeds in the value under test
 * pins a bug as correct.** Nothing below passes a `passRate`, a `failRate` or a
 * count as a literal argument to the function that computes it. Where an
 * expected value is a literal, it was read off the fixture by a path that does
 * not go through `site/try-view.ts` — the helpers at the top of this file — and
 * the reasoning that fixes it is stated.
 *
 * ## What is not tested here
 *
 * The rendering. `site/try.ts` turns these structures into elements and nothing
 * else; asserting on that in node needs a DOM shim that is a second
 * implementation of the browser. It is verified where it runs: both pages loaded
 * in Chrome against one pinned snapshot and compared node for node
 * (`PARITY.md` §4).
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ConfigStats } from '../lib/query/config-stats.ts';
import type { TestStats } from '../lib/query/test-stats.ts';
import { bucketIndexForPath } from '../lib/formats/buckets.ts';
import { stripChunkSuffix } from '../lib/model/job-name.ts';
import {
    type FailingTest,
    type Job,
    type Timing,
    MIN_RECENT_RUNS,
    aggregateFailures,
    baseStatus,
    cleanFailureSummary,
    consoleFailures,
    countClass,
    coversAll,
    dayCount,
    extractBuildTypes,
    extractPlatform,
    extractRevision,
    extractUploadedProfileName,
    failureSummaryGroupKey,
    filterTests,
    findUploadedProfile,
    flakinessCell,
    flakinessRequests,
    flakinessTooltip,
    formatFailRate,
    formatForPrompt,
    groupRequestsByChunk,
    groupUnblamedJobs,
    hgRepoPath,
    initialSort,
    instanceMessages,
    isFailureStatus,
    isTestJob,
    needsPermanentHeader,
    nextSort,
    noFailuresText,
    parseSearch,
    phabricatorRevision,
    pickHeadlineRate,
    planRevisionList,
    pushLogUrl,
    readUrlState,
    runCountTooltip,
    runKeyOf,
    selectTryJobs,
    sortTests,
    sortedBuildTypes,
    sortedPlatforms,
    splitTables,
    summaryCards,
    tagIntermittent,
    visibleUnblamedGroups,
    writeUrlState,
} from '../site/try-view.ts';

// --- the fixture ----------------------------------------------------------

interface PushFixture {
    push: string;
    jobs: Job[];
    timings: Timing[];
}

const PUSH: PushFixture = JSON.parse(
    readFileSync(new URL('./fixtures/try-7d16bff81bb1.json', import.meta.url), 'utf8')
) as PushFixture;

/**
 * The push's derived inputs, computed the way the page computes them.
 *
 * This is setup, not an assertion: everything below asserts against numbers
 * read off `PUSH.timings` and `PUSH.jobs` directly, by `rawFailureCount` and
 * friends, never against another call of the code under test.
 */
function buildFailures(options: { allJobs?: boolean } = {}): ReturnType<typeof aggregateFailures> {
    // `selectTryJobs`, not a fourth hand-rolled partition. This helper used to
    // reproduce the filters `site/try.ts` ran, which meant the page's own tests
    // could pass while the page selected something else — the same shape of
    // hole the extraction closed between the page and the CLI, one level down.
    const { jobsToProcess, successfulJobNames, runsPerJobName } = selectTryJobs(PUSH.jobs, {
        readPassingJobs: options.allJobs === true,
    });

    // `tagIntermittent` mutates, so each call gets its own copies.
    const timings: Timing[] = PUSH.timings.map((timing) => ({ ...timing }));
    tagIntermittent(timings, { jobsToProcess, successfulJobNames });

    const globalPlatforms = new Set<string>();
    const globalBuildTypes = new Set<string>();
    for (const job of jobsToProcess) {
        globalPlatforms.add(extractPlatform(job.jobName));
        for (const buildType of extractBuildTypes(job.jobName)) {
            globalBuildTypes.add(buildType);
        }
    }
    return aggregateFailures(timings, {
        globalPlatforms,
        globalBuildTypes,
        jobRunCounts: runsPerJobName,
    });
}

const FAILURES = buildFailures();

// --- independent readings off the fixture ---------------------------------
//
// Deliberately not using anything from `site/try-view.ts`. This is the path the
// expected values are derived from: if the view model and these were both wrong
// in the same way, comparing them to each other would agree and comparing them
// to the raw fixture would not.

/** The statuses this page treats as failures, spelled out again. */
const RAW_FAILURE_STATUSES = ['FAIL', 'TIMEOUT', 'CRASH', 'ERROR', 'UNEXPECTED-PASS'];

/** Whether a raw status is a failure, by a separate rule. */
function rawIsFailure(status: string): boolean {
    const bare = status.endsWith('-PARALLEL')
        ? status.slice(0, -'-PARALLEL'.length)
        : status.endsWith('-SEQUENTIAL')
          ? status.slice(0, -'-SEQUENTIAL'.length)
          : status;
    return RAW_FAILURE_STATUSES.includes(bare);
}

/** Failing EXECUTIONS of one test path, counted straight off the fixture. */
function rawFailureCount(path: string): number {
    let count = 0;
    for (const timing of PUSH.timings) {
        if (timing.path === path && rawIsFailure(timing.status)) {
            count++;
        }
    }
    return count;
}

/** Distinct JOB RUNS in which one test path failed — the number that is NOT the sort key. */
function rawFailingJobRuns(path: string): number {
    const runs = new Set<string>();
    for (const timing of PUSH.timings) {
        if (timing.path === path && rawIsFailure(timing.status)) {
            runs.add(`${timing.taskId}.${timing.retryId}`);
        }
    }
    return runs.size;
}

/** Distinct job NAMES one test failed on. */
function rawFailingJobNames(path: string): Set<string> {
    const names = new Set<string>();
    for (const timing of PUSH.timings) {
        if (timing.path === path && rawIsFailure(timing.status)) {
            names.add(timing.jobName);
        }
    }
    return names;
}

/** Every path that failed at least once. */
function rawFailingPaths(): Set<string> {
    const paths = new Set<string>();
    for (const timing of PUSH.timings) {
        if (rawIsFailure(timing.status)) {
            paths.add(timing.path);
        }
    }
    return paths;
}

/** Completed runs of one job name, straight off the job list. */
function rawJobRuns(jobName: string): number {
    let count = 0;
    for (const job of PUSH.jobs) {
        if (
            job.jobName === jobName &&
            job.state === 'completed' &&
            (job.jobName.includes('mochitest') || job.jobName.includes('xpcshell'))
        ) {
            count++;
        }
    }
    return count;
}

/** A test row from the fixture, failing loudly if the push changed. */
function testRow(path: string): FailingTest {
    const row = FAILURES.tests.find((candidate) => candidate.path === path);
    assert.notEqual(row, undefined, `${path} is not in the pinned push any more`);
    return row!;
}

// --- the fixture is what it claims to be ---------------------------------

test('the pinned push still holds the data these tests are written against', () => {
    // Read off the fixture with the helpers above, so a re-capture that changed
    // the push fails here rather than silently rewriting every expectation.
    assert.equal(PUSH.push, 'try-7d16bff81bb1');
    assert.equal(PUSH.jobs.length, 1731);
    assert.equal(rawFailingPaths().size, 28);
    assert.equal(FAILURES.tests.length, 28);
    // Every path the raw walk found is a row, and no row was invented.
    assert.deepEqual(
        new Set(FAILURES.tests.map((t) => t.path)),
        rawFailingPaths()
    );
});

// --- status classification ------------------------------------------------

test('UNEXPECTED-PASS counts as a failure and EXPECTED-FAIL does not', () => {
    // `old/try.html:1486`. The asymmetry is the point: an annotation that stopped
    // being true is news, one that fired as intended is not.
    assert.equal(isFailureStatus('UNEXPECTED-PASS'), true);
    assert.equal(isFailureStatus('EXPECTED-FAIL'), false);
    assert.equal(isFailureStatus('PASS'), false);
    assert.equal(isFailureStatus('SKIP'), false);
    assert.equal(isFailureStatus('ERROR'), true);
    // The phase suffix is stripped before the test.
    assert.equal(isFailureStatus('FAIL-PARALLEL'), true);
    assert.equal(isFailureStatus('TIMEOUT-SEQUENTIAL'), true);
    assert.equal(isFailureStatus('PASS-PARALLEL'), false);
    // Only a TRAILING suffix, and only these two words.
    assert.equal(baseStatus('FAIL-PARALLEL-SEQUENTIAL'), 'FAIL-PARALLEL');
    assert.equal(baseStatus('CRASH-OTHER'), 'CRASH-OTHER');
});

test('every failing status in the pinned push is classified as one', () => {
    // Drives the real statuses rather than a hand-written list, so a status the
    // push contains and the rule does not know about fails here.
    const seen = new Set(PUSH.timings.map((timing) => timing.status));
    assert.ok(seen.size >= 4, `only ${seen.size} distinct statuses in the fixture`);
    for (const status of seen) {
        assert.equal(
            isFailureStatus(status),
            rawIsFailure(status),
            `${status} classified differently by the two rules`
        );
    }
});

// --- the row unit and the sort key ---------------------------------------

test('a row is one TEST PATH aggregated across the push, not a (test, config) pair', () => {
    // The framing property `PARITY.md` flags as the one a port loses silently.
    // `browser_test_panel.js` failed on THREE configurations in this push and is
    // ONE row carrying all of them; a port emitting one row per (test, config)
    // would produce the same numbers and answer a different question.
    const row = testRow('accessible/tests/browser/events/browser_test_panel.js');
    assert.equal(row.jobs.size, 3);
    assert.deepEqual(row.jobs, rawFailingJobNames(row.path));
    // One row per path, never two.
    const paths = FAILURES.tests.map((t) => t.path);
    assert.equal(new Set(paths).size, paths.length);
    // Measured on this push, so the property is not being tested on one row:
    // 10 of the 28 failing tests span more than one configuration.
    const multiConfig = FAILURES.tests.filter((t) => t.jobs.size > 1);
    assert.equal(multiConfig.length, 10);
});

test('the # column is failing EXECUTIONS, not distinct job runs', () => {
    // The user-reported CLI bug (`PARITY.md` §1): the two produce the SAME SET
    // in a different order, so no set comparison catches it. Both numbers are
    // read off the fixture independently and the row is asserted against the
    // right one — and against the wrong one being wrong.
    let differing = 0;
    for (const row of FAILURES.tests) {
        const executions = rawFailureCount(row.path);
        const jobRuns = rawFailingJobRuns(row.path);
        assert.equal(
            row.instances.length,
            executions,
            `${row.path}: instances.length should be failing executions`
        );
        if (executions !== jobRuns) {
            differing++;
        }
    }
    // If the two never differed on this push the assertion above would be
    // vacuous, so the fixture is required to contain the distinction.
    assert.ok(
        differing >= 3,
        `only ${differing} tests distinguish executions from job runs; the fixture no ` +
            'longer exercises the sort-key bug'
    );
});

test('the default sort is count descending, and count is instances.length', () => {
    const sort = initialSort();
    assert.deepEqual(sort, { column: 'count', ascending: false });

    const sorted = sortTests(FAILURES.tests, sort, () => null);
    // Descending on the INDEPENDENTLY read execution count, not on the row's own.
    const counts = sorted.map((row) => rawFailureCount(row.path));
    for (let i = 1; i < counts.length; i++) {
        assert.ok(
            counts[i - 1]! >= counts[i]!,
            `not descending at ${i}: ${counts[i - 1]} then ${counts[i]}`
        );
    }
    // And the order is NOT the one job-run counting would give. Measured on this
    // push so the assertion cannot silently become vacuous.
    const byJobRuns = [...FAILURES.tests].sort(
        (a, b) => rawFailingJobRuns(b.path) - rawFailingJobRuns(a.path)
    );
    assert.notDeepEqual(
        sorted.map((r) => r.path),
        byJobRuns.map((r) => r.path),
        'ranking by job runs happens to give the same order; the fixture no longer ' +
            'distinguishes the two sort keys'
    );
});

test("aggregateFailures pre-sorts DESCENDING, which sets the flakiness fetch priority", () => {
    // `old/try.html:1588`. Flipping this comparator to ascending used to leave the
    // whole file green, so what it actually decides had to be measured.
    //
    // NOT the table order. `sortTests` re-sorts on the same key and
    // `Array.prototype.sort` is stable (ES2019), so tie members keep their
    // input order either way and the re-sort erases the pre-sort's direction.
    //
    // Modelling that needs care: reversing `aggregateFailures`'s OUTPUT is a
    // different experiment — it reverses each tie group, which the re-sort then
    // preserves, and the table really does change (22 of 28 positions here).
    // The mutation to defend against flips the COMPARATOR, which leaves tie
    // members in `testMap` insertion order in both directions. So the ascending
    // arm is built the way the mutant would build it: re-sort the pre-sort's
    // own input by the flipped comparator.
    //
    // Measured on this fixture (28 tests, five tie groups sized 3/6/3/5/8):
    // flipping the comparator changes 0 of 28 positions in the default table.
    const counts = FAILURES.tests.map((t) => t.instances.length);
    assert.ok(
        counts.length > new Set(counts).size,
        'no two tests share an execution count; this fixture cannot exercise tie order'
    );

    // `FAILURES.tests` is the descending pre-sort's output; a stable sort of it
    // by the ascending comparator reconstructs what the mutant would return,
    // because both start from the same insertion order within each tie group.
    const mutantOrder = [...FAILURES.tests].sort(
        (a, b) => a.instances.length - b.instances.length
    );
    const table = sortTests(FAILURES.tests, initialSort(), () => null).map((t) => t.path);
    const fromMutant = sortTests(mutantOrder, initialSort(), () => null).map((t) => t.path);
    assert.deepEqual(fromMutant, table, 'the stable re-sort should erase the pre-sort direction');

    // What the direction DOES decide: the order `site/try.ts` numbers the tests
    // into `testOrder` and hands to `groupRequestsByChunk`, which is the order
    // the 3.5 MB bucket files are fetched in. Descending puts the most-failing
    // test's bucket first, so the visible top of the table fills in first.
    assert.deepEqual(
        [...counts].sort((a, b) => b - a),
        counts,
        'aggregateFailures must return the tests count-descending'
    );

    const fetchOrder = (tests: readonly FailingTest[]): string[] =>
        groupRequestsByChunk(
            flakinessRequests(tests, stripChunkSuffix),
            new Map(tests.map((test, index) => [test.path, index])),
            (path) => `bucket-${bucketIndexForPath(path)}`
        ).map(([file]) => file);

    const descending = fetchOrder(FAILURES.tests);
    const ascending = fetchOrder(mutantOrder);
    assert.ok(descending.length > 1, 'one bucket file cannot show a fetch order');
    assert.notDeepEqual(
        descending,
        ascending,
        'the pre-sort direction no longer changes the fetch order; this test is vacuous'
    );

    // Concretely: the first file fetched is the one holding the most-failing
    // test, and the mutant would fetch it last instead.
    const topTest = FAILURES.tests[0]!;
    assert.equal(topTest.instances.length, Math.max(...counts));
    assert.equal(descending[0], `bucket-${bucketIndexForPath(topTest.path)}`);
    assert.equal(ascending[ascending.length - 1], `bucket-${bucketIndexForPath(topTest.path)}`);
});

test('clicking a header toggles direction, and only "test" starts ascending', () => {
    // `old/try.html:2550`. a-to-z is what a reader wants from a path column and
    // most-first from every other one.
    assert.deepEqual(nextSort({ column: 'count', ascending: false }, 'count'), {
        column: 'count',
        ascending: true,
    });
    assert.deepEqual(nextSort({ column: 'count', ascending: false }, 'test'), {
        column: 'test',
        ascending: true,
    });
    assert.deepEqual(nextSort({ column: 'count', ascending: false }, 'status'), {
        column: 'status',
        ascending: false,
    });
    assert.deepEqual(nextSort({ column: 'count', ascending: false }, 'flakiness'), {
        column: 'flakiness',
        ascending: false,
    });
});

test('the status sort orders on the ALPHABETISED joined status set', () => {
    const sorted = sortTests(FAILURES.tests, { column: 'status', ascending: true }, () => null);
    const keys = sorted.map((row) => [...row.statuses].sort().join(','));
    for (let i = 1; i < keys.length; i++) {
        assert.ok(keys[i - 1]! <= keys[i]!, `not ascending at ${i}: ${keys[i - 1]} then ${keys[i]}`);
    }
    // Not a severity order: CRASH sorts before FAIL because C < F.
    assert.ok('CRASH,FAIL'.localeCompare('FAIL') < 0);
});

test('a test with no flakiness data sorts below every real rate, including 0%', () => {
    // `old/try.html:1753` maps a missing entry to -1.
    const known = FAILURES.tests[0]!;
    const sorted = sortTests(
        FAILURES.tests,
        { column: 'flakiness', ascending: false },
        (path) => (path === known.path ? 0 : null)
    );
    assert.equal(sorted[0]!.path, known.path, 'the 0% rate should outrank the unknowns');
});

// --- the three tables -----------------------------------------------------

test('a test is intermittent only when EVERY instance is; one permanent keeps it', () => {
    const { permanent, intermittent } = splitTables(FAILURES.tests);
    assert.equal(permanent.length + intermittent.length, FAILURES.tests.length);
    for (const row of intermittent) {
        assert.equal(row.intermittentCount, row.instances.length);
        assert.ok(row.instances.every((i) => i.intermittent === true));
    }
    for (const row of permanent) {
        assert.notEqual(row.intermittentCount, row.instances.length);
        assert.ok(
            row.instances.some((i) => i.intermittent !== true),
            `${row.path} is in the permanent table with every instance intermittent`
        );
    }
    // Both tables have rows on this push, so neither branch is vacuous.
    assert.ok(permanent.length > 0 && intermittent.length > 0);
});

test('a single permanent instance among many intermittents keeps the test permanent', () => {
    // Constructed, because the property is about the RULE rather than about this
    // push: the permanent table is the one that must not miss anything.
    const row: FailingTest = {
        ...testRow(FAILURES.tests[0]!.path),
        instances: [
            { intermittent: true } as unknown as Timing,
            { intermittent: true } as unknown as Timing,
            { intermittent: false } as unknown as Timing,
        ],
        intermittentCount: 2,
    };
    const { permanent, intermittent } = splitTables([row]);
    assert.equal(permanent.length, 1);
    assert.equal(intermittent.length, 0);
});

test('the Permanent failures heading appears only when another section follows', () => {
    // `old/try.html:1772`. It disappears when it is the only table, which is
    // surprising until stated.
    assert.equal(needsPermanentHeader(0, 0), false);
    assert.equal(needsPermanentHeader(1, 0), true);
    assert.equal(needsPermanentHeader(0, 1), true);
    assert.equal(needsPermanentHeader(3, 7), true);
});

// --- the denominators -----------------------------------------------------

test('totalJobs counts only the configs the test FAILED on', () => {
    // `old/try.html:1563`. A config where it ran and always passed is NOT in the
    // denominator — the question is "when this config ran, how often did it
    // fail", and folding in clean configs would dilute exactly that signal.
    let checked = 0;
    for (const row of FAILURES.tests) {
        const failedOn = rawFailingJobNames(row.path);
        let expected = 0;
        for (const jobName of failedOn) {
            expected += rawJobRuns(jobName);
        }
        assert.equal(row.totalJobs, expected, `${row.path}: totalJobs`);
        checked++;
    }
    assert.equal(checked, 28);
});

test('a config the test ran clean on is absent from totalJobs, measured', () => {
    // The assertion above would pass for a wrong rule if no test in the push had
    // a clean config. This shows at least one does, and that its runs are out.
    let found = 0;
    for (const row of FAILURES.tests) {
        const failedOn = rawFailingJobNames(row.path);
        const ranOn = new Set(
            PUSH.timings.filter((t) => t.path === row.path).map((t) => t.jobName)
        );
        const clean = [...ranOn].filter((name) => !failedOn.has(name));
        if (clean.length === 0) {
            continue;
        }
        found++;
        const cleanRuns = clean.reduce((sum, name) => sum + rawJobRuns(name), 0);
        assert.ok(cleanRuns > 0);
        // The clean configs' runs are not in the denominator.
        const withClean = row.totalJobs + cleanRuns;
        assert.notEqual(row.totalJobs, withClean);
    }
    assert.ok(found > 0, 'no test in the push ran clean on a config it also failed on ' +
        'elsewhere; this assertion no longer measures anything');
});

test('the outcome buckets count JOB RUNS and sum to the job total in the tooltip', () => {
    for (const row of FAILURES.tests) {
        const { failedTwice, passedOnRetry, failedOnce, passed, notAnalyzed } = row.outcomes;
        const jobs = failedTwice + passedOnRetry + failedOnce + passed + notAnalyzed;
        assert.equal(jobs, row.totalJobs, `${row.path}: buckets should sum to totalJobs`);
        // And they are NOT the failure count: the harness reruns a failing test,
        // so one job run can hold two failures.
        assert.ok(row.instances.length >= 1);
    }
    // At least one row where the two genuinely differ, so the point is live.
    const differing = FAILURES.tests.filter((row) => row.instances.length !== row.totalJobs);
    assert.ok(differing.length > 0);
});

test('the run-count tooltip states both totals in one sentence', () => {
    const row = FAILURES.tests.find((r) => r.outcomes.failedOnce > 0)!;
    const tooltip = runCountTooltip(row);
    const expectedFailures = rawFailureCount(row.path);
    assert.match(
        tooltip,
        new RegExp(
            `^Ran ${row.totalRuns} times? and failed ${expectedFailures} times?, in ` +
                `${row.totalJobs} jobs? across ${row.jobs.size} configurations?:`
        )
    );
    assert.match(tooltip, /• \d+ jobs?: failed, not retried/);
    // Only the non-zero buckets get a line.
    if (row.outcomes.passedOnRetry === 0) {
        assert.doesNotMatch(tooltip, /passed when retried/);
    }
});

test('a run the harness reran to green is bucketed as passedOnRetry, through aggregateFailures', () => {
    // The pinned push's timings contain no rerun-passing execution, so the
    // fixture-driven tests above never reach that branch of the bucketing —
    // a mutation disabling it left all 74 of them green. This drives
    // `aggregateFailures` with the shape the branch exists for, which is also
    // the shape behind the CLI's `18/18` report.
    const base = {
        path: 'a/b/test_rerun.js',
        duration: 1,
        timestamp: 0,
        allMessages: [],
        jobName: 'test-linux2404-64/opt-mochitest-browser-chrome-1',
        taskId: 'RERUN1',
        retryId: 0,
    };
    const timings: Timing[] = [
        { ...base, status: 'FAIL' },
        { ...base, status: 'PASS', isRetry: true },
    ];
    const failures = aggregateFailures(timings, {
        globalPlatforms: new Set(['linux']),
        globalBuildTypes: new Set(['opt']),
        jobRunCounts: new Map([[base.jobName, 1]]),
    });

    const row = failures.tests.find((t) => t.path === 'a/b/test_rerun.js')!;
    assert.deepEqual(row.outcomes, {
        failedTwice: 0,
        passedOnRetry: 1,
        failedOnce: 0,
        passed: 0,
        notAnalyzed: 0,
    });
    // One failing execution, one job run, and two executions of the test —
    // the three counts the tooltip keeps separate.
    assert.equal(row.instances.length, 1);
    assert.equal(row.totalJobs, 1);
    assert.equal(row.totalRuns, 2, 'FAIL plus the passing rerun');
    assert.match(runCountTooltip(row), /• 1 job: failed, then passed when retried/);
});

test('a rerun that failed again is failedTwice, and the two branches are distinguishable', () => {
    // The counterpart to the test above. Identical but for the second
    // execution's status, which is what makes the rerun branch a decision:
    // with only the passing case covered, disabling the branch changes nothing
    // observable here.
    const base = {
        path: 'a/b/test_twice.js',
        duration: 1,
        timestamp: 0,
        allMessages: [],
        jobName: 'test-linux2404-64/opt-mochitest-browser-chrome-1',
        taskId: 'TWICE1',
        retryId: 0,
    };
    const timings: Timing[] = [
        { ...base, status: 'FAIL' },
        { ...base, status: 'FAIL', isRetry: true },
    ];
    const failures = aggregateFailures(timings, {
        globalPlatforms: new Set(['linux']),
        globalBuildTypes: new Set(['opt']),
        jobRunCounts: new Map([[base.jobName, 3]]),
    });

    const row = failures.tests.find((t) => t.path === 'a/b/test_twice.js')!;
    assert.deepEqual(row.outcomes, {
        failedTwice: 1,
        passedOnRetry: 0,
        failedOnce: 0,
        passed: 0,
        // Three runs of the config on the push, one profile parsed.
        notAnalyzed: 2,
    });
    assert.equal(row.instances.length, 2, 'both executions failed');
    assert.equal(row.totalJobs, 3);
    // The three units, kept apart. `totalRuns` counts EXECUTIONS: the two
    // parsed ones, plus one for each of the two runs of this config whose
    // profile was never parsed (`old/try.html:1579`). Without that unseen term
    // it would be 2, which would say the test ran twice on a config that ran
    // three times.
    assert.equal(row.totalRuns, 4, '2 parsed executions + 2 unread runs');
    assert.match(runCountTooltip(row), /^Ran 4 times and failed 2 times, in 3 jobs across 1 /);
    assert.match(runCountTooltip(row), /• 1 job: failed, then failed again when retried/);
    assert.match(runCountTooltip(row), /• 2 jobs: not analyzed/);
});

test('a read run of a failing config that did not fail is passed, not notAnalyzed', () => {
    // The bucket only "All jobs" can reach: a run whose profile WAS parsed and
    // held no failure of this test. It is the distinction the checkbox exists
    // for — the same run is `notAnalyzed` when its profile is not fetched, and
    // reporting it as unread once it has been read would waste the fetch.
    const common = {
        path: 'a/b/test_mixed.js',
        duration: 1,
        timestamp: 0,
        allMessages: [],
        jobName: 'test-linux2404-64/opt-mochitest-browser-chrome-1',
        retryId: 0,
    };
    const timings: Timing[] = [
        { ...common, taskId: 'MIXED1', status: 'FAIL' },
        { ...common, taskId: 'MIXED2', status: 'PASS' },
    ];
    const failures = aggregateFailures(timings, {
        globalPlatforms: new Set(['linux']),
        globalBuildTypes: new Set(['opt']),
        jobRunCounts: new Map([[common.jobName, 2]]),
    });

    const row = failures.tests.find((t) => t.path === 'a/b/test_mixed.js')!;
    assert.deepEqual(row.outcomes, {
        failedTwice: 0,
        passedOnRetry: 0,
        failedOnce: 1,
        passed: 1,
        notAnalyzed: 0,
    });
    assert.match(runCountTooltip(row), /• 1 job: passed/);
});

test('singular and plural are chosen per count', () => {
    const row: FailingTest = {
        path: 'a/b/test_x.js',
        instances: [{} as Timing],
        statuses: new Set(['FAIL']),
        jobs: new Set(['j']),
        platforms: new Set(),
        buildTypes: new Set(),
        intermittentCount: 0,
        totalJobs: 1,
        totalRuns: 1,
        outcomes: { failedTwice: 0, passedOnRetry: 0, failedOnce: 1, passed: 0, notAnalyzed: 0 },
        sortedPlatforms: [],
        sortedBuildTypes: [],
    };
    assert.match(
        runCountTooltip(row),
        /^Ran 1 time and failed 1 time, in 1 job across 1 configuration:/
    );
    assert.match(runCountTooltip(row), /• 1 job: failed, not retried/);
});

// --- intermittency --------------------------------------------------------

test('a test that passed on the harness rerun is intermittent and flagged as such', () => {
    const timings: Timing[] = [
        {
            path: 'a/test_x.js',
            duration: 1,
            status: 'FAIL',
            timestamp: 1,
            allMessages: [],
            jobName: 'test-linux/opt-xpcshell',
            taskId: 'T1',
            retryId: 0,
        },
        {
            path: 'a/test_x.js',
            duration: 1,
            status: 'PASS',
            timestamp: 2,
            allMessages: [],
            isRetry: true,
            jobName: 'test-linux/opt-xpcshell',
            taskId: 'T1',
            retryId: 0,
        },
    ];
    tagIntermittent(timings, {
        jobsToProcess: [
            {
                jobId: 1,
                jobName: 'test-linux/opt-xpcshell',
                taskId: 'T1',
                retryId: 0,
                state: 'completed',
                result: 'testfailed',
            },
        ],
        successfulJobNames: new Set(),
    });
    assert.equal(timings[0]!.intermittent, true);
    assert.equal(timings[0]!.passedOnRetry, true);
    // The passing rerun itself is not a failure, so it is marked not-intermittent.
    assert.equal(timings[1]!.intermittent, false);
});

test('a successful run of the same job name makes the failure intermittent', () => {
    const timings: Timing[] = [
        {
            path: 'a/test_x.js',
            duration: 1,
            status: 'FAIL',
            timestamp: 1,
            allMessages: [],
            jobName: 'test-linux/opt-xpcshell',
            taskId: 'T1',
            retryId: 0,
        },
    ];
    tagIntermittent(timings, {
        jobsToProcess: [
            {
                jobId: 1,
                jobName: 'test-linux/opt-xpcshell',
                taskId: 'T1',
                retryId: 0,
                state: 'completed',
                result: 'testfailed',
            },
        ],
        successfulJobNames: new Set(['test-linux/opt-xpcshell']),
    });
    assert.equal(timings[0]!.intermittent, true);
});

test('a run whose profile yielded NO failures still counts as a separate run', () => {
    // The seeding at `old/try.html:1380`. Without it, case 3 cannot see the run that
    // produced nothing, and a test failing in one of two runs reads as permanent.
    const timings: Timing[] = [
        {
            path: 'a/test_x.js',
            duration: 1,
            status: 'FAIL',
            timestamp: 1,
            allMessages: [],
            jobName: 'test-linux/opt-xpcshell',
            taskId: 'T1',
            retryId: 0,
        },
    ];
    const job = (taskId: string): Job => ({
        jobId: 1,
        jobName: 'test-linux/opt-xpcshell',
        taskId,
        retryId: 0,
        state: 'completed',
        result: 'testfailed',
    });
    // T2 was processed but its profile produced no timing at all.
    tagIntermittent(timings, {
        jobsToProcess: [job('T1'), job('T2')],
        successfulJobNames: new Set(),
    });
    assert.equal(timings[0]!.intermittent, true, 'the unparseable run should make it flaky');

    // With T2 absent from jobsToProcess the same failure is permanent, which is
    // what shows the seeding is doing the work rather than something else.
    const alone: Timing[] = [{ ...timings[0]!, intermittent: undefined }];
    tagIntermittent(alone, { jobsToProcess: [job('T1')], successfulJobNames: new Set() });
    assert.equal(alone[0]!.intermittent, false);
});

test('another run failing on DIFFERENT tests makes this failure intermittent', () => {
    const mk = (path: string, taskId: string): Timing => ({
        path,
        duration: 1,
        status: 'FAIL',
        timestamp: 1,
        allMessages: [],
        jobName: 'test-linux/opt-xpcshell',
        taskId,
        retryId: 0,
    });
    const timings = [mk('a/test_x.js', 'T1'), mk('a/test_y.js', 'T2')];
    const job = (taskId: string): Job => ({
        jobId: 1,
        jobName: 'test-linux/opt-xpcshell',
        taskId,
        retryId: 0,
        state: 'completed',
        result: 'testfailed',
    });
    tagIntermittent(timings, {
        jobsToProcess: [job('T1'), job('T2')],
        successfulJobNames: new Set(),
    });
    // Each failed in one run and not in the other.
    assert.equal(timings[0]!.intermittent, true);
    assert.equal(timings[1]!.intermittent, true);

    // Both failing in both runs is permanent.
    const both = [mk('a/test_x.js', 'T1'), mk('a/test_x.js', 'T2')];
    tagIntermittent(both, {
        jobsToProcess: [job('T1'), job('T2')],
        successfulJobNames: new Set(),
    });
    assert.equal(both[0]!.intermittent, false);
    assert.equal(both[1]!.intermittent, false);
});

// --- the "All jobs" checkbox ---------------------------------------------

test('"All jobs" changes the universe that intermittency is judged against', () => {
    // `old/try.html:1342`. The checkbox adds the successful test jobs to
    // `jobsToProcess`, which is what `tagIntermittent` seeds its per-run failure
    // sets from and what the page fetches profiles for. It is not a visibility
    // toggle.
    //
    // On THIS push it changes no verdict, and the reason is worth recording
    // rather than papering over: 22 of the 28 failing tests already have a
    // wholly successful run of the same job name, so case 2 has already marked
    // them intermittent and adding 1,538 more processed jobs cannot change that.
    // What the checkbox does change here is the seeded run set — measured below.
    const withAll = buildFailures({ allJobs: true });
    assert.deepEqual(
        new Set(withAll.tests.map((t) => t.path)),
        new Set(FAILURES.tests.map((t) => t.path)),
        'the fixture holds only the failed jobs\' profiles, so no NEW failure appears'
    );

    // The seeded universe really is larger, which is the property under test —
    // and on this fixture it is the ONLY observable the checkbox moves, since
    // no profile exists for a passing job. So it is asserted directly rather
    // than left to the rows: the two filters below are written out here, not
    // taken from `selectTryJobs`, and are what the selection is checked against.
    const failedTestJobs = PUSH.jobs.filter(
        (j) => j.state === 'completed' && j.result === 'testfailed' && isTestJob(j.jobName)
    );
    const successfulTestJobs = PUSH.jobs.filter(
        (j) => j.state === 'completed' && j.result === 'success' && isTestJob(j.jobName)
    );
    assert.equal(failedTestJobs.length, 46);
    assert.equal(successfulTestJobs.length, 1538);

    assert.equal(
        selectTryJobs(PUSH.jobs, { readPassingJobs: false }).jobsToProcess.length,
        46,
        'unchecked, the page reads the failed test jobs'
    );
    assert.equal(
        selectTryJobs(PUSH.jobs, { readPassingJobs: true }).jobsToProcess.length,
        46 + 1538,
        'checked, it reads every completed test job — 34x the artifacts'
    );

    // And the rule DOES respond to the larger universe: with only one job
    // processed a failure is permanent, and with a sibling run processed it is
    // not. That is the same switch the checkbox flips, shown on data where the
    // other two intermittency cases cannot mask it.
    const mk = (taskId: string): Timing => ({
        path: 'a/test_x.js',
        duration: 1,
        status: 'FAIL',
        timestamp: 1,
        allMessages: [],
        jobName: 'test-linux/opt-xpcshell',
        taskId,
        retryId: 0,
    });
    const job = (taskId: string): Job => ({
        jobId: 1,
        jobName: 'test-linux/opt-xpcshell',
        taskId,
        retryId: 0,
        state: 'completed',
        result: 'success',
    });
    const narrow = [mk('T1')];
    tagIntermittent(narrow, { jobsToProcess: [], successfulJobNames: new Set() });
    assert.equal(narrow[0]!.intermittent, false);
    const wide = [mk('T1')];
    tagIntermittent(wide, {
        jobsToProcess: [job('T1'), job('T2')],
        successfulJobNames: new Set(),
    });
    assert.equal(wide[0]!.intermittent, true, 'the extra processed run makes it flaky');
});

// --- badges ---------------------------------------------------------------

test('build types add up rather than replacing, except that opt is the fallback', () => {
    // `old/try.html:831`. `ccov/debug` is BOTH; `asan/opt` is asan alone.
    assert.deepEqual(extractBuildTypes('test-linux2404-64-ccov/debug-xpcshell-3'), [
        'ccov',
        'debug',
    ]);
    assert.deepEqual(extractBuildTypes('test-linux2404-64-asan/opt-xpcshell-3'), ['asan']);
    assert.deepEqual(extractBuildTypes('test-linux2404-64/opt-xpcshell-3'), ['opt']);
    assert.deepEqual(extractBuildTypes('test-linux2404-64/debug-xpcshell-3'), ['debug']);
    assert.deepEqual(extractBuildTypes('test-linux2404-64-tsan/opt-xpcshell'), ['tsan']);
});

test('badge order is fixed, not alphabetical and not insertion order', () => {
    assert.deepEqual(
        sortedPlatforms(new Set(['mac', 'linux', 'unknown', 'windows'])),
        ['linux', 'windows', 'mac', 'unknown']
    );
    assert.deepEqual(sortedBuildTypes(new Set(['ccov', 'opt', 'debug'])), [
        'opt',
        'debug',
        'ccov',
    ]);
    // A value not in the order is dropped, which is upstream's filter.
    assert.deepEqual(sortedPlatforms(new Set(['bsd'])), []);
});

test('extractPlatform returns the literal "unknown", which the page groups by', () => {
    assert.equal(extractPlatform('test-linux2404-64/opt-xpcshell-3'), 'linux');
    assert.equal(extractPlatform('test-windows11-64-25h2/opt-xpcshell'), 'windows');
    assert.equal(extractPlatform('test-macosx1470-64/opt-xpcshell'), 'mac');
    assert.equal(extractPlatform('test-android-em-14-x86_64/opt-xpcshell'), 'android');
    // Not `null`: `unknown` is in PLATFORM_ORDER and becomes a badge.
    assert.equal(extractPlatform('something-else'), 'unknown');
    assert.ok(sortedPlatforms(new Set(['unknown'])).includes('unknown'));
});

test('a test failing on every configuration shows N/N instead of the badges', () => {
    // `old/try.html:1600`. Both the length AND the membership have to match, so a
    // test on two of three platforms one of which is not in the global set does
    // not read as "everywhere".
    assert.equal(coversAll(['linux', 'windows'], new Set(['linux', 'windows'])), true);
    assert.equal(coversAll(['linux'], new Set(['linux', 'windows'])), false);
    assert.equal(coversAll(['linux', 'bsd'], new Set(['linux', 'windows'])), false);
});

test('the count cell colour thresholds are 5 and 2', () => {
    assert.equal(countClass(1), 'low');
    assert.equal(countClass(2), 'medium');
    assert.equal(countClass(4), 'medium');
    assert.equal(countClass(5), 'high');
    assert.equal(countClass(99), 'high');
});

// --- the summary cards ----------------------------------------------------

test('Total Failures is the sum of failing executions, and can exceed the job count', () => {
    const cards = summaryCards(FAILURES, { totalJobs: 1731, failedJobCount: 46 });
    const byLabel = new Map(cards.map((card) => [card.label.trim(), card.value]));
    // Read independently off the fixture.
    const expectedTotal = PUSH.timings.filter((t) => rawIsFailure(t.status)).length;
    assert.equal(byLabel.get('Total Failures'), String(expectedTotal));
    assert.equal(byLabel.get('Unique Failing Tests'), String(rawFailingPaths().size));
    assert.equal(byLabel.get('Total Jobs'), '1731');
    assert.equal(byLabel.get('Failed Test Jobs'), '46');
    // Executions exceed unique tests, which is the relationship the card names.
    assert.ok(expectedTotal > rawFailingPaths().size);
});

test('the Intermittent card is omitted when the count is zero', () => {
    const withIntermittents = summaryCards(FAILURES, { totalJobs: 1, failedJobCount: 1 });
    assert.equal(withIntermittents.length, 5);
    assert.equal(withIntermittents[4]!.labelHasMitten, true);

    const none = summaryCards(
        { ...FAILURES, tests: FAILURES.tests.filter((t) => t.intermittentCount === 0) },
        { totalJobs: 1, failedJobCount: 1 }
    );
    assert.equal(none.length, 4);
});

// --- search ---------------------------------------------------------------

test('a leading ! negates, and a bare ! filters nothing', () => {
    assert.deepEqual(parseSearch('Timeout'), { term: 'timeout', negate: false });
    assert.deepEqual(parseSearch('!linux'), { term: 'linux', negate: true });
    // `old/try.html:1720` guards on a truthy term, so `!` alone shows everything.
    assert.deepEqual(parseSearch('!'), { term: '', negate: true });
    assert.equal(filterTests(FAILURES.tests, parseSearch('!')).length, FAILURES.tests.length);
});

test('search matches the path, a message, OR a job name', () => {
    const all = FAILURES.tests;
    // Path.
    const row = all.find((t) => t.path.includes('browser_sync'))!;
    assert.ok(filterTests(all, parseSearch('browser_sync')).includes(row));

    // Job name — no test path in this push contains `windows11`, so a match can
    // only have come from the job-name field.
    const byJob = filterTests(all, parseSearch('windows11'));
    assert.ok(byJob.length > 0);
    for (const match of byJob) {
        assert.ok(
            !match.path.toLowerCase().includes('windows11'),
            'the path itself matched, so this does not test the job-name field'
        );
        assert.ok(match.instances.some((i) => i.jobName.includes('windows11')));
    }

    // Message: pick a real message substring off the fixture.
    const withMessage = all.find(
        (t) => t.instances.some((i) => (i.message ?? '').length > 20)
    )!;
    const message = withMessage.instances.find((i) => (i.message ?? '').length > 20)!.message!;
    const fragment = message.slice(0, 20).toLowerCase();
    assert.ok(filterTests(all, parseSearch(fragment)).includes(withMessage));
});

test('negation is the exact complement of the positive filter', () => {
    for (const term of ['timeout', 'browser', 'windows11', 'zzz-no-such-thing']) {
        const yes = new Set(filterTests(FAILURES.tests, parseSearch(term)).map((t) => t.path));
        const no = new Set(filterTests(FAILURES.tests, parseSearch(`!${term}`)).map((t) => t.path));
        assert.equal(yes.size + no.size, FAILURES.tests.length, `${term}: not a partition`);
        for (const path of yes) {
            assert.ok(!no.has(path), `${term}: ${path} is in both halves`);
        }
    }
});

// --- flakiness ------------------------------------------------------------

/**
 * A `ConfigStats` built from raw counts, never from a rate.
 *
 * The rates are computed here the way `lib/query/config-stats.ts` computes them,
 * from `(fails, runs)` pairs given as literals — so a test asserting on
 * `pickHeadlineRate`'s choice is driven by counts end to end rather than being
 * handed the percentage it is supposed to derive.
 */
function config(
    jobName: string,
    counts: {
        runs: number;
        fails: number;
        sameMsg: number;
        recentRuns?: number;
        recentSameMsg?: number;
        recentDays?: number;
    }
): ConfigStats {
    const { runs, fails, sameMsg } = counts;
    const hasRecent = counts.recentRuns !== undefined;
    const recentRuns = counts.recentRuns ?? 0;
    return {
        jobName,
        runCount: runs,
        failCount: fails,
        failRate: runs > 0 ? (fails / runs) * 100 : 0,
        sameMsgFailCount: sameMsg,
        sameMsgFailRate: runs > 0 ? (sameMsg / runs) * 100 : 0,
        recentDays: counts.recentDays ?? 7,
        recentRunCount: recentRuns,
        recentFailRate: hasRecent && recentRuns > 0 ? 0 : null,
        recentSameMsgFailRate:
            hasRecent && recentRuns > 0 ? ((counts.recentSameMsg ?? 0) / recentRuns) * 100 : null,
    };
}

/** A `TestStats` from raw counts. */
function stats(counts: {
    runs: number;
    fails?: number;
    crashes?: number;
    timeouts?: number;
}): TestStats {
    const fails = counts.fails ?? 0;
    const crashes = counts.crashes ?? 0;
    const timeouts = counts.timeouts ?? 0;
    const passes = counts.runs - fails - crashes - timeouts;
    return {
        family: 'bucket',
        runCount: counts.runs,
        passCount: passes,
        failCount: fails,
        timeoutCount: timeouts,
        crashCount: crashes,
        expectedFailCount: 0,
        unknownCount: 0,
        skipCount: 0,
        runIfSkipCount: 0,
        passRate: counts.runs > 0 ? (passes / counts.runs) * 100 : null,
    };
}

test('the headline rate is an argmax on rate - 100/sqrt(runs), not on the raw rate', () => {
    // The whole point of the penalty: a config with few runs that happened to
    // land higher must not beat one with many. Driven from COUNTS.
    //
    //   A: 12 of 100 recent runs = 12.0%, score 12.0 - 100/10   =  2.0
    //   B: 90 of 900 recent runs = 10.0%, score 10.0 - 100/30   =  6.67
    //
    // The raw-rate argmax picks A; the lower-bound argmax picks B.
    const configs = [
        config('few-runs', { runs: 100, fails: 12, sameMsg: 12, recentRuns: 100, recentSameMsg: 12 }),
        config('many-runs', { runs: 900, fails: 90, sameMsg: 90, recentRuns: 900, recentSameMsg: 90 }),
    ];
    assert.equal(configs[0]!.recentSameMsgFailRate, 12);
    assert.equal(configs[1]!.recentSameMsgFailRate, 10);

    const headline = pickHeadlineRate(stats({ runs: 1000, fails: 102 }), configs);
    assert.equal(headline.jobName, 'many-runs');
    assert.equal(headline.scope, 'config');
    assert.equal(headline.rate, 10);
    // …and the raw-rate winner really is the other one, so the test is live.
    const rawWinner = [...configs].sort(
        (a, b) => b.recentSameMsgFailRate! - a.recentSameMsgFailRate!
    )[0]!;
    assert.equal(rawWinner.jobName, 'few-runs');
});

test('a config with zero runs scores 0, not -Infinity', () => {
    // `old/try.html:2776`'s `r.runs > 0 ? … : 0`. A 0-run config must beat a config
    // with a genuinely negative score — a low rate over few runs.
    const configs = [
        // 1 of 40 runs = 2.5%, score 2.5 - 100/sqrt(40) = -13.3
        config('low-and-sparse', { runs: 40, fails: 1, sameMsg: 1 }),
        config('no-runs', { runs: 0, fails: 0, sameMsg: 0 }),
    ];
    const headline = pickHeadlineRate(stats({ runs: 41, fails: 1 }), configs);
    // The 0-run config wins the argmax with score 0 — and then its rate is 0, so
    // the `best.rate === 0` fallback fires and the scope becomes overall.
    assert.equal(headline.scope, 'overall');
});

test('a 0% winner falls back to the overall rate and changes what the column means', () => {
    // `old/try.html:2788`. When no config shows the same failure, the column stops
    // answering "does this exact failure pre-exist" and answers "how flaky is
    // this test at all".
    const configs = [config('clean', { runs: 500, fails: 40, sameMsg: 0 })];
    // 40 failures of 500 runs = 8.0% overall, 0% same-message.
    const headline = pickHeadlineRate(stats({ runs: 500, fails: 40 }), configs);
    assert.equal(headline.scope, 'overall');
    assert.equal(headline.rate, 8);
    assert.equal(headline.runs, 500);
    assert.equal(headline.jobName, undefined);
});

test('the overall rate counts fails, crashes and timeouts over runs', () => {
    // `old/try.html:2767`. Three numerators, one denominator, and the denominator is
    // runCount — which excludes skips.
    const headline = pickHeadlineRate(
        stats({ runs: 200, fails: 10, crashes: 3, timeouts: 7 }),
        []
    );
    assert.equal(headline.scope, 'overall');
    assert.equal(headline.rate, 10); // (10 + 3 + 7) / 200 * 100
});

test('lowConfidence marks a rate resting on fewer than MIN_RECENT_RUNS runs', () => {
    assert.equal(MIN_RECENT_RUNS, 100);
    const few = pickHeadlineRate(stats({ runs: 60, fails: 6 }), [
        config('sparse', { runs: 60, fails: 6, sameMsg: 6 }),
    ]);
    assert.equal(few.lowConfidence, true);
    assert.equal(few.runs, 60);

    const many = pickHeadlineRate(stats({ runs: 600, fails: 60 }), [
        config('dense', { runs: 600, fails: 60, sameMsg: 60 }),
    ]);
    assert.equal(many.lowConfidence, false);
});

test('a recent window is preferred over the full history when it exists', () => {
    const withRecent = config('c', {
        runs: 1000,
        fails: 500,
        sameMsg: 500, // 50% over the whole window
        recentRuns: 200,
        recentSameMsg: 20, // 10% recently
        recentDays: 5,
    });
    const headline = pickHeadlineRate(stats({ runs: 1000, fails: 500 }), [withRecent]);
    assert.equal(headline.rate, 10, 'the recent window should win');
    assert.equal(headline.recent, true);
    assert.equal(headline.days, 5);

    const noRecent = config('c', { runs: 1000, fails: 500, sameMsg: 500 });
    assert.equal(noRecent.recentSameMsgFailRate, null);
    const fallback = pickHeadlineRate(stats({ runs: 1000, fails: 500 }), [noRecent]);
    assert.equal(fallback.rate, 50);
    assert.equal(fallback.recent, false);
});

/**
 * `(fails, runs)` pairs where rounding once and rounding twice DISAGREE.
 *
 * The previous version of the rounding test conceded in its own comment that
 * its chosen values "both give 0.1 here", i.e. that it could not fail for the
 * reason it existed — and a mutation to
 * `Number(rate.toFixed(2)).toFixed(1)` left the whole file green. These pairs
 * are the fix: for each, `x/n*100` sits just under a `.x5` boundary, so one
 * round goes down and an intermediate round to two decimals pushes it up
 * (or vice versa).
 *
 * All are small enough to occur in real 21-day aggregates; the run counts are
 * the kind a single configuration reports, not synthetic round numbers.
 */
const ROUNDING_CASES: { fails: number; runs: number; once: string; twice: string }[] = [
    // 3.846153…% — one round 3.8, two rounds 3.85 -> 3.9.
    { fails: 1, runs: 26, once: '3.8%', twice: '3.9%' },
    // 46.153846…% — one round 46.2, two rounds 46.15 -> 46.1 (banker-ish
    // float: 46.15 is stored just below and toFixed(1) drops it).
    { fails: 6, runs: 13, once: '46.2%', twice: '46.1%' },
    // 53.846153…% — the mirror, going the other way: 53.8 vs 53.9.
    { fails: 7, runs: 13, once: '53.8%', twice: '53.9%' },
    // 82.352941…% — 82.4 vs 82.3.
    { fails: 14, runs: 17, once: '82.4%', twice: '82.3%' },
    // 19.047619…% — 19.0 vs 19.1.
    { fails: 4, runs: 21, once: '19.0%', twice: '19.1%' },
];

test('a percentage is rounded ONCE from the raw ratio, to one decimal', () => {
    assert.equal(formatFailRate(0), '0.0%');
    assert.equal(formatFailRate(100), '100.0%');

    for (const { fails, runs, once, twice } of ROUNDING_CASES) {
        const rate = (fails / runs) * 100;
        // The premise: these two implementations really do differ here. If a
        // refactor ever makes this assertion fail, the case has stopped
        // defending anything and must be replaced, not deleted.
        assert.notEqual(
            once,
            twice,
            `${fails}/${runs} no longer separates single from double rounding`
        );
        assert.equal(`${Number(rate.toFixed(2)).toFixed(1)}%`, twice, 'double-round reference');

        // And the code under test must produce the single-round answer.
        assert.equal(
            formatFailRate(rate),
            once,
            `${fails} of ${runs} must print ${once}, not ${twice}`
        );
    }
});

test('the rate reaching the formatter is the raw ratio, not a pre-rounded one', () => {
    // Driving real counts through the whole chain, because a pre-round could
    // live in `pickHeadlineRate` or in `ConfigStats` rather than in the format.
    for (const { fails, runs, once, twice } of ROUNDING_CASES) {
        const c = config('c', { runs, fails, sameMsg: fails });
        assert.equal(c.sameMsgFailRate, (fails / runs) * 100, 'ConfigStats must not round');

        const headline = pickHeadlineRate(stats({ runs, fails }), [c]);
        assert.equal(headline.rate, (fails / runs) * 100, 'the headline must be the raw ratio');
        assert.equal(formatFailRate(headline.rate), once, `expected ${once}, not ${twice}`);
    }
});

test('the flakiness CELL prints the single-rounded rate', () => {
    // The cell is where a reader actually sees the digit, and it reaches
    // `formatFailRate` by a different path than the tooltip does.
    for (const { fails, runs, once, twice } of ROUNDING_CASES) {
        const cell = flakinessCell({
            stats: stats({ runs, fails }),
            hasMatchingMessage: true,
            configs: [config('c', { runs, fails, sameMsg: fails })],
            totalDays: 21,
        })!;
        assert.equal(cell.text, once, `the cell must show ${once}, not ${twice}`);
    }
});

test('every percentage in the TOOLTIP is single-rounded too', () => {
    // Three more `formatFailRate` call sites: the headline line, each
    // per-configuration line, and the closing all-failure line. Each gets
    // counts that separate the two implementations, and they are DIFFERENT
    // counts so one shared value cannot satisfy all three by accident.
    //
    //   headline / per-config job-a: 14 of 17 = 82.352941…%  -> 82.4, not 82.3
    //   per-config job-b:             1 of 26 =  3.846153…%  ->  3.8, not  3.9
    //   all-failure floor:            4 of 21 = 19.047619…%  -> 19.0, not 19.1
    const configs = [
        config('job-a', { runs: 17, fails: 14, sameMsg: 14 }),
        config('job-b', { runs: 26, fails: 1, sameMsg: 1 }),
    ];
    const s = stats({ runs: 21, fails: 4 });
    const headline = pickHeadlineRate(s, configs);
    assert.equal(headline.jobName, 'job-a');
    assert.equal(headline.rate, (14 / 17) * 100);

    const lines = flakinessTooltip(s, configs, headline, true, 21).split('\n');

    const headlineLine = lines.find((line) => line.startsWith('It fails this way'))!;
    assert.match(headlineLine, /82\.4% of the time/, 'headline: 82.4, not 82.3');

    const listStart = lines.findIndex((line) => line.startsWith('Same failure over'));
    assert.equal(lines[listStart + 1], '  82.4% of 17 runs — job-a');
    assert.equal(lines[listStart + 2], '  3.8% of 26 runs — job-b');

    assert.equal(
        lines[lines.length - 1],
        'Any failure, all platforms, 21 days: 19.0% of 21 runs.',
        'the all-failure floor: 19.0, not 19.1'
    );
});

test('the flakiness cell shows a warning glyph, not 0.0%, for a never-failing test', () => {
    // `old/try.html:2864`. "This test has never failed in 21 days" is the strongest
    // possible answer to "is this pre-existing", and 0.0% next to 18.1% would
    // bury it.
    const cell = flakinessCell({
        stats: stats({ runs: 5000 }),
        hasMatchingMessage: false,
        configs: [],
        totalDays: 21,
    })!;
    assert.equal(cell.isNewWarning, true);
    assert.equal(cell.text, '⚠️');
    assert.equal(cell.className, 'flakiness-cell flaky-new');
    assert.equal(cell.tooltip, '5000 runs, 100% pass rate over 21 days — this failure is new');
});

test('the cell class distinguishes a matching message from a merely flaky test', () => {
    const configs = [config('c', { runs: 500, fails: 50, sameMsg: 50 })];
    const matching = flakinessCell({
        stats: stats({ runs: 500, fails: 50 }),
        hasMatchingMessage: true,
        configs,
        totalDays: 21,
    })!;
    assert.equal(matching.className, 'flakiness-cell flaky-msg');
    assert.equal(matching.hasMitten, true);

    const notMatching = flakinessCell({
        stats: stats({ runs: 500, fails: 50 }),
        hasMatchingMessage: false,
        configs,
        totalDays: 21,
    })!;
    assert.equal(notMatching.className, 'flakiness-cell flaky');
    assert.equal(notMatching.hasMitten, false);

    // And low confidence appends a third class.
    const sparse = flakinessCell({
        stats: stats({ runs: 50, fails: 5 }),
        hasMatchingMessage: true,
        configs: [config('c', { runs: 50, fails: 5, sameMsg: 5 })],
        totalDays: 21,
    })!;
    assert.equal(sparse.className, 'flakiness-cell flaky-msg flaky-few-runs');
});

test('a test with no history at all gets a blanked cell, not a zero', () => {
    assert.equal(flakinessCell(null), null);
});

test('the tooltip leads with the verdict and ends with the all-failure rate', () => {
    const configs = [
        config('job-a', { runs: 400, fails: 40, sameMsg: 40, recentRuns: 200, recentSameMsg: 30, recentDays: 6 }),
        config('job-b', { runs: 400, fails: 20, sameMsg: 20, recentRuns: 200, recentSameMsg: 10, recentDays: 6 }),
    ];
    const s = stats({ runs: 1000, fails: 60 });
    const headline = pickHeadlineRate(s, configs);
    const tooltip = flakinessTooltip(s, configs, headline, true, 21);
    const lines = tooltip.split('\n');
    assert.equal(lines[0], 'This failure already happens without your changes.');
    assert.equal(
        lines[lines.length - 1],
        'Any failure, all platforms, 21 days: 6.0% of 1000 runs.'
    );
    // Most-failing first, and only configs that show the failure.
    const listStart = lines.findIndex((line) => line.startsWith('Same failure over'));
    assert.ok(listStart > 0);
    assert.equal(lines[listStart], 'Same failure over the last 6 days, by configuration:');
    assert.equal(lines[listStart + 1], '  15.0% of 200 runs — job-a');
    assert.equal(lines[listStart + 2], '  5.0% of 200 runs — job-b');

    const isNew = flakinessTooltip(s, configs, headline, false, 21);
    assert.match(isNew, /^This exact failure was never seen in history — it looks new\./);
});

test('the tooltip caps the config list and says how many it hid', () => {
    const configs = Array.from({ length: 7 }, (_, i) =>
        config(`job-${i}`, {
            runs: 400,
            fails: 40 - i,
            sameMsg: 40 - i,
            recentRuns: 200,
            recentSameMsg: 40 - i,
            recentDays: 6,
        })
    );
    const s = stats({ runs: 1000, fails: 200 });
    const tooltip = flakinessTooltip(s, configs, pickHeadlineRate(s, configs), true, 21);
    const rows = tooltip.split('\n').filter((line) => line.startsWith('  ') && line.includes('—'));
    assert.equal(rows.length, 4);
    assert.match(tooltip, /and 3 more configurations/);

    // Exactly one hidden gets the singular.
    const five = configs.slice(0, 5);
    const t5 = flakinessTooltip(s, five, pickHeadlineRate(s, five), true, 21);
    assert.match(t5, /and 1 more configuration$/m);
});

test('the tooltip drops the config section entirely when nothing shows the failure', () => {
    const configs = [config('clean', { runs: 500, fails: 50, sameMsg: 0 })];
    const s = stats({ runs: 500, fails: 50 });
    const tooltip = flakinessTooltip(s, configs, pickHeadlineRate(s, configs), false, 21);
    assert.doesNotMatch(tooltip, /by configuration/);
    // And no double blank line where the section would have been.
    assert.doesNotMatch(tooltip, /\n\n\n/);
});

test('dayCount says "the last day" for one', () => {
    assert.equal(dayCount(1), 'the last day');
    assert.equal(dayCount(7), 'the last 7 days');
    assert.equal(dayCount(undefined), 'the last undefined days');
});

// --- the flakiness worker's plan -----------------------------------------

test('the worker is asked about chunk-STRIPPED job names', () => {
    // The 21-day aggregates store job names stripped and a push's do not, so
    // without this every configuration would miss and the column would be empty.
    const requests = flakinessRequests(FAILURES.tests, stripChunkSuffix);
    assert.equal(requests.length, FAILURES.tests.length);
    let stripped = 0;
    for (const request of requests) {
        for (const jobName of request.jobNames) {
            assert.equal(stripChunkSuffix(jobName), jobName, 'already stripped');
            assert.doesNotMatch(jobName.split('/').pop()!, /-\d+$/);
        }
        // The raw names this test failed on, for comparison.
        const raw = rawFailingJobNames(request.path);
        if ([...raw].some((name) => /-\d+$/.test(name.split('/').pop()!))) {
            stripped++;
        }
    }
    assert.ok(stripped > 0, 'no job name in the push carried a chunk suffix; the strip is ' +
        'not being exercised');
});

test('the request carries the push messages, and the timeout/crash kind flags', () => {
    const requests = flakinessRequests(FAILURES.tests, stripChunkSuffix);
    const byPath = new Map(requests.map((request) => [request.path, request]));
    for (const row of FAILURES.tests) {
        const request = byPath.get(row.path)!;
        // Every message and signature the push saw, deduplicated. Read
        // independently off the fixture rather than off the row.
        const expected = new Set<string>();
        let hasTimeout = false;
        let hasCrash = false;
        for (const timing of PUSH.timings) {
            if (timing.path !== row.path || !rawIsFailure(timing.status)) {
                continue;
            }
            if (timing.message) {
                expected.add(timing.message);
            }
            if (timing.crashSignature) {
                expected.add(timing.crashSignature);
            }
            if (timing.status.startsWith('TIMEOUT')) {
                hasTimeout = true;
            }
            if (timing.status.startsWith('CRASH')) {
                hasCrash = true;
            }
        }
        assert.deepEqual(new Set(request.tryMessages), expected, row.path);
        assert.equal(request.hasTimeout, hasTimeout, row.path);
        assert.equal(request.hasCrash, hasCrash, row.path);
    }
    // The flags fire somewhere on this push, so the assertion is not vacuous.
    assert.ok(requests.some((r) => r.hasTimeout));
});

test('bucket files are read in the order their best test appears in the table', () => {
    // `old/try.html:2667`. The visible top of the table fills in first; reading in
    // hash order would fill it in a random-looking sequence.
    const requests = [
        { path: 'z', tryMessages: [], hasTimeout: false, hasCrash: false, jobNames: [] },
        { path: 'a', tryMessages: [], hasTimeout: false, hasCrash: false, jobNames: [] },
        { path: 'm', tryMessages: [], hasTimeout: false, hasCrash: false, jobNames: [] },
    ];
    // 'a' is last in the table, 'z' first.
    const order = new Map([
        ['z', 0],
        ['m', 1],
        ['a', 2],
    ]);
    // 'a' and 'z' share a file; 'm' has its own.
    const fileOf = (path: string): string => (path === 'm' ? 'file-b' : 'file-a');
    const grouped = groupRequestsByChunk(requests, order, fileOf);
    // file-a's best test is 'z' at position 0, so it comes first.
    assert.deepEqual(grouped.map(([file]) => file), ['file-a', 'file-b']);
});

// --- unblamed jobs --------------------------------------------------------

test('"exit status N" is dropped unless it is the only line', () => {
    assert.deepEqual(
        cleanFailureSummary(['[taskcluster:error] exit status 1']),
        ['[taskcluster:error] exit status 1']
    );
    assert.deepEqual(
        cleanFailureSummary(['real failure', '[taskcluster:error] exit status 1']),
        ['real failure']
    );
});

test('everything between "Aborting task" and "task aborted" is dropped, bookends kept', () => {
    assert.deepEqual(
        cleanFailureSummary([
            'before',
            '[taskcluster:error] Aborting task because of maxRunTime',
            'noise 1',
            'noise 2',
            '[taskcluster:error] task aborted',
            'after',
        ]),
        [
            'before',
            '[taskcluster:error] Aborting task because of maxRunTime',
            '[taskcluster:error] task aborted',
            'after',
        ]
    );
});

test('crash UUIDs are stripped so identical signatures group into one row', () => {
    const a = ['PROCESS-CRASH | 11111111-2222-3333-4444-555555555555 | boom in Foo::Bar'];
    const b = ['PROCESS-CRASH | aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee | boom in Foo::Bar'];
    assert.equal(failureSummaryGroupKey(a), failureSummaryGroupKey(b));
    assert.equal(failureSummaryGroupKey(a), 'PROCESS-CRASH | boom in Foo::Bar');
    // A different signature stays a different group.
    const c = ['PROCESS-CRASH | 11111111-2222-3333-4444-555555555555 | boom in Baz::Qux'];
    assert.notEqual(failureSummaryGroupKey(a), failureSummaryGroupKey(c));
});

test('unblamed groups are ordered by job count descending, and that is not configurable', () => {
    const job = (name: string): Job => ({
        jobId: 1,
        jobName: name,
        taskId: 'T',
        retryId: 0,
        state: 'completed',
        result: 'testfailed',
    });
    const jobs = [job('a'), job('b'), job('c'), job('d')];
    const summaries = [['one'], ['two'], ['two'], ['two']];
    const groups = groupUnblamedJobs(jobs, summaries);
    assert.equal(groups.size, 2);
    const visible = visibleUnblamedGroups(groups, { term: '', negate: false });
    assert.deepEqual(visible.map((g) => g.jobs.length), [3, 1]);
    assert.equal(visible[0]!.lines[0], 'two');
});

test('the unblamed search filters WITHIN a group and drops emptied groups', () => {
    const job = (name: string): Job => ({
        jobId: 1,
        jobName: name,
        taskId: 'T',
        retryId: 0,
        state: 'completed',
        result: 'testfailed',
    });
    const jobs = [job('test-linux-a'), job('test-windows-b'), job('test-windows-c')];
    const groups = groupUnblamedJobs(jobs, [['same'], ['same'], ['other']]);
    const visible = visibleUnblamedGroups(groups, { term: 'windows', negate: false });
    // The `same` group keeps only its windows job; the `other` group is windows.
    assert.equal(visible.length, 2);
    assert.equal(visible.reduce((sum, g) => sum + g.jobs.length, 0), 2);

    // A term matching nothing empties every group.
    assert.equal(visibleUnblamedGroups(groups, { term: 'bsd', negate: false }).length, 0);
    // The summary text is searchable too.
    assert.equal(visibleUnblamedGroups(groups, { term: 'other', negate: false }).length, 1);
});

// --- uploaded profiles ----------------------------------------------------

test('the "profile uploaded in" notice yields the artifact filename', () => {
    assert.equal(
        extractUploadedProfileName(
            'Found unexpected failures during the test; profile uploaded in profile_test_foo.js.json'
        ),
        'profile_test_foo.js.json'
    );
    assert.equal(extractUploadedProfileName('an ordinary failure'), null);
    assert.equal(extractUploadedProfileName(null), null);
    assert.equal(extractUploadedProfileName(undefined), null);
});

test('the notice keeps the .gz of a gzipped profile', () => {
    // Same regex as `uploadedProfileName` (`lib/links.ts`), duplicated for the
    // worker bundle, so it needs the same coverage: `.json` is a prefix of
    // `.json.gz`, and a pattern ending at `.json` truncates instead of failing.
    assert.equal(
        extractUploadedProfileName(
            'Found unexpected failures during the test; profile uploaded in profile_test_foo.js.json.gz'
        ),
        'profile_test_foo.js.json.gz'
    );
    assert.equal(
        extractUploadedProfileName('profile uploaded in profile_test_foo.js.json'),
        'profile_test_foo.js.json'
    );
});

test('a gzipped notice is still suppressed from the message list', () => {
    // The icon replaces the line. A truncated match would still suppress it,
    // so this pins the pairing rather than the extraction.
    const instance: Timing = {
        path: 'a/test_x.js',
        duration: 1,
        status: 'FAIL',
        timestamp: 1,
        jobName: 'j',
        taskId: 'T',
        retryId: 0,
        allMessages: [
            { message: 'the real failure' },
            { message: 'profile uploaded in profile_x.json.gz' },
        ],
    };
    assert.deepEqual(instanceMessages([instance]), ['the real failure']);
    assert.equal(findUploadedProfile([instance])!.filename, 'profile_x.json.gz');
});

test('the notice is excluded from the copied message list', () => {
    const instance: Timing = {
        path: 'a/test_x.js',
        duration: 1,
        status: 'FAIL',
        timestamp: 1,
        jobName: 'j',
        taskId: 'T',
        retryId: 0,
        allMessages: [
            { message: 'the real failure' },
            { message: 'profile uploaded in profile_x.json' },
            { message: 'the real failure' },
        ],
    };
    // Deduplicated, and the notice is gone — it is shown as an icon instead.
    assert.deepEqual(instanceMessages([instance]), ['the real failure']);
});

test('a profile is located per instance, and the first one wins for the row', () => {
    const mk = (taskId: string, filename: string | null): Timing => ({
        path: 'a/test_x.js',
        duration: 1,
        status: 'FAIL',
        timestamp: 1,
        jobName: `job-${taskId}`,
        taskId,
        retryId: 0,
        allMessages: filename === null ? [] : [{ message: `profile uploaded in ${filename}` }],
    });
    assert.equal(findUploadedProfile([mk('T1', null)]), null);
    const found = findUploadedProfile([mk('T1', null), mk('T2', 'profile_a.json')])!;
    assert.equal(found.taskId, 'T2');
    assert.equal(found.filename, 'profile_a.json');
    assert.equal(found.jobName, 'job-T2');
});

test('the pinned push really does carry uploaded profiles', () => {
    // Otherwise the assertions above would be about a code path nothing reaches.
    const withProfiles = FAILURES.tests.filter(
        (row) => findUploadedProfile(row.instances) !== null
    );
    assert.ok(withProfiles.length > 0, `${withProfiles.length} tests with an uploaded profile`);
});

// --- the empty state ------------------------------------------------------

test('the verdict is weaker for an empty permanent table than for a green push', () => {
    const green = noFailuresText({ noTestFailuresAtAll: true, otherFailedJobCount: 0 });
    assert.equal(green.verdict, 'No test failures — the patches might be ready to land.');
    assert.equal(green.caveat, 'This page only covers mochitest and xpcshell failures.');
    assert.equal(green.caveatHasLink, false);

    const noPerma = noFailuresText({ noTestFailuresAtAll: false, otherFailedJobCount: 0 });
    assert.equal(noPerma.verdict, 'No permanent failures — the patches might be ready to land.');
});

test('a green verdict next to a failed build says so and links Treeherder', () => {
    const one = noFailuresText({ noTestFailuresAtAll: true, otherFailedJobCount: 1 });
    assert.equal(one.caveatHasLink, true);
    assert.equal(
        one.caveat,
        'But this page only covers mochitest and xpcshell, and 1 other job failed: '
    );
    const many = noFailuresText({ noTestFailuresAtAll: true, otherFailedJobCount: 3 });
    assert.match(many.caveat, /and 3 other jobs failed: $/);
});

// --- URL state ------------------------------------------------------------

test('the URL is query-only and drops every parameter at its default', () => {
    const url = new URL('https://example.com/try.html');
    writeUrlState(url, { rev: 'abc123', repo: 'try', filter: '', allJobs: false });
    assert.equal(url.search, '?rev=abc123');
    assert.equal(url.hash, '', 'this page uses no hash');

    writeUrlState(url, { rev: 'abc123', repo: 'autoland', filter: 'x', allJobs: true });
    assert.equal(url.searchParams.get('repo'), 'autoland');
    assert.equal(url.searchParams.get('filter'), 'x');
    assert.equal(url.searchParams.get('alljobs'), '1');

    // And back to the defaults deletes them rather than emptying them.
    writeUrlState(url, { rev: null, repo: 'try', filter: '', allJobs: false });
    assert.equal(url.search, '');
});

test('alljobs is presence-only: any value counts as on', () => {
    assert.equal(readUrlState('?rev=a&alljobs=1').allJobs, true);
    assert.equal(readUrlState('?rev=a&alljobs=0').allJobs, true, 'presence, not value');
    assert.equal(readUrlState('?rev=a&alljobs').allJobs, true);
    assert.equal(readUrlState('?rev=a').allJobs, false);
});

test('the repository defaults to try and the revision to null', () => {
    const empty = readUrlState('');
    assert.equal(empty.rev, null);
    assert.equal(empty.repo, 'try');
    assert.equal(empty.filter, '');
    assert.equal(readUrlState('?rev=a&repo=autoland').repo, 'autoland');
});

test('a bare revision after an autoland push goes back to try', () => {
    // The prefix check is unconditional, which is what makes this work.
    assert.deepEqual(extractRevision('autoland:abc123'), { revision: 'abc123', repo: 'autoland' });
    assert.deepEqual(extractRevision('7d16bff81bb1'), { revision: '7d16bff81bb1', repo: 'try' });
});

test('a revision is recognised as hex, a Treeherder URL, or an hg path', () => {
    assert.deepEqual(extractRevision('  7d16bff81bb1  '), {
        revision: '7d16bff81bb1',
        repo: 'try',
    });
    assert.deepEqual(extractRevision('7d16bff81bb1c0de7d16bff81bb1c0de7d16bff8'), {
        revision: '7d16bff81bb1c0de7d16bff81bb1c0de7d16bff8',
        repo: 'try',
    });
    // A Treeherder URL does NOT parse as one, and that is upstream's behaviour,
    // not a port defect. The `repo:rev` prefix check runs first and its pattern
    // `/^([a-z][\w-]*):(.+)$/i` matches `https:` — so the repository becomes
    // the literal string `https` and the rest of the URL becomes the revision.
    // The `new URL()` branch below it is therefore unreachable for any input
    // starting with a scheme, which is every input it was written for.
    //
    // **Verified against try.html itself**, by extracting its own
    // `extractRevision` and running it: it returns exactly this. Reproduced
    // rather than fixed, because fixing it would change which push a shared
    // Treeherder link loads and that is a behaviour change this migration is
    // not making.
    assert.deepEqual(
        extractRevision('https://treeherder.mozilla.org/jobs?repo=autoland&revision=abc123'),
        { revision: '//treeherder.mozilla.org/jobs?repo=autoland&revision=abc123', repo: 'https' }
    );
    // The hg form survives because the prefix strip leaves a string the hg
    // pattern still matches at its end.
    assert.deepEqual(
        extractRevision('https://hg.mozilla.org/integration/autoland/rev/abc123'),
        { revision: 'abc123', repo: 'autoland' }
    );
    assert.deepEqual(extractRevision('https://hg.mozilla.org/mozilla-central/rev/abc123'), {
        revision: 'abc123',
        repo: 'mozilla-central',
    });
    // A URL with no scheme reaches the `new URL()` branch and works as intended.
    assert.deepEqual(
        extractRevision('treeherder.mozilla.org/jobs?repo=autoland&revision=abc123'),
        {
            revision: 'treeherder.mozilla.org/jobs?repo=autoland&revision=abc123',
            repo: 'try',
        }
    );
    // An unrecognised string is handed to Treeherder rather than rejected here.
    assert.deepEqual(extractRevision('not-a-revision'), {
        revision: 'not-a-revision',
        repo: 'try',
    });
});

test('the hg path of a Treeherder repository name', () => {
    assert.equal(hgRepoPath('autoland'), 'integration/autoland');
    assert.equal(hgRepoPath('try'), 'try');
    assert.equal(hgRepoPath('mozilla-central'), 'mozilla-central');
    assert.equal(hgRepoPath('mozilla-beta'), 'mozilla-beta');
});

// --- the console API ------------------------------------------------------

test('the console list carries the same counts and flags as the table', () => {
    const list = consoleFailures(FAILURES.tests, FAILURES);
    assert.equal(list.length, FAILURES.tests.length);
    for (const entry of list) {
        // Read independently off the fixture.
        assert.equal(entry.count, rawFailureCount(entry.test), entry.test);
        const row = testRow(entry.test);
        assert.equal(entry.flaky, row.intermittentCount === row.instances.length);
    }
});

test('platforms collapse to the literal "all" under the same rule the badges use', () => {
    const list = consoleFailures(FAILURES.tests, FAILURES);
    for (const entry of list) {
        const row = testRow(entry.test);
        const expected = coversAll(row.sortedPlatforms, FAILURES.globalPlatforms)
            ? 'all'
            : row.sortedPlatforms;
        assert.deepEqual(entry.platforms, expected, entry.test);
    }
});

test('formatForPrompt says permafails or is flaky, and names the configs', () => {
    assert.equal(
        formatForPrompt([
            {
                test: 'a/test_x.js',
                count: 2,
                statuses: ['FAIL'],
                platforms: ['linux'],
                buildTypes: ['debug'],
                flaky: false,
                message: 'boom',
            },
        ]),
        'a/test_x.js permafails on linux debug with `boom`'
    );
    assert.equal(
        formatForPrompt([
            {
                test: 'a/test_y.js',
                count: 1,
                statuses: ['TIMEOUT'],
                platforms: 'all',
                buildTypes: 'all',
                flaky: true,
            },
        ]),
        'a/test_y.js is flaky'
    );
});

// --- run keys -------------------------------------------------------------

test('a run key pairs the task with its JOB-level retry', () => {
    assert.equal(runKeyOf({ taskId: 'ABC', retryId: 0 }), 'ABC.0');
    assert.equal(runKeyOf({ taskId: 'ABC', retryId: 2 }), 'ABC.2');
});

// --- the commit list ------------------------------------------------------

/**
 * The push that drove this, with its numbers pinned.
 *
 * Try `de1c6569d675`: a 40-commit stack whose `revision_count` says 40 and
 * whose `revisions` array holds 20 — the first of which is the try head the
 * page strips, leaving 19 it can draw.
 *
 * So the displayable total is 39, not 40, and that is the number the collapsed
 * count is taken against. The missing one is the try head, a commit of the
 * push and not a patch under review. It is why `planRevisionList` takes
 * `returned` as well as `total` rather than subtracting the displayable count.
 */
const PUSH_DE1C = { total: 40, returned: 20, displayable: 19 };

const revs = (n: number): { revision: string }[] =>
    Array.from({ length: n }, (_unused, i) => ({ revision: `rev${i}` }));

test('the commit list shows five, and one control at a time', () => {
    const collapsed = planRevisionList(
        revs(PUSH_DE1C.displayable),
        PUSH_DE1C.total,
        PUSH_DE1C.returned,
        false
    );
    assert.equal(collapsed.shown.length, 5, 'five commits, not the 39 that filled a screen');
    // 34, not 14: the count is of the push, so it covers the commits the API
    // never sent as well. Over-promising by design — two stacked links
    // (`+ 14 more` then `+ 20 more on the pushlog`) read as broken.
    assert.equal(collapsed.hidden, 34, '39 displayable less the 5 shown');
    assert.equal(collapsed.beyondApi, 0, 'and nothing else, while the expander speaks for them');
    assert.equal(collapsed.shown[0]!.revision, 'rev0', 'newest first, as Treeherder orders them');

    // Expanding shows everything the API sent. The click could not deliver all
    // 34, so what is left over now gets its own link — and the expander, whose
    // count covered these, is gone.
    const expanded = planRevisionList(
        revs(PUSH_DE1C.displayable),
        PUSH_DE1C.total,
        PUSH_DE1C.returned,
        true
    );
    assert.equal(expanded.shown.length, 19, 'every commit the API sent and the page can show');
    assert.equal(expanded.hidden, 0, 'no expander left');
    assert.equal(expanded.beyondApi, 20, '40 in the push less the 20 Treeherder returned');
});

test('the two counts are never both non-zero, so only one control renders', () => {
    // The property the renderer relies on instead of checking. Asserted over
    // every cutoff of a truncated push and of a whole one, because it is what
    // stops the stacked pair from coming back.
    for (const [total, returned, count] of [
        [PUSH_DE1C.total, PUSH_DE1C.returned, PUSH_DE1C.displayable],
        [7, 7, 6],
        [4, 4, 3],
        [21, 20, 19],
    ] as const) {
        for (const expanded of [false, true]) {
            const plan = planRevisionList(revs(count), total, returned, expanded);
            assert.ok(
                plan.hidden === 0 || plan.beyondApi === 0,
                `total=${total} expanded=${expanded}: ${plan.hidden} and ${plan.beyondApi}`
            );
        }
    }
});

test('a push the API returned whole is fully revealed by the expander', () => {
    // 6 commits, all returned. Expanding shows them all and leaves no link:
    // there is no pushlog to send anyone to.
    const collapsed = planRevisionList(revs(6), 7, 7, false);
    assert.equal(collapsed.shown.length, 5);
    assert.equal(collapsed.hidden, 1);
    assert.equal(collapsed.beyondApi, 0);

    const expanded = planRevisionList(revs(6), 7, 7, true);
    assert.deepEqual(
        [expanded.shown.length, expanded.hidden, expanded.beyondApi],
        [6, 0, 0],
        'no expander and no link once everything is on screen'
    );

    // And a push shorter than the cutoff has no control from the start.
    const short = planRevisionList(revs(3), 4, 4, false);
    assert.deepEqual([short.shown.length, short.hidden, short.beyondApi], [3, 0, 0]);
});

test('a revision_count that lags the commit rows cannot print a negative', () => {
    // Defensive: the two numbers come from different queries in Treeherder's
    // serializer (`commits.count()` against a sliced `commits.all()`), so a
    // push mid-ingestion can answer with more rows than it counts.
    const plan = planRevisionList(revs(19), 3, 20, false);
    assert.equal(plan.hidden, 0, 'clamped, not -17');
    assert.equal(planRevisionList(revs(19), 3, 20, true).beyondApi, 0);
});

test('the pushlog link keys on the push head, not on the last commit shown', () => {
    // The same URL shape Treeherder's own MoreRevisionsLink builds
    // (`ui/models/repository.js`'s getPushLogHref).
    assert.equal(
        pushLogUrl('try', 'de1c6569d6752d665492ad6cecc5654821bab9ea'),
        'https://hg.mozilla.org/try/pushloghtml?changeset=de1c6569d6752d665492ad6cecc5654821bab9ea'
    );
    // autoland's hg path is not its Treeherder name, which is what hgRepoPath
    // is for; asserted here because a wrong path is a 404 rather than a visible
    // error.
    assert.equal(
        pushLogUrl('autoland', 'abc123'),
        'https://hg.mozilla.org/integration/autoland/pushloghtml?changeset=abc123'
    );
    assert.equal(
        pushLogUrl('mozilla-central', 'abc123'),
        'https://hg.mozilla.org/mozilla-central/pushloghtml?changeset=abc123'
    );
});

// --- Phabricator links ----------------------------------------------------

test('a commit links the Phabricator revision its trailer names', () => {
    // A real message off push de1c6569d675, trailer included.
    const found = phabricatorRevision(
        'Bug 2073421 - Stop TopSitesFeed dispatching a top sites row after uninit().\n' +
            '\n' +
            'Mark the instance in uninit() and treat that mark like a superseded generation.\n' +
            '\n' +
            'Differential Revision: https://phabricator.services.mozilla.com/D327289'
    );
    assert.deepEqual(found, {
        url: 'https://phabricator.services.mozilla.com/D327289',
        name: 'D327289',
    });

    // The URL is taken from the message rather than built from the number, so a
    // commit reviewed on another instance links to that instance.
    assert.equal(
        phabricatorRevision('x\n\nDifferential Revision: https://phab.example.org/D1')?.url,
        'https://phab.example.org/D1'
    );
});

test('a commit without the trailer gets no Phabricator link', () => {
    assert.equal(phabricatorRevision('Bug 1 - a patch that never went to review, r=me'), null);
    // The try head commit, which carries try syntax and no trailer. This is the
    // one the page strips anyway, but it is also the shape a `hg commit` patch
    // has.
    assert.equal(phabricatorRevision('newtab burndown push 7: 39-commit stack'), null);

    // Anchored per line: a message that discusses the trailer in prose is not
    // one that carries it. Matching unanchored would link the word rather than
    // the commit.
    assert.equal(
        phabricatorRevision('Explain that Differential Revision: https://x/D2 is a trailer.'),
        null
    );
});
