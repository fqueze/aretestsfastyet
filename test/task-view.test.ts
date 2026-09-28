/**
 * `task.html`'s view model, over profiles parsed by the shared marker parser.
 *
 * The aggregation is `lib/query/task-summary.ts` and is pinned by
 * `test/task-command.test.ts` through the CLI; these tests are about what only
 * the page does with it — the URL state, the all-tests rows and their
 * durations, crash-viewer links out of minidumps, and the artifact list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { type DroppedMarker, parseTestMarkers } from '../lib/model/test-markers.ts';
import { attachProvenance, summarize } from '../lib/query/task-summary.ts';
import {
    artifactRows,
    type ManifestGroup,
    type TestRow,
    artifactSizeFromHeaders,
    artifactSizesFromProfile,
    droppedViews,
    failureViews,
    flakinessRequestsForTask,
    formatAgo,
    formatRunLength,
    splitPath,
    formatBytes,
    hiddenRowsLabel,
    manifestStatus,
    noPermanentFailureNote,
    manifestGroups,
    manifestsFromSummary,
    outcomeSentence,
    outcomeTally,
    selectGroups,
    matchesTest,
    outcomeCounts,
    parseTaskInput,
    readParams,
    runFacts,
    selectRows,
    taskPageSearch,
    testRows,
} from '../site/task-view.ts';
import { sampleProfile } from './task-fixture.ts';

const TASK = 'K-PZiLvGQTWmnPPGkwMbpQ';
const ORIGIN = 'https://profiler.firefox.com';

test('a task is read out of an ID, a Treeherder URL or a Taskcluster URL', () => {
    assert.deepEqual(parseTaskInput(TASK), { taskId: TASK, retryId: 0 });
    assert.deepEqual(parseTaskInput(` ${TASK}.2 `), { taskId: TASK, retryId: 2 });
    assert.deepEqual(
        parseTaskInput(
            `https://treeherder.mozilla.org/jobs?repo=autoland&selectedTaskRun=${TASK}.1&revision=abc`
        ),
        { taskId: TASK, retryId: 1 }
    );
    assert.deepEqual(
        parseTaskInput(`https://firefox-ci-tc.services.mozilla.com/tasks/${TASK}/runs/3/logs`),
        { taskId: TASK, retryId: 3 }
    );
    assert.deepEqual(parseTaskInput(`https://firefox-ci-tc.services.mozilla.com/tasks/${TASK}`), {
        taskId: TASK,
        retryId: 0,
    });
    assert.equal(parseTaskInput('not a task'), null);
    assert.equal(parseTaskInput(''), null);
});

test('the URL round-trips, with the test to highlight', () => {
    const search = taskPageSearch(TASK, 1, 'dom/base/test/browser_a.js');
    assert.equal(search, `?task=${TASK}.1&test=dom%2Fbase%2Ftest%2Fbrowser_a.js`);
    assert.deepEqual(readParams(search), {
        taskId: TASK,
        retryId: 1,
        test: 'dom/base/test/browser_a.js',
    });
    assert.deepEqual(readParams(`?task=${TASK}`), { taskId: TASK, retryId: 0, test: null });
    assert.equal(readParams('?test=x'), null);
});

test('a linking page may name the test by path or by bare file name', () => {
    assert.equal(matchesTest('dom/base/test/browser_a.js', 'dom/base/test/browser_a.js'), true);
    assert.equal(matchesTest('dom/base/test/browser_a.js', 'browser_a.js'), true);
    assert.equal(matchesTest('dom/base/test/xbrowser_a.js', 'browser_a.js'), false);
    assert.equal(matchesTest('dom/base/test/browser_a.js', 'test/browser_a.js'), false);
    assert.equal(matchesTest('dom/base/test/browser_a.js', null), false);
});

function parsed(): {
    timings: ReturnType<typeof parseTestMarkers>;
    dropped: DroppedMarker[];
    result: ReturnType<typeof summarize>;
} {
    const dropped: DroppedMarker[] = [];
    const timings = parseTestMarkers(sampleProfile(), { jobName: 'job', taskId: TASK, retryId: 0 }, dropped);
    const result = summarize(
        TASK,
        0,
        { jobName: 'test-linux/opt-mochitest-1', project: 'autoland', revision: 'abcdef012345' },
        'profile-url',
        timings
    );
    attachProvenance(result.failures, timings, TASK, 0);
    return { timings, dropped, result };
}

test('every test is one row, in run order, with its time summed over executions', () => {
    const rows = testRows(parsed().timings);
    assert.deepEqual(
        rows.map((row) => [row.path, row.statuses, row.outcome, row.executions, row.reruns, row.duration]),
        [
            ['a/browser_slow.js', ['PASS'], 'passed', 1, 0, 400],
            ['a/browser_fail.js', ['FAIL', 'PASS'], 'failed', 2, 1, 70],
            ['a/browser_crash.js', ['CRASH'], 'failed', 1, 0, 50],
            ['a/browser_skip.js', ['SKIP'], 'skipped', 1, 0, 0],
            ['a/browser_twice.js', ['FAIL'], 'failed', 2, 1, 70],
        ]
    );
    assert.deepEqual(outcomeCounts(rows), { all: 5, failed: 3, passed: 1, skipped: 1, other: 0 });
});

test('the table filters by outcome and text, and sorts slowest first', () => {
    const rows = testRows(parsed().timings);
    assert.deepEqual(
        selectRows(rows, { text: '', outcome: 'all', sort: 'duration' }).map((row) => row.path),
        [
            'a/browser_slow.js',
            'a/browser_fail.js',
            'a/browser_twice.js',
            'a/browser_crash.js',
            'a/browser_skip.js',
        ]
    );
    assert.deepEqual(
        selectRows(rows, { text: 'CRASH', outcome: 'failed', sort: 'path' }).map((row) => row.path),
        ['a/browser_crash.js']
    );
    assert.deepEqual(
        selectRows(rows, { text: '', outcome: 'skipped', sort: 'order' }).map((row) => row.path),
        ['a/browser_skip.js']
    );
});

test('the summary counts tests by what their first run and their retry did', () => {
    const tally = outcomeTally(parsed().timings);
    assert.deepEqual(tally, {
        passed: 1,
        failedThenPassed: 1,
        failedTwice: 1,
        failedNotRetried: 1,
        failedOnlyOnRetry: 0,
        failedRetryOther: 0,
        skipped: 1,
        other: 0,
    });
    assert.equal(
        outcomeSentence(tally),
        '1 passed, 1 failed then passed on retry, 1 failed twice, 1 failed but were not retried, 1 skipped.'
    );
    assert.equal(
        outcomeSentence({ ...tally, failedThenPassed: 0, failedTwice: 0, failedNotRetried: 0, skipped: 0, passed: 0 }),
        '0 passed.'
    );
});

test('a failing test is split into its initial run and a failing retry, as try.html does', () => {
    const { timings, result } = parsed();
    const views = failureViews(result, timings, ORIGIN);
    assert.deepEqual(
        views.map((view) => [
            view.path,
            view.failureCount,
            view.commonMessage,
            view.category,
            view.lines,
            view.phases.map((phase) => [
                phase.label,
                phase.profile !== null,
                phase.items.map((item) => [item.message, item.stack, item.crash]),
            ]),
        ]),
        [
            [
                'a/browser_twice.js',
                2,
                'leaked 1 window(s)',
                'permanent',
                6,
                [
                    [
                        'Initial',
                        true,
                        [
                            [
                                'leaked 1 window(s)',
                                'run @ chrome://mochitests/content/browser/a/browser_twice.js:12\n' +
                                    'observe — JS Function - observe @  0x1f',
                                null,
                            ],
                        ],
                    ],
                    ['Retry', false, [['leaked 1 window(s)', null, null]]],
                ],
            ],
            [
                'a/browser_crash.js',
                1,
                'mozilla::Foo',
                'permanent',
                1,
                [[null, false, [['mozilla::Foo', null, { url: 'crash-viewer.html?url=https%3A%2F%2Ffirefox-ci-tc.services.mozilla.com%2Fapi%2Fqueue%2Fv1%2Ftask%2F' +
                `${TASK}%2Fruns%2F0%2Fartifacts%2Fpublic%2Ftest_info%2F11111111-2222-3333-4444-555555555555.json` }]]]],
            ],
            [
                'a/browser_fail.js',
                1,
                'expected 1 got 2',
                'passedOnRetry',
                1,
                [[null, false, [['expected 1 got 2', null, null]]]],
            ],
        ]
    );
    assert.match(views[0]!.profile!, /profile_browser_twice\.js\.json\.gz/);
});

test('tests are grouped under the manifest summary.jsonl names, or their directory', () => {
    const summary = [
        '{"action": "suite_start", "name": "mochitest-browser"}',
        '{"action": "test_start", "test": "a/browser_slow.js", "group": "a/browser.toml"}',
        '{"action": "test_start", "test": "b.toml:a/browser_fail.js", "group": "a/b.toml"}',
        '{"action": "test_end", "test": "a/browser_crash.js", "group": "a/other.toml"}',
        'not json',
    ].join('\n');
    const manifests = manifestsFromSummary(summary);
    assert.deepEqual([...manifests], [
        ['a/browser_slow.js', 'a/browser.toml'],
        ['a/browser_fail.js', 'a/b.toml'],
    ]);
    const groups = manifestGroups(testRows(parsed().timings), manifests);
    assert.deepEqual(
        groups.map((group) => [group.manifest, group.known, group.rows.map((row) => row.path), group.duration, group.failed]),
        [
            ['a/browser.toml', true, ['a/browser_slow.js'], 400, 0],
            ['a/b.toml', true, ['a/browser_fail.js'], 70, 1],
            ['a/', false, ['a/browser_crash.js', 'a/browser_skip.js', 'a/browser_twice.js'], 120, 2],
        ]
    );
    // With one manifest in the directory, the unrecorded tests join it.
    const one = new Map([['a/browser_slow.js', 'a/browser.toml']]);
    assert.deepEqual(
        manifestGroups(testRows(parsed().timings), one).map((group) => [group.manifest, group.rows.length]),
        [['a/browser.toml', 5]]
    );
    assert.deepEqual(
        selectGroups(groups, { text: '', outcome: 'failed', sort: 'duration' }).map((group) => [
            group.manifest,
            group.rows.map((row) => row.path),
        ]),
        [
            ['a/', ['a/browser_twice.js', 'a/browser_crash.js']],
            ['a/b.toml', ['a/browser_fail.js']],
        ]
    );
});

test('the flakiness worker is asked about each failure on this job’s chunk-stripped configuration', () => {
    const { timings, result } = parsed();
    assert.deepEqual(flakinessRequestsForTask(result, timings), [
        {
            path: 'a/browser_twice.js',
            tryMessages: ['leaked 1 window(s)'],
            hasTimeout: false,
            hasCrash: false,
            jobNames: ['test-linux/opt-mochitest'],
        },
        {
            path: 'a/browser_crash.js',
            tryMessages: ['mozilla::Foo'],
            hasTimeout: false,
            hasCrash: true,
            jobNames: ['test-linux/opt-mochitest'],
        },
        {
            path: 'a/browser_fail.js',
            tryMessages: ['expected 1 got 2'],
            hasTimeout: false,
            hasCrash: false,
            jobNames: ['test-linux/opt-mochitest'],
        },
    ]);
    assert.deepEqual(splitPath('a/b/browser_c.js'), { directory: 'a/b/', name: 'browser_c.js' });
    assert.deepEqual(splitPath('top.js'), { directory: '', name: 'top.js' });
});

test('a crash against a manifest is listed on its own, with its dump', () => {
    const { dropped } = parsed();
    assert.deepEqual(droppedViews(dropped, TASK, 0), [
        {
            id: 'a/browser.toml',
            status: 'CRASH',
            crash: {
                label: 'Crash',
                url:
                    'crash-viewer.html?url=https%3A%2F%2Ffirefox-ci-tc.services.mozilla.com%2Fapi%2Fqueue%2Fv1%2Ftask%2F' +
                    `${TASK}%2Fruns%2F0%2Fartifacts%2Fpublic%2Ftest_info%2F66666666-7777-8888-9999-000000000000.json`,
            },
        },
    ]);
});

test('no permanent failure: the job succeeded only if the queue says so', () => {
    const { result } = parsed();
    assert.equal(noPermanentFailureNote(result, { runId: 0, state: 'completed' }), 'The job succeeded.');
    assert.match(noPermanentFailureNote(result, { runId: 0, state: 'failed' }), /not attributed to a test/);
    assert.match(noPermanentFailureNote(result, null), /not attributed to a test/);
    assert.match(noPermanentFailureNote({ ...result, testCount: 0 }, null), /records no tests at all/);
});

test('a manifest row says FAIL with its count, or PASS, or SKIP', () => {
    const groups = manifestGroups(testRows(parsed().timings), null);
    const row = (path: string, outcome: TestRow['outcome']): TestRow => ({
        path,
        statuses: [],
        outcome,
        executions: 1,
        reruns: 0,
        duration: 0,
        firstStart: 0,
    });
    const group = (rows: TestRow[]): ManifestGroup => ({
        manifest: 'm',
        known: true,
        rows,
        duration: 0,
        firstStart: 0,
        failed: rows.filter((r) => r.outcome === 'failed').length,
    });
    assert.deepEqual(manifestStatus(groups[0]!), { status: 'FAIL', count: 3 });
    assert.deepEqual(manifestStatus(group([row('a', 'passed'), row('b', 'skipped')])), { status: 'PASS', count: null });
    assert.deepEqual(manifestStatus(group([row('a', 'skipped')])), { status: 'SKIP', count: null });
    assert.equal(manifestStatus(group([row('a', 'other')])), null);
    assert.equal(hiddenRowsLabel([row('a', 'passed'), row('b', 'passed')]), '+ 2 passed tests');
    assert.equal(hiddenRowsLabel([row('a', 'passed'), row('b', 'skipped')]), '+ 1 passed, 1 skipped tests');
    assert.equal(hiddenRowsLabel([row('a', 'passed')]), '+ 1 passed test');
});

test('artifact sizes: recorded by the harness, or from the storage headers', () => {
    assert.equal(formatBytes(56), '56 B');
    assert.equal(formatBytes(9887), '9.9 kB');
    assert.equal(formatBytes(397875), '398 kB');
    assert.equal(formatBytes(20912399), '21 MB');
    const headers = (entries: Record<string, string>) => (name: string) => entries[name] ?? null;
    assert.deepEqual(
        artifactSizeFromHeaders(
            headers({ 'x-goog-stored-content-encoding': 'identity', 'content-length': '397875', 'x-goog-stored-content-length': '397875' })
        ),
        { bytes: 397875, compressed: false }
    );
    assert.deepEqual(
        artifactSizeFromHeaders(headers({ 'x-goog-stored-content-encoding': 'gzip', 'x-goog-stored-content-length': '981841' })),
        { bytes: 981841, compressed: true }
    );
    assert.equal(artifactSizeFromHeaders(headers({})), null);
    const profile = {
        threads: [
            {
                markers: {
                    data: [
                        { type: 'Artifact', filename: 'profile_resource-usage.json', size: 20912399 },
                        { type: 'Test', test: 'x' },
                        null,
                    ],
                },
            },
        ],
    };
    assert.deepEqual([...artifactSizesFromProfile(profile)], [['public/test_info/profile_resource-usage.json', 20912399]]);
});

test('the header: when and how long it ran, and the worker with its pool', () => {
    const now = Date.parse('2026-09-28T12:30:00.000Z');
    const facts = runFacts(
        {
            runId: 0,
            state: 'exception',
            reasonResolved: 'deadline-exceeded',
            started: '2026-09-28T09:22:10.000Z',
            resolved: '2026-09-28T09:49:48.000Z',
            workerId: 'w-1',
            workerGroup: 'us-east-1',
        },
        { payload: { maxRunTime: 5400 }, provisionerId: 'gecko-t', workerType: 't-linux' },
        now
    );
    assert.deepEqual(
        facts.map((fact) => [fact.label, fact.parts]),
        [
            ['Resolved', [{ text: 'deadline-exceeded' }]],
            [
                'Ran',
                [
                    { text: '3 hours ago', title: '2026-09-28 09:22 UTC' },
                    { text: ' for 28 minutes' },
                    { text: ' (' },
                    { text: '31% of allowed time', title: 'maxRunTime 1 h 30 min' },
                    { text: ')' },
                ],
            ],
            ['Worker', [{ text: 'w-1', title: 'us-east-1' }, { text: ' (gecko-t/t-linux)' }]],
        ]
    );
    assert.deepEqual(
        runFacts({ runId: 0, state: 'running', started: '2026-09-28T12:00:00.000Z' }, null, now),
        [['Ran', [{ text: 'started 30 minutes ago, still running', title: '2026-09-28 12:00 UTC' }]]].map(
            ([label, parts]) => ({ label, parts })
        )
    );
    assert.deepEqual(runFacts({ runId: 0, state: 'failed', reasonResolved: 'failed' }, null), []);
    assert.equal(formatAgo(40_000), 'just now');
    assert.equal(formatAgo(89 * 60_000), '89 minutes ago');
    assert.equal(formatAgo(35 * 3600_000), '35 hours ago');
    assert.equal(formatAgo(3 * 86400_000), '3 days ago');
    assert.equal(formatRunLength(45_000), '45 seconds');
    assert.equal(formatRunLength(92 * 60_000), '1 h 32 min');
});

test('artifacts list logs first, with the viewer each one opens in', () => {
    const rows = artifactRows(
        [
            { name: 'public/test_info/profile_resource-usage.json' },
            { name: 'public/build/perfherder.json' },
            { name: 'public/test_info/11111111-2222-3333-4444-555555555555.json' },
            { name: 'public/test_info/profile_browser_a.js.json.gz' },
            { name: 'public/logs/live_backing.log' },
        ],
        TASK,
        0,
        'test-linux/opt-mochitest-1',
        ORIGIN
    );
    assert.deepEqual(
        rows.map((row) => [row.name, row.viewer?.label ?? null]),
        [
            ['public/logs/live_backing.log', null],
            ['public/test_info/11111111-2222-3333-4444-555555555555.json', 'Crash viewer'],
            ['public/test_info/profile_browser_a.js.json.gz', 'Profiler'],
            ['public/test_info/profile_resource-usage.json', 'Profiler'],
            ['public/build/perfherder.json', null],
        ]
    );
    assert.equal(
        rows[0]!.url,
        `https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/${TASK}/runs/0/artifacts/public/logs/live_backing.log`
    );
    assert.match(rows[3]!.viewer!.url, /profileName=test-linux%2Fopt-mochitest-1%20\(/);
});

test('a retry that ends OK is counted and sectioned the same way', () => {
    // The sentence counted a retry ending `OK` as a pass while the sections,
    // reading `passedOnRerun`, filed the test as permanent. Both now read
    // `isRetryRescue`, which only a `PASS` satisfies.
    const markers = [
        { data: { type: 'Text', text: 'retry' }, start: 100, end: 200 },
        { data: { type: 'Test', test: 'a/browser_ok.js', status: 'FAIL' }, start: 0, end: 10 },
        { data: { type: 'Test', test: 'a/browser_ok.js', status: 'OK' }, start: 110, end: 120 },
    ];
    const profile = {
        meta: { startTime: 0 },
        threads: [
            {
                stringArray: ['test', 'Text'],
                markers: {
                    length: markers.length,
                    name: markers.map((m) => (m.data.type === 'Test' ? 0 : 1)),
                    data: markers.map((m) => m.data),
                    startTime: markers.map((m) => m.start),
                    endTime: markers.map((m) => m.end),
                },
            },
        ],
    };
    const timings = parseTestMarkers(profile, { jobName: 'job', taskId: TASK, retryId: 0 });
    const result = summarize(TASK, 0, { jobName: 'job', project: null, revision: null }, 'url', timings);
    const tally = outcomeTally(timings);
    assert.equal(tally.failedThenPassed, 0);
    assert.equal(tally.failedRetryOther, 1);
    assert.deepEqual(
        failureViews(result, timings, ORIGIN).map((view) => view.category),
        ['permanent']
    );
});
