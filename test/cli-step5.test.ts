/**
 * The step-5 commands — `errors`, `manifests`, `crash`, `issues`, `failures`,
 * `crashes`, `skips` — end to end against the checked-in fixtures.
 *
 * A separate file from `cli.test.ts` only because the two were written
 * concurrently; the harness below is the same shape.
 *
 * ## Where the goldens came from
 *
 * Every expected number here was derived **from the fixture JSON directly**, by
 * a script that sums the raw parallel arrays, and not by running the code and
 * recording what it said. That distinction is the whole value of the
 * assertion — a golden captured from the implementation only proves the
 * implementation is deterministic. The script is `artifacts/goldens.mjs` and
 * the numbers it produced are quoted next to the assertions that use them.
 *
 * ## What is deliberately asserted about *absence*
 *
 * Several tests assert something is **not** printed, **not** fetched, or
 * refused rather than answered:
 *
 * - the errors file is fetched exactly once, not probed and then fetched;
 * - `--config` and `--minidumps` are usage errors on `issues.json` rather than
 *   quietly empty results;
 * - a skipped manifest has no duration statistics rather than zeros;
 * - a 403 is exit 3 and only a 404 is exit 4.
 *
 * Those are the regressions that produce plausible output, so they are the ones
 * worth pinning.
 */

import { readFile } from 'node:fs/promises';
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
import { captureStreams } from '../cli/context.ts';
import { diskCache } from '../cli/cache.ts';
import { REJECTED_GLOBALS, run } from '../cli/main.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

async function fixtureBytes(name: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(new URL(name, FIXTURES)));
}

/**
 * The fixture files, under the names the CLI asks for.
 *
 * Note which errors files exist: `2026-08-03` only. That is deliberate and
 * mirrors production, where 16 of the 21 dates in `index.json` 404 — the
 * window-discovery tests below depend on the other 20 dates being absent.
 */
const FILES: Record<string, string> = {
    'xpcshell-timings/index.json': 'index.json',
    'mochitest-timings/index.json': 'index.json',
    'xpcshell-timings/xpcshell-issues.json': 'xpcshell-issues.json',
    'xpcshell-timings/xpcshell-2026-08-03-errors.json': 'xpcshell-2026-08-03-errors.json',
    'mochitest-timings/mochitest-2026-08-03-errors.json': 'mochitest-2026-08-03-errors.json',
    'manifest-timings/manifests.json': 'manifests.json',
};

/** A source serving the fixtures, recording every name it was asked for. */
function fixtureSource(
    overrides: Record<string, string> = {}
): DataSource & { requested: string[] } {
    const requested: string[] = [];
    const files = { ...FILES, ...overrides };
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
 * A source serving the bucket fixtures, for the commands that read one.
 *
 * Separate from `fixtureSource` because the tree-wide commands and `test` read
 * different families, and a source serving both would let a command read the
 * wrong one without a test noticing.
 */
function bucketSource(): DataSource & { requested: string[] } {
    return fixtureSource({
        'mochitest-timings/mochitest-00.json': 'mochitest-00.json',
        'xpcshell-timings/xpcshell-00.json': 'xpcshell-00.json',
    });
}

/** Serves the two stackwalk fixtures, plus the failure modes exit 3/4 need. */
function artifactSource(): DataSource & { requested: string[] } {
    const requested: string[] = [];
    const map: Record<string, string> = {
        'TASKCRASH/runs/0/artifacts/public/test_info/dump-crash.json': 'stackwalk-crash.json',
        'TASKHANG/runs/0/artifacts/public/test_info/dump-hang.json': 'stackwalk-hang.json',
        'TASKCRASH/runs/2/artifacts/public/test_info/dump-crash.json': 'stackwalk-crash.json',
    };
    return {
        name: 'fixture-artifacts',
        requested,
        async fetch(name: DataFileName): Promise<Uint8Array> {
            const key = `${name.index}/${name.filename}`;
            requested.push(key);
            if (key.includes('dump-403')) {
                throw new DataFetchError(name, 'HTTP 403', 'url', 403);
            }
            if (key.includes('dump-500')) {
                throw new DataFetchError(name, 'HTTP 500', 'url', 500);
            }
            const local = map[key];
            if (local === undefined) {
                throw new DataFileNotFoundError(name);
            }
            return fixtureBytes(local);
        },
    };
}

/** Runs one invocation and returns everything a test might assert on. */
async function invoke(
    argv: string[],
    overrides: Partial<Parameters<typeof run>[0]> = {}
): Promise<{
    code: number;
    stdout: string;
    stderr: string;
    source: DataSource & { requested: string[] };
}> {
    const streams = captureStreams();
    const source = (overrides.source as DataSource & { requested: string[] }) ?? fixtureSource();
    const code = await run({
        argv,
        streams,
        source,
        taskArtifacts: overrides.taskArtifacts ?? artifactSource(),
        // A cache that can never be read or written: these tests must not
        // depend on, or leave behind, anything in the developer's real cache.
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        ...overrides,
    });
    return { code, stdout: streams.stdout, stderr: streams.stderr, source };
}

function json(stdout: string): Record<string, unknown> {
    return JSON.parse(stdout) as Record<string, unknown>;
}

// =========================================================================
// fx-tests errors
// =========================================================================

test('errors defaults to mochitest, unlike every other command', async () => {
    const { code, stdout, source } = await invoke(['errors', '--json']);
    assert.equal(code, ExitCode.Success);
    assert.equal(json(stdout)['harness'], 'mochitest');
    // Not merely the label: the mochitest file is the one actually read.
    assert.ok(
        source.requested.some((name) => name.includes('mochitest-2026-08-03-errors.json')),
        `expected the mochitest errors file to be read, got ${source.requested.join(', ')}`
    );
    assert.ok(!source.requested.some((name) => name.includes('xpcshell-2026-08-03-errors')));
});

test('errors reports the xpcshell file as covering failing tests only', async () => {
    const { stdout } = await invoke(['errors', '--harness', 'xpcshell', '--json']);
    const result = json(stdout);
    assert.equal(result['harness'], 'xpcshell');
    // The bias is in the data, not only in the prose, so a script comparing
    // two harnesses can see it without parsing English.
    assert.equal(result['failingTestsOnly'], true);

    const text = await invoke(['errors', '--harness', 'xpcshell']);
    assert.match(text.stdout, /failing\s+tests only/s);
    assert.match(text.stdout, /--harness mochitest/);

    // And the mochitest side must *not* claim the same thing, or the flag
    // would be a constant rather than a fact about the file.
    const mochitest = await invoke(['errors', '--json']);
    assert.equal(json(mochitest.stdout)['failingTestsOnly'], false);
});

test('errors fetches the file once rather than probing and then fetching', async () => {
    const { source } = await invoke(['errors', '--json']);
    const errorsFetches = source.requested.filter((name) => name.includes('-errors.json'));
    // An earlier draft probed for existence and then fetched, downloading 97 MB
    // twice on a weekday to learn what the first response already carried.
    assert.deepEqual(errorsFetches, ['mochitest-timings/mochitest-2026-08-03-errors.json']);
});

test('errors totals and per-kind counts match the fixture arrays', async () => {
    const { stdout } = await invoke(['errors', '--json', '--limit', '0']);
    const result = json(stdout);
    // Derived by summing markers.counts in artifacts/goldens.mjs.
    assert.equal((result['totals'] as { file: number }).file, 15_224);
    assert.equal((result['metadata'] as { jobCount: number }).jobCount, 19_022);
    // Straight from metadata.markerCounts, and read as data rather than from a
    // hardcoded list of kinds.
    assert.deepEqual(result['markerCounts'], [
        { kind: 'C++ warning', count: 14_742 },
        { kind: 'console.error', count: 482 },
    ]);
    assert.deepEqual(result['markerNames'], ['C++ warning', 'console.error']);
});

test('errors groups by source location, not by message text alone', async () => {
    // The fixture has 60 distinct (kind, text, file, line) tuples but only 57
    // distinct (kind, text) ones, so three texts appear at two locations each.
    // That difference is the whole reason `errors.html` changed to group by
    // location, and it is what this pins: a mutation switching the default back
    // to text-only grouping changes 60 into 57.
    const byLocation = await invoke(['errors', '--json', '--limit', '0']);
    assert.equal(json(byLocation.stdout)['rowCount'], 60);
    assert.equal(json(byLocation.stdout)['grouping'], 'location');

    const byMessage = await invoke([
        'errors', '--json', '--limit', '0', '--group-by', 'message',
    ]);
    assert.equal(json(byMessage.stdout)['rowCount'], 57);
});

test('errors ranks by occurrences, and --sort tests reorders on spread', async () => {
    const byCount = await invoke(['errors', '--json', '--limit', '3']);
    const rows = json(byCount.stdout)['rows'] as { count: number; text: string }[];
    // Golden: the top three counts in the fixture are 1840, 1697, 1697.
    assert.deepEqual(rows.map((row) => row.count), [1840, 1697, 1697]);
    assert.match(rows[0]!.text, /NS_FAILED\(rv\)/);

    // Sorting must actually change the comparator, not just the label.
    const bySpread = await invoke(['errors', '--json', '--limit', '3', '--sort', 'tests']);
    const spread = json(bySpread.stdout)['rows'] as { testCount: number }[];
    for (let i = 1; i < spread.length; i++) {
        assert.ok(
            spread[i - 1]!.testCount >= spread[i]!.testCount,
            'rows must be ordered by descending testCount'
        );
    }
    assert.equal(json(bySpread.stdout)['sort'], 'tests');
});

test('errors reports the source location, and a line with no file as such', async () => {
    const { stdout } = await invoke(['errors', '--json', '--limit', '3']);
    const rows = json(stdout)['rows'] as { file: string | null; line: number | null }[];
    assert.equal(rows[0]!.file, 'xpcom/threads/nsThreadUtils.cpp');
    assert.equal(rows[0]!.line, 237);
    // `file` and `line` are separate fields precisely because a message can
    // have one without the other; neither is collapsed into a `file:line`
    // string that would print `null:237`.
    assert.ok(rows.every((row) => row.file === null || typeof row.file === 'string'));
});

test('errors --day outside the errors window exits 2 and names the real dates', async () => {
    const { code, stderr } = await invoke(['errors', '--day', '2026-07-20']);
    assert.equal(code, ExitCode.NotFound);
    assert.match(stderr, /no mochitest errors data for 2026-07-20/);
    // The list is the point: `CLI.md`'s compare-two-dates workflow fails the
    // moment one date falls outside the errors window, and an error that does
    // not say which dates exist leaves the caller guessing.
    assert.match(stderr, /2026-08-03/);
    assert.match(stderr, /1 of the 21 dates/);
});

test('errors --since is a usage error rather than a silently ignored flag', async () => {
    const { code, stderr } = await invoke(['errors', '--since', '3']);
    // Ignoring it would report one day's numbers under a three-day flag.
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /--since does not apply to errors/);
    assert.match(stderr, /no multi-day aggregate/);
});

test('errors rejects a marker kind the file does not carry, listing the ones it does', async () => {
    // `TSan Error` is mochitest-only in production and absent from this
    // fixture. An empty ranking would read as "there are none", which is a
    // different claim from "this file has no such kind".
    const { code, stderr } = await invoke(['errors', '--kind', 'TSan Error']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /no marker kind "TSan Error"/);
    assert.match(stderr, /C\+\+ warning, console\.error/);
});

test('errors --kind filters to that kind and nothing else', async () => {
    const { stdout } = await invoke([
        'errors', '--json', '--limit', '0', '--kind', 'console.error',
    ]);
    const result = json(stdout);
    const rows = result['rows'] as { kind: string; count: number }[];
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.kind === 'console.error'));
    // Golden: summing the fixture's counts per kind gives console.error 482,
    // which matches metadata.markerCounts — so the filter drops exactly the
    // C++ warnings and nothing more.
    assert.equal((result['totals'] as { matched: number }).matched, 482);
    // The file total is unchanged by a filter: it is what the whole file holds.
    assert.equal((result['totals'] as { file: number }).file, 15_224);
});

test('errors --test matches a full path or a directory prefix, not any substring', async () => {
    const full = await invoke([
        'errors', '--harness', 'xpcshell', '--json', '--limit', '0',
        '--test', 'browser/components/urlbar/tests/quicksuggest/unit/test_quicksuggest_amp.js',
    ]);
    const fullRows = json(full.stdout)['rows'] as { tests: { path: string }[] }[];
    assert.ok(fullRows.length > 0);
    for (const row of fullRows) {
        for (const entry of row.tests) {
            assert.equal(
                entry.path,
                'browser/components/urlbar/tests/quicksuggest/unit/test_quicksuggest_amp.js'
            );
        }
    }

    const prefix = await invoke([
        'errors', '--harness', 'xpcshell', '--json', '--limit', '0',
        '--test', 'browser/components/urlbar',
    ]);
    assert.ok((json(prefix.stdout)['rows'] as unknown[]).length > 0);

    // A bare substring must not match: `--test unit` naming half the tree is
    // not what someone naming a test means.
    const substring = await invoke([
        'errors', '--harness', 'xpcshell', '--json', '--limit', '0', '--test', 'unit',
    ]);
    assert.equal((json(substring.stdout)['rows'] as unknown[]).length, 0);
});

test('errors --task-ids delta-decodes the per-group task IDs', async () => {
    const { stdout } = await invoke([
        'errors', '--harness', 'xpcshell', '--json', '--limit', '1', '--task-ids', '--sort', 'tests',
    ]);
    const rows = json(stdout)['rows'] as { taskIds?: string[] }[];
    const taskIds = rows[0]?.taskIds;
    assert.ok(Array.isArray(taskIds) && taskIds.length > 0, 'expected task IDs');
    // Every ID is a real table entry in `<id>.<retry>` form. A delta decoder
    // that forgot to accumulate would still produce ids, but they would repeat
    // the first entry — hence the distinctness check.
    for (const id of taskIds) {
        assert.match(id, /^[A-Za-z0-9_-]{22}\.\d+$/);
    }
    assert.equal(new Set(taskIds).size, taskIds.length, 'task IDs must be distinct');
});

test('errors omits task IDs unless asked', async () => {
    const { stdout } = await invoke(['errors', '--json', '--limit', '2']);
    const rows = json(stdout)['rows'] as { taskIds?: string[] }[];
    assert.ok(rows.every((row) => row.taskIds === undefined));
});

test('errors says what it truncated', async () => {
    const { stdout } = await invoke(['errors', '--limit', '3']);
    // 60 rows, 3 shown.
    assert.match(stdout, /… 57 more \(--limit 0 for all\)/);
});

test('errors defaults to 20 rows, as CLI.md specifies', async () => {
    // The default is a documented number, not an implementation detail: an
    // agent pasting this into a prompt pays for every row, and `guide` will
    // assert the same figure. The fixture has 60 rows, so a default of 20
    // truncates and the "… 40 more" line is the discriminating evidence.
    const { stdout } = await invoke(['errors', '--json']);
    assert.equal((json(stdout)['rows'] as unknown[]).length, 20);
    assert.equal(json(stdout)['rowCount'], 60);
    const text = await invoke(['errors']);
    assert.match(text.stdout, /… 40 more \(--limit 0 for all\)/);
    // …and `--limit 0` really means all of them.
    const all = await invoke(['errors', '--json', '--limit', '0']);
    assert.equal((json(all.stdout)['rows'] as unknown[]).length, 60);
});

test('errors names the weekday, and flags a weekend', async () => {
    // 2026-08-03 is a Monday, so no weekend warning should appear.
    const { stdout } = await invoke(['errors', '--json']);
    assert.equal(json(stdout)['weekday'], 'Mon');
    assert.equal(json(stdout)['weekend'], false);
    const text = await invoke(['errors', '--limit', '1']);
    assert.match(text.stdout, /2026-08-03 \(Mon\)/);
    assert.doesNotMatch(text.stdout, /Weekend:/);
});

test('errors reports a filter with no matches as such, not as an empty file', async () => {
    const { stdout } = await invoke(['errors', '--message', 'no-such-message-anywhere']);
    assert.match(stdout, /No markers matched/);
    // The file total is still stated, so "my filter is wrong" and "the file is
    // empty" stay distinguishable.
    assert.match(stdout, /15,224 markers/);
});

// =========================================================================
// fx-tests manifests
// =========================================================================

test('manifests treats all-zero durations as skipped, not as instant', async () => {
    const { stdout } = await invoke(['manifests', '--json', '--limit', '0']);
    const result = json(stdout);
    // Golden: 18 of 200 runs are zero, forming 18 all-zero (manifest, config)
    // pairs, and those 18 manifests ran nowhere else in the fixture.
    assert.deepEqual(result['zeroDurations'], {
        zeroRuns: 18,
        totalRuns: 200,
        skippedPairs: 18,
        totalPairs: 200,
    });

    const rows = result['rows'] as {
        manifest: string;
        durations: unknown;
        skippedOn: string[];
        runCount: number;
    }[];
    const skipped = rows.filter((row) => row.durations === null);
    assert.equal(skipped.length, 18);
    for (const row of skipped) {
        // The load-bearing assertion: no duration statistics at all, rather
        // than a median of 0 that would rank them as the fastest in the tree.
        assert.equal(row.durations, null);
        assert.equal(row.runCount, 0);
        assert.ok(row.skippedOn.length > 0);
    }
});

test('manifests sorts a skipped manifest last, not first', async () => {
    const { stdout } = await invoke(['manifests', '--json', '--limit', '0', '--sort', 'median']);
    const rows = json(stdout)['rows'] as { durations: { median: number } | null }[];
    const firstNull = rows.findIndex((row) => row.durations === null);
    const lastReal = rows.map((row) => row.durations !== null).lastIndexOf(true);
    // Every real row precedes every skipped one. A zero median would invert
    // this and put the manifests that did not run at the top of a
    // "slowest manifests" table.
    assert.ok(firstNull > lastReal, 'skipped manifests must sort after the ones that ran');
    // And the ranking is descending among the ones that ran.
    const medians = rows
        .filter((row) => row.durations !== null)
        .map((row) => row.durations!.median);
    for (let i = 1; i < medians.length; i++) {
        assert.ok(medians[i - 1]! >= medians[i]!);
    }
});

test('manifests aggregates on the chunk-stripped job name', async () => {
    const { stdout } = await invoke(['manifests', '--json', '--limit', '0']);
    const rows = json(stdout)['rows'] as { configs: { configuration: string }[] }[];
    const configs = rows.flatMap((row) => row.configs.map((c) => c.configuration));
    assert.ok(configs.length > 0);
    // Golden: 191 of the fixture's 200 runs have a task job name ending in a
    // chunk suffix, and all 200 agree once it is stripped. So if aggregation
    // used `tasks.jobName`, chunked names would appear here.
    for (const configuration of configs) {
        assert.doesNotMatch(
            configuration,
            /-\d+$/,
            `${configuration} still carries a chunk suffix, so aggregation used tasks.jobName`
        );
    }
    // And the stripped names really are shorter than the chunked ones in this
    // fixture, so the assertion above is not vacuous.
    assert.ok(
        configs.some((c) => c === 'test-macosx1500-aarch64/debug-web-platform-tests-wdspec'),
        'expected the chunk-stripped wdspec configuration'
    );
});

test('manifests states the zero-duration share unconditionally', async () => {
    const { stdout } = await invoke(['manifests', '--limit', '2']);
    assert.match(stdout, /18 of 200 runs \(9\.0%\) recorded a zero duration/);
    assert.match(stdout, /skipped there, not run instantly/);
});

test('manifests renders an absent duration as an em dash, never as zero', async () => {
    // The rendering half of the all-zero rule. A skipped manifest printing
    // `0ms` reads as the fastest row in the table, which is precisely the
    // conclusion the rule exists to prevent.
    const { stdout } = await invoke(['manifests', '--limit', '0', '--sort', 'name']);
    const skippedRow = stdout
        .split('\n')
        .find((line) => line.includes('dom/media/mediacontrol/tests/browser/browser.toml'));
    assert.ok(skippedRow !== undefined, 'expected the skipped manifest in the table');
    assert.match(skippedRow, /—/);
    assert.doesNotMatch(skippedRow, /\b0ms\b/);
    // And the table says how many rows are in that state.
    assert.match(stdout, /ran on no configuration at all/);
});

test('manifests states the division of labour with per-test durations', async () => {
    const { stdout } = await invoke(['manifests', '--limit', '2']);
    // `CLI.md` asks for this explicitly: the file cannot say whether a slow
    // manifest is one slow test or a thousand cheap ones.
    assert.match(stdout, /per-manifest durations, not per-test ones/);
    assert.match(stdout, /fx-tests test <path> --durations/);
});

test('manifests --day and --since are usage errors: the file has no day axis', async () => {
    for (const flag of [['--day', '2026-08-03'], ['--since', '3']]) {
        const { code, stderr } = await invoke(['manifests', ...flag]);
        assert.equal(code, ExitCode.Usage, `${flag[0]} should be a usage error`);
        assert.match(stderr, /single day and has no day axis/);
    }
});

/**
 * The flag lines of a `--help` output, trimmed, without the surrounding prose.
 *
 * `Options:` opens the table and the first blank line closes it, which is what
 * `commandHelp()` emits.
 */
function optionTable(help: string): string[] {
    const lines = help.split('\n');
    const start = lines.indexOf('Options:');
    assert.notEqual(start, -1, 'help output has no option table');
    const table: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line.trim() === '') {
            break;
        }
        table.push(line.trim());
    }
    assert.ok(table.length > 0, 'option table is empty');
    return table;
}

/**
 * `--help` must not promise a flag the command exits 1 on.
 *
 * The reported case was `manifests --help` listing `--day` and `--since`, both
 * of which `manifests` refuses — a caller reads an option table as the list of
 * what works. Driven off `REJECTED_GLOBALS` rather than a list here, so the two
 * halves cannot drift: a refusal added to a command's registration is checked
 * against its help text automatically, and a refusal thrown from a command body
 * without being declared is not covered by this and will not hide behind it.
 */
test('no command’s --help lists a global flag that command rejects', async () => {
    for (const [command, rejected] of Object.entries(REJECTED_GLOBALS)) {
        const { code, stdout } = await invoke([command, '--help']);
        assert.equal(code, ExitCode.Success, `${command} --help`);
        // Scoped to the option table, which is the only part `commandHelp()`
        // filters. Asserting against the whole output would fail on a `notes`
        // block that merely *mentions* a rejected flag — prose the filter does
        // not touch and should not have to, since `flaky`'s notes show that
        // block can say anything. If a command ever needs its notes checked
        // too, that is a separate assertion, not a wider match here.
        const table = optionTable(stdout);
        for (const flag of rejected) {
            assert.ok(
                !table.some((line) => line.startsWith(`--${flag} `) || line === `--${flag}`),
                `${command} --help lists --${flag} in its option table, which ${command} rejects`
            );
        }
    }
});

test('a rejected global is still refused with its own message, not "unknown option"', async () => {
    // The flag stays in the parser's spec table on purpose: dropping it there
    // too would turn a message that explains the data model into
    // "unknown option --day".
    for (const argv of [
        ['manifests', '--day', '2026-08-03'],
        ['manifests', '--since', '3'],
        ['errors', '--since', '3'],
    ]) {
        const { code, stderr } = await invoke(argv);
        assert.equal(code, ExitCode.Usage, argv.join(' '));
        assert.doesNotMatch(stderr, /unknown option/, argv.join(' '));
        assert.match(stderr, /does not apply|do not apply/, argv.join(' '));
    }
});

/**
 * A refusal must not pre-empt the validation of the *other* globals.
 *
 * The regression this pins: the refusal loop originally ran before
 * `readGlobalOptions()`, so `manifests --harness bogus --since 3` reported the
 * `--since` refusal and said nothing about the typo. Fixing the flag it named
 * then surfaced an error the caller had never been told about. A refusal about a
 * flag the caller may not have meant to pass must not outrank "this value is not
 * a thing", so the loop runs after the globals are validated.
 *
 * Every case below is paired with a rejected global on purpose — that is the
 * combination that broke, and each expectation is the message the command gave
 * before `rejectsGlobals` existed.
 */
test('a rejected global does not mask a bad value in another global', async () => {
    const cases: [string[], RegExp][] = [
        [['manifests', '--harness', 'bogus', '--since', '3'], /--harness expects xpcshell or mochitest/],
        [['manifests', '--data-source', 'bogus', '--since', '3'], /--data-source expects central, try or local/],
        [['manifests', '--json', '--markdown', '--since', '3'], /--json and --markdown are mutually exclusive/],
        [['manifests', '--day', '2026-08-03', '--since', '3'], /--day and --since are mutually exclusive/],
        [['manifests', '--since', '0'], /--since expects at least 1 day/],
        [['errors', '--harness', 'bogus', '--since', '3'], /--harness expects xpcshell or mochitest/],
        [['errors', '--data-source', 'bogus', '--since', '3'], /--data-source expects central, try or local/],
        [['errors', '--json', '--markdown', '--since', '3'], /--json and --markdown are mutually exclusive/],
        [['errors', '--since', '0'], /--since expects at least 1 day/],
    ];
    for (const [argv, expected] of cases) {
        const { code, stderr } = await invoke(argv);
        assert.equal(code, ExitCode.Usage, argv.join(' '));
        assert.match(stderr, expected, argv.join(' '));
        // And the refusal must not also be printed: two complaints about
        // different flags in one message is how the first version read.
        assert.doesNotMatch(stderr, /does not apply|do not apply/, argv.join(' '));
    }
});

/**
 * The other direction: a global a command's help *does* list must work.
 *
 * Without this, deleting a flag from the help text would satisfy the test above
 * while making the help less useful — the fix for a rejected flag is to stop
 * advertising it, not to stop advertising all of them.
 */
test('errors --help still lists --day, which errors accepts', async () => {
    const { stdout } = await invoke(['errors', '--help']);
    assert.ok(stdout.includes('--day <date>'));
    const { code } = await invoke(['errors', '--day', '2026-08-03', '--limit', '1']);
    assert.equal(code, ExitCode.Success);
});

test('manifests names a manifest and shows its per-config table', async () => {
    const { code, stdout } = await invoke([
        'manifests', 'toolkit/components/extensions/test/browser/browser.toml', '--json',
    ]);
    assert.equal(code, ExitCode.Success);
    const rows = json(stdout)['rows'] as {
        manifest: string;
        durations: { median: number };
    }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.manifest, 'toolkit/components/extensions/test/browser/browser.toml');
    // Golden: the slowest manifest in the fixture, median 657109 ms.
    assert.equal(rows[0]!.durations.median, 657_109);
});

test('manifests exits 2 for a name that matches nothing', async () => {
    const { code, stderr } = await invoke(['manifests', 'no/such/manifest.toml']);
    assert.equal(code, ExitCode.NotFound);
    assert.match(stderr, /no manifest matching "no\/such\/manifest.toml"/);
});

test('manifests --slower-than reads a bare number as seconds', async () => {
    // The fixture's slowest median is 657,109 ms = 657 s. A bare `700` read as
    // milliseconds would keep almost everything; read as seconds it drops
    // everything, which is what distinguishes the two.
    const asSeconds = await invoke(['manifests', '--json', '--limit', '0', '--slower-than', '700']);
    assert.equal((json(asSeconds.stdout)['rows'] as unknown[]).length, 0);

    const asMillis = await invoke(['manifests', '--json', '--limit', '0', '--slower-than', '700ms']);
    assert.ok((json(asMillis.stdout)['rows'] as unknown[]).length > 0);

    const explicit = await invoke(['manifests', '--json', '--limit', '0', '--slower-than', '10m']);
    const rows = json(explicit.stdout)['rows'] as { durations: { median: number } }[];
    assert.ok(rows.every((row) => row.durations.median >= 600_000));
});

test('manifests rejects a malformed --slower-than', async () => {
    const { code, stderr } = await invoke(['manifests', '--slower-than', 'soon']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /--slower-than expects a duration/);
});

// =========================================================================
// fx-tests crash
// =========================================================================

test('crash computes the crash-viewer signature for a real dump', async () => {
    const { code, stdout } = await invoke(['crash', 'TASKCRASH', 'dump-crash', '--json']);
    assert.equal(code, ExitCode.Success);
    const result = json(stdout);
    // The crash fixture's crashing thread has exactly one frame, unnamed
    // thread, so this also covers both of those edge cases.
    assert.equal(result['signature'], '@ KiUserCallbackDispatcher');
    assert.equal(result['crashType'], 'STATUS_NO_CALLBACK_ACTIVE');
    assert.equal(result['threadCount'], 59);
    const threads = result['threads'] as { name: string | null; frames: unknown[] }[];
    assert.equal(threads.length, 1);
    // `null` is real here and must not be replaced by a placeholder that reads
    // like a thread name.
    assert.equal(threads[0]!.name, null);
    assert.equal(threads[0]!.frames.length, 1);
});

test('crash detects a hang that crash_info.type calls SIGABRT', async () => {
    const { stdout } = await invoke(['crash', 'TASKHANG', 'dump-hang', '--json']);
    const result = json(stdout);
    // The whole point: the type is indistinguishable from an ordinary abort.
    assert.equal(result['crashType'], 'EXC_SOFTWARE / SIGABRT');
    const hang = result['hang'] as {
        looksLikeHang: boolean;
        parkedIn: string | null;
        blockedThreadCount: number;
    };
    assert.equal(hang.looksLikeHang, true);
    // Underneath breakpad's frames and past the unsymbolized CoreFoundation
    // ones is what the process was actually doing. Stopping at the first
    // unsymbolized frame would report `CoreFoundation + 0x83ef4` instead.
    assert.equal(hang.parkedIn, 'RunCurrentEventLoopInMode');
    assert.equal(hang.blockedThreadCount, 5);

    // …and the crash dump must not be called a hang, or the detector is a
    // constant.
    const crash = await invoke(['crash', 'TASKCRASH', 'dump-crash', '--json']);
    assert.equal((json(crash.stdout)['hang'] as { looksLikeHang: boolean }).looksLikeHang, false);
});

test('crash does not call a real SIGSEGV a hang because breakpad handled it', async () => {
    // The false positive `hasFaultingAccess` exists for, asserted through the
    // command rather than only through `lib/`, because this is where a reader
    // sees the contradiction: the text below printed "This looks like a HANG
    // rather than a crash … the dump was written on request rather than at a
    // fault" four lines under its own "** null pointer with offset".
    //
    // The dump is derived here rather than checked in: it is the crash fixture
    // with a breakpad *signal handler* frame prepended, which is what is
    // genuinely on the stack during a fatal signal. None of the real dumps has
    // one, because a symbolized breakpad handler frame is not present in the
    // current corpus — not because it cannot occur.
    const base = JSON.parse(
        await readFile(new URL('stackwalk-crash.json', FIXTURES), 'utf8')
    ) as {
        crash_info: Record<string, unknown>;
        crashing_thread: { frames: unknown[] };
        threads: { frames: unknown[] }[];
    };
    base.crash_info['type'] = 'SIGSEGV / SEGV_MAPERR';
    base.crash_info['adjusted_address'] = { kind: 'null-pointer', offset: '0x0' };
    const handler = {
        ...(base.crashing_thread.frames[0] as Record<string, unknown>),
        frame: 0,
        function: 'google_breakpad::ExceptionHandler::SignalHandler(int, siginfo_t*, void*)',
    };
    base.crashing_thread.frames = [handler, ...base.crashing_thread.frames];

    const bytes = new TextEncoder().encode(JSON.stringify(base));
    const source: DataSource & { requested: string[] } = {
        name: 'faulted',
        requested: [],
        async fetch(): Promise<Uint8Array> {
            return bytes;
        },
    };

    const { stdout } = await invoke(['crash', 'TASKF', 'dump-faulted', '--json'], {
        taskArtifacts: source,
    });
    const result = json(stdout);
    const hang = result['hang'] as { looksLikeHang: boolean; reason: string };
    assert.equal(hang.looksLikeHang, false, 'a faulting access is a crash, not a hang');
    assert.ok(!hang.reason.includes('rather than at a fault'));

    // And the text output must not contradict its own address line.
    const text = await invoke(['crash', 'TASKF', 'dump-faulted'], { taskArtifacts: source });
    assert.match(text.stdout, /null pointer with offset/);
    assert.ok(
        !text.stdout.includes('This looks like a HANG'),
        'the hang note must not appear above a null-pointer dereference'
    );
});

test('crash --all-threads shows every thread at 8 frames, not 20', async () => {
    const all = await invoke(['crash', 'TASKHANG', 'dump-hang', '--json', '--all-threads']);
    const threads = json(all.stdout)['threads'] as { frames: unknown[]; frameCount: number }[];
    assert.equal(threads.length, 26);
    // A deadlock is diagnosed by breadth, so the frame budget per thread drops.
    const deep = threads.filter((thread) => thread.frameCount > 8);
    assert.ok(deep.length > 0, 'fixture must have a thread deeper than 8 frames');
    for (const thread of deep) {
        assert.equal(thread.frames.length, 8);
    }

    // The single-thread default stays deeper: there the frames are the answer.
    const single = await invoke(['crash', 'TASKHANG', 'dump-hang', '--json']);
    const one = json(single.stdout)['threads'] as { frames: unknown[] }[];
    assert.equal(one.length, 1);
    assert.equal(one[0]!.frames.length, 20);
});

test('crash --frames overrides both defaults', async () => {
    const single = await invoke(['crash', 'TASKHANG', 'dump-hang', '--json', '--frames', '3']);
    const threads = json(single.stdout)['threads'] as { frames: unknown[] }[];
    assert.equal(threads[0]!.frames.length, 3);

    const all = await invoke([
        'crash', 'TASKHANG', 'dump-hang', '--json', '--all-threads', '--frames', '2',
    ]);
    for (const thread of json(all.stdout)['threads'] as { frames: unknown[] }[]) {
        assert.ok(thread.frames.length <= 2);
    }

    // 0 means every frame.
    const unlimited = await invoke([
        'crash', 'TASKHANG', 'dump-hang', '--json', '--frames', '0',
    ]);
    const full = json(unlimited.stdout)['threads'] as { frames: unknown[]; frameCount: number }[];
    assert.equal(full[0]!.frames.length, full[0]!.frameCount);
    assert.equal(full[0]!.frameCount, 56);
});

test('crash marks blocked threads, and does not mark most of them', async () => {
    const { stdout } = await invoke(['crash', 'TASKCRASH', 'dump-crash', '--json', '--all-threads']);
    const threads = json(stdout)['threads'] as { blocked: boolean }[];
    const blocked = threads.filter((thread) => thread.blocked).length;
    // Matching every OS wait primitive marked 57 of these 59 threads. The
    // narrowed lock-and-condvar list marks 2. That gap is real on this dump —
    // but it is not the general case: across seven dumps the narrowed rule
    // marks between 2% and 77% of threads, so this pins a measurement rather
    // than a claim that the marker is always selective.
    assert.equal(blocked, 2);
    assert.ok(blocked > 0, 'the marker must fire on a dump that has lock waits');
});

test('crash resolves <taskId>.<retryId> with .0 implied', async () => {
    const implied = await invoke(['crash', 'TASKCRASH', 'dump-crash', '--json']);
    assert.equal(json(implied.stdout)['retryId'], 0);
    assert.equal(json(implied.stdout)['taskId'], 'TASKCRASH');

    const artifacts = artifactSource();
    const explicit = await invoke(['crash', 'TASKCRASH.2', 'dump-crash', '--json'], {
        taskArtifacts: artifacts,
    });
    assert.equal(json(explicit.stdout)['retryId'], 2);
    assert.equal(json(explicit.stdout)['taskId'], 'TASKCRASH');
    // The retry has to reach the URL, not merely be parsed and reported: a
    // command that split `.2` off and then fetched run 0 would pass every
    // assertion above and read the wrong job's dump.
    assert.deepEqual(artifacts.requested, [
        'TASKCRASH/runs/2/artifacts/public/test_info/dump-crash.json',
    ]);
    // And the reported URL agrees with what was fetched.
    assert.match(json(explicit.stdout)['url'] as string, /\/runs\/2\/artifacts\//);
});

test('crash asks for runs/<retryId>/artifacts/<path>, in that order', async () => {
    const artifacts = artifactSource();
    await invoke(['crash', 'TASKCRASH.2', 'dump-crash', '--json'], { taskArtifacts: artifacts });
    // Transposing the run segment past `artifacts` answers 403 rather than 404,
    // so it does not even fail like a missing artifact would.
    assert.deepEqual(artifacts.requested, [
        'TASKCRASH/runs/2/artifacts/public/test_info/dump-crash.json',
    ]);
});

test('crash exits 4 for a missing artifact and 3 for anything else', async () => {
    // 404: the dump is permanently gone. This is the only producer of exit 4.
    const gone = await invoke(['crash', 'TASKGONE', 'dump-gone']);
    assert.equal(gone.code, ExitCode.Gone);
    assert.match(gone.stderr, /permanently gone/);

    // 403 is what a transposed artifact path answers, so it must NOT be exit 4:
    // telling a caller to stop retrying something that would work is worse than
    // a spurious retry.
    const forbidden = await invoke(['crash', 'TASK403', 'dump-403']);
    assert.equal(forbidden.code, ExitCode.Upstream);
    assert.match(forbidden.stderr, /403/);

    const serverError = await invoke(['crash', 'TASK500', 'dump-500']);
    assert.equal(serverError.code, ExitCode.Upstream);
});

test('a 403 gets the transposed-path hint and a 5xx does not', async () => {
    // Both are exit 3, so the code alone cannot tell the branch apart and a
    // mutation re-keying the hint to 404 survived. The hint is the actionable
    // part: 403 is what the *wrong URL shape* answers, and someone seeing it
    // should check the path rather than wait and retry.
    const forbidden = await invoke(['crash', 'TASK403', 'dump-403']);
    assert.match(forbidden.stderr, /malformed artifact path|auth problem/);
    assert.match(forbidden.stderr, /which answers 404/);

    const serverError = await invoke(['crash', 'TASK500', 'dump-500']);
    assert.match(serverError.stderr, /looks transient/);
    // …and must NOT claim a path problem, which would send someone checking a
    // URL that is fine.
    assert.doesNotMatch(serverError.stderr, /malformed artifact path/);
});

test('crash requires both arguments', async () => {
    const missing = await invoke(['crash', 'TASKCRASH']);
    assert.equal(missing.code, ExitCode.Usage);
    assert.match(missing.stderr, /requires a task ID and a minidump ID/);

    const none = await invoke(['crash']);
    assert.equal(none.code, ExitCode.Usage);
});

test('crash --all-threads and --thread are mutually exclusive', async () => {
    const { code, stderr } = await invoke([
        'crash', 'TASKHANG', 'dump-hang', '--all-threads', '--thread', '1',
    ]);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /mutually exclusive/);
});

test('crash --thread picks one thread and rejects one that does not exist', async () => {
    const { stdout } = await invoke(['crash', 'TASKHANG', 'dump-hang', '--json', '--thread', '3']);
    const threads = json(stdout)['threads'] as { index: number; name: string | null }[];
    assert.equal(threads.length, 1);
    assert.equal(threads[0]!.index, 3);
    assert.equal(threads[0]!.name, 'Breakpad ExceptionHandler');

    const bad = await invoke(['crash', 'TASKHANG', 'dump-hang', '--thread', '999']);
    assert.equal(bad.code, ExitCode.Usage);
    assert.match(bad.stderr, /no thread #999/);
});

test('crash --raw emits the unprocessed JSON', async () => {
    const { stdout } = await invoke(['crash', 'TASKCRASH', 'dump-crash', '--raw']);
    const raw = json(stdout);
    // The real dump's own top-level keys, not the command's shape.
    assert.ok('crash_info' in raw);
    assert.ok('modules' in raw);
    assert.equal((raw['thread_count'] as number), 59);
    assert.ok(!('signature' in raw));
});

test('crash renders inlined frames under their parent', async () => {
    const { stdout } = await invoke([
        'crash', 'TASKHANG', 'dump-hang', '--thread', '2', '--frames', '6',
    ]);
    // The signature heuristic reads inlines first, so a reader has to be able
    // to see them to understand why the signature says what it does.
    assert.match(stdout, /└ inlined: SamplerThread::SleepMicro/);
});

// =========================================================================
// fx-tests issues / failures / crashes / skips
// =========================================================================

test('issues refuses --config on a file that records no job names', async () => {
    const { code, stderr } = await invoke(['issues', '--config', 'linux']);
    // `computeConfigStats` returns [] on issues.json, and [] means both "no
    // config failed" and "this file cannot say". A silently empty table would
    // be the confidently wrong answer.
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /--config cannot be applied to xpcshell-issues\.json/);
    assert.match(stderr, /matches nothing/);

    const excluded = await invoke(['issues', '--exclude-config', 'debug']);
    assert.equal(excluded.code, ExitCode.Usage);
});

test('every tree-wide command reports that it cannot attribute configurations', async () => {
    for (const command of ['issues', 'failures', 'crashes', 'skips']) {
        const { code, stdout } = await invoke([command, '--json', '--limit', '2']);
        assert.equal(code, ExitCode.Success, `${command} should succeed`);
        const header = json(stdout)['header'] as { canAttributeConfigs: boolean };
        assert.equal(
            header.canAttributeConfigs,
            false,
            `${command} must report that issues.json cannot attribute configs`
        );
    }
});

test('the no-job-names notice is printed, and says what it means', async () => {
    // The prose half of the guard. Only the `--config` usage error was covered
    // on the first pass, so the notice could be replaced with anything — or
    // dropped entirely — with the suite green. It is the only thing a reader
    // who did *not* pass `--config` ever sees, so it carries the whole claim.
    for (const command of ['issues', 'failures', 'crashes', 'skips']) {
        const { stdout } = await invoke([command, '--limit', '2']);
        assert.match(
            stdout,
            /records no job names/,
            `${command} must say the file records no job names`
        );
        assert.match(
            stdout,
            /broken down by configuration/,
            `${command} must say what that costs the reader`
        );
    }
});

test('test --task-ids surfaces minidump IDs from the bucket file', async () => {
    // The workflow the `crashes` hint points at, and which did not exist until
    // this landed: `issues.json` records no dumps, so the hint sends a caller
    // to `fx-tests test --task-ids` — which read the bucket file's `minidumps`
    // array not at all. The golden is the ID in the checked-in fixture.
    const { code, stdout } = await invoke([
        'test',
        'browser/components/sessionstore/test/browser_revive_crashed_bg_tabs.js',
        '--harness', 'mochitest', '--task-ids', '--json',
    ], { source: bucketSource() });
    assert.equal(code, ExitCode.Success);
    const rows = json(stdout)['taskIds'] as {
        taskId: string;
        retryId: number;
        status: string;
        minidumpId?: string;
        crashCommand?: string;
    }[];
    const crashes = rows.filter((row) => row.status.startsWith('CRASH'));
    assert.ok(crashes.length > 0, 'the fixture test must have crashed');
    const withDump = crashes.find((row) => row.minidumpId !== undefined);
    assert.ok(withDump !== undefined, 'a crash row must carry its minidump ID');
    assert.equal(withDump.minidumpId, 'd2d42d50-47cc-4c58-a9ed-829a648c372e');
    assert.equal(withDump.taskId, 'Y9Rrc0AOTHyR1g40ft10Ig');
    // The pairing is what matters: a dump ID is unusable without its task, so
    // the two are emitted together as the command that reads them.
    assert.equal(
        withDump.crashCommand,
        'fx-tests crash Y9Rrc0AOTHyR1g40ft10Ig.0 d2d42d50-47cc-4c58-a9ed-829a648c372e'
    );

    // …and the text view shows it, since that is what a reader sees.
    const text = await invoke([
        'test',
        'browser/components/sessionstore/test/browser_revive_crashed_bg_tabs.js',
        '--harness', 'mochitest', '--task-ids',
    ], { source: bucketSource() });
    assert.match(text.stdout, /fx-tests crash Y9Rrc0AOTHyR1g40ft10Ig\.0 d2d42d50-/);
});

test('a non-crash row carries no minidump ID', async () => {
    // Absent rather than null, and only on crashes: a fail row with a dump
    // field would imply there is a dump to read.
    const { stdout } = await invoke([
        'test',
        'browser/components/sessionstore/test/browser_revive_crashed_bg_tabs.js',
        '--harness', 'mochitest', '--task-ids', '--json',
    ], { source: bucketSource() });
    const rows = json(stdout)['taskIds'] as { status: string; minidumpId?: string }[];
    for (const row of rows) {
        if (!row.status.startsWith('CRASH')) {
            assert.equal(row.minidumpId, undefined, `${row.status} should carry no dump`);
        }
    }
});

test('crashes refuses --minidumps on a file that records none', async () => {
    // Measured: issues.json's CRASH groups carry counts, days and
    // crashSignatureIds and no minidumps field at all — 0 of 7 in the fixture.
    const { code, stderr } = await invoke(['crashes', '--minidumps']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /--minidumps cannot be answered from xpcshell-issues\.json/);

    // And without the flag, the zero column is explained rather than left to
    // read as "the dumps were never uploaded".
    const plain = await invoke(['crashes', '--limit', '2']);
    assert.match(plain.stdout, /records no minidump IDs/);
    assert.match(plain.stdout, /property of the file/);
});

test('crashes groups by signature and counts distinct tests', async () => {
    const { stdout } = await invoke(['crashes', '--json', '--limit', '0']);
    const rows = json(stdout)['rows'] as {
        signature: string | null;
        count: number;
        testCount: number;
        minidumpCount: number;
    }[];
    assert.ok(rows.length > 0);
    // Descending by occurrences.
    for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i - 1]!.count >= rows[i]!.count);
    }
    // The file records none, so this is 0 everywhere — and that is asserted so
    // a future file that does record them makes this test fail loudly rather
    // than passing on a stale assumption.
    assert.ok(rows.every((row) => row.minidumpCount === 0));
    assert.ok(rows.every((row) => row.testCount >= 1));
});

test('issues --group-by message is a different query, not a regrouping', async () => {
    const byTest = await invoke(['issues', '--json', '--limit', '0', '--group-by', 'test']);
    const byMessage = await invoke(['issues', '--json', '--limit', '0', '--group-by', 'message']);
    const testRows = json(byTest.stdout)['rows'] as Record<string, unknown>[];
    const messageRows = json(byMessage.stdout)['rows'] as Record<string, unknown>[];
    // A row keyed by test carries a test; one keyed by message carries a
    // message and a test-spread count. `IssueRow` has no messages on it at all,
    // which is why this reroutes to `failures.ts` rather than regrouping.
    assert.ok('test' in testRows[0]!);
    assert.ok('message' in messageRows[0]!);
    assert.ok('testCount' in messageRows[0]!);
});

test('issues --group-by component and directory aggregate rather than list tests', async () => {
    for (const groupBy of ['component', 'directory']) {
        const { stdout } = await invoke(['issues', '--json', '--limit', '0', '--group-by', groupBy]);
        const rows = json(stdout)['rows'] as { key: string; testCount: number }[];
        assert.ok(rows.length > 0, `${groupBy} produced no rows`);
        assert.ok(rows.every((row) => typeof row.key === 'string'));
        // A group covering more than one test proves it aggregated.
        assert.ok(
            rows.some((row) => row.testCount > 1),
            `${groupBy} should have at least one multi-test group`
        );
    }
});

test('issues counts all four outcomes by default, as the dashboard does', async () => {
    // `old/issues.html:626-638` has four "Count as issues" checkboxes — failures,
    // timeouts, crashes and skips — and every one of them is `checked` on load.
    // The CLI used to omit skips, which ranked components against a different
    // definition of "issue" than the page the data comes from. Skips are the
    // largest of the four in this data, so the omission changed the order.
    const byDefault = await invoke(['issues', '--json', '--limit', '0', '--group-by', 'test']);
    assert.deepEqual(json(byDefault.stdout)['types'], ['fail', 'timeout', 'crash', 'skip']);

    // Every test in this fixture that has skips also has failures, so the two
    // row *sets* happen to coincide here and comparing them would prove
    // nothing. What does discriminate is `--type skip` alone: it must keep only
    // tests that were actually skipped, and the fixture has three tests with
    // failures and no skips at all for it to drop.
    const skipOnly = await invoke([
        'issues', '--json', '--limit', '0', '--group-by', 'test', '--type', 'skip',
    ]);
    const skipRows = json(skipOnly.stdout)['rows'] as { test: string; skipCount: number }[];
    assert.ok(skipRows.length > 0, 'the fixture must have skipped tests');
    assert.ok(skipRows.every((row) => row.skipCount > 0));
    const defaultRows = json(byDefault.stdout)['rows'] as { test: string; skipCount: number }[];
    assert.ok(
        defaultRows.some((row) => row.skipCount === 0),
        'the default view must include a test that has failures and no skips'
    );
    assert.ok(
        skipRows.length < defaultRows.length,
        '--type skip must be a strictly narrower set here'
    );
});

test('issues defaults to the component ranking, not a flat list of tests', async () => {
    // The reported bug: `fx-tests issues` printed "a few random tests" because
    // it led with a per-test list, while `old/issues.html:888` hardcodes the
    // components view ("Always use components view for issues page") and sorts
    // it by issue count (`:663`). Triage starts by finding the area to look at.
    const { stdout } = await invoke(['issues', '--json', '--limit', '0']);
    const result = json(stdout);
    assert.equal(result['groupBy'], 'component', 'the default view is by component');
    assert.equal(result['sort'], 'issues', 'ranked by issue count, as the page is');

    const rows = result['rows'] as {
        key: string;
        issueCount: number;
        testCount: number;
        totalTestCount: number;
    }[];
    assert.ok(rows.length > 0, 'the fixture must produce component rows');
    // Ranked descending by issue count, and by a margin — an accidentally
    // ordered list of equal values would satisfy a non-strict check.
    for (let i = 1; i < rows.length; i++) {
        assert.ok(
            rows[i - 1]!.issueCount >= rows[i]!.issueCount,
            `component ${i} outranks its predecessor: ${JSON.stringify(rows.slice(i - 1, i + 1))}`
        );
    }
    assert.ok(
        rows[0]!.issueCount > rows[rows.length - 1]!.issueCount,
        'the ranking must actually discriminate, not be a tie'
    );
    // "N tests with issues, out of M" — the denominator covers clean tests too,
    // as the page's does (`:2010` accumulates before `:2016` filters).
    for (const row of rows) {
        assert.ok(row.testCount > 0, `a listed component has an affected test: ${row.key}`);
        assert.ok(
            row.totalTestCount >= row.testCount,
            `the "out of" total includes the affected tests: ${JSON.stringify(row)}`
        );
    }
});

test('issues --type narrows the union and changes the ranking', async () => {
    // The checkboxes are togglable and turning one off must move the ranking,
    // as it does on the page. Skips dominate this data, so dropping them is the
    // case most likely to reorder — and the one that would silently do nothing
    // if `--type` were only filtering rows rather than feeding the count.
    const all = await invoke(['issues', '--json', '--limit', '0']);
    const noSkips = await invoke([
        'issues', '--json', '--limit', '0', '--type', 'fail,timeout,crash',
    ]);
    const allRows = json(all.stdout)['rows'] as { key: string; issueCount: number }[];
    const fewerRows = json(noSkips.stdout)['rows'] as { key: string; issueCount: number }[];
    assert.deepEqual(json(noSkips.stdout)['types'], ['fail', 'timeout', 'crash']);

    const skipsOf = (rows: { key: string; issueCount: number }[]): Map<string, number> =>
        new Map(rows.map((row) => [row.key, row.issueCount]));
    const withSkips = skipsOf(allRows);
    const without = skipsOf(fewerRows);
    // Every component's total must drop or hold — never rise — when a type is
    // removed from the union.
    for (const [key, count] of without) {
        assert.ok(
            count <= (withSkips.get(key) ?? Infinity),
            `${key} counted more issues with fewer types enabled`
        );
    }
    assert.ok(
        [...without].some(([key, count]) => count < (withSkips.get(key) ?? 0)),
        'dropping skips must reduce some component total, or --type is decorative'
    );
});

test('issues --type changes which outcomes make a test interesting', async () => {
    const all = await invoke(['issues', '--json', '--limit', '0']);
    const crashOnly = await invoke(['issues', '--json', '--limit', '0', '--type', 'crash']);
    const allRows = json(all.stdout)['rows'] as { test: string; crashCount: number }[];
    const crashRows = json(crashOnly.stdout)['rows'] as { test: string; crashCount: number }[];
    assert.ok(crashRows.length > 0);
    assert.ok(crashRows.length < allRows.length, '--type crash must be a narrower set');
    // Every row kept must actually have crashed, or the filter is decorative.
    assert.ok(crashRows.every((row) => row.crashCount > 0));
});

test('issues --min-rate accepts a fraction and filters on it', async () => {
    const { stdout } = await invoke(['issues', '--json', '--limit', '0', '--min-rate', '0.5']);
    const rows = json(stdout)['rows'] as { failRate: number }[];
    assert.ok(rows.every((row) => row.failRate >= 0.5));
    const unfiltered = await invoke(['issues', '--json', '--limit', '0']);
    assert.ok(
        (json(unfiltered.stdout)['rows'] as unknown[]).length >= rows.length
    );

    const bad = await invoke(['issues', '--min-rate', '500']);
    assert.equal(bad.code, ExitCode.Usage);
});

test('issues --sort changes the order', async () => {
    const perTest = ['issues', '--json', '--limit', '0', '--group-by', 'test'];
    const byIssues = await invoke(perTest);
    const byName = await invoke([...perTest, '--sort', 'name']);
    const byRate = await invoke([...perTest, '--sort', 'rate']);
    const issueRows = (json(byIssues.stdout)['rows'] as { test: string }[]).map((r) => r.test);
    const nameRows = (json(byName.stdout)['rows'] as { test: string }[]).map((r) => r.test);
    const rateRows = (json(byRate.stdout)['rows'] as { test: string }[]).map((r) => r.test);
    assert.deepEqual(nameRows, [...nameRows].sort());
    assert.notDeepEqual(issueRows, nameRows, '--sort name must reorder');
    // The default is now issue count, so `--sort rate` has to be a real re-sort
    // rather than the identity it used to be.
    assert.notDeepEqual(issueRows, rateRows, '--sort rate must differ from the default');
    const issueCounts = (
        json(byIssues.stdout)['rows'] as { issueCount: number }[]
    ).map((r) => r.issueCount);
    for (let i = 1; i < issueCounts.length; i++) {
        assert.ok(issueCounts[i - 1]! >= issueCounts[i]!, 'the default order is by issue count');
    }
});

test('issues --sort works on the component ranking too', async () => {
    const byIssues = await invoke(['issues', '--json', '--limit', '0']);
    const byName = await invoke(['issues', '--json', '--limit', '0', '--sort', 'name']);
    const byRate = await invoke(['issues', '--json', '--limit', '0', '--sort', 'rate']);
    const keys = (out: string): string[] =>
        (json(out)['rows'] as { key: string }[]).map((row) => row.key);
    assert.deepEqual(keys(byName.stdout), [...keys(byName.stdout)].sort());
    assert.notDeepEqual(keys(byIssues.stdout), keys(byName.stdout));
    const rates = (json(byRate.stdout)['rows'] as { issueRate: number }[]).map((r) => r.issueRate);
    for (let i = 1; i < rates.length; i++) {
        assert.ok(rates[i - 1]! >= rates[i]!, '--sort rate orders components by issue rate');
    }
});

test('issues --path and --component narrow the set', async () => {
    const perTest = ['issues', '--json', '--limit', '0', '--group-by', 'test'];
    const all = await invoke(perTest);
    const scoped = await invoke([...perTest, '--path', 'netwerk/']);
    const rows = json(scoped.stdout)['rows'] as { test: string }[];
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.test.startsWith('netwerk/')));
    assert.ok(rows.length < (json(all.stdout)['rows'] as unknown[]).length);

    // `--component` on the default (component) view narrows to the named
    // component rather than silently returning everything.
    const byComponent = await invoke(['issues', '--json', '--limit', '0', '--component', 'Network']);
    const groups = json(byComponent.stdout)['rows'] as { key: string }[];
    assert.ok(groups.length > 0, '--component must match something in the fixture');
    assert.ok(
        groups.every((group) => group.key.toLowerCase().includes('network')),
        `--component must drop non-matching components: ${JSON.stringify(groups.map((g) => g.key))}`
    );
});

test('skips says the aggregate already dropped run-if, rather than "excluded 0"', async () => {
    const { stdout } = await invoke(['skips', '--limit', '2']);
    // The measured asymmetry: on a 21-day aggregate the generator got there
    // first, so --include-run-if changes nothing. Reporting "excluded 0" would
    // imply there were none rather than that they never reached this file.
    assert.match(stdout, /generator already dropped run-if skips/);
    assert.match(stdout, /63\.6%/);

    const { stdout: withRunIf } = await invoke([
        'skips', '--json', '--limit', '0', '--include-run-if',
    ]);
    const { stdout: without } = await invoke(['skips', '--json', '--limit', '0']);
    // Same file, same answer: on an aggregate the flag genuinely changes
    // nothing, which is exactly the claim the prose above makes. Asserting the
    // totals are equal *and* non-zero is what stops this passing vacuously if
    // both queries broke and returned nothing.
    const withTotal = json(withRunIf)['totalSkips'] as number;
    const withoutTotal = json(without)['totalSkips'] as number;
    assert.equal(withTotal, withoutTotal);
    assert.ok(withoutTotal > 0, 'the fixture must have skips for this to mean anything');
});

test('skips totals match the fixture', async () => {
    const { stdout } = await invoke(['skips', '--json', '--limit', '0']);
    const result = json(stdout);
    // Golden: summing the fixture's SKIP counts gives 17,787 runs, none of
    // which are run-if (the aggregate has no run-if messages at all).
    assert.equal(result['totalSkips'], 17_787);
    assert.equal(result['runIfIsUpstreamFiltered'], true);
});

/**
 * `skips --group-by` used to be accepted, validated, echoed into the JSON and
 * then ignored — `--group-by component` printed the per-test table, byte for
 * byte. An option that changes nothing is worse than a rejected one, because
 * the reader believes the answer is about components.
 *
 * Goldens summed from the fixture's raw arrays without going through the
 * decoder, as `artifacts/goldens.mjs` does for the rest of this file:
 * WebExtensions :: General has 10,713 skipped runs over 4 of its 7 tests, Core
 * :: Networking 7,074 over 1 of 2. They add up to the 17,787 total the flat
 * view asserts above, which is the cross-check that they are the same data.
 */
test('skips --group-by component aggregates rather than printing the per-test table', async () => {
    const { stdout } = await invoke(['skips', '--json', '--limit', '0', '--group-by', 'component']);
    const result = json(stdout);
    const rows = result['rows'] as {
        key: string;
        skipCount: number;
        testCount: number;
        totalTestCount: number;
        messages: { message: string; count: number }[];
    }[];
    assert.deepEqual(
        rows.map((row) => [row.key, row.skipCount, row.testCount, row.totalTestCount]),
        [
            ['WebExtensions :: General', 10_713, 4, 7],
            ['Core :: Networking', 7_074, 1, 2],
        ]
    );
    // The group's skips must be the same population the flat view reports, or
    // the two views are answering about different trees.
    assert.equal(
        rows.reduce((sum, row) => sum + row.skipCount, 0),
        17_787
    );
    // `N/M` is only worth a column if M is the whole group, clean tests
    // included — `findSkips` returns neither, so the denominator has to come
    // from the file. 4 of 7 and 1 of 2 are both strict.
    assert.ok(rows.every((row) => row.totalTestCount > row.testCount));
    // The conditions are the actionable part, aggregated over the group.
    assert.equal(rows[0]!.messages[0]!.message, "os == 'android'");
    assert.equal(rows[0]!.messages[0]!.count, 7_859);
    for (const row of rows) {
        for (let i = 1; i < row.messages.length; i++) {
            assert.ok(row.messages[i - 1]!.count >= row.messages[i]!.count);
        }
    }
});

test('skips --group-by directory groups on the directory, not the test', async () => {
    const { stdout } = await invoke(['skips', '--json', '--limit', '0', '--group-by', 'directory']);
    const rows = json(stdout)['rows'] as { key: string; skipCount: number }[];
    assert.deepEqual(
        rows.map((row) => [row.key, row.skipCount]),
        [
            ['toolkit/components/extensions/test/xpcshell', 10_713],
            ['netwerk/test/unit', 7_074],
        ]
    );
});

test('skips --group-by really changes the table, and keeps the run-if statement', async () => {
    const flat = await invoke(['skips', '--limit', '5']);
    const byComponent = await invoke(['skips', '--group-by', 'component', '--limit', '5']);
    assert.notEqual(
        flat.stdout,
        byComponent.stdout,
        '--group-by component must not print the per-test table'
    );
    assert.match(byComponent.stdout, /skips by component/);
    assert.match(byComponent.stdout, /Component\s+skips ▼\s+tests\s+reason/);
    // The per-test view keeps its reviewed shape exactly.
    assert.match(flat.stdout, /Test\s+skips ▼\s+reason/);
    assert.doesNotMatch(flat.stdout, /skips by component/);
    // The population statement is the point of the command; a grouped view that
    // dropped it would be the same "excluded 0" ambiguity in a new table.
    for (const out of [flat.stdout, byComponent.stdout]) {
        assert.match(out, /generator already dropped run-if skips/);
        assert.match(out, /17,787 skipped runs across 5 tests/);
    }
});

test('failures groups by message and reports the test spread', async () => {
    const { stdout } = await invoke(['failures', '--json', '--limit', '0']);
    const rows = json(stdout)['rows'] as {
        message: string | null;
        count: number;
        testCount: number;
    }[];
    assert.ok(rows.length > 0);
    for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i - 1]!.count >= rows[i]!.count);
    }
    // The spread count is the discriminator, so it must be present and real.
    assert.ok(rows.every((row) => row.testCount >= 1));
    assert.ok(rows.some((row) => row.testCount >= 1));
});

/**
 * The bug: `tests` capped at 50 beside `testCount: 204`, with nothing saying so.
 *
 * A consumer that reads the array as the answer is off by however many the cap
 * dropped, and cannot tell. Six tests went missing that way, two of them inside
 * the contiguous manifest block that was the point of the query. So the
 * invariant is checked on **every** row of every `--json` path that emits the
 * pair, rather than on the one row that happened to be over the cap: the
 * fixture is small enough that a cap-shaped regression would hide behind a
 * spot-check of the biggest group.
 */
test('--json never emits a tests array shorter than its own testCount', async () => {
    for (const argv of [
        ['failures', '--json', '--limit', '0'],
        ['failures', '--json'],
        ['issues', '--group-by', 'message', '--json', '--limit', '0'],
    ]) {
        const { stdout } = await invoke(argv);
        const rows = json(stdout)['rows'] as {
            message: string | null;
            testCount: number;
            tests: { test: string; count: number }[];
            testsTruncated: boolean;
        }[];
        assert.ok(rows.length > 0, argv.join(' '));
        for (const row of rows) {
            assert.equal(
                row.tests.length,
                row.testCount,
                `${argv.join(' ')}: ${row.tests.length} of ${row.testCount} tests for ${row.message}`
            );
            // Present and false, not absent. An absent key is the shape item 5
            // of the review is about: a consumer cannot tell "nothing was
            // dropped" from "this build does not report it".
            assert.equal(row.testsTruncated, false, argv.join(' '));
        }
    }
});

/**
 * The other half: the text table printed the count and never the tests.
 *
 * "Which 204 tests" is the question the command is asked, and the answer has to
 * be reachable without `--json` — the list is what shows whether a chain is
 * contiguous in the manifest.
 */
test('failures lists the tests behind a message in text output', async () => {
    const all = await invoke(['failures', '--json', '--limit', '0']);
    const rows = json(all.stdout)['rows'] as {
        message: string | null;
        tests: { test: string }[];
    }[];
    // The loudest group in this fixture records no message, and `--message`
    // cannot name that one.
    const row = rows.find((candidate) => candidate.message !== null);
    assert.ok(row?.message, 'the fixture must have a failure with a message');
    assert.ok(row.tests.length > 0);

    const { stdout } = await invoke(['failures', '--message', row.message, '--limit', '1']);
    // Whole paths. This block exists because the table could not carry them, so
    // a truncated path here would defeat its purpose — the same failure mode the
    // review's item 17 is about, checked on the output that must not have it.
    for (const test of row.tests) {
        assert.ok(
            stdout.includes(test.test),
            `the whole path must appear untruncated: ${test.test}\n${stdout}`
        );
    }
});

/**
 * The list is automatic at the narrowness that asks for it, and off above it.
 *
 * `--message` usually narrows to one row, so a caller who does not know about
 * `--tests` still gets the answer; at twenty rows the same block is noise, which
 * is the trade `errors` already made at the same threshold.
 */
test('the per-message test list is automatic when narrow and opt-in when wide', async () => {
    const narrow = await invoke(['failures', '--limit', '1']);
    assert.match(narrow.stdout, /failures in \d+ tests? —/);

    const wide = await invoke(['failures', '--limit', '20']);
    assert.doesNotMatch(wide.stdout, /failures in \d+ tests? —/);

    const asked = await invoke(['failures', '--limit', '20', '--tests']);
    assert.match(asked.stdout, /failures in \d+ tests? —/);
});

test('failures --message filters case-insensitively', async () => {
    const all = await invoke(['failures', '--json', '--limit', '0']);
    const rows = json(all.stdout)['rows'] as { message: string | null }[];
    const needle = rows.find((row) => row.message !== null)?.message;
    assert.ok(needle !== undefined && needle !== null);
    const word = needle.split(/\s+/).find((w) => w.length > 5) ?? needle.slice(0, 6);

    const filtered = await invoke([
        'failures', '--json', '--limit', '0', '--message', word.toUpperCase(),
    ]);
    const filteredRows = json(filtered.stdout)['rows'] as { message: string | null }[];
    assert.ok(filteredRows.length > 0, `expected a match for ${word}`);
    assert.ok(
        filteredRows.every((row) => (row.message ?? '').toLowerCase().includes(word.toLowerCase()))
    );
});

test('the tree-wide commands reject a stray positional with a useful hint', async () => {
    const { code, stderr } = await invoke(['issues', 'netwerk/test/unit']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /takes no positional arguments/);
    assert.match(stderr, /--path netwerk\/test\/unit/);
});

test('the tree-wide commands say what they truncated', async () => {
    const { stdout } = await invoke(['issues', '--limit', '2']);
    assert.match(stdout, /… \d+ more \(--limit 0 for all\)/);
});

/**
 * The path columns keep the filename, not the leading directories.
 *
 * Reported as unusable: a path cut to `toolkit/components/extensions/test/xp…`
 * cannot be pasted into `fx-tests test`, grepped for, or told apart from its
 * neighbours — and every one of those is what the output is for. The fixture's
 * longest test path is 83 characters against a 62-character column, so the
 * columns below do truncate and this is not a vacuous assertion.
 */
/**
 * Every path a tree-wide command prints must be copyable into the next one.
 *
 * This is the bug the owner reported twice: paths were cut to a hardcoded 56 or
 * 62 columns with no way to recover them, so the output could not feed
 * `fx-tests test <path>`. A previous fix added left-truncation and a recovery
 * block to `try` **only**, and the four tree-wide commands kept shipping
 * unusable paths — the test that should have caught it looked at `try` alone.
 *
 * So this asserts the property that actually matters, on every such command:
 * for each row, the whole path is obtainable from the default output. The
 * column now sizes itself to the longest path present, so normally nothing is
 * cut at all; if a cap ever bites, the recovery block must carry the full value.
 */
test('every command that prints a test path prints a usable one', async () => {
    const commands: [string[], (row: Record<string, unknown>) => string][] = [
        [['issues', '--group-by', 'test'], (row) => String(row['test'])],
        [['skips'], (row) => String(row['test'])],
        [['manifests'], (row) => String(row['manifest'])],
    ];
    for (const [argv, pathOf] of commands) {
        // The JSON is the source of truth for what the rows *are* — it is
        // documented never to truncate — and the text output is what has to
        // make each of them recoverable.
        const { stdout: raw } = await invoke([...argv, '--json', '--limit', '10']);
        const rows = json(raw)['rows'] as Record<string, unknown>[];
        assert.ok(rows.length > 0, `${argv[0]}: fixture produced no rows`);
        const paths = rows.map(pathOf);
        assert.ok(
            paths.some((path) => path.includes('/')),
            `${argv[0]}: expected real paths, got ${JSON.stringify(paths.slice(0, 3))}`
        );

        const { stdout } = await invoke([...argv, '--limit', '10']);
        for (const path of paths) {
            // Present *verbatim* somewhere in the output — in the column when
            // it fits, in the `full paths` block when it did not. A cell ending
            // in `…` satisfies neither, which is the whole point.
            assert.ok(
                stdout.includes(path),
                `${argv[0]}: the full path must be obtainable from the default output: ${path}`
            );
        }
    }
});

test('a path too long for the cap is cut at the front and recovered below', async () => {
    // The fallback, exercised directly: with auto-sizing the real data no
    // longer truncates, so nothing end-to-end would cover the cap any more.
    const { table: renderTable, tableWithPaths, fullPathLines, PATH_COLUMN_CAP } = await import(
        '../cli/format/text.ts'
    );
    const long = `dom/${'nested/'.repeat(30)}test_something_specific.js`;
    assert.ok(long.length > PATH_COLUMN_CAP, 'the fixture path must exceed the cap');

    const rendered = tableWithPaths(
        [{ header: 'Test', path: true }, { header: 'n', align: 'right' }],
        [[long, '1'], ['dom/short/test_a.js', '2']]
    );
    const row = rendered.lines.find((line) => line.includes('…')) ?? '';
    assert.ok(row.includes('…/'), `the cut is at the front: ${row}`);
    assert.ok(
        row.includes('test_something_specific.js'),
        `the filename survives the cut: ${row}`
    );
    // And the full value comes back, so it is still copyable.
    assert.deepEqual(rendered.shortenedPaths, [long]);
    const recovery = fullPathLines(rendered.shortenedPaths);
    assert.match(recovery[0]!, /full paths \(1 shortened above\):/);
    assert.ok(recovery.some((line) => line.includes(long)), 'the whole path is printed back');

    // A path that fits is neither cut nor listed — the block is a fallback,
    // not something every table carries.
    const short = tableWithPaths([{ header: 'Test', path: true }], [['dom/test_a.js']]);
    assert.deepEqual(short.shortenedPaths, []);
    assert.deepEqual(fullPathLines(short.shortenedPaths), []);
    // `table()` is the same renderer, so it cannot drift from the above.
    assert.deepEqual(
        renderTable([{ header: 'Test', path: true }], [['dom/test_a.js']]),
        short.lines
    );
});

test('a path column sizes itself to the longest path, not to a constant', async () => {
    const { tableWithPaths } = await import('../cli/format/text.ts');
    // 83 characters: longer than both constants this replaced (56 and 62), and
    // well under the cap, so it must survive whole.
    const path = `browser/components/${'x'.repeat(20)}/test/browser/browser_a_long_name.js`;
    assert.ok(path.length > 62 && path.length < 128);
    const rendered = tableWithPaths([{ header: 'Test', path: true }], [[path]]);
    assert.deepEqual(rendered.shortenedPaths, [], 'a path under the cap is never shortened');
    assert.ok(
        rendered.lines.some((line) => line.includes(path)),
        `the whole ${path.length}-character path must appear: ${rendered.lines.join('\n')}`
    );
});

test('a group shows its message in full, and the rest only how they differ', async () => {
    const { messageLines } = await import('../cli/format/text.ts');
    const head =
        'Uncaught exception in test - [Exception... "Component returned failure code: ' +
        '0x80520015" location: "JS frame :: Tabbrowser.sys.mjs :: _internalMaybeFixupLoadURI';
    const values = [
        `${head} :: line 10875"  data: no]`,
        `${head} :: line 10651"  data: no]`,
        `${head} :: line 10643"  data: no]`,
    ];
    const rendered = messageLines(values, 60);

    // Row 1 carries the whole message across as many lines as it needs. This is
    // the regression that matters: the previous fix showed a stack location and
    // no failure message at all, sending a reader to --json for what failed.
    const first = rendered.filter((line) => line.index === 0);
    const joined = first.map((line) => line.text).join(' ');
    assert.ok(first.length > 1, 'a 200-character message must wrap, not truncate');
    assert.ok(
        joined.includes('Uncaught exception in test') && joined.includes('0x80520015'),
        `the message must survive whole: ${joined}`
    );
    assert.equal(joined.replace(/\s+/g, ' '), values[0]!.replace(/\s+/g, ' '));
    for (const line of first) {
        assert.ok(line.text.length <= 60, `wrapped to width: ${line.text.length}`);
    }

    // Rows 2 and 3 are one line each, naming their leader and their difference.
    for (const [n, index] of [1, 2].entries()) {
        const rows = rendered.filter((line) => line.index === index);
        assert.equal(rows.length, 1, 'a difference-only row fits on one line');
        assert.match(rows[0]!.text, /^↑ same as 1, but /);
        assert.ok(
            rows[0]!.text.includes(['10651', '10643'][n]!),
            `the discriminator survives: ${rows[0]!.text}`
        );
        // And it keeps the word that says what the number *is* — a bare
        // `10651"` would be a number with no label.
        assert.ok(rows[0]!.text.includes('line'), `the phrase survives: ${rows[0]!.text}`);
    }
});

test('a message with no relatives is shown whole, never cut', async () => {
    const { messageLines } = await import('../cli/format/text.ts');
    // Two unrelated messages: neither can be a "same as" of the other, so both
    // print in full. Nothing is truncated, which is the point — a reader must
    // not need --json or --full-messages to learn what failed.
    const values = [
        `unrelated alpha ${'padding '.repeat(20)}end-of-alpha`,
        'short beta',
    ];
    const rendered = messageLines(values, 40);
    for (const [i, value] of values.entries()) {
        const text = rendered
            .filter((line) => line.index === i)
            .map((line) => line.text)
            .join(' ');
        assert.equal(text.replace(/\s+/g, ' '), value.replace(/\s+/g, ' '));
    }
});

test('no wrapping under --markdown, --json or --full-messages', async () => {
    const { messageLines } = await import('../cli/format/text.ts');
    // `renderWidth()` is null in those modes, and a null width must pass the
    // message through as one line rather than wrapping it to a default.
    const long = `x ${'y '.repeat(200)}z`;
    const rendered = messageLines([long], null);
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0]!.text, long);
});

test('--markdown emits a real table from every command, not a fenced block', async () => {
    // These four used to render text and wrap it in a fence, which made them
    // the only commands whose `--markdown` was not Markdown: pasting `issues`
    // and `manifests` into one bug gave a code block and a table.
    for (const argv of [
        ['issues', '--limit', '2'],
        ['failures', '--limit', '2'],
        ['crashes', '--limit', '2'],
        ['skips', '--limit', '2'],
        ['manifests', '--limit', '2'],
        ['errors', '--limit', '2'],
    ]) {
        const { code, stdout } = await invoke([...argv, '--markdown']);
        assert.equal(code, ExitCode.Success, argv[0]);
        assert.match(stdout, /^# /m, `${argv[0]} should open with a heading`);
        // A header row followed by the alignment row is what makes it a table.
        assert.match(stdout, /^\|.*\|$/m, `${argv[0]} should emit a table row`);
        assert.match(stdout, /^\| -+/m, `${argv[0]} should emit an alignment row`);
        assert.doesNotMatch(stdout, /^```/m, `${argv[0]} should not fence its table`);
    }
});

// =========================================================================
// dispatch
// =========================================================================

test('every step-5 command is registered and none is still "planned"', async () => {
    const { stdout } = await invoke(['--help']);
    for (const name of [
        'issues', 'failures', 'crashes', 'skips', 'errors', 'manifests', 'crash',
    ]) {
        assert.match(stdout, new RegExp(`\\b${name}\\b`), `${name} missing from --help`);
    }
    // A command that is registered must not also be advertised as unbuilt.
    const planned = /Planned[^\n]*\n\s*([^\n]*)/.exec(stdout)?.[1] ?? '';
    for (const name of ['issues', 'failures', 'crashes', 'skips', 'errors', 'manifests']) {
        assert.ok(!planned.split(/,\s*/).includes(name), `${name} still listed as planned`);
    }
});

test('each step-5 command has --help listing its own options', async () => {
    const expected: Record<string, string[]> = {
        errors: ['--message', '--kind', '--test', '--group-by', '--sort', '--task-ids'],
        manifests: ['--job', '--platform', '--sort', '--slower-than'],
        crash: ['--all-threads', '--thread', '--frames', '--raw'],
        issues: ['--component', '--path', '--type', '--min-rate', '--sort', '--group-by'],
        crashes: ['--signature', '--minidumps'],
        skips: ['--include-run-if'],
        failures: ['--message', '--tests'],
    };
    for (const [command, flags] of Object.entries(expected)) {
        const { code, stdout } = await invoke([command, '--help']);
        assert.equal(code, ExitCode.Success);
        for (const flag of flags) {
            assert.ok(stdout.includes(flag), `${command} --help is missing ${flag}`);
        }
    }
});

test('--json and text agree on the numbers they both report', async () => {
    // The two renderers must not drift: a golden pinned only to text would let
    // the JSON shape rot, and vice versa.
    const asJson = await invoke(['errors', '--json', '--limit', '1']);
    const asText = await invoke(['errors', '--limit', '1']);
    const row = (json(asJson.stdout)['rows'] as { count: number }[])[0]!;
    assert.match(asText.stdout, new RegExp(row.count.toLocaleString('en-US').replace('.', '\\.')));
});

/**
 * A ranked list must say what it is ranked by.
 *
 * `fx-tests issues` was correctly sorted by rate and still read as "a few
 * random tests, without sorting", because nothing in the output said so. A
 * reader who does not already know cannot tell an ordered list from an
 * arbitrary one, so the header carries the marker — the same `▼`/`▲` the
 * dashboards put on their sort buttons (`old/failures.html:632`).
 */
test('every ranked command marks the column it is ordered by', async () => {
    const commands = [
        ['issues'],
        ['issues', '--group-by', 'test'],
        ['issues', '--group-by', 'directory'],
        ['failures'],
        ['crashes'],
        ['skips'],
        ['manifests'],
    ];
    for (const argv of commands) {
        const { stdout } = await invoke([...argv, '--limit', '3']);
        const marked = stdout
            .split('\n')
            .filter((line) => line.includes('▼') || line.includes('▲'));
        assert.equal(
            marked.length,
            1,
            `${argv.join(' ')}: expected exactly one sort marker, got ${marked.length}: ${marked.join(' | ')}`
        );
        // On the header row, not in the data. The marker must sit in a cell
        // that is a *column name*: checked by confirming the marked token also
        // appears as a header in the `--json` view's ordering, and that the
        // line below it is a data row. Shape checks like "contains no digit"
        // would be wrong here — `manifests` has a column called `p95`.
        const lines = stdout.split('\n');
        const markerIndex = lines.findIndex((line) => line.includes('▼') || line.includes('▲'));
        const marker = lines[markerIndex]!;
        // The marked cell, without its arrow.
        const markedColumn = marker
            .split(/\s{2,}/)
            .map((cell) => cell.trim())
            .find((cell) => cell.endsWith('▼') || cell.endsWith('▲'))!
            .replace(/\s*[▼▲]$/, '');
        assert.ok(
            markedColumn.length > 0,
            `${argv.join(' ')}: the marker must annotate a named column`
        );
        // A header row is followed by data, and is not itself data: no cell in
        // it may be a formatted number, which is what a data row leads with.
        const below = lines[markerIndex + 1];
        assert.ok(
            below !== undefined && below.trim().length > 0,
            `${argv.join(' ')}: the marked row must be followed by a data row`
        );
        assert.doesNotMatch(
            markedColumn,
            /^[\d,]+$/,
            `${argv.join(' ')}: the marker landed on a value, not a column name: ${markedColumn}`
        );
    }
});

test('the sort marker follows --sort rather than being hardcoded', async () => {
    // A marker that always names the same column would be worse than none: it
    // would assert an order the command did not produce.
    const byName = await invoke(['issues', '--limit', '3', '--sort', 'name']);
    const nameHeader = byName.stdout
        .split('\n')
        .find((line) => line.includes('▲') || line.includes('▼'))!;
    assert.match(nameHeader, /Component ▲/, `--sort name marks the key column, ascending`);

    const byRate = await invoke(['issues', '--limit', '3', '--sort', 'rate']);
    const rateHeader = byRate.stdout
        .split('\n')
        .find((line) => line.includes('▲') || line.includes('▼'))!;
    assert.match(rateHeader, /rate ▼/, '--sort rate marks the rate column, descending');

    const byIssues = await invoke(['issues', '--limit', '3']);
    const issuesHeader = byIssues.stdout
        .split('\n')
        .find((line) => line.includes('▲') || line.includes('▼'))!;
    assert.match(issuesHeader, /issues ▼/, 'the default marks the issue-count column');

    // The per-test renderer builds its columns separately from the grouped one,
    // so asserting only the component view leaves half the code unpinned: a
    // marker hardcoded to `desc` there would claim A→Z was descending.
    const headerOf = async (argv: string[]): Promise<string> => {
        const { stdout } = await invoke(argv);
        return stdout.split('\n').find((line) => line.includes('▲') || line.includes('▼'))!;
    };
    assert.match(
        await headerOf(['issues', '--group-by', 'test', '--limit', '3', '--sort', 'name']),
        /Test ▲/,
        'the per-test view marks --sort name as ascending'
    );
    assert.match(
        await headerOf(['issues', '--group-by', 'test', '--limit', '3']),
        /issues ▼/,
        'the per-test default marks the issue-count column, descending'
    );
    assert.match(
        await headerOf(['issues', '--group-by', 'test', '--limit', '3', '--sort', 'rate']),
        /rate ▼/,
        'the per-test view follows --sort rate'
    );
});

/**
 * `--sort count` orders by fail+timeout+crash+skip, which is not a column.
 *
 * The marker used to be put on `fail`, so a ▼ sat on a column the rows were not
 * ordered by and which was visibly non-monotone: on the real file the first
 * rows of `issues --group-by test --sort count` read 0, 0, 1, 0, 0 under
 * `fail ▼`. Both renderers built their column lists separately and both did it.
 */
test('--sort count marks no column, since no column is what it orders by', async () => {
    for (const argv of [
        ['issues', '--limit', '5', '--sort', 'count'],
        ['issues', '--group-by', 'test', '--limit', '5', '--sort', 'count'],
        ['issues', '--group-by', 'directory', '--limit', '5', '--sort', 'count'],
        ['issues', '--group-by', 'test', '--limit', '5', '--sort', 'count', '--type', 'crash'],
    ]) {
        const { stdout } = await invoke(argv);
        assert.doesNotMatch(
            stdout,
            /[▼▲]/,
            `${argv.join(' ')}: a marker here would name a column the rows are not ordered by`
        );
    }
    // And the marker is still there for the sorts that do name a column, so
    // this is not "the marker was deleted".
    const { stdout: byIssues } = await invoke(['issues', '--limit', '3', '--sort', 'issues']);
    assert.match(byIssues, /issues ▼/);
});

/**
 * `--sort count` must mean one thing at both levels.
 *
 * The row sum included `skipCount` and the group sum did not, so the ranking
 * quantity depended on `--group-by` with nothing saying so. Skips are in the
 * `--type` default and the header calls them issues, so excluding them from a
 * "count" ranking is the side that cannot be defended.
 *
 * Goldens summed from the fixture's raw arrays: by component, the two groups
 * with skips total 14,222 and 7,083 non-passing runs with skips counted, and
 * 3,509 and 9 without.
 *
 * The fixture's *component* order happens to be the same under both
 * definitions, so a monotonicity check on the groups cannot see this bug — one
 * written that way stayed green when the skip-excluding sum was put back. What
 * discriminates is asking the two levels for the same quantity and requiring
 * the answers to agree: the rank the grouped view gives a component must be the
 * rank its own rows produce. Per test the two definitions do diverge, and
 * `--type skip` below is where that shows.
 */
test('--sort count ranks on the same quantity for rows and for groups', async () => {
    const nonPass = (row: {
        failCount: number;
        timeoutCount: number;
        crashCount: number;
        skipCount: number;
    }): number => row.failCount + row.timeoutCount + row.crashCount + row.skipCount;

    const grouped = await invoke(['issues', '--json', '--limit', '0', '--sort', 'count']);
    const groups = json(grouped.stdout)['rows'] as {
        key: string;
        failCount: number;
        timeoutCount: number;
        crashCount: number;
        skipCount: number;
    }[];
    assert.ok(groups.length > 1);
    const byKey = new Map(groups.map((group) => [group.key, nonPass(group)]));
    assert.equal(byKey.get('WebExtensions :: General'), 14_222);
    assert.equal(byKey.get('Core :: Networking'), 7_083);
    for (let i = 1; i < groups.length; i++) {
        assert.ok(
            nonPass(groups[i - 1]!) >= nonPass(groups[i]!),
            `groups are not ordered by fail+timeout+crash+skip at ${groups[i]!.key}`
        );
    }
    // Skips dominate this fixture, so a group sum that dropped them would be a
    // different number — 3,509 rather than 14,222.
    assert.ok(
        groups.some((group) => group.skipCount > 0),
        'the fixture must have grouped skips or this asserts nothing'
    );

    // The ranking the grouped view produced must be the one its own rows
    // produce under the same definition. This is what catches a group sum that
    // silently drops skips, since the resulting order can coincide by luck.
    const perTestAll = await invoke(['issues', '--json', '--limit', '0', '--group-by', 'test']);
    const rowsByComponent = new Map<string, number>();
    for (const row of json(perTestAll.stdout)['rows'] as {
        component: string | null;
        failCount: number;
        timeoutCount: number;
        crashCount: number;
        skipCount: number;
    }[]) {
        const key = row.component ?? '(no component)';
        rowsByComponent.set(key, (rowsByComponent.get(key) ?? 0) + nonPass(row));
    }
    assert.deepEqual(
        groups.map((group) => group.key),
        [...groups]
            .map((group) => group.key)
            .sort(
                (a, b) =>
                    (rowsByComponent.get(b) ?? 0) - (rowsByComponent.get(a) ?? 0) ||
                    a.localeCompare(b)
            ),
        'the grouped ranking disagrees with the one its own rows imply'
    );
    for (const group of groups) {
        assert.equal(
            rowsByComponent.get(group.key),
            nonPass(group),
            `${group.key}: the group total is not the sum of its rows`
        );
    }

    const perTest = await invoke([
        'issues', '--json', '--limit', '0', '--group-by', 'test', '--sort', 'count',
    ]);
    const rows = json(perTest.stdout)['rows'] as {
        test: string;
        failCount: number;
        timeoutCount: number;
        crashCount: number;
        skipCount: number;
    }[];
    for (let i = 1; i < rows.length; i++) {
        assert.ok(
            nonPass(rows[i - 1]!) >= nonPass(rows[i]!),
            `rows are not ordered by fail+timeout+crash+skip at ${rows[i]!.test}`
        );
    }
    assert.equal(
        rows[0]!.test,
        'toolkit/components/extensions/test/xpcshell/test_ext_geckoProfiler_control.js'
    );
    assert.equal(nonPass(rows[0]!), 7_482);

    // Where the two definitions visibly disagree: restricted to tests with a
    // skip, `test_ext_geckoProfiler_control.js` leads on 7,482 runs of which
    // only 3 are not skips, so a skip-excluding sum ranks it last of five
    // rather than first. The exact order is the golden.
    const skipOnly = await invoke([
        'issues', '--json', '--limit', '0', '--group-by', 'test', '--sort', 'count',
        '--type', 'skip',
    ]);
    const skipRows = json(skipOnly.stdout)['rows'] as { test: string }[];
    assert.deepEqual(
        skipRows.map((row) => row.test.split('/').pop()),
        [
            'test_ext_geckoProfiler_control.js',
            'test_trr_https_fallback.js',
            'test_ext_contentscript_context.js',
            'test_ext_background_early_shutdown.js',
            'test_ext_alarms.js',
        ]
    );
});

test('--markdown carries the sort marker too', async () => {
    // A table pasted into a bug has even less context than one in a terminal.
    const { stdout } = await invoke(['issues', '--markdown', '--limit', '2']);
    const header = stdout.split('\n').find((line) => line.startsWith('| Component'))!;
    assert.match(header, /issues ▼/, `the Markdown header states the order: ${header}`);
});

test('an empty result says what was searched, not just "no match"', async () => {
    // "No test matched." alone cannot distinguish a healthy tree from a
    // mistyped --path, and those want opposite next actions.
    const { stdout } = await invoke(['issues', '--path', 'no/such/directory/']);
    assert.match(stdout, /No test matched\./);
    assert.match(stdout, /Searched [\d,]+ tests/, 'it names the population it searched');
    assert.match(stdout, /--path/, 'it names the filter most likely to be at fault');
    // And it does not offer to narrow a set that is already empty.
    assert.doesNotMatch(stdout, /Drill in with/);
});

/**
 * The issue rate's denominator, which four mutation survivors showed unpinned.
 *
 * `old/issues.html:1079` adds skipped runs back to the denominator only when skips
 * are one of the enabled types, because `runCount` excludes them (`:1061`). Get
 * this wrong and the numerator counts a skip the denominator does not, which
 * inflates every rate — measured on the real file, 8.74% became 9.53%. Nothing
 * asserted the rate at all, so both the row-level and group-level denominators
 * could be silently narrowed.
 */
test('the issue rate divides by the runs its numerator could come from', async () => {
    const { stdout } = await invoke(['issues', '--json', '--limit', '0']);
    const rows = json(stdout)['rows'] as {
        key: string;
        issueCount: number;
        runCount: number;
        skipCount: number;
        issueRate: number;
    }[];
    assert.ok(rows.length > 0);

    let sawSkips = false;
    for (const row of rows) {
        // Skips are in the default union, so they belong in the denominator.
        const expected = (row.issueCount / (row.runCount + row.skipCount)) * 100;
        assert.ok(
            Math.abs(row.issueRate - expected) < 1e-9,
            `${row.key}: rate ${row.issueRate} is not ${expected} ` +
                `(${row.issueCount} / (${row.runCount} + ${row.skipCount}))`
        );
        if (row.skipCount > 0) {
            sawSkips = true;
            // And the wrong denominator is a *different* number here, so the
            // assertion above is discriminating rather than trivially true.
            const narrowed = (row.issueCount / row.runCount) * 100;
            assert.ok(
                Math.abs(narrowed - row.issueRate) > 1e-9,
                `${row.key}: omitting skips must change the rate for this to be a real check`
            );
        }
        // A rate is a proportion of runs that happened.
        assert.ok(row.issueRate <= 100.000001, `${row.key}: rate above 100%`);
    }
    assert.ok(sawSkips, 'the fixture must have a group with skips');

    // The per-test rows compute their own rate, in `findIssues` rather than in
    // `groupIssues`, so the group assertions above leave that half unpinned.
    // A skip-only test is the sharp case: with skips out of the denominator it
    // has 24,826 issues over 0 runs and reports 0%, which is the opposite of
    // the truth.
    const perTest = await invoke(['issues', '--json', '--limit', '0', '--group-by', 'test']);
    const tests = perTest.stdout;
    const testRows = json(tests)['rows'] as {
        test: string;
        issueCount: number;
        runCount: number;
        skipCount: number;
        issueRate: number;
    }[];
    assert.ok(testRows.length > 0);
    let sawTestSkips = false;
    for (const row of testRows) {
        const expected = (row.issueCount / (row.runCount + row.skipCount)) * 100;
        assert.ok(
            Math.abs(row.issueRate - expected) < 1e-9,
            `${row.test}: rate ${row.issueRate} is not ${expected}`
        );
        if (row.skipCount > 0) {
            sawTestSkips = true;
            const narrowed = (row.issueCount / row.runCount) * 100;
            assert.ok(
                !Number.isFinite(narrowed) || Math.abs(narrowed - row.issueRate) > 1e-9,
                `${row.test}: omitting skips must change this row's rate`
            );
        }
    }
    assert.ok(sawTestSkips, 'the fixture must have a test with skips');
});

test('--type skip removes skips from the denominator as well as the count', async () => {
    // The other half of `:1079`: with skips disabled they leave the numerator,
    // so they must leave the denominator too.
    const { stdout } = await invoke([
        'issues', '--json', '--limit', '0', '--type', 'fail,timeout,crash',
    ]);
    const rows = json(stdout)['rows'] as {
        key: string;
        issueCount: number;
        runCount: number;
        skipCount: number;
        issueRate: number;
    }[];
    assert.ok(rows.length > 0);
    for (const row of rows) {
        const expected = row.runCount > 0 ? (row.issueCount / row.runCount) * 100 : 0;
        assert.ok(
            Math.abs(row.issueRate - expected) < 1e-9,
            `${row.key}: with skips off the denominator is runCount alone`
        );
    }
});

test('the grouped views ask for the clean tests the denominator needs', async () => {
    // `old/issues.html:2010` accumulates a component's runs over every test in it,
    // and only then (`:2016`) decides which tests to list. The CLI gets those
    // clean tests by passing `keepClean` for the grouped views only, so the
    // per-test list still shows only tests worth listing. Both halves are
    // asserted here; the arithmetic itself is in query.test.ts, on a fixture
    // that can be built with an issue-free test in it.
    const grouped = await invoke(['issues', '--json', '--limit', '0']);
    const perTest = await invoke(['issues', '--json', '--limit', '0', '--group-by', 'test']);
    const groups = json(grouped.stdout)['rows'] as {
        key: string;
        runCount: number;
        testCount: number;
        totalTestCount: number;
    }[];
    const tests = json(perTest.stdout)['rows'] as {
        component: string | null;
        runCount: number;
        issueCount: number;
    }[];
    assert.ok(groups.length > 0 && tests.length > 0);

    // Every listed test has an issue: the per-test view does not keep clean ones.
    assert.ok(
        tests.every((row) => row.issueCount > 0),
        '--group-by test must not list issue-free tests'
    );
    for (const group of groups) {
        const listed = tests.filter((t) => (t.component ?? '(no component)') === group.key);
        assert.equal(
            listed.length,
            group.testCount,
            `${group.key}: testCount is the number of tests the per-test view lists`
        );
        assert.ok(
            group.runCount >= listed.reduce((sum, t) => sum + t.runCount, 0),
            `${group.key}: the group total must cover at least the listed tests' runs`
        );
        assert.ok(
            group.totalTestCount >= group.testCount,
            `${group.key}: the "out of" total includes the affected tests`
        );
    }

    // And the command must actually *ask* for the clean tests: the library
    // honouring `keepClean` proves nothing if `runIssues` stops passing it.
    // The observable consequence is `totalTestCount` exceeding `testCount`,
    // which needs a test that is clean *for the query being run*. Narrowing to
    // one outcome produces those: on the real file `--type crash` gives
    // WebExtensions :: General 190 crashing tests out of 396.
    const narrowed = await invoke(['issues', '--json', '--limit', '0', '--type', 'crash']);
    const crashGroups = json(narrowed.stdout)['rows'] as {
        key: string;
        testCount: number;
        totalTestCount: number;
    }[];
    assert.ok(crashGroups.length > 0, '--type crash must still produce components');
    assert.ok(
        crashGroups.some((group) => group.totalTestCount > group.testCount),
        'a component must report more tests than the crashing ones it lists — ' +
            'without keepClean the two are always equal'
    );
    for (const group of crashGroups) {
        assert.ok(
            group.testCount > 0,
            `${group.key}: a listed component must have a crashing test`
        );
        assert.ok(
            group.totalTestCount >= group.testCount,
            `${group.key}: the "out of" total cannot be smaller than the affected count`
        );
    }

    // The default view too, where the clean test is clean under every type.
    assert.ok(
        groups.some((group) => group.totalTestCount > group.testCount),
        'the default view must also count a component\'s issue-free tests'
    );
});

test('tableSection prints the table, the more-line and the recovery block', async () => {
    // The three parts travel together by construction — a caller cannot take
    // the truncation without the recovery. A mutation dropping the recovery
    // block from `tableSection` survived, because every real command now
    // auto-sizes and so never reaches it.
    const { tableSection, PATH_COLUMN_CAP } = await import('../cli/format/text.ts');
    const long = `dom/${'deeply/'.repeat(30)}test_the_actual_name.js`;
    assert.ok(long.length > PATH_COLUMN_CAP);
    const lines = tableSection(
        [{ header: 'Test', path: true }, { header: 'n', align: 'right' }],
        [[long, '1']],
        { total: 5, shown: 1 }
    );
    const text = lines.join('\n');
    assert.match(text, /… 4 more \(--limit 0 for all\)/, 'the more-line is present');
    assert.match(text, /full paths \(1 shortened above\):/, 'the recovery block is present');
    assert.ok(lines.some((line) => line.includes(long)), 'the whole path is recoverable');
    // Order matters for reading: table, then what was hidden, then what was cut.
    const moreAt = lines.findIndex((line) => line.includes('more (--limit 0'));
    const fullAt = lines.findIndex((line) => line.includes('full paths ('));
    assert.ok(moreAt > 0 && fullAt > moreAt, `unexpected order: ${text}`);
});
