import type { PerformanceRun } from './performance-view.ts';
import { element, errorMessage } from './performance-dom.ts';
import { indexPerformanceBugResults } from './performance-regressions.ts';
import type { MappingIndex } from './performance-regressions.ts';

interface Bug { id: number; resolution?: string | null }
interface QueryResult<T> { query_result?: { retrieved_at?: string; data?: { rows?: T[] } } }
// STMO query 129802: cached regression-only job mappings and bug resolutions.
// Daily refresh: 129799 (descriptions), 129801 (database), 129837 (tracker labels).
const BUG_RESULTS_URL = 'https://sql.telemetry.mozilla.org/api/queries/129802/results.json?api_key=NdYG70E9cg5hwu5hOLqeopSSeriuF63xiGQ0KPL8';

export function countPerformanceAlerts(runs: Pick<PerformanceRun, 'project' | 'label'>[], index: MappingIndex) {
    const keys = new Set(runs.map(run => JSON.stringify([run.project, run.label])));
    const ids = new Set<number>();
    for (const key of keys) {
        const match = index.get(key);
        if (!match) continue;
        match.regression_bug_ids.forEach(id => ids.add(id));
    }
    return { bugIds: [...ids].sort((a, b) => a - b), total: ids.size, mapped: keys.size, configurations: keys.size };
}
// Every job label (in any repository) each bug is linked to, built once per index.
const bugLabelsCache = new WeakMap<MappingIndex, Map<number, Set<string>>>();
function bugLabels(index: MappingIndex) {
    let labels = bugLabelsCache.get(index);
    if (!labels) {
        labels = new Map();
        for (const mapping of index.values()) {
            for (const id of mapping.regression_bug_ids) {
                if (!labels.has(id)) labels.set(id, new Set());
                labels.get(id)!.add(mapping.job_label);
            }
        }
        bugLabelsCache.set(index, labels);
    }
    return labels;
}

// Bugs that no job outside these runs' labels is linked to.
export function exclusivePerformanceBugs(runs: Pick<PerformanceRun, 'label'>[], bugIds: number[], index: MappingIndex) {
    const own = new Set(runs.map(run => run.label));
    const labels = bugLabels(index);
    return bugIds.filter(id => [...labels.get(id) ?? []].every(label => own.has(label)));
}

export const performanceAlertsState: {
    status: 'loading' | 'ready' | 'error'; index: MappingIndex | null;
    error: string; windowStart: string; generatedAt: string;
} = { status: 'loading', index: null, error: '', windowStart: '', generatedAt: '' };
export const performanceAlertCells: { runs: PerformanceRun[]; totalCell: HTMLTableCellElement; runtimeShare: number }[] = [];
// The runs of the selected pool and project, the denominator of each bug share.
export const performanceAlertPoolRuns: PerformanceRun[] = [];
export function clearPerformanceAlertCells() { performanceAlertCells.length = 0; }

const BUG_RESOLUTIONS = [
    ['Fixed', '#2e9e44'], ["Won’t fix", '#eb6834'], ['Invalid', '#d7264c'],
    ['Duplicate', '#9b6bd6'], ['Works for me', '#e3b505'], ['Other', '#e87ba4'],
    ['Open', '#2a78d6'], ['Unknown', '#c5c5c5'],
] as const;
type Resolution = typeof BUG_RESOLUTIONS[number][0];
const bugResolutions = new Map<number, Resolution>();
let hideOpenTooltip: (() => void) | null = null;

function bugResolution(bug: Bug): Resolution {
    if (!bug || typeof bug.resolution !== 'string') return 'Unknown';
    return ({ FIXED: 'Fixed', WONTFIX: 'Won’t fix', INVALID: 'Invalid', DUPLICATE: 'Duplicate',
        WORKSFORME: 'Works for me', '': 'Open' } as Record<string, Resolution>)[bug.resolution] || 'Other';
}

// A bug count linking to those bugs in Bugzilla; a plain 0 when there are none.
function bugListLink(ids: number[]): Node {
    if (!ids.length) return document.createTextNode('0');
    const link = document.createElement('a');
    link.textContent = ids.length.toLocaleString();
    const url = new URL('https://bugzilla.mozilla.org/buglist.cgi');
    url.searchParams.set('bug_id', ids.join(','));
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
}

export function updatePerformanceAlertCells() {
    const isFixed = (id: number) => bugResolutions.get(id) === 'Fixed';
    const poolBugs = performanceAlertsState.index && performanceAlertCells.length
        ? countPerformanceAlerts(performanceAlertPoolRuns, performanceAlertsState.index).bugIds : [];
    const bugTotal = poolBugs.length;
    const fixedTotal = poolBugs.filter(isFixed).length;
    const percent = (part: number, whole: number) => `${whole ? (100 * part / whole).toFixed(1) : '0.0'}%`;
    for (const { runs, totalCell, runtimeShare } of performanceAlertCells) {
        if (performanceAlertsState.status !== 'ready') {
            totalCell.textContent = performanceAlertsState.status === 'loading' ? '…' : '—';
            totalCell.title = performanceAlertsState.status === 'loading' ? 'Loading bugs' : performanceAlertsState.error;
            continue;
        }
        const counts = countPerformanceAlerts(runs, performanceAlertsState.index!);
        const breakdown = new Map<Resolution, number>(BUG_RESOLUTIONS.map(([name]) => [name, 0]));
        for (const id of counts.bugIds) {
            const name = bugResolutions.get(id) || 'Unknown';
            breakdown.set(name, (breakdown.get(name) ?? 0) + 1);
        }
        totalCell.removeAttribute('title');
        totalCell.textContent = counts.mapped ? '0' : '—';
        if (!counts.total) continue;
        const container = document.createElement('div');
        container.className = 'resolution-widget';
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'resolution-trigger';
        trigger.setAttribute('aria-label', 'Show bug resolution breakdown');
        trigger.setAttribute('aria-expanded', 'false');
        const popup = document.createElement('div');
        popup.className = 'resolution-tooltip';
        popup.hidden = true;
        const fixedIds = counts.bugIds.filter(isFixed);
        const fixed = fixedIds.length;
        const exclusive = exclusivePerformanceBugs(runs, counts.bugIds, performanceAlertsState.index!);
        const summary = document.createElement('div');
        summary.className = 'resolution-summary';
        for (const parts of [
            [`Runtime share on ${element<HTMLSelectElement>('date').value}: ${runtimeShare.toFixed(1)}%`],
            ['Regression bugs created in the past 365 days: ', bugListLink(counts.bugIds), ` of ${bugTotal.toLocaleString()} (${percent(counts.total, bugTotal)})`],
            ['Fixed bugs: ', bugListLink(fixedIds), ` of ${fixedTotal.toLocaleString()} (${percent(fixed, fixedTotal)})`],
            ['Only found by this test: ', bugListLink(exclusive)],
        ]) {
            const line = document.createElement('div');
            line.append(...parts);
            summary.appendChild(line);
        }
        popup.appendChild(summary);
        for (const [name, color] of BUG_RESOLUTIONS) {
            const ids = counts.bugIds.filter(id => (bugResolutions.get(id) || 'Unknown') === name);
            if (!ids.length) continue;
            const line = document.createElement('div');
            const swatch = document.createElement('span');
            swatch.className = 'resolution-swatch';
            swatch.style.backgroundColor = color;
            const text = document.createElement('span');
            text.textContent = `${name}: `;
            line.append(swatch, text, bugListLink(ids));
            if (name === 'Fixed') line.append(` (${percent(fixed, counts.total)})`);
            popup.appendChild(line);
        }
        const show = () => {
            // A mouseleave can be missed while the window is inactive.
            if (hideOpenTooltip !== hide) hideOpenTooltip?.();
            hideOpenTooltip = hide;
            popup.hidden = false;
            const rect = trigger.getBoundingClientRect();
            popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popup.offsetWidth - 8))}px`;
            popup.style.top = `${rect.bottom + popup.offsetHeight < window.innerHeight ? rect.bottom : Math.max(8, rect.top - popup.offsetHeight)}px`;
            trigger.setAttribute('aria-expanded', 'true');
        };
        const hide = () => { popup.hidden = true; trigger.setAttribute('aria-expanded', 'false'); };
        container.addEventListener('mouseenter', show);
        container.addEventListener('mouseleave', hide);
        container.addEventListener('focusin', show);
        container.addEventListener('focusout', event => { if (!(event.relatedTarget instanceof Node) || !container.contains(event.relatedTarget)) hide(); });
        container.addEventListener('keydown', event => { if (event.key === 'Escape') { hide(); event.stopPropagation(); } });
        container.addEventListener('click', event => event.stopPropagation());
        trigger.addEventListener('click', show);
        const bar = document.createElement('span');
        bar.className = 'resolution-bar';
        bar.setAttribute('aria-hidden', 'true');
        for (const [name, color] of BUG_RESOLUTIONS) {
            const count = breakdown.get(name);
            if (!count) continue;
            const segment = document.createElement('span');
            segment.style.flexGrow = String(count);
            segment.style.backgroundColor = color;
            bar.appendChild(segment);
        }
        const label = document.createElement('span');
        label.className = 'resolution-total';
        label.textContent = counts.total.toLocaleString();
        trigger.append(bar, label);
        container.append(trigger, popup);
        totalCell.replaceChildren(container);
    }
}

export async function loadPerformanceAlerts(onReady: () => void) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(BUG_RESULTS_URL, { signal: controller.signal });
        if (!response.ok) throw new Error(`Bug results: HTTP ${response.status}`);
        const result = await response.json() as QueryResult<unknown>;
        const generatedAt = result.query_result?.retrieved_at;
        const age = Date.now() - Date.parse(generatedAt || '');
        // A failed scheduled refresh leaves the last successful result in STMO.
        // Allow one missed daily refresh, then stop presenting it as current.
        if (!Number.isFinite(age) || age > 48 * 60 * 60 * 1000 || age < -5 * 60 * 1000) {
            throw new Error('STMO bug data is stale or has no valid refresh time.');
        }
        const { index, resolutions } = indexPerformanceBugResults(result.query_result?.data?.rows);
        bugResolutions.clear();
        for (const [id, resolution] of resolutions) bugResolutions.set(id, bugResolution({ id, resolution }));
        performanceAlertsState.index = index;
        performanceAlertsState.windowStart = '';
        performanceAlertsState.generatedAt = generatedAt!;
        performanceAlertsState.status = 'ready';
    } catch (error) {
        performanceAlertsState.status = 'error';
        performanceAlertsState.error = `Bug counts unavailable: ${errorMessage(error)}`;
    } finally {
        clearTimeout(timeout);
        updatePerformanceAlertCells();
        onReady();
    }
}
