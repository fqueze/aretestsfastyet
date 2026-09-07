/**
 * Records `test/fixtures/intermittents-trunk-2026-08-10.json` from live
 * Treeherder and Bugzilla.
 *
 * A generator rather than a hand-written fixture: the shapes are someone else's,
 * and a fixture invented from the serializer source would agree with what the
 * code expects rather than with what the API sends. The `{"bug_id": null}` group
 * and a summary naming a path that is not a test are both things nobody would
 * have thought to write.
 *
 * The head of the ranking is not a representative sample — every summary in it
 * happens to name a real test — so `ALWAYS_RECORD` pins the bugs that carry the
 * cases classification can get wrong. A fixture that cannot express a failure
 * cannot pin the fix for it.
 *
 * Run with:
 *   node --experimental-strip-types test/intermittents-fixture-gen.ts
 */

import { writeFile } from 'node:fs/promises';

import { testPathCandidates } from '../lib/sources/intermittents.ts';
import { collectTestPaths } from '../lib/query/test-lookup.ts';

const TREE = 'trunk';
const START = '2026-08-10';
const END = '2026-08-16';
const BASE = 'https://treeherder.mozilla.org/api';

/** How many ranked bugs to keep. More than any test scans, so the tail is real. */
const RANKING_ROWS = 12;
/** How many occurrences to keep per suite, per bug. */
const PER_SUITE = 2;
/** A cap per bug, so one 500-occurrence bug does not dominate the file. */
const PER_BUG = 8;

/**
 * Bugs recorded whatever their rank, and the classification case each pins.
 *
 * Every one is a case the head of the ranking does not contain.
 */
const ALWAYS_RECORD: readonly { bug: number; pins: string }[] = [
    // A mochitest whose *job* name is not harness-prefixed (ASAN), so this row
    // exists only because classification reads the summary rather than the job.
    { bug: 2021221, pins: 'summary path verifies as mochitest' },
    // An xpcshell test, for the other-harness branch.
    { bug: 2063359, pins: 'summary path verifies as xpcshell' },
    // A path is extracted and is not a test: the xpcshell harness script.
    { bug: 1946935, pins: 'path extracted, does not verify' },
    // The same, for a wpt test — a different reason to reject.
    { bug: 2051017, pins: 'path extracted, does not verify' },
];

interface RankRow {
    bug_id: number | null;
    bug_count: number;
}

interface OccurrenceRow {
    test_suite: string;
    [key: string]: unknown;
}

interface IssuesLike {
    tables: { testPaths: readonly string[]; testNames: readonly string[] };
    testInfo: { testPathIds: readonly number[]; testNameIds: readonly number[] };
}

async function getJson<T>(url: string): Promise<T> {
    // Treeherder answers 403 to a request with no User-Agent.
    const response = await fetch(url, { headers: { 'User-Agent': 'fx-tests-fixture-gen' } });
    if (!response.ok) {
        throw new Error(`${url} -> HTTP ${response.status}`);
    }
    return (await response.json()) as T;
}

const range = `startday=${START}&endday=${END}&tree=${TREE}`;
const whole = await getJson<RankRow[]>(`${BASE}/failures/?${range}`);

const pinned = new Set(ALWAYS_RECORD.map((entry) => entry.bug));
// Ranking order is preserved rather than appending the pinned ones: `failures`
// must stay count-descending, which is the order a scan walks.
const ranking = whole.filter(
    (row, index) => index < RANKING_ROWS || (row.bug_id !== null && pinned.has(row.bug_id))
);
for (const { bug, pins } of ALWAYS_RECORD) {
    if (!ranking.some((row) => row.bug_id === bug)) {
        // Loud rather than silent: a pinned bug that aged out means the fixture
        // no longer carries the case, and its test would pass vacuously.
        throw new Error(
            `pinned bug ${bug} (${pins}) is not in the ${START}..${END} ranking; ` +
                `pick a current bug with the same shape and update ALWAYS_RECORD`
        );
    }
}

const bugIds = ranking.flatMap((row) => (row.bug_id === null ? [] : [row.bug_id]));
const summaries: Record<string, string> = {};
for (let i = 0; i < bugIds.length; i += 40) {
    const batch = bugIds.slice(i, i + 40).join(',');
    const data = await getJson<{ bugs?: { id: number; summary: string }[] }>(
        `https://bugzilla.mozilla.org/rest/bug?id=${batch}&include_fields=id,summary`
    );
    for (const bug of data.bugs ?? []) {
        summaries[String(bug.id)] = bug.summary;
    }
}

const failuresbybug: Record<string, OccurrenceRow[]> = {};
for (const row of ranking) {
    if (row.bug_id === null) {
        continue;
    }
    const rows = await getJson<OccurrenceRow[]>(`${BASE}/failuresbybug/?${range}&bug=${row.bug_id}`);
    const perSuite = new Map<string, number>();
    const kept: OccurrenceRow[] = [];
    for (const occurrence of rows) {
        const seen = perSuite.get(occurrence.test_suite) ?? 0;
        if (seen >= PER_SUITE) {
            continue;
        }
        perSuite.set(occurrence.test_suite, seen + 1);
        kept.push(occurrence);
        if (kept.length >= PER_BUG) {
            break;
        }
    }
    failuresbybug[String(row.bug_id)] = kept;
    const pin = ALWAYS_RECORD.find((entry) => entry.bug === row.bug_id);
    process.stdout.write(
        `bug ${row.bug_id}: ${row.bug_count} annotations -> kept ${kept.length}` +
            `${pin === undefined ? '' : `  [pins: ${pin.pins}]`}\n`
    );
}

/**
 * The Taskcluster run index of every recorded job.
 *
 * `/api/failuresbybug/` carries `job_id` and `task_id` but no run, and the run
 * is not derivable: a task retried after an `exception` has its annotated
 * failure in a later run, and an artifact URL built from `runs/0` 404s. Recorded
 * from the same `/api/jobs/` listing the client reads, so a test can assert the
 * printed `<taskId>.<runId>` against Treeherder's own answer rather than an
 * invented one. This window happens to contain a `retry_id` of 5.
 */
const recordedJobIds = [
    ...new Set(Object.values(failuresbybug).flatMap((rows) => rows.map((row) => row['job_id']))),
];
const jobsData = await getJson<{ results?: unknown[][]; job_property_names?: string[] }>(
    `${BASE}/jobs/?id__in=${recordedJobIds.join(',')}`
);
const jobNames = jobsData.job_property_names ?? [];
const idColumn = jobNames.indexOf('id');
const retryColumn = jobNames.indexOf('retry_id');
const runIds: Record<string, number> = {};
for (const row of jobsData.results ?? []) {
    runIds[String(row[idColumn])] = Number(row[retryColumn] ?? 0);
}

/**
 * The published test lists, so the recorded summaries can be classified.
 *
 * Only the paths those summaries actually name are kept: the real lists are
 * 21,014 and 4,881 entries, and a test does not need them to check that a path
 * verifies. What matters is that membership is decided by the same
 * `collectTestPaths` the command uses, over the same published files.
 */
const named = new Set(Object.values(summaries).flatMap((summary) => testPathCandidates(summary)));
const knownTestPaths: Record<string, string[]> = { mochitest: [], xpcshell: [] };
for (const harness of ['mochitest', 'xpcshell'] as const) {
    const file = await getJson<IssuesLike>(
        `https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/` +
            `gecko.v2.mozilla-central.latest.source.test-info-${harness}-timings/` +
            `artifacts/public/${harness}-issues.json`
    );
    knownTestPaths[harness] = collectTestPaths([file]).filter((path) => named.has(path));
}

await writeFile(
    'test/fixtures/intermittents-trunk-2026-08-10.json',
    JSON.stringify(
        {
            note:
                'Recorded from live Treeherder and Bugzilla by ' +
                'test/intermittents-fixture-gen.ts. `failures` is the head of the real ranking ' +
                'plus the bugs in ALWAYS_RECORD, which pin the three classification cases: a ' +
                'summary whose path verifies, one whose path does not (the xpcshell harness ' +
                'script, a wpt test), and one with no path at all. `knownTestPaths` is the ' +
                'subset of the published test lists those summaries name, so a test can ' +
                'classify without reading a 6 MB aggregate. `runIds` is each recorded ' +
                'job_id\'s Taskcluster run index, which /api/failuresbybug/ does not carry.',
            tree: TREE,
            startday: START,
            endday: END,
            failures: ranking,
            summaries,
            knownTestPaths,
            failuresbybug,
            runIds,
        },
        null,
        1
    )
);
process.stdout.write(
    `wrote ${ranking.length} ranked rows, ${Object.keys(summaries).length} summaries, ` +
        `${knownTestPaths['mochitest']!.length} mochitest + ` +
        `${knownTestPaths['xpcshell']!.length} xpcshell known paths\n`
);
