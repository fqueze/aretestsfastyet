/**
 * `fx-tests issues`, `failures`, `crashes` and `skips` — the tree-wide views.
 *
 * Four commands in one file because they read the same file, take almost the
 * same options and differ only in what they group by. Splitting them would
 * duplicate the loading, the filters and the "which file can answer this"
 * reasoning below four times.
 *
 * ## The file cannot attribute configurations, and that is not an empty result
 *
 * These read `{harness}-issues.json`, which is 2.8 MB because it **gave up all
 * attribution**: it has no `taskInfo`, its groups carry no `jobNameIds`, and so
 * every per-configuration query over it returns nothing whatever the test.
 *
 * `computeConfigStats()` returns `[]` on it, and `[]` means two entirely
 * different things — "no configuration failed" and "this file cannot say".
 * `canAttributeConfigs()` exists for exactly that distinction, and these
 * commands are where it becomes load-bearing: `fx-tests test` reads bucket
 * files and so never exercises it, which is why step 4 could leave the guard
 * untested. Here, `--config` is **refused** rather than silently matching
 * nothing, because a filter that quietly drops every row looks identical to a
 * tree with no failures.
 *
 * The escape hatch is real and is named in the message: `issues-with-taskids`
 * carries task attribution on the non-passing groups, at about 5× the bytes.
 *
 * ## `run-if` is not a disabled test
 *
 * `fx-tests skips` excludes `run-if` by default: it means the test is scoped to
 * another platform, so it not running here is the annotation working rather
 * than work someone owes. `--include-run-if` keeps them.
 *
 * The measured asymmetry matters for how that is reported. `FORMATS.md`: the
 * 21-day aggregates **already dropped** `run-if` upstream, while the daily
 * files keep them — 253,252 of 398,212 skipped runs on one daily file, 63.6%.
 * So on the aggregate these commands read, `--include-run-if` changes nothing
 * at all, and saying "excluded 0" would imply there were none to exclude rather
 * than that the generator got there first. The output says which population it
 * is reporting.
 */

import type { DecodedTimingFile } from '../../lib/formats/decode.ts';
import { canAttributeConfigs } from '../../lib/query/config-stats.ts';
import { type CrashGroup, groupCrashesBySignature } from '../../lib/query/crashes.ts';
import { type FailureGroup, groupFailuresByMessage } from '../../lib/query/failures.ts';
import {
    DEFAULT_TYPES,
    type IssueGroup,
    type IssueRow,
    type IssueType,
    type SkipRow,
    findIssues,
    findSkips,
    groupIssues,
} from '../../lib/query/issues.ts';
import { configFilter } from '../../lib/query/test-stats.ts';
import { type OptionSpecs, type ParsedArgs, boolOption, listOption, stringOption } from '../args.ts';
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
    truncate,
} from '../format/text.ts';
import type { Harness } from '../options.ts';
import { type DayWindow, loadIssues, resolveDayWindow } from '../data.ts';

/** Options shared by the four tree-wide commands. */
const SHARED_OPTIONS: OptionSpecs = {
    component: {
        type: 'string',
        placeholder: '<substring>',
        describe: 'Only tests whose Bugzilla component contains this.',
    },
    path: {
        type: 'string',
        placeholder: '<prefix>',
        describe: 'Only tests under this directory prefix.',
    },
};

/**
 * The standing note printed by `issues --help`, and nothing else.
 *
 * The reciprocal of the paragraph `intermittent --help` already carries. Asked
 * for "the most commonly failing mochitests" an agent reached for `issues
 * --group-by test`, got a top 20 with almost nothing in common with
 * `intermittent`'s, and built a whole candidate list on it — because the text
 * distinguishing the two rankings existed only on the command it did not run.
 *
 * One sentence, and it ends in a pointer rather than an explanation. The
 * explanation is `fx-tests guide`'s `annotations-are-not-failures` trap and
 * stays there; a fuller paraphrase here would be a second copy of it to keep in
 * step, which is the failure this note exists to fix rather than repeat. The
 * trap is named by its title because `fx-tests guide` takes no topic argument
 * and text mode prints titles, not ids.
 *
 * The contrasting noun is **issues**, not failures, and the difference is not
 * pedantry: an issue is the fail+timeout+crash+skip union, skips dominate it,
 * and the top rows of the default ranking are routinely 100% skip with zero
 * failures. A sentence saying "the failures counted here" would misdescribe the
 * column the rows are actually ordered by. `flaky` states its own unit for the
 * same reason — see the note at the end of `FLAKY_NOTES`, which is deliberately
 * *not* the same sentence.
 */
export const ISSUES_NOTES: readonly string[] = [
    '`fx-tests intermittent` ranks the bugs sheriffs annotated failing jobs with rather than',
    'the issues counted here — see `fx-tests guide`, "`intermittent` counts sheriff',
    'annotations, not failures".',
];

/** `fx-tests issues` options. */
export const ISSUES_OPTIONS: OptionSpecs = {
    ...SHARED_OPTIONS,
    type: {
        type: 'list',
        placeholder: '<fail|timeout|crash|skip>',
        describe:
            'Which outcomes count as an issue. Repeatable. Default all four, as on issues.html.',
    },
    'min-rate': {
        type: 'string',
        placeholder: '<pct>',
        describe: 'Drop tests failing less often than this, in percent.',
    },
    sort: {
        type: 'string',
        placeholder: '<issues|rate|count|name>',
        describe: 'How to rank. Default issues.',
    },
    'group-by': {
        type: 'string',
        placeholder: '<component|test|directory|message>',
        describe:
            'How to group. Default component, as issues.html does. `message` is the ' +
            'one-bug-many-tests view.',
    },
};

/** `fx-tests failures` options. */
export const FAILURES_OPTIONS: OptionSpecs = {
    ...SHARED_OPTIONS,
    message: {
        type: 'string',
        placeholder: '<substring>',
        describe: 'Only messages containing this.',
    },
    tests: {
        type: 'boolean',
        describe: 'List the tests behind each message. Automatic once the table is 3 rows or fewer.',
    },
};

/** `fx-tests crashes` options. */
export const CRASHES_OPTIONS: OptionSpecs = {
    ...SHARED_OPTIONS,
    signature: {
        type: 'string',
        placeholder: '<substring>',
        describe: 'Only signatures containing this.',
    },
    minidumps: {
        type: 'boolean',
        describe: 'Print minidump IDs, which `fx-tests crash` then reads.',
    },
};

/** `fx-tests skips` options. */
export const SKIPS_OPTIONS: OptionSpecs = {
    ...SHARED_OPTIONS,
    'include-run-if': {
        type: 'boolean',
        describe: 'Keep run-if skips, which mean "not applicable here" rather than "disabled".',
    },
    'group-by': {
        type: 'string',
        placeholder: '<test|component|directory>',
        describe: 'How to group. Default test.',
    },
};

/** The default row count for every tree-wide view. */
const DEFAULT_LIMIT = 20;

// --- shared loading ------------------------------------------------------

/** What every one of these commands needs before it can answer. */
interface TreeQuery {
    harness: Harness;
    file: DecodedTimingFile;
    window: DayWindow;
    pathPrefix: string | undefined;
    component: string | undefined;
    /** The header every command prints. */
    header: TreeHeader;
}

/** The provenance header, shared by all four commands' JSON. */
interface TreeHeader {
    harness: string;
    family: string;
    startDate: string;
    endDate: string;
    dayCount: number;
    singleDay: boolean;
    testCount: number;
    dataSource: string;
    /**
     * Whether the file can attribute runs to configurations.
     *
     * False on `issues.json`. Reported in every response because a consumer
     * that sees no configurations needs to know whether that is an answer.
     */
    canAttributeConfigs: boolean;
    /**
     * Whether the file records minidump IDs on its CRASH groups.
     *
     * False on `issues.json`, measured: its CRASH groups carry `counts`,
     * `days` and `crashSignatureIds` and no `minidumps` field at all — 0 of
     * 676 groups. Separate from `canAttributeConfigs` because they are
     * different capabilities that happen to be absent from the same file, and
     * a caller checking one must not conclude anything about the other.
     */
    recordsMinidumps: boolean;
}

/**
 * Loads the aggregate and applies the shared validation.
 *
 * The `--config` refusal is the important part, and it is a refusal rather than
 * a warning on purpose: `issues.json` attributes nothing, so a config filter
 * over it matches zero rows for every input. Printing an empty table would be a
 * confidently wrong answer, which is the failure mode this project keeps
 * producing.
 */
async function loadTreeQuery(
    context: CommandContext,
    args: ParsedArgs,
    commandName: string
): Promise<TreeQuery> {
    const harness: Harness = context.globals.harness ?? 'xpcshell';
    progress(context, `Reading ${harness}-issues.json…`);
    const { file } = await loadIssues(context, harness);

    if (
        (context.globals.config.length > 0 || context.globals.excludeConfig.length > 0) &&
        !canAttributeConfigs(file)
    ) {
        throw usageError(
            `--config cannot be applied to ${harness}-issues.json: the file records no job ` +
                'names, so every configuration filter over it matches nothing',
            'This is a property of the file, not of the tree — it dropped all attribution to be ' +
                '2.8 MB. Use `fx-tests test <path> --config` for one test, which reads a bucket file.'
        );
    }

    const window = resolveDayWindow(context.globals, file);
    void commandName;
    return {
        harness,
        file,
        window,
        pathPrefix: stringOption(args, 'path'),
        component: stringOption(args, 'component'),
        header: {
            harness,
            family: file.family,
            startDate: window.startDate,
            endDate: window.endDate,
            dayCount: window.dayCount,
            singleDay: window.singleDay,
            testCount: file.testCount,
            dataSource: context.source.name,
            canAttributeConfigs: canAttributeConfigs(file),
            recordsMinidumps: recordsMinidumps(file),
        },
    };
}

/**
 * Whether a file's CRASH groups carry minidump IDs.
 *
 * `issues.json` does not — see `TreeHeader.recordsMinidumps`. Keyed on the
 * family rather than on whether any group happened to have one, because "this
 * file cannot record them" and "no crash in this window uploaded one" are
 * different answers and only the family distinguishes them reliably.
 */
function recordsMinidumps(file: DecodedTimingFile): boolean {
    return file.family !== 'issues';
}

/** The shared query options, as the `lib/query` functions take them. */
function sharedOptions(query: TreeQuery): {
    pathPrefix?: string;
    component?: string;
    dayRange?: { from: number; to: number };
} {
    return {
        ...(query.pathPrefix === undefined ? {} : { pathPrefix: query.pathPrefix }),
        ...(query.component === undefined ? {} : { component: query.component }),
        ...(query.window.range === null ? {} : { dayRange: query.window.range }),
    };
}

/** The header lines every tree-wide command prints. */
function headerLines(header: TreeHeader, subject: string, types?: readonly IssueType[]): string[] {
    const lines: string[] = [];
    lines.push(
        `${header.harness} ${subject} — ` +
            (header.singleDay
                ? dateWithWeekday(header.endDate)
                : `${header.dayCount} days (${dateWithWeekday(header.startDate)} … ` +
                  `${dateWithWeekday(header.endDate)})`) +
            `, ${fmtCount(header.testCount)} tests in the file`
    );
    if (types !== undefined) {
        // What "issue" means for this invocation. The count is a union over
        // four outcomes and `--type` changes it, so a reader comparing two runs
        // has to be able to see which population each one counted.
        lines.push(
            `  Counting ${types.join(', ')} as issues` +
                (types.length === DEFAULT_TYPES.length
                    ? ' (all four, as issues.html does; --type narrows it).'
                    : ' (--type changed this from the default of all four).')
        );
    }
    if (!header.canAttributeConfigs) {
        // Stated up front rather than only when someone asks for a config:
        // a reader comparing this against `fx-tests test` needs to know the two
        // files answer different questions.
        lines.push(
            '  This file records no job names, so nothing here can be broken down by ' +
                'configuration.'
        );
    }
    return lines;
}

// --- fx-tests issues -----------------------------------------------------

/** The `--json` shape for `issues`. */
export interface IssuesJson {
    header: TreeHeader;
    groupBy: string;
    sort: string;
    types: IssueType[];
    rowCount: number;
    rows: unknown[];
}

/** Runs `fx-tests issues`. */
export async function runIssues(context: CommandContext, args: ParsedArgs): Promise<void> {
    rejectPositionals(args, 'issues');
    const query = await loadTreeQuery(context, args, 'issues');

    const types = readTypes(args);
    const minRate = readPercent(stringOption(args, 'min-rate'), '--min-rate');
    // Both defaults are the dashboard's: `issues.html` hardcodes the components
    // view (`:888`) and sorts it by issue count (`:663`). The CLI used to lead
    // with a flat per-test list ranked by rate, which answers a question triage
    // asks second.
    const sort = readSort(args, ['issues', 'rate', 'count', 'name'], 'issues');
    const groupBy = readGroupBy(args, ['component', 'test', 'directory', 'message'], 'component');
    const limit = context.globals.limit ?? DEFAULT_LIMIT;

    // `--group-by message` is a different query, not a regrouping of the rows:
    // an `IssueRow` carries counts, not the messages behind them. `CLI.md` calls
    // it the "one bug, many tests" view and `failures.ts` is where it lives.
    if (groupBy === 'message') {
        const groups = groupFailuresByMessage(query.file, {
            ...sharedOptions(query),
            maxTestsPerGroup: maxTestsFor(context),
        });
        const shown = applyLimit(groups, limit);
        const result = {
            header: query.header,
            groupBy,
            sort,
            types,
            rowCount: groups.length,
            rows: shown.map(failureGroupJson),
        };
        emitResult(context, result, () => renderFailures(result, 'Issues by message'));
        return;
    }

    // The grouped views keep issue-free tests so a component's run total covers
    // its whole population, as the page's does; the per-test view drops them,
    // since a clean test is not a row anyone wants listed.
    const grouped = groupBy === 'component' || groupBy === 'directory';
    const rows = findIssues(query.file, {
        ...sharedOptions(query),
        types,
        ...(minRate === undefined ? {} : { minRate }),
        ...(grouped && minRate === undefined ? { keepClean: true } : {}),
    });

    if (grouped) {
        const groups = sortGroups(groupIssues(rows, groupBy, types), sort);
        const shown = applyLimit(groups, limit);
        const result = {
            header: query.header,
            groupBy,
            sort,
            types,
            rowCount: groups.length,
            rows: shown,
        };
        emitResult(context, result, () => renderIssueGroups(result));
        return;
    }

    const sorted = sortIssueRows(rows, sort);
    const shown = applyLimit(sorted, limit);
    const result = {
        header: query.header,
        groupBy,
        sort,
        types,
        rowCount: sorted.length,
        rows: shown.map(issueRowJson),
    };
    emitResult(context, result, () => renderIssueRows(result));
}

/** One issue row's JSON. */
function issueRowJson(row: IssueRow): Record<string, unknown> {
    return {
        // Always the whole path, never the shortened display form: `--json` is
        // the programmatic surface and a truncated identifier in it would be
        // useless to the caller that asked for JSON precisely to avoid parsing
        // the table.
        test: row.fullPath,
        directory: row.directory,
        component: row.component,
        runCount: row.runCount,
        passCount: row.passCount,
        failCount: row.failCount,
        timeoutCount: row.timeoutCount,
        crashCount: row.crashCount,
        skipCount: row.skipCount,
        failRate: row.failRate,
        /** The dashboard's issue total over the requested `--type`s. */
        issueCount: row.issueCount,
        issueRate: row.issueRate,
    };
}

/**
 * What `--sort count` ranks on, at both the row and the group level.
 *
 * All four outcomes, skips included. The two levels used to disagree — the row
 * sum included `skipCount` and the group sum did not — so `--sort count` ranked
 * by a different quantity depending on `--group-by`, with nothing in the output
 * saying so. Measured on the real file, the group order put Toolkit :: Telemetry
 * (6,815 non-pass without skips) above Firefox :: Address Bar, whose 21,120
 * issues are mostly its 15,107 skips.
 *
 * Skips are in because `--type` defaults to all four and the header calls them
 * issues: counting a skip as an issue and then excluding it from the "count"
 * ranking is not a distinction a reader can be expected to hold.
 *
 * This is the union over *every* outcome rather than over the requested
 * `--type`s, which is what makes it different from `issueCount` and so worth
 * offering as a separate sort at all: `--sort issues` already ranks by the
 * `--type` union.
 */
function nonPassCount(counts: {
    failCount: number;
    timeoutCount: number;
    crashCount: number;
    skipCount: number;
}): number {
    return counts.failCount + counts.timeoutCount + counts.crashCount + counts.skipCount;
}

/**
 * Sorts issue rows.
 *
 * Exported for the tests: the fixture's component ranking is the same under
 * either definition of `--sort count`, so nothing a command prints can pin the
 * comparator. `step5-query.test.ts` drives it with the discriminating input.
 */
export function sortIssueRows(rows: readonly IssueRow[], sort: string): IssueRow[] {
    const sorted = [...rows];
    if (sort === 'name') {
        sorted.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
    } else if (sort === 'count') {
        sorted.sort(
            (a, b) => nonPassCount(b) - nonPassCount(a) || a.fullPath.localeCompare(b.fullPath)
        );
    } else if (sort === 'issues') {
        // The per-test analogue of the component ranking, and the default here
        // too, so `--group-by test` and the default view agree on what "worst"
        // means. `findIssues` returns rate order, so this is a real re-sort.
        sorted.sort((a, b) => b.issueCount - a.issueCount || a.fullPath.localeCompare(b.fullPath));
    }
    // `rate` is `findIssues`' own order, so nothing to do.
    return sorted;
}

/** Sorts grouped rows. Exported for the same reason as `sortIssueRows`. */
export function sortGroups(groups: readonly IssueGroup[], sort: string): IssueGroup[] {
    const sorted = [...groups];
    if (sort === 'name') {
        sorted.sort((a, b) => a.key.localeCompare(b.key));
    } else if (sort === 'count') {
        // The same definition as the per-test view — see `nonPassCount()`.
        sorted.sort((a, b) => nonPassCount(b) - nonPassCount(a) || a.key.localeCompare(b.key));
    } else if (sort === 'rate') {
        sorted.sort((a, b) => b.issueRate - a.issueRate || a.key.localeCompare(b.key));
    }
    // `issues` is `groupIssues`' own order, so nothing to do.
    return sorted;
}

/** Renders the per-test issues table. */
function renderIssueRows(result: {
    header: TreeHeader;
    sort: string;
    types: readonly IssueType[];
    rowCount: number;
    rows: Record<string, unknown>[];
}): Rendered {
    // Which column the rows are ordered by, so the marker follows `--sort`
    // rather than asserting an order the command may not have produced.
    //
    // `count` has no entry on purpose, so it gets no marker: it orders by
    // fail+timeout+crash+skip, a sum no column shows. It used to mark `fail`,
    // which put a ▼ on a visibly non-monotone column — the first rows of
    // `--sort count` on the real file read 0, 0, 1, 0, 0 under `fail ▼`. A
    // marker pointing at a column the rows are not ordered by is worse than
    // none, since it is read as a claim about the order.
    const sortColumn: string | undefined = { issues: 'issues', rate: 'rate', name: 'Test' }[
        result.sort as 'issues' | 'rate' | 'name'
    ];
    const column = (header: string, rest: Omit<Column, 'header'> = {}): Column => ({
        header,
        ...rest,
        // `name` sorts ascending (A→Z); the numeric orders are descending.
        ...(header === sortColumn ? { sort: result.sort === 'name' ? 'asc' : 'desc' } : {}),
    });
    return {
        preamble: headerLines(result.header, 'issues by test', result.types),
        table: {
            // The path column is declared, not truncated by hand: `path: true`
            // sizes it to the longest path present and keeps the filename if a
            // cap ever bites. See `tableWithPaths()`.
            columns: [
                column('Test', { path: true }),
                column('issues', { align: 'right' }),
                column('runs', { align: 'right' }),
                column('fail', { align: 'right' }),
                column('timeout', { align: 'right' }),
                column('crash', { align: 'right' }),
                column('skip', { align: 'right' }),
                column('rate', { align: 'right' }),
            ],
            rows: result.rows.map((row) => [
                String(row.test),
                fmtCount(Number(row.issueCount)),
                fmtCount(Number(row.runCount)),
                fmtCount(Number(row.failCount)),
                fmtCount(Number(row.timeoutCount)),
                fmtCount(Number(row.crashCount)),
                fmtCount(Number(row.skipCount)),
                percent(Number(row.issueRate)),
            ]),
        },
        total: result.rowCount,
        shown: result.rows.length,
        epilogue: [],
        empty: emptyMessage(result.header, result.types),
    };
}

/** Renders the grouped issues table. */
function renderIssueGroups(result: {
    header: TreeHeader;
    groupBy: string;
    sort: string;
    types: readonly IssueType[];
    rowCount: number;
    rows: IssueGroup[];
}): Rendered {
    const keyHeader = result.groupBy === 'component' ? 'Component' : 'Directory';
    // No `count` entry, for the reason given in `renderIssueRows()`: the sum it
    // orders by is not one of these columns.
    const sortColumn: string | undefined = {
        issues: 'issues',
        rate: 'rate',
        name: keyHeader,
    }[result.sort as 'issues' | 'rate' | 'name'];
    const column = (header: string, rest: Omit<Column, 'header'> = {}): Column => ({
        header,
        ...rest,
        ...(header === sortColumn ? { sort: result.sort === 'name' ? 'asc' : 'desc' } : {}),
    });
    return {
        preamble: headerLines(result.header, `issues by ${result.groupBy}`, result.types),
        table: {
            // The page's per-component columns: the issue total it ranks on,
            // how many tests contributed, and the breakdown that says what kind
            // of issue they are.
            columns: [
                // A directory key is a path and gets the path treatment; a
                // component name ("Core :: Storage: IndexedDB") is not one.
                column(keyHeader, result.groupBy === 'directory' ? { path: true } : {}),
                column('issues', { align: 'right' }),
                // "with issues / in the component", as the page's "(393 tests
                // with issues, out of 402)". One number would hide whether a
                // component is broadly sick or has three bad tests.
                column('tests', { align: 'right' }),
                column('runs', { align: 'right' }),
                column('fail', { align: 'right' }),
                column('timeout', { align: 'right' }),
                column('crash', { align: 'right' }),
                column('skip', { align: 'right' }),
                column('rate', { align: 'right' }),
            ],
            rows: result.rows.map((group) => [
                group.key,
                fmtCount(group.issueCount),
                `${fmtCount(group.testCount)}/${fmtCount(group.totalTestCount)}`,
                fmtCount(group.runCount),
                fmtCount(group.failCount),
                fmtCount(group.timeoutCount),
                fmtCount(group.crashCount),
                fmtCount(group.skipCount),
                percent(group.issueRate),
            ]),
        },
        total: result.rowCount,
        shown: result.rows.length,
        // Suppressed when there is nothing to drill into: advice to narrow a
        // set that is already empty is worse than none.
        epilogue:
            result.rows.length === 0
                ? []
                : [
                      '  Drill in with --component "<name>", or --group-by test for the tests ' +
                          'themselves.',
                  ],
        empty: emptyMessage(result.header, result.types),
    };
}

/**
 * What to say when a filter matched nothing.
 *
 * "No test matched." alone leaves a reader unable to tell a healthy tree from a
 * mistyped `--path`, which are the two possibilities and want opposite actions.
 * So it names the population that *was* searched and the filters that could
 * have emptied it.
 */
function emptyMessage(
    header: TreeHeader,
    types?: readonly IssueType[],
    subject = 'test',
    extraFilters = ''
): string {
    const searched = `${fmtCount(header.testCount)} tests in ${header.harness}-issues.json`;
    const typeNote =
        types !== undefined && types.length < DEFAULT_TYPES.length
            ? ` Only ${types.join(', ')} counted as issues, so --type may be why.`
            : '';
    return (
        `No ${subject} matched. Searched ${searched} over ` +
        `${header.startDate} … ${header.endDate}.${typeNote}` +
        ` Check --path (a directory prefix)${extraFilters} and --component (a substring) ` +
        'for typos.'
    );
}

// --- fx-tests failures ---------------------------------------------------

/** Runs `fx-tests failures`. */
export async function runFailures(context: CommandContext, args: ParsedArgs): Promise<void> {
    rejectPositionals(args, 'failures');
    const query = await loadTreeQuery(context, args, 'failures');
    const limit = context.globals.limit ?? DEFAULT_LIMIT;

    const groups = groupFailuresByMessage(query.file, {
        ...sharedOptions(query),
        ...optional('message', stringOption(args, 'message')),
        maxTestsPerGroup: maxTestsFor(context),
    });
    const shown = applyLimit(groups, limit);
    const result = {
        header: query.header,
        groupBy: 'message',
        sort: 'count',
        types: ['fail'] as IssueType[],
        rowCount: groups.length,
        rows: shown.map(failureGroupJson),
    };
    emitResult(context, result, () =>
        renderFailures(result, 'failures by message', boolOption(args, 'tests'))
    );
}

/**
 * How many per-test rows to carry. `0` is uncapped, not empty.
 *
 * `--json` must not ship a `tests` array shorter than the `testCount` beside
 * it; only the text renderer has a width to run out of.
 */
function maxTestsFor(context: CommandContext): number {
    return context.globals.format === 'json' ? 0 : TEXT_MAX_TESTS_PER_GROUP;
}

/** How many tests one message's list shows in text, before `… n more`. */
const TEXT_MAX_TESTS_PER_GROUP = 50;

/** How few rows print the per-test list unasked. Matches `errors`. */
const AUTO_TESTS_ROW_LIMIT = 3;

/** One failure group's JSON. */
function failureGroupJson(group: FailureGroup): Record<string, unknown> {
    return {
        message: group.message,
        count: group.count,
        testCount: group.testCount,
        tests: group.tests.map((test) => ({ test: test.fullPath, count: test.count })),
        testsTruncated: group.testsTruncated,
        // A Set does not survive JSON.stringify; spelled out rather than
        // silently serializing as `{}`.
        jobNames: [...group.jobNames],
        taskIds: group.taskIds,
    };
}

/** Renders a message-grouped table. */
function renderFailures(
    result: { header: TreeHeader; rowCount: number; rows: Record<string, unknown>[] },
    subject: string,
    wantTests = false
): Rendered {
    return {
        preamble: headerLines(result.header, subject),
        // `tests` is the discriminator here for the same reason it is in
        // `errors`: one message across thirty tests is one bug, and across one
        // test is another kind of bug entirely.
        table: {
            columns: [
                // Ordered by total failing runs — the only order this command
                // offers, so the marker is unconditional.
                { header: 'failures', align: 'right', sort: 'desc' },
                { header: 'tests', align: 'right' },
                { header: 'message' },
            ],
            rows: result.rows.map((row) => [
                fmtCount(Number(row.count)),
                fmtCount(Number(row.testCount)),
                truncate(oneLine(String(row.message ?? '(no message recorded)')), 84),
            ]),
        },
        total: result.rowCount,
        shown: result.rows.length,
        epilogue: testListLines(result.rows, wantTests),
        empty: emptyMessage(result.header, undefined, 'failure', ', --message (a substring)'),
    };
}

/**
 * The per-message test lists, below the table.
 *
 * Paths print whole: this block exists because the table's `message` column
 * could not carry them, so `truncate` here would defeat it.
 */
function testListLines(rows: Record<string, unknown>[], wantTests: boolean): string[] {
    if (!wantTests && rows.length > AUTO_TESTS_ROW_LIMIT) {
        return [];
    }
    const lines: string[] = [];
    for (const row of rows) {
        const tests = row.tests as { test: string; count: number }[];
        if (tests.length === 0) {
            continue;
        }
        const testCount = Number(row.testCount);
        lines.push('');
        lines.push(
            `  ${fmtCount(Number(row.count))} failures in ${fmtCount(testCount)} test` +
                `${testCount === 1 ? '' : 's'} — ` +
                truncate(oneLine(String(row.message ?? '(no message recorded)')), 60)
        );
        for (const test of tests) {
            lines.push(`    ${fmtCount(test.count).padStart(7)}  ${test.test}`);
        }
        if (row.testsTruncated === true) {
            lines.push(
                `    … ${fmtCount(testCount - tests.length)} more tests (--json for all of them)`
            );
        }
    }
    return lines;
}

// --- fx-tests crashes ----------------------------------------------------

/** Runs `fx-tests crashes`. */
export async function runCrashes(context: CommandContext, args: ParsedArgs): Promise<void> {
    rejectPositionals(args, 'crashes');
    const query = await loadTreeQuery(context, args, 'crashes');
    const limit = context.globals.limit ?? DEFAULT_LIMIT;
    const wantMinidumps = boolOption(args, 'minidumps');
    if (wantMinidumps && !query.header.recordsMinidumps) {
        // Refused rather than printing an empty section, for the same reason
        // `--config` is: a flag that silently produces nothing is
        // indistinguishable from a window in which nothing crashed.
        throw usageError(
            `--minidumps cannot be answered from ${query.harness}-issues.json: its CRASH groups ` +
                'record signatures and counts but no minidump IDs',
            'This is a property of the file. `fx-tests test <path> --task-ids` reads a bucket ' +
                'file, which carries them.'
        );
    }

    const groups = groupCrashesBySignature(query.file, {
        ...sharedOptions(query),
        ...optional('signature', stringOption(args, 'signature')),
    });
    const shown = applyLimit(groups, limit);
    const result = {
        header: query.header,
        rowCount: groups.length,
        rows: shown.map((group) => crashGroupJson(group, wantMinidumps)),
    };
    emitResult(context, result, () => renderCrashes(result, wantMinidumps, query.header));
}

/** One crash group's JSON. */
function crashGroupJson(group: CrashGroup, withMinidumps: boolean): Record<string, unknown> {
    const json: Record<string, unknown> = {
        signature: group.signature,
        count: group.count,
        testCount: group.testCount,
        tests: group.tests.map((test) => ({ test: test.fullPath, count: test.count })),
        jobNames: [...group.jobNames],
        /** How many dumps this group has that can actually be fetched. */
        minidumpCount: group.minidumps.length,
    };
    if (withMinidumps) {
        json.minidumps = group.minidumps.map((dump) => ({
            taskId: dump.taskId,
            retryId: dump.retryId,
            minidumpId: dump.minidumpId,
            /** Copy-pasteable straight into `fx-tests crash`. */
            command: `fx-tests crash ${dump.taskId}.${dump.retryId} ${dump.minidumpId}`,
        }));
    }
    return json;
}

/** Renders the crashes table. */
function renderCrashes(
    result: { rowCount: number; rows: Record<string, unknown>[] },
    withMinidumps: boolean,
    header: TreeHeader
): Rendered {
    const epilogue: string[] = [];
    const anyDumps = result.rows.some((row) => Number(row.minidumpCount) > 0);

    if (!header.recordsMinidumps) {
        // The same shape of trap as `canAttributeConfigs`, and measured the
        // same way: `issues.json`'s CRASH groups carry `counts`, `days` and
        // `crashSignatureIds` and **no `minidumps` field at all** — 0 of 676
        // groups have one. So "0 dumps" here is not "the dumps were never
        // uploaded", it is "this file does not record them", and the two would
        // otherwise be indistinguishable.
        epilogue.push(
            '  This file records no minidump IDs, so the dumps column is 0 for every row — that'
        );
        epilogue.push(
            '  is a property of the file, not of the crashes. `fx-tests test <path> --task-ids`'
        );
        epilogue.push('  reads a bucket file, which does carry them.');
    } else if (withMinidumps) {
        epilogue.push('Minidumps');
        for (const row of result.rows) {
            const dumps = row.minidumps as { command: string }[] | undefined;
            if (dumps === undefined || dumps.length === 0) {
                continue;
            }
            epilogue.push(`  ${truncate(String(row.signature ?? '(not symbolized)'), 76)}`);
            for (const dump of dumps.slice(0, 3)) {
                epilogue.push(`    ${dump.command}`);
            }
            if (dumps.length > 3) {
                epilogue.push(`    … ${dumps.length - 3} more`);
            }
        }
    } else {
        // A group can legitimately have crashes and no dump even on a file that
        // records them: 58 mochitest entries in the sweep had a null signature
        // *and* a null minidump, the dump never having been uploaded.
        const noDumps = result.rows.filter((row) => Number(row.minidumpCount) === 0);
        if (noDumps.length > 0) {
            epilogue.push(
                `  ${noDumps.length} of these have no minidump to fetch: the dump was never ` +
                    'uploaded, so the crash is counted but cannot be read.'
            );
        }
        if (anyDumps) {
            epilogue.push('  --minidumps prints the IDs, which `fx-tests crash` reads.');
        }
    }

    return {
        preamble: headerLines(header, 'crashes by signature'),
        table: {
            columns: [
                // `groupCrashesBySignature()` orders by crash count descending.
                { header: 'crashes', align: 'right', sort: 'desc' },
                { header: 'tests', align: 'right' },
                { header: 'dumps', align: 'right' },
                { header: 'signature' },
            ],
            rows: result.rows.map((row) => [
                fmtCount(Number(row.count)),
                fmtCount(Number(row.testCount)),
                fmtCount(Number(row.minidumpCount)),
                truncate(String(row.signature ?? '(not symbolized)'), 76),
            ]),
        },
        total: result.rowCount,
        shown: result.rows.length,
        epilogue,
        empty: emptyMessage(header, undefined, 'crash', ', --signature (a substring)'),
    };
}

// --- fx-tests skips ------------------------------------------------------

/** Runs `fx-tests skips`. */
export async function runSkips(context: CommandContext, args: ParsedArgs): Promise<void> {
    rejectPositionals(args, 'skips');
    const query = await loadTreeQuery(context, args, 'skips');
    const limit = context.globals.limit ?? DEFAULT_LIMIT;
    const includeRunIf = boolOption(args, 'include-run-if');
    const groupBy = readGroupBy(args, ['test', 'component', 'directory'], 'test');

    const rows = findSkips(query.file, {
        ...sharedOptions(query),
        includeRunIf,
    });

    // The measured asymmetry: the 21-day aggregates already dropped `run-if`
    // upstream, so on this file the flag changes nothing. Saying which
    // population is being reported is the difference between "there are no
    // run-if skips" and "this file never had any to begin with".
    const runIfIsUpstreamFiltered = query.file.family !== 'daily';

    // `totalSkips` is over every matching test, not over the groups or the
    // limited page, so the two views agree on the population they summarise.
    const totalSkips = rows.reduce((sum, row) => sum + row.skipCount, 0);

    if (groupBy === 'component' || groupBy === 'directory') {
        // "which component disables the most tests" needs the group's whole
        // population as the denominator, the way `groupIssues` gets it from
        // `findIssues(keepClean)`: `findSkips` returns only tests with a skip,
        // so the count of tests that exist in the group has to come from the
        // file rather than from the rows.
        const groups = sortSkipGroups(
            groupSkips(rows, groupBy, testsPerGroup(query, groupBy)),
            'skips'
        );
        const shown = applyLimit(groups, limit);
        const result = {
            header: query.header,
            groupBy,
            includeRunIf,
            runIfIsUpstreamFiltered,
            rowCount: groups.length,
            totalSkips,
            skippedTestCount: rows.length,
            rows: shown.map(skipGroupJson),
        };
        emitResult(context, result, () => renderSkipGroups(result));
        return;
    }

    const sorted = [...rows].sort((a, b) => b.skipCount - a.skipCount);
    const shown = applyLimit(sorted, limit);
    const result = {
        header: query.header,
        groupBy,
        includeRunIf,
        runIfIsUpstreamFiltered,
        rowCount: sorted.length,
        totalSkips,
        skippedTestCount: sorted.length,
        rows: shown.map(skipRowJson),
    };
    emitResult(context, result, () => renderSkips(result));
}

/** A component's or directory's skips. */
interface SkipGroup {
    key: string;
    /** Skipped runs over every test in the group. */
    skipCount: number;
    /** Tests in the group with at least one skip. */
    testCount: number;
    /** Every test in the group, skip-free ones included. */
    totalTestCount: number;
    /** The distinct skip conditions, most-skipped first. */
    messages: { message: string; count: number }[];
}

/**
 * How many tests exist under each key, skip-free ones included.
 *
 * Counted over the file with the command's own `--path`/`--component` filters,
 * because the "N/M tests" column is only meaningful against the population the
 * query was scoped to. `findSkips` cannot supply the M: it drops every test with
 * no skip, which is most of them.
 */
function testsPerGroup(query: TreeQuery, by: 'component' | 'directory'): Map<string, number> {
    const totals = new Map<string, number>();
    for (let testId = 0; testId < query.file.testCount; testId++) {
        const identity = query.file.testAt(testId);
        if (query.pathPrefix !== undefined && !identity.fullPath.startsWith(query.pathPrefix)) {
            continue;
        }
        if (query.component !== undefined) {
            const component = identity.component;
            if (
                component === null ||
                !component.toLowerCase().includes(query.component.toLowerCase())
            ) {
                continue;
            }
        }
        const key =
            by === 'component' ? (identity.component ?? '(no component)') : identity.directory;
        totals.set(key, (totals.get(key) ?? 0) + 1);
    }
    return totals;
}

/** Groups skip rows by component or directory. */
function groupSkips(
    rows: readonly SkipRow[],
    by: 'component' | 'directory',
    totals: ReadonlyMap<string, number>
): SkipGroup[] {
    const groups = new Map<string, SkipGroup & { byMessage: Map<string, number> }>();
    for (const row of rows) {
        const key = by === 'component' ? (row.component ?? '(no component)') : row.directory;
        let group = groups.get(key);
        if (group === undefined) {
            group = {
                key,
                skipCount: 0,
                testCount: 0,
                totalTestCount: totals.get(key) ?? 0,
                messages: [],
                byMessage: new Map(),
            };
            groups.set(key, group);
        }
        group.skipCount += row.skipCount;
        group.testCount += 1;
        for (const [message, count] of row.messages) {
            group.byMessage.set(message, (group.byMessage.get(message) ?? 0) + count);
        }
    }
    const out: SkipGroup[] = [];
    for (const group of groups.values()) {
        const { byMessage, ...rest } = group;
        out.push({
            ...rest,
            messages: [...byMessage]
                .map(([message, count]) => ({ message, count }))
                .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message)),
        });
    }
    return out;
}

/** Sorts skip groups. Only the one order for now, as the per-test view has. */
function sortSkipGroups(groups: readonly SkipGroup[], sort: 'skips'): SkipGroup[] {
    void sort;
    return [...groups].sort((a, b) => b.skipCount - a.skipCount || a.key.localeCompare(b.key));
}

/** One skip group's JSON. */
function skipGroupJson(group: SkipGroup): Record<string, unknown> {
    return {
        key: group.key,
        skipCount: group.skipCount,
        testCount: group.testCount,
        totalTestCount: group.totalTestCount,
        messages: group.messages,
    };
}

/**
 * Renders the grouped skips table.
 *
 * The columns follow `renderIssueGroups`: the key, the quantity the rows are
 * ranked on, then "N/M tests" for how much of the group is affected. That last
 * one is what separates "this component disabled three tests a lot" from "this
 * component is switched off", and one number cannot say which — the same reason
 * `issues` shows it. The reason column stays because the conditions are the
 * actionable part of a skip, aggregated over the group rather than per test.
 */
function renderSkipGroups(result: {
    header: TreeHeader;
    groupBy: string;
    includeRunIf: boolean;
    runIfIsUpstreamFiltered: boolean;
    rowCount: number;
    totalSkips: number;
    skippedTestCount: number;
    rows: Record<string, unknown>[];
}): Rendered {
    const keyHeader = result.groupBy === 'component' ? 'Component' : 'Directory';
    return {
        preamble: skipsPreamble(result, `skips by ${result.groupBy}`),
        table: {
            columns: [
                {
                    header: keyHeader,
                    ...(result.groupBy === 'directory' ? { path: true } : {}),
                },
                // Ordered by skipped runs; the only order this view offers, so
                // the marker is unconditional as it is on the per-test table.
                { header: 'skips', align: 'right', sort: 'desc' },
                { header: 'tests', align: 'right' },
                { header: 'reason' },
            ],
            rows: result.rows.map((row) => {
                const messages = row.messages as { message: string; count: number }[];
                return [
                    String(row.key),
                    fmtCount(Number(row.skipCount)),
                    `${fmtCount(Number(row.testCount))}/${fmtCount(Number(row.totalTestCount))}`,
                    truncate(oneLine(messages[0]?.message ?? '(no reason recorded)'), 50) +
                        (messages.length > 1 ? ` (+${messages.length - 1} more)` : ''),
                ];
            }),
        },
        total: result.rowCount,
        shown: result.rows.length,
        epilogue:
            result.rows.length === 0
                ? []
                : [
                      '  Drill in with --component "<name>", or --group-by test for the tests ' +
                          'themselves.',
                  ],
        empty: emptyMessage(result.header, undefined, 'skipped test'),
    };
}

/** One skip row's JSON. */
function skipRowJson(row: SkipRow): Record<string, unknown> {
    return {
        test: row.fullPath,
        directory: row.directory,
        component: row.component,
        skipCount: row.skipCount,
        // Maps and Sets do not survive JSON.stringify.
        messages: [...row.messages].map(([message, count]) => ({ message, count })),
        jobNames: [...row.jobNames],
    };
}

/**
 * The header and population statement both skips views print.
 *
 * Shared so the two cannot drift on which run-if population they claim to be
 * reporting — that statement is the whole point of tracking
 * `runIfIsUpstreamFiltered`, and a grouped view that dropped it would be the
 * same "excluded 0" ambiguity in a different table.
 */
function skipsPreamble(
    result: {
        header: TreeHeader;
        includeRunIf: boolean;
        runIfIsUpstreamFiltered: boolean;
        totalSkips: number;
        /**
         * Tests with a skip. Passed rather than read off `rowCount`, which is a
         * count of components in the grouped view — "across 137 tests" of a
         * component count would be a wrong number stated confidently.
         */
        skippedTestCount: number;
    },
    subject: string
): string[] {
    const preamble = headerLines(result.header, subject);
    preamble.push(
        `  ${fmtCount(result.totalSkips)} skipped runs across ` +
            `${fmtCount(result.skippedTestCount)} tests.`
    );
    if (result.runIfIsUpstreamFiltered) {
        preamble.push(
            '  This is a 21-day aggregate, and the generator already dropped run-if skips from it,'
        );
        preamble.push(
            '  so --include-run-if would change nothing here. A daily file keeps them — on one'
        );
        preamble.push('  measured day they were 63.6% of all skipped runs.');
    } else if (result.includeRunIf) {
        preamble.push(
            '  Including run-if skips, which mean "not applicable on this platform" rather than'
        );
        preamble.push('  "disabled".');
    } else {
        preamble.push(
            '  Excluding run-if skips, which mean "not applicable on this platform" rather than'
        );
        preamble.push('  "disabled" (--include-run-if to keep them).');
    }
    return preamble;
}

/** Renders the skips table. */
function renderSkips(result: {
    header: TreeHeader;
    includeRunIf: boolean;
    runIfIsUpstreamFiltered: boolean;
    rowCount: number;
    totalSkips: number;
    skippedTestCount: number;
    rows: Record<string, unknown>[];
}): Rendered {
    return {
        preamble: skipsPreamble(result, 'skips'),
        table: {
            columns: [
                { header: 'Test', path: true },
                // `findSkips()` orders by skip count descending.
                { header: 'skips', align: 'right', sort: 'desc' },
                { header: 'reason' },
            ],
            rows: result.rows.map((row) => {
                const messages = row.messages as { message: string; count: number }[];
                return [
                    String(row.test),
                    fmtCount(Number(row.skipCount)),
                    truncate(oneLine(messages[0]?.message ?? '(no reason recorded)'), 50) +
                        (messages.length > 1 ? ` (+${messages.length - 1} more)` : ''),
                ];
            }),
        },
        total: result.rowCount,
        shown: result.rows.length,
        epilogue: [],
        empty: emptyMessage(result.header, undefined, 'skipped test'),
    };
}

// --- shared helpers ------------------------------------------------------

/** Only sets a key when the value is present. */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
    return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** These commands take no positionals; a stray one is usually a missing flag. */
function rejectPositionals(args: ParsedArgs, name: string): void {
    if (args.positionals.length > 0) {
        throw usageError(
            `${name} takes no positional arguments, got "${args.positionals[0]}"`,
            `Did you mean --path ${args.positionals[0]} or --component "${args.positionals[0]}"?`
        );
    }
}

/** Reads and validates `--type`. */
function readTypes(args: ParsedArgs): IssueType[] {
    const values = listOption(args, 'type');
    if (values.length === 0) {
        // All four, as the dashboard's checkboxes all start checked.
        return [...DEFAULT_TYPES];
    }
    const allowed: IssueType[] = ['fail', 'timeout', 'crash', 'skip'];
    for (const value of values) {
        if (!(allowed as string[]).includes(value)) {
            throw usageError(`--type expects one of ${allowed.join(', ')}, got "${value}"`);
        }
    }
    return values as IssueType[];
}

/** Reads and validates `--sort`. */
function readSort(args: ParsedArgs, allowed: readonly string[], fallback: string): string {
    const value = stringOption(args, 'sort') ?? fallback;
    if (!allowed.includes(value)) {
        throw usageError(`--sort expects one of ${allowed.join(', ')}, got "${value}"`);
    }
    return value;
}

/** Reads and validates `--group-by`. */
function readGroupBy(args: ParsedArgs, allowed: readonly string[], fallback: string): string {
    const value = stringOption(args, 'group-by') ?? fallback;
    if (!allowed.includes(value)) {
        throw usageError(`--group-by expects one of ${allowed.join(', ')}, got "${value}"`);
    }
    return value;
}

/**
 * Reads a percentage option.
 *
 * A string rather than a `number` option because `--min-rate 0.5` is a
 * perfectly reasonable thing to type and the number parser rejects
 * non-integers.
 */
function readPercent(value: string | undefined, flag: string): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        throw usageError(`${flag} expects a percentage between 0 and 100, got "${value}"`);
    }
    return parsed;
}

/**
 * What a tree-wide command produces, before it is laid out.
 *
 * Separating the content from the layout is what lets one renderer serve both
 * text and Markdown. The alternative — render text and fence it for
 * `--markdown` — is what these four used to do, and it made them the only
 * commands in the CLI whose `--markdown` was not real Markdown: someone pasting
 * `manifests` and `issues` into one bug got a table and a code block.
 */
interface Rendered {
    /** Lines above the table: the provenance header and any caveats. */
    preamble: string[];
    /** The table, or `null` for a command that has nothing to show. */
    table: { columns: Column[]; rows: string[][] } | null;
    /** The `… n more` line's inputs. */
    total: number;
    shown: number;
    /** Lines below the table. */
    epilogue: string[];
    /** Shown instead of the table when there are no rows. */
    empty: string;
}

/** Emits in whichever format was asked for. */
function emitResult(context: CommandContext, result: unknown, build: () => Rendered): void {
    if (context.globals.format === 'json') {
        emit(context, toJson(result));
        return;
    }
    const content = build();
    emit(
        context,
        context.globals.format === 'markdown'
            ? renderMarkdownFrom(content)
            : renderTextFrom(content)
    );
}

/** Plain text: the shared aligned-column layout. */
function renderTextFrom(content: Rendered): string {
    const lines: (string | null)[] = [...content.preamble, ''];
    if (content.table === null || content.table.rows.length === 0) {
        lines.push(content.empty);
    } else {
        // `tableSection` renders the table, the `… n more` line and the
        // full-path recovery block together: a path column cannot be shortened
        // here without the whole value being printed back.
        lines.push(...tableSection(content.table.columns, content.table.rows, content));
    }
    lines.push(...content.epilogue);
    return joinLines(lines);
}

/**
 * Markdown: a real table, matching every other command.
 *
 * The preamble becomes prose rather than staying inside a fence, so a pasted
 * report reads as a report. `md.table` escapes cell contents, which matters
 * here because a failure message can contain a pipe.
 */
function renderMarkdownFrom(content: Rendered): string {
    const lines: (string | null)[] = [];
    const [heading, ...caveats] = content.preamble;
    lines.push(md.heading(heading ?? 'Results', 1));
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

/** Collapses a multi-line message onto one line. */
function oneLine(value: string): string {
    return value.replace(/\s*\r?\n\s*/g, ' ⏎ ').trim();
}

/** Re-exported so `configFilter` stays reachable if a bucket-backed mode lands. */
export { configFilter };
