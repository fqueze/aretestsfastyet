// Utility functions for fetching xpcshell data

// Fetch data file with appropriate prefix based on page protocol
function fetchData(filename) {
    const prefix = window.location.protocol === 'https:'
        ? 'https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/gecko.v2.mozilla-central.latest.source.test-info-xpcshell-timings/artifacts/public/'
        : './xpcshell-data/';
    return fetch(`${prefix}${filename}`);
}
