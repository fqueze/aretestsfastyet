/**
 * `fx-tests flaky` — which folder to book a flakiness-burndown session on.
 *
 * `flaky.html` leads with two charts, because "is the tree getting better?" is a
 * shape and a page can draw one. This command leads with something else, and the
 * difference is deliberate: the question a terminal is asked is *where do I spend
 * the afternoon*, and the answer to that is a ranked list of directories with
 * enough on each row to weigh the work against the payoff.
 *
 * So the default view is the page's **flat list**, not its tree and not its
 * charts. See `folderList()` for why the two rankings differ and why the flat one
 * is the actionable one: the tree puts `toolkit` first by virtue of containing
 * everything, and nobody can book a session on `toolkit`.
 *
 * ## The default window is a 7-day average of per-day classifications
 *
 * Both obvious choices are wrong, in opposite directions, and the default had to
 * be neither.
 *
 * **Not the whole 21 days.** `lib/query/flakiness.ts` opens with the measurement:
 * over the window 84% of xpcshell tests have failed at least once, because a test
 * runs on dozens of configurations dozens of times a day. Ranked that way the top
 * folders read 75%, 92%, 99% and nothing discriminates — `netwerk/test/unit` is
 * 437 of 582 and `js/xpconnect/tests/unit` is 148 of 149.
 *
 * **Not one day either**, which is the trap a per-day classification walks into
 * next: weekend push volume is 2.6× lower (`FORMATS.md`), so a single day's counts
 * are partly a fact about the weekday. Measured on the pinned window,
 * `netwerk/test/unit` reads 137 flaky on Tuesday and **76 on Sunday** — a 1.8×
 * swing from the calendar — and `dom/indexedDB/test/unit` is 4th on Sunday and 3rd
 * on Monday at more than double the count. Someone running this on a Monday would
 * be ranking Sunday's fraction of the runs.
 *
 * So the default is `DEFAULT_AVERAGE_DAYS` (7) days of *per-day* verdicts,
 * averaged: a whole number of weeks, so the weekday mix cancels, and still a daily
 * denominator rather than the window's inflated one. `flaky.html`'s headline tiles
 * average the same 7 days (`site/flaky-view.ts`'s `AVERAGE_WINDOW`), so the two
 * agree by construction. The counts are therefore **means per day and are
 * fractional** — 187.0 rather than 187 — which is the honest shape for "on a
 * typical day this folder has 187 flaky tests" and is why the columns carry a
 * decimal.
 *
 * `--day <date>` still ranks one named day and `--all-days` still ranks the whole
 * window, because both are real questions; the header always says which of the
 * three it printed. That is the bug `flaky.html` shipped and had to fix — tiles
 * showing one day above a table showing 21, with nothing saying so.
 *
 * ## What the columns are for
 *
 * A reader choosing between candidates needs the work, the payoff and the risk
 * that the work is not worth doing:
 *
 * - **flaky** — how many test files are flaky *directly in this folder*. The
 *   work. `selfFlaky`, not the subtree roll-up.
 * - **flaky%** — that as a percentage of the folder's own tests. Separates a
 *   rotten folder from two bad files in a healthy one, which want opposite
 *   responses and have the same flaky count.
 * - **skip** — how many of its tests are disabled somewhere. Ground already
 *   given up, usually the same underlying problem, and often the cheapest win.
 * - **tests** — the folder's population, so `flaky%` has a visible denominator.
 * - **+subtree** — the subtree's flaky count, printed only when it differs from
 *   the folder's own. That one column is the whole reason the tree view does not
 *   need to be a second table: it says "and there is more below here" without
 *   showing it.
 *
 * Two of those five were renamed after review, because the names did not carry
 * their meanings and the header block was already eight lines long — so the fix
 * had to be in the names rather than in more prose. `share` was read as a share
 * of the *issues* on the row (flaky/(flaky+skip)) rather than of the folder's
 * tests; `flaky%` sits directly under `flaky` and next to `tests`, which is the
 * ratio it is. `in tree` was read as "is this folder in the tree"; `+subtree`
 * leads with the `+` that says it is an addition to the number on its left.
 * `--sort share` still works, and is still spelled `share`, because a sort key is
 * an input a script may already have written down.
 *
 * ## Drilling in: `--group-by tests`
 *
 * A ranking's answer is a folder, and the next question is always which files.
 * `fx-tests issues --path <folder> --group-by test` answers a *different*
 * question and misleads badly here: it ranks by issue runs, and skips dominate
 * those. Measured on the pinned window for `toolkit/components/telemetry/tests/
 * unit`, it puts `test_UserInteraction_annotations.js` first with 6,879 issues,
 * **6,782 of which are skips** — a test this classification calls skipped and
 * not flaky. So the drill-down is here, on the same classification and the same
 * window as the ranking above it, reached as `fx-tests flaky <path>` or
 * `--group-by tests`. See `testRows()`.
 *
 * "The same window" is now true and was not. The listing passed no window option
 * to `flakinessByFolder` at all, so it inherited that function's own default of
 * the most recent day — a default written for the folder table. Measured on the
 * pinned file for `toolkit/components/telemetry/tests/unit`, the ranking scores
 * the folder over 7 days and the listing showed **29** flaky tests where **32**
 * were flaky across those days: three tests the ranking counted were absent from
 * the drill-down of it. The listing now takes one verdict per test over the same
 * 7 days — flaky if flaky on any of them — so drilling in is a refinement of the
 * row rather than a different question. `listingTree()` has the mechanism.
 *
 * The two numbers still differ, and both are right: the ranking's 26.7 is a mean
 * per day, the listing's 32 is a count of distinct tests. Only the *window* is
 * shared, and the header says so.
 *
 * ## Flaky and skipped overlap, and the header says so
 *
 * A test that fails on Linux and is disabled on Windows is both. Measured on the
 * pinned window, 800 of 4,807 tests are in both columns, so `flaky + skip` is not
 * a total and the two percentages have different denominators. `OverlappingCounts`
 * has the reasoning; the preamble states it, the way `issues` states which
 * outcomes it counted.
 *
 * The `--group-by days` view is the exception: it uses the mutually exclusive
 * classification, so its three columns *do* sum to `total`. The two views are
 * labelled differently for exactly that reason.
 */

import type { DecodedTimingFile } from '../../lib/formats/decode.ts';
import {
    DEFAULT_AVERAGE_DAYS,
    DEFAULT_MIN_WINDOW_FAILURES,
    type FlakyDay,
    type FolderListRow,
    type FolderNode,
    MIN_FILTERABLE_DAYS,
    type TestLeaf,
    flakinessByFolder,
    flakinessByFolderAveraged,
    flakinessOverTime,
    folderAt,
    folderList,
    hasSomethingToAct,
    runningAverage,
    subtreeTests,
} from '../../lib/query/flakiness.ts';
import { type OptionSpecs, type ParsedArgs, boolOption, numberOption, stringOption } from '../args.ts';
import { type CommandContext, emit, progress } from '../context.ts';
import { usageError } from '../errors.ts';
import { toJson } from '../format/json.ts';
import * as md from '../format/markdown.ts';
import {
    type Column,
    applyLimit,
    count as fmtCount,
    dateWithWeekday,
    joinLines,
    percent,
    tableSection,
} from '../format/text.ts';
import type { Harness } from '../options.ts';
import {
    type SearchedFile,
    describeSearchedFiles,
    harnessesForPathFilter,
} from '../../lib/model/harness.ts';
import { dayIndexOfDate, ifPublished, loadIssues, resolveDayKeyword } from '../data.ts';

/**
 * The standing definitions, printed by `flaky --help` and nowhere else.
 *
 * These are the lines that used to open **every** run. None of them changes
 * between two invocations — "flaky means failed, timed out or crashed" is as
 * true of tomorrow's data as of today's — so a reader needs them once and an
 * agent consumer pays for them every time. Measured on the pinned window they
 * were 13 of `flaky --limit 5`'s 24 lines (955 characters, ~238 tokens), where
 * the comparable `issues --limit 5` spends 4.
 *
 * They are not deleted, they are moved: the same text is in `docs/CLI.md`
 * §`fx-tests flaky`, and what remains in the output is the per-run provenance
 * `headerLines` documents.
 */
export const FLAKY_NOTES: string[] = [
    'How a test is classified:',
    '  flaky    it failed, timed out or crashed at least once',
    '  skipped  it was disabled somewhere (run-if exclusions are not counted)',
    '',
    'The window:',
    '  The FOLDER views average per-day counts over the last 7 days, so a folder reading',
    '  187.0 means "on a typical day, 187 of this folder\'s tests were flaky". A whole',
    '  number of weeks, because weekend push volume is 2.6x lower and one day\'s ranking is',
    '  otherwise partly the calendar: on the pinned window netwerk/test/unit reads 137',
    '  flaky on a Tuesday and 76 on a Sunday.',
    '  The PER-TEST view covers the SAME 7 days but does not average — a single test has',
    '  no meaningful mean — so it takes one verdict per test: flaky if flaky on ANY of',
    '  those days. Drilling into a ranked folder therefore stays inside the window it was',
    '  ranked over. The two numbers are still different quantities and both are right: on',
    '  the pinned window toolkit/components/telemetry/tests/unit ranks at 26.7 (a mean per',
    '  day) and lists 32 (distinct tests flaky at least once in the 7 days).',
    '  --day <date> takes one verdict on one named day instead. --all-days takes one over',
    '  the whole 21-day file, flaky if flaky on ANY day — a much looser bar, tree-wide',
    '  ~84% of tests, because a test runs on dozens of configs dozens of times a day.',
    '  Every run names the window it used in its header.',
    '',
    'Flaky and skipped OVERLAP:',
    '  A test failing on Linux and disabled on Windows is both, so the flaky and skip',
    '  columns do not sum to the test count — on the pinned window 800 of 4,807 tests are',
    '  in both. On the folder views flaky% is flaky/tests, not flaky/(flaky+skip). Rows are',
    '  ranked flaky-first, so a skipped-only test is never above a flaky one.',
    '',
    'Reading the columns:',
    '  Folder views rank a population, so they carry counts and a flaky% share of the',
    '  folder\'s tests, plus +subtree — the flaky count including subfolders.',
    '  The per-test view is one verdict per test over the window, as flaky.html shows it:',
    '    flaky        1 if it failed, timed out or crashed at all in the window, else 0',
    '    skipped      1 if it is disabled somewhere, else 0. A test can be both; 0 flaky',
    '                 with 1 skipped is switched off rather than failing.',
    '    failures     failing RUNS over the whole file window, across every configuration —',
    '                 a different unit and window from the two verdicts, and what --noise',
    '                 is compared against. It is what separates "failed twice" from',
    '                 "failed 2,543 times".',
    '  There is no percentage on a single test: a percentage needs a population, and one',
    '  test can only be 0% or 100%. Use `fx-tests test <path>` for a per-configuration',
    '  breakdown of one test, or --json for the raw counters.',
    '',
    '--group-by days is the exception: its flaky, stable and skipped columns are mutually',
    'exclusive and do sum to total.',
    '',
    // The reciprocal of the paragraph `intermittent --help` carries, since an
    // agent asked for the most commonly failing tests ranked them from a
    // failure-count command and then reasoned about sheriff priority from it.
    // One sentence ending in a pointer: the explanation is `fx-tests guide`'s
    // `annotations-are-not-failures` trap and paraphrasing it here would be a
    // copy to keep in step.
    //
    // NOT the same sentence as `ISSUES_NOTES`, and the difference is the point.
    // This command does not count failures: a row is TESTS carrying a flaky
    // verdict — a per-day mean of them on the folder views, a literal 1 or 0 per
    // test on the per-test view, with `failures` a separate column the ranking
    // is not ordered by. The first version of this note was `issues`' sentence
    // copied verbatim, and its "rather than the failures counted here" was false
    // of the very command it printed on, which is exactly the confusion the
    // pointer exists to prevent. Each sentence names its own unit.
    '`fx-tests intermittent` ranks the bugs sheriffs annotated failing jobs with rather than',
    'the tests counted flaky here — see `fx-tests guide`, "`intermittent` counts sheriff',
    'annotations, not failures".',
];

/** `fx-tests flaky` options. */
export const FLAKY_OPTIONS: OptionSpecs = {
    // The global's shared wording is wrong here, restated rather than left to
    // mislead — the same mechanism `intermittent` uses, since a command's own
    // spec wins the merge in `dispatch()`. This command reads no test path: it
    // takes a directory prefix, which has no filename for `detectHarness` to
    // classify, so it reads both aggregates instead of inferring. See
    // `harnessesForPathFilter`.
    harness: {
        type: 'string',
        placeholder: '<xpcshell|mochitest>',
        describe:
            'Which harness’s data to read. Omit it and a directory path reads both, printing ' +
            'whichever has rows.',
    },
    path: {
        type: 'string',
        placeholder: '<prefix>',
        describe: 'Only tests under this directory prefix.',
    },
    'group-by': {
        type: 'string',
        placeholder: '<list|folder|days|tests>',
        describe:
            'How to group. Default list — folders ranked by their own flaky tests, the ' +
            'burndown view. `folder` rolls subtrees up; `days` is the trend; `tests` lists the ' +
            'individual test files under a path, which `fx-tests flaky <path>` also selects.',
    },
    sort: {
        type: 'string',
        placeholder: '<flaky|share|skips|tests|name>',
        describe: 'How to rank. Default flaky.',
    },
    'here-only': {
        type: 'boolean',
        describe:
            '--group-by tests: only the files directly in the path, not its subfolders. ' +
            'The subtree is the default, because a folder ranking\'s answer is a directory and ' +
            'its subdirectories are part of the same job.',
    },
    noise: {
        type: 'number',
        placeholder: '<n>',
        describe:
            'Read a test failing this often or less over the window as passing. Default 1; ' +
            '0 disables. Ignored on a single-day file.',
    },
    'average-days': {
        type: 'number',
        placeholder: '<n>',
        describe:
            'Average the per-day counts over this many days. Default 7; a multiple of 7 is ' +
            'strongly preferred, since weekend push volume is 2.6x lower.',
    },
    'all-days': {
        type: 'boolean',
        describe:
            'Classify over the whole window instead: flaky if flaky on ANY day. A much looser ' +
            'bar — tree-wide that is ~84% of tests. See the header it prints.',
    },
};

/** The default row count, as every other tree-wide view uses. */
const DEFAULT_LIMIT = 20;

/** The centred running mean's window, in days, for `--group-by days`. */
const TREND_WINDOW = 7;

/** How rows can be ranked. */
type FlakySort = 'flaky' | 'share' | 'skips' | 'tests' | 'name';

/** Which view to print. */
type FlakyGroupBy = 'list' | 'folder' | 'days' | 'tests';

/** The provenance header, shared by every view and repeated in `--json`. */
interface FlakyHeader {
    harness: string;
    family: string;
    /** The file's whole window. */
    startDate: string;
    endDate: string;
    dayCount: number;
    testCount: number;
    dataSource: string;
    /**
     * Which window classified: an average, one day, the whole file, or a trailing
     * window of it.
     *
     * Named rather than left implicit because they give a 48%, a 53% and a 75%
     * reading of the same folder, and a reader cannot tell them apart from the
     * numbers. See the module comment.
     *
     * `window` is the per-test listing's default and appears on no folder view: it
     * is one verdict per test over the same `DEFAULT_AVERAGE_DAYS` days the folder
     * ranking averages — see `listingTree`. The folder views never take it,
     * because "flaky on any of 7 days" inflates a folder's count toward the same
     * denominator effect `--all-days` has, which is what the averaging avoids.
     */
    scope: 'average' | 'day' | 'all-days' | 'window';
    /**
     * Whether the scope was asked for, rather than being a view's default.
     *
     * Only the suggested follow-up commands read it, and only to avoid printing a
     * flag the reader never typed: the per-test listing classifies the ranking's
     * 7 days by default (`listingHeader`), which is not the same fact as
     * `--all-days` or `--day 2026-08-04` on the command line.
     */
    scopeRequested: boolean;
    /** The dates the folder views covered, oldest first. */
    scopeDates: string[];
    /**
     * How many days were averaged, or `null` outside `scope: 'average'`.
     *
     * The count actually used, which is fewer than requested on a short file —
     * so a view cannot label a 3-day file's numbers a 7-day average.
     */
    averageDays: number | null;
    /**
     * The noise threshold **actually applied**, which is 0 on a single-day file
     * whatever was asked for. Reported rather than the request, so a caller
     * cannot claim a filter that did not run. See `MIN_FILTERABLE_DAYS`.
     */
    minWindowFailures: number;
    /** What `--noise` asked for, so the two can be seen to differ. */
    requestedMinWindowFailures: number;
    /** How many tests the filter neutralised. */
    neutralisedTests: number;
    /** True when the filter was requested and skipped for being unjudgeable. */
    noiseFilterSkipped: boolean;
}

/** Everything a view needs, loaded once. */
interface FlakyQuery {
    harness: Harness;
    file: DecodedTimingFile;
    pathPrefix: string | undefined;
    /** Set only when `--day` named one; otherwise the scope is not a single day. */
    day: number | undefined;
    allDays: boolean;
    /** How many days to average, when the scope is the default average. */
    averageDays: number;
    minWindowFailures: number;
    header: FlakyHeader;
}

/**
 * Loads the aggregate and resolves the day.
 *
 * `resolveDayWindow()` is deliberately **not** reused. It returns an inclusive
 * *range* of day indices, which is the right shape for a command summing runs
 * over a window, and the wrong shape here: this classification is per day, so a
 * range of days is not a thing it can be evaluated on: "flaky over days 14-20" is
 * either seven verdicts or a looser single verdict, and those are the two things
 * `--average-days` and `--all-days` already name. So `--day` picks one day,
 * `--average-days` sets the averaging width, `--since` narrows the trend series,
 * and none of the three is silently reinterpreted as another.
 */
async function loadFlakyQuery(
    context: CommandContext,
    args: ParsedArgs,
    /**
     * Which harness's file to read, when `runFlaky` resolved that itself.
     *
     * It does whenever the path is a directory and no `--harness` was given, in
     * which case there is nothing to infer from and both are read. See
     * `harnessesForPathFilter`.
     */
    harnessOverride?: Harness
): Promise<FlakyQuery> {
    const harness: Harness = harnessOverride ?? context.globals.harness ?? 'xpcshell';
    progress(context, `Reading ${harness}-issues.json…`);
    const { file } = await loadIssues(context, harness);

    if (context.globals.config.length > 0 || context.globals.excludeConfig.length > 0) {
        // The same refusal `issues` makes, for the same reason: `issues.json`
        // records no job names, so a configuration filter over it matches
        // nothing for every input and an empty table would read as a clean tree.
        throw usageError(
            `--config cannot be applied to ${harness}-issues.json: the file records no job ` +
                'names, so every configuration filter over it matches nothing',
            'Flakiness here is a per-test verdict over all configurations. `fx-tests test <path> ' +
                '--config` reads a bucket file and can break one test down by configuration.'
        );
    }

    const days = file.days ?? 1;
    const allDays = boolOption(args, 'all-days');
    const requested = numberOption(args, 'noise') ?? DEFAULT_MIN_WINDOW_FAILURES;
    const averageDays = numberOption(args, 'average-days') ?? DEFAULT_AVERAGE_DAYS;
    if (averageDays < 1) {
        throw usageError(`--average-days expects at least 1, got ${averageDays}`);
    }
    if (allDays && args.options.has('average-days')) {
        throw usageError(
            '--all-days and --average-days are mutually exclusive',
            '--all-days is a single verdict over the whole window; --average-days averages ' +
                'per-day verdicts. Pick one.'
        );
    }

    let day: number | undefined;
    if (context.globals.day !== undefined) {
        if (allDays) {
            throw usageError(
                '--day and --all-days are mutually exclusive',
                '--day classifies on one day; --all-days classifies over the whole window. ' +
                    'They are the two ends of the choice, not a range.'
            );
        }
        if (args.options.has('average-days')) {
            throw usageError(
                '--day and --average-days are mutually exclusive',
                '--day is one day; --average-days averages several. Drop --day to average.'
            );
        }
        const wanted = resolveDayKeyword(context.globals.day, file.endDate);
        const index = dayIndexOfDate(file.endDate, days, wanted);
        if (index === null) {
            throw usageError(
                `no data for ${wanted}: ${harness}-issues.json covers ` +
                    `${dateOfIndex(file.endDate, days, 0)} … ${file.endDate} (${days} days)`,
                'Run `fx-tests dates` to see what is published.'
            );
        }
        day = index;
    }

    // `flaky <path>` and `--path <prefix>` are the same selection — `runFlaky`
    // refuses both at once — so the prefix is resolved once, here, and every
    // view and the header read it from the same place.
    const pathPrefix = stringOption(args, 'path') ?? args.positionals[0];

    // `flakinessOverTime` is what reports the threshold it really applied and
    // how many tests it neutralised, and both are header facts every view
    // prints — so the series is computed once here rather than only by the
    // trend view. It is one pass over a file already in memory.
    const series = flakinessOverTime(file, {
        minWindowFailures: requested,
        ...(pathPrefix === undefined ? {} : { pathPrefix }),
    });

    // The three scopes, resolved once so the header and the views cannot disagree
    // about which one ran — which is the mismatch `flaky.html` had to fix.
    const scope: FlakyHeader['scope'] = allDays ? 'all-days' : day !== undefined ? 'day' : 'average';
    const effectiveAverage = Math.max(1, Math.min(averageDays, days));
    const scopeDates =
        scope === 'day'
            ? [dateOfIndex(file.endDate, days, day!)]
            : scope === 'all-days'
              ? [dateOfIndex(file.endDate, days, 0), file.endDate]
              : Array.from({ length: effectiveAverage }, (_unused, offset) =>
                    dateOfIndex(file.endDate, days, days - effectiveAverage + offset)
                );

    return {
        harness,
        file,
        pathPrefix,
        day,
        allDays,
        averageDays,
        minWindowFailures: series.minWindowFailures,
        header: {
            harness,
            family: file.family,
            startDate: dateOfIndex(file.endDate, days, 0),
            endDate: file.endDate,
            dayCount: days,
            testCount: file.testCount,
            dataSource: context.source.name,
            scope,
            // Asked for here by construction: this scope came from --day,
            // --all-days or the default average. `listingHeader` is the one place
            // that narrows a scope on the view's own behalf, and it clears this.
            scopeRequested: true,
            scopeDates,
            averageDays: scope === 'average' ? effectiveAverage : null,
            minWindowFailures: series.minWindowFailures,
            requestedMinWindowFailures: requested,
            neutralisedTests: series.neutralisedTests,
            // The distinction `MIN_FILTERABLE_DAYS` documents: a caller who
            // asked for a filter on a one-day file gets the unfiltered
            // classification, and is told so rather than left to assume the
            // 366 tests it would have neutralised were quietly handled.
            noiseFilterSkipped: requested > 0 && series.minWindowFailures === 0,
        },
    };
}

/** The date of a day index. Day 0 is the oldest, as the files encode it. */
function dateOfIndex(endDate: string, days: number, index: number): string {
    const end = Date.parse(`${endDate}T00:00:00Z`);
    if (Number.isNaN(end)) {
        return endDate;
    }
    return new Date(end - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
}

/** Runs `fx-tests flaky`. */
export async function runFlaky(context: CommandContext, args: ParsedArgs): Promise<void> {
    if (args.positionals.length > 1) {
        throw usageError(
            `flaky takes at most one path, got ${args.positionals.length}: ` +
                args.positionals.join(', ')
        );
    }
    const positional = args.positionals[0];
    // Both spellings of the same selection, so they cannot disagree about it.
    // Refused rather than merged: `flaky dom --path netwerk` has no reading that
    // is not a guess, and `cli/args.ts`'s rule is that a flag must not silently
    // do nothing.
    if (positional !== undefined && args.options.has('path')) {
        throw usageError(
            `flaky <path> and --path are the same selection, got "${positional}" and ` +
                `"${stringOption(args, 'path')}"`,
            'Drop one. `fx-tests flaky <path>` is shorthand for `--path <path> --group-by tests`.'
        );
    }
    const groupBy = readGroupBy(args);
    const sort = readSort(args);
    if (positional !== undefined && groupBy !== 'tests') {
        // The positional is *how* the per-test view is reached, so pairing it
        // with another view leaves it meaning nothing but a path filter — which
        // is what `--path` is for and is spelled that way.
        throw usageError(
            `flaky <path> selects the per-test listing, which --group-by ${groupBy} is not`,
            `Use \`fx-tests flaky --path ${positional} --group-by ${groupBy}\` for that view.`
        );
    }
    if (args.options.has('here-only') && groupBy !== 'tests') {
        throw usageError(
            `--here-only only applies to --group-by tests, not ${groupBy}`,
            'The folder views already report the folder\'s own tests and its subtree in ' +
                'separate columns.'
        );
    }
    if (args.options.has('here-only') && positional === undefined && !args.options.has('path')) {
        // Measured: with no path, `--here-only` names the tree root, no test file
        // lives at the top level of mozilla-central, and the listing came out
        // empty — a flag that silently produces no rows is the "flag did nothing"
        // failure `cli/args.ts` rejects unknown flags to avoid.
        throw usageError(
            '--here-only needs a path: it means "not the subfolders of", and with no path there ' +
                'is nothing to exclude',
            'Drop --here-only for every test in the tree, or name a folder: ' +
                'fx-tests flaky <folder> --here-only.'
        );
    }
    if (groupBy === 'days' && args.options.has('sort')) {
        // A calendar is not a ranking. Accepting `--sort` here and ignoring it
        // would be the "flag did nothing" failure `cli/args.ts` opens by
        // rejecting for unknown flags.
        throw usageError(
            '--sort does not apply to --group-by days, which is ordered by date',
            'Drop --sort, or use --group-by list to rank folders.'
        );
    }

    // `flaky <path>` and `--path <prefix>` are the same selection, already
    // refused together above. A **directory** has no filename to infer a harness
    // from, so with no `--harness` both files are read and the data decides which
    // one — or both — has an answer. See `harnessesForPathFilter`.
    const pathPrefix = stringOption(args, 'path') ?? positional;
    const { required, speculative } = harnessesForPathFilter(pathPrefix, context.globals.harness);
    const limit = context.globals.limit ?? DEFAULT_LIMIT;

    const oneHarness = async (harness: Harness): Promise<FlakyView> =>
        oneView(context, args, await loadFlakyQuery(context, args, harness), groupBy, sort, limit);

    const views: FlakyView[] = [await oneHarness(required)];
    for (const harness of speculative) {
        // A file this command went looking for on its own initiative, so its
        // absence means "no data from that harness" rather than an error. See
        // `ifPublished`.
        const extra = await ifPublished(oneHarness(harness));
        if (extra !== null) {
            views.push(extra);
        }
    }

    // Only the ones with rows, unless none has any — then the first, so the
    // existing not-found message still prints exactly once. The first is the
    // harness the command searched before it learned to widen.
    const withRows = views.filter((view) => view.rowCount > 0);
    const shown = withRows.length > 0 ? withRows : views.slice(0, 1);
    // The aggregates that were read and are not being printed. Reaches the output
    // only through the not-found messages, and only in the both-empty case, where
    // naming one file after downloading two would be a false sentence.
    const alsoSearched = views.filter((view) => !shown.includes(view)).map((view) => view.file);
    if (context.globals.format === 'json' && shown.length > 1) {
        // Two JSON documents on one stdout is not JSON. Wrapped only when there
        // really are two, so a single answer keeps the shape it always had.
        emit(context, toJson(roundForJson({ harnesses: shown.map((view) => view.result) })));
        return;
    }
    for (const [index, view] of shown.entries()) {
        if (index > 0) {
            // The second header has to read as a second answer, not as more rows
            // under the first one.
            emit(context, '\n');
        }
        emitResult(context, view.result, () => view.render(alsoSearched));
    }
}

/** One harness's answer, before it is known whether the other has one too. */
interface FlakyView {
    result: unknown;
    /** How many rows it found — the test for "this harness has data". */
    rowCount: number;
    /** The file this view read, for the messages that name what was searched. */
    file: SearchedFile;
    /**
     * `alsoSearched` names the aggregates that were read and are not printed, so
     * the not-found message can name the whole population. Empty unless this is
     * the both-empty case. See `describeSearchedFiles`.
     */
    render(alsoSearched: readonly SearchedFile[]): Rendered;
}

/** The requested view over one harness's file. */
function oneView(
    context: CommandContext,
    args: ParsedArgs,
    query: FlakyQuery,
    groupBy: FlakyGroupBy,
    sort: FlakySort,
    limit: number
): FlakyView {
    const file: SearchedFile = {
        harness: query.header.harness,
        testCount: query.header.testCount,
    };
    if (groupBy === 'days') {
        const result = trendResult(query, context, limit);
        // Not `rows.length`: this view has one row per **day**, so a harness that
        // ran nothing under the path still returns a full calendar of zeroes.
        // What makes it an answer is a day on which some test ran, which is the
        // same emptiness `renderTrend`'s own message names. And not a sum over
        // `result.rows` either — those are the `--limit` tail, so a folder that
        // ran early in the window and stopped would read as "no data" at
        // `--limit 3` and print at `--limit 0`. See `TrendResult.testDays`.
        return {
            result,
            rowCount: result.testDays,
            file,
            render: (alsoSearched) => renderTrend(result, alsoSearched),
        };
    }

    if (groupBy === 'tests') {
        // Its own tree: one verdict over the window, as the page's test rows are.
        // See `listingTree`.
        const result = testResult(
            query,
            listingTree(query),
            boolOption(args, 'here-only'),
            sort,
            limit
        );
        // `consideredTests`, not `rows.length`: a folder whose every test passed
        // everywhere has no rows and is still an answer — "nothing is flaky here"
        // — and dropping it would send the reader to the typo message instead.
        return {
            result,
            rowCount: result.consideredTests,
            file,
            render: (alsoSearched) => renderTests(result, alsoSearched),
        };
    }

    const root = classifiedTree(query);
    const rows = groupBy === 'list' ? listRows(root) : treeRows(root);
    const sorted = sortRows(rows, sort);
    const result: FolderResult = {
        header: query.header,
        groupBy,
        sort,
        pathPrefix: query.pathPrefix ?? null,
        allDays: query.allDays,
        totals: {
            flaky: root.flaky,
            stable: root.stable,
            skipped: root.skipped,
            flakyAndSkipped: root.flakyAndSkipped,
            total: root.total,
            testCount: root.testCount,
        },
        rowCount: sorted.length,
        rows: applyLimit(sorted, limit),
    };
    return {
        result,
        rowCount: sorted.length,
        file,
        render: (alsoSearched) => renderFolders(result, alsoSearched),
    };
}

/**
 * The classified folder tree under the query's scope.
 *
 * Extracted so the folder views and the per-test listing cannot classify
 * differently. That is not hypothetical tidiness: the whole complaint the per-test
 * view answers is that `fx-tests issues --path <folder>` ranks the *same folder*
 * on a different definition and puts a skipped test first, so a drill-down that
 * re-derived its own classification would reintroduce the bug one level down.
 */
function classifiedTree(query: FlakyQuery): FolderNode {
    const noise = {
        minWindowFailures: query.header.requestedMinWindowFailures,
        ...(query.pathPrefix === undefined ? {} : { pathPrefix: query.pathPrefix }),
    };
    // The default scope averages per-day verdicts, so it is a different walk and
    // not a `FolderOptions` flag — see `flakinessByFolderAveraged`.
    return query.header.scope === 'average'
        ? flakinessByFolderAveraged(query.file, {
              ...noise,
              averageDays: query.averageDays,
          }).root
        : flakinessByFolder(query.file, {
              ...noise,
              ...(query.allDays ? { allDays: true } : {}),
              ...(query.day === undefined ? {} : { day: query.day }),
          });
}

// --- the per-test listing ------------------------------------------------

/** One row of `--group-by tests`. */
interface TestRow {
    path: string;
    /**
     * Which of the two things this test is, spelled out.
     *
     * The column exists because the number columns alone cannot say it under the
     * averaged scope: a test flaky on two of seven days reads `0.3`, and `0.3`
     * next to a skip count of `1` gives a reader no ordering between "this fails"
     * and "this is switched off". That ambiguity is exactly how
     * `issues --group-by test` came to rank a skipped file first, so the drill-down
     * states the verdict rather than leaving it to be inferred from two decimals.
     *
     * `flaky+skipped` is not a third state — see `OverlappingCounts` — it is the
     * overlap, and it is 800 of 4,807 tests on the pinned window, so it needs a
     * name of its own rather than being filed under either.
     */
    verdict: 'flaky' | 'flaky+skipped' | 'skipped';
    /**
     * Whether this test was flaky in the window: **0 or 1**, as the page's table
     * shows it.
     *
     * Not a day count and not a mean, and both of those were mistakes this view
     * made in turn. The 7-day averaging is a *folder-ranking* concept — "126.7 of
     * this folder's tests were flaky on a typical day" is a real quantity —
     * and pushing it down onto a single test produces nothing a reader can use:
     * a single test's mean can only be 0, 1/7 … 1, so it was multiplied back out
     * into "flaky on 6 of the 7 days", and `7 of 7` to say "always" is more
     * digits than "yes" with no more meaning.
     *
     * `flakinessByFolder` — what `flaky.html` renders its test rows from — gives
     * one verdict over the window instead. Measured on the pinned file, its
     * 4,807 leaves take exactly **two** distinct values in each of `flaky`,
     * `skipped` and `stable`, namely 0 and 1, with `total` always 1. Using the
     * same derivation is also what stops the CLI and the page disagreeing about
     * a test, which `test/flaky-tests-listing.test.ts` pins.
     *
     * What the listing *does* share with the ranking is the **window**, which is
     * not the same thing as the averaging: by default the verdict covers the same
     * `DEFAULT_AVERAGE_DAYS` days, flaky if flaky on any of them. See
     * `listingTree`.
     */
    flaky: number;
    /** Whether it is skipped somewhere: 0 or 1, overlapping `flaky`. */
    skipped: number;
    flakyAndSkipped: number;
    /** Always 1 — one test, one verdict. Kept so `--json` stays self-describing. */
    total: number;
    /**
     * Failing runs over the **whole file's window**, not the scope.
     *
     * The one number here with real resolution: 272 distinct values over the
     * pinned file's leaves, up to 5,200, where every other column is 0 or 1. It
     * is what separates "failed twice" from "failed 2,543 times".
     */
    windowFailures: number;
    /** Whether the noise filter read this test's failures as passes. */
    neutralised: boolean;
}

/** The `--json` shape of `--group-by tests`. */
interface TestResult {
    header: FlakyHeader;
    groupBy: 'tests';
    sort: FlakySort;
    pathPrefix: string | null;
    /** False when the listing covered the subtree, true under `--here-only`. */
    hereOnly: boolean;
    /**
     * Tests that passed everywhere they ran and are therefore not listed.
     *
     * Reported rather than silently dropped, exactly as the page does: a listing
     * shorter than the `tests` count on the folder row above it is otherwise an
     * unexplained discrepancy. Measured tree-wide on the pinned window, under the
     * three scopes:
     *
     * | scope | clean, not listed | considered |
     * | --- | --- | --- |
     * | the ranking's 7 days (default) | 2,224 | 4,806 |
     * | `--all-days` | 707 | 4,807 |
     * | `--day 2026-08-04` | 3,122 | 4,805 |
     *
     * The two ends are the page's own measured figures for its two readings
     * (`site/flaky-view.ts`'s `isWorthListing`), which is the check that this
     * hides the same rows the page hides. The default sits between them, as a
     * verdict over 7 of the 21 days must.
     */
    cleanTests: number;
    /** Every test considered, clean ones included. */
    consideredTests: number;
    rowCount: number;
    rows: TestRow[];
}

/**
 * The per-test rows for a path.
 *
 * **The subtree by default**, and `--here-only` for the folder alone. That way
 * round because the ranking above this hands a reader a directory and the
 * subdirectories under it are the same afternoon's work — and because the folder
 * views already carry a `+subtree` column whose entire job is to say "there is
 * more below here", so the obvious next command must be the one that shows it.
 * Measured on the pinned window, 4 of 250 folders have subfolders at all, so the
 * two answers coincide on 246 of them; the default is chosen for the 4 where they
 * do not.
 *
 * Clean tests are counted and not listed — `hasSomethingToAct`, the rule
 * `site/flaky-view.ts` states and measures.
 */
/**
 * The tree the **per-test listing** reads, which is not the one the folder views
 * read.
 *
 * `flakinessByFolder` rather than `flakinessByFolderAveraged`, because a single
 * test has no meaningful average: it gives one verdict over the window, and its
 * leaves are 0 or 1 (measured: exactly two distinct values in `flaky`, `skipped`
 * and `stable` across the pinned file's 4,807 leaves, `total` always 1). This is
 * also the derivation `flaky.html` renders its test rows from, so the CLI and the
 * page cannot disagree about whether a test is flaky —
 * `test/flaky-tests-listing.test.ts` asserts they agree leaf for leaf.
 *
 * ## The default window is the ranking's, and used not to be
 *
 * With neither `--day` nor `--all-days` this passed **no window option at all**,
 * so `flakinessByFolder` fell through to its own default of the most recent day —
 * a default written for the *folder* table, where a single day is the right unit,
 * and inherited here by omission. The ranking above it scores over
 * `DEFAULT_AVERAGE_DAYS` days, so drilling into a row crossed a window boundary
 * with nothing saying so. Measured on the pinned file for
 * `toolkit/components/telemetry/tests/unit`: the ranking scores 7 days, and the
 * listing showed **29** flaky tests where **32** were flaky in those 7 days.
 * Three tests the ranking counted were silently absent from the drill-down.
 *
 * So the default is now the ranking's window, expressed as the only shape a
 * per-test verdict can take over several days: `allDays` bounded by `fromDay`,
 * flaky if flaky on **any** of them. Still 0/1 per test, still no means, still
 * `windowState`'s precedence — a test flaky on one of those days and skipped on
 * another is flaky-and-skipped, as it is under every other scope.
 *
 * **The two numbers are not the same quantity and must not be forced to match.**
 * The ranking's 26.7 is a mean per day; this listing's 32 is a count of distinct
 * tests flaky at least once in the window. Both are correct over the same 7 days,
 * and the header states the relationship rather than leaving a reader to notice
 * that 32 > 26.7.
 *
 * `--day` and `--all-days` are untouched: one named day, and one verdict over the
 * whole 21-day file.
 */
function listingTree(query: FlakyQuery): FolderNode {
    const noise = { minWindowFailures: query.header.requestedMinWindowFailures };
    const days = query.file.days ?? 1;
    // The default: the ranking's trailing window, as a single verdict per test.
    // `header.scope` is what resolved which of the four ran, so the tree and the
    // header cannot disagree about it — the mismatch `flaky.html` had to fix.
    const window =
        query.header.scope === 'average'
            ? { allDays: true as const, fromDay: days - (query.header.averageDays ?? days) }
            : {
                  ...(query.allDays ? { allDays: true as const } : {}),
                  ...(query.day === undefined ? {} : { day: query.day }),
              };
    return flakinessByFolder(query.file, {
        ...noise,
        ...(query.pathPrefix === undefined ? {} : { pathPrefix: query.pathPrefix }),
        ...window,
    });
}

/**
 * The header as it applies to the **per-test listing**, whose scope differs.
 *
 * `loadFlakyQuery` resolves one header for every view, and its default is the
 * folder ranking's 7-day *average*. `listingTree` covers the same seven days but
 * does not average them: a single test's mean can only be 0, 1/7 … 1, so it takes
 * one verdict over the window instead. Emitting the shared header unchanged would
 * have `--json` claim `scope: "average"` and `averageDays: 7` over a table of 0/1
 * verdicts — the tiles-say-one-thing, table-says-another mismatch `flaky.html`
 * had to fix, and the reason this header names its scope at all.
 *
 * So the listing corrects the fields that describe *how* it classified and leaves
 * the rest — the dates themselves, the file's window, the harness, the noise
 * accounting — alone. `scopeDates` is deliberately unchanged: the window really
 * is those seven days, which is the whole point of the fix. Only `averageDays`
 * goes to `null`, because nothing here is a mean.
 *
 * `scopeRequested` stays false in that correction, because the window was this
 * view's default rather than something the reader asked for. `suggestion` reads
 * it: a footer that appended `--all-days` would be telling the reader to type a
 * flag they never typed, and one that named a date would pin a later run to it.
 */
function listingHeader(header: FlakyHeader): FlakyHeader {
    if (header.scope !== 'average') {
        return header;
    }
    return {
        ...header,
        scope: 'window',
        averageDays: null,
        scopeRequested: false,
    };
}

function testResult(
    query: FlakyQuery,
    root: FolderNode,
    hereOnly: boolean,
    sort: FlakySort,
    limit: number
): TestResult {
    // `flakinessBy*` already applied the path prefix, so the whole tree is the
    // selection; `--here-only` needs the one node, which requires the prefix to
    // name a directory rather than be any string. A prefix that names no folder —
    // a partial segment, or a full test path — has no node, and the empty listing
    // says so rather than silently reporting the subtree.
    const node = hereOnly && query.pathPrefix !== undefined
        ? folderAt(root, query.pathPrefix)
        : root;
    const leaves: TestLeaf[] = node === null ? [] : hereOnly ? node.tests : subtreeTests(node);
    const worth = leaves.filter(hasSomethingToAct);
    // Straight off the leaf. No scaling, no rounding, no ratio: the counters are
    // already the 0/1 verdicts the page shows, and every transformation this used
    // to apply was recovering information it had just destroyed.
    const rows: TestRow[] = worth.map((leaf) => ({
        path: leaf.fullPath,
        verdict:
            leaf.flakyAndSkipped > 0
                ? 'flaky+skipped'
                : leaf.flaky > 0
                  ? 'flaky'
                  : 'skipped',
        flaky: leaf.flaky,
        skipped: leaf.skipped,
        flakyAndSkipped: leaf.flakyAndSkipped,
        total: leaf.total,
        windowFailures: leaf.windowFailures,
        neutralised: leaf.neutralised,
    }));
    const sorted = sortTestRows(rows, sort);
    return {
        // Corrected to the scope this listing actually classified. See
        // `listingHeader`.
        header: listingHeader(query.header),
        groupBy: 'tests',
        sort,
        pathPrefix: query.pathPrefix ?? null,
        hereOnly,
        cleanTests: leaves.length - worth.length,
        consideredTests: leaves.length,
        rowCount: sorted.length,
        rows: applyLimit(sorted, limit),
    };
}

/**
 * Ranks test rows **flaky-first**, then by how much they are skipped.
 *
 * The tie-break carries almost all the ordering here, because the keys are 0/1:
 * `flaky` and `skipped` sort the rows into at most four blocks, so within a block
 * the second and third keys are what a reader sees. `windowFailures` is that
 * second key — 272 distinct values over the pinned file's leaves against 2 for
 * every verdict column — which puts "failed 2,543 times" above "failed twice"
 * instead of leaving both in path order.
 *
 * A purely-skipped test cannot outrank a flaky one, which is the whole defect
 * being fixed: `issues --group-by test` on `toolkit/components/telemetry/tests/
 * unit` puts `test_UserInteraction_annotations.js` first on 6,879 issues of which
 * 6,782 are skips, and this classification calls that test skipped and not flaky.
 */
function sortTestRows(rows: readonly TestRow[], sort: FlakySort): TestRow[] {
    const sorted = [...rows];
    const byPath = (a: TestRow, b: TestRow): number => a.path.localeCompare(b.path);
    /** Failing runs, then path: the only keys with resolution below the verdicts. */
    const byWeight = (a: TestRow, b: TestRow): number =>
        b.windowFailures - a.windowFailures || byPath(a, b);
    switch (sort) {
        // `share` ranked on a percentage that no longer exists, and could not
        // meaningfully: a percentage of one test is 0% or 100%, which is the
        // `flaky` verdict restated. It ranks as `flaky` rather than being
        // rejected, since it stays valid on the folder views this flag is shared
        // with.
        case 'flaky':
        case 'share':
            sorted.sort((a, b) => b.flaky - a.flaky || b.skipped - a.skipped || byWeight(a, b));
            break;
        case 'skips':
            sorted.sort((a, b) => b.skipped - a.skipped || b.flaky - a.flaky || byWeight(a, b));
            break;
        case 'tests':
            // `tests` is a folder's population and a test has none — `total` is 1
            // on every row — so the closest honest reading is "how much did it
            // fail", which is the one number a test row has a lot of.
            sorted.sort(byWeight);
            break;
        case 'name':
            sorted.sort(byPath);
            break;
    }
    return sorted;
}

/** Renders the per-test listing. */
function renderTests(
    result: TestResult,
    /** The other aggregates this run read. See `testEmptyMessage`. */
    alsoSearched: readonly SearchedFile[] = []
): Rendered {
    // Six columns cut to three. What the old six actually contained, measured over
    // every listed row on the pinned window (2,582 rows):
    //
    // | column | distinct values | mode |
    // | --- | --- | --- |
    // | `ran d` | 2 | **7 on 2,581 of 2,582 rows** |
    // | `verdict` | 3 | `flaky` on 60.0% |
    // | `flaky d` | 8 | 1 on 29.2% |
    // | `flaky%` | 8 | 14.3% on 29.2% |
    // | `skip d` | 3 | 0 on 60.0% |
    // | `failures` | 271 | 2 on 14.9% |
    //
    // - **`ran d` was a constant** — 7 on all but one row (the exception is
    //   `test_distribution_idonly.js`, 5 of 7 days), and a single distinct value
    //   inside each of `netwerk/test/unit` (412 rows), `toolkit/components/
    //   extensions/test/xpcshell` (371) and `dom/indexedDB/test/unit` (103).
    // - **`flaky%` was `flaky d` in other units** — exactly `100*flaky/ran` on
    //   every row, so over a constant denominator the two are 1:1, 8 distinct
    //   values each. A percentage needs a population to be a proportion of, and a
    //   single test is not one: it can only be 0% or 100%. **`flaky%` stays on the
    //   folder ranking**, where it is "of this folder's tests, what share were
    //   flaky" over a real population — the asymmetry is deliberate, so do not
    //   restore it here for consistency.
    // - **`verdict` was derivable** — `f(flaky>0, skip>0)` on every row, which the
    //   two verdict columns now print directly.
    // - **The day counts were the deeper mistake.** They came from multiplying a
    //   7-day *mean* back out by 7, and the mean itself was a folder concept
    //   pushed onto a single test. `flaky.html` never did this: its test rows come
    //   from `flakinessByFolder`, whose leaves are 0 or 1 (measured: two distinct
    //   values in each of `flaky`, `skipped`, `stable` across 4,807 leaves,
    //   `total` always 1). This view now reads the same derivation — see
    //   `listingTree` — so `7 of 7` to say "always" is gone along with the
    //   arithmetic that produced it.
    //
    // What survives, and why each earns a column on every row:
    //
    // - **`flaky` and `skipped`, 0 or 1**, exactly as the page shows them. Both,
    //   not one: the flaky-vs-skipped distinction is the entire reason this view
    //   exists rather than `fx-tests issues`, which let a skipped test top a list
    //   a reader would read as "most flaky". `1  1` is both, `0  1` is switched
    //   off rather than failing.
    // - **`failures`**, kept, because it is the only column with real resolution —
    //   272 distinct values up to 5,200 against 2 for each verdict — and the only
    //   thing separating "failed twice" from "failed 2,543 times". It is a count
    //   of *runs* over the file's whole window rather than of days in the scope,
    //   which is what made it read as a jumble beside three day-counts; with the
    //   day-counts gone it is the one number on the row, and its header names the
    //   window so the different unit is visible rather than implied.
    const sortColumn: Record<FlakySort, string> = {
        flaky: 'flaky',
        // `share` ranked a percentage that is gone from this view; it orders as
        // `flaky` here and keeps its own column on the folder views.
        share: 'flaky',
        skips: 'skipped',
        tests: `failures ${result.header.dayCount}d`,
        name: 'Test',
    };
    const column = (header: string, rest: Omit<Column, 'header'> = {}): Column => ({
        header,
        ...rest,
        ...(header === sortColumn[result.sort]
            ? { sort: result.sort === 'name' ? 'asc' : 'desc' }
            : {}),
    });
    const columns = [
        column('Test', { path: true }),
        column('flaky', { align: 'right' }),
        column('skipped', { align: 'right' }),
        column(`failures ${result.header.dayCount}d`, { align: 'right' }),
    ];
    return {
        preamble: headerLines(result),
        table: {
            columns,
            rows: result.rows.map((row) => [
                row.path,
                fmtCount(row.flaky),
                fmtCount(row.skipped),
                fmtCount(row.windowFailures),
            ]),
        },
        total: result.rowCount,
        shown: result.rows.length,
        epilogue: testEpilogue(result),
        empty: testEmptyMessage(result, alsoSearched),
    };
}

/**
 * Renders a suggested `fx-tests` invocation carrying the flags that reproduce
 * this run's context.
 *
 * A footer that prints a copy-pasteable command is promising the reader it
 * answers the question they are looking at. It did not: `fx-tests flaky
 * --harness mochitest` suggested `fx-tests flaky <directory>`, and because a
 * **directory** has no filename for `detectHarness()` to classify it falls
 * through to the xpcshell default — so the suggestion silently answered about
 * the wrong harness. `detectHarness` rescues the per-test footer, whose argument
 * is a file (`browser_*.js` infers mochitest), and cannot rescue the two
 * directory-argument ones. Rather than depend on which suggestions happen to
 * take a filename, every one of them goes through here.
 *
 * ## What is carried, and what is not
 *
 * - **`--harness`, only when it is not the default.** `--harness xpcshell` on
 *   the common path is noise on a footer that is already being trimmed for
 *   length, and xpcshell is what an omitted flag means anyway.
 * - **`--day`**, because it *is* the question, and every target accepts it: it
 *   is a global. A table classified on one day whose footer suggests a command
 *   reverting to the 7-day mean sends the reader to different numbers than the
 *   ones they picked a row from — the same mismatch `headerLines` names the
 *   window to prevent.
 * - **`--all-days`, `--average-days` and `--noise` only for `fx-tests flaky`**,
 *   which is the only command that has them. They are not globals: `skips` and
 *   `test` would reject them as unknown flags (`cli/args.ts` rejects rather than
 *   ignores), turning a suggestion into an error. `flakyScope` is the opt-in.
 * - **Not `--limit`, `--json`, `--markdown` or the cache flags.** They shape
 *   *this* rendering, not the question, and a reader who wants them still has
 *   them typed in their own scrollback.
 */
function suggestion(
    command: string,
    header: FlakyHeader,
    options: { readonly flakyScope?: boolean } = {}
): string {
    const flags: string[] = [];
    if (header.harness !== 'xpcshell') {
        flags.push(`--harness ${header.harness}`);
    }
    // Only a scope the reader actually asked for. The per-test listing's default
    // window is `scope: 'window'` and not `'day'` (`listingHeader`), so it never
    // reaches this branch — and naming its last date would both invent a flag the
    // reader never typed and pin a later run to today.
    if (header.scope === 'day' && header.scopeRequested) {
        flags.push(`--day ${header.scopeDates[0] ?? header.endDate}`);
    }
    if (options.flakyScope === true) {
        if (header.scope === 'all-days') {
            flags.push('--all-days');
        } else if (header.averageDays !== null && header.averageDays !== DEFAULT_AVERAGE_DAYS) {
            flags.push(`--average-days ${header.averageDays}`);
        }
        if (header.requestedMinWindowFailures !== DEFAULT_MIN_WINDOW_FAILURES) {
            flags.push(`--noise ${header.requestedMinWindowFailures}`);
        }
    }
    return flags.length === 0 ? command : `${command} ${flags.join(' ')}`;
}

/**
 * The clean-test note and the deep-dive command.
 *
 * `fx-tests test <path>` is the only per-test deep dive in the tool — it reads a
 * *bucket* file rather than `issues.json`, so it is the one command that can
 * break a single test down by configuration and show its failure messages, which
 * is the next thing a reader wants and is something this file cannot answer at
 * all (`issues.json` records no job names — see `loadFlakyQuery`'s refusal of
 * `--config`).
 */
function testEpilogue(result: TestResult): string[] {
    const lines: string[] = [];
    if (result.cleanTests > 0) {
        lines.push(
            `  ${fmtCount(result.cleanTests)} of ${fmtCount(result.consideredTests)} tests here ` +
                'passed everywhere they ran and are not listed. They are still in every count above.'
        );
    }
    const top = result.rows[0];
    if (top !== undefined) {
        if (lines.length > 0) {
            lines.push('');
        }
        lines.push(
            '  Next, for a test you pick:',
            // `fx-tests test` reads a bucket file rather than `issues.json` and
            // has none of this command's scope flags, so only the globals carry.
            // See `suggestion`.
            `    ${suggestion(`fx-tests test ${top.path}`, result.header)}` +
                '     # every config it ran on, and what it failed with'
        );
    }
    return lines;
}

/**
 * "4,911 tests in xpcshell-issues.json", naming every file this run read.
 *
 * Wraps `describeSearchedFiles` with this command's header and its count
 * formatter, so the three views cannot describe the same search differently.
 */
function searchedFiles(header: FlakyHeader, alsoSearched: readonly SearchedFile[]): string {
    return describeSearchedFiles(
        [{ harness: header.harness, testCount: header.testCount }, ...alsoSearched],
        fmtCount
    );
}

/** What to say when nothing under the path is worth listing. */
function testEmptyMessage(result: TestResult, alsoSearched: readonly SearchedFile[] = []): string {
    const { header } = result;
    const where = result.pathPrefix === null ? 'the tree' : result.pathPrefix;
    const over =
        header.scope === 'day'
            ? `on ${header.scopeDates[0] ?? header.endDate}`
            : header.scope === 'all-days'
              ? `over all ${header.dayCount} days`
              : `over the last ${header.scopeDates.length} days`;
    if (result.consideredTests === 0) {
        return (
            `No test ran under ${where} ${over}. Searched ` +
            `${searchedFiles(header, alsoSearched)}. Check the ` +
            'path (a directory prefix) for typos' +
            (result.hereOnly
                ? ', and note that --here-only needs the path to name a directory exactly — drop ' +
                  'it for the subtree.'
                : '.')
        );
    }
    return (
        `All ${fmtCount(result.consideredTests)} tests under ${where} passed everywhere they ran ` +
        `${over}, so there is nothing to list. Nothing is flaky and nothing is disabled here.`
    );
}

// --- the folder views ----------------------------------------------------

/** One row of the `list` or `folder` view. */
interface FolderRow {
    path: string;
    /** The flaky count this row is ranked and judged on. */
    flaky: number;
    /** The denominator of `flakyPercent`. */
    total: number;
    /** Tests skipped somewhere, overlapping `flaky` by `flakyAndSkipped`. */
    skipped: number;
    flakyAndSkipped: number;
    /** Test files behind `total`. */
    testCount: number;
    /**
     * The subtree's flaky count.
     *
     * Equal to `flaky` in the `folder` view by construction, and in the `list`
     * view on any folder with no subfolders — which is 246 of 250 on the pinned
     * window. Carried on every row anyway so `--json` has one shape, and printed
     * only where it says something.
     */
    subtreeFlaky: number;
    /** Rounded **once**, from the raw ratio. Double-rounding is a known defect. */
    flakyPercent: number;
    skippedPercent: number;
}

/**
 * The burndown rows: one per folder, counting only the tests directly in it.
 *
 * `selfSkipped` rather than the subtree's `skipped`, so every column on the row
 * describes the same population as the `flaky` column it sits next to.
 */
function listRows(root: FolderNode): FolderRow[] {
    return folderList(root).map((row: FolderListRow) => ({
        path: row.path,
        flaky: row.selfFlaky,
        total: row.selfTotal,
        skipped: row.selfSkipped,
        flakyAndSkipped: row.selfFlakyAndSkipped,
        testCount: row.selfTestCount,
        subtreeFlaky: row.flaky,
        flakyPercent: ratio(row.selfFlaky, row.selfTotal),
        skippedPercent: ratio(row.selfSkipped, row.selfTotal),
    }));
}

/**
 * The subtree roll-up: one row per folder, counting everything beneath it.
 *
 * The tree view flattened rather than drawn. A terminal cannot be drilled, and
 * indenting 250 rows of a 6-deep tree produces something less readable than the
 * paths themselves — which are already the tree, written down.
 */
function treeRows(root: FolderNode): FolderRow[] {
    const rows: FolderRow[] = [];
    const visit = (node: FolderNode): void => {
        if (node.path !== '') {
            rows.push({
                path: node.path,
                flaky: node.flaky,
                total: node.total,
                skipped: node.skipped,
                flakyAndSkipped: node.flakyAndSkipped,
                testCount: node.testCount,
                subtreeFlaky: node.flaky,
                flakyPercent: ratio(node.flaky, node.total),
                skippedPercent: ratio(node.skipped, node.total),
            });
        }
        for (const child of node.children) {
            visit(child);
        }
    };
    visit(root);
    return rows;
}

/** A percentage from the raw counts, unrounded. The formatter rounds, once. */
function ratio(part: number, whole: number): number {
    return whole > 0 ? (part / whole) * 100 : 0;
}

/**
 * Whether two counts differ by enough to be worth showing as different.
 *
 * `!==` is wrong under the averaged scope and wrong in a way that looks like a
 * feature: `folderList` re-sums per-leaf means, so a folder with no subfolders at
 * all comes out with a subtree total differing from its own by ~1e-14, and the
 * `+subtree` column — which should appear on 4 of 250 rows — printed on all of
 * them. The tolerance is far below the smallest real difference, which is one
 * test-day, or `1/averageDays` ≥ 1/21.
 */
function differs(a: number, b: number): boolean {
    return Math.abs(a - b) > 1e-6;
}

/**
 * A per-day mean, with one decimal — but only where the decimal says something.
 *
 * A mean that is a whole number to within the tolerance is printed as one. That is
 * not cosmetic tidying: skip annotations barely move day to day, so the skip column
 * is exactly integral on almost every row, and printing `131.0` there put a decimal
 * point on 250 rows to signal a fractionality that column does not have. The
 * decimal is the signal that a number is a mean, so it has to be spent where it is
 * true — `187.0` for a flaky count that really is 1,309/7.
 *
 * Rounded **once** from the raw mean. The share column is computed from the same
 * unrounded numbers, so it cannot disagree with its own numerator.
 */
function mean(value: number): string {
    const whole = Math.abs(value - Math.round(value)) <= 1e-6;
    return value.toLocaleString('en-US', {
        minimumFractionDigits: whole ? 0 : 1,
        maximumFractionDigits: whole ? 0 : 1,
    });
}

/**
 * Ranks folder rows.
 *
 * `flaky` is the default and ranks on the count, not the share, for the reason
 * `sortTree()` gives: a folder holding one test that failed is 100% flaky and is
 * not where to start. `--sort share` is there for the reader who has already
 * decided how much time they have.
 */
function sortRows(rows: readonly FolderRow[], sort: FlakySort): FolderRow[] {
    const sorted = [...rows];
    const byPath = (a: FolderRow, b: FolderRow): number => a.path.localeCompare(b.path);
    switch (sort) {
        case 'flaky':
            sorted.sort((a, b) => b.flaky - a.flaky || byPath(a, b));
            break;
        case 'share':
            sorted.sort((a, b) => b.flakyPercent - a.flakyPercent || byPath(a, b));
            break;
        case 'skips':
            sorted.sort((a, b) => b.skipped - a.skipped || byPath(a, b));
            break;
        case 'tests':
            sorted.sort((a, b) => b.testCount - a.testCount || byPath(a, b));
            break;
        case 'name':
            sorted.sort(byPath);
            break;
    }
    return sorted;
}

/** The `--json` shape of the folder views. */
interface FolderResult {
    header: FlakyHeader;
    groupBy: 'list' | 'folder';
    sort: FlakySort;
    pathPrefix: string | null;
    allDays: boolean;
    /** The whole selection's counts — the root node's. */
    totals: {
        flaky: number;
        stable: number;
        skipped: number;
        flakyAndSkipped: number;
        total: number;
        testCount: number;
    };
    rowCount: number;
    rows: FolderRow[];
}

/** Renders a folder view. */
function renderFolders(
    result: FolderResult,
    /** The other aggregates this run read. See `emptyMessage`. */
    alsoSearched: readonly SearchedFile[] = []
): Rendered {
    // `--sort share` still selects the `flaky%` column: the flag is an input a
    // script may have written down, the header is prose for a reader, and only
    // the header was unclear. Renaming both would have broken the first to fix
    // the second.
    const sortColumn: Record<FlakySort, string> = {
        flaky: 'flaky',
        share: 'flaky%',
        skips: 'skip',
        tests: 'tests',
        name: 'Folder',
    };
    const column = (header: string, rest: Omit<Column, 'header'> = {}): Column => ({
        header,
        ...rest,
        ...(header === sortColumn[result.sort]
            ? { sort: result.sort === 'name' ? 'asc' : 'desc' }
            : {}),
    });
    // Printed only when at least one row has more below it, so the common case
    // — a leaf directory, 246 of 250 on the pinned window — does not carry a
    // column of repeated numbers.
    const anySubtree = result.rows.some((row) => differs(row.subtreeFlaky, row.flaky));
    // Averaged counts are means per day and are fractional; a single day's and
    // the window's are counts of test files. Printing `187.0` under the average
    // and `208` under `--day` is the cheapest available signal that the two
    // columns are not the same quantity.
    const num = result.header.scope === 'average' ? mean : fmtCount;
    const columns = [
        column('Folder', { path: true }),
        column('flaky', { align: 'right' }),
        // `flaky%` rather than `share`: it is `flaky / tests`, and it sits
        // between the two columns it is the ratio of, which `share` did not say
        // and was read as a share of the row's issues instead.
        column('flaky%', { align: 'right' }),
        column('skip', { align: 'right' }),
        column('tests', { align: 'right' }),
        // `+subtree` rather than `in tree`: the `+` says it is this row's number
        // *plus what is below it*, which is the one thing the column means and
        // the one thing "in tree" left a reader to guess.
        ...(anySubtree ? [{ header: '+subtree', align: 'right' as const }] : []),
    ];
    return {
        preamble: headerLines(result),
        table: {
            columns,
            rows: result.rows.map((row) => [
                row.path,
                num(row.flaky),
                percent(row.flakyPercent),
                num(row.skipped),
                // Always an integer: `testCount` is test files, which does not
                // become fractional just because the states above it did.
                fmtCount(row.testCount),
                ...(anySubtree ? [differs(row.subtreeFlaky, row.flaky) ? num(row.subtreeFlaky) : ''] : []),
            ]),
        },
        total: result.rowCount,
        shown: result.rows.length,
        epilogue: epilogueFor(result),
        empty: emptyMessage(result, alsoSearched),
    };
}

/**
 * The next command to run, which is the point of printing a ranking at all.
 *
 * `CLI.md`'s "answers, not dumps": a reader who has picked a folder should not
 * have to work out what to type next. Named against the top row rather than left
 * generic, so it is copy-pasteable — the same treatment `crashes --minidumps`
 * gives its `fx-tests crash` lines.
 *
 * **This used to suggest `fx-tests issues --path <folder>`, and that was wrong.**
 * `issues` ranks by issue *runs*, which skips dominate: measured on the pinned
 * window for `toolkit/components/telemetry/tests/unit`,
 * `issues --group-by test` puts `test_UserInteraction_annotations.js` first with
 * 6,879 issues of which 6,782 are skips, and this classification calls that test
 * skipped and not flaky. A footer sending a reader from a flakiness ranking to a
 * differently-defined listing of the same folder is worse than no footer, so it
 * points at `--group-by tests`, which is this command's own definition one level
 * down.
 *
 * The `skips` line is kept: it answers a question this command does not, which is
 * *why* something is disabled (`skips` prints the `skip-if` condition, which
 * `issues.json`'s classification here reduces to a boolean).
 */
function epilogueFor(result: FolderResult): string[] {
    const top = result.rows[0];
    if (top === undefined) {
        return [];
    }
    // Both arguments here are **directories**, which is what made the missing
    // `--harness` a silent wrong answer rather than a cosmetic omission:
    // `detectHarness()` classifies on a filename, a directory has none, and it
    // defaults to xpcshell. See `suggestion`.
    return [
        `  Next, for the folder you pick:`,
        `    ${suggestion(`fx-tests flaky ${top.path}`, result.header, { flakyScope: true })}` +
            '     # which tests, flaky ones first',
        `    ${suggestion(`fx-tests skips --path ${top.path}`, result.header)}` +
            '      # what is already disabled there, and why',
    ];
}

// --- the trend view ------------------------------------------------------

/** One row of `--group-by days`. */
interface TrendRow {
    date: string;
    day: number;
    flaky: number;
    stable: number;
    skipped: number;
    total: number;
    flakyPercent: number;
    /** The centred 7-day mean, or `null` where there is no measurement. */
    average: number | null;
}

/** The `--json` shape of the trend view. */
interface TrendResult {
    header: FlakyHeader;
    groupBy: 'days';
    pathPrefix: string | null;
    averageWindow: number;
    rowCount: number;
    rows: TrendRow[];
    /**
     * Test-days over the **whole** window, before `--since` and `--limit`.
     *
     * `rows` is the printed tail; this is the population behind it, which is what
     * "did this harness run anything under the path" has to be asked of. The two
     * differ whenever the tail is shorter than the window, and a folder that ran
     * early and stopped is exactly the case where they disagree.
     */
    testDays: number;
}

/**
 * The per-day series.
 *
 * Kept because it is the one view whose numbers a folder ranking cannot imply:
 * it says whether the folder you are about to fix is getting worse or was always
 * like this. It is a table of numbers rather than a drawing — `CLI.md` §Non-goals
 * rules out chart rendering, and no `cli/format/` module has a sparkline to
 * reuse.
 *
 * `--since n` filters the series to its last `n` days, which is a filter on a
 * computed series and not a different classification: each day is still
 * classified on its own runs, and the noise filter still judges "one unlucky
 * run" against the whole 21 days. Narrowing what is *printed* cannot change
 * that, and must not appear to.
 */
function trendResult(query: FlakyQuery, context: CommandContext, limit: number): TrendResult {
    const series = flakinessOverTime(query.file, {
        minWindowFailures: query.header.requestedMinWindowFailures,
        ...(query.pathPrefix === undefined ? {} : { pathPrefix: query.pathPrefix }),
    });
    const average = runningAverage(series.days, TREND_WINDOW);
    let rows: TrendRow[] = series.days.map((day: FlakyDay, index: number) => ({
        date: day.date,
        day: day.day,
        flaky: day.flaky,
        stable: day.stable,
        skipped: day.skipped,
        total: day.total,
        flakyPercent: ratio(day.flaky, day.total),
        average: average[index] ?? null,
    }));
    if (context.globals.since !== undefined) {
        rows = rows.slice(Math.max(0, rows.length - context.globals.since));
    }
    // Oldest-first, as the files encode it and the charts plot it. The limit
    // therefore keeps the **newest** rows: a truncated calendar that dropped
    // today would answer "how is it now" with last fortnight.
    const shown = limit === 0 ? rows : rows.slice(Math.max(0, rows.length - limit));
    return {
        header: query.header,
        groupBy: 'days',
        pathPrefix: query.pathPrefix ?? null,
        averageWindow: TREND_WINDOW,
        rowCount: rows.length,
        rows: shown,
        // Summed over `rows`, never `shown`: see `TrendResult.testDays`.
        testDays: rows.reduce((sum, row) => sum + row.total, 0),
    };
}

/** Renders the trend table. */
function renderTrend(
    result: TrendResult,
    /** The other aggregates this run read. See `describeSearchedFiles`. */
    alsoSearched: readonly SearchedFile[] = []
): Rendered {
    const lines = headerLines(result);
    return {
        preamble: lines,
        table: {
            columns: [
                { header: 'Date', sort: 'asc' },
                { header: 'flaky', align: 'right' },
                { header: 'stable', align: 'right' },
                { header: 'skipped', align: 'right' },
                { header: 'total', align: 'right' },
                { header: 'flaky%', align: 'right' },
                { header: `${result.averageWindow}d avg`, align: 'right' },
            ],
            rows: result.rows.map((row) => [
                dateWithWeekday(row.date),
                fmtCount(row.flaky),
                fmtCount(row.stable),
                fmtCount(row.skipped),
                fmtCount(row.total),
                percent(row.flakyPercent),
                percent(row.average),
            ]),
        },
        total: result.rowCount,
        shown: result.rows.length,
        epilogue: [
            '  --group-by list ranks the folders behind these numbers.',
        ],
        empty:
            'No day had any test run. Searched ' +
            searchedFiles(result.header, alsoSearched) +
            ` over ${result.header.startDate} … ${result.header.endDate}. ` +
            'Check --path (a directory prefix) for typos.',
    };
}

// --- shared header and epilogue -----------------------------------------

/**
 * The provenance lines every view prints.
 *
 * ## Only what varies between two invocations
 *
 * This block used to open every run with the standing definitions — what "flaky"
 * means, what "skipped" means, why the window is a whole number of weeks, that
 * the flaky and skip columns overlap. Measured on the pinned window,
 * `flaky --limit 5` was 24 lines of which **13 were preamble** (955 characters,
 * ~238 tokens) before the reader reached a number, against 4 lines for
 * `issues --limit 5`. A primary consumer of this CLI is an agent, which pays
 * that on every invocation and needs the explanation at most once, so the
 * standing definitions moved to `flaky --help` (`FLAKY_NOTES`) and `docs/CLI.md`.
 *
 * What stays is what a reader cannot recover from the digits in front of them,
 * and each line here is one a wrong reading of would be a factor-of-several
 * error:
 *
 * - **which window produced the table.** `flaky.html` shipped a bug where the
 *   tiles showed one day above a table showing 21 with nothing saying so; naming
 *   the window in both places was the fix, and dropping it here would recreate
 *   it. The three scopes read 48%, 53% and 75% on the same folder.
 * - **the harness, the file's window and its test count** — the first line,
 *   which every command in this tool opens with.
 * - **how many tests the noise filter neutralised**, when it neutralised any,
 *   because that changes every count below it. Silent when it neutralised none:
 *   "0 tests neutralised" is a line that cannot change a reading.
 * - **which selection ran** on the per-test view, since on 4 of 250 pinned
 *   folders `--here-only` and the subtree differ and the tables look alike.
 */
function headerLines(result: FolderResult | TrendResult | TestResult): string[] {
    const { header } = result;
    const lines: string[] = [];
    const subject =
        result.groupBy === 'days'
            ? 'flakiness by day'
            : result.groupBy === 'tests'
              ? 'flaky tests, by test file'
              : result.groupBy === 'list'
                ? 'flaky tests by folder'
                : 'flaky tests by folder subtree';
    lines.push(
        `${header.harness} ${subject} — ${header.dayCount} days ` +
            `(${dateWithWeekday(header.startDate)} … ${dateWithWeekday(header.endDate)}), ` +
            `${fmtCount(header.testCount)} tests in the file`
    );
    // Which selection ran, said in the header rather than left to the flag the
    // reader typed: on 4 of 250 pinned folders `--here-only` and the subtree
    // differ, and a listing that silently answered the other question would look
    // exactly like this one.
    if (result.groupBy === 'tests') {
        if (result.pathPrefix !== null) {
            lines.push(
                result.hereOnly
                    ? `Test files directly in ${result.pathPrefix}, not its subfolders (--here-only).`
                    : `Test files under ${result.pathPrefix} and its subfolders.`
            );
        }
    } else if (result.pathPrefix !== null) {
        lines.push(`Under ${result.pathPrefix} only.`);
    }

    // Which window produced the table. Non-negotiable, and the one caveat that
    // survives on every view: `flaky.html` shipped tiles showing one day above a
    // table showing 21 with nothing saying so. What each window *means* is in
    // `flaky --help`; this only has to name the one that ran.
    if (result.groupBy === 'days') {
        // Nothing to say: the Date column is the window, one row per day.
    } else if (header.scope === 'all-days') {
        lines.push(
            `Window: --all-days — one verdict over all ${header.dayCount} days, flaky if flaky ` +
                'on ANY of them. A much looser bar than the default (see --help).'
        );
    } else if (header.scope === 'window') {
        // The per-test listing's default: the same days the ranking averages, but
        // one verdict per test rather than a mean, so a reader drilling into a row
        // stays inside the window it was scored over. The second sentence is what
        // stops the two numbers reading as a contradiction — the ranking says 26.7
        // for toolkit/components/telemetry/tests/unit and this lists 32, because a
        // mean per day and a count of distinct tests are different quantities over
        // the same seven days.
        const first = header.scopeDates[0] ?? header.startDate;
        const last = header.scopeDates[header.scopeDates.length - 1] ?? header.endDate;
        lines.push(
            `Window: the ranking's ${header.scopeDates.length} days ${first} … ${last}, one ` +
                'verdict per test, flaky if flaky on ANY of them — so more tests than the ' +
                'ranking\'s mean per day (--day, --all-days).'
        );
    } else if (header.scope === 'day') {
        // One day, because --day named it. The per-test listing no longer lands
        // here by default: it used to, by omitting a window option entirely, and
        // that is the bug — measured on the pinned file for
        // toolkit/components/telemetry/tests/unit it listed 29 flaky tests under a
        // ranking that had scored 32 over 7 days. See `listingTree`.
        const date = dateWithWeekday(header.scopeDates[0] ?? header.endDate);
        lines.push(
            result.groupBy === 'tests'
                ? `Window: ${date} alone, one verdict per test (--all-days for the whole file).`
                : `Window: --day ${date} alone, which is partly a fact about the weekday ` +
                  '(see --help).'
        );
    } else {
        const first = header.scopeDates[0] ?? header.startDate;
        const last = header.scopeDates[header.scopeDates.length - 1] ?? header.endDate;
        lines.push(
            `Window: mean per day over the ${header.averageDays ?? 0} days ${first} … ${last}.`
        );
    }

    if (header.noiseFilterSkipped) {
        // Stated, not silently dropped. `MIN_FILTERABLE_DAYS`: on a one-day
        // file the same threshold neutralised 366 tests and reported 562 flaky
        // where the 21-day window reads 923 for the same date.
        lines.push(
            `--noise ${header.requestedMinWindowFailures} was NOT applied: this file covers ` +
                `fewer than ${MIN_FILTERABLE_DAYS} days, and "did this fail more than once in ` +
                'the window" cannot be judged from one day. The counts below are unfiltered.'
        );
    } else if (header.minWindowFailures > 0 && header.neutralisedTests > 0) {
        // Only when it changed something. A filter that neutralised nothing
        // cannot change a reading, and saying so on every run is the bloat this
        // block was trimmed for; `--json`'s `neutralisedTests` still reports 0.
        lines.push(
            `Noise filter neutralised ${fmtCount(header.neutralisedTests)} tests failing ` +
                `${header.minWindowFailures} time${header.minWindowFailures === 1 ? '' : 's'} ` +
                `or fewer in ${header.dayCount} days (--noise 0 disables).`
        );
    } else if (header.minWindowFailures === 0) {
        // The opposite direction, and it does change the numbers: every
        // one-off failure is being counted as flakiness.
        lines.push('Noise filter off (--noise 0): a single failure counts as flaky.');
    }
    return lines;
}

/**
 * The width the text renderer wraps preamble prose to.
 *
 * The caveats are built as whole sentences rather than pre-broken lines, because
 * the two renderers want opposite things from them: the text one wants them
 * wrapped and indented for a terminal, and Markdown wants each to be one
 * paragraph. Hard-wrapping at source gave Markdown one paragraph *per line* — an
 * eight-line caveat became eight blank-line-separated fragments — so the wrapping
 * happens here, at the only place that wants it.
 */
const WRAP_WIDTH = 96;

/** Wraps a caveat to `WRAP_WIDTH`, indented under the heading. */
function wrapCaveat(text: string, indent = '  '): string[] {
    const words = text.split(' ');
    const out: string[] = [];
    let line = '';
    for (const word of words) {
        const candidate = line === '' ? word : `${line} ${word}`;
        if (`${indent}${candidate}`.length > WRAP_WIDTH && line !== '') {
            out.push(`${indent}${line}`);
            line = word;
        } else {
            line = candidate;
        }
    }
    if (line !== '') {
        out.push(`${indent}${line}`);
    }
    return out;
}

/** What to say when the selection is empty. */
function emptyMessage(result: FolderResult, alsoSearched: readonly SearchedFile[] = []): string {
    const { header } = result;
    const over =
        header.scope === 'day'
            ? `on ${header.scopeDates[0] ?? header.endDate}`
            : header.scope === 'all-days'
              ? `over all ${header.dayCount} days`
              : `over the last ${header.averageDays ?? 0} days`;
    return (
        `No folder matched. Searched ${searchedFiles(header, alsoSearched)}, ` +
        `classified ${over}. ` +
        'Check --path (a directory prefix) for typos — and note that a folder whose tests did ' +
        'not run at all in that window has no row, since it has no rate.'
    );
}

// --- option reading ------------------------------------------------------

function readGroupBy(args: ParsedArgs): FlakyGroupBy {
    // A positional path *is* the per-test view — see `runFlaky`. Defaulting here
    // rather than at the call site keeps "which view" one decision, so the
    // positional and the flag cannot be resolved to different answers.
    const fallback = args.positionals.length > 0 ? 'tests' : 'list';
    const value = stringOption(args, 'group-by') ?? fallback;
    if (value !== 'list' && value !== 'folder' && value !== 'days' && value !== 'tests') {
        throw usageError(
            `--group-by expects one of list, folder, days, tests, got "${value}"`,
            'list ranks folders by their own flaky tests (the burndown view); folder rolls ' +
                'subtrees up; days is the trend; tests lists the individual test files under a ' +
                'path.'
        );
    }
    return value;
}

function readSort(args: ParsedArgs): FlakySort {
    const value = stringOption(args, 'sort') ?? 'flaky';
    const allowed: FlakySort[] = ['flaky', 'share', 'skips', 'tests', 'name'];
    if (!(allowed as string[]).includes(value)) {
        throw usageError(`--sort expects one of ${allowed.join(', ')}, got "${value}"`);
    }
    return value as FlakySort;
}

// --- rendering plumbing --------------------------------------------------

/** What a view produces, before it is laid out. Mirrors `issues.ts`. */
interface Rendered {
    preamble: string[];
    table: { columns: Column[]; rows: string[][] } | null;
    total: number;
    shown: number;
    epilogue: string[];
    empty: string;
}

/**
 * How many decimals a `--json` mean carries.
 *
 * Four, which is three more than anything is printed to and far more than the
 * data supports — the point is not precision but *stability*. The averages are
 * sums of `1/windowDays`, so a folder whose 187 tests are flaky every day comes
 * out as `186.99999999999858`, and emitting that raw makes `--json` a shape whose
 * digits change with the iteration order. A consumer diffing two runs would see
 * churn that is not in the data, and `CLI.md` promises a stable shape.
 *
 * The text renderer is deliberately **not** routed through this: it rounds from
 * the raw value to one decimal, once. Rounding to 4 and then to 1 would be the
 * double-rounding this repo already has a recorded defect for.
 */
const JSON_DECIMALS = 4;

/**
 * Rounds every number in a result for `--json`, leaving integers alone.
 *
 * Applied at the emit boundary and nowhere else, so the ranking, the percentages
 * and the text output are all computed from the unrounded values.
 */
function roundForJson(value: unknown): unknown {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? value : Number(value.toFixed(JSON_DECIMALS));
    }
    if (Array.isArray(value)) {
        return value.map(roundForJson);
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
                key,
                roundForJson(entry),
            ])
        );
    }
    return value;
}

/** Emits in whichever format was asked for. */
function emitResult<T>(context: CommandContext, result: T, build: (result: T) => Rendered): void {
    if (context.globals.format === 'json') {
        emit(context, toJson(roundForJson(result)));
        return;
    }
    const content = build(result);
    emit(
        context,
        context.globals.format === 'markdown' ? renderMarkdownFrom(content) : renderTextFrom(content)
    );
}

/** Plain text: the shared aligned-column layout. */
function renderTextFrom(content: Rendered): string {
    // The heading is one line by construction; every caveat after it is a whole
    // sentence and is wrapped here. See `wrapCaveat`.
    const [heading, ...caveats] = content.preamble;
    const lines: (string | null)[] = [
        heading ?? '',
        ...caveats.flatMap((caveat) => wrapCaveat(caveat)),
        '',
    ];
    if (content.table === null || content.table.rows.length === 0) {
        lines.push(content.empty);
    } else {
        lines.push(...tableSection(content.table.columns, content.table.rows, content));
    }
    lines.push('');
    lines.push(...content.epilogue);
    return joinLines(lines);
}

/** Markdown: a real table, as every other command emits. */
function renderMarkdownFrom(content: Rendered): string {
    const lines: (string | null)[] = [];
    const [heading, ...caveats] = content.preamble;
    lines.push(md.heading(heading ?? 'Flakiness', 1));
    lines.push('');
    for (const caveat of caveats) {
        lines.push(caveat.trim());
        lines.push('');
    }
    if (content.table === null || content.table.rows.length === 0) {
        lines.push(content.empty);
    } else {
        lines.push(...md.table(content.table.columns, content.table.rows));
        lines.push(md.moreLine(content.total, content.shown));
    }
    if (content.epilogue.length > 0) {
        lines.push('');
        for (const line of content.epilogue) {
            lines.push(line.trim());
        }
    }
    return joinLines(lines);
}
