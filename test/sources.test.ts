/**
 * `lib/sources/`, against fakes. **No test here touches the network.**
 *
 * That is a requirement (`PLAN.md` §3 step 3) and also the point of the
 * interface: if a `DataSource` were hard to fake, the layering rule would be
 * decorative. Every test below supplies either a `memorySource` or a
 * `FetchLike` closure that records the URLs it was asked for, so what is being
 * asserted is the *URL construction and the caching policy* rather than
 * anything about HTTP.
 *
 * The behaviours worth defending:
 *
 * - The verified index namespace, exactly.
 * - The redirect base is cached per index, so *n* files cost one redirect.
 * - A 404 against a **cached** base re-resolves instead of reporting missing
 *   data. `latest` moves nightly, so a cached base outlives its index task —
 *   a case `fetch-utils.js` cannot hit because a page does not live that long.
 * - A missing file and a failed request are different errors, because
 *   `CLI.md` maps them to different exit codes.
 * - Treeherder's positional job rows are decoded through
 *   `job_property_names`, and a missing field throws rather than yielding a
 *   push with no jobs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DataFetchError,
    DataFileNotFoundError,
    MANIFEST_TIMINGS_INDEX,
    dataFileKey,
    fetchJson,
    memorySource,
    timingsIndex,
} from '../lib/sources/source.ts';
import type { DataFileName } from '../lib/sources/source.ts';
import {
    type FetchLike,
    type FetchLikeResponse,
    httpSource,
    indexArtifactBase,
    indexArtifactUrl,
    taskArtifactName,
    taskArtifactSource,
} from '../lib/sources/http.ts';
import { resourceUsageProfileUrl, taskArtifactUrl } from '../lib/links.ts';
import {
    FAILED_JOB_RESULTS,
    PushNotFoundError,
    TreeherderError,
    type TreeherderJob,
    findTimingsJobs,
    isFailedJob,
    treeherderClient,
} from '../lib/sources/treeherder.ts';
import {
    CURRENT_LANDO_INSTANCE,
    DEFAULT_LANDO_INSTANCE,
    LANDO_INSTANCES,
    LandingJobNotFoundError,
    LandoError,
    MIN_REVISION_DIGITS,
    landingJobUrl,
    landoClient,
    looksLikeLandoCommitId,
    parseTreeherderUrl,
} from '../lib/sources/lando.ts';

const ROOT = 'https://firefox-ci-tc.services.mozilla.com';

/** A `FetchLike` over a URL → response map, recording every URL requested. */
function fakeFetch(
    handler: (url: string) => Partial<FetchLikeResponse> & { body?: string }
): { fetch: FetchLike; urls: string[] } {
    const urls: string[] = [];
    const fetch: FetchLike = (url: string) => {
        urls.push(url);
        const result = handler(url);
        const body = result.body ?? '';
        return Promise.resolve({
            ok: result.ok ?? true,
            status: result.status ?? 200,
            url: result.url,
            arrayBuffer: () =>
                Promise.resolve(
                    new TextEncoder().encode(body).buffer as ArrayBuffer
                ),
        });
    };
    return { fetch, urls };
}

// --- the interface -------------------------------------------------------

test('the index namespace is built exactly as verified', () => {
    assert.equal(
        indexArtifactUrl('xpcshell-timings', 'xpcshell-00.json'),
        `${ROOT}/api/index/v1/task/gecko.v2.mozilla-central.latest.source.test-info-xpcshell-timings/artifacts/public/xpcshell-00.json`
    );
    // `try` names a different repository's `latest` task — the same choice
    // `fetch-utils.js:68` makes, but as configuration rather than a hostname
    // sniff.
    assert.equal(
        indexArtifactUrl('mochitest-timings', 'index.json', 'try'),
        `${ROOT}/api/index/v1/task/gecko.v2.try.latest.source.test-info-mochitest-timings/artifacts/public/index.json`
    );
    // More than one index, which is the reason for the port: `manifests.json`
    // lives under its own.
    assert.equal(
        indexArtifactUrl(MANIFEST_TIMINGS_INDEX, 'manifests.json'),
        `${ROOT}/api/index/v1/task/gecko.v2.mozilla-central.latest.source.test-info-manifest-timings/artifacts/public/manifests.json`
    );
    assert.ok(indexArtifactBase('xpcshell-timings').endsWith('/artifacts/public/'));
});

test('timingsIndex names a harness index and the manifest index is its own', () => {
    assert.equal(timingsIndex('xpcshell'), 'xpcshell-timings');
    assert.equal(timingsIndex('mochitest'), 'mochitest-timings');
    // `manifest-timings` is a separate index rather than a harness's, which is
    // why it is a constant and not `timingsIndex('manifest')` — the two happen
    // to spell the same string, and relying on that coincidence would tie an
    // unrelated index to the harness naming rule.
    assert.equal(MANIFEST_TIMINGS_INDEX, 'manifest-timings');
    assert.notEqual(MANIFEST_TIMINGS_INDEX, timingsIndex('xpcshell'));
});

test('memorySource serves bytes and reports a miss as not-found', async () => {
    const source = memorySource(
        new Map([['xpcshell-timings/index.json', '{"dates":["2026-08-03"]}']])
    );
    const name: DataFileName = { index: 'xpcshell-timings', filename: 'index.json' };
    const parsed = await fetchJson<{ dates: string[] }>(source, name);
    assert.deepEqual(parsed.dates, ['2026-08-03']);

    await assert.rejects(
        source.fetch({ index: 'xpcshell-timings', filename: 'nope.json' }),
        DataFileNotFoundError
    );
});

test('fetchJson names the file when the body is not JSON', async () => {
    // The realistic failure: an HTML error page arriving where 45 MB of JSON
    // was expected. `Unexpected token <` on its own is a poor error.
    const source = memorySource(new Map([['x/y.json', '<html>502</html>']]));
    await assert.rejects(
        fetchJson(source, { index: 'x', filename: 'y.json' }),
        (error: Error) => error instanceof DataFetchError && /y\.json/.test(error.message)
    );
});

test('dataFileKey is the cache key both index and filename contribute to', () => {
    assert.equal(
        dataFileKey({ index: 'xpcshell-timings', filename: 'a.json' }),
        'xpcshell-timings/a.json'
    );
    // Two indexes can publish the same filename, so the index has to be in the
    // key or one would evict the other.
    assert.notEqual(
        dataFileKey({ index: 'xpcshell-timings', filename: 'index.json' }),
        dataFileKey({ index: 'mochitest-timings', filename: 'index.json' })
    );
});

// --- the redirect base cache ---------------------------------------------

const REDIRECT_BASE = 'https://firefoxci.taskcluster-artifacts.net/ABC/0/public/';

test('the resolved redirect base is cached per index', async () => {
    const { fetch, urls } = fakeFetch((url) => ({
        body: '{}',
        // Every index URL 302s to the artifacts host; a `FetchLike` follows
        // redirects and reports where it landed.
        url: url.includes('/api/index/')
            ? `${REDIRECT_BASE}${url.slice(url.lastIndexOf('/') + 1)}`
            : url,
    }));
    const source = httpSource({ fetch });

    await source.fetch({ index: 'xpcshell-timings', filename: 'a.json' });
    await source.fetch({ index: 'xpcshell-timings', filename: 'b.json' });
    await source.fetch({ index: 'xpcshell-timings', filename: 'c.json' });

    // One redirect for the first file, none after: three files, one resolution.
    assert.equal(urls.filter((url) => url.includes('/api/index/')).length, 1);
    assert.deepEqual(urls.slice(1), [`${REDIRECT_BASE}b.json`, `${REDIRECT_BASE}c.json`]);
});

test('the cache is per index, so a second index resolves separately', async () => {
    const { fetch, urls } = fakeFetch((url) => ({
        body: '{}',
        url: url.includes('/api/index/')
            ? `${REDIRECT_BASE}${url.slice(url.lastIndexOf('/') + 1)}`
            : url,
    }));
    const source = httpSource({ fetch });

    await source.fetch({ index: 'xpcshell-timings', filename: 'a.json' });
    await source.fetch({ index: MANIFEST_TIMINGS_INDEX, filename: 'manifests.json' });

    // Two indexes, two resolutions: caching one against the other would fetch
    // the wrong task's artifacts.
    const indexUrls = urls.filter((url) => url.includes('/api/index/'));
    assert.equal(indexUrls.length, 2);
    assert.ok(indexUrls[0]!.includes('test-info-xpcshell-timings'));
    assert.ok(indexUrls[1]!.includes('test-info-manifest-timings'));
});

test('a 404 against a cached base re-resolves instead of reporting missing data', async () => {
    // `latest` moves nightly, so a cached base outlives its index task. A page
    // never lives long enough to see this; a long-running CLI process does.
    let staleBaseExhausted = false;
    const { fetch, urls } = fakeFetch((url) => {
        if (url.startsWith(REDIRECT_BASE)) {
            if (!staleBaseExhausted) {
                return { body: '{}', url };
            }
            return { ok: false, status: 404 };
        }
        // The index URL always resolves, to a *new* base after the rollover.
        const base = staleBaseExhausted
            ? 'https://firefoxci.taskcluster-artifacts.net/DEF/0/public/'
            : REDIRECT_BASE;
        return { body: '{}', url: `${base}${url.slice(url.lastIndexOf('/') + 1)}` };
    });
    const source = httpSource({ fetch });

    await source.fetch({ index: 'xpcshell-timings', filename: 'a.json' });
    staleBaseExhausted = true;
    urls.length = 0;

    // Must succeed: the file exists under the new index task.
    const bytes = await source.fetch({ index: 'xpcshell-timings', filename: 'b.json' });
    assert.equal(new TextDecoder().decode(bytes), '{}');
    // It tried the stale base, got a 404, and went back to the index URL.
    assert.equal(urls.length, 2);
    assert.ok(urls[0]!.startsWith(REDIRECT_BASE));
    assert.ok(urls[1]!.includes('/api/index/'));
});

test('a genuine 404 is not-found, and a 500 is a fetch error', async () => {
    // `CLI.md` maps the two to different exit codes: "never published" versus
    // "try again in a minute". Collapsing them loses that.
    const notFound = httpSource({ fetch: fakeFetch(() => ({ ok: false, status: 404 })).fetch });
    await assert.rejects(
        notFound.fetch({ index: 'xpcshell-timings', filename: 'gone.json' }),
        DataFileNotFoundError
    );

    const serverError = httpSource({
        fetch: fakeFetch(() => ({ ok: false, status: 503 })).fetch,
    });
    await assert.rejects(
        serverError.fetch({ index: 'xpcshell-timings', filename: 'a.json' }),
        (error: Error) => error instanceof DataFetchError && (error as DataFetchError).status === 503
    );
});

test('a transport failure is a fetch error, not a missing file', async () => {
    const source = httpSource({
        fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await assert.rejects(
        source.fetch({ index: 'xpcshell-timings', filename: 'a.json' }),
        (error: Error) =>
            error instanceof DataFetchError && /ECONNREFUSED/.test(error.message)
    );
});

test('the source is labelled by its repository for diagnostics', () => {
    const { fetch } = fakeFetch(() => ({ body: '{}' }));
    assert.equal(httpSource({ fetch }).name, 'mozilla-central');
    assert.equal(httpSource({ fetch, repository: 'try' }).name, 'try');
    assert.equal(httpSource({ fetch, name: 'staging' }).name, 'staging');
});

// --- per-task artifacts --------------------------------------------------

test('taskArtifactSource reads one task run rather than an index', async () => {
    const { fetch, urls } = fakeFetch(() => ({ body: '{"crash_info":{}}' }));
    const source = taskArtifactSource({ fetch });
    const name = taskArtifactName('ABC', 2, 'public/test_info/dump.json');
    await source.fetch(name);
    assert.deepEqual(urls, [
        `${ROOT}/api/queue/v1/task/ABC/runs/2/artifacts/public/test_info/dump.json`,
    ]);
});

test('the fetched artifact URL matches the one links.ts prints', async () => {
    // These two build the same path independently — one to fetch, one to show
    // the user — and they diverged during development: the run segment goes
    // *before* `artifacts`, and transposing it 404s in a way that looks
    // exactly like an expired artifact. Asserting they agree is what catches
    // that, since neither is wrong in isolation.
    const { fetch, urls } = fakeFetch(() => ({ body: '{}' }));
    await taskArtifactSource({ fetch }).fetch(
        taskArtifactName('ABC', 2, 'public/test_info/profile_resource-usage.json')
    );
    assert.equal(urls[0], resourceUsageProfileUrl('ABC', 2));
    assert.equal(
        urls[0],
        taskArtifactUrl('ABC', 2, 'public/test_info/profile_resource-usage.json')
    );
});

test('an expired task artifact is not-found, distinctly from an outage', async () => {
    // The 4-vs-3 exit-code split: "this dump is never coming back" versus
    // "Taskcluster is down".
    const gone = taskArtifactSource({ fetch: fakeFetch(() => ({ ok: false, status: 404 })).fetch });
    await assert.rejects(
        gone.fetch(taskArtifactName('ABC', 0, 'public/x.json')),
        DataFileNotFoundError
    );

    const down = taskArtifactSource({ fetch: fakeFetch(() => ({ ok: false, status: 500 })).fetch });
    await assert.rejects(down.fetch(taskArtifactName('ABC', 0, 'public/x.json')), DataFetchError);
});

// --- Treeherder ----------------------------------------------------------

/** A Treeherder fake serving a push and one or two pages of jobs. */
function treeherderFake(pages: unknown[], push: unknown = { results: [{ id: 42 }] }) {
    let page = 0;
    const { fetch, urls } = fakeFetch((url) => {
        if (url.includes('/push/')) {
            return { body: JSON.stringify(push) };
        }
        const body = JSON.stringify(pages[page++] ?? { results: [] });
        return { body };
    });
    return { fetch, urls };
}

const PROPERTY_NAMES = ['id', 'job_type_name', 'task_id', 'retry_id', 'state', 'result'];

test('findPush resolves a revision to a push ID', async () => {
    const { fetch, urls } = treeherderFake([], {
        results: [{ id: 1234, revision: 'abcdef', revisions: [] }],
    });
    const client = treeherderClient({ fetch });
    const push = await client.findPush('try', 'abcdef');
    assert.equal(push.pushId, 1234);
    assert.equal(push.repository, 'try');
    assert.match(urls[0]!, /\/api\/project\/try\/push\/\?full=true&count=10&revision=abcdef/);
});

test('a revision with no push is a distinct error, not a crash', async () => {
    const { fetch } = treeherderFake([], { results: [] });
    const client = treeherderClient({ fetch });
    await assert.rejects(client.findPush('try', 'nope'), PushNotFoundError);
});

test('jobsOfPush decodes the positional rows through job_property_names', async () => {
    const { fetch } = treeherderFake([
        {
            job_property_names: PROPERTY_NAMES,
            results: [
                [1, 'test-linux2404-64/opt-xpcshell-3', 'AAA', 0, 'completed', 'success'],
                [2, 'test-linux2404-64/debug-xpcshell-1', 'BBB', 1, 'completed', 'testfailed'],
            ],
            next: null,
        },
    ]);
    const jobs = await treeherderClient({ fetch }).jobsOfPush(42);
    assert.deepEqual(jobs, [
        {
            jobId: 1,
            jobName: 'test-linux2404-64/opt-xpcshell-3',
            taskId: 'AAA',
            retryId: 0,
            state: 'completed',
            result: 'success',
        },
        {
            jobId: 2,
            jobName: 'test-linux2404-64/debug-xpcshell-1',
            taskId: 'BBB',
            retryId: 1,
            state: 'completed',
            result: 'testfailed',
        },
    ]);
    assert.equal(isFailedJob(jobs[0]!), false);
    assert.equal(isFailedJob(jobs[1]!), true);
});

test('pagination follows next, and the property names carry across pages', async () => {
    const { fetch } = treeherderFake([
        {
            job_property_names: PROPERTY_NAMES,
            results: [[1, 'a', 'AAA', 0, 'completed', 'success']],
            next: 'https://treeherder.mozilla.org/api/jobs/?push_id=42&page=2',
        },
        // The second page does not repeat job_property_names, which is why the
        // client has to hold them.
        {
            results: [[2, 'b', 'BBB', 0, 'completed', 'success']],
            next: null,
        },
    ]);
    const jobs = await treeherderClient({ fetch }).jobsOfPush(42);
    assert.equal(jobs.length, 2);
    assert.deepEqual(jobs.map((job) => job.taskId), ['AAA', 'BBB']);
});

test('a missing property name throws instead of yielding a push with no jobs', async () => {
    // `old/try.html:791` uses indexOf(-1), reads undefined, and filters the job
    // out — so a Treeherder field rename presents as "this push has no jobs".
    const { fetch } = treeherderFake([
        {
            job_property_names: ['id', 'job_type_name', 'state', 'result'],
            results: [[1, 'a', 'completed', 'success']],
            next: null,
        },
    ]);
    await assert.rejects(
        treeherderClient({ fetch }).jobsOfPush(42),
        (error: Error) =>
            error instanceof TreeherderError && /missing task_id, retry_id/.test(error.message)
    );
});

test('a runaway next is refused rather than followed forever', async () => {
    const { fetch } = fakeFetch(() => ({
        body: JSON.stringify({
            job_property_names: PROPERTY_NAMES,
            results: [],
            // A `next` pointing at itself would loop against someone else's
            // server until the process died.
            next: 'https://treeherder.mozilla.org/api/jobs/?push_id=42',
        }),
    }));
    await assert.rejects(
        treeherderClient({ fetch, maxPages: 3 }).jobsOfPush(42),
        /exceeded 3 pages/
    );
});

test('an HTTP failure from Treeherder is reported with its status', async () => {
    const { fetch } = fakeFetch(() => ({ ok: false, status: 503 }));
    await assert.rejects(
        treeherderClient({ fetch }).findPush('try', 'abc'),
        (error: Error) =>
            error instanceof TreeherderError && (error as TreeherderError).status === 503
    );
});

test('a retried job is not a failed job', () => {
    // `retry` means the job was superseded by another run of the same task —
    // an infrastructure hiccup, not a test failure. Counting it would inflate
    // a push's failure count with jobs that were re-run and may have passed,
    // and `fx-tests try`'s "37 failed" line is built from exactly this set.
    assert.deepEqual([...FAILED_JOB_RESULTS].sort(), ['busted', 'exception', 'testfailed']);
    assert.equal(FAILED_JOB_RESULTS.has('retry'), false);
    assert.equal(FAILED_JOB_RESULTS.has('success'), false);
    assert.equal(FAILED_JOB_RESULTS.has('unknown'), false);

    const job = (result: string): TreeherderJob => ({
        jobId: 1,
        jobName: 'test-linux2404-64/opt-xpcshell-1',
        taskId: 'AAA',
        retryId: 0,
        state: 'completed',
        result,
    });
    assert.equal(isFailedJob(job('testfailed')), true);
    assert.equal(isFailedJob(job('busted')), true);
    assert.equal(isFailedJob(job('exception')), true);
    assert.equal(isFailedJob(job('retry')), false);
    assert.equal(isFailedJob(job('success')), false);
    assert.equal(isFailedJob(job('unknown')), false);

    // Over a mixed push, only three of the six count.
    const results = ['success', 'testfailed', 'retry', 'busted', 'exception', 'unknown'];
    assert.equal(results.map(job).filter(isFailedJob).length, 3);
});

test('findTimingsJobs keeps the last completed job per harness', () => {
    const job = (
        jobName: string,
        taskId: string,
        state = 'completed'
    ): Parameters<typeof findTimingsJobs>[0] extends Iterable<infer T> ? T : never =>
        ({ jobId: 0, jobName, taskId, retryId: 0, state, result: 'success' }) as never;

    const found = findTimingsJobs([
        job('source-test-xpcshell-timings-rev', 'FIRST'),
        // A re-trigger supersedes the earlier run, so the last wins.
        job('source-test-xpcshell-timings-rev', 'SECOND'),
        job('source-test-mochitest-timings-rev', 'MOCHI'),
        // Not completed: no artifacts to read.
        job('source-test-xpcshell-timings-rev', 'RUNNING', 'running'),
        job('test-linux2404-64/opt-xpcshell-1', 'UNRELATED'),
    ]);
    assert.equal(found.get('xpcshell'), 'SECOND');
    assert.equal(found.get('mochitest'), 'MOCHI');
    assert.equal(found.size, 2);
});

// --- Lando ---------------------------------------------------------------

test('a Treeherder URL carrying a revision is used directly, with no Lando trip', () => {
    // What the Treeherder UI's own address bar shows once a push is open, and
    // what gets pasted into a bug. It needs no resolution at all.
    assert.deepEqual(
        parseTreeherderUrl(
            'https://treeherder.mozilla.org/jobs?repo=try' +
                '&revision=276928d856a67e2fff01925eeea1d3777087b17f'
        ),
        {
            kind: 'revision',
            revision: '276928d856a67e2fff01925eeea1d3777087b17f',
            repository: 'try',
        }
    );
    // A URL somehow carrying both prefers the revision: asking Lando could
    // only produce the string already in hand.
    const both = parseTreeherderUrl(
        'https://treeherder.mozilla.org/jobs?repo=try&revision=abc123&landoCommitID=86670'
    );
    assert.equal(both?.kind, 'revision');
    // An empty `revision=` is no revision, so a `landoCommitID` beside it wins.
    assert.equal(
        parseTreeherderUrl(
            'https://treeherder.mozilla.org/jobs?revision=&landoCommitID=86670'
        )?.kind,
        'lando'
    );
});

test('a Treeherder Lando URL is read for its instance, ID and repo', () => {
    // The exact string Lando hands back after accepting a push.
    assert.deepEqual(
        parseTreeherderUrl(
            'https://treeherder.mozilla.org/jobs?repo=try' +
                '&landoInstance=lando-prod-2025&landoCommitID=86670'
        ),
        { kind: 'lando', commitId: 86670, instance: 'lando-prod-2025', repository: 'try' }
    );
    // Surrounding whitespace survives a paste.
    assert.equal(
        parseTreeherderUrl(
            '  https://treeherder.mozilla.org/jobs?landoCommitID=86670  '
        )?.kind,
        'lando'
    );
    // No `landoInstance` falls back to Treeherder's own default, not to the
    // instance a bare ID would use — a URL reproduces the UI's behaviour.
    const bare = parseTreeherderUrl('https://treeherder.mozilla.org/jobs?landoCommitID=86670');
    assert.equal(bare?.kind === 'lando' ? bare.instance : undefined, DEFAULT_LANDO_INSTANCE);
    assert.equal(bare?.repository, undefined);
    // `Number.parseInt`, as `getLandoJobsUrl()` uses: `1e3` is job 1 on both
    // sides, and trailing garbage is truncated rather than rejected.
    const exponent = parseTreeherderUrl(
        'https://treeherder.mozilla.org/jobs?landoCommitID=1e3'
    );
    assert.equal(exponent?.kind === 'lando' ? exponent.commitId : undefined, 1);
    const garbage = parseTreeherderUrl(
        'https://treeherder.mozilla.org/jobs?landoCommitID=86670abc'
    );
    assert.equal(garbage?.kind === 'lando' ? garbage.commitId : undefined, 86670);
});

test('an empty repo= is treated as absent rather than as a project named ""', () => {
    // `??` would keep the empty string, which reaches Treeherder as
    // `/api/project//push/`: a 404 naming no repository, reported as a
    // retryable upstream failure for a permanent input problem.
    assert.equal(
        parseTreeherderUrl('https://treeherder.mozilla.org/jobs?repo=&landoCommitID=86670')
            ?.repository,
        undefined
    );
    // The same for an empty landoInstance.
    const empty = parseTreeherderUrl(
        'https://treeherder.mozilla.org/jobs?landoInstance=&landoCommitID=86670'
    );
    assert.equal(empty?.kind === 'lando' ? empty.instance : undefined, DEFAULT_LANDO_INSTANCE);
});

test('a URL naming two landing jobs is refused rather than silently halved', () => {
    // Two IDs name two pushes, and picking either is a coin flip whose result
    // looks like a complete answer.
    assert.throws(
        () =>
            parseTreeherderUrl(
                'https://treeherder.mozilla.org/jobs?landoCommitID=86670&landoCommitID=86671'
            ),
        (error: unknown) => error instanceof LandoError && /more than one landing job/.test(error.message)
    );
});

test('anything that is not a Treeherder URL is left for Treeherder to resolve', () => {
    // A plain revision, the overwhelmingly common argument.
    assert.equal(parseTreeherderUrl('4f2c1a9e8b3d'), undefined);
    // Not a URL at all.
    assert.equal(parseTreeherderUrl('not a url'), undefined);
    // A URL, but not http(s) — nothing to fetch.
    assert.equal(parseTreeherderUrl('file:///tmp/x?landoCommitID=1'), undefined);
    // A Treeherder URL naming neither a revision nor a landing job.
    assert.equal(parseTreeherderUrl('https://treeherder.mozilla.org/jobs?repo=try'), undefined);
    // Not Treeherder's host. Nothing is ever fetched from the pasted origin,
    // but reading a landoCommitID out of someone else's URL and answering as
    // if it were Treeherder's is a confusing answer to a bad input.
    assert.equal(
        parseTreeherderUrl('https://evil.example.com/jobs?repo=try&landoCommitID=86670'),
        undefined
    );
    assert.equal(
        parseTreeherderUrl('https://evil.example.com/jobs?repo=try&revision=abc123'),
        undefined
    );
    // The staging deployment is Treeherder, though.
    assert.equal(
        parseTreeherderUrl('https://treeherder.allizom.org/jobs?revision=abc123')?.kind,
        'revision'
    );
    // A `landoCommitID` that is not a positive integer is not an ID.
    assert.equal(
        parseTreeherderUrl('https://treeherder.mozilla.org/jobs?landoCommitID=abc'),
        undefined
    );
    assert.equal(
        parseTreeherderUrl('https://treeherder.mozilla.org/jobs?landoCommitID=0'),
        undefined
    );
    assert.equal(
        parseTreeherderUrl('https://treeherder.mozilla.org/jobs?landoCommitID=-3'),
        undefined
    );
});

test('a bare argument is a landoCommitID only when it is too short to be a hash', () => {
    // The rule: all decimal digits, fewer than MIN_REVISION_DIGITS (8).
    assert.equal(MIN_REVISION_DIGITS, 8);
    assert.equal(looksLikeLandoCommitId('86670'), true);
    assert.equal(looksLikeLandoCommitId('  86670  '), true);
    assert.equal(looksLikeLandoCommitId('1'), true);
    // The boundary a reader will want to check: seven digits go to Lando,
    // eight stay a revision.
    assert.equal(looksLikeLandoCommitId('1234567'), true);
    assert.equal(looksLikeLandoCommitId('12345678'), false);
    // The literal in the regexp must track the constant.
    assert.equal(looksLikeLandoCommitId('9'.repeat(MIN_REVISION_DIGITS - 1)), true);
    assert.equal(looksLikeLandoCommitId('9'.repeat(MIN_REVISION_DIGITS)), false);
    // Any hex letter makes it a revision, at any length.
    assert.equal(looksLikeLandoCommitId('86670a'), false);
    assert.equal(looksLikeLandoCommitId('4f2c1a9e8b3d'), false);
    // Zero is not an ID, and neither is a non-integer.
    assert.equal(looksLikeLandoCommitId('0'), false);
    assert.equal(looksLikeLandoCommitId('866.70'), false);
    assert.equal(looksLikeLandoCommitId(''), false);
    // Shapes that must not sneak past the digit test.
    for (const odd of ['-1', '+5', '5.0', '1e5', '0x10', '1_0', '１２３']) {
        assert.equal(looksLikeLandoCommitId(odd), false, `${odd} is not a Lando ID`);
    }
});

test('the landing-job URL keeps its trailing slash and maps every instance', () => {
    // Without the slash Lando answers 301, and a `FetchLike` is not required
    // to follow one.
    assert.equal(
        landingJobUrl(86670, 'lando-prod-2025'),
        'https://lando.moz.tools/landing_jobs/86670/'
    );
    // Every instance in Treeherder's table is reachable.
    for (const [instance, host] of Object.entries(LANDO_INSTANCES)) {
        assert.equal(landingJobUrl(7, instance), `https://${host}/landing_jobs/7/`);
    }
    // An unknown instance falls back the way `getLandoJobsUrl()` does.
    assert.equal(
        landingJobUrl(7, 'lando-from-the-future'),
        `https://${LANDO_INSTANCES[DEFAULT_LANDO_INSTANCE]}/landing_jobs/7/`
    );
    // The instance a bare ID uses is the one that actually serves the
    // endpoint, which is not the URL fallback.
    assert.notEqual(CURRENT_LANDO_INSTANCE, DEFAULT_LANDO_INSTANCE);
    assert.equal(
        landingJobUrl(86670, CURRENT_LANDO_INSTANCE),
        'https://lando.moz.tools/landing_jobs/86670/'
    );
});

test('a landed job yields its revision, and an unlanded one yields its status', async () => {
    const landed = JSON.stringify({
        id: 86670,
        status: 'LANDED',
        commit_id: '276928d856a67e2fff01925eeea1d3777087b17f',
        repository: 'try',
        error: '',
        url: 'https://lando.moz.tools/landings/86670',
    });
    // Lando writes `""`, not `null` and not an absent field, before a job
    // lands. Normalised to `undefined` so it cannot be mistaken for a
    // revision — `findPush('')` would otherwise return the newest push.
    const queued = JSON.stringify({
        id: 87340,
        status: 'SUBMITTED',
        commit_id: '',
        repository: 'firefox-autoland',
        error: '',
        url: 'https://lando.moz.tools/landings/87340',
    });
    const { fetch, urls } = fakeFetch((url) => ({
        body: url.includes('/86670/') ? landed : queued,
    }));
    const client = landoClient({ fetch });

    const job = await client.landingJob(86670, 'lando-prod-2025');
    assert.equal(job.revision, '276928d856a67e2fff01925eeea1d3777087b17f');
    assert.equal(job.status, 'LANDED');
    assert.equal(job.repository, 'try');
    assert.deepEqual(urls, ['https://lando.moz.tools/landing_jobs/86670/']);

    const pending = await client.landingJob(87340, 'lando-prod-2025');
    assert.equal(pending.revision, undefined);
    assert.equal(pending.status, 'SUBMITTED');
});

test('an unknown landing job is not-found, and an unreadable answer is upstream', async () => {
    const missing = landoClient({
        // Lando returns a JSON *body* with the 404, so a client that only
        // looked at the body would read a job with no status.
        fetch: fakeFetch(() => ({
            ok: false,
            status: 404,
            body: JSON.stringify({ title: 'Landing job not found', status: 404 }),
        })).fetch,
    });
    await assert.rejects(
        () => missing.landingJob(999999, 'lando-prod-2025'),
        (error: unknown) => error instanceof LandingJobNotFoundError
    );

    const broken = landoClient({
        fetch: fakeFetch(() => ({ body: 'not json' })).fetch,
    });
    await assert.rejects(
        () => broken.landingJob(1, 'lando-prod-2025'),
        (error: unknown) => error instanceof LandoError
    );

    // A 200 with no `status` cannot say why there is no revision, which is the
    // whole of the not-yet-landed report, so it is an error rather than a job.
    const statusless = landoClient({
        fetch: fakeFetch(() => ({ body: JSON.stringify({ id: 1, commit_id: '' }) })).fetch,
    });
    await assert.rejects(
        () => statusless.landingJob(1, 'lando-prod-2025'),
        (error: unknown) => error instanceof LandoError
    );

    const down = landoClient({
        fetch: fakeFetch(() => ({ ok: false, status: 503 })).fetch,
    });
    await assert.rejects(
        () => down.landingJob(1, 'lando-prod-2025'),
        (error: unknown) => error instanceof LandoError && error.status === 503
    );
});
