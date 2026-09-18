/**
 * URL builders: Taskcluster artifacts, Treeherder, the profiler front end,
 * Searchfox, Bugzilla.
 *
 * Pure string construction, which is why it is worth having once rather than
 * inline in nine pages. The port from `common-links.js` is mostly mechanical.
 * One thing about it is not, and it is the reason this module exists as its own
 * step rather than as a footnote to `sources/`.
 *
 * ## The split: raw artifact URL vs profiler front-end URL
 *
 * `getProfilerUrl()` (`common-links.js:16`) does two things in one expression:
 * it derives the artifact URL of a profile, and it wraps that URL in
 * `profiler.firefox.com/from-url/…`. Fusing them was fine when every consumer
 * was a browser, and it is wrong now that one is not:
 *
 * - **A page** wants the wrapper. Its consumer is a human who will click the
 *   link and read a flame graph.
 * - **The CLI** wants the bare artifact URL. Its consumer is `profiler-cli`,
 *   which downloads and parses the profile itself, and for which a front-end
 *   URL is not merely unhelpful but unusable — it is an HTML page, not a
 *   profile.
 *
 * So the two halves are separate functions here, and the wrapper takes a URL
 * rather than deriving one. `profilerFrontEndUrl(resourceUsageProfileUrl(…))`
 * reproduces the old behaviour exactly, and the CLI simply omits the outer
 * call.
 *
 * ## Two kinds of profile, and only one is derivable
 *
 * | kind | filename | derivable from the task ID? |
 * | --- | --- | --- |
 * | resource-usage, one per job | fixed: `profile_resource-usage.json` | **yes** |
 * | per-test failure profile | appears only in the failure message | **no** |
 *
 * The second is the trap. A test that fails uploads a profile captured at the
 * moment of failure, under a name derived from the test — and the only place
 * that name is recorded is the failure message itself
 * (`"… profile uploaded in profile_foo.js.json"`, parsed at `old/try.html:2900`).
 * There is no listing to consult and no naming rule to apply: two tests in the
 * same job produce two different filenames, and a job where nothing failed
 * produced none at all.
 *
 * `uploadedProfileName()` therefore returns `null` rather than guessing, and
 * `CLI.md` makes the same promise to the user: where no profile was uploaded,
 * no URL is emitted.
 *
 * The extension is `.json` or `.json.gz` — test jobs moved to uploading the
 * profile gzipped. Both are accepted because a window of already-uploaded
 * artifacts uses the old name, and Treeherder serves their messages unchanged.
 * `.json` being a prefix of `.json.gz` is why the `(?:\.gz)?` matters: without
 * it the pattern still matched, backtracked to the shorter boundary and
 * returned a truncated filename, so the link 404ed instead of failing here.
 */

// --- Taskcluster ---------------------------------------------------------

/** The Firefox CI Taskcluster deployment every URL here is rooted at. */
export const FIREFOX_CI_ROOT = 'https://firefox-ci-tc.services.mozilla.com';

/**
 * The queue-API URL of one artifact of one run of one task.
 *
 * This is the shape every per-task artifact URL in the dashboards has, written
 * once. The `runs/<retryId>` segment is the **job-level** retry — the axis
 * `parseTaskId()` splits off a task ID's `.<n>` suffix — and not the harness's
 * within-job rerun, which has no URL of its own.
 *
 * Requests to this URL redirect to `firefoxci.taskcluster-artifacts.net` (303,
 * measured 2026-08-04); a caller that follows redirects — every `fetch`
 * implementation, by default — needs to do nothing about that.
 *
 * The segment order is `runs/<retryId>/artifacts/<path>`, and transposing the
 * run past `artifacts` yields a 403 rather than a 404, so it does not even
 * fail like a missing artifact. `sources/http.ts` builds the same path and a
 * test asserts the two agree.
 */
export function taskArtifactUrl(taskId: string, retryId: number, artifactPath: string): string {
    return `${FIREFOX_CI_ROOT}/api/queue/v1/task/${taskId}/runs/${retryId}/artifacts/${artifactPath}`;
}

/** An artifact under `public/test_info/`, where the test harness uploads. */
export function testInfoArtifactUrl(taskId: string, retryId: number, filename: string): string {
    return taskArtifactUrl(taskId, retryId, `public/test_info/${filename}`);
}

// --- profiles ------------------------------------------------------------

/**
 * The **raw** URL of a job's resource-usage profile.
 *
 * Fixed path, so it is derivable from the task ID and retry alone and is
 * available for any job whether or not anything failed. This is what shows
 * whether a timeout was the test being slow or the machine being saturated.
 *
 * Returns the artifact URL, not a profiler front-end link — see the module
 * comment. Wrap it in `profilerFrontEndUrl()` for a human.
 */
export function resourceUsageProfileUrl(taskId: string, retryId: number): string {
    return testInfoArtifactUrl(taskId, retryId, 'profile_resource-usage.json');
}

/**
 * The filename of the profile a failing test uploaded, from its failure
 * message, or `null` when the message names none.
 *
 * Ported verbatim from `extractUploadedProfileName()` (`old/try.html:2903`),
 * including the regex. The message looks like:
 *
 * ```
 * Found unexpected failures during the test; profile uploaded in profile_foo.js.json.gz
 * ```
 *
 * The extension is `.json.gz` on current jobs and `.json` on older uploads;
 * both are matched. See the module comment.
 *
 * `null` is the common case and is not an error: most failure messages carry no
 * profile, because the harness only captures one for certain failures. A caller
 * must not substitute a guessed filename — nothing in the data supports one.
 */
export function uploadedProfileName(message: string | null | undefined): string | null {
    if (!message) {
        return null;
    }
    const match = /profile uploaded in (profile_\S+\.json(?:\.gz)?)/.exec(message);
    return match?.[1] ?? null;
}

/**
 * The **raw** URL of the per-test failure profile named in a failure message,
 * or `null` when the message names none.
 *
 * The composition of `uploadedProfileName()` with `testInfoArtifactUrl()`, and
 * the reason both are exported: a caller that has already extracted the name
 * (to show it, or to dedupe on it) should not have to re-parse the message.
 */
export function uploadedProfileUrl(
    taskId: string,
    retryId: number,
    message: string | null | undefined
): string | null {
    const filename = uploadedProfileName(message);
    return filename === null ? null : testInfoArtifactUrl(taskId, retryId, filename);
}

/** Where the profiler front end lives. Overridable for local development. */
export const DEFAULT_PROFILER_ORIGIN = 'https://profiler.firefox.com';

/** Options for `profilerFrontEndUrl`. */
export interface ProfilerUrlOptions {
    /** The tab title the profiler shows. Omitted when absent. */
    profileName?: string | undefined;
    /** Pre-fills the profiler's marker search box, e.g. with the test name. */
    markerSearch?: string | undefined;
    /** Defaults to `DEFAULT_PROFILER_ORIGIN`. */
    origin?: string | undefined;
}

/**
 * Wraps a **raw** profile URL in a `profiler.firefox.com/from-url/…` link.
 *
 * The half of `getProfilerUrl()` that is about presentation. It takes a URL
 * rather than a task ID precisely so that it composes with either profile kind
 * — resource-usage or per-test — and so that a caller who does not want the
 * wrapper can simply not call it.
 *
 * `origin` is a parameter rather than being read from `?profiler=`
 * (`shared.js:32`): `lib/` must not touch `window`, and the override is
 * configuration. A page passes what it parsed from its own URL;
 * `resolveProfilerOrigin()` is the shorthand expansion that page needs.
 */
export function profilerFrontEndUrl(rawProfileUrl: string, options: ProfilerUrlOptions = {}): string {
    const origin = options.origin ?? DEFAULT_PROFILER_ORIGIN;
    let url = `${origin}/from-url/${encodeURIComponent(rawProfileUrl)}`;
    const query: string[] = [];
    if (options.profileName !== undefined) {
        query.push(`profileName=${encodeURIComponent(options.profileName)}`);
    }
    if (options.markerSearch !== undefined) {
        query.push(`markerSearch=${encodeURIComponent(options.markerSearch)}`);
    }
    return query.length > 0 ? `${url}?${query.join('&')}` : url;
}

/**
 * Expands the `?profiler=` shorthands into an origin.
 *
 * Ported from `getProfilerOrigin()` (`shared.js:32`) with the `window` read
 * lifted out: the caller passes the raw parameter value. The shorthands are a
 * developer affordance — `localhost` for a local build, `dp1234` for a Netlify
 * deploy preview — and are kept so a page's behaviour does not change when it
 * migrates onto this module.
 */
export function resolveProfilerOrigin(profilerParam: string | null | undefined): string {
    const profiler = (profilerParam ?? '').replace(/\/$/, '');
    if (!profiler) {
        return DEFAULT_PROFILER_ORIGIN;
    }
    if (profiler === 'localhost') {
        return 'http://localhost:4242';
    }
    const deployPreview = /^dp(\d+)$/.exec(profiler);
    if (deployPreview) {
        return `https://deploy-preview-${deployPreview[1]}--perf-html.netlify.app`;
    }
    return profiler.includes('://') ? profiler : `https://${profiler}`;
}

// --- crash dumps ---------------------------------------------------------

/**
 * The **raw** URL of a processed minidump-stackwalk JSON.
 *
 * `fx-tests crash` reads this directly. The `.json` suffix on the minidump ID
 * is the generator's convention, not part of the ID — `getCrashViewerUrl()`
 * (`common-links.js:33`) appends it the same way.
 */
export function minidumpJsonUrl(taskId: string, retryId: number, minidumpId: string): string {
    return testInfoArtifactUrl(taskId, retryId, `${minidumpId}.json`);
}

/**
 * The `crash-viewer.html` page URL for a dump — the browser-facing wrapper,
 * exactly parallel to `profilerFrontEndUrl()`.
 *
 * Relative, because the viewer is served alongside whichever page links to it.
 * The CLI wants `minidumpJsonUrl()` instead.
 */
export function crashViewerUrl(taskId: string, retryId: number, minidumpId: string): string {
    return `crash-viewer.html?url=${encodeURIComponent(minidumpJsonUrl(taskId, retryId, minidumpId))}`;
}

/**
 * The crash-stats search URL for a signature.
 *
 * `~` is crash-stats' "contains" operator, and the `@ ` prefix is stripped
 * before searching because crash-stats' own signatures do not carry it —
 * searching for `~@ Foo` matches nothing. Both are upstream's
 * (`old/crash-viewer.html:625`).
 */
export function crashStatsSearchUrl(signature: string): string {
    const bare = signature.replace(/^@ /, '');
    return `https://crash-stats.mozilla.org/search/?signature=${encodeURIComponent(`~${bare}`)}`;
}

// --- source references in a stackwalk ------------------------------------

/** A parsed `hg:`/`git:` source reference from minidump-stackwalk. */
export interface FileInfo {
    type: 'git' | 'hg';
    repo: string;
    revision: string;
    path: string;
}

/**
 * Parses the walker's source-file reference.
 *
 * Ported from `parseFileInfo()` (`old/crash-viewer.html:997`) unchanged, including
 * the `parts.length >= 4` guard and the `slice(2, -1).join(':')` that puts a
 * path containing a colon back together.
 *
 * The two spellings, both real:
 *
 * ```
 * hg:hg.mozilla.org/mozilla-central:xpcom/base/file.cpp:c536b1636b55af
 * git:github.com/rust-lang/rust:library/alloc/src/boxed.rs:05f9846f893b09a1
 * ```
 *
 * Anything else — an absolute path, an `s3:` reference, a bare filename —
 * returns `null`, and the caller shows the string as it is rather than
 * guessing at a repository. Both spellings occur in `artifacts/dumps/`, as do
 * `s3:gecko-generated-sources:…` references and Windows absolute paths.
 *
 * Here rather than in a page's view model because it is a **parser for walker
 * data**: `fx-tests crash` currently prints `frame.file` raw, so a reader sees
 * the whole `hg:hg.mozilla.org/mozilla-central:…:rev` string where the page
 * shows `xpcom/base/file.cpp`. Nothing about it names a UI.
 */
export function parseFileInfo(file: string | null | undefined): FileInfo | null {
    if (!file) {
        return null;
    }
    const parts = file.split(':');
    const kind = parts[0];
    if ((kind === 'git' || kind === 'hg') && parts.length >= 4) {
        return {
            type: kind,
            repo: parts[1]!,
            revision: parts[parts.length - 1]!,
            path: parts.slice(2, parts.length - 1).join(':'),
        };
    }
    return null;
}

/**
 * A browsable URL for a source reference, or `null` when there is none.
 *
 * `hg:` goes to hg.mozilla.org's file view and `git:` to GitHub's blob view,
 * and the two use different line-anchor spellings — `#l177` lowercase for hg,
 * `#L1976` uppercase for GitHub. Both are upstream's
 * (`old/crash-viewer.html:1023`) and both matter: the wrong case scrolls nowhere.
 */
export function sourceUrl(file: string | null | undefined, line: number | null): string | null {
    const info = parseFileInfo(file);
    if (info === null) {
        return null;
    }
    if (info.type === 'git') {
        return `https://${info.repo}/blob/${info.revision}/${info.path}${line ? `#L${line}` : ''}`;
    }
    return `https://${info.repo}/file/${info.revision}/${info.path}${line ? `#l${line}` : ''}`;
}

/**
 * A Searchfox link to a frame's source, or `null` for non-Mozilla code.
 *
 * Ported from `makeSearchfoxSearchUrl()` (`old/crash-viewer.html:1042`). Two
 * conditions are load-bearing and both are upstream's:
 *
 * - **`hg:` only.** A `git:` reference is a vendored third-party repository
 *   (rust-lang/rust, for instance), which Searchfox does not index under a
 *   Mozilla tree, so linking there would 404.
 * - **The last path segment of the repo is the tree name.**
 *   `hg.mozilla.org/releases/mozilla-beta` → `mozilla-beta`. Using the whole
 *   repo string builds a URL with slashes in the tree name.
 *
 * The name says "search" because that is what upstream called it; it has built
 * a direct `hgrev` file link, not a search, since whenever that was last
 * touched. The behaviour is kept and the misleading name is not.
 *
 * Distinct from `searchfoxUrl()` above, which searches for a *test path*: this
 * one resolves a stack frame to the exact revision the build came from.
 */
export function searchfoxFrameUrl(frame: {
    function: string | null;
    file: string | null;
    line: number | null;
}): string | null {
    if (!frame.function || !frame.file || !frame.line) {
        return null;
    }
    const info = parseFileInfo(frame.file);
    if (info === null || info.type !== 'hg') {
        return null;
    }
    const tree = info.repo.split('/').pop();
    return `https://searchfox.org/${tree}/hgrev/${info.revision}/${info.path}#${frame.line}`;
}

// --- Treeherder ----------------------------------------------------------

/** Treeherder's origin, shared with `sources/treeherder.ts`. */
export const TREEHERDER_ROOT = 'https://treeherder.mozilla.org';

/**
 * The Treeherder job view for one task run.
 *
 * `common-links.js:43` reaches into a data file to find the repository and
 * revision for a task ID; here they are parameters, because resolving them is
 * the caller's job and differs by file family. The `selectedTaskRun` parameter
 * wants the suffixed `"<taskId>.<retryId>"` form, which is what the timing
 * files store, so it is built rather than taken apart.
 */
export function treeherderJobUrl(
    repository: string,
    revision: string,
    taskId: string,
    retryId: number
): string {
    const params = new URLSearchParams({
        repo: repository,
        selectedTaskRun: `${taskId}.${retryId}`,
        revision,
    });
    return `${TREEHERDER_ROOT}/jobs?${params.toString()}`;
}

/** The Treeherder view of a whole push. */
export function treeherderPushUrl(repository: string, revision: string): string {
    const params = new URLSearchParams({ repo: repository, revision });
    return `${TREEHERDER_ROOT}/jobs?${params.toString()}`;
}

// --- Searchfox -----------------------------------------------------------

/**
 * The Searchfox source view of a test, optionally anchored at the line a
 * failure message names.
 *
 * The line comes out of messages shaped `"[child : 42] error text"`, which is
 * the only place the data records where in the file a failure happened. Ported
 * from `getSearchfoxUrl()` (`common-links.js:104`) with its regex unchanged.
 */
export function searchfoxUrl(testPath: string, message?: string | null): string {
    const url = `https://searchfox.org/mozilla-central/source/${testPath}`;
    if (!message) {
        return url;
    }
    const match = /^\[[^\] :]+ : (\d+)\]/.exec(message);
    return match ? `${url}#${match[1]}` : url;
}

/**
 * The line number a failure message names, or `null`.
 *
 * Exported separately because a caller that wants to *show* the line — rather
 * than link to it — should not have to build a URL and parse the fragment back
 * out. Same regex, one definition.
 */
export function messageLineNumber(message: string | null | undefined): number | null {
    if (!message) {
        return null;
    }
    const match = /^\[[^\] :]+ : (\d+)\]/.exec(message);
    return match?.[1] === undefined ? null : Number(match[1]);
}

// --- Bugzilla ------------------------------------------------------------

/** What `bugzillaFilingUrl` needs to pre-fill a bug. */
export interface BugFilingOptions {
    /** Full test path, used in the summary and the Searchfox link. */
    testPath: string;
    /** The failure message the bug is about. */
    summary: string;
    /** `"Product :: Component"`, as the data files store it. */
    component: string;
    /** Optional occurrence statistics, rendered into the description. */
    stats?:
        | {
              failureCount?: number | undefined;
              totalRuns?: number | undefined;
              firstDate?: string | undefined;
              lastDate?: string | undefined;
          }
        | undefined;
    /** A link back to the dashboard or command that found this. */
    sourceUrl?: string | undefined;
}

/**
 * A pre-filled Bugzilla filing URL for an intermittent failure.
 *
 * Ported from `getBugzillaUrl()` (`common-links.js:126`) minus its
 * `window.location` read: the "where this was found" link is now a parameter,
 * since the CLI has no page URL to offer and a page has one it already knows.
 *
 * A component that is not in `"Product :: Component"` form throws rather than
 * filing the bug into a product named after the whole string — a bug filed in
 * the wrong component is worse than one not filed.
 */
export function bugzillaFilingUrl(options: BugFilingOptions): string {
    const separator = options.component.indexOf(' :: ');
    if (separator === -1) {
        throw new Error(
            `component ${JSON.stringify(options.component)} is not in "Product :: Component" form`
        );
    }
    const product = options.component.slice(0, separator);
    const component = options.component.slice(separator + ' :: '.length);

    const params = new URLSearchParams();
    params.set('product', product);
    params.set('component', component);
    params.set('short_desc', `Intermittent ${options.testPath} | ${options.summary}`);
    params.set('comment', bugDescription(options));
    return `https://bugzilla.mozilla.org/enter_bug.cgi?${params.toString()}`;
}

/** The Markdown body of a filed bug. Split out so a test can read it directly. */
export function bugDescription(options: BugFilingOptions): string {
    const { testPath, summary, stats, sourceUrl } = options;
    let description = `Test: [${testPath}](${searchfoxUrl(testPath)})\n\n`;

    // When the message names a line, link the bracketed prefix at that line and
    // leave the rest of the message as prose — `common-links.js:150` does the
    // same, and it is what keeps the message readable in the bug.
    const lineUrl = searchfoxUrl(testPath, summary);
    if (lineUrl.includes('#')) {
        const end = summary.indexOf(']') + 1;
        description += `Failure message: [${summary.slice(0, end)}](${lineUrl})${summary.slice(end)}\n\n`;
    } else {
        description += `Failure message: ${summary}\n\n`;
    }

    if (stats?.failureCount) {
        const occurrence =
            stats.failureCount === 1 ? 'occurred once' : `occurred ${stats.failureCount} times`;
        const occurrenceText = sourceUrl ? `[${occurrence}](${sourceUrl})` : occurrence;

        let runInfo = '';
        if (stats.totalRuns !== undefined && stats.totalRuns > 0) {
            const percentage = ((stats.failureCount / stats.totalRuns) * 100).toFixed(2);
            runInfo = ` out of ${stats.totalRuns.toLocaleString('en-US')} runs (${percentage}%)`;
        }

        let dateRange = '';
        if (stats.firstDate && stats.lastDate) {
            dateRange =
                stats.firstDate === stats.lastDate
                    ? ` on ${stats.firstDate}`
                    : ` between ${stats.firstDate} and ${stats.lastDate}`;
        }

        description += `This failure ${occurrenceText}${runInfo}${dateRange}.\n`;
    }

    return description;
}
