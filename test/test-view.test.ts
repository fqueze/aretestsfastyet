/**
 * `test.html`'s view model, against the checked-in bucket fixtures.
 *
 * ## Why this imports from `site/`
 *
 * `site/test-view.ts` is **page-local** — it names cell keys, badge classes and
 * column headers, so it is the page's, not `lib/`'s. A node test importing it
 * is the point: the seam is the module boundary, not the directory.
 *
 * The import also enforces the DOM-free rule for free. The root tsconfig
 * compiles `test/**` and has **no DOM lib**, so a `document` reach from the
 * view model is a compile error here even though `tsconfig.site.json` would
 * accept it.
 *
 * ## What these tests are for, and the trap they are written to avoid
 *
 * The crash-viewer review found that **three of five surviving mutants were
 * tests deriving their expected value from the thing under test**. A test that
 * says `assert.equal(view.total, sumOf(view.parts))` passes for any consistent
 * wrong answer, and is worse than no test because it reads like coverage.
 *
 * So the rule here is: **every expected value is either a literal, or computed
 * from the raw fixture by a path that does not go through the code under
 * test.** Where a number is a literal it was read off the fixture with a
 * separate script and is stated with the reasoning that fixes it.
 *
 * The rendering is not tested here. `site/test.ts` turns these structures into
 * elements and nothing else; asserting on that in node needs a DOM shim that is
 * itself a second implementation of the browser. It is verified where it runs:
 * both pages loaded in Chrome against one pinned snapshot and compared node for
 * node, plus the same interaction sequence driven through both (`PARITY.md` §4).
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { type BucketFile, decodeBucket } from '../lib/formats/buckets.ts';
import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import { detectHarness, otherHarness } from '../lib/model/harness.ts';
import { coverageOf } from '../lib/query/coverage.ts';
import { computeTestStats } from '../lib/query/test-stats.ts';
import {
    type Issue,
    type Outcomes,
    CRASH_NO_SIGNATURE,
    FAILURE_NO_MESSAGE,
    buildDayCellMatrix,
    buildHistogram,
    buildIssueAttribution,
    buildIssues,
    buildJobTable,
    buildRuntimePanel,
    buildTestView,
    cellKey,
    chartPresence,
    collectDurations,
    computeDisplayMappings,
    computeDurationStats,
    computeHistogramBins,
    computePercentile,
    dailyRates,
    dateOfDay,
    displayPlatformOf,
    displayVariantOf,
    emptyOutcomes,
    extractDetailedPlatform,
    extractPlatform,
    extractVariant,
    filterIssues,
    filteredCell,
    formatDurationMs,
    issueFilterNotice,
    outcomeSignature,
    platformDisplayName,
    runtimeTitleFor,
    splitCellKey,
    summaryStats,
    variantLabel,
} from '../site/test-view.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

function fixture(name: string): BucketFile {
    return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as BucketFile;
}

const XPCSHELL = fixture('xpcshell-00.json');
const MOCHITEST = fixture('mochitest-00.json');

function decoded(file: BucketFile): DecodedTimingFile {
    return decodeBucket(file);
}

/** A test's index in a fixture, by path. Fails loudly if the fixture changed. */
function testIdOf(file: BucketFile, path: string): number {
    const identity = decodeBucket(file).findTest(path);
    assert.notEqual(identity, null, `${path} is not in the fixture any more`);
    return identity!.testId;
}

/**
 * The raw status totals for a test, read straight off the fixture's arrays.
 *
 * **Deliberately not using anything from `lib/` or `site/`.** This is the
 * independent path the expected values below are derived from: if the decoder
 * and the view model were both wrong in the same way, comparing them to each
 * other would agree and comparing them to this would not.
 */
function rawTotals(file: BucketFile, testId: number): Map<string, number> {
    const totals = new Map<string, number>();
    const groups = file.testRuns[testId] ?? [];
    for (let statusId = 0; statusId < groups.length; statusId++) {
        const group = groups[statusId] as Record<string, unknown> | null | undefined;
        if (!group) {
            continue;
        }
        const status = file.tables.statuses[statusId]!;
        let count = 0;
        if (Array.isArray(group['counts'])) {
            count = (group['counts'] as number[]).reduce((a, b) => a + b, 0);
        } else if (Array.isArray(group['durations'])) {
            count = (group['durations'] as number[][]).reduce((a, b) => a + b.length, 0);
        } else if (Array.isArray(group['taskIdIds'])) {
            count = (group['taskIdIds'] as number[][]).reduce((a, b) => a + b.length, 0);
        }
        totals.set(status, (totals.get(status) ?? 0) + count);
    }
    return totals;
}

// --- the harness rule ----------------------------------------------------

test('detectHarness follows every branch of the shared rule, hole included', () => {
    // Literals, from `common-test-data.js:9`. The last two are the hole: a
    // mochitest-plain `test_*.js` is called xpcshell, and anything unrecognized
    // is too — which is why the page retries the other harness.
    assert.equal(detectHarness('browser/base/content/test/browser_foo.js'), 'mochitest');
    assert.equal(detectHarness('dom/media/test/test_playback.html'), 'mochitest');
    assert.equal(detectHarness('netwerk/test/unit/test_cookies.js'), 'xpcshell');
    assert.equal(detectHarness('dom/plain/test_thing.js'), 'xpcshell');
    assert.equal(detectHarness('some/dir/browser_foo.html'), 'xpcshell');
    assert.equal(detectHarness('no_prefix_at_all.js'), 'xpcshell');
    // No slash at all: `split('/').pop()` gives the whole string.
    assert.equal(detectHarness('browser_x.js'), 'mochitest');

    assert.equal(otherHarness('xpcshell'), 'mochitest');
    assert.equal(otherHarness('mochitest'), 'xpcshell');
});

// --- variant and platform naming -----------------------------------------

test('extractVariant applies the sanitizer, artifact and chunk rules', () => {
    // The three examples upstream documents (`old/test.html:585-587`), as literals.
    assert.equal(extractVariant('test-linux1804-64-asan/opt-xpcshell-1'), 'asan-xpcshell');
    assert.equal(
        extractVariant('test-linux1804-64-artifact/opt-xpcshell-1'),
        'artifact-opt-xpcshell'
    );
    assert.equal(extractVariant('test-linux1804-64/opt-xpcshell-1'), 'opt-xpcshell');

    // A sanitizer *replaces* the build type; artifact *prepends*. Both matter:
    // an asan build is not an opt build with a flag, while opt and debug
    // artifact builds both exist and must stay distinguishable.
    assert.equal(extractVariant('test-linux2404-64-tsan/opt-mochitest'), 'tsan-mochitest');
    assert.equal(extractVariant('test-linux2404-64-ccov/debug-xpcshell'), 'ccov-xpcshell');
    assert.equal(
        extractVariant('test-linux2404-64-artifact/debug-mochitest'),
        'artifact-debug-mochitest'
    );

    // Only a trailing run of digits is a chunk. `-no-nv` and `-swr` are config
    // variants and survive; `-25h2` is part of a platform, before the slash.
    assert.equal(extractVariant('test-win/opt-mochitest-browser-chrome-swr'), 'opt-mochitest-browser-chrome-swr');
    assert.equal(extractVariant('test-windows11-64-25h2/opt-xpcshell'), 'opt-xpcshell');

    // No slash: the whole name is the variant, chunk stripped.
    assert.equal(extractVariant('standalone-name-3'), 'standalone-name');
});

test('extractPlatform returns the literal "unknown", not null, when it cannot tell', () => {
    // The value matters because it becomes a *column header*: `null` would
    // vanish from the table, `'unknown'` is a visible column. This is where
    // it differs from `lib/model/job-name.ts`'s `operatingSystem()`.
    assert.equal(extractPlatform('completely-unrecognized'), 'unknown');
    assert.equal(extractDetailedPlatform('completely-unrecognized'), 'unknown');

    assert.equal(extractPlatform('test-linux2404-64/opt-xpcshell'), 'linux');
    assert.equal(extractPlatform('test-windows11-32-25h2/debug-mochitest'), 'windows');
    assert.equal(extractPlatform('test-macosx1015-64-qr/opt-mochitest'), 'mac');
    // Android is checked against the WHOLE name and wins over everything.
    assert.equal(extractPlatform('test-android-em-14-x86_64/opt-xpcshell'), 'android');
});

test('extractDetailedPlatform never splits android or unknown by bitness', () => {
    // `android-em-14-x86_64` contains `-x86_64`, so a naive rule would produce
    // `android-64`, which is not a platform anyone runs.
    assert.equal(extractDetailedPlatform('test-android-em-14-x86_64/opt-xpcshell'), 'android');
    assert.equal(extractDetailedPlatform('test-android-hw-a55-14-0-aarch64/opt-mochitest'), 'android');

    assert.equal(extractDetailedPlatform('test-windows11-32-25h2/debug-mochitest'), 'windows-32');
    assert.equal(extractDetailedPlatform('test-windows11-64-25h2/debug-mochitest'), 'windows-64');
    assert.equal(extractDetailedPlatform('test-macosx1470-64-aarch64/opt-mochitest'), 'mac-aarch64');
    // Bitness is read from the part BEFORE the slash. A suite name ending in
    // `-64` must not be mistaken for one.
    assert.equal(extractDetailedPlatform('test-linux2404/opt-mochitest-64'), 'linux');
});

test('bitness comes from the prefix, and the -32 test must OVERRIDE a -64 prefix', () => {
    // MEASURED: mutating `prefix` to the whole job name survived the `-32`
    // arm of the rule, and the reason is worth writing down because it is not
    // "no test used -32".
    //
    // The three tests run in order aarch64, then -32, then -64. Every real
    // `-32` job name has `-32` in its PREFIX (`test-windows11-32-25h2/...`),
    // so the prefix and the whole name agree and the mutation is invisible
    // there. The `-32` arm only diverges when the SUFFIX carries `-32` while
    // the prefix carries a different bitness — and then it diverges loudly,
    // because `-32` is tested BEFORE `-64` and therefore wins.
    //
    // Measured over the 666 distinct job names in the pinned snapshot plus the
    // two fixtures: 140 names distinguish prefix-from-whole-name, ALL of them
    // through the `-64`/`-aarch64` arms (`test-linux2404-64/...` → `linux-64`
    // vs `linux`), and 0 through `-32`. So this case is constructed rather
    // than sampled, and the comment says so.
    //
    // It is not hypothetical: a suite named `mochitest-32` on a 64-bit
    // platform would be silently filed under a `Win 32`/`Linux 32` column that
    // no such job ran in.
    assert.equal(extractDetailedPlatform('test-linux2404-64/opt-mochitest-32'), 'linux-64');
    assert.equal(extractDetailedPlatform('test-windows11-64-25h2/opt-mochitest-32'), 'windows-64');
    // Same shape one arm up: an aarch64 prefix is not overridden by a -32
    // suffix either.
    assert.equal(
        extractDetailedPlatform('test-macosx1500-aarch64/opt-mochitest-32'),
        'mac-aarch64'
    );
    // And the real `-32` names, which the prefix rule and the whole-name rule
    // agree on — kept so the arm is pinned in both directions.
    assert.equal(
        extractDetailedPlatform('test-windows11-32-25h2-shippable/opt-xpcshell'),
        'windows-32'
    );
    assert.equal(
        extractDetailedPlatform('test-windows11-32-25h2-mingwclang/debug-mochitest-plain-gpu'),
        'windows-32'
    );

    // The `-64` arm, from a real name that DOES distinguish the two rules:
    // `test-linux2404-64/debug-mochitest-a11y-1proc` is `linux-64` by the
    // prefix and would be plain `linux` if the suffix were included, because
    // the suffix has no bitness token to find.
    assert.equal(
        extractDetailedPlatform('test-linux2404-64/debug-mochitest-a11y-1proc'),
        'linux-64'
    );
});

test('platformDisplayName falls back to the key rather than to a placeholder', () => {
    assert.equal(platformDisplayName('windows-64'), 'Win 64');
    assert.equal(platformDisplayName('mac-aarch64'), 'macOS ARM');
    assert.equal(platformDisplayName('linux'), 'Linux');
    // A platform combination with no pretty name shows its own key, so a new
    // one appears in the table rather than disappearing.
    assert.equal(platformDisplayName('linux-aarch64'), 'linux-aarch64');
    assert.equal(platformDisplayName('unknown'), 'unknown');
});

// --- outcome signatures and collapsing -----------------------------------

test('outcomeSignature separates absent from skip-only from ran', () => {
    // Three distinct states, and conflating any two collapses rows that should
    // stay apart. Literals.
    assert.equal(outcomeSignature(emptyOutcomes()), 'absent');
    assert.equal(outcomeSignature({ ...emptyOutcomes(), skips: 9 }), 'skip');
    assert.equal(outcomeSignature({ ...emptyOutcomes(), passes: 1 }), 'p');
    assert.equal(outcomeSignature({ passes: 1, failures: 1, timeouts: 0, crashes: 0, skips: 0 }), 'pf');
    assert.equal(outcomeSignature({ passes: 3, failures: 2, timeouts: 1, crashes: 4, skips: 7 }), 'pftc');
    // Deliberately rate-blind: 1 failure in 10 and 9 in 10 are the same
    // signature, because the question is "does merging hide a difference a
    // reader needs", not "are the rates equal".
    assert.equal(
        outcomeSignature({ passes: 9, failures: 1, timeouts: 0, crashes: 0, skips: 0 }),
        outcomeSignature({ passes: 1, failures: 9, timeouts: 0, crashes: 0, skips: 0 })
    );
});

test('a variant collapses only when its outcomes match the base everywhere', () => {
    const base: Outcomes = { passes: 100, failures: 0, timeouts: 0, crashes: 0, skips: 0 };
    const config = (jobName: string, o: Outcomes) => ({
        jobName,
        state: 'ok' as const,
        runCount: o.passes + o.failures + o.timeouts + o.crashes,
        passCount: o.passes,
        failCount: o.failures,
        timeoutCount: o.timeouts,
        crashCount: o.crashes,
        expectedFailCount: 0,
        skipCount: o.skips,
        runIfSkipCount: 0,
        skipMessages: new Map<string, number>(),
    });

    // Same signature on the shared platform: msix folds into its base.
    const agreeing = computeDisplayMappings([
        config('test-windows11-64-25h2/opt-mochitest', base),
        config('test-windows11-64-25h2/opt-mochitest-msix', { ...base, passes: 50 }),
    ]);
    assert.equal(agreeing.variantCollapse['opt-mochitest-msix'], 'opt-mochitest');

    // The msix build fails and the base does not — signatures `p` vs `pf`, so
    // the rows stay apart. This is the case the conditional collapse exists
    // for: folding them would hide a build-specific perma-fail.
    const differing = computeDisplayMappings([
        config('test-windows11-64-25h2/opt-mochitest', base),
        config('test-windows11-64-25h2/opt-mochitest-msix', {
            passes: 0,
            failures: 40,
            timeouts: 0,
            crashes: 0,
            skips: 0,
        }),
    ]);
    assert.equal(differing.variantCollapse['opt-mochitest-msix'], undefined);
});

test('swr collapses unconditionally, but only when every platform is linux', () => {
    const row = (jobName: string, passes: number, failures = 0) => ({
        jobName,
        state: 'ok' as const,
        runCount: passes + failures,
        passCount: passes,
        failCount: failures,
        timeoutCount: 0,
        crashCount: 0,
        expectedFailCount: 0,
        skipCount: 0,
        runIfSkipCount: 0,
        skipMessages: new Map<string, number>(),
    });

    // Unconditional: the outcomes differ (`p` vs `pf`) and it collapses anyway,
    // because software WebRender is known to behave like its base.
    const linux = computeDisplayMappings([
        row('test-linux2404-64/opt-mochitest', 100),
        row('test-linux2404-64/opt-mochitest-swr', 10, 5),
    ]);
    assert.equal(linux.variantCollapse['opt-mochitest-swr'], 'opt-mochitest');

    // The precheck: swr is linux-only, so a windows job carrying the token is
    // not the same thing and must not be folded.
    const windows = computeDisplayMappings([
        row('test-windows11-64-25h2/opt-mochitest', 100),
        row('test-windows11-64-25h2/opt-mochitest-swr', 100),
    ]);
    assert.equal(windows.variantCollapse['opt-mochitest-swr'], undefined);
});

test('a lone sub-platform collapses to its base OS, so the column reads "Windows"', () => {
    const row = (jobName: string) => ({
        jobName,
        state: 'ok' as const,
        runCount: 10,
        passCount: 10,
        failCount: 0,
        timeoutCount: 0,
        crashCount: 0,
        expectedFailCount: 0,
        skipCount: 0,
        runIfSkipCount: 0,
        skipMessages: new Map<string, number>(),
    });
    // Only 64-bit windows ran it, so the column is `Windows`, not `Win 64` —
    // the bitness is not information when there is nothing to contrast it with.
    const only64 = computeDisplayMappings([row('test-windows11-64-25h2/opt-mochitest')]);
    assert.equal(only64.platformCollapse['windows-64'], 'windows');

    // Both ran it with the same outcomes: still merged into one column.
    const both = computeDisplayMappings([
        row('test-windows11-64-25h2/opt-mochitest'),
        row('test-windows11-32-25h2/opt-mochitest'),
    ]);
    assert.equal(both.platformCollapse['windows-64'], 'windows');
    assert.equal(both.platformCollapse['windows-32'], 'windows');
});

test('the sub-platforms stay split when a variant behaves differently on them', () => {
    const row = (jobName: string, passes: number, failures: number) => ({
        jobName,
        state: 'ok' as const,
        runCount: passes + failures,
        passCount: passes,
        failCount: failures,
        timeoutCount: 0,
        crashCount: 0,
        expectedFailCount: 0,
        skipCount: 0,
        runIfSkipCount: 0,
        skipMessages: new Map<string, number>(),
    });
    // `p` on 64, `pf` on 32 — the split is the finding, so the columns stay.
    const mappings = computeDisplayMappings([
        row('test-windows11-64-25h2/opt-mochitest', 100, 0),
        row('test-windows11-32-25h2/opt-mochitest', 90, 10),
    ]);
    assert.equal(mappings.platformCollapse['windows-64'], 'windows-64');
    assert.equal(mappings.platformCollapse['windows-32'], 'windows-32');
});

test('displayVariantOf chases a collapse chain rather than following one link', () => {
    // `nofis` runs before `geckoview`, so `X-geckoview-Y-nofis` can land on
    // `X-geckoview-Y` and then be carried on to `X-Y`. Following one link would
    // strand it at the intermediate name, which is a row nothing else uses.
    const mappings = {
        variantCollapse: {
            'opt-mochitest-geckoview-nofis': 'opt-mochitest-geckoview',
            'opt-mochitest-geckoview': 'opt-mochitest',
        },
        platformCollapse: { 'linux-64': 'linux' },
    };
    assert.equal(
        displayVariantOf(mappings, 'test-linux2404-64/opt-mochitest-geckoview-nofis-3'),
        'opt-mochitest'
    );
    assert.equal(displayPlatformOf(mappings, 'test-linux2404-64/opt-mochitest'), 'linux');
    // A platform with no entry keeps its detailed name.
    assert.equal(displayPlatformOf(mappings, 'test-windows11-32-25h2/opt-mochitest'), 'windows-32');
});

test('cellKey and splitCellKey round-trip, and split at the FIRST bar', () => {
    assert.equal(cellKey('opt-xpcshell', 'linux-64'), 'opt-xpcshell|linux-64');
    assert.deepEqual(splitCellKey('opt-xpcshell|linux-64'), {
        variant: 'opt-xpcshell',
        platform: 'linux-64',
    });
    // A bar cannot appear in either part today, but splitting on the last one
    // would silently move characters between the two if it ever did.
    assert.deepEqual(splitCellKey('a|b|c'), { variant: 'a', platform: 'b|c' });
});

// --- the summary bar -----------------------------------------------------

test('the summary bar reports the raw fixture totals, with skips out of runCount', () => {
    // The semantic trap named in the migration brief: `runCount` EXCLUDES
    // skips here (`test.html` / `common-test-data.js:341`) while
    // `old/issues.html:1060` includes them in its own denominator. Getting this
    // wrong changes every percentage on the page.
    //
    // `test_http2-proxy.js` is the fixture's clearest case: 3,494 skips against
    // 9,171 passes and 1 timeout. Expected values come from `rawTotals`, which
    // reads the fixture's arrays directly and shares no code with the view.
    const testId = testIdOf(XPCSHELL, 'netwerk/test/unit/test_http2-proxy.js');
    const raw = rawTotals(XPCSHELL, testId);
    assert.equal(raw.get('SKIP'), 3494);
    assert.equal(raw.get('PASS-SEQUENTIAL'), 9171);
    assert.equal(raw.get('TIMEOUT-SEQUENTIAL'), 1);

    const stats = computeTestStats(decoded(XPCSHELL), testId);
    // 9171 + 1 = 9172. The 3,494 skips are NOT in it.
    assert.equal(stats.runCount, 9172);
    assert.equal(stats.skipCount, 3494);

    const summary = summaryStats(stats);
    // The counts go through `toLocaleString()`, whose group separator depends
    // on the runtime's locale — a comma in en-US, a narrow no-break space in
    // fr-FR. Pinning a comma made this test pass or fail by environment, so the
    // separator is taken from the platform and only the *number* is asserted.
    // The old page uses the same `toLocaleString()` (`common-ui.js:18`), so the
    // two agree whatever the locale is; the browser run confirmed it.
    assert.deepEqual(
        summary.map((s) => [s.label, s.value]),
        [
            ['Runs', (9172).toLocaleString()],
            ['Pass %', '99.99%'],
            ['Failures', '0'],
            ['Timeouts', '1'],
            ['Crashes', '0'],
            ['Skips', (3494).toLocaleString()],
        ]
    );
    // Had skips been in the denominator the rate would be 9171/12666 = 72.4%.
    // Stating the wrong answer as a literal is what makes this test fail loudly
    // if the denominator ever changes.
    assert.notEqual(summary[1]!.value, '72.41%');
});

test('the summary colour classes mark zero, healthy and unhealthy differently', () => {
    // 100% is green, below 90% is red, between is default, and a zero count is
    // grey so a row of zeroes reads as "nothing here".
    const clean = summaryStats(
        computeTestStats(
            decoded(MOCHITEST),
            testIdOf(MOCHITEST, 'dom/canvas/test/webgl-mochitest/test_webgl_high_power.html')
        )
    );
    assert.equal(clean[1]!.value, '100%');
    assert.equal(clean[1]!.cssClass, 'good');
    assert.equal(clean[2]!.cssClass, 'zero', 'no failures is grey, not red');
    assert.equal(clean[5]!.cssClass, 'zero');

    const failing = summaryStats(
        computeTestStats(decoded(MOCHITEST), testIdOf(MOCHITEST, 'layout/base/tests/chrome/test_bug551434.html'))
    );
    // 8,649 passes and 42 failures — read off `rawTotals` below.
    const raw = rawTotals(MOCHITEST, testIdOf(MOCHITEST, 'layout/base/tests/chrome/test_bug551434.html'));
    assert.equal(raw.get('PASS'), 8649);
    assert.equal(raw.get('FAIL'), 42);
    assert.equal(failing[0]!.value, (8691).toLocaleString());
    assert.equal(failing[2]!.value, '42');
    assert.equal(failing[2]!.cssClass, 'fail');
    // 8649/8691 = 99.52%, which is above 90 and below 100: the default class.
    assert.equal(failing[1]!.value, '99.52%');
    assert.equal(failing[1]!.cssClass, '');
});

test('Pass % is rounded to at most 2 decimals and drops trailing zeros', () => {
    // Upstream computes `Math.round(x * 10000) / 100` and interpolates the
    // NUMBER, so 100 renders `100%` rather than `100.00%`. A `toFixed(2)`
    // "simplification" would change every clean test's headline figure.
    const clean = summaryStats(
        computeTestStats(
            decoded(MOCHITEST),
            testIdOf(MOCHITEST, 'dom/canvas/test/webgl-mochitest/test_webgl_constant_vendor_fpp.html')
        )
    );
    assert.equal(clean[1]!.value, '100%');
    assert.notEqual(clean[1]!.value, '100.00%');
});

// --- the job table -------------------------------------------------------

test('the job table is a variant × platform pivot, not a list of configs', () => {
    // The framing property the audit flags first: one row per job VARIANT, with
    // platforms as columns. A port emitting one row per configuration would
    // produce the same numbers and answer a different question.
    const file = decoded(XPCSHELL);
    const testId = testIdOf(XPCSHELL, 'dom/indexedDB/test/unit/test_rename_objectStore_errors.js');
    const view = buildTestView(file, {
        testId,
        testPath: 'dom/indexedDB/test/unit/test_rename_objectStore_errors.js',
        component: null,
        harness: 'xpcshell',
        stats: computeTestStats(file, testId),
        metadata: { days: 21, startTime: XPCSHELL.metadata.startTime },
    });

    // Every row has exactly one cell per platform column — that is what makes
    // it a pivot rather than a ragged list.
    for (const row of view.jobTable.rows) {
        assert.equal(row.cells.length, view.jobTable.platforms.length, row.variant);
        for (const [i, cell] of row.cells.entries()) {
            assert.equal(cell.platform, view.jobTable.platforms[i]);
            assert.equal(cell.variant, row.variant);
            assert.equal(cell.key, cellKey(row.variant, cell.platform));
        }
    }
    // Variants are unique: two rows with the same name would be the pivot
    // failing to aggregate.
    const names = view.jobTable.rows.map((r) => r.variant);
    assert.equal(new Set(names).size, names.length);
    // Headers are the display names, in the same order as the keys.
    assert.deepEqual(view.jobTable.platformHeaders, view.jobTable.platforms.map(platformDisplayName));
});

test('platform columns are lexicographic on the KEY, not on the display name', () => {
    // `old/test.html:2698` sorts the keys. The distinction is visible whenever a
    // display name reorders relative to its key — `mac-64`/`mac-aarch64` sort
    // one way and `macOS x64`/`macOS ARM` the other.
    const file = decoded(MOCHITEST);
    const testId = testIdOf(MOCHITEST, 'dom/security/test/csp/test_bug1777572.html');
    const view = buildTestView(file, {
        testId,
        testPath: 'dom/security/test/csp/test_bug1777572.html',
        component: null,
        harness: 'mochitest',
        stats: computeTestStats(file, testId),
        metadata: { days: 21, startTime: MOCHITEST.metadata.startTime },
    });
    assert.deepEqual(view.jobTable.platforms, [...view.jobTable.platforms].sort());
});

test('rows group by variant prefix, both levels descending by total runs', () => {
    // `old/test.html:2717-2731`, and "total runs" at both levels INCLUDES skips
    // (`:2720`) — unlike every percentage on the page. Preserved because a
    // variant scheduled everywhere and skipped everywhere accounts for a lot of
    // CI, and sinking it to the bottom is where a reader would least look for
    // the reason it never runs.
    const file = decoded(MOCHITEST);
    const testId = testIdOf(MOCHITEST, 'dom/security/test/csp/test_bug1777572.html');
    const view = buildTestView(file, {
        testId,
        testPath: 'dom/security/test/csp/test_bug1777572.html',
        component: null,
        harness: 'mochitest',
        stats: computeTestStats(file, testId),
        metadata: { days: 21, startTime: MOCHITEST.metadata.startTime },
    });

    // Recompute the sort keys from the ROWS' own cells rather than from the
    // sorter, so this checks the ordering rather than restating it.
    const totalOf = (variant: string): number => {
        const row = view.jobTable.rows.find((r) => r.variant === variant)!;
        let total = 0;
        for (const cell of row.cells) {
            const o = cell.outcomes;
            if (o !== null) {
                total += o.passes + o.failures + o.timeouts + o.crashes + o.skips;
            }
        }
        return total;
    };
    const prefixOf = (v: string): string => v.split('-')[0] || v;
    const prefixTotals = new Map<string, number>();
    for (const row of view.jobTable.rows) {
        const p = prefixOf(row.variant);
        prefixTotals.set(p, (prefixTotals.get(p) ?? 0) + totalOf(row.variant));
    }

    for (let i = 1; i < view.jobTable.rows.length; i++) {
        const prev = view.jobTable.rows[i - 1]!.variant;
        const curr = view.jobTable.rows[i]!.variant;
        const pPrev = prefixOf(prev);
        const pCurr = prefixOf(curr);
        if (pPrev !== pCurr) {
            assert.ok(
                prefixTotals.get(pPrev)! >= prefixTotals.get(pCurr)!,
                `prefix ${pPrev} (${prefixTotals.get(pPrev)}) must not sort below ` +
                    `${pCurr} (${prefixTotals.get(pCurr)})`
            );
        } else {
            assert.ok(
                totalOf(prev) >= totalOf(curr),
                `${prev} (${totalOf(prev)}) must not sort below ${curr} (${totalOf(curr)}) ` +
                    'within the same prefix group'
            );
        }
    }
    // A prefix's rows are contiguous — grouping means the group is not split.
    const seen = new Set<string>();
    let last: string | null = null;
    for (const row of view.jobTable.rows) {
        const p = prefixOf(row.variant);
        if (p !== last) {
            assert.ok(!seen.has(p), `prefix ${p} appears in two separate blocks`);
            seen.add(p);
            last = p;
        }
    }
});

test('tied rows fall back to the page walk order, not to coverageOf order', () => {
    // `coverageInPageOrder`'s whole reason to exist, and the mutation that
    // survived: `Array.prototype.sort` is stable, so when both levels of the
    // key tie the input order decides, and the input order is the page's walk
    // over `runsOfTest` rather than `coverageOf`'s own sorted output.
    //
    // The earlier review called this unreachable on a measurement of "0 ties".
    // That measurement was wrong. MEASURED over the 1,674 tests in the pinned
    // snapshot plus both checked-in fixtures:
    //
    //   - 492 tests have at least one tied pair (797 tied pairs in total);
    //   - on 186 of them the resulting ROW ORDER actually differs between the
    //     walk order and `coverageOf`'s order.
    //
    // One of those 186 is in `mochitest-00.json`, so the case is pinned here
    // against real data rather than constructed. It is the same `ccov` pair
    // the module comment in `site/test-view.ts` uses as its example.
    const path = 'dom/media/webrtc/tests/mochitests/test_peerConnection_simulcastOffer.html';
    const file = decoded(MOCHITEST);
    const testId = testIdOf(MOCHITEST, path);
    const view = buildTestView(file, {
        testId,
        testPath: path,
        component: null,
        harness: 'mochitest',
        stats: computeTestStats(file, testId),
        metadata: { days: 21, startTime: MOCHITEST.metadata.startTime },
    });
    const variants = view.jobTable.rows.map((r) => r.variant);

    // The two tied rows, and the order the page produces. Both have the prefix
    // `ccov` and the same total runs, so neither level of the sort separates
    // them — only the input order does.
    const nogpu = variants.indexOf('ccov-mochitest-media-nogpu');
    const plain = variants.indexOf('ccov-mochitest-media');
    assert.notEqual(nogpu, -1, 'ccov-mochitest-media-nogpu is gone from the fixture');
    assert.notEqual(plain, -1, 'ccov-mochitest-media is gone from the fixture');
    assert.ok(nogpu < plain, `-nogpu must come first; got ${variants.slice(nogpu, plain + 1)}`);

    // And the tie is real: both sort keys are equal, so this is not the
    // comparator ordering them.
    const totalOf = (variant: string): number => {
        const row = view.jobTable.rows.find((r) => r.variant === variant)!;
        let total = 0;
        for (const cell of row.cells) {
            const o = cell.outcomes;
            if (o !== null) {
                total += o.passes + o.failures + o.timeouts + o.crashes + o.skips;
            }
        }
        return total;
    };
    assert.equal(
        totalOf('ccov-mochitest-media-nogpu'),
        totalOf('ccov-mochitest-media'),
        'the rows must TIE, or this test is checking the comparator instead'
    );

    // The independent half: `coverageOf` — the library query the page reorders
    // — emits these two the other way round. So the assertion above cannot be
    // satisfied by passing `coverageOf`'s configs straight through, which is
    // exactly the mutation that survived.
    //
    // Compared through `displayVariantOf` because `coverageOf` yields raw job
    // names (`test-windows11-64-25h2-ccov/opt-mochitest-media`) and the row
    // order is over display variants.
    const configs = coverageOf(file, testId).configs;
    const mappings = computeDisplayMappings(configs);
    const covOrder = configs.map((c) => displayVariantOf(mappings, c.jobName));
    const covNogpu = covOrder.indexOf('ccov-mochitest-media-nogpu');
    const covPlain = covOrder.indexOf('ccov-mochitest-media');
    assert.notEqual(covNogpu, -1);
    assert.notEqual(covPlain, -1);
    assert.ok(
        covPlain < covNogpu,
        'coverageOf is expected to emit the plain variant FIRST; if this flips, ' +
            'the fixture changed and the test no longer distinguishes the two orders'
    );
});

test('the badge percentage divides by runs, EXCLUDING skips', () => {
    // `old/test.html:2740`. The same trap as the summary bar, one level down: a
    // test skipped on most of its scheduled jobs and failing on half the rest
    // reads as 50%, not as a few percent.
    const cell = {
        variant: 'v',
        platform: 'p',
        key: 'v|p',
        outcomes: null,
        badges: [],
        hasPassPrefixLayer: false,
        noHover: true,
    };
    void cell;

    const configs = [
        {
            jobName: 'test-linux2404-64/opt-xpcshell',
            state: 'intermittent' as const,
            runCount: 10,
            passCount: 5,
            failCount: 5,
            timeoutCount: 0,
            crashCount: 0,
            expectedFailCount: 0,
            skipCount: 90,
            runIfSkipCount: 0,
            skipMessages: new Map([['os == "win"', 90]]),
        },
    ];
    const table = buildJobTable(configs, computeDisplayMappings(configs));
    const only = table.rows[0]!.cells[0]!;
    const fail = only.badges.find((b) => b.kind === 'fail')!;
    // 5 / (5 + 5) = 50.0%, not 5 / 100 = 5.0%.
    assert.equal(fail.percentText, '50.0%');
    assert.notEqual(fail.percentText, '5.0%');
    // The shared tooltip lists every outcome, and its total also excludes skips.
    assert.equal(fail.tooltip, '5 failures\n5 passes\n10 total runs');
    // The skip badge carries the reason.
    const skip = only.badges.find((b) => b.kind === 'skip')!;
    assert.equal(skip.tooltip, '90 skips\nos == "win"');
});

test('the fail, crash and timeout badges share ONE tooltip listing everything', () => {
    // `old/test.html:2765` builds the text once. Hovering CRASH to be told only
    // about crashes would hide that the cell also failed 40 times.
    const configs = [
        {
            jobName: 'test-linux2404-64/opt-xpcshell',
            state: 'intermittent' as const,
            runCount: 100,
            passCount: 50,
            failCount: 40,
            timeoutCount: 3,
            crashCount: 7,
            expectedFailCount: 0,
            skipCount: 0,
            runIfSkipCount: 0,
            skipMessages: new Map<string, number>(),
        },
    ];
    const table = buildJobTable(configs, computeDisplayMappings(configs));
    const badges = table.rows[0]!.cells[0]!.badges;
    // Order is fail, crash, timeout — upstream's, severity-ish rather than
    // alphabetical.
    assert.deepEqual(badges.map((b) => b.kind), ['fail', 'crash', 'timeout']);
    const expected = '40 failures\n7 crashes\n3 timeouts\n50 passes\n100 total runs';
    for (const badge of badges) {
        assert.equal(badge.tooltip, expected, badge.kind);
    }
    assert.equal(badges[0]!.percentText, '40.0%');
    assert.equal(badges[1]!.percentText, '7.0%');
    assert.equal(badges[2]!.percentText, '3.0%');
});

test('singular and plural are chosen per count, including "crashes"', () => {
    const one = [
        {
            jobName: 'test-linux2404-64/opt-xpcshell',
            state: 'intermittent' as const,
            runCount: 2,
            passCount: 1,
            failCount: 1,
            timeoutCount: 0,
            crashCount: 0,
            expectedFailCount: 0,
            skipCount: 1,
            runIfSkipCount: 0,
            skipMessages: new Map<string, number>(),
        },
    ];
    const table = buildJobTable(one, computeDisplayMappings(one));
    const badges = table.rows[0]!.cells[0]!.badges;
    assert.equal(badges[0]!.tooltip, '1 failure\n1 pass\n2 total runs');
    assert.equal(badges.find((b) => b.kind === 'skip')!.tooltip, '1 skip');

    const crashy = [{ ...one[0]!, crashCount: 1, failCount: 0, passCount: 1, runCount: 2 }];
    const crashTable = buildJobTable(crashy, computeDisplayMappings(crashy));
    // `crash` pluralizes with `-es`, which a generic `+ 's'` gets wrong.
    assert.match(crashTable.rows[0]!.cells[0]!.badges[0]!.tooltip, /^1 crash\n/);
});

test('a pass-only cell shows one PASS badge and is not hoverable', () => {
    const configs = [
        {
            jobName: 'test-linux2404-64/opt-xpcshell',
            state: 'ok' as const,
            runCount: 42,
            passCount: 42,
            failCount: 0,
            timeoutCount: 0,
            crashCount: 0,
            expectedFailCount: 0,
            skipCount: 0,
            runIfSkipCount: 0,
            skipMessages: new Map<string, number>(),
        },
    ];
    const cell = buildJobTable(configs, computeDisplayMappings(configs)).rows[0]!.cells[0]!;
    assert.deepEqual(cell.badges.map((b) => b.kind), ['pass']);
    assert.equal(cell.badges[0]!.percentText, null, 'the PASS badge shows no rate');
    assert.equal(cell.badges[0]!.tooltip, '42 runs');
    // No per-cell runtime story worth pulling up for a cell with nothing to
    // distinguish, so hovering does nothing.
    assert.equal(cell.noHover, true);
    // No issues, so no PASS prefix overlay: there is nothing to fall back from.
    assert.equal(cell.hasPassPrefixLayer, false);
});

test('a skip-only cell IS hoverable, unlike a pass-only one', () => {
    // `hasVisibleIssues` (`old/test.html:2263`) counts skips. A cell that is only
    // ever skipped is worth hovering — the reason is in the tooltip.
    const configs = [
        {
            jobName: 'test-linux2404-64/opt-xpcshell',
            state: 'skipped' as const,
            runCount: 0,
            passCount: 0,
            failCount: 0,
            timeoutCount: 0,
            crashCount: 0,
            expectedFailCount: 0,
            skipCount: 5,
            runIfSkipCount: 0,
            skipMessages: new Map([['os == "linux"', 5]]),
        },
    ];
    const cell = buildJobTable(configs, computeDisplayMappings(configs)).rows[0]!.cells[0]!;
    assert.deepEqual(cell.badges.map((b) => b.kind), ['skip']);
    assert.equal(cell.noHover, false);
});

test('a variant absent from a platform gets a null cell, not a zeroed one', () => {
    // The em-dash case. Zeroes would read as "ran and never failed", which is
    // the opposite of "never ran here".
    const configs = [
        {
            jobName: 'test-linux2404-64/opt-xpcshell',
            state: 'ok' as const,
            runCount: 1,
            passCount: 1,
            failCount: 0,
            timeoutCount: 0,
            crashCount: 0,
            expectedFailCount: 0,
            skipCount: 0,
            runIfSkipCount: 0,
            skipMessages: new Map<string, number>(),
        },
        {
            jobName: 'test-windows11-64-25h2/debug-mochitest',
            state: 'ok' as const,
            runCount: 1,
            passCount: 1,
            failCount: 0,
            timeoutCount: 0,
            crashCount: 0,
            expectedFailCount: 0,
            skipCount: 0,
            runIfSkipCount: 0,
            skipMessages: new Map<string, number>(),
        },
    ];
    const table = buildJobTable(configs, computeDisplayMappings(configs));
    assert.equal(table.platforms.length, 2);
    const nulls = table.rows.flatMap((r) => r.cells).filter((c) => c.outcomes === null);
    // Two variants × two platforms, two of which actually ran.
    assert.equal(nulls.length, 2);
    for (const cell of nulls) {
        assert.deepEqual(cell.badges, []);
        assert.equal(cell.noHover, true);
    }
});

test('several skip reasons are listed by count descending', () => {
    const configs = [
        {
            jobName: 'test-linux2404-64/opt-xpcshell',
            state: 'skipped' as const,
            runCount: 0,
            passCount: 0,
            failCount: 0,
            timeoutCount: 0,
            crashCount: 0,
            expectedFailCount: 0,
            skipCount: 12,
            runIfSkipCount: 0,
            skipMessages: new Map([
                ['rarely', 2],
                ['most often', 9],
                ['sometimes', 1],
            ]),
        },
    ];
    const cell = buildJobTable(configs, computeDisplayMappings(configs)).rows[0]!.cells[0]!;
    // The reason a test is most often skipped is the one worth reading first.
    assert.equal(
        cell.badges[0]!.tooltip,
        '12 skips\nmost often (9)\nrarely (2)\nsometimes (1)'
    );
});

test('EXPECTED-FAIL is counted as a pass in a cell, matching the old page', () => {
    // `lib/model/status.ts` splits `expected-fail` out on purpose; the page
    // folds it into passes (`old/test.html:2625` lists it among the non-failures).
    // Keeping the page's meaning is what makes every badge percentage match.
    const configs = [
        {
            jobName: 'test-linux2404-64/opt-xpcshell',
            state: 'ok' as const,
            runCount: 10,
            passCount: 6,
            failCount: 0,
            timeoutCount: 0,
            crashCount: 0,
            expectedFailCount: 4,
            skipCount: 0,
            runIfSkipCount: 0,
            skipMessages: new Map<string, number>(),
        },
    ];
    const cell = buildJobTable(configs, computeDisplayMappings(configs)).rows[0]!.cells[0]!;
    assert.equal(cell.outcomes!.passes, 10, 'the 4 expected failures are in the pass bucket');
    assert.equal(cell.badges[0]!.tooltip, '10 runs');
});

// --- daily rates and the chart -------------------------------------------

test('dailyRates emits one row per day, dated forward from startTime', () => {
    const file = decoded(XPCSHELL);
    const testId = testIdOf(XPCSHELL, 'toolkit/components/extensions/test/xpcshell/test_ext_shadowdom.js');
    const rates = dailyRates(file, testId, { days: 21, startTime: XPCSHELL.metadata.startTime });
    assert.equal(rates.length, 21);
    // Day 0 is the OLDEST, and the fixture's own metadata says which date that
    // is. Read off the fixture, not off the function.
    assert.equal(rates[0]!.date, XPCSHELL.metadata.startDate);
    assert.equal(rates[20]!.date, XPCSHELL.metadata.endDate);
    assert.deepEqual(rates.map((r) => r.day), [...Array(21).keys()]);
    // Consecutive and strictly increasing — a duplicated date would mean the
    // 86,400-second step had drifted into local time.
    const dates = rates.map((r) => r.date);
    assert.equal(new Set(dates).size, 21);
    assert.deepEqual(dates, [...dates].sort());
});

test('the daily totals sum to the whole-window totals', () => {
    // Not circular: `rawTotals` reads the fixture's arrays, `dailyRates`
    // decodes and buckets them. Agreement means the day attribution loses
    // nothing — the failure this catches is an off-by-one on `day >= days`.
    const testId = testIdOf(XPCSHELL, 'toolkit/crashreporter/test/unit/test_crash_win64cfi_push_nonvol.js');
    const raw = rawTotals(XPCSHELL, testId);
    const rates = dailyRates(decoded(XPCSHELL), testId, {
        days: 21,
        startTime: XPCSHELL.metadata.startTime,
    });
    const sum = (key: keyof (typeof rates)[number]): number =>
        rates.reduce((a, r) => a + (r[key] as number), 0);

    const rawPasses =
        (raw.get('PASS') ?? 0) + (raw.get('PASS-PARALLEL') ?? 0) + (raw.get('PASS-SEQUENTIAL') ?? 0);
    const rawFails =
        (raw.get('FAIL') ?? 0) + (raw.get('FAIL-PARALLEL') ?? 0) + (raw.get('FAIL-SEQUENTIAL') ?? 0);
    const rawTimeouts =
        (raw.get('TIMEOUT') ?? 0) +
        (raw.get('TIMEOUT-PARALLEL') ?? 0) +
        (raw.get('TIMEOUT-SEQUENTIAL') ?? 0);

    assert.equal(sum('passes'), rawPasses);
    assert.equal(sum('failures'), rawFails);
    assert.equal(sum('timeouts'), rawTimeouts);
    assert.equal(sum('crashes'), raw.get('CRASH') ?? 0);
    assert.equal(sum('skips'), raw.get('SKIP') ?? 0);
});

test('dateOfDay steps by whole UTC days', () => {
    // 1783987200 is the fixture's startTime, whose date the fixture also states.
    assert.equal(dateOfDay(1783987200, 0), '2026-07-14');
    assert.equal(dateOfDay(1783987200, 1), '2026-07-15');
    assert.equal(dateOfDay(1783987200, 20), '2026-08-03');
    // Across a month boundary and a DST change in local time, which a
    // local-time calculation would shift.
    assert.equal(dateOfDay(1783987200, 17), '2026-07-31');
    assert.equal(dateOfDay(1783987200, 18), '2026-08-01');
});

test('the chart section appears only when there is something to plot', () => {
    // `old/test.html:2482`, and each canvas is independent: a test that is skipped
    // but never fails gets the skip chart alone.
    const zero = { day: 0, date: 'd', passes: 5, failures: 0, timeouts: 0, crashes: 0, skips: 0 };
    assert.deepEqual(chartPresence([zero]), { hasIssues: false, hasSkips: false });
    assert.deepEqual(chartPresence([{ ...zero, skips: 1 }]), { hasIssues: false, hasSkips: true });
    assert.deepEqual(chartPresence([{ ...zero, failures: 1 }]), { hasIssues: true, hasSkips: false });
    assert.deepEqual(chartPresence([{ ...zero, timeouts: 1 }]), { hasIssues: true, hasSkips: false });
    assert.deepEqual(chartPresence([{ ...zero, crashes: 1 }]), { hasIssues: true, hasSkips: false });
    assert.deepEqual(chartPresence([]), { hasIssues: false, hasSkips: false });

    // A real clean test: no chart at all.
    const cleanId = testIdOf(MOCHITEST, 'dom/canvas/test/webgl-mochitest/test_webgl_high_power.html');
    const cleanRates = dailyRates(decoded(MOCHITEST), cleanId, {
        days: 21,
        startTime: MOCHITEST.metadata.startTime,
    });
    assert.deepEqual(chartPresence(cleanRates), { hasIssues: false, hasSkips: false });

    // A real skipped-but-passing test: the skip chart only.
    const skippedId = testIdOf(
        MOCHITEST,
        'browser/components/tabbrowser/test/browser/tabs/browser_pinnedTabs_clickOpen.js'
    );
    const skippedRates = dailyRates(decoded(MOCHITEST), skippedId, {
        days: 21,
        startTime: MOCHITEST.metadata.startTime,
    });
    assert.deepEqual(chartPresence(skippedRates), { hasIssues: false, hasSkips: true });
});

// --- issues --------------------------------------------------------------

/** Builds the issue list for a fixture test. */
function issuesFor(file: BucketFile, path: string): Issue[] {
    const testId = testIdOf(file, path);
    const dec = decoded(file);
    return buildIssues(dec, testId, computeTestStats(dec, testId));
}

test('the issue list is ordered by count descending', () => {
    // `old/test.html:2551`. The only sort on the list; the assembly order (skips,
    // failures, crashes, timeouts) decides ties only.
    for (const [file, path] of [
        [XPCSHELL, 'toolkit/crashreporter/test/unit/test_crash_win64cfi_push_nonvol.js'],
        [XPCSHELL, 'dom/indexedDB/test/unit/test_setVersion_exclusion.js'],
        [MOCHITEST, 'dom/media/webrtc/tests/mochitests/test_peerConnection_simulcastOffer.html'],
    ] as const) {
        const issues = issuesFor(file, path);
        assert.ok(issues.length > 0, path);
        const counts = issues.map((i) => i.count);
        assert.deepEqual(counts, [...counts].sort((a, b) => b - a), path);
    }
});

test('the issue ids are positional, so they follow the sort', () => {
    const issues = issuesFor(XPCSHELL, 'toolkit/crashreporter/test/unit/test_crash_win64cfi_push_nonvol.js');
    assert.deepEqual(issues.map((i) => i.id), issues.map((_, index) => `issue-${index}`));
});

test('the badge class matches the type, and only SKIP is inexpandable', () => {
    // A skip has no task to link to, because the run never happened.
    const issues = issuesFor(MOCHITEST, 'dom/security/test/csp/test_bug1777572.html');
    for (const issue of issues) {
        assert.equal(issue.badgeClass, `badge-${issue.type.toLowerCase()}`);
        assert.equal(issue.expandable, issue.type !== 'SKIP');
    }
    assert.ok(issues.some((i) => i.type === 'SKIP'), 'the fixture test should have skips');
});

test('a timeout becomes ONE row carrying the whole timeout count', () => {
    // `TIMEOUT*` groups carry no `messageIds` at all, so there is nothing to
    // group by and upstream emits a single fixed row (`old/test.html:2545`).
    const path = 'dom/media/webrtc/tests/mochitests/test_peerConnection_simulcastOffer.html';
    const raw = rawTotals(MOCHITEST, testIdOf(MOCHITEST, path));
    assert.equal(raw.get('TIMEOUT'), 3);

    const timeouts = issuesFor(MOCHITEST, path).filter((i) => i.type === 'TIMEOUT');
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0]!.count, 3);
    assert.equal(timeouts[0]!.message, 'Test exceeded time limit');
    // Timeouts get no tooltip; only FAIL rows do.
    assert.equal(timeouts[0]!.countTooltip, null);
});

test('failures with no message become one synthetic row for the remainder', () => {
    // `old/test.html:2530`. Without it the list's counts would not add up to the
    // summary bar's Failures figure, and the two are read together.
    const path = 'toolkit/crashreporter/test/unit/test_crash_win64cfi_push_nonvol.js';
    const testId = testIdOf(XPCSHELL, path);
    const dec = decoded(XPCSHELL);
    const stats = computeTestStats(dec, testId);
    const issues = buildIssues(dec, testId, stats);

    const failRows = issues.filter((i) => i.type === 'FAIL');
    const failTotal = failRows.reduce((a, i) => a + i.count, 0);
    // The FAIL rows sum to exactly the summary bar's Failures figure.
    assert.equal(failTotal, stats.failCount);
    // And that figure is the raw one.
    const raw = rawTotals(XPCSHELL, testId);
    assert.equal(
        stats.failCount,
        (raw.get('FAIL') ?? 0) + (raw.get('FAIL-PARALLEL') ?? 0) + (raw.get('FAIL-SEQUENTIAL') ?? 0)
    );
});

test('crash rows total the crash count, with a synthetic row when unsymbolized', () => {
    for (const [file, path] of [
        [XPCSHELL, 'dom/indexedDB/test/unit/test_setVersion_exclusion.js'],
        [MOCHITEST, 'browser/components/sessionstore/test/browser_revive_crashed_bg_tabs.js'],
    ] as const) {
        const testId = testIdOf(file, path);
        const dec = decoded(file);
        const stats = computeTestStats(dec, testId);
        const crashRows = buildIssues(dec, testId, stats).filter((i) => i.type === 'CRASH');
        assert.equal(
            crashRows.reduce((a, i) => a + i.count, 0),
            stats.crashCount,
            path
        );
        assert.equal(stats.crashCount, rawTotals(file, testId).get('CRASH') ?? 0, path);
    }
});

test('the FAIL tooltip divides by runCount, which excludes skips', () => {
    // `old/test.html:2566`. On a heavily-skipped test the two denominators differ
    // by a factor, so this is where the trap would show as a wrong percentage.
    const path = 'toolkit/components/extensions/test/xpcshell/test_ext_shadowdom.js';
    const testId = testIdOf(XPCSHELL, path);
    const dec = decoded(XPCSHELL);
    const stats = computeTestStats(dec, testId);
    const raw = rawTotals(XPCSHELL, testId);

    // 22910 + 7 + 321 passes, 6 fails, 1 timeout, and 1921 skips OUTSIDE it.
    assert.equal(raw.get('SKIP'), 1921);
    assert.equal(stats.runCount, 22910 + 7 + 321 + 6 + 1);
    assert.equal(stats.skipCount, 1921);

    const fail = buildIssues(dec, testId, stats).find((i) => i.type === 'FAIL');
    assert.notEqual(fail, undefined);
    assert.notEqual(fail!.countTooltip, null);
    // The denominator in the text is runCount, formatted with separators.
    assert.match(fail!.countTooltip!, new RegExp(`out of ${stats.runCount.toLocaleString()} runs`));
    // And it is not the skip-inclusive total.
    const withSkips = (stats.runCount + stats.skipCount).toLocaleString();
    assert.doesNotMatch(fail!.countTooltip!, new RegExp(`out of ${withSkips} runs`));
    // Plural, because this issue happened more than once. Asserted as the
    // exact word: `/occurrences? of this message/` matches BOTH spellings and
    // is what let an inverted `count === 1 ? 'occurrences' : 'occurrence'`
    // survive the suite.
    assert.ok(fail!.count > 1, `${fail!.count} should be the plural case`);
    assert.match(fail!.countTooltip!, /^\d+ occurrences of this message out of /);
    assert.doesNotMatch(fail!.countTooltip!, /\boccurrence\b/);
});

test('a FAIL that happened once says "1 occurrence", not "1 occurrences"', () => {
    // MEASURED: inverting the singular/plural ternary survived the suite,
    // because the only assertion on the noun was a regex matching either
    // spelling. The singular branch is reachable and visible — this is the
    // tooltip a reader sees on the count of a one-off failure.
    //
    // Three tests in `xpcshell-00.json` have a FAIL issue with count 1; this
    // is the first, found by scanning the fixture rather than constructed.
    const path = 'toolkit/components/extensions/test/xpcshell/test_ext_proxy_speculative.js';
    const testId = testIdOf(XPCSHELL, path);
    const dec = decoded(XPCSHELL);
    const stats = computeTestStats(dec, testId);
    const fail = buildIssues(dec, testId, stats).find((i) => i.type === 'FAIL' && i.count === 1);
    assert.notEqual(fail, undefined, 'the fixture no longer has a single-occurrence FAIL');

    // The whole string, so both the noun and the number are pinned. 16,099
    // runs, read off the fixture through `computeTestStats`, and the space is
    // a narrow no-break space because `toLocaleString()` is locale-dependent.
    assert.equal(stats.runCount, 16099);
    assert.equal(
        fail!.countTooltip,
        `1 occurrence of this message out of ${(16099).toLocaleString()} runs (0.01%)`
    );
    assert.doesNotMatch(fail!.countTooltip!, /occurrences/);
});

test('only FAIL rows carry a count tooltip', () => {
    const issues = issuesFor(MOCHITEST, 'dom/security/test/csp/test_bug1777572.html');
    for (const issue of issues) {
        if (issue.type === 'FAIL') {
            continue;
        }
        assert.equal(issue.countTooltip, null, `${issue.type} should have no tooltip`);
    }
});

test('a clean test produces an empty issue list, so the section is omitted', () => {
    // `old/test.html:2549` returns '' rather than an empty section: a heading over
    // nothing reads as a loading failure.
    const path = 'dom/canvas/test/webgl-mochitest/test_webgl_high_power.html';
    assert.deepEqual(issuesFor(MOCHITEST, path), []);
});

test('skip rows drop `run-if` and strip the `skip-if: ` prefix', () => {
    // Both rules, on real data. `run-if` means the test is scoped elsewhere,
    // which is the annotation working rather than something disabled.
    const issues = issuesFor(MOCHITEST, 'dom/security/test/csp/test_bug1777572.html').filter(
        (i) => i.type === 'SKIP'
    );
    assert.ok(issues.length > 0);
    for (const issue of issues) {
        assert.doesNotMatch(issue.message, /^skip-if:/);
        assert.doesNotMatch(issue.message, /^run-if/);
    }
});

// --- the selection model -------------------------------------------------

test('the day/cell matrix sums to the job table, cell for cell', () => {
    // The matrix drives every filtered view, so it has to agree with the
    // unfiltered table it is filtering. Two different code paths over the same
    // entries — buildJobTable aggregates per config, buildDayCellMatrix per day
    // — so agreement is a real check rather than a restatement.
    const file = decoded(XPCSHELL);
    const testId = testIdOf(XPCSHELL, 'dom/indexedDB/test/unit/test_setVersion_exclusion.js');
    const view = buildTestView(file, {
        testId,
        testPath: 'dom/indexedDB/test/unit/test_setVersion_exclusion.js',
        component: null,
        harness: 'xpcshell',
        stats: computeTestStats(file, testId),
        metadata: { days: 21, startTime: XPCSHELL.metadata.startTime },
    });
    const matrix = buildDayCellMatrix(file, testId, view.mappings, { days: 21 });

    const summed = new Map<string, Outcomes>();
    for (const day of matrix) {
        for (const [key, cell] of day) {
            const into = summed.get(key) ?? emptyOutcomes();
            into.passes += cell.passes;
            into.failures += cell.failures;
            into.timeouts += cell.timeouts;
            into.crashes += cell.crashes;
            into.skips += cell.skips;
            summed.set(key, into);
        }
    }

    assert.ok(view.jobTable.byCell.size > 0);
    for (const [key, expected] of view.jobTable.byCell) {
        assert.deepEqual(summed.get(key), expected, key);
    }
    // And no cell exists in the matrix that the table does not know about.
    for (const key of summed.keys()) {
        assert.ok(view.jobTable.byCell.has(key), `${key} is in the matrix but not the table`);
    }
});

test('a day filter recomputes a cell to the selected days only', () => {
    const file = decoded(XPCSHELL);
    const path = 'dom/indexedDB/test/unit/test_setVersion_exclusion.js';
    const testId = testIdOf(XPCSHELL, path);
    const view = buildTestView(file, {
        testId,
        testPath: path,
        component: null,
        harness: 'xpcshell',
        stats: computeTestStats(file, testId),
        metadata: { days: 21, startTime: XPCSHELL.metadata.startTime },
    });
    const matrix = buildDayCellMatrix(file, testId, view.mappings, { days: 21 });
    const cell = view.jobTable.rows.flatMap((r) => r.cells).find((c) => c.outcomes !== null)!;

    // Every day selected: the filtered cell equals the unfiltered one.
    const allDays = new Set([...Array(21).keys()]);
    const whole = filteredCell(cell, matrix, allDays);
    assert.deepEqual(whole.outcomes, cell.outcomes);
    assert.equal(whole.noData, false);

    // No day has data at index 21 — out of range — so selecting it is "no data".
    const none = filteredCell(cell, matrix, new Set([99]));
    assert.deepEqual(none.outcomes, emptyOutcomes());
    assert.equal(none.noData, true, 'the em-dash overlay');
    assert.equal(none.allIssuesHidden, true);
    assert.equal(none.badgesHidden, true);
    assert.equal(none.noHover, true);
    for (const badge of none.badges.values()) {
        assert.equal(badge.visible, false);
    }
});

test('a day filter leaving only passes shows the PASS overlay, if the cell has one', () => {
    // The three-state overlay logic (`old/test.html:2217-2238`), which is the
    // fiddliest part of the filter. A cell that never had an issue has no
    // overlay element, and then a pass-only day just shows its ordinary badge.
    const withIssues = {
        variant: 'v',
        platform: 'p',
        key: 'v|p',
        outcomes: { passes: 10, failures: 2, timeouts: 0, crashes: 0, skips: 0 },
        badges: [
            { kind: 'fail' as const, label: 'FAIL', percentText: '16.7%', tooltip: 't' },
        ],
        hasPassPrefixLayer: true,
        noHover: false,
    };
    // Day 0 has passes only; day 1 has the failures.
    const matrix = [
        new Map([['v|p', { passes: 10, failures: 0, timeouts: 0, crashes: 0, skips: 0 }]]),
        new Map([['v|p', { passes: 0, failures: 2, timeouts: 0, crashes: 0, skips: 0 }]]),
    ];

    const passOnly = filteredCell(withIssues, matrix, new Set([0]));
    assert.equal(passOnly.noData, false);
    assert.equal(passOnly.allIssuesHidden, true);
    assert.equal(passOnly.badgesHidden, true, 'the PASS overlay replaces the badges');
    assert.equal(passOnly.noHover, true, 'nothing to distinguish on a pass-only day');
    assert.equal(passOnly.badges.get('fail')!.visible, false);

    const failDay = filteredCell(withIssues, matrix, new Set([1]));
    assert.equal(failDay.allIssuesHidden, false);
    assert.equal(failDay.badgesHidden, false);
    assert.equal(failDay.noHover, false);
    assert.equal(failDay.badges.get('fail')!.visible, true);
    // 2 failures out of 2 runs that day — the denominator is the DAY's runs.
    assert.equal(failDay.badges.get('fail')!.percentText, '100.0%');

    // The same cell without the overlay element: the badges layer stays visible.
    const noOverlay = { ...withIssues, hasPassPrefixLayer: false };
    assert.equal(filteredCell(noOverlay, matrix, new Set([0])).badgesHidden, false);
});

test('issue counts under a filter come from the day∩cell intersection', () => {
    // `byDayCell` is stored because it is NOT derivable from the other two:
    // "3 on Monday" and "3 on linux" do not say whether the Monday ones were
    // the linux ones. This is that case, constructed so the two disagree.
    const issue: Issue = {
        count: 6,
        type: 'FAIL',
        message: 'boom',
        badgeClass: 'badge-fail',
        id: 'issue-0',
        expandable: true,
        countTooltip: null,
    };
    const attribution = [
        {
            byDay: new Map([[0, 3], [1, 3]]),
            byCell: new Map([['a|x', 3], ['b|y', 3]]),
            // Day 0 was all cell b, day 1 all cell a — so day 0 ∩ cell a is 0.
            byDayCell: new Map([
                [0, new Map([['b|y', 3]])],
                [1, new Map([['a|x', 3]])],
            ]),
        },
    ];

    const dayOnly = filterIssues([issue], attribution, { days: new Set([0]), cells: new Set() });
    assert.deepEqual(dayOnly, [{ visible: true, count: 3 }]);

    const cellOnly = filterIssues([issue], attribution, { days: new Set(), cells: new Set(['a|x']) });
    assert.deepEqual(cellOnly, [{ visible: true, count: 3 }]);

    // Both: the intersection is empty, so the row hides — and shows its
    // UNFILTERED count, because `0` next to a badge reads as "never happened".
    const both = filterIssues([issue], attribution, {
        days: new Set([0]),
        cells: new Set(['a|x']),
    });
    assert.deepEqual(both, [{ visible: false, count: 6 }]);

    // The other intersection is non-empty.
    const other = filterIssues([issue], attribution, {
        days: new Set([0]),
        cells: new Set(['b|y']),
    });
    assert.deepEqual(other, [{ visible: true, count: 3 }]);

    // No filter at all: everything visible with its own count.
    assert.deepEqual(
        filterIssues([issue], attribution, { days: new Set(), cells: new Set() }),
        [{ visible: true, count: 6 }]
    );
});

test('issue attribution totals match the issue counts it attributes', () => {
    // On real data: every occurrence the list counted must be attributable to
    // some day and some cell, or the filter would silently drop rows.
    const file = decoded(XPCSHELL);
    const path = 'toolkit/components/extensions/test/xpcshell/test_ext_contentscript_scriptCreated.js';
    const testId = testIdOf(XPCSHELL, path);
    const stats = computeTestStats(file, testId);
    const view = buildTestView(file, {
        testId,
        testPath: path,
        component: null,
        harness: 'xpcshell',
        stats,
        metadata: { days: 21, startTime: XPCSHELL.metadata.startTime },
    });
    const attribution = buildIssueAttribution(file, testId, view.issues, view.mappings, { days: 21 });
    assert.equal(attribution.length, view.issues.length);

    for (const [index, issue] of view.issues.entries()) {
        const info = attribution[index]!;
        const byDay = [...info.byDay.values()].reduce((a, b) => a + b, 0);
        const byCell = [...info.byCell.values()].reduce((a, b) => a + b, 0);
        // The two attributions of the same occurrences must agree with each
        // other and with the row's count. A SKIP row can under-count here:
        // `run-if` skips are excluded from the matrix but the list's counts
        // come from a filter that also excludes them, so they agree too.
        assert.equal(byDay, byCell, `${issue.type} ${issue.message}`);
        assert.equal(byDay, issue.count, `${issue.type} ${issue.message}`);
    }
});

test('the filter notice collapses dates to a range past three, and cells past one', () => {
    // `old/test.html:2372`. The notice sits on the `Issue Details` heading line, so
    // nine job names do not fit.
    const rates = [...Array(21).keys()].map((day) => ({
        day,
        date: dateOfDay(1783987200, day),
        passes: 0,
        failures: 0,
        timeouts: 0,
        crashes: 0,
        skips: 0,
    }));

    assert.equal(issueFilterNotice(3, 7, { days: new Set(), cells: new Set() }, rates, 'xpcshell'), null);

    assert.equal(
        issueFilterNotice(2, 7, { days: new Set([0]), cells: new Set() }, rates, 'xpcshell'),
        '— 2 of 7 shown (2026-07-14)'
    );
    assert.equal(
        issueFilterNotice(2, 7, { days: new Set([0, 1, 2]), cells: new Set() }, rates, 'xpcshell'),
        '— 2 of 7 shown (2026-07-14, 2026-07-15, 2026-07-16)'
    );
    // Four is one too many: it becomes a range with an en dash.
    assert.equal(
        issueFilterNotice(2, 7, { days: new Set([0, 1, 2, 3]), cells: new Set() }, rates, 'xpcshell'),
        '— 2 of 7 shown (2026-07-14 – 2026-07-17)'
    );
    // One cell is named; several are counted.
    assert.equal(
        issueFilterNotice(1, 7, { days: new Set(), cells: new Set(['opt-xpcshell|linux-64']) }, rates, 'xpcshell'),
        '— 1 of 7 shown (opt on linux-64)'
    );
    assert.equal(
        issueFilterNotice(1, 7, { days: new Set(), cells: new Set(['a|x', 'b|y']) }, rates, 'xpcshell'),
        '— 1 of 7 shown (2 jobs)'
    );
    // Both, in day-then-cell order.
    assert.equal(
        issueFilterNotice(1, 7, { days: new Set([0]), cells: new Set(['a|x']) }, rates, 'xpcshell'),
        '— 1 of 7 shown (2026-07-14, a on x)'
    );
});

// --- durations -----------------------------------------------------------

test('computePercentile interpolates rather than taking a nearest rank', () => {
    // `old/test.html:1660`. Distinct from `cli/commands/test.ts`'s `quantile()`,
    // which is nearest-rank; the two disagree by up to one sample and only this
    // one is what the panel shows.
    assert.equal(computePercentile([10, 20, 30, 40], 50), 25, 'midway between 20 and 30');
    assert.equal(computePercentile([10, 20, 30, 40], 0), 10);
    assert.equal(computePercentile([10, 20, 30, 40], 100), 40);
    // Nearest-rank would give 30 here.
    assert.notEqual(computePercentile([10, 20, 30, 40], 50), 30);
    assert.equal(computePercentile([5], 90), 5, 'one sample is every percentile');
    assert.equal(computePercentile([], 50), 0);
    // A percentile landing exactly on an index takes that element.
    assert.equal(computePercentile([0, 100], 50), 50);
});

test('computeDurationStats reports null for nothing, not a row of zeroes', () => {
    assert.equal(computeDurationStats([]), null);
    const stats = computeDurationStats([30, 10, 20, 40])!;
    // Sorted internally; the input order must not matter.
    assert.equal(stats.count, 4);
    assert.equal(stats.min, 10);
    assert.equal(stats.max, 40);
    assert.equal(stats.avg, 25);
    assert.equal(stats.median, 25);
    // The input is not mutated — a sort in place would reorder the caller's
    // array, and the caller here is a cached duration list.
    const input = [3, 1, 2];
    computeDurationStats(input);
    assert.deepEqual(input, [3, 1, 2]);
});

test('formatDurationMs changes units with magnitude, and em-dashes nothing', () => {
    // `old/test.html:552`, as literals.
    assert.equal(formatDurationMs(0), '—', 'a zero-millisecond run is a measurement that did not happen');
    assert.equal(formatDurationMs(100, false), '—');
    assert.equal(formatDurationMs(1), '1ms');
    assert.equal(formatDurationMs(999), '999ms');
    assert.equal(formatDurationMs(1000), '1.0s');
    assert.equal(formatDurationMs(59999), '60.0s');
    assert.equal(formatDurationMs(60000), '1m');
    assert.equal(formatDurationMs(93000), '1m 33s');
    assert.equal(formatDurationMs(3600000), '1h');
    assert.equal(formatDurationMs(3660000), '1h 1m');
    assert.equal(formatDurationMs(86400000), '1d');
    assert.equal(formatDurationMs(90000000), '1d 1h');
    // Whole units drop the smaller part rather than showing `1m 0s`.
    assert.equal(formatDurationMs(120000), '2m');
});

test('the histogram scales both layers to the OVERALL maximum', () => {
    // That shared scale is what makes a selection legible as a subset; scaling
    // each to its own maximum would make every selection look the same shape.
    const overall = computeHistogramBins([0, 0, 0, 0, 5, 10], 2, 0, 10);
    // Bin width 5: [0,5) holds the four zeros, [5,10] holds 5 and 10.
    assert.deepEqual(overall, [4, 2]);

    const subset = buildHistogram([5], { numBins: 2, rangeMin: 0, rangeMax: 10, overallBins: overall })!;
    assert.equal(subset.bars.length, 2);
    // The background is the overall shape: 4/4 and 2/4.
    assert.equal(subset.bars[0]!.backgroundPercent, 100);
    assert.equal(subset.bars[1]!.backgroundPercent, 50);
    // The foreground is the subset, against the SAME denominator: 0/4 and 1/4.
    assert.equal(subset.bars[0]!.hasForeground, false);
    assert.equal(subset.bars[1]!.hasForeground, true);
    assert.equal(subset.bars[1]!.foregroundPercent, 25);
    // Literals, not `formatDurationMs(0)` and friends: an expectation computed
    // by calling the formatter passes for every possible formatter, including a
    // broken one, and asserts only that the labels were produced by *some*
    // function of the bin edges.
    assert.deepEqual(subset.labels, ['—', '5ms', '10ms']);
});

test('the histogram gives a non-empty bin at least 1% height', () => {
    // One run in a bin next to a bin of 2,000 would otherwise be invisible.
    const overall = computeHistogramBins([...Array(2000).fill(1), 9], 2, 0, 10);
    const histogram = buildHistogram([9], { numBins: 2, rangeMin: 0, rangeMax: 10, overallBins: overall })!;
    assert.equal(histogram.bars[1]!.hasForeground, true);
    assert.ok(histogram.bars[1]!.foregroundPercent >= 1);
});

test('the histogram is null when there is no range to distribute over', () => {
    // Every run took the same time: there is nothing to show, and dividing by
    // a zero range would produce Infinity heights.
    assert.equal(buildHistogram([5, 5, 5]), null);
    assert.equal(buildHistogram([]), null);
    // A degenerate explicit range too.
    assert.equal(buildHistogram([1, 2, 3], { rangeMin: 7, rangeMax: 7 }), null);
});

test('a histogram bin tooltip names its range and its own count', () => {
    const histogram = buildHistogram([0, 10], { numBins: 2, rangeMin: 0, rangeMax: 20000 })!;
    assert.equal(histogram.bars[0]!.tooltip, '— – 10.0s: 2 runs');
    assert.equal(histogram.bars[1]!.tooltip, '10.0s – 20.0s: 0 runs');
    // Singular for one.
    const single = buildHistogram([0], { numBins: 2, rangeMin: 0, rangeMax: 20000 })!;
    assert.match(single.bars[0]!.tooltip, /: 1 run$/);
});

test('durations are collected only from passing runs, and split by cell', () => {
    const file = decoded(XPCSHELL);
    const path = 'toolkit/components/extensions/test/xpcshell/test_ext_proxy_speculative.js';
    const testId = testIdOf(XPCSHELL, path);
    const view = buildTestView(file, {
        testId,
        testPath: path,
        component: null,
        harness: 'xpcshell',
        stats: computeTestStats(file, testId),
        metadata: { days: 21, startTime: XPCSHELL.metadata.startTime },
    });
    const durations = collectDurations(file, testId, view.mappings);

    // The per-cell lists partition the overall list exactly.
    const perCellTotal = [...durations.byCell.values()].reduce((a, l) => a + l.length, 0);
    assert.equal(perCellTotal, durations.all.length);

    // And the count is the passing runs — the panel's "N passing runs" is
    // literal. `rawTotals` gives the independent figure.
    const raw = rawTotals(XPCSHELL, testId);
    const passes =
        (raw.get('PASS') ?? 0) + (raw.get('PASS-PARALLEL') ?? 0) + (raw.get('PASS-SEQUENTIAL') ?? 0);
    assert.equal(durations.all.length, passes);

    // Every cell the durations mention is a cell the table has.
    for (const key of durations.byCell.keys()) {
        assert.ok(view.jobTable.byCell.has(key), `${key} has durations but no table cell`);
    }
});

test('the runtime panel names one cell and counts several', () => {
    // `old/test.html:2424`. Six job names do not fit in a 420px header.
    assert.equal(runtimeTitleFor(new Set(), 'xpcshell'), 'Overall');
    assert.equal(runtimeTitleFor(new Set(['opt-xpcshell|linux-64']), 'xpcshell'), 'opt on linux-64');
    assert.equal(runtimeTitleFor(new Set(['a|x', 'b|y']), 'xpcshell'), '2 selected cells');
    assert.equal(runtimeTitleFor(new Set(['a|x', 'b|y', 'c|z']), 'xpcshell'), '3 selected cells');
});

test('a variant label drops the harness the page header already names', () => {
    assert.equal(variantLabel('opt-xpcshell', 'xpcshell'), 'opt');
    assert.equal(variantLabel('debug-xpcshell-msix', 'xpcshell'), 'debug msix');
    assert.equal(variantLabel('artifact-debug-xpcshell', 'xpcshell'), 'artifact-debug');
    assert.equal(variantLabel('opt-mochitest-browser-chrome', 'mochitest'), 'opt browser-chrome');
    assert.equal(
        variantLabel('debug-mochitest-browser-chrome-no-nv', 'mochitest'),
        'debug browser-chrome-no-nv'
    );
    // Only the page's own harness, and only as a whole word.
    assert.equal(variantLabel('opt-xpcshell', 'mochitest'), 'opt-xpcshell');
    assert.equal(variantLabel('opt-test-verify', 'mochitest'), 'opt-test-verify');
    assert.equal(variantLabel('xpcshell', 'xpcshell'), 'xpcshell');
    // The runtime title and the filter notice use the same label.
    assert.equal(
        runtimeTitleFor(new Set(['opt-mochitest-plain|linux-64']), 'mochitest'),
        'opt plain on linux-64'
    );
});

test('the runtime panel lists the six figures in order, or nothing at all', () => {
    assert.equal(buildRuntimePanel('Overall', []), null, 'no durations means no panel');

    const panel = buildRuntimePanel('Overall', [1000, 2000, 3000, 4000])!;
    assert.equal(panel.title, 'Overall');
    assert.equal(panel.subtitle, '4 passing runs');
    assert.deepEqual(
        panel.items.map((i) => i.label),
        ['Min', 'Avg', 'Median', 'P90', 'P95', 'Max']
    );
    assert.equal(panel.items[0]!.value, '1.0s');
    assert.equal(panel.items[5]!.value, '4.0s');
    // Avg of 1,2,3,4 seconds is 2.5s; median interpolates to 2.5s too.
    assert.equal(panel.items[1]!.value, '2.5s');
    assert.equal(panel.items[2]!.value, '2.5s');
    // The subtitle uses locale separators for large counts.
    assert.equal(buildRuntimePanel('x', new Array(1234).fill(500))!.subtitle, (1234).toLocaleString() + ' passing runs');
});

// --- the whole view ------------------------------------------------------

test('buildTestView derives the header fields from the path alone', () => {
    const file = decoded(MOCHITEST);
    const path = 'layout/base/tests/chrome/test_bug551434.html';
    const testId = testIdOf(MOCHITEST, path);
    const view = buildTestView(file, {
        testId,
        testPath: path,
        component: 'Core :: Layout',
        harness: 'mochitest',
        stats: computeTestStats(file, testId),
        metadata: {
            days: 21,
            startTime: MOCHITEST.metadata.startTime,
            startDate: MOCHITEST.metadata.startDate,
            endDate: MOCHITEST.metadata.endDate,
        },
    });

    assert.equal(view.testName, 'test_bug551434.html');
    assert.equal(view.documentTitle, 'test_bug551434.html - Test Info');
    assert.equal(view.searchfoxUrl, `https://searchfox.org/mozilla-central/source/${path}`);
    assert.equal(view.component, 'Core :: Layout');
    assert.equal(view.harness, 'mochitest');
    assert.equal(view.dateRangeText, '21 days (2026-07-14 to 2026-08-03)');
    assert.equal(view.jobTableDateInfo, '21 days, 2026-07-14 to 2026-08-03');
    // 42 failures out of 8,691: not 100%, so the favicon is orange.
    assert.equal(view.healthy, false);
});

test('the date phrases are empty rather than partial when the metadata is', () => {
    const file = decoded(MOCHITEST);
    const path = 'layout/base/tests/chrome/test_bug551434.html';
    const testId = testIdOf(MOCHITEST, path);
    const view = buildTestView(file, {
        testId,
        testPath: path,
        component: null,
        harness: 'mochitest',
        stats: computeTestStats(file, testId),
        // No startDate/endDate: a daily file's shape.
        metadata: { days: 21, startTime: MOCHITEST.metadata.startTime, date: '2026-08-03' },
    });
    assert.equal(view.dateRangeText, '', 'no half-written range');
    // The job-table heading falls back to the single date.
    assert.equal(view.jobTableDateInfo, '2026-08-03');
});

test('healthy is true only at exactly 100%', () => {
    const file = decoded(MOCHITEST);
    const build = (path: string) => {
        const testId = testIdOf(MOCHITEST, path);
        return buildTestView(file, {
            testId,
            testPath: path,
            component: null,
            harness: 'mochitest',
            stats: computeTestStats(file, testId),
            metadata: { days: 21, startTime: MOCHITEST.metadata.startTime },
        });
    };
    assert.equal(build('dom/canvas/test/webgl-mochitest/test_webgl_high_power.html').healthy, true);
    // 99.52% is not 100%.
    assert.equal(build('layout/base/tests/chrome/test_bug551434.html').healthy, false);
    // A test that ran and crashed twice is not healthy either.
    assert.equal(build('browser/components/sessionstore/test/browser_revive_crashed_bg_tabs.js').healthy, false);
});

test('every fixture test builds a coherent view', () => {
    // A sweep rather than a spot check: the invariants that must hold for any
    // test, asserted on all 20 in the two fixtures. This is what catches a
    // shape the hand-picked cases do not have.
    for (const fixtureFile of [XPCSHELL, MOCHITEST]) {
        const file = decoded(fixtureFile);
        for (let testId = 0; testId < fixtureFile.testRuns.length; testId++) {
            if (!fixtureFile.testRuns[testId]) {
                continue;
            }
            const identity = file.testAt(testId);
            const stats = computeTestStats(file, testId);
            const view = buildTestView(file, {
                testId,
                testPath: identity.fullPath,
                component: identity.component,
                harness: 'xpcshell',
                stats,
                metadata: { days: 21, startTime: fixtureFile.metadata.startTime },
            });
            const where = identity.fullPath;

            // The summary's Runs figure is the stats' runCount, formatted.
            assert.equal(view.summary[0]!.value, stats.runCount.toLocaleString(), where);
            // The daily rates cover the window with no gaps.
            assert.equal(view.rates.length, 21, where);
            // The job table's cells total the whole-test outcome counts, with
            // `run-if` skips excluded from both — `rawTotals` is the
            // independent side.
            let tableRuns = 0;
            for (const cell of view.jobTable.byCell.values()) {
                tableRuns += cell.passes + cell.failures + cell.timeouts + cell.crashes;
            }
            assert.equal(tableRuns, stats.runCount, `${where}: table runs vs stats runCount`);
            // Issue counts never exceed the totals they are drawn from.
            const failRows = view.issues.filter((i) => i.type === 'FAIL');
            assert.equal(
                failRows.reduce((a, i) => a + i.count, 0),
                stats.failCount,
                `${where}: FAIL rows`
            );
            assert.equal(
                view.issues.filter((i) => i.type === 'CRASH').reduce((a, i) => a + i.count, 0),
                stats.crashCount,
                `${where}: CRASH rows`
            );
            assert.equal(
                view.issues.filter((i) => i.type === 'TIMEOUT').reduce((a, i) => a + i.count, 0),
                stats.timeoutCount,
                `${where}: TIMEOUT rows`
            );
            // Skip rows can total LESS than skipCount: a skip with no message
            // is dropped from the list (`old/test.html:791`) because there is
            // nothing to label the row with. It must never total MORE.
            assert.ok(
                view.issues.filter((i) => i.type === 'SKIP').reduce((a, i) => a + i.count, 0) <=
                    stats.skipCount,
                `${where}: SKIP rows exceed the skip count`
            );
        }
    }
});

// --- cases the fixtures do not contain -----------------------------------
//
// Every test below was added because a mutation SURVIVED the suite: the code
// was right, the fixtures simply have no example, and "no example" is how a
// port's bug ships. Each states what the fixtures measured, so the reason the
// case is synthetic is on the record rather than being a bare hand-built input.

/** A synthetic decoded file, for cases the two fixtures do not contain. */
function syntheticFile(
    statuses: readonly string[],
    groups: readonly (Record<string, unknown> | null)[],
    extra: { jobNames?: string[]; messages?: string[]; crashSignatures?: string[] } = {}
): DecodedTimingFile {
    return decodeBucket({
        metadata: { days: 21, startTime: 1783987200, endDate: '2026-08-03' },
        tables: {
            jobNames: extra.jobNames ?? ['test-linux2404-64/opt-xpcshell'],
            testPaths: ['dir'],
            testNames: ['test_x.js'],
            statuses: [...statuses],
            taskIds: ['aaa.0', 'bbb.0', 'ccc.0'],
            messages: extra.messages ?? [],
            crashSignatures: extra.crashSignatures ?? [],
            components: ['C :: D'],
        },
        taskInfo: { jobNameIds: [0, 0, 0], chunks: [null, null, null] },
        testInfo: { testPathIds: [0], testNameIds: [0], componentIds: [0] },
        testRuns: [[...groups]],
    } as unknown as BucketFile);
}

test('a crash with no signature gets the synthetic CRASH row', () => {
    // MEASURED: 0 of the 26 crashes across both fixtures have a null
    // signature, so nothing here exercises the branch — the mutation that
    // deleted it survived. `FORMATS.md` counts 58 such crashes in the full
    // sweep, always the ones whose minidump was never uploaded, so the case is
    // real and simply not in the cut.
    const file = syntheticFile(
        ['PASS', 'CRASH'],
        [
            { days: [0], durations: [[100, 200]], jobNameIds: [0] },
            // Two crashes: one symbolized, one not.
            {
                days: [0, 1],
                taskIdIds: [[0], [1]],
                crashSignatureIds: [0, null],
                minidumps: [['dump-a'], [null]],
            },
        ],
        { crashSignatures: ['@ Foo::Bar'] }
    );
    const stats = computeTestStats(file, 0);
    assert.equal(stats.crashCount, 2);

    const crashRows = buildIssues(file, 0, stats).filter((i) => i.type === 'CRASH');
    assert.equal(crashRows.length, 2);
    // The named one, and the remainder under the placeholder — so the rows
    // still total the summary bar's Crashes figure.
    assert.deepEqual(
        crashRows.map((r) => [r.message, r.count]).sort(),
        [
            ['@ Foo::Bar', 1],
            [CRASH_NO_SIGNATURE, 1],
        ].sort()
    );
    assert.equal(crashRows.reduce((a, r) => a + r.count, 0), stats.crashCount);
});

test('`run-if` skips never appear in the issue list, the table or the matrix', () => {
    // MEASURED: 0 `run-if` skips in either fixture — the 21-day aggregates drop
    // them upstream (`lib/query/test-stats.ts`), and these are aggregates. So
    // three separate mutations removing the filter all survived. The daily
    // files keep them, and `FORMATS.md` measured 63.6% of skipped runs on one
    // day being `run-if`, so getting this wrong would be a 2.7× error on any
    // family that carries them.
    const file = syntheticFile(
        ['PASS', 'SKIP'],
        [
            { days: [0], durations: [[100]], jobNameIds: [0] },
            // Two skip entries on the same job: one `skip-if`, one `run-if`.
            { days: [0, 0], counts: [7, 900], jobNameIds: [0, 0], messageIds: [0, 1] },
        ],
        { messages: ['skip-if: os == "win"', 'run-if: os == "android"'] }
    );

    // The issue list: only the `skip-if`, with its prefix stripped.
    const stats = computeTestStats(file, 0);
    assert.equal(stats.skipCount, 7, 'the 900 run-if skips are not skips');
    assert.equal(stats.runIfSkipCount, 900);
    const skipRows = buildIssues(file, 0, stats).filter((i) => i.type === 'SKIP');
    assert.deepEqual(skipRows.map((r) => [r.message, r.count]), [['os == "win"', 7]]);

    // The job table's cell.
    const view = buildTestView(file, {
        testId: 0,
        testPath: 'dir/test_x.js',
        component: null,
        harness: 'xpcshell',
        stats,
        metadata: { days: 21, startTime: 1783987200 },
    });
    const cell = view.jobTable.rows[0]!.cells[0]!;
    assert.equal(cell.outcomes!.skips, 7);
    assert.notEqual(cell.outcomes!.skips, 907);
    // The SKIP badge names only the reportable reason.
    assert.equal(cell.badges.find((b) => b.kind === 'skip')!.tooltip, '7 skips\nos == "win"');

    // And the day/cell matrix, which every filtered view reads.
    const matrix = buildDayCellMatrix(file, 0, view.mappings, { days: 21 });
    assert.equal(matrix[0]!.get(cell.key)!.skips, 7);
});

test('an entry past the end of the window is dropped from the matrix', () => {
    // MEASURED: every entry in both fixtures falls inside the 21 days, so the
    // bound was never exercised and removing it survived. A `days` array can
    // legitimately run past the window — the generator emits one entry per
    // observed day and the page asks for a fixed 21 — and an out-of-range
    // index would index past the matrix and throw, or silently land nowhere.
    const file = syntheticFile(
        ['PASS'],
        // Day deltas summing to 0, 1 and 25: the last is outside a 21-day view.
        [{ days: [0, 1, 24], durations: [[1], [2], [3]], jobNameIds: [0, 0, 0] }]
    );
    const mappings = computeDisplayMappings([]);
    const matrix = buildDayCellMatrix(file, 0, mappings, { days: 21 });
    assert.equal(matrix.length, 21);
    const total = matrix.reduce(
        (a, day) => a + [...day.values()].reduce((b, c) => b + c.passes, 0),
        0
    );
    assert.equal(total, 2, 'the day-25 run is outside the window');

    // The daily rates apply the same bound, so the chart and the matrix agree.
    const rates = dailyRates(file, 0, { days: 21, startTime: 1783987200 });
    assert.equal(rates.reduce((a, r) => a + r.passes, 0), 2);
});

test('a day filter distinguishes "nothing ran" from "only skipped"', () => {
    // MEASURED: no fixture cell is skip-only on one day and active on another,
    // so two mutations conflating the two states survived. The distinction is
    // what the em-dash means: an em-dash says CI did not schedule it that day,
    // and a SKIP badge says it did and disabled it. Those are different facts.
    const cell = {
        variant: 'v',
        platform: 'p',
        key: 'v|p',
        outcomes: { passes: 4, failures: 0, timeouts: 0, crashes: 0, skips: 3 },
        badges: [
            { kind: 'pass' as const, label: 'PASS', percentText: null, tooltip: '4 runs' },
            { kind: 'skip' as const, label: 'SKIP', percentText: null, tooltip: '3 skips' },
        ],
        hasPassPrefixLayer: false,
        noHover: false,
    };
    const matrix = [
        // Day 0: ran.
        new Map([['v|p', { passes: 4, failures: 0, timeouts: 0, crashes: 0, skips: 0 }]]),
        // Day 1: scheduled and skipped — NOT the same as absent.
        new Map([['v|p', { passes: 0, failures: 0, timeouts: 0, crashes: 0, skips: 3 }]]),
        // Day 2: nothing at all.
        new Map<string, Outcomes>(),
    ];

    const skipDay = filteredCell(cell, matrix, new Set([1]));
    assert.equal(skipDay.noData, false, 'a skip is data: the em-dash must not show');
    assert.equal(skipDay.noHover, false, 'a skip-only day is still worth hovering');
    assert.equal(skipDay.badges.get('skip')!.visible, true);
    assert.equal(skipDay.badges.get('skip')!.tooltip, '3 skips');
    assert.equal(skipDay.badges.get('pass')!.visible, false);

    const emptyDay = filteredCell(cell, matrix, new Set([2]));
    assert.equal(emptyDay.noData, true, 'nothing scheduled: the em-dash');
    assert.equal(emptyDay.noHover, true);

    const ranDay = filteredCell(cell, matrix, new Set([0]));
    assert.equal(ranDay.noData, false);
    assert.equal(ranDay.noHover, true, 'pass-only is not hoverable');
    assert.equal(ranDay.badges.get('pass')!.tooltip, '4 runs');
});

test('the swr precheck keeps a non-linux swr variant apart', () => {
    // MEASURED: all 15 swr job names in `mochitest-00.json` are linux, so
    // weakening `every` to `some` changed nothing and the mutation survived.
    // The precheck exists because swr means software WebRender, which is a
    // linux-only configuration — a windows job carrying the token is not the
    // same thing and folding it into the base would merge two configurations.
    const row = (jobName: string) => ({
        jobName,
        state: 'ok' as const,
        runCount: 10,
        passCount: 10,
        failCount: 0,
        timeoutCount: 0,
        crashCount: 0,
        expectedFailCount: 0,
        skipCount: 0,
        runIfSkipCount: 0,
        skipMessages: new Map<string, number>(),
    });

    // A variant that runs on BOTH linux and windows: `every` says no, `some`
    // says yes, and the two answers differ — which is the mutation this kills.
    const mixed = computeDisplayMappings([
        row('test-linux2404-64/opt-mochitest'),
        row('test-windows11-64-25h2/opt-mochitest'),
        row('test-linux2404-64/opt-mochitest-swr'),
        row('test-windows11-64-25h2/opt-mochitest-swr'),
    ]);
    assert.equal(
        mixed.variantCollapse['opt-mochitest-swr'],
        undefined,
        'swr spanning windows must not collapse'
    );

    // The same shape restricted to linux does collapse, so the assertion above
    // is about the precheck rather than about collapsing being broken.
    const linuxOnly = computeDisplayMappings([
        row('test-linux2404-64/opt-mochitest'),
        row('test-linux2404-64/opt-mochitest-swr'),
    ]);
    assert.equal(linuxOnly.variantCollapse['opt-mochitest-swr'], 'opt-mochitest');
});

test('a platform absent from one variant is not itself a reason to split', () => {
    // MEASURED: no fixture test has a variant present on one sub-platform and
    // missing from the other, so dropping the `!== 'absent'` filter survived.
    // The filter is what stops "ran on 64, never scheduled on 32" from reading
    // as a behavioural difference — it is a scheduling fact, not an outcome.
    const row = (jobName: string, failures = 0) => ({
        jobName,
        state: 'ok' as const,
        runCount: 10 + failures,
        passCount: 10,
        failCount: failures,
        timeoutCount: 0,
        crashCount: 0,
        expectedFailCount: 0,
        skipCount: 0,
        runIfSkipCount: 0,
        skipMessages: new Map<string, number>(),
    });

    // Variant A runs on both and behaves the same; variant B runs on 64 only.
    // Signatures are ['p','p'] and ['p','absent'] — with the filter, one
    // distinct value each, so the columns merge.
    const merged = computeDisplayMappings([
        row('test-windows11-64-25h2/opt-a'),
        row('test-windows11-32-25h2/opt-a'),
        row('test-windows11-64-25h2/opt-b'),
    ]);
    assert.equal(merged.platformCollapse['windows-64'], 'windows');
    assert.equal(merged.platformCollapse['windows-32'], 'windows');

    // And a real outcome difference still splits them, so the merge above is
    // the filter working rather than the split being broken.
    const split = computeDisplayMappings([
        row('test-windows11-64-25h2/opt-a'),
        row('test-windows11-32-25h2/opt-a', 5),
        row('test-windows11-64-25h2/opt-b'),
    ]);
    assert.equal(split.platformCollapse['windows-64'], 'windows-64');
    assert.equal(split.platformCollapse['windows-32'], 'windows-32');
});

test('nofis collapses BEFORE geckoview, or the nofis row is stranded', () => {
    // MEASURED: no fixture test has a `-geckoview-…-nofis` variant, so
    // swapping the two steps changed nothing and the mutation survived.
    // Upstream calls the ordering out explicitly (`old/test.html:648`): `nofis`
    // must run first so `X-geckoview-Y-nofis` can collapse against the
    // still-present `X-geckoview-Y` before geckoview is itself collapsed away.
    // Reversed, the nofis row lands on a name nothing else uses and stays a
    // row of its own.
    const row = (jobName: string) => ({
        jobName,
        state: 'ok' as const,
        runCount: 10,
        passCount: 10,
        failCount: 0,
        timeoutCount: 0,
        crashCount: 0,
        expectedFailCount: 0,
        skipCount: 0,
        runIfSkipCount: 0,
        skipMessages: new Map<string, number>(),
    });

    const configs = [
        row('test-android-em-14-x86_64/opt-mochitest-geckoview-nofis'),
        row('test-android-em-14-x86_64/opt-mochitest-geckoview'),
        row('test-linux2404-64/opt-mochitest'),
    ];
    const mappings = computeDisplayMappings(configs);

    // The chain exists: nofis → geckoview → the desktop base.
    assert.equal(
        mappings.variantCollapse['opt-mochitest-geckoview-nofis'],
        'opt-mochitest-geckoview'
    );
    assert.equal(mappings.variantCollapse['opt-mochitest-geckoview'], 'opt-mochitest');

    // Which is what lets all three land in one row.
    const table = buildJobTable(configs, mappings);
    assert.deepEqual(table.rows.map((r) => r.variant), ['opt-mochitest']);
    for (const jobName of configs.map((c) => c.jobName)) {
        assert.equal(displayVariantOf(mappings, jobName), 'opt-mochitest', jobName);
    }
});

/**
 * `Pass %` for a test that passed `pass` of `run` times.
 *
 * **Counts in, not a rate in.** This helper exists in this shape because the
 * version it replaces took `passRate` as a parameter and every call site
 * passed a literal (`at(2.675)`, `at(56.775)`). That tested only the *second*
 * of two roundings and never the division that produces the float, so it
 * confirmed a real off-by-one-hundredth as correct — `at(1.045)` was asserted
 * to be `'1.05%'` when the page it is a port of shows `1.04%` for every
 * `(pass, run)` that yields that rate (209/20000, 418/40000, …).
 *
 * `PARITY.md` §1: the tests must check the code against the thing the user
 * already trusts, not against itself. So the input here is what the data
 * actually holds — two counts — and `passRate` is derived exactly as
 * `computeTestStats` derives it.
 */
const passPctFor = (pass: number, run: number): string =>
    summaryStats({
        family: 'bucket',
        runCount: run,
        passCount: pass,
        failCount: run - pass,
        timeoutCount: 0,
        crashCount: 0,
        expectedFailCount: 0,
        unknownCount: 0,
        skipCount: 0,
        runIfSkipCount: 0,
        // `lib/query/test-stats.ts:164`, verbatim.
        passRate: run > 0 ? (pass / run) * 100 : null,
    })[1]!.value;

/** What `common-test-data.js:350` would print for the same counts. */
const upstreamPassPct = (pass: number, run: number): string =>
    `${run > 0 ? Math.round((pass / run) * 10000) / 100 : 0}%`;

test('Pass % rounds ONCE from the ratio, as the old page does', () => {
    // The defect this pins: `Math.round(passRate * 100) / 100` looks like the
    // same arithmetic but rounds a value that has already been multiplied by
    // 100, and the second rounding cannot recover what the first lost.
    //
    // MEASURED by exhaustive search over every `(pass, run)` with
    // `run <= 2000` — 2,001,000 pairs — comparing upstream's
    // `Math.round((p/r) * 10000) / 100` against `Math.round(((p/r)*100) * 100)
    // / 100`. **90 pairs disagree**, always with the double-rounded value one
    // hundredth LOW. These are the first of them, and `run = 160` is an
    // entirely ordinary count for this page: the pinned snapshot's 1,618 tests
    // with runs range from 23 to 28,568.
    for (const [pass, run, expected] of [
        [23, 160, '14.38%'],
        [41, 160, '25.63%'],
        [51, 160, '31.88%'],
        [87, 160, '54.38%'],
        [97, 160, '60.63%'],
        [29, 800, '3.63%'],
        [46, 320, '14.38%'],
    ] as const) {
        assert.equal(passPctFor(pass, run), expected, `${pass}/${run}`);
        // Stated twice on purpose: the literal above is what a reader can
        // check by hand, and this is the old page's own formula run on the
        // same counts. Neither is derived from `summaryStats`.
        assert.equal(passPctFor(pass, run), upstreamPassPct(pass, run));
    }

    // The case that made the bug survive its own test. `(209/20000)*100` is
    // exactly the float `1.045`, and the previous test fed that literal in and
    // asserted `'1.05%'` — which is what double-rounding produces and NOT what
    // the page shows. Upstream prints `1.04%`.
    assert.equal(passPctFor(209, 20000), '1.04%');
    assert.equal(upstreamPassPct(209, 20000), '1.04%');
    assert.notEqual(passPctFor(209, 20000), '1.05%');
});

test('Pass % agrees with the old page on every ratio, not just the sampled ones', () => {
    // The loop above pins seven pairs a reader can verify by eye; this is the
    // exhaustive version, and it is what makes the claim "rounds once" a
    // property rather than seven examples. Every `(pass, run)` with
    // `run <= 400` — 80,600 pairs — must render exactly what
    // `common-test-data.js:350` renders.
    //
    // Bounded at 400 to keep this test at ~0.2s; the 2,001,000-pair run over
    // `run <= 2000` was done once by hand and reported 0 differences after the
    // fix and 90 before it.
    let checked = 0;
    for (let run = 1; run <= 400; run++) {
        for (let pass = 0; pass <= run; pass++) {
            const got = passPctFor(pass, run);
            const want = upstreamPassPct(pass, run);
            if (got !== want) {
                assert.fail(`${pass}/${run}: page says ${got}, upstream says ${want}`);
            }
            checked++;
        }
    }
    assert.equal(checked, 80600);
});

test('Pass % drops trailing zeros, which toFixed(2) would keep', () => {
    // Upstream interpolates the NUMBER, so a rate of exactly 50 renders `50%`
    // and not `50.00%`. Driven from counts, so the rate is a real division.
    assert.equal(passPctFor(50, 100), '50%');
    assert.equal(passPctFor(100, 100), '100%');
    assert.equal(passPctFor(199, 200), '99.5%');
    // A test that never ran has no rate; the page shows 0%, not `NaN%`.
    assert.equal(passPctFor(0, 0), '0%');

    // `Math.round(x*100)/100` and `Number(x.toFixed(2))` also differ, and a
    // "simplification" to `toFixed` would move a headline figure by 0.01.
    // 27,252 of 48,000 runs is 56.775%: upstream shows 56.78%, `toFixed` 56.77%.
    assert.equal(passPctFor(27252, 48000), '56.78%');
    assert.equal(upstreamPassPct(27252, 48000), '56.78%');
    assert.equal(Number(((27252 / 48000) * 100).toFixed(2)), 56.77);
});

test('the Pass % colour threshold is < 90, so exactly 90% is NOT red', () => {
    // MEASURED: mutating `passPercentage < 90` to `<= 90` survived the whole
    // suite, because no fixture test lands on exactly 90.00% — the closest are
    // 89.9% and 90.6%. The boundary is a visible colour change on the page's
    // headline figure, so it is pinned with counts that hit it exactly.
    const classAt = (pass: number, run: number): string =>
        summaryStats({
            family: 'bucket',
            runCount: run,
            passCount: pass,
            failCount: run - pass,
            timeoutCount: 0,
            crashCount: 0,
            expectedFailCount: 0,
            unknownCount: 0,
            skipCount: 0,
            runIfSkipCount: 0,
            passRate: run > 0 ? (pass / run) * 100 : null,
        })[1]!.cssClass;

    // Exactly 90%: upstream's `passPercentage < 90` is false, so no class.
    assert.equal(passPctFor(90, 100), '90%');
    assert.equal(classAt(90, 100), '', '90% is the boundary and is NOT red');
    assert.equal(classAt(900, 1000), '');
    // A hair under, and it is red.
    assert.equal(passPctFor(8999, 10000), '89.99%');
    assert.equal(classAt(8999, 10000), 'fail');
    // A hair over, and it stays unclassed.
    assert.equal(classAt(9001, 10000), '');
    // 100% is the other boundary: green, and 99.99% is not.
    assert.equal(classAt(10000, 10000), 'good');
    assert.equal(classAt(9999, 10000), '');
});

test('an empty histogram bin draws no background bar at all', () => {
    // MEASURED: every fixture histogram has a non-zero count in its first bin,
    // so removing the background's 1% floor survived — the floor only shows on
    // a bin whose count is small relative to the tallest, and `hasBackground`
    // is what suppresses the bar entirely when the count is zero. The two are
    // easy to conflate: a 0-count bin must draw NOTHING, while a 1-count bin
    // next to a 2,000-count one must still draw something.
    const overall = computeHistogramBins([0, 0, 5, 5, 5, 5, 9], 3, 0, 9);
    // Bin width 3: [0,3) has the two zeros, [3,6) has the four fives, [6,9]
    // has the nine.
    assert.deepEqual(overall, [2, 4, 1]);

    const histogram = buildHistogram([0, 0, 5, 5, 5, 5, 9], {
        numBins: 3,
        rangeMin: 0,
        rangeMax: 9,
        overallBins: overall,
    })!;
    assert.deepEqual(histogram.bars.map((b) => b.hasBackground), [true, true, true]);
    // Heights are relative to the tallest bin, which is 4.
    assert.equal(histogram.bars[1]!.backgroundPercent, 100);
    assert.equal(histogram.bars[0]!.backgroundPercent, 50);

    // A genuinely empty bin: no bar, and its height is not consulted.
    const gappy = computeHistogramBins([0, 9], 3, 0, 9);
    assert.deepEqual(gappy, [1, 0, 1]);
    const withGap = buildHistogram([0, 9], {
        numBins: 3,
        rangeMin: 0,
        rangeMax: 9,
        overallBins: gappy,
    })!;
    assert.deepEqual(withGap.bars.map((b) => b.hasBackground), [true, false, true]);

    // And the floor: one run against a very tall bin still draws.
    const lopsided = computeHistogramBins([...new Array(500).fill(1), 8], 2, 0, 10);
    assert.deepEqual(lopsided, [500, 1]);
    const floored = buildHistogram([...new Array(500).fill(1), 8], {
        numBins: 2,
        rangeMin: 0,
        rangeMax: 10,
        overallBins: lopsided,
    })!;
    assert.equal(floored.bars[1]!.hasBackground, true);
    assert.equal(
        floored.bars[1]!.backgroundPercent,
        1,
        '1/500 would round to 0.2% and vanish; the floor lifts it to 1%'
    );
});

test('durations come only from passing entries, even when failures carry them', () => {
    // MEASURED: in both fixtures only the `durations`-shaped pass groups carry
    // durations at all, so removing the status filter changed nothing and the
    // mutation survived. The panel's label says "N passing runs", and a
    // failing run's duration is the time it took to fail — a different
    // quantity, and one that would skew every percentile.
    const file = syntheticFile(
        ['PASS', 'FAIL'],
        [
            { days: [0], durations: [[100, 200]], jobNameIds: [0] },
            // A FAIL group in the `durations` shape. Not what the generator
            // emits today, which is exactly why the filter must be explicit.
            { days: [0], durations: [[99999]], jobNameIds: [0] },
        ]
    );
    const mappings = computeDisplayMappings([]);
    const durations = collectDurations(file, 0, mappings);
    assert.deepEqual([...durations.all].sort((a, b) => a - b), [100, 200]);
    assert.ok(!durations.all.includes(99999), 'a failing run’s duration is not a run time');

    const panel = buildRuntimePanel('Overall', durations.all)!;
    assert.equal(panel.subtitle, '2 passing runs');
    // The literal, not `formatDurationMs(200)`: the point of the assertion is
    // which *duration* reached the panel, and calling the formatter to build
    // the expectation would pass even if the panel had picked 99,999 ms and the
    // formatter had been changed to render it as this string.
    assert.equal(panel.items[5]!.value, '200ms', 'Max is 200ms, not 99999ms');
});

test('the synthetic placeholders are the exact strings the old page used', () => {
    // Pinned as literals: they are matched against by the run-list filter, so
    // a change to either string silently empties an expanded issue rather than
    // failing.
    assert.equal(
        FAILURE_NO_MESSAGE,
        'Failure details not recorded (likely Android or platform logging issue)'
    );
    assert.equal(CRASH_NO_SIGNATURE, 'Crash signature not recorded');
});
