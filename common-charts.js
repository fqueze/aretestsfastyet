/**
 * Common chart utilities for historical data visualization
 * Shared between crashes.html, failures.html, etc.
 */

/**
 * Generic function to calculate daily rates with a test filter
 * @param {Object} options - Configuration options
 * @param {Object} options.historicalData - The historical data object
 * @param {string} options.targetValue - The value to match (e.g., crash signature or failure message)
 * @param {string} options.valueField - Field name in statusGroup (e.g., 'crashSignatureIds' or 'messageIds')
 * @param {string} options.valueTable - Table name in data.tables (e.g., 'crashSignatures' or 'messages')
 * @param {string} options.statusName - Status to count (e.g., 'CRASH' or 'FAIL')
 * @param {Function} [options.testFilterFn] - Optional function to filter tests
 * @returns {Array} Array of daily data with { day, date, events, totalRuns }
 */
function calculateDailyRates(options) {
    const {
        historicalData,
        targetValue,
        valueField,
        valueTable,
        statusName,
        testFilterFn
    } = options;

    if (!historicalData) return null;

    const days = historicalData.metadata.days || 21;
    const startTime = historicalData.metadata.startTime;
    const dailyData = [];

    // Initialize daily data structure
    for (let day = 0; day < days; day++) {
        dailyData.push({
            day: day,
            date: new Date((startTime + day * 86400) * 1000).toISOString().split('T')[0],
            events: 0,
            totalRuns: 0
        });
    }

    // Find the target valueId once (much faster than looking it up every time)
    const targetValueId = historicalData.tables[valueTable].indexOf(targetValue);
    if (targetValueId === -1) {
        // Target value doesn't exist in the table, return empty results
        return dailyData;
    }

    // Iterate through all tests
    for (const testId in historicalData.testRuns) {
        // Apply filter if provided
        if (testFilterFn && !testFilterFn(testId)) continue;

        const testGroup = historicalData.testRuns[testId];

        // Count total runs per day for this test
        for (let statusId = 0; statusId < testGroup.length; statusId++) {
            const statusGroup = testGroup[statusId];
            if (!statusGroup) continue;

            const status = historicalData.tables.statuses[statusId];

            // Skip if this status doesn't match what we're looking for
            if (!status.startsWith(statusName)) continue;

            // Historical data uses bucketed format with hours
            if (statusGroup.taskIdIds && statusGroup.hours) {
                let currentHour = 0;
                for (let i = 0; i < statusGroup.hours.length; i++) {
                    currentHour += statusGroup.hours[i];
                    const day = Math.floor(currentHour / 24);
                    if (day < days) {
                        const bucket = statusGroup.taskIdIds[i];
                        const count = bucket.length;
                        dailyData[day].totalRuns += count;

                        // Check if this bucket's valueId matches our target (compare integers, not strings)
                        const valueId = statusGroup[valueField]?.[i];
                        if (valueId === targetValueId) {
                            dailyData[day].events += count;
                        }
                    }
                }
            }
        }
    }

    return dailyData;
}

/**
 * Helper to count daily runs and events for a set of test IDs
 * @param {Object} historicalData - The historical data object
 * @param {Set} testIds - Set of test IDs to count
 * @param {number} targetValueId - The target value ID to match
 * @param {string} valueField - Field name (e.g., 'messageIds' or 'crashSignatureIds')
 * @param {string} statusName - Status to count (e.g., 'FAIL' or 'CRASH')
 * @param {number} days - Number of days
 * @param {number} startTime - Start timestamp
 * @returns {Array} Daily data with events and totalRuns
 */
function countDailyRunsForTests(historicalData, testIds, targetValueId, valueField, statusName, days, startTime) {
    const dailyData = [];
    for (let day = 0; day < days; day++) {
        dailyData.push({
            day: day,
            date: new Date((startTime + day * 86400) * 1000).toISOString().split('T')[0],
            events: 0,
            totalRuns: 0
        });
    }

    for (const testId of testIds) {
        const testGroup = historicalData.testRuns[testId];
        if (!testGroup) continue;

        for (let statusId = 0; statusId < testGroup.length; statusId++) {
            const statusGroup = testGroup[statusId];
            if (!statusGroup) continue;

            const status = historicalData.tables.statuses[statusId];

            if (statusGroup.taskIdIds && statusGroup.hours) {
                let currentHour = 0;
                for (let i = 0; i < statusGroup.hours.length; i++) {
                    currentHour += statusGroup.hours[i];
                    const day = Math.floor(currentHour / 24);
                    if (day < days) {
                        const count = statusGroup.taskIdIds[i].length;

                        if (status !== 'SKIP' && !status.startsWith('SKIP')) {
                            dailyData[day].totalRuns += count;
                        }

                        if (status && status.startsWith(statusName)) {
                            const valueId = statusGroup[valueField]?.[i];
                            if (valueId === targetValueId) {
                                dailyData[day].events += count;
                            }
                        }
                    }
                }
            } else if (statusGroup.counts && statusGroup.hours) {
                let currentHour = 0;
                for (let i = 0; i < statusGroup.hours.length; i++) {
                    currentHour += statusGroup.hours[i];
                    const day = Math.floor(currentHour / 24);
                    if (day < days) {
                        const count = statusGroup.counts[i];

                        if (status !== 'SKIP' && !status.startsWith('SKIP')) {
                            dailyData[day].totalRuns += count;
                        }

                        if (status && status.startsWith(statusName)) {
                            const valueId = statusGroup[valueField]?.[i];
                            if (valueId === targetValueId) {
                                dailyData[day].events += count;
                            }
                        }
                    }
                }
            }
        }
    }

    return dailyData;
}

/**
 * Calculate daily rates for a specific value (all tests)
 */
function calculateValueDailyRates(historicalData, targetValue, valueField, valueTable, statusName) {
    return calculateDailyRates({
        historicalData,
        targetValue,
        valueField,
        valueTable,
        statusName,
        testFilterFn: null
    });
}

/**
 * Calculate daily rates for a specific path (all tests in that path)
 */
function calculatePathDailyRates(historicalData, targetValue, valueField, valueTable, statusName, dirPath) {
    return calculateDailyRates({
        historicalData,
        targetValue,
        valueField,
        valueTable,
        statusName,
        testFilterFn: (testId) => {
            const testPathId = historicalData.testInfo.testPathIds[testId];
            const testPath = historicalData.tables.testPaths[testPathId];
            return testPath === dirPath;
        }
    });
}

/**
 * Calculate daily rates for a specific test
 */
function calculateTestDailyRates(historicalData, targetValue, valueField, valueTable, statusName, dirPath, testName) {
    return calculateDailyRates({
        historicalData,
        targetValue,
        valueField,
        valueTable,
        statusName,
        testFilterFn: (testId) => {
            const testPathId = historicalData.testInfo.testPathIds[testId];
            const testNameId = historicalData.testInfo.testNameIds[testId];
            const testPath = historicalData.tables.testPaths[testPathId];
            const testNameFromId = historicalData.tables.testNames[testNameId];
            return testPath === dirPath && testNameFromId === testName;
        }
    });
}

/**
 * Helper to get common chart options
 */
function getCommonChartOptions(yAxisLabel, tooltipCallback) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
            mode: 'index',
            intersect: false
        },
        plugins: {
            title: { display: false },
            legend: { display: false },
            tooltip: {
                animation: false,
                callbacks: { label: tooltipCallback }
            }
        },
        scales: {
            x: {},
            y: {
                beginAtZero: true,
                title: { display: true, text: yAxisLabel },
                ticks: { callback: (value) => value + '%' }
            }
        }
    };
}

/**
 * Get colors for different event types
 */
function getEventColors(eventLabel) {
    const colorMap = {
        'crash': {
            backgroundColor: 'rgba(220, 53, 69, 0.7)',
            borderColor: '#dc3545'
        },
        'failure': {
            backgroundColor: 'rgba(255, 140, 0, 0.7)',
            borderColor: '#ff8c00'
        },
        'timeout': {
            backgroundColor: 'rgba(255, 193, 7, 0.7)',
            borderColor: '#ffc107'
        },
        'skip': {
            backgroundColor: 'rgba(108, 117, 125, 0.7)',
            borderColor: '#6c757d'
        }
    };

    // Default to red if unknown
    return colorMap[eventLabel] || colorMap['crash'];
}

/**
 * Create a Chart.js bar chart for rates over time
 * @param {string} canvasId - ID of canvas element
 * @param {Array} dailyData - Array of daily data with { date, events, totalRuns }
 * @param {string} label - Label for the data (used in title/tooltip)
 * @param {string} eventLabel - Label for events (e.g., "crash", "failure", "timeout", "skip")
 * @returns {Chart} Chart.js instance
 */
function createRateChart(canvasId, dailyData, label, eventLabel = 'event') {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const labels = dailyData.map(d => d.date);
    const percentages = dailyData.map(d => d.totalRuns > 0 ? (d.events / d.totalRuns * 100) : 0);

    // Format number with separators
    function formatNumber(num) {
        return num.toLocaleString();
    }

    // Get colors based on event type
    const colors = getEventColors(eventLabel);

    return new Chart(canvas, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: `${label} Rate`,
                data: percentages,
                backgroundColor: colors.backgroundColor,
                borderColor: colors.borderColor,
                borderWidth: 1
            }]
        },
        options: getCommonChartOptions(`% ${eventLabel}s`, function(context) {
            const dataIndex = context.dataIndex;
            const data = dailyData[dataIndex];
            const percentage = context.parsed.y.toFixed(1);

            // Don't show 0 values in tooltip
            if (data.events === 0) return null;

            const eventWord = data.events === 1 ? eventLabel : `${eventLabel}s`;
            return `${formatNumber(data.events)} ${eventWord} out of ${formatNumber(data.totalRuns)} runs (${percentage}%)`;
        })
    });
}

/**
 * Generate a unique chart ID from components
 */
function makeChartId(prefix, ...parts) {
    function escapeForId(text) {
        return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/[^a-zA-Z0-9]/g, '-');
    }
    return prefix + '-chart-' + parts.map(p => escapeForId(p)).join('-');
}

// Export for use in other modules (if using modules)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        calculateDailyRates,
        calculateValueDailyRates,
        calculatePathDailyRates,
        calculateTestDailyRates,
        getCommonChartOptions,
        getEventColors,
        createRateChart,
        makeChartId
    };
}
