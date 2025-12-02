// Utility functions for fetching xpcshell data

// Fetch data file with appropriate prefix based on page protocol
function fetchData(filename) {
    let prefix;
    if (window.location.protocol === 'https:') {
        // Use try repository for fqueze.github.io, mozilla-central for others
        const repository = window.location.hostname === 'fqueze.github.io' ? 'try' : 'mozilla-central';
        prefix = `https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/gecko.v2.${repository}.latest.source.test-info-xpcshell-timings/artifacts/public/`;
    } else {
        prefix = './xpcshell-data/';
    }
    return fetch(`${prefix}${filename}`);
}
