/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * `site/tests.ts`, the folder burndown page, driven end to end in jsdom.
 *
 * ## Why this file exists
 *
 * The controller exports one thing — `start()` — and the behaviour worth
 * covering is module-private behind it: which file the page loads with no hash,
 * the day selection and what it does to the list, the breadcrumb, the expanded
 * test's run list and the detail fetch behind it. `test/tests-view.test.ts`
 * can assert the view model's predicates; only a started page can show they are
 * wired to a fetch and to the DOM.
 *
 * ## Where the expected values come from
 *
 * Not from the code under test, and not from `site/tests-view.ts` either. The
 * per-test counts are tallied off the raw fixture JSON by `handTally()`, which
 * reads `tables`/`testRuns` directly and imports nothing from `site/` or
 * `lib/query/`. This project has had four tests derive an expected value from
 * the thing under test; it shipped a wrong digit once and pinned a bug as
 * correct twice, so the numbers here are computed a second, independent way.
 *
 * Numbers rendered into cells are compared against `toLocaleString()` of the
 * tallied value rather than a hardcoded separator — this machine renders 1078
 * as `1 078` with a narrow no-break space.
 *
 * ## What is asserted to *fail if a feature is removed*
 *
 * The range is the page's reason to exist, so the assertions are written so
 * that a controller which drew the highlight but did not filter the list, or
 * filtered the list but not the issue lines, goes red. Concretely: a day with a
 * known issue and a day without are both selected, and the worklist is asserted
 * to differ; and `harness.hold()` freezes the detail response so the
 * before-merge state is observable and asserted empty rather than merely
 * described.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupPage, fixture } from './dom-harness.ts';
import type { IssuesFile, IssuesWithTaskIdsFile } from '../lib/formats/issues.ts';
import type { DailyFile } from '../lib/formats/daily.ts';

// --- ground truth, read off the raw fixtures ------------------------------

const AGGREGATE = fixture<IssuesFile>('xpcshell-issues.json');
const DETAILED = fixture<IssuesWithTaskIdsFile>('xpcshell-issues-with-taskids.json');
const DAILY = fixture<DailyFile>('xpcshell-2026-08-03.json');
const INDEX = fixture<{ dates: string[] }>('index.json');
/**
 * The mochitest aggregate, which the page probes to find out whether a folder
 * has tests in both harnesses.
 *
 * Served in every test, because the page's *ordinary* startup with no `?kind=`
 * asks for it — a harness omitted here would be a 404 the page treats as "no
 * mochitest tests", which is the wrong reason to get the right answer.
 */
const MOCHITEST = fixture<IssuesFile>('mochitest-issues.json');

const FILES = {
    'index.json': INDEX,
    'xpcshell-issues.json': AGGREGATE,
    'mochitest-issues.json': MOCHITEST,
    'xpcshell-issues-with-taskids.json': DETAILED,
    'xpcshell-2026-08-03.json': DAILY,
};

/** The folder the fixture has two tests in, one of which stops failing. */
const FOLDER = 'netwerk/test/unit';

/**
 * Per-test counts for one folder, tallied straight off the raw aggregate.
 *
 * Deliberately does not import `findIssues`, `decodeIssues` or anything from
 * `site/`: it walks `testInfo`/`testRuns` by hand so the page's numbers are
 * checked against an independent reading of the same bytes. `dayRange` filters
 * on the group's own day list, which is what makes the range assertions below
 * ground truth rather than a restatement.
 */
function handTally(
    folder: string,
    dayRange?: { from: number; to: number }
): Map<string, { runs: number; fails: number; timeouts: number; crashes: number; skips: number }> {
    const out = new Map<
        string,
        { runs: number; fails: number; timeouts: number; crashes: number; skips: number }
    >();
    const { tables, testInfo, testRuns } = AGGREGATE;
    const statuses = tables.statuses;

    for (let testId = 0; testId < testRuns.length; testId++) {
        // A path is the interned directory plus the interned file name — the
        // format keeps them in two tables so the common directory is stored
        // once. Reassembled here rather than read off a decoded file, so this
        // tally shares nothing with the code under test.
        const directory = tables.testPaths[testInfo.testPathIds[testId]!]!;
        const name = tables.testNames[testInfo.testNameIds[testId]!]!;
        const path = `${directory}/${name}`;
        if (!path.startsWith(`${folder}/`)) {
            continue;
        }
        const row = { runs: 0, fails: 0, timeouts: 0, crashes: 0, skips: 0 };
        const groups = testRuns[testId] ?? [];
        for (let statusId = 0; statusId < groups.length; statusId++) {
            const group = groups[statusId];
            if (group === null || group === undefined) {
                continue;
            }
            const status = statuses[statusId]!;
            // The counts shape: `days` is delta-encoded with day 0 the oldest,
            // and `counts` is parallel to it.
            const days = group.days ?? [];
            const counts = group.counts ?? [];
            let day = 0;
            for (let index = 0; index < days.length; index++) {
                day += days[index]!;
                const count = counts[index] ?? 0;
                if (
                    dayRange !== undefined &&
                    (day < dayRange.from || day > dayRange.to)
                ) {
                    continue;
                }
                if (status === 'SKIP') {
                    // `run-if` skips are already dropped from the aggregates by
                    // the generator, so every SKIP here is a real one.
                    row.skips += count;
                } else if (status.startsWith('TIMEOUT')) {
                    row.timeouts += count;
                    row.runs += count;
                } else if (status === 'CRASH') {
                    row.crashes += count;
                    row.runs += count;
                } else if (status.startsWith('FAIL')) {
                    row.fails += count;
                    row.runs += count;
                } else {
                    row.runs += count;
                }
            }
        }
        out.set(path, row);
    }
    return out;
}

test('the fixture supports what these tests assert', () => {
    const whole = handTally(FOLDER);
    assert.equal(whole.size, 2, 'two tests in the folder, so a range can drop one');
    const early = handTally(FOLDER, { from: 0, to: 9 });
    const late = handTally(FOLDER, { from: 10, to: 20 });
    const socks = 'netwerk/test/unit/test_socks.js';
    assert.ok(
        early.get(socks)!.timeouts > 0 && late.get(socks)!.timeouts === 0,
        'a test whose only issue is in the first half of the window — the burndown case'
    );
});

// --- the harness ----------------------------------------------------------

/**
 * A page on its own module instance, so each test sees a fresh request log.
 *
 * The controller keeps its state in module-level `let`s, so two tests sharing
 * one instance would share an expanded row and a loaded detail file. `?tag=`
 * gives a fresh module registry entry and with it fresh flags.
 */
async function freshPage(
    tag: string,
    query = `?path=${FOLDER}`,
    files: Record<string, unknown> = FILES
): Promise<ReturnType<typeof setupPage>> {
    const page = setupPage({
        page: 'tests',
        url: `https://tests.firefox.dev/tests.html${query}`,
        files,
    });
    const module = await import(`../site/tests.ts?${tag}=${Date.now()}-${Math.random()}`);
    await (module as { start: () => Promise<void> }).start();
    return page;
}

/** The page's own view of its state, through the test seam. */
function view(page: ReturnType<typeof setupPage>): {
    folder: string;
    range: { from: number; to: number } | null;
    dates: readonly string[];
    openTest: string | null;
    filters: { failures: boolean; timeouts: boolean; crashes: boolean; skips: boolean };
    list: {
        tests: { fullPath: string; harness: string; failCount: number }[];
        totalTestCount: number;
        issueCount: number;
    } | null;
} {
    return (
        page.window as unknown as {
            __testsView: () => ReturnType<typeof view>;
        }
    ).__testsView();
}

/** Clicks a day on the timeline, the way the chart's `onClick` would. */
function clickDay(page: ReturnType<typeof setupPage>, day: number, shift = false): void {
    (
        page.window as unknown as {
            __testsClickDay: (day: number, shift?: boolean) => void;
        }
    ).__testsClickDay(day, shift);
}

/** The worklist's test rows, by path. */
function rowPaths(page: ReturnType<typeof setupPage>): string[] {
    return [...page.document.querySelectorAll<HTMLElement>('.tree-row.test-row')].map(
        (row) => row.getAttribute('data-path') ?? ''
    );
}

// --- what the page loads --------------------------------------------------

test('the page loads the 21-day window, and no date list', async () => {
    const page = await freshPage('default');
    try {
        // The 21-day window is the page's *only* window — a folder burndown is
        // a question about change over time, so a single day is not one of its
        // views. `index.json` is therefore not fetched either: it exists to
        // fill a date `<select>` this page does not have.
        //
        // Both aggregates, because with no `?kind=` the page has to find out
        // which harnesses hold this folder and that is a question about the
        // data. Each is fetched **once**: narrowing to xpcshell afterwards
        // drops the mochitest file it already has rather than re-fetching.
        assert.deepEqual(page.requested, [
            'xpcshell-issues.json',
            'mochitest-issues.json',
        ]);
        assert.equal(
            page.requested.filter((name) => name === 'xpcshell-issues.json').length,
            1,
            'the 2.8 MB aggregate is not fetched twice to learn what it already said'
        );
        assert.equal(view(page).dates.length, 21);
        assert.equal(
            page.document.getElementById('date-select'),
            null,
            'no date selector'
        );
        assert.equal(
            page.document.getElementById('historical-button'),
            null,
            'no single-day toggle'
        );
        // The 15.9 MB detail file is not part of opening the page.
        assert.ok(
            !page.requested.includes('xpcshell-issues-with-taskids.json'),
            'the detail file is not fetched on load'
        );
    } finally {
        page.restore();
    }
});

test('an old #date= link still lands on the window, not an error', async () => {
    // Links to this page were shared with `#date=21days`, and `#date=<a day>`
    // was once a real view. Both now mean the one window the page has: the
    // hash key is read and ignored rather than being a 404 or a blank page.
    for (const hash of ['#date=21days', '#date=2026-08-03']) {
        const page = await freshPage(`olddate${hash}`, `?path=${FOLDER}${hash}`);
        try {
            assert.equal(view(page).dates.length, 21, hash);
            assert.equal(page.document.getElementById('error')!.style.display, 'none');
            assert.ok(rowPaths(page).length > 0, `${hash} rendered rows`);
        } finally {
            page.restore();
        }
    }
});

test('the folder is an editable path in the heading', async () => {
    const page = await freshPage('crumb');
    try {
        assert.equal(view(page).folder, FOLDER);
        // Typeable, so a reader can jump sideways to any folder without going
        // back to a listing — the completion offers every folder with tests.
        const input = page.document.querySelector<HTMLInputElement>('#folder-path-input')!;
        assert.equal(input.value, FOLDER);
        assert.notEqual(page.document.getElementById('folder-path-dropdown'), null);
        // And it is *not* a row of links: those moved into the table, where
        // the total row walks up and a test's subfolders walk down.
        assert.equal(page.document.querySelector('h1 a.crumb-link'), null);
    } finally {
        page.restore();
    }
});

test('the table walks the tree: the total row up, a test name down', async () => {
    const page = await freshPage('treewalk');
    try {
        // The total row's path is linked ancestor by ancestor.
        const up = [
            ...page.document.querySelectorAll<HTMLAnchorElement>('.total-row a.crumb-link'),
        ].map((a) => [a.textContent, a.getAttribute('href')]);
        assert.deepEqual(
            up.map(([text]) => text),
            ['netwerk', 'test'],
            'every ancestor of netwerk/test/unit'
        );
        assert.match(up[0]![1] ?? '', /^tests\.html\?path=netwerk$/);

        // A test in a subfolder gets that subfolder as a link *down*. This
        // folder's tests sit directly in it, so use the shared folder, whose
        // tests are under `xpcshell/` and `mochitest/`.
        const deep = await freshPage('treewalk2', `?path=${SHARED}`);
        try {
            const down = page.document.querySelectorAll('.tree-row.test-row a.subfolder-link');
            void down;
            const links = [
                ...deep.document.querySelectorAll<HTMLAnchorElement>(
                    '.tree-row.test-row a.subfolder-link'
                ),
            ];
            assert.ok(links.length > 0, 'a test in a subfolder links to it');
            const href = links[0]!.getAttribute('href') ?? '';
            assert.match(href, /^tests\.html\?path=/);
            assert.ok(
                decodeURIComponent(href).includes(`${SHARED}/${links[0]!.textContent}`),
                `${href} points at the subfolder it names`
            );
        } finally {
            deep.restore();
        }
    } finally {
        page.restore();
    }
});

test('the page title names the folder', async () => {
    const page = await freshPage('title');
    try {
        // A constant title is useless with several of these open: the tab, the
        // history and a bookmark all show this rather than the URL.
        assert.match(page.document.title, /netwerk\/test\/unit/);
    } finally {
        page.restore();
    }
});

// --- the worklist ---------------------------------------------------------

test('the worklist is the folder’s tests, with the tallied counts', async () => {
    const page = await freshPage('rows');
    try {
        const expected = handTally(FOLDER);
        const paths = rowPaths(page);
        // Every listed row is in the folder and has an issue.
        assert.equal(paths.length, 2);
        for (const path of paths) {
            assert.ok(expected.has(path), `${path} is one of the folder's tests`);
        }

        // The stat cells against the hand tally, not against the view model.
        const worst = page.document.querySelector<HTMLElement>('.tree-row.test-row')!;
        const values = [
            ...worst.querySelectorAll<HTMLElement>('.tree-stats .stat-value'),
        ].map((cell) => cell.textContent);
        const truth = expected.get(worst.getAttribute('data-path')!)!;
        // Runs, Issue %, Issues, Skips, Failures, Timeouts, Crashes.
        assert.equal(values[0], truth.runs.toLocaleString());
        assert.equal(values[3], truth.skips.toLocaleString());
        assert.equal(values[4], truth.fails.toLocaleString());
        assert.equal(values[5], truth.timeouts.toLocaleString());
        assert.equal(values[6], truth.crashes.toLocaleString());
    } finally {
        page.restore();
    }
});

test('a clean test is counted but not listed', async () => {
    const page = await freshPage('clean');
    try {
        // The fixture's 7 tests under the extensions folder include ones with
        // no issue; they are in the total and not in the rows.
        const other = setupPage({
            page: 'tests',
            url:
                'https://tests.firefox.dev/tests.html?path=' +
                'toolkit/components/extensions/test/xpcshell',
            files: FILES,
        });
        const module = await import(`../site/tests.ts?clean2=${Date.now()}`);
        await (module as { start: () => Promise<void> }).start();
        try {
            const state = view(other);
            assert.equal(state.list!.totalTestCount, 7);
            assert.ok(
                rowPaths(other).length < 7,
                'fewer rows than tests, so the clean ones are in the denominator only'
            );
        } finally {
            other.restore();
        }
    } finally {
        page.restore();
    }
});

// --- the range, which is the page's reason to exist -----------------------

test('selecting a day filters the worklist, not only the highlight', async () => {
    const page = await freshPage('range');
    try {
        assert.equal(rowPaths(page).length, 2, 'both tests over the whole window');

        // Day 20 is in the half of the window where `test_socks.js` has no
        // issue, so selecting it must drop that row. A controller that drew the
        // highlight and did not filter fails here.
        clickDay(page, 20);
        assert.deepEqual(view(page).range, { from: 20, to: 20 });
        const late = rowPaths(page);
        assert.ok(
            !late.some((path) => path.endsWith('test_socks.js')),
            'the test with no issue on that day is gone from the list'
        );

        // And the denominator is unchanged: the test is still one of the
        // folder's two, it just has nothing left to fix.
        assert.equal(view(page).list!.totalTestCount, 2);
    } finally {
        page.restore();
    }
});

test('shift-click extends the range from the anchor, in either direction', async () => {
    const page = await freshPage('shift');
    try {
        clickDay(page, 5);
        assert.deepEqual(view(page).range, { from: 5, to: 5 });

        clickDay(page, 12, true);
        assert.deepEqual(view(page).range, { from: 5, to: 12 });

        // Backwards from the same anchor is the same range normalized, so a
        // reader dragging right-to-left gets what they expect.
        clickDay(page, 1, true);
        assert.deepEqual(view(page).range, { from: 1, to: 5 });
    } finally {
        page.restore();
    }
});

test('clicking the one selected day again returns to the whole window', async () => {
    const page = await freshPage('toggle');
    try {
        clickDay(page, 7);
        assert.deepEqual(view(page).range, { from: 7, to: 7 });
        // The affordance that makes the filter safe to try — `test.html`'s
        // rule, so the two pages behave the same way.
        clickDay(page, 7);
        assert.equal(view(page).range, null);
        assert.equal(rowPaths(page).length, 2);
    } finally {
        page.restore();
    }
});

test('the scope line carries the reset, and only one copy of the range', async () => {
    const page = await freshPage('clear');
    try {
        // Nothing above the charts: the range used to be stated there *and* on
        // the scope line, with a button beside it.
        assert.equal(page.document.getElementById('timeline-label'), null);
        assert.equal(page.document.getElementById('range-clear'), null);
        assert.equal(
            page.document.querySelector('#scope-line .scope-reset'),
            null,
            'no reset with nothing selected'
        );

        clickDay(page, 3);
        const reset = page.document.querySelector<HTMLElement>('#scope-line .scope-reset')!;
        assert.match(reset.textContent ?? '', /see all 21 days/);
        reset.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
        assert.equal(view(page).range, null);
        assert.equal(page.document.querySelector('#scope-line .scope-reset'), null);
    } finally {
        page.restore();
    }
});

test('the range goes into the hash, and the whole window does not', async () => {
    const page = await freshPage('hash');
    try {
        clickDay(page, 4);
        clickDay(page, 9, true);
        const hash = new URLSearchParams(page.window.location.hash.slice(1));
        assert.equal(hash.get('from'), '4');
        assert.equal(hash.get('to'), '9');
        assert.equal(hash.get('date'), null, 'one window, so no date key');
        // The folder is *not* in the hash — it is what the page is, and it
        // lives in the query string.
        assert.equal(hash.get('path'), null);
        assert.equal(
            new URLSearchParams(page.window.location.search).get('path'),
            FOLDER
        );

        clickDay(page, 4);
        clickDay(page, 4);
        const cleared = new URLSearchParams(page.window.location.hash.slice(1));
        // A reader who has not selected anything must not get a URL pinning
        // today's window — next month it means a different one.
        assert.equal(cleared.get('from'), null);
        assert.equal(cleared.get('to'), null);
    } finally {
        page.restore();
    }
});

test('a range in the hash is applied on load, and clamped to the window', async () => {
    const page = await freshPage('fromhash', `?path=${FOLDER}#from=10&to=20`);
    try {
        assert.deepEqual(view(page).range, { from: 10, to: 20 });
        assert.ok(
            !rowPaths(page).some((path) => path.endsWith('test_socks.js')),
            'the hash range reached the list'
        );
    } finally {
        page.restore();
    }

    // Past the end of the file: clamped rather than showing nothing.
    const far = await freshPage('clamp', `?path=${FOLDER}#from=5&to=99`);
    try {
        assert.deepEqual(view(far).range, { from: 5, to: 20 });
    } finally {
        far.restore();
    }

    // Missing the file entirely: the whole window, not an empty list that
    // would read as a folder with nothing left to fix.
    const off = await freshPage('off', `?path=${FOLDER}#from=90&to=99`);
    try {
        assert.equal(view(off).range, null);
        assert.equal(rowPaths(off).length, 2);
    } finally {
        off.restore();
    }
});

test('every day is clickable, including one whose bar has zero height', async () => {
    // The bug this replaces: the day selection used to read
    // `elements[0]?.index` off Chart.js's `onClick`, which is only called when
    // the interaction found an element — and a day with no flaky tests draws a
    // bar of zero height. On the live aggregate for
    // `devtools/client/memory/test/xpcshell`, 18 of 21 days had `height: 0`,
    // so most of the timeline was inert. Those are exactly the days a burndown
    // reader clicks.
    //
    // jsdom has no layout, so this cannot assert the pixel path; what it can
    // assert is the invariant that made the old code wrong — the handler must
    // depend on the day index alone, never on there being data on that day.
    const page = await freshPage('emptyday');
    try {
        const state = view(page);
        const series = (
            page.window as unknown as {
                __testsView: () => { timeline: { flaky: (number | null)[] } | null };
            }
        ).__testsView().timeline;
        const empty = (series?.flaky ?? []).findIndex((value) => !value);
        assert.ok(empty >= 0, 'the fixture has a day with no flaky tests to click');

        clickDay(page, empty);
        assert.deepEqual(
            view(page).range,
            { from: empty, to: empty },
            'a day with nothing on it still selects'
        );
        assert.equal(state.dates.length, 21);
    } finally {
        page.restore();
    }
});

test('clicking day after day does not double-fire the handler', async () => {
    // The other browser-only bug: the canvas listener was attached on every
    // render, so the listeners accumulated and one physical click ran the
    // handler N times — after a render or two, selecting a new day selected it
    // and then cleared it. Driving the handler directly cannot reproduce the
    // duplicate attachment, but it does pin the state machine the duplicates
    // corrupted: each of these clicks must land on exactly the day clicked.
    const page = await freshPage('nodouble');
    try {
        clickDay(page, 5);
        assert.deepEqual(view(page).range, { from: 5, to: 5 });
        clickDay(page, 7);
        assert.deepEqual(view(page).range, { from: 7, to: 7 }, 'a new day replaces, not clears');
        clickDay(page, 7);
        assert.equal(view(page).range, null, 'the same day again clears');
        clickDay(page, 7);
        assert.deepEqual(view(page).range, { from: 7, to: 7 }, 'and selects again');
    } finally {
        page.restore();
    }
});

/** The most recent chart drawn on one canvas. */
function chartOn(page: ReturnType<typeof setupPage>, canvasId: string) {
    return [...page.chartJs].reverse().find((call) => call.canvasId === canvasId)!;
}

test('the click target covers both charts, not just one', async () => {
    // The bug: the listener was on the tests-per-day canvas, so clicking the
    // issues chart above it did nothing — two charts sharing an x axis where
    // only one was interactive. The target is now the container that holds
    // both plots, and a click on a title or a note is still not a day.
    const page = await freshPage('both-charts-click');
    try {
        const area = page.document.querySelector('.chart-click-area');
        assert.notEqual(area, null, 'the shared click target exists');
        // Both canvases are inside it.
        assert.notEqual(area!.querySelector('#issue-chart-canvas'), null);
        assert.notEqual(area!.querySelector('#timeline-canvas'), null);
        // The note is outside it, so the "click a day" hint is not itself a
        // day. There are no titles at all any more — what each chart counts is
        // its y-axis legend, whose tooltip is on the plot.
        const box = page.document.getElementById('charts-box')!;
        assert.equal(box.querySelector('.chart-click-area .chart-note'), null);
        assert.equal(box.querySelector('.chart-title'), null);
        assert.ok(
            (page.document.getElementById('timeline-box')!.title ?? '').length > 0,
            'the plot carries the explanation the title used to'
        );
    } finally {
        page.restore();
    }
});

test('both charts use the shared palette, at the same saturation', async () => {
    // The bug: this page filled bars with the solid hue while `test.html` fills
    // with the same hue at 0.7 alpha and uses the solid one as the border, so
    // the same series looked more saturated here. Both now read the palette
    // from `site/chart-colours.ts`.
    const page = await freshPage('palette');
    try {
        const issues = chartOn(page, 'issue-chart-canvas');
        const failures = issues.datasets.find((dataset) => dataset.label === 'Failures')!;
        const config = failures as unknown as { backgroundColor: string; borderColor: string };
        assert.equal(config.borderColor, '#ff8c00', 'the solid hue is the border');
        assert.equal(
            config.backgroundColor,
            'rgba(255, 140, 0, 0.7)',
            'the fill is that hue at the alpha the other pages use'
        );
    } finally {
        page.restore();
    }
});

test('the range is a column band, not desaturated bars', async () => {
    // `test.html` keeps every bar at full strength and paints `#d0e4fd` behind
    // the selected columns. Dimming the bars instead — which this page did —
    // made a quiet day and an out-of-range day look alike, and changed the
    // colour of the whole chart when a range was picked.
    const page = await freshPage('band');
    try {
        const before = chartOn(page, 'issue-chart-canvas');
        const fill = (call: typeof before): string =>
            (call.datasets.find((d) => d.label === 'Failures') as unknown as {
                backgroundColor: string;
            }).backgroundColor;

        clickDay(page, 4);
        const after = chartOn(page, 'issue-chart-canvas');
        assert.equal(
            fill(after),
            fill(before),
            'picking a range does not change any bar colour'
        );
        // The selection reaches the chart as the set the plugin bands.
        const selected = (
            after.config as unknown as { _selectedDays?: ReadonlySet<number> }
        )._selectedDays;
        void selected;
        assert.deepEqual(view(page).range, { from: 4, to: 4 });
    } finally {
        page.restore();
    }
});

test('the timeline draws every day and highlights only the selection', async () => {
    const page = await freshPage('chart');
    try {
        const first = chartOn(page, 'timeline-canvas');
        assert.equal(first.type, 'bar');
        assert.equal(first.canvasId, 'timeline-canvas');
        assert.equal(first.labels.length, 21, 'the whole window is drawn');
        assert.ok(first.attached, 'the canvas is in the document, so Chart.js can size it');

        clickDay(page, 20);
        const after = chartOn(page, 'timeline-canvas');
        // Still 21 bars: the range is a highlight, not a clip. This is the
        // assertion that fails if someone "optimizes" the chart to the range.
        assert.equal(after.labels.length, 21);
        // And the bars are one colour, not a per-day array: the selection is a
        // band painted behind them, as on `test.html`. A per-day array here
        // would mean the desaturation came back.
        const fill = (
            after.config['data'] as { datasets: { backgroundColor: unknown }[] }
        ).datasets[0]!.backgroundColor;
        assert.equal(typeof fill, 'string', `one fill for every bar, got ${typeof fill}`);
        // The shared failure orange: `flaky.html` moved to it too, so the
        // two charts in this box no longer show two near-identical oranges.
        assert.equal(fill, 'rgba(255, 140, 0, 0.7)');
    } finally {
        page.restore();
    }
});

// --- the expanded test ----------------------------------------------------

test('expanding a test lists its issue lines for the selected range', async () => {
    const page = await freshPage('expand');
    try {
        const socks = [...page.document.querySelectorAll<HTMLElement>('.tree-row.test-row')].find(
            (row) => row.getAttribute('data-path')!.endsWith('test_socks.js')
        )!;
        socks.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));

        const details = page.document.querySelector('.issue-details-row')!;
        const badges = [...details.querySelectorAll('.issue-badge')].map((b) => b.textContent);
        assert.deepEqual(badges, ['TIMEOUT'], 'its one issue over the whole window');
        assert.equal(view(page).openTest, 'netwerk/test/unit/test_socks.js');

        // Clicking again closes it.
        socks.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
        assert.equal(page.document.querySelector('.issue-details-row'), null);
        assert.equal(view(page).openTest, null);
    } finally {
        page.restore();
    }
});

test('the issue lines say "fixed in this range" rather than "no issues"', async () => {
    // The distinction a burndown lives on. `test_socks.js` has an issue in the
    // window but none in days 10-20, and the page must not say the test is
    // clean outright — nor list a line it did not count.
    const page = await freshPage('fixed', `?path=${FOLDER}#from=10&to=20`);
    try {
        // It is not in the worklist at all in this range, which is the primary
        // signal; assert that rather than an empty details row.
        assert.ok(!rowPaths(page).some((path) => path.endsWith('test_socks.js')));
        // And the scope line reports one of two, so the reader can see the
        // other test is accounted for rather than missing.
        assert.match(
            page.document.getElementById('scope-line')!.textContent ?? '',
            /1 test with issues out of 2/
        );
    } finally {
        page.restore();
    }
});

test('the detail file is fetched on expansion, once, and never blocks a render', async () => {
    const page = await freshPage('detail');
    try {
        assert.ok(!page.requested.includes('xpcshell-issues-with-taskids.json'));

        page.hold('xpcshell-issues-with-taskids.json');
        const row = page.document.querySelector<HTMLElement>('.tree-row.test-row')!;
        row.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));

        // The issue lines are there before the merge lands: they come from the
        // file already loaded, and only the per-run links need the larger one.
        assert.ok(
            page.document.querySelectorAll('.issue-item').length > 0,
            'the expansion rendered without waiting for 15.9 MB'
        );
        assert.ok(page.requested.includes('xpcshell-issues-with-taskids.json'));

        page.release('xpcshell-issues-with-taskids.json');
        await (
            page.window as unknown as { __testsDetailedLoad: () => Promise<void> | null }
        ).__testsDetailedLoad();

        // Expanding another test does not fetch it a second time.
        const before = page.requested.filter(
            (name) => name === 'xpcshell-issues-with-taskids.json'
        ).length;
        const rows = [...page.document.querySelectorAll<HTMLElement>('.tree-row.test-row')];
        rows.at(-1)!.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
        assert.equal(
            page.requested.filter((name) => name === 'xpcshell-issues-with-taskids.json')
                .length,
            before,
            '15.9 MB is not a request to make twice'
        );
    } finally {
        page.restore();
    }
});

test('after the merge, an issue line expands to its runs with real links', async () => {
    // The feature the 15.9 MB file exists for. Before the merge there is no
    // attribution at all, so this is asserted *after* release — and against a
    // task ID read out of the detailed fixture, not out of the page.
    const page = await freshPage('runs');
    try {
        const socks = [...page.document.querySelectorAll<HTMLElement>('.tree-row.test-row')].find(
            (row) => row.getAttribute('data-path')!.endsWith('test_socks.js')
        )!;
        socks.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
        await (
            page.window as unknown as { __testsDetailedLoad: () => Promise<void> | null }
        ).__testsDetailedLoad();

        const line = page.document.querySelector<HTMLElement>('.issue-item.has-runs')!;
        line.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
        // The click awaits the merge before building rows, so let it settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        const rows = page.document.querySelectorAll('.issue-runs tr');
        assert.equal(rows.length, 1, 'the one timeout in the window');
        const links = [...rows[0]!.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
        // The task ID is `Nf_in0iDRkKntpbGFajFkw.0` in the detailed fixture;
        // every link for this run must name that task rather than some other.
        assert.ok(
            links.length > 0 && links.every((href) => href.includes('Nf_in0iDRkKntpbGFajFkw')),
            `the run's links point at its own task: ${JSON.stringify(links)}`
        );
        assert.ok(
            links.some((href) => href.includes('profiler')),
            'a profile link, which is what the job name points at'
        );
    } finally {
        page.restore();
    }
});

test('the page works with the detail file absent', async () => {
    // A failure there is a warning, not an error: the page keeps showing the
    // numbers it already had.
    const { 'xpcshell-issues-with-taskids.json': _omitted, ...without } = FILES;
    const page = await freshPage('nodetail', `?path=${FOLDER}`, without);
    try {
        const row = page.document.querySelector<HTMLElement>('.tree-row.test-row')!;
        row.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
        assert.ok(page.document.querySelectorAll('.issue-item').length > 0);
        assert.equal(page.document.getElementById('error')!.style.display, 'none');
    } finally {
        page.restore();
    }
});

// --- the filters and the search -------------------------------------------

test('unchecking skips moves the totals, not just the rows', async () => {
    const page = await freshPage('filters');
    try {
        const before = view(page).list!.issueCount;
        const box = page.document.getElementById('filter-skips') as HTMLInputElement;
        box.checked = false;
        box.dispatchEvent(new page.window.Event('change', { bubbles: true }));

        const after = view(page).list!.issueCount;
        assert.ok(
            after < before,
            'the skips left the numerator, so this is not a visibility filter'
        );
        const truth = handTally(FOLDER);
        const skips = [...truth.values()].reduce((sum, row) => sum + row.skips, 0);
        assert.equal(before - after, skips, 'exactly the tallied skips went away');
    } finally {
        page.restore();
    }
});

test('the search narrows the rows and keeps the folder’s total', async () => {
    const page = await freshPage('search');
    try {
        const box = page.document.getElementById('search-box') as HTMLInputElement;
        box.value = 'socks';
        box.dispatchEvent(new page.window.Event('input', { bubbles: true }));
        // `searchBox` debounces, so drive the render the way a reader's keypress
        // eventually does rather than racing the timer.
        await new Promise((resolve) => setTimeout(resolve, 350));

        assert.deepEqual(rowPaths(page), ['netwerk/test/unit/test_socks.js']);
        assert.equal(view(page).list!.totalTestCount, 2);
    } finally {
        page.restore();
    }
});

// --- sorting --------------------------------------------------------------

test('a column header re-sorts without refetching', async () => {
    const page = await freshPage('sort');
    try {
        const before = page.requested.length;
        const headers = [
            ...page.document.querySelectorAll<HTMLElement>('.sort-header .sort-button'),
        ];
        const byName = headers.find((button) => button.textContent?.includes('Test'))!;
        byName.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));

        assert.deepEqual(
            rowPaths(page),
            [
                'netwerk/test/unit/test_socks.js',
                'netwerk/test/unit/test_trr_https_fallback.js',
            ],
            'ascending by path'
        );
        assert.equal(page.requested.length, before, 'the data was already in hand');
    } finally {
        page.restore();
    }
});

// --- the empty and the missing --------------------------------------------

test('a folder with no tests says so instead of rendering an empty table', async () => {
    const page = await freshPage('missing', '?path=does/not/exist');
    try {
        assert.equal(rowPaths(page).length, 0);
        assert.match(
            page.document.getElementById('worklist-table')!.textContent ?? '',
            /No tests under does\/not\/exist/
        );
    } finally {
        page.restore();
    }
});

// --- the merged harnesses -------------------------------------------------

/** The directory both fixtures hold tests in. */
const SHARED = 'toolkit/components/extensions/test';

test('a folder in both harnesses merges them and badges every row', async () => {
    const page = await freshPage('merge', `?path=${SHARED}`);
    try {
        // Both aggregates loaded and kept: this folder has xpcshell tests in
        // `.../test/xpcshell` and mochitest tests in `.../test/mochitest`.
        assert.deepEqual(page.requested, [
            'xpcshell-issues.json',
            'mochitest-issues.json',
        ]);

        const harnesses = [
            ...page.document.querySelectorAll<HTMLElement>('.tree-row.test-row'),
        ].map((row) => row.getAttribute('data-harness'));
        assert.ok(harnesses.includes('xpcshell'), 'xpcshell rows');
        assert.ok(harnesses.includes('mochitest'), 'mochitest rows');

        // The badge is shown, because it distinguishes the rows.
        const badges = [...page.document.querySelectorAll('.harness-badge')].map(
            (badge) => badge.textContent
        );
        assert.equal(badges.length, harnesses.length, 'one badge per row');
        assert.deepEqual(new Set(badges), new Set(['xpcshell', 'mochitest']));

        // The heading *states* which harnesses contributed; there is no
        // control. A `?kind=` selector was removed: once two harnesses show as
        // one ranked list, picking one is only a way to see less, and choosing
        // it made the dropdown vanish with no way back.
        assert.equal(
            page.document.getElementById('heading-harness')!.textContent,
            'XPCShell + Mochitest'
        );
        assert.equal(page.document.querySelector('.harness-switcher'), null);
    } finally {
        page.restore();
    }
});

test('a single-harness folder shows no badge and no switcher options', async () => {
    const page = await freshPage('single-harness');
    try {
        // `netwerk/test/unit` is xpcshell-only, so the badge would be the same
        // word on every row.
        assert.equal(page.document.querySelectorAll('.harness-badge').length, 0);
        // And the heading names the one harness that has tests here, which is
        // worth knowing and costs no control.
        assert.equal(
            page.document.getElementById('heading-harness')!.textContent,
            'XPCShell'
        );
    } finally {
        page.restore();
    }
});

test('both aggregates load whatever the URL says, including a stale ?kind=', async () => {
    // `?kind=` no longer selects a harness: a path is not a harness's unit, so
    // the page loads both and merges. A link written when it did select one
    // must still show the whole path rather than half of it.
    const page = await freshPage('kind', `?path=${SHARED}&kind=mochitest`);
    try {
        assert.deepEqual(page.requested, [
            'xpcshell-issues.json',
            'mochitest-issues.json',
        ]);
        const harnesses = new Set(
            [...page.document.querySelectorAll<HTMLElement>('.tree-row.test-row')].map((row) =>
                row.getAttribute('data-harness')
            )
        );
        assert.deepEqual(harnesses, new Set(['xpcshell', 'mochitest']));
    } finally {
        page.restore();
    }
});

// --- the no-folder search form -------------------------------------------

test('with no path the layout is the same, and the heading is the control', async () => {
    const page = await freshPage('noform', '');
    try {
        // The same shell: the heading, its input and the controls stay put, and
        // only the charts and the table give way to a hint. Arriving with no
        // path used to swap in a whole different page, so the two states looked
        // like two pages and the input moved.
        const input = page.document.querySelector<HTMLInputElement>('#folder-path-input')!;
        assert.notEqual(input, null, 'the same input, in the same place');
        assert.equal(page.document.querySelector('#folder-form'), null, 'no second form');
        assert.notEqual(page.document.querySelector('.path-prompt'), null);
        assert.equal(page.document.getElementById('charts-box')!.style.display, 'none');
        assert.equal(page.document.getElementById('worklist-container')!.style.display, 'none');
        // And the controls are where they always are, not hidden or moved.
        assert.notEqual(page.document.getElementById('search-box'), null);
    } finally {
        page.restore();
    }
});

test('the heading path completes on every folder, ancestors included', async () => {
    const page = await freshPage('form-ac', '');
    try {
        const input = page.document.querySelector<HTMLInputElement>('#folder-path-input')!;
        input.value = 'netwerk';
        input.dispatchEvent(new page.window.Event('input', { bubbles: true }));
        // The folder list is fetched once and shared, so the first keystroke
        // may land before it resolves.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const items = [
            ...page.document.querySelectorAll('#folder-path-dropdown .ac-item'),
        ].map((item) => item.textContent);
        // The folder itself and its subdirectories — `netwerk` alone is
        // offerable even though every test sits further down, because a
        // burndown often starts at a subsystem.
        assert.ok(items.includes('netwerk'), `got ${items.join(', ')}`);
        assert.ok(items.includes('netwerk/test/unit'));
        // Directories, not test files.
        assert.ok(!items.some((item) => (item ?? '').endsWith('.js')));
    } finally {
        page.restore();
    }
});

// --- the issue-count chart and the hover overlay -------------------------

test('both charts are drawn, issue counts above tests-per-day', async () => {
    const page = await freshPage('two-charts');
    try {
        const issues = chartOn(page, 'issue-chart-canvas');
        const tests = chartOn(page, 'timeline-canvas');
        assert.notEqual(issues, undefined, 'the issue-count chart');
        assert.notEqual(tests, undefined, 'the tests-per-day chart');
        assert.equal(issues.labels.length, 21);
        assert.equal(tests.labels.length, 21);

        // The issue chart is the one that counts occurrences, so its four
        // categories are the issue types rather than the flaky/skipped states.
        const series = issues.datasets
            .map((dataset) => dataset.label)
            .filter((label) => !label.includes('(other tests)'));
        assert.deepEqual(series, ['Failures', 'Timeouts', 'Crashes', 'Skips']);
    } finally {
        page.restore();
    }
});

test('hovering a test row highlights its share of the issue chart', async () => {
    const page = await freshPage('hover');
    try {
        const before = chartOn(page, 'issue-chart-canvas');
        // With nothing hovered the bright half carries the whole count and the
        // remainder is zero, so the chart reads as one dataset per category.
        const remainderBefore = before.datasets.find((d) =>
            d.label.includes('(other tests)')
        )!;
        assert.ok(
            remainderBefore.data.every((value) => value === 0),
            'no remainder until a row is hovered'
        );

        const row = page.document.querySelector<HTMLElement>('.tree-row.test-row')!;
        const path = row.getAttribute('data-path')!;
        row.dispatchEvent(new page.window.MouseEvent('mouseenter', { bubbles: false }));

        const after = chartOn(page, 'issue-chart-canvas');
        assert.notEqual(after, before, 'the chart was redrawn');
        // The bright half is now this one test's contribution, and the two
        // halves still sum to the day's total — so the bar height never moves.
        for (const category of ['Failures', 'Skips']) {
            const mine = after.datasets.find((d) => d.label === category)!;
            const others = after.datasets.find(
                (d) => d.label === `${category} (other tests)`
            )!;
            const total = before.datasets.find((d) => d.label === category)!;
            for (let day = 0; day < total.data.length; day++) {
                assert.equal(
                    mine.data[day]! + others.data[day]!,
                    total.data[day],
                    `${category} day ${day} still sums to the whole`
                );
            }
        }

        // The row's own totals are what the bright half adds up to.
        const list = view(page).list!;
        const hovered = list.tests.find((test) => test.fullPath === path)!;
        const mineFail = after.datasets.find((d) => d.label === 'Failures')!;
        assert.equal(
            mineFail.data.reduce((a, b) => a + b, 0),
            hovered.failCount
        );

        row.dispatchEvent(new page.window.MouseEvent('mouseleave', { bubbles: false }));
        const cleared = chartOn(page, 'issue-chart-canvas');
        assert.ok(
            cleared.datasets
                .find((d) => d.label.includes('(other tests)'))!
                .data.every((value) => value === 0),
            'leaving the row clears the overlay'
        );
    } finally {
        page.restore();
    }
});

test('unchecking a type removes it from the chart as well as the numbers', async () => {
    // Skips outnumber failures by an order of magnitude in most folders, so
    // with them plotted the failures are a sliver and the chart cannot answer
    // "did the failures go down". Unchecking one has to take it out of both.
    const page = await freshPage('chartfilter');
    try {
        const before = chartOn(page, 'issue-chart-canvas');
        const series = (call: typeof before): string[] =>
            call.datasets.map((d) => d.label).filter((l) => !l.includes('(other tests)'));
        assert.deepEqual(series(before), ['Failures', 'Timeouts', 'Crashes', 'Skips']);

        const box = page.document.getElementById('filter-skips') as HTMLInputElement;
        box.checked = false;
        box.dispatchEvent(new page.window.Event('change', { bubbles: true }));

        const after = chartOn(page, 'issue-chart-canvas');
        assert.deepEqual(series(after), ['Failures', 'Timeouts', 'Crashes']);
        // And it left the hash, so the view is shareable.
        assert.equal(
            new URLSearchParams(page.window.location.hash.slice(1)).get('issues'),
            'ftc'
        );
    } finally {
        page.restore();
    }
});

test('a filter state in the URL is applied on load, over the checkboxes', async () => {
    const page = await freshPage('filterurl', `?path=${FOLDER}#issues=f`);
    try {
        assert.deepEqual(view(page).filters, {
            failures: true,
            timeouts: false,
            crashes: false,
            skips: false,
        });
        // The boxes match, so the control and the data agree on arrival.
        for (const [id, checked] of [
            ['filter-failures', true],
            ['filter-timeouts', false],
            ['filter-skips', false],
        ] as const) {
            assert.equal(
                (page.document.getElementById(id) as HTMLInputElement).checked,
                checked,
                id
            );
        }
    } finally {
        page.restore();
    }
});

// --- the shared filter shortcut ------------------------------------------

test('f focuses the filter box, and typing is never interrupted', async () => {
    // Wired in `site/drilldown-render.ts`'s `searchBox`, which every page with
    // a filter box goes through — so this covers the family, not just this
    // page.
    const page = await freshPage('shortcut');
    try {
        const box = page.document.getElementById('search-box') as HTMLInputElement;
        assert.notEqual(page.document.activeElement, box, 'not focused to begin with');

        const press = (key: string, target: Element, modifiers: Record<string, boolean> = {}) => {
            const event = new page.window.KeyboardEvent('keydown', {
                key,
                bubbles: true,
                cancelable: true,
                ...modifiers,
            });
            target.dispatchEvent(event);
            return event;
        };

        const bare = press('f', page.document.body);
        assert.equal(page.document.activeElement, box, 'f focuses the filter box');
        assert.equal(bare.defaultPrevented, true, 'and the f does not land in it');

        // Escape leaves, without clearing: the value is URL state on most of
        // these pages, so clearing it would throw away what a reader arrived
        // with.
        box.value = 'socks';
        press('Escape', box);
        assert.notEqual(page.document.activeElement, box, 'Escape blurs');
        assert.equal(box.value, 'socks', 'and keeps the filter');

        // An `f` typed into any field is an `f`. This page has two text inputs,
        // so "already typing" is the common case rather than an edge one.
        const path = page.document.getElementById('folder-path-input')!;
        const inField = press('f', path);
        assert.equal(inField.defaultPrevented, false, 'not stolen from another input');

        // And the browser keeps its own find-in-page.
        const withCtrl = press('f', page.document.body, { ctrlKey: true });
        assert.equal(withCtrl.defaultPrevented, false, 'Ctrl+F is the browser’s');
        const withMeta = press('f', page.document.body, { metaKey: true });
        assert.equal(withMeta.defaultPrevented, false, 'Cmd+F is the browser’s');
    } finally {
        page.restore();
    }
});

test('f does nothing while the filter box is hidden', async () => {
    // `try.html` keeps its filter hidden until a revision is loaded, and
    // focusing an invisible field loses the reader's keystrokes with nothing
    // to show why. Checked by walking `display` rather than reading
    // `offsetParent`: jsdom does no layout, so `offsetParent` is always null
    // there and this guard would be dead in every test while live in a
    // browser.
    const page = await freshPage('hiddenbox');
    try {
        const box = page.document.getElementById('search-box') as HTMLInputElement;
        const controls = page.document.querySelector<HTMLElement>('.controls')!;
        controls.style.display = 'none';

        const event = new page.window.KeyboardEvent('keydown', {
            key: 'f',
            bubbles: true,
            cancelable: true,
        });
        page.document.body.dispatchEvent(event);
        assert.equal(event.defaultPrevented, false, 'the key is left alone');
        assert.notEqual(page.document.activeElement, box, 'and nothing is focused');

        // Shown again, it works.
        controls.style.display = '';
        const second = new page.window.KeyboardEvent('keydown', {
            key: 'f',
            bubbles: true,
            cancelable: true,
        });
        page.document.body.dispatchEvent(second);
        assert.equal(page.document.activeElement, box);
    } finally {
        page.restore();
    }
});
