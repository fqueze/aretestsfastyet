// Pure runtime decoding and grouping, shared by the controller and its tests.
export interface ProfileTask {
    label: string; task_queue_id: string; task_id: string; run_id: string;
    _scheduledMs: number; _startedMs: number; _resolvedMs: number;
    state: string; reason_resolved: string; priority: string; worker_id: string;
    worker_group: string; task_group_id: string; project: string;
}
export interface PerformanceRun {
    label: string; suite: string; pool: string; project: string;
    start: number; end: number; milliseconds: number; profileTask: ProfileTask;
}
export interface PerformanceGroup {
    name: string; milliseconds: number; runs: number; intervals: PerformanceRun[];
}
export interface WorkerData {
    metadata: { taskCount: number };
    tasks: {
        scheduled: number[]; started: (number | null)[]; resolved: (number | null)[];
        taskIds: string[]; labelIds: number[]; taskQueueIdIds: number[];
        taskGroupIdIds: (number | null)[]; resolutionIds?: number[];
        priorityIds?: number[]; workerIdIds?: number[];
    };
    tables: {
        labels: string[]; taskQueueIds: string[]; projects: string[];
        resolutions?: string[]; priorities?: string[]; workerIds?: string[];
        workerGroups?: string[]; taskGroupIds?: string[];
    };
    taskGroupInfo: { projectIds: number[] };
    workerInfo?: { workerGroupIds: number[] };
}
// The performance dashboard’s profiler script supplies its label parser.
declare function splitPerfSuite(label: string): { suite: string; test: string; app: string } | null;
declare const VARIANT_SUFFIXES: string[];
const lookup = (values: string[] | undefined, index: number | null | undefined): string =>
    index == null ? '' : values?.[index] || '';

export function performanceSuite(label: string) {
    if (!/^(?:test-|perftest-|mozperftest-)/.test(label)) return null;
    if (/(?:^|-)browsertime-/.test(label)) return 'Browsertime';
    if (/(?:^|-)raptor-/.test(label)) return 'Raptor';
    if (/(?:^|-)talos-/.test(label)) return 'Talos';
    if (/(?:^|-)awsy(?:-|$)/.test(label)) return 'AWSY';
    if (/(?:^|-)(?:moz)?perftest(?:-|$)/.test(label)) return 'mozperftest';
    if (/-mochitest-browser-speedometer\d*(?:-|$)/.test(label)) return 'Mochitest Speedometer';
    return null;
}

export function decodePerformanceTasks(data: WorkerData, date: string): PerformanceRun[] {
    const { tasks, tables, taskGroupInfo, workerInfo, metadata } = data;
    const dayStart = Date.parse(date + 'T00:00:00Z');
    const dayEnd = dayStart + 86400000;
    const rows: PerformanceRun[] = [];
    let scheduled = 0;
    const seen = new Set();
    for (let i = 0; i < metadata.taskCount; i++) {
        scheduled += tasks.scheduled[i] ?? 0;
        const label = lookup(tables.labels, tasks.labelIds[i]);
        const suite = performanceSuite(label);
        if (!suite || tasks.started[i] == null || tasks.resolved[i] == null) continue;
        const start = scheduled + tasks.started[i]!;
        const end = scheduled + tasks.resolved[i]!;
        const milliseconds = Math.min(end, dayEnd) - Math.max(start, dayStart);
        if (!Number.isFinite(milliseconds) || milliseconds <= 0) continue;
        const run = tasks.taskIds[i]!;
        if (seen.has(run)) continue;
        seen.add(run);
        const group = tasks.taskGroupIdIds[i];
        const projectId = group == null ? null : taskGroupInfo.projectIds[group];
        // taskQueueIds are the actual provisioner/worker-type pools, as in workers.html.
        const pool = lookup(tables.taskQueueIds, tasks.taskQueueIdIds[i]) || 'unknown';
        const resolution = lookup(tables.resolutions, tasks.resolutionIds?.[i]);
        const [state = '', reason = state] = resolution.split(' - ');
        const runMatch = run.match(/^(.*)\.(\d+)$/);
        const worker = tasks.workerIdIds?.[i];
        const profileTask = {
            label, task_queue_id: pool, task_id: runMatch ? runMatch[1]! : run,
            run_id: runMatch ? runMatch[2]! : '0',
            _scheduledMs: scheduled, _startedMs: start, _resolvedMs: end,
            state, reason_resolved: reason,
            priority: lookup(tables.priorities, tasks.priorityIds?.[i]),
            worker_id: worker == null ? '' : tables.workerIds?.[worker] || '',
            worker_group: worker == null ? '' : lookup(tables.workerGroups, workerInfo?.workerGroupIds[worker]),
            task_group_id: group == null ? '' : tables.taskGroupIds?.[group] || '',
            project: projectId == null ? 'unknown' : tables.projects[projectId] || 'unknown',
        };
        rows.push({ label, suite, pool, milliseconds, profileTask,
            start: Math.max(start, dayStart), end: Math.min(end, dayEnd),
            project: projectId == null ? 'unknown' : tables.projects[projectId] || 'unknown' });
    }
    return rows;
}

export function summarizePerformance(rows: PerformanceRun[], key: ((row: PerformanceRun) => string) | 'label' | 'pool' | 'project') {
    const groups = new Map<string, PerformanceGroup>();
    for (const row of rows) {
        const name = typeof key === 'function' ? key(row) : row[key];
        const entry = groups.get(name) || { name, milliseconds: 0, runs: 0, intervals: [] };
        entry.milliseconds += row.milliseconds;
        entry.runs++;
        entry.intervals.push(row);
        groups.set(name, entry);
    }
    return [...groups.values()].sort((a, b) => b.milliseconds - a.milliseconds);
}

const PERFORMANCE_AGGREGATES = [
    'opt-talos-pdfpaint',
    'opt-browsertime-tp6',
    'opt-talos-g1',
    'opt-talos-damp',
    'opt-browsertime-responsiveness',
    'opt-talos-tp5o',
    'browsertime-benchmark-firefox-speedometer3',
];

const TALOS_AGGREGATES = [
    'svgr', 'g3', 'g4', 'g5', 'bcv', 'chrome', 'other', 'dromaeojs',
    'perf-reftest', 'webgl', 'sessionrestore-many-windows', 'realworld-webextensions', 'xperf',
];
const BROWSERTIME_AGGREGATES = new Set([
    'webcodecs', 'indexeddb', 'network-bench', 'video-playback-latency',
    'video-playback-latency-mobile', 'youtube-playback', 'youtube-playback-mobile',
    'media-playback', 'power', 'speculation-rules', 'speculative', 'hev3-connection',
    'hev3-connection-m', 'trr-performance', 'trr-performance-m', 'upload',
    'nav-bench', 'first-install', 'media-seek',
].map(name => 'browsertime-' + name));
const BENCHMARK_AGGREGATES = [
    'speedometer-experimental', 'speedometer3', 'speedometer2', 'jetstream3',
    'motionmark', 'matrix-react-bench', 'stylebench', 'unity-webgl', 'webaudio',
    'media-capabilities', 'twitch-animation', 'assorted-dom',
];
const PERFTEST_AGGREGATES = [
    'ml-llama-summarizer-perf', 'ml-llama-smollm2-smoke', 'ml-perf-semantic',
    'ml-perf-suggest', 'ml-perf-autofill', 'ml-perf-smart-tab', 'ml-multi-perf',
    'ml-perf', 'tr8ns-perf', 'perftest-accessibility', 'perftest-places',
    'service-worker', 'speech-recognition-perf', 'linkpreview-perf',
    'semantichistory-perf', 'formautofill-ml-perf', 'mlsuggest-perf',
    'smarttabgrouping-perf', 'smartwindow-perf', 'busy-trr', 'browsertime-sample',
];
const hasPrefix = (value: string, prefix: string) => value === prefix || value.startsWith(prefix + '-');

export function performanceAggregate(label: string) {
    // Keep the original explicitly requested substring rules unchanged.
    const existing = PERFORMANCE_AGGREGATES.find(pattern => label.includes(pattern));
    if (existing) return `*${existing}*`;
    const test = label.match(/^test-[^/]+\/(opt|debug)-(.+)$/);
    if (test) {
        const build = test[1]!;
        const job = test[2]!;
        if (build === 'opt') {
            const talos = TALOS_AGGREGATES.find(name => hasPrefix(job, 'talos-' + name));
            if (talos) return `*opt-talos-${talos}*`;
            if (hasPrefix(job, 'awsy')) return '*opt-awsy*';
        }
        const perf = splitPerfSuite(job);
        if (perf) {
            let family = perf.suite;
            if (family === 'browsertime-benchmark') {
                const benchmark = BENCHMARK_AGGREGATES.find(name => hasPrefix(perf.test, name));
                if (!benchmark) return label;
                family += '-' + benchmark;
            } else if (family === 'browsertime-custom' || family === 'browsertime-regression-tests') {
                // Keep distinct custom/regression workloads, removing only known variants.
                let name = perf.test;
                let previous;
                do {
                    previous = name;
                    for (const variant of ['native-profiling', ...VARIANT_SUFFIXES]) {
                        if (name.endsWith('-' + variant)) name = name.slice(0, -variant.length - 1);
                    }
                } while (name !== previous);
                family += '-' + name;
            } else if (!BROWSERTIME_AGGREGATES.has(family) && !family.startsWith('browsertime-benchmark-')) {
                return label;
            }
            return `${build}-${family} [${perf.app}]`;
        }
    }
    if (/^(?:moz)?perftest-/.test(label)) {
        if (label.startsWith('perftest-android-emulator-')) return 'mozperftest Android emulator startup';
        const startup = label.match(/-startup-(fenix|geckoview|chrome-m|refbrow)-/);
        if (startup) return `mozperftest Android startup [${startup[1]}]`;
        const resource = label.match(/-(?:background|foreground)-resource-(.+)$/);
        if (resource) return `mozperftest Android resources [${resource[1]}]`;
        const family = PERFTEST_AGGREGATES.find(name => label.includes('-' + name + '-') || label.endsWith('-' + name));
        if (family) return 'mozperftest ' + family;
    }
    return label;
}

export function performanceGroups(rows: PerformanceRun[], aggregate: boolean) {
    return summarizePerformance(rows, row => aggregate ? performanceAggregate(row.label) : row.label);
}

export function performanceMarkerSearch(name: string) {
    return name.startsWith('*') && name.endsWith('*') ? name.slice(1, -1) : name;
}

// Maximum simultaneous running jobs in each five-minute bucket. Aggregate
// simultaneous starts/ends before sampling so adjacent runs do not form a spike.
export function performanceActivity(intervals: {start: number; end: number}[], dayStart: number, bucketCount = 288) {
    const events = new Map<number, number>();
    const dayEnd = dayStart + 86400000;
    for (const interval of intervals) {
        const start = Math.max(dayStart, interval.start);
        const end = Math.min(dayEnd, interval.end);
        if (!(end > start)) continue;
        events.set(start, (events.get(start) || 0) + 1);
        events.set(end, (events.get(end) || 0) - 1);
    }
    const ordered = [...events].sort((a, b) => a[0] - b[0]);
    const buckets: number[] = new Array<number>(bucketCount).fill(0);
    const width = 86400000 / bucketCount;
    let running = 0;
    for (let i = 0; i < ordered.length - 1; i++) {
        running += ordered[i]![1];
        const first = Math.floor((ordered[i]![0] - dayStart) / width);
        const last = Math.ceil((ordered[i + 1]![0] - dayStart) / width) - 1;
        for (let bucket = first; bucket <= last && bucket < bucketCount; bucket++) {
            buckets[bucket] = Math.max(buckets[bucket]!, running);
        }
    }
    return buckets;
}

export function performanceProfilerSeries(rows: {start: number; end: number}[], dayStart: number) {
    const changes = new Map([[dayStart, 0], [dayStart + 86400000, 0]]);
    for (const row of rows) {
        changes.set(row.start, (changes.get(row.start) || 0) + 1);
        changes.set(row.end, (changes.get(row.end) || 0) - 1);
    }
    let running = 0;
    return [...changes].sort((a, b) => a[0] - b[0]).map(([time, delta]) => {
        running += delta;
        return { time, total: running, running, expired: 0 };
    });
}

export function performanceGroupName(name: string) {
    return name.replace(/\*/g, '').replace(/^test-[^/]+\//, '').replace(/^opt-/, '');
}


export function sortPerformanceGroups(groups: PerformanceGroup[], dayStart: number, performanceSort: {key: string; descending: boolean}, children = false, bugCount: (group: PerformanceGroup) => number | null = () => null) {
    const key = performanceSort.key;
    const value = (group: PerformanceGroup): string | number | null => {
        if (key === 'name') return children ? group.name : performanceGroupName(group.name);
        if (key === 'runtime') return group.milliseconds;
        if (key === 'runs') return group.runs;
        if (key === 'peak') return Math.max(...performanceActivity(group.intervals, dayStart));
        return bugCount(group);
    };
    return groups.map(group => ({ group, value: value(group) })).sort((a, b) => {
        if (a.value === null || b.value === null) {
            if (a.value !== b.value) return a.value === null ? 1 : -1;
        } else {
            const comparison = typeof a.value === 'string' ? a.value.localeCompare(String(b.value)) : a.value - Number(b.value);
            if (comparison) return performanceSort.descending ? -comparison : comparison;
        }
        return a.group.name.localeCompare(b.group.name);
    }).map(entry => entry.group);
}

