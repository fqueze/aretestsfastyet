/**
 * Lando landing jobs, and the revision one of them produced.
 *
 * Lando is what actually pushes a queued patch stack, and the URL it hands back
 * when it accepts one names the landing job rather than the push:
 *
 * ```
 * https://treeherder.mozilla.org/jobs?repo=try&landoInstance=lando-prod-2025&landoCommitID=86670
 * ```
 *
 * There is no revision anywhere in that string — Lando does not know one until
 * the job has run — so anything that triages a push has to resolve the ID
 * first. Treeherder's UI does the same lookup client-side; `getLandoJobsUrl()`
 * in its `ui/helpers/url.js` is the function this module ports,
 * `LANDO_INSTANCES` below is its table verbatim, and the ID is read with the
 * same `Number.parseInt` so that `landoCommitID=1e3` names the same job on
 * both sides. The one deliberate divergence is the trailing slash, below.
 *
 * ## Why not Treeherder's own push API
 *
 * `/api/project/<repo>/push/` accepts `lando_instance` and `lando_commit_id`
 * and echoes both back under `filter_params`, which makes a request built on
 * them look like it worked. It **ignores them**: the response is whatever
 * landed most recently on that repository. Measured, and the reason this module
 * exists rather than a two-line addition to `lib/sources/treeherder.ts` — an
 * implementation on that path returns a plausible push for any ID and triages
 * the wrong one silently.
 *
 * ## The trailing slash
 *
 * `https://lando.moz.tools/landing_jobs/<id>/` — without the final slash the
 * request answers **301** rather than the JSON. Treeherder's helper builds the
 * slash-less form and relies on the redirect being followed; this one does not,
 * because a `FetchLike` is not required to follow redirects and a 301 body is
 * not JSON.
 *
 * ## A job that has not landed
 *
 * `commit_id` is the empty string, not absent, until the job reaches `LANDED`.
 * Observed 2026-09-03: `SUBMITTED` (queued, empty `commit_id`) and `FAILED`
 * (empty `commit_id`, with `error` carrying the hg output). Both are answers
 * rather than errors — "your push is still in the queue" is the useful thing to
 * say — so they come back as a `LandingJob` with no revision rather than as a
 * throw.
 */

import type { FetchLike } from './http.ts';

/**
 * Lando's deployments, keyed by the `landoInstance` a Treeherder URL carries.
 *
 * Copied from `getLandoJobsUrl()` (`ui/helpers/url.js:283` of
 * mozilla/treeherder). An unknown instance falls back to `lando-prod`, as it
 * does there.
 */
export const LANDO_INSTANCES: Readonly<Record<string, string>> = {
    'lando-dev': 'api.dev.lando.nonprod.cloudops.mozgcp.net',
    'lando-dev-2025': 'lando-dev.allizom.org',
    'lando-prod': 'api.lando.services.mozilla.com',
    'lando-prod-2025': 'lando.moz.tools',
};

/**
 * The instance a *URL* falls back to when it names none, or names one not in
 * the table. `getLandoJobsUrl()`'s fallback, kept identical so a URL resolves
 * the same way here as it does in Treeherder's own UI.
 */
export const DEFAULT_LANDO_INSTANCE = 'lando-prod';

/**
 * The instance a **bare** `landoCommitID` is looked up on.
 *
 * Not `DEFAULT_LANDO_INSTANCE`. A URL's fallback exists to reproduce
 * Treeherder's behaviour on a malformed URL; a bare ID has no URL and no
 * behaviour to reproduce, so what it needs is the instance that is actually
 * serving. Measured 2026-09-03: `lando-prod`
 * (`api.lando.services.mozilla.com`) has no `/landing_jobs/` endpoint at all
 * and answers 404 for **every** ID, so defaulting a bare ID to it would report
 * "no such landing job" for ids that exist.
 */
export const CURRENT_LANDO_INSTANCE = 'lando-prod-2025';

/** A landing job, as `/landing_jobs/<id>/` describes it. */
export interface LandingJob {
    id: number;
    /** `LANDED`, `SUBMITTED`, `IN_PROGRESS`, `FAILED`, `CANCELLED`, … */
    status: string;
    /**
     * The revision the job pushed, or `undefined` while it has none.
     *
     * Lando writes `""` rather than omitting the field before the job lands;
     * that is normalised to `undefined` here so a caller cannot mistake an
     * empty string for a revision.
     */
    revision: string | undefined;
    /** The Treeherder repository the job landed on, e.g. `try`. */
    repository: string | undefined;
    /** Lando's own failure text. Empty when there is none. */
    error: string;
    /** The human-facing Lando page for the job. */
    url: string | undefined;
}

/** Thrown when Lando is unreachable or answers with something unreadable. */
export class LandoError extends Error {
    readonly url: string;
    readonly status: number | undefined;

    constructor(message: string, url: string, status?: number) {
        super(message);
        this.name = 'LandoError';
        this.url = url;
        this.status = status;
    }
}

/** Thrown when Lando has no job with that ID — a real answer, not a failure. */
export class LandingJobNotFoundError extends Error {
    readonly commitId: number;
    readonly instance: string;

    constructor(commitId: number, instance: string) {
        super(`Lando has no landing job ${commitId} on ${instance}`);
        this.name = 'LandingJobNotFoundError';
        this.commitId = commitId;
        this.instance = instance;
    }
}

/** The Treeherder hosts a pasted `/jobs` URL may name. */
const TREEHERDER_HOSTS: ReadonlySet<string> = new Set([
    'treeherder.mozilla.org',
    'treeherder.allizom.org',
]);

/**
 * What a pasted Treeherder URL resolved to.
 *
 * Exactly one of `revision` and `commitId` is set. A URL carrying a `revision`
 * needs no resolution at all, so it is preferred when a URL somehow carries
 * both — there is nothing to gain by asking Lando for a revision that is
 * already in hand.
 */
export type TreeherderUrlTarget =
    | {
          kind: 'revision';
          revision: string;
          /** The `repo` parameter, when the URL had a non-empty one. */
          repository: string | undefined;
      }
    | {
          kind: 'lando';
          /** The `landoCommitID`. */
          commitId: number;
          /** The `landoInstance`, defaulted when the URL named none. */
          instance: string;
          repository: string | undefined;
      };

/**
 * Reads a pasted Treeherder `/jobs` URL, or returns `undefined` for anything
 * else.
 *
 * The two shapes a user actually has in the clipboard, and both are accepted:
 *
 * - `?repo=try&revision=<hash>` — what the Treeherder UI's address bar shows
 *   once a push is open, and what a colleague pastes into a bug.
 * - `?repo=try&landoInstance=…&landoCommitID=<id>` — what Lando hands back
 *   when it accepts a push, before any revision exists.
 *
 * Restricted to Treeherder's own hosts. Nothing is ever fetched from the
 * pasted origin — the Lando request goes to `LANDO_INSTANCES` and the push
 * lookup to `TREEHERDER_ROOT` — but silently reading a `landoCommitID` out of
 * `https://evil.example.com/jobs?…` and answering as if it were Treeherder's
 * is a confusing answer to a bad input rather than a useful one.
 *
 * Pure, so the parsing is testable without a network.
 */
export function parseTreeherderUrl(raw: string): TreeherderUrlTarget | undefined {
    const trimmed = raw.trim();
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return undefined;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return undefined;
    }
    if (!TREEHERDER_HOSTS.has(url.hostname)) {
        return undefined;
    }
    // `??` would not do: `?repo=` is present and empty, and an empty project
    // reaches Treeherder as `/api/project//push/` — a 404 naming no repository
    // at all, reported as a retryable upstream failure for what is a
    // permanent input problem.
    const repository = emptyAsUndefined(url.searchParams.get('repo'));

    // A revision wins over a `landoCommitID`: it is the answer the Lando
    // lookup would be trying to produce, so resolving it would be a request
    // that cannot change the outcome.
    const revision = emptyAsUndefined(url.searchParams.get('revision'));
    if (revision !== undefined) {
        return { kind: 'revision', revision, repository };
    }

    const ids = url.searchParams.getAll('landoCommitID');
    if (ids.length === 0) {
        return undefined;
    }
    // Repeated deliberately rather than silently: two IDs name two pushes, and
    // picking either is a coin flip whose result looks like a complete answer.
    if (ids.length > 1) {
        throw new LandoError(
            `the URL carries ${ids.length} landoCommitID parameters (${ids.join(', ')}); ` +
                `it names more than one landing job`,
            trimmed
        );
    }
    // `Number.parseInt`, not `Number`: `getLandoJobsUrl()` uses it, so
    // `landoCommitID=1e3` is job 1 here as it is in Treeherder's UI, and a
    // trailing-garbage `86670abc` resolves rather than being rejected.
    const commitId = Number.parseInt(ids[0]!, 10);
    if (!Number.isInteger(commitId) || commitId <= 0) {
        return undefined;
    }
    const instance =
        emptyAsUndefined(url.searchParams.get('landoInstance')) ?? DEFAULT_LANDO_INSTANCE;
    return { kind: 'lando', commitId, instance, repository };
}

/** A query parameter that is present but empty is no parameter at all. */
function emptyAsUndefined(value: string | null): string | undefined {
    return value === null || value === '' ? undefined : value;
}

/**
 * The width at or above which an all-digit argument is a revision, not a
 * Lando ID.
 *
 * Eight, and the number is a judgement about headroom rather than about any
 * property of a hash. Lando IDs are decimal and reached 87,000 — five digits —
 * in September 2026; eight leaves three orders of magnitude above that before
 * an ID could reach the boundary, which is far longer than this code will
 * live. Everything from eight digits up therefore goes back to being a
 * revision, which keeps the band of arguments whose meaning this rule
 * *changes* as narrow as it can be while still covering every ID Lando will
 * issue.
 */
export const MIN_REVISION_DIGITS = 8;

/**
 * Whether a bare argument should be read as a `landoCommitID`.
 *
 * The rule: **all decimal digits and fewer than `MIN_REVISION_DIGITS`
 * characters** is a Lando ID. Anything with a hex letter in it, of any length,
 * is a revision, and so is any all-digit string of eight characters or more.
 *
 * The reasoning is about what a human has in hand, not about what Treeherder
 * would do with the string: an all-digit argument that short is **not a hash
 * anyone would paste** — `hg` abbreviates to twelve characters and no tool in
 * this ecosystem abbreviates below seven — so it is read as a Lando ID by
 * design.
 *
 * **This is a deliberate reassignment, not a fix for something broken.**
 * Treeherder's push API prefix-matches a short string, so before this rule
 * `fx-tests try 86680` returned a real, complete report for push
 * `8668024b7fb8`. Measured 2026-09-04, most short prefixes resolve to exactly
 * one push — `86680`, `86690`, `11111`, `98765` and `00000` each match a
 * single one — so that behaviour was not unreliable, and any claim that it was
 * is contradicted by the data. It is simply not what someone typing five
 * digits means. Under this rule the same argument is a Lando ID, and
 * Treeherder's willingness to prefix-match it is beside the point.
 */
export function looksLikeLandoCommitId(raw: string): boolean {
    const trimmed = raw.trim();
    // The literal `7` is `MIN_REVISION_DIGITS - 1`; a test asserts the two
    // agree, so changing the constant alone cannot leave this stale.
    return /^[0-9]{1,7}$/.test(trimmed) && Number(trimmed) > 0;
}

/** The endpoint `landingJob` reads. Exported so a caller can print it. */
export function landingJobUrl(
    commitId: number,
    instance: string = DEFAULT_LANDO_INSTANCE
): string {
    const host = LANDO_INSTANCES[instance] ?? LANDO_INSTANCES[DEFAULT_LANDO_INSTANCE];
    // The trailing slash is load-bearing: without it Lando answers 301.
    return `https://${host}/landing_jobs/${commitId}/`;
}

/** What `landoClient` needs. */
export interface LandoOptions {
    /** How requests are made. Required — `lib/` has no global `fetch`. */
    fetch: FetchLike;
}

/** Landing-job lookup against Lando. */
export interface LandoClient {
    /**
     * One landing job. Throws `LandingJobNotFoundError` when there is no such
     * ID, which Lando reports as a 404 with a JSON body.
     */
    landingJob(commitId: number, instance?: string): Promise<LandingJob>;
}

/** Builds a client over an injected fetch. */
export function landoClient(options: LandoOptions): LandoClient {
    return {
        async landingJob(
            commitId: number,
            instance: string = DEFAULT_LANDO_INSTANCE
        ): Promise<LandingJob> {
            const url = landingJobUrl(commitId, instance);
            let response;
            try {
                response = await options.fetch(url);
            } catch (error) {
                throw new LandoError(
                    `request to Lando failed: ${(error as Error).message}`,
                    url
                );
            }
            if (response.status === 404) {
                throw new LandingJobNotFoundError(commitId, instance);
            }
            if (!response.ok) {
                throw new LandoError(`Lando returned HTTP ${response.status}`, url, response.status);
            }
            const text = new TextDecoder().decode(await response.arrayBuffer());
            let body: {
                id?: number;
                status?: string;
                commit_id?: string;
                repository?: string;
                error?: string;
                url?: string;
            };
            try {
                body = JSON.parse(text) as typeof body;
            } catch (error) {
                throw new LandoError(
                    `Lando response is not valid JSON: ${(error as Error).message}`,
                    url
                );
            }
            return readLandingJob(body, commitId, url);
        },
    };
}

/**
 * Turns Lando's JSON into a `LandingJob`.
 *
 * Separate from the fetch so a test can assert the empty-`commit_id`
 * normalisation without a network. `status` is required: without it the caller
 * cannot say why a job has no revision, which is the whole of the
 * not-yet-landed report.
 */
export function readLandingJob(
    body: {
        id?: number;
        status?: string;
        commit_id?: string;
        repository?: string;
        error?: string;
        url?: string;
    },
    commitId: number,
    url: string
): LandingJob {
    if (typeof body.status !== 'string') {
        throw new LandoError(`Lando job ${commitId} has no status`, url);
    }
    const revision = body.commit_id;
    return {
        id: typeof body.id === 'number' ? body.id : commitId,
        status: body.status,
        revision: revision === undefined || revision === '' ? undefined : revision,
        repository: body.repository,
        error: body.error ?? '',
        url: body.url,
    };
}
