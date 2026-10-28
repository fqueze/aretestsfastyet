/**
 * `site/manifests-view.ts` — the view model behind `site/manifests.html`.
 *
 * ## Where every expected value comes from
 *
 * This project's most expensive recurring mistake is a test whose expected
 * value is produced by the thing under test — eight occurrences, one of which
 * shipped a visibly wrong digit and two of which pinned bugs as correct. So
 * every number below comes from one of two places and **never** from
 * `manifests-view.ts`:
 *
 * 1. **A hand-authored file, `TINY`.** Four manifests over three job names,
 *    with the durations chosen so a reader can do the arithmetic in their head
 *    and — the part that matters — so that a *plausible wrong implementation
 *    gets a different number*. Specifically:
 *
 *    - `slow.toml` has an **even** run count on one job (4 runs), so the upper
 *      middle and the lower middle are different values. A test using a
 *      nearest-rank median gets 300 where this page gets 400.
 *    - `mixed.toml` has a pair with **some** zeros and some not, so an `any`
 *      reading of the all-zero rule drops runs an `every` reading keeps, and
 *      the Runs column changes.
 *    - `skipped.toml` is all-zero on **every** job, so it is the "no runtime at
 *      all" case: its median must be `null` and it must sort *last*, not first.
 *    - `fast.toml` has one job and one run, the degenerate case where median,
 *      mean, min and max coincide — so an implementation that confused them
 *      still has to get the other three manifests right.
 *
 * 2. **The checked-in `test/fixtures/manifests.json`**, walked a second,
 *    independent time inside the test — never through `buildManifestRows`.
 *
 * Each assertion was checked against "what wrong implementation still passes
 * this?", and the ones verified by actually breaking the code are listed in the
 * migration report.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ManifestsFile } from '../lib/formats/manifests.ts';
import { parseTaskId } from '../lib/formats/tables.ts';
import {
    type Filters,
    type ManifestRow,
    DEFAULT_SORT,
    ITEMS_PER_PAGE,
    NO_FILTERS,
    SORT_COLUMNS,
    buildManifestRows,
    chartElementId,
    errorSummaryUrl,
    filterJobs,
    filterRows,
    filtersToSearch,
    formatDuration,
    headlineStats,
    isSortColumn,
    jobKey,
    meanOf,
    medianOf,
    nextSort,
    pageSlice,
    pageState,
    parseFilters,
    profilerUrl,
    resourceProfileArtifactUrl,
    scatterPoints,
    sortRows,
    splitTaskId,
} from '../site/manifests-view.ts';

// =========================================================================
// The hand-authored file
// =========================================================================

/** Job names, short enough that the expectations stay readable. */
const JOBS = ['linux-opt', 'linux-debug', 'win-opt'] as const;
const MANIFESTS = ['slow.toml', 'mixed.toml', 'skipped.toml', 'fast.toml'] as const;

/**
 * A `manifests.json` written out by hand.
 *
 * The runs, in the order they appear in the file, so the arithmetic below can
 * be checked against this table directly:
 *
 * | manifest | job | durations |
 * | --- | --- | --- |
 * | `slow.toml` | `linux-opt` | 100, 200, 400, 800 — **even count** |
 * | `slow.toml` | `linux-debug` | 1000 |
 * | `mixed.toml` | `linux-opt` | 0, 60 — a pair with *some* zeros: it ran |
 * | `mixed.toml` | `win-opt` | 0, 0 — all zero: it was skipped here |
 * | `skipped.toml` | `linux-opt` | 0 |
 * | `skipped.toml` | `win-opt` | 0, 0 |
 * | `fast.toml` | `win-opt` | 50 |
 */
function tinyFile(): ManifestsFile {
    const runs: [manifest: number, job: number, task: number, duration: number][] = [
        [0, 0, 0, 100],
        [0, 0, 1, 200],
        [0, 0, 0, 400],
        [0, 0, 1, 800],
        [0, 1, 0, 1000],
        [1, 0, 0, 0],
        [1, 0, 1, 60],
        [1, 2, 0, 0],
        [1, 2, 1, 0],
        [2, 0, 0, 0],
        [2, 2, 0, 0],
        [2, 2, 1, 0],
        [3, 2, 0, 50],
    ];
    return {
        metadata: {
            date: '2026-08-04',
            repository: 'mozilla-central',
            generatedAt: '2026-08-05T03:06:21.278Z',
            processedJobCount: 7,
            failedJobCount: 1,
        },
        manifests: [...MANIFESTS],
        jobNames: [...JOBS],
        commits: ['abc123', 'def456'],
        prefixes: ['mochitest-plain', 'wpt'],
        tasks: {
            // One task carries a `.1` retry suffix, so `splitTaskId` has a real
            // case in the fixture rather than only in its own unit test.
            id: ['TASK0', 'TASK1.1'],
            jobName: [0, 1],
            commitId: [0, 1],
            prefix: [0, 1],
        },
        runs: {
            manifestIds: runs.map((run) => run[0]),
            jobNameIds: runs.map((run) => run[1]),
            taskIds: runs.map((run) => run[2]),
            durations: runs.map((run) => run[3]),
        },
    };
}

/** The rows, by manifest name. */
function tinyRows(): Map<string, ManifestRow> {
    return new Map(buildManifestRows(tinyFile()).map((row) => [row.manifest, row]));
}

// =========================================================================
// Aggregation
// =========================================================================

test('a pair whose durations are all zero is skipped, and one with any non-zero is not', () => {
    const rows = tinyRows();

    // `mixed.toml` on `linux-opt` is [0, 60]. `every` says it ran; `any` would
    // say it was skipped, and the two give different answers here by
    // construction. An `any` implementation reports runCount 0 for this
    // manifest and median null; this asserts the opposite of both.
    const mixed = rows.get('mixed.toml')!;
    const linuxOpt = mixed.jobStats.find((job) => job.jobName === 'linux-opt')!;
    assert.equal(linuxOpt.skipped, false, '[0, 60] ran: one duration is non-zero');
    assert.equal(linuxOpt.runCount, 2, 'both runs count, including the zero one');
    // Sorted [0, 60], upper middle of 2 is index 1.
    assert.equal(linuxOpt.median, 60);
    // (0 + 60) / 2.
    assert.equal(linuxOpt.mean, 30);

    // `mixed.toml` on `win-opt` is [0, 0]: every duration zero.
    const winOpt = mixed.jobStats.find((job) => job.jobName === 'win-opt')!;
    assert.equal(winOpt.skipped, true);
    assert.equal(winOpt.median, null, 'a skipped pair has no median, not a median of 0');
    assert.equal(winOpt.mean, null);
    // The run count is still reported: the pair has runs, they were all zero.
    assert.equal(winOpt.runCount, 2);
});

test('a skipped pair is excluded from the manifest total runs, jobs and pooled stats', () => {
    const mixed = tinyRows().get('mixed.toml')!;

    // Two pairs: `linux-opt` [0, 60] ran, `win-opt` [0, 0] did not.
    assert.equal(mixed.jobStats.length, 2, 'both pairs are listed as rows');
    // Only the pair that ran counts. Including the skipped pair would give 4.
    assert.equal(mixed.totalRuns, 2, 'the 2 runs of the skipped pair are excluded');
    // Only the pair that ran counts. Including it would give 2.
    assert.equal(mixed.totalJobs, 1, 'Job Types counts jobs it ran on');
    // Pooled over [0, 60] only. Pooling the skipped pair's zeros would give a
    // median of 0 and a mean of 15.
    assert.equal(mixed.overallMedian, 60);
    assert.equal(mixed.overallMean, 30);
    assert.equal(mixed.allSkipped, false);
});

test('a manifest skipped on every job has no runtime at all', () => {
    const skipped = tinyRows().get('skipped.toml')!;
    assert.equal(skipped.allSkipped, true);
    // `null`, not 0 — this is the value the sort has to keep off the top.
    assert.equal(skipped.overallMedian, null);
    assert.equal(skipped.overallMean, null);
    assert.equal(skipped.totalRuns, 0);
    assert.equal(skipped.totalJobs, 0);
    // The pairs are still listed, so a reader expanding it sees where it was
    // skipped rather than an empty row.
    assert.equal(skipped.jobStats.length, 2);
    assert.ok(skipped.jobStats.every((job) => job.skipped));
});

test('the median is the upper middle element, which differs from nearest-rank', () => {
    // `slow.toml` on `linux-opt` is [100, 200, 400, 800]: four values, so the
    // two middle ones are 200 and 400 and the rules disagree.
    const slow = tinyRows().get('slow.toml')!;
    const linuxOpt = slow.jobStats.find((job) => job.jobName === 'linux-opt')!;
    assert.equal(linuxOpt.median, 400, 'the upper middle; nearest-rank would give 200');
    // (100 + 200 + 400 + 800) / 4 = 1500 / 4.
    assert.equal(linuxOpt.mean, 375);

    // Pooled over both jobs: [100, 200, 400, 800, 1000], five values, upper
    // middle is index 2. An odd sample is where the two rules agree, so this
    // one does *not* distinguish them — which is why the even case above is
    // asserted separately.
    assert.equal(slow.overallMedian, 400);
    // 2500 / 5.
    assert.equal(slow.overallMean, 500);
    assert.equal(slow.totalRuns, 5);
    assert.equal(slow.totalJobs, 2);
});

test('medianOf takes the upper middle and does not reorder its argument', () => {
    // Spelled out on a literal array so the rule is pinned independently of any
    // fixture. Nearest-rank (`ceil(0.5n) - 1`) gives 50 on the first.
    assert.equal(medianOf([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]), 60);
    assert.equal(medianOf([1, 2, 3]), 2);
    assert.equal(medianOf([1, 2]), 2, 'two values: the upper one');
    assert.equal(medianOf([7]), 7);
    // Unsorted input, to prove it sorts rather than indexing the raw array:
    // index 1 of the raw array is 9, of the sorted array is 5.
    assert.equal(medianOf([9, 5, 1]), 5);

    const original = [3, 1, 2];
    medianOf(original);
    assert.deepEqual(original, [3, 1, 2], 'the caller keeps its order');
});

test('meanOf is the arithmetic mean', () => {
    assert.equal(meanOf([1, 2, 3, 4]), 2.5);
    assert.equal(meanOf([5]), 5);
    // A mean that ignored the zero would give 30 here.
    assert.equal(meanOf([0, 60]), 30);
});

test('jobs are ordered worst median first, with skipped ones last', () => {
    const rows = tinyRows();

    // `mixed.toml`: `linux-opt` ran (median 60), `win-opt` was skipped. The
    // skipped one must be second even though a `0` median would sort it first
    // under a descending comparison only if the sentinel were 0 rather than -1.
    assert.deepEqual(
        rows.get('mixed.toml')!.jobStats.map((job) => job.jobName),
        ['linux-opt', 'win-opt']
    );

    // `slow.toml`: `linux-debug` has median 1000, `linux-opt` has 400.
    assert.deepEqual(
        rows.get('slow.toml')!.jobStats.map((job) => job.jobName),
        ['linux-debug', 'linux-opt']
    );
});

test('a run point carries the task, commit and prefix its chart click needs', () => {
    const slow = tinyRows().get('slow.toml')!;
    const linuxOpt = slow.jobStats.find((job) => job.jobName === 'linux-opt')!;
    // Runs in file order: tasks 0, 1, 0, 1 with durations 100, 200, 400, 800.
    assert.deepEqual(
        linuxOpt.runs.map((run) => [run.duration, run.taskId, run.commit, run.prefix]),
        [
            [100, 'TASK0', 'abc123', 'mochitest-plain'],
            [200, 'TASK1.1', 'def456', 'wpt'],
            [400, 'TASK0', 'abc123', 'mochitest-plain'],
            [800, 'TASK1.1', 'def456', 'wpt'],
        ]
    );
});

test('buildManifestRows groups on the chunk-stripped job name, not the task name', () => {
    // `tasks.jobName` points at a *different* entry of the same table than
    // `runs.jobNameIds` does, which is the trap `FORMATS.md` measures at
    // 360,373 of 433,836 runs. Here task 0's jobName is `linux-opt` and task
    // 1's is `linux-debug`, while both tasks appear under `slow.toml`'s
    // `linux-opt` runs — so an implementation reading `tasks.jobName` would
    // split that one pair into two.
    const slow = tinyRows().get('slow.toml')!;
    const linuxOpt = slow.jobStats.find((job) => job.jobName === 'linux-opt')!;
    assert.equal(linuxOpt.runCount, 4, 'one pair, not one per task');
    assert.equal(slow.jobStats.length, 2, 'two jobs, from runs.jobNameIds');
});

test('buildManifestRows throws when the runs arrays are not parallel', () => {
    const file = tinyFile();
    file.runs.taskIds = file.runs.taskIds.slice(0, 3);
    // A misattributed duration produces a plausible, wrong ranking, which is
    // worse than a failure.
    assert.throws(() => buildManifestRows(file), /not parallel/);
});

// =========================================================================
// Sorting
// =========================================================================

/** The four rows of `TINY`, unsorted. */
function tinyList(): ManifestRow[] {
    return buildManifestRows(tinyFile());
}

test('the default sort is median descending, slowest first', () => {
    assert.deepEqual(DEFAULT_SORT, { column: 'median', ascending: false });
});

test('a manifest that ran nowhere sorts last under either direction', () => {
    const rows = tinyList();

    // Descending median: slow (400), mixed (60), fast (50), skipped (none).
    assert.deepEqual(
        sortRows(rows, { column: 'median', ascending: false }).map((row) => row.manifest),
        ['slow.toml', 'mixed.toml', 'fast.toml', 'skipped.toml']
    );

    // Ascending median: the three that ran, cheapest first — and `skipped.toml`
    // is **still last**. This is the assertion that fails if the sentinel is 0
    // rather than -1, and it is the whole of the first-paint defect: with a 0
    // sentinel this reads `skipped.toml` first.
    assert.deepEqual(
        sortRows(rows, { column: 'median', ascending: true }).map((row) => row.manifest),
        ['fast.toml', 'mixed.toml', 'slow.toml', 'skipped.toml']
    );

    // The same for mean, which has the same absent case: means are 500, 30, 50.
    assert.deepEqual(
        sortRows(rows, { column: 'mean', ascending: true }).map((row) => row.manifest),
        ['mixed.toml', 'fast.toml', 'slow.toml', 'skipped.toml']
    );
});

test('every column sorts, in both directions', () => {
    const rows = tinyList();
    // Independently derived from the table in `tinyFile`'s comment:
    // totalRuns  — slow 5, mixed 2, fast 1, skipped 0
    // totalJobs  — slow 2, mixed 1, fast 1, skipped 0
    assert.deepEqual(
        sortRows(rows, { column: 'runs', ascending: false }).map((row) => row.totalRuns),
        [5, 2, 1, 0]
    );
    assert.deepEqual(
        sortRows(rows, { column: 'runs', ascending: true }).map((row) => row.totalRuns),
        [0, 1, 2, 5]
    );
    assert.deepEqual(
        sortRows(rows, { column: 'jobTypes', ascending: false }).map((row) => row.totalJobs),
        [2, 1, 1, 0]
    );

    // `manifest` sorts by name, so descending is Z→A. Alphabetically:
    // fast, mixed, skipped, slow.
    assert.deepEqual(
        sortRows(rows, { column: 'manifest', ascending: true }).map((row) => row.manifest),
        ['fast.toml', 'mixed.toml', 'skipped.toml', 'slow.toml']
    );
    assert.deepEqual(
        sortRows(rows, { column: 'manifest', ascending: false }).map((row) => row.manifest),
        ['slow.toml', 'skipped.toml', 'mixed.toml', 'fast.toml']
    );
});

test('sortRows returns a new array and leaves its argument alone', () => {
    const rows = tinyList();
    const before = rows.map((row) => row.manifest);
    const sorted = sortRows(rows, { column: 'manifest', ascending: true });
    assert.notEqual(sorted, rows);
    assert.deepEqual(rows.map((row) => row.manifest), before);
});

test('clicking the active column toggles, and another column starts descending', () => {
    // `old/manifests.html:487-493`, including the part a reader might not expect:
    // even `manifest` starts descending, i.e. Z→A on the first click.
    assert.deepEqual(nextSort({ column: 'median', ascending: false }, 'median'), {
        column: 'median',
        ascending: true,
    });
    assert.deepEqual(nextSort({ column: 'median', ascending: true }, 'median'), {
        column: 'median',
        ascending: false,
    });
    assert.deepEqual(nextSort({ column: 'median', ascending: true }, 'runs'), {
        column: 'runs',
        ascending: false,
    });
    assert.deepEqual(nextSort({ column: 'runs', ascending: false }, 'manifest'), {
        column: 'manifest',
        ascending: false,
    });
});

test('the sortable columns are the five header cells, in header order', () => {
    // The order is `updateSortIndicators`' column map (`old/manifests.html:522-528`)
    // and it is what maps a header index to a column, so a reordering here
    // silently sorts by the wrong column.
    assert.deepEqual(SORT_COLUMNS, ['manifest', 'jobTypes', 'runs', 'median', 'mean']);
    for (const column of SORT_COLUMNS) {
        assert.ok(isSortColumn(column));
    }
    assert.equal(isSortColumn('p95'), false, "the CLI's columns are not this page's");
    assert.equal(isSortColumn(''), false);
});

// =========================================================================
// Filtering
// =========================================================================

test('the manifest box matches the path and the job box matches jobs under it', () => {
    const rows = tinyList();

    // `q` alone: substring of the manifest path, case-insensitive.
    assert.deepEqual(
        filterRows(rows, { manifest: 'SLOW', job: '' }).map((row) => row.manifest),
        ['slow.toml']
    );
    // The important half: rows that do *not* match must disappear. A filter
    // that returned everything would pass an assertion naming only the kept
    // row, which is the trap that let a search filter be deleted with every
    // test green.
    assert.equal(filterRows(rows, { manifest: 'slow', job: '' }).length, 1);
    assert.equal(filterRows(rows, { manifest: 'toml', job: '' }).length, 4, 'all four match');
    assert.equal(filterRows(rows, { manifest: 'nothing-here', job: '' }).length, 0);

    // `job` alone: keeps a manifest if *any* of its jobs matches. `win-opt`
    // runs `mixed.toml`, `skipped.toml` and `fast.toml`, but not `slow.toml`.
    assert.deepEqual(
        filterRows(rows, { manifest: '', job: 'win' }).map((row) => row.manifest).sort(),
        ['fast.toml', 'mixed.toml', 'skipped.toml']
    );
    // `linux-debug` runs only `slow.toml`.
    assert.deepEqual(
        filterRows(rows, { manifest: '', job: 'debug' }).map((row) => row.manifest),
        ['slow.toml']
    );

    // Both: the intersection, not the union. `slow.toml` matches `q=slow` but
    // has no `win` job, so the result is empty — a union would return three.
    assert.equal(filterRows(rows, { manifest: 'slow', job: 'win' }).length, 0);
    assert.deepEqual(
        filterRows(rows, { manifest: 'mixed', job: 'win' }).map((row) => row.manifest),
        ['mixed.toml']
    );

    // Empty boxes keep everything.
    assert.equal(filterRows(rows, NO_FILTERS).length, 4);
});

test('a row kept by the job filter keeps its unfiltered numbers', () => {
    // The search never rewrites a count. `mixed.toml` under `job=win` still
    // reports the runs and median of the job it *ran* on, which is `linux-opt`
    // — the job that did not match.
    const [row] = filterRows(tinyList(), { manifest: '', job: 'win' }).filter(
        (candidate) => candidate.manifest === 'mixed.toml'
    );
    assert.equal(row!.totalRuns, 2);
    assert.equal(row!.overallMedian, 60);
    assert.equal(row!.jobStats.length, 2, 'the row still carries both jobs');
});

test('the job filter narrows the sub-rows of an expanded manifest', () => {
    const mixed = tinyRows().get('mixed.toml')!;
    // Unfiltered: both jobs.
    assert.equal(filterJobs(mixed, NO_FILTERS).length, 2);
    // Filtered: only the matching one, and it is the *right* one.
    assert.deepEqual(
        filterJobs(mixed, { manifest: '', job: 'win' }).map((job) => job.jobName),
        ['win-opt']
    );
    // A needle matching nothing empties the subtree rather than showing it all.
    assert.equal(filterJobs(mixed, { manifest: '', job: 'android' }).length, 0);
    // The manifest needle does not apply here: the row is already selected.
    assert.equal(filterJobs(mixed, { manifest: 'nothing', job: '' }).length, 2);
});

// =========================================================================
// Pagination
// =========================================================================

test('pages hold 50 rows and the pager counts them', () => {
    assert.equal(ITEMS_PER_PAGE, 50);

    // 125 pages for 6,227 rows is the pinned file's shape; 101 rows is the
    // smallest case where the last page is short.
    assert.deepEqual(pageState(101, 1), {
        page: 1,
        totalPages: 3,
        prevDisabled: true,
        nextDisabled: false,
        label: 'Page 1 of 3',
    });
    assert.deepEqual(pageState(101, 3), {
        page: 3,
        totalPages: 3,
        prevDisabled: false,
        nextDisabled: true,
        label: 'Page 3 of 3',
    });
    assert.equal(pageState(100, 1).totalPages, 2, 'exactly two full pages');
    assert.equal(pageState(50, 1).totalPages, 1);
    assert.equal(pageState(51, 1).totalPages, 2);
});

test('an empty result disables Next rather than leaving it enabled and inert', () => {
    // Divergence 3. Upstream's `currentPage === totalPages` is `1 === 0`, so
    // Next stays enabled and clicking it does nothing — measured in Chrome.
    const pager = pageState(0, 1);
    assert.equal(pager.totalPages, 0);
    assert.equal(pager.nextDisabled, true, 'a control that does nothing is disabled');
    assert.equal(pager.prevDisabled, true);
    // The text is upstream's, unchanged.
    assert.equal(pager.label, 'Page 1 of 0');
});

test('pageSlice takes the right 50 rows', () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({ manifest: `m${index}` }) as ManifestRow);
    assert.equal(pageSlice(rows, 1).length, 50);
    assert.equal(pageSlice(rows, 1)[0]!.manifest, 'm0');
    assert.equal(pageSlice(rows, 2)[0]!.manifest, 'm50', 'page 2 starts at index 50');
    assert.equal(pageSlice(rows, 3).length, 20, 'the last page is short');
    assert.equal(pageSlice(rows, 3)[0]!.manifest, 'm100');
    assert.equal(pageSlice(rows, 4).length, 0, 'past the end is empty, not an error');
});

// =========================================================================
// URL state
// =========================================================================

test('the URL carries the two searches and nothing else', () => {
    assert.deepEqual(parseFilters(''), { manifest: '', job: '' });
    assert.deepEqual(parseFilters('?q=browser'), { manifest: 'browser', job: '' });
    assert.deepEqual(parseFilters('?job=wdspec'), { manifest: '', job: 'wdspec' });
    assert.deepEqual(parseFilters('?q=a&job=b'), { manifest: 'a', job: 'b' });
    // Sort, direction and page are not URL state, so a URL carrying them is
    // read as if they were absent rather than honoured.
    assert.deepEqual(parseFilters('?sort=runs&page=3'), { manifest: '', job: '' });
    // An explicitly empty parameter is the same as an absent one.
    assert.deepEqual(parseFilters('?q=&job='), { manifest: '', job: '' });
});

test('an empty box deletes its parameter rather than writing an empty value', () => {
    assert.equal(filtersToSearch('', { manifest: 'browser', job: '' }), '?q=browser');
    assert.equal(filtersToSearch('', { manifest: '', job: 'wdspec' }), '?job=wdspec');
    assert.equal(filtersToSearch('', { manifest: 'a', job: 'b' }), '?q=a&job=b');
    // Clearing leaves no trace, so the URL is the same as a fresh load's.
    assert.equal(filtersToSearch('?q=browser', NO_FILTERS), '');
    assert.equal(filtersToSearch('?q=browser&job=wd', { manifest: '', job: 'wd' }), '?job=wd');

    // An unrelated parameter survives: `?data-source=` and `?profiler=` are
    // read by the shared scripts, and dropping one would change where the page
    // fetches from mid-session.
    assert.equal(
        filtersToSearch('?data-source=try', { manifest: 'x', job: '' }),
        '?data-source=try&q=x'
    );
    assert.equal(filtersToSearch('?data-source=try', NO_FILTERS), '?data-source=try');
});

test('the searches round-trip through the URL', () => {
    for (const filters of [
        { manifest: 'browser', job: '' },
        { manifest: '', job: 'wdspec' },
        { manifest: 'dom/media', job: 'linux' },
        // The characters a query string has to escape, in both boxes.
        { manifest: 'a b&c=d', job: 'e+f%g' },
        NO_FILTERS,
    ] satisfies Filters[]) {
        assert.deepEqual(parseFilters(filtersToSearch('', filters)), filters);
    }
});

// =========================================================================
// Formatting and identifiers
// =========================================================================

test('formatDuration matches the page, floored minutes and no hour form', () => {
    assert.equal(formatDuration(0), '0ms');
    assert.equal(formatDuration(999), '999ms');
    assert.equal(formatDuration(999.6), '1000ms', 'rounded, and still the ms branch');
    assert.equal(formatDuration(1000), '1.0s');
    assert.equal(formatDuration(59_999), '60.0s', 'just under a minute is still seconds');
    assert.equal(formatDuration(60_000), '1m 0s');
    // Floored, not rounded: 1m 59.9s reads as `1m 59s`. This is the page's
    // behaviour and the CLI's differs; divergence 9.
    assert.equal(formatDuration(119_900), '1m 59s');
    // No hour form: two hours is 120 minutes.
    assert.equal(formatDuration(7_200_000), '120m 0s');
});

test('jobKey joins the two names with the separator the page uses', () => {
    assert.equal(jobKey('dom/media/test.toml', 'linux-opt'), 'dom/media/test.toml|||linux-opt');

    // The key is **not** injective in general: a name containing the separator
    // makes two different pairs build the same key, and this asserts that
    // rather than pretending otherwise.
    assert.equal(jobKey('a', 'b|||c'), jobKey('a|||b', 'c'));

    // It is unreachable on the real data, and this is the measurement rather
    // than the claim: on the pinned 2026-08-04 file **0 of 6,227** manifest
    // paths and **0 of 4,165** job names contain even a single `|`, and the
    // fixture below has none either. Upstream uses the same separator
    // (`old/manifests.html:625`), so changing it here would be a difference with no
    // observable effect on any input either page can be given.
    const names = [...FIXTURE.manifests, ...FIXTURE.jobNames];
    assert.equal(names.filter((name) => name.includes('|')).length, 0);
});

test('the chart id slugs everything outside [a-z0-9]', () => {
    assert.equal(chartElementId('dom/media/test.toml', 'linux-opt'), 'chart-dom-media-test-toml-linux-opt');
    // Case is preserved — the regex is `gi`, so uppercase letters are *kept*,
    // not replaced. An implementation dropping the `i` flag would mangle them.
    assert.equal(chartElementId('DOM/Media', 'Linux'), 'chart-DOM-Media-Linux');
    // The collision the id scheme allows, spelled out: two different manifests
    // produce the same id. Two of the pinned file's 6,227 names do this.
    assert.equal(chartElementId('a/b', 'j'), chartElementId('a.b', 'j'));
});

test('splitTaskId separates the retry, defaulting to run 0', () => {
    assert.deepEqual(splitTaskId('ABC123'), { baseTaskId: 'ABC123', retryId: '0' });
    assert.deepEqual(splitTaskId('ABC123.1'), { baseTaskId: 'ABC123', retryId: '1' });
    assert.deepEqual(splitTaskId('ABC123.12'), { baseTaskId: 'ABC123', retryId: '12' });
});

test('splitTaskId agrees with parseTaskId on the inputs the two used to differ on', () => {
    // The two implementations disagreed on exactly these shapes: the old
    // `split('.')` took the *first* dot and never checked the suffix, so
    // `abc.1.2` was run 1 and `abc.def` was run "def" — a URL that 404s. Both
    // shapes are absent from the data (0 of 12,771 ids measured), so this
    // pins the behaviour rather than reporting a fixed bug.
    for (const raw of ['abc.1.2', 'abc.def', 'abc.', 'abc.0.0', 'a.b.c.3']) {
        const parsed = parseTaskId(raw);
        assert.deepEqual(
            splitTaskId(raw),
            { baseTaskId: parsed.taskId, retryId: String(parsed.retryId) },
            `splitTaskId and parseTaskId disagree on ${raw}`
        );
    }
    // Spelled out, so the assertion above cannot pass by both being wrong the
    // same way: the retry is the LAST dot's suffix, and only when it is digits.
    assert.deepEqual(splitTaskId('abc.1.2'), { baseTaskId: 'abc.1', retryId: '2' });
    assert.deepEqual(splitTaskId('abc.def'), { baseTaskId: 'abc.def', retryId: '0' });
    assert.deepEqual(splitTaskId('abc.'), { baseTaskId: 'abc.', retryId: '0' });
});

test('the two artifact URLs put the retry in the path, not in the task id', () => {
    const base = 'https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task';
    assert.equal(
        resourceProfileArtifactUrl('ABC.2', '2026-10-28'),
        `${base}/ABC/runs/2/artifacts/public/profile_run-task-resource-usage.json`
    );
    assert.equal(
        resourceProfileArtifactUrl('ABC', '2026-10-27'),
        `${base}/ABC/runs/0/artifacts/public/test_info/profile_resource-usage.json`
    );
    // The prefix names the harness family, so the log file differs per family.
    assert.equal(
        errorSummaryUrl('ABC.1', 'wpt'),
        `${base}/ABC/runs/1/artifacts/public/test_info/wpt_errorsummary.log`
    );
    assert.equal(
        errorSummaryUrl('ABC', 'mochitest-plain'),
        `${base}/ABC/runs/0/artifacts/public/test_info/mochitest-plain_errorsummary.log`
    );
});

test('the profiler URL focuses the profile on the manifest', () => {
    const url = new URL(profilerUrl('https://profiler.firefox.com', 'ABC', 'dom/media/x.toml', 'linux-opt', '2026-10-28'));
    assert.equal(url.origin, 'https://profiler.firefox.com');
    // The raw artifact is the path segment after `/from-url/`, encoded once.
    assert.equal(
        decodeURIComponent(url.pathname.replace('/from-url/', '')),
        resourceProfileArtifactUrl('ABC', '2026-10-28')
    );
    assert.equal(url.searchParams.get('profileName'), 'linux-opt (ABC)');
    // The whole point of the link: the profile opens with the manifest's
    // markers selected rather than the job's.
    assert.equal(url.searchParams.get('markerSearch'), 'dom/media/x.toml');

    // `?profiler=` is honoured through the origin the caller passes in.
    assert.ok(profilerUrl('http://localhost:4242', 'A', 'm', 'j', '2026-10-28').startsWith('http://localhost:4242/'));
});

// =========================================================================
// The chart series
// =========================================================================

test('the scatter x axis is position in the file, not a date', () => {
    const slow = tinyRows().get('slow.toml')!;
    const linuxOpt = slow.jobStats.find((job) => job.jobName === 'linux-opt')!;
    const points = scatterPoints(linuxOpt);
    // 1-based, in the order the file holds the runs — *not* sorted by duration,
    // which is the plausible wrong implementation: sorting would give
    // y = [100, 200, 400, 800] here too, so the durations are deliberately
    // already ascending in the file and the *task ids* are what distinguishes
    // the two orders. Asserted below.
    assert.deepEqual(points.map((point) => point.x), [1, 2, 3, 4]);
    assert.deepEqual(points.map((point) => point.y), [100, 200, 400, 800]);
    assert.deepEqual(points.map((point) => point.taskId), ['TASK0', 'TASK1.1', 'TASK0', 'TASK1.1']);
    assert.deepEqual(
        points.map((point) => point.prefix),
        ['mochitest-plain', 'wpt', 'mochitest-plain', 'wpt']
    );
});

test('a skipped pair still gets a series, of zeros', () => {
    // Expanding a skipped job draws a flat line at zero rather than nothing:
    // the pair has runs, and they were all zero. Upstream does the same.
    const mixed = tinyRows().get('mixed.toml')!;
    const winOpt = mixed.jobStats.find((job) => job.jobName === 'win-opt')!;
    assert.deepEqual(scatterPoints(winOpt), [
        { x: 1, y: 0, taskId: 'TASK0', prefix: 'mochitest-plain' },
        { x: 2, y: 0, taskId: 'TASK1.1', prefix: 'wpt' },
    ]);
});

// =========================================================================
// The headline stats
// =========================================================================

test('the stat cards are raw table lengths, decoupled from the rows', () => {
    const file = tinyFile();
    const stats = headlineStats(file);
    // 4 manifests, 3 job names, 13 runs — counted off `tinyFile`'s table, not
    // off the rows. The rows would say 4 manifests, but only 6 runs on pairs
    // that ran and 2 distinct jobs that ran.
    assert.deepEqual(stats, { manifests: 4, jobs: 3, runs: 13, date: '2026-08-04' });

    // The decoupling, stated as an assertion rather than as a comment: the
    // three that ran hold 5 + 2 + 1 = 8 runs between them, and the card says 13.
    const rows = buildManifestRows(file);
    assert.equal(
        rows.reduce((sum, row) => sum + row.totalRuns, 0),
        8
    );
    assert.notEqual(stats.runs, 8, 'the card counts skipped runs the table excludes');
});

test('a file with no date shows Unknown', () => {
    const file = tinyFile();
    file.metadata.date = '';
    assert.equal(headlineStats(file).date, 'Unknown');
});

/**
 * The last index matching a predicate.
 *
 * `Array.prototype.findLastIndex` is ES2023 and this project targets ES2022
 * (`tsconfig.json`), so it is spelled out rather than widening the lib for
 * three call sites in one test file.
 */
function lastIndexWhere<T>(list: readonly T[], matches: (item: T) => boolean): number {
    for (let i = list.length - 1; i >= 0; i--) {
        if (matches(list[i]!)) {
            return i;
        }
    }
    return -1;
}

// =========================================================================
// The real fixture, walked independently
// =========================================================================

const FIXTURE = JSON.parse(
    readFileSync(new URL('./fixtures/manifests.json', import.meta.url), 'utf8')
) as ManifestsFile;

test('the fixture aggregates to what a second, independent walk says', () => {
    // This walk is written here, not imported: it is the check that
    // `buildManifestRows` groups and classifies the way the old page does, and
    // borrowing the implementation would make it check nothing.
    const pairs = new Map<string, number[]>();
    for (let i = 0; i < FIXTURE.runs.durations.length; i++) {
        const manifest = FIXTURE.manifests[FIXTURE.runs.manifestIds[i]!]!;
        const job = FIXTURE.jobNames[FIXTURE.runs.jobNameIds[i]!]!;
        const key = `${manifest}${job}`;
        const existing = pairs.get(key);
        if (existing === undefined) {
            pairs.set(key, [FIXTURE.runs.durations[i]!]);
        } else {
            existing.push(FIXTURE.runs.durations[i]!);
        }
    }
    const expectedManifests = new Set([...pairs.keys()].map((key) => key.split('')[0]!));
    const expectedSkippedPairs = [...pairs.values()].filter((durations) =>
        durations.every((duration) => duration === 0)
    ).length;

    const rows = buildManifestRows(FIXTURE);
    assert.equal(rows.length, expectedManifests.size);
    assert.equal(
        rows.reduce((sum, row) => sum + row.jobStats.length, 0),
        pairs.size,
        'every (manifest, job) pair is one sub-row'
    );
    assert.equal(
        rows.reduce((sum, row) => sum + row.jobStats.filter((job) => job.skipped).length, 0),
        expectedSkippedPairs
    );

    // The fixture's own numbers, so a regenerated fixture fails loudly rather
    // than comparing a different file: 200 runs over 200 manifests, 18 zeros.
    assert.equal(FIXTURE.runs.durations.length, 200);
    assert.equal(FIXTURE.runs.durations.filter((duration) => duration === 0).length, 18);
    assert.equal(FIXTURE.metadata.date, '2026-08-03');
});

test('every fixture row has a median that is one of its own durations', () => {
    // A property rather than a value: an interpolating median would produce a
    // number that is not in the sample, and would pass any assertion that only
    // checked the ordering.
    for (const row of buildManifestRows(FIXTURE)) {
        for (const job of row.jobStats) {
            if (job.skipped) {
                assert.equal(job.median, null);
                continue;
            }
            const durations = job.runs.map((run) => run.duration);
            assert.ok(
                durations.includes(job.median!),
                `${row.manifest} / ${job.jobName}: median ${job.median} is not a sample`
            );
            // And the mean is within the range, which an off-by-one sum is not.
            assert.ok(job.mean! >= Math.min(...durations) && job.mean! <= Math.max(...durations));
        }
    }
});

test('the fixture sorts with no manifest that ran nowhere ahead of one that ran', () => {
    const rows = buildManifestRows(FIXTURE);
    for (const ascending of [true, false]) {
        const sorted = sortRows(rows, { column: 'median', ascending });
        const lastThatRan = lastIndexWhere(sorted, (row) => !row.allSkipped);
        const firstSkipped = sorted.findIndex((row) => row.allSkipped);
        if (firstSkipped !== -1) {
            assert.ok(
                firstSkipped > lastThatRan,
                `ascending=${ascending}: a skipped manifest is at ${firstSkipped}, ` +
                    `ahead of a manifest that ran at ${lastThatRan}`
            );
        }
    }
});
