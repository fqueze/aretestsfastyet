/**
 * Regenerates `test/fixtures/` from the published data.
 *
 * Fixtures are **truncated real files**, never hand-written: the shapes are
 * subtle enough — five status-group variants, two task-ID conventions,
 * delta-encoded axes — that an invented file would encode this repository's
 * misunderstanding rather than the format. Truncation keeps a real file's
 * every quirk while making it small enough to check in.
 *
 * Truncation keeps a status-covering selection of tests — not a prefix, which
 * would be circular: `xpcshell-00.json`'s first `FAIL` group is on test 76, so
 * a "first 40 tests" fixture contains no failures at all. See `selectTests()`.
 * The string tables are then rebuilt to hold only what survived and every
 * index renumbered. `npm test` re-validates each fixture with the same checker
 * the sweep used, so a truncation bug cannot pass silently.
 *
 * Cut from a **weekday**: weekend push volume is several-fold lower, so a
 * Saturday file is not representative of the shapes that appear under load.
 *
 * Usage: node tools/make-fixtures.js [--date YYYY-MM-DD]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
    truncateErrors,
    truncateManifests,
    truncateResources,
    truncateTimingFile,
    type AnyRecord,
} from './fixtures/truncate.ts';

const CI_INDEX = 'https://firefox-ci-tc.services.mozilla.com/api/index/v1/task';
const QUEUE = 'https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task';
const FIXTURES = 'test/fixtures';

/**
 * How much of each file a fixture keeps.
 *
 * `TESTS_PER_STATUS` is per status, not a total: two tests carrying each
 * status covers all twelve xpcshell statuses in about a dozen tests, and
 * raising it grows the file without covering anything new.
 */
const TESTS_PER_STATUS = 2;
const MARKER_GROUPS = 60;
const MANIFEST_RUNS = 200;
const RESOURCE_JOBS = 30;

function indexUrl(indexName: string, filename: string): string {
    return `${CI_INDEX}/gecko.v2.mozilla-central.latest.source.test-info-${indexName}/artifacts/public/${filename}`;
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
    process.stderr.write(`fetching ${url}\n`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return (await response.json()) as Record<string, unknown>;
}

async function write(name: string, data: unknown): Promise<void> {
    const file = path.join(FIXTURES, name);
    await mkdir(path.dirname(file), { recursive: true });
    const text = JSON.stringify(data);
    await writeFile(file, `${text}\n`);
    process.stderr.write(`  wrote ${name} (${(text.length / 1024).toFixed(1)} KB)\n`);
}

/**
 * Finds a crash with a minidump in a bucket file, and returns the artifact URL
 * for its stackwalk JSON. Crash status groups carry `minidumps` parallel to
 * `taskIdIds`, which is how `crashes.html` links to the crash viewer.
 */
function findCrashes(
    data: AnyRecord,
    limit: number
): { taskId: string; retryId: string; minidump: string; test: string }[] {
    const tables = data['tables'] as Record<string, string[]>;
    const testInfo = data['testInfo'] as Record<string, number[]>;
    const testRuns = data['testRuns'] as (AnyRecord | null)[][];
    const statusId = (tables['statuses'] ?? []).indexOf('CRASH');
    if (statusId < 0) {
        return [];
    }
    const out: { taskId: string; retryId: string; minidump: string; test: string }[] = [];
    for (let testIndex = 0; testIndex < testRuns.length && out.length < limit; testIndex++) {
        const group = testRuns[testIndex]?.[statusId];
        const minidumps = group?.['minidumps'] as (string | string[] | null)[] | undefined;
        const taskIdIds = group?.['taskIdIds'] as (number | number[])[] | undefined;
        if (!minidumps || !taskIdIds) {
            continue;
        }
        for (let i = 0; i < minidumps.length && out.length < limit; i++) {
            const ids = Array.isArray(minidumps[i]) ? (minidumps[i] as string[]) : [minidumps[i] as string];
            const tasks = Array.isArray(taskIdIds[i])
                ? (taskIdIds[i] as number[])
                : [taskIdIds[i] as number];
            for (let j = 0; j < ids.length && out.length < limit; j++) {
                const minidump = ids[j];
                if (!minidump) {
                    continue;
                }
                const suffixed = tables['taskIds']?.[tasks[j] ?? tasks[0]!];
                if (!suffixed) {
                    continue;
                }
                const [taskId, retryId = '0'] = suffixed.split('.');
                out.push({
                    taskId: taskId!,
                    retryId,
                    minidump,
                    test: tables['testNames']?.[testInfo['testNameIds']![testIndex]!] ?? '',
                });
            }
        }
    }
    return out;
}

function stackwalkUrl(taskId: string, retryId: string, minidump: string): string {
    return `${QUEUE}/${taskId}/runs/${retryId}/artifacts/public/test_info/${minidump}.json`;
}

/** True when a stackwalk looks like a hung process rather than a crash. */
function looksLikeHang(dump: AnyRecord): boolean {
    const info = dump['crash_info'] as AnyRecord | undefined;
    const type = String(info?.['type'] ?? '');
    // A hang is killed from outside: an abort/breakpoint rather than a fault,
    // with the dump taken by breakpad on the main thread while it waits.
    if (!/SIGABRT|BREAKPOINT|EXC_SOFTWARE/i.test(type)) {
        return false;
    }
    const crashing = dump['crashing_thread'] as AnyRecord | undefined;
    const frames = (crashing?.['frames'] ?? []) as AnyRecord[];
    const names = frames.map((f) => String(f['function'] ?? f['module'] ?? ''));
    const waiting =
        /RunCurrentEventLoopInMode|WaitForMessage|NtWaitFor|WaitForSingleObject|__psynch_cvwait|pthread_cond_wait|semaphore_wait|mach_msg/i;
    return names.some((n) => waiting.test(n));
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const dateFlag = argv.indexOf('--date');
    let date = dateFlag >= 0 ? argv[dateFlag + 1] : undefined;

    const index = (await fetchJson(indexUrl('xpcshell-timings', 'index.json'))) as {
        dates: string[];
    };
    if (!date) {
        // Fixtures must come from a weekday: weekend push volume is a
        // fraction of a weekday's, and the shapes that only appear under load
        // would be missing.
        date = index.dates.find((d) => {
            const day = new Date(`${d}T12:00:00Z`).getUTCDay();
            return day >= 1 && day <= 5;
        });
    }
    if (!date) {
        throw new Error('no weekday found in index.json');
    }
    process.stderr.write(`fixtures from ${date} (${new Date(`${date}T12:00:00Z`).toUTCString().slice(0, 3)})\n`);

    await write('index.json', index);

    for (const harness of ['xpcshell', 'mochitest'] as const) {
        // The small ones go in whole: a stats file is a few tens of KB and
        // truncating it would only remove dates the tests want.
        await write(
            `${harness}-stats.json`,
            await fetchJson(indexUrl(`${harness}-timings`, `${harness}-stats.json`))
        );

        // Errors: one per harness, because their coverage genuinely differs —
        // xpcshell only records failing tests' output.
        await write(
            `${harness}-${date}-errors.json`,
            truncateErrors(
                await fetchJson(indexUrl(`${harness}-timings`, `${harness}-${date}-errors.json`)),
                MARKER_GROUPS
            )
        );
    }

    // The timing families, from xpcshell (the smaller harness).
    await write(
        `xpcshell-${date}.json`,
        truncateTimingFile(
            await fetchJson(indexUrl('xpcshell-timings', `xpcshell-${date}.json`)),
            TESTS_PER_STATUS
        )
    );
    await write(
        'xpcshell-issues.json',
        truncateTimingFile(
            await fetchJson(indexUrl('xpcshell-timings', 'xpcshell-issues.json')),
            TESTS_PER_STATUS
        )
    );
    await write(
        'xpcshell-issues-with-taskids.json',
        truncateTimingFile(
            await fetchJson(indexUrl('xpcshell-timings', 'xpcshell-issues-with-taskids.json')),
            TESTS_PER_STATUS
        )
    );

    const bucket = await fetchJson(indexUrl('xpcshell-timings', 'xpcshell-00.json'));
    await write('xpcshell-00.json', truncateTimingFile(bucket, TESTS_PER_STATUS));

    // A mochitest bucket too: the two harnesses do not carry the same statuses
    // — the `-PARALLEL`/`-SEQUENTIAL` suffixes are xpcshell-only — so an
    // xpcshell-only fixture would leave the plain-status path untested.
    await write(
        'mochitest-00.json',
        truncateTimingFile(
            await fetchJson(indexUrl('mochitest-timings', 'mochitest-00.json')),
            TESTS_PER_STATUS
        )
    );

    // And the mochitest 21-day aggregate, which is what `tests.html` merges
    // with the xpcshell one. A folder in mozilla-central routinely holds an
    // xpcshell manifest and a mochitest manifest side by side, so the merge is
    // the page's ordinary path rather than an edge case — and testing it needs
    // both harnesses' aggregates, not two copies of one.
    //
    // Two deliberate departures from every other fixture here, both forced by
    // what the merge has to be tested against:
    //
    //  1. **Selected by path.** `toolkit/components/extensions/test` is a
    //     directory both harnesses genuinely use — `.../test/xpcshell` and
    //     `.../test/mochitest` — and it is already in the xpcshell fixture.
    //     Status coverage alone picks tests from wherever they happen to be,
    //     and the two fixtures then share no folder at all, leaving the merge
    //     untestable on real data.
    //  2. **The window is rewritten to the xpcshell fixture's.** The published
    //     index serves only `latest`, so a mochitest aggregate contemporaneous
    //     with the checked-in xpcshell one cannot be fetched. Day indices are
    //     relative to `metadata.startTime`, and the page aligns the two
    //     harnesses by day index — so without this the fixtures would describe
    //     different calendars and every merged chart would be off by weeks.
    //     Only the four window fields move; every count, status group and day
    //     index is the real file's.
    const mochitestIssues = truncateTimingFile(
        await fetchJson(indexUrl('mochitest-timings', 'mochitest-issues.json')),
        TESTS_PER_STATUS,
        'toolkit/components/extensions/test/mochitest'
    );
    const xpcshellIssues = truncateTimingFile(
        await fetchJson(indexUrl('xpcshell-timings', 'xpcshell-issues.json')),
        TESTS_PER_STATUS
    );
    const xpcshellMeta = xpcshellIssues['metadata'] as Record<string, unknown>;
    const mochitestMeta = mochitestIssues['metadata'] as Record<string, unknown>;
    for (const field of ['startDate', 'endDate', 'startTime', 'days']) {
        mochitestMeta[field] = xpcshellMeta[field];
    }
    await write('mochitest-issues.json', mochitestIssues);

    await write(
        `xpcshell-${date}-resources.json`,
        truncateResources(
            await fetchJson(indexUrl('xpcshell-timings', `xpcshell-${date}-resources.json`)),
            RESOURCE_JOBS
        )
    );

    await write(
        'manifests.json',
        truncateManifests(await fetchJson(indexUrl('manifest-timings', 'manifests.json')), MANIFEST_RUNS)
    );

    // --- the stackwalks --------------------------------------------------
    //
    // A crash and a hang, found by walking the bucket files for CRASH groups
    // with a minidump and fetching that task's artifact. Both are real dumps;
    // neither is trimmed, because the signature heuristic reads frames the
    // whole way down and a truncated thread would test the truncation.
    let crashWritten = false;
    let hangWritten = false;
    for (let n = 0; n < 64 && !(crashWritten && hangWritten); n++) {
        const name = `xpcshell-${n.toString(16).padStart(2, '0')}.json`;
        const file = n === 0 ? bucket : await fetchJson(indexUrl('xpcshell-timings', name));
        for (const crash of findCrashes(file, 40)) {
            if (crashWritten && hangWritten) {
                break;
            }
            let dump: AnyRecord;
            try {
                dump = await fetchJson(stackwalkUrl(crash.taskId, crash.retryId, crash.minidump));
            } catch {
                continue; // Expired or never uploaded; try the next one.
            }
            const hang = looksLikeHang(dump);
            if (hang && !hangWritten) {
                await write('stackwalk-hang.json', dump);
                process.stderr.write(`  hang from ${crash.test} (${crash.taskId})\n`);
                hangWritten = true;
            } else if (!hang && !crashWritten) {
                await write('stackwalk-crash.json', dump);
                process.stderr.write(`  crash from ${crash.test} (${crash.taskId})\n`);
                crashWritten = true;
            }
        }
    }
    if (!crashWritten) {
        process.stderr.write('WARNING: no crash stackwalk found\n');
    }
    if (!hangWritten) {
        process.stderr.write('WARNING: no hung-process stackwalk found\n');
    }
}

await main();
