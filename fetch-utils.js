// Utility functions for fetching test data

// Get harness type from URL parameter (default: xpcshell)
// Usage: Add ?kind=mochitest to URL to fetch mochitest data instead
function getHarnessType() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('kind') || 'xpcshell';
}

// The raw ?data-source= and ?profiler= URL parameters, parsed once (they can't
// change without a page load). Empty string when absent.
const _urlParams = new URLSearchParams(window.location.search);
const _dataSourceParam = _urlParams.get('data-source') || '';
// Raw ?profiler= value, kept only so withDevParams() can propagate it onto nav
// links. Its meaning (hostname / full URL / shorthand) is interpreted by
// getProfilerOrigin() in shared.js; here we just carry the value through.
const _profilerParam = _urlParams.get('profiler') || '';

// Determine where test data is fetched from. Possible values:
//   'try'     - CI data from the try repository
//   'central' - CI data from mozilla-central
//   'local'   - local ./data/ files
// Override with ?data-source=try|central|local (handy while developing). When
// the parameter is absent we fall back to the default for the deployment:
// local files when not served over https, try on the staging site, otherwise
// mozilla-central.
function getDataSource() {
    if (_dataSourceParam) {
        return _dataSourceParam;
    }
    if (window.location.protocol !== 'https:') {
        return 'local';
    }
    return window.location.hostname === 'fqueze.github.io' ? 'try' : 'central';
}

// Propagate the active dev-override parameters (?data-source=, ?profiler=) onto
// an internal link so that navigating between dashboards keeps them. Each is
// only appended when explicitly present in the current URL, leaving normal
// browsing URLs untouched. Inserts before any #hash so the query stays valid.
function withDevParams(url) {
    const params = [];
    if (_dataSourceParam) {
        params.push(`data-source=${encodeURIComponent(_dataSourceParam)}`);
    }
    if (_profilerParam) {
        params.push(`profiler=${encodeURIComponent(_profilerParam)}`);
    }
    if (!params.length) {
        return url;
    }
    const hashIndex = url.indexOf('#');
    const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
    const hash = hashIndex === -1 ? '' : url.slice(hashIndex);
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}${params.join('&')}${hash}`;
}

// Helper function to fetch from Firefox CI
// indexName is the test-info-* suffix, e.g. 'xpcshell-timings', 'worker-data'
// Caches the resolved base URL after the first redirect to avoid repeated redirects.
const _resolvedBaseUrls = new Map(); // indexName -> resolved base URL prefix
async function fetchFromCI(indexName, filename) {
    const cached = _resolvedBaseUrls.get(indexName);
    if (cached) {
        return fetch(`${cached}${filename}`);
    }
    const repository = getDataSource() === 'try' ? 'try' : 'mozilla-central';
    const prefix = `https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/gecko.v2.${repository}.latest.source.test-info-${indexName}/artifacts/public/`;
    const response = await fetch(`${prefix}${filename}`);
    // Cache the resolved base URL from the final (redirected) URL.
    if (response.ok && response.url) {
        const base = response.url.substring(0, response.url.lastIndexOf('/') + 1);
        if (base !== prefix) {
            _resolvedBaseUrls.set(indexName, base);
        }
    }
    return response;
}

// Helper function to fetch JSON with error handling
async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        return null;
    }
    return response.json();
}

// Find all timings jobs for a try revision using Treeherder API
// Returns an object with xpcshell and mochitest task IDs (if they exist)
async function findTimingsJobsForRevision(revision) {
    try {
        console.log(`Finding timings jobs for try revision ${revision}...`);

        // Get push ID from revision
        const pushResult = await fetchJson(
            `https://treeherder.mozilla.org/api/project/try/push/?full=true&count=10&revision=${revision}`
        );

        if (!pushResult || !pushResult.results || pushResult.results.length === 0) {
            throw new Error(`No push found for revision ${revision} on try`);
        }

        const pushId = pushResult.results[0].id;
        console.log(`Found push ID: ${pushId}`);

        // Fetch all jobs for this push (with pagination)
        let allJobs = [];
        let propertyNames = [];
        let url = `https://treeherder.mozilla.org/api/jobs/?push_id=${pushId}`;

        while (url) {
            const result = await fetchJson(url);
            if (!result) {
                throw new Error(`Failed to fetch jobs for push ID ${pushId}`);
            }

            allJobs = allJobs.concat(result.results || []);
            if (!propertyNames.length) {
                propertyNames = result.job_property_names || [];
            }

            url = result.next;
        }

        console.log(`Found ${allJobs.length} total jobs`);

        // Find field indices
        const jobTypeNameIndex = propertyNames.indexOf('job_type_name');
        const taskIdIndex = propertyNames.indexOf('task_id');
        const stateIndex = propertyNames.indexOf('state');

        // Find the most recent completed timings jobs (keep the last one found in the list)
        const timingsJobs = {
            xpcshell: null,
            mochitest: null
        };

        for (const job of allJobs) {
            const jobName = job[jobTypeNameIndex];
            const state = job[stateIndex];
            const taskId = job[taskIdIndex];

            if (state !== 'completed' || !jobName || !taskId) {
                continue;
            }

            if (jobName.endsWith('xpcshell-timings-rev')) {
                timingsJobs.xpcshell = taskId;
            } else if (jobName.endsWith('mochitest-timings-rev')) {
                timingsJobs.mochitest = taskId;
            }
        }

        if (timingsJobs.xpcshell) {
            console.log(`Found xpcshell-timings job: ${timingsJobs.xpcshell}`);
        }
        if (timingsJobs.mochitest) {
            console.log(`Found mochitest-timings job: ${timingsJobs.mochitest}`);
        }

        return timingsJobs;
    } catch (error) {
        console.error(`Error finding timings jobs:`, error);
        throw error;
    }
}

// Fetch data file with appropriate prefix based on page protocol
// For try runs, if xpcshell data doesn't exist, falls back to mochitest data
async function fetchData(filename) {
    if (getDataSource() !== 'local') {
        // Check if this is a try revision file (format: xpcshell-try-<revision>.json or mochitest-try-<revision>.json)
        const tryMatch = filename.match(/^(xpcshell|mochitest)-try-([a-f0-9]{40})\.json$/);

        if (tryMatch) {
            const [, requestedHarness, revision] = tryMatch;
            console.log(`Detected try revision request: ${requestedHarness} for ${revision}`);

            try {
                // Find all timings jobs for this revision (only fetch job list once)
                const timingsJobs = await findTimingsJobsForRevision(revision);

                // Try the requested harness first
                if (timingsJobs[requestedHarness]) {
                    const taskId = timingsJobs[requestedHarness];
                    const artifactUrl = `https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/${taskId}/runs/0/artifacts/public/${filename}`;
                    console.log(`Fetching ${requestedHarness} artifact: ${artifactUrl}`);
                    const response = await fetch(artifactUrl);
                    if (response.ok) {
                        return response;
                    }
                }

                // Fall back to the other harness if requested was xpcshell
                if (requestedHarness === 'xpcshell' && timingsJobs.mochitest) {
                    const mochitestFilename = filename.replace('xpcshell-', 'mochitest-');
                    const taskId = timingsJobs.mochitest;
                    const artifactUrl = `https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/${taskId}/runs/0/artifacts/public/${mochitestFilename}`;
                    console.log(`xpcshell data not found, trying mochitest artifact: ${artifactUrl}`);
                    return fetch(artifactUrl);
                }

                throw new Error(`No ${requestedHarness}-timings job found for revision ${revision}`);
            } catch (error) {
                console.error(`Error fetching try revision artifact:`, error);
                return new Response(null, { status: 404, statusText: error.message });
            }
        }

        // Detect harness from filename (xpcshell-*.json or mochitest-*.json)
        // For generic files like index.json, use the URL parameter
        let harness = 'xpcshell';
        if (filename.startsWith('mochitest-')) {
            harness = 'mochitest';
        } else if (filename === 'index.json') {
            harness = getHarnessType();
        }

        // Try the detected harness first
        const response = await fetchFromCI(harness + '-timings', filename);

        // If data exists, return it
        if (response.ok) {
            return response;
        }

        // For xpcshell try runs, fall back to mochitest if xpcshell doesn't exist
        if (filename.startsWith('xpcshell-try-')) {
            const mochitestFilename = filename.replace('xpcshell-', 'mochitest-');
            console.log(`xpcshell data not found for ${filename}, trying ${mochitestFilename}...`);
            return fetchFromCI('mochitest-timings', mochitestFilename);
        }

        // For non-try runs, return the original failed response
        return response;
    } else {
        // Local file fetching
        try {
            const response = await fetch(`./data/${filename}`);

            // If local data exists, return it
            if (response.ok) {
                return response;
            }
        } catch (error) {
            // Network error (file doesn't exist, etc.)
            console.log(`Failed to fetch ${filename}:`, error.message);
        }

        // For try runs, fall back to mochitest if xpcshell doesn't exist
        if (filename.startsWith('xpcshell-try-')) {
            const mochitestFilename = filename.replace('xpcshell-', 'mochitest-');
            console.log(`Trying ${mochitestFilename}...`);
            return fetch(`./data/${mochitestFilename}`);
        }

        // For non-try runs, re-fetch to get the proper error response
        return fetch(`./data/${filename}`);
    }
}
