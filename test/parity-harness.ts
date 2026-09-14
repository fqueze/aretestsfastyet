/**
 * Shared machinery for the new-page-vs-CLI parity checks (`PARITY.md` §5).
 *
 * Not a test file. It holds the three things the per-page parity suites need
 * and that would otherwise be copied three times:
 *
 * 1. **`invoke`** — one CLI invocation against the checked-in fixtures, offline
 *    by construction. The same shape `cli-step5.test.ts` and `framing.test.ts`
 *    use, deliberately: `PARITY.md` §5's brief says to reuse how the CLI is
 *    already driven rather than inventing a third way.
 * 2. **`synthProfile`** — the piece that makes `try` comparable at all. See
 *    below.
 * 3. **`Divergence` / `assertDeclaredDivergences`** — the allow-list discipline
 *    `test/framing.test.ts` implements for CLI-vs-old-page, applied to
 *    new-page-vs-CLI. A declared divergence whose sides have converged fails.
 *
 * ## Why `synthProfile` exists, and what it is not
 *
 * The page and the CLI read the push from **different sources of the same
 * bytes**: `site/try.ts` parses the resource-usage profile in a web worker,
 * `cli/commands/try.ts` parses it with `parseTestMarkers`. There is no shared
 * `lib/` module for that step, so a parity check has to feed both the same
 * profile.
 *
 * `test/fixtures/try-7d16bff81bb1.json` holds the **page side already parsed**
 * — its `timings` were produced by running the page's own worker source over
 * the push's 39 parseable profiles (`test/try-view.test.ts` documents the
 * capture). What it does not hold is the profiles themselves, which are tens of
 * megabytes.
 *
 * So `synthProfile` reconstructs a marker stream that re-parses to those
 * timings. That inverts the page's parser to build input for the CLI's, which
 * is a real limitation and is stated rather than hidden: it means the two
 * parsers are compared **through** a reconstruction, so a difference in how
 * they read a marker shape the fixture does not contain is invisible here. What
 * it does catch is every difference in what the two do with a marker stream
 * they both see — measured: it found two, both listed in `try-parity.test.ts`.
 *
 * The reconstruction is checked, not assumed: `try-parity.test.ts`'s first test
 * re-parses every synthesized profile and asserts the result equals the
 * fixture's timings field for field, with the differences enumerated. If the
 * synthesis drifted, that test fails before any parity claim is made.
 */

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import {
    type DataFileName,
    type DataSource,
    DataFileNotFoundError,
} from '../lib/sources/source.ts';
import type { TreeherderClient, TreeherderJob } from '../lib/sources/treeherder.ts';
import { captureStreams } from '../cli/context.ts';
import { diskCache } from '../cli/cache.ts';
import { run } from '../cli/main.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

/** A fixture's bytes. */
export function fixtureBytes(name: string): Uint8Array {
    return new Uint8Array(readFileSync(new URL(name, FIXTURES)));
}

/** A fixture's parsed JSON. */
export function fixtureJson<T>(name: string): T {
    return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;
}

// =========================================================================
// Driving the CLI
// =========================================================================

/** The published files, under the names the CLI asks for. */
const FILES: Record<string, string> = {
    'xpcshell-timings/index.json': 'index.json',
    'mochitest-timings/index.json': 'index.json',
    'xpcshell-timings/xpcshell-00.json': 'xpcshell-00.json',
    'mochitest-timings/mochitest-00.json': 'mochitest-00.json',
};

/** A data source over the fixtures, recording what was asked for. */
export function fixtureSource(
    overrides: Record<string, string> = {}
): DataSource & { requested: string[] } {
    const requested: string[] = [];
    const files = { ...FILES, ...overrides };
    return {
        name: 'fixtures',
        requested,
        fetch(fileName: DataFileName): Promise<Uint8Array> {
            const key = `${fileName.index}/${fileName.filename}`;
            requested.push(key);
            const local = files[key];
            if (local === undefined) {
                return Promise.reject(new DataFileNotFoundError(fileName));
            }
            return Promise.resolve(fixtureBytes(local));
        },
    };
}

/** A task-artifact source over the two stackwalk dumps. */
export function artifactSource(
    map: Record<string, string>
): DataSource & { requested: string[] } {
    const requested: string[] = [];
    return {
        name: 'fixture-artifacts',
        requested,
        fetch(name: DataFileName): Promise<Uint8Array> {
            const key = `${name.index}/${name.filename}`;
            requested.push(key);
            const local = map[key];
            if (local === undefined) {
                return Promise.reject(new DataFileNotFoundError(name));
            }
            return Promise.resolve(fixtureBytes(local));
        },
    };
}

/** The result of one CLI invocation. */
export interface Invocation {
    code: number;
    stdout: string;
    stderr: string;
    requested: string[];
}

/**
 * Runs one CLI invocation against the fixtures.
 *
 * The cache directory is one that must never exist: these tests must not read
 * from, or write to, the developer's real cache, or a stale entry would decide
 * whether a parity assertion passes.
 */
export async function invoke(
    argv: string[],
    overrides: Partial<Parameters<typeof run>[0]> = {}
): Promise<Invocation> {
    const streams = captureStreams();
    const source = (overrides.source as DataSource & { requested: string[] }) ?? fixtureSource();
    const code = await run({
        argv,
        streams,
        source,
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-parity-never-used'), ttlMs: 0 }),
        ...overrides,
    });
    return {
        code,
        stdout: streams.stdout,
        stderr: streams.stderr,
        requested: (source as DataSource & { requested?: string[] }).requested ?? [],
    };
}

/** Parses `--json` stdout, failing with the stderr when it is not JSON. */
export function json<T = Record<string, unknown>>(result: Invocation): T {
    assert.equal(result.code, 0, `command failed (${result.code}): ${result.stderr}`);
    try {
        return JSON.parse(result.stdout) as T;
    } catch {
        throw new Error(`stdout was not JSON:\n${result.stdout}\n${result.stderr}`);
    }
}

// =========================================================================
// The pinned try push
// =========================================================================

/** One entry of the pinned push's `timings`, as the page's worker emitted it. */
export interface PushTiming {
    path: string;
    duration: number;
    status: string;
    timestamp: number;
    allMessages: { message: string; status?: string }[];
    message?: string;
    isRetry?: boolean;
    crashSignature?: string;
    minidump?: string;
    jobName: string;
    taskId: string;
    retryId: number;
}

/** The pinned push fixture. */
export interface PushFixture {
    push: string;
    jobs: TreeherderJob[];
    timings: PushTiming[];
}

/** `taskId.retryId` — the key identifying one job run. */
export function runKey(entry: { taskId: string; retryId: number }): string {
    return `${entry.taskId}.${entry.retryId}`;
}

/**
 * Groups a push's timings by the job run they came from.
 *
 * One profile is fetched per job run, so this is the unit `synthProfile` builds.
 */
export function timingsByRun(push: PushFixture): Map<string, PushTiming[]> {
    const byRun = new Map<string, PushTiming[]>();
    for (const timing of push.timings) {
        const key = runKey(timing);
        const list = byRun.get(key);
        if (list === undefined) {
            byRun.set(key, [timing]);
        } else {
            list.push(timing);
        }
    }
    return byRun;
}

/**
 * Rebuilds a Gecko profile whose `Test` markers re-parse to `timings`.
 *
 * The shape is the harness's, and each part is here because one of the two
 * parsers reads it:
 *
 * - A `Test` marker per timing, named by the `test` string-table entry. Both
 *   parsers key on the marker *name*, not on `data.type` alone.
 * - A `TestStatus` marker named `FAIL` before a failing timing that carries a
 *   message. Both parsers take a failing test's message from the `TestStatus`
 *   markers inside its time range rather than from the `Test` marker, so a
 *   message written only onto the `Test` marker would be dropped by both and
 *   the comparison would be of two empty strings.
 * - A `Crash` marker before a timing with a `crashSignature`, inside the
 *   timing's range so the claiming branch fires. A timing whose path has no
 *   test extension gets its crash marker placed **outside** any test range,
 *   which is how a synthetic crash arises in the real data — a crash recorded
 *   during manifest teardown, with no running test to attribute it to.
 * - One `retry` Text marker spanning the reruns, because both parsers decide
 *   `isRetry`/`isRerun` by overlap with that range rather than from a field.
 *
 * No `parallel` range is emitted: the pinned push contains no `-PARALLEL` or
 * `-SEQUENTIAL` status, checked by `try-parity.test.ts`, so emitting one would
 * rewrite every status and compare something the push does not contain.
 */
export function synthProfile(timings: readonly PushTiming[]): unknown {
    const strings = ['test', 'FAIL', 'retry', 'Crash'];
    const name: number[] = [];
    const data: Record<string, unknown>[] = [];
    const startTime: number[] = [];
    const endTime: number[] = [];

    const push = (
        stringName: string,
        markerData: Record<string, unknown>,
        start: number,
        end: number
    ): void => {
        name.push(strings.indexOf(stringName));
        data.push(markerData);
        startTime.push(start);
        endTime.push(end);
    };

    // Non-rerun executions first, then the reruns, so one `retry` range covers
    // exactly the rerun ones. Each execution gets a disjoint two-tick slot, so
    // a `TestStatus` or `Crash` marker placed at its start belongs to it and to
    // no other.
    const ordered = [
        ...timings.filter((timing) => timing.isRetry !== true),
        ...timings.filter((timing) => timing.isRetry === true),
    ];
    const rerunCount = timings.filter((timing) => timing.isRetry === true).length;

    let clock = 1000;
    const slots = ordered.map((timing) => {
        const slot = { timing, start: clock, end: clock + 1 };
        clock += 2;
        return slot;
    });
    if (rerunCount > 0) {
        const first = slots[slots.length - rerunCount]!;
        // Half a tick early, so the first rerun's `start` is strictly inside.
        push('retry', { type: 'Text', text: 'retry' }, first.start - 0.5, clock);
    }

    const hasTestExtension = (path: string): boolean => /\.(js|html|xhtml)$/.test(path);

    for (const { timing, start, end } of slots) {
        if (timing.crashSignature !== undefined) {
            // Inside the range for a real test, outside it for a manifest path:
            // a `.toml` never has a `Test` marker of its own, so its crash is
            // the unclaimed kind that becomes a synthetic entry.
            const at = hasTestExtension(timing.path) ? start : start - 0.75;
            push(
                'Crash',
                {
                    type: 'Crash',
                    test: timing.path,
                    signature: timing.crashSignature,
                    minidump: timing.minidump ?? null,
                    reason: null,
                },
                at,
                at
            );
        }
        if (!hasTestExtension(timing.path)) {
            // No `Test` marker: the manifest path is not a test the harness ran.
            continue;
        }
        for (const entry of timing.allMessages) {
            push(
                'FAIL',
                { type: 'TestStatus', test: timing.path, message: entry.message },
                start,
                start
            );
        }
        // The `Test` marker's own `message`, which both parsers read as the
        // base before a `TestStatus` in range overrides it. It is where a
        // SKIP's `skip-if:` reason lives: the override branch is gated on
        // FAIL/TIMEOUT/ERROR in both, so a skip message written only as a
        // `TestStatus` marker would be dropped by both parsers and the
        // comparison would be of two empty strings.
        const marker: Record<string, unknown> = {
            type: 'Test',
            test: timing.path,
            status: timing.status,
        };
        if (timing.message !== undefined) {
            marker['message'] = timing.message;
        }
        push('test', marker, start, end);
    }

    return {
        meta: { startTime: 0 },
        threads: [{ stringArray: strings, markers: { length: data.length, name, data, startTime, endTime } }],
    };
}

/** A Treeherder client over a fixed push and job list. */
export function fakeTreeherder(
    jobs: readonly TreeherderJob[],
    push: { pushId: number; revision: string; repository: string } = {
        pushId: 1,
        revision: '7d16bff81bb1',
        repository: 'try',
    }
): TreeherderClient {
    return {
        findPush: () => Promise.resolve({ ...push, revisions: [] }),
        jobsOfPush: () => Promise.resolve([...jobs]),
    };
}

/**
 * Serves one synthesized profile per job run of the pinned push.
 *
 * A run with no timings answers `null`, which is what an unreadable artifact
 * looks like to the CLI — and is what 7 of this push's 46 failed test jobs
 * really were.
 */
export function pushProfileFetcher(push: PushFixture): (url: string) => Promise<Uint8Array | null> {
    const byRun = timingsByRun(push);
    const encoder = new TextEncoder();
    return (url: string) => {
        // `https://…/task/<taskId>/runs/<retryId>/artifacts/…`
        const match = /task\/([^/]+)\/runs\/(\d+)\//.exec(url);
        if (match === null) {
            return Promise.resolve(null);
        }
        const timings = byRun.get(`${match[1]}.${match[2]}`);
        if (timings === undefined) {
            return Promise.resolve(null);
        }
        return Promise.resolve(encoder.encode(JSON.stringify(synthProfile(timings))));
    };
}

// =========================================================================
// The allow-list discipline
// =========================================================================

/**
 * A difference between the page and the CLI that is correct and stays.
 *
 * Both sides' observed values are recorded, not just the fact of a difference:
 * `PARITY.md` §4 requires an allow-list entry that stops matching to be a
 * failure, and an entry saying only "these differ" cannot detect that. So each
 * entry carries what each side actually produced, measured, and
 * `assertDeclaredDivergences` fails when the two have converged.
 */
export interface Divergence<T = unknown> {
    /** What differs, in the terms a reader would ask about it. */
    what: string;
    /** Why the difference is correct. Not a label — something to evaluate. */
    reason: string;
    /** What the page's view model produced. */
    page: T;
    /** What the CLI produced. */
    cli: T;
}

/**
 * Asserts every declared divergence still diverges, and every reason is real.
 *
 * The half of the discipline that is easy to leave out and is the whole point:
 * a stale exception is where the next regression hides, because the entry stops
 * protecting anything and starts excusing whatever drifts into its place.
 * `test/framing.test.ts` implements this for the CLI-vs-old-page table; this is
 * the same rule for the new-page-vs-CLI tables.
 */
export function assertDeclaredDivergences(label: string, divergences: readonly Divergence[]): void {
    assert.ok(divergences.length > 0, `${label}: an empty divergence list asserts nothing`);
    for (const divergence of divergences) {
        assert.ok(
            divergence.reason.length > 60,
            `${label}/${divergence.what}: a divergence needs a reason someone can evaluate, ` +
                `not a label — got ${JSON.stringify(divergence.reason)}`
        );
        assert.notDeepEqual(
            divergence.cli,
            divergence.page,
            `${label}: the declared divergence "${divergence.what}" no longer diverges — both ` +
                `sides produced ${JSON.stringify(divergence.cli)}. Delete the entry; leaving it ` +
                `lets the next real difference through unnoticed.\n  Its stated reason was: ` +
                divergence.reason
        );
    }
}

/**
 * Asserts two ranked sequences are identical, reporting the first divergence.
 *
 * `assert.deepEqual` on two long arrays prints both in full and leaves the
 * reader to find the position that moved — which for a 431-row ranking is
 * exactly the work the failure message should have done. This names the index,
 * both entries, and the surrounding rows.
 */
export function assertSameOrder(
    actual: readonly string[],
    expected: readonly string[],
    context: string
): void {
    for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
        if (actual[i] !== expected[i]) {
            const from = Math.max(0, i - 2);
            const window = (list: readonly string[]): string =>
                list
                    .slice(from, i + 3)
                    .map((entry, offset) => `    ${from + offset === i ? '>' : ' '} ${entry}`)
                    .join('\n');
            assert.fail(
                `${context}\n  first difference at index ${i}:\n` +
                    `    page: ${actual[i] ?? '(past the end)'}\n` +
                    `    cli:  ${expected[i] ?? '(past the end)'}\n` +
                    `  page around it:\n${window(actual)}\n` +
                    `  cli around it:\n${window(expected)}`
            );
        }
    }
    assert.equal(actual.length, expected.length, `${context}: different lengths`);
}

/**
 * A recorded window ranking split across that window's days, tiling it exactly.
 *
 * ## Why a fake needs this
 *
 * `intermittent.html` derives its window ranking by summing its per-day
 * `/api/failures/` responses — `rankingFromDays` in `site/intermittent-view.ts`
 * carries the measurement against live Treeherder that says the two are equal.
 * So a fixture client whose per-day answers do **not** sum to its window
 * ranking is a fake the real API contradicts, and a page under it would be
 * tested against a relationship Treeherder does not have.
 *
 * The page-side fakes used to build a day from the fixture's recorded
 * `failuresbybug` occurrences. Those are truncated by the recorder (`PER_BUG`
 * is 8) and span only 4 of the fixture's 7 days, so they summed to 108 where
 * the recorded ranking sums to 4,829 — fine while the ranking came from its own
 * request, and wrong the moment the ranking became the days' sum.
 *
 * ## What this does instead
 *
 * Each entry's recorded `count` is spread over a **contiguous run** of the
 * window's days, chosen from the bug number so the run's length and offset
 * vary between bugs, with the remainder on the run's first days. That gives:
 *
 * - **the days sum to the window exactly**, per bug and overall, which is the
 *   property measured against live Treeherder and the only one asserted;
 * - **zero days at both ends of some rows** — leading zeros before a bug's
 *   first annotation, trailing zeros after its last — which is what the three
 *   sparkline zero-classification tests need to be non-vacuous. A split that
 *   touched every day for every bug would make every row zero-free and pass
 *   those tests without exercising them;
 * - **series that are not flat**, so a sparkline plotting a constant fails;
 * - **determinism**, so a per-day cache assertion sees the same numbers on a
 *   refetch, and a failure is reproducible.
 *
 * It is not a claim about how annotations really distribute over a week; it is
 * a shape that exercises the code paths a real week's data would.
 */
export function rankingByDay(
    ranking: readonly { bugId: number | null; count: number }[],
    dates: readonly string[]
): Map<string, { bugId: number | null; count: number }[]> {
    const byDay = new Map<string, { bugId: number | null; count: number }[]>(
        dates.map((date) => [date, []])
    );
    for (const entry of ranking) {
        // The no-bug group spans the whole window; a bug gets a run derived
        // from its number. `% 3` and `% 2` keep a short window from collapsing
        // every run to its full length.
        const id = entry.bugId ?? 0;
        const span =
            entry.bugId === null ? dates.length : Math.max(1, dates.length - (id % 3) - 1);
        const from = entry.bugId === null ? 0 : Math.min(id % 2, dates.length - span);
        const base = Math.floor(entry.count / span);
        const extra = entry.count % span;
        for (let offset = 0; offset < span; offset++) {
            const count = base + (offset < extra ? 1 : 0);
            if (count > 0) {
                byDay.get(dates[from + offset]!)!.push({ bugId: entry.bugId, count });
            }
        }
    }
    for (const rows of byDay.values()) {
        rows.sort((a, b) => b.count - a.count);
    }
    return byDay;
}
