import { decodePerformanceTasks, performanceAggregate, performanceGroups, performanceActivity,
    performanceProfilerSeries, performanceGroupName, performanceMarkerSearch, sortPerformanceGroups,
    type PerformanceRun, type PerformanceGroup, type WorkerData, type ProfileTask } from './performance-view.ts';
import { performanceAlertsState, countPerformanceAlerts, performanceAlertCells,
    clearPerformanceAlertCells, updatePerformanceAlertCells, loadPerformanceAlerts } from './performance-alerts.ts';
import { element, errorMessage } from './performance-dom.ts';

declare function fetchFromCI(indexName: string, filename: string): Promise<Response>;
declare function openTaskTimelineInProfiler(tasks: (ProfileTask & {aggregate: string})[], title: string,
    series: ReturnType<typeof performanceProfilerSeries>, start: number, end: number,
    categories: never[], search: string): Promise<void>;
interface TableGroup extends PerformanceGroup { key?: string; parent?: boolean; child?: boolean }
type SortKey = 'name' | 'runtime' | 'runs' | 'alerts' | 'peak';
let performanceRows: PerformanceRun[] = [];
let loadVersion = 0;
const expandedPerformanceGroups = new Set();
let performanceSort: {key: SortKey; descending: boolean} = { key: 'runtime', descending: true };

function performanceActivityGraph(buckets: number[], name: string) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    const peak = Math.max(1, ...buckets);
    svg.classList.add('activity-track');
    svg.setAttribute('viewBox', `0 0 ${buckets.length} 36`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${name}: running jobs over 00:00–24:00 UTC, peak ${Math.max(...buckets)}`);
    for (let hour = 0; hour <= 24; hour += 6) {
        const line = document.createElementNS(ns, 'line');
        const x = hour / 24 * buckets.length;
        for (const [key, value] of Object.entries({ x1: x, x2: x, y1: 0, y2: 36 })) line.setAttribute(key, String(value));
        line.setAttribute('stroke', '#ddd');
        svg.appendChild(line);
    }
    buckets.forEach((count, index) => {
        // Transparent full-height hit targets also give useful tooltips for idle periods.
        const group = document.createElementNS(ns, 'g');
        const title = document.createElementNS(ns, 'title');
        const time = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
        title.textContent = `${time(index * 5)}–${time((index + 1) * 5)} UTC: peak ${count} running jobs`;
        group.appendChild(title);
        for (const [height, fill] of [[36, 'transparent'], [count / peak * 35, 'rgba(0,96,223,0.6)']] as const) {
            const rect = document.createElementNS(ns, 'rect');
            for (const [key, value] of Object.entries({ x: index, y: 36 - height, width: 1, height, fill })) rect.setAttribute(key, String(value));
            group.appendChild(rect);
        }
        svg.appendChild(group);
    });
    return svg;
}

function groupBugCount(group: PerformanceGroup): number | null {
    if (!performanceAlertsState.index) return null;
    const counts = countPerformanceAlerts(group.intervals, performanceAlertsState.index);
    return counts.mapped ? counts.total : null;
}

function performanceTable(groups: PerformanceGroup[], heading: string, total: number) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pool-table-wrapper';
    const table = document.createElement('table');
    table.className = 'pool-table';
    const head = table.createTHead().insertRow();
    for (const [label, key] of [[heading, 'name'], ['Runtime share', 'runtime'], ['Runs', 'runs'], ['Resolutions', 'alerts'], ['Peak running', 'peak'], ['Activity (UTC)', null]] as const) {
        const th = document.createElement('th');
        th.scope = 'col';
        if (label !== heading && label !== 'Activity (UTC)') th.className = 'num';
        if (label === 'Activity (UTC)') th.title = 'Peak running jobs in five-minute buckets; each row is scaled to its own peak.';
        if (key === 'alerts') th.title = 'Number of distinct bugs linked to regression alerts created for this test in the past 365 days.';

        if (key) {
            th.setAttribute('aria-sort', performanceSort.key === key ? (performanceSort.descending ? 'descending' : 'ascending') : 'none');
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'sort-button';
            button.dataset.sort = key;
            button.textContent = label + (performanceSort.key === key ? (performanceSort.descending ? ' ▾' : ' ▴') : '');
            button.addEventListener('click', () => {
                performanceSort = { key, descending: performanceSort.key === key ? !performanceSort.descending : key !== 'name' };
                renderPerformance();
                document.querySelector<HTMLElement>(`[data-sort="${key}"]`)?.focus({ preventScroll: true });
            });
            th.appendChild(button);
        } else th.textContent = label;
        head.appendChild(th);
    }
    const body = table.createTBody();
    const totalRuns = groups.reduce((sum, group) => sum + group.runs, 0);
    const dayStart = Date.parse(element<HTMLSelectElement>('date').value + 'T00:00:00Z');
    const entries: TableGroup[] = [{ name: 'All configurations', milliseconds: groups.reduce((sum, group) => sum + group.milliseconds, 0), runs: totalRuns, intervals: groups.flatMap(group => group.intervals) }];
    for (const group of sortPerformanceGroups(groups, dayStart, performanceSort, false, groupBugCount)) {
        entries.push({ ...group, key: group.name, name: performanceGroupName(group.name), parent: true });
        if (expandedPerformanceGroups.has(group.name)) {
            entries.push(...sortPerformanceGroups(performanceGroups(group.intervals, false), dayStart, performanceSort, true, groupBugCount).map(child => ({ ...child, child: true })));
        }
    }
    for (const [index, group] of entries.entries()) {
        const row = body.insertRow();
        if (index === 0) row.className = 'all-tasks-row';
        const name = row.insertCell();
        name.textContent = name.title = group.name;
        name.className = 'pool-name';
        if (group.child) row.classList.add('test-child');
        if (group.parent) {
            row.classList.add('test-group');
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'group-toggle';
            const expanded = expandedPerformanceGroups.has(group.key!);
            toggle.setAttribute('aria-expanded', String(expanded));
            toggle.textContent = `${expanded ? '▾' : '▸'} ${group.name}`;
            name.replaceChildren(toggle);
            const expand = () => {
                if (expandedPerformanceGroups.has(group.key!)) expandedPerformanceGroups.delete(group.key!);
                else expandedPerformanceGroups.add(group.key!);
                renderPerformance();
                const replacement = [...document.querySelectorAll<HTMLButtonElement>('.group-toggle')]
                    .find(button => button.parentElement?.title === group.name);
                replacement?.focus({ preventScroll: true });
            };
            toggle.addEventListener('click', expand);
            row.addEventListener('click', event => {
                if (event.target instanceof Element && !event.target.closest('button, a')) expand();
            });
        }

        const share = total > 0 ? 100 * group.milliseconds / total : 0;
        const hours = (group.milliseconds / 3600000).toLocaleString(undefined,
            { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const runtime = row.insertCell();
        runtime.className = 'runtime-cell';
        runtime.title = `${hours} worker-hours`;
        const runtimeChart = document.createElement('div');
        runtimeChart.className = 'runtime-chart';
        runtimeChart.setAttribute('aria-label', `${share.toFixed(1)}% of runtime, ${hours} worker-hours`);
        const track = document.createElement('span');
        track.className = 'runtime-track';
        track.setAttribute('aria-hidden', 'true');
        const bar = document.createElement('span');
        bar.className = 'runtime-bar';
        bar.style.width = `${share}%`;
        track.appendChild(bar);
        const percentage = document.createElement('span');
        percentage.className = 'runtime-percentage';
        percentage.textContent = `${share.toFixed(1)}%`;
        runtimeChart.append(track, percentage);
        runtime.appendChild(runtimeChart);
        const runs = row.insertCell();
        runs.className = 'num';
        runs.textContent = group.runs.toLocaleString();
        const totalCell = row.insertCell();
        totalCell.className = 'resolution-cell';
        performanceAlertCells.push({ runs: group.intervals, totalCell });
        const buckets = performanceActivity(group.intervals, dayStart);
        const peak = row.insertCell();
        peak.className = 'num';
        peak.textContent = String(Math.max(...buckets));
        const activity = row.insertCell();
        activity.className = 'activity-cell';
        const container = document.createElement('div');
        container.className = 'activity-container';
        const graph = document.createElement('div');
        graph.className = 'activity-graph';
        container.appendChild(graph);
        activity.appendChild(container);
        graph.appendChild(performanceActivityGraph(buckets, group.name));
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'profiler-btn';
        button.textContent = 'Profiler';
        button.title = `Open ${group.name} task timeline in Firefox Profiler`;
        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                await openTaskTimelineInProfiler(group.intervals.map(row => ({ ...row.profileTask, aggregate: group.name })),
                    `${element<HTMLSelectElement>('pool').value === 'all' ? 'All worker pools' : element<HTMLSelectElement>('pool').value}: ${group.name}`,
                    performanceProfilerSeries(group.intervals, dayStart), dayStart, dayStart + 86400000,
                    [], index > 0 ? performanceMarkerSearch(group.name) : '');
            } catch (error) {
                const errorElement = element<HTMLElement>('error');
                errorElement.textContent = `Unable to open Profiler: ${errorMessage(error)}`;
                errorElement.style.display = 'block';
            } finally {
                button.disabled = false;
            }
        });
        container.appendChild(button);
    }
    wrapper.appendChild(table);
    updatePerformanceAlertCells();
    return wrapper;
}

function clearPerformanceResults() {
    const results = element<HTMLElement>('results');
    clearPerformanceAlertCells();
    results.replaceChildren();
    return results;
}

function updatePerformancePools() {
    const select = element<HTMLSelectElement>('pool');
    const previous = select.value || new URLSearchParams(location.search).get('pool') || 'all';
    const project = element<HTMLSelectElement>('project').value;
    const names = [...new Set(performanceRows.filter(row => !project || row.project === project)
        .map(row => row.pool))].sort();
    select.replaceChildren(new Option('All', 'all'));
    names.forEach(name => select.add(new Option(name, name)));
    select.value = previous === 'all' || names.includes(previous) ? previous : 'all';
    select.disabled = !names.length;
    renderPerformance();
}

function renderPerformance() {
    const project = element<HTMLSelectElement>('project').value;
    const pool = element<HTMLSelectElement>('pool').value;
    const search = element<HTMLInputElement>('test-search').value.trim();
    const query = search.toLowerCase();
    const poolRows = performanceRows.filter(row => (pool === 'all' || row.pool === pool) && (!project || row.project === project));
    const rows = poolRows.filter(row => (!query || row.label.toLowerCase().includes(query)
            || performanceGroupName(performanceAggregate(row.label)).toLowerCase().includes(query)));
    const results = clearPerformanceResults();
    const url = new URL(location.href);
    url.searchParams.delete('platform');
    url.searchParams.delete('allPools');
    if (search) url.searchParams.set('search', search);
    else url.searchParams.delete('search');
    url.searchParams.delete('aggregate');
    if (project) url.searchParams.set('project', project);
    else url.searchParams.delete('project');
    if (url.searchParams.has('pool')) url.searchParams.set('pool', pool);
    history.replaceState(null, '', url);
    const total = rows.reduce((sum, row) => sum + row.milliseconds, 0);
    const groups = performanceGroups(rows, true);
    element<HTMLElement>('summary-date').textContent = element<HTMLSelectElement>('date').value;
    element<HTMLElement>('summary-configs').textContent = new Set(rows.map(row => row.label)).size.toLocaleString();
    element<HTMLElement>('summary-runs').textContent = rows.length.toLocaleString();
    element<HTMLElement>('summary-hours').textContent = (total / 3600000).toLocaleString(undefined, { maximumFractionDigits: 2 });
    element<HTMLElement>('status').textContent = rows.length ? '' : query ? 'No tests match your search.' : 'No performance-test runs for this date and project.';
    if (!rows.length) return;
    results.appendChild(performanceTable(groups, 'Job configuration', poolRows.reduce((sum, row) => sum + row.milliseconds, 0)));
}

async function loadPerformanceDate() {
    const version = ++loadVersion;
    const date = element<HTMLSelectElement>('date').value;
    const project = element<HTMLSelectElement>('project');
    project.disabled = true;
    element<HTMLInputElement>('test-search').disabled = true;
    element<HTMLSelectElement>('pool').disabled = true;
    clearPerformanceResults();
    document.querySelectorAll('.summary-stat .value').forEach(value => { value.textContent = '—'; });
    element<HTMLElement>('error').style.display = 'none';
    element<HTMLElement>('status').textContent = `Loading task data for ${date}…`;
    try {
        const response = await fetchFromCI('worker-data', `workers-${date}-tasks.json`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as WorkerData;
        if (version !== loadVersion) return;
        performanceRows = decodePerformanceTasks(data, date);
        const previous = project.value || new URLSearchParams(location.search).get('project') || '';
        project.replaceChildren(new Option('All projects', ''));
        [...new Set(performanceRows.map(row => row.project))].sort()
            .forEach(name => project.add(new Option(name, name)));
        project.value = [...project.options].some(option => option.value === previous) ? previous : '';
        project.disabled = false;
        element<HTMLInputElement>('test-search').disabled = false;
        updatePerformancePools();
    } catch (error) {
        if (version === loadVersion) showPerformanceError(error);
    }
}

function showPerformanceError(error: unknown) {
    element<HTMLElement>('status').textContent = '';
    const errorElement = element<HTMLElement>('error');
    errorElement.textContent = `Unable to load performance-test data: ${errorMessage(error)}. Reload to retry.`;
    errorElement.style.display = 'block';
}

export async function start() {
    void loadPerformanceAlerts(() => {
        if (!element<HTMLInputElement>('test-search').disabled) renderPerformance();
    });
    const search = element<HTMLInputElement>('test-search');
    search.value = new URLSearchParams(location.search).get('search') || '';
    search.addEventListener('input', renderPerformance);
    try {
        const response = await fetchFromCI('worker-data', 'index.json');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const index = await response.json() as {dates?: string[]};
        const dates = [...new Set(index.dates || [])].sort().reverse();
        if (!dates.length) throw new Error('No dates available');
        const select = element<HTMLSelectElement>('date');
        dates.forEach(date => select.add(new Option(date, date)));
        const requested = new URLSearchParams(location.search).get('date');
        select.value = requested !== null && dates.includes(requested) ? requested : dates[0]!;
        select.disabled = false;
        select.addEventListener('change', () => {
            const url = new URL(location.href);
            url.searchParams.set('date', select.value);
            history.replaceState(null, '', url);
            loadPerformanceDate();
        });
        element<HTMLSelectElement>('project').addEventListener('change', () => {
            const url = new URL(location.href);
            const project = element<HTMLSelectElement>('project').value;
            if (project) url.searchParams.set('project', project);
            else url.searchParams.delete('project');
            history.replaceState(null, '', url);
            updatePerformancePools();
        });
        element<HTMLSelectElement>('pool').addEventListener('change', () => {
            const url = new URL(location.href);
            url.searchParams.set('pool', element<HTMLSelectElement>('pool').value);
            history.replaceState(null, '', url);
            renderPerformance();
        });
        await loadPerformanceDate();
    } catch (error) { showPerformanceError(error); }
}


