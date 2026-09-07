/**
 * `fx-tests intermittent` — the sheriff-annotated top offenders, tree-wide.
 *
 * Every other view in this CLI is scoped by path, component or push and reads a
 * nightly aggregate. This one is tree-wide and reads a live API, so its rows are
 * *annotations* rather than failures: a failure nobody triaged has no row. It
 * ranks what costs sheriffs time; `issues` and `flaky` rank what fails most.
 *
 * The ranking API has no harness parameter, so `--harness` is a client-side scan
 * at one request per candidate bug — see `lib/query/intermittents.ts`. The list
 * is therefore a prefix of the ranking, and every run prints its own depth.
 */

import type { OptionSpecs, ParsedArgs } from '../args.ts';
import { boolOption, numberOption, stringOption } from '../args.ts';
import { type CommandContext, emit, progress, warn } from '../context.ts';
import { notFoundError, upstreamError, usageError } from '../errors.ts';
import * as md from '../format/markdown.ts';
import { toJson } from '../format/json.ts';
import {
    type Column,
    applyLimit,
    count as fmtCount,
    dateWithWeekday,
    joinLines,
    renderWidth,
    table,
    fitLine,
    tableSection,
    truncate,
    wrapText,
} from '../format/text.ts';
import {
    type BugOccurrence,
    type DayRange,
    IntermittentsError,
    type IntermittentsClient,
    TREE_GROUPS,
} from '../../lib/sources/intermittents.ts';
import {
    type BugDrilldown,
    type DrilldownFilter,
    type HarnessOfPath,
    type HarnessSelector,
    type OccurrenceDay,
    type OccurrenceProfiles,
    type RankedIntermittent,
    type ScanHarness,
    type ScanResult,
    type SuiteCount,
    bugsNamingTest,
    filterOccurrences,
    occurrenceHistory,
    occurrenceProfiles,
    scanBugs,
    selectHarness,
    summariseBug,
} from '../../lib/query/intermittents.ts';
import { type IssuesFile } from '../../lib/formats/issues.ts';
import { collectTestPaths } from '../../lib/query/test-lookup.ts';
import { fetchJson, timingsIndex } from '../../lib/sources/source.ts';

/** The default number of ranked rows, matching the other tree-wide commands. */
export const DEFAULT_LIMIT = 20;

/**
 * How many days the window covers when `--since` and `--day` are both absent.
 *
 * Seven, for the reason `fx-tests summary` gives: push volume drops
 * several-fold at weekends, so a window that is not a whole number of weeks
 * ranks a different weekday mix each time it is run.
 */
export const DEFAULT_DAYS = 7;

/**
 * How wide the `test` column may get.
 *
 * A `truncate()` budget, so it is stated against the 90-column baseline and
 * scaled to the real terminal — not an absolute width. Together with
 * `FAILURE_WIDTH` and the two numeric columns it has to *add up* to that
 * baseline: budgets that each nearly fill the width produce a line twice the
 * width, which is what put this table at 162 characters on an 80-column
 * terminal. The two numeric columns and the gaps take 22 of the 90, leaving 68
 * for these two.
 *
 * Measured over a live 731-row window: a test path has a p90 of 86 characters
 * and a failure message a p90 of 158, so neither column fits its content at any
 * split and `fitToWidth` shaves the rest. What the split decides is which one
 * degrades first.
 *
 * 36/32 rather than the p90-proportional 24/44, because the two columns fail
 * differently. The path is front-truncated (`path: true`) to save the basename,
 * which is the copyable part: at 36 a basename survives whole on 62% of path
 * rows, against 19% at 24. The failure message is prose read left to right, so
 * a cut tail costs the least-important words. Hence the path gets more than its
 * p90 share and the message a little less.
 */
export const MIXED_CELL_WIDTH = 36;

/** The `failure` column's budget. See `MIXED_CELL_WIDTH`. */
export const FAILURE_WIDTH = 32;

/**
 * How many rows each of `--bug`'s sections shows by default.
 *
 * Lower than `DEFAULT_LIMIT`: the drill-down prints six sections at once, so
 * twenty each would be 120 lines. `--limit` applies to every section.
 */
export const DRILLDOWN_ROWS = 10;

/** Options `intermittent` adds to the globals. */
export const INTERMITTENT_OPTIONS: OptionSpecs = {
    // Two globals whose shared wording is wrong here, restated rather than left
    // to mislead. A command's own spec wins the merge in `dispatch()`, so this
    // is the supported way to say what the flag means for this command — the
    // same rule as declaring a global rejected, applied to a flag that works but
    // works differently.
    harness: {
        type: 'string',
        placeholder: '<mochitest|xpcshell|unknown>',
        describe:
            'Rank only bugs naming a test of this harness. `unknown` is the bugs naming no ' +
            'known test. Omit for all three.',
    },
    day: {
        type: 'string',
        placeholder: '<date>',
        describe: 'One day, YYYY-MM-DD. No today/yesterday: this is a live API, not the published window.',
    },
    since: {
        type: 'number',
        placeholder: '<n>',
        describe: 'The last n days, ending today (UTC). Default 7.',
    },
    tree: {
        type: 'string',
        placeholder: '<name>',
        describe: 'Repository, repo group (trunk, firefox-releases, comm-releases) or all. Default trunk.',
    },
    bug: {
        type: 'number',
        placeholder: '<id>',
        describe: 'Drill into one bug: its occurrences, platforms, task ids and log lines.',
    },
    // `--test`, not `--path`: on this command it selects one bug, which is what
    // `try --test` and `errors --test` do, where `--path <prefix>` filters many
    // tests on `issues`, `failures`, `crashes`, `skips` and `flaky`.
    test: {
        type: 'string',
        placeholder: '<path>',
        describe:
            'Drill into the bug annotated on this exact test path, instead of --bug. Lists them ' +
            'all when several bugs name it.',
    },
    profiles: {
        type: 'boolean',
        describe:
            'With --bug or --test, print the raw per-test profile artifact URL of every ' +
            'occurrence whose log named one.',
    },
    // Named after `test --history`, which prints the same shape from the
    // nightly aggregates: one flag name for "break the window down by day",
    // whichever command the caller reached it from.
    history: {
        type: 'boolean',
        describe:
            'With --bug or --test, print annotations per day over the window, zero days ' +
            'included.',
    },
};

/**
 * The standing definitions, printed by `--help` rather than on every run.
 *
 * Same reasoning as `FLAKY_NOTES`: none of it varies between invocations, and
 * the primary consumer is an agent that would pay for it every time.
 */
export const INTERMITTENT_NOTES: readonly string[] = [
    'What a row is:',
    '  One bug a sheriff attached to failing jobs, and how many jobs. These are human',
    '  judgements, not computed rates: a failure nobody triaged has no row here. So',
    '  this ranks what is costing sheriffs time; `fx-tests issues` and `fx-tests flaky`',
    '  rank what fails most.',
    '',
    'How a bug is placed:',
    '  Treeherder ranks bugs with no harness parameter, so a bug counts as a mochitest',
    '  (or xpcshell) bug when its summary names a test path that harness\'s data holds —',
    '  the same test lists `fx-tests test` resolves against. A bug naming no test this',
    '  tool knows is `unknown`: an infrastructure failure, a suite this tool does not',
    '  read, or a summary that never named a path.',
    '',
    '  With no --harness every annotated bug is ranked together, which is the whole',
    '  picture. --harness mochitest, xpcshell or unknown ranks one group of it.',
    '',
    '  Every bug in the window is classified — there is no per-bug request to economise',
    '  on — so the ranking is complete. --limit sets how many rows print, and --json',
    '  prints them all. Use `fx-tests test <path>` to dig into one of the tests named.',
    '',
    'The window:',
    '  --day <date> is one day, --since <n> the last n days ending today (UTC), default',
    '  7. Unlike everywhere else in this CLI there is no published window and no',
    '  "today"/"yesterday" keyword — this is a live API, not the nightly aggregates.',
];

/** The `--json` shape for the ranked list. */
export interface IntermittentListJson {
    /** The `--harness` selection, or `null` when every bug is ranked. */
    harness: HarnessSelector | null;
    tree: string;
    startday: string;
    endday: string;
    /** How the whole window classified, whatever `harness` selected. */
    coverage: ScanCoverageJson;
    /** How many rows the selection holds. `rows` is always this long. */
    matchCount: number;
    rows: RankedIntermittent[];
}

/** Re-exported so the JSON shape is one type rather than a structural copy. */
export type ScanCoverageJson = ScanResult['coverage'];

/** The `--json` shape for `--bug`. */
export interface IntermittentBugJson extends BugDrilldown {
    tree: string;
    startday: string;
    endday: string;
    /**
     * The Bugzilla summary, which is not the observed failure.
     *
     * `bugSummary` and not `summary`, because the ranking rows carry a
     * `failure` parsed out of this same string and a reader who found one under
     * the other name read the two as the same field. It describes the failure
     * the day the bug was filed; what the annotated jobs printed is in `lines`.
     */
    bugSummary: string | null;
    /** Every occurrence, always in full. */
    occurrenceRows: BugOccurrence[];
    /**
     * Annotations per day over the window, zero days included.
     *
     * Unconditional, like `profiles` and for the same reason: it is computed
     * from `occurrenceRows`, costs no request, and a machine-readable shape
     * whose fields depend on a flag is what `--json` exists to avoid.
     */
    history: OccurrenceDay[];
    /**
     * The per-test profile URLs, unconditionally.
     *
     * Not behind `--profiles`: they cost no request, and a machine-readable
     * shape whose fields depend on a flag is the thing `--json` exists to avoid.
     * Empty when no occurrence's log named a profile.
     */
    profiles: OccurrenceProfiles[];
}

/** Runs the command. */
export async function runIntermittent(context: CommandContext, args: ParsedArgs): Promise<void> {
    if (args.positionals.length > 0) {
        throw usageError(
            `intermittent takes no arguments, got "${args.positionals[0]}"`,
            'Use --bug <id> to drill into one bug, or no argument for the ranked list.'
        );
    }
    const client = context.intermittents;
    if (client === undefined) {
        throw new Error('intermittent requires an intermittents client');
    }

    const { globals } = context;
    const tree = stringOption(args, 'tree') ?? 'trunk';
    const range = resolveRange(globals.day, globals.since);

    const bug = numberOption(args, 'bug');
    const test = stringOption(args, 'test');
    if (bug !== undefined && test !== undefined) {
        throw usageError(
            '--bug and --test both select one bug, so only one of them can be given',
            'Use --test <path> when you have a failing test and no bug number, --bug <id> otherwise.'
        );
    }
    if (bug !== undefined) {
        await runDrilldown(context, client, tree, range, bug, args);
        return;
    }
    if (test !== undefined) {
        await runTestDrilldown(context, client, tree, range, test, args);
        return;
    }
    if (boolOption(args, 'profiles')) {
        // The ranked list's rows are bugs, and a profile belongs to one job of
        // one occurrence. There is nothing here to print URLs for.
        throw usageError(
            '--profiles needs one bug: the ranked list’s rows are bugs, and a profile is an ' +
                'artifact of a single job',
            'Use --bug <id> --profiles, or --test <path> --profiles.'
        );
    }
    if (boolOption(args, 'history')) {
        // Same reason `--profiles` is refused here: the ranked list's rows are
        // bugs, and "annotations per day" is a property of one bug's
        // occurrences. Ignoring the flag would print a table that answers a
        // question nobody asked.
        throw usageError(
            '--history needs one bug: the ranked list’s rows are bugs, and a per-day breakdown ' +
                'is a property of one bug’s occurrences',
            'Use --bug <id> --history, or --test <path> --history.'
        );
    }
    if (globals.config.length > 0 || globals.excludeConfig.length > 0) {
        // Accepted on `--bug`, where each occurrence carries a platform and a
        // build type, and refused here, where the rows are bugs and there is no
        // per-occurrence configuration to match. `dispatch()` cannot make that
        // distinction — `rejectsGlobals` is per command, not per mode — so the
        // ranking refuses it itself rather than ignoring it.
        throw usageError(
            '--config cannot be applied to the ranked list: its rows are bugs, and a bug spans ' +
                'every configuration it was annotated on',
            'Use --bug <id> --config <substring> to filter one bug’s occurrences.'
        );
    }

    await runRanking(context, client, tree, range, args);
}

/** The ranked list. */
async function runRanking(
    context: CommandContext,
    client: IntermittentsClient,
    tree: string,
    range: DayRange,
    args: ParsedArgs
): Promise<void> {
    const { globals } = context;
    const harness = readHarnessSelector(args);
    const limit = globals.limit ?? DEFAULT_LIMIT;

    progress(context, `Ranking annotated bugs on ${tree} for ${range.start}..${range.end}…`);
    const ranking = await withUpstreamErrors(() => client.rankBugs(tree, range), tree);

    // Every candidate's summary, batched rather than one request per bug:
    // classification reads the summary, so this is not the drill-down's "look up
    // what I am about to print" but an input to the ranking itself.
    //
    // **Batched is not one request.** `bugSummaries` chunks by
    // `BUG_BATCH_SIZE`, so the count is `ceil(candidates / BUG_BATCH_SIZE)` and
    // scales with the ranking: a trunk week runs to several hundred annotated
    // bugs and therefore several Bugzilla requests, not one. Stated because the
    // saving here is against *one per bug*, and understating the real load is
    // how a caller concludes this path is cheaper than it is.
    const candidates = ranking
        .filter((row) => row.bugId !== null)
        .map((row) => row.bugId as number);
    progress(context, `Reading ${candidates.length} bug summaries…`);
    const summaries = await withUpstreamErrors(() => client.bugSummaries(candidates), tree);

    progress(context, 'Reading the mochitest and xpcshell test lists…');
    const harnessOfPath = await loadHarnessOfPath(context);

    // Classify everything, then select: with no `--harness` the answer is the
    // whole ranking, classified and unknown interleaved by count.
    const scan = scanBugs({ ranking, summaries, harnessOfPath });
    const selected = selectHarness(scan.rows, harness);
    const shown = applyLimit(selected, limit);

    if (globals.format === 'json') {
        // The whole selected set, not `shown`: `--json` is the escape hatch and
        // a machine-readable array that is silently a prefix of its own count
        // is the defect this repository's work list calls out twice.
        emit(
            context,
            toJson({
                harness: harness ?? null,
                tree,
                startday: range.start,
                endday: range.end,
                coverage: scan.coverage,
                matchCount: selected.length,
                rows: selected,
            } satisfies IntermittentListJson)
        );
        return;
    }
    emit(
        context,
        globals.format === 'markdown'
            ? renderRankingMarkdown(harness, tree, range, shown, selected, scan)
            : renderRankingText(harness, tree, range, shown, selected, scan)
    );
}

/**
 * `--harness`, which here takes a third value beyond the two harnesses.
 *
 * Read from the raw argument rather than `globals.harness`, because the global
 * validator only knows the two real harnesses — `unknown` is this command's
 * own classification bucket, not a harness anyone can run. Validated here so
 * the error names all three values a reader can actually pass.
 */
function readHarnessSelector(args: ParsedArgs): HarnessSelector | undefined {
    const value = stringOption(args, 'harness');
    if (value === undefined) {
        return undefined;
    }
    if (value !== 'mochitest' && value !== 'xpcshell' && value !== 'unknown') {
        throw usageError(
            `--harness expects mochitest, xpcshell or unknown, got "${value}"`,
            'Omit --harness to rank every annotated bug, whatever its classification.'
        );
    }
    return value;
}

/**
 * Which harness a test path belongs to, from the published 21-day aggregates.
 *
 * Two files for the whole run, whatever `--scan` is — the same
 * `{harness}-issues.json` five other commands already read, so a warm cache
 * makes this free. Deliberately not the per-test bucket files: those are 3.5 MB
 * *each* and would make the cost scale with the number of bugs examined, when
 * the question here is only "is this path a test of this harness". Drilling into
 * one test is what `fx-tests test <path>` is for, and the path printed in each
 * row is what it takes.
 */
async function loadHarnessOfPath(context: CommandContext): Promise<HarnessOfPath> {
    const known = new Map<string, ScanHarness>();
    for (const harness of ['mochitest', 'xpcshell'] as const) {
        const file = await fetchJson<IssuesFile>(context.source, {
            index: timingsIndex(harness),
            filename: `${harness}-issues.json`,
        });
        for (const path of collectTestPaths([file])) {
            // First wins, so a path in both files keeps the mochitest answer
            // rather than depending on iteration order.
            if (!known.has(path)) {
                known.set(path, harness);
            }
        }
    }
    return (path: string) => known.get(path) ?? null;
}

/**
 * `--test <path>`: the same drill-down, reached by test path.
 *
 * Someone starting from a failing test has no bug number, and the mapping is
 * already in the ranking this command builds — every classified row carries the
 * verified path its bug's summary names. So this is the ranking, matched on
 * `test`, rather than a second source of truth.
 *
 * **An exact path only.** `errors --test` accepts a directory prefix; here a
 * prefix matching several tests has no single bug to drill into, and the answer
 * would be a list of lists. Several bugs naming *one* test is a real case and
 * does print them all, without picking one.
 */
async function runTestDrilldown(
    context: CommandContext,
    client: IntermittentsClient,
    tree: string,
    range: DayRange,
    test: string,
    args: ParsedArgs
): Promise<void> {
    progress(context, `Ranking annotated bugs on ${tree} for ${range.start}..${range.end}…`);
    const ranking = await withUpstreamErrors(() => client.rankBugs(tree, range), tree);
    const candidates = ranking
        .filter((row) => row.bugId !== null)
        .map((row) => row.bugId as number);
    progress(context, `Reading ${candidates.length} bug summaries…`);
    const summaries = await withUpstreamErrors(() => client.bugSummaries(candidates), tree);
    progress(context, 'Reading the mochitest and xpcshell test lists…');
    const harnessOfPath = await loadHarnessOfPath(context);

    const matches = bugsNamingTest(scanBugs({ ranking, summaries, harnessOfPath }).rows, test);
    if (matches.length === 0) {
        throw notFoundError(
            `no sheriff-annotated bug names the test ${test} on ${tree} between ` +
                `${range.start} and ${range.end}`,
            'A bug is matched by the exact test path in its summary, so a directory prefix will ' +
                'not do. Widen the window with --since <n>, or run without --test to see what ' +
                'was annotated.'
        );
    }
    if (matches.length > 1) {
        emit(context, renderTestMatches(test, tree, range, matches, context.globals.format));
        return;
    }
    await runDrilldown(context, client, tree, range, matches[0]!.bugId, args);
}

/**
 * The bugs naming one test, when there is more than one.
 *
 * Printed instead of drilling into the largest: two bugs on one test are two
 * different failures of it, and choosing for the reader hides the one they did
 * not get.
 */
function renderTestMatches(
    test: string,
    tree: string,
    range: DayRange,
    matches: readonly RankedIntermittent[],
    format: string
): string {
    const title = `${fmtCount(matches.length)} sheriff-annotated bugs name ${test} on ${tree}, ${range.start} to ${range.end}`;
    if (format === 'markdown') {
        return joinLines([
            md.heading(title),
            '',
            ...md.table(
                [{ header: 'count', align: 'right' }, { header: 'bug' }, { header: 'failure' }],
                matches.map((row) => [
                    fmtCount(row.count),
                    `[${row.bugId}](https://bugzilla.mozilla.org/show_bug.cgi?id=${row.bugId})`,
                    row.failure,
                ])
            ),
        ]);
    }
    if (format === 'json') {
        return toJson({
            test,
            tree,
            startday: range.start,
            endday: range.end,
            matchCount: matches.length,
            rows: matches,
        });
    }
    return joinLines([
        ...wrapText(title),
        '',
        ...tableSection(
            [
                { header: 'count', align: 'right', sort: 'desc' },
                { header: 'bug', align: 'right' },
                { header: 'failure' },
            ],
            matches.map((row) => [fmtCount(row.count), String(row.bugId), row.failure]),
            { total: matches.length, shown: matches.length, fit: true }
        ),
        'Drill into one with --bug <id>.',
    ]);
}

/** The `--bug <id>` drill-down. */
async function runDrilldown(
    context: CommandContext,
    client: IntermittentsClient,
    tree: string,
    range: DayRange,
    bug: number,
    args: ParsedArgs
): Promise<void> {
    const { globals } = context;
    progress(context, `Reading occurrences of bug ${bug} on ${tree} for ${range.start}..${range.end}…`);
    const raw = await withUpstreamErrors(() => client.occurrencesOfBug(tree, range, bug), tree);
    if (raw.length === 0) {
        // Exit 2, and the message names all three things that could be wrong,
        // because "no rows" here means "no sheriff annotated this bug on this
        // tree in this window" — not "this bug does not exist".
        throw notFoundError(
            `no sheriff annotations for bug ${bug} on ${tree} between ${range.start} and ${range.end}`,
            'Annotations are per tree and per day range: widen with --since <n>, or try --tree all. ' +
                'A bug with no annotations in the window is not in this data at all.'
        );
    }
    const occurrences = await withRunIds(context, client, tree, raw);

    const filter: DrilldownFilter = {
        ...(globals.harness === undefined ? {} : { harness: globals.harness }),
        ...(globals.config.length === 0 ? {} : { config: globals.config }),
        ...(globals.excludeConfig.length === 0 ? {} : { excludeConfig: globals.excludeConfig }),
    };
    const summary = summariseBug(bug, occurrences, filter);
    const shownOccurrences = filterOccurrences(occurrences, filter);
    if (shownOccurrences.length === 0) {
        // Exit 2 rather than an empty report: the bug has annotations, the
        // filter matched none of them, and the two are different answers.
        throw notFoundError(
            `bug ${bug} has ${occurrences.length} annotations on ${tree}, but none match the ` +
                `filter`,
            'Run without --harness/--config to see every configuration it was annotated on.'
        );
    }
    const summaries = await withUpstreamErrors(() => client.bugSummaries([bug]), tree);
    const bugSummary = summaries.get(bug) ?? null;
    // Always in `--json`, which is the escape hatch, and behind the flag in the
    // rendered views, where it is thirty lines nobody asked for.
    const profiles =
        globals.format === 'json' || boolOption(args, 'profiles')
            ? occurrenceProfiles(shownOccurrences)
            : null;
    // Over the filtered population, like every other section: a per-day table
    // that counted annotations the header says were excluded would not sum to
    // the total above it.
    const history = occurrenceHistory(shownOccurrences, range);

    if (globals.format === 'json') {
        emit(
            context,
            toJson({
                ...summary,
                tree,
                startday: range.start,
                endday: range.end,
                bugSummary,
                occurrenceRows: shownOccurrences,
                profiles: profiles ?? [],
                history,
            } satisfies IntermittentBugJson)
        );
        return;
    }
    const shownHistory = boolOption(args, 'history') ? history : null;
    emit(
        context,
        globals.format === 'markdown'
            ? renderBugMarkdown(
                  summary,
                  bugSummary,
                  tree,
                  range,
                  shownOccurrences,
                  profiles,
                  shownHistory
              )
            : renderBugText(
                  summary,
                  bugSummary,
                  tree,
                  range,
                  shownOccurrences,
                  globals.limit,
                  profiles,
                  shownHistory
              )
    );
}

/**
 * The occurrences with Taskcluster's run index filled in.
 *
 * Costs `ceil(occurrences / JOB_BATCH_SIZE)` extra requests — one for a bug with
 * a few hundred annotations, more for a busier one, never one per occurrence.
 * Stated as the formula rather than as a number so it cannot read as a flat
 * "one request" the way this comment first did.
 *
 * What it buys is the difference between a task ID that can be turned into an
 * artifact URL and one that cannot: a task whose first run ended in `exception`
 * has its annotated failure in run 1, and `runs/0` 404s. Measured on bug
 * 1988796, 5 of its 122 occurrences.
 *
 * A failure here is not fatal. The run index improves every task ID printed but
 * is not what the drill-down is for, so an outage degrades to the task IDs
 * alone, warned about, rather than failing the whole report.
 */
async function withRunIds(
    context: CommandContext,
    client: IntermittentsClient,
    tree: string,
    occurrences: readonly BugOccurrence[]
): Promise<BugOccurrence[]> {
    const jobIds = occurrences.map((row) => row.jobId).filter((id) => Number.isFinite(id) && id > 0);
    if (jobIds.length === 0) {
        return [...occurrences];
    }
    progress(context, `Reading the run index of ${jobIds.length} jobs…`);
    let runIds: Map<number, number>;
    try {
        runIds = await withUpstreamErrors(() => client.runIdsOfJobs(jobIds), tree);
    } catch (error) {
        warn(
            context,
            `could not read job run indexes (${(error as Error).message}); ` +
                `task ids are printed without one`
        );
        return [...occurrences];
    }
    return occurrences.map((row) => ({ ...row, runId: runIds.get(row.jobId) ?? null }));
}

/**
 * The window, mapped onto the API's required `startday`/`endday`.
 *
 * UTC, because Treeherder's push times are: a local-time end date asks for
 * tomorrow east of Greenwich, which the API answers with an empty tail.
 */
export function resolveRange(
    day: string | undefined,
    since: number | undefined,
    today: Date = new Date()
): DayRange {
    if (day !== undefined) {
        // No `today`/`yesterday` keywords here, deliberately: elsewhere they
        // mean "the newest day with published data", which is a property of the
        // index this command does not read. Offering the same word for a
        // different meaning is worse than not offering it.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
            throw usageError(
                `--day expects YYYY-MM-DD, got "${day}"`,
                'This command queries a live API rather than the published window, so the ' +
                    '"today" and "yesterday" keywords — which mean "the newest day with data" ' +
                    'elsewhere — do not apply. Use --since <n> for a relative range.'
            );
        }
        return { start: day, end: day };
    }
    const days = since ?? DEFAULT_DAYS;
    const end = isoDay(today);
    const start = isoDay(new Date(today.getTime() - (days - 1) * 24 * 60 * 60 * 1000));
    return { start, end };
}

/** A `Date` as `YYYY-MM-DD` in UTC. */
function isoDay(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/**
 * Turns a transport or HTTP failure into the CLI's exit codes.
 *
 * A 400 from Treeherder is almost always a `tree` it does not know — that is the
 * one thing `validate_tree` rejects — so it becomes a usage error naming the
 * groups it does accept, rather than exit 3 telling the user to retry a request
 * that will fail identically forever.
 */
async function withUpstreamErrors<T>(work: () => Promise<T>, tree: string): Promise<T> {
    try {
        return await work();
    } catch (error) {
        if (error instanceof IntermittentsError) {
            if (error.status === 400) {
                throw usageError(
                    `Treeherder rejected the query, which for these endpoints means an unknown ` +
                        `tree: "${tree}"`,
                    `--tree takes a repository name (autoland, mozilla-central, …), a repo group ` +
                        `(${TREE_GROUPS.join(', ')}), or all.`
                );
            }
            throw upstreamError(
                `${error.message} from ${error.url}`,
                'Treeherder’s intermittents API and Bugzilla are both live services; retrying may work.'
            );
        }
        throw error;
    }
}

/**
 * What the window holds, and what this run selected from it.
 *
 * Two framings of the same numbers, because they answer different questions.
 * Unfiltered, the reader wants the composition of the list in front of them.
 * Filtered, they want to know what was selected and out of what — so the same
 * counts appear, but as a denominator rather than as a breakdown.
 */
function coverageLines(
    coverage: ScanCoverageJson,
    harness: HarnessSelector | undefined,
    selected: number
): string[] {
    // Each entry is one sentence, wrapped on the way out: prose stated as a
    // single string in the source and broken to the terminal here, rather than
    // hand-wrapped, which fixes it to one width. Under `--markdown` and
    // `--full-messages` `wrapText` returns it whole.
    const sentences: string[] = [];
    const lines: string[] = [];
    if (harness === undefined) {
        sentences.push(
            `All ${fmtCount(coverage.scanned)} annotated bugs, ranked by count: ` +
                `${fmtCount(coverage.mochitest)} name a mochitest test, ` +
                `${fmtCount(coverage.xpcshell)} an xpcshell test, and ` +
                `${fmtCount(coverage.unknown)} name no test this tool knows.`
        );
        sentences.push(
            'A bug is placed by the test path in its summary, checked against the published ' +
                'test lists. --harness mochitest, xpcshell or unknown ranks one group.'
        );
    } else if (harness === 'unknown') {
        sentences.push(
            `${fmtCount(selected)} of ${fmtCount(coverage.scanned)} annotated bugs name no test ` +
                `this tool knows — infrastructure failures, suites it does not read, and tests ` +
                `whose summary does not name a path.`
        );
    } else {
        sentences.push(
            `${fmtCount(selected)} of ${fmtCount(coverage.scanned)} annotated bugs name a ` +
                `verified ${harness} test. The rest: ` +
                `${fmtCount(harness === 'mochitest' ? coverage.xpcshell : coverage.mochitest)} ` +
                `name a test of the other harness, ` +
                `${fmtCount(coverage.unknown)} name no test this tool knows ` +
                `(--harness unknown ranks those).`
        );
    }
    if (coverage.noBugCount > 0) {
        sentences.push(
            `Excluded: ${fmtCount(coverage.noBugCount)} annotations with no bug attached, which ` +
                `carry no summary to read a test path from.`
        );
    }
    for (const sentence of sentences) {
        lines.push(...wrapText(sentence));
    }
    lines.push('');
    lines.push('count = jobs sheriffs annotated with this bug.');
    return lines;
}

/**
 * A row's `test` cell — the verified path, or empty when the bug names none.
 *
 * **Empty, not `(no test named) <failure>`.** That marker used to prefix the
 * failure text and put the whole thing in this column, which meant the column
 * headed `failure` sat empty on exactly the rows whose text *is* a failure
 * message — 59% of a live 731-row window. Two columns then carried one field
 * between them depending on the row, and naming both after that field is what
 * left the table with a duplicate header. An absent path is now an absent cell,
 * and the message is in the column that names it.
 */
function testCell(row: RankedIntermittent): string {
    return row.test ?? '';
}

/** The title line, which says what the list is. */
function rankingTitle(harness: HarnessSelector | undefined, tree: string, range: DayRange): string {
    const what =
        harness === undefined
            ? 'Sheriff-annotated intermittents'
            : harness === 'unknown'
              ? 'Sheriff-annotated bugs naming no known test'
              : `Sheriff-annotated ${harness} intermittents`;
    return `${what} on ${tree}, ${range.start} to ${range.end}`;
}

/** The ranked list, as text. */
function renderRankingText(
    harness: HarnessSelector | undefined,
    tree: string,
    range: DayRange,
    shown: readonly RankedIntermittent[],
    selected: readonly RankedIntermittent[],
    scan: ScanResult
): string {
    const lines: (string | null)[] = [
        ...wrapText(rankingTitle(harness, tree, range)),
        '',
        ...coverageLines(scan.coverage, harness, selected.length),
        '',
    ];
    if (shown.length === 0) {
        lines.push(emptySelectionLine(harness, scan));
        return joinLines(lines);
    }
    // Under `--harness unknown` no row has a path, so the `test` column would be
    // empty on every row: a header with nothing under it. That mode alone drops
    // it and gives the whole text budget to `failure`.
    const columns: Column[] =
        harness === 'unknown'
            ? [
                  { header: 'count', align: 'right', sort: 'desc' },
                  { header: 'bug', align: 'right' },
                  // The only text column in this mode, so it gets the whole
                  // remaining width: a budget would just be a second cap under
                  // the one `fit` already applies.
                  { header: 'failure', maxWidth: MIXED_CELL_WIDTH + FAILURE_WIDTH },
              ]
            : [
                  { header: 'count', align: 'right', sort: 'desc' },
                  { header: 'bug', align: 'right' },
                  // `path: true` in every mode that shows this column, because
                  // it now holds only paths. Path truncation cuts from the
                  // front to save the basename, which is the copyable part; it
                  // used to be withheld here because the same cell also carried
                  // prose, and front-truncating a sentence mangles it.
                  { header: 'test', path: true },
                  { header: 'failure', maxWidth: FAILURE_WIDTH },
              ];
    lines.push(
        ...tableSection(
            columns,
            shown.map((row) =>
                harness === 'unknown'
                    ? [fmtCount(row.count), String(row.bugId), row.failure]
                    : [fmtCount(row.count), String(row.bugId), testCell(row), row.failure]
            ),
            // Fitted: `test` and `failure` both hold content wider than any
            // budget, so the two have to be reconciled against the real width.
            { total: selected.length, shown: shown.length, fit: true }
        )
    );
    return joinLines(lines);
}

/** Why the selection is empty, in the terms the caller asked in. */
function emptySelectionLine(harness: HarnessSelector | undefined, scan: ScanResult): string {
    if (harness === undefined) {
        return 'No bug was annotated in this window.';
    }
    if (harness === 'unknown') {
        return `Every one of the ${fmtCount(scan.coverage.scanned)} annotated bugs named a test this tool knows.`;
    }
    return `No bug among the ${fmtCount(scan.coverage.scanned)} annotated named a verified ${harness} test.`;
}

/** The ranked list, as Markdown. */
function renderRankingMarkdown(
    harness: HarnessSelector | undefined,
    tree: string,
    range: DayRange,
    shown: readonly RankedIntermittent[],
    selected: readonly RankedIntermittent[],
    scan: ScanResult
): string {
    const lines: (string | null)[] = [
        md.heading(rankingTitle(harness, tree, range)),
        '',
        ...coverageLines(scan.coverage, harness, selected.length),
        '',
    ];
    if (shown.length === 0) {
        lines.push(emptySelectionLine(harness, scan));
        return joinLines(lines);
    }
    const link = (row: RankedIntermittent): string =>
        `[${row.bugId}](https://bugzilla.mozilla.org/show_bug.cgi?id=${row.bugId})`;
    lines.push(
        ...md.table(
            harness === 'unknown'
                ? [{ header: 'count', align: 'right' }, { header: 'bug' }, { header: 'failure' }]
                : [
                      { header: 'count', align: 'right' },
                      { header: 'bug' },
                      { header: 'test' },
                      { header: 'failure' },
                  ],
            // Untruncated: `--markdown` is for pasting into a bug.
            shown.map((row) =>
                harness === 'unknown'
                    ? [fmtCount(row.count), link(row), row.failure]
                    : [fmtCount(row.count), link(row), testCell(row), row.failure]
            )
        )
    );
    const more = md.moreLine(selected.length, shown.length);
    if (more !== null) {
        lines.push('');
        lines.push(more);
    }
    return joinLines(lines);
}

/**
 * The line under the bug's title, stating the filter's effect.
 *
 * `127 of 168 sheriff annotations` rather than a bare `127`: a filtered number
 * on its own is indistinguishable from the bug having got quieter, and the
 * reader cannot tell the filter worked.
 */
function drilldownCountLine(
    drilldown: BugDrilldown,
    tree: string,
    range: DayRange
): string {
    const scope =
        drilldown.occurrences === drilldown.totalOccurrences
            ? `${fmtCount(drilldown.occurrences)} sheriff annotations`
            : `${fmtCount(drilldown.occurrences)} of ${fmtCount(drilldown.totalOccurrences)} ` +
              `sheriff annotations match the filter`;
    return `${scope} on ${tree}, ${range.start} to ${range.end}`;
}

/**
 * The bug's identity and its Bugzilla summary, as two keyed lines.
 *
 * **Two lines, not one.** Item 5's goal was that this text not be read as the
 * observed failure, and two attempts at saying so with a word both failed for
 * the same reason: a label inside the value reads as part of it.
 * `Bug 2036743 — summary: Permanent toolkit/…` makes `summary:` look like the
 * summary's first word, and `Bug 2036743, filed as: …` still runs the two
 * together on one line. Keyed on separate lines, a reader sees a key and a
 * value and cannot mistake one for the other — the distinction is structural
 * rather than a matter of phrasing.
 *
 * It matters because the two are different failures often enough to mislead: a
 * Bugzilla summary describes the failure the day the bug was filed, and the
 * jobs annotated with it today regularly carry a different message — on bug
 * 2036743 a different service CID, from a different repository. What is failing
 * now is `Failure messages, per annotated job`, the first block below.
 *
 * The summary wraps to the terminal (they reach 255 characters), with
 * continuations hanging under the value rather than at column 0 so the key
 * column stays legible.
 */
function headlineLines(bugId: number, bugSummary: string | null): string[] {
    const label = 'Summary: ';
    const width = renderWidth();
    const wrapWidth =
        width === null ? null : Math.max(MIN_SUMMARY_WIDTH, width - label.length);
    const wrapped = wrapText(bugSummary ?? '(no summary from Bugzilla)', wrapWidth);
    const hang = ' '.repeat(label.length);
    return [
        `Bug #: ${bugId}`,
        ...wrapped.map((line, i) => {
            if (i === 0) {
                return `${label}${line}`;
            }
            // A line already too wide to fit is not indented. `wrapText` breaks
            // on spaces, so a space-free token wider than the terminal cannot
            // be split — bug 2036743's summary ends in an 83-character CID
            // array — and indenting it adds the label's 9 columns to a line
            // that was overflowing anyway. Starting it at the margin keeps the
            // overflow no worse than it is without the two-line format, while
            // the hanging indent still applies to every line it can help.
            //
            // The alternative, hard-breaking the token at the boundary, is
            // rejected: it uses the terminal better but makes that CID array
            // unselectable as one string, and copying it is a real use.
            return wrapWidth !== null && line.length > wrapWidth ? line : `${hang}${line}`;
        }),
    ];
}

/**
 * The narrowest the summary is wrapped to, however narrow the terminal.
 *
 * Mirrors `MIN_CELL_WIDTH` in `format/text.ts`: below this a hanging indent
 * costs more than it buys, and one word per line is worse than overflowing.
 */
const MIN_SUMMARY_WIDTH = 20;

/** The drill-down, as text. */
function renderBugText(
    drilldown: BugDrilldown,
    bugSummary: string | null,
    tree: string,
    range: DayRange,
    occurrences: readonly BugOccurrence[],
    limit: number | undefined,
    profiles: readonly OccurrenceProfiles[] | null,
    history: readonly OccurrenceDay[] | null
): string {
    const lines: (string | null)[] = [
        ...headlineLines(drilldown.bugId, bugSummary),
        ...wrapText(drilldownCountLine(drilldown, tree, range)),
        '',
    ];
    // First, ahead of the four grouping tallies: it is what the annotated jobs
    // actually printed, which is the question a drill-down is opened to answer,
    // and it used to sit fifth behind the axes a reader can already guess.
    //
    // 140 rather than 100: the number that made this useful was measured, not
    // chosen. With the marker and the path stripped (`failureLineDetail`) the
    // messages on live bug 2019094 diverge between characters 30 and 120, so a
    // 100-character cut still lost the discriminator on some rows.
    lines.push(...tallySection('Failure messages, per annotated job', drilldown.lines, limit, 140));
    lines.push(...tallySection('Job names, chunk numbers merged', drilldown.jobNames, limit));
    lines.push(...tallySection('Platforms', drilldown.platforms, limit));
    lines.push(...tallySection('Build types', drilldown.buildTypes, limit));
    lines.push(...tallySection('Trees', drilldown.trees, limit));
    lines.push(...tallySection('Tests named, per annotated job', drilldown.tests, limit));
    if (drilldown.tests.length === 0) {
        // The `lines` array is empty for jobs whose `TEST-UNEXPECTED-FAIL`
        // lines Treeherder did not keep, and a silent absence here reads as
        // "this bug has no test", which is a claim about Firefox rather than
        // about the data.
        lines.push('Tests named, per annotated job');
        lines.push(
            '  (none: no occurrence carried a TEST-UNEXPECTED-FAIL line naming a test — ' +
                'the API only keeps lines matching that marker)'
        );
        lines.push('');
    }
    if (history !== null) {
        lines.push(...historySection(history));
    }

    const rows = applyLimit(occurrences, limit ?? DRILLDOWN_ROWS);
    lines.push(`Occurrences (${fmtCount(occurrences.length)})`);
    lines.push(
        ...table(
            [
                { header: 'push time' },
                { header: 'tree' },
                // The two widest columns carry budgets so `fit` has something
                // to shave: the rest are short enough that cutting them would
                // destroy the value rather than shorten it — a truncated task
                // id cannot be looked up, and `opt`/`debug` is already minimal.
                { header: 'platform', maxWidth: 24 },
                { header: 'build' },
                { header: 'job name', maxWidth: 30 },
                // `<taskId>.<runId>`, the format `test --task-ids` and
                // Treeherder both use. The run index is not decoration: a task
                // retried after an `exception` has its annotated failure in run
                // 1, and every artifact URL built from run 0 then 404s.
                { header: 'task id' },
            ],
            rows.map((row) => [
                row.pushTime,
                row.tree,
                row.platform,
                row.buildType,
                row.testSuite,
                taskRunId(row),
            ]),
            '  ',
            { fit: true }
        )
    );
    if (rows.length < occurrences.length) {
        lines.push(`  … ${occurrences.length - rows.length} more (--limit 0 for all)`);
    }
    if (profiles !== null) {
        lines.push('');
        lines.push(...profileSection(profiles, limit));
    }
    return joinLines(lines);
}

/**
 * An occurrence's run, as `<taskId>.<runId>`.
 *
 * Falls back to the bare task ID when the run index was not resolved, rather
 * than printing `.0`: a guessed run reads exactly like a known one, and getting
 * it wrong is the defect this carries the field to fix.
 */
function taskRunId(row: BugOccurrence): string {
    return row.runId === null ? row.taskId : `${row.taskId}.${row.runId}`;
}

/**
 * The `Profiles` section, in the shape `fx-tests test --profiles` prints.
 *
 * `taskId.runId  <job name>` with the URLs indented beneath, so someone who
 * learned the layout on `test` reads this one without learning a second.
 *
 * The URLs are **raw artifact URLs**, per `lib/links.ts`: the consumer is
 * `profiler-cli`, which downloads the profile itself.
 */
function profileSection(
    profiles: readonly OccurrenceProfiles[],
    limit: number | undefined
): string[] {
    // A profile whose URL could not be built is dropped, and a row left with no
    // profiles is dropped with it. The bare filename is not an answer: the run
    // index a reader would need to construct the URL themselves is exactly what
    // is missing, so the line costs space and delivers nothing. `--json` keeps
    // `{"filename": …, "url": null}`, where a consumer can tell the states apart.
    const linked = profiles
        .map((row) => ({ ...row, profiles: row.profiles.filter((entry) => entry.url !== null) }))
        .filter((row) => row.profiles.length > 0);
    if (linked.length === 0) {
        // Named causes, not a bare "none". A silent absence reads as "this bug
        // has no profiles", which is the misreading the section exists to
        // prevent — and "the run index did not resolve" is a different fact
        // about this run from "the harness captured nothing".
        return [
            'Profiles',
            ...(profiles.length === 0
                ? [
                      '  (none: no occurrence’s log named an uploaded profile — the harness ' +
                          'only captures one for certain failures)',
                  ]
                : [
                      `  (none reachable: ${fmtCount(profiles.length)} occurrences named a ` +
                          `profile, but no artifact URL could be built for any of them — the ` +
                          `run index did not resolve, or Treeherder holds no task for the job)`,
                  ]),
        ];
    }
    const shown = applyLimit(linked, limit ?? DRILLDOWN_ROWS);
    const lines = ['Profiles (raw artifact URLs, for profiler-cli)'];
    for (const row of shown) {
        lines.push(`  ${row.run}  ${row.configuration}`);
        for (const profile of row.profiles) {
            // The label reads the name the log gave; a `-2` file is the
            // harness's in-job rerun. Nothing is emitted that a log line did
            // not name, so there is no third state to label.
            lines.push(`    ${profile.isRerun ? 'rerun:  ' : 'profile:'} ${profile.url}`);
        }
    }
    if (shown.length < linked.length) {
        lines.push(`  … ${linked.length - shown.length} more (--limit 0 for all)`);
    }
    if (shown.some((row) => row.profiles.some((profile) => profile.isRerun))) {
        // One line for the section, and only when a rerun is actually shown.
        // It explains an absence a reader will otherwise puzzle over — the
        // first run's profile exists but is not listed — and the answer is not
        // guessable from the output. Per row it would be the noise this section
        // just shed.
        lines.push(
            '  (a rerun’s first-run profile is uploaded too, but Treeherder keeps only the ' +
                'retry’s log messages, so it is not named here)'
        );
    }
    return lines;
}

/**
 * The `History` section, in the shape `fx-tests test --history` prints.
 *
 * `<date> (<weekday>)  <count>`, right-aligned, one row per day of the window
 * with the empty days kept — see `occurrenceHistory` for why they are the
 * point. The weekday is there for the reason `dateWithWeekday` exists: push
 * volume drops several-fold at weekends, so a low Saturday is not a quiet day.
 *
 * Never wider than the widest count, so the numbers line up under each other
 * and a spike is visible as a step in the column rather than read digit by
 * digit.
 *
 * **`--limit` does not apply**, matching `test --history`, which ignores it too.
 * Every other section here is a ranking, where the top N is a smaller answer to
 * the same question; this is an axis, where the zero rows carry the finding —
 * the four empty days before bug 2036743's spike are what say "regression", not
 * "two weeks of flakiness" — so a capped one would cut the signal rather than
 * shorten it. The cost of that is real but bounded by the window: `--since
 * 99999` prints 100,001 rows, of which 114 are non-zero.
 */
function historySection(history: readonly OccurrenceDay[]): string[] {
    const width = Math.max(3, ...history.map((row) => fmtCount(row.count).length));
    return [
        'History (annotations per day)',
        ...history.map(
            (row) =>
                `  ${dateWithWeekday(row.date).padEnd(16)}  ${fmtCount(row.count).padStart(width)}`
        ),
        '',
    ];
}

/** One counted group of the drill-down, or nothing when it is empty. */
function tallySection(
    title: string,
    counts: readonly SuiteCount[],
    limit: number | undefined,
    maxWidth?: number
): string[] {
    if (counts.length === 0) {
        return [];
    }
    const shown = applyLimit(counts, limit ?? DRILLDOWN_ROWS);
    // `  NNNNNx  ` — the count column and its padding, which the name shares the
    // line with. These rows are hand-built rather than rendered by `table()`, so
    // the terminal clamp `table()` applies has to be applied here too.
    const prefixWidth = 10;
    const lines = [
        title,
        ...shown.map((entry) => {
            const budgeted = maxWidth === undefined ? entry.name : truncate(entry.name, maxWidth);
            return `  ${String(entry.count).padStart(5)}x  ${fitLine(budgeted, prefixWidth)}`;
        }),
    ];
    if (shown.length < counts.length) {
        lines.push(`  … ${counts.length - shown.length} more (--limit 0 for all)`);
    }
    lines.push('');
    return lines;
}

/**
 * The drill-down, as Markdown.
 *
 * **Nothing here is truncated and `--limit` is ignored**: Markdown is for
 * pasting into a bug, so a silently partial list is the defect a capped `--json`
 * array would be. The text renderer is where `--limit` applies and marks cuts.
 */
function renderBugMarkdown(
    drilldown: BugDrilldown,
    bugSummary: string | null,
    tree: string,
    range: DayRange,
    occurrences: readonly BugOccurrence[],
    profiles: readonly OccurrenceProfiles[] | null,
    history: readonly OccurrenceDay[] | null
): string {
    const lines: (string | null)[] = [
        // The heading is the bug alone and the summary a keyed line under it,
        // matching the text renderer's two lines. A 255-character Bugzilla
        // summary inside an `#` heading is unreadable pasted into a bug, and
        // running the label into the value is the thing `headlineLines`
        // exists to avoid.
        md.heading(`Bug #: ${drilldown.bugId}`),
        '',
        `Summary: ${bugSummary ?? '(no summary from Bugzilla)'}`,
        '',
        `${drilldownCountLine(drilldown, tree, range)}.`,
        '',
        ...md.table(
            [
                { header: 'count', align: 'right' },
                { header: 'job name' },
                { header: 'platform' },
                { header: 'build type' },
            ],
            // The three axes side by side rather than as three tables: pasted
            // into a bug this is one block to read.
            zipTallies(drilldown.jobNames, drilldown.platforms, drilldown.buildTypes)
        ),
        '',
    ];
    if (drilldown.lines.length > 0) {
        lines.push(md.heading('Failure messages, per annotated job', 2));
        lines.push('');
        for (const entry of drilldown.lines) {
            // Untruncated, per `--markdown` being a file format: the cut-off
            // part of a failure message is regularly the discriminator.
            lines.push(`- ${entry.count}x ${md.code(entry.name)}`);
        }
        lines.push('');
    }
    if (history !== null) {
        lines.push(md.heading('History (annotations per day)', 2));
        lines.push('');
        lines.push(
            ...md.table(
                [{ header: 'day' }, { header: 'annotations', align: 'right' }],
                history.map((row) => [dateWithWeekday(row.date), fmtCount(row.count)])
            )
        );
        lines.push('');
    }
    lines.push(md.heading('Task IDs', 2));
    lines.push('');
    for (const row of occurrences) {
        lines.push(`- \`${taskRunId(row)}\` — ${row.platform}/${row.buildType} ${row.testSuite}`);
    }
    // Same rule as the text renderer's: an entry with no URL is not printable,
    // and a row emptied by that is not a row. See `profileSection`.
    const linkedProfiles = (profiles ?? [])
        .map((row) => ({ ...row, profiles: row.profiles.filter((entry) => entry.url !== null) }))
        .filter((row) => row.profiles.length > 0);
    if (profiles !== null && linkedProfiles.length > 0) {
        lines.push('');
        lines.push(md.heading('Profiles', 2));
        lines.push('');
        // Uncapped, like every other Markdown section here: it is a file format
        // for pasting into a bug, so a silently partial list is the defect.
        for (const row of linkedProfiles) {
            lines.push(`- \`${row.run}\` — ${row.configuration}`);
            for (const profile of row.profiles) {
                lines.push(`  - ${profile.isRerun ? 'rerun' : 'profile'}: ${profile.url}`);
            }
        }
    }
    return joinLines(lines);
}

/** Pads three tallies to the same length so they can share one table. */
function zipTallies(
    suites: readonly SuiteCount[],
    platforms: readonly SuiteCount[],
    buildTypes: readonly SuiteCount[]
): string[][] {
    const rows: string[][] = [];
    const height = Math.max(suites.length, platforms.length, buildTypes.length);
    for (let i = 0; i < height; i++) {
        rows.push([
            suites[i] === undefined ? '' : String(suites[i]!.count),
            suites[i]?.name ?? '',
            platforms[i] === undefined ? '' : `${platforms[i]!.count}x ${platforms[i]!.name}`,
            buildTypes[i] === undefined ? '' : `${buildTypes[i]!.count}x ${buildTypes[i]!.name}`,
        ]);
    }
    return rows;
}
