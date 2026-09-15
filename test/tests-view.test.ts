/**
 * `site/tests-view.ts` — the page's decisions, with no DOM.
 *
 * The range arithmetic is tested against hand-written inputs, because the
 * properties are structural (an inverted range, a range past the end of the
 * file) and a fixture supplies those only by luck. The *worklist* is tested
 * against the real 21-day fixture, driven end to end through `findIssues` —
 * this project's tests have four times deriving an expected value from the
 * thing under test, and it shipped a wrong digit once and pinned a bug as
 * correct twice. So the numbers below were read off the decoded fixture and are
 * written out as literals.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decodeIssues, type IssuesFile } from '../lib/formats/issues.ts';
import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import type { FlakyDay } from '../lib/query/flakiness.ts';
import type { IssueRow } from '../lib/query/issues.ts';
import {
    type LoadedHarness,
    ALL_FILTERS,
    decodeFilters,
    encodeFilters,
    harnessesWithTests,
    issueTimeline,
    mergedWindow,
    testContribution,
    INITIAL_SORT,
    axisLabels,
    breadcrumb,
    folderPageUrl,
    isHistoricalDate,
    isWholeWindow,
    issueLines,
    nextSort,
    parseRange,
    pathPrefixOf,
    percentageDisplay,
    rangeLabel,
    rangeLength,
    rangeOf,
    MAX_BACKFILL_DAYS,
    WINDOW_DAYS,
    backfillPushdates,
    datesOfRange,
    parseBackfillDays,
    rangeOfDates,
    readUrlState,
    scopeLine,
    sortTests,
    testPageUrl,
    timeline,
    typesOf,
    urlStateOf,
    windowDates,
    worklist,
} from '../site/tests-view.ts';

/** The 21-day xpcshell aggregate the page opens on. */
function fixtureFile(): DecodedTimingFile {
    const raw = JSON.parse(
        readFileSync(new URL('./fixtures/xpcshell-issues.json', import.meta.url), 'utf8')
    ) as IssuesFile;
    return decodeIssues(raw);
}

/**
 * The fixture as the one loaded harness, which is the shape the page holds.
 *
 * Built once: `decodeIssues` indexes 10 tests lazily and nothing here mutates
 * the file, so sharing it across tests costs nothing and keeps each test's body
 * about the assertion rather than about the setup.
 */
const loadedFixture: LoadedHarness[] = (() => {
    const file = fixtureFile();
    return [{ harness: 'xpcshell', file, dates: windowDates(file) }];
})();

/**
 * Both harnesses, which is what a folder holding two manifests looks like.
 *
 * `toolkit/components/extensions/test` is a real such directory —
 * `.../test/xpcshell` and `.../test/mochitest` — and both fixtures are
 * generated to contain it over the same 21 days. See `tools/make-fixtures.ts`
 * for why the mochitest fixture's window is rewritten.
 */
const bothHarnesses: LoadedHarness[] = (() => {
    const xpcshell = fixtureFile();
    const raw = JSON.parse(
        readFileSync(new URL('./fixtures/mochitest-issues.json', import.meta.url), 'utf8')
    ) as IssuesFile;
    const mochitest = decodeIssues(raw);
    return [
        { harness: 'xpcshell', file: xpcshell, dates: windowDates(xpcshell) },
        { harness: 'mochitest', file: mochitest, dates: windowDates(mochitest) },
    ];
})();

/** The directory both fixtures hold tests in. */
const SHARED = 'toolkit/components/extensions/test';

// --- the range -----------------------------------------------------------

test('a range is normalized however the two days were clicked', () => {
    assert.deepEqual(rangeOf(3, 9), { from: 3, to: 9 });
    // Dragging backwards is the same range. Without this the list would filter
    // on `from > to` and show nothing.
    assert.deepEqual(rangeOf(9, 3), { from: 3, to: 9 });
    assert.deepEqual(rangeOf(4, 4), { from: 4, to: 4 });
});

test('a range covers both its ends', () => {
    assert.equal(rangeLength({ from: 0, to: 0 }), 1);
    assert.equal(rangeLength({ from: 0, to: 20 }), 21);
    assert.equal(rangeLength({ from: 10, to: 12 }), 3);
});

test('the whole window is recognized so the hash can omit it', () => {
    assert.equal(isWholeWindow(null, 21), true);
    assert.equal(isWholeWindow({ from: 0, to: 20 }, 21), true);
    assert.equal(isWholeWindow({ from: 0, to: 19 }, 21), false);
    assert.equal(isWholeWindow({ from: 1, to: 20 }, 21), false);
});

// --- the timeline --------------------------------------------------------

/** `days` days of made-up counts, dated from 2026-08-01. */
function days(counts: { flaky: number; skipped: number; stable: number }[]): FlakyDay[] {
    return counts.map((count, day) => ({
        day,
        date: `2026-08-${String(day + 1).padStart(2, '0')}`,
        ...count,
        total: count.flaky + count.skipped + count.stable,
    }));
}

test('the timeline marks the range and keeps every day', () => {
    const series = days([
        { flaky: 5, skipped: 1, stable: 10 },
        { flaky: 4, skipped: 1, stable: 11 },
        { flaky: 0, skipped: 1, stable: 15 },
        { flaky: 0, skipped: 0, stable: 16 },
    ]);
    const view = timeline(series, [false, false, false, false], { from: 2, to: 3 });

    // Every day is still drawn — the range highlights, it does not clip. A
    // reader picks the range by looking at the shape, so a chart showing only
    // the selection cannot show them where the shape changed.
    assert.equal(view.days.length, 4);
    assert.deepEqual(
        view.days.map((day) => day.selected),
        [false, false, true, true]
    );
    assert.deepEqual(view.flaky, [5, 4, 0, 0]);
});

test('with no range every day reads as selected', () => {
    const series = days([
        { flaky: 1, skipped: 0, stable: 2 },
        { flaky: 0, skipped: 0, stable: 3 },
    ]);
    const view = timeline(series, [false, false], null);
    assert.deepEqual(
        view.days.map((day) => day.selected),
        [true, true]
    );
});

test('a thin day breaks the line rather than plotting a zero', () => {
    // 2026-07-11 ran 128 of ~4,600 xpcshell tests. Plotted as 0 it reads as a
    // fixed folder rather than as a day the tree did not run.
    const series = days([
        { flaky: 5, skipped: 0, stable: 10 },
        { flaky: 0, skipped: 0, stable: 1 },
        { flaky: 4, skipped: 0, stable: 11 },
    ]);
    const view = timeline(series, [false, true, false], null);
    assert.deepEqual(view.flaky, [5, null, 4]);
    assert.deepEqual(view.skipped, [0, null, 0]);
    assert.equal(view.days[1]!.thin, true);
});

test('axis labels carry the year only when the window spans two', () => {
    assert.deepEqual(axisLabels(['2026-08-01', '2026-08-02']), ['08-01', '08-02']);
    // `12-31` then `01-01` is ambiguous.
    assert.deepEqual(axisLabels(['2025-12-31', '2026-01-01']), ['2025-12-31', '2026-01-01']);
});

// --- the folder selector -------------------------------------------------

test('a folder prefix ends in a separator, so a sibling is not swept in', () => {
    // `dom/base` without the separator also selects `dom/baseline`, which is a
    // different folder and a wrong answer nobody would notice in a list of 40.
    assert.equal(pathPrefixOf('dom/base'), 'dom/base/');
    assert.equal(pathPrefixOf('dom/base/'), 'dom/base/');
    // The whole tree gets no prefix; `startsWith('/')` would select nothing.
    assert.equal(pathPrefixOf(''), undefined);
});

test('the breadcrumb is every ancestor, root first', () => {
    assert.deepEqual(breadcrumb('dom/base/test'), [
        { name: 'dom', path: 'dom' },
        { name: 'base', path: 'dom/base' },
        { name: 'test', path: 'dom/base/test' },
    ]);
    assert.deepEqual(breadcrumb(''), []);
});

// --- the worklist, over the real fixture ---------------------------------

test('the worklist is the folder, ranked worst first', () => {
    const list = worklist(loadedFixture, 'netwerk/test/unit', ALL_FILTERS, null, INITIAL_SORT);

    // Both of the fixture's two tests in this folder have an issue.
    assert.deepEqual(
        list.tests.map((row) => row.fullPath),
        [
            'netwerk/test/unit/test_trr_https_fallback.js',
            'netwerk/test/unit/test_socks.js',
        ]
    );
    assert.equal(list.totalTestCount, 2);
    assert.equal(list.testsWithIssues, 2);
    // Read off the decoded fixture, not derived from the function under test.
    assert.equal(list.tests[0]!.failCount, 8);
    assert.equal(list.tests[0]!.skipCount, 7074);
    assert.equal(list.tests[1]!.timeoutCount, 1);
});

test('a range narrows the counts, and drops a test that is fixed in it', () => {
    const early = worklist(
        loadedFixture,
        'netwerk/test/unit',
        ALL_FILTERS,
        { from: 0, to: 9 },
        INITIAL_SORT
    );
    const late = worklist(
        loadedFixture,
        'netwerk/test/unit',
        ALL_FILTERS,
        { from: 10, to: 20 },
        INITIAL_SORT
    );

    // This is the burndown case the page exists for: `test_socks.js` times out
    // once in the first half of the window and never again, so it is on the
    // worklist early and gone late — while still being counted in the
    // denominator, which is what `keepClean` buys.
    assert.equal(
        early.tests.some((row) => row.fullPath.endsWith('test_socks.js')),
        true
    );
    assert.equal(
        late.tests.some((row) => row.fullPath.endsWith('test_socks.js')),
        false
    );
    assert.equal(late.totalTestCount, 2, 'the clean test still counts in the denominator');
    assert.equal(late.testsWithIssues, 1);

    // The two halves partition the whole window's counts, which is what says
    // the range reached the counters rather than only the row filter.
    assert.equal(early.tests[0]!.failCount, 5);
    assert.equal(late.tests[0]!.failCount, 3);
    assert.equal(early.tests[0]!.failCount + late.tests[0]!.failCount, 8);
    assert.equal(early.tests[0]!.skipCount + late.tests[0]!.skipCount, 7074);
});

test('clean tests are in the denominator, so the rate is over the whole folder', () => {
    // `toolkit/…/xpcshell` has 7 tests in the fixture; only the ones with an
    // issue are listed, but all 7 are counted.
    const list = worklist(
        loadedFixture,
        'toolkit/components/extensions/test/xpcshell',
        ALL_FILTERS,
        null,
        INITIAL_SORT
    );
    assert.equal(list.totalTestCount, 7);
    assert.ok(
        list.tests.length <= list.totalTestCount,
        'only tests with an issue are listed'
    );
    for (const row of list.tests) {
        assert.ok(row.issueCount > 0, `${row.fullPath} is listed, so it has an issue`);
    }
});

test('a folder prefix does not leak into a sibling folder', () => {
    const list = worklist(loadedFixture, 'netwerk/test', ALL_FILTERS, null, INITIAL_SORT);
    for (const row of list.tests) {
        assert.ok(
            row.fullPath.startsWith('netwerk/test/'),
            `${row.fullPath} is under the folder asked for`
        );
    }
});

test('unchecking a type moves the numbers, not just the rows', () => {
    const all = worklist(loadedFixture, 'netwerk/test/unit', ALL_FILTERS, null, INITIAL_SORT);
    const noSkips = worklist(
        loadedFixture,
        'netwerk/test/unit',
        { ...ALL_FILTERS, skips: false },
        null,
        INITIAL_SORT
    );

    // The skips were 7,074 of the folder's 7,083 issues, so dropping them is
    // not a cosmetic filter: the count and the rate both move.
    assert.equal(all.issueCount, 7083);
    assert.equal(noSkips.issueCount, 9);
    assert.notEqual(all.issueRate, noSkips.issueRate);
});

test('the search narrows the list without hiding the denominator', () => {
    const list = worklist(
        loadedFixture,
        'netwerk/test/unit',
        ALL_FILTERS,
        null,
        INITIAL_SORT,
        'socks'
    );
    assert.deepEqual(
        list.tests.map((row) => row.fullPath),
        ['netwerk/test/unit/test_socks.js']
    );
    assert.equal(list.totalTestCount, 2, 'the folder still has two tests');
});

test('a folder with no tests reports none rather than throwing', () => {
    const list = worklist(loadedFixture, 'does/not/exist', ALL_FILTERS, null, INITIAL_SORT);
    assert.equal(list.totalTestCount, 0);
    assert.deepEqual(list.tests, []);
    assert.equal(list.issueRate, 0);
});

// --- the issue lines -----------------------------------------------------

test("a test's issue lines respect the range", () => {
    const file = fixtureFile();
    const socks = file.findTest('netwerk/test/unit/test_socks.js');
    assert.notEqual(socks, null);

    const whole = issueLines(file, socks!.testId, ALL_FILTERS, null);
    const early = issueLines(file, socks!.testId, ALL_FILTERS, { from: 0, to: 9 });
    const late = issueLines(file, socks!.testId, ALL_FILTERS, { from: 10, to: 20 });

    assert.deepEqual(
        whole.map((line) => [line.type, line.count]),
        [['TIMEOUT', 1]]
    );
    assert.deepEqual(
        early.map((line) => [line.type, line.count]),
        [['TIMEOUT', 1]]
    );
    // The line is gone in the half of the window where the timeout did not
    // happen — the same fact the worklist reports, reached a second way.
    assert.deepEqual(late, []);
});

test('an unchecked type removes its lines', () => {
    const file = fixtureFile();
    const socks = file.findTest('netwerk/test/unit/test_socks.js');
    const lines = issueLines(
        file,
        socks!.testId,
        { ...ALL_FILTERS, timeouts: false },
        null
    );
    assert.deepEqual(lines, []);
});

// --- sorting -------------------------------------------------------------

test('the sort starts on most issues first', () => {
    assert.deepEqual(INITIAL_SORT, { field: 'issueCount', direction: 'desc' });
});

test('a column flips, a new column picks its own default direction', () => {
    assert.deepEqual(nextSort({ field: 'issueCount', direction: 'desc' }, 'issueCount'), {
        field: 'issueCount',
        direction: 'asc',
    });
    assert.deepEqual(nextSort({ field: 'issueCount', direction: 'desc' }, 'failCount'), {
        field: 'failCount',
        direction: 'desc',
    });
    // Ascending on a rate surfaces the nearly-clean tests, which is a real and
    // different question from "who is worst".
    assert.deepEqual(nextSort({ field: 'issueCount', direction: 'desc' }, 'issuePercentage'), {
        field: 'issuePercentage',
        direction: 'asc',
    });
    assert.deepEqual(nextSort({ field: 'issueCount', direction: 'desc' }, 'name'), {
        field: 'name',
        direction: 'asc',
    });
});

/** A row with every counter zeroed but the ones a test cares about. */
function row(fullPath: string, fields: Partial<IssueRow> = {}): IssueRow {
    return {
        testId: 0,
        fullPath,
        directory: fullPath.slice(0, fullPath.lastIndexOf('/')),
        component: null,
        runCount: 0,
        passCount: 0,
        failCount: 0,
        timeoutCount: 0,
        crashCount: 0,
        expectedFailCount: 0,
        skipCount: 0,
        failRate: 0,
        issueCount: 0,
        issueRate: 0,
        ...fields,
    };
}

test('ties break on path, so the order is total', () => {
    const rows = [
        row('b/t.js', { issueCount: 3 }),
        row('a/t.js', { issueCount: 3 }),
        row('c/t.js', { issueCount: 9 }),
    ];
    assert.deepEqual(
        sortTests(rows, { field: 'issueCount', direction: 'desc' }).map((r) => r.fullPath),
        ['c/t.js', 'a/t.js', 'b/t.js']
    );
    // Re-sorting the same data cannot reorder the tied rows.
    assert.deepEqual(
        sortTests(rows, { field: 'issueCount', direction: 'desc' }).map((r) => r.fullPath),
        ['c/t.js', 'a/t.js', 'b/t.js']
    );
});

// --- presentation --------------------------------------------------------

test('a non-zero rate never rounds down to a clean 0%', () => {
    // Three skips in a million runs is not a clean folder, and `0%` says it is.
    assert.deepEqual(percentageDisplay(0), { displayValue: '0%', cssClass: 'zero' });
    assert.deepEqual(percentageDisplay(0.0003), { displayValue: '<1%', cssClass: '' });
    assert.deepEqual(percentageDisplay(8.7), { displayValue: '9%', cssClass: 'yellow' });
    assert.deepEqual(percentageDisplay(14.4), { displayValue: '14%', cssClass: 'orange' });
    assert.deepEqual(percentageDisplay(55), { displayValue: '55%', cssClass: 'fail' });
});

test('the window is stated in words, and a single day names itself', () => {
    const dates = ['2026-08-01', '2026-08-02', '2026-08-03'];
    assert.equal(rangeLabel(null, dates), 'all 3 days');
    assert.equal(rangeLabel({ from: 1, to: 1 }, dates), '2026-08-02');
    assert.equal(rangeLabel({ from: 0, to: 2 }, dates), '2026-08-01 → 2026-08-03 (3 days)');
    assert.equal(rangeLabel(null, []), 'no data');
});

test('the scope line says how many of how many, and over which days', () => {
    const file = fixtureFile();
    const list = worklist(loadedFixture, 'netwerk/test/unit', ALL_FILTERS, null, INITIAL_SORT);
    const dates = windowDates(file);
    assert.equal(scopeLine(list, null, dates), '2 tests with issues out of 2 · all 21 days');

    const late = worklist(
        loadedFixture,
        'netwerk/test/unit',
        ALL_FILTERS,
        { from: 10, to: 20 },
        INITIAL_SORT
    );
    assert.equal(
        scopeLine(late, { from: 10, to: 20 }, dates),
        '1 test with issues out of 2 · 2026-07-24 → 2026-08-03 (11 days)'
    );
});

test('the window dates are the file’s, oldest first', () => {
    const file = fixtureFile();
    const dates = windowDates(file);
    assert.equal(dates.length, 21);
    // Day 0 is the oldest and the last is the file's end date.
    assert.equal(dates.at(-1), '2026-08-03');
    assert.equal(dates[0], '2026-07-14');
});

test('the path is a query parameter, like test.html’s test', () => {
    assert.equal(
        testPageUrl('dom/base/test/test_foo.html'),
        'test.html?test=dom%2Fbase%2Ftest%2Ftest_foo.html'
    );
    // `?path=`, not `#path=`: it is what the page *is*, and a `#` cannot be a
    // form target. Named `path` and not `folder` because these are prefixes,
    // not only leaf directories.
    assert.equal(folderPageUrl('dom/base/test'), 'tests.html?path=dom%2Fbase%2Ftest');
    // The window is a view setting, so it stays in the hash.
    assert.equal(
        folderPageUrl('dom/base/test', { date: '21days' }),
        'tests.html?path=dom%2Fbase%2Ftest#date=21days'
    );
    assert.equal(folderPageUrl('dom/base', { date: '' }), 'tests.html?path=dom%2Fbase');
});

test('an absent date means the 21-day window', () => {
    assert.equal(isHistoricalDate(undefined), true);
    assert.equal(isHistoricalDate(''), true);
    assert.equal(isHistoricalDate('21days'), true);
    assert.equal(isHistoricalDate('2026-08-03'), false);
});

test('the URL is read from both halves, with empty values absent', () => {
    const state = readUrlState(
        new URLSearchParams('date=21days&q=foo&from=3&to=9&open=x.js'),
        new URLSearchParams('path=dom/base&kind=both')
    );
    assert.deepEqual(state, {
        folder: 'dom/base',
        kind: 'both',
        date: '21days',
        q: 'foo',
        from: '3',
        to: '9',
        open: 'x.js',
        issues: undefined,
        days: undefined,
    });
    assert.deepEqual(
        readUrlState(new URLSearchParams('q='), new URLSearchParams('path=')),
        {
            folder: undefined,
            kind: undefined,
            date: undefined,
            q: undefined,
            from: undefined,
            to: undefined,
            open: undefined,
            issues: undefined,
            days: undefined,
        }
    );
});

test('a stray #path= does not override ?path=', () => {
    // Two URLs that look different must not mean the same thing, and an old
    // hash-shaped link should lose to the real parameter rather than win.
    const state = readUrlState(
        new URLSearchParams('path=old/path'),
        new URLSearchParams('path=new/path')
    );
    assert.equal(state.folder, 'new/path');
});

/** A 21-day span, as the published window is, for the URL tests. */
const DATES_21 = Array.from({ length: 21 }, (_, day) =>
    new Date(Date.parse('2026-08-25T00:00:00Z') + day * 86_400_000).toISOString().slice(0, 10)
);

test('half a range is not a range', () => {
    // `#from=2026-09-01` alone would otherwise silently mean "that date to the
    // end", a window the reader never selected.
    assert.equal(parseRange({ from: '2026-09-01' }), null);
    assert.equal(parseRange({ to: '2026-09-09' }), null);
    assert.equal(parseRange({}), null);
    assert.equal(parseRange({ from: 'x', to: '2026-09-09' }), null);
    // Either order means the same range.
    assert.deepEqual(parseRange({ from: '2026-09-09', to: '2026-09-01' }), {
        from: '2026-09-01',
        to: '2026-09-09',
    });
});

test('a range is carried as dates, so nothing can move it', () => {
    // The bug this replaces: indices are meaningless without the span they
    // were measured in, and this page has two ways for that span to change
    // under a saved index — backfill prepends days, and the published window
    // slides forward daily. Both moved the reader's selection.
    const dates = [
        '2026-09-01',
        '2026-09-02',
        '2026-09-03',
        '2026-09-04',
        '2026-09-05',
    ];
    assert.deepEqual(datesOfRange({ from: 1, to: 3 }, dates), {
        from: '2026-09-02',
        to: '2026-09-04',
    });
    // And back, unchanged.
    assert.deepEqual(rangeOfDates({ from: '2026-09-02', to: '2026-09-04' }, dates), {
        from: 1,
        to: 3,
    });

    // The same dates in a span with 20 older days prepended resolve 20 later —
    // which is the whole point: the *dates* did not move, so the selection
    // does not either.
    const longer = [
        ...Array.from({ length: 20 }, (_, i) =>
            new Date(Date.parse('2026-08-12T00:00:00Z') + i * 86_400_000)
                .toISOString()
                .slice(0, 10)
        ),
        ...dates,
    ];
    assert.equal(longer.length, 25);
    assert.deepEqual(rangeOfDates({ from: '2026-09-02', to: '2026-09-04' }, longer), {
        from: 21,
        to: 23,
    });
    assert.deepEqual(datesOfRange({ from: 21, to: 23 }, longer), {
        from: '2026-09-02',
        to: '2026-09-04',
    });
});

test('a range from an older window clamps to the overlap', () => {
    // A shared link outlives the window it was written against — the published
    // span slides forward daily — so a date that has fallen off the start
    // clamps rather than collapsing the selection to nothing.
    const dates = ['2026-09-03', '2026-09-04', '2026-09-05'];
    assert.deepEqual(rangeOfDates({ from: '2026-08-20', to: '2026-09-04' }, dates), {
        from: 0,
        to: 1,
    });
    assert.deepEqual(rangeOfDates({ from: '2026-09-04', to: '2026-12-01' }, dates), {
        from: 1,
        to: 2,
    });
    // A weekend the tree did not run is an ordinary thing to have dragged
    // across, so the bounds are found by comparison rather than by lookup.
    assert.deepEqual(rangeOfDates({ from: '2026-09-03', to: '2026-09-04' }, ['2026-09-03', '2026-09-05']), {
        from: 0,
        to: 0,
    });
    // Missing the span entirely has no honest answer, and the whole window is
    // a better one than a wrong range.
    assert.equal(rangeOfDates({ from: '2026-01-01', to: '2026-01-05' }, dates), null);
    assert.equal(rangeOfDates({ from: '2027-01-01', to: '2027-01-05' }, dates), null);
    assert.equal(rangeOfDates(null, dates), null);
    assert.equal(rangeOfDates({ from: '2026-09-03', to: '2026-09-04' }, []), null);
});

test('the default state serializes to nothing, so a shared URL stays clean', () => {
    // `initUrlHashManager` drops falsy values, so a default has to become `''`
    // rather than its value — otherwise a reader who changed nothing gets a URL
    // pinning today's window, which means something else next month.
    assert.deepEqual(
        urlStateOf({
            search: '',
            range: null,
            days: 21,
            open: null,
            filters: ALL_FILTERS,
        }),
        { q: '', from: '', to: '', open: '', issues: '', days: '' }
    );
    // A range covering every day is the whole window, so it is omitted too.
    assert.deepEqual(
        urlStateOf({
            search: '',
            range: { from: 0, to: 20 },
            days: 21,
            open: null,
            filters: ALL_FILTERS,
            dates: DATES_21,
        }).from,
        ''
    );
    // A real selection is written out, as dates.
    assert.deepEqual(
        urlStateOf({
            search: ' foo ',
            range: { from: 10, to: 20 },
            days: 21,
            open: 'x.js',
            filters: ALL_FILTERS,
            dates: DATES_21,
        }),
        {
            q: 'foo',
            from: DATES_21[10]!,
            to: DATES_21[20]!,
            open: 'x.js',
            issues: '',
            days: '',
        }
    );
    // With no dates to name it against, a range is omitted rather than
    // written as an index — an index in a URL is what this replaced.
    assert.equal(
        urlStateOf({
            search: '',
            range: { from: 10, to: 20 },
            days: 21,
            open: null,
            filters: ALL_FILTERS,
        }).from,
        ''
    );
});

test('a backfilled span is written to the URL, a default one is not', () => {
    // `#days=` is what makes a shared link show the same history the sender
    // was looking at. Without it, `from`/`to` — absolute day indices — would
    // land on entirely different dates for the recipient.
    const base = { search: '', range: null, open: null, filters: ALL_FILTERS } as const;

    // One published window is the default, so it says nothing.
    assert.equal(urlStateOf({ ...base, days: 21, windowDays: 21 }).days, '');
    // Fewer than a window — a short file — is not a backfill either.
    assert.equal(urlStateOf({ ...base, days: 5, windowDays: 21 }).days, '');
    // A stitched timeline is written out.
    assert.equal(urlStateOf({ ...base, days: 41, windowDays: 21 }).days, '41');
    assert.equal(urlStateOf({ ...base, days: 221, windowDays: 21 }).days, '221');
    // With no window length to compare against, nothing is claimed.
    assert.equal(urlStateOf({ ...base, days: 41 }).days, '');
});

test('a range written against a backfilled window round-trips with its span', () => {
    // The pair is the point: the indices only mean anything alongside the day
    // count they were picked in.
    const dates = Array.from({ length: 221 }, (_, day) =>
        new Date(Date.parse('2026-02-06T00:00:00Z') + day * 86_400_000)
            .toISOString()
            .slice(0, 10)
    );
    const state = urlStateOf({
        search: '',
        range: { from: 100, to: 140 },
        days: 221,
        open: null,
        filters: ALL_FILTERS,
        windowDays: 21,
        dates,
    });
    assert.deepEqual(
        { from: state.from, to: state.to, days: state.days },
        { from: dates[100]!, to: dates[140]!, days: '221' }
    );
    const read = readUrlState(
        new URLSearchParams(`from=${state.from}&to=${state.to}&days=${state.days}`)
    );
    // The dates resolve back to the same days, given the same span.
    assert.deepEqual(rangeOfDates(parseRange(read), dates), { from: 100, to: 140 });
    assert.equal(parseBackfillDays(read), 221);

    // And `#days=` is still what makes that span reachable: those dates are
    // months older than the published window, so without the backfill the
    // link resolves to no range at all rather than to the wrong days. That is
    // the honest answer — and it is why `days` travels with `from`/`to`.
    assert.equal(rangeOfDates(parseRange(read), dates.slice(-21)), null);
    // A range that *does* overlap the published window clamps to the overlap.
    assert.deepEqual(
        rangeOfDates({ from: dates[210]!, to: dates[240] ?? '2027-01-01' }, dates.slice(-21)),
        { from: 10, to: 20 }
    );
});

test('#days= is bounded, so a hand-edited URL cannot fetch forever', () => {
    // The value drives a loop that fetches an aggregate per 20 days, so an
    // unbounded one would download until the archive ran out.
    assert.equal(parseBackfillDays({ days: '41' }), 41);
    assert.equal(parseBackfillDays({ days: '99999' }), MAX_BACKFILL_DAYS);
    // Absent, empty and nonsense all mean "the default window".
    assert.equal(parseBackfillDays({}), null);
    assert.equal(parseBackfillDays({ days: '' }), null);
    assert.equal(parseBackfillDays({ days: 'lots' }), null);
    assert.equal(parseBackfillDays({ days: '0' }), null);
    assert.equal(parseBackfillDays({ days: '-40' }), null);
});

test('the pushdates for a span are arithmetic, so they can be fetched at once', () => {
    // The point of computing these up front: a shared `#days=` link knows its
    // whole span, so every window can be fetched in parallel. Deriving each
    // pushdate from the previous *fetch* is what made such a link visibly
    // settle through 21 → 41 → 61 days.
    //
    // Consecutive runs overlap by one day, so the step is 20, not 21.
    assert.deepEqual(backfillPushdates('2026-08-25', 21, 41), ['2026-08-25']);
    assert.deepEqual(backfillPushdates('2026-08-25', 21, 61), [
        '2026-08-25',
        '2026-08-05',
    ]);
    assert.deepEqual(backfillPushdates('2026-08-25', 21, 101), [
        '2026-08-25',
        '2026-08-05',
        '2026-07-16',
        '2026-06-26',
    ]);
    // The first pushdate is the span's own oldest date, not the day before it:
    // that puts the seam on a date the loaded window already holds, so the
    // unreliable `endDate` day of the older run is never the joint. See
    // `lib/formats/stitch.ts`.
    assert.equal(backfillPushdates('2026-08-25', 21, 41)[0], '2026-08-25');

    // A span already covered needs nothing.
    assert.deepEqual(backfillPushdates('2026-08-25', 21, 21), []);
    assert.deepEqual(backfillPushdates('2026-08-25', 41, 21), []);

    // One day past a window boundary still costs a whole window, because that
    // is the unit that gets published.
    assert.equal(backfillPushdates('2026-08-25', 21, 42).length, 2);
    assert.equal(backfillPushdates('2026-08-25', 21, 41).length, 1);
});

test('a pushdate walk lands exactly on the span it was asked for', () => {
    // The arithmetic and the day count have to agree: each run adds
    // `WINDOW_DAYS - 1` days, so n runs from a 21-day window span
    // `21 + 20n`. Asserted rather than reasoned about, because an off-by-one
    // here means either a gap in the chart or a wasted multi-megabyte fetch.
    for (const [wanted, runs] of [
        [41, 1],
        [61, 2],
        [101, 4],
        [221, 10],
    ] as const) {
        const pushdates = backfillPushdates('2026-09-14', 21, wanted);
        assert.equal(pushdates.length, runs, `${wanted} days needs ${runs} runs`);
        assert.equal(
            21 + runs * (WINDOW_DAYS - 1),
            wanted,
            `${runs} runs span exactly ${wanted} days`
        );
    }
});

test('the filter vocabulary maps to the library’s', () => {
    assert.deepEqual(typesOf(ALL_FILTERS), ['fail', 'timeout', 'crash', 'skip']);
    assert.deepEqual(typesOf({ ...ALL_FILTERS, skips: false }), ['fail', 'timeout', 'crash']);
    assert.deepEqual(typesOf({ failures: false, timeouts: false, crashes: false, skips: false }), []);
});

// --- merging the two harnesses -------------------------------------------

test('the fixtures really do share a folder over one window', () => {
    // If this fails, every merge assertion below is vacuous — which is the
    // failure mode `tools/make-fixtures.ts` rewrites the window to prevent.
    const [xpcshell, mochitest] = bothHarnesses;
    assert.deepEqual(xpcshell!.dates, mochitest!.dates, 'aligned day numbering');
    for (const entry of bothHarnesses) {
        const rows = worklist(
            [entry],
            SHARED,
            ALL_FILTERS,
            null,
            INITIAL_SORT
        );
        assert.ok(rows.totalTestCount > 0, `${entry.harness} has tests under ${SHARED}`);
    }
});

test('a merged worklist holds both harnesses’ tests, each tagged', () => {
    const merged = worklist(bothHarnesses, SHARED, ALL_FILTERS, null, INITIAL_SORT);
    const alone = bothHarnesses.map((entry) =>
        worklist([entry], SHARED, ALL_FILTERS, null, INITIAL_SORT)
    );

    // A test belongs to exactly one harness's file, so the row sets are
    // disjoint and the totals add — there is no test to deduplicate.
    assert.equal(
        merged.totalTestCount,
        alone[0]!.totalTestCount + alone[1]!.totalTestCount
    );
    assert.equal(
        merged.testsWithIssues,
        alone[0]!.testsWithIssues + alone[1]!.testsWithIssues
    );
    assert.equal(merged.issueCount, alone[0]!.issueCount + alone[1]!.issueCount);
    assert.equal(merged.runCount, alone[0]!.runCount + alone[1]!.runCount);

    // Every row says which harness ran it, which is what lets two same-named
    // files in one directory be told apart.
    assert.deepEqual(merged.harnesses, ['xpcshell', 'mochitest']);
    for (const row of merged.tests) {
        const expected = row.fullPath.includes('/xpcshell/') ? 'xpcshell' : 'mochitest';
        assert.equal(row.harness, expected, row.fullPath);
    }
});

test('the merged list is ranked across harnesses, not grouped by them', () => {
    const merged = worklist(bothHarnesses, SHARED, ALL_FILTERS, null, INITIAL_SORT);
    const counts = merged.tests.map((row) => row.issueCount);
    assert.deepEqual(
        [...counts].sort((a, b) => b - a),
        counts,
        'worst first, whichever harness it came from'
    );
    // And the two harnesses really do interleave in this data, so the
    // assertion above is not passing by accident on a sorted-by-harness list.
    const harnesses = merged.tests.map((row) => row.harness);
    assert.ok(
        new Set(harnesses).size === 2 && harnesses[0] !== harnesses.at(-1),
        `both harnesses appear: ${harnesses.join(',')}`
    );
});

test('a single-harness folder reports one harness, so no badge is shown', () => {
    // `netwerk/test/unit` is xpcshell-only in these fixtures.
    const list = worklist(bothHarnesses, 'netwerk/test/unit', ALL_FILTERS, null, INITIAL_SORT);
    assert.deepEqual(list.harnesses, ['xpcshell']);
    assert.ok(!scopeLine(list, null, loadedFixture[0]!.dates).includes('Mochitest'));
});

test('which harnesses hold a folder is read from the data, not the path', () => {
    assert.deepEqual(harnessesWithTests(bothHarnesses, SHARED), ['xpcshell', 'mochitest']);
    assert.deepEqual(harnessesWithTests(bothHarnesses, 'netwerk/test/unit'), ['xpcshell']);
    assert.deepEqual(harnessesWithTests(bothHarnesses, 'does/not/exist'), []);
});

test('the merged window is the shortest, and says whether they agreed', () => {
    assert.deepEqual(mergedWindow(bothHarnesses).dates, bothHarnesses[0]!.dates);
    assert.equal(mergedWindow(bothHarnesses).aligned, true);
    // A divergent end date is reported rather than plotted: aligning day 0 of
    // one window with day 1 of the other would date every failure wrongly.
    const skewed: LoadedHarness[] = [
        { ...bothHarnesses[0]!, dates: ['2026-08-01', '2026-08-02', '2026-08-03'] },
        { ...bothHarnesses[1]!, dates: ['2026-08-01', '2026-08-02'] },
    ];
    assert.equal(mergedWindow(skewed).aligned, false);
    assert.deepEqual(mergedWindow(skewed).dates, ['2026-08-01', '2026-08-02']);
    assert.deepEqual(mergedWindow([]).dates, []);
});

// --- the issue-count timeline --------------------------------------------

test('the issue chart counts occurrences, summed across harnesses', () => {
    const dates = bothHarnesses[0]!.dates;
    const merged = issueTimeline(bothHarnesses, SHARED, null, dates);
    assert.equal(merged.days.length, 21);
    assert.equal(merged.labels.length, 21);

    // The per-harness series add up to the merged one, day by day.
    const alone = bothHarnesses.map((entry) => issueTimeline([entry], SHARED, null, dates));
    for (let day = 0; day < dates.length; day++) {
        for (const field of ['failures', 'timeouts', 'crashes', 'skips'] as const) {
            assert.equal(
                merged.days[day]![field],
                alone[0]!.days[day]![field] + alone[1]!.days[day]![field],
                `${field} on day ${day}`
            );
        }
    }

    // And the totals match the worklist's, which is the cross-check that the
    // chart and the list are counting the same thing.
    const list = worklist(bothHarnesses, SHARED, ALL_FILTERS, null, INITIAL_SORT);
    const summed = merged.days.reduce(
        (total, day) => total + day.failures + day.timeouts + day.crashes + day.skips,
        0
    );
    assert.equal(summed, list.issueCount);
});

test('the issue chart marks the range without clipping the series', () => {
    const dates = bothHarnesses[0]!.dates;
    const series = issueTimeline(bothHarnesses, SHARED, { from: 10, to: 20 }, dates);
    assert.equal(series.days.length, 21, 'every day is still drawn');
    assert.deepEqual(
        series.days.map((day) => day.selected),
        dates.map((_, day) => day >= 10)
    );
});

test('a run-if skip is not counted as an issue', () => {
    // The annotation says the test is scoped to another platform, so it not
    // running here is the annotation working. `findIssues` applies the same
    // rule, so the chart and the list agree.
    const dates = bothHarnesses[0]!.dates;
    const series = issueTimeline(bothHarnesses, SHARED, null, dates);
    const list = worklist(bothHarnesses, SHARED, ALL_FILTERS, null, INITIAL_SORT);
    const skips = series.days.reduce((total, day) => total + day.skips, 0);
    assert.equal(skips, list.skipCount);
});

// --- the hover overlay ---------------------------------------------------

test('a hovered test’s contribution is its own counts, never more', () => {
    const dates = bothHarnesses[0]!.dates;
    const series = issueTimeline(bothHarnesses, SHARED, null, dates);
    const list = worklist(bothHarnesses, SHARED, ALL_FILTERS, null, INITIAL_SORT);
    const worst = list.tests[0]!;

    const mine = testContribution(bothHarnesses, worst.fullPath, dates.length);
    for (const field of ['failures', 'timeouts', 'crashes', 'skips'] as const) {
        assert.equal(mine[field].length, dates.length);
        for (let day = 0; day < dates.length; day++) {
            // The bright half can never exceed the bar it is drawn inside, or
            // the remainder would go negative and the stack would misreport.
            assert.ok(
                mine[field][day]! <= series.days[day]![field],
                `${field} day ${day}: ${mine[field][day]} <= ${series.days[day]![field]}`
            );
        }
    }

    // And it totals the row's own counts, so the overlay and the row agree.
    const totals = (field: 'failures' | 'timeouts' | 'crashes' | 'skips'): number =>
        mine[field].reduce((a, b) => a + b, 0);
    assert.equal(totals('failures'), worst.failCount);
    assert.equal(totals('timeouts'), worst.timeoutCount);
    assert.equal(totals('crashes'), worst.crashCount);
    assert.equal(totals('skips'), worst.skipCount);
});

test('hovering a test that is not in the folder contributes nothing', () => {
    const dates = bothHarnesses[0]!.dates;
    const mine = testContribution(bothHarnesses, 'does/not/exist.js', dates.length);
    assert.deepEqual(mine.failures, new Array<number>(dates.length).fill(0));
    assert.deepEqual(mine.skips, new Array<number>(dates.length).fill(0));
});

// --- the filters in the URL ----------------------------------------------

test('the filters encode to letters, and the default to nothing', () => {
    // Empty for all four on, because the hash managers drop falsy values — so
    // a reader who has touched nothing gets no key at all.
    assert.equal(encodeFilters(ALL_FILTERS), '');
    assert.equal(encodeFilters({ ...ALL_FILTERS, skips: false }), 'ftc');
    assert.equal(encodeFilters({ failures: true, timeouts: false, crashes: false, skips: true }), 'fs');
    // `none`, not `''`: the empty string means "default" to every hash manager
    // here, so it would silently re-check all four.
    assert.equal(
        encodeFilters({ failures: false, timeouts: false, crashes: false, skips: false }),
        'none'
    );
});

test('a filter value round-trips, and an absent one is all four on', () => {
    for (const filters of [
        ALL_FILTERS,
        { ...ALL_FILTERS, skips: false },
        { failures: false, timeouts: true, crashes: false, skips: false },
        { failures: false, timeouts: false, crashes: false, skips: false },
    ]) {
        assert.deepEqual(decodeFilters(encodeFilters(filters)), filters);
    }
    assert.deepEqual(decodeFilters(undefined), ALL_FILTERS);
    assert.deepEqual(decodeFilters(''), ALL_FILTERS);
});

test('an unknown letter is ignored rather than rejected', () => {
    // A hash outlives the code that wrote it: a fifth issue type added later
    // should leave the four that still exist working.
    assert.deepEqual(decodeFilters('fz'), {
        failures: true,
        timeouts: false,
        crashes: false,
        skips: false,
    });
});

test('the filters ride in the hash next to the range', () => {
    const state = urlStateOf({
        search: '',
        range: { from: 3, to: 9 },
        days: 21,
        open: null,
        filters: { ...ALL_FILTERS, skips: false },
        dates: DATES_21,
    });
    assert.equal(state['issues'], 'ftc');
    assert.equal(state['from'], DATES_21[3]);
    // And read back from the same place.
    assert.deepEqual(
        decodeFilters(readUrlState(new URLSearchParams('issues=ftc')).issues),
        { ...ALL_FILTERS, skips: false }
    );
});
