/**
 * `fx-tests task <taskId>` — one job's own profile, read offline.
 *
 * The command is `fx-tests try` narrowed to a single task, so what is worth
 * asserting is the narrowing rather than the marker parsing: the parser is
 * shared with `try` (`lib/model/test-markers.ts`) and is already pinned by
 * `test/try-parity.test.ts` against the page's two copies. Re-asserting it here
 * would be a fourth place to keep in sync, which is the exact failure mode that
 * moving it into `lib/` was for.
 *
 * So these tests are about the things only this command does:
 *
 * - the two artifacts it reads, and the **order** — the profile before the task
 *   definition, so a typo'd ID reports the typo rather than a warning about a
 *   missing job name;
 * - `<taskId>.<retryId>` reaching the URL, not merely being parsed, which is
 *   the bug `crash`'s equivalent test exists for;
 * - the identity being presentation-only: an unreadable task definition costs
 *   the header a line and no rows;
 * - the exit-code split, including the 400 that a malformed task ID answers and
 *   that must not be reported as transient;
 * - the aggregation `try` does per push done here per job: failing executions
 *   ranked, statuses failing-only, rerun rescues named.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    type DataFileName,
    type DataSource,
    DataFetchError,
    DataFileNotFoundError,
} from '../lib/sources/source.ts';
import { ExitCode } from '../cli/errors.ts';
import { MESSAGE_CAP, messageLines } from '../cli/format/failure-lines.ts';
import { captureStreams } from '../cli/context.ts';
import { diskCache } from '../cli/cache.ts';
import { run } from '../cli/main.ts';

const PROFILE_PATH = 'public/test_info/profile_resource-usage.json';

/**
 * A minimal Gecko profile with the markers the parser reads.
 *
 * The same shape `test/cli.test.ts` builds for `try`, kept local rather than
 * exported from there: that file's helper serves `try`'s cases and would grow a
 * second set of parameters to serve these, which is how a test helper becomes a
 * thing to maintain. Both are ten lines of literal.
 */
function profileWith(
    entries: {
        type: 'Test' | 'Text' | 'TestStatus';
        test?: string;
        text?: string;
        status?: string;
        message?: string;
        color?: string;
        start: number;
        end: number;
    }[]
): Uint8Array {
    // Index 0 is `test`, which is how a `Test` marker is named; `FAIL` gets its
    // own index because a `TestStatus` marker is identified by its *name*, not
    // by `data.status`.
    const stringArray = ['test', 'other', 'FAIL'];
    const nameOf = (entry: (typeof entries)[number]): number =>
        entry.type === 'Test' ? 0 : entry.type === 'TestStatus' ? 2 : 1;
    return new TextEncoder().encode(
        JSON.stringify({
            meta: { startTime: 0 },
            threads: [
                {
                    stringArray,
                    markers: {
                        length: entries.length,
                        name: entries.map(nameOf),
                        data: entries.map((entry) => {
                            const record: Record<string, unknown> = { type: entry.type };
                            for (const key of ['test', 'text', 'status', 'message', 'color'] as const) {
                                if (entry[key] !== undefined) {
                                    record[key] = entry[key];
                                }
                            }
                            return record;
                        }),
                        startTime: entries.map((entry) => entry.start),
                        endTime: entries.map((entry) => entry.end),
                    },
                },
            ],
        })
    );
}

/** A task definition as the Taskcluster queue returns one. */
function definition(name: string, project: string, revision: string): Uint8Array {
    return new TextEncoder().encode(
        JSON.stringify({
            metadata: {
                name,
                source: `https://hg.mozilla.org/integration/${project}/file/${revision}/taskcluster/kinds/test`,
            },
            tags: { label: name, project, 'test-suite': 'mochitest' },
        })
    );
}

const TEST_A = 'dom/base/test/browser_a.js';
const TEST_B = 'dom/base/test/browser_b.js';

/**
 * The profile every default test here runs against.
 *
 * One job, five executions of three tests, chosen so each assertion below has
 * something to bite on: `browser_a.js` fails twice under parallel execution and
 * once more in the rerun phase, so it ranks first on failing executions;
 * `browser_b.js` fails once and is then rescued by the rerun; `browser_c.js`
 * only ever passes and so exists only under `--passed`.
 */
function defaultProfile(): Uint8Array {
    return profileWith([
        { type: 'Text', text: 'parallel', start: 0, end: 100 },
        { type: 'Text', text: 'retry', start: 200, end: 300 },
        { type: 'Test', test: TEST_A, status: 'FAIL', start: 10, end: 20 },
        { type: 'TestStatus', test: TEST_A, message: 'a failed once', start: 15, end: 15 },
        { type: 'Test', test: TEST_A, status: 'FAIL', start: 30, end: 40 },
        { type: 'TestStatus', test: TEST_A, message: 'a failed twice', start: 35, end: 35 },
        { type: 'Test', test: TEST_A, status: 'FAIL', start: 210, end: 220 },
        { type: 'TestStatus', test: TEST_A, message: 'a failed once', start: 215, end: 215 },
        { type: 'Test', test: TEST_B, status: 'FAIL', start: 50, end: 60 },
        { type: 'TestStatus', test: TEST_B, message: 'b blew up', start: 55, end: 55 },
        { type: 'Test', test: TEST_B, status: 'PASS', start: 230, end: 240 },
        { type: 'Test', test: 'dom/base/test/browser_c.js', status: 'PASS', start: 70, end: 80 },
    ]);
}

/**
 * A task-artifact source over an in-memory map, recording what was asked for.
 *
 * The `requested` log is the point: several assertions below are about which
 * artifacts the command reads and in which order, and neither is visible in the
 * output.
 */
function artifacts(
    map: Record<string, Uint8Array>,
    failures: Record<string, { status: number } | 'missing'> = {}
): DataSource & { requested: string[] } {
    const requested: string[] = [];
    return {
        name: 'fixture-artifacts',
        requested,
        fetch(name: DataFileName): Promise<Uint8Array> {
            const key = `${name.index}/${name.filename}`;
            requested.push(key);
            const failure = failures[key];
            if (failure === 'missing') {
                return Promise.reject(new DataFileNotFoundError(name));
            }
            if (failure !== undefined) {
                return Promise.reject(
                    new DataFetchError(name, `HTTP ${failure.status}`, 'url', failure.status)
                );
            }
            const body = map[key];
            if (body === undefined) {
                return Promise.reject(new DataFileNotFoundError(name));
            }
            return Promise.resolve(body);
        },
    };
}

/** The source a healthy `TASK1.0` is served from. */
function healthy(): DataSource & { requested: string[] } {
    return artifacts({
        'TASK1/': definition('test-linux2404-64/debug-mochitest-browser-chrome-3', 'autoland', 'a1b2c3d4e5f6'),
        [`TASK1/runs/0/artifacts/${PROFILE_PATH}`]: defaultProfile(),
    });
}

async function invoke(
    argv: string[],
    taskArtifacts: DataSource
): Promise<{ code: number; stdout: string; stderr: string }> {
    const streams = captureStreams();
    const code = await run({
        argv,
        streams,
        taskArtifacts,
        // A cache directory that must never exist: these tests must not read
        // from, or write to, the developer's real cache.
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-task-never-used'), ttlMs: 0 }),
    });
    return { code, stdout: streams.stdout, stderr: streams.stderr };
}

function json(stdout: string): Record<string, unknown> {
    return JSON.parse(stdout) as Record<string, unknown>;
}

// --- what it reads --------------------------------------------------------

test('task reads the profile before the task definition', async () => {
    // The order is load-bearing, not incidental. `fetchIdentity` only warns, so
    // reading it first meant a typo'd task ID printed "could not read the
    // definition …" and *then* the real error, with the useful message second.
    const source = healthy();
    const { code } = await invoke(['task', 'TASK1', '--json'], source);
    assert.equal(code, ExitCode.Success);
    assert.deepEqual(source.requested, [
        `TASK1/runs/0/artifacts/${PROFILE_PATH}`,
        'TASK1/',
    ]);
});

test('task resolves <taskId>.<retryId> with .0 implied, and the retry reaches the URL', async () => {
    const implied = healthy();
    const first = await invoke(['task', 'TASK1', '--json'], implied);
    assert.equal(json(first.stdout)['retryId'], 0);
    assert.equal(json(first.stdout)['taskId'], 'TASK1');

    const source = artifacts({
        'TASK1/': definition('test-linux/opt-mochitest', 'try', 'a1b2c3d4e5f6'),
        [`TASK1/runs/3/artifacts/${PROFILE_PATH}`]: defaultProfile(),
    });
    const explicit = await invoke(['task', 'TASK1.3', '--json'], source);
    assert.equal(explicit.code, ExitCode.Success);
    assert.equal(json(explicit.stdout)['retryId'], 3);
    // Not merely parsed and reported: a command that split `.3` off and then
    // fetched run 0 would satisfy the line above and read the wrong run.
    assert.ok(
        source.requested.includes(`TASK1/runs/3/artifacts/${PROFILE_PATH}`),
        `asked for ${source.requested.join(', ')}`
    );
    assert.match(json(explicit.stdout)['profileUrl'] as string, /\/runs\/3\/artifacts\//);
});

// --- the identity is presentation only ------------------------------------

test('task reads the job name, repository and revision out of the task definition', async () => {
    const { stdout } = await invoke(['task', 'TASK1', '--json'], healthy());
    const result = json(stdout);
    assert.equal(result['jobName'], 'test-linux2404-64/debug-mochitest-browser-chrome-3');
    assert.equal(result['project'], 'autoland');
    // From `metadata.source`'s hg path, which is where a task records it.
    assert.equal(result['revision'], 'a1b2c3d4e5f6');
    assert.match(result['treeherderUrl'] as string, /selectedTaskRun=TASK1\.0/);
});

test('an unreadable task definition costs the header a line and no rows', async () => {
    // Every row comes out of the profile, so failing the whole command over a
    // definition that will not load would refuse to answer a question it can.
    const source = artifacts(
        { [`TASK1/runs/0/artifacts/${PROFILE_PATH}`]: defaultProfile() },
        { 'TASK1/': { status: 500 } }
    );
    const { code, stdout, stderr } = await invoke(['task', 'TASK1', '--json'], source);
    assert.equal(code, ExitCode.Success);
    assert.match(stderr, /could not read the definition/);
    const result = json(stdout);
    assert.equal(result['jobName'], null);
    assert.equal(result['project'], null);
    assert.equal(result['treeherderUrl'], null);
    assert.equal((result['failures'] as unknown[]).length, 2);
});

// --- exit codes -----------------------------------------------------------

test('task exits 4 for a missing profile, 3 for a 5xx, and 1 for a malformed ID', async () => {
    // 404: Taskcluster expired it, or the job never uploaded one. Permanent.
    const gone = await invoke(
        ['task', 'TASK1'],
        artifacts({}, { [`TASK1/runs/0/artifacts/${PROFILE_PATH}`]: 'missing' })
    );
    assert.equal(gone.code, ExitCode.Gone);
    assert.match(gone.stderr, /expires task artifacts/);

    // 5xx: try again.
    const flaky = await invoke(
        ['task', 'TASK1'],
        artifacts({}, { [`TASK1/runs/0/artifacts/${PROFILE_PATH}`]: { status: 503 } })
    );
    assert.equal(flaky.code, ExitCode.Upstream);
    assert.match(flaky.stderr, /transient/);

    // 400 is what the queue answers for a string that is not a task ID at all,
    // so it must be neither of the two above: a retry loop over a typo never
    // terminates, and "permanently gone" is wrong about a task that never was.
    const typo = await invoke(
        ['task', 'NOTATASKID'],
        artifacts({}, { [`NOTATASKID/runs/0/artifacts/${PROFILE_PATH}`]: { status: 400 } })
    );
    assert.equal(typo.code, ExitCode.Usage);
    assert.match(typo.stderr, /not a task ID/);
    assert.doesNotMatch(typo.stderr, /transient|permanently/);
});

test('a streamed profile is reported as a killed job, not as an unreadable one', async () => {
    // A job killed for exceeding maxRunTime uploads newline-delimited JSON.
    // "Could not be read" sends a reader looking for a broken download; the
    // problem is the job's duration.
    const streamed = new TextEncoder().encode('{"type":"meta"}\n{"threads":[]}\n');
    const { code, stderr } = await invoke(
        ['task', 'TASK1'],
        artifacts({ [`TASK1/runs/0/artifacts/${PROFILE_PATH}`]: streamed })
    );
    assert.equal(code, ExitCode.Upstream);
    assert.match(stderr, /killed for exceeding its maximum duration/);
    assert.doesNotMatch(stderr, /not valid JSON/);
});

// --- the narrowing --------------------------------------------------------

test('task ranks on failing executions and reports the executions it saw', async () => {
    const { stdout } = await invoke(['task', 'TASK1', '--json'], healthy());
    const failures = json(stdout)['failures'] as {
        path: string;
        failureCount: number;
        executionCount: number;
        statuses: string[];
        passedOnRerun: boolean;
        parallelOnly: boolean;
    }[];
    assert.deepEqual(
        failures.map((failure) => [failure.path, failure.failureCount]),
        [
            [TEST_A, 3],
            [TEST_B, 1],
        ],
        'ranked on failing executions, as try ranks'
    );
    assert.equal(failures[0]!.executionCount, 3);
    // Only the failing statuses. Adding the PASS of a rescued rerun made every
    // such row read `FAIL, PASS`, which states the outcome twice.
    assert.deepEqual(failures[1]!.statuses, ['FAIL']);
    assert.equal(failures[1]!.passedOnRerun, true, 'b was rescued by the rerun');
    assert.equal(failures[0]!.passedOnRerun, false, 'a failed again in the rerun');
    // `a` failed both inside and outside the parallel range, so the phase does
    // not single it out; `b` failed only inside it.
    assert.equal(failures[0]!.parallelOnly, false);
    assert.equal(failures[1]!.parallelOnly, true);
});

test('the per-test outcome counts do not pretend to partition the tests', async () => {
    const result = json((await invoke(['task', 'TASK1', '--json'], healthy())).stdout);
    assert.equal(result['testCount'], 3);
    assert.equal(result['executionCount'], 6);
    const counts = result['statusCounts'] as Record<string, number>;
    // `browser_b.js` is under both, because it did both — which is why the
    // renderer says "counted per test" rather than presenting a partition.
    assert.equal(counts['FAIL'], 2);
    assert.equal(counts['PASS'], 2);
    assert.ok(
        counts['FAIL']! + counts['PASS']! > (result['testCount'] as number),
        'the fixture must exercise a test that both failed and passed'
    );
});

test('the rerun count is counted from the markers, not subtracted from the executions', async () => {
    // The bug this pins: the header printed `executionCount - testCount` and
    // called it "harness reruns". The two are not the same quantity and are not
    // close. A test listed in two manifests executes twice under one path —
    // `normalizeTestPath` strips the `manifest.toml:` prefix that told them
    // apart — and neither execution is a rerun.
    //
    // The default fixture already separates them: 3 tests, 6 executions, and
    // exactly 2 markers inside the `retry` range. The subtraction says 3.
    const result = json((await invoke(['task', 'TASK1', '--json'], healthy())).stdout);
    assert.equal(result['testCount'], 3);
    assert.equal(result['executionCount'], 6);
    assert.equal(result['rerunCount'], 2);
    assert.notEqual(
        result['rerunCount'],
        (result['executionCount'] as number) - (result['testCount'] as number),
        'the fixture must distinguish the counted reruns from the subtraction'
    );

    const { stdout } = await invoke(['task', 'TASK1'], healthy());
    assert.match(stdout, /6 executions \(2 of them harness reruns\)/);
});

test('a job the harness never reran says so by omitting the clause', async () => {
    // Two executions of one test, both in the parallel phase, neither a rerun —
    // the shape that made the old subtraction claim a rerun where there was
    // none. There is no `retry` range at all here.
    const source = artifacts({
        'TASK1/': definition('test-linux/opt-mochitest', 'try', 'a1b2c3d4e5f6'),
        [`TASK1/runs/0/artifacts/${PROFILE_PATH}`]: profileWith([
            { type: 'Text', text: 'parallel', start: 0, end: 100 },
            { type: 'Test', test: TEST_A, status: 'PASS', start: 10, end: 20 },
            { type: 'Test', test: TEST_A, status: 'PASS', start: 30, end: 40 },
        ]),
    });
    const result = json((await invoke(['task', 'TASK1', '--json'], source)).stdout);
    assert.equal(result['testCount'], 1);
    assert.equal(result['executionCount'], 2);
    assert.equal(result['rerunCount'], 0, 'two parallel-phase markers are not a rerun');

    const { stdout } = await invoke(['task', 'TASK1'], source);
    assert.match(stdout, /1 tests, 2 executions, 0 failing/);
    assert.doesNotMatch(stdout, /harness reruns/);
});

test('the markdown # column is an ordinal, not a repeat of the executions numerator', async () => {
    // `try`'s `#` holds the failing execution count, which works there because
    // it prints no adjacent execution column. Here `Executions` is
    // `failureCount/executionCount` in the next cell, so a `#` holding the
    // numerator would read `1` down every row and say nothing.
    const { stdout } = await invoke(['task', 'TASK1', '--markdown'], healthy());
    const rows = stdout
        .split('\n')
        .filter((line) => line.startsWith('| ') && !line.startsWith('| # ') && !line.startsWith('| ---'));
    assert.equal(rows.length, 2);
    assert.deepEqual(
        rows.map((row) => row.split('|')[1]!.trim()),
        ['1', '2']
    );
});

test('--messages counts each message per execution; the default shows two and says how many more', async () => {
    // Three messages on `browser_a.js`, of which the default shows the two most
    // common — `try`'s rule, and the same reason: two lines of message is what
    // a scannable row affords.
    const source = artifacts({
        'TASK1/': definition('test-linux/opt-mochitest', 'try', 'a1b2c3d4e5f6'),
        [`TASK1/runs/0/artifacts/${PROFILE_PATH}`]: profileWith([
            { type: 'Test', test: TEST_A, status: 'FAIL', start: 10, end: 20 },
            { type: 'TestStatus', test: TEST_A, message: 'first', start: 15, end: 15 },
            { type: 'Test', test: TEST_A, status: 'FAIL', start: 30, end: 40 },
            { type: 'TestStatus', test: TEST_A, message: 'first', start: 35, end: 35 },
            { type: 'Test', test: TEST_A, status: 'FAIL', start: 50, end: 60 },
            { type: 'TestStatus', test: TEST_A, message: 'second', start: 55, end: 55 },
            { type: 'Test', test: TEST_A, status: 'FAIL', start: 70, end: 80 },
            { type: 'TestStatus', test: TEST_A, message: 'third', start: 75, end: 75 },
        ]),
    });
    const brief = await invoke(['task', 'TASK1'], source);
    assert.match(brief.stdout, /first/);
    assert.match(brief.stdout, /second/);
    assert.doesNotMatch(brief.stdout, /third/);
    assert.match(brief.stdout, /\+1 more message for this test; --messages/);

    const full = await invoke(['task', 'TASK1', '--messages'], healthy());
    // Per failing execution, which is why `a failed once` is 2x: it is the
    // message of two of the three executions.
    assert.match(full.stdout, /2x a failed once/);
    assert.match(full.stdout, /1x a failed twice/);
});

test('--passed lists what did not fail, and the default does not', async () => {
    const plain = await invoke(['task', 'TASK1'], healthy());
    assert.doesNotMatch(plain.stdout, /browser_c\.js/);

    const withPassed = await invoke(['task', 'TASK1', '--passed'], healthy());
    assert.match(withPassed.stdout, /DID NOT FAIL \(1\)/);
    assert.match(withPassed.stdout, /browser_c\.js/);
});

test('task says what it cannot say, and names the command that can', async () => {
    const { stdout } = await invoke(['task', 'TASK1'], healthy());
    // The classification `try` does and this deliberately does not: one job
    // cannot say whether a failure is new, so the footer sends the reader to
    // the command that compares against central.
    assert.match(stdout, /fx-tests test <path>/);
    // And it must not have grown `try`'s cross-configuration verdicts.
    assert.doesNotMatch(stdout, /PERMA-FAIL|KNOWN INTERMITTENT|NEW INTERMITTENT/);
});

test('a job with no test-level failure is not reported as a job that passed', async () => {
    // A harness crash, or a failure recorded against a manifest, leaves no
    // test-level row on a job Treeherder shows red. Saying "no failures" alone
    // would send the reader to the next test instead of to the log.
    const source = artifacts({
        'TASK1/': definition('test-linux/opt-mochitest', 'try', 'a1b2c3d4e5f6'),
        [`TASK1/runs/0/artifacts/${PROFILE_PATH}`]: profileWith([
            { type: 'Test', test: TEST_A, status: 'PASS', start: 1, end: 2 },
        ]),
    });
    const { code, stdout } = await invoke(['task', 'TASK1'], source);
    assert.equal(code, ExitCode.Success);
    assert.match(stdout, /No test-level failure in this job/);
    assert.match(stdout, /Read the log/);
});

test('a failure the profile could not attribute to a test is warned about, not dropped', async () => {
    // A crash recorded against a `.toml` manifest has no test path, so it
    // cannot be a row. In a per-push report that is a footnote; in a per-job
    // one it can be most of the answer, so its absence has to be stated.
    const source = artifacts({
        'TASK1/': definition('test-linux/opt-mochitest', 'try', 'a1b2c3d4e5f6'),
        [`TASK1/runs/0/artifacts/${PROFILE_PATH}`]: profileWith([
            { type: 'Test', test: 'browser.toml', status: 'CRASH', start: 1, end: 2 },
            { type: 'Test', test: TEST_A, status: 'PASS', start: 3, end: 4 },
        ]),
    });
    const { code, stdout, stderr } = await invoke(['task', 'TASK1'], source);
    assert.equal(code, ExitCode.Success);
    assert.match(stderr, /1 failing marker in this job named no test path/);
    assert.match(stderr, /CRASH browser\.toml/);
    // And the table still says there is nothing in it, rather than implying the
    // job was clean — the warning and the body have to agree.
    assert.match(stdout, /No test-level failure in this job/);
});

/**
 * The shared row renderer, which `try` and `task` both call.
 *
 * They rendered these lines from two copies for exactly one commit, and the
 * copies had already drifted in two unreachable places. Both now call
 * `cli/format/failure-lines.ts`, so agreement is structural rather than
 * asserted — a comparison test between the two commands would be tautological.
 * What is worth pinning instead is the two branches the drift was in, since
 * being unreachable from either command today is what let them differ.
 */
test('the shared message renderer keeps the branches the two copies had drifted in', () => {
    // Drift 1: a message present in `messages` but absent from `allMessages`
    // must still be listed, at a blank count rather than `0x`. Reachable only
    // for a synthetic crash, whose signature goes in `messages` alone.
    const crashLike = messageLines(
        { messages: ['SIGSEGV @ nsFoo::Bar'], allMessages: [] },
        true
    );
    assert.deepEqual(crashLike, ['         SIGSEGV @ nsFoo::Bar']);
    assert.ok(!crashLike[0]!.includes('0x'), '0x would read as "never seen"');

    // Drift 2: a row with no messages at all renders nothing, rather than an
    // empty bullet.
    assert.deepEqual(messageLines({ messages: [], allMessages: [] }, true), []);
    assert.deepEqual(messageLines({ messages: [], allMessages: [] }, false), []);
});

test('the shared message renderer states the cap when it bites', () => {
    const many = Array.from({ length: MESSAGE_CAP + 3 }, (_, i) => ({
        message: `message ${i}`,
        count: 1,
    }));
    const lines = messageLines({ messages: [], allMessages: many }, true);
    assert.equal(lines.length, MESSAGE_CAP + 1, 'the cap plus the line explaining it');
    assert.match(lines.at(-1)!, new RegExp(`3 more messages, not shown: the cap is ${MESSAGE_CAP}`));
});

test('--profiles says so when no failing test named one, and stays silent by default', async () => {
    // Silence is ambiguous: a reader cannot tell "this job has none" from "the
    // tool did not look". Measured on task `KDqOl_b-QeKPlA6J6BaM_A`, whose
    // Taskcluster artifact listing holds exactly one profile file — the
    // resource-usage one — so the absence is real. Only under `--profiles`,
    // because most xpcshell jobs upload none and a line on every one of them
    // is noise for a reader who never asked.
    const source = artifacts({
        'TASK1/': definition('test-linux/opt-xpcshell', 'try', 'a1b2c3d4e5f6'),
        [`TASK1/runs/0/artifacts/${PROFILE_PATH}`]: profileWith([
            { type: 'Test', test: TEST_A, status: 'FAIL', start: 10, end: 20 },
            { type: 'TestStatus', test: TEST_A, message: 'boom', start: 15, end: 15 },
        ]),
    });

    const asked = await invoke(['task', 'TASK1', '--profiles'], source);
    assert.match(asked.stdout, /No failing test named a per-test profile in this job\./);
    // "per-test" is load-bearing: the resource-usage profile is in the header
    // two lines above and is a different artifact, so the note must not read as
    // denying it.
    assert.match(asked.stdout, /^profile https:\/\/\S+profile_resource-usage\.json$/m);

    // Silent without the flag.
    const plain = await invoke(['task', 'TASK1'], source);
    assert.doesNotMatch(plain.stdout, /named a per-test profile/);
});

test('the no-profiles note is only for a section where every row lacks one', async () => {
    // Some rows naming a profile and others not is ordinary. A note there would
    // contradict the filename printed two lines below it.
    const source = artifacts({
        'TASK1/': definition('test-linux/opt-mochitest', 'try', 'a1b2c3d4e5f6'),
        [`TASK1/runs/0/artifacts/${PROFILE_PATH}`]: profileWith([
            { type: 'Test', test: TEST_A, status: 'FAIL', start: 10, end: 20 },
            {
                type: 'TestStatus',
                test: TEST_A,
                message: 'boom; profile uploaded in profile_browser_a.js.json',
                start: 15,
                end: 15,
            },
            { type: 'Test', test: TEST_B, status: 'FAIL', start: 30, end: 40 },
            { type: 'TestStatus', test: TEST_B, message: 'no profile here', start: 35, end: 35 },
        ]),
    });
    const { stdout } = await invoke(['task', 'TASK1', '--profiles'], source);
    assert.doesNotMatch(stdout, /named a per-test profile/);
    assert.match(stdout, /profile_browser_a\.js\.json/);
});

test('a per-test profile filename is not gated on --messages', async () => {
    // The two flags were demonstrated on different tasks in the artifacts,
    // which made the filename look tied to whichever flag sat beside it. It is
    // a property of the job.
    const source = artifacts({
        'TASK1/': definition('test-linux/opt-mochitest', 'try', 'a1b2c3d4e5f6'),
        [`TASK1/runs/0/artifacts/${PROFILE_PATH}`]: profileWith([
            { type: 'Test', test: TEST_A, status: 'FAIL', start: 10, end: 20 },
            {
                type: 'TestStatus',
                test: TEST_A,
                message: 'boom; profile uploaded in profile_browser_a.js.json',
                start: 15,
                end: 15,
            },
        ]),
    });
    const plain = await invoke(['task', 'TASK1'], source);
    const withMessages = await invoke(['task', 'TASK1', '--messages'], source);
    const count = (text: string): number =>
        text.match(/profile in profile_browser_a\.js\.json/g)?.length ?? 0;
    assert.equal(count(plain.stdout), 1);
    assert.equal(count(withMessages.stdout), 1, '--messages must not change the profile lines');
});

test('a per-test profile is named by filename in the default output, not by URL', async () => {
    // The header already prints the resource-usage URL in full, and every
    // per-test profile sits beside it, so the two differ only in the last path
    // segment. A per-row URL would spend ~130 characters conveying a filename.
    const source = artifacts({
        'TASK1/': definition('test-linux/opt-mochitest', 'try', 'a1b2c3d4e5f6'),
        [`TASK1/runs/0/artifacts/${PROFILE_PATH}`]: profileWith([
            { type: 'Test', test: TEST_A, status: 'FAIL', start: 10, end: 20 },
            {
                type: 'TestStatus',
                test: TEST_A,
                message: 'boom; profile uploaded in profile_browser_a.js.json',
                start: 15,
                end: 15,
            },
        ]),
    });

    const plain = await invoke(['task', 'TASK1'], source);
    assert.match(plain.stdout, /profile in profile_browser_a\.js\.json/);
    assert.doesNotMatch(
        plain.stdout.split('FAILED')[1]!,
        /https:\/\//,
        'no row should carry a full URL by default'
    );

    // `--profiles` is what expands them, for a script piping to curl.
    const full = await invoke(['task', 'TASK1', '--profiles'], source);
    assert.match(
        full.stdout,
        /profile https:\/\/[^\s]+\/test_info\/profile_browser_a\.js\.json/
    );

    // `--json` always carries the absolute URL: a machine consumer must not
    // have to join a base and a filename back together.
    const asJson = json((await invoke(['task', 'TASK1', '--json'], source)).stdout);
    const failures = asJson['failures'] as { testProfiles: string[] }[];
    assert.deepEqual(failures[0]!.testProfiles, [
        'https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/TASK1/runs/0/' +
            'artifacts/public/test_info/profile_browser_a.js.json',
    ]);
});

test('an annotation every failing row shares is stated once, not per row', async () => {
    // On a real job all five failing rows carried both annotations, which put
    // ten identical lines in a five-row table. An annotation true of every row
    // distinguishes no row, so it belongs to the job.
    // Both failing tests rescued by the rerun, which the default fixture does
    // not do — there `browser_a.js` fails again in the retry phase.
    const source = artifacts({
        'TASK1/': definition('test-linux/opt-mochitest', 'try', 'a1b2c3d4e5f6'),
        [`TASK1/runs/0/artifacts/${PROFILE_PATH}`]: profileWith([
            { type: 'Text', text: 'retry', start: 200, end: 300 },
            { type: 'Test', test: TEST_A, status: 'FAIL', start: 10, end: 20 },
            { type: 'Test', test: TEST_A, status: 'PASS', start: 210, end: 220 },
            { type: 'Test', test: TEST_B, status: 'FAIL', start: 30, end: 40 },
            { type: 'Test', test: TEST_B, status: 'PASS', start: 230, end: 240 },
        ]),
    });
    const { stdout } = await invoke(['task', 'TASK1'], source);
    assert.match(stdout, /All 2 passed when the harness reran them\./);
    // Stated above the rows, and not repeated inside them.
    const body = stdout.split('FAILED')[1]!;
    assert.equal(
        body.match(/passed when the harness reran/gi)?.length,
        1,
        'the shared annotation must appear exactly once'
    );
    // And the editorialising is gone: the line states the fact and stops.
    assert.doesNotMatch(stdout, /intermittent, at least here|racing with its neighbours/);
});

test('an annotation only some rows share stays on the rows that have it', async () => {
    // Two failing tests, only one rescued by the rerun. Hoisting here would
    // attribute the rescue to a test that never got one.
    const source = artifacts({
        'TASK1/': definition('test-linux/opt-mochitest', 'try', 'a1b2c3d4e5f6'),
        [`TASK1/runs/0/artifacts/${PROFILE_PATH}`]: profileWith([
            { type: 'Text', text: 'retry', start: 200, end: 300 },
            { type: 'Test', test: TEST_A, status: 'FAIL', start: 10, end: 20 },
            { type: 'Test', test: TEST_A, status: 'PASS', start: 210, end: 220 },
            { type: 'Test', test: TEST_B, status: 'FAIL', start: 30, end: 40 },
        ]),
    });
    const { stdout } = await invoke(['task', 'TASK1'], source);
    assert.doesNotMatch(stdout, /All \d+ passed when the harness reran/);
    assert.equal(stdout.match(/Passed when the harness reran it\./g)?.length, 1);
});

test('a single failing row keeps its annotation rather than hoisting it', async () => {
    // With one row, "every row" and "this row" say the same thing, and hoisting
    // only moves the line away from the test it describes.
    const source = artifacts({
        'TASK1/': definition('test-linux/opt-mochitest', 'try', 'a1b2c3d4e5f6'),
        [`TASK1/runs/0/artifacts/${PROFILE_PATH}`]: profileWith([
            { type: 'Text', text: 'retry', start: 200, end: 300 },
            { type: 'Test', test: TEST_A, status: 'FAIL', start: 10, end: 20 },
            { type: 'Test', test: TEST_A, status: 'PASS', start: 210, end: 220 },
        ]),
    });
    const { stdout } = await invoke(['task', 'TASK1'], source);
    assert.match(stdout, /^ {4}Passed when the harness reran it\.$/m);
    assert.doesNotMatch(stdout, /All \d+ passed/);
});

test('task --help does not list the two flags the command refuses', async () => {
    // `--config` and `--exclude-config` are meaningless on a single job, and a
    // help text promising a flag that exits 1 is worse than omitting it. They
    // are filtered because the refusal is declared in `rejectsGlobals`; a
    // refusal thrown from the command body is not filtered, which is what this
    // command used to do.
    const { code, stdout } = await invoke(['task', '--help'], healthy());
    assert.equal(code, ExitCode.Success);
    assert.doesNotMatch(stdout, /^ {2}--config /m);
    assert.doesNotMatch(stdout, /^ {2}--exclude-config /m);
    // And --task-ids is gone entirely: it printed the argument the caller typed.
    assert.doesNotMatch(stdout, /--task-ids/);
    assert.match(stdout, /What happened in one job/);
});

test('--config is refused rather than ignored: a task is one configuration', async () => {
    const { code, stderr } = await invoke(
        ['task', 'TASK1', '--config', 'linux'],
        healthy()
    );
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /a task is one configuration/);
});

test('task exits 0 with failures found, as try does', async () => {
    const { code } = await invoke(['task', 'TASK1'], healthy());
    assert.equal(code, ExitCode.Success);
});
