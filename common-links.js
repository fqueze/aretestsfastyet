/**
 * Common link generation utilities for test results
 * Shared between crashes.html, failures.html, etc.
 */

/**
 * Generate Firefox Profiler URL for a test run
 * @param {Object} instance - Test run instance with taskId, retryId, jobName
 * @returns {string} - Firefox Profiler URL
 */
function getProfilerUrl(instance) {
    const profileUrl = `https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/${instance.taskId}/runs/${instance.retryId}/artifacts/public/test_info/profile_resource-usage.json`;
    const encodedProfileUrl = encodeURIComponent(profileUrl);
    const profileName = `${instance.jobName} (${instance.taskId}.${instance.retryId})`;
    const encodedProfileName = encodeURIComponent(profileName);
    return `https://profiler.firefox.com/from-url/${encodedProfileUrl}?profileName=${encodedProfileName}`;
}

/**
 * Generate crash viewer URL for a crash instance
 * @param {Object} crashInstance - Crash instance with taskId, retryId, minidump
 * @returns {string} - Crash viewer URL or empty string if no minidump
 */
function getCrashViewerUrl(crashInstance) {
    if (!crashInstance.minidump) return '';
    const jsonUrl = `https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/${crashInstance.taskId}/runs/${crashInstance.retryId}/artifacts/public/test_info/${crashInstance.minidump}.json`;
    return `crash-viewer.html?url=${encodeURIComponent(jsonUrl)}`;
}

/**
 * Render links for a crash instance (Profile + Crash Viewer)
 * @param {Object} crashInstance - Crash instance
 * @returns {string} - HTML string with links
 */
function renderCrashLinks(crashInstance) {
    let html = '';
    const profilerUrl = getProfilerUrl(crashInstance);
    html += `<a href="${profilerUrl}" target="_blank" class="crash-link" style="margin-right: 10px;">View Profile</a>`;

    const crashUrl = getCrashViewerUrl(crashInstance);
    if (crashUrl) {
        html += `<a href="${crashUrl}" target="_blank" class="crash-link">View Crash</a>`;
    }
    return html;
}

// Export for use in other modules (if using modules)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getProfilerUrl,
        getCrashViewerUrl,
        renderCrashLinks
    };
}
