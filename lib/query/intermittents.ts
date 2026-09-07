/**
 * Ranking sheriff-annotated intermittents by the test each bug names.
 *
 * `/failures/` ranks bugs tree-wide with no harness parameter, so "the top 20
 * mochitest intermittents" is not a query. A bug is a mochitest bug when its
 * **summary names a test path that the mochitest data actually holds** — the
 * same 21-day aggregates `fx-tests test` resolves against, read once for the
 * whole run. That is a fact about a published test list, not an inference from
 * a job name.
 *
 * The alternative, reading Treeherder's `test_suite`, describes the *job* that
 * ran rather than the test that failed, and it presents an infrastructure bug
 * that fires across every job — `[taskcluster:error] Task aborted` — as a
 * mochitest intermittent. Bugs whose summary names no verifiable test are
 * therefore not classified at all, and are reported separately.
 *
 * **The depth is `maxScan`, never the display limit.** Tying it to `--limit`
 * made `--limit 1` scan one candidate, so `--json` returned one row with no
 * fuller answer for `--limit 0` to reveal.
 */

import {
    type BugFailureCount,
    type BugOccurrence,
    UNKNOWN_TASK_ID,
    harnessOfOccurrence,
    stripSuiteChunk,
    summaryRemainder,
    testPathCandidates,
    testPathOfLine,
} from '../sources/intermittents.ts';
import { testInfoArtifactUrl } from '../links.ts';
import { type PartitionedMessages, partitionMarkerMessages } from '../model/marker-messages.ts';
import { dateOfDay } from './flakiness.ts';
import { configFilter } from './test-stats.ts';

/** Which harness a scan is looking for. */
export type ScanHarness = 'mochitest' | 'xpcshell';

/**
 * What `--harness` selects: a harness, or the bugs that named no known test.
 *
 * `unknown` is not a harness, and that is the point — it is the third value the
 * classification takes, so it belongs on the same axis rather than on a separate
 * switch. A row is mochitest, xpcshell or unknown; the filter picks one of the
 * three, or none of them and shows all.
 */
export type HarnessSelector = ScanHarness | 'unknown';

/** Which harness a path belongs to, from the published test lists. */
export type HarnessOfPath = (path: string) => ScanHarness | null;

/**
 * One ranked bug, whatever its classification.
 *
 * A single type rather than one for classified rows and one for the rest,
 * because with no `--harness` they share a list ordered by count. What separates
 * them is `harness`, an attribute of the row rather than a precondition for
 * having one.
 */
export interface RankedIntermittent {
    bugId: number;
    /** Jobs sheriffs annotated with this bug, in the window. Treeherder's own count. */
    count: number;
    /**
     * Which harness the summary's test path belongs to, or `unknown` when the
     * summary named no test this tool holds.
     */
    harness: HarnessSelector;
    /** The verified test path, or `null` on an `unknown` row. */
    test: string | null;
    /**
     * What to say about the failure.
     *
     * On a classified row, the summary with its triage prefix and the path
     * removed — the part the other columns do not already show. On an `unknown`
     * row there is no path to remove, so this is the whole summary minus the
     * prefix, and it is everything the row has.
     */
    failure: string;
    /**
     * The whole Bugzilla summary, as `failure` was cut out of it.
     *
     * Carried as well as `failure` because the two things `failure` strips —
     * the triage prefix (`Intermittent`, `Permanent`) and the test path — are
     * exactly what a caller reconstructing a bug reference needs, and the only
     * other way to get them is a Bugzilla request per bug. `null` when Bugzilla
     * returned no summary for the bug, which is distinct from an empty one.
     */
    bugSummary: string | null;
}

/** A name and how many occurrences carried it. */
export interface SuiteCount {
    name: string;
    count: number;
}

/** What the scan classified, in the window as a whole. */
export interface ScanCoverage {
    /** How many bugs the tree-wide ranking held, the no-bug group included. */
    ranked: number;
    /** How many of them carried a bug number and so could be classified. */
    scanned: number;
    /** How many named a verified mochitest test. */
    mochitest: number;
    /** How many named a verified xpcshell test. */
    xpcshell: number;
    /** How many named no test path this tool could verify. */
    unknown: number;
    /**
     * `/failures/`'s `{"bug_id": null}` group: annotations with no bug attached.
     *
     * Regularly the largest single group, and unclassifiable at any depth —
     * there is no bug, so there is no summary to read a test path from.
     */
    noBugCount: number;
}

/** A scan's result. */
export interface ScanResult {
    /** Every classified bug, count-descending, before any `--harness` filter. */
    rows: RankedIntermittent[];
    coverage: ScanCoverage;
}

/** What `scanBugs` needs from its caller. */
export interface ScanOptions {
    /** The tree-wide ranking from `/api/failures/`, count-descending. */
    ranking: readonly BugFailureCount[];
    /** Every candidate's Bugzilla summary, by bug number. */
    summaries: ReadonlyMap<number, string>;
    /** Which harness a path belongs to, from the published test lists. */
    harnessOfPath: HarnessOfPath;
}

/**
 * Classifies every bug in the ranking by the test its summary names.
 *
 * Classifies rather than filters: the `--harness` selection happens in
 * `selectHarness` afterwards, over the same rows. Splitting it that way is what
 * lets the unfiltered list rank classified and unknown bugs together — with the
 * filter inside the loop, a row had to be one or the other to exist at all.
 *
 * Synchronous, which is the shape worth noticing: classification costs no
 * per-bug request, so the whole ranking is classified rather than a prefix of
 * it. Only the `--bug` drill-down fetches per bug.
 */
export function scanBugs(options: ScanOptions): ScanResult {
    const { ranking, summaries, harnessOfPath } = options;

    const noBugCount = ranking
        .filter((row) => row.bugId === null)
        .reduce((sum, row) => sum + row.count, 0);
    // The no-bug group cannot be classified: there is no bug to read a summary
    // from. It is reported in the coverage instead.
    const candidates = ranking.filter(
        (row): row is BugFailureCount & { bugId: number } => row.bugId !== null
    );

    const rows: RankedIntermittent[] = candidates.map((candidate) => {
        const bugSummary = summaries.get(candidate.bugId) ?? null;
        const summary = bugSummary ?? '';
        // Only the first verified path is used. A summary naming two is rare —
        // one in a live top-80, a reftest comparing a file against its
        // reference — and neither of that pair is a test this tool holds, so
        // the case resolves as unknown anyway.
        const verified = testPathCandidates(summary)
            .map((path) => ({ path, harness: harnessOfPath(path) }))
            .find((entry) => entry.harness !== null);
        return verified === undefined
            ? {
                  bugId: candidate.bugId,
                  count: candidate.count,
                  harness: 'unknown' as const,
                  test: null,
                  failure: summaryRemainder(summary, null),
                  bugSummary,
              }
            : {
                  bugId: candidate.bugId,
                  count: candidate.count,
                  harness: verified.harness as ScanHarness,
                  test: verified.path,
                  failure: summaryRemainder(summary, verified.path),
                  bugSummary,
              };
    });

    // Already count-descending, since `/failures/` is and the count is
    // Treeherder's own. Sorted anyway so the order is this function's contract
    // rather than an upstream detail.
    const ordered = [...rows].sort((a, b) => b.count - a.count);
    const count = (harness: HarnessSelector): number =>
        ordered.filter((row) => row.harness === harness).length;
    return {
        rows: ordered,
        coverage: {
            ranked: ranking.length,
            scanned: candidates.length,
            mochitest: count('mochitest'),
            xpcshell: count('xpcshell'),
            unknown: count('unknown'),
            noBugCount,
        },
    };
}

/**
 * The rows one `--harness` selects, or all of them when none was given.
 *
 * Separate from `scanBugs` so that "what is this bug" and "which of them do I
 * want" stay separate questions. The unfiltered answer is the whole ranking,
 * which is the honest default: the tool ranks what sheriffs annotated, and the
 * harness is one column of that.
 */
export function selectHarness(
    rows: readonly RankedIntermittent[],
    harness: HarnessSelector | undefined
): RankedIntermittent[] {
    return harness === undefined ? [...rows] : rows.filter((row) => row.harness === harness);
}

/**
 * The scanned rows whose bug summary names one exact test path.
 *
 * The one path→bug selection in this tool. `intermittent --test` reaches it and
 * so does `fx-tests test`'s "Bugs naming this test" block, and a second
 * resolver would agree today and drift the first time `scanBugs` learns a new
 * summary shape.
 *
 * Here rather than in a command module because two commands need it and
 * `lib/` is where shared code lives — the same rule that put `selectHarness`
 * here, which this sits beside and mirrors: both are pure selections over
 * `scanBugs`'s output, taking rows and returning rows.
 *
 * **Exact match only.** A directory prefix would select several tests, and
 * several tests have no single bug to drill into. Count-descending, inherited
 * from `scanBugs`, since a filter preserves order. Empty when nothing names the
 * path, which is a normal answer rather than an error: the caller decides
 * whether that is exit 2 or a block it does not print.
 *
 * The I/O this needs — the ranking, the summaries, the harness classifier — is
 * the caller's to fetch, which is what keeps this side of the seam free of
 * `CommandContext`, progress reporting and CLI exit codes.
 */
export function bugsNamingTest(
    rows: readonly RankedIntermittent[],
    test: string
): RankedIntermittent[] {
    return rows.filter((row) => row.test === test);
}

/**
 * Counts, per test path, how many occurrences named it — not how many lines.
 *
 * A job emits the marker once per failing assertion, so counting lines can
 * report a path many times more often than the population it is drawn from,
 * beside columns that are per occurrence.
 *
 * Reads the partitioned messages, not `lines`, for the reason the
 * failure-message tally does: a `profile uploaded in …` notice carries the
 * `TEST-UNEXPECTED-FAIL` marker and a path field of its own, so counting it
 * ranks artifact metadata as a test. On bug 2060167 that put `shutdown hang` —
 * a line that is *nothing but* a notice — first with 806 occurrences, above the
 * test the bug is about. Measured over the top 25 trunk bugs of
 * 2026-08-28..09-03, 810 of 5,560 occurrences carry a notice-only path that no
 * failure line names, so this is the common case rather than a corner.
 */
export function tallyTests(occurrences: readonly BugOccurrence[]): SuiteCount[] {
    return tally(
        occurrences.flatMap((row) => [
            ...new Set(
                partitionOccurrenceLines(row)
                    .messages.map((line) => testPathOfLine(line))
                    .filter((path): path is string => path !== null)
            ),
        ])
    );
}

/**
 * One occurrence's log lines split into failures and profile artifact names.
 *
 * The same `partitionMarkerMessages()` `fx-tests try` runs its `TestStatus`
 * markers through (`cli/commands/try.ts:1019`), applied to the raw
 * `TEST-UNEXPECTED-FAIL` lines Treeherder keeps. The marker's message is the
 * tail of the line and `uploadedProfileName()` searches it, so a raw line needs
 * no pre-parsing — and running one function over both sources is what keeps
 * "which of these is a profile notice" a single answer.
 *
 * `profile uploaded in profile_foo.js.json` is artifact metadata, not a
 * failure, and counting it as one put four notices in the top ten of
 * `--bug 2063582`'s "failure messages" and ranked `shutdown hang` first among
 * `--bug 2060167`'s "tests named". It belongs to the profile section instead.
 *
 * **Every reader of an occurrence's lines goes through here.** `BugOccurrence.
 * lines` stays raw because `--json`'s `occurrenceRows` promise to keep every
 * line verbatim (see `normaliseDuration`), so the field cannot be filtered at
 * the source without breaking that — which makes this the one gate, and a
 * second direct reader of `lines` a bug. The first version of this change
 * partitioned at the failure-message tally alone and left `tallyTests` reading
 * the raw field; that is the defect this docstring exists to prevent recurring.
 */
export function partitionOccurrenceLines(occurrence: BugOccurrence): PartitionedMessages {
    return partitionMarkerMessages(occurrence.lines);
}

/** Counts occurrences of each name, count-descending then alphabetical. */
export function tally(names: readonly string[]): SuiteCount[] {
    const counts = new Map<string, number>();
    for (const name of names) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** One per-test profile an occurrence's log lines point at. */
export interface OccurrenceProfile {
    /** The artifact filename, e.g. `profile_browser_resize_sidebar-2.js.json`. */
    filename: string;
    /**
     * The raw Taskcluster artifact URL, or `null` when it cannot be built.
     *
     * A URL needs a run index and a task ID, and neither is guaranteed: the run
     * comes from a request that can fail (`withRunIds` warns and yields `null`),
     * and `taskId` is the string `"unknown"` when Treeherder holds no
     * Taskcluster metadata for the job. Guessing `runs/0` would print a URL
     * indistinguishable from a resolved one that 404s — exactly the defect the
     * run index was added to fix — so the filename is reported without one.
     */
    url: string | null;
    /**
     * Whether the log named this as the harness's in-job rerun — the
     * `-2`-suffixed upload.
     *
     * Read off the filename the log gave, not inferred. A task that fails twice
     * uploads both profiles, but Treeherder keeps the retry's messages only, so
     * the first run's name is usually absent. It is **not** synthesised by
     * stripping the suffix: `lib/links.ts` states that a caller must not
     * substitute a guessed filename, and a guess printed beside real data is
     * indistinguishable from it — while adding nothing, since removing `-2` is
     * something any reader can do without being told.
     */
    isRerun: boolean;
}

/** The per-test profiles of one occurrence, for a `Profiles` section. */
export interface OccurrenceProfiles {
    /** `<taskId>.<runId>`, or `<taskId>` when the run index was not resolved. */
    run: string;
    taskId: string;
    runId: number | null;
    /**
     * The configuration that ran, as `<platform>/<buildType> <suite>`.
     *
     * **Not a job name**, and deliberately not presented as one. `test
     * --profiles` prints Treeherder's `job_type_name`
     * (`test-<platform>/<buildType>-<suite>`), and the bare `test_suite` this
     * used to print was strictly less — the suite with the platform and build
     * type stripped, so `mochitest-browser-chrome-5` for every platform alike.
     *
     * Reconstructing `job_type_name` from these three fields is what the obvious
     * fix would be, and it is wrong: Treeherder derives them by *subtracting*
     * from the job name and gets the boundary wrong on sanitizer builds. A
     * Windows ASAN job arrives as `platform: "windows11-64-25h2"`,
     * `build_type: "asan"`, `test_suite: "opt-mochitest-browser-chrome-45"`
     * while its real name is
     * `test-windows11-64-25h2-asan/opt-mochitest-browser-chrome-45` — the
     * `asan` belongs to the platform and the `opt` to the build type, and
     * nothing in the three fields says so. Measured over the top 25 trunk bugs
     * of 2026-08-31..09-07, 337 of 6,228 occurrences (5.4%) would get a
     * fabricated name, and 30 distinct configurations reconstruct wrongly —
     * including non-test jobs (`snap-upstream-build-amd64-esr/opt`) that have no
     * `test-` prefix at all.
     *
     * So this reports the fields as the API gives them, joined the way the
     * `--markdown` renderer and the occurrence table already join them. It
     * carries the same information as a job name without asserting a string
     * Treeherder would not recognise.
     */
    configuration: string;
    profiles: OccurrenceProfile[];
}

/**
 * An occurrence's configuration for display: `<platform>/<buildType> <suite>`.
 *
 * Not `occurrenceConfig`, which is `<platform>/<buildType>` and exists to be
 * *matched* against by `--config`. This one is for reading, so it keeps the
 * suite — the chunk number included, because a profile belongs to one chunk and
 * merging them would point at the wrong job.
 *
 * The same three fields in the same order as the `Task IDs` markdown section and
 * the occurrence table, so the three places a reader meets a job in this
 * command's output agree. See `OccurrenceProfiles.configuration` for why this is
 * not spliced into a `job_type_name`.
 */
export function occurrenceConfiguration(row: BugOccurrence): string {
    return `${occurrenceConfig(row)} ${row.testSuite}`;
}

/**
 * The `-2` rerun suffix the harness appends to a second upload of one test.
 *
 * `profile_browser_resize_sidebar-2.js.json` against
 * `profile_browser_resize_sidebar.js.json`: the suffix sits before the test's
 * own extension, not at the end of the name.
 *
 * Used to **recognise** a name the log gave, never to build one it did not.
 */
const RERUN_SUFFIX = /-2(\.\w+\.json)$/;

/**
 * Every per-test profile one bug's occurrences point at, occurrence order.
 *
 * Built from the `profile uploaded in …` notices `partitionOccurrenceLines`
 * takes out of the failure tally — the same notices, read once for both
 * purposes — and turned into URLs by `testInfoArtifactUrl()`, which is what
 * `cli/commands/try.ts:1540` does with the same `profileFilenames` field.
 * `uploadedProfileUrl()` is the other half of the same pair and re-parses a
 * message; the filenames are already extracted here, so this calls the shared
 * URL builder directly.
 *
 * **Only filenames a log line actually named.** A task that failed twice
 * uploads both profiles and Treeherder keeps the retry's messages only, so the
 * first run's name is usually missing — and it is left missing. Synthesising it
 * by stripping `-2` is what `lib/links.ts` prohibits ("a caller must not
 * substitute a guessed filename — nothing in the data supports one"), and it is
 * information-free besides: the transformation is one any consumer can apply
 * itself, so printing the result doubles the section with output that only
 * looks like data.
 *
 * No request is made: the occurrence carries the task ID, and `runId` supplies
 * the run index, so the URL is a composition of data already in hand.
 *
 * Occurrences whose lines name no profile are omitted, and an occurrence whose
 * run index was never resolved is kept with a `null` URL: a row with a task ID,
 * a filename and no URL still tells a reader where to look, where dropping it
 * says the profile does not exist and a guessed URL says it is somewhere it is
 * not.
 */
export function occurrenceProfiles(
    occurrences: readonly BugOccurrence[]
): OccurrenceProfiles[] {
    const rows: OccurrenceProfiles[] = [];
    for (const occurrence of occurrences) {
        const filenames = partitionOccurrenceLines(occurrence).profileFilenames;
        if (filenames.length === 0) {
            continue;
        }
        rows.push({
            run:
                occurrence.runId === null
                    ? occurrence.taskId
                    : `${occurrence.taskId}.${occurrence.runId}`,
            taskId: occurrence.taskId,
            runId: occurrence.runId,
            configuration: occurrenceConfiguration(occurrence),
            profiles: filenames.map((filename) => ({
                filename,
                // `runId` and `taskId` both have to be real. See
                // `OccurrenceProfile.url`: no guessed `runs/0`, and no
                // `/task/unknown/` — `"unknown"` is a documented sentinel on
                // this field (`lib/sources/intermittents.ts`), not a task.
                url:
                    occurrence.runId === null || occurrence.taskId === UNKNOWN_TASK_ID
                        ? null
                        : testInfoArtifactUrl(
                              occurrence.taskId,
                              occurrence.runId,
                              filename
                          ),
                isRerun: RERUN_SUFFIX.test(filename),
            })),
        });
    }
    return rows;
}

/** How the drill-down groups one bug's occurrences. */
export interface BugDrilldown {
    bugId: number;
    /** Occurrences in the reported population — after any filter. */
    occurrences: number;
    /**
     * Every occurrence of the bug in the window, before any filter.
     *
     * Carried so the header can state the filter's effect rather than printing
     * a silently smaller number: `127 of 168` is a fact a reader can check,
     * `127` alone is not.
     */
    totalOccurrences: number;
    /**
     * Job names with the chunk number stripped, count-descending.
     *
     * The chunk is dropped because `mochitest-browser-chrome-1` through `-12`
     * are one configuration run twelve ways, and a reader asking "where does
     * this bug fail" wants one row for it, not twelve. Variant suffixes
     * (`-no-nv`, `-swr`, `-msix`) are not chunks and survive. The raw values
     * stay in `occurrenceRows` under `--json`.
     */
    jobNames: SuiteCount[];
    platforms: SuiteCount[];
    buildTypes: SuiteCount[];
    trees: SuiteCount[];
    tests: SuiteCount[];
    /** Distinct `TEST-UNEXPECTED-FAIL` lines, count-descending. */
    lines: SuiteCount[];
    /**
     * Occurrences whose job name is neither mochitest nor xpcshell.
     *
     * Reported so "this bug is all mochitest" stays distinguishable from "some
     * of its jobs were not classified".
     */
    unclassifiedOccurrences: number;
}

/** How `--bug` narrows the occurrences it reports. */
export interface DrilldownFilter {
    /** Keep only occurrences whose job ran this harness. */
    harness?: ScanHarness | undefined;
    /** Substrings to keep, matched against `<platform>/<buildType>`. */
    config?: readonly string[] | undefined;
    /** Substrings to drop, applied after `config`. */
    excludeConfig?: readonly string[] | undefined;
}

/**
 * The configuration string an occurrence is matched against.
 *
 * `<platform>/<buildType>`, which is the shape `fx-tests test --config` matches
 * job names in — so `macosx1500-aarch64`, `debug` and `macosx1500-aarch64/debug`
 * all work, and a caller who learned the flag there does not learn a second
 * convention here. The rows carry the two fields separately; this is the only
 * place they are joined.
 */
export function occurrenceConfig(row: BugOccurrence): string {
    return `${row.platform}/${row.buildType}`;
}

/** One day of the window, and how many annotations landed on it. */
export interface OccurrenceDay {
    /** `YYYY-MM-DD`. */
    date: string;
    count: number;
}

/**
 * Annotations per day over the whole window, zero days included.
 *
 * **Zero days are the point.** `1,116 sheriff annotations, 2026-08-21 to
 * 2026-09-03` reads as two weeks of steady flakiness whether the annotations
 * are spread evenly or landed in one afternoon, and the two are opposite
 * answers: the first is an intermittent to rank, the second a regression to
 * back out. Dropping the empty days would leave the same ambiguity, so the
 * range is enumerated rather than derived from the rows.
 *
 * The dates come from each occurrence's `pushTime`, which the API formats as
 * `YYYY-MM-DD HH:MM:SS` — the day is its first ten characters, no parsing and
 * no timezone conversion, because the window this is bucketed into is stated in
 * the same calendar days the API filtered on.
 */
export function occurrenceHistory(
    occurrences: readonly BugOccurrence[],
    range: { start: string; end: string }
): OccurrenceDay[] {
    const counts = new Map<string, number>();
    // `dateOfDay` rather than local date arithmetic: it is the same
    // `startDate + n days`, UTC, sliced to ten characters that `flakiness.ts`
    // enumerates its own date axis with, and two implementations of that would
    // be two places for a timezone to creep in.
    for (let day = 0; ; day++) {
        const date = dateOfDay(range.start, day);
        if (date > range.end) {
            break;
        }
        counts.set(date, 0);
    }
    // A day outside the window gets a row of its own rather than being dropped.
    // The API filters on push time, so it should never happen — and if it does,
    // a table that quietly sums to less than the header's total is the
    // disagreement this whole drill-down is built to avoid.
    for (const row of occurrences) {
        const date = row.pushTime.slice(0, 10);
        counts.set(date, (counts.get(date) ?? 0) + 1);
    }
    return [...counts]
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Groups one bug's occurrences, optionally narrowed.
 *
 * **Every field is computed from the same filtered population.** A header total
 * that disagrees with its own table is the defect item 14 exists to fix, and the
 * way to get it is to filter one list and compute the rest over everything — so
 * the filter is applied once, here, and every tally below reads `rows`.
 *
 * The harness comes from each occurrence's own job name rather than from the
 * bug's summary. The ranked list classifies a *bug*, where a summary naming one
 * test is the best evidence available; here the question is whether *this job*
 * ran mochitest, and the row says so directly.
 */
export function summariseBug(
    bugId: number,
    occurrences: readonly BugOccurrence[],
    filter: DrilldownFilter = {}
): BugDrilldown {
    const rows = filterOccurrences(occurrences, filter);
    return {
        bugId,
        occurrences: rows.length,
        totalOccurrences: occurrences.length,
        jobNames: tally(rows.map((row) => stripSuiteChunk(row.testSuite))),
        platforms: tally(rows.map((row) => row.platform)),
        buildTypes: tally(rows.map((row) => row.buildType)),
        trees: tally(rows.map((row) => row.tree)),
        tests: tallyTests(rows),
        // Per occurrence, like every other tally here: a job emits the marker
        // once per failing assertion, so counting raw lines reports a job that
        // failed eighteen assertions as eighteen jobs.
        //
        // Partitioned first, so a `profile uploaded in …` notice is never
        // counted as a failure message. See `partitionOccurrenceLines`.
        lines: tally(
            rows.flatMap((row) => [
                ...new Set(partitionOccurrenceLines(row).messages.map(failureLineDetail)),
            ])
        ),
        unclassifiedOccurrences: rows.filter(
            (row) => harnessOfOccurrence(row.testSuite) === null
        ).length,
    };
}

/** The occurrences `summariseBug` kept, for the rows and `--json`. */
export function filterOccurrences(
    occurrences: readonly BugOccurrence[],
    filter: DrilldownFilter = {}
): BugOccurrence[] {
    const matchesConfig = configFilter(filter.config ?? [], filter.excludeConfig ?? []);
    return occurrences.filter(
        (row) =>
            (filter.harness === undefined ||
                harnessOfOccurrence(row.testSuite) === filter.harness) &&
            matchesConfig(occurrenceConfig(row))
    );
}

/**
 * Drops the `HH:MM:SS     INFO - ` prefix a mozharness log line carries.
 *
 * Without it the timestamp makes every line distinct, so a ranking of lines has
 * every count at 1.
 */
export function stripLogTimestamp(line: string): string {
    return line.replace(/^\d{2}:\d{2}:\d{2}\s+\w+\s+-\s+/, '').trim();
}

/**
 * The part of a failure line that distinguishes it from the others.
 *
 * The marker and path are 60-plus characters of prefix, and the path is already
 * reported in its own section, so a truncated ranking of one test's failures
 * shows identical visible text on every row. Both come off; a line with no path
 * field (`[taskcluster:error]`) keeps whatever followed the marker.
 */
export function failureLineDetail(line: string): string {
    const stripped = stripLogTimestamp(line);
    const marker = stripped.indexOf('TEST-UNEXPECTED-FAIL');
    if (marker === -1) {
        return stripped;
    }
    const fields = stripped.slice(marker).split('|');
    // The message can itself contain `|`, so the tail is rejoined, not indexed.
    const rest = fields.slice(2).join('|').trim();
    return rest.length === 0 ? stripped : normaliseDuration(rest);
}

/**
 * Collapses a per-run duration to `<n>ms`, so one message is one row.
 *
 * The harness appends `finished in 1306ms` to a failing test file, carrying the
 * `TEST-UNEXPECTED-FAIL` marker, so these are real failure lines — but the
 * number differs on every run, which made each occurrence its own row. Measured
 * on live bug 1829935: 108 of 120 message rows were this one message, each with
 * a count of 1, burying the twelve rows that say what actually failed.
 *
 * Same reasoning as `stripLogTimestamp`: text that is unique per occurrence
 * cannot be ranked, and the ranking is the point. The duration is not dropped —
 * `--json`'s `occurrenceRows` keep every line verbatim.
 */
function normaliseDuration(message: string): string {
    return message.replace(/\b\d+ms\b/g, '<n>ms');
}
