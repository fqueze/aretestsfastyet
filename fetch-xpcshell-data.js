#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const os = require('os');

// Configuration
const MAX_WORKERS = Math.max(1, Math.floor(os.cpus().length / 2));
const CACHE_DIR = './xpcshell-data';
const PROFILE_CACHE_DIR = './profile-cache';

// Ensure cache directories exist
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}
if (!fs.existsSync(PROFILE_CACHE_DIR)) {
    fs.mkdirSync(PROFILE_CACHE_DIR, { recursive: true });
}

// Get date in YYYY-MM-DD format
function getDateString(daysAgo = 0) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    return date.toISOString().split('T')[0];
}

// Resource profile fetching moved to profile-worker.js

// Fetch try commit push data from Treeherder API
async function fetchTryCommitData(revision) {
    console.log(`Fetching try commit data for revision ${revision}...`);

    const response = await fetch(`https://treeherder.mozilla.org/api/project/try/push/?full=true&count=10&revision=${revision}`);

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();

    if (!result.results || result.results.length === 0) {
        throw new Error(`No push found for revision ${revision}`);
    }

    const pushId = result.results[0].id;
    console.log(`Found push ID: ${pushId}`);
    return pushId;
}

// Fetch jobs from try push
async function fetchTryJobs(pushId) {
    console.log(`Fetching jobs for push ID ${pushId}...`);

    const response = await fetch(`https://treeherder.mozilla.org/api/jobs/?push_id=${pushId}`);

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    const allJobs = result.results || [];
    const propertyNames = result.job_property_names || [];

    // Get field indices dynamically
    const jobTypeNameIndex = propertyNames.indexOf('job_type_name');
    const taskIdIndex = propertyNames.indexOf('task_id');
    const retryIdIndex = propertyNames.indexOf('retry_id');
    const lastModifiedIndex = propertyNames.indexOf('last_modified');

    // Filter for xpcshell jobs and convert to the expected format
    const xpcshellJobs = allJobs
        .filter(job => job[jobTypeNameIndex] && job[jobTypeNameIndex].includes('xpcshell'))
        .map(job => ({
            name: job[jobTypeNameIndex],
            task_id: job[taskIdIndex],
            retry_id: job[retryIdIndex] || 0,
            start_time: job[lastModifiedIndex],
            repository: 'try'
        }));

    console.log(`Found ${xpcshellJobs.length} xpcshell jobs out of ${allJobs.length} total jobs`);
    return xpcshellJobs;
}

// Fetch xpcshell test data from Mozilla's Telemetry API for a specific date
async function fetchXpcshellData(targetDate) {
    console.log(`Fetching xpcshell test data for ${targetDate}...`);

    // Fetch data from the Telemetry API
    const response = await fetch('https://sql.telemetry.mozilla.org/api/queries/110630/results.json?api_key=Pyybfsna2r5KQkwYgSk9zqbYfc6Dv0rhxL99DFi1');

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    const allJobs = result.query_result.data.rows;

    // Filter for xpcshell jobs from the target date
    const xpcshellJobs = allJobs.filter(job => {
        const jobDate = job.start_time.split('T')[0];
        return job.name.includes('xpcshell') && jobDate === targetDate;
    });

    return xpcshellJobs;
}

// Process jobs using worker threads with dynamic job distribution
async function processJobsWithWorkers(jobs, debug = false, targetDate = null) {
    if (jobs.length === 0) return [];

    const dateStr = targetDate ? ` for ${targetDate}` : '';
    console.log(`Processing ${jobs.length} jobs${dateStr} using ${MAX_WORKERS} workers...`);

    const jobQueue = [...jobs];
    const results = [];
    const workers = [];
    let completedJobs = 0;
    let lastProgressTime = 0;

    return new Promise((resolve, reject) => {
        // Track worker states
        const workerStates = new Map();

        // Create workers
        for (let i = 0; i < MAX_WORKERS; i++) {
            const worker = new Worker(path.join(__dirname, 'profile-worker.js'), {
                workerData: {
                    profileCacheDir: PROFILE_CACHE_DIR
                }
            });

            workers.push(worker);
            workerStates.set(worker, { id: i + 1, ready: false, jobsProcessed: 0 });

            worker.on('message', (message) => {
                const workerState = workerStates.get(worker);

                if (message.type === 'ready') {
                    workerState.ready = true;
                    assignNextJob(worker);
                } else if (message.type === 'jobComplete') {
                    workerState.jobsProcessed++;
                    completedJobs++;

                    if (message.result) {
                        results.push(message.result);
                    }

                    // Show progress at most once per second, or on first/last job
                    const now = Date.now();
                    if (completedJobs === 1 || completedJobs === jobs.length || (now - lastProgressTime) >= 1000) {
                        const percentage = Math.round((completedJobs / jobs.length) * 100);
                        const paddedCompleted = completedJobs.toString().padStart(jobs.length.toString().length);
                        const paddedPercentage = percentage.toString().padStart(3); // Pad to 3 chars for alignment (0-100%)
                        console.log(` ${paddedPercentage}% ${paddedCompleted}/${jobs.length}`);
                        lastProgressTime = now;
                    }

                    // Assign next job or finish
                    assignNextJob(worker);
                } else if (message.type === 'finished') {
                    // Worker finished - no need to process results as they were already handled in jobComplete
                    if (debug) {
                        console.log(`Worker ${workerState.id} finished processing ${workerState.jobsProcessed} jobs`);
                    }
                    checkAllComplete();
                } else if (message.type === 'error') {
                    reject(new Error(`Worker ${workerState.id} error: ${message.error}`));
                }
            });

            worker.on('error', (error) => {
                reject(new Error(`Worker ${workerStates.get(worker).id} thread error: ${error.message}`));
            });

            worker.on('exit', (code) => {
                if (code !== 0) {
                    reject(new Error(`Worker ${workerStates.get(worker).id} stopped with exit code ${code}`));
                }
            });
        }

        function assignNextJob(worker) {
            if (jobQueue.length > 0) {
                const job = jobQueue.shift();
                worker.postMessage({ type: 'job', job });
            } else {
                // No more jobs, tell worker to finish
                worker.postMessage({ type: 'shutdown' });
            }
        }

        let resolved = false;
        let workersFinished = 0;

        function checkAllComplete() {
            if (resolved) return;

            workersFinished++;

            if (workersFinished >= MAX_WORKERS) {
                resolved = true;
                if (debug) {
                    console.log('All workers completed processing');
                }

                // Terminate all workers to ensure clean exit
                workers.forEach(worker => worker.terminate());

                resolve(results);
            }
        }
    });
}

// processJobsWithLimit function removed - using processJobsWithWorkers directly

// These functions are now handled by the worker threads
// (processJob and extractPlatform moved to profile-worker.js)

// Create string tables and store raw data efficiently
function createDataTables(jobResults) {
    const tables = {
        jobNames: [],
        testPaths: [],
        testNames: [],
        repositories: [],
        statuses: [],
        taskIds: [],
        messages: [],
        crashSignatures: []
    };

    // Maps for O(1) string lookups
    const stringMaps = {
        jobNames: new Map(),
        testPaths: new Map(),
        testNames: new Map(),
        repositories: new Map(),
        statuses: new Map(),
        taskIds: new Map(),
        messages: new Map(),
        crashSignatures: new Map()
    };

    // Task info maps task ID index to repository and job name indexes
    const taskInfo = {
        repositoryIds: [],
        jobNameIds: []
    };

    // Test info maps test ID index to test path and name indexes
    const testInfo = {
        testPathIds: [],
        testNameIds: []
    };

    // Map for fast testId lookup: fullPath -> testId
    const testIdMap = new Map();

    // Test runs grouped by test ID, then by status ID
    // testRuns[testId] = array of status groups for that test
    const testRuns = [];

    function findStringIndex(tableName, string) {
        const table = tables[tableName];
        const map = stringMaps[tableName];

        let index = map.get(string);
        if (index === undefined) {
            index = table.length;
            table.push(string);
            map.set(string, index);
        }
        return index;
    }

    for (const result of jobResults) {
        if (!result || !result.timings) continue;

        const jobNameId = findStringIndex('jobNames', result.jobName);
        const repositoryId = findStringIndex('repositories', result.repository);

        for (const timing of result.timings) {
            const fullPath = timing.path;

            // Check if we already have this test
            let testId = testIdMap.get(fullPath);
            if (testId === undefined) {
                // New test - need to process path/name split and create entry
                const lastSlashIndex = fullPath.lastIndexOf('/');

                let testPath, testName;
                if (lastSlashIndex === -1) {
                    // No directory, just the filename
                    testPath = '';
                    testName = fullPath;
                } else {
                    testPath = fullPath.substring(0, lastSlashIndex);
                    testName = fullPath.substring(lastSlashIndex + 1);
                }

                const testPathId = findStringIndex('testPaths', testPath);
                const testNameId = findStringIndex('testNames', testName);

                testId = testInfo.testPathIds.length;
                testInfo.testPathIds.push(testPathId);
                testInfo.testNameIds.push(testNameId);
                testIdMap.set(fullPath, testId);
            }

            const statusId = findStringIndex('statuses', timing.status || 'UNKNOWN');
            const taskIdString = `${result.taskId}.${result.retryId}`;
            const taskIdId = findStringIndex('taskIds', taskIdString);

            // Store task info only once per unique task ID
            if (taskInfo.repositoryIds[taskIdId] === undefined) {
                taskInfo.repositoryIds[taskIdId] = repositoryId;
                taskInfo.jobNameIds[taskIdId] = jobNameId;
            }

            // Initialize test group if it doesn't exist
            if (!testRuns[testId]) {
                testRuns[testId] = [];
            }

            // Initialize status group within test if it doesn't exist
            let statusGroup = testRuns[testId][statusId];
            if (!statusGroup) {
                statusGroup = {
                    taskIdIds: [],
                    durations: [],
                    timestamps: []
                };
                // Only include messageIds array for SKIP status
                if (timing.status === 'SKIP') {
                    statusGroup.messageIds = [];
                }
                // Only include crash data arrays for CRASH status
                if (timing.status === 'CRASH') {
                    statusGroup.crashSignatureIds = [];
                    statusGroup.minidumps = [];
                }
                testRuns[testId][statusId] = statusGroup;
            }

            // Add test run to the appropriate test/status group
            statusGroup.taskIdIds.push(taskIdId);
            statusGroup.durations.push(Math.round(timing.duration));
            statusGroup.timestamps.push(timing.timestamp);

            // Store message ID for SKIP status (or null if no message)
            if (timing.status === 'SKIP') {
                const messageId = timing.message ? findStringIndex('messages', timing.message) : null;
                statusGroup.messageIds.push(messageId);
            }

            // Store crash data for CRASH status (or null if not available)
            if (timing.status === 'CRASH') {
                const crashSignatureId = timing.crashSignature ? findStringIndex('crashSignatures', timing.crashSignature) : null;
                statusGroup.crashSignatureIds.push(crashSignatureId);
                statusGroup.minidumps.push(timing.minidump || null);
            }
        }
    }

    return {
        tables: tables,
        taskInfo: taskInfo,
        testInfo: testInfo,
        testRuns: testRuns
    };
}

// Common function to process jobs and create data structure
async function processJobsAndCreateData(jobs, debug, targetLabel, startTime, metadata) {
    if (jobs.length === 0) {
        console.log(`No jobs found for ${targetLabel}.`);
        return null;
    }

    // Process jobs to extract test timings
    const jobProcessingStart = Date.now();
    const jobResults = await processJobsWithWorkers(jobs, debug, targetLabel);
    const jobProcessingTime = Date.now() - jobProcessingStart;
    console.log(`Successfully processed ${jobResults.length} jobs in ${jobProcessingTime}ms`);

    // Create efficient data tables
    const dataTablesStart = Date.now();
    const dataStructure = createDataTables(jobResults);
    const dataTablesTime = Date.now() - dataTablesStart;
    console.log(`Created data tables in ${dataTablesTime}ms:`);

    // Check if any test runs were extracted
    const hasTestRuns = dataStructure.testRuns.length > 0;
    if (!hasTestRuns) {
        console.log(`No test run data extracted for ${targetLabel}`);
        return null;
    }

    const totalRuns = dataStructure.testRuns.reduce((sum, testGroup) => {
        if (!testGroup) return sum;
        return sum + testGroup.reduce((testSum, statusGroup) => testSum + (statusGroup ? statusGroup.taskIdIds.length : 0), 0);
    }, 0);
    console.log(`  ${dataStructure.testInfo.testPathIds.length} tests, ${totalRuns} runs, ${dataStructure.tables.taskIds.length} tasks, ${dataStructure.tables.jobNames.length} job names, ${dataStructure.tables.statuses.length} statuses`);

    // Convert absolute timestamps to relative and apply differential compression (in place)
    for (const testGroup of dataStructure.testRuns) {
        if (!testGroup) continue;

        for (const statusGroup of testGroup) {
            if (!statusGroup) continue;

            // Convert timestamps to relative in place
            for (let i = 0; i < statusGroup.timestamps.length; i++) {
                statusGroup.timestamps[i] = Math.floor(statusGroup.timestamps[i] / 1000) - startTime;
            }

            // Map to array of objects including crash data if present
            const runs = statusGroup.timestamps.map((ts, i) => {
                const run = {
                    timestamp: ts,
                    taskIdId: statusGroup.taskIdIds[i],
                    duration: statusGroup.durations[i]
                };
                // Include crash data if this is a CRASH status group
                if (statusGroup.crashSignatureIds) {
                    run.crashSignatureId = statusGroup.crashSignatureIds[i];
                }
                if (statusGroup.minidumps) {
                    run.minidump = statusGroup.minidumps[i];
                }
                // Include message data if this is a SKIP status group
                if (statusGroup.messageIds) {
                    run.messageId = statusGroup.messageIds[i];
                }
                return run;
            });

            // Sort by timestamp
            runs.sort((a, b) => a.timestamp - b.timestamp);

            // Apply differential compression in place for timestamps
            let previousTimestamp = 0;
            for (const run of runs) {
                const currentTimestamp = run.timestamp;
                run.timestamp = currentTimestamp - previousTimestamp;
                previousTimestamp = currentTimestamp;
            }

            // Update in place
            statusGroup.taskIdIds = runs.map(run => run.taskIdId);
            statusGroup.durations = runs.map(run => run.duration);
            statusGroup.timestamps = runs.map(run => run.timestamp);
            // Update crash data arrays if present
            if (statusGroup.crashSignatureIds) {
                statusGroup.crashSignatureIds = runs.map(run => run.crashSignatureId);
            }
            if (statusGroup.minidumps) {
                statusGroup.minidumps = runs.map(run => run.minidump);
            }
            // Update message data arrays if present
            if (statusGroup.messageIds) {
                statusGroup.messageIds = runs.map(run => run.messageId);
            }
        }
    }

    // Build output with metadata
    return {
        metadata: {
            ...metadata,
            startTime: startTime,
            generatedAt: new Date().toISOString(),
            jobCount: jobs.length,
            processedJobCount: jobResults.length
        },
        tables: dataStructure.tables,
        taskInfo: dataStructure.taskInfo,
        testInfo: dataStructure.testInfo,
        testRuns: dataStructure.testRuns
    };
}

// Process try commit data
async function processTryData(revision, forceRefetch = false, debug = false) {
    const cacheFile = path.join(CACHE_DIR, `xpcshell-try-${revision}.json`);

    // Check if we already have data for this revision
    if (fs.existsSync(cacheFile) && !forceRefetch) {
        console.log(`Data for try revision ${revision} already exists. Skipping.`);
        return null;
    }

    if (forceRefetch) {
        console.log(`Force flag detected, re-fetching data for try revision ${revision}...`);
    }

    try {
        // Fetch push ID from revision
        const pushId = await fetchTryCommitData(revision);

        // Fetch jobs for the push
        const jobs = await fetchTryJobs(pushId);

        if (jobs.length === 0) {
            console.log(`No xpcshell jobs found for try revision ${revision}.`);
            return null;
        }

        // For try commits, use the last_modified time of the first job as start time
        const startTime = jobs.length > 0 ? Math.floor(new Date(jobs[0].start_time).getTime() / 1000) : Math.floor(Date.now() / 1000);

        // Process using common function
        const output = await processJobsAndCreateData(
            jobs,
            debug,
            `try-${revision}`,
            startTime,
            {
                revision: revision,
                pushId: pushId
            }
        );

        if (!output) return null;

        const jsonString = debug ? JSON.stringify(output, null, 2) : JSON.stringify(output);
        fs.writeFileSync(cacheFile, jsonString);

        // Get file size and format it
        const stats = fs.statSync(cacheFile);
        const fileSizeBytes = stats.size;
        const fileSizeMB = Math.round(fileSizeBytes / (1024 * 1024));
        const formattedBytes = fileSizeBytes.toLocaleString();

        console.log(`Saved ${cacheFile} - ${fileSizeMB}MB (${formattedBytes} bytes)${debug ? ' (with formatting)' : ''}`);

        return output;
    } catch (error) {
        console.error(`Error processing try revision ${revision}:`, error);
        return null;
    }
}

// Process data for a single date
async function processDateData(targetDate, forceRefetch = false, debug = false) {
    const cacheFile = path.join(CACHE_DIR, `xpcshell-${targetDate}.json`);

    // Check if we already have data for this date
    if (fs.existsSync(cacheFile) && !forceRefetch) {
        console.log(`Data for ${targetDate} already exists. Skipping.`);
        return null;
    }

    if (forceRefetch) {
        console.log(`Force flag detected, re-fetching data for ${targetDate}...`);
    }

    try {
        // Fetch data for the specific date
        const jobs = await fetchXpcshellData(targetDate);

        if (jobs.length === 0) {
            console.log(`No jobs found for ${targetDate}.`);
            return null;
        }

        // Calculate start of day timestamp for relative time calculation
        const startOfDay = new Date(targetDate + 'T00:00:00.000Z');
        const startTime = Math.floor(startOfDay.getTime() / 1000); // Convert to seconds

        // Process using common function
        const output = await processJobsAndCreateData(
            jobs,
            debug,
            targetDate,
            startTime,
            {
                date: targetDate
            }
        );

        if (!output) return null;

        const jsonString = debug ? JSON.stringify(output, null, 2) : JSON.stringify(output);
        fs.writeFileSync(cacheFile, jsonString);

        // Get file size and format it
        const stats = fs.statSync(cacheFile);
        const fileSizeBytes = stats.size;
        const fileSizeMB = Math.round(fileSizeBytes / (1024 * 1024));
        const formattedBytes = fileSizeBytes.toLocaleString();

        console.log(`Saved ${cacheFile} - ${fileSizeMB}MB (${formattedBytes} bytes)${debug ? ' (with formatting)' : ''}`);

        return output;
    } catch (error) {
        console.error(`Error processing ${targetDate}:`, error);
        return null;
    }
}

// Main function
async function main() {
    const forceRefetch = process.argv.includes('--force');
    const debug = process.argv.includes('--debug');

    // Check for --days parameter
    let numDays = 3; // Default to 3 days
    const daysIndex = process.argv.findIndex(arg => arg === '--days');
    if (daysIndex !== -1 && daysIndex + 1 < process.argv.length) {
        const daysValue = parseInt(process.argv[daysIndex + 1]);
        if (!isNaN(daysValue) && daysValue > 0 && daysValue <= 30) {
            numDays = daysValue;
        } else {
            console.error('Error: --days must be a number between 1 and 30');
            process.exit(1);
        }
    }

    // Check for try commit option
    const tryIndex = process.argv.findIndex(arg => arg === '--try');
    if (tryIndex !== -1 && tryIndex + 1 < process.argv.length) {
        const revision = process.argv[tryIndex + 1];
        console.log(`Try mode: Fetching xpcshell test data for revision ${revision}`);
        console.log(`=== Processing try revision ${revision} ===`);

        const output = await processTryData(revision, forceRefetch, debug);

        if (output) {
            console.log('Successfully processed try commit data.');
        } else {
            console.log('\nNo data was successfully processed.');
        }
        return;
    }

    if (debug) {
        // Debug mode: fetch only yesterday's data with formatted JSON
        const targetDate = getDateString(1); // Yesterday
        console.log(`Debug mode: Fetching xpcshell test data for ${targetDate} only`);
        console.log(`=== Processing ${targetDate} (debug mode) ===`);

        const output = await processDateData(targetDate, forceRefetch, debug);

        if (output) {
            // Create index file even in debug mode
            const indexFile = path.join(CACHE_DIR, 'index.json');
            const files = fs.readdirSync(CACHE_DIR);
            const availableDates = [];
            files.forEach(file => {
                const match = file.match(/^xpcshell-(\d{4}-\d{2}-\d{2})\.json$/);
                if (match) {
                    availableDates.push(match[1]);
                }
            });
            availableDates.sort((a, b) => b.localeCompare(a));
            fs.writeFileSync(indexFile, JSON.stringify({ dates: availableDates }, null, 2));
            console.log(`Index file saved with ${availableDates.length} dates`);
        } else {
            console.log('\nNo data was successfully processed.');
        }
    } else {
        // Normal mode: fetch data for the specified number of days
        const dates = [];
        for (let i = 1; i <= numDays; i++) {
            dates.push(getDateString(i));
        }

        console.log(`Fetching xpcshell test data for the last ${numDays} day${numDays > 1 ? 's' : ''}: ${dates.join(', ')}`);

        for (const date of dates) {
            console.log(`\n=== Processing ${date} ===`);
            await processDateData(date, forceRefetch, debug);
        }

        // Create index file with available dates
        const indexFile = path.join(CACHE_DIR, 'index.json');
        const availableDates = [];

        // Scan for all xpcshell-*.json files in the cache directory
        const files = fs.readdirSync(CACHE_DIR);
        files.forEach(file => {
            const match = file.match(/^xpcshell-(\d{4}-\d{2}-\d{2})\.json$/);
            if (match) {
                availableDates.push(match[1]);
            }
        });

        // Sort dates in descending order (newest first)
        availableDates.sort((a, b) => b.localeCompare(a));

        fs.writeFileSync(indexFile, JSON.stringify({ dates: availableDates }, null, 2));
        console.log(`\nIndex file saved as ${indexFile} with ${availableDates.length} dates`);
    }
}

// Run the script
main().catch(console.error);
