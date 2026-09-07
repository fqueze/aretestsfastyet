/**
 * `fx-tests try <revision>` — triage a Try push.
 *
 * The command most useful to an agent that just pushed. It answers one
 * question: **which of these failures did my patch cause?**
 *
 * ## How the push's failures are obtained
 *
 * Not from an aggregate — the push's own results are not published as one.
 * `try.html` reads, per failed test job, the job's
 * `public/test_info/profile_resource-usage.json` artifact and extracts the
 * test-status markers from it (`old/try.html:955`, `profile-worker.js:112`). That
 * is the only source of per-test outcomes for a push, so this command does the
 * same. `parseTestMarkers()` (`lib/model/test-markers.ts`) is the port; it sits
 * in `lib/` because `fx-tests task` makes the same read against a single task.
 *
 * The cost is one artifact per failed job, which is why the command reports
 * progress and why `--limit` does not reduce the fetching — the classification
 * needs every failure before it can rank them.
 *
 * ## The three sections, and what separates them
 *
 * `CLI.md`'s split, in decreasing order of "this is probably yours":
 *
 * - **PERMA-FAILS** — failed in **every** run of at least one configuration.
 *   A fact about the push alone; each row is annotated with what central says
 *   about that same config, which is context for reading the row rather than
 *   grounds for hiding it. See `isPermaFail()`.
 * - **KNOWN INTERMITTENTS** — did not fail every run anywhere, and also fail
 *   on central. Likely not yours.
 * - **NEW INTERMITTENTS** — failed here, not seen failing on central, but not
 *   in every run. Worth a look.
 *
 * Two distinctions carry the weight, and both are easy to lose:
 *
 * **Passed on rerun.** A test that failed and then passed when the harness
 * reran it *within the same job* is intermittent almost by definition. The
 * profile records the rerun phase as a `retry` text marker, so a `PASS` marker
 * inside that range for a test that also failed is the signal
 * (`old/try.html:1393`). This is a within-job rerun, not the job-level `retryId`.
 *
 * **Same message.** A test that already fails 8% of the time on central, but
 * with a *different* message than the one in your push, is **not** exonerated.
 * `computeConfigStats`'s `tryMessages` option exists for this, and every
 * section reports the same-message rate alongside the overall one.
 */

import { bucketFileSuffix, bucketIndexForPath, type BucketFile, decodeBucket } from '../../lib/formats/buckets.ts';
import { computeConfigStats } from '../../lib/query/config-stats.ts';
import {
    MIN_RECENT_RUNS,
    type HeadlineRate,
    flakinessTooltip,
    pickHeadlineRate,
} from '../../lib/query/flakiness-rate.ts';
import { computeTestStats } from '../../lib/query/test-stats.ts';
import { stripChunkSuffix } from '../../lib/model/job-name.ts';
import { normalizeMessage } from '../../lib/model/failure-message.ts';
import {
    type DroppedMarker,
    type TestTiming,
    isStreamedProfile,
    parseTestMarkers,
} from '../../lib/model/test-markers.ts';
import {
    type RunOutcomes,
    baseStatus,
    isFailureStatus,
    runKeyOf,
    runOutcomes,
    selectTryJobs,
} from '../../lib/model/try-jobs.ts';
import { resourceUsageProfileUrl, testInfoArtifactUrl } from '../../lib/links.ts';
import { treeherderPushUrl } from '../../lib/links.ts';
import { type TreeherderJob } from '../../lib/sources/treeherder.ts';
import { fetchJson, timingsIndex } from '../../lib/sources/source.ts';
import { type OptionSpecs, type ParsedArgs, boolOption, stringOption } from '../args.ts';
import { type CommandContext, emit, progress, warn } from '../context.ts';
import { usageError } from '../errors.ts';
import { MESSAGE_CAP, messageLines } from '../format/failure-lines.ts';
import { toJson } from '../format/json.ts';
import * as md from '../format/markdown.ts';
import {
    applyLimit,
    fullPathLines,
    joinLines,
    moreLine,
    percent,
    table,
    tableWithPaths,
    truncate,
} from '../format/text.ts';
import { detectHarness } from '../options.ts';

/** Options `try` adds. */
export const TRY_OPTIONS: OptionSpecs = {
    project: {
        type: 'string',
        placeholder: '<try|autoland|…>',
        describe: 'The Treeherder repository the push is on. Default try.',
    },
    'perma-only': {
        type: 'boolean',
        describe: 'Only the perma-fail section — the highest-signal output.',
    },
    'all-jobs': {
        type: 'boolean',
        // Says what it fetches, what that buys, and what it costs. The page's
        // tooltip is the model ("Also fetch profiles of test jobs that
        // ultimately succeeded, so tests that failed initially but passed on
        // retry surface too"); the cost clause is added because a terminal
        // gives no other warning before a run that reads tens of times more
        // artifacts. Kept to one line because the help printer does not wrap.
        describe:
            'Also read profiles of test jobs that SUCCEEDED, so a test that failed then ' +
            'passed on retry surfaces. Reads every test job: much slower.',
    },
    'other-jobs': {
        type: 'boolean',
        describe: 'List the non-test job failures (builds, lint) the header already counts.',
    },
    test: {
        type: 'string',
        placeholder: '<path>',
        describe:
            'Report one test per configuration: ran/pass/fail/skip/timeout. ' +
            'Needs --all-jobs for the pass counts.',
    },
    'task-ids': { type: 'boolean', describe: 'Print the task IDs behind each failure.' },
    profiles: { type: 'boolean', describe: 'Print raw profile artifact URLs.' },
    messages: {
        type: 'boolean',
        describe: `Print every failure message per row, not just the first (cap ${MESSAGE_CAP}).`,
    },
    concurrency: {
        type: 'number',
        placeholder: '<n>',
        describe: 'How many job profiles to fetch at once. Default 8.',
    },
};

/** Default rows per section. */
const DEFAULT_LIMIT = 10;

/**
 * What the perma-fail section promises, in both text and Markdown.
 *
 * Deliberately does not say "almost certainly yours". The section is no longer
 * filtered by central history, so it contains rows that are annotated on the
 * very next line as already failing the same way on central — claiming those
 * are the reader's doing would be false. What every row *does* have in common
 * is the push fact, so that is what the header states.
 */
const PERMA_FAIL_DESCRIPTION =
    'failed in every run of at least one configuration here. ' +
    'Each row says what central shows on that same configuration.';

/** How many artifacts to fetch at once. */
const DEFAULT_CONCURRENCY = 8;

/** One test failure on the push, aggregated across jobs. */
export interface TryFailure {
    path: string;
    /** Distinct configurations it failed on. */
    jobNames: string[];
    /**
     * Failing **executions** — the number this and `try.html` rank on.
     *
     * Not the same as `failedRuns`. The harness reruns a test that fails, so
     * one job run can hold several failing executions of it, and a test that
     * failed twice in one job is a worse failure than one that failed once.
     * `try.html`'s `count` column is `test.instances.length`
     * (`old/try.html:1869`), one entry per failing marker, and its default sort is
     * that column descending (`old/try.html:744`). Ranking on `failedRuns` instead
     * flattens every such test to its job count: measured on try push
     * 09028ab93fe1, that turned a top row of 4, 4, 3, 3, 3 into 2, 2, 2, 2, 2
     * and reordered the whole section.
     */
    failureCount: number;
    /**
     * Distinct **job runs** in which it failed.
     *
     * Not the denominator's unit. Kept because the perma-fail rule is on this
     * axis — "every run of this configuration failed" is a question about job
     * runs, and `permaFailingConfigs` compares this against `runsPerJobName`.
     */
    failedRuns: number;
    /**
     * **Executions** of the test across the configurations it failed on — the
     * denominator of the ratio, and the page's `totalRuns`.
     *
     * Executions, not job runs, and the distinction is the whole point:
     * `old/try.html:1557-1558` names the two fields apart, and `1e8b867` changed
     * the displayed ratio to this one precisely to stop rows reading `21 out of
     * 21`. The harness reruns a test that fails, so a FAIL followed by a PASS in
     * the rerun phase is **two** executions inside one job run, and a row where
     * every job run failed still reads `21/40` rather than `21/21`.
     *
     * Includes one execution for each run of those configurations whose profile
     * was not parsed (`old/try.html:1579`). That term is live rather than
     * theoretical: on push 7d16bff81bb1, 99 of the completed test jobs are
     * `exception` or `retry`, so they count as runs and yield no timings.
     */
    totalRuns: number;
    /**
     * Task runs of the configurations it failed on — the page's `totalJobs`.
     *
     * The quantity the CLI used to print as `totalRuns`. Carried as its own
     * field rather than dropped, because it is what the outcome buckets sum to
     * and what "failed on 3 of 4 runs of this config" is asked against.
     */
    totalJobs: number;
    /**
     * How each of those `totalJobs` **job runs** ended. Sums to `totalJobs`.
     *
     * A different unit from `totalRuns` above, which is why both are reported.
     * `old/try.html:1546` says it: "These buckets count job runs, so they sum to
     * totalJobs, not to the failure count."
     */
    outcomes: RunOutcomes;
    /**
     * True when at least one affected configuration failed in every run.
     *
     * Per-configuration on purpose: see `permaFailingConfigs`.
     */
    everyRunFailed: boolean;
    /**
     * The configurations on which every run failed, none succeeded, and the
     * harness's in-job rerun never passed. These are what makes the test a
     * perma-fail; a test can be one of these *and* intermittent elsewhere.
     */
    permaFailingConfigs: string[];
    /** True when the harness reran it in-job and it passed on some config. */
    passedOnRerun: boolean;
    /**
     * The configurations where the harness's in-job rerun turned it green.
     *
     * Named rather than reduced to a flag because a test can perma-fail on one
     * configuration and pass on rerun on another, and the unscoped sentence
     * read as a contradiction: on try push 09028ab93fe1, 33 of the 54
     * perma-fails were rows that said both "failed every run" and "passed when
     * the harness reran it". They are two facts about *different* configs —
     * `test_nimbus_newtabTrainhopAddon.js` failed both runs of
     * `test-windows11-64-25h2/opt-xpcshell` and passed on rerun on
     * `test-windows11-32-25h2/opt-xpcshell` — so the row has to say which.
     * Disjoint from `permaFailingConfigs` by construction: a config the rerun
     * turned green is excluded from the latter.
     */
    passedOnRerunConfigs: string[];
    /** One message per failing execution, most common first. */
    messages: string[];
    /** Every message the failing executions logged, with a count each. */
    allMessages: { message: string; count: number }[];
    /**
     * Whether the same-message comparison against central means anything.
     *
     * False when the push recorded no message and the status is not one that
     * matches on kind instead (timeout, crash). A `sameMessageFailCount` of 0
     * then means "nothing to compare", not "a different failure" — and the
     * difference decides which section a failure lands in. Measured: on
     * autoland push 7c06165ae50f70, 20 of 21 candidate perma-fails had no
     * message.
     */
    messageComparable: boolean;
    /**
     * The distinct **base** statuses seen, sorted — `FAIL`, not `FAIL-PARALLEL`.
     *
     * The phase suffix is stripped, as `site/try-view.ts` has always done: it
     * is one verdict in two phases, and this field answers which verdict. The
     * phase is reported by `parallelOnly`, which reads its own set.
     */
    statuses: string[];
    /** Only failed under parallel execution. */
    parallelOnly: boolean;
    /** What central says about this test. `null` when it has no data at all. */
    central: CentralHistory | null;
    taskIds?: { taskId: string; retryId: number; jobName: string }[];
    profiles?: {
        taskId: string;
        retryId: number;
        resourceUsage: string;
        testProfile?: string;
        /** All of them: an in-job rerun uploads a second with a `-2` suffix. */
        testProfiles?: string[];
    }[];
}

/** What the 21-day central aggregate says about a test. */
export interface CentralHistory {
    /** Runs and failures over the whole window, all configs. */
    runCount: number;
    failCount: number;
    failRate: number | null;
    /**
     * The failure rate counting **only** failures whose message matches one
     * from the push. The number that decides whether a known intermittent
     * exonerates this failure.
     */
    sameMessageFailCount: number;
    sameMessageFailRate: number | null;
    /** The worst affected config's overall rate, for the one-line summary. */
    worstConfig: { jobName: string; failRate: number; sameMsgFailRate: number } | null;
    /**
     * Same-message failures on central, restricted to the configurations on
     * which this push's failure was permanent (`permaFailingConfigs`).
     *
     * Separate from `sameMessageFailCount` because the two answer different
     * questions and only this one bears on the verdict. A test can fail the
     * same way on some *other* config for weeks without that saying anything
     * about the config where this push made it fail every single time.
     * `null` when the test perma-failed on no config, or when none of them
     * appears in central's history.
     */
    sameMessageFailCountOnPermaConfigs: number | null;
    /**
     * try.html's flakiness column (`lib/query/flakiness-rate.ts`), and the
     * tooltip explaining it. Read this for "does this failure pre-exist", not
     * `failRate` above, which is the whole-test, all-configuration rate.
     */
    headline: HeadlineRate;
    explanation: string;
    /**
     * How many of this push's configurations central has history for. 0 means
     * the explanation's "never seen in history" is about an empty population.
     */
    configsInHistory: number;
    /** Whether the test appears in central data at all. */
    known: boolean;
}

/** The `--json` shape `CLI.md` documents. */
export interface TryJson {
    revision: string;
    pushId: number;
    project: string;
    treeherderUrl: string;
    jobCount: number;
    failedJobCount: number;
    /**
     * How many job profiles were read, and whether the passing ones were among
     * them.
     *
     * In the output because it is the one thing a reader cannot infer from the
     * rows: an empty `newIntermittents` means "none found" under `--all-jobs`
     * and "none looked for" without it, and nothing else here distinguishes
     * the two.
     */
    profilesRead: number;
    /** Whether `--all-jobs` put the successful test jobs in the universe. */
    readPassingJobs: boolean;
    /**
     * Completed test jobs that passed — the ones `--all-jobs` adds.
     *
     * Reported whether or not the flag was given, because it is the size of
     * what the default did not look at, and it is what makes the "run with
     * --all-jobs" hint honest about the cost.
     */
    passingTestJobCount: number;
    /** Failed test jobs whose profile yielded no test-level failure. */
    unblamedJobCount: number;
    /** Jobs that failed but are not test jobs — builds, lint. */
    otherFailedJobs: { jobName: string; taskId: string; result: string }[];
    permaFails: TryFailure[];
    knownIntermittents: TryFailure[];
    newIntermittents: TryFailure[];
}

/** Runs the command. */
export async function runTry(context: CommandContext, args: ParsedArgs): Promise<void> {
    const revision = args.positionals[0];
    if (revision === undefined) {
        throw usageError(
            'try requires a revision',
            'Usage: fx-tests try <revision>, e.g. fx-tests try 4f2c1a9e8b3d'
        );
    }
    if (args.positionals.length > 1) {
        throw usageError(`try takes one revision, got ${args.positionals.length}`);
    }
    const treeherder = context.treeherder;
    if (treeherder === undefined) {
        throw new Error('try needs a Treeherder client but none was supplied');
    }
    const fetchUrl = context.fetchUrl;
    if (fetchUrl === undefined) {
        throw new Error('try needs a URL fetcher but none was supplied');
    }

    // Refused, not ignored: these sections are cross-configuration verdicts — a
    // perma-fail is "failed in every run of at least one configuration here" — so
    // filtering the job set redefines each heading rather than shortening it.
    if (context.globals.config.length > 0 || context.globals.excludeConfig.length > 0) {
        throw usageError(
            '--config cannot be applied to try: this command classifies a test across the ' +
                'configurations a push ran, so filtering the job set would change what each ' +
                'section means rather than narrow it',
            'The per-row config names and central comparison are already per configuration. ' +
                'For one test on one configuration over central, use ' +
                '`fx-tests test <path> --config <substring>`.'
        );
    }

    const project = stringOption(args, 'project') ?? 'try';

    progress(context, `Looking up ${revision} on ${project}…`);
    const push = await treeherder.findPush(project, revision);

    progress(context, `Fetching jobs for push ${push.pushId}…`);
    const jobs = await treeherder.jobsOfPush(push.pushId);

    // `--all-jobs` changes the UNIVERSE, not the rows, and `selectTryJobs` is
    // where that is decided — the same call `site/try.ts` makes for the "All
    // jobs" checkbox, so the two cannot answer it differently. It is off by
    // default on both sides for the reason `lib/model/try-jobs.ts` records: on
    // try push 7d16bff81bb1 it reads 1,584 profiles against 46.
    const selection = selectTryJobs(jobs, {
        readPassingJobs: boolOption(args, 'all-jobs'),
    });
    const { failedTestJobs, successfulTestJobs, otherFailedJobs, jobsToProcess } = selection;
    const { readPassingJobs, runsPerJobName } = selection;

    let timings: TestTiming[] = [];
    if (jobsToProcess.length > 0) {
        // "Reading", not "Fetching": the profiles are cached on disk after the
        // first run, so a warm run reads all 46 and downloads none. Printing
        // "Fetching 46 job profiles" there is what made the caching look
        // broken when it was working — it is the line the bug was reported
        // against. The command cannot say which it will be before it starts,
        // so it says the thing that is true either way.
        //
        // The count is `jobsToProcess`, not `failedTestJobs`: under
        // `--all-jobs` the two differ by a factor of tens, and a line naming
        // the smaller one while reading the larger set is the same defect the
        // "Fetching" wording was. The parenthetical states which set it is.
        progress(
            context,
            `Reading ${jobsToProcess.length} job profiles (one per ` +
                `${readPassingJobs ? 'completed test job, passing ones included' : 'failed test job'})…`
        );
        timings = await collectTimings(
            context,
            jobsToProcess,
            fetchUrl,
            Number(args.options.get('concurrency') ?? DEFAULT_CONCURRENCY)
        );
    }

    // Its own report: `try` otherwise shows only failures, so zero failures and
    // "never ran" look alike.
    const testPath = stringOption(args, 'test');
    if (testPath !== undefined) {
        emit(
            context,
            renderTestReport(
                context,
                push.revision,
                project,
                testPath,
                timings,
                runsPerJobName,
                readPassingJobs
            )
        );
        return;
    }

    const failures = aggregateFailures(timings, runsPerJobName);

    // Central history, one bucket file per distinct bucket the failing tests
    // land in. Failing tests cluster, so this is usually one or two files, not
    // one per test.
    if (failures.length > 0) {
        progress(context, `Comparing ${failures.length} failing tests against central…`);
        await attachCentralHistory(context, failures);
    }

    // Unconditional under `--json`; text and Markdown gate on the flags, where
    // these are line output rather than data. An absent key would make "no
    // tasks" and "you forgot a flag" the same observation.
    const asJson = context.globals.format === 'json';
    const withTaskIds = asJson || boolOption(args, 'task-ids');
    const withProfiles = asJson || boolOption(args, 'profiles');
    attachProvenance(failures, timings, withTaskIds, withProfiles);

    const blamed = new Set(
        timings.filter((timing) => isFailureStatus(timing.status)).map(runKeyOf)
    );
    // `runKeyOf` on the job, not a hand-written template: the key has to be the
    // one the timings were mapped through above, and this line spelled it out
    // itself only because the CLI's `runKeyOf` used to take a `TestTiming`.
    const unblamedJobCount = failedTestJobs.filter((job) => !blamed.has(runKeyOf(job))).length;

    const result: TryJson = {
        revision: push.revision,
        pushId: push.pushId,
        project,
        treeherderUrl: treeherderPushUrl(project, push.revision),
        jobCount: jobs.length,
        failedJobCount: failedTestJobs.length + otherFailedJobs.length,
        profilesRead: jobsToProcess.length,
        readPassingJobs,
        passingTestJobCount: successfulTestJobs.length,
        unblamedJobCount,
        otherFailedJobs: otherFailedJobs.map((job) => ({
            jobName: job.jobName,
            taskId: job.taskId,
            result: job.result,
        })),
        permaFails: failures.filter(isPermaFail),
        knownIntermittents: failures.filter(
            (failure) => !isPermaFail(failure) && isKnownOnCentral(failure)
        ),
        newIntermittents: failures.filter(
            (failure) => !isPermaFail(failure) && !isKnownOnCentral(failure)
        ),
    };

    if (context.globals.format === 'json') {
        emit(context, toJson(result));
        return;
    }
    const limit = context.globals.limit ?? DEFAULT_LIMIT;
    emit(
        context,
        context.globals.format === 'markdown'
            ? renderMarkdown(result, limit, boolOption(args, 'perma-only'), boolOption(args, 'other-jobs'))
            : renderText(
                  result,
                  limit,
                  boolOption(args, 'perma-only'),
                  boolOption(args, 'other-jobs'),
                  boolOption(args, 'messages')
              )
    );
    // Exit 0 regardless of what was found: `CLI.md` is explicit that the
    // failures are the answer, not an error, and that scripts should branch on
    // --json rather than on the exit code.
}

/**
 * Whether a failure is a perma-fail candidate.
 *
 * **A fact about the push, and only about the push**: the test failed in every
 * run of at least one configuration, and the harness's in-job rerun never
 * turned it green there. That is what `try.html` puts in its "Permanent
 * failures" table, and this command now agrees with it.
 *
 * Central history is deliberately *not* consulted here. It used to be — the
 * section was "and were not failing on central" — and that filter is what made
 * this command report 0 perma-fails on try push 7d16bff8 where the dashboard
 * reports 3. All three of that push's permanent failures do already fail the
 * same way on central, on the very configs they perma-failed on here
 * (`browser_sync.js` 146/345 = 42.3% on `swr-a11y-checks`,
 * `browser_smartwindow_run_search.js` 339/370 = 91.6% on `standalone`,
 * `browser_ml_heuristics.js` 115/449 = 25.6% on `msix`), so the filter was
 * working exactly as written — and still produced an empty section for a push
 * with three tests that failed every single run.
 *
 * "Failed every run on a config" is what someone triaging a push wants
 * surfaced. Whether central fails there too is context that changes how the
 * row is read, not grounds for hiding it, so it is now an annotation on the
 * row (`centralLine()`) rather than a filter on the section. The section
 * header no longer claims these are "almost certainly yours", because for a
 * row simultaneously annotated as pre-existing that would be false.
 */
function isPermaFail(failure: TryFailure): boolean {
    // `everyRunFailed` already excludes any config the harness's rerun turned
    // green, so the test-level `passedOnRerun` must not be re-tested here: a
    // test that is intermittent on one config and permanent on another has it
    // set, and rejecting on it discards the permanent config.
    return failure.everyRunFailed;
}

/** Whether central has seen this test fail the same way. */
function isKnownOnCentral(failure: TryFailure): boolean {
    return failure.central !== null && failure.central.failCount > 0;
}

// --- the push's own results ----------------------------------------------


/** Fetches and parses each job's profile, with bounded concurrency. */
async function collectTimings(
    context: CommandContext,
    jobs: readonly TreeherderJob[],
    fetchUrl: (url: string) => Promise<Uint8Array | null>,
    concurrency: number
): Promise<TestTiming[]> {
    const timings: TestTiming[] = [];
    const dropped: DroppedMarker[] = [];
    const queue = [...jobs];
    let done = 0;
    let missing = 0;
    let streamed = 0;

    const worker = async (): Promise<void> => {
        for (;;) {
            const job = queue.shift();
            if (job === undefined) {
                return;
            }
            const url = resourceUsageProfileUrl(job.taskId, job.retryId);
            let bytes: Uint8Array | null = null;
            try {
                bytes = await fetchUrl(url);
            } catch {
                // A single unreachable artifact must not fail the command:
                // the answer is still useful without one job, and reporting
                // how many were missing is more honest than either failing or
                // silently dropping them.
                bytes = null;
            }
            done++;
            if (bytes === null) {
                missing++;
            } else if (isStreamedProfile(bytes)) {
                streamed++;
            } else {
                try {
                    const profile = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
                    timings.push(...parseTestMarkers(profile, job, dropped));
                } catch {
                    missing++;
                }
            }
            if (done % 10 === 0) {
                progress(context, `  …${done}/${jobs.length} profiles`);
            }
        }
    };

    await Promise.all(
        Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker)
    );

    // Two separate counts, because they are two different things to go and do.
    if (streamed > 0) {
        warn(
            context,
            `${streamed} of ${jobs.length} jobs were killed for exceeding their maximum ` +
                `duration, so only a streamed profile exists for them and this tool does ` +
                `not read that format; failures in those jobs are not in this report`
        );
    }
    if (missing > 0) {
        warn(
            context,
            `${missing} of ${jobs.length} job profiles could not be read; ` +
                `failures in those jobs are not in this report`
        );
    }
    // A `warn`, not `progress`: it says the report is incomplete. The ids print
    // rather than just counting, since the useful question is which shape dropped.
    if (dropped.length > 0) {
        const shown = [...new Set(dropped.map((entry) => `${entry.status} ${entry.id}`))];
        warn(
            context,
            `${dropped.length} failing marker${dropped.length === 1 ? '' : 's'} named no test ` +
                `path and are not in this report (a crash recorded against a manifest has no ` +
                `path to compare against central): ${shown.slice(0, 5).join(', ')}` +
                (shown.length > 5 ? `, and ${shown.length - 5} more` : '')
        );
    }
    return timings;
}

/**
 * Re-exported so this module's readers and its tests find them where they were.
 *
 * `lib/model/failure-message.ts` owns `normalizeMessage` and records why the
 * CRLF pass this copy had, and `site/try.ts`'s did not, is the behaviour both
 * now share. `lib/model/test-markers.ts` owns the marker parser, which moved
 * there when `fx-tests task` needed the same read against a single task: the
 * alternative was a fourth copy of it, which is the thing
 * `test/try-parity.test.ts` exists to prevent.
 */
export { type DroppedMarker, isStreamedProfile, normalizeMessage, parseTestMarkers };

/**
 * Groups per-run outcomes into one entry per test.
 *
 * `runsPerJobName` counts every completed run of each config, successes
 * included, which is what makes "every run of this config failed" answerable
 * from the failures alone — see `permaFailingConfigs` below.
 */
function aggregateFailures(
    timings: readonly TestTiming[],
    runsPerJobName: ReadonlyMap<string, number>
): TryFailure[] {
    // A test that passed when the harness reran it inside the same job is
    // intermittent almost by definition (`old/try.html:1393`). Keyed by run, since
    // the same test can pass on rerun in one job and fail outright in another.
    const passedOnRerunByRun = new Map<string, Set<string>>();
    for (const timing of timings) {
        if (!timing.isRerun || !timing.status.startsWith('PASS')) {
            continue;
        }
        const key = runKeyOf(timing);
        let set = passedOnRerunByRun.get(key);
        if (set === undefined) {
            set = new Set();
            passedOnRerunByRun.set(key, set);
        }
        set.add(timing.path);
    }

    interface Accumulator {
        path: string;
        /** Failing executions, which is what the ranking is on. */
        failureCount: number;
        /** Per config: the runs of it in which this test failed. */
        failedRunsByJobName: Map<string, Set<string>>;
        /**
         * The configs where the harness's in-job rerun passed.
         *
         * A set, not a `Map<string, boolean>`. It only ever held `true`, so
         * every read had to compare against it and every derivation had to
         * filter it — code that looked like it was deciding something and
         * could not decide anything, which two mutations confirmed by
         * surviving. Absence is the other case.
         */
        passedOnRerunConfigs: Set<string>;
        messages: Map<string, number>;
        otherMessages: Map<string, number>;
        statuses: Set<string>;
        modes: Set<string>;
    }
    const byTest = new Map<string, Accumulator>();

    for (const timing of timings) {
        if (!isFailureStatus(timing.status)) {
            continue;
        }
        let entry = byTest.get(timing.path);
        if (entry === undefined) {
            entry = {
                path: timing.path,
                failureCount: 0,
                failedRunsByJobName: new Map(),
                passedOnRerunConfigs: new Set(),
                messages: new Map(),
                otherMessages: new Map(),
                statuses: new Set(),
                modes: new Set(),
            };
            byTest.set(timing.path, entry);
        }
        entry.failureCount++;
        let runs = entry.failedRunsByJobName.get(timing.jobName);
        if (runs === undefined) {
            runs = new Set();
            entry.failedRunsByJobName.set(timing.jobName, runs);
        }
        runs.add(runKeyOf(timing));
        // The BASE status: `FAIL-PARALLEL` and `FAIL-SEQUENTIAL` are one
        // verdict in two phases, and this set answers "what happened", not
        // "in which phase". `site/try-view.ts` has always stripped here; the
        // CLI did not, so a test that failed in both phases reported
        // `["FAIL-PARALLEL","FAIL-SEQUENTIAL"]` where the page reported
        // `["FAIL"]`. The phase is not lost — `entry.modes` below records it,
        // and `parallelOnly` is derived from that, not from this.
        entry.statuses.add(baseStatus(timing.status));
        if (timing.message !== null) {
            entry.messages.set(timing.message, (entry.messages.get(timing.message) ?? 0) + 1);
        }
        // Kept apart from `messages` deliberately: that set feeds the central
        // same-message comparison, so widening it would change which section
        // every failure lands in.
        for (const message of timing.messages) {
            entry.otherMessages.set(message, (entry.otherMessages.get(message) ?? 0) + 1);
        }
        if (passedOnRerunByRun.get(runKeyOf(timing))?.has(timing.path) === true) {
            entry.passedOnRerunConfigs.add(timing.jobName);
        }
        const suffix = /-(PARALLEL|SEQUENTIAL)$/.exec(timing.status)?.[1];
        entry.modes.add(suffix ?? 'UNRECORDED');
    }

    // Every parsed execution of each failing test, by config and by run —
    // the PASSING ones included, which is the whole point. A run's outcome is
    // not decidable from its failures alone: `FAIL` and `FAIL -> PASS(rerun)`
    // have the same failing executions and are opposite outcomes.
    const execsByTest = new Map<string, Map<string, Map<string, TestTiming[]>>>();
    for (const timing of timings) {
        if (!byTest.has(timing.path)) {
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
        const key = runKeyOf(timing);
        let execs = byRun.get(key);
        if (execs === undefined) {
            execs = [];
            byRun.set(key, execs);
        }
        execs.push(timing);
    }

    const failures: TryFailure[] = [];
    for (const entry of byTest.values()) {
        const jobNames = [...entry.failedRunsByJobName.keys()];
        // Task runs of those configurations — the page's `totalJobs`, and what
        // this command used to print as `totalRuns`.
        const totalJobs = jobNames.reduce(
            (sum, jobName) => sum + (runsPerJobName.get(jobName) ?? 0),
            0
        );
        // EXECUTIONS of the test — the page's `totalRuns` and the denominator
        // of the displayed ratio. `old/try.html:1565-1580`: every parsed
        // execution in each run of those configurations, plus one for each run
        // whose profile was never parsed.
        const execsByJobName = execsByTest.get(entry.path);
        let totalRuns = 0;
        for (const jobName of jobNames) {
            const runs = execsByJobName?.get(jobName);
            for (const execs of runs?.values() ?? []) {
                totalRuns += execs.length;
            }
            totalRuns += Math.max(0, (runsPerJobName.get(jobName) ?? 0) - (runs?.size ?? 0));
        }
        const failedRuns = new Set(
            [...entry.failedRunsByJobName.values()].flatMap((runs) => [...runs])
        ).size;

        // Whether this test is a permanent failure **on one configuration**:
        // every run of that config failed, no run of it succeeded outright,
        // and the harness's in-job rerun never turned it green there.
        //
        // Per-config, not per-test, because those are different questions and
        // only the per-config one matches `try.html`, which tags each failing
        // *instance* intermittent (`old/try.html:1400`) and calls the test
        // permanent when any instance is not (`old/try.html:1765`).
        //
        // Measured on push 7d16bff8: `browser_ml_heuristics.js` failed on
        // three configs — intermittently on `browser-chrome-3` and
        // `browser-chrome-7`, which also had passing runs, and in all four
        // runs of `browser-chrome-msix-18`, which had none. Asking the
        // question of the whole test answers "intermittent" and hides a
        // config on which the test never once passed. `try.html` lists it as
        // one of the push's three permanent failures.
        //
        // There is deliberately no separate "and no run of this config
        // succeeded" clause. `runsPerJobName` counts every *completed* run of
        // the job name, successes included, so a config with a successful run
        // has a denominator the failures cannot reach and the run comparison
        // below already excludes it. A `successfulJobNames.has(jobName)` guard
        // here reads like it is doing that work and does none: removing it
        // changes no output on any input, which a mutation confirmed.
        const permaFailingConfigs = jobNames.filter((jobName) => {
            if (entry.passedOnRerunConfigs.has(jobName)) {
                return false;
            }
            const runsOfConfig = runsPerJobName.get(jobName) ?? 0;
            const failed = entry.failedRunsByJobName.get(jobName)?.size ?? 0;
            return runsOfConfig > 0 && failed >= runsOfConfig;
        });

        const passedOnRerunConfigs = [...entry.passedOnRerunConfigs].sort();

        // How each of those `totalJobs` JOB RUNS ended — a different unit from
        // `totalRuns` above, and the reason both are reported. The buckets are
        // what turn "every job run failed" into a readable statement.
        const outcomes = runOutcomes<TestTiming>(
            execsByJobName ?? new Map(),
            jobNames,
            runsPerJobName,
            (timing) => timing.isRerun
        );

        failures.push({
            path: entry.path,
            jobNames: jobNames.sort(),
            failureCount: entry.failureCount,
            failedRuns,
            totalRuns,
            totalJobs,
            outcomes,
            everyRunFailed: permaFailingConfigs.length > 0,
            permaFailingConfigs: permaFailingConfigs.sort(),
            passedOnRerun: passedOnRerunConfigs.length > 0,
            passedOnRerunConfigs,
            messages: [...entry.messages]
                .sort((a, b) => b[1] - a[1])
                .map(([message]) => message),
            allMessages: [...entry.otherMessages]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([message, count]) => ({ message, count })),
            // A timeout or a crash records no message anywhere — not in the
            // push and not in the aggregates (`FORMATS.md`) — so for those the
            // status kind is the comparison and it is a valid one. For a plain
            // FAIL with no message there is nothing to compare at all.
            // `has`, not a `startsWith` scan: the set holds base statuses now,
            // so the prefix test that tolerated `TIMEOUT-PARALLEL` is no
            // longer standing in for an exact comparison.
            messageComparable:
                entry.messages.size > 0 ||
                entry.statuses.has('TIMEOUT') ||
                entry.statuses.has('CRASH'),
            statuses: [...entry.statuses].sort(),
            parallelOnly: entry.modes.size === 1 && entry.modes.has('PARALLEL'),
            central: null,
        });
    }
    // `old/try.html:744` — the page's default sort, and now this command's.
    //
    // The tiebreak is deliberately *not* the page's. The page leaves equal
    // counts in `Array.from(testMap.values())` order and relies on the
    // stability of two `sort()` calls, so its order among ties is the order
    // the timings arrived — which is the order eight web workers finished
    // parsing profiles fetched 64 at a time (`old/try.html:1113`). That is a
    // network and scheduler race: reloading the page reorders the ties. A
    // command whose output is diffed and pasted into bugs cannot be
    // non-deterministic, so ties break on the path.
    return failures.sort(
        (a, b) => b.failureCount - a.failureCount || a.path.localeCompare(b.path)
    );
}

// --- central comparison ---------------------------------------------------

/**
 * Fills in each failure's central history from the 21-day aggregates.
 *
 * Reads the bucket file each failing test hashes into. Failing tests cluster
 * by directory and the hash is over the full path, so this is not
 * one-file-per-test in practice, but the worst case is bounded at 64 per
 * harness and the files are cached.
 *
 * The same-message rate is what makes the comparison meaningful: `CLI.md` is
 * explicit that a test already failing 8% on central *with a different
 * message* is not exonerated.
 */
async function attachCentralHistory(
    context: CommandContext,
    failures: readonly TryFailure[]
): Promise<void> {
    // Group by (harness, bucket) so each file is fetched once.
    const wanted = new Map<string, { harness: string; suffix: string; failures: TryFailure[] }>();
    for (const failure of failures) {
        const harness = detectHarness(failure.path);
        const suffix = bucketFileSuffix(bucketIndexForPath(failure.path));
        const key = `${harness}-${suffix}`;
        let group = wanted.get(key);
        if (group === undefined) {
            group = { harness, suffix, failures: [] };
            wanted.set(key, group);
        }
        group.failures.push(failure);
    }

    for (const group of wanted.values()) {
        let file: BucketFile;
        try {
            file = await fetchJson<BucketFile>(context.source, {
                index: timingsIndex(group.harness),
                filename: `${group.harness}-${group.suffix}.json`,
            });
        } catch (error) {
            // Central history is an enrichment, not the answer. Losing it
            // downgrades every failure in this bucket to "unknown on central"
            // rather than failing the command — and the warning says so, so
            // the missing comparison is visible rather than read as "never
            // failed on central".
            warn(
                context,
                `could not read central history for ${group.harness}-${group.suffix}.json: ` +
                    `${(error as Error).message}`
            );
            continue;
        }
        const decoded = decodeBucket(file);
        for (const failure of group.failures) {
            const identity = decoded.findTest(failure.path);
            if (identity === null) {
                // Not in central data at all. Left as `null`, which the
                // renderer prints as "no central data", distinct from
                // "0 failures on central".
                continue;
            }
            const stats = computeTestStats(decoded, identity.testId);
            const messageOptions = {
                tryMessages: failure.messages,
                // A timeout or a crash records no message at all
                // (`FORMATS.md`), so for those the status kind stands in for
                // one — otherwise every timeout would count as a different
                // failure from the timeout on central.
                matchAnyTimeout: failure.statuses.includes('TIMEOUT'),
                matchAnyCrash: failure.statuses.includes('CRASH'),
            };
            const configs = computeConfigStats(decoded, identity.testId, messageOptions);
            // The call `site/try-flakiness-worker.ts` makes, option for option.
            // Chunk-stripped because the aggregates store names that way: leave
            // it out and every configuration misses, silently sending every row
            // to the overall fallback.
            const hereConfigs = computeConfigStats(decoded, identity.testId, {
                ...messageOptions,
                jobNames: failure.jobNames.map(stripChunkSuffix),
                minRecentRuns: MIN_RECENT_RUNS,
            });
            const headline = pickHeadlineRate(stats, hereConfigs);
            const failCount = stats.failCount + stats.timeoutCount + stats.crashCount;
            const sameMessageFailCount = configs.reduce(
                (sum, config) => sum + config.sameMsgFailCount,
                0
            );
            const worst = configs.find((config) => config.failCount > 0) ?? null;

            // The same question, asked only of the configs where this push's
            // failure was permanent. `computeConfigStats` reports
            // chunk-stripped names, so the push's names have to be stripped
            // too — otherwise `…-msix-18` never matches `…-msix` and every
            // config looks absent from history.
            const permaConfigNames = new Set(
                failure.permaFailingConfigs.map(stripChunkSuffix)
            );
            const permaConfigs = configs.filter((config) =>
                permaConfigNames.has(config.jobName)
            );
            const sameMessageFailCountOnPermaConfigs =
                permaConfigs.length === 0
                    ? null
                    : permaConfigs.reduce((sum, config) => sum + config.sameMsgFailCount, 0);

            failure.central = {
                runCount: stats.runCount,
                failCount,
                failRate: stats.runCount > 0 ? (failCount / stats.runCount) * 100 : null,
                sameMessageFailCount,
                sameMessageFailRate:
                    stats.runCount > 0 ? (sameMessageFailCount / stats.runCount) * 100 : null,
                sameMessageFailCountOnPermaConfigs,
                headline,
                // Over `hereConfigs`, to agree with the rates it quotes.
                explanation: flakinessTooltip(
                    stats,
                    hereConfigs,
                    headline,
                    hereConfigs.some((config) => config.sameMsgFailCount > 0),
                    decoded.days ?? undefined
                ),
                configsInHistory: hereConfigs.length,
                worstConfig:
                    worst === null
                        ? null
                        : {
                              jobName: worst.jobName,
                              failRate: worst.failRate,
                              sameMsgFailRate: worst.sameMsgFailRate,
                          },
                known: true,
            };
        }
    }
}

/** Attaches task IDs and profile URLs to each failure. */
function attachProvenance(
    failures: readonly TryFailure[],
    timings: readonly TestTiming[],
    withTaskIds: boolean,
    withProfiles: boolean
): void {
    const byPath = new Map<string, TestTiming[]>();
    for (const timing of timings) {
        if (!isFailureStatus(timing.status)) {
            continue;
        }
        const list = byPath.get(timing.path) ?? [];
        list.push(timing);
        byPath.set(timing.path, list);
    }
    // `timings` arrives in the order concurrent artifact fetches finished
    // parsing — a network race — so this must sort or `--json` differs between
    // two runs over one warm cache. `test/artifact-cache.test.ts` pins it.
    for (const list of byPath.values()) {
        list.sort(
            (a, b) =>
                a.jobName.localeCompare(b.jobName) ||
                a.taskId.localeCompare(b.taskId) ||
                a.retryId - b.retryId
        );
    }
    for (const failure of failures) {
        const list = byPath.get(failure.path) ?? [];
        if (withTaskIds) {
            failure.taskIds = list.map((timing) => ({
                taskId: timing.taskId,
                retryId: timing.retryId,
                jobName: timing.jobName,
            }));
        }
        if (withProfiles) {
            const seen = new Set<string>();
            failure.profiles = [];
            for (const timing of list) {
                const key = runKeyOf(timing);
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                const row: NonNullable<TryFailure['profiles']>[number] = {
                    taskId: timing.taskId,
                    retryId: timing.retryId,
                    resourceUsage: resourceUsageProfileUrl(timing.taskId, timing.retryId),
                };
                // Every profile this execution uploaded, not the first: an
                // in-job rerun adds a `-2`-suffixed one and comparing the two is
                // what the list is for.
                const urls = timing.profileFilenames.map((filename) =>
                    testInfoArtifactUrl(timing.taskId, timing.retryId, filename)
                );
                if (urls.length > 0) {
                    row.testProfiles = urls;
                    // Kept for consumers reading the pre-existing key.
                    row.testProfile = urls[0]!;
                }
                failure.profiles.push(row);
            }
        }
    }
}

// --- rendering -----------------------------------------------------------

/** How central compares, as one line. */
function centralLine(failure: TryFailure): string {
    const central = failure.central;
    if (central === null) {
        return 'No central data for this test in the 21-day window';
    }
    if (central.failCount === 0) {
        return `Never failed on central in 21 days (0/${central.runCount} runs)`;
    }
    const overall = `${percent(central.failRate)} on central (${central.failCount}/${central.runCount})`;
    if (!failure.messageComparable) {
        // Saying "0.0% with the same message" here would be a measurement of
        // nothing presented as a measurement of something.
        return `${overall}; this push recorded no failure message, so it cannot be compared`;
    }
    // Both rates: the overall one says "this test is flaky", the same-message
    // one says "it is flaky *this way*".
    return (
        `${overall}, ` +
        `${percent(central.sameMessageFailRate)} with the same message ` +
        `(${central.sameMessageFailCount})`
    );
}

/** `[]` when there is no central history — `centralLine()` says so already. */
function centralHeadlineLines(failure: TryFailure, indent: string): string[] {
    const central = failure.central;
    if (central === null) {
        return [];
    }
    const where =
        central.headline.scope === 'config'
            ? `on ${centralScopeCell(failure)}`
            : 'across every configuration';
    const lines = [
        `${indent}central ${percent(central.headline.rate)} ${where} ` +
            `(${central.headline.runs} runs)`,
    ];
    if (central.configsInHistory === 0) {
        // Before the explanation: its verdict is conditional on this.
        lines.push(
            `${indent}  central never ran this test on ` +
                `${failure.jobNames.length === 1 ? 'the configuration' : `any of the ${failure.jobNames.length} configurations`}` +
                ' this push used, so the rate above is the whole-test one'
        );
    }
    for (const line of central.explanation.split('\n')) {
        lines.push(line === '' ? '' : `${indent}  ${line}`);
    }
    return lines;
}

/**
 * What the `central` percentage was measured on. `all configs` is the
 * `scope: 'overall'` fallback: no configuration this push ran shows this
 * failure, so the cell answers "how flaky is this test at all" instead.
 */
function centralScopeCell(failure: TryFailure): string {
    if (failure.central === null) {
        return 'n/a';
    }
    const { headline } = failure.central;
    return headline.scope === 'config' ? (headline.jobName ?? '') : 'all configs';
}

/**
 * Whether central already fails this way on the config the push broke.
 *
 * The single most useful sentence on a perma-fail row, and the one that
 * replaced the filter this section used to have. A perma-fail is now reported
 * on push evidence alone, so without this a reader has no way to tell
 * `browser_smartwindow_run_search.js` — which fails 91.6% of the time on
 * central on the very config it perma-failed on here — from a test the patch
 * genuinely broke. Returns `null` when there is nothing to say.
 */
function preExistingLine(failure: TryFailure): string | null {
    const central = failure.central;
    if (central === null) {
        return null;
    }
    // No `!messageComparable` guard, deliberately. `messageComparable` is false
    // only when the push recorded no message *and* the status is neither a
    // timeout nor a crash — and in exactly that case `computeConfigStats` is
    // given an empty `tryMessages` with both `matchAny*` flags off, so
    // `entryMatches()` can never fire and the count below is already 0 or
    // `null`. A guard here would read as load-bearing and decide nothing;
    // a mutation removing it changed no output on any input.
    const onPermaConfigs = central.sameMessageFailCountOnPermaConfigs;
    if (onPermaConfigs === null || onPermaConfigs === 0) {
        return null;
    }
    const configs =
        failure.permaFailingConfigs.length === 1
            ? failure.permaFailingConfigs[0]
            : `the ${failure.permaFailingConfigs.length} configs it failed every run on`;
    return (
        `Pre-existing: central already fails the same way on ${configs} ` +
        `(${onPermaConfigs} times in 21 days) — probably not yours.`
    );
}

/**
 * Where the harness's in-job rerun turned the test green, named.
 *
 * The unscoped version of this sentence — "Passed when the harness reran it in
 * the same job — intermittent." — is what made a perma-fail row contradict
 * itself. Both facts are true and neither is about the whole test: on try push
 * 09028ab93fe1, `test_nimbus_newtabTrainhopAddon.js` failed both runs of
 * `test-windows11-64-25h2/opt-xpcshell` and passed on rerun on
 * `test-windows11-32-25h2/opt-xpcshell`. 33 of that push's 54 perma-fails read
 * that way. Naming the configs is what lets the two coexist, and it is also
 * the more useful form: the config that was *not* rescued by a rerun is the
 * one to reproduce on.
 *
 * Returns `null` when the rerun never passed anywhere.
 */
/**
 * How each JOB RUN of a failing test ended, when that is not one thing.
 *
 * These sum to `totalJobs`, not to `totalRuns` and not to `failureCount` —
 * three different units, which is why the line above names all three rather
 * than pairing two of them into a ratio. `old/try.html:1546` states the same
 * constraint for the page's tooltip.
 *
 * Suppressed when a single bucket holds every job run, where it would only
 * restate the line above it.
 */
function outcomesLine(failure: TryFailure): string | null {
    const { failedTwice, passedOnRetry, failedOnce, passed, notAnalyzed } = failure.outcomes;
    const parts: string[] = [];
    const runs = (n: number): string => `${n} run${n === 1 ? '' : 's'}`;
    if (failedTwice > 0) {
        parts.push(`${runs(failedTwice)} failed, then failed again on rerun`);
    }
    if (passedOnRetry > 0) {
        parts.push(`${runs(passedOnRetry)} failed, then passed on rerun`);
    }
    if (failedOnce > 0) {
        parts.push(`${runs(failedOnce)} failed, not rerun`);
    }
    if (passed > 0) {
        parts.push(`${runs(passed)} passed`);
    }
    if (notAnalyzed > 0) {
        // Named as unread rather than passed: without `--all-jobs` these are
        // the runs whose profiles were never fetched, and calling them passes
        // would assert something this run did not look at.
        parts.push(`${runs(notAnalyzed)} not read`);
    }
    return parts.length > 1 ? `    Of those runs: ${parts.join('; ')}.` : null;
}

function rerunLine(failure: TryFailure): string | null {
    const configs = failure.passedOnRerunConfigs;
    if (configs.length === 0) {
        return null;
    }
    const where =
        configs.length === 1
            ? configs[0]
            : `${configs.length} of them: ${configs.slice(0, 3).join(', ')}` +
              (configs.length > 3 ? `, +${configs.length - 3} more` : '');
    // "there" rather than a bare "intermittent": the verdict is scoped to
    // these configs, and the row may well be permanent on another.
    return `Passed when the harness reran it in the same job on ${where} — intermittent there.`;
}

/**
 * The "same message" column, which must not print a rate it does not have.
 *
 * `n/a` when there is no central data; `?` when the push recorded no message,
 * so 0 would mean "nothing to compare" while reading as "a different failure".
 */
function sameMessageCell(failure: TryFailure): string {
    if (failure.central === null) {
        return 'n/a';
    }
    if (!failure.messageComparable) {
        return '?';
    }
    return percent(failure.central.sameMessageFailRate);
}

/**
 * The same verdict as `preExistingLine()`, as a table cell.
 *
 * `—` rather than "no" when the question could not be asked: no central data,
 * or no message to compare. Saying "no" there would answer a question that was
 * never put.
 */
function preExistingCell(failure: TryFailure): string {
    if (failure.central === null || !failure.messageComparable) {
        return '—';
    }
    const onPermaConfigs = failure.central.sameMessageFailCountOnPermaConfigs;
    if (onPermaConfigs === null) {
        return '—';
    }
    // Unlike `preExistingLine()`, the `messageComparable` guard above *is*
    // load-bearing here: this cell distinguishes "no" from "could not ask",
    // and an uncomparable failure has to read as the second.
    return onPermaConfigs > 0 ? `yes (${onPermaConfigs})` : 'no';
}

/**
 * The one line that says which jobs were read, and what that leaves out.
 *
 * Present in both directions, because both are things the reader cannot see
 * from the rows. Without `--all-jobs` the sections are silent about every test
 * that failed and then passed on retry — the job is green, so nothing about it
 * reaches this output — and a report that does not say so reads as a complete
 * picture of the push. With the flag it says what the wider universe cost, so
 * a slow run is explained rather than suspicious.
 *
 * `null` when there is nothing to say: no passing test job means the two
 * universes are the same one.
 */
function universeLine(result: TryJson): string | null {
    if (result.passingTestJobCount === 0) {
        return null;
    }
    if (result.readPassingJobs) {
        return (
            `Read ${result.profilesRead} test job profiles, including the ` +
            `${result.passingTestJobCount} that passed (--all-jobs).`
        );
    }
    return (
        `Read ${result.profilesRead} failed test job profiles. The ` +
        `${result.passingTestJobCount} test jobs that passed were not read, so a test that ` +
        `failed and then passed on retry is not here; --all-jobs reads them too.`
    );
}


// --- `--test`: one test, per configuration ---------------------------------

/**
 * One configuration's job runs of the test `--test` named, bucketed by how each
 * run ended.
 *
 * The three buckets partition `jobs`: every job run that recorded the test lands
 * in exactly one, so `passed + passedOnRetry + failed === jobs` on every row.
 * Measured over 605,635 (test, job run) pairs across pushes `46c757b692be` and
 * `7d16bff81bb1` — 1,515 configuration rows, no exceptions.
 *
 * **Job runs, not attempts, and the attempt total is deliberately not
 * recoverable from a row.** The harness re-runs a failing test within the job,
 * and it can do so more than once: 81 job runs on `7d16bff81bb1` hold three
 * attempts of one test. So `passedOnRetry` counts jobs that needed at least one
 * retry, not retries. Adding an attempt count back as a column is the change to
 * resist — it puts a second unit in the row, which is what two rejected versions
 * of this table did, and a reader then reads `0 failed` beside a non-zero
 * attempt figure as a contradiction. `--json` carries what a caller needs.
 */
interface TestConfigRow {
    jobName: string;
    /** Job runs of this configuration whose profile recorded the test. */
    jobs: number;
    /** Ended with the test passing, no failing attempt. */
    passed: number;
    /** Failed at least once, then a retry within the same job passed. */
    passedOnRetry: number;
    /** Failed, and no retry passed. */
    failed: number;
}

/** The `--json` shape of `try --test`. */
interface TryTestJson {
    revision: string;
    project: string;
    test: string;
    readPassingJobs: boolean;
    configs: TestConfigRow[];
}

/**
 * `try <rev> --test <path>` — how each configuration's job runs ended.
 *
 * Under `--all-jobs` every profile is read, so all four columns are exact and
 * the outcomes partition `jobs`. Without it only the failed jobs are read, and
 * the push's job list supplies `jobs` so a row reads `2 of 20` rather than a
 * bare `2`; a rescue inside an unread green job cannot be seen, so the two pass
 * columns become bounds rather than counts.
 */
function renderTestReport(
    context: CommandContext,
    revision: string,
    project: string,
    testPath: string,
    timings: readonly TestTiming[],
    runsPerJobName: ReadonlyMap<string, number>,
    readPassingJobs: boolean
): string {
    // Exact before suffix, or a path that is itself a test resolves to a longer
    // one ending with it.
    const exact = timings.filter((timing) => timing.path === testPath);
    const matching =
        exact.length > 0
            ? exact
            : timings.filter((timing) => timing.path.endsWith(`/${testPath}`));
    const resolved = new Set(matching.map((timing) => timing.path));

    const lines: (string | null)[] = [];
    if (resolved.size > 1) {
        lines.push(`${resolved.size} tests in this push end with ${testPath}:`);
        for (const path of [...resolved].sort()) {
            lines.push(`  ${path}`);
        }
        lines.push('Pass one of them to --test.');
        return joinLines(lines);
    }

    // Every attempt of the test in one job run, keyed by that run. Which bucket
    // a run lands in is a question about its attempts together — one failing
    // attempt does not decide it — so they are grouped before being counted.
    const attemptsByRun = new Map<string, TestTiming[]>();
    for (const timing of matching) {
        const key = runKeyOf(timing);
        const list = attemptsByRun.get(key) ?? [];
        list.push(timing);
        attemptsByRun.set(key, list);
    }

    const byConfig = new Map<string, TestConfigRow>();
    for (const attempts of attemptsByRun.values()) {
        const jobName = (attempts[0] as TestTiming).jobName;
        let row = byConfig.get(jobName);
        if (row === undefined) {
            row = { jobName, jobs: 0, passed: 0, passedOnRetry: 0, failed: 0 };
            byConfig.set(jobName, row);
        }
        row.jobs++;
        if (!attempts.some((attempt) => isFailureStatus(attempt.status))) {
            row.passed++;
        } else if (
            attempts.some((attempt) => attempt.isRerun && attempt.status.startsWith('PASS'))
        ) {
            row.passedOnRetry++;
        } else {
            // Failed, including the common case of a retry that failed again.
            row.failed++;
        }
    }

    const configs = [...byConfig.values()].sort((a, b) => a.jobName.localeCompare(b.jobName));
    const path = [...resolved][0] ?? testPath;

    // Mode two downloads only the failed jobs, so the bucketing above counted
    // those alone. The push's job list — already fetched, no extra request —
    // says how many runs each configuration actually had, which turns a bare
    // `2` into `2 of 20`. A green job of the same name ran the same test
    // selection (measured: 1,507 of 1,508 job names on push `7d16bff81bb1` ran
    // an identical test set across their runs), so it did not fail this test.
    // That bounds the other two columns without reading a single profile.
    //
    // Only configurations already in the table are completed this way, never
    // all-green ones. The job list carries job names and results, not test
    // selection, so an all-green name may never have run this test: on push
    // `46c757b692be` only 4 of the 13 such names did, and adding rows for them
    // would fabricate 9 claiming the test ran where it did not. `--all-jobs`
    // resolves it, because reading the profile is the only way to know.
    if (!readPassingJobs) {
        for (const row of configs) {
            row.jobs = runsPerJobName.get(row.jobName) ?? row.jobs;
        }
    }

    if (context.globals.format === 'json') {
        const json: TryTestJson = { revision, project, test: path, readPassingJobs, configs };
        return toJson(json);
    }

    lines.push(`Try push ${revision.slice(0, 12)} (${project}) — ${path}`);
    if (!readPassingJobs) {
        lines.push(
            'Only the failed jobs were downloaded, so a pass the harness rescued on a retry ' +
                'is invisible here. jobs and failed are exact; the rest are bounds.'
        );
    }
    lines.push(treeherderPushUrl(project, revision));
    lines.push('');

    if (configs.length === 0) {
        lines.push(
            readPassingJobs
                ? 'No run of this test was found in any of the job profiles read. Either it ' +
                      'did not run on this push, or the path does not match one.'
                : 'This test failed in none of the failed jobs read. That is not the same as ' +
                      '"it passed" and not the same as "it did not run" — neither question ' +
                      'can be answered without --all-jobs.'
        );
        return joinLines(lines);
    }

    if (readPassingJobs) {
        lines.push('Every job run that ran this test, counted once by how it ended.');
        lines.push('');
        lines.push(
            ...table(
                [
                    { header: 'configuration' },
                    { header: 'jobs', align: 'right' },
                    { header: 'passed', align: 'right' },
                    { header: 'passed on retry', align: 'right' },
                    { header: 'failed', align: 'right' },
                ],
                configs.map((row) => [
                    row.jobName,
                    String(row.jobs),
                    String(row.passed),
                    String(row.passedOnRetry),
                    String(row.failed),
                ])
            )
        );
        return joinLines(lines);
    }

    // The two exact columns first, then the two the unread jobs only bound.
    //
    // `jobs` and `failed` are exact: a job that ended `retry` or `exception`
    // produced no test result at all, which is an absent observation rather
    // than a hidden failure, so it cannot inflate `failed`.
    //
    // The markers are real and stay even at zero. A rescue inside a green job
    // is unreadable here, so `passed on retry` is a floor over the rescues
    // visible in the downloaded jobs — `>=0` says "none seen", not "none
    // happened", and a bare 0 would assert the stronger claim. On this very
    // push `swr-1` shows `>=0` where the truth is 9.
    lines.push(
        ...table(
            [
                { header: 'configuration' },
                { header: 'jobs', align: 'right' },
                { header: 'failed', align: 'right' },
                { header: 'passed on retry', align: 'right' },
                { header: 'passed', align: 'right' },
            ],
            configs.map((row) => [
                row.jobName,
                String(row.jobs),
                String(row.failed),
                `\u2265${row.passedOnRetry}`,
                `\u2264${row.jobs - row.failed - row.passedOnRetry}`,
            ])
        )
    );
    return joinLines(lines);
}

/** Plain text, as `CLI.md` lays it out. */
function renderText(
    result: TryJson,
    limit: number,
    permaOnly: boolean,
    otherJobs: boolean,
    allMessages: boolean
): string {
    const lines: (string | null)[] = [];
    lines.push(
        `Try push ${result.revision.slice(0, 12)} (${result.project}) — ` +
            `${result.jobCount} jobs, ${result.failedJobCount} failed`
    );
    lines.push('Compared against 21 days of mozilla-central history.');
    lines.push(universeLine(result));
    lines.push(result.treeherderUrl);

    if (
        result.permaFails.length === 0 &&
        result.knownIntermittents.length === 0 &&
        result.newIntermittents.length === 0
    ) {
        lines.push('');
        lines.push('No test-level failures found.');
        if (result.unblamedJobCount > 0) {
            lines.push(
                `${result.unblamedJobCount} failed test jobs had no test-level failure ` +
                    `attributed to them (harness crash, or no profile).`
            );
        }
        if (result.otherFailedJobs.length > 0) {
            lines.push(
                `${result.otherFailedJobs.length} non-test jobs failed ` +
                    `(--other-jobs to list them).`
            );
        }
        return joinLines(lines);
    }

    lines.push('');
    lines.push(...section(
        'PERMA-FAILS',
        result.permaFails,
        PERMA_FAIL_DESCRIPTION,
        limit,
        allMessages
    ));

    if (!permaOnly) {
        lines.push('');
        lines.push(
            ...compactSection(
                'KNOWN INTERMITTENTS',
                result.knownIntermittents,
                'also fail on central; likely not yours.',
                limit
            )
        );
        lines.push('');
        lines.push(
            ...compactSection(
                'NEW INTERMITTENTS',
                result.newIntermittents,
                'failed here, never on central. Worth a look.',
                limit
            )
        );
    }

    if (result.unblamedJobCount > 0) {
        lines.push('');
        lines.push(
            `${result.unblamedJobCount} failed test jobs had no test-level failure attributed`
        );
        lines.push(
            '  to them — a harness crash, or a profile that could not be read. Check them on'
        );
        lines.push('  Treeherder; this command cannot say what failed in them.');
    }

    if (otherJobs && result.otherFailedJobs.length > 0) {
        lines.push('');
        lines.push(`OTHER FAILED JOBS (${result.otherFailedJobs.length})`);
        const shown = applyLimit(result.otherFailedJobs, limit);
        for (const job of shown) {
            lines.push(`  ${job.result.padEnd(10)} ${job.jobName}  ${job.taskId}`);
        }
        lines.push(moreLine(result.otherFailedJobs.length, shown.length));
    } else if (result.otherFailedJobs.length > 0) {
        lines.push('');
        lines.push(
            `${result.otherFailedJobs.length} non-test jobs also failed (--other-jobs to list).`
        );
    }

    return joinLines(lines);
}

/** The detailed section — perma-fails get every fact. */
function section(
    title: string,
    failures: readonly TryFailure[],
    description: string,
    limit: number,
    allMessages: boolean
): string[] {
    const lines: string[] = [`${title} (${failures.length}) — ${description}`];
    if (failures.length === 0) {
        lines.push('  (none)');
        return lines;
    }
    const shown = applyLimit(failures, limit);
    for (const failure of shown) {
        lines.push('');
        lines.push(`  ${failure.path}`);
        // Three quantities, each labelled, which is what `1e8b867` did to the
        // page's tooltip for the same reason: failing executions, total
        // executions, and the job runs those happened in. Printing any two of
        // them as one `n/m` is what made `18/18` read as "never passed".
        const runWord = failure.totalRuns === 1 ? 'run' : 'runs';
        const jobWord = failure.totalJobs === 1 ? 'job run' : 'job runs';
        lines.push(
            `    ${failure.failureCount} ${failure.failureCount === 1 ? 'failure' : 'failures'}` +
                ` in ${failure.totalRuns} ${runWord}, across ${failure.totalJobs} ${jobWord}` +
                ` on ${failure.jobNames.length === 1 ? failure.jobNames[0] : `${failure.jobNames.length} configs`}`
        );
        const outcomes = outcomesLine(failure);
        if (outcomes !== null) {
            lines.push(outcomes);
        }
        if (failure.jobNames.length > 1) {
            for (const jobName of failure.jobNames.slice(0, 4)) {
                lines.push(`      ${jobName}`);
            }
            if (failure.jobNames.length > 4) {
                lines.push(`      … ${failure.jobNames.length - 4} more configs`);
            }
        }
        // Which configs failed *every* run, when that is not all of them. The
        // section is entered on this fact, so a row that failed on six configs
        // and perma-failed on one has to say which one — that is the config to
        // reproduce on.
        //
        // No extra clause is needed for the rerun case, though it looks like
        // one would be: a row that says where the rerun passed must also say
        // where the test failed every run, or it states only the first and
        // reads as contradicting its own section. That is already guaranteed.
        // `passedOnRerunConfigs` is a subset of `jobNames`, and
        // `permaFailingConfigs` excludes every config in it, so a non-empty
        // `passedOnRerunConfigs` forces the strict inequality below. An
        // explicit `|| passedOnRerunConfigs.length > 0` was tried and a
        // mutation removing it changed no output on any input.
        if (
            failure.permaFailingConfigs.length > 0 &&
            failure.permaFailingConfigs.length < failure.jobNames.length
        ) {
            const every = failure.permaFailingConfigs;
            lines.push(
                every.length === 1
                    ? `    Failed every run on ${every[0]}`
                    : `    Failed every run on ${every.length} of them: ${every.slice(0, 3).join(', ')}` +
                          (every.length > 3 ? `, +${every.length - 3} more` : '')
            );
        }
        lines.push(...centralHeadlineLines(failure, '    '));
        lines.push(`    ${centralLine(failure)}`);
        const preExisting = preExistingLine(failure);
        if (preExisting !== null) {
            lines.push(`    ${preExisting}`);
        }
        const rerun = rerunLine(failure);
        if (rerun !== null) {
            lines.push(`    ${rerun}`);
        }
        if (failure.parallelOnly) {
            lines.push(
                '    Only failed under parallel execution — likely racing with its neighbours.'
            );
        }
        lines.push(...messageLines(failure, allMessages));
        lines.push(...provenanceLines(failure, '    '));
    }
    const more = moreLine(failures.length, shown.length);
    if (more !== null) {
        lines.push(more);
    }
    return lines;
}

/** The compact sections — one line each, as `CLI.md` shows. */
function compactSection(
    title: string,
    failures: readonly TryFailure[],
    description: string,
    limit: number
): string[] {
    const lines: string[] = [`${title} (${failures.length}) — ${description}`];
    if (failures.length === 0) {
        lines.push('  (none)');
        return lines;
    }
    const shown = applyLimit(failures, limit);
    const rendered = tableWithPaths(
        [
            // The column the rows are ordered by. Without it the ordering
            // is unexplained — the reader sees a list that is not
            // alphabetical and has nothing to read it against.
            { header: '#', align: 'right', sort: 'desc' },
            // Path-aware: the column sizes itself to the longest path here, so
            // in normal use nothing is cut at all. If one ever exceeds the cap,
            // the leading directories go rather than the filename, and the
            // recovery block below prints it whole. See `tableWithPaths()`.
            { header: 'test', path: true },
            { header: 'here', align: 'right' },
            // Measured on the configurations this push ran, so it is
            // comparable with `here`.
            { header: 'central', align: 'right' },
            { header: 'same msg', align: 'right' },
        ],
        shown.map((failure) => [
            String(failure.failureCount),
            failure.path,
            // The page's ratio: failing EXECUTIONS over total executions
            // (`old/try.html:1798`, `site/try.ts:1409`). The numerator was
            // distinct job runs and the denominator job runs — two wrong
            // quantities that agreed with each other.
            `${failure.failureCount}/${failure.totalRuns}`,
            failure.central === null ? 'n/a' : percent(failure.central.headline.rate),
            sameMessageCell(failure),
        ])
    );
    lines.push(...rendered.lines);
    for (const failure of shown) {
        // Always, not behind a flag: the config is what makes the central rate
        // comparable and the failure reproducible.
        lines.push(`    ${basename(failure.path)}: ${configsPhrase(failure)}`);
        if (failure.passedOnRerun) {
            lines.push('      passed on harness rerun');
        }
        lines.push(...centralHeadlineLines(failure, '      '));
        // The flags render here too: a known intermittent is the row most worth
        // profiling, being the one that cannot be reproduced on demand.
        lines.push(...provenanceLines(failure, '      '));
        // No "failed every run on a config" note is needed here any more:
        // every such failure is now in the perma-fail section, which states it
        // per row along with what central shows on that config.
    }
    // Only when the cap actually bit. With the column sized to the rows, this
    // is now the rare fallback rather than something every table carries.
    lines.push(...fullPathLines(rendered.shortenedPaths));
    const more = moreLine(failures.length, shown.length);
    if (more !== null) {
        lines.push(more);
    }
    return lines;
}

/** The last segment of a path — what identifies a test to a reader. */
function basename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

/** The configurations a failure was seen on, as one phrase. */
function configsPhrase(failure: TryFailure): string {
    const names = failure.jobNames;
    const [only] = names;
    if (names.length === 1 && only !== undefined) {
        return only;
    }
    return (
        `${names.length} configs: ${names.slice(0, 3).join(', ')}` +
        (names.length > 3 ? `, +${names.length - 3} more` : '')
    );
}

const PROVENANCE_ROWS = 5;

/**
 * The `--task-ids` and `--profiles` lines for one row.
 *
 * One copy for both sections: they diverged on whether they honoured the flags
 * at all, and a second copy is how that comes back. Only `indent` differs.
 */
function provenanceLines(failure: TryFailure, indent: string): string[] {
    const lines: string[] = [];
    if (failure.taskIds !== undefined) {
        for (const entry of failure.taskIds.slice(0, PROVENANCE_ROWS)) {
            lines.push(`${indent}task ${entry.taskId}.${entry.retryId}  ${entry.jobName}`);
        }
        const hidden = failure.taskIds.length - PROVENANCE_ROWS;
        if (hidden > 0) {
            lines.push(`${indent}… ${hidden} more task${hidden === 1 ? '' : 's'}`);
        }
    }
    if (failure.profiles !== undefined) {
        for (const entry of failure.profiles.slice(0, PROVENANCE_ROWS)) {
            lines.push(`${indent}profile ${entry.resourceUsage}`);
            for (const url of entry.testProfiles ?? []) {
                lines.push(`${indent}test profile ${url}`);
            }
        }
        const hidden = failure.profiles.length - PROVENANCE_ROWS;
        if (hidden > 0) {
            lines.push(`${indent}… ${hidden} more profile${hidden === 1 ? '' : 's'}`);
        }
    }
    return lines;
}

/** Markdown, for pasting into a bug or PR. */
function renderMarkdown(
    result: TryJson,
    limit: number,
    permaOnly: boolean,
    otherJobs: boolean
): string {
    const lines: (string | null)[] = [];
    lines.push(md.heading(`Try push ${result.revision.slice(0, 12)} (${result.project})`, 1));
    lines.push('');
    lines.push(
        `${result.jobCount} jobs, ${result.failedJobCount} failed. ` +
            `Compared against 21 days of mozilla-central history.`
    );
    const universe = universeLine(result);
    if (universe !== null) {
        lines.push('');
        lines.push(`_${universe}_`);
    }
    lines.push('');
    lines.push(`[View on Treeherder](${result.treeherderUrl})`);

    const sections: [string, readonly TryFailure[], string][] = permaOnly
        ? [['Perma-fails', result.permaFails, PERMA_FAIL_DESCRIPTION]]
        : [
              ['Perma-fails', result.permaFails, PERMA_FAIL_DESCRIPTION],
              ['Known intermittents', result.knownIntermittents, 'Also fail on central; likely not yours.'],
              ['New intermittents', result.newIntermittents, 'Failed here, never on central.'],
          ];

    for (const [title, failures, description] of sections) {
        lines.push('');
        lines.push(md.heading(`${title} (${failures.length})`));
        lines.push('');
        lines.push(`_${description}_`);
        lines.push('');
        if (failures.length === 0) {
            lines.push('None.');
            continue;
        }
        const shown = applyLimit(failures, limit);
        lines.push(
            ...md.table(
                [
                    // The ranking column, so a table pasted into a bug shows
                    // what its order means.
                    { header: '#', align: 'right' },
                    { header: 'Test' },
                    { header: 'Configs', align: 'right' },
                    { header: 'Here', align: 'right' },
                    { header: 'Central', align: 'right' },
                    // A table pasted into a bug carries no tooltip, so the
                    // configuration the rate was measured on has to be a column.
                    { header: 'Central measured on' },
                    { header: 'Same message', align: 'right' },
                    // The text renderer says this in a sentence per row. A
                    // Markdown table pasted into a bug needs it just as much —
                    // without it the perma-fail table reads as a list of
                    // regressions, and on autoland push 7c06165ae50f70 that
                    // would be 48 of 51 rows misread.
                    { header: 'Pre-existing?' },
                    { header: 'Message' },
                ],
                shown.map((failure) => [
                    String(failure.failureCount),
                    failure.path,
                    String(failure.jobNames.length),
                    `${failure.failureCount}/${failure.totalRuns}`,
                    failure.central === null ? 'n/a' : percent(failure.central.headline.rate),
                    centralScopeCell(failure),
                    sameMessageCell(failure),
                    preExistingCell(failure),
                    truncate(failure.messages[0] ?? '', 120),
                ])
            )
        );
        lines.push(md.moreLine(failures.length, shown.length));
    }

    if (otherJobs && result.otherFailedJobs.length > 0) {
        lines.push('');
        lines.push(md.heading(`Other failed jobs (${result.otherFailedJobs.length})`));
        lines.push('');
        lines.push(
            ...md.table(
                [{ header: 'Result' }, { header: 'Job' }, { header: 'Task' }],
                applyLimit(result.otherFailedJobs, limit).map((job) => [
                    job.result,
                    job.jobName,
                    job.taskId,
                ])
            )
        );
    }

    return joinLines(lines);
}
