/**
 * `site/intermittent-view.ts` — the page's decisions, with no DOM.
 *
 * The expected values here are written out rather than computed by the code
 * under test, which is the rule this repository keeps relearning: a test that
 * imports `DEFAULT_DAYS` and asserts the window is `DEFAULT_DAYS` long passes
 * whatever the constant says. So the window arithmetic is checked against dates
 * spelled out in full, and the request plan against a total added up by hand.
 *
 * The per-day series are built from small maps written here, because the
 * properties under test are structural — a bug that appears on some days and not
 * others, a day the API never answered for — and a fixture supplies those only
 * by luck.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { OccurrenceDay, RankedIntermittent, ScanResult } from '../lib/query/intermittents.ts';
import { BUG_BATCH_SIZE } from '../lib/sources/intermittents.ts';
import {
    DEFAULT_DAYS,
    DEFAULT_TREE,
    DEFAULT_WINDOW,
    HARNESS_OPTIONS,
    TITLE_SUFFIX,
    bugUrl,
    coverageLine,
    daysOfWindow,
    annotationsTooltip,
    documentTitle,
    emptySelectionLine,
    harnessValue,
    historiesFromDays,
    parseHarness,
    parseWindowDays,
    progressLine,
    readUrlState,
    scanPlan,
    sparklinePeak,
    sparklinePeakLabel,
    sparklineVisible,
    tableRows,
    volumeLine,
    volumeSeries,
    windowNote,
    windowOf,
    windowScopeLine,
    writeUrlState,
    zeroDayKinds,
} from '../site/intermittent-view.ts';
// The rate and its tooltip are shared with `try.html`'s column rather than
// copied — `lib/query/flakiness-rate.ts` is where both pages get them.

/** A ranked row, with only the fields a view-model test reads. */
function row(bugId: number, count: number, over: Partial<RankedIntermittent> = {}): RankedIntermittent {
    return {
        bugId,
        count,
        harness: 'unknown',
        test: null,
        failure: `failure of ${bugId}`,
        bugSummary: `summary of ${bugId}`,
        // Open by default, so a test about anything else is not accidentally
        // about a struck-through row; `over` is how the resolved case is asked
        // for explicitly.
        resolution: '',
        status: 'NEW',
        // Unassigned by default, which is the common case in a ranked window
        // and keeps a test about anything else from depending on a name.
        assignee: null,
        ...over,
    };
}

/** A coverage block, with only the fields a view-model test reads. */
function coverage(over: Partial<ScanResult['coverage']> = {}): ScanResult['coverage'] {
    return { ranked: 0, scanned: 0, mochitest: 0, xpcshell: 0, unknown: 0, noBugCount: 0, ...over };
}

// --- the window -----------------------------------------------------------

test('the default window is 21 days, and it is a whole number of weeks', () => {
    assert.equal(DEFAULT_DAYS, 21);
    // The CLI's `DEFAULT_DAYS` is 7 for a stated reason — weekend push volume
    // means a non-whole-week window ranks a different weekday mix each run — and
    // 21 satisfies that reason rather than overriding it. A default of 10 or 17
    // would not, which is what this asserts.
    assert.equal(DEFAULT_DAYS % 7, 0);
    assert.equal(DEFAULT_WINDOW, '21days');
});

test('an absent date means the default window, and a bad one means none', () => {
    assert.equal(parseWindowDays(undefined), 21, 'no hash opens on 21 days');
    assert.equal(parseWindowDays(''), 21, 'an empty value is an absent one');
    assert.equal(parseWindowDays('21days'), 21);
    assert.equal(parseWindowDays('7days'), 7);
    assert.equal(parseWindowDays('14days'), 14);
    // Not a window this page can ask for: it queries a live API by day range and
    // has no single-day file to select, so a bare date is not a value here.
    assert.equal(parseWindowDays('2026-08-04'), null);
    assert.equal(parseWindowDays('0days'), null, 'a zero-day window is not a window');
    assert.equal(parseWindowDays('twenty-one'), null);
});

test('a window of n days ends today and spans n calendar days, in UTC', () => {
    // Spelled out rather than derived: the range is inclusive at both ends, so
    // "the last 21 days" is today plus the 20 before it. An off-by-one here
    // would put every number on the page one day out from the command's.
    const at = new Date('2026-09-12T15:00:00Z');
    assert.deepEqual(windowOf(21, at), { start: '2026-08-23', end: '2026-09-12' });
    assert.deepEqual(windowOf(7, at), { start: '2026-09-06', end: '2026-09-12' });
    assert.deepEqual(windowOf(1, at), { start: '2026-09-12', end: '2026-09-12' });
    // Late in the UTC day, which is where a local-time implementation drifts.
    assert.deepEqual(windowOf(7, new Date('2026-09-12T23:59:59Z')), {
        start: '2026-09-06',
        end: '2026-09-12',
    });
});

test('the window enumerates every day including both ends', () => {
    assert.deepEqual(daysOfWindow({ start: '2026-09-06', end: '2026-09-12' }), [
        '2026-09-06',
        '2026-09-07',
        '2026-09-08',
        '2026-09-09',
        '2026-09-10',
        '2026-09-11',
        '2026-09-12',
    ]);
    assert.deepEqual(daysOfWindow({ start: '2026-09-12', end: '2026-09-12' }), ['2026-09-12']);
    // Across a month boundary, where date arithmetic on the day number breaks.
    assert.deepEqual(daysOfWindow({ start: '2026-08-30', end: '2026-09-02' }), [
        '2026-08-30',
        '2026-08-31',
        '2026-09-01',
        '2026-09-02',
    ]);
    assert.equal(daysOfWindow(windowOf(21, new Date('2026-09-12T00:00:00Z'))).length, 21);
});

test('only a window that is not a whole number of weeks is annotated', () => {
    assert.equal(windowNote(7), null);
    assert.equal(windowNote(14), null);
    assert.equal(windowNote(21), null, 'the default carries no caveat');
    const note = windowNote(10);
    assert.ok(note !== null, '10 days is not a whole number of weeks');
    assert.match(note, /weekends/, 'and the note says why that matters');
    assert.match(note, /10 days/, 'naming the window it is about');
});

// --- the harness control --------------------------------------------------

test('the harness control offers all three classifications plus the unfiltered list', () => {
    assert.deepEqual(
        HARNESS_OPTIONS.map((option) => option.value),
        ['all', 'mochitest', 'xpcshell', 'unknown'],
        'four states: `selectHarness` takes the three values or `undefined`'
    );
    // `unknown` is on the same axis as the two harnesses, which is the decision
    // `lib/query/intermittents.ts` records on `HarnessSelector`. A row is one of
    // the three, so the control picks one of the three — not a checkbox beside
    // a two-value dropdown.
    assert.ok(HARNESS_OPTIONS.every((option) => option.label.length > 0));
});

test('each label reads as part of the title it sits inside', () => {
    // The control is in the `<h1>`, so each option has to complete the phrase
    // "… Intermittent failures". `All harnesses` read as a heading of its own
    // beside the title's words and `No known test` could not be read as a noun
    // phrase there; these are the owner's replacements.
    assert.deepEqual(
        HARNESS_OPTIONS.map((option) => option.label),
        ['all', 'Mochitest', 'XPCShell', 'Unknown test']
    );
    assert.equal(TITLE_SUFFIX, 'Intermittent failures');
    // The phrase the owner asked for, assembled the way the page assembles it.
    assert.equal(documentTitle('mochitest'), 'Mochitest Intermittent failures');
    assert.equal(documentTitle(undefined), 'all Intermittent failures');
    assert.equal(documentTitle('unknown'), 'Unknown test Intermittent failures');
    assert.equal(documentTitle('xpcshell'), 'XPCShell Intermittent failures');
});

test('the in-title suffix is fixed, where the table’s heading varies', () => {
    // Two titles, deliberately. The `<h1>` is the page's identity and must not
    // rewrite itself under a reader who changed one filter; the heading over the
    // table is a caption for a specific list and says the harness, the tree and
    // the window. `rankingTitle` is asserted below; what matters here is that
    // the `<h1>`'s words do not vary with the tree or the window.
    assert.equal(documentTitle(undefined).includes('trunk'), false);
    assert.equal(documentTitle(undefined).includes('2026'), false);
});

test('an unrecognised harness falls back to the unfiltered ranking', () => {
    assert.equal(parseHarness('mochitest'), 'mochitest');
    assert.equal(parseHarness('xpcshell'), 'xpcshell');
    assert.equal(parseHarness('unknown'), 'unknown');
    assert.equal(parseHarness('all'), undefined);
    assert.equal(parseHarness(undefined), undefined);
    // A hash is user-editable text. The safe answer to a harness that does not
    // exist is every bug, not an empty table that reads as "none were annotated".
    assert.equal(parseHarness('reftest'), undefined);
    assert.equal(parseHarness(''), undefined);
});

test('the control value and the selector round-trip', () => {
    for (const value of ['mochitest', 'xpcshell', 'unknown', 'all'] as const) {
        assert.equal(harnessValue(parseHarness(value)), value);
    }
    assert.equal(harnessValue(undefined), 'all');
});

// --- the request plan -----------------------------------------------------

test('the request plan counts batches, not bugs, and adds up by hand', () => {
    // Measured against live trunk for a 21-day window: 1,166 candidates, which
    // `BUG_BATCH_SIZE` = 500 makes 3 Bugzilla requests. Plus two published test
    // lists and one request per day.
    //
    // 26, not the 27 this was: the whole-window ranking request is gone, since
    // the ranking is the per-day responses summed (`rankingFromDays`). A plan
    // that still counted it would report a total the run never reaches, which
    // is the one thing `ScanPlan` exists to get right.
    const plan = scanPlan(21, 1166);
    assert.equal(plan.summaryBatches, 3, 'ceil(1166/500)');
    assert.equal(plan.days, 21);
    assert.equal(plan.total, 2 + 3 + 21);
    assert.equal(plan.total, 26, 'added up by hand, not recomputed from the formula');
});

test('the plan’s batch size tracks the client’s, or the progress line lies', () => {
    // `SUMMARY_BATCH` is deliberately a restated constant rather than an import
    // — `scanPlan`'s comment says why — so nothing but this check stops the two
    // from drifting. The page counted 12 batches while the client made 3 until
    // both were moved, and a progress line that stalls at "3 of 36" is exactly
    // what `ScanPlan` exists to prevent.
    //
    // Written as an arithmetic identity rather than as `SUMMARY_BATCH === 500`,
    // so that raising the real constant fails here with a number to act on.
    assert.equal(scanPlan(7, BUG_BATCH_SIZE).summaryBatches, 1, 'one full batch of the real size');
    assert.equal(scanPlan(7, BUG_BATCH_SIZE + 1).summaryBatches, 2, 'one bug over is two batches');
});

test('the plan before the ranking lands under-reports only the batches', () => {
    // The first progress line is drawn before the candidate count is known, so
    // the batch count is 0 and the rest of the plan is already right.
    const plan = scanPlan(21, 0);
    assert.equal(plan.summaryBatches, 0);
    assert.equal(plan.total, 2 + 0 + 21);
    // One candidate is still one batch, not zero.
    assert.equal(scanPlan(7, 1).summaryBatches, 1);
    assert.equal(scanPlan(7, 500).summaryBatches, 1, 'exactly one full batch');
    assert.equal(scanPlan(7, 501).summaryBatches, 2);
});

test('the progress line counts requests rather than showing a percentage', () => {
    const line = progressLine(14, scanPlan(21, 1166), 'Reading day 11 of 21');
    // 26, and neither of the two numbers this once was: the same 1,166
    // candidates are 3 Bugzilla batches at `BUG_BATCH_SIZE` = 500 where they
    // were 12 at 100, and the whole-window ranking request that made it 27 is
    // gone (`rankingFromDays`).
    assert.equal(line, 'Reading day 11 of 21 — 14 of 26 requests');
    // A reader of this line is deciding whether to wait, and "14 of 26" answers
    // that where "54%" does not.
    assert.doesNotMatch(line, /%/);
});

// --- the coverage line ----------------------------------------------------

const WINDOW_COVERAGE = {
    ranked: 1171,
    scanned: 1170,
    mochitest: 427,
    xpcshell: 60,
    unknown: 683,
    noBugCount: 3347,
};

test('the unfiltered count is the row count, with nothing to compare it against', () => {
    // `1,170 bugs · 1,170 classified · 3,347 untriaged excluded` was here, and
    // the page owner rejected two of its three parts: "I don't see what '1,172
    // classified' means but it seems useless" and "I have no idea what '3,351
    // untriaged excluded' means". The first is gone — with every bug classified
    // it says nothing — and the second moved into `annotationsTooltip`.
    const line = coverageLine(coverage(WINDOW_COVERAGE), undefined, 1170);
    assert.equal(line, '1,170 annotated bugs');
    assert.doesNotMatch(line, /classified/);
    assert.doesNotMatch(line, /excluded/);
});

test('a harness selection names what separates its two numbers', () => {
    // The owner's own phrasing, which is the pattern this follows: "I assume the
    // first part means '428 of 1,172 bugs are for mochitests.' and that could
    // also go in the line next to the time window drop down." A bare "427 of
    // 1,170 bugs" was read as opaque precisely because the predicate was
    // missing.
    assert.equal(
        coverageLine(coverage(WINDOW_COVERAGE), 'mochitest', 427),
        '427 of 1,170 bugs are for mochitests'
    );
    assert.equal(
        coverageLine(coverage(WINDOW_COVERAGE), 'xpcshell', 60),
        '60 of 1,170 bugs are for xpcshells'
    );
    // `unknown` is not a harness, so it gets a phrasing of its own rather than
    // "are for unknowns".
    assert.equal(
        coverageLine(coverage(WINDOW_COVERAGE), 'unknown', 683),
        '683 of 1,170 bugs name no test this tool knows'
    );
});

test('the coverage line makes no claim about a cap, because there is none', () => {
    // The table draws every matching row now, so "top 50 of 760" and "the other
    // 710 are ranked but not drawn" are gone — not softened, gone, because there
    // is no longer a prefix to confess to. `tableRows` is where that holds.
    const line = coverageLine(
        coverage({ ranked: 761, scanned: 760, noBugCount: 5 }),
        undefined,
        760
    );
    assert.doesNotMatch(line, /top \d/);
    assert.doesNotMatch(line, /not drawn/);
    assert.match(line, /^760 annotated bugs/, 'the row count is the whole list');
});

test('one bug is “1 bug”, not “1 bugs”', () => {
    assert.equal(coverageLine(coverage({ ranked: 2, scanned: 1 }), undefined, 1), '1 annotated bug');
});

test('an empty selection says which question came back empty', () => {
    const cov = coverage({ ranked: 761, scanned: 760 });
    assert.match(emptySelectionLine('xpcshell', cov), /No bug among the 760 annotated/);
    assert.match(emptySelectionLine('unknown', cov), /Every one of the 760/);
    assert.equal(emptySelectionLine(undefined, cov), 'No bug was annotated in this window.');
});

test('the scope line carries the tree and the window’s ends', () => {
    // `rankingTitle` was here, asserting the `<h2>` over the table in the CLI's
    // three phrasings. The page owner removed the point of that heading --
    // "what's the point of this section title when there's only one section in
    // the entire page?" -- so what is asserted now is the line that inherited
    // the two facts the heading carried and nothing else did.
    assert.equal(
        windowScopeLine('trunk', { start: '2026-09-06', end: '2026-09-12' }),
        'trunk, 2026-09-06 to 2026-09-12'
    );
    // The harness is deliberately absent: it is the `<h1>`'s dropdown and the
    // coverage line's predicate already, and a third copy would be the noise
    // the heading was removed for.
    assert.doesNotMatch(windowScopeLine('autoland', { start: 'a', end: 'b' }), /mochitest/);
});

// --- the table ------------------------------------------------------------

test('the table renders every matching row, in the ranking’s order', () => {
    // **No cap.** There was one — 50, taken from the CLI’s `DEFAULT_LIMIT` — and
    // it only hid data: a terminal cannot scroll a thousand rows and a browser
    // can. The cost that a cap was really avoiding is the per-row charts, which
    // are drawn lazily now; the comment above `tableRows` carries the
    // measurements.
    const selected = Array.from({ length: 1170 }, (_, i) => row(1000 + i, 2000 - i));
    const rows = tableRows(selected, new Map());
    assert.equal(rows.length, 1170, 'every matching row, not a prefix');
    assert.deepEqual(
        rows.slice(0, 3).map((entry) => entry.bug.bugId),
        [1000, 1001, 1002],
        'in the ranking’s order, not a re-sort of it'
    );
    assert.equal(rows.at(-1)!.bug.bugId, 2169, 'including the last one');
});

test('a row with no per-day series still gets a row', () => {
    // The count came from the window ranking and is real whether or not the
    // per-day breakdown arrived; dropping the row would make a chart failure
    // look like a data absence.
    const rows = tableRows([row(1, 5)], new Map());
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.history, []);
    assert.equal(sparklineVisible(rows[0]!.history), false);
});

test('a sparkline is drawn only when there is a shape to draw', () => {
    assert.equal(sparklineVisible([]), false, 'nothing');
    assert.equal(sparklineVisible([{ date: '2026-09-12', count: 9 }]), false, 'one point is not a trend');
    assert.equal(
        sparklineVisible([
            { date: '2026-09-11', count: 0 },
            { date: '2026-09-12', count: 0 },
        ]),
        false,
        'a flat line of zeros says nothing'
    );
    assert.equal(
        sparklineVisible([
            { date: '2026-09-11', count: 0 },
            { date: '2026-09-12', count: 3 },
        ]),
        true
    );
});

// --- the sparkline's scale and its zero days ------------------------------

test('each row’s scale is its own peak, and the label states it', () => {
    // Per-row rather than shared, because a shared maximum left 19 of the 50
    // drawn rows entirely inside 2px of the 28px cell on live trunk —
    // `sparklinePeak`'s comment carries the table.
    const small: OccurrenceDay[] = [
        { date: '2026-09-11', count: 0 },
        { date: '2026-09-12', count: 3 },
    ];
    const large: OccurrenceDay[] = [
        { date: '2026-09-11', count: 400 },
        { date: '2026-09-12', count: 193 },
    ];
    assert.equal(sparklinePeak(small), 3);
    assert.equal(sparklinePeak(large), 400);
    // Never zero, or the axis has no extent and Chart.js draws nothing.
    assert.equal(sparklinePeak([{ date: '2026-09-12', count: 0 }]), 1);
    assert.equal(sparklinePeak([]), 1);

    // The label is what keeps per-row scaling honest, so it is part of the
    // contract rather than decoration.
    assert.equal(sparklinePeakLabel(small), 'peak 3/day');
    assert.equal(sparklinePeakLabel(large), 'peak 400/day');
    // Thousands separators, like every other number on this site.
    assert.equal(
        sparklinePeakLabel([{ date: '2026-09-12', count: 1275 }]),
        'peak 1,275/day'
    );
});

test('a zero day is leading, fixed or quiet, by what the zero means', () => {
    // Leading zeros come before the bug's first annotation in the window: the
    // bug was not failing yet, which is an absence of data rather than an
    // achieved zero, so it is grey and not green.
    const series: OccurrenceDay[] = [
        { date: '2026-09-08', count: 0 },
        { date: '2026-09-09', count: 0 },
        { date: '2026-09-10', count: 7 },
        { date: '2026-09-11', count: 0 },
        { date: '2026-09-12', count: 0 },
    ];
    assert.deepEqual(zeroDayKinds(series, true), [
        'leading',
        'leading',
        null,
        'fixed',
        'fixed',
    ]);
    // The same series on an **open** bug: nothing was achieved, so no day is
    // `fixed`. This is what makes green mean something.
    assert.deepEqual(zeroDayKinds(series, false), [
        'leading',
        'leading',
        null,
        'quiet',
        'quiet',
    ]);
});

test('a bug that never failed in the window is all leading, never fixed', () => {
    // The degenerate case, and the honest reading of it: a resolved bug with no
    // annotation in the window has not been observed to stop failing here, so
    // colouring the whole row green would claim a fix this window cannot see.
    const empty: OccurrenceDay[] = [
        { date: '2026-09-11', count: 0 },
        { date: '2026-09-12', count: 0 },
    ];
    assert.deepEqual(zeroDayKinds(empty, true), ['leading', 'leading']);
    assert.deepEqual(zeroDayKinds(empty, false), ['leading', 'leading']);
});

test('a zero between two failing days on a resolved bug is fixed, deliberately', () => {
    // The ambiguous case the docstring names. It reads as `fixed`, which
    // slightly overstates the good news, because the alternative — greening only
    // a run that reaches the end of the window — makes the colour depend on
    // where the window happens to end, so the same bug would change colour
    // tomorrow with no new data.
    const spiky: OccurrenceDay[] = [
        { date: '2026-09-10', count: 4 },
        { date: '2026-09-11', count: 0 },
        { date: '2026-09-12', count: 9 },
    ];
    assert.deepEqual(zeroDayKinds(spiky, true), [null, 'fixed', null]);
});

test('a bug number links to Bugzilla', () => {
    // The `test.html` link moved to `site/test-link.ts`, shared with
    // `try.html` and `issues.html`; it builds a DOM element rather than a
    // string, so it is asserted on the page tests rather than here.
    assert.equal(bugUrl(2060167), 'https://bugzilla.mozilla.org/show_bug.cgi?id=2060167');
});

// --- the per-day series ---------------------------------------------------

test('a bug’s series spans the whole window, with zeros where it did not fail', () => {
    // The load-bearing property: a bug that stopped failing has trailing zeros
    // and a bug that started has leading ones, which is the new-versus-fixed
    // contrast the per-row chart exists for. Enumerating only the days that had
    // a row would draw both as the same short line.
    const perDay = new Map([
        ['2026-09-10', new Map([[111, 16]])],
        ['2026-09-11', new Map([[111, 32]])],
        ['2026-09-12', new Map([[222, 64]])],
    ]);
    const histories = historiesFromDays(perDay, { start: '2026-09-10', end: '2026-09-12' });

    assert.deepEqual(
        histories.get(111)!.map((day) => day.count),
        [16, 32, 0],
        'a bug that stopped: trailing zero'
    );
    assert.deepEqual(
        histories.get(222)!.map((day) => day.count),
        [0, 0, 64],
        'a bug that started: leading zeros'
    );
    // And the dates are the window's, in order, so two rows' charts line up.
    assert.deepEqual(
        histories.get(111)!.map((day) => day.date),
        ['2026-09-10', '2026-09-11', '2026-09-12']
    );
});

test('a day the API never answered for reads as zero, not as a missing point', () => {
    // `loadDays` skips a day whose request failed rather than failing the page.
    // The series still has an entry for it, so every row's chart has the same
    // number of points and the x axes stay comparable.
    const perDay = new Map([['2026-09-12', new Map([[111, 5]])]]);
    const histories = historiesFromDays(perDay, { start: '2026-09-10', end: '2026-09-12' });
    assert.deepEqual(
        histories.get(111)!.map((day) => day.count),
        [0, 0, 5]
    );
});

test('the overall volume counts every annotation, the no-bug group included', () => {
    const series = volumeSeries(
        new Map([
            ['2026-09-10', 2992],
            ['2026-09-11', 2518],
            ['2026-09-12', 422],
        ]),
        { start: '2026-09-10', end: '2026-09-12' }
    );
    assert.deepEqual(series.counts, [2992, 2518, 422]);
    assert.deepEqual(series.labels, ['09-10', '09-11', '09-12'], 'MM-DD per day');
    assert.deepEqual(series.dates, ['2026-09-10', '2026-09-11', '2026-09-12'], 'the full dates');

    // The volume figure beside the window dropdown is the total and nothing
    // else. The busiest-day sentence and the "sums to less than this" clause
    // that used to follow it were both cut on the page owner's verdict on the
    // paragraph they lived in: "blah blah".
    assert.equal(volumeLine(series), '5,932 annotations over 3 days');
});

test('the untriaged annotations stay reachable, in the figure’s tooltip', () => {
    // The no-bug population is the one thing the table cannot show, so dropping
    // the prose that named it must not drop the number. It moved into a tooltip
    // on the annotations figure, spelled out as a sentence -- the owner's
    // complaint about the old three-word version was "I have no idea what
    // '3,351 untriaged excluded' means, so I can't guess if it's useful".
    const tip = annotationsTooltip(coverage({ noBugCount: 3351 }));
    assert.match(tip, /3,351 annotations/);
    // The mechanism, not just the count: why they cannot be rows.
    assert.match(tip, /without attaching a bug/);
    assert.match(tip, /sums to less than this/);
});

test('a window where every annotation had a bug claims no exclusion', () => {
    // The tooltip must not say "includes 0 annotations where…", which reads as
    // a caveat about nothing. With nothing excluded the table is complete, and
    // saying so is the honest statement.
    const tip = annotationsTooltip(coverage({ noBugCount: 0 }));
    assert.match(tip, /accounts for all of them/);
    assert.doesNotMatch(tip, /\b0 annotations\b/);
});

test('the volume figure is the total alone when there were no annotations', () => {
    const series = volumeSeries(new Map(), { start: '2026-09-10', end: '2026-09-12' });
    assert.equal(volumeLine(series), '0 annotations over 3 days');
});

test('a day with no annotations is a zero, not a gap', () => {
    const series = volumeSeries(new Map([['2026-09-12', 10]]), {
        start: '2026-09-10',
        end: '2026-09-12',
    });
    assert.deepEqual(series.counts, [0, 0, 10]);
});

// --- URL state ------------------------------------------------------------

test('the hash carries the window, the harness and the tree', () => {
    const params = new URLSearchParams('date=7days&harness=xpcshell&tree=autoland');
    assert.deepEqual(readUrlState(params), {
        date: '7days',
        harness: 'xpcshell',
        tree: 'autoland',
    });
    assert.deepEqual(readUrlState(new URLSearchParams('')), {});
});

test('the hash always states the window, and omits the other two at default', () => {
    // `#date=21days` is the URL the owner pastes between pages, so it is written
    // even when it is the default. The other two are omitted, so a shared link
    // carries what the sender changed and nothing else.
    assert.deepEqual(writeUrlState({ date: '21days', harness: 'all', tree: DEFAULT_TREE }), {
        date: '21days',
    });
    assert.deepEqual(writeUrlState({ date: '7days', harness: 'xpcshell', tree: 'autoland' }), {
        date: '7days',
        harness: 'xpcshell',
        tree: 'autoland',
    });
    assert.equal(DEFAULT_TREE, 'trunk', 'the CLI’s default, and Treeherder’s own');
});
