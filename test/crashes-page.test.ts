/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * `site/crashes.ts`, the crashes page controller, driven end to end in jsdom.
 *
 * ## Why this file exists at all
 *
 * The controller exports exactly one thing — `start()` — and everything this
 * suite is meant to cover is module-private behind it: the `VOCAB` record, the
 * eight `RenderHooks`, the three `endsX` stop predicates, the chart series
 * walks, `loadSelectedDate`, `onHistoricalToggled` and `loadFromUrlHash`. There
 * is no seam to unit-test them through, so they are tested the way a reader
 * exercises them: by loading the page and clicking it.
 *
 * That is not a compromise. It is what makes a **page-identity** mistake fail
 * here: `test/drilldown-render.test.ts` proves the renderer emits the crashes
 * tree when handed the crashes vocabulary, and this file proves the crashes
 * page hands it that one. Neither test alone catches a swapped `VOCAB`.
 *
 * ## Where the expected values come from
 *
 * Nothing here calls the code under test to find out what to expect.
 *
 * - The seven signature rows, their counts and their test counts are tallied
 *   off the raw fixture JSON by `tallyCrashes()` below, which reads
 *   `tables`/`testRuns` directly and imports nothing from `site/`.
 * - Every class name and label is a literal, taken from
 *   `common-data-view.css` and the old `crashes.html`.
 * - Link hrefs are built by the **real** `common-links.js`, loaded into the
 *   jsdom window by `test/dom-harness.ts` — so an assertion that a job cell
 *   points at the crash viewer is comparing two independent computations of
 *   that URL rather than a stub's echo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupPage, fixture, shape, shapes, pathTo } from './dom-harness.ts';
import type { IssuesWithTaskIdsFile } from '../lib/formats/issues.ts';

// --- ground truth, read off the raw fixture -------------------------------

const RAW = fixture<IssuesWithTaskIdsFile>('xpcshell-issues-with-taskids.json');
const DAILY = fixture<{
    metadata: { jobCount?: number };
    tables: { statuses: string[]; crashSignatures?: string[] };
}>('xpcshell-2026-08-03.json');
const INDEX = fixture<{ dates: string[] }>('index.json');

interface Tally {
    /** signature → occurrences */
    counts: Map<string, number>;
    /** signature → distinct `dirPath/testName` */
    tests: Map<string, Set<string>>;
}

/** The crashes in the 21-day fixture, counted without touching `site/`. */
function tallyCrashes(): Tally {
    const counts = new Map<string, number>();
    const tests = new Map<string, Set<string>>();
    const crashStatusId = RAW.tables.statuses.indexOf('CRASH');

    RAW.testRuns.forEach((testGroup, testId) => {
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
        const dirPath = RAW.tables.testPaths[RAW.testInfo.testPathIds[testId]!]!;
        const testName = RAW.tables.testNames[RAW.testInfo.testNameIds[testId]!]!;
        group.crashSignatureIds.forEach((id, index) => {
            if (id === null) {
                return;
            }
            const signature = RAW.tables.crashSignatures[id];
            if (signature === undefined) {
                return;
            }
            counts.set(signature, (counts.get(signature) ?? 0) + group.taskIdIds![index]!.length);
            const seen = tests.get(signature) ?? new Set<string>();
            seen.add(`${dirPath}/${testName}`);
            tests.set(signature, seen);
        });
    });
    return { counts, tests };
}

const TALLY = tallyCrashes();
/** The rows the default view must show: most crashes first. */
const EXPECTED_ROWS = [...TALLY.counts]
    .map(([key, count]) => ({ key, count, testCount: TALLY.tests.get(key)!.size }))
    .sort((a, b) => b.count - a.count);

test('the fixture exercises what this suite claims to cover', () => {
    // Vacuity guard. Every assertion below is conditional on the fixture
    // containing the case; if a future fixture loses one, the tests that depend
    // on it would pass by having nothing to check.
    assert.ok(EXPECTED_ROWS.length > 1, 'several signatures, so order means something');
    assert.ok(
        EXPECTED_ROWS.some((row) => row.testCount > 1),
        'a signature spanning several tests, so a path row is reachable'
    );
    assert.ok(
        EXPECTED_ROWS.some((row) => row.count === 1),
        'a signature with one occurrence, so a single-crash row is reachable'
    );
    // The field is `minidumps` — dump IDs are stored inline, not through a
    // table. Checked against the raw JSON rather than assumed from the decoder.
    const dumps = RAW.testRuns
        .flatMap((testGroup) => {
            const group = testGroup?.[RAW.tables.statuses.indexOf('CRASH')] as
                | { minidumps?: (string | null)[] }
                | null
                | undefined;
            return group?.minidumps ?? [];
        })
        .filter((dump) => dump !== null && dump !== '');
    assert.ok(dumps.length > 0, 'the fixture records minidumps, so the crash link is reachable');
});

// --- the harness ----------------------------------------------------------

const FILES = {
    'index.json': INDEX,
    'xpcshell-issues-with-taskids.json': RAW,
    'xpcshell-2026-08-03.json': DAILY,
};

/**
 * A page, started, on the crashes URL.
 *
 * The controller holds module-level state (`groups`, `expandedSignature`, the
 * sort), so it is imported **once** and every test shares it — a second
 * `import()` returns the same module instance. Tests are therefore written to
 * leave the page as they found it, and the ones that cannot are ordered so the
 * ones after them re-render first.
 */
const harness = setupPage({ url: 'https://tests.firefox.dev/crashes.html', files: FILES });
const { start } = await import('../site/crashes.ts');
await start();

const list = (): HTMLElement => harness.content.querySelector('.crash-list')!;
const dataRows = (): HTMLElement[] => [
    ...list().querySelectorAll<HTMLElement>('.crash-row:not(.total-row)'),
];
const searchBox = (): HTMLInputElement =>
    harness.document.getElementById('searchBox') as HTMLInputElement;

/** The rows following `row` up to, but not including, the next top-level row. */
function subtreeOf(row: Element): HTMLElement[] {
    const out: HTMLElement[] = [];
    let next = row.nextElementSibling;
    while (
        next !== null &&
        !next.classList.contains('crash-row') &&
        !next.classList.contains('sort-header')
    ) {
        out.push(next as HTMLElement);
        next = next.nextElementSibling;
    }
    return out;
}

/** Closes whatever is open, so the next test starts from a known page. */
function collapseAll(): void {
    for (const row of dataRows()) {
        if (row.classList.contains('expanded')) {
            row.click();
        }
    }
}

// =========================================================================
// 1. Page identity — the crashes VOCAB really is the crashes one
// =========================================================================

test('the page renders the crashes vocabulary and none of the failures names', () => {
    const root = list();
    assert.equal(shape(root), 'div.crash-list');

    // Present, with counts. A `querySelector` that merely found one would pass
    // against a page that rendered a single row of the right kind.
    const rowCount = EXPECTED_ROWS.length;
    assert.equal(root.querySelectorAll('.crash-row').length, rowCount + 1, 'rows plus the total');
    assert.equal(root.querySelectorAll('.crash-signature').length, rowCount + 2, 'plus the header');
    assert.equal(root.querySelectorAll('.crash-stats').length, rowCount + 2);
    assert.equal(root.querySelectorAll('.stat-value.crash').length, rowCount + 1);

    // Absent. This is the half that makes a swapped VOCAB fail: every one of
    // these is what the *other* page emits at the same position.
    for (const name of [
        'failure-list',
        'failure-row',
        'failure-message',
        'failure-stats',
        'single-failure',
        'failure-job-name',
        'test-failure-count',
    ]) {
        assert.equal(harness.content.querySelector(`.${name}`), null, `no .${name} on crashes`);
    }
    assert.equal(harness.content.querySelector('.stat-value.fail'), null);
});

test('the page names its columns "Crash Signature" and "Crashes"', () => {
    const header = list().querySelector('.sort-header')!;
    assert.equal(header.querySelector('.crash-signature')!.textContent, 'Crash Signature');
    const labels = [...header.querySelectorAll('button')].map(
        (button) => button.lastChild!.textContent
    );
    assert.deepEqual(labels, ['Tests', 'Crashes']);
    // Not the failures page's words, which sit in the same two positions.
    assert.equal(labels.includes('Failures'), false);
    assert.equal(header.textContent!.includes('Failure Message'), false);
});

test('a signature label is plain text with no title and no Searchfox anchor', () => {
    // `site/crashes.ts:244-247`: `labelNodes: (key) => [key]` and
    // `labelTitle: () => undefined`. The failures page does the opposite on
    // both counts, so this is the hook pair asserted as a page identity.
    for (const row of dataRows()) {
        const cell = row.querySelector('.crash-signature')!;
        assert.equal(cell.children.length, 0, `${cell.textContent}: no child elements`);
        assert.equal(cell.hasAttribute('title'), false, 'no title on a signature cell');
    }
    assert.equal(list().querySelector('.crash-signature a'), null, 'no linkified signature');
});

test('no test row on the crashes page carries a bug-filing button', () => {
    // `testNameSuffix: () => null` (`site/crashes.ts:272`). The failures page
    // emits 24 of these on the same fixture, so the absence is a real
    // distinction rather than an artefact of empty data.
    let testRows = 0;
    for (const row of dataRows()) {
        row.click();
        for (const sub of subtreeOf(row)) {
            if (sub.classList.contains('test-row')) {
                testRows++;
                assert.equal(sub.querySelector('.action-button'), null, 'no 🐛 button');
                assert.equal(sub.querySelector('a[href*="bugzilla"]'), null, 'no Bugzilla link');
            }
        }
        row.click();
    }
    assert.ok(testRows > 0, `${testRows} test rows were inspected`);
});

// =========================================================================
// 2. What the default view shows
// =========================================================================

test('the default view is the 21-day file, ranked most crashes first', () => {
    // The 21-day file is the default despite `isHistoricalMode = false` at
    // module scope: `loadFromUrlHash` sees no `date` in the hash and toggles.
    // Measured by what was fetched — the daily file is in `files` and was never
    // asked for.
    assert.deepEqual(harness.requested, ['index.json', 'xpcshell-issues-with-taskids.json']);

    assert.deepEqual(
        dataRows().map((row) => row.querySelector('.crash-signature')!.textContent),
        EXPECTED_ROWS.map((row) => row.key),
        'every signature, in descending-count order'
    );
});

test('each row shows the test count and the occurrence count from the file', () => {
    assert.deepEqual(
        dataRows().map((row) =>
            [...row.querySelectorAll('.stat-value')].map((value) => value.textContent)
        ),
        EXPECTED_ROWS.map((row) => [String(row.testCount), String(row.count)])
    );
});

test('the total row sums the column above it, overcounting tests as upstream does', () => {
    // Divergence 3, reproduced. The numbers are the *sums of the rows*, not the
    // distinct counts — and on this fixture they differ, which is what makes
    // the assertion meaningful rather than a coincidence of small data.
    const expectedTests = EXPECTED_ROWS.reduce((sum, row) => sum + row.testCount, 0);
    const expectedCount = EXPECTED_ROWS.reduce((sum, row) => sum + row.count, 0);
    const distinctTests = new Set([...TALLY.tests.values()].flatMap((set) => [...set])).size;
    assert.notEqual(expectedTests, distinctTests, 'the fixture must exhibit the overcount');

    const totalRow = list().querySelector('.crash-row.total-row')!;
    assert.equal(totalRow.querySelector('.crash-signature')!.textContent, '📊 Total');
    assert.deepEqual(
        [...totalRow.querySelectorAll('.stat-value')].map((value) => value.textContent),
        [String(expectedTests), String(expectedCount)]
    );
});

test('the status text reports the 21-day window from the file"s own metadata', () => {
    const status = harness.document.getElementById('statusText')!;
    assert.equal(
        status.textContent,
        `${RAW.metadata.days} days (${RAW.metadata.startDate} to ${RAW.metadata.endDate})`
    );
});

// =========================================================================
// 3. Expansion: the drill-down and the stop predicates
// =========================================================================

/**
 * A note on `endsSignature`'s three clauses, from mutating each in turn.
 *
 * `site/crashes.ts:338` stops the removal walk on `crash-row`, `sort-header`
 * **or** `total-row`. Only the first is load-bearing, and that is measured
 * rather than argued:
 *
 * | clause removed | result |
 * | --- | --- |
 * | `crash-row` | 15 tests fail |
 * | `total-row` | survives |
 * | `sort-header` | survives |
 *
 * Both survivors are redundant by construction, not by accident of this
 * fixture. `renderTotalRow` emits `class="${vocab.rowClass} total-row"`
 * (`site/drilldown-render.ts:496`), so **every** `total-row` is also a
 * `crash-row` and the first clause already caught it; and the `sort-header` is
 * `renderList`'s first child, so it is never a following sibling of an expanded
 * row at all. Upstream lists all three (`old/crashes.html:841`) and they are
 * reproduced as written.
 *
 * No test is added for the two: an assertion that cannot distinguish the code
 * from the mutant is the defect this suite is written against.
 */
test('expanding a signature inserts its subtree directly after the row', () => {
    const row = dataRows()[0]!;
    const before = list().children.length;
    row.click();

    assert.equal(row.classList.contains('expanded'), true);
    const subtree = subtreeOf(row);
    assert.ok(subtree.length > 0, 'something was inserted');
    assert.equal(list().children.length, before + subtree.length, 'and nothing else moved');
    // In the 21-day view the first inserted element is the chart slot.
    assert.equal(shape(subtree[0]!), 'div.historical-chart');

    row.click();
    assert.equal(row.classList.contains('expanded'), false);
    assert.equal(subtreeOf(row).length, 0, 'closing removes the whole run');
    assert.equal(list().children.length, before, 'and restores the list exactly');
});

test('expanding a second signature closes the first', () => {
    // `toggleSignature` (`site/crashes.ts:378`): only one signature is open at
    // a time, and the previously open row is found through `rowsByKey`.
    const [first, second] = dataRows();
    first!.click();
    assert.ok(subtreeOf(first!).length > 0);

    second!.click();
    assert.equal(first!.classList.contains('expanded'), false, 'the first row closed');
    assert.equal(subtreeOf(first!).length, 0, 'and its rows are gone');
    assert.equal(second!.classList.contains('expanded'), true);
    assert.ok(subtreeOf(second!).length > 0);
    assert.equal(list().querySelectorAll('.crash-row.expanded').length, 1, 'exactly one open');

    second!.click();
    assert.equal(list().querySelectorAll('.expanded').length, 0);
});

test('a signature spanning several tests in one directory expands to a path row', () => {
    const multi = EXPECTED_ROWS.find((row) => row.testCount > 1)!;
    const row = dataRows().find(
        (candidate) => candidate.querySelector('.crash-signature')!.textContent === multi.key
    )!;
    row.click();
    const subtree = subtreeOf(row);
    const pathRows = subtree.filter((element) => element.classList.contains('path-row'));
    assert.ok(pathRows.length > 0, `${multi.key} must produce a path row`);

    // Expanding the path inserts its tests immediately under it, and closing it
    // removes exactly those — the `endsPath` predicate stops on anything that
    // is not a test row, a chart or an instance table.
    // The whole list before, as a sequence. Comparing the *sequence* rather
    // than a length is what makes this fail on a stop predicate that ate one
    // row too many: `endsPath` stops on anything that is not a test row, a
    // chart or an instance table, and the row immediately after this path's own
    // run is a `direct-child test-row` belonging to the signature above — so an
    // off-by-one here silently deletes a sibling and leaves the count right.
    const pathRow = pathRows[0]!;
    const before = shapes(list().children);
    pathRow.click();
    const opened = shapes(list().children);

    assert.equal(pathRow.classList.contains('expanded'), true);
    assert.ok(opened.length > before.length, 'the path expanded to something');
    const pathIndex = [...list().children].indexOf(pathRow);
    // Chart first, then the path's tests. `togglePath` (`site/crashes.ts:403`).
    assert.equal(opened[pathIndex + 1], 'div.historical-chart');
    assert.equal(opened[pathIndex + 2], 'div.test-row');
    // Everything before the path row is untouched.
    assert.deepEqual(opened.slice(0, pathIndex), before.slice(0, pathIndex));

    pathRow.click();
    assert.equal(pathRow.classList.contains('expanded'), false);

    // Closing the path does NOT restore the list — it also deletes the
    // `direct-child test-row` that follows and belongs to the *signature*, not
    // to this path. Measured on this fixture: the run before the expansion ends
    // `path-row, direct-child test-row, crash-row` and after closing it is
    // `path-row, crash-row`.
    //
    // Reproduced, not introduced. `endsPath` stops on anything that is not a
    // test row, a chart or an instance table (`site/crashes.ts:349`), and a
    // collapsed-away path's test row *is* a test row — so the walk runs past
    // the end of its own subtree. `old/crashes.html:886-891` is the same loop with
    // the same three classes, so the old page loses the same row.
    //
    // The reader-visible effect: a signature with both a multi-test directory
    // and a single-test one loses the single-test row when the directory is
    // collapsed, and only a full re-render brings it back.
    const closed = shapes(list().children);
    assert.deepEqual(
        closed,
        before.filter((_, index) => index !== pathIndex + 1),
        'exactly one row too many is removed: the sibling immediately after the path'
    );
    assert.equal(before[pathIndex + 1], 'div.direct-child.test-row', 'and that is what it was');

    row.click();
    collapseAll();
});

test('expanding a test inserts an instance table, and closing removes only that', () => {
    // `endsTest` stops on anything that is not a chart or an instance table, so
    // a test close must not eat the sibling test rows below it.
    let covered = 0;
    for (const row of dataRows()) {
        row.click();
        const expandable = subtreeOf(row).filter(
            (element) =>
                element.classList.contains('test-row') &&
                !element.classList.contains('single-crash')
        );
        for (const testRow of expandable) {
            const before = list().children.length;
            const siblingsBelow = subtreeOf(row).length;
            testRow.click();

            // The chart slot goes in first in the 21-day view, then the table.
            assert.equal(shape(testRow.nextElementSibling!), 'div.historical-chart');
            const table = testRow.nextElementSibling!.nextElementSibling!;
            assert.equal(shape(table), 'table.instance-table');
            assert.ok(table.querySelectorAll('tbody > tr').length > 0, 'with occurrence rows');

            testRow.click();
            assert.equal(list().children.length, before, 'the table is gone');
            assert.equal(subtreeOf(row).length, siblingsBelow, 'and the sibling rows survived');
            covered++;
        }
        row.click();
    }
    assert.ok(covered > 0, `${covered} expandable test rows were opened and closed`);
});

// =========================================================================
// 4. The links — the crashes page's hooks
// =========================================================================

test('a single-crash row links its job name at task.html, and its Crash link at its own dump', () => {
    // `jobNameHref` is the task page for the occurrence's run
    // (`site/crashes.ts`); the crash viewer is the one link left beside it. The
    // expected viewer URL is rebuilt from the raw task ID and dump ID with the
    // *real* `common-links.js`, so this compares two independent computations
    // rather than echoing a stub.
    const getCrashViewerUrl = (globalThis as unknown as {
        getCrashViewerUrl: (o: { taskId: string; retryId: string; minidump?: string | null }) => string;
    }).getCrashViewerUrl;

    let checked = 0;
    for (const row of dataRows()) {
        row.click();
        for (const single of subtreeOf(row).filter((e) => e.classList.contains('single-crash'))) {
            const job = (single.querySelector('.crash-job-name a') as HTMLAnchorElement).getAttribute('href')!;
            const match = /^task\.html\?task=([\w-]{22})\.(\d+)&test=/.exec(job);
            assert.ok(match !== null, `the job name opens task.html, got ${job.slice(0, 40)}`);
            const [, taskId, retryId] = match;
            assert.ok(RAW.tables.taskIds.includes(`${taskId}.${retryId}`), 'the task is one the file records');

            const crash = (single.querySelector('.view-links a[href^="crash-viewer.html"]') as HTMLAnchorElement).getAttribute('href')!;
            assert.equal(
                crash,
                getCrashViewerUrl({
                    taskId: taskId!,
                    retryId: retryId!,
                    minidump: decodeURIComponent(crash).match(/test_info\/([^/]+)\.json/)![1]!,
                }),
                'the Crash link is the same run’s dump'
            );
            checked++;
        }
        row.click();
    }
    assert.ok(checked > 0, `${checked} single-crash rows were checked`);
});

test('clicking a single-crash row opens the crash viewer for that occurrence', () => {
    // `singleRowHref` (`site/crashes.ts:274`), the click behaviour upstream
    // expresses as `data-crash-url` plus a delegated handler.
    //
    // The row's own listener is what is under test, so the click has to happen
    // and `window.open` has to be observed: asserting only that the row *has*
    // a crash-viewer link elsewhere in it passes against a row that does
    // nothing when clicked, which is measurably the wrong behaviour here —
    // every occurrence in this fixture carries a dump.
    const opened: [string, string][] = [];
    const realOpen = harness.window.open;
    (harness.window as unknown as { open: unknown }).open = (url: string, target: string) => {
        opened.push([url, target]);
        return null;
    };
    try {
        let clicked = 0;
        for (const row of dataRows()) {
            row.click();
            for (const single of subtreeOf(row).filter((e) =>
                e.classList.contains('single-crash')
            )) {
                const before = opened.length;
                single.click();
                assert.equal(opened.length, before + 1, 'the row opened exactly one window');
                const [url, target] = opened[opened.length - 1]!;
                assert.ok(
                    url.startsWith('crash-viewer.html?url='),
                    `a dumped occurrence opens the viewer, got ${url.slice(0, 40)}`
                );
                assert.equal(target, '_blank');
                // The row opens *its own* occurrence: the URL matches the one
                // its Crash link points at.
                assert.equal(
                    url,
                    (single.querySelector('.view-links a[href^="crash-viewer.html"]') as HTMLAnchorElement).getAttribute('href')
                );
                clicked++;
            }
            row.click();
        }
        assert.ok(clicked > 0, `${clicked} single-crash rows were clicked`);
        assert.equal(opened.length, clicked, 'and none of them was inert');
    } finally {
        (harness.window as unknown as { open: unknown }).open = realOpen;
    }
});

test('an occurrence"s links are Profile, Crash and Job, in that order', () => {
    // `occurrenceLinks` (`site/crashes.ts:249`) — `renderCrashLinks` in element
    // form. The order is upstream's and the Crash link is conditional on a
    // dump, so the labels are asserted as a sequence.
    let checked = 0;
    for (const row of dataRows()) {
        row.click();
        for (const single of subtreeOf(row).filter((e) => e.classList.contains('single-crash'))) {
            const holder = single.querySelector('.view-links')!;
            const labels = [...holder.querySelectorAll('a')].map((a) => a.textContent);
            assert.deepEqual(labels, ['Profile', 'Crash', 'Job'], 'every dumped occurrence');
            for (const anchor of holder.querySelectorAll('a')) {
                assert.equal((anchor as HTMLAnchorElement).target, '_blank');
            }
            checked++;
        }
        row.click();
    }
    assert.ok(checked > 0);
});

test('the crashes page nests its inline links in a span, unlike the failures page', () => {
    // The page-identity branch, asserted through the page rather than through a
    // hand-passed vocabulary. Inverting `inlineLinksCell` used to pass the
    // whole suite; it now fails here and in `drilldown-render.test.ts`.
    let checked = 0;
    for (const row of dataRows()) {
        row.click();
        for (const single of subtreeOf(row).filter((e) => e.classList.contains('single-crash'))) {
            const cells = [...single.querySelectorAll('td')];
            assert.equal(cells.length, 3);
            assert.equal(cells[2]!.className, '', 'the links cell is bare');
            assert.equal(shape(cells[2]!.firstElementChild!), 'span.view-links');
            assert.equal(
                pathTo(single, single.querySelector('.view-links a')!),
                'table.inline-instance > tbody > tr > td > span.view-links > a'
            );
            checked++;
        }
        row.click();
    }
    assert.ok(checked > 0, `${checked} inline cells were checked`);
});

test('the expanded occurrence table uses td.view-links, with no span', () => {
    // The counterpart of the inline cell above, and the reason `vocab.kind` is
    // read in exactly one place: here the two pages agree
    // (`old/crashes.html:820`, `old/failures.html:919`), so the crashes page must
    // *not* apply its span nesting.
    //
    // Any expandable test row will do; the search finds the first one rather
    // than assuming which signature has it, because a row's shape depends on
    // the collapse rule.
    let checked = 0;
    for (const row of dataRows()) {
        row.click();
        const testRow = subtreeOf(row).find(
            (element) =>
                element.classList.contains('test-row') &&
                !element.classList.contains('single-crash')
        );
        if (testRow !== undefined) {
            testRow.click();
            const table = testRow.nextElementSibling!.nextElementSibling!;
            assert.equal(shape(table), 'table.instance-table');
            const cells = [...table.querySelectorAll('tr')[0]!.querySelectorAll('td')];
            assert.deepEqual(shapes(cells), ['td.run-date', 'td.crash-job-name', 'td.view-links']);
            assert.equal(table.querySelectorAll('span').length, 0, 'no span here');
            testRow.click();
            checked++;
        }
        row.click();
    }
    assert.ok(checked > 0, `${checked} expanded occurrence tables were checked`);
});

// =========================================================================
// 5. Sorting
// =========================================================================

test('clicking the Crashes header flips the direction without changing the set', () => {
    const header = (): Element => list().querySelector('.sort-header')!;
    const countButton = (): HTMLButtonElement =>
        header().querySelectorAll('button')[1] as HTMLButtonElement;

    const descending = dataRows().map((row) => row.querySelector('.crash-signature')!.textContent);
    countButton().click();
    const ascending = dataRows().map((row) => row.querySelector('.crash-signature')!.textContent);

    assert.deepEqual(
        ascending.map((key) => TALLY.counts.get(key!)),
        [...EXPECTED_ROWS].sort((a, b) => a.count - b.count).map((row) => row.count),
        'now least crashes first'
    );
    assert.deepEqual([...ascending].sort(), [...descending].sort(), 'the same set of rows');
    assert.notDeepEqual(ascending, descending, 'in a different order');
    assert.equal(header().querySelectorAll('.sort-arrow')[1]!.textContent, '▲');

    countButton().click();
    assert.deepEqual(
        dataRows().map((row) => row.querySelector('.crash-signature')!.textContent),
        descending,
        'clicking again restores the original order'
    );
    assert.equal(header().querySelectorAll('.sort-arrow')[1]!.textContent, '▼');
});

test('clicking the Tests header sorts by test count, descending first', () => {
    const testsButton = (): HTMLButtonElement =>
        list().querySelector('.sort-header')!.querySelectorAll('button')[0] as HTMLButtonElement;
    testsButton().click();

    const shown = dataRows().map((row) =>
        Number(row.querySelectorAll('.stat-value')[0]!.textContent)
    );
    assert.deepEqual(shown, [...shown].sort((a, b) => b - a), 'descending by tests');
    assert.equal(
        shown[0],
        Math.max(...EXPECTED_ROWS.map((row) => row.testCount)),
        'the widest signature is first'
    );
    // A new column starts descending — it does not inherit the previous
    // column's direction. `nextSort` (`site/drilldown-view.ts:452`).
    const arrows = [...list().querySelectorAll('.sort-arrow')].map((a) => a.textContent);
    assert.deepEqual(arrows, ['▼', ''], 'the arrow moved to the Tests column');

    // Back to the default, so the rest of the file sees the ranked list.
    list().querySelector('.sort-header')!.querySelectorAll('button')[1]!.dispatchEvent(
        new harness.window.Event('click', { bubbles: true })
    );
});

// =========================================================================
// 6. The search — this page keeps rows whole
// =========================================================================

test('a search drops non-matching rows and leaves the survivors" numbers alone', async () => {
    // Divergence 4. The crashes page filters whole rows; the failures page
    // rewrites the counts. The distinction is what `filterGroupsByMatch` exists
    // for, and it is only visible if the surviving row's number is compared
    // against its unfiltered one.
    const before = dataRows().map((row) => [
        row.querySelector('.crash-signature')!.textContent,
        row.querySelectorAll('.stat-value')[1]!.textContent,
    ]);

    const target = EXPECTED_ROWS[0]!;
    const term = target.key.slice(2, 14);
    assert.ok(term.length > 3, 'a term with something in it');

    searchBox().value = term;
    searchBox().dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400)); // the 300ms debounce

    const after = dataRows().map((row) => [
        row.querySelector('.crash-signature')!.textContent,
        row.querySelectorAll('.stat-value')[1]!.textContent,
    ]);
    assert.ok(after.length < before.length, `the search must drop rows: ${before.length} kept`);
    assert.ok(after.length > 0, 'and keep at least one');

    // Every surviving row matches, and shows exactly the count it had before.
    for (const [key, count] of after) {
        const matches =
            key!.toLowerCase().includes(term.toLowerCase()) ||
            [...TALLY.tests.get(key!)!].some((path) => path.toLowerCase().includes(term.toLowerCase()));
        assert.ok(matches, `${key} survived without matching`);
        assert.equal(
            count,
            String(TALLY.counts.get(key!)),
            'a surviving row keeps its pre-filter count'
        );
    }

    // The total row *does* shrink, because it is summed after the filter. That
    // is the visible consequence of this page's search semantics.
    const total = list().querySelector('.total-row')!.querySelectorAll('.stat-value')[1]!;
    assert.equal(
        Number(total.textContent),
        after.reduce((sum, [, count]) => sum + Number(count), 0)
    );
    assert.ok(
        Number(total.textContent) < EXPECTED_ROWS.reduce((sum, row) => sum + row.count, 0),
        'and it is smaller than the unfiltered total'
    );

    searchBox().value = '';
    searchBox().dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(dataRows().length, before.length, 'clearing the search restores every row');
});

test('a row expanded under a search shows its whole, unfiltered subtree', async () => {
    // The other half of divergence 4, and the half a filter-only test misses:
    // `render()` re-opens from `groups`, not from the filtered rows
    // (`site/crashes.ts:321`).
    const multi = EXPECTED_ROWS.find((row) => row.testCount > 1)!;
    const row = dataRows().find(
        (candidate) => candidate.querySelector('.crash-signature')!.textContent === multi.key
    )!;
    row.click();
    const unfiltered = subtreeOf(row).length;
    assert.ok(unfiltered > 1);

    // Search for one of its test names. The row survives; its subtree must not
    // narrow to the matching test.
    const oneTest = [...TALLY.tests.get(multi.key)!][0]!.split('/').pop()!;
    searchBox().value = oneTest;
    searchBox().dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));

    const reopened = dataRows().find(
        (candidate) => candidate.querySelector('.crash-signature')!.textContent === multi.key
    )!;
    assert.equal(reopened.classList.contains('expanded'), true, 'the row is still open');
    assert.equal(subtreeOf(reopened).length, unfiltered, 'with the same, unnarrowed subtree');

    searchBox().value = '';
    searchBox().dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    collapseAll();

    // A note on what this test does *not* pin, because a mutation proved it.
    //
    // `render()` re-attaches an open row's subtree from `groups`
    // (`site/crashes.ts:315`) rather than from the filtered rows, and the
    // comment there calls that "deliberately the *unfiltered* subtree". Rewiring
    // it to read the filtered row's `paths` instead changes nothing and survives
    // this suite — correctly, because the two are the **same object**:
    // `filterGroupsByMatch` is an `Array.prototype.filter`
    // (`site/drilldown-view.ts:531`) that selects whole rows and never rebuilds
    // `row.paths`, so a surviving row holds the very `PathNode`s `groups` does.
    //
    // The distinction only becomes observable if the crashes page ever adopts a
    // rewriting search, and that is pinned by the next test — which fails the
    // moment `crashRows` starts rewriting. No assertion is added here for it: a
    // check that cannot distinguish the two states would be the kind of test
    // this suite exists to avoid.
});

test('a row matched only by a test name keeps its FULL count, not the matched part', async () => {
    // The assertion that actually separates the two pages' search semantics,
    // and it took a surviving mutation to find: replacing `filterGroupsByMatch`
    // with the failures page's `rewriteGroupsBySearch` failed nothing, because
    // every other search test here uses a term drawn from the *signature* — and
    // a row that matches by key is not rewritten under either rule.
    //
    // The distinguishing case is a row matched only by one of its **test
    // names**. `old/crashes.html:508-526` keeps such a row whole; `failures.html`
    // rewrites its numbers down to the matching test. So the numbers below are
    // the whole row's, and under the failures rule they would be one test's.
    const multi = EXPECTED_ROWS.find((row) => row.testCount > 1)!;
    const tests = [...TALLY.tests.get(multi.key)!];
    const oneTest = tests[0]!.split('/').pop()!;
    assert.equal(
        multi.key.toLowerCase().includes(oneTest.toLowerCase()),
        false,
        'the term must not match the signature, or the rewrite never applies'
    );

    // What that one test contributes, counted off the raw fixture — strictly
    // less than the row, which is what makes "full count" a real claim.
    const crashStatusId = RAW.tables.statuses.indexOf('CRASH');
    let ofThatTest = 0;
    RAW.testRuns.forEach((testGroup, testId) => {
        const group = testGroup?.[crashStatusId] as
            | { crashSignatureIds?: (number | null)[]; taskIdIds?: number[][] }
            | null
            | undefined;
        if (!group?.crashSignatureIds || !group.taskIdIds) {
            return;
        }
        if (RAW.tables.testNames[RAW.testInfo.testNameIds[testId]!] !== oneTest) {
            return;
        }
        group.crashSignatureIds.forEach((id, index) => {
            if (id !== null && RAW.tables.crashSignatures[id] === multi.key) {
                ofThatTest += group.taskIdIds![index]!.length;
            }
        });
    });
    assert.ok(ofThatTest > 0, 'the term does select occurrences of this signature');
    assert.ok(
        ofThatTest < multi.count,
        `${ofThatTest} of ${multi.count} — the two rules must disagree for this to test anything`
    );

    searchBox().value = oneTest;
    searchBox().dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));

    const row = dataRows().find(
        (candidate) => candidate.querySelector('.crash-signature')!.textContent === multi.key
    );
    assert.ok(row !== undefined, 'the row survives on its matching test');
    const [shownTests, shownCount] = [...row.querySelectorAll('.stat-value')].map(
        (value) => value.textContent
    );
    assert.equal(shownCount, String(multi.count), 'the WHOLE count, not the matched test"s');
    assert.notEqual(shownCount, String(ofThatTest), 'which is what the failures rule would show');
    assert.equal(shownTests, String(multi.testCount), 'and the whole test count');
    assert.notEqual(shownTests, '1');

    searchBox().value = '';
    searchBox().dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
});

// =========================================================================
// 7. The charts
// =========================================================================

test('expanding in the 21-day view draws one chart, labelled with the signature', () => {
    harness.charts.length = 0;
    const target = EXPECTED_ROWS[0]!;
    const row = dataRows().find(
        (candidate) => candidate.querySelector('.crash-signature')!.textContent === target.key
    )!;
    row.click();

    assert.equal(harness.charts.length, 1, 'exactly one chart');
    const chart = harness.charts[0]!;
    assert.equal(chart.label, target.key, 'labelled with the signature, not the path');
    assert.equal(chart.eventLabel, 'crash', 'the crashes page"s event noun');
    assert.equal(chart.series.length, RAW.metadata.days, 'one point per day in the file');

    // The series is the signature's, not an empty placeholder: the events over
    // the window must add up to the row's occurrence count.
    const events = chart.series.reduce((sum, point) => sum + point.events, 0);
    assert.equal(events, target.count, 'the chart and the row agree on the total');
    assert.ok(
        chart.series.some((point) => point.totalRuns > 0),
        'and the denominator is populated'
    );

    // The canvas the chart names is the one the renderer put in the tree.
    const canvas = harness.document.getElementById(chart.canvasId);
    assert.ok(canvas !== null, `#${chart.canvasId} exists`);
    assert.equal(canvas.tagName, 'CANVAS');
    assert.equal(canvas.parentElement!.className, 'historical-chart');

    row.click();
    harness.charts.length = 0;
});

test('expanding a path draws a chart labelled "signature in path"', () => {
    const multi = EXPECTED_ROWS.find((row) => row.testCount > 1)!;
    const row = dataRows().find(
        (candidate) => candidate.querySelector('.crash-signature')!.textContent === multi.key
    )!;
    row.click();
    const pathRow = subtreeOf(row).find((e) => e.classList.contains('path-row'));
    assert.ok(pathRow !== undefined, 'the fixture must reach a path row');

    harness.charts.length = 0;
    pathRow.click();
    assert.equal(harness.charts.length, 1);
    const dirPath = pathRow.dataset['path']!;
    assert.equal(harness.charts[0]!.label, `${multi.key} in ${dirPath}`);

    // The path's series must be *restricted to that directory*, and the
    // expected total is counted off the raw fixture rather than compared
    // loosely against the row. An earlier version asserted only
    // `pathEvents <= multi.count`, which a `pathDailyRates` that dropped its
    // path filter satisfies — measured: that mutation survived.
    const crashStatusId = RAW.tables.statuses.indexOf('CRASH');
    let inThisPath = 0;
    RAW.testRuns.forEach((testGroup, testId) => {
        const group = testGroup?.[crashStatusId] as
            | { crashSignatureIds?: (number | null)[]; taskIdIds?: number[][] }
            | null
            | undefined;
        if (!group?.crashSignatureIds || !group.taskIdIds) {
            return;
        }
        if (RAW.tables.testPaths[RAW.testInfo.testPathIds[testId]!] !== dirPath) {
            return;
        }
        group.crashSignatureIds.forEach((id, index) => {
            if (id !== null && RAW.tables.crashSignatures[id] === multi.key) {
                inThisPath += group.taskIdIds![index]!.length;
            }
        });
    });

    const pathEvents = harness.charts[0]!.series.reduce((sum, p) => sum + p.events, 0);
    assert.ok(inThisPath > 0, 'the directory does contribute occurrences');
    assert.ok(
        inThisPath < multi.count,
        `${inThisPath} of ${multi.count} — the signature must span more than this directory, ` +
            'or the path filter makes no difference and this asserts nothing'
    );
    assert.equal(pathEvents, inThisPath, 'the chart counts only this directory');
    assert.notEqual(pathEvents, multi.count, 'and not the whole signature');

    // The crashes page's own status test in `ratesFor` is `=== 'CRASH'`
    // (`site/crashes.ts:567`). Loosening it to `startsWith('CRASH')` survives,
    // and that is expected rather than a gap: measured here, the file's status
    // table contains exactly one CRASH-prefixed entry, `CRASH` itself, so the
    // two rules select the same runs. `site/drilldown-view.ts:150` records the
    // same measurement for the extractor and keeps the exact form deliberately,
    // so a future `CRASH-PARALLEL` is a decision rather than an absorption.
    assert.deepEqual(
        RAW.tables.statuses.filter((status) => status.startsWith('CRASH')),
        ['CRASH'],
        'if a suffixed CRASH status ever appears, exact-vs-prefix becomes observable'
    );

    pathRow.click();
    row.click();
    harness.charts.length = 0;
});

// =========================================================================
// 8. Data loading: the single-day path and its errors
// =========================================================================

test('choosing a date leaves the 21-day view and loads that day"s file', async () => {
    const select = harness.document.getElementById('dateSelect') as HTMLSelectElement;
    assert.deepEqual(
        [...select.options].map((option) => option.value),
        INDEX.dates,
        'the selector was filled from index.json'
    );

    harness.requested.length = 0;
    // The historical toggle is what leaves the 21-day view; the page's own
    // change listener then loads the date.
    (harness.document.getElementById('historicalButton') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    select.value = '2026-08-03';
    select.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(
        harness.requested.includes('xpcshell-2026-08-03.json'),
        `asked for the daily file, got ${JSON.stringify(harness.requested)}`
    );
    assert.equal(
        harness.document.getElementById('statusText')!.textContent,
        `${DAILY.metadata.jobCount!.toLocaleString()} test jobs`,
        'the status text is the file"s own job count'
    );

    // A single-day view still renders the crashes vocabulary, and its rows are
    // the day's crashes rather than the 21-day ones.
    assert.ok(list() !== null);
    assert.ok(
        dataRows().length > 0 && dataRows().length < EXPECTED_ROWS.length,
        `the day has fewer signatures than the window: ${dataRows().length}`
    );
});

test('a single-day view reached from the 21-day view keeps the 21-day denominator', () => {
    // Measured, and it contradicts a comment rather than the code.
    //
    // `site/drilldown-view.ts:814` says "`totalRuns` is 0 unless the 21-day
    // file is loaded […] so every tooltip on a single-day view is empty". That
    // is true only *before* the first toggle. `historicalData` is assigned when
    // the 21-day file loads (`site/crashes.ts:707`) and **never reset**, so
    // toggling back to a single day leaves `totalRunsOf` returning the 21-day
    // run total and every tooltip populated.
    //
    // Not a migration defect: `old/crashes.html:168` assigns the same variable and
    // never clears it either, and `old/crashes.html:718` passes it to
    // `getTestTotalRuns` unconditionally. Reproduced behaviour, asserted here
    // as what actually happens rather than as what the comment claims.
    //
    // Measured on this fixture, expanding all five single-day rows: of the two
    // test rows that carry a count cell, one reads
    // `9 occurrences … out of 15,924 runs` and the other is `''`. The empty one
    // is a test the 21-day file does not contain, so `getTestTotalRuns` finds
    // no denominator — it is *not* single-day mode zeroing the total.
    //
    // The number is the give-away: the daily file records 775 jobs, so a
    // denominator in the thousands can only have come from the 21-day file.
    let populated = 0;
    let checked = 0;
    for (const row of dataRows()) {
        row.click();
        for (const cell of row.parentElement!.querySelectorAll('.test-crash-count')) {
            checked++;
            const title = cell.getAttribute('title')!;
            if (title === '') {
                continue;
            }
            populated++;
            const runs = Number(title.replace(/^.*out of /u, '').replace(/\D/gu, ''));
            assert.ok(
                runs > DAILY.metadata.jobCount!,
                `${runs} runs exceeds the day's ${DAILY.metadata.jobCount} jobs, so it came from the 21-day file`
            );
        }
        row.click();
    }
    assert.ok(checked > 0, `${checked} count cells were checked in single-day mode`);
    assert.ok(
        populated > 0,
        'at least one single-day tooltip carried a 21-day denominator; with none, this asserts nothing'
    );
});

test('a date with no file shows the error, and does not leave a stale list', async () => {
    const select = harness.document.getElementById('dateSelect') as HTMLSelectElement;
    assert.ok(dataRows().length > 0, 'there is a list to lose');

    select.value = '2026-07-14'; // in index.json, but not in the harness's files
    select.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(harness.content.querySelector('.crash-list'), null, 'the list is gone');
    const message = harness.content.querySelector('.no-data')!;
    assert.equal(shape(message), 'div.no-data');
    assert.equal(message.textContent, 'Failed to load data');
    assert.equal(harness.document.getElementById('statusText')!.textContent, 'Error loading data');
});

test('toggling back to 21 days restores the full ranked list', async () => {
    (harness.document.getElementById('historicalButton') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
        dataRows().map((row) => row.querySelector('.crash-signature')!.textContent),
        EXPECTED_ROWS.map((row) => row.key)
    );
    assert.equal(harness.content.querySelector('.no-data'), null);
});

test('a day that decodes but has no crashes shows this page"s empty text', async () => {
    // `VOCAB.emptyText`, which is only reached when the file parses and
    // `groups.size === 0` (`site/crashes.ts:290`). No checked-in fixture is
    // like that, so one is derived here by taking the daily file and removing
    // its CRASH status groups — everything else, including the decode, is
    // unchanged, so this exercises the empty branch and not the error branch.
    //
    // Without this the string is unreachable from a test: mutating it to the
    // failures page's wording failed nothing.
    const crashStatusId = DAILY.tables.statuses.indexOf('CRASH');
    assert.notEqual(crashStatusId, -1, 'the daily file must have a CRASH status to remove');
    const withoutCrashes = JSON.parse(JSON.stringify(DAILY)) as {
        testRuns: (Record<string, unknown> | null)[];
    };
    let removed = 0;
    for (const testGroup of withoutCrashes.testRuns) {
        if (testGroup !== null && testGroup[String(crashStatusId)] !== undefined) {
            delete testGroup[String(crashStatusId)];
            removed++;
        }
    }
    assert.ok(removed > 0, `${removed} crash groups were removed, so the fixture really changed`);

    harness.files.set('xpcshell-2026-08-02.json', withoutCrashes);
    const select = harness.document.getElementById('dateSelect') as HTMLSelectElement;
    (harness.document.getElementById('historicalButton') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    select.value = '2026-08-02';
    select.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const message = harness.content.querySelector('.no-data')!;
    assert.equal(shape(message), 'div.no-data');
    assert.equal(message.textContent, 'No crash data available');
    assert.equal(message.textContent!.includes('failure'), false, 'not the other page"s wording');
    assert.equal(harness.content.querySelector('.crash-list'), null, 'and no empty list frame');
    // It is the *empty* branch, not the error branch: the load succeeded.
    assert.equal(
        harness.document.getElementById('statusText')!.textContent,
        `${DAILY.metadata.jobCount!.toLocaleString()} test jobs`
    );

    // Back to the 21-day view, which every later test starts from.
    (harness.document.getElementById('historicalButton') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(dataRows().length, EXPECTED_ROWS.length, 'the page is restored');
});

test('the 21-day view fills in the per-test tooltip that single-day mode cannot', () => {
    // The counterpart of the single-day test above. With the historical file
    // loaded, `getTestTotalRuns` has a denominator, so the tooltip is written.
    // Both directions are asserted so neither passes by the tooltip never
    // being set at all.
    let withText = 0;
    for (const row of dataRows()) {
        row.click();
        for (const cell of row.parentElement!.querySelectorAll('.test-crash-count')) {
            const title = cell.getAttribute('title')!;
            if (title !== '') {
                // The thousands separator is whatever `toLocaleString()` picks
                // in the host locale — a comma in the browser, a narrow no-break
                // space under node's default ICU — so the group separator is
                // matched loosely and the digits strictly.
                assert.match(
                    title,
                    /^\d+ occurrences? of this signature out of [\d\s,  ]+ runs \(\d+\.\d\d%\)$/u,
                    title
                );
                // The noun is this page's. `failures.html` says "message".
                assert.ok(title.includes('of this signature'));
                assert.equal(title.includes('of this message'), false);
                withText++;
            }
        }
        row.click();
    }
    assert.ok(withText > 0, `${withText} tooltips carried a run total`);
});

// =========================================================================
// 9. URL state
// =========================================================================

test('the hash records the 21-day view and the search term', async () => {
    const hashState = (): URLSearchParams =>
        new URLSearchParams(harness.window.location.hash.slice(1));

    searchBox().value = 'ctypes';
    searchBox().dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(hashState().get('date'), '21days', 'the 21-day view is named in the hash');
    assert.equal(hashState().get('q'), 'ctypes');

    searchBox().value = '';
    searchBox().dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(hashState().get('q'), null, 'an empty term is dropped from the hash');
    assert.equal(hashState().get('date'), '21days');
});

test('a hash naming a date leaves the 21-day view and loads that day', async () => {
    // `loadFromUrlHash` is module-private and only reachable through the
    // `hashchange` event the shared hash manager listens for.
    //
    // The selector is put back to a date the harness *has* first, because the
    // preceding test leaves it on one it does not — and the ordering quirk
    // asserted in the next test would otherwise make this one about that.
    const select = harness.document.getElementById('dateSelect') as HTMLSelectElement;
    select.value = '2026-08-03';

    harness.requested.length = 0;
    harness.window.location.hash = '#date=2026-08-03';
    harness.window.dispatchEvent(new harness.window.Event('hashchange'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(
        harness.requested.includes('xpcshell-2026-08-03.json'),
        `the hash drove a load: ${JSON.stringify(harness.requested)}`
    );
    assert.equal(select.value, '2026-08-03', 'and the selector follows the hash');
    assert.ok(
        dataRows().length > 0 && dataRows().length < EXPECTED_ROWS.length,
        'the single-day list is showing'
    );
});

test('leaving the 21-day view by hash loads the OLD date once before the new one', async () => {
    // Reproduced upstream behaviour, measured rather than inferred, and worth a
    // test because it looks like a bug and is not this migration's.
    //
    // `loadFromUrlHash` (`site/crashes.ts:748-759`) toggles out of historical
    // mode *before* it writes the hash's date into the selector. The toggle's
    // own callback runs `loadSelectedDate()`, which reads the selector — still
    // holding the previously selected date. So a hash navigation from the
    // 21-day view to a date fetches the stale date first and the requested one
    // second.
    //
    // `old/crashes.html:993-1005` has the identical order: `toggleHistoricalData()`
    // then `dateSelect.value = state.date`. So this is upstream's, not the
    // migration's, and is asserted so a future reordering is a deliberate
    // change rather than a silent one.
    const select = harness.document.getElementById('dateSelect') as HTMLSelectElement;

    // Back to the 21-day view, with a stale date left in the selector.
    harness.window.location.hash = '#date=21days';
    harness.window.dispatchEvent(new harness.window.Event('hashchange'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    select.value = '2026-07-14'; // in index.json, absent from the harness's files

    harness.requested.length = 0;
    harness.window.location.hash = '#date=2026-08-03';
    harness.window.dispatchEvent(new harness.window.Event('hashchange'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The whole measured sequence, because the ordering does not merely waste a
    // fetch — the page ends up on the wrong date.
    //
    // 1. `loadFromUrlHash` toggles out of historical mode. The toggle's
    //    callback runs `loadSelectedDate()`, which reads the *stale* selector →
    //    `xpcshell-2026-07-14.json`.
    // 2. `loadFromUrlHash` then writes the hash's date into the selector, and
    //    `onHashChange` calls `loadSelectedDate()` again →
    //    `xpcshell-2026-08-03.json`.
    // 3. The toggle's `updateUrlHash()` had already rewritten the hash from the
    //    selector as it stood in step 1, so a third `hashchange` fires for
    //    `#date=2026-07-14` and loads the stale date once more.
    //
    // The selector and the hash both settle on the stale date, not on the one
    // the link named. Upstream's `old/crashes.html:993-1005` has the same order and
    // the same `updateUrlHash` in its toggle, so this is reproduced rather than
    // introduced — asserted here so that fixing it is a deliberate change.
    assert.deepEqual(harness.requested, [
        'xpcshell-2026-07-14.json',
        'xpcshell-2026-08-03.json',
        'xpcshell-2026-07-14.json',
    ]);
    assert.equal(select.value, '2026-07-14', 'the stale date wins');
    assert.equal(
        harness.window.location.hash,
        '#date=2026-07-14',
        'and the URL is rewritten to it, so the shared link no longer names the date it asked for'
    );
});

test('a hash with no date goes back to the 21-day view', async () => {
    harness.window.location.hash = '#';
    harness.window.dispatchEvent(new harness.window.Event('hashchange'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(
        dataRows().map((row) => row.querySelector('.crash-signature')!.textContent),
        EXPECTED_ROWS.map((row) => row.key),
        'an absent date means 21 days — the default the page has despite isHistoricalMode = false'
    );
});

test('the crashes page does NOT clear a stale search box on hashchange', async () => {
    // Divergence 5 on the *failures* page is a fix; the crashes page keeps the
    // bug deliberately, and the two lists say so from both sides. Asserting it
    // here is what makes the asymmetry a tested decision rather than a
    // difference nobody noticed. `site/crashes.ts:744`.
    searchBox().value = 'ctypes';
    searchBox().dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(searchBox().value, 'ctypes');

    harness.window.location.hash = '#date=21days';
    harness.window.dispatchEvent(new harness.window.Event('hashchange'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(
        searchBox().value,
        'ctypes',
        'the crashes page leaves a term the URL no longer names'
    );

    searchBox().value = '';
    searchBox().dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
});

test('the harness switcher renamed the heading for this page', () => {
    // `initHarnessSwitcher('Crashes by Signature')` (`site/crashes.ts:765`) —
    // the one string that names which page this is outside the vocabulary.
    const heading = harness.document.querySelector('h1')!;
    // `initHarnessSwitcher` replaces the heading with a `<select>` followed by
    // a text node, so `textContent` folds in both option labels. The suffix is
    // the trailing text node, which is the part this page chose.
    assert.equal(heading.lastChild!.textContent, ' Crashes by Signature');
    assert.equal(heading.textContent!.includes('Failures by Message'), false);
    assert.equal(harness.document.title, 'XPCShell Crashes by Signature');
    assert.deepEqual(
        [...heading.querySelectorAll('option')].map((option) => option.value),
        ['xpcshell', 'mochitest']
    );
    assert.equal(
        (heading.querySelector('select') as HTMLSelectElement).value,
        'xpcshell',
        'the URL carries no ?kind=, so xpcshell is selected'
    );
});
