/**
 * Which of a push's jobs a try report is computed from.
 *
 * The layer between `lib/sources/treeherder.ts`, which fetches a push's jobs,
 * and the two things that read their profiles — `try.html` in a browser and
 * `fx-tests try` in node. Both had to answer the same three questions before
 * fetching anything: which jobs run a harness this tooling can parse, which of
 * those to read profiles for, and how many times each configuration ran. Both
 * answered them in their own code.
 *
 * That is the hole `cde2ebd` exposed. The page's "All jobs" checkbox and the
 * CLI's `--all-jobs` flag were two controls on different axes sharing a name;
 * fixing the flag made the two sides *agree*, but by writing the rule a second
 * time rather than by sharing it, so the next divergence had the same room to
 * grow. `isTestJob` was defined twice, character for character, and nothing
 * would have failed if one copy had gained a harness.
 *
 * ## What is here, and what is deliberately not
 *
 * Here: **what to read**. `selectTryJobs` partitions a push and names the set
 * whose profiles the caller should fetch.
 *
 * Not here: **how to read it**. The page fetches through a pool of Web Workers
 * that parse in the worker and post timings back; the CLI fetches through a
 * disk cache with a `--concurrency` bound and a streamed-profile check. Those
 * differ for real reasons and are not a duplication to remove — one of them
 * cannot run in the other's runtime. The boundary is drawn exactly at the job
 * list because that is the last point at which the two are answering the same
 * question.
 *
 * Also here: the status classification the selection travels with
 * (`isFailureStatus`, `runKeyOf`). Those were duplicated the same way and are
 * read on the same objects, so splitting them across two modules would leave
 * the next reader looking in two places for one rule.
 *
 * ## `retry` vs `rerun`, which is the other half of the same bug
 *
 * The two sides also **name** the harness's in-job rerun differently, and that
 * is not cosmetic: it is why nothing lined the `--all-jobs` defect up. The
 * concept has three spellings in this repository.
 *
 * | side | field on a timing | derived flag |
 * | --- | --- | --- |
 * | `site/` | `isRetry` | `passedOnRetry` |
 * | `cli/` | `isRerun` | `passedOnRerun` |
 * | `lib/model/execution.ts` | — | `passedOnRerun` |
 *
 * They are the same thing, and `passedOnRerun` is the name this repository has
 * settled on — `lib/model/execution.ts` owns the concept and spells it that
 * way. A grep for it finds 19 hits in `cli/` and **none** in `site/`, which
 * reads as "the page does not have this feature" and is false.
 *
 * It is not renamed here, and the reason is a hard boundary rather than
 * reluctance. `isRetry` is set inside `WORKER_CODE` in `site/try.ts` — a
 * `String.raw` block carried verbatim from `old/try.html:862`, which that file
 * documents as untouched precisely so bundling cannot alter marker semantics.
 * The field then crosses a `postMessage` boundary into the page. Renaming it
 * means editing the verbatim block, which is a behaviour risk on the profile
 * parser taken for a vocabulary win. The table above is the cheap half of the
 * fix: a reader who greps either spelling now finds the other.
 *
 * Note the third confusion the names invite and that neither side has: the
 * job-level retry, Taskcluster's `runs/<n>`, is `retryId`, and it is a
 * different axis from both. `runKeyOf` below is built on that one.
 */

import type { TreeherderJob } from '../sources/treeherder.ts';
import { FAILED_JOB_RESULTS } from '../sources/treeherder.ts';

// --- which jobs run tests --------------------------------------------------

/**
 * The harnesses whose profiles carry test markers. `old/try.html:735`.
 *
 * Not a taxonomy of Firefox's harnesses — a statement about which artifacts
 * this tooling can extract per-test timings from. A reftest job is a test job
 * in every ordinary sense and is not in here, because its profile has no `Test`
 * markers to parse. Both consumers say so in their own words: the page's empty
 * state names these two harnesses in its caveat, and the CLI's header does the
 * same.
 */
export const SUPPORTED_HARNESSES: readonly string[] = ['mochitest', 'xpcshell'];

/**
 * Job kinds that run a supported harness without naming it.
 *
 * `test-verify` reruns the tests a push *touched*, over and over, to catch the
 * new intermittent before it lands. It runs them through `desktop_unittest.py`
 * — mochitest and xpcshell, the same two harnesses, the same `Test` markers in
 * the same `profile_resource-usage.json`. `taskcluster/kinds/test/misc.yml`
 * names the suite `test-verify` rather than after what it runs, so the
 * substring rule below sees a job name with no harness in it and calls a
 * mochitest job a build.
 *
 * `test-verify-gpu` is the same suite on a GPU worker
 * (`suite: {category: test-verify, name: test-verify-gpu}`), so it is here too.
 * Its file patterns (`taskcluster/gecko_taskgraph/util/perfile.py:34`) select
 * `dom/canvas`, `gfx/tests`, `webgl` and `devtools/canvasdebugger` — mochitests
 * — alongside a `reftest` glob, which is not parseable. That mix costs nothing:
 * a reftest contributes no `Test` marker, so it is absent from the report
 * rather than wrong in it, which is what a reftest job already is here.
 *
 * `test-verify-wpt` is **not** here, and is why this is a list of prefixes read
 * longest-first rather than a `test-verify` prefix test. It is the wpt harness
 * (`taskcluster/kinds/web-platform-tests/kind.yml:966`), whose profile has no
 * `Test` markers — the same line `SUPPORTED_HARNESSES` draws for
 * `test-linux2404-64/opt-web-platform-tests-2`.
 */
const VERIFY_JOB_KINDS: readonly { prefix: string; parseable: boolean }[] = [
    { prefix: 'test-verify-wpt', parseable: false },
    { prefix: 'test-verify-gpu', parseable: true },
    { prefix: 'test-verify', parseable: true },
];

/**
 * Whether a job runs a harness whose profile this tooling can extract
 * per-test timings from.
 *
 * Two rules, because Firefox names test jobs two ways. Most name their harness,
 * and those are a substring test on the job name — what upstream does, and
 * looser than it looks: it matches `test-linux2404-64/debug-xpcshell-3` and
 * would also match a hypothetical `mochitest-devtools-chrome` variant nobody
 * has parsed. Kept loose rather than tightened, because the two consumers
 * agreeing matters more here than either one being right — and a tightening
 * would silently drop rows from one of them if only one copy got it.
 *
 * The rest name a *suite* that runs one, and `VERIFY_JOB_KINDS` is the list of
 * those. A substring test cannot express it: `test-verify` is a prefix of
 * `test-verify-wpt`, which must not match, so the kinds are read longest-prefix
 * first and the first hit decides. Verified against a real push — 20
 * `test-verify` runs on try `433ac99a803f`, 3 of them `testfailed`, all three
 * reported as failed *builds* before this.
 */
export function isTestJob(jobName: string): boolean {
    // `test-linux2404-64/opt-test-verify-1` — the kind is the tail, after the
    // platform and the build type, so this reads the whole name and anchors on
    // the separator rather than stripping a list of build types. `misc.yml`
    // keeps test-verify off asan and ccov today, and an `includes` that did not
    // anchor would take `test-verify-wpt` through the `test-verify` entry.
    for (const kind of VERIFY_JOB_KINDS) {
        if (jobName.includes(`-${kind.prefix}`)) return kind.parseable;
    }
    return SUPPORTED_HARNESSES.some((harness) => jobName.includes(harness));
}

// --- status classification -------------------------------------------------

/**
 * The statuses that count as a failure in a try report. `old/try.html:1486`.
 *
 * **`UNEXPECTED-PASS` is one of them**, and that is not a slip. A test annotated
 * `fail-if` that *passed* means the annotation is now wrong, which is a thing
 * the push broke and a thing someone has to go and fix — so it ranks alongside
 * the failures. Note the asymmetry with `EXPECTED-FAIL`, which the profile
 * parser produces for a `FAIL` marker coloured green and which is **not** here:
 * an annotation that fired as intended is not news.
 *
 * `ERROR` is here too. The parser emits it for a `Test` marker whose status is
 * literally `ERROR`, which mochitest uses for a harness-level problem inside a
 * test's range.
 *
 * Deliberately *not* `classifyStatus`'s `isFail`. `lib/model/status.ts` answers
 * "did this run reach a failing verdict" for the published aggregates, where
 * `UNEXPECTED-PASS` does not occur and `EXPECTED-FAIL` is its own kind. A try
 * push's question is "is this a row in the failures table", and the two sets
 * differ by exactly `UNEXPECTED-PASS`. Keeping this set separate is what stops
 * a unification from silently dropping a column of rows.
 */
export const FAILURE_STATUSES: ReadonlySet<string> = new Set([
    'FAIL',
    'TIMEOUT',
    'CRASH',
    'ERROR',
    'UNEXPECTED-PASS',
]);

/**
 * The status with any `-PARALLEL`/`-SEQUENTIAL` phase suffix removed.
 *
 * The profile parser appends the suffix for the four statuses it can place in
 * the parallel range (`old/try.html:979`), so `FAIL-PARALLEL` and `FAIL` are the
 * same verdict in a different phase. Everything that asks *what happened*
 * strips it; only the detail rows keep it.
 */
export function baseStatus(status: string): string {
    return status.replace(/-(PARALLEL|SEQUENTIAL)$/, '');
}

/** Whether a status means the test failed, in a try report. `old/try.html:1488`. */
export function isFailureStatus(status: string): boolean {
    return FAILURE_STATUSES.has(baseStatus(status));
}

/**
 * `"<taskId>.<retryId>"` — the key identifying one job run.
 *
 * The `retryId` here is the **job-level** retry, Taskcluster's `runs/<n>`, not
 * the harness's within-job rerun; `lib/model/execution.ts` owns that
 * distinction. Taking a structural parameter rather than a `TreeherderJob` is
 * what lets both a job and a timing be keyed by it, which both consumers do.
 */
export function runKeyOf(run: { taskId: string; retryId: number }): string {
    return `${run.taskId}.${run.retryId}`;
}

// --- how each job run of a test ended ---------------------------------------

/**
 * How the runs of one test ended, counted in **job runs**.
 *
 * The five buckets partition the runs of the configurations the test failed on,
 * so they sum to the denominator of the "failed n of m runs" fraction. That is
 * the distinction the fraction alone cannot make, and getting it wrong is what
 * `browser_878452_drag_to_panel.js` exposed on try push 7d16bff81bb1: it failed
 * in all 18 runs of the 12 configurations it failed on, and the harness's in-job
 * rerun turned every one of those 18 runs green. `18/18` is arithmetically
 * right and reads as "this test never once passed", which is the opposite of
 * what happened. Only `passedOnRetry === 18` says what the push actually did.
 *
 * Counting job runs rather than executions is deliberate and is the axis the
 * fraction is on. A failing execution is a different unit — the harness reruns
 * a failing test, so one job run can hold two of them — and conflating the two
 * is what `PARITY.md` §1 records as a user-reported defect.
 */
export interface RunOutcomes {
    /** Failed, then failed again when the harness reran it in-job. */
    failedTwice: number;
    /** Failed, then passed when the harness reran it in-job. */
    passedOnRetry: number;
    /** Failed once and was not rerun. */
    failedOnce: number;
    /** Ran and did not fail. */
    passed: number;
    /**
     * A run of one of those configurations whose profile was never parsed.
     *
     * Without `--all-jobs` (the page's "All jobs" unchecked) this is every
     * *passing* run of the configuration, because only the failed jobs'
     * profiles were read. It is not evidence the test failed there, and a
     * reader who takes the fraction as "failed every time" is reading these as
     * failures.
     */
    notAnalyzed: number;
}

/**
 * The minimum a timing has to carry for its run outcome to be decidable.
 *
 * Structural rather than either side's concrete type, because the two spell the
 * in-job rerun flag differently — `cli/commands/try.ts` has `isRerun` and
 * `site/try-view.ts` has `isRetry`, for the reason the table above records — and
 * neither spelling can be made to serve as the shared one without renaming a
 * field that crosses a `postMessage` boundary. The caller passes a reader.
 */
export interface RunOutcomeTiming {
    path: string;
    status: string;
    jobName: string;
    taskId: string;
    retryId: number;
}

/**
 * Buckets the runs of one test, over the configurations it failed on.
 *
 * `execsByRun` holds **every** parsed execution of the test in each run of those
 * configurations, passing ones included — that is what makes the in-job rerun
 * visible, and reading only the failing executions is what reduces this to the
 * fraction it is meant to qualify.
 *
 * Ported from `site/try-view.ts`'s `aggregateFailures`, whose bucketing this is,
 * so that `fx-tests try` and `try.html` cannot answer it differently.
 */
export function runOutcomes<T extends RunOutcomeTiming>(
    /** jobName -> runKey -> every parsed execution of the test in that run. */
    execsByRun: ReadonlyMap<string, ReadonlyMap<string, readonly T[]>>,
    /** The configurations the test failed on. */
    failedJobNames: Iterable<string>,
    /** Completed runs of each configuration, across the whole push. */
    runsPerJobName: ReadonlyMap<string, number>,
    /** Whether this execution fell in the harness's in-job rerun phase. */
    isRerun: (timing: T) => boolean
): RunOutcomes {
    const outcomes: RunOutcomes = {
        failedTwice: 0,
        passedOnRetry: 0,
        failedOnce: 0,
        passed: 0,
        notAnalyzed: 0,
    };
    for (const jobName of failedJobNames) {
        const runs = execsByRun.get(jobName);
        for (const execs of runs?.values() ?? []) {
            const failed = execs.filter((exec) => isFailureStatus(exec.status));
            if (failed.length === 0) {
                outcomes.passed++;
            } else if (execs.some((exec) => isRerun(exec) && exec.status.startsWith('PASS'))) {
                outcomes.passedOnRetry++;
            } else if (failed.length > 1) {
                outcomes.failedTwice++;
            } else {
                outcomes.failedOnce++;
            }
        }
        // Runs of this configuration whose profile was never parsed. One run of
        // the test each; `Math.max` because a profile can hold a run the job
        // list does not (a retriggered task the push query missed).
        outcomes.notAnalyzed += Math.max(0, (runsPerJobName.get(jobName) ?? 0) - (runs?.size ?? 0));
    }
    return outcomes;
}

// --- the selection ---------------------------------------------------------

/**
 * A push's jobs, split into the sets a try report is built from.
 *
 * Every field is derived from the same job list in one pass, so no consumer can
 * partition it slightly differently — which is what the two of them were doing.
 */
export interface TryJobSelection<J extends TreeherderJob = TreeherderJob> {
    /** Completed test jobs whose result is `testfailed`. */
    failedTestJobs: J[];
    /** Completed test jobs that passed — what `readPassingJobs` adds. */
    successfulTestJobs: J[];
    /**
     * Completed jobs that failed but run no parseable harness — builds, lint,
     * reftests.
     *
     * Both consumers surface these as a pointer to Treeherder rather than
     * hiding them: a green verdict next to a busted build is the one way a try
     * report could actively mislead.
     */
    otherFailedJobs: J[];
    /**
     * The jobs whose profiles to read, in that order: the failed test jobs,
     * then the successful ones when they were asked for.
     *
     * The order is part of the contract. Both consumers report progress against
     * this list, and the failed jobs — the ones that produce rows either way —
     * coming first is what makes an interrupted run useful.
     */
    jobsToProcess: J[];
    /** Whether the successful test jobs are in `jobsToProcess`. */
    readPassingJobs: boolean;
    /**
     * Completed runs of each test job name, successes included.
     *
     * The denominator of "failed in 3 of 4 runs". Counted over *all* completed
     * test jobs rather than over `jobsToProcess`, so it does not move when the
     * caller widens the universe — a test that failed every run it was read in
     * must not become a perma-fail just because the passing runs were not read.
     */
    runsPerJobName: Map<string, number>;
    /** The job names with at least one wholly successful run. */
    successfulJobNames: Set<string>;
}

/**
 * Splits a push's jobs, and decides which profiles to read.
 *
 * `readPassingJobs` is the shared meaning of `try.html`'s "All jobs" checkbox
 * and `fx-tests try --all-jobs`. It changes the **universe**, not the rows: it
 * adds the successful test jobs' profiles, which is the only way a test that
 * failed and then passed on the harness's rerun can surface at all — that job
 * is green on Treeherder, so nothing in the default set references it.
 *
 * Off by default on both sides, for the same reason. Measured on try push
 * `7d16bff81bb1`: 46 failed test jobs against 1,538 successful ones, so it
 * reads 34x the artifacts. It is worth it when flakiness is the question —
 * that same run reports 116 failing tests against the default's 26, and all 90
 * of the added ones passed on the harness's rerun.
 *
 * Generic over the job type so each consumer keeps its own: the page's `Job`
 * carries a `cleanedSummary` its unblamed-jobs pass attaches, and the returned
 * arrays hold the caller's objects rather than copies.
 */
export function selectTryJobs<J extends TreeherderJob>(
    jobs: readonly J[],
    options: { readPassingJobs: boolean }
): TryJobSelection<J> {
    const failedTestJobs: J[] = [];
    const successfulTestJobs: J[] = [];
    const otherFailedJobs: J[] = [];
    const runsPerJobName = new Map<string, number>();

    for (const job of jobs) {
        if (job.state !== 'completed') {
            // A running or pending job has no artifact to read and no outcome
            // to count. Both consumers gate on this before every other test.
            continue;
        }
        if (isTestJob(job.jobName)) {
            runsPerJobName.set(job.jobName, (runsPerJobName.get(job.jobName) ?? 0) + 1);
            if (job.result === 'testfailed') {
                failedTestJobs.push(job);
            } else if (job.result === 'success') {
                successfulTestJobs.push(job);
            }
            // A test job that was `busted` or `exception` is in neither: it
            // produced no usable profile and it did not pass. It still counts
            // as a run of its configuration above, which is the point of
            // counting there rather than from these two arrays.
        } else if (FAILED_JOB_RESULTS.has(job.result)) {
            otherFailedJobs.push(job);
        }
    }

    return {
        failedTestJobs,
        successfulTestJobs,
        otherFailedJobs,
        jobsToProcess: options.readPassingJobs
            ? failedTestJobs.concat(successfulTestJobs)
            : [...failedTestJobs],
        readPassingJobs: options.readPassingJobs,
        runsPerJobName,
        successfulJobNames: new Set(successfulTestJobs.map((job) => job.jobName)),
    };
}
