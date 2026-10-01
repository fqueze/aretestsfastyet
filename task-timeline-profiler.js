// Shared task timeline export for workers.html and performance-tests.html.
// ==================== Profile Generation ====================

// Test variant suffixes, from the `suffix:` of each variant in
// taskcluster/test_configs/variants.yml. Variants compose, so a label can stack
// several after the suite name. Sorted longest first, so "pb-ioi" beats "ioi".
const VARIANT_SUFFIXES = [
  'a11y-checks', 'trainhop-beta', 'trainhop-rel', 'condprof', 'standalone',
  'headless', 'wr-dc1-p', 'wr-dc2-o', 'wr-dc3-c', 'emewmf', 'mda-gpu',
  'pb-ioi', 'wr-dc0', 'zygote', 'fis-hv', 'no-nv', 'http2', 'http3', 'nogpu',
  'wmfme', 'xorig', 'async', 'nofis', 'msix', '1proc', 'uipc', 'aab', 'swr',
  'spi', 'fis', 'ioi', 'vt', 'pb', 'cf', 's',
  // Not in variants.yml: "nv" is the old spelling of no-nova, and both forms
  // appear in mid-August 2026 data. Aliased below so they share one node.
  'nv',
].sort((a, b) => b.length - a.length);

const VARIANT_ALIASES = { nv: 'no-nv' };

// Build type modifiers, from the platform keys in
// taskcluster/test_configs/test-platforms.yml. They live in the platform name,
// not after the slash, which only ever holds opt or debug. opt is the default
// flavour so a modifier alone names the build type ("asan"), and only debug is
// spelled out ("asan debug").
const BUILD_TYPE_MODIFIERS = [
  'shippable', 'devedition', 'nightlyasrelease', 'clang-trunk', 'lite',
  'asan', 'tsan', 'ccov', 'artifact', 'mingwclang',
];

// Perf test suites, from the task names in taskcluster/kinds/browsertime/*.yml.
// "browsertime-tp6-essential-firefox-yahoo-mail" is the tp6-essential suite
// loading yahoo-mail in Firefox. Longest first, so tp6-essential beats tp6.
const PERF_SUITES = [
  'browsertime-benchmark-motionmark-1-3', 'browsertime-benchmark-speedometer2-mobile',
  'browsertime-benchmark-speedometer3-mobile', 'browsertime-benchmark-unity-webgl-mobile',
  'browsertime-video-playback-latency-mobile', 'browsertime-youtube-playback-power-mobile',
  'browsertime-benchmark-jetstream2', 'browsertime-benchmark-jetstream3',
  'browsertime-video-playback-latency', 'browsertime-youtube-playback-mobile',
  'browsertime-youtube-playback-power', 'browsertime-benchmark-wasm',
  'browsertime-pageload-benchmark', 'browsertime-tp6-live-sheriffed',
  'browsertime-hev3-connection-m', 'browsertime-tp6-webextensions',
  'browsertime-tp6m-webextensions', 'browsertime-trr-performance-m',
  'browsertime-youtube-playback', 'browsertime-speculation-rules',
  'browsertime-regression-tests', 'browsertime-trr-performance',
  'browsertime-hev3-connection', 'browsertime-network-bench',
  'browsertime-responsiveness', 'browsertime-tp6m-essential',
  'browsertime-tp6m-profiling', 'browsertime-benchmark',
  'browsertime-first-install', 'browsertime-tp6-bytecode',
  'browsertime-tp6-essential', 'browsertime-tp6-profiling',
  'browsertime-media-seek', 'browsertime-speculative', 'browsertime-indexeddb',
  'browsertime-nav-bench', 'browsertime-throttled', 'browsertime-tp6-live',
  'browsertime-tp6m-live', 'browsertime-webcodecs', 'browsertime-custom',
  'browsertime-upload', 'browsertime-power', 'browsertime-tp6m',
  'browsertime-tp6', 'browsertime-tp7',
].sort((a, b) => b.length - a.length);

// The apps a perf suite can run against, from the `apps:` lists in
// taskcluster/kinds/browsertime/*.yml. Longest first so "chrome-m" wins over
// "chrome" and "custom-car" over "car".
const PERF_APPS = [
  'cstm-car-m', 'custom-car', 'safari-tp', 'geckoview', 'chrome-m', 'refbrow',
  'firefox', 'safari', 'chrome', 'fenix',
];

// Split a browsertime/raptor suite string into its suite, app and test name,
// or null if there is no app token to split on. Usually <suite>-<app>-<test>,
// but the youtube-playback suites splice the app into the middle of the suite
// name, so the app is located first and the suite rebuilt around it.
function splitPerfSuite(name) {
  const segments = name.split('-');

  // Find the app: the first token sequence that matches a known app name.
  let appIndex = -1, app = null;
  for (let i = 0; i < segments.length && appIndex < 0; i++) {
    for (const candidate of PERF_APPS) {
      const parts = candidate.split('-');
      if (i + parts.length <= segments.length &&
          parts.every((part, j) => segments[i + j] === part)) {
        appIndex = i;
        app = candidate;
        break;
      }
    }
  }
  if (appIndex < 0) return null;

  const beforeSegments = segments.slice(0, appIndex);
  const afterSegments = segments.slice(appIndex + app.split('-').length);
  const before = beforeSegments.join('-');
  const after = afterSegments.join('-');

  // When the text before the app isn't a suite on its own, the suite continues
  // after the app: "browsertime-firefox-youtube-playback-hfr" is the
  // browsertime-youtube-playback suite, and "browsertime-mobile-fenix-youtube-
  // playback-hfr" is browsertime-youtube-playback-mobile, with the "-mobile"
  // landing before the app. So try known suites built from the tokens before the
  // app plus a prefix of those after it, longest first, and whatever is left
  // over is the test name.
  if (!PERF_SUITES.includes(before)) {
    for (let take = afterSegments.length; take > 0; take--) {
      const head = afterSegments.slice(0, take);
      const rest = afterSegments.slice(take).join('-');
      for (let keep = beforeSegments.length; keep > 0; keep--) {
        const candidate = [
          ...beforeSegments.slice(0, keep),
          ...head,
          ...beforeSegments.slice(keep),
        ].join('-');
        if (PERF_SUITES.includes(candidate)) {
          return { suite: candidate, app, test: rest };
        }
      }
    }
  }

  // The common case: the suite name is everything before the app.
  return { suite: before, app, test: after };
}

// Split a task label into the four call tree levels used by the flame graph.
// Labels come in two shapes:
//   test-<platform>/<opt|debug>-<suite>[-<variant>...][-<chunk>]
//     e.g. test-linux2404-64-shippable/opt-mochitest-browser-chrome-swr-3
//   <kind>-<platform>/<opt|debug>
//     e.g. build-linux64/debug
function splitLabel(label) {
  if (!label) return { buildType: 'unknown', suite: 'unknown' };

  const slash = label.indexOf('/');
  if (slash < 0) {
    // No platform/build-type split, e.g. "source-test-mozlint-eslint": the
    // whole label is the leaf.
    return { buildType: 'other', suite: label };
  }

  const platform = label.substring(0, slash);
  const rest = label.substring(slash + 1);

  const dash = rest.indexOf('-');
  const firstToken = dash < 0 ? rest : rest.substring(0, dash);
  const isOptOrDebug = firstToken === 'opt' || firstToken === 'debug';

  let buildType;
  if (!isOptOrDebug) {
    buildType = 'other';
  } else {
    // Name the build type after any modifier carried by the platform, keeping
    // the opt/debug only when it is debug: "asan", but "asan debug".
    const modifier = BUILD_TYPE_MODIFIERS.find(m => platform.includes('-' + m));
    if (!modifier) {
      buildType = firstToken;
    } else {
      buildType = firstToken === 'debug' ? modifier + ' debug' : modifier;
    }
  }

  let suite = isOptOrDebug ? (dash < 0 ? '' : rest.substring(dash + 1)) : rest;

  // Drop the chunk number so all chunks of a suite share one call tree node.
  // The pre-strip string is kept for the perf split below, which needs to see
  // the trailing number to tell a chunk from part of a test name.
  const stripChunk = (s) => s.replace(/-\d+$/, '');
  const suiteWithChunk = suite;
  suite = stripChunk(suite);

  // Peel off variant suffixes, innermost last, e.g.
  // "mochitest-plain-spi-nofis" -> suite "mochitest-plain", variants spi+nofis.
  // A chunk number can sit between two variants ("...-swr-2-cf"), so retry the
  // chunk strip after each peel.
  const variants = [];
  for (let peeled = true; peeled; ) {
    peeled = false;
    for (const s of VARIANT_SUFFIXES) {
      if (suite.length > s.length + 1 && suite.endsWith('-' + s)) {
        suite = suite.substring(0, suite.length - s.length - 1);
        variants.unshift(VARIANT_ALIASES[s] || s);
        peeled = true;
        break;
      }
    }
    if (peeled) suite = stripChunk(suite);
  }

  if (!suite) {
    // "build-linux64/opt" and "update-integrity-de-win64-shippable/opt" have
    // nothing after the build type: fall back to the task kind.
    suite = platform.split('-')[0];
  }

  // Perf jobs carry the app and the page or benchmark in the suite name; pull
  // those out so all the pages of a suite group under one node, with the app
  // joining the variants. Split on the string that still has its chunk, since
  // matching whole suite names is the only way to tell the "-1-3" of
  // "browsertime-benchmark-motionmark-1-3" from a chunk. The test name is left
  // as-is: perf names often end in a number ("speedometer3", "motionmark-1-3").
  let test = null;
  if (suite.startsWith('browsertime-') || suite.startsWith('raptor-')) {
    const perf = splitPerfSuite(variants.length ? suite : suiteWithChunk);
    if (perf && perf.suite) {
      suite = perf.suite;
      variants.unshift(perf.app);
      if (perf.test) test = perf.test;
    }
  }

  const result = { buildType, suite };
  if (variants.length) result.variant = variants.join('+');
  if (test) result.test = test;
  return result;
}

// Taskcluster's task priorities, highest first, each a band in the
// RunningByPriority graph. autoland runs at "low" and try at "very-low", so
// those are the bands that vanish when higher priority work saturates a pool.
// `key` is the marker data property, which cannot hold the "-" of the real name.
const PRIORITIES = [
  { name: 'highest', key: 'highest', color: 'red' },
  { name: 'very-high', key: 'veryHigh', color: 'orange' },
  { name: 'high', key: 'high', color: 'yellow' },
  { name: 'medium', key: 'medium', color: 'green' },
  { name: 'low', key: 'low', color: 'blue' },
  { name: 'very-low', key: 'veryLow', color: 'purple' },
  { name: 'lowest', key: 'lowest', color: 'grey' },
].map(p => ({ ...p, cumulativeKey: p.key + 'AndUp' }));

const PRIORITY_KEYS = Object.fromEntries(PRIORITIES.map(p => [p.name, p.key]));

// The category indices used for the call tree levels. Only the outcomes get a
// color; every structural level is grey. The activity graph colors each sample
// by the category of its leaf frame, and the outcome is always the leaf, so
// this makes the flame graph colors match the activity graph above it.
const CATEGORY_POOL = 1;
const CATEGORY_REPOSITORY = 2;
const CATEGORY_BUILD_TYPE = 3;
const CATEGORY_SUITE = 4;
const CATEGORY_VARIANT = 5;
const CATEGORY_TEST = 6;
const CATEGORY_OUTCOME = { passed: 7, failed: 8, retried: 9, canceled: 10 };
const CATEGORY_IDLE = 11;

// How a task ended, as the leaf frame of the call tree, keeping the exception
// reasons apart since "the worker went away" and "a human canceled it" are
// different problems. Taskcluster's "completed" state is exclusive with
// "failed" and means the task exited zero, so it is shown as "passed".
function taskOutcome(task) {
  if (task.state === 'completed') return { name: 'passed', category: CATEGORY_OUTCOME.passed };
  if (task.state === 'failed') return { name: 'failed', category: CATEGORY_OUTCOME.failed };
  if (task.state === 'exception') {
    const reason = task.reason_resolved;
    if (reason === 'canceled' || reason === 'deadline-exceeded') {
      return { name: reason, category: CATEGORY_OUTCOME.canceled };
    }
    // worker-shutdown, intermittent-task, claim-expired, internal-error, ...:
    // the task was interrupted and will usually be retried.
    return { name: reason || 'exception', category: CATEGORY_OUTCOME.retried };
  }
  return { name: task.state || 'unknown', category: CATEGORY_OUTCOME.retried };
}

// Build the samples and stack tables: one sample per task at its start time,
// weighted by run time, stacked as pool/repository/build type/suite/variant/
// test/outcome. One sample per task rather than per interval keeps each task a
// single slice in the stack chart.
//
// The call tree reads samples.weight, but the activity graph ignores it and
// instead fills each sample's span to the next, scaled by threadCPUDelta —
// hence the concurrency in threadCPUDelta and the explicit idle samples.
function createStacks(taskList, getStringIndex, earliestTime, latestTime) {
  // frameTable/funcTable entry 0 is the (root) frame created by the caller.
  const stackTable = { frame: [0], prefix: [null], category: [0], subcategory: [0], length: 1 };
  const frameTable = {
    address: [-1], inlineDepth: [0], category: [0], subcategory: [0],
    func: [0], nativeSymbol: [null], innerWindowID: [0],
    implementation: [null], line: [null], column: [null], length: 1
  };
  const funcTable = {
    isJS: [false], relevantForJS: [false], name: [0], resource: [-1],
    fileName: [null], lineNumber: [null], columnNumber: [null], length: 1
  };

  // One frame per distinct (name, category) pair, and one stack node per
  // distinct (prefix, frame) pair, so identical paths collapse into one node.
  const frameByKey = new Map();
  function getFrame(name, category) {
    const key = category + ' ' + name;
    const existing = frameByKey.get(key);
    if (existing !== undefined) return existing;
    const funcIndex = funcTable.length;
    funcTable.isJS.push(false);
    funcTable.relevantForJS.push(false);
    funcTable.name.push(getStringIndex(name));
    funcTable.resource.push(-1);
    funcTable.fileName.push(null);
    funcTable.lineNumber.push(null);
    funcTable.columnNumber.push(null);
    funcTable.length++;

    const frameIndex = frameTable.length;
    frameTable.address.push(-1);
    frameTable.inlineDepth.push(0);
    frameTable.category.push(category);
    frameTable.subcategory.push(0);
    frameTable.func.push(funcIndex);
    frameTable.nativeSymbol.push(null);
    frameTable.innerWindowID.push(0);
    frameTable.implementation.push(null);
    frameTable.line.push(null);
    frameTable.column.push(null);
    frameTable.length++;

    frameByKey.set(key, frameIndex);
    return frameIndex;
  }

  const stackByKey = new Map();
  function getStack(prefix, name, category) {
    const frame = getFrame(name, category);
    const key = prefix + ' ' + frame;
    let idx = stackByKey.get(key);
    if (idx !== undefined) return idx;
    idx = stackTable.length;
    stackTable.frame.push(frame);
    stackTable.prefix.push(prefix);
    stackTable.category.push(category);
    stackTable.subcategory.push(0);
    stackTable.length++;
    stackByKey.set(key, idx);
    return idx;
  }

  const samples = {
    weightType: 'tracing-ms', weight: [], stack: [], time: [],
    threadCPUDelta: [], length: 0
  };

  // Samples must be ordered by time; tasks arrive in arbitrary order.
  const started = [];
  for (const t of taskList) {
    if (!t._startedMs) continue; // never ran: no duration to attribute
    if (t._resolvedMs < earliestTime || t._startedMs > latestTime) continue;
    started.push(t);
  }
  started.sort((a, b) => a._startedMs - b._startedMs);

  // How many jobs are running at any moment, so the activity graph can be
  // scaled by it. The graph fills the span from each sample to the next one, so
  // without this it would be solid at 100% even while the pool sits empty.
  const concurrencyChanges = new Map();
  for (const t of started) {
    const start = Math.max(t._startedMs, earliestTime);
    const end = Math.min(t._resolvedMs, latestTime);
    concurrencyChanges.set(start, (concurrencyChanges.get(start) || 0) + 1);
    concurrencyChanges.set(end, (concurrencyChanges.get(end) || 0) - 1);
  }
  const changeTimes = [...concurrencyChanges.keys()].sort((a, b) => a - b);
  const runningAt = new Map();
  const idleTimes = [];
  let running = 0, peakRunning = 1;
  for (let i = 0; i < changeTimes.length; i++) {
    const time = changeTimes[i];
    running += concurrencyChanges.get(time);
    runningAt.set(time, running);
    if (running > peakRunning) peakRunning = running;
    // Each threadCPUDelta covers the span before its sample, so an idle stretch
    // needs samples at both ends. The one at the end carries the empty span and
    // gets the idle stack; the one at the start closes off the busy span before
    // it and has to keep a visible stack, because the Idle category is drawn
    // transparent and would otherwise erase the run-up to every gap.
    if (running === 0) {
      idleTimes.push({ time, boundary: true });
      idleTimes.push({ time: changeTimes[i + 1] ?? latestTime, boundary: false });
    }
  }

  const idleStack = getStack(0, '(idle)', CATEGORY_IDLE);

  const events = [];
  for (const t of started) {
    events.push({ time: Math.max(t._startedMs, earliestTime), task: t });
  }
  for (const idle of idleTimes) {
    if (idle.time > earliestTime && idle.time <= latestTime) {
      events.push({ time: idle.time, task: null, boundary: idle.boundary });
    }
  }
  // At an instant where a gap ends and work resumes, the idle sample closing off
  // the empty stretch comes before the jobs starting there, so the gap keeps its
  // own zero-CPU span. A boundary sample likewise precedes anything at its time.
  events.sort((a, b) => a.time - b.time || (a.task ? 1 : 0) - (b.task ? 1 : 0));

  // The profiler reads a zero time delta as "CPU unknown" and forces that sample
  // to full height, painting a spurious block up to tens of minutes wide. Jobs
  // routinely start in the same millisecond, so collisions are pushed a
  // millisecond apart — but never past the window end, which would put the sample
  // outside profilingEndTime.
  let previousTime = -1;
  const nextFreeTime = (time) => {
    const shifted = Math.min(Math.max(time, previousTime + 1), latestTime - earliestTime);
    previousTime = shifted;
    return shifted;
  };

  for (const event of events) {
    const t = event.task;
    if (!t) {
      // A boundary sample ends the busy span before a gap, so it keeps the
      // previous sample's stack to stay visible; the gap's own sample is idle.
      samples.stack.push(
        event.boundary && samples.length ? samples.stack[samples.length - 1] : idleStack);
      samples.time.push(nextFreeTime(event.time - earliestTime));
      samples.weight.push(0);
      samples.length++;
      continue;
    }

    const { buildType, suite, variant, test } = splitLabel(t.label);
    const outcome = taskOutcome(t);
    // One category per level, so "Focus category" isolates a single level. The
    // variant and test levels only exist for the jobs that have them, so a
    // plain mochitest chunk is 5 deep and a browsertime page load is 7.
    // The pool comes first: it is the only thing that distinguishes the rows in
    // the "All Tasks" profile, where every pool's tasks share one thread.
    let stack = getStack(0, t.task_queue_id || 'unknown', CATEGORY_POOL);
    stack = getStack(stack, t.project || 'unknown', CATEGORY_REPOSITORY);
    stack = getStack(stack, buildType, CATEGORY_BUILD_TYPE);
    stack = getStack(stack, suite, CATEGORY_SUITE);
    if (variant) stack = getStack(stack, variant, CATEGORY_VARIANT);
    if (test) stack = getStack(stack, test, CATEGORY_TEST);
    stack = getStack(stack, outcome.name, outcome.category);

    // Clip to the window so a task that started before it or ended after it
    // neither inflates the totals beyond the 24h being shown nor places a
    // sample outside the profile's time range.
    const start = Math.max(t._startedMs, earliestTime);
    const end = Math.min(t._resolvedMs, latestTime);

    samples.stack.push(stack);
    samples.time.push(nextFreeTime(start - earliestTime));
    samples.weight.push(Math.max(0, end - start));
    samples.length++;
  }

  // Now that the sample times are known, fill in threadCPUDelta. Per Gecko's
  // convention it holds the CPU used *since* the previous sample — the profiler
  // divides it by time[i] - time[i-1] — so each value covers the span ending at
  // its sample. For µs units the height is cpuDelta / (1000 * spanInMs), so the
  // span's average concurrency over the peak reads as occupancy against the
  // pool's busiest moment. Changes and samples are walked together to integrate.
  let changeIndex = 0, runningNow = 0;
  const windowEnd = latestTime - earliestTime;
  for (let i = 0; i < samples.length; i++) {
    const spanEnd = samples.time[i];
    const spanStart = i > 0 ? samples.time[i - 1] : 0;
    // Sum jobs-running × time over the span, advancing through the changes.
    let busyMs = 0, at = spanStart;
    while (changeIndex < changeTimes.length &&
           changeTimes[changeIndex] - earliestTime < spanEnd) {
      const changeTime = changeTimes[changeIndex] - earliestTime;
      if (changeTime > at) {
        busyMs += runningNow * (changeTime - at);
        at = changeTime;
      }
      runningNow = runningAt.get(changeTimes[changeIndex]);
      changeIndex++;
    }
    busyMs += runningNow * (spanEnd - at);
    samples.threadCPUDelta.push(Math.round(1000 * busyMs / peakRunning));
  }
  // The stretch after the last sample would carry no CPU, so close it off with a
  // zero-weight sample at the window end. It repeats the previous stack rather
  // than using the idle one, because it carries that final span's occupancy and
  // the Idle category draws transparent — an idle stack would erase the tail.
  if (samples.length && samples.time[samples.length - 1] < windowEnd) {
    let busyMs = 0, at = samples.time[samples.length - 1];
    while (changeIndex < changeTimes.length &&
           changeTimes[changeIndex] - earliestTime < windowEnd) {
      const changeTime = changeTimes[changeIndex] - earliestTime;
      if (changeTime > at) {
        busyMs += runningNow * (changeTime - at);
        at = changeTime;
      }
      runningNow = runningAt.get(changeTimes[changeIndex]);
      changeIndex++;
    }
    busyMs += runningNow * (windowEnd - at);
    samples.stack.push(samples.stack[samples.length - 1]);
    samples.time.push(windowEnd);
    samples.weight.push(0);
    samples.threadCPUDelta.push(Math.round(1000 * busyMs / peakRunning));
    samples.length++;
  }

  return { samples, stackTable, frameTable, funcTable };
}

function generateProfile(tasks, threadName, timeSeries, globalTimeStart, globalTimeEnd, treeClosures = []) {
  const stringArray = ['(root)'];
  const stringIndexMap = new Map([['(root)', 0]]);
  function getStringIndex(str) {
    if (!str) str = '';
    if (stringIndexMap.has(str)) return stringIndexMap.get(str);
    const idx = stringArray.length;
    stringArray.push(str);
    stringIndexMap.set(str, idx);
    return idx;
  }

  // Use the fixed 24h window
  const earliestTime = globalTimeStart;
  const latestTime = globalTimeEnd;

  // Which repositories run at each priority, by run time, so the graph's bands
  // can be labelled with the trees behind them. Priority is close to a proxy for
  // repository — autoland runs at "low", try at "very-low", mozilla-release at
  // "highest" — but that mapping is not something a reader should have to know.
  const runTimeByPriorityRepository = new Map(); // priority key -> repository -> ms
  for (const t of tasks) {
    if (!t._startedMs) continue;
    if (t._resolvedMs < earliestTime || t._startedMs > latestTime) continue;
    const priorityKey = PRIORITY_KEYS[t.priority] || 'medium';
    const busy = Math.max(0,
      Math.min(t._resolvedMs, latestTime) - Math.max(t._startedMs, earliestTime));
    let byRepository = runTimeByPriorityRepository.get(priorityKey);
    if (!byRepository) runTimeByPriorityRepository.set(priorityKey, byRepository = new Map());
    const name = t.project || 'unknown';
    byRepository.set(name, (byRepository.get(name) || 0) + busy);
  }

  // Name each band with the trees running in it, busiest first, so the graph
  // explains itself: "why is there a red block at the top" is answered by the
  // band reading "highest — mozilla-release, comm-release" rather than just
  // "highest". Every repository is accounted for in some band, so nothing is
  // hidden the way a top-N list of repositories would hide the release branches.
  const priorityGroups = PRIORITIES.map(p => {
    const names = [...(runTimeByPriorityRepository.get(p.key) || new Map())]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    const shown = names.slice(0, 4).join(', ');
    return {
      ...p,
      name: !names.length ? p.name
        : p.name + ' — ' + (names.length > 4 ? shown + ' +' + (names.length - 4) : shown),
    };
  });

  const markerSchema = [
    {
      name: 'Task',
      tooltipLabel: '{marker.data.label}',
      tableLabel: '{marker.data.state} \u2014 {marker.data.label} \u2014 {marker.data.id}',
      chartLabel: '{marker.data.label}',
      display: ['marker-chart', 'marker-table'],
      colorField: 'color',
      fields: [
        { key: 'id', label: 'Task ID', format: 'unique-string' },
        { key: 'run', label: 'Run ID', format: 'integer' },
        { key: 'label', label: 'Label', format: 'unique-string' },
        { key: 'aggregate', label: 'Aggregate', format: 'string' },
        { key: 'priority', label: 'Priority', format: 'unique-string' },
        { key: 'state', label: 'State', format: 'unique-string' },
        { key: 'reason', label: 'Reason Resolved', format: 'unique-string' },
        { key: 'group', label: 'Task Group ID', format: 'unique-string' },
        { key: 'proj', label: 'Project', format: 'unique-string' },
        { key: 'user', label: 'User', format: 'unique-string' },
        { key: 'wgrp', label: 'Worker Group', format: 'unique-string' },
        { key: 'wid', label: 'Worker ID', format: 'unique-string' },
        { key: 'qtime', label: 'Queue Time', format: 'duration' },
        { key: 'rtime', label: 'Run Time', format: 'duration' },
        { key: 'cost', label: 'Run Cost', format: 'decimal' },
        { key: 'color', format: 'string', hidden: true },
      ]
    },
    {
      name: 'TaskCount',
      tooltipLabel: '{marker.name}',
      display: [],
      fields: [
        { key: 'total', label: 'Total Tasks', format: 'integer' },
        { key: 'running', label: 'Running Tasks', format: 'integer' },
        { key: 'queued', label: 'Queued Tasks', format: 'integer' },
        { key: 'expired', label: 'Queued Until Expiration', format: 'integer' },
      ],
      graphs: [
        // Drawn back-to-front: purple (total), grey (total-expired), blue (running)
        // Visible bands: blue at bottom, grey in middle, purple at top
        { key: 'total', color: 'purple', type: 'bar' },
        { key: 'nonExpired', color: 'grey', type: 'bar' },
        { key: 'running', color: 'blue', type: 'bar' },
      ]
    },
    ...[
      { type: 'RunningByPriority', groups: priorityGroups },
    ].map(({ type, groups }) => ({
      name: type,
      tooltipLabel: '{marker.name}',
      display: [],
      // The tooltip lists the plain per-group counts, which is what a reader
      // wants to know. The cumulative keys exist only to stack the bars and are
      // hidden, like TaskCount's nonExpired above.
      fields: [
        ...groups.map(g => (
          { key: g.key, label: g.name, format: 'integer' }
        )),
        ...groups.map(g => (
          { key: g.cumulativeKey, format: 'integer', hidden: true }
        )),
      ],
      // Each cumulative key holds the tasks running in that group plus every
      // group before it. Bars are drawn back to front, so the biggest total goes
      // first and each later bar paints over the lower part of the previous one,
      // leaving one visible band per group — first group at the bottom.
      graphs: groups.slice().reverse().map(g => (
        { key: g.cumulativeKey, color: g.color, type: 'bar' }
      )),
    })),
    {
      name: 'TreeClosure',
      tooltipLabel: 'Tree closed',
      chartLabel: '{marker.data.reason}',
      tableLabel: 'Tree closed \u2014 {marker.data.reason}',
      display: ['marker-chart', 'marker-table', 'timeline-overview'],
      fields: [
        { key: 'reason', label: 'Reason', format: 'string' },
        { key: 'who', label: 'Who', format: 'string' },
        { key: 'duration', label: 'Duration', format: 'duration' },
      ]
    }
  ];

  function createMarkers(taskList) {
    const markers = {
      data: [], name: [], startTime: [], endTime: [],
      phase: [], category: [], length: 0
    };

    // TaskCount markers — reuse the already-sorted timeSeries from the dashboard.
    // The name is what the tooltip shows, so it reads as prose rather than as the
    // schema's type key.
    const countNameIdx = getStringIndex('Task count');
    for (let i = 0; i < timeSeries.length; i++) {
      const m = timeSeries[i];
      if (m.time < earliestTime) continue;
      const next = timeSeries[i + 1];
      markers.name.push(countNameIdx);
      markers.startTime.push(m.time - earliestTime);
      markers.endTime.push(next ? next.time - earliestTime : latestTime - earliestTime);
      markers.phase.push(1);
      markers.category.push(0);
      const queued = m.total - m.running;
      markers.data.push({ type: 'TaskCount', total: m.total, running: m.running, queued, expired: m.expired, nonExpired: m.total - m.expired });
      markers.length++;
    }

    // A step function of how many tasks are running, split into one band per
    // group — used for the by-priority and by-repository graphs.
    //
    // Changes are bucketed to the second. Across all pools there are hundreds of
    // thousands of start/stop events a day, far more than a 24h graph can show,
    // and every one of them would otherwise be a marker carrying a value per
    // band — which on its own outweighed the rest of the profile.
    const bucketMs = 1000;
    function addRunningByGroup(type, displayName, groups, groupOf) {
      const changes = new Map(); // bucketed time -> { key: delta }
      for (const t of taskList) {
        if (!t._startedMs) continue;
        if (t._resolvedMs < earliestTime || t._startedMs > latestTime) continue;
        const key = groupOf(t);
        if (!key) continue;
        for (const [time, delta] of [[t._startedMs, 1], [t._resolvedMs, -1]]) {
          const clamped = Math.min(Math.max(time, earliestTime), latestTime);
          const bucket = Math.floor((clamped - earliestTime) / bucketMs) * bucketMs + earliestTime;
          let deltas = changes.get(bucket);
          if (!deltas) changes.set(bucket, deltas = {});
          deltas[key] = (deltas[key] || 0) + delta;
        }
      }
      if (!changes.size) return;

      const nameIdx = getStringIndex(displayName);
      const times = [...changes.keys()].sort((a, b) => a - b);
      const counts = {};
      for (const g of groups) counts[g.key] = 0;

      for (let i = 0; i < times.length; i++) {
        const deltas = changes.get(times[i]);
        for (const key in deltas) counts[key] += deltas[key];

        // Cumulative from the first group down, so the bars stack into one band
        // per group rather than hiding each other. The plain counts come along
        // for the tooltip, but only when non-zero: at any given moment most
        // bands are empty, and there are enough of these markers that carrying
        // every zero doubles the size of the profile.
        const d = { type };
        let cumulative = 0;
        for (const g of groups) {
          if (counts[g.key]) d[g.key] = counts[g.key];
          cumulative += counts[g.key];
          d[g.cumulativeKey] = cumulative;
        }

        markers.name.push(nameIdx);
        markers.startTime.push(times[i] - earliestTime);
        markers.endTime.push((times[i + 1] ?? latestTime) - earliestTime);
        markers.phase.push(1);
        markers.category.push(0);
        markers.data.push(d);
        markers.length++;
      }
    }

    addRunningByGroup('RunningByPriority', 'Running by priority', priorityGroups,
      t => PRIORITY_KEYS[t.priority] || 'medium');

    // TreeClosure markers
    if (treeClosures.length) {
      const closureNameIdx = getStringIndex('Closed tree');
      for (const c of treeClosures) {
        if (c.end < earliestTime || c.start > latestTime) continue;
        markers.name.push(closureNameIdx);
        markers.startTime.push(Math.max(0, c.start - earliestTime));
        markers.endTime.push(Math.min(latestTime - earliestTime, c.end - earliestTime));
        markers.phase.push(1);
        markers.category.push(0);
        markers.data.push({
          type: 'TreeClosure',
          reason: c.reason || '(no reason)',
          who: c.who,
          duration: c.end - c.start,
        });
        markers.length++;
      }
    }

    // Task markers — skip tasks entirely outside the 24h window
    const taskNameIdx = getStringIndex('Task');
    for (const t of taskList) {
      // Determine the visible range of this task
      let markerStart, markerEnd;
      if (t._startedMs) {
        markerStart = t._startedMs;
        markerEnd = t._resolvedMs;
      } else if (t._expired) {
        markerStart = t._scheduledMs;
        markerEnd = t._resolvedMs;
      } else {
        markerStart = t._resolvedMs;
        markerEnd = t._resolvedMs;
      }
      // Skip if entirely outside the 24h window
      if (markerEnd < earliestTime || markerStart > latestTime) continue;

      const d = { type: 'Task' };
      d.id = getStringIndex(t.task_id);
      d.run = parseInt(t.run_id) || 0;
      d.label = getStringIndex(t.label || 'unknown');
      if (t.aggregate) d.aggregate = t.aggregate;
      if (t.priority) d.priority = getStringIndex(t.priority);
      d.state = getStringIndex(t.state);
      if (t.reason_resolved && t.reason_resolved !== t.state)
        d.reason = getStringIndex(t.reason_resolved);
      if (t.task_group_id) d.group = getStringIndex(t.task_group_id);
      if (t.project) d.proj = getStringIndex(t.project);
      if (t.created_for_user) d.user = getStringIndex(t.created_for_user);
      if (t.worker_group) d.wgrp = getStringIndex(t.worker_group);
      if (t.worker_id) d.wid = getStringIndex(t.worker_id);
      if (t.run_cost) d.cost = parseFloat(t.run_cost);

      if (t.state === 'completed') d.color = 'green';
      else if (t.state === 'failed') d.color = 'red';
      else if (t.state === 'exception' && (t.reason_resolved === 'canceled' || t.reason_resolved === 'deadline-exceeded')) d.color = 'purple';

      if (t._startedMs) {
        d.qtime = t._startedMs - t._scheduledMs;
        d.rtime = t._resolvedMs - t._startedMs;
      } else if (t._expired) {
        d.qtime = t._resolvedMs - t._scheduledMs;
      }

      markers.name.push(taskNameIdx);
      if (t._startedMs) {
        markers.startTime.push(t._startedMs - earliestTime);
        markers.endTime.push(t._resolvedMs - earliestTime);
        markers.phase.push(1);
      } else if (t._expired) {
        markers.startTime.push(t._scheduledMs - earliestTime);
        markers.endTime.push(t._resolvedMs - earliestTime);
        markers.phase.push(1);
      } else {
        markers.startTime.push(t._resolvedMs - earliestTime);
        markers.endTime.push(null);
        markers.phase.push(0);
      }
      markers.category.push(0);
      markers.data.push(d);
      markers.length++;
    }

    return markers;
  }

  function makeThread(name, pid, tid, taskList) {
    const stacks = createStacks(taskList, getStringIndex, earliestTime, latestTime);

    return {
      processType: 'default',
      processName: name,
      processStartupTime: 0,
      processShutdownTime: null,
      registerTime: 0,
      unregisterTime: null,
      pausedRanges: [],
      showMarkersInTimeline: true,
      name,
      isMainThread: false,
      pid: String(pid),
      tid,
      samples: stacks.samples,
      markers: createMarkers(taskList),
      stackTable: stacks.stackTable,
      frameTable: stacks.frameTable,
      funcTable: stacks.funcTable,
      resourceTable: { lib: [], name: [], host: [], type: [], length: 0 },
      nativeSymbols: { libIndex: [], address: [], name: [], functionSize: [], length: 0 },
    };
  }

  const threads = [makeThread(threadName || 'All Tasks', '0', 0, tasks)];

  return {
    meta: {
      processType: 0,
      product: 'Taskcluster tasks',
      stackwalk: 0,
      version: 32,
      preprocessedProfileVersion: 56,
      symbolicationNotSupported: true,
      interval: 1,
      startTime: earliestTime,
      profilingStartTime: 0,
      profilingEndTime: latestTime - earliestTime,
      // One category per call tree level, so "Focus category" in the call tree
      // context menu collapses the tree down to a single level. The structural
      // levels are all grey and only the outcomes are colored, so that the
      // colors in the flame graph match the ones in the activity graph, which
      // colors each sample by the category of its leaf frame — always an
      // outcome here. Keep these in sync with CATEGORY_* above.
      categories: [
        { name: 'Other', color: 'grey', subcategories: ['Other'] },
        { name: 'Worker pool', color: 'grey', subcategories: ['Other'] },
        { name: 'Repository', color: 'grey', subcategories: ['Other'] },
        { name: 'Build type', color: 'grey', subcategories: ['Other'] },
        { name: 'Test suite', color: 'grey', subcategories: ['Other'] },
        { name: 'Variant', color: 'grey', subcategories: ['Other'] },
        { name: 'Test', color: 'grey', subcategories: ['Other'] },
        { name: 'Passed', color: 'green', subcategories: ['Other'] },
        { name: 'Failed', color: 'orange', subcategories: ['Other'] },
        { name: 'Retried', color: 'blue', subcategories: ['Other'] },
        { name: 'Canceled', color: 'purple', subcategories: ['Other'] },
        { name: 'Idle', color: 'transparent', subcategories: ['Other'] },
      ],
      // threadCPUDelta is not a real CPU measurement here: it carries the
      // average number of jobs running over each sample's span, scaled so that
      // the pool's busiest moment reads as 100%. Microseconds are used because
      // that unit gives a fixed conversion factor (1000 per ms) — the
      // "variable CPU cycles" unit would instead normalize against the largest
      // observed value, which two jobs starting a millisecond apart can spike.
      sampleUnits: {
        time: 'ms',
        eventDelay: 'ms',
        threadCPUDelta: 'µs',
      },
      markerSchema,
      usesOnlyOneStackType: true,
    },
    libs: [],
    threads,
    counters: [],
    shared: { stringArray },
  };
}

// ==================== Profiler Integration ====================

async function openTaskTimelineInProfiler(tasks, name, timeSeries, start, end, closures = [], markerSearch = '') {
  const origin = new URL(getProfilerOrigin()).origin;
  const url = new URL(markerSearch ? '/from-post-message/marker-chart/' : '/from-post-message/', origin);
  if (markerSearch) {
    url.searchParams.set('markerSearch', markerSearch);
    url.searchParams.set('thread', '0');
  }
  const profilerWindow = window.open(url.href, '_blank');
  if (!profilerWindow) throw new Error('Popup blocked — please allow popups for this site.');
  const profile = generateProfile(tasks, name, timeSeries, start, end, closures);
  await new Promise((resolve, reject) => {
    let poll;
    let timeout;
    function cleanup() {
      clearInterval(poll);
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
    }
    function onMessage(event) {
      if (event.source !== profilerWindow || event.origin !== origin || event.data?.name !== 'ready:response') return;
      cleanup();
      profilerWindow.postMessage({ name: 'inject-profile', profile }, origin);
      resolve();
    }
    window.addEventListener('message', onMessage);
    poll = setInterval(() => {
      if (profilerWindow.closed) {
        cleanup();
        reject(new Error('Profiler window closed before loading.'));
      } else {
        profilerWindow.postMessage({ name: 'ready:request' }, origin);
      }
    }, 100);
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Profiler did not respond. Please try again.'));
    }, 60000);
  });
}
