/**
 * Treeherder's sheriff-annotated intermittent failures, and the Bugzilla lookup
 * that makes them readable.
 *
 * The data behind <https://treeherder.mozilla.org/intermittent-failures/>: a CI
 * failure a sheriff judged worth tracking and attached a bug number to. Not an
 * aggregate computed from logs — a human judgement, which is what makes a
 * burndown built on it assignable.
 *
 * `/api/failures/` ranks bugs by annotation count; `/api/failuresbybug/` returns
 * one bug's occurrences. Both take `startday`, `endday` and `tree`; that is the
 * whole vocabulary. Three consequences:
 *
 * **No harness parameter exists**, so `/failures/` ranks every harness at once
 * and nothing in its response identifies a mochitest bug. Answering "the top N
 * mochitest intermittents" means ranking tree-wide then reading `test_suite`
 * from `/failuresbybug/`, one request per candidate bug.
 *
 * **`/failures/` carries no bug summary and no test name**, only `bug_id` and
 * `bug_count`. The summary comes from Bugzilla, batched; the test name from
 * `lines` on the per-bug rows.
 *
 * **`bug_id` can be null** — the group of annotations made without naming a bug,
 * regularly the largest one. Nothing can be looked up or drilled into for it, so
 * callers report it as a count rather than dropping it.
 */

import type { FetchLike } from './http.ts';
import { TREEHERDER_ROOT } from './treeherder.ts';

/** Bugzilla's REST origin. */
export const BUGZILLA_ROOT = 'https://bugzilla.mozilla.org';

/**
 * One row of `/api/failures/`: a bug and how many annotations it has.
 *
 * `bugId` is `null` for the no-bug group. See the module comment.
 */
export interface BugFailureCount {
    bugId: number | null;
    count: number;
}

/** One row of `/api/failuresbybug/`, as `FailuresByBugSerializer` returns it. */
export interface BugOccurrence {
    bugId: number | null;
    /** Treeherder's own job ID, which `runIdsOfJobs` resolves to a run index. */
    jobId: number;
    /**
     * The job type with the platform and build type removed:
     * `mochitest-browser-chrome-39`, `xpcshell-spi-nw-2`. The **suite**, not a
     * test path — the test name, where there is one, is inside `lines`.
     */
    testSuite: string;
    platform: string;
    buildType: string;
    revision: string;
    tree: string;
    /** `YYYY-MM-DD HH:MM:SS`, as the API formats it. */
    pushTime: string;
    machineName: string;
    /** `UNKNOWN_TASK_ID` when Treeherder has no Taskcluster metadata for the job. */
    taskId: string;
    /**
     * Taskcluster's `runs/<n>` for `taskId`, or `null` when it was not resolved.
     *
     * **Not on `/api/failuresbybug/`**, which carries only `task_id`. A task
     * whose first run ended in `exception` is retried, and the annotated failure
     * is then in run 1 — so a caller that assumes run 0 fetches the wrong
     * artifacts, or none. `runIdsOfJobs` resolves it from `job_id`; a caller
     * that has not called it leaves this `null` rather than guessing 0.
     */
    runId: number | null;
    /** The job's `TEST-UNEXPECTED-FAIL` log lines. Empty when none were kept. */
    lines: string[];
}

/**
 * What `taskId` holds when Treeherder has no Taskcluster metadata for the job.
 *
 * `intermittents_view.py` writes the literal string rather than omitting the
 * field, so it is a value every consumer receives and none can index. Exported
 * because it is not a null check but a sentinel comparison: a caller building a
 * Taskcluster URL has to reject it, and `"unknown"` spelled out at each such
 * site is the same magic string repeated.
 */
export const UNKNOWN_TASK_ID = 'unknown';

/**
 * What Bugzilla tells us about one bug: its summary and whether it is resolved.
 *
 * **`resolution` is the field that says "resolved", not `status`.** Measured
 * against live Bugzilla on 2026-09-12 (bugs 1980036, 2021221, 2060167,
 * 2062444): an open bug carries `status: "NEW"` with `resolution: ""`, and a
 * closed one carries `status: "RESOLVED"` with `resolution: "FIXED"`. So the
 * empty string is the marker for "still open" and any non-empty value means the
 * bug has been closed out somehow — `FIXED`, `WONTFIX`, `DUPLICATE`,
 * `INCOMPLETE`, `WORKSFORME`.
 *
 * Both fields are kept rather than collapsing to a boolean here, because they
 * are not the same question and a caller may need either: `resolution` answers
 * "was this closed", and `status` distinguishes `RESOLVED` from `VERIFIED` and
 * `CLOSED`, which are all resolved states Bugzilla sets at different points of
 * its own workflow. A boolean computed in this module would make the caller
 * unable to tell a reader *how* a bug was closed, and "FIXED" and "WONTFIX"
 * mean opposite things to somebody deciding whether to expect more failures.
 */
export interface BugInfo {
    /** The bug's one-line summary, as Bugzilla stores it. */
    summary: string;
    /**
     * Bugzilla's `status`: `NEW`, `ASSIGNED`, `RESOLVED`, `VERIFIED`, `CLOSED`.
     *
     * The empty string when Bugzilla did not return the field, which is what a
     * recorded fixture predating this field carries.
     */
    status: string;
    /**
     * Bugzilla's `resolution`, or `''` for a bug that is still open.
     *
     * `FIXED`, `WONTFIX`, `DUPLICATE`, `INCOMPLETE`, `WORKSFORME` — or `''`.
     * `isResolvedBug` is the predicate; callers should not re-spell the
     * emptiness check.
     */
    resolution: string;
    /**
     * Who the bug is assigned to, as a human name, or `null` for nobody.
     *
     * **`assigned_to_detail.real_name`, not `assigned_to`.** The latter is an
     * email address; a display of "who owns this bug" does not need to publish
     * one, so the name is what this field carries.
     *
     * **`null` for the unassigned sentinel.** Bugzilla has no empty assignee: an
     * unowned bug is assigned to `nobody@mozilla.org`, whose `real_name` is the
     * string `'Nobody; OK to take it and work on it'`. Measured against live
     * Bugzilla on 2026-09-12 (bugs 1913777, 2021221, 2060167). That string is a
     * sentence about the bug's state rather than a name, so it is turned into
     * `null` here — once, where the field is read — instead of every caller
     * learning to recognise it.
     */
    assignee: string | null;
}

/**
 * The `assigned_to` value Bugzilla uses to mean "nobody".
 *
 * Exported so a test can assert the mapping against the real sentinel rather
 * than against a copy of the string.
 */
export const UNASSIGNED_BUGZILLA_USER = 'nobody@mozilla.org';

/**
 * `BugInfo.assignee` from one Bugzilla bug object.
 *
 * Three ways to be unassigned, and all three answer `null`: the sentinel user,
 * a missing `assigned_to_detail`, and a `real_name` Bugzilla left empty (which
 * happens for an account that never set one). The email is deliberately **not**
 * the fallback for that last case — see `BugInfo.assignee`.
 */
export function assigneeName(bug: {
    assigned_to?: string;
    assigned_to_detail?: { real_name?: string };
}): string | null {
    if (bug.assigned_to === UNASSIGNED_BUGZILLA_USER) {
        return null;
    }
    const name = bug.assigned_to_detail?.real_name;
    return name === undefined || name === '' ? null : name;
}

/**
 * Whether a bug has been closed out, by Bugzilla's own definition.
 *
 * A non-empty `resolution`, which is the semantics measured above: Bugzilla
 * clears `resolution` when a bug is reopened and sets it when a bug is closed,
 * whatever the closing `status` is. Written as a predicate rather than left to
 * each caller so that "resolved" means one thing across the CLI and the page.
 *
 * **Not restricted to `FIXED`.** A `WONTFIX` or `DUPLICATE` intermittent bug is
 * just as closed, and a reader scanning a ranked list needs to know that nobody
 * is working on it — which is the same thing they need to know about a `FIXED`
 * one that is still failing. The *distinction* between them is carried to the
 * reader as text (the resolution word itself) rather than by excluding some
 * resolutions from the predicate.
 */
export function isResolvedBug(info: BugInfo | undefined): boolean {
    return info !== undefined && info.resolution !== '';
}

/** Thrown when Treeherder or Bugzilla answers with something unreadable. */
export class IntermittentsError extends Error {
    readonly url: string;
    readonly status: number | undefined;

    constructor(message: string, url: string, status?: number) {
        super(message);
        this.name = 'IntermittentsError';
        this.url = url;
        this.status = status;
    }
}

/** What `intermittentsClient` needs. */
export interface IntermittentsOptions {
    /** How requests are made. Required — `lib/` has no global `fetch`. */
    fetch: FetchLike;
    /** Overrides Treeherder's origin, for a test or a staging instance. */
    root?: string | undefined;
    /** Overrides Bugzilla's origin, for a test. */
    bugzillaRoot?: string | undefined;
}

/**
 * One day of `/api/failurecount/`: a bug's failures against what ran that day.
 *
 * `testRuns` is the **denominator** the other two endpoints do not carry, and it
 * is what makes a rate possible rather than only a count. That matters on this
 * data specifically: push volume drops several-fold at weekends (the reason
 * `DEFAULT_DAYS` gives for whole-week windows), so a raw count dips every
 * Saturday for reasons that have nothing to do with the bug.
 */
export interface BugFailureDay {
    /** `YYYY-MM-DD`. */
    date: string;
    /** Jobs that ran that day, tree-wide — the rate's denominator. */
    testRuns: number;
    /** Annotations of this bug that day. */
    failureCount: number;
}

/** A date range, both ends inclusive, both `YYYY-MM-DD`. */
export interface DayRange {
    /** `startday`. */
    start: string;
    /** `endday`. Treeherder extends it to the end of that day (`get_end_of_day`). */
    end: string;
}

/** The two queries this module makes, over one Treeherder deployment. */
export interface IntermittentsClient {
    /** `/api/failures/`: every annotated bug in the range, count-descending. */
    rankBugs(tree: string, range: DayRange): Promise<BugFailureCount[]>;
    /** `/api/failuresbybug/`: every occurrence of one bug in the range. */
    occurrencesOfBug(tree: string, range: DayRange, bug: number): Promise<BugOccurrence[]>;
    /**
     * `/api/failurecount/`: one bug's whole per-day series, in one request.
     *
     * **One bug per request — `bug=a,b` is HTTP 400.** Measured against live
     * Treeherder on 2026-09-12, so there is no batching to be had and the cost
     * is O(bugs) rather than O(days). That is exactly why the ranked table's
     * sparklines do *not* use this: they need every row's series, and 21 per-day
     * `/api/failures/` requests serve all 1,170 of them where this would be
     * 1,170 requests. `historiesFromDays` in `site/intermittent-view.ts` carries
     * that comparison.
     *
     * Where it wins is **one bug on demand**: 1.2 kB and 0.4-1.5 s for a 21-day
     * series, against 2.2 MB and 5.4 s for the same bug's `occurrencesOfBug`.
     * So a drill-down that wants a bug's history without its per-job breakdown
     * should come here.
     *
     * Without a `bug`, Treeherder returns the tree-wide daily series instead —
     * the same shape, and measured at **19.1 s** for a 21-day window, which is
     * why nothing here calls it that way.
     *
     * The numbers agree with the per-day `/api/failures/` route exactly:
     * verified on bug 2060167 over 2026-09-01..05, both give 182/193/160/99/17.
     */
    failureCountOfBug(tree: string, range: DayRange, bug: number): Promise<BugFailureDay[]>;
    /**
     * `/api/jobs/?id__in=`: the Taskcluster run index of each job, batched.
     *
     * The intermittents endpoints do not carry it, and it is not derivable: a
     * task that was retried has its annotated failure in a run other than 0.
     * This is the same `/api/jobs/` listing `lib/sources/treeherder.ts` reads,
     * selected by job ID rather than by push, so the run index comes from
     * Treeherder's own job record rather than from a Taskcluster run list.
     *
     * A job Treeherder does not return is absent from the map rather than
     * defaulted.
     */
    runIdsOfJobs(jobIds: readonly number[]): Promise<Map<number, number>>;
    /**
     * Bugzilla summaries and resolutions for a set of bug numbers, batched.
     *
     * Returns a `BugInfo` rather than a bare summary string: the resolution
     * comes back in the same response for no extra request and no extra
     * round trip, and a ranked list of intermittents that does not say which
     * of its bugs are already closed is a list a reader has to check by hand.
     * A bug Bugzilla does not return — one that is restricted, or a number
     * that does not exist — is absent from the map rather than defaulted.
     */
    bugSummaries(bugs: readonly number[]): Promise<Map<number, BugInfo>>;
}

/**
 * The repo groups `tree` accepts besides a repository name.
 *
 * Mirrors Treeherder's `REPO_GROUPS`, so a typo can be answered with the valid
 * group names rather than with its 400.
 */
export const TREE_GROUPS: readonly string[] = ['trunk', 'firefox-releases', 'comm-releases'];

/** Builds a client over an injected fetch. */
export function intermittentsClient(options: IntermittentsOptions): IntermittentsClient {
    const root = options.root ?? TREEHERDER_ROOT;
    const bugzillaRoot = options.bugzillaRoot ?? BUGZILLA_ROOT;

    async function getJson<T>(url: string): Promise<T> {
        let response;
        try {
            response = await options.fetch(url);
        } catch (error) {
            throw new IntermittentsError(
                `request failed: ${(error as Error).message}`,
                url
            );
        }
        if (!response.ok) {
            throw new IntermittentsError(`HTTP ${response.status}`, url, response.status);
        }
        const text = new TextDecoder().decode(await response.arrayBuffer());
        try {
            return JSON.parse(text) as T;
        } catch (error) {
            throw new IntermittentsError(
                `response is not valid JSON: ${(error as Error).message}`,
                url
            );
        }
    }

    return {
        async rankBugs(tree: string, range: DayRange): Promise<BugFailureCount[]> {
            const url = `${root}/api/failures/?${rangeQuery(tree, range)}`;
            const rows = await getJson<{ bug_id: number | null; bug_count: number }[]>(url);
            return rows.map((row) => ({ bugId: row.bug_id, count: row.bug_count }));
        },

        async occurrencesOfBug(
            tree: string,
            range: DayRange,
            bug: number
        ): Promise<BugOccurrence[]> {
            const url = `${root}/api/failuresbybug/?${rangeQuery(tree, range)}&bug=${bug}`;
            const rows = await getJson<
                {
                    bug_id: number | null;
                    test_suite: string;
                    platform: string;
                    build_type: string;
                    revision: string;
                    tree: string;
                    push_time: string;
                    machine_name: string;
                    task_id: string;
                    job_id: number;
                    lines: string[];
                }[]
            >(url);
            return rows.map((row) => ({
                bugId: row.bug_id,
                jobId: row.job_id,
                testSuite: row.test_suite,
                platform: row.platform,
                buildType: row.build_type,
                revision: row.revision,
                tree: row.tree,
                pushTime: row.push_time,
                machineName: row.machine_name,
                taskId: row.task_id,
                runId: null,
                lines: row.lines,
            }));
        },

        async failureCountOfBug(
            tree: string,
            range: DayRange,
            bug: number
        ): Promise<BugFailureDay[]> {
            // One bug, never a list: `bug=a,b` is a 400 (see the interface).
            const url = `${root}/api/failurecount/?${rangeQuery(tree, range)}&bug=${bug}`;
            const rows = await getJson<
                { date: string; test_runs: number; failure_count: number }[]
            >(url);
            return rows.map((row) => ({
                date: row.date,
                testRuns: row.test_runs,
                failureCount: row.failure_count,
            }));
        },

        async runIdsOfJobs(jobIds: readonly number[]): Promise<Map<number, number>> {
            const found = new Map<number, number>();
            for (const batch of chunk([...new Set(jobIds)], JOB_BATCH_SIZE)) {
                if (batch.length === 0) {
                    continue;
                }
                const url = `${root}/api/jobs/?id__in=${batch.join(',')}`;
                const data = await getJson<{
                    results?: unknown[][];
                    job_property_names?: string[];
                    next?: string | null;
                }>(url);
                // `/api/jobs/` is paginated and the page size is Treeherder's
                // choice — `lib/sources/treeherder.ts` follows `next` for that
                // reason. `JOB_BATCH_SIZE` is set below the measured page size
                // so one batch is one page, but "measured" is not "guaranteed":
                // a smaller page would silently leave the tail of the batch
                // unresolved, and an unresolved run is indistinguishable from
                // run 0 to every caller. So it is checked rather than assumed.
                if (data.next != null) {
                    throw new IntermittentsError(
                        `Treeherder paginated a ${batch.length}-job request, so ${JOB_BATCH_SIZE} ` +
                            `is above its current page size; lower JOB_BATCH_SIZE or follow "next"`,
                        url
                    );
                }
                const names = data.job_property_names ?? [];
                const idColumn = names.indexOf('id');
                const retryColumn = names.indexOf('retry_id');
                if (idColumn === -1 || retryColumn === -1) {
                    throw new IntermittentsError(
                        `Treeherder's job_property_names is missing id or retry_id, so the ` +
                            `positional rows cannot be decoded; got: ${names.join(', ')}`,
                        url
                    );
                }
                for (const row of data.results ?? []) {
                    // A null `retry_id` is how Treeherder writes run 0, the same
                    // convention `lib/sources/treeherder.ts` reads it under.
                    found.set(Number(row[idColumn]), Number(row[retryColumn] ?? 0));
                }
            }
            return found;
        },

        async bugSummaries(bugs: readonly number[]): Promise<Map<number, BugInfo>> {
            const batches = chunk(bugs, BUG_BATCH_SIZE).filter((batch) => batch.length > 0);
            // **Concurrent, not serial.** Each batch is an independent GET of a
            // disjoint set of bug numbers, so there is no ordering constraint
            // between them and nothing to read from an earlier response. Serial
            // batches cost the round trip once per batch; measured against live
            // Bugzilla on 2026-09-12, one request of 500 ids takes 0.7 s
            // whatever else is in flight, so a 1,166-candidate window went from
            // 12 sequential requests to 3 concurrent ones.
            //
            // Bounded by `BUG_REQUEST_CONCURRENCY` rather than run through one
            // `Promise.all` over every batch, for the reason that constant
            // records: this is somebody else's public API.
            const responses = await inPool(batches, BUG_REQUEST_CONCURRENCY, async (batch) => {
                const url =
                    `${bugzillaRoot}/rest/bug?id=${batch.join(',')}` +
                    // `status`, `resolution` and the assignee alongside the
                    // summary. Bugzilla charges nothing for extra columns of a
                    // row it is already reading, and a second request for the
                    // resolutions would double the request count for data that
                    // was one field away. Verified against live Bugzilla on
                    // 2026-09-12: adding the two assignee fields to this same
                    // batched request costs **no additional request**.
                    `&include_fields=id,summary,status,resolution,assigned_to,assigned_to_detail`;
                return getJson<{
                    bugs?: {
                        id: number;
                        summary: string;
                        status?: string;
                        resolution?: string;
                        assigned_to?: string;
                        assigned_to_detail?: { real_name?: string };
                    }[];
                }>(url);
            });
            const found = new Map<number, BugInfo>();
            for (const data of responses) {
                for (const bug of data.bugs ?? []) {
                    found.set(bug.id, {
                        summary: bug.summary,
                        // Defaulted to `''` rather than required, so a Bugzilla
                        // that stops returning a field — or a recorded fixture
                        // written before this change — reads as "not known to be
                        // resolved" instead of throwing. `isResolvedBug` then
                        // answers false, which is the safe direction: it strikes
                        // nothing through rather than striking a live bug.
                        status: bug.status ?? '',
                        resolution: bug.resolution ?? '',
                        assignee: assigneeName(bug),
                    });
                }
            }
            return found;
        },
    };
}

/**
 * How many bug numbers go in one Bugzilla request.
 *
 * Bounded by URL length rather than by the API, which takes a comma-joined `id`
 * and does not document a count limit. **Measured** against live Bugzilla on
 * 2026-09-12, with this request's own `include_fields=id,summary,status,resolution`
 * and seven-digit bug numbers:
 *
 * | ids | URL length | result |
 * | --- | --- | --- |
 * | 100 | 884 | HTTP 200, 0.8 s |
 * | 500 | 4,084 | HTTP 200, 0.7 s |
 * | 600 | 4,884 | HTTP 200, 0.8 s |
 * | 1,000 | 8,084 | HTTP 200 |
 * | 1,100 | 8,884 | **HTTP 414 URI Too Long** |
 * | 1,200 | 9,684 | **HTTP 414** |
 * | 2,000 | 16,084 | **HTTP 414** |
 *
 * So the boundary sits between 8,084 and 8,884 characters of URL, and the
 * response time does not grow with the batch — 500 ids cost the same 0.7 s as
 * 100 did, which is what makes a larger batch a straight win rather than a
 * trade. That the limit tracks URL length and not the id count is the observed
 * pattern; the exact figure is one deployment's configuration on one day rather
 * than a documented contract, which is why this constant leaves headroom
 * instead of sitting at the measured edge.
 *
 * **500**, which is 4 kB of URL — under half the length that first failed. Five
 * times fewer requests than the 100 this started at, while staying far enough
 * below the boundary that a longer `include_fields`, a Bugzilla whose limit is
 * lower, or eight-digit bug numbers do not turn a working page into a 414. Going
 * to 1,000 would save one more request out of three and spend all of that
 * margin.
 */
export const BUG_BATCH_SIZE = 500;

/**
 * How many Bugzilla batches are in flight at once.
 *
 * `bugSummaries` issues its batches concurrently, and this caps how many. A
 * 21-day `trunk` window has ~1,166 candidates, which is 3 batches at
 * `BUG_BATCH_SIZE`, so this bound does not bite there — it exists for the window
 * that is larger than the one measured, so that a 90-day range cannot turn into
 * a burst of twenty parallel requests at somebody else's public API from every
 * open tab.
 *
 * 4 rather than a larger pool because the win is already taken: three batches
 * run fully parallel, and the round trip is 0.7 s whether one or several are in
 * flight. A higher number would buy nothing measurable here and spend goodwill
 * that is not ours.
 */
export const BUG_REQUEST_CONCURRENCY = 4;

/**
 * How many job IDs go in one `/api/jobs/?id__in=` request.
 *
 * Bounded by URL length, like `BUG_BATCH_SIZE`: a job ID is nine digits plus a
 * comma, so 200 of them is a 2 KB query string.
 *
 * Also has to stay **below Treeherder's page size**, measured at 2,000 on
 * 2026-09-04, so that one batch is one page and `runIdsOfJobs` needs no
 * pagination loop. That is a measurement of someone else's default rather than
 * a contract, so `runIdsOfJobs` rejects a paginated response instead of
 * trusting this number.
 */
export const JOB_BATCH_SIZE = 200;

/** The query string all three intermittents endpoints share. */
function rangeQuery(tree: string, range: DayRange): string {
    return (
        `startday=${encodeURIComponent(range.start)}` +
        `&endday=${encodeURIComponent(range.end)}` +
        `&tree=${encodeURIComponent(tree)}`
    );
}

/** Splits into batches of at most `size`. */
function chunk<T>(items: readonly T[], size: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        batches.push(items.slice(i, i + size));
    }
    return batches;
}

/**
 * Maps `work` over `items` with at most `limit` calls in flight, in order.
 *
 * **Results are index-aligned with `items`**, not in completion order, so a
 * caller can pair the nth result with the nth input. That matters because the
 * whole point of a pool is that things finish out of order.
 *
 * **The first rejection rejects the whole call**, like `Promise.all` and unlike
 * `allSettled`: every current caller is fetching pieces of one answer, and a
 * half-fetched ranking presented as a whole one is the failure mode this
 * module's error type exists to prevent. Work already in flight is not
 * cancelled — there is nothing to cancel a `fetch` with here — so it runs to
 * completion and its result is dropped.
 *
 * Written out rather than pulled from a dependency because it is eight lines and
 * this repository has no runtime dependencies to add one to.
 */
export async function inPool<T, R>(
    items: readonly T[],
    limit: number,
    work: (item: T) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    // `limit` workers sharing one cursor, rather than slicing the input into
    // `limit` contiguous runs: a slow item then delays only its own worker
    // instead of stalling a fixed share of the work behind it.
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        for (let index = next++; index < items.length; index = next++) {
            results[index] = await work(items[index] as T);
        }
    });
    await Promise.all(workers);
    return results;
}

/**
 * Which harness an **occurrence** ran under, from its job name, or `null`.
 *
 * Deliberately not the ranked list's classifier, which reads a test path out of
 * the bug summary. That is the right evidence for "is this *bug* a mochitest
 * bug", because a summary names one test and a bug spans many jobs. Here the
 * question is different — "did *this job* run mochitest" — and the row carries
 * the job name that answers it directly, which is better evidence than
 * re-deriving it from the bug.
 *
 * The harness is a `-`-delimited word rather than a prefix, because Treeherder
 * computes `test_suite` by subtracting the platform and build type out of the
 * job name: an ASAN mochitest arrives as `opt-mochitest-chrome-1proc` and an
 * Android one as `geckoview-mochitest-plain-3`. `gtest-1proc` and
 * `opt-gtest-1proc` are neither harness, which is why the boundary matters in
 * both directions.
 *
 * `null` for a job that is neither — talos, reftest, wpt, a build task — and
 * callers report how many rather than dropping them.
 */
export function harnessOfOccurrence(testSuite: string): 'mochitest' | 'xpcshell' | null {
    if (/(^|-)mochitest(-|$)/.test(testSuite)) {
        return 'mochitest';
    }
    return /(^|-)xpcshell(-|$)/.test(testSuite) ? 'xpcshell' : null;
}

/**
 * A `test_suite` value with its trailing chunk number removed.
 *
 * `mochitest-browser-chrome-2` and `mochitest-browser-chrome-11` are the same
 * configuration run in different chunks, so grouping the raw values splits one
 * answer into a dozen rows. Variant suffixes are *not* numbers — `-no-nv`,
 * `-swr`, `-msix`, `-spi`, `-nofis` — so they survive, which is the distinction
 * that matters: `-no-nv-7` versus `-7` is two configurations, `-7` versus `-8`
 * is one.
 *
 * Not `lib/model/job-name.ts`'s `stripChunkSuffix`, and deliberately: that one
 * anchors the strip after the `/` that separates the build type, because a
 * platform can end in digits and stripping the whole name would eat part of it.
 * Treeherder has already removed the platform and build type from `test_suite`
 * (`TestSuiteField`), so there is no `/` and no platform left to damage — but
 * that also means the shared function returns these unchanged. Loosening it
 * would weaken the guarantee it makes for job names that still carry a
 * platform, so this is its own rule for its own field.
 */
export function stripSuiteChunk(testSuite: string): string {
    return testSuite.replace(/-\d+$/, '');
}

/**
 * Path-shaped tokens in a bug summary, in the order they appear.
 *
 * The first half of classifying a bug. Sheriffs name the failing test in the
 * summary — `Frequent browser/.../browser_tab_preview.js | single tracking bug`
 * — so the path is there to be read, but *only a caller that checks it against
 * the real test data may call the result a mochitest*: this returns candidates,
 * not verdicts. Measured over a live top-80 ranking, 48 summaries yield a token
 * and 8 of those are not tests this tool knows (wpt, a crashtest, a marionette
 * `.py`, the xpcshell harness script itself).
 *
 * The extension list is what keeps a token path-shaped rather than merely
 * slash-separated: a summary routinely carries `gfx/wr/...` source locations and
 * `/_mozilla/webgpu/cts/...` fragments, and neither is a file.
 */
export function testPathCandidates(summary: string): string[] {
    const found: string[] = [];
    for (const match of summary.matchAll(TEST_PATH_TOKEN)) {
        const path = match[1]!;
        if (!found.includes(path)) {
            found.push(path);
        }
    }
    return found;
}

/**
 * A `dir/.../file.ext` token with a test-file extension.
 *
 * `.py` and `.toml` are in the list because a summary can legitimately name a
 * manifest or a marionette test; both are rejected later by the check against
 * the real test paths, which is where "is this a test" is actually decided.
 */
const TEST_PATH_TOKEN = /\b((?:[\w.+-]+\/)+[\w.+-]+\.(?:js|mjs|html|xhtml|xul|sjs|py|toml|ini))\b/g;

/**
 * The bug summary with its triage prefix and the test path removed.
 *
 * What is left is the part that says something the other columns do not. A
 * summary is `<prefix> <path> | <message>`, and both of the first two are
 * already columns of their own, so showing them again spends the width that
 * the message needs — the message is what distinguishes two bugs on the same
 * test.
 *
 * Returns an empty string when nothing is left, which is the common case for a
 * tracking bug whose whole summary is the path.
 */
export function summaryRemainder(summary: string, path: string | null): string {
    let rest = summary.replace(TRIAGE_PREFIX, '');
    if (path !== null) {
        rest = rest.replace(path, '');
    }
    return rest.replace(/^[\s|:-]+/, '').replace(/[\s|]+$/, '').trim();
}

/**
 * The triage words a sheriff puts in front of a summary.
 *
 * Repeated rather than alternated once: `Perma [tier 2] ` and
 * `High frequency intermittent ` both occur, so one pass over a single
 * alternation would leave the second word behind.
 *
 * Each word alternative ends at a word boundary, so a longer word is never
 * partly consumed: without it `perma` ate the front of `Permanent` and left
 * `nent` as the whole failure column of bug 2036743.
 *
 * The `[a-z]*` before each boundary carries the inflections rather than a list
 * of spellings, so `Permafailing` (bug 1844248) and `Intermittents` need no
 * entry of their own. It deliberately stops at the stems above: `Permaorange`
 * is a different word, not an inflection, and stripping it would need the
 * spelling list this avoids — so it is left whole, which costs width but never
 * corrupts the message. `high frequ[en]*cy` gets the boundary on the same rule,
 * though no summary yet distinguishes it.
 */
const TRIAGE_PREFIX =
    /^(?:(?:perma(?:nent|fail)[a-z]*\b|perma\b|frequent[a-z]*\b|intermittent[a-z]*\b|high frequ[en]*cy\b|\[meta\]|\[tier \d\]|\[?not ?a ?leak\]?)[\s|:-]*)+/i;

/**
 * The test path a `TEST-UNEXPECTED-FAIL` line names, or `null`.
 *
 * The only place a per-test name appears in this API — `test_suite` is the suite
 * and chunk — so without it a "top intermittents" list names chunks. The format
 * is `… TEST-UNEXPECTED-FAIL | <path> | <message>`. `null` for a line with no
 * path field, which a `[taskcluster:error]` genuinely has.
 */
export function testPathOfLine(line: string): string | null {
    const marker = line.indexOf('TEST-UNEXPECTED-FAIL');
    if (marker === -1) {
        return null;
    }
    const fields = line.slice(marker).split('|');
    const candidate = fields[1]?.trim();
    if (candidate === undefined || candidate.length === 0) {
        return null;
    }
    return candidate;
}
