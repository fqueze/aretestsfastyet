/**
 * Taskcluster index URLs, and the redirect-base cache.
 *
 * Ported from `fetchFromCI()` (`fetch-utils.js:63`) with two changes, both
 * required by `PLAN.md` §2's layering rule and by having a second consumer.
 *
 * **The fetch is injected.** `lib/` must not call global `fetch`. The caller
 * passes a `FetchLike`, which the browser satisfies with `fetch` itself and
 * Node satisfies with `fetch` wrapped in a disk cache (step 4). This is also
 * what makes `sources/` testable without a network — every test in this repo
 * passes a fake.
 *
 * **The data source is configuration, not a sniff.** `getDataSource()`
 * (`fetch-utils.js:27`) reads `window.location.protocol` and `.hostname` to
 * decide between `local`, `try` and `central`. That is a reasonable default for
 * a page and is meaningless for a CLI, which has a `--data-source` flag
 * instead. So the choice is a constructor parameter; a page computes it from
 * its own URL and passes it in.
 *
 * ## The index namespace
 *
 * Verified by request, not inferred:
 *
 * ```
 * https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/
 *   gecko.v2.{repository}.latest.source.test-info-{index}/artifacts/public/{filename}
 * ```
 *
 * This redirects to `firefoxci.taskcluster-artifacts.net`, where the bytes
 * actually are. Measured 2026-08-04: the status is **303**, not the 302 an
 * earlier note claimed. Immaterial to a `fetch`, which follows both, and
 * recorded because the number was written down wrong once.
 *
 * ## Why the redirect base is cached
 *
 * Every request to the index URL costs a redirect. `fetch-utils.js` remembers
 * the resolved prefix after the first response and builds subsequent URLs from
 * it, which turns *n* files into 1 redirect rather than *n*. The cache is
 * per-index — the point of the port is that there is more than one index — and
 * per-source, since `try` and `central` resolve to different tasks.
 *
 * The subtlety worth keeping: the resolved base is only good while the index
 * task is the same one. `latest` moves nightly, so a cached base outlives its
 * task and starts 404ing. A 404 against a cached base therefore **retries
 * against the index URL** rather than being reported as missing data, which is
 * a case `fetch-utils.js` does not handle because a page's lifetime is shorter
 * than a night.
 */

import {
    type DataFileName,
    type DataSource,
    DataFetchError,
    DataFileNotFoundError,
} from './source.ts';

/**
 * The subset of `fetch` this module uses.
 *
 * Narrower than the DOM's `fetch` on purpose: it names exactly what an
 * implementation has to provide, so a fake is five lines and does not have to
 * pretend to be a whole `Response`.
 */
export type FetchLike = (url: string) => Promise<FetchLikeResponse>;

/** The subset of `Response` this module uses. */
export interface FetchLikeResponse {
    ok: boolean;
    status: number;
    /** The final URL after redirects — what the base cache is read from. */
    url?: string | undefined;
    arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Where CI data is read from.
 *
 * `try` and `central` name the repository whose `latest` index task is read;
 * they are the same two `fetch-utils.js:68` picks between. `local` is not here
 * because it is not an HTTP source at all — a caller wanting `./data/` should
 * supply a different `DataSource`, which is the whole point of the interface.
 */
export type CiRepository = 'mozilla-central' | 'try';

/** Configuration for `httpSource`. */
export interface HttpSourceOptions {
    /** How bytes are actually fetched. Required — `lib/` has no global `fetch`. */
    fetch: FetchLike;
    /** Which repository's `latest` index task to read. Default `mozilla-central`. */
    repository?: CiRepository | undefined;
    /** Overrides the Taskcluster root, for a staging deployment or a test. */
    root?: string | undefined;
    /** The source's label, for diagnostics. Defaults to the repository. */
    name?: string | undefined;
}

/** The Firefox CI Taskcluster deployment. Same constant as `lib/links.ts`. */
export const FIREFOX_CI_ROOT = 'https://firefox-ci-tc.services.mozilla.com';

/**
 * The index-API URL of one artifact of the `latest` index task for an index.
 *
 * Pure string construction, exported so a caller can show the URL it is about
 * to fetch (the CLI prints it under `--verbose`) and so a test can assert the
 * namespace without a fetch.
 */
export function indexArtifactUrl(
    index: string,
    filename: string,
    repository: CiRepository = 'mozilla-central',
    root: string = FIREFOX_CI_ROOT
): string {
    return `${indexArtifactBase(index, repository, root)}${filename}`;
}

/** The prefix `indexArtifactUrl` appends a filename to. */
export function indexArtifactBase(
    index: string,
    repository: CiRepository = 'mozilla-central',
    root: string = FIREFOX_CI_ROOT
): string {
    return `${root}/api/index/v1/task/gecko.v2.${repository}.latest.source.test-info-${index}/artifacts/public/`;
}

/**
 * A `DataSource` reading the published files from the Taskcluster index.
 *
 * Holds one resolved-base cache for its lifetime, keyed by index name. A
 * caller wanting a fresh resolution — a long-running process crossing the
 * nightly boundary — makes a new source, or relies on the 404 retry below.
 */
export function httpSource(options: HttpSourceOptions): DataSource {
    const repository = options.repository ?? 'mozilla-central';
    const root = options.root ?? FIREFOX_CI_ROOT;
    const doFetch = options.fetch;
    /** index name -> the redirected base URL its artifacts are served from. */
    const resolvedBases = new Map<string, string>();

    async function get(name: DataFileName, url: string): Promise<Uint8Array | 'not-found'> {
        let response: FetchLikeResponse;
        try {
            response = await doFetch(url);
        } catch (error) {
            // A transport failure is not a missing file: `CLI.md` maps the two
            // to different exit codes precisely so a script can tell "retry"
            // from "never coming back".
            throw new DataFetchError(name, (error as Error).message, url);
        }
        if (response.status === 404) {
            return 'not-found';
        }
        if (!response.ok) {
            throw new DataFetchError(name, `HTTP ${response.status}`, url, response.status);
        }
        // Remember where the redirect landed, so the next file in this index
        // skips it. Only when it actually moved — a non-redirecting response
        // would otherwise cache the prefix we already build.
        const finalUrl = response.url;
        if (finalUrl) {
            const base = finalUrl.slice(0, finalUrl.lastIndexOf('/') + 1);
            const requested = url.slice(0, url.lastIndexOf('/') + 1);
            if (base && base !== requested) {
                resolvedBases.set(name.index, base);
            }
        }
        return new Uint8Array(await response.arrayBuffer());
    }

    return {
        name: options.name ?? repository,

        async fetch(name: DataFileName): Promise<Uint8Array> {
            const cachedBase = resolvedBases.get(name.index);
            if (cachedBase !== undefined) {
                const result = await get(name, `${cachedBase}${name.filename}`);
                if (result !== 'not-found') {
                    return result;
                }
                // The cached base belongs to an index task that has since been
                // superseded — `latest` moves nightly — so the file may well
                // exist under the new one. Drop the cache and resolve again
                // rather than reporting data that is there as missing.
                resolvedBases.delete(name.index);
            }

            const url = indexArtifactUrl(name.index, name.filename, repository, root);
            const result = await get(name, url);
            if (result === 'not-found') {
                throw new DataFileNotFoundError(name, url);
            }
            return result;
        },
    };
}

/**
 * A `DataSource` reading one task's own artifacts, rather than an index's.
 *
 * The dependency shape `PLAN.md` §4 calls out as new: `fx-tests crash` and
 * `--profiles` fetch a *specific task's* artifact, which can 404 because it was
 * never uploaded or because Taskcluster expired it. It shares no assumptions
 * with the aggregate cache — the URL is not stable across retries and the
 * content never changes — so it is a separate source rather than a mode of the
 * one above.
 *
 * `name.index` is the task ID here and `name.filename` the rest of the path
 * after it — `runs/<retryId>/<artifactPath>`, as `taskArtifactName()` builds
 * it. That is a slight abuse of the interface and the reason it is documented:
 * it buys `fetchJson()` and the error types for free.
 */
export function taskArtifactSource(options: {
    fetch: FetchLike;
    root?: string | undefined;
}): DataSource {
    const root = options.root ?? FIREFOX_CI_ROOT;
    return {
        name: 'task-artifacts',
        async fetch(name: DataFileName): Promise<Uint8Array> {
            const url = taskArtifactUrl(name, root);
            let response: FetchLikeResponse;
            try {
                response = await options.fetch(url);
            } catch (error) {
                throw new DataFetchError(name, (error as Error).message, url);
            }
            if (response.status === 404) {
                throw new DataFileNotFoundError(name, url);
            }
            if (!response.ok) {
                throw new DataFetchError(name, `HTTP ${response.status}`, url, response.status);
            }
            return new Uint8Array(await response.arrayBuffer());
        },
    };
}

/**
 * The queue URL `taskArtifactSource` fetches a name from.
 *
 * `/task/<id>/runs/<n>/artifacts/<path>`: the run comes *before* `artifacts`,
 * not after. `name.filename` already carries the `runs/<n>/artifacts/` prefix
 * from `taskArtifactName()`.
 *
 * Extracted so the disk cache can key an entry on the same URL the source
 * would have fetched, without the source having to report it. Two callers
 * building the string separately is exactly how a cache ends up keyed on
 * something the fetch does not use.
 */
export function taskArtifactUrl(name: DataFileName, root: string = FIREFOX_CI_ROOT): string {
    return `${root}/api/queue/v1/task/${name.index}/${name.filename}`;
}

/**
 * Names the artifact of a task run, for `taskArtifactSource`.
 *
 * The path after the task ID is `runs/<retryId>/artifacts/<artifactPath>` —
 * the run segment precedes `artifacts`, which is easy to transpose. Measured
 * 2026-08-04: the correct order answers 303 and the transposed one **403**,
 * so getting it wrong does not even fail like a missing artifact would.
 * `lib/links.ts` builds the same path for display, and a test asserts the two
 * agree.
 */
export function taskArtifactName(
    taskId: string,
    retryId: number,
    artifactPath: string
): DataFileName {
    return { index: taskId, filename: `runs/${retryId}/artifacts/${artifactPath}` };
}

/**
 * Names a task's **definition** — not an artifact of it — for the same source.
 *
 * `fx-tests task <taskId>` is handed a task ID and nothing else, so it has no
 * job name, no push and no repository. The queue's task document carries all
 * three: `metadata.name` and `tags.label` are the Treeherder job name,
 * `tags.project` the repository, and `metadata.source` the hg URL whose
 * second-to-last segment is the revision. One request replaces the push lookup
 * `fx-tests try` does.
 *
 * The empty `filename` is deliberate rather than a placeholder: `taskArtifactUrl`
 * joins the two with a slash, so the URL is `/api/queue/v1/task/<id>/`, and the
 * queue answers that with the task definition — measured 2026-09-03, HTTP 200
 * and the same body as the slashless form. Reusing that builder is what keeps
 * the disk cache keyed on the URL the fetch actually uses.
 */
export function taskDefinitionName(taskId: string): DataFileName {
    return { index: taskId, filename: '' };
}
