# Are Tests Fast Yet?

A dashboard for visualizing Firefox test job performance metrics over time.

## Features

- **Interactive scatter plots** showing test duration trends for each platform (Android, Linux, Windows, macOS)
- **Repository comparison** - Switch between `autoland` and `mozilla-central` repositories
- **Build type visualization** - Different colors for debug (red) and opt (teal) builds
- **Resource usage profiling** - Click any data point to view detailed performance profiles in Firefox Profiler

## Usage

1. Visit https://fqueze.github.io/aretestsfastyet/
2. Use the repository buttons to switch between autoland and mozilla-central
3. Click the platform links to jump to specific charts
4. Hover over data points to see test details
5. Click on any data point to open its resource usage profile

## URL Parameters

- `#autoland` - Show autoland repository data
- `#mozilla-central` - Show mozilla-central repository data
- `#autoland:linux` - Show autoland data and scroll to Linux chart
- `#mozilla-central:windows` - Show mozilla-central data and scroll to Windows chart

## Data Source

The dashboard fetches test performance data from the [Treeherder database](https://treeherder.mozilla.org/), displaying xpcshell test execution times from the last 21 days.
