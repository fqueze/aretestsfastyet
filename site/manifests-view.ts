/**
 * `manifests.html`'s **view model**: every decision the page makes, as plain
 * values, with no DOM.
 *
 * ## Why this page does not use `site/drilldown-view.ts`
 *
 * The brief asked for this judgement rather than an assumption either way, so
 * it is written out. The two are **not** the same shape:
 *
 * | | crashes / failures | manifests |
 * | --- | --- | --- |
 * | levels | key → dirPath → test → occurrence, **4** | manifest → job → **chart**, 3 |
 * | what a row *is* | a signature / a message | one **manifest path** |
 * | the middle level | a **directory**, with a collapse rule when it holds one test | one **job name**, no path structure and nothing to collapse |
 * | the leaf | one run, as a **table row** | **not a row at all** — one `<td colspan=5>` holding a per-run Plotly scatter |
 * | ranking | `count` or `tests`, count-like integers | `median` / `mean` **durations**, plus `manifest`, `jobTypes`, `runs` |
 * | what the numbers are | occurrence counts | **duration statistics with an absent case** — a manifest that ran nowhere has no median, and must not read as zero |
 * | the search | one box, drops or rewrites rows | **two boxes**, and the second filters the *sub-rows* of an expanded row as well as the top level |
 * | paging | none; the list is virtualized | **fixed 50 per page**, with Previous/Next |
 * | expansion state | a set of keys | two sets — manifests, and `manifest\|\|\|job` pairs |
 *
 * The decisive one is the leaf. `drilldown-view.ts`'s bottom level is an
 * `Occurrence` that becomes a table row, and this page's bottom level is a
 * chart: there is no per-run row here at all, and `Occurrence` carries
 * `minidump`, a component and a task link that a scatter point does not want.
 * Serving both would mean a `SubRow` member that renders as a `colspan` cell,
 * a `GroupRow` gaining a nullable `median`, a nullable `mean` and an
 * `allSkipped` flag, an always-single synthetic `PathNode` level, and a second
 * search string threaded through `filterGroupsByMatch`. That is the "three new
 * booleans" signal the brief names, and `site/errors-view.ts` declined for
 * less.
 *
 * What *is* reused: `site/drilldown-render.ts`'s DOM primitives (`el`,
 * `noData`) and its `declare global` block for the shared scripts — genuinely
 * page-independent, and the escaping question is answered once at `el()`.
 *
 * ## Why the page's own aggregation, and not `lib/query/manifest-stats.ts`
 *
 * `computeManifestStats` answers this question for the CLI and is the
 * comparison target in `test/manifests-parity.test.ts`. The page does **not**
 * call it, and the reason is a measured disagreement rather than a preference:
 *
 * - **The median rule differs, on half the corpus.** The page takes the
 *   **upper** middle element (`old/manifests.html:429`, `:455`:
 *   `sorted[Math.floor(n / 2)]`); `summarize` takes the nearest-rank quantile
 *   (`lib/query/manifest-stats.ts:302-305`: `ceil(0.5n) - 1`), which is the
 *   **lower** middle. They agree on every odd-length sample and differ on every
 *   even-length one. Measured on the pinned 2026-08-04 file: the two rules give
 *   a different median on **3,122 of 6,227 manifests**, and on `[10 … 100]`
 *   they give 60 and 50. `test/step5-query.test.ts:401` pins the CLI's rule
 *   deliberately, so this is two intended rules, not a bug in one of them.
 * - **`mean` exists here and nowhere in `lib/`.** `DurationStats` has `min`,
 *   `median`, `p95`, `max` and `total` and no mean; this page's fifth column is
 *   a mean, and adding one to `DurationStats` for a field only this page reads
 *   is the wrong direction.
 * - **The page has no `p95`, `max`, `total`, `os` or `platforms`,** and pooling
 *   `platforms` per manifest costs a `parseJobName` per configuration —
 *   173,875 pairs on the pinned file — for a column that does not exist here.
 * - **The row unit differs at the job level.** The page groups sub-rows by
 *   `runs.jobNameIds` (`old/manifests.html:376`, `:382`) and so does
 *   `computeManifestStats`; both use the chunk-stripped name, so this one
 *   agrees — recorded because it is the trap `FORMATS.md` measures at 360,373
 *   of 433,836 runs, and agreement here is a fact worth pinning rather than
 *   assuming.
 *
 * So the seam is the one `PARITY.md` §5 wants: two implementations of the same
 * question, compared against each other, rather than one wrapping the other
 * and making the comparison vacuous. What *is* shared is the rule that matters
 * most — the all-zero-durations rule — and the parity test asserts that both
 * sides classify the identical set of pairs as skipped.
 *
 * ## The all-zero-durations rule, and where it changes a number
 *
 * A (manifest, job) pair whose durations are **all** zero was skipped there,
 * not run instantly (`old/manifests.html:416`). `every`, not `any`. Such a pair is
 * excluded from `totalRuns` (`:441`), from the pooled runtimes (`:442`) and
 * from `totalJobs` (`:461`) — so a manifest's Runs column counts runs on
 * configs where it *ran*, and its Job Types column counts configs where it
 * ran. Measured on the pinned 2026-08-04 file: 78,957 of 494,380 runs are zero
 * (16.0%), and 26,932 of 173,875 (manifest, job) pairs are skipped.
 *
 * A manifest skipped on *every* job it appears on has no runtime at all —
 * `durations` is `null` here and `SKIP` on the page — and there are **302** of
 * them. They must sort **last**, not first; see `DEFAULT_SORT` for the bug that
 * fell out of getting that wrong.
 *
 * ## This file must stay DOM-free
 *
 * Enforced the same way as `site/errors-view.ts`: `test/manifests-view.test.ts`
 * imports it, the root `tsconfig.json` compiles `test/**`, and the root project
 * has no DOM lib. A `document` reach fails `npm run typecheck`.
 */

import type { ManifestsFile } from '../lib/formats/manifests.ts';
import { parseTaskId } from '../lib/formats/tables.ts';
import { resourceUsageProfileUrl } from '../lib/links.ts';

// --- the rows -------------------------------------------------------------

/**
 * One run of one manifest on one job: a point in the third-level scatter.
 *
 * Field-for-field what the old page pushes at `old/manifests.html:398-403`. The
 * `commit` is carried because the old page carries it into `customdata`
 * (`:777`) — nothing reads it back today, and it is kept rather than dropped so
 * that the hover template stays a presentation choice rather than a data one.
 */
export interface ManifestRunPoint {
    /** Milliseconds. Zero here is a real zero within a pair that ran. */
    duration: number;
    /** The bare task ID — this family carries no `.<retry>` suffix on most. */
    taskId: string;
    commit: string;
    /** The harness family, for the error-summary artifact name. */
    prefix: string;
}

/** One (manifest, job) pair: a child row under a manifest. */
export interface JobStats {
    jobName: string;
    runs: ManifestRunPoint[];
    /** Every run, skipped ones included — the page shows this even on a skip. */
    runCount: number;
    /**
     * `null` when `skipped`, and that is the point: a skipped pair has no
     * runtime, and a zero would make it the fastest row in the table.
     *
     * The old page stores `0` here and guards every read with `skipped`
     * (`old/manifests.html:424-425`, `:719-727`). A nullable field makes the guard
     * the type system's job instead — a renderer that forgot it does not
     * compile, where upstream would print `0ms`.
     */
    median: number | null;
    mean: number | null;
    /** Every duration was zero: it did not run here. `old/manifests.html:416`. */
    skipped: boolean;
}

/** One manifest path: a top-level row. */
export interface ManifestRow {
    manifest: string;
    /** Jobs, worst median first, skipped ones last. */
    jobStats: JobStats[];
    /** Jobs where it **ran**. Skipped pairs are excluded (`:461`). */
    totalJobs: number;
    /** Runs on jobs where it ran. Skipped pairs are excluded (`:441`). */
    totalRuns: number;
    /** Pooled over every job where it ran; `null` when it ran nowhere. */
    overallMedian: number | null;
    overallMean: number | null;
    /** Skipped on every job it appears on: 302 of 6,227 on the pinned file. */
    allSkipped: boolean;
}

// --- the controls ---------------------------------------------------------

/** The sortable columns, in the order the header cells appear. */
export type SortColumn = 'manifest' | 'jobTypes' | 'runs' | 'median' | 'mean';

/** The header order, which is also `updateSortIndicators`' column map (`:522-528`). */
export const SORT_COLUMNS: readonly SortColumn[] = [
    'manifest',
    'jobTypes',
    'runs',
    'median',
    'mean',
];

/** Whether a string names a sortable column. */
export function isSortColumn(value: string): value is SortColumn {
    return (SORT_COLUMNS as readonly string[]).includes(value);
}

/** A sort: which column, and which way. */
export interface SortState {
    column: SortColumn;
    ascending: boolean;
}

/**
 * The sort the page opens on: **median, descending** — slowest manifest first.
 *
 * This is what `old/manifests.html:360-361` declares, and it is **not** what that
 * page renders. `loadData()` finishes by calling `filterManifests()` (`:909`),
 * which calls `sortBy(currentSortColumn)` (`:611`) with the column that is
 * already selected, which takes the toggle branch (`:488-490`) and flips the
 * direction. So the old page's first paint is median *ascending*.
 *
 * **Measured in Chrome on the pinned 2026-08-04 file:** the Median header
 * renders `▲` on first paint, and **all 50 rows of page 1 read `SKIP`** — the
 * 302 manifests that ran nowhere have no median, sort as 0 under an ascending
 * comparison, and fill the first six pages. A reader opening the page to find
 * the manifest eating a job's time budget is shown seven pages of manifests
 * that did not run.
 *
 * Fixed here rather than reproduced; the reasoning and the measurement are in
 * `site/manifests.ts`'s divergence 1.
 */
export const DEFAULT_SORT: SortState = { column: 'median', ascending: false };

/** Rows per page. `old/manifests.html:359`, and not configurable there or here. */
export const ITEMS_PER_PAGE = 50;

/**
 * The next sort after clicking a header. `old/manifests.html:487-493`.
 *
 * Clicking the active column toggles; clicking another selects it descending.
 * Descending-first is right for every column here except `manifest`, and
 * upstream applies it to `manifest` too — reproduced, because a name column
 * that opened Z→A would be a gratuitous difference and the toggle makes A→Z one
 * click away. Recorded as divergence 4's *non*-change.
 */
export function nextSort(current: SortState, column: SortColumn): SortState {
    if (current.column === column) {
        return { column, ascending: !current.ascending };
    }
    return { column, ascending: false };
}

// --- building the rows ----------------------------------------------------

/**
 * Aggregates a `manifests.json` into one row per manifest path.
 *
 * Transcribed from `processManifestData` (`old/manifests.html:371-473`) with two
 * changes, both about the absent case rather than about arithmetic: a skipped
 * pair's statistics are `null` rather than `0`, and the final "sort by overall
 * median descending" (`:470`) is dropped because `sortRows` runs immediately
 * afterwards on every path through the page and would redo it.
 *
 * One pass to bucket, then a sort per bucket — the same shape as
 * `computeManifestStats`, on 494,380 runs.
 */
export function buildManifestRows(file: ManifestsFile): ManifestRow[] {
    const { runs, tasks, manifests, jobNames, commits, prefixes } = file;
    const count = runs.durations.length;
    if (
        runs.manifestIds.length !== count ||
        runs.jobNameIds.length !== count ||
        runs.taskIds.length !== count
    ) {
        // A length mismatch misattributes every duration to the wrong manifest
        // or job. Throwing beats rendering a plausible, wrong ranking — the
        // same reason `decodeManifests` throws on it.
        throw new Error(
            'runs arrays are not parallel: ' +
                `durations ${count}, manifestIds ${runs.manifestIds.length}, ` +
                `jobNameIds ${runs.jobNameIds.length}, taskIds ${runs.taskIds.length}`
        );
    }

    /** manifest -> job -> the runs on that pair */
    const byManifest = new Map<string, Map<string, ManifestRunPoint[]>>();
    for (let i = 0; i < count; i++) {
        const manifest = manifests[runs.manifestIds[i]!]!;
        // `runs.jobNameIds`, the chunk-stripped name — not `tasks.jobName`,
        // which keeps the chunk and would split one config into one row per
        // chunk. They differ on 83% of runs; see `lib/formats/manifests.ts`.
        const jobName = jobNames[runs.jobNameIds[i]!]!;
        const taskIndex = runs.taskIds[i]!;

        let jobs = byManifest.get(manifest);
        if (jobs === undefined) {
            jobs = new Map();
            byManifest.set(manifest, jobs);
        }
        const point: ManifestRunPoint = {
            duration: runs.durations[i]!,
            taskId: tasks.id[taskIndex]!,
            commit: commits[tasks.commitId[taskIndex]!]!,
            prefix: prefixes[tasks.prefix[taskIndex]!]!,
        };
        const existing = jobs.get(jobName);
        if (existing === undefined) {
            jobs.set(jobName, [point]);
        } else {
            existing.push(point);
        }
    }

    const rows: ManifestRow[] = [];
    for (const [manifest, jobs] of byManifest) {
        const jobStats: JobStats[] = [];
        let totalRuns = 0;
        const pooled: number[] = [];

        for (const [jobName, points] of jobs) {
            const durations = points.map((point) => point.duration);
            // `every`, not `any`: a pair with one non-zero duration ran, and
            // its zeros are runs that finished under the timer's resolution.
            const skipped = durations.every((duration) => duration === 0);
            if (skipped) {
                jobStats.push({
                    jobName,
                    runs: points,
                    runCount: points.length,
                    median: null,
                    mean: null,
                    skipped: true,
                });
                continue;
            }
            jobStats.push({
                jobName,
                runs: points,
                runCount: points.length,
                median: medianOf(durations),
                mean: meanOf(durations),
                skipped: false,
            });
            // Both exclude the skipped pair — `:441`, `:442`.
            totalRuns += points.length;
            pooled.push(...durations);
        }

        jobStats.sort(compareJobs);

        rows.push({
            manifest,
            jobStats,
            // Jobs it *ran* on, not jobs it appears on. `:461`.
            totalJobs: jobStats.filter((job) => !job.skipped).length,
            totalRuns,
            overallMedian: pooled.length === 0 ? null : medianOf(pooled),
            overallMean: pooled.length === 0 ? null : meanOf(pooled),
            allSkipped: pooled.length === 0,
        });
    }
    return rows;
}

/**
 * The **upper** middle element of a sample, which is this page's median.
 *
 * `old/manifests.html:429`, `:455`: `durations[Math.floor(durations.length / 2)]`
 * on a sorted array. Not interpolated, and **not** the nearest-rank quantile
 * `lib/query/manifest-stats.ts` uses — that one is `ceil(0.5n) - 1`, the
 * *lower* middle, and the two disagree on every even-length sample.
 *
 * Measured on the pinned 2026-08-04 file: **3,122 of 6,227** manifests get a
 * different overall median under the two rules. On `[10, 20 … 100]` this gives
 * 60 and `summarize` gives 50.
 *
 * Kept as the page's rule rather than unified, because unifying would change
 * every even-sample number on a dashboard in daily use, and the CLI's rule is
 * pinned by a test that names it deliberately
 * (`test/step5-query.test.ts:401`). The disagreement is declared instead —
 * `site/manifests.ts` divergence 8 — and asserted in
 * `test/manifests-parity.test.ts` so it cannot drift into an accident.
 *
 * Sorts a copy: the caller's array is built per pair and pooling reads it
 * again afterwards.
 */
export function medianOf(durations: readonly number[]): number {
    const sorted = [...durations].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
}

/** The arithmetic mean. `old/manifests.html:430`, `:456`. */
export function meanOf(durations: readonly number[]): number {
    let total = 0;
    for (const duration of durations) {
        total += duration;
    }
    return total / durations.length;
}

/**
 * Orders a manifest's jobs: worst median first, skipped last.
 *
 * `old/manifests.html:447-450` opens with
 * `if (a.skipped !== b.skipped) return a.skipped ? 1 : -1` and then compares
 * medians. Here the `?? -1` does both, exactly as
 * `lib/query/manifest-stats.ts:241-245` does and for the reason recorded there:
 * a skipped job's median is absent, every real median is at least 0, so a
 * sentinel below zero sorts it after all of them under the descending
 * comparison. Writing the guard as well would be a branch that changes no
 * output on any input — the shape mutation testing found in that file.
 *
 * `compareJobs` has **no tie-break on name** and upstream has none either
 * (`:447-450`), so two jobs with the same median keep insertion order. `Array`
 * sort is stable in every engine this ships to, and insertion order here is
 * the order the runs appear in the file. Left alone rather than "improved":
 * adding a name tie-break would change the rendered order of real rows for no
 * reason a reader asked for. See divergence 7.
 */
function compareJobs(a: JobStats, b: JobStats): number {
    return (b.median ?? -1) - (a.median ?? -1);
}

// --- filtering ------------------------------------------------------------

/** The two search boxes. Both default empty. */
export interface Filters {
    /** `?q=` — matched against the manifest path, case-insensitively. */
    manifest: string;
    /** `?job=` — matched against the *job names under* a manifest. */
    job: string;
}

/** No filters: what the page opens with, and what a cleared box returns to. */
export const NO_FILTERS: Filters = { manifest: '', job: '' };

/**
 * Keeps the manifests matching both boxes. `old/manifests.html:604-608`.
 *
 * The two boxes are not symmetric, and that asymmetry is the page's design
 * rather than an accident: `q` matches the row's **own** name, while `job`
 * matches **any job under** the row and keeps the row whole. An empty box
 * matches everything — `''.includes` is vacuously true for `q`, and `job` is
 * short-circuited explicitly (`:606`) so that a manifest with no jobs at all
 * would still survive an empty job box.
 *
 * A row kept by the job filter still shows its *unfiltered* Runs, Job Types,
 * Median and Mean: the numbers are never rewritten by a search. Filtering the
 * sub-rows is a separate step, `filterJobs`, which is the only place the job
 * needle narrows anything.
 */
export function filterRows(rows: readonly ManifestRow[], filters: Filters): ManifestRow[] {
    const manifestNeedle = filters.manifest.toLowerCase();
    const jobNeedle = filters.job.toLowerCase();
    return rows.filter((row) => {
        if (!row.manifest.toLowerCase().includes(manifestNeedle)) {
            return false;
        }
        return (
            jobNeedle === '' ||
            row.jobStats.some((job) => job.jobName.toLowerCase().includes(jobNeedle))
        );
    });
}

/**
 * The sub-rows an expanded manifest shows. `old/manifests.html:686-688`.
 *
 * The job needle applies here as well as at the top level, so expanding a row
 * under a job search shows only the matching jobs — the search narrows what is
 * *inside* a row as well as which rows there are. The manifest needle does not
 * apply: it has already selected the row.
 */
export function filterJobs(row: ManifestRow, filters: Filters): JobStats[] {
    const needle = filters.job.toLowerCase();
    if (needle === '') {
        return row.jobStats;
    }
    return row.jobStats.filter((job) => job.jobName.toLowerCase().includes(needle));
}

// --- sorting --------------------------------------------------------------

/**
 * The comparator value for a column, or `null` when the row has no value.
 *
 * `null` rather than a numeric sentinel, and the distinction is one a test
 * caught rather than one that was designed in. `lib/query/manifest-stats.ts`
 * uses `?? -1`, which works there because `sortManifests` only ever sorts
 * **descending** — a sentinel below every real value lands last, and there is
 * no ascending case to flip it.
 *
 * This page sorts both ways. A `-1` here puts a skipped manifest last under
 * descending and **first** under ascending, which is the very defect being
 * fixed, reintroduced through the fix. Measured on the hand-authored fixture:
 * with `-1`, `sortRows(rows, {column: 'median', ascending: true})` returns
 * `skipped.toml` first.
 *
 * So the absent case is not a value at all. `compareRows` handles it
 * explicitly, outside the direction flip.
 */
function columnValue(row: ManifestRow, column: SortColumn): number | null {
    switch (column) {
        case 'jobTypes':
            return row.totalJobs;
        case 'runs':
            return row.totalRuns;
        case 'median':
            return row.overallMedian;
        case 'mean':
            return row.overallMean;
        case 'manifest':
            // Handled by `sortRows`; a name has no numeric value and is never
            // absent.
            return 0;
    }
}

/**
 * Ranks the rows. `old/manifests.html:495-506`.
 *
 * The comparator for the rows that *have* a value is written ascending and
 * negated for descending, which is upstream's arrangement (`:503-505`) and is
 * kept because it is what makes a descending name sort mean "Z→A".
 *
 * A manifest that ran nowhere is handled **before** the negation, so it sorts
 * last in both directions rather than swapping ends with them. Upstream has no
 * such case — it stores `0` and lets the flip carry it to the top — and that is
 * the first-paint defect. Only `median` and `mean` can be absent; `runs` and
 * `jobTypes` are `0` for a skipped manifest, which is a real value and ranks
 * correctly as the smallest.
 *
 * **There is no tie-break**, and upstream has none either. A tie-break on the
 * manifest path would be an improvement — `sortManifests` has one — and it is
 * deliberately not added: it would reorder real rows relative to the page this
 * is being compared against, for a stability `Array.prototype.sort`'s
 * guaranteed stability already provides from a fixed input order. Divergence 7.
 */
export function sortRows(rows: readonly ManifestRow[], sort: SortState): ManifestRow[] {
    const sorted = [...rows];
    sorted.sort((a, b) => {
        if (sort.column === 'manifest') {
            const byName = a.manifest.localeCompare(b.manifest);
            return sort.ascending ? byName : -byName;
        }
        const left = columnValue(a, sort.column);
        const right = columnValue(b, sort.column);
        // Outside the flip: absent is last either way. Two absent rows tie, so
        // they keep their input order rather than reshuffling.
        if (left === null || right === null) {
            if (left === null && right === null) {
                return 0;
            }
            return left === null ? 1 : -1;
        }
        const result = left - right;
        return sort.ascending ? result : -result;
    });
    return sorted;
}

// --- pagination -----------------------------------------------------------

/** What the pager shows and which slice is on screen. */
export interface PageState {
    /** 1-based, as the page counts. */
    page: number;
    totalPages: number;
    prevDisabled: boolean;
    nextDisabled: boolean;
    /** `Page 1 of 125`. */
    label: string;
}

/**
 * The pager for a row count. `old/manifests.html:754-757`.
 *
 * `Math.ceil(n / 50)` is **0 when nothing matched**, so upstream renders
 * `Page 1 of 0` and disables Next only because `currentPage === totalPages` is
 * false — measured below. Reproduced exactly: it is visible, it is honest
 * enough ("there is no page 1"), and changing the string would be a difference
 * a reader has to notice for no gain. What is *not* reproduced is the disabled
 * state that falls out of it; see divergence 3.
 */
export function pageState(rowCount: number, page: number): PageState {
    const totalPages = Math.ceil(rowCount / ITEMS_PER_PAGE);
    return {
        page,
        totalPages,
        prevDisabled: page === 1,
        // `>=`, not `===`. Upstream's `currentPage === totalPages` leaves Next
        // *enabled* on an empty result, where `totalPages` is 0 and the page is
        // 1 — clicking it then does nothing, because `nextPage` guards with
        // `currentPage < totalPages`. A control that is enabled and inert is
        // worse than a disabled one. Divergence 3.
        nextDisabled: page >= totalPages,
        label: `Page ${page} of ${totalPages}`,
    };
}

/** The rows on the current page. `old/manifests.html:638-640`. */
export function pageSlice(rows: readonly ManifestRow[], page: number): ManifestRow[] {
    const start = (page - 1) * ITEMS_PER_PAGE;
    return rows.slice(start, start + ITEMS_PER_PAGE);
}

// --- URL state ------------------------------------------------------------

/**
 * The page's whole URL state: two search boxes and nothing else.
 *
 * Sort column, sort direction, page number and expansion are **not** in the
 * URL, upstream or here (`:568-596` writes only these two). So a shared link
 * reproduces what was typed and not what was clicked. Left as it is: adding
 * them would be a new feature rather than a migration, and it would change what
 * an existing shared link means.
 */
export function parseFilters(search: string): Filters {
    const params = new URLSearchParams(search);
    return {
        manifest: params.get('q') ?? '',
        job: params.get('job') ?? '',
    };
}

/**
 * The query string for a set of filters, as `syncFiltersToUrl` writes it.
 *
 * An empty box **deletes** its parameter rather than writing an empty value
 * (`:573-582`), so a cleared search leaves no trace in the URL — which is what
 * makes `?q=` and no query string the same state on the way back in.
 *
 * Takes the existing search so that an unrelated parameter a reader arrived
 * with — `?data-source=`, `?profiler=`, both read by the shared scripts — is
 * preserved rather than dropped. Upstream does this too, by mutating a
 * `new URL(location)` in place.
 */
export function filtersToSearch(current: string, filters: Filters): string {
    const params = new URLSearchParams(current);
    if (filters.manifest === '') {
        params.delete('q');
    } else {
        params.set('q', filters.manifest);
    }
    if (filters.job === '') {
        params.delete('job');
    } else {
        params.set('job', filters.job);
    }
    const query = params.toString();
    return query === '' ? '' : `?${query}`;
}

// --- the headline stats ---------------------------------------------------

/** The four stat cards. */
export interface HeadlineStats {
    manifests: number;
    jobs: number;
    runs: number;
    date: string;
}

/**
 * The four cards, from **raw artifact array lengths**. `old/manifests.html:890-893`.
 *
 * Deliberately decoupled from the table: these are `data.manifests.length`,
 * `data.jobNames.length` and `data.runs.durations.length`, so they describe the
 * whole corpus and do not move when a search narrows the table to one row.
 * Reproduced exactly, because "how big is the corpus" is a different question
 * from "what am I looking at" and the page answers both.
 *
 * Two of the three are **not** what the table would say even unfiltered.
 * Measured on the pinned 2026-08-04 file:
 *
 * | card | shows | the table's own count |
 * | --- | --- | --- |
 * | Total Manifests | 6,227 | 6,227 — every manifest in the table has at least one run |
 * | Total Jobs | **4,165** | **859** distinct job names actually appear on a run |
 * | Total Runs | **494,380** | **415,445** on pairs that ran — the card counts the 78,957 skipped ones too |
 *
 * So two of the three cards do not describe the table. Total Jobs is the length
 * of the `jobNames` **string table**, and that table is shared with
 * `tasks.jobName`, which keeps the chunk suffix — 4,165 entries of which only
 * 859 are reachable as a run's chunk-stripped configuration. Total Runs
 * includes runs every Runs cell excludes.
 *
 * Both are upstream's meaning and both are kept. Changing them would be a
 * different page rather than a migration of this one, and the gap is recorded
 * here so the next reader does not have to rediscover that the card and the
 * column disagree by design. Divergence 11 records the one thing this does say
 * on the page.
 */
export function headlineStats(file: ManifestsFile): HeadlineStats {
    return {
        manifests: file.manifests.length,
        jobs: file.jobNames.length,
        runs: file.runs.durations.length,
        // `|| 'Unknown'`, as upstream (`:893`) — an empty string is falsy there
        // too, so this matches on a file with a blank date as well as an absent
        // one.
        date: file.metadata.date || 'Unknown',
    };
}

// --- formatting -----------------------------------------------------------

/**
 * A duration for display. `old/manifests.html:475-485`.
 *
 * Transcribed exactly, including the two things a reader might call bugs and
 * which are left alone because changing them changes every cell on the page:
 * the minute form floors its seconds rather than rounding (`:482`), so
 * `119_900` is `1m 59s` and not `2m 0s`; and there is no hour form, so a
 * two-hour total reads `120m 0s`. `cli/commands/manifests.ts:459-477` formats
 * differently — one decimal on seconds, a padded `m ss`, and an hour form — and
 * that is a presentation divergence rather than a value one. Divergence 9.
 */
export function formatDuration(ms: number): string {
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }
    if (ms < 60000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

/** The key an expanded job is remembered by. `old/manifests.html:625`. */
export function jobKey(manifest: string, jobName: string): string {
    return `${manifest}|||${jobName}`;
}

// --- the chart ------------------------------------------------------------

/** One point of the per-run scatter, with what its click handlers need. */
export interface ScatterPoint {
    /** 1-based run number: the x axis is position in the file, not time. */
    x: number;
    /** Milliseconds. */
    y: number;
    taskId: string;
    prefix: string;
}

/**
 * The scatter series for one (manifest, job) pair. `old/manifests.html:764-781`.
 *
 * The x axis is **the run's index in the file**, not a date or a commit: the
 * old page pushes `i + 1` (`:771`) and labels the axis "Run Number". The runs
 * are in the order `runs.durations` holds them, which is the generator's order
 * and not sorted by anything this page knows about — so a rising line here
 * means "later in the file", not "slower over time". Reproduced, because
 * re-ordering the points would change what the chart says.
 *
 * Skipped pairs get a chart too, and it is a flat line of zeros — upstream
 * renders one (`:733` is reached for any expanded job, skipped or not) and so
 * does this. It is honest: the pair has runs, they are all zero, and the chart
 * shows exactly that.
 */
export function scatterPoints(job: JobStats): ScatterPoint[] {
    return job.runs.map((run, index) => ({
        x: index + 1,
        y: run.duration,
        taskId: run.taskId,
        prefix: run.prefix,
    }));
}

/**
 * Splits a task ID into its base and retry parts. `old/manifests.html:827-829`,
 * `:841-843`.
 *
 * `manifests.json` task IDs are mostly bare, but a minority carry a `.<retry>`
 * suffix and the artifact URL needs the two apart, because the run number is a
 * path segment rather than part of the id. Measured on the pinned 2026-08-04
 * file: **231 of 11,378** tasks. (`FORMATS.md` records 216 of 9,543 against an
 * earlier file; the share is stable, the counts are per-file.) A missing suffix
 * means run `0`.
 *
 * ## Why this delegates to `parseTaskId` rather than splitting on `.`
 *
 * This used to be `taskId.split('.')` with an unvalidated `parts[1]`, which is
 * a *different function* from `lib/formats/tables.ts`'s `parseTaskId` on two
 * inputs: `abc.1.2` gives retry `1` here and `2` there (last dot, not first),
 * and `abc.def` gives retry `def` here and `0` there. Both feed the same
 * Taskcluster `/runs/<n>/` URLs, so the two could not both be right.
 *
 * Neither input occurs. Across the published `manifests.json` (11,378 task ids)
 * and both manifests fixtures (1,393 more), **0 ids carry more than one dot and
 * 0 have a non-numeric suffix** — the only suffixes present are `1`, `2` and
 * `3`. Running the two implementations over all 12,771 gives 0 disagreements.
 * So this is unified on the validated one on that measurement, not on a
 * guess, and the collision is unreachable *in this data* rather than
 * impossible.
 *
 * The string-valued `retryId` is kept because it is interpolated straight into
 * a URL; `parseTaskId` returns a number and both render identically.
 */
export function splitTaskId(taskId: string): { baseTaskId: string; retryId: string } {
    const { taskId: base, retryId } = parseTaskId(taskId);
    return { baseTaskId: base, retryId: String(retryId) };
}

/**
 * The raw resource-usage profile URL for a run on `date`. `old/manifests.html:832`.
 *
 * Built here rather than in the renderer because it is a pure function of the
 * data and is what `test/manifests-view.test.ts` asserts; the renderer only
 * decides *when* to open it.
 */
export function resourceProfileArtifactUrl(taskId: string, date: string): string {
    const { baseTaskId, retryId } = splitTaskId(taskId);
    return resourceUsageProfileUrl(baseTaskId, Number(retryId), date);
}

/** The error-summary log URL for a run. `old/manifests.html:846`. */
export function errorSummaryUrl(taskId: string, prefix: string): string {
    const { baseTaskId, retryId } = splitTaskId(taskId);
    return (
        `https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/${baseTaskId}` +
        `/runs/${retryId}/artifacts/public/test_info/${prefix}_errorsummary.log`
    );
}

/**
 * The profiler URL a chart click opens. `old/manifests.html:834`.
 *
 * `markerSearch` is set to the manifest path, which is what makes the profile
 * open focused on that manifest's markers rather than on the whole job — the
 * one thing that makes this link worth following from this page rather than
 * from the job list.
 *
 * `profilerOrigin` is passed in rather than read from `getProfilerOrigin()`
 * here, because that global is a DOM reach (it parses `location.search`) and
 * this module has no DOM.
 */
export function profilerUrl(
    profilerOrigin: string,
    taskId: string,
    manifest: string,
    jobName: string,
    date: string
): string {
    const raw = resourceProfileArtifactUrl(taskId, date);
    const profileName = `${jobName} (${taskId})`;
    return (
        `${profilerOrigin}/from-url/${encodeURIComponent(raw)}` +
        `?profileName=${encodeURIComponent(profileName)}` +
        `&markerSearch=${encodeURIComponent(manifest)}`
    );
}

/**
 * The DOM id of a job's chart container. `old/manifests.html:740`.
 *
 * Reproduced character for character because Plotly is handed the **id**, not
 * the element (`:809`), so a different scheme is a different chart. Every
 * character outside `[a-z0-9]` becomes `-`, case-insensitively.
 *
 * The scheme is **not injective** — `a/b` and `a.b` both become `a-b` — so two
 * charts open at once could collide. Measured on the pinned 2026-08-04 file:
 * exactly **2 of 6,227** manifest names collide with another, and they are the
 * only pair. Reaching the collision needs both of them expanded at once, on the
 * same page of 50, on the same job. Kept as it is rather than "fixed": the
 * measurement says the risk is two names, changing the scheme changes nothing a
 * reader sees, and this function is the one place a future fix belongs.
 * Divergence 10.
 */
export function chartElementId(manifest: string, jobName: string): string {
    const slug = (value: string): string => value.replace(/[^a-z0-9]/gi, '-');
    return `chart-${slug(manifest)}-${slug(jobName)}`;
}
