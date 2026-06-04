// Single source of truth for the list of dashboards on this site.
//
// Used by:
//   - The top-right hover menu, injected on every Tier-1 page that loads this
//     script (renderDashboardMenu, auto-runs on DOMContentLoaded).
//   - help.html, the full listing page (renderDashboardList).
//   - The compact teaser section at the top of index.html (renderDashboardTeaser).
//
// To add/rename/reorder a dashboard, edit the DASHBOARDS array below; every
// consumer updates automatically. `tier: 1` entries appear in the hover menu and
// at the top of help.html; `tier: 2` entries only appear (collapsed) on help.html.
// `featured: true` entries appear in the index.html teaser.

// `desc` is the short one-liner used in the hover menu tooltip and the index
// teaser chips. `long` is the fuller description shown on help.html — detailed
// enough that a reader can decide whether the dashboard is worth exploring.
const DASHBOARDS = [
    // --- Tier 1: polished, most useful. Shown in the hover menu. ---
    { file: 'index.html', tier: 1, title: 'Test Health',
      desc: 'Overview of flaky test/job failure rates and skip rates across harnesses.',
      long: 'The site landing page. Trend charts plus a 7-day summary of flaky ' +
            'test-failure rates, flaky job-failure rates, skip rates and invalid-job ' +
            'rates for XPCShell and Mochitest (with a per-flavor breakdown). Start ' +
            'here to see at a glance whether overall test health is improving or ' +
            'regressing over time.' },
    { file: 'issues.html', tier: 1, title: 'Test Issues', featured: true,
      desc: 'Failures, timeouts, crashes and skips grouped by component and tree.',
      long: 'Every non-passing test outcome — failures, timeouts, crashes and skips — ' +
            'over the last 21 days, grouped by Bugzilla component and by directory tree ' +
            'so you can find which areas are noisiest, then drill down to the individual ' +
            'tests and their failure counts. Switch between XPCShell and Mochitest with ' +
            'the harness selector. The best place to start triaging intermittents.' },
    { file: 'test.html', tier: 1, title: 'Test Info', featured: true,
      desc: 'Everything about a single test: issues, run times and pass/fail by job.',
      long: 'A deep dive on one test (opened via ?test=path/to/test) that brings 21 days ' +
            'of history together in a single view: the test’s failure / skip / crash ' +
            'history with daily charts, per-run timings, and a pass/fail breakdown across ' +
            'job configurations. Open this when you are investigating one specific test.' },
    { file: 'try.html', tier: 1, title: 'Try Push Results', featured: true,
      desc: 'Aggregated failed tests of a single Try push, perma-fails first.',
      long: 'Point it at one Try push and it aggregates the failed tests from all of that ' +
            'push’s failed Mochitest and XPCShell jobs, with perma-fails listed first and ' +
            'intermittent failures further down. It matches each failure against historical ' +
            'data so you can see whether the outcome you got is unusual, and links through ' +
            'to Test Info for the full detail on any test.' },
    { file: 'failures.html', tier: 1, title: 'Failures', featured: true,
      desc: 'Test failures grouped by failure message.',
      long: 'Test failures grouped by failure message, so you can see which assertion or ' +
            'error strings are most common across all tests and how many runs each one ' +
            'affects. Good for spotting a single root cause behind many seemingly-unrelated ' +
            'intermittents.' },
    { file: 'crashes.html', tier: 1, title: 'Crashes', featured: true,
      desc: 'Crashes grouped by signature.',
      long: 'Crashes grouped by crash signature, with occurrence counts over time and links ' +
            'to the crashing tasks. Use it to see which signatures dominate and whether a ' +
            'particular crash is spiking.' },
    { file: 'xpcshell-timings.html', tier: 1, title: 'Test Timings', featured: true,
      desc: 'Per-test run times with a tree view and scatter charts.',
      long: 'Per-test run times, with a directory-tree view and scatter charts of duration ' +
            'over time. Use it to find the slowest tests, watch how a test’s runtime trends ' +
            'across pushes and platforms, and see whether a test’s run time is consistent or ' +
            'varies randomly.' },
    { file: 'manifests.html', tier: 1, title: 'Manifest Runtimes',
      desc: 'Per-manifest runtimes, as used by the dynamic chunking algorithm.',
      long: 'Runtime aggregated by test manifest. Mainly useful for visualizing the data ' +
            'that feeds the dynamic chunking algorithm, so you can verify that input is ' +
            'correct; it also helps find the manifests that dominate a job’s wall-clock ' +
            'time and might be worth splitting.' },
    { file: 'workers.html', tier: 1, title: 'Worker Pools',
      desc: 'CI worker pool utilization over time.',
      long: 'Utilization of the CI worker pools over time — how fully each pool’s capacity ' +
            'is being used. Useful for spotting pools that are saturated (a source of queue ' +
            'and wait delays) or, conversely, over-provisioned.' },
    { file: 'builds.html', tier: 1, title: 'Build Times', featured: true,
      desc: 'Firefox build job durations by platform.',
      long: 'Firefox build-job durations over time, broken down by platform and build type, ' +
            'as a scatter plot; click a point to open that build’s profile. Use it to track ' +
            'whether builds are getting slower and which platforms are the bottleneck.' },
    { file: 'mochitest-jobs.html', tier: 1, title: 'Mochitest Jobs', featured: true,
      desc: 'Mochitest job durations: typical wait time and dynamic-chunking quality.',
      long: 'Mochitest job durations over time, across platforms and configurations, so you ' +
            'can see how long you will typically wait for results and how well dynamic ' +
            'chunking is balancing work across chunks.' },
    { file: 'xpcshell-jobs.html', tier: 1, title: 'XPCShell Jobs', featured: true,
      desc: 'XPCShell job durations: typical wait time and dynamic-chunking quality.',
      long: 'XPCShell job durations over time, across platforms and configurations, so you ' +
            'can see how long you will typically wait for results and how well dynamic ' +
            'chunking is balancing work across chunks.' },

    // --- Tier 2: less frequently used (not yet promoted, or older / specialized). help.html only. ---
    { file: 'perma-fails.html', tier: 2, title: 'Perma-Fails',
      desc: 'Tests failing ~100% of the time on a given job configuration.',
      long: 'Tests that fail essentially 100% of the time (or more than 50%) on a particular ' +
            'job configuration. These tests still run and fail every time, creating extra ' +
            'work for sheriffs, so it is a good place to look for tests that could use a ' +
            'skip-if annotation. Computed from per-(test, job) failure rates over a 21-day ' +
            'window.' },
    { file: 'variant.html', tier: 2, title: 'Variant Impact',
      desc: 'Compares failure rates of two configs differing by a single variant token.',
      long: 'Compares test failure rates between two job configurations that differ by a ' +
            'single variant token (isolated-process, artifact, nofis, standalone, swr, msix, ' +
            '…). For each test/platform it pairs the with-token and without-token rates and ' +
            'ranks them by statistical significance, so you can tell whether enabling a ' +
            'variant actually makes tests fail more.' },
    { file: 'errors.html', tier: 2, title: 'Errors & Warnings',
      desc: 'Error and warning log markers grouped by (test, message).',
      long: 'Error and warning log markers emitted during test runs, grouped by ' +
            '(test, message). Surfaces noisy log output and recurring warnings even when ' +
            'they do not fail the test, with occurrence counts and links back to Treeherder ' +
            'and Bugzilla. Still being built out: for now it only has data from Try pushes.' },
    { file: 'green.html', tier: 2, title: 'Are Tests Green Yet?',
      desc: 'Job-level view of sheriff-annotated intermittent / expected failures.',
      long: 'A job-level rather than test-level view: it shows the jobs that sheriffs ' +
            'annotated as intermittent or expected failures, across Mozilla repositories. ' +
            'A very different angle from the test-centric dashboards. It sits in the ' +
            'second tier because the underlying data is human-annotated, and therefore of ' +
            'lower quality.' },
    { file: 'crash-viewer.html', tier: 2, title: 'Crash Dump Viewer',
      desc: 'Inspect an individual crash dump.',
      long: 'A utility for inspecting a single crash dump loaded from a URL, decoding and ' +
            'displaying its contents. Usually reached by following a link from another ' +
            'dashboard rather than browsed directly.' },
    { file: 'job-speed.html', tier: 2, title: 'Job Speed',
      desc: 'XPCShell job speed; used to tune per-job-type timeout multipliers.',
      long: 'A specialized XPCShell dashboard built (together with Runtime Histograms) to ' +
            'set test timeouts. Once the histograms had fixed the overall default timeout, ' +
            'Job Speed was used to tune the per-job-type multipliers — e.g. debug builds run ' +
            'slower than opt, and Windows slower than Linux.' },
    { file: 'resource-use.html', tier: 2, title: 'Resource Usage',
      desc: 'XPCShell per-job CPU usage; finds CPU-bound vs single-threaded jobs.',
      long: 'XPCShell per-job resource usage. Built to find jobs that already saturate all ' +
            'the CPU cores they are given — candidates for machines with more cores, since ' +
            'they parallelize well — and, at the other end, jobs spending too much time on a ' +
            'single thread that would be worth profiling to fix.' },
    { file: 'xpcshell-histograms.html', tier: 2, title: 'Runtime Histograms',
      desc: 'XPCShell runtime distribution; used to set the default test timeout.',
      long: 'Histograms of XPCShell test runtimes — the distribution of how long tests take, ' +
            'rather than per-test trends. Used (with Job Speed) to choose test timeouts: the ' +
            'histogram shape informed the overall default timeout that keeps most tests ' +
            'passing, before Job Speed tuned the per-job-type multipliers.' },
    { file: 'sp3-noise.html', tier: 2, title: 'Speedometer 3 Noise',
      desc: 'Per-subtest run-to-run noise in the Speedometer 3 benchmark.',
      long: 'Run-to-run measurement noise in the Speedometer 3 benchmark, charting each ' +
            'subtest separately so you can easily figure out which subtests are noisy on ' +
            'which platform. A specialized page for performance-benchmark work.' },
    { file: 'sp3-profiler-overhead.html', tier: 2, title: 'SP3 Profiler Overhead',
      desc: 'Profiler overhead on Speedometer 3, for the profiler team.',
      long: 'Measures the overhead the Firefox profiler adds to Speedometer 3 runs, meant ' +
            'for the profiler team to benchmark the profiler.' },
];

// Basename of the page currently being viewed (e.g. "errors.html").
// A bare "/" or directory URL is treated as "index.html".
function currentDashboardFile() {
    const path = location.pathname;
    const base = path.substring(path.lastIndexOf('/') + 1);
    return base === '' ? 'index.html' : base;
}

function escapeDashAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeDashText(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Build and inject the top-right hover menu, listing the Tier-1 dashboards.
function renderDashboardMenu() {
    const current = currentDashboardFile();
    const tier1 = DASHBOARDS.filter(d => d.tier === 1);

    const links = tier1.map(d => {
        const isCurrent = d.file === current;
        const title = escapeDashText(d.title);
        const descAttr = escapeDashAttr(d.desc);
        const descText = escapeDashText(d.desc);
        if (isCurrent) {
            return `<span class="dash-menu-item dash-menu-current" title="${descAttr}">
                        <span class="dash-menu-title">${title}</span>
                        <span class="dash-menu-desc">${descText}</span>
                    </span>`;
        }
        return `<a class="dash-menu-item" href="${d.file}" title="${descAttr}">
                    <span class="dash-menu-title">${title}</span>
                    <span class="dash-menu-desc">${descText}</span>
                </a>`;
    }).join('');

    const menu = document.createElement('nav');
    menu.className = 'dash-menu';
    menu.innerHTML = `
        <button type="button" class="dash-menu-trigger" aria-haspopup="true" aria-expanded="false">Dashboards ▾</button>
        <div class="dash-menu-panel" role="menu">
            ${links}
            <a class="dash-menu-item dash-menu-all" href="help.html">
                <span class="dash-menu-title">All dashboards…</span>
                <span class="dash-menu-desc">See the full list, including older ones.</span>
            </a>
        </div>`;
    document.body.appendChild(menu);

    // Keep aria-expanded in sync for assistive tech (CSS drives the visuals
    // via :hover / :focus-within, so this is purely for accessibility).
    const trigger = menu.querySelector('.dash-menu-trigger');
    const sync = () => trigger.setAttribute('aria-expanded',
        menu.matches(':hover') || menu.contains(document.activeElement) ? 'true' : 'false');
    menu.addEventListener('mouseenter', sync);
    menu.addEventListener('mouseleave', sync);
    menu.addEventListener('focusin', sync);
    menu.addEventListener('focusout', sync);
}

// Render the full dashboard listing into `container` (used by help.html).
function renderDashboardList(container) {
    const current = currentDashboardFile();

    function item(d) {
        const isCurrent = d.file === current;
        const title = escapeDashText(d.title);
        const desc = escapeDashText(d.long || d.desc);
        const badge = isCurrent ? ' <span class="dash-list-badge">you are here</span>' : '';
        const inner = `<div class="dash-list-title">${title}${badge}</div>
                       <div class="dash-list-desc">${desc}</div>`;
        if (isCurrent) {
            return `<div class="dash-list-item dash-list-current">${inner}</div>`;
        }
        return `<a class="dash-list-item" href="${d.file}">${inner}</a>`;
    }

    const tier1 = DASHBOARDS.filter(d => d.tier === 1).map(item).join('');
    const tier2 = DASHBOARDS.filter(d => d.tier === 2).map(item).join('');

    container.innerHTML = `
        <div class="dash-list">${tier1}</div>
        <details class="dash-list-more">
            <summary>Less frequently used dashboards</summary>
            <div class="dash-list">${tier2}</div>
        </details>`;
}

// Render the compact teaser into `container` (used by index.html). Shows the
// `featured` dashboards as chips, skipping the current page.
function renderDashboardTeaser(container) {
    const current = currentDashboardFile();
    const chips = DASHBOARDS
        .filter(d => d.featured && d.file !== current)
        .map(d => `<a class="dash-chip" href="${d.file}" title="${escapeDashAttr(d.desc)}">${escapeDashText(d.title)}</a>`)
        .join('');
    container.innerHTML =
        `<h2>Dashboards</h2>${chips}<a class="dash-teaser-all" href="help.html">See all</a>`;
}

// Pages that already display the dashboard list/teaser inline (index.html,
// help.html) don't need the floating hover menu.
function shouldAutoInjectMenu() {
    return !document.getElementById('dashboardTeaser') &&
           !document.getElementById('dashboardList');
}

// Auto-inject the hover menu on any other page that loads this script.
function maybeRenderDashboardMenu() {
    if (shouldAutoInjectMenu()) renderDashboardMenu();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeRenderDashboardMenu);
} else {
    maybeRenderDashboardMenu();
}
