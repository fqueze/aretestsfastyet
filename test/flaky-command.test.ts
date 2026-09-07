/**
 * `fx-tests flaky` end to end, and `flakinessByFolderAveraged` against an
 * independent walk of the fixture.
 *
 * ## Where the goldens come from
 *
 * Not from the code under test. `independentFolderAverage()` below re-decodes the
 * fixture's delta-encoded day arrays itself, matches statuses by regular
 * expression rather than through `classifyStatus`, applies the three-state
 * precedence with its own `if` chain, and averages by summing integer test-days
 * and dividing once. It shares no line with `lib/query/flakiness.ts`. That is the
 * pattern `test/flakiness.test.ts` established and the reason it exists: the
 * repo has four recorded cases of a test taking its expected value from the thing
 * under test, which shipped a wrong digit once and pinned a bug as correct twice.
 *
 * ## What these are defending
 *
 * 1. **The default scope is a 7-day average of per-day verdicts** — not one day
 *    and not the window. Both wrong answers produce plausible tables: the window
 *    reads ~84% flaky tree-wide (a fact about the denominator) and one day swings
 *    1.8× with the weekday, because weekend push volume is 2.6× lower. The test
 *    asserts the three scopes give *different* numbers on the fixture, so a
 *    default that silently changed could not pass.
 * 2. **The averaging divides once.** Adding `1/7` seven times does not make 1, and
 *    the error was not cosmetic — it turned the "in tree" column on for every row.
 *    Asserted as exactness against integers, which only holds if the division is
 *    where it should be.
 * 3. **Flaky and skipped overlap, and `total` is not their sum.** Asserted rather
 *    than described, on a fixture folder that really has both.
 * 4. **The noise filter is reported, not assumed.** On a single-day file the
 *    command must say it did not apply the filter rather than quietly returning
 *    unfiltered counts under a filtered heading.
 */

import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { type IssuesFile, decodeIssues } from '../lib/formats/issues.ts';
import {
    DEFAULT_AVERAGE_DAYS,
    flakinessByFolder,
    flakinessByFolderAveraged,
    folderList,
} from '../lib/query/flakiness.ts';
import { type DataFileName, type DataSource, DataFileNotFoundError } from '../lib/sources/source.ts';
import { ExitCode } from '../cli/errors.ts';
import { captureStreams } from '../cli/context.ts';
import { diskCache } from '../cli/cache.ts';
import { run } from '../cli/main.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

const issuesFixture = JSON.parse(
    await readFile(new URL('xpcshell-issues.json', FIXTURES), 'utf8')
) as IssuesFile;

// --- the independent walk ------------------------------------------------

/** One folder's own tests, averaged over the last `windowDays` days. */
interface ExpectedFolder {
    /** Mean per day of tests directly here that failed at least once. */
    flaky: number;
    /** Mean per day of tests directly here skipped somewhere. */
    skipped: number;
    /** Mean per day of tests directly here that ran at all. */
    total: number;
    /** Test files directly here that ran at all in the window. */
    testCount: number;
}

/**
 * The per-folder averages, recomputed from the raw fixture.
 *
 * Deliberately dumber than the implementation: a map keyed on the test's
 * directory string, integer test-days accumulated, one division at the end. No
 * tree, no ancestors — which is exactly what makes it a check on `selfFlaky`,
 * the "tests directly in this folder" counter the command ranks on.
 */
function independentFolderAverage(
    file: IssuesFile,
    windowDays: number
): Map<string, ExpectedFolder> {
    const days = file.metadata.days;
    const statuses = file.tables.statuses;
    const messages = file.tables.messages;
    const from = days - windowDays;

    /** Integer test-days per folder, divided only at the very end. */
    const acc = new Map<string, { flaky: number; skipped: number; total: number; tests: number }>();

    // The directory comes straight off `testInfo.testPathIds`, which is the
    // interning the file already does — so this walk does not have to split a
    // path and cannot disagree with the decoder about where a folder ends.
    const paths = file.tables.testPaths;
    const pathIds = file.testInfo.testPathIds;

    for (let testId = 0; testId < file.testRuns.length; testId++) {
        const perTest = file.testRuns[testId];
        if (!perTest) {
            continue;
        }
        const directory = paths[pathIds[testId]!]!;

        const fail = new Array<number>(days).fill(0);
        const pass = new Array<number>(days).fill(0);
        const skip = new Array<number>(days).fill(0);
        let windowFailures = 0;

        for (let statusId = 0; statusId < perTest.length; statusId++) {
            const group = perTest[statusId];
            if (!group) {
                continue;
            }
            const status = statuses[statusId]!;
            const raw = group as unknown as {
                days?: number[];
                counts?: number[];
                messageIds?: (number | null)[];
            };
            if (raw.days === undefined || raw.counts === undefined) {
                continue;
            }
            // Prefix matching, not the shared classifier, so a taxonomy change
            // cannot move both sides at once.
            const isSkip = status === 'SKIP';
            const isExpectedFail = status.startsWith('EXPECTED-FAIL');
            const isFail = !isExpectedFail && /^(FAIL|TIMEOUT|CRASH)/.test(status);
            const isPass = isExpectedFail || status.startsWith('PASS');

            let day = 0;
            for (let index = 0; index < raw.days.length; index++) {
                day += raw.days[index]!;
                const count = raw.counts[index]!;
                if (isFail) {
                    fail[day] = fail[day]! + count;
                    windowFailures += count;
                } else if (isPass) {
                    pass[day] = pass[day]! + count;
                } else if (isSkip) {
                    const messageId = raw.messageIds?.[index];
                    const message =
                        messageId === null || messageId === undefined
                            ? null
                            : messages[messageId]!;
                    if (message === null || !message.startsWith('run-if')) {
                        skip[day] = skip[day]! + count;
                    }
                }
            }
        }

        // The default noise threshold of 1, reimplemented: a test failing once
        // across the whole window has those failures read as passes.
        const neutralised = windowFailures > 0 && windowFailures <= 1;

        let flakyDays = 0;
        let skippedDays = 0;
        let totalDays = 0;
        for (let day = from; day < days; day++) {
            const failed = neutralised ? 0 : fail[day]!;
            const passed = pass[day]! + (neutralised ? fail[day]! : 0);
            const skipped = skip[day]!;
            // flaky beats skipped beats stable, and a test with nothing that day
            // is in no state at all.
            let state: 'flaky' | 'skipped' | 'stable' | null = null;
            if (failed > 0) {
                state = 'flaky';
            } else if (skipped > 0) {
                state = 'skipped';
            } else if (passed > 0) {
                state = 'stable';
            }
            if (state === null) {
                continue;
            }
            totalDays++;
            if (state === 'flaky') {
                flakyDays++;
            }
            // The **overlapping** reading, which is the table's skip column: was
            // it skipped somewhere that day, whether or not it also failed.
            if (skipped > 0) {
                skippedDays++;
            }
        }
        if (totalDays === 0) {
            continue;
        }
        const entry = acc.get(directory) ?? { flaky: 0, skipped: 0, total: 0, tests: 0 };
        entry.flaky += flakyDays;
        entry.skipped += skippedDays;
        entry.total += totalDays;
        entry.tests += 1;
        acc.set(directory, entry);
    }

    const out = new Map<string, ExpectedFolder>();
    for (const [directory, entry] of acc) {
        out.set(directory, {
            flaky: entry.flaky / windowDays,
            skipped: entry.skipped / windowDays,
            total: entry.total / windowDays,
            testCount: entry.tests,
        });
    }
    return out;
}

/**
 * Two means are equal if they agree well inside one test-day.
 *
 * `tolerance` is 1e-9 against the library, which returns raw means, and looser
 * against `--json`, which deliberately rounds to 4 decimals so its shape does not
 * churn between runs. Comparing the rounded surface at 1e-9 would be asserting
 * that the rounding does not happen.
 */
function assertMean(actual: number, expected: number, message: string, tolerance = 1e-9): void {
    assert.ok(
        Math.abs(actual - expected) < tolerance,
        `${message}: got ${actual}, the independent walk says ${expected}`
    );
}

/** Half a unit in the last place `--json` keeps, plus slack for the rounding. */
const JSON_TOLERANCE = 1e-4;

// --- the library function ------------------------------------------------

test('the averaged folder list matches an independent walk of the fixture', () => {
    const decoded = decodeIssues(issuesFixture);
    const { root, windowDays } = flakinessByFolderAveraged(decoded);
    assert.equal(windowDays, DEFAULT_AVERAGE_DAYS);

    const expected = independentFolderAverage(issuesFixture, DEFAULT_AVERAGE_DAYS);
    const rows = folderList(root);
    assert.ok(rows.length > 0, 'the fixture must produce folder rows');

    // Every folder the independent walk found must be a row, and vice versa —
    // a missing folder is as wrong as a wrong number and would not be caught by
    // checking only the rows that exist.
    assert.deepEqual(
        new Set(rows.map((row) => row.path)),
        new Set(expected.keys()),
        'the set of folders with their own tests must match the independent walk'
    );

    for (const row of rows) {
        const want = expected.get(row.path)!;
        assertMean(row.selfFlaky, want.flaky, `${row.path} selfFlaky`);
        assertMean(row.selfSkipped, want.skipped, `${row.path} selfSkipped`);
        assertMean(row.selfTotal, want.total, `${row.path} selfTotal`);
        assert.equal(row.selfTestCount, want.testCount, `${row.path} selfTestCount`);
    }
});

test('averaging divides once, so a constant folder comes out exactly integral', () => {
    // The float bug this pins: accumulating `1/windowDays` per day made a folder
    // whose tests were skipped every single day read 130.99999999999997 instead
    // of 131, and every `subtree === self` comparison false by ~3.6e-14.
    //
    // Derived from the fixture rather than asserted as a literal: the property is
    // "a count that is a whole number of test-days is exactly a whole number of
    // tests", which is checkable without knowing which folders qualify.
    const decoded = decodeIssues(issuesFixture);
    const { root, windowDays } = flakinessByFolderAveraged(decoded);
    let checked = 0;
    for (const row of folderList(root)) {
        for (const [label, value] of [
            ['selfFlaky', row.selfFlaky],
            ['selfSkipped', row.selfSkipped],
            ['selfTotal', row.selfTotal],
        ] as const) {
            // `value * windowDays` is a count of test-days and so an integer. If
            // the division happened per-day, this is where the drift shows.
            const testDays = value * windowDays;
            assert.ok(
                Math.abs(testDays - Math.round(testDays)) < 1e-9,
                `${row.path} ${label} = ${value} is not a whole number of test-days ` +
                    `over ${windowDays} days (${testDays}) — the division moved`
            );
            checked++;
        }
    }
    assert.ok(checked > 0, 'nothing was checked, so this asserts nothing');
});

test('the three scopes give different answers on the same data', () => {
    // The reason the default had to be chosen rather than defaulted into: all
    // three are defensible readings and they disagree. If this stops failing to
    // be equal, one of the scopes has silently become another.
    const decoded = decodeIssues(issuesFixture);
    const folder = 'toolkit/components/extensions/test/xpcshell';
    const own = (root: ReturnType<typeof flakinessByFolder>): number =>
        folderList(root).find((row) => row.path === folder)?.selfFlaky ?? -1;

    const lastDay = own(flakinessByFolder(decoded));
    const wholeWindow = own(flakinessByFolder(decoded, { allDays: true }));
    const averaged = own(flakinessByFolderAveraged(decoded).root);

    assert.ok(lastDay >= 0 && wholeWindow >= 0 && averaged >= 0, 'the folder must be present');
    // The whole window is the loosest bar — "flaky on any day" — so it can only
    // be greater than or equal to a single day's, and on this fixture it is
    // strictly greater. That inequality is the 84%-denominator effect in
    // miniature and is the thing the default avoids.
    assert.ok(
        wholeWindow > lastDay,
        `--all-days must be a looser bar than one day (${wholeWindow} vs ${lastDay})`
    );
    assert.ok(
        averaged <= wholeWindow,
        `a mean of daily verdicts cannot exceed the any-day verdict (${averaged} vs ${wholeWindow})`
    );
});

test('flaky and skipped overlap, so they do not sum to the total', () => {
    const decoded = decodeIssues(issuesFixture);
    const { root } = flakinessByFolderAveraged(decoded);
    const rows = folderList(root);
    const overlapping = rows.filter((row) => row.selfFlakyAndSkipped > 0);
    assert.ok(
        overlapping.length > 0,
        'the fixture must contain a folder with a test that is both flaky and skipped, or this ' +
            'asserts nothing'
    );
    for (const row of overlapping) {
        // The named overlap accounts for the excess exactly. `stable` is not on
        // the list row, so the identity is checked the way a reader would: the
        // two overlapping columns exceed the population by the overlap.
        assert.ok(
            row.selfFlaky + row.selfSkipped - row.selfFlakyAndSkipped <= row.selfTotal + 1e-9,
            `${row.path}: flaky + skipped - both must not exceed total`
        );
    }
});

// --- the command ---------------------------------------------------------

const FILES: Record<string, string> = {
    'xpcshell-timings/index.json': 'index.json',
    'xpcshell-timings/xpcshell-issues.json': 'xpcshell-issues.json',
    // The same fixture bytes served as mochitest, so `--harness mochitest` can be
    // exercised at all. What is under test is which flags the suggested follow-up
    // commands carry, not the contents of a mochitest file.
    'mochitest-timings/index.json': 'index.json',
    'mochitest-timings/mochitest-issues.json': 'xpcshell-issues.json',
};

function fixtureSource(): DataSource & { requested: string[] } {
    const requested: string[] = [];
    return {
        name: 'fixtures',
        requested,
        async fetch(fileName: DataFileName): Promise<Uint8Array> {
            const key = `${fileName.index}/${fileName.filename}`;
            requested.push(key);
            const local = FILES[key];
            if (local === undefined) {
                throw new DataFileNotFoundError(fileName);
            }
            return new Uint8Array(await readFile(new URL(local, FIXTURES)));
        },
    };
}

async function invoke(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const streams = captureStreams();
    const code = await run({
        argv,
        streams,
        source: fixtureSource(),
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
    });
    return { code, stdout: streams.stdout, stderr: streams.stderr };
}

function json(stdout: string): Record<string, unknown> {
    return JSON.parse(stdout) as Record<string, unknown>;
}

test('flaky defaults to the burndown list over a 7-day average', async () => {
    const { code, stdout } = await invoke(['flaky', '--json', '--quiet']);
    assert.equal(code, ExitCode.Success);
    const result = json(stdout);
    assert.equal(result['groupBy'], 'list', 'the default view is the burndown list');
    assert.equal(result['sort'], 'flaky');
    const header = result['header'] as Record<string, unknown>;
    assert.equal(header['scope'], 'average');
    assert.equal(header['averageDays'], DEFAULT_AVERAGE_DAYS);
    assert.equal(
        (header['scopeDates'] as string[]).length,
        DEFAULT_AVERAGE_DAYS,
        'scopeDates must name every day averaged, so a reader can check the window'
    );
});

test('the default rows carry the independently derived means', async () => {
    // The command's numbers, against the same independent walk — so a regression
    // between the library and the command is caught as well as one inside it.
    const { stdout } = await invoke(['flaky', '--json', '--quiet', '--limit', '0']);
    const rows = json(stdout)['rows'] as {
        path: string;
        flaky: number;
        skipped: number;
        total: number;
        testCount: number;
    }[];
    const expected = independentFolderAverage(issuesFixture, DEFAULT_AVERAGE_DAYS);
    assert.equal(rows.length, expected.size);
    for (const row of rows) {
        const want = expected.get(row.path)!;
        assert.ok(want !== undefined, `${row.path} is not a folder the independent walk found`);
        assertMean(row.flaky, want.flaky, `${row.path} flaky`, JSON_TOLERANCE);
        assertMean(row.skipped, want.skipped, `${row.path} skipped`, JSON_TOLERANCE);
        assertMean(row.total, want.total, `${row.path} total`, JSON_TOLERANCE);
        assert.equal(row.testCount, want.testCount);
    }
});

test('rows are ranked by the folder’s own flaky count, descending', async () => {
    const { stdout } = await invoke(['flaky', '--json', '--quiet', '--limit', '0']);
    const rows = json(stdout)['rows'] as { path: string; flaky: number }[];
    assert.ok(rows.length > 1, 'need at least two rows to observe an order');
    for (let i = 1; i < rows.length; i++) {
        assert.ok(
            rows[i - 1]!.flaky >= rows[i]!.flaky,
            `ranked on the folder's own flaky count: row ${i - 1} has ${rows[i - 1]!.flaky} and ` +
                `row ${i} has ${rows[i]!.flaky}`
        );
    }
});

test('the list ranks a folder’s own tests, not its subtree', async () => {
    // The whole reason the flat list exists: the roll-up puts a container first.
    // `toolkit` holds every extensions test in the fixture and must not be a row
    // in the list view, because it has no test files of its own.
    const list = json((await invoke(['flaky', '--json', '--quiet', '--limit', '0'])).stdout);
    const paths = (list['rows'] as { path: string }[]).map((row) => row.path);
    assert.ok(
        !paths.includes('toolkit'),
        'a pure container has no tests of its own and is not a burndown candidate'
    );

    // ...and the subtree view does rank it, which is what makes the two views
    // different rather than differently labelled.
    const tree = json(
        (await invoke(['flaky', '--json', '--quiet', '--group-by', 'folder', '--limit', '0'])).stdout
    );
    const treePaths = (tree['rows'] as { path: string }[]).map((row) => row.path);
    assert.ok(treePaths.includes('toolkit'), '--group-by folder rolls subtrees up');
});

test('the text output states the scope and the noise filter, compactly', async () => {
    const { stdout } = await invoke(['flaky', '--quiet', '--limit', '3']);
    // The two per-run facts that survive the preamble trim, because each is a
    // factor-of-several difference a reader would otherwise attribute to Firefox:
    // which window produced the table, and whether the noise filter moved the
    // numbers. `flaky.html` shipped a bug where tiles showed one day above a
    // table showing 21 with nothing saying so, so naming the window is not
    // optional.
    assert.match(stdout, /Window: mean per day over the 7 days/);
    assert.match(stdout, /Noise filter/);

    // And the standing definitions are **not** here — they moved to `--help`,
    // where a reader asks for them once, rather than being reprinted on every
    // invocation. Measured on the pinned window, that preamble was 13 of this
    // command's 24 lines (955 characters, ~238 tokens).
    for (const moved of [/Flaky means/, /OVERLAP/, /whole number\s+of weeks/, /run-if excluded/]) {
        assert.doesNotMatch(stdout, moved, `${String(moved)} belongs in --help, not in every run`);
    }
    // Not lost, though: `--help` has to carry every one of them. Matched across
    // line breaks, since the help text is hand-wrapped and a phrase may straddle
    // two lines — this is checking the prose is present, not how it is folded.
    const help = (await invoke(['flaky', '--help'])).stdout.replace(/\s+/g, ' ');
    for (const kept of [
        /flaky it failed, timed out or crashed/,
        /OVERLAP/,
        /whole number of weeks/,
        /run-if exclusions are not counted/,
    ]) {
        assert.match(help, kept, `${String(kept)} must be findable in --help`);
    }
    // And the follow-up command, so a reader can act without a second lookup.
    // It must be this command's own per-test listing and **not** `issues --path`,
    // which ranks by issue runs and is dominated by skips: on the pinned window
    // for toolkit/components/telemetry/tests/unit, `issues --group-by test` puts
    // test_UserInteraction_annotations.js first with 6,879 issues of which 6,782
    // are skips, and this classification calls that test skipped, not flaky. A
    // footer sending a reader to a differently-defined listing of the folder they
    // just picked is worse than no footer.
    assert.match(stdout, /fx-tests flaky toolkit\//);
    assert.doesNotMatch(
        stdout,
        /fx-tests issues/,
        'the follow-up must not be `issues`, whose definition of a problem test differs'
    );
    // `skips` stays, because it answers what this command cannot: *why* something
    // is disabled. Here the classification is a boolean; `skips` prints skip-if.
    assert.match(stdout, /fx-tests skips --path /);
});

test('the suggested commands carry --harness, so they cannot answer for the wrong one', async () => {
    // A silent wrong answer, not a cosmetic omission. Both suggestions on the
    // folder ranking take a **directory**, and `detectHarness()` classifies on a
    // filename — a directory has none, so it falls through to the xpcshell
    // default. Under `--harness mochitest` the footer therefore offered two
    // commands that would report on xpcshell and look entirely plausible doing it.
    const mochitest = await invoke(['flaky', '--quiet', '--harness', 'mochitest', '--limit', '3']);
    const suggestions = mochitest.stdout
        .split('\n')
        .filter((line) => line.trim().startsWith('fx-tests '));
    assert.ok(suggestions.length >= 2, 'the ranking must suggest a drill-down and a skips lookup');
    for (const line of suggestions) {
        assert.match(
            line,
            /--harness mochitest/,
            `"${line.trim()}" would run against xpcshell, the default, and answer for the wrong harness`
        );
    }

    // The per-test footer too, whose argument is a file: `detectHarness` would
    // rescue a `browser_*.js` path and cannot rescue `test_*.js`, which is both
    // harnesses' naming, so it is propagated there rather than relied upon.
    const listing = await invoke([
        'flaky', 'toolkit', '--quiet', '--harness', 'mochitest', '--limit', '2',
    ]);
    for (const line of listing.stdout.split('\n').filter((l) => l.trim().startsWith('fx-tests '))) {
        assert.match(line, /--harness mochitest/, `"${line.trim()}" must name its harness`);
    }

    // And **not** on the common path, where the flag would be noise: an omitted
    // --harness already means xpcshell.
    const xpcshell = await invoke(['flaky', '--quiet', '--limit', '3']);
    assert.doesNotMatch(
        xpcshell.stdout,
        /--harness/,
        'xpcshell is the default, so saying so on every suggestion is bloat'
    );
});

test('a suggestion carries the scope only when the reader asked for it', async () => {
    // `--day` changes the numbers, so a suggestion reverting to the default would
    // send the reader to a different table than the row they picked came from.
    const named = await invoke(['flaky', '--quiet', '--day', '2026-08-03', '--limit', '2']);
    for (const line of named.stdout.split('\n').filter((l) => l.trim().startsWith('fx-tests '))) {
        assert.match(line, /--day 2026-08-03/, `"${line.trim()}" must carry the day it ranked`);
    }

    // But the per-test listing takes the ranking's window *by default*, and
    // suggesting a flag for it would print something the reader never typed and
    // pin a later run to today's dates. `scopeRequested` is what separates the two
    // cases. Checked on the suggestion lines rather than the whole output: the
    // header's own caveat names `--day` and `--all-days` as the two other windows
    // available, which is prose about the alternatives and not a command to run.
    const listing = await invoke(['flaky', 'toolkit', '--quiet', '--limit', '2']);
    for (const line of listing.stdout.split('\n').filter((l) => l.trim().startsWith('fx-tests '))) {
        assert.doesNotMatch(
            line,
            /--day|--all-days|--average-days/,
            `"${line.trim()}": the listing’s default window was not requested, so no suggestion ` +
                'may name it'
        );
    }

    // `--noise` goes only to the command that accepts it: `fx-tests test` and
    // `fx-tests skips` would reject it as an unknown flag.
    const noisy = await invoke(['flaky', '--quiet', '--noise', '0', '--limit', '2']);
    const lines = noisy.stdout.split('\n').filter((l) => l.trim().startsWith('fx-tests '));
    assert.ok(
        lines.some((line) => /fx-tests flaky .*--noise 0/.test(line)),
        'the flaky drill-down must reproduce the noise threshold'
    );
    assert.ok(
        lines.every((line) => !/fx-tests skips.*--noise/.test(line)),
        'skips does not accept --noise, and an unknown flag is a usage error'
    );
});

test('--all-days and --day each name their window in the header', async () => {
    // The naming is what must survive the trim: the three scopes give a 48%, a
    // 53% and a 75% reading of the same folder, and a reader cannot tell them
    // apart from the digits. Why each window behaves as it does — the ~84%
    // measurement, the 2.6x weekend volume — is standing prose and lives in
    // `--help`.
    const all = await invoke(['flaky', '--quiet', '--all-days', '--limit', '2']);
    assert.match(all.stdout, /Window: --all-days/);
    assert.match(all.stdout, /all 21 days/, 'the looser bar must say what it covers');

    const one = await invoke(['flaky', '--quiet', '--day', '2026-08-03', '--limit', '2']);
    assert.match(one.stdout, /Window: --day 2026-08-03/);

    // The explanations are in --help, once, rather than on both of those runs.
    const help = (await invoke(['flaky', '--help'])).stdout.replace(/\s+/g, ' ');
    assert.match(help, /~84% of tests/, 'the all-days denominator caveat moved here');
    assert.match(help, /weekend push volume is 2\.6x lower/, 'as did the weekday risk');
});

test('the scopes are mutually exclusive rather than one silently winning', async () => {
    for (const argv of [
        ['flaky', '--day', '2026-08-03', '--all-days'],
        ['flaky', '--day', '2026-08-03', '--average-days', '7'],
        ['flaky', '--all-days', '--average-days', '7'],
    ]) {
        const { code, stderr } = await invoke([...argv, '--quiet']);
        assert.equal(code, ExitCode.Usage, `${argv.join(' ')} must be a usage error`);
        assert.match(stderr, /mutually exclusive/);
    }
});

test('--sort is refused on the trend view rather than ignored', async () => {
    // A calendar is not a ranking, and a flag that silently does nothing is
    // indistinguishable from one that is not implemented.
    const { code, stderr } = await invoke(['flaky', '--group-by', 'days', '--sort', 'flaky', '--quiet']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /--sort does not apply/);
});

test('--config is refused, because issues.json attributes nothing', async () => {
    const { code, stderr } = await invoke(['flaky', '--config', 'linux', '--quiet']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /records no job names/);
});

test('the trend view’s three states sum to its total', async () => {
    // The one view whose classification is mutually exclusive. The folder views'
    // columns deliberately do not sum, so asserting this here is what keeps the
    // two readings from being conflated.
    const { stdout } = await invoke(['flaky', '--group-by', 'days', '--json', '--quiet', '--limit', '0']);
    const result = json(stdout);
    const rows = result['rows'] as {
        date: string;
        flaky: number;
        stable: number;
        skipped: number;
        total: number;
    }[];
    assert.equal(rows.length, issuesFixture.metadata.days);
    for (const row of rows) {
        assert.equal(
            row.flaky + row.stable + row.skipped,
            row.total,
            `${row.date}: the per-day states are exclusive and must sum to total`
        );
    }
    // Oldest first, as the files encode it and the charts plot it.
    assert.equal(rows[0]!.date, issuesFixture.metadata.startDate);
    assert.equal(rows.at(-1)!.date, issuesFixture.metadata.endDate);
});

test('the trend limit keeps the newest days, not the oldest', async () => {
    // A truncated calendar that dropped today would answer "how is it now" with
    // last fortnight.
    const { stdout } = await invoke(['flaky', '--group-by', 'days', '--json', '--quiet', '--limit', '3']);
    const rows = json(stdout)['rows'] as { date: string }[];
    assert.equal(rows.length, 3);
    assert.equal(rows.at(-1)!.date, issuesFixture.metadata.endDate);
});

test('--path narrows the population, and a miss says so', async () => {
    // `--harness xpcshell` is explicit because the fixture serves the *same
    // bytes* under both harnesses, so a directory path matches in both and
    // `flaky` answers for both (`harnessesForPathFilter`). That widening has its
    // own tests below; this one is about the path filter.
    const { stdout } = await invoke([
        'flaky',
        '--json',
        '--quiet',
        '--harness',
        'xpcshell',
        '--limit',
        '0',
        '--path',
        'netwerk/',
    ]);
    const result = json(stdout);
    const rows = result['rows'] as { path: string }[];
    assert.ok(rows.length > 0, 'netwerk/ must match something in the fixture');
    for (const row of rows) {
        assert.ok(row.path.startsWith('netwerk'), `${row.path} is outside --path netwerk/`);
    }

    // A miss under *both* harnesses, which is the only case that still reports a
    // possible typo now that a directory queries both.
    const miss = await invoke(['flaky', '--quiet', '--path', 'no/such/directory']);
    assert.equal(miss.code, ExitCode.Success, 'an empty result is an answer, not an error');
    assert.match(miss.stdout, /No folder matched/);
    assert.match(miss.stdout, /--path/, 'the empty message must name the filter that could be wrong');
});

test('a positional path selects the per-test listing, not a usage error', async () => {
    // This used to be rejected with "did you mean --path?". It is now the
    // shorthand for the drill-down, which is how `fx-tests test <path>` and
    // `fx-tests manifests [name]` already read a path.
    // Pinned to one harness for the reason `--path narrows the population` gives:
    // the fixture is the same bytes under both, so a directory would answer twice.
    const { code, stdout } = await invoke([
        'flaky',
        'toolkit/components/extensions/test/xpcshell',
        '--json',
        '--quiet',
        '--harness',
        'xpcshell',
        '--limit',
        '0',
    ]);
    assert.equal(code, ExitCode.Success);
    const result = json(stdout);
    assert.equal(result['groupBy'], 'tests', 'a positional path means the per-test listing');
    assert.equal(result['pathPrefix'], 'toolkit/components/extensions/test/xpcshell');
    // Identical to the long form, so the two spellings cannot drift.
    const long = await invoke([
        'flaky',
        '--path',
        'toolkit/components/extensions/test/xpcshell',
        '--group-by',
        'tests',
        '--json',
        '--quiet',
        '--harness',
        'xpcshell',
        '--limit',
        '0',
    ]);
    assert.equal(long.stdout, stdout, 'flaky <path> must be exactly --path <path> --group-by tests');
});

test('the two spellings of the path cannot contradict each other', async () => {
    // Refused rather than merged: `flaky dom --path netwerk` has no reading that
    // is not a guess about which one the caller meant.
    const both = await invoke(['flaky', 'dom', '--path', 'netwerk', '--quiet']);
    assert.equal(both.code, ExitCode.Usage);
    assert.match(both.stderr, /same selection/);

    // A positional with any other view leaves it meaning nothing, which is the
    // "flag did nothing" failure this CLI rejects unknown flags to avoid.
    for (const view of ['list', 'folder', 'days']) {
        const { code, stderr } = await invoke(['flaky', 'netwerk', '--group-by', view, '--quiet']);
        assert.equal(code, ExitCode.Usage, `flaky <path> --group-by ${view} must be refused`);
        assert.match(stderr, new RegExp(`--group-by ${view}`));
        assert.match(stderr, /--path netwerk/, 'and must name the flag that does mean that');
    }

    // Two positionals is one too many, as `fx-tests test` reports it.
    const two = await invoke(['flaky', 'a', 'b', '--quiet']);
    assert.equal(two.code, ExitCode.Usage);
    assert.match(two.stderr, /at most one path/);
});

test('--json means are rounded to a stable number of digits', async () => {
    // The averages are sums of 1/windowDays, so a folder that is flaky every day
    // comes out as 186.99999999999858 raw. Emitting that makes `--json` a shape
    // whose digits move with iteration order, and `CLI.md` promises a stable one.
    const { stdout } = await invoke(['flaky', '--json', '--quiet', '--limit', '0']);
    const rows = json(stdout)['rows'] as Record<string, number | string>[];
    for (const row of rows) {
        for (const [key, value] of Object.entries(row)) {
            if (typeof value !== 'number') {
                continue;
            }
            const decimals = String(value).split('.')[1]?.length ?? 0;
            assert.ok(
                decimals <= 4,
                `${String(row['path'])}.${key} = ${value} carries ${decimals} decimals; --json ` +
                    'must round means so the shape does not churn between runs'
            );
        }
    }
    // And a value that *is* a whole number is emitted as one, rather than as
    // 186.9999 — the case that made this necessary. Which values qualify is a
    // property of the data, so the expectation is derived rather than pinned: a
    // skip count that does not move across the window is integral, and the
    // fixture has one.
    const integral = rows.filter((row) => Number.isInteger(row['skipped']));
    assert.ok(
        integral.length > 0,
        'the fixture must contain a folder whose skip count is constant across the window, or ' +
            'this cannot check that integral means stay integral'
    );
    for (const row of integral) {
        assert.equal(
            String(row['skipped']).includes('.'),
            false,
            `${String(row['path'])} skipped = ${row['skipped']} must serialise without a decimal`
        );
    }
});

test('--noise 0 disables the filter, and the header reports what was applied', async () => {
    const off = json((await invoke(['flaky', '--json', '--quiet', '--noise', '0'])).stdout);
    const offHeader = off['header'] as Record<string, unknown>;
    assert.equal(offHeader['minWindowFailures'], 0);
    assert.equal(offHeader['neutralisedTests'], 0, 'nothing is neutralised with the filter off');

    const on = json((await invoke(['flaky', '--json', '--quiet'])).stdout);
    const onHeader = on['header'] as Record<string, unknown>;
    assert.equal(onHeader['minWindowFailures'], 1, 'the default threshold is 1');
    // The applied threshold and the requested one are both reported, so a caller
    // can see when they differ — which is what a single-day file causes.
    assert.equal(onHeader['requestedMinWindowFailures'], 1);
    assert.equal(onHeader['noiseFilterSkipped'], false);
});

// --- a directory path queries both harnesses -----------------------------

/**
 * `fx-tests flaky <directory>` with no `--harness`.
 *
 * The defect: `--harness` is documented as "Inferred from the test path by
 * default", `detectHarness` infers from the **filename**, and a directory has
 * none — so it fell through to xpcshell. On a mochitest-only directory the
 * command searched the wrong file, found nothing, and told the reader to check
 * their path for a typo that was not there. Measured on the published data,
 * `toolkit/components/passwordmgr/test/browser` has 1,760 failures on its top
 * mochitest message and no xpcshell rows at all.
 *
 * There is nothing in the aggregates to infer a folder's harness from — that is
 * in its manifests, and the CLI has no checkout — so the resolution is to ask
 * both and let the data answer.
 */

/**
 * The directory each harness's copy of the fixture puts its tests under.
 *
 * `netwerk/test/unit` is xpcshell's, from the fixture; the mochitest copy is
 * relocated to `netwerk/test/browser`. So `netwerk/test` is a directory **both**
 * harnesses run under and neither owns — which is the real tree's shape (and the
 * shape of item 17's own `netwerk/test` example), and the case a both-have-data
 * test has to be built from.
 */
const XPCSHELL_DIR = 'netwerk/test/unit';
const MOCHITEST_DIR = 'netwerk/test/browser';
/** The directory above both, matched by each harness for different rows. */
const SHARED_DIR = 'netwerk/test';

/**
 * A source serving both aggregates, with the mochitest one **relocated**.
 *
 * There is one issues fixture and it is xpcshell's. Serving those same bytes
 * under both names — which is what `FILES` does for the `--harness` tests — makes
 * every path match under both harnesses, and then no test can tell "printed the
 * harness that has data" apart from "printed both". So the mochitest copy's
 * folder table has each path's leaf renamed to `browser`, putting its rows beside
 * the xpcshell ones rather than on top of them: `netwerk/test/unit` stays
 * xpcshell-only, `netwerk/test/browser` becomes mochitest-only, and
 * `netwerk/test` has both. That is the disjointness the real tree has and the
 * fixture lacks, and it is what lets the three cases item 17 names be told apart.
 *
 * `available` drops a harness's file entirely, for the 404 case.
 */
function harnessSource(available: readonly string[] = ['xpcshell', 'mochitest']): DataSource {
    return {
        name: 'fixtures',
        async fetch(fileName: DataFileName): Promise<Uint8Array> {
            const harness = fileName.index.replace(/-timings$/, '');
            const key = `${fileName.index}/${fileName.filename}`;
            const local = FILES[key];
            if (local === undefined || !available.includes(harness)) {
                throw new DataFileNotFoundError(fileName);
            }
            const bytes = new Uint8Array(await readFile(new URL(local, FIXTURES)));
            if (harness !== 'mochitest' || fileName.filename === 'index.json') {
                return bytes;
            }
            const file = JSON.parse(new TextDecoder().decode(bytes)) as {
                tables: { testPaths: string[] };
            };
            file.tables.testPaths = file.tables.testPaths.map((path) =>
                path.replace(/[^/]+$/, 'browser')
            );
            return new TextEncoder().encode(JSON.stringify(file));
        },
    };
}

/** `harnessSource`, recording every file name it was asked for. */
function fetchCounting(): { source: DataSource; requested: string[] } {
    const inner = harnessSource();
    const requested: string[] = [];
    return {
        requested,
        source: {
            name: inner.name,
            async fetch(fileName: DataFileName): Promise<Uint8Array> {
                requested.push(`${fileName.index}/${fileName.filename}`);
                return inner.fetch(fileName);
            },
        },
    };
}

async function invokeWith(
    source: DataSource,
    argv: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
    const streams = captureStreams();
    const code = await run({
        argv,
        streams,
        source,
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
    });
    return { code, stdout: streams.stdout, stderr: streams.stderr };
}

test('a directory prints the harness that has data, not the one it guessed', async () => {
    // The bug's shape exactly: a directory only mochitest runs. The old code read
    // xpcshell, found nothing, and blamed a typo. Both aggregates are published
    // here — the xpcshell one simply has no row under this path.
    const mochitestOnly = await invokeWith(harnessSource(), [
        'flaky',
        MOCHITEST_DIR,
        '--quiet',
        '--limit',
        '3',
    ]);
    assert.equal(mochitestOnly.code, ExitCode.Success);
    assert.match(
        mochitestOnly.stdout,
        /^mochitest flaky tests/,
        'the harness with rows leads, rather than the xpcshell default with none'
    );
    assert.doesNotMatch(
        mochitestOnly.stdout,
        /for typos/,
        'there is no typo to hunt: the directory has data, under the other harness'
    );
    assert.doesNotMatch(
        mochitestOnly.stdout,
        /^xpcshell flaky tests/m,
        'the empty harness must not print a header of its own'
    );

    // And the mirror, so the rule is "whichever has rows" rather than
    // "mochitest wins".
    const xpcshellOnly = await invokeWith(harnessSource(), [
        'flaky',
        XPCSHELL_DIR,
        '--quiet',
        '--limit',
        '3',
    ]);
    assert.equal(xpcshellOnly.code, ExitCode.Success);
    assert.match(xpcshellOnly.stdout, /^xpcshell flaky tests/);
    assert.doesNotMatch(xpcshellOnly.stdout, /^mochitest flaky tests/m);
});

test('a directory with data under both harnesses prints both, each with its header', async () => {
    // A real directory a user would type: `netwerk/test` holds the xpcshell tests
    // in `unit/` and the mochitest ones in `browser/`, which is item 17's own
    // example and the shape of the tree. Not `--path ''` — that means the same
    // thing as omitting `--path`, and pinning this requirement to a path form
    // nobody types would leave the requirement effectively untested.
    const { code, stdout } = await invokeWith(harnessSource(), [
        'flaky',
        '--quiet',
        '--path',
        SHARED_DIR,
        '--group-by',
        'list',
        '--limit',
        '3',
    ]);
    assert.equal(code, ExitCode.Success);
    assert.match(stdout, /^xpcshell flaky/m);
    assert.match(stdout, /^mochitest flaky/m);
    // Each section really is that harness's own rows, not the same table twice.
    assert.match(stdout, new RegExp(`^\\s+${XPCSHELL_DIR}\\s`, 'm'));
    assert.match(stdout, new RegExp(`^\\s+${MOCHITEST_DIR}\\s`, 'm'));

    // `--json` cannot emit two documents on one stdout, so the pair is wrapped —
    // and only then, so a single answer keeps the shape existing callers parse.
    const wrapped = await invokeWith(harnessSource(), [
        'flaky',
        '--quiet',
        '--path',
        SHARED_DIR,
        '--group-by',
        'list',
        '--json',
        '--limit',
        '0',
    ]);
    const both = (json(wrapped.stdout)['harnesses'] as Record<string, unknown>[] | undefined) ?? [];
    assert.equal(both.length, 2, 'both harnesses answered, so both are in the JSON');
    assert.deepEqual(
        both.map((one) => (one['header'] as Record<string, unknown>)['harness']),
        ['xpcshell', 'mochitest']
    );

    const single = await invokeWith(harnessSource(), [
        'flaky',
        XPCSHELL_DIR,
        '--json',
        '--quiet',
        '--limit',
        '0',
    ]);
    assert.equal(
        json(single.stdout)['harnesses'],
        undefined,
        'one answer must not be wrapped: that would break every existing --json caller'
    );
});

test('the typo message survives, for the one case where it is the right answer', async () => {
    // Both empty is the only remaining case where "check the path" is advice
    // rather than a misdirection — and it must be said once, not once per harness.
    const { code, stdout } = await invokeWith(harnessSource(), [
        'flaky',
        '--quiet',
        '--path',
        'no/such/directory',
    ]);
    assert.equal(code, ExitCode.Success, 'an empty result is an answer, not an error');
    assert.equal(
        stdout.match(/No folder matched/g)?.length,
        1,
        'the not-found message must print once, not once per harness searched'
    );
    // Once, but naming **both** files. The message exists so a reader can tell a
    // clean tree from a mistyped path, which it cannot do if it reports one
    // aggregate after downloading two.
    assert.match(stdout, /tests in xpcshell-issues\.json and [\d,]+ tests in mochitest-issues\.json/);

    // The per-test listing's own message carries it too — three views, one phrase.
    const listing = await invokeWith(harnessSource(), [
        'flaky',
        '--quiet',
        'no/such/directory',
    ]);
    assert.match(
        listing.stdout,
        /tests in xpcshell-issues\.json and [\d,]+ tests in mochitest-issues\.json/
    );

    // And the single-harness wording is untouched: one file searched, one named.
    const pinned = await invokeWith(harnessSource(), [
        'flaky',
        '--quiet',
        '--harness',
        'xpcshell',
        '--path',
        'no/such/directory',
    ]);
    assert.match(pinned.stdout, /Searched [\d,]+ tests in xpcshell-issues\.json,/);
    assert.doesNotMatch(pinned.stdout, /mochitest-issues\.json/);
});

test('an explicit --harness is never widened, and neither is the tree-wide ranking', async () => {
    // The reader named the file; answering about the other one too would be
    // ignoring the flag. Asserted where mochitest *does* have rows under the
    // path, so the second section exists and is deliberately not taken.
    const pinned = await invokeWith(harnessSource(), [
        'flaky',
        '--quiet',
        '--harness',
        'xpcshell',
        '--path',
        SHARED_DIR,
        '--group-by',
        'list',
        '--limit',
        '3',
    ]);
    assert.doesNotMatch(pinned.stdout, /^mochitest flaky/m);

    // And with no path there is no directory to be wrong about: the default
    // ranking stays the one file it always read.
    const treeWide = await invokeWith(harnessSource(), ['flaky', '--quiet', '--limit', '3']);
    assert.doesNotMatch(treeWide.stdout, /^mochitest flaky/m);
});

test('--path \'\' is the same query as no --path, and fetches the same files', async () => {
    // An empty prefix selects every test, which is what omitting the flag means.
    // Left to fall through to `isDirectoryPath('')` it read as a directory and
    // doubled the download for an identical question. Asserted on the fetches
    // rather than the output, because the output would have looked fine.
    const withEmpty = fetchCounting();
    const withNone = fetchCounting();
    const a = await invokeWith(withEmpty.source, ['flaky', '--quiet', '--path', '', '--limit', '3']);
    const b = await invokeWith(withNone.source, ['flaky', '--quiet', '--limit', '3']);
    assert.deepEqual(
        withEmpty.requested,
        withNone.requested,
        'an empty prefix must not read a second aggregate that no --path does not'
    );
    assert.equal(withEmpty.requested.filter((key) => key.includes('issues')).length, 1);
    // The rows are the same selection. Not asserted on the whole of stdout: the
    // header prints "Under  only." for an empty prefix, a cosmetic defect that
    // predates this change and is out of item 17's scope.
    const rows = (text: string): string[] =>
        text.split('\n').filter((line) => line.includes('flaky') || line.startsWith('  toolkit'));
    assert.deepEqual(rows(a.stdout), rows(b.stdout), 'the same selection must rank the same');
});

test('--group-by days counts test-days, not calendar rows, when it decides who has data', async () => {
    // This view has one row per **day**, so a harness that ran nothing under the
    // path still returns a full 21-row calendar of zeroes. Testing `rows.length`
    // would call that "has data" and print an all-zero table above the real one.
    const { code, stdout } = await invokeWith(harnessSource(), [
        'flaky',
        '--quiet',
        '--path',
        MOCHITEST_DIR,
        '--group-by',
        'days',
        '--limit',
        '3',
    ]);
    assert.equal(code, ExitCode.Success);
    assert.match(stdout, /^mochitest flakiness by day/);
    assert.doesNotMatch(
        stdout,
        /^xpcshell flakiness by day/m,
        'a calendar of zeroes is not an answer, and must not be printed as one'
    );
});

test('the trend view counts test-days over the window, not over the --limit tail', async () => {
    // `rows` is the printed tail — `--since` and `--limit` both slice it — so
    // summing it to decide "did this harness run anything here" asks the question
    // of the last few days instead of the window. A folder that ran early and
    // stopped then reads as no data at `--limit 3` and prints at `--limit 0`,
    // which is the same answer changing with a display flag.
    const windowDays = 21;
    const full = json(
        (
            await invokeWith(harnessSource(), [
                'flaky',
                '--quiet',
                '--json',
                '--harness',
                'xpcshell',
                '--path',
                'netwerk/test/unit',
                '--group-by',
                'days',
                '--limit',
                '0',
            ])
        ).stdout
    );
    const tail = json(
        (
            await invokeWith(harnessSource(), [
                'flaky',
                '--quiet',
                '--json',
                '--harness',
                'xpcshell',
                '--path',
                'netwerk/test/unit',
                '--group-by',
                'days',
                '--limit',
                '3',
            ])
        ).stdout
    );

    // The tail really is shorter, so the two would differ if `testDays` were
    // summed over what is printed.
    assert.equal((full['rows'] as unknown[]).length, windowDays);
    assert.equal((tail['rows'] as unknown[]).length, 3);
    assert.ok((full['testDays'] as number) > 0, 'the fixture folder ran on every day');
    assert.equal(
        tail['testDays'],
        full['testDays'],
        '--limit is a display flag and must not change what the window contains'
    );

    // And it is the *whole* window, not merely limit-invariant: an independent
    // sum over the unsliced rows.
    const summed = (full['rows'] as { total: number }[]).reduce((sum, row) => sum + row.total, 0);
    assert.equal(full['testDays'], summed);
    assert.ok(
        summed > ((tail['rows'] as { total: number }[]).reduce((sum, r) => sum + r.total, 0)),
        'the fixture must have more test-days in the window than in its last three days, ' +
            'or this test cannot tell the two sums apart'
    );
});

test('a harness that publishes nothing is no data, not an error', async () => {
    // The mochitest read is this command's own initiative. A 404 on it says the
    // aggregate is not published, which is the same answer as an empty table, and
    // it must not take the xpcshell answer down with it. See `ifPublished`.
    const { code, stdout } = await invokeWith(harnessSource(['xpcshell']), [
        'flaky',
        '--quiet',
        '--path',
        'netwerk/',
        '--group-by',
        'list',
        '--limit',
        '3',
    ]);
    assert.equal(code, ExitCode.Success);
    assert.match(stdout, /^xpcshell flaky/);
});
