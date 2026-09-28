/**
 * One task's profile, shared by `test/task-view.test.ts` and
 * `test/task-page.test.ts`: a rerun rescue, a test that failed twice with a
 * stacked leak and an uploaded profile, a crash with a dump, a skip, and a crash
 * against a manifest — one of each thing `task.html` renders differently.
 */

/** The profile described above. */
export function sampleProfile(): unknown {
    const stringArray = [
        'test',
        'Text',
        'FAIL',
        'Crash',
        'observe — JS Function - observe @  0x1f',
        'run',
        'chrome://mochitests/content/browser/a/browser_twice.js',
    ];
    const markers: {
        name: number;
        data: Record<string, unknown>;
        start: number;
        end: number;
        stack?: number;
    }[] = [
        { name: 1, data: { type: 'Text', text: 'retry' }, start: 900, end: 1000 },
        {
            name: 1,
            data: { type: 'Artifact', filename: 'profile_resource-usage.json', size: 20912399 },
            start: 1000,
            end: 1000,
        },
        { name: 0, data: { type: 'Test', test: 'a/browser_slow.js', status: 'PASS' }, start: 0, end: 400 },
        { name: 0, data: { type: 'Test', test: 'a/browser_fail.js', status: 'FAIL' }, start: 400, end: 450 },
        {
            name: 2,
            data: { type: 'TestStatus', test: 'a/browser_fail.js', message: 'expected 1 got 2' },
            start: 420,
            end: 420,
        },
        { name: 0, data: { type: 'Test', test: 'a/browser_crash.js', status: 'CRASH' }, start: 450, end: 500 },
        {
            name: 3,
            data: {
                type: 'Crash',
                test: 'a/browser_crash.js',
                signature: 'mozilla::Foo',
                minidump: '11111111-2222-3333-4444-555555555555',
            },
            start: 480,
            end: 480,
        },
        { name: 0, data: { type: 'Test', test: 'a/browser_skip.js', status: 'SKIP' }, start: 500, end: 500 },
        { name: 0, data: { type: 'Test', test: 'a/browser_twice.js', status: 'FAIL' }, start: 600, end: 650 },
        {
            name: 2,
            data: { type: 'TestStatus', test: 'a/browser_twice.js', message: 'leaked 1 window(s)' },
            start: 620,
            end: 620,
            stack: 1,
        },
        {
            name: 2,
            data: {
                type: 'TestStatus',
                test: 'a/browser_twice.js',
                message: 'Found unexpected failures; profile uploaded in profile_browser_twice.js.json.gz',
            },
            start: 630,
            end: 630,
        },
        { name: 0, data: { type: 'Test', test: 'a/browser_twice.js', status: 'FAIL' }, start: 940, end: 960 },
        {
            name: 2,
            data: { type: 'TestStatus', test: 'a/browser_twice.js', message: 'leaked 1 window(s)' },
            start: 950,
            end: 950,
        },
        { name: 0, data: { type: 'Test', test: 'a/browser_fail.js', status: 'PASS' }, start: 910, end: 930 },
        {
            name: 3,
            data: {
                type: 'Crash',
                test: 'a/browser.toml',
                signature: 'shutdownhang',
                minidump: '66666666-7777-8888-9999-000000000000',
            },
            start: 990,
            end: 990,
        },
    ];
    return {
        meta: { startTime: 0 },
        threads: [
            {
                stringArray,
                markers: {
                    length: markers.length,
                    name: markers.map((m) => m.name),
                    data: markers.map((m) => m.data),
                    startTime: markers.map((m) => m.start),
                    endTime: markers.map((m) => m.end),
                    stack: markers.map((m) => m.stack ?? null),
                },
                // Stack 1 is `run @ …browser_twice.js:12`, called from stack 0.
                stackTable: { frame: [0, 1], prefix: [null, 0] },
                frameTable: { func: [0, 1], line: [null, 12] },
                funcTable: { name: [4, 5], fileName: [null, 6] },
            },
        ],
    };
}
