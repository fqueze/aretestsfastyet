/**
 * `stitchWindows` — joining consecutive 21-day aggregates into one timeline.
 *
 * The windows are built by hand rather than taken from the fixtures, because
 * what is under test is the *seam* rules and a fixture has only one window.
 * Each synthetic file gives one status one run per day, with the run count
 * equal to a per-window marker plus the day, so any misplaced day shows up as a
 * wrong number rather than as a missing entry.
 *
 * The rules being pinned, all from measurement recorded in `lib/formats/stitch.ts`:
 *
 * - interior days pass through untouched,
 * - a seam date is taken from the window holding it as an interior day,
 * - when both hold it at a boundary the newer window wins,
 * - the timeline's own outer edges are kept, not dropped,
 * - the result is calendar-contiguous, because `startDateOf` reconstructs every
 *   label by arithmetic from `endDate`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeIssues } from '../lib/formats/issues.ts';
import type { IssuesFile } from '../lib/formats/issues.ts';
import {
    type StitchWindow,
    isDecodableAggregate,
    stitchWindows,
} from '../lib/formats/stitch.ts';

/** A one-test, one-status aggregate covering `days` days from `startDate`. */
function window(options: {
    startDate: string;
    days: number;
    /** Added to the day index to make each window's counts distinguishable. */
    marker: number;
    paths?: string[];
}): StitchWindow {
    const paths = options.paths ?? ['dom/base/test/test_a.js'];
    const end = new Date(
        Date.parse(`${options.startDate}T00:00:00Z`) + (options.days - 1) * 86_400_000
    )
        .toISOString()
        .slice(0, 10);
    const file: IssuesFile = {
        metadata: {
            startDate: options.startDate,
            endDate: end,
            days: options.days,
            startTime: Date.parse(`${options.startDate}T00:00:00Z`) / 1000,
            generatedAt: `${end}T03:00:00.000Z`,
            totalTestCount: paths.length,
            testsWithFailures: paths.length,
            aggregatedFrom: [],
        },
        tables: {
            testPaths: paths.map((path) => path.slice(0, path.lastIndexOf('/'))),
            testNames: paths.map((path) => path.slice(path.lastIndexOf('/') + 1)),
            statuses: ['PASS', 'FAIL'],
            messages: ['boom'],
            crashSignatures: [],
            components: ['Core::DOM'],
        },
        testInfo: {
            testPathIds: paths.map((_, index) => index),
            testNameIds: paths.map((_, index) => index),
            componentIds: paths.map(() => 0),
        },
        testRuns: paths.map(() => [
            // PASS: one entry per day, count = marker + day.
            {
                days: Array.from({ length: options.days }, (_, day) => (day === 0 ? 0 : 1)),
                counts: Array.from({ length: options.days }, (_, day) => options.marker + day),
            },
            null,
        ]),
    };
    const decoded = decodeIssues(file);
    const dates = Array.from({ length: options.days }, (_, day) =>
        new Date(Date.parse(`${options.startDate}T00:00:00Z`) + day * 86_400_000)
            .toISOString()
            .slice(0, 10)
    );
    return { file: decoded, dates };
}

/** `{date: passCount}` for a test, read out of a stitched timeline. */
function countsByDate(stitched: ReturnType<typeof stitchWindows>, path: string): Map<string, number> {
    const identity = stitched.file.findTest(path);
    assert.ok(identity !== null, `${path} is in the timeline`);
    const out = new Map<string, number>();
    for (const entry of stitched.file.runsOfTest(identity.testId)) {
        if (entry.day === null) {
            continue;
        }
        const date = stitched.dates[entry.day];
        assert.ok(date !== undefined, `day ${entry.day} is inside the span`);
        out.set(date, (out.get(date) ?? 0) + entry.count);
    }
    return out;
}

test('a single window is returned unchanged rather than wrapped', () => {
    const only = window({ startDate: '2026-09-01', days: 21, marker: 100 });
    const stitched = stitchWindows([only]);
    assert.equal(stitched.file, only.file, 'the same object, not a composite');
    assert.equal(stitched.seams, 0);
    assert.deepEqual(stitched.missing, []);
    assert.equal(stitched.dates.length, 21);
});

test('two windows sharing one date join into a contiguous span', () => {
    // 08-05..08-25 and 08-25..09-14: 41 days, sharing 08-25.
    const older = window({ startDate: '2026-08-05', days: 21, marker: 1000 });
    const newer = window({ startDate: '2026-08-25', days: 21, marker: 2000 });
    const stitched = stitchWindows([older, newer]);

    assert.equal(stitched.dates.length, 41, '21 + 21 - 1 shared day');
    assert.equal(stitched.dates[0], '2026-08-05');
    assert.equal(stitched.dates.at(-1), '2026-09-14');
    assert.equal(stitched.seams, 1, 'exactly one date was claimed twice');
    assert.deepEqual(stitched.missing, [], 'no holes');
    assert.equal(stitched.file.days, 41, 'the composite reports the long window');
    assert.equal(stitched.file.endDate, '2026-09-14');

    // Contiguous: every date is one day after the previous one.
    for (let day = 1; day < stitched.dates.length; day++) {
        const previous = Date.parse(`${stitched.dates[day - 1]}T00:00:00Z`);
        const current = Date.parse(`${stitched.dates[day]}T00:00:00Z`);
        assert.equal(current - previous, 86_400_000, `${stitched.dates[day]} follows its neighbour`);
    }
});

test('interior days come from their own window, untouched', () => {
    const older = window({ startDate: '2026-08-05', days: 21, marker: 1000 });
    const newer = window({ startDate: '2026-08-25', days: 21, marker: 2000 });
    const counts = countsByDate(stitchWindows([older, newer]), 'dom/base/test/test_a.js');

    // 08-10 is the older window's day 5 -> 1000 + 5.
    assert.equal(counts.get('2026-08-10'), 1005);
    // 09-05 is the newer window's day 11 -> 2000 + 11.
    assert.equal(counts.get('2026-09-05'), 2011);
});

test('the outer edges are kept, not dropped as untrustworthy', () => {
    const older = window({ startDate: '2026-08-05', days: 21, marker: 1000 });
    const newer = window({ startDate: '2026-08-25', days: 21, marker: 2000 });
    const counts = countsByDate(stitchWindows([older, newer]), 'dom/base/test/test_a.js');

    // The oldest day of the oldest window and the newest of the newest: both
    // are boundary days with no better source, so they stay. Dropping the
    // newest would cost the reader the most recent day the page can show.
    assert.equal(counts.get('2026-08-05'), 1000, 'oldest day present');
    assert.equal(counts.get('2026-09-14'), 2020, 'newest day present');
});

test('a seam date both windows hold at a boundary comes from the newer one', () => {
    // 08-25 is the older window's last day and the newer window's first: both
    // boundaries, so the later-generated run wins. Measured on live data, that
    // run had 222,330 more runs for the shared date.
    const older = window({ startDate: '2026-08-05', days: 21, marker: 1000 });
    const newer = window({ startDate: '2026-08-25', days: 21, marker: 2000 });
    const counts = countsByDate(stitchWindows([older, newer]), 'dom/base/test/test_a.js');

    assert.equal(counts.get('2026-08-25'), 2000, "the newer window's day 0, not the older's day 20");
    assert.notEqual(counts.get('2026-08-25'), 1020, "not the older window's endDate day");
});

test('a seam date one window holds as an interior day comes from that window', () => {
    // Overlapping by 3: 08-23, 08-24, 08-25 are in both. For the newer window
    // 08-23 is day 0 (a boundary) while the older holds it as day 18
    // (interior), so the older wins that one — interior beats boundary
    // whichever window is newer.
    const older = window({ startDate: '2026-08-05', days: 21, marker: 1000 });
    const newer = window({ startDate: '2026-08-23', days: 21, marker: 2000 });
    const stitched = stitchWindows([older, newer]);
    const counts = countsByDate(stitched, 'dom/base/test/test_a.js');

    assert.equal(stitched.seams, 3, 'three dates claimed twice');
    assert.equal(counts.get('2026-08-23'), 1018, "the older window's interior day 18");
    // 08-24 and 08-25 are interior in *both*, so the newer wins.
    assert.equal(counts.get('2026-08-24'), 2001);
    assert.equal(counts.get('2026-08-25'), 2002);
});

test('a gap between windows is reported rather than silently closed', () => {
    // 08-01..08-07 then 08-15..08-21: 08-08..08-14 exist in neither. The span
    // stays contiguous — `startDateOf` does date arithmetic, so a hole in the
    // numbering would misdate every label after it — and the missing dates are
    // named so the page can say so.
    const older = window({ startDate: '2026-08-01', days: 7, marker: 1000 });
    const newer = window({ startDate: '2026-08-15', days: 7, marker: 2000 });
    const stitched = stitchWindows([older, newer]);

    assert.equal(stitched.dates.length, 21, 'the whole span, holes included');
    assert.deepEqual(stitched.missing, [
        '2026-08-08',
        '2026-08-09',
        '2026-08-10',
        '2026-08-11',
        '2026-08-12',
        '2026-08-13',
        '2026-08-14',
    ]);
    const counts = countsByDate(stitched, 'dom/base/test/test_a.js');
    assert.equal(counts.get('2026-08-08'), undefined, 'a missing day has no runs');
    assert.equal(counts.get('2026-08-07'), 1006);
    assert.equal(counts.get('2026-08-15'), 2000);
});

test('every entry lands inside the stitched window', () => {
    // `flakiness.ts` uses `day` as an `Int32Array` index and silently drops
    // anything out of range, so a wrong offset here would lose data with no
    // error at all. Asserted over every entry rather than sampled.
    const older = window({ startDate: '2026-08-05', days: 21, marker: 1000 });
    const newer = window({ startDate: '2026-08-25', days: 21, marker: 2000 });
    const stitched = stitchWindows([older, newer]);

    let seen = 0;
    let highest = -1;
    for (let testId = 0; testId < stitched.file.testCount; testId++) {
        for (const entry of stitched.file.runsOfTest(testId)) {
            assert.ok(entry.day !== null, 'an aggregate entry carries a day');
            assert.ok(entry.day >= 0, `day ${entry.day} is not negative`);
            assert.ok(entry.day < stitched.dates.length, `day ${entry.day} is inside the window`);
            highest = Math.max(highest, entry.day);
            seen++;
        }
    }
    assert.equal(seen, 41, 'one entry per day, the seam resolved to a single source');
    assert.equal(highest, stitched.dates.length - 1, 'the last day carries data');
});

test('tests are joined by path, not by index', () => {
    // The windows hold different test sets in different orders, so index 0 is
    // a different test in each. Joining by index would report one test's runs
    // under another's name.
    const older = window({
        startDate: '2026-08-05',
        days: 21,
        marker: 1000,
        paths: ['dom/base/test/test_a.js', 'dom/base/test/test_gone.js'],
    });
    const newer = window({
        startDate: '2026-08-25',
        days: 21,
        marker: 2000,
        paths: ['dom/base/test/test_new.js', 'dom/base/test/test_a.js'],
    });
    const stitched = stitchWindows([older, newer]);

    assert.equal(stitched.file.testCount, 3, 'the union of both windows');

    // The test in both windows spans the whole timeline.
    const shared = countsByDate(stitched, 'dom/base/test/test_a.js');
    assert.equal(shared.get('2026-08-10'), 1005, 'from the older window');
    assert.equal(shared.get('2026-09-05'), 2011, 'from the newer window');

    // A test only the older window knows has data only in the older dates.
    const gone = countsByDate(stitched, 'dom/base/test/test_gone.js');
    assert.equal(gone.get('2026-08-10'), 1005);
    assert.equal(gone.get('2026-09-05'), undefined, 'absent from the newer window');

    // And one only the newer window knows, the other way round.
    const added = countsByDate(stitched, 'dom/base/test/test_new.js');
    assert.equal(added.get('2026-08-10'), undefined, 'absent from the older window');
    assert.equal(added.get('2026-09-05'), 2011);
});

test('windows may be given newest first', () => {
    // The page appends each backfill to its list, so the order is newest-first
    // by construction. The result must not depend on it.
    const older = window({ startDate: '2026-08-05', days: 21, marker: 1000 });
    const newer = window({ startDate: '2026-08-25', days: 21, marker: 2000 });
    const forwards = stitchWindows([older, newer]);
    const backwards = stitchWindows([newer, older]);

    assert.deepEqual(backwards.dates, forwards.dates);
    assert.deepEqual(
        [...countsByDate(backwards, 'dom/base/test/test_a.js').entries()].sort(),
        [...countsByDate(forwards, 'dom/base/test/test_a.js').entries()].sort()
    );
});

test('totalsByStatus counts only the days the timeline shows', () => {
    // A window contributes only the days it won, so summing each window's own
    // totals would double-count the seam.
    const older = window({ startDate: '2026-08-05', days: 21, marker: 1000 });
    const newer = window({ startDate: '2026-08-25', days: 21, marker: 2000 });
    const stitched = stitchWindows([older, newer]);
    const identity = stitched.file.findTest('dom/base/test/test_a.js');
    assert.ok(identity !== null);

    const counts = countsByDate(stitched, 'dom/base/test/test_a.js');
    const expected = [...counts.values()].reduce((a, b) => a + b, 0);
    assert.equal(stitched.file.totalsByStatus(identity.testId).get('PASS'), expected);
});

test('an aggregate in the pre-2026-02-16 format is rejected before decoding', () => {
    // Runs older than about 2026-02-16 key their per-day arrays `hours`.
    // Measured 2026-09-15: pushdate 2026-02-10 carries `hours` and 2026-02-16
    // carries `days`. `statusGroupShape` throws on the former, and it throws
    // only when a group is *iterated* — so without this check the file loads
    // fine and then breaks the chart mid-render.
    const legacy = {
        testRuns: [[{ counts: [1, 2, 3], hours: [0, 1, 1] }, null]],
    };
    assert.equal(isDecodableAggregate(legacy), false);

    const current = {
        testRuns: [[{ counts: [1, 2, 3], days: [0, 1, 1] }, null]],
    };
    assert.equal(isDecodableAggregate(current), true);
});

test('a malformed or empty aggregate is rejected rather than trusted', () => {
    assert.equal(isDecodableAggregate({}), false, 'no testRuns');
    assert.equal(isDecodableAggregate({ testRuns: [] }), false, 'no tests');
    assert.equal(isDecodableAggregate({ testRuns: [[null, null]] }), false, 'no groups');
    assert.equal(isDecodableAggregate(null), false);

    // Leading nulls are skipped rather than answered on: a test with no runs
    // for its first status, or none at all, says nothing about the file's
    // format — the first real group does.
    assert.equal(
        isDecodableAggregate({
            testRuns: [null, [null, null], [null, { counts: [1], days: [0] }]],
        }),
        true,
        'the first non-null group decides'
    );
});
