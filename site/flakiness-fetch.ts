/**
 * The 21-day CI history of failing tests: `try.html`'s flakiness column,
 * shared with `task.html` so both show the same rate for the same failure.
 *
 * Moved out of `site/try.ts`. The caller supplies the requests, the order the
 * answers are wanted in, and what to do with each; the bucket files, the
 * worker, the harness retry and the cell's rendering are here.
 */

import { bucketFileSuffix, bucketIndexForPath } from '../lib/formats/buckets.ts';
import { detectHarness, otherHarness } from '../lib/model/harness.ts';
import type { FlakinessData } from '../lib/query/flakiness-rate.ts';
import { el } from './drilldown-render.ts';
import { testPageUrl } from './test-link.ts';
import type { FlakinessResult, WorkerResponse } from './try-flakiness-worker.ts';
import { type FlakinessRequest, flakinessCell, groupRequestsByChunk } from './try-view.ts';

declare global {
    /** `fetch-utils.js` — fetches a data file, honouring `?data-source=`. */
    function fetchData(filename: string, date?: string): Promise<Response>;
    // eslint-disable-next-line no-var
    var __workers: Record<string, string> | undefined;
}

/**
 * Creates the flakiness worker from the bundled source. `old/try.html:2581`.
 *
 * The source comes from `globalThis.__workers`, which `tools/build-pages.ts`
 * writes as a string constant ahead of the page's code, for a page whose HTML
 * carries `<!-- worker: ./try-flakiness-worker.ts -->`. See
 * `site/try-flakiness-worker.ts` for why the old page's `.toString()` approach
 * cannot survive bundling.
 *
 * A missing entry throws rather than falling back to a module worker. Two
 * reasons, and the second is the one that decided it:
 *
 *  - There is nothing to fall back *for*. A page's `<script type="module"
 *    src="./x.ts">` cannot load unbuilt, so a page reaching this line has necessarily been through the
 *    build and the entry is either there or the build is broken.
 *  - `new URL('./x.ts', import.meta.url)` puts an `import.meta` in the bundle,
 *    and `tools/build-pages.ts`'s parse guard — `new Function`, which is not a
 *    module scope — rejects it. That guard exists because the symptom of a
 *    mangled inline bundle is a blank dashboard, so working around it to keep a
 *    dev convenience would be trading a real check for an unreachable path.
 */
function initFlakinessWorker(): Worker {
    const source = globalThis.__workers?.['try-flakiness-worker.ts'];
    if (source === undefined) {
        throw new Error(
            'try-flakiness-worker.ts was not inlined by the build. The page cannot ' +
                'fetch 21-day history without it; check the <!-- worker: --> directive ' +
                'in the page’s HTML.'
        );
    }
    return new Worker(URL.createObjectURL(new Blob([source], { type: 'application/javascript' })));
}

/** One round trip to the flakiness worker. `old/try.html:2619`. */
function processInWorker(
    worker: Worker,
    buffer: ArrayBuffer,
    tests: readonly FlakinessRequest[]
): Promise<WorkerResponse> {
    return new Promise((resolve) => {
        const handler = (event: MessageEvent<WorkerResponse>): void => {
            worker.removeEventListener('message', handler);
            resolve(event.data);
        };
        worker.addEventListener('message', handler);
        worker.postMessage({ buffer, tests }, [buffer]);
    });
}

/**
 * How many bucket files are downloaded at once, and so how many can be in
 * memory at once. Each is ~6 MB compressed — `mochitest-0a.json` measured
 * 6,262,249 bytes stored on 2026-09-28 — and several times that decoded.
 */
const MAX_DOWNLOADS = 4;

/** How many workers parse them. Parsing is the CPU-bound half. */
const MAX_WORKERS = 3;

/**
 * Reads 21-day history for each request. `old/try.html:2632`.
 *
 * The files download in parallel, up to `MAX_DOWNLOADS` — started in table
 * order, so the top rows fill in first — and each is parsed by the first free
 * worker of up to `MAX_WORKERS`. A download slot is held until its file is
 * parsed, which bounds the buffers in memory by `MAX_DOWNLOADS`. The old page
 * fetched one file at a time, overlapping only the next download with the
 * current parse.
 *
 * Tests not found under their detected harness are retried under the other one,
 * because `detectHarness` cannot tell a mochitest-plain `test_foo.js` from an
 * xpcshell one (`lib/model/harness.ts` documents the hole). `onResult` gets
 * `null` for anything still not found.
 */
export async function fetchFlakiness(
    requests: readonly FlakinessRequest[],
    order: readonly string[],
    onResult: (path: string, data: FlakinessData | null) => void
): Promise<void> {
    const testOrder = new Map(order.map((path, index) => [path, index]));
    const workers: Worker[] = [];
    const idle: Worker[] = [];
    const waiting: ((worker: Worker) => void)[] = [];
    const acquire = (): Promise<Worker> => {
        const free = idle.pop();
        if (free !== undefined) {
            return Promise.resolve(free);
        }
        if (workers.length < MAX_WORKERS) {
            const worker = initFlakinessWorker();
            workers.push(worker);
            return Promise.resolve(worker);
        }
        return new Promise((resolve) => waiting.push(resolve));
    };
    const release = (worker: Worker): void => {
        const next = waiting.shift();
        if (next !== undefined) {
            next(worker);
        } else {
            idle.push(worker);
        }
    };

    /** One pass over the files for one harness guess; returns what it did not find. */
    const pass = async (
        entries: readonly FlakinessRequest[],
        harnessOf: (path: string) => string
    ): Promise<FlakinessRequest[]> => {
        const notFound: FlakinessRequest[] = [];
        const queue = groupRequestsByChunk(
            entries,
            testOrder,
            (path) => `${harnessOf(path)}-${bucketFileSuffix(bucketIndexForPath(path))}`
        );
        const readOne = async ([file, tests]: [string, FlakinessRequest[]]): Promise<void> => {
            const buffer = await fetchData(`${file}.json`)
                .then((response) => (response.ok ? response.arrayBuffer() : null))
                .catch(() => null);
            if (buffer === null) {
                notFound.push(...tests);
                return;
            }
            const worker = await acquire();
            try {
                const result = await processInWorker(worker, buffer, tests);
                if (result.error !== undefined) {
                    notFound.push(...tests);
                    return;
                }
                for (const answer of result.results ?? []) {
                    if (answer.found) {
                        onResult(answer.path, dataOf(answer));
                    } else {
                        notFound.push(...tests.filter((test) => test.path === answer.path));
                    }
                }
            } catch {
                notFound.push(...tests);
            } finally {
                release(worker);
            }
        };
        const lane = async (): Promise<void> => {
            for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
                await readOne(next);
            }
        };
        await Promise.all(Array.from({ length: MAX_DOWNLOADS }, lane));
        return notFound;
    };

    try {
        const notFound = await pass(requests, (path) => detectHarness(path));
        if (notFound.length > 0) {
            const stillNotFound = await pass(notFound, (path) => otherHarness(detectHarness(path)));
            for (const entry of stillNotFound) {
                onResult(entry.path, null);
            }
        }
    } finally {
        for (const worker of workers) {
            worker.terminate();
        }
    }
}

/** A found answer as the cell wants it. */
function dataOf(answer: FlakinessResult): FlakinessData {
    return {
        stats: answer.stats!,
        hasMatchingMessage: answer.hasMatchingMessage === true,
        configs: answer.configs ?? [],
        totalDays: answer.totalDays ?? 0,
    };
}

// --- the cell -------------------------------------------------------------

/** The mitten glyph that marks a same-message rate. `old/try.html:1483`. */
export function mitten(): HTMLElement {
    return el('span', { class: 'mitten' });
}

/**
 * Paints one flakiness cell. `old/try.html:2848`.
 *
 * The rate links to `test.html` for the test, the same URL the path links to —
 * but not the shared link element: this anchor's text is a percentage and its
 * title is the per-config breakdown, so only the destination is shared. The
 * click stops there, so it does not also toggle the row it sits in.
 */
export function paintFlakinessCell(cell: HTMLElement, testPath: string, data: FlakinessData | null): void {
    const view = flakinessCell(data);
    if (view === null) {
        cell.replaceChildren();
        cell.className = 'flakiness-cell';
        cell.title = '';
        return;
    }
    cell.className = view.className;
    const anchor = el('a', { href: testPageUrl(testPath), title: view.tooltip });
    anchor.target = '_blank';
    anchor.addEventListener('click', (event) => event.stopPropagation());
    if (view.hasMitten) {
        anchor.append(mitten());
    }
    anchor.append(view.text);
    cell.replaceChildren(anchor);
}
