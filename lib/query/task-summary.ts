/**
 * One task run's per-test outcomes, aggregated out of its resource-usage profile.
 *
 * Shared by `fx-tests task` and `task.html`, which answer the same question —
 * what happened in this job — for a terminal and for a browser. Moved here out
 * of `cli/commands/task.ts` rather than copied, for the reason
 * `lib/model/test-markers.ts` gives about its own parser.
 */

import { treeherderJobUrl, testInfoArtifactUrl } from '../links.ts';
import { type TestTiming, isStreamedProfile } from '../model/test-markers.ts';
import { taskArtifactName, taskDefinitionName } from '../sources/http.ts';
import { DataFetchError, DataFileNotFoundError, type DataSource } from '../sources/source.ts';
import { baseStatus, isFailureStatus } from '../model/try-jobs.ts';

/** One failing test in this job, aggregated over its executions. */
export interface TaskFailure {
    path: string;
    /**
     * Failing **executions** — what the rows are ranked on, as `try` ranks.
     *
     * The harness reruns a test that fails, so one job run holds several
     * executions of it and a test that failed twice here is a worse failure
     * than one that failed once.
     */
    failureCount: number;
    /** Every execution of it in this job, failing or not. */
    executionCount: number;
    /** The distinct **base** statuses seen, sorted — `FAIL`, not `FAIL-PARALLEL`. */
    statuses: string[];
    /** True when the harness reran it in-job and it passed. */
    passedOnRerun: boolean;
    /** Only failed under parallel execution. */
    parallelOnly: boolean;
    /** One message per failing execution, most common first. */
    messages: string[];
    /** Every message the failing executions logged, with a count each. */
    allMessages: { message: string; count: number }[];
    /** The per-test profiles the harness uploaded for it, if any. */
    testProfiles?: string[];
}

/** One test that did not fail, under `--passed`. */
export interface TaskOutcome {
    path: string;
    /** The distinct base statuses, sorted. */
    statuses: string[];
    executionCount: number;
}

/** The `--json` shape. */
export interface TaskJson {
    taskId: string;
    retryId: number;
    /** The Treeherder job name, or `null` when the task definition was unreadable. */
    jobName: string | null;
    /** The repository the task ran on, or `null`. */
    project: string | null;
    /** The revision it was pushed as, or `null`. */
    revision: string | null;
    /** The Treeherder job view, or `null` when the identity is incomplete. */
    treeherderUrl: string | null;
    /** The profile every row was read out of. */
    profileUrl: string;
    /** Distinct tests the profile recorded, failing or not. */
    testCount: number;
    /**
     * Executions recorded — `Test` markers, after the path normalization.
     *
     * Exceeds `testCount`, and **not by the reruns**: that arithmetic was the
     * bug this field's comment used to assert. One test can execute twice in a
     * job for reasons that have nothing to do with the harness rerunning it,
     * the common one being that it is listed in two manifests and
     * `normalizeTestPath` strips the `manifest.toml:` prefix that told them
     * apart. Measured on task `KDqOl_b-QeKPlA6J6BaM_A`: 1,478 executions over
     * 1,153 tests is 325 extra, of which **7** are reruns — the other 318 are
     * pairs like `PASS-PARALLEL, PASS-PARALLEL` for one test under
     * `xpcshell.toml` and `xpcshell-remote.toml`.
     */
    executionCount: number;
    /**
     * Executions the harness ran as its in-job retry — `TestTiming.isRerun`.
     *
     * Counted, never derived. It is the one intermittency signal a single job
     * produces, so it is carried as its own number rather than left to a
     * subtraction that answers a different question.
     */
    rerunCount: number;
    /** Distinct tests by how they ended: keyed on the base status. */
    statusCounts: Record<string, number>;
    failures: TaskFailure[];
    /** Populated only under `--passed` and `--json`; the non-failing tests. */
    passed?: TaskOutcome[];
}

/** What the task definition says about the job, as far as it could be read. */
export interface TaskIdentity {
    jobName: string | null;
    project: string | null;
    revision: string | null;
}

/** The fields this command reads out of a Taskcluster task definition. */
export interface TaskDefinition {
    metadata?: { name?: string; source?: string };
    tags?: { label?: string; project?: string };
}

/**
 * The revision out of a task's `metadata.source`.
 *
 * The field is the hg URL of the file the task was generated from —
 * `https://hg.mozilla.org/integration/autoland/file/<rev>/taskcluster/kinds/test`
 * — so the revision is the segment after `file/`. Read from there rather than
 * from the Treeherder link in `metadata.description`, which is prose and only
 * present on some kinds.
 */
function revisionOf(source: string | undefined): string | null {
    const match = /\/file\/([0-9a-f]{12,40})\//.exec(source ?? '');
    return match?.[1] ?? null;
}

/**
 * The job's name, repository and revision out of a parsed task definition.
 *
 * `metadata.name` and `tags.label` are the same string on every gecko test
 * task measured; the tag is the fallback rather than the source because
 * `metadata.name` is the field Taskcluster documents.
 */
export function taskIdentity(definition: TaskDefinition): TaskIdentity {
    return {
        jobName: definition.metadata?.name ?? definition.tags?.label ?? null,
        project: definition.tags?.project ?? null,
        revision: revisionOf(definition.metadata?.source),
    };
}

/**
 * Whether an execution is the harness's in-job retry, passing.
 *
 * The one test of "failed then passed on retry", shared by `summarize`'s
 * `passedOnRerun` and `task.html`'s outcome counts so the two cannot disagree
 * on a test whose retry ended `OK` or `EXPECTED-FAIL` — neither counts.
 */
export function isRetryRescue(timing: TestTiming): boolean {
    return timing.isRerun && timing.status.startsWith('PASS');
}

// --- reading a task from the queue ----------------------------------------

/** Why a task's profile could not be read: each front-end words it its own way. */
export type TaskProfileProblem =
    /** 404: never uploaded, or expired. Permanent. */
    | 'missing'
    /** 400: the queue does not accept this string as a task ID. */
    | 'not-a-task'
    /** A job killed at its `maxRunTime` uploads a partial stream, not a document. */
    | 'streamed'
    | 'invalid-json'
    /** Anything else: transient, as far as can be told. */
    | 'fetch';

/** A failed `readTaskProfile`, classified. */
export class TaskProfileError extends Error {
    readonly problem: TaskProfileProblem;
    /** The HTTP status, when there was one. */
    readonly status: number | undefined;
    constructor(problem: TaskProfileProblem, message: string, status?: number) {
        super(message);
        this.name = 'TaskProfileError';
        this.problem = problem;
        this.status = status;
    }
}

/**
 * A task run's parsed `profile_resource-usage.json`, or a classified error.
 *
 * The status split is measured, and is why the classification is shared
 * rather than left to each caller: the queue answers **400** for a string that
 * is not a well-formed task ID (`ZZZZZZZZZZZZZZZZZZZZZZ`, 2026-09-03) and 404
 * for a real task with no such artifact, so a 400 is a typo and a 404 is an
 * expiry — neither is worth retrying.
 */
export async function readTaskProfile(
    source: DataSource,
    taskId: string,
    retryId: number
): Promise<unknown> {
    let bytes: Uint8Array;
    try {
        bytes = await source.fetch(
            taskArtifactName(taskId, retryId, 'public/test_info/profile_resource-usage.json')
        );
    } catch (error) {
        if (error instanceof DataFileNotFoundError) {
            throw new TaskProfileError('missing', error.message, 404);
        }
        if (error instanceof DataFetchError) {
            throw new TaskProfileError(
                error.status === 400 ? 'not-a-task' : 'fetch',
                error.message,
                error.status
            );
        }
        throw error;
    }
    if (isStreamedProfile(bytes)) {
        throw new TaskProfileError('streamed', 'the profile is a partial stream');
    }
    try {
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch (error) {
        throw new TaskProfileError('invalid-json', (error as Error).message);
    }
}

/** A task's definition, as the queue returns it. Throws the source's errors. */
export async function readTaskDefinition<T extends TaskDefinition>(
    source: DataSource,
    taskId: string
): Promise<T> {
    const bytes = await source.fetch(taskDefinitionName(taskId));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

// --- aggregating one job's markers ----------------------------------------

/** Groups the job's executions into one entry per failing test. */
export function summarize(
    taskId: string,
    retryId: number,
    identity: TaskIdentity,
    profileUrl: string,
    timings: readonly TestTiming[]
): TaskJson {
    interface Accumulator {
        path: string;
        failureCount: number;
        executionCount: number;
        /** The failing statuses only — what a FAILED row prints. */
        statuses: Set<string>;
        /**
         * Every status, failing or not — what the header's per-test outcome
         * breakdown counts. Kept apart from `statuses` because a row that
         * failed and was then rescued must not print `FAIL, PASS`, while the
         * header must still count it under both.
         */
        allStatuses: Set<string>;
        modes: Set<string>;
        passedOnRerun: boolean;
        messages: Map<string, number>;
        otherMessages: Map<string, number>;
    }
    const byTest = new Map<string, Accumulator>();
    const entryFor = (path: string): Accumulator => {
        let entry = byTest.get(path);
        if (entry === undefined) {
            entry = {
                path,
                failureCount: 0,
                executionCount: 0,
                statuses: new Set(),
                allStatuses: new Set(),
                modes: new Set(),
                passedOnRerun: false,
                messages: new Map(),
                otherMessages: new Map(),
            };
            byTest.set(path, entry);
        }
        return entry;
    };

    for (const timing of timings) {
        const entry = entryFor(timing.path);
        entry.executionCount++;
        entry.allStatuses.add(baseStatus(timing.status));
        if (isFailureStatus(timing.status)) {
            entry.failureCount++;
            // The BASE status, as `try` records it: `FAIL-PARALLEL` and
            // `FAIL-SEQUENTIAL` are one verdict in two phases, and this set
            // answers "what happened". The phase lands in `modes`, which
            // `parallelOnly` reads.
            //
            // Failing statuses only, again as `try`. Adding the PASS of a
            // successful rerun here made every rescued row read `FAIL, PASS`,
            // which states the outcome twice and contradicts itself — the
            // rerun is what `passedOnRerun` is for, and it says so in words.
            entry.statuses.add(baseStatus(timing.status));
            entry.modes.add(/-(PARALLEL|SEQUENTIAL)$/.exec(timing.status)?.[1] ?? 'UNRECORDED');
            if (timing.message !== null) {
                entry.messages.set(
                    timing.message,
                    (entry.messages.get(timing.message) ?? 0) + 1
                );
            }
            for (const message of timing.messages) {
                entry.otherMessages.set(
                    message,
                    (entry.otherMessages.get(message) ?? 0) + 1
                );
            }
        } else if (isRetryRescue(timing)) {
            // The harness reran it inside this job and it went green. Within
            // one job this is the same signal `try` calls `passedOnRerun`, and
            // it is the one fact a single task *can* state about intermittency.
            entry.passedOnRerun = true;
        }
    }

    // Distinct tests by outcome. Base statuses, and a test that ended more than
    // one way — failed, then passed on rerun — is counted under each, so these
    // do not partition `testCount` and the renderer does not present them as
    // though they did.
    const statusCounts: Record<string, number> = {};
    for (const entry of byTest.values()) {
        for (const status of entry.allStatuses) {
            statusCounts[status] = (statusCounts[status] ?? 0) + 1;
        }
    }

    const failures: TaskFailure[] = [];
    for (const entry of byTest.values()) {
        if (entry.failureCount === 0) {
            continue;
        }
        const failure: TaskFailure = {
            path: entry.path,
            failureCount: entry.failureCount,
            executionCount: entry.executionCount,
            statuses: [...entry.statuses].sort(),
            passedOnRerun: entry.passedOnRerun,
            parallelOnly: entry.modes.size === 1 && entry.modes.has('PARALLEL'),
            messages: [...entry.messages]
                .sort((a, b) => b[1] - a[1])
                .map(([message]) => message),
            allMessages: [...entry.otherMessages]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([message, count]) => ({ message, count })),
        };
        failures.push(failure);
    }

    return {
        taskId,
        retryId,
        jobName: identity.jobName,
        project: identity.project,
        revision: identity.revision,
        treeherderUrl:
            identity.project !== null && identity.revision !== null
                ? treeherderJobUrl(identity.project, identity.revision, taskId, retryId)
                : null,
        profileUrl,
        testCount: byTest.size,
        executionCount: timings.length,
        rerunCount: timings.filter((timing) => timing.isRerun).length,
        statusCounts,
        // `try`'s default sort, and its deterministic tie-break: failing
        // executions descending, then the path, so two runs over one warm cache
        // produce the same bytes.
        failures: failures.sort(
            (a, b) => b.failureCount - a.failureCount || a.path.localeCompare(b.path)
        ),
    };
}

/** The tests that did not fail, for `--passed`. */
export function nonFailures(
    timings: readonly TestTiming[],
    failures: readonly TaskFailure[]
): TaskOutcome[] {
    const failing = new Set(failures.map((failure) => failure.path));
    const byPath = new Map<string, { statuses: Set<string>; executionCount: number }>();
    for (const timing of timings) {
        if (failing.has(timing.path)) {
            continue;
        }
        let entry = byPath.get(timing.path);
        if (entry === undefined) {
            entry = { statuses: new Set(), executionCount: 0 };
            byPath.set(timing.path, entry);
        }
        entry.statuses.add(baseStatus(timing.status));
        entry.executionCount++;
    }
    return [...byPath]
        .map(([path, entry]) => ({
            path,
            statuses: [...entry.statuses].sort(),
            executionCount: entry.executionCount,
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Fills in each failing row's per-test profile URLs.
 *
 * Always full URLs, whatever the text renderer does with them: `--json` must not
 * make a machine consumer join a base and a filename back together.
 * `profileLines()` is what shortens them to filenames for a terminal.
 *
 * Only the per-test ones: the job's own resource-usage profile is a property of
 * the task rather than of a row, so it is in the header and in `profileUrl`.
 * `try` repeats it per row because a row there spans several tasks; here it
 * would be the same URL on every line.
 */
export function attachProvenance(
    failures: readonly TaskFailure[],
    timings: readonly TestTiming[],
    taskId: string,
    retryId: number
): void {
    const byPath = new Map<string, string[]>();
    for (const timing of timings) {
        if (!isFailureStatus(timing.status)) {
            continue;
        }
        const list = byPath.get(timing.path) ?? [];
        for (const filename of timing.profileFilenames) {
            // Every profile the executions uploaded, not the first: an in-job
            // rerun adds a `-2`-suffixed one and comparing the two is what the
            // list is for.
            if (!list.includes(filename)) {
                list.push(filename);
            }
        }
        byPath.set(timing.path, list);
    }
    for (const failure of failures) {
        // The task run is the command's argument, not something to look up per
        // row: every timing here came out of the one profile.
        failure.testProfiles = (byPath.get(failure.path) ?? []).map((filename) =>
            testInfoArtifactUrl(taskId, retryId, filename)
        );
    }
}
