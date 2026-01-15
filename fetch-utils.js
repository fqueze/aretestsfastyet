// Utility functions for fetching xpcshell data

// Helper function to fetch from Firefox CI with specified harness
function fetchFromCI(harness, repository, filename) {
    const prefix = `https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/gecko.v2.${repository}.latest.source.test-info-${harness}-timings/artifacts/public/`;
    return fetch(`${prefix}${filename}`);
}

// Fetch data file with appropriate prefix based on page protocol
// For try runs, if xpcshell data doesn't exist, falls back to mochitest data
async function fetchData(filename) {
    if (window.location.protocol === 'https:') {
        // Use try repository for fqueze.github.io, mozilla-central for others
        const repository = window.location.hostname === 'fqueze.github.io' ? 'try' : 'mozilla-central';

        // Try xpcshell first
        const response = await fetchFromCI('xpcshell', repository, filename);

        // If xpcshell data exists, return it
        if (response.ok) {
            return response;
        }

        // For try runs, fall back to mochitest if xpcshell doesn't exist
        if (filename.startsWith('xpcshell-try-')) {
            const mochitestFilename = filename.replace('xpcshell-', 'mochitest-');
            console.log(`xpcshell data not found for ${filename}, trying ${mochitestFilename}...`);
            return fetchFromCI('mochitest', repository, mochitestFilename);
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
