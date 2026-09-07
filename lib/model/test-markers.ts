/**
 * Per-test outcomes from a job's `profile_resource-usage.json`.
 *
 * The **only** source of per-test results for one job run. Nothing publishes a
 * per-push or per-task aggregate of them, so `try.html` (`old/try.html:955`,
 * `profile-worker.js:112`) reads the job's own profile and pulls the
 * `Test`/`TestStatus`/`Crash` markers out of it. This is that read, and it is
 * shared rather than copied: `test/try-parity.test.ts` exists because there
 * are already three parsers of these markers in the tree, and a fourth is what
 * that test was written to prevent.
 *
 * Lifted verbatim out of `cli/commands/try.ts`, which still re-exports it, so
 * that `fx-tests task <taskId>` — the same read against one task instead of a
 * push — could call it rather than grow a copy.
 */

import { normalizeMessage } from './failure-message.ts';
import { type MarkerMessage, type PartitionedMessages, partitionMarkerMessages } from './marker-messages.ts';
import { type TestPathDropReason, describeTestPathDrop, normalizeTestPath } from './test-path.ts';

/**
 * The job run a profile belongs to, as the parser needs it.
 *
 * Structural rather than `TreeherderJob`: these three fields are all the
 * parser reads, and `fx-tests task` has no Treeherder job to hand — it is
 * given a task ID and asks Taskcluster for the name. A `TreeherderJob` still
 * satisfies it, so `fx-tests try` passes one unchanged.
 */
export interface MarkerJob {
    /** e.g. `test-linux2404-64/debug-xpcshell-3`. */
    jobName: string;
    taskId: string;
    /** Taskcluster's `runs/<n>`. */
    retryId: number;
}

/** One test's outcome in one job run, from the job's profile. */
export interface TestTiming {
    path: string;
    status: string;
    /**
     * The message the row shows: the first of `messages`, or the `Test` marker's
     * own when there were no `TestStatus` markers and `messages` is empty.
     */
    message: string | null;
    /** Every message logged, in log order, profile notices partitioned out. */
    messages: string[];
    profileFilenames: string[];
    jobName: string;
    taskId: string;
    /** The **job-level** retry, Taskcluster's `runs/<n>` — a different axis from `isRerun`. */
    retryId: number;
    /**
     * True when the marker fell inside the harness's rerun phase.
     *
     * `site/try-view.ts` calls this field `isRetry` and its derived flag
     * `passedOnRetry`; the table in `lib/model/try-jobs.ts` lines the two
     * vocabularies up and says why the page's cannot simply be renamed.
     */
    isRerun: boolean;
}

/**
 * Whether these bytes are a *streamed* profile rather than a finished one.
 *
 * A job killed for exceeding its `maxRunTime` never gets to write a profile,
 * so what its artifact holds is whatever the profiler had streamed out so far:
 * newline-delimited JSON — a `{"type":"meta",…}` header followed by one
 * document per thread and per chunk — rather than the single object a finished
 * job uploads. `JSON.parse` on the whole thing fails at the first newline,
 * which is why these used to be counted as unreadable.
 *
 * They are neither a read failure nor a data-generation bug, and this tool
 * does not read the format. Telling the two apart is the point: "could not be
 * read" sends a reader looking for a broken download, while "the job was
 * killed" sends them to the job's duration, which is the actual problem.
 *
 * Detected on the shape rather than the parse error, so the check says what it
 * means: a complete JSON document, then more input. Measured on try push
 * 717fc67feaa071, where 57 of 124 fetched profiles are this — 34 to 50 MB
 * each, every one of them a `{"type":"meta"}` first line. Task
 * `DVdj7ZQdTCijqjU02ol-Dw` is the worked example: `maxRunTime` 5400 s, ran
 * 5443 s, resolved `failed`.
 */
export function isStreamedProfile(bytes: Uint8Array): boolean {
    // Only the first line is decoded: these artifacts run to 50 MB and the
    // answer is in the first few hundred bytes.
    const head = new TextDecoder().decode(bytes.subarray(0, 64 * 1024));
    const newline = head.indexOf('\n');
    if (newline < 0) {
        // Either one document (finished, or truncated mid-write) or a first
        // line longer than the window. Not the streamed shape as far as we can
        // tell, so it stays with the genuine read failures.
        return false;
    }
    // A single document with a trailing newline leaves this empty, and an
    // empty string starts with nothing, so the final test already rejects it.
    // There is deliberately no separate `rest === ''` guard: it reads as
    // load-bearing and decides nothing, and a mutation removing it could not
    // be distinguished from the original on 400,000 generated inputs.
    const rest = head.slice(newline + 1).trim();
    try {
        JSON.parse(head.slice(0, newline));
    } catch {
        // The first line is not a document on its own, so whatever is wrong
        // here is not "several documents concatenated".
        return false;
    }
    // What follows has to be another document. Trailing text that is not one —
    // a log line appended to a profile, say — is a different problem and
    // belongs with the genuine read failures.
    return rest.startsWith('{');
}

/** The marker table shape a Gecko profile's first thread has. */
interface ProfileThread {
    stringArray?: string[];
    markers?: {
        length?: number;
        name?: number[];
        data?: ({
            type?: string;
            test?: string;
            name?: string;
            status?: string;
            message?: string;
            color?: string;
            /**
             * The manifest's annotated expectation, when the harness recorded
             * one. Drives `UNEXPECTED-PASS`; see `parseTestMarkers`.
             */
            expected?: string;
            text?: string;
            signature?: string;
            minidump?: string;
            reason?: string;
        } | null)[];
        startTime?: number[];
        endTime?: number[];
    };
}

/**
 * A `TestStatus` marker: one logged failure line, with the message on it.
 *
 * These are where a mochitest failure's message actually lives. The `Test`
 * marker that says `status: 'FAIL'` carries no `message` field at all for a
 * plain assertion failure — measured on task `GwXgN5-rTOOtVkoQvJlDBQ` of try
 * push 7d16bff8, whose two `Test` markers for `browser_sync.js` are
 * `{test, status: 'FAIL', color: 'orange'}` and nothing more, while the
 * twenty-one `TestStatus` markers inside their time ranges carry
 * `"handleEvent() was unable to perform a11y checks on hidden node: …"` and
 * the rest.
 */
interface TestStatusMarker {
    /** The raw `data.test`, still carrying any `manifest.toml:` prefix. */
    test: string;
    time: number;
    message: string;
    /** `FAIL` or `ERROR`, the marker's name in the string table. */
    statusName: string;
}

/**
 * A marker whose id yielded no test path, and why.
 *
 * `kind` matters: a `Test` marker with a non-path id is usually an xpcshell
 * selftest name, while a `Crash` one is a crash the report cannot attribute.
 */
export interface DroppedMarker {
    kind: 'Test' | 'Crash';
    /** `''` when the marker named no test at all. */
    id: string;
    reason: TestPathDropReason;
    status: string;
}

/**
 * The `Test` marker statuses whose drop is worth recording.
 *
 * The xpcshell selftest job names every one of its passing tests with a bare
 * function name, so recording those drops would bury the ones that matter. Raw
 * statuses, before the `-PARALLEL`/`-SEQUENTIAL` suffixes are derived.
 */
const DROP_WORTH_REPORTING = new Set(['FAIL', 'TIMEOUT', 'CRASH', 'ERROR']);

/** A `Crash` marker, before it is matched to a test. */
interface CrashMarker {
    /** The test the crash was recorded against, as written in the marker. */
    testPath: string;
    start: number;
    signature: string | null;
    minidump: string | null;
    reason: string | null;
    /** Set once a `CRASH`-status test marker has claimed it. */
    consumed: boolean;
}

/**
 * Extracts per-test outcomes from a job's resource-usage profile.
 *
 * Ported from `extractTestTimings()` (`profile-worker.js:112`) and the richer
 * copy in `old/try.html:955`. What it keeps from both:
 *
 * - **The `parallel` and `retry` text markers are ranges**, not flags. A test
 *   marker overlapping the `parallel` range ran in parallel; one overlapping
 *   `retry` was the harness's within-job rerun. That is where the
 *   `-PARALLEL`/`-SEQUENTIAL` suffix on a try push comes from — the aggregates
 *   get it from the generator, a push has to derive it.
 * - **`FAIL` with `color === 'green'` is an expected failure**, not a failure.
 *   Missing this reports every `fail-if` annotated test as broken.
 * - **The test path may be `manifest.toml:path/to/test.js`**, and only the part
 *   after the colon is the path the aggregates use. `normalizeTestPath` in
 *   `lib/model/test-path.ts` owns that rule; the `site/try.ts` worker copies it.
 * - **`Crash` markers that no test marker claims become synthetic `CRASH`
 *   entries** (`old/try.html:1042`). This is not an edge case. Measured on the
 *   five failed Linux mochitest jobs of try push 717fc67feaa071: four of them
 *   (`-gpu`, `-gpu-nofis`, `-gpu-swr`, `-gpu-swr-nofis`) had *every* `Test`
 *   marker at `PASS` or `SKIP` — `{SKIP: 9, PASS: 8}` in each — with the
 *   actual failures existing solely as four shutdown-hang `Crash` markers
 *   against tests that had already finished. Without this the command reports
 *   "no test-level failures found" for a push that plainly has them, which is
 *   what it did before this was ported.
 *
 *   The fifth job (`-xorig-2`) is the useful contrast: 767 passes, one real
 *   `FAIL`, and 27 crashes recorded against `.toml` manifests rather than
 *   tests. Those 27 are deliberately dropped by the path filter below —
 *   a manifest is not a test path and has nothing to join against central —
 *   so that job contributes its `FAIL` and nothing else. Pass `dropped` to get
 *   those discards reported rather than inferred from a missing row.
 */
export function parseTestMarkers(
    profile: unknown,
    job: MarkerJob,
    dropped: DroppedMarker[] = []
): TestTiming[] {
    const thread = (profile as { threads?: ProfileThread[] })?.threads?.[0];
    const markers = thread?.markers;
    const stringArray = thread?.stringArray;
    if (markers?.data === undefined || markers.name === undefined || stringArray === undefined) {
        return [];
    }
    const length = markers.length ?? markers.data.length;
    const startTime = markers.startTime ?? [];
    const endTime = markers.endTime ?? [];

    const rangesOf = (text: string): { start: number; end: number }[] => {
        const ranges: { start: number; end: number }[] = [];
        for (let i = 0; i < length; i++) {
            const data = markers.data![i];
            if (data?.type === 'Text' && data.text === text) {
                ranges.push({ start: startTime[i] ?? 0, end: endTime[i] ?? 0 });
            }
        }
        return ranges;
    };
    const parallelRanges = rangesOf('parallel');
    const retryRanges = rangesOf('retry');
    const overlaps = (
        start: number,
        end: number,
        ranges: readonly { start: number; end: number }[]
    ): boolean => ranges.some((range) => start < range.end && end > range.start);

    // Crash markers are collected first so a CRASH-status test marker can
    // claim the one inside its time range, leaving the unclaimed ones to
    // become synthetic entries below.
    const crashMarkers: CrashMarker[] = [];
    for (let i = 0; i < length; i++) {
        const data = markers.data[i];
        if (data?.type !== 'Crash' || data.test === undefined) {
            continue;
        }
        crashMarkers.push({
            testPath: data.test,
            start: startTime[i] ?? 0,
            signature: data.signature ?? null,
            minidump: data.minidump ?? null,
            reason: data.reason ?? null,
            consumed: false,
        });
    }

    // The failure messages, which live on separate `TestStatus` markers rather
    // than on the `Test` marker. Named `FAIL` or `ERROR` in the string table
    // — the marker *name*, not `data.status`, is what distinguishes them.
    // `old/try.html:936`.
    const failStringId = stringArray.indexOf('FAIL');
    const errorStringId = stringArray.indexOf('ERROR');
    const testStatusMarkers: TestStatusMarker[] = [];
    for (let i = 0; i < length; i++) {
        const nameId = markers.name[i];
        if (nameId !== failStringId && nameId !== errorStringId) {
            continue;
        }
        const data = markers.data[i];
        if (data?.type !== 'TestStatus' || data.test === undefined) {
            continue;
        }
        const message = normalizeMessage(data.message ?? null);
        if (message === null) {
            continue;
        }
        testStatusMarkers.push({
            test: data.test,
            time: startTime[i] ?? 0,
            message,
            statusName: stringArray[nameId] ?? 'FAIL',
        });
    }
    // Sorted by time, so the collect below yields harness log order.
    testStatusMarkers.sort((a, b) => a.time - b.time);

    const messagesInRange = (test: string, start: number, end: number): MarkerMessage[] =>
        testStatusMarkers
            .filter(
                (marker) => marker.test === test && marker.time >= start && marker.time <= end
            )
            .map((marker) => ({ message: marker.message, status: marker.statusName }));

    const testStringId = stringArray.indexOf('test');
    const timings: TestTiming[] = [];

    for (let i = 0; i < length; i++) {
        if (markers.name[i] !== testStringId) {
            continue;
        }
        const data = markers.data[i];
        if (data?.type !== 'Test') {
            continue;
        }
        // The full ID keeps the `manifest.toml:` prefix, which is how the
        // `TestStatus` and `Crash` markers name the test; `path` is the
        // stripped form the aggregates use. Both are needed.
        const fullTestId = data.test ?? data.name ?? '';
        const path = normalizeTestPath(fullTestId);
        if (path === null) {
            const status = data.status ?? '';
            if (DROP_WORTH_REPORTING.has(status)) {
                dropped.push({
                    kind: 'Test',
                    id: fullTestId,
                    reason: describeTestPathDrop(fullTestId),
                    status,
                });
            }
            continue;
        }

        const start = startTime[i] ?? 0;
        const end = endTime[i] ?? 0;
        let status = data.status ?? 'UNKNOWN';
        if (status === 'FAIL' && data.color === 'green') {
            status = 'EXPECTED-FAIL';
        } else if (status === 'PASS' && data.expected !== undefined && data.expected !== 'PASS') {
            // A test the manifest annotated `fail-if` that passed anyway: the
            // annotation is now wrong, and that is a thing the push changed.
            // `FAILURE_STATUSES` has always listed `UNEXPECTED-PASS` and this
            // command could not produce it — `data.expected` appeared nowhere
            // in this file — so a shared constant named a value only one of
            // its two consumers could ever emit. `site/try.ts:455` is the
            // branch this mirrors, in the same position in the same chain.
            status = 'UNEXPECTED-PASS';
        } else if (
            ['TIMEOUT', 'FAIL', 'CRASH', 'PASS'].includes(status) &&
            parallelRanges.length > 0
        ) {
            status += overlaps(start, end, parallelRanges) ? '-PARALLEL' : '-SEQUENTIAL';
        }

        let message = normalizeMessage(data.message ?? null);
        // A failing test's messages come from the `TestStatus` markers logged
        // inside its execution, and the first of them overrides the `Test`
        // marker's own `message` when there is one — `old/try.html:983` assigns
        // `allMessages[0].message` over whatever it had. It is usually the
        // only message there is: the `Test` marker has no `message` field for
        // a plain assertion failure, so without this every `FAIL` on the push
        // looks message-less. Measured on push 7d16bff8, that was 12 of the 26
        // failing tests, including all three of its permanent failures.
        //
        // All of them are kept, not just the first, with the `profile uploaded in
        // …` notices partitioned out so no caller has to spot a URL in the list.
        let partitioned: PartitionedMessages = { messages: [], profileFilenames: [] };
        if (status.startsWith('FAIL') || status.startsWith('TIMEOUT') || status === 'ERROR') {
            partitioned = partitionMarkerMessages(messagesInRange(fullTestId, start, end));
            message = partitioned.messages[0] ?? message;
        }
        if (status.startsWith('CRASH')) {
            // Claim the crash marker inside this test's range, so it is not
            // also emitted as a synthetic entry below. Matched on the raw
            // `data.test`, which still carries the manifest prefix the path
            // above had stripped.
            const matching = crashMarkers.find(
                (crash) =>
                    !crash.consumed &&
                    crash.testPath === fullTestId &&
                    crash.start >= start &&
                    crash.start <= end
            );
            if (matching !== undefined) {
                matching.consumed = true;
                message ??= normalizeMessage(matching.signature);
            }
        }

        timings.push({
            path,
            status,
            message,
            messages: partitioned.messages,
            profileFilenames: partitioned.profileFilenames,
            jobName: job.jobName,
            taskId: job.taskId,
            retryId: job.retryId,
            isRerun: retryRanges.length > 0 && overlaps(start, end, retryRanges),
        });
    }

    // Crashes no test marker claimed. `old/try.html:1042`: these happen during
    // manifest teardown or shutdown, so the test they are recorded against has
    // usually already reported PASS. Dropping them loses the only evidence of
    // the failure — measured on push 717fc67feaa071, where four of the five
    // failing Linux jobs had no other evidence at all.
    for (const crash of crashMarkers) {
        if (crash.consumed) {
            continue;
        }
        // The marker's `test` can carry a manifest prefix and a " (finished)"
        // suffix, neither of which is part of the path the aggregates use.
        const path = normalizeTestPath(crash.testPath);
        if (path === null) {
            // A crash against a manifest: real, but with no path to join against
            // central. All of them are recorded, unlike the `Test` loop's.
            dropped.push({
                kind: 'Crash',
                id: crash.testPath,
                reason: describeTestPathDrop(crash.testPath),
                status: 'CRASH',
            });
            continue;
        }
        timings.push({
            path,
            status: 'CRASH',
            message: normalizeMessage(crash.signature ?? crash.reason),
            // The harness uploads a per-test profile from a failure handler that
            // a crash never reaches.
            messages: [],
            profileFilenames: [],
            jobName: job.jobName,
            taskId: job.taskId,
            retryId: job.retryId,
            isRerun: false,
        });
    }

    return timings;
}