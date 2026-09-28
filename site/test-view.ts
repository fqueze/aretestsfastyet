/**
 * `test.html`'s **view model**: one test's bucket file reduced to exactly what
 * the page draws, with no DOM in sight.
 *
 * The second of the three migrations `PARITY.md` §3 sequences, following the
 * boundary `site/crash-view.ts` settled:
 *
 * > **`lib/` holds data and derivations. The page directory holds the view
 * > model — including anything that names an element id, a CSS class or a
 * > glyph.**
 *
 * Applying that test here draws the line in a specific and slightly surprising
 * place, so it is worth stating what went which way.
 *
 * ## What came from `lib/`, unchanged
 *
 * | from | replaces | verified against the old page |
 * | --- | --- | --- |
 * | `computeTestStats` (`lib/query/test-stats.ts`) | `common-test-data.js:267` | 775 tests across 4 real bucket files, every field equal |
 * | `coverageOf` (`lib/query/coverage.ts`) | `calculateJobNameBreakdown` (`old/test.html:2607`) | same 775 tests, every job name and count equal |
 * | `bucketIndexForPath` (`lib/formats/buckets.ts`) | `getChunkIndex` (`common-test-data.js:26`) | same hash, `\| 0` and all |
 * | `decoded.findTest` (`lib/formats/tables.ts`) | `findTest` (`common-test-data.js:53`) | same linear path join |
 * | `detectHarness` (`lib/model/harness.ts`) | `common-test-data.js:9` | moved out of `cli/options.ts`; see that module |
 * | `classifyStatus`, `skipReason`, `displaySkipMessage` | six inline copies | — |
 *
 * The page no longer loads `common-test-data.js` at all, which was the point.
 *
 * ## What stayed here, and why it is not `lib/`'s
 *
 * **`extractVariant` / `displayVariant` / `displayPlatform` and the collapse
 * machinery.** This is the largest thing in this file and the easiest to
 * mistake for a data derivation. It is not: it decides *how many rows and
 * columns the table has*. `computeDisplayMappings` collapses `X-swr` into `X`
 * only when their per-platform outcome signatures match, and merges the 32- and
 * 64-bit columns only when no variant distinguishes them — both are judgements
 * about what a reader should see side by side, made from the data but
 * answerable only in terms of a table. `lib/query/coverage.ts` deliberately has
 * no such concept: it reports one row per configuration and says so.
 *
 * The test from `crash-view.ts` — *would a non-page consumer want this, and
 * does it name anything about the UI?* — comes out the same way it did there.
 * `fx-tests test --coverage` prints configurations, not a variant × platform
 * pivot, and moving this to `lib/` would be shipping a reuse nothing has asked
 * for.
 *
 * **Everything naming a badge, a cell key or a glyph.** `cellKey()` builds
 * `"variant|platform"`, which is the string the DOM carries in `data-variant`
 * and `data-platform` and which every interaction is keyed on. The badge kinds
 * are `fail`/`crash`/`timeout`/`pass`/`skip`, which are CSS class suffixes.
 * Both are here for the reason `frameRows()`'s `crashed` class was: the class
 * name is the channel the old page used to express a behavioural decision, and
 * reproducing the name is what keeps the stylesheet unchanged.
 *
 * ## Why the view model exists at all
 *
 * `PARITY.md` §2. A page that builds strings of HTML out of a parsed JSON file
 * has no seam to compare against; the only way to ask what it decided is to
 * read the pixels back. Splitting the decisions from the drawing means the job
 * table's row order, the badge percentages, the issue list and its counts are
 * all plain values a node test can assert on, and `site/test.ts` becomes a
 * transliteration.
 *
 * It matters more here than it did for the crash viewer, because this page's
 * interactions *recompute* the view: selecting two cells and three days
 * re-derives every badge, every issue count and the runtime panel. Those
 * recomputations are functions in this file taking a selection and returning
 * values, so the filtered states are testable without driving a browser.
 *
 * ## This file must stay DOM-free
 *
 * `tsconfig.site.json` gives `site/` the DOM lib, so that is a discipline
 * rather than something the compiler enforces here — but it *is* enforced
 * indirectly: `test/test-view.test.ts` imports this module, the root project
 * compiles `test/**`, and the root project has no DOM. A `document` reach fails
 * `npm run typecheck` on the root project.
 */

import { type DecodedTimingFile, type RunEntry } from '../lib/formats/decode.ts';
import { formatDurationMs } from '../lib/model/duration.ts';
import { extractPlatform } from '../lib/model/job-name.ts';
import { classifyStatus } from '../lib/model/status.ts';
import { displaySkipMessage, skipReason } from '../lib/model/skips.ts';
import { type ConfigCoverage, coverageOf } from '../lib/query/coverage.ts';
import {
    type TestIssue,
    CRASH_NO_SIGNATURE,
    FAILURE_NO_MESSAGE,
    TIMEOUT_MESSAGE,
    buildTestIssues,
} from '../lib/query/test-issues.ts';
import { type TestStats } from '../lib/query/test-stats.ts';

/**
 * `coverageOf`'s rows, put back into the order the page's own walk produced
 * them.
 *
 * ## Why this exists, and how it was found
 *
 * `coverageOf` sorts its output by descending run count and then by job name
 * (`lib/query/coverage.ts:292`), which is right for a CLI table. The page does
 * not sort at all: `calculateJobNameBreakdown` returns a plain object and
 * `Object.entries` yields insertion order, which is the order the status-group
 * walk first saw each job name.
 *
 * That difference is invisible until two variants **tie** in the row sort, and
 * then it decides which comes first — because `Array.prototype.sort` is stable,
 * so a tie preserves the input order and the input order is this one.
 *
 * It is not hypothetical. The browser diff on
 * `dom/media/test/test_playback.html` reported exactly this and nothing else:
 *
 * ```
 * row 14  OLD ccov-mochitest-media-nogpu   NEW ccov-mochitest-media
 * row 15  OLD ccov-mochitest-media         NEW ccov-mochitest-media-nogpu
 * ```
 *
 * Both variants have 51 runs and the prefix `ccov`, so both levels of the sort
 * tie and the order falls through to insertion. `coverageOf` had emitted them
 * alphabetically; the page's walk had seen `-nogpu` first.
 *
 * ## Why the order is recovered here rather than changed in `lib/`
 *
 * `coverageOf`'s sort is a documented property its CLI caller relies on, and
 * the page needs the *unsorted* order — so the two want different things from
 * the same query and neither is wrong. Recovering the order costs one pass over
 * the entries and keeps the divergence where it belongs: in the page, whose
 * row order this is.
 *
 * A first pass over `runsOfTest` yields the job names in walk order; the rows
 * are then emitted in that order.
 *
 * ## Why the order matters, measured
 *
 * `Array.prototype.sort` is stable, so the input order decides every tie in
 * `buildJobTable`'s two-level key — and ties are common, not exotic. Over the
 * 1,674 tests in the pinned snapshot plus both checked-in fixtures: **492
 * tests have at least one tied pair** (797 pairs in total), and on **186 of
 * them the resulting row order actually differs** between this walk order and
 * `coverageOf`'s own order. One of the 186 is in `mochitest-00.json`, so
 * `test/test-view.test.ts` pins it against real data.
 *
 * (An earlier review recorded "0 ties" here and concluded the pre-sort was
 * unreachable. That measurement was wrong; the numbers above replace it.)
 *
 * ## The trailing append, and why it is unreachable
 *
 * Any row whose job name the walk never produced is appended in `coverageOf`'s
 * order. **Measured unreachable: 0 configs over those same 1,674 tests.** That
 * is structural rather than lucky, and the reason is worth stating because it
 * is the only thing that could change it:
 *
 *  - Both sides iterate the same `file.runsOfTest(testId)`, and `coverageOf`
 *    creates a row only from an entry it yields — it has no other source
 *    ("nothing is added from outside the test's runs", `lib/query/coverage.ts`).
 *  - Both resolve an entry to job names the same way: `entry.jobName` when the
 *    shape names a job, otherwise `jobNameOfTaskIndex` per task.
 *  - So the walk's name set is a superset of `coverageOf`'s, except for the two
 *    places they differ, and neither can add a name:
 *      1. `coverageOf` keys rows by `stripChunkSuffix(jobName)` while the walk
 *         looks up the raw name. On the bucket family that is an identity —
 *         the generator already strips the chunk suffix into a parallel array
 *         (`lib/formats/buckets.ts`), and `stripChunkSuffix` changes **0 of
 *         the 2,987** `tables.jobNames` entries across the snapshot and the
 *         fixtures. On a family that did carry suffixes this loop is exactly
 *         what would stop a row from being dropped.
 *      2. The walk skips `run-if` skips before taking a name. That can only
 *         make the walk see *fewer* names, and it cannot orphan a row: a
 *         config known **only** from a `run-if` skip gets no row from
 *         `coverageOf` on this family either, because the 21-day aggregates
 *         drop those entries upstream (`FORMATS.md`).
 *
 * It is kept rather than deleted because appending beats dropping if any of
 * those three facts stops holding, and each is a property of the data format
 * rather than of this function.
 */
function coverageInPageOrder(
    file: DecodedTimingFile,
    testId: number
): ConfigCoverage[] {
    const byName = new Map<string, ConfigCoverage>();
    for (const config of coverageOf(file, testId).configs) {
        byName.set(config.jobName, config);
    }

    const ordered: ConfigCoverage[] = [];
    const taken = new Set<string>();
    for (const entry of file.runsOfTest(testId)) {
        const { kind } = classifyStatus(entry.status);
        // `run-if` skips never create a row: `calculateJobNameBreakdown`
        // `continue`s before `ensureJob` (`old/test.html:2642`), so a config known
        // only from a `run-if` skip is absent from the table entirely rather
        // than present with zeroes.
        if (kind === 'skip' && skipReason(entry.message) === 'run-if') {
            continue;
        }
        // `unknown` is not skipped here even though it contributes no counts:
        // upstream's `addToJob` calls `ensureJob` before classifying, so an
        // UNKNOWN entry does create the row. Zero such entries exist in the
        // published data (`lib/model/status.ts` measured 0 in 21 days), so this
        // is fidelity to the rule rather than a case anyone has seen.
        for (const target of targetsOfEntry(file, entry)) {
            if (taken.has(target.jobName)) {
                continue;
            }
            const config = byName.get(target.jobName);
            if (config !== undefined) {
                taken.add(target.jobName);
                ordered.push(config);
            }
        }
    }
    for (const [jobName, config] of byName) {
        if (!taken.has(jobName)) {
            ordered.push(config);
        }
    }
    return ordered;
}

// --- variant and platform naming -----------------------------------------
//
// The pivot's axes. Page-local: see the module comment.

/**
 * The display variant of a job name, before any collapsing.
 *
 * `old/test.html:588`, unchanged. Three rules, and the second and third exist
 * because of what they make visible:
 *
 * ```
 * test-linux1804-64-asan/opt-xpcshell-1     -> asan-xpcshell
 * test-linux1804-64-artifact/opt-xpcshell-1 -> artifact-opt-xpcshell
 * test-linux1804-64/opt-xpcshell-1          -> opt-xpcshell
 * ```
 *
 * A sanitizer replaces the build type rather than being appended, because an
 * asan build is not an opt build with a flag. An artifact build is *prepended*
 * rather than replacing, because opt and debug artifact builds both exist and
 * a test can perma-fail on an artifact build while passing on a regular one —
 * upstream's comment, and the reason the token survives to be collapsed
 * conditionally below rather than being dropped here.
 */
export function extractVariant(jobName: string): string {
    const slashIdx = jobName.indexOf('/');
    let variant = slashIdx !== -1 ? jobName.substring(slashIdx + 1) : jobName;
    variant = variant.replace(/-\d+$/, '');
    if (slashIdx !== -1) {
        const prefix = jobName.substring(0, slashIdx);
        const sanitizerMatch = /-(asan|tsan|ccov)$/.exec(prefix);
        if (sanitizerMatch !== null) {
            // Group 1 is non-optional in the pattern, so it is always present
            // when the match is.
            variant = variant.replace(/^[^-]+/, sanitizerMatch[1]!);
        }
        if (/-artifact(?:-|$)/.test(prefix)) {
            variant = 'artifact-' + variant;
        }
    }
    return variant;
}

/**
 * The coarse OS of a job name — `shared.js:70`'s `extractPlatform`.
 *
 * Shared with `try-view.ts`, which had a byte-identical copy. It is deliberately
 * not `operatingSystem()`; `lib/model/job-name.ts` states why both exist.
 * Re-exported rather than imported through, because this page's own tests and
 * the parity harness read it from here.
 */
export { extractPlatform };

/**
 * The OS with its bitness, e.g. `windows-64`.
 *
 * `extractDetailedPlatform` (`shared.js:88`). Android and `unknown` are never
 * split: an Android platform string carries its own naming
 * (`android-em-14-x86_64`) and splitting on `-64` there would produce
 * `android-64`, which is not a thing anyone runs.
 */
export function extractDetailedPlatform(name: string): string {
    const base = extractPlatform(name);
    if (base === 'unknown' || base === 'android') {
        return base;
    }
    const slashIdx = name.indexOf('/');
    const prefix = slashIdx !== -1 ? name.substring(0, slashIdx) : name;
    if (/-aarch64(?:-|$)/.test(prefix)) {
        return `${base}-aarch64`;
    }
    if (/-32(?:-|$)/.test(prefix)) {
        return `${base}-32`;
    }
    if (/-64(?:-|$)/.test(prefix) || /-x86_64(?:-|$)/.test(prefix)) {
        return `${base}-64`;
    }
    return base;
}

/**
 * The pretty names the column headers use.
 *
 * `platformDisplayNames` (`shared.js:99`). Copied rather than read off the
 * global: `shared.js` is loaded by the page and stays that way, but a view
 * model that reads a global at module scope is a view model a node test cannot
 * import. A platform with no entry here falls back to its own key, which is
 * what upstream's `|| platform` does.
 */
export const PLATFORM_DISPLAY_NAMES: Record<string, string> = {
    android: 'Android',
    linux: 'Linux',
    windows: 'Windows',
    mac: 'macOS',
    'windows-32': 'Win 32',
    'windows-64': 'Win 64',
    'mac-64': 'macOS x64',
    'mac-aarch64': 'macOS ARM',
    'linux-32': 'Linux 32',
    'linux-64': 'Linux 64',
};

/** The header text for a platform column. */
export function platformDisplayName(platform: string): string {
    return PLATFORM_DISPLAY_NAMES[platform] ?? platform;
}

// --- the collapse mappings ------------------------------------------------

/** Per-cell outcome counts, the unit everything downstream aggregates. */
export interface Outcomes {
    passes: number;
    failures: number;
    timeouts: number;
    crashes: number;
    skips: number;
}

/** A fresh zeroed cell. */
export function emptyOutcomes(): Outcomes {
    return { passes: 0, failures: 0, timeouts: 0, crashes: 0, skips: 0 };
}

/** Adds `from` into `into`, in place. */
function addOutcomes(into: Outcomes, from: Outcomes): void {
    into.passes += from.passes;
    into.failures += from.failures;
    into.timeouts += from.timeouts;
    into.crashes += from.crashes;
    into.skips += from.skips;
}

/**
 * What the table shows for a cell, reduced to the axes a collapse compares on.
 *
 * `outcomeSig` (`old/test.html:660`). A cell with no runs at all is `absent`, one
 * with only skips is `skip`, and anything else is the set of outcome letters it
 * saw — so two configs that both fail sometimes and pass sometimes have the
 * same signature regardless of the rates. Deliberately coarse: the question a
 * collapse asks is "would merging these hide a difference a reader needs", and
 * 3% versus 4% is not such a difference while "fails here, never fails there"
 * is.
 */
export function outcomeSignature(d: Outcomes): string {
    const total = d.passes + d.failures + d.timeouts + d.crashes;
    if (total === 0) {
        return d.skips > 0 ? 'skip' : 'absent';
    }
    return (
        (d.passes > 0 ? 'p' : '') +
        (d.failures > 0 ? 'f' : '') +
        (d.timeouts > 0 ? 't' : '') +
        (d.crashes > 0 ? 'c' : '')
    );
}

/**
 * One variant-token collapse step.
 *
 * `unconditional` marks a token known to behave like its base; everything else
 * only collapses when every shared platform's outcome signature matches, so a
 * test that perma-fails only on artifact builds keeps its own row.
 */
interface CollapseStep {
    match: RegExp;
    strip: RegExp;
    unconditional?: boolean;
    precheck?: (detailedPlatforms: string[]) => boolean;
}

/**
 * The collapse steps, in the order they run.
 *
 * `old/test.html:686`, order included — and the order is load-bearing, in one
 * place upstream calls out: `nofis` sits **before** `geckoview` so that
 * `X-geckoview-Y-nofis` can collapse against the still-present
 * `X-geckoview-Y` before `geckoview` is itself collapsed away. Reversing them
 * leaves the nofis row stranded.
 *
 * Token meanings, upstream's list:
 *
 * | token | what it is |
 * | --- | --- |
 * | `X-swr` | software WebRender, linux-only — hence the precheck |
 * | `artifact-X` | test runs against an artifact build (prebuilt binaries) |
 * | `X-standalone` | mochitest variant that restarts the browser per test |
 * | `X-msix` | Windows MSIX-packaged Firefox build |
 * | `X-nofis` | fission disabled (desktop and Android) |
 * | `X-geckoview-Y` | Android xpcshell/mochitest; collapsing lets a cross-platform test share one row |
 *
 * Only SWR is unconditional. The rest can each hide a real behavioural
 * difference, so they collapse only when the data says they do not.
 */
const VARIANT_TOKEN_COLLAPSES: CollapseStep[] = [
    {
        match: /-swr(?:-|$)/,
        strip: /-swr(?=-|$)/,
        unconditional: true,
        precheck: (dps) => dps.every((p) => p.startsWith('linux')),
    },
    { match: /^artifact-/, strip: /^artifact-/ },
    { match: /-standalone(?:-|$)/, strip: /-standalone(?=-|$)/ },
    { match: /-msix(?:-|$)/, strip: /-msix(?=-|$)/ },
    { match: /-nofis(?:-|$)/, strip: /-nofis(?=-|$)/ },
    { match: /-geckoview(?:-|$)/, strip: /-geckoview(?=-|$)/ },
];

/**
 * The variant→base and detailedPlatform→displayPlatform maps for one test.
 *
 * These decide the table's shape, and they are derived from *this test's* runs
 * only — two tests can legitimately show different rows for the same CI
 * configuration, because the question each answers is "does splitting this
 * make a difference for **this** test".
 */
export interface DisplayMappings {
    /**
     * variant → the variant it collapses into. Chains: `nofis-on-geckoview` can
     * map to `geckoview`, which maps to the desktop base, so a lookup has to
     * follow the chain (`displayVariantOf`).
     */
    variantCollapse: Record<string, string>;
    /** detailedPlatform → the column it is drawn in. */
    platformCollapse: Record<string, string>;
}

/** Empty mappings, for a test with no jobs at all. */
export function emptyDisplayMappings(): DisplayMappings {
    return { variantCollapse: {}, platformCollapse: {} };
}

/**
 * Computes the collapse mappings from a test's per-config coverage.
 *
 * `computeDisplayMappings` (`old/test.html:625`), which re-aggregates
 * `calculateJobNameBreakdown`'s per-job counts into variant × detailedPlatform
 * and then runs the two collapse passes. Here the per-job counts come from
 * `coverageOf`, which was verified to produce the same ones — see the module
 * comment's table.
 *
 * ## The platform merge, and the branch that is easy to get wrong
 *
 * Detailed platforms are grouped by base OS (`windows-32` and `windows-64` both
 * under `windows`). A group with **one** member always collapses to the base,
 * which is what turns a windows-64-only test's column header from `Win 64` into
 * `Windows`. A group with several collapses only when no variant shows
 * different outcome *types* across them — and "different" is measured over the
 * non-absent signatures only, so a variant that ran on 64 and not on 32 is not
 * itself a reason to split the column.
 */
export function computeDisplayMappings(configs: readonly ConfigCoverage[]): DisplayMappings {
    const mappings = emptyDisplayMappings();
    if (configs.length === 0) {
        return mappings;
    }

    // variant -> detailedPlatform -> outcomes
    const outcomes: Record<string, Record<string, Outcomes>> = {};
    for (const config of configs) {
        const variant = extractVariant(config.jobName);
        const dp = extractDetailedPlatform(config.jobName);
        outcomes[variant] ??= {};
        const byPlatform = outcomes[variant];
        byPlatform[dp] ??= emptyOutcomes();
        addOutcomes(byPlatform[dp], outcomesOfConfig(config));
    }

    const tryCollapse = (fromV: string, toV: string, step: CollapseStep): void => {
        const from = outcomes[fromV];
        const to = outcomes[toV];
        if (from === undefined || to === undefined) {
            return;
        }
        if (step.precheck !== undefined && !step.precheck(Object.keys(from))) {
            return;
        }
        if (step.unconditional !== true) {
            for (const dp of Object.keys(from)) {
                const a = from[dp]!;
                const b = to[dp];
                if (b !== undefined && outcomeSignature(a) !== outcomeSignature(b)) {
                    return; // outcomes differ; keep the rows apart
                }
            }
        }
        mappings.variantCollapse[fromV] = toV;
        for (const [dp, data] of Object.entries(from)) {
            const existing = to[dp];
            if (existing === undefined) {
                to[dp] = data;
            } else {
                addOutcomes(existing, data);
            }
        }
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete outcomes[fromV];
    };

    for (const step of VARIANT_TOKEN_COLLAPSES) {
        for (const fromV of Object.keys(outcomes).filter((v) => step.match.test(v))) {
            tryCollapse(fromV, fromV.replace(step.strip, ''), step);
        }
    }

    // Platform 32/64 merge: group detailed platforms by base OS.
    const basePlatformGroups: Record<string, Set<string>> = {};
    for (const byPlatform of Object.values(outcomes)) {
        for (const dp of Object.keys(byPlatform)) {
            const base = dp.replace(/-(32|64|aarch64)$/, '');
            basePlatformGroups[base] ??= new Set();
            basePlatformGroups[base].add(dp);
        }
    }

    for (const [base, subSet] of Object.entries(basePlatformGroups)) {
        const subs = [...subSet];
        if (subs.length <= 1) {
            // `subs[0]` is always defined: a group only exists because some
            // platform was added to it.
            mappings.platformCollapse[subs[0]!] = base;
            continue;
        }
        // Keep the split only if some variant behaves differently across the
        // sub-platforms. Absent signatures are dropped first, so "ran on 64,
        // never scheduled on 32" is not by itself a difference.
        let hasDifferences = false;
        for (const byPlatform of Object.values(outcomes)) {
            const sigs = subs.map((sp) => {
                const cell = byPlatform[sp];
                return cell === undefined ? 'absent' : outcomeSignature(cell);
            });
            const nonAbsent = sigs.filter((s) => s !== 'absent');
            if (new Set(nonAbsent).size > 1) {
                hasDifferences = true;
                break;
            }
        }
        for (const sp of subs) {
            mappings.platformCollapse[sp] = hasDifferences ? sp : base;
        }
    }

    return mappings;
}

/**
 * A coverage row as the page's outcome counters.
 *
 * The one mapping that is not a rename: `expectedFailCount` folds into
 * `passes`. `lib/model/status.ts` splits `EXPECTED-FAIL` out on purpose — a
 * `fail-if` annotation that fires is neither a pass nor a failure — while
 * `calculateJobNameBreakdown` puts it in the pass bucket by listing it among
 * the non-failures (`old/test.html:2625`). Folding it back here is what keeps every
 * cell's badge percentage identical to the old page's; splitting it out would
 * be a behaviour change this migration is not making, and one with no UI to
 * show it in.
 */
function outcomesOfConfig(config: ConfigCoverage): Outcomes {
    return {
        passes: config.passCount + config.expectedFailCount,
        failures: config.failCount,
        timeouts: config.timeoutCount,
        crashes: config.crashCount,
        skips: config.skipCount,
    };
}

/** The variant a job name is drawn under, following the collapse chain. */
export function displayVariantOf(mappings: DisplayMappings, jobName: string): string {
    let variant = extractVariant(jobName);
    // Chases the chain, e.g. nofis-on-geckoview -> geckoview -> desktop base.
    // A cycle is impossible because every step strips characters.
    let next = mappings.variantCollapse[variant];
    while (next !== undefined) {
        variant = next;
        next = mappings.variantCollapse[variant];
    }
    return variant;
}

/**
 * A job variant as the page labels it, without the harness the page header
 * already names: `opt-mochitest-browser-chrome` is `opt browser-chrome` on a
 * mochitest's page, `debug-xpcshell-msix` is `debug msix` on an xpcshell test's.
 * The space, not a dash, where the harness was, so the label does not read as
 * a job name. A variant without the harness in it is returned unchanged.
 */
export function variantLabel(variant: string, harness: string): string {
    const parts = variant.split('-');
    const at = parts.indexOf(harness);
    if (at === -1) {
        return variant;
    }
    return [parts.slice(0, at).join('-'), parts.slice(at + 1).join('-')]
        .filter((part) => part !== '')
        .join(' ') || variant;
}

/** The column a job name is drawn in. */
export function displayPlatformOf(mappings: DisplayMappings, jobName: string): string {
    const dp = extractDetailedPlatform(jobName);
    return mappings.platformCollapse[dp] ?? dp;
}

/**
 * The `variant|platform` key.
 *
 * The string the DOM carries in `data-variant`/`data-platform`, the key of
 * `clickedCells`, and what every filtered recomputation looks up. Page-local
 * by construction: it is an identifier for a cell.
 */
export function cellKey(variant: string, platform: string): string {
    return `${variant}|${platform}`;
}

/** Splits a cell key back into its parts, for the filter notice's prose. */
export function splitCellKey(key: string): { variant: string; platform: string } {
    const bar = key.indexOf('|');
    return bar === -1
        ? { variant: key, platform: '' }
        : { variant: key.slice(0, bar), platform: key.slice(bar + 1) };
}

// --- the job table --------------------------------------------------------

/** One badge in a cell. The kind is the CSS class suffix, `badge-${kind}`. */
export interface CellBadge {
    kind: 'fail' | 'crash' | 'timeout' | 'pass' | 'skip';
    /** `FAIL`, `PASS`, … — the badge's own text. */
    label: string;
    /**
     * The `12.3%` a fail/crash/timeout badge shows in its own span, or `null`
     * for the pass and skip badges, which show no rate.
     */
    percentText: string | null;
    /** The `title` attribute, already newline-joined. */
    tooltip: string;
}

/** One cell of the pivot. */
export interface JobCell {
    variant: string;
    platform: string;
    /** `variant|platform`, the DOM's key. */
    key: string;
    /**
     * `null` when this variant never ran on this platform. The page draws an
     * em-dash and the cell carries no `data-variant`, so it is not selectable.
     */
    outcomes: Outcomes | null;
    /** Badges in draw order, top to bottom. Empty when `outcomes` is null. */
    badges: CellBadge[];
    /**
     * Whether the cell gets the hidden `PASS` prefix overlay — shown when a
     * day filter leaves the cell with passes and no issues.
     *
     * Emitted only for a cell that has both issues and passes, matching
     * `old/test.html:2751`: a cell that never had an issue has nothing to fall back
     * from, and one with no passes has nothing to fall back to.
     */
    hasPassPrefixLayer: boolean;
    /**
     * Whether hovering the cell does nothing. True for a cell showing only
     * passes or only an em-dash — there is no per-cell runtime story worth
     * pulling up for a cell with nothing to distinguish.
     */
    noHover: boolean;
}

/** One row of the pivot: a variant, and its cell in every platform column. */
export interface JobRow {
    variant: string;
    cells: JobCell[];
}

/** The whole `Pass/Fail by Job` table. */
export interface JobTable {
    /** Platform column keys, in header order. */
    platforms: string[];
    /** Column headers, parallel to `platforms`. */
    platformHeaders: string[];
    rows: JobRow[];
    /** Per-cell outcomes by `variant|platform`, for the interactions. */
    byCell: Map<string, Outcomes>;
}

/**
 * Builds the pivot from a test's coverage.
 *
 * **The row unit is one job variant; platforms are columns**
 * (`old/test.html:2670`). This is a per-test detail page, not a ranked list, and
 * the framing audit flags it as the thing most easily lost in a port: a
 * migration that emitted one row per configuration would produce the same
 * numbers and answer a different question.
 *
 * ## The sort, which is two levels and has no UI
 *
 * `old/test.html:2717-2731`. Variants are grouped by their prefix — the text before
 * the first `-`, so `opt-xpcshell` and `opt-xpcshell-1proc` share the prefix
 * `opt` — and then:
 *
 * 1. groups are ordered by the **total runs of the whole group**, descending;
 * 2. within a group, variants are ordered by their **own** total runs,
 *    descending.
 *
 * "Total runs" here **includes skips** (`old/test.html:2720`), unlike every
 * percentage on the page. That is deliberate on upstream's part and preserved:
 * the sort is asking "how much CI does this variant account for", and a
 * variant scheduled everywhere and skipped everywhere accounts for a lot of it.
 * Using the badge denominator instead would sink an all-skipped row to the
 * bottom, which is where a reader would least look for the reason it never
 * runs.
 *
 * Platform columns are plain lexicographic on the *key*, not the display name
 * (`old/test.html:2698`), so `mac-64` sorts before `mac-aarch64` and `Win 32`
 * before `Win 64`. Neither axis is user-sortable; there is no sort control on
 * this page at all.
 */
export function buildJobTable(
    configs: readonly ConfigCoverage[],
    mappings: DisplayMappings
): JobTable {
    // variant -> platform -> outcomes, plus the skip messages behind the
    // SKIP badge's tooltip.
    const variants = new Map<string, Map<string, Outcomes>>();
    const skipMessages = new Map<string, Map<string, number>>();
    const platformSet = new Set<string>();

    for (const config of configs) {
        const platform = displayPlatformOf(mappings, config.jobName);
        const variant = displayVariantOf(mappings, config.jobName);
        platformSet.add(platform);
        const key = cellKey(variant, platform);

        let byPlatform = variants.get(variant);
        if (byPlatform === undefined) {
            byPlatform = new Map();
            variants.set(variant, byPlatform);
        }
        let cell = byPlatform.get(platform);
        if (cell === undefined) {
            cell = emptyOutcomes();
            byPlatform.set(platform, cell);
        }
        addOutcomes(cell, outcomesOfConfig(config));

        if (config.skipMessages.size > 0) {
            let messages = skipMessages.get(key);
            if (messages === undefined) {
                messages = new Map();
                skipMessages.set(key, messages);
            }
            for (const [message, count] of config.skipMessages) {
                messages.set(message, (messages.get(message) ?? 0) + count);
            }
        }
    }

    const platforms = [...platformSet].sort();

    // The two-level sort. `totalRuns` includes skips — see the doc comment.
    const totalRuns = (byPlatform: Map<string, Outcomes>): number => {
        let total = 0;
        for (const d of byPlatform.values()) {
            total += d.passes + d.failures + d.timeouts + d.crashes + d.skips;
        }
        return total;
    };
    const prefixOf = (variant: string): string => variant.split('-')[0] || variant;

    const prefixRuns = new Map<string, number>();
    for (const [variant, byPlatform] of variants) {
        const prefix = prefixOf(variant);
        prefixRuns.set(prefix, (prefixRuns.get(prefix) ?? 0) + totalRuns(byPlatform));
    }

    const sorted = [...variants.entries()].sort((a, b) => {
        const prefixA = prefixOf(a[0]);
        const prefixB = prefixOf(b[0]);
        if (prefixA !== prefixB) {
            return (prefixRuns.get(prefixB) ?? 0) - (prefixRuns.get(prefixA) ?? 0);
        }
        return totalRuns(b[1]) - totalRuns(a[1]);
    });

    const byCell = new Map<string, Outcomes>();
    const rows: JobRow[] = sorted.map(([variant, byPlatform]) => ({
        variant,
        cells: platforms.map((platform) => {
            const outcomes = byPlatform.get(platform) ?? null;
            const key = cellKey(variant, platform);
            if (outcomes === null) {
                return {
                    variant,
                    platform,
                    key,
                    outcomes: null,
                    badges: [],
                    hasPassPrefixLayer: false,
                    noHover: true,
                };
            }
            byCell.set(key, outcomes);
            const badges = cellBadges(outcomes, skipMessages.get(key) ?? new Map());
            const issues = outcomes.failures + outcomes.timeouts + outcomes.crashes;
            return {
                variant,
                platform,
                key,
                outcomes,
                badges,
                hasPassPrefixLayer: issues > 0 && outcomes.passes > 0,
                // Upstream computes this from the rendered DOM after the fact
                // (`old/test.html:3168`): a cell with no fail/crash/timeout/skip
                // badge gets `no-hover`. Same predicate, from the values.
                noHover: !badges.some((badge) => badge.kind !== 'pass'),
            };
        }),
    }));

    return {
        platforms,
        platformHeaders: platforms.map(platformDisplayName),
        rows,
        byCell,
    };
}

/**
 * The badges one cell shows, in draw order.
 *
 * ## The denominator excludes skips
 *
 * `old/test.html:2740`: `total = passes + failures + timeouts + crashes`. A skip is
 * not a run, so a test skipped on 90% of its scheduled jobs and failing on half
 * of the rest reads as 50%, not 5%. This is the same denominator
 * `computeTestStats().runCount` uses, and the framing audit flags it because
 * `old/issues.html:1060` computes its Issue% over a denominator that *includes*
 * skips — same word, two definitions. Verified against `lib/`: `runCount`
 * there is pass + fail + timeout + crash + expected-fail, skips excluded, so
 * the page's meaning is the one that carried over.
 *
 * ## Why there is one tooltip shared by three badges
 *
 * The fail, crash and timeout badges all carry the *same* text, listing every
 * outcome the cell saw (`old/test.html:2765`). Upstream builds it once and
 * interpolates it into each; reproduced, because hovering the CRASH badge to
 * be told only about crashes would hide that the cell also failed 40 times.
 * The PASS and SKIP badges have their own, narrower tooltips.
 */
function cellBadges(d: Outcomes, skipMessages: Map<string, number>): CellBadge[] {
    const badges: CellBadge[] = [];
    const total = d.passes + d.failures + d.timeouts + d.crashes;
    const issues = d.failures + d.timeouts + d.crashes;

    if (issues > 0) {
        const lines: string[] = [];
        if (d.failures > 0) {
            lines.push(`${d.failures} failure${d.failures !== 1 ? 's' : ''}`);
        }
        if (d.crashes > 0) {
            lines.push(`${d.crashes} crash${d.crashes !== 1 ? 'es' : ''}`);
        }
        if (d.timeouts > 0) {
            lines.push(`${d.timeouts} timeout${d.timeouts !== 1 ? 's' : ''}`);
        }
        if (d.passes > 0) {
            lines.push(`${d.passes} pass${d.passes !== 1 ? 'es' : ''}`);
        }
        lines.push(`${total} total runs`);
        const tooltip = lines.join('\n');

        // Order is fail, crash, timeout — upstream's, and it is severity-ish
        // rather than alphabetical, so it is reproduced rather than sorted.
        if (d.failures > 0) {
            badges.push({
                kind: 'fail',
                label: 'FAIL',
                percentText: `${((d.failures / total) * 100).toFixed(1)}%`,
                tooltip,
            });
        }
        if (d.crashes > 0) {
            badges.push({
                kind: 'crash',
                label: 'CRASH',
                percentText: `${((d.crashes / total) * 100).toFixed(1)}%`,
                tooltip,
            });
        }
        if (d.timeouts > 0) {
            badges.push({
                kind: 'timeout',
                label: 'TIMEOUT',
                percentText: `${((d.timeouts / total) * 100).toFixed(1)}%`,
                tooltip,
            });
        }
    } else if (total > 0) {
        badges.push({
            kind: 'pass',
            label: 'PASS',
            percentText: null,
            tooltip: `${d.passes} run${d.passes !== 1 ? 's' : ''}`,
        });
    }

    if (d.skips > 0) {
        badges.push({
            kind: 'skip',
            label: 'SKIP',
            percentText: null,
            tooltip: skipTooltip(d.skips, skipMessages),
        });
    }

    return badges;
}

/**
 * The SKIP badge's tooltip: the count, then the reasons.
 *
 * `old/test.html:2784`. One message is shown bare; several are listed with their
 * counts, ordered by count descending — the reason a test is most often
 * skipped is the one worth reading first. No messages at all leaves just the
 * count, which happens when the skips recorded no reason.
 */
function skipTooltip(skips: number, messages: Map<string, number>): string {
    const skipCount = `${skips} skip${skips !== 1 ? 's' : ''}`;
    if (messages.size === 1) {
        const [message] = messages.keys();
        return `${skipCount}\n${message!}`;
    }
    if (messages.size > 1) {
        const lines = [...messages.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([message, count]) => `${message} (${count})`)
            .join('\n');
        return `${skipCount}\n${lines}`;
    }
    return skipCount;
}

// --- daily rates ----------------------------------------------------------

/** One day's totals, for the chart. */
export interface DailyRate {
    /** Absolute day index, 0 = oldest. */
    day: number;
    /** `YYYY-MM-DD`. */
    date: string;
    passes: number;
    failures: number;
    timeouts: number;
    crashes: number;
    skips: number;
}

/**
 * The date a day index falls on.
 *
 * `metadata.startTime` is a Unix timestamp in seconds and days are 86,400
 * seconds apart, which is upstream's arithmetic (`old/test.html:1102`) and is
 * correct here because the values are UTC midnights — a local-time calculation
 * would shift by a day either side of a DST boundary.
 */
export function dateOfDay(startTime: number, day: number): string {
    return new Date((startTime + day * 86400) * 1000).toISOString().split('T')[0]!;
}

/**
 * Per-day pass/fail/timeout/crash/skip totals across every configuration.
 *
 * `calculateDailyFailureRates` (`old/test.html:1094`). Two things about it are
 * worth stating because they differ from the rest of the page:
 *
 * **Skips are counted here without the `run-if` filter.** Every other skip
 * count on the page drops `run-if` (`old/test.html:2642`, `common-test-data.js:303`),
 * and this one does not (`old/test.html:1133`). On a **bucket** file that is a
 * distinction without a difference — the 21-day aggregates have already dropped
 * `run-if` skips upstream, which `lib/query/test-stats.ts` documents and
 * `runIfSkipCount` reports as always 0 for an aggregate — and this page only
 * ever reads bucket files. Preserved as upstream wrote it rather than
 * "corrected", because the two agree on every file this page can load and
 * changing it would be an unverifiable claim about a file it never sees.
 *
 * **`UNKNOWN` contributes to nothing.** Upstream's chain has no `else`, so a
 * status matching none of the five prefixes falls out. `classifyStatus` returns
 * `unknown` for exactly those, so the `switch` below drops them the same way.
 */
export function dailyRates(
    file: DecodedTimingFile,
    testId: number,
    options: { days: number; startTime: number }
): DailyRate[] {
    const { days, startTime } = options;
    const rows: DailyRate[] = [];
    for (let day = 0; day < days; day++) {
        rows.push({
            day,
            date: dateOfDay(startTime, day),
            passes: 0,
            failures: 0,
            timeouts: 0,
            crashes: 0,
            skips: 0,
        });
    }

    for (const entry of file.runsOfTest(testId)) {
        if (entry.day === null || entry.day >= days) {
            continue;
        }
        const row = rows[entry.day]!;
        switch (classifyStatus(entry.status).kind) {
            case 'pass':
            case 'expected-fail':
                // `EXPECTED-FAIL` lands in `passes` here for the same reason it
                // does in the job table: upstream's chain tests
                // `status.startsWith('PASS')` first and EXPECTED-FAIL matches
                // none of the five branches, so upstream drops it entirely.
                // See the note below — this is the one place the port and the
                // old page can disagree, and it is measured.
                row.passes += entry.count;
                break;
            case 'fail':
                row.failures += entry.count;
                break;
            case 'timeout':
                row.timeouts += entry.count;
                break;
            case 'crash':
                row.crashes += entry.count;
                break;
            case 'skip':
                row.skips += entry.count;
                break;
            case 'unknown':
                break;
        }
    }
    return rows;
}

/** Whether the chart section is drawn at all, and which of its two charts. */
export interface ChartPresence {
    hasIssues: boolean;
    hasSkips: boolean;
}

/**
 * Which charts the page draws.
 *
 * `old/test.html:2482`. The section appears only when there is something to plot,
 * and each canvas is emitted only if its own series is non-empty — a test that
 * is skipped but never fails gets the skip chart alone, and then that chart
 * keeps its x-axis because there is no failure chart above it to carry one.
 */
export function chartPresence(rates: readonly DailyRate[]): ChartPresence {
    return {
        hasIssues: rates.some((d) => d.failures > 0 || d.timeouts > 0 || d.crashes > 0),
        hasSkips: rates.some((d) => d.skips > 0),
    };
}

// --- issues ---------------------------------------------------------------

/**
 * Re-exported rather than imported through, as this file does for the other
 * shared values its readers and tests expect to find here.
 */
export { CRASH_NO_SIGNATURE, FAILURE_NO_MESSAGE, TIMEOUT_MESSAGE };

/** One row of the Issue Details list: the shared row plus this page's fields. */
export interface Issue extends TestIssue {
    /** `badge-skip`, `badge-fail`, … */
    badgeClass: string;
    /** `issue-0`, …; the prefix of the runs and chart element ids. */
    id: string;
    /**
     * Whether clicking expands a run list. False for SKIP only
     * (`old/test.html:2562`) — a skip has no task IDs to list, because the run
     * never happened.
     */
    expandable: boolean;
    /**
     * The count's tooltip, or `null`. Only FAIL rows get one
     * (`old/test.html:2565`), and it divides by `stats.runCount`, which **excludes
     * skips** — so it reads as a share of runs that happened, not of jobs
     * scheduled.
     */
    countTooltip: string | null;
}

/**
 * The Issue Details list, ordered by count descending.
 *
 * `renderIssueDetails` (`old/test.html:2513`). `buildTestIssues` assembles the
 * rows; this adds the page's badge class, DOM id, click affordance and tooltip.
 */
export function buildIssues(
    file: DecodedTimingFile,
    testId: number,
    stats: TestStats
): Issue[] {
    return buildTestIssues(file, testId, stats).map((issue, index) => ({
        ...issue,
        badgeClass: badgeClassOf(issue.type),
        id: `issue-${index}`,
        expandable: issue.type !== 'SKIP',
        countTooltip:
            issue.type === 'FAIL' && stats.runCount > 0
                ? `${issue.count} ${issue.count === 1 ? 'occurrence' : 'occurrences'} of this ` +
                  `message out of ${stats.runCount.toLocaleString()} runs ` +
                  `(${((issue.count / stats.runCount) * 100).toFixed(2)}%)`
                : null,
    }));
}

/** The badge class for an issue type. */
function badgeClassOf(type: Issue['type']): string {
    switch (type) {
        case 'SKIP':
            return 'badge-skip';
        case 'FAIL':
            return 'badge-fail';
        case 'CRASH':
            return 'badge-crash';
        case 'TIMEOUT':
            return 'badge-timeout';
    }
}

// --- the selection model --------------------------------------------------
//
// Everything below recomputes part of the view for a set of selected cells and
// days. These are the interactions, expressed as pure functions so the filtered
// states are testable without a browser.

/** What is selected right now. Hover and click are unioned before use. */
export interface Selection {
    /** `variant|platform` keys of the cells contributing to the filter. */
    cells: ReadonlySet<string>;
    /** Absolute day indices contributing to the filter. */
    days: ReadonlySet<number>;
}

/** An empty selection — the unfiltered page. */
export const NO_SELECTION: Selection = { cells: new Set(), days: new Set() };

/**
 * Per-day, per-cell outcome counts: the matrix every filtered view reads.
 *
 * `buildDayJobMatrix` (`old/test.html:1877`). Indexed `[day][cellKey]`, and built
 * once because the interactions are hover-driven — recomputing it per mouse
 * move on a test with 21 days and 60 cells would be doing the whole decode
 * again on every frame.
 *
 * `run-if` skips are excluded here (`old/test.html:1920`), matching the job table.
 */
export function buildDayCellMatrix(
    file: DecodedTimingFile,
    testId: number,
    mappings: DisplayMappings,
    options: { days: number }
): Map<string, Outcomes>[] {
    const matrix: Map<string, Outcomes>[] = [];
    for (let day = 0; day < options.days; day++) {
        matrix.push(new Map());
    }

    for (const entry of file.runsOfTest(testId)) {
        if (entry.day === null || entry.day >= options.days) {
            continue;
        }
        const { kind } = classifyStatus(entry.status);
        if (kind === 'unknown') {
            continue;
        }
        if (kind === 'skip' && skipReason(entry.message) === 'run-if') {
            continue;
        }
        const dayMap = matrix[entry.day]!;
        for (const target of targetsOfEntry(file, entry)) {
            const key = cellKey(
                displayVariantOf(mappings, target.jobName),
                displayPlatformOf(mappings, target.jobName)
            );
            let cell = dayMap.get(key);
            if (cell === undefined) {
                cell = emptyOutcomes();
                dayMap.set(key, cell);
            }
            switch (kind) {
                case 'pass':
                case 'expected-fail':
                    cell.passes += target.count;
                    break;
                case 'fail':
                    cell.failures += target.count;
                    break;
                case 'timeout':
                    cell.timeouts += target.count;
                    break;
                case 'crash':
                    cell.crashes += target.count;
                    break;
                case 'skip':
                    cell.skips += target.count;
                    break;
                // No `unknown` case: it is filtered out above, and the
                // exhaustiveness check is what proves the filter is the only
                // place it can be dropped.
            }
        }
    }
    return matrix;
}

/**
 * The (job, count) pairs one entry accounts for.
 *
 * The two attributed shapes name a job directly; the failing shapes name tasks,
 * one run each, and the job has to be resolved through `taskInfo`. Same
 * resolution `lib/query/coverage.ts` does, and the reason a failure's job is
 * per-task rather than per-entry: one bucket can hold retries of more than one
 * job.
 */
function targetsOfEntry(
    file: DecodedTimingFile,
    entry: RunEntry
): { jobName: string; count: number }[] {
    if (entry.jobName !== undefined) {
        return [{ jobName: entry.jobName, count: entry.count }];
    }
    const targets: { jobName: string; count: number }[] = [];
    for (const taskIdIndex of entry.taskIdIndexes ?? []) {
        const jobName = file.jobNameOfTaskIndex(taskIdIndex);
        if (jobName !== null) {
            targets.push({ jobName, count: 1 });
        }
    }
    return targets;
}

/** A cell's outcomes summed over the selected days. */
export function outcomesForDays(
    matrix: readonly Map<string, Outcomes>[],
    key: string,
    days: ReadonlySet<number>
): Outcomes {
    const total = emptyOutcomes();
    for (const day of days) {
        const cell = matrix[day]?.get(key);
        if (cell !== undefined) {
            addOutcomes(total, cell);
        }
    }
    return total;
}

/** What a cell should show once a day filter is applied. */
export interface FilteredCell {
    outcomes: Outcomes;
    /** No runs and no skips on the selected days: the em-dash overlay. */
    noData: boolean;
    /** Runs, but no fail/crash/timeout: the `PASS` prefix overlay may apply. */
    allIssuesHidden: boolean;
    /** Whether the badges layer is hidden behind an overlay. */
    badgesHidden: boolean;
    /** The per-badge state, keyed by badge kind. */
    badges: Map<CellBadge['kind'], { visible: boolean; percentText: string | null; tooltip: string }>;
    /** Whether hovering does nothing in this state. */
    noHover: boolean;
}

/**
 * Recomputes one cell for a day selection.
 *
 * `updateTableHighlight` (`old/test.html:2190`), which mutates the DOM in place;
 * here it is a value, which is what lets a test assert on a filtered cell
 * without a browser.
 *
 * The overlay logic is the fiddly part and is upstream's exactly. Three states
 * a cell can be in once days are selected:
 *
 * | state | what shows |
 * | --- | --- |
 * | nothing ran and nothing was skipped | the em-dash overlay, badges hidden |
 * | ran, passed, had issues on *other* days | the `PASS` prefix overlay, badges hidden |
 * | anything else | the badges, each shown or hidden on its own count |
 *
 * The second row is why `hasPassPrefixLayer` exists on the unfiltered cell: the
 * overlay element has to be in the DOM from the start, because the filter only
 * toggles `display`. A cell that never had an issue has no such element, and
 * then a day filter leaving it pass-only simply shows its ordinary PASS badge
 * — which is the "For pass-only or skip-only cells (no prefix), layer stays
 * visible" case upstream comments at `:2234`.
 */
export function filteredCell(
    cell: JobCell,
    matrix: readonly Map<string, Outcomes>[],
    days: ReadonlySet<number>
): FilteredCell {
    const f = outcomesForDays(matrix, cell.key, days);
    const total = f.passes + f.failures + f.timeouts + f.crashes;
    const allIssuesHidden = f.failures === 0 && f.crashes === 0 && f.timeouts === 0;
    const noData = total === 0 && f.skips === 0;

    const badges = new Map<
        CellBadge['kind'],
        { visible: boolean; percentText: string | null; tooltip: string }
    >();
    for (const badge of cell.badges) {
        if (badge.kind === 'pass') {
            badges.set('pass', {
                visible: f.passes > 0,
                percentText: null,
                tooltip: `${f.passes} run${f.passes !== 1 ? 's' : ''}`,
            });
        } else if (badge.kind === 'skip') {
            badges.set('skip', {
                visible: f.skips > 0,
                percentText: null,
                tooltip: `${f.skips} skip${f.skips !== 1 ? 's' : ''}`,
            });
        } else {
            const count =
                badge.kind === 'fail'
                    ? f.failures
                    : badge.kind === 'crash'
                      ? f.crashes
                      : f.timeouts;
            badges.set(badge.kind, {
                visible: count > 0,
                // Upstream recomputes the percentage only when the badge is
                // visible and leaves the stale text in place otherwise
                // (`old/test.html:2253`). Since the badge is hidden either way,
                // the value is unobservable; `null` says so rather than
                // preserving a number nobody can see.
                percentText:
                    count > 0
                        ? `${(total > 0 ? (count / total) * 100 : 0).toFixed(1)}%`
                        : null,
                tooltip: badge.tooltip,
            });
        }
    }

    return {
        outcomes: f,
        noData,
        allIssuesHidden,
        badgesHidden: noData || (cell.hasPassPrefixLayer && allIssuesHidden),
        badges,
        // Upstream's `hasVisibleIssues` (`old/test.html:2263`) — note it counts
        // skips, so a skip-only cell stays hoverable while a pass-only one does
        // not.
        noHover: !(f.failures > 0 || f.crashes > 0 || f.timeouts > 0 || f.skips > 0),
    };
}

/**
 * Per-issue day and cell attribution, for filtering the issue list.
 *
 * `buildIssueFilterData` (`old/test.html:1959`). For each issue, how many
 * occurrences fell on each day, in each cell, and in each (day, cell) pair —
 * the third is not derivable from the first two, which is why it is stored:
 * "3 on Monday" and "3 on linux" do not tell you whether the Monday ones were
 * the linux ones.
 */
export interface IssueAttribution {
    byDay: Map<number, number>;
    byCell: Map<string, number>;
    byDayCell: Map<number, Map<string, number>>;
}

/** Builds the attribution for every issue, parallel to the issue list. */
export function buildIssueAttribution(
    file: DecodedTimingFile,
    testId: number,
    issues: readonly Issue[],
    mappings: DisplayMappings,
    options: { days: number }
): IssueAttribution[] {
    const result: IssueAttribution[] = issues.map(() => ({
        byDay: new Map(),
        byCell: new Map(),
        byDayCell: new Map(),
    }));

    for (const entry of file.runsOfTest(testId)) {
        if (entry.day === null || entry.day >= options.days) {
            continue;
        }
        const day = entry.day;
        for (const [index, issue] of issues.entries()) {
            if (!entryMatchesIssue(entry, issue)) {
                continue;
            }
            const attribution = result[index]!;
            for (const target of targetsOfEntry(file, entry)) {
                const key = cellKey(
                    displayVariantOf(mappings, target.jobName),
                    displayPlatformOf(mappings, target.jobName)
                );
                attribution.byDay.set(day, (attribution.byDay.get(day) ?? 0) + target.count);
                attribution.byCell.set(key, (attribution.byCell.get(key) ?? 0) + target.count);
                let cells = attribution.byDayCell.get(day);
                if (cells === undefined) {
                    cells = new Map();
                    attribution.byDayCell.set(day, cells);
                }
                cells.set(key, (cells.get(key) ?? 0) + target.count);
            }
        }
    }
    return result;
}

/**
 * Whether one run entry is an occurrence of one issue.
 *
 * `matchesEntry` (`old/test.html:1988`). The three message-bearing types compare
 * their display text; TIMEOUT matches any timeout entry, because the whole
 * timeout count is one issue row.
 *
 * The synthetic rows match on *absence*: `FAILURE_NO_MESSAGE` matches a
 * failure whose message is empty or missing, and `CRASH_NO_SIGNATURE` a crash
 * with no signature. That is what makes their counts filterable at all.
 */
function entryMatchesIssue(entry: RunEntry, issue: Issue): boolean {
    const { kind } = classifyStatus(entry.status);
    switch (issue.type) {
        case 'TIMEOUT':
            return kind === 'timeout';
        case 'SKIP': {
            if (kind !== 'skip') {
                return false;
            }
            const clean = entry.message ? displaySkipMessage(entry.message) : '';
            return issue.message === FAILURE_NO_MESSAGE ? clean === '' : clean === issue.message;
        }
        case 'FAIL': {
            if (kind !== 'fail') {
                return false;
            }
            // Upstream applies no `skip-if:` strip on the FAIL branch — the
            // `clean` it compares is the raw message (`old/test.html:1993`).
            const message = entry.message ?? '';
            return issue.message === FAILURE_NO_MESSAGE ? message === '' : message === issue.message;
        }
        case 'CRASH': {
            if (kind !== 'crash') {
                return false;
            }
            const signature = entry.crashSignature ?? null;
            return signature === null
                ? issue.message === CRASH_NO_SIGNATURE
                : signature === issue.message;
        }
    }
}

/** One issue's state under the current selection. */
export interface FilteredIssue {
    /** Whether the row is shown at all. */
    visible: boolean;
    /** The number the count span shows — filtered when filtering, else the total. */
    count: number;
}

/**
 * The issue list under a selection.
 *
 * `updateIssueListFilter` (`old/test.html:2273`). With both a day and a cell filter
 * the counts come from `byDayCell`, which is the intersection; with one filter
 * they come from that filter's own map. An issue with no occurrences in the
 * selection is hidden, and a hidden row shows its **unfiltered** count
 * (`old/test.html:2346`) — because zero, next to a badge, reads as "this never
 * happened" rather than "not in this selection".
 */
export function filterIssues(
    issues: readonly Issue[],
    attribution: readonly IssueAttribution[],
    selection: Selection
): FilteredIssue[] {
    const hasDays = selection.days.size > 0;
    const hasCells = selection.cells.size > 0;
    if (!hasDays && !hasCells) {
        return issues.map((issue) => ({ visible: true, count: issue.count }));
    }

    return issues.map((issue, index) => {
        const info = attribution[index];
        if (info === undefined) {
            return { visible: true, count: issue.count };
        }
        let filtered = 0;
        if (hasDays && hasCells) {
            for (const day of selection.days) {
                const cells = info.byDayCell.get(day);
                if (cells === undefined) {
                    continue;
                }
                for (const cell of selection.cells) {
                    filtered += cells.get(cell) ?? 0;
                }
            }
        } else if (hasDays) {
            for (const day of selection.days) {
                filtered += info.byDay.get(day) ?? 0;
            }
        } else {
            for (const cell of selection.cells) {
                filtered += info.byCell.get(cell) ?? 0;
            }
        }
        const visible = filtered > 0;
        return { visible, count: visible ? filtered : issue.count };
    });
}

/**
 * The `— 3 of 17 shown (2026-08-01, opt-xpcshell on Linux)` notice.
 *
 * `old/test.html:2372`. Dates collapse to a range once there are more than three,
 * and cells collapse to a count once there is more than one — the notice has to
 * fit on the `Issue Details` heading line, and a list of nine job names does
 * not.
 */
export function issueFilterNotice(
    visibleCount: number,
    totalCount: number,
    selection: Selection,
    rates: readonly DailyRate[],
    harness: string
): string | null {
    if (selection.days.size === 0 && selection.cells.size === 0) {
        return null;
    }
    const parts: string[] = [];
    if (selection.days.size > 0) {
        const dates = [...selection.days]
            .sort((a, b) => a - b)
            .map((d) => rates[d]?.date)
            .filter((date): date is string => Boolean(date));
        if (dates.length === 1) {
            parts.push(dates[0]!);
        } else if (dates.length > 1 && dates.length <= 3) {
            parts.push(dates.join(', '));
        } else if (dates.length > 3) {
            parts.push(`${dates[0]!} – ${dates[dates.length - 1]!}`);
        }
    }
    if (selection.cells.size > 0) {
        if (selection.cells.size === 1) {
            const [key] = selection.cells;
            const { variant, platform } = splitCellKey(key!);
            parts.push(`${variantLabel(variant, harness)} on ${platform}`);
        } else {
            parts.push(`${selection.cells.size} jobs`);
        }
    }
    return (
        `— ${visibleCount} of ${totalCount} shown` +
        (parts.length > 0 ? ` (${parts.join(', ')})` : '')
    );
}

// --- durations ------------------------------------------------------------

/** Duration statistics for the runtime panel. */
export interface DurationStats {
    count: number;
    min: number;
    max: number;
    avg: number;
    median: number;
    p90: number;
    p95: number;
}

/**
 * A percentile by linear interpolation on a pre-sorted array.
 *
 * `computePercentile` (`old/test.html:1660`). Interpolating rather than
 * nearest-rank, which differs from `cli/commands/test.ts`'s `quantile()` — that
 * one takes `ceil(q * n)`. Both are defensible and they disagree by up to one
 * sample; this one is reproduced because it is what the panel shows today, and
 * the two are not compared anywhere.
 */
export function computePercentile(sorted: readonly number[], p: number): number {
    if (sorted.length === 0) {
        return 0;
    }
    if (sorted.length === 1) {
        return sorted[0]!;
    }
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) {
        return sorted[lower]!;
    }
    return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

/** The six numbers the runtime panel shows. `null` for no durations. */
export function computeDurationStats(durations: readonly number[]): DurationStats | null {
    if (durations.length === 0) {
        return null;
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
        count: sorted.length,
        min: sorted[0]!,
        max: sorted[sorted.length - 1]!,
        avg: sum / sorted.length,
        median: computePercentile(sorted, 50),
        p90: computePercentile(sorted, 90),
        p95: computePercentile(sorted, 95),
    };
}

/**
 * Every passing run's duration, overall and per cell.
 *
 * `collectAllDurations` (`old/test.html:1618`) plus `buildCellDurationMap`
 * (`:1647`). Only pass-like statuses carry durations — upstream filters to
 * `PASS*`/`OK`/`EXPECTED-FAIL` explicitly, and `classifyStatus` gives the same
 * three kinds — so the panel's "N passing runs" is literal.
 */
export function collectDurations(
    file: DecodedTimingFile,
    testId: number,
    mappings: DisplayMappings
): { all: number[]; byCell: Map<string, number[]> } {
    const all: number[] = [];
    const byCell = new Map<string, number[]>();

    for (const entry of file.runsOfTest(testId)) {
        const { kind } = classifyStatus(entry.status);
        if (kind !== 'pass' && kind !== 'expected-fail') {
            continue;
        }
        if (entry.durations === undefined || entry.jobName === undefined) {
            continue;
        }
        const key = cellKey(
            displayVariantOf(mappings, entry.jobName),
            displayPlatformOf(mappings, entry.jobName)
        );
        let list = byCell.get(key);
        if (list === undefined) {
            list = [];
            byCell.set(key, list);
        }
        for (const duration of entry.durations) {
            all.push(duration);
            list.push(duration);
        }
    }
    return { all, byCell };
}

/** Bin counts for the runtime histogram. `computeHistogramBins` (`:1687`). */
export function computeHistogramBins(
    durations: readonly number[],
    numBins: number,
    min: number,
    max: number
): number[] {
    const binWidth = (max - min) / numBins;
    const bins = new Array<number>(numBins).fill(0);
    for (const d of durations) {
        let bin = Math.floor((d - min) / binWidth);
        if (bin >= numBins) {
            bin = numBins - 1;
        }
        if (bin < 0) {
            bin = 0;
        }
        bins[bin]! += 1;
    }
    return bins;
}

/**
 * A duration in milliseconds, as the panel and the histogram write it.
 *
 * `formatDurationMs` (`old/test.html:552`). An em-dash for no data, and units that
 * change with magnitude so a 4-hour run does not read as `14400000ms`. The
 * `ms === 0` case is an em-dash too, which is upstream's — a run recorded as
 * taking zero milliseconds is a measurement that did not happen.
 *
 * The body moved to `lib/model/duration.ts`, which `issues.html`,
 * `xpcshell-timings.html` and this page's original all held byte-identical
 * copies of. It is re-exported here rather than imported at each use site
 * because this module's own callers refer to it by this name; the behaviour is
 * unchanged, checked over every integer millisecond from `0` to three days.
 */
export { formatDurationMs };

/** One bar of the runtime histogram. */
export interface HistogramBar {
    /** Background height as a percentage — the overall distribution. */
    backgroundPercent: number;
    /** Foreground height as a percentage — the selected subset. */
    foregroundPercent: number;
    /** Whether each layer is drawn at all. */
    hasBackground: boolean;
    hasForeground: boolean;
    /** `1.2s – 1.4s: 37 runs`. */
    tooltip: string;
}

/** The histogram, or `null` when it cannot be drawn. */
export interface Histogram {
    bars: HistogramBar[];
    /** The three axis labels: min, midpoint, max. */
    labels: [string, string, string];
}

/**
 * The runtime histogram for a set of durations.
 *
 * `generateHistogram` (`old/test.html:1700`). Two layers: a grey background showing
 * the *overall* distribution and a blue foreground showing the selection's, both
 * scaled to the background's tallest bin. That shared scale is what makes the
 * selected subset legible as a subset — scaling each to its own maximum would
 * make every selection look the same shape.
 *
 * `null` when the range is degenerate (`min === max`, so every run took the
 * same time and there is nothing to distribute) or when the background is
 * empty. A visible bin gets at least 1% height so a single run does not
 * disappear.
 */
export function buildHistogram(
    durations: readonly number[],
    options: {
        numBins?: number;
        rangeMin?: number | null;
        rangeMax?: number | null;
        overallBins?: readonly number[] | null;
    } = {}
): Histogram | null {
    const numBins = options.numBins ?? 20;
    const overallBins = options.overallBins ?? null;
    if (durations.length === 0 && overallBins === null) {
        return null;
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const min = options.rangeMin ?? sorted[0];
    const max = options.rangeMax ?? sorted[sorted.length - 1];
    if (min === undefined || max === undefined || min === max) {
        return null;
    }

    const fgBins = computeHistogramBins(durations, numBins, min, max);
    const bgBins = overallBins ?? fgBins;
    const bgMax = Math.max(...bgBins);
    if (bgMax === 0) {
        return null;
    }

    const binWidth = (max - min) / numBins;
    const bars: HistogramBar[] = [];
    for (let i = 0; i < numBins; i++) {
        const bg = bgBins[i] ?? 0;
        const fg = fgBins[i] ?? 0;
        const binStart = min + i * binWidth;
        bars.push({
            backgroundPercent: Math.max((bg / bgMax) * 100, 1),
            foregroundPercent: Math.max((fg / bgMax) * 100, 1),
            hasBackground: bg > 0,
            hasForeground: fg > 0,
            tooltip:
                `${formatDurationMs(binStart)} – ${formatDurationMs(binStart + binWidth)}: ` +
                `${fg} run${fg !== 1 ? 's' : ''}`,
        });
    }

    return {
        bars,
        labels: [
            formatDurationMs(min),
            formatDurationMs((min + max) / 2),
            formatDurationMs(max),
        ],
    };
}

/** The runtime panel's contents for one selection. */
export interface RuntimePanel {
    /** `Overall`, `opt-xpcshell on Linux`, or `3 selected cells`. */
    title: string;
    /** `1,234 passing runs`. */
    subtitle: string;
    /** The six labelled figures, in display order. */
    items: { label: string; value: string }[];
    histogram: Histogram | null;
}

/** The six figures' labels and order. `old/test.html:1751`. */
const RUNTIME_ITEMS: [string, keyof DurationStats][] = [
    ['Min', 'min'],
    ['Avg', 'avg'],
    ['Median', 'median'],
    ['P90', 'p90'],
    ['P95', 'p95'],
    ['Max', 'max'],
];

/**
 * The runtime panel for a title and a set of durations.
 *
 * `renderRuntimePanelContent` (`old/test.html:1739`). `null` when there are no
 * durations at all, and the page then says "No duration data" — which is a
 * different thing from a panel of zeroes.
 */
export function buildRuntimePanel(
    title: string,
    durations: readonly number[],
    options: {
        overallRange?: { min: number; max: number } | null;
        overallBins?: readonly number[] | null;
    } = {}
): RuntimePanel | null {
    const stats = computeDurationStats(durations);
    if (stats === null) {
        return null;
    }
    return {
        title,
        subtitle: `${stats.count.toLocaleString()} passing runs`,
        items: RUNTIME_ITEMS.map(([label, key]) => ({
            label,
            value: formatDurationMs(stats[key]),
        })),
        histogram: buildHistogram(durations, {
            rangeMin: options.overallRange?.min ?? null,
            rangeMax: options.overallRange?.max ?? null,
            overallBins: options.overallBins ?? null,
        }),
    };
}

/**
 * The runtime panel's title for a cell selection.
 *
 * `updateRuntimeForSelection` (`old/test.html:2424`). One cell is named; several
 * are counted, because six job names do not fit in a 420px panel header.
 */
export function runtimeTitleFor(cells: ReadonlySet<string>, harness: string): string {
    if (cells.size === 0) {
        return 'Overall';
    }
    if (cells.size === 1) {
        const [key] = cells;
        const { variant, platform } = splitCellKey(key!);
        return `${variantLabel(variant, harness)} on ${platform}`;
    }
    return `${cells.size} selected cells`;
}

// --- the summary bar ------------------------------------------------------

/** One figure in the summary bar. */
export interface SummaryStat {
    label: string;
    value: string;
    /** The colour class, or `''` for the default. */
    cssClass: string;
}

/**
 * The `Pass %` figure, rounded once from the ratio.
 *
 * `common-test-data.js:350` computes `Math.round((passCount / totalRunCount) *
 * 10000) / 100` — **one** rounding, applied to the undivided ratio.
 * `stats.passRate` is that ratio already multiplied by 100
 * (`lib/query/test-stats.ts:164`), so recovering it means dividing by 100
 * again rather than rounding what is left.
 *
 * That distinction is not pedantry, it is a visible digit. Rounding the
 * already-scaled `passRate` a second time — `Math.round(passRate * 100) / 100`
 * — rounds a value that has already lost precision to the first multiply, and
 * the two disagree on **90 of the 2,001,000 `(pass, run)` pairs with
 * `run <= 2000`**, always by one hundredth downward:
 *
 * ```
 * 23/160   old 14.38%   double-rounded 14.37%
 * 41/160   old 25.63%   double-rounded 25.62%
 * 29/800   old  3.63%   double-rounded  3.62%
 * 87/160   old 54.38%   double-rounded 54.37%
 * ```
 *
 * 160 runs is an ordinary count for this page — the pinned snapshot's tests
 * range from 23 to 28,568 runs — so this is reachable, not theoretical. It
 * happens not to fire on any of the snapshot's 786 distinct `(pass, run)`
 * pairs, which is why a fixture-only test could not catch it and why
 * `test/test-view.test.ts` drives the counts directly.
 *
 * Shared with `healthy` below so the favicon and the headline figure cannot
 * round differently.
 */
function passPercentageOf(stats: TestStats): number {
    if (stats.passRate === null) {
        return 0;
    }
    // `passRate / 100` is the ratio; `* 10000` then `/ 100` is upstream's
    // single rounding to two decimals, kept in that shape so the two can be
    // compared by eye.
    return Math.round((stats.passRate / 100) * 10000) / 100;
}

/**
 * The six figures above the chart.
 *
 * `old/test.html:2471`. The colour rules are upstream's and each says something:
 * a 100% pass rate is green, below 90% is red, and a zero count is grey rather
 * than black so that a row of zeroes reads as "nothing here" at a glance.
 *
 * **`passPercentage` counts `EXPECTED-FAIL` as a pass.** `computeTestStats` in
 * `common-test-data.js` folds it into `passCount` (it matches none of the
 * `isFail` exclusions and falls through to the `else`), and `lib/`'s splits it
 * out into `expectedFailCount` while keeping it in `runCount` and in
 * `passRate`'s numerator. So `stats.passRate` is already the old page's
 * `passPercentage` — verified equal on 775 tests — and the addition below is
 * only for the `Runs`/pass-count relationship the label implies.
 */
export function summaryStats(stats: TestStats): SummaryStat[] {
    const passPercentage = passPercentageOf(stats);
    return [
        {
            label: 'Runs',
            value: formatCount(stats.runCount),
            cssClass: stats.runCount === 0 ? 'zero' : '',
        },
        {
            label: 'Pass %',
            value: `${passPercentage}%`,
            cssClass: passPercentage === 100 ? 'good' : passPercentage < 90 ? 'fail' : '',
        },
        {
            label: 'Failures',
            value: formatCount(stats.failCount),
            cssClass: stats.failCount > 0 ? 'fail' : 'zero',
        },
        {
            label: 'Timeouts',
            value: formatCount(stats.timeoutCount),
            cssClass: stats.timeoutCount > 0 ? 'timeout' : 'zero',
        },
        {
            label: 'Crashes',
            value: formatCount(stats.crashCount),
            cssClass: stats.crashCount > 0 ? 'fail' : 'zero',
        },
        {
            label: 'Skips',
            value: formatCount(stats.skipCount),
            cssClass: stats.skipCount > 0 ? 'skip' : 'zero',
        },
    ];
}

/**
 * `formatNumber` (`common-ui.js:18`), which is `toLocaleString()`.
 *
 * Reimplemented here rather than read off the global for the same reason
 * `PLATFORM_DISPLAY_NAMES` is: the view model has to be importable by a node
 * test, and `common-ui.js` is a browser script. It is one call.
 */
export function formatCount(value: number): string {
    return value.toLocaleString();
}

// --- the whole page -------------------------------------------------------

/** Everything the page draws for a found test, derived once. */
export interface TestView {
    /** The full path, as given. */
    testPath: string;
    /** The filename — the `<h1>`. */
    testName: string;
    /** The harness the data was actually found under. */
    harness: string;
    /** Bugzilla component, or `null`. */
    component: string | null;
    /** `https://searchfox.org/...`. */
    searchfoxUrl: string;
    /** `21 days (2026-07-15 to 2026-08-04)`, or `''`. */
    dateRangeText: string;
    /** The date phrase in the job table's heading, or `''`. */
    jobTableDateInfo: string;
    /** `test_foo.js - Test Info` — the `document.title`. */
    documentTitle: string;
    stats: TestStats;
    summary: SummaryStat[];
    rates: DailyRate[];
    charts: ChartPresence;
    jobTable: JobTable;
    issues: Issue[];
    mappings: DisplayMappings;
    /** Whether the favicon is drawn green. `old/test.html:3112`. */
    healthy: boolean;
}

/** Metadata the view needs from the file, already read off it. */
export interface TestViewMetadata {
    days: number;
    startTime: number;
    startDate?: string | undefined;
    endDate?: string | undefined;
    /** A daily file's single date. Bucket files have none. */
    date?: string | undefined;
}

/**
 * Builds the whole view for a test that was found.
 *
 * The section order is fixed and is upstream's (`old/test.html:2452-2504`): header,
 * status line, summary stats, Daily Issue Rates, job table with the runtime
 * panel beside it, Issue Details. The framing audit lists it because a
 * rearrangement would be invisible to a value diff and would change what the
 * page leads with.
 */
export function buildTestView(
    file: DecodedTimingFile,
    options: {
        testId: number;
        testPath: string;
        component: string | null;
        harness: string;
        stats: TestStats;
        metadata: TestViewMetadata;
    }
): TestView {
    const { testId, testPath, stats, metadata } = options;
    // In the page's own walk order, not `coverageOf`'s sorted order: a tie in
    // the row sort is broken by this. See `coverageInPageOrder`.
    const configs = coverageInPageOrder(file, testId);
    const mappings = computeDisplayMappings(configs);
    const rates = dailyRates(file, testId, {
        days: metadata.days,
        startTime: metadata.startTime,
    });

    return {
        testPath,
        testName: testPath.split('/').pop() ?? testPath,
        harness: options.harness,
        component: options.component,
        searchfoxUrl: `https://searchfox.org/mozilla-central/source/${testPath}`,
        dateRangeText:
            metadata.startDate && metadata.endDate
                ? `${metadata.days} days (${metadata.startDate} to ${metadata.endDate})`
                : '',
        jobTableDateInfo: jobTableDateInfo(metadata),
        documentTitle: `${testPath.split('/').pop() ?? testPath} - Test Info`,
        stats,
        summary: summaryStats(stats),
        rates,
        charts: chartPresence(rates),
        jobTable: buildJobTable(configs, mappings),
        issues: buildIssues(file, testId, stats),
        mappings,
        // Upstream: `stats.passPercentage === 100 ? green : orange`
        // (`old/test.html:3112`). A test with no runs at all has a pass rate of 0
        // and therefore an orange favicon, which is upstream's behaviour and is
        // arguably right — a test that never ran is not healthy.
        healthy: passPercentageOf(stats) === 100,
    };
}

/**
 * The parenthesised date phrase in the job table's heading.
 *
 * `old/test.html:2702`. Prefers the aggregate's range and falls back to a daily
 * file's single date, which is the only place the page acknowledges that a
 * non-bucket file could be loaded.
 */
function jobTableDateInfo(metadata: TestViewMetadata): string {
    if (metadata.startDate && metadata.endDate) {
        return `${metadata.days} days, ${metadata.startDate} to ${metadata.endDate}`;
    }
    return metadata.date ?? '';
}
