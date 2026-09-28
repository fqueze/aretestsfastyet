/**
 * `fx-tests task <taskId>` — what happened in one job, from its resource-usage profile.
 *
 * `fx-tests try` pointed at a single task instead of a push. It answers the
 * question a push-level report cannot: **what else went wrong in this job?**
 *
 * ## Why this is not a fourth thing
 *
 * Everything here comes out of the job's
 * `public/test_info/profile_resource-usage.json`, read by the same
 * `parseTestMarkers()` `try` uses (`lib/model/test-markers.ts`). That artifact
 * is the only per-test record a job publishes, and `try --profiles` has been
 * printing its URL all along — what was missing was a way to read it, which is
 * the whole of this command. The alternative every agent reached for instead
 * was downloading `live_backing.log` and counting by hand, several megabytes
 * at a time, or listing the run's artifacts to find this file.
 *
 * ## What `try`'s shape survives the narrowing, and what does not
 *
 * Kept: the per-test outcomes, the failing-executions ranking, the message
 * lines, `--task-ids`, `--profiles`, `--messages`.
 *
 * Dropped, because each is a statement about *several* configurations and a
 * single task is one:
 *
 * - **The perma-fail verdict.** "Failed in every run of at least one
 *   configuration" is a claim about a set of job runs. One job run is one
 *   observation, and a row that failed here says nothing about whether the
 *   next run of the same job would.
 * - **The central comparison, and with it the known/new intermittent split.**
 *   Both classify a push's failure against 21 days of mozilla-central. That
 *   comparison is still available and still worth making — it is
 *   `fx-tests test <path>`, which this command names in its footer for the
 *   rows it printed.
 * - **The per-configuration aggregation.** There is one configuration here, so
 *   it is a header field rather than a column.
 *
 * ## The job's identity comes from the queue, not Treeherder
 *
 * A bare task ID resolves to nothing on Treeherder without a push, so the job
 * name, the repository and the revision are read from the task definition
 * (`taskDefinitionName()` in `lib/sources/http.ts`) — one request, cached with
 * the artifacts. They are presentation only: a definition that cannot be read
 * costs the header a line and changes no row, so it is reported and not fatal.
 * The profile is the opposite, and a missing one is exit 4, as `crash`'s is,
 * because Taskcluster expires artifacts and a task from last month is
 * permanently gone rather than temporarily unavailable.
 */

import { parseTaskId } from '../../lib/formats/tables.ts';
import { type DroppedMarker, parseTestMarkers } from '../../lib/model/test-markers.ts';
import { resourceUsageProfileUrl } from '../../lib/links.ts';
import {
    type TaskDefinition,
    type TaskFailure,
    type TaskIdentity,
    type TaskJson,
    TaskProfileError,
    attachProvenance,
    nonFailures,
    readTaskDefinition,
    readTaskProfile,
    summarize,
    taskIdentity,
} from '../../lib/query/task-summary.ts';
import type { DataSource } from '../../lib/sources/source.ts';
import { type OptionSpecs, type ParsedArgs, boolOption } from '../args.ts';
import { type CommandContext, emit, progress, warn } from '../context.ts';
import { goneError, upstreamError, usageError } from '../errors.ts';
import {
    MESSAGE_CAP,
    droppedMarkerSummary,
    messageLines,
} from '../format/failure-lines.ts';
import { toJson } from '../format/json.ts';
import * as md from '../format/markdown.ts';
import {
    applyLimit,
    joinLines,
    moreLine,
    table,
    truncate,
} from '../format/text.ts';

/** Default failing tests listed. */
const DEFAULT_LIMIT = 20;

/** How many provenance lines one row prints. */
const PROVENANCE_ROWS = 5;

/** Options `task` adds. */
export const TASK_OPTIONS: OptionSpecs = {
    profiles: {
        type: 'boolean',
        // Kept, narrowly. The default now names each per-test profile by
        // filename under the header's URL, which is what a reader wants; this
        // prints them as absolute URLs, which is what a script piping to
        // `curl` or `profiler-cli` wants without having to join strings.
        describe: 'Print per-test profile URLs in full, rather than as filenames.',
    },
    messages: {
        type: 'boolean',
        describe: `Print every failure message per row, not just the first (cap ${MESSAGE_CAP}).`,
    },
    passed: {
        type: 'boolean',
        // The default answers "what failed", which is the question usually
        // asked. The profile also records every PASS and SKIP, and "did this
        // test even run in this chunk" is the other thing a task ID gets
        // asked, so the data is there behind a flag rather than thrown away.
        //
        // "passed and were skipped" described one test as both; these are two
        // disjoint groups of tests, and the flag lists the union of them.
        describe: 'Also list the tests that passed or were skipped, not just the failures.',
    },
};

/** Runs the command. */
export async function runTask(context: CommandContext, args: ParsedArgs): Promise<void> {
    const rawTaskId = args.positionals[0];
    if (rawTaskId === undefined) {
        throw usageError(
            'task requires a task ID',
            'Usage: fx-tests task <taskId>[.<retryId>]. Task IDs come from ' +
                '`fx-tests test <path> --task-ids`, `fx-tests try <rev> --task-ids` or a ' +
                'Treeherder job URL.'
        );
    }
    if (args.positionals.length > 1) {
        throw usageError(
            `task takes one task ID, got ${args.positionals.length}: ` +
                args.positionals.join(', ')
        );
    }

    // `<taskId>.<retryId>` with `.0` implied, as `crash` accepts it — so an ID
    // copied from any other command works unchanged.
    const { taskId, retryId } = parseTaskId(rawTaskId);

    const source = context.taskArtifacts;
    if (source === undefined) {
        throw new Error('task needs a task-artifact source but none was supplied');
    }

    const profileUrl = resourceUsageProfileUrl(taskId, retryId);
    // "Reading", not "Fetching": a warm cache downloads nothing, and a line
    // saying "Fetching" there is what made the caching look broken in `try`.
    progress(context, `Reading the resource-usage profile of task ${taskId}.${retryId}…`);
    // The profile before the definition, and the order is load-bearing: a task
    // ID that is not a task ID fails both, and `fetchIdentity` only warns. Read
    // the other way round, a typo answered with a warning about a missing job
    // name and *then* the real error, burying it.
    const profile = await fetchProfile(source, taskId, retryId, profileUrl);
    progress(context, 'Reading the task definition for the job name…');
    const identity = await fetchIdentity(context, source, taskId);

    const dropped: DroppedMarker[] = [];
    const timings = parseTestMarkers(
        profile,
        {
            // `parseTestMarkers` stamps every row with these three. The job
            // name is what a row would be grouped by in `try`; here it is the
            // header, and a task whose definition would not load still gets
            // rows.
            jobName: identity.jobName ?? `${taskId}.${retryId}`,
            taskId,
            retryId,
        },
        dropped
    );
    reportDropped(context, dropped);

    const result = summarize(taskId, retryId, identity, profileUrl, timings);

    const asJson = context.globals.format === 'json';
    if (asJson || boolOption(args, 'passed')) {
        result.passed = nonFailures(timings, result.failures);
    }
    // Unconditional now: the per-test profiles are named in the default output,
    // so they are data rather than a flag's payload. `--profiles` only chooses
    // whether they render as filenames or as absolute URLs.
    attachProvenance(result.failures, timings, taskId, retryId);

    if (asJson) {
        emit(context, toJson(result));
        return;
    }
    const limit = context.globals.limit ?? DEFAULT_LIMIT;
    emit(
        context,
        context.globals.format === 'markdown'
            ? renderMarkdown(result, limit)
            : renderText(
                  result,
                  limit,
                  boolOption(args, 'profiles'),
                  boolOption(args, 'messages'),
                  boolOption(args, 'passed')
              )
    );
    // Exit 0 with failures found, as `try` does: the failures are the answer,
    // not an error, and a script branches on `--json`.
}

// --- reading the task -----------------------------------------------------

/**
 * The job's name, repository and revision, or as much of them as loads.
 *
 * Never fatal. Every row of the report comes out of the profile, so a
 * definition that will not load costs the header its name and the footer its
 * Treeherder link and nothing else — failing the command over it would refuse
 * to answer a question it can answer. The warning says which part is missing
 * so the blank header is not read as "this job has no name".
 */
async function fetchIdentity(
    context: CommandContext,
    source: DataSource,
    taskId: string
): Promise<TaskIdentity> {
    let definition: TaskDefinition;
    try {
        definition = await readTaskDefinition(source, taskId);
    } catch {
        warn(
            context,
            `could not read the definition of task ${taskId}, so the job name, repository and ` +
                `revision are missing from the header; the results below are unaffected`
        );
        return { jobName: null, project: null, revision: null };
    }
    return taskIdentity(definition);
}

/**
 * Says which failing markers named no test path, so their absence is stated.
 *
 * A crash recorded against a `.toml` manifest rather than a test is real and
 * has no path to put in a row — measured on try push 717fc67feaa071, one job
 * had 27 of them and one genuine `FAIL`. In a per-push report those are a
 * footnote; in a per-*job* one, "27 crashes in this job that this table does
 * not list" is close to the whole answer, so it is a `warn` and it names the
 * markers rather than only counting them.
 */
function reportDropped(context: CommandContext, dropped: readonly DroppedMarker[]): void {
    if (dropped.length === 0) {
        return;
    }
    const { count, shown } = droppedMarkerSummary(dropped);
    warn(
        context,
        `${count} failing marker${count === 1 ? '' : 's'} in this job named no test path and ` +
            `${count === 1 ? 'is' : 'are'} not in the table below (a crash recorded against a ` +
            `manifest has no test to attribute it to): ${shown}`
    );
}

/**
 * The job's resource-usage profile, with `crash`'s exit-code split.
 *
 * **404 is exit 4**, and this is the command where that matters most:
 * Taskcluster expires task artifacts after about a month, so most task IDs a
 * caller has written down somewhere are permanently unreadable rather than
 * temporarily so, and the hint has to send them to a current one rather than
 * to a retry loop.
 *
 * A **streamed** profile is neither. A job killed for exceeding its
 * `maxRunTime` uploads whatever the profiler had flushed — newline-delimited
 * JSON, not one document — and this tool does not read that format. Reporting
 * it as unreadable sends a reader looking for a broken download when the
 * answer is the job's duration, so it gets its own message.
 */
async function fetchProfile(
    source: DataSource,
    taskId: string,
    retryId: number,
    url: string
): Promise<unknown> {
    try {
        return await readTaskProfile(source, taskId, retryId);
    } catch (error) {
        if (!(error instanceof TaskProfileError)) {
            throw error;
        }
        switch (error.problem) {
            case 'missing':
                throw goneError(
                    `task ${taskId}.${retryId} has no profile_resource-usage.json: the artifact is ` +
                        `not there.`,
                    'Taskcluster expires task artifacts after about a month, so this is permanent ' +
                        'and retrying will not help. Check the retry number — `.0` is assumed — and ' +
                        'get a current task ID from `fx-tests test <path> --task-ids`. A job that is ' +
                        'not a test job never uploads one.'
                );
            case 'not-a-task':
                // Not exit 3, and not exit 4: a 400 is the caller's typo, and
                // calling it transient would send them into a retry loop over
                // a string that will never be a task. `readTaskProfile` has
                // the measurement.
                throw usageError(
                    `"${taskId}" is not a task ID Taskcluster will accept (HTTP 400).`,
                    'A task ID is 22 URL-safe base64 characters. The `.<retryId>` suffix is ' +
                        'optional and defaults to .0. Get one from `fx-tests test <path> ' +
                        '--task-ids`, `fx-tests try <rev> --task-ids`, or the `selectedTaskRun` ' +
                        'parameter of a Treeherder job URL.'
                );
            case 'streamed':
                throw upstreamError(
                    `task ${taskId}.${retryId} was killed for exceeding its maximum duration, so its ` +
                        `profile is a partial stream rather than a finished document and this tool ` +
                        `does not read that format.`,
                    'The job never got to write a profile, so there are no per-test results to read. ' +
                        'Its duration is the problem to look at; the log is on Treeherder.'
                );
            case 'invalid-json':
                throw upstreamError(
                    `the profile of task ${taskId}.${retryId} is not valid JSON: ${error.message}`,
                    `Re-run with --no-cache in case a truncated copy was cached; the artifact is ${url}.`
                );
            case 'fetch':
                throw upstreamError(
                    `could not fetch ${url}: ${error.message}`,
                    error.status === 403
                        ? 'A 403 here is usually a malformed artifact path rather than an expired ' +
                          'artifact, which answers 404. Retrying may work.'
                        : 'This looks transient — retrying may work.'
                );
        }
    }
}

// --- rendering -----------------------------------------------------------

/** The header both renderers share, as plain sentences. */
function headerLines(result: TaskJson): string[] {
    const lines: string[] = [];
    lines.push(
        `Task ${result.taskId}.${result.retryId}` +
            (result.jobName === null ? '' : ` — ${result.jobName}`)
    );
    if (result.project !== null || result.revision !== null) {
        lines.push(
            [result.project, result.revision?.slice(0, 12)].filter((part) => part !== null).join(' ')
        );
    }
    // Three separate counts, none derived from the others. `executionCount -
    // testCount` was printed here as "harness reruns" and is not: on task
    // `KDqOl_b-QeKPlA6J6BaM_A` that subtraction says 325 where the profile
    // records 7, because a test listed in two manifests executes twice under
    // one normalized path. The rerun figure is now counted from `isRerun`,
    // which is the field that means it.
    lines.push(
        `${result.testCount} tests, ${result.executionCount} executions` +
            (result.rerunCount > 0
                ? ` (${result.rerunCount} of them harness reruns)`
                : '') +
            `, ${result.failures.length} failing`
    );
    lines.push(outcomeLine(result));
    return lines.filter((line) => line !== '');
}

/**
 * The status breakdown, counted over distinct tests.
 *
 * Says "counted per test" because the counts deliberately do **not** partition
 * `testCount`: a test that failed and then passed on the harness's rerun is
 * both a FAIL and a PASS, and presenting the numbers as a partition would make
 * them look wrong to anyone who added them up.
 */
function outcomeLine(result: TaskJson): string {
    const entries = Object.entries(result.statusCounts).sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
    if (entries.length === 0) {
        return '';
    }
    return (
        `Outcomes, counted per test: ` +
        entries.map(([status, count]) => `${count} ${status}`).join(', ')
    );
}

/** Plain text. */
function renderText(
    result: TaskJson,
    limit: number,
    withProfiles: boolean,
    allMessages: boolean,
    withPassed: boolean
): string {
    const lines: (string | null)[] = [...headerLines(result)];
    if (result.treeherderUrl !== null) {
        lines.push(result.treeherderUrl);
    }
    lines.push(`profile ${result.profileUrl}`);

    lines.push('');
    if (result.failures.length === 0) {
        // Not the same as "the job passed": a harness crash, or a failure the
        // profile recorded against a manifest rather than a test, leaves no
        // test-level row. Saying which is the difference between sending a
        // reader to the next test and sending them to the log.
        lines.push(
            result.testCount === 0
                ? 'This profile records no tests at all. Either the job is not a test job, or ' +
                      'the harness died before it ran one — the log on Treeherder is the next step.'
                : 'No test-level failure in this job. If Treeherder shows it red, the failure is ' +
                      'not attributed to a test: a harness crash, a leak check, or a shutdown ' +
                      'hang recorded against a manifest. Read the log.'
        );
    } else {
        lines.push(...failureSection(result, limit, withProfiles, allMessages));
    }

    if (withPassed && result.passed !== undefined && result.passed.length > 0) {
        lines.push('');
        lines.push(`DID NOT FAIL (${result.passed.length})`);
        const shown = applyLimit(result.passed, limit);
        lines.push(
            ...table(
                [
                    { header: 'test', path: true },
                    { header: 'status' },
                    { header: 'runs', align: 'right' },
                ],
                shown.map((entry) => [
                    entry.path,
                    entry.statuses.join(', '),
                    String(entry.executionCount),
                ])
            )
        );
        lines.push(moreLine(result.passed.length, shown.length));
    }

    if (result.failures.length > 0) {
        lines.push('');
        // The classification this command deliberately does not do, named with
        // the command that does. A single task cannot say whether a failure is
        // new; `fx-tests test` compares one against 21 days of central.
        lines.push(
            'One job says what failed, not whether it usually does. For that, run ' +
                '`fx-tests test <path>` on a row above.'
        );
    }
    return joinLines(lines);
}

/** An annotation every failing row shares, and so belongs to the job. */
interface SharedAnnotations {
    passedOnRerun: boolean;
    parallelOnly: boolean;
}

/**
 * Which annotations hold for **every** failing row.
 *
 * On task `KDqOl_b-QeKPlA6J6BaM_A` both do, and printing them per row produced
 * ten identical lines in a five-row table. An annotation true of every row does
 * not distinguish any row from another, so it is a property of the job and is
 * stated once above the table.
 *
 * Two or more rows required: with one failing test "every row" and "this row"
 * are the same statement, and hoisting it only moves the line further from the
 * test it is about.
 */
function sharedAnnotations(failures: readonly TaskFailure[]): SharedAnnotations {
    if (failures.length < 2) {
        return { passedOnRerun: false, parallelOnly: false };
    }
    return {
        passedOnRerun: failures.every((failure) => failure.passedOnRerun),
        parallelOnly: failures.every((failure) => failure.parallelOnly),
    };
}

/** The hoisted annotations, as lines under the section header. */
function sharedAnnotationLines(shared: SharedAnnotations, count: number): string[] {
    const lines: string[] = [];
    if (shared.passedOnRerun) {
        lines.push(`  All ${count} passed when the harness reran them.`);
    }
    if (shared.parallelOnly) {
        lines.push(`  All ${count} failed only in the parallel phase.`);
    }
    return lines;
}

/**
 * The per-test profiles a failing row uploaded.
 *
 * Filenames by default, not URLs. Every one of these sits beside the
 * resource-usage profile already named in full in the header, so the two differ
 * only in the final path segment and a per-row URL spends ~130 characters to
 * convey a filename. Naming the file is enough to find it, and cheap enough to
 * print without a flag — which is why `--profiles` is no longer what reveals
 * these, only what expands them to absolute URLs for a script.
 *
 * **Never a synthesised name.** A filename appears here only because a failure
 * message named it (`uploadedProfileName`, `lib/links.ts:109`). A job that
 * uploaded a rerun profile whose message did not name it contributes one entry,
 * not two, and deriving the missing one by stripping a `-2` is forbidden.
 */
function profileLines(failure: TaskFailure, withProfiles: boolean): string[] {
    const urls = failure.testProfiles ?? [];
    if (urls.length === 0) {
        return [];
    }
    const shown = urls.slice(0, PROVENANCE_ROWS);
    const lines = withProfiles
        ? shown.map((url) => `    profile ${url}`)
        : [
              `    ${shown.length === 1 ? 'profile' : 'profiles'} in ` +
                  shown.map((url) => url.slice(url.lastIndexOf('/') + 1)).join(' '),
          ];
    const hidden = urls.length - shown.length;
    if (hidden > 0) {
        lines.push(`    … ${hidden} more profile${hidden === 1 ? '' : 's'}`);
    }
    return lines;
}

/** The failing tests, one block each — `try`'s detailed section, minus central. */
function failureSection(
    result: TaskJson,
    limit: number,
    withProfiles: boolean,
    allMessages: boolean
): string[] {
    const shared = sharedAnnotations(result.failures);
    const lines: string[] = [
        `FAILED (${result.failures.length}) — every test this job recorded a failure for.`,
        ...sharedAnnotationLines(shared, result.failures.length),
    ];
    // Asked for profiles and there are none to name: say so once, rather than
    // leaving a reader to tell "this job has none" from "the tool did not
    // look". Only under `--profiles` — silent by default, because most
    // xpcshell jobs upload none and a line on every one of them is noise for a
    // reader who never asked.
    //
    // Only when the whole section would be silent. Some rows naming a profile
    // and others not is ordinary and needs no note.
    //
    // States what the data supports and no more. A filename is here only
    // because a failure message named one, so "no failing test named a
    // profile" is a fact about the messages read; whether the job uploaded one
    // anyway is not in the profile and is not claimed. "per-test" is explicit
    // so the line cannot be read as denying the resource-usage profile in the
    // header, which is always there and is a different artifact.
    if (withProfiles && result.failures.every((f) => (f.testProfiles ?? []).length === 0)) {
        lines.push('  No failing test named a per-test profile in this job.');
    }
    const shown = applyLimit(result.failures, limit);
    for (const failure of shown) {
        lines.push('');
        lines.push(`  ${failure.path}`);
        lines.push(
            `    ${failure.statuses.join(', ')} — ` +
                `${failure.failureCount} failing ` +
                `${failure.failureCount === 1 ? 'execution' : 'executions'} of ` +
                `${failure.executionCount}`
        );
        // Only where it distinguishes this row from its neighbours. When every
        // failing row shares an annotation it is a fact about the job, and the
        // header states it once — see `sharedAnnotations`. Ten identical hedged
        // lines in a five-row table is what this replaced.
        if (failure.passedOnRerun && !shared.passedOnRerun) {
            lines.push('    Passed when the harness reran it.');
        }
        if (failure.parallelOnly && !shared.parallelOnly) {
            lines.push('    Failed only in the parallel phase.');
        }
        lines.push(...messageLines(failure, allMessages));
        lines.push(...profileLines(failure, withProfiles));
    }
    const more = moreLine(result.failures.length, shown.length);
    if (more !== null) {
        lines.push(more);
    }
    return lines;
}

/** Markdown, for pasting into a bug or PR. */
function renderMarkdown(result: TaskJson, limit: number): string {
    const lines: (string | null)[] = [];
    lines.push(
        md.heading(
            `Task ${result.taskId}.${result.retryId}` +
                (result.jobName === null ? '' : ` — ${result.jobName}`),
            1
        )
    );
    lines.push('');
    for (const line of headerLines(result).slice(1)) {
        lines.push(line);
        lines.push('');
    }
    if (result.treeherderUrl !== null) {
        lines.push(`[View on Treeherder](${result.treeherderUrl})`);
        lines.push('');
    }
    lines.push(`[Resource-usage profile](${result.profileUrl})`);
    lines.push('');
    lines.push(md.heading(`Failed (${result.failures.length})`));
    lines.push('');
    if (result.failures.length === 0) {
        lines.push('None attributed to a test.');
        return joinLines(lines);
    }
    const shown = applyLimit(result.failures, limit);
    lines.push(
        ...md.table(
            [
                // A true ordinal, unlike `try`'s `#`, which holds the failing
                // execution count. That works there because `try` prints no
                // adjacent execution column; here `Executions` is
                // `failureCount/executionCount` in the very next cell, so a `#`
                // holding the numerator again would be a duplicate reading `1`
                // down every row of a five-row table — measured on
                // `KDqOl_b-QeKPlA6J6BaM_A`. The rows are ranked, so the column
                // says where in the ranking each one is.
                { header: '#', align: 'right' },
                { header: 'Test' },
                { header: 'Status' },
                { header: 'Executions', align: 'right' },
                // A single task cannot say a failure is intermittent tree-wide,
                // but an in-job rerun that went green says it here, and that is
                // the one column of triage this command earns.
                { header: 'Passed on rerun' },
                { header: 'Message' },
            ],
            shown.map((failure, index) => [
                String(index + 1),
                failure.path,
                failure.statuses.join(', '),
                `${failure.failureCount}/${failure.executionCount}`,
                failure.passedOnRerun ? 'yes' : '',
                truncate(failure.messages[0] ?? '', 120),
            ])
        )
    );
    lines.push(md.moreLine(result.failures.length, shown.length));
    return joinLines(lines);
}
