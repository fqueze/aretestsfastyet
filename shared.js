// Shared visualization code for Firefox performance dashboards

const platforms = {
    'android': 'Android',
    'linux': 'Linux',
    'windows': 'Windows',
    'mac': 'macOS'
};

function createProfileUrl(taskId, retryId, jobName, useTaskClusterTools = false) {
    // Use TaskCluster tools if requested, for decision tasks, or for Android artifact builds
    if (useTaskClusterTools ||
        jobName.includes('Decision Task') ||
        jobName.includes('geckoview-fat-aar')) {
        return `https://gregtatum.github.io/taskcluster-tools/src/taskprofiler/?taskId=${taskId}`;
    }

    // Determine if this is a build job based on the job name
    // Test jobs start with "test-", everything else is a build job
    const isBuildJob = !jobName.startsWith('test-');

    const profilePath = isBuildJob
        ? 'build/profile_build_resources.json'
        : 'test_info/profile_resource-usage.json';

    const baseUrl = `https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/${taskId}/runs/${retryId}/artifacts/public/${profilePath}`;
    const encodedUrl = encodeURIComponent(baseUrl);
    const profileName = `${jobName} (${taskId}.${retryId})`;
    const encodedName = encodeURIComponent(profileName);
    return `https://profiler.firefox.com/from-url/${encodedUrl}?profileName=${encodedName}`;
}

function extractPlatform(name) {
    let platform = 'unknown';

    // Check for Android builds first (e.g., build-fat-aar-android-geckoview-fat-aar/opt)
    if (name.includes('android')) {
        platform = 'android';
    } else {
        const platformMatch = name.match(/(?:test-|build-)([^-\/]+)/);
        if (platformMatch) {
            const rawPlatform = platformMatch[1];
            if (rawPlatform.includes('linux')) platform = 'linux';
            else if (rawPlatform.includes('win')) platform = 'windows';  // Catch win32, win64, etc.
            else if (rawPlatform.includes('macos')) platform = 'mac';
        }
    }
    return platform;
}

function formatDurationS(totalSeconds) {
    if (totalSeconds >= 3600) {
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
    } else {
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = Math.floor(totalSeconds % 60);
        return `${minutes}m ${seconds}s`;
    }
}

function createScatterPlot(container, platformData, platform, currentRepository, colors, buildTypes) {
    // Add anchor for direct linking
    const anchor = document.createElement('a');
    anchor.id = `${currentRepository}:${platform}`;
    anchor.style.display = 'block';
    anchor.style.position = 'relative';
    anchor.style.top = '-80px';
    container.appendChild(anchor);

    const traces = [];

    buildTypes.forEach(buildType => {
        const filteredData = platformData.filter(d => d.build_type === buildType);
        if (filteredData.length === 0) return;

        const trace = {
            x: filteredData.map(d => new Date(d.date)),
            y: filteredData.map(d => d.duration_seconds / 60), // Convert to minutes
            mode: 'markers',
            type: 'scatter',
            name: buildType.toUpperCase().replace(/-/g, ' '),
            marker: {
                color: colors[buildType],
                size: 8,
                opacity: 0.7
            },
            customdata: filteredData.map(d => {
                return {
                    name: d.name,
                    taskId: d.task_id,
                    retryId: d.retry_id,
                    buildType: d.build_type,
                    durationStr: formatDurationS(d.duration_seconds),
                    date: d.date,
                    repository: d.repository,
                    machineRow: (d.machine_name && d.machine_name.trim() !== '') ? `Machine: ${d.machine_name}<br>` : ''
                };
            }),
            hovertemplate: '<b>%{customdata.name}</b><br>' +
                           'Repository: %{customdata.repository}<br>' +
                           'Duration: %{customdata.durationStr}<br>' +
                           'Date: %{x|%Y-%m-%d %H:%M}<br>' +
                           'Build: %{customdata.buildType}<br>' +
                           '%{customdata.machineRow}' +
                           '<i>Click to view profile</i><br>' +
                           '<extra></extra>'
        };
        traces.push(trace);
    });

    const layout = {
        title: `${platforms[platform]} - ${currentRepository}`,
        xaxis: {
            title: 'Date',
            type: 'date',
            tickformat: '%Y-%m-%d'
        },
        yaxis: {
            title: 'Duration (minutes)',
            rangemode: 'tozero'
        },
        hovermode: 'closest',
        showlegend: true,
        legend: {
            x: 1,
            y: 1,
            xanchor: 'right',
            bgcolor: 'rgba(255,255,255,0.9)',
            bordercolor: '#ccc',
            borderwidth: 1
        },
        hoverlabel: {
            bgcolor: '#2a2a2a',
            bordercolor: '#2a2a2a',
            font: {
                size: 15,
                color: 'white',
                family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif'
            }
        },
        margin: {
            l: 60,
            r: 40,
            t: 60,
            b: 60
        }
    };

    const config = {
        responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        toImageButtonOptions: {
            format: 'png',
            filename: `performance-${platform}-${currentRepository}`,
            height: 600,
            width: 800,
            scale: 1
        }
    };

    Plotly.newPlot(container.id, traces, layout, config);

    // Add click handler using shared function
    addClickHandler(container.id);
}

function openProfile(taskId, retryId, jobName, useTaskClusterTools = false) {
    const url = createProfileUrl(taskId, retryId, jobName, useTaskClusterTools);
    window.open(url, '_blank');
}

function addClickHandler(containerId) {
    const plotElement = document.getElementById(containerId);

    // Add click handler for data points to open profile
    plotElement.on('plotly_click', function(data) {
        if (data.points.length > 0) {
            const { customdata } = data.points[0];
            const { taskId, retryId, name } = customdata;

            // Check if alt key was pressed
            const useTaskClusterTools = (data.event && data.event.altKey) ||
                                      (arguments[1] && arguments[1].altKey) ||
                                      (data.altKey);

            openProfile(taskId, retryId, name, useTaskClusterTools);
        }
    });

    // Make cursor appear as pointer when hovering over data points
    const dragLayer = plotElement.getElementsByClassName('nsewdrag')[0];
    if (dragLayer) {
        plotElement.on('plotly_hover', function(data) {
            dragLayer.style.cursor = 'pointer';
        });

        plotElement.on('plotly_unhover', function(data) {
            dragLayer.style.cursor = '';
        });
    }
}

function jumpToPlatform(platform, currentRepository) {
    const targetId = `${currentRepository}-${platform}-tests`;
    window.location.hash = targetId;
    const element = document.getElementById(targetId);
    if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function setupWindowResize() {
    let resizeTimeout;
    window.addEventListener('resize', function() {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(function() {
            // Resize all Plotly charts
            const chartContainers = document.querySelectorAll('.chart-container');
            chartContainers.forEach(container => {
                if (container.id) {
                    Plotly.Plots.resize(container.id);
                }
            });
        }, 250);
    });
}

function handleHashChange(switchRepository) {
    window.addEventListener('hashchange', function() {
        const hash = window.location.hash.substring(1);
        if (hash) {
            const [repo, platform] = hash.split(':');
            if (repo && (repo === 'autoland' || repo === 'mozilla-central')) {
                switchRepository(repo, false);
                if (platform) {
                    const element = document.getElementById(hash);
                    if (element) {
                        element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                }
            }
        }
    });
}

function parseInitialHash() {
    const hash = window.location.hash.substring(1);
    if (hash && hash.endsWith('-tests')) {
        // Remove -tests suffix first
        const withoutSuffix = hash.slice(0, -6);
        // Check for known repositories
        if (withoutSuffix.startsWith('autoland-')) {
            const platform = withoutSuffix.slice(9); // Remove 'autoland-'
            return { repository: 'autoland', platform: platform };
        } else if (withoutSuffix.startsWith('mozilla-central-')) {
            const platform = withoutSuffix.slice(16); // Remove 'mozilla-central-'
            return { repository: 'mozilla-central', platform: platform };
        }
    }
    return { repository: 'autoland', platform: null };
}
