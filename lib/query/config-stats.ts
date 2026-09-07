/**
 * Per-configuration failure rates for a test, with a recent window sized by
 * run count.
 *
 * A **port**, not a rewrite. `computeConfigStats()`
 * (`common-test-data.js:121`) is the one piece of the existing data code that
 * already has its domain knowledge written down, and `PLAN.md` §3 is explicit
 * that the recent-window logic "should be moved, not rewritten". The comments
 * below are that code's reasoning, kept because they are the reason it is
 * right; what changed is that the shape dispatch is now the step-1 iterator's
 * job and the classification is `model/status.ts`'s.
 *
 * ## Why per-config at all
 *
 * The overall rate divides failures from every config by runs from every
 * config, so a test that fails **every time** on one platform still reads as a
 * couple of percent overall. Slicing by config is what makes a perma-fail
 * visible, and it is why `CLI.md`'s `fx-tests test` leads with a per-config
 * table rather than with a single number.
 *
 * ## Why the recent window is sized by runs and not by days
 *
 * The load-bearing property, and the one most likely to be "simplified" away by
 * someone who has not read this comment.
 *
 * Push volume drops several-fold at weekends — `FORMATS.md` measures 103.2M
 * markers on Thursday 2026-07-30 against 39.1M on Sunday 2026-08-02, a factor
 * of 2.6, and the same ratio on xpcshell. So "the last 7 days" measured on a
 * Monday covers two days that barely ran, and a config's recent failure rate
 * would rest on a handful of runs and swing wildly. A fixed day count is a
 * rate whose denominator depends on the calendar.
 *
 * Instead the window is widened until the **sparsest** config has accumulated
 * `minRecentRuns` runs, and then *every* config uses that same window. Two
 * consequences worth stating because both are deliberate:
 *
 * - All configs share one window, so their recent rates cover the same period
 *   and are comparable, and the window can be described to the user once as a
 *   number of days rather than as a different run count per config.
 * - A config too sparse to ever reach the minimum does **not** widen the window
 *   for everyone else. It simply gets no recent rate — `null`, not zero,
 *   because "not enough data to say" and "0% failures" are different claims.
 *
 * The window is anchored to the **newest day any config ran**, not to each
 * config's own last active day. Anchoring per config would give a config that
 * stopped running a week ago a full "recent" window taken from its own last
 * active days, which is not recent at all.
 *
 * A config that has stopped running gets **no** recent rate, for the same
 * reason. It cannot be excluded by the anchor alone: it stretches the shared
 * window wide enough to reach back into the period it was alive, and then its
 * runs are inside that window by construction. `summarize` measures staleness
 * against the window the still-running configs need instead.
 *
 * `CLI.md`'s "recent (7d)" column is this window, and its width is an output
 * rather than a setting: the command prints the window it used.
 *
 * ## Why failures are counted twice over
 *
 * Every failure, and separately only those whose message matches one seen on
 * the try push. A test can fail for more than one reason on the same config, so
 * "this test fails 28% of the time here" and "it fails *this way* 28% of the
 * time here" are different claims — and only the second one says the failure in
 * your push is pre-existing. `fx-tests try`'s known-intermittent section rests
 * on the distinction.
 *
 * Timeouts and crashes frequently record no message at all (`FORMATS.md`:
 * `TIMEOUT*` and `CRASH` groups carry no `messageIds`), so for those the status
 * kind stands in for the message — `matchAnyTimeout` / `matchAnyCrash`.
 */

import type { DecodedTimingFile, RunEntry } from '../formats/decode.ts';
import { stripChunkSuffix } from '../model/job-name.ts';
import { classifyStatus } from '../model/status.ts';

/** Failure rates for one configuration. */
export interface ConfigStats {
    /** The job name with any chunk suffix stripped — the configuration identity. */
    jobName: string;
    /** Runs that reached a verdict on this config. Skips are not runs. */
    runCount: number;
    failCount: number;
    /** `failCount / runCount * 100`. 0 when the config had no runs. */
    failRate: number;
    /** Of `failCount`, those whose message matched one of `tryMessages`. */
    sameMsgFailCount: number;
    sameMsgFailRate: number;
    /**
     * The width of the shared recent window, in days. The same value on every
     * config — that is the point of it.
     */
    recentDays: number;
    /** Runs inside the recent window. */
    recentRunCount: number;
    /**
     * Failure rate inside the window, or `null` when there is no percentage to
     * state. Not 0 — "too little data to say" and "no failures" are different
     * claims.
     *
     * Two ways to get `null`: the config did not reach `minRecentRuns` inside
     * the window, or it has **stopped running**. The second matters because a
     * retired config stretches the window itself (see `summarize`), so without
     * it the column would report a month-old rate as this week's.
     */
    recentFailRate: number | null;
    /** Same-message failure rate inside the window, or `null`. */
    recentSameMsgFailRate: number | null;
}

/** Options for `computeConfigStats`. */
export interface ConfigStatsOptions {
    /**
     * Configurations to report on, as chunk-stripped job names. Omit for every
     * config that ran — `'all'` in the original's parameter.
     */
    jobNames?: readonly string[] | undefined;
    /**
     * How many runs a config needs inside the window before a percentage is
     * reported for it. Also what sizes the window.
     */
    minRecentRuns?: number | undefined;
    /**
     * Override the window width in days instead of deriving it from
     * `minRecentRuns`. `CLI.md`'s `--recent-days`.
     */
    recentDays?: number | undefined;
    /**
     * Failure messages and crash signatures seen on a try push, for the
     * same-message counts.
     */
    tryMessages?: Iterable<string> | undefined;
    /** Treat any timeout as matching, since timeouts record no message. */
    matchAnyTimeout?: boolean | undefined;
    /** Treat any crash as matching, since crashes record no message. */
    matchAnyCrash?: boolean | undefined;
    /** Restrict to a day range, as absolute day indices. Both ends inclusive. */
    dayRange?: { from: number; to: number } | undefined;
    /**
     * Keep only configurations whose job name satisfies this — `--config`.
     *
     * Must be applied here, not by filtering the returned rows: the recent window
     * is sized from the sparsest config in the set, so post-filtering labels every
     * row with a window computed over configs the report does not show. Tested
     * against the chunk-stripped name the rows are keyed on.
     */
    jobFilter?: ((jobName: string) => boolean) | undefined;
}

/** The default number of runs a config needs before a recent rate is reported. */
export const DEFAULT_MIN_RECENT_RUNS = 20;

/** Per-config accumulator. */
interface ConfigAccumulator {
    jobName: string;
    passCount: number;
    failCount: number;
    sameMsgFailCount: number;
    /** day -> [passes, failures, same-message failures] */
    byDay: Map<number, [number, number, number]>;
}

/**
 * Per-config failure rates, sorted by descending failure rate.
 *
 * Returns `[]` when the file cannot attribute runs to configurations at all —
 * `{harness}-issues.json` has no `taskInfo` and no `jobNameIds`, so the
 * question has no answer there rather than the answer "no configs failed".
 * `canAttributeConfigs()` is how a caller tells those apart before asking.
 */
export function computeConfigStats(
    file: DecodedTimingFile,
    testId: number,
    options: ConfigStatsOptions = {}
): ConfigStats[] {
    const minRecentRuns = options.minRecentRuns ?? DEFAULT_MIN_RECENT_RUNS;
    const wanted = options.jobNames === undefined ? null : new Set(options.jobNames);
    const tryMessages = new Set(options.tryMessages ?? []);
    const byJob = new Map<string, ConfigAccumulator>();

    const bump = (
        rawJobName: string,
        isFail: boolean,
        sameMsg: boolean,
        day: number | null,
        count: number
    ): void => {
        // Aggregating per configuration wants the chunk-stripped name: the
        // daily files keep the chunk and the aggregates do not, so without
        // this the same config splits into one row per chunk on one family and
        // not on the other (`FORMATS.md`: they differed on 360,373 of 433,836
        // runs on 2026-08-03).
        const jobName = stripChunkSuffix(rawJobName);
        if (wanted !== null && !wanted.has(jobName)) {
            return;
        }
        if (options.jobFilter !== undefined && !options.jobFilter(jobName)) {
            return;
        }
        let entry = byJob.get(jobName);
        if (entry === undefined) {
            entry = { jobName, passCount: 0, failCount: 0, sameMsgFailCount: 0, byDay: new Map() };
            byJob.set(jobName, entry);
        }
        if (isFail) {
            entry.failCount += count;
        } else {
            entry.passCount += count;
        }
        if (isFail && sameMsg) {
            entry.sameMsgFailCount += count;
        }
        // Bucket by day so the recent window can be taken newest-first below.
        // Daily files have no days array; treat those as a single day.
        const key = day ?? 0;
        let bucket = entry.byDay.get(key);
        if (bucket === undefined) {
            bucket = [0, 0, 0];
            entry.byDay.set(key, bucket);
        }
        bucket[isFail ? 1 : 0] += count;
        if (isFail && sameMsg) {
            bucket[2] += count;
        }
    };

    for (const entry of file.runsOfTest(testId)) {
        const { kind } = classifyStatus(entry.status);
        // Skips are not runs and must not enter a denominator; `unknown`
        // reported no outcome, so counting it either way invents information.
        if (kind === 'skip' || kind === 'unknown') {
            continue;
        }
        if (
            options.dayRange !== undefined &&
            entry.day !== null &&
            (entry.day < options.dayRange.from || entry.day > options.dayRange.to)
        ) {
            continue;
        }

        // `expected-fail` is deliberately not a failure: the test failed as its
        // annotation said it would, so counting it inflates failure rates and
        // — via `sameMsg` below — would report a working annotation as a
        // pre-existing failure matching a try push.
        const isFail = kind === 'fail' || kind === 'timeout' || kind === 'crash';
        const sameMsg = isFail
            ? entryMatches(entry, kind, tryMessages, options)
            : false;

        if (entry.jobName !== undefined) {
            // PASS and SKIP groups attribute each entry to a job directly.
            bump(entry.jobName, isFail, sameMsg, entry.day, entry.count);
        } else if (entry.taskIdIndexes !== undefined) {
            // FAIL, TIMEOUT and CRASH groups carry only task IDs, so the job
            // has to be resolved through `taskInfo` — one run per task ID,
            // since the bucket's length is its run count.
            for (const taskIdIndex of entry.taskIdIndexes) {
                const jobName = file.jobNameOfTaskIndex(taskIdIndex);
                if (jobName !== null) {
                    bump(jobName, isFail, sameMsg, entry.day, 1);
                }
            }
        }
        // An entry with neither is `{harness}-issues.json`'s `counts` shape,
        // which discarded attribution entirely. Nothing to attribute it to.
    }

    return summarize(byJob, minRecentRuns, options.recentDays);
}

/** The kinds that count as a failure, and the only ones `entryMatches` sees. */
type FailureKind = 'fail' | 'timeout' | 'crash';

/**
 * Whether a failing entry's message is one of the messages seen on try.
 *
 * Crashes match on the signature and everything else on the message, because
 * those are the fields each status actually carries. Timeouts and crashes
 * often carry neither, which is what `matchAnyTimeout`/`matchAnyCrash` are for.
 *
 * Takes a `FailureKind` rather than any `StatusKind` deliberately. This used to
 * open with `if (kind === 'pass' || kind === 'expected-fail') return false`,
 * which read as a guard and was not one: the result is only ever consumed under
 * `if (isFail && sameMsg)`, so a pass or an expected-fail could never reach the
 * counter whatever this returned. A mutation removing that clause left the
 * suite green *and* changed no output on any input, because the branch was
 * unreachable-by-effect rather than merely untested. Narrowing the parameter
 * says the same thing in a way the compiler enforces and no test has to.
 *
 * The behaviour it encoded still holds and still matters: a test annotated
 * `fail-if` that failed did what it was told, so it must never be reported as
 * a failure matching a try push's. That is now guaranteed by `expected-fail`
 * not being in `isFail` at the one call site.
 */
function entryMatches(
    entry: RunEntry,
    kind: FailureKind,
    tryMessages: ReadonlySet<string>,
    options: ConfigStatsOptions
): boolean {
    if (kind === 'timeout' && options.matchAnyTimeout) {
        return true;
    }
    if (kind === 'crash' && options.matchAnyCrash) {
        return true;
    }
    const text = kind === 'crash' ? entry.crashSignature : entry.message;
    return text !== null && text !== undefined && tryMessages.has(text);
}

/** Turns the accumulators into sorted `ConfigStats`, sizing the shared window. */
function summarize(
    byJob: ReadonlyMap<string, ConfigAccumulator>,
    minRecentRuns: number,
    forcedRecentDays: number | undefined
): ConfigStats[] {
    // Anchor the window to the newest day any of these configs ran, so that
    // "the last N days" means the same period for all of them. Anchoring per
    // config would give one that stopped running days ago a full recent window
    // taken from its own last active days, which is not recent at all.
    let newestDay = -Infinity;
    for (const entry of byJob.values()) {
        for (const day of entry.byDay.keys()) {
            newestDay = Math.max(newestDay, day);
        }
    }

    // How many days back each config needs to reach minRecentRuns. The widest
    // of those becomes one window shared by every config, so the rates cover
    // the same period and can be compared, and so the window can be described
    // once as a number of days instead of a different run count per config.
    let windowDays = 1;
    if (forcedRecentDays !== undefined) {
        windowDays = Math.max(1, forcedRecentDays);
    } else {
        for (const entry of byJob.values()) {
            const needed = daysToReach(entry, minRecentRuns, newestDay);
            // A config too sparse to ever reach the minimum must not stretch
            // the window for everyone else; it simply gets no recent rate.
            if (needed !== null) {
                windowDays = Math.max(windowDays, needed);
            }
        }
    }

    // How stale a config may be before its "recent" rate stops being recent.
    //
    // `windowDays` cannot answer that, because a *retired* config stretches it.
    // The sizing loop above walks a config's days newest-first until it has
    // `minRecentRuns`, and a config that stopped two weeks ago still gets there
    // by reaching back into the fortnight it was alive — so it sets a window
    // wide enough to contain its own death, for every config. Measured on
    // `browser_aboutdebugging_connect_toggle_usb_devices.js`: three mac configs
    // skipped out on day 6 of 20, one of them needs 15 days to find 20 runs, and
    // the resulting 15-day "recent" rate is computed entirely from runs that
    // stopped a fortnight earlier. It reads as a live failure rate for a
    // configuration that no longer exists, which is the confidently-wrong number
    // this project keeps producing.
    //
    // So staleness is measured against the window the *live* configs need — the
    // widest reach-back among configs that ran on the newest day — rather than
    // against the stretched one. A config whose last run predates that has no
    // recent rate, the same `null` a config with too few recent runs already
    // gets. The window itself is untouched: this changes who gets a percentage,
    // not what period the percentage covers.
    const liveWindow = liveWindowDays(byJob, minRecentRuns, newestDay, windowDays);

    const configs: ConfigStats[] = [];
    for (const entry of byJob.values()) {
        const runCount = entry.passCount + entry.failCount;
        const from = newestDay - windowDays + 1;
        let lastActiveDay = -Infinity;
        for (const day of entry.byDay.keys()) {
            lastActiveDay = Math.max(lastActiveDay, day);
        }
        const stillRunning = lastActiveDay > newestDay - liveWindow;
        let recentPass = 0;
        let recentFail = 0;
        let recentSameMsg = 0;
        for (const [day, [passes, fails, sameMsg]] of entry.byDay) {
            if (day < from) {
                continue;
            }
            recentPass += passes;
            recentFail += fails;
            recentSameMsg += sameMsg;
        }
        const recentRunCount = recentPass + recentFail;
        // Below the minimum there is not enough data to build a percentage from,
        // and a config that has stopped running has no *recent* data at all —
        // only old data that a stretched window happens to enclose.
        const enough = recentRunCount >= minRecentRuns && stillRunning;
        configs.push({
            jobName: entry.jobName,
            runCount,
            failCount: entry.failCount,
            failRate: runCount > 0 ? (entry.failCount / runCount) * 100 : 0,
            sameMsgFailCount: entry.sameMsgFailCount,
            sameMsgFailRate: runCount > 0 ? (entry.sameMsgFailCount / runCount) * 100 : 0,
            recentDays: windowDays,
            recentRunCount,
            recentFailRate: enough ? (recentFail / recentRunCount) * 100 : null,
            recentSameMsgFailRate: enough ? (recentSameMsg / recentRunCount) * 100 : null,
        });
    }
    configs.sort((a, b) => b.failRate - a.failRate);
    return configs;
}

/**
 * How many days back this config must reach to accumulate `minRecentRuns`, or
 * `null` when it never gets there.
 *
 * Walks newest-first from the shared anchor, so the answer is in the same
 * "days before `newestDay`" units the window is expressed in — which is what
 * lets the sizing loop and the staleness test below share one definition
 * instead of drifting into two.
 */
function daysToReach(
    entry: ConfigAccumulator,
    minRecentRuns: number,
    newestDay: number
): number | null {
    let runs = 0;
    let needed = 0;
    for (const day of [...entry.byDay.keys()].sort((a, b) => b - a)) {
        const bucket = entry.byDay.get(day)!;
        runs += bucket[0] + bucket[1];
        needed = newestDay - day + 1;
        if (runs >= minRecentRuns) {
            return needed;
        }
    }
    return null;
}

/**
 * The window the configurations that are **still running** need, in days.
 *
 * The reference `summarize` measures staleness against. `windowDays` is the
 * widest reach-back over *every* config, which a retired one inflates; this is
 * the widest over those that ran on the newest day, and a config cannot inflate
 * it by having stopped. Falls back to `windowDays` when nothing ran on the
 * newest day at all — a tree-wide quiet spell, where no config is stale
 * relative to its neighbours and the old behaviour is the right one.
 */
function liveWindowDays(
    byJob: ReadonlyMap<string, ConfigAccumulator>,
    minRecentRuns: number,
    newestDay: number,
    windowDays: number
): number {
    let live = 0;
    for (const entry of byJob.values()) {
        if (!entry.byDay.has(newestDay)) {
            continue;
        }
        live = Math.max(live, daysToReach(entry, minRecentRuns, newestDay) ?? 1);
    }
    return live === 0 ? windowDays : live;
}

/**
 * Whether a file can attribute runs to configurations at all.
 *
 * `{harness}-issues.json` cannot: it has no `taskInfo` and its groups carry no
 * `jobNameIds`, so every per-config query over it returns nothing. That is a
 * property of the file and not of the test, and a caller should say "this file
 * cannot answer that" rather than "this test failed on no configs".
 */
export function canAttributeConfigs(file: DecodedTimingFile): boolean {
    return file.family !== 'issues';
}
