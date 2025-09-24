const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

// Extract test timings from profile
function extractTestTimings(profile, jobName) {
    if (!profile || !profile.threads || !profile.threads[0]) {
        return [];
    }

    const thread = profile.threads[0];
    const { markers, stringArray } = thread;

    if (!markers || !stringArray) {
        return [];
    }

    const testStringId = stringArray.indexOf("test");
    const timings = [];

    for (let i = 0; i < markers.length; i++) {
        if (markers.name && markers.name[i] !== testStringId) {
            continue;
        }

        const data = markers.data && markers.data[i];
        if (!data) {
            continue;
        }

        let testPath = null;
        let status = 'UNKNOWN';

        // Handle both old format (type: "Text") and new format (type: "Test")
        if (data.type === "Test") {
            // New structured format
            testPath = data.test || data.name;
            status = data.status || 'UNKNOWN';

            // Check if this is an expected failure (FAIL status but green color)
            if (status === 'FAIL' && data.color === 'green') {
                status = 'EXPECTED-FAIL';
            }

            // Extract the actual test file path from the test field
            // Format: "xpcshell-parent-process.toml:dom/indexedDB/test/unit/test_fileListUpgrade.js"
            if (testPath && testPath.includes(':')) {
                testPath = testPath.split(':')[1];
            }
        } else if (data.type === "Text") {
            // Old format
            testPath = data.text;
            // We don't have status information in old format
            status = 'UNKNOWN';
        } else {
            continue;
        }

        if (!testPath || !testPath.endsWith('.js')) {
            continue;
        }

        timings.push({
            path: testPath,
            duration: markers.endTime[i] - markers.startTime[i],
            status: status,
            timestamp: profile.meta.startTime + markers.startTime[i]
        });
    }

    return timings;
}


// Fetch resource profile from TaskCluster with local caching
async function fetchResourceProfile(taskId, retryId = 0) {
    const cacheFile = path.join(workerData.profileCacheDir, `${taskId}-${retryId}.json`);

    // Check if we have a cached version
    if (fs.existsSync(cacheFile)) {
        try {
            const cachedData = fs.readFileSync(cacheFile, 'utf-8');
            return JSON.parse(cachedData);
        } catch (error) {
            console.warn(`Error reading cached profile ${taskId}: ${error.message}`);
            // Continue to fetch from network
        }
    }

    const url = `https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/${taskId}/runs/${retryId}/artifacts/public/test_info/profile_resource-usage.json`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            return null;
        }

        const profile = await response.json();

        // Cache the profile for future use
        try {
            fs.writeFileSync(cacheFile, JSON.stringify(profile));
        } catch (error) {
            console.warn(`Error caching profile ${taskId}: ${error.message}`);
        }

        return profile;
    } catch (error) {
        console.error(`Error fetching profile for task ${taskId}:`, error.message);
        return null;
    }
}

// Process a single job to extract test timings
async function processJob(job) {
    const taskId = job.task_id;
    const retryId = job.retry_id || 0;
    const jobName = job.name;

    if (!taskId) {
        return null;
    }

    // Processing job silently to avoid mixed output with main thread

    const profile = await fetchResourceProfile(taskId, retryId);
    if (!profile) {
        return null;
    }

    const timings = extractTestTimings(profile, jobName);
    if (timings.length === 0) {
        return null;
    }

    return {
        jobName: jobName,
        taskId: taskId,
        retryId: retryId,
        repository: job.repository,
        startTime: job.start_time,
        timings: timings
    };
}

// Main worker function
async function main() {
    try {
        const results = [];

        // Signal worker is ready for jobs
        parentPort.postMessage({ type: 'ready' });

        // Listen for job assignments
        parentPort.on('message', async (message) => {
            if (message.type === 'job') {
                const result = await processJob(message.job);
                if (result) {
                    results.push(result);
                }
                // Request next job
                parentPort.postMessage({ type: 'jobComplete', result });
            } else if (message.type === 'shutdown') {
                // Send final results and exit
                parentPort.postMessage({ type: 'finished', results });
            }
        });
    } catch (error) {
        parentPort.postMessage({ type: 'error', error: error.message });
    }
}

main();