/**
 * One checker per file family, written directly against the declarations in
 * `lib/formats/`. If a declaration says a field is a `TableIndex[]`, the
 * checker here asserts every entry is an integer in range for that table.
 *
 * The checkers deliberately do not share a generic schema runner: the families
 * differ in ways (the five status-group shapes, the two task-ID conventions)
 * that a schema language would only obscure, and the point of this code is to
 * be obviously right rather than concise.
 */

import type { Checker } from './check.ts';

/** What the caller knows about the file before it is opened. */
export interface FileContext {
    harness: string;
    date?: string;
}

// --- shared pieces -------------------------------------------------------

const AGGREGATE_METADATA_KEYS = [
    'startDate',
    'endDate',
    'days',
    'startTime',
    'generatedAt',
    'totalTestCount',
    'testsWithFailures',
    'aggregatedFrom',
] as const;

/**
 * The 21-day aggregate metadata, shared by issues, issues-with-taskids and the
 * bucket files. Returns the day count, which every `days` array is checked
 * against. `extraKeys` is how the bucket files add `totalBuckets`/`bucketIndex`.
 */
function checkAggregateMetadata(
    c: Checker,
    value: unknown,
    extraKeys: readonly string[] = []
): number {
    if (!c.object(value, '.metadata')) {
        return 0;
    }
    return c.in('.metadata', () => {
        c.noExtraKeys(value, [...AGGREGATE_METADATA_KEYS, ...extraKeys]);
        c.date(value['startDate'], '.startDate');
        c.date(value['endDate'], '.endDate');
        c.integer(value['days'], '.days');
        c.integer(value['startTime'], '.startTime');
        c.timestamp(value['generatedAt'], '.generatedAt');
        c.integer(value['totalTestCount'], '.totalTestCount');
        c.integer(value['testsWithFailures'], '.testsWithFailures');
        // Filenames, not dates — the declaration said dates and the sweep
        // said otherwise.
        if (c.array(value['aggregatedFrom'], '.aggregatedFrom')) {
            for (const entry of value['aggregatedFrom'] as unknown[]) {
                if (c.string(entry, '.aggregatedFrom[]') && !/\d{4}-\d{2}-\d{2}\.json$/.test(entry)) {
                    c.error(
                        `expected a {harness}-{date}.json filename, got ${JSON.stringify(entry)}`,
                        '.aggregatedFrom[]'
                    );
                }
            }
        }
        return typeof value['days'] === 'number' ? value['days'] : 0;
    });
}

const DAILY_METADATA_KEYS = [
    'date',
    'startTime',
    'generatedAt',
    'jobCount',
    'processedJobCount',
    'invalidJobCount',
] as const;

function checkDailyMetadata(c: Checker, value: unknown, extraKeys: readonly string[] = []): void {
    if (!c.object(value, '.metadata')) {
        return;
    }
    c.in('.metadata', () => {
        c.noExtraKeys(value, [...DAILY_METADATA_KEYS, ...extraKeys]);
        c.date(value['date'], '.date');
        c.integer(value['startTime'], '.startTime');
        c.timestamp(value['generatedAt'], '.generatedAt');
        c.integer(value['jobCount'], '.jobCount');
        c.integer(value['processedJobCount'], '.processedJobCount');
        c.integer(value['invalidJobCount'], '.invalidJobCount');
    });
}

/** `taskInfo`: parallel arrays indexed by task-ID index. */
function checkTaskInfo(
    c: Checker,
    value: unknown,
    tables: { repositories: number; jobNames: number; commitIds: number; taskIds: number },
    { expectChunks }: { expectChunks: boolean }
): void {
    if (!c.object(value, '.taskInfo')) {
        return;
    }
    c.in('.taskInfo', () => {
        c.noExtraKeys(value, ['repositoryIds', 'jobNameIds', 'commitIds', 'chunks']);
        c.indexArray(value['repositoryIds'], tables.repositories, 'tables.repositories', '.repositoryIds');
        c.indexArray(value['jobNameIds'], tables.jobNames, 'tables.jobNames', '.jobNameIds');
        c.indexArray(value['commitIds'], tables.commitIds, 'tables.commitIds', '.commitIds');

        const chunks = value['chunks'];
        if (chunks === undefined) {
            c.note('absent', '.chunks');
            if (expectChunks) {
                c.error('declared present on this family but absent', '.chunks');
            }
        } else if (c.array(chunks, '.chunks')) {
            if (!expectChunks) {
                c.error('declared absent on this family but present', '.chunks');
            }
            for (const entry of chunks) {
                if (entry === null) {
                    c.note('null', '.chunks[]');
                    continue;
                }
                c.integer(entry, '.chunks[]');
            }
        }

        const lengths = c.parallel({
            repositoryIds: value['repositoryIds'],
            jobNameIds: value['jobNameIds'],
            commitIds: value['commitIds'],
            ...(Array.isArray(chunks) ? { chunks } : {}),
        });
        if (lengths !== undefined && lengths !== tables.taskIds) {
            c.error(
                `taskInfo has ${lengths} entries but tables.taskIds has ${tables.taskIds}`
            );
        }
    });
}

/** `testInfo`: parallel arrays indexed by test index. Returns the test count. */
function checkTestInfo(
    c: Checker,
    value: unknown,
    tables: { testPaths: number; testNames: number; components: number }
): number {
    if (!c.object(value, '.testInfo')) {
        return 0;
    }
    return c.in('.testInfo', () => {
        c.noExtraKeys(value, ['testPathIds', 'testNameIds', 'componentIds']);
        c.indexArray(value['testPathIds'], tables.testPaths, 'tables.testPaths', '.testPathIds');
        c.indexArray(value['testNameIds'], tables.testNames, 'tables.testNames', '.testNameIds');
        c.indexArray(
            value['componentIds'],
            tables.components,
            'tables.components',
            '.componentIds', 'nullable');
        return (
            c.parallel({
                testPathIds: value['testPathIds'],
                testNameIds: value['testNameIds'],
                componentIds: value['componentIds'],
            }) ?? 0
        );
    });
}

/**
 * Checks that `tables.taskIds` entries carry the `.<retryId>` suffix the
 * timing files use. `JSON_FORMAT.md` warns that the resource files differ;
 * this is where that claim gets tested on the timing side.
 */
function checkSuffixedTaskIds(c: Checker, taskIds: string[], segment: string): void {
    let unsuffixed = 0;
    for (const id of taskIds) {
        if (!/^[A-Za-z0-9_-]+\.\d+$/.test(id)) {
            unsuffixed += 1;
        }
    }
    if (unsuffixed > 0) {
        c.observe('taskIdsWithoutRetrySuffix', `${segment}: ${unsuffixed}/${taskIds.length}`);
    }
}

// --- status groups -------------------------------------------------------

/** Which shape the family+status is declared to use. */
type GroupShape = 'flat' | 'counts' | 'skip-counts' | 'durations' | 'task-ids';

interface GroupTables {
    statuses: string[];
    messages: number;
    crashSignatures: number;
    taskIds: number;
    jobNames: number;
}

const GROUP_KEYS = [
    'days',
    'counts',
    'taskIdIds',
    'durations',
    'timestamps',
    'jobNameIds',
    'messageIds',
    'crashSignatureIds',
    'minidumps',
] as const;

/**
 * Validates one status group and reports which shape it actually has, so the
 * caller can compare against what the family declares.
 *
 * `hasDays` distinguishes the 21-day families from the daily one: it is the
 * same test `getCountAtIndex()` makes, and getting it wrong is how a decoder
 * silently reads a nested array as a flat one.
 */
function checkStatusGroup(
    c: Checker,
    group: Record<string, unknown>,
    status: string,
    tables: GroupTables,
    dayCount: number
): GroupShape {
    c.noExtraKeys(group, GROUP_KEYS);

    const hasDays = group['days'] !== undefined;
    let entryCount: number | undefined;

    if (hasDays) {
        if (c.array(group['days'], '.days')) {
            const days = group['days'] as unknown[];
            entryCount = days.length;
            // Delta-encoded: cumulative sum must stay within [0, dayCount).
            let day = 0;
            for (const delta of days) {
                if (!c.integer(delta, '.days[]')) {
                    continue;
                }
                if (delta < 0) {
                    c.error(`negative day delta ${delta}`, '.days[]');
                }
                day += delta;
                if (day < 0 || day >= dayCount) {
                    c.error(`decoded day ${day} outside 0..${dayCount - 1}`, '.days[]');
                }
            }
        }
    }

    // Identify the shape from the arrays that are present.
    const nestedTaskIds =
        Array.isArray(group['taskIdIds']) && Array.isArray((group['taskIdIds'] as unknown[])[0]);
    const nestedDurations =
        Array.isArray(group['durations']) && Array.isArray((group['durations'] as unknown[])[0]);

    let shape: GroupShape;
    if (!hasDays) {
        shape = 'flat';
    } else if (group['counts'] !== undefined) {
        shape = group['jobNameIds'] !== undefined ? 'skip-counts' : 'counts';
    } else if (group['durations'] !== undefined) {
        shape = 'durations';
    } else if (group['taskIdIds'] !== undefined) {
        shape = 'task-ids';
    } else {
        c.error(`status group for ${status} has none of counts/durations/taskIdIds`);
        return 'counts';
    }

    switch (shape) {
        case 'flat': {
            c.indexArray(group['taskIdIds'], tables.taskIds, 'tables.taskIds', '.taskIdIds');
            c.numberArray(group['durations'], '.durations');
            c.numberArray(group['timestamps'], '.timestamps');
            if (nestedTaskIds || nestedDurations) {
                c.error('daily group has nested arrays where flat ones were declared');
            }
            entryCount = c.parallel({
                taskIdIds: group['taskIdIds'],
                durations: group['durations'],
                timestamps: group['timestamps'],
            });
            break;
        }
        case 'counts': {
            c.numberArray(group['counts'], '.counts', { nonNegative: true });
            if (group['jobNameIds'] !== undefined) {
                c.error('counts group unexpectedly carries jobNameIds');
            }
            if (group['durations'] !== undefined) {
                c.error('counts group unexpectedly carries durations');
            }
            break;
        }
        case 'skip-counts': {
            c.numberArray(group['counts'], '.counts', { nonNegative: true });
            c.indexArray(group['jobNameIds'], tables.jobNames, 'tables.jobNames', '.jobNameIds');
            break;
        }
        case 'durations': {
            if (c.array(group['durations'], '.durations')) {
                for (const bucket of group['durations'] as unknown[]) {
                    c.numberArray(bucket, '.durations[]');
                }
            }
            c.indexArray(group['jobNameIds'], tables.jobNames, 'tables.jobNames', '.jobNameIds');
            if (!nestedDurations && (group['durations'] as unknown[]).length > 0) {
                c.error('bucket PASS group has flat durations where nested were declared');
            }
            break;
        }
        case 'task-ids': {
            if (c.array(group['taskIdIds'], '.taskIdIds')) {
                for (const bucket of group['taskIdIds'] as unknown[]) {
                    c.indexArray(bucket, tables.taskIds, 'tables.taskIds', '.taskIdIds[]');
                }
            }
            if (!nestedTaskIds && (group['taskIdIds'] as unknown[]).length > 0) {
                c.error('group has flat taskIdIds where nested were declared');
            }
            break;
        }
    }

    // `messageIds` presence is decided by the status, not the shape: FAIL* and
    // SKIP always carry it, TIMEOUT*/CRASH/EXPECTED-FAIL/PASS* never do, and
    // no status is mixed. Asserting that here is what would catch the
    // generator starting to attach messages to timeouts — which would
    // otherwise look like an ordinary optional field appearing.
    const expectsMessages = /^(FAIL|SKIP)(-|$)/.test(status);
    if (group['messageIds'] === undefined) {
        if (expectsMessages) {
            c.error(`${status} group has no messageIds, which this status always carries`);
        }
    } else {
        if (!expectsMessages) {
            c.error(`${status} group carries messageIds, which this status never does`);
        }
        c.indexArray(
            group['messageIds'],
            tables.messages,
            'tables.messages',
            '.messageIds',
            'nullable'
        );
    }
    // The mirror image: crashSignatureIds and minidumps are CRASH-only.
    if (group['crashSignatureIds'] !== undefined) {
        if (status !== 'CRASH') {
            c.error(`${status} group carries crashSignatureIds, which only CRASH does`);
        }
        c.indexArray(
            group['crashSignatureIds'],
            tables.crashSignatures,
            'tables.crashSignatures',
            '.crashSignatureIds',
            'nullable'
        );
    } else if (status === 'CRASH') {
        c.error('CRASH group has no crashSignatureIds');
    }
    if (group['minidumps'] !== undefined && status !== 'CRASH') {
        c.error(`${status} group carries minidumps, which only CRASH does`);
    }
    if (group['minidumps'] !== undefined) {
        if (c.array(group['minidumps'], '.minidumps')) {
            for (const entry of group['minidumps'] as unknown[]) {
                if (entry === null) {
                    c.note('null', '.minidumps[]');
                    continue;
                }
                if (shape === 'flat') {
                    // Declared as a flat string per entry in the daily files.
                    if (Array.isArray(entry)) {
                        c.error('daily minidumps entry is an array, declared string', '.minidumps[]');
                    } else {
                        c.string(entry, '.minidumps[]');
                    }
                } else if (c.array(entry, '.minidumps[]')) {
                    for (const id of entry as unknown[]) {
                        if (id === null) {
                            c.note('null', '.minidumps[][]');
                        } else {
                            c.string(id, '.minidumps[][]');
                        }
                    }
                }
            }
        }
    }

    // Every array in a group is parallel to `days` (or to each other, flat).
    const parallelArrays: Record<string, unknown> = {};
    for (const key of GROUP_KEYS) {
        if (Array.isArray(group[key])) {
            parallelArrays[key] = group[key];
        }
    }
    const groupLength = c.parallel(parallelArrays);
    if (entryCount !== undefined && groupLength !== undefined && groupLength !== entryCount) {
        c.error(`group arrays have ${groupLength} entries, days has ${entryCount}`);
    }

    return shape;
}

/**
 * Walks `testRuns` and validates every status group, recording which shapes
 * each status was seen in and counting occurrences per status.
 *
 * The per-status occurrence count is what produces the `UNKNOWN` census: it is
 * a real count of runs, not merely "the string appears in `tables.statuses`".
 */
function checkTestRuns(
    c: Checker,
    testRuns: unknown,
    tables: GroupTables,
    testCount: number,
    dayCount: number,
    family: string,
    harness: string
): void {
    if (!c.array(testRuns, '.testRuns')) {
        return;
    }
    const runs = testRuns as unknown[];
    if (runs.length !== testCount) {
        c.error(`testRuns has ${runs.length} entries but testInfo has ${testCount}`, '.testRuns');
    }

    c.in('.testRuns[]', () => {
        for (const perTest of runs) {
            if (perTest === null) {
                c.note('null');
                continue;
            }
            if (!Array.isArray(perTest)) {
                c.error(`expected an array of status groups, got ${typeof perTest}`);
                continue;
            }
            if (perTest.length > tables.statuses.length) {
                c.error(
                    `${perTest.length} status slots but tables.statuses has ${tables.statuses.length}`
                );
            }
            for (let statusId = 0; statusId < perTest.length; statusId++) {
                const group = perTest[statusId];
                if (group === null || group === undefined) {
                    continue;
                }
                const status = tables.statuses[statusId];
                if (status === undefined) {
                    c.error(`status id ${statusId} out of range for tables.statuses`);
                    continue;
                }
                if (typeof group !== 'object' || Array.isArray(group)) {
                    c.error(`expected a status group object for ${status}`);
                    continue;
                }
                c.in(`[${status}]`, () => {
                    const shape = checkStatusGroup(
                        c,
                        group as Record<string, unknown>,
                        status,
                        tables,
                        dayCount
                    );
                    c.observe('statusShapes', `${family}/${status} -> ${shape}`);
                    c.observe('statusesInUse', status);
                    c.observe(`statusRuns/${harness}`, status, countRuns(group as Record<string, unknown>));
                });
            }
        }
    });
}

/** Number of runs a status group represents, across all its shapes. */
function countRuns(group: Record<string, unknown>): number {
    const counts = group['counts'];
    if (Array.isArray(counts)) {
        let total = 0;
        for (const n of counts) {
            if (typeof n === 'number') {
                total += n;
            }
        }
        return total;
    }
    const durations = group['durations'];
    if (Array.isArray(durations)) {
        let total = 0;
        for (const entry of durations) {
            total += Array.isArray(entry) ? entry.length : 1;
        }
        return total;
    }
    const taskIdIds = group['taskIdIds'];
    if (Array.isArray(taskIdIds)) {
        let total = 0;
        for (const entry of taskIdIds) {
            total += Array.isArray(entry) ? entry.length : 1;
        }
        return total;
    }
    return 0;
}

// --- the file families ---------------------------------------------------

export function checkDaily(c: Checker, data: unknown, ctx: FileContext): void {
    if (!c.object(data)) {
        return;
    }
    c.noExtraKeys(data, ['metadata', 'tables', 'taskInfo', 'testInfo', 'testRuns']);
    checkDailyMetadata(c, data['metadata']);

    const tables = checkTables(c, data['tables'], [
        'jobNames',
        'testPaths',
        'testNames',
        'repositories',
        'taskIds',
        'components',
        'commitIds',
        'statuses',
        'messages',
        'crashSignatures',
    ]);
    checkSuffixedTaskIds(c, tables['taskIds'] ?? [], 'daily tables.taskIds');

    checkTaskInfo(
        c,
        data['taskInfo'],
        {
            repositories: len(tables, 'repositories'),
            jobNames: len(tables, 'jobNames'),
            commitIds: len(tables, 'commitIds'),
            taskIds: len(tables, 'taskIds'),
        },
        { expectChunks: false }
    );
    const testCount = checkTestInfo(c, data['testInfo'], {
        testPaths: len(tables, 'testPaths'),
        testNames: len(tables, 'testNames'),
        components: len(tables, 'components'),
    });

    checkTestRuns(
        c,
        data['testRuns'],
        groupTables(tables),
        testCount,
        1,
        'daily',
        ctx.harness
    );
}

export function checkIssues(c: Checker, data: unknown, ctx: FileContext): void {
    if (!c.object(data)) {
        return;
    }
    c.noExtraKeys(data, ['metadata', 'tables', 'testInfo', 'testRuns']);
    const dayCount = checkAggregateMetadata(c, data['metadata']);
    const tables = checkTables(c, data['tables'], [
        'testPaths',
        'testNames',
        'statuses',
        'messages',
        'crashSignatures',
        'components',
    ]);
    const testCount = checkTestInfo(c, data['testInfo'], {
        testPaths: len(tables, 'testPaths'),
        testNames: len(tables, 'testNames'),
        components: len(tables, 'components'),
    });
    checkTestRuns(c, data['testRuns'], groupTables(tables), testCount, dayCount, 'issues', ctx.harness);
}

export function checkIssuesWithTaskIds(c: Checker, data: unknown, ctx: FileContext): void {
    if (!c.object(data)) {
        return;
    }
    c.noExtraKeys(data, ['metadata', 'tables', 'taskInfo', 'testInfo', 'testRuns']);
    const dayCount = checkAggregateMetadata(c, data['metadata']);
    const tables = checkTables(c, data['tables'], [
        'testPaths',
        'testNames',
        'statuses',
        'messages',
        'crashSignatures',
        'components',
        'jobNames',
        'repositories',
        'taskIds',
        'commitIds',
    ]);
    checkSuffixedTaskIds(c, tables['taskIds'] ?? [], 'issues-with-taskids tables.taskIds');
    checkTaskInfo(
        c,
        data['taskInfo'],
        {
            repositories: len(tables, 'repositories'),
            jobNames: len(tables, 'jobNames'),
            commitIds: len(tables, 'commitIds'),
            taskIds: len(tables, 'taskIds'),
        },
        { expectChunks: false }
    );
    const testCount = checkTestInfo(c, data['testInfo'], {
        testPaths: len(tables, 'testPaths'),
        testNames: len(tables, 'testNames'),
        components: len(tables, 'components'),
    });
    checkTestRuns(
        c,
        data['testRuns'],
        groupTables(tables),
        testCount,
        dayCount,
        'issues-with-taskids',
        ctx.harness
    );
}

export function checkBucket(c: Checker, data: unknown, ctx: FileContext): void {
    if (!c.object(data)) {
        return;
    }
    c.noExtraKeys(data, ['metadata', 'tables', 'taskInfo', 'testInfo', 'testRuns']);
    const dayCount = checkBucketMetadata(c, data['metadata']);
    const tables = checkTables(c, data['tables'], [
        'jobNames',
        'testPaths',
        'testNames',
        'repositories',
        'statuses',
        'taskIds',
        'messages',
        'crashSignatures',
        'components',
        'commitIds',
    ]);
    checkSuffixedTaskIds(c, tables['taskIds'] ?? [], 'bucket tables.taskIds');
    checkTaskInfo(
        c,
        data['taskInfo'],
        {
            repositories: len(tables, 'repositories'),
            jobNames: len(tables, 'jobNames'),
            commitIds: len(tables, 'commitIds'),
            taskIds: len(tables, 'taskIds'),
        },
        { expectChunks: true }
    );
    const testCount = checkTestInfo(c, data['testInfo'], {
        testPaths: len(tables, 'testPaths'),
        testNames: len(tables, 'testNames'),
        components: len(tables, 'components'),
    });
    checkTestRuns(
        c,
        data['testRuns'],
        groupTables(tables),
        testCount,
        dayCount,
        'buckets',
        ctx.harness
    );
}

/** Bucket metadata: the aggregate fields plus `totalBuckets`/`bucketIndex`. */
function checkBucketMetadata(c: Checker, value: unknown): number {
    const dayCount = checkAggregateMetadata(c, value, ['totalBuckets', 'bucketIndex']);
    if (!c.object(value, '.metadata')) {
        return dayCount;
    }
    c.in('.metadata', () => {
        c.integer(value['totalBuckets'], '.totalBuckets');
        c.integer(value['bucketIndex'], '.bucketIndex');
        c.observe('bucketTotals', String(value['totalBuckets']));
    });
    return dayCount;
}

export function checkStats(c: Checker, data: unknown, _ctx: FileContext): void {
    if (!c.object(data)) {
        return;
    }
    const counterKeys = [
        'totalTestRuns',
        'failedTestRuns',
        'skippedTestRuns',
        'processedJobCount',
        'failedJobs',
        'ignoredJobs',
    ] as const;
    c.noExtraKeys(data, [
        'metadata',
        'dates',
        'invalidJobs',
        'flavors',
        'markerCounts',
        ...counterKeys,
    ]);

    if (c.object(data['metadata'], '.metadata')) {
        c.in('.metadata', () => {
            const meta = data['metadata'] as Record<string, unknown>;
            c.noExtraKeys(meta, ['generatedAt', 'harness']);
            c.timestamp(meta['generatedAt'], '.generatedAt');
            c.string(meta['harness'], '.harness');
        });
    }

    let dateCount = 0;
    if (c.array(data['dates'], '.dates')) {
        const dates = data['dates'] as unknown[];
        dateCount = dates.length;
        for (const entry of dates) {
            c.date(entry, '.dates[]');
        }
        // Declared oldest-first, unlike index.json.
        const sorted = [...dates].sort();
        if (JSON.stringify(sorted) !== JSON.stringify(dates)) {
            c.error('dates are not in ascending order', '.dates');
        }
    }

    const checkSeries = (value: unknown, segment: string): void => {
        c.numberArray(value, segment);
        if (Array.isArray(value) && value.length !== dateCount) {
            c.error(`series has ${value.length} entries, dates has ${dateCount}`, segment);
        }
    };

    for (const key of counterKeys) {
        checkSeries(data[key], `.${key}`);
    }
    checkSeries(data['invalidJobs'], '.invalidJobs');

    if (data['flavors'] === undefined) {
        c.note('absent', '.flavors');
    } else if (c.object(data['flavors'], '.flavors')) {
        const flavors = data['flavors'] as Record<string, unknown>;
        for (const [name, value] of Object.entries(flavors)) {
            c.observe('statsFlavors', name);
            if (!c.object(value, `.flavors.${name}`)) {
                continue;
            }
            const flavor = value as Record<string, unknown>;
            c.noExtraKeys(flavor, counterKeys, `.flavors.${name}`);
            for (const key of counterKeys) {
                checkSeries(flavor[key], `.flavors[].${key}`);
            }
        }
    }

    if (data['markerCounts'] === undefined) {
        c.note('absent', '.markerCounts');
    } else if (c.object(data['markerCounts'], '.markerCounts')) {
        const markerCounts = data['markerCounts'] as Record<string, unknown>;
        for (const [kind, series] of Object.entries(markerCounts)) {
            c.observe('markerKinds', kind);
            checkSeries(series, '.markerCounts[]');
        }
    }
}

export function checkIndex(c: Checker, data: unknown, _ctx: FileContext): void {
    if (!c.object(data)) {
        return;
    }
    c.noExtraKeys(data, ['dates']);
    if (c.array(data['dates'], '.dates')) {
        for (const entry of data['dates'] as unknown[]) {
            c.date(entry, '.dates[]');
        }
    }
}

export function checkErrors(c: Checker, data: unknown, ctx: FileContext): void {
    if (!c.object(data)) {
        return;
    }
    c.noExtraKeys(data, ['metadata', 'tables', 'messages', 'taskInfo', 'testInfo', 'markers']);
    checkDailyMetadata(c, data['metadata'], ['markerCounts']);

    if (c.object(data['metadata'], '.metadata')) {
        const meta = data['metadata'] as Record<string, unknown>;
        if (c.object(meta['markerCounts'], '.metadata.markerCounts')) {
            for (const [kind, total] of Object.entries(meta['markerCounts'] as object)) {
                c.observe('markerKinds', kind);
                c.observe(`markerKinds/${ctx.harness}`, kind);
                c.integer(total, '.metadata.markerCounts[]');
            }
        }
    }

    const tables = checkTables(c, data['tables'], [
        'jobNames',
        'testPaths',
        'testNames',
        'repositories',
        'taskIds',
        'components',
        'commitIds',
        'markerNames',
        'messageTexts',
        'files',
    ]);
    checkSuffixedTaskIds(c, tables['taskIds'] ?? [], 'errors tables.taskIds');
    for (const name of tables['markerNames'] ?? []) {
        c.observe('markerKinds', name);
        c.observe(`markerKinds/${ctx.harness}`, name);
    }

    let messageCount = 0;
    if (c.object(data['messages'], '.messages')) {
        const messages = data['messages'] as Record<string, unknown>;
        c.in('.messages', () => {
            c.noExtraKeys(messages, [
                'markerNameIds',
                'textIds',
                'fileIds',
                'lines',
                'componentIds',
            ]);
            c.indexArray(
                messages['markerNameIds'],
                len(tables, 'markerNames'),
                'tables.markerNames',
                '.markerNameIds'
            );
            // textIds, fileIds, lines and componentIds are all nullable — the
            // census recorded nulls in every one of them, including 124
            // textIds on mochitest.
            c.indexArray(
                messages['textIds'],
                len(tables, 'messageTexts'),
                'tables.messageTexts',
                '.textIds',
                'nullable'
            );
            c.indexArray(
                messages['fileIds'],
                len(tables, 'files'),
                'tables.files',
                '.fileIds',
                'nullable'
            );
            c.numberArray(messages['lines'], '.lines', { elements: 'nullable' });
            c.indexArray(
                messages['componentIds'],
                len(tables, 'components'),
                'tables.components',
                '.componentIds', 'nullable');
            messageCount =
                c.parallel({
                    markerNameIds: messages['markerNameIds'],
                    textIds: messages['textIds'],
                    fileIds: messages['fileIds'],
                    lines: messages['lines'],
                    componentIds: messages['componentIds'],
                }) ?? 0;
        });
    }

    checkTaskInfo(
        c,
        data['taskInfo'],
        {
            repositories: len(tables, 'repositories'),
            jobNames: len(tables, 'jobNames'),
            commitIds: len(tables, 'commitIds'),
            taskIds: len(tables, 'taskIds'),
        },
        { expectChunks: false }
    );
    const testCount = checkTestInfo(c, data['testInfo'], {
        testPaths: len(tables, 'testPaths'),
        testNames: len(tables, 'testNames'),
        components: len(tables, 'components'),
    });

    if (c.object(data['markers'], '.markers')) {
        const markers = data['markers'] as Record<string, unknown>;
        c.in('.markers', () => {
            c.noExtraKeys(markers, ['testIds', 'messageIds', 'taskIdIds', 'counts']);
            c.indexArray(markers['testIds'], testCount, 'testInfo', '.testIds');
            c.indexArray(markers['messageIds'], messageCount, 'messages', '.messageIds');

            const taskIdCount = len(tables, 'taskIds');
            if (c.array(markers['taskIdIds'], '.taskIdIds')) {
                for (const bucket of markers['taskIdIds'] as unknown[]) {
                    if (!Array.isArray(bucket)) {
                        c.error('expected an array of delta-encoded indices', '.taskIdIds[]');
                        continue;
                    }
                    // Delta-encoded within the group, starting from 0.
                    let taskId = 0;
                    for (const delta of bucket) {
                        if (!c.integer(delta, '.taskIdIds[][]')) {
                            continue;
                        }
                        if (delta < 0) {
                            c.error(`negative task-id delta ${delta}`, '.taskIdIds[][]');
                        }
                        taskId += delta;
                        if (taskId < 0 || taskId >= taskIdCount) {
                            c.error(
                                `decoded task-id index ${taskId} out of range for tables.taskIds (${taskIdCount})`,
                                '.taskIdIds[][]'
                            );
                        }
                    }
                }
            }
            if (c.array(markers['counts'], '.counts')) {
                for (const bucket of markers['counts'] as unknown[]) {
                    c.numberArray(bucket, '.counts[]', { nonNegative: true });
                }
            }

            c.parallel({
                testIds: markers['testIds'],
                messageIds: markers['messageIds'],
                taskIdIds: markers['taskIdIds'],
                counts: markers['counts'],
            });

            // taskIdIds[i] and counts[i] are parallel within a group.
            const taskIdIds = markers['taskIdIds'];
            const counts = markers['counts'];
            if (Array.isArray(taskIdIds) && Array.isArray(counts)) {
                for (let i = 0; i < taskIdIds.length; i++) {
                    const a = taskIdIds[i];
                    const b = counts[i];
                    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) {
                        c.error(
                            `group has ${a.length} taskIdIds but ${b.length} counts`,
                            '.taskIdIds[]'
                        );
                        break;
                    }
                }
            }
        });
    }
}

export function checkManifests(c: Checker, data: unknown, _ctx: FileContext): void {
    if (!c.object(data)) {
        return;
    }
    c.noExtraKeys(data, [
        'metadata',
        'manifests',
        'jobNames',
        'commits',
        'prefixes',
        'tasks',
        'runs',
    ]);

    if (c.object(data['metadata'], '.metadata')) {
        const meta = data['metadata'] as Record<string, unknown>;
        c.in('.metadata', () => {
            c.noExtraKeys(meta, [
                'date',
                'repository',
                'generatedAt',
                'processedJobCount',
                'failedJobCount',
            ]);
            c.date(meta['date'], '.date');
            c.string(meta['repository'], '.repository');
            c.timestamp(meta['generatedAt'], '.generatedAt');
            c.integer(meta['processedJobCount'], '.processedJobCount');
            c.integer(meta['failedJobCount'], '.failedJobCount');
        });
    }

    const manifests = c.stringTable(data['manifests'], '.manifests');
    const jobNames = c.stringTable(data['jobNames'], '.jobNames');
    const commits = c.stringTable(data['commits'], '.commits');
    const prefixes = c.stringTable(data['prefixes'], '.prefixes');

    let taskCount = 0;
    if (c.object(data['tasks'], '.tasks')) {
        const tasks = data['tasks'] as Record<string, unknown>;
        c.in('.tasks', () => {
            c.noExtraKeys(tasks, ['id', 'jobName', 'commitId', 'prefix']);
            const ids = c.stringTable(tasks['id'], '.id');
            // Declared as bare task IDs, unlike the timing files.
            const suffixed = ids.filter((id) => id.includes('.')).length;
            if (suffixed > 0) {
                c.observe('manifestTaskIdsWithSuffix', `${suffixed}/${ids.length}`);
            }
            c.indexArray(tasks['jobName'], jobNames.length, 'jobNames', '.jobName');
            c.indexArray(tasks['commitId'], commits.length, 'commits', '.commitId');
            c.indexArray(tasks['prefix'], prefixes.length, 'prefixes', '.prefix');
            for (const prefix of prefixes) {
                c.observe('manifestPrefixes', prefix);
            }
            taskCount =
                c.parallel({
                    id: tasks['id'],
                    jobName: tasks['jobName'],
                    commitId: tasks['commitId'],
                    prefix: tasks['prefix'],
                }) ?? 0;
        });
    }

    if (c.object(data['runs'], '.runs')) {
        const runs = data['runs'] as Record<string, unknown>;
        c.in('.runs', () => {
            c.noExtraKeys(runs, ['manifestIds', 'jobNameIds', 'taskIds', 'durations']);
            c.indexArray(runs['manifestIds'], manifests.length, 'manifests', '.manifestIds');
            c.indexArray(runs['jobNameIds'], jobNames.length, 'jobNames', '.jobNameIds');
            c.indexArray(runs['taskIds'], taskCount, 'tasks', '.taskIds');
            c.numberArray(runs['durations'], '.durations', { nonNegative: true });
            c.parallel({
                manifestIds: runs['manifestIds'],
                jobNameIds: runs['jobNameIds'],
                taskIds: runs['taskIds'],
                durations: runs['durations'],
            });

            // `runs.jobNameIds[i]` is the chunk-stripped job name and
            // `tasks.jobName[runs.taskIds[i]]` keeps the chunk suffix. They
            // are not interchangeable, and the two must agree once the
            // suffix is stripped — if they ever stop agreeing, one of them
            // means something this code does not know about.
            const runJobNames = runs['jobNameIds'];
            const runTaskIds = runs['taskIds'];
            const tasks = data['tasks'];
            if (
                Array.isArray(runJobNames) &&
                Array.isArray(runTaskIds) &&
                typeof tasks === 'object' &&
                tasks !== null
            ) {
                const taskJobName = (tasks as Record<string, unknown>)['jobName'];
                if (Array.isArray(taskJobName)) {
                    let chunkOnly = 0;
                    let unexplained = 0;
                    let zeroDurations = 0;
                    const durations = runs['durations'];
                    for (let i = 0; i < runJobNames.length; i++) {
                        const viaRun = jobNames[runJobNames[i] as number];
                        const viaTask = jobNames[taskJobName[runTaskIds[i] as number] as number];
                        if (viaRun !== viaTask) {
                            if (viaTask?.replace(/-\d+$/, '') === viaRun) {
                                chunkOnly += 1;
                            } else {
                                unexplained += 1;
                                if (unexplained === 1) {
                                    c.error(
                                        `runs.jobNameIds says ${JSON.stringify(viaRun)} but ` +
                                            `tasks.jobName says ${JSON.stringify(viaTask)}, ` +
                                            'which is not a chunk-suffix difference',
                                        '.jobNameIds'
                                    );
                                }
                            }
                        }
                        if (Array.isArray(durations) && durations[i] === 0) {
                            zeroDurations += 1;
                        }
                    }
                    c.observe(
                        'manifestJobNameChunkSuffix',
                        `${chunkOnly}/${runJobNames.length} runs differ by chunk suffix only, ` +
                            `${unexplained} otherwise`
                    );
                    c.observe(
                        'manifestZeroDurations',
                        `${zeroDurations}/${runJobNames.length} runs`
                    );
                }
            }
        });
    }
}

export function checkResources(c: Checker, data: unknown, _ctx: FileContext): void {
    if (!c.object(data)) {
        return;
    }
    c.noExtraKeys(data, ['jobNames', 'repositories', 'machineInfos', 'jobs']);
    if (data['metadata'] !== undefined) {
        c.error('resources file unexpectedly carries metadata', '.metadata');
    }

    const jobNames = c.stringTable(data['jobNames'], '.jobNames');
    const repositories = c.stringTable(data['repositories'], '.repositories');

    let machineInfoCount = 0;
    if (c.array(data['machineInfos'], '.machineInfos')) {
        const infos = data['machineInfos'] as unknown[];
        machineInfoCount = infos.length;
        c.in('.machineInfos[]', () => {
            for (const info of infos) {
                if (!c.object(info)) {
                    continue;
                }
                const m = info as Record<string, unknown>;
                c.noExtraKeys(m, ['logicalCPUs', 'physicalCPUs', 'mainMemory']);
                c.integer(m['logicalCPUs'], '.logicalCPUs');
                c.integer(m['physicalCPUs'], '.physicalCPUs');
                c.number(m['mainMemory'], '.mainMemory');
            }
        });
    }

    if (c.object(data['jobs'], '.jobs')) {
        const jobs = data['jobs'] as Record<string, unknown>;
        c.in('.jobs', () => {
            c.noExtraKeys(jobs, [
                'jobNameIds',
                'chunks',
                'taskIds',
                'repositoryIds',
                'startTimes',
                'machineInfoIds',
                'maxMemories',
                'idleTimes',
                'singleCoreTimes',
                'cpuBuckets',
            ]);
            c.indexArray(jobs['jobNameIds'], jobNames.length, 'jobNames', '.jobNameIds');
            if (c.array(jobs['chunks'], '.chunks')) {
                for (const chunk of jobs['chunks'] as unknown[]) {
                    if (chunk === null) {
                        c.note('null', '.chunks[]');
                        continue;
                    }
                    c.integer(chunk, '.chunks[]');
                }
            }
            const taskIds = c.stringTable(jobs['taskIds'], '.taskIds');
            // Declared: `.0` omitted, other retries suffixed.
            const suffixed = taskIds.filter((id) => id.includes('.')).length;
            const dotZero = taskIds.filter((id) => id.endsWith('.0')).length;
            c.observe(
                'resourceTaskIdSuffixes',
                `${suffixed}/${taskIds.length} suffixed, ${dotZero} ending .0`
            );
            c.indexArray(
                jobs['repositoryIds'],
                repositories.length,
                'repositories',
                '.repositoryIds'
            );
            c.numberArray(jobs['startTimes'], '.startTimes');
            c.indexArray(
                jobs['machineInfoIds'],
                machineInfoCount,
                'machineInfos',
                '.machineInfoIds'
            );
            c.numberArray(jobs['maxMemories'], '.maxMemories');
            c.numberArray(jobs['idleTimes'], '.idleTimes');
            c.numberArray(jobs['singleCoreTimes'], '.singleCoreTimes');

            if (c.array(jobs['cpuBuckets'], '.cpuBuckets')) {
                for (const bucket of jobs['cpuBuckets'] as unknown[]) {
                    if (!c.array(bucket, '.cpuBuckets[]')) {
                        continue;
                    }
                    if ((bucket as unknown[]).length !== 10) {
                        c.error(
                            `expected 10 CPU buckets, got ${(bucket as unknown[]).length}`,
                            '.cpuBuckets[]'
                        );
                    }
                    c.numberArray(bucket, '.cpuBuckets[]');
                }
            }

            c.parallel({
                jobNameIds: jobs['jobNameIds'],
                chunks: jobs['chunks'],
                taskIds: jobs['taskIds'],
                repositoryIds: jobs['repositoryIds'],
                startTimes: jobs['startTimes'],
                machineInfoIds: jobs['machineInfoIds'],
                maxMemories: jobs['maxMemories'],
                idleTimes: jobs['idleTimes'],
                singleCoreTimes: jobs['singleCoreTimes'],
                cpuBuckets: jobs['cpuBuckets'],
            });
        });
    }
}

export function checkStackwalk(c: Checker, data: unknown, _ctx: FileContext): void {
    if (!c.object(data)) {
        return;
    }
    c.noExtraKeys(data, [
        'crash_info',
        'crashing_thread',
        'handles',
        'linux_memory_map_count',
        'lsb_release',
        'mac_boot_args',
        'mac_crash_info',
        'main_module',
        'modules',
        'modules_contains_cert_info',
        'pid',
        'proc_limits',
        'soft_errors',
        'status',
        'system_info',
        'thread_count',
        'threads',
        'unloaded_modules',
    ]);

    c.string(data['status'], '.status');
    c.integer(data['thread_count'], '.thread_count');
    c.integer(data['main_module'], '.main_module');
    c.integer(data['pid'], '.pid');
    c.boolean(data['modules_contains_cert_info'], '.modules_contains_cert_info');

    let threadCount = 0;
    if (c.array(data['threads'], '.threads')) {
        const threads = data['threads'] as unknown[];
        threadCount = threads.length;
        if (typeof data['thread_count'] === 'number' && data['thread_count'] !== threadCount) {
            c.error(
                `thread_count is ${data['thread_count']} but threads has ${threadCount}`,
                '.threads'
            );
        }
        c.in('.threads[]', () => {
            for (const thread of threads) {
                checkThread(c, thread);
            }
        });
    }
    c.observe('stackwalkThreadCounts', String(threadCount));

    if (data['crash_info'] === undefined) {
        c.note('absent', '.crash_info');
    } else if (c.object(data['crash_info'], '.crash_info')) {
        const info = data['crash_info'] as Record<string, unknown>;
        c.in('.crash_info', () => {
            c.noExtraKeys(info, [
                'address',
                'adjusted_address',
                'assertion',
                'crash_inconsistencies',
                'crashing_thread',
                'instruction',
                'instruction_pointer_update',
                'memory_accesses',
                'possible_bit_flips',
                'type',
            ]);
            c.string(info['address'], '.address');
            c.string(info['type'], '.type');
            c.observe('crashTypes', String(info['type']));
            if (info['adjusted_address'] === null) {
                c.note('null', '.adjusted_address');
            } else if (c.object(info['adjusted_address'], '.adjusted_address')) {
                const adjusted = info['adjusted_address'] as Record<string, unknown>;
                c.noExtraKeys(adjusted, ['kind', 'offset'], '.adjusted_address');
                c.string(adjusted['kind'], '.adjusted_address.kind');
                c.observe('adjustedAddressKinds', String(adjusted['kind']));
            }
            if (info['assertion'] === null) {
                c.note('null', '.assertion');
            } else {
                c.string(info['assertion'], '.assertion');
            }
            if (info['instruction'] === null) {
                c.note('null', '.instruction');
            } else {
                c.string(info['instruction'], '.instruction');
            }
            if (
                c.index(
                    info['crashing_thread'],
                    threadCount,
                    'threads',
                    '.crashing_thread'
                )
            ) {
                // fine
            }
        });
    }

    if (data['crashing_thread'] === undefined) {
        c.note('absent', '.crashing_thread');
    } else {
        c.in('.crashing_thread', () => {
            checkThread(c, data['crashing_thread'], { expectThreadsIndex: true });
        });
    }

    if (c.array(data['modules'], '.modules')) {
        c.in('.modules[]', () => {
            for (const module of data['modules'] as unknown[]) {
                checkModule(c, module);
            }
        });
    }
    if (data['unloaded_modules'] !== undefined && c.array(data['unloaded_modules'], '.unloaded_modules')) {
        // Entries have a different, smaller shape than loaded modules; only
        // their presence and array-ness are declared.
    }

    if (c.object(data['system_info'], '.system_info')) {
        const info = data['system_info'] as Record<string, unknown>;
        c.in('.system_info', () => {
            c.noExtraKeys(info, [
                'cpu_arch',
                'cpu_count',
                'cpu_info',
                'cpu_microcode_version',
                'os',
                'os_ver',
            ]);
            c.string(info['cpu_arch'], '.cpu_arch');
            c.integer(info['cpu_count'], '.cpu_count');
            c.string(info['os'], '.os');
            c.string(info['os_ver'], '.os_ver');
            c.observe('stackwalkOS', `${info['os']}`);
            if (info['cpu_info'] === null) {
                c.note('null', '.cpu_info');
            }
            if (info['cpu_microcode_version'] === null) {
                c.note('null', '.cpu_microcode_version');
            }
        });
    }
}

function checkThread(
    c: Checker,
    value: unknown,
    { expectThreadsIndex = false } = {}
): void {
    if (!c.object(value)) {
        return;
    }
    const thread = value as Record<string, unknown>;
    c.noExtraKeys(thread, [
        'frame_count',
        'frames',
        'last_error_value',
        'thread_id',
        'thread_name',
        'threads_index',
    ]);
    c.integer(thread['frame_count'], '.frame_count');
    c.integer(thread['thread_id'], '.thread_id');
    if (thread['thread_name'] === null) {
        c.note('null', '.thread_name');
    } else {
        c.string(thread['thread_name'], '.thread_name');
    }
    if (thread['threads_index'] === undefined) {
        c.note('absent', '.threads_index');
        if (expectThreadsIndex) {
            c.error('declared present on crashing_thread but absent', '.threads_index');
        }
    } else {
        c.integer(thread['threads_index'], '.threads_index');
    }

    if (c.array(thread['frames'], '.frames')) {
        const frames = thread['frames'] as unknown[];
        if (typeof thread['frame_count'] === 'number' && thread['frame_count'] !== frames.length) {
            c.error(
                `frame_count is ${thread['frame_count']} but frames has ${frames.length}`,
                '.frames'
            );
        }
        c.in('.frames[]', () => {
            for (const frame of frames) {
                checkFrame(c, frame);
            }
        });
    }
}

function checkFrame(c: Checker, value: unknown): void {
    if (!c.object(value)) {
        return;
    }
    const frame = value as Record<string, unknown>;
    c.noExtraKeys(frame, [
        'frame',
        'function',
        'function_offset',
        'file',
        'line',
        'module',
        'module_offset',
        'offset',
        'missing_symbols',
        'inlines',
        'registers',
        'trust',
        'unloaded_modules',
    ]);
    c.integer(frame['frame'], '.frame');
    c.string(frame['offset'], '.offset');
    c.boolean(frame['missing_symbols'], '.missing_symbols');
    c.string(frame['trust'], '.trust');
    c.observe('frameTrust', String(frame['trust']));

    for (const key of ['function', 'function_offset', 'file', 'module', 'module_offset'] as const) {
        if (frame[key] === null) {
            c.note('null', `.${key}`);
        } else if (frame[key] === undefined) {
            c.note('absent', `.${key}`);
        } else {
            c.string(frame[key], `.${key}`);
        }
    }
    if (frame['line'] === null) {
        c.note('null', '.line');
    } else if (frame['line'] === undefined) {
        c.note('absent', '.line');
    } else {
        c.integer(frame['line'], '.line');
    }

    if (frame['inlines'] === undefined) {
        c.note('absent', '.inlines');
    } else if (frame['inlines'] === null) {
        c.note('null', '.inlines');
    } else if (c.array(frame['inlines'], '.inlines')) {
        c.in('.inlines[]', () => {
            for (const inline of frame['inlines'] as unknown[]) {
                if (!c.object(inline)) {
                    continue;
                }
                const i = inline as Record<string, unknown>;
                c.noExtraKeys(i, ['file', 'function', 'line']);
                for (const key of ['file', 'function'] as const) {
                    if (i[key] === null) {
                        c.note('null', `.${key}`);
                    } else {
                        c.string(i[key], `.${key}`);
                    }
                }
                if (i['line'] === null) {
                    c.note('null', '.line');
                } else {
                    c.integer(i['line'], '.line');
                }
            }
        });
    }

    if (frame['registers'] === undefined) {
        c.note('absent', '.registers');
    } else if (c.object(frame['registers'], '.registers')) {
        for (const [name, addr] of Object.entries(frame['registers'] as object)) {
            c.string(addr, '.registers[]');
            void name;
        }
    }
}

function checkModule(c: Checker, value: unknown): void {
    if (!c.object(value)) {
        return;
    }
    const module = value as Record<string, unknown>;
    c.noExtraKeys(module, [
        'base_addr',
        'end_addr',
        'code_id',
        'cert_subject',
        'corrupt_symbols',
        'debug_file',
        'debug_id',
        'filename',
        'loaded_symbols',
        'missing_symbols',
        'symbol_url',
        'version',
    ]);
    c.string(module['base_addr'], '.base_addr');
    c.string(module['end_addr'], '.end_addr');
    c.string(module['filename'], '.filename');
    for (const key of [
        'code_id',
        'cert_subject',
        'debug_file',
        'debug_id',
        'symbol_url',
        'version',
    ] as const) {
        if (module[key] === null) {
            c.note('null', `.${key}`);
        } else if (module[key] === undefined) {
            c.note('absent', `.${key}`);
        } else {
            c.string(module[key], `.${key}`);
        }
    }
    for (const key of ['corrupt_symbols', 'loaded_symbols', 'missing_symbols'] as const) {
        if (module[key] === null) {
            c.note('null', `.${key}`);
        } else if (module[key] === undefined) {
            c.note('absent', `.${key}`);
        } else {
            c.boolean(module[key], `.${key}`);
        }
    }
}

// --- helpers -------------------------------------------------------------

/** Validates a `tables` object and returns its string tables by name. */
function checkTables(
    c: Checker,
    value: unknown,
    expected: readonly string[]
): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    if (!c.object(value, '.tables')) {
        return out;
    }
    c.in('.tables', () => {
        c.noExtraKeys(value, expected);
        for (const name of expected) {
            if (value[name] === undefined) {
                c.note('absent', `.${name}`);
                out[name] = [];
                continue;
            }
            out[name] = c.stringTable(value[name], `.${name}`);
        }
    });
    return out;
}

function len(tables: Record<string, string[]>, name: string): number {
    return tables[name]?.length ?? 0;
}

function groupTables(tables: Record<string, string[]>): GroupTables {
    return {
        statuses: tables['statuses'] ?? [],
        messages: len(tables, 'messages'),
        crashSignatures: len(tables, 'crashSignatures'),
        taskIds: len(tables, 'taskIds'),
        jobNames: len(tables, 'jobNames'),
    };
}

/** Every status string in `tables.statuses`, whether or not it is used. */
export function observeStatusTable(c: Checker, data: unknown, harness: string): void {
    if (typeof data !== 'object' || data === null) {
        return;
    }
    const tables = (data as Record<string, unknown>)['tables'];
    if (typeof tables !== 'object' || tables === null) {
        return;
    }
    const statuses = (tables as Record<string, unknown>)['statuses'];
    if (!Array.isArray(statuses)) {
        return;
    }
    for (const status of statuses) {
        if (typeof status === 'string') {
            c.observe('statusesDeclared', status);
            c.observe(`statusesDeclared/${harness}`, status);
        }
    }
}

/**
 * A captured Try push: what `try.html` and `fx-tests try` read from Treeherder,
 * plus the per-task timings pulled from each failing job's profile.
 *
 * Unlike every other family here this is not a published artefact — it is a
 * recording, made so the page and the CLI can be driven over a real push
 * without the network. It is checked for the same reason the others are: a
 * fixture is a *subset*, and the interesting invariant survives subsetting only
 * if something asserts it. Here that invariant is the join — every timing names
 * a `(taskId, retryId)`, and a capture that kept a timing while dropping its
 * job would still parse, still look plausible, and quietly change what the
 * page computes for that row.
 */
export function checkTryPush(c: Checker, data: unknown, _ctx: FileContext): void {
    if (!c.object(data)) {
        return;
    }
    c.noExtraKeys(data, ['push', 'jobs', 'timings']);
    c.string(data['push'], '.push');

    // `(taskId, retryId)` is the key a timing joins on: a task that was retried
    // has several runs under one task ID, and the page attributes a failure to
    // the run rather than the task.
    const runs = new Set<string>();
    const jobs = c.array(data['jobs'], '.jobs') ? data['jobs'] : [];
    for (const [i, job] of jobs.entries()) {
        const at = `.jobs[${i}]`;
        if (!c.object(job, at)) {
            continue;
        }
        c.noExtraKeys(job, ['jobId', 'jobName', 'taskId', 'retryId', 'state', 'result'], at);
        c.integer(job['jobId'], `${at}.jobId`);
        c.string(job['jobName'], `${at}.jobName`);
        c.string(job['state'], `${at}.state`);
        c.string(job['result'], `${at}.result`);
        const taskId = job['taskId'];
        const retryId = job['retryId'];
        if (c.string(taskId, `${at}.taskId`) && c.integer(retryId, `${at}.retryId`)) {
            runs.add(`${taskId}.${retryId}`);
        }
        c.observe('tryJobStates', String(job['state']));
        c.observe('tryJobResults', String(job['result']));
    }

    const timings = c.array(data['timings'], '.timings') ? data['timings'] : [];
    for (const [i, timing] of timings.entries()) {
        const at = `.timings[${i}]`;
        if (!c.object(timing, at)) {
            continue;
        }
        c.noExtraKeys(
            timing,
            [
                'path',
                'duration',
                'status',
                'timestamp',
                'allMessages',
                'message',
                'isRetry',
                'crashSignature',
                'minidump',
                'jobName',
                'taskId',
                'retryId',
            ],
            at
        );
        c.string(timing['path'], `${at}.path`);
        c.number(timing['duration'], `${at}.duration`);
        c.string(timing['status'], `${at}.status`);
        c.number(timing['timestamp'], `${at}.timestamp`);
        c.string(timing['jobName'], `${at}.jobName`);
        // Absent rather than null when they do not apply, so `optional` and not
        // `nullable`. Measured on this capture: `message` on 117 of 180
        // timings, `isRetry` on 82, and the crash pair on exactly the 4 CRASHes.
        c.string(timing['message'], `${at}.message`, 'optional');
        c.boolean(timing['isRetry'], `${at}.isRetry`, 'optional');
        c.string(timing['crashSignature'], `${at}.crashSignature`, 'optional');
        c.string(timing['minidump'], `${at}.minidump`, 'optional');

        const messages = c.array(timing['allMessages'], `${at}.allMessages`)
            ? (timing['allMessages'] as unknown[])
            : [];
        for (const [j, message] of messages.entries()) {
            const mAt = `${at}.allMessages[${j}]`;
            if (!c.object(message, mAt)) {
                continue;
            }
            c.noExtraKeys(message, ['message', 'status', 'stack'], mAt);
            c.string(message['message'], `${mAt}.message`, 'nullable');
            c.string(message['status'], `${mAt}.status`);
            c.string(message['stack'], `${mAt}.stack`, 'optional');
        }

        // The join. A timing whose run is not in the capture is the subsetting
        // bug this whole file exists to catch.
        const taskId = timing['taskId'];
        const retryId = timing['retryId'];
        if (c.string(taskId, `${at}.taskId`) && c.integer(retryId, `${at}.retryId`)) {
            if (!runs.has(`${taskId}.${retryId}`)) {
                c.error(`names run ${taskId}.${retryId}, which is not in .jobs`, `${at}.taskId`);
            }
        }
        c.observe('tryTimingStatuses', String(timing['status']));
    }
}

/**
 * A recorded Treeherder intermittents response, as
 * `test/intermittents-fixture-gen.ts` writes it.
 *
 * Someone else's API rather than this repository's output, but checked for the
 * reason the rest of this file exists: the fixture joins two responses, and the
 * join breaks silently. A `failuresbybug` key absent from `failures` means
 * occurrences were kept for a bug no ranking holds.
 */
export function checkIntermittents(c: Checker, data: unknown, _ctx: FileContext): void {
    if (!c.object(data)) {
        return;
    }
    c.noExtraKeys(data, [
        'note',
        'tree',
        'startday',
        'endday',
        'failures',
        'summaries',
        'knownTestPaths',
        'failuresbybug',
        'runIds',
    ]);
    c.string(data['note'], '.note');
    c.string(data['tree'], '.tree');
    c.date(data['startday'], '.startday');
    c.date(data['endday'], '.endday');

    /** The bug numbers the ranking holds, for the join below. */
    const ranked = new Set<number>();
    if (c.array(data['failures'], '.failures')) {
        let previous = Infinity;
        for (const [i, row] of (data['failures'] as unknown[]).entries()) {
            const at = `.failures[${i}]`;
            if (!c.object(row, at)) {
                continue;
            }
            c.noExtraKeys(row, ['bug_id', 'bug_count'], at);
            // Nullable: the largest group is regularly the no-bug one.
            if (c.integer(row['bug_id'], `${at}.bug_id`, 'nullable')) {
                ranked.add(row['bug_id'] as number);
            }
            if (c.integer(row['bug_count'], `${at}.bug_count`)) {
                const bugCount = row['bug_count'] as number;
                // Scans walk this in arrival order, so a differently sorted
                // fixture would make "the top N" mean nothing.
                if (bugCount > previous) {
                    c.error(
                        `bug_count ${bugCount} is above the previous row's ${previous}; ` +
                            `the ranking must be count-descending`,
                        `${at}.bug_count`
                    );
                }
                previous = bugCount;
            }
        }
    }

    // Every ranked bug needs a summary: classification reads it, so a bug
    // recorded without one would classify as "no test path" for the wrong
    // reason and a test asserting that would pass vacuously.
    if (c.object(data['summaries'], '.summaries')) {
        const summaries = data['summaries'] as Record<string, unknown>;
        for (const bug of ranked) {
            if (!(String(bug) in summaries)) {
                c.error(`bug ${bug} is ranked but has no summary`, '.summaries');
            }
        }
        for (const [key, value] of Object.entries(summaries)) {
            c.string(value, `.summaries["${key}"]`);
        }
    }

    if (c.object(data['knownTestPaths'], '.knownTestPaths')) {
        const known = data['knownTestPaths'] as Record<string, unknown>;
        c.noExtraKeys(known, ['mochitest', 'xpcshell'], '.knownTestPaths');
        for (const harness of ['mochitest', 'xpcshell']) {
            const at = `.knownTestPaths.${harness}`;
            if (c.array(known[harness], at)) {
                for (const [i, path] of (known[harness] as unknown[]).entries()) {
                    c.string(path, `${at}[${i}]`);
                }
            }
        }
    }

    // `/api/failuresbybug/` carries no run index, so it is recorded separately
    // from `/api/jobs/` and joined on `job_id`. A recorded job with no run index
    // is the same silent-subsetting failure the rest of this file catches: the
    // occurrence would print a bare task ID and the test asserting the run would
    // pass vacuously.
    const runIds = new Set<string>();
    if (c.object(data['runIds'], '.runIds')) {
        for (const [key, value] of Object.entries(data['runIds'] as Record<string, unknown>)) {
            runIds.add(key);
            c.integer(value, `.runIds["${key}"]`);
        }
    }

    if (!c.object(data['failuresbybug'], '.failuresbybug')) {
        return;
    }
    for (const [key, rows] of Object.entries(data['failuresbybug'] as Record<string, unknown>)) {
        const at = `.failuresbybug["${key}"]`;
        const bug = Number(key);
        if (!Number.isInteger(bug)) {
            c.error('key is not a bug number', at);
            continue;
        }
        // The join this checker exists for.
        if (!ranked.has(bug)) {
            c.error(`bug ${bug} has occurrences but is not in .failures`, at);
        }
        if (!c.array(rows, at)) {
            continue;
        }
        for (const [i, row] of (rows as unknown[]).entries()) {
            const rowAt = `${at}[${i}]`;
            if (!c.object(row, rowAt)) {
                continue;
            }
            c.noExtraKeys(
                row,
                [
                    'bug_id',
                    'test_suite',
                    'platform',
                    'build_type',
                    'revision',
                    'tree',
                    'push_time',
                    'job_id',
                    'machine_name',
                    'task_id',
                    'lines',
                ],
                rowAt
            );
            c.integer(row['bug_id'], `${rowAt}.bug_id`, 'nullable');
            c.string(row['test_suite'], `${rowAt}.test_suite`);
            c.string(row['platform'], `${rowAt}.platform`);
            c.string(row['build_type'], `${rowAt}.build_type`);
            c.string(row['revision'], `${rowAt}.revision`);
            c.string(row['tree'], `${rowAt}.tree`);
            c.string(row['push_time'], `${rowAt}.push_time`);
            if (
                c.integer(row['job_id'], `${rowAt}.job_id`) &&
                !runIds.has(String(row['job_id']))
            ) {
                c.error(
                    `job ${String(row['job_id'])} has no entry in .runIds, so its run index ` +
                        `is unknown`,
                    `${rowAt}.job_id`
                );
            }
            c.string(row['machine_name'], `${rowAt}.machine_name`);
            // `"unknown"` when Treeherder has no Taskcluster metadata for the
            // job (`intermittents_view.py:98`), so it is a string and never
            // absent.
            c.string(row['task_id'], `${rowAt}.task_id`);
            if (c.array(row['lines'], `${rowAt}.lines`)) {
                for (const [j, line] of (row['lines'] as unknown[]).entries()) {
                    c.string(line, `${rowAt}.lines[${j}]`);
                }
            }
            if (row['bug_id'] !== null && row['bug_id'] !== bug) {
                c.error(
                    `row reports bug ${String(row['bug_id'])} under key ${bug}`,
                    `${rowAt}.bug_id`
                );
            }
        }
    }
}
