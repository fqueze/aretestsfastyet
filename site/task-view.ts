/**
 * `task.html`'s view model: every decision the page makes, and nothing that
 * touches the DOM.
 *
 * The aggregation itself is `lib/query/task-summary.ts`, shared with
 * `fx-tests task`; this file only shapes it for a page — the URL state, the
 * all-tests table, the artifact list, and the run facts out of the queue's
 * task status.
 */

import { parseTaskId } from '../lib/formats/tables.ts';
import {
    FIREFOX_CI_ROOT,
    TREEHERDER_ROOT,
    crashViewerUrl,
    profilerFrontEndUrl,
    resourceUsageProfileUrl,
    taskArtifactUrl,
    testInfoArtifactUrl,
} from '../lib/links.ts';
import type { DroppedMarker, TestTiming } from '../lib/model/test-markers.ts';
import { stripChunkSuffix } from '../lib/model/job-name.ts';
import { normalizeTestPath } from '../lib/model/test-path.ts';
import { baseStatus, isFailureStatus } from '../lib/model/try-jobs.ts';
import { type TaskDefinition, type TaskFailure, type TaskJson, isRetryRescue } from '../lib/query/task-summary.ts';
import type { FlakinessRequest } from './try-view.ts';

// --- URL state -----------------------------------------------------------

/** What the page was asked to show. */
export interface TaskPageParams {
    taskId: string;
    retryId: number;
    /** A test path to scroll to and highlight, from a page that linked here. */
    test: string | null;
}

/** A Taskcluster task ID: 22 URL-safe base64 characters. */
const TASK_ID = /^[A-Za-z0-9_-]{22}$/;

/**
 * A task run out of whatever a reader pasted, or `null`.
 *
 * Accepts `<taskId>[.<retryId>]`, a Treeherder URL carrying
 * `selectedTaskRun=`, and a Taskcluster task URL — the three places a task ID
 * is usually copied from.
 */
export function parseTaskInput(raw: string): { taskId: string; retryId: number } | null {
    const text = raw.trim();
    const selected = /[?&]selectedTaskRun=([A-Za-z0-9_-]{22}(?:\.\d+)?)/.exec(text);
    if (selected !== null) {
        return parseTaskId(selected[1]!);
    }
    const tasks = /\/tasks\/([A-Za-z0-9_-]{22})(?:\/runs\/(\d+))?/.exec(text);
    if (tasks !== null) {
        return { taskId: tasks[1]!, retryId: tasks[2] === undefined ? 0 : Number(tasks[2]) };
    }
    const parsed = parseTaskId(text);
    return TASK_ID.test(parsed.taskId) ? parsed : null;
}

/** The page's parameters out of `location.search`, or `null` when there is no task. */
export function readParams(search: string): TaskPageParams | null {
    const params = new URLSearchParams(search);
    const task = parseTaskInput(params.get('task') ?? '');
    if (task === null) {
        return null;
    }
    return { ...task, test: params.get('test') || null };
}

/**
 * Whether a row is the test a linking page named.
 *
 * Exact on a path, and on a bare file name when that is all the linking page
 * had: the drilldown rows of `crashes.html` and `failures.html` carry the name
 * under a directory, not the path.
 */
export function matchesTest(path: string, test: string | null): boolean {
    if (test === null || test === '') {
        return false;
    }
    return path === test || (!test.includes('/') && path.endsWith(`/${test}`));
}

/** The `task.html` query string for one task run. */
export function taskPageSearch(taskId: string, retryId: number, test?: string | null): string {
    const params = new URLSearchParams({ task: `${taskId}.${retryId}` });
    if (test) {
        params.set('test', test);
    }
    return `?${params.toString()}`;
}

// --- the queue's view of the task ----------------------------------------

/** The task definition fields this page reads, beyond the ones `taskIdentity` does. */
export interface PageTaskDefinition extends TaskDefinition {
    taskGroupId?: string;
    workerType?: string;
    provisionerId?: string;
    created?: string;
    payload?: { maxRunTime?: number };
}

/** One run, as `task/<id>/status` returns it. */
export interface TaskRun {
    runId: number;
    state: string;
    reasonCreated?: string;
    reasonResolved?: string;
    workerGroup?: string;
    workerId?: string;
    scheduled?: string;
    started?: string;
    resolved?: string;
}

/** `task/<id>/status`. */
export interface TaskStatus {
    status: { state: string; runs?: TaskRun[] };
}

/** A run of text in a fact, with its tooltip. */
export interface FactPart {
    text: string;
    title?: string;
}

/** One labelled fact in the header. */
export interface Fact {
    label: string;
    parts: FactPart[];
}

/** `2026-09-27T14:03:11.123Z` → `2026-09-27 14:03 UTC`. */
function formatTime(iso: string): string {
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** How long ago, in the one unit that reads naturally: minutes, hours or days. */
export function formatAgo(ms: number): string {
    if (ms < 60_000) {
        return 'just now';
    }
    const minutes = Math.round(ms / 60_000);
    if (minutes < 90) {
        return `${plural(minutes, 'minute')} ago`;
    }
    const hours = Math.round(minutes / 60);
    return hours < 36 ? `${plural(hours, 'hour')} ago` : `${plural(Math.round(hours / 24), 'day')} ago`;
}

/** A run's length in words: `27 minutes`, `1 h 32 min`. */
export function formatRunLength(ms: number): string {
    if (ms < 60_000) {
        return plural(Math.round(ms / 1000), 'second');
    }
    const minutes = Math.round(ms / 60_000);
    if (minutes < 90) {
        return plural(minutes, 'minute');
    }
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/**
 * The facts the header lists for the selected run.
 *
 * "Ran 3 hours ago for 27 minutes (31% of allowed time)": when, as a relative
 * time with the timestamp as its tooltip, and how long against the task's
 * `maxRunTime`, which is the tooltip of the percentage. The worker carries its
 * pool in parentheses.
 */
export function runFacts(
    run: TaskRun | null,
    definition: PageTaskDefinition | null,
    now: number = Date.now()
): Fact[] {
    const facts: Fact[] = [];
    if (run !== null) {
        // The state itself is the badge beside the title; the reason is only
        // worth a line when it says more, as `exception (deadline-exceeded)`.
        if (run.reasonResolved !== undefined && run.reasonResolved !== run.state) {
            facts.push({ label: 'Resolved', parts: [{ text: run.reasonResolved }] });
        }
        if (run.started !== undefined) {
            const started = Date.parse(run.started);
            const parts: FactPart[] = [{ text: formatAgo(now - started), title: formatTime(run.started) }];
            if (run.resolved !== undefined) {
                const ms = Date.parse(run.resolved) - started;
                parts.push({ text: ` for ${formatRunLength(ms)}` });
                const max = definition?.payload?.maxRunTime;
                if (max !== undefined && max > 0) {
                    parts.push({ text: ' (' });
                    parts.push({
                        text: `${Math.round((ms / (max * 1000)) * 100)}% of allowed time`,
                        title: `maxRunTime ${formatRunLength(max * 1000)}`,
                    });
                    parts.push({ text: ')' });
                }
            } else {
                parts[0] = { ...parts[0]!, text: `started ${parts[0]!.text}, still running` };
            }
            facts.push({ label: 'Ran', parts });
        }
    }
    const pool =
        definition?.workerType === undefined ? null : `${definition.provisionerId ?? ''}/${definition.workerType}`;
    if (run?.workerId !== undefined) {
        facts.push({
            label: 'Worker',
            parts: [
                { text: run.workerId, ...(run.workerGroup === undefined ? {} : { title: run.workerGroup }) },
                ...(pool === null ? [] : [{ text: ` (${pool})` }]),
            ],
        });
    } else if (pool !== null) {
        facts.push({ label: 'Worker pool', parts: [{ text: pool }] });
    }
    return facts;
}

/** The Taskcluster UI for one run. */
export function taskclusterRunUrl(taskId: string, retryId: number): string {
    return `${FIREFOX_CI_ROOT}/tasks/${taskId}/runs/${retryId}`;
}

/** Treeherder's parsed-log view of one job, by its Treeherder job ID. */
export function treeherderLogUrl(repository: string, jobId: number): string {
    return `${TREEHERDER_ROOT}/logviewer?${new URLSearchParams({ job_id: String(jobId), repo: repository })}`;
}

/** A job's raw log. */
export function liveLogUrl(taskId: string, retryId: number): string {
    return taskArtifactUrl(taskId, retryId, 'public/logs/live_backing.log');
}

/** The resource-usage profile in the profiler. */
export function jobProfilerUrl(taskId: string, retryId: number, jobName: string | null, origin: string): string {
    return profilerFrontEndUrl(resourceUsageProfileUrl(taskId, retryId), {
        profileName: `${jobName ?? taskId} (${taskId}.${retryId})`,
        origin,
    });
}

// --- the summary line ----------------------------------------------------

/**
 * What the permanent-failures section says when it has no rows.
 *
 * "The job succeeded" only when the queue says so: no permanent failure is
 * not the same as a green job, since a harness crash or a leak recorded
 * against a manifest fails the job without failing a test.
 */
export function noPermanentFailureNote(result: TaskJson, run: TaskRun | null): string {
    if (result.testCount === 0) {
        return (
            'This profile records no tests at all. Either the job is not a test job, or the ' +
            'harness died before it ran one — the log is the next step.'
        );
    }
    if (run !== null && run.state === 'completed') {
        return 'The job succeeded.';
    }
    return (
        'No test failed permanently. If the job is red, the failure is not attributed to a ' +
        'test: a harness crash, a leak check, or a shutdown hang recorded against a manifest. ' +
        'Read the log.'
    );
}

/** How each test's executions ended, across the initial run and the harness's retry. */
export interface OutcomeTally {
    passed: number;
    failedThenPassed: number;
    failedTwice: number;
    failedNotRetried: number;
    /** Passed at first, failed in the retry phase. */
    failedOnlyOnRetry: number;
    /** Failed, then retried to an outcome that is neither a pass nor a failure. */
    failedRetryOther: number;
    skipped: number;
    /** Neither: e.g. only `UNKNOWN` markers. */
    other: number;
}

/**
 * One count per test, by what its initial run and its retry did.
 *
 * Read off `isRerun`, the marker range the harness wraps its retry in — not
 * off the execution count, which also grows when a test is listed in two
 * manifests (`TaskJson.executionCount` says why).
 */
export function outcomeTally(timings: readonly TestTiming[]): OutcomeTally {
    interface Phases {
        initialFail: boolean;
        retryFail: boolean;
        retryPass: boolean;
        retried: boolean;
        statuses: Set<string>;
    }
    const byPath = new Map<string, Phases>();
    for (const timing of timings) {
        let entry = byPath.get(timing.path);
        if (entry === undefined) {
            entry = { initialFail: false, retryFail: false, retryPass: false, retried: false, statuses: new Set() };
            byPath.set(timing.path, entry);
        }
        const failed = isFailureStatus(timing.status);
        entry.statuses.add(baseStatus(timing.status));
        if (timing.isRerun) {
            entry.retried = true;
            if (failed) {
                entry.retryFail = true;
            } else if (isRetryRescue(timing)) {
                entry.retryPass = true;
            }
        } else if (failed) {
            entry.initialFail = true;
        }
    }
    const tally: OutcomeTally = {
        passed: 0,
        failedThenPassed: 0,
        failedTwice: 0,
        failedNotRetried: 0,
        failedOnlyOnRetry: 0,
        failedRetryOther: 0,
        skipped: 0,
        other: 0,
    };
    for (const entry of byPath.values()) {
        if (entry.initialFail) {
            if (entry.retryFail) {
                tally.failedTwice++;
            } else if (entry.retryPass) {
                tally.failedThenPassed++;
            } else if (!entry.retried) {
                tally.failedNotRetried++;
            } else {
                tally.failedRetryOther++;
            }
        } else if (entry.retryFail) {
            tally.failedOnlyOnRetry++;
        } else {
            const outcome = outcomeOf([...entry.statuses]);
            if (outcome === 'passed') {
                tally.passed++;
            } else if (outcome === 'skipped') {
                tally.skipped++;
            } else {
                tally.other++;
            }
        }
    }
    return tally;
}

/** The tally as one sentence, leaving out the kinds with nothing in them. */
export function outcomeSentence(tally: OutcomeTally): string {
    const parts: [number, string][] = [
        [tally.passed, 'passed'],
        [tally.failedThenPassed, 'failed then passed on retry'],
        [tally.failedTwice, 'failed twice'],
        [tally.failedNotRetried, 'failed but were not retried'],
        [tally.failedOnlyOnRetry, 'passed then failed on retry'],
        [tally.failedRetryOther, 'failed and were retried without a result'],
        [tally.skipped, 'skipped'],
        [tally.other, 'with no recorded outcome'],
    ];
    const shown = parts.filter(([count], index) => count > 0 || index === 0);
    return `${shown.map(([count, text]) => `${count} ${text}`).join(', ')}.`;
}

// --- failures ------------------------------------------------------------

/** A link with a label. */
export interface Link {
    label: string;
    url: string;
}

/** One line of a failure's assertion list. */
export interface AssertionView {
    message: string;
    stack: string | null;
    /** Set on a crash signature: the crash viewer, when a dump was uploaded. */
    crash: { url: string | null } | null;
}

/** The lines of one phase, labelled when the test was retried. */
export interface PhaseView {
    label: 'Initial' | 'Retry' | null;
    /** The per-test profile that phase uploaded, in the profiler. */
    profile: string | null;
    items: AssertionView[];
}

/** One failing test, ready to render in `try.html`'s shape. */
export interface FailureView {
    path: string;
    statuses: string[];
    failureCount: number;
    /** The first line every failing execution shares, for under the path. */
    commonMessage: string | null;
    /** The first per-test profile, for the row's profiler icon. */
    profile: string | null;
    phases: PhaseView[];
    /**
     * Which section it goes in: `passedOnRetry` for a test that failed at
     * first and passed when the harness retried it, `permanent` for the rest
     * — failed twice, failed and was not retried, or failed only on retry.
     * The same split `outcomeTally` counts, so the headings match the summary.
     */
    category: 'permanent' | 'passedOnRetry';
    /** Roughly how many lines the assertion list takes, stacks included. */
    lines: number;
}

/** Above this many lines, a failure's output is cut short behind "show more". */
export const DETAIL_LINES = 12;

/** The failing rows, in `summarize`'s order. */
export function failureViews(
    result: TaskJson,
    timings: readonly TestTiming[],
    origin: string
): FailureView[] {
    const byPath = new Map<string, TestTiming[]>();
    for (const timing of timings) {
        const list = byPath.get(timing.path) ?? [];
        list.push(timing);
        byPath.set(timing.path, list);
    }
    return result.failures.map((failure) =>
        failureView(failure, byPath.get(failure.path) ?? [], result, origin)
    );
}

function failureView(
    failure: TaskFailure,
    executions: readonly TestTiming[],
    result: TaskJson,
    origin: string
): FailureView {
    const sorted = [...executions].sort((a, b) => a.start - b.start);
    const failing = sorted.filter((timing) => isFailureStatus(timing.status));
    const initial = failing.filter((timing) => !timing.isRerun);
    const retry = failing.filter((timing) => timing.isRerun);
    const passedOnRetry = failure.passedOnRerun && retry.length === 0;
    // Split into phases only when there is a failing retry to show. A test
    // that passed on retry is in a section saying so, which is what the
    // "Initial" chip and `try.html`'s "Passed on retry" line would repeat.
    const showRuns = retry.length > 0;
    const name = failure.path.split('/').pop() ?? failure.path;

    const profileOf = (group: readonly TestTiming[]): string | null => {
        const filename = group.flatMap((timing) => timing.profileFilenames)[0];
        return filename === undefined
            ? null
            : profilerFrontEndUrl(testInfoArtifactUrl(result.taskId, result.retryId, filename), {
                  profileName: `${result.jobName ?? result.taskId} — ${name}`,
                  origin,
              });
    };
    const itemsOf = (group: readonly TestTiming[]): AssertionView[] =>
        group.flatMap((timing): AssertionView[] => {
            const items: AssertionView[] = [];
            if (timing.status.startsWith('CRASH')) {
                items.push({
                    message: timing.message ?? 'CRASH',
                    stack: null,
                    crash: {
                        url:
                            timing.minidump === null
                                ? null
                                : crashViewerUrl(result.taskId, result.retryId, timing.minidump),
                    },
                });
            }
            for (const detail of timing.details) {
                items.push({ message: detail.message, stack: detail.stack, crash: null });
            }
            if (items.length === 0 && timing.message !== null) {
                items.push({ message: timing.message, stack: null, crash: null });
            }
            return items;
        });

    const phases: PhaseView[] = showRuns
        ? [
              { label: 'Initial' as const, profile: profileOf(initial), items: itemsOf(initial) },
              { label: 'Retry' as const, profile: profileOf(retry), items: itemsOf(retry) },
          ]
        : [{ label: null, profile: null, items: itemsOf(failing) }];

    const firsts = new Set(failing.map((timing) => timing.message ?? ''));
    const common = firsts.size === 1 ? [...firsts][0]! : '';
    return {
        path: failure.path,
        statuses: failure.statuses,
        failureCount: failure.failureCount,
        commonMessage: common === '' ? null : (common.split('\n')[0] ?? null),
        profile: profileOf(failing),
        phases,
        category: passedOnRetry ? 'passedOnRetry' : 'permanent',

        lines: phases.reduce(
            (sum, phase) =>
                sum +
                (phase.label === null ? 0 : 1) +
                phase.items.reduce(
                    (n, item) => n + item.message.split('\n').length + (item.stack?.split('\n').length ?? 0),
                    0
                ),
            0
        ),
    };
}

/**
 * What `try.html`'s flakiness worker is asked about each failing test: its
 * messages here, whether it timed out or crashed, and this job's configuration
 * — chunk-stripped, as the 21-day aggregates store job names — as the one
 * configuration to compare against.
 */
export function flakinessRequestsForTask(
    result: TaskJson,
    timings: readonly TestTiming[]
): FlakinessRequest[] {
    const jobName = result.jobName === null ? [] : [stripChunkSuffix(result.jobName)];
    return result.failures.map((failure) => {
        const failing = timings.filter((timing) => timing.path === failure.path && isFailureStatus(timing.status));
        return {
            path: failure.path,
            tryMessages: [
                ...new Set(failing.map((timing) => timing.message).filter((message): message is string => message !== null)),
            ],
            hasTimeout: failing.some((timing) => timing.status.startsWith('TIMEOUT')),
            hasCrash: failing.some((timing) => timing.status.startsWith('CRASH')),
            jobNames: jobName,
        };
    });
}

/** A failing marker that named no test, ready to render. */
export interface DroppedView {
    id: string;
    status: string;
    crash: Link | null;
}

/** The failing markers the table cannot hold, deduplicated. */
export function droppedViews(
    dropped: readonly DroppedMarker[],
    taskId: string,
    retryId: number
): DroppedView[] {
    const seen = new Set<string>();
    const views: DroppedView[] = [];
    for (const marker of dropped) {
        const key = `${marker.kind}\n${marker.id}\n${marker.status}\n${marker.minidump ?? ''}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        views.push({
            id: marker.id === '' ? '(no test named)' : marker.id,
            status: marker.status,
            crash:
                marker.minidump === null
                    ? null
                    : { label: 'Crash', url: crashViewerUrl(taskId, retryId, marker.minidump) },
        });
    }
    return views;
}

// --- every test ----------------------------------------------------------

/** How a test ended, coarsely, for the filter. */
export type Outcome = 'failed' | 'passed' | 'skipped' | 'other';

/** One test in the all-tests table. */
export interface TestRow {
    path: string;
    /** Distinct base statuses, in execution order. */
    statuses: string[];
    outcome: Outcome;
    executions: number;
    reruns: number;
    /** Summed over its executions, in ms. */
    duration: number;
    /** When its first execution started, for the run-order sort. */
    firstStart: number;
}

const PASSING = new Set(['PASS', 'EXPECTED-FAIL', 'OK']);

function outcomeOf(statuses: readonly string[]): Outcome {
    if (statuses.some(isFailureStatus)) {
        return 'failed';
    }
    if (statuses.some((status) => PASSING.has(status))) {
        return 'passed';
    }
    if (statuses.length > 0 && statuses.every((status) => status === 'SKIP')) {
        return 'skipped';
    }
    return 'other';
}

/** One row per test path, in the order the job first ran them. */
export function testRows(timings: readonly TestTiming[]): TestRow[] {
    const byPath = new Map<string, TestRow>();
    for (const timing of timings) {
        let row = byPath.get(timing.path);
        if (row === undefined) {
            row = {
                path: timing.path,
                statuses: [],
                outcome: 'other',
                executions: 0,
                reruns: 0,
                duration: 0,
                firstStart: timing.start,
            };
            byPath.set(timing.path, row);
        }
        const status = baseStatus(timing.status);
        if (!row.statuses.includes(status)) {
            row.statuses.push(status);
        }
        row.executions++;
        if (timing.isRerun) {
            row.reruns++;
        }
        row.duration += timing.duration;
        row.firstStart = Math.min(row.firstStart, timing.start);
    }
    const rows = [...byPath.values()];
    for (const row of rows) {
        row.outcome = outcomeOf(row.statuses);
    }
    return rows.sort((a, b) => a.firstStart - b.firstStart || a.path.localeCompare(b.path));
}

/** A path as its directory, for grey, and its file name, which is what a reader scans for. */
export function splitPath(path: string): { directory: string; name: string } {
    const slash = path.lastIndexOf('/');
    return { directory: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** The table's sort orders. */
export type TestSort = 'order' | 'duration' | 'path';

/** The all-tests table's controls. */
export interface TestFilter {
    text: string;
    outcome: Outcome | 'all';
    sort: TestSort;
}

/** The rows the controls select, in the order they ask for. */
export function selectRows(rows: readonly TestRow[], filter: TestFilter): TestRow[] {
    const needle = filter.text.trim().toLowerCase();
    const selected = rows.filter(
        (row) =>
            (filter.outcome === 'all' || row.outcome === filter.outcome) &&
            (needle === '' || row.path.toLowerCase().includes(needle))
    );
    if (filter.sort === 'duration') {
        selected.sort((a, b) => b.duration - a.duration || a.path.localeCompare(b.path));
    } else if (filter.sort === 'path') {
        selected.sort((a, b) => a.path.localeCompare(b.path));
    }
    return selected;
}

/** How many rows each outcome has, for the filter's labels. */
export function outcomeCounts(rows: readonly TestRow[]): Record<Outcome | 'all', number> {
    const counts = { all: rows.length, failed: 0, passed: 0, skipped: 0, other: 0 };
    for (const row of rows) {
        counts[row.outcome]++;
    }
    return counts;
}

// --- manifests -----------------------------------------------------------

/**
 * Each test's manifest, from the run's `public/test_info/summary.jsonl`.
 *
 * The profile does not say: a mochitest `Test` marker names the test alone,
 * and an xpcshell one carries a bare `xpcshell.toml:` on a minority of tests
 * (132 of 2,453 on task `GABDuN0ETSKsyOWEeovFaA`). The harness's own
 * `test_start` lines carry the full manifest path as `group` on every test.
 */
export function manifestsFromSummary(text: string): Map<string, string> {
    const manifests = new Map<string, string>();
    for (const line of text.split('\n')) {
        if (!line.includes('"test_start"')) {
            continue;
        }
        let entry: { action?: string; test?: string; group?: string };
        try {
            entry = JSON.parse(line) as typeof entry;
        } catch {
            continue;
        }
        const path = normalizeTestPath(entry.test);
        if (entry.action === 'test_start' && path !== null && entry.group) {
            manifests.set(path, entry.group);
        }
    }
    return manifests;
}

/** The tests of one manifest. */
export interface ManifestGroup {
    /** The manifest path, or the test directory when no manifest is known. */
    manifest: string;
    known: boolean;
    rows: TestRow[];
    duration: number;
    firstStart: number;
    failed: number;
}

/** The rows grouped by manifest, in the order the job first reached each. */
export function manifestGroups(
    rows: readonly TestRow[],
    manifests: ReadonlyMap<string, string> | null
): ManifestGroup[] {
    // A skipped test gets no `test_start` line, so it has no recorded
    // manifest. Measured on task `Y-sVoD8-RE2PgHb5vDWs4Q`: its 4 skips were
    // exactly the tests missing from `summary.jsonl`. Each is put in the
    // manifest of its own directory when the run recorded exactly one there,
    // and grouped by directory otherwise rather than guessed between two.
    const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1);
    const byDirectory = new Map<string, Set<string>>();
    for (const manifest of manifests?.values() ?? []) {
        const set = byDirectory.get(dirOf(manifest)) ?? new Set<string>();
        set.add(manifest);
        byDirectory.set(dirOf(manifest), set);
    }
    const manifestOf = (path: string): string | undefined => {
        const recorded = manifests?.get(path);
        if (recorded !== undefined) {
            return recorded;
        }
        const candidates = byDirectory.get(dirOf(path));
        return candidates?.size === 1 ? [...candidates][0] : undefined;
    };
    const groups = new Map<string, ManifestGroup>();
    for (const row of rows) {
        const known = manifestOf(row.path);
        const key = known ?? dirOf(row.path);
        let group = groups.get(key);
        if (group === undefined) {
            group = { manifest: key, known: known !== undefined, rows: [], duration: 0, firstStart: row.firstStart, failed: 0 };
            groups.set(key, group);
        }
        group.rows.push(row);
        group.duration += row.duration;
        group.firstStart = Math.min(group.firstStart, row.firstStart);
        if (row.outcome === 'failed') {
            group.failed++;
        }
    }
    return [...groups.values()].sort((a, b) => a.firstStart - b.firstStart || a.manifest.localeCompare(b.manifest));
}

/** The manifest row's status: its failures, or PASS or SKIP when it has none. */
export function manifestStatus(group: ManifestGroup): { status: string; count: number | null } | null {
    if (group.failed > 0) {
        return { status: 'FAIL', count: group.failed };
    }
    if (group.rows.some((row) => row.outcome === 'passed')) {
        return { status: 'PASS', count: null };
    }
    if (group.rows.every((row) => row.outcome === 'skipped')) {
        return { status: 'SKIP', count: null };
    }
    return null;
}

/**
 * The fold row under a manifest that shows only its failures: what it hides,
 * e.g. `+ 88 passed tests` or `+ 85 passed, 3 skipped tests`.
 */
export function hiddenRowsLabel(rows: readonly TestRow[]): string {
    const counts = outcomeCounts(rows);
    const parts = (['passed', 'skipped', 'other'] as const)
        .filter((outcome) => counts[outcome] > 0)
        .map((outcome) => `${counts[outcome]} ${outcome}`);
    return `+ ${parts.join(', ')} test${rows.length === 1 ? '' : 's'}`;
}

/** The groups the controls select: each with its selected rows, empty ones dropped. */
export function selectGroups(groups: readonly ManifestGroup[], filter: TestFilter): ManifestGroup[] {
    const selected = groups
        .map((group) => ({ ...group, rows: selectRows(group.rows, filter) }))
        .filter((group) => group.rows.length > 0);
    if (filter.sort === 'duration') {
        selected.sort((a, b) => b.duration - a.duration || a.manifest.localeCompare(b.manifest));
    } else if (filter.sort === 'path') {
        selected.sort((a, b) => a.manifest.localeCompare(b.manifest));
    }
    return selected;
}

// --- artifacts -----------------------------------------------------------

/** One entry of `task/<id>/runs/<n>/artifacts`. */
export interface Artifact {
    name: string;
    /** `reference` for a log still streaming from the worker, which has no stored size. */
    storageType?: string;
    contentType?: string;
    expires?: string;
}

/** One artifact, ready to render. */
export interface ArtifactRow {
    name: string;
    url: string;
    /** A better way to open it than downloading it, when there is one. */
    viewer: Link | null;
}

/** A byte count at the precision a file list wants. */
export function formatBytes(bytes: number): string {
    if (bytes < 1000) {
        return `${bytes} B`;
    }
    const units = ['kB', 'MB', 'GB'];
    let value = bytes / 1000;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Sizes the harness recorded for what it uploaded, by artifact name.
 *
 * The profile's `Artifact` markers name each file under `public/test_info/`
 * with its size before upload. They matter because the storage answers a HEAD
 * with the **compressed** size of a gzip-stored file — 982 kB for a
 * `profile_resource-usage.json` whose marker says 20.9 MB, measured on task
 * `K-PZiLvGQTWmnPPGkwMbpQ`.
 */
export function artifactSizesFromProfile(profile: unknown): Map<string, number> {
    const sizes = new Map<string, number>();
    const markers = (profile as { threads?: { markers?: { data?: unknown[] } }[] })?.threads?.[0]?.markers;
    for (const data of markers?.data ?? []) {
        const entry = data as { type?: string; filename?: string; size?: number } | null;
        if (entry?.type === 'Artifact' && entry.filename !== undefined && typeof entry.size === 'number') {
            sizes.set(`public/test_info/${entry.filename}`, entry.size);
        }
    }
    return sizes;
}

/** What a HEAD on an artifact says about its size. */
export interface ArtifactSize {
    bytes: number;
    /** True when only the gzip-compressed size is known. */
    compressed: boolean;
}

/**
 * The size out of a HEAD response's headers, or `null`.
 *
 * The storage sends `content-length` only for a file stored as is; for one
 * stored gzipped it sends `x-goog-stored-content-length`, the compressed size,
 * and serves the bytes decompressed.
 */
export function artifactSizeFromHeaders(get: (name: string) => string | null): ArtifactSize | null {
    const encoding = get('x-goog-stored-content-encoding');
    const stored = Number(get('x-goog-stored-content-length'));
    if (encoding === 'gzip' && Number.isFinite(stored) && stored > 0) {
        return { bytes: stored, compressed: true };
    }
    const length = Number(get('content-length') ?? NaN);
    return Number.isFinite(length) ? { bytes: length, compressed: false } : null;
}

/** The minidump-stackwalk output the crash viewer reads. */
const MINIDUMP_JSON = /^public\/test_info\/([0-9a-fA-F-]{36})\.json$/;
/** A profile the Firefox Profiler can open. */
const PROFILE = /^public\/test_info\/(profile_[^/]+\.json(?:\.gz)?)$/;

/**
 * The run's artifacts, logs first and then by name, each with its viewer.
 *
 * The directory listing is not in the result: `public/logs/` and
 * `public/test_info/` are where everything a reader wants is, and the full
 * name says so on every row.
 */
export function artifactRows(
    artifacts: readonly Artifact[],
    taskId: string,
    retryId: number,
    jobName: string | null,
    origin: string
): ArtifactRow[] {
    const rank = (name: string): number =>
        name.startsWith('public/logs/') ? 0 : name.startsWith('public/test_info/') ? 1 : 2;
    return [...artifacts]
        .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
        .map((artifact) => {
            const url = taskArtifactUrl(taskId, retryId, artifact.name);
            let viewer: Link | null = null;
            const minidump = MINIDUMP_JSON.exec(artifact.name);
            const profile = PROFILE.exec(artifact.name);
            if (minidump !== null) {
                viewer = { label: 'Crash viewer', url: crashViewerUrl(taskId, retryId, minidump[1]!) };
            } else if (profile !== null) {
                viewer = {
                    label: 'Profiler',
                    url:
                        profile[1] === 'profile_resource-usage.json'
                            ? jobProfilerUrl(taskId, retryId, jobName, origin)
                            : profilerFrontEndUrl(url, { profileName: `${profile[1]} (${taskId}.${retryId})`, origin }),
                };
            }
            return { name: artifact.name, url, viewer };
        });
}
