import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../shared.js', import.meta.url), 'utf8'), context);
vm.runInContext(readFileSync(new URL('../task-timeline-profiler.js', import.meta.url), 'utf8'), context);
const bundle = await build({
    stdin: { contents: "export * from './site/performance-view.ts';", resolveDir: process.cwd() },
    bundle: true, write: false, format: 'iife', globalName: 'performanceModel', platform: 'browser',
});
vm.runInContext(bundle.outputFiles[0]!.text, context);
Object.assign(context, context.performanceModel);

test('performance suite recognition excludes builds and ordinary functional tests', () => {
    for (const [label, expected] of [
        ['test-linux2404-64/opt-browsertime-benchmark-firefox-speedometer3', 'Browsertime'],
        ['test-windows11-64/opt-talos-tp5', 'Talos'],
        ['test-macosx1500/opt-raptor-speedometer', 'Raptor'],
        ['test-linux64/opt-awsy-base', 'AWSY'],
        ['perftest-android-hw-a55-startup-fenix', 'mozperftest'],
        ['test-linux64/opt-mochitest-browser-speedometer3', 'Mochitest Speedometer'],
        ['build-linux64/opt-browsertime', null],
        ['test-linux64/opt-mochitest-browser-chrome', null],
    ] as const) assert.equal(context.performanceSuite(label), expected, label);
});

test('daily accounting clips boundaries, excludes unstarted runs and counts distinct retries', () => {
    const day = Date.parse('2026-09-30T00:00:00Z');
    const data = {
        metadata: { taskCount: 6 },
        tables: { labels: ['perftest-linux64-startup'], projects: ['autoland'], taskQueueIds: ['releng-hardware/gecko-t-linux-talos'] },
        taskGroupInfo: { projectIds: [0] },
        tasks: {
            scheduled: [day - 3600000, 0, 0, 0, 0, 0],
            started: [0, 86400000, null, 3600000, 3600000, 0],
            resolved: [7200000, 93600000, 7200000, 7200000, 7200000, 1800000],
            taskIds: ['a.0', 'b.0', 'c.0', 'a.1', 'a.1', 'd.0'],
            taskQueueIdIds: [0, 0, 0, 0, 0, 0],
            labelIds: [0, 0, 0, 0, 0, 0], taskGroupIdIds: [0, 0, 0, 0, 0, 0],
        },
    };
    const rows = context.decodePerformanceTasks(data, '2026-09-30');
    assert.equal(rows.length, 3);
    assert.equal(rows.reduce((sum: number, row: any) => sum + row.milliseconds, 0), 10800000);
    assert.equal(rows[0].pool, 'releng-hardware/gecko-t-linux-talos');
    assert.equal(rows[0].project, 'autoland');
    assert.equal(context.summarizePerformance(rows, 'pool')[0].runs, 3);
});


test('actual worker pools separate identical labels and combine different task platforms', () => {
    const day = Date.parse('2026-09-30T00:00:00Z');
    const labels = ['test-macosx1500-aarch64-shippable/opt-talos-tp5',
        'test-macosx1500-aarch64-nightlyasrelease/opt-talos-tp5'];
    const data = {
        metadata: { taskCount: 4 },
        tables: { labels, projects: ['autoland'], taskQueueIds: ['hardware/pool-a', 'hardware/pool-b'] },
        taskGroupInfo: { projectIds: [0] },
        tasks: { scheduled: [day, 0, 0, 0], started: [0, 0, 0, 0],
            resolved: [1000, 3000, 2000, 5000], taskIds: ['a.0', 'b.0', 'c.0', 'd.0'],
            labelIds: [0, 0, 1, 1], taskGroupIdIds: [0, 0, 0, 0], taskQueueIdIds: [0, 1, 0, 0] },
    };
    const rows = context.decodePerformanceTasks(data, '2026-09-30');
    const selected = rows.filter((row: any) => row.pool === 'hardware/pool-a');
    assert.equal(selected.length, 3);
    const ranked = context.summarizePerformance(selected, 'label');
    assert.equal(ranked[0].name, labels[1]);
    assert.equal(ranked[0].milliseconds, 7000);
    assert.equal(ranked[0].runs, 2);
    assert.equal(ranked[1].milliseconds, 1000);
});

test('activity preserves short spikes, clips midnight and avoids false spikes at shared endpoints', () => {
    const start = Date.parse('2026-09-30T00:00:00Z');
    const buckets = context.performanceActivity([
        { start: start - 1000, end: start + 1000 },
        { start: start + 1000, end: start + 300000 },
        { start: start + 10000, end: start + 11000 },
        { start: start + 86400000 - 1000, end: start + 86400000 + 1000 },
    ], start);
    assert.equal(buckets[0], 2);
    assert.equal(buckets[1], 0);
    assert.equal(buckets[287], 1);
    const adjacent = context.performanceActivity([
        { start, end: start + 300000 },
        { start: start + 300000, end: start + 600000 },
    ], start);
    assert.equal(Math.max(...adjacent), 1);
    assert.equal(adjacent[2], 0);
});

test('profiler export retains task identity and clips weighted runtime to the selected day', () => {
    const start = Date.parse('2026-09-30T00:00:00Z');
    const task = {
        label: 'test-macosx1500-aarch64-shippable/opt-talos-tp5',
        task_queue_id: 'hardware/macos', project: 'autoland', priority: 'low',
        task_id: 'task-id', run_id: '2', state: 'failed', reason_resolved: 'failed',
        worker_id: 'worker-1', _scheduledMs: start - 2000,
        _startedMs: start - 1000, _resolvedMs: start + 3000,
    };
    const series = context.performanceProfilerSeries([{ start, end: start + 3000 }], start);
    const profile = context.generateProfile([task], task.label, series, start, start + 86400000);
    assert.equal(profile.meta.startTime, start);
    assert.equal(profile.meta.profilingEndTime, 86400000);
    assert.equal(profile.threads[0].samples.weight.reduce((a: number, b: number) => a + b, 0), 3000);
    const markers = profile.threads[0].markers.data.filter((marker: any) => marker.type === 'Task');
    assert.equal(markers.length, 1);
    assert.equal(profile.shared.stringArray[markers[0].id], 'task-id');
    assert.equal(markers[0].run, 2);
    assert.equal(profile.shared.stringArray[markers[0].wid], 'worker-1');
});

test('aggregation merges pdfpaint chunks and variants while preserving runs and other tests', () => {
    const rows = [
        { label: 'test-macosx1470-64-shippable/opt-talos-pdfpaint-1', milliseconds: 10, start: 0, end: 10 },
        { label: 'test-macosx1470-64-shippable/opt-talos-pdfpaint-5-swr', milliseconds: 20, start: 0, end: 20 },
        { label: 'test-macosx1470-64-shippable/debug-talos-pdfpaint-1', milliseconds: 5, start: 0, end: 5 },
        { label: 'test-macosx1470-64-shippable/opt-talos-svgr', milliseconds: 40, start: 0, end: 40 },
    ];
    const grouped = context.performanceGroups(rows, true);
    assert.equal(grouped.length, 3);
    assert.equal(grouped[0].name, '*opt-talos-svgr*');
    assert.equal(grouped[1].name, '*opt-talos-pdfpaint*');
    assert.equal(grouped[1].milliseconds, 30);
    assert.equal(grouped[1].runs, 2);
    assert.equal(grouped[1].intervals[1], rows[1]);
    assert.equal(context.performanceGroups(rows, false).length, 4);
});

test('all requested aggregates combine variants and supply a matching profiler filter', () => {
    const patterns = ['opt-talos-pdfpaint', 'opt-browsertime-tp6', 'opt-talos-g1',
        'opt-talos-damp', 'opt-browsertime-responsiveness', 'opt-talos-tp5o',
        'browsertime-benchmark-firefox-speedometer3'];
    const rows = patterns.flatMap(pattern => ['', '-variant'].map(suffix => ({
        label: `test-linux2404-64-shippable/${pattern}${suffix}`,
        milliseconds: 10, start: 0, end: 10,
    })));
    const groups = context.performanceGroups(rows, true);
    assert.equal(groups.length, patterns.length);
    for (const pattern of patterns) {
        const group = groups.find((entry: any) => entry.name === `*${pattern}*`);
        assert.equal(group.runs, 2);
        assert.equal(group.milliseconds, 20);
        assert.equal(context.performanceMarkerSearch(group.name), pattern);
    }
    assert.equal(context.performanceGroups(rows, false).length, rows.length);
});

test('extended aggregates keep browsers, benchmarks and feature families distinct', () => {
    const cases = [
        ['test-linux/opt-browsertime-webcodecs-firefox-ve-av1-rt', 'opt-browsertime-webcodecs [firefox]'],
        ['test-linux/opt-browsertime-webcodecs-chrome-ve-av1-rt', 'opt-browsertime-webcodecs [chrome]'],
        ['test-linux/opt-browsertime-benchmark-firefox-motionmark-htmlsuite-1-3', 'opt-browsertime-benchmark-motionmark [firefox]'],
        ['test-linux/opt-browsertime-benchmark-firefox-speedometer-experimental-native-profiling', 'opt-browsertime-benchmark-speedometer-experimental [firefox]'],
        ['test-android/opt-browsertime-benchmark-speedometer3-mobile-chrome-m-nofis', 'opt-browsertime-benchmark-speedometer3-mobile [chrome-m]'],
        ['test-linux/opt-browsertime-firefox-youtube-playback-widevine-vp9-sfr', 'opt-browsertime-youtube-playback [firefox]'],
        ['test-linux/opt-talos-perf-reftest-singletons', '*opt-talos-perf-reftest*'],
        ['test-linux/opt-awsy-base-dmd', '*opt-awsy*'],
        ['perftest-android-hw-a55-startup-chrome-m-tab-restore-startup', 'mozperftest Android startup [chrome-m]'],
        ['perftest-android-hw-a55-foreground-resource-fenix', 'mozperftest Android resources [fenix]'],
        ['perftest-linux-ml-perf-smart-tab-cluster-native-linux2404-64-shippable/opt', 'mozperftest ml-perf-smart-tab'],
        ['perftest-windows11-24h2-ml-perf-suggest-ft-wasm', 'mozperftest ml-perf-suggest'],
        ['test-linux/opt-browsertime-custom-firefox-process-switch-nofis', 'opt-browsertime-custom-process-switch [firefox]'],
    ];
    for (const [label, expected] of cases) assert.equal(context.performanceAggregate(label), expected);
    const unknown = 'test-linux/opt-browsertime-new-suite-firefox-new-test';
    assert.equal(context.performanceAggregate(unknown), unknown);
    assert.equal(context.performanceAggregate('test-linux/opt-talos-g50'), 'test-linux/opt-talos-g50');
});

test('column sorting orders numeric values and names while leaving unknown bug counts last', () => {
    const groups = [
        {name: '*opt-talos-z*', milliseconds: 20, runs: 2, intervals: []},
        {name: '*opt-talos-a*', milliseconds: 100, runs: 1, intervals: []},
    ];
    const names = (key: string, descending: boolean) => Array.from(context.sortPerformanceGroups(
        groups, 0, {key, descending}, false, (group: {name: string}) => group.name.includes('-z') ? 2 : null),
        (group: unknown) => (group as {name: string}).name);
    assert.deepEqual(names('runtime', true), ['*opt-talos-a*', '*opt-talos-z*']);
    assert.deepEqual(names('runtime', false), ['*opt-talos-z*', '*opt-talos-a*']);
    assert.deepEqual(names('runs', true), ['*opt-talos-z*', '*opt-talos-a*']);
    assert.deepEqual(names('name', false), ['*opt-talos-a*', '*opt-talos-z*']);
    assert.deepEqual(names('alerts', true), ['*opt-talos-z*', '*opt-talos-a*']);
    assert.deepEqual(names('alerts', false), ['*opt-talos-z*', '*opt-talos-a*']);
});
