/**
 * `task.html` — what happened in one task run.
 *
 * | file | contains | tested by |
 * | --- | --- | --- |
 * | `lib/query/task-summary.ts` | the per-test aggregation, shared with `fx-tests task` | `test/task-command.test.ts` |
 * | `site/task-view.ts` | this page's view model — URL state, rows, artifacts, run facts | `test/task-view.test.ts`, no DOM |
 * | this file | the requests and the renderer | `test/task-page.test.ts` |
 *
 * The page the other pages' **Task** links open: one place for what a reader
 * otherwise assembles from the profile, the Treeherder failure summary and the
 * Taskcluster artifact list. Everything is read live — the task definition,
 * its status, the run's artifact list, its `summary.jsonl` for the manifests,
 * the Treeherder job for its parsed-log link, and the run's
 * `profile_resource-usage.json` — so it has no aggregate and no window.
 *
 * The requests are independent and render as each lands: the header does not
 * wait on a 50 MB profile, and a profile that has expired still leaves the
 * header, the links and the artifact list on the page. The queue is read
 * through `lib/`'s `taskArtifactSource` and `readTaskProfile`, the reads
 * `fx-tests task` makes.
 *
 * The failures table is `try.html`'s, narrowed to one job: the same columns,
 * the same assertion lines and stack colouring (`site/assertion-render.ts`),
 * the same 21-day rate (`site/flakiness-fetch.ts`) and profiler icon.
 */

import {
    TREEHERDER_ROOT,
    resolveProfilerOrigin,
    resourceUsageProfileUrl,
    taskArtifactUrl,
    treeherderJobUrl,
    treeherderPushUrl,
} from '../lib/links.ts';
import { formatDurationMs } from '../lib/model/duration.ts';
import { type DroppedMarker, type TestTiming, parseTestMarkers } from '../lib/model/test-markers.ts';
import {
    type TaskIdentity,
    type TaskJson,
    TaskProfileError,
    readTaskDefinition,
    readTaskProfile,
    summarize,
    taskIdentity,
} from '../lib/query/task-summary.ts';
import {
    type FetchLike,
    taskArtifactListName,
    taskArtifactName,
    taskArtifactSource,
    taskStatusName,
} from '../lib/sources/http.ts';
import { DataFetchError, DataFileNotFoundError, type DataSource, fetchJson } from '../lib/sources/source.ts';
import { type AssertionItem, renderAssertionItem } from './assertion-render.ts';
import { el, externalLink } from './drilldown-render.ts';
import {
    type Artifact,
    type ArtifactSize,
    type AssertionView,
    type FailureView,
    type Link,
    type ManifestGroup,
    type Outcome,
    type PageTaskDefinition,
    type TaskPageParams,
    type TaskRun,
    type TaskStatus,
    type TestFilter,
    type TestRow,
    DETAIL_LINES,
    artifactRows,
    artifactSizeFromHeaders,
    artifactSizesFromProfile,
    droppedViews,
    flakinessRequestsForTask,
    formatBytes,
    hiddenRowsLabel,
    manifestStatus,
    noPermanentFailureNote,
    failureViews,
    jobProfilerUrl,
    liveLogUrl,
    manifestGroups,
    manifestsFromSummary,
    matchesTest,
    outcomeCounts,
    outcomeSentence,
    outcomeTally,
    parseTaskInput,
    readParams,
    runFacts,
    selectGroups,
    splitPath,
    taskclusterRunUrl,
    testRows,
    treeherderLogUrl,
} from './task-view.ts';
import { fetchFlakiness, mitten, paintFlakinessCell } from './flakiness-fetch.ts';
import { copyToClipboard, taskPageUrl, testRowLink } from './test-link.ts';
import { countClass } from './try-view.ts';

type Fetch = (url: string, init?: { method?: string }) => Promise<Response>;

/** `$('id')`, typed, failing loudly on a markup/code mismatch. */
function byId(id: string): HTMLElement {
    const node = document.getElementById(id);
    if (node === null) {
        throw new Error(`task.html has no #${id}`);
    }
    return node;
}

function statusBadge(status: string): HTMLElement {
    return el('span', { class: `status-badge status-${status}`, text: status });
}

/** The profiler icon `try.html` uses for a per-test profile. */
function profilerIcon(url: string): HTMLAnchorElement {
    const anchor = el('a', {
        class: 'profiler-cmd',
        href: url,
        title: 'Open the failure profile in the Firefox Profiler',
        attrs: { rel: 'noopener' },
    });
    anchor.target = '_blank';
    return anchor;
}

// --- requests ------------------------------------------------------------

/** The fetch the page uses, as `lib/`'s `FetchLike` wants it. */
function asFetchLike(fetchFn: Fetch): FetchLike {
    return (url) => fetchFn(url);
}

/**
 * The same, reporting the bytes of a download as they arrive — the profile runs
 * to 50 MB and a silent wait reads as a hung page — and then `onDone`, with a
 * turn of the event loop so it can paint before the parse that follows.
 */
function withProgress(fetchFn: Fetch, onProgress: (bytes: number) => void, onDone: () => void): FetchLike {
    return async (url) => {
        const response = await fetchFn(url);
        return {
            ok: response.ok,
            status: response.status,
            url: response.url,
            async arrayBuffer(): Promise<ArrayBuffer> {
                const reader = response.body?.getReader();
                if (reader === undefined) {
                    return response.arrayBuffer();
                }
                const chunks: Uint8Array[] = [];
                let total = 0;
                for (let next = await reader.read(); !next.done; next = await reader.read()) {
                    chunks.push(next.value);
                    total += next.value.length;
                    onProgress(total);
                }
                const bytes = new Uint8Array(total);
                let offset = 0;
                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.length;
                }
                onDone();
                await new Promise((resolve) => setTimeout(resolve, 0));
                return bytes.buffer;
            },
        };
    };
}

/** Every artifact of the run, following the listing's pagination. */
async function fetchArtifacts(source: DataSource, taskId: string, retryId: number): Promise<Artifact[]> {
    const artifacts: Artifact[] = [];
    let token: string | undefined;
    do {
        const page = await fetchJson<{ artifacts: Artifact[]; continuationToken?: string }>(
            source,
            taskArtifactListName(taskId, retryId, token)
        );
        artifacts.push(...page.artifacts);
        token = page.continuationToken;
    } while (token !== undefined);
    return artifacts;
}

/**
 * The Treeherder job ID of a task run, which the parsed-log view is addressed
 * by and the task definition does not carry. `null` when Treeherder has none.
 */
async function fetchTreeherderJobId(fetchFn: Fetch, taskId: string, retryId: number): Promise<number | null> {
    const response = await fetchFn(`${TREEHERDER_ROOT}/api/jobs/?task_id=${taskId}&retry_id=${retryId}`);
    if (!response.ok) {
        return null;
    }
    const page = (await response.json()) as { results: unknown[][]; job_property_names: string[] };
    const id = page.results[0]?.[page.job_property_names.indexOf('id')];
    return typeof id === 'number' ? id : null;
}

// --- page state ----------------------------------------------------------

interface PageState {
    params: TaskPageParams;
    origin: string;
    definition: PageTaskDefinition | null;
    identity: TaskIdentity;
    status: TaskStatus | null;
    treeherderJobId: number | null;
    result: TaskJson | null;
    /** Sizes the profile's `Artifact` markers recorded, uncompressed. */
    recordedSizes: Map<string, number>;
    /** Sizes from HEAD requests, compressed for a gzip-stored file. */
    headSizes: Map<string, ArtifactSize>;
    /** The queue answered 400 or 404 for the definition: there is no such task. */
    unknownTask: boolean;
}

function selectedRun(state: PageState): TaskRun | null {
    return state.status?.status.runs?.find((run) => run.runId === state.params.retryId) ?? null;
}

// --- the header ----------------------------------------------------------

function renderHeader(state: PageState): void {
    const { taskId, retryId } = state.params;
    const { jobName, project, revision } = state.identity;
    document.title = `${jobName ?? `${taskId}.${retryId}`} — Task`;

    const run = selectedRun(state);
    const stateBadge = byId('run-state');
    stateBadge.replaceChildren();
    if (run !== null) {
        stateBadge.append(el('span', { class: `run-state state-${run.state}`, text: run.state }));
    }

    const facts = byId('facts');
    const links = byId('links');
    facts.replaceChildren();
    links.replaceChildren();
    if (state.unknownTask) {
        return;
    }

    const addFact = (label: string, value: Node | string, title?: string): void => {
        facts.append(
            el('div', { class: 'fact-label', text: label }),
            el('div', {
                class: 'fact-value',
                title,
                children: [typeof value === 'string' ? document.createTextNode(value) : value],
            })
        );
    };
    if (jobName !== null) {
        addFact('Job', jobName);
    }
    if (project !== null || revision !== null) {
        const text = [project, revision?.slice(0, 12)].filter((part) => part !== null).join(' ');
        addFact(
            'Push',
            project !== null && revision !== null
                ? externalLink(treeherderPushUrl(project, revision), text)
                : text
        );
    }
    for (const fact of runFacts(run, state.definition)) {
        const value = el('span');
        for (const part of fact.parts) {
            value.append(
                part.title === undefined
                    ? part.text
                    : el('span', { class: 'has-tooltip', title: part.title, text: part.text })
            );
        }
        addFact(fact.label, value);
    }
    const runs = state.status?.status.runs ?? [];
    if (runs.length > 1) {
        const list = el('span');
        runs.forEach((other, i) => {
            if (i > 0) {
                list.append(' · ');
            }
            const label = `${other.runId} (${other.state})`;
            list.append(
                other.runId === retryId
                    ? el('strong', { text: label })
                    : el('a', { text: label, href: taskPageUrl(taskId, other.runId) })
            );
        });
        addFact('Runs', list);
    }

    // `try.html`'s "View on Treeherder" position: beside the input, before
    // anything else. Treeherder last, because it is the one reached through
    // a second lookup and may not be there.
    const view: (Node | string)[] = ['View: '];
    const add = (link: Link): void => {
        view.push(externalLink(link.url, link.label), ' ');
    };
    add({ label: 'Profile', url: jobProfilerUrl(taskId, retryId, jobName, state.origin) });
    add({ label: 'Taskcluster', url: taskclusterRunUrl(taskId, retryId) });
    add({ label: 'raw log', url: liveLogUrl(taskId, retryId) });
    if (project !== null && revision !== null) {
        view.push('Treeherder: ');
        add({ label: 'job', url: treeherderJobUrl(project, revision, taskId, retryId) });
        if (state.treeherderJobId !== null) {
            add({ label: 'parsed log', url: treeherderLogUrl(project, state.treeherderJobId) });
        }
    }
    links.append(...view);
}

// --- the results ---------------------------------------------------------

function renderSummary(timings: readonly TestTiming[]): void {
    byId('summary').replaceChildren(el('span', { text: outcomeSentence(outcomeTally(timings)) }));
}

/** One line of output as `try.html`'s shared assertion item. */
function assertionItem(item: AssertionView, cls: string): AssertionItem {
    let content: Node | string = item.message;
    if (item.crash !== null) {
        content =
            item.crash.url === null
                ? el('span', { class: 'crash-sig', text: item.message })
                : externalLink(item.crash.url, item.message, 'crash-sig');
    }
    return { cls, content, stack: item.stack ?? undefined };
}

/**
 * `try.html`'s assertion list — phase chips, lines, stacks — cut to about
 * `DETAIL_LINES` lines behind a "show more" when the output is longer, so one
 * leak's stacks do not push every other failure off the screen.
 */
function assertionList(view: FailureView): Node[] {
    const items: AssertionItem[] = [];
    for (const phase of view.phases) {
        const cls = phase.label === 'Initial' ? 'phase-initial' : phase.label === 'Retry' ? 'phase-retry' : '';
        if (phase.label !== null) {
            items.push({
                separator: true,
                label: phase.label,
                cls,
                icon: phase.profile === null ? null : profilerIcon(phase.profile),
            });
        }
        items.push(...phase.items.map((item) => assertionItem(item, cls)));
    }
    const list = el('ul', {
        class: 'assertion-list',
        children: items.map((item) => renderAssertionItem(item, false)),
    });
    if (view.lines <= DETAIL_LINES) {
        return [list];
    }
    list.classList.add('clamped');
    const more = el('a', { class: 'show-more-link', text: 'show more' });
    more.addEventListener('click', () => {
        const clamped = list.classList.toggle('clamped');
        more.textContent = clamped ? 'show more' : 'show less';
    });
    return [list, more];
}

/**
 * One failing test: its summary row and its assertion list, which the row
 * toggles. `expanded` is the section's default — open for a permanent
 * failure, closed for one the retry rescued.
 */
function failureRows(
    view: FailureView,
    expanded: boolean,
    flakinessCells: Map<string, HTMLElement>
): HTMLTableRowElement[] {
    const row = el('tr', {
        class: `failure-row clickable-row${expanded ? ' expanded' : ''}`,
        title: 'Click to show or hide the output',
        attrs: { 'data-path': view.path },
    });
    row.append(el('td', { class: `count-cell ${countClass(view.failureCount)}`, text: String(view.failureCount) }));
    row.append(el('td', { children: view.statuses.flatMap((status) => [statusBadge(status), ' ']) }));
    const flakiness = el('td', { class: 'flakiness-cell' });
    flakinessCells.set(view.path, flakiness);
    row.append(flakiness);
    const info = el('td', {
        class: 'test-info',
        children: [el('span', { class: 'test-path', children: testRowLink(view.path) })],
    });
    if (view.commonMessage !== null) {
        info.append(el('div', { class: 'inline-message', title: view.commonMessage, text: view.commonMessage }));
    }
    row.append(info);

    const actions = el('td', { class: 'repro-cell' });
    if (view.profile !== null) {
        const icon = profilerIcon(view.profile);
        icon.addEventListener('click', (event) => event.stopPropagation());
        actions.append(icon);
    }
    const copy = el('span', { class: 'copy-cmd', text: '\u{1F4CB}', title: 'Copy mach test command' });
    copy.addEventListener('click', (event) => {
        event.stopPropagation();
        void copyToClipboard(`./mach test ${view.path} --headless`, copy);
    });
    actions.append(copy);
    row.append(actions);

    const detail = el('tr', {
        class: 'detail-row',
        attrs: { 'data-path': view.path },
        children: [
            el('td', { attrs: { colspan: '3' } }),
            el('td', { class: 'test-info', children: assertionList(view) }),
            el('td'),
        ],
    });
    detail.hidden = !expanded;
    row.addEventListener('click', (event) => {
        // A click on a link or a selection drag is not a toggle.
        if ((event.target as Element).closest('a, button') !== null || String(window.getSelection?.() ?? '') !== '') {
            return;
        }
        detail.hidden = !detail.hidden;
        row.classList.toggle('expanded', !detail.hidden);
    });
    return [row, detail];
}

function failureTable(
    views: readonly FailureView[],
    expanded: boolean,
    flakinessCells: Map<string, HTMLElement>
): HTMLElement {
    const head = el('tr', {
        children: [
            el('th', { text: '#', title: 'Failing executions', attrs: { style: 'width: 24px' } }),
            el('th', { text: 'Status', attrs: { style: 'width: 80px' } }),
            el('th', {
                title:
                    'Existing flakiness: how often this same failure already happens on autoland ' +
                    'and mozilla-central over the last 21 days, on this job’s configuration. ' +
                    'Hover a value for the details.',
                attrs: { style: 'width: 60px; text-align: right' },
                children: [mitten()],
            }),
            el('th', { text: 'Test' }),
            el('th', { attrs: { style: 'width: 44px' } }),
        ],
    });
    const body = el('tbody');
    for (const view of views) {
        body.append(...failureRows(view, expanded, flakinessCells));
    }
    return el('table', { class: 'failure-table', children: [el('thead', { children: [head] }), body] });
}

/**
 * Two sections, as the summary sentence splits them: the tests that failed
 * for good, open, then the ones the harness's retry rescued, closed. The first
 * is always there, so "0" is stated rather than left to a missing heading.
 */
function renderFailures(state: PageState, timings: readonly TestTiming[]): Map<string, HTMLElement> {
    const result = state.result!;
    const views = failureViews(result, timings, state.origin);
    const permanent = views.filter((view) => view.category === 'permanent');
    const rescued = views.filter((view) => view.category === 'passedOnRetry');
    const cells = new Map<string, HTMLElement>();
    const section = byId('failures');
    section.hidden = false;
    section.replaceChildren(el('h2', { text: `Permanent failures (${permanent.length})` }));
    section.append(
        permanent.length > 0
            ? failureTable(permanent, true, cells)
            : el('p', { class: 'section-note', text: noPermanentFailureNote(result, selectedRun(state)) })
    );
    if (rescued.length > 0) {
        section.append(
            el('h2', { text: `Failed then passed on retry (${rescued.length})` }),
            failureTable(rescued, false, cells)
        );
    }
    return cells;
}

/** Fills the flakiness column from the 21-day aggregates, as `try.html` does. */
async function loadFlakiness(
    state: PageState,
    timings: readonly TestTiming[],
    cells: Map<string, HTMLElement>
): Promise<void> {
    const requests = flakinessRequestsForTask(state.result!, timings);
    if (requests.length === 0) {
        return;
    }
    await fetchFlakiness(
        requests,
        requests.map((request) => request.path),
        (path, data) => {
            const cell = cells.get(path);
            if (cell !== undefined) {
                paintFlakinessCell(cell, path, data);
            }
        }
    );
}

function renderDropped(state: PageState, dropped: readonly DroppedMarker[]): void {
    const section = byId('dropped');
    section.replaceChildren();
    const views = droppedViews(dropped, state.params.taskId, state.params.retryId);
    if (views.length === 0) {
        section.hidden = true;
        return;
    }
    section.hidden = false;
    section.append(
        el('h2', { text: `Failures not attributed to a test (${views.length})` }),
        el('p', {
            class: 'section-note',
            text:
                'Failing markers that named a manifest or no test path, such as a crash during ' +
                'shutdown. They are not in the tables.',
        })
    );
    const list = el('ul', { class: 'dropped-list' });
    for (const view of views) {
        list.append(
            el('li', {
                children: [
                    statusBadge(view.status),
                    ' ',
                    el('span', { class: 'mono', text: view.id }),
                    view.crash === null ? null : ' ',
                    view.crash === null ? null : externalLink(view.crash.url, view.crash.label),
                ],
            })
        );
    }
    section.append(list);
}

// --- the tests tree ------------------------------------------------------

const OUTCOME_LABELS: Record<Outcome | 'all', string> = {
    all: 'All',
    failed: 'Failed',
    passed: 'Passed',
    skipped: 'Skipped',
    other: 'Other',
};

/** The shared test link, its directory in grey so the file name stands out. */
function splitPathLink(path: string): Node[] {
    const [link, ...buttons] = testRowLink(path);
    const { directory, name } = splitPath(path);
    link.replaceChildren(el('span', { class: 'path-directory', text: directory }), name);
    return [link, ...buttons];
}

function testRowElement(row: TestRow, highlight: string | null): HTMLTableRowElement {
    return el('tr', {
        class: `test-row${matchesTest(row.path, highlight) ? ' highlight' : ''}`,
        attrs: { 'data-path': row.path },
        children: [
            el('td', { class: 'test-path', children: splitPathLink(row.path) }),
            el('td', { children: row.statuses.flatMap((s) => [statusBadge(s), ' ']) }),
            el('td', {
                class: 'num',
                text: String(row.executions),
                title: row.reruns > 0 ? `${row.reruns} of them harness retries` : undefined,
            }),
            el('td', { class: 'num', text: formatDurationMs(row.duration) }),
        ],
    });
}

function manifestStatusNodes(group: ManifestGroup): (Node | string)[] {
    const status = manifestStatus(group);
    if (status === null) {
        return [];
    }
    return status.count === null ? [statusBadge(status.status)] : [statusBadge(status.status), ` ${status.count}`];
}

function manifestRowElement(group: ManifestGroup, expanded: boolean, onToggle: () => void): HTMLTableRowElement {
    const label = el('td', {
        class: 'manifest-name',
        title: group.known ? undefined : 'No manifest recorded for these tests; grouped by directory.',
        children: [
            el('span', { class: 'toggle', text: expanded ? '▾ ' : '▸ ' }),
            group.manifest,
            el('span', { class: 'manifest-count', text: ` (${group.rows.length})` }),
        ],
    });
    const row = el('tr', {
        class: 'manifest-row',
        attrs: { 'data-manifest': group.manifest },
        children: [
            label,
            el('td', { children: manifestStatusNodes(group) }),
            el('td'),
            el('td', { class: 'num', text: formatDurationMs(group.duration) }),
        ],
    });
    row.addEventListener('click', onToggle);
    return row;
}

function renderTests(
    rows: readonly TestRow[],
    manifests: ReadonlyMap<string, string> | null,
    highlight: string | null
): void {
    const section = byId('tests');
    section.hidden = rows.length === 0;
    const groups = manifestGroups(rows, manifests);
    const counts = outcomeCounts(rows);
    const select = byId('outcome-select') as HTMLSelectElement;
    select.replaceChildren();
    for (const outcome of ['all', 'failed', 'passed', 'skipped', 'other'] as const) {
        if (outcome !== 'all' && counts[outcome] === 0) {
            continue;
        }
        select.append(
            el('option', { text: `${OUTCOME_LABELS[outcome]} (${counts[outcome]})`, attrs: { value: outcome } })
        );
    }
    const filterBox = byId('test-filter') as HTMLInputElement;
    const sortSelect = byId('sort-select') as HTMLSelectElement;
    const body = byId('tests-body');
    const shownCount = byId('tests-shown');

    // Open to begin with: the manifests holding a failure or the named test.
    // Manifests whose passing tests are shown too. By default a manifest with
    // a failure lists only its failures, and the rest behind one row.
    const revealed = new Set<string>();
    const expanded = new Set(
        groups
            .filter((group) => group.failed > 0 || group.rows.some((row) => matchesTest(row.path, highlight)))
            .map((group) => group.manifest)
    );
    const draw = (): void => {
        const filter: TestFilter = {
            text: filterBox.value,
            outcome: select.value as TestFilter['outcome'],
            sort: sortSelect.value as TestFilter['sort'],
        };
        const selected = selectGroups(groups, filter);
        const shown = selected.reduce((sum, group) => sum + group.rows.length, 0);
        shownCount.textContent =
            `${selected.length} manifest${selected.length === 1 ? '' : 's'}` +
            (shown === rows.length ? '' : `, ${shown} of ${rows.length} tests shown`);
        // A filter is a search: show what it found without another click.
        const searching = filter.text.trim() !== '' || filter.outcome !== 'all';
        const nodes: HTMLTableRowElement[] = [];
        for (const group of selected) {
            const open = searching || expanded.has(group.manifest);
            nodes.push(
                manifestRowElement(group, open, () => {
                    if (open) {
                        expanded.delete(group.manifest);
                    } else {
                        expanded.add(group.manifest);
                    }
                    draw();
                })
            );
            if (!open) {
                continue;
            }
            const failing = group.rows.filter((row) => row.outcome === 'failed');
            const others = group.rows.filter((row) => row.outcome !== 'failed');
            const foldable =
                !searching &&
                failing.length > 0 &&
                others.length > 0 &&
                !others.some((row) => matchesTest(row.path, highlight));
            if (!foldable) {
                nodes.push(...group.rows.map((row) => testRowElement(row, highlight)));
                continue;
            }
            const shown = revealed.has(group.manifest);
            nodes.push(...(shown ? group.rows : failing).map((row) => testRowElement(row, highlight)));
            // The fold row stays after unfolding, so it can fold back.
            const more = el('tr', {
                class: 'more-row',
                children: [
                    el('td', {
                        attrs: { colspan: '4' },
                        text: shown ? `− hide the ${others.length} that did not fail` : hiddenRowsLabel(others),
                    }),
                ],
            });
            more.addEventListener('click', () => {
                if (shown) {
                    revealed.delete(group.manifest);
                } else {
                    revealed.add(group.manifest);
                }
                draw();
            });
            nodes.push(more);
        }
        body.replaceChildren(...nodes);
    };
    filterBox.addEventListener('input', draw);
    select.addEventListener('change', draw);
    sortSelect.addEventListener('change', draw);
    draw();
}

/**
 * The artifact list: the profiler icon in front of a profile, then the name,
 * the size, and the crash viewer for a minidump. Sizes fill in as they arrive.
 */
function renderArtifacts(state: PageState, artifacts: readonly Artifact[]): void {
    const { taskId, retryId } = state.params;
    const rows = artifactRows(artifacts, taskId, retryId, state.identity.jobName, state.origin);
    const section = byId('artifacts');
    section.replaceChildren(el('h2', { text: `Artifacts (${rows.length})` }));
    const list = el('table', { class: 'artifact-table' });
    for (const row of rows) {
        const profile = row.viewer?.label === 'Profiler' ? row.viewer : null;
        const other = row.viewer !== null && profile === null ? row.viewer : null;
        list.append(
            el('tr', {
                children: [
                    el('td', { class: 'artifact-icon', children: profile === null ? [] : [profilerIcon(profile.url)] }),
                    el('td', { class: 'mono', children: [externalLink(row.url, row.name)] }),
                    el('td', { class: 'num artifact-size', attrs: { 'data-name': row.name } }),
                    el('td', { children: other === null ? [] : [externalLink(other.url, other.label)] }),
                ],
            })
        );
    }
    section.append(list);
    renderArtifactSizes(state);
}

/** Writes every size known so far into the artifact table. */
function renderArtifactSizes(state: PageState): void {
    for (const cell of document.querySelectorAll<HTMLElement>('#artifacts .artifact-size')) {
        const name = cell.dataset['name'] ?? '';
        const exact = state.recordedSizes.get(name);
        const head = state.headSizes.get(name);
        if (exact !== undefined) {
            cell.textContent = formatBytes(exact);
            cell.title = '';
        } else if (head !== undefined) {
            cell.textContent = head.compressed ? `${formatBytes(head.bytes)} gz` : formatBytes(head.bytes);
            cell.title = head.compressed ? 'Compressed size; the file is served decompressed.' : '';
        }
    }
}

/** Asks the storage for each stored artifact's size, a few at a time. */
async function fetchArtifactSizes(fetchFn: Fetch, state: PageState, artifacts: readonly Artifact[]): Promise<void> {
    const queue = artifacts.filter((artifact) => artifact.storageType !== 'reference');
    const worker = async (): Promise<void> => {
        for (let artifact = queue.shift(); artifact !== undefined; artifact = queue.shift()) {
            try {
                const response = await fetchFn(
                    taskArtifactUrl(state.params.taskId, state.params.retryId, artifact.name),
                    { method: 'HEAD' }
                );
                const size = response.ok ? artifactSizeFromHeaders((name) => response.headers.get(name)) : null;
                if (size !== null) {
                    state.headSizes.set(artifact.name, size);
                    renderArtifactSizes(state);
                }
            } catch {
                // No size; the row keeps its link.
            }
        }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
}

function showError(id: string, message: string): void {
    const node = byId(id);
    node.hidden = false;
    node.textContent = message;
}

/**
 * Why the profile could not be read, in terms of what to do next. The
 * classification is `readTaskProfile`'s, the one `fx-tests task` words too.
 */
function profileErrorMessage(error: unknown, run: TaskRun | null): string {
    if (!(error instanceof TaskProfileError)) {
        return `Could not read the profile: ${(error as Error).message}`;
    }
    switch (error.problem) {
        case 'missing':
            if (run !== null && (run.state === 'running' || run.state === 'pending')) {
                return `This run is still ${run.state}; the profile is uploaded when it finishes.`;
            }
            return (
                'This run has no profile_resource-usage.json. Taskcluster expires artifacts after ' +
                'about a month, and a job that is not a test job never uploads one.'
            );
        case 'streamed':
            return (
                'This job was killed for exceeding its maximum duration, so its profile is a ' +
                'partial stream and has no per-test results. Its duration is the problem to ' +
                'look at; the log has the rest.'
            );
        case 'invalid-json':
            return `The profile is not valid JSON: ${error.message}`;
        case 'not-a-task':
        case 'fetch':
            return `Could not read the profile: ${error.message}`;
    }
}

/** Whether the queue says there is no such task: 400 for a malformed ID, 404 for an unknown one. */
function isUnknownTask(error: unknown): boolean {
    return error instanceof DataFileNotFoundError || (error instanceof DataFetchError && error.status === 400);
}

// --- start ---------------------------------------------------------------

/** The heading's task field: Enter goes to what was typed. */
function initInput(params: TaskPageParams | null): void {
    const input = byId('task-input') as HTMLInputElement;
    if (params !== null) {
        input.value = `${params.taskId}.${params.retryId}`;
    } else {
        input.focus();
    }
    input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') {
            return;
        }
        const task = parseTaskInput(input.value);
        if (task === null) {
            showError('form-error', 'Not a task ID, a Treeherder job URL or a Taskcluster task URL.');
            return;
        }
        window.location.href = taskPageUrl(task.taskId, task.retryId);
    });
}

/** Starts the page. `fetch` is injectable for the page test. */
export async function start(options: { fetch?: Fetch } = {}): Promise<void> {
    const fetchFn: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
    const params = readParams(window.location.search);
    initInput(params);
    if (params === null) {
        byId('task-view').hidden = true;
        return;
    }
    const { taskId, retryId } = params;
    const state: PageState = {
        params,
        origin: resolveProfilerOrigin(new URLSearchParams(window.location.search).get('profiler')),
        definition: null,
        identity: { jobName: null, project: null, revision: null },
        status: null,
        treeherderJobId: null,
        result: null,
        recordedSizes: new Map(),
        headSizes: new Map(),
        unknownTask: false,
    };
    renderHeader(state);
    const source = taskArtifactSource({ fetch: asFetchLike(fetchFn) });

    const definitionLoad = readTaskDefinition<PageTaskDefinition>(source, taskId)
        .then((definition) => {
            state.definition = definition;
            state.identity = taskIdentity(definition);
        })
        .catch((error: unknown) => {
            state.unknownTask = isUnknownTask(error);
            showError(
                'header-error',
                state.unknownTask
                    ? `Taskcluster has no task ${taskId}.`
                    : `Could not read the task definition: ${(error as Error).message}`
            );
        });
    const statusLoad = fetchJson<TaskStatus>(source, taskStatusName(taskId))
        .then((status) => {
            state.status = status;
        })
        .catch(() => {
            // The header loses its run facts and nothing else.
        });
    const headerLoad = Promise.all([definitionLoad, statusLoad]).then(() => renderHeader(state));
    // Its own render: the parsed-log link is the only thing it adds.
    const jobIdLoad = fetchTreeherderJobId(fetchFn, taskId, retryId)
        .then(async (id) => {
            state.treeherderJobId = id;
            await headerLoad;
            renderHeader(state);
        })
        .catch(() => {
            // No parsed-log link; the Treeherder job link does not need the ID.
        });

    const artifactsLoad = fetchArtifacts(source, taskId, retryId)
        .then(async (artifacts) => {
            await headerLoad;
            renderArtifacts(state, artifacts);
            await fetchArtifactSizes(fetchFn, state, artifacts);
        })
        .catch(async (error: unknown) => {
            await headerLoad;
            if (state.unknownTask) {
                return;
            }
            byId('artifacts').replaceChildren(
                el('h2', { text: 'Artifacts' }),
                el('p', { class: 'section-note', text: `Could not list them: ${(error as Error).message}` })
            );
        });
    // Missing on older jobs and on some harnesses: the tree then groups by
    // directory, which is what `manifestGroups` falls back to.
    const manifestsLoad = source
        .fetch(taskArtifactName(taskId, retryId, 'public/test_info/summary.jsonl'))
        .then((bytes) => manifestsFromSummary(new TextDecoder().decode(bytes)))
        .catch(() => null);

    const status = byId('status-text');
    const profileLoad = (async (): Promise<void> => {
        status.textContent = 'Downloading the resource-usage profile…';
        const profileSource = taskArtifactSource({
            fetch: withProgress(
                fetchFn,
                (n) => {
                    status.textContent = `Downloading the resource-usage profile… ${(n / 1e6).toFixed(1)} MB`;
                },
                () => {
                    status.textContent = 'Reading the profile…';
                }
            ),
        });
        let profile: unknown;
        try {
            profile = await readTaskProfile(profileSource, taskId, retryId);
        } catch (error) {
            await headerLoad;
            status.textContent = '';
            if (!state.unknownTask) {
                showError('results-error', profileErrorMessage(error, selectedRun(state)));
            }
            return;
        }
        await headerLoad;
        const dropped: DroppedMarker[] = [];
        const timings = parseTestMarkers(
            profile,
            { jobName: state.identity.jobName ?? `${taskId}.${retryId}`, taskId, retryId },
            dropped
        );
        state.result = summarize(taskId, retryId, state.identity, resourceUsageProfileUrl(taskId, retryId), timings);
        state.recordedSizes = artifactSizesFromProfile(profile);
        renderArtifactSizes(state);
        status.textContent = '';
        renderSummary(timings);
        const flakinessCells = renderFailures(state, timings);
        renderDropped(state, dropped);
        renderTests(testRows(timings), await manifestsLoad, params.test);
        scrollToTest(params.test);
        await loadFlakiness(state, timings, flakinessCells).catch(() => {
            // A blank column: the history is a comparison, not the answer.
        });
    })();

    await Promise.all([headerLoad, jobIdLoad, artifactsLoad, profileLoad]);
}

/** Scrolls to the test a linking page named, and marks it. */
function scrollToTest(test: string | null): void {
    const candidates = [
        ...document.querySelectorAll<HTMLElement>('#failures .failure-row'),
        ...document.querySelectorAll<HTMLElement>('#tests-body tr.test-row'),
    ];
    const target = candidates.find((node) => matchesTest(node.dataset['path'] ?? '', test));
    if (target === undefined) {
        return;
    }
    target.classList.add('highlight');
    target.scrollIntoView({ block: 'center' });
}
