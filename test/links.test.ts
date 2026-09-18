/**
 * `lib/links.ts`, exhaustively.
 *
 * Pure string construction, so there is no reason not to assert the exact
 * output of every builder — and a reason to: these URLs are currently written
 * inline in several pages, so the port is only safe if it produces the same
 * strings. Several assertions below are literal URLs copied from what
 * `common-links.js` builds for the same inputs.
 *
 * The split between the raw artifact URL and the profiler front-end wrapper is
 * the part of this module that is a design change rather than a move, so it
 * gets the most attention: a test that the two compose back into the old
 * behaviour, and a test that the CLI's path yields something `profiler-cli`
 * can actually fetch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_PROFILER_ORIGIN,
    FIREFOX_CI_ROOT,
    TREEHERDER_ROOT,
    bugDescription,
    bugzillaFilingUrl,
    crashStatsSearchUrl,
    crashViewerUrl,
    messageLineNumber,
    minidumpJsonUrl,
    parseFileInfo,
    profilerFrontEndUrl,
    resolveProfilerOrigin,
    resourceUsageProfileUrl,
    searchfoxFrameUrl,
    searchfoxUrl,
    sourceUrl,
    taskArtifactUrl,
    testInfoArtifactUrl,
    treeherderJobUrl,
    treeherderPushUrl,
    uploadedProfileName,
    uploadedProfileUrl,
} from '../lib/links.ts';

const TASK = 'YJJe4a0CRIqbAmcCo8n63w';

// --- Taskcluster artifacts -----------------------------------------------

test('taskArtifactUrl builds the queue-API path', () => {
    assert.equal(
        taskArtifactUrl(TASK, 0, 'public/test_info/foo.json'),
        `${FIREFOX_CI_ROOT}/api/queue/v1/task/${TASK}/runs/0/artifacts/public/test_info/foo.json`
    );
    // The retry is the `runs/<n>` segment — the job-level axis, not the
    // harness's within-job rerun.
    assert.match(taskArtifactUrl(TASK, 3, 'public/x'), /\/runs\/3\//);
});

test('testInfoArtifactUrl is the test harness upload directory', () => {
    assert.equal(
        testInfoArtifactUrl(TASK, 1, 'profile_foo.js.json'),
        `${FIREFOX_CI_ROOT}/api/queue/v1/task/${TASK}/runs/1/artifacts/public/test_info/profile_foo.js.json`
    );
});

// --- profiles: the split -------------------------------------------------

test('resourceUsageProfileUrl is derivable from the task ID alone', () => {
    // Fixed path, so it is available for any job whether or not anything
    // failed. This is the raw URL, which is what `profiler-cli` fetches.
    assert.equal(
        resourceUsageProfileUrl(TASK, 0),
        `${FIREFOX_CI_ROOT}/api/queue/v1/task/${TASK}/runs/0/artifacts/public/test_info/profile_resource-usage.json`
    );
    // It is a URL to a JSON artifact, not to a front end.
    assert.ok(!resourceUsageProfileUrl(TASK, 0).includes('profiler.firefox.com'));
    assert.ok(resourceUsageProfileUrl(TASK, 0).endsWith('.json'));
});

test('uploadedProfileName reads the filename out of a failure message', () => {
    assert.equal(
        uploadedProfileName(
            'Found unexpected failures during the test; profile uploaded in profile_test_foo.js.json'
        ),
        'profile_test_foo.js.json'
    );
    // The name is not derivable, so anything that does not say it yields null.
    assert.equal(uploadedProfileName('Assertion failed: frecency of 100 != 120'), null);
    assert.equal(uploadedProfileName(''), null);
    assert.equal(uploadedProfileName(null), null);
    assert.equal(uploadedProfileName(undefined), null);
    // A message naming something that is not a profile artifact.
    assert.equal(uploadedProfileName('profile uploaded in somewhere else'), null);
});

test('uploadedProfileName keeps the .gz of a gzipped profile', () => {
    // Test jobs upload the profile gzipped. The whole extension belongs to the
    // filename: `.json` is a *prefix* of `.json.gz`, so a pattern ending at
    // `.json` still matches a gzipped name, backtracks to the shorter boundary
    // and returns a truncated filename — which is a URL that 404s rather than a
    // null the callers already handle.
    assert.equal(
        uploadedProfileName(
            'Found unexpected failures during the test; profile uploaded in profile_test_foo.js.json.gz'
        ),
        'profile_test_foo.js.json.gz'
    );
    // Older uploads predate the change and their messages are served unchanged.
    assert.equal(
        uploadedProfileName('profile uploaded in profile_test_foo.js.json'),
        'profile_test_foo.js.json'
    );
});

test('uploadedProfileUrl points at the gzipped artifact that exists', () => {
    // The truncated name would be a well-formed URL to a missing artifact, so
    // this is the assertion that the link actually resolves.
    assert.equal(
        uploadedProfileUrl(TASK, 2, 'test failed; profile uploaded in profile_browser_tabs.js.json.gz'),
        `${FIREFOX_CI_ROOT}/api/queue/v1/task/${TASK}/runs/2/artifacts/public/test_info/profile_browser_tabs.js.json.gz`
    );
});

test('uploadedProfileUrl returns nothing rather than guessing a filename', () => {
    const message = 'test failed; profile uploaded in profile_browser_tabs.js.json';
    assert.equal(
        uploadedProfileUrl(TASK, 2, message),
        `${FIREFOX_CI_ROOT}/api/queue/v1/task/${TASK}/runs/2/artifacts/public/test_info/profile_browser_tabs.js.json`
    );
    // The whole point: where no profile was uploaded, no URL is emitted. A
    // guessed filename would 404 and look like an expired artifact.
    assert.equal(uploadedProfileUrl(TASK, 0, 'some other failure'), null);
    assert.equal(uploadedProfileUrl(TASK, 0, null), null);
});

test('profilerFrontEndUrl wraps a raw URL and is separable from it', () => {
    const raw = resourceUsageProfileUrl(TASK, 0);
    const wrapped = profilerFrontEndUrl(raw, {
        profileName: 'test-linux2404-64/opt-xpcshell (ABC.0)',
        markerSearch: 'test_frecency.js',
    });

    // Composing the two reproduces `getProfilerUrl()` (`common-links.js:16`)
    // exactly, which is what makes this a port rather than a rewrite.
    assert.equal(
        wrapped,
        `${DEFAULT_PROFILER_ORIGIN}/from-url/${encodeURIComponent(raw)}` +
            `?profileName=${encodeURIComponent('test-linux2404-64/opt-xpcshell (ABC.0)')}` +
            `&markerSearch=${encodeURIComponent('test_frecency.js')}`
    );

    // The raw URL survives round-tripping through the wrapper, which is what
    // lets a page show the wrapper and the CLI print the bare URL.
    const fromUrl = new URL(wrapped);
    const encoded = fromUrl.pathname.slice('/from-url/'.length);
    assert.equal(decodeURIComponent(encoded), raw);
});

test('profilerFrontEndUrl omits absent query parameters entirely', () => {
    const raw = resourceUsageProfileUrl(TASK, 0);
    assert.equal(
        profilerFrontEndUrl(raw),
        `${DEFAULT_PROFILER_ORIGIN}/from-url/${encodeURIComponent(raw)}`
    );
    assert.ok(!profilerFrontEndUrl(raw).includes('?'));
    assert.match(profilerFrontEndUrl(raw, { profileName: 'x' }), /\?profileName=x$/);
    assert.match(profilerFrontEndUrl(raw, { markerSearch: 'x' }), /\?markerSearch=x$/);
});

test('resolveProfilerOrigin expands the developer shorthands', () => {
    assert.equal(resolveProfilerOrigin(null), DEFAULT_PROFILER_ORIGIN);
    assert.equal(resolveProfilerOrigin(''), DEFAULT_PROFILER_ORIGIN);
    assert.equal(resolveProfilerOrigin('localhost'), 'http://localhost:4242');
    assert.equal(
        resolveProfilerOrigin('dp1234'),
        'https://deploy-preview-1234--perf-html.netlify.app'
    );
    // A bare hostname gets https; a full URL is taken as given.
    assert.equal(resolveProfilerOrigin('example.com'), 'https://example.com');
    assert.equal(resolveProfilerOrigin('http://example.com'), 'http://example.com');
    // A trailing slash is stripped, so the origin never doubles it.
    assert.equal(resolveProfilerOrigin('https://example.com/'), 'https://example.com');
});

test('a custom origin flows through to the wrapper', () => {
    const raw = resourceUsageProfileUrl(TASK, 0);
    assert.match(
        profilerFrontEndUrl(raw, { origin: resolveProfilerOrigin('localhost') }),
        /^http:\/\/localhost:4242\/from-url\//
    );
});

// --- crash dumps ---------------------------------------------------------

test('minidumpJsonUrl is the raw dump, crashViewerUrl the page wrapper', () => {
    const dumpId = '12345678-abcd-1234-abcd-1234567890ab';
    const raw = minidumpJsonUrl(TASK, 0, dumpId);
    assert.equal(
        raw,
        `${FIREFOX_CI_ROOT}/api/queue/v1/task/${TASK}/runs/0/artifacts/public/test_info/${dumpId}.json`
    );
    // Same split as the profiles: the CLI reads the raw JSON, the page opens
    // the viewer.
    assert.equal(crashViewerUrl(TASK, 0, dumpId), `crash-viewer.html?url=${encodeURIComponent(raw)}`);
});

// --- Treeherder ----------------------------------------------------------

test('treeherderJobUrl selects the task run', () => {
    const url = treeherderJobUrl('try', 'abc123', TASK, 2);
    assert.equal(
        url,
        `${TREEHERDER_ROOT}/jobs?repo=try&selectedTaskRun=${TASK}.2&revision=abc123`
    );
    // The suffixed form is what the timing files store, so a task ID copied
    // from any other command works unchanged.
    assert.ok(url.includes(`${TASK}.2`));
});

test('treeherderPushUrl points at the whole push', () => {
    assert.equal(
        treeherderPushUrl('mozilla-central', 'deadbeef'),
        `${TREEHERDER_ROOT}/jobs?repo=mozilla-central&revision=deadbeef`
    );
});

test('Treeherder URLs encode their parameters', () => {
    const url = treeherderJobUrl('try', 'a b', 'x/y', 0);
    assert.ok(!url.includes('a b'), 'the revision must be encoded');
    assert.ok(url.includes('x%2Fy'), 'the task ID must be encoded');
});

// --- Searchfox -----------------------------------------------------------

test('searchfoxUrl anchors at the line a failure message names', () => {
    assert.equal(
        searchfoxUrl('dom/base/test/test_selection.html'),
        'https://searchfox.org/mozilla-central/source/dom/base/test/test_selection.html'
    );
    assert.equal(
        searchfoxUrl('dom/base/test/test_selection.html', '[child : 42] assertion failed'),
        'https://searchfox.org/mozilla-central/source/dom/base/test/test_selection.html#42'
    );
    // A message with no bracketed line prefix leaves the URL unanchored.
    assert.equal(
        searchfoxUrl('a/b.js', 'assertion failed'),
        'https://searchfox.org/mozilla-central/source/a/b.js'
    );
    assert.equal(searchfoxUrl('a/b.js', null), 'https://searchfox.org/mozilla-central/source/a/b.js');
    // The prefix must be at the start and must have the `name : digits` shape.
    assert.ok(!searchfoxUrl('a/b.js', 'x [child : 42] y').includes('#'));
    assert.ok(!searchfoxUrl('a/b.js', '[child : abc] y').includes('#'));
});

test('messageLineNumber reads the same line without building a URL', () => {
    assert.equal(messageLineNumber('[child : 42] assertion failed'), 42);
    assert.equal(messageLineNumber('[main : 1284] boom'), 1284);
    assert.equal(messageLineNumber('assertion failed'), null);
    assert.equal(messageLineNumber(null), null);
    assert.equal(messageLineNumber(undefined), null);
});

// --- Bugzilla ------------------------------------------------------------

test('bugzillaFilingUrl splits the component into product and component', () => {
    const url = bugzillaFilingUrl({
        testPath: 'dom/base/test/test_selection.html',
        summary: 'Assertion failed: selection.rangeCount == 1',
        component: 'Core :: DOM: Selection',
    });
    const params = new URL(url).searchParams;
    assert.equal(params.get('product'), 'Core');
    assert.equal(params.get('component'), 'DOM: Selection');
    assert.equal(
        params.get('short_desc'),
        'Intermittent dom/base/test/test_selection.html | Assertion failed: selection.rangeCount == 1'
    );
    assert.ok(params.get('comment')?.includes('searchfox.org'));
});

test('a malformed component throws rather than filing into the wrong product', () => {
    // Filing a bug in the wrong component is worse than not filing one, so
    // this is one of the few places the library refuses rather than guesses.
    assert.throws(
        () =>
            bugzillaFilingUrl({
                testPath: 'a/b.js',
                summary: 'boom',
                component: 'Core',
            }),
        /not in "Product :: Component" form/
    );
});

test('the bug description links the line when the message names one', () => {
    const withLine = bugDescription({
        testPath: 'a/b.js',
        summary: '[child : 42] boom',
        component: 'Core :: X',
    });
    // The bracketed prefix becomes the link text and the rest stays prose.
    assert.ok(withLine.includes('[[child : 42]](https://searchfox.org/mozilla-central/source/a/b.js#42) boom'));

    const withoutLine = bugDescription({
        testPath: 'a/b.js',
        summary: 'boom',
        component: 'Core :: X',
    });
    assert.ok(withoutLine.includes('Failure message: boom'));
    assert.ok(!withoutLine.includes('#'));
});

test('the bug description renders occurrence statistics when given them', () => {
    const description = bugDescription({
        testPath: 'a/b.js',
        summary: 'boom',
        component: 'Core :: X',
        stats: {
            failureCount: 21,
            totalRuns: 4812,
            firstDate: '2026-07-13',
            lastDate: '2026-08-02',
        },
        sourceUrl: 'https://tests.firefox.dev/test.html',
    });
    assert.ok(description.includes('occurred 21 times'));
    assert.ok(description.includes('out of 4,812 runs (0.44%)'));
    assert.ok(description.includes('between 2026-07-13 and 2026-08-02'));
    assert.ok(description.includes('(https://tests.firefox.dev/test.html)'));

    // One occurrence reads as prose, not as "occurred 1 times".
    const once = bugDescription({
        testPath: 'a/b.js',
        summary: 'boom',
        component: 'Core :: X',
        stats: { failureCount: 1, firstDate: '2026-08-02', lastDate: '2026-08-02' },
    });
    assert.ok(once.includes('occurred once'));
    assert.ok(once.includes('on 2026-08-02'));
    assert.ok(!once.includes('between'));

    // No stats at all means no sentence, rather than a sentence full of zeros.
    const bare = bugDescription({ testPath: 'a/b.js', summary: 'boom', component: 'Core :: X' });
    assert.ok(!bare.includes('This failure'));
});

// --- source references in a stackwalk ------------------------------------
//
// These moved here with `parseFileInfo`/`sourceUrl`/`searchfoxFrameUrl`/
// `crashStatsSearchUrl`, which used to live in the crash viewer's view model.
// They are URL construction over walker data and name nothing about a UI, so
// they belong beside the other builders — and their tests belong beside the
// other builders' tests rather than in a page's test file.

test('parseFileInfo reads both spellings and rejects anything else', () => {
    assert.deepEqual(parseFileInfo('hg:hg.mozilla.org/mozilla-central:xpcom/base/f.cpp:c536b16'), {
        type: 'hg',
        repo: 'hg.mozilla.org/mozilla-central',
        revision: 'c536b16',
        path: 'xpcom/base/f.cpp',
    });
    assert.deepEqual(
        parseFileInfo('git:github.com/rust-lang/rust:library/alloc/src/boxed.rs:05f98'),
        {
            type: 'git',
            repo: 'github.com/rust-lang/rust',
            revision: '05f98',
            path: 'library/alloc/src/boxed.rs',
        }
    );
    // A path containing a colon is put back together, which is why the parse
    // is a slice-and-join rather than a five-part destructure.
    assert.equal(
        parseFileInfo('hg:hg.mozilla.org/mozilla-central:a/b:c/d.cpp:rev')?.path,
        'a/b:c/d.cpp'
    );
    // Not a repository reference: shown as-is rather than linked somewhere
    // invented. All three spellings occur in `artifacts/dumps/`.
    assert.equal(parseFileInfo('/usr/include/stdio.h'), null);
    assert.equal(parseFileInfo('s3:gecko-generated-sources:abc/ipc/P.cpp:'), null);
    assert.equal(parseFileInfo('hg:only:three'), null);
    assert.equal(parseFileInfo(null), null);
    assert.equal(parseFileInfo(''), null);
});

test('the line anchor differs in case between hg and GitHub', () => {
    // Lowercase `#l` for hg.mozilla.org, uppercase `#L` for GitHub. Both are
    // upstream's, and the wrong case scrolls nowhere.
    assert.equal(
        sourceUrl('hg:hg.mozilla.org/mozilla-central:xpcom/base/f.cpp:c536b16', 177),
        'https://hg.mozilla.org/mozilla-central/file/c536b16/xpcom/base/f.cpp#l177'
    );
    assert.equal(
        sourceUrl('git:github.com/rust-lang/rust:library/alloc/src/boxed.rs:05f98', 1976),
        'https://github.com/rust-lang/rust/blob/05f98/library/alloc/src/boxed.rs#L1976'
    );
    // No line: no anchor, rather than `#l` with nothing after it.
    assert.equal(
        sourceUrl('hg:hg.mozilla.org/mozilla-central:xpcom/base/f.cpp:c536b16', null),
        'https://hg.mozilla.org/mozilla-central/file/c536b16/xpcom/base/f.cpp'
    );
    // Unparseable reference: no URL at all.
    assert.equal(sourceUrl('/usr/include/stdio.h', 12), null);
});

test('Searchfox links only Mozilla hg code, and names the tree not the repo', () => {
    assert.equal(
        searchfoxFrameUrl({
            function: 'Foo',
            file: 'hg:hg.mozilla.org/releases/mozilla-beta:netwerk/ipc/P.cpp:727346cd',
            line: 177,
        }),
        // `mozilla-beta`, not `releases/mozilla-beta`: the last path segment is
        // the tree name, and the whole string builds a URL with a stray slash.
        'https://searchfox.org/mozilla-beta/hgrev/727346cd/netwerk/ipc/P.cpp#177'
    );
    // A `git:` reference is vendored third-party code, which Searchfox does not
    // index under a Mozilla tree — linking there would 404.
    assert.equal(
        searchfoxFrameUrl({
            function: 'Foo',
            file: 'git:github.com/rust-lang/rust:library/alloc/src/boxed.rs:05f98',
            line: 10,
        }),
        null
    );
    // Missing any of function/file/line: no link. An unsymbolized frame has no
    // function to search for.
    assert.equal(searchfoxFrameUrl({ function: null, file: 'hg:a/b:c:d', line: 1 }), null);
    assert.equal(searchfoxFrameUrl({ function: 'Foo', file: null, line: 1 }), null);
    assert.equal(searchfoxFrameUrl({ function: 'Foo', file: 'hg:a/b:c:d', line: null }), null);
});

test('the crash-stats link strips the @ prefix and searches with ~', () => {
    // `~` is crash-stats' "contains"; the `@ ` prefix is the viewer's own and
    // is not in crash-stats' signatures, so leaving it on matches nothing.
    const url = crashStatsSearchUrl('@ mozilla::dom::Foo');
    assert.ok(url.startsWith('https://crash-stats.mozilla.org/search/?signature='));
    assert.equal(new URL(url).searchParams.get('signature'), '~mozilla::dom::Foo');
    // A signature that is a module+offset fallback keeps its spaces, which
    // must survive encoding rather than becoming `+`.
    assert.equal(
        new URL(crashStatsSearchUrl('@ libsystem_kernel.dylib + 0x0dfa')).searchParams.get(
            'signature'
        ),
        '~libsystem_kernel.dylib + 0x0dfa'
    );
});
