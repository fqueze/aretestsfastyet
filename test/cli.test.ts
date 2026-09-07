/**
 * The CLI, end to end, against the checked-in fixtures.
 *
 * Every test here calls `run()` with a `memorySource` and captured streams:
 * no subprocess, no network, no disk cache unless the test builds one in a
 * temporary directory. `PLAN.md` §3 step 4 requires that no test hits the
 * network, and the injected source is what makes that structural rather than
 * a rule to remember.
 *
 * ## What the golden numbers are, and where they came from
 *
 * The expected counts below were derived **from the fixture JSON directly**,
 * by a throwaway script that sums the raw parallel arrays — not by running the
 * code under test and recording what it said. That distinction is the whole
 * value of the assertion: a golden captured from the implementation only
 * proves the implementation is deterministic.
 *
 * `dom/indexedDB/test/unit/test_rename_objectStore_errors.js` in
 * `xpcshell-00.json` is the workhorse fixture test, because it exercises seven
 * statuses at once: `PASS-PARALLEL` (15,638), `PASS-SEQUENTIAL` (6), `PASS`
 * (314), `SKIP` (1,348), `CRASH` (6), `FAIL-PARALLEL` (2) and
 * `FAIL-SEQUENTIAL` (2). The three pass buckets are what
 * `--executions` must not merge, and the skips are all `skip-if` with no
 * `run-if`, which is the aggregate-family invariant `FORMATS.md` records.
 *
 * ## What is deliberately asserted about *absence*
 *
 * Several tests assert that something is **not** printed or **not** fetched:
 * that `--day` reads no daily file, that a mochitest `--executions` prints no
 * mode table, that an uncomparable message shows `?` rather than `0.0%`. Those
 * are the regressions that produce plausible output, so they are the ones
 * worth pinning.
 */

import { readFile, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { type DataFileName, type DataSource, DataFetchError, DataFileNotFoundError } from '../lib/sources/source.ts';
import type { TreeherderClient, TreeherderJob } from '../lib/sources/treeherder.ts';
import { CANDIDATE_LIMIT } from '../lib/query/test-lookup.ts';
import { ExitCode } from '../cli/errors.ts';
import { type CommandContext, captureStreams } from '../cli/context.ts';
import { diskCache } from '../cli/cache.ts';
import { COMMAND_NAMES, run } from '../cli/main.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

async function fixtureBytes(name: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(new URL(name, FIXTURES)));
}

/** The test whose counts every golden below refers to. */
const TEST_PATH = 'dom/indexedDB/test/unit/test_rename_objectStore_errors.js';
/** A mochitest in `mochitest-00.json`, for the no-mode-axis assertions. */
const MOCHITEST_PATH =
    'browser/components/tabbrowser/test/browser/tabs/browser_tab_dragdrop2.js';
/**
 * The one test whose fixture keeps a `profile uploaded in …` failure message,
 * so `--profiles` can render a per-test profile URL. Uncommon in real data,
 * but not impossible, which is why the branch needs pinning.
 */
const PROFILE_NAMED_TEST = 'layout/base/tests/chrome/test_bug551434.html';
/**
 * A Windows-only crash-reporter test, for the `--coverage` rollup.
 *
 * Chosen because one test exhibits every outcome the rollup has to tell apart:
 * on Windows it ran on 9 configs and was scheduled-and-skipped on 2 more, on
 * Android it was scheduled and skipped on every config, and on mac and linux it
 * is not scheduled at all — so those platforms have no row, which is how
 * `--coverage` reports them. A rollup that conflates any two of those produces
 * a visibly wrong row here, or a row where there should be none.
 */
const WINDOWS_ONLY_TEST =
    'toolkit/crashreporter/test/unit/test_crash_win64cfi_push_nonvol.js';

/**
 * A source serving the fixtures under the names the CLI asks for.
 *
 * Records every requested name, so a test can assert **what was not
 * fetched** — which is how `--day must not read a daily file` is checked. An
 * assertion on the output alone could not tell the two paths apart.
 */
function fixtureSource(): DataSource & { requested: string[] } {
    const requested: string[] = [];
    const files: Record<string, string> = {
        // The bucket `TEST_PATH` hashes into is 00, which is the fixture.
        'xpcshell-timings/xpcshell-00.json': 'xpcshell-00.json',
        'mochitest-timings/mochitest-00.json': 'mochitest-00.json',
        'xpcshell-timings/xpcshell-stats.json': 'xpcshell-stats.json',
        'mochitest-timings/mochitest-stats.json': 'mochitest-stats.json',
        'xpcshell-timings/index.json': 'index.json',
        'mochitest-timings/index.json': 'index.json',
        'xpcshell-timings/xpcshell-2026-08-03.json': 'xpcshell-2026-08-03.json',
        // The path list `resolveTest` searches, served from the bucket fixtures
        // rather than `xpcshell-issues.json`. `collectTestPaths` reads only
        // `tables.testPaths` / `tables.testNames` / `testInfo`, which both
        // families carry identically — and it has to be the *bucket* fixtures'
        // 20 tests, because a path the list offers and the bucket does not hold
        // is the one case the resolution cannot complete. The real
        // `xpcshell-issues.json` fixture names ten tests that hash into buckets
        // 02, 08, 12 and 1c, none of them published here.
        'xpcshell-timings/xpcshell-issues.json': 'xpcshell-00.json',
        'mochitest-timings/mochitest-issues.json': 'mochitest-00.json',
    };
    return {
        name: 'fixtures',
        requested,
        async fetch(fileName: DataFileName): Promise<Uint8Array> {
            const key = `${fileName.index}/${fileName.filename}`;
            requested.push(key);
            const local = files[key];
            if (local === undefined) {
                throw new DataFileNotFoundError(fileName);
            }
            return fixtureBytes(local);
        },
    };
}

/**
 * An intermittents client that throws if anything touches it.
 *
 * Two jobs. It keeps this file offline: without a stub, `run()` builds a real
 * client against `nodeFetch`, so any command that reached the intermittents API
 * would have this suite hitting Treeherder and Bugzilla for real — slower,
 * flakier, and different on a plane.
 *
 * And it is how "the default path makes no request" is *asserted* rather than
 * assumed. A stub returning empty results would let a regression that resolves
 * the annotations by default pass silently; one that throws turns that
 * regression into a failure. `fx-tests test --bugs` is the only thing in here
 * that may touch it, and those tests pass their own client.
 *
 * `test/intermittent.test.ts` has the recorded fixture client and is where the
 * ranking's behaviour is actually pinned.
 */
function silentIntermittents(): NonNullable<Parameters<typeof run>[0]['intermittents']> {
    const refuse = (method: string) => (): never => {
        throw new Error(
            `intermittents.${method} was called, but this command should make no live request`
        );
    };
    return {
        rankBugs: refuse('rankBugs'),
        occurrencesOfBug: refuse('occurrencesOfBug'),
        runIdsOfJobs: refuse('runIdsOfJobs'),
        bugSummaries: refuse('bugSummaries'),
    };
}

/** Runs one invocation and returns everything a test might assert on. */
async function invoke(
    argv: string[],
    overrides: Partial<Parameters<typeof run>[0]> = {}
): Promise<{ code: number; stdout: string; stderr: string; source: DataSource & { requested: string[] } }> {
    const streams = captureStreams();
    const source = (overrides.source as DataSource & { requested: string[] }) ?? fixtureSource();
    const code = await run({
        intermittents: silentIntermittents(),
        argv,
        streams,
        source,
        // A cache that can never be read or written: these tests must not
        // depend on, or leave behind, anything in the developer's real cache.
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        ...overrides,
    });
    return { code, stdout: streams.stdout, stderr: streams.stderr, source };
}

/** Parses `--json` stdout. */
function json(stdout: string): Record<string, unknown> {
    return JSON.parse(stdout) as Record<string, unknown>;
}

// --- the exit-code table is a contract, so it is pinned to literals -------

test('the exit codes are the literal numbers CLI.md documents', () => {
    // Pinned to literals on purpose. Every other assertion in this file
    // compares against `ExitCode.Usage` and friends, which means mutating the
    // constant moves the code and the test together — a mutation changing
    // `Usage: 1` to `Usage: 0` survived the whole suite. These values are a
    // published contract that scripts branch on, so the numbers themselves
    // have to be asserted somewhere.
    assert.equal(ExitCode.Success, 0);
    assert.equal(ExitCode.Usage, 1);
    assert.equal(ExitCode.NotFound, 2);
    assert.equal(ExitCode.Upstream, 3);
    // No producer yet — `fx-tests crash` in step 5 is the first — but the
    // value is part of the same table and the 3/4 split is the reason the
    // table exists at all.
    assert.equal(ExitCode.Gone, 4);
});

test('a usage error exits with the literal 1', async () => {
    const { code } = await invoke(['test', TEST_PATH, '--json', '--markdown']);
    assert.equal(code, 1);
});

test('a not-found exits with the literal 2', async () => {
    const { code } = await invoke(['test', 'dom/base/test/test_nonexistent90.js']);
    assert.equal(code, 2);
});

test('a transient upstream failure exits with the literal 3', async () => {
    const flaky: DataSource = {
        name: 'flaky',
        fetch(name) {
            return Promise.reject(new DataFetchError(name, 'ECONNRESET'));
        },
    };
    const { code } = await invoke(['summary', '--harness', 'xpcshell'], {
        source: flaky as DataSource & { requested: string[] },
    });
    assert.equal(code, 3);
});

test('success exits with the literal 0', async () => {
    const { code } = await invoke(['test', TEST_PATH, '--json']);
    assert.equal(code, 0);
});

// --- argument parsing and exit codes -------------------------------------

test('--json and --markdown together is a usage error, not one winning', async () => {
    const { code, stdout, stderr } = await invoke(['test', TEST_PATH, '--json', '--markdown']);
    assert.equal(code, ExitCode.Usage);
    assert.equal(stdout, '', 'a usage error must print nothing to stdout');
    assert.match(stderr, /mutually exclusive/);
});

test('an unknown option exits 1 and suggests the closest real one', async () => {
    const { code, stderr } = await invoke(['test', TEST_PATH, '--covrage']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /unknown option --covrage/);
    assert.match(stderr, /Did you mean --coverage\?/);
});

test('an option missing its value exits 1 naming the option, not consuming the next flag', async () => {
    const { code, stderr } = await invoke(['test', TEST_PATH, '--limit', '--json']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /--limit requires a value/);
});

test('--limit rejects a non-integer rather than silently flooring it', async () => {
    const { code, stderr } = await invoke(['test', TEST_PATH, '--limit', '2.5']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /non-negative integer/);
});

test('a value on a boolean option is a usage error', async () => {
    const { code, stderr } = await invoke(['test', TEST_PATH, '--json=yes']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /--json takes no value/);
});

test('--day and --since together is a usage error', async () => {
    const { code, stderr } = await invoke(['test', TEST_PATH, '--day', '2026-08-03', '--since', '3']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /mutually exclusive/);
});

test('--harness rejects an unknown harness', async () => {
    const { code, stderr } = await invoke(['test', TEST_PATH, '--harness', 'reftest']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /expects xpcshell or mochitest/);
});

test('an unknown command exits 1 and lists what exists', async () => {
    const { code, stderr } = await invoke(['tset']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /unknown command "tset"/);
});

test('a command CLI.md specifies but has not landed says so, rather than "unknown"', async () => {
    // Driven off PLANNED_COMMANDS rather than naming a command: `errors` and
    // then `manifests` both landed while this suite was being reviewed, and a
    // test pinned to a specific unimplemented command fails the day someone
    // implements it — the wrong signal entirely. What is being asserted is the
    // behaviour, which outlives any particular name.
    const { PLANNED_COMMANDS } = await import('../cli/main.ts');
    const planned = Object.entries(PLANNED_COMMANDS);
    // Step 5 landed the last of them, so this is now legitimately empty and the
    // loop below is a no-op. Kept rather than deleted: `CLI.md` will document a
    // command before it exists again, and the branch it guards — "documented
    // but unlanded" must not read as "unknown command" — still exists in
    // `dispatch()`. `the planned-command branch is still wired up` below is
    // what keeps that branch covered while the list is empty.
    for (const [name, description] of planned) {
        const { code, stderr } = await invoke([name]);
        assert.equal(code, ExitCode.Usage, name);
        assert.match(stderr, /not implemented yet/, name);
        // The description is echoed, so the user learns what it will do.
        assert.ok(stderr.includes(description), `${name} should echo its description`);
        // And the distinction that matters: not "unknown command", which would
        // send someone who read the spec correctly looking for a typo.
        assert.doesNotMatch(stderr, /unknown command/, name);
    }
});

test('the planned-command branch is still wired up, with the list empty', async () => {
    // With `PLANNED_COMMANDS` empty the loop above covers nothing, so the
    // branch would rot untested until the next unlanded command appeared — and
    // then be discovered broken. This drives it directly by injecting an entry,
    // which is the only way to exercise it while everything is implemented.
    const main = await import('../cli/main.ts');
    const planned = main.PLANNED_COMMANDS as Record<string, string>;
    planned['futurecommand'] = 'something CLI.md will describe one day';
    try {
        const { code, stderr } = await invoke(['futurecommand']);
        assert.equal(code, ExitCode.Usage);
        assert.match(stderr, /not implemented yet/);
        assert.match(stderr, /something CLI.md will describe one day/);
        assert.doesNotMatch(stderr, /unknown command/);
    } finally {
        delete planned['futurecommand'];
    }
});

test('a genuinely unknown command is reported as unknown', async () => {
    // The other side of the same branch, so a mutation collapsing the two
    // messages into one cannot survive.
    const { code, stderr } = await invoke(['tsetstuff']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /unknown command "tsetstuff"/);
    assert.doesNotMatch(stderr, /not implemented yet/);
});

test('--help exits 0 and writes to stdout', async () => {
    const { code, stdout, stderr } = await invoke(['--help']);
    assert.equal(code, ExitCode.Success);
    assert.match(stdout, /Usage: fx-tests <command>/);
    assert.equal(stderr, '');
});

test('test with no path exits 1', async () => {
    const { code, stderr } = await invoke(['test']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /requires a path/);
});

// --- the resolution ladder -----------------------------------------------
//
// `resolveTest` (`lib/query/test-lookup.ts`) is shared with `test.html`, and
// what is pinned here is the CLI's half: which of the five outcomes a given
// input produces, and that a message about the *lookup* is never phrased as a
// finding about the test. `fx-tests test browser_tab_preview.js` used to say
// `No such test in mochitest data` while the page said `perma-fail` on the same
// data, and a reviewer read four such messages as four clean tests.

test('a basename resolves to the one test that matches it', async () => {
    const { code, stdout, stderr } = await invoke([
        'test',
        'test_rename_objectStore_errors.js',
        '--json',
    ]);
    assert.equal(code, ExitCode.Success);
    // The answer is about the full path, and `path` says which — a resolution
    // that did not surface what it resolved to would be the same trap in a
    // different place.
    assert.equal(json(stdout)['path'], TEST_PATH);
    assert.match(stderr, /Resolved "test_rename_objectStore_errors\.js" to the one test matching it/);
    assert.match(stderr, new RegExp(TEST_PATH.replace(/[.]/g, '\\.')));
});

test('a fragment several tests match lists them and measures nothing', async () => {
    // Exactly four of the fixtures' 20 tests are under `components/extensions`.
    const { code, stdout, stderr } = await invoke(['test', 'components/extensions']);
    assert.equal(code, ExitCode.NotFound);
    assert.equal(stdout, '', 'an ambiguous query produces no report');
    assert.match(stderr, /and 4 tests match it\. Nothing was measured; pick one:/);
    assert.match(stderr, /test_ext_shadowdom\.js/);
    assert.match(stderr, /test_ext_proxy_speculative\.js/);
    // All four fit under the default limit, so nothing is withheld and no
    // marker is printed — the negative half of the assertion below.
    assert.doesNotMatch(stderr, /more not shown/);
});

test('a candidate list cut by --limit says so, and by how much', async () => {
    // Asserted on the **rendered message**, not on the resolution object. The
    // first version of this change carried a correct `truncated` flag and a
    // renderer that could never act on it, and a unit test on the object passed
    // over a 50-line list that ended without a word.
    const { code, stderr } = await invoke(['test', 'components/extensions', '--limit', '2']);
    assert.equal(code, ExitCode.NotFound);
    // The count is the true total, and the tail accounts for every one of the
    // four: 2 listed + "2 more".
    assert.match(stderr, /and 4 tests match it/);
    assert.match(stderr, /… and 2 more not shown \(--limit 0 for all\)/);
    const listed = stderr.split('\n').filter((line) => /^ {2}\w/.test(line));
    assert.equal(listed.length, 2, `two candidate lines, got: ${listed.join(' | ')}`);
});

test('past the ladder\'s own cap, the message stops promising --limit 0', async () => {
    // More matches than `CANDIDATE_LIMIT`, which the fixtures' 20 tests cannot
    // produce, so the test list is synthesised. This is the case the reviewer
    // reproduced: 50 lines, "more than 50 tests match", and no tail at all.
    const count = 60;
    const names = Array.from({ length: count }, (_, i) => `test_generated_${i}.js`);
    const issues = {
        metadata: { days: 21, endDate: '2026-08-16', generatedAt: '2026-08-17T00:00:00Z' },
        tables: {
            testPaths: ['dom/generated/test'],
            testNames: names,
            statuses: [],
            messages: [],
            crashSignatures: [],
            components: [],
        },
        testInfo: {
            testPathIds: names.map(() => 0),
            testNameIds: names.map((_, i) => i),
            componentIds: names.map(() => null),
        },
        testRuns: names.map(() => []),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(issues));
    const { code, stderr } = await invoke(['test', 'dom/generated', '--limit', '0'], {
        source: {
            name: 'generated',
            requested: [],
            async fetch(fileName: DataFileName): Promise<Uint8Array> {
                if (fileName.filename === 'xpcshell-issues.json') {
                    return bytes;
                }
                // No buckets and no mochitest list: steps 1–2 miss, step 3 runs.
                throw new DataFileNotFoundError(fileName);
            },
        } as DataSource & { requested: string[] },
    });
    assert.equal(code, ExitCode.NotFound);

    // The true count, not "more than 50" — the scan counts past the cap.
    assert.match(stderr, new RegExp(`and ${count} tests match it`));
    const listed = stderr.split('\n').filter((line) => /^ {2}dom\/generated/.test(line));
    assert.equal(listed.length, CANDIDATE_LIMIT, 'the ladder caps the candidates it collects');
    // The tail accounts for the other 10 and does **not** offer `--limit 0`,
    // which is already in effect and cannot lift the ladder's cap.
    assert.match(stderr, new RegExp(`… and ${count - CANDIDATE_LIMIT} more not shown`));
    assert.match(stderr, /narrow the fragment to see the rest/);
    assert.doesNotMatch(stderr, /--limit 0 for all/);
});

test('--limit 0 lists every candidate the ladder collected', async () => {
    const { stderr } = await invoke(['test', 'components/extensions', '--limit', '0']);
    assert.match(stderr, /and 4 tests match it/);
    // Four listed, so no shortfall to mark. `--limit 0` promised all of them
    // above, and here it delivers them.
    assert.doesNotMatch(stderr, /more not shown/);
    for (const name of [
        'test_ext_proxy_speculative.js',
        'test_ext_manifest_omnibox.js',
        'test_ext_contentscript_scriptCreated.js',
        'test_ext_shadowdom.js',
    ]) {
        assert.ok(stderr.includes(name), `${name} is missing from --limit 0`);
    }
});

// Step 2 — the other harness at the same bucket index — needs a test whose
// filename `detectHarness` misclassifies, and neither bucket fixture holds one:
// every mochitest in `mochitest-00.json` is `browser_*.js` or `test_*.html`,
// both of which it gets right. `test/query.test.ts` covers that step over
// synthetic loaders, where the misclassified path can be constructed.

test('a genuinely unknown test says so about the lookup, not about the test', async () => {
    const { code, stdout, stderr } = await invoke([
        'test',
        'dom/base/test/test_nonexistent90.js',
    ]);
    assert.equal(code, ExitCode.NotFound);
    assert.equal(stdout, '');
    // Which harnesses were read, and that the sentence is about the data the
    // tool holds. The wording it replaced — `No such test in xpcshell data` —
    // was read six times as "this test is fine".
    assert.match(stderr, /No test path in the xpcshell and mochitest 21-day data contains/);
    assert.match(stderr, /reports nothing about the test itself/);
});

test('an explicit --harness searches only that harness, and says why it missed', async () => {
    const path = 'dom/canvas/test/webgl-mochitest/test_webgl_high_power.html';
    const found = await invoke(['test', path, '--json']);
    assert.equal(found.code, ExitCode.Success, 'found under the inferred harness');

    const { code, stderr } = await invoke(['test', path, '--harness', 'xpcshell']);
    // A caller who named a harness asked about that harness — but the path is
    // known to exist, so the message says the xpcshell file does not hold it
    // rather than that there is no such test.
    assert.equal(code, ExitCode.NotFound);
    assert.match(stderr, /is a test in the tree-wide data, but it is not in the xpcshell file/);
    assert.match(stderr, /Drop --harness xpcshell/);
});

test('a missing test list is not reported as "no test matches"', async () => {
    const source = fixtureSource();
    const { code, stderr } = await invoke(['test', 'dom/base/test/test_nonexistent90.js'], {
        source: {
            name: 'no-list',
            requested: source.requested,
            async fetch(fileName: DataFileName): Promise<Uint8Array> {
                if (fileName.filename.endsWith('-issues.json')) {
                    throw new DataFileNotFoundError(fileName);
                }
                return source.fetch(fileName);
            },
        } as DataSource & { requested: string[] },
    });
    assert.equal(code, ExitCode.NotFound);
    // The distinction the old message could not make: "searched and found
    // nothing" against "could not search".
    assert.match(stderr, /the test list could not be read, so no search was made/);
    assert.match(stderr, /This says nothing about the test/);
});

// --- fx-tests test -------------------------------------------------------

test('test --json reports the totals the fixture actually contains', async () => {
    const { code, stdout } = await invoke(['test', TEST_PATH, '--json']);
    assert.equal(code, ExitCode.Success);
    const result = json(stdout);
    assert.equal(result['path'], TEST_PATH);
    assert.equal(result['component'], 'Core :: Storage: IndexedDB');
    assert.equal(result['harness'], 'xpcshell');

    // Derived from the fixture JSON by summing the raw arrays, not from the
    // code under test. PASS-PARALLEL 15638 + PASS-SEQUENTIAL 6 + PASS 314.
    const totals = result['totals'] as Record<string, number>;
    assert.equal(totals['passCount'], 15_958);
    assert.equal(totals['failCount'], 4, 'FAIL-PARALLEL 2 + FAIL-SEQUENTIAL 2');
    assert.equal(totals['crashCount'], 6);
    assert.equal(totals['timeoutCount'], 0);
    // Every skip here is a `skip-if`; the aggregates carry no `run-if` at all.
    assert.equal(totals['skipCount'], 1_348);
    assert.equal(totals['runIfSkipCount'], 0);
    // Runs exclude skips: 15958 + 4 + 6 + 0 + 0.
    assert.equal(totals['runCount'], 15_968);
    assert.equal(totals['unknownCount'], 0);
});

test('test --json attributes failures to configs, counting a crash as a failure', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    const configs = json(stdout)['configs'] as { jobName: string; failCount: number }[];
    // Two configs, and which two is the point: the 4 FAIL-* runs are all on
    // one Windows config, and the 6 CRASH runs are all on one macOS config.
    // A crash is a failure for the purpose of "where does this break", which
    // is the disagreement PLAN.md §2 settled — the library reports `crash`
    // separately and lets the caller aggregate, and this is the caller doing
    // so deliberately rather than by accident.
    const byJob = Object.fromEntries(configs.map((c) => [c.jobName, c.failCount]));
    assert.deepEqual(byJob, {
        'test-macosx1015-64-qr/debug-xpcshell': 6,
        'test-windows11-64-25h2-shippable/opt-xpcshell': 4,
    });
});

test('test --json reports canAttributeConfigs true for a bucket file', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    assert.equal(json(stdout)['canAttributeConfigs'], true);
});

/** Loads the issues fixture, which has no `taskInfo` and cannot attribute. */
async function issuesLoader(): Promise<NonNullable<CommandContext['loadTimingFile']>> {
    const { decodeIssues } = await import('../lib/formats/issues.ts');
    type IssuesFile = import('../lib/formats/issues.ts').IssuesFile;
    const raw = JSON.parse(
        new TextDecoder().decode(await fixtureBytes('xpcshell-issues.json'))
    ) as IssuesFile;
    return () => Promise.resolve({ raw, decoded: decodeIssues(raw) });
}

/** A test that fails in the issues fixture, so `configs` is empty for a reason. */
async function failingTestInIssues(): Promise<string> {
    const { decodeIssues } = await import('../lib/formats/issues.ts');
    type IssuesFile = import('../lib/formats/issues.ts').IssuesFile;
    const decoded = decodeIssues(
        JSON.parse(
            new TextDecoder().decode(await fixtureBytes('xpcshell-issues.json'))
        ) as IssuesFile
    );
    for (let id = 0; id < decoded.testCount; id++) {
        for (const [status, count] of decoded.totalsByStatus(id)) {
            if (status.startsWith('FAIL') && count > 0) {
                return decoded.testAt(id).fullPath;
            }
        }
    }
    throw new Error('the issues fixture has no failing test');
}

test('test over a file that cannot attribute configs says so, rather than "none failed"', async () => {
    // Driven through the `loadTimingFile` seam because `fx-tests test` always
    // reads a bucket file, which *can* attribute — so this branch is
    // unreachable from the command's own code path and a literal `true`
    // survived the suite. It stops being unreachable in step 5, where
    // `issues`, `failures`, `crashes` and `skips` all read this family, and
    // wiring the guard live untested is how it would become silently wrong.
    const path = await failingTestInIssues();
    const { code, stdout } = await invoke(['test', path, '--json'], {
        loadTimingFile: await issuesLoader(),
    });
    assert.equal(code, 0);
    const result = json(stdout);

    // The test genuinely failed, and the file genuinely cannot say where.
    const totals = result['totals'] as Record<string, number>;
    assert.ok(totals['failCount']! > 0, 'this test has failures');
    assert.deepEqual(result['configs'], []);
    assert.equal(
        result['canAttributeConfigs'],
        false,
        'an issues file has no taskInfo, so configs: [] means "cannot say"'
    );

    // And `reach` must be null rather than an empty or failing-only summary:
    // with no attributed passes, "where does this run" has no answer here.
    assert.equal(result['reach'], null);
});

test('the text output distinguishes "cannot attribute" from "no config failed"', async () => {
    const path = await failingTestInIssues();
    const { stdout } = await invoke(['test', path], {
        loadTimingFile: await issuesLoader(),
    });
    assert.match(stdout, /does not attribute runs to configurations/);
    assert.doesNotMatch(stdout, /no failing configuration in this window/);
    // And no reach line, since it would be built from failing configs only.
    assert.doesNotMatch(stdout, /^Runs on /m);
});

test('test refuses --config on a file that cannot attribute configs', async () => {
    // Same seam and same reason as the three tests above: production `test`
    // always reads a bucket file. The difference from `--coverage`, which
    // prints a refusal inside its section, is that `--config` shapes *every*
    // number in the report, so it has to fail before any of them are printed —
    // a page of zeros under a filter reads as "clean on that configuration".
    const path = await failingTestInIssues();
    const { code, stderr } = await invoke(['test', path, '--config', 'linux'], {
        loadTimingFile: await issuesLoader(),
    });
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /--config cannot be applied to this xpcshell file/);
    assert.match(stderr, /records no job names/);

    const excluded = await invoke(['test', path, '--exclude-config', 'debug'], {
        loadTimingFile: await issuesLoader(),
    });
    assert.equal(excluded.code, ExitCode.Usage);
});

test('--coverage refuses on a file without attributed passes', async () => {
    const path = await failingTestInIssues();
    const { stdout } = await invoke(['test', path, '--coverage'], {
        loadTimingFile: await issuesLoader(),
    });
    // CLI.md's refusal: printing the failing configs under a "Coverage"
    // heading would present a failure-only view as the whole picture, which
    // is the exact thing --coverage exists to replace.
    assert.match(stdout, /Coverage is not available from this file/);
});

test('canAttributeConfigs is false for a family that cannot attribute', async () => {
    // The bucket fixture can attribute, so asserting `true` against it proves
    // nothing — a hardcoded `true` survives that test. `issues.json` has no
    // `taskInfo` at all, which is the case the field exists to distinguish,
    // and it has to be reached through the library because no CLI command
    // reads that family yet.
    const { decodeIssues } = await import('../lib/formats/issues.ts');
    type IssuesFile = import('../lib/formats/issues.ts').IssuesFile;
    const { canAttributeConfigs, computeConfigStats } = await import(
        '../lib/query/config-stats.ts'
    );
    const issues = decodeIssues(
        JSON.parse(
            new TextDecoder().decode(await fixtureBytes('xpcshell-issues.json'))
        ) as IssuesFile
    );
    assert.equal(canAttributeConfigs(issues), false);

    // And the reason it matters: `computeConfigStats` returns [] here for a
    // test that definitely failed, so [] must not be read as "no config
    // failed". Only the predicate separates the two.
    let testIdWithFailures: number | null = null;
    for (let id = 0; id < issues.testCount && testIdWithFailures === null; id++) {
        for (const [status, count] of issues.totalsByStatus(id)) {
            if (status.startsWith('FAIL') && count > 0) {
                testIdWithFailures = id;
                break;
            }
        }
    }
    assert.ok(testIdWithFailures !== null, 'the issues fixture has a failing test');
    assert.deepEqual(computeConfigStats(issues, testIdWithFailures), []);
});

test('the skip section reports the skip-if condition and its count', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    const skips = json(stdout)['skips'] as { message: string; count: number }[];
    assert.equal(skips.length, 1);
    assert.equal(skips[0]!.count, 1_348);
    assert.match(skips[0]!.message, /os == 'android'/);
});

test('the recent window is reported, not assumed, and is sized by runs', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    const window = json(stdout)['recentWindow'] as { days: number; minRuns: number };
    assert.ok(window !== null, 'a multi-day query must state the window it used');
    assert.equal(window.minRuns, 20);
    assert.ok(
        window.days >= 1 && window.days <= 21,
        `recent window ${window.days} must be within the 21-day file`
    );
});

test('text output states the window width it used', async () => {
    const { stdout } = await invoke(['test', TEST_PATH]);
    assert.match(stdout, /recent = last \d+d, sized so the sparsest config has 20\+ runs/);
});

test('every date printed carries its weekday', async () => {
    const { stdout } = await invoke(['test', TEST_PATH]);
    // The fixture window ends 2026-08-03, a Monday. Without the weekday a
    // reader cannot tell a weekend count from a weekday one, and FORMATS.md
    // measures a 2.6x difference in volume between them.
    assert.match(stdout, /2026-08-03 \(Mon\)/);
    assert.match(stdout, /2026-07-14 \(Tue\)/);
});

// --- the perma-fail verdict, which the fixtures cannot produce -------------

/**
 * A bucket file with one test that never passes on one of its two configs.
 *
 * Hand-built, and the comment says why: **no test in either bucket fixture
 * has a config with a 100% failure rate** — the highest anywhere is under
 * 20% — so the perma-fail branch of the verdict is unreachable from fixture
 * data. A mutation making `permaFails` permanently empty survived the entire
 * suite for exactly that reason.
 *
 * That branch is the single most important thing `fx-tests test` says: an
 * overall pass rate of 96% hides a config where the test has never once
 * passed, and CLI.md lists "a test's overall failure rate understates a
 * single-config perma-fail" among the traps the tool exists to prevent.
 *
 * The shape is copied from `xpcshell-00.json`: `durations` groups carry
 * `jobNameIds`, `task-ids` groups carry nested `taskIdIds` plus `messageIds`,
 * and every group carries delta-encoded `days`.
 */
function permaFailBucket(): string {
    const days = 3;
    return JSON.stringify({
        metadata: {
            startDate: '2026-08-01',
            endDate: '2026-08-03',
            days,
            startTime: 1_785_000_000,
            generatedAt: '2026-08-04T03:00:00.000Z',
            totalTestCount: 1,
            testsWithFailures: 1,
            totalBuckets: 64,
            bucketIndex: 0,
            aggregatedFrom: [],
        },
        tables: {
            jobNames: [
                'test-linux2404-64/debug-xpcshell',
                'test-windows11-64/opt-xpcshell',
                'test-macosx1500-64/debug-xpcshell',
            ],
            testPaths: ['dom/base/test/unit'],
            testNames: ['test_permafail.js'],
            repositories: ['mozilla-central'],
            // Order matters only in that entries are indexed by position.
            statuses: ['PASS', 'FAIL'],
            taskIds: [
                'AAAAAAAAAAAAAAAAAAAAAA.0',
                'BBBBBBBBBBBBBBBBBBBBBB.0',
                'CCCCCCCCCCCCCCCCCCCCCC.0',
                // 99 macOS tasks, so that config reaches 99% without hitting
                // 100. Generated rather than written out.
                ...Array.from({ length: 99 }, (_, i) => `M${String(i).padStart(21, '0')}.0`),
            ],
            messages: ['assertion failed: everything is broken here'],
            crashSignatures: [],
            components: ['Core :: DOM'],
            commitIds: ['abc123'],
        },
        taskInfo: {
            repositoryIds: Array.from({ length: 102 }, () => 0),
            // Tasks 0-2 are the Windows config, which never passes. Tasks 3-4
            // are macOS, which fails 2 of its 3 runs — 67%, deliberately
            // between the 50% a plausible-looking threshold might use and the
            // 100% the rule actually requires. Without a config in that band,
            // loosening the threshold to >= 50 changes nothing observable.
            jobNameIds: [1, 1, 1, ...Array.from({ length: 99 }, () => 2)],
            commitIds: Array.from({ length: 102 }, () => 0),
            chunks: Array.from({ length: 102 }, () => null),
        },
        testInfo: { testPathIds: [0], testNameIds: [0], componentIds: [0] },
        testRuns: [
            [
                // PASS: 30 runs, all on linux, none on windows.
                {
                    durations: [
                        Array.from({ length: 10 }, () => 1000),
                        Array.from({ length: 10 }, () => 1100),
                        Array.from({ length: 10 }, () => 1200),
                        // The single macOS pass. With 99 macOS failures
                        // below, that config sits at 99% — the closest a
                        // config can get to perma-failing without being one.
                        [1300],
                    ],
                    days: [0, 1, 1, 0],
                    jobNameIds: [0, 0, 0, 2],
                },
                // FAIL: three on windows (3 runs, 3 failures — 100%) and 99
                // on macOS (100 runs, 99 failures — 99%).
                {
                    taskIdIds: [
                        [0],
                        [1],
                        [2],
                        Array.from({ length: 99 }, (_, i) => 3 + i),
                    ],
                    days: [0, 1, 1, 0],
                    messageIds: [0, 0, 0, 0],
                },
            ],
        ],
    });
}

/** A source serving only the synthetic perma-fail bucket. */
function permaFailSource(): DataSource & { requested: string[] } {
    const requested: string[] = [];
    return {
        name: 'perma-fixture',
        requested,
        fetch(fileName: DataFileName): Promise<Uint8Array> {
            requested.push(`${fileName.index}/${fileName.filename}`);
            return Promise.resolve(new TextEncoder().encode(permaFailBucket()));
        },
    };
}

test('a config that never passes is reported as a perma-fail, not as 91% healthy', async () => {
    const { code, stdout } = await invoke(
        ['test', 'dom/base/test/unit/test_permafail.js', '--json'],
        { source: permaFailSource() }
    );
    assert.equal(code, 0);
    const result = json(stdout);
    const totals = result['totals'] as Record<string, number>;
    assert.equal(totals['passCount'], 31);
    assert.equal(totals['failCount'], 102);

    // And the verdict must not. This is the number CLI.md warns the overall
    // rate hides.
    const verdict = result['verdict'] as { kind: string; summary: string };
    assert.equal(verdict.kind, 'perma-fail');
    assert.match(verdict.summary, /Never passed on 1 configuration/);
    assert.match(verdict.summary, /test-windows11-64\/opt-xpcshell \(3\/3\)/);

    const configs = result['configs'] as { jobName: string; failRate: number }[];
    const windows = configs.find((config) => config.jobName.includes('windows'));
    assert.ok(windows !== undefined);
    assert.equal(windows.failRate, 100);

    // The macOS config fails 99 of its 100 runs and is still not a
    // perma-fail. "Fails almost always" and "has never once passed" are
    // different findings, and only the second says the config is simply
    // broken — so the threshold is exactly 100, not merely "high". Pinned at
    // 99% because a looser threshold anywhere below that would otherwise go
    // unnoticed.
    const macos = configs.find((config) => config.jobName.includes('macosx'));
    assert.ok(macos !== undefined);
    assert.equal(Math.round(macos.failRate), 99);
    assert.doesNotMatch(verdict.summary, /macosx/, 'a 67% config is not a perma-fail');
    assert.match(verdict.summary, /Never passed on 1 configuration/);
});

test('the perma-fail verdict appears in the text output and points at --coverage', async () => {
    const { stdout } = await invoke(['test', 'dom/base/test/unit/test_permafail.js'], {
        source: permaFailSource(),
    });
    assert.match(stdout, /Verdict: perma-fail\./);
    assert.match(stdout, /Never passed on 1 configuration/);
    // No invented denominator: computeConfigStats only returns configs that
    // ran, so the verdict points at --coverage instead of claiming a total.
    assert.match(stdout, /--coverage for every config it runs on/);
    assert.doesNotMatch(stdout, /perma-fails on 1 of 1 configuration/);
});

test('a test with failures but none perma-failing reads as intermittent', async () => {
    // The other side of the same branch: without this, a mutation forcing
    // every failing test to "perma-fail" would also survive.
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    const verdict = json(stdout)['verdict'] as { kind: string };
    assert.equal(verdict.kind, 'intermittent');
});

// --- --day / --since are filters, not a different file --------------------

test('--day inside the window filters the bucket file and fetches no daily file', async () => {
    const { code, stdout, source } = await invoke([
        'test',
        TEST_PATH,
        '--day',
        '2026-08-03',
        '--json',
    ]);
    assert.equal(code, ExitCode.Success);
    // The load-bearing assertion. A daily file is 10x the size, drops
    // different skips and disagrees on job membership (FORMATS.md), so
    // switching families on a flag would silently change the population.
    assert.deepEqual(source.requested, ['xpcshell-timings/xpcshell-00.json']);
    const metadata = json(stdout)['metadata'] as Record<string, unknown>;
    assert.equal(metadata['singleDay'], true);
    assert.equal(metadata['dayCount'], 1);
    assert.equal(metadata['family'], 'bucket');
});

test('--day narrows the counts rather than returning the whole window', async () => {
    const whole = json((await invoke(['test', TEST_PATH, '--json'])).stdout);
    const oneDay = json(
        (await invoke(['test', TEST_PATH, '--day', '2026-08-03', '--json'])).stdout
    );
    const wholeRuns = (whole['totals'] as Record<string, number>)['runCount']!;
    const dayRuns = (oneDay['totals'] as Record<string, number>)['runCount']!;
    assert.ok(dayRuns > 0, 'the fixture has runs on its last day');
    assert.ok(
        dayRuns < wholeRuns,
        `one day (${dayRuns}) must be fewer runs than 21 (${wholeRuns})`
    );
});

test('--since n and --day agree when n is 1', async () => {
    const day = json((await invoke(['test', TEST_PATH, '--day', '2026-08-03', '--json'])).stdout);
    const since = json((await invoke(['test', TEST_PATH, '--since', '1', '--json'])).stdout);
    assert.deepEqual(day['totals'], since['totals']);
});

test('--since sums to the whole window when it covers it', async () => {
    const whole = json((await invoke(['test', TEST_PATH, '--json'])).stdout);
    const since21 = json((await invoke(['test', TEST_PATH, '--since', '21', '--json'])).stdout);
    assert.deepEqual(whole['totals'], since21['totals']);
});

test('--since beyond the window clamps rather than erroring', async () => {
    const { code, stdout } = await invoke(['test', TEST_PATH, '--since', '90', '--json']);
    assert.equal(code, ExitCode.Success);
    const metadata = json(stdout)['metadata'] as Record<string, number>;
    assert.equal(metadata['dayCount'], 21, 'clamped to what the file has');
});

test('--day outside the window exits 2 and names the window', async () => {
    const { code, stderr } = await invoke(['test', TEST_PATH, '--day', '2020-01-01']);
    assert.equal(code, ExitCode.NotFound);
    assert.match(stderr, /2026-07-14 … 2026-08-03/);
    assert.match(stderr, /21 days/);
});

test('--day today resolves to the data’s newest date, not the system clock', async () => {
    const { code, stdout } = await invoke(['test', TEST_PATH, '--day', 'today', '--json']);
    assert.equal(code, ExitCode.Success);
    // The fixture's window ends 2026-08-03 and the real clock is elsewhere.
    // Anchoring to the clock would 404 on the most natural thing to type.
    const metadata = json(stdout)['metadata'] as Record<string, string>;
    assert.equal(metadata['endDate'], '2026-08-03');
});

test('--day yesterday is the day before the data’s newest date', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--day', 'yesterday', '--json']);
    const metadata = json(stdout)['metadata'] as Record<string, string>;
    assert.equal(metadata['endDate'], '2026-08-02');
});

test('--day rejects a malformed date', async () => {
    const { code, stderr } = await invoke(['test', TEST_PATH, '--day', 'last-tuesday']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /expects YYYY-MM-DD/);
});

// --- --config filtering ---------------------------------------------------

test('--config keeps only matching configs and changes the totals', async () => {
    const { stdout } = await invoke([
        'test',
        TEST_PATH,
        '--config',
        'windows11-64-25h2-shippable',
        '--json',
    ]);
    const result = json(stdout);
    const configs = result['configs'] as { jobName: string }[];
    assert.equal(configs.length, 1);
    assert.match(configs[0]!.jobName, /windows11-64-25h2-shippable/);
    const totals = result['totals'] as Record<string, number>;
    assert.ok(
        totals['runCount']! < 15_968,
        'filtering to one config must reduce the run count'
    );
});

test('--exclude-config is applied after --config', async () => {
    const { stdout } = await invoke([
        'test',
        TEST_PATH,
        '--config',
        'windows',
        '--exclude-config',
        'shippable',
        '--json',
    ]);
    const configs = json(stdout)['configs'] as { jobName: string }[];
    // The only failing config is windows *and* shippable, so excluding
    // shippable must leave nothing.
    assert.equal(configs.length, 0);
});

/**
 * The test whose failing entries hold tasks from two configurations each.
 *
 * `test/query.test.ts` covers the arithmetic; this covers the report. One of its
 * configs is reachable only as the *second* task in its entry, which is the case
 * an entry-level filter drops — and dropping it is what printed `0 fail` in the
 * header beside a non-zero per-config table.
 */
const MULTI_CONFIG_TEST =
    'toolkit/components/extensions/test/xpcshell/test_ext_contentscript_scriptCreated.js';
const LATE_TASK_CONFIG =
    'test-android-em-14-x86_64-shippable-lite/opt-geckoview-xpcshell-nofis';

test('--config makes the header totals and the per-config table agree', async () => {
    const { stdout } = await invoke([
        'test',
        MULTI_CONFIG_TEST,
        '--config',
        LATE_TASK_CONFIG,
        '--json',
    ]);
    const result = json(stdout);
    const totals = result['totals'] as Record<string, number>;
    const configs = result['configs'] as { jobName: string; failCount: number }[];

    assert.equal(configs.length, 1);
    assert.equal(configs[0]!.jobName, LATE_TASK_CONFIG);
    // The invariant the item is about: one report, one filtered population.
    assert.equal(
        totals['failCount']! + totals['timeoutCount']! + totals['crashCount']!,
        configs.reduce((sum, row) => sum + row.failCount, 0),
        'header totals must come from the same filtered population as the table'
    );
    assert.equal(totals['failCount'], 1, 'the failure at task index 1 must be counted');

    // The section that used to disappear — it is the one a `--config` caller is
    // filtering for, and it must cover every failure the header counted.
    const messages = result['messages'] as { count: number }[];
    assert.equal(
        messages.reduce((sum, row) => sum + row.count, 0),
        totals['failCount']
    );
});

test('--config narrows --task-ids and --profiles to the matching configs', async () => {
    const { stdout } = await invoke([
        'test',
        MULTI_CONFIG_TEST,
        '--config',
        LATE_TASK_CONFIG,
        '--task-ids',
        '--profiles',
        '--json',
    ]);
    const result = json(stdout);
    const taskIds = result['taskIds'] as { jobName: string | null }[];
    const profiles = result['profiles'] as { jobName: string | null }[];

    // Both used to be built from whole entries kept on their first task, so
    // they listed every other config's tasks alongside the requested one.
    assert.ok(taskIds.length > 0, '--task-ids must not be empty under a filter that matches');
    for (const row of taskIds) {
        assert.equal(row.jobName, LATE_TASK_CONFIG, '--task-ids leaked another config');
    }
    assert.ok(profiles.length > 0);
    for (const row of profiles) {
        assert.equal(row.jobName, LATE_TASK_CONFIG, '--profiles leaked another config');
    }
});

test('the text report names the --config filter its numbers were measured under', async () => {
    const { stdout } = await invoke(['test', MULTI_CONFIG_TEST, '--config', LATE_TASK_CONFIG]);
    // Without this line a filtered report is indistinguishable from an
    // unfiltered one with different numbers.
    assert.match(stdout, /^Filtered: every count below covers only configurations matching /m);
    assert.match(stdout, new RegExp(LATE_TASK_CONFIG.replace(/[/.]/g, '\\$&')));

    const unfiltered = await invoke(['test', MULTI_CONFIG_TEST]);
    assert.doesNotMatch(unfiltered.stdout, /^Filtered:/m);
    assert.equal(json((await invoke(['test', MULTI_CONFIG_TEST, '--json'])).stdout)['configFilter'], null);
});

/** A config `MULTI_CONFIG_TEST` ran 937 times on and never failed on. */
const CLEAN_CONFIG = 'test-linux2404-64/opt-xpcshell';

test('--config keeps the Issues section in text AND in markdown', async () => {
    // A filter matching a config the test never failed on. The header says 0
    // fail, so the section has nothing to list — but it must still appear and
    // say so, because its absence is what made a filtered report read as an
    // unfiltered clean one.
    //
    // Asserted against **both** renderers. The first version of this test
    // checked text only, and `renderMarkdown` had no such branch: the section
    // vanished in the one format `CLI.md` documents for pasting into a bug,
    // where a reader has nothing to cross-check it against.
    const text = await invoke(['test', MULTI_CONFIG_TEST, '--config', CLEAN_CONFIG]);
    assert.match(text.stdout, /^Issues$/m);
    assert.match(text.stdout, /no issues on the configurations this filter matched/);

    const markdown = await invoke([
        'test',
        MULTI_CONFIG_TEST,
        '--config',
        CLEAN_CONFIG,
        '--markdown',
    ]);
    assert.match(markdown.stdout, /^#+ Issues$/m, 'markdown dropped the section');
    assert.match(markdown.stdout, /no issues on the configurations this filter matched/);

    // Same wording in both, so the two renderers cannot drift into describing
    // the same state differently.
    const sentence = /\(no issues on the configurations this filter matched\)/;
    assert.match(text.stdout, sentence);
    assert.match(markdown.stdout, sentence);
});

test('every section a filter empties reconciles with the totals above it', async () => {
    // Why `Skips` and `Crash signatures` need no such branch, asserted rather
    // than argued: their lists and the header totals are built from the same
    // narrowed population, so a list is empty exactly when its total is zero —
    // and an unfiltered report omits those headings then too, so nothing
    // disappeared *because of* the filter. If that ever stops holding, this
    // fails and the missing-section branch is owed to them as well.
    for (const config of [CLEAN_CONFIG, LATE_TASK_CONFIG]) {
        const { stdout } = await invoke([
            'test',
            MULTI_CONFIG_TEST,
            '--config',
            config,
            '--json',
        ]);
        const result = json(stdout);
        const totals = result['totals'] as Record<string, number>;
        const messages = result['messages'] as { count: number }[];
        const skips = result['skips'] as { count: number }[];
        const crashSignatures = result['crashSignatures'] as { count: number }[];

        const sum = (rows: { count: number }[]): number =>
            rows.reduce((total, row) => total + row.count, 0);
        assert.equal(sum(messages), totals['failCount'], `${config}: messages vs failCount`);
        assert.equal(sum(skips), totals['skipCount'], `${config}: skips vs skipCount`);
        assert.equal(
            sum(crashSignatures),
            totals['crashCount'],
            `${config}: crashSignatures vs crashCount`
        );
        // The implication that lets the two sections stay gated on length alone.
        assert.equal(skips.length === 0, totals['skipCount'] === 0, `${config}: skips`);
        assert.equal(
            crashSignatures.length === 0,
            totals['crashCount'] === 0,
            `${config}: crashSignatures`
        );
    }
});

test('the markdown report names the --config filter, for pasting into a bug', async () => {
    const { stdout } = await invoke([
        'test',
        MULTI_CONFIG_TEST,
        '--config',
        LATE_TASK_CONFIG,
        '--markdown',
    ]);
    assert.match(stdout, /Filtered: every count below covers only configurations matching /);

    const unfiltered = await invoke(['test', MULTI_CONFIG_TEST, '--markdown']);
    assert.doesNotMatch(unfiltered.stdout, /Filtered:/);
});

test('try, errors and summary refuse --config rather than ignoring it', async () => {
    // All three advertise the global flag and none can honour it: `try`
    // classifies across configurations, and the errors and stats files record no
    // job names. Accepting it returned the unfiltered answer.
    for (const argv of [
        ['try', 'abc123'],
        ['errors'],
        ['summary'],
    ]) {
        const { code, stderr } = await invoke([...argv, '--config', 'linux']);
        assert.equal(code, ExitCode.Usage, `${argv[0]} should refuse --config`);
        assert.match(stderr, /--config cannot be applied to/, argv[0]);

        const excluded = await invoke([...argv, '--exclude-config', 'debug']);
        assert.equal(excluded.code, ExitCode.Usage, `${argv[0]} should refuse --exclude-config`);
    }
});

// --- --executions ---------------------------------------------------------

test('--executions keeps the three mode states separate on xpcshell', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--executions', '--json']);
    const executions = json(stdout)['executions'] as {
        modeAxis: { failures: Record<string, number>; runs: Record<string, number> } | null;
    };
    assert.ok(executions.modeAxis !== null, 'xpcshell records a mode axis');
    const { failures, runs } = executions.modeAxis;
    assert.equal(failures['parallel'], 2, 'FAIL-PARALLEL');
    assert.equal(failures['sequential'], 2, 'FAIL-SEQUENTIAL');
    // CRASH carries no mode suffix, so its 6 runs land in `unrecorded`.
    assert.equal(failures['unrecorded'], 6);

    // The measured fact this pins: plain PASS is its own bucket, NOT the sum
    // of the two modes. 15638 parallel, 6 sequential, and 314 unsuffixed
    // passes plus 6 crashes = 320 unrecorded runs.
    assert.equal(runs['parallel'], 15_640, 'PASS-PARALLEL 15638 + FAIL-PARALLEL 2');
    assert.equal(runs['sequential'], 8, 'PASS-SEQUENTIAL 6 + FAIL-SEQUENTIAL 2');
    assert.equal(runs['unrecorded'], 320, 'PASS 314 + CRASH 6');
    assert.notEqual(
        runs['unrecorded'],
        runs['parallel']! + runs['sequential']!,
        'unrecorded must not be the sum of the other two'
    );
});

test('--executions on mochitest reports no mode axis rather than a table of zeros', async () => {
    const { code, stdout } = await invoke([
        'test',
        MOCHITEST_PATH,
        '--executions',
        '--json',
    ]);
    assert.equal(code, ExitCode.Success);
    const executions = json(stdout)['executions'] as { modeAxis: unknown };
    // FORMATS.md: the -PARALLEL/-SEQUENTIAL suffixes are xpcshell-only.
    // `null` rather than a breakdown of zeros, which would read as "measured
    // and found nothing" instead of "this harness does not record it".
    assert.equal(executions.modeAxis, null);
});

test('--executions text on mochitest says the axis is absent', async () => {
    const { stdout } = await invoke(['test', MOCHITEST_PATH, '--executions']);
    assert.match(stdout, /By execution mode: not recorded for this harness/);
    assert.match(stdout, /xpcshell-only/);
    assert.doesNotMatch(stdout, /^\s+parallel\s+0/m, 'no zero-filled mode table');
});

test('--executions text says the two blocks are not additive', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--executions']);
    assert.match(stdout, /partition the same failures two ways; they are not additive/);
});

// --- --coverage -----------------------------------------------------------

test('--coverage lists passing configs, which the default view omits', async () => {
    const { code, stdout } = await invoke(['test', TEST_PATH, '--coverage', '--json']);
    assert.equal(code, ExitCode.Success);
    const coverage = json(stdout)['coverage'] as {
        attributedPasses: boolean;
        configs: { jobName: string; state: string; passCount: number }[];
    };
    assert.equal(coverage.attributedPasses, true);
    assert.ok(
        coverage.configs.length > 1,
        'coverage must show more configs than the one that failed'
    );
    assert.ok(
        coverage.configs.some((config) => config.state === 'ok' && config.passCount > 0),
        'at least one config that only ever passed'
    );
});

test('--coverage reports a config that both ran and skipped as having run', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--coverage', '--json']);
    const coverage = json(stdout)['coverage'] as {
        configs: {
            jobName: string;
            state: string;
            runCount: number;
            skipCount: number;
            skipMessages: { message: string; count: number }[];
        }[];
    };
    // A subtlety the fixture happens to contain, and worth pinning because
    // the obvious expectation is wrong: this test is skip-if'd on android,
    // but the android configs *also* ran it on other days in the window. So
    // they are not in the `skipped` state — they ran, and they passed. The
    // skip count is carried alongside rather than instead.
    const android = coverage.configs.find((config) =>
        config.jobName.startsWith('test-android-em-14-x86_64/debug-geckoview-xpcshell')
    );
    assert.ok(android !== undefined, 'the fixture has android configs');
    assert.ok(android.runCount > 0, 'it ran');
    assert.ok(android.skipCount > 0, 'and it was skipped on other days');
    assert.equal(android.state, 'ok', 'having run and passed, it is not "skipped"');
    assert.ok(
        android.skipMessages.some((skip) => /os == 'android'/.test(skip.message)),
        'and the skip-if condition is reported'
    );

    const states = new Set(coverage.configs.map((config) => config.state));
    assert.ok(states.has('ok'));
});

test('--coverage does not label a config with 191 skips a bare "ok"', async () => {
    const { stdout } = await invoke([
        'test',
        TEST_PATH,
        '--coverage',
        '--config',
        'android',
        '--limit',
        '0',
    ]);
    // The reading this prevents: the android configs ran the test on some
    // days and were skipped on others, so `ok` is the correct *state* and a
    // skip column of 191 sits next to it. A reader takes "ok" to mean "runs
    // fine here, nothing disabled", which is the wrong conclusion drawn from
    // right data — this project's recurring failure mode.
    assert.match(stdout, /ok \+skipped/);
    for (const line of stdout.split('\n')) {
        // No row may show a non-zero skip count with an unannotated status.
        const match = /^\s+\S+\s+\d+\s+\d+\s+\d+\s+([1-9]\d*)\s+(\S.*)$/.exec(line);
        if (match !== null) {
            assert.match(
                match[2]!,
                /skipped/,
                `a row with ${match[1]} skips must say so in its status: ${line}`
            );
        }
    }
});

test('--coverage counts the states CLI.md says it distinguishes', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--coverage', '--limit', '4']);
    // Counted, not left for the reader to total by eye off a truncated table
    // — the skipped rows are the easiest to miss because they sort last.
    assert.match(stdout, /^States: \d+ ran/m);
    assert.match(stdout, /also skipped it on other days/);
});

// --- the "Scheduled on" rollup ---------------------------------------------

test('--coverage answers "does this run on <platform>" without --limit 0', async () => {
    // One row per platform the test is scheduled on, each saying what happened
    // there, at the default limit. The reader must not have to rerun with
    // `--limit 0` and total a config table by eye.
    const { stdout } = await invoke(['test', WINDOWS_ONLY_TEST, '--coverage']);
    assert.match(stdout, /^Scheduled on:$/m);
    assert.match(stdout, /^ {2}windows\s+[1-9]\d*\/\d+ ran/m);
});

test('--coverage lists no config the test was not scheduled on', async () => {
    // The design point, asserted on output. The previous version subtracted
    // the test's configs from a universe of every config in the file and
    // printed the difference — 453 rows for a browser-chrome test, all Android
    // media variants it could never have run under. Narrowing that universe
    // kept the concept; the concept is what was wrong, because there is no
    // boundary at which "things this test does not run on" stops.
    //
    // So every config named anywhere in the output must be one the data says
    // this test was scheduled on. Checked at `--limit 0`, where nothing is
    // hidden by truncation.
    const { stdout } = await invoke([
        'test',
        WINDOWS_ONLY_TEST,
        '--coverage',
        '--limit',
        '0',
    ]);
    const jsonRun = await invoke([
        'test',
        WINDOWS_ONLY_TEST,
        '--coverage',
        '--json',
    ]);
    const coverage = json(jsonRun.stdout)['coverage'] as {
        configs: { jobName: string; state: string }[];
    };
    const scheduled = new Set(coverage.configs.map((config) => config.jobName));
    assert.ok(scheduled.size > 0, 'the fixture test must be scheduled somewhere');

    const named = [...stdout.matchAll(/\btest-[\w.-]+\/[\w.-]+/g)].map((match) => match[0]!);
    assert.ok(named.length > 0, 'the output must name some configs');
    for (const jobName of named) {
        assert.ok(
            scheduled.has(jobName),
            `${jobName} is named in the output but is not a config this test ran on`
        );
    }

    // And no state names an absence. `never-scheduled` is gone from the
    // vocabulary, not merely hidden behind a limit.
    assert.doesNotMatch(stdout, /never scheduled/);
    for (const config of coverage.configs) {
        assert.notEqual(config.state, 'never-scheduled');
    }
});

test('--coverage has no row for a platform with nothing scheduled', async () => {
    // Absence is the signal. A `mac 0/0` row, or a line saying these suites do
    // not run on mac, is a claim about a config set the data does not contain
    // — and it has no stopping point: iOS would qualify equally.
    const jsonRun = await invoke(['test', WINDOWS_ONLY_TEST, '--coverage', '--json']);
    const platforms = (
        json(jsonRun.stdout)['coverage'] as {
            scheduledPlatforms: { platform: string; ranCount: number; skippedCount: number }[];
        }
    ).scheduledPlatforms;
    assert.ok(platforms.length > 0);
    for (const entry of platforms) {
        assert.ok(
            entry.ranCount + entry.skippedCount > 0,
            `${entry.platform} has a row but nothing scheduled on it`
        );
    }

    const { stdout } = await invoke(['test', WINDOWS_ONLY_TEST, '--coverage']);
    assert.doesNotMatch(stdout, /do not run on/);
    assert.doesNotMatch(stdout, /^ {2}\w+\s+0\/0 ran/m);
});

test('a platform row says how many of its configs only ever skipped', async () => {
    // The partly-disabled case, which is neither of the two easy ones: on
    // Windows this test ran on 9 configs and was scheduled-and-skipped on 2
    // more. A bare `9/11 ran` leaves the reader to work out what the other two
    // did, and "scheduled but skipped" is the half that is someone's `skip-if`.
    const { stdout } = await invoke(['test', WINDOWS_ONLY_TEST, '--coverage']);
    const row = /^ {2}windows\s+(\d+)\/(\d+) ran(.*)$/m.exec(stdout);
    assert.ok(row !== null, 'the rollup has a windows row');
    const [, ran, total, rest] = row;
    assert.ok(Number(total) > Number(ran), 'the fixture must have partly-skipped windows');
    assert.match(
        rest!,
        new RegExp(`${Number(total) - Number(ran)} scheduled but skipped`),
        `the windows row does not account for its non-running configs: ${row[0]}`
    );
});

test('--coverage counts run-if configs apart from disabled ones', async () => {
    // `not-applicable` is the third non-running state, and it is the opposite
    // of `skipped`: a `run-if` scoping the test elsewhere is the annotation
    // working, while a `skip-if` is work someone owes. Folding it into the
    // skipped count would report a correctly-scoped test as disabled on 11
    // configs.
    //
    // Driven through the `loadTimingFile` seam because `fx-tests test` always
    // reads a bucket file, and the 21-day aggregates drop `run-if` skips
    // upstream (`FORMATS.md`) — so the state exists only on a daily file and
    // the States clause was unreachable from the command's own path. A
    // mutation deleting it survived the suite until this existed.
    const { decodeDaily } = await import('../lib/formats/daily.ts');
    type DailyFile = import('../lib/formats/daily.ts').DailyFile;
    const raw = JSON.parse(
        new TextDecoder().decode(await fixtureBytes('xpcshell-2026-08-03.json'))
    ) as DailyFile;
    const decoded = decodeDaily(raw);

    const path = 'toolkit/components/extensions/test/xpcshell/test_ext_dnr_download.js';
    const { stdout } = await invoke(['test', path, '--coverage'], {
        loadTimingFile: () => Promise.resolve({ raw, decoded }),
    });
    assert.match(stdout, /^States: [^\n]*\b\d+ not applicable \(run-if\)/m);

    // And the count is the rows in that state, not a repeat of the skip count.
    const { coverageOf } = await import('../lib/query/coverage.ts');
    const identity = decoded.findTest(path)!;
    const expected = coverageOf(decoded, identity.testId).configs.filter(
        (config) => config.state === 'not-applicable'
    ).length;
    assert.ok(expected > 0, 'the fixture test must have run-if configs');
    assert.match(stdout, new RegExp(`${expected} not applicable \\(run-if\\)`));
});

test('--coverage distinguishes skipped-everywhere from not being scheduled', async () => {
    // The distinction that survives, and must: a platform where the test is
    // scheduled and disabled on every config is a `skip-if` someone owes, and
    // it looks nothing like a platform CI does not schedule it on. The first
    // gets a row saying so; the second gets no row.
    const { stdout } = await invoke(['test', WINDOWS_ONLY_TEST, '--coverage']);
    assert.match(
        stdout,
        /^ {2}android\s+0\/\d+ ran — scheduled here, but skipped on every config$/m,
        'android scheduled and skipped it, and the row has to say the "scheduled" half'
    );
});

test('--coverage JSON keeps the raw state, so the annotation is presentation only', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--coverage', '--json']);
    const coverage = json(stdout)['coverage'] as {
        configs: { state: string; runCount: number; skipCount: number }[];
    };
    const mixed = coverage.configs.filter(
        (config) => config.runCount > 0 && config.skipCount > 0
    );
    assert.ok(mixed.length > 0, 'the fixture has configs that both ran and skipped');
    for (const config of mixed) {
        // The library's state vocabulary is unchanged; only the text column
        // annotates. A consumer switching on `state` must not have to learn a
        // new value.
        assert.doesNotMatch(config.state, /\+/);
        assert.ok(['ok', 'intermittent', 'perma-fail'].includes(config.state));
    }
});

// --- "Runs on N configs across ..." in the default view --------------------

test('the default view says where the test runs, without --coverage', async () => {
    const { stdout } = await invoke(['test', TEST_PATH]);
    // CLI.md puts this directly under the verdict. Without it "no Android
    // failures" is unreadable: it could mean Android is fine, or that Android
    // never ran the test.
    assert.match(stdout, /^Runs on \d+ configs across /m);
    assert.match(stdout, /android \(\d+\)/);
});

test('the reach line is in --json too, and counts only configs that ran', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    const result = json(stdout);
    const reach = result['reach'] as {
        configCount: number;
        platforms: { platform: string; configCount: number }[];
        absentPlatforms: string[];
    };
    assert.ok(reach !== null);
    assert.ok(reach.configCount > 0);
    assert.ok(reach.platforms.length > 0);

    // Reconciliation: the reach count must equal the number of coverage rows
    // that actually ran, computed by a different path.
    const withCoverage = json(
        (await invoke(['test', TEST_PATH, '--coverage', '--json'])).stdout
    );
    const coverage = withCoverage['coverage'] as { configs: { runCount: number }[] };
    assert.equal(
        reach.configCount,
        coverage.configs.filter((config) => config.runCount > 0).length
    );
});

test('a platform the test never runs on is named, and is a measured absence', async () => {
    // The synthetic bucket has linux, windows and macOS configs, and the test
    // runs on all three, so nothing is absent. Filtering to two of them makes
    // the third absent — which exercises the set difference rather than
    // asserting a hardcoded platform list.
    const { stdout } = await invoke(
        ['test', 'dom/base/test/unit/test_permafail.js', '--json', '--config', 'linux,windows'],
        { source: permaFailSource() }
    );
    const reach = json(stdout)['reach'] as {
        platforms: { platform: string }[];
        absentPlatforms: string[];
    };
    const covered = reach.platforms.map((entry) => entry.platform);
    assert.ok(!covered.includes('mac'), 'macOS was filtered out');
    assert.deepEqual(reach.absentPlatforms, ['mac']);
});

test('the reach line points at --coverage when a platform is absent', async () => {
    const { stdout } = await invoke(
        ['test', 'dom/base/test/unit/test_permafail.js', '--config', 'linux,windows'],
        { source: permaFailSource() }
    );
    assert.match(stdout, /Runs on \d+ configs across .*— not mac; see --coverage/);
});

// --- --profiles -----------------------------------------------------------

test('--profiles emits raw artifact URLs, never profiler.firefox.com', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--profiles', '--json']);
    const profiles = json(stdout)['profiles'] as { resourceUsage: string }[];
    assert.ok(profiles.length > 0, 'the fixture test has failures with task IDs');
    for (const profile of profiles) {
        // The consumer is profiler-cli, which fetches the JSON itself; a
        // front-end URL would be useless to it.
        assert.match(profile.resourceUsage, /firefox-ci-tc\.services\.mozilla\.com/);
        assert.match(profile.resourceUsage, /profile_resource-usage\.json$/);
        assert.doesNotMatch(profile.resourceUsage, /profiler\.firefox\.com/);
        assert.doesNotMatch(profile.resourceUsage, /from-url/);
    }
});

test('--profiles emits no per-test profile URL when no message named one', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--profiles', '--json']);
    const profiles = json(stdout)['profiles'] as { testProfile?: string }[];
    // The fixture's failure messages name no uploaded profile, and CLI.md is
    // explicit: emit nothing rather than guess a filename.
    for (const profile of profiles) {
        assert.equal(profile.testProfile, undefined);
    }
});

test('--profiles text says what the list is and where per-test profiles are', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--profiles']);
    // Names the list and the command that does carry per-test profiles.
    // Claiming an absence instead read as "no profile exists" and readers
    // stopped looking.
    assert.match(stdout, /these are resource-usage profiles/);
    // `intermittent --test <path>`, not `try <rev>`: the try route needs a
    // revision, and every report of this footnote came from someone looking at
    // a trunk intermittent with no try push at all. The path is printed
    // literally so the line can be pasted — never rebuilt from the test name,
    // which `lib/links.ts` forbids and the `-2` rerun suffix would break.
    assert.match(stdout, new RegExp(`fx-tests intermittent --test ${TEST_PATH} --profiles`));
    assert.doesNotMatch(stdout, /fx-tests try <rev> --profiles/);
});

test('--profiles text omits the caveat when a per-test profile IS found', async () => {
    // The caveat prints only when nothing was extracted, so without this case
    // the tests that do carry a name would never exercise the branch.
    const { stdout } = await invoke([
        'test',
        PROFILE_NAMED_TEST,
        '--profiles',
        '--harness',
        'mochitest',
    ]);
    assert.match(stdout, /test profile:\s+https:\/\/\S+profile_test_bug551434\.html\.json/);
    assert.doesNotMatch(stdout, /these are resource-usage profiles/);
});

// --- --history, --task-ids, --durations ------------------------------------

test('--history has one row per day, oldest first, dated correctly', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--history', '--json']);
    const history = json(stdout)['history'] as { date: string; pass: number }[];
    assert.equal(history.length, 21);
    // Day 0 is the OLDEST. Reading it as "today" reverses every trend and
    // still looks plausible, which is why the ends are pinned.
    assert.equal(history[0]!.date, '2026-07-14');
    assert.equal(history[20]!.date, '2026-08-03');
});

test('--history counts sum to the totals', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--history', '--json']);
    const result = json(stdout);
    const history = result['history'] as { pass: number; fail: number; crash: number; skip: number }[];
    const totals = result['totals'] as Record<string, number>;
    const sum = (key: 'pass' | 'fail' | 'crash' | 'skip'): number =>
        history.reduce((acc, row) => acc + row[key], 0);
    // Reconciliation across two independent paths: the per-day rollup and the
    // one-pass totals. Agreeing is evidence, not tautology.
    assert.equal(sum('pass'), totals['passCount']! + totals['expectedFailCount']!);
    assert.equal(sum('fail'), totals['failCount']);
    assert.equal(sum('crash'), totals['crashCount']);
    assert.equal(sum('skip'), totals['skipCount']);
});

test('--task-ids yields one row per failing run, with the retry split off', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--task-ids', '--json']);
    const taskIds = json(stdout)['taskIds'] as {
        taskId: string;
        retryId: number;
        status: string;
    }[];
    // 4 fails + 6 crashes, each carrying task IDs in a bucket file.
    assert.equal(taskIds.length, 10);
    for (const row of taskIds) {
        assert.ok(Number.isInteger(row.retryId), 'the retry is parsed off, not left in the ID');
        assert.doesNotMatch(row.taskId, /\.\d+$/, 'the task ID must not keep its retry suffix');
    }
});

test('--durations reports a distribution ordered min <= median <= p95 <= max', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--durations', '--json']);
    const durations = json(stdout)['durations'] as {
        min: number;
        median: number;
        p95: number;
        max: number;
        runCount: number;
    }[];
    assert.ok(durations.length > 0);
    for (const row of durations) {
        assert.ok(row.min <= row.median, `min ${row.min} <= median ${row.median}`);
        assert.ok(row.median <= row.p95, `median ${row.median} <= p95 ${row.p95}`);
        assert.ok(row.p95 <= row.max, `p95 ${row.p95} <= max ${row.max}`);
        assert.ok(row.runCount > 0);
    }
});

// --- the flat-counts hint, and the bugs naming this test -------------------

test('the default view points at --history when the daily counts are not flat', async () => {
    const { stdout } = await invoke(['test', TEST_PATH]);
    // The default view has no time axis, so a failure that started last Tuesday
    // and one that has been there three weeks read identically. This is the
    // line that separates them, and it is the only pointer to `--history`
    // anywhere in the command's own output.
    assert.match(stdout, /Daily counts are not flat; --history shows the per-day breakdown\./);
});

test('the flat-counts hint is a reading of the same rows --history prints', async () => {
    // Not a second per-day tally: the hint and the table are one computation,
    // so they cannot disagree about which day was the outlier.
    const { stdout } = await invoke(['test', TEST_PATH, '--history', '--json']);
    const result = json(stdout);
    const history = result['history'] as { fail: number; timeout: number; crash: number }[];
    const counts = history.map((row) => row.fail + row.timeout + row.crash);
    const sorted = [...counts].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median =
        sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    // Zero-run days are in the median on purpose: a test that stopped running,
    // or only started on Friday, is exactly the discontinuity the hint exists
    // to advertise, and excluding those days would hide it.
    const flat =
        median === 0 ? false : counts.every((c) => c <= median * 10 && c * 10 >= median);
    assert.equal(result['dailyCountsAreFlat'], flat);
});

test('a test with no failures at all is neither flat nor not flat', async () => {
    // `null`, not `true`: "the counts are level" and "there are no counts" are
    // different claims, and only one of them is worth a line of output.
    const args = ['test', MULTI_CONFIG_TEST, '--config', CLEAN_CONFIG];
    const { stdout } = await invoke([...args, '--json']);
    const result = json(stdout);
    assert.equal((result['totals'] as Record<string, number>)['failCount'], 0);
    assert.equal(result['dailyCountsAreFlat'], null);
    const { stdout: text } = await invoke(args);
    assert.doesNotMatch(text, /Daily counts are not flat/);
});

/** A ranking in which two of three bugs name `TEST_PATH`. */
function bugNamingClient(): NonNullable<Parameters<typeof run>[0]['intermittents']> {
    return {
        rankBugs: () =>
            Promise.resolve([
                { bugId: 2063582, count: 252 },
                { bugId: 2059110, count: 12 },
                { bugId: 1, count: 999 },
            ]),
        occurrencesOfBug: () => Promise.resolve([]),
        runIdsOfJobs: () => Promise.resolve(new Map()),
        bugSummaries: () =>
            Promise.resolve(
                new Map([
                    [2063582, `Intermittent ${TEST_PATH} | single tracking bug`],
                    [2059110, `Intermittent ${TEST_PATH} | application terminated`],
                    [1, 'Intermittent some/other/test.js | unrelated'],
                ])
            ),
    };
}

test('the default path makes no intermittents request at all', async () => {
    // The load-bearing assertion of the whole flag. `test` is run constantly,
    // and resolving the annotations by default put traffic on the machines
    // serving Treeherder's API that they did not previously carry — a cost no
    // local cache gives back, because it is per user rather than per run.
    //
    // Asserted rather than assumed: `silentIntermittents()` throws on every
    // method, and `fetchAnnotatedBugs` catches, so a regression here would be
    // invisible if the client returned empty results instead. The whole default
    // view is rendered, so a request anywhere in it would fail this.
    const { code, stdout, stderr } = await invoke(['test', TEST_PATH]);
    assert.equal(code, ExitCode.Success);
    assert.doesNotMatch(stderr, /should make no live request/);
    assert.doesNotMatch(stdout, /Bugs naming this test/);
    // The flags that read the same published file must stay quiet too.
    for (const flag of ['--coverage', '--history', '--task-ids', '--durations', '--executions']) {
        const withFlag = await invoke(['test', TEST_PATH, flag]);
        assert.equal(withFlag.code, ExitCode.Success, `${flag} exited ${withFlag.code}`);
        assert.doesNotMatch(withFlag.stderr, /should make no live request/, flag);
    }
});

test('--bugs is what asks, and the default leaves the field null', async () => {
    const quiet = await invoke(['test', TEST_PATH, '--json']);
    // The key is *absent*, not `null`. Both `null` and `[]` read as "no bugs"
    // at a glance, and `null` is the more natural spelling of it, so it
    // suggested the opposite of what it meant. Absence cannot be misread.
    assert.ok(
        !('annotatedBugs' in json(quiet.stdout)),
        'the default output must omit annotatedBugs, not set it to null'
    );

    const asked = await invoke(['test', TEST_PATH, '--bugs', '--json'], {
        intermittents: bugNamingClient(),
    });
    const bugs = json(asked.stdout)['annotatedBugs'] as {
        bugId: number;
        bugSummary: string;
    }[];
    assert.deepEqual(bugs.map((bug) => bug.bugId), [2063582, 2059110]);
    // The summaries are paid for — resolving which bugs name the test means
    // reading them — so they are carried through rather than discarded. The
    // triage prefix and the path are stripped, leaving what the caller did not
    // already type.
    assert.deepEqual(bugs.map((bug) => bug.bugSummary), [
        'single tracking bug',
        'application terminated',
    ]);
});

test('the bugs naming this test come from the intermittent ranking', async () => {
    // Item 10: the first question anyone asks about a failing test, and until
    // now the only way to answer it was to pull the whole ranking as JSON and
    // grep it. Resolved through `bugsNamingTest`, the same lookup
    // `intermittent --test` uses — a second resolver is the failure this is
    // meant to prevent.
    const { stdout } = await invoke(['test', TEST_PATH, '--bugs'], {
        intermittents: bugNamingClient(),
    });
    assert.match(stdout, /^Bugs naming this test$/m);
    // A block, not a line: more than one bug can name one test, and picking
    // the largest would hide the one the reader did not get.
    assert.match(stdout, /2063582\s+252 annotations, last 7 days\s+fx-tests intermittent --bug 2063582/);
    assert.match(stdout, /2059110\s+12 annotations, last 7 days\s+fx-tests intermittent --bug 2059110/);
    // The summary, on its own line under each bug. Without it a reader has to
    // run the suggested command just to learn what the bug is — a second
    // command, and a second full ranking fetch, for data already in hand.
    assert.match(stdout, /^ +single tracking bug$/m);
    assert.match(stdout, /^ +application terminated$/m);
    // The bug naming a different test is not in the block.
    assert.doesNotMatch(stdout, /fx-tests intermittent --bug 1$/m);
});

test('a long bug summary is truncated, not wrapped', async () => {
    // Truncation rather than wrapping is a deliberate split from
    // `intermittent --bug`, whose headline wraps because there the summary *is*
    // the content. Here it is one row among several and the reader is scanning
    // bug numbers, so a summary must not push the next bug off the screen.
    const long = 'x'.repeat(400);
    const client = () => ({
        rankBugs: () => Promise.resolve([{ bugId: 42, count: 7 }]),
        occurrencesOfBug: () => Promise.resolve([]),
        runIdsOfJobs: () => Promise.resolve(new Map<number, number>()),
        bugSummaries: () =>
            Promise.resolve(new Map([[42, `Intermittent ${TEST_PATH} | ${long}`]])),
    });
    const summaryOf = (stdout: string): string | undefined =>
        stdout.split('\n').find((line) => line.includes('xxx'));

    const { stdout } = await invoke(['test', TEST_PATH, '--bugs'], {
        intermittents: client(),
    });
    assert.match(stdout, /Bugs naming this test/);
    const cut = summaryOf(stdout);
    assert.ok(cut !== undefined, 'the summary line should be printed');
    // Cut with an ellipsis, and onto one line — never re-flowed across several.
    assert.match(cut, /…$/);
    assert.ok(cut.length < long.length, `the summary should be cut, got ${cut.length}`);

    // `--full-messages` opts out, as it does everywhere else. Pinned because
    // the first version of this test passed the flag by mistake and read the
    // uncut output as a truncation bug — the flag was working.
    const full = await invoke(['test', TEST_PATH, '--bugs', '--full-messages'], {
        intermittents: client(),
    });
    const whole = summaryOf(full.stdout);
    assert.ok(whole !== undefined && whole.includes(long), '--full-messages must not cut');
});

test('no block is printed when no annotated bug names the test', async () => {
    // "Print nothing", per the spec — not "no bugs found", which reads as a
    // measurement and would be one more line on every healthy test. Asked for
    // here, so this is the empty *answer* rather than the unasked default.
    const { stdout } = await invoke(['test', TEST_PATH, '--bugs'], {
        intermittents: {
            rankBugs: () => Promise.resolve([{ bugId: 1, count: 999 }]),
            occurrencesOfBug: () => Promise.resolve([]),
            runIdsOfJobs: () => Promise.resolve(new Map()),
            bugSummaries: () =>
                Promise.resolve(new Map([[1, 'Intermittent some/other/test.js | unrelated']])),
        },
    });
    assert.doesNotMatch(stdout, /Bugs naming this test/);
});

test('a Treeherder outage costs the bug block, not the whole answer', async () => {
    // Everything else `test` prints comes from a published file. Exiting 3
    // because a live API is down would lose an answer the command already had.
    const { code, stdout, stderr } = await invoke(['test', TEST_PATH, '--bugs', '--json'], {
        intermittents: {
            rankBugs: () => Promise.reject(new Error('treeherder is down')),
            occurrencesOfBug: () => Promise.resolve([]),
            runIdsOfJobs: () => Promise.resolve(new Map()),
            bugSummaries: () => Promise.resolve(new Map()),
        },
    });
    assert.equal(code, ExitCode.Success);
    // Three states, all distinguishable: `null` is nobody asked, `[]` is asked
    // and nothing names it, `{ error }` is asked and could not be answered.
    // Collapsing the last two would report a healthy test during an outage.
    assert.deepEqual(json(stdout)['annotatedBugs'], { error: 'treeherder is down' });
    assert.match(stderr, /treeherder is down/);
});

// --- limits and truncation -------------------------------------------------

test('a truncated list says how much it cut and how to see it all', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--coverage', '--limit', '2']);
    assert.match(stdout, /… \d+ more \(--limit 0 for all\)/);
});

test('--limit 0 means no limit', async () => {
    const limited = await invoke(['test', TEST_PATH, '--coverage', '--limit', '2']);
    const all = await invoke(['test', TEST_PATH, '--coverage', '--limit', '0']);
    assert.match(limited.stdout, /… \d+ more/);
    assert.doesNotMatch(all.stdout, /… \d+ more \(--limit 0 for all\)/);
    assert.ok(all.stdout.length > limited.stdout.length);
});

// --- output stream discipline ---------------------------------------------

test('progress goes to stderr so stdout stays pipeable', async () => {
    const { stdout, stderr } = await invoke(['test', TEST_PATH, '--json']);
    // stdout must parse as JSON on its own — this is the `| jq` contract.
    assert.doesNotThrow(() => JSON.parse(stdout));
    assert.match(stderr, /Looking up dom\/indexedDB/);
});

test('--quiet suppresses progress but keeps the data', async () => {
    const { stdout, stderr } = await invoke(['test', TEST_PATH, '--json', '--quiet']);
    assert.equal(stderr, '');
    assert.doesNotThrow(() => JSON.parse(stdout));
});

/**
 * An agent harness merges stdout and stderr into the transcript, so progress
 * written to stderr still ends up in the model's context, and an agent has no
 * way to know to pass `--quiet` on its first call. Each of the four variables
 * is asserted separately: a helper reading only `CLAUDECODE` would pass a test
 * that named the set in a comment.
 */
for (const variable of ['CLAUDECODE', 'CODEX_SANDBOX', 'GEMINI_CLI', 'OPENCODE']) {
    test(`${variable} suppresses progress without --quiet`, async () => {
        const { stdout, stderr } = await invoke(['test', TEST_PATH, '--json'], {
            env: { [variable]: '1' },
        });
        assert.equal(stderr, '');
        assert.doesNotThrow(() => JSON.parse(stdout));
    });
}

/**
 * `0` is how a caller turns a variable off, so reading it as "on" would take
 * progress away with no way to guess which variable did it. This diverges from
 * the presence-based Python snippet on purpose — see `isAgentCaller`.
 */
for (const value of ['', '0']) {
    test(`CLAUDECODE=${JSON.stringify(value)} does not make a caller an agent`, async () => {
        const { stderr } = await invoke(['test', TEST_PATH, '--json'], {
            env: { CLAUDECODE: value },
        });
        assert.notEqual(stderr, '', 'progress must still reach stderr');
    });
}

test('--progress asks for progress back in an agent environment', async () => {
    const { stdout, stderr } = await invoke(['test', TEST_PATH, '--json', '--progress'], {
        env: { CLAUDECODE: '1' },
    });
    assert.notEqual(stderr, '', 'progress must reach stderr');
    assert.doesNotThrow(() => JSON.parse(stdout));
});

test('--quiet still wins over --progress', async () => {
    const { stderr } = await invoke(['test', TEST_PATH, '--json', '--quiet', '--progress'], {
        env: { CLAUDECODE: '1' },
    });
    assert.equal(stderr, '');
});

/**
 * The suppression has to hold in **every** command, and asserting that per
 * command would mean one test per command that nobody adds for the next one.
 *
 * What makes it hold instead is that every progress line goes through
 * `progress()` or `wantsProgress()`. So this scans the CLI sources for the
 * writes that bypass both: a `streams.err` call whose text is not a warning and
 * not an error. `cli/main.ts`'s two gated call sites are the allowed exception,
 * recognised by a `wantsProgress` in the enclosing function.
 *
 * **The file list is read from disk, not written here.** A hand-maintained copy
 * would match `cli/commands/` only by coincidence of timing, and a command
 * added afterwards would be unscanned — which is the one regression this exists
 * to catch. `cli/main.ts`'s `COMMAND_NAMES` carries the same warning for the
 * same reason. Enumerating goes further than `COMMAND_NAMES` here: a file that
 * is present but not yet wired into the command table is still scanned, and it
 * can still be imported and still leak.
 *
 * **Aliasing defeats the scan**, and knowingly: `const { err } = context.streams`
 * followed by a bare `err(…)` is matched via the alias case below, but an alias
 * under any other name, or a stream passed into a helper as a parameter, is not
 * detectable by a regex. That is accepted rather than papered over — this guard
 * is a backstop against the ordinary way of writing the mistake, and the
 * behavioural tests above are what actually pin the behaviour.
 */
test('no command writes progress past the agent check', async () => {
    const cliDir = new URL('../cli/', import.meta.url);
    const commandsDir = new URL('commands/', cliDir);
    const sources: string[] = [];
    for (const [dir, prefix] of [
        [cliDir, 'cli'],
        [commandsDir, 'cli/commands'],
    ] as const) {
        for (const entry of await readdir(dir)) {
            if (entry.endsWith('.ts')) {
                sources.push(`${prefix}/${entry}`);
            }
        }
    }
    // The enumeration must not silently come back empty or short, or the whole
    // guard passes by scanning nothing. Checked against the command table with
    // a name-by-name lookup rather than a count: `issues.ts` implements four of
    // the commands (`issues`, `failures`, `crashes`, `skips`) and `crash.ts`
    // one more, so there are legitimately fewer files than commands.
    for (const name of COMMAND_NAMES) {
        const covered =
            sources.includes(`cli/commands/${name}.ts`) ||
            // The commands whose implementation shares a sibling's file.
            ['failures', 'crashes', 'skips'].includes(name);
        assert.ok(covered, `no source enumerated for the ${name} command`);
    }
    assert.ok(
        sources.includes('cli/main.ts') && sources.includes('cli/commands/issues.ts'),
        `enumeration missed a known file: ${sources.join(', ')}`
    );

    const offenders: string[] = [];
    for (const path of sources) {
        // `cli/context.ts` defines the sinks themselves — `progress()` gated on
        // `wantsProgress`, `warn()` and `notice()` deliberately ungated. Their
        // bodies are the mechanism, not a bypass of it.
        if (path === 'cli/context.ts') {
            continue;
        }
        const text = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
        const lines = text.split('\n');
        // `const { err } = context.streams` — after this, a bare `err(…)` in the
        // same file writes to stderr without naming the stream.
        const aliased = /(?:const|let)\s*\{[^}]*\berr\b[^}]*\}\s*=\s*\S*streams/.test(text);
        for (const [index, line] of lines.entries()) {
            const writes =
                line.includes('streams.err(') || (aliased && /(?:^|[^.\w])err\(/.test(line));
            // `err(text: string): void` is the declaration of the sink, not a
            // write to it.
            if (!writes || /\berr\([^)]*:\s*string/.test(line)) {
                continue;
            }
            // A warning or an error is not progress and is meant to get out.
            if (/warning: |fx-tests: |\$\{error\.hint\}/.test(line)) {
                continue;
            }
            // A gated progress writer. The gate is somewhere in the enclosing
            // function, not on the same line: `buildSource` decides whether to
            // pass the callback at all, and `reportArtifactCacheUse` returns
            // early. So the scan is from the function's opening line, found by
            // walking back to the last line starting in column 0.
            let start = index;
            while (start > 0 && /^[\s})]/.test(lines[start]!)) {
                start--;
            }
            if (lines.slice(start, index + 1).join('\n').includes('wantsProgress')) {
                continue;
            }
            offenders.push(`${path}:${index + 1}: ${line.trim()}`);
        }
    }
    assert.deepEqual(
        offenders,
        [],
        'these write to stderr without going through progress()/wantsProgress(); ' +
            'an agent caller would see them'
    );
});

// --- markdown -------------------------------------------------------------

test('markdown escapes a pipe in a message rather than splitting the row', async () => {
    const { code, stdout } = await invoke(['test', TEST_PATH, '--markdown']);
    assert.equal(code, ExitCode.Success);
    assert.match(stdout, /^\| /m, 'a Markdown table is emitted');
    // Every table row must have a consistent column count; an unescaped `|`
    // in a message is what breaks that, and it renders without complaint.
    for (const line of stdout.split('\n')) {
        if (!line.startsWith('|')) {
            continue;
        }
        const unescaped = line.replace(/\\\|/g, '');
        assert.ok(unescaped.split('|').length >= 3, `malformed row: ${line}`);
    }
});

test('percent() renders "no rate to state" as a dash, never as 0%', async () => {
    // `null` and `0` are different claims: "too few runs to say" against "no
    // failures". config-stats.ts returns `null` deliberately for the first,
    // and collapsing it to 0.0% in the formatter throws that away at the last
    // step — a column of confident zeroes for configs that were never
    // measured. A mutation removing the null branch survived the suite.
    const { percent } = await import('../cli/format/text.ts');
    assert.equal(percent(null), '—');
    assert.equal(percent(undefined), '—');
    assert.equal(percent(0), '0.0%');
    assert.notEqual(percent(null), percent(0), 'null must not render like zero');
    assert.equal(percent(8.14), '8.1%');
    assert.equal(percent(8.14, 2), '8.14%');
});

test('a config with too few recent runs prints a dash rather than 0.0%', async () => {
    const { stdout } = await invoke(['test', TEST_PATH, '--json']);
    const configs = json(stdout)['configs'] as { recentFailRate: number | null }[];
    // The JSON keeps `null`; the text column must not turn it into a number.
    // Whether the fixture has such a config depends on the window, so this
    // asserts the mapping rather than requiring one to exist.
    const { percent } = await import('../cli/format/text.ts');
    for (const config of configs) {
        const cell = percent(config.recentFailRate);
        if (config.recentFailRate === null) {
            assert.equal(cell, '—');
        } else {
            assert.match(cell, /^\d+\.\d%$/);
        }
    }
});

test('truncate() cuts to the width and marks the cut', async () => {
    // CLI.md's frugality rule has two halves — fewer rows, and a truncated
    // message column — and only the row half was tested. A no-op `truncate`
    // survived: the fixture messages are short enough that nothing visibly
    // changed, so the guard has to be asserted on its own.
    const { truncate } = await import('../cli/format/text.ts');
    assert.equal(truncate('short', 10), 'short');
    assert.equal(truncate('exactlyten', 10), 'exactlyten');
    const cut = truncate('a message far longer than the column', 10);
    assert.equal(cut.length, 10, 'the result never exceeds the width');
    assert.ok(cut.endsWith('…'), `the cut must be visible: ${cut}`);
    assert.equal(cut, 'a message…');
    // 0 means "no limit", matching --limit 0.
    assert.equal(truncate('unbounded', 0), 'unbounded');
});

test('truncatePath() drops leading directories, never the filename', async () => {
    // The bug: `truncate()` on a path cuts the basename, which is the only part
    // that identifies a test, so the output could not be pasted into
    // `fx-tests test` or grepped for. Every assertion here is about the
    // basename surviving.
    const { truncatePath } = await import('../cli/format/text.ts');
    const path = 'browser/extensions/formautofill/test/browser/browser_ml_heuristics.js';

    assert.equal(truncatePath(path, 200), path, 'a path that fits is untouched');
    assert.equal(truncatePath('a/b.js', 0), 'a/b.js', '0 means no limit');

    // Every width that shortens the 69-character path but can still hold its
    // 24-character basename must keep that basename whole.
    for (const width of [30, 45, 60, 68]) {
        const cut = truncatePath(path, width);
        assert.ok(cut.length <= width, `${width}: ${cut.length} chars is over budget`);
        assert.ok(
            cut.endsWith('browser_ml_heuristics.js'),
            `${width}: the filename must survive, got ${cut}`
        );
        assert.ok(cut.startsWith('…'), `${width}: the cut must be visible, got ${cut}`);
    }

    // Whole segments, so the result is still a readable path fragment.
    assert.equal(truncatePath(path, 45), '…/test/browser/browser_ml_heuristics.js');

    // The `…/` prefix is part of the budget. `formautofill/test/browser/…` is
    // 50 characters, so it fits behind the prefix at 52 and not at 51 — the
    // boundary that says the two prefix characters are counted against it.
    assert.equal(
        truncatePath(path, 52),
        '…/formautofill/test/browser/browser_ml_heuristics.js'
    );
    assert.equal(truncatePath(path, 52).length, 52);
    assert.equal(truncatePath(path, 51), '…/test/browser/browser_ml_heuristics.js');

    // A basename that does not fit on its own keeps its *tail*: neighbouring
    // tests differ at the end (`…_forms.html` vs `…_form.html`), so cutting
    // the tail here would make them identical.
    const long = 'dom/test/test_a_very_long_file_name_indeed.html';
    const tiny = truncatePath(long, 12);
    assert.ok(tiny.length <= 12);
    assert.ok(tiny.endsWith('.html'), `the distinguishing tail survives: ${tiny}`);
});

test('the try test column truncates paths from the left', async () => {
    // End to end: the column is the thing the owner reported as unusable, and a
    // unit test on `truncatePath` alone would not catch the column forgetting
    // to opt in with `path: true`.
    //
    // It has to be a *compact* section, since only those render a table —
    // PERMA-FAILS prints each path on its own line and never truncates. Two
    // runs of one config with a pass among them puts it in an intermittent
    // section, whatever central says.
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            job('test-linux/opt-mochitest-plain', 'TASK1', 'testfailed'),
            job('test-linux/opt-mochitest-plain', 'TASK2', 'success'),
        ]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const basename = MOCHITEST_PATH.slice(MOCHITEST_PATH.lastIndexOf('/') + 1);
    // The table *row*, not merely the output: any full-path footer below the
    // table would also contain the basename, so asserting on the whole of
    // stdout would pass with the column still cutting the filename off.
    const row = streams.stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.includes('…/') || line.includes(MOCHITEST_PATH));
    assert.ok(row !== undefined, 'expected the test to appear as a table row');
    // Found by shape rather than by column index: the row leads with the
    // failure-count column now, and hardcoding "cell 0" would silently start
    // asserting about a number the moment another column is added.
    const cell = (row.split(/\s{2,}/).find(
        (part) => part.startsWith('…/') || part === MOCHITEST_PATH
    ) ?? '');
    // The column sizes itself to the paths it is given, so this 73-character
    // path — which the old hardcoded 60 would have cut — now appears whole. If
    // a path ever does exceed the cap the cut comes off the front, so either
    // way the filename survives and the value stays copyable.
    assert.ok(
        cell === MOCHITEST_PATH || cell.startsWith('…/'),
        `the path is whole, or cut at the front: ${cell}`
    );
    assert.ok(
        cell.endsWith(basename),
        `the filename must survive in the table row: ${cell}`
    );
    // And the full path is present, so it can be copied into the next command.
    // That is the whole purpose of the output.
    assert.ok(
        streams.stdout.includes(MOCHITEST_PATH),
        'the full path must be obtainable from the default output'
    );
});

test('a long failure message is truncated in the text table', async () => {
    // End to end, with a message the fixture does not have: built through the
    // try path, which is where a real stack-trace-bearing message arrives.
    const streams = captureStreams();
    const longMessage = `LEADING ${'x'.repeat(400)} TRAILING`;
    // Pinned: truncation follows `COLUMNS`, so the assertions below would
    // otherwise depend on the terminal the suite runs in.
    const previousColumns = process.env['COLUMNS'];
    process.env['COLUMNS'] = '90';
    await run({
        argv: ['try', 'abcdef123456'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: longMessage, start: 1, end: 2 },
            ]),
        }),
    });
    if (previousColumns === undefined) {
        delete process.env['COLUMNS'];
    } else {
        process.env['COLUMNS'] = previousColumns;
    }
    assert.match(streams.stdout, /LEADING/, 'the start of the message survives');
    assert.doesNotMatch(streams.stdout, /TRAILING/, 'the end is cut');
    assert.match(streams.stdout, /…/, 'and the cut is marked');
    for (const line of streams.stdout.split('\n')) {
        assert.ok(line.length < 300, `no line may run away: ${line.length} chars`);
    }
});

test('truncation follows COLUMNS in text, and never applies to markdown', async () => {
    const longMessage = `LEADING ${'x'.repeat(400)} TRAILING`;
    const runWith = async (argv: string[], columns: string | undefined): Promise<string> => {
        const previous = process.env['COLUMNS'];
        if (columns === undefined) {
            delete process.env['COLUMNS'];
        } else {
            process.env['COLUMNS'] = columns;
        }
        const streams = captureStreams();
        await run({
            argv,
            streams,
            source: fixtureSource(),
            cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
            treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
            fetchUrl: profileFetcher({
                TASK1: profileWith([
                    {
                        type: 'Test',
                        test: TEST_PATH,
                        status: 'FAIL',
                        message: longMessage,
                        start: 1,
                        end: 2,
                    },
                ]),
            }),
        });
        if (previous === undefined) {
            delete process.env['COLUMNS'];
        } else {
            process.env['COLUMNS'] = previous;
        }
        return streams.stdout;
    };

    const narrow = await runWith(['try', 'abcdef123456'], '90');
    const wide = await runWith(['try', 'abcdef123456'], '400');
    // The longest run of `x`, not the first: the output contains unrelated
    // single `x` characters and matching those measures nothing.
    const kept = (out: string): number =>
        Math.max(0, ...[...out.matchAll(/x+/g)].map((match) => match[0].length));
    assert.ok(kept(narrow) > 0, 'the narrow run must still show part of the message');
    assert.ok(
        kept(wide) > kept(narrow),
        `COLUMNS must widen the message: ${kept(narrow)} at 90 vs ${kept(wide)} at 400`
    );

    for (const argv of [
        ['try', 'abcdef123456', '--full-messages'],
        ['try', 'abcdef123456', '--markdown'],
    ]) {
        const out = await runWith(argv, '90');
        assert.match(out, /TRAILING/, `${argv.join(' ')} must not cut the message`);
    }
});

test('markdown also states what a truncated list left out', async () => {
    const md = await import('../cli/format/markdown.ts');
    // Every format has to say a list is partial, not just the text one.
    assert.equal(md.moreLine(5, 5), null);
    assert.equal(md.moreLine(5, 7), null);
    const line = md.moreLine(50, 3);
    assert.ok(line !== null);
    assert.match(line, /47 more/);
    assert.match(line, /--limit 0/);
});

test('serializing a Map or Set throws rather than emitting {}', async () => {
    // A safety net with no live trigger today: every command already converts
    // its Maps before emitting, so a mutation disabling this guard survives
    // the end-to-end tests. It is tested directly because the thing it
    // prevents is silent — JSON.stringify turns both into {}, so the output
    // parses, validates as an object, and is empty. That is the failure mode
    // this project keeps finding, and the guard is what makes it a crash at
    // development time instead.
    const { toJson, mapToObject } = await import('../cli/format/json.ts');
    assert.throws(
        () => toJson({ counts: new Map([['a', 1]]) }),
        /refusing to serialize a Map at "counts"/
    );
    assert.throws(
        () => toJson({ seen: new Set(['a']) }),
        /refusing to serialize a Set at "seen"/
    );
    // An empty Map is the worst case: `{}` is indistinguishable from a field
    // that legitimately has no entries, so it must throw too.
    assert.throws(() => toJson({ counts: new Map() }), /refusing to serialize a Map/);

    // And the conversion helper it points at works.
    assert.equal(toJson({ counts: mapToObject(new Map([['a', 1]])) }), '{\n  "counts": {\n    "a": 1\n  }\n}');
});

test('markdown escaping is exercised directly, since no fixture message has a pipe', async () => {
    // The end-to-end markdown test above cannot catch a broken escaper:
    // measured, zero of the 13 messages in either bucket fixture contain a
    // `|`, so the escaping branch never runs on fixture data. A mutation
    // removing the pipe replacement survived the suite until this test.
    const md = await import('../cli/format/markdown.ts');
    assert.equal(md.escapeCell('a|b'), 'a\\|b');
    assert.equal(md.escapeCell('line1\nline2'), 'line1<br>line2');
    assert.equal(md.escapeCell('line1\r\nline2'), 'line1<br>line2');
    assert.equal(md.escapeCell('back\\slash'), 'back\\\\slash');

    // And the property that matters: a cell can never introduce a column.
    const row = md.table(
        [{ header: 'a' }, { header: 'b' }],
        [['x|y', 'plain']]
    );
    const body = row[2]!;
    assert.equal(
        body.replace(/\\\|/g, '').split('|').length,
        4,
        `an escaped cell must not add a column: ${body}`
    );
});

test('harness inference follows detectHarness for every rule, including the hole', async () => {
    // Table-driven because the end-to-end tests only reach two of the four
    // branches, and a mutation deleting the `test_*.html` rule survived them.
    const { detectHarness } = await import('../cli/options.ts');
    const cases: [string, string][] = [
        ['browser/base/content/test/browser_foo.js', 'mochitest'],
        ['dom/base/test/test_selection.html', 'mochitest'],
        // The documented hole: a mochitest-plain `test_foo.js` is
        // misclassified as xpcshell. Asserted deliberately — the CLI must
        // agree with common-test-data.js:9 rather than improve on it, and
        // step 2 of the resolution ladder is what covers it.
        ['dom/base/test/test_foo.js', 'xpcshell'],
        ['netwerk/test/unit/test_bug1195415.js', 'xpcshell'],
        ['some/dir/browser_foo.html', 'xpcshell'],
        ['no_prefix.js', 'xpcshell'],
        ['test_at_root.html', 'mochitest'],
    ];
    for (const [path, expected] of cases) {
        assert.equal(detectHarness(path), expected, path);
    }
});

// --- summary --------------------------------------------------------------

test('summary reports both harnesses with rates and a prior-period delta', async () => {
    const { code, stdout } = await invoke(['summary', '--json']);
    assert.equal(code, ExitCode.Success);
    const harnesses = json(stdout)['harnesses'] as {
        harness: string;
        current: Record<string, number>;
        prior: Record<string, number> | null;
        delta: Record<string, number | null>;
    }[];
    assert.deepEqual(
        harnesses.map((entry) => entry.harness),
        ['xpcshell', 'mochitest']
    );
    for (const entry of harnesses) {
        assert.equal(entry.current['dayCount'], 7, 'the default period is 7 days');
        assert.ok(entry.current['testFailureRate']! >= 0);
        assert.ok(entry.prior !== null, 'the stats fixtures reach back far enough');
        // A delta in percentage points, so a rate moving 0.42 -> 0.50 is 0.08.
        assert.equal(
            Math.abs(
                entry.delta['testFailureRate']! -
                    (entry.current['testFailureRate']! - entry.prior['testFailureRate']!)
            ) < 1e-9,
            true
        );
    }
});

test('summary --harness reads only that harness', async () => {
    const { stdout, source } = await invoke(['summary', '--harness', 'xpcshell', '--json']);
    const harnesses = json(stdout)['harnesses'] as { harness: string }[];
    assert.equal(harnesses.length, 1);
    assert.deepEqual(source.requested, ['xpcshell-timings/xpcshell-stats.json']);
});

test('summary --days rejects zero', async () => {
    const { code, stderr } = await invoke(['summary', '--days', '0']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /at least 1/);
});

test('summary takes no positional argument', async () => {
    const { code, stderr } = await invoke(['summary', 'xpcshell']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /takes no arguments/);
});

// --- dates ----------------------------------------------------------------

test('dates reports the window ends the right way round', async () => {
    const { code, stdout } = await invoke(['dates', '--harness', 'xpcshell', '--json']);
    assert.equal(code, ExitCode.Success);
    const entry = (json(stdout)['harnesses'] as {
        dates: string[];
        oldest: string;
        newest: string;
        dayCount: number;
    }[])[0]!;
    assert.equal(entry.dayCount, 21);
    // index.json is newest first, unlike stats.json. Getting this backwards
    // reports the window inverted and still looks like a date range.
    assert.equal(entry.newest, '2026-08-03');
    assert.equal(entry.oldest, '2026-07-14');
    assert.equal(entry.dates[0], '2026-08-03');
});

test('dates marks weekend days', async () => {
    const { stdout } = await invoke(['dates', '--harness', 'xpcshell']);
    assert.match(stdout, /2026-08-02 \(Sun\)\s+— weekend/);
    assert.match(stdout, /2026-08-03 \(Mon\)$/m);
});

// --- cache ----------------------------------------------------------------

test('the cache keys on the file name, so two files do not share an entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fx-tests-cache-'));
    try {
        const cache = diskCache({ directory });
        const { cachedSource } = await import('../cli/cache.ts');
        const source = fixtureSource();
        const wrapped = cachedSource(source, cache);
        const streams = captureStreams();
        // Both harnesses, so two different files go through one cache. A
        // constant cache key passes every single-file test — the entry is
        // written and read back correctly — and only shows up as one file
        // being served in place of another.
        await run({ argv: ['summary', '--json'], streams, source: wrapped, cache });
        const entries = await cache.list();
        assert.equal(entries.length, 2, 'two files must occupy two entries');
        assert.deepEqual(
            entries.map((entry) => entry.key).sort(),
            [
                'mochitest-timings/mochitest-stats.json',
                'xpcshell-timings/xpcshell-stats.json',
            ]
        );

        // And the consequence that matters: a second run served entirely from
        // cache must still report each harness's own numbers. Under a shared
        // key one of them silently becomes a copy of the other.
        const first = json(streams.stdout);
        const warmStreams = captureStreams();
        await run({ argv: ['summary', '--json'], streams: warmStreams, source: wrapped, cache });
        assert.equal(source.requested.length, 2, 'the warm run fetched nothing');
        const second = json(warmStreams.stdout);
        assert.deepEqual(second, first, 'the cached answer matches the fetched one');
        const harnesses = second['harnesses'] as { harness: string; current: Record<string, number> }[];
        assert.notDeepEqual(
            harnesses[0]!.current,
            harnesses[1]!.current,
            'xpcshell and mochitest must not report identical numbers'
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('the cache serves a second read with no further fetch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fx-tests-cache-'));
    try {
        const cache = diskCache({ directory });
        const source = fixtureSource();
        const streams = captureStreams();
        // Two runs against a cache-wrapped source: the second must not reach
        // the inner source at all. This is CLI.md's "a warm run should need no
        // network".
        const { cachedSource } = await import('../cli/cache.ts');
        const wrapped = cachedSource(source, cache);
        await run({ argv: ['summary', '--harness', 'xpcshell', '--json'], streams, source: wrapped, cache });
        assert.equal(source.requested.length, 1);
        await run({ argv: ['summary', '--harness', 'xpcshell', '--json'], streams, source: wrapped, cache });
        assert.equal(source.requested.length, 1, 'the second run must fetch nothing');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('the cache records the file’s own generatedAt, not the fetch time', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fx-tests-cache-'));
    try {
        const cache = diskCache({ directory });
        const { cachedSource } = await import('../cli/cache.ts');
        const wrapped = cachedSource(fixtureSource(), cache);
        const streams = captureStreams();
        await run({ argv: ['summary', '--harness', 'xpcshell', '--json'], streams, source: wrapped, cache });
        const entries = await cache.list();
        assert.equal(entries.length, 1);
        // Read out of the payload, so a file re-fetched today but generated
        // last night reports last night — which is the question a surprising
        // number raises.
        assert.match(entries[0]!.generatedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
        assert.notEqual(entries[0]!.generatedAt, entries[0]!.fetchedAt);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('an expired cache entry is re-fetched', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fx-tests-cache-'));
    try {
        let now = Date.now();
        const cache = diskCache({ directory, ttlMs: 1000, now: () => now });
        const { cachedSource } = await import('../cli/cache.ts');
        const source = fixtureSource();
        const wrapped = cachedSource(source, cache);
        const streams = captureStreams();
        await run({ argv: ['summary', '--harness', 'xpcshell', '--json'], streams, source: wrapped, cache });
        assert.equal(source.requested.length, 1);
        now += 5000;
        await run({ argv: ['summary', '--harness', 'xpcshell', '--json'], streams, source: wrapped, cache });
        assert.equal(source.requested.length, 2, 'past the TTL it must re-fetch');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('--no-cache neither reads nor writes the cache', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fx-tests-cache-'));
    try {
        const cache = diskCache({ directory });
        const streams = captureStreams();
        await run({
            argv: ['summary', '--harness', 'xpcshell', '--json', '--no-cache'],
            streams,
            source: fixtureSource(),
            cache,
        });
        assert.deepEqual(await cache.list(), [], 'nothing was written');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('an unwritable cache warns actionably and still answers', async () => {
    // A read-only path: writing under a file is EACCES/ENOTDIR everywhere.
    const directory = await mkdtemp(join(tmpdir(), 'fx-tests-cache-'));
    const blocked = join(directory, 'a-file', 'cache');
    await writeFile(join(directory, 'a-file'), 'not a directory');
    try {
        const cache = diskCache({ directory: blocked });
        const { cachedSource } = await import('../cli/cache.ts');
        const streams = captureStreams();
        const code = await run({
            argv: ['summary', '--harness', 'xpcshell', '--json'],
            streams,
            source: cachedSource(fixtureSource(), cache, {
                onWarning: (message) => streams.err(`warning: ${message}\n`),
            }),
            cache,
        });

        // The behaviour that matters first: a cache that cannot be written
        // makes the CLI slower, not broken.
        assert.equal(code, 0);
        assert.doesNotThrow(() => JSON.parse(streams.stdout));

        // And the message has to be usable. The raw form was
        // `EPERM: operation not permitted, mkdir '/proc'` — accurate, and it
        // tells a reader neither that the run succeeded nor what to do, so
        // seeing it mid-output reads as a failed run.
        assert.match(streams.stderr, /cache directory/);
        assert.match(streams.stderr, /complete and correct/);
        assert.match(streams.stderr, /--cache-dir/);
        assert.match(streams.stderr, /--no-cache/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('the cache-failure message names the cause for each errno it knows', async () => {
    const { describeCacheWriteFailure } = await import('../cli/cache.ts');
    const of = (code: string): string => {
        const error = new Error(`${code}: something went wrong`) as NodeJS.ErrnoException;
        error.code = code;
        return describeCacheWriteFailure('/some/dir', error);
    };
    assert.match(of('EACCES'), /no permission to write/);
    assert.match(of('EPERM'), /no permission to write/);
    assert.match(of('ENOSPC'), /no space left/);
    assert.match(of('EROFS'), /read-only filesystem/);
    // An unrecognized errno still gets the directory, the reassurance and the
    // two flags — only the first clause is generic.
    const unknown = of('EWEIRD');
    assert.match(unknown, /could not write the cache directory \/some\/dir/);
    assert.match(unknown, /--no-cache/);
    // The raw errno is kept at the end: it is the part worth searching for.
    assert.match(unknown, /EWEIRD/);
});

test('cache --clear empties it and reports how many entries went', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fx-tests-cache-'));
    try {
        const cache = diskCache({ directory });
        const { cachedSource } = await import('../cli/cache.ts');
        const wrapped = cachedSource(fixtureSource(), cache);
        const streams = captureStreams();
        await run({ argv: ['summary', '--harness', 'xpcshell', '--json'], streams, source: wrapped, cache });
        assert.equal((await cache.list()).length, 1);

        const clearStreams = captureStreams();
        const code = await run({ argv: ['cache', '--clear'], streams: clearStreams, cache, source: fixtureSource() });
        assert.equal(code, ExitCode.Success);
        assert.match(clearStreams.stdout, /Cleared 1 entry/);
        assert.deepEqual(await cache.list(), []);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

// --- error mapping --------------------------------------------------------

test('a missing published file exits 2, not 1', async () => {
    const missing: DataSource = {
        name: 'empty',
        fetch(name) {
            return Promise.reject(new DataFileNotFoundError(name));
        },
    };
    const { code } = await invoke(['summary', '--harness', 'xpcshell'], {
        source: missing as DataSource & { requested: string[] },
    });
    assert.equal(code, ExitCode.NotFound);
});

test('a transport failure exits 3, so a script can tell it from missing data', async () => {
    const flaky: DataSource = {
        name: 'flaky',
        fetch(name) {
            return Promise.reject(new DataFetchError(name, 'ECONNRESET'));
        },
    };
    const { code, stderr } = await invoke(['summary', '--harness', 'xpcshell'], {
        source: flaky as DataSource & { requested: string[] },
    });
    // The 3/4 split exists so "try again in a minute" is distinguishable from
    // "this is never coming back". Collapsing them makes retry logic
    // impossible to write correctly.
    assert.equal(code, ExitCode.Upstream);
    assert.match(stderr, /ECONNRESET/);
});

// --- fx-tests try ---------------------------------------------------------

/** A Treeherder client over canned jobs. */
function fakeTreeherder(jobs: TreeherderJob[]): TreeherderClient {
    return {
        findPush: () =>
            Promise.resolve({
                pushId: 1,
                revision: 'abcdef1234567890',
                repository: 'try',
                revisions: [],
            }),
        jobsOfPush: () => Promise.resolve(jobs),
    };
}

/** A completed job. */
function job(
    jobName: string,
    taskId: string,
    result: string,
    retryId = 0
): TreeherderJob {
    return { jobId: 1, jobName, taskId, retryId, state: 'completed', result };
}

/**
 * A minimal Gecko profile with the markers `parseTestMarkers` reads.
 *
 * Hand-built rather than a fixture because the cases that matter — a crash
 * marker no test claims, a rerun that passed, a FAIL that is green — are
 * combinations a captured profile does not contain all of at once.
 *
 * `TestStatus` is where a real mochitest failure's message lives, and the
 * marker *name* is what identifies it: `FAIL` or `ERROR` in the string table,
 * not `test`. The `Test` marker itself carries no `message` for a plain
 * assertion failure, so a fixture that puts the message on the `Test` marker
 * tests a shape the harness does not emit.
 */
function profileWith(
    entries: {
        type: 'Test' | 'Crash' | 'Text' | 'TestStatus';
        test?: string;
        text?: string;
        status?: string;
        message?: string;
        color?: string;
        signature?: string;
        /** For `TestStatus`: the marker name, `FAIL` (default) or `ERROR`. */
        markerName?: 'FAIL' | 'ERROR';
        start: number;
        end: number;
    }[]
): string {
    // Index 0 is `test`; `FAIL` and `ERROR` get their own indexes so a
    // `TestStatus` marker can be named one of them, as the harness names them.
    const stringArray = ['test', 'other', 'FAIL', 'ERROR'];
    const nameIndexOf = (entry: (typeof entries)[number]): number => {
        if (entry.type === 'Test') return 0;
        if (entry.type === 'TestStatus') return entry.markerName === 'ERROR' ? 3 : 2;
        return 1;
    };
    const data = entries.map((entry) => {
        const record: Record<string, unknown> = { type: entry.type };
        if (entry.test !== undefined) record['test'] = entry.test;
        if (entry.text !== undefined) record['text'] = entry.text;
        if (entry.status !== undefined) record['status'] = entry.status;
        if (entry.message !== undefined) record['message'] = entry.message;
        if (entry.color !== undefined) record['color'] = entry.color;
        if (entry.signature !== undefined) record['signature'] = entry.signature;
        return record;
    });
    return JSON.stringify({
        meta: { startTime: 0 },
        threads: [
            {
                stringArray,
                markers: {
                    length: entries.length,
                    // Only `Test` markers are named `test`; Text and Crash get
                    // an index that is not 0, and `TestStatus` is named after
                    // its status, matching how a real profile names them.
                    name: entries.map(nameIndexOf),
                    data,
                    startTime: entries.map((entry) => entry.start),
                    endTime: entries.map((entry) => entry.end),
                },
            },
        ],
    });
}

/** Serves one profile for every task. */
function profileFetcher(byTask: Record<string, string>): (url: string) => Promise<Uint8Array | null> {
    return (url: string) => {
        const match = /task\/([^/]+)\//.exec(url);
        const body = match === null ? undefined : byTask[match[1]!];
        return Promise.resolve(
            body === undefined ? null : new TextEncoder().encode(body)
        );
    };
}

test('try exits 0 when it finds failures — the failures are the answer', async () => {
    const streams = captureStreams();
    const code = await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'boom', start: 1, end: 2 },
            ]),
        }),
    });
    assert.equal(code, ExitCode.Success);
    const result = json(streams.stdout);
    const perma = result['permaFails'] as { path: string }[];
    const known = result['knownIntermittents'] as { path: string }[];
    assert.equal(perma.length + known.length, 1);
});

test('try exits 0 when it finds nothing', async () => {
    const streams = captureStreams();
    const code = await run({
        argv: ['try', 'abcdef123456'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'success')]),
        fetchUrl: profileFetcher({}),
    });
    assert.equal(code, ExitCode.Success);
    assert.match(streams.stdout, /No test-level failures found/);
});

test('try surfaces a crash no test marker claimed', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-mochitest-plain', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            // Exactly the shape measured on try push 717fc67feaa071: the test
            // reported PASS and the failure is a shutdown-hang crash recorded
            // against it afterwards. Dropping it reports "no failures".
            TASK1: profileWith([
                { type: 'Test', test: MOCHITEST_PATH, status: 'PASS', start: 1, end: 2 },
                {
                    type: 'Crash',
                    test: `${MOCHITEST_PATH} (finished)`,
                    signature: '@ RunWatchdog',
                    start: 3,
                    end: 3,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { path: string; messages: string[] }[]),
        ...(result['knownIntermittents'] as { path: string; messages: string[] }[]),
        ...(result['newIntermittents'] as { path: string; messages: string[] }[]),
    ];
    assert.equal(all.length, 1, 'the unclaimed crash must become a failure');
    assert.equal(all[0]!.path, MOCHITEST_PATH, 'the (finished) suffix is stripped');
    assert.deepEqual(all[0]!.messages, ['@ RunWatchdog']);
});

test('try drops a crash recorded against a manifest rather than a test', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-mochitest-plain', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                // Two unclaimed crashes: one against a real test, one against
                // the manifest. Measured on try push 717fc67feaa071, the
                // `-xorig-2` job recorded 27 of the manifest kind.
                {
                    type: 'Crash',
                    test: `${MOCHITEST_PATH} (finished)`,
                    signature: '@ RunWatchdog',
                    start: 1,
                    end: 1,
                },
                {
                    type: 'Crash',
                    test: 'dom/canvas/test/mochitest.toml',
                    signature: '@ RunWatchdog',
                    start: 2,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { path: string }[]),
        ...(result['knownIntermittents'] as { path: string }[]),
        ...(result['newIntermittents'] as { path: string }[]),
    ];
    // The test-path crash becomes a failure; the manifest one does not. A
    // manifest is not a test, has nothing to join against central, and
    // reporting it as a failing test invents a test that does not exist.
    assert.deepEqual(
        all.map((failure) => failure.path),
        [MOCHITEST_PATH]
    );
    assert.ok(
        !all.some((failure) => failure.path.endsWith('.toml')),
        'no .toml may be reported as a failing test'
    );
});

test('try reports a no-message failure that failed every run as a perma-fail', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            // No `message` anywhere — not on the Test marker and not on a
            // TestStatus one. A real shape, and the one that used to be
            // excluded because the same-message comparison had nothing to
            // work with.
            TASK1: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'FAIL', start: 1, end: 2 },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const perma = result['permaFails'] as { messageComparable: boolean }[];
    // Classification is on push evidence alone now: it failed the only run of
    // the only config, so it is a perma-fail whatever central says and whether
    // or not there is a message to compare.
    assert.equal(perma.length, 1);
    assert.equal(perma[0]!.messageComparable, false);
    assert.equal((result['knownIntermittents'] as unknown[]).length, 0);
});

test('try states that an uncomparable failure cannot be compared, rather than "0%"', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'FAIL', start: 1, end: 2 },
            ]),
        }),
    });
    // The `messageComparable` guard no longer decides the section, but it
    // still decides what may be *printed*. The fixture test does fail on
    // central; with no message from the push, "0.0% with the same message"
    // would be a measurement of nothing presented as a measurement.
    assert.match(streams.stdout, /recorded no failure message, so it cannot be compared/);
    assert.doesNotMatch(streams.stdout, /0\.0% with the same message/);
    // And with nothing to compare, no pre-existing claim is made either.
    assert.doesNotMatch(streams.stdout, /Pre-existing/);
});

/**
 * The message the fixture test already fails with on central.
 *
 * Taken verbatim from `xpcshell-00.json`'s `FAIL-PARALLEL` and
 * `FAIL-SEQUENTIAL` groups for `TEST_PATH`, so a push reporting it is
 * reporting the *same* failure central already sees.
 */
const CENTRAL_FAILURE_MESSAGE =
    'NS_ERROR_FILE_CORRUPTED: Component returned failure code: 0x8052000b ' +
    '(NS_ERROR_FILE_CORRUPTED) [nsIPrefService.readUserPrefsFromFile]';

/**
 * Central history annotates a perma-fail; it no longer hides one.
 *
 * This test used to assert the opposite, and the filter it asserted is what
 * made the command report 0 perma-fails on try push 7d16bff8 where `try.html`
 * reports 3 — the filter was working exactly as written and still produced an
 * empty section for a push with three tests that failed every single run.
 *
 * The fact the reader needs is not lost, it moved: the row is reported, and it
 * is labelled `Pre-existing:` with the count on the config it broke.
 */
test('try reports a same-message central failure, and labels it pre-existing', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            // Fails in the only run, never passed on rerun, and reports the
            // message central already fails with.
            TASK1: profileWith([
                {
                    type: 'Test',
                    test: TEST_PATH,
                    status: 'FAIL',
                    message: CENTRAL_FAILURE_MESSAGE,
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const perma = result['permaFails'] as {
        messageComparable: boolean;
        central: { sameMessageFailCount: number };
    }[];
    assert.equal(perma.length, 1, 'it failed every run of its config, so it is reported');
    assert.equal(perma[0]!.messageComparable, true);
    assert.ok(
        perma[0]!.central.sameMessageFailCount > 0,
        'and the same-message count is what the annotation is built from'
    );
    assert.equal((result['knownIntermittents'] as unknown[]).length, 0);
});

/**
 * The Markdown table carries the same distinction as the text.
 *
 * A `--markdown` run is what gets pasted into a bug, and without this column
 * the perma-fail table reads as a list of regressions. On autoland push
 * 7c06165a that would be 48 of 51 rows misread.
 *
 * Three states, not two: `yes (n)`, `no`, and `—` for a row where the question
 * could not be asked at all.
 */
test('the Markdown perma-fail table has a pre-existing column with all three states', async () => {
    const cell = async (
        jobName: string,
        message: string | undefined
    ): Promise<string> => {
        const streams = captureStreams();
        await run({
            argv: ['try', 'abcdef123456', '--markdown'],
            streams,
            source: fixtureSource(),
            cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
            treeherder: fakeTreeherder([job(jobName, 'TASK1', 'testfailed')]),
            fetchUrl: profileFetcher({
                TASK1: profileWith([
                    // `message` is omitted rather than set to `undefined` when
                    // there is none: `exactOptionalPropertyTypes` makes those
                    // different types, and the absent case is the one the
                    // harness actually emits.
                    {
                        type: 'Test',
                        test: TEST_PATH,
                        status: 'FAIL',
                        ...(message === undefined ? {} : { message }),
                        start: 1,
                        end: 2,
                    },
                ]),
            }),
        });
        assert.match(streams.stdout, /\| Pre-existing\? \|/, 'the column must exist');
        const lines = streams.stdout.split('\n');
        const header = lines.find((line) => line.includes('| Pre-existing? |'));
        assert.ok(header !== undefined, 'expected the header row');
        const row = lines.find((line) => line.includes(TEST_PATH) && line.startsWith('|'));
        assert.ok(row !== undefined, `expected a row for ${TEST_PATH}`);
        // Located by header text, not by index: this table gained a leading
        // failure-count column, and a hardcoded index would have kept passing
        // while reading the wrong cell.
        const column = header.split('|').findIndex((cell) => cell.trim() === 'Pre-existing?');
        return (row.split('|')[column] ?? '').trim();
    };

    // Central fails this config with this very message, 4 times.
    assert.match(
        await cell('test-windows11-64-25h2-shippable/opt-xpcshell', CENTRAL_FAILURE_MESSAGE),
        /^yes \(4\)$/
    );
    // Same config, a message central has never seen there.
    assert.equal(
        await cell('test-windows11-64-25h2-shippable/opt-xpcshell', 'a message central has never seen'),
        'no'
    );
    // No message at all: the question cannot be asked, and "no" would answer
    // one that was never put.
    assert.equal(
        await cell('test-windows11-64-25h2-shippable/opt-xpcshell', undefined),
        '—'
    );
});

test('try labels a pre-existing perma-fail in the text output', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        // A config the fixture's central history actually attributes runs to,
        // and one it fails on with this very message (4 of them). Pushing on a
        // config central has never run leaves nothing to annotate with.
        treeherder: fakeTreeherder([
            job('test-windows11-64-25h2-shippable/opt-xpcshell', 'TASK1', 'testfailed'),
        ]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                {
                    type: 'Test',
                    test: TEST_PATH,
                    status: 'FAIL',
                    message: CENTRAL_FAILURE_MESSAGE,
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    assert.match(streams.stdout, /PERMA-FAILS \(1\)/);
    // The sentence that stops someone chasing a pre-existing breakage. Without
    // it the section is a wall of rows with no way to tell them apart.
    assert.match(streams.stdout, /Pre-existing: central already fails the same way on/);
    assert.match(streams.stdout, /probably not yours/);
    // And the header must not simultaneously claim the row is the reader's.
    assert.doesNotMatch(streams.stdout, /almost certainly yours/);
});

test('try text output states both central rates for an intermittent', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        // Two runs of the config with one failure, so it does not fail every
        // run and lands in the compact table rather than the perma section.
        treeherder: fakeTreeherder([
            job('test-linux/opt-xpcshell', 'TASK1', 'testfailed'),
            job('test-linux/opt-xpcshell', 'TASK2', 'testfailed'),
        ]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                {
                    type: 'Test',
                    test: TEST_PATH,
                    status: 'FAIL',
                    message: CENTRAL_FAILURE_MESSAGE,
                    start: 1,
                    end: 2,
                },
            ]),
            TASK2: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'PASS', start: 1, end: 2 },
            ]),
        }),
    });
    assert.match(streams.stdout, /PERMA-FAILS \(0\)/);
    assert.match(streams.stdout, /KNOWN INTERMITTENTS \(1\)/);
    // Both rates in the table, so a reader can see it is flaky *this way* and
    // not merely flaky.
    assert.match(streams.stdout, /same msg/);
});

test('try marks a matching message as comparable and reports both rates', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                {
                    type: 'Test',
                    test: TEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { messageComparable: boolean; central: { failCount: number; sameMessageFailCount: number } }[]),
        ...(result['knownIntermittents'] as { messageComparable: boolean; central: { failCount: number; sameMessageFailCount: number } }[]),
    ];
    assert.equal(all.length, 1);
    assert.equal(all[0]!.messageComparable, true);
    // Central has failures for this test but not with this message — the
    // distinction CLI.md says is load-bearing.
    assert.ok(all[0]!.central.failCount > 0);
    assert.equal(all[0]!.central.sameMessageFailCount, 0);
});

test('try reports a test that passed on harness rerun as intermittent', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Text', text: 'retry', start: 10, end: 20 },
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'x', start: 1, end: 2 },
                // Inside the retry range: the harness reran it and it passed.
                { type: 'Test', test: TEST_PATH, status: 'PASS', start: 12, end: 14 },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { passedOnRerun: boolean }[]),
        ...(result['knownIntermittents'] as { passedOnRerun: boolean }[]),
        ...(result['newIntermittents'] as { passedOnRerun: boolean }[]),
    ];
    assert.equal(all.length, 1);
    assert.equal(all[0]!.passedOnRerun, true);
    // Passing on rerun is decisive: it cannot be a perma-fail.
    assert.equal((result['permaFails'] as unknown[]).length, 0);
});

// --- where the message actually lives -------------------------------------

/**
 * The shape measured on task `GwXgN5-rTOOtVkoQvJlDBQ` of try push 7d16bff8:
 * a `Test` marker with a status and no `message` field at all, and the real
 * message on a `TestStatus` marker inside its time range.
 *
 * This is what a plain mochitest assertion failure looks like. Reading only
 * `data.message` off the `Test` marker left 12 of that push's 26 failing tests
 * with no message, which printed `?` in the `same msg` column and — because an
 * uncomparable failure cannot be exonerated or convicted — took every one of
 * them out of the running for PERMA-FAILS.
 */
test('try reads a failure message off the TestStatus markers, not the Test marker', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                // No `message` on the Test marker — the harness does not put
                // one there for a FAIL.
                { type: 'Test', test: TEST_PATH, status: 'FAIL', start: 10, end: 20 },
                {
                    type: 'TestStatus',
                    test: TEST_PATH,
                    message: 'the real failure message',
                    start: 12,
                    end: 12,
                },
                // A later one inside the same range: the first is the one taken.
                {
                    type: 'TestStatus',
                    test: TEST_PATH,
                    message: 'a subsequent message',
                    start: 15,
                    end: 15,
                },
                // Outside the range, so it belongs to no execution here.
                {
                    type: 'TestStatus',
                    test: TEST_PATH,
                    message: 'from some other execution',
                    start: 90,
                    end: 90,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { messages: string[]; messageComparable: boolean }[]),
        ...(result['knownIntermittents'] as { messages: string[]; messageComparable: boolean }[]),
        ...(result['newIntermittents'] as { messages: string[]; messageComparable: boolean }[]),
    ];
    assert.equal(all.length, 1);
    assert.deepEqual(
        all[0]!.messages,
        ['the real failure message'],
        'the message on the TestStatus marker inside the range, and only that one'
    );
    // The whole point: with a message there is something to compare, so the
    // failure can reach a verdict instead of being parked as uncomparable.
    assert.equal(all[0]!.messageComparable, true);
});

/**
 * The precedence, which `old/try.html:983` sets by assigning `allMessages[0]`
 * *over* whatever the `Test` marker held. Some `Test` markers do carry a
 * `message`, and it is the generic harness summary ("Found unexpected failures
 * during the test") rather than the assertion that failed — so preferring it
 * would replace the useful message with a constant, and every failure in a job
 * would look like the same failure to the same-message comparison.
 */
test('try prefers the TestStatus message over the Test marker’s own', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                {
                    type: 'Test',
                    test: TEST_PATH,
                    status: 'FAIL',
                    message: 'the generic harness summary',
                    start: 10,
                    end: 20,
                },
                {
                    type: 'TestStatus',
                    test: TEST_PATH,
                    message: 'the assertion that actually failed',
                    start: 12,
                    end: 12,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { messages: string[] }[]),
        ...(result['knownIntermittents'] as { messages: string[] }[]),
        ...(result['newIntermittents'] as { messages: string[] }[]),
    ];
    assert.equal(all.length, 1);
    assert.deepEqual(all[0]!.messages, ['the assertion that actually failed']);
});

/**
 * The upper bound of the range. Two executions of the same test in one job —
 * the harness's rerun is exactly that — each have their own messages, and a
 * lookup that only checks `time >= start` takes the first one for both, so the
 * rerun reports the initial run's failure.
 */
test('try does not take a later execution’s message for an earlier one', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                // Two executions, each with its own message. Only the upper
                // bound of the range keeps them apart: without it the first
                // execution's lookup runs past its own end and finds the
                // second's marker, so both report the first message and the
                // second one is never seen.
                // The first execution logs nothing while it runs.
                { type: 'Test', test: TEST_PATH, status: 'FAIL', start: 10, end: 20 },
                // Logged *between* the two executions — during teardown, and
                // so inside neither test's range. Without the upper bound the
                // first execution reaches forward and claims it.
                {
                    type: 'TestStatus',
                    test: TEST_PATH,
                    message: 'logged between the two executions',
                    start: 25,
                    end: 25,
                },
                { type: 'Test', test: TEST_PATH, status: 'FAIL', start: 30, end: 40 },
                {
                    type: 'TestStatus',
                    test: TEST_PATH,
                    message: 'the second execution failed here',
                    start: 35,
                    end: 35,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { messages: string[] }[]),
        ...(result['knownIntermittents'] as { messages: string[] }[]),
        ...(result['newIntermittents'] as { messages: string[] }[]),
    ];
    assert.equal(all.length, 1);
    // Only the message logged inside an execution's own range. A lookup
    // unbounded at the top attributes the teardown line to the first
    // execution, which is a message that test never produced.
    assert.deepEqual(all[0]!.messages, ['the second execution failed here']);
});

/**
 * Only failing executions gather a message. A `PASS` that happens to overlap a
 * `TestStatus` marker — the harness logs plenty of them for tests that
 * recovered — must not acquire one, because a passing execution with a failure
 * message is not a thing and it would pollute the messages the same-message
 * comparison runs on.
 */
test('try does not attach a failure message to a passing execution', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Text', text: 'retry', start: 30, end: 50 },
                // Failed first, with its own message.
                { type: 'Test', test: TEST_PATH, status: 'FAIL', start: 10, end: 20 },
                {
                    type: 'TestStatus',
                    test: TEST_PATH,
                    message: 'the failure',
                    start: 15,
                    end: 15,
                },
                // Then passed on rerun, overlapping a leftover status marker.
                { type: 'Test', test: TEST_PATH, status: 'PASS', start: 35, end: 45 },
                {
                    type: 'TestStatus',
                    test: TEST_PATH,
                    message: 'logged during the passing rerun',
                    start: 40,
                    end: 40,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { messages: string[]; passedOnRerun: boolean }[]),
        ...(result['knownIntermittents'] as { messages: string[]; passedOnRerun: boolean }[]),
        ...(result['newIntermittents'] as { messages: string[]; passedOnRerun: boolean }[]),
    ];
    assert.equal(all.length, 1);
    assert.equal(all[0]!.passedOnRerun, true);
    assert.deepEqual(
        all[0]!.messages,
        ['the failure'],
        'only the failing execution contributes a message'
    );
});

/**
 * Only a failing execution gathers a message, asserted on `parseTestMarkers`
 * directly.
 *
 * It has to be direct. Both consumers of a timing's `message` —
 * `aggregateFailures` and `attachProvenance` — sit behind `isFailureStatus`,
 * so a message wrongly attached to a `PASS` is invisible in every rendered
 * output and in `--json`. That makes the status guard unreachable-by-effect
 * through the command, exactly like the `entryMatches` clause documented in
 * `lib/query/config-stats.ts`, and a mutation removing it survives the whole
 * suite while changing no output.
 *
 * The guard is still worth keeping and worth pinning: `timings` is the shape
 * the rest of the command is written against, and "a passing execution with a
 * failure message" is not a state anything downstream should have to consider.
 */
test('parseTestMarkers attaches a message only to a failing execution', async () => {
    const { parseTestMarkers } = await import('../cli/commands/try.ts');
    const profile = JSON.parse(
        profileWith([
            // A pass, overlapping a status marker the harness logged for a
            // check that failed and then recovered.
            { type: 'Test', test: TEST_PATH, status: 'PASS', start: 10, end: 20 },
            {
                type: 'TestStatus',
                test: TEST_PATH,
                message: 'a check that failed and then recovered',
                start: 15,
                end: 15,
            },
            // And a failure, which does take its message.
            { type: 'Test', test: TEST_PATH, status: 'FAIL', start: 30, end: 40 },
            {
                type: 'TestStatus',
                test: TEST_PATH,
                message: 'the real failure',
                start: 35,
                end: 35,
            },
        ])
    ) as unknown;
    const timings = parseTestMarkers(profile, job('test-linux/opt-xpcshell', 'TASK1', 'testfailed'));

    const pass = timings.find((timing) => timing.status === 'PASS');
    assert.ok(pass !== undefined, 'the passing execution is parsed');
    assert.equal(pass.message, null, 'a passing execution carries no failure message');

    const fail = timings.find((timing) => timing.status === 'FAIL');
    assert.ok(fail !== undefined);
    assert.equal(fail.message, 'the real failure');
});

test('try takes an ERROR-named TestStatus marker as a message too', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'FAIL', start: 10, end: 20 },
                {
                    type: 'TestStatus',
                    test: TEST_PATH,
                    markerName: 'ERROR',
                    message: 'an ERROR-named status marker',
                    start: 12,
                    end: 12,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { messages: string[] }[]),
        ...(result['knownIntermittents'] as { messages: string[] }[]),
        ...(result['newIntermittents'] as { messages: string[] }[]),
    ];
    assert.equal(all.length, 1);
    assert.deepEqual(all[0]!.messages, ['an ERROR-named status marker']);
});

test('try ignores a TestStatus marker recorded against a different test', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'FAIL', start: 10, end: 20 },
                // Same time range, different test: two tests can be in flight
                // at once under parallel execution, so the range alone does not
                // identify the owner.
                {
                    type: 'TestStatus',
                    test: 'dom/base/test/unit/test_other.js',
                    message: 'belongs to the neighbour',
                    start: 12,
                    end: 12,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { messages: string[]; messageComparable: boolean }[]),
        ...(result['knownIntermittents'] as { messages: string[]; messageComparable: boolean }[]),
        ...(result['newIntermittents'] as { messages: string[]; messageComparable: boolean }[]),
    ];
    assert.equal(all.length, 1);
    assert.deepEqual(all[0]!.messages, [], 'the neighbour’s message is not this test’s');
    assert.equal(all[0]!.messageComparable, false);
});

// --- perma-fail classification is per configuration -----------------------

/**
 * The shape measured for `browser_ml_heuristics.js` on try push 7d16bff8, and
 * the case `try.html` and this command used to disagree on.
 *
 * The test fails on two configurations. On CONFIG-A it is plainly intermittent
 * — another run of the same job name passed outright. On CONFIG-B every run
 * failed and none passed. `try.html` lists the test under "Permanent failures"
 * because it tags each failing *instance* and calls the test permanent when any
 * instance is not intermittent (`old/try.html:1400`, `:1765`).
 *
 * Asking "did every run of this test fail?" of the whole test answers no, and
 * hides a configuration the test never once passed on. That is the question
 * this command used to ask.
 */
test('try calls a test perma-failing when one config failed every run, even if another is flaky', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            // CONFIG-A: two runs, one failed the test and one passed the job
            // outright, so the failure is intermittent there.
            job('test-linux/opt-xpcshell-a', 'TASKA1', 'testfailed'),
            job('test-linux/opt-xpcshell-a', 'TASKA2', 'success'),
            // CONFIG-B: one run, and it failed. Nothing passed here.
            job('test-linux/opt-xpcshell-b', 'TASKB1', 'testfailed'),
        ]),
        fetchUrl: profileFetcher({
            TASKA1: profileWith([
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
            ]),
            TASKB1: profileWith([
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const perma = result['permaFails'] as {
        path: string;
        everyRunFailed: boolean;
        permaFailingConfigs: string[];
    }[];
    assert.equal(perma.length, 1, 'the config that never passed makes this a perma-fail');
    assert.equal(perma[0]!.path, MOCHITEST_PATH);
    assert.equal(perma[0]!.everyRunFailed, true);
    // And it names *which* config, since that is the actionable part and the
    // test is perfectly healthy on the other one.
    assert.deepEqual(perma[0]!.permaFailingConfigs, ['test-linux/opt-xpcshell-b']);
});

/**
 * Every run of the config, not merely one of them. A config that ran three
 * times and failed once is the textbook intermittent, and calling it permanent
 * is the "almost certainly yours" verdict handed to someone whose patch did
 * nothing.
 */
test('try does not call a config perma-failing when only some of its runs failed', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            // Three runs of one config. All three are `testfailed` — so the
            // job failed each time — but the test under scrutiny only failed
            // in the first; the others failed on something else.
            job('test-linux/opt-xpcshell-a', 'TASKA1', 'testfailed'),
            job('test-linux/opt-xpcshell-a', 'TASKA2', 'testfailed'),
            job('test-linux/opt-xpcshell-a', 'TASKA3', 'testfailed'),
        ]),
        fetchUrl: profileFetcher({
            TASKA1: profileWith([
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
            ]),
            TASKA2: profileWith([
                { type: 'Test', test: MOCHITEST_PATH, status: 'PASS', start: 1, end: 2 },
            ]),
            TASKA3: profileWith([
                { type: 'Test', test: MOCHITEST_PATH, status: 'PASS', start: 1, end: 2 },
            ]),
        }),
    });
    const result = json(streams.stdout);
    assert.equal(
        (result['permaFails'] as unknown[]).length,
        0,
        '1 of 3 runs is an intermittent, not a permanent failure'
    );
    const rest = [
        ...(result['knownIntermittents'] as { failedRuns: number; totalRuns: number }[]),
        ...(result['newIntermittents'] as { failedRuns: number; totalRuns: number }[]),
    ];
    assert.equal(rest.length, 1);
    assert.equal(rest[0]!.failedRuns, 1);
    assert.equal(rest[0]!.totalRuns, 3);
});

test('try does not call a config perma-failing when a run of it passed the job', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            job('test-linux/opt-xpcshell-a', 'TASKA1', 'testfailed'),
            job('test-linux/opt-xpcshell-a', 'TASKA2', 'success'),
        ]),
        fetchUrl: profileFetcher({
            TASKA1: profileWith([
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    // The only config had a fully successful run, so nothing here is permanent.
    assert.equal((result['permaFails'] as unknown[]).length, 0);
    const rest = [
        ...(result['knownIntermittents'] as { everyRunFailed: boolean; permaFailingConfigs: string[] }[]),
        ...(result['newIntermittents'] as { everyRunFailed: boolean; permaFailingConfigs: string[] }[]),
    ];
    assert.equal(rest.length, 1);
    assert.equal(rest[0]!.everyRunFailed, false);
    assert.deepEqual(rest[0]!.permaFailingConfigs, []);
});

// --- the central check is asked of the perma-failing configs --------------

/** The path the synthetic perma-fail bucket holds. */
const PERMAFAIL_BUCKET_TEST = 'dom/base/test/unit/test_permafail.js';

/** The message that bucket's failures carry, on every config. */
const PERMAFAIL_BUCKET_MESSAGE = 'assertion failed: everything is broken here';

/**
 * The bug that produced "0 perma-fails" where `try.html` shows 3.
 *
 * `permaFailBucket()` has this test failing with the same message on two
 * configs — `test-windows11-64/opt-xpcshell` and
 * `test-macosx1500-64/debug-xpcshell` — and passing on a third,
 * `test-linux2404-64/debug-xpcshell`, which it never fails on at all.
 *
 * A push that perma-fails it on the *linux* config is therefore reporting a
 * failure central has never seen there. Measuring the same-message count over
 * every config instead finds the windows and macOS failures and exonerates the
 * push — which on try push 7d16bff8 is what happened to all three of its
 * permanent failures, each of them on a config where central *does* fail the
 * same way, but reached through configs where it does not.
 */
test('try scopes the central same-message check to the perma-failing config', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: permaFailSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            job('test-linux2404-64/debug-xpcshell', 'TASK1', 'testfailed'),
        ]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                {
                    type: 'Test',
                    test: PERMAFAIL_BUCKET_TEST,
                    status: 'FAIL',
                    message: PERMAFAIL_BUCKET_MESSAGE,
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const perma = result['permaFails'] as {
        permaFailingConfigs: string[];
        central: {
            sameMessageFailCount: number;
            sameMessageFailCountOnPermaConfigs: number | null;
        };
    }[];
    assert.equal(perma.length, 1, 'central never fails this way on the config that broke');
    assert.deepEqual(perma[0]!.permaFailingConfigs, ['test-linux2404-64/debug-xpcshell']);
    // The two numbers must differ, or the test is not measuring the scoping.
    assert.ok(
        perma[0]!.central.sameMessageFailCount > 0,
        'central does fail this way somewhere, which is what used to exonerate it'
    );
    assert.equal(
        perma[0]!.central.sameMessageFailCountOnPermaConfigs,
        0,
        'but not on the configuration this push broke'
    );

    // And the row must carry no pre-existing label, since nothing about it is
    // pre-existing on the config that broke. Asserting the label's *absence*
    // is what makes the scoping observable now that it no longer filters:
    // unscoped, this row would be labelled off the failures on other configs.
    const text = captureStreams();
    await run({
        argv: ['try', 'abcdef123456'],
        streams: text,
        source: permaFailSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            job('test-linux2404-64/debug-xpcshell', 'TASK1', 'testfailed'),
        ]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                {
                    type: 'Test',
                    test: PERMAFAIL_BUCKET_TEST,
                    status: 'FAIL',
                    message: PERMAFAIL_BUCKET_MESSAGE,
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    assert.match(text.stdout, /PERMA-FAILS \(1\)/);
    assert.doesNotMatch(text.stdout, /Pre-existing/);
});

test('try labels a perma-fail pre-existing when central fails that very config', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456'],
        streams,
        source: permaFailSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            // The windows config, which central fails on 3 of 3 runs with
            // exactly this message.
            job('test-windows11-64/opt-xpcshell', 'TASK1', 'testfailed'),
        ]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                {
                    type: 'Test',
                    test: PERMAFAIL_BUCKET_TEST,
                    status: 'FAIL',
                    message: PERMAFAIL_BUCKET_MESSAGE,
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    // Reported — it failed every run — and named as pre-existing on the
    // configuration it failed on, which is the whole point of the scoping.
    assert.match(streams.stdout, /PERMA-FAILS \(1\)/);
    assert.match(
        streams.stdout,
        /Pre-existing: central already fails the same way on test-windows11-64\/opt-xpcshell/
    );
});

/**
 * The chunk suffix has to come off both sides before the names can be matched.
 *
 * `computeConfigStats` reports chunk-stripped names and a push's job names
 * carry the chunk, so `…-xpcshell-3` never equals `…-xpcshell` and every
 * perma-failing config looks absent from central's history. That silently
 * turns the config-scoped count into `null` for every chunked job — which is
 * most of them — and falls back to the whole-test count, undoing the scoping
 * exactly where it was needed.
 */
test('try matches perma-failing configs to central with the chunk suffix stripped', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: permaFailSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            // The same windows config as above, but chunked — which is how a
            // real push names it.
            job('test-windows11-64/opt-xpcshell-3', 'TASK1', 'testfailed'),
        ]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                {
                    type: 'Test',
                    test: PERMAFAIL_BUCKET_TEST,
                    status: 'FAIL',
                    message: PERMAFAIL_BUCKET_MESSAGE,
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as {
            central: { sameMessageFailCountOnPermaConfigs: number | null };
        }[]),
        ...(result['knownIntermittents'] as {
            central: { sameMessageFailCountOnPermaConfigs: number | null };
        }[]),
    ];
    assert.equal(all.length, 1);
    // Not `null`: the chunked push name resolved to the unchunked history one.
    // Left unstripped it finds nothing, the count is `null`, and the row loses
    // its pre-existing label — which is most rows, since most job names are
    // chunked.
    assert.ok(
        (all[0]!.central.sameMessageFailCountOnPermaConfigs ?? 0) > 0,
        'the chunked job name must still find its configuration in central'
    );
    assert.equal((result['permaFails'] as unknown[]).length, 1);
});

/**
 * The other half of the per-config rule, and the one that is easy to get
 * backwards: a test that passed on the harness's rerun *on one config* must
 * still be a perma-fail when a different config failed every run.
 *
 * `isPermaFail` used to reject on the test-level `passedOnRerun`, which threw
 * the permanent config away. Measured on push 7d16bff8: four of that push's
 * five every-run-failed tests had `passedOnRerun` set somewhere.
 */
test('try keeps a perma-failing config when the test passed on rerun elsewhere', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            job('test-linux/opt-xpcshell-a', 'TASKA1', 'testfailed'),
            job('test-linux/opt-xpcshell-b', 'TASKB1', 'testfailed'),
        ]),
        fetchUrl: profileFetcher({
            // CONFIG-A: failed, then passed when the harness reran it.
            TASKA1: profileWith([
                { type: 'Text', text: 'retry', start: 10, end: 20 },
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
                { type: 'Test', test: MOCHITEST_PATH, status: 'PASS', start: 12, end: 14 },
            ]),
            // CONFIG-B: failed, and never passed.
            TASKB1: profileWith([
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const perma = result['permaFails'] as {
        passedOnRerun: boolean;
        passedOnRerunConfigs: string[];
        permaFailingConfigs: string[];
    }[];
    assert.equal(perma.length, 1, 'the rerun on one config does not excuse the other');
    // The test-level flag is still true and reported — it is a real fact about
    // the push — it just does not decide the section on its own.
    assert.equal(perma[0]!.passedOnRerun, true);
    assert.deepEqual(perma[0]!.permaFailingConfigs, ['test-linux/opt-xpcshell-b']);
    // And the config the rerun rescued is named, so the row can say where each
    // of the two facts applies. Disjoint from `permaFailingConfigs`.
    assert.deepEqual(perma[0]!.passedOnRerunConfigs, ['test-linux/opt-xpcshell-a']);
});

/**
 * The `n/m runs` fraction, and the fact it cannot state on its own.
 *
 * Reported against `--all-jobs` on try push 7d16bff81bb1:
 * `browser_878452_drag_to_panel.js` printed `18/18 runs` while also reporting
 * `passedOnRerun`. Both were true — it failed in all 18 runs of the 12
 * configurations it failed on, and the harness reran it to green in every one
 * of those 18 runs — and `18/18` alone reads as "this test never passed".
 *
 * The fraction was not wrong and is unchanged. What was missing is the
 * breakdown that makes it readable, so this pins the breakdown against a run
 * whose two executions are written out here rather than derived.
 */
test('try reports how each run of a failing config ended, not just the fraction', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell-a', 'TASKA1', 'testfailed')]),
        fetchUrl: profileFetcher({
            // One run, two executions: the failure and the rerun that passed.
            TASKA1: profileWith([
                { type: 'Text', text: 'retry', start: 10, end: 20 },
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
                { type: 'Test', test: MOCHITEST_PATH, status: 'PASS', start: 12, end: 14 },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as Record<string, unknown>[]),
        ...(result['knownIntermittents'] as Record<string, unknown>[]),
        ...(result['newIntermittents'] as Record<string, unknown>[]),
    ];
    assert.equal(all.length, 1);
    const failure = all[0]!;
    // One failing execution out of TWO executions — the FAIL and the passing
    // rerun — in one job run of one configuration. Counted out by hand from the
    // two `Test` markers in the profile above: the ratio the command prints is
    // `1/2`, and the older `1/1` was the job run counted twice over.
    assert.equal(failure['failureCount'], 1, 'one failing execution');
    assert.equal(failure['totalRuns'], 2, 'the FAIL and the passing rerun');
    assert.equal(failure['totalJobs'], 1, 'both happened in one job run');
    assert.equal(failure['failedRuns'], 1, 'which is the one job run that failed');
    // And what the ratio still does not say.
    assert.deepEqual(failure['outcomes'], {
        failedTwice: 0,
        passedOnRetry: 1,
        failedOnce: 0,
        passed: 0,
        notAnalyzed: 0,
    });
});

/**
 * The other two buckets, which the rerun case cannot reach.
 *
 * `failedTwice` is the rerun that did *not* rescue the run, and it is the one
 * that decides whether a `passedOnRetry` reading is real: without a case where
 * the second execution fails, the branch can be disabled and nothing notices.
 * `notAnalyzed` is the default run's blind spot — the runs of a failing
 * configuration whose profiles were never fetched, which are the runs a reader
 * of the bare fraction takes for failures.
 */
test('try separates a rerun that failed again from runs it never read', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        // Three runs of one configuration; only the failed one has its profile
        // read, which is what the default (no `--all-jobs`) does.
        treeherder: fakeTreeherder([
            job('test-linux/opt-xpcshell-a', 'TASKA1', 'testfailed'),
            job('test-linux/opt-xpcshell-a', 'TASKA2', 'success'),
            job('test-linux/opt-xpcshell-a', 'TASKA3', 'success'),
        ]),
        fetchUrl: profileFetcher({
            // Failed, then failed AGAIN when the harness reran it.
            TASKA1: profileWith([
                { type: 'Text', text: 'retry', start: 10, end: 20 },
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 12,
                    end: 14,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as Record<string, unknown>[]),
        ...(result['knownIntermittents'] as Record<string, unknown>[]),
        ...(result['newIntermittents'] as Record<string, unknown>[]),
    ];
    assert.equal(all.length, 1);
    const failure = all[0]!;
    assert.deepEqual(failure['outcomes'], {
        failedTwice: 1,
        passedOnRetry: 0,
        failedOnce: 0,
        passed: 0,
        // The two passing runs of the same configuration, whose profiles the
        // default run does not fetch. Not failures, and not asserted to be
        // passes either — they were not looked at.
        notAnalyzed: 2,
    });
    // The three quantities, counted by hand off the profile and the job list.
    // Two `Test` markers in the one run whose profile was read, and two more
    // runs of that configuration nobody read: 2 + 2 = 4 executions.
    assert.equal(failure['failureCount'], 2, 'both executions failed');
    assert.equal(failure['totalRuns'], 4, '2 parsed executions + 2 unread runs');
    assert.equal(failure['totalJobs'], 3, 'three job runs of the configuration');
    assert.equal(failure['failedRuns'], 1, 'one of which contained a failure');
    // This row is the one that makes the unseen term of `totalRuns` load-bearing
    // (`old/try.html:1579`): drop it and the denominator becomes 2, which would
    // claim the test ran twice on a configuration that ran three times.
    assert.notEqual(failure['totalRuns'], 2);
});

/**
 * The bucket only `--all-jobs` can reach.
 *
 * A run of a failing configuration whose profile was read and held no failure
 * is a *pass*, not an unread run — and the default cannot tell the two apart
 * because it never fetches that profile. This is the payoff of the flag stated
 * as a number: the same push, the same test, `notAnalyzed: 1` without it and
 * `passed: 1` with it.
 */
test('try --all-jobs turns an unread run of a failing config into a counted pass', async () => {
    const jobs = [
        job('test-linux/opt-xpcshell-a', 'TASKA1', 'testfailed'),
        job('test-linux/opt-xpcshell-a', 'TASKA2', 'success'),
    ];
    const profiles = {
        TASKA1: profileWith([
            {
                type: 'Test',
                test: MOCHITEST_PATH,
                status: 'FAIL',
                message: 'a message central has never seen',
                start: 1,
                end: 2,
            },
        ]),
        // The green run: the test ran there and passed.
        TASKA2: profileWith([
            { type: 'Test', test: MOCHITEST_PATH, status: 'PASS', start: 1, end: 2 },
        ]),
    };
    const outcomesFor = async (argv: string[]): Promise<Record<string, number>> => {
        const streams = captureStreams();
        await run({
            argv,
            streams,
            source: fixtureSource(),
            cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
            treeherder: fakeTreeherder(jobs),
            fetchUrl: profileFetcher(profiles),
        });
        const result = json(streams.stdout);
        const all = [
            ...(result['permaFails'] as Record<string, unknown>[]),
            ...(result['knownIntermittents'] as Record<string, unknown>[]),
            ...(result['newIntermittents'] as Record<string, unknown>[]),
        ];
        assert.equal(all.length, 1);
        return all[0]!['outcomes'] as Record<string, number>;
    };

    const byDefault = await outcomesFor(['try', 'abcdef123456', '--json']);
    assert.deepEqual(byDefault, {
        failedTwice: 0,
        passedOnRetry: 0,
        failedOnce: 1,
        passed: 0,
        notAnalyzed: 1,
    });

    const widened = await outcomesFor(['try', 'abcdef123456', '--json', '--all-jobs']);
    assert.deepEqual(widened, {
        failedTwice: 0,
        passedOnRetry: 0,
        failedOnce: 1,
        passed: 1,
        notAnalyzed: 0,
    });
});

/**
 * The order of the sections, which is the thing the owner reported.
 *
 * `old/try.html:744` sets the page's default sort to `{ column: 'count',
 * ascending: false }`, and its `count` is `test.instances.length`
 * (`old/try.html:1869`) — failing *executions*, not the job runs they happened in.
 * This command ranked on distinct failing job runs, which is a different
 * number whenever the harness reran a test: on try push 09028ab93fe1 it turned
 * a leading sequence of 4, 4, 3, 3, 3 into 2, 2, 2, 2, 2 and reordered the
 * whole section.
 *
 * The fixture is the smallest push that distinguishes them: one config, one
 * job run, two failing executions of test A against one of test B. Ranked on
 * runs the two tie at 1 and A sorts second on its path; ranked on executions
 * A leads. Only the second matches the page.
 */
test('try ranks failures by failing executions, as the dashboard does', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                // Two failing executions of the alphabetically-later test…
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'boom', start: 1, end: 2 },
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'boom', start: 3, end: 4 },
                // …and one of the alphabetically-earlier one.
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'boom',
                    start: 5,
                    end: 6,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { path: string; failureCount: number; failedRuns: number }[]),
        ...(result['knownIntermittents'] as {
            path: string;
            failureCount: number;
            failedRuns: number;
        }[]),
        ...(result['newIntermittents'] as {
            path: string;
            failureCount: number;
            failedRuns: number;
        }[]),
    ];
    assert.equal(all.length, 2);
    // Both failed in exactly one job run, so the old key cannot separate them
    // and the alphabetical tiebreak would have put MOCHITEST_PATH first.
    assert.deepEqual(
        all.map((failure) => failure.failedRuns),
        [1, 1],
        'the fixture must tie on job runs, or it tests nothing'
    );
    assert.ok(
        MOCHITEST_PATH.localeCompare(TEST_PATH) < 0,
        'the fixture must make the busier test sort later alphabetically'
    );
    assert.deepEqual(
        all.map((failure) => failure.failureCount),
        [2, 1],
        'the busier test must come first'
    );
    assert.equal(all[0]!.path, TEST_PATH);
});

/**
 * Ties break on the path, which the page does not do and cannot.
 *
 * `try.html` leaves equal counts in insertion order and leans on `sort()`
 * being stable, so its tie order is the order eight web workers finished
 * parsing profiles fetched 64 at a time (`old/try.html:1113`) — a race that
 * reorders on reload. Output that gets diffed and pasted into bugs has to be
 * stable instead, so this is a deliberate divergence and it is pinned here.
 */
test('try breaks ties on the path, so the output is reproducible', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            // Emitted later-path-first, so insertion order is not path order.
            TASK1: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'boom', start: 1, end: 2 },
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'boom',
                    start: 3,
                    end: 4,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { path: string; failureCount: number }[]),
        ...(result['knownIntermittents'] as { path: string; failureCount: number }[]),
        ...(result['newIntermittents'] as { path: string; failureCount: number }[]),
    ];
    assert.deepEqual(
        all.map((failure) => failure.failureCount),
        [1, 1],
        'the fixture must tie, or the tiebreak is not what is under test'
    );
    assert.deepEqual(all.map((failure) => failure.path), [MOCHITEST_PATH, TEST_PATH]);
});

/**
 * The perma-fail row has to say *where* the rerun passed.
 *
 * Unscoped, the sentence "Passed when the harness reran it in the same job —
 * intermittent." on a row in the PERMA-FAILS section reads as a contradiction.
 * It is not one: the two facts are about different configurations. On try push
 * 09028ab93fe1, 33 of the 54 perma-fails printed both sentences.
 */
/**
 * The "failed every run on X" line exists to pick *some* of a row's configs
 * out of the rest, so when it would name all of them it says nothing the row
 * has not already said and is omitted.
 *
 * The row above it already reads "N failures on <config> (n/n runs)" for one
 * config, or lists every config for several. Repeating that list under a
 * heading that implies a distinction invents one.
 */
test('try omits the every-run line when it would name every config', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        // One config, and it failed its only run — so the perma-failing
        // configs are all of the configs.
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    assert.match(streams.stdout, /PERMA-FAILS \(1\)/, 'the fixture must produce a perma-fail');
    // The config is named once, on the "N failures in …" line. One `Test`
    // marker in one run of a configuration that ran once: 1 failure, 1
    // execution, 1 job run — the case where all three quantities coincide, and
    // the line still labels each rather than pairing them into a ratio.
    assert.match(
        streams.stdout,
        /1 failure in 1 run, across 1 job run on test-linux\/opt-xpcshell/
    );
    assert.doesNotMatch(
        streams.stdout,
        /Failed every run on/,
        'naming the same single config again distinguishes nothing'
    );
});

test('try scopes the rerun sentence to the configs it applies to', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            job('test-linux/opt-xpcshell-a', 'TASKA1', 'testfailed'),
            job('test-linux/opt-xpcshell-b', 'TASKB1', 'testfailed'),
        ]),
        fetchUrl: profileFetcher({
            TASKA1: profileWith([
                { type: 'Text', text: 'retry', start: 10, end: 20 },
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
                { type: 'Test', test: MOCHITEST_PATH, status: 'PASS', start: 12, end: 14 },
            ]),
            TASKB1: profileWith([
                {
                    type: 'Test',
                    test: MOCHITEST_PATH,
                    status: 'FAIL',
                    message: 'a message central has never seen',
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    // Both halves, each naming its own config, so the row does not contradict
    // itself.
    assert.match(
        streams.stdout,
        /Failed every run on test-linux\/opt-xpcshell-b/,
        'the permanent config must be named'
    );
    assert.match(
        streams.stdout,
        /Passed when the harness reran it in the same job on test-linux\/opt-xpcshell-a — intermittent there\./,
        'the rescued config must be named'
    );
    // And not the unscoped sentence, which is the thing that read as a
    // contradiction.
    assert.doesNotMatch(
        streams.stdout,
        /reran it in the same job — intermittent\./,
        'the unscoped sentence must be gone'
    );
    // The rerun sentence names only the config it rescued. Naming the
    // permanent one there would put the same config on both lines and say
    // opposite things about it — worse than the unscoped sentence it replaced.
    const rerun = streams.stdout
        .split('\n')
        .find((line) => line.includes('Passed when the harness reran it'));
    assert.ok(rerun !== undefined);
    assert.doesNotMatch(
        rerun,
        /opt-xpcshell-b/,
        'the config the rerun did not rescue must not be listed as rescued'
    );
    // Both configs are named on the row, each on its own line, so the two
    // facts can be told apart. Without the "failed every run" line the row
    // states only where the rerun passed, and the section it sits in looks
    // wrong.
    const everyRun = streams.stdout
        .split('\n')
        .find((line) => line.includes('Failed every run on'));
    assert.ok(everyRun !== undefined, 'the permanent config must be stated even so');
    assert.doesNotMatch(
        everyRun,
        /opt-xpcshell-a/,
        'the rescued config must not be listed as failing every run'
    );
});

test('try treats a green FAIL as an expected failure, not a failure', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                {
                    type: 'Test',
                    test: TEST_PATH,
                    status: 'FAIL',
                    color: 'green',
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    // Missing this reports every fail-if annotated test as broken.
    assert.equal((result['permaFails'] as unknown[]).length, 0);
    assert.equal((result['knownIntermittents'] as unknown[]).length, 0);
    assert.equal((result['newIntermittents'] as unknown[]).length, 0);
});

test('try derives the parallel suffix from the parallel range', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Text', text: 'parallel', start: 0, end: 100 },
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'x', start: 10, end: 20 },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { statuses: string[]; parallelOnly: boolean }[]),
        ...(result['knownIntermittents'] as { statuses: string[]; parallelOnly: boolean }[]),
    ];
    // The VERDICT, with the phase suffix stripped — `site/try-view.ts:498` has
    // always stripped here and the CLI did not, so a test that failed in both
    // phases read `["FAIL-PARALLEL","FAIL-SEQUENTIAL"]` on one side and
    // `["FAIL"]` on the other. Nothing is lost: the phase is what
    // `parallelOnly` reports, and it is asserted on the next line off the same
    // profile.
    assert.deepEqual(all[0]!.statuses, ['FAIL']);
    assert.equal(all[0]!.parallelOnly, true);
});

/**
 * The CRLF fold, end to end through the command.
 *
 * `lib/model/failure-message.ts` owns the rule and `test/try-parity.test.ts`
 * pins the page's worker copy against it. This asserts the third thing neither
 * covers: that the CLI's reported `messages` have been through it, so a
 * Windows job's message and a Linux job's message of the same failure are one
 * entry rather than two that print identically.
 */
test('try folds CRLF so one failure reported from two platforms is one message', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            job('test-windows/opt-xpcshell', 'TASKW', 'testfailed'),
            job('test-linux/opt-xpcshell', 'TASKL', 'testfailed'),
        ]),
        fetchUrl: profileFetcher({
            // The same failure, CRLF-terminated, with a per-run rejection date.
            TASKW: profileWith([
                {
                    type: 'Test',
                    test: TEST_PATH,
                    status: 'FAIL',
                    message: 'uncaught rejection\r\nRejection date: Mon Jan 01 2026\r\nstack frame',
                    start: 1,
                    end: 2,
                },
            ]),
            // And LF-terminated, with a different date.
            TASKL: profileWith([
                {
                    type: 'Test',
                    test: TEST_PATH,
                    status: 'FAIL',
                    message: 'uncaught rejection\nRejection date: Tue Jan 02 2026\nstack frame',
                    start: 1,
                    end: 2,
                },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { messages: string[] }[]),
        ...(result['knownIntermittents'] as { messages: string[] }[]),
        ...(result['newIntermittents'] as { messages: string[] }[]),
    ];
    assert.equal(all.length, 1);
    // One message, not two. The date is gone and the line ending is LF.
    assert.deepEqual(all[0]!.messages, ['uncaught rejection\nstack frame']);
});

/**
 * The divergence stated as one push: a test that failed in BOTH phases.
 *
 * The CLI reported `["FAIL-PARALLEL","FAIL-SEQUENTIAL"]` and the page
 * `["FAIL"]` off the same input. Two runs of one config, one execution in the
 * parallel range and one outside it.
 */
test('a test failing in both phases reports one verdict, not two', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            job('test-linux/opt-xpcshell', 'TASK1', 'testfailed'),
            job('test-linux/opt-xpcshell', 'TASK2', 'testfailed'),
        ]),
        fetchUrl: profileFetcher({
            // Inside the parallel range.
            TASK1: profileWith([
                { type: 'Text', text: 'parallel', start: 0, end: 100 },
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'x', start: 10, end: 20 },
            ]),
            // A parallel range exists but this execution falls outside it.
            TASK2: profileWith([
                { type: 'Text', text: 'parallel', start: 0, end: 5 },
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'x', start: 10, end: 20 },
            ]),
        }),
    });
    const result = json(streams.stdout);
    const all = [
        ...(result['permaFails'] as { statuses: string[]; parallelOnly: boolean }[]),
        ...(result['knownIntermittents'] as { statuses: string[]; parallelOnly: boolean }[]),
        ...(result['newIntermittents'] as { statuses: string[]; parallelOnly: boolean }[]),
    ];
    assert.equal(all.length, 1);
    assert.deepEqual(all[0]!.statuses, ['FAIL'], 'one verdict, whatever the phase');
    assert.equal(all[0]!.parallelOnly, false, 'it also failed outside the parallel range');
});

test('try counts non-test job failures separately from test ones', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            job('build-linux64/opt', 'TASKB', 'busted'),
            job('source-test-mozlint-eslint', 'TASKL', 'testfailed'),
            job('test-linux/opt-xpcshell', 'TASK1', 'success'),
        ]),
        fetchUrl: profileFetcher({}),
    });
    const result = json(streams.stdout);
    const other = result['otherFailedJobs'] as { jobName: string }[];
    // A lint job's name contains neither "mochitest" nor "xpcshell", so it is
    // not a test job and its profile carries no test markers.
    assert.equal(other.length, 2);
    assert.equal((result['permaFails'] as unknown[]).length, 0);
});

test('try counts a failed test job whose profile yielded nothing as unblamed', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        // No profile at all — expired, or never uploaded.
        fetchUrl: profileFetcher({}),
    });
    const result = json(streams.stdout);
    // Reporting 0 failures without saying a job could not be read would claim
    // the push is clean when it is not.
    assert.equal(result['unblamedJobCount'], 1);
});

/**
 * A job killed for exceeding `maxRunTime` leaves a *streamed* profile, and
 * saying it "could not be read" points the reader at the wrong problem.
 *
 * The artifact is newline-delimited JSON — one `{"type":"meta",…}` document,
 * then one per thread and per chunk — because the profiler never got to write
 * the single object a finished job uploads. Reading that format is out of
 * scope; what is in scope is saying which of the two things happened, since
 * "could not be read" sends someone looking for a broken download while the
 * real answer is the job's duration. Measured on try push 717fc67feaa071: 66
 * of 160 profiles, 34 to 50 MB each. Task `DVdj7ZQdTCijqjU02ol-Dw` is the
 * worked example — `maxRunTime` 5400 s, ran 5443 s, resolved `failed`.
 */
test('try blames a streamed profile on the job being killed, not on a read failure', async () => {
    const streams = captureStreams();
    const finished = profileWith([
        { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'boom', start: 1, end: 2 },
    ]);
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            job('test-linux/opt-xpcshell-killed', 'TASK1', 'testfailed'),
            job('test-linux/opt-xpcshell-truncated', 'TASK2', 'testfailed'),
        ]),
        fetchUrl: profileFetcher({
            // Two complete documents, newline-separated: the streamed shape.
            TASK1: `${JSON.stringify({ type: 'meta', interval: 1 })}\n${finished}\n`,
            // Genuinely unparseable, and nothing to do with streaming.
            TASK2: '{"threads": [',
        }),
    });
    assert.match(
        streams.stderr,
        /1 of 2 jobs were killed for exceeding their maximum duration/,
        'the killed job must be reported as killed'
    );
    assert.match(
        streams.stderr,
        /does not read that format/,
        'and the format must be named as out of scope, not as a failure'
    );
    // The two counts stay distinct: one killed, one genuinely unreadable.
    assert.match(
        streams.stderr,
        /1 of 2 job profiles could not be read/,
        'the truncated profile is still a read failure'
    );
    assert.doesNotMatch(
        streams.stderr,
        /2 of 2 job profiles could not be read/,
        'the killed job must not be counted as unreadable too'
    );
});

/**
 * The agent check suppresses *progress*, and a warning is not progress.
 *
 * This is the regression the suppression could most easily cause: the killed
 * jobs are why the answer below is a subset, so an agent that stops being told
 * reports a partial result as a whole one. Same fixture as the test above, run
 * with an agent environment, asserting the warnings survive and the progress
 * lines do not.
 */
test('an agent caller still gets the warnings that say why a result is partial', async () => {
    const streams = captureStreams();
    const finished = profileWith([
        { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'boom', start: 1, end: 2 },
    ]);
    await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        env: { CLAUDECODE: '1' },
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([
            job('test-linux/opt-xpcshell-killed', 'TASK1', 'testfailed'),
            job('test-linux/opt-xpcshell-truncated', 'TASK2', 'testfailed'),
        ]),
        fetchUrl: profileFetcher({
            TASK1: `${JSON.stringify({ type: 'meta', interval: 1 })}\n${finished}\n`,
            TASK2: '{"threads": [',
        }),
    });
    assert.match(
        streams.stderr,
        /1 of 2 jobs were killed for exceeding their maximum duration/,
        'a warning explaining an incomplete result must not be suppressed'
    );
    assert.match(
        streams.stderr,
        /1 of 2 job profiles could not be read/,
        'nor must the read-failure count'
    );
    assert.doesNotMatch(
        streams.stderr,
        /Looking up|Fetching jobs for push|job profiles \(one per/,
        'while the progress lines are gone'
    );
});

/**
 * The detector keys on the shape, so it cannot mistake an ordinary profile for
 * a streamed one — including the trailing-newline case, which is one document
 * and must stay readable.
 */
test('a profile with a trailing newline is not mistaken for a streamed one', async () => {
    const { isStreamedProfile } = await import('../cli/commands/try.ts');
    const finished = profileWith([
        { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'boom', start: 1, end: 2 },
    ]);
    assert.equal(isStreamedProfile(new TextEncoder().encode(finished)), false);
    assert.equal(isStreamedProfile(new TextEncoder().encode(`${finished}\n`)), false);
    // A truncated document followed by more is not the streamed shape either:
    // the first line has to parse on its own.
    assert.equal(isStreamedProfile(new TextEncoder().encode('{"threads": [\n{}')), false);
    // Two complete documents is.
    assert.equal(isStreamedProfile(new TextEncoder().encode(`{"type":"meta"}\n${finished}`)), true);
    // What follows the first document has to *be* a document. A profile with a
    // log line appended parses its first line and has trailing content, so
    // only the leading `{` separates it from the streamed shape — and it is a
    // genuine read failure, not a killed job.
    assert.equal(isStreamedProfile(new TextEncoder().encode('{"a":1}\nnot json')), false);
    assert.equal(isStreamedProfile(new TextEncoder().encode('{"a":1}\n[1,2]')), false);
    // No newline at all is not the streamed shape, whatever the content. The
    // check has to be on the newline rather than on what a slice happens to
    // parse as: `{}\t ` has no newline, and slicing to `newline` would hand
    // `JSON.parse` the string minus its last character, which parses.
    assert.equal(isStreamedProfile(new TextEncoder().encode('{}\t ')), false);
});

test('try --perma-only omits the other sections from the text output', async () => {
    const streams = captureStreams();
    await run({
        argv: ['try', 'abcdef123456', '--perma-only'],
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'novel', start: 1, end: 2 },
            ]),
        }),
    });
    assert.match(streams.stdout, /PERMA-FAILS/);
    assert.doesNotMatch(streams.stdout, /KNOWN INTERMITTENTS/);
});

test('try still answers when a central bucket cannot be read', async () => {
    const streams = captureStreams();
    const brokenCentral: DataSource = {
        name: 'broken',
        fetch(name) {
            return Promise.reject(new DataFetchError(name, 'upstream is down'));
        },
    };
    const code = await run({
        argv: ['try', 'abcdef123456', '--json'],
        streams,
        source: brokenCentral,
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        treeherder: fakeTreeherder([job('test-linux/opt-xpcshell', 'TASK1', 'testfailed')]),
        fetchUrl: profileFetcher({
            TASK1: profileWith([
                { type: 'Test', test: TEST_PATH, status: 'FAIL', message: 'x', start: 1, end: 2 },
            ]),
        }),
    });
    // Central history is an enrichment. Losing it must warn and downgrade,
    // not fail the command — but the warning has to be there, or a missing
    // comparison reads as "never failed on central".
    assert.equal(code, ExitCode.Success);
    assert.match(streams.stderr, /could not read central history/);
    const result = json(streams.stdout);
    const perma = result['permaFails'] as { central: unknown }[];
    assert.equal(perma.length, 1);
    assert.equal(perma[0]!.central, null);
});
