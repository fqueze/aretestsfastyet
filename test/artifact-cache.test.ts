/**
 * Caching of per-task artifacts, and the failure semantics it must not blur.
 *
 * The bug these tests pin: `fx-tests try <rev>` re-downloaded every job
 * profile on every run. Measured on try push 7d16bff8 before the fix — two
 * consecutive runs, 46 profiles each, 828 MB each, 48 network requests on the
 * warm run of which 46 were profiles. The named data files *were* cached, so
 * the cache was not broken; per-task artifacts simply bypassed it.
 *
 * A task's artifact is immutable — `<taskId>/runs/<retryId>/<path>` fully
 * determines the content — so unlike the nightly aggregates there is no
 * `generatedAt` to compare and no TTL to honour. That makes these a *better*
 * caching candidate than the files already cached, which is the point the
 * original "deliberately not the disk cache's" comment missed: distinct error
 * handling is a reason not to share the aggregates' semantics, not a reason
 * not to cache.
 *
 * ## What is asserted about absence
 *
 * Most of the value here is negative, and each negative is a way the fix could
 * be wrong while looking right:
 *
 * - a warm run makes **zero** artifact requests, asserted by counting calls on
 *   an instrumented fetcher rather than by timing anything;
 * - a **failure is never cached**, so a transient outage does not become a
 *   permanent-looking one;
 * - a 404 still produces **exit 4** and a 5xx **exit 3**, through the cache;
 * - `--no-cache` writes nothing and reads nothing.
 *
 * No test here touches the network: every fetcher is a counter over an
 * in-memory map, and every cache lives in a temporary directory the test
 * removes.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import {
    type DataFileName,
    type DataSource,
    DataFetchError,
    DataFileNotFoundError,
} from '../lib/sources/source.ts';
import { taskArtifactName, taskArtifactUrl } from '../lib/sources/http.ts';
import {
    DEFAULT_ARTIFACT_BUDGET_BYTES,
    SETTLED_PUSH_TTL_MS,
    TASK_ARTIFACT_KIND,
    cachedArtifactFetcher,
    cachedTaskArtifactSource,
    cachedTreeherderJobs,
    diskCache,
    isImmutableKind,
    isSettledPush,
    urlCacheHash,
} from '../cli/cache.ts';

/**
 * Runs a body with a fresh cache directory.
 *
 * One `mkdtemp` for the whole file and a counter within it, rather than one
 * per test. Measured on macOS: `mkdtemp` plus a recursive `rm` under
 * `os.tmpdir()` costs roughly half a second each, so the per-test form made
 * these eighteen tests take twenty seconds against a suite that otherwise runs
 * in under three. The directories are still disjoint, which is the property
 * that matters; only the syscalls are shared.
 */
let base: string | null = null;
let counter = 0;
async function withCacheDir(body: (directory: string) => Promise<void>): Promise<void> {
    base ??= await mkdtemp(join(tmpdir(), 'fx-tests-artifact-cache-'));
    const directory = join(base, String(counter++));
    await mkdir(directory, { recursive: true });
    await body(directory);
}

// Removed once, at the end, for the same reason.
after(async () => {
    if (base !== null) {
        await rm(base, { recursive: true, force: true });
    }
});

/** A URL fetcher over a map, counting every call. */
function countingFetcher(
    bodies: Record<string, string>
): ((url: string) => Promise<Uint8Array | null>) & { calls: string[] } {
    const calls: string[] = [];
    const fetcher = (url: string): Promise<Uint8Array | null> => {
        calls.push(url);
        const body = bodies[url];
        return Promise.resolve(
            body === undefined ? null : new TextEncoder().encode(body)
        );
    };
    fetcher.calls = calls;
    return fetcher;
}

const URL_A = 'https://example.invalid/api/queue/v1/task/TASKA/runs/0/artifacts/public/a.json';
const URL_B = 'https://example.invalid/api/queue/v1/task/TASKB/runs/0/artifacts/public/a.json';

// --- the bug: a warm run must make zero artifact requests -----------------

test('a second fetch of the same artifact makes no request', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        const inner = countingFetcher({ [URL_A]: '{"profile":1}' });
        const fetcher = cachedArtifactFetcher(inner, cache);

        const first = await fetcher(URL_A);
        assert.equal(inner.calls.length, 1);
        const second = await fetcher(URL_A);
        // The assertion the bug report is about: not "it was fast", but that
        // the inner fetcher was never reached a second time.
        assert.equal(inner.calls.length, 1, 'the warm fetch must make no request');
        assert.deepEqual(second, first, 'and it must return the same bytes');
    });
});

test('a warm cache survives a new fetcher, which is what a second process is', async () => {
    await withCacheDir(async (directory) => {
        const warm = countingFetcher({ [URL_A]: '{"profile":1}' });
        await cachedArtifactFetcher(warm, diskCache({ directory }))(URL_A);
        assert.equal(warm.calls.length, 1);

        // A second `fx-tests try` is a new process with a new fetcher and a
        // new cache object over the same directory. An in-memory memo would
        // pass the test above and fail this one, which is the case the user
        // actually reported.
        const second = countingFetcher({ [URL_A]: '{"profile":1}' });
        const bytes = await cachedArtifactFetcher(second, diskCache({ directory }))(URL_A);
        assert.equal(second.calls.length, 0, 'a fresh process must read from disk');
        assert.equal(new TextDecoder().decode(bytes!), '{"profile":1}');
    });
});

test('two artifacts do not share a cache entry', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        const inner = countingFetcher({ [URL_A]: '{"a":1}', [URL_B]: '{"b":2}' });
        const fetcher = cachedArtifactFetcher(inner, cache);
        await fetcher(URL_A);
        await fetcher(URL_B);
        // A constant key passes every single-artifact test — the entry is
        // written and read back correctly — and only shows up as one job's
        // profile being served in place of another's, which would silently
        // attribute one job's failures to a different config.
        assert.equal(
            new TextDecoder().decode((await fetcher(URL_A))!),
            '{"a":1}',
            'the second artifact must not overwrite the first'
        );
        assert.equal(new TextDecoder().decode((await fetcher(URL_B))!), '{"b":2}');
        assert.equal(inner.calls.length, 2, 'and neither re-fetched');
    });
});

test('the artifact key space does not collide with the aggregates’', async () => {
    // Both hash to a 32-character hex name in one directory, so the two key
    // spaces have to be disjoint by construction rather than by luck. A
    // `DataFileName` whose `index/filename` spells a URL must not address the
    // same entry as that URL.
    const url = 'mozilla-central/xpcshell-00.json';
    const { cacheHash } = await import('../cli/cache.ts');
    assert.notEqual(
        urlCacheHash(url),
        cacheHash({ index: 'mozilla-central', filename: 'xpcshell-00.json' })
    );
});

// --- immutability: no TTL, because the key determines the content ---------

test('a task artifact is served however old the entry is', async () => {
    await withCacheDir(async (directory) => {
        let now = Date.parse('2026-01-01T00:00:00Z');
        // A TTL short enough that an aggregate written now is stale by the
        // next call. The artifact must ignore it: the URL names one run of one
        // completed task, whose content cannot have changed.
        const cache = diskCache({ directory, ttlMs: 1000, now: () => now });
        const inner = countingFetcher({ [URL_A]: '{"profile":1}' });
        const fetcher = cachedArtifactFetcher(inner, cache);
        await fetcher(URL_A);
        now += 365 * 24 * 60 * 60 * 1000;
        await fetcher(URL_A);
        assert.equal(inner.calls.length, 1, 'a year later it is still valid');
    });
});

test('an entry written under another rule is not readable as an artifact', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        // Push job lists share `urlCacheHash`'s key space with artifacts, so
        // the *kind* is the only thing keeping the two apart at one hash. That
        // makes this the case the kind check actually exists for: dropping it
        // would serve a job list — which expires after a day — as an immutable
        // artifact that never expires at all.
        const key = 'treeherder:jobs:1988598';
        await cache.putPushJobs(key, new TextEncoder().encode('[]'));
        assert.equal(await cache.getArtifact(key), null);
        // And the converse, so the check is not merely rejecting everything:
        // an artifact written at the same hash *is* served.
        await cache.putArtifact(key, new TextEncoder().encode('{"a":1}'));
        assert.equal(new TextDecoder().decode((await cache.getArtifact(key))!), '{"a":1}');
    });
});

test('an artifact entry is not readable as a push job list', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        // The other direction. An artifact never expires, so reading one as a
        // job list would give a push's jobs an entry that outlives every
        // retrigger.
        await cache.putArtifact(URL_A, new TextEncoder().encode('{}'));
        assert.equal(await cache.getPushJobs(URL_A), null);
    });
});

test('an aggregate’s key does not address an artifact entry', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        const name: DataFileName = { index: 'x-timings', filename: 'x-00.json' };
        await cache.put(name, new TextEncoder().encode('{"metadata":{}}'));
        assert.equal(await cache.getArtifact(taskArtifactUrl(name)), null);
    });
});

test('entries record which expiry rule they were written under', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        await cache.putArtifact(URL_A, new TextEncoder().encode('{}'));
        await cache.put({ index: 'x-timings', filename: 'x-00.json' }, new TextEncoder().encode('{}'));
        const entries = await cache.list();
        const kinds = entries.map((entry) => isImmutableKind(entry.kind));
        assert.deepEqual(kinds.sort(), [false, true], 'one of each kind');
        const artifact = entries.find((entry) => entry.kind === TASK_ARTIFACT_KIND);
        // The URL is the key, because there is no shorter name that identifies
        // the entry, and it is also recorded as the URL.
        assert.equal(artifact?.key, URL_A);
        assert.equal(artifact?.url, URL_A);
    });
});

// --- negative results are never cached ------------------------------------

test('a missing artifact is not cached, so a transient outage is not sticky', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        // The fetcher's contract collapses a 404 and a 503 into the same
        // `null`, so caching it would preserve a Taskcluster hiccup as if the
        // artifact had expired. Caching a success can only ever be right;
        // caching a failure can be wrong, and the wrong version is sticky.
        const failing = countingFetcher({});
        const fetcher = cachedArtifactFetcher(failing, cache);
        assert.equal(await fetcher(URL_A), null);
        assert.equal(await fetcher(URL_A), null);
        assert.equal(failing.calls.length, 2, 'a failure must be retried, not remembered');
        assert.deepEqual(await cache.list(), [], 'and nothing was written');
    });
});

test('an artifact that becomes available after a failure is picked up', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        const bodies: Record<string, string> = {};
        const inner = countingFetcher(bodies);
        const fetcher = cachedArtifactFetcher(inner, cache);
        assert.equal(await fetcher(URL_A), null);
        // The consequence of the rule above, and the reason it is the right
        // one: the outage ends and the next run sees the real artifact.
        bodies[URL_A] = '{"profile":1}';
        assert.equal(new TextDecoder().decode((await fetcher(URL_A))!), '{"profile":1}');
    });
});

// --- the DataSource half: exit 4 and exit 3 must still differ -------------

/** A task-artifact `DataSource` over a map, counting fetches. */
function countingArtifactSource(
    bodies: Record<string, string>
): DataSource & { calls: string[] } {
    const calls: string[] = [];
    return {
        name: 'counting-artifacts',
        calls,
        fetch(name: DataFileName): Promise<Uint8Array> {
            const key = `${name.index}/${name.filename}`;
            calls.push(key);
            if (key.includes('server-error')) {
                return Promise.reject(new DataFetchError(name, 'HTTP 500', 'url', 500));
            }
            const body = bodies[key];
            if (body === undefined) {
                return Promise.reject(new DataFileNotFoundError(name));
            }
            return Promise.resolve(new TextEncoder().encode(body));
        },
    };
}

test('the cached task-artifact source serves a second read with no fetch', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        const name = taskArtifactName('TASKCRASH', 0, 'public/test_info/dump.json');
        const inner = countingArtifactSource({
            [`${name.index}/${name.filename}`]: '{"threads":[]}',
        });
        const source = cachedTaskArtifactSource(inner, cache, (n) => taskArtifactUrl(n));
        await source.fetch(name);
        await source.fetch(name);
        assert.equal(inner.calls.length, 1, '`fx-tests crash` benefits too');
    });
});

test('a 404 still throws DataFileNotFoundError through the cache', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        const name = taskArtifactName('TASKGONE', 0, 'public/test_info/dump.json');
        const inner = countingArtifactSource({});
        const source = cachedTaskArtifactSource(inner, cache, (n) => taskArtifactUrl(n));
        // The distinction the whole separate source exists for: `fx-tests
        // crash` maps this to exit 4, and a cache that swallowed the type or
        // remembered the absence would break the 3/4 split.
        await assert.rejects(() => source.fetch(name), DataFileNotFoundError);
        await assert.rejects(() => source.fetch(name), DataFileNotFoundError);
        assert.equal(inner.calls.length, 2, 'and the absence was not cached');
        assert.deepEqual(await cache.list(), []);
    });
});

test('a 5xx still throws DataFetchError through the cache', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        const name = taskArtifactName('TASKX', 0, 'public/test_info/server-error.json');
        const inner = countingArtifactSource({});
        const source = cachedTaskArtifactSource(inner, cache, (n) => taskArtifactUrl(n));
        // Exit 3, not 4. Caching this would tell a caller to stop retrying
        // something that would have worked a minute later.
        await assert.rejects(() => source.fetch(name), DataFetchError);
        assert.deepEqual(await cache.list(), []);
    });
});

test('the cache key is the URL the source would have fetched', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        const name = taskArtifactName('TASKCRASH', 2, 'public/test_info/dump.json');
        const inner = countingArtifactSource({
            [`${name.index}/${name.filename}`]: '{"threads":[]}',
        });
        await cachedTaskArtifactSource(inner, cache, (n) => taskArtifactUrl(n)).fetch(name);
        const entries = await cache.list();
        assert.equal(entries.length, 1);
        // Built by the source's own URL function, so the two cannot drift.
        // A key derived some other way caches correctly and never hits.
        assert.equal(entries[0]!.key, taskArtifactUrl(name));
        assert.match(entries[0]!.key, /\/task\/TASKCRASH\/runs\/2\/artifacts\//);
    });
});

test('the retry number is part of the key', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        const run0 = taskArtifactName('TASKR', 0, 'public/test_info/dump.json');
        const run1 = taskArtifactName('TASKR', 1, 'public/test_info/dump.json');
        const inner = countingArtifactSource({
            [`${run0.index}/${run0.filename}`]: '{"run":0}',
            [`${run1.index}/${run1.filename}`]: '{"run":1}',
        });
        const source = cachedTaskArtifactSource(inner, cache, (n) => taskArtifactUrl(n));
        await source.fetch(run0);
        // Two runs of one task are two different artifacts. Keying on the task
        // ID alone would serve run 0's dump for run 1 — a wrong answer that
        // looks entirely plausible.
        assert.equal(new TextDecoder().decode(await source.fetch(run1)), '{"run":1}');
    });
});

// --- the budget -----------------------------------------------------------

test('pruning evicts the oldest artifacts until they fit the budget', async () => {
    await withCacheDir(async (directory) => {
        let now = Date.parse('2026-01-01T00:00:00Z');
        const cache = diskCache({ directory, artifactBudgetBytes: 250, now: () => now });
        const body = (n: number): Uint8Array => new Uint8Array(100).fill(n);
        for (const index of [1, 2, 3]) {
            await cache.putArtifact(`https://example.invalid/a${index}`, body(index));
            now += 1000;
        }
        assert.equal(await cache.pruneTaskArtifacts(), 1, '300 bytes over a 250 budget');
        const keys = (await cache.list()).map((entry) => entry.key);
        // Oldest first: the two most recent survive, which is what makes a
        // re-run of the push you just looked at still hit.
        assert.deepEqual(keys.sort(), [
            'https://example.invalid/a2',
            'https://example.invalid/a3',
        ]);
    });
});

test('pruning leaves the aggregates alone', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory, artifactBudgetBytes: 0 });
        await cache.put({ index: 'x-timings', filename: 'x-00.json' }, new Uint8Array(500));
        await cache.putArtifact('https://example.invalid/a1', new Uint8Array(500));
        assert.equal(await cache.pruneTaskArtifacts(), 1);
        const keys = (await cache.list()).map((entry) => entry.key);
        // The aggregates are a bounded set the TTL refreshes in place, so
        // evicting them buys nothing and costs a 13 MB re-download. Only the
        // artifacts accumulate.
        assert.deepEqual(keys, ['x-timings/x-00.json']);
    });
});

test('pruning does nothing while the cache is under budget', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        await cache.putArtifact('https://example.invalid/a1', new Uint8Array(500));
        assert.equal(await cache.pruneTaskArtifacts(), 0);
        assert.equal((await cache.list()).length, 1);
    });
});

test('the default budget holds several pushes’ worth of profiles', () => {
    // Measured on try push 7d16bff8: 46 profiles, 828 MB. A budget that could
    // not hold two of those would evict the previous push on every run, which
    // is the case the cache exists to serve.
    const onePush = 828 * 1000 * 1000;
    assert.ok(
        DEFAULT_ARTIFACT_BUDGET_BYTES > 2 * onePush,
        `the budget must hold more than two pushes, got ${DEFAULT_ARTIFACT_BUDGET_BYTES}`
    );
});

// --- what `fx-tests cache` reports ----------------------------------------

test('the listing names a task artifact by its task and run', async () => {
    const { entryLabel } = await import('../cli/commands/cache.ts');
    const url =
        'https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/aqu497o9RbGEN4AqiE3MJQ' +
        '/runs/0/artifacts/public/test_info/profile_resource-usage.json';
    // 130 characters of which 90 are the same on every row. Measured on the
    // cache one `fx-tests try 7d16bff8` leaves: the raw key truncated to a
    // column width printed forty-six visually identical rows, because the only
    // distinguishing part is in the middle.
    assert.equal(
        entryLabel(url),
        'aqu497o9RbGEN4AqiE3MJQ.0 public/test_info/profile_resource-usage.json'
    );
    // Two runs of one task must still be told apart.
    assert.notEqual(entryLabel(url), entryLabel(url.replace('/runs/0/', '/runs/1/')));
});

test('the listing leaves an aggregate’s key alone', async () => {
    const { entryLabel } = await import('../cli/commands/cache.ts');
    assert.equal(entryLabel('xpcshell-timings/xpcshell-00.json'), 'xpcshell-timings/xpcshell-00.json');
});

test('cache --size breaks out the task-artifact half', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        await cache.put({ index: 'x-timings', filename: 'x-00.json' }, new Uint8Array(1000));
        await cache.putArtifact('https://example.invalid/a1', new Uint8Array(4000));
        const { run } = await import('../cli/main.ts');
        const { captureStreams } = await import('../cli/context.ts');
        const streams = captureStreams();
        await run({ argv: ['cache', '--size'], streams, cache });
        // A single total hides which half is big, and they behave differently:
        // the aggregates are a bounded set a TTL refreshes in place, the
        // artifacts accumulate and are evicted by a budget. Someone asking
        // because the directory is large needs to know which they are seeing.
        assert.match(streams.stdout, /1 task artifact/);
        assert.match(streams.stdout, /3\.9 KB of that/, streams.stdout);
    });
});

test('cache --json reports the artifact totals separately', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        await cache.put({ index: 'x-timings', filename: 'x-00.json' }, new Uint8Array(1000));
        await cache.putArtifact('https://example.invalid/a1', new Uint8Array(4000));
        await cache.putArtifact('https://example.invalid/a2', new Uint8Array(2000));
        const { run } = await import('../cli/main.ts');
        const { captureStreams } = await import('../cli/context.ts');
        const streams = captureStreams();
        await run({ argv: ['cache', '--json'], streams, cache });
        const result = JSON.parse(streams.stdout) as {
            entryCount: number;
            taskArtifacts: { entryCount: number; bytes: number };
        };
        assert.equal(result.entryCount, 3);
        // Not all three, and not the aggregate's bytes: exactly the two
        // artifacts. A count over every entry passes when there are no
        // aggregates, which is what a single-kind fixture would have.
        assert.deepEqual(result.taskArtifacts, { entryCount: 2, bytes: 6000 });
    });
});

test('cache --clear removes artifacts and says how many', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        await cache.put({ index: 'x-timings', filename: 'x-00.json' }, new Uint8Array(1000));
        await cache.putArtifact('https://example.invalid/a1', new Uint8Array(4000));
        const { run } = await import('../cli/main.ts');
        const { captureStreams } = await import('../cli/context.ts');
        const streams = captureStreams();
        await run({ argv: ['cache', '--clear'], streams, cache });
        assert.match(streams.stdout, /Cleared 2 entries/);
        assert.match(streams.stdout, /of which 1 task artifact/);
        assert.deepEqual(await cache.list(), [], 'both kinds are gone');
    });
});

// --- Treeherder: a settled push, and only a settled push ------------------

/** A Treeherder client over a fixed job list, counting `jobsOfPush` calls. */
function countingTreeherder(jobs: { state: string; taskId: string }[]): {
    jobsOfPush(pushId: number): Promise<{ state: string; taskId: string }[]>;
    calls: number[];
} {
    const calls: number[] = [];
    return {
        calls,
        jobsOfPush(pushId: number) {
            calls.push(pushId);
            return Promise.resolve(jobs);
        },
    };
}

test('a settled push’s job list is served from cache', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        const inner = countingTreeherder([
            { state: 'completed', taskId: 'A' },
            { state: 'completed', taskId: 'B' },
        ]);
        const client = cachedTreeherderJobs(inner, cache);
        const first = await client.jobsOfPush(1988598);
        // 561 KB and 0.3 s for a 1,731-job push, measured on try push
        // 7d16bff8. Worth not asking for twice.
        const second = await client.jobsOfPush(1988598);
        assert.equal(inner.calls.length, 1, 'the second lookup must make no request');
        assert.deepEqual(second, first);
    });
});

test('a push still running is never cached', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        // Measured on live autoland push 1991559: 1,906 unscheduled, 65
        // running, 28 completed, 1 pending. `try` reads only completed jobs,
        // so a snapshot of this cached and re-served would report whatever had
        // failed by then and call the rest of the push clean — a confident
        // wrong answer to "did my patch break anything".
        const inner = countingTreeherder([
            { state: 'completed', taskId: 'A' },
            { state: 'running', taskId: 'B' },
        ]);
        const client = cachedTreeherderJobs(inner, cache);
        await client.jobsOfPush(7);
        await client.jobsOfPush(7);
        assert.equal(inner.calls.length, 2, 'an unfinished push must be re-read every time');
        assert.deepEqual(await cache.list(), [], 'and nothing written');
    });
});

test('every non-terminal state keeps a push out of the cache', () => {
    // Each of Treeherder's three non-terminal states on its own, because a
    // rule written as `state !== 'running'` catches the common case and lets a
    // push that is entirely `pending` through.
    for (const state of ['unscheduled', 'pending', 'running']) {
        assert.equal(
            isSettledPush([{ state: 'completed' }, { state }]),
            false,
            `a ${state} job must keep the push unsettled`
        );
    }
    assert.equal(isSettledPush([{ state: 'completed' }, { state: 'completed' }]), true);
});

test('a push with no jobs at all is not settled', () => {
    // An empty list is what a push answers before anything is scheduled, and
    // caching it would pin "this push has no jobs" for a day.
    assert.equal(isSettledPush([]), false);
});

test('the settled-push TTL is a literal day', () => {
    // Pinned to the number, not to the constant. Every assertion below uses
    // `SETTLED_PUSH_TTL_MS` symbolically, which means mutating it moves the
    // code and the tests together — a mutation making it a year survived the
    // whole suite. A day is a judgement about how long a retrigger may go
    // unseen, so the value itself has to be asserted somewhere.
    assert.equal(SETTLED_PUSH_TTL_MS, 24 * 60 * 60 * 1000);
});

test('a settled push is re-read after a day, so a retrigger is picked up', async () => {
    await withCacheDir(async (directory) => {
        let now = Date.parse('2026-01-01T00:00:00Z');
        const cache = diskCache({ directory, now: () => now });
        const inner = countingTreeherder([{ state: 'completed', taskId: 'A' }]);
        const client = cachedTreeherderJobs(inner, cache);
        await client.jobsOfPush(7);
        now += SETTLED_PUSH_TTL_MS - 1000;
        await client.jobsOfPush(7);
        assert.equal(inner.calls.length, 1, 'within the day it is still served');
        // The entry is not permanent, because a settled push can still gain a
        // run when someone retriggers a job on it and nothing in the cached
        // list would say so.
        now += 2000;
        await client.jobsOfPush(7);
        assert.equal(inner.calls.length, 2, 'past the day it is re-read');
    });
});

test('two pushes do not share a job-list entry', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        const first = countingTreeherder([{ state: 'completed', taskId: 'A' }]);
        const second = countingTreeherder([{ state: 'completed', taskId: 'B' }]);
        await cachedTreeherderJobs(first, cache).jobsOfPush(1);
        const jobs = await cachedTreeherderJobs(second, cache).jobsOfPush(2);
        // A shared key would serve push 1's jobs for push 2 — a whole push's
        // triage attributed to the wrong revision.
        assert.deepEqual(jobs, [{ state: 'completed', taskId: 'B' }]);
        assert.equal(second.calls.length, 1);
    });
});

test('the push lookup is deliberately left uncached', async () => {
    await withCacheDir(async (directory) => {
        const cache = diskCache({ directory });
        let lookups = 0;
        const inner = {
            findPush: (): Promise<{ pushId: number }> => {
                lookups++;
                return Promise.resolve({ pushId: 1 });
            },
            jobsOfPush: (): Promise<{ state: string }[]> =>
                Promise.resolve([{ state: 'completed' }]),
        };
        const client = cachedTreeherderJobs(inner, cache);
        await client.findPush();
        await client.findPush();
        // 3.5 KB and 0.25 s, so there is little to win, and this is the
        // request that resolves a revision — including a 12-character prefix,
        // which can match a different push later. See `cachedTreeherderJobs`.
        assert.equal(lookups, 2, 'the push lookup stays live');
    });
});

// --- end to end: two `fx-tests try` runs, as the user ran them ------------

/**
 * The two profiles the end-to-end runs below serve.
 *
 * Minimal rather than a captured fixture: these tests assert on *how many
 * requests were made*, not on what was parsed out of them, so the smallest
 * profile carrying one readable `Test` marker is the right size. The marker
 * shape itself is exercised by `parseTestMarkers`' own tests.
 */
function tinyProfile(testPath: string): string {
    return JSON.stringify({
        threads: [
            {
                stringArray: ['test'],
                markers: {
                    length: 1,
                    name: [0],
                    data: [{ type: 'Test', test: testPath, status: 'FAIL', message: 'boom' }],
                    startTime: [1],
                    endTime: [2],
                },
            },
        ],
    });
}

/** A `DataSource` over the checked-in fixtures, counting what it is asked for. */
async function bucketSource(): Promise<DataSource & { requested: string[] }> {
    const { readFile } = await import('node:fs/promises');
    const requested: string[] = [];
    const files: Record<string, string> = {
        'xpcshell-timings/xpcshell-00.json': 'xpcshell-00.json',
        'mochitest-timings/mochitest-00.json': 'mochitest-00.json',
    };
    return {
        name: 'fixtures',
        requested,
        async fetch(name: DataFileName): Promise<Uint8Array> {
            const key = `${name.index}/${name.filename}`;
            requested.push(key);
            const local = files[key];
            if (local === undefined) {
                throw new DataFileNotFoundError(name);
            }
            return new Uint8Array(
                await readFile(new URL(`./fixtures/${local}`, import.meta.url))
            );
        },
    };
}

/** A source serving just `index.json`, for a command that reads no artifacts. */
async function datesSource(): Promise<DataSource> {
    const { readFile } = await import('node:fs/promises');
    return {
        name: 'fixtures',
        async fetch(name: DataFileName): Promise<Uint8Array> {
            if (name.filename !== 'index.json') {
                throw new DataFileNotFoundError(name);
            }
            return new Uint8Array(
                await readFile(new URL('./fixtures/index.json', import.meta.url))
            );
        },
    };
}

/** The test whose failures the runs below report. Present in `xpcshell-00.json`. */
const E2E_TEST_PATH = 'dom/indexedDB/test/unit/test_rename_objectStore_errors.js';

/** Two failed jobs, so the run fetches more than one artifact. */
const E2E_JOBS = [
    { jobId: 1, jobName: 'test-linux/opt-xpcshell-1', taskId: 'TASKONE', retryId: 0, state: 'completed', result: 'testfailed' },
    { jobId: 2, jobName: 'test-linux/opt-xpcshell-2', taskId: 'TASKTWO', retryId: 0, state: 'completed', result: 'testfailed' },
];

/** Treeherder, answering from memory. */
function e2eTreeherder(): {
    findPush: () => Promise<{ pushId: number; revision: string; repository: string; revisions: [] }>;
    jobsOfPush: () => Promise<typeof E2E_JOBS>;
} {
    return {
        findPush: () =>
            Promise.resolve({
                pushId: 1,
                revision: '7d16bff81bb1340b832428c1973e1a8c0090405f',
                repository: 'try',
                revisions: [],
            }),
        jobsOfPush: () => Promise.resolve(E2E_JOBS),
    };
}

/** One `fx-tests try` run against an injected HTTP layer. See `httpFetchUrl`. */
async function runTryOnce(
    directory: string,
    http: (url: string) => Promise<Uint8Array | null>,
    extraArgv: string[] = []
): Promise<string> {
    const { run } = await import('../cli/main.ts');
    const { captureStreams } = await import('../cli/context.ts');
    const streams = captureStreams();
    const code = await run({
        argv: ['try', '7d16bff8', '--json', ...extraArgv],
        streams,
        source: await bucketSource(),
        cache: diskCache({ directory }),
        treeherder: e2eTreeherder(),
        // Deliberately `httpFetchUrl` and not `fetchUrl`: the latter replaces
        // the cache as well, so a test using it could not tell a warm run from
        // a cold one. This one leaves the production wiring intact and swaps
        // only the network.
        httpFetchUrl: http,
    });
    assert.equal(code, 0, streams.stderr);
    return streams.stdout;
}

test('a second fx-tests try run makes zero artifact requests', async () => {
    await withCacheDir(async (directory) => {
        const profiles = {
            [`https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/TASKONE/runs/0/artifacts/public/profile_run-task-resource-usage.json`]:
                tinyProfile(E2E_TEST_PATH),
            [`https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/TASKTWO/runs/0/artifacts/public/profile_run-task-resource-usage.json`]:
                tinyProfile(E2E_TEST_PATH),
        };
        const http = countingFetcher(profiles);

        const first = await runTryOnce(directory, http);
        assert.equal(http.calls.length, 2, 'the cold run fetches one profile per failed job');

        // The bug, as the user reported it. Before the fix this was 4: the
        // named data files were cached and the profiles were not, so a warm
        // run still printed "Fetching 46 job profiles" and downloaded all of
        // them. Measured on push 7d16bff8, that was 828 MB per run.
        const second = await runTryOnce(directory, http);
        assert.equal(http.calls.length, 2, 'the warm run must fetch nothing');
        assert.equal(second, first, 'and must produce the identical answer');
    });
});

test('the run says where its profiles came from', async () => {
    await withCacheDir(async (directory) => {
        const profiles = {
            [`https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/TASKONE/runs/0/artifacts/public/profile_run-task-resource-usage.json`]:
                tinyProfile(E2E_TEST_PATH),
            [`https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/TASKTWO/runs/0/artifacts/public/profile_run-task-resource-usage.json`]:
                tinyProfile(E2E_TEST_PATH),
        };
        const http = countingFetcher(profiles);
        const { run } = await import('../cli/main.ts');
        const { captureStreams } = await import('../cli/context.ts');

        const cold = captureStreams();
        await run({
            argv: ['try', '7d16bff8', '--json'],
            streams: cold,
            source: await bucketSource(),
            cache: diskCache({ directory }),
            treeherder: e2eTreeherder(),
            httpFetchUrl: http,
        });
        assert.match(cold.stderr, /Downloaded 2 job profiles/);

        // The line the bug was reported against says "Reading 46 job
        // profiles" on both runs, because it is printed before the first
        // fetch and cannot know. Saying afterwards which it was is what
        // answers "is the cache working?" without instrumenting a fetch.
        const warm = captureStreams();
        await run({
            argv: ['try', '7d16bff8', '--json'],
            streams: warm,
            source: await bucketSource(),
            cache: diskCache({ directory }),
            treeherder: e2eTreeherder(),
            httpFetchUrl: http,
        });
        assert.match(warm.stderr, /All 2 job profiles came from the cache/);
        assert.doesNotMatch(warm.stderr, /Downloaded/);
    });
});

test('a command that reads no artifacts says nothing about them', async () => {
    await withCacheDir(async (directory) => {
        const { run } = await import('../cli/main.ts');
        const { captureStreams } = await import('../cli/context.ts');
        const streams = captureStreams();
        // A command that runs all the way through dispatch, not `cache`, which
        // returns before the reporting is reached. That distinction is what
        // the test is for: with `cache` here, a mutation deleting the
        // zero-artifact guard survived, and the mutant prints "All 0 job
        // profiles came from the cache" on the end of every command's output.
        await run({
            argv: ['dates', '--harness', 'xpcshell', '--json'],
            streams,
            source: await datesSource(),
            cache: diskCache({ directory }),
        });
        assert.doesNotMatch(streams.stderr, /job profiles/, streams.stderr);
    });
});

test('--no-cache makes fx-tests try re-fetch every artifact', async () => {
    await withCacheDir(async (directory) => {
        const http = countingFetcher({
            [`https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/TASKONE/runs/0/artifacts/public/profile_run-task-resource-usage.json`]:
                tinyProfile(E2E_TEST_PATH),
            [`https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/TASKTWO/runs/0/artifacts/public/profile_run-task-resource-usage.json`]:
                tinyProfile(E2E_TEST_PATH),
        });
        await runTryOnce(directory, http, ['--no-cache']);
        await runTryOnce(directory, http, ['--no-cache']);
        assert.equal(http.calls.length, 4, '--no-cache must bypass the artifact cache too');
        const cache = diskCache({ directory });
        assert.deepEqual(await cache.list(), [], 'and write nothing');
    });
});

/** Node-shaped `fetch` over a map, counting every call. */
function countingHttp(
    bodies: Record<string, string>
): ((url: string) => Promise<{ ok: boolean; status: number; url: string; arrayBuffer(): Promise<ArrayBuffer> }>) & {
    calls: string[];
} {
    const calls: string[] = [];
    const http = (url: string) => {
        calls.push(url);
        const body = bodies[url];
        const bytes = new TextEncoder().encode(body ?? '');
        return Promise.resolve({
            ok: body !== undefined,
            status: body === undefined ? 404 : 200,
            url,
            arrayBuffer: () =>
                Promise.resolve(
                    bytes.buffer.slice(
                        bytes.byteOffset,
                        bytes.byteOffset + bytes.byteLength
                    ) as ArrayBuffer
                ),
        });
    };
    http.calls = calls;
    return http;
}

test('fx-tests crash caches its dump, and --no-cache does not', async () => {
    await withCacheDir(async (directory) => {
        const url = taskArtifactUrl(
            taskArtifactName('TASKD', 0, 'public/test_info/dump-x.json')
        );
        const dump = JSON.stringify({
            threads: [{ thread_id: 1, thread_name: null, frames: [] }],
            crash_info: { crashing_thread: 0, type: 'SIGSEGV' },
        });
        const { run } = await import('../cli/main.ts');
        const { captureStreams } = await import('../cli/context.ts');
        const cached = countingHttp({ [url]: dump });
        for (const _ of [1, 2]) {
            const streams = captureStreams();
            await run({
                argv: ['crash', 'TASKD', 'dump-x', '--json'],
                streams,
                cache: diskCache({ directory }),
                httpFetch: cached,
            });
        }
        // The other per-task-artifact consumer, benefiting from the same
        // wrapper rather than merely not regressed.
        assert.equal(cached.calls.length, 1, 'the second crash read must fetch nothing');

        const uncached = countingHttp({ [url]: dump });
        for (const _ of [1, 2]) {
            const streams = captureStreams();
            await run({
                argv: ['crash', 'TASKD', 'dump-x', '--json', '--no-cache'],
                streams,
                cache: diskCache({ directory }),
                httpFetch: uncached,
            });
        }
        assert.equal(uncached.calls.length, 2, '--no-cache must bypass the dump cache');
    });
});

test('--no-cache re-reads a settled push’s job list', async () => {
    await withCacheDir(async (directory) => {
        const root = 'https://treeherder.mozilla.org';
        const bodies = {
            [`${root}/api/project/try/push/?full=true&count=10&revision=7d16bff8`]: JSON.stringify({
                results: [{ id: 1988598, revision: '7d16bff8', revisions: [] }],
            }),
            [`${root}/api/jobs/?push_id=1988598`]: JSON.stringify({
                job_property_names: [
                    'id', 'job_type_name', 'task_id', 'retry_id', 'state', 'result',
                ],
                results: [[1, 'build-linux', 'TASKB', 0, 'completed', 'success']],
                next: null,
            }),
        };
        const { run } = await import('../cli/main.ts');
        const { captureStreams } = await import('../cli/context.ts');
        const jobsUrl = `${root}/api/jobs/?push_id=1988598`;

        const cached = countingHttp(bodies);
        for (const _ of [1, 2]) {
            await run({
                argv: ['try', '7d16bff8', '--json'],
                streams: captureStreams(),
                source: await bucketSource(),
                cache: diskCache({ directory }),
                httpFetch: cached,
            });
        }
        assert.equal(
            cached.calls.filter((url) => url === jobsUrl).length,
            1,
            'a settled push’s job list is fetched once'
        );

        const uncached = countingHttp(bodies);
        for (const _ of [1, 2]) {
            await run({
                argv: ['try', '7d16bff8', '--json', '--no-cache'],
                streams: captureStreams(),
                source: await bucketSource(),
                cache: diskCache({ directory }),
                httpFetch: uncached,
            });
        }
        assert.equal(
            uncached.calls.filter((url) => url === jobsUrl).length,
            2,
            '--no-cache must bypass the job-list cache too'
        );
    });
});

test('fx-tests try caches its artifacts under --cache-dir, not elsewhere', async () => {
    await withCacheDir(async (directory) => {
        const http = countingFetcher({
            [`https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/TASKONE/runs/0/artifacts/public/profile_run-task-resource-usage.json`]:
                tinyProfile(E2E_TEST_PATH),
            [`https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/TASKTWO/runs/0/artifacts/public/profile_run-task-resource-usage.json`]:
                tinyProfile(E2E_TEST_PATH),
        });
        await runTryOnce(directory, http);
        const artifacts = (await diskCache({ directory }).list()).filter((entry) =>
            isImmutableKind(entry.kind)
        );
        // In the directory the flag names, and keyed by the URL that was
        // fetched. An entry written to the default directory would still make
        // the warm-run test above pass on a developer's machine and pollute
        // their real cache.
        assert.equal(artifacts.length, 2);
        assert.deepEqual(
            artifacts.map((entry) => entry.key).sort(),
            [
                'https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/TASKONE/runs/0/artifacts/public/profile_run-task-resource-usage.json',
                'https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/TASKTWO/runs/0/artifacts/public/profile_run-task-resource-usage.json',
            ]
        );
    });
});
