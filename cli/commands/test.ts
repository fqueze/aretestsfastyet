/**
 * `fx-tests test <path>` — everything about one test.
 *
 * The workhorse, and the command that has to answer "why is this test failing,
 * and is it my fault?" without the caller having to know anything about the
 * data.
 *
 * Reads **one 64-bucket file**: 21 days of history for ~3.5 MB, against a
 * daily file's ~37 MB and 5× the heap (`FORMATS.md`). `--day` and `--since`
 * are filters on that same file, not a reason to fetch another one — every
 * status group carries a delta-encoded `days` array, so a day range costs
 * nothing extra. See `cli/data.ts` for why that matters.
 *
 * ## What the default output does and does not show
 *
 * `CLI.md`'s design goal is "answers, not dumps": a verdict first, then the
 * numbers behind it, then the failing configurations. Passing configurations
 * are behind `--coverage` because the default question is "what is broken",
 * and a 34-row table where 31 rows say `ok` buries the three that do not.
 *
 * Execution detail follows `PLAN.md` §5's assumption: the verdict mentions
 * initial-vs-rerun and parallel-vs-sequential only **when they change the
 * interpretation**, and the full breakdown is behind `--executions`. A test
 * that fails 20 times in parallel and once sequentially is a different bug
 * from one that fails evenly, and saying so in the verdict is worth one line;
 * printing both tables always is not.
 */

import { chunkOfTask } from '../../lib/formats/buckets.ts';
import type { DecodedTimingFile, RunEntry } from '../../lib/formats/decode.ts';
import { type TestIdentity, parseTaskId } from '../../lib/formats/tables.ts';
import { otherHarness } from '../../lib/model/harness.ts';
import { CANDIDATE_LIMIT, resolveTest } from '../../lib/query/test-lookup.ts';
import {
    type ModeBreakdown,
    addToModeBreakdown,
    countRerunsByTask,
    emptyModeBreakdown,
    hasModeAxis,
} from '../../lib/model/execution.ts';
import { classifyStatus } from '../../lib/model/status.ts';
import {
    type ConfigStats,
    canAttributeConfigs,
    computeConfigStats,
} from '../../lib/query/config-stats.ts';
import {
    type TestCoverage,
    coverageOf,
    coveragePlatforms,
    platformsCovered,
    platformsInFile,
} from '../../lib/query/coverage.ts';
import { buildTestIssues } from '../../lib/query/test-issues.ts';
import {
    type TestStats,
    computeTestStats,
    configFilter,
    crashSignatureCounts,
    failureMessageCounts,
    inDayRange,
    narrowEntryToConfig,
} from '../../lib/query/test-stats.ts';
import {
    resourceUsageProfileUrl,
    uploadedProfileUrl,
} from '../../lib/links.ts';
import { type OptionSpecs, type ParsedArgs, boolOption, numberOption } from '../args.ts';
import { type CommandContext, emit, notice, progress, warn } from '../context.ts';
import { DEFAULT_DAYS as INTERMITTENT_DEFAULT_DAYS, resolveRange } from './intermittent.ts';
import {
    bugsNamingTest,
    loadHarnessOfPath,
    scanBugs,
} from '../../lib/query/intermittents.ts';
import { notFoundError, usageError, withUpstreamErrors } from '../errors.ts';
import { toJson } from '../format/json.ts';
import * as md from '../format/markdown.ts';
import {
    applyLimit,
    count as fmtCount,
    dateWithWeekday,
    joinLines,
    moreLine,
    percent,
    table,
    truncate,
} from '../format/text.ts';
import { resolveHarness } from '../options.ts';
import {
    type DayWindow,
    dateOfDayIndex,
    resolveDayWindow,
    testLookupLoaders,
} from '../data.ts';

/** Options `test` adds to the globals. */
export const TEST_OPTIONS: OptionSpecs = {
    coverage: {
        type: 'boolean',
        describe: 'Every config the test ran on, passing ones included.',
    },
    executions: {
        type: 'boolean',
        describe: 'Break failures down by rerun and by execution mode.',
    },
    'recent-days': {
        type: 'number',
        placeholder: '<n>',
        describe: 'Override the automatically-sized recent window.',
    },
    'task-ids': {
        type: 'boolean',
        describe:
            'Print the task IDs behind each failure, and the minidump IDs of any crashes.',
    },
    profiles: {
        type: 'boolean',
        describe: 'Print raw profile artifact URLs for each failure.',
    },
    durations: {
        type: 'boolean',
        describe: 'Per-config run-time distribution from the pass durations.',
    },
    history: { type: 'boolean', describe: 'A per-day sparkline of pass/fail counts.' },
    // Opt-in, unlike every other section on this command, and for a reason
    // that is not about this process: it is the only flag here that reaches a
    // live API rather than the published aggregate the rest of the command
    // reads. `test` is run constantly, so resolving the annotations by default
    // would put a per-user load on the machines serving Treeherder's
    // `/api/failures/` that they did not previously carry — a cost a local
    // cache TTL cannot give back, because it is upstream rather than local.
    bugs: {
        type: 'boolean',
        describe:
            'The sheriff-annotated bugs naming this test. Off by default because it queries ' +
            'Treeherder and Bugzilla live, several requests, where the rest of this command ' +
            'reads one published file.',
    },
};

/** The default number of failing-config rows and messages shown. */
const DEFAULT_LIMIT = 10;

/**
 * How wide a bug summary may get in the `Bugs naming this test` block.
 *
 * A `truncate()` budget, stated against the 90-column baseline and scaled to
 * the real terminal rather than an absolute width. 78 is the p90 of the
 * summaries in a live 731-bug ranking (median 19, max 182), so the common row
 * prints whole and only the outliers are cut — which is the point of measuring
 * rather than guessing. The line is indented 11 to sit under the bug number.
 */
const SUMMARY_WIDTH = 78;

/** The `--json` shape `CLI.md` documents. */
export interface TestJson {
    test: string;
    path: string;
    component: string | null;
    harness: string;
    metadata: {
        family: string;
        generatedAt: string;
        startDate: string;
        endDate: string;
        dayCount: number;
        singleDay: boolean;
        dataSource: string;
    };
    /**
     * The filter these numbers were measured under, `null` when none was given.
     * Every count below is over the filtered population, so a filtered `0 fail`
     * is otherwise indistinguishable from a healthy test.
     */
    configFilter: { include: string[]; exclude: string[] } | null;
    totals: TestStats;
    verdict: Verdict;
    configs: ConfigStats[];
    /**
     * Whether the file can attribute runs to configurations at all.
     *
     * `configs: []` means two different things — "no config failed" and "this
     * file cannot say" — and only this field separates them. `issues.json`
     * has no `taskInfo`, so every per-config query over it is empty regardless
     * of the test.
     */
    canAttributeConfigs: boolean;
    /** The window `configs`' recent rates were computed over. */
    recentWindow: { days: number; minRuns: number } | null;
    /**
     * Where the test runs at all, for `CLI.md`'s "Runs on N configs across
     * ..." line.
     *
     * In the default view, not just under `--coverage`: the failing-config
     * table cannot answer "does this run on Android at all?", and that
     * question has to be settled before concluding a platform is unaffected.
     * `null` when the file cannot attribute passing runs to a config, since
     * then the answer would be the failing configs only.
     */
    reach: {
        configCount: number;
        platforms: { platform: string; configCount: number }[];
        /** Platforms in the file that this test never runs on. */
        absentPlatforms: string[];
    } | null;
    /**
     * The sheriff-annotated bugs whose summary names this test, under `--bugs`.
     *
     * The first question anyone asks about a failing test, and the command
     * answered none of it: finding the bug number meant pulling the whole
     * `intermittent` ranking as JSON and grepping it. Resolved through
     * `bugsNamingTest`, the same lookup `intermittent --test` uses.
     *
     * Three states, kept apart because a consumer branches differently on each
     * and collapsing any two of them would be a confidently wrong answer:
     *
     *  - **absent** — `--bugs` was not passed. Nothing was asked and no request
     *    was made, which is why the default path is as network-quiet as it was
     *    before the flag existed. Encoded as a missing key rather than `null`
     *    on purpose: `null` and `[]` both read as "no bugs" at a glance, and
     *    `null` is the *more* natural spelling of it, so it suggested the
     *    opposite of what it meant. Absence cannot be misread — the test is
     *    `'annotatedBugs' in result`.
     *  - `{ error: … }` — asked, and the lookup failed. The intermittents API
     *    is live where `test`'s own data is not, so a Treeherder outage must
     *    not take the rest of the answer with it.
     *  - an array — asked and answered. Empty means no annotated bug names the
     *    test, which is a real result rather than a failure to get one.
     */
    annotatedBugs?:
        | {
              bugId: number;
              count: number;
              /**
               * The bug's Bugzilla summary, with the triage prefix and the test
               * path removed — the part naming the failure rather than
               * repeating what the caller already typed.
               */
              bugSummary: string;
              /** The window the count covers, in days. */
              days: number;
              tree: string;
          }[]
        | { error: string };
    /**
     * Whether the per-day failure counts sit within an order of magnitude of
     * the window's median. `null` when the file carries no day axis, or the
     * window is one day, or nothing failed — there is nothing to be flat.
     *
     * The default view has no time axis at all, so a failure that started on a
     * Tuesday and one that has been there for three weeks read identically.
     * `--history` is what separates them and nothing pointed at it; this is the
     * one line that does, and only when the answer would change what the reader
     * does next. The sparkline itself stays behind the flag.
     */
    dailyCountsAreFlat: boolean | null;
    /**
     * Every issue of this test, ordered by count — the list `test.html` shows.
     *
     * `messages`, `crashSignatures` and `skips` below are slices of this, kept
     * because `CLI.md` documents them; all three are keyed on message text, so
     * none of them can carry a timeout.
     */
    issues: { count: number; type: string; message: string }[];
    messages: { message: string; count: number }[];
    crashSignatures: { signature: string; count: number }[];
    skips: { message: string; count: number }[];
    coverage?: CoverageJson;
    executions?: ExecutionsJson;
    durations?: DurationsJson[];
    history?: HistoryJson[];
    taskIds?: TaskIdJson[];
    profiles?: ProfileJson[];
}

/** The verdict, computed once and rendered by every format. */
export interface Verdict {
    /** The one-word answer. */
    kind: 'passing' | 'intermittent' | 'perma-fail' | 'skipped-everywhere' | 'no-data';
    /** The sentence shown under the totals. */
    summary: string;
    /** Extra clauses that change the interpretation, per `PLAN.md` §5. */
    notes: string[];
}

interface CoverageJson {
    attributedPasses: boolean;
    configs: {
        jobName: string;
        state: string;
        runCount: number;
        passCount: number;
        failCount: number;
        skipCount: number;
        skipMessages: { message: string; count: number }[];
    }[];
    /** Platforms the test *ran* on, and how many configs on each. */
    platforms: { platform: string; configCount: number }[];
    /**
     * Every platform the test is *scheduled* on, ran or not.
     *
     * One row per platform that appears in `configs`, and no rows for anything
     * else. A consumer asking "does this run on Android?" reads the absence of
     * an `android` row as the answer — which is what the data supports. There
     * is deliberately no list of configs the test was not scheduled on: see
     * `lib/query/coverage.ts` for why no such list has a defensible boundary.
     */
    scheduledPlatforms: {
        platform: string;
        ranCount: number;
        skippedCount: number;
    }[];
}

interface ExecutionsJson {
    /** Null when the data records no mode axis — mochitest. See below. */
    modeAxis: {
        failures: ModeBreakdown;
        runs: ModeBreakdown;
        /** Failure rate per mode, `null` where the mode had no runs. */
        failRate: { parallel: number | null; sequential: number | null; unrecorded: number | null };
    } | null;
    reruns: { jobs: number; runs: number; jobsWithRerun: number };
}

interface DurationsJson {
    jobName: string;
    runCount: number;
    min: number;
    median: number;
    p95: number;
    max: number;
}

interface HistoryJson {
    date: string;
    pass: number;
    fail: number;
    timeout: number;
    crash: number;
    skip: number;
}

interface TaskIdJson {
    taskId: string;
    retryId: number;
    jobName: string | null;
    chunk: number | null;
    status: string;
    day: string | null;
    message: string | null;
    /**
     * The processed crash dump, on a `CRASH` row whose dump was uploaded.
     *
     * Absent rather than null when there is none: a crash can be recorded with
     * no dump — 58 such entries in the sweep — and an explicit null would read
     * as "there is a dump, and it is null".
     */
    minidumpId?: string;
    /** The `fx-tests crash` invocation that reads it, ready to paste. */
    crashCommand?: string;
}

interface ProfileJson {
    taskId: string;
    retryId: number;
    jobName: string | null;
    /** Always available: derivable from the task ID alone. */
    resourceUsage: string;
    /**
     * The per-test failure profile, when the failure message named one.
     * Absent otherwise — the filename is not derivable and `CLI.md` says to
     * emit nothing rather than guess.
     */
    testProfile?: string;
}

interface LookedUpTest {
    harness: string;
    decoded: DecodedTimingFile;
    file: { metadata: { generatedAt: string }; taskInfo?: { chunks?: (number | null)[] } };
    identity: TestIdentity;
}

/**
 * Turns what was typed into a test, walking `resolveTest`'s shared ladder.
 *
 * Every message below is scoped to the lookup, not to the test: a sentence about
 * which file was read is read as a verdict on the test's health.
 */
async function lookUpTest(context: CommandContext, testPath: string): Promise<LookedUpTest> {
    if (context.loadTimingFile !== undefined) {
        // The test-only seam (`LoadedTimingFile` in `cli/context.ts`) hands
        // back one injected file, so there is no ladder to walk here.
        const { harness } = resolveHarness(testPath, context.globals.harness);
        const loaded = await context.loadTimingFile(harness, testPath);
        const identity = loaded.decoded.findTest(testPath);
        if (identity === null) {
            throw notFoundError(
                `the injected ${harness} file does not hold ${testPath}`,
                'This is the test-only loadTimingFile seam; production walks the resolution ladder.'
            );
        }
        return { harness, decoded: loaded.decoded, file: loaded.raw, identity };
    }

    const loaders = testLookupLoaders(context);
    progress(context, `Looking up ${testPath}…`);
    const resolution = await resolveTest(testPath, context.globals.harness, loaders);

    if (resolution.kind === 'found') {
        if (resolution.resolvedFrom !== null) {
            notice(
                context,
                `Resolved "${resolution.resolvedFrom}" to the one test matching it: ` +
                    `${resolution.testPath}`
            );
        }
        if (resolution.viaOtherHarness) {
            notice(
                context,
                `Found in ${resolution.harness} data, not the ${otherHarness(resolution.harness)} ` +
                    'the filename suggests.'
            );
        }
        return {
            harness: resolution.harness,
            decoded: resolution.file.decoded,
            file: resolution.file.raw,
            identity: resolution.identity,
        };
    }

    if (resolution.kind === 'not-in-file') {
        throw notFoundError(
            `${resolution.testPath} is a test in the tree-wide data, but it is not in ` +
                `the ${resolution.searched.join(' or ')} file that should describe it` +
                (loaders.missingFiles.length === 0
                    ? '.'
                    : ` (${loaders.missingFiles.join(', ')} not published).`),
            context.globals.harness === undefined
                ? 'The two families are published separately, so this is usually a window they disagree on. Retry later.'
                : `Drop --harness ${context.globals.harness}: the test may not run under it.`
        );
    }

    if (resolution.kind === 'ambiguous') {
        const shown = applyLimit(resolution.candidates, context.globals.limit ?? DEFAULT_LIMIT);
        // Two shortfalls to account for: `--limit` cut what is shown, and
        // `CANDIDATE_LIMIT` cut what the ladder collected. `--limit 0` lifts
        // only the first, so it is offered only when it would deliver.
        const hidden = resolution.total - shown.length;
        throw notFoundError(
            `"${resolution.query}" is not a test path, and ${resolution.total} tests ` +
                `match it. Nothing was measured; pick one:\n` +
                shown.map((candidate) => `  ${candidate}`).join('\n') +
                (hidden === 0
                    ? ''
                    : `\n  … and ${hidden} more not shown` +
                      (resolution.truncated
                          ? ` (${CANDIDATE_LIMIT} candidates is the most this message collects;` +
                            ' narrow the fragment to see the rest)'
                          : ' (--limit 0 for all)')),
            'Add more of the path to narrow it — every space-separated word has to appear somewhere in it.'
        );
    }

    const searched = resolution.searched.join(' and ');
    if (resolution.allTests === null) {
        throw notFoundError(
            `Not in the ${searched} bucket files for this path` +
                (loaders.missingFiles.length === 0
                    ? ''
                    : ` (${loaders.missingFiles.join(', ')} not published)`) +
                `, and the test list could not be read, so no search was made: ${resolution.query}`,
            'This says nothing about the test — retry to search the full test list, ' +
                'or pass the path exactly as it appears in the tree.'
        );
    }
    throw notFoundError(
        `No test path in the ${searched} 21-day data contains "${resolution.query}", ` +
            `so this reports nothing about the test itself.`,
        'It may have been renamed, added after the window started, or never run in CI. ' +
            'Check the spelling, or pass a longer fragment of the path.'
    );
}

/** Runs the command. */
export async function runTest(context: CommandContext, args: ParsedArgs): Promise<void> {
    const testPath = args.positionals[0];
    if (testPath === undefined) {
        throw usageError(
            'test requires a path',
            'Usage: fx-tests test <path>, e.g. fx-tests test netwerk/test/unit/test_bug1195415.js'
        );
    }
    if (args.positionals.length > 1) {
        throw usageError(
            `test takes one path, got ${args.positionals.length}: ${args.positionals.join(', ')}`
        );
    }

    const { harness, decoded, file, identity } = await lookUpTest(context, testPath);

    const window = resolveDayWindow(context.globals, decoded);
    const jobFilter = configFilter(context.globals.config, context.globals.excludeConfig);
    const hasConfigFilter =
        context.globals.config.length > 0 || context.globals.excludeConfig.length > 0;

    // Refuse rather than filter a family with no job names: every section here is
    // per-run, so the alternative is a page of zeros reading as "clean on that
    // configuration". Reachable only through the `loadTimingFile` seam today.
    if (hasConfigFilter && !canAttributeConfigs(decoded)) {
        throw usageError(
            `--config cannot be applied to this ${harness} file: it records no job names, ` +
                'so every configuration filter over it matches nothing',
            'This is a property of the file, not of the test. The 64-bucket files that back ' +
                '--config are what `--data-source central` serves by default.'
        );
    }

    const statsOptions = {
        ...(window.range === null ? {} : { dayRange: window.range }),
        ...(hasConfigFilter ? { jobFilter } : {}),
    };

    const totals = computeTestStats(decoded, identity.testId, statsOptions);

    const recentDays = numberOption(args, 'recent-days');
    const configs = computeConfigStats(decoded, identity.testId, {
        ...(window.range === null ? {} : { dayRange: window.range }),
        ...(recentDays === undefined ? {} : { recentDays }),
        ...(hasConfigFilter ? { jobFilter } : {}),
    });

    const entries = [...decoded.runsOfTest(identity.testId)].filter((entry) =>
        inDayRange(entry.day, window.range ?? undefined)
    );
    // Narrowed per task, not filtered per entry: dropping a whole entry on its
    // first task's job loses runs on the requested config and keeps runs on every
    // other one. `narrowEntryToConfig` carries the detail.
    const filteredEntries = hasConfigFilter
        ? entries.flatMap((entry) => {
              const narrowed = narrowEntryToConfig(decoded, entry, jobFilter);
              return narrowed === null ? [] : [narrowed];
          })
        : entries;

    const messages = [...failureMessageCounts(decoded, identity.testId, statsOptions)]
        .map(([message, count]) => ({ message: message ?? '(no message recorded)', count }))
        .sort((a, b) => b.count - a.count);
    const crashSignatures = [...crashSignatureCounts(decoded, identity.testId, statsOptions)]
        .map(([signature, count]) => ({
            signature: signature ?? '(no signature recorded)',
            count,
        }))
        .sort((a, b) => b.count - a.count);
    const skips = collectSkips(filteredEntries);

    const failingConfigs = configs.filter((config) => config.failCount > 0);
    const verdict = computeVerdict(totals, failingConfigs, filteredEntries, decoded);

    // Computed whether or not `--coverage` was passed, because the default
    // view needs it too: `CLI.md` puts a "Runs on N configs across ..." line
    // directly under the verdict, and a failing-config table cannot answer
    // "does this run on Android at all?". It is one pass over this test's own
    // entries, so it is cheap either way.
    const coverage = coverageOf(decoded, identity.testId, {
        ...(window.range === null ? {} : { dayRange: window.range }),
        ...(hasConfigFilter ? { jobFilter } : {}),
    });

    // The same rows `--history` prints, computed whether or not it was asked
    // for: the default view's flatness hint is a reading of them, and a second
    // per-day tally would be a second thing to keep in step. One pass over this
    // test's own entries, so it costs what `--history` costs, which is nothing.
    const history = buildHistory(decoded, filteredEntries, window);

    const result: TestJson = {
        test: identity.name,
        path: identity.fullPath,
        component: identity.component,
        harness,
        metadata: {
            family: decoded.family,
            generatedAt: file.metadata.generatedAt,
            startDate: window.startDate,
            endDate: window.endDate,
            dayCount: window.dayCount,
            singleDay: window.singleDay,
            dataSource: context.source.name,
        },
        configFilter: hasConfigFilter
            ? {
                  include: [...context.globals.config],
                  exclude: [...context.globals.excludeConfig],
              }
            : null,
        totals,
        verdict,
        configs: failingConfigs,
        canAttributeConfigs: canAttributeConfigs(decoded),
        recentWindow:
            configs.length === 0 || window.singleDay
                ? null
                : { days: configs[0]!.recentDays, minRuns: 20 },
        reach: buildReach(decoded, coverage),
        dailyCountsAreFlat: dailyCountsAreFlat(history),
        // `statsOptions` is the same day and config filter the header totals
        // used, so the list and the totals cover one population.
        issues: buildTestIssues(decoded, identity.testId, totals, statsOptions),
        messages,
        crashSignatures,
        skips,
    };

    if (boolOption(args, 'coverage')) {
        result.coverage = buildCoverage(coverage);
    }
    if (boolOption(args, 'executions')) {
        result.executions = buildExecutions(decoded, filteredEntries);
    }
    if (boolOption(args, 'durations')) {
        result.durations = buildDurations(decoded, filteredEntries);
    }
    if (boolOption(args, 'history')) {
        result.history = history;
    }
    if (boolOption(args, 'bugs')) {
        result.annotatedBugs = await fetchAnnotatedBugs(context, identity.fullPath);
    }
    if (boolOption(args, 'task-ids')) {
        result.taskIds = buildTaskIds(file, decoded, filteredEntries, window);
    }
    if (boolOption(args, 'profiles')) {
        result.profiles = buildProfiles(decoded, filteredEntries);
    }

    if (context.globals.format === 'json') {
        emit(context, toJson(result));
        return;
    }
    const limit = context.globals.limit ?? DEFAULT_LIMIT;
    emit(
        context,
        context.globals.format === 'markdown'
            ? renderMarkdown(result, limit)
            : renderText(result, limit)
    );
}

/** The job a run entry belongs to, whichever way the shape records it. */
function jobNameOf(file: DecodedTimingFile, entry: RunEntry): string | null {
    if (entry.jobName !== undefined) {
        return entry.jobName;
    }
    const first = entry.taskIdIndexes?.[0];
    return first === undefined ? null : file.jobNameOfTaskIndex(first);
}

/** Skip messages with counts, `run-if` already excluded by the aggregate. */
function collectSkips(entries: readonly RunEntry[]): { message: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const entry of entries) {
        if (classifyStatus(entry.status).kind !== 'skip') {
            continue;
        }
        const message = entry.message ?? '(no reason recorded)';
        counts.set(message, (counts.get(message) ?? 0) + entry.count);
    }
    return [...counts]
        .map(([message, count]) => ({ message, count }))
        .sort((a, b) => b.count - a.count);
}

/**
 * The verdict, and the notes that qualify it.
 *
 * The ordering matters: a test that perma-fails on one config is reported as a
 * perma-fail even when its overall pass rate is 99%, because the overall rate
 * is exactly the number that hides it. `CLI.md`'s worked example makes the same
 * point — "a test's overall failure rate understates a single-config
 * perma-fail" is listed as one of the traps `guide` exists to warn about.
 */
function computeVerdict(
    totals: TestStats,
    failingConfigs: readonly ConfigStats[],
    entries: readonly RunEntry[],
    file: DecodedTimingFile
): Verdict {
    const notes: string[] = [];

    if (totals.runCount === 0) {
        return {
            kind: totals.skipCount > 0 ? 'skipped-everywhere' : 'no-data',
            summary:
                totals.skipCount > 0
                    ? `skipped everywhere in this window (${fmtCount(totals.skipCount)} skipped runs, no runs at all).`
                    : 'no runs recorded in this window.',
            notes,
        };
    }

    const permaFails = failingConfigs.filter((config) => config.failRate >= 100);
    const worst = failingConfigs[0];

    // Mode skew is a note rather than a section: it changes what the failure
    // means (a race with neighbours rather than a broken test) and costs one
    // line. The full table is behind --executions.
    const modeNote = modeSkewNote(entries, file);
    if (modeNote !== null) {
        notes.push(modeNote);
    }
    const rerunNote = rerunNoteOf(entries);
    if (rerunNote !== null) {
        notes.push(rerunNote);
    }

    if (permaFails.length > 0) {
        // No "n of m configurations" here: `computeConfigStats` returns only
        // the configs that ran this test, so any denominator built from it
        // would silently exclude configs that only ever passed. `--coverage`
        // is where the full matrix lives, and the verdict points at it rather
        // than inventing a total.
        return {
            kind: 'perma-fail',
            summary:
                `perma-fail. Never passed on ${permaFails.length} ` +
                `configuration${permaFails.length === 1 ? '' : 's'}: ` +
                permaFails
                    .slice(0, 3)
                    .map((config) => `${config.jobName} (${config.failCount}/${config.runCount})`)
                    .join(', ') +
                (permaFails.length > 3 ? `, and ${permaFails.length - 3} more` : '') +
                '. Use --coverage for every config it runs on.',
            notes,
        };
    }

    if (failingConfigs.length === 0) {
        return {
            kind: 'passing',
            summary:
                `passing. ${fmtCount(totals.passCount)} of ${fmtCount(totals.runCount)} runs passed` +
                (totals.expectedFailCount > 0
                    ? `, plus ${fmtCount(totals.expectedFailCount)} expected failures`
                    : '') +
                '.',
            notes,
        };
    }

    return {
        kind: 'intermittent',
        summary:
            `intermittent. Fails on ${failingConfigs.length} ` +
            `configuration${failingConfigs.length === 1 ? '' : 's'}; ` +
            (worst === undefined
                ? ''
                : `worst is ${worst.jobName} at ${percent(worst.failRate)} ` +
                  `(${worst.failCount}/${worst.runCount})`) +
            '.',
        notes,
    };
}

/**
 * A note when failures skew strongly to one execution mode.
 *
 * The threshold is deliberately conservative: a mode has to carry at least
 * four fifths of the failures *and* the other mode has to have had a
 * meaningful number of runs, otherwise "fails only in parallel" would fire for
 * a test that simply never ran sequentially. `FORMATS.md` is explicit that
 * plain `PASS` is its own bucket rather than the sum of the two modes, so the
 * unrecorded bucket is kept separate and never folded into either.
 */
function modeSkewNote(entries: readonly RunEntry[], file: DecodedTimingFile): string | null {
    if (!hasModeAxis(file.statuses)) {
        return null;
    }
    const failures = emptyModeBreakdown();
    const runs = emptyModeBreakdown();
    for (const entry of entries) {
        const { kind } = classifyStatus(entry.status);
        if (kind === 'skip' || kind === 'unknown') {
            continue;
        }
        addToModeBreakdown(runs, entry.status, entry.count);
        if (kind === 'fail' || kind === 'timeout' || kind === 'crash') {
            addToModeBreakdown(failures, entry.status, entry.count);
        }
    }
    const total = failures.parallel + failures.sequential;
    if (total < 5) {
        return null;
    }
    if (failures.parallel >= total * 0.8 && runs.sequential >= 20) {
        const parallelRate = runs.parallel > 0 ? (failures.parallel / runs.parallel) * 100 : 0;
        const sequentialRate =
            runs.sequential > 0 ? (failures.sequential / runs.sequential) * 100 : 0;
        return (
            `Fails almost only in parallel: ${failures.parallel} of ${total} mode-recorded ` +
            `failures, ${percent(parallelRate)} of parallel runs against ` +
            `${percent(sequentialRate)} of sequential ones (--executions for the breakdown).`
        );
    }
    if (failures.sequential >= total * 0.8 && runs.parallel >= 20) {
        return (
            `Fails almost only in sequential execution: ${failures.sequential} of ${total} ` +
            `mode-recorded failures (--executions for the breakdown).`
        );
    }
    return null;
}

/** A note when failures were reruns within the same job. */
function rerunNoteOf(entries: readonly RunEntry[]): string | null {
    const failing = entries.filter((entry) => {
        const { kind } = classifyStatus(entry.status);
        return kind === 'fail' || kind === 'timeout' || kind === 'crash';
    });
    const reruns = countRerunsByTask(failing);
    if (reruns.jobsWithRerun === 0 || reruns.jobs === 0) {
        return null;
    }
    return (
        `${reruns.jobsWithRerun} of ${reruns.jobs} failing jobs saw the failure more than ` +
        `once, which within a job is a harness rerun (--executions for the breakdown).`
    );
}

/** The `--coverage` matrix. */
function buildCoverage(coverage: TestCoverage): CoverageJson {
    const platforms = platformsCovered(coverage);
    return {
        attributedPasses: coverage.attributedPasses,
        configs: coverage.configs.map((config) => ({
            jobName: config.jobName,
            state: config.state,
            runCount: config.runCount,
            passCount: config.passCount,
            failCount: config.failCount + config.timeoutCount + config.crashCount,
            skipCount: config.skipCount,
            skipMessages: [...config.skipMessages].map(([message, count]) => ({
                message,
                count,
            })),
        })),
        platforms: [...platforms].map(([platform, configCount]) => ({
            platform,
            configCount,
        })),
        scheduledPlatforms: coveragePlatforms(coverage),
    };
}

/**
 * Where the test runs at all — `CLI.md`'s "Runs on N configs across ..." line.
 *
 * In the **default** view, because the failing-config table above it cannot
 * answer "is this test running on Android at all?", and that question has to
 * be settled before concluding a platform is unaffected. `CLI.md` puts the
 * line directly under the verdict for that reason.
 *
 * `null` where passing runs are not attributed to a config: there the only
 * configs visible are the ones that failed, and calling that "where it runs"
 * would be precisely the wrong answer.
 *
 * The `absentPlatforms` list is a set difference against the platforms the
 * *file* knows about, not a hardcoded list — a new platform appearing in CI
 * should show up here without a code change.
 */
function buildReach(
    file: DecodedTimingFile,
    coverage: TestCoverage
): TestJson['reach'] {
    if (!coverage.attributedPasses) {
        return null;
    }
    const platforms = platformsCovered(coverage);
    const ranOn = coverage.configs.filter((config) => config.runCount > 0);

    // Every platform any test in this file runs on, so "not android" is a
    // measured absence rather than an assumption about what CI has.
    const absentPlatforms = [...platformsInFileCache(file)]
        .filter((platform) => !platforms.has(platform))
        .sort();

    return {
        configCount: ranOn.length,
        platforms: [...platforms].map(([platform, configCount]) => ({
            platform,
            configCount,
        })),
        absentPlatforms,
    };
}

/** One printable row of the `Bugs naming this test` block. */
type AnnotatedBugRow = {
    bugId: number;
    count: number;
    bugSummary: string;
    days: number;
    tree: string;
};

/**
 * The bug rows to print, or `[]` for each of the two states that have none.
 *
 * Both renderers ask the same question — "is there a block to draw" — so the
 * narrowing lives here rather than twice. Neither the absent field nor the
 * failed `{ error }` prints anything: the warning on stderr already said what
 * happened, and a "could not look" line in the middle of the answer would read
 * as a property of the test.
 */
function annotatedBugRows(annotatedBugs: TestJson['annotatedBugs']): AnnotatedBugRow[] {
    return annotatedBugs === undefined || 'error' in annotatedBugs ? [] : annotatedBugs;
}

/** The tree the bug lookup asks about, matching `intermittent`'s own default. */
const ANNOTATED_BUGS_TREE = 'trunk';

/**
 * The bugs naming this test, from `intermittent`'s ranking. `--bugs` only.
 *
 * ## Why this is the one part of `test` behind a flag
 *
 * Everything else this command prints comes from one published aggregate, and
 * this does not: the sheriff annotations live behind Treeherder's
 * `/api/failures/` and Bugzilla, which is why they were only ever reachable
 * from `intermittent`.
 *
 * A first version resolved them on the default path, on the argument that a bug
 * number behind a flag nobody passes is no answer at all. That was reversed in
 * review, and the reason is not the latency — ~8.5s cold and ~0.3s warm against
 * a 0.5s command, which a cache TTL mostly absorbs. It is the **load on the
 * machines serving the API**: `test` is run constantly, and making every
 * invocation of it fetch the tree-wide ranking is upstream traffic those
 * machines did not previously carry. A local cache cannot give that back,
 * because the cost is per user rather than per invocation.
 *
 * So the default path issues no intermittents request at all, and `--bugs` is
 * the opt-in. `test/cli.test.ts` pins that with a client that throws on every
 * method, which is the only way to assert an absence of requests rather than
 * assume it.
 *
 * ## Why a failure is not this command's failure
 *
 * A live API is down in a way a published file is not, and a `test` invocation
 * that exits 3 because Bugzilla is slow would have lost an answer it already
 * had. So the lookup warns and yields `{ error }` — distinct from the *absent*
 * field that means nobody asked, because "no bugs" and "could not look" are
 * answers a consumer has to branch on differently.
 *
 * The return type is deliberately not `TestJson['annotatedBugs']`: that is
 * optional, and this function is only ever called when `--bugs` was passed, so
 * it always has something to say. Only the caller may leave the key off.
 */
async function fetchAnnotatedBugs(
    context: CommandContext,
    path: string
): Promise<AnnotatedBugRow[] | { error: string }> {
    const client = context.intermittents;
    if (client === undefined) {
        return { error: 'no intermittents client is configured' };
    }
    const range = resolveRange(undefined, undefined);
    const tree = ANNOTATED_BUGS_TREE;
    try {
        // The fetching that `intermittent --test` also does. It stays here
        // rather than in `lib/`, because progress reporting and exit-code
        // mapping are CLI concerns: `lib/` holds the pure part, which is the
        // ranking scan and the path filter below. Same three inputs, same
        // order, so both commands resolve a path through one code path.
        progress(context, `Ranking annotated bugs on ${tree} for ${range.start}..${range.end}…`);
        const ranking = await withUpstreamErrors(() => client.rankBugs(tree, range), tree);
        const candidates = ranking
            .filter((row) => row.bugId !== null)
            .map((row) => row.bugId as number);
        if (candidates.length === 0) {
            // No bug to read a summary from, so there is nothing to classify —
            // and skipping here avoids the two issues files `loadHarnessOfPath`
            // would otherwise fetch to classify an empty list.
            return [];
        }
        progress(context, `Reading ${candidates.length} bug summaries…`);
        const summaries = await withUpstreamErrors(() => client.bugSummaries(candidates), tree);
        progress(context, 'Reading the mochitest and xpcshell test lists…');
        const harnessOfPath = await loadHarnessOfPath(context.source);

        const matches = bugsNamingTest(
            scanBugs({ ranking, summaries, harnessOfPath }).rows,
            path
        );
        return matches.map((row) => ({
            bugId: row.bugId,
            count: row.count,
            // `failure`, not `bugSummary`, and deliberately — this is A's rule
            // on the `RankedIntermittent` docstring applied to this block:
            // `failure` where the surrounding output already names the test,
            // `bugSummary` standalone. Here the path is established context
            // three times over (the caller typed it, the header prints it, and
            // the heading is "Bugs naming this test"), so the raw summary would
            // spend its width re-printing it. Measured: truncated to the
            // terminal, a raw summary is cut *inside* the path on both rows of
            // a live two-bug test, losing the description entirely.
            //
            // The cost is the triage prefix — `Perma` on bug 2061951 is real
            // information — and an empty `|  |` where the path was cut out, on
            // 7 of 300 live classified rows. Composing prefix + `failure` would
            // fix both but needs a second copy of `TRIAGE_PREFIX` here, and a
            // fourth spelling of one summary is what that docstring exists to
            // prevent. If a prefix-keeping, path-stripping variant is ever
            // wanted, it belongs in `lib/` beside `summaryRemainder`.
            bugSummary: row.failure,
            days: INTERMITTENT_DEFAULT_DAYS,
            tree,
        }));
    } catch (error) {
        const message = (error as Error).message;
        warn(
            context,
            `could not read the sheriff annotations naming this test ` +
                `(${message}); the bug list is omitted`
        );
        return { error: message };
    }
}

/**
 * `platformsInFile()` memoized per file.
 *
 * It scans every test in the file, which for a bucket file is the one O(file)
 * step in a `test` run. Memoized because a single run can build `reach` more
 * than once — `--json` and the text renderer both go through it.
 */
const platformCache = new WeakMap<DecodedTimingFile, Set<string>>();
function platformsInFileCache(file: DecodedTimingFile): Set<string> {
    let platforms = platformCache.get(file);
    if (platforms === undefined) {
        platforms = platformsInFile(file);
        platformCache.set(file, platforms);
    }
    return platforms;
}

/**
 * The `--executions` breakdown.
 *
 * Two partitions of the *same* failures, and the reason they are reported as
 * two blocks rather than one table: initial-vs-rerun and
 * parallel-vs-sequential are **not additive**. `CLI.md` says so explicitly and
 * the layout follows.
 *
 * `modeAxis` is `null` for mochitest, where the suffixes do not exist at all
 * (`FORMATS.md`). Reporting zeros there would be a misleading table with one
 * row; the renderer says the axis is absent instead.
 */
function buildExecutions(
    file: DecodedTimingFile,
    entries: readonly RunEntry[]
): ExecutionsJson {
    const failing = entries.filter((entry) => {
        const { kind } = classifyStatus(entry.status);
        return kind === 'fail' || kind === 'timeout' || kind === 'crash';
    });
    const reruns = countRerunsByTask(failing);

    if (!hasModeAxis(file.statuses)) {
        return {
            modeAxis: null,
            reruns: { jobs: reruns.jobs, runs: reruns.runs, jobsWithRerun: reruns.jobsWithRerun },
        };
    }

    const failures = emptyModeBreakdown();
    const runs = emptyModeBreakdown();
    for (const entry of entries) {
        const { kind } = classifyStatus(entry.status);
        if (kind === 'skip' || kind === 'unknown') {
            continue;
        }
        addToModeBreakdown(runs, entry.status, entry.count);
        if (kind === 'fail' || kind === 'timeout' || kind === 'crash') {
            addToModeBreakdown(failures, entry.status, entry.count);
        }
    }
    const rateOf = (fails: number, total: number): number | null =>
        total > 0 ? (fails / total) * 100 : null;

    return {
        modeAxis: {
            failures,
            runs,
            failRate: {
                parallel: rateOf(failures.parallel, runs.parallel),
                sequential: rateOf(failures.sequential, runs.sequential),
                unrecorded: rateOf(failures.unrecorded, runs.unrecorded),
            },
        },
        reruns: { jobs: reruns.jobs, runs: reruns.runs, jobsWithRerun: reruns.jobsWithRerun },
    };
}

/** Per-config duration distribution, from the pass durations. */
function buildDurations(
    file: DecodedTimingFile,
    entries: readonly RunEntry[]
): DurationsJson[] {
    const byJob = new Map<string, number[]>();
    for (const entry of entries) {
        if (entry.durations === undefined || entry.durations.length === 0) {
            continue;
        }
        const jobName = jobNameOf(file, entry);
        if (jobName === null) {
            continue;
        }
        const list = byJob.get(jobName) ?? [];
        list.push(...entry.durations);
        byJob.set(jobName, list);
    }
    const rows: DurationsJson[] = [];
    for (const [jobName, durations] of byJob) {
        durations.sort((a, b) => a - b);
        rows.push({
            jobName,
            runCount: durations.length,
            min: durations[0]!,
            median: quantile(durations, 0.5),
            p95: quantile(durations, 0.95),
            max: durations[durations.length - 1]!,
        });
    }
    return rows.sort((a, b) => b.median - a.median || a.jobName.localeCompare(b.jobName));
}

/** The nearest-rank quantile of a sorted array. */
function quantile(sorted: readonly number[], q: number): number {
    if (sorted.length === 0) {
        throw new Error('quantile of an empty array');
    }
    const rank = Math.ceil(q * sorted.length);
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

/** Per-day pass/fail counts, for `--history`. */
function buildHistory(
    file: DecodedTimingFile,
    entries: readonly RunEntry[],
    window: DayWindow
): HistoryJson[] {
    const days = file.days;
    if (days === null) {
        return [];
    }
    const from = window.range?.from ?? 0;
    const to = window.range?.to ?? days - 1;
    const rows = new Map<number, HistoryJson>();
    for (let day = from; day <= to; day++) {
        rows.set(day, {
            date: dateOfDayIndex(file.endDate, days, day),
            pass: 0,
            fail: 0,
            timeout: 0,
            crash: 0,
            skip: 0,
        });
    }
    for (const entry of entries) {
        if (entry.day === null) {
            continue;
        }
        const row = rows.get(entry.day);
        if (row === undefined) {
            continue;
        }
        const { kind } = classifyStatus(entry.status);
        switch (kind) {
            case 'pass':
            case 'expected-fail':
                row.pass += entry.count;
                break;
            case 'fail':
                row.fail += entry.count;
                break;
            case 'timeout':
                row.timeout += entry.count;
                break;
            case 'crash':
                row.crash += entry.count;
                break;
            case 'skip':
                row.skip += entry.count;
                break;
            case 'unknown':
                break;
        }
    }
    return [...rows.values()];
}

/**
 * Whether every day's failure count sits within an order of magnitude of the
 * window's median.
 *
 * The question the default view cannot answer: `fx-tests test` shows one number
 * per configuration over three weeks, so a failure that started last Tuesday
 * and one that has been there since the window opened read identically. This is
 * the cheapest signal that separates them, and its only job is to decide
 * whether to point at `--history`.
 *
 * ## What the median is taken over
 *
 * **Every day in the window, zero-run days included.** The alternative —
 * median over days the test ran — was rejected because the days it did not run
 * are the interesting ones: a test disabled a week ago, or one that only landed
 * on Friday, has a real discontinuity, and dropping those days from the median
 * hides exactly the shape the line exists to advertise. It does mean a test
 * that runs on weekdays only reads as not flat, which is correct: the weekend
 * dip is a real feature of the counts and `--history` is where it is legible.
 *
 * ## Where the threshold sits
 *
 * "More than an order of magnitude from the median" is `count > median * 10` or
 * `count * 10 < median`. A median of zero — a test that fails on a handful of
 * days and not at all on the rest — makes the second test vacuous and the first
 * true for any failure at all, so it is treated as not flat: a window that is
 * mostly zeros with a spike in it *is* the non-flat case.
 *
 * `null` where the question does not arise: no day axis, one day, or no
 * failures anywhere in the window.
 */
function dailyCountsAreFlat(history: readonly HistoryJson[]): boolean | null {
    if (history.length < 2) {
        return null;
    }
    const counts = history.map((row) => row.fail + row.timeout + row.crash);
    if (counts.every((count) => count === 0)) {
        return null;
    }
    const sorted = [...counts].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median =
        sorted.length % 2 === 1
            ? sorted[mid]!
            : (sorted[mid - 1]! + sorted[mid]!) / 2;
    if (median === 0) {
        return false;
    }
    return counts.every((count) => count <= median * 10 && count * 10 >= median);
}

/**
 * The task IDs behind each failure, for `--task-ids`.
 *
 * Also the **minidump IDs**, which is what makes `fx-tests crash` reachable
 * from here. `CRASH` groups in a bucket file carry a `minidumps` array parallel
 * to `taskIdIds` (`FORMATS.md`), and `status-entries.ts` already decodes it —
 * but nothing read it, so the hint pointing a caller here for a dump ID was
 * false as shipped. A dump ID is useless without the task that produced it and
 * vice versa, so emitting the two together is the whole point.
 *
 * A `null` entry is a crash whose dump was **never uploaded** — 58 of them in
 * the sweep, always the same entries whose signature is also null. Those get no
 * `minidumpId`, rather than a placeholder that would look fetchable.
 */
function buildTaskIds(
    // Optional, because only the bucket files carry `taskInfo.chunks` at all
    // (`FORMATS.md`: it is absent from every daily, issues-with-taskids and
    // errors file). A missing chunk is reported as `null` rather than guessed.
    raw: { taskInfo?: { chunks?: (number | null)[] | undefined } | undefined },
    file: DecodedTimingFile,
    entries: readonly RunEntry[],
    window: DayWindow
): TaskIdJson[] {
    const rows: TaskIdJson[] = [];
    const days = file.days;
    for (const entry of entries) {
        const { kind } = classifyStatus(entry.status);
        if (kind !== 'fail' && kind !== 'timeout' && kind !== 'crash') {
            continue;
        }
        if (entry.taskIds === undefined) {
            continue;
        }
        entry.taskIds.forEach((raw2, i) => {
            const { taskId, retryId } = parseTaskId(raw2);
            const taskIdIndex = entry.taskIdIndexes?.[i];
            const row: TaskIdJson = {
                taskId,
                retryId,
                jobName:
                    taskIdIndex === undefined ? null : file.jobNameOfTaskIndex(taskIdIndex),
                chunk:
                    taskIdIndex === undefined || raw.taskInfo === undefined
                        ? null
                        : chunkOfTask(raw as never, taskIdIndex),
                status: entry.status,
                day:
                    entry.day === null || days === null
                        ? null
                        : dateOfDayIndex(file.endDate, days, entry.day),
                message: entry.message ?? null,
            };
            // `minidumps[i]` belongs to `taskIds[i]`: same bucket, same order,
            // which is the join `crashes.ts` relies on too. Falsy means the
            // dump was never uploaded, so there is nothing to fetch and the
            // field is omitted rather than set to null.
            const minidumpId = entry.minidumps?.[i];
            if (minidumpId) {
                row.minidumpId = minidumpId;
                row.crashCommand = `fx-tests crash ${taskId}.${retryId} ${minidumpId}`;
            }
            rows.push(row);
        });
    }
    void window;
    return rows;
}

/**
 * Raw profile URLs, for `--profiles`.
 *
 * **Raw artifact URLs, not `profiler.firefox.com/from-url/…`.** `CLI.md` is
 * explicit: the consumer is `profiler-cli`, which downloads and queries the
 * profile itself, and a front-end URL is useless to it. `lib/links.ts` keeps
 * the two apart and this uses the raw side.
 *
 * Two kinds with different availability. The resource-usage profile is
 * derivable from the task ID and is always emitted. The per-test failure
 * profile's filename appears only in the failure message, so it is emitted
 * only when the message names one — **no guessing**, per `CLI.md`.
 */
function buildProfiles(
    file: DecodedTimingFile,
    entries: readonly RunEntry[]
): ProfileJson[] {
    const rows: ProfileJson[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
        const { kind } = classifyStatus(entry.status);
        if (kind !== 'fail' && kind !== 'timeout' && kind !== 'crash') {
            continue;
        }
        if (entry.taskIds === undefined) {
            continue;
        }
        entry.taskIds.forEach((rawTaskId, i) => {
            const { taskId, retryId } = parseTaskId(rawTaskId);
            const key = `${taskId}.${retryId}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            const taskIdIndex = entry.taskIdIndexes?.[i];
            const row: ProfileJson = {
                taskId,
                retryId,
                jobName:
                    taskIdIndex === undefined ? null : file.jobNameOfTaskIndex(taskIdIndex),
                resourceUsage: resourceUsageProfileUrl(taskId, retryId),
            };
            const testProfile = uploadedProfileUrl(taskId, retryId, entry.message);
            if (testProfile !== null) {
                row.testProfile = testProfile;
            }
            rows.push(row);
        });
    }
    return rows;
}

// --- rendering -----------------------------------------------------------

/** Plain text, as `CLI.md` lays it out. */
function renderText(result: TestJson, limit: number): string {
    const lines: (string | null)[] = [];
    const { metadata, totals } = result;

    lines.push(`${result.test} — ${dirOf(result.path)}`);
    if (result.component !== null) {
        lines.push(`Component: ${result.component}`);
    }
    lines.push(
        `Data: ${result.harness}, ${describeWindow(metadata)}, ` +
            `generated ${metadata.generatedAt}`
    );
    const filterLine = describeConfigFilter(result.configFilter);
    if (filterLine !== null) {
        lines.push(filterLine);
    }
    lines.push('');
    lines.push(
        `  ${fmtCount(totals.runCount)} runs   ` +
            `${fmtCount(totals.passCount)} pass (${percent(totals.passRate, 2)})   ` +
            `${fmtCount(totals.failCount)} fail   ` +
            `${fmtCount(totals.timeoutCount)} timeout   ` +
            `${fmtCount(totals.crashCount)} crash   ` +
            `${fmtCount(totals.skipCount)} skip`
    );
    if (totals.expectedFailCount > 0) {
        lines.push(`  ${fmtCount(totals.expectedFailCount)} expected failures`);
    }
    if (totals.unknownCount > 0) {
        // Never silently folded into pass or fail: a job that reported no
        // outcome did not pass. `FORMATS.md` measured zero of these in 21
        // days, so seeing this line means the generator emitted something new.
        lines.push(
            `  ${fmtCount(totals.unknownCount)} runs of an unrecognized status ` +
                `(not counted as pass or fail)`
        );
    }
    lines.push('');
    lines.push(`Verdict: ${result.verdict.summary}`);
    for (const note of result.verdict.notes) {
        lines.push(`  ${note}`);
    }

    if (result.dailyCountsAreFlat === false) {
        lines.push('  Daily counts are not flat; --history shows the per-day breakdown.');
    }

    const reachLine = describeReach(result.reach);
    if (reachLine !== null) {
        lines.push('');
        lines.push(reachLine);
    }

    const bugRows = annotatedBugRows(result.annotatedBugs);
    if (bugRows.length > 0) {
        lines.push('');
        lines.push('Bugs naming this test');
        for (const bug of bugRows) {
            lines.push(
                `  ${String(bug.bugId).padStart(7)}  ` +
                    `${fmtCount(bug.count).padStart(4)} annotations, last ${bug.days} days   ` +
                    `fx-tests intermittent --bug ${bug.bugId}`
            );
            // The summary gets its own line rather than a fourth column: the
            // row above is already ~70 characters, and these run to 182 in a
            // live ranking, so inline it would wrap into a mess whatever the
            // budget. Truncated rather than wrapped, unlike `intermittent
            // --bug`'s headline — there the summary *is* the content, here it
            // is one row among several and a reader is scanning bug numbers.
            // `truncate` scales the budget to the real terminal.
            lines.push(`           ${truncate(bug.bugSummary, SUMMARY_WIDTH)}`);
        }
    }

    if (result.configs.length > 0) {
        lines.push('');
        const shown = applyLimit(result.configs, limit);
        const header = result.recentWindow === null
            ? 'Failing configurations'
            : `Failing configurations (recent = last ${result.recentWindow.days}d, ` +
              `sized so the sparsest config has ${result.recentWindow.minRuns}+ runs)`;
        lines.push(header);
        lines.push(
            ...table(
                [
                    { header: 'Configuration' },
                    { header: 'fail rate', align: 'right' },
                    { header: 'fails', align: 'right' },
                    { header: 'recent', align: 'right' },
                    { header: 'runs', align: 'right' },
                ],
                shown.map((config) => [
                    config.jobName,
                    percent(config.failRate),
                    String(config.failCount),
                    // `null` prints as `—`, not `0.0%`: "too few runs to say"
                    // and "no failures" are different claims and the column
                    // must not conflate them.
                    percent(config.recentFailRate),
                    String(config.runCount),
                ])
            )
        );
        lines.push(moreLine(result.configs.length, shown.length));
    } else if (totals.failCount + totals.timeoutCount + totals.crashCount > 0) {
        lines.push('');
        // `computeConfigStats` returns [] both when no config failed and when
        // the file cannot attribute runs to configs at all. Those are
        // different answers and `canAttributeConfigs()` is what tells them
        // apart — printing "no failing configurations" for a file that simply
        // cannot say would be the confidently-wrong number this project keeps
        // producing.
        lines.push(
            result.canAttributeConfigs
                ? '  (no failing configuration in this window, though the totals show failures —'
                : '  (this file does not attribute runs to configurations, so the failing-config'
        );
        lines.push(
            result.canAttributeConfigs
                ? '   the failures could not be attributed to a job)'
                : '   table cannot be built from it)'
        );
    }

    // Replaces the `Failure messages`, `Crash signatures` and `Skips` sections.
    if (result.issues.length > 0) {
        lines.push('');
        lines.push('Issues');
        const shown = applyLimit(result.issues, limit);
        for (const entry of shown) {
            lines.push(
                `  ${String(entry.count).padStart(5)}x  ${entry.type.padEnd(7)} ` +
                    `${truncate(oneLine(entry.message), 92)}`
            );
        }
        lines.push(moreLine(result.issues.length, shown.length));
    } else if (result.configFilter !== null) {
        lines.push('');
        lines.push('Issues');
        lines.push(`  ${emptyIssuesUnderFilter()}`);
    }

    if (result.coverage !== undefined) {
        lines.push('');
        lines.push(...renderCoverageText(result.coverage, limit));
    }
    if (result.executions !== undefined) {
        lines.push('');
        lines.push(...renderExecutionsText(result.executions));
    }
    if (result.durations !== undefined) {
        lines.push('');
        lines.push('Durations (ms, from passing runs)');
        const shown = applyLimit(result.durations, limit);
        lines.push(
            ...table(
                [
                    { header: 'Configuration' },
                    { header: 'runs', align: 'right' },
                    { header: 'min', align: 'right' },
                    { header: 'median', align: 'right' },
                    { header: 'p95', align: 'right' },
                    { header: 'max', align: 'right' },
                ],
                shown.map((row) => [
                    row.jobName,
                    String(row.runCount),
                    String(Math.round(row.min)),
                    String(Math.round(row.median)),
                    String(Math.round(row.p95)),
                    String(Math.round(row.max)),
                ])
            )
        );
        lines.push(moreLine(result.durations.length, shown.length));
    }
    if (result.history !== undefined) {
        lines.push('');
        lines.push('History (pass/fail per day)');
        for (const row of result.history) {
            const bar = row.fail + row.timeout + row.crash > 0 ? '!' : '·';
            lines.push(
                `  ${dateWithWeekday(row.date)}  ${bar}  ` +
                    `${String(row.pass).padStart(5)} pass  ` +
                    `${String(row.fail).padStart(4)} fail  ` +
                    `${String(row.timeout).padStart(3)} timeout  ` +
                    `${String(row.crash).padStart(3)} crash  ` +
                    `${String(row.skip).padStart(5)} skip`
            );
        }
    }
    if (result.taskIds !== undefined) {
        lines.push('');
        lines.push('Task IDs');
        const shown = applyLimit(result.taskIds, limit);
        for (const row of shown) {
            lines.push(
                `  ${row.taskId}.${row.retryId}  ${row.status.padEnd(18)} ` +
                    `${row.day ?? '—'}  ${row.jobName ?? '(unknown job)'}` +
                    (row.chunk === null ? '' : ` chunk ${row.chunk}`)
            );
            // The command rather than the bare ID: a dump ID is only usable
            // paired with its task, and pasting is the point.
            if (row.crashCommand !== undefined) {
                lines.push(`    ${row.crashCommand}`);
            }
        }
        lines.push(moreLine(result.taskIds.length, shown.length));
        const crashRows = shown.filter((row) => row.status.startsWith('CRASH'));
        if (crashRows.length > 0 && crashRows.every((row) => row.minidumpId === undefined)) {
            // A crash with no dump is real — the dump was never uploaded — and
            // saying so beats leaving a caller to wonder whether the command
            // forgot to look.
            lines.push(
                '  (no minidump was uploaded for these crashes, so there is nothing to read)'
            );
        }
    }
    if (result.profiles !== undefined) {
        lines.push('');
        lines.push('Profiles (raw artifact URLs, for profiler-cli)');
        const shown = applyLimit(result.profiles, limit);
        for (const row of shown) {
            lines.push(`  ${row.taskId}.${row.retryId}  ${row.jobName ?? '(unknown job)'}`);
            lines.push(`    resource-usage: ${row.resourceUsage}`);
            if (row.testProfile !== undefined) {
                lines.push(`    test profile:   ${row.testProfile}`);
            }
        }
        lines.push(moreLine(result.profiles.length, shown.length));
        if (shown.every((row) => row.testProfile === undefined)) {
            // Only prints when nothing was extracted, so the tests that do
            // carry a name never show it; `test/cli.test.ts` pins that case.
            //
            // It used to name `fx-tests try <rev> --profiles`, which needs a
            // try revision this command has not got and the reader usually has
            // not either — every report of this was a trunk intermittent, and
            // the advice sent people to the Taskcluster queue API by hand.
            // `intermittent --test` needs nothing but the path, and it resolves
            // the bug itself.
            //
            // The path is printed literally rather than reconstructed from the
            // test name, so the line can be pasted. Note that this is a pointer
            // and not a fallback: `test` still cannot serve these URLs itself,
            // because the published aggregate keeps one message per failing run
            // and the profile notice is never the one it keeps
            // (`lib/model/marker-messages.ts`).
            lines.push(
                '  (these are resource-usage profiles; per-test profiles: ' +
                    `fx-tests intermittent --test ${result.path} --profiles)`
            );
        }
    }

    return joinLines(lines);
}

/** The coverage table. */
function renderCoverageText(coverage: CoverageJson, limit: number): string[] {
    const lines: (string | null)[] = [];
    if (!coverage.attributedPasses) {
        // The refusal `CLI.md` asks for: `computeConfigStats` returns [] on
        // `issues.json` and that is not "no configs failed".
        return [
            'Coverage is not available from this file: it does not attribute passing runs',
            'to a configuration, so the table would show only the failing configs.',
        ];
    }
    lines.push('Coverage');
    const shown = applyLimit(coverage.configs, limit);
    lines.push(
        ...table(
            [
                { header: 'Configuration' },
                { header: 'runs', align: 'right' },
                { header: 'pass', align: 'right' },
                { header: 'fail', align: 'right' },
                { header: 'skip', align: 'right' },
                { header: 'status' },
            ],
            shown.map((config) => [
                config.jobName,
                String(config.runCount),
                String(config.passCount),
                String(config.failCount),
                String(config.skipCount),
                coverageStatusLabel(config),
            ])
        )
    );
    lines.push(moreLine(coverage.configs.length, shown.length));
    for (const config of shown) {
        for (const skip of config.skipMessages) {
            lines.push(`      ${config.jobName}: ${truncate(oneLine(skip.message), 80)}`);
        }
    }
    if (coverage.platforms.length > 0) {
        lines.push('');
        lines.push(
            `${coverage.configs.length} configs, ${coverage.platforms.length} platforms: ` +
                coverage.platforms
                    .map((entry) => `${entry.platform} (${entry.configCount})`)
                    .join(', ')
        );
    }
    // The states CLI.md says this flag exists to distinguish, counted. Without
    // this a reader has to scan the status column and total it by eye, and the
    // skipped rows are the ones easiest to miss because they often sit below
    // the limit.
    const ran = coverage.configs.filter((config) => config.runCount > 0).length;
    const skippedOnly = coverage.configs.filter(
        (config) => config.runCount === 0 && config.skipCount > 0
    ).length;
    const notApplicable = coverage.configs.filter(
        (config) => config.state === 'not-applicable'
    ).length;
    const alsoSkipped = coverage.configs.filter(
        (config) => config.runCount > 0 && config.skipCount > 0
    ).length;
    const summary = [
        `${ran} ran`,
        skippedOnly > 0 ? `${skippedOnly} only ever skipped` : null,
        notApplicable > 0 ? `${notApplicable} not applicable (run-if)` : null,
    ].filter((part): part is string => part !== null);
    lines.push(`States: ${summary.join(', ')}`);
    if (alsoSkipped > 0) {
        // The case that produced a wrong reading: these configs ran the test
        // on some days and skipped it on others, so their state is `ok` and
        // their skip column is large. Both are true, and stating it is what
        // stops "ok" being read as "never skipped here".
        lines.push(
            `${alsoSkipped} of the ${ran} configs that ran it also skipped it on other days ` +
                `— see the skip column.`
        );
    }
    lines.push(...renderScheduledPlatforms(coverage));
    return lines.filter((line): line is string => line !== null);
}

/**
 * One row per platform the test is scheduled on — and no row for anything else.
 *
 * This block used to also enumerate configs the test was *not* scheduled on,
 * subtracted from a universe of every config in the bucket file. That produced
 * 453 rows for a browser-chrome test, all of them Android media variants it
 * could never have run under. Scoping the universe to the test's own suites cut
 * it to 3, but kept the concept, and the concept is what was wrong: there is no
 * boundary at which "things this test does not run on" stops. Widen it and iOS
 * belongs on the list.
 *
 * So what is printed is what the data records, and **absence is the report**. A
 * reader who wants to know whether the test runs on Android looks for an
 * `android` row; not finding one is the answer. That is exactly how
 * `test.html`'s `calculateJobNameBreakdown()` has always worked — it iterates
 * the test's own status groups and has no universe.
 *
 * `ran/total` is still the shape, because it separates "scheduled on 20 Android
 * configs and disabled on all of them" (`0/20`) from "runs fine on Android"
 * (`20/20`), and only the first is somebody's work to fix.
 */
function renderScheduledPlatforms(coverage: CoverageJson): string[] {
    if (coverage.scheduledPlatforms.length === 0) {
        return [];
    }
    const lines: string[] = ['', 'Scheduled on:'];
    for (const entry of coverage.scheduledPlatforms) {
        const total = entry.ranCount + entry.skippedCount;
        const verdict =
            entry.ranCount === 0
                ? ' — scheduled here, but skipped on every config'
                : entry.skippedCount > 0
                  ? ` — ${entry.skippedCount} scheduled but skipped`
                  : '';
        lines.push(`  ${entry.platform.padEnd(8)} ${entry.ranCount}/${total} ran${verdict}`);
    }
    return lines;
}

/**
 * The status cell for a coverage row.
 *
 * The library's `CoverageState` answers "what happened when it ran", and a
 * config that ran on some days and was skipped on others is legitimately
 * `ok` — it ran, and it passed. But printing a bare `ok` next to a skip
 * column reading 191 invites exactly the wrong conclusion, and a reader
 * drawing a wrong conclusion from correct data is this project's recurring
 * failure mode.
 *
 * So the cell is annotated rather than the state being changed: `ok +skipped`
 * says both facts, and the underlying state stays what `--json` reports.
 */
function coverageStatusLabel(config: CoverageJson['configs'][number]): string {
    if (config.runCount > 0 && config.skipCount > 0) {
        return `${config.state} +skipped`;
    }
    return config.state;
}

/** The `--executions` blocks. */
function renderExecutionsText(executions: ExecutionsJson): string[] {
    const lines: string[] = ['Executions'];
    const { reruns } = executions;

    if (reruns.jobs === 0) {
        lines.push('  No failing runs with task attribution, so no rerun analysis.');
    } else {
        lines.push(
            `  ${reruns.runs} failing runs across ${reruns.jobs} jobs; ` +
                `${reruns.jobsWithRerun} of those jobs saw the failure more than once.`
        );
        lines.push(
            '  A repeat within one job is a harness rerun. The aggregates record no order,'
        );
        lines.push(
            '  so this counts repetition rather than labelling a run initial or rerun.'
        );
    }

    lines.push('');
    if (executions.modeAxis === null) {
        // Saying so rather than printing a one-row table, exactly as
        // `FORMATS.md` asks: mochitest has no mode axis at all.
        lines.push('  By execution mode: not recorded for this harness.');
        lines.push(
            '  The -PARALLEL/-SEQUENTIAL status suffixes are xpcshell-only, so there is'
        );
        lines.push('  no parallel-vs-sequential split to report here.');
        return lines;
    }

    const { failures, runs, failRate } = executions.modeAxis;
    lines.push('  By execution mode');
    lines.push(
        ...table(
            [
                { header: 'mode' },
                { header: 'failures', align: 'right' },
                { header: 'runs', align: 'right' },
                { header: 'rate', align: 'right' },
            ],
            [
                ['parallel', String(failures.parallel), String(runs.parallel), percent(failRate.parallel)],
                [
                    'sequential',
                    String(failures.sequential),
                    String(runs.sequential),
                    percent(failRate.sequential),
                ],
                [
                    'not recorded',
                    String(failures.unrecorded),
                    String(runs.unrecorded),
                    percent(failRate.unrecorded),
                ],
            ],
            '    '
        )
    );
    lines.push(
        '    "not recorded" is its own bucket, not the sum of the other two: plain PASS'
    );
    lines.push('    coexists with PASS-PARALLEL and PASS-SEQUENTIAL in the same file.');
    lines.push('');
    lines.push(
        '  The two blocks partition the same failures two ways; they are not additive.'
    );
    return lines;
}

/** Markdown, for pasting into a bug. */
function renderMarkdown(result: TestJson, limit: number): string {
    const lines: (string | null)[] = [];
    const { metadata, totals } = result;
    lines.push(md.heading(`${result.test}`, 1));
    lines.push('');
    lines.push(`${md.code(result.path)}`);
    if (result.component !== null) {
        lines.push('');
        lines.push(`**Component:** ${result.component}`);
    }
    lines.push('');
    lines.push(
        `**Data:** ${result.harness}, ${describeWindow(metadata)}, generated ${metadata.generatedAt}`
    );
    const filterLine = describeConfigFilter(result.configFilter);
    if (filterLine !== null) {
        lines.push('');
        lines.push(`**${filterLine}**`);
    }
    lines.push('');
    lines.push(
        ...md.table(
            [
                { header: 'runs', align: 'right' },
                { header: 'pass', align: 'right' },
                { header: 'fail', align: 'right' },
                { header: 'timeout', align: 'right' },
                { header: 'crash', align: 'right' },
                { header: 'skip', align: 'right' },
            ],
            [
                [
                    fmtCount(totals.runCount),
                    `${fmtCount(totals.passCount)} (${percent(totals.passRate, 2)})`,
                    fmtCount(totals.failCount),
                    fmtCount(totals.timeoutCount),
                    fmtCount(totals.crashCount),
                    fmtCount(totals.skipCount),
                ],
            ]
        )
    );
    lines.push('');
    lines.push(`**Verdict:** ${result.verdict.summary}`);
    for (const note of result.verdict.notes) {
        lines.push('');
        lines.push(note);
    }
    if (result.dailyCountsAreFlat === false) {
        lines.push('');
        lines.push('Daily counts are not flat; `--history` shows the per-day breakdown.');
    }
    const reachLine = describeReach(result.reach);
    if (reachLine !== null) {
        lines.push('');
        lines.push(reachLine);
    }

    const bugRows = annotatedBugRows(result.annotatedBugs);
    if (bugRows.length > 0) {
        lines.push('');
        lines.push(md.heading('Bugs naming this test'));
        lines.push('');
        lines.push(
            ...md.table(
                [
                    { header: 'bug' },
                    { header: 'summary' },
                    { header: 'annotations', align: 'right' },
                    { header: 'window' },
                    { header: 'drill down' },
                ],
                bugRows.map((bug) => [
                    `[${bug.bugId}](https://bugzilla.mozilla.org/show_bug.cgi?id=${bug.bugId})`,
                    // Untruncated, unlike the text renderer: `--markdown` never
                    // cuts, because it is the format for pasting into a bug.
                    bug.bugSummary,
                    fmtCount(bug.count),
                    `last ${bug.days} days`,
                    `\`fx-tests intermittent --bug ${bug.bugId}\``,
                ])
            )
        );
    }

    if (result.configs.length > 0) {
        lines.push('');
        lines.push(md.heading('Failing configurations'));
        lines.push('');
        const shown = applyLimit(result.configs, limit);
        lines.push(
            ...md.table(
                [
                    { header: 'Configuration' },
                    { header: 'fail rate', align: 'right' },
                    { header: 'fails', align: 'right' },
                    { header: 'recent', align: 'right' },
                    { header: 'runs', align: 'right' },
                ],
                shown.map((config) => [
                    config.jobName,
                    percent(config.failRate),
                    String(config.failCount),
                    percent(config.recentFailRate),
                    String(config.runCount),
                ])
            )
        );
        lines.push(md.moreLine(result.configs.length, shown.length));
    }

    if (result.issues.length > 0) {
        lines.push('');
        lines.push(md.heading('Issues'));
        lines.push('');
        const shown = applyLimit(result.issues, limit);
        lines.push(
            ...md.table(
                [
                    { header: 'count', align: 'right' },
                    { header: 'kind' },
                    { header: 'message' },
                ],
                shown.map((entry) => [String(entry.count), entry.type, oneLine(entry.message)])
            )
        );
        lines.push(md.moreLine(result.issues.length, shown.length));
    } else if (result.configFilter !== null) {
        lines.push('');
        lines.push(md.heading('Issues'));
        lines.push('');
        lines.push(emptyIssuesUnderFilter());
    }

    if (result.coverage !== undefined) {
        lines.push('');
        lines.push(md.heading('Coverage'));
        lines.push('');
        if (!result.coverage.attributedPasses) {
            lines.push(
                'Not available from this file: it does not attribute passing runs to a configuration.'
            );
        } else {
            const shown = applyLimit(result.coverage.configs, limit);
            lines.push(
                ...md.table(
                    [
                        { header: 'Configuration' },
                        { header: 'runs', align: 'right' },
                        { header: 'pass', align: 'right' },
                        { header: 'fail', align: 'right' },
                        { header: 'skip', align: 'right' },
                        { header: 'status' },
                    ],
                    shown.map((config) => [
                        config.jobName,
                        String(config.runCount),
                        String(config.passCount),
                        String(config.failCount),
                        String(config.skipCount),
                        config.state,
                    ])
                )
            );
            lines.push(md.moreLine(result.coverage.configs.length, shown.length));
            // The same platform rollup the text view leads with. A bug comment
            // pasting coverage is answering "does this run on Android", and a
            // truncated config table does not answer it.
            if (result.coverage.scheduledPlatforms.length > 0) {
                lines.push('');
                lines.push(
                    ...md.table(
                        [
                            { header: 'Platform scheduled on' },
                            { header: 'ran', align: 'right' },
                            { header: 'skipped', align: 'right' },
                        ],
                        result.coverage.scheduledPlatforms.map((entry) => [
                            entry.platform,
                            String(entry.ranCount),
                            String(entry.skippedCount),
                        ])
                    )
                );
                lines.push('');
                // Said outright, because a bug comment is read by someone who
                // did not run the command and cannot know the table is
                // complete. Without this the missing rows read as truncation.
                lines.push(
                    'Every platform this test is scheduled on has a row above. ' +
                        'A platform with no row is one CI does not run this test on.'
                );
            }
        }
    }

    if (result.executions !== undefined) {
        lines.push('');
        lines.push(md.heading('Executions'));
        lines.push('');
        lines.push(...renderExecutionsText(result.executions).slice(1).map((line) => line.trim()));
    }

    return joinLines(lines);
}

/**
 * The "Runs on N configs across ..." line.
 *
 * `CLI.md` puts this directly under the verdict, and names the reason: the
 * failing-config table above cannot say whether a platform ran the test at
 * all, so "no Android failures" is unreadable without it — it could mean
 * Android is fine or that Android never ran it.
 *
 * The "(not android — see --coverage)" clause is the load-bearing half, and
 * it is a measured absence: `absentPlatforms` is a set difference against the
 * platforms other tests in the same file run on.
 */
function describeReach(reach: TestJson['reach']): string | null {
    if (reach === null || reach.configCount === 0) {
        return null;
    }
    const platforms = reach.platforms
        .map((entry) => `${entry.platform} (${entry.configCount})`)
        .join(', ');
    const absent =
        reach.absentPlatforms.length === 0
            ? ''
            : ` — not ${reach.absentPlatforms.join(', ')}; see --coverage`;
    return `Runs on ${reach.configCount} configs across ${platforms}${absent}`;
}

/**
 * What the `Issues` section says when a `--config` filter emptied it.
 * Both renderers call this, so the heading cannot survive a filter in one format
 * and vanish in the other.
 */
function emptyIssuesUnderFilter(): string {
    return '(no issues on the configurations this filter matched)';
}

/**
 * The line naming the `--config` filter every number below was measured under.
 * Without it a filtered report is indistinguishable from an unfiltered one.
 */
function describeConfigFilter(filter: TestJson['configFilter']): string | null {
    if (filter === null) {
        return null;
    }
    const parts: string[] = [];
    if (filter.include.length > 0) {
        parts.push(`matching ${filter.include.join(', ')}`);
    }
    if (filter.exclude.length > 0) {
        parts.push(`excluding ${filter.exclude.join(', ')}`);
    }
    return `Filtered: every count below covers only configurations ${parts.join(', ')}`;
}

/** The header's window phrase. */
function describeWindow(metadata: TestJson['metadata']): string {
    if (metadata.singleDay) {
        return `${dateWithWeekday(metadata.endDate)} only`;
    }
    return (
        `${metadata.dayCount} days (${dateWithWeekday(metadata.startDate)} … ` +
        `${dateWithWeekday(metadata.endDate)})`
    );
}

/** The directory a test lives in. */
function dirOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? '.' : path.slice(0, slash);
}

/** Collapses a multi-line message onto one line for a table cell. */
function oneLine(value: string): string {
    return value.replace(/\s*\r?\n\s*/g, ' ⏎ ').trim();
}
