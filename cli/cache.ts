/**
 * The on-disk cache, and the reason a warm run costs no network at all.
 *
 * The aggregate files are tens of megabytes and change once a night, so
 * `CLI.md` asks for a cache "keyed by URL plus the file's
 * `metadata.generatedAt`". That phrasing hides a bootstrapping problem worth
 * being explicit about, because getting it wrong is how a cache ends up
 * "working" while still making a request every time:
 *
 * **`generatedAt` is inside the file.** You cannot key a lookup on it before
 * you have the bytes, so a cache that literally keyed on (URL, generatedAt)
 * would have to fetch the file to find out which cache entry to read — which
 * is the opposite of a cache. A conditional request (`If-Modified-Since`) is no
 * better: it is still a round trip, and `CLI.md` says a warm run should need
 * **no network at all**.
 *
 * So the split here is:
 *
 * - The **lookup key is the URL** (index + filename), hashed. That is what a
 *   caller knows before fetching.
 * - **`generatedAt` is recorded in the entry**, read from the bytes after a
 *   fetch. It is what the entry reports for provenance — `fx-tests cache`
 *   lists it, and every command prints the generation time of the data it
 *   used, so a stale answer is visible rather than silent.
 * - **Freshness is a TTL**, defaulting to the nightly cadence. Within the TTL
 *   the cached bytes are used with no request; past it the file is re-fetched
 *   and the new `generatedAt` recorded.
 *
 * That is what "keyed by URL plus generatedAt" can actually mean for a cache
 * that has to answer before it fetches, and the honest version of it: the URL
 * addresses the entry, `generatedAt` identifies which generation the entry
 * holds.
 *
 * ## Layout
 *
 * Two files per entry under the cache directory: `<hash>.json` holding the
 * bytes and `<hash>.meta.json` holding the metadata. Separate because the data
 * file is the thing that is tens of megabytes, and listing the cache
 * (`fx-tests cache`) should not read any of it.
 *
 * The bytes are stored verbatim rather than re-serialized: the cache is a
 * `DataSource` decorator and the contract is bytes in, the same bytes out.
 *
 * ## The second kind of entry: a completed task's own artifact
 *
 * Everything above describes the nightly aggregates. Per-task artifacts —
 * `fx-tests try`'s one resource-usage profile per failed job, and
 * `fx-tests crash`'s minidump — are a different shape, and the reasoning that
 * kept them out of the cache entirely was over-applied. Distinct *error
 * handling* (a 404 is exit 4, permanently gone; a 5xx is exit 3, try again) is
 * a good reason not to reuse the aggregates' semantics. It is not a reason to
 * skip caching, and skipping it made `fx-tests try <rev>` re-download 828 MB
 * on every single run — measured on try push 7d16bff8: 46 profiles, 4.7 MB to
 * 34 MB each, median 14.2 MB.
 *
 * A completed task's artifact is **immutable**. `<taskId>/runs/<retryId>/…`
 * fully determines the content; there is no `latest` that moves and no
 * `generatedAt` to compare. So these entries:
 *
 * - are keyed by the **artifact URL**, which is what the caller has;
 * - carry **no TTL**. Revalidating an immutable object is a round trip to
 *   learn something the key already told you. `TASK_ARTIFACT_KIND` marks them
 *   so `get()` knows not to expire them;
 * - are **bounded by total size** rather than by age, because unbounded is not
 *   acceptable at 828 MB per push. `pruneTaskArtifacts()` evicts the
 *   least-recently-fetched until the budget is met.
 *
 * Nothing negative is ever cached — see `cachedArtifactFetcher`.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
    mkdir,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';

import {
    type DataFileName,
    type DataSource,
    dataFileKey,
} from '../lib/sources/source.ts';

/**
 * What kind of thing an entry holds, which decides how it expires.
 *
 * `aggregate` is a published index file: it has a newer generation every
 * night, so it expires on a TTL. `task-artifact` is one completed task run's
 * own artifact, which never changes, so it does not expire at all and is
 * evicted by size instead.
 *
 * An entry with no `kind` recorded is an `aggregate`, which is what every
 * entry written before this field existed is.
 */
export const AGGREGATE_KIND = 'aggregate';
/** See `AGGREGATE_KIND`. */
export const TASK_ARTIFACT_KIND = 'task-artifact';

/** What is recorded alongside a cached file. */
export interface CacheEntryMeta {
    /** The `index/filename` this entry holds, for `fx-tests cache`'s listing. */
    key: string;
    /**
     * Which expiry rule applies. Absent means `aggregate`, for entries written
     * before the field existed.
     */
    kind?: string;
    /** The URL it came from, when the source knew one. */
    url?: string;
    /**
     * The file's own `metadata.generatedAt`, when it had one.
     *
     * Not every cached file does — `index.json` has no metadata block, and a
     * task artifact has none either — so this is optional, and its absence
     * means "this file does not say".
     */
    generatedAt?: string;
    /** When this entry was written, as an ISO timestamp. */
    fetchedAt: string;
    /** Size of the cached bytes. */
    bytes: number;
}

/**
 * A settled Treeherder push's job list. See `isSettledPush`.
 *
 * Its own kind rather than an aggregate, because its expiry rule is neither
 * the aggregates' 12 hours nor the artifacts' never: see
 * `SETTLED_PUSH_TTL_MS`.
 */
export const PUSH_JOBS_KIND = 'push-jobs';

/**
 * One live API query's response — the intermittents endpoints and Bugzilla.
 *
 * A fourth kind because neither other rule fits: there is no `generatedAt` for
 * the aggregates' TTL to track, and a range ending today keeps gaining
 * annotations, so it is not immutable either. See `QUERY_TTL_MS`.
 */
export const QUERY_KIND = 'query';

/** Whether an entry's kind means it never goes stale. See `AGGREGATE_KIND`. */
export function isImmutableKind(kind: string | undefined): boolean {
    return kind === TASK_ARTIFACT_KIND;
}

/** One entry, as `fx-tests cache` reports it. */
export interface CacheEntryInfo extends CacheEntryMeta {
    /** The hash the entry is filed under. */
    hash: string;
}

/** Options for `diskCache`. */
export interface DiskCacheOptions {
    /** Where entries live. Default `~/.cache/fx-tests`. */
    directory?: string | undefined;
    /**
     * How long a cached entry is used without re-fetching, in milliseconds.
     *
     * Default 12 hours, against a nightly regeneration cadence. Shorter than a
     * day on purpose: the index task's completion time drifts, and a 24-hour
     * TTL anchored to whenever the user last ran the command would routinely
     * serve yesterday's data for a whole extra day.
     */
    ttlMs?: number | undefined;
    /**
     * How many bytes of **task artifacts** the cache may hold.
     *
     * Only task artifacts, because only they are unbounded: the aggregates are
     * a fixed set of files that a TTL re-fetches in place, while a new Try push
     * adds 46 more profiles that nothing ever supersedes. Default
     * `DEFAULT_ARTIFACT_BUDGET_BYTES`.
     */
    artifactBudgetBytes?: number | undefined;
    /** Injected clock, for tests. */
    now?: (() => number) | undefined;
}

/** The default cache directory. */
export function defaultCacheDir(): string {
    const xdg = process.env['XDG_CACHE_HOME'];
    if (xdg !== undefined && xdg.length > 0) {
        return join(xdg, 'fx-tests');
    }
    return join(homedir(), '.cache', 'fx-tests');
}

/** Twelve hours. See `DiskCacheOptions.ttlMs`. */
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * How many bytes of cached task artifacts to keep. See
 * `DiskCacheOptions.artifactBudgetBytes`.
 *
 * Four gigabytes, chosen against the measured cost rather than a round number
 * that felt safe: one `fx-tests try` on push 7d16bff8 caches 828 MB of
 * profiles, so this holds roughly the last five pushes' worth. Fewer than that
 * and the common case — re-running `try` on the push you just pushed, having
 * looked at one other in between — starts missing, which is the case the cache
 * exists for.
 */
export const DEFAULT_ARTIFACT_BUDGET_BYTES = 4 * 1024 * 1024 * 1024;

/** The filename an entry is stored under. */
export function cacheHash(name: DataFileName): string {
    return createHash('sha256').update(dataFileKey(name)).digest('hex').slice(0, 32);
}

/**
 * The filename a task artifact is stored under, keyed by its URL.
 *
 * A separate function from `cacheHash` and not merely a different argument to
 * it: the two key spaces must not collide, and a URL is not an
 * `index/filename` pair. The prefix is what keeps them apart — without it a
 * caller could construct a `DataFileName` whose key is a URL and read another
 * kind of entry.
 *
 * The URL is the whole key because it already contains the task ID, the retry
 * and the artifact path, which is exactly what determines the content.
 */
export function urlCacheHash(url: string): string {
    return createHash('sha256').update(`url:${url}`).digest('hex').slice(0, 32);
}

/** The cache itself, usable on its own by `fx-tests cache`. */
export interface DiskCache {
    readonly directory: string;
    /** Cached bytes for a name, or `null` when absent or stale. */
    get(name: DataFileName): Promise<Uint8Array | null>;
    /** Stores bytes, recording `generatedAt` if the payload carries one. */
    put(name: DataFileName, bytes: Uint8Array, url?: string): Promise<void>;
    /**
     * Cached bytes of an immutable task artifact, or `null` when absent.
     *
     * No TTL: the URL names one run of one completed task, whose artifact
     * never changes. An entry that is there is correct however old it is.
     */
    getArtifact(url: string): Promise<Uint8Array | null>;
    /** Stores an immutable task artifact under its URL. */
    putArtifact(url: string, bytes: Uint8Array): Promise<void>;
    /**
     * A settled push's cached job list, or `null` when absent or past
     * `SETTLED_PUSH_TTL_MS`.
     */
    getPushJobs(key: string): Promise<Uint8Array | null>;
    /** Stores a settled push's job list. Only call it for a settled push. */
    putPushJobs(key: string, bytes: Uint8Array): Promise<void>;
    /**
     * A live query's cached response, or `null` when absent or past
     * `QUERY_TTL_MS`. See `QUERY_KIND`.
     */
    getQuery(url: string): Promise<Uint8Array | null>;
    /** Stores a live query's response under its URL. */
    putQuery(url: string, bytes: Uint8Array): Promise<void>;
    /**
     * Evicts the oldest task artifacts until they fit the budget.
     *
     * Returns how many were removed. Aggregates are never touched: they are a
     * bounded set that the TTL refreshes in place.
     */
    pruneTaskArtifacts(): Promise<number>;
    /** Every entry, for the `cache` command. */
    list(): Promise<CacheEntryInfo[]>;
    /** Deletes everything. Returns how many entries were removed. */
    clear(): Promise<number>;
}

/** Opens (does not create) a disk cache. */
export function diskCache(options: DiskCacheOptions = {}): DiskCache {
    const directory = options.directory ?? defaultCacheDir();
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const artifactBudgetBytes =
        options.artifactBudgetBytes ?? DEFAULT_ARTIFACT_BUDGET_BYTES;
    const now = options.now ?? Date.now;

    const dataPath = (hash: string): string => join(directory, `${hash}.json`);
    const metaPath = (hash: string): string => join(directory, `${hash}.meta.json`);

    async function readMeta(hash: string): Promise<CacheEntryMeta | null> {
        try {
            const text = await readFile(metaPath(hash), 'utf8');
            return JSON.parse(text) as CacheEntryMeta;
        } catch {
            // A missing or corrupt metadata file means "no usable entry".
            // Not an error: a cache that throws when its own directory is in
            // an unexpected state is worse than one that re-fetches.
            return null;
        }
    }

    async function readBytes(hash: string): Promise<Uint8Array | null> {
        try {
            return new Uint8Array(await readFile(dataPath(hash)));
        } catch {
            return null;
        }
    }

    /** Writes both files of one entry, data first. See `put()`. */
    async function writeEntry(hash: string, bytes: Uint8Array, meta: CacheEntryMeta): Promise<void> {
        await mkdir(directory, { recursive: true });
        // Data first, then metadata: the metadata file is what `get()` keys
        // on, so writing it last means a crash between the two leaves an
        // orphaned data file rather than metadata pointing at bytes that are
        // not there.
        await writeFile(dataPath(hash), bytes);
        await writeFile(metaPath(hash), JSON.stringify(meta, null, 2));
    }

    const self: DiskCache = {
        directory,

        async get(name: DataFileName): Promise<Uint8Array | null> {
            const hash = cacheHash(name);
            const meta = await readMeta(hash);
            if (meta === null) {
                return null;
            }
            const age = now() - Date.parse(meta.fetchedAt);
            if (!Number.isFinite(age) || age < 0 || age > ttlMs) {
                return null;
            }
            return readBytes(hash);
        },

        async put(name: DataFileName, bytes: Uint8Array, url?: string): Promise<void> {
            const meta: CacheEntryMeta = {
                key: dataFileKey(name),
                kind: AGGREGATE_KIND,
                fetchedAt: new Date(now()).toISOString(),
                bytes: bytes.byteLength,
            };
            if (url !== undefined) {
                meta.url = url;
            }
            const generatedAt = readGeneratedAt(bytes);
            if (generatedAt !== null) {
                meta.generatedAt = generatedAt;
            }
            await writeEntry(cacheHash(name), bytes, meta);
        },

        async getArtifact(url: string): Promise<Uint8Array | null> {
            const hash = urlCacheHash(url);
            const meta = await readMeta(hash);
            // No age check, and that is the point: the URL names one run of
            // one completed task. The kind is still checked, so an entry
            // written under some other rule cannot be served as immutable.
            if (meta === null || !isImmutableKind(meta.kind)) {
                return null;
            }
            return readBytes(hash);
        },

        async putArtifact(url: string, bytes: Uint8Array): Promise<void> {
            await writeEntry(urlCacheHash(url), bytes, {
                // The URL is the key, so it is also what `fx-tests cache`
                // lists: there is no shorter name that identifies the entry.
                key: url,
                kind: TASK_ARTIFACT_KIND,
                url,
                fetchedAt: new Date(now()).toISOString(),
                bytes: bytes.byteLength,
            });
        },

        async getPushJobs(key: string): Promise<Uint8Array | null> {
            const hash = urlCacheHash(key);
            const meta = await readMeta(hash);
            if (meta === null || meta.kind !== PUSH_JOBS_KIND) {
                return null;
            }
            // Its own TTL, neither the aggregates' 12 hours nor the artifacts'
            // never. See `SETTLED_PUSH_TTL_MS`: the entry was only written
            // because every job had finished, so the only thing that can
            // invalidate it is a retrigger.
            const age = now() - Date.parse(meta.fetchedAt);
            if (!Number.isFinite(age) || age < 0 || age > SETTLED_PUSH_TTL_MS) {
                return null;
            }
            return readBytes(hash);
        },

        async putPushJobs(key: string, bytes: Uint8Array): Promise<void> {
            await writeEntry(urlCacheHash(key), bytes, {
                key,
                kind: PUSH_JOBS_KIND,
                fetchedAt: new Date(now()).toISOString(),
                bytes: bytes.byteLength,
            });
        },

        async getQuery(url: string): Promise<Uint8Array | null> {
            const hash = urlCacheHash(url);
            const meta = await readMeta(hash);
            if (meta === null || meta.kind !== QUERY_KIND) {
                return null;
            }
            const age = now() - Date.parse(meta.fetchedAt);
            if (!Number.isFinite(age) || age < 0 || age > QUERY_TTL_MS) {
                return null;
            }
            return readBytes(hash);
        },

        async putQuery(url: string, bytes: Uint8Array): Promise<void> {
            await writeEntry(urlCacheHash(url), bytes, {
                key: url,
                kind: QUERY_KIND,
                url,
                fetchedAt: new Date(now()).toISOString(),
                bytes: bytes.byteLength,
            });
        },

        async pruneTaskArtifacts(): Promise<number> {
            const artifacts = (await self.list()).filter((entry) =>
                isImmutableKind(entry.kind)
            );
            let total = artifacts.reduce((sum, entry) => sum + entry.bytes, 0);
            if (total <= artifactBudgetBytes) {
                return 0;
            }
            // Oldest first. Least-recently-*fetched* rather than
            // least-recently-used: reading an entry does not rewrite its
            // metadata, so there is no use timestamp to order by, and adding
            // one would mean a write on every cache hit.
            artifacts.sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt));
            let removed = 0;
            for (const entry of artifacts) {
                if (total <= artifactBudgetBytes) {
                    break;
                }
                await rm(dataPath(entry.hash), { force: true });
                await rm(metaPath(entry.hash), { force: true });
                total -= entry.bytes;
                removed++;
            }
            return removed;
        },

        async list(): Promise<CacheEntryInfo[]> {
            let names: string[];
            try {
                names = await readdir(directory);
            } catch {
                return [];
            }
            const entries: CacheEntryInfo[] = [];
            for (const fileName of names) {
                if (!fileName.endsWith('.meta.json')) {
                    continue;
                }
                const hash = fileName.slice(0, -'.meta.json'.length);
                const meta = await readMeta(hash);
                if (meta !== null) {
                    entries.push({ ...meta, hash });
                }
            }
            entries.sort((a, b) => a.key.localeCompare(b.key));
            return entries;
        },

        async clear(): Promise<number> {
            let names: string[];
            try {
                names = await readdir(directory);
            } catch {
                return 0;
            }
            let removed = 0;
            for (const fileName of names) {
                if (fileName.endsWith('.meta.json')) {
                    removed++;
                }
                await rm(join(directory, fileName), { force: true });
            }
            return removed;
        },
    };
    return self;
}

/**
 * Reads `metadata.generatedAt` out of cached bytes without parsing the file.
 *
 * A regex over the first few kilobytes, and deliberately so: the alternative
 * is `JSON.parse` on a 45 MB download to read one string, which for a bucket
 * file costs a 195 MB heap peak (`FORMATS.md`) purely to write a cache entry.
 * `metadata` is the first key the generator emits, so the field is always near
 * the start.
 *
 * Returns `null` when the field is not there, which is a real case —
 * `index.json` has no metadata block — and not an error.
 */
export function readGeneratedAt(bytes: Uint8Array): string | null {
    const head = new TextDecoder().decode(bytes.subarray(0, 4096));
    const match = /"generatedAt"\s*:\s*"([^"]+)"/.exec(head);
    return match?.[1] ?? null;
}

/**
 * Wraps a source so its fetches are cached on disk.
 *
 * A decorator rather than a mode of `httpSource`, because the cache is a
 * Node-only concern and `lib/` must not touch `fs` (`PLAN.md` §2). It also
 * means `--no-cache` is "do not wrap" rather than a flag threaded through the
 * fetch path.
 *
 * A cache write failure is **not** fatal: a read-only or full cache directory
 * should make the CLI slower, not broken. The write error is reported through
 * `onWarning` so it is visible on stderr rather than swallowed.
 */
export function cachedSource(
    inner: DataSource,
    cache: DiskCache,
    hooks: {
        onHit?: ((name: DataFileName) => void) | undefined;
        onMiss?: ((name: DataFileName) => void) | undefined;
        onWarning?: ((message: string) => void) | undefined;
    } = {}
): DataSource {
    return {
        name: inner.name,
        async fetch(name: DataFileName): Promise<Uint8Array> {
            const cached = await cache.get(name);
            if (cached !== null) {
                hooks.onHit?.(name);
                return cached;
            }
            hooks.onMiss?.(name);
            const bytes = await inner.fetch(name);
            try {
                await cache.put(name, bytes);
            } catch (error) {
                hooks.onWarning?.(describeCacheWriteFailure(cache.directory, error));
            }
            return bytes;
        },
    };
}

/**
 * Wraps a per-URL artifact fetcher so its results are cached on disk.
 *
 * This is what `fx-tests try` reaches for: one resource-usage profile per
 * failed job, fetched by URL rather than by `DataFileName`. Before this
 * existed, two consecutive runs on try push 7d16bff8 each downloaded all 46 —
 * measured at 828 MB and 19 s cold, 7 s warm and still 46 requests.
 *
 * ## Nothing negative is cached, deliberately
 *
 * The fetcher's contract is `Uint8Array | null`, where `null` is "no artifact"
 * — and a `null` that came from a 404 means something permanently different
 * from a `null` that came from a 503. The caller cannot tell them apart from
 * the return value, so caching `null` would preserve a transient outage as if
 * it were an expired artifact, and a run made during a Taskcluster hiccup
 * would keep reporting missing profiles long after they were reachable again.
 *
 * The asymmetry is what settles it: caching a success can only ever be right,
 * because the content is immutable; caching a failure can be wrong, and the
 * wrong version is sticky. So a miss re-fetches, which costs one request on a
 * genuinely expired artifact and correctness on every transient one.
 */
export function cachedArtifactFetcher(
    inner: (url: string) => Promise<Uint8Array | null>,
    cache: DiskCache,
    hooks: {
        onHit?: ((url: string) => void) | undefined;
        onMiss?: ((url: string) => void) | undefined;
        onWarning?: ((message: string) => void) | undefined;
    } = {}
): (url: string) => Promise<Uint8Array | null> {
    return async (url: string): Promise<Uint8Array | null> => {
        const cached = await cache.getArtifact(url);
        if (cached !== null) {
            hooks.onHit?.(url);
            return cached;
        }
        hooks.onMiss?.(url);
        const bytes = await inner(url);
        if (bytes === null) {
            return null;
        }
        try {
            await cache.putArtifact(url, bytes);
        } catch (error) {
            hooks.onWarning?.(describeCacheWriteFailure(cache.directory, error));
        }
        return bytes;
    };
}

/**
 * Wraps a task-artifact `DataSource` so its fetches are cached on disk.
 *
 * The `DataSource` half of the same idea, for `fx-tests crash`. Keyed by the
 * same URL space, so the key is rebuilt from the name rather than taken from
 * the source — `taskArtifactSource` does not report the URL it used.
 *
 * **The error types pass straight through**, which is the requirement that
 * kept these out of the cache in the first place. A `DataFileNotFoundError`
 * still reaches `fx-tests crash` and still becomes exit 4; a `DataFetchError`
 * still becomes exit 3. Nothing is cached on either path — see
 * `cachedArtifactFetcher` for why a failure must not be sticky — so the cache
 * cannot turn one into the other.
 */
export function cachedTaskArtifactSource(
    inner: DataSource,
    cache: DiskCache,
    keyOf: (name: DataFileName) => string,
    hooks: {
        onWarning?: ((message: string) => void) | undefined;
    } = {}
): DataSource {
    return {
        name: inner.name,
        async fetch(name: DataFileName): Promise<Uint8Array> {
            const key = keyOf(name);
            const cached = await cache.getArtifact(key);
            if (cached !== null) {
                return cached;
            }
            // Not in a try/catch: a 404 must stay a `DataFileNotFoundError`
            // and a 5xx a `DataFetchError`, because the two are exit 4 and
            // exit 3 and the whole point of this source is that they differ.
            const bytes = await inner.fetch(name);
            try {
                await cache.putArtifact(key, bytes);
            } catch (error) {
                hooks.onWarning?.(describeCacheWriteFailure(cache.directory, error));
            }
            return bytes;
        },
    };
}

/**
 * Wraps a Treeherder client so a **settled** push's job list is cached.
 *
 * The judgement call this makes, stated plainly: the job list is cached and
 * the push lookup is not.
 *
 * **The job list is worth caching and can be cached safely.** It is 561 KB and
 * 0.3 s for a 1,731-job push (measured on try push 7d16bff8), and once every
 * job has finished it cannot change except by a retrigger — see
 * `isSettledPush` for why that is the condition rather than a TTL, and
 * `SETTLED_PUSH_TTL_MS` for why the entry still expires.
 *
 * **The push lookup is not.** It is 3.5 KB and 0.25 s, so there is little to
 * win, and it is the request that *resolves* a revision — including a
 * 12-character prefix, which can in principle match a different push later.
 * Caching the cheap half of a pair to save a quarter of a second, at the price
 * of resolving a revision from memory, is the wrong trade. It also keeps the
 * failure mode simple: `PushNotFoundError` for a push that does not exist yet
 * stays a live answer rather than a remembered one.
 */
export function cachedTreeherderJobs<
    J extends { state: string },
    C extends { jobsOfPush(pushId: number): Promise<J[]> },
>(inner: C, cache: DiskCache, hooks: { onWarning?: ((message: string) => void) | undefined } = {}): C {
    return {
        ...inner,
        async jobsOfPush(pushId: number): Promise<J[]> {
            const key = `treeherder:jobs:${pushId}`;
            const cached = await cache.getPushJobs(key);
            if (cached !== null) {
                try {
                    return JSON.parse(new TextDecoder().decode(cached)) as J[];
                } catch {
                    // A corrupt entry means "no usable entry", as everywhere
                    // else in this file: re-fetch rather than throw.
                }
            }
            const jobs = await inner.jobsOfPush(pushId);
            if (!isSettledPush(jobs)) {
                // A push still running must not be cached at all. The stale
                // read would report the failures that had landed so far and
                // call the rest of the push clean — see `isSettledPush`.
                return jobs;
            }
            try {
                await cache.putPushJobs(key, new TextEncoder().encode(JSON.stringify(jobs)));
            } catch (error) {
                hooks.onWarning?.(describeCacheWriteFailure(cache.directory, error));
            }
            return jobs;
        },
    };
}

/**
 * Job states that mean the job is not going to change again.
 *
 * Treeherder's states are `unscheduled`, `pending`, `running` and `completed`,
 * and only the last is terminal. Measured on live autoland push 1991559:
 * 1,906 unscheduled, 65 running, 28 completed, 1 pending — a push under way is
 * overwhelmingly *not* completed.
 */
const TERMINAL_JOB_STATES: ReadonlySet<string> = new Set(['completed']);

/**
 * Whether a push's job list can be cached: every job has finished.
 *
 * This is the whole Treeherder staleness rule, and it is deliberately not a
 * TTL. A TTL on a *finished* push wastes a request on data that will never
 * change again; a TTL on a *running* one serves a snapshot that was already
 * wrong when it was taken — and the way it is wrong is the dangerous
 * direction. `fx-tests try` only looks at completed jobs, so a half-finished
 * push cached mid-run reports the failures that had landed by then and calls
 * the rest of the push clean. That is a *confident wrong answer* to "did my
 * patch break anything", which is worse than the 0.6 s it costs to ask again.
 *
 * A settled push, by contrast, is as immutable as a task artifact: no state
 * can leave `completed`.
 *
 * The one thing this does not cover is a **retrigger** — someone adding a run
 * to a push that had settled. That adds a job the cached list does not have,
 * and it is why `SETTLED_PUSH_TTL_MS` exists rather than the entry being
 * permanent: a retriggered push is re-read within the day.
 */
export function isSettledPush(jobs: readonly { state: string }[]): boolean {
    return jobs.length > 0 && jobs.every((job) => TERMINAL_JOB_STATES.has(job.state));
}

/**
 * How long a settled push's job list is served from cache.
 *
 * Not `Infinity`, and the reason is retriggers: a push whose jobs have all
 * finished can still gain another run when someone re-runs a job on it, and
 * nothing in the cached list says so. A day is the compromise — long enough
 * that the triage loop this command exists for (push, look, fix, look again)
 * never re-downloads, short enough that a retrigger from yesterday is picked
 * up without anyone reaching for `--no-cache`.
 */
export const SETTLED_PUSH_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a live query's response is served from cache. See `QUERY_KIND`.
 *
 * An hour: the window moves continuously, but a ranking over days does not
 * reorder within one, and the scan costs a request per candidate bug — so
 * re-running with a different `--limit` must not repeat them.
 */
export const QUERY_TTL_MS = 60 * 60 * 1000;

/**
 * Wraps an intermittents client so its responses are cached on disk.
 *
 * Keyed on the query, rebuilt here from the arguments. Nothing is cached on
 * failure, for the reason `cachedArtifactFetcher` gives: a remembered outage is
 * sticky, and a remembered 400 would outlive the typo that caused it.
 */
export function cachedIntermittents<
    C extends {
        rankBugs(tree: string, range: { start: string; end: string }): Promise<unknown>;
        occurrencesOfBug(
            tree: string,
            range: { start: string; end: string },
            bug: number
        ): Promise<unknown>;
        runIdsOfJobs(jobIds: readonly number[]): Promise<Map<number, number>>;
        bugSummaries(bugs: readonly number[]): Promise<Map<number, string>>;
    },
>(
    inner: C,
    cache: DiskCache,
    hooks: { onWarning?: ((message: string) => void) | undefined } = {}
): C {
    async function through<T>(key: string, compute: () => Promise<T>): Promise<T> {
        const cached = await cache.getQuery(key);
        if (cached !== null) {
            try {
                return JSON.parse(new TextDecoder().decode(cached)) as T;
            } catch {
                // A corrupt entry means "no usable entry", as everywhere else
                // in this file: re-fetch rather than throw.
            }
        }
        const value = await compute();
        try {
            await cache.putQuery(key, new TextEncoder().encode(JSON.stringify(value)));
        } catch (error) {
            hooks.onWarning?.(describeCacheWriteFailure(cache.directory, error));
        }
        return value;
    }

    return {
        ...inner,
        rankBugs(tree: string, range: { start: string; end: string }) {
            return through(`intermittents:failures:${tree}:${range.start}:${range.end}`, () =>
                inner.rankBugs(tree, range)
            );
        },
        occurrencesOfBug(tree: string, range: { start: string; end: string }, bug: number) {
            return through(
                `intermittents:failuresbybug:${tree}:${range.start}:${range.end}:${bug}`,
                () => inner.occurrencesOfBug(tree, range, bug)
            );
        },
        async runIdsOfJobs(jobIds: readonly number[]): Promise<Map<number, number>> {
            // A completed job's run index never changes, but a job still
            // running can gain one, so this rides the same one-hour query TTL
            // rather than claiming to be immutable. Sorted for the reason
            // `bugSummaries` sorts: call order must not split the entry.
            const key = `intermittents:runids:${[...jobIds].sort((a, b) => a - b).join(',')}`;
            const entries = await through(key, async () => [...(await inner.runIdsOfJobs(jobIds))]);
            return new Map(entries);
        },
        async bugSummaries(bugs: readonly number[]): Promise<Map<number, string>> {
            // A `Map` does not survive `JSON.stringify`, so the entry array is
            // the cached form. Sorted so call order does not split the entry.
            const key = `bugzilla:summaries:${[...bugs].sort((a, b) => a - b).join(',')}`;
            const entries = await through(key, async () => [
                ...(await inner.bugSummaries(bugs)),
            ]);
            return new Map(entries);
        },
    };
}

/**
 * Turns a cache-write failure into something the reader can act on.
 *
 * The raw form was `EPERM: operation not permitted, mkdir '/proc'`, which is
 * accurate and useless: it does not say the command still worked, does not say
 * what the consequence is, and does not say what to do. Someone seeing it
 * mid-output reasonably concludes the run failed. It did not — the data below
 * the warning is complete, and only the caching of it was skipped.
 *
 * So the message states, in order: what could not be done, that the answer is
 * unaffected, what it costs, and the two flags that resolve it. The errno is
 * kept at the end, because it is the part worth pasting into a search.
 */
export function describeCacheWriteFailure(directory: string, error: unknown): string {
    const message = (error as Error | undefined)?.message ?? String(error);
    const code = (error as NodeJS.ErrnoException | undefined)?.code;

    const cause =
        code === 'EACCES' || code === 'EPERM'
            ? `no permission to write the cache directory ${directory}`
            : code === 'ENOSPC'
              ? `no space left to write the cache directory ${directory}`
              : code === 'EROFS'
                ? `the cache directory ${directory} is on a read-only filesystem`
                : `could not write the cache directory ${directory}`;

    return (
        `${cause}. The results below are complete and correct — only caching was ` +
        `skipped, so this run and the next one re-download instead of reading from ` +
        `disk. Use --cache-dir <path> to cache somewhere writable, or --no-cache to ` +
        `stop trying. (${message})`
    );
}

/** Total bytes held by the cache directory, for `fx-tests cache --size`. */
export async function cacheSize(cache: DiskCache): Promise<number> {
    let names: string[];
    try {
        names = await readdir(cache.directory);
    } catch {
        return 0;
    }
    let total = 0;
    for (const fileName of names) {
        try {
            total += (await stat(join(cache.directory, fileName))).size;
        } catch {
            // Raced with a concurrent clear; skip it.
        }
    }
    return total;
}
