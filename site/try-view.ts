/**
 * `try.html`'s **view model**: one Try push reduced to exactly what the page
 * draws, with no DOM in sight.
 *
 * The third and last of the three migrations `PARITY.md` §3 sequences, and the
 * one it deliberately put last. It follows the boundary the first two settled:
 *
 * > **`lib/` holds data and derivations. The page directory holds the view
 * > model — including anything that names an element id, a CSS class or a
 * > glyph.**
 *
 * ## What came from `lib/`
 *
 * | from | replaces | why it is `lib/`'s |
 * | --- | --- | --- |
 * | `computeConfigStats` (`lib/query/config-stats.ts`) | `common-test-data.js:121` | the recent-window sizing, shared with `fx-tests try` |
 * | `computeTestStats` (`lib/query/test-stats.ts`) | `common-test-data.js:267` | per-status run totals |
 * | `stripChunkSuffix` (`lib/model/job-name.ts`) | `common-test-data.js:80` | the config identity rule |
 * | `findTestByPath` / `decodeBucket` (`lib/formats/`) | `findTest`, ad-hoc indexing | the file format |
 * | `bucketIndexForPath` (`lib/formats/buckets.ts`) | `getChunkIndex` | the bucket hash |
 * | `detectHarness` (`lib/model/harness.ts`) | `common-test-data.js:9` | which file a test lives in |
 * | `classifyStatus` (`lib/model/status.ts`) | inline prefix tests | status classification |
 *
 * The page no longer loads `common-test-data.js`, which was the point of the
 * exercise: all six of the functions try.html reached into it for now have a
 * typed, tested `lib/` equivalent, and one of them (`computeConfigStats`) is
 * the one `PLAN.md` §3 named as "should be moved, not rewritten".
 *
 * ## What stayed here, and why it is not `lib/`'s
 *
 * **The push's own aggregation** (`aggregateFailures`, below). It looks like a
 * data derivation and it very nearly is one — `cli/commands/try.ts` has its own
 * copy under the same name. They are deliberately *not* unified, and the reason
 * is the one thing this page must not get wrong:
 *
 * `try.html`'s row unit is **one test path, aggregated across the push**, ranked
 * by **failing executions** (`test.instances.length`, `old/try.html:1749`), and its
 * two tables are split by whether *every* instance was intermittent
 * (`old/try.html:1765`). `fx-tests try`'s row unit is the same test path but its
 * sections are split on `everyRunFailed` — a per-configuration fact — and it
 * carries central history on each row. Those are two different questions asked
 * of the same timings, and `PARITY.md` §5 exists precisely to compare them
 * rather than to collapse them. Unifying the aggregation would delete the thing
 * being compared.
 *
 * **Everything naming a badge, a glyph or a CSS class.** `MITTEN`, the
 * `status-FAIL` / `platform-linux` / `build-opt` class suffixes, the
 * `count-cell high|medium|low` thresholds, the `flaky` / `flaky-msg` /
 * `flaky-few-runs` classes, and the tooltip prose. The class name is the channel
 * the old page used to express a decision, and reproducing the name is what
 * keeps `shared.css` unchanged.
 *
 * **`flakinessCell`.** It pairs a rate with a CSS class and a glyph, so it is
 * view-model by the rule above. The rate and its tooltip are not: `fx-tests try`
 * shows the same number, so they live in `lib/query/flakiness-rate.ts`.
 *
 * ## This file must stay DOM-free
 *
 * `tsconfig.site.json` gives `site/` the DOM lib, so that is a discipline rather
 * than something the compiler enforces here — but it *is* enforced indirectly:
 * `test/try-view.test.ts` imports this module, the root project compiles
 * `test/**`, and the root project has no DOM. A `document` reach fails
 * `npm run typecheck` on the root project.
 */

import { extractPlatform } from '../lib/model/job-name.ts';
import {
    FAILURE_STATUSES,
    type RunOutcomes,
    SUPPORTED_HARNESSES,
    baseStatus,
    isFailureStatus,
    isTestJob,
    runKeyOf,
    runOutcomes,
    selectTryJobs,
} from '../lib/model/try-jobs.ts';
import {
    HISTORY_DAYS,
    type FlakinessData,
    flakinessTooltip,
    formatFailRate,
    pickHeadlineRate,
} from '../lib/query/flakiness-rate.ts';

// --- the push's raw material ---------------------------------------------

/**
 * One execution of one test, as the profile worker extracts it.
 *
 * The shape `site/try-worker.ts` posts back, plus the three fields the main
 * thread stamps on afterwards (`jobName`, `taskId`, `retryId`) and the two the
 * intermittency pass adds (`intermittent`, `passedOnRetry`).
 *
 * Deliberately a plain interface rather than a class: it crosses a
 * `postMessage` boundary, so it has to be structured-cloneable, and every
 * consumer here reads it rather than asking it questions.
 */
export interface Timing {
    path: string;
    duration: number;
    /** `FAIL`, `TIMEOUT-PARALLEL`, `CRASH`, `UNEXPECTED-PASS`, `PASS`, … */
    status: string;
    timestamp: number;
    /** Every `TestStatus` message inside this test's marker range. */
    allMessages: TimingMessage[];
    /** The first of `allMessages`, or the `Test` marker's own message. */
    message?: string | undefined;
    crashSignature?: string | undefined;
    minidump?: string | undefined;
    /**
     * The marker fell inside the harness's in-job `retry` phase.
     *
     * `cli/commands/try.ts` calls this same field `isRerun`, and the flag below
     * `passedOnRerun` — which is the name `lib/model/execution.ts` owns and the
     * one this repository has settled on. The spelling here is `retry` because
     * it is set inside `WORKER_CODE`, carried verbatim from `old/try.html`. See
     * the table in `lib/model/try-jobs.ts`: a grep for one spelling finding
     * nothing on the other side is how the `--all-jobs` defect survived.
     */
    isRetry?: boolean | undefined;
    jobName: string;
    taskId: string;
    /** The **job-level** retry, Taskcluster's `runs/<n>` — a different axis from `isRetry`. */
    retryId: number;
    /** Set by `tagIntermittent`. */
    intermittent?: boolean | undefined;
    /** Set by `tagIntermittent`, only on the rerun-passed case. `cli/`'s `passedOnRerun`. */
    passedOnRetry?: boolean | undefined;
}

/** One logged failure line inside a test's marker range. */
export interface TimingMessage {
    message: string;
    status?: string | undefined;
    stack?: string | undefined;
}

/** A Treeherder job, as this page uses it. */
export interface Job {
    jobId: number;
    jobName: string;
    taskId: string;
    retryId: number;
    state: string;
    result: string;
    /** Attached by the unblamed-jobs pass. */
    cleanedSummary?: string[] | undefined;
}

/**
 * Job classification and selection, shared with `fx-tests try`.
 *
 * These were defined here and again in `cli/commands/try.ts`, character for
 * character in the case of `isTestJob`. `lib/model/try-jobs.ts` states why one
 * definition matters more than either copy being right; re-exported rather than
 * imported through, because this page's own tests and the parity harness read
 * them from here.
 */
export {
    FAILURE_STATUSES,
    SUPPORTED_HARNESSES,
    baseStatus,
    isFailureStatus,
    isTestJob,
    runKeyOf,
    runOutcomes,
    selectTryJobs,
};
export { FAILED_JOB_RESULTS } from '../lib/sources/treeherder.ts';

// --- platform and build badges --------------------------------------------

/**
 * Fixed badge orders. `old/try.html:739`.
 *
 * Not alphabetical and not data-driven: a reader scanning a column of badges
 * wants the same platform in the same place on every row, and `linux` before
 * `windows` before `mac` is the order the rest of the tooling uses.
 */
export const PLATFORM_ORDER = ['linux', 'windows', 'mac', 'android', 'unknown'];

/** `old/try.html:740`. Build types in increasing order of exoticism. */
export const BUILD_TYPE_ORDER = ['opt', 'debug', 'asan', 'tsan', 'ccov'];

/**
 * The build types a job name implies. `old/try.html:831`.
 *
 * Note the shape of the chain, which is easy to "tidy" into something else:
 * the three sanitizers each *add* a type, `debug` adds one too, and `opt` is
 * added **only** when nothing else matched at all. So `ccov/debug` is
 * `['ccov', 'debug']` and `asan/opt` is `['asan']` — an asan build is not
 * additionally an opt build, but a ccov debug build is both.
 *
 * Reproduced rather than replaced with `lib/model/job-name.ts`'s `buildType()`,
 * which returns a single string. The two are not interchangeable: this returns
 * a *set*, and the set is what the badge column draws.
 */
export function extractBuildTypes(jobName: string): string[] {
    const types: string[] = [];
    if (/[-/]asan/.test(jobName)) {
        types.push('asan');
    }
    if (/[-/]tsan/.test(jobName)) {
        types.push('tsan');
    }
    if (/[-/]ccov/.test(jobName)) {
        types.push('ccov');
    }
    if (/[-/]debug/.test(jobName)) {
        types.push('debug');
    } else if (types.length === 0) {
        types.push('opt');
    }
    return types;
}

/** The members of `platforms`, in `PLATFORM_ORDER`. `old/try.html:841`. */
export function sortedPlatforms(platforms: ReadonlySet<string>): string[] {
    return PLATFORM_ORDER.filter((platform) => platforms.has(platform));
}

/** The members of `builds`, in `BUILD_TYPE_ORDER`. `old/try.html:845`. */
export function sortedBuildTypes(builds: ReadonlySet<string>): string[] {
    return BUILD_TYPE_ORDER.filter((build) => builds.has(build));
}

/**
 * The coarse OS of a job name — `shared.js:70`'s `extractPlatform`.
 *
 * Shared with `test-view.ts`, which had a byte-identical copy. It is
 * deliberately not `operatingSystem()`; `lib/model/job-name.ts` states why both
 * exist. Re-exported rather than imported through, because this page's own
 * tests and the parity harness read it from here.
 */
export { extractPlatform };

// --- intermittency --------------------------------------------------------

/**
 * Marks each failing timing intermittent or not, in place.
 *
 * `old/try.html:1370-1433`. Three independent cases, tried in order, and the order
 * matters only because the first one also sets `passedOnRetry`:
 *
 * 1. **The harness reran it in-job and it passed.** The strongest signal there
 *    is — the same binary, the same machine, the same job, a different outcome.
 *    This is the *within-job* rerun (`isRetry`), not the job-level `retryId`.
 * 2. **Another run of the same job name succeeded entirely.** If
 *    `test-linux2404-64/opt-xpcshell-3` passed once and failed once, whatever
 *    failed in it was not deterministic.
 * 3. **Another run of the same job name failed on *different* tests.** Two runs
 *    of one config that fail on disjoint test sets are both flaky runs; a test
 *    absent from one of the failure sets did not fail there.
 *
 * ## The seeding, and why it is load-bearing
 *
 * `failsByJobAndRun` is seeded with **every processed job** before any timing is
 * read (`old/try.html:1380`), so a run whose profile yielded no parseable test-level
 * failure — a harness crash, a killed job — still counts as a separate run of
 * that job name with an empty failure set. Without the seeding, case 3 could
 * never see it, and a test that failed in one run of a two-run config where the
 * other run crashed the harness would read as permanent.
 *
 * Mutating in place rather than returning is upstream's shape and is kept: the
 * `intermittent` flag is read off the timing objects by four later passes, and
 * threading a parallel map through all of them would be a bigger change than
 * the migration is making.
 */
export function tagIntermittent(
    timings: readonly Timing[],
    options: {
        jobsToProcess: readonly Job[];
        /** Job names with at least one wholly successful run. */
        successfulJobNames: ReadonlySet<string>;
    }
): void {
    // jobName -> runKey -> failing test paths. Seeded with every processed job,
    // so a run that produced no parseable failure still counts as a run.
    const failsByJobAndRun = new Map<string, Map<string, Set<string>>>();
    for (const job of options.jobsToProcess) {
        let runs = failsByJobAndRun.get(job.jobName);
        if (runs === undefined) {
            runs = new Map();
            failsByJobAndRun.set(job.jobName, runs);
        }
        const runKey = runKeyOf(job);
        if (!runs.has(runKey)) {
            runs.set(runKey, new Set());
        }
    }
    for (const timing of timings) {
        if (!isFailureStatus(timing.status)) {
            continue;
        }
        // Upstream indexes without a guard (`old/try.html:1389`); a timing whose job
        // is not in `jobsToProcess` would throw there. It cannot happen — every
        // timing came from processing one of those jobs — but reading through
        // an optional chain says so without changing any outcome.
        failsByJobAndRun.get(timing.jobName)?.get(runKeyOf(timing))?.add(timing.path);
    }

    // Tests that passed in the harness's rerun phase, per run.
    const passedOnRetryByRun = new Map<string, Set<string>>();
    for (const timing of timings) {
        if (timing.isRetry !== true || !timing.status.startsWith('PASS')) {
            continue;
        }
        const runKey = runKeyOf(timing);
        let paths = passedOnRetryByRun.get(runKey);
        if (paths === undefined) {
            paths = new Set();
            passedOnRetryByRun.set(runKey, paths);
        }
        paths.add(timing.path);
    }

    for (const timing of timings) {
        if (!isFailureStatus(timing.status)) {
            timing.intermittent = false;
            continue;
        }
        const runKey = runKeyOf(timing);

        if (passedOnRetryByRun.get(runKey)?.has(timing.path) === true) {
            timing.intermittent = true;
            timing.passedOnRetry = true;
            continue;
        }
        if (options.successfulJobNames.has(timing.jobName)) {
            timing.intermittent = true;
            continue;
        }
        const runs = failsByJobAndRun.get(timing.jobName);
        if (runs !== undefined && runs.size > 1) {
            timing.intermittent = false;
            for (const [key, failSet] of runs) {
                if (key === runKey) {
                    continue;
                }
                if (!failSet.has(timing.path)) {
                    timing.intermittent = true;
                    break;
                }
            }
        } else {
            timing.intermittent = false;
        }
    }
}

// --- the aggregation ------------------------------------------------------

/**
 * How each job run of a test ended. These count **job runs**, not failures.
 *
 * `lib/model/try-jobs.ts`'s `RunOutcomes`, under this page's name for it. The
 * bucketing was written here first and is now shared, because the CLI had the
 * fraction and not the breakdown.
 */
export type Outcomes = RunOutcomes;

/** One row of the failures table: a test path, aggregated across the push. */
export interface FailingTest {
    path: string;
    /**
     * Every **failing execution**, one entry per failing marker.
     *
     * `instances.length` is the `#` column and the default sort key. It is
     * **not** the number of job runs: the harness reruns a test that fails, so
     * one job run can hold two of these. This distinction was a user-reported
     * CLI bug (`PARITY.md` §1, "sort key: executions vs job runs" — the one
     * defect that produced the *same set* in a different order and would pass
     * any set comparison), so it is stated here and tested directly.
     */
    instances: Timing[];
    /** Base statuses seen, in first-seen order. Drives the status badges. */
    statuses: Set<string>;
    /** Distinct job names it failed on. */
    jobs: Set<string>;
    platforms: Set<string>;
    buildTypes: Set<string>;
    /** The one message every instance shares, or the shared crash signature. */
    commonMessage?: string | undefined;
    /** How many of `instances` are intermittent. */
    intermittentCount: number;
    /**
     * Task runs of the job names this test **failed on**.
     *
     * Only those. A configuration where the test ran and always passed is not
     * in this denominator, because `entry.jobs` only ever gains a name from a
     * *failing* instance (`old/try.html:1512`) and the loop at `:1563` walks
     * `entry.jobs`. So "2/2 runs" means "both runs of the configs it failed on",
     * not "both runs anywhere". Preserved deliberately: the question the column
     * answers is "when this config ran, how often did it fail", and folding in
     * configs that never failed would dilute exactly the signal being read.
     */
    totalJobs: number;
    /** Executions of the test itself, including unparsed runs. */
    totalRuns: number;
    outcomes: Outcomes;
    /** Pre-sorted for rendering. */
    sortedPlatforms: string[];
    sortedBuildTypes: string[];
}

/** Everything `aggregateFailures` produces. */
export interface Failures {
    tests: FailingTest[];
    globalPlatforms: Set<string>;
    globalBuildTypes: Set<string>;
    /** path -> jobName -> runKey -> executions. The debug JSON's source. */
    execsByTest: Map<string, Map<string, Map<string, Timing[]>>>;
}

/**
 * Aggregates the push's timings into one row per failing test path.
 *
 * `old/try.html:1492`. **The row unit is a test path, aggregated across the whole
 * push** — not a (test, config) pair and not a job. The framing audit flags this
 * as the thing most easily lost in a port, because a migration emitting one row
 * per configuration would produce the same *numbers* and answer a different
 * question.
 *
 * ## The default sort, and what its direction actually decides
 *
 * `tests.sort((a, b) => b.instances.length - a.instances.length)`
 * (`old/try.html:1588`) — failing executions, descending.
 *
 * **It is not the table's order.** `renderTable` re-sorts through `sortTests`
 * with the same key by default (`currentSort = { column: 'count', ascending:
 * false }`, `old/try.html:744`), and `Array.prototype.sort` has been required to be
 * stable since ES2019, so tie members keep whatever relative order they had
 * *going in*. Both directions of this pre-sort leave tie members in
 * `testMap.values()` insertion order — a descending pre-sort does not permute
 * within a tie group and neither does an ascending one — so the re-sort erases
 * the direction entirely. Measured on `try-7d16bff81bb1` (28 tests, five tie
 * groups sized 3/6/3/5/8): flipping this comparator to ascending changes **0 of
 * 28** positions in the default table.
 *
 * **What it does decide is the flakiness fetch order**, and that is observable.
 * `site/try.ts` passes this array straight to `fetchFlakinessData`, which
 * numbers it into `testOrder` and hands that to `groupRequestsByChunk` — so the
 * pre-sort's direction is the priority the bucket files are fetched in. Same
 * fixture: descending fetches `mochitest-04` first, ascending fetches
 * `mochitest-1e` first, and the full 27-file sequence is exactly reversed.
 * Descending is the one that fills the visible top of the table first, which is
 * the whole point of ordering the fetches at all; ascending would fill it last.
 * `test/try-view.test.ts` asserts the fetch order, not the table order, because
 * only the former can fail.
 *
 * ## `commonMessage`, and the crash fallback
 *
 * The inline message under a test path appears only when **every** instance
 * that recorded a message recorded the *same* one (`old/try.html:1538`) — a summary
 * line that showed one of several different messages would be worse than none.
 * Note the asymmetry the crash fallback introduces (`:1543`): the message rule
 * ignores instances with no message, while the signature rule requires
 * `crashSigs.length === entry.instances.length`, so one crash without a
 * signature suppresses the line. Preserved as written.
 */
export function aggregateFailures(
    allTimings: readonly Timing[],
    options: {
        globalPlatforms: Set<string>;
        globalBuildTypes: Set<string>;
        /** jobName -> completed runs of it, across the whole push. */
        jobRunCounts: ReadonlyMap<string, number>;
    }
): Failures {
    const testMap = new Map<string, FailingTest>();

    for (const timing of allTimings) {
        if (!isFailureStatus(timing.status)) {
            continue;
        }
        let entry = testMap.get(timing.path);
        if (entry === undefined) {
            entry = {
                path: timing.path,
                instances: [],
                statuses: new Set(),
                jobs: new Set(),
                platforms: new Set(),
                buildTypes: new Set(),
                intermittentCount: 0,
                totalJobs: 0,
                totalRuns: 0,
                outcomes: {
                    failedTwice: 0,
                    passedOnRetry: 0,
                    failedOnce: 0,
                    passed: 0,
                    notAnalyzed: 0,
                },
                sortedPlatforms: [],
                sortedBuildTypes: [],
            };
            testMap.set(timing.path, entry);
        }
        entry.instances.push(timing);
        entry.statuses.add(baseStatus(timing.status));
        // Platforms and builds are taken once per job name, not once per
        // instance: two failures in the same job say nothing new about which
        // platform it was.
        if (!entry.jobs.has(timing.jobName)) {
            entry.jobs.add(timing.jobName);
            entry.platforms.add(extractPlatform(timing.jobName));
            for (const buildType of extractBuildTypes(timing.jobName)) {
                entry.buildTypes.add(buildType);
            }
        }
    }

    // Every parsed execution of each failing test, by job name and job run.
    // Unlike `instances` this keeps the PASSING executions too, which is what
    // makes the harness's reruns visible in the tooltip and the debug JSON.
    const execsByTest = new Map<string, Map<string, Map<string, Timing[]>>>();
    for (const timing of allTimings) {
        if (!testMap.has(timing.path)) {
            continue;
        }
        let byJob = execsByTest.get(timing.path);
        if (byJob === undefined) {
            byJob = new Map();
            execsByTest.set(timing.path, byJob);
        }
        let byRun = byJob.get(timing.jobName);
        if (byRun === undefined) {
            byRun = new Map();
            byJob.set(timing.jobName, byRun);
        }
        const runKey = runKeyOf(timing);
        let execs = byRun.get(runKey);
        if (execs === undefined) {
            execs = [];
            byRun.set(runKey, execs);
        }
        execs.push(timing);
    }

    for (const entry of testMap.values()) {
        const messages = entry.instances
            .map((instance) => instance.message)
            .filter((message): message is string => Boolean(message));
        if (messages.length > 0 && messages.every((message) => message === messages[0])) {
            entry.commonMessage = messages[0];
        }
        if (entry.commonMessage === undefined) {
            const crashSigs = entry.instances
                .map((instance) => instance.crashSignature)
                .filter((signature): signature is string => Boolean(signature));
            if (
                crashSigs.length > 0 &&
                crashSigs.length === entry.instances.length &&
                crashSigs.every((signature) => signature === crashSigs[0])
            ) {
                entry.commonMessage = crashSigs[0];
            }
        }
        entry.intermittentCount = entry.instances.filter(
            (instance) => instance.intermittent === true
        ).length;

        const byJob = execsByTest.get(entry.path);
        // Only the configs it FAILED on. See `totalJobs`'s comment.
        for (const jobName of entry.jobs) {
            const jobRuns = options.jobRunCounts.get(jobName) ?? 0;
            const runs = byJob?.get(jobName);
            entry.totalJobs += jobRuns;
            // `totalRuns` counts EXECUTIONS, unlike the buckets below, which
            // count job runs — the harness reruns a failing test, so one run
            // can hold two. Both are wanted: the tooltip says "ran 36 times and
            // failed 18 times, in 18 jobs" and needs all three numbers.
            for (const execs of runs?.values() ?? []) {
                entry.totalRuns += execs.length;
            }
            entry.totalRuns += Math.max(0, jobRuns - (runs?.size ?? 0));
        }
        // The bucketing itself is `lib/model/try-jobs.ts`'s, shared with
        // `fx-tests try` — the CLI printed a bare `18/18` for a test that
        // passed on rerun in all 18 of those runs, which is the fraction this
        // breakdown exists to qualify, and it could only gain it by sharing.
        entry.outcomes = runOutcomes<Timing>(
            byJob ?? new Map(),
            entry.jobs,
            options.jobRunCounts,
            (timing) => timing.isRetry === true
        );
        entry.sortedPlatforms = sortedPlatforms(entry.platforms);
        entry.sortedBuildTypes = sortedBuildTypes(entry.buildTypes);
    }

    const tests = [...testMap.values()];
    tests.sort((a, b) => b.instances.length - a.instances.length);

    return {
        tests,
        globalPlatforms: options.globalPlatforms,
        globalBuildTypes: options.globalBuildTypes,
        execsByTest,
    };
}

// --- search ---------------------------------------------------------------

/** A parsed search box value. `old/try.html:1693`. */
export interface SearchTerm {
    /** Already lower-cased, with any leading `!` removed. */
    term: string;
    /** A leading `!` inverts the match. */
    negate: boolean;
}

/**
 * Parses the search box's raw value.
 *
 * A leading `!` negates. Note that `!` alone gives `{ term: '', negate: true }`
 * and `term === ''` is what every caller tests for "no filter", so a bare `!`
 * filters nothing rather than hiding everything — upstream's behaviour, since
 * `if (currentSearchTerm)` guards the filter (`old/try.html:1720`).
 */
export function parseSearch(raw: string): SearchTerm {
    const lower = raw.toLowerCase();
    const negate = lower.startsWith('!');
    return { term: negate ? lower.slice(1) : lower, negate };
}

/**
 * The tests a search leaves visible. `old/try.html:1718`.
 *
 * Matches the path, any instance's **message**, or any instance's **job name** —
 * three fields, so `!linux` hides every test that failed on Linux and `timeout`
 * finds tests by their failure text rather than only by name.
 *
 * This is display-only for the tables, but `sendAllRunRequests` and
 * `markNoMatchTests` also iterate it (`old/try.html:3368`, `:3421`, `:3435`), so
 * the search box **scopes which tests get reproduced locally** as well as which
 * are shown. That is not obvious from the control and is preserved.
 */
export function filterTests(
    tests: readonly FailingTest[],
    search: SearchTerm
): FailingTest[] {
    if (!search.term) {
        return [...tests];
    }
    const matches = (test: FailingTest): boolean =>
        test.path.toLowerCase().includes(search.term) ||
        test.instances.some((instance) =>
            instance.message?.toLowerCase().includes(search.term) === true
        ) ||
        test.instances.some((instance) =>
            instance.jobName.toLowerCase().includes(search.term)
        );
    return tests.filter((test) => (search.negate ? !matches(test) : matches(test)));
}

// --- sorting --------------------------------------------------------------

/** The four sortable columns. */
export type SortColumn = 'count' | 'flakiness' | 'test' | 'status';

/** The sort state. */
export interface SortState {
    column: SortColumn;
    ascending: boolean;
}

/**
 * The page's initial sort. `old/try.html:744`.
 *
 * `count` descending, where count is **failing executions**
 * (`a.instances.length`, `old/try.html:1749`) and not distinct job runs. See
 * `FailingTest.instances`.
 */
export function initialSort(): SortState {
    return { column: 'count', ascending: false };
}

/**
 * What clicking a column header does. `old/try.html:2550`.
 *
 * Clicking the active column flips the direction; clicking a new one selects
 * it, ascending **only** for `test`. The asymmetry is deliberate and is the
 * right default in each case: a-to-z is what a reader wants from a path column,
 * and most-failures-first is what they want from every other one.
 */
export function nextSort(current: SortState, column: SortColumn): SortState {
    if (current.column === column) {
        return { column, ascending: !current.ascending };
    }
    return { column, ascending: column === 'test' };
}

/** What the comparator needs to know about a test's flakiness, if anything. */
export interface FlakinessLookup {
    /** The headline rate, or `null` when the test has no flakiness data yet. */
    (path: string): number | null;
}

/**
 * Sorts the tests for display. `old/try.html:1747`.
 *
 * Four keys, and two of them need stating:
 *
 * - **`count` is `instances.length`** — failing executions. Ranking on distinct
 *   job runs instead produces the same set in a different order, which is the
 *   one defect class `PARITY.md` §1 says a value diff cannot catch.
 * - **`status` sorts on the alphabetised, comma-joined status set**, so
 *   `CRASH,FAIL` sorts before `FAIL` and before `TIMEOUT`. Not a severity order
 *   — it groups rows that failed the same *way*, which is what the column is
 *   for.
 *
 * A test with no flakiness data yet sorts as `-1` (`old/try.html:1753`), below every
 * real rate including 0%. The data arrives asynchronously per bucket file, so
 * during loading the unresolved rows collect at the bottom of a descending sort
 * and the table visibly fills in from the top.
 *
 * ## Ties
 *
 * **No tiebreak. Equal keys keep their input order**, which is
 * `aggregateFailures`'s `testMap` insertion order — and that is
 * `allTimings` order, which is *not deterministic*. This is upstream's
 * behaviour, faithfully, and it is worth writing down rather than leaving to
 * the reader because it is the difference between "the two pages disagree" and
 * "the page disagrees with itself".
 *
 * The mechanism, confirmed in code: `allTimings.push(...timings)`
 * (`old/try.html:1117`, transliterated at `site/try.ts:623`) appends each profile
 * worker's results **in worker-completion order**. Eight workers parse profiles
 * fetched 64 at a time, so the append order is a network and scheduler race.
 * Pinning the data does not fix it — the fetches are still concurrent.
 *
 * Measured in Chrome, both pages reloaded four times each against one pinned
 * snapshot, with every unpinned request failing hard (0 reached the network):
 *
 * - `09028ab93fe1` (71 rows): **stable**. 0 of 71 positions differ, old against
 *   itself, new against itself, and old against new. A push this size finishes
 *   its fetches in a consistent order — but see below, this is luck, not a
 *   guarantee.
 * - `717fc67feaa071` (431 rows): the old page disagrees **with itself** by
 *   112, 163 and 166 of 431 positions across three reloads. The new page
 *   disagrees with itself by 88-116. Old-against-new spans 104-181 — the same
 *   magnitude, so the two pages are indistinguishable from one page reloaded.
 * - **Zero unequal-count differences in any of the twelve comparisons.** Every
 *   differing index was a tie. That is the assertion worth keeping: the order
 *   is unstable *only* where the sort key does not decide it.
 *
 * A harness that diffs raw row order on a large push is therefore measuring the
 * network, not the code, and will report ~30% of rows as defects at random.
 * Normalising ties before diffing is not papering over a difference; it is the
 * only way to see one.
 *
 * So a parity harness must normalise ties before diffing; a diff that does not
 * is measuring the network. The CLI takes the other route and **breaks ties on
 * the path** (`cli/commands/try.ts:1027-1036`) precisely because output that is
 * diffed and pasted into bugs cannot be non-deterministic. `PARITY.md` §5
 * already declares that as a permitted divergence. This function does *not*
 * adopt the CLI's tiebreak: it would be a real ordering change against the page
 * it is migrating, and this file's contract is the page.
 */
export function sortTests(
    tests: readonly FailingTest[],
    sort: SortState,
    flakinessRate: FlakinessLookup
): FailingTest[] {
    const { column, ascending } = sort;
    return [...tests].sort((a, b) => {
        if (column === 'test') {
            return ascending ? a.path.localeCompare(b.path) : b.path.localeCompare(a.path);
        }
        if (column === 'status') {
            const va = [...a.statuses].sort().join(',');
            const vb = [...b.statuses].sort().join(',');
            return ascending ? va.localeCompare(vb) : vb.localeCompare(va);
        }
        const va =
            column === 'count' ? a.instances.length : (flakinessRate(a.path) ?? -1);
        const vb =
            column === 'count' ? b.instances.length : (flakinessRate(b.path) ?? -1);
        return ascending ? va - vb : vb - va;
    });
}

/**
 * Splits the sorted tests into the two tables. `old/try.html:1765`.
 *
 * **Data-driven, not a toggle.** A test is intermittent only when *every* one of
 * its failing executions was intermittent; one permanent instance keeps the
 * whole test in the permanent table. That asymmetry is the point of the split —
 * the permanent table is the one that must not miss anything, so it takes any
 * test with a permanent failure anywhere.
 */
export function splitTables(tests: readonly FailingTest[]): {
    permanent: FailingTest[];
    intermittent: FailingTest[];
} {
    return {
        permanent: tests.filter((test) => test.intermittentCount !== test.instances.length),
        intermittent: tests.filter((test) => test.intermittentCount === test.instances.length),
    };
}

/**
 * Whether the "Permanent failures" heading is drawn. `old/try.html:1772`.
 *
 * Only when another section follows it: a lone table needs no header, and the
 * page reads better without one. So the heading appears and disappears as the
 * *other* tables gain and lose rows, which is surprising until stated.
 */
export function needsPermanentHeader(
    intermittentCount: number,
    unblamedCount: number
): boolean {
    return intermittentCount > 0 || unblamedCount > 0;
}

/** The `count-cell` colour class. `old/try.html:1864`. */
export function countClass(count: number): string {
    return count >= 5 ? 'high' : count >= 2 ? 'medium' : 'low';
}

// --- the summary cards ----------------------------------------------------

/** One summary card. */
export interface SummaryCard {
    label: string;
    value: string;
    /** `red`, `orange`, or `''`. */
    valueClass: string;
    /** True for the Intermittent card, whose label carries the mitten glyph. */
    labelHasMitten?: boolean;
}

/**
 * The cards above the tables. `old/try.html:1663`.
 *
 * **`Total Failures` is the sum of `instances.length`** — failing executions
 * again, so it exceeds `Unique Failing Tests` and can exceed the number of
 * failed jobs. The Intermittent card is drawn **only** when the count is
 * non-zero, so the row has four or five cards.
 */
export function summaryCards(
    failures: Failures,
    options: { totalJobs: number; failedJobCount: number }
): SummaryCard[] {
    const totalFailures = failures.tests.reduce((sum, test) => sum + test.instances.length, 0);
    const intermittentTests = failures.tests.filter(
        (test) => test.intermittentCount === test.instances.length
    ).length;
    const cards: SummaryCard[] = [
        { label: 'Total Jobs', value: String(options.totalJobs), valueClass: '' },
        { label: 'Failed Test Jobs', value: String(options.failedJobCount), valueClass: 'red' },
        {
            label: 'Unique Failing Tests',
            value: String(failures.tests.length),
            valueClass: 'orange',
        },
        { label: 'Total Failures', value: String(totalFailures), valueClass: 'red' },
    ];
    if (intermittentTests > 0) {
        cards.push({
            label: 'Intermittent ',
            value: String(intermittentTests),
            valueClass: 'orange',
            labelHasMitten: true,
        });
    }
    return cards;
}

/**
 * Whether a test's badges cover every configuration the push processed.
 *
 * `summaryPlatformBadges` / `summaryBuildBadges` (`old/try.html:1596`, `:1606`).
 * When they do, the cell shows `4/4` in grey instead of four badges — a row
 * that failed everywhere says more by saying "everywhere" than by drawing the
 * whole legend again.
 */
export function coversAll(values: readonly string[], global: ReadonlySet<string>): boolean {
    return values.length === global.size && values.every((value) => global.has(value));
}

// --- the run-count tooltip ------------------------------------------------

/** English pluralisation, upstream's one-liner. `old/try.html:1797`. */
function s(n: number): string {
    return n === 1 ? '' : 's';
}

/**
 * The `#` column's tooltip on an intermittent row. `old/try.html:1796`.
 *
 * Summarises what happened to the test across the push: how many times it ran,
 * how often it failed, and how each job run ended. The five buckets count **job
 * runs** and sum to `totalJobs`, while the failure count counts **executions**
 * — the harness reruns a failing test, so one job run can hold two failures and
 * the two totals legitimately differ. Saying both in one sentence is what makes
 * that readable rather than looking like an inconsistency.
 *
 * Only the non-zero buckets get a line, so a row with a single outcome reads as
 * two lines rather than six.
 */
export function runCountTooltip(test: FailingTest): string {
    const { failedTwice, passedOnRetry, failedOnce, passed, notAnalyzed } = test.outcomes;
    const jobs = failedTwice + passedOnRetry + failedOnce + passed + notAnalyzed;
    const failures = test.instances.length;
    const names = test.jobs.size;
    const lines = [
        `Ran ${test.totalRuns} time${s(test.totalRuns)} and failed ${failures} ` +
            `time${s(failures)}, in ${jobs} job${s(jobs)} across ` +
            `${names} configuration${s(names)}:`,
    ];
    const job = (n: number): string => `${n} job${s(n)}`;
    if (failedTwice) {
        lines.push(`• ${job(failedTwice)}: failed, then failed again when retried`);
    }
    if (passedOnRetry) {
        lines.push(`• ${job(passedOnRetry)}: failed, then passed when retried`);
    }
    if (failedOnce) {
        lines.push(`• ${job(failedOnce)}: failed, not retried`);
    }
    if (passed) {
        lines.push(`• ${job(passed)}: passed`);
    }
    if (notAnalyzed) {
        lines.push(`• ${job(notAnalyzed)}: not analyzed`);
    }
    return lines.join('\n');
}

// --- flakiness ------------------------------------------------------------

/** Re-exported for `site/try.ts` and `test/try-view.test.ts`. */
export {
    HISTORY_DAYS,
    MAX_TOOLTIP_CONFIGS,
    MIN_RECENT_RUNS,
    type FlakinessData,
    type HeadlineRate,
    dayCount,
    flakinessTooltip,
    formatFailRate,
    pickHeadlineRate,
} from '../lib/query/flakiness-rate.ts';

/**
 * What the flakiness cell shows for one test.
 *
 * `className` is **not** redundant with the two booleans, though it overlaps
 * them. It is read verbatim by the renderer (`site/try.ts`, which assigns it to
 * `cell.className`) and it carries a third state the booleans do not:
 * `flaky-few-runs`, from `headline.lowConfidence`, which no other field exposes.
 * `isNewWarning` and `hasMitten` exist because the renderer must *branch* on
 * them — one picks the glyph, the other prepends the mitten element — and
 * re-deriving those by string-matching the class list would be worse.
 */
export interface FlakinessCell {
    /**
     * The `flakiness-cell …` class list, assigned as-is. Encodes three axes:
     * `flaky-new` / `flaky-msg` / `flaky`, plus an optional `flaky-few-runs`.
     */
    className: string;
    /** The link's text: a percentage, or the ⚠️ glyph. */
    text: string;
    /** Whether `text` is the warning glyph rather than a rate. */
    isNewWarning: boolean;
    /** Whether the mitten precedes the rate. */
    hasMitten: boolean;
    /** The link's `title`. */
    tooltip: string;
}

/**
 * The flakiness cell for one test's history. `old/try.html:2848`.
 *
 * Three states, and the first is the one worth noticing: a test with a **0%**
 * 21-day failure rate gets the ⚠️ glyph and the `flaky-new` class rather than
 * `0.0%`. The cell's job is to answer "is this pre-existing", and "this test has
 * never failed in 21 days" is the strongest possible *no* — printing `0.0%` next
 * to `18.1%` on the row above would bury it.
 *
 * Note the denominator: `failRate` here is the **all-failure** rate over the
 * whole window, not the same-message rate the headline uses. So a test that
 * fails often for an unrelated reason takes the third branch and shows a
 * headline rate that may itself be 0.0%.
 *
 * Returns `null` for a test with no history at all — the worker found no such
 * test in either harness's bucket — and the cell is then blanked.
 */
export function flakinessCell(data: FlakinessData | null): FlakinessCell | null {
    if (data === null) {
        return null;
    }
    const { stats, configs, hasMatchingMessage, totalDays } = data;
    const failCount = stats.failCount + stats.crashCount + stats.timeoutCount;
    const failRate = stats.runCount > 0 ? (failCount / stats.runCount) * 100 : 0;

    if (failRate === 0) {
        return {
            className: 'flakiness-cell flaky-new',
            text: '⚠️',
            isNewWarning: true,
            hasMitten: false,
            tooltip:
                `${stats.runCount} runs, 100% pass rate over ${totalDays || HISTORY_DAYS} days ` +
                '— this failure is new',
        };
    }
    const headline = pickHeadlineRate(stats, configs);
    return {
        className:
            'flakiness-cell ' +
            (hasMatchingMessage ? 'flaky-msg' : 'flaky') +
            (headline.lowConfidence === true ? ' flaky-few-runs' : ''),
        text: formatFailRate(headline.rate),
        isNewWarning: false,
        hasMitten: hasMatchingMessage,
        tooltip: flakinessTooltip(stats, configs, headline, hasMatchingMessage, totalDays),
    };
}

// --- the unblamed-jobs table ----------------------------------------------

/**
 * Drops the noise from a job's Treeherder bug-suggestion lines.
 * `old/try.html:2023`.
 *
 * Two rules. `exit status N` is dropped unless it is the only line — on its own
 * it is all the information there is, next to a real failure it is a
 * consequence. And everything *between* `Aborting task` and `task aborted` is
 * dropped while both bookends are kept: a task that hit its time limit logs
 * whatever it was doing, which is a hundred lines of nothing to do with the
 * failure.
 */
export function cleanFailureSummary(lines: readonly string[]): string[] {
    const cleaned =
        lines.length > 1
            ? lines.filter((line) => !/^\[taskcluster:error\] exit status \d+$/.test(line))
            : [...lines];

    const result: string[] = [];
    let skipping = false;
    for (const line of cleaned) {
        if (/^\[taskcluster:error\] Aborting task/.test(line)) {
            result.push(line);
            skipping = true;
            continue;
        }
        if (skipping) {
            if (/^\[taskcluster:error\] task aborted/.test(line)) {
                result.push(line);
                skipping = false;
            }
            continue;
        }
        result.push(line);
    }
    return result;
}

/**
 * The key jobs are grouped by. `old/try.html:2050`.
 *
 * The cleaned summary with crash UUIDs stripped, so twenty jobs that all crashed
 * with the same signature become one row saying `20` instead of twenty rows of
 * one. The UUID is the only part that differs between them and it is per-crash,
 * not per-signature.
 */
export function failureSummaryGroupKey(lines: readonly string[]): string {
    return cleanFailureSummary(lines)
        .map((line) => line.replace(/^(PROCESS-CRASH \| )[0-9a-f-]{36} \| /, '$1'))
        .join('\n');
}

/** One group of unblamed jobs. */
export interface UnblamedGroup {
    key: string;
    /** The group key split back into lines — what the row displays. */
    lines: string[];
    jobs: Job[];
}

/**
 * Groups the unblamed jobs by failure summary. `old/try.html:1941`.
 *
 * Insertion-ordered, which the sort below then reorders; the grouping itself
 * preserves the order `currentUnblamedJobs` came in.
 */
export function groupUnblamedJobs(
    jobs: readonly Job[],
    summaries: readonly string[][]
): Map<string, UnblamedGroup> {
    const groups = new Map<string, UnblamedGroup>();
    for (const [index, job] of jobs.entries()) {
        const key = failureSummaryGroupKey(summaries[index] ?? []);
        let group = groups.get(key);
        if (group === undefined) {
            group = { key, lines: key.split('\n'), jobs: [] };
            groups.set(key, group);
        }
        group.jobs.push(job);
    }
    return groups;
}

/**
 * Filters and orders the unblamed groups for display. `old/try.html:1964-1981`.
 *
 * The search matches a job's **name** or any line of the group's summary, and
 * filters *within* a group — a group all of whose jobs are filtered out
 * disappears entirely. Then the groups are ordered by `jobs.length` descending,
 * which is **not** configurable: this table has no sortable headers
 * (`old/try.html:1955-1960` marks every one `no-sort`), and the count is the only
 * thing worth ranking twenty identical crash rows by.
 */
export function visibleUnblamedGroups(
    groups: ReadonlyMap<string, UnblamedGroup>,
    search: SearchTerm
): UnblamedGroup[] {
    const filtered: UnblamedGroup[] = [];
    for (const group of groups.values()) {
        const jobs = search.term
            ? group.jobs.filter((job) => {
                  const matches =
                      job.jobName.toLowerCase().includes(search.term) ||
                      group.lines.some((line) => line.toLowerCase().includes(search.term));
                  return search.negate ? !matches : matches;
              })
            : group.jobs;
        if (jobs.length > 0) {
            filtered.push({ key: group.key, lines: group.lines, jobs });
        }
    }
    return filtered.sort((a, b) => b.jobs.length - a.jobs.length);
}

// --- uploaded failure profiles --------------------------------------------

/**
 * The artifact filename from a "profile uploaded in …" message, or `null`.
 * `old/try.html:2902`.
 *
 * When a test fails, the harness captures a Gecko profile at that moment and
 * uploads it, logging a message naming the file. That message is *not* shown as
 * an assertion line — the profiler icon is shown instead — so this predicate is
 * doing two jobs: finding the profile, and suppressing the line.
 *
 * `lib/links.ts` has `uploadedProfileName`, which is the same regex. Not
 * imported, because the page needs it in the *worker* too and the worker's
 * bundle should not pull in the link builders; see `site/try-worker.ts`.
 * Both accept `.json` and `.json.gz`, and a change to one is a change to the
 * other — `lib/links.ts` explains why the `.gz` branch is load-bearing.
 */
export function extractUploadedProfileName(message: string | null | undefined): string | null {
    const match = message?.match(/profile uploaded in (profile_\S+\.json(?:\.gz)?)/);
    return match ? match[1]! : null;
}

/** An uploaded failure profile, located. */
export interface UploadedProfile {
    taskId: string;
    retryId: number;
    filename: string;
    jobName: string;
}

/** Every message logged on an instance. `old/try.html:2911`. */
export function messagesOf(instance: Timing): string[] {
    if (instance.allMessages.length > 0) {
        return instance.allMessages.map((message) => message.message);
    }
    return instance.message ? [instance.message] : [];
}

/**
 * The failure profile one execution uploaded, or `null`. `old/try.html:2934`.
 *
 * Per-instance, because each run uploads its own artifact — a test that failed
 * in two jobs has two profiles and the row's icon must open the right one.
 */
export function instanceUploadedProfile(instance: Timing): UploadedProfile | null {
    for (const message of messagesOf(instance)) {
        const filename = extractUploadedProfileName(message);
        if (filename !== null) {
            return {
                taskId: instance.taskId,
                retryId: instance.retryId,
                filename,
                jobName: instance.jobName,
            };
        }
    }
    return null;
}

/** The first instance that uploaded a profile, or `null`. `old/try.html:2945`. */
export function findUploadedProfile(instances: readonly Timing[]): UploadedProfile | null {
    for (const instance of instances) {
        const profile = instanceUploadedProfile(instance);
        if (profile !== null) {
            return profile;
        }
    }
    return null;
}

/**
 * The messages logged on a set of instances, deduped. `old/try.html:2919`.
 *
 * The "profile uploaded" notice is excluded — it is shown as an icon, and
 * repeating it in a copied debugging prompt would waste the reader's attention
 * on a line that is already a link.
 */
export function instanceMessages(instances: readonly Timing[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const instance of instances) {
        for (const message of messagesOf(instance)) {
            if (!message || extractUploadedProfileName(message) !== null || seen.has(message)) {
                continue;
            }
            seen.add(message);
            out.push(message);
        }
    }
    return out;
}

// --- the empty state ------------------------------------------------------

/** The `no-failures` block's parts. `old/try.html:1830`. */
export interface NoFailuresText {
    verdict: string;
    caveat: string;
    /** Whether the caveat carries the Treeherder link. */
    caveatHasLink: boolean;
}

/**
 * The empty state, for the permanent table and for a push with no test failures
 * at all. `old/try.html:1830`.
 *
 * The verdict differs between the two — "No test failures" against "No permanent
 * failures" — because they are different claims and the second one is weaker.
 * Either way the caveat names the harnesses this page covers, and when some
 * *other* job failed it says so and links Treeherder: a green verdict next to a
 * busted build is the one way this page could actively mislead.
 */
export function noFailuresText(options: {
    noTestFailuresAtAll: boolean;
    otherFailedJobCount: number;
}): NoFailuresText {
    const harnesses = SUPPORTED_HARNESSES.join(' and ');
    const verdict = options.noTestFailuresAtAll ? 'No test failures' : 'No permanent failures';
    const others = options.otherFailedJobCount;
    if (others > 0) {
        const jobs = others === 1 ? '1 other job' : `${others} other jobs`;
        return {
            verdict: `${verdict} — the patches might be ready to land.`,
            caveat: `But this page only covers ${harnesses}, and ${jobs} failed: `,
            caveatHasLink: true,
        };
    }
    return {
        verdict: `${verdict} — the patches might be ready to land.`,
        caveat: `This page only covers ${harnesses} failures.`,
        caveatHasLink: false,
    };
}

// --- URL state ------------------------------------------------------------

/**
 * The page's URL state. `old/try.html:1249`, `:3760`.
 *
 * **Query only, no hash.** `test.html` and `crash-viewer.html` both use the
 * hash; this page does not, and the difference is deliberate on upstream's
 * part: `updateUrlState` writes with `history.replaceState`, so a hash would
 * have made every filter keystroke a navigation target.
 */
export interface UrlState {
    /** The revision. Nothing loads without it. */
    rev: string | null;
    /** The Treeherder project. Absent from the URL when it is `try`. */
    repo: string;
    /** The search box's raw value. */
    filter: string;
    /** Presence-only: `?alljobs=1`, and any value counts as on. */
    allJobs: boolean;
}

/** Reads the state out of a query string. `old/try.html:3760`. */
export function readUrlState(search: string): UrlState {
    const params = new URLSearchParams(search);
    return {
        rev: params.get('rev'),
        repo: params.get('repo') ?? 'try',
        filter: params.get('filter') ?? '',
        // `has`, not a value test: the checkbox is set explicitly from this
        // rather than only when present, so a browser-preserved checkbox state
        // cannot disagree with the URL after a reload (`old/try.html:3772`).
        allJobs: params.has('alljobs'),
    };
}

/**
 * Applies the state to a URL's query. `old/try.html:1249`.
 *
 * Each parameter is **deleted** when it holds its default, rather than written
 * as an empty value — so the URL of an unfiltered `try` push is
 * `?rev=abc123` and nothing else, which is what gets pasted into a bug.
 */
export function writeUrlState(url: URL, state: UrlState): void {
    if (state.rev) {
        url.searchParams.set('rev', state.rev);
    } else {
        url.searchParams.delete('rev');
    }
    if (state.repo !== 'try') {
        url.searchParams.set('repo', state.repo);
    } else {
        url.searchParams.delete('repo');
    }
    if (state.filter) {
        url.searchParams.set('filter', state.filter);
    } else {
        url.searchParams.delete('filter');
    }
    if (state.allJobs) {
        url.searchParams.set('alljobs', '1');
    } else {
        url.searchParams.delete('alljobs');
    }
}

/**
 * Pulls the revision, and possibly the repository, out of whatever was typed.
 * `old/try.html:1212`.
 *
 * Five accepted shapes, tried in order. The `repo:rev` prefix is checked
 * **first** and unconditionally resets the repository to `try` when absent,
 * which is what makes typing a bare revision after loading an autoland push go
 * back to try rather than silently staying on autoland.
 *
 * The final `return input` is a deliberate non-validation: an unrecognised
 * string is handed to Treeherder, which answers with a 404 the page reports as
 * "No push found for revision …". Rejecting it here would mean maintaining a
 * second opinion about what a revision looks like.
 */
export function extractRevision(raw: string): { revision: string; repo: string } {
    let input = raw.trim();
    let repo = 'try';
    const prefixMatch = /^([a-z][\w-]*):(.+)$/i.exec(input);
    if (prefixMatch) {
        repo = prefixMatch[1]!;
        input = prefixMatch[2]!.trim();
    }
    if (/^[a-f0-9]{40}$/i.test(input) || /^[a-f0-9]{12}$/i.test(input)) {
        return { revision: input, repo };
    }
    try {
        const url = new URL(input);
        const urlRepo = url.searchParams.get('repo');
        if (urlRepo) {
            repo = urlRepo;
        }
        const rev = url.searchParams.get('revision');
        if (rev) {
            return { revision: rev, repo };
        }
    } catch {
        // Not a URL; fall through to the hg path form.
    }
    const hgMatch = /hg\.mozilla\.org\/([^/]+(?:\/[^/]+)*)\/rev\/([a-f0-9]+)$/i.exec(input);
    if (hgMatch) {
        const repoPath = hgMatch[1]!;
        const repoMap: Record<string, string> = {
            'mozilla-central': 'mozilla-central',
            'integration/autoland': 'autoland',
            try: 'try',
        };
        repo = repoMap[repoPath] ?? repoPath.split('/').pop()!;
        return { revision: hgMatch[2]!, repo };
    }
    return { revision: input, repo };
}

/** hg.mozilla.org's path for a Treeherder repository name. `old/try.html:1624`. */
export function hgRepoPath(repo: string): string {
    const map: Record<string, string> = {
        'mozilla-central': 'mozilla-central',
        autoland: 'integration/autoland',
        try: 'try',
    };
    return map[repo] ?? repo;
}

// --- the console API ------------------------------------------------------

/** One entry of `window.failures`. `old/try.html:3685`. */
export interface ConsoleFailure {
    test: string;
    count: number;
    statuses: string[];
    /** The platform names, or the literal `'all'`. */
    platforms: string[] | 'all';
    buildTypes: string[] | 'all';
    flaky: boolean;
    message?: string | undefined;
}

/**
 * The `window.failures` list. `old/try.html:3659`.
 *
 * Note that this re-sorts with its **own** comparator (`old/try.html:3665`), which
 * is `renderTable`'s minus the `flakiness` branch — so `window.failures` after
 * clicking the flakiness header returns the tests in an order the page is not
 * showing. That is upstream's behaviour and is preserved rather than fixed: the
 * fix would be a behaviour change to a documented console seam, and the seam's
 * documented promise is "sorted as on page" for the sorts it knows about.
 *
 * `platforms`/`buildTypes` collapse to `'all'` under the same rule the badges
 * use, so the console output and the table agree about what "everywhere" means.
 */
export function consoleFailures(
    tests: readonly FailingTest[],
    failures: Failures
): ConsoleFailure[] {
    return tests.map((test) => ({
        test: test.path,
        count: test.instances.length,
        statuses: [...test.statuses],
        platforms: coversAll(test.sortedPlatforms, failures.globalPlatforms)
            ? 'all'
            : test.sortedPlatforms,
        buildTypes: coversAll(test.sortedBuildTypes, failures.globalBuildTypes)
            ? 'all'
            : test.sortedBuildTypes,
        flaky: test.intermittentCount === test.instances.length,
        message: test.commonMessage ? test.commonMessage.split('\n')[0] : undefined,
    }));
}

/** The comparator `window.failures` uses — no `flakiness` branch. */
export function sortConsoleFailures(
    tests: readonly FailingTest[],
    sort: SortState
): FailingTest[] {
    const { column, ascending } = sort;
    return [...tests].sort((a, b) => {
        if (column === 'test') {
            return ascending ? a.path.localeCompare(b.path) : b.path.localeCompare(a.path);
        }
        if (column === 'status') {
            const va = [...a.statuses].sort().join(',');
            const vb = [...b.statuses].sort().join(',');
            return ascending ? va.localeCompare(vb) : vb.localeCompare(va);
        }
        // `count` and `flakiness` both land here. Upstream's own comparator has
        // no `flakiness` branch, so `va`/`vb` are `undefined` there and the
        // subtraction is NaN — `Array.sort` treats a NaN comparator result as
        // 0, so the order is left as-is. Reproduced by falling through to
        // `count`, which is what "left as-is" means for a list that arrived in
        // count order. The measured difference on the pinned pushes: none, on
        // any of the four.
        const va = a.instances.length;
        const vb = b.instances.length;
        return ascending ? va - vb : vb - va;
    });
}

/** `formatForPrompt`. `old/try.html:3711`. */
export function formatForPrompt(list: readonly ConsoleFailure[]): string {
    return list
        .map((failure) => {
            let line = failure.test;
            line += failure.flaky ? ' is flaky' : ' permafails';
            const config: string[] = [];
            if (failure.platforms !== 'all') {
                config.push(failure.platforms.join(', '));
            }
            if (failure.buildTypes !== 'all') {
                config.push(failure.buildTypes.join(', '));
            }
            if (config.length > 0) {
                line += ' on ' + config.join(' ');
            }
            if (failure.message) {
                line += ' with `' + failure.message + '`';
            }
            return line;
        })
        .join('\n');
}

// --- the flakiness worker's plan ------------------------------------------

/** One test's request to the flakiness worker. */
export interface FlakinessRequest {
    path: string;
    /** Messages and crash signatures seen on this push. */
    tryMessages: string[];
    hasTimeout: boolean;
    hasCrash: boolean;
    /** Chunk-stripped job names — the configs this test failed on here. */
    jobNames: string[];
}

/**
 * Builds one flakiness request per failing test. `old/try.html:2636`.
 *
 * The `jobNames` are chunk-stripped because the 21-day aggregates store them
 * that way and a try push's do not (`lib/model/job-name.ts` measured the
 * consequence: 360,373 of 433,836 runs differed before stripping). Without it
 * every configuration would miss and the column would be empty.
 *
 * `hasTimeout` / `hasCrash` exist because those statuses frequently record no
 * message at all, so there would be nothing to match on; `computeConfigStats`
 * turns them into "any timeout counts" / "any crash counts".
 */
export function flakinessRequests(
    tests: readonly FailingTest[],
    stripChunk: (jobName: string) => string
): FlakinessRequest[] {
    return tests.map((test) => {
        const tryMessages = new Set<string>();
        let hasTimeout = false;
        let hasCrash = false;
        const jobNames = new Set<string>();
        for (const instance of test.instances) {
            if (instance.message) {
                tryMessages.add(instance.message);
            }
            if (instance.crashSignature) {
                tryMessages.add(instance.crashSignature);
            }
            if (instance.status.startsWith('TIMEOUT')) {
                hasTimeout = true;
            }
            if (instance.status.startsWith('CRASH')) {
                hasCrash = true;
            }
            jobNames.add(stripChunk(instance.jobName));
        }
        return {
            path: test.path,
            tryMessages: [...tryMessages],
            hasTimeout,
            hasCrash,
            jobNames: [...jobNames],
        };
    });
}

/**
 * Groups the requests by the bucket file that answers them, in table order.
 * `old/try.html:2654-2675`.
 *
 * The ordering is the useful part: chunks are sorted by the **position of their
 * highest-priority test in the table**, so the visible top of the table fills in
 * first. A push failing on 70 tests spread across 12 bucket files takes twelve
 * sequential fetches, and reading them in hash order would fill the table in a
 * random-looking sequence.
 */
export function groupRequestsByChunk(
    requests: readonly FlakinessRequest[],
    testOrder: ReadonlyMap<string, number>,
    fileOf: (path: string) => string
): [string, FlakinessRequest[]][] {
    const chunkMap = new Map<string, FlakinessRequest[]>();
    for (const request of requests) {
        const key = fileOf(request.path);
        let list = chunkMap.get(key);
        if (list === undefined) {
            list = [];
            chunkMap.set(key, list);
        }
        list.push(request);
    }
    return [...chunkMap.entries()].sort((a, b) => {
        const minA = Math.min(
            ...a[1].map((request) => testOrder.get(request.path) ?? Infinity)
        );
        const minB = Math.min(
            ...b[1].map((request) => testOrder.get(request.path) ?? Infinity)
        );
        return minA - minB;
    });
}
