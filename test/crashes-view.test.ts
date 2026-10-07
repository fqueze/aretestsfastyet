/**
 * `crashes.html`'s page-local view model.
 *
 * The shared drill-down it is built on is covered by
 * `test/drilldown-view.test.ts`; this file is only what is true of the crashes
 * page — the signature as the row key, the link decisions, and the agreement
 * with `lib/query/crashes.ts` that `PARITY.md` §5 asks for.
 *
 * Same rule as the shared tests: **no expected value comes from the thing under
 * test.** The signature tallies below are read off the raw fixture by hand.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeIssuesWithTaskIds } from '../lib/formats/issues.ts';
import type { IssuesWithTaskIdsFile } from '../lib/formats/issues.ts';
import { groupCrashesBySignature } from '../lib/query/crashes.ts';
import { INITIAL_SORT, rowsOf } from '../site/drilldown-view.ts';
import type { Occurrence } from '../site/drilldown-view.ts';
import {
    CRASH_NOUN,
    buildCrashGroups,
    crashLinksOf,
    crashRows,
    singleCrashOpensViewer,
} from '../site/crashes-view.ts';

const file = JSON.parse(
    readFileSync(
        new URL('../test/fixtures/xpcshell-issues-with-taskids.json', import.meta.url),
        'utf8'
    )
) as IssuesWithTaskIdsFile;
const decoded = decodeIssuesWithTaskIds(file);
const startTime = file.metadata.startTime;

/**
 * Signature → distinct `dirPath/testName`, and signature → occurrences, read
 * straight off the raw JSON without touching `site/` or `lib/query/`.
 */
function tally(): { tests: Map<string, Set<string>>; counts: Map<string, number> } {
    const tests = new Map<string, Set<string>>();
    const counts = new Map<string, number>();
    const crashStatusId = file.tables.statuses.indexOf('CRASH');

    file.testRuns.forEach((testGroup, testId) => {
        if (!testGroup) {
            return;
        }
        const group = testGroup[crashStatusId] as
            | { crashSignatureIds?: (number | null)[]; taskIdIds?: number[][] }
            | null
            | undefined;
        if (!group?.crashSignatureIds || !group.taskIdIds) {
            return;
        }
        const dirPath = file.tables.testPaths[file.testInfo.testPathIds[testId]!]!;
        const testName = file.tables.testNames[file.testInfo.testNameIds[testId]!]!;

        group.crashSignatureIds.forEach((id, index) => {
            if (id === null) {
                return;
            }
            const signature = file.tables.crashSignatures[id];
            if (!signature) {
                return;
            }
            counts.set(signature, (counts.get(signature) ?? 0) + group.taskIdIds![index]!.length);
            const seen = tests.get(signature) ?? new Set<string>();
            seen.add(`${dirPath}/${testName}`);
            tests.set(signature, seen);
        });
    });
    return { tests, counts };
}

const expected = tally();

test('the fixture exercises this page at all', () => {
    assert.ok(expected.counts.size > 0, 'the fixture must contain crashes');
    assert.ok(
        [...expected.counts.values()].reduce((sum, n) => sum + n, 0) > 0,
        'and some occurrences'
    );
});

test('a row is one crash signature, counting its occurrences', () => {
    const rows = crashRows(buildCrashGroups(decoded, startTime), '', INITIAL_SORT);
    assert.equal(rows.length, expected.counts.size);
    for (const row of rows) {
        assert.equal(row.count, expected.counts.get(row.key), `count of ${row.key}`);
        assert.equal(row.testCount, expected.tests.get(row.key)!.size, `tests of ${row.key}`);
    }
});

test('the default view is most crashes first', () => {
    const rows = crashRows(buildCrashGroups(decoded, startTime), '', INITIAL_SORT);
    const counts = rows.map((row) => row.count);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
});

test('the page and the CLI agree on every signature, count and test count', () => {
    // `PARITY.md` §5, value parity. Two code paths over the same file: the CLI's
    // `groupCrashesBySignature` counts distinct test IDs, and the page sums
    // `tests.size` across directory paths. They must give the same answer.
    const rows = crashRows(buildCrashGroups(decoded, startTime), '', INITIAL_SORT);
    const cli = groupCrashesBySignature(decoded);

    // The CLI keeps unsymbolized crashes as a `null` group and the page drops
    // them. On this fixture there are none, so the two sets must match exactly —
    // and if a future fixture gains one, this assertion is where it surfaces.
    assert.equal(
        cli.filter((group) => group.signature === null).length,
        0,
        'fixture has no unsymbolized crashes, so the null-group divergence is latent here'
    );

    const cliByKey = new Map(cli.map((group) => [group.signature, group]));
    assert.deepEqual(
        rows.map((row) => row.key).sort(),
        [...cliByKey.keys()].sort(),
        'same signatures'
    );
    for (const row of rows) {
        const group = cliByKey.get(row.key)!;
        assert.equal(row.count, group.count, `occurrences of ${row.key}`);
        assert.equal(row.testCount, group.testCount, `distinct tests of ${row.key}`);
    }
});

test('the page and the CLI rank identically, as a full sequence', () => {
    // Order parity. The sort-key bug `PARITY.md` §1 records produced the same
    // set in a *different order*, which no set comparison would catch — so this
    // asserts the whole ranked sequence rather than a spot check.
    //
    // Ties are included rather than skipped, and that is safe here for a reason
    // worth stating: both sides sort with `Array.prototype.sort`, which is
    // stable, over an input built by the same walk (ascending test ID, then the
    // status groups of each test). So a tie resolves the same way on both. The
    // fixture makes this load-bearing — of its 7 signatures only one has a
    // unique count, so skipping ties would compare a sequence of length 1 and
    // assert nothing.
    const rows = crashRows(buildCrashGroups(decoded, startTime), '', INITIAL_SORT);
    const cli = groupCrashesBySignature(decoded);

    assert.deepEqual(
        rows.map((row) => [row.key, row.count]),
        cli.map((group) => [group.signature, group.count])
    );
    assert.ok(rows.length > 1, 'a one-row sequence would not test an order');
});

test('the tooltip noun is the one the page uses', () => {
    assert.equal(CRASH_NOUN, 'signature');
});

// --- the links ------------------------------------------------------------

const withDump: Occurrence = {
    jobName: 'test-linux1804-64/opt-xpcshell-1',
    date: '2026-08-03',
    taskId: 'abc',
    retryId: '0',
    minidump: 'DUMP-ID',
};
const withoutDump: Occurrence = { ...withDump, minidump: null };

test('an occurrence gets a crash link only when a dump was uploaded', () => {
    assert.deepEqual(crashLinksOf(withDump, true), { profile: true, crash: true, job: true });
    assert.deepEqual(crashLinksOf(withoutDump, true), { profile: true, crash: false, job: true });
    // `undefined` is "the group recorded no minidumps array at all", which is
    // the same "nothing to fetch" as an explicit null.
    assert.deepEqual(crashLinksOf({ ...withDump, minidump: undefined }, true), {
        profile: true,
        crash: false,
        job: true,
    });
});

test('the job link depends on the file being able to resolve a revision', () => {
    assert.equal(crashLinksOf(withDump, false).job, false);
    // The profile link is unconditional: it is built from the task ID alone.
    assert.equal(crashLinksOf(withoutDump, false).profile, true);
});

test('a single-occurrence row is inert when there is no dump to open', () => {
    // Upstream writes `data-crash-url=""` and its handler's `if (crashUrl)`
    // makes the row do nothing. The row still looks clickable, because the
    // cursor is on `.test-row` in the stylesheet.
    assert.equal(singleCrashOpensViewer(withDump), true);
    assert.equal(singleCrashOpensViewer(withoutDump), false);
});

test('every occurrence in the 21-day file carries a dump, so rows do open', () => {
    // An earlier version of this test asserted the opposite, on the strength of
    // `fx-tests crashes` printing `0` in its dumps column for every row and
    // saying "this file records no minidump IDs". That is true of the file the
    // *CLI* reads and not of the file the *page* reads, and the test caught the
    // mistake. Measured across the three:
    //
    //   xpcshell-issues.json                (CLI)   0 of 0 dumps, no array
    //   xpcshell-issues-with-taskids.json   (page)  318 of 318 in the fixture
    //   the same file, full snapshot                21,252 of 21,252
    //
    // So on the page's default 21-day view every single-crash row is clickable,
    // and the CLI's caveat is about a different file.
    const groups = buildCrashGroups(decoded, startTime);
    let occurrences = 0;
    let openable = 0;
    for (const group of groups.values()) {
        for (const path of group.paths.values()) {
            for (const testNode of path.tests.values()) {
                for (const occurrence of testNode.occurrences) {
                    occurrences++;
                    if (singleCrashOpensViewer(occurrence)) {
                        openable++;
                    }
                }
            }
        }
    }
    assert.ok(occurrences > 0);
    assert.equal(openable, occurrences, 'every crash occurrence has a dump to open');
});

test('the search keeps rows whole', () => {
    // The crashes-specific half of the two search semantics, asserted here as
    // well as in the shared tests because it is what `crashRows` wires up.
    const groups = buildCrashGroups(decoded, startTime);
    const all = rowsOf(groups);
    const target = all.find((row) => row.testCount > 1);
    assert.ok(target !== undefined, 'need a signature spanning several tests');

    const [path] = [...target.paths.values()];
    const [testNode] = [...path!.tests.values()];
    const rows = crashRows(groups, testNode!.testName.toLowerCase(), INITIAL_SORT);
    const found = rows.find((row) => row.key === target.key);
    assert.ok(found !== undefined, 'a matching test name must keep its row');
    assert.equal(found.count, target.count, 'and the row keeps its full count');
    assert.equal(found.paths.size, target.paths.size, 'and its whole subtree');

    // The other half, and the half that was missing: the non-matching rows must
    // be *gone*. Asserting only that the match survives with its counts intact
    // passes against a `crashRows` that does no filtering at all — measured,
    // deleting `filterGroupsByMatch` from it left all eleven tests in this file
    // green while the search took 7 rows to 1. "Keeps rows whole" is a claim
    // about the rows that remain; it says nothing unless the set shrinks.
    assert.ok(
        rows.length < all.length,
        `the search matched every one of the ${all.length} rows, so this asserts nothing`
    );
    for (const row of rows) {
        const matches = [...row.paths.values()].some((p) =>
            [...p.tests.keys()].some((name) =>
                name.toLowerCase().includes(testNode!.testName.toLowerCase())
            )
        );
        assert.ok(matches, `${row.key} survived the search without matching it`);
    }
});
