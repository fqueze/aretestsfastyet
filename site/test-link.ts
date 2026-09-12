/**
 * The **test row link treatment**, shared by the pages that list test paths.
 *
 * One row unit, three pages: `try.html`'s two failure tables, `issues.html`'s
 * test rows under an expanded component, and `intermittent.html`'s ranking put
 * a test path in a row. Each one needs the same two things next to the path — a
 * way to copy it, and a way to reach `test.html` for it — and before this file
 * existed each one answered them differently:
 *
 * | page | copy the path | reach `test.html` |
 * | --- | --- | --- |
 * | `try.html` | nothing | a separate `history` link after the path |
 * | `issues.html` | a 📋 button | nothing |
 * | `intermittent.html` | nothing | the path, in the same tab |
 * | `xpcshell-timings.html` (unmigrated, left alone) | a 📋 button | nothing |
 *
 * `test.html` itself is the fourth caller, and only of `copyToClipboard`: its
 * button is in the page header rather than in a row.
 *
 * ## Why the copy button is the point
 *
 * Reported by the owner about `try.html`: *"copying the name of a failed test
 * from try.html is currently difficult because clicking it opens the subview
 * and clears the selection"*. Dragging a selection across the path is a click
 * on the row, the row's handler expands the test, the re-render replaces the
 * element the selection was anchored in, and the selection is gone. A button
 * that copies the path and stops the click from reaching the row is what makes
 * the path obtainable at all — so `stopPropagation` here is the behaviour, not
 * a detail of it.
 *
 * ## Why the clipboard write has a fallback
 *
 * `navigator.clipboard` is undefined on a non-secure origin, and these
 * dashboards are opened from `file://` and from plain-HTTP mirrors as well as
 * from `https://tests.firefox.dev/`. The textarea/`execCommand` path is what
 * `old/issues.html:3318-3341` and `xpcshell-timings.html:2541` already do, and
 * what `site/issues.ts` and `site/test.ts` each ported separately; this is the
 * one copy of it.
 *
 * ## Why the URL goes through `withDevParams`
 *
 * `fetch-utils.js:41` carries `?data-source=` and `?profiler=` onto a link, so
 * a reader who loaded the page against a pinned snapshot stays on that snapshot
 * when they follow a row into `test.html`. Both pages load `fetch-utils.js` by
 * name (`site/try.html:724`, `site/issues.html:7`), so the function is there on
 * both.
 */

import { el, externalLink } from './drilldown-render.ts';

declare global {
    /** `fetch-utils.js:41` — carries `?data-source=`/`?profiler=` onto a link. */
    function withDevParams(url: string): string;
}

/**
 * The `test.html` URL for one test path, with the dev params carried over.
 *
 * `site/flaky-view.ts` has its own `testPageUrl` without the `withDevParams`
 * wrapping, and it stays there: that file is a view model, imported by a node
 * test that has no `fetch-utils.js` global to call.
 */
export function testPageUrl(testPath: string): string {
    return withDevParams(`test.html?test=${encodeURIComponent(testPath)}`);
}

/**
 * The 📋 button that copies a test path, with a brief ✓ on success.
 *
 * `action-button` is the class both pages already style for a row-hover icon
 * button (`site/try.html`, `site/issues.html:415`), so the button is invisible
 * until the row is hovered and needs no new rule of its own.
 */
export function copyPathButton(testPath: string): HTMLButtonElement {
    const button = el('button', {
        class: 'action-button',
        text: '📋',
        title: 'Copy test path',
    });
    button.addEventListener('click', (event) => {
        // The row underneath expands on click. Without this the copy also
        // toggles the row, which is the half of the reported problem a copy
        // button would otherwise not fix.
        event.stopPropagation();
        void copyToClipboard(testPath, button);
    });
    return button;
}

/**
 * The test path as a link into `test.html`, which does not toggle the row.
 *
 * `title` is an option rather than a fixed string because `issues.html` already
 * puts the test's Bugzilla component in the path's tooltip
 * (`old/issues.html:2168`), and a tooltip the shared code chose would replace a
 * tooltip the page has a reason for. A page with nothing to say there passes
 * nothing and the reader gets no tooltip, which is what both pages showed on
 * the path before this.
 */
export function testPageLink(
    testPath: string,
    options: { text?: string; title?: string } = {}
): HTMLAnchorElement {
    const anchor = el('a', {
        href: testPageUrl(testPath),
        text: options.text ?? testPath,
        title: options.title,
    });
    anchor.target = '_blank';
    anchor.addEventListener('click', (event) => {
        event.stopPropagation();
    });
    return anchor;
}

/**
 * The 🔍 Searchfox link for a test path.
 *
 * `generateSearchfoxButton` (`old/issues.html:848-851`,
 * `xpcshell-timings.html:505`), and the destination `try.html`'s path used to
 * link to directly. It stays reachable from every row: the path itself is the
 * `test.html` link now, and the source is one glyph away.
 *
 * The URL is built here rather than through `common-links.js`'s
 * `getSearchfoxUrl`, which takes an optional failure message and appends a
 * line-number fragment for it — a `try.html` concern that `issues.html` has no
 * message to supply. A page with a message to point at keeps calling that
 * function itself.
 */
export function searchfoxButton(testPath: string): HTMLAnchorElement {
    const anchor = externalLink(
        `https://searchfox.org/mozilla-central/source/${testPath}`,
        '🔍',
        'action-button'
    );
    anchor.title = 'Open in Searchfox';
    return anchor;
}

/**
 * The whole treatment: the copy button, the path as a `test.html` link, and the
 * Searchfox button.
 *
 * Returned as a list rather than a wrapper element, because the pages put these
 * into containers that already exist and are styled — a `span.test-path` inside
 * `td.test-info` on `try.html`, a `div.tree-name` on `issues.html` — and
 * wrapping them would add an element neither stylesheet knows about.
 *
 * **Both buttons trail the path**, copy then Searchfox. Leading with the copy
 * button was tried and reverted: a control that is invisible until the row is
 * hovered cannot hold a column of its own without either indenting every path
 * away from the `Test` header or needing a negative margin to pull it back, and
 * on `issues.html` the alternative — stacking it on the row's 📄 and
 * cross-fading — read as too magical to the owner. Trailing costs no width in
 * the gutter, needs no compensating rule, and puts it where `issues.html`
 * already had its Searchfox button.
 */
export function testRowLink(
    testPath: string,
    options: { text?: string; title?: string } = {}
): [HTMLAnchorElement, HTMLButtonElement, HTMLAnchorElement] {
    return [testPageLink(testPath, options), copyPathButton(testPath), searchfoxButton(testPath)];
}


/**
 * Copies text and flashes the button that asked for it.
 *
 * `showCopySuccess` (`xpcshell-timings.html:2513`) is the behaviour being
 * matched: the label becomes a green ✓ for a second and then comes back. The
 * colour is set inline rather than through a class, because it is the same
 * inline `#28a745` the three copies this replaces used and no stylesheet
 * carries a rule for it.
 *
 * Exported because `site/test.ts`'s `📋 Copy` button wants the same copy and
 * the same flash without the rest of the treatment: it sits in a page header
 * rather than in a row, so it has no row to stop a click from reaching and no
 * `test.html` to link to — it *is* `test.html`.
 */
export async function copyToClipboard(text: string, button: HTMLElement): Promise<void> {
    const flash = (): void => {
        const original = button.textContent;
        button.textContent = '✓';
        button.style.color = '#28a745';
        setTimeout(() => {
            button.textContent = original;
            button.style.color = '';
        }, 1000);
    };
    try {
        if (navigator.clipboard !== undefined) {
            await navigator.clipboard.writeText(text);
            flash();
            return;
        }
    } catch {
        // Falls through to the textarea path below.
    }
    const textarea = el('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    try {
        if (document.execCommand('copy')) {
            flash();
        }
    } catch (error) {
        console.error('Copy failed:', error);
    }
    textarea.remove();
}
