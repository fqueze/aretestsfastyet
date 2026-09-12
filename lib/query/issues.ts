/**
 * Tree-wide triage: what is failing, across every test in a file.
 *
 * Behind `fx-tests issues`. Where `test-stats.ts` answers about one test, this
 * walks every test in the file once and reports the ones that are not clean,
 * grouped however the caller asks.
 *
 * ## One pass, integer accumulators
 *
 * `PLAN.md` §4 is specific about this: aggregate in a single pass over
 * integer-indexed arrays rather than materializing per-occurrence objects. A
 * 21-day aggregate holds ~40M xpcshell runs and ~172M mochitest ones, so an
 * object per run is not viable. Each test contributes one row with six
 * counters, and rows are dropped as soon as they are known to be uninteresting.
 *
 * ## What "the population" is, and why this file will not mix families
 *
 * `FORMATS.md` measures that `issues.json`, `issues-with-taskids.json` and the
 * 64 bucket files are three encodings of the *same* 21 days: adding their
 * totals multiplies the population by the number of encodings, and an earlier
 * revision of that document quoted a figure 4× too large by doing exactly
 * that. Two agents have made the same mistake.
 *
 * The defence here is structural rather than documentary: every function takes
 * **one** `DecodedTimingFile`. There is no parameter to pass a second file
 * through, so there is no summing across families to get wrong. A caller that
 * wants both must call twice and compare, which is the operation that makes
 * sense — and even then, `FORMATS.md` now measures that the daily files and the
 * aggregates disagree on job membership as well as on skips, so the comparison
 * is not apples to apples either.
 */

import type { DecodedTimingFile } from '../formats/decode.ts';
import { classifyStatus } from '../model/status.ts';
import { skipReason } from '../model/skips.ts';
import { inDayRange } from './test-stats.ts';

/** One test's tree-wide row. */
export interface IssueRow {
    testId: number;
    fullPath: string;
    directory: string;
    component: string | null;
    /** Runs that reached a verdict. */
    runCount: number;
    passCount: number;
    failCount: number;
    timeoutCount: number;
    crashCount: number;
    expectedFailCount: number;
    /** Skipped runs, `run-if` excluded. */
    skipCount: number;
    /** `(fail + timeout + crash) / runCount * 100`, or 0 when nothing ran. */
    failRate: number;
    /**
     * Non-passing runs of the requested types — the dashboard's `issueCount`.
     *
     * `old/issues.html:1071-1076` computes exactly this: the sum of `skipCount`,
     * `failCount`, `timeoutCount` and `crashCount` over the *enabled* issue-type
     * checkboxes, all four of which are checked by default (`:626-638`). It is a
     * count of runs, not of tests, and it is what the page's default ranking
     * sorts on.
     */
    issueCount: number;
    /**
     * `issueCount` as a percentage of the runs it could have come from.
     *
     * The denominator is the dashboard's (`:1079`): `runCount` excludes skips,
     * so skipped runs are added back only when skips are one of the requested
     * types. Otherwise a skip would inflate the numerator and be missing from
     * the denominator.
     */
    issueRate: number;
}

/** Which non-passing outcomes a query is interested in. */
export type IssueType = 'fail' | 'timeout' | 'crash' | 'skip';

/** Options for `findIssues`. */
export interface IssuesOptions {
    /** Only tests whose path starts with this. `CLI.md`'s `--path`. */
    pathPrefix?: string | undefined;
    /** Only tests whose component contains this, case-insensitively. */
    component?: string | undefined;
    /**
     * Which outcomes count as an issue. Default: **all four**.
     *
     * This mirrors `issues.html`, whose four "Count as issues" checkboxes —
     * failures, timeouts, crashes and skips — are every one of them `checked`
     * on load (`:626-638`). Excluding skips here would rank components against
     * a different definition of "issue" than the dashboard the CLI is supposed
     * to agree with, and skips are the largest of the four in this data.
     */
    types?: readonly IssueType[] | undefined;
    /** Drop tests below this failure rate, in percent. */
    minRate?: number | undefined;
    /**
     * Keep tests with no issue at all, rather than dropping them.
     *
     * The grouped views need them: `issues.html` accumulates a component's
     * `runCount` over **every** test in it (`:2010`) and only then decides
     * which tests to list (`:2016`), so a component's denominator includes its
     * clean tests. Dropping them first inflates the issue rate — measured on
     * WebExtensions :: General, 6,087,719 runs instead of 6,131,520, turning
     * 8.7% into 8.8%.
     */
    keepClean?: boolean | undefined;
    /** Drop tests with fewer than this many matching occurrences. */
    minCount?: number | undefined;
    /** Restrict to a day range, as absolute day indices. Both ends inclusive. */
    dayRange?: { from: number; to: number } | undefined;
}

/**
 * Every issue type, matching the dashboard's four checkboxes, all of which
 * default to checked (`old/issues.html:626-638`).
 */
export const DEFAULT_TYPES: readonly IssueType[] = ['fail', 'timeout', 'crash', 'skip'];

/**
 * Every test in the file with a non-passing outcome, sorted by descending
 * failure rate.
 *
 * Sorting is by rate rather than by count because a count ranks the tests that
 * run most, not the ones that are worst — `CLI.md` offers `--sort count` for
 * when the opposite is wanted, and that is the caller's re-sort of this array.
 */
export function findIssues(
    file: DecodedTimingFile,
    options: IssuesOptions = {}
): IssueRow[] {
    const types = new Set(options.types ?? DEFAULT_TYPES);
    const rows: IssueRow[] = [];

    for (let testId = 0; testId < file.testCount; testId++) {
        const identity = file.testAt(testId);
        if (options.pathPrefix !== undefined && !identity.fullPath.startsWith(options.pathPrefix)) {
            continue;
        }
        if (options.component !== undefined) {
            const component = identity.component;
            if (
                component === null ||
                !component.toLowerCase().includes(options.component.toLowerCase())
            ) {
                continue;
            }
        }

        const row: IssueRow = {
            testId,
            fullPath: identity.fullPath,
            directory: identity.directory,
            component: identity.component,
            runCount: 0,
            passCount: 0,
            failCount: 0,
            timeoutCount: 0,
            crashCount: 0,
            expectedFailCount: 0,
            skipCount: 0,
            failRate: 0,
            issueCount: 0,
            issueRate: 0,
        };

        for (const entry of file.runsOfTest(testId)) {
            if (!inDayRange(entry.day, options.dayRange)) {
                continue;
            }
            switch (classifyStatus(entry.status).kind) {
                case 'pass':
                    row.passCount += entry.count;
                    break;
                case 'fail':
                    row.failCount += entry.count;
                    break;
                case 'timeout':
                    row.timeoutCount += entry.count;
                    break;
                case 'crash':
                    row.crashCount += entry.count;
                    break;
                case 'expected-fail':
                    row.expectedFailCount += entry.count;
                    break;
                case 'skip':
                    if (skipReason(entry.message) !== 'run-if') {
                        row.skipCount += entry.count;
                    }
                    break;
                case 'unknown':
                    break;
            }
        }

        row.runCount =
            row.passCount +
            row.failCount +
            row.timeoutCount +
            row.crashCount +
            row.expectedFailCount;
        const nonPass = row.failCount + row.timeoutCount + row.crashCount;
        row.failRate = row.runCount > 0 ? (nonPass / row.runCount) * 100 : 0;

        // The dashboard's `issueCount`/`issuePercentage`, `old/issues.html:1071-1080`.
        row.issueCount = issueCountOf(row, types);
        const rateDenominator = row.runCount + (types.has('skip') ? row.skipCount : 0);
        row.issueRate = rateDenominator > 0 ? (row.issueCount / rateDenominator) * 100 : 0;

        if (row.issueCount === 0 && options.keepClean !== true) {
            continue;
        }
        if (options.minCount !== undefined && row.issueCount < options.minCount) {
            continue;
        }
        if (options.minRate !== undefined && row.failRate < options.minRate) {
            continue;
        }
        rows.push(row);
    }

    rows.sort((a, b) => b.failRate - a.failRate || a.fullPath.localeCompare(b.fullPath));
    return rows;
}

/**
 * The dashboard's `issueCount` for one row, over the enabled types.
 *
 * Shared by the row and the group so the two cannot disagree about what an
 * issue is — a group total that counted different outcomes than its rows would
 * rank components against a definition nothing else uses.
 */
function issueCountOf(
    counts: { failCount: number; timeoutCount: number; crashCount: number; skipCount: number },
    types: ReadonlySet<IssueType>
): number {
    return (
        (types.has('skip') ? counts.skipCount : 0) +
        (types.has('fail') ? counts.failCount : 0) +
        (types.has('timeout') ? counts.timeoutCount : 0) +
        (types.has('crash') ? counts.crashCount : 0)
    );
}

/** A group of issue rows sharing a key. */
export interface IssueGroup {
    /** The component, directory, or whatever the rows were grouped by. */
    key: string;
    /**
     * How many distinct tests in the group have at least one issue.
     *
     * The page's "N tests with issues, out of M" (`:2106`); `totalTestCount` is
     * the M. The two differ and the difference is the point — 393 of 402 is a
     * component in trouble, 3 of 402 is three bad tests.
     */
    testCount: number;
    /** Every test in the group, issue-free ones included. */
    totalTestCount: number;
    runCount: number;
    failCount: number;
    timeoutCount: number;
    crashCount: number;
    skipCount: number;
    failRate: number;
    /** Sum of the rows' `issueCount` — the page's per-component total. */
    issueCount: number;
    /** `issueCount` over the same denominator the page uses (`:2046-2048`). */
    issueRate: number;
}

/**
 * Groups issue rows by component or directory, ranked by issue count.
 *
 * This is `fx-tests issues`' default view and it mirrors `issues.html`, which
 * hardcodes the components view (`:888`, "Always use components view for issues
 * page"), accumulates the same per-component totals (`:2007-2013`) and sorts by
 * `issueCount` descending (`:663`, `sortField = 'issueCount'`).
 *
 * The ordering is the substance, not a presentation detail: triage starts by
 * finding the area worth looking at. A flat per-test list ranked by rate makes
 * the reader do that aggregation themselves, which is what "a few random tests"
 * meant when the owner read it.
 *
 * Grouping by *message* is a different operation — it needs the messages, which
 * a row does not carry — and lives in `failures.ts`.
 *
 * **Both keys are now a page control as well as a CLI flag.**
 * `site/issues.html`'s "Show as" radios call this with `component` for
 * "bugzilla components" and `directory` for "source tree"
 * (`site/issues-view.ts:groupingOf`), so the two sides group by the same key
 * through the same function rather than agreeing by coincidence. The `:888`
 * hard-coding above describes the pre-migration page; `component` is still the
 * default on both sides.
 */
export function groupIssues(
    rows: Iterable<IssueRow>,
    by: 'component' | 'directory',
    types: readonly IssueType[] = DEFAULT_TYPES
): IssueGroup[] {
    const enabled = new Set(types);
    const groups = new Map<string, IssueGroup>();
    for (const row of rows) {
        const key = by === 'component' ? (row.component ?? '(no component)') : row.directory;
        let group = groups.get(key);
        if (group === undefined) {
            group = {
                key,
                testCount: 0,
                totalTestCount: 0,
                runCount: 0,
                failCount: 0,
                timeoutCount: 0,
                crashCount: 0,
                skipCount: 0,
                failRate: 0,
                issueCount: 0,
                issueRate: 0,
            };
            groups.set(key, group);
        }
        // Runs accumulate over every test, `testCount` only over those with an
        // issue — the page's order of operations (`:2010` before `:2016`), and
        // what keeps a component's rate over its whole population.
        group.totalTestCount += 1;
        if (row.issueCount > 0) {
            group.testCount += 1;
        }
        group.runCount += row.runCount;
        group.failCount += row.failCount;
        group.timeoutCount += row.timeoutCount;
        group.crashCount += row.crashCount;
        group.skipCount += row.skipCount;
    }
    // A group whose every test is clean is not a triage row. It can only arise
    // when the caller passed `keepClean` to get honest denominators.
    const out = [...groups.values()].filter((group) => group.testCount > 0);
    for (const group of out) {
        const nonPass = group.failCount + group.timeoutCount + group.crashCount;
        group.failRate = group.runCount > 0 ? (nonPass / group.runCount) * 100 : 0;
        // Recomputed from the group's own totals rather than summed from the
        // rows, so it is the same function of the same counters at both levels.
        group.issueCount = issueCountOf(group, enabled);
        const denominator = group.runCount + (enabled.has('skip') ? group.skipCount : 0);
        group.issueRate = denominator > 0 ? (group.issueCount / denominator) * 100 : 0;
    }
    out.sort((a, b) => b.issueCount - a.issueCount || a.key.localeCompare(b.key));
    return out;
}

/** What is skipped where — behind `fx-tests skips`. */
export interface SkipRow {
    testId: number;
    fullPath: string;
    directory: string;
    component: string | null;
    /** Skipped runs, `run-if` excluded unless `includeRunIf`. */
    skipCount: number;
    /** Skip conditions in display form, with counts. */
    messages: Map<string, number>;
    /** Configurations the test was skipped on, where the file attributes them. */
    jobNames: Set<string>;
}

/** Options for `findSkips`. */
export interface SkipsOptions {
    pathPrefix?: string | undefined;
    component?: string | undefined;
    /**
     * Keep `run-if` skips too. `CLI.md`'s `--include-run-if`.
     *
     * Off by default because a `run-if` means the test is scoped to another
     * platform, so it not running here is the annotation working rather than
     * something disabled. Note the asymmetry `FORMATS.md` measures: on a
     * 21-day aggregate this flag changes nothing at all, because the generator
     * already dropped them, while on a daily file it changes the count by up
     * to 2.7×.
     */
    includeRunIf?: boolean | undefined;
    dayRange?: { from: number; to: number } | undefined;
}

/** Every skipped test in the file, sorted by descending skip count. */
export function findSkips(file: DecodedTimingFile, options: SkipsOptions = {}): SkipRow[] {
    const rows: SkipRow[] = [];
    for (let testId = 0; testId < file.testCount; testId++) {
        const identity = file.testAt(testId);
        if (options.pathPrefix !== undefined && !identity.fullPath.startsWith(options.pathPrefix)) {
            continue;
        }
        if (options.component !== undefined) {
            const component = identity.component;
            if (
                component === null ||
                !component.toLowerCase().includes(options.component.toLowerCase())
            ) {
                continue;
            }
        }

        const row: SkipRow = {
            testId,
            fullPath: identity.fullPath,
            directory: identity.directory,
            component: identity.component,
            skipCount: 0,
            messages: new Map(),
            jobNames: new Set(),
        };

        for (const entry of file.runsOfTest(testId)) {
            if (!inDayRange(entry.day, options.dayRange)) {
                continue;
            }
            if (classifyStatus(entry.status).kind !== 'skip') {
                continue;
            }
            const reason = skipReason(entry.message);
            if (reason === 'run-if' && !options.includeRunIf) {
                continue;
            }
            row.skipCount += entry.count;
            if (entry.message) {
                const display = entry.message.replace(/^skip-if:\s*/, '');
                row.messages.set(display, (row.messages.get(display) ?? 0) + entry.count);
            }
            if (entry.jobName !== undefined) {
                row.jobNames.add(entry.jobName);
            }
        }

        if (row.skipCount > 0) {
            rows.push(row);
        }
    }
    rows.sort((a, b) => b.skipCount - a.skipCount || a.fullPath.localeCompare(b.fullPath));
    return rows;
}
