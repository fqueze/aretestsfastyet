/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * `task.html` in jsdom, against a fake queue.
 *
 * The page's own markup, the shared `fetch-utils.js` it links through, and a
 * `fetch` that serves the four queue requests. What is asserted is what the
 * view-model tests cannot see: that each request lands in its section, that a
 * missing profile leaves the rest of the page standing, and that the controls
 * re-filter the table.
 */

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';

import { start } from '../site/task.ts';
import { sampleProfile } from './task-fixture.ts';

const TASK = 'K-PZiLvGQTWmnPPGkwMbpQ';
const QUEUE = 'https://firefox-ci-tc.services.mozilla.com/api/queue/v1';
const ROOT = new URL('../', import.meta.url);

const DEFINITION = {
    metadata: {
        name: 'test-linux2404-64/debug-mochitest-browser-chrome-4',
        source: 'https://hg.mozilla.org/integration/autoland/file/1d16569aaa156af33d9e47742052dfdc7294b20f/taskcluster/kinds/test',
    },
    tags: { project: 'autoland' },
    provisionerId: 'gecko-t',
    workerType: 't-linux',
    payload: { maxRunTime: 5400 },
};

const STATUS = {
    status: {
        state: 'failed',
        runs: [
            {
                runId: 0,
                state: 'failed',
                reasonResolved: 'failed',
                started: '2026-09-28T09:22:10.000Z',
                resolved: '2026-09-28T09:49:48.000Z',
                workerId: 'w-1',
            },
            { runId: 1, state: 'completed', reasonResolved: 'completed' },
        ],
    },
};

const ARTIFACTS = {
    artifacts: [
        { name: 'public/test_info/profile_resource-usage.json' },
        { name: 'public/logs/live_backing.log' },
    ],
};

/** Installs the page and runs `start()` against `responses`, keyed by URL. */
async function load(
    search: string,
    responses: Record<string, unknown>
): Promise<{ document: Document; requested: string[]; restore: () => void }> {
    const markup = readFileSync(new URL('site/task.html', ROOT), 'utf8').replace(
        /<script\b[^>]*>[\s\S]*?<\/script>/g,
        ''
    );
    const dom = new JSDOM(markup, {
        url: `https://tests.firefox.dev/task.html${search}`,
        runScripts: 'outside-only',
    });
    dom.window.eval(readFileSync(new URL('fetch-utils.js', ROOT), 'utf8'));
    dom.window.HTMLElement.prototype.scrollIntoView = function (): void {};

    const scope = globalThis as unknown as Record<string, unknown>;
    const names = ['window', 'document', 'Element', 'Node', 'HTMLElement', 'withDevParams'];
    const saved = names.map((name) => scope[name]);
    for (const name of names) {
        scope[name] =
            name === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[name];
    }

    const requested: string[] = [];
    await start({
        fetch: async (url, init) => {
            requested.push(init?.method === 'HEAD' ? `HEAD ${url}` : url);
            if (init?.method === 'HEAD') {
                const headers = HEADS[url];
                return headers === undefined
                    ? new Response(null, { status: 404 })
                    : new Response(null, { status: 200, headers });
            }
            const body = responses[url];
            if (body === undefined) {
                return new Response('not found', { status: 404 });
            }
            const raw = (body as { raw?: string }).raw;
            return new Response(raw ?? JSON.stringify(body), { status: 200 });
        },
    });
    return {
        document: dom.window.document,
        requested,
        restore: () => names.forEach((name, i) => (scope[name] = saved[i])),
    };
}

function everything(): Record<string, unknown> {
    return {
        // `taskDefinitionName`'s URL, with the trailing slash the queue accepts.
        [`${QUEUE}/task/${TASK}/`]: DEFINITION,
        [`${QUEUE}/task/${TASK}/status`]: STATUS,
        [`${QUEUE}/task/${TASK}/runs/0/artifacts`]: ARTIFACTS,
        [`${QUEUE}/task/${TASK}/runs/0/artifacts/public/test_info/profile_resource-usage.json`]:
            sampleProfile(),
        [`https://treeherder.mozilla.org/api/jobs/?task_id=${TASK}&retry_id=0`]: {
            results: [[596172712, 'autoland']],
            job_property_names: ['id', 'repository'],
        },
        [`${QUEUE}/task/${TASK}/runs/0/artifacts/public/test_info/summary.jsonl`]: RAW(
            // Two manifests in one directory, so the tests neither names stay
            // grouped by directory rather than being guessed into one.
            '{"action": "test_start", "test": "a/browser_slow.js", "group": "a/other.toml"}\n' +
                '{"action": "test_start", "test": "a/browser_fail.js", "group": "a/browser.toml"}\n'
        ),
    };
}

/** What the storage answers a HEAD with, by artifact URL. */
const HEADS: Record<string, Record<string, string>> = {
    [`${QUEUE}/task/${TASK}/runs/0/artifacts/public/logs/live_backing.log`]: {
        'x-goog-stored-content-encoding': 'gzip',
        'x-goog-stored-content-length': '542278',
    },
    [`${QUEUE}/task/${TASK}/runs/0/artifacts/public/test_info/profile_resource-usage.json`]: {
        'x-goog-stored-content-encoding': 'gzip',
        'x-goog-stored-content-length': '981841',
    },
};

/** A body served as-is rather than as JSON. */
function RAW(text: string): { raw: string } {
    return { raw: text };
}

const texts = (nodes: Iterable<Element>): string[] =>
    [...nodes].map((node) => node.textContent ?? '');

test('the header, the failures, the tests and the artifacts each come from their request', async () => {
    const page = await load(`?task=${TASK}.0&test=browser_fail.js`, everything());
    try {
        const { document } = page;
        assert.equal((document.getElementById('task-input') as HTMLInputElement).value, `${TASK}.0`);
        assert.equal(document.getElementById('run-state')!.textContent, 'failed');
        assert.equal(
            document.getElementById('links')!.textContent!.replace(/\s+/g, ' ').trim(),
            'View: Profile Taskcluster raw log Treeherder: job parsed log'
        );
        assert.equal(
            document.querySelector<HTMLAnchorElement>('#links a:last-child')!.href,
            'https://treeherder.mozilla.org/logviewer?job_id=596172712&repo=autoland'
        );
        const facts = document.getElementById('facts')!.textContent!;
        assert.match(facts, /^Job/);
        assert.doesNotMatch(facts, /Task/, 'the task ID is the heading, not a fact');
        assert.match(facts, /autoland 1d16569aaa15/);
        // The other run is a link to itself on this page; the current one is not.
        assert.deepEqual(texts(document.querySelectorAll('#facts a[href^="task.html?task="]')), [
            '1 (completed)',
        ]);
        assert.equal(
            document.getElementById('summary')!.textContent,
            '1 passed, 1 failed then passed on retry, 1 failed twice, 1 failed but were not retried, 1 skipped.'
        );

        // The two sections the summary sentence names, in its order.
        const sections = [...document.querySelectorAll('#failures h2')].map((heading) => [
            heading.textContent,
            [...heading.nextElementSibling!.querySelectorAll('tr.failure-row')].map((row) => [
                (row as HTMLElement).dataset['path'],
                row.querySelector('.count-cell')!.textContent,
                row.querySelectorAll('a.profiler-cmd').length,
            ]),
        ]);
        assert.deepEqual(sections, [
            [
                'Permanent failures (2)',
                [
                    ['a/browser_twice.js', '2', 1],
                    ['a/browser_crash.js', '1', 0],
                ],
            ],
            ['Failed then passed on retry (1)', [['a/browser_fail.js', '1', 0]]],
        ]);
        assert.deepEqual(texts(document.querySelectorAll('#failures .chip')), ['Initial', 'Retry']);
        assert.equal(document.querySelectorAll('#failures .assertion-stack').length, 1);
        assert.equal(document.querySelectorAll('#failures .show-more-link').length, 0, 'nothing is long enough to cut');
        assert.equal(document.querySelectorAll('#failures a.crash-sig').length, 1);
        assert.deepEqual(texts(document.querySelectorAll('#dropped li a')), ['Crash']);

        // Two manifests from summary.jsonl, the rest by directory; the two
        // holding a failure start open, listing only their failures.
        assert.deepEqual(
            [...document.querySelectorAll('#tests-body tr')].map((row) =>
                row.classList.contains('manifest-row')
                    ? `[${(row as HTMLElement).dataset['manifest']}] ${row.children[1]!.textContent}`
                    : row.classList.contains('more-row')
                      ? row.textContent
                      : (row as HTMLElement).dataset['path']
            ),
            [
                '[a/other.toml] PASS',
                '[a/browser.toml] FAIL 1',
                'a/browser_fail.js',
                '[a/] FAIL 2',
                'a/browser_crash.js',
                'a/browser_twice.js',
                '+ 1 skipped test',
            ]
        );
        document.querySelector<HTMLElement>('#tests-body tr.more-row')!.click();
        assert.deepEqual(
            [...document.querySelectorAll<HTMLElement>('#tests-body tr.test-row')].map((row) => row.dataset['path']),
            ['a/browser_fail.js', 'a/browser_crash.js', 'a/browser_skip.js', 'a/browser_twice.js']
        );
        const fold = document.querySelector<HTMLElement>('#tests-body tr.more-row')!;
        assert.equal(fold.textContent, '− hide the 1 that did not fail');
        fold.click();
        assert.equal(document.querySelectorAll('#tests-body tr.test-row').length, 3, 'folded back');
        // The directory is grey and apart from the file name.
        assert.deepEqual(
            [...document.querySelector('#tests-body tr.test-row a')!.childNodes].map((node) => node.textContent),
            ['a/', 'browser_fail.js']
        );

        // Permanent failures open, the rescued one closed; a click toggles.
        const detailOf = (path: string): HTMLElement =>
            document.querySelector<HTMLElement>(`#failures tr.detail-row[data-path="${path}"]`)!;
        assert.deepEqual(
            ['a/browser_twice.js', 'a/browser_crash.js', 'a/browser_fail.js'].map((path) => detailOf(path).hidden),
            [false, false, true]
        );
        document.querySelector<HTMLElement>('#failures tr.failure-row[data-path="a/browser_fail.js"] .count-cell')!.click();
        assert.equal(detailOf('a/browser_fail.js').hidden, false);
        assert.deepEqual(
            [...document.querySelectorAll('.highlight')].map(
                (node) => `${node.tagName} ${(node as HTMLElement).dataset['path']}`
            ),
            ['TR a/browser_fail.js', 'TR a/browser_fail.js'],
            'the named test, by bare file name, is marked in both tables'
        );
        // The profile's `Artifact` marker gives the profile's real size; the
        // log has only the HEAD's compressed size, and says so.
        assert.deepEqual(
            [...document.querySelectorAll('#artifacts tr')].map((row) => [
                row.querySelectorAll('td:first-child a.profiler-cmd').length,
                row.children[1]!.textContent,
                row.children[2]!.textContent,
            ]),
            [
                [0, 'public/logs/live_backing.log', '542 kB gz'],
                [1, 'public/test_info/profile_resource-usage.json', '21 MB'],
            ]
        );
        assert.deepEqual(
            [...document.querySelectorAll('#results-error, #header-error')].map((node) => (node as HTMLElement).hidden),
            [true, true]
        );
    } finally {
        page.restore();
    }
});

test('a manifest row folds and unfolds its tests', async () => {
    const page = await load(`?task=${TASK}`, everything());
    try {
        const { document } = page;
        const rowOf = (manifest: string): HTMLElement =>
            document.querySelector<HTMLElement>(`#tests-body tr[data-manifest="${manifest}"]`)!;
        rowOf('a/').click();
        assert.deepEqual(
            [...document.querySelectorAll<HTMLElement>('#tests-body tr')].map(
                (row) => row.dataset['manifest'] ?? row.dataset['path']
            ),
            ['a/other.toml', 'a/browser.toml', 'a/browser_fail.js', 'a/']
        );
        rowOf('a/other.toml').click();
        assert.deepEqual(
            [...document.querySelectorAll<HTMLElement>('#tests-body tr.test-row')].map((row) => row.dataset['path']),
            ['a/browser_slow.js', 'a/browser_fail.js']
        );
    } finally {
        page.restore();
    }
});

test('the outcome filter and the text filter narrow the table', async () => {
    const page = await load(`?task=${TASK}`, everything());
    try {
        const { document } = page;
        const select = document.getElementById('outcome-select') as HTMLSelectElement;
        assert.deepEqual(texts(select.options), ['All (5)', 'Failed (3)', 'Passed (1)', 'Skipped (1)']);
        select.value = 'skipped';
        select.dispatchEvent(new document.defaultView!.Event('change'));
        assert.deepEqual(
            [...document.querySelectorAll<HTMLElement>('#tests-body tr')].map(
                (row) => row.dataset['manifest'] ?? row.dataset['path']
            ),
            ['a/', 'a/browser_skip.js']
        );
        select.value = 'all';
        const filter = document.getElementById('test-filter') as HTMLInputElement;
        filter.value = 'slow';
        filter.dispatchEvent(new document.defaultView!.Event('input'));
        assert.equal(document.querySelectorAll('#tests-body tr.test-row').length, 1);
        assert.equal(document.getElementById('tests-shown')!.textContent, '1 manifest, 1 of 5 tests shown');
    } finally {
        page.restore();
    }
});

test('an expired profile leaves the header and the artifacts standing', async () => {
    const responses = everything();
    delete responses[`${QUEUE}/task/${TASK}/runs/0/artifacts/public/test_info/profile_resource-usage.json`];
    const page = await load(`?task=${TASK}`, responses);
    try {
        const { document } = page;
        const error = document.getElementById('results-error')!;
        assert.equal(error.hidden, false);
        assert.match(error.textContent!, /expires artifacts after about a month/);
        assert.match(document.getElementById('facts')!.textContent!, /debug-mochitest-browser-chrome-4/);
        assert.equal(document.querySelectorAll('#artifacts tr').length, 2);
        assert.equal((document.getElementById('tests') as HTMLElement).hidden, true);
    } finally {
        page.restore();
    }
});

test('a task the queue does not know says so once, and nothing else', async () => {
    const page = await load(`?task=${TASK}`, {});
    try {
        const { document } = page;
        const visible = [...document.querySelectorAll('.error')].filter(
            (node) => !(node as HTMLElement).hidden
        );
        assert.deepEqual(texts(visible), [`Taskcluster has no task ${TASK}.`]);
        assert.equal(document.querySelectorAll('#links a').length, 0);
        assert.equal(document.getElementById('artifacts')!.childElementCount, 0);
    } finally {
        page.restore();
    }
});

test('with no task, only the form shows and nothing is requested', async () => {
    const page = await load('', everything());
    try {
        assert.deepEqual(page.requested, []);
        assert.equal((page.document.getElementById('task-view') as HTMLElement).hidden, true);
    } finally {
        page.restore();
    }
});
