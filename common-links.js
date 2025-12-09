/**
 * Common link generation utilities for test results
 * Shared between crashes.html, failures.html, etc.
 */

/**
 * Generate Firefox Profiler URL for a test run
 * @param {Object} instance - Test run instance with taskId, retryId, jobName
 * @param {string} [testName] - Optional test name to filter markers
 * @returns {string} - Firefox Profiler URL
 */
function getProfilerUrl(instance, testName) {
    const profileUrl = `https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/${instance.taskId}/runs/${instance.retryId}/artifacts/public/test_info/profile_resource-usage.json`;
    const encodedProfileUrl = encodeURIComponent(profileUrl);
    const profileName = `${instance.jobName} (${instance.taskId}.${instance.retryId})`;
    const encodedProfileName = encodeURIComponent(profileName);
    let url = `https://profiler.firefox.com/from-url/${encodedProfileUrl}?profileName=${encodedProfileName}`;
    if (testName) {
        url += `&markerSearch=${encodeURIComponent(testName)}`;
    }
    return url;
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
 * @param {string} [testName] - Optional test name to filter markers
 * @returns {string} - HTML string with links
 */
function renderCrashLinks(crashInstance, testName) {
    let html = '';
    const profilerUrl = getProfilerUrl(crashInstance, testName);
    html += `<a href="${profilerUrl}" target="_blank" class="crash-link" style="margin-right: 10px;">View Profile</a>`;

    const crashUrl = getCrashViewerUrl(crashInstance);
    if (crashUrl) {
        html += `<a href="${crashUrl}" target="_blank" class="crash-link">View Crash</a>`;
    }
    return html;
}

/**
 * Generate Bugzilla bug filing URL
 * @param {Object} options - Bug filing options
 * @param {string} options.testPath - Full test path (dirPath/testName)
 * @param {string} options.summary - Bug summary (failure message)
 * @param {string} [options.component] - Bugzilla component (optional)
 * @param {Object} [options.stats] - Statistics like failureCount, firstSeen, lastSeen (optional)
 * @returns {string} - Bugzilla URL
 */
function getBugzillaUrl(options) {
    const { testPath, summary, component, stats } = options;

    const params = new URLSearchParams();

    // Parse component string which is in format "Product :: Component"
    const [product, comp] = component.split(' :: ', 2);
    params.set('product', product);
    params.set('component', comp);

    // Pre-fill summary with failure message
    params.set('short_desc', `Intermittent ${testPath} | ${summary}`);

    // Build URL with search filter for this specific failure message
    // Limit to 150 chars to avoid excessively long URLs
    const searchQuery = summary.length > 150 ? summary.substring(0, 150) : summary;
    const url = new URL(window.location.href);
    url.hash = ''; // Clear existing hash
    const hashParams = new URLSearchParams();
    hashParams.set('q', searchQuery);
    url.hash = hashParams.toString();

    // Build description
    let description = `Test: ${testPath}\n\n`;
    description += `Failure message: ${summary}\n\n`;

    if (stats?.failureCount) {
        const occurrenceText = stats.failureCount === 1 ? 'occurred once' : `occurred ${stats.failureCount} times`;

        let dateRange = '';
        if (stats.firstSeen && stats.lastSeen) {
            const firstDate = new Date(stats.firstSeen).toISOString().split('T')[0];
            const lastDate = new Date(stats.lastSeen).toISOString().split('T')[0];
            dateRange = firstDate === lastDate ? ` on ${firstDate}` : ` between ${firstDate} and ${lastDate}`;
        }

        let runInfo = '';
        if (stats.totalRuns && stats.totalRuns > 0) {
            const percentage = ((stats.failureCount / stats.totalRuns) * 100).toFixed(2);
            runInfo = ` out of ${stats.totalRuns.toLocaleString()} runs (${percentage}%)`;
        }

        description += `This failure [${occurrenceText}](${url.toString()})${runInfo}${dateRange}.\n`;
    }

    params.set('comment', description);

    return `https://bugzilla.mozilla.org/enter_bug.cgi?${params.toString()}`;
}

// Export for use in other modules (if using modules)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getProfilerUrl,
        getCrashViewerUrl,
        renderCrashLinks,
        getBugzillaUrl
    };
}
