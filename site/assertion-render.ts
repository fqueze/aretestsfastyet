/**
 * One line of a failure's assertion list, and its stack colouring, shared by
 * `try.html` and `task.html`.
 *
 * Moved out of `site/try.ts` unchanged so the task page renders a phase chip, a
 * message, a leak or a JS stack exactly as the try page does.
 */

import { el } from './drilldown-render.ts';

/** One item of the assertion list: a message, a crash signature, or a phase label. */
export interface AssertionItem {
    separator?: boolean;
    label?: string;
    cls?: string;
    icon?: HTMLElement | null;
    /** The rendered content, already escaped by construction. */
    content?: Node | string;
    stack?: string | undefined;
}

/** One `<li>` of the assertion list. `old/try.html:2345`. */
export function renderAssertionItem(item: AssertionItem, isHidden: boolean): HTMLElement {
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
