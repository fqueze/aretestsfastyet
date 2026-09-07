/**
 * `fx-tests intermittent`, against a recorded Treeherder response.
 *
 * The fixture (`test/intermittents-fixture-gen.ts` records it) is the head of a
 * real `trunk` ranking plus real `/failuresbybug/` rows, so the suite strings
 * these tests classify are Treeherder's own: `mochitest-browser-chrome-msix-11`,
 * `xpcshell-nofis`, `web-platform-tests-webgpu-11`,
 * `snap-upstream-build-arm64-local`, `perftest-android-hw-p6-…`,
 * `test-update-integrity-fr-macosx64-shippable`. A hand-written fixture would
 * have agreed with whatever the classifier happened to do; these do not.
 *
 * ## What is asserted, and why each one
 *
 * The command's whole risk is **an answer that looks complete**, which is what
 * the CLI's work list is about, so the assertions concentrate there:
 *
 * - the scan's depth is reported, and the reported depth is the number of
 *   requests actually made;
 * - `--json` carries every matched row, never a prefix of its own count;
 * - the `{"bug_id": null}` group is counted and named rather than dropped, and
 *   is never scanned (there is no request that could classify it);
 * - the harness filter matches on the suite and nothing else, so a bug whose
 *   annotations are reftest or snap-build does not appear under `--harness
 *   mochitest` however large its tree-wide count is;
 * - every tally is per annotated job. A job emits the `TEST-UNEXPECTED-FAIL`
 *   marker once per failing assertion, and counting lines reported a test path
 *   seventeen times more often than the population it came from.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { QUERY_TTL_MS, cachedIntermittents, diskCache } from '../cli/cache.ts';
import { captureStreams } from '../cli/context.ts';
import type { DataFileName, DataSource } from '../lib/sources/source.ts';
import { ExitCode } from '../cli/errors.ts';
import { DEFAULT_DAYS, resolveRange } from '../cli/commands/intermittent.ts';
import { run } from '../cli/main.ts';
import {
    type BugFailureCount,
    type BugOccurrence,
    type IntermittentsClient,
    IntermittentsError,
    UNKNOWN_TASK_ID,
    intermittentsClient,
    summaryRemainder,
    testPathCandidates,
    testPathOfLine,
} from '../lib/sources/intermittents.ts';
import {
    type ScanHarness,
    bugsNamingTest,
    failureLineDetail,
    occurrenceProfiles,
    scanBugs,
    selectHarness,
    stripLogTimestamp,
    summariseBug,
    tallyTests,
} from '../lib/query/intermittents.ts';

const FIXTURE = new URL('./fixtures/intermittents-trunk-2026-08-10.json', import.meta.url);

interface Fixture {
    tree: string;
    startday: string;
    endday: string;
    failures: { bug_id: number | null; bug_count: number }[];
    summaries: Record<string, string>;
    knownTestPaths: { mochitest: string[]; xpcshell: string[] };
    failuresbybug: Record<
        string,
        {
            bug_id: number | null;
            test_suite: string;
            platform: string;
            build_type: string;
            revision: string;
            tree: string;
            push_time: string;
            machine_name: string;
            task_id: string;
            job_id: number;
            lines: string[];
        }[]
    >;
    /** Each recorded `job_id`'s Taskcluster run index, from `/api/jobs/`. */
    runIds: Record<string, number>;
}

const fixture: Fixture = JSON.parse(await readFile(FIXTURE, 'utf8')) as Fixture;

/** The fixture served through a client, counting the requests it answers. */
function fixtureClient(): IntermittentsClient & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        async rankBugs(tree, range): Promise<BugFailureCount[]> {
            calls.push(`failures:${tree}:${range.start}:${range.end}`);
            return fixture.failures.map((row) => ({ bugId: row.bug_id, count: row.bug_count }));
        },
        async occurrencesOfBug(tree, range, bug): Promise<BugOccurrence[]> {
            calls.push(`failuresbybug:${bug}:${tree}:${range.start}:${range.end}`);
            return (fixture.failuresbybug[String(bug)] ?? []).map((row) => ({
                bugId: row.bug_id,
                testSuite: row.test_suite,
                platform: row.platform,
                buildType: row.build_type,
                revision: row.revision,
                tree: row.tree,
                pushTime: row.push_time,
                machineName: row.machine_name,
                taskId: row.task_id,
                jobId: row.job_id,
                runId: null,
                lines: row.lines,
            }));
        },
        async runIdsOfJobs(jobIds): Promise<Map<number, number>> {
            calls.push(`runids:${jobIds.length}`);
            // The **recorded** run indexes, so what a test asserts about
            // `<taskId>.<runId>` is Treeherder's answer rather than this file's.
            return new Map(
                jobIds.flatMap((jobId) => {
                    const runId = fixture.runIds[String(jobId)];
                    return runId === undefined ? [] : [[jobId, runId] as [number, number]];
                })
            );
        },
        async bugSummaries(bugs): Promise<Map<number, string>> {
            calls.push(`bugzilla:${[...bugs].join(',')}`);
            // The **recorded** summaries: classification reads them, so a
            // synthesised one would make every test here about a string this
            // file invented rather than about what Bugzilla says.
            return new Map(
                bugs.flatMap((bug) => {
                    const summary = fixture.summaries[String(bug)];
                    return summary === undefined ? [] : [[bug, summary] as [number, string]];
                })
            );
        },
    };
}

/**
 * The width these tests render at.
 *
 * Pinned, and wide: truncation follows `COLUMNS`, so without this every
 * assertion about a message's text would depend on the terminal the suite runs
 * in — and would pass locally while failing in CI, where stdout is a pipe. Wide
 * enough that content assertions are about the content. The tests that are
 * *about* width set their own.
 */
const TEST_COLUMNS = '200';

async function invoke(
    argv: string[],
    client?: IntermittentsClient,
    source?: DataSource & { requested: string[] },
    columns: string = TEST_COLUMNS
): Promise<{ code: number; stdout: string; stderr: string; calls: string[] }> {
    const streams = captureStreams();
    const previousColumns = process.env['COLUMNS'];
    process.env['COLUMNS'] = columns;
    try {
        return await invokeAt(argv, client, source, streams);
    } finally {
        if (previousColumns === undefined) {
            delete process.env['COLUMNS'];
        } else {
            process.env['COLUMNS'] = previousColumns;
        }
    }
}

async function invokeAt(
    argv: string[],
    client: IntermittentsClient | undefined,
    source: (DataSource & { requested: string[] }) | undefined,
    streams: ReturnType<typeof captureStreams>
): Promise<{ code: number; stdout: string; stderr: string; calls: string[] }> {
    const intermittents = client ?? fixtureClient();
    const code = await run({
        argv,
        streams,
        source: source ?? issuesSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        intermittents,
    });
    return {
        code,
        stdout: streams.stdout,
        stderr: streams.stderr,
        calls: (intermittents as { calls?: string[] }).calls ?? [],
    };
}

/**
 * A source serving just enough `{harness}-issues.json` to classify.
 *
 * The real files are 6 MB and 3 MB; only `tables` and `testInfo` are read, and
 * only the paths the recorded summaries name are needed, so the fixture carries
 * those and this rebuilds the shape `collectTestPaths` consumes. The command
 * therefore exercises its real loader — including that it asks for exactly two
 * files however deep the scan goes.
 */
function issuesSource(): DataSource & { requested: string[] } {
    const requested: string[] = [];
    return {
        name: 'fixture-issues',
        requested,
        fetch(name: DataFileName): Promise<Uint8Array> {
            requested.push(name.filename);
            const harness = name.filename.startsWith('mochitest') ? 'mochitest' : 'xpcshell';
            const paths = fixture.knownTestPaths[harness as 'mochitest' | 'xpcshell'];
            const dirs: string[] = [];
            const names: string[] = [];
            const testPathIds: number[] = [];
            const testNameIds: number[] = [];
            for (const full of paths) {
                const cut = full.lastIndexOf('/');
                const dir = cut === -1 ? '' : full.slice(0, cut);
                const base = cut === -1 ? full : full.slice(cut + 1);
                if (!dirs.includes(dir)) {
                    dirs.push(dir);
                }
                names.push(base);
                testPathIds.push(dirs.indexOf(dir));
                testNameIds.push(names.length - 1);
            }
            const file = {
                metadata: { generatedAt: '2026-08-17T00:00:00Z' },
                tables: { testPaths: dirs, testNames: names },
                testInfo: { testPathIds, testNameIds },
            };
            return Promise.resolve(new TextEncoder().encode(JSON.stringify(file)));
        },
    };
}

/** Which harness a fixture path belongs to, as the command's loader decides. */
function fixtureHarnessOfPath(path: string): ScanHarness | null {
    if (fixture.knownTestPaths.mochitest.includes(path)) {
        return 'mochitest';
    }
    return fixture.knownTestPaths.xpcshell.includes(path) ? 'xpcshell' : null;
}

/** One recorded row as the client would hand it to a command. */
function toOccurrence(row: Fixture['failuresbybug'][string][number]): BugOccurrence {
    return {
        bugId: row.bug_id,
        testSuite: row.test_suite,
        platform: row.platform,
        buildType: row.build_type,
        revision: row.revision,
        tree: row.tree,
        pushTime: row.push_time,
        machineName: row.machine_name,
        taskId: row.task_id,
        jobId: row.job_id,
        runId: null,
        lines: row.lines,
    };
}

/**
 * One recorded row with its run index filled in, as the command has it.
 *
 * `toOccurrence` leaves `runId` null because that is what the client returns;
 * `withRunIds` resolves it before anything builds a URL. A test about URLs has
 * to model the resolved state, and doing it through the recorded `runIds` map
 * keeps it Treeherder's answer rather than a constant.
 */
function toResolvedOccurrence(
    row: Fixture['failuresbybug'][string][number]
): BugOccurrence {
    const runId = fixture.runIds[String(row.job_id)];
    return { ...toOccurrence(row), runId: runId ?? null };
}

/** The fixture's window, so a test is not affected by today's date. */
const WINDOW = ['--day', fixture.startday];

/** Runs `body` against a fresh cache directory, and removes it afterwards. */
async function withCacheDir(body: (directory: string) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'fx-tests-intermittent-'));
    try {
        await body(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// --- classification: a verified test path, not a job name ----------------

test('a bug is a mochitest bug when its summary names a mochitest test', () => {
    // The whole mechanism, on the recorded summaries. Bug 2021221 is the case
    // that matters: its jobs are named `opt-mochitest-chrome-1proc-4` because
    // Treeherder computes `test_suite` by subtracting the platform and build
    // type from the job name, so nothing about the *job* identifies it. Its
    // summary names `toolkit/content/tests/chrome/test_findbar.xhtml`, which is
    // a mochitest, and that is what decides it.
    const summary = fixture.summaries['2021221']!;
    const paths = testPathCandidates(summary);
    assert.deepEqual(paths, ['toolkit/content/tests/chrome/test_findbar.xhtml']);
    assert.equal(fixtureHarnessOfPath(paths[0]!), 'mochitest');
});

test('a path in the summary that is not a test does not classify the bug', () => {
    // Extraction alone is not enough, and these are why. Bug 1946935's summary
    // names the xpcshell *harness script* it ran, and 2051017's names a wpt
    // test — both are `dir/.../file.ext` and neither is a test this tool holds.
    // Checking against the published lists is what rejects them.
    for (const [bug, expected] of [
        [1946935, 'builds/worker/workspace/build/tests/xpcshell/runxpcshelltests.py'],
        [2051017, 'pointerevents/pointerlock/pointerevent_coordinates_when_locked.html'],
    ] as const) {
        const paths = testPathCandidates(fixture.summaries[String(bug)]!);
        assert.ok(
            paths.some((path) => path.endsWith(expected.split('/').pop()!)),
            `bug ${bug}: expected a path-shaped token ending ${expected}`
        );
        for (const path of paths) {
            assert.equal(
                fixtureHarnessOfPath(path),
                null,
                `bug ${bug}: ${path} must not verify as a test`
            );
        }
    }
});

test('a summary with no path at all yields nothing to classify', () => {
    // The generic-bug case. 1809667 is `[meta] Intermittent [taskcluster:error]
    // Task aborted`, which fires across every job in the tree; 2055846 is a snap
    // build failure. Neither is a test failure and neither may be ranked as one.
    for (const bug of [1809667, 2055846]) {
        assert.deepEqual(
            testPathCandidates(fixture.summaries[String(bug)]!),
            [],
            `bug ${bug} names no test and must yield no candidate`
        );
    }
});

test('a source location in a summary is not mistaken for a test path', () => {
    // The shape that makes extraction non-trivial: a crash summary carries
    // `gfx/wr/webrender/src/renderer/mod.rs`, and a webgpu one carries
    // `/_mozilla/webgpu/cts/...`. Neither has a test extension.
    assert.deepEqual(
        testPathCandidates(
            'Intermittent Hit MOZ_CRASH(assertion failed) at gfx/wr/webrender/src/renderer/mod.rs:1'
        ),
        []
    );
    assert.deepEqual(
        testPathCandidates(fixture.summaries['1913777']!),
        [],
        'the webgpu path fragment is not a file'
    );
});

test('classification places each recorded summary the way the test lists say', () => {
    // The property over the whole fixture rather than a list someone remembered
    // to extend: for every recorded summary, the harness is whatever the
    // published lists say about the first path that verifies, and nothing else.
    let verified = 0;
    let rejected = 0;
    for (const [bug, summary] of Object.entries(fixture.summaries)) {
        const first = testPathCandidates(summary)
            .map((path) => ({ path, harness: fixtureHarnessOfPath(path) }))
            .find((entry) => entry.harness !== null);
        if (first === undefined) {
            rejected++;
            continue;
        }
        verified++;
        assert.ok(
            fixture.knownTestPaths[first.harness as 'mochitest' | 'xpcshell'].includes(first.path),
            `bug ${bug}: ${first.path} classified ${first.harness} but is not in that list`
        );
    }
    // Both sides must be non-empty, or the fixture cannot pin the mechanism.
    assert.ok(verified >= 3, `only ${verified} summaries verified`);
    assert.ok(rejected >= 3, `only ${rejected} summaries were rejected`);
});

test('every bug is classified, and the harness is an attribute of the row', () => {
    // The model: `scanBugs` places every annotated bug, and `selectHarness`
    // picks from that. With the filter inside the scan, a row had to be one
    // harness or the other to exist at all, and there was no way to see the
    // whole ranking.
    const scan = scanBugs({
        ranking: RANKING(),
        summaries: SUMMARIES(),
        harnessOfPath: fixtureHarnessOfPath,
    });
    const classifiable = fixture.failures.filter((row) => row.bug_id !== null).length;
    assert.equal(scan.rows.length, classifiable, 'every bug with a number gets a row');
    assert.equal(
        scan.coverage.mochitest + scan.coverage.xpcshell + scan.coverage.unknown,
        scan.coverage.scanned,
        'the three groups partition the scanned bugs'
    );

    const byId = new Map(scan.rows.map((row) => [row.bugId, row]));
    // Placed by the test its summary names.
    assert.equal(byId.get(1980036)?.harness, 'mochitest');
    assert.equal(byId.get(2021221)?.harness, 'mochitest', 'the ASAN bug is placed by its path');
    assert.equal(byId.get(2063359)?.harness, 'xpcshell');
    // Named no test this tool holds — each for its own reason.
    assert.equal(byId.get(1809667)?.harness, 'unknown', 'the [taskcluster:error] meta bug');
    assert.equal(byId.get(1946935)?.harness, 'unknown', 'the xpcshell harness script');
    assert.equal(byId.get(2051017)?.harness, 'unknown', 'a wpt test');
    // An unknown row carries no path, and its text is the summary.
    const meta = byId.get(1809667)!;
    assert.equal(meta.test, null);
    assert.match(meta.failure, /taskcluster:error/);
    assert.ok(!meta.failure.startsWith('[meta]'), 'the triage prefix is stripped');
    // A classified row carries the path it was placed by.
    assert.equal(byId.get(2021221)?.test, 'toolkit/content/tests/chrome/test_findbar.xhtml');
});

test('selecting a harness picks from the same rows, and selecting none takes all', () => {
    const scan = scanBugs({
        ranking: RANKING(),
        summaries: SUMMARIES(),
        harnessOfPath: fixtureHarnessOfPath,
    });
    const all = selectHarness(scan.rows, undefined);
    const mochitest = selectHarness(scan.rows, 'mochitest');
    const xpcshell = selectHarness(scan.rows, 'xpcshell');
    const unknown = selectHarness(scan.rows, 'unknown');

    assert.equal(all.length, scan.rows.length);
    assert.equal(mochitest.length, scan.coverage.mochitest);
    assert.equal(xpcshell.length, scan.coverage.xpcshell);
    assert.equal(unknown.length, scan.coverage.unknown);
    // The three selections partition the whole, so nothing is lost or double
    // counted between them.
    assert.equal(mochitest.length + xpcshell.length + unknown.length, all.length);
    assert.ok(mochitest.every((row) => row.harness === 'mochitest'));
    assert.ok(unknown.every((row) => row.test === null));
    // And every selection stays count-descending.
    for (const rows of [all, mochitest, unknown]) {
        const counts = rows.map((row) => row.count);
        assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
    }
});

test('the unfiltered list interleaves unknown bugs with classified ones by count', async () => {
    // The gap this closes: there was no way to see the whole ranking, because
    // omitting --harness silently meant mochitest.
    const { stdout } = await invoke(['intermittent', ...WINDOW, '--limit', '0']);
    const classifiable = fixture.failures.filter((row) => row.bug_id !== null).length;
    assert.match(stdout, new RegExp(`All ${classifiable} annotated bugs, ranked by count`));
    // Both kinds are present, and the biggest bug in the fixture is an unknown
    // one — so a list that ranked only classified bugs would not lead with it.
    const rows = stdout
        .split('\n')
        .filter((line) => /^\s+\d[\d,]*\s+\d{6,}\s/.test(line));
    assert.equal(rows.length, classifiable, 'every bug appears, whatever its classification');
    // Both kinds are in one list, ordered by count rather than grouped.
    assert.ok(rows.some((line) => line.includes('browser_tab_preview.js')), 'a classified row');
    assert.ok(rows.some((line) => line.includes('1913777')), 'an unknown row');
    const counts = rows.map((line) => Number(/^\s+([\d,]+)/.exec(line)![1]!.replace(/,/g, '')));
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a), 'one ranking, not two lists');
    // Interleaved, not classified-then-unknown: an unknown row outranks a
    // classified one somewhere in the list.
    const firstUnknown = rows.findIndex((line) => line.includes('(no test named)'));
    const lastClassified = rows.map((line) => !line.includes('(no test named)')).lastIndexOf(true);
    assert.ok(firstUnknown < lastClassified, 'the two kinds must interleave');
    // An unknown row is marked rather than showing a blank cell.
    assert.match(stdout, /\(no test named\)/);
});

test('--harness unknown ranks only the bugs naming no known test', async () => {
    const { code, stdout } = await invoke([
        'intermittent', '--harness', 'unknown', ...WINDOW, '--limit', '0',
    ]);
    assert.equal(code, ExitCode.Success);
    assert.match(stdout, /naming no known test/);
    assert.match(stdout, /1913777/);
    // No classified bug, and no path anywhere in the table.
    assert.doesNotMatch(stdout, /browser_tab_preview\.js/);
    assert.doesNotMatch(stdout, /test_findbar\.xhtml/);
    // Every row is unknown, so the marker is dropped and there is no empty
    // `failure` column to head.
    assert.doesNotMatch(stdout, /\(no test named\)/);
    assert.doesNotMatch(stdout, /^\s+count.*failure/m);
    assert.match(stdout, /^\s+count ▼\s+bug\s+summary$/m);
});

test('--harness takes exactly three values, and says so when it does not', async () => {
    for (const value of ['mochitest', 'xpcshell', 'unknown']) {
        const { code } = await invoke(['intermittent', '--harness', value, ...WINDOW, '--limit', '1']);
        assert.equal(code, ExitCode.Success, `--harness ${value} should work`);
    }
    const { code, stderr } = await invoke(['intermittent', '--harness', 'reftest', ...WINDOW]);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /xpcshell, mochitest or unknown/);
    // `--unclassified` is gone: one axis, one flag.
    const dropped = await invoke(['intermittent', '--unclassified', ...WINDOW]);
    assert.equal(dropped.code, ExitCode.Usage);
    assert.match(dropped.stderr, /unknown option --unclassified/);
});

test('the header states composition when unfiltered and a denominator when filtered', async () => {
    const all = await invoke(['intermittent', ...WINDOW, '--limit', '1']);
    // Unfiltered: what the list in front of you is made of.
    assert.match(all.stdout, /name a mochitest test, \d+ an xpcshell test, and \d+ name no test/);

    const mochitest = await invoke(['intermittent', '--harness', 'mochitest', ...WINDOW, '--limit', '1']);
    // Filtered: what was selected, out of what, and where the rest went.
    assert.match(mochitest.stdout, /\d+ of \d+ annotated bugs name a verified mochitest test/);
    assert.match(mochitest.stdout, /--harness unknown ranks those/);

    const unknown = await invoke(['intermittent', '--harness', 'unknown', ...WINDOW, '--limit', '1']);
    assert.match(unknown.stdout, /\d+ of \d+ annotated bugs name no test this tool knows/);

    // The counts are the same numbers in all three framings.
    const scanned = /of (\d+) annotated bugs/.exec(mochitest.stdout)![1];
    assert.match(all.stdout, new RegExp(`All ${scanned} annotated bugs`));
});

test('the summary remainder drops the triage prefix and the path', () => {
    // What makes the `failure` column worth its width: the prefix and the path
    // are already columns of their own.
    assert.equal(
        summaryRemainder(
            'Frequent browser/a/test_b.js | single tracking bug',
            'browser/a/test_b.js'
        ),
        'single tracking bug'
    );
    assert.equal(
        summaryRemainder('Perma [tier 2] browser/a/test_b.js', 'browser/a/test_b.js'),
        ''
    );
    // The real one, whose remainder is the discriminator between two bugs on
    // the same test.
    assert.match(
        summaryRemainder(
            fixture.summaries['2021221']!,
            'toolkit/content/tests/chrome/test_findbar.xhtml'
        ),
        /^Currently highlighted match should be at 2 for/
    );
});

test('classification reads exactly two published files', async () => {
    // The cost property the whole design rests on: classifying the entire
    // ranking reads the aggregates once rather than asking per bug, which is
    // what lets the default be the whole ranking.
    for (const harness of ['mochitest', 'xpcshell']) {
        const source = issuesSource();
        await invoke(['intermittent', '--harness', harness, ...WINDOW], undefined, source);
        assert.deepEqual(
            source.requested.sort(),
            ['mochitest-issues.json', 'xpcshell-issues.json'],
            `--harness ${harness} must read both lists, once each`
        );
    }
});

test('no per-bug request is made for the ranked list', async () => {
    // `/failuresbybug/` is the drill-down's endpoint. The ranking must not touch
    // it at all, or the cost scales with `--scan` again.
    const { calls } = await invoke(['intermittent', ...WINDOW, '--limit', '0']);
    assert.equal(
        calls.filter((call) => call.startsWith('failuresbybug:')).length,
        0,
        'the ranked list must make no per-bug request'
    );
    assert.equal(calls.filter((call) => call.startsWith('bugzilla:')).length, 1);
});

test('a test path is read out of a TEST-UNEXPECTED-FAIL line', () => {
    const line = fixture.failuresbybug['1980036']!.flatMap((row) => row.lines).find((candidate) =>
        candidate.includes('TEST-UNEXPECTED-FAIL')
    );
    assert.ok(line !== undefined, 'the fixture should carry a TEST-UNEXPECTED-FAIL line');
    const path = testPathOfLine(line);
    assert.ok(path !== null && path.endsWith('.js'), `expected a test path, got ${String(path)}`);
    assert.ok(!path.includes('|'), 'the path must not carry the neighbouring fields');
    assert.ok(!/^\d{2}:\d{2}/.test(path), 'the path must not carry the log timestamp');
});

test('a line with no path field yields no path rather than a fragment', () => {
    // Real shapes: a build-task failure and a harness-level one carry the
    // marker with nothing after it. Returning `''` here would put a blank row
    // at the top of a test ranking.
    assert.equal(testPathOfLine('12:00:00     INFO - TEST-UNEXPECTED-FAIL'), null);
    assert.equal(testPathOfLine('12:00:00     INFO - TEST-UNEXPECTED-FAIL |  | msg'), null);
    assert.equal(testPathOfLine('[taskcluster:error] exit status 1'), null);
});

// --- the scan ------------------------------------------------------------

const RANKING = () => fixture.failures.map((row) => ({ bugId: row.bug_id, count: row.bug_count }));
const SUMMARIES = () =>
    new Map(Object.entries(fixture.summaries).map(([bug, text]) => [Number(bug), text]));

test('the no-bug group is counted and never classified', () => {
    // `/failures/` returns `{"bug_id": null, "bug_count": N}` for annotations a
    // sheriff made without a bug — the largest single group in the recorded
    // ranking. There is no summary to read, so it cannot be classified, and
    // dropping it silently would make every total below it wrong.
    const noBug = fixture.failures.find((row) => row.bug_id === null);
    assert.ok(noBug !== undefined, 'the fixture should carry the no-bug group');
    const result = scanBugs({
        ranking: RANKING(),
        summaries: SUMMARIES(),
        harnessOfPath: fixtureHarnessOfPath,
    });
    assert.equal(result.coverage.noBugCount, noBug.bug_count);
    // It gets no row at all — there is no bug number to rank or classify.
    assert.ok(result.rows.every((row) => Number.isInteger(row.bugId)));
    assert.equal(result.rows.length, fixture.failures.length - 1);
});

test('the no-bug group is named in the output', async () => {
    const { stdout } = await invoke(['intermittent', '--harness', 'mochitest', ...WINDOW]);
    assert.match(stdout, /annotations with no bug attached/);
});

test('the display limit does not bound the scan', async () => {
    // Tying the two together is how a `--json` answer becomes a prefix with no
    // fuller version to ask for.
    const one = await invoke([
        'intermittent', '--harness', 'mochitest', ...WINDOW, '--limit', '1', '--json',
    ]);
    const all = await invoke([
        'intermittent', '--harness', 'mochitest', ...WINDOW, '--limit', '0', '--json',
    ]);
    const parse = (text: string) => JSON.parse(text) as { coverage: { scanned: number }; rows: unknown[] };
    assert.equal(parse(one.stdout).coverage.scanned, parse(all.stdout).coverage.scanned);
    assert.deepEqual(
        parse(one.stdout).rows,
        parse(all.stdout).rows,
        '--json rows must not depend on --limit at all'
    );
});

test('rows are ranked on the count, descending', () => {
    const result = scanBugs({
        ranking: RANKING(),
        summaries: SUMMARIES(),
        harnessOfPath: fixtureHarnessOfPath,
    });
    const counts = result.rows.map((row) => row.count);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
    // And the count is Treeherder's own, not a recomputed share of it.
    for (const row of result.rows) {
        const ranked = fixture.failures.find((entry) => entry.bug_id === row.bugId);
        assert.equal(row.count, ranked?.bug_count);
    }
});

test('every annotated bug in the window is classified, with no --scan to lower it', async () => {
    // The ranking used to stop at a depth because classification cost one
    // request per bug. It does not any more — summaries arrive in batches of a
    // hundred and the test lists are two files — so a partial ranking would be a
    // silent subset for no saving, and there is no flag that produces one.
    const { code, stdout, calls } = await invoke(['intermittent', ...WINDOW, '--limit', '2']);
    assert.equal(code, ExitCode.Success);
    const classifiable = fixture.failures.filter((row) => row.bug_id !== null).length;
    assert.match(stdout, new RegExp(`All ${classifiable} annotated bugs, ranked by count`));
    assert.doesNotMatch(stdout, /--scan/);
    assert.doesNotMatch(stdout, /not looked at/i);
    // And the cost is flat: one ranking request, one batch of summaries.
    assert.equal(calls.filter((call) => call.startsWith('failures:')).length, 1);
    assert.equal(calls.filter((call) => call.startsWith('bugzilla:')).length, 1);
    assert.equal(calls.filter((call) => call.startsWith('failuresbybug:')).length, 0);
});

test('--scan is not an option, so a stale invocation fails loudly', async () => {
    // Rather than being accepted and ignored, which is how a caller keeps
    // believing in a limit that no longer exists.
    const { code, stderr } = await invoke(['intermittent', ...WINDOW, '--scan', '10']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /unknown option --scan/);
});

test('--json emits every matched row and says so, never a prefix of its own count', async () => {
    // The defect items 5 and 12 of the work list are about: a machine-readable
    // array shorter than the count field beside it.
    const { stdout } = await invoke([
        'intermittent', '--harness', 'mochitest', ...WINDOW, '--limit', '1', '--json',
    ]);
    const parsed = JSON.parse(stdout) as {
        harness: string | null;
        matchCount: number;
        rows: unknown[];
        coverage: { scanned: number; mochitest: number; xpcshell: number; unknown: number };
    };
    assert.equal(parsed.rows.length, parsed.matchCount);
    assert.equal(parsed.rows.length, parsed.coverage.mochitest);
    assert.equal(parsed.harness, 'mochitest');
    assert.ok(parsed.matchCount > 1, '--limit 1 must not have shortened the JSON array');
    // The coverage says how the whole window split, so a consumer reading only
    // the mochitest rows can still see the unknown bugs exist.
    assert.ok(parsed.coverage.unknown > 0);
    assert.equal(
        parsed.coverage.mochitest + parsed.coverage.xpcshell + parsed.coverage.unknown,
        parsed.coverage.scanned
    );
});

test('--limit N bounds the printed list at N, and the marker counts the real remainder', async () => {
    // A cap that only works at 0 is the defect this pins: `--limit 1` must print
    // one row and `--limit 2` two, with the `… N more` line naming what is left
    // of the *matched* set rather than of some default.
    const total = (
        JSON.parse(
            (
                await invoke([
                    'intermittent', '--harness', 'mochitest', ...WINDOW, '--json',
                ])
            ).stdout
        ) as { matchCount: number }
    ).matchCount;
    assert.ok(total >= 3, `the fixture must match at least 3 bugs, matched ${total}`);

    /** The ranked table's rows, which stop at the unclassified heading. */
    const rankedRows = (stdout: string): string[] => {
        const cut = stdout.indexOf('Not classified');
        const head = cut === -1 ? stdout : stdout.slice(0, cut);
        return head.split('\n').filter((line) => /^\s+\d[\d,]*\s+\d{6,}\s/.test(line));
    };

    for (const limit of [1, 2]) {
        const { stdout } = await invoke([
            'intermittent', '--harness', 'mochitest', ...WINDOW,
            '--limit', String(limit),
        ]);
        assert.equal(rankedRows(stdout).length, limit, `--limit ${limit} should print ${limit} rows`);
        assert.ok(
            stdout.includes(`… ${total - limit} more (--limit 0 for all)`),
            `--limit ${limit} should say ${total - limit} more, not a remainder of some default`
        );
    }

    const all = await invoke([
        'intermittent', '--harness', 'mochitest', ...WINDOW, '--limit', '0',
    ]);
    assert.equal(rankedRows(all.stdout).length, total, '--limit 0 should print every matched row');
});

test('a row prints the full verified test path, not a job name', async () => {
    // Complaint 3: the old column printed `mochitest-browser-chrome-39` plus
    // whatever fragment was scraped from a log line, which produced rows reading
    // `ShutdownLeaks` and `TestRunner.js)`. The path is now a real path, so it
    // pastes straight into `fx-tests test`.
    const { stdout } = await invoke([
        'intermittent', '--harness', 'mochitest', ...WINDOW, '--limit', '0',
    ]);
    assert.match(stdout, /browser\/components\/tabbrowser\/test\/browser\/tabs\/browser_tab_preview\.js/);
    // No job name anywhere in the table.
    assert.doesNotMatch(stdout, /mochitest-browser-chrome-\d+/);
    assert.doesNotMatch(stdout, /opt-mochitest-chrome-1proc/);
});

test('the failure column carries what the other columns do not', async () => {
    // Complaint 4: `Frequent browser/.../brow…` repeated the test column and
    // told the reader nothing. The prefix and the path are stripped, so what is
    // left is the discriminator.
    const { stdout } = await invoke([
        'intermittent', '--harness', 'mochitest', ...WINDOW, '--limit', '0',
    ]);
    assert.match(stdout, /Currently highlighted match should be at 2 for/);
    assert.doesNotMatch(stdout, /^\s+\d[\d,]*\s+\d{6,}\s+\S+\s+Frequent /m);
});

test('--markdown links the bug and does not truncate', async () => {
    const { stdout } = await invoke([
        'intermittent', '--harness', 'mochitest', ...WINDOW, '--markdown',
    ]);
    assert.match(stdout, /\[\d+\]\(https:\/\/bugzilla\.mozilla\.org\/show_bug\.cgi\?id=\d+\)/);
    assert.match(stdout, /Currently highlighted match should be at 2 for 't' - got 1, expected 2/);
    assert.doesNotMatch(stdout, /…/);
});

// --- the drill-down ------------------------------------------------------

test('--bug groups one bug’s occurrences and prints its task ids', async () => {
    const { code, stdout } = await invoke([
        'intermittent',
        '--bug',
        '1980036',
        ...WINDOW,
        '--limit',
        '0',
    ]);
    assert.equal(code, ExitCode.Success);
    const recorded = fixture.failuresbybug['1980036']!;
    assert.match(stdout, /^Bug 1980036 — /m);
    assert.match(stdout, new RegExp(`${recorded.length} sheriff annotations on trunk`));
    assert.match(stdout, /^Job names, chunk numbers merged$/m);
    assert.match(stdout, /^Platforms$/m);
    assert.match(stdout, /^Build types$/m);
    for (const occurrence of recorded) {
        assert.ok(
            stdout.includes(occurrence.task_id),
            `task id ${occurrence.task_id} should be printed under --limit 0`
        );
    }
});

test('--bug --json carries every occurrence, not a grouped summary only', async () => {
    const { stdout } = await invoke(['intermittent', '--bug', '1980036', ...WINDOW, '--json']);
    const parsed = JSON.parse(stdout) as {
        occurrences: number;
        occurrenceRows: { taskId: string; lines: string[] }[];
        jobNames: unknown[];
        totalOccurrences: number;
    };
    const recorded = fixture.failuresbybug['1980036']!;
    assert.equal(parsed.occurrences, recorded.length);
    assert.equal(parsed.occurrenceRows.length, recorded.length);
    assert.ok(parsed.occurrenceRows.every((row) => typeof row.taskId === 'string'));
    assert.ok(parsed.jobNames.length > 0);
    // Unfiltered, so the two counts agree — which is what makes a filtered run
    // legible when they do not.
    assert.equal(parsed.totalOccurrences, recorded.length);
});

test('every mode fits the terminal width', async () => {
    // The defect: header prose was never wrapped and the table's column budgets
    // did not add up, so an 80-column terminal got 162-character lines. Both
    // halves are checked here, at three widths, in every mode — a single spot
    // check is what let it ship.
    const longest = (text: string): number =>
        Math.max(0, ...text.split('\n').map((line: string) => line.length));
    const modes = [
        [],
        ['--harness', 'mochitest'],
        ['--harness', 'xpcshell'],
        ['--harness', 'unknown'],
        ['--bug', '1980036'],
    ];
    for (const columns of ['60', '80', '200']) {
        for (const mode of modes) {
            const { stdout } = await invoke(
                ['intermittent', ...mode, ...WINDOW, '--limit', '5'],
                undefined,
                undefined,
                columns
            );
            // Two blocks are deliberately uncut, and both are worse cut. The
            // full-path recovery block exists precisely to give back a path
            // that can be pasted into `fx-tests test`. And `--bug`'s occurrence
            // table is six identifier columns — a timestamp and a task id
            // shortened are values that cannot be looked up — so
            // `MIN_CELL_WIDTH` stops shaving before it destroys them, and the
            // table is allowed to exceed a very narrow terminal.
            const occurrences = stdout.indexOf('\nOccurrences (');
            const head = occurrences === -1 ? stdout : stdout.slice(0, occurrences);
            const body = head
                .split('\n')
                .filter((line) => !/^\s*\S+\/\S+$/.test(line))
                .join('\n');
            assert.ok(
                longest(body) <= Number(columns),
                `${mode.join(' ') || '(no --harness)'} at COLUMNS=${columns}: ` +
                    `longest line ${longest(body)}`
            );
        }
    }
});

test('a narrow terminal wraps the header prose rather than overflowing', async () => {
    const { stdout } = await invoke(
        ['intermittent', ...WINDOW, '--limit', '1'],
        undefined,
        undefined,
        '60'
    );
    // The sentence is still complete, just across lines.
    assert.match(stdout.replace(/\n/g, ' '), /annotated bugs, ranked by count/);
    const header = stdout.split('\n').slice(0, 8);
    assert.ok(
        header.every((line) => line.length <= 60),
        header.join('|')
    );
});

test('--markdown and --full-messages ignore the terminal width', async () => {
    // Both exist to produce untruncated text; a narrow terminal must not cut
    // them. `… N more` is a truncation *marker*, not truncation, so a list that
    // was limited still carries it.
    for (const flag of ['--markdown', '--full-messages']) {
        const { stdout } = await invoke(
            ['intermittent', ...WINDOW, '--limit', '3', flag],
            undefined,
            undefined,
            '60'
        );
        const cuts = stdout
            .split('\n')
            .filter((line) => line.includes('…') && !line.includes('more'));
        assert.deepEqual(cuts, [], `${flag} must not truncate at COLUMNS=60`);
    }
});

test('--bug --markdown truncates nothing, in any of its sections', async () => {
    // The defect this pins, and it shipped: the Markdown drill-down applied
    // `DRILLDOWN_ROWS` to its suite table, its message list and its task-ID list
    // and emitted no `… n more` line for any of them, so a comment pasted into a
    // bug silently carried 10 of 43 suites and 10 of 140 task IDs while reading
    // as complete. `--markdown` is a file format, not a terminal view
    // (`cli/format/markdown.ts`, work-list item 17), so the fix is to emit all of
    // it rather than to add a marker.
    const bug = '1980036';
    const recorded = fixture.failuresbybug[bug]!;
    const suites = new Set(recorded.map((row) => row.test_suite));
    const { stdout } = await invoke(['intermittent', '--bug', bug, ...WINDOW, '--markdown']);
    for (const suite of suites) {
        assert.ok(stdout.includes(suite), `Markdown must name suite ${suite}`);
    }
    for (const row of recorded) {
        assert.ok(stdout.includes(row.task_id), `Markdown must name task ${row.task_id}`);
    }
    // And no truncation marker, because nothing was cut.
    assert.doesNotMatch(stdout, /… \d+ more/);

    // `--limit` must not shrink it either: that is what makes it a file format.
    const limited = await invoke([
        'intermittent',
        '--bug',
        bug,
        ...WINDOW,
        '--markdown',
        '--limit',
        '1',
    ]);
    assert.equal(limited.stdout, stdout, '--limit must not change --markdown output');
});

test('a bug with no annotations in the window is exit 2 explaining the window', async () => {
    const { code, stderr } = await invoke(['intermittent', '--bug', '4242424', ...WINDOW]);
    assert.equal(code, ExitCode.NotFound);
    assert.match(stderr, /no sheriff annotations for bug 4242424/);
    assert.match(stderr, /--tree all/);
});

// --- the run index, the profile notices and the profile URLs -------------

test('a task id prints with its run index, as `test --task-ids` does', async () => {
    // The defect: a subagent took an occurrence's task ID, fetched `runs/0`,
    // and the annotated failure was not there — run 0 had ended in `exception`.
    // The recorded window holds one such job, `retry_id` 5, so this asserts
    // Treeherder's own answer rather than a constructed one.
    const { code, stdout } = await invoke([
        'intermittent',
        '--bug',
        '2063359',
        ...WINDOW,
        '--limit',
        '0',
    ]);
    assert.equal(code, ExitCode.Success);
    for (const occurrence of fixture.failuresbybug['2063359']!) {
        const runId = fixture.runIds[String(occurrence.job_id)];
        assert.ok(
            stdout.includes(`${occurrence.task_id}.${runId}`),
            `expected ${occurrence.task_id}.${runId} in the occurrence rows`
        );
    }
    // The one job that is not run 0. Without it this test would pass against a
    // hardcoded `.0`.
    assert.match(stdout, /FsWPMrs5RkORDe3E0CLckg\.5/);
});

test('a run index the API does not answer for is omitted, not guessed as 0', async () => {
    const client = fixtureClient();
    const withoutRunIds: IntermittentsClient & { calls: string[] } = {
        ...client,
        runIdsOfJobs: () => Promise.resolve(new Map<number, number>()),
    };
    const { code, stdout } = await invoke(
        ['intermittent', '--bug', '2063359', ...WINDOW, '--limit', '0'],
        withoutRunIds
    );
    assert.equal(code, ExitCode.Success);
    // A guessed `.0` reads exactly like a known one, which is the defect.
    assert.ok(stdout.includes('FsWPMrs5RkORDe3E0CLckg'));
    assert.ok(!stdout.includes('FsWPMrs5RkORDe3E0CLckg.'));
});

test('a profile notice is not counted as a failure message', async () => {
    // Four of the top eight "failure messages" on live bug 2063582 were
    // `profile uploaded in …`, which is artifact metadata rather than a failure.
    const { code, stdout } = await invoke([
        'intermittent',
        '--bug',
        '2062444',
        ...WINDOW,
        '--limit',
        '0',
    ]);
    assert.equal(code, ExitCode.Success);
    const recorded = fixture.failuresbybug['2062444']!;
    assert.ok(
        recorded.some((row) => row.lines.some((line) => line.includes('profile uploaded in'))),
        'the fixture must carry a profile notice for this test to mean anything'
    );
    const tally = stdout.slice(stdout.indexOf('Failure messages, per annotated job'));
    assert.ok(!tally.includes('profile uploaded in'), tally);
});

test('--profiles emits only filenames a log line named, and labels a rerun', async () => {
    // This test used to assert the opposite: that a `-2` notice also produced
    // the first run's URL, synthesised by stripping the suffix. That is a
    // guessed filename, which `lib/links.ts` prohibits in terms, and it is
    // information-free — removing `-2` is a transformation any consumer can
    // apply, so printing the result doubled the section with output that only
    // looked like data. It now pins the prohibition instead.
    const { code, stdout } = await invoke([
        'intermittent',
        '--bug',
        '2062444',
        ...WINDOW,
        '--profiles',
        '--limit',
        '0',
    ]);
    assert.equal(code, ExitCode.Success);
    assert.match(stdout, /^Profiles \(raw artifact URLs, for profiler-cli\)$/m);

    // Every filename printed must appear verbatim in some occurrence's log.
    const named = new Set(
        fixture.failuresbybug['2062444']!.flatMap((row) =>
            row.lines.flatMap((line) => {
                const match = /profile uploaded in (profile_\S+\.json)/.exec(line);
                return match === null ? [] : [match[1]!];
            })
        )
    );
    assert.ok(named.size > 0, 'the fixture must name at least one profile');
    const printed = [...stdout.matchAll(/public\/test_info\/(profile_\S+\.json)/g)].map(
        (match) => match[1]!
    );
    assert.ok(printed.length > 0);
    for (const filename of printed) {
        assert.ok(named.has(filename), `${filename} was printed but no log line named it`);
    }

    // A named `-2` file is still labelled as the rerun: reading the data, not
    // inventing it.
    const first = fixture.failuresbybug['2062444']![0]!;
    const rerun = /profile uploaded in (profile_\S+-2\.\w+\.json)/.exec(first.lines.join('\n'));
    assert.ok(rerun, 'the fixture row must name a -2 profile');
    const runId = fixture.runIds[String(first.job_id)];
    const base = `https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/${first.task_id}/runs/${runId}/artifacts/public/test_info`;
    assert.ok(stdout.includes(`rerun:   ${base}/${rerun[1]}`), stdout);
    // The stripped name is never emitted, in any label.
    assert.ok(
        !stdout.includes(rerun[1]!.replace(/-2(\.\w+\.json)$/, '$1')),
        'the first run\u2019s filename was synthesised by stripping -2'
    );
    assert.ok(!stdout.includes('first run'), stdout);
    // The absence is explained once, for the section, not per row.
    assert.equal(stdout.split('Treeherder keeps only the').length - 1, 1);
});

test('no profile filename is ever synthesised, over every recorded bug', () => {
    // The class, not the one case: whatever the log named is what is emitted,
    // for every bug in the fixture. `lib/links.ts` — "a caller must not
    // substitute a guessed filename — nothing in the data supports one".
    for (const [bug, rows] of Object.entries(fixture.failuresbybug)) {
        const occurrences = rows.map(toResolvedOccurrence);
        const named = new Set(
            rows.flatMap((row) =>
                row.lines.flatMap((line) => {
                    const match = /profile uploaded in (profile_\S+\.json)/.exec(line);
                    return match === null ? [] : [match[1]!];
                })
            )
        );
        for (const built of occurrenceProfiles(occurrences)) {
            for (const profile of built.profiles) {
                assert.ok(
                    named.has(profile.filename),
                    `bug ${bug} emitted ${profile.filename}, which no log line named`
                );
            }
        }
    }
});

test('--json carries the profiles without the flag, and costs no extra request', async () => {
    const { stdout, calls } = await invoke(['intermittent', '--bug', '2062444', ...WINDOW, '--json']);
    const parsed = JSON.parse(stdout) as {
        profiles: { run: string; jobName: string; profiles: { url: string }[] }[];
    };
    assert.ok(parsed.profiles.length > 0);
    assert.ok(parsed.profiles.every((row) => row.profiles.length > 0));
    // Item 1's "no new network request", asserted against the **whole** call
    // list rather than a prefix filter. The first version of this test filtered
    // for a `taskcluster` prefix the fixture client never emits, so it was
    // always comparing `[]` to `[]` and would have passed had
    // `occurrenceProfiles` fetched every artifact it names.
    //
    // Exactly three: the occurrences, one batched run-index lookup for all
    // eight of them, and the bug summary. A URL is built from data already in
    // hand, so adding a request per profile — or per occurrence — fails here.
    assert.deepEqual(calls, [
        `failuresbybug:2062444:trunk:${fixture.startday}:${fixture.startday}`,
        `runids:${fixture.failuresbybug['2062444']!.length}`,
        'bugzilla:2062444',
    ]);
});

test('a pure profile notice is not ranked as a test path', () => {
    // The defect the first version of this change left behind: the notices were
    // partitioned out of the failure-message tally but `tallyTests` still read
    // the raw `lines`, so a line that is *nothing but* a notice was ranked as a
    // test. These two lines are verbatim from live bug 2060167, where
    // `shutdown hang` came first with 806 occurrences — above the test the bug
    // is about. Measured over the top 25 trunk bugs of 2026-08-28..09-03, 810
    // of 5,560 occurrences carry a notice-only path.
    const test2060167: BugOccurrence = {
        bugId: 2060167,
        jobId: 1,
        testSuite: 'mochitest-browser-chrome-1',
        platform: 'linux2404-64',
        buildType: 'opt',
        revision: 'abc',
        tree: 'autoland',
        pushTime: '2026-09-03 21:00:00',
        machineName: 'm',
        taskId: 'T1',
        runId: 0,
        lines: [
            '21:34:29     INFO - TEST-UNEXPECTED-FAIL | browser/components/aiwindow/ui/test/browser/browser_aiwindow_group_tabs_button.js | This test exceeded the timeout threshold.',
            '21:42:03    ERROR - GECKO(23125) | TEST-UNEXPECTED-FAIL | shutdown hang | profile uploaded in profile_shutdown_hang_23125.json',
            '21:30:45    ERROR - GECKO(1575) | TEST-UNEXPECTED-FAIL | shutdown hang | profile uploaded in profile_shutdown_hang_1575.json',
        ],
    };
    // `shutdown hang` is the path field of a notice and of nothing else, so it
    // is not a test and must not be a row.
    assert.deepEqual(tallyTests([test2060167]), [
        {
            name: 'browser/components/aiwindow/ui/test/browser/browser_aiwindow_group_tabs_button.js',
            count: 1,
        },
    ]);
    const summary = summariseBug(2060167, [test2060167]);
    assert.deepEqual(summary.tests, tallyTests([test2060167]));
    assert.ok(!summary.lines.some((entry) => entry.name.includes('profile uploaded in')));
    // Both notices still reach the profile section — partitioned out of the
    // tallies, not discarded.
    assert.deepEqual(
        occurrenceProfiles([test2060167])[0]!.profiles.map((entry) => entry.filename),
        ['profile_shutdown_hang_23125.json', 'profile_shutdown_hang_1575.json']
    );
});

test('no reader of an occurrence reaches the raw lines past the partition', async () => {
    // The class rather than the two symptoms: whatever a caller asks for, a
    // `profile uploaded in …` notice must not appear as a failure message or as
    // a test path. Checked over every recorded bug and every rendered mode.
    for (const bug of Object.keys(fixture.failuresbybug)) {
        const rows = fixture.failuresbybug[bug]!.map(toOccurrence);
        const summary = summariseBug(Number(bug), rows);
        for (const [label, counts] of Object.entries({
            tests: summary.tests,
            lines: summary.lines,
        })) {
            for (const entry of counts) {
                assert.ok(
                    !entry.name.includes('profile uploaded in'),
                    `bug ${bug} ${label} ranks a profile notice: ${entry.name}`
                );
            }
        }
    }
    // And through the command, where the tallies are rendered.
    for (const format of [[], ['--markdown']]) {
        const { stdout } = await invoke([
            'intermittent',
            '--bug',
            '2062444',
            ...WINDOW,
            ...format,
            '--limit',
            '0',
        ]);
        const tallies = stdout.slice(0, stdout.indexOf('Profiles'));
        assert.ok(!tallies.includes('profile uploaded in'), tallies);
    }
});

test('a profile URL is omitted rather than guessed when the run is unknown', async () => {
    // The row header already declined to guess `.0`; the URL beneath it did not,
    // so a `runs/0` URL that 404s was printed as if resolved. Reachable through
    // the documented degraded path: `withRunIds` warns and yields `null`.
    const client = fixtureClient();
    const withoutRunIds: IntermittentsClient & { calls: string[] } = {
        ...client,
        runIdsOfJobs: () => Promise.resolve(new Map<number, number>()),
    };
    const { code, stdout } = await invoke(
        ['intermittent', '--bug', '2062444', ...WINDOW, '--json'],
        withoutRunIds
    );
    assert.equal(code, ExitCode.Success);
    const parsed = JSON.parse(stdout) as {
        profiles: { runId: number | null; profiles: { url: string | null; filename: string }[] }[];
    };
    assert.ok(parsed.profiles.length > 0);
    for (const row of parsed.profiles) {
        assert.equal(row.runId, null);
        for (const profile of row.profiles) {
            assert.equal(profile.url, null, 'no URL may be built from an unresolved run');
            assert.ok(profile.filename.length > 0, 'the filename is still reported');
        }
    }
    assert.ok(!stdout.includes('/runs/0/'));
});

test('a profile with no URL is not rendered, nor is the row it empties', async () => {
    // A bare filename is not an answer: the run index a reader would need to
    // build the URL is exactly what is missing. So the entry goes, the row goes
    // with it when it empties, and the section says why rather than printing an
    // empty heading — a silent absence reads as "this bug has no profiles".
    const client = fixtureClient();
    const withoutRunIds: IntermittentsClient & { calls: string[] } = {
        ...client,
        runIdsOfJobs: () => Promise.resolve(new Map<number, number>()),
    };
    for (const format of [[], ['--markdown']]) {
        const { code, stdout } = await invoke(
            ['intermittent', '--bug', '2062444', ...WINDOW, '--profiles', ...format, '--limit', '0'],
            withoutRunIds
        );
        assert.equal(code, ExitCode.Success);
        assert.ok(!stdout.includes('no URL'), stdout);
        assert.ok(!stdout.includes('.js.json'), 'no bare filename may be rendered');
    }
    // Text names the cause; markdown drops the section rather than heading an
    // empty list, as it does for every other empty section.
    const { stdout: text } = await invoke(
        ['intermittent', '--bug', '2062444', ...WINDOW, '--profiles', '--limit', '0'],
        withoutRunIds
    );
    assert.match(text, /^Profiles$/m);
    assert.match(text, /none reachable: .* named a profile/);
    assert.match(text, /run index did not resolve/);
    const { stdout: markdown } = await invoke(
        ['intermittent', '--bug', '2062444', ...WINDOW, '--profiles', '--markdown', '--limit', '0'],
        withoutRunIds
    );
    assert.ok(!markdown.includes('## Profiles'), markdown);
});

test('the profile row names the platform and build type, not the bare suite', async () => {
    // `test --profiles` prints Treeherder's full `job_type_name`; this printed
    // the stripped `test_suite`, so two rows on different platforms read
    // identically. The three fields are reported as the API gives them rather
    // than spliced into a job name — see `OccurrenceProfiles.configuration`:
    // Treeherder mis-splits sanitizer builds, so the splice would be a string
    // that does not exist for 5.4% of occurrences.
    const rows = fixture.failuresbybug['2062444']!.map(toResolvedOccurrence);
    const built = occurrenceProfiles(rows);
    assert.ok(built.length > 0);
    for (const row of built) {
        const source = rows.find((occurrence) => occurrence.taskId === row.taskId)!;
        assert.equal(
            row.configuration,
            `${source.platform}/${source.buildType} ${source.testSuite}`
        );
        // The chunk survives: a profile belongs to one chunk, so merging them
        // would point a reader at a different job.
        assert.ok(row.configuration.endsWith(source.testSuite));
    }
    const { stdout } = await invoke([
        'intermittent',
        '--bug',
        '2062444',
        ...WINDOW,
        '--profiles',
        '--limit',
        '0',
    ]);
    // Only the rows whose URL resolved are rendered, so the assertion is made
    // against one of those rather than against `built[0]`.
    const rendered = built.filter((row) => row.profiles.some((entry) => entry.url !== null));
    assert.ok(rendered.length > 0, 'the fixture must resolve at least one run');
    for (const row of rendered) {
        assert.ok(
            stdout.includes(`${row.run}  ${row.configuration}`),
            `expected "${row.run}  ${row.configuration}" in the Profiles section`
        );
    }
});

test('a sanitizer build is reported as Treeherder splits it, not as a spliced job name', () => {
    // The Windows ASAN shape, verbatim from live bug 2021221: the `asan` is in
    // `build_type` and the `opt` at the head of `test_suite`, while the real job
    // is `test-windows11-64-25h2-asan/opt-mochitest-chrome-1proc-2`. Splicing
    // `test-<platform>/<buildType>-<suite>` would assert a job name that does
    // not exist, so the fields are reported unjoined.
    const asan: BugOccurrence = {
        ...fixture.failuresbybug['2062444']!.map(toResolvedOccurrence)[0]!,
        platform: 'windows11-64-25h2',
        buildType: 'asan',
        testSuite: 'opt-mochitest-chrome-1proc-2',
    };
    const [row] = occurrenceProfiles([asan]);
    assert.ok(row);
    assert.equal(row.configuration, 'windows11-64-25h2/asan opt-mochitest-chrome-1proc-2');
    // The string Treeherder would not recognise.
    assert.ok(!row.configuration.includes('test-windows11-64-25h2/asan-opt'));
});

test('an occurrence with no Taskcluster metadata gets no artifact URL', () => {
    // `UNKNOWN_TASK_ID` is a documented sentinel on this field, not a task, so
    // `…/task/unknown/runs/0/artifacts/…` would present a value that cannot be
    // fetched as one that can.
    const noMetadata: BugOccurrence = {
        ...fixture.failuresbybug['2062444']!.map(toResolvedOccurrence)[0]!,
        taskId: UNKNOWN_TASK_ID,
    };
    const [row] = occurrenceProfiles([noMetadata]);
    assert.ok(row, 'the occurrence is still listed — it named a profile');
    assert.ok(row.profiles.length > 0);
    for (const profile of row.profiles) {
        assert.equal(profile.url, null);
    }
});

test('a paginated /api/jobs/ response is refused rather than silently truncated', async () => {
    // `JOB_BATCH_SIZE` is set below Treeherder's measured page size so one batch
    // is one page. That is a measurement of someone else's default, and a
    // smaller page would leave the tail of a batch with no run index — which is
    // indistinguishable from run 0 to every caller downstream.
    const client = intermittentsClient({
        root: 'https://th.test',
        fetch: (url: string) =>
            Promise.resolve({
                ok: true,
                status: 200,
                url,
                arrayBuffer: () =>
                    Promise.resolve(
                        new TextEncoder().encode(
                            JSON.stringify({
                                job_property_names: ['id', 'retry_id'],
                                results: [[1, 0]],
                                next: 'https://th.test/api/jobs/?id__in=2&page=2',
                            })
                        ).buffer as ArrayBuffer
                    ),
            }),
    });
    await assert.rejects(() => client.runIdsOfJobs([1, 2]), (error: Error) => {
        assert.ok(error instanceof IntermittentsError);
        assert.match(error.message, /paginated a 2-job request/);
        assert.match(error.message, /JOB_BATCH_SIZE/);
        return true;
    });
});

test('--profiles is refused on the ranked list, where a row is a bug', async () => {
    const { code, stderr } = await invoke(['intermittent', ...WINDOW, '--profiles']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /--profiles needs one bug/);
    assert.match(stderr, /--bug <id> --profiles/);
});

// --- --test <path> -------------------------------------------------------

test('bugsNamingTest selects on the exact path, and lives in lib', () => {
    // Shared by `intermittent --test` and `fx-tests test`'s bug block, so it is
    // in `lib/query/` beside `selectHarness` rather than exported from a command
    // module for another command to import across.
    const scan = scanBugs({
        ranking: fixture.failures.map((row) => ({ bugId: row.bug_id, count: row.bug_count })),
        summaries: new Map(
            Object.entries(fixture.summaries).map(([bug, summary]) => [Number(bug), summary])
        ),
        harnessOfPath: fixtureHarnessOfPath,
    });
    const path = 'toolkit/profile/test/xpcshell/test_check_backup.js';
    const matches = bugsNamingTest(scan.rows, path);
    assert.deepEqual(
        matches.map((row) => row.bugId),
        [2063359]
    );
    // A directory prefix selects nothing: several tests have no single bug.
    assert.deepEqual(bugsNamingTest(scan.rows, 'toolkit/profile/test/xpcshell'), []);
    // Count-descending, inherited from `scanBugs`.
    const counts = bugsNamingTest(scan.rows, path).map((row) => row.count);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
});

test('--test selects the bug by test path, without a bug number', async () => {
    const { code, stdout } = await invoke([
        'intermittent',
        '--test',
        'toolkit/profile/test/xpcshell/test_check_backup.js',
        ...WINDOW,
    ]);
    assert.equal(code, ExitCode.Success);
    assert.match(stdout, /^Bug 2063359 — /m);
});

test('--test takes an exact path, not a directory prefix', async () => {
    const { code, stderr } = await invoke([
        'intermittent',
        '--test',
        'toolkit/profile/test/xpcshell',
        ...WINDOW,
    ]);
    assert.equal(code, ExitCode.NotFound);
    assert.match(stderr, /no sheriff-annotated bug names the test/);
    assert.match(stderr, /a directory prefix will not do/);
});

test('--test lists every bug naming the test rather than choosing one', async () => {
    // Two bugs on one test is item 5's case: choosing the larger for the reader
    // hides the one they did not get. The recorded window holds no such pair,
    // so a second bug with the same summary path is injected over the fixture.
    const inner = fixtureClient();
    const path = 'toolkit/profile/test/xpcshell/test_check_backup.js';
    const twoBugs: IntermittentsClient & { calls: string[] } = {
        ...inner,
        async rankBugs(tree, range) {
            return [...(await inner.rankBugs(tree, range)), { bugId: 9999999, count: 3 }];
        },
        async bugSummaries(bugs) {
            const found = await inner.bugSummaries(bugs);
            if (bugs.includes(9999999)) {
                found.set(9999999, `Intermittent ${path} | a second failure of the same test`);
            }
            return found;
        },
    };
    const { code, stdout } = await invoke(['intermittent', '--test', path, ...WINDOW], twoBugs);
    assert.equal(code, ExitCode.Success);
    assert.match(stdout, /2 sheriff-annotated bugs name /);
    assert.match(stdout, /\b2063359\b/);
    assert.match(stdout, /\b9999999\b/);
    assert.match(stdout, /Drill into one with --bug <id>\./);
});

test('--test and --bug together are a usage error, not a silent precedence', async () => {
    const { code, stderr } = await invoke([
        'intermittent',
        '--bug',
        '2063359',
        '--test',
        'toolkit/profile/test/xpcshell/test_check_backup.js',
        ...WINDOW,
    ]);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /both select one bug/);
});

// --- the tallies are per annotated job -----------------------------------

test('a test path is counted once per job that named it, not once per line', () => {
    // The bug this pins: one job emits `TEST-UNEXPECTED-FAIL` once per failing
    // assertion, so counting lines reported `2,486x browser_findbar_marks.js`
    // against 140 occurrences on live bug 2019094 — seventeen times the
    // population, sitting beside per-occurrence counts.
    const occurrences: BugOccurrence[] = [
        {
            bugId: 1,
            testSuite: 'mochitest-browser-chrome-1',
            platform: 'linux',
            buildType: 'opt',
            revision: 'abc',
            tree: 'autoland',
            pushTime: '2026-08-10 00:00:00',
            machineName: 'm',
            taskId: 'T1',
            jobId: 1,
            runId: 0,
            lines: [
                '00:00:01     INFO - TEST-UNEXPECTED-FAIL | a/b/test_one.js | first - failed',
                '00:00:02     INFO - TEST-UNEXPECTED-FAIL | a/b/test_one.js | second - failed',
                '00:00:03     INFO - TEST-UNEXPECTED-FAIL | a/b/test_one.js | third - failed',
            ],
        },
    ];
    assert.deepEqual(tallyTests(occurrences), [{ name: 'a/b/test_one.js', count: 1 }]);

    const summary = summariseBug(1, occurrences);
    assert.deepEqual(summary.tests, [{ name: 'a/b/test_one.js', count: 1 }]);
    // The messages differ, so all three are their own row — repetition within
    // one job is collapsed, distinct messages are not.
    assert.equal(summary.lines.length, 3);
    assert.ok(summary.lines.every((entry) => entry.count === 1));
});

test('no tally can exceed the number of occurrences it was built from', async () => {
    // The invariant behind the previous test, checked over the whole fixture
    // rather than a constructed case: every count in a per-occurrence tally is
    // bounded by the population.
    for (const [bug, rows] of Object.entries(fixture.failuresbybug)) {
        const occurrences: BugOccurrence[] = rows.map(toOccurrence);
        const summary = summariseBug(Number(bug), occurrences);
        for (const [label, counts] of Object.entries({
            jobNames: summary.jobNames,
            platforms: summary.platforms,
            buildTypes: summary.buildTypes,
            tests: summary.tests,
            lines: summary.lines,
        })) {
            for (const entry of counts) {
                assert.ok(
                    entry.count <= occurrences.length,
                    `bug ${bug}: ${label} reports ${entry.count}x "${entry.name}" from ` +
                        `${occurrences.length} occurrences`
                );
            }
        }
    }
});

test('a failure message keeps its discriminator once the marker and path come off', () => {
    // Measured on live bug 2019094: the top three lines were byte-identical for
    // the first 100 characters, so a truncated ranking showed three rows of the
    // same visible text. The path is reported in its own section.
    const line =
        '13:47:02     INFO - TEST-UNEXPECTED-FAIL | toolkit/content/tests/browser/' +
        'browser_findbar_marks.js | test_findmarks - marks should be on the horizontal ' +
        'scrollbar - "undefined" === false';
    const detail = failureLineDetail(line);
    assert.equal(
        detail,
        'test_findmarks - marks should be on the horizontal scrollbar - "undefined" === false'
    );
    assert.ok(!detail.includes('TEST-UNEXPECTED-FAIL'));
    assert.ok(!detail.includes('browser_findbar_marks.js'));
    assert.ok(detail.length < 90, 'the detail should fit a row without losing its end');
});

test('a per-run duration is normalised, so one message is one row', () => {
    // The harness appends `finished in 1306ms` to a failing test file, with the
    // TEST-UNEXPECTED-FAIL marker, so it is a real failure line — but the number
    // differs every run. Left alone it was 108 of 120 message rows on live bug
    // 1829935, each with a count of 1, burying the message that says what broke.
    const detail = (ms: number) =>
        failureLineDetail(`00:00:00     INFO - TEST-UNEXPECTED-FAIL | a/test.js | finished in ${ms}ms`);
    assert.equal(detail(1306), 'finished in <n>ms');
    assert.equal(detail(1306), detail(9925), 'two runs of one message must be one row');
    // Only the duration is touched; the rest of the message survives.
    assert.equal(
        failureLineDetail('00:00:00     INFO - TEST-UNEXPECTED-FAIL | a/test.js | timed out after 50 tries.'),
        'timed out after 50 tries.'
    );
});

test('a failure message containing a pipe keeps the whole message', () => {
    // The message can itself contain `|`, so the tail is rejoined rather than
    // indexed. Splitting on the second pipe would cut a shell command or a
    // regex out of the middle of a message.
    const detail = failureLineDetail(
        '00:00:00     INFO - TEST-UNEXPECTED-FAIL | a/test.js | got "a | b", expected "c | d"'
    );
    assert.equal(detail, 'got "a | b", expected "c | d"');
});

test('a line with no test path keeps its own text rather than becoming empty', () => {
    const detail = failureLineDetail('00:00:00     INFO - [taskcluster:error] exit status 1');
    assert.equal(detail, '[taskcluster:error] exit status 1');
    assert.equal(stripLogTimestamp('00:00:00     INFO - hello'), 'hello');
});

// --- flags that cannot be answered are refused ---------------------------

test('--data-source is refused, and named as the tree-wide question it is not', async () => {
    // It was listed in --help and accepted at runtime while changing nothing:
    // advertised, accepted, ignored. The ranking is Treeherder's tree-wide
    // annotations, which have no try-scoped or local equivalent.
    const { code, stderr } = await invoke(['intermittent', '--data-source', 'try', ...WINDOW]);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /--data-source cannot be applied to intermittent/);
    assert.match(stderr, /tree-wide/);
    // The refusal names the flag the caller probably wanted.
    assert.match(stderr, /--tree/);
});

test('--help lists no flag this command ignores, and describes the rest correctly', async () => {
    // Item 13's rule, applied to this command: a flag in --help that does
    // nothing is indistinguishable from a flag that is broken. The audit also
    // covers wording — a global whose shared description is wrong here is the
    // same defect in prose.
    const { stdout } = await invoke(['intermittent', '--help']);
    assert.ok(!stdout.includes('--data-source'), '--data-source is refused and must not be listed');
    // `--config` stays listed: it is refused on the ranked list but works on
    // `--bug`, so hiding it would be the opposite error.
    assert.ok(stdout.includes('--config'));
    // `--harness` is not inferred here: there is no test path to infer from.
    assert.doesNotMatch(stdout, /Inferred from the test path/);
    assert.match(stdout, /mochitest\|xpcshell\|unknown/);
    // `--day` must not advertise the keywords this command rejects.
    assert.doesNotMatch(stdout, /YYYY-MM-DD, today, yesterday/);
    // The window default is visible, since it differs from `test`'s 21 days.
    assert.match(stdout, /--since <n> *The last n days, ending today \(UTC\)\. Default 7\./);
});

test('--harness filters the drill-down instead of refusing it', async () => {
    // It used to refuse, on the grounds that a bug's occurrences are what they
    // are. But the rows carry a job name per occurrence, so restricting to one
    // harness is a projection over data already in hand, not a query the API
    // cannot answer.
    const bug = '1809667';
    const all = fixture.failuresbybug[bug]!;
    const mochitest = all.filter((row) => /(^|-)mochitest(-|$)/.test(row.test_suite));
    assert.ok(
        mochitest.length > 0 && mochitest.length < all.length,
        'the fixture bug must be mixed, or this asserts nothing'
    );

    const { code, stdout } = await invoke([
        'intermittent', '--bug', bug, '--harness', 'mochitest', ...WINDOW, '--limit', '0',
    ]);
    assert.equal(code, ExitCode.Success);
    // The header states the filter's effect rather than a bare smaller number.
    assert.ok(
        stdout.includes(`${mochitest.length} of ${all.length} sheriff annotations match the filter`),
        `expected "${mochitest.length} of ${all.length}" in:\n${stdout.split('\n')[1]}`
    );
    // No non-mochitest job name survives the filter.
    const jobs = stdout.slice(stdout.indexOf('Job names'), stdout.indexOf('Platforms'));
    assert.doesNotMatch(jobs, /talos|browsertime|jittest|geckoview-xpcshell/);
});

test('every section of a filtered drill-down comes from the same population', async () => {
    // Item 14's rule: a header total disagreeing with its own table is the
    // defect that row exists to fix, and filtering one list while computing the
    // rest over everything is how you get it.
    const bug = '1809667';
    const occurrences = fixture.failuresbybug[bug]!.map(toOccurrence);
    const filtered = summariseBug(Number(bug), occurrences, { harness: 'mochitest' });
    const sum = (counts: { count: number }[]) => counts.reduce((n, c) => n + c.count, 0);
    assert.equal(sum(filtered.jobNames), filtered.occurrences);
    assert.equal(sum(filtered.platforms), filtered.occurrences);
    assert.equal(sum(filtered.buildTypes), filtered.occurrences);
    assert.equal(sum(filtered.trees), filtered.occurrences);
    assert.equal(filtered.totalOccurrences, occurrences.length);
    assert.ok(filtered.occurrences < filtered.totalOccurrences);
    // A filtered population contains nothing it filtered out.
    assert.equal(filtered.unclassifiedOccurrences, 0);
});

test('--config filters on platform and build type, as `test --config` does', async () => {
    const bug = '1809667';
    const occurrences = fixture.failuresbybug[bug]!.map(toOccurrence);
    const platform = occurrences[0]!.platform;
    const buildType = occurrences[0]!.buildType;
    // All three spellings work, because the match is against `<platform>/<build>`.
    for (const config of [platform, buildType, `${platform}/${buildType}`]) {
        const filtered = summariseBug(Number(bug), occurrences, { config: [config] });
        assert.ok(filtered.occurrences > 0, `--config ${config} matched nothing`);
        assert.ok(
            filtered.occurrences <= filtered.totalOccurrences,
            'a filter cannot produce more than it was given'
        );
        const sum = filtered.platforms.reduce((n, c) => n + c.count, 0);
        assert.equal(sum, filtered.occurrences, `--config ${config}: sections must reconcile`);
    }
});

test('--harness and --config compose rather than excluding each other', async () => {
    const bug = '1809667';
    const occurrences = fixture.failuresbybug[bug]!.map(toOccurrence);
    const mochitest = summariseBug(Number(bug), occurrences, { harness: 'mochitest' });
    const platform = mochitest.platforms[0]!.name;
    const both = summariseBug(Number(bug), occurrences, {
        harness: 'mochitest',
        config: [platform],
    });
    assert.ok(both.occurrences > 0);
    assert.ok(
        both.occurrences <= mochitest.occurrences,
        'adding --config to --harness cannot widen the result'
    );
    assert.equal(both.totalOccurrences, occurrences.length);
});

test('a filter matching nothing is exit 2, not an empty report', async () => {
    const { code, stderr } = await invoke([
        'intermittent', '--bug', '1809667', '--config', 'no-such-platform', ...WINDOW,
    ]);
    assert.equal(code, ExitCode.NotFound);
    assert.match(stderr, /none match the filter/);
    // The message says the bug does have annotations, which is the distinction.
    assert.match(stderr, /\d+ annotations on trunk/);
});

test('--config is refused on the ranked list, pointing at --bug', async () => {
    // A bug spans every configuration it was annotated on, so there is nothing
    // per-row to filter here — but the flag works on the drill-down, so the
    // refusal names it rather than saying the tool cannot do this at all.
    const { code, stderr } = await invoke(['intermittent', '--config', 'linux', ...WINDOW]);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /--config cannot be applied to the ranked list/);
    assert.match(stderr, /--bug <id> --config/);
});

test('job names are grouped with the chunk merged and the variant kept', async () => {
    // `mochitest-browser-chrome-1` through `-12` are one configuration run
    // twelve ways; `-no-nv-7` is a different one. Grouping the raw values gives
    // a reader twelve rows of noise instead of one number.
    const occurrences = fixture.failuresbybug['1980036']!.map(toOccurrence);
    const summary = summariseBug(1980036, occurrences);
    for (const entry of summary.jobNames) {
        assert.doesNotMatch(entry.name, /-\d+$/, `${entry.name} still carries a chunk number`);
    }
    // The variant survives, so two configurations do not merge into one.
    const raw = new Set(occurrences.map((row) => row.testSuite));
    if ([...raw].some((name) => name.includes('-msix'))) {
        assert.ok(summary.jobNames.some((entry) => entry.name.includes('-msix')));
    }
    // And the grouping loses no occurrence.
    assert.equal(
        summary.jobNames.reduce((n, c) => n + c.count, 0),
        occurrences.length
    );
});

test('--day rejects the today/yesterday keywords and says why they do not apply', async () => {
    // They mean "the newest day with published data" everywhere else in this
    // CLI, which is a property of an index this command does not read.
    const { code, stderr } = await invoke(['intermittent', '--day', 'today']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /--day expects YYYY-MM-DD/);
    assert.match(stderr, /live API/);
});

test('intermittent takes no positional argument', async () => {
    const { code, stderr } = await invoke(['intermittent', '1980036']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /takes no arguments/);
    assert.match(stderr, /--bug <id>/);
});

test('an unknown tree becomes a usage error naming the trees that work', async () => {
    // Treeherder answers 400, and `validate_tree` is the only thing in these
    // endpoints that rejects a request — so exit 3 "retry" would be wrong: the
    // retry fails identically forever.
    const client = fixtureClient();
    client.rankBugs = async () => {
        throw new IntermittentsError('HTTP 400', 'https://treeherder.mozilla.org/api/failures/', 400);
    };
    const { code, stderr } = await invoke(['intermittent', ...WINDOW], client);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /unknown tree/);
    assert.match(stderr, /trunk, firefox-releases, comm-releases/);
});

test('a 5xx stays exit 3, because retrying may work', async () => {
    const client = fixtureClient();
    client.rankBugs = async () => {
        throw new IntermittentsError('HTTP 503', 'https://treeherder.mozilla.org/api/failures/', 503);
    };
    const { code, stderr } = await invoke(['intermittent', ...WINDOW], client);
    assert.equal(code, ExitCode.Upstream);
    assert.match(stderr, /HTTP 503/);
    assert.match(stderr, /retrying may work/);
});

// --- the window ----------------------------------------------------------

test('the window maps onto the API’s two required YYYY-MM-DD parameters', () => {
    // `startday` and `endday` are both required and both `YYYY-MM-DD`
    // (`FailuresQueryParamsSerializer`), so the CLI's own date flags land here.
    const today = new Date('2026-08-17T09:30:00Z');
    assert.deepEqual(resolveRange(undefined, undefined, today), {
        start: '2026-08-11',
        end: '2026-08-17',
    });
    assert.deepEqual(resolveRange(undefined, 1, today), { start: '2026-08-17', end: '2026-08-17' });
    assert.deepEqual(resolveRange(undefined, 30, today), {
        start: '2026-07-19',
        end: '2026-08-17',
    });
    assert.deepEqual(resolveRange('2026-08-01', undefined, today), {
        start: '2026-08-01',
        end: '2026-08-01',
    });
});

test('the default window is a whole number of weeks', () => {
    // The reason `fx-tests summary` gives: push volume drops several-fold at
    // weekends, so a window that is not a multiple of 7 ranks a different
    // weekday mix every time it is run.
    assert.equal(DEFAULT_DAYS % 7, 0);
});

test('the window is UTC, so it does not ask for tomorrow east of Greenwich', () => {
    // A local-time end date would be tomorrow for anyone east of UTC late in
    // the day, which this API answers with an empty tail rather than an error.
    const lateUtc = new Date('2026-08-17T23:59:00Z');
    assert.equal(resolveRange(undefined, 1, lateUtc).end, '2026-08-17');
});

test('the requested window is what reaches the client', async () => {
    const { calls } = await invoke(['intermittent', '--since', '3', '--limit', '1']);
    const ranking = calls.find((call) => call.startsWith('failures:'));
    assert.ok(ranking !== undefined);
    const [, tree, start, end] = ranking.split(':');
    assert.equal(tree, 'trunk');
    assert.match(start!, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(end!, /^\d{4}-\d{2}-\d{2}$/);
    const days =
        (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
    assert.equal(days, 3);
});

test('--tree reaches the client verbatim', async () => {
    const { calls } = await invoke(['intermittent', '--tree', 'autoland', ...WINDOW, '--limit', '1']);
    assert.ok(calls.some((call) => call.startsWith('failures:autoland:')));
});

// --- the URLs the client builds ------------------------------------------

test('the client builds the documented query strings and decodes the documented fields', async () => {
    // The one test that pins the request shape rather than the logic above it:
    // both endpoints take `startday`, `endday` and `tree`, and only
    // `/failuresbybug/` takes `bug`.
    const requested: string[] = [];
    const client = intermittentsClient({
        root: 'https://th.test',
        bugzillaRoot: 'https://bz.test',
        async fetch(url: string) {
            requested.push(url);
            const body = url.includes('/rest/bug')
                ? JSON.stringify({ bugs: [{ id: 7, summary: 'a summary' }] })
                : url.includes('failuresbybug')
                  ? JSON.stringify(fixture.failuresbybug['1980036'])
                  : JSON.stringify(fixture.failures);
            return {
                ok: true,
                status: 200,
                url,
                arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
            };
        },
    });

    const range = { start: '2026-08-10', end: '2026-08-16' };
    const ranking = await client.rankBugs('trunk', range);
    assert.equal(
        requested[0],
        'https://th.test/api/failures/?startday=2026-08-10&endday=2026-08-16&tree=trunk'
    );
    assert.equal(ranking[0]!.bugId, fixture.failures[0]!.bug_id);
    assert.equal(ranking[0]!.count, fixture.failures[0]!.bug_count);

    const occurrences = await client.occurrencesOfBug('trunk', range, 1980036);
    assert.equal(
        requested[1],
        'https://th.test/api/failuresbybug/?startday=2026-08-10&endday=2026-08-16&tree=trunk&bug=1980036'
    );
    const first = fixture.failuresbybug['1980036']![0]!;
    assert.equal(occurrences[0]!.testSuite, first.test_suite);
    assert.equal(occurrences[0]!.taskId, first.task_id);
    assert.equal(occurrences[0]!.buildType, first.build_type);
    assert.equal(occurrences[0]!.pushTime, first.push_time);
    assert.deepEqual(occurrences[0]!.lines, first.lines);

    const summaries = await client.bugSummaries([7]);
    assert.equal(requested[2], 'https://bz.test/rest/bug?id=7&include_fields=id,summary');
    assert.equal(summaries.get(7), 'a summary');
});

test('a non-200 becomes an IntermittentsError carrying the status and the URL', async () => {
    const client = intermittentsClient({
        root: 'https://th.test',
        async fetch(url: string) {
            return {
                ok: false,
                status: 400,
                url,
                arrayBuffer: async () => new ArrayBuffer(0),
            };
        },
    });
    await assert.rejects(
        () => client.rankBugs('nope', { start: '2026-08-10', end: '2026-08-16' }),
        (error: unknown) => {
            assert.ok(error instanceof IntermittentsError);
            assert.equal(error.status, 400);
            assert.match(error.url, /^https:\/\/th\.test\/api\/failures\//);
            return true;
        }
    );
});

// --- caching -------------------------------------------------------------

test('a warm run makes no requests, and a stale one re-fetches', async () => {
    // A live query has no `generatedAt` to key on, so it gets its own TTL —
    // neither the aggregates' twelve hours nor an artifact's never. The scan
    // costs one request per candidate bug, so re-running the same command with
    // a different `--limit`, which is what a caller does next, must be free.
    await withCacheDir(async (directory) => {
        let now = Date.parse('2026-08-17T12:00:00Z');
        const cache = diskCache({ directory, now: () => now });
        const inner = fixtureClient();
        const cached = cachedIntermittents(inner, cache);
        const range = { start: fixture.startday, end: fixture.endday };

        await cached.rankBugs('trunk', range);
        await cached.occurrencesOfBug('trunk', range, 1980036);
        await cached.bugSummaries([1980036, 2062444]);
        const cold = inner.calls.length;
        assert.equal(cold, 3);

        await cached.rankBugs('trunk', range);
        await cached.occurrencesOfBug('trunk', range, 1980036);
        await cached.bugSummaries([1980036, 2062444]);
        assert.equal(inner.calls.length, cold, 'a warm run must make no request at all');

        now += QUERY_TTL_MS + 1;
        await cached.rankBugs('trunk', range);
        assert.equal(inner.calls.length, cold + 1, 'past the TTL it must re-fetch');
    });
});

test('the cache key includes the tree, the window and the bug', async () => {
    // A key that dropped any of the three would serve one window's ranking for
    // another's — a wrong answer that looks completely normal, since the numbers
    // are plausible for either.
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        const inner = fixtureClient();
        const cached = cachedIntermittents(inner, cache);
        const range = { start: '2026-08-10', end: '2026-08-16' };

        await cached.rankBugs('trunk', range);
        await cached.rankBugs('autoland', range);
        await cached.rankBugs('trunk', { start: '2026-08-01', end: '2026-08-16' });
        await cached.rankBugs('trunk', { start: '2026-08-10', end: '2026-08-15' });
        assert.equal(inner.calls.length, 4, 'each of tree, startday and endday must be in the key');

        const before = inner.calls.length;
        await cached.occurrencesOfBug('trunk', range, 1980036);
        await cached.occurrencesOfBug('trunk', range, 2062444);
        assert.equal(inner.calls.length - before, 2);
    });
});

test('a cached bug-summary batch survives the round trip through JSON', async () => {
    // `bugSummaries` returns a `Map`, which `JSON.stringify` turns into `{}`.
    // Getting this wrong would cache an empty result and print
    // "(no summary from Bugzilla)" for every row on the second run.
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        const inner = fixtureClient();
        const cached = cachedIntermittents(inner, cache);
        const cold = await cached.bugSummaries([1980036, 2062444]);
        const warm = await cached.bugSummaries([1980036, 2062444]);
        assert.equal(inner.calls.length, 1);
        assert.deepEqual([...warm], [...cold]);
        assert.equal(warm.get(1980036), fixture.summaries['1980036']);
    });
});

test('the same bugs in a different order share one cache entry', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        const inner = fixtureClient();
        const cached = cachedIntermittents(inner, cache);
        await cached.bugSummaries([2062444, 1980036]);
        await cached.bugSummaries([1980036, 2062444]);
        assert.equal(inner.calls.length, 1);
    });
});

test('an entry written under another rule is not readable as a query', async () => {
    // Query entries share `urlCacheHash`'s key space with task artifacts and
    // push job lists, so the *kind* is the only thing keeping them apart at one
    // hash. Without the check, a query response — which must expire within the
    // hour — could be served from an immutable artifact entry that never does.
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        const key = 'intermittents:failures:trunk:2026-08-10:2026-08-16';
        await cache.putArtifact(key, new TextEncoder().encode('[]'));
        assert.equal(await cache.getQuery(key), null);
        // And the converse, so the check is not merely rejecting everything.
        await cache.putQuery(key, new TextEncoder().encode('[1]'));
        assert.equal(new TextDecoder().decode((await cache.getQuery(key))!), '[1]');
        // A query entry must not be readable as an immutable artifact either.
        assert.equal(await cache.getArtifact(key), null);
    });
});

test('--no-cache reads nothing and writes nothing', async () => {
    await withCacheDir(async (directory) => {
        const client = fixtureClient();
        const streams = captureStreams();
        for (let i = 0; i < 2; i++) {
            await run({
                argv: ['intermittent', ...WINDOW, '--no-cache', '--cache-dir', directory],
                streams,
                source: issuesSource(),
                intermittents: client,
            });
        }
        // Two runs, two rankings: nothing was remembered between them.
        assert.equal(client.calls.filter((call) => call.startsWith('failures:')).length, 2);
        assert.deepEqual(await diskCache({ directory }).list(), []);
    });
});

test('a cache write failure warns and does not fail the run', async () => {
    // Same contract as everywhere else in this cache: a read-only cache
    // directory makes the CLI slower, not broken.
    const cache = diskCache({ directory: join(tmpdir(), 'fx-tests-intermittent-cache') });
    const failing = {
        ...cache,
        async putQuery(): Promise<void> {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        },
        async getQuery(): Promise<Uint8Array | null> {
            return null;
        },
    };
    const warnings: string[] = [];
    const inner = fixtureClient();
    const cached = cachedIntermittents(inner, failing, {
        onWarning: (message) => warnings.push(message),
    });
    const ranking = await cached.rankBugs('trunk', {
        start: fixture.startday,
        end: fixture.endday,
    });
    assert.ok(ranking.length > 0, 'the answer must still be complete');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /results below are complete and correct/);
});

test('bug summaries are requested in one batch, not one request per bug', async () => {
    // `/failures/` gives no summary at all, so the ranked list needs a Bugzilla
    // lookup per row — and one request per row would be twenty requests for one
    // screen of output.
    const requested: string[] = [];
    const client = intermittentsClient({
        bugzillaRoot: 'https://bz.test',
        async fetch(url: string) {
            requested.push(url);
            return {
                ok: true,
                status: 200,
                url,
                arrayBuffer: async () =>
                    new TextEncoder().encode(JSON.stringify({ bugs: [] })).buffer as ArrayBuffer,
            };
        },
    });
    await client.bugSummaries([1, 2, 3, 4, 5]);
    assert.equal(requested.length, 1);
    assert.match(requested[0]!, /id=1,2,3,4,5/);
});
