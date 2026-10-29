// Cached STMO output is already filtered to regression tables and deduplicated
// by bug/job/resolution. Keep distinct IDs when combining configurations.
export interface BugMapping { repository: string; job_label: string; regression_bug_ids: number[] }
export type MappingIndex = Map<string, BugMapping>;

export function indexPerformanceBugResults(rows: unknown) {
    if (!Array.isArray(rows)) throw new Error('Unsupported regression bug results');
    const index: MappingIndex = new Map();
    const resolutions = new Map<number, string>();
    for (const row of rows) {
        if (!row || typeof row.repository !== 'string' || !row.repository ||
            typeof row.job_label !== 'string' || !row.job_label || typeof row.resolution !== 'string' ||
            !Number.isInteger(row.bug_count) || row.bug_count < 0 || typeof row.bug_ids !== 'string') {
            throw new Error('Unsupported regression bug row');
        }
        const ids: unknown = JSON.parse(row.bug_ids);
        if (!Array.isArray(ids) || !ids.every(id => Number.isInteger(id) && id > 0) ||
            new Set(ids).size !== row.bug_count || ids.length !== row.bug_count) {
            throw new Error('Invalid regression bug IDs');
        }
        const key = JSON.stringify([row.repository, row.job_label]);
        if (!index.has(key)) index.set(key, { repository: row.repository, job_label: row.job_label, regression_bug_ids: [] });
        const mapping = index.get(key)!;
        for (const id of ids as number[]) {
            if (resolutions.has(id) && resolutions.get(id) !== row.resolution) {
                throw new Error('Conflicting bug resolutions');
            }
            resolutions.set(id, row.resolution);
            if (!mapping.regression_bug_ids.includes(id)) mapping.regression_bug_ids.push(id);
        }
    }
    return { index, resolutions };
}
