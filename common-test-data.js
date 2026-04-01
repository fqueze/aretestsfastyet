/**
 * Common data access utilities for test result files.
 * Shared between test.html, try.html, etc.
 */

/**
 * Detect harness type from a test file path.
 */
function detectHarness(testPath) {
    const fileName = testPath.split('/').pop();
    if (fileName.startsWith('browser_') && fileName.endsWith('.js')) {
        return 'mochitest';
    }
    if (fileName.startsWith('test_') && fileName.endsWith('.html')) {
        return 'mochitest';
    }
    if (fileName.startsWith('test_') && fileName.endsWith('.js')) {
        return 'xpcshell';
    }
    return 'xpcshell';
}

/**
 * Compute the chunk bucket index (0-63) for a test path.
 */
function getChunkIndex(fullPath, totalChunks = 64) {
    let hash = 0;
    for (let i = 0; i < fullPath.length; i++) {
        hash = ((hash << 5) - hash + fullPath.charCodeAt(i)) | 0;
    }
    return ((hash % totalChunks) + totalChunks) % totalChunks;
}

/**
 * Get count for a specific index in a statusGroup, handling all formats.
 */
function getCountAtIndex(statusGroup, index) {
    if (statusGroup.counts !== undefined) {
        return statusGroup.counts[index];
    } else if (statusGroup.durations && statusGroup.days !== undefined) {
        return statusGroup.durations[index].length;
    } else if (statusGroup.taskIdIds && statusGroup.days !== undefined) {
        return statusGroup.taskIdIds[index].length;
    } else {
        return 1;
    }
}

/**
 * Find a test in a data file by matching full path.
 * @returns {{ testId, fullPath, component }} or null
 */
function findTest(data, testPath) {
    if (!data.testRuns || !data.tables || !data.testInfo) return null;

    for (let testId = 0; testId < data.testRuns.length; testId++) {
        const testGroup = data.testRuns[testId];
        if (!testGroup) continue;

        const dirPath = data.tables.testPaths[data.testInfo.testPathIds[testId]];
        const testName = data.tables.testNames[data.testInfo.testNameIds[testId]];
        const fullPath = dirPath ? `${dirPath}/${testName}` : testName;

        if (fullPath === testPath) {
            const componentId = data.testInfo.componentIds ? data.testInfo.componentIds[testId] : null;
            const component = (componentId !== null && data.tables.components) ? data.tables.components[componentId] : null;
            return { testId, fullPath, component };
        }
    }
    return null;
}

/**
 * Compute pass/fail/skip/crash/timeout statistics for a test.
 * @param {object} data - The parsed data file (with tables, testRuns, etc.)
 * @param {number} testId - The test index in data.testRuns
 * @returns {{ runCount, skipCount, passCount, failCount, timeoutCount, crashCount, passPercentage, failureMessages }}
 */
function computeTestStats(data, testId) {
    const testGroup = data.testRuns[testId];
    if (!testGroup) {
        return { runCount: 0, skipCount: 0, passCount: 0, failCount: 0, timeoutCount: 0, crashCount: 0, passPercentage: 0, failureMessages: [] };
    }

    let skipCount = 0, timeoutCount = 0, failCount = 0, crashCount = 0, passCount = 0;
    const failureMessages = [];

    for (let statusId = 0; statusId < testGroup.length; statusId++) {
        const statusGroup = testGroup[statusId];
        if (!statusGroup) continue;

        const status = data.tables.statuses[statusId];

        let runCount = 0;
        if (statusGroup.counts !== undefined) {
            runCount = statusGroup.counts.reduce((sum, count) => sum + count, 0);
        } else if (statusGroup.durations && statusGroup.days !== undefined) {
            runCount = statusGroup.durations.reduce((sum, bucket) => sum + bucket.length, 0);
        } else if (statusGroup.taskIdIds && statusGroup.days !== undefined) {
            runCount = statusGroup.taskIdIds.reduce((sum, bucket) => sum + bucket.length, 0);
        } else if (statusGroup.taskIdIds) {
            runCount = statusGroup.taskIdIds.length;
        }

        const isSkip = status === 'SKIP';
        const isCrash = status === 'CRASH';
        const isTimeout = status && status.startsWith('TIMEOUT');
        const isFail = status && !status.startsWith('PASS') && !status.startsWith('TIMEOUT') && !['SKIP', 'CRASH', 'EXPECTED-FAIL', 'OK'].includes(status);

        if (isSkip) {
            if (statusGroup.messageIds) {
                for (let i = 0; i < statusGroup.messageIds.length; i++) {
                    const messageId = statusGroup.messageIds[i];
                    const message = messageId !== null ? data.tables.messages[messageId] : null;
                    if (!message || !message.startsWith('run-if')) {
                        skipCount += getCountAtIndex(statusGroup, i);
                    }
                }
            } else {
                skipCount += runCount;
            }
        } else if (isCrash) {
            crashCount += runCount;
        } else if (isTimeout) {
            timeoutCount += runCount;
        } else if (status === 'UNKNOWN') {
            // Ignore UNKNOWN status
        } else if (isFail) {
            failCount += runCount;
            // Collect failure messages
            if (statusGroup.messageIds) {
                for (const messageId of statusGroup.messageIds) {
                    if (messageId !== null && messageId !== undefined) {
                        const msg = data.tables.messages[messageId];
                        if (msg) failureMessages.push(msg);
                    }
                }
            }
        } else {
            passCount += runCount;
        }
    }

    const totalRunCount = timeoutCount + failCount + crashCount + passCount;

    return {
        runCount: totalRunCount,
        skipCount,
        passCount,
        failCount,
        timeoutCount,
        crashCount,
        passPercentage: totalRunCount > 0 ? Math.round((passCount / totalRunCount) * 10000) / 100 : 0,
        failureMessages,
    };
}
