import type { PerformanceRun } from './performance-view.ts';
import { errorMessage } from './performance-dom.ts';

interface BugMapping {
    repository: string; job_label: string; regression_bug_ids: number[];
    window_start: string; generated_at: string;
}
type MappingIndex = Map<string, BugMapping>;
interface Bug { id: number; resolution?: string | null }
interface QueryResult<T> { query_result?: { data?: { rows?: T[] } } }
interface SourceConfig { results_url: string; resolutions_results_url: string }

export function indexPerformanceAlerts(rows: unknown): MappingIndex {
    if (!Array.isArray(rows) || !rows.length) throw new Error('Bug results are empty');
    const index: MappingIndex = new Map();
    for (const row of rows as Record<string, unknown>[]) {
        if (row['schema_version'] !== 3 || typeof row['repository'] !== 'string' ||
            typeof row['job_label'] !== 'string' || typeof row['window_start'] !== 'string' ||
            typeof row['generated_at'] !== 'string' || !Array.isArray(row['regression_bug_ids']) ||
            !row['regression_bug_ids'].every(id => Number.isInteger(id) && id > 0)) {
            throw new Error('Unsupported bug mapping format');
        }
        const mapping: BugMapping = {
            repository: row['repository'], job_label: row['job_label'],
            window_start: row['window_start'], generated_at: row['generated_at'],
            regression_bug_ids: row['regression_bug_ids'] as number[],
        };
        const key = JSON.stringify([mapping.repository, mapping.job_label]);
        if (index.has(key)) throw new Error('Duplicate job mapping in bug results');
        index.set(key, mapping);
    }
    return index;
}

export function countPerformanceAlerts(runs: Pick<PerformanceRun, 'project' | 'label'>[], index: MappingIndex) {
    const keys = new Set(runs.map(run => JSON.stringify([run.project, run.label])));
    const ids = new Set<number>();
    let mapped = 0;
    for (const key of keys) {
        const match = index.get(key);
        if (!match) continue;
        mapped++;
        match.regression_bug_ids.forEach(id => ids.add(id));
    }
    return { bugIds: [...ids].sort((a, b) => a - b), total: ids.size, mapped, configurations: keys.size };
}
export const performanceAlertsState: {
    status: 'loading' | 'ready' | 'error'; index: MappingIndex | null;
    error: string; windowStart: string; generatedAt: string;
} = { status: 'loading', index: null, error: '', windowStart: '', generatedAt: '' };
export const performanceAlertCells: { runs: PerformanceRun[]; totalCell: HTMLTableCellElement }[] = [];
export function clearPerformanceAlertCells() { performanceAlertCells.length = 0; }

const BUG_RESOLUTIONS = [
    ['Fixed', '#2a78d6'], ["Won’t fix", '#eb6834'], ['Invalid', '#1baf7a'],
    ['Duplicate', '#eda100'], ['Works for me', '#4a3aa7'], ['Other', '#e87ba4'],
    ['Open', '#008300'], ['Unknown', '#c5c5c5'],
] as const;
type Resolution = typeof BUG_RESOLUTIONS[number][0];
const bugResolutions = new Map<number, Resolution>();

function bugResolution(bug: Bug): Resolution {
    if (!bug || typeof bug.resolution !== 'string') return 'Unknown';
    return ({ FIXED: 'Fixed', WONTFIX: 'Won’t fix', INVALID: 'Invalid', DUPLICATE: 'Duplicate',
        WORKSFORME: 'Works for me', '': 'Open' } as Record<string, Resolution>)[bug.resolution] || 'Other';
}

async function loadBugResolutions(url: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as QueryResult<Bug>;
        const rows = data.query_result?.data?.rows;
        if (!Array.isArray(rows)) throw new Error('Unsupported resolution results');
        for (const bug of rows) {
            if (Number.isInteger(bug.id)) bugResolutions.set(bug.id, bugResolution(bug));
        }
    } catch { /* Missing or inaccessible bugs remain explicitly unknown. */ }
    finally {
        clearTimeout(timeout);
        updatePerformanceAlertCells();
    }
}

export function updatePerformanceAlertCells() {
    for (const { runs, totalCell } of performanceAlertCells) {
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
        for (const [name, color] of BUG_RESOLUTIONS) {
            const ids = counts.bugIds.filter(id => (bugResolutions.get(id) || 'Unknown') === name);
            const line = document.createElement('div');
            const swatch = document.createElement('span');
            swatch.className = 'resolution-swatch';
            swatch.style.backgroundColor = color;
            const text = document.createElement('span');
            text.textContent = `${name}: `;
            const number = document.createElement('a');
            number.textContent = String(ids.length);
            if (ids.length) {
                const url = new URL('https://bugzilla.mozilla.org/buglist.cgi');
                url.searchParams.set('bug_id', ids.join(','));
                number.href = url.href;
                number.target = '_blank';
                number.rel = 'noopener noreferrer';
                number.setAttribute('aria-label', `${name}: ${ids.length} bugs`);
            }
            line.append(swatch, text, number);
            popup.appendChild(line);
        }
        const show = () => {
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
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
        const configResponse = await fetch('./performance-alerts-source.json', { signal: controller.signal });
        if (!configResponse.ok) throw new Error(`Alert configuration: HTTP ${configResponse.status}`);
        const config = await configResponse.json() as SourceConfig;
        const response = await fetch(config.results_url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Alert results: HTTP ${response.status}`);
        const result = await response.json() as QueryResult<unknown>;
        const rows = result.query_result?.data?.rows;
        performanceAlertsState.index = indexPerformanceAlerts(rows);
        performanceAlertsState.status = 'ready';
        performanceAlertsState.windowStart = performanceAlertsState.index.values().next().value!.window_start;
        performanceAlertsState.generatedAt = performanceAlertsState.index.values().next().value!.generated_at;
        loadBugResolutions(config.resolutions_results_url);
    } catch (error) {
        performanceAlertsState.status = 'error';
        performanceAlertsState.error = `Bug counts unavailable: ${errorMessage(error)}`;
    } finally {
        clearTimeout(timeout);
        updatePerformanceAlertCells();
        onReady();
    }
}
