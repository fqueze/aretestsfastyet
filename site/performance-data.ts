import { decodePerformanceTasks, type PerformanceRun, type WorkerData } from './performance-view.ts';

type Entry = { key: string; rows: PerformanceRun[]; savedAt: number };
const STORE = 'days';
// Keys include the immutable Taskcluster artifact directory, not just the date.
// A new producer run must never reuse results from an older version of a day.
function database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('performance-task-cache-v1', 1);
        let settled = false;
        const fail = () => {
            settled = true;
            clearTimeout(timeout);
            reject(new Error('Task cache unavailable'));
        };
        const timeout = setTimeout(fail, 2000);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('savedAt', 'savedAt');
        };
        request.onsuccess = () => {
            if (settled) { request.result.close(); return; }
            settled = true;
            clearTimeout(timeout);
            request.result.onversionchange = () => request.result.close();
            resolve(request.result);
        };
        request.onerror = fail;
        request.onblocked = fail;
    });
}
async function readDay(key: string): Promise<PerformanceRun[] | undefined> {
    try {
        const db = await database();
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE);
                tx.onabort = () => reject(tx.error);
                const request = tx.objectStore(STORE).get(key);
                request.onsuccess = () => resolve((request.result as Entry | undefined)?.rows);
                request.onerror = () => reject(request.error);
            });
        } finally { db.close(); }
    } catch { return undefined; } // Private browsing or disabled storage still works.
}
async function writeDay(key: string, rows: PerformanceRun[]) {
    try {
        const db = await database();
        try {
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                const store = tx.objectStore(STORE);
                store.put({ key, rows, savedAt: Date.now() } satisfies Entry);
                // Prune by index keys without cloning every cached day's rows.
                let count = 0;
                const cursor = store.index('savedAt').openKeyCursor(null, 'prev');
                cursor.onsuccess = () => {
                    if (!cursor.result) return;
                    if (++count > 7) store.delete(cursor.result.primaryKey);
                    cursor.result.continue();
                };
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } finally { db.close(); }
    } catch { /* A full or unavailable cache must not fail a successful load. */ }
}

export function createPerformanceDataLoader(
    decode = decodePerformanceTasks,
    read = readDay,
    write = writeDay,
    request: typeof fetch = fetch,
) {
    const memory = new Map<string, PerformanceRun[]>();
    let active: AbortController | undefined;
    return async (url: string, date: string, progress: (text: string, downloading?: boolean) => void): Promise<PerformanceRun[]> => {
        active?.abort();
        const controller = new AbortController();
        active = controller;
        const { signal } = controller;
        const key = `${url}#${date}`;
        const remember = (rows: PerformanceRun[]) => {
            memory.delete(key);
            memory.set(key, rows);
            while (memory.size > 3) memory.delete(memory.keys().next().value!);
            return rows;
        };
        if (memory.has(key)) return remember(memory.get(key)!);
        progress(`Loading cached task data for ${date}…`);
        const cached = await read(key);
        signal.throwIfAborted();
        if (cached) return remember(cached);
        progress(`Downloading task data for ${date}…`, true);
        const timeout = setTimeout(() => controller.abort(), 90000);
        try {
            const response = await request(url, { signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const reader = response.body?.getReader();
            let data: WorkerData;
            if (!reader) {
                data = await response.json() as WorkerData;
            } else {
                const decoder = new TextDecoder();
                const chunks: string[] = [];
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    chunks.push(decoder.decode(chunk.value, { stream: true }));
                }
                chunks.push(decoder.decode());
                signal.throwIfAborted();
                progress(`Processing task data for ${date}…`);
                // Let the progress message paint before parsing the large JSON.
                await new Promise(resolve => setTimeout(resolve, 0));
                signal.throwIfAborted();
                data = JSON.parse(chunks.join('')) as WorkerData;
            }
            signal.throwIfAborted();
            const rows = remember(decode(data, date));
            // Persist only the filtered performance data, not every CI job.
            void write(key, rows);
            return rows;
        } finally { clearTimeout(timeout); }
    };
}
