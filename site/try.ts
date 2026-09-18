/**
 * `try.html`, migrated onto `lib/`.
 *
 * The third and last of the three page migrations, following the split the
 * first two settled:
 *
 * | file | contains | tested by |
 * | --- | --- | --- |
 * | `lib/` | data and derivations: config stats, test stats, the bucket hash, chunk stripping, status classification | node tests, shared with the CLI |
 * | `site/try-view.ts` | the view model — every decision, and everything naming an id, a class or a glyph | `test/try-view.test.ts`, no DOM |
 * | `site/try-flakiness-worker.ts` | the worker, as its own esbuild entry point | the browser run |
 * | this file | turning those decisions into elements, and the interactions | the browser parity run |
 *
 * ## What the migration removes
 *
 * `common-test-data.js` — the *data* logic, of which `lib/` already had a typed,
 * tested version. The page no longer loads it, and the tag is gone rather than
 * left dead (leaving one was a defect in the previous migration). All six
 * functions this page reached into it for have `lib/` replacements:
 * `getChunkIndex` → `bucketIndexForPath`, `findTest` → `DecodedTimingFile.findTest`,
 * `computeTestStats`, `computeConfigStats`, `stripChunkSuffix`, `detectHarness`.
 * `getCountAtIndex` has no direct replacement because it does not need one:
 * `lib/formats/decode.ts` yields decoded entries, so nothing indexes a status
 * group by hand any more.
 *
 * **Verified before removal**: no consumer remains. `common-test-data.js`'s
 * seven globals are referenced nowhere in this page's source, nowhere in the
 * five shared scripts that still load, and nowhere through a `window.*` lookup;
 * the grep is in the page's own HTML comment. Removing the tag drops 15,636
 * bytes the page downloaded and never called.
 *
 * The other five shared scripts **stay, loaded by name**. `fetch-utils.js`,
 * `dashboards.js`, `common-ui.js`, `common-links.js` and `shared.js` are UI
 * plumbing with no `lib/` equivalent, up to 22 unmigrated pages depend on them,
 * and `tools/build-pages.ts` copies them next to the built page.
 *
 * ## The two workers
 *
 * This page runs two, and they were migrated differently for a reason worth
 * stating because it is the only asymmetry here:
 *
 * - **The profile worker** (`WORKER_CODE`, below) is unchanged, still a template
 *   literal. Measured: the old page's copy has **zero `${}` interpolations** and
 *   references nothing outside itself, so it is already a complete program and
 *   bundling cannot touch it. Rewriting it as an entry point would have been
 *   churn with a real risk of changing marker semantics.
 * - **The flakiness worker** could not survive bundling at all, because the old
 *   page built it by `.toString()`-ing six `common-test-data.js` functions. It
 *   is now `site/try-flakiness-worker.ts`, its own esbuild entry point; see that
 *   file's comment for the failure mode, and `tools/build-pages.ts` for how the
 *   bundled text reaches the page.
 *
 * ## Declared divergences from `try.html`
 *
 * `PARITY.md` §4: byte-identical is the default and every exception is declared.
 * **This list is the whole set.** The previous migration wrote four entries plus
 * a paragraph of prose and the largest divergence lived only in the prose, so
 * anything that makes a parsed-DOM diff non-empty is a numbered entry here.
 *
 *  1. **Inline handler attributes become `addEventListener`.** The largest DOM
 *     difference by far. Upstream emits `onclick="toggleTest('…')"`,
 *     `onclick="sortTable('count')"`, `onclick="event.stopPropagation()"`,
 *     `onclick="copyMachCmd('…', event)"`, `onclick="toggleUnblamedGroup(3)"`,
 *     `onclick="return onProfilerClick(event, '…', …)"`,
 *     `onclick="toggleAssertions(this, '…')"` and the four control-bar handlers
 *     as **attributes**; this page attaches the same handlers with
 *     `addEventListener` and emits none of them. Behaviour-preserving, but not
 *     invisible: an inline handler needs a *global* function, which is what tied
 *     the old page's rendering to module scope, and removing them is what lets
 *     this file be a module.
 *
 *     The measured counts are in this file's browser evidence; every `on*`
 *     attribute the old page writes is one this page does not.
 *
 *  2. **The `#` column's `escapeAttr(test.path)` id becomes a `Map` lookup.**
 *     Upstream writes `id="flakiness-${escapeAttr(test.path)}"` and
 *     `id="repro-icon-${escapeAttr(test.path)}"` and finds the cell again with
 *     `document.getElementById('flakiness-' + testPath)` — **unescaped**
 *     (`old/try.html:2849`, `:3605`). Those two spellings disagree for any path
 *     containing `&`, `<` or `"`. No such path exists in the corpus (measured: 0
 *     of the 138 failing paths across the four pinned pushes), so the mismatch is
 *     latent rather than live. Here the renderer keeps the elements in a `Map`
 *     keyed by the raw path and the ids are gone, which removes the class of bug
 *     rather than reproducing it. **A DOM diff sees this as two absent `id`
 *     attributes per row.**
 *
 *  3. **`copyMachCmd` / `copyDebugJson` / `onProfilerClick` read a real event.**
 *     Upstream passes `event` through an inline attribute and reads
 *     `event.currentTarget`. Here the listener has the element. Same behaviour,
 *     no reliance on the attribute-scope `event` binding.
 *
 *  4. **The assertion "show N more" link toggles a class, not `style.display`.**
 *     Upstream writes `style="display:none"` on each hidden `<li>` and flips
 *     `el.style.display` (`old/try.html:3090`). The markup already carries an
 *     `assertion-hidden` class for exactly these items, so this page toggles
 *     `hidden` on them instead of writing inline styles. A DOM diff sees the
 *     absent `style` attribute; the rendered result is identical because
 *     `assertion-hidden` is not styled in `shared.css` — verified by grep — so
 *     upstream's inline `display:none` was doing all the work and the class was
 *     already inert.
 *
 *  5. **`renderUnblamedJobs` is keyed by group key, not by render index.**
 *     Upstream emits `onclick="toggleUnblamedGroup(${groupIdx})"` and resolves
 *     the index against `unblamedRenderedKeys`, a module-scope array written by
 *     the last render (`old/try.html:1981`, `:2108`). That is a stale-index hazard —
 *     the array is rewritten on every search keystroke while the click is
 *     pending — and here the listener closes over the key itself. Same rows
 *     expand; the indirection is gone.
 *
 *  6. **The `no-failures` empty state is built from parts.** Upstream's
 *     `noFailuresHtml()` returns a string with the Treeherder link interpolated
 *     into it; here `noFailuresText()` returns the verdict, the caveat and
 *     whether the caveat carries a link, and the renderer builds the anchor. The
 *     rendered text is identical — the tests assert it — but the view model can
 *     be checked without a DOM.
 *
 *  7. **The local reproduction subsystem is not migrated, and its controls are
 *     emitted disabled.** The largest *behavioural* omission, and the only one
 *     on this list that removes a capability rather than re-expressing one.
 *
 *     Upstream drives a local test runner over `ws://localhost:3000`
 *     (`old/try.html:3206`) to re-run failing tests and report whether each
 *     reproduces: roughly 20 functions and 550 lines, spanning `reproState`, the
 *     per-config run queues, the cached-history fetch, the per-row repro icons
 *     and detail rows, and the `Reset` button. None of it is here.
 *
 *     What this page emits instead: `#extra-args`, `#reproduce-btn` and
 *     `#repro-reset-btn`, in the same places, gated on `isLocal` exactly as
 *     upstream gates them, all three `disabled` with the title `Local
 *     reproduction is not available in this build`. Upstream would have enabled
 *     the button (failures exist, nothing is running — `updateReproduceButton()`
 *     third branch, `old/try.html:3186`) and given it the title `Connect to local
 *     test-runner and attempt to reproduce failures`.
 *
 *     **Why disabled rather than absent.** An earlier revision of this file
 *     emitted the button *enabled* with no handler, with a comment claiming it
 *     was "emitted disabled" — the code two lines down set `disabled` from
 *     `failures.tests.length`, which is always non-zero where this runs.
 *     Measured in Chrome: old `{visible:true,disabled:false,hasOnclick:true}`,
 *     new `{visible:true,disabled:false,hasOnclick:false}`; clicking it changed
 *     nothing. The parity diff could not catch that, because **a DOM diff cannot
 *     tell a working button from an inert one** — satisfying it by restoring
 *     markup turned a known gap into a hidden one. Disabling is what makes the
 *     omission visible in the artefact the diff actually compares.
 *
 *     These controls only render when the page is served from localhost, so a
 *     deployed page shows none of them and is unaffected.
 *
 *     Two knock-on effects, both stated where they happen: the last column's
 *     width term `(hasRepro || isLocal)` reduces to `isLocal` (`renderTable`),
 *     and the search box does not scope reproduction runs the way upstream's
 *     `sendAllRunRequests` does (`old/try.html:3367` iterates `getFilteredTests()`)
 *     because there are no runs to scope.
 *
 *  8. **`normalizeMessage` folds CRLF for both call sites, not one.** The only
 *     entry on this list that changes an output *value* rather than the DOM
 *     around it, and the only one where upstream is not reproduced because
 *     upstream is wrong.
 *
 *     Upstream applies `.replace(/\r\n/g, '\n')` inline at the `Test` marker
 *     (`old/try.html:973`) and not at the `TestStatus` marker (`:948`) — and
 *     `TestStatus` is the one that overrides the message for FAIL, TIMEOUT and
 *     ERROR, so the compensated path is the rare one. The `Rejection date`
 *     pattern is anchored on `\n`, so on CRLF input a `\r` survives:
 *     `'…\r\nRejection date: X\r\nb'` normalizes to `'…\r\nb'` where the LF
 *     spelling of the same message gives `'…\nb'`. One failure, two groups,
 *     rendered identically because the difference is a control character — and
 *     the same split defeats the same-message comparison against central.
 *
 *     The pass now happens inside `normalizeMessage`, once, which is where
 *     `cli/commands/try.ts` always had it. `lib/model/failure-message.ts` owns
 *     the rule and the measurement; the worker keeps a copy because a Blob
 *     worker cannot import, and `test/try-parity.test.ts` pins the copy against
 *     the shared function so they cannot drift.
 *
 *  9. **The `<manifest>:` prefix is stripped for all three marker kinds, not
 *     one.** The second entry that changes an output value. Upstream stripped it
 *     inside the `Test` branch (`old/try.html:990`) and nowhere else, so the
 *     `Text` branch and the synthetic-crash loop emitted the raw id — and a path
 *     carrying its prefix matches nothing on central, which showed two known
 *     intermittents as introduced by the push. `lib/model/test-path.ts` owns the
 *     rule; the worker keeps a pinned copy, as it does for `normalizeMessage`.
 *
 * 10. **Each failure section's heading carries its row count as ` — N`.**
 *     Upstream's headings are the bare words (`old/try.html:1774`, `:1779`). The
 *     number is `permanent.length` / `intermittent.length`, which is what
 *     `renderTestTable` draws one summary row per — so it is the count under the
 *     current search rather than the push's total, and it moves as the reader
 *     types. Requested by the owner. A suffix rather than an inflected count,
 *     which is why neither heading needs a plural rule; see `countSuffix`.
 *
 * 11. **A test path is a `test.html` link with a 📋 copy button, not a Searchfox
 *     link with a `history` link after it.** The shared treatment in
 *     `site/test-link.ts`, which `issues.html` renders too.
 *
 *     Requested by the owner, and the copy button is the reason: *"copying the
 *     name of a failed test from try.html is currently difficult because
 *     clicking it opens the subview and clears the selection"*. A drag across
 *     the path is a click on the row, the row expands, the re-render replaces
 *     the element the selection was anchored in.
 *
 *     Three destinations before, three after, redistributed: the path now goes
 *     to `test.html` (where the `history` link went), Searchfox moves onto a 🔍
 *     button after it (where `issues.html` already has it), and the copy button
 *     is new, between the two. Nothing this row could reach is unreachable. The
 *     `history-link` rule in `site/try.html` went with the link; the
 *     `action-button` rules came in, copied from `issues.html` — including
 *     their metrics, after a leading copy button that needed a reserved gutter
 *     and a negative margin to keep the column aligned was tried and reverted.
 *
 * Everything else — the row unit, the three tables and their split rule, the
 * sort keys and their directions, the `UNEXPECTED-PASS` failure status, the
 * `totalJobs` denominator, the headline-rate argmax, the search box's `!`
 * negation, the URL state, and the `window.failures`/`permaFails` seams — is
 * reproduced, and the reasoning for each lives next to the code that does it in
 * `site/try-view.ts`.
 */

import { bucketFileSuffix, bucketIndexForPath } from '../lib/formats/buckets.ts';
import { detectHarness, otherHarness } from '../lib/model/harness.ts';
import { stripChunkSuffix } from '../lib/model/job-name.ts';
import { el, searchBox } from './drilldown-render.ts';
import { testPageUrl, testRowLink } from './test-link.ts';
import {
    type ConsoleFailure,
    type FailingTest,
    type Failures,
    type FlakinessData,
    type FlakinessRequest,
    type Job,
    type SearchTerm,
    type SortColumn,
    type SortState,
    type Timing,
    type UnblamedGroup,
    type UploadedProfile,
    aggregateFailures,
    baseStatus,
    cleanFailureSummary,
    consoleFailures,
    countClass,
    coversAll,
    extractBuildTypes,
    extractPlatform,
    extractRevision,
    extractUploadedProfileName,
    findUploadedProfile,
    filterTests,
    flakinessCell,
    flakinessRequests,
    formatForPrompt,
    groupRequestsByChunk,
    groupUnblamedJobs,
    hgRepoPath,
    initialSort,
    instanceMessages,
    instanceUploadedProfile,
    isFailureStatus,
    needsPermanentHeader,
    nextSort,
    noFailuresText,
    parseSearch,
    phabricatorRevision,
    pickHeadlineRate,
    planRevisionList,
    pushLogUrl,
    readUrlState,
    runCountTooltip,
    runKeyOf,
    selectTryJobs,
    sortConsoleFailures,
    sortTests,
    sortedBuildTypes,
    sortedPlatforms,
    splitTables,
    summaryCards,
    tagIntermittent,
    visibleUnblamedGroups,
    writeUrlState,
} from './try-view.ts';
import type { FlakinessResult, WorkerResponse } from './try-flakiness-worker.ts';

// --- the shared scripts, as they are --------------------------------------
//
// Declared rather than imported: these are `<script src=…>` globals from files
// up to 22 unmigrated pages depend on, which the build copies next to this
// page. Typing them here is what lets the rest of this file be checked.

declare global {
    /** `common-ui.js:44` — wires a search box, its clear button and a debounce. */
    function initSearchBox(options: {
        searchBoxId: string;
        searchClearId: string;
        onSearch: () => void;
        updateUrlHash: () => void;
        debounceMs?: number;
    }): unknown;
    /** `common-links.js:15` — the Firefox Profiler URL for a profile. */
    function getProfilerUrl(
        instance: {
            taskId?: string;
            retryId?: number;
            jobName?: string;
            profile?: string;
            profileName?: string;
        },
        testName?: string | null
    ): string;
    /** `common-links.js:31` — the crash viewer URL, or `''` with no minidump. */
    function getCrashViewerUrl(crashInstance: {
        taskId: string;
        retryId: number;
        minidump?: string | undefined;
    }): string;
    /** `shared.js:70` — the coarse OS of a job name. */
    function extractPlatform(name: string): string;
    /** `shared.js:3` — recolours the favicon. */
    function setFavicon(color: string): void;
    // `withDevParams` is no longer named here: the only call this page makes is
    // inside `site/test-link.ts`, which declares it there.
    /**
     * `fetch-utils.js` — fetches a data file, honouring `?data-source=`.
     *
     * `date` is an optional `YYYY-MM-DD` pushdate naming an *older* published
     * run to read instead of the latest one. Omit it for the current data.
     */
    function fetchData(filename: string, date?: string): Promise<Response>;
    /**
     * The worker sources the build inlined. See `tools/build-pages.ts`; the
     * page reads this rather than importing the worker, so that the built page
     * stays one file with no extra request.
     */
    // eslint-disable-next-line no-var
    var __workers: Record<string, string> | undefined;
}

// --- constants ------------------------------------------------------------

const TH_BASE = 'https://treeherder.mozilla.org';

/** Whether the local reproduction features are available. `old/try.html:736`. */
const isLocal =
    window.location.protocol === 'file:' || window.location.hostname === 'localhost';

/** The mitten glyph's element. `old/try.html:1483` writes it as markup. */
function mitten(): HTMLElement {
    return el('span', { class: 'mitten' });
}

/**
 * A section heading's row count, as ` — N`.
 *
 * A suffix rather than a parenthesised or inflected count, so neither heading
 * needs a plural rule on the word in front of it: "Permanent failures — 1"
 * reads correctly where "1 permanent failures" would not.
 *
 * The number is the length of the list the table beside it is built from, which
 * is post-search: `renderTable` filters before `splitTables`, and
 * `renderTestTable` draws one summary row per element of what it is handed. So
 * typing in the search box moves both headings' numbers.
 */
function countSuffix(count: number): string {
    return ` — ${count}`;
}

// --- small DOM helpers ----------------------------------------------------

/** An `<a target="_blank">` whose click does not also toggle the row. */
function link(
    href: string,
    options: {
        text?: string | undefined;
        class?: string | undefined;
        title?: string | undefined;
        children?: (Node | string)[] | undefined;
    } = {}
): HTMLAnchorElement {
    const anchor = el('a', {
        href,
        class: options.class,
        text: options.text,
        title: options.title,
        children: options.children,
    });
    anchor.target = '_blank';
    // Upstream writes `onclick="event.stopPropagation()"` on every link inside
    // a clickable row (`old/try.html:1884`), so following a link does not also
    // expand the row. Same effect, as a listener.
    anchor.addEventListener('click', (event) => {
        event.stopPropagation();
    });
    return anchor;
}

/** An element the page's own markup guarantees exists. */
function requireElement(id: string): HTMLElement {
    const node = document.getElementById(id);
    if (node === null) {
        throw new Error(`${id} is missing from the page`);
    }
    return node;
}

/** The typed input elements the markup guarantees. */
function requireInput(id: string): HTMLInputElement {
    return requireElement(id) as HTMLInputElement;
}

// --- the profile worker ---------------------------------------------------
//
// Unchanged from `old/try.html:862`. See the module comment: it has zero `${}`
// interpolations and references nothing outside itself, so bundling cannot
// touch it and rewriting it would risk changing marker semantics for no gain.
//
// It receives an ArrayBuffer by transfer, decodes and parses the JSON, extracts
// the test timings and posts them back. No network access needed.

const WORKER_CODE = String.raw`
'use strict';

// The CRLF pass is the one line of this worker that is NOT upstream's, and it
// is a declared divergence (see the module comment's numbered list). Upstream
// normalized line endings at one of the two call sites -- the Test marker,
// old/try.html:973 -- and not at the TestStatus marker at :948, which overrides
// it for FAIL, TIMEOUT and ERROR and is therefore the common path. Left as
// upstream had it, the same failure on Windows and on Linux is two message
// groups that render identically, because the only difference is a carriage
// return. lib/model/failure-message.ts owns the rule and records the
// measurement; this copy exists because a Web Worker built from a Blob cannot
// import, and test/try-parity.test.ts pins the two against each other.
function normalizeMessage(message) {
    return message
        ?.replace(/\r\n/g, '\n')
        .replace(/task_\d+/g, 'task_id')
        .replace(/\nRejection date: [^\n]+/g, '')
        .replace(/Test ran for \d+s/g, 'Test ran for Xs');
}

// The path derivation, one rule for all three marker kinds; upstream had it in
// the Test branch only (old/try.html:990). Anchored on the .toml/.ini extension
// rather than the first colon because this now runs over the free-form Text
// marker too, where an unanchored rule would corrupt a URL or a Windows path
// into something that still looks like a test path. lib/model/test-path.ts owns
// the rule; this copy exists because a Blob worker cannot import, and
// test/try-parity.test.ts pins the two against each other.
function stripManifestPrefix(id) {
    return id.replace(/^[^:]+\.(?:toml|ini):/, '').replace(/\s+\(finished\)$/, '').trim();
}

function isTestFilePath(path) {
    return /\.(js|html|xhtml)$/.test(path);
}

function normalizeTestPath(id) {
    if (id === null || id === undefined || id === '') return null;
    const path = stripManifestPrefix(id);
    return isTestFilePath(path) ? path : null;
}

function extractTextRanges(markers, text) {
    const ranges = [];
    for (let i = 0; i < markers.length; i++) {
        const data = markers.data[i];
        if (data?.type === 'Text' && data.text === text) {
            ranges.push({ start: markers.startTime[i], end: markers.endTime[i] });
        }
    }
    return ranges;
}

function isInRange(testStart, testEnd, ranges) {
    for (const r of ranges) {
        if (testStart < r.end && testEnd > r.start) return true;
    }
    return false;
}

function resolveStack(stackIndex, thread) {
    const { stackTable, frameTable, funcTable, stringArray } = thread;
    if (!stackTable || !frameTable || !funcTable || stackIndex == null) return null;
    const frames = [];
    let idx = stackIndex;
    while (idx != null && idx >= 0) {
        const frameIdx = stackTable.frame[idx];
        const funcIdx = frameTable.func[frameIdx];
        const name = stringArray[funcTable.name[funcIdx]] || '?';
        const file = funcTable.fileName != null ? stringArray[funcTable.fileName[funcIdx]] : null;
        const line = frameTable.line ? frameTable.line[frameIdx] : null;
        let frame = name;
        if (file) {
            frame += ' @ ' + file;
            if (line != null && line >= 0) frame += ':' + line;
        }
        frames.push(frame);
        idx = stackTable.prefix[idx];
    }
    return frames.length ? frames.join('\n') : null;
}

function extractTestTimings(profile) {
    if (!profile?.threads?.[0]) return [];
    const thread = profile.threads[0];
    const { markers, stringArray } = thread;
    if (!markers?.data || !markers?.name || !stringArray) return [];

    const parallelRanges = extractTextRanges(markers, 'parallel');
    // The harness wraps reruns of initially-failing tests in a "retry" marker.
    const retryRanges = extractTextRanges(markers, 'retry');

    const crashMarkers = [];
    for (let i = 0; i < markers.length; i++) {
        const data = markers.data[i];
        if (data?.type === 'Crash' && data.test) {
            crashMarkers.push({
                testPath: data.test,
                startTime: markers.startTime[i],
                signature: data.signature || null,
                minidump: data.minidump || null,
            });
        }
    }

    const failStringId = stringArray.indexOf('FAIL');
    const errorStringId = stringArray.indexOf('ERROR');
    const testStatusMarkers = [];
    for (let i = 0; i < markers.length; i++) {
        const nameId = markers.name[i];
        if (nameId !== failStringId && nameId !== errorStringId) continue;
        const data = markers.data[i];
        if (!data || data.type !== 'TestStatus' || !data.test) continue;
        const stack = markers.stack ? resolveStack(markers.stack[i], thread) : null;
        testStatusMarkers.push({
            test: data.test,
            nameId,
            time: markers.startTime[i],
            message: normalizeMessage(data.message),
            statusName: stringArray[nameId],
            stack,
        });
    }
    testStatusMarkers.sort((a, b) => a.test.localeCompare(b.test) || a.time - b.time);

    const testStringId = stringArray.indexOf('test');
    const timings = [];

    for (let i = 0; i < markers.length; i++) {
        if (markers.name[i] !== testStringId) continue;
        const data = markers.data[i];
        if (!data) continue;

        let testPath = null;
        let fullTestId = null;
        let status = 'UNKNOWN';
        let message = null;
        let allMessages = [];

        if (data.type === 'Test') {
            fullTestId = data.test || data.name;
            testPath = fullTestId;
            status = data.status || 'UNKNOWN';
            // The inline CRLF replace upstream had here (old/try.html:973) is
            // gone: normalizeMessage does it for both call sites now, which is
            // the point of moving it there.
            message = normalizeMessage(data.message);

            if (status === 'FAIL' && data.color === 'green') {
                status = 'EXPECTED-FAIL';
            } else if (status === 'PASS' && data.expected && data.expected !== 'PASS') {
                status = 'UNEXPECTED-PASS';
            } else if (['TIMEOUT', 'FAIL', 'CRASH', 'PASS'].includes(status) && parallelRanges.length) {
                status += isInRange(markers.startTime[i], markers.endTime[i], parallelRanges)
                    ? '-PARALLEL' : '-SEQUENTIAL';
            }

            if (status.startsWith('FAIL') || status.startsWith('TIMEOUT') || status === 'ERROR') {
                const testStartTime = markers.startTime[i];
                const testEndTime = markers.endTime[i];
                for (const m of testStatusMarkers) {
                    if (m.test === fullTestId && m.time >= testStartTime && m.time <= testEndTime) {
                        if (m.message) {
                            const entry = { message: m.message, status: m.statusName };
                            if (m.stack) entry.stack = m.stack;
                            allMessages.push(entry);
                        }
                    }
                }
                if (allMessages.length > 0) {
                    message = allMessages[0].message;
                }
            }

        } else if (data.type === 'Text') {
            testPath = data.text;
            if (testPath?.startsWith('replaying full log for ')) continue;
            status = 'UNKNOWN';
        } else {
            continue;
        }

        // One derivation for both branches; upstream stripped in the Test branch
        // alone and then applied the .js filter to both.
        testPath = normalizeTestPath(testPath);
        if (testPath === null) continue;

        const timing = {
            path: testPath,
            duration: markers.endTime[i] - markers.startTime[i],
            status,
            timestamp: profile.meta.startTime + markers.startTime[i],
            allMessages,
        };
        if (retryRanges.length && isInRange(markers.startTime[i], markers.endTime[i], retryRanges)) {
            timing.isRetry = true;
        }
        if (message) timing.message = message;

        if (status.startsWith('CRASH')) {
            const matchingCrash = crashMarkers.find(
                c => c.testPath === fullTestId &&
                     c.startTime >= markers.startTime[i] &&
                     c.startTime <= markers.endTime[i]
            );
            if (matchingCrash) {
                matchingCrash.consumed = true;
                if (matchingCrash.signature) timing.crashSignature = matchingCrash.signature;
                if (matchingCrash.minidump) timing.minidump = matchingCrash.minidump;
            }
        }

        timings.push(timing);
    }

    // Surface crashes that weren't attributed to a running test (e.g. crashes
    // during manifest teardown/shutdown, recorded against a .toml/.ini path).
    // Without this they'd be invisible whenever the job also has another test
    // failure, since the log-based fallback only runs for jobs with no blamed
    // failure at all. Emit one synthetic CRASH timing per such crash.
    // Stripped, but the .js filter is NOT applied: a crash recorded against a
    // .toml manifest is what this loop exists to surface, so it keeps that row
    // where cli/commands/try.ts drops it.
    for (const c of crashMarkers) {
        if (c.consumed || !c.testPath) continue;
        const timing = {
            path: stripManifestPrefix(c.testPath),
            duration: 0,
            status: 'CRASH',
            timestamp: profile.meta.startTime + c.startTime,
            allMessages: [],
        };
        if (c.signature) {
            timing.crashSignature = c.signature;
            timing.message = c.signature;
        }
        if (c.minidump) timing.minidump = c.minidump;
        timings.push(timing);
    }
    return timings;
}

self.onmessage = function(e) {
    const { id, buffer, jobName, taskId, retryId } = e.data;
    try {
        const json = new TextDecoder().decode(buffer);
        const profile = JSON.parse(json);
        const timings = extractTestTimings(profile);
        for (const t of timings) {
            t.jobName = jobName;
            t.taskId = taskId;
            t.retryId = retryId;
        }
        self.postMessage({ id, timings });
    } catch (err) {
        self.postMessage({ id, timings: [], error: err.message });
    }
};
`;

const workerUrl = URL.createObjectURL(
    new Blob([WORKER_CODE], { type: 'application/javascript' })
);

/** Cap at 8 to avoid lock contention on the memory allocator. `old/try.html:1088`. */
const NUM_WORKERS = Math.min(navigator.hardwareConcurrency || 4, 8);
const MAX_CONCURRENT_FETCHES = 64;

/**
 * Fetches every job's profile and parses them in a worker pool.
 * `old/try.html:1094`.
 *
 * The main thread fetches with high concurrency and transfers the `ArrayBuffer`
 * to a worker for the CPU-bound parse, which is what keeps the page responsive
 * while 300 profiles of 30-50 MB each go through `JSON.parse`.
 *
 * A profile that 404s, or that fails to parse, is counted as completed and
 * contributes nothing. **This is what keeps a streamed profile from breaking
 * the page**: a job killed for exceeding its maximum duration uploads
 * newline-delimited JSON rather than one document, `JSON.parse` throws at the
 * first newline, the worker's `catch` posts back an empty timing list and the
 * page carries on. Measured on push 717fc67feaa071: **66 of its 160 profiles
 * are that shape**, 36-50 MB each, and the page renders the other 94 without
 * noticing. Reading that format is explicitly out of scope; not breaking on it
 * is not.
 */
function processJobsWithWorkers(
    failedTestJobs: readonly Job[],
    onProgress: (done: number, total: number) => void
): Promise<{ timings: Timing[]; workers: Worker[] }> {
    return new Promise((resolve) => {
        const allTimings: Timing[] = [];
        const total = failedTestJobs.length;
        let completed = 0;
        let nextId = 0;

        const workers: Worker[] = [];
        for (let i = 0; i < NUM_WORKERS; i++) {
            workers.push(new Worker(workerUrl));
        }
        const idleWorkers = [...workers];
        interface PendingBuffer {
            id: number;
            buffer: ArrayBuffer;
            jobName: string;
            taskId: string;
            retryId: number;
        }
        const pendingBuffers: PendingBuffer[] = [];

        const sendToWorker = (worker: Worker, item: PendingBuffer): void => {
            worker.postMessage(item, [item.buffer]);
        };

        const onWorkerMessage = (worker: Worker, event: MessageEvent): void => {
            const { timings } = event.data as { timings?: Timing[] };
            if (timings !== undefined && timings.length > 0) {
                allTimings.push(...timings);
            }
            completed++;
            onProgress(completed, total);

            const next = pendingBuffers.shift();
            if (next !== undefined) {
                sendToWorker(worker, next);
            } else {
                idleWorkers.push(worker);
                if (completed >= total) {
                    resolve({ timings: allTimings, workers });
                }
            }
        };

        for (const worker of workers) {
            worker.onmessage = (event): void => {
                onWorkerMessage(worker, event);
            };
        }

        const enqueueBuffer = (item: PendingBuffer): void => {
            const idle = idleWorkers.pop();
            if (idle !== undefined) {
                sendToWorker(idle, item);
            } else {
                pendingBuffers.push(item);
            }
        };

        const queue = [...failedTestJobs];
        let inFlight = 0;

        const fetchNext = (): void => {
            while (inFlight < MAX_CONCURRENT_FETCHES && queue.length > 0) {
                const job = queue.shift()!;
                const id = nextId++;
                inFlight++;
                const url =
                    'https://firefoxci.taskcluster-artifacts.net/' +
                    `${job.taskId}/${job.retryId}/public/test_info/profile_resource-usage.json`;
                fetch(url)
                    .then((response) => (response.ok ? response.arrayBuffer() : null))
                    .then((buffer) => {
                        if (buffer !== null) {
                            enqueueBuffer({
                                id,
                                buffer,
                                jobName: job.jobName,
                                taskId: job.taskId,
                                retryId: job.retryId,
                            });
                        } else {
                            // No profile available; count as completed.
                            completed++;
                            onProgress(completed, total);
                        }
                    })
                    .catch(() => {
                        completed++;
                        onProgress(completed, total);
                    })
                    .finally(() => {
                        inFlight--;
                        fetchNext();
                        // Everything fetched, nothing pending, all workers idle.
                        if (completed >= total && idleWorkers.length === workers.length) {
                            resolve({ timings: allTimings, workers });
                        }
                    });
            }
        };

        if (total === 0) {
            for (const worker of workers) {
                worker.terminate();
            }
            resolve({ timings: [], workers: [] });
            return;
        }
        fetchNext();
    });
}

// --- Treeherder -----------------------------------------------------------

/** `old/try.html:759`. */
async function fetchPushId(
    repo: string,
    revision: string
): Promise<{ pushId: number; revisions: PushRevision[]; revisionCount: number }> {
    const url = `${TH_BASE}/api/project/${repo}/push/?full=true&count=10&revision=${revision}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to look up revision on Treeherder (HTTP ${response.status})`);
    }
    const data = (await response.json()) as {
        results?: { id: number; revisions?: PushRevision[]; revision_count?: number }[];
    };
    const push = data.results?.[0];
    if (push === undefined) {
        throw new Error(`No push found for revision ${revision} on ${repo}`);
    }
    const revisions = push.revisions ?? [];
    return {
        pushId: push.id,
        revisions,
        // Absent on an older Treeherder than the one this was written against;
        // falling back to what arrived reports no unreachable commits, which
        // is the safe direction — a missing "+N on the pushlog" link is a
        // smaller wrong than one claiming commits that do not exist.
        revisionCount: push.revision_count ?? revisions.length,
    };
}

/** One commit of a push. */
interface PushRevision {
    revision: string;
    author: string;
    comments: string;
}

/** `old/try.html:771`. Follows `next` until the job list is exhausted. */
async function fetchAllJobs(
    pushId: number
): Promise<{ allJobs: unknown[][]; propertyNames: string[] }> {
    let allJobs: unknown[][] = [];
    let propertyNames: string[] = [];
    let url: string | null = `${TH_BASE}/api/jobs/?push_id=${pushId}`;

    while (url !== null) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch jobs (HTTP ${response.status})`);
        }
        const data = (await response.json()) as {
            results?: unknown[][];
            job_property_names?: string[];
            next?: string | null;
        };
        allJobs = allJobs.concat(data.results ?? []);
        if (propertyNames.length === 0) {
            propertyNames = data.job_property_names ?? [];
        }
        url = data.next ?? null;
    }
    return { allJobs, propertyNames };
}

/**
 * Resolves the positional job arrays against `job_property_names`.
 * `old/try.html:790`.
 *
 * A job with no name or no task ID is dropped, which is upstream's behaviour
 * and is how a Treeherder field rename would present: as "the push has no
 * jobs". `lib/sources/treeherder.ts` throws instead, but this page's copy is
 * kept because changing it is a behaviour change and not one this migration
 * makes.
 */
function parseJobs(allJobs: readonly unknown[][], propertyNames: readonly string[]): Job[] {
    const idx = (name: string): number => propertyNames.indexOf(name);
    const jobIdIdx = idx('id');
    const jobTypeNameIdx = idx('job_type_name');
    const taskIdIdx = idx('task_id');
    const retryIdIdx = idx('retry_id');
    const stateIdx = idx('state');
    const resultIdx = idx('result');

    const jobs: Job[] = [];
    for (const job of allJobs) {
        const jobName = job[jobTypeNameIdx] as string | undefined;
        const taskId = job[taskIdIdx] as string | undefined;
        if (!jobName || !taskId) {
            continue;
        }
        jobs.push({
            jobId: job[jobIdIdx] as number,
            jobName,
            taskId,
            retryId: (job[retryIdIdx] as number | undefined) || 0,
            state: job[stateIdx] as string,
            result: job[resultIdx] as string,
        });
    }
    return jobs;
}

// --- page state -----------------------------------------------------------

/** Everything the interactions need. The old page's module-scope `let`s. */
interface PageState {
    failures: Failures | null;
    unblamedJobs: Job[];
    unblamedGroups: Map<string, UnblamedGroup> | null;
    sort: SortState;
    search: SearchTerm;
    expandedTests: Set<string>;
    expandedUnblamed: Set<string>;
    revision: string | null;
    repo: string;
    /** jobName -> completed runs, for the debug JSON. */
    jobRunCounts: Map<string, number> | null;
    /** Failed jobs of harnesses this page cannot parse. */
    otherFailedJobs: Job[];
    treeherderUrl: string;
    /** testPath -> its 21-day history, once the worker has answered. */
    flakiness: Map<string, FlakinessData>;
    /**
     * The flakiness cells, keyed by raw test path.
     *
     * Divergence 2: the old page finds these by `getElementById` on an id it
     * built with `escapeAttr` and looks up without it, which disagree for a path
     * containing `&`, `<` or `"`. Holding the elements removes the class of bug.
     */
    flakinessCells: Map<string, HTMLElement>;
    flakinessWorker: Worker | null;
}

const state: PageState = {
    failures: null,
    unblamedJobs: [],
    unblamedGroups: null,
    sort: initialSort(),
    search: { term: '', negate: false },
    expandedTests: new Set(),
    expandedUnblamed: new Set(),
    revision: null,
    repo: 'try',
    jobRunCounts: null,
    otherFailedJobs: [],
    treeherderUrl: '',
    flakiness: new Map(),
    flakinessCells: new Map(),
    flakinessWorker: null,
};

// --- status and progress --------------------------------------------------

function setStatus(text: string, isError = false): void {
    const node = requireElement('status');
    node.textContent = text;
    node.className = isError ? 'error-text' : '';
}

function setProgress(fraction: number): void {
    const bar = requireElement('progress-bar');
    const fill = requireElement('progress-fill');
    if (fraction < 0) {
        bar.classList.remove('visible');
    } else {
        bar.classList.add('visible');
        fill.style.width = `${Math.round(fraction * 100)}%`;
    }
}

// --- URL state ------------------------------------------------------------

/** `old/try.html:1249`. Writes the current view into the URL, without a hash. */
function updateUrlState(): void {
    const url = new URL(window.location.href);
    writeUrlState(url, {
        rev: state.revision,
        repo: state.repo,
        filter: requireInput('search-box').value,
        allJobs: requireInput('alljobs-checkbox').checked,
    });
    window.history.replaceState(null, '', url);
}

// --- loading --------------------------------------------------------------

/** `old/try.html:1286`. The whole load, from a revision string to a rendered page. */
async function loadRevision(): Promise<void> {
    const { revision, repo } = extractRevision(requireInput('revision-input').value);
    if (!revision) {
        setStatus('Please enter a revision.', true);
        return;
    }
    state.revision = revision;
    state.repo = repo;
    updateUrlState();

    const loadButton = requireElement('load-btn') as HTMLButtonElement;
    loadButton.disabled = true;
    requireElement('results').replaceChildren();
    requireElement('treeherder-link-container').replaceChildren();
    requireElement('filter-container').style.display = 'none';
    requireElement('revisions-container').replaceChildren();
    state.expandedTests.clear();
    state.expandedUnblamed.clear();
    state.unblamedGroups = null;
    state.flakiness.clear();
    state.flakinessCells.clear();

    try {
        setStatus('Looking up push on Treeherder...');
        setProgress(-1);
        const { pushId, revisions, revisionCount } = await fetchPushId(repo, revision);
        revisionsExpanded = false;
        renderRevisions(revisions, revisionCount);

        setStatus('Fetching jobs...');
        const { allJobs, propertyNames } = await fetchAllJobs(pushId);
        const jobs = parseJobs(allJobs, propertyNames);

        const totalJobs = jobs.length;

        // The "All jobs" checkbox changes the UNIVERSE, not just the visible
        // rows: it adds the successful test jobs' profiles, so tests that failed
        // initially and passed on retry surface at all. Unchecked by default
        // (`old/try.html:706`, forced at `:3775`). The checkbox is the only part
        // of this the page owns — `selectTryJobs` decides what the answer means,
        // and `fx-tests try --all-jobs` calls it with the same argument.
        const selection = selectTryJobs(jobs, {
            readPassingJobs: requireInput('alljobs-checkbox').checked,
        });
        const { failedTestJobs, jobsToProcess, successfulJobNames } = selection;

        // Failures this page cannot dig into: builds, lint, and test harnesses
        // other than the ones we parse profiles for. Surfaced as a pointer to
        // Treeherder rather than hidden — a green verdict next to a busted
        // build is the one way this page could actively mislead.
        state.otherFailedJobs = selection.otherFailedJobs;
        state.treeherderUrl = `${TH_BASE}/jobs?repo=${repo}&revision=${revision}`;

        const passingTestJobs = selection.readPassingJobs ? selection.successfulTestJobs : [];

        if (jobsToProcess.length === 0) {
            // No table renders at all — green favicon, the `no-failures` block,
            // and an early return. `old/try.html:1346`.
            //
            // `runsPerJobName` counts every completed run of every test job, so
            // its total is the count this line used to `filter` for. The word
            // "successfully" in the message is upstream's and is a shade
            // optimistic either way: a test job that ended `exception` is in
            // this total, and reaching this branch only means no test job
            // ended `testfailed`.
            let completedTestJobs = 0;
            for (const runs of selection.runsPerJobName.values()) {
                completedTestJobs += runs;
            }
            setFavicon('#4caf50');
            setStatus(
                `${completedTestJobs} test jobs completed successfully out of ` +
                    `${totalJobs} total jobs.`
            );
            setProgress(-1);
            const empty = el('div', { class: 'no-failures' });
            appendNoFailures(empty, true);
            requireElement('results').replaceChildren(empty);
            renderTreeherderLink();
            loadButton.disabled = false;
            return;
        }

        const passingNote =
            passingTestJobs.length > 0
                ? ` and ${passingTestJobs.length} passing test jobs`
                : '';
        setStatus(
            `Found ${failedTestJobs.length} failed test jobs${passingNote}. Fetching profiles...`
        );
        setProgress(0);

        const result = await processJobsWithWorkers(jobsToProcess, (done, total) => {
            setStatus(`Fetching & parsing profiles... (${done}/${total})`);
            setProgress(done / total);
        });

        tagIntermittent(result.timings, { jobsToProcess, successfulJobNames });

        // The global platform and build sets come from ALL processed jobs, not
        // from the failing ones: "failed on every platform" has to be measured
        // against the platforms the push actually ran.
        const globalPlatforms = new Set<string>();
        const globalBuildTypes = new Set<string>();
        for (const job of jobsToProcess) {
            globalPlatforms.add(extractPlatform(job.jobName));
            for (const buildType of extractBuildTypes(job.jobName)) {
                globalBuildTypes.add(buildType);
            }
        }

        // Completed runs per job name, across the whole push — the denominator
        // of the intermittent ratio. Counted over the whole push rather than
        // over `jobsToProcess`, so ticking the checkbox cannot move it.
        const jobRunCounts = selection.runsPerJobName;
        state.jobRunCounts = jobRunCounts;

        const failures = aggregateFailures(result.timings, {
            globalPlatforms,
            globalBuildTypes,
            jobRunCounts,
        });
        state.failures = failures;
        setProgress(-1);

        // Failed jobs with no test-level failure attributed to them.
        const jobsWithFailures = new Set(
            result.timings.filter((t) => isFailureStatus(t.status)).map(runKeyOf)
        );
        state.unblamedJobs = failedTestJobs.filter(
            (job) => !jobsWithFailures.has(runKeyOf(job))
        );

        setStatus('');
        renderResults(failures, totalJobs, failedTestJobs.length);
        logConsoleAPI();

        void fetchFlakinessData(failures.tests);

        // Deferred so terminating eight workers does not block the paint.
        setTimeout(() => {
            for (const worker of result.workers) {
                worker.terminate();
            }
        }, 0);
    } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true);
        setProgress(-1);
        console.error(error);
    } finally {
        loadButton.disabled = false;
    }
}

// --- rendering ------------------------------------------------------------

/**
 * Whether the commit list is showing every commit Treeherder returned.
 *
 * Page state rather than URL state: which commits are on screen is not a view
 * of the push worth pasting into a bug, and `writeUrlState` deliberately keeps
 * the query to what is (`site/try-view.ts`'s note on the parameters it drops).
 * Reset on each load, so a 40-commit push does not open expanded because the
 * previous one was.
 */
let revisionsExpanded = false;

/** `old/try.html:1616`. The commit list, the heading and the tab title. */
function renderRevisions(revisions: readonly PushRevision[], totalCount: number): void {
    const container = requireElement('revisions-container');
    if (revisions.length === 0) {
        container.replaceChildren();
        return;
    }

    // Skip the try commit itself (first in the array = tip); keep newest-first,
    // like Treeherder.
    const displayRevs =
        state.repo === 'try' && revisions.length > 1 ? revisions.slice(1) : revisions;

    // The head commit, not `displayRevs[0]`: the pushlog keys on the push, and
    // the try head is exactly the commit that was stripped above.
    const headRevision = revisions[0]?.revision ?? '';
    const draw = (): void => {
        container.replaceChildren(
            revisionList(displayRevs, totalCount, revisions.length, headRevision, draw)
        );
    };
    draw();

    const repoLabel = state.repo.charAt(0).toUpperCase() + state.repo.slice(1);
    const mainRev = displayRevs[0] ?? revisions[0];
    const commitMsg = mainRev?.comments.split('\n')[0];
    requireElement('page-heading').textContent = `${repoLabel} Push Results`;
    document.title = commitMsg ? `${repoLabel}: ${commitMsg}` : `${repoLabel} Push Results`;
}

/**
 * The commit list, with both cutoffs drawn.
 *
 * Takes its own redraw as a parameter rather than calling `renderRevisions`
 * again: expanding must not retitle the tab or re-derive the heading, and a
 * closure over the already-computed lists is also what keeps the expander from
 * needing a second Treeherder request.
 */
function revisionList(
    displayRevs: readonly PushRevision[],
    totalCount: number,
    returnedCount: number,
    headRevision: string,
    redraw: () => void
): HTMLElement {
    const plan = planRevisionList(displayRevs, totalCount, returnedCount, revisionsExpanded);
    const repoPath = hgRepoPath(state.repo);
    const list = el('div', { class: 'revisions-list' });

    for (const rev of plan.shown) {
        const row = el('div');
        row.append(
            link(`https://hg.mozilla.org/${repoPath}/rev/${rev.revision}`, {
                class: 'rev-hash',
                text: rev.revision.slice(0, 12),
            }),
            ' '
        );
        const phabricator = phabricatorRevision(rev.comments);
        if (phabricator) {
            // The icon carries the name in its tooltip rather than beside it:
            // a column of `D327289`s cost more width than the commit message
            // it pushed off the line, and the number is not what a reader
            // scans for. Treeherder's own list makes the same trade
            // (`mozilla/treeherder#9741`), with this glyph.
            row.append(
                link(phabricator.url, {
                    class: 'rev-phab',
                    title: `Open ${phabricator.name} on Phabricator`,
                    children: [el('span', { class: 'phabricator-icon' })],
                }),
                ' '
            );
        }
        const comment = el('span', { class: 'rev-comment' });
        appendLinkifiedBugNumbers(comment, rev.comments.split('\n')[0] ?? '');
        row.append(comment);
        row.append(
            el('span', {
                class: 'rev-author',
                title: rev.author,
                text: ` — ${rev.author.replace(/ <[^>]+>$/, '')}`,
            })
        );
        list.append(row);
    }

    // At most one of these is non-zero; `planRevisionList` is what guarantees
    // it, so this renders both branches without checking the other.
    if (plan.hidden > 0) {
        const more = el('button', {
            class: 'rev-more',
            text: `+ ${plan.hidden} more`,
            attrs: { type: 'button' },
        });
        more.addEventListener('click', () => {
            revisionsExpanded = true;
            redraw();
        });
        list.append(el('div', { children: [more] }));
    }
    if (plan.beyondApi > 0) {
        list.append(
            el('div', {
                children: [
                    link(pushLogUrl(state.repo, headRevision), {
                        class: 'rev-more-link',
                        text: `+ ${plan.beyondApi} more on the pushlog`,
                        title: 'Treeherder returns at most 20 commits per push',
                    }),
                ],
            })
        );
    }
    return list;
}

/** `old/try.html:2057`. Turns `bug 12345` in a commit message into a link. */
function appendLinkifiedBugNumbers(parent: HTMLElement, text: string): void {
    const pattern = /\b(bug )(\d{4,})\b/gi;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        const at = match.index;
        if (at > last) {
            parent.append(text.slice(last, at));
        }
        parent.append(
            link(`https://bugzilla.mozilla.org/show_bug.cgi?id=${match[2]!}`, {
                text: `${match[1]!}${match[2]!}`,
            })
        );
        last = at + match[0].length;
    }
    if (last < text.length) {
        parent.append(text.slice(last));
    }
}

/** The `View on Treeherder` span. */
function renderTreeherderLink(): void {
    const span = el('span', { class: 'treeherder-link' });
    span.append(link(state.treeherderUrl, { text: 'View on Treeherder' }));
    requireElement('treeherder-link-container').replaceChildren(span);
}

/** `old/try.html:1650`. The summary cards, the containers, and the search box. */
function renderResults(failures: Failures, totalJobs: number, failedJobCount: number): void {
    setFavicon('#ff9500');
    renderTreeherderLink();
    requireElement('filter-container').style.display = '';

    const cards = el('div', { class: 'summary-cards' });
    for (const card of summaryCards(failures, { totalJobs, failedJobCount })) {
        const label = el('div', { class: 'label', text: card.label });
        if (card.labelHasMitten === true) {
            label.append(mitten());
        }
        cards.append(
            el('div', {
                class: 'summary-card',
                children: [
                    label,
                    el('div', { class: `value ${card.valueClass}`.trim(), text: card.value }),
                ],
            })
        );
    }

    // The reproduction controls. See divergence 7: the local test-runner
    // subsystem is not migrated, so every control here is emitted **inert and
    // visibly disabled**, and says so in its title.
    //
    // Upstream enables the button whenever failures exist
    // (`updateReproduceButton()`, `old/try.html:3186`, third branch) and wires it to
    // `reproduceFailures()`, which opens a WebSocket to `ws://localhost:3000`
    // (`old/try.html:3206`). None of that exists here. An enabled control with no
    // handler is worse than an absent one: it claims a capability the build
    // does not have, and a DOM diff cannot tell the two apart — which is how
    // this shipped enabled in the first place.
    //
    // The markup is still emitted, still gated on `isLocal`, so the layout and
    // the last column's width (`renderTable`, below) match upstream. `disabled`
    // is set unconditionally rather than from `failures.tests.length`: the
    // reason it cannot run has nothing to do with whether failures loaded.
    const actions = el('div', { class: 'summary-actions' });
    const UNAVAILABLE = 'Local reproduction is not available in this build';
    const extraArgs = el('input', {
        id: 'extra-args',
        attrs: {
            type: 'text',
            value: '',
            placeholder: 'extra mach test args',
            title: UNAVAILABLE,
        },
    });
    extraArgs.disabled = true;
    extraArgs.style.display = isLocal ? '' : 'none';

    const reproduceBtn = el('button', { id: 'reproduce-btn', text: 'Reproduce Failures' });
    reproduceBtn.disabled = true;
    reproduceBtn.title = UNAVAILABLE;
    reproduceBtn.style.display = isLocal ? '' : 'none';

    // Upstream keeps `Reset` hidden until a cached reproduction result exists
    // (`updateResetButton()`, `old/try.html:3583`). No result can exist here, so the
    // reveal is unreachable and the button stays hidden exactly as it does on a
    // fresh upstream load — the states coincide, and the `display: none` below
    // is upstream's own markup, not a workaround.
    const resetBtn = el('button', {
        id: 'repro-reset-btn',
        text: 'Reset',
        title: UNAVAILABLE,
        attrs: { style: 'display: none; font-size: 12px; padding: 6px 10px;' },
    });
    resetBtn.disabled = true;

    actions.append(extraArgs, reproduceBtn, resetBtn);
    cards.append(actions);

    requireElement('results').replaceChildren(
        cards,
        el('div', { id: 'failure-table-container' }),
        el('div', { id: 'intermittent-table-container' }),
        el('div', { id: 'unblamed-table-container' })
    );

    // `searchBox` and not the raw `initSearchBox` global: the wrapper narrows
    // the return type *and* binds the `f` shortcut, so this page gets it with
    // the rest of the family rather than needing its own listener.
    searchBox({
        searchBoxId: 'search-box',
        searchClearId: 'search-clear',
        onSearch: () => {
            state.search = parseSearch(requireInput('search-box').value);
            renderTable();
            void renderUnblamedJobs();
        },
        updateUrlHash: updateUrlState,
    });

    renderTable();
    void renderUnblamedJobs();
}

/** `old/try.html:1738`. The two test tables. */
function renderTable(): void {
    const failures = state.failures;
    if (failures === null) {
        return;
    }
    const container = requireElement('failure-table-container');
    const intermittentContainer = requireElement('intermittent-table-container');

    const tests = sortTests(
        filterTests(failures.tests, state.search),
        state.sort,
        (path) => {
            const data = state.flakiness.get(path);
            return data === undefined
                ? null
                : pickHeadlineRate(data.stats, data.configs).rate;
        }
    );
    const { permanent, intermittent } = splitTables(tests);

    state.flakinessCells.clear();

    const parts: Node[] = [];
    if (needsPermanentHeader(intermittent.length, state.unblamedJobs.length)) {
        parts.push(
            el('h3', {
                class: 'section-header',
                text: `Permanent failures${countSuffix(permanent.length)}`,
            })
        );
    }
    parts.push(renderTestTable(permanent, false));
    container.replaceChildren(...parts);

    if (intermittent.length > 0) {
        const heading = el('h3', { class: 'section-header', text: 'Intermittent failures ' });
        heading.append(mitten());
        // After the mitten, not before it: the glyph belongs to the words it
        // qualifies, and the count is about the table below.
        heading.append(countSuffix(intermittent.length));
        intermittentContainer.replaceChildren(heading, renderTestTable(intermittent, true));
    } else {
        intermittentContainer.replaceChildren();
    }

    // Restore cached flakiness data after the re-render, since the cells are
    // new elements.
    for (const [path, data] of state.flakiness) {
        updateFlakinessDisplay(path, data);
    }
}

/** `old/try.html:1846`. One test table. */
function renderTestTable(tests: readonly FailingTest[], showJobCount: boolean): HTMLElement {
    const table = el('table', { class: 'failure-table' });
    const head = el('thead');
    const headRow = el('tr');

    const sortableHeader = (
        column: SortColumn,
        label: string | Node,
        style: string,
        title?: string
    ): HTMLTableCellElement => {
        const th = el('th', { title });
        if (state.sort.column === column) {
            th.className = 'active';
        }
        th.setAttribute('style', style);
        // Upstream builds the header as one string, so `#` and its arrow are a
        // SINGLE text node (`"# \u25BC"`). Appending the arrow separately would
        // make two, which the parsed-DOM diff sees — and did, on the first run.
        const arrow = state.sort.column === column ? (state.sort.ascending ? ' \u25B2' : ' \u25BC') : '';
        if (typeof label === 'string') {
            th.append(label + arrow);
        } else {
            th.append(label);
            if (arrow) {
                th.append(arrow);
            }
        }
        th.addEventListener('click', () => {
            state.sort = nextSort(state.sort, column);
            renderTable();
        });
        return th;
    };

    headRow.append(sortableHeader('count', '#', 'width: 24px'));
    headRow.append(sortableHeader('status', 'Status', 'width: 65px'));
    headRow.append(
        el('th', { class: 'no-sort', text: 'OS', attrs: { style: 'width: 55px' } })
    );
    headRow.append(
        el('th', { class: 'no-sort', text: 'Build', attrs: { style: 'width: 55px' } })
    );
    headRow.append(
        sortableHeader(
            'flakiness',
            mitten(),
            'width: 45px; text-align: right',
            'Existing flakiness: how often this same failure already happens on autoland ' +
                'and mozilla-central, on the configurations this test failed on in this ' +
                'push. Hover a value for the per-configuration rates.'
        )
    );
    headRow.append(sortableHeader('test', 'Test', ''));

    const hasAnyProfile = tests.some((test) => findUploadedProfile(test.instances) !== null);
    // The width tracks which icons the last column can hold. Upstream writes
    // `20 + (hasRepro || isLocal ? 18 : 0) + (hasAnyProfile ? 18 : 0) + (isLocal ? 18 : 0)`
    // (`old/try.html:1859`) where `hasRepro = reproState.size > 0` (`:1768`).
    //
    // The first term is `isLocal` alone on both pages, for different reasons
    // that happen to agree on every load this page can produce: upstream clears
    // `reproState` on each render (`:1701`), so `hasRepro` is false until a
    // reproduction result arrives, and here no result can ever arrive because
    // the subsystem is not migrated (divergence 7). So the widths match
    // upstream's initial render exactly, and diverge only after an upstream user
    // runs a reproduction — a state this build has no way to enter.
    const iconWidth = 20 + (isLocal ? 18 : 0) + (hasAnyProfile ? 18 : 0) + (isLocal ? 18 : 0);
    headRow.append(
        el('th', { class: 'no-sort', attrs: { style: `width: ${iconWidth}px` } })
    );
    head.append(headRow);
    table.append(head);

    const body = el('tbody');
    for (const test of tests) {
        body.append(renderTestRow(test, showJobCount));
        if (state.expandedTests.has(test.path)) {
            for (const row of renderTestDetailRows(test)) {
                body.append(row);
            }
        }
    }

    if (tests.length === 0) {
        const cell = el('td', { class: 'no-failures', attrs: { colspan: '7' } });
        if (state.search.term) {
            cell.textContent = 'No matching tests found.';
        } else {
            appendNoFailures(cell, false);
        }
        body.append(el('tr', { children: [cell] }));
    }

    table.append(body);
    return table;
}

/** One summary row of a test table. */
function renderTestRow(test: FailingTest, showJobCount: boolean): HTMLTableRowElement {
    const failures = state.failures!;
    const row = el('tr', {
        class: `clickable-row${state.expandedTests.has(test.path) ? ' expanded' : ''}`,
        title: 'Click to expand',
    });
    row.addEventListener('click', () => {
        if (state.expandedTests.has(test.path)) {
            state.expandedTests.delete(test.path);
        } else {
            state.expandedTests.add(test.path);
        }
        renderTable();
    });

    // The `#` column: failing executions, and on an intermittent row also the
    // total number of runs.
    const countCell = el('td', {
        class: `count-cell ${countClass(test.instances.length)}`,
    });
    if (showJobCount) {
        const wrapper = el('span', { title: runCountTooltip(test) });
        wrapper.append(String(test.instances.length));
        wrapper.append(el('span', { class: 'all-configs', text: `/${test.totalRuns}` }));
        countCell.append(wrapper);
    } else {
        countCell.textContent = String(test.instances.length);
    }
    row.append(countCell);

    const statusCell = el('td');
    for (const status of test.statuses) {
        statusCell.append(
            el('span', { class: `status-badge status-${status}`, text: status }),
            ' '
        );
    }
    row.append(statusCell);

    row.append(
        badgesCell(test.sortedPlatforms, failures.globalPlatforms, 'platform'),
        badgesCell(test.sortedBuildTypes, failures.globalBuildTypes, 'build')
    );

    const flakinessCellNode = el('td', { class: 'flakiness-cell' });
    state.flakinessCells.set(test.path, flakinessCellNode);
    row.append(flakinessCellNode);

    const info = el('td', { class: 'test-info' });
    const pathSpan = el('span', { class: 'test-path' });
    // The shared treatment (`site/test-link.ts`): the path as a `test.html`
    // link, then the 📋 and 🔍 buttons. It replaces the `history` link this
    // cell used to carry after the path — the path *is* that link now — and
    // moves the Searchfox destination the path used to carry onto the 🔍
    // button, so nothing this row reached before is unreachable.
    //
    // The title is the link's own, because the row's `Click to expand` is
    // inherited by everything in it and became a false promise about the path
    // the moment the path stopped expanding the row. It names both actions, so
    // the row's behaviour is still discoverable from the thing that no longer
    // does it.
    pathSpan.append(
        ...testRowLink(test.path, {
            title: 'See history — or click elsewhere in the row to see details',
        })
    );
    info.append(pathSpan);
    if (test.commonMessage !== undefined) {
        info.append(
            el('div', {
                class: 'inline-message',
                title: test.commonMessage,
                text: test.commonMessage.split('\n')[0],
            })
        );
    }
    row.append(info);

    row.append(renderActionsCell(test));
    return row;
}

/** The OS / Build cell: badges, or `N/N` when every config is covered. */
function badgesCell(
    values: readonly string[],
    global: ReadonlySet<string>,
    kind: 'platform' | 'build'
): HTMLTableCellElement {
    const cell = el('td', { class: 'badges-cell' });
    const tooltip = values.join(', ');
    if (coversAll(values, global)) {
        cell.append(
            el('span', {
                class: 'all-configs',
                title: tooltip,
                text: `${values.length}/${global.size}`,
            })
        );
        return cell;
    }
    const wrapper = el('span', { title: tooltip });
    for (const value of values) {
        wrapper.append(el('span', { class: `badge ${kind}-${value}`, text: value }));
    }
    cell.append(wrapper);
    return cell;
}

/** The last column: the profiler icon and the copy buttons. `old/try.html:1893`. */
function renderActionsCell(test: FailingTest): HTMLTableCellElement {
    const cell = el('td', { class: 'repro-cell' });
    // Upstream emits an empty `<span id="repro-icon-…">` even with no
    // reproduction state, so the cell's layout does not shift when one arrives.
    cell.append(el('span'));

    const profile = findUploadedProfile(test.instances);
    if (profile !== null) {
        cell.append(profilerLink(test.path, null, profile));
    }

    const copyCmd = el('span', {
        class: 'copy-cmd',
        text: '\u{1F4CB}',
        title: `Copy mach test command${isLocal ? ' (Alt+click: copy Claude prompt)' : ''}`,
    });
    copyCmd.addEventListener('click', (event) => {
        event.stopPropagation();
        copyMachCmd(test.path, copyCmd, event);
    });
    cell.append(copyCmd);

    if (isLocal) {
        const copyDebug = el('span', {
            class: 'copy-cmd',
            text: '\u{1F41B}',
            title:
                'Copy debugging JSON: how the failure/run counts were derived, with every ' +
                'parsed execution',
        });
        copyDebug.addEventListener('click', (event) => {
            event.stopPropagation();
            copyDebugJson(test.path, copyDebug);
        });
        cell.append(copyDebug);
    }
    return cell;
}

/**
 * The detail rows of one expanded test: one per job run. `old/try.html:2118`.
 *
 * Grouped by `taskId.retryId`, so two failures in the same job run share a row
 * and the assertion list under it shows both.
 */
function renderTestDetailRows(test: FailingTest): HTMLTableRowElement[] {
    interface JobGroup {
        jobName: string;
        taskId: string;
        retryId: number;
        instances: Timing[];
    }
    const byJob = new Map<string, JobGroup>();
    for (const instance of test.instances) {
        const key = runKeyOf(instance);
        let group = byJob.get(key);
        if (group === undefined) {
            group = {
                jobName: instance.jobName,
                taskId: instance.taskId,
                retryId: instance.retryId,
                instances: [],
            };
            byJob.set(key, group);
        }
        group.instances.push(instance);
    }

    const rows: HTMLTableRowElement[] = [];
    for (const job of byJob.values()) {
        rows.push(renderJobDetailRow(test, job));
    }
    return rows;
}

/** One job run's detail row. */
function renderJobDetailRow(
    test: FailingTest,
    job: { jobName: string; taskId: string; retryId: number; instances: Timing[] }
): HTMLTableRowElement {
    const platform = extractPlatform(job.jobName);
    const builds = extractBuildTypes(job.jobName);
    const profilerUrl = getProfilerUrl(
        { taskId: job.taskId, retryId: job.retryId, jobName: job.jobName },
        test.path.split('/').pop()
    );
    const thJobUrl =
        `${TH_BASE}/jobs?repo=${state.repo}&selectedTaskRun=${job.taskId}.${job.retryId}` +
        `&revision=${state.revision ?? ''}`;

    const jobStatuses = new Set<string>();
    for (const instance of job.instances) {
        jobStatuses.add(baseStatus(instance.status));
    }

    const row = el('tr', { class: 'detail-row visible' });

    // The `#` column carries the mitten when EVERY instance in this job run was
    // intermittent — the same all-or-nothing rule the table split uses.
    const countCell = el('td', { class: 'count-cell' });
    if (job.instances.every((instance) => instance.intermittent === true)) {
        countCell.append(mitten());
    }
    row.append(countCell);

    const statusCell = el('td');
    for (const status of jobStatuses) {
        statusCell.append(
            el('span', { class: `status-badge status-${status}`, text: status }),
            ' '
        );
    }
    row.append(statusCell);

    const platformCell = el('td', { class: 'badges-cell' });
    platformCell.append(el('span', { class: `badge platform-${platform}`, text: platform }));
    row.append(platformCell);

    const buildCell = el('td', { class: 'badges-cell' });
    for (const build of sortedBuildTypes(new Set(builds))) {
        buildCell.append(el('span', { class: `badge build-${build}`, text: build }));
    }
    row.append(buildCell);

    // Flakiness is a per-test column; a detail row has nothing to put in it.
    row.append(el('td'));

    const info = el('td', { class: 'test-info' });
    const header = el('div', { class: 'job-header' });
    header.append(el('span', { class: 'job-name', text: job.jobName }));

    // A test that fails is rerun in the harness's "retry" phase. Split the
    // failures into the initial run and the retry, ordered by time; when it
    // failed initially but ultimately passed, no failure instance exists for
    // the retry, so the outcome is stated on its own line.
    const sortedInstances = [...job.instances].sort((a, b) => a.timestamp - b.timestamp);
    const initialInstances = sortedInstances.filter((i) => i.isRetry !== true);
    const retryInstances = sortedInstances.filter((i) => i.isRetry === true);
    const passedOnRetry = sortedInstances.some((i) => i.passedOnRetry === true);
    const showRuns = retryInstances.length > 0 || (passedOnRetry && initialInstances.length > 0);

    const jobKey = `${job.taskId}.${job.retryId}`;
    const jobProfile = findUploadedProfile(job.instances);
    // For a lone failure run the test-run failure profile sits by the job name;
    // the links below are job-level.
    if (!showRuns && jobProfile !== null) {
        header.append(profilerLink(test.path, jobKey, jobProfile));
    }

    const links = el('span', { class: 'job-links' });
    links.append(plainLink(profilerUrl, 'Profile'));
    const crashUrls = new Set<string>();
    for (const instance of job.instances) {
        if (instance.minidump !== undefined) {
            crashUrls.add(
                getCrashViewerUrl({
                    taskId: instance.taskId,
                    retryId: instance.retryId,
                    minidump: instance.minidump,
                })
            );
        }
    }
    for (const crashUrl of crashUrls) {
        if (crashUrl) {
            links.append(plainLink(crashUrl, 'Crash'));
        }
    }
    links.append(plainLink(thJobUrl, 'Treeherder'));
    header.append(' ', links);
    info.append(header);

    info.append(...renderAssertionList(test, { showRuns, initialInstances, retryInstances, passedOnRetry, jobKey }));

    row.append(info);
    row.append(el('td'));
    return row;
}

/**
 * A link inside a detail row's `job-links`.
 *
 * Unlike `link()` this does **not** stop propagation: upstream's detail-row
 * links carry no `onclick` (`old/try.html:2204`), because a detail row is not
 * itself clickable, so there is no row toggle to suppress.
 */
function plainLink(href: string, text: string): HTMLAnchorElement {
    const anchor = el('a', { href, text });
    anchor.target = '_blank';
    return anchor;
}

/** One item of the assertion list: a message, a crash signature, or a phase label. */
interface AssertionItem {
    separator?: boolean;
    label?: string;
    cls?: string;
    icon?: HTMLElement | null;
    /** The rendered content, already escaped by construction. */
    content?: Node | string;
    stack?: string | undefined;
}

/** How many assertions show before the `show N more` link. `old/try.html:2356`. */
const MAX_VISIBLE = 10;

/** The `<ul class="assertion-list">` and its `show more` link. `old/try.html:2212`. */
function renderAssertionList(
    test: FailingTest,
    options: {
        showRuns: boolean;
        initialInstances: readonly Timing[];
        retryInstances: readonly Timing[];
        passedOnRetry: boolean;
        jobKey: string;
    }
): Node[] {
    const { showRuns, initialInstances, retryInstances, passedOnRetry, jobKey } = options;
    const items: AssertionItem[] = [];

    const appendInstance = (instance: Timing, cls: string): void => {
        if (instance.crashSignature !== undefined) {
            const crashViewerUrl =
                instance.minidump !== undefined
                    ? getCrashViewerUrl({
                          taskId: instance.taskId,
                          retryId: instance.retryId,
                          minidump: instance.minidump,
                      })
                    : '';
            items.push({
                cls,
                content: crashViewerUrl
                    ? link(crashViewerUrl, {
                          class: 'crash-sig',
                          text: instance.crashSignature,
                      })
                    : el('span', { class: 'crash-sig', text: instance.crashSignature }),
            });
        }
        const messages =
            instance.allMessages.length > 0
                ? instance.allMessages
                : instance.message !== undefined
                  ? [{ message: instance.message }]
                  : [];
        for (const message of messages) {
            // The "profile uploaded in …" notice is shown as the icon instead.
            if (extractUploadedProfileName(message.message) !== null) {
                continue;
            }
            items.push({
                cls,
                content: message.message,
                stack: 'stack' in message ? message.stack : undefined,
            });
        }
    };

    const appendGroup = (label: string, cls: string, instances: readonly Timing[]): void => {
        if (instances.length === 0) {
            return;
        }
        if (showRuns) {
            const withProfile = instances.find(
                (instance) => instanceUploadedProfile(instance) !== null
            );
            const profile =
                withProfile === undefined ? null : instanceUploadedProfile(withProfile);
            items.push({
                separator: true,
                label,
                cls,
                icon: profile === null ? null : profilerLink(test.path, jobKey, profile),
            });
        }
        for (const instance of instances) {
            appendInstance(instance, showRuns ? cls : '');
        }
    };

    appendGroup('Initial', 'phase-initial', initialInstances);
    appendGroup('Retry', 'phase-retry', retryInstances);
    // Failed initially but passed on the retry: no failure instance exists for
    // the retry, so the outcome gets a single plain line — no badge, no rule.
    if (showRuns && passedOnRetry && retryInstances.length === 0) {
        items.push({ content: el('span', { class: 'repro-pass', text: 'Passed on retry' }) });
    }

    const list = el('ul', { class: 'assertion-list' });
    const hidden: HTMLElement[] = [];
    for (const [index, item] of items.entries()) {
        const isHidden = index >= MAX_VISIBLE;
        const li = renderAssertionItem(item, isHidden);
        if (isHidden) {
            hidden.push(li);
        }
        list.append(li);
    }

    if (items.length <= MAX_VISIBLE) {
        return [list];
    }
    const remaining = items.length - MAX_VISIBLE;
    const more = el('a', { class: 'show-more-link', text: `show ${remaining} more` });
    more.addEventListener('click', () => {
        // Divergence 4: a class, not `style.display`. `assertion-hidden` is not
        // styled in shared.css — grep confirms — so upstream's inline
        // `display:none` was doing all the work and the class was already inert.
        const nowHidden = hidden[0]?.hidden === true;
        for (const item of hidden) {
            item.hidden = !nowHidden;
        }
        more.textContent = nowHidden ? 'show less' : `show ${hidden.length} more`;
    });
    return [list, more];
}

/** One `<li>` of the assertion list. `old/try.html:2345`. */
function renderAssertionItem(item: AssertionItem, isHidden: boolean): HTMLElement {
    const classes: string[] = [];
    if (item.separator === true) {
        classes.push('phase-label');
    } else if (item.cls) {
        classes.push('phase-body');
    }
    if (item.cls) {
        classes.push(item.cls);
    }
    if (isHidden) {
        classes.push('assertion-hidden');
    }
    const li = el('li', { class: classes.join(' ') });
    if (isHidden) {
        li.hidden = true;
    }

    if (item.separator === true) {
        li.append(el('span', { class: 'chip', text: item.label ?? '' }));
        if (item.icon != null) {
            li.append(item.icon);
        }
        return li;
    }
    if (item.content !== undefined) {
        li.append(item.content);
    }
    if (item.stack !== undefined) {
        li.append(renderStack(item.stack));
    }
    return li;
}

// --- stack colouring ------------------------------------------------------
//
// `old/try.html:2251-2333`. Three line shapes, tried in order, and everything else
// is printed plain. The point of the colouring is that a leak stack and a JS
// stack look different at a glance and each links to Searchfox where it can.

/** Known prefix → Searchfox source path. The prefix is hidden. `old/try.html:2252`. */
const SOURCE_PREFIX_MAP: [string, string][] = [
    ['chrome://mochitests/content/browser/', ''],
    ['chrome://mochikit/content/', 'testing/mochitest/'],
];

/** One `file:line:col` reference, linked where possible. `old/try.html:2257`. */
function renderJsFile(file: string, funcName: string | null): Node {
    const lineMatch = /^(.+?):(\d+)(:\d+)?$/.exec(file);
    const filePart = lineMatch ? lineMatch[1]! : file;
    const lineNum = lineMatch ? lineMatch[2]! : null;
    const lineSuffix = lineMatch ? `:${lineMatch[2]!}${lineMatch[3] ?? ''}` : '';
    const fileName = filePart.split('/').pop();

    for (const [prefix, replacement] of SOURCE_PREFIX_MAP) {
        if (filePart.startsWith(prefix)) {
            const srcPath = replacement + filePart.slice(prefix.length);
            const href =
                `https://searchfox.org/mozilla-central/source/${srcPath}` +
                (lineNum !== null ? `#${lineNum}` : '');
            const anchor = el('a', { href });
            anchor.target = '_blank';
            anchor.append(el('span', { class: 'stack-file', text: srcPath }));
            if (lineSuffix) {
                anchor.append(el('span', { class: 'stack-line', text: lineSuffix }));
            }
            return anchor;
        }
    }

    // Unknown scheme (`resource://`, `chrome://browser/`, …): grey out the
    // prefix and link to a Searchfox *search* rather than a source path,
    // because the mapping from a runtime URL to a source file is not one this
    // page knows.
    const schemeMatch = /^(.+\/)([^/]+)$/.exec(filePart);
    const fragment = document.createDocumentFragment();
    if (schemeMatch) {
        fragment.append(el('span', { class: 'stack-prefix', text: schemeMatch[1]! }));
        fragment.append(el('span', { class: 'stack-file', text: schemeMatch[2]! }));
    } else {
        fragment.append(el('span', { class: 'stack-file', text: filePart }));
    }
    if (lineSuffix) {
        fragment.append(el('span', { class: 'stack-line', text: lineSuffix }));
    }
    if (fileName !== undefined && fileName !== '') {
        const params = new URLSearchParams({ path: fileName, case: 'true', regexp: 'false' });
        if (funcName !== null) {
            params.set('q', funcName);
        }
        const anchor = el('a', { href: `https://searchfox.org/mozilla-central/search?${params}` });
        anchor.target = '_blank';
        anchor.append(fragment);
        return anchor;
    }
    return fragment;
}

/** A leak-stack description. `old/try.html:2299`. */
function renderLeakDesc(desc: string): Node {
    const fragment = document.createDocumentFragment();
    const funcMatch = /^(JS Function - )(.+)$/.exec(desc);
    if (funcMatch) {
        fragment.append(el('span', { class: 'stack-desc', text: funcMatch[1]! }));
        fragment.append(el('span', { class: 'stack-func', text: funcMatch[2]! }));
        return fragment;
    }
    for (const part of desc.split(/((?:chrome|resource):\/\/[^\s]+)/)) {
        if (/^(?:chrome|resource):\/\//.test(part)) {
            fragment.append(renderJsFile(part, null));
        } else {
            fragment.append(el('span', { class: 'stack-desc', text: part }));
        }
    }
    return fragment;
}

/** The `<pre class="assertion-stack">`. `old/try.html:2314`. */
function renderStack(stack: string): HTMLElement {
    const pre = el('pre', { class: 'assertion-stack' });
    const lines = stack.split('\n');
    for (const [index, line] of lines.entries()) {
        if (index > 0) {
            pre.append('\n');
        }
        // Leak stack: `name — description @  0xaddr`.
        const leakMatch = /^(.+?) — (.+?) @ {2}(0x[0-9a-f]+)$/.exec(line);
        if (leakMatch) {
            pre.append(el('span', { class: 'stack-func', text: leakMatch[1]! }));
            pre.append(el('span', { class: 'stack-sep', text: ' — ' }));
            pre.append(renderLeakDesc(leakMatch[2]!));
            pre.append(el('span', { class: 'stack-sep', text: ' @ ' }));
            pre.append(el('span', { class: 'stack-addr', text: leakMatch[3]! }));
            continue;
        }
        // Leak stack with no description: `name @  0xaddr`.
        const leakSimple = /^(.+?) @ {2}(0x[0-9a-f]+)$/.exec(line);
        if (leakSimple) {
            pre.append(el('span', { class: 'stack-func', text: leakSimple[1]! }));
            pre.append(el('span', { class: 'stack-sep', text: ' @ ' }));
            pre.append(el('span', { class: 'stack-addr', text: leakSimple[2]! }));
            continue;
        }
        // JS stack: `func @ file:line:col`.
        const jsMatch = /^(.+?) @ (.+)$/.exec(line);
        if (jsMatch) {
            pre.append(el('span', { class: 'stack-func', text: jsMatch[1]! }));
            pre.append(el('span', { class: 'stack-sep', text: ' @ ' }));
            pre.append(renderJsFile(jsMatch[2]!, jsMatch[1]!));
            continue;
        }
        pre.append(line);
    }
    return pre;
}

// --- the unblamed-jobs table ----------------------------------------------

/** `old/try.html:1914`. Failed test jobs with no test-level failure attributed. */
async function renderUnblamedJobs(): Promise<void> {
    const container = requireElement('unblamed-table-container');
    if (state.unblamedJobs.length === 0) {
        container.replaceChildren();
        state.unblamedGroups = null;
        return;
    }

    if (state.unblamedGroups === null) {
        // One bug-suggestions request per job, in parallel. A failure yields an
        // empty list rather than propagating: the table is still worth showing
        // with a job's summary missing.
        const summaries = await Promise.all(
            state.unblamedJobs.map(async (job) => {
                if (!job.jobId) {
                    return [];
                }
                try {
                    const response = await fetch(
                        `${TH_BASE}/api/project/${state.repo}/jobs/${job.jobId}/bug_suggestions/`
                    );
                    if (!response.ok) {
                        return [];
                    }
                    const suggestions = (await response.json()) as { search?: string }[];
                    return suggestions
                        .filter((s) => s.search !== undefined && s.search.trim() !== '')
                        .map((s) => s.search!.trim());
                } catch {
                    return [];
                }
            })
        );
        for (const [index, job] of state.unblamedJobs.entries()) {
            job.cleanedSummary = cleanFailureSummary(summaries[index] ?? []);
        }
        state.unblamedGroups = groupUnblamedJobs(state.unblamedJobs, summaries);
    }

    const groups = visibleUnblamedGroups(state.unblamedGroups, state.search);
    if (groups.length === 0) {
        container.replaceChildren();
        return;
    }

    const table = el('table', { class: 'failure-table' });
    const head = el('thead');
    const headRow = el('tr');
    // Every header is `no-sort`: this table's order is `jobs.length`
    // descending and is not configurable. `old/try.html:1955`.
    for (const [label, width] of [
        ['#', '24px'],
        ['Status', '65px'],
        ['OS', '55px'],
        ['Build', '55px'],
        ['Job', ''],
        ['', '20px'],
    ] as [string, string][]) {
        headRow.append(
            el('th', {
                class: 'no-sort',
                text: label,
                attrs: width ? { style: `width: ${width}` } : {},
            })
        );
    }
    head.append(headRow);
    table.append(head);

    const body = el('tbody');
    for (const group of groups) {
        body.append(renderUnblamedGroupRow(group));
        if (state.expandedUnblamed.has(group.key)) {
            for (const job of group.jobs) {
                body.append(renderUnblamedJobRow(job));
            }
        }
    }
    table.append(body);

    container.replaceChildren(
        el('h3', {
            class: 'section-header',
            text: 'Failed jobs with no specific test blamed',
        }),
        table
    );
}

/** One group's summary row. */
function renderUnblamedGroupRow(group: UnblamedGroup): HTMLTableRowElement {
    const allPlatforms = new Set<string>();
    const allBuildTypes = new Set<string>();
    for (const job of group.jobs) {
        allPlatforms.add(extractPlatform(job.jobName));
        for (const build of extractBuildTypes(job.jobName)) {
            allBuildTypes.add(build);
        }
    }

    const row = el('tr', {
        class: `clickable-row${state.expandedUnblamed.has(group.key) ? ' expanded' : ''}`,
        title: 'Click to expand',
    });
    // Divergence 5: keyed by the group key, not by a render index resolved
    // against an array the next render overwrites.
    row.addEventListener('click', () => {
        if (state.expandedUnblamed.has(group.key)) {
            state.expandedUnblamed.delete(group.key);
        } else {
            state.expandedUnblamed.add(group.key);
        }
        void renderUnblamedJobs();
    });

    row.append(
        el('td', {
            class: `count-cell ${countClass(group.jobs.length)}`,
            text: String(group.jobs.length),
        })
    );
    row.append(
        el('td', {
            children: [el('span', { class: 'status-badge status-FAIL', text: 'FAIL' })],
        })
    );

    const platformCell = el('td', { class: 'badges-cell' });
    for (const platform of sortedPlatforms(allPlatforms)) {
        platformCell.append(el('span', { class: `badge platform-${platform}`, text: platform }));
    }
    row.append(platformCell);

    const buildCell = el('td', { class: 'badges-cell' });
    for (const build of sortedBuildTypes(allBuildTypes)) {
        buildCell.append(el('span', { class: `badge build-${build}`, text: build }));
    }
    row.append(buildCell);

    const info = el('td', { class: 'test-info' });
    if (group.lines.length > 0) {
        info.append(
            el('div', {
                class: 'inline-message',
                title: group.lines.join('\n'),
                text: group.lines[0],
            })
        );
    } else {
        info.append(
            el('div', {
                class: 'inline-message',
                text: '(no failure summary available)',
                attrs: { style: 'color:#999' },
            })
        );
    }
    row.append(info, el('td'));
    return row;
}

/** One unblamed job's detail row. `old/try.html:2074`. */
function renderUnblamedJobRow(job: Job): HTMLTableRowElement {
    const platform = extractPlatform(job.jobName);
    const builds = extractBuildTypes(job.jobName);
    const profilerUrl = getProfilerUrl({
        taskId: job.taskId,
        retryId: job.retryId,
        jobName: job.jobName,
    });
    const thJobUrl =
        `${TH_BASE}/jobs?repo=${state.repo}&selectedTaskRun=${job.taskId}.${job.retryId}` +
        `&revision=${state.revision ?? ''}`;

    const row = el('tr', { class: 'detail-row visible' });
    row.append(el('td', { class: 'count-cell' }));
    row.append(
        el('td', {
            children: [el('span', { class: 'status-badge status-FAIL', text: 'FAIL' })],
        })
    );

    const platformCell = el('td', { class: 'badges-cell' });
    platformCell.append(el('span', { class: `badge platform-${platform}`, text: platform }));
    row.append(platformCell);

    const buildCell = el('td', { class: 'badges-cell' });
    for (const build of sortedBuildTypes(new Set(builds))) {
        buildCell.append(el('span', { class: `badge build-${build}`, text: build }));
    }
    row.append(buildCell);

    const info = el('td', { class: 'test-info' });
    const header = el('div', { class: 'job-header' });
    header.append(el('span', { class: 'job-name', text: job.jobName }));
    const links = el('span', { class: 'job-links' });
    links.append(link(profilerUrl, { text: 'Profile' }));
    links.append(link(thJobUrl, { text: 'Treeherder' }));
    header.append(' ', links);
    info.append(header);

    for (const line of job.cleanedSummary ?? []) {
        const div = el('div', { class: 'inline-message' });
        // A `PROCESS-CRASH | <uuid> | rest` line gets its UUID linked to the
        // crash viewer; everything else is plain text. `old/try.html:2065`.
        const match = /^(PROCESS-CRASH \| )([0-9a-f-]{36})( \| .*)$/.exec(line);
        const crashUrl =
            match === null
                ? ''
                : getCrashViewerUrl({
                      taskId: job.taskId,
                      retryId: job.retryId,
                      minidump: match[2]!,
                  });
        if (match !== null && crashUrl) {
            div.append(match[1]!);
            div.append(link(crashUrl, { text: match[2]! }));
            div.append(match[3]!);
        } else {
            div.textContent = line;
        }
        info.append(div);
    }
    row.append(info, el('td'));
    return row;
}

// --- the empty state ------------------------------------------------------

/** `old/try.html:1830`. Divergence 6: built from the view model's parts. */
function appendNoFailures(parent: HTMLElement, noTestFailuresAtAll: boolean): void {
    const text = noFailuresText({
        noTestFailuresAtAll,
        otherFailedJobCount: state.otherFailedJobs.length,
    });
    parent.append(el('span', { class: 'verdict', text: text.verdict }));
    if (text.caveatHasLink) {
        const caveat = el('span', { class: 'caveat other-failures', text: text.caveat });
        caveat.append(link(state.treeherderUrl, { text: 'check on Treeherder' }), '.');
        parent.append(caveat);
    } else {
        parent.append(el('span', { class: 'caveat', text: text.caveat }));
    }
}

// --- uploaded failure profiles --------------------------------------------

/**
 * A real link to an uploaded failure profile, so the destination shows in the
 * status bar on hover. Alt+click copies a profiler-cli prompt instead.
 * `old/try.html:2965`.
 */
function profilerLink(
    testPath: string,
    jobKey: string | null,
    profile: UploadedProfile
): HTMLAnchorElement {
    const artifactUrl = uploadedProfileArtifactUrl(
        profile.taskId,
        profile.retryId,
        profile.filename
    );
    const leaf = testPath.split('/').pop();
    const url = getProfilerUrl({
        profile: artifactUrl,
        profileName: `${profile.jobName} — ${leaf}`,
    });
    const anchor = el('a', {
        class: 'profiler-cmd',
        href: url,
        title:
            'Open the failure profile in the Firefox Profiler ' +
            '(Alt+click: copy profiler-cli debug prompt)',
        attrs: { rel: 'noopener' },
    });
    anchor.target = '_blank';
    anchor.addEventListener('click', (event) => {
        event.stopPropagation();
        if (event.altKey) {
            event.preventDefault();
            copyProfilerDebugPrompt(testPath, jobKey, anchor);
        }
    });
    return anchor;
}

/** `old/try.html:2907`. */
function uploadedProfileArtifactUrl(
    taskId: string,
    retryId: number,
    filename: string
): string {
    return (
        `https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/${taskId}/runs/` +
        `${retryId}/artifacts/public/test_info/${filename}`
    );
}

// --- clipboard actions ----------------------------------------------------

/** `old/try.html:2886`. */
function getExtraArgs(): string[] {
    const value = (document.getElementById('extra-args') as HTMLInputElement | null)?.value.trim();
    return value ? value.split(/\s+/) : [];
}

/** `old/try.html:2891`. */
function getMachCmd(testPath: string): string {
    return ['./mach test', testPath, '--headless', ...getExtraArgs()].join(' ');
}

/** Copies, then shows a tick for a second. `old/try.html:3030`. */
function copyWithFeedback(text: string, element: HTMLElement): void {
    void navigator.clipboard.writeText(text).then(() => {
        const previous = element.textContent;
        element.textContent = '✓';
        element.classList.add('copied');
        setTimeout(() => {
            element.textContent = previous;
            element.classList.remove('copied');
        }, 1000);
    });
}

/** `old/try.html:3016`. Alt+click, when local, copies a debugging prompt instead. */
function copyMachCmd(testPath: string, element: HTMLElement, event: MouseEvent): void {
    if (isLocal && event.altKey) {
        const test = state.failures?.tests.find((t) => t.path === testPath);
        const message = test?.commonMessage ?? test?.instances[0]?.message ?? '';
        copyWithFeedback(
            'Follow the instructions in @../DEBUG_STANDALONE_TEST_FAILURES.md to debug this ' +
                `test failure.\n\n\`${getMachCmd(testPath)}\`\n\nError: ${message}`,
            element
        );
        return;
    }
    copyWithFeedback(getMachCmd(testPath), element);
}

/**
 * Copies the raw data behind a row's counts. `old/try.html:3041`.
 *
 * Every parsed execution of the test, grouped by job name and job run, next to
 * the derived numbers — so the "failures / runs" ratio can be checked against
 * what it was built from. This is the seam the sort-key bug was found through.
 */
function copyDebugJson(testPath: string, element: HTMLElement): void {
    const failures = state.failures;
    const test = failures?.tests.find((t) => t.path === testPath);
    if (test === undefined || failures === undefined || failures === null) {
        return;
    }
    const byJob = failures.execsByTest.get(testPath);
    const jobs = [...test.jobs].map((jobName) => {
        const runs = byJob?.get(jobName);
        return {
            jobName,
            completedRunsOfThisJobName: state.jobRunCounts?.get(jobName) ?? null,
            profiledRuns: runs ? runs.size : 0,
            runs: [...(runs ?? new Map<string, Timing[]>())].map(([runKey, execs]) => ({
                runKey,
                executions: execs.map((exec) => ({
                    status: exec.status,
                    isRetry: exec.isRetry === true,
                    startTime: exec.timestamp,
                    durationMs: Math.round(exec.duration),
                    intermittent: exec.intermittent === true,
                    passedOnRetry: exec.passedOnRetry === true,
                })),
            })),
        };
    });

    copyWithFeedback(
        JSON.stringify(
            {
                test: test.path,
                revision: state.revision,
                repo: state.repo,
                derived: {
                    failures: test.instances.length,
                    totalRuns: test.totalRuns,
                    totalJobs: test.totalJobs,
                    outcomes: test.outcomes,
                    statuses: [...test.statuses],
                },
                jobs,
            },
            null,
            2
        ),
        element
    );
}

/** `old/try.html:2984`. */
function copyProfilerDebugPrompt(
    testPath: string,
    jobKey: string | null,
    element: HTMLElement
): void {
    const test = state.failures?.tests.find((t) => t.path === testPath);
    if (test === undefined) {
        return;
    }
    const scope =
        jobKey !== null
            ? test.instances.filter((instance) => runKeyOf(instance) === jobKey)
            : test.instances;
    const profile = findUploadedProfile(scope);
    if (profile === null) {
        return;
    }
    const artifactUrl = uploadedProfileArtifactUrl(
        profile.taskId,
        profile.retryId,
        profile.filename
    );
    // Messages from the same run that produced the profile.
    const profKey = `${profile.taskId}.${profile.retryId}`;
    const runInstances = test.instances.filter(
        (instance) => runKeyOf(instance) === profKey
    );
    const message = instanceMessages(runInstances).join('\n') || test.commonMessage || '';

    void navigator.clipboard
        .writeText(
            `Use profiler-cli to debug this Firefox test failure.

Test: ${testPath}
Job: ${profile.jobName}

Failure message:
${message}

A Gecko profile was captured at the moment of failure. Load it with:
\`profiler-cli load "${artifactUrl}"\`

Then investigate the cause: look at the markers around the failure (TestStatus/FAIL/ERROR markers and the failing test's own "test" marker), inspect the test thread's activity and stacks at that time, and check any relevant log markers. Run \`profiler-cli guide\` if you need a refresher on the commands. Explain the most likely cause of the failure.`
        )
        .then(() => {
            element.classList.add('copied');
            setTimeout(() => {
                element.classList.remove('copied');
            }, 1000);
        });
}

// --- flakiness ------------------------------------------------------------

/**
 * Creates the flakiness worker from the bundled source. `old/try.html:2581`.
 *
 * The source comes from `globalThis.__workers`, which `tools/build-pages.ts`
 * writes as a string constant ahead of this module's code. See
 * `site/try-flakiness-worker.ts` for why the old page's `.toString()` approach
 * cannot survive bundling.
 *
 * A missing entry throws rather than falling back to a module worker. Two
 * reasons, and the second is the one that decided it:
 *
 *  - There is nothing to fall back *for*. `site/try.html` carries
 *    `<script type="module" src="./try.ts">`, which no browser can load
 *    unbuilt, so a page reaching this line has necessarily been through the
 *    build and the entry is either there or the build is broken.
 *  - `new URL('./x.ts', import.meta.url)` puts an `import.meta` in the bundle,
 *    and `tools/build-pages.ts`'s parse guard — `new Function`, which is not a
 *    module scope — rejects it. That guard exists because the symptom of a
 *    mangled inline bundle is a blank dashboard, so working around it to keep a
 *    dev convenience would be trading a real check for an unreachable path.
 */
function initFlakinessWorker(): Worker {
    if (state.flakinessWorker !== null) {
        return state.flakinessWorker;
    }
    const source = globalThis.__workers?.['try-flakiness-worker.ts'];
    if (source === undefined) {
        throw new Error(
            'try-flakiness-worker.ts was not inlined by the build. The page cannot ' +
                'fetch 21-day history without it; check the <!-- worker: --> directive ' +
                'in site/try.html.'
        );
    }
    const worker = new Worker(
        URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))
    );
    state.flakinessWorker = worker;
    return worker;
}

/** One round trip to the flakiness worker. `old/try.html:2619`. */
function processInWorker(
    worker: Worker,
    buffer: ArrayBuffer,
    tests: readonly FlakinessRequest[]
): Promise<WorkerResponse> {
    return new Promise((resolve) => {
        const handler = (event: MessageEvent<WorkerResponse>): void => {
            worker.removeEventListener('message', handler);
            resolve(event.data);
        };
        worker.addEventListener('message', handler);
        worker.postMessage({ buffer, tests }, [buffer]);
    });
}

/**
 * Fills in the flakiness column, one bucket file at a time. `old/try.html:2632`.
 *
 * Sequential fetches with the next file's download overlapping the current
 * file's parse — a bucket file is ~3.5 MB and the parse is the slow half, so
 * the pipeline roughly halves the wall time without ever holding two 3.5 MB
 * buffers *and* two decoded files at once.
 *
 * Tests not found under their detected harness are retried under the other one,
 * because `detectHarness` cannot tell a mochitest-plain `test_foo.js` from an
 * xpcshell one (`lib/model/harness.ts` documents the hole). Anything still not
 * found gets a blank cell.
 */
async function fetchFlakinessData(tests: readonly FailingTest[]): Promise<void> {
    const worker = initFlakinessWorker();
    const requests = flakinessRequests(tests, stripChunkSuffix);
    const testOrder = new Map(tests.map((test, index) => [test.path, index]));

    const processChunks = async (
        entries: readonly FlakinessRequest[],
        harnessOf: (path: string) => string
    ): Promise<FlakinessRequest[]> => {
        const notFound: FlakinessRequest[] = [];
        const sorted = groupRequestsByChunk(
            entries,
            testOrder,
            (path) => `${harnessOf(path)}-${bucketFileSuffix(bucketIndexForPath(path))}`
        );

        let workerPromise: Promise<WorkerResponse> | null = null;
        let workerTests: FlakinessRequest[] | null = null;

        const drainWorker = async (): Promise<void> => {
            if (workerPromise === null) {
                return;
            }
            const pending = workerTests ?? [];
            try {
                const result = await workerPromise;
                if (result.error !== undefined) {
                    notFound.push(...pending);
                } else {
                    for (const answer of result.results ?? []) {
                        applyFlakinessResult(answer, pending, notFound);
                    }
                }
            } catch {
                notFound.push(...pending);
            }
            workerPromise = null;
            workerTests = null;
        };

        let pendingFetch: Promise<ArrayBuffer | null> | null = null;
        const fetchChunk = (file: string): Promise<ArrayBuffer | null> =>
            fetchData(`${file}.json`)
                .then((response) => (response.ok ? response.arrayBuffer() : null))
                .catch(() => null);

        for (let i = 0; i < sorted.length; i++) {
            const [chunkFile, chunkTests] = sorted[i]!;
            const fetched = await (pendingFetch ?? fetchChunk(chunkFile));
            pendingFetch = null;
            if (fetched === null) {
                notFound.push(...chunkTests);
                continue;
            }
            await drainWorker();
            workerTests = chunkTests;
            workerPromise = processInWorker(worker, fetched, chunkTests);
            // Start fetching the next chunk while the worker parses this one.
            const next = sorted[i + 1];
            if (next !== undefined) {
                pendingFetch = fetchChunk(next[0]);
            }
        }
        await drainWorker();
        return notFound;
    };

    const notFound = await processChunks(requests, (path) => detectHarness(path));
    if (notFound.length > 0) {
        const stillNotFound = await processChunks(notFound, (path) =>
            otherHarness(detectHarness(path))
        );
        for (const entry of stillNotFound) {
            updateFlakinessDisplay(entry.path, null);
        }
    }

    worker.terminate();
    state.flakinessWorker = null;
}

/** Records one worker answer, or defers the test to the other harness. */
function applyFlakinessResult(
    answer: FlakinessResult,
    pending: readonly FlakinessRequest[],
    notFound: FlakinessRequest[]
): void {
    if (!answer.found) {
        const request = pending.find((test) => test.path === answer.path);
        if (request !== undefined) {
            notFound.push(request);
        }
        return;
    }
    const data: FlakinessData = {
        stats: answer.stats!,
        hasMatchingMessage: answer.hasMatchingMessage === true,
        configs: answer.configs ?? [],
        totalDays: answer.totalDays ?? 0,
    };
    state.flakiness.set(answer.path, data);
    updateFlakinessDisplay(answer.path, data);
}

/** `old/try.html:2848`. Paints one flakiness cell. */
function updateFlakinessDisplay(testPath: string, data: FlakinessData | null): void {
    const cell = state.flakinessCells.get(testPath);
    if (cell === undefined) {
        return;
    }
    const view = flakinessCell(data);
    if (view === null) {
        cell.replaceChildren();
        cell.className = 'flakiness-cell';
        cell.title = '';
        return;
    }
    cell.className = view.className;
    // The same URL the path links to, built by the shared `testPageUrl` — but
    // not the shared link element: this anchor's text is a percentage and its
    // title is the per-config breakdown, so only the destination is shared.
    const anchor = link(testPageUrl(testPath), { title: view.tooltip });
    if (view.hasMitten) {
        anchor.append(mitten());
    }
    anchor.append(view.text);
    cell.replaceChildren(anchor);
}

// --- the console API ------------------------------------------------------

/** `old/try.html:3659`. */
function getSortedFailures(): ConsoleFailure[] {
    const failures = state.failures;
    if (failures === null) {
        return [];
    }
    return consoleFailures(
        sortConsoleFailures(filterTests(failures.tests, state.search), state.sort),
        failures
    );
}

/** `old/try.html:3699`. */
function logFailures(list: readonly ConsoleFailure[]): void {
    console.table(
        list.map((failure) => ({
            '#': failure.count,
            test: failure.test,
            statuses: failure.statuses.join(', '),
            platforms: Array.isArray(failure.platforms)
                ? failure.platforms.join(', ')
                : failure.platforms,
            buildTypes: Array.isArray(failure.buildTypes)
                ? failure.buildTypes.join(', ')
                : failure.buildTypes,
            flaky: failure.flaky,
            message: failure.message ?? '',
        }))
    );
}

/** `old/try.html:3737`. */
function logConsoleAPI(): void {
    console.log(
        '%cConsole API available',
        'font-weight: bold; font-size: 14px; color: #2563eb'
    );
    console.log(
        `%c  failures%c    — all failures sorted as on page\n` +
            `%c  permaFails%c  — same, excluding flaky failures\n\n` +
            `    Each entry: { test, count, statuses, platforms, buildTypes, flaky, message }\n` +
            `    • platforms/buildTypes: array of names, or "all" if present on every config\n` +
            `    • flaky: true if failure was intermittent in all runs (didn't happen in every job)\n` +
            `    • message: first line of failure message (if consistent across instances)\n` +
            `    Also logs a console.table() for quick viewing.\n\n` +
            `  formatForPrompt(list) — pretty-prints for use as a Claude prompt\n\n` +
            `  Example: copy(formatForPrompt(permaFails))`,
        'color: #059669; font-weight: bold',
        'color: inherit',
        'color: #059669; font-weight: bold',
        'color: inherit'
    );
}

/**
 * Installs the console seams. `old/try.html:3711-3735`.
 *
 * Getters, not functions: typing `failures` in the console is the whole
 * interface, and it also logs a `console.table` on the way past.
 */
function installConsoleAPI(): void {
    Object.defineProperty(window, 'formatForPrompt', {
        value: formatForPrompt,
        writable: true,
        configurable: true,
    });
    Object.defineProperty(window, 'failures', {
        configurable: true,
        get() {
            const list = getSortedFailures();
            logFailures(list);
            return list;
        },
    });
    Object.defineProperty(window, 'permaFails', {
        configurable: true,
        get() {
            const list = getSortedFailures().filter((failure) => !failure.flaky);
            logFailures(list);
            return list;
        },
    });
}

// --- init -----------------------------------------------------------------

installConsoleAPI();

document.addEventListener('DOMContentLoaded', () => {
    const url = readUrlState(window.location.search);
    state.repo = url.repo;

    // Seed the filter from the URL BEFORE loading, so that `updateUrlState()` —
    // called during the load, before the filter UI is shown — does not clear the
    // parameter. `old/try.html:3763`.
    if (url.filter) {
        requireInput('search-box').value = url.filter;
        state.search = parseSearch(url.filter);
    }
    // Set explicitly rather than only when present, so a browser-preserved
    // checkbox state cannot disagree with the URL after a reload.
    requireInput('alljobs-checkbox').checked = url.allJobs;

    requireElement('load-btn').addEventListener('click', () => {
        void loadRevision();
    });
    // Toggling "All jobs" changes which jobs get fetched, so reload the push.
    // With nothing loaded yet, just record the choice for the next Load.
    requireInput('alljobs-checkbox').addEventListener('change', () => {
        if (state.revision !== null) {
            void loadRevision();
        } else {
            updateUrlState();
        }
    });

    if (url.rev !== null) {
        const prefix = url.repo !== 'try' ? `${url.repo}:` : '';
        requireInput('revision-input').value = prefix + url.rev;
        void loadRevision();
    }

    requireInput('revision-input').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            void loadRevision();
        }
    });

    // The `f` shortcut is `searchBox()`'s, in `site/drilldown-render.ts`: this
    // page had the only copy, and it is now shared with every other page that
    // has a filter box. Its one extra rule — do nothing while the filter is
    // hidden, which here means no revision is loaded — went into the shared
    // handler as a visibility check, so a hidden box is never focused.
});
