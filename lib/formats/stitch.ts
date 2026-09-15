/**
 * Joining consecutive 21-day aggregates into one longer timeline.
 *
 * Taskcluster keeps every `test-info-*` run indexed under its push date, not
 * only under `latest`, and each archived run published its own complete 21-day
 * aggregate. So a page that wants more than 21 days of history does not need a
 * new artifact — it needs to fetch several of the existing ones and lay them
 * end to end. That is what this does.
 *
 * ## Why the join is at the decoded level
 *
 * The obvious implementation merges two raw `IssuesFile`s. It is the wrong one:
 * every integer in a raw file is an index into that file's own string tables —
 * `statuses` (positionally, through `testRuns[testId][statusId]`), `messages`,
 * `crashSignatures`, `taskIds`, `jobNames`, `testPaths`, `testNames`,
 * `components`, plus `taskInfo`'s parallel arrays. Two files order those tables
 * differently (measured: the same twelve xpcshell statuses come back in two
 * different orders), so a raw merge has to re-index all of them and re-delta-
 * encode every group's `days`. Every one of those remaps is a chance to
 * silently attribute a failure to the wrong status or the wrong job.
 *
 * `decodeTimingFile` already resolves entry strings — a `RunEntry` carries
 * `status`, `message`, `crashSignature` and `jobName` as actual strings — so a
 * composite built on top of the decoded interface needs no table work at all.
 * `DecodedTimingFile` is a plain interface and nothing downstream requires the
 * object `decodeTimingFile()` returned, which is what makes this possible.
 *
 * ## Which day comes from which file
 *
 * A window's two boundary days are not trustworthy, and this is measured rather
 * than assumed. Comparing two published xpcshell aggregates that overlap, per
 * test and per status, aligned by date:
 *
 * | date | tests agreeing | run totals |
 * | --- | --- | --- |
 * | 2026-08-16, the newer file's `startDate` | 43 of 4831 | newer has 18,741 **fewer** |
 * | 2026-08-18 | 4841 of 4841 | identical |
 * | 2026-08-21 | 4848 of 4848 | identical |
 * | 2026-08-24 | 4853 of 4853 | identical |
 * | 2026-08-25, the older file's `endDate` | 1 of 4855 | newer has 222,330 **more** |
 *
 * Interior days are exact — same tests, same counts, to the unit. A window's
 * `endDate` day undercounts because the run is generated about a day later and
 * jobs are still landing against it; its `startDate` day is partial.
 *
 * So at a **seam** a date is taken from the file where it is interior. The
 * timeline's own two outer edges are kept as they are: the newest day of the
 * newest window and the oldest day of the oldest window have no better source,
 * and dropping them would throw away the most recent day the page can show.
 *
 * Day indices are plain `startDate + day` with day 0 the oldest, confirmed by
 * alignment: the matching offset between two windows equals their `startDate`
 * gap exactly.
 */

import type { DecodedTimingFile, RunEntry, TimingFamily } from './decode.ts';
import type { TestIdentity } from './tables.ts';

/**
 * Whether this codebase can decode a fetched aggregate at all.
 *
 * The published format changed: runs older than about 2026-02-16 key their
 * per-day arrays `hours` rather than `days`, and no decoder here knows that
 * shape — `statusGroupShape` throws `UnknownStatusGroupShapeError` on it.
 * Measured 2026-09-15: pushdate 2026-02-10 carries `hours`, 2026-02-16 carries
 * `days`, and every run after it carries `days`.
 *
 * Checked on the raw file *before* decoding, because the throw would otherwise
 * happen deep inside a render — the shape is only inspected when a group is
 * iterated, so a bad file loads fine and then breaks the chart.
 *
 * Only the first non-null group is examined. The format is a property of the
 * generating job, not of a test, so one group answers for the file; scanning
 * all of them would walk 100,000 tests to learn the same thing.
 */
export function isDecodableAggregate(raw: unknown): boolean {
    if (raw === null || typeof raw !== 'object') {
        return false;
    }
    const testRuns = (raw as { testRuns?: unknown }).testRuns;
    if (!Array.isArray(testRuns)) {
        return false;
    }
    for (const groups of testRuns) {
        if (!Array.isArray(groups)) {
            continue;
        }
        for (const group of groups) {
            if (group === null || typeof group !== 'object') {
                continue;
            }
            const keys = Object.keys(group as object);
            if (keys.length === 0) {
                continue;
            }
            // `days` is what every shape this codebase decodes carries, apart
            // from the daily files' flat groups — and an aggregate is never
            // one of those.
            return keys.includes('days');
        }
    }
    // No groups at all: nothing to misread, and nothing to plot either.
    return false;
}

/** One fetched window, with the dates it covers. */
export interface StitchWindow {
    /** The decoded aggregate. */
    file: DecodedTimingFile;
    /**
     * Its dates, oldest first, one per day index — `windowDates()`'s output.
     * Passed in rather than recomputed so this module needs no date
     * arithmetic and no opinion about where `startDate` comes from.
     */
    dates: readonly string[];
}

/** A stitched timeline: the joined file plus what went into it. */
export interface StitchedTimeline {
    /** The composite, spanning every date in `dates`. */
    file: DecodedTimingFile;
    /** Every date the timeline covers, oldest first, contiguous. */
    dates: string[];
    /** How many dates came from more than one window and had to be resolved. */
    seams: number;
    /**
     * Dates that no window could supply, as a gap in an otherwise contiguous
     * span. Empty for windows fetched 19–21 days apart; non-empty means a
     * window is missing and the chart has holes the caller should say so about.
     */
    missing: string[];
}

/**
 * Which window a date's data is read from, and at which of its day indices.
 *
 * Interior beats boundary, and among interior days the newest window wins —
 * the later-generated run has seen strictly more of the jobs that landed.
 */
interface DayPlan {
    window: number;
    day: number;
}

/**
 * Joins windows into one timeline, oldest date first.
 *
 * Windows may be given in any order and may overlap by any amount. A single
 * window is returned as-is rather than wrapped, so the common case pays
 * nothing: the composite's `runsOfTest` costs a path lookup per window per
 * test, which is worth avoiding when there is only one.
 */
export function stitchWindows(windows: readonly StitchWindow[]): StitchedTimeline {
    const usable = windows.filter((window) => window.dates.length > 0);
    if (usable.length === 0) {
        throw new Error('stitchWindows needs at least one window with dates');
    }
    const only = usable[0];
    if (usable.length === 1 && only !== undefined) {
        return {
            file: only.file,
            dates: [...only.dates],
            seams: 0,
            missing: [],
        };
    }

    // Plan every date before building anything: which window supplies it and
    // at which of that window's day indices.
    const plans = new Map<string, DayPlan>();
    let seams = 0;
    usable.forEach((window, index) => {
        const last = window.dates.length - 1;
        window.dates.forEach((date, day) => {
            const existing = plans.get(date);
            const candidate: DayPlan = { window: index, day };
            if (existing === undefined) {
                plans.set(date, candidate);
                return;
            }
            // Two windows claim this date — a seam. Prefer whichever holds it
            // as an interior day; if both do, prefer the newer window, whose
            // run was generated later and saw more of the jobs.
            seams++;
            const boundary = day === 0 || day === last;
            const rival = usable[existing.window];
            const rivalBoundary =
                rival === undefined ||
                existing.day === 0 ||
                existing.day === rival.dates.length - 1;
            if (rivalBoundary && !boundary) {
                plans.set(date, candidate);
            } else if (rivalBoundary === boundary && isNewer(window, rival)) {
                plans.set(date, candidate);
            }
        });
    });

    // The span, filled in day by day so the result is calendar-contiguous:
    // `startDateOf` reconstructs a day's date as `endDate - (days - 1) + day`,
    // so a timeline with a hole in it would misdate every label after the hole.
    const known = [...plans.keys()].sort();
    const oldest = known[0];
    const newest = known.at(-1);
    if (oldest === undefined || newest === undefined) {
        throw new Error('stitchWindows found no dates to join');
    }
    const dates = datesBetween(oldest, newest);
    const missing = dates.filter((date) => !plans.has(date));

    // Day index in the stitched timeline -> where to read it from.
    const sources = dates.map((date) => plans.get(date) ?? null);

    return {
        file: compositeFile(usable, dates, sources),
        dates,
        seams,
        missing,
    };
}

/** Whether `a`'s window ends later than `b`'s — i.e. was generated later. */
function isNewer(a: StitchWindow, b: StitchWindow | undefined): boolean {
    if (b === undefined) {
        return true;
    }
    const endA = a.dates.at(-1) ?? '';
    const endB = b.dates.at(-1) ?? '';
    return endA > endB;
}

/** Every date from `from` to `to` inclusive, oldest first. */
function datesBetween(from: string, to: string): string[] {
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
        return [from];
    }
    const dates: string[] = [];
    for (let time = start; time <= end; time += 86_400_000) {
        dates.push(new Date(time).toISOString().slice(0, 10));
    }
    return dates;
}

/**
 * The composite `DecodedTimingFile`.
 *
 * A test is identified by its full path, because the windows have different
 * test-index spaces: index 400 is not the same test in two files, and joining
 * by index would report one test's failures under another's name. The
 * composite's own test IDs are positions in the union of paths, sorted so the
 * numbering is stable across reloads.
 */
function compositeFile(
    windows: readonly StitchWindow[],
    dates: readonly string[],
    sources: readonly (DayPlan | null)[]
): DecodedTimingFile {
    // The union of every window's tests, by path. Built eagerly: unlike a
    // single file's lazy path index, the composite needs the union to answer
    // `testCount` at all.
    const paths = new Set<string>();
    for (const { file } of windows) {
        for (let testId = 0; testId < file.testCount; testId++) {
            paths.add(file.testAt(testId).fullPath);
        }
    }
    const order = [...paths].sort();
    const idByPath = new Map(order.map((path, index) => [path, index]));

    /** Per window, this composite test ID's ID in that window, or -1. */
    const localIds = windows.map(({ file }) => {
        const ids = new Int32Array(order.length).fill(-1);
        for (let testId = 0; testId < file.testCount; testId++) {
            const composite = idByPath.get(file.testAt(testId).fullPath);
            if (composite !== undefined) {
                ids[composite] = testId;
            }
        }
        return ids;
    });

    // Where each window's day index lands in the stitched timeline, or -1 for
    // a day this window does not supply — a seam day another window won, or a
    // day outside the span. Entries mapping to -1 are skipped rather than
    // clamped: `flakiness.ts` uses `day` as an array index and silently drops
    // anything out of range, so a wrong offset here would lose data with no
    // error at all.
    const dayMaps = windows.map(({ dates: windowDates }) =>
        Int32Array.from(windowDates, () => -1)
    );
    sources.forEach((source, day) => {
        if (source === null) {
            return;
        }
        const map = dayMaps[source.window];
        if (map !== undefined) {
            map[source.day] = day;
        }
    });

    // The union of every window's statuses. Status *strings* are what the
    // entries carry, so the composite's table exists only to satisfy
    // `statuses` and to give `statusId` a consistent meaning.
    const statuses = [...new Set(windows.flatMap(({ file }) => [...file.statuses]))].sort();
    const statusIds = new Map(statuses.map((status, index) => [status, index]));

    const newest = windows.reduce((a, b) => (isNewer(b, a) ? b : a), windows[0]!);

    const identityOf = (testId: number): TestIdentity => {
        const path = order[testId];
        if (path === undefined) {
            throw new Error(`no such test in the stitched timeline: ${testId}`);
        }
        for (const [index, { file }] of windows.entries()) {
            const local = localIds[index]?.[testId] ?? -1;
            if (local >= 0) {
                return { ...file.testAt(local), testId };
            }
        }
        throw new Error(`no window holds ${path}`);
    };

    return {
        // The families are identical across windows in practice — the same job
        // publishes them — so the newest window's is the honest answer.
        family: newest.file.family as TimingFamily,
        days: dates.length,
        endDate: dates.at(-1) ?? newest.file.endDate,
        statuses,
        testCount: order.length,

        findTest(fullPath: string): TestIdentity | null {
            const testId = idByPath.get(fullPath);
            return testId === undefined ? null : identityOf(testId);
        },

        testAt: identityOf,

        *runsOfTest(testId: number): Generator<RunEntry> {
            for (const [index, { file }] of windows.entries()) {
                const local = localIds[index]?.[testId] ?? -1;
                if (local < 0) {
                    continue;
                }
                const dayMap = dayMaps[index];
                for (const entry of file.runsOfTest(local)) {
                    // A single-day file's entries carry `day === null`; there
                    // is no window to place them in, so they are left alone.
                    if (entry.day === null) {
                        yield { ...entry, statusId: statusIds.get(entry.status) ?? entry.statusId };
                        continue;
                    }
                    const day = dayMap?.[entry.day] ?? -1;
                    if (day < 0) {
                        continue;
                    }
                    yield {
                        ...entry,
                        day,
                        statusId: statusIds.get(entry.status) ?? entry.statusId,
                    };
                }
            }
        },

        totalsByStatus(testId: number): Map<string, number> {
            // Summed from the entries rather than from each window's own
            // totals: a window contributes only the days it won, so its
            // `totalsByStatus` counts runs this timeline does not show.
            const totals = new Map<string, number>();
            for (const entry of this.runsOfTest(testId)) {
                totals.set(entry.status, (totals.get(entry.status) ?? 0) + entry.count);
            }
            return totals;
        },

        jobNameOfTaskIndex(taskIdIndex: number): string | null {
            // A task index is file-local, so it cannot be resolved without
            // knowing which window an entry came from. Nothing asks: the
            // callers that name a job read `entry.jobName`, which the decode
            // already resolved to a string. Answering `null` is what
            // `{harness}-issues.json` answers too.
            void taskIdIndex;
            return null;
        },
    };
}
