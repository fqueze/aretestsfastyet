/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * `site/failures.ts`, the failures page controller, driven end to end in jsdom.
 *
 * The twin of `test/crashes-page.test.ts`, and written to be read against it:
 * the two pages share `site/drilldown-render.ts` and `site/drilldown-view.ts`,
 * so what matters is where they *differ*, and every one of those differences is
 * asserted from both sides.
 *
 * | | crashes | failures |
 * | --- | --- | --- |
 * | inline links cell | `td > span.view-links` | `td.view-links` |
 * | the search | drops whole rows, keeps their numbers | rewrites the numbers |
 * | expanding under a search | the unfiltered subtree | only what matched |
 * | the row label | plain text, no title | Searchfox anchor, full-message title |
 * | a test row | nothing after the name | a 🐛 bug button |
 * | a stale search box on hashchange | kept (the bug) | cleared (divergence 5) |
 * | an occurrence's links | Profile, Crash, Job | Profile, Job |
 *
 * As in the crashes suite, no expected value is produced by the code under
 * test: the 25 message rows and their counts are tallied off the raw fixture by
 * `tallyFailures()`, class names are literals, and the link hrefs come from the
 * real `common-links.js` running in the jsdom window.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupPage, fixture, shape, shapes } from './dom-harness.ts';
import type { IssuesWithTaskIdsFile } from '../lib/formats/issues.ts';

// --- ground truth ---------------------------------------------------------

const RAW = fixture<IssuesWithTaskIdsFile>('xpcshell-issues-with-taskids.json');
const DAILY = fixture<{ metadata: { jobCount?: number } }>('xpcshell-2026-08-03.json');
const INDEX = fixture<{ dates: string[] }>('index.json');

/** What `failures.html` calls a failure that recorded no message. */
const NO_MESSAGE = '(no failure message)';

interface Tally {
    counts: Map<string, number>;
    tests: Map<string, Set<string>>;
}

/** The failures in the 21-day fixture, counted without touching `site/`. */
function tallyFailures(): Tally {
    const counts = new Map<string, number>();
    const tests = new Map<string, Set<string>>();
    const failStatusIds = RAW.tables.statuses
        .map((status, id) => (status.startsWith('FAIL') ? id : -1))
        .filter((id) => id !== -1);

    RAW.testRuns.forEach((testGroup, testId) => {
        if (!testGroup) {
            return;
        }
        const dirPath = RAW.tables.testPaths[RAW.testInfo.testPathIds[testId]!]!;
        const testName = RAW.tables.testNames[RAW.testInfo.testNameIds[testId]!]!;
        for (const statusId of failStatusIds) {
            const group = testGroup[statusId] as
                | { messageIds?: (number | null)[]; taskIdIds?: number[][] }
                | null
                | undefined;
            if (!group?.taskIdIds) {
                continue;
            }
            group.taskIdIds.forEach((taskIds, index) => {
                const messageId = group.messageIds?.[index];
                const message =
                    messageId === null || messageId === undefined
                        ? NO_MESSAGE
                        : RAW.tables.messages[messageId]!;
                counts.set(message, (counts.get(message) ?? 0) + taskIds.length);
                const seen = tests.get(message) ?? new Set<string>();
                seen.add(`${dirPath}/${testName}`);
                tests.set(message, seen);
            });
        }
    });
    return { counts, tests };
}

const TALLY = tallyFailures();
const EXPECTED_ROWS = [...TALLY.counts]
    .map(([key, count]) => ({ key, count, testCount: TALLY.tests.get(key)!.size }))
    .sort((a, b) => b.count - a.count);

/** `common-links.js:108`'s own regex, which decides whether a message links. */
const SEARCHFOX_LINE = /^\[[^\] :]+ : (\d+)\]/u;

test('the fixture exercises what this suite claims to cover', () => {
    assert.ok(EXPECTED_ROWS.length > 1, 'several messages');
    assert.ok(
        EXPECTED_ROWS.some((row) => row.key === NO_MESSAGE),
        'the rankable "(no failure message)" row is present'
    );
    assert.ok(
        RAW.tables.messages.some((message) => SEARCHFOX_LINE.test(message)),
        'a [file : line] message, so the Searchfox split is reachable'
    );
    assert.ok(
        RAW.tables.messages.some((message) => !SEARCHFOX_LINE.test(message)),
        'and a plain one, so the unlinked branch is reachable too'
    );
    assert.ok(
        RAW.tables.messages.some((message) => message.includes('"')),
        'a message containing a quote — the case upstream"s attribute round-trip loses'
    );
    assert.ok(
        RAW.tables.components.some((component) => component.includes(' :: ')),
        'a Product :: Component, so the bug button is reachable'
    );
    assert.ok(EXPECTED_ROWS.some((row) => row.testCount > 1), 'a message spanning several tests');
});

// --- the harness ----------------------------------------------------------

const harness = setupPage({
    url: 'https://tests.firefox.dev/failures.html',
    files: {
        'index.json': INDEX,
        'xpcshell-issues-with-taskids.json': RAW,
        'xpcshell-2026-08-03.json': DAILY,
    },
});
const { start } = await import('../site/failures.ts');
await start();

const list = (): HTMLElement => harness.content.querySelector('.failure-list')!;
const dataRows = (): HTMLElement[] => [
    ...list().querySelectorAll<HTMLElement>('.failure-row:not(.total-row)'),
];
const searchBox = (): HTMLInputElement =>
    harness.document.getElementById('searchBox') as HTMLInputElement;
/** The label cell's whole text — the anchor plus the remainder. */
const labelOf = (row: Element): string => row.querySelector('.failure-message')!.textContent!;

function subtreeOf(row: Element): HTMLElement[] {
    const out: HTMLElement[] = [];
    let next = row.nextElementSibling;
    while (
        next !== null &&
        !next.classList.contains('failure-row') &&
        !next.classList.contains('sort-header')
    ) {
        out.push(next as HTMLElement);
        next = next.nextElementSibling;
    }
    return out;
}

function collapseAll(): void {
    for (const row of dataRows()) {
        if (row.classList.contains('expanded')) {
            row.click();
        }
    }
}

/**
 * Every test row under an expanded message, opening path rows on the way.
 *
 * A message spanning one directory with several tests collapses that directory
 * away and emits `direct-child test-row`s; one spanning several tests in a
 * directory emits a `path-row` that has to be clicked. So "the tests of this
 * row" is not simply the immediate subtree, and a test that assumed it was
 * would measure zero on half the fixture and pass by asserting nothing.
 */
function testRowsUnder(row: HTMLElement): HTMLElement[] {
    for (const sub of subtreeOf(row)) {
        if (sub.classList.contains('path-row') && !sub.classList.contains('expanded')) {
            sub.click();
        }
    }
    return subtreeOf(row).filter((element) => element.classList.contains('test-row'));
}

/** Types into the search box and waits out `initSearchBox`'s 300ms debounce. */
async function search(term: string): Promise<void> {
    searchBox().value = term;
    searchBox().dispatchEvent(new harness.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
}

// =========================================================================
// 1. Page identity — the failures VOCAB really is the failures one
// =========================================================================

test('the page renders the failures vocabulary and none of the crashes names', () => {
    const root = list();
    assert.equal(shape(root), 'div.failure-list');

    const rowCount = EXPECTED_ROWS.length;
    assert.equal(root.querySelectorAll('.failure-row').length, rowCount + 1);
    assert.equal(root.querySelectorAll('.failure-message').length, rowCount + 2);
    assert.equal(root.querySelectorAll('.failure-stats').length, rowCount + 2);
    assert.equal(root.querySelectorAll('.stat-value.fail').length, rowCount + 1);

    for (const name of [
        'crash-list',
        'crash-row',
        'crash-signature',
        'crash-stats',
        'single-crash',
        'crash-job-name',
        'test-crash-count',
    ]) {
        assert.equal(harness.content.querySelector(`.${name}`), null, `no .${name} on failures`);
    }
    assert.equal(harness.content.querySelector('.stat-value.crash'), null);
});

test('a test row"s count cell is a test-failure-count, with the message noun', () => {
    // The `testCountClass` and `tooltipOf` half of the vocabulary, which only
    // appears once a row is expanded and so is not covered by the list-level
    // test above. Both halves are needed: asserting only that
    // `.test-crash-count` is absent — which is what the list test does — is
    // satisfied by *any* other class, so setting `testCountClass` to a third
    // name survived it. Measured: mutating it to `test-crash-count` failed no
    // test in this suite before this one existed.
    collapseAll();
    let cells = 0;
    for (const row of dataRows()) {
        row.click();
        // Only the *expandable* test rows carry a count cell; a
        // `single-failure` row shows its one occurrence inline instead.
        for (const testRow of testRowsUnder(row).filter(
            (element) => !element.classList.contains('single-failure')
        )) {
            const cell = testRow.querySelector('.test-failure-count');
            assert.ok(cell !== null, 'the count cell carries this page"s class');
            assert.equal(testRow.querySelector('.test-crash-count'), null, 'and not the other');
            assert.equal(cell.textContent, String(Number(cell.textContent)), 'it holds a number');

            // `occurrenceTooltip(…, FAILURE_NOUN)` — the crashes page says
            // "of this signature" in the same position.
            const title = cell.getAttribute('title')!;
            if (title !== '') {
                assert.ok(title.includes('of this message'), title);
                assert.equal(title.includes('of this signature'), false);
            }
            cells++;
        }
        row.click();
    }
    assert.ok(cells > 0, `${cells} count cells were checked`);
});

test('the page names its columns "Failure Message" and "Failures"', () => {
    const header = list().querySelector('.sort-header')!;
    assert.equal(header.querySelector('.failure-message')!.textContent, 'Failure Message');
    const labels = [...header.querySelectorAll('button')].map(
        (button) => button.lastChild!.textContent
    );
    assert.deepEqual(labels, ['Tests', 'Failures']);
    assert.equal(labels.includes('Crashes'), false);
    assert.equal(header.textContent!.includes('Crash Signature'), false);
});

test('the harness switcher renamed the heading for this page', () => {
    const heading = harness.document.querySelector('h1')!;
    assert.equal(heading.lastChild!.textContent, ' Failures by Message');
    assert.equal(heading.textContent!.includes('Crashes by Signature'), false);
    assert.equal(harness.document.title, 'XPCShell Failures by Message');
});

// =========================================================================
// 2. What the default view shows
// =========================================================================

test('the default view is the 21-day file, ranked most failures first', () => {
    assert.deepEqual(harness.requested, ['index.json', 'xpcshell-issues-with-taskids.json']);
    assert.deepEqual(
        dataRows().map(labelOf),
        EXPECTED_ROWS.map((row) => row.key),
        'every message, in descending-count order'
    );
});

test('"(no failure message)" is a real, rankable row', () => {
    // Not a placeholder the page skips: on this fixture it is the *largest*
    // row, which is the point `site/failures-view.ts` makes about it.
    const expected = EXPECTED_ROWS.find((row) => row.key === NO_MESSAGE)!;
    assert.equal(EXPECTED_ROWS[0]!.key, NO_MESSAGE, 'and it ranks first here');

    const row = dataRows().find((candidate) => labelOf(candidate) === NO_MESSAGE)!;
    assert.deepEqual(
        [...row.querySelectorAll('.stat-value')].map((value) => value.textContent),
        [String(expected.testCount), String(expected.count)]
    );
    // It is plain text: `messageLink` returns null for it, so no Searchfox
    // anchor is built for a name the page invented.
    assert.equal(row.querySelector('.failure-message a'), null);
});

test('each row shows the test count and the occurrence count from the file', () => {
    assert.deepEqual(
        dataRows().map((row) =>
            [...row.querySelectorAll('.stat-value')].map((value) => value.textContent)
        ),
        EXPECTED_ROWS.map((row) => [String(row.testCount), String(row.count)])
    );
});

test('the total row sums the column above it, overcounting tests as upstream does', () => {
    const expectedTests = EXPECTED_ROWS.reduce((sum, row) => sum + row.testCount, 0);
    const expectedCount = EXPECTED_ROWS.reduce((sum, row) => sum + row.count, 0);
    const distinctTests = new Set([...TALLY.tests.values()].flatMap((set) => [...set])).size;
    assert.notEqual(expectedTests, distinctTests, 'the fixture must exhibit the overcount');

    const totalRow = list().querySelector('.failure-row.total-row')!;
    assert.equal(totalRow.querySelector('.failure-message')!.textContent, '📊 Total');
    assert.deepEqual(
        [...totalRow.querySelectorAll('.stat-value')].map((value) => value.textContent),
        [String(expectedTests), String(expectedCount)]
    );
});

// =========================================================================
// 3. The label: the Searchfox split and the title
// =========================================================================

test('a [file : line] message links only its prefix, and the rest stays text', () => {
    // `messageLink` + `labelNodes` (`site/failures.ts:265`), the element form of
    // `linkifyFailureMessage`. The split point and the `#line` are checked
    // against `common-links.js`'s own regex, read here rather than retyped from
    // the view model.
    let linked = 0;
    for (const row of dataRows()) {
        const key = EXPECTED_ROWS.find((candidate) => candidate.key === labelOf(row))!.key;
        const cell = row.querySelector('.failure-message')!;
        const match = SEARCHFOX_LINE.exec(key);
        if (match === null) {
            assert.equal(cell.querySelector('a'), null, `${key.slice(0, 30)} must not link`);
            assert.equal(cell.textContent, key, 'and shows the message unchanged');
            continue;
        }

        const anchor = cell.querySelector('a') as HTMLAnchorElement;
        assert.ok(anchor !== null, `${key.slice(0, 30)} must link`);
        // The anchor's text is the bracketed prefix, up to and including the
        // first `]` — upstream's `indexOf(']') + 1`.
        const end = key.indexOf(']') + 1;
        assert.equal(anchor.textContent, key.slice(0, end));
        assert.equal(cell.textContent, key, 'the whole message is still readable');
        // The remainder is a text node, not a second anchor.
        assert.equal(cell.querySelectorAll('a').length, 1);

        const href = anchor.getAttribute('href')!;
        assert.ok(href.startsWith('https://searchfox.org/mozilla-central/source/'), href);
        assert.ok(href.endsWith(`#${match[1]}`), `the line number is the fragment: ${href}`);
        assert.equal(anchor.target, '_blank');
        linked++;
    }
    assert.ok(linked > 0, `${linked} messages carried a Searchfox link`);
});

test('clicking the Searchfox link does not also expand the row', () => {
    // The behaviour: a reader who clicks the linked `[file : line]` prefix gets
    // a Searchfox tab and *not* an expansion they did not ask for.
    //
    // Which mechanism delivers it is worth stating precisely, because a
    // mutation showed the obvious answer is the wrong one. The delegated
    // handler opens with
    // `if (!(target instanceof Element) || target.tagName === 'A') return`
    // (`site/failures.ts:841`) — but **deleting the `tagName === 'A'` clause
    // changes nothing and survives this suite.** Measured: the label anchor is
    // built by `externalLink`, which attaches its own
    // `click -> stopPropagation` listener (`site/drilldown-render.ts:310`), so
    // the event never reaches `#content` at all. Instrumented, a click on the
    // anchor reaches `#content` 0 times where a click on the cell reaches it 1.
    //
    // So the guard is unreachable defence-in-depth behind `externalLink`, and
    // this test pins the reader-visible behaviour rather than the clause. The
    // same click on the crashes page cannot even arise: its `labelNodes` is
    // plain text (`site/crashes.ts:244`) and a top-level `.crash-row` holds 0
    // anchors.
    collapseAll();
    const row = dataRows().find((candidate) => candidate.querySelector('.failure-message a'));
    assert.ok(row !== undefined, 'a row with a Searchfox anchor must exist for this to test');
    const anchor = row.querySelector('.failure-message a') as HTMLAnchorElement;

    assert.equal(row.classList.contains('expanded'), false, 'starting closed');
    const before = subtreeOf(row).length;
    assert.equal(before, 0);

    anchor.dispatchEvent(new harness.window.Event('click', { bubbles: true }));

    assert.equal(row.classList.contains('expanded'), false, 'the row must not have opened');
    assert.equal(subtreeOf(row).length, 0, 'and no sub-rows were inserted');

    // The control that keeps this from passing vacuously: clicking the *cell*
    // rather than the anchor does expand, so the row really is clickable and
    // the guard is what stopped it.
    row.querySelector('.failure-message')!.dispatchEvent(
        new harness.window.Event('click', { bubbles: true })
    );
    assert.equal(row.classList.contains('expanded'), true, 'a non-anchor click does expand');
    assert.ok(subtreeOf(row).length > 0);
    row.click();
});

test('the Searchfox link points at the row"s most-failing test', () => {
    // `mostFrequentTestPath` (`site/failures-view.ts:146`), reached through
    // `labelNodes`. The expected path is recomputed from the raw tally, not
    // from the view model.
    let checked = 0;
    for (const row of dataRows()) {
        const anchor = row.querySelector('.failure-message a') as HTMLAnchorElement | null;
        if (anchor === null) {
            continue;
        }
        const key = labelOf(row);
        const path = decodeURIComponent(anchor.getAttribute('href')!)
            .replace('https://searchfox.org/mozilla-central/source/', '')
            .replace(/#\d+$/u, '');
        assert.ok(
            TALLY.tests.get(key)!.has(path),
            `${path} must be one of the tests that produced this message`
        );
        checked++;
    }
    assert.ok(checked > 0);
});

test('every message row carries the whole message as a title, unlike the crashes page', () => {
    // `labelTitle: (key) => key` (`site/failures.ts:277`). The cell is
    // `text-overflow: ellipsis`, so a long message is cut off and the tooltip
    // is the only way to read it. The crashes page has no title at all.
    for (const row of dataRows()) {
        const cell = row.querySelector('.failure-message')!;
        assert.equal(cell.getAttribute('title'), labelOf(row));
    }
    const longest = [...dataRows()].sort((a, b) => labelOf(b).length - labelOf(a).length)[0]!;
    assert.ok(labelOf(longest).length > 40, 'the fixture has a message worth a tooltip');
});

test('a row whose message contains a quote is found again after a re-sort', () => {
    // Divergence 2, and the one that fixes a live bug. Upstream re-finds an
    // expanded row with `querySelector('[data-message="…"]')` built by
    // `escapeAttr`, which cannot match once the parser has decoded `&quot;` —
    // measured at 1,848 of 2,841 rows on the pinned snapshot. Here the row
    // elements are in a Map keyed by the raw message.
    const quoted = EXPECTED_ROWS.find((row) => row.key.includes('"'));
    assert.ok(quoted !== undefined, 'the fixture must contain a quoted message');

    const row = dataRows().find((candidate) => labelOf(candidate) === quoted.key)!;
    row.click();
    const openedWith = subtreeOf(row).length;
    assert.ok(openedWith > 0, 'the quoted row expanded to something');

    // Re-sort, which re-renders the whole list and re-attaches the open row.
    const countButton = (): HTMLButtonElement =>
        list().querySelector('.sort-header')!.querySelectorAll('button')[1] as HTMLButtonElement;
    countButton().click();

    const reopened = dataRows().find((candidate) => labelOf(candidate) === quoted.key)!;
    assert.equal(reopened.classList.contains('expanded'), true, 'still marked as expanded');
    assert.equal(
        subtreeOf(reopened).length,
        openedWith,
        'and it still has its rows — upstream leaves a highlighted row with 0 sub-rows'
    );
    // No attribute carries the message, so there is nothing to round-trip.
    assert.equal(list().querySelector('[data-message]'), null);

    countButton().click();
    collapseAll();
});

// =========================================================================
// 4. The bug button — this page has one, the crashes page does not
// =========================================================================

test('a test row carries a 🐛 button filed against the test"s component', () => {
    // `bugButton` (`site/failures.ts:238`), which is the one place the new page
    // parses HTML — `getBugButton` returns a string, and it is parsed through a
    // `<template>` rather than assigned into the live tree.
    collapseAll();
    let buttons = 0;
    for (const row of dataRows()) {
        row.click();
        for (const sub of testRowsUnder(row)) {
            const button = sub.querySelector('a.action-button') as HTMLAnchorElement | null;
            assert.ok(button !== null, `${sub.querySelector('.test-name')!.textContent}: 🐛`);
            assert.equal(button.textContent, '🐛');
            assert.equal(button.target, '_blank');
            assert.equal(button.title, 'File bug for this test');

            const url = new URL(button.getAttribute('href')!);
            assert.equal(url.origin + url.pathname, 'https://bugzilla.mozilla.org/enter_bug.cgi');
            // The product and component are the two halves of the file's
            // `Product :: Component` string, split by the shared function.
            const component = `${url.searchParams.get('product')} :: ${url.searchParams.get('component')}`;
            assert.ok(
                RAW.tables.components.includes(component),
                `${component} must be a component the file records`
            );
            // The summary names the message this row is under, which is what
            // makes the button a function of (test, message) and not of test
            // alone.
            assert.ok(
                url.searchParams.get('short_desc')!.includes(labelOf(row).slice(0, 20)),
                'the summary carries this row"s message'
            );
            buttons++;
        }
        row.click();
    }
    assert.ok(buttons > 0, `${buttons} bug buttons were checked`);

    // The *omitted* case is not asserted here, and the reason is measured
    // rather than assumed. `bugButton` returns null when the component cannot
    // be split into the two Bugzilla fields (`site/failures.ts:240`), and this
    // fixture cannot reach that branch: its `tables.components` is exactly
    // `["WebExtensions :: General", "Core :: Networking", "Core :: XPConnect"]`
    // — three of three well-formed — and all ten entries of
    // `testInfo.componentIds` point at one of them, none null.
    //
    // Deleting the guard therefore changes nothing observable on this page and
    // that mutation survives, correctly. The rule itself is covered where it
    // can fail: `test/failures-view.test.ts` drives `hasBugButton` over
    // `'Core'`, `''`, `null`, `undefined` and `'Core::Networking'`.
    assert.deepEqual(
        RAW.tables.components.filter((component) => !component.includes(' :: ')),
        [],
        'if a future fixture gains a malformed component, the guard becomes reachable here'
    );
});

test('the 🐛 button carries the one inline onclick the new page still emits', () => {
    // Divergence 1 says this page attaches listeners and emits no `on*`
    // attributes of its own — with one exception, which is not this page's:
    // `getBugButton` (`common-links.js:216`) returns a *string* containing
    // `onclick="event.stopPropagation();"`, and this migration keeps that
    // shared script. So the attribute count on the new page tracks the number
    // of bug buttons rather than the number of rows.
    //
    // What is asserted is the attribute's presence, and that it is the only
    // `on*` in the tree. Whether it *works* is deliberately not asserted:
    // measured here, jsdom under `runScripts: 'outside-only'` does not compile
    // inline event-handler content attributes at all — a control `<a
    // onclick="event.stopPropagation();">` inside a listening parent still lets
    // the click through — so an assertion that the row did not toggle would be
    // testing jsdom's script policy and would pass just as well against a
    // button with no attribute. That behaviour belongs to the browser parity
    // run.
    collapseAll();
    const row = dataRows()[0]!;
    row.click();
    const testRow = testRowsUnder(row)[0]!;
    const button = testRow.querySelector('a.action-button') as HTMLAnchorElement;
    assert.equal(button.getAttribute('onclick'), 'event.stopPropagation();');

    // The only one. Every other handler on the page is a listener, so a
    // regression that reintroduced `onclick="toggleFailure(…)"` fails here.
    const withOnclick = [...list().querySelectorAll('*')].filter((element) =>
        [...element.attributes].some((attribute) => attribute.name.startsWith('on'))
    );
    assert.deepEqual(
        withOnclick.map((element) => element.className),
        withOnclick.map(() => 'action-button'),
        'every inline handler in the tree belongs to a bug button'
    );
    assert.ok(withOnclick.length > 0, 'and there is at least one to check');
    row.click();
});

// =========================================================================
// 5. The inline links cell — the page-identity branch
// =========================================================================

test('the failures page puts view-links on the td, with no span', () => {
    let checked = 0;
    for (const row of dataRows()) {
        row.click();
        for (const single of subtreeOf(row).filter((e) => e.classList.contains('single-failure'))) {
            const cells = [...single.querySelectorAll('td')];
            assert.equal(cells.length, 3);
            assert.equal(shape(cells[2]!), 'td.view-links', 'the class is on the cell itself');
            assert.equal(
                cells[2]!.querySelector('span.view-links'),
                null,
                'and there is no span wrapper — that is the crashes page'
            );
            // Empty: the job name in the cell before it opens task.html.
            assert.equal(cells[2]!.textContent, '');
            checked++;
        }
        row.click();
    }
    assert.ok(checked > 0, `${checked} inline cells were checked`);
});

test('an occurrence gets no View links, and never a Crash link', () => {
    // `occurrenceLinks` (`site/failures.ts`): the job name is the task.html
    // link, which has the profile and the Treeherder job, and a failure has no
    // minidump for the crash viewer the crashes page leaves in this position.
    let checked = 0;
    for (const row of dataRows()) {
        row.click();
        for (const single of subtreeOf(row).filter((e) => e.classList.contains('single-failure'))) {
            const labels = [...single.querySelectorAll('.view-links a')].map((a) => a.textContent);
            assert.deepEqual(labels, []);
            assert.equal(single.querySelector('a[href^="crash-viewer.html"]'), null);
            checked++;
        }
        row.click();
    }
    assert.ok(checked > 0);
});

test('a single-failure row opens task.html, and is never inert', () => {
    // `singleRowHref` (`site/failures.ts`) always returns a task page URL.
    // The crashes page returns `null` for a crash with no dump; here there is
    // no such case, so every single row is clickable.
    const opened: string[] = [];
    const realOpen = harness.window.open;
    (harness.window as unknown as { open: unknown }).open = (url: string) => {
        opened.push(url);
        return null;
    };
    try {
        let clicked = 0;
        for (const row of dataRows()) {
            row.click();
            for (const single of subtreeOf(row).filter((e) =>
                e.classList.contains('single-failure')
            )) {
                single.click();
                clicked++;
            }
            row.click();
        }
        assert.equal(opened.length, clicked, 'every single row opened something');
        assert.ok(clicked > 0);
        for (const url of opened) {
            assert.match(url, /^task\.html\?task=[\w-]{22}\.\d+&test=/);
        }
    } finally {
        (harness.window as unknown as { open: unknown }).open = realOpen;
    }
});

test('the job name in a failures row points at task.html, for its own run', () => {
    // `jobNameHref` (`site/failures.ts`), the same destination the crashes page
    // uses since the task page lists a run's crashes too.
    let checked = 0;
    for (const row of dataRows()) {
        row.click();
        for (const single of subtreeOf(row).filter((e) => e.classList.contains('single-failure'))) {
            const anchor = single.querySelector('.failure-job-name a') as HTMLAnchorElement;
            const match = /^task\.html\?task=([\w-]{22}\.\d+)&test=/.exec(anchor.getAttribute('href')!);
            assert.ok(match !== null, anchor.getAttribute('href')!);
            assert.ok(RAW.tables.taskIds.includes(match[1]!), 'a run the file records');
            assert.equal(anchor.textContent!.length > 0, true, 'the job name is not empty');
            checked++;
        }
        row.click();
    }
    assert.ok(checked > 0);
});

// =========================================================================
// 6. The search — this page rewrites the numbers
// =========================================================================

test('a search rewrites a surviving row"s count, unlike the crashes page', async () => {
    // Divergence 4, and the sharpest difference between the two pages. A row
    // whose *message* does not match survives on the strength of a matching
    // test, and shows a **smaller** number than it did unfiltered.
    //
    // This is asserted by finding such a row rather than by asserting it of
    // whatever is on screen: a test that only checked "the row is still there"
    // would pass against the crashes semantics too.
    const before = new Map(
        dataRows().map((row) => [labelOf(row), row.querySelectorAll('.stat-value')[1]!.textContent])
    );

    // A message spanning several tests, searched by one of its test names, so
    // the row survives on the test and is rewritten down to it.
    const multi = EXPECTED_ROWS.find(
        (row) => row.testCount > 1 && !SEARCHFOX_LINE.test(row.key)
    )!;
    const testPath = [...TALLY.tests.get(multi.key)!][0]!;
    const term = testPath.split('/').pop()!;
    assert.equal(
        multi.key.toLowerCase().includes(term.toLowerCase()),
        false,
        'the term must not match the message itself, or nothing is rewritten'
    );

    await search(term);
    const row = dataRows().find((candidate) => labelOf(candidate) === multi.key);
    assert.ok(row !== undefined, 'the row survives on its matching test');

    const after = row.querySelectorAll('.stat-value')[1]!.textContent;
    assert.notEqual(after, before.get(multi.key), 'and its count was rewritten');
    assert.ok(
        Number(after) < Number(before.get(multi.key)),
        `${after} must be smaller than the unfiltered ${before.get(multi.key)}`
    );
    // The test count is rewritten too, down to the tests that matched.
    assert.equal(row.querySelectorAll('.stat-value')[0]!.textContent, '1');

    // And rows matching nothing are gone.
    assert.ok(dataRows().length < before.size, 'the search dropped rows as well');

    await search('');
    assert.equal(
        dataRows().find((candidate) => labelOf(candidate) === multi.key)!.querySelectorAll(
            '.stat-value'
        )[1]!.textContent,
        before.get(multi.key),
        'clearing the search restores the full count'
    );
});

test('a row expanded under a search shows only the tests that matched', async () => {
    // The other half, and the mirror of the crashes page's behaviour: this page
    // expands from `expandable`, the search-rewritten tree
    // (`site/failures.ts:419`), where the crashes page expands from `groups`.
    const multi = EXPECTED_ROWS.find(
        (row) => row.testCount > 2 && !SEARCHFOX_LINE.test(row.key)
    );
    assert.ok(multi !== undefined, 'need a message spanning three or more tests');

    collapseAll();
    const row = dataRows().find((candidate) => labelOf(candidate) === multi.key)!;

    // The unfiltered shape, as a sequence. Measured on this fixture the row
    // holds five tests in one directory, so `expandGroup` keeps the directory
    // level and emits a `path-row`.
    row.click();
    assert.deepEqual(shapes(subtreeOf(row)), ['div.historical-chart', 'div.path-row']);
    const pathRow = subtreeOf(row).find((e) => e.classList.contains('path-row'))!;
    pathRow.click();
    const unfilteredTests = subtreeOf(row).filter((e) =>
        e.classList.contains('test-row')
    ).length;
    assert.equal(unfilteredTests, multi.testCount, `all ${multi.testCount} tests are reachable`);
    assert.ok(unfilteredTests > 1);
    row.click();

    const testPath = [...TALLY.tests.get(multi.key)!][0]!;
    await search(testPath.split('/').pop()!);
    const searched = dataRows().find((candidate) => labelOf(candidate) === multi.key)!;
    assert.equal(
        searched.querySelectorAll('.stat-value')[0]!.textContent,
        '1',
        'the row was rewritten to the one matching test'
    );

    // The narrowing is visible in the *shape*: with one test left the directory
    // level collapses away entirely, so the `path-row` is replaced by a single
    // `direct-child test-row`. Asserting the sequence rather than a count is
    // what makes this fail against an expansion that read the unfiltered tree —
    // that would still emit the `path-row`.
    searched.click();
    assert.deepEqual(
        shapes(subtreeOf(searched)),
        ['div.historical-chart', 'div.direct-child.test-row'],
        'the searched subtree is one test, not a directory of five'
    );
    assert.equal(
        subtreeOf(searched).filter((e) => e.classList.contains('path-row')).length,
        0,
        'and no path row survives'
    );

    // That covered the **click** path (`toggleMessage`, `site/failures.ts:419`).
    // The other opener is the **re-attach** in `render()` (`:343`), which runs
    // when the list re-renders with a row already open — reached here by
    // re-sorting while expanded. Both must read `expandable`; measured, wiring
    // either one alone to `groups` survives if only the other is exercised.
    const countButton = (): HTMLButtonElement =>
        list().querySelector('.sort-header')!.querySelectorAll('button')[1] as HTMLButtonElement;
    countButton().click();
    const reattached = dataRows().find((candidate) => labelOf(candidate) === multi.key)!;
    assert.equal(reattached.classList.contains('expanded'), true, 're-attached still open');
    assert.deepEqual(
        shapes(subtreeOf(reattached)),
        ['div.historical-chart', 'div.direct-child.test-row'],
        'the re-attach path narrows to the same one test the click path did'
    );
    countButton().click();

    await search('');
    collapseAll();
});

// =========================================================================
// 7. Sorting and expansion
// =========================================================================

test('clicking the Failures header flips the direction without changing the set', () => {
    const countButton = (): HTMLButtonElement =>
        list().querySelector('.sort-header')!.querySelectorAll('button')[1] as HTMLButtonElement;

    const descending = dataRows().map(labelOf);
    countButton().click();
    const ascending = dataRows().map(labelOf);

    assert.deepEqual(
        ascending.map((key) => TALLY.counts.get(key)),
        [...EXPECTED_ROWS].sort((a, b) => a.count - b.count).map((row) => row.count)
    );
    assert.deepEqual([...ascending].sort(), [...descending].sort(), 'the same set');
    assert.notDeepEqual(ascending, descending, 'in a different order');

    countButton().click();
    assert.deepEqual(dataRows().map(labelOf), descending);
});

test('expanding a message inserts its subtree and closing restores the list', () => {
    collapseAll();
    const row = dataRows()[0]!;
    const before = shapes(list().children);
    row.click();
    assert.equal(row.classList.contains('expanded'), true);
    assert.ok(subtreeOf(row).length > 0);
    assert.equal(shape(subtreeOf(row)[0]!), 'div.historical-chart', 'the chart slot goes first');

    row.click();
    assert.deepEqual(shapes(list().children), before, 'closing restores the list exactly');
    assert.equal(row.classList.contains('expanded'), false);
});

test('expanding a second message closes the first', () => {
    const [first, second] = dataRows();
    first!.click();
    second!.click();
    assert.equal(first!.classList.contains('expanded'), false);
    assert.equal(subtreeOf(first!).length, 0);
    assert.equal(list().querySelectorAll('.failure-row.expanded').length, 1);
    second!.click();
});

// =========================================================================
// 8. The charts
// =========================================================================

test('expanding draws one chart, labelled with the message and the failure noun', () => {
    harness.charts.length = 0;
    // Not the `(no failure message)` row: that name is not in `tables.messages`
    // so its chart is all zeroes, which the next test covers.
    const target = EXPECTED_ROWS.find((row) => row.key !== NO_MESSAGE)!;
    const row = dataRows().find((candidate) => labelOf(candidate) === target.key)!;
    row.click();

    assert.equal(harness.charts.length, 1);
    const chart = harness.charts[0]!;
    assert.equal(chart.label, target.key);
    // The event noun the crashes page passes here is `'crash'`; an equality
    // check against `'failure'` already excludes it, and a second assertion
    // spelling that out was one `tsc` proved could never fail.
    assert.equal(chart.eventLabel, 'failure', 'the failures page"s event noun');
    assert.equal(chart.series.length, RAW.metadata.days);

    const events = chart.series.reduce((sum, point) => sum + point.events, 0);
    assert.equal(events, target.count, 'the chart and the row agree on the total');

    row.click();
    harness.charts.length = 0;
});

test('the chart counts every FAIL* status, not just the bare "FAIL"', () => {
    // `ratesFor` collects the tests that ever produced this message using
    // `status.startsWith('FAIL')` (`site/failures.ts:596`), matching the
    // extractor's status universe. Narrowing that to `status === 'FAIL'` used
    // to survive this suite: the chart test above happens to pick a row whose
    // series is dominated by nothing in particular, and the
    // `(no failure message)` row has no table entry at all.
    //
    // The fixture makes the distinction sharp. Counted off the raw JSON, the
    // suffixed statuses carry almost everything — e.g. one message is
    // `FAIL-PARALLEL: 386, FAIL-SEQUENTIAL: 2, FAIL: 3` — so a chart built from
    // the bare status alone would show a small fraction of the row.
    const failStatuses = RAW.tables.statuses
        .map((status, id) => ({ status, id }))
        .filter((entry) => entry.status.startsWith('FAIL'));
    const suffixed = failStatuses.filter((entry) => entry.status !== 'FAIL');
    assert.ok(suffixed.length > 0, 'the file must have suffixed FAIL statuses');

    // What `ratesFor`'s status test actually decides is **which test IDs** go
    // to `countDailyRunsForTests` — that shared function does its own
    // `status.startsWith(statusName)` when summing (`common-charts.js:181`).
    // So the case that distinguishes the two is a message whose *test set*
    // shrinks under the narrower rule, which is not the same as a message whose
    // occurrences are mostly suffixed. Measured on this fixture: the two rules
    // select a different test set for **19 of the 31 messages**.
    const testSetsFor = (message: string): { wide: Set<number>; narrow: Set<number> } => {
        const messageId = RAW.tables.messages.indexOf(message);
        const wide = new Set<number>();
        const narrow = new Set<number>();
        RAW.testRuns.forEach((testGroup, testId) => {
            if (!testGroup) {
                return;
            }
            for (const { status, id } of failStatuses) {
                const group = testGroup[id] as { messageIds?: (number | null)[] } | null | undefined;
                if (!group?.messageIds?.some((candidate) => candidate === messageId)) {
                    continue;
                }
                wide.add(testId);
                if (status === 'FAIL') {
                    narrow.add(testId);
                }
            }
        });
        return { wide, narrow };
    };

    const target = EXPECTED_ROWS.map((row) => ({ row, sets: testSetsFor(row.key) })).find(
        (entry) =>
            entry.row.key !== NO_MESSAGE &&
            entry.sets.narrow.size < entry.sets.wide.size &&
            entry.row.count > 0
    );
    assert.ok(
        target !== undefined,
        'need a message whose test set shrinks under the narrow rule, or this asserts nothing'
    );

    collapseAll();
    harness.charts.length = 0;
    const row = dataRows().find((candidate) => labelOf(candidate) === target.row.key)!;
    row.click();

    assert.equal(harness.charts.length, 1);
    const events = harness.charts[0]!.series.reduce((sum, point) => sum + point.events, 0);
    assert.equal(events, target.row.count, 'the chart counts every FAIL* occurrence of the row');
    assert.ok(events > 0, 'and the narrow rule would have selected no tests at all here');
    assert.equal(
        target.sets.narrow.size,
        0,
        `${target.sets.wide.size} tests under FAIL*, none under the bare "FAIL"`
    );

    row.click();
    harness.charts.length = 0;
});

/**
 * Three chart paths this fixture cannot reach, with the measurement.
 *
 * Each is a mutation that survives, and the reason is the same shape of the
 * data rather than a missing assertion:
 *
 * - **`openMessage`'s search-filtered chart variant** (`site/failures.ts:394`)
 *   and **`testIdsOfSubtree`/`testIdsOfPath`** (`:638`, `:657`). Reaching the
 *   filtered variant needs a row that is on screen under a search *without its
 *   own message matching* and that has a chart with events. Counted off the raw
 *   fixture: **exactly one of the 25 message rows spans more than one test**,
 *   and it is `(no failure message)` — whose display name is not in
 *   `tables.messages`, so `messageId` is -1 and its chart is all zeroes either
 *   way (the test below pins that). Every other row has a single test, so a
 *   search either matches the row's message or removes the row.
 * - **`testDailyRates`'s single-test walk** (`:620`). Same cause: it is only
 *   distinguishable from the general walk on a test that never produced the
 *   message, and the one-test rows make the two agree.
 *
 * These are stated rather than covered because the honest fix is a fixture with
 * a multi-test, message-bearing row, and adding one is a change to
 * `test/fixtures/` that would alter what every other suite over that file sees.
 * The guard below is what turns this from a claim into a tripwire.
 */
test('the fixture cannot reach the search-filtered chart variants', () => {
    const multiTest = EXPECTED_ROWS.filter((row) => row.testCount > 1);
    assert.deepEqual(
        multiTest.map((row) => row.key),
        [NO_MESSAGE],
        'if a message row ever spans several tests, the filtered chart variants become ' +
            'reachable and should be covered rather than left to this note'
    );
    assert.equal(
        RAW.tables.messages.includes(NO_MESSAGE),
        false,
        'and the one multi-test row is the display name with no table entry, so its chart is empty'
    );
});

test('the "(no failure message)" row gets an all-zero chart, as upstream does', () => {
    // `messageId` (`site/failures.ts:547`): the display name is not a table
    // entry, so `indexOf` gives -1 and the series has no events. Reproduced
    // rather than special-cased, and worth asserting because the row is the
    // page's largest — a reader sees an empty chart on the top row.
    harness.charts.length = 0;
    const row = dataRows().find((candidate) => labelOf(candidate) === NO_MESSAGE)!;
    row.click();

    assert.equal(harness.charts.length, 1);
    const chart = harness.charts[0]!;
    assert.equal(chart.label, NO_MESSAGE);
    assert.equal(
        chart.series.reduce((sum, point) => sum + point.events, 0),
        0,
        'no events, because the name is not in tables.messages'
    );
    // The row itself is not zero, which is what makes the empty chart notable
    // rather than a row with no data.
    assert.ok(TALLY.counts.get(NO_MESSAGE)! > 0);
    assert.equal(chart.series.length, RAW.metadata.days, 'the days are still there');

    row.click();
    harness.charts.length = 0;
});

// =========================================================================
// 9. Data loading and URL state
// =========================================================================

test('choosing a date leaves the 21-day view and loads that day"s file', async () => {
    const select = harness.document.getElementById('dateSelect') as HTMLSelectElement;
    assert.deepEqual([...select.options].map((option) => option.value), INDEX.dates);

    harness.requested.length = 0;
    (harness.document.getElementById('historicalButton') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    select.value = '2026-08-03';
    select.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(harness.requested.includes('xpcshell-2026-08-03.json'));
    assert.equal(
        harness.document.getElementById('statusText')!.textContent,
        `${DAILY.metadata.jobCount!.toLocaleString()} test jobs`
    );
    assert.ok(dataRows().length > 0 && dataRows().length < EXPECTED_ROWS.length);
});

test('a date with no file shows the error, and does not leave a stale list', async () => {
    const select = harness.document.getElementById('dateSelect') as HTMLSelectElement;
    assert.ok(dataRows().length > 0, 'there is a list to lose');

    select.value = '2026-07-14';
    select.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(harness.content.querySelector('.failure-list'), null);
    assert.equal(harness.content.querySelector('.no-data')!.textContent, 'Failed to load data');
    assert.equal(harness.document.getElementById('statusText')!.textContent, 'Error loading data');
});

test('toggling back to 21 days restores the full ranked list', async () => {
    (harness.document.getElementById('historicalButton') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(dataRows().map(labelOf), EXPECTED_ROWS.map((row) => row.key));
    assert.equal(harness.content.querySelector('.no-data'), null);
});

test('a day that decodes but has no failures shows this page"s empty text', async () => {
    // `VOCAB.emptyText`, only reached when the file parses and
    // `groups.size === 0` (`site/failures.ts:312`). Derived by stripping the
    // `FAIL*` status groups out of the daily file, so the decode is unchanged
    // and this is the empty branch rather than the error branch.
    //
    // Without it the string is unreachable: mutating it to the crashes page's
    // wording failed nothing.
    const daily = fixture<{
        tables: { statuses: string[] };
        testRuns: (Record<string, unknown> | null)[];
        metadata: { jobCount?: number };
    }>('xpcshell-2026-08-03.json');
    const failIds = daily.tables.statuses
        .map((status, id) => (status.startsWith('FAIL') ? id : -1))
        .filter((id) => id !== -1);
    assert.ok(failIds.length > 0, 'the daily file must have FAIL statuses to remove');

    let removed = 0;
    for (const testGroup of daily.testRuns) {
        if (testGroup === null) {
            continue;
        }
        for (const id of failIds) {
            if (testGroup[String(id)] !== undefined) {
                delete testGroup[String(id)];
                removed++;
            }
        }
    }
    assert.ok(removed > 0, `${removed} failure groups were removed, so the fixture really changed`);

    harness.files.set('xpcshell-2026-08-02.json', daily);
    const select = harness.document.getElementById('dateSelect') as HTMLSelectElement;
    (harness.document.getElementById('historicalButton') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    select.value = '2026-08-02';
    select.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const message = harness.content.querySelector('.no-data')!;
    assert.equal(shape(message), 'div.no-data');
    assert.equal(message.textContent, 'No failure data available');
    assert.equal(message.textContent!.includes('crash'), false, 'not the other page"s wording');
    assert.equal(harness.content.querySelector('.failure-list'), null);
    assert.equal(
        harness.document.getElementById('statusText')!.textContent,
        `${daily.metadata.jobCount!.toLocaleString()} test jobs`,
        'the load succeeded — this is the empty branch, not the error branch'
    );

    (harness.document.getElementById('historicalButton') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(dataRows().length, EXPECTED_ROWS.length, 'the page is restored');
});

test('the failures page DOES clear a stale search box on hashchange', async () => {
    // Divergence 5 — the one behaviour change on this page's list, and the
    // asymmetry with the crashes page, which keeps the bug. Both sides are
    // asserted so the difference is a tested decision.
    //
    // `site/failures.ts:770` writes `state.q ?? ''`; `site/crashes.ts:744`
    // guards on `state.q` and so never clears.
    await search('netwerk');
    assert.equal(searchBox().value, 'netwerk');
    assert.ok(dataRows().length < EXPECTED_ROWS.length, 'the list really is filtered');

    harness.window.location.hash = '#date=21days';
    harness.window.dispatchEvent(new harness.window.Event('hashchange'));
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(searchBox().value, '', 'a hash with no q clears the box');
    assert.equal(
        dataRows().length,
        EXPECTED_ROWS.length,
        'and the list is unfiltered again — the fix is observable, not cosmetic'
    );
});

test('the hash records the 21-day view and the search term', async () => {
    const hashState = (): URLSearchParams =>
        new URLSearchParams(harness.window.location.hash.slice(1));

    await search('netwerk');
    assert.equal(hashState().get('date'), '21days');
    assert.equal(hashState().get('q'), 'netwerk');

    await search('');
    assert.equal(hashState().get('q'), null, 'an empty term is dropped');
    assert.equal(hashState().get('date'), '21days');
});

test('the focus guard keeps a hashchange from interrupting typing', () => {
    // Kept unchanged by divergence 5: `document.activeElement !== box`
    // (`site/failures.ts:769`). Asserted because the fix above touches the same
    // line, and losing the guard would delete what a reader is typing.
    searchBox().value = 'half-typed';
    searchBox().focus();
    assert.equal(harness.document.activeElement, searchBox());

    harness.window.location.hash = '#date=21days';
    harness.window.dispatchEvent(new harness.window.Event('hashchange'));

    assert.equal(searchBox().value, 'half-typed', 'the focused box is left alone');
    searchBox().blur();
    searchBox().value = '';
});
