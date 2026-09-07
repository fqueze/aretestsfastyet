/**
 * Loading published files, and resolving `--day` / `--since` against the
 * window they cover.
 *
 * The day logic is the part worth reading, because `CLI.md` makes a claim that
 * is easy to implement wrongly in a way that still produces plausible output:
 *
 * > **Within the 21-day window, `--day` and `--since` are both just filters.**
 *
 * Every status group in a bucket file carries a delta-encoded `days` array —
 * passes, skips, failures, crashes and timeouts alike — so restricting to one
 * day happens during the single pass the command already makes. **`--day` must
 * not fetch a daily file.** The daily files are 10× the size, cover different
 * skips (`FORMATS.md`: the aggregates drop `run-if`, the daily files keep
 * them), and disagree on job membership, so a command that quietly switched
 * families for `--day` would be comparing two different populations depending
 * on a flag.
 *
 * Only two things genuinely need a daily file — per-run timestamps and task
 * IDs for *passing* runs — and both are triggered by the flag that needs them,
 * never by `--day`.
 *
 * ## Day indices
 *
 * A bucket file's entries carry a `day` in `0 … days-1`, **oldest first**, and
 * `metadata.endDate` is the newest. So the date of day *d* is
 * `endDate - (days - 1 - d)` days, and that arithmetic lives here once rather
 * than in each command.
 */

import { bucketFileSuffix, bucketIndexForPath, type BucketFile, decodeBucket } from '../lib/formats/buckets.ts';
import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import { type IssuesFile, decodeIssues } from '../lib/formats/issues.ts';
import type { IndexFile } from '../lib/formats/stats.ts';
import {
    type LoadedTestFile,
    type TestLookupLoaders,
    collectTestPaths,
} from '../lib/query/test-lookup.ts';
import {
    type DataFileName,
    DataFileNotFoundError,
    fetchJson,
    timingsIndex,
} from '../lib/sources/source.ts';
import { type CommandContext, progress } from './context.ts';
import { notFoundError, usageError } from './errors.ts';
import type { GlobalOptions, Harness } from './options.ts';

/**
 * The loaders `resolveTest` needs, over a command's source: the fetching half,
 * which the two front-ends cannot share.
 *
 * `missingFiles` exists because a 404 is swallowed to `null` here but is not the
 * same problem as a typo — an unpublished bucket has to be nameable in the
 * not-found message rather than reported as a missing test.
 */
export function testLookupLoaders(context: CommandContext): TestLookupLoaders<BucketFile> & {
    readonly missingFiles: string[];
} {
    const missingFiles: string[] = [];
    return {
        missingFiles,
        async loadBucket(harness: Harness, testPath: string): Promise<LoadedTestFile<BucketFile> | null> {
            const suffix = bucketFileSuffix(bucketIndexForPath(testPath));
            const name: DataFileName = {
                index: timingsIndex(harness),
                filename: `${harness}-${suffix}.json`,
            };
            try {
                const raw = await fetchJson<BucketFile>(context.source, name);
                return { raw, decoded: decodeBucket(raw) };
            } catch (error) {
                if (error instanceof DataFileNotFoundError) {
                    missingFiles.push(name.filename);
                    return null;
                }
                throw error;
            }
        },
        async loadAllTestPaths(): Promise<string[]> {
            const files = await Promise.all(
                (['xpcshell', 'mochitest'] as Harness[]).map(async (harness) => {
                    try {
                        return await fetchJson<IssuesFile>(context.source, {
                            index: timingsIndex(harness),
                            filename: `${harness}-issues.json`,
                        });
                    } catch (error) {
                        if (error instanceof DataFileNotFoundError) {
                            return null;
                        }
                        throw error;
                    }
                })
            );
            if (files.every((file) => file === null)) {
                // `collectTestPaths` would return `[]`, which the ladder reads
                // as "no test matches" — a claim nothing checked.
                throw new DataFileNotFoundError({
                    index: timingsIndex('xpcshell'),
                    filename: 'xpcshell-issues.json',
                });
            }
            return collectTestPaths(files);
        },
        onStep: (message) => {
            progress(context, message);
        },
    };
}

/** The 21-day aggregate, and the decoded view of it. */
export interface LoadedIssues {
    file: DecodedTimingFile;
    raw: IssuesFile;
    name: DataFileName;
}

/**
 * Loads `{harness}-issues.json`, the tree-wide 21-day aggregate.
 *
 * The small one: 2.8 MB for xpcshell, against 15.7 MB for
 * `issues-with-taskids` and ~3.5 MB × 64 for the buckets. It buys that by
 * discarding **all** attribution — no `taskInfo`, no `jobNameIds` — so every
 * per-configuration question over it has the answer "this file cannot say".
 * `canAttributeConfigs()` is how a caller finds that out before asking, and the
 * tree-wide commands refuse `--config` rather than returning nothing.
 */
export async function loadIssues(
    context: CommandContext,
    harness: Harness
): Promise<LoadedIssues> {
    const name: DataFileName = {
        index: timingsIndex(harness),
        filename: `${harness}-issues.json`,
    };
    const raw = await fetchJson<IssuesFile>(context.source, name);
    return { file: decodeIssues(raw), raw, name };
}

/**
 * The result of a load a command made on its own initiative, or `null` when
 * the file it wanted is not published.
 *
 * The one caller shape is a command that widened its own query — `failures` and
 * `flaky` read the mochitest aggregate as well as the xpcshell one when the path
 * is a directory (`harnessesForPathFilter`). Nothing the reader typed named that
 * file, so a 404 on it is not their mistake: it is the same answer as an empty
 * table, and the command already knows how to print that. Only
 * `DataFileNotFoundError` is swallowed — a network failure or a corrupt file is
 * still an error, because those say nothing about whether the harness has data.
 */
export async function ifPublished<T>(loading: Promise<T>): Promise<T | null> {
    try {
        return await loading;
    } catch (error) {
        if (error instanceof DataFileNotFoundError) {
            return null;
        }
        throw error;
    }
}

/** Reads a harness's `index.json`. */
export async function loadIndex(
    context: CommandContext,
    harness: Harness
): Promise<IndexFile> {
    return fetchJson<IndexFile>(context.source, {
        index: timingsIndex(harness),
        filename: 'index.json',
    });
}

/**
 * A resolved day filter: the range of day indices, and how to describe it.
 *
 * `null` `range` means the whole window, which is the default and is not the
 * same as a range covering every day — a command prints a different header for
 * "21 days" than for "2026-07-30 only".
 */
export interface DayWindow {
    /** Inclusive day-index range, or `null` for the whole window. */
    range: { from: number; to: number } | null;
    /** The first and last dates the range covers. */
    startDate: string;
    endDate: string;
    /** How many days the range covers. */
    dayCount: number;
    /** True when the range is a single day — the trend columns are omitted. */
    singleDay: boolean;
    /** How the range was chosen, for the header line. */
    reason: 'whole-window' | 'day' | 'since';
}

/**
 * Resolves `--day` / `--since` against a file's window.
 *
 * Three behaviours `CLI.md` specifies and this enforces:
 *
 * - **`--day` outside the window is exit 2, naming the window.** Older data is
 *   not gone — Taskcluster keeps artifacts for about a year — but reaching it
 *   means resolving historical index tasks, which nothing does today. Saying
 *   which window is available turns a dead end into a next step.
 * - **`--day today`/`yesterday` resolve to the most recent day *with data*,**
 *   not literally to a calendar date. The index task runs overnight, so
 *   "today" frequently has no file yet, and resolving it literally would exit
 *   2 on the most natural thing to type.
 * - **`--since n` clamps** rather than erroring when `n` exceeds the window:
 *   asking for 60 days of a 21-day file is a reasonable thing to type and the
 *   answer is the 21 days that exist, with the header saying so.
 */
export function resolveDayWindow(
    globals: GlobalOptions,
    file: { days: number | null; endDate: string }
): DayWindow {
    const days = file.days;
    if (days === null) {
        // A daily file is one day; its entries carry `day === null` and
        // `inDayRange()` lets them through. Filtering it further is the caller
        // having already chosen the day.
        return {
            range: null,
            startDate: file.endDate,
            endDate: file.endDate,
            dayCount: 1,
            singleDay: true,
            reason: 'whole-window',
        };
    }

    const oldest = dateOfDayIndex(file.endDate, days, 0);

    if (globals.day !== undefined) {
        const wanted = resolveDayKeyword(globals.day, file.endDate);
        const index = dayIndexOfDate(file.endDate, days, wanted);
        if (index === null) {
            throw notFoundError(
                `no data for ${wanted}: the published window is ${oldest} … ${file.endDate} (${days} days)`,
                'Older data is not fetchable today — the index publishes a rolling window. ' +
                    'Run `fx-tests dates` to see what is available.'
            );
        }
        return {
            range: { from: index, to: index },
            startDate: wanted,
            endDate: wanted,
            dayCount: 1,
            singleDay: true,
            reason: 'day',
        };
    }

    if (globals.since !== undefined) {
        const wanted = Math.min(globals.since, days);
        const from = days - wanted;
        return {
            range: { from, to: days - 1 },
            startDate: dateOfDayIndex(file.endDate, days, from),
            endDate: file.endDate,
            dayCount: wanted,
            singleDay: wanted === 1,
            reason: 'since',
        };
    }

    return {
        range: null,
        startDate: oldest,
        endDate: file.endDate,
        dayCount: days,
        singleDay: days === 1,
        reason: 'whole-window',
    };
}

/**
 * Turns `today` / `yesterday` into a date from the file's window.
 *
 * Relative to the **data**, not to the clock. `CLI.md`: "`--day` resolves to
 * the most recent day with data, not literally yesterday". The index task runs
 * overnight and can be late, so anchoring to the system clock produces a
 * not-found for the most obvious thing a user types, and — worse — silently
 * shifts which day is meant depending on the caller's timezone.
 */
export function resolveDayKeyword(day: string, endDate: string): string {
    if (day === 'today' || day === 'latest') {
        return endDate;
    }
    if (day === 'yesterday') {
        return addDays(endDate, -1);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw usageError(
            `--day expects YYYY-MM-DD, "today" or "yesterday", got "${day}"`
        );
    }
    return day;
}

/** The date `offset` days from `date`, as `YYYY-MM-DD`. */
export function addDays(date: string, offset: number): string {
    const parsed = new Date(`${date}T00:00:00Z`);
    parsed.setUTCDate(parsed.getUTCDate() + offset);
    return parsed.toISOString().slice(0, 10);
}

/**
 * The date a day index refers to.
 *
 * Day 0 is the **oldest**, which is the encoding the files use and the source
 * of a whole class of off-by-a-window mistakes: reading day 0 as "today"
 * produces a chart that is exactly reversed and still looks plausible.
 */
export function dateOfDayIndex(endDate: string, days: number, dayIndex: number): string {
    return addDays(endDate, -(days - 1 - dayIndex));
}

/** The day index of a date, or `null` when it is outside the window. */
export function dayIndexOfDate(
    endDate: string,
    days: number,
    date: string
): number | null {
    const end = Date.parse(`${endDate}T00:00:00Z`);
    const wanted = Date.parse(`${date}T00:00:00Z`);
    if (Number.isNaN(end) || Number.isNaN(wanted)) {
        return null;
    }
    const daysBack = Math.round((end - wanted) / 86_400_000);
    const index = days - 1 - daysBack;
    return index >= 0 && index < days ? index : null;
}

/** Every date in a window, oldest first. */
export function datesOfWindow(endDate: string, days: number): string[] {
    return Array.from({ length: days }, (_, i) => dateOfDayIndex(endDate, days, i));
}
