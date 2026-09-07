#!/usr/bin/env node

// cli/errors.ts
var ExitCode = {
  /** Success. */
  Success: 0,
  /** Usage error: bad flag, missing argument, `--json` with `--markdown`. */
  Usage: 1,
  /** Not found: no such test, no data for that revision, no such minidump. */
  NotFound: 2,
  /**
   * Upstream **temporarily** unavailable — index unreachable, 5xx, network
   * failure. Retrying may work.
   */
  Upstream: 3,
  /**
   * Data **permanently** gone — an expired Taskcluster artifact. Retrying
   * will not help.
   */
  Gone: 4
};
var CliError = class extends Error {
  exitCode;
  /** An optional second paragraph: the suggested next step. */
  hint;
  constructor(exitCode2, message, hint) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode2;
    this.hint = hint;
  }
};
function usageError(message, hint) {
  return new CliError(ExitCode.Usage, message, hint);
}
function notFoundError(message, hint) {
  return new CliError(ExitCode.NotFound, message, hint);
}
function upstreamError(message, hint) {
  return new CliError(ExitCode.Upstream, message, hint);
}
function goneError(message, hint) {
  return new CliError(ExitCode.Gone, message, hint);
}

// cli/args.ts
function parseArgs(argv, specs) {
  const positionals = [];
  const options = /* @__PURE__ */ new Map();
  let optionsEnded = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (optionsEnded || !arg.startsWith("--")) {
      if (!optionsEnded && arg.startsWith("-") && arg.length > 1) {
        throw usageError(
          `unknown option ${arg}`,
          "All options are long form, e.g. --config. Run --help for the list."
        );
      }
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      optionsEnded = true;
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    const inlineValue = equals === -1 ? null : arg.slice(equals + 1);
    const spec = specs[name];
    if (spec === void 0) {
      throw usageError(
        `unknown option --${name}`,
        suggestOption(name, specs) ?? "Run --help for the list of options."
      );
    }
    if (spec.type === "boolean") {
      if (inlineValue !== null) {
        throw usageError(
          `--${name} takes no value, but got --${name}=${inlineValue}`
        );
      }
      options.set(name, true);
      continue;
    }
    let value;
    if (inlineValue !== null) {
      value = inlineValue;
    } else {
      const next = argv[i + 1];
      if (next === void 0 || next.startsWith("--") && next !== "--") {
        throw usageError(`--${name} requires a value`);
      }
      value = next;
      i++;
    }
    if (spec.type === "number") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw usageError(
          `--${name} expects a non-negative integer, got "${value}"`
        );
      }
      options.set(name, parsed);
    } else if (spec.type === "list") {
      const previous = options.get(name) ?? [];
      const items = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
      options.set(name, [...previous, ...items]);
    } else {
      options.set(name, value);
    }
  }
  return { positionals, options };
}
function suggestOption(name, specs) {
  let best = null;
  let bestDistance = 3;
  for (const candidate of Object.keys(specs)) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best === null ? null : `Did you mean --${best}?`;
}
function editDistance(a, b) {
  if (a === b) {
    return 0;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }
    previous = current;
  }
  return previous[b.length];
}
function boolOption(args, name) {
  return args.options.get(name) === true;
}
function stringOption(args, name) {
  const value = args.options.get(name);
  return typeof value === "string" ? value : void 0;
}
function numberOption(args, name) {
  const value = args.options.get(name);
  return typeof value === "number" ? value : void 0;
}
function listOption(args, name) {
  const value = args.options.get(name);
  return Array.isArray(value) ? value : [];
}

// lib/model/harness.ts
function detectHarness(testPath) {
  const fileName = testPath.split("/").pop() ?? testPath;
  if (fileName.startsWith("browser_") && fileName.endsWith(".js")) {
    return "mochitest";
  }
  if (fileName.startsWith("test_") && fileName.endsWith(".html")) {
    return "mochitest";
  }
  return "xpcshell";
}
function otherHarness(harness) {
  return harness === "xpcshell" ? "mochitest" : "xpcshell";
}

// cli/options.ts
function isAgentCaller(env) {
  const set = (value) => value !== void 0 && value !== "" && value !== "0";
  return set(env.CLAUDECODE) || set(env.CODEX_SANDBOX) || set(env.GEMINI_CLI) || set(env.OPENCODE);
}
var GLOBAL_OPTION_SPECS = {
  harness: {
    type: "string",
    placeholder: "<xpcshell|mochitest>",
    describe: "Which harness\u2019s data to read. Inferred from the test path by default."
  },
  json: { type: "boolean", describe: "Emit JSON instead of text." },
  markdown: { type: "boolean", describe: "Emit Markdown, for pasting into a bug or PR." },
  limit: { type: "number", placeholder: "<n>", describe: "Max rows. 0 means no limit." },
  config: {
    type: "list",
    placeholder: "<list>",
    describe: "Comma-separated job-name substrings to include."
  },
  "exclude-config": {
    type: "list",
    placeholder: "<list>",
    describe: "Comma-separated substrings to exclude, applied after --config."
  },
  day: {
    type: "string",
    placeholder: "<date>",
    describe: "Restrict to one day (YYYY-MM-DD, today, yesterday)."
  },
  since: {
    type: "number",
    placeholder: "<n>",
    describe: "Restrict to the last n days of the window."
  },
  "data-source": {
    type: "string",
    placeholder: "<central|try|local>",
    describe: "Where to read data from. Default central."
  },
  "cache-dir": {
    type: "string",
    placeholder: "<path>",
    describe: "On-disk cache directory. Default ~/.cache/fx-tests."
  },
  "no-cache": { type: "boolean", describe: "Ignore and do not write the cache." },
  quiet: { type: "boolean", describe: "Suppress progress output on stderr." },
  progress: {
    type: "boolean",
    describe: "Write progress to stderr even when a coding agent is the caller (off by default there). --quiet wins over this."
  },
  "full-messages": {
    type: "boolean",
    describe: "Do not cut messages or paths to the terminal width. Implied by --markdown."
  },
  help: { type: "boolean", describe: "Show this help." }
};
function readGlobalOptions(args, env = {}, extraHarnessValues = []) {
  const wantsJson = boolOption(args, "json");
  const wantsMarkdown = boolOption(args, "markdown");
  if (wantsJson && wantsMarkdown) {
    throw usageError(
      "--json and --markdown are mutually exclusive",
      "Pick one: --json for a stable machine-readable shape, --markdown for pasting into a bug."
    );
  }
  const harnessValue = stringOption(args, "harness");
  const allowed = ["xpcshell", "mochitest", ...extraHarnessValues];
  if (harnessValue !== void 0 && !allowed.includes(harnessValue)) {
    throw usageError(
      `--harness expects ${allowed.slice(0, -1).join(", ")} or ${allowed[allowed.length - 1]}, got "${harnessValue}"`
    );
  }
  const day = stringOption(args, "day");
  const since = numberOption(args, "since");
  if (day !== void 0 && since !== void 0) {
    throw usageError(
      "--day and --since are mutually exclusive",
      "--day restricts to one day; --since restricts to the last n days."
    );
  }
  if (since !== void 0 && since < 1) {
    throw usageError(`--since expects at least 1 day, got ${since}`);
  }
  const dataSourceValue = stringOption(args, "data-source") ?? "central";
  if (dataSourceValue !== "central" && dataSourceValue !== "try" && dataSourceValue !== "local") {
    throw usageError(
      `--data-source expects central, try or local, got "${dataSourceValue}"`
    );
  }
  return {
    format: wantsJson ? "json" : wantsMarkdown ? "markdown" : "text",
    // Narrow on purpose: a widened value is not a harness any other
    // command understands, so it stays out of the shared field and the
    // command reads it from the raw argument.
    harness: harnessValue === "xpcshell" || harnessValue === "mochitest" ? harnessValue : void 0,
    limit: numberOption(args, "limit"),
    config: listOption(args, "config"),
    excludeConfig: listOption(args, "exclude-config"),
    day,
    since,
    dataSource: dataSourceValue,
    cacheDir: stringOption(args, "cache-dir"),
    noCache: boolOption(args, "no-cache"),
    quiet: boolOption(args, "quiet"),
    progress: boolOption(args, "progress"),
    agent: isAgentCaller(env),
    fullMessages: boolOption(args, "full-messages")
  };
}
function resolveHarness(testPath, explicit) {
  if (explicit !== void 0) {
    return { harness: explicit, inferred: false };
  }
  return { harness: detectHarness(testPath), inferred: true };
}

// cli/cache.ts
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";

// lib/sources/source.ts
var DataFileNotFoundError = class extends Error {
  name2;
  url;
  constructor(name, url) {
    super(
      `no such data file: ${name.filename} in index ${name.index}` + (url === void 0 ? "" : ` (${url})`)
    );
    this.name = "DataFileNotFoundError";
    this.name2 = name;
    this.url = url;
  }
};
var DataFetchError = class extends Error {
  name2;
  url;
  /** The HTTP status, when there was one. Absent for a transport failure. */
  status;
  constructor(name, message, url, status) {
    super(`failed to fetch ${name.filename} from index ${name.index}: ${message}`);
    this.name = "DataFetchError";
    this.name2 = name;
    this.url = url;
    this.status = status;
  }
};
async function fetchJson(source, name) {
  const bytes2 = await source.fetch(name);
  const text = new TextDecoder().decode(bytes2);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DataFetchError(
      name,
      `response is not valid JSON: ${error.message}`
    );
  }
}
function timingsIndex(harness) {
  return `${harness}-timings`;
}
var MANIFEST_TIMINGS_INDEX = "manifest-timings";
function dataFileKey(name) {
  return `${name.index}/${name.filename}`;
}

// cli/cache.ts
var AGGREGATE_KIND = "aggregate";
var TASK_ARTIFACT_KIND = "task-artifact";
var PUSH_JOBS_KIND = "push-jobs";
var QUERY_KIND = "query";
function isImmutableKind(kind) {
  return kind === TASK_ARTIFACT_KIND;
}
function defaultCacheDir() {
  const xdg = process.env["XDG_CACHE_HOME"];
  if (xdg !== void 0 && xdg.length > 0) {
    return join(xdg, "fx-tests");
  }
  return join(homedir(), ".cache", "fx-tests");
}
var DEFAULT_TTL_MS = 12 * 60 * 60 * 1e3;
var DEFAULT_ARTIFACT_BUDGET_BYTES = 4 * 1024 * 1024 * 1024;
function cacheHash(name) {
  return createHash("sha256").update(dataFileKey(name)).digest("hex").slice(0, 32);
}
function urlCacheHash(url) {
  return createHash("sha256").update(`url:${url}`).digest("hex").slice(0, 32);
}
function diskCache(options = {}) {
  const directory = options.directory ?? defaultCacheDir();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const artifactBudgetBytes = options.artifactBudgetBytes ?? DEFAULT_ARTIFACT_BUDGET_BYTES;
  const now = options.now ?? Date.now;
  const dataPath = (hash) => join(directory, `${hash}.json`);
  const metaPath = (hash) => join(directory, `${hash}.meta.json`);
  async function readMeta(hash) {
    try {
      const text = await readFile(metaPath(hash), "utf8");
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  async function readBytes(hash) {
    try {
      return new Uint8Array(await readFile(dataPath(hash)));
    } catch {
      return null;
    }
  }
  async function writeEntry(hash, bytes2, meta) {
    await mkdir(directory, { recursive: true });
    await writeFile(dataPath(hash), bytes2);
    await writeFile(metaPath(hash), JSON.stringify(meta, null, 2));
  }
  const self = {
    directory,
    async get(name) {
      const hash = cacheHash(name);
      const meta = await readMeta(hash);
      if (meta === null) {
        return null;
      }
      const age = now() - Date.parse(meta.fetchedAt);
      if (!Number.isFinite(age) || age < 0 || age > ttlMs) {
        return null;
      }
      return readBytes(hash);
    },
    async put(name, bytes2, url) {
      const meta = {
        key: dataFileKey(name),
        kind: AGGREGATE_KIND,
        fetchedAt: new Date(now()).toISOString(),
        bytes: bytes2.byteLength
      };
      if (url !== void 0) {
        meta.url = url;
      }
      const generatedAt = readGeneratedAt(bytes2);
      if (generatedAt !== null) {
        meta.generatedAt = generatedAt;
      }
      await writeEntry(cacheHash(name), bytes2, meta);
    },
    async getArtifact(url) {
      const hash = urlCacheHash(url);
      const meta = await readMeta(hash);
      if (meta === null || !isImmutableKind(meta.kind)) {
        return null;
      }
      return readBytes(hash);
    },
    async putArtifact(url, bytes2) {
      await writeEntry(urlCacheHash(url), bytes2, {
        // The URL is the key, so it is also what `fx-tests cache`
        // lists: there is no shorter name that identifies the entry.
        key: url,
        kind: TASK_ARTIFACT_KIND,
        url,
        fetchedAt: new Date(now()).toISOString(),
        bytes: bytes2.byteLength
      });
    },
    async getPushJobs(key) {
      const hash = urlCacheHash(key);
      const meta = await readMeta(hash);
      if (meta === null || meta.kind !== PUSH_JOBS_KIND) {
        return null;
      }
      const age = now() - Date.parse(meta.fetchedAt);
      if (!Number.isFinite(age) || age < 0 || age > SETTLED_PUSH_TTL_MS) {
        return null;
      }
      return readBytes(hash);
    },
    async putPushJobs(key, bytes2) {
      await writeEntry(urlCacheHash(key), bytes2, {
        key,
        kind: PUSH_JOBS_KIND,
        fetchedAt: new Date(now()).toISOString(),
        bytes: bytes2.byteLength
      });
    },
    async getQuery(url) {
      const hash = urlCacheHash(url);
      const meta = await readMeta(hash);
      if (meta === null || meta.kind !== QUERY_KIND) {
        return null;
      }
      const age = now() - Date.parse(meta.fetchedAt);
      if (!Number.isFinite(age) || age < 0 || age > QUERY_TTL_MS) {
        return null;
      }
      return readBytes(hash);
    },
    async putQuery(url, bytes2) {
      await writeEntry(urlCacheHash(url), bytes2, {
        key: url,
        kind: QUERY_KIND,
        url,
        fetchedAt: new Date(now()).toISOString(),
        bytes: bytes2.byteLength
      });
    },
    async pruneTaskArtifacts() {
      const artifacts = (await self.list()).filter(
        (entry) => isImmutableKind(entry.kind)
      );
      let total = artifacts.reduce((sum, entry) => sum + entry.bytes, 0);
      if (total <= artifactBudgetBytes) {
        return 0;
      }
      artifacts.sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt));
      let removed = 0;
      for (const entry of artifacts) {
        if (total <= artifactBudgetBytes) {
          break;
        }
        await rm(dataPath(entry.hash), { force: true });
        await rm(metaPath(entry.hash), { force: true });
        total -= entry.bytes;
        removed++;
      }
      return removed;
    },
    async list() {
      let names;
      try {
        names = await readdir(directory);
      } catch {
        return [];
      }
      const entries = [];
      for (const fileName of names) {
        if (!fileName.endsWith(".meta.json")) {
          continue;
        }
        const hash = fileName.slice(0, -".meta.json".length);
        const meta = await readMeta(hash);
        if (meta !== null) {
          entries.push({ ...meta, hash });
        }
      }
      entries.sort((a, b) => a.key.localeCompare(b.key));
      return entries;
    },
    async clear() {
      let names;
      try {
        names = await readdir(directory);
      } catch {
        return 0;
      }
      let removed = 0;
      for (const fileName of names) {
        if (fileName.endsWith(".meta.json")) {
          removed++;
        }
        await rm(join(directory, fileName), { force: true });
      }
      return removed;
    }
  };
  return self;
}
function readGeneratedAt(bytes2) {
  const head = new TextDecoder().decode(bytes2.subarray(0, 4096));
  const match = /"generatedAt"\s*:\s*"([^"]+)"/.exec(head);
  return match?.[1] ?? null;
}
function cachedSource(inner, cache, hooks = {}) {
  return {
    name: inner.name,
    async fetch(name) {
      const cached = await cache.get(name);
      if (cached !== null) {
        hooks.onHit?.(name);
        return cached;
      }
      hooks.onMiss?.(name);
      const bytes2 = await inner.fetch(name);
      try {
        await cache.put(name, bytes2);
      } catch (error) {
        hooks.onWarning?.(describeCacheWriteFailure(cache.directory, error));
      }
      return bytes2;
    }
  };
}
function cachedArtifactFetcher(inner, cache, hooks = {}) {
  return async (url) => {
    const cached = await cache.getArtifact(url);
    if (cached !== null) {
      hooks.onHit?.(url);
      return cached;
    }
    hooks.onMiss?.(url);
    const bytes2 = await inner(url);
    if (bytes2 === null) {
      return null;
    }
    try {
      await cache.putArtifact(url, bytes2);
    } catch (error) {
      hooks.onWarning?.(describeCacheWriteFailure(cache.directory, error));
    }
    return bytes2;
  };
}
function cachedTaskArtifactSource(inner, cache, keyOf, hooks = {}) {
  return {
    name: inner.name,
    async fetch(name) {
      const key = keyOf(name);
      const cached = await cache.getArtifact(key);
      if (cached !== null) {
        return cached;
      }
      const bytes2 = await inner.fetch(name);
      try {
        await cache.putArtifact(key, bytes2);
      } catch (error) {
        hooks.onWarning?.(describeCacheWriteFailure(cache.directory, error));
      }
      return bytes2;
    }
  };
}
function cachedTreeherderJobs(inner, cache, hooks = {}) {
  return {
    ...inner,
    async jobsOfPush(pushId) {
      const key = `treeherder:jobs:${pushId}`;
      const cached = await cache.getPushJobs(key);
      if (cached !== null) {
        try {
          return JSON.parse(new TextDecoder().decode(cached));
        } catch {
        }
      }
      const jobs = await inner.jobsOfPush(pushId);
      if (!isSettledPush(jobs)) {
        return jobs;
      }
      try {
        await cache.putPushJobs(key, new TextEncoder().encode(JSON.stringify(jobs)));
      } catch (error) {
        hooks.onWarning?.(describeCacheWriteFailure(cache.directory, error));
      }
      return jobs;
    }
  };
}
var TERMINAL_JOB_STATES = /* @__PURE__ */ new Set(["completed"]);
function isSettledPush(jobs) {
  return jobs.length > 0 && jobs.every((job) => TERMINAL_JOB_STATES.has(job.state));
}
var SETTLED_PUSH_TTL_MS = 24 * 60 * 60 * 1e3;
var QUERY_TTL_MS = 60 * 60 * 1e3;
function cachedIntermittents(inner, cache, hooks = {}) {
  async function through(key, compute) {
    const cached = await cache.getQuery(key);
    if (cached !== null) {
      try {
        return JSON.parse(new TextDecoder().decode(cached));
      } catch {
      }
    }
    const value = await compute();
    try {
      await cache.putQuery(key, new TextEncoder().encode(JSON.stringify(value)));
    } catch (error) {
      hooks.onWarning?.(describeCacheWriteFailure(cache.directory, error));
    }
    return value;
  }
  return {
    ...inner,
    rankBugs(tree, range) {
      return through(
        `intermittents:failures:${tree}:${range.start}:${range.end}`,
        () => inner.rankBugs(tree, range)
      );
    },
    occurrencesOfBug(tree, range, bug) {
      return through(
        `intermittents:failuresbybug:${tree}:${range.start}:${range.end}:${bug}`,
        () => inner.occurrencesOfBug(tree, range, bug)
      );
    },
    async runIdsOfJobs(jobIds) {
      const key = `intermittents:runids:${[...jobIds].sort((a, b) => a - b).join(",")}`;
      const entries = await through(key, async () => [...await inner.runIdsOfJobs(jobIds)]);
      return new Map(entries);
    },
    async bugSummaries(bugs) {
      const key = `bugzilla:summaries:${[...bugs].sort((a, b) => a - b).join(",")}`;
      const entries = await through(key, async () => [
        ...await inner.bugSummaries(bugs)
      ]);
      return new Map(entries);
    }
  };
}
function describeCacheWriteFailure(directory, error) {
  const message = error?.message ?? String(error);
  const code2 = error?.code;
  const cause = code2 === "EACCES" || code2 === "EPERM" ? `no permission to write the cache directory ${directory}` : code2 === "ENOSPC" ? `no space left to write the cache directory ${directory}` : code2 === "EROFS" ? `the cache directory ${directory} is on a read-only filesystem` : `could not write the cache directory ${directory}`;
  return `${cause}. The results below are complete and correct \u2014 only caching was skipped, so this run and the next one re-download instead of reading from disk. Use --cache-dir <path> to cache somewhere writable, or --no-cache to stop trying. (${message})`;
}
async function cacheSize(cache) {
  let names;
  try {
    names = await readdir(cache.directory);
  } catch {
    return 0;
  }
  let total = 0;
  for (const fileName of names) {
    try {
      total += (await stat(join(cache.directory, fileName))).size;
    } catch {
    }
  }
  return total;
}

// cli/context.ts
function wantsProgress(globals) {
  if (globals.quiet) {
    return false;
  }
  return globals.progress || !globals.agent;
}
function progress(context, message) {
  if (wantsProgress(context.globals)) {
    context.streams.err(`${message}
`);
  }
}
function warn(context, message) {
  context.streams.err(`warning: ${message}
`);
}
function notice(context, message) {
  context.streams.err(`${message}
`);
}
function emit(context, text) {
  if (text.length === 0) {
    return;
  }
  context.streams.out(text.endsWith("\n") ? text : `${text}
`);
}

// cli/format/text.ts
var PATH_COLUMN_CAP = 128;
function pathColumnCap() {
  return widthScale === null ? Number.POSITIVE_INFINITY : PATH_COLUMN_CAP;
}
function table(columns, rows2, indent = "  ", options = {}) {
  return tableWithPaths(columns, rows2, indent, options).lines;
}
function tableWithPaths(columns, rows2, indent = "  ", options = {}) {
  if (rows2.length === 0) {
    return { lines: [], shortenedPaths: [] };
  }
  const shortened = [];
  const pathWidths = columns.map(
    (column, i) => column.path === true ? Math.min(
      pathColumnCap(),
      Math.max(0, ...rows2.map((row) => (row[i] ?? "").length))
    ) : void 0
  );
  const cells = rows2.map(
    (row) => row.map((cell, i) => {
      const column = columns[i];
      const max = column?.path === true ? pathWidths[i] : column?.maxWidth;
      if (max === void 0) {
        return cell;
      }
      if (column?.path !== true) {
        return truncate(cell, max);
      }
      const cut = truncatePath(cell, max);
      if (cut !== cell && !shortened.includes(cell)) {
        shortened.push(cell);
      }
      return cut;
    })
  );
  const headers = columns.map(headerLabel);
  const widths = fitToWidth(
    columns,
    columns.map(
      (_column, i) => Math.max(headers[i].length, ...cells.map((row) => (row[i] ?? "").length))
    ),
    indent.length,
    options.fit === true
  );
  for (const [r, row] of cells.entries()) {
    for (let i = 0; i < columns.length; i++) {
      const cell = row[i] ?? "";
      const width = widths[i];
      if (cell.length <= width) {
        continue;
      }
      if (columns[i]?.path === true) {
        row[i] = truncatePath(cell, width);
        const original = rows2[r][i] ?? "";
        if (!shortened.includes(original)) {
          shortened.push(original);
        }
        continue;
      }
      row[i] = truncateTo(cell, width);
    }
  }
  const line = (values) => {
    const parts = [];
    for (let i = 0; i < columns.length; i++) {
      const value = values[i] ?? "";
      const isLast = i === columns.length - 1;
      if (isLast) {
        parts.push(columns[i].align === "right" ? value.padStart(widths[i]) : value);
      } else {
        parts.push(
          columns[i].align === "right" ? value.padStart(widths[i]) : value.padEnd(widths[i])
        );
      }
    }
    return (indent + parts.join("  ")).trimEnd();
  };
  return { lines: [line(headers), ...cells.map(line)], shortenedPaths: shortened };
}
function fitToWidth(columns, measured, indentWidth, enabled) {
  const limit = renderWidth();
  const widths = [...measured];
  if (!enabled || limit === null) {
    return widths;
  }
  const shrinkable = columns.map((column, i) => column.maxWidth !== void 0 || column.path === true ? i : -1).filter((i) => i >= 0);
  if (shrinkable.length === 0) {
    return widths;
  }
  const overhead = indentWidth + Math.max(0, columns.length - 1) * 2;
  const total = () => widths.reduce((sum, width) => sum + width, overhead);
  while (total() > limit) {
    let widest = -1;
    for (const i of shrinkable) {
      if (widest === -1 || widths[i] > widths[widest]) {
        widest = i;
      }
    }
    if (widest === -1 || widths[widest] <= MIN_CELL_WIDTH) {
      break;
    }
    widths[widest]--;
  }
  return widths;
}
var MIN_CELL_WIDTH = 12;
function headerLabel(column) {
  if (column.sort === void 0) {
    return column.header;
  }
  return `${column.header} ${column.sort === "desc" ? "\u25BC" : "\u25B2"}`;
}
function labelledLines(rows2, indent = "  ") {
  const width = Math.max(0, ...rows2.map(([label]) => label.length));
  return rows2.map(([label, value]) => `${indent}${label.padEnd(width)}  ${value}`.trimEnd());
}
function fullPathLines(shortenedPaths, indent = "  ") {
  if (shortenedPaths.length === 0) {
    return [];
  }
  return [
    `${indent}full paths (${shortenedPaths.length} shortened above):`,
    ...shortenedPaths.map((path) => `${indent}  ${path}`)
  ];
}
function tableSection(columns, rows2, options) {
  const indent = options.indent ?? "  ";
  const rendered = tableWithPaths(columns, rows2, indent, { fit: options.fit === true });
  const lines = [...rendered.lines];
  const more = moreLine(options.total, options.shown, indent);
  if (more !== null) {
    lines.push(more);
  }
  lines.push(...fullPathLines(rendered.shortenedPaths, indent));
  return lines;
}
var BASELINE_WIDTH = 90;
var MIN_WIDTH = 60;
var widthScale = 1;
function configureTruncation(options) {
  if (options.format !== "text" || options.fullMessages) {
    widthScale = null;
    return;
  }
  widthScale = Math.max(MIN_WIDTH, terminalWidth()) / BASELINE_WIDTH;
}
function terminalWidth() {
  const fromEnv = Number(process.env["COLUMNS"]);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  const fromTty = process.stdout.columns;
  if (typeof fromTty === "number" && fromTty > 0) {
    return fromTty;
  }
  return BASELINE_WIDTH;
}
function renderWidth() {
  return widthScale === null ? null : Math.max(MIN_WIDTH, terminalWidth());
}
function resetTruncation() {
  widthScale = 1;
}
function scaled(maxWidth) {
  if (widthScale === null || maxWidth <= 0) {
    return 0;
  }
  return Math.max(1, Math.round(maxWidth * widthScale));
}
function truncateTo(value, width) {
  if (width <= 0 || value.length <= width) {
    return value;
  }
  return `${value.slice(0, Math.max(0, width - 1))}\u2026`;
}
function truncate(value, maxWidth) {
  const limit = scaled(maxWidth);
  if (limit <= 0 || value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1))}\u2026`;
}
function truncatePath(value, maxWidth) {
  if (maxWidth <= 0 || value.length <= maxWidth) {
    return value;
  }
  const segments = value.split("/");
  let kept = "";
  for (let i = segments.length - 1; i >= 0; i--) {
    const candidate = segments.slice(i).join("/");
    if (candidate.length + 2 > maxWidth) {
      break;
    }
    kept = candidate;
  }
  if (kept === "") {
    const basename2 = segments[segments.length - 1] ?? value;
    return `\u2026${basename2.slice(Math.max(0, basename2.length - (maxWidth - 1)))}`;
  }
  return `\u2026/${kept}`;
}
function moreLine(total, shown, indent = "  ") {
  const hidden = total - shown;
  if (hidden <= 0) {
    return null;
  }
  return `${indent}\u2026 ${hidden} more (--limit 0 for all)`;
}
function applyLimit(items, limit) {
  if (limit === void 0 || limit === 0) {
    return [...items];
  }
  return items.slice(0, limit);
}
function fitLine(value, prefixWidth = 0) {
  const width = renderWidth();
  if (width === null) {
    return value;
  }
  return truncateTo(value, Math.max(MIN_CELL_WIDTH, width - prefixWidth));
}
function wrapText(text, width = renderWidth()) {
  if (width === null || width <= 0) {
    return [text];
  }
  const lines = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") {
    lines.push(current);
  }
  return lines;
}
function percent(value, digits = 1) {
  if (value === null || value === void 0) {
    return "\u2014";
  }
  return `${value.toFixed(digits)}%`;
}
function delta(value, digits = 2) {
  if (value === null || value === void 0) {
    return "\u2014";
  }
  if (Math.abs(value) < 5e-3) {
    return "=";
  }
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}
function count(value) {
  return value.toLocaleString("en-US");
}
function dateWithWeekday(date) {
  const weekday = weekdayOf(date);
  return weekday === null ? date : `${date} (${weekday})`;
}
function weekdayOf(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }
  const parsed = /* @__PURE__ */ new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parsed.getUTCDay()];
}
function isWeekend(date) {
  const weekday = weekdayOf(date);
  return weekday === "Sat" || weekday === "Sun";
}
function joinLines(lines) {
  const out = [];
  for (const line of lines) {
    if (line === null) {
      continue;
    }
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) {
      continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }
  return out.join("\n");
}
function bytes(value) {
  const units = ["B", "KB", "MB", "GB"];
  let scaled2 = value;
  let unit = 0;
  while (scaled2 >= 1024 && unit < units.length - 1) {
    scaled2 /= 1024;
    unit++;
  }
  return `${unit === 0 ? scaled2 : scaled2.toFixed(1)} ${units[unit]}`;
}

// cli/format/json.ts
function toJson(value) {
  return JSON.stringify(value, jsonReplacer, 2);
}
function jsonReplacer(key, value) {
  if (value instanceof Map) {
    throw new Error(
      `refusing to serialize a Map at "${key}" \u2014 it would become {}. Convert it with Object.fromEntries() or [...map] first.`
    );
  }
  if (value instanceof Set) {
    throw new Error(
      `refusing to serialize a Set at "${key}" \u2014 it would become {}. Convert it with [...set] first.`
    );
  }
  return value;
}

// cli/format/markdown.ts
function table2(columns, rows2) {
  if (rows2.length === 0) {
    return [];
  }
  const header = `| ${columns.map(
    (c) => escapeCell(c.sort === void 0 ? c.header : `${c.header} ${c.sort === "desc" ? "\u25BC" : "\u25B2"}`)
  ).join(" | ")} |`;
  const rule = `| ${columns.map((c) => c.align === "right" ? "---:" : "---").join(" | ")} |`;
  const body = rows2.map(
    (row) => `| ${columns.map((_, i) => escapeCell(row[i] ?? "")).join(" | ")} |`
  );
  return [header, rule, ...body];
}
function escapeCell(value) {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}
function heading(text, level = 2) {
  return `${"#".repeat(level)} ${text}`;
}
function code(value) {
  return `\`${value.replace(/`/g, "\u2018")}\``;
}
function moreLine2(total, shown) {
  const hidden = total - shown;
  if (hidden <= 0) {
    return null;
  }
  return `_\u2026 ${hidden} more (\`--limit 0\` for all)_`;
}

// cli/commands/cache.ts
var CACHE_OPTIONS = {
  clear: { type: "boolean", describe: "Delete every cached entry." },
  size: { type: "boolean", describe: "Report the total size on disk." }
};
function artifactTotals(entries) {
  const artifacts = entries.filter((entry) => isImmutableKind(entry.kind));
  return {
    entryCount: artifacts.length,
    bytes: artifacts.reduce((sum, entry) => sum + entry.bytes, 0)
  };
}
async function runCache(context, args, cache) {
  if (args.positionals.length > 0) {
    throw usageError(`cache takes no arguments, got "${args.positionals[0]}"`);
  }
  const wantsClear = boolOption(args, "clear");
  if (wantsClear) {
    const totalBytes2 = await cacheSize(cache);
    const artifacts = artifactTotals(await cache.list());
    const cleared = await cache.clear();
    const result2 = {
      directory: cache.directory,
      entryCount: 0,
      totalBytes: 0,
      taskArtifacts: { entryCount: 0, bytes: 0 },
      cleared,
      entries: []
    };
    if (context.globals.format === "json") {
      emit(context, toJson(result2));
      return;
    }
    emit(
      context,
      `Cleared ${cleared} ${cleared === 1 ? "entry" : "entries"} (${bytes(totalBytes2)}) from ${cache.directory}` + (artifacts.entryCount === 0 ? "" : `, of which ${artifacts.entryCount} task ${artifacts.entryCount === 1 ? "artifact" : "artifacts"} (${bytes(artifacts.bytes)})`)
    );
    return;
  }
  const entries = await cache.list();
  const totalBytes = await cacheSize(cache);
  const result = {
    directory: cache.directory,
    entryCount: entries.length,
    totalBytes,
    taskArtifacts: artifactTotals(entries),
    entries
  };
  if (context.globals.format === "json") {
    emit(context, toJson(result));
    return;
  }
  emit(
    context,
    context.globals.format === "markdown" ? renderMarkdown(result) : renderText(result, boolOption(args, "size"))
  );
}
function entryLabel(key) {
  const match = /\/task\/([^/]+)\/runs\/(\d+)\/artifacts\/(.+)$/.exec(key);
  if (match === null) {
    return key;
  }
  return `${match[1]}.${match[2]} ${match[3]}`;
}
function artifactNote(result) {
  if (result.taskArtifacts.entryCount === 0) {
    return "";
  }
  return ` \u2014 ${bytes(result.taskArtifacts.bytes)} of that is ${result.taskArtifacts.entryCount} task ${result.taskArtifacts.entryCount === 1 ? "artifact" : "artifacts"}`;
}
function renderText(result, sizeOnly) {
  if (sizeOnly) {
    return `${bytes(result.totalBytes)} in ${result.entryCount} entries (${result.directory})${artifactNote(result)}`;
  }
  const lines = [
    `${result.directory} \u2014 ${result.entryCount} ${result.entryCount === 1 ? "entry" : "entries"}, ${bytes(result.totalBytes)}` + artifactNote(result)
  ];
  if (result.entries.length === 0) {
    lines.push("");
    lines.push("  (empty)");
    return joinLines(lines);
  }
  lines.push("");
  lines.push(
    ...table(
      [
        // Truncated from the right, not the left, because
        // `entryLabel()` has already put the identifying part — the
        // task ID and run — at the front. Path-aware truncation here
        // would drop it again.
        { header: "File", maxWidth: 56 },
        { header: "Size", align: "right" },
        { header: "Generated" },
        { header: "Fetched" }
      ],
      result.entries.map((entry) => [
        entryLabel(entry.key),
        bytes(entry.bytes),
        // A file with no `generatedAt` is a real case (`index.json`
        // has no metadata block, and neither does a task artifact), so
        // it says so rather than showing a blank that reads as missing
        // data.
        entry.generatedAt ?? "n/a",
        entry.fetchedAt
      ])
    )
  );
  return joinLines(lines);
}
function renderMarkdown(result) {
  const lines = [
    heading("fx-tests cache"),
    "",
    `${code(result.directory)} \u2014 ${result.entryCount} entries, ${bytes(result.totalBytes)}`,
    ""
  ];
  lines.push(
    ...table2(
      [
        { header: "File" },
        { header: "Size", align: "right" },
        { header: "Generated" },
        { header: "Fetched" }
      ],
      result.entries.map((entry) => [
        entryLabel(entry.key),
        bytes(entry.bytes),
        entry.generatedAt ?? "n/a",
        entry.fetchedAt
      ])
    )
  );
  return joinLines(lines);
}

// lib/formats/tables.ts
var TableIndexError = class extends Error {
  // Written out rather than declared as constructor parameter properties:
  // `node --experimental-strip-types` erases types without emitting code, so
  // a parameter property has nowhere to be assigned and is rejected outright.
  table;
  index;
  length;
  constructor(table3, index, length) {
    super(`index ${index} out of range for ${table3} (length ${length})`);
    this.name = "TableIndexError";
    this.table = table3;
    this.index = index;
    this.length = length;
  }
};
function lookup(table3, index, name) {
  const value = table3[index];
  if (value === void 0) {
    throw new TableIndexError(name, index, table3.length);
  }
  return value;
}
function lookupOptional(table3, index, name) {
  if (index === null || index === void 0) {
    return null;
  }
  return lookup(table3, index, name);
}
function lookupRequiredTable(table3, index, name) {
  if (table3 === void 0) {
    throw new Error(`${name} is needed to decode this group but was not supplied`);
  }
  return lookup(table3, index, name);
}
function joinTestPath(directory, name) {
  return directory ? `${directory}/${name}` : name;
}
function readTest(tables, testInfo, testId) {
  const pathId = testInfo.testPathIds[testId];
  const nameId = testInfo.testNameIds[testId];
  if (pathId === void 0 || nameId === void 0) {
    throw new TableIndexError("testInfo", testId, testInfo.testPathIds.length);
  }
  const directory = lookup(tables.testPaths, pathId, "tables.testPaths");
  const name = lookup(tables.testNames, nameId, "tables.testNames");
  const componentId = testInfo.componentIds?.[testId] ?? null;
  return {
    testId,
    fullPath: joinTestPath(directory, name),
    directory,
    name,
    component: tables.components ? lookupOptional(tables.components, componentId, "tables.components") : null
  };
}
function indexTestsByPath(tables, testInfo) {
  const byPath = /* @__PURE__ */ new Map();
  for (let testId = 0; testId < testInfo.testPathIds.length; testId++) {
    const pathId = testInfo.testPathIds[testId];
    const nameId = testInfo.testNameIds[testId];
    if (nameId === void 0) {
      continue;
    }
    const directory = lookup(tables.testPaths, pathId, "tables.testPaths");
    const name = lookup(tables.testNames, nameId, "tables.testNames");
    byPath.set(joinTestPath(directory, name), testId);
  }
  return byPath;
}
function parseTaskId(raw) {
  const dot = raw.lastIndexOf(".");
  if (dot === -1) {
    return { taskId: raw, retryId: 0 };
  }
  const suffix = raw.slice(dot + 1);
  if (suffix.length === 0 || !/^\d+$/.test(suffix)) {
    return { taskId: raw, retryId: 0 };
  }
  return { taskId: raw.slice(0, dot), retryId: Number(suffix) };
}

// lib/model/crash-signature.ts
var ABORT_SIGNATURES = [
  "Abort(char const*)",
  "RustMozCrash",
  "NS_DebugBreak",
  "core::ops::function::Fn::call",
  "gkrust_shared::panic_hook",
  "mozglue_static::panic_hook",
  "intentional_panic",
  "mozalloc_abort",
  "mozalloc_abort(char const* const)",
  "static void Abort(const char *)",
  "std::sys_common::backtrace::__rust_end_short_backtrace",
  "rust_begin_unwind",
  "MOZ_Crash(char const*, int, char const*)",
  "MOZ_CrashSequence(void*, long)",
  "<alloc::boxed::Box<F,A> as core::ops::function::Fn<Args>>::call"
];
var ABORT_SUBSTRINGS = [
  "_panic_",
  "core::panic::",
  "core::panicking::",
  "core::result::unwrap_failed",
  "std::panicking::"
];
var UNKNOWN_SIGNATURE = "@ Unknown";
function frameName(frame) {
  return frame.function || `${frame.module} + ${frame.module_offset}`;
}
function flattenFrames(frames) {
  const flattened = [];
  for (const frame of frames) {
    for (const inline of frame.inlines ?? []) {
      flattened.push(inline.function);
    }
    flattened.push(frameName(frame));
  }
  return flattened;
}
function isAbortFrame(name) {
  return ABORT_SIGNATURES.includes(name) || ABORT_SUBSTRINGS.some((fragment) => name.includes(fragment));
}
function stripParameters(signature) {
  const match = /(.*)\(.*\)/.exec(signature);
  return match?.[1] ?? signature;
}
function crashSignature(file) {
  const frames = file.crashing_thread?.frames ?? [];
  const flattened = flattenFrames(frames);
  for (const name of flattened) {
    if (!name) {
      continue;
    }
    if (!isAbortFrame(name)) {
      return stripParameters(`@ ${name}`);
    }
  }
  const first = flattened[0];
  if (first) {
    return stripParameters(`@ ${first}`);
  }
  return UNKNOWN_SIGNATURE;
}
function faultingAddress(file) {
  const info = file.crash_info;
  if (info === void 0) {
    return null;
  }
  const adjusted = info.adjusted_address;
  return {
    address: info.address,
    kind: adjusted?.kind ?? null,
    offset: adjusted?.offset ?? null,
    nullPointer: adjusted?.kind === "null-pointer"
  };
}
var BREAKPAD_FRAME_FRAGMENTS = [
  "google_breakpad::",
  "ExceptionHandler::WriteMinidumpWithException",
  "CrashGenerationClient::RequestDumpForException",
  "ReceivePort::WaitForMessage"
];
var BLOCKED_FRAME_FRAGMENTS = [
  // Mozilla's own synchronization primitives — the highest-signal entries,
  // because reaching one means Gecko code is waiting on Gecko code.
  "ConditionVariableImpl::wait",
  "MutexImpl::lock",
  "Monitor::Wait",
  "ReentrantMonitor::Wait",
  "CondVar::Wait",
  "MonitorAutoLock",
  "OffTheBooksMutex::Lock",
  // Platform mutex and condition-variable waits.
  "RtlSleepConditionVariableSRW",
  "SleepConditionVariableSRW",
  "RtlEnterCriticalSection",
  "EnterCriticalSection",
  "__psynch_cvwait",
  "__psynch_mutexwait",
  "pthread_cond_wait",
  "pthread_cond_timedwait",
  "pthread_mutex_lock",
  "futex_wait",
  // Cross-process message waits, which is how an IPC deadlock presents.
  "WaitForMessage",
  "WaitForReplyMessage"
];
var BLOCKED_FRAME_DEPTH = 4;
function isBlockedThread(thread) {
  return thread.frames.slice(0, BLOCKED_FRAME_DEPTH).some((frame) => {
    const name = frameName(frame);
    return BLOCKED_FRAME_FRAGMENTS.some((fragment) => name.includes(fragment));
  });
}
function hasBreakpadFrames(thread) {
  return thread.frames.slice(0, 8).some((frame) => {
    const name = frameName(frame);
    return BREAKPAD_FRAME_FRAGMENTS.some((fragment) => name.includes(fragment));
  });
}
var FAULT_TYPE_FRAGMENTS = [
  // POSIX segmentation and bus faults, as Linux and Android report them.
  "SIGSEGV",
  "SIGBUS",
  // Mach exceptions, as macOS reports them. `EXC_BAD_ACCESS` covers
  // `KERN_INVALID_ADDRESS` and `KERN_PROTECTION_FAILURE` alike.
  "EXC_BAD_ACCESS",
  // Windows structured exceptions for the same conditions.
  "EXCEPTION_ACCESS_VIOLATION",
  "EXCEPTION_IN_PAGE_ERROR",
  "EXCEPTION_DATATYPE_MISALIGNMENT"
];
function hasFaultingAccess(file) {
  const type = file.crash_info?.type;
  if (type === void 0) {
    return false;
  }
  return FAULT_TYPE_FRAGMENTS.some((fragment) => type.includes(fragment));
}
function detectHang(file) {
  const crashing = file.crashing_thread;
  const blockedThreadCount = file.threads.filter(isBlockedThread).length;
  if (crashing === void 0) {
    return {
      looksLikeHang: false,
      reason: "no crashing thread recorded",
      parkedIn: null,
      blockedThreadCount
    };
  }
  if (hasFaultingAccess(file)) {
    const type = file.crash_info?.type ?? "a memory fault";
    const kind = file.crash_info?.adjusted_address?.kind;
    return {
      looksLikeHang: false,
      reason: `the dump records ${type}` + (kind === void 0 ? "" : ` (${kind})`) + ", a faulting memory access \u2014 the process was executing when it died, so this is a real crash even though breakpad\u2019s frames are on the stack (its signal handler is what wrote the dump)",
      parkedIn: null,
      blockedThreadCount
    };
  }
  if (!hasBreakpadFrames(crashing)) {
    return {
      looksLikeHang: false,
      reason: "the crashing thread\u2019s innermost frames are not breakpad\u2019s, so this looks like a real fault rather than a dump taken from outside",
      parkedIn: null,
      blockedThreadCount
    };
  }
  const parkedIn = firstNonBreakpadFrame(crashing);
  return {
    looksLikeHang: true,
    reason: "breakpad\u2019s own frames are on top of the crashing thread, so the dump was written on request rather than at a fault \u2014 the signature of a process killed from outside",
    parkedIn,
    blockedThreadCount
  };
}
function firstNonBreakpadFrame(thread) {
  for (const frame of thread.frames) {
    const name = frameName(frame);
    if (BREAKPAD_FRAME_FRAGMENTS.some((fragment) => name.includes(fragment))) {
      continue;
    }
    if (name.includes("_sigtramp")) {
      continue;
    }
    if (frame.function === null) {
      continue;
    }
    return name;
  }
  return null;
}

// lib/links.ts
var FIREFOX_CI_ROOT = "https://firefox-ci-tc.services.mozilla.com";
function taskArtifactUrl(taskId, retryId, artifactPath) {
  return `${FIREFOX_CI_ROOT}/api/queue/v1/task/${taskId}/runs/${retryId}/artifacts/${artifactPath}`;
}
function testInfoArtifactUrl(taskId, retryId, filename) {
  return taskArtifactUrl(taskId, retryId, `public/test_info/${filename}`);
}
function resourceUsageProfileUrl(taskId, retryId) {
  return testInfoArtifactUrl(taskId, retryId, "profile_resource-usage.json");
}
function uploadedProfileName(message) {
  if (!message) {
    return null;
  }
  const match = /profile uploaded in (profile_\S+\.json)/.exec(message);
  return match?.[1] ?? null;
}
function uploadedProfileUrl(taskId, retryId, message) {
  const filename = uploadedProfileName(message);
  return filename === null ? null : testInfoArtifactUrl(taskId, retryId, filename);
}
function minidumpJsonUrl(taskId, retryId, minidumpId) {
  return testInfoArtifactUrl(taskId, retryId, `${minidumpId}.json`);
}
var TREEHERDER_ROOT = "https://treeherder.mozilla.org";
function treeherderPushUrl(repository, revision) {
  const params = new URLSearchParams({ repo: repository, revision });
  return `${TREEHERDER_ROOT}/jobs?${params.toString()}`;
}

// lib/sources/http.ts
var FIREFOX_CI_ROOT2 = "https://firefox-ci-tc.services.mozilla.com";
function indexArtifactUrl(index, filename, repository = "mozilla-central", root = FIREFOX_CI_ROOT2) {
  return `${indexArtifactBase(index, repository, root)}${filename}`;
}
function indexArtifactBase(index, repository = "mozilla-central", root = FIREFOX_CI_ROOT2) {
  return `${root}/api/index/v1/task/gecko.v2.${repository}.latest.source.test-info-${index}/artifacts/public/`;
}
function httpSource(options) {
  const repository = options.repository ?? "mozilla-central";
  const root = options.root ?? FIREFOX_CI_ROOT2;
  const doFetch = options.fetch;
  const resolvedBases = /* @__PURE__ */ new Map();
  async function get(name, url) {
    let response;
    try {
      response = await doFetch(url);
    } catch (error) {
      throw new DataFetchError(name, error.message, url);
    }
    if (response.status === 404) {
      return "not-found";
    }
    if (!response.ok) {
      throw new DataFetchError(name, `HTTP ${response.status}`, url, response.status);
    }
    const finalUrl = response.url;
    if (finalUrl) {
      const base = finalUrl.slice(0, finalUrl.lastIndexOf("/") + 1);
      const requested = url.slice(0, url.lastIndexOf("/") + 1);
      if (base && base !== requested) {
        resolvedBases.set(name.index, base);
      }
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  return {
    name: options.name ?? repository,
    async fetch(name) {
      const cachedBase = resolvedBases.get(name.index);
      if (cachedBase !== void 0) {
        const result2 = await get(name, `${cachedBase}${name.filename}`);
        if (result2 !== "not-found") {
          return result2;
        }
        resolvedBases.delete(name.index);
      }
      const url = indexArtifactUrl(name.index, name.filename, repository, root);
      const result = await get(name, url);
      if (result === "not-found") {
        throw new DataFileNotFoundError(name, url);
      }
      return result;
    }
  };
}
function taskArtifactSource(options) {
  const root = options.root ?? FIREFOX_CI_ROOT2;
  return {
    name: "task-artifacts",
    async fetch(name) {
      const url = taskArtifactUrl2(name, root);
      let response;
      try {
        response = await options.fetch(url);
      } catch (error) {
        throw new DataFetchError(name, error.message, url);
      }
      if (response.status === 404) {
        throw new DataFileNotFoundError(name, url);
      }
      if (!response.ok) {
        throw new DataFetchError(name, `HTTP ${response.status}`, url, response.status);
      }
      return new Uint8Array(await response.arrayBuffer());
    }
  };
}
function taskArtifactUrl2(name, root = FIREFOX_CI_ROOT2) {
  return `${root}/api/queue/v1/task/${name.index}/${name.filename}`;
}
function taskArtifactName(taskId, retryId, artifactPath) {
  return { index: taskId, filename: `runs/${retryId}/artifacts/${artifactPath}` };
}

// cli/commands/crash.ts
var CRASH_OPTIONS = {
  "all-threads": {
    type: "boolean",
    describe: "Every thread, shallower (8 frames) \u2014 the view for a hang."
  },
  thread: {
    type: "number",
    placeholder: "<n>",
    describe: "Show one thread by index instead of the crashing one."
  },
  frames: {
    type: "number",
    placeholder: "<n>",
    describe: "Frames per thread. Default 20, or 8 with --all-threads. 0 for all."
  },
  raw: { type: "boolean", describe: "Print the unprocessed stackwalk JSON." }
};
var DEFAULT_FRAMES_SINGLE = 20;
var DEFAULT_FRAMES_ALL = 8;
async function runCrash(context, args) {
  const [rawTaskId, minidumpId] = args.positionals;
  if (rawTaskId === void 0 || minidumpId === void 0) {
    throw usageError(
      "crash requires a task ID and a minidump ID",
      "Usage: fx-tests crash <taskId>[.<retryId>] <minidumpId>. Both come from `fx-tests crashes --minidumps` or `fx-tests test --task-ids`."
    );
  }
  if (args.positionals.length > 2) {
    throw usageError(
      `crash takes two arguments, got ${args.positionals.length}: ` + args.positionals.join(", ")
    );
  }
  const { taskId, retryId } = parseTaskId(rawTaskId);
  const allThreads = boolOption(args, "all-threads");
  const threadIndex = numberOption(args, "thread");
  if (allThreads && threadIndex !== void 0) {
    throw usageError(
      "--all-threads and --thread are mutually exclusive",
      "--thread <n> shows one thread; --all-threads shows every thread, shallower."
    );
  }
  const url = minidumpJsonUrl(taskId, retryId, minidumpId);
  progress(context, `Reading ${minidumpId}.json from task ${taskId}.${retryId}\u2026`);
  const file = await fetchDump(context, taskId, retryId, minidumpId, url);
  if (boolOption(args, "raw")) {
    emit(context, JSON.stringify(file, null, 2));
    return;
  }
  const crashingIndex = file.crash_info?.crashing_thread ?? null;
  const frameLimit = numberOption(args, "frames") ?? (allThreads ? DEFAULT_FRAMES_ALL : DEFAULT_FRAMES_SINGLE);
  let selected;
  if (allThreads) {
    selected = file.threads.map((thread, index) => ({ thread, index }));
  } else if (threadIndex !== void 0) {
    const thread = file.threads[threadIndex];
    if (thread === void 0) {
      throw usageError(
        `no thread #${threadIndex}: the dump has ${file.threads.length} threads (0\u2026${file.threads.length - 1})`
      );
    }
    selected = [{ thread, index: threadIndex }];
  } else {
    const thread = file.crashing_thread ?? (crashingIndex === null ? void 0 : file.threads[crashingIndex]);
    if (thread === void 0) {
      throw upstreamError(
        `the dump for ${minidumpId} records no crashing thread`,
        "Use --all-threads to see every thread, or --raw for the unprocessed JSON."
      );
    }
    selected = [{ thread, index: crashingIndex ?? 0 }];
  }
  const limit = context.globals.limit;
  const shown = allThreads ? applyLimit(selected, limit ?? 0) : selected;
  const result = {
    taskId,
    retryId,
    minidumpId,
    url,
    signature: crashSignature(file),
    crashType: file.crash_info?.type ?? null,
    assertion: file.crash_info?.assertion ?? null,
    instruction: file.crash_info?.instruction ?? null,
    address: faultingAddress(file),
    system: file.system_info === void 0 ? null : {
      os: file.system_info.os,
      osVersion: file.system_info.os_ver,
      cpuArch: file.system_info.cpu_arch,
      cpuCount: file.system_info.cpu_count
    },
    crashingThreadIndex: crashingIndex,
    threadCount: file.threads.length,
    hang: detectHang(file),
    threads: shown.map(
      ({ thread, index }) => toThreadJson(thread, index, index === crashingIndex, frameLimit)
    ),
    threadRowCount: selected.length
  };
  if (context.globals.format === "json") {
    emit(context, toJson(result));
    return;
  }
  emit(
    context,
    context.globals.format === "markdown" ? renderMarkdown2(result, allThreads) : renderText2(result, allThreads, frameLimit)
  );
}
async function fetchDump(context, taskId, retryId, minidumpId, url) {
  const source = context.taskArtifacts ?? taskArtifactSource({ fetch: nodeFetch });
  const name = taskArtifactName(taskId, retryId, `public/test_info/${minidumpId}.json`);
  try {
    return await fetchJson(source, name);
  } catch (error) {
    if (error instanceof DataFileNotFoundError) {
      throw goneError(
        `no minidump ${minidumpId} on task ${taskId}.${retryId}: the artifact is not there.`,
        "Taskcluster expires artifacts, so a dump from an old task is permanently gone \u2014 retrying will not help. Check the task ID and retry number, and that the crash recorded a minidump at all (some do not)."
      );
    }
    if (error instanceof DataFetchError) {
      throw upstreamError(
        `could not fetch ${url}: ${error.message}`,
        error.status === 403 ? "A 403 here is usually a malformed artifact path or an auth problem rather than an expired artifact, which answers 404. Retrying may work." : "This looks transient \u2014 retrying may work."
      );
    }
    throw error;
  }
}
async function nodeFetch(url) {
  const response = await fetch(url);
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    arrayBuffer: () => response.arrayBuffer()
  };
}
function toThreadJson(thread, index, crashing, frameLimit) {
  const frames = frameLimit === 0 ? thread.frames : thread.frames.slice(0, frameLimit);
  return {
    index,
    // `null` is real and common: the crash fixture's own crashing thread is
    // unnamed, so this must not be defaulted to a placeholder that reads
    // like a name.
    name: thread.thread_name,
    threadId: thread.thread_id,
    crashing,
    blocked: isBlockedThread(thread),
    frameCount: thread.frames.length,
    frames: frames.map(toFrameJson)
  };
}
function toFrameJson(frame) {
  return {
    index: frame.frame,
    function: frameName(frame),
    unsymbolized: frame.function === null,
    file: frame.file,
    line: frame.line,
    module: frame.module,
    trust: frame.trust,
    // `inlines` is `null` rather than absent on frames that have none —
    // measured on both fixtures, and not what the declaration suggests.
    inlines: (frame.inlines ?? []).map((inline) => ({
      function: inline.function,
      file: inline.file,
      line: inline.line
    }))
  };
}
function renderText2(result, allThreads, frameLimit) {
  const lines = [];
  lines.push(`Crash ${result.signature}`);
  if (result.crashType !== null) {
    lines.push(`  Type:    ${result.crashType}`);
  }
  if (result.address !== null) {
    lines.push(
      `  Address: ${result.address.address}` + (result.address.nullPointer ? `  ** null pointer with offset ${result.address.offset ?? "0x0"}` : result.address.kind !== null ? `  ** ${result.address.kind}${result.address.offset === null ? "" : ` with offset ${result.address.offset}`}` : "")
    );
  }
  if (result.assertion !== null) {
    lines.push(`  Assertion: ${result.assertion}`);
  }
  if (result.instruction !== null) {
    lines.push(`  Instruction: ${result.instruction}`);
  }
  if (result.system !== null) {
    lines.push(
      `  System:  ${result.system.os} ${result.system.osVersion}, ${result.system.cpuArch}, ${result.system.cpuCount} CPUs`
    );
  }
  lines.push(`  Task:    ${result.taskId}.${result.retryId}  dump ${result.minidumpId}`);
  if (result.hang.looksLikeHang) {
    lines.push("");
    lines.push("This looks like a HANG rather than a crash.");
    lines.push(`  ${result.hang.reason}.`);
    if (result.hang.parkedIn !== null) {
      lines.push(`  Underneath breakpad, the thread was parked in ${result.hang.parkedIn}.`);
    }
    lines.push(
      `  ${result.hang.blockedThreadCount} of ${result.threadCount} threads are waiting on a lock or condition variable.`
    );
    if (!allThreads) {
      lines.push(
        "  A deadlock is read across threads rather than down one \u2014 try --all-threads."
      );
    }
  }
  lines.push("");
  if (allThreads) {
    lines.push(
      `${result.threadCount} threads.` + (result.hang.blockedThreadCount > 0 ? ` Waiting on a lock: ${blockedList(result)}  (see ** markers)` : " None are waiting on a lock.")
    );
    lines.push(
      '  "blocked" is a heuristic over the innermost frames \u2014 a minidump records no lock'
    );
    lines.push("  ownership, so this points at threads worth reading, not at a proven cycle.");
    lines.push("");
  }
  for (const thread of result.threads) {
    lines.push(...renderThread(thread, allThreads));
    lines.push("");
  }
  lines.push(moreLine(result.threadRowCount, result.threads.length));
  if (!allThreads && result.threadCount > 1) {
    const others = result.threadCount - 1;
    lines.push(
      `${others} other thread${others === 1 ? "" : "s"} (--all-threads to show, --thread <n> for one)`
    );
  }
  const truncated = result.threads.filter(
    (thread) => frameLimit !== 0 && thread.frameCount > thread.frames.length
  );
  if (truncated.length > 0) {
    lines.push(
      `Frames truncated to ${frameLimit} per thread (--frames <n>, or --frames 0 for all).`
    );
  }
  return joinLines(lines);
}
function blockedList(result) {
  const blocked = result.threads.filter((thread) => thread.blocked).map((t) => `#${t.index}`);
  return blocked.length === 0 ? "(none in this view)" : blocked.slice(0, 12).join(", ");
}
function renderThread(thread, allThreads) {
  const lines = [];
  const label = thread.name ?? `tid ${thread.threadId}`;
  const header = allThreads ? ` #${thread.index}  ${label}` : `${thread.crashing ? "Crashing thread" : "Thread"} #${thread.index} (${label})`;
  lines.push(header + (thread.blocked ? "   ** blocked" : ""));
  for (const frame of thread.frames) {
    const where = frame.file !== null && frame.line !== null ? `  ${shortenSourceFile(frame.file)}:${frame.line}` : "";
    lines.push(
      `  ${String(frame.index).padStart(3)}  ${truncate(frame.function, 88)}${where}`
    );
    for (const inline of frame.inlines) {
      lines.push(
        `       \u2514 inlined: ${truncate(inline.function ?? "(unnamed)", 78)}` + (inline.file !== null && inline.line !== null ? `  ${shortenSourceFile(inline.file)}:${inline.line}` : "")
      );
    }
  }
  if (thread.frameCount > thread.frames.length) {
    lines.push(`       \u2026 ${thread.frameCount - thread.frames.length} more frames`);
  }
  return lines;
}
function shortenSourceFile(file) {
  const match = /^(?:git|hg|s3):[^:]+:([^:]+):/.exec(file);
  return match?.[1] ?? file;
}
function renderMarkdown2(result, allThreads) {
  const lines = [];
  lines.push(heading(result.signature, 1));
  lines.push("");
  const facts = [];
  if (result.crashType !== null) {
    facts.push(["Type", code(result.crashType)]);
  }
  if (result.address !== null) {
    facts.push([
      "Address",
      code(result.address.address) + (result.address.nullPointer ? ` \u2014 **null pointer** with offset ${result.address.offset ?? "0x0"}` : "")
    ]);
  }
  if (result.system !== null) {
    facts.push(["System", `${result.system.os} ${result.system.osVersion}, ${result.system.cpuArch}`]);
  }
  facts.push(["Task", code(`${result.taskId}.${result.retryId}`)]);
  facts.push(["Dump", code(result.minidumpId)]);
  lines.push(...table2([{ header: "Field" }, { header: "Value" }], facts));
  if (result.hang.looksLikeHang) {
    lines.push("");
    lines.push(
      `**This looks like a hang rather than a crash.** ${result.hang.reason}` + (result.hang.parkedIn === null ? "." : `, parked in ${code(result.hang.parkedIn)}.`)
    );
  }
  for (const thread of result.threads) {
    lines.push("");
    lines.push(
      heading(
        `#${thread.index} ${thread.name ?? `tid ${thread.threadId}`}` + (thread.crashing ? " (crashing)" : "") + (thread.blocked ? " \u2014 blocked" : "")
      )
    );
    lines.push("");
    lines.push("```");
    for (const frame of thread.frames) {
      lines.push(
        `${String(frame.index).padStart(3)}  ${frame.function}` + (frame.file !== null && frame.line !== null ? `  ${shortenSourceFile(frame.file)}:${frame.line}` : "")
      );
    }
    if (thread.frameCount > thread.frames.length) {
      lines.push(`\u2026 ${thread.frameCount - thread.frames.length} more frames`);
    }
    lines.push("```");
  }
  void allThreads;
  return joinLines(lines);
}

// cli/commands/dates.ts
async function runDates(context, args) {
  if (args.positionals.length > 0) {
    throw usageError(`dates takes no arguments, got "${args.positionals[0]}"`);
  }
  const harnesses = context.globals.harness !== void 0 ? [context.globals.harness] : ["xpcshell", "mochitest"];
  const result = { harnesses: [] };
  for (const harness of harnesses) {
    progress(context, `Reading ${harness} index.json\u2026`);
    const file = await fetchJson(context.source, {
      index: timingsIndex(harness),
      filename: "index.json"
    });
    const dates = [...file.dates];
    result.harnesses.push({
      harness,
      dates,
      // `index.json` is newest first, so the ends are the other way round
      // from `stats.json`. Naming them rather than indexing at the call
      // site is what stops that from being got wrong twice.
      newest: dates[0] ?? null,
      oldest: dates[dates.length - 1] ?? null,
      dayCount: dates.length
    });
  }
  if (context.globals.format === "json") {
    emit(context, toJson(result));
    return;
  }
  emit(
    context,
    context.globals.format === "markdown" ? renderMarkdown3(result) : renderText3(result)
  );
}
function renderText3(result) {
  const lines = [];
  for (const entry of result.harnesses) {
    if (entry.dayCount === 0) {
      lines.push(`${entry.harness}: no dates published`);
      lines.push("");
      continue;
    }
    lines.push(
      `${entry.harness}: ${entry.dayCount} dates, ${dateWithWeekday(entry.oldest)} \u2026 ${dateWithWeekday(entry.newest)}`
    );
    for (const date of entry.dates) {
      lines.push(`  ${dateWithWeekday(date)}${isWeekend(date) ? "  \u2014 weekend" : ""}`);
    }
    lines.push("");
  }
  return joinLines(lines);
}
function renderMarkdown3(result) {
  const lines = [];
  for (const entry of result.harnesses) {
    lines.push(heading(entry.harness));
    lines.push("");
    if (entry.dayCount === 0) {
      lines.push("No dates published.");
      lines.push("");
      continue;
    }
    lines.push(
      ...table2(
        [{ header: "Date" }, { header: "Weekday" }, { header: "Note" }],
        entry.dates.map((date) => [
          date,
          dateWithWeekday(date).replace(`${date} `, "").replace(/[()]/g, ""),
          isWeekend(date) ? "weekend" : ""
        ])
      )
    );
    lines.push("");
  }
  return joinLines(lines);
}

// lib/formats/delta.ts
function forEachDelta(deltas, base, fn) {
  let value = base;
  for (let i = 0; i < deltas.length; i++) {
    value += deltas[i];
    fn(value, i);
  }
}

// lib/formats/errors.ts
function decodeErrors(file) {
  const { tables, messages, markers, testInfo, taskInfo, metadata } = file;
  const groupCount = markers.testIds.length;
  if (markers.messageIds.length !== groupCount || markers.taskIdIds.length !== groupCount || markers.counts.length !== groupCount) {
    throw new Error(
      `markers arrays are not parallel: testIds ${groupCount}, messageIds ${markers.messageIds.length}, taskIdIds ${markers.taskIdIds.length}, counts ${markers.counts.length}`
    );
  }
  return {
    date: metadata.date,
    generatedAt: metadata.generatedAt,
    jobCount: metadata.jobCount,
    processedJobCount: metadata.processedJobCount,
    invalidJobCount: metadata.invalidJobCount,
    markerCounts: metadata.markerCounts,
    markerNames: tables.markerNames,
    groupCount,
    messageCount: messages.markerNameIds.length,
    testCount: testInfo.testPathIds.length,
    messageAt(messageId) {
      const kindId = messages.markerNameIds[messageId];
      if (kindId === void 0) {
        throw new Error(
          `index ${messageId} out of range for messages (length ${messages.markerNameIds.length})`
        );
      }
      return {
        messageId,
        kind: lookup(tables.markerNames, kindId, "tables.markerNames"),
        text: lookupOptional(
          tables.messageTexts,
          messages.textIds[messageId],
          "tables.messageTexts"
        ),
        file: lookupOptional(tables.files, messages.fileIds[messageId], "tables.files"),
        line: messages.lines[messageId] ?? null,
        component: lookupOptional(
          tables.components,
          messages.componentIds[messageId],
          "tables.components"
        )
      };
    },
    testPathAt(testId) {
      const pathId = testInfo.testPathIds[testId];
      const nameId = testInfo.testNameIds[testId];
      if (pathId === void 0 || nameId === void 0) {
        throw new Error(
          `index ${testId} out of range for testInfo (length ${testInfo.testPathIds.length})`
        );
      }
      return joinTestPath(
        lookup(tables.testPaths, pathId, "tables.testPaths"),
        lookup(tables.testNames, nameId, "tables.testNames")
      );
    },
    testComponentAt(testId) {
      return lookupOptional(
        tables.components,
        testInfo.componentIds?.[testId],
        "tables.components"
      );
    },
    *groups() {
      for (let groupId = 0; groupId < groupCount; groupId++) {
        const counts = markers.counts[groupId];
        let totalCount = 0;
        for (let i = 0; i < counts.length; i++) {
          totalCount += counts[i];
        }
        yield {
          groupId,
          testId: markers.testIds[groupId],
          messageId: markers.messageIds[groupId],
          totalCount,
          // The task IDs are delta-encoded but their *count* is just
          // the array length, so the ranking path never decodes them.
          taskCount: markers.taskIdIds[groupId].length
        };
      }
    },
    taskIdsOfGroup(groupId) {
      const deltas = markers.taskIdIds[groupId];
      if (deltas === void 0) {
        throw new Error(
          `index ${groupId} out of range for markers (length ${groupCount})`
        );
      }
      const out = [];
      forEachDelta(deltas, 0, (taskIdIndex) => {
        out.push(lookup(tables.taskIds, taskIdIndex, "tables.taskIds"));
      });
      return out;
    },
    jobNameOfTaskIndex(taskIdIndex) {
      const jobNameId = taskInfo.jobNameIds[taskIdIndex];
      if (jobNameId === void 0) {
        throw new Error(
          `index ${taskIdIndex} out of range for taskInfo.jobNameIds (length ${taskInfo.jobNameIds.length})`
        );
      }
      return lookup(tables.jobNames, jobNameId, "tables.jobNames");
    }
  };
}

// lib/query/error-ranking.ts
var DEFAULT_MAX_TESTS = 20;
var DEFAULT_MAX_GROUP_IDS = 50;
function rankErrors(file, options = {}) {
  const grouping = options.grouping ?? "location";
  const maxTests = options.maxTestsPerGroup ?? DEFAULT_MAX_TESTS;
  const maxGroupIds = options.maxGroupIds ?? DEFAULT_MAX_GROUP_IDS;
  const messageNeedle = options.message?.toLowerCase();
  const componentNeedle = options.component?.toLowerCase();
  const fileNeedle = options.file?.toLowerCase();
  const messageCache = /* @__PURE__ */ new Map();
  const messageOf = (messageId) => {
    let decoded = messageCache.get(messageId);
    if (decoded === void 0) {
      decoded = file.messageAt(messageId);
      messageCache.set(messageId, decoded);
    }
    return decoded;
  };
  const testPathCache = /* @__PURE__ */ new Map();
  const pathOf = (testId) => {
    let path = testPathCache.get(testId);
    if (path === void 0) {
      path = file.testPathAt(testId);
      testPathCache.set(testId, path);
    }
    return path;
  };
  const groups = /* @__PURE__ */ new Map();
  let matchedCount = 0;
  let fileCount = 0;
  let matchedGroups = 0;
  for (const group of file.groups()) {
    fileCount += group.totalCount;
    const message = messageOf(group.messageId);
    if (options.kind !== void 0 && message.kind !== options.kind) {
      continue;
    }
    if (messageNeedle !== void 0 && !(message.text ?? "").toLowerCase().includes(messageNeedle)) {
      continue;
    }
    if (componentNeedle !== void 0 && !(message.component ?? "").toLowerCase().includes(componentNeedle)) {
      continue;
    }
    if (fileNeedle !== void 0 && !(message.file ?? "").toLowerCase().includes(fileNeedle)) {
      continue;
    }
    const path = pathOf(group.testId);
    if (options.test !== void 0 && !matchesTest(path, options.test)) {
      continue;
    }
    matchedCount += group.totalCount;
    matchedGroups += 1;
    const key = groupKey(grouping, message, path);
    let accumulator = groups.get(key);
    if (accumulator === void 0) {
      accumulator = {
        key,
        ...groupFields(grouping, message, path),
        count: 0,
        perTest: /* @__PURE__ */ new Map(),
        perComponent: /* @__PURE__ */ new Map(),
        groupIds: []
      };
      groups.set(key, accumulator);
    }
    accumulator.count += group.totalCount;
    accumulator.perTest.set(
      group.testId,
      (accumulator.perTest.get(group.testId) ?? 0) + group.totalCount
    );
    if (grouping !== "kind") {
      const component = message.component ?? UNKNOWN_COMPONENT;
      accumulator.perComponent.set(
        component,
        (accumulator.perComponent.get(component) ?? 0) + group.totalCount
      );
    }
    if (accumulator.groupIds.length < maxGroupIds) {
      accumulator.groupIds.push(group.groupId);
    }
  }
  const rows2 = [];
  for (const accumulator of groups.values()) {
    rows2.push({
      key: accumulator.key,
      kind: accumulator.kind,
      text: accumulator.text,
      file: accumulator.file,
      line: accumulator.line,
      component: accumulator.component,
      count: accumulator.count,
      testCount: accumulator.perTest.size,
      tests: [...accumulator.perTest].sort((a, b) => b[1] - a[1]).slice(0, maxTests).map(([testId, count2]) => ({ testId, path: pathOf(testId), count: count2 })),
      components: sortComponents(accumulator.perComponent),
      groupIds: accumulator.groupIds
    });
  }
  const sort = options.sort ?? "occurrences";
  rows2.sort(
    (a, b) => sort === "tests" ? b.testCount - a.testCount || b.count - a.count : b.count - a.count || b.testCount - a.testCount
  );
  return { rows: rows2, totals: { matchedCount, fileCount, matchedGroups } };
}
var UNKNOWN_COMPONENT = "Unknown";
function sortComponents(perComponent) {
  return [...perComponent].map(([component, count2]) => ({ component, count: count2 })).sort((a, b) => b.count - a.count || a.component.localeCompare(b.component));
}
function dominates(leaderCount, total) {
  return leaderCount * 2 > total;
}
function componentSummary(shares) {
  if (shares.length === 0) {
    return null;
  }
  if (shares.length === 1) {
    return shares[0].component;
  }
  const total = shares.reduce((sum, share) => sum + share.count, 0);
  if (dominates(shares[0].count, total)) {
    return `${shares[0].component}  +${(shares.length - 1).toLocaleString()} more`;
  }
  return `${shares.length.toLocaleString()} components`;
}
var MAX_BREAKDOWN_ROWS = 12;
function componentBreakdownLines(shares) {
  const shown = shares.slice(0, MAX_BREAKDOWN_ROWS);
  const lines = shown.map((share) => `${share.component}  ${share.count.toLocaleString()}`);
  if (shares.length > shown.length) {
    const rest = shares.slice(shown.length);
    const restCount = rest.reduce((sum, share) => sum + share.count, 0);
    lines.push(
      `\u2026 and ${rest.length.toLocaleString()} more, ${restCount.toLocaleString()} occurrences`
    );
  }
  return lines;
}
function matchesTest(path, wanted) {
  if (path === wanted) {
    return true;
  }
  const prefix = wanted.endsWith("/") ? wanted : `${wanted}/`;
  return path.startsWith(prefix);
}
var KEY_SEPARATOR = "";
var KEY_ABSENT = "";
function groupKey(grouping, message, path) {
  const part = (value) => value === null ? KEY_ABSENT : String(value);
  switch (grouping) {
    case "message":
      return [part(message.kind), part(message.text)].join(KEY_SEPARATOR);
    case "location":
      return [
        part(message.kind),
        part(message.text),
        part(message.file),
        part(message.line)
      ].join(KEY_SEPARATOR);
    case "test":
      return path;
    case "component":
      return part(message.component);
    case "kind":
      return message.kind;
  }
}
function groupFields(grouping, message, path) {
  switch (grouping) {
    case "message":
      return {
        kind: message.kind,
        text: message.text,
        file: null,
        line: null,
        component: null
      };
    case "location":
      return {
        kind: message.kind,
        text: message.text,
        file: message.file,
        line: message.line,
        component: message.component
      };
    case "test":
      return { kind: null, text: path, file: null, line: null, component: null };
    case "component":
      return {
        kind: null,
        text: null,
        file: null,
        line: null,
        component: message.component
      };
    case "kind":
      return { kind: message.kind, text: null, file: null, line: null, component: null };
  }
}
function kindTotals(file) {
  return Object.entries(file.markerCounts).map(([kind, count2]) => ({ kind, count: count2 })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

// lib/formats/status-entries.ts
var UnknownStatusGroupShapeError = class extends Error {
  // Written out rather than declared as constructor parameter properties:
  // `node --experimental-strip-types` erases types without emitting code, so
  // a parameter property has nowhere to be assigned and is rejected outright.
  status;
  keys;
  constructor(status, keys) {
    super(
      `status group for ${status} matches no known shape; keys: ${keys.length > 0 ? keys.join(", ") : "(none)"}`
    );
    this.name = "UnknownStatusGroupShapeError";
    this.status = status;
    this.keys = keys;
  }
};
function fields(group) {
  return group;
}
function statusGroupShape(group, status = "(unknown status)") {
  const g = fields(group);
  if (g["days"] === void 0) {
    if (Array.isArray(g["taskIdIds"]) && Array.isArray(g["durations"])) {
      return "flat";
    }
    throw new UnknownStatusGroupShapeError(status, Object.keys(g));
  }
  if (g["counts"] !== void 0) {
    return g["jobNameIds"] !== void 0 ? "skip-counts" : "counts";
  }
  if (g["durations"] !== void 0) {
    return "durations";
  }
  if (g["taskIdIds"] !== void 0) {
    return "task-ids";
  }
  throw new UnknownStatusGroupShapeError(status, Object.keys(g));
}
var MisalignedStatusGroupError = class extends Error {
  // Written out rather than declared as constructor parameter properties:
  // `node --experimental-strip-types` erases types without emitting code, so
  // a parameter property has nowhere to be assigned and is rejected outright.
  status;
  lengths;
  constructor(status, lengths) {
    const described = Object.entries(lengths).map(([key, length]) => `${key}=${length}`).join(", ");
    super(`status group for ${status} has misaligned parallel arrays: ${described}`);
    this.name = "MisalignedStatusGroupError";
    this.status = status;
    this.lengths = lengths;
  }
};
var PARALLEL_KEYS = [
  "days",
  "counts",
  "taskIdIds",
  "durations",
  "timestamps",
  "jobNameIds",
  "messageIds",
  "crashSignatureIds",
  "minidumps"
];
function entryCount(group, shape, status = "(unknown status)") {
  const g = fields(group);
  const lengths = {};
  for (const key of PARALLEL_KEYS) {
    const value = g[key];
    if (Array.isArray(value)) {
      lengths[key] = value.length;
    }
  }
  const distinct = new Set(Object.values(lengths));
  if (distinct.size > 1) {
    throw new MisalignedStatusGroupError(status, lengths);
  }
  const days = lengths["days"];
  if (days !== void 0) {
    return days;
  }
  switch (shape ?? statusGroupShape(group, status)) {
    case "flat":
    case "task-ids":
      return requireArray(g["taskIdIds"], "taskIdIds", status).length;
    case "counts":
    case "skip-counts":
      return requireArray(g["counts"], "counts", status).length;
    case "durations":
      return requireArray(g["durations"], "durations", status).length;
  }
}
function requireArray(value, key, status) {
  if (!Array.isArray(value)) {
    throw new UnknownStatusGroupShapeError(status, [`${key} is ${typeof value}, not an array`]);
  }
  return value;
}
function at(array, i, key, status) {
  const value = array[i];
  if (value === void 0) {
    throw new MisalignedStatusGroupError(status, { [key]: array.length, index: i });
  }
  return value;
}
function nestedAt(array, i, key, status) {
  const value = at(array, i, key, status);
  if (!Array.isArray(value)) {
    throw new UnknownStatusGroupShapeError(status, [
      `${key}[${i}] is ${typeof value}, expected an array of per-run values`
    ]);
  }
  return value;
}
function totalRuns(group, status = "(unknown status)") {
  const g = fields(group);
  switch (statusGroupShape(group, status)) {
    case "flat":
      return g["taskIdIds"].length;
    case "counts":
    case "skip-counts":
      return g["counts"].reduce((sum, n) => sum + n, 0);
    case "durations":
      return g["durations"].reduce((sum, b) => sum + b.length, 0);
    case "task-ids":
      return g["taskIdIds"].reduce((sum, b) => sum + b.length, 0);
  }
}
function* iterateStatusGroup(group, status, tables, options = {}) {
  const shape = statusGroupShape(group, status);
  const g = fields(group);
  const rawDays = g["days"];
  const messageIds = g["messageIds"];
  const crashSignatureIds = g["crashSignatureIds"];
  const rawMinidumps = g["minidumps"];
  const jobNameIds = g["jobNameIds"];
  const decorate = (entry, i) => {
    if (messageIds !== void 0) {
      const id = messageIds[i];
      entry.message = id === null || id === void 0 ? null : lookupRequiredTable(tables.messages, id, "tables.messages");
    }
    if (crashSignatureIds !== void 0) {
      const id = crashSignatureIds[i];
      entry.crashSignature = id === null || id === void 0 ? null : lookupRequiredTable(
        tables.crashSignatures,
        id,
        "tables.crashSignatures"
      );
    }
    return entry;
  };
  const jobNameAt = (i) => {
    const id = jobNameIds?.[i];
    if (id === void 0) {
      throw new TableIndexError("jobNameIds", i, jobNameIds?.length ?? 0);
    }
    return lookupRequiredTable(tables.jobNames, id, "tables.jobNames");
  };
  let day = 0;
  let timestamp = options.startTime ?? 0;
  const length = entryCount(group, shape, status);
  for (let i = 0; i < length; i++) {
    if (rawDays !== void 0) {
      day += at(rawDays, i, "days", status);
    }
    const dayValue = rawDays !== void 0 ? day : null;
    switch (shape) {
      case "flat": {
        const taskIdIds = g["taskIdIds"];
        const durations = g["durations"];
        const timestamps = g["timestamps"];
        const taskIdIndex = at(taskIdIds, i, "taskIdIds", status);
        const entry = {
          day: dayValue,
          count: 1,
          index: i,
          taskIdIndexes: [taskIdIndex],
          taskIds: [
            lookupRequiredTable(tables.taskIds, taskIdIndex, "tables.taskIds")
          ],
          durations: [at(durations, i, "durations", status)]
        };
        if (timestamps !== void 0) {
          timestamp += at(timestamps, i, "timestamps", status);
          entry.timestamps = [timestamp];
        }
        if (rawMinidumps !== void 0) {
          entry.minidumps = [
            at(rawMinidumps, i, "minidumps", status)
          ];
        }
        yield decorate(entry, i);
        break;
      }
      case "counts": {
        const counts = g["counts"];
        yield decorate(
          { day: dayValue, count: at(counts, i, "counts", status), index: i },
          i
        );
        break;
      }
      case "skip-counts": {
        const counts = g["counts"];
        yield decorate(
          {
            day: dayValue,
            count: at(counts, i, "counts", status),
            index: i,
            jobName: jobNameAt(i)
          },
          i
        );
        break;
      }
      case "durations": {
        const bucket = nestedAt(
          g["durations"],
          i,
          "durations",
          status
        );
        yield decorate(
          {
            day: dayValue,
            count: bucket.length,
            index: i,
            jobName: jobNameAt(i),
            durations: bucket.slice()
          },
          i
        );
        break;
      }
      case "task-ids": {
        const indexes = nestedAt(
          g["taskIdIds"],
          i,
          "taskIdIds",
          status
        );
        const entry = {
          day: dayValue,
          count: indexes.length,
          index: i,
          taskIdIndexes: indexes.slice(),
          taskIds: indexes.map(
            (id) => lookupRequiredTable(tables.taskIds, id, "tables.taskIds")
          )
        };
        if (rawMinidumps !== void 0) {
          entry.minidumps = nestedAt(
            rawMinidumps,
            i,
            "minidumps",
            status
          ).slice();
        }
        yield decorate(entry, i);
        break;
      }
    }
  }
}
function* statusGroupsOfTest(testRuns, statuses, testId) {
  const perTest = testRuns[testId];
  if (!perTest) {
    return;
  }
  for (let statusId = 0; statusId < perTest.length; statusId++) {
    const group = perTest[statusId];
    if (!group) {
      continue;
    }
    const status = statuses[statusId];
    if (status === void 0) {
      throw new TableIndexError("tables.statuses", statusId, statuses.length);
    }
    yield { statusId, status, group };
  }
}

// lib/formats/decode.ts
function decodeTimingFile(input) {
  const { tables, testInfo, testRuns } = input;
  let byPath;
  return {
    family: input.family,
    days: input.days,
    endDate: input.endDate,
    statuses: tables.statuses,
    testCount: testInfo.testPathIds.length,
    findTest(fullPath) {
      byPath ??= indexTestsByPath(tables, testInfo);
      const testId = byPath.get(fullPath);
      return testId === void 0 ? null : readTest(tables, testInfo, testId);
    },
    testAt(testId) {
      return readTest(tables, testInfo, testId);
    },
    *runsOfTest(testId) {
      for (const ref of statusGroupsOfTest(testRuns, tables.statuses, testId)) {
        for (const entry of iterateStatusGroup(
          ref.group,
          ref.status,
          tables,
          input.iterateOptions ?? {}
        )) {
          yield { ...entry, status: ref.status, statusId: ref.statusId };
        }
      }
    },
    totalsByStatus(testId) {
      const totals = /* @__PURE__ */ new Map();
      for (const ref of statusGroupsOfTest(testRuns, tables.statuses, testId)) {
        totals.set(
          ref.status,
          (totals.get(ref.status) ?? 0) + totalRuns(ref.group, ref.status)
        );
      }
      return totals;
    },
    jobNameOfTaskIndex(taskIdIndex) {
      const jobNameIds = input.taskJobNameIds;
      if (jobNameIds === void 0) {
        return null;
      }
      const jobNameId = jobNameIds[taskIdIndex];
      if (jobNameId === void 0) {
        throw new TableIndexError("taskInfo.jobNameIds", taskIdIndex, jobNameIds.length);
      }
      if (tables.jobNames === void 0) {
        throw new Error("tables.jobNames is needed to name a job but was not supplied");
      }
      return lookup(tables.jobNames, jobNameId, "tables.jobNames");
    }
  };
}

// lib/formats/buckets.ts
var BUCKET_COUNT = 64;
function decodeBucket(file) {
  return decodeTimingFile({
    family: "bucket",
    days: file.metadata.days,
    endDate: file.metadata.endDate,
    tables: file.tables,
    testInfo: file.testInfo,
    testRuns: file.testRuns,
    taskJobNameIds: file.taskInfo.jobNameIds
  });
}
function bucketIndexForPath(fullPath, totalBuckets = BUCKET_COUNT) {
  let hash = 0;
  for (let i = 0; i < fullPath.length; i++) {
    hash = (hash << 5) - hash + fullPath.charCodeAt(i) | 0;
  }
  return (hash % totalBuckets + totalBuckets) % totalBuckets;
}
function bucketFileSuffix(bucketIndex) {
  return bucketIndex.toString(16).padStart(2, "0");
}
function chunkOfTask(file, taskIdIndex) {
  return file.taskInfo.chunks?.[taskIdIndex] ?? null;
}

// lib/formats/issues.ts
function decodeIssues(file) {
  return decodeTimingFile({
    family: "issues",
    days: file.metadata.days,
    endDate: file.metadata.endDate,
    tables: file.tables,
    testInfo: file.testInfo,
    testRuns: file.testRuns
  });
}

// lib/query/test-lookup.ts
function searchTerms(query) {
  return query.toLowerCase().split(/\s+/).filter((term) => term !== "");
}
function matchesTerms(path, terms) {
  const lower = path.toLowerCase();
  return terms.every((term) => lower.includes(term));
}
function matchTestPaths(allTests, query, limit) {
  const terms = searchTerms(query);
  if (terms.length === 0) {
    return { matches: [], total: 0, truncated: false };
  }
  const matches = [];
  let total = 0;
  for (const path of allTests) {
    if (!matchesTerms(path, terms)) {
      continue;
    }
    total++;
    if (matches.length < limit) {
      matches.push(path);
    }
  }
  return { matches, total, truncated: total > matches.length };
}
var CANDIDATE_LIMIT = 50;
function collectTestPaths(files) {
  const paths = /* @__PURE__ */ new Set();
  for (const file of files) {
    if (file === null) {
      continue;
    }
    const { testPaths, testNames } = file.tables;
    const { testPathIds, testNameIds } = file.testInfo;
    for (let i = 0; i < testPathIds.length; i++) {
      const name = testNames[testNameIds[i]];
      if (name === void 0) {
        continue;
      }
      paths.add(joinTestPath(testPaths[testPathIds[i]] ?? "", name));
    }
  }
  return [...paths].sort();
}
async function findInEitherHarness(testPath, explicitHarness, loaders) {
  const first = explicitHarness ?? detectHarness(testPath);
  const attempts = explicitHarness === void 0 ? [first, otherHarness(first)] : [first];
  for (const harness of attempts) {
    if (harness !== first) {
      loaders.onStep?.(`Not found in ${first}, trying ${harness}\u2026`);
    }
    const file = await loaders.loadBucket(harness, testPath);
    const identity = file === null ? null : file.decoded.findTest(testPath);
    if (file !== null && identity !== null) {
      return { file, identity, harness, viaOtherHarness: harness !== first };
    }
  }
  return null;
}
async function resolveTest(query, explicitHarness, loaders) {
  const inferredHarness = explicitHarness === void 0;
  const first = explicitHarness ?? detectHarness(query);
  const searched = inferredHarness ? [first, otherHarness(first)] : [first];
  const direct = await findInEitherHarness(query, explicitHarness, loaders);
  if (direct !== null) {
    return {
      kind: "found",
      testPath: query,
      harness: direct.harness,
      inferredHarness,
      viaOtherHarness: direct.viaOtherHarness,
      resolvedFrom: null,
      file: direct.file,
      identity: direct.identity
    };
  }
  loaders.onStep?.("Test not found, looking for a unique match\u2026");
  let allTests;
  try {
    allTests = await loaders.loadAllTestPaths();
  } catch {
    return { kind: "unknown", query, searched, allTests: null };
  }
  const { matches, total, truncated } = matchTestPaths(allTests, query, CANDIDATE_LIMIT);
  if (matches.length === 0) {
    return { kind: "unknown", query, searched, allTests };
  }
  if (total === 1) {
    const match = matches[0];
    const resolved = await findInEitherHarness(match, explicitHarness, loaders);
    if (resolved !== null) {
      return {
        kind: "found",
        testPath: match,
        harness: resolved.harness,
        inferredHarness,
        viaOtherHarness: resolved.viaOtherHarness,
        // Null when the match is what was typed, which steps 1-2 can
        // still miss on a stale bucket the re-lookup then finds. Without
        // this, the page redirects to the URL it is already on.
        resolvedFrom: match === query ? null : query,
        file: resolved.file,
        identity: resolved.identity
      };
    }
    return { kind: "not-in-file", query, testPath: match, searched, allTests };
  }
  return { kind: "ambiguous", query, candidates: matches, total, truncated, allTests };
}

// cli/data.ts
function testLookupLoaders(context) {
  const missingFiles = [];
  return {
    missingFiles,
    async loadBucket(harness, testPath) {
      const suffix = bucketFileSuffix(bucketIndexForPath(testPath));
      const name = {
        index: timingsIndex(harness),
        filename: `${harness}-${suffix}.json`
      };
      try {
        const raw = await fetchJson(context.source, name);
        return { raw, decoded: decodeBucket(raw) };
      } catch (error) {
        if (error instanceof DataFileNotFoundError) {
          missingFiles.push(name.filename);
          return null;
        }
        throw error;
      }
    },
    async loadAllTestPaths() {
      const files = await Promise.all(
        ["xpcshell", "mochitest"].map(async (harness) => {
          try {
            return await fetchJson(context.source, {
              index: timingsIndex(harness),
              filename: `${harness}-issues.json`
            });
          } catch (error) {
            if (error instanceof DataFileNotFoundError) {
              return null;
            }
            throw error;
          }
        })
      );
      if (files.every((file) => file === null)) {
        throw new DataFileNotFoundError({
          index: timingsIndex("xpcshell"),
          filename: "xpcshell-issues.json"
        });
      }
      return collectTestPaths(files);
    },
    onStep: (message) => {
      progress(context, message);
    }
  };
}
async function loadIssues(context, harness) {
  const name = {
    index: timingsIndex(harness),
    filename: `${harness}-issues.json`
  };
  const raw = await fetchJson(context.source, name);
  return { file: decodeIssues(raw), raw, name };
}
async function loadIndex(context, harness) {
  return fetchJson(context.source, {
    index: timingsIndex(harness),
    filename: "index.json"
  });
}
function resolveDayWindow(globals, file) {
  const days = file.days;
  if (days === null) {
    return {
      range: null,
      startDate: file.endDate,
      endDate: file.endDate,
      dayCount: 1,
      singleDay: true,
      reason: "whole-window"
    };
  }
  const oldest = dateOfDayIndex(file.endDate, days, 0);
  if (globals.day !== void 0) {
    const wanted = resolveDayKeyword(globals.day, file.endDate);
    const index = dayIndexOfDate(file.endDate, days, wanted);
    if (index === null) {
      throw notFoundError(
        `no data for ${wanted}: the published window is ${oldest} \u2026 ${file.endDate} (${days} days)`,
        "Older data is not fetchable today \u2014 the index publishes a rolling window. Run `fx-tests dates` to see what is available."
      );
    }
    return {
      range: { from: index, to: index },
      startDate: wanted,
      endDate: wanted,
      dayCount: 1,
      singleDay: true,
      reason: "day"
    };
  }
  if (globals.since !== void 0) {
    const wanted = Math.min(globals.since, days);
    const from = days - wanted;
    return {
      range: { from, to: days - 1 },
      startDate: dateOfDayIndex(file.endDate, days, from),
      endDate: file.endDate,
      dayCount: wanted,
      singleDay: wanted === 1,
      reason: "since"
    };
  }
  return {
    range: null,
    startDate: oldest,
    endDate: file.endDate,
    dayCount: days,
    singleDay: days === 1,
    reason: "whole-window"
  };
}
function resolveDayKeyword(day, endDate) {
  if (day === "today" || day === "latest") {
    return endDate;
  }
  if (day === "yesterday") {
    return addDays(endDate, -1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw usageError(
      `--day expects YYYY-MM-DD, "today" or "yesterday", got "${day}"`
    );
  }
  return day;
}
function addDays(date, offset) {
  const parsed = /* @__PURE__ */ new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + offset);
  return parsed.toISOString().slice(0, 10);
}
function dateOfDayIndex(endDate, days, dayIndex) {
  return addDays(endDate, -(days - 1 - dayIndex));
}
function dayIndexOfDate(endDate, days, date) {
  const end = Date.parse(`${endDate}T00:00:00Z`);
  const wanted = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(end) || Number.isNaN(wanted)) {
    return null;
  }
  const daysBack = Math.round((end - wanted) / 864e5);
  const index = days - 1 - daysBack;
  return index >= 0 && index < days ? index : null;
}

// cli/commands/errors.ts
var ERRORS_OPTIONS = {
  message: {
    type: "string",
    placeholder: "<substring>",
    describe: "Only messages whose text contains this."
  },
  kind: {
    type: "string",
    placeholder: "<name>",
    describe: "Only this marker kind. Names come from the file, not a fixed list."
  },
  test: {
    type: "string",
    placeholder: "<path>",
    describe: "Only this test, by full path or directory prefix."
  },
  component: {
    type: "string",
    placeholder: "<substring>",
    describe: "Only messages whose Bugzilla component contains this."
  },
  file: {
    type: "string",
    placeholder: "<substring>",
    describe: "Only messages whose source file contains this."
  },
  "group-by": {
    type: "string",
    placeholder: "<message|location|test|component|kind>",
    describe: "How to group rows. Default location: file and line as well as text."
  },
  sort: {
    type: "string",
    placeholder: "<occurrences|tests>",
    describe: "Rank by total occurrences (default) or by how many tests saw it."
  },
  "task-ids": { type: "boolean", describe: "Print the task IDs behind each row." }
};
var DEFAULT_LIMIT = 20;
var MAX_WINDOW_PROBE = 21;
async function runErrors(context, args) {
  if (args.positionals.length > 0) {
    throw usageError(
      `errors takes no positional arguments, got "${args.positionals[0]}"`,
      "Filter with --message, --kind, --test, --component or --file."
    );
  }
  const harness = context.globals.harness ?? "mochitest";
  if (context.globals.config.length > 0 || context.globals.excludeConfig.length > 0) {
    throw usageError(
      `--config cannot be applied to ${harness}-<date>-errors.json: the file records no job names, so every configuration filter over it matches nothing`,
      "The errors files group markers by test and message, not by job. Use `fx-tests test <path> --config` for one test, which reads a bucket file."
    );
  }
  const grouping = readGrouping(args);
  const sort = readSort(args);
  const loaded = await loadErrorsFile(context, harness);
  const decoded = decodeErrors(loaded.file);
  const kindOption = stringOption(args, "kind");
  if (kindOption !== void 0 && !decoded.markerNames.includes(kindOption)) {
    throw usageError(
      `no marker kind "${kindOption}" in ${harness} ${loaded.date}`,
      `This file carries: ${decoded.markerNames.join(", ")}.`
    );
  }
  const ranking = rankErrors(decoded, {
    grouping,
    sort,
    ...optional("message", stringOption(args, "message")),
    ...optional("kind", kindOption),
    ...optional("test", stringOption(args, "test")),
    ...optional("component", stringOption(args, "component")),
    ...optional("file", stringOption(args, "file"))
  });
  const limit = context.globals.limit ?? DEFAULT_LIMIT;
  const shown = applyLimit(ranking.rows, limit);
  const wantTaskIds = boolOption(args, "task-ids");
  const result = {
    harness,
    date: loaded.date,
    weekday: weekdayOf(loaded.date),
    weekend: isWeekend(loaded.date),
    metadata: {
      generatedAt: decoded.generatedAt,
      jobCount: decoded.jobCount,
      processedJobCount: decoded.processedJobCount,
      invalidJobCount: decoded.invalidJobCount,
      dataSource: context.source.name
    },
    availableDates: loaded.availableDates,
    availableDatesArePartial: loaded.partial,
    failingTestsOnly: harness === "xpcshell",
    markerCounts: kindTotals(decoded),
    markerNames: [...decoded.markerNames],
    totals: {
      matched: ranking.totals.matchedCount,
      file: ranking.totals.fileCount,
      matchedGroups: ranking.totals.matchedGroups
    },
    grouping,
    sort,
    rowCount: ranking.rows.length,
    // Task IDs are decoded only for the rows that will be shown: doing it
    // for tens of thousands of dropped rows would allocate for nothing.
    rows: shown.map((row) => toRowJson(row, wantTaskIds ? decoded : null))
  };
  if (context.globals.format === "json") {
    emit(context, toJson(result));
    return;
  }
  emit(
    context,
    context.globals.format === "markdown" ? renderMarkdown4(result) : renderText4(result)
  );
}
function optional(key, value) {
  return value === void 0 ? {} : { [key]: value };
}
function readGrouping(args) {
  const value = stringOption(args, "group-by") ?? "location";
  const allowed = ["message", "location", "test", "component", "kind"];
  if (!allowed.includes(value)) {
    throw usageError(`--group-by expects one of ${allowed.join(", ")}, got "${value}"`);
  }
  return value;
}
function readSort(args) {
  const value = stringOption(args, "sort") ?? "occurrences";
  if (value !== "occurrences" && value !== "tests") {
    throw usageError(`--sort expects occurrences or tests, got "${value}"`);
  }
  return value;
}
async function loadErrorsFile(context, harness) {
  const index = await loadIndex(context, harness);
  const indexDates = [...index.dates].sort((a, b) => b.localeCompare(a));
  if (context.globals.day !== void 0) {
    const wanted = resolveErrorsDay(context.globals.day, indexDates);
    const name = errorsFileName(harness, wanted);
    progress(context, `Reading ${name.filename}\u2026`);
    try {
      const file = await fetchJson(context.source, name);
      return { file, date: wanted, availableDates: [wanted], partial: true };
    } catch (error) {
      if (error instanceof DataFileNotFoundError) {
        const available = await probeAvailableDates(context, harness, indexDates);
        throw notFoundError(
          `no ${harness} errors data for ${wanted}: ${name.filename} is not published.`,
          available.dates.length === 0 ? "No errors file exists for any date in the window. The errors files are published for only a few of the dates `fx-tests dates` lists." : `Errors data exists for ${available.dates.length} of the ${indexDates.length} dates in the window: ${available.dates.join(", ")}.`
        );
      }
      throw error;
    }
  }
  const limit = Math.min(indexDates.length, MAX_WINDOW_PROBE);
  for (let i = 0; i < limit; i++) {
    const date = indexDates[i];
    const name = errorsFileName(harness, date);
    progress(context, `Reading ${name.filename}\u2026`);
    try {
      const file = await fetchJson(context.source, name);
      return { file, date, availableDates: [date], partial: true };
    } catch (error) {
      if (error instanceof DataFileNotFoundError) {
        continue;
      }
      throw error;
    }
  }
  throw notFoundError(
    `no ${harness} errors data published for any of the ${indexDates.length} dates in the window`,
    "The errors files are published for only some dates. Run `fx-tests dates` for the window, and note that a date being listed there does not mean it has errors data."
  );
}
async function probeAvailableDates(context, harness, dates) {
  const found = [];
  const limit = Math.min(dates.length, MAX_WINDOW_PROBE);
  for (let i = 0; i < limit; i++) {
    try {
      await context.source.fetch(errorsFileName(harness, dates[i]));
      found.push(dates[i]);
    } catch (error) {
      if (error instanceof DataFileNotFoundError) {
        continue;
      }
      throw error;
    }
  }
  return { dates: found, partial: limit < dates.length };
}
function errorsFileName(harness, date) {
  return { index: timingsIndex(harness), filename: `${harness}-${date}-errors.json` };
}
function resolveErrorsDay(day, indexDates) {
  if (day === "today" || day === "latest" || day === "yesterday") {
    const newest = indexDates[0];
    if (newest === void 0) {
      throw notFoundError(`the index lists no dates, so --day ${day} cannot be resolved`);
    }
    return day === "yesterday" ? addDays(newest, -1) : newest;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw usageError(`--day expects YYYY-MM-DD, "today" or "yesterday", got "${day}"`);
  }
  return day;
}
function toRowJson(row, file) {
  const json = {
    kind: row.kind,
    text: row.text,
    file: row.file,
    line: row.line,
    component: row.component,
    count: row.count,
    testCount: row.testCount,
    tests: row.tests.map((entry) => ({ path: entry.path, count: entry.count })),
    components: row.components.map((share) => ({
      component: share.component,
      count: share.count
    })),
    componentSummary: componentSummary(row.components)
  };
  if (file !== null) {
    const seen = /* @__PURE__ */ new Set();
    for (const groupId of row.groupIds) {
      for (const raw of file.taskIdsOfGroup(groupId)) {
        const { taskId, retryId } = parseTaskId(raw);
        seen.add(`${taskId}.${retryId}`);
      }
    }
    json.taskIds = [...seen];
  }
  return json;
}
function renderText4(result) {
  const lines = [];
  lines.push(...headerLines(result));
  lines.push("");
  if (result.rows.length === 0) {
    lines.push("No markers matched.");
    lines.push(
      `  The file holds ${count(result.totals.file)} markers, so this is a filter with no matches rather than an empty file.`
    );
    lines.push("");
    lines.push(...footerLines(result));
    return joinLines(lines);
  }
  lines.push(
    ...table(
      [
        { header: "occurrences", align: "right" },
        { header: "tests", align: "right" },
        { header: result.grouping === "test" ? "test" : "message" }
      ],
      result.rows.map((row) => [
        count(row.count),
        count(row.testCount),
        truncate(oneLine(describeRow(row)), 88)
      ])
    )
  );
  lines.push(moreLine(result.rowCount, result.rows.length));
  const located = result.rows.filter((row) => locationOf(row) !== null);
  if (located.length > 0) {
    lines.push("");
    lines.push("Where they come from");
    lines.push(
      ...labelledLines(
        located.map((row) => [
          truncate(oneLine(describeRow(row)), 52),
          truncate(locationOf(row), 60)
        ])
      )
    );
  }
  const summarized = result.rows.filter(
    (row) => row.componentSummary !== null && componentBlockApplies(result.grouping)
  );
  if (summarized.length > 0) {
    lines.push("");
    lines.push("Which components");
    lines.push(
      ...labelledLines(
        summarized.map((row) => [
          truncate(oneLine(describeRow(row)), 52),
          truncate(row.componentSummary, 60)
        ])
      )
    );
  }
  if (result.rows.length <= 3) {
    for (const row of result.rows) {
      if (row.tests.length === 0) {
        continue;
      }
      lines.push("");
      lines.push(`  ${spreadVerdict(row)}`);
      for (const test of row.tests.slice(0, 5)) {
        lines.push(
          `    ${count(test.count).padStart(9)}  ${displayTestPath(test.path)}`
        );
      }
      if (row.testCount > 5) {
        lines.push(`    \u2026 ${count(row.testCount - 5)} more tests`);
      }
      if (componentBlockApplies(result.grouping) && row.components.length > 1) {
        lines.push("");
        lines.push(`  Components \u2014 ${row.componentSummary}`);
        for (const line of componentBreakdownLines(row.components)) {
          lines.push(`    ${line}`);
        }
      }
    }
  }
  if (result.rows.some((row) => row.taskIds !== void 0)) {
    lines.push("");
    lines.push("Task IDs");
    for (const row of result.rows) {
      if (row.taskIds === void 0) {
        continue;
      }
      lines.push(`  ${truncate(oneLine(describeRow(row)), 76)}`);
      lines.push(`    ${row.taskIds.slice(0, 8).join(" ")}`);
      if (row.taskIds.length > 8) {
        lines.push(`    \u2026 ${count(row.taskIds.length - 8)} more`);
      }
    }
  }
  lines.push("");
  lines.push(...footerLines(result));
  return joinLines(lines);
}
function componentBlockApplies(grouping) {
  return grouping !== "component" && grouping !== "kind";
}
function spreadVerdict(row) {
  const head = `${count(row.count)} occurrences in ${count(row.testCount)} test${row.testCount === 1 ? "" : "s"}`;
  if (row.testCount === 1) {
    return `${head} \u2014 specific to that test, not ambient noise`;
  }
  if (row.testCount >= 50) {
    return `${head} \u2014 ambient: spread this wide is background noise, not a lead`;
  }
  return head;
}
function headerLines(result) {
  const lines = [];
  lines.push(
    `${result.harness}, ${dateWithWeekday(result.date)} \u2014 ${count(result.metadata.jobCount)} jobs, ${count(result.totals.file)} markers`
  );
  if (result.markerCounts.length > 0) {
    lines.push(
      "  " + result.markerCounts.map((entry) => `${entry.kind} ${count(entry.count)}`).join(" \xB7 ")
    );
  }
  if (result.weekend) {
    lines.push(
      "  Weekend: push volume drops several-fold, so these counts are a fraction of a"
    );
    lines.push("  weekday\u2019s and make a poor baseline. Prefer a weekday when comparing.");
  }
  if (result.failingTestsOnly) {
    lines.push(
      "  xpcshell replays a test\u2019s stdout only when it fails, so this file covers failing"
    );
    lines.push(
      "  tests only \u2014 a biased population, not a smaller sample. Use --harness mochitest"
    );
    lines.push("  to rank overall log noise.");
  }
  return lines;
}
function footerLines(result) {
  return [
    describeWindow(result),
    "  There is no multi-day errors aggregate, so \u201Cwas this error here when the test was",
    "  passing?\u201D means running this command for two dates and comparing. Compare weekday",
    "  against weekday \u2014 weekend volume is a fraction of a weekday\u2019s."
  ];
}
function describeWindow(result) {
  if (result.availableDatesArePartial) {
    return `Errors files exist for only a few of the dates \`fx-tests dates\` lists; this is ${result.date}. Pass --day <date> for another \u2014 a date with no errors file exits 2 and names the ones that have data.`;
  }
  return `Errors files exist for ${result.availableDates.length} of the dates in the window: ${result.availableDates.join(", ")}.`;
}
function describeRow(row) {
  if (row.text !== null) {
    return row.text === "" ? "(empty message text)" : row.text;
  }
  if (row.component !== null) {
    return row.component;
  }
  if (row.kind !== null) {
    return row.kind;
  }
  return "(no component recorded)";
}
function locationOf(row) {
  if (row.file !== null && row.line !== null) {
    return `${row.file}:${row.line}`;
  }
  if (row.file !== null) {
    return row.file;
  }
  if (row.line !== null) {
    return `line ${row.line} (no source file recorded)`;
  }
  return null;
}
function oneLine(value) {
  return value.replace(/\s*\r?\n\s*/g, " \u23CE ").trim();
}
function displayTestPath(path) {
  return path === "" ? "(not attributed to a test)" : path;
}
function renderMarkdown4(result) {
  const lines = [];
  lines.push(heading(`${result.harness} errors \u2014 ${dateWithWeekday(result.date)}`, 1));
  lines.push("");
  for (const line of headerLines(result).slice(1)) {
    lines.push(line.trim());
  }
  lines.push("");
  if (result.rows.length === 0) {
    lines.push("No markers matched.");
    lines.push("");
    lines.push(...footerLines(result).map((line) => line.trim()));
    return joinLines(lines);
  }
  const withComponents = componentBlockApplies(result.grouping);
  lines.push(
    ...table2(
      [
        { header: "occurrences", align: "right" },
        { header: "tests", align: "right" },
        { header: "message" },
        { header: "location" },
        ...withComponents ? [{ header: "components" }] : []
      ],
      result.rows.map((row) => [
        count(row.count),
        count(row.testCount),
        oneLine(describeRow(row)),
        locationOf(row) ?? "",
        ...withComponents ? [row.componentSummary ?? ""] : []
      ])
    )
  );
  lines.push(moreLine2(result.rowCount, result.rows.length));
  lines.push("");
  lines.push(...footerLines(result).map((line) => line.trim()));
  return joinLines(lines);
}

// lib/model/status.ts
function splitExecutionMode(status) {
  if (status.endsWith("-PARALLEL")) {
    return { base: status.slice(0, -"-PARALLEL".length), mode: "parallel" };
  }
  if (status.endsWith("-SEQUENTIAL")) {
    return { base: status.slice(0, -"-SEQUENTIAL".length), mode: "sequential" };
  }
  return { base: status, mode: null };
}
function classifyStatus(status) {
  const { base, mode } = splitExecutionMode(status);
  return { kind: classifyBase(base), mode, raw: status };
}
function classifyBase(base) {
  switch (base) {
    case "PASS":
    // The harness's own name for a passing xpcshell test. Not observed in
    // the published files, but `common-test-data.js:155` treats it as a
    // pass and the cost of agreeing is a line.
    case "OK":
      return "pass";
    case "FAIL":
      return "fail";
    case "TIMEOUT":
      return "timeout";
    case "CRASH":
      return "crash";
    case "SKIP":
      return "skip";
    case "EXPECTED-FAIL":
      return "expected-fail";
    case "UNKNOWN":
      return "unknown";
    default:
      return "unknown";
  }
}

// lib/model/skips.ts
function skipReason(message) {
  if (message === null || message === void 0) {
    return "unrecorded";
  }
  if (message.startsWith("run-if")) {
    return "run-if";
  }
  if (message.startsWith("skip-if")) {
    return "skip-if";
  }
  return "other";
}
function displaySkipMessage(message) {
  return message.replace(/^skip-if:\s*/, "");
}

// lib/query/flakiness.ts
var DEFAULT_MIN_WINDOW_FAILURES = 1;
var MIN_FILTERABLE_DAYS = 2;
function testDays(file, testId, days) {
  const row = {
    fail: new Int32Array(days),
    pass: new Int32Array(days),
    skip: new Int32Array(days),
    windowFailures: 0
  };
  for (const entry of file.runsOfTest(testId)) {
    const day = entry.day ?? 0;
    if (day < 0 || day >= days) {
      continue;
    }
    switch (classifyStatus(entry.status).kind) {
      case "pass":
      case "expected-fail":
        row.pass[day] = row.pass[day] + entry.count;
        break;
      case "fail":
      case "timeout":
      case "crash":
        row.fail[day] = row.fail[day] + entry.count;
        row.windowFailures += entry.count;
        break;
      case "skip":
        if (skipReason(entry.message) !== "run-if") {
          row.skip[day] = row.skip[day] + entry.count;
        }
        break;
      case "unknown":
        break;
    }
  }
  return row;
}
function isNoise(row, minWindowFailures) {
  return row.windowFailures > 0 && row.windowFailures <= minWindowFailures;
}
function stateOn(row, day, neutralised) {
  const failed = neutralised ? 0 : row.fail[day];
  const passed = row.pass[day] + (neutralised ? row.fail[day] : 0);
  const skipped = row.skip[day];
  if (failed > 0) {
    return "flaky";
  }
  if (skipped > 0) {
    return "skipped";
  }
  return passed > 0 ? "stable" : null;
}
function wasSkipped(row, days, day, from = 0) {
  if (day !== null) {
    return (row.skip[day] ?? 0) > 0;
  }
  for (let index = from; index < days; index++) {
    if (row.skip[index] > 0) {
      return true;
    }
  }
  return false;
}
function windowState(row, days, neutralised, from = 0) {
  let sawSkip = false;
  let sawPass = false;
  for (let day = from; day < days; day++) {
    switch (stateOn(row, day, neutralised)) {
      case "flaky":
        return "flaky";
      case "skipped":
        sawSkip = true;
        break;
      case "stable":
        sawPass = true;
        break;
      case null:
        break;
    }
  }
  if (sawSkip) {
    return "skipped";
  }
  return sawPass ? "stable" : null;
}
function dateOfDay(startDate, day) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  if (Number.isNaN(start)) {
    return startDate;
  }
  return new Date(start + day * 864e5).toISOString().slice(0, 10);
}
function startDateOf(file) {
  const days = file.days ?? 1;
  const end = Date.parse(`${file.endDate}T00:00:00Z`);
  if (Number.isNaN(end)) {
    return file.endDate;
  }
  return new Date(end - (days - 1) * 864e5).toISOString().slice(0, 10);
}
function walk(file, options, testIds) {
  const days = file.days ?? 1;
  const minWindowFailures = days < MIN_FILTERABLE_DAYS ? 0 : options.minWindowFailures ?? DEFAULT_MIN_WINDOW_FAILURES;
  const rows2 = [];
  const neutralised = [];
  let neutralisedCount = 0;
  const ids = testIds ?? Array.from({ length: file.testCount }, (_unused, index) => index);
  for (const testId of ids) {
    const row = testDays(file, testId, days);
    const noise = isNoise(row, minWindowFailures);
    rows2.push(row);
    neutralised.push(noise);
    if (noise) {
      neutralisedCount++;
    }
  }
  return {
    rows: rows2,
    neutralised,
    neutralisedCount,
    days,
    startDate: startDateOf(file),
    minWindowFailures
  };
}
function selectTests(file, pathPrefix) {
  const ids = [];
  for (let testId = 0; testId < file.testCount; testId++) {
    if (pathPrefix !== void 0 && !file.testAt(testId).fullPath.startsWith(pathPrefix)) {
      continue;
    }
    ids.push(testId);
  }
  return ids;
}
function flakinessOverTime(file, options = {}) {
  const ids = selectTests(file, options.pathPrefix);
  const { rows: rows2, neutralised, neutralisedCount, days, startDate, minWindowFailures } = walk(
    file,
    options,
    ids
  );
  const series = [];
  for (let day = 0; day < days; day++) {
    const counts = { flaky: 0, stable: 0, skipped: 0 };
    for (let index = 0; index < rows2.length; index++) {
      const state = stateOn(rows2[index], day, neutralised[index]);
      if (state !== null) {
        counts[state]++;
      }
    }
    series.push({
      day,
      date: dateOfDay(startDate, day),
      ...counts,
      total: counts.flaky + counts.stable + counts.skipped
    });
  }
  return { days: series, neutralisedTests: neutralisedCount, minWindowFailures };
}
var THIN_DAY_SHARE = 0.1;
function thinDays(days) {
  const populations = days.map((day) => day.total).filter((total) => total > 0);
  if (populations.length === 0) {
    return days.map(() => false);
  }
  populations.sort((a, b) => a - b);
  const median = populations[Math.floor(populations.length / 2)];
  const floor = median * THIN_DAY_SHARE;
  return days.map((day) => day.total > 0 && day.total < floor);
}
function runningAverage(days, window = 7) {
  const half = Math.floor(window / 2);
  const thin = thinDays(days);
  return days.map((_unused, index) => {
    if (thin[index] === true) {
      return null;
    }
    let flaky = 0;
    let total = 0;
    for (let offset = -half; offset <= half; offset++) {
      const day = days[index + offset];
      if (day === void 0 || day.total === 0 || thin[index + offset] === true) {
        continue;
      }
      flaky += day.flaky;
      total += day.total;
    }
    return total === 0 ? null : flaky / total * 100;
  });
}
function flakinessByFolder(file, options = {}) {
  const ids = selectTests(file, options.pathPrefix);
  const { rows: rows2, neutralised, days } = walk(file, options, ids);
  const lastDay = days - 1;
  const day = options.day ?? lastDay;
  const fromDay = Math.max(0, Math.min(options.fromDay ?? 0, lastDay));
  const root = {
    path: "",
    name: "",
    flaky: 0,
    stable: 0,
    skipped: 0,
    flakyAndSkipped: 0,
    total: 0,
    testCount: 0,
    children: [],
    tests: []
  };
  const byPath = /* @__PURE__ */ new Map([["", root]]);
  for (let index = 0; index < ids.length; index++) {
    const row = rows2[index];
    const noise = neutralised[index];
    const state = options.allDays === true ? windowState(row, days, noise, fromDay) : stateOn(row, day, noise);
    if (state === null) {
      continue;
    }
    const skipped = wasSkipped(row, days, options.allDays === true ? null : day, fromDay);
    const both = state === "flaky" && skipped;
    const identity = file.testAt(ids[index]);
    const { directory } = identity;
    const segments = directory === "" ? [] : directory.split("/");
    let path = "";
    let node = root;
    const credit = (target) => {
      target[state]++;
      target.total++;
      if (both) {
        target.skipped++;
        target.flakyAndSkipped++;
      }
      target.testCount++;
    };
    credit(node);
    for (const segment of segments) {
      path = path === "" ? segment : `${path}/${segment}`;
      let child = byPath.get(path);
      if (child === void 0) {
        child = {
          path,
          name: segment,
          flaky: 0,
          stable: 0,
          skipped: 0,
          flakyAndSkipped: 0,
          total: 0,
          testCount: 0,
          children: [],
          tests: []
        };
        byPath.set(path, child);
        node.children.push(child);
      }
      credit(child);
      node = child;
    }
    const leaf = {
      fullPath: identity.fullPath,
      name: identity.fullPath.slice(identity.fullPath.lastIndexOf("/") + 1),
      flaky: 0,
      stable: 0,
      skipped: 0,
      flakyAndSkipped: both ? 1 : 0,
      // One test, so `total` is 1 — the exclusive verdict's bucket.
      total: 1,
      windowFailures: row.windowFailures,
      neutralised: noise
    };
    leaf[state]++;
    if (both) {
      leaf.skipped++;
    }
    node.tests.push(leaf);
  }
  sortTree(root);
  return root;
}
function sortTree(node) {
  node.children.sort((a, b) => b.flaky - a.flaky || a.path.localeCompare(b.path));
  node.tests.sort((a, b) => b.flaky - a.flaky || a.fullPath.localeCompare(b.fullPath));
  for (const child of node.children) {
    sortTree(child);
  }
}
var DEFAULT_AVERAGE_DAYS = 7;
function flakinessByFolderAveraged(file, options = {}) {
  const ids = selectTests(file, options.pathPrefix);
  const { rows: rows2, neutralised, days, startDate } = walk(file, options, ids);
  const wanted = options.averageDays ?? DEFAULT_AVERAGE_DAYS;
  const windowDays = Math.max(1, Math.min(wanted, days));
  const from = days - windowDays;
  const root = {
    path: "",
    name: "",
    flaky: 0,
    stable: 0,
    skipped: 0,
    flakyAndSkipped: 0,
    total: 0,
    testCount: 0,
    children: [],
    tests: []
  };
  const byPath = /* @__PURE__ */ new Map([["", root]]);
  for (let index = 0; index < ids.length; index++) {
    const row = rows2[index];
    const noise = neutralised[index];
    const identity = file.testAt(ids[index]);
    const counts = { flaky: 0, stable: 0, skipped: 0 };
    let skippedShare = 0;
    let bothShare = 0;
    let ranAtAll = false;
    for (let day = from; day < days; day++) {
      const state = stateOn(row, day, noise);
      if (state === null) {
        continue;
      }
      ranAtAll = true;
      counts[state]++;
      if (wasSkipped(row, days, day)) {
        skippedShare++;
        if (state === "flaky") {
          bothShare++;
        }
      }
    }
    if (!ranAtAll) {
      continue;
    }
    const { directory } = identity;
    const segments = directory === "" ? [] : directory.split("/");
    let path = "";
    let node = root;
    const credit = (target) => {
      target.flaky += counts.flaky;
      target.stable += counts.stable;
      target.total += counts.flaky + counts.stable + counts.skipped;
      target.skipped += skippedShare;
      target.flakyAndSkipped += bothShare;
      target.testCount++;
    };
    credit(node);
    for (const segment of segments) {
      path = path === "" ? segment : `${path}/${segment}`;
      let child = byPath.get(path);
      if (child === void 0) {
        child = {
          path,
          name: segment,
          flaky: 0,
          stable: 0,
          skipped: 0,
          flakyAndSkipped: 0,
          total: 0,
          testCount: 0,
          children: [],
          tests: []
        };
        byPath.set(path, child);
        node.children.push(child);
      }
      credit(child);
      node = child;
    }
    node.tests.push({
      fullPath: identity.fullPath,
      name: identity.fullPath.slice(identity.fullPath.lastIndexOf("/") + 1),
      flaky: counts.flaky,
      stable: counts.stable,
      skipped: skippedShare,
      flakyAndSkipped: bothShare,
      total: counts.flaky + counts.stable + counts.skipped,
      windowFailures: row.windowFailures,
      neutralised: noise
    });
  }
  const average = (node) => {
    node.flaky /= windowDays;
    node.stable /= windowDays;
    node.skipped /= windowDays;
    node.flakyAndSkipped /= windowDays;
    node.total /= windowDays;
    for (const leaf of node.tests) {
      leaf.flaky /= windowDays;
      leaf.stable /= windowDays;
      leaf.skipped /= windowDays;
      leaf.flakyAndSkipped /= windowDays;
      leaf.total /= windowDays;
    }
    for (const child of node.children) {
      average(child);
    }
  };
  average(root);
  sortTree(root);
  const dates = [];
  for (let day = from; day < days; day++) {
    dates.push(dateOfDay(startDate, day));
  }
  return { root, windowDays, dates };
}
function folderList(root) {
  const rows2 = [];
  const visit = (node, depth) => {
    if (node.path !== "" && node.tests.length > 0) {
      let selfFlaky = 0;
      let selfTotal = 0;
      let selfSkipped = 0;
      let selfFlakyAndSkipped = 0;
      for (const leaf of node.tests) {
        selfFlaky += leaf.flaky;
        selfTotal += leaf.total;
        selfSkipped += leaf.skipped;
        selfFlakyAndSkipped += leaf.flakyAndSkipped;
      }
      rows2.push({
        path: node.path,
        name: node.name,
        flaky: node.flaky,
        stable: node.stable,
        skipped: node.skipped,
        total: node.total,
        testCount: node.testCount,
        selfFlaky,
        selfTotal,
        selfSkipped,
        selfFlakyAndSkipped,
        selfTestCount: node.tests.length,
        depth
      });
    }
    for (const child of node.children) {
      visit(child, depth + 1);
    }
  };
  visit(root, -1);
  rows2.sort((a, b) => b.selfFlaky - a.selfFlaky || a.path.localeCompare(b.path));
  return rows2;
}
function subtreeTests(node) {
  const leaves = [];
  const visit = (current) => {
    leaves.push(...current.tests);
    for (const child of current.children) {
      visit(child);
    }
  };
  visit(node);
  return leaves;
}
function folderAt(root, path) {
  if (path === "") {
    return root;
  }
  let node = root;
  for (const segment of path.split("/")) {
    const child = node.children.find((entry) => entry.name === segment);
    if (child === void 0) {
      return null;
    }
    node = child;
  }
  return node;
}
function hasSomethingToAct(leaf) {
  return leaf.flaky > 0 || leaf.skipped > 0;
}

// cli/commands/flaky.ts
var FLAKY_NOTES = [
  "How a test is classified:",
  "  flaky    it failed, timed out or crashed at least once",
  "  skipped  it was disabled somewhere (run-if exclusions are not counted)",
  "",
  "The window:",
  "  The FOLDER views average per-day counts over the last 7 days, so a folder reading",
  `  187.0 means "on a typical day, 187 of this folder's tests were flaky". A whole`,
  "  number of weeks, because weekend push volume is 2.6x lower and one day's ranking is",
  "  otherwise partly the calendar: on the pinned window netwerk/test/unit reads 137",
  "  flaky on a Tuesday and 76 on a Sunday.",
  "  The PER-TEST view covers the SAME 7 days but does not average \u2014 a single test has",
  "  no meaningful mean \u2014 so it takes one verdict per test: flaky if flaky on ANY of",
  "  those days. Drilling into a ranked folder therefore stays inside the window it was",
  "  ranked over. The two numbers are still different quantities and both are right: on",
  "  the pinned window toolkit/components/telemetry/tests/unit ranks at 26.7 (a mean per",
  "  day) and lists 32 (distinct tests flaky at least once in the 7 days).",
  "  --day <date> takes one verdict on one named day instead. --all-days takes one over",
  "  the whole 21-day file, flaky if flaky on ANY day \u2014 a much looser bar, tree-wide",
  "  ~84% of tests, because a test runs on dozens of configs dozens of times a day.",
  "  Every run names the window it used in its header.",
  "",
  "Flaky and skipped OVERLAP:",
  "  A test failing on Linux and disabled on Windows is both, so the flaky and skip",
  "  columns do not sum to the test count \u2014 on the pinned window 800 of 4,807 tests are",
  "  in both. On the folder views flaky% is flaky/tests, not flaky/(flaky+skip). Rows are",
  "  ranked flaky-first, so a skipped-only test is never above a flaky one.",
  "",
  "Reading the columns:",
  "  Folder views rank a population, so they carry counts and a flaky% share of the",
  "  folder's tests, plus +subtree \u2014 the flaky count including subfolders.",
  "  The per-test view is one verdict per test over the window, as flaky.html shows it:",
  "    flaky        1 if it failed, timed out or crashed at all in the window, else 0",
  "    skipped      1 if it is disabled somewhere, else 0. A test can be both; 0 flaky",
  "                 with 1 skipped is switched off rather than failing.",
  "    failures     failing RUNS over the whole file window, across every configuration \u2014",
  "                 a different unit and window from the two verdicts, and what --noise",
  '                 is compared against. It is what separates "failed twice" from',
  '                 "failed 2,543 times".',
  "  There is no percentage on a single test: a percentage needs a population, and one",
  "  test can only be 0% or 100%. Use `fx-tests test <path>` for a per-configuration",
  "  breakdown of one test, or --json for the raw counters.",
  "",
  "--group-by days is the exception: its flaky, stable and skipped columns are mutually",
  "exclusive and do sum to total."
];
var FLAKY_OPTIONS = {
  path: {
    type: "string",
    placeholder: "<prefix>",
    describe: "Only tests under this directory prefix."
  },
  "group-by": {
    type: "string",
    placeholder: "<list|folder|days|tests>",
    describe: "How to group. Default list \u2014 folders ranked by their own flaky tests, the burndown view. `folder` rolls subtrees up; `days` is the trend; `tests` lists the individual test files under a path, which `fx-tests flaky <path>` also selects."
  },
  sort: {
    type: "string",
    placeholder: "<flaky|share|skips|tests|name>",
    describe: "How to rank. Default flaky."
  },
  "here-only": {
    type: "boolean",
    describe: "--group-by tests: only the files directly in the path, not its subfolders. The subtree is the default, because a folder ranking's answer is a directory and its subdirectories are part of the same job."
  },
  noise: {
    type: "number",
    placeholder: "<n>",
    describe: "Read a test failing this often or less over the window as passing. Default 1; 0 disables. Ignored on a single-day file."
  },
  "average-days": {
    type: "number",
    placeholder: "<n>",
    describe: "Average the per-day counts over this many days. Default 7; a multiple of 7 is strongly preferred, since weekend push volume is 2.6x lower."
  },
  "all-days": {
    type: "boolean",
    describe: "Classify over the whole window instead: flaky if flaky on ANY day. A much looser bar \u2014 tree-wide that is ~84% of tests. See the header it prints."
  }
};
var DEFAULT_LIMIT2 = 20;
var TREND_WINDOW = 7;
async function loadFlakyQuery(context, args) {
  const harness = context.globals.harness ?? "xpcshell";
  progress(context, `Reading ${harness}-issues.json\u2026`);
  const { file } = await loadIssues(context, harness);
  if (context.globals.config.length > 0 || context.globals.excludeConfig.length > 0) {
    throw usageError(
      `--config cannot be applied to ${harness}-issues.json: the file records no job names, so every configuration filter over it matches nothing`,
      "Flakiness here is a per-test verdict over all configurations. `fx-tests test <path> --config` reads a bucket file and can break one test down by configuration."
    );
  }
  const days = file.days ?? 1;
  const allDays = boolOption(args, "all-days");
  const requested = numberOption(args, "noise") ?? DEFAULT_MIN_WINDOW_FAILURES;
  const averageDays = numberOption(args, "average-days") ?? DEFAULT_AVERAGE_DAYS;
  if (averageDays < 1) {
    throw usageError(`--average-days expects at least 1, got ${averageDays}`);
  }
  if (allDays && args.options.has("average-days")) {
    throw usageError(
      "--all-days and --average-days are mutually exclusive",
      "--all-days is a single verdict over the whole window; --average-days averages per-day verdicts. Pick one."
    );
  }
  let day;
  if (context.globals.day !== void 0) {
    if (allDays) {
      throw usageError(
        "--day and --all-days are mutually exclusive",
        "--day classifies on one day; --all-days classifies over the whole window. They are the two ends of the choice, not a range."
      );
    }
    if (args.options.has("average-days")) {
      throw usageError(
        "--day and --average-days are mutually exclusive",
        "--day is one day; --average-days averages several. Drop --day to average."
      );
    }
    const wanted = resolveDayKeyword(context.globals.day, file.endDate);
    const index = dayIndexOfDate(file.endDate, days, wanted);
    if (index === null) {
      throw usageError(
        `no data for ${wanted}: ${harness}-issues.json covers ${dateOfIndex(file.endDate, days, 0)} \u2026 ${file.endDate} (${days} days)`,
        "Run `fx-tests dates` to see what is published."
      );
    }
    day = index;
  }
  const pathPrefix = stringOption(args, "path") ?? args.positionals[0];
  const series = flakinessOverTime(file, {
    minWindowFailures: requested,
    ...pathPrefix === void 0 ? {} : { pathPrefix }
  });
  const scope = allDays ? "all-days" : day !== void 0 ? "day" : "average";
  const effectiveAverage = Math.max(1, Math.min(averageDays, days));
  const scopeDates = scope === "day" ? [dateOfIndex(file.endDate, days, day)] : scope === "all-days" ? [dateOfIndex(file.endDate, days, 0), file.endDate] : Array.from(
    { length: effectiveAverage },
    (_unused, offset) => dateOfIndex(file.endDate, days, days - effectiveAverage + offset)
  );
  return {
    harness,
    file,
    pathPrefix,
    day,
    allDays,
    averageDays,
    minWindowFailures: series.minWindowFailures,
    header: {
      harness,
      family: file.family,
      startDate: dateOfIndex(file.endDate, days, 0),
      endDate: file.endDate,
      dayCount: days,
      testCount: file.testCount,
      dataSource: context.source.name,
      scope,
      // Asked for here by construction: this scope came from --day,
      // --all-days or the default average. `listingHeader` is the one place
      // that narrows a scope on the view's own behalf, and it clears this.
      scopeRequested: true,
      scopeDates,
      averageDays: scope === "average" ? effectiveAverage : null,
      minWindowFailures: series.minWindowFailures,
      requestedMinWindowFailures: requested,
      neutralisedTests: series.neutralisedTests,
      // The distinction `MIN_FILTERABLE_DAYS` documents: a caller who
      // asked for a filter on a one-day file gets the unfiltered
      // classification, and is told so rather than left to assume the
      // 366 tests it would have neutralised were quietly handled.
      noiseFilterSkipped: requested > 0 && series.minWindowFailures === 0
    }
  };
}
function dateOfIndex(endDate, days, index) {
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(end)) {
    return endDate;
  }
  return new Date(end - (days - 1 - index) * 864e5).toISOString().slice(0, 10);
}
async function runFlaky(context, args) {
  if (args.positionals.length > 1) {
    throw usageError(
      `flaky takes at most one path, got ${args.positionals.length}: ` + args.positionals.join(", ")
    );
  }
  const positional = args.positionals[0];
  if (positional !== void 0 && args.options.has("path")) {
    throw usageError(
      `flaky <path> and --path are the same selection, got "${positional}" and "${stringOption(args, "path")}"`,
      "Drop one. `fx-tests flaky <path>` is shorthand for `--path <path> --group-by tests`."
    );
  }
  const groupBy = readGroupBy(args);
  const sort = readSort2(args);
  if (positional !== void 0 && groupBy !== "tests") {
    throw usageError(
      `flaky <path> selects the per-test listing, which --group-by ${groupBy} is not`,
      `Use \`fx-tests flaky --path ${positional} --group-by ${groupBy}\` for that view.`
    );
  }
  if (args.options.has("here-only") && groupBy !== "tests") {
    throw usageError(
      `--here-only only applies to --group-by tests, not ${groupBy}`,
      "The folder views already report the folder's own tests and its subtree in separate columns."
    );
  }
  if (args.options.has("here-only") && positional === void 0 && !args.options.has("path")) {
    throw usageError(
      '--here-only needs a path: it means "not the subfolders of", and with no path there is nothing to exclude',
      "Drop --here-only for every test in the tree, or name a folder: fx-tests flaky <folder> --here-only."
    );
  }
  if (groupBy === "days" && args.options.has("sort")) {
    throw usageError(
      "--sort does not apply to --group-by days, which is ordered by date",
      "Drop --sort, or use --group-by list to rank folders."
    );
  }
  const query = await loadFlakyQuery(context, args);
  const limit = context.globals.limit ?? DEFAULT_LIMIT2;
  if (groupBy === "days") {
    emitResult(context, trendResult(query, context, limit), (result2) => renderTrend(result2));
    return;
  }
  if (groupBy === "tests") {
    emitResult(
      context,
      testResult(query, listingTree(query), boolOption(args, "here-only"), sort, limit),
      renderTests
    );
    return;
  }
  const root = classifiedTree(query);
  const rows2 = groupBy === "list" ? listRows(root) : treeRows(root);
  const sorted = sortRows(rows2, sort);
  const shown = applyLimit(sorted, limit);
  const result = {
    header: query.header,
    groupBy,
    sort,
    pathPrefix: query.pathPrefix ?? null,
    allDays: query.allDays,
    totals: {
      flaky: root.flaky,
      stable: root.stable,
      skipped: root.skipped,
      flakyAndSkipped: root.flakyAndSkipped,
      total: root.total,
      testCount: root.testCount
    },
    rowCount: sorted.length,
    rows: shown
  };
  emitResult(context, result, renderFolders);
}
function classifiedTree(query) {
  const noise = {
    minWindowFailures: query.header.requestedMinWindowFailures,
    ...query.pathPrefix === void 0 ? {} : { pathPrefix: query.pathPrefix }
  };
  return query.header.scope === "average" ? flakinessByFolderAveraged(query.file, {
    ...noise,
    averageDays: query.averageDays
  }).root : flakinessByFolder(query.file, {
    ...noise,
    ...query.allDays ? { allDays: true } : {},
    ...query.day === void 0 ? {} : { day: query.day }
  });
}
function listingTree(query) {
  const noise = { minWindowFailures: query.header.requestedMinWindowFailures };
  const days = query.file.days ?? 1;
  const window = query.header.scope === "average" ? { allDays: true, fromDay: days - (query.header.averageDays ?? days) } : {
    ...query.allDays ? { allDays: true } : {},
    ...query.day === void 0 ? {} : { day: query.day }
  };
  return flakinessByFolder(query.file, {
    ...noise,
    ...query.pathPrefix === void 0 ? {} : { pathPrefix: query.pathPrefix },
    ...window
  });
}
function listingHeader(header) {
  if (header.scope !== "average") {
    return header;
  }
  return {
    ...header,
    scope: "window",
    averageDays: null,
    scopeRequested: false
  };
}
function testResult(query, root, hereOnly, sort, limit) {
  const node = hereOnly && query.pathPrefix !== void 0 ? folderAt(root, query.pathPrefix) : root;
  const leaves = node === null ? [] : hereOnly ? node.tests : subtreeTests(node);
  const worth = leaves.filter(hasSomethingToAct);
  const rows2 = worth.map((leaf) => ({
    path: leaf.fullPath,
    verdict: leaf.flakyAndSkipped > 0 ? "flaky+skipped" : leaf.flaky > 0 ? "flaky" : "skipped",
    flaky: leaf.flaky,
    skipped: leaf.skipped,
    flakyAndSkipped: leaf.flakyAndSkipped,
    total: leaf.total,
    windowFailures: leaf.windowFailures,
    neutralised: leaf.neutralised
  }));
  const sorted = sortTestRows(rows2, sort);
  return {
    // Corrected to the scope this listing actually classified. See
    // `listingHeader`.
    header: listingHeader(query.header),
    groupBy: "tests",
    sort,
    pathPrefix: query.pathPrefix ?? null,
    hereOnly,
    cleanTests: leaves.length - worth.length,
    consideredTests: leaves.length,
    rowCount: sorted.length,
    rows: applyLimit(sorted, limit)
  };
}
function sortTestRows(rows2, sort) {
  const sorted = [...rows2];
  const byPath = (a, b) => a.path.localeCompare(b.path);
  const byWeight = (a, b) => b.windowFailures - a.windowFailures || byPath(a, b);
  switch (sort) {
    // `share` ranked on a percentage that no longer exists, and could not
    // meaningfully: a percentage of one test is 0% or 100%, which is the
    // `flaky` verdict restated. It ranks as `flaky` rather than being
    // rejected, since it stays valid on the folder views this flag is shared
    // with.
    case "flaky":
    case "share":
      sorted.sort((a, b) => b.flaky - a.flaky || b.skipped - a.skipped || byWeight(a, b));
      break;
    case "skips":
      sorted.sort((a, b) => b.skipped - a.skipped || b.flaky - a.flaky || byWeight(a, b));
      break;
    case "tests":
      sorted.sort(byWeight);
      break;
    case "name":
      sorted.sort(byPath);
      break;
  }
  return sorted;
}
function renderTests(result) {
  const sortColumn = {
    flaky: "flaky",
    // `share` ranked a percentage that is gone from this view; it orders as
    // `flaky` here and keeps its own column on the folder views.
    share: "flaky",
    skips: "skipped",
    tests: `failures ${result.header.dayCount}d`,
    name: "Test"
  };
  const column = (header, rest = {}) => ({
    header,
    ...rest,
    ...header === sortColumn[result.sort] ? { sort: result.sort === "name" ? "asc" : "desc" } : {}
  });
  const columns = [
    column("Test", { path: true }),
    column("flaky", { align: "right" }),
    column("skipped", { align: "right" }),
    column(`failures ${result.header.dayCount}d`, { align: "right" })
  ];
  return {
    preamble: headerLines2(result),
    table: {
      columns,
      rows: result.rows.map((row) => [
        row.path,
        count(row.flaky),
        count(row.skipped),
        count(row.windowFailures)
      ])
    },
    total: result.rowCount,
    shown: result.rows.length,
    epilogue: testEpilogue(result),
    empty: testEmptyMessage(result)
  };
}
function suggestion(command, header, options = {}) {
  const flags = [];
  if (header.harness !== "xpcshell") {
    flags.push(`--harness ${header.harness}`);
  }
  if (header.scope === "day" && header.scopeRequested) {
    flags.push(`--day ${header.scopeDates[0] ?? header.endDate}`);
  }
  if (options.flakyScope === true) {
    if (header.scope === "all-days") {
      flags.push("--all-days");
    } else if (header.averageDays !== null && header.averageDays !== DEFAULT_AVERAGE_DAYS) {
      flags.push(`--average-days ${header.averageDays}`);
    }
    if (header.requestedMinWindowFailures !== DEFAULT_MIN_WINDOW_FAILURES) {
      flags.push(`--noise ${header.requestedMinWindowFailures}`);
    }
  }
  return flags.length === 0 ? command : `${command} ${flags.join(" ")}`;
}
function testEpilogue(result) {
  const lines = [];
  if (result.cleanTests > 0) {
    lines.push(
      `  ${count(result.cleanTests)} of ${count(result.consideredTests)} tests here passed everywhere they ran and are not listed. They are still in every count above.`
    );
  }
  const top = result.rows[0];
  if (top !== void 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(
      "  Next, for a test you pick:",
      // `fx-tests test` reads a bucket file rather than `issues.json` and
      // has none of this command's scope flags, so only the globals carry.
      // See `suggestion`.
      `    ${suggestion(`fx-tests test ${top.path}`, result.header)}     # every config it ran on, and what it failed with`
    );
  }
  return lines;
}
function testEmptyMessage(result) {
  const { header } = result;
  const where = result.pathPrefix === null ? "the tree" : result.pathPrefix;
  const over = header.scope === "day" ? `on ${header.scopeDates[0] ?? header.endDate}` : header.scope === "all-days" ? `over all ${header.dayCount} days` : `over the last ${header.scopeDates.length} days`;
  if (result.consideredTests === 0) {
    return `No test ran under ${where} ${over}. Searched ${count(header.testCount)} tests in ${header.harness}-issues.json. Check the path (a directory prefix) for typos` + (result.hereOnly ? ", and note that --here-only needs the path to name a directory exactly \u2014 drop it for the subtree." : ".");
  }
  return `All ${count(result.consideredTests)} tests under ${where} passed everywhere they ran ${over}, so there is nothing to list. Nothing is flaky and nothing is disabled here.`;
}
function listRows(root) {
  return folderList(root).map((row) => ({
    path: row.path,
    flaky: row.selfFlaky,
    total: row.selfTotal,
    skipped: row.selfSkipped,
    flakyAndSkipped: row.selfFlakyAndSkipped,
    testCount: row.selfTestCount,
    subtreeFlaky: row.flaky,
    flakyPercent: ratio(row.selfFlaky, row.selfTotal),
    skippedPercent: ratio(row.selfSkipped, row.selfTotal)
  }));
}
function treeRows(root) {
  const rows2 = [];
  const visit = (node) => {
    if (node.path !== "") {
      rows2.push({
        path: node.path,
        flaky: node.flaky,
        total: node.total,
        skipped: node.skipped,
        flakyAndSkipped: node.flakyAndSkipped,
        testCount: node.testCount,
        subtreeFlaky: node.flaky,
        flakyPercent: ratio(node.flaky, node.total),
        skippedPercent: ratio(node.skipped, node.total)
      });
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(root);
  return rows2;
}
function ratio(part, whole) {
  return whole > 0 ? part / whole * 100 : 0;
}
function differs(a, b) {
  return Math.abs(a - b) > 1e-6;
}
function mean(value) {
  const whole = Math.abs(value - Math.round(value)) <= 1e-6;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 1,
    maximumFractionDigits: whole ? 0 : 1
  });
}
function sortRows(rows2, sort) {
  const sorted = [...rows2];
  const byPath = (a, b) => a.path.localeCompare(b.path);
  switch (sort) {
    case "flaky":
      sorted.sort((a, b) => b.flaky - a.flaky || byPath(a, b));
      break;
    case "share":
      sorted.sort((a, b) => b.flakyPercent - a.flakyPercent || byPath(a, b));
      break;
    case "skips":
      sorted.sort((a, b) => b.skipped - a.skipped || byPath(a, b));
      break;
    case "tests":
      sorted.sort((a, b) => b.testCount - a.testCount || byPath(a, b));
      break;
    case "name":
      sorted.sort(byPath);
      break;
  }
  return sorted;
}
function renderFolders(result) {
  const sortColumn = {
    flaky: "flaky",
    share: "flaky%",
    skips: "skip",
    tests: "tests",
    name: "Folder"
  };
  const column = (header, rest = {}) => ({
    header,
    ...rest,
    ...header === sortColumn[result.sort] ? { sort: result.sort === "name" ? "asc" : "desc" } : {}
  });
  const anySubtree = result.rows.some((row) => differs(row.subtreeFlaky, row.flaky));
  const num = result.header.scope === "average" ? mean : count;
  const columns = [
    column("Folder", { path: true }),
    column("flaky", { align: "right" }),
    // `flaky%` rather than `share`: it is `flaky / tests`, and it sits
    // between the two columns it is the ratio of, which `share` did not say
    // and was read as a share of the row's issues instead.
    column("flaky%", { align: "right" }),
    column("skip", { align: "right" }),
    column("tests", { align: "right" }),
    // `+subtree` rather than `in tree`: the `+` says it is this row's number
    // *plus what is below it*, which is the one thing the column means and
    // the one thing "in tree" left a reader to guess.
    ...anySubtree ? [{ header: "+subtree", align: "right" }] : []
  ];
  return {
    preamble: headerLines2(result),
    table: {
      columns,
      rows: result.rows.map((row) => [
        row.path,
        num(row.flaky),
        percent(row.flakyPercent),
        num(row.skipped),
        // Always an integer: `testCount` is test files, which does not
        // become fractional just because the states above it did.
        count(row.testCount),
        ...anySubtree ? [differs(row.subtreeFlaky, row.flaky) ? num(row.subtreeFlaky) : ""] : []
      ])
    },
    total: result.rowCount,
    shown: result.rows.length,
    epilogue: epilogueFor(result),
    empty: emptyMessage(result)
  };
}
function epilogueFor(result) {
  const top = result.rows[0];
  if (top === void 0) {
    return [];
  }
  return [
    `  Next, for the folder you pick:`,
    `    ${suggestion(`fx-tests flaky ${top.path}`, result.header, { flakyScope: true })}     # which tests, flaky ones first`,
    `    ${suggestion(`fx-tests skips --path ${top.path}`, result.header)}      # what is already disabled there, and why`
  ];
}
function trendResult(query, context, limit) {
  const series = flakinessOverTime(query.file, {
    minWindowFailures: query.header.requestedMinWindowFailures,
    ...query.pathPrefix === void 0 ? {} : { pathPrefix: query.pathPrefix }
  });
  const average = runningAverage(series.days, TREND_WINDOW);
  let rows2 = series.days.map((day, index) => ({
    date: day.date,
    day: day.day,
    flaky: day.flaky,
    stable: day.stable,
    skipped: day.skipped,
    total: day.total,
    flakyPercent: ratio(day.flaky, day.total),
    average: average[index] ?? null
  }));
  if (context.globals.since !== void 0) {
    rows2 = rows2.slice(Math.max(0, rows2.length - context.globals.since));
  }
  const shown = limit === 0 ? rows2 : rows2.slice(Math.max(0, rows2.length - limit));
  return {
    header: query.header,
    groupBy: "days",
    pathPrefix: query.pathPrefix ?? null,
    averageWindow: TREND_WINDOW,
    rowCount: rows2.length,
    rows: shown
  };
}
function renderTrend(result) {
  const lines = headerLines2(result);
  return {
    preamble: lines,
    table: {
      columns: [
        { header: "Date", sort: "asc" },
        { header: "flaky", align: "right" },
        { header: "stable", align: "right" },
        { header: "skipped", align: "right" },
        { header: "total", align: "right" },
        { header: "flaky%", align: "right" },
        { header: `${result.averageWindow}d avg`, align: "right" }
      ],
      rows: result.rows.map((row) => [
        dateWithWeekday(row.date),
        count(row.flaky),
        count(row.stable),
        count(row.skipped),
        count(row.total),
        percent(row.flakyPercent),
        percent(row.average)
      ])
    },
    total: result.rowCount,
    shown: result.rows.length,
    epilogue: [
      "  --group-by list ranks the folders behind these numbers."
    ],
    empty: `No day had any test run. Searched ${count(result.header.testCount)} tests in ${result.header.harness}-issues.json over ${result.header.startDate} \u2026 ${result.header.endDate}. Check --path (a directory prefix) for typos.`
  };
}
function headerLines2(result) {
  const { header } = result;
  const lines = [];
  const subject = result.groupBy === "days" ? "flakiness by day" : result.groupBy === "tests" ? "flaky tests, by test file" : result.groupBy === "list" ? "flaky tests by folder" : "flaky tests by folder subtree";
  lines.push(
    `${header.harness} ${subject} \u2014 ${header.dayCount} days (${dateWithWeekday(header.startDate)} \u2026 ${dateWithWeekday(header.endDate)}), ${count(header.testCount)} tests in the file`
  );
  if (result.groupBy === "tests") {
    if (result.pathPrefix !== null) {
      lines.push(
        result.hereOnly ? `Test files directly in ${result.pathPrefix}, not its subfolders (--here-only).` : `Test files under ${result.pathPrefix} and its subfolders.`
      );
    }
  } else if (result.pathPrefix !== null) {
    lines.push(`Under ${result.pathPrefix} only.`);
  }
  if (result.groupBy === "days") {
  } else if (header.scope === "all-days") {
    lines.push(
      `Window: --all-days \u2014 one verdict over all ${header.dayCount} days, flaky if flaky on ANY of them. A much looser bar than the default (see --help).`
    );
  } else if (header.scope === "window") {
    const first = header.scopeDates[0] ?? header.startDate;
    const last = header.scopeDates[header.scopeDates.length - 1] ?? header.endDate;
    lines.push(
      `Window: the ranking's ${header.scopeDates.length} days ${first} \u2026 ${last}, one verdict per test, flaky if flaky on ANY of them \u2014 so more tests than the ranking's mean per day (--day, --all-days).`
    );
  } else if (header.scope === "day") {
    const date = dateWithWeekday(header.scopeDates[0] ?? header.endDate);
    lines.push(
      result.groupBy === "tests" ? `Window: ${date} alone, one verdict per test (--all-days for the whole file).` : `Window: --day ${date} alone, which is partly a fact about the weekday (see --help).`
    );
  } else {
    const first = header.scopeDates[0] ?? header.startDate;
    const last = header.scopeDates[header.scopeDates.length - 1] ?? header.endDate;
    lines.push(
      `Window: mean per day over the ${header.averageDays ?? 0} days ${first} \u2026 ${last}.`
    );
  }
  if (header.noiseFilterSkipped) {
    lines.push(
      `--noise ${header.requestedMinWindowFailures} was NOT applied: this file covers fewer than ${MIN_FILTERABLE_DAYS} days, and "did this fail more than once in the window" cannot be judged from one day. The counts below are unfiltered.`
    );
  } else if (header.minWindowFailures > 0 && header.neutralisedTests > 0) {
    lines.push(
      `Noise filter neutralised ${count(header.neutralisedTests)} tests failing ${header.minWindowFailures} time${header.minWindowFailures === 1 ? "" : "s"} or fewer in ${header.dayCount} days (--noise 0 disables).`
    );
  } else if (header.minWindowFailures === 0) {
    lines.push("Noise filter off (--noise 0): a single failure counts as flaky.");
  }
  return lines;
}
var WRAP_WIDTH = 96;
function wrapCaveat(text, indent = "  ") {
  const words = text.split(" ");
  const out = [];
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (`${indent}${candidate}`.length > WRAP_WIDTH && line !== "") {
      out.push(`${indent}${line}`);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== "") {
    out.push(`${indent}${line}`);
  }
  return out;
}
function emptyMessage(result) {
  const { header } = result;
  const over = header.scope === "day" ? `on ${header.scopeDates[0] ?? header.endDate}` : header.scope === "all-days" ? `over all ${header.dayCount} days` : `over the last ${header.averageDays ?? 0} days`;
  return `No folder matched. Searched ${count(header.testCount)} tests in ${header.harness}-issues.json, classified ${over}. Check --path (a directory prefix) for typos \u2014 and note that a folder whose tests did not run at all in that window has no row, since it has no rate.`;
}
function readGroupBy(args) {
  const fallback = args.positionals.length > 0 ? "tests" : "list";
  const value = stringOption(args, "group-by") ?? fallback;
  if (value !== "list" && value !== "folder" && value !== "days" && value !== "tests") {
    throw usageError(
      `--group-by expects one of list, folder, days, tests, got "${value}"`,
      "list ranks folders by their own flaky tests (the burndown view); folder rolls subtrees up; days is the trend; tests lists the individual test files under a path."
    );
  }
  return value;
}
function readSort2(args) {
  const value = stringOption(args, "sort") ?? "flaky";
  const allowed = ["flaky", "share", "skips", "tests", "name"];
  if (!allowed.includes(value)) {
    throw usageError(`--sort expects one of ${allowed.join(", ")}, got "${value}"`);
  }
  return value;
}
var JSON_DECIMALS = 4;
function roundForJson(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : Number(value.toFixed(JSON_DECIMALS));
  }
  if (Array.isArray(value)) {
    return value.map(roundForJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        roundForJson(entry)
      ])
    );
  }
  return value;
}
function emitResult(context, result, build) {
  if (context.globals.format === "json") {
    emit(context, toJson(roundForJson(result)));
    return;
  }
  const content = build(result);
  emit(
    context,
    context.globals.format === "markdown" ? renderMarkdownFrom(content) : renderTextFrom(content)
  );
}
function renderTextFrom(content) {
  const [heading2, ...caveats] = content.preamble;
  const lines = [
    heading2 ?? "",
    ...caveats.flatMap((caveat) => wrapCaveat(caveat)),
    ""
  ];
  if (content.table === null || content.table.rows.length === 0) {
    lines.push(content.empty);
  } else {
    lines.push(...tableSection(content.table.columns, content.table.rows, content));
  }
  lines.push("");
  lines.push(...content.epilogue);
  return joinLines(lines);
}
function renderMarkdownFrom(content) {
  const lines = [];
  const [heading2, ...caveats] = content.preamble;
  lines.push(heading(heading2 ?? "Flakiness", 1));
  lines.push("");
  for (const caveat of caveats) {
    lines.push(caveat.trim());
    lines.push("");
  }
  if (content.table === null || content.table.rows.length === 0) {
    lines.push(content.empty);
  } else {
    lines.push(...table2(content.table.columns, content.table.rows));
    lines.push(moreLine2(content.total, content.shown));
  }
  if (content.epilogue.length > 0) {
    lines.push("");
    for (const line of content.epilogue) {
      lines.push(line.trim());
    }
  }
  return joinLines(lines);
}

// cli/commands/guide.ts
var GUIDE_OPTIONS = {};
var COMMAND_FACTS = [
  {
    name: "test",
    reads: "{harness}-{bucket}.json",
    answers: "Is this one test failing, where, since when, and where does it run at all?",
    defaultLimit: 10
  },
  {
    name: "try",
    reads: "Treeherder + {harness}-{bucket}.json",
    answers: "Which failures in my push are mine, and which already fail on central?"
  },
  {
    name: "issues",
    reads: "{harness}-issues.json",
    answers: "What is failing across the tree?",
    defaultLimit: 20
  },
  {
    name: "failures",
    reads: "{harness}-issues.json",
    answers: "Which message is behind many failures? The one-bug-many-tests view.",
    defaultLimit: 20
  },
  {
    name: "crashes",
    reads: "{harness}-issues.json",
    answers: "Which crash signatures are happening, and in how many tests?",
    defaultLimit: 20
  },
  {
    name: "skips",
    reads: "{harness}-issues.json",
    answers: "What is disabled, where, and why?",
    defaultLimit: 20
  },
  {
    name: "flaky",
    reads: "{harness}-issues.json",
    answers: "Which folder should I book a flakiness-burndown session on?",
    defaultLimit: 20
  },
  {
    name: "intermittent",
    reads: "Treeherder /api/failures/ + /api/failuresbybug/ + Bugzilla /rest/bug",
    answers: "Which annotated intermittents cost sheriffs the most, tree-wide, and with which bug?",
    defaultHarness: "mochitest",
    defaultLimit: 20
  },
  {
    name: "errors",
    reads: "{harness}-{date}-errors.json",
    answers: "What is loudest in the logs? Is this message ambient or specific to one test?",
    defaultHarness: "mochitest",
    defaultLimit: 20
  },
  {
    name: "manifests",
    reads: "manifests.json",
    answers: "Which manifest is eating a job\u2019s time budget, and on which configs?",
    defaultLimit: 10
  },
  {
    name: "crash",
    reads: "a task\u2019s minidump-stackwalk artifact",
    answers: "What crashed or deadlocked, and where?"
  },
  {
    name: "summary",
    reads: "{harness}-stats.json",
    answers: "The 7-day topline rates, against the prior period."
  },
  {
    name: "dates",
    reads: "index.json",
    answers: "Which dates have published data?"
  },
  {
    name: "cache",
    reads: "the local cache",
    answers: "What is cached, and how much space is it using?"
  }
];
var EXIT_CODE_FACTS = [
  { code: ExitCode.Success, meaning: "Success." },
  { code: ExitCode.Usage, meaning: "Usage error: a bad flag, a missing argument, or a flag this file cannot answer." },
  { code: ExitCode.NotFound, meaning: "Not found: no such test, no data for that date or revision." },
  {
    code: ExitCode.Upstream,
    meaning: "Upstream temporarily unavailable \u2014 network, 5xx, a 403. Retrying may work."
  },
  {
    code: ExitCode.Gone,
    meaning: "Data permanently gone: an expired or never-uploaded Taskcluster artifact. Only `fx-tests crash` produces this. Retrying will not help."
  }
];
var TRAPS = [
  {
    id: "perma-fail-rate",
    title: "An overall failure rate hides a single-config perma-fail",
    body: [
      "A test failing **every time** on one platform and passing everywhere else still",
      "reads as a low single-digit percentage overall, because the rate divides failures",
      "from every config by runs from every config. So a small overall rate is not",
      "evidence a test is healthy, and `fx-tests test` leads with a verdict and a",
      "per-config table rather than one number."
    ]
  },
  {
    id: "manifest-zero-durations",
    title: "All-zero manifest durations mean skipped, not instant",
    body: [
      "A manifest whose durations are **all zero** on a configuration was skipped there;",
      "it did not run in no time. Read as real durations, every skipped config becomes",
      'the fastest in the table, which exactly inverts "which config is worst". The rule',
      "is `every`, not `any` \u2014 some zero and some non-zero means it ran, and those zeros",
      "finished under the timer\u2019s resolution."
    ]
  },
  {
    id: "profiles-not-derivable",
    title: "A per-test profile URL cannot be guessed",
    body: [
      "The **resource-usage** profile is one per job at a fixed path derivable from the",
      "task ID \u2014 that is the one showing whether a timeout was the test being slow or the",
      "machine saturated. The **per-test failure profile** is different: uploaded only",
      'when a test fails, and named only in the failure message ("profile uploaded in',
      'profile_<name>.json"). Where none was named, no URL exists to construct.'
    ]
  },
  {
    id: "errors-window",
    title: "Errors data covers fewer days than everything else",
    body: [
      "A date in `fx-tests dates` does **not** mean it has errors data, and which dates do",
      "changes \u2014 so do not carry a number for it. `fx-tests errors` discovers and prints",
      "its own window, and a date outside it is exit 2 listing the ones that work. This",
      'bounds the "was this error already there when the test was passing?" comparison:',
      "both days have to be days with errors data."
    ]
  },
  {
    id: "errors-harness",
    title: "`errors` defaults to mochitest, and the xpcshell file is a biased sample",
    body: [
      "Every other command defaults to xpcshell; `errors` does not, and the reason is not",
      "size. xpcshell runs its tests in parallel, so stdout cannot be streamed as it is",
      "produced and is replayed **only when a test fails** \u2014 the xpcshell errors file is",
      "failing tests\u2019 output and nothing else. That is a biased population, not a smaller",
      'sample of the same one: ranking it answers "what do failing tests print", not',
      '"what is noisy in CI", which is what a reader of a ranking assumes.'
    ]
  },
  {
    id: "issues-attribution",
    title: "`issues.json` cannot tell you which configuration failed",
    body: [
      "The tree-wide aggregate discarded all attribution \u2014 no task IDs, no job names, no",
      'minidump IDs \u2014 so "which config?" has no answer there, which is not the same as',
      'the answer being "none". `issues`, `failures`, `crashes` and `skips` therefore',
      "**refuse** `--config` and `--minidumps` rather than return an empty table, because",
      "a filter that silently matches nothing looks exactly like a clean tree. Use",
      "`fx-tests test <path>` for per-config detail."
    ]
  },
  {
    id: "annotations-are-not-failures",
    title: "`intermittent` counts sheriff annotations, not failures",
    body: [
      "A row is a bug a **sheriff** attached to failing jobs, so an untriaged failure has",
      "no row: this ranks what costs sheriffs time, while `issues`/`flaky` rank what fails",
      "most. A bug belongs to a harness when its summary names a test that harness runs;",
      "one naming no known test \u2014 a [taskcluster:error], a suite this tool does not read \u2014",
      "is `unknown`. --harness picks one of the three, and omitting it ranks them all."
    ]
  },
  {
    id: "weekend-volume",
    title: "Weekend counts are a fraction of weekday counts",
    body: [
      "Push volume drops several-fold at weekends, so an absolute count from a Saturday",
      "is not comparable with one from a Thursday. Every command prints the weekday next",
      "to a date for this reason. Compare like with like, and prefer rates to counts."
    ]
  },
  {
    id: "run-if",
    title: "`run-if` is not a disabled test, and skip counts are not comparable across files",
    body: [
      "A `skip-if` means the test should run here and is turned off \u2014 usually work someone",
      "owes. A `run-if` means it is scoped to another platform, so not running here is the",
      "annotation working; `fx-tests skips` excludes those by default.",
      "",
      "The aggregates drop `run-if` skips upstream and the daily files keep them, so a",
      "skip count from one family must not be compared with one from the other. Nor added:",
      "the aggregates and the bucket files re-encode the *same* runs, so summing across",
      "them multiplies the population by the number of encodings."
    ]
  },
  {
    id: "hang-not-type",
    title: "A hang is not distinguishable from a crash by its crash type",
    body: [
      "A minidump is also how a hung process is diagnosed, and `crash_info.type` will not",
      "tell you which you have: a real hang reports `EXC_SOFTWARE / SIGABRT`, exactly as",
      "an ordinary abort. The evidence is breakpad\u2019s own frames on top of a thread that",
      "was otherwise waiting. For a hang use `--all-threads` \u2014 a deadlock is diagnosed by",
      "breadth across threads, not depth in one."
    ]
  }
];
var WORKFLOWS = [
  {
    title: "A test failed on my Try push",
    steps: [
      "fx-tests try <revision> --perma-only",
      "    Tests that failed every run of some configuration. Read the Pre-existing line",
      "    on each: without it the row is probably yours, with it central already fails",
      "    the same way on that same config and it probably is not.",
      "",
      "fx-tests try <revision> --all-jobs",
      "    Reads the passing test jobs too. A test that failed and then passed when the",
      "    harness reran it leaves the job GREEN, so the default run never sees it \u2014 it",
      "    is missing, not ranked low. Costs one profile per test job on the push rather",
      "    than one per failed job, so reach for it when burning down flakiness.",
      "",
      "fx-tests test <path>",
      "    Whether it already fails on central, and how. Two things change the reading:",
      "    that it passed when the harness reran it in the same job, and that it fails",
      "    only in parallel \u2014 the second points at a race with its neighbours.",
      "",
      "fx-tests test <path> --coverage",
      "    Before concluding a platform is unaffected, check the test runs there at all.",
      '    "No Android row" and "passes on Android" look identical without this.'
    ]
  },
  {
    title: "A job is timing out",
    steps: [
      "fx-tests manifests --job <config> --sort median",
      "    Narrows it to a manifest. Remember the all-zero rule: a manifest with no",
      "    duration shown did not run there.",
      "",
      "fx-tests test <path> --durations",
      "    Whether that manifest is one slow test or a thousand cheap ones. The manifest",
      "    view has no per-test durations and cannot tell you.",
      "",
      "fx-tests test <path> --profiles",
      '    Separates "the test is slow" from "the machine was saturated". Feed the raw',
      "    URL to profiler-cli."
    ]
  },
  {
    title: "Reduce CI log noise",
    steps: [
      "fx-tests errors",
      "    A handful of messages are most of the volume, so the top of the list is most",
      "    of the work. Read the `tests` column too: a message in thousands of tests is",
      "    ambient, one in a single test is a candidate cause for that test.",
      "",
      'fx-tests errors --message "<text>"',
      "    Lists the tests emitting one message, so you can tell which of those it is.",
      "",
      "fx-tests errors --day <a> ... then --day <b>",
      "    A single day cannot say whether an error was already there when the test was",
      "    passing. Two days can \u2014 both weekdays, and both days that have errors data."
    ]
  },
  {
    title: "A test is crashing",
    steps: [
      "fx-tests test <path> --task-ids",
      "    The configs and signatures, plus a task ID and, where the dump was uploaded, a",
      "    minidump ID. A crash whose dump was never uploaded still counts as a crash.",
      "",
      "fx-tests crash <taskId> <minidumpId>",
      "    Signature, crash reason, faulting address, crashing thread. A null pointer",
      "    flagged with an offset means that offset is the field being dereferenced."
    ]
  }
];
function runGuide(context, args) {
  if (args.positionals.length > 0) {
    throw usageError(
      `guide takes no arguments, got "${args.positionals[0]}"`,
      "Run `fx-tests guide` and read all of it."
    );
  }
  if (context.globals.format === "json") {
    emit(
      context,
      toJson({
        commands: COMMAND_FACTS,
        exitCodes: EXIT_CODE_FACTS,
        traps: TRAPS.map((trap) => ({ id: trap.id, title: trap.title }))
      })
    );
    return Promise.resolve();
  }
  emit(context, render());
  return Promise.resolve();
}
function render() {
  const lines = [];
  lines.push("fx-tests \u2014 what this data can and cannot tell you");
  lines.push("");
  lines.push("Read this once before using the other commands. The traps below are not");
  lines.push("discoverable from --help, and every one of them has been got wrong in practice.");
  lines.push("");
  lines.push("Everything is read-only. There is no writing to CI, Bugzilla or Treeherder.");
  lines.push("");
  lines.push("THE COMMANDS");
  lines.push("");
  const width = Math.max(...COMMAND_FACTS.map((fact) => fact.name.length));
  for (const fact of COMMAND_FACTS) {
    lines.push(`  ${fact.name.padEnd(width)}  ${fact.answers}`);
    if (fact.defaultHarness !== void 0) {
      lines.push(
        `  ${" ".repeat(width)}  defaults to --harness ${fact.defaultHarness} \u2014 see TRAPS`
      );
    }
  }
  lines.push("");
  lines.push("THE WINDOW");
  lines.push("");
  lines.push("The index publishes a rolling window of recent days; `fx-tests dates` says");
  lines.push("which. Older data still exists in Taskcluster but nothing here reaches it, so a");
  lines.push("date outside the window is exit 2 naming the window.");
  lines.push("");
  lines.push("Inside it, --day and --since filter a file the command already reads rather than");
  lines.push("fetching a different one, so a narrower question is not a slower one. `errors`");
  lines.push("and `manifests` are per-date files and are the exception \u2014 see TRAPS.");
  lines.push("");
  lines.push("TRAPS");
  for (const trap of TRAPS) {
    lines.push("");
    lines.push(`  ${trap.title}`);
    for (const line of trap.body) {
      lines.push(line === "" ? "" : `    ${line}`);
    }
  }
  lines.push("");
  lines.push("WORKED INVESTIGATIONS");
  for (const workflow of WORKFLOWS) {
    lines.push("");
    lines.push(`  ${workflow.title}`);
    for (const step of workflow.steps) {
      lines.push(step === "" ? "" : `    ${step}`);
    }
  }
  lines.push("");
  lines.push("EXIT CODES");
  lines.push("");
  for (const fact of EXIT_CODE_FACTS) {
    const [first, ...rest] = wrapText(fact.meaning, 74);
    lines.push(`  ${fact.code}  ${first ?? ""}`);
    for (const line of rest) {
      lines.push(`     ${line}`);
    }
  }
  lines.push("");
  lines.push('  The 3/4 split lets a script tell "try again in a minute" from "this dump is');
  lines.push('  never coming back". `fx-tests try` exits 0 whether or not it found failures:');
  lines.push("  the failures are the answer, not an error.");
  lines.push("");
  lines.push("OUTPUT");
  lines.push("");
  lines.push("  --json for a stable shape, --markdown for pasting into a bug. Only requested");
  lines.push("  data goes to stdout and everything else to stderr, so piping behaves.");
  lines.push("");
  lines.push("  Lists are truncated by default and say so (`\u2026 47 more (--limit 0 for all)`).");
  lines.push("  If a list looks short, check for that line before believing it is complete.");
  lines.push("");
  lines.push("  Messages are cut to the terminal width, and the cut takes the end \u2014 which is");
  lines.push("  often the discriminator. COLUMNS widens it; --full-messages turns it off, as");
  lines.push("  does --markdown, which never truncates.");
  return joinLines(lines);
}

// lib/model/job-name.ts
function stripChunkSuffix(jobName) {
  const slash = jobName.indexOf("/");
  if (slash === -1) {
    return jobName;
  }
  const head = jobName.slice(0, slash + 1);
  const tail = jobName.slice(slash + 1);
  return head + tail.replace(/-\d+$/, "");
}
function chunkNumber(jobName) {
  const slash = jobName.indexOf("/");
  if (slash === -1) {
    return null;
  }
  const match = /-(\d+)$/.exec(jobName.slice(slash + 1));
  return match ? Number(match[1]) : null;
}
function parseJobName(jobName) {
  const slash = jobName.indexOf("/");
  const configuration = stripChunkSuffix(jobName);
  const chunk2 = chunkNumber(jobName);
  if (slash === -1) {
    return {
      raw: jobName,
      configuration,
      kind: firstSegment(jobName),
      platform: null,
      os: null,
      buildType: null,
      suite: null,
      chunk: chunk2
    };
  }
  const head = jobName.slice(0, slash);
  const tail = jobName.slice(slash + 1).replace(/-\d+$/, "");
  const dash = head.indexOf("-");
  const kind = dash === -1 ? null : head.slice(0, dash);
  const platform = dash === -1 ? null : head.slice(dash + 1);
  const tailDash = tail.indexOf("-");
  const buildType = tailDash === -1 ? tail : tail.slice(0, tailDash);
  const suite = tailDash === -1 ? null : tail.slice(tailDash + 1);
  return {
    raw: jobName,
    configuration,
    kind,
    platform,
    os: platform === null ? null : operatingSystem(platform),
    buildType: buildType === "" ? null : buildType,
    suite,
    chunk: chunk2
  };
}
function operatingSystem(platform) {
  if (platform.includes("android")) {
    return "android";
  }
  if (platform.includes("linux")) {
    return "linux";
  }
  if (platform.includes("win")) {
    return "windows";
  }
  if (platform.includes("macos") || platform.includes("osx")) {
    return "mac";
  }
  return null;
}
function firstSegment(name) {
  const dash = name.indexOf("-");
  return dash === -1 ? null : name.slice(0, dash);
}

// lib/query/config-stats.ts
var DEFAULT_MIN_RECENT_RUNS = 20;
function computeConfigStats(file, testId, options = {}) {
  const minRecentRuns = options.minRecentRuns ?? DEFAULT_MIN_RECENT_RUNS;
  const wanted = options.jobNames === void 0 ? null : new Set(options.jobNames);
  const tryMessages = new Set(options.tryMessages ?? []);
  const byJob = /* @__PURE__ */ new Map();
  const bump = (rawJobName, isFail, sameMsg, day, count2) => {
    const jobName = stripChunkSuffix(rawJobName);
    if (wanted !== null && !wanted.has(jobName)) {
      return;
    }
    if (options.jobFilter !== void 0 && !options.jobFilter(jobName)) {
      return;
    }
    let entry = byJob.get(jobName);
    if (entry === void 0) {
      entry = { jobName, passCount: 0, failCount: 0, sameMsgFailCount: 0, byDay: /* @__PURE__ */ new Map() };
      byJob.set(jobName, entry);
    }
    if (isFail) {
      entry.failCount += count2;
    } else {
      entry.passCount += count2;
    }
    if (isFail && sameMsg) {
      entry.sameMsgFailCount += count2;
    }
    const key = day ?? 0;
    let bucket = entry.byDay.get(key);
    if (bucket === void 0) {
      bucket = [0, 0, 0];
      entry.byDay.set(key, bucket);
    }
    bucket[isFail ? 1 : 0] += count2;
    if (isFail && sameMsg) {
      bucket[2] += count2;
    }
  };
  for (const entry of file.runsOfTest(testId)) {
    const { kind } = classifyStatus(entry.status);
    if (kind === "skip" || kind === "unknown") {
      continue;
    }
    if (options.dayRange !== void 0 && entry.day !== null && (entry.day < options.dayRange.from || entry.day > options.dayRange.to)) {
      continue;
    }
    const isFail = kind === "fail" || kind === "timeout" || kind === "crash";
    const sameMsg = isFail ? entryMatches(entry, kind, tryMessages, options) : false;
    if (entry.jobName !== void 0) {
      bump(entry.jobName, isFail, sameMsg, entry.day, entry.count);
    } else if (entry.taskIdIndexes !== void 0) {
      for (const taskIdIndex of entry.taskIdIndexes) {
        const jobName = file.jobNameOfTaskIndex(taskIdIndex);
        if (jobName !== null) {
          bump(jobName, isFail, sameMsg, entry.day, 1);
        }
      }
    }
  }
  return summarize(byJob, minRecentRuns, options.recentDays);
}
function entryMatches(entry, kind, tryMessages, options) {
  if (kind === "timeout" && options.matchAnyTimeout) {
    return true;
  }
  if (kind === "crash" && options.matchAnyCrash) {
    return true;
  }
  const text = kind === "crash" ? entry.crashSignature : entry.message;
  return text !== null && text !== void 0 && tryMessages.has(text);
}
function summarize(byJob, minRecentRuns, forcedRecentDays) {
  let newestDay = -Infinity;
  for (const entry of byJob.values()) {
    for (const day of entry.byDay.keys()) {
      newestDay = Math.max(newestDay, day);
    }
  }
  let windowDays = 1;
  if (forcedRecentDays !== void 0) {
    windowDays = Math.max(1, forcedRecentDays);
  } else {
    for (const entry of byJob.values()) {
      let runs = 0;
      let needed = 0;
      for (const day of [...entry.byDay.keys()].sort((a, b) => b - a)) {
        const bucket = entry.byDay.get(day);
        runs += bucket[0] + bucket[1];
        needed = newestDay - day + 1;
        if (runs >= minRecentRuns) {
          break;
        }
      }
      if (runs >= minRecentRuns) {
        windowDays = Math.max(windowDays, needed);
      }
    }
  }
  const configs = [];
  for (const entry of byJob.values()) {
    const runCount = entry.passCount + entry.failCount;
    const from = newestDay - windowDays + 1;
    let recentPass = 0;
    let recentFail = 0;
    let recentSameMsg = 0;
    for (const [day, [passes, fails, sameMsg]] of entry.byDay) {
      if (day < from) {
        continue;
      }
      recentPass += passes;
      recentFail += fails;
      recentSameMsg += sameMsg;
    }
    const recentRunCount = recentPass + recentFail;
    const enough = recentRunCount >= minRecentRuns;
    configs.push({
      jobName: entry.jobName,
      runCount,
      failCount: entry.failCount,
      failRate: runCount > 0 ? entry.failCount / runCount * 100 : 0,
      sameMsgFailCount: entry.sameMsgFailCount,
      sameMsgFailRate: runCount > 0 ? entry.sameMsgFailCount / runCount * 100 : 0,
      recentDays: windowDays,
      recentRunCount,
      recentFailRate: enough ? recentFail / recentRunCount * 100 : null,
      recentSameMsgFailRate: enough ? recentSameMsg / recentRunCount * 100 : null
    });
  }
  configs.sort((a, b) => b.failRate - a.failRate);
  return configs;
}
function canAttributeConfigs(file) {
  return file.family !== "issues";
}

// lib/query/test-stats.ts
function inDayRange(day, range) {
  if (range === void 0 || day === null) {
    return true;
  }
  return day >= range.from && day <= range.to;
}
function computeTestStats(file, testId, options = {}) {
  const stats = {
    family: file.family,
    runCount: 0,
    passCount: 0,
    failCount: 0,
    timeoutCount: 0,
    crashCount: 0,
    expectedFailCount: 0,
    unknownCount: 0,
    skipCount: 0,
    runIfSkipCount: 0,
    passRate: null
  };
  for (const entry of file.runsOfTest(testId)) {
    if (!inDayRange(entry.day, options.dayRange)) {
      continue;
    }
    let count2 = entry.count;
    if (options.jobFilter !== void 0) {
      const kept = filterEntryByConfig(file, entry, options.jobFilter);
      if (kept === null || kept.count === 0) {
        continue;
      }
      count2 = kept.count;
    }
    addEntry(stats, classifyStatus(entry.status).kind, entry, count2);
  }
  stats.runCount = stats.passCount + stats.failCount + stats.timeoutCount + stats.crashCount + stats.expectedFailCount;
  stats.passRate = stats.runCount > 0 ? (stats.passCount + stats.expectedFailCount) / stats.runCount * 100 : null;
  return stats;
}
function addEntry(stats, kind, entry, count2) {
  switch (kind) {
    case "pass":
      stats.passCount += count2;
      return;
    case "fail":
      stats.failCount += count2;
      return;
    case "timeout":
      stats.timeoutCount += count2;
      return;
    case "crash":
      stats.crashCount += count2;
      return;
    case "expected-fail":
      stats.expectedFailCount += count2;
      return;
    case "unknown":
      stats.unknownCount += count2;
      return;
    case "skip":
      if (skipReason(entry.message) === "run-if") {
        stats.runIfSkipCount += count2;
      } else {
        stats.skipCount += count2;
      }
      return;
  }
}
function jobNameOfEntry(file, entry) {
  if (entry.jobName !== void 0) {
    return entry.jobName;
  }
  const first = entry.taskIdIndexes?.[0];
  return first === void 0 ? null : file.jobNameOfTaskIndex(first);
}
function configTargetsOfEntry(file, entry) {
  if (entry.jobName !== void 0) {
    return [{ jobName: entry.jobName, count: entry.count, indexes: [] }];
  }
  if (entry.taskIdIndexes === void 0) {
    return [];
  }
  const byJob = /* @__PURE__ */ new Map();
  entry.taskIdIndexes.forEach((taskIdIndex, i) => {
    const jobName = file.jobNameOfTaskIndex(taskIdIndex);
    if (jobName === null) {
      return;
    }
    let target = byJob.get(jobName);
    if (target === void 0) {
      target = { jobName, count: 0, indexes: [] };
      byJob.set(jobName, target);
    }
    target.count++;
    target.indexes.push(i);
  });
  return [...byJob.values()];
}
function filterEntryByConfig(file, entry, jobFilter) {
  const targets = configTargetsOfEntry(file, entry);
  if (targets.length === 0) {
    return null;
  }
  let count2 = 0;
  const indexes = [];
  for (const target of targets) {
    if (!jobFilter(target.jobName)) {
      continue;
    }
    count2 += target.count;
    indexes.push(...target.indexes);
  }
  indexes.sort((a, b) => a - b);
  return { count: count2, indexes };
}
function narrowEntryToConfig(file, entry, jobFilter) {
  const kept = filterEntryByConfig(file, entry, jobFilter);
  if (kept === null || kept.count === 0) {
    return null;
  }
  if (kept.count === entry.count) {
    return entry;
  }
  const pick = (values, field) => {
    if (values === void 0) {
      return void 0;
    }
    if (values.length !== entry.count) {
      throw new RangeError(
        `${entry.status} entry has ${values.length} ${field} for ${entry.count} runs; narrowing by configuration needs them parallel`
      );
    }
    return kept.indexes.map((i) => values[i]);
  };
  const narrowed = { ...entry, count: kept.count };
  const taskIds = pick(entry.taskIds, "taskIds");
  if (taskIds !== void 0) {
    narrowed.taskIds = taskIds;
  }
  const taskIdIndexes = pick(entry.taskIdIndexes, "taskIdIndexes");
  if (taskIdIndexes !== void 0) {
    narrowed.taskIdIndexes = taskIdIndexes;
  }
  const durations = pick(entry.durations, "durations");
  if (durations !== void 0) {
    narrowed.durations = durations;
  }
  const timestamps = pick(entry.timestamps, "timestamps");
  if (timestamps !== void 0) {
    narrowed.timestamps = timestamps;
  }
  const minidumps = pick(entry.minidumps, "minidumps");
  if (minidumps !== void 0) {
    narrowed.minidumps = minidumps;
  }
  return narrowed;
}
function failureMessageCounts(file, testId, options = {}) {
  const counts = /* @__PURE__ */ new Map();
  for (const entry of file.runsOfTest(testId)) {
    if (!inDayRange(entry.day, options.dayRange)) {
      continue;
    }
    if (classifyStatus(entry.status).kind !== "fail") {
      continue;
    }
    let count2 = entry.count;
    if (options.jobFilter !== void 0) {
      const kept = filterEntryByConfig(file, entry, options.jobFilter);
      if (kept === null || kept.count === 0) {
        continue;
      }
      count2 = kept.count;
    }
    const key = entry.message ?? null;
    counts.set(key, (counts.get(key) ?? 0) + count2);
  }
  return counts;
}
function crashSignatureCounts(file, testId, options = {}) {
  const counts = /* @__PURE__ */ new Map();
  for (const entry of file.runsOfTest(testId)) {
    if (!inDayRange(entry.day, options.dayRange)) {
      continue;
    }
    if (classifyStatus(entry.status).kind !== "crash") {
      continue;
    }
    let count2 = entry.count;
    if (options.jobFilter !== void 0) {
      const kept = filterEntryByConfig(file, entry, options.jobFilter);
      if (kept === null || kept.count === 0) {
        continue;
      }
      count2 = kept.count;
    }
    const key = entry.crashSignature ?? null;
    counts.set(key, (counts.get(key) ?? 0) + count2);
  }
  return counts;
}
function configFilter(include = [], exclude = []) {
  return (jobName) => {
    if (include.length > 0 && !include.some((s) => jobName.includes(s))) {
      return false;
    }
    return !exclude.some((s) => jobName.includes(s));
  };
}

// lib/query/crashes.ts
var DEFAULT_MAX_TESTS2 = 50;
var DEFAULT_MAX_MINIDUMPS = 20;
function groupCrashesBySignature(file, options = {}) {
  const maxTests = options.maxTestsPerGroup ?? DEFAULT_MAX_TESTS2;
  const maxMinidumps = options.maxMinidumps ?? DEFAULT_MAX_MINIDUMPS;
  const needle = options.signature?.toLowerCase();
  const groups = /* @__PURE__ */ new Map();
  const perTest = /* @__PURE__ */ new Map();
  for (let testId = 0; testId < file.testCount; testId++) {
    const identity = file.testAt(testId);
    if (options.pathPrefix !== void 0 && !identity.fullPath.startsWith(options.pathPrefix)) {
      continue;
    }
    if (options.component !== void 0) {
      const component = identity.component;
      if (component === null || !component.toLowerCase().includes(options.component.toLowerCase())) {
        continue;
      }
    }
    for (const entry of file.runsOfTest(testId)) {
      if (!inDayRange(entry.day, options.dayRange)) {
        continue;
      }
      if (classifyStatus(entry.status).kind !== "crash") {
        continue;
      }
      const signature = entry.crashSignature ?? null;
      if (needle !== void 0 && !(signature ?? "").toLowerCase().includes(needle)) {
        continue;
      }
      let jobName = null;
      if (options.jobFilter !== void 0) {
        jobName = jobNameOfEntry(file, entry);
        if (jobName === null || !options.jobFilter(jobName)) {
          continue;
        }
      }
      let group = groups.get(signature);
      if (group === void 0) {
        group = {
          signature,
          count: 0,
          testCount: 0,
          tests: [],
          jobNames: /* @__PURE__ */ new Set(),
          minidumps: []
        };
        groups.set(signature, group);
        perTest.set(signature, /* @__PURE__ */ new Map());
      }
      group.count += entry.count;
      const counts = perTest.get(signature);
      counts.set(testId, (counts.get(testId) ?? 0) + entry.count);
      const resolved = jobName ?? jobNameOfEntry(file, entry);
      if (resolved !== null) {
        group.jobNames.add(resolved);
      }
      if (entry.minidumps !== void 0 && entry.taskIds !== void 0) {
        for (let i = 0; i < entry.minidumps.length; i++) {
          if (group.minidumps.length >= maxMinidumps) {
            break;
          }
          const minidumpId = entry.minidumps[i];
          const rawTaskId = entry.taskIds[i];
          if (!minidumpId || rawTaskId === void 0) {
            continue;
          }
          const { taskId, retryId } = parseTaskId(rawTaskId);
          group.minidumps.push({ taskId, retryId, minidumpId });
        }
      }
    }
  }
  for (const [signature, group] of groups) {
    const counts = perTest.get(signature);
    group.testCount = counts.size;
    group.tests = [...counts].sort((a, b) => b[1] - a[1]).slice(0, maxTests).map(([testId, count2]) => ({
      testId,
      fullPath: file.testAt(testId).fullPath,
      count: count2
    }));
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// lib/query/failures.ts
var DEFAULT_MAX_TESTS3 = 50;
var DEFAULT_MAX_TASK_IDS = 20;
function groupFailuresByMessage(file, options = {}) {
  const maxTests = options.maxTestsPerGroup ?? DEFAULT_MAX_TESTS3;
  const maxTaskIds = options.maxTaskIds ?? DEFAULT_MAX_TASK_IDS;
  const needle = options.message?.toLowerCase();
  const groups = /* @__PURE__ */ new Map();
  const perTest = /* @__PURE__ */ new Map();
  for (let testId = 0; testId < file.testCount; testId++) {
    const identity = file.testAt(testId);
    if (options.pathPrefix !== void 0 && !identity.fullPath.startsWith(options.pathPrefix)) {
      continue;
    }
    if (options.component !== void 0) {
      const component = identity.component;
      if (component === null || !component.toLowerCase().includes(options.component.toLowerCase())) {
        continue;
      }
    }
    for (const entry of file.runsOfTest(testId)) {
      if (!inDayRange(entry.day, options.dayRange)) {
        continue;
      }
      if (classifyStatus(entry.status).kind !== "fail") {
        continue;
      }
      const message = entry.message ?? null;
      if (needle !== void 0 && !(message ?? "").toLowerCase().includes(needle)) {
        continue;
      }
      let jobName = null;
      if (options.jobFilter !== void 0) {
        jobName = jobNameOfEntry(file, entry);
        if (jobName === null || !options.jobFilter(jobName)) {
          continue;
        }
      }
      let group = groups.get(message);
      if (group === void 0) {
        group = {
          message,
          count: 0,
          testCount: 0,
          tests: [],
          testsTruncated: false,
          jobNames: /* @__PURE__ */ new Set(),
          taskIds: []
        };
        groups.set(message, group);
        perTest.set(message, /* @__PURE__ */ new Map());
      }
      group.count += entry.count;
      const counts = perTest.get(message);
      counts.set(testId, (counts.get(testId) ?? 0) + entry.count);
      const resolved = jobName ?? jobNameOfEntry(file, entry);
      if (resolved !== null) {
        group.jobNames.add(resolved);
      }
      if (entry.taskIds !== void 0 && group.taskIds.length < maxTaskIds) {
        for (const taskId of entry.taskIds) {
          if (group.taskIds.length >= maxTaskIds) {
            break;
          }
          group.taskIds.push(taskId);
        }
      }
    }
  }
  for (const [message, group] of groups) {
    const counts = perTest.get(message);
    group.testCount = counts.size;
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    const kept = maxTests === 0 ? ranked : ranked.slice(0, maxTests);
    group.testsTruncated = kept.length < ranked.length;
    group.tests = kept.map(([testId, count2]) => ({
      testId,
      fullPath: file.testAt(testId).fullPath,
      count: count2
    }));
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// lib/query/issues.ts
var DEFAULT_TYPES = ["fail", "timeout", "crash", "skip"];
function findIssues(file, options = {}) {
  const types = new Set(options.types ?? DEFAULT_TYPES);
  const rows2 = [];
  for (let testId = 0; testId < file.testCount; testId++) {
    const identity = file.testAt(testId);
    if (options.pathPrefix !== void 0 && !identity.fullPath.startsWith(options.pathPrefix)) {
      continue;
    }
    if (options.component !== void 0) {
      const component = identity.component;
      if (component === null || !component.toLowerCase().includes(options.component.toLowerCase())) {
        continue;
      }
    }
    const row = {
      testId,
      fullPath: identity.fullPath,
      directory: identity.directory,
      component: identity.component,
      runCount: 0,
      passCount: 0,
      failCount: 0,
      timeoutCount: 0,
      crashCount: 0,
      expectedFailCount: 0,
      skipCount: 0,
      failRate: 0,
      issueCount: 0,
      issueRate: 0
    };
    for (const entry of file.runsOfTest(testId)) {
      if (!inDayRange(entry.day, options.dayRange)) {
        continue;
      }
      switch (classifyStatus(entry.status).kind) {
        case "pass":
          row.passCount += entry.count;
          break;
        case "fail":
          row.failCount += entry.count;
          break;
        case "timeout":
          row.timeoutCount += entry.count;
          break;
        case "crash":
          row.crashCount += entry.count;
          break;
        case "expected-fail":
          row.expectedFailCount += entry.count;
          break;
        case "skip":
          if (skipReason(entry.message) !== "run-if") {
            row.skipCount += entry.count;
          }
          break;
        case "unknown":
          break;
      }
    }
    row.runCount = row.passCount + row.failCount + row.timeoutCount + row.crashCount + row.expectedFailCount;
    const nonPass = row.failCount + row.timeoutCount + row.crashCount;
    row.failRate = row.runCount > 0 ? nonPass / row.runCount * 100 : 0;
    row.issueCount = issueCountOf(row, types);
    const rateDenominator = row.runCount + (types.has("skip") ? row.skipCount : 0);
    row.issueRate = rateDenominator > 0 ? row.issueCount / rateDenominator * 100 : 0;
    if (row.issueCount === 0 && options.keepClean !== true) {
      continue;
    }
    if (options.minCount !== void 0 && row.issueCount < options.minCount) {
      continue;
    }
    if (options.minRate !== void 0 && row.failRate < options.minRate) {
      continue;
    }
    rows2.push(row);
  }
  rows2.sort((a, b) => b.failRate - a.failRate || a.fullPath.localeCompare(b.fullPath));
  return rows2;
}
function issueCountOf(counts, types) {
  return (types.has("skip") ? counts.skipCount : 0) + (types.has("fail") ? counts.failCount : 0) + (types.has("timeout") ? counts.timeoutCount : 0) + (types.has("crash") ? counts.crashCount : 0);
}
function groupIssues(rows2, by, types = DEFAULT_TYPES) {
  const enabled = new Set(types);
  const groups = /* @__PURE__ */ new Map();
  for (const row of rows2) {
    const key = by === "component" ? row.component ?? "(no component)" : row.directory;
    let group = groups.get(key);
    if (group === void 0) {
      group = {
        key,
        testCount: 0,
        totalTestCount: 0,
        runCount: 0,
        failCount: 0,
        timeoutCount: 0,
        crashCount: 0,
        skipCount: 0,
        failRate: 0,
        issueCount: 0,
        issueRate: 0
      };
      groups.set(key, group);
    }
    group.totalTestCount += 1;
    if (row.issueCount > 0) {
      group.testCount += 1;
    }
    group.runCount += row.runCount;
    group.failCount += row.failCount;
    group.timeoutCount += row.timeoutCount;
    group.crashCount += row.crashCount;
    group.skipCount += row.skipCount;
  }
  const out = [...groups.values()].filter((group) => group.testCount > 0);
  for (const group of out) {
    const nonPass = group.failCount + group.timeoutCount + group.crashCount;
    group.failRate = group.runCount > 0 ? nonPass / group.runCount * 100 : 0;
    group.issueCount = issueCountOf(group, enabled);
    const denominator = group.runCount + (enabled.has("skip") ? group.skipCount : 0);
    group.issueRate = denominator > 0 ? group.issueCount / denominator * 100 : 0;
  }
  out.sort((a, b) => b.issueCount - a.issueCount || a.key.localeCompare(b.key));
  return out;
}
function findSkips(file, options = {}) {
  const rows2 = [];
  for (let testId = 0; testId < file.testCount; testId++) {
    const identity = file.testAt(testId);
    if (options.pathPrefix !== void 0 && !identity.fullPath.startsWith(options.pathPrefix)) {
      continue;
    }
    if (options.component !== void 0) {
      const component = identity.component;
      if (component === null || !component.toLowerCase().includes(options.component.toLowerCase())) {
        continue;
      }
    }
    const row = {
      testId,
      fullPath: identity.fullPath,
      directory: identity.directory,
      component: identity.component,
      skipCount: 0,
      messages: /* @__PURE__ */ new Map(),
      jobNames: /* @__PURE__ */ new Set()
    };
    for (const entry of file.runsOfTest(testId)) {
      if (!inDayRange(entry.day, options.dayRange)) {
        continue;
      }
      if (classifyStatus(entry.status).kind !== "skip") {
        continue;
      }
      const reason = skipReason(entry.message);
      if (reason === "run-if" && !options.includeRunIf) {
        continue;
      }
      row.skipCount += entry.count;
      if (entry.message) {
        const display = entry.message.replace(/^skip-if:\s*/, "");
        row.messages.set(display, (row.messages.get(display) ?? 0) + entry.count);
      }
      if (entry.jobName !== void 0) {
        row.jobNames.add(entry.jobName);
      }
    }
    if (row.skipCount > 0) {
      rows2.push(row);
    }
  }
  rows2.sort((a, b) => b.skipCount - a.skipCount || a.fullPath.localeCompare(b.fullPath));
  return rows2;
}

// cli/commands/issues.ts
var SHARED_OPTIONS = {
  component: {
    type: "string",
    placeholder: "<substring>",
    describe: "Only tests whose Bugzilla component contains this."
  },
  path: {
    type: "string",
    placeholder: "<prefix>",
    describe: "Only tests under this directory prefix."
  }
};
var ISSUES_OPTIONS = {
  ...SHARED_OPTIONS,
  type: {
    type: "list",
    placeholder: "<fail|timeout|crash|skip>",
    describe: "Which outcomes count as an issue. Repeatable. Default all four, as on issues.html."
  },
  "min-rate": {
    type: "string",
    placeholder: "<pct>",
    describe: "Drop tests failing less often than this, in percent."
  },
  sort: {
    type: "string",
    placeholder: "<issues|rate|count|name>",
    describe: "How to rank. Default issues."
  },
  "group-by": {
    type: "string",
    placeholder: "<component|test|directory|message>",
    describe: "How to group. Default component, as issues.html does. `message` is the one-bug-many-tests view."
  }
};
var FAILURES_OPTIONS = {
  ...SHARED_OPTIONS,
  message: {
    type: "string",
    placeholder: "<substring>",
    describe: "Only messages containing this."
  },
  tests: {
    type: "boolean",
    describe: "List the tests behind each message. Automatic once the table is 3 rows or fewer."
  }
};
var CRASHES_OPTIONS = {
  ...SHARED_OPTIONS,
  signature: {
    type: "string",
    placeholder: "<substring>",
    describe: "Only signatures containing this."
  },
  minidumps: {
    type: "boolean",
    describe: "Print minidump IDs, which `fx-tests crash` then reads."
  }
};
var SKIPS_OPTIONS = {
  ...SHARED_OPTIONS,
  "include-run-if": {
    type: "boolean",
    describe: 'Keep run-if skips, which mean "not applicable here" rather than "disabled".'
  },
  "group-by": {
    type: "string",
    placeholder: "<test|component|directory>",
    describe: "How to group. Default test."
  }
};
var DEFAULT_LIMIT3 = 20;
async function loadTreeQuery(context, args, commandName) {
  const harness = context.globals.harness ?? "xpcshell";
  progress(context, `Reading ${harness}-issues.json\u2026`);
  const { file } = await loadIssues(context, harness);
  if ((context.globals.config.length > 0 || context.globals.excludeConfig.length > 0) && !canAttributeConfigs(file)) {
    throw usageError(
      `--config cannot be applied to ${harness}-issues.json: the file records no job names, so every configuration filter over it matches nothing`,
      "This is a property of the file, not of the tree \u2014 it dropped all attribution to be 2.8 MB. Use `fx-tests test <path> --config` for one test, which reads a bucket file."
    );
  }
  const window = resolveDayWindow(context.globals, file);
  void commandName;
  return {
    harness,
    file,
    window,
    pathPrefix: stringOption(args, "path"),
    component: stringOption(args, "component"),
    header: {
      harness,
      family: file.family,
      startDate: window.startDate,
      endDate: window.endDate,
      dayCount: window.dayCount,
      singleDay: window.singleDay,
      testCount: file.testCount,
      dataSource: context.source.name,
      canAttributeConfigs: canAttributeConfigs(file),
      recordsMinidumps: recordsMinidumps(file)
    }
  };
}
function recordsMinidumps(file) {
  return file.family !== "issues";
}
function sharedOptions(query) {
  return {
    ...query.pathPrefix === void 0 ? {} : { pathPrefix: query.pathPrefix },
    ...query.component === void 0 ? {} : { component: query.component },
    ...query.window.range === null ? {} : { dayRange: query.window.range }
  };
}
function headerLines3(header, subject, types) {
  const lines = [];
  lines.push(
    `${header.harness} ${subject} \u2014 ` + (header.singleDay ? dateWithWeekday(header.endDate) : `${header.dayCount} days (${dateWithWeekday(header.startDate)} \u2026 ${dateWithWeekday(header.endDate)})`) + `, ${count(header.testCount)} tests in the file`
  );
  if (types !== void 0) {
    lines.push(
      `  Counting ${types.join(", ")} as issues` + (types.length === DEFAULT_TYPES.length ? " (all four, as issues.html does; --type narrows it)." : " (--type changed this from the default of all four).")
    );
  }
  if (!header.canAttributeConfigs) {
    lines.push(
      "  This file records no job names, so nothing here can be broken down by configuration."
    );
  }
  return lines;
}
async function runIssues(context, args) {
  rejectPositionals(args, "issues");
  const query = await loadTreeQuery(context, args, "issues");
  const types = readTypes(args);
  const minRate = readPercent(stringOption(args, "min-rate"), "--min-rate");
  const sort = readSort3(args, ["issues", "rate", "count", "name"], "issues");
  const groupBy = readGroupBy2(args, ["component", "test", "directory", "message"], "component");
  const limit = context.globals.limit ?? DEFAULT_LIMIT3;
  if (groupBy === "message") {
    const groups = groupFailuresByMessage(query.file, {
      ...sharedOptions(query),
      maxTestsPerGroup: maxTestsFor(context)
    });
    const shown2 = applyLimit(groups, limit);
    const result2 = {
      header: query.header,
      groupBy,
      sort,
      types,
      rowCount: groups.length,
      rows: shown2.map(failureGroupJson)
    };
    emitResult2(context, result2, () => renderFailures(result2, "Issues by message"));
    return;
  }
  const grouped = groupBy === "component" || groupBy === "directory";
  const rows2 = findIssues(query.file, {
    ...sharedOptions(query),
    types,
    ...minRate === void 0 ? {} : { minRate },
    ...grouped && minRate === void 0 ? { keepClean: true } : {}
  });
  if (grouped) {
    const groups = sortGroups(groupIssues(rows2, groupBy, types), sort);
    const shown2 = applyLimit(groups, limit);
    const result2 = {
      header: query.header,
      groupBy,
      sort,
      types,
      rowCount: groups.length,
      rows: shown2
    };
    emitResult2(context, result2, () => renderIssueGroups(result2));
    return;
  }
  const sorted = sortIssueRows(rows2, sort);
  const shown = applyLimit(sorted, limit);
  const result = {
    header: query.header,
    groupBy,
    sort,
    types,
    rowCount: sorted.length,
    rows: shown.map(issueRowJson)
  };
  emitResult2(context, result, () => renderIssueRows(result));
}
function issueRowJson(row) {
  return {
    // Always the whole path, never the shortened display form: `--json` is
    // the programmatic surface and a truncated identifier in it would be
    // useless to the caller that asked for JSON precisely to avoid parsing
    // the table.
    test: row.fullPath,
    directory: row.directory,
    component: row.component,
    runCount: row.runCount,
    passCount: row.passCount,
    failCount: row.failCount,
    timeoutCount: row.timeoutCount,
    crashCount: row.crashCount,
    skipCount: row.skipCount,
    failRate: row.failRate,
    /** The dashboard's issue total over the requested `--type`s. */
    issueCount: row.issueCount,
    issueRate: row.issueRate
  };
}
function nonPassCount(counts) {
  return counts.failCount + counts.timeoutCount + counts.crashCount + counts.skipCount;
}
function sortIssueRows(rows2, sort) {
  const sorted = [...rows2];
  if (sort === "name") {
    sorted.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  } else if (sort === "count") {
    sorted.sort(
      (a, b) => nonPassCount(b) - nonPassCount(a) || a.fullPath.localeCompare(b.fullPath)
    );
  } else if (sort === "issues") {
    sorted.sort((a, b) => b.issueCount - a.issueCount || a.fullPath.localeCompare(b.fullPath));
  }
  return sorted;
}
function sortGroups(groups, sort) {
  const sorted = [...groups];
  if (sort === "name") {
    sorted.sort((a, b) => a.key.localeCompare(b.key));
  } else if (sort === "count") {
    sorted.sort((a, b) => nonPassCount(b) - nonPassCount(a) || a.key.localeCompare(b.key));
  } else if (sort === "rate") {
    sorted.sort((a, b) => b.issueRate - a.issueRate || a.key.localeCompare(b.key));
  }
  return sorted;
}
function renderIssueRows(result) {
  const sortColumn = { issues: "issues", rate: "rate", name: "Test" }[result.sort];
  const column = (header, rest = {}) => ({
    header,
    ...rest,
    // `name` sorts ascending (A→Z); the numeric orders are descending.
    ...header === sortColumn ? { sort: result.sort === "name" ? "asc" : "desc" } : {}
  });
  return {
    preamble: headerLines3(result.header, "issues by test", result.types),
    table: {
      // The path column is declared, not truncated by hand: `path: true`
      // sizes it to the longest path present and keeps the filename if a
      // cap ever bites. See `tableWithPaths()`.
      columns: [
        column("Test", { path: true }),
        column("issues", { align: "right" }),
        column("runs", { align: "right" }),
        column("fail", { align: "right" }),
        column("timeout", { align: "right" }),
        column("crash", { align: "right" }),
        column("skip", { align: "right" }),
        column("rate", { align: "right" })
      ],
      rows: result.rows.map((row) => [
        String(row.test),
        count(Number(row.issueCount)),
        count(Number(row.runCount)),
        count(Number(row.failCount)),
        count(Number(row.timeoutCount)),
        count(Number(row.crashCount)),
        count(Number(row.skipCount)),
        percent(Number(row.issueRate))
      ])
    },
    total: result.rowCount,
    shown: result.rows.length,
    epilogue: [],
    empty: emptyMessage2(result.header, result.types)
  };
}
function renderIssueGroups(result) {
  const keyHeader = result.groupBy === "component" ? "Component" : "Directory";
  const sortColumn = {
    issues: "issues",
    rate: "rate",
    name: keyHeader
  }[result.sort];
  const column = (header, rest = {}) => ({
    header,
    ...rest,
    ...header === sortColumn ? { sort: result.sort === "name" ? "asc" : "desc" } : {}
  });
  return {
    preamble: headerLines3(result.header, `issues by ${result.groupBy}`, result.types),
    table: {
      // The page's per-component columns: the issue total it ranks on,
      // how many tests contributed, and the breakdown that says what kind
      // of issue they are.
      columns: [
        // A directory key is a path and gets the path treatment; a
        // component name ("Core :: Storage: IndexedDB") is not one.
        column(keyHeader, result.groupBy === "directory" ? { path: true } : {}),
        column("issues", { align: "right" }),
        // "with issues / in the component", as the page's "(393 tests
        // with issues, out of 402)". One number would hide whether a
        // component is broadly sick or has three bad tests.
        column("tests", { align: "right" }),
        column("runs", { align: "right" }),
        column("fail", { align: "right" }),
        column("timeout", { align: "right" }),
        column("crash", { align: "right" }),
        column("skip", { align: "right" }),
        column("rate", { align: "right" })
      ],
      rows: result.rows.map((group) => [
        group.key,
        count(group.issueCount),
        `${count(group.testCount)}/${count(group.totalTestCount)}`,
        count(group.runCount),
        count(group.failCount),
        count(group.timeoutCount),
        count(group.crashCount),
        count(group.skipCount),
        percent(group.issueRate)
      ])
    },
    total: result.rowCount,
    shown: result.rows.length,
    // Suppressed when there is nothing to drill into: advice to narrow a
    // set that is already empty is worse than none.
    epilogue: result.rows.length === 0 ? [] : [
      '  Drill in with --component "<name>", or --group-by test for the tests themselves.'
    ],
    empty: emptyMessage2(result.header, result.types)
  };
}
function emptyMessage2(header, types, subject = "test", extraFilters = "") {
  const searched = `${count(header.testCount)} tests in ${header.harness}-issues.json`;
  const typeNote = types !== void 0 && types.length < DEFAULT_TYPES.length ? ` Only ${types.join(", ")} counted as issues, so --type may be why.` : "";
  return `No ${subject} matched. Searched ${searched} over ${header.startDate} \u2026 ${header.endDate}.${typeNote} Check --path (a directory prefix)${extraFilters} and --component (a substring) for typos.`;
}
async function runFailures(context, args) {
  rejectPositionals(args, "failures");
  const query = await loadTreeQuery(context, args, "failures");
  const limit = context.globals.limit ?? DEFAULT_LIMIT3;
  const groups = groupFailuresByMessage(query.file, {
    ...sharedOptions(query),
    ...optional2("message", stringOption(args, "message")),
    maxTestsPerGroup: maxTestsFor(context)
  });
  const shown = applyLimit(groups, limit);
  const result = {
    header: query.header,
    groupBy: "message",
    sort: "count",
    types: ["fail"],
    rowCount: groups.length,
    rows: shown.map(failureGroupJson)
  };
  emitResult2(
    context,
    result,
    () => renderFailures(result, "failures by message", boolOption(args, "tests"))
  );
}
function maxTestsFor(context) {
  return context.globals.format === "json" ? 0 : TEXT_MAX_TESTS_PER_GROUP;
}
var TEXT_MAX_TESTS_PER_GROUP = 50;
var AUTO_TESTS_ROW_LIMIT = 3;
function failureGroupJson(group) {
  return {
    message: group.message,
    count: group.count,
    testCount: group.testCount,
    tests: group.tests.map((test) => ({ test: test.fullPath, count: test.count })),
    testsTruncated: group.testsTruncated,
    // A Set does not survive JSON.stringify; spelled out rather than
    // silently serializing as `{}`.
    jobNames: [...group.jobNames],
    taskIds: group.taskIds
  };
}
function renderFailures(result, subject, wantTests = false) {
  return {
    preamble: headerLines3(result.header, subject),
    // `tests` is the discriminator here for the same reason it is in
    // `errors`: one message across thirty tests is one bug, and across one
    // test is another kind of bug entirely.
    table: {
      columns: [
        // Ordered by total failing runs — the only order this command
        // offers, so the marker is unconditional.
        { header: "failures", align: "right", sort: "desc" },
        { header: "tests", align: "right" },
        { header: "message" }
      ],
      rows: result.rows.map((row) => [
        count(Number(row.count)),
        count(Number(row.testCount)),
        truncate(oneLine2(String(row.message ?? "(no message recorded)")), 84)
      ])
    },
    total: result.rowCount,
    shown: result.rows.length,
    epilogue: testListLines(result.rows, wantTests),
    empty: emptyMessage2(result.header, void 0, "failure", ", --message (a substring)")
  };
}
function testListLines(rows2, wantTests) {
  if (!wantTests && rows2.length > AUTO_TESTS_ROW_LIMIT) {
    return [];
  }
  const lines = [];
  for (const row of rows2) {
    const tests = row.tests;
    if (tests.length === 0) {
      continue;
    }
    const testCount = Number(row.testCount);
    lines.push("");
    lines.push(
      `  ${count(Number(row.count))} failures in ${count(testCount)} test${testCount === 1 ? "" : "s"} \u2014 ` + truncate(oneLine2(String(row.message ?? "(no message recorded)")), 60)
    );
    for (const test of tests) {
      lines.push(`    ${count(test.count).padStart(7)}  ${test.test}`);
    }
    if (row.testsTruncated === true) {
      lines.push(
        `    \u2026 ${count(testCount - tests.length)} more tests (--json for all of them)`
      );
    }
  }
  return lines;
}
async function runCrashes(context, args) {
  rejectPositionals(args, "crashes");
  const query = await loadTreeQuery(context, args, "crashes");
  const limit = context.globals.limit ?? DEFAULT_LIMIT3;
  const wantMinidumps = boolOption(args, "minidumps");
  if (wantMinidumps && !query.header.recordsMinidumps) {
    throw usageError(
      `--minidumps cannot be answered from ${query.harness}-issues.json: its CRASH groups record signatures and counts but no minidump IDs`,
      "This is a property of the file. `fx-tests test <path> --task-ids` reads a bucket file, which carries them."
    );
  }
  const groups = groupCrashesBySignature(query.file, {
    ...sharedOptions(query),
    ...optional2("signature", stringOption(args, "signature"))
  });
  const shown = applyLimit(groups, limit);
  const result = {
    header: query.header,
    rowCount: groups.length,
    rows: shown.map((group) => crashGroupJson(group, wantMinidumps))
  };
  emitResult2(context, result, () => renderCrashes(result, wantMinidumps, query.header));
}
function crashGroupJson(group, withMinidumps) {
  const json = {
    signature: group.signature,
    count: group.count,
    testCount: group.testCount,
    tests: group.tests.map((test) => ({ test: test.fullPath, count: test.count })),
    jobNames: [...group.jobNames],
    /** How many dumps this group has that can actually be fetched. */
    minidumpCount: group.minidumps.length
  };
  if (withMinidumps) {
    json.minidumps = group.minidumps.map((dump) => ({
      taskId: dump.taskId,
      retryId: dump.retryId,
      minidumpId: dump.minidumpId,
      /** Copy-pasteable straight into `fx-tests crash`. */
      command: `fx-tests crash ${dump.taskId}.${dump.retryId} ${dump.minidumpId}`
    }));
  }
  return json;
}
function renderCrashes(result, withMinidumps, header) {
  const epilogue = [];
  const anyDumps = result.rows.some((row) => Number(row.minidumpCount) > 0);
  if (!header.recordsMinidumps) {
    epilogue.push(
      "  This file records no minidump IDs, so the dumps column is 0 for every row \u2014 that"
    );
    epilogue.push(
      "  is a property of the file, not of the crashes. `fx-tests test <path> --task-ids`"
    );
    epilogue.push("  reads a bucket file, which does carry them.");
  } else if (withMinidumps) {
    epilogue.push("Minidumps");
    for (const row of result.rows) {
      const dumps = row.minidumps;
      if (dumps === void 0 || dumps.length === 0) {
        continue;
      }
      epilogue.push(`  ${truncate(String(row.signature ?? "(not symbolized)"), 76)}`);
      for (const dump of dumps.slice(0, 3)) {
        epilogue.push(`    ${dump.command}`);
      }
      if (dumps.length > 3) {
        epilogue.push(`    \u2026 ${dumps.length - 3} more`);
      }
    }
  } else {
    const noDumps = result.rows.filter((row) => Number(row.minidumpCount) === 0);
    if (noDumps.length > 0) {
      epilogue.push(
        `  ${noDumps.length} of these have no minidump to fetch: the dump was never uploaded, so the crash is counted but cannot be read.`
      );
    }
    if (anyDumps) {
      epilogue.push("  --minidumps prints the IDs, which `fx-tests crash` reads.");
    }
  }
  return {
    preamble: headerLines3(header, "crashes by signature"),
    table: {
      columns: [
        // `groupCrashesBySignature()` orders by crash count descending.
        { header: "crashes", align: "right", sort: "desc" },
        { header: "tests", align: "right" },
        { header: "dumps", align: "right" },
        { header: "signature" }
      ],
      rows: result.rows.map((row) => [
        count(Number(row.count)),
        count(Number(row.testCount)),
        count(Number(row.minidumpCount)),
        truncate(String(row.signature ?? "(not symbolized)"), 76)
      ])
    },
    total: result.rowCount,
    shown: result.rows.length,
    epilogue,
    empty: emptyMessage2(header, void 0, "crash", ", --signature (a substring)")
  };
}
async function runSkips(context, args) {
  rejectPositionals(args, "skips");
  const query = await loadTreeQuery(context, args, "skips");
  const limit = context.globals.limit ?? DEFAULT_LIMIT3;
  const includeRunIf = boolOption(args, "include-run-if");
  const groupBy = readGroupBy2(args, ["test", "component", "directory"], "test");
  const rows2 = findSkips(query.file, {
    ...sharedOptions(query),
    includeRunIf
  });
  const runIfIsUpstreamFiltered = query.file.family !== "daily";
  const totalSkips = rows2.reduce((sum, row) => sum + row.skipCount, 0);
  if (groupBy === "component" || groupBy === "directory") {
    const groups = sortSkipGroups(
      groupSkips(rows2, groupBy, testsPerGroup(query, groupBy)),
      "skips"
    );
    const shown2 = applyLimit(groups, limit);
    const result2 = {
      header: query.header,
      groupBy,
      includeRunIf,
      runIfIsUpstreamFiltered,
      rowCount: groups.length,
      totalSkips,
      skippedTestCount: rows2.length,
      rows: shown2.map(skipGroupJson)
    };
    emitResult2(context, result2, () => renderSkipGroups(result2));
    return;
  }
  const sorted = [...rows2].sort((a, b) => b.skipCount - a.skipCount);
  const shown = applyLimit(sorted, limit);
  const result = {
    header: query.header,
    groupBy,
    includeRunIf,
    runIfIsUpstreamFiltered,
    rowCount: sorted.length,
    totalSkips,
    skippedTestCount: sorted.length,
    rows: shown.map(skipRowJson)
  };
  emitResult2(context, result, () => renderSkips(result));
}
function testsPerGroup(query, by) {
  const totals = /* @__PURE__ */ new Map();
  for (let testId = 0; testId < query.file.testCount; testId++) {
    const identity = query.file.testAt(testId);
    if (query.pathPrefix !== void 0 && !identity.fullPath.startsWith(query.pathPrefix)) {
      continue;
    }
    if (query.component !== void 0) {
      const component = identity.component;
      if (component === null || !component.toLowerCase().includes(query.component.toLowerCase())) {
        continue;
      }
    }
    const key = by === "component" ? identity.component ?? "(no component)" : identity.directory;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  return totals;
}
function groupSkips(rows2, by, totals) {
  const groups = /* @__PURE__ */ new Map();
  for (const row of rows2) {
    const key = by === "component" ? row.component ?? "(no component)" : row.directory;
    let group = groups.get(key);
    if (group === void 0) {
      group = {
        key,
        skipCount: 0,
        testCount: 0,
        totalTestCount: totals.get(key) ?? 0,
        messages: [],
        byMessage: /* @__PURE__ */ new Map()
      };
      groups.set(key, group);
    }
    group.skipCount += row.skipCount;
    group.testCount += 1;
    for (const [message, count2] of row.messages) {
      group.byMessage.set(message, (group.byMessage.get(message) ?? 0) + count2);
    }
  }
  const out = [];
  for (const group of groups.values()) {
    const { byMessage, ...rest } = group;
    out.push({
      ...rest,
      messages: [...byMessage].map(([message, count2]) => ({ message, count: count2 })).sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
    });
  }
  return out;
}
function sortSkipGroups(groups, sort) {
  void sort;
  return [...groups].sort((a, b) => b.skipCount - a.skipCount || a.key.localeCompare(b.key));
}
function skipGroupJson(group) {
  return {
    key: group.key,
    skipCount: group.skipCount,
    testCount: group.testCount,
    totalTestCount: group.totalTestCount,
    messages: group.messages
  };
}
function renderSkipGroups(result) {
  const keyHeader = result.groupBy === "component" ? "Component" : "Directory";
  return {
    preamble: skipsPreamble(result, `skips by ${result.groupBy}`),
    table: {
      columns: [
        {
          header: keyHeader,
          ...result.groupBy === "directory" ? { path: true } : {}
        },
        // Ordered by skipped runs; the only order this view offers, so
        // the marker is unconditional as it is on the per-test table.
        { header: "skips", align: "right", sort: "desc" },
        { header: "tests", align: "right" },
        { header: "reason" }
      ],
      rows: result.rows.map((row) => {
        const messages = row.messages;
        return [
          String(row.key),
          count(Number(row.skipCount)),
          `${count(Number(row.testCount))}/${count(Number(row.totalTestCount))}`,
          truncate(oneLine2(messages[0]?.message ?? "(no reason recorded)"), 50) + (messages.length > 1 ? ` (+${messages.length - 1} more)` : "")
        ];
      })
    },
    total: result.rowCount,
    shown: result.rows.length,
    epilogue: result.rows.length === 0 ? [] : [
      '  Drill in with --component "<name>", or --group-by test for the tests themselves.'
    ],
    empty: emptyMessage2(result.header, void 0, "skipped test")
  };
}
function skipRowJson(row) {
  return {
    test: row.fullPath,
    directory: row.directory,
    component: row.component,
    skipCount: row.skipCount,
    // Maps and Sets do not survive JSON.stringify.
    messages: [...row.messages].map(([message, count2]) => ({ message, count: count2 })),
    jobNames: [...row.jobNames]
  };
}
function skipsPreamble(result, subject) {
  const preamble = headerLines3(result.header, subject);
  preamble.push(
    `  ${count(result.totalSkips)} skipped runs across ${count(result.skippedTestCount)} tests.`
  );
  if (result.runIfIsUpstreamFiltered) {
    preamble.push(
      "  This is a 21-day aggregate, and the generator already dropped run-if skips from it,"
    );
    preamble.push(
      "  so --include-run-if would change nothing here. A daily file keeps them \u2014 on one"
    );
    preamble.push("  measured day they were 63.6% of all skipped runs.");
  } else if (result.includeRunIf) {
    preamble.push(
      '  Including run-if skips, which mean "not applicable on this platform" rather than'
    );
    preamble.push('  "disabled".');
  } else {
    preamble.push(
      '  Excluding run-if skips, which mean "not applicable on this platform" rather than'
    );
    preamble.push('  "disabled" (--include-run-if to keep them).');
  }
  return preamble;
}
function renderSkips(result) {
  return {
    preamble: skipsPreamble(result, "skips"),
    table: {
      columns: [
        { header: "Test", path: true },
        // `findSkips()` orders by skip count descending.
        { header: "skips", align: "right", sort: "desc" },
        { header: "reason" }
      ],
      rows: result.rows.map((row) => {
        const messages = row.messages;
        return [
          String(row.test),
          count(Number(row.skipCount)),
          truncate(oneLine2(messages[0]?.message ?? "(no reason recorded)"), 50) + (messages.length > 1 ? ` (+${messages.length - 1} more)` : "")
        ];
      })
    },
    total: result.rowCount,
    shown: result.rows.length,
    epilogue: [],
    empty: emptyMessage2(result.header, void 0, "skipped test")
  };
}
function optional2(key, value) {
  return value === void 0 ? {} : { [key]: value };
}
function rejectPositionals(args, name) {
  if (args.positionals.length > 0) {
    throw usageError(
      `${name} takes no positional arguments, got "${args.positionals[0]}"`,
      `Did you mean --path ${args.positionals[0]} or --component "${args.positionals[0]}"?`
    );
  }
}
function readTypes(args) {
  const values = listOption(args, "type");
  if (values.length === 0) {
    return [...DEFAULT_TYPES];
  }
  const allowed = ["fail", "timeout", "crash", "skip"];
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw usageError(`--type expects one of ${allowed.join(", ")}, got "${value}"`);
    }
  }
  return values;
}
function readSort3(args, allowed, fallback) {
  const value = stringOption(args, "sort") ?? fallback;
  if (!allowed.includes(value)) {
    throw usageError(`--sort expects one of ${allowed.join(", ")}, got "${value}"`);
  }
  return value;
}
function readGroupBy2(args, allowed, fallback) {
  const value = stringOption(args, "group-by") ?? fallback;
  if (!allowed.includes(value)) {
    throw usageError(`--group-by expects one of ${allowed.join(", ")}, got "${value}"`);
  }
  return value;
}
function readPercent(value, flag) {
  if (value === void 0) {
    return void 0;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw usageError(`${flag} expects a percentage between 0 and 100, got "${value}"`);
  }
  return parsed;
}
function emitResult2(context, result, build) {
  if (context.globals.format === "json") {
    emit(context, toJson(result));
    return;
  }
  const content = build();
  emit(
    context,
    context.globals.format === "markdown" ? renderMarkdownFrom2(content) : renderTextFrom2(content)
  );
}
function renderTextFrom2(content) {
  const lines = [...content.preamble, ""];
  if (content.table === null || content.table.rows.length === 0) {
    lines.push(content.empty);
  } else {
    lines.push(...tableSection(content.table.columns, content.table.rows, content));
  }
  lines.push(...content.epilogue);
  return joinLines(lines);
}
function renderMarkdownFrom2(content) {
  const lines = [];
  const [heading2, ...caveats] = content.preamble;
  lines.push(heading(heading2 ?? "Results", 1));
  lines.push("");
  for (const caveat of caveats) {
    lines.push(caveat.trim());
    lines.push("");
  }
  if (content.table === null || content.table.rows.length === 0) {
    lines.push(content.empty);
  } else {
    lines.push(...table2(content.table.columns, content.table.rows));
    lines.push(moreLine2(content.total, content.shown));
  }
  if (content.epilogue.length > 0) {
    lines.push("");
    for (const line of content.epilogue) {
      lines.push(line.trim());
    }
  }
  return joinLines(lines);
}
function oneLine2(value) {
  return value.replace(/\s*\r?\n\s*/g, " \u23CE ").trim();
}

// lib/sources/treeherder.ts
var TREEHERDER_ROOT2 = "https://treeherder.mozilla.org";
var FAILED_JOB_RESULTS = /* @__PURE__ */ new Set([
  "testfailed",
  "busted",
  "exception"
]);
var TreeherderError = class extends Error {
  url;
  status;
  constructor(message, url, status) {
    super(message);
    this.name = "TreeherderError";
    this.url = url;
    this.status = status;
  }
};
var PushNotFoundError = class extends Error {
  revision;
  repository;
  constructor(revision, repository) {
    super(`no push found for revision ${revision} on ${repository}`);
    this.name = "PushNotFoundError";
    this.revision = revision;
    this.repository = repository;
  }
};
function treeherderClient(options) {
  const root = options.root ?? TREEHERDER_ROOT2;
  const maxPages = options.maxPages ?? 100;
  async function getJson(url) {
    let response;
    try {
      response = await options.fetch(url);
    } catch (error) {
      throw new TreeherderError(
        `request to Treeherder failed: ${error.message}`,
        url
      );
    }
    if (!response.ok) {
      throw new TreeherderError(
        `Treeherder returned HTTP ${response.status}`,
        url,
        response.status
      );
    }
    const text = new TextDecoder().decode(await response.arrayBuffer());
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new TreeherderError(
        `Treeherder response is not valid JSON: ${error.message}`,
        url
      );
    }
  }
  return {
    async findPush(repository, revision) {
      const url = `${root}/api/project/${encodeURIComponent(repository)}/push/?full=true&count=10&revision=${encodeURIComponent(revision)}`;
      const data = await getJson(url);
      const first = data.results?.[0];
      if (first === void 0) {
        throw new PushNotFoundError(revision, repository);
      }
      if (typeof first.id !== "number") {
        throw new TreeherderError(
          `push for ${revision} has no numeric id`,
          url
        );
      }
      return {
        pushId: first.id,
        revision: first.revision ?? revision,
        repository,
        revisions: first.revisions ?? []
      };
    },
    async jobsOfPush(pushId) {
      const jobs = [];
      let url = `${root}/api/jobs/?push_id=${pushId}`;
      let propertyNames = null;
      let pages = 0;
      while (url !== null) {
        if (++pages > maxPages) {
          throw new TreeherderError(
            `job listing for push ${pushId} exceeded ${maxPages} pages; refusing to keep following "next"`,
            url
          );
        }
        const data = await getJson(url);
        propertyNames ??= data.job_property_names ?? null;
        if (propertyNames === null) {
          throw new TreeherderError(
            `Treeherder returned jobs with no job_property_names, so the positional rows cannot be decoded`,
            url
          );
        }
        const columns = jobColumns(propertyNames, url);
        for (const row of data.results ?? []) {
          jobs.push(readJob(row, columns));
        }
        url = data.next ?? null;
      }
      return jobs;
    }
  };
}
function jobColumns(propertyNames, url) {
  const required = ["id", "job_type_name", "task_id", "retry_id", "state", "result"];
  const missing = required.filter((name) => !propertyNames.includes(name));
  if (missing.length > 0) {
    throw new TreeherderError(
      `Treeherder's job_property_names is missing ${missing.join(", ")}; got: ${propertyNames.join(", ")}`,
      url
    );
  }
  return {
    jobId: propertyNames.indexOf("id"),
    jobName: propertyNames.indexOf("job_type_name"),
    taskId: propertyNames.indexOf("task_id"),
    retryId: propertyNames.indexOf("retry_id"),
    state: propertyNames.indexOf("state"),
    result: propertyNames.indexOf("result")
  };
}
function readJob(row, columns) {
  return {
    jobId: Number(row[columns.jobId] ?? 0),
    jobName: String(row[columns.jobName] ?? ""),
    taskId: String(row[columns.taskId] ?? ""),
    // A null `retry_id` means run 0, which is how Treeherder writes the
    // first run of a task.
    retryId: Number(row[columns.retryId] ?? 0),
    state: String(row[columns.state] ?? ""),
    result: String(row[columns.result] ?? "")
  };
}

// lib/sources/intermittents.ts
var BUGZILLA_ROOT = "https://bugzilla.mozilla.org";
var UNKNOWN_TASK_ID = "unknown";
var IntermittentsError = class extends Error {
  url;
  status;
  constructor(message, url, status) {
    super(message);
    this.name = "IntermittentsError";
    this.url = url;
    this.status = status;
  }
};
var TREE_GROUPS = ["trunk", "firefox-releases", "comm-releases"];
function intermittentsClient(options) {
  const root = options.root ?? TREEHERDER_ROOT2;
  const bugzillaRoot = options.bugzillaRoot ?? BUGZILLA_ROOT;
  async function getJson(url) {
    let response;
    try {
      response = await options.fetch(url);
    } catch (error) {
      throw new IntermittentsError(
        `request failed: ${error.message}`,
        url
      );
    }
    if (!response.ok) {
      throw new IntermittentsError(`HTTP ${response.status}`, url, response.status);
    }
    const text = new TextDecoder().decode(await response.arrayBuffer());
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new IntermittentsError(
        `response is not valid JSON: ${error.message}`,
        url
      );
    }
  }
  return {
    async rankBugs(tree, range) {
      const url = `${root}/api/failures/?${rangeQuery(tree, range)}`;
      const rows2 = await getJson(url);
      return rows2.map((row) => ({ bugId: row.bug_id, count: row.bug_count }));
    },
    async occurrencesOfBug(tree, range, bug) {
      const url = `${root}/api/failuresbybug/?${rangeQuery(tree, range)}&bug=${bug}`;
      const rows2 = await getJson(url);
      return rows2.map((row) => ({
        bugId: row.bug_id,
        jobId: row.job_id,
        testSuite: row.test_suite,
        platform: row.platform,
        buildType: row.build_type,
        revision: row.revision,
        tree: row.tree,
        pushTime: row.push_time,
        machineName: row.machine_name,
        taskId: row.task_id,
        runId: null,
        lines: row.lines
      }));
    },
    async runIdsOfJobs(jobIds) {
      const found = /* @__PURE__ */ new Map();
      for (const batch of chunk([...new Set(jobIds)], JOB_BATCH_SIZE)) {
        if (batch.length === 0) {
          continue;
        }
        const url = `${root}/api/jobs/?id__in=${batch.join(",")}`;
        const data = await getJson(url);
        if (data.next != null) {
          throw new IntermittentsError(
            `Treeherder paginated a ${batch.length}-job request, so ${JOB_BATCH_SIZE} is above its current page size; lower JOB_BATCH_SIZE or follow "next"`,
            url
          );
        }
        const names = data.job_property_names ?? [];
        const idColumn = names.indexOf("id");
        const retryColumn = names.indexOf("retry_id");
        if (idColumn === -1 || retryColumn === -1) {
          throw new IntermittentsError(
            `Treeherder's job_property_names is missing id or retry_id, so the positional rows cannot be decoded; got: ${names.join(", ")}`,
            url
          );
        }
        for (const row of data.results ?? []) {
          found.set(Number(row[idColumn]), Number(row[retryColumn] ?? 0));
        }
      }
      return found;
    },
    async bugSummaries(bugs) {
      const found = /* @__PURE__ */ new Map();
      for (const batch of chunk(bugs, BUG_BATCH_SIZE)) {
        if (batch.length === 0) {
          continue;
        }
        const url = `${bugzillaRoot}/rest/bug?id=${batch.join(",")}&include_fields=id,summary`;
        const data = await getJson(url);
        for (const bug of data.bugs ?? []) {
          found.set(bug.id, bug.summary);
        }
      }
      return found;
    }
  };
}
var BUG_BATCH_SIZE = 100;
var JOB_BATCH_SIZE = 200;
function rangeQuery(tree, range) {
  return `startday=${encodeURIComponent(range.start)}&endday=${encodeURIComponent(range.end)}&tree=${encodeURIComponent(tree)}`;
}
function chunk(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}
function harnessOfOccurrence(testSuite) {
  if (/(^|-)mochitest(-|$)/.test(testSuite)) {
    return "mochitest";
  }
  return /(^|-)xpcshell(-|$)/.test(testSuite) ? "xpcshell" : null;
}
function stripSuiteChunk(testSuite) {
  return testSuite.replace(/-\d+$/, "");
}
function testPathCandidates(summary) {
  const found = [];
  for (const match of summary.matchAll(TEST_PATH_TOKEN)) {
    const path = match[1];
    if (!found.includes(path)) {
      found.push(path);
    }
  }
  return found;
}
var TEST_PATH_TOKEN = /\b((?:[\w.+-]+\/)+[\w.+-]+\.(?:js|mjs|html|xhtml|xul|sjs|py|toml|ini))\b/g;
function summaryRemainder(summary, path) {
  let rest = summary.replace(TRIAGE_PREFIX, "");
  if (path !== null) {
    rest = rest.replace(path, "");
  }
  return rest.replace(/^[\s|:-]+/, "").replace(/[\s|]+$/, "").trim();
}
var TRIAGE_PREFIX = /^(?:(?:perma(?:nent|fail)[a-z]*\b|perma\b|frequent[a-z]*\b|intermittent[a-z]*\b|high frequ[en]*cy\b|\[meta\]|\[tier \d\]|\[?not ?a ?leak\]?)[\s|:-]*)+/i;
function testPathOfLine(line) {
  const marker = line.indexOf("TEST-UNEXPECTED-FAIL");
  if (marker === -1) {
    return null;
  }
  const fields2 = line.slice(marker).split("|");
  const candidate = fields2[1]?.trim();
  if (candidate === void 0 || candidate.length === 0) {
    return null;
  }
  return candidate;
}

// lib/model/marker-messages.ts
function partitionMarkerMessages(messages) {
  const seenMessage = /* @__PURE__ */ new Set();
  const seenProfile = /* @__PURE__ */ new Set();
  const out = { messages: [], profileFilenames: [] };
  for (const entry of messages) {
    const message = typeof entry === "string" ? entry : entry.message;
    if (!message) {
      continue;
    }
    const filename = uploadedProfileName(message);
    if (filename !== null) {
      if (!seenProfile.has(filename)) {
        seenProfile.add(filename);
        out.profileFilenames.push(filename);
      }
      continue;
    }
    if (seenMessage.has(message)) {
      continue;
    }
    seenMessage.add(message);
    out.messages.push(message);
  }
  return out;
}

// lib/query/intermittents.ts
function scanBugs(options) {
  const { ranking, summaries, harnessOfPath } = options;
  const noBugCount = ranking.filter((row) => row.bugId === null).reduce((sum, row) => sum + row.count, 0);
  const candidates = ranking.filter(
    (row) => row.bugId !== null
  );
  const rows2 = candidates.map((candidate) => {
    const bugSummary = summaries.get(candidate.bugId) ?? null;
    const summary = bugSummary ?? "";
    const verified = testPathCandidates(summary).map((path) => ({ path, harness: harnessOfPath(path) })).find((entry) => entry.harness !== null);
    return verified === void 0 ? {
      bugId: candidate.bugId,
      count: candidate.count,
      harness: "unknown",
      test: null,
      failure: summaryRemainder(summary, null),
      bugSummary
    } : {
      bugId: candidate.bugId,
      count: candidate.count,
      harness: verified.harness,
      test: verified.path,
      failure: summaryRemainder(summary, verified.path),
      bugSummary
    };
  });
  const ordered = [...rows2].sort((a, b) => b.count - a.count);
  const count2 = (harness) => ordered.filter((row) => row.harness === harness).length;
  return {
    rows: ordered,
    coverage: {
      ranked: ranking.length,
      scanned: candidates.length,
      mochitest: count2("mochitest"),
      xpcshell: count2("xpcshell"),
      unknown: count2("unknown"),
      noBugCount
    }
  };
}
function selectHarness(rows2, harness) {
  return harness === void 0 ? [...rows2] : rows2.filter((row) => row.harness === harness);
}
function bugsNamingTest(rows2, test) {
  return rows2.filter((row) => row.test === test);
}
function tallyTests(occurrences) {
  return tally(
    occurrences.flatMap((row) => [
      ...new Set(
        partitionOccurrenceLines(row).messages.map((line) => testPathOfLine(line)).filter((path) => path !== null)
      )
    ])
  );
}
function partitionOccurrenceLines(occurrence) {
  return partitionMarkerMessages(occurrence.lines);
}
function tally(names) {
  const counts = /* @__PURE__ */ new Map();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count2]) => ({ name, count: count2 })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
function occurrenceConfiguration(row) {
  return `${occurrenceConfig(row)} ${row.testSuite}`;
}
var RERUN_SUFFIX = /-2(\.\w+\.json)$/;
function occurrenceProfiles(occurrences) {
  const rows2 = [];
  for (const occurrence of occurrences) {
    const filenames = partitionOccurrenceLines(occurrence).profileFilenames;
    if (filenames.length === 0) {
      continue;
    }
    rows2.push({
      run: occurrence.runId === null ? occurrence.taskId : `${occurrence.taskId}.${occurrence.runId}`,
      taskId: occurrence.taskId,
      runId: occurrence.runId,
      configuration: occurrenceConfiguration(occurrence),
      profiles: filenames.map((filename) => ({
        filename,
        // `runId` and `taskId` both have to be real. See
        // `OccurrenceProfile.url`: no guessed `runs/0`, and no
        // `/task/unknown/` — `"unknown"` is a documented sentinel on
        // this field (`lib/sources/intermittents.ts`), not a task.
        url: occurrence.runId === null || occurrence.taskId === UNKNOWN_TASK_ID ? null : testInfoArtifactUrl(
          occurrence.taskId,
          occurrence.runId,
          filename
        ),
        isRerun: RERUN_SUFFIX.test(filename)
      }))
    });
  }
  return rows2;
}
function occurrenceConfig(row) {
  return `${row.platform}/${row.buildType}`;
}
function occurrenceHistory(occurrences, range) {
  const counts = /* @__PURE__ */ new Map();
  for (let day = 0; ; day++) {
    const date = dateOfDay(range.start, day);
    if (date > range.end) {
      break;
    }
    counts.set(date, 0);
  }
  for (const row of occurrences) {
    const date = row.pushTime.slice(0, 10);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts].map(([date, count2]) => ({ date, count: count2 })).sort((a, b) => a.date.localeCompare(b.date));
}
function summariseBug(bugId, occurrences, filter = {}) {
  const rows2 = filterOccurrences(occurrences, filter);
  return {
    bugId,
    occurrences: rows2.length,
    totalOccurrences: occurrences.length,
    jobNames: tally(rows2.map((row) => stripSuiteChunk(row.testSuite))),
    platforms: tally(rows2.map((row) => row.platform)),
    buildTypes: tally(rows2.map((row) => row.buildType)),
    trees: tally(rows2.map((row) => row.tree)),
    tests: tallyTests(rows2),
    // Per occurrence, like every other tally here: a job emits the marker
    // once per failing assertion, so counting raw lines reports a job that
    // failed eighteen assertions as eighteen jobs.
    //
    // Partitioned first, so a `profile uploaded in …` notice is never
    // counted as a failure message. See `partitionOccurrenceLines`.
    lines: tally(
      rows2.flatMap((row) => [
        ...new Set(partitionOccurrenceLines(row).messages.map(failureLineDetail))
      ])
    ),
    unclassifiedOccurrences: rows2.filter(
      (row) => harnessOfOccurrence(row.testSuite) === null
    ).length
  };
}
function filterOccurrences(occurrences, filter = {}) {
  const matchesConfig = configFilter(filter.config ?? [], filter.excludeConfig ?? []);
  return occurrences.filter(
    (row) => (filter.harness === void 0 || harnessOfOccurrence(row.testSuite) === filter.harness) && matchesConfig(occurrenceConfig(row))
  );
}
function stripLogTimestamp(line) {
  return line.replace(/^\d{2}:\d{2}:\d{2}\s+\w+\s+-\s+/, "").trim();
}
function failureLineDetail(line) {
  const stripped = stripLogTimestamp(line);
  const marker = stripped.indexOf("TEST-UNEXPECTED-FAIL");
  if (marker === -1) {
    return stripped;
  }
  const fields2 = stripped.slice(marker).split("|");
  const rest = fields2.slice(2).join("|").trim();
  return rest.length === 0 ? stripped : normaliseDuration(rest);
}
function normaliseDuration(message) {
  return message.replace(/\b\d+ms\b/g, "<n>ms");
}

// cli/commands/intermittent.ts
var DEFAULT_LIMIT4 = 20;
var DEFAULT_DAYS = 7;
var MIXED_CELL_WIDTH = 36;
var FAILURE_WIDTH = 32;
var DRILLDOWN_ROWS = 10;
var INTERMITTENT_OPTIONS = {
  // Two globals whose shared wording is wrong here, restated rather than left
  // to mislead. A command's own spec wins the merge in `dispatch()`, so this
  // is the supported way to say what the flag means for this command — the
  // same rule as declaring a global rejected, applied to a flag that works but
  // works differently.
  harness: {
    type: "string",
    placeholder: "<mochitest|xpcshell|unknown>",
    describe: "Rank only bugs naming a test of this harness. `unknown` is the bugs naming no known test. Omit for all three."
  },
  day: {
    type: "string",
    placeholder: "<date>",
    describe: "One day, YYYY-MM-DD. No today/yesterday: this is a live API, not the published window."
  },
  since: {
    type: "number",
    placeholder: "<n>",
    describe: "The last n days, ending today (UTC). Default 7."
  },
  tree: {
    type: "string",
    placeholder: "<name>",
    describe: "Repository, repo group (trunk, firefox-releases, comm-releases) or all. Default trunk."
  },
  bug: {
    type: "number",
    placeholder: "<id>",
    describe: "Drill into one bug: its occurrences, platforms, task ids and log lines."
  },
  // `--test`, not `--path`: on this command it selects one bug, which is what
  // `try --test` and `errors --test` do, where `--path <prefix>` filters many
  // tests on `issues`, `failures`, `crashes`, `skips` and `flaky`.
  test: {
    type: "string",
    placeholder: "<path>",
    describe: "Drill into the bug annotated on this exact test path, instead of --bug. Lists them all when several bugs name it."
  },
  profiles: {
    type: "boolean",
    describe: "With --bug or --test, print the raw per-test profile artifact URL of every occurrence whose log named one."
  },
  // Named after `test --history`, which prints the same shape from the
  // nightly aggregates: one flag name for "break the window down by day",
  // whichever command the caller reached it from.
  history: {
    type: "boolean",
    describe: "With --bug or --test, print annotations per day over the window, zero days included."
  }
};
var INTERMITTENT_NOTES = [
  "What a row is:",
  "  One bug a sheriff attached to failing jobs, and how many jobs. These are human",
  "  judgements, not computed rates: a failure nobody triaged has no row here. So",
  "  this ranks what is costing sheriffs time; `fx-tests issues` and `fx-tests flaky`",
  "  rank what fails most.",
  "",
  "How a bug is placed:",
  "  Treeherder ranks bugs with no harness parameter, so a bug counts as a mochitest",
  "  (or xpcshell) bug when its summary names a test path that harness's data holds \u2014",
  "  the same test lists `fx-tests test` resolves against. A bug naming no test this",
  "  tool knows is `unknown`: an infrastructure failure, a suite this tool does not",
  "  read, or a summary that never named a path.",
  "",
  "  With no --harness every annotated bug is ranked together, which is the whole",
  "  picture. --harness mochitest, xpcshell or unknown ranks one group of it.",
  "",
  "  Every bug in the window is classified \u2014 there is no per-bug request to economise",
  "  on \u2014 so the ranking is complete. --limit sets how many rows print, and --json",
  "  prints them all. Use `fx-tests test <path>` to dig into one of the tests named.",
  "",
  "The window:",
  "  --day <date> is one day, --since <n> the last n days ending today (UTC), default",
  "  7. Unlike everywhere else in this CLI there is no published window and no",
  '  "today"/"yesterday" keyword \u2014 this is a live API, not the nightly aggregates.'
];
async function runIntermittent(context, args) {
  if (args.positionals.length > 0) {
    throw usageError(
      `intermittent takes no arguments, got "${args.positionals[0]}"`,
      "Use --bug <id> to drill into one bug, or no argument for the ranked list."
    );
  }
  const client = context.intermittents;
  if (client === void 0) {
    throw new Error("intermittent requires an intermittents client");
  }
  const { globals } = context;
  const tree = stringOption(args, "tree") ?? "trunk";
  const range = resolveRange(globals.day, globals.since);
  const bug = numberOption(args, "bug");
  const test = stringOption(args, "test");
  if (bug !== void 0 && test !== void 0) {
    throw usageError(
      "--bug and --test both select one bug, so only one of them can be given",
      "Use --test <path> when you have a failing test and no bug number, --bug <id> otherwise."
    );
  }
  if (bug !== void 0) {
    await runDrilldown(context, client, tree, range, bug, args);
    return;
  }
  if (test !== void 0) {
    await runTestDrilldown(context, client, tree, range, test, args);
    return;
  }
  if (boolOption(args, "profiles")) {
    throw usageError(
      "--profiles needs one bug: the ranked list\u2019s rows are bugs, and a profile is an artifact of a single job",
      "Use --bug <id> --profiles, or --test <path> --profiles."
    );
  }
  if (boolOption(args, "history")) {
    throw usageError(
      "--history needs one bug: the ranked list\u2019s rows are bugs, and a per-day breakdown is a property of one bug\u2019s occurrences",
      "Use --bug <id> --history, or --test <path> --history."
    );
  }
  if (globals.config.length > 0 || globals.excludeConfig.length > 0) {
    throw usageError(
      "--config cannot be applied to the ranked list: its rows are bugs, and a bug spans every configuration it was annotated on",
      "Use --bug <id> --config <substring> to filter one bug\u2019s occurrences."
    );
  }
  await runRanking(context, client, tree, range, args);
}
async function runRanking(context, client, tree, range, args) {
  const { globals } = context;
  const harness = readHarnessSelector(args);
  const limit = globals.limit ?? DEFAULT_LIMIT4;
  progress(context, `Ranking annotated bugs on ${tree} for ${range.start}..${range.end}\u2026`);
  const ranking = await withUpstreamErrors(() => client.rankBugs(tree, range), tree);
  const candidates = ranking.filter((row) => row.bugId !== null).map((row) => row.bugId);
  progress(context, `Reading ${candidates.length} bug summaries\u2026`);
  const summaries = await withUpstreamErrors(() => client.bugSummaries(candidates), tree);
  progress(context, "Reading the mochitest and xpcshell test lists\u2026");
  const harnessOfPath = await loadHarnessOfPath(context);
  const scan = scanBugs({ ranking, summaries, harnessOfPath });
  const selected = selectHarness(scan.rows, harness);
  const shown = applyLimit(selected, limit);
  if (globals.format === "json") {
    emit(
      context,
      toJson({
        harness: harness ?? null,
        tree,
        startday: range.start,
        endday: range.end,
        coverage: scan.coverage,
        matchCount: selected.length,
        rows: selected
      })
    );
    return;
  }
  emit(
    context,
    globals.format === "markdown" ? renderRankingMarkdown(harness, tree, range, shown, selected, scan) : renderRankingText(harness, tree, range, shown, selected, scan)
  );
}
function readHarnessSelector(args) {
  const value = stringOption(args, "harness");
  if (value === void 0) {
    return void 0;
  }
  if (value !== "mochitest" && value !== "xpcshell" && value !== "unknown") {
    throw usageError(
      `--harness expects mochitest, xpcshell or unknown, got "${value}"`,
      "Omit --harness to rank every annotated bug, whatever its classification."
    );
  }
  return value;
}
async function loadHarnessOfPath(context) {
  const known = /* @__PURE__ */ new Map();
  for (const harness of ["mochitest", "xpcshell"]) {
    const file = await fetchJson(context.source, {
      index: timingsIndex(harness),
      filename: `${harness}-issues.json`
    });
    for (const path of collectTestPaths([file])) {
      if (!known.has(path)) {
        known.set(path, harness);
      }
    }
  }
  return (path) => known.get(path) ?? null;
}
async function runTestDrilldown(context, client, tree, range, test, args) {
  progress(context, `Ranking annotated bugs on ${tree} for ${range.start}..${range.end}\u2026`);
  const ranking = await withUpstreamErrors(() => client.rankBugs(tree, range), tree);
  const candidates = ranking.filter((row) => row.bugId !== null).map((row) => row.bugId);
  progress(context, `Reading ${candidates.length} bug summaries\u2026`);
  const summaries = await withUpstreamErrors(() => client.bugSummaries(candidates), tree);
  progress(context, "Reading the mochitest and xpcshell test lists\u2026");
  const harnessOfPath = await loadHarnessOfPath(context);
  const matches = bugsNamingTest(scanBugs({ ranking, summaries, harnessOfPath }).rows, test);
  if (matches.length === 0) {
    throw notFoundError(
      `no sheriff-annotated bug names the test ${test} on ${tree} between ${range.start} and ${range.end}`,
      "A bug is matched by the exact test path in its summary, so a directory prefix will not do. Widen the window with --since <n>, or run without --test to see what was annotated."
    );
  }
  if (matches.length > 1) {
    emit(context, renderTestMatches(test, tree, range, matches, context.globals.format));
    return;
  }
  await runDrilldown(context, client, tree, range, matches[0].bugId, args);
}
function renderTestMatches(test, tree, range, matches, format) {
  const title = `${count(matches.length)} sheriff-annotated bugs name ${test} on ${tree}, ${range.start} to ${range.end}`;
  if (format === "markdown") {
    return joinLines([
      heading(title),
      "",
      ...table2(
        [{ header: "count", align: "right" }, { header: "bug" }, { header: "failure" }],
        matches.map((row) => [
          count(row.count),
          `[${row.bugId}](https://bugzilla.mozilla.org/show_bug.cgi?id=${row.bugId})`,
          row.failure
        ])
      )
    ]);
  }
  if (format === "json") {
    return toJson({
      test,
      tree,
      startday: range.start,
      endday: range.end,
      matchCount: matches.length,
      rows: matches
    });
  }
  return joinLines([
    ...wrapText(title),
    "",
    ...tableSection(
      [
        { header: "count", align: "right", sort: "desc" },
        { header: "bug", align: "right" },
        { header: "failure" }
      ],
      matches.map((row) => [count(row.count), String(row.bugId), row.failure]),
      { total: matches.length, shown: matches.length, fit: true }
    ),
    "Drill into one with --bug <id>."
  ]);
}
async function runDrilldown(context, client, tree, range, bug, args) {
  const { globals } = context;
  progress(context, `Reading occurrences of bug ${bug} on ${tree} for ${range.start}..${range.end}\u2026`);
  const raw = await withUpstreamErrors(() => client.occurrencesOfBug(tree, range, bug), tree);
  if (raw.length === 0) {
    throw notFoundError(
      `no sheriff annotations for bug ${bug} on ${tree} between ${range.start} and ${range.end}`,
      "Annotations are per tree and per day range: widen with --since <n>, or try --tree all. A bug with no annotations in the window is not in this data at all."
    );
  }
  const occurrences = await withRunIds(context, client, tree, raw);
  const filter = {
    ...globals.harness === void 0 ? {} : { harness: globals.harness },
    ...globals.config.length === 0 ? {} : { config: globals.config },
    ...globals.excludeConfig.length === 0 ? {} : { excludeConfig: globals.excludeConfig }
  };
  const summary = summariseBug(bug, occurrences, filter);
  const shownOccurrences = filterOccurrences(occurrences, filter);
  if (shownOccurrences.length === 0) {
    throw notFoundError(
      `bug ${bug} has ${occurrences.length} annotations on ${tree}, but none match the filter`,
      "Run without --harness/--config to see every configuration it was annotated on."
    );
  }
  const summaries = await withUpstreamErrors(() => client.bugSummaries([bug]), tree);
  const bugSummary = summaries.get(bug) ?? null;
  const profiles = globals.format === "json" || boolOption(args, "profiles") ? occurrenceProfiles(shownOccurrences) : null;
  const history = occurrenceHistory(shownOccurrences, range);
  if (globals.format === "json") {
    emit(
      context,
      toJson({
        ...summary,
        tree,
        startday: range.start,
        endday: range.end,
        bugSummary,
        occurrenceRows: shownOccurrences,
        profiles: profiles ?? [],
        history
      })
    );
    return;
  }
  const shownHistory = boolOption(args, "history") ? history : null;
  emit(
    context,
    globals.format === "markdown" ? renderBugMarkdown(
      summary,
      bugSummary,
      tree,
      range,
      shownOccurrences,
      profiles,
      shownHistory
    ) : renderBugText(
      summary,
      bugSummary,
      tree,
      range,
      shownOccurrences,
      globals.limit,
      profiles,
      shownHistory
    )
  );
}
async function withRunIds(context, client, tree, occurrences) {
  const jobIds = occurrences.map((row) => row.jobId).filter((id) => Number.isFinite(id) && id > 0);
  if (jobIds.length === 0) {
    return [...occurrences];
  }
  progress(context, `Reading the run index of ${jobIds.length} jobs\u2026`);
  let runIds;
  try {
    runIds = await withUpstreamErrors(() => client.runIdsOfJobs(jobIds), tree);
  } catch (error) {
    warn(
      context,
      `could not read job run indexes (${error.message}); task ids are printed without one`
    );
    return [...occurrences];
  }
  return occurrences.map((row) => ({ ...row, runId: runIds.get(row.jobId) ?? null }));
}
function resolveRange(day, since, today = /* @__PURE__ */ new Date()) {
  if (day !== void 0) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw usageError(
        `--day expects YYYY-MM-DD, got "${day}"`,
        'This command queries a live API rather than the published window, so the "today" and "yesterday" keywords \u2014 which mean "the newest day with data" elsewhere \u2014 do not apply. Use --since <n> for a relative range.'
      );
    }
    return { start: day, end: day };
  }
  const days = since ?? DEFAULT_DAYS;
  const end = isoDay(today);
  const start = isoDay(new Date(today.getTime() - (days - 1) * 24 * 60 * 60 * 1e3));
  return { start, end };
}
function isoDay(date) {
  return date.toISOString().slice(0, 10);
}
async function withUpstreamErrors(work, tree) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof IntermittentsError) {
      if (error.status === 400) {
        throw usageError(
          `Treeherder rejected the query, which for these endpoints means an unknown tree: "${tree}"`,
          `--tree takes a repository name (autoland, mozilla-central, \u2026), a repo group (${TREE_GROUPS.join(", ")}), or all.`
        );
      }
      throw upstreamError(
        `${error.message} from ${error.url}`,
        "Treeherder\u2019s intermittents API and Bugzilla are both live services; retrying may work."
      );
    }
    throw error;
  }
}
function coverageLines(coverage, harness, selected) {
  const sentences = [];
  const lines = [];
  if (harness === void 0) {
    sentences.push(
      `All ${count(coverage.scanned)} annotated bugs, ranked by count: ${count(coverage.mochitest)} name a mochitest test, ${count(coverage.xpcshell)} an xpcshell test, and ${count(coverage.unknown)} name no test this tool knows.`
    );
    sentences.push(
      "A bug is placed by the test path in its summary, checked against the published test lists. --harness mochitest, xpcshell or unknown ranks one group."
    );
  } else if (harness === "unknown") {
    sentences.push(
      `${count(selected)} of ${count(coverage.scanned)} annotated bugs name no test this tool knows \u2014 infrastructure failures, suites it does not read, and tests whose summary does not name a path.`
    );
  } else {
    sentences.push(
      `${count(selected)} of ${count(coverage.scanned)} annotated bugs name a verified ${harness} test. The rest: ${count(harness === "mochitest" ? coverage.xpcshell : coverage.mochitest)} name a test of the other harness, ${count(coverage.unknown)} name no test this tool knows (--harness unknown ranks those).`
    );
  }
  if (coverage.noBugCount > 0) {
    sentences.push(
      `Excluded: ${count(coverage.noBugCount)} annotations with no bug attached, which carry no summary to read a test path from.`
    );
  }
  for (const sentence of sentences) {
    lines.push(...wrapText(sentence));
  }
  lines.push("");
  lines.push("count = jobs sheriffs annotated with this bug.");
  return lines;
}
function testCell(row) {
  return row.test ?? "";
}
function rankingTitle(harness, tree, range) {
  const what = harness === void 0 ? "Sheriff-annotated intermittents" : harness === "unknown" ? "Sheriff-annotated bugs naming no known test" : `Sheriff-annotated ${harness} intermittents`;
  return `${what} on ${tree}, ${range.start} to ${range.end}`;
}
function renderRankingText(harness, tree, range, shown, selected, scan) {
  const lines = [
    ...wrapText(rankingTitle(harness, tree, range)),
    "",
    ...coverageLines(scan.coverage, harness, selected.length),
    ""
  ];
  if (shown.length === 0) {
    lines.push(emptySelectionLine(harness, scan));
    return joinLines(lines);
  }
  const columns = harness === "unknown" ? [
    { header: "count", align: "right", sort: "desc" },
    { header: "bug", align: "right" },
    // The only text column in this mode, so it gets the whole
    // remaining width: a budget would just be a second cap under
    // the one `fit` already applies.
    { header: "failure", maxWidth: MIXED_CELL_WIDTH + FAILURE_WIDTH }
  ] : [
    { header: "count", align: "right", sort: "desc" },
    { header: "bug", align: "right" },
    // `path: true` in every mode that shows this column, because
    // it now holds only paths. Path truncation cuts from the
    // front to save the basename, which is the copyable part; it
    // used to be withheld here because the same cell also carried
    // prose, and front-truncating a sentence mangles it.
    { header: "test", path: true },
    { header: "failure", maxWidth: FAILURE_WIDTH }
  ];
  lines.push(
    ...tableSection(
      columns,
      shown.map(
        (row) => harness === "unknown" ? [count(row.count), String(row.bugId), row.failure] : [count(row.count), String(row.bugId), testCell(row), row.failure]
      ),
      // Fitted: `test` and `failure` both hold content wider than any
      // budget, so the two have to be reconciled against the real width.
      { total: selected.length, shown: shown.length, fit: true }
    )
  );
  return joinLines(lines);
}
function emptySelectionLine(harness, scan) {
  if (harness === void 0) {
    return "No bug was annotated in this window.";
  }
  if (harness === "unknown") {
    return `Every one of the ${count(scan.coverage.scanned)} annotated bugs named a test this tool knows.`;
  }
  return `No bug among the ${count(scan.coverage.scanned)} annotated named a verified ${harness} test.`;
}
function renderRankingMarkdown(harness, tree, range, shown, selected, scan) {
  const lines = [
    heading(rankingTitle(harness, tree, range)),
    "",
    ...coverageLines(scan.coverage, harness, selected.length),
    ""
  ];
  if (shown.length === 0) {
    lines.push(emptySelectionLine(harness, scan));
    return joinLines(lines);
  }
  const link = (row) => `[${row.bugId}](https://bugzilla.mozilla.org/show_bug.cgi?id=${row.bugId})`;
  lines.push(
    ...table2(
      harness === "unknown" ? [{ header: "count", align: "right" }, { header: "bug" }, { header: "failure" }] : [
        { header: "count", align: "right" },
        { header: "bug" },
        { header: "test" },
        { header: "failure" }
      ],
      // Untruncated: `--markdown` is for pasting into a bug.
      shown.map(
        (row) => harness === "unknown" ? [count(row.count), link(row), row.failure] : [count(row.count), link(row), testCell(row), row.failure]
      )
    )
  );
  const more = moreLine2(selected.length, shown.length);
  if (more !== null) {
    lines.push("");
    lines.push(more);
  }
  return joinLines(lines);
}
function drilldownCountLine(drilldown, tree, range) {
  const scope = drilldown.occurrences === drilldown.totalOccurrences ? `${count(drilldown.occurrences)} sheriff annotations` : `${count(drilldown.occurrences)} of ${count(drilldown.totalOccurrences)} sheriff annotations match the filter`;
  return `${scope} on ${tree}, ${range.start} to ${range.end}`;
}
function headlineLines(bugId, bugSummary) {
  const label = "Summary: ";
  const width = renderWidth();
  const wrapWidth = width === null ? null : Math.max(MIN_SUMMARY_WIDTH, width - label.length);
  const wrapped = wrapText(bugSummary ?? "(no summary from Bugzilla)", wrapWidth);
  const hang = " ".repeat(label.length);
  return [
    `Bug #: ${bugId}`,
    ...wrapped.map((line, i) => {
      if (i === 0) {
        return `${label}${line}`;
      }
      return wrapWidth !== null && line.length > wrapWidth ? line : `${hang}${line}`;
    })
  ];
}
var MIN_SUMMARY_WIDTH = 20;
function renderBugText(drilldown, bugSummary, tree, range, occurrences, limit, profiles, history) {
  const lines = [
    ...headlineLines(drilldown.bugId, bugSummary),
    ...wrapText(drilldownCountLine(drilldown, tree, range)),
    ""
  ];
  lines.push(...tallySection("Failure messages, per annotated job", drilldown.lines, limit, 140));
  lines.push(...tallySection("Job names, chunk numbers merged", drilldown.jobNames, limit));
  lines.push(...tallySection("Platforms", drilldown.platforms, limit));
  lines.push(...tallySection("Build types", drilldown.buildTypes, limit));
  lines.push(...tallySection("Trees", drilldown.trees, limit));
  lines.push(...tallySection("Tests named, per annotated job", drilldown.tests, limit));
  if (drilldown.tests.length === 0) {
    lines.push("Tests named, per annotated job");
    lines.push(
      "  (none: no occurrence carried a TEST-UNEXPECTED-FAIL line naming a test \u2014 the API only keeps lines matching that marker)"
    );
    lines.push("");
  }
  if (history !== null) {
    lines.push(...historySection(history));
  }
  const rows2 = applyLimit(occurrences, limit ?? DRILLDOWN_ROWS);
  lines.push(`Occurrences (${count(occurrences.length)})`);
  lines.push(
    ...table(
      [
        { header: "push time" },
        { header: "tree" },
        // The two widest columns carry budgets so `fit` has something
        // to shave: the rest are short enough that cutting them would
        // destroy the value rather than shorten it — a truncated task
        // id cannot be looked up, and `opt`/`debug` is already minimal.
        { header: "platform", maxWidth: 24 },
        { header: "build" },
        { header: "job name", maxWidth: 30 },
        // `<taskId>.<runId>`, the format `test --task-ids` and
        // Treeherder both use. The run index is not decoration: a task
        // retried after an `exception` has its annotated failure in run
        // 1, and every artifact URL built from run 0 then 404s.
        { header: "task id" }
      ],
      rows2.map((row) => [
        row.pushTime,
        row.tree,
        row.platform,
        row.buildType,
        row.testSuite,
        taskRunId(row)
      ]),
      "  ",
      { fit: true }
    )
  );
  if (rows2.length < occurrences.length) {
    lines.push(`  \u2026 ${occurrences.length - rows2.length} more (--limit 0 for all)`);
  }
  if (profiles !== null) {
    lines.push("");
    lines.push(...profileSection(profiles, limit));
  }
  return joinLines(lines);
}
function taskRunId(row) {
  return row.runId === null ? row.taskId : `${row.taskId}.${row.runId}`;
}
function profileSection(profiles, limit) {
  const linked = profiles.map((row) => ({ ...row, profiles: row.profiles.filter((entry) => entry.url !== null) })).filter((row) => row.profiles.length > 0);
  if (linked.length === 0) {
    return [
      "Profiles",
      ...profiles.length === 0 ? [
        "  (none: no occurrence\u2019s log named an uploaded profile \u2014 the harness only captures one for certain failures)"
      ] : [
        `  (none reachable: ${count(profiles.length)} occurrences named a profile, but no artifact URL could be built for any of them \u2014 the run index did not resolve, or Treeherder holds no task for the job)`
      ]
    ];
  }
  const shown = applyLimit(linked, limit ?? DRILLDOWN_ROWS);
  const lines = ["Profiles (raw artifact URLs, for profiler-cli)"];
  for (const row of shown) {
    lines.push(`  ${row.run}  ${row.configuration}`);
    for (const profile of row.profiles) {
      lines.push(`    ${profile.isRerun ? "rerun:  " : "profile:"} ${profile.url}`);
    }
  }
  if (shown.length < linked.length) {
    lines.push(`  \u2026 ${linked.length - shown.length} more (--limit 0 for all)`);
  }
  if (shown.some((row) => row.profiles.some((profile) => profile.isRerun))) {
    lines.push(
      "  (a rerun\u2019s first-run profile is uploaded too, but Treeherder keeps only the retry\u2019s log messages, so it is not named here)"
    );
  }
  return lines;
}
function historySection(history) {
  const width = Math.max(3, ...history.map((row) => count(row.count).length));
  return [
    "History (annotations per day)",
    ...history.map(
      (row) => `  ${dateWithWeekday(row.date).padEnd(16)}  ${count(row.count).padStart(width)}`
    ),
    ""
  ];
}
function tallySection(title, counts, limit, maxWidth) {
  if (counts.length === 0) {
    return [];
  }
  const shown = applyLimit(counts, limit ?? DRILLDOWN_ROWS);
  const prefixWidth = 10;
  const lines = [
    title,
    ...shown.map((entry) => {
      const budgeted = maxWidth === void 0 ? entry.name : truncate(entry.name, maxWidth);
      return `  ${String(entry.count).padStart(5)}x  ${fitLine(budgeted, prefixWidth)}`;
    })
  ];
  if (shown.length < counts.length) {
    lines.push(`  \u2026 ${counts.length - shown.length} more (--limit 0 for all)`);
  }
  lines.push("");
  return lines;
}
function renderBugMarkdown(drilldown, bugSummary, tree, range, occurrences, profiles, history) {
  const lines = [
    // The heading is the bug alone and the summary a keyed line under it,
    // matching the text renderer's two lines. A 255-character Bugzilla
    // summary inside an `#` heading is unreadable pasted into a bug, and
    // running the label into the value is the thing `headlineLines`
    // exists to avoid.
    heading(`Bug #: ${drilldown.bugId}`),
    "",
    `Summary: ${bugSummary ?? "(no summary from Bugzilla)"}`,
    "",
    `${drilldownCountLine(drilldown, tree, range)}.`,
    "",
    ...table2(
      [
        { header: "count", align: "right" },
        { header: "job name" },
        { header: "platform" },
        { header: "build type" }
      ],
      // The three axes side by side rather than as three tables: pasted
      // into a bug this is one block to read.
      zipTallies(drilldown.jobNames, drilldown.platforms, drilldown.buildTypes)
    ),
    ""
  ];
  if (drilldown.lines.length > 0) {
    lines.push(heading("Failure messages, per annotated job", 2));
    lines.push("");
    for (const entry of drilldown.lines) {
      lines.push(`- ${entry.count}x ${code(entry.name)}`);
    }
    lines.push("");
  }
  if (history !== null) {
    lines.push(heading("History (annotations per day)", 2));
    lines.push("");
    lines.push(
      ...table2(
        [{ header: "day" }, { header: "annotations", align: "right" }],
        history.map((row) => [dateWithWeekday(row.date), count(row.count)])
      )
    );
    lines.push("");
  }
  lines.push(heading("Task IDs", 2));
  lines.push("");
  for (const row of occurrences) {
    lines.push(`- \`${taskRunId(row)}\` \u2014 ${row.platform}/${row.buildType} ${row.testSuite}`);
  }
  const linkedProfiles = (profiles ?? []).map((row) => ({ ...row, profiles: row.profiles.filter((entry) => entry.url !== null) })).filter((row) => row.profiles.length > 0);
  if (profiles !== null && linkedProfiles.length > 0) {
    lines.push("");
    lines.push(heading("Profiles", 2));
    lines.push("");
    for (const row of linkedProfiles) {
      lines.push(`- \`${row.run}\` \u2014 ${row.configuration}`);
      for (const profile of row.profiles) {
        lines.push(`  - ${profile.isRerun ? "rerun" : "profile"}: ${profile.url}`);
      }
    }
  }
  return joinLines(lines);
}
function zipTallies(suites, platforms, buildTypes) {
  const rows2 = [];
  const height = Math.max(suites.length, platforms.length, buildTypes.length);
  for (let i = 0; i < height; i++) {
    rows2.push([
      suites[i] === void 0 ? "" : String(suites[i].count),
      suites[i]?.name ?? "",
      platforms[i] === void 0 ? "" : `${platforms[i].count}x ${platforms[i].name}`,
      buildTypes[i] === void 0 ? "" : `${buildTypes[i].count}x ${buildTypes[i].name}`
    ]);
  }
  return rows2;
}

// lib/formats/manifests.ts
function decodeManifests(file) {
  const { runs, tasks, metadata } = file;
  const runCount = runs.manifestIds.length;
  if (runs.jobNameIds.length !== runCount || runs.taskIds.length !== runCount || runs.durations.length !== runCount) {
    throw new Error(
      `runs arrays are not parallel: manifestIds ${runCount}, jobNameIds ${runs.jobNameIds.length}, taskIds ${runs.taskIds.length}, durations ${runs.durations.length}`
    );
  }
  const at2 = (table3, index, name) => {
    const value = table3[index];
    if (value === void 0) {
      throw new Error(`index ${index} out of range for ${name} (length ${table3.length})`);
    }
    return value;
  };
  return {
    date: metadata.date,
    repository: metadata.repository,
    generatedAt: metadata.generatedAt,
    processedJobCount: metadata.processedJobCount,
    failedJobCount: metadata.failedJobCount,
    runCount,
    manifestCount: file.manifests.length,
    manifestAt(manifestId) {
      return at2(file.manifests, manifestId, "manifests");
    },
    *runs() {
      for (let i = 0; i < runCount; i++) {
        const manifestId = runs.manifestIds[i];
        const taskIndex = runs.taskIds[i];
        const taskJobNameId = tasks.jobName[taskIndex];
        if (taskJobNameId === void 0) {
          throw new Error(
            `runs.taskIds[${i}] = ${taskIndex} is out of range for tasks (length ${tasks.jobName.length})`
          );
        }
        yield {
          runIndex: i,
          manifestId,
          manifest: at2(file.manifests, manifestId, "manifests"),
          configuration: at2(file.jobNames, runs.jobNameIds[i], "jobNames"),
          jobName: at2(file.jobNames, taskJobNameId, "jobNames"),
          taskId: at2(tasks.id, taskIndex, "tasks.id"),
          prefix: at2(file.prefixes, tasks.prefix[taskIndex], "prefixes"),
          duration: runs.durations[i]
        };
      }
    }
  };
}

// lib/query/manifest-stats.ts
function computeManifestStats(file, options = {}) {
  const needle = options.manifest?.toLowerCase();
  const platforms = options.platforms === void 0 ? null : new Set(options.platforms);
  const byManifest = /* @__PURE__ */ new Map();
  for (const run2 of file.runs()) {
    if (needle !== void 0 && !run2.manifest.toLowerCase().includes(needle)) {
      continue;
    }
    const configuration = run2.configuration;
    if (options.jobFilter !== void 0 && !options.jobFilter(configuration)) {
      continue;
    }
    if (platforms !== null) {
      const os = parseJobName(configuration).os;
      if (os === null || !platforms.has(os)) {
        continue;
      }
    }
    let configs = byManifest.get(run2.manifest);
    if (configs === void 0) {
      configs = /* @__PURE__ */ new Map();
      byManifest.set(run2.manifest, configs);
    }
    const durations = configs.get(configuration);
    if (durations === void 0) {
      configs.set(configuration, [run2.duration]);
    } else {
      durations.push(run2.duration);
    }
  }
  const out = [];
  for (const [manifest, configs] of byManifest) {
    const configStats = [];
    const skippedOn = [];
    const pooled = [];
    for (const [configuration, durations] of configs) {
      const skipped = durations.every((duration2) => duration2 === 0);
      if (skipped) {
        skippedOn.push(configuration);
        configStats.push({
          configuration,
          os: parseJobName(configuration).os,
          runCount: durations.length,
          skipped: true,
          // Not zeros. A skipped config has no runtime to report, and
          // zeros would make it the fastest row in the table.
          durations: null
        });
        continue;
      }
      pooled.push(...durations);
      configStats.push({
        configuration,
        os: parseJobName(configuration).os,
        runCount: durations.length,
        skipped: false,
        durations: summarize2(durations)
      });
    }
    const ran = configStats.filter((config) => !config.skipped);
    configStats.sort(compareConfigs);
    skippedOn.sort();
    const platformCounts = /* @__PURE__ */ new Map();
    for (const config of ran) {
      const key = config.os ?? "(unparsed)";
      platformCounts.set(key, (platformCounts.get(key) ?? 0) + 1);
    }
    const stats = {
      manifest,
      configs: configStats,
      skippedOn,
      runCount: ran.reduce((sum, config) => sum + config.runCount, 0),
      durations: pooled.length === 0 ? null : summarize2(pooled),
      platforms: [...platformCounts].map(([platform, configCount]) => ({ platform, configCount })).sort((a, b) => b.configCount - a.configCount || a.platform.localeCompare(b.platform))
    };
    if (options.slowerThanMs !== void 0 && (stats.durations === null || stats.durations.median < options.slowerThanMs)) {
      continue;
    }
    out.push(stats);
  }
  return out;
}
function compareConfigs(a, b) {
  const aMedian = a.durations?.median ?? -1;
  const bMedian = b.durations?.median ?? -1;
  return bMedian - aMedian || a.configuration.localeCompare(b.configuration);
}
function sortManifests(rows2, by) {
  const sorted = [...rows2];
  if (by === "name") {
    sorted.sort((a, b) => a.manifest.localeCompare(b.manifest));
    return sorted;
  }
  if (by === "runs") {
    sorted.sort((a, b) => b.runCount - a.runCount || a.manifest.localeCompare(b.manifest));
    return sorted;
  }
  const value = (row) => {
    if (row.durations === null) {
      return -1;
    }
    return by === "median" ? row.durations.median : by === "p95" ? row.durations.p95 : by === "max" ? row.durations.max : row.durations.total;
  };
  sorted.sort((a, b) => value(b) - value(a) || a.manifest.localeCompare(b.manifest));
  return sorted;
}
function summarize2(durations) {
  if (durations.length === 0) {
    throw new Error("cannot summarize an empty duration list");
  }
  const sorted = [...durations].sort((a, b) => a - b);
  let total = 0;
  for (const duration2 of sorted) {
    total += duration2;
  }
  return {
    runCount: sorted.length,
    min: sorted[0],
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    total
  };
}
function quantile(sorted, q) {
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
function zeroDurationCensus(file) {
  let zeroRuns = 0;
  let totalRuns2 = 0;
  const pairs = /* @__PURE__ */ new Map();
  for (const run2 of file.runs()) {
    totalRuns2 += 1;
    if (run2.duration === 0) {
      zeroRuns += 1;
    }
    const key = `${run2.manifestId}\0${run2.configuration}`;
    const allZeroSoFar = pairs.get(key);
    pairs.set(key, (allZeroSoFar ?? true) && run2.duration === 0);
  }
  let skippedPairs = 0;
  for (const allZero of pairs.values()) {
    if (allZero) {
      skippedPairs += 1;
    }
  }
  return { zeroRuns, totalRuns: totalRuns2, skippedPairs, totalPairs: pairs.size };
}
function configurationFilter(include, exclude) {
  return (configuration) => {
    if (include.length > 0 && !include.some((needle) => configuration.includes(needle))) {
      return false;
    }
    return !exclude.some((needle) => configuration.includes(needle));
  };
}

// lib/model/duration.ts
function formatDurationPadded(ms) {
  if (ms === null || ms === void 0) {
    return "\u2014";
  }
  if (ms < 1e3) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 6e4) {
    return `${(ms / 1e3).toFixed(1)}s`;
  }
  const total = Math.round(ms / 1e3);
  if (total < 3600) {
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
  }
  const minutes = Math.floor(total / 60) % 60;
  return `${Math.floor(total / 3600)}h ${String(minutes).padStart(2, "0")}m`;
}

// cli/commands/manifests.ts
var MANIFESTS_OPTIONS = {
  job: {
    type: "list",
    placeholder: "<list>",
    describe: "Comma-separated job-name substrings. Same as --config."
  },
  platform: {
    type: "list",
    placeholder: "<list>",
    describe: "Comma-separated platforms: linux, windows, mac, android."
  },
  sort: {
    type: "string",
    placeholder: "<median|p95|max|runs|total|name>",
    describe: "How to rank manifests. Default median."
  },
  "slower-than": {
    type: "string",
    placeholder: "<duration>",
    describe: "Only manifests with a median above this, e.g. 30s, 5m, 500ms."
  }
};
var DEFAULT_LIMIT5 = 10;
async function runManifests(context, args) {
  if (args.positionals.length > 1) {
    throw usageError(
      `manifests takes at most one manifest name, got ${args.positionals.length}: ` + args.positionals.join(", ")
    );
  }
  const wanted = args.positionals[0];
  const sort = readSort4(args);
  const slowerThanMs = readDuration(stringOption(args, "slower-than"));
  progress(context, "Reading manifests.json\u2026");
  const raw = await fetchJson(context.source, {
    index: MANIFEST_TIMINGS_INDEX,
    filename: "manifests.json"
  });
  const file = decodeManifests(raw);
  const include = [...listOption(args, "job"), ...context.globals.config];
  const platforms = listOption(args, "platform");
  const jobFilter = include.length > 0 || context.globals.excludeConfig.length > 0 ? configurationFilter(include, context.globals.excludeConfig) : void 0;
  const stats = computeManifestStats(file, {
    ...wanted === void 0 ? {} : { manifest: wanted },
    ...jobFilter === void 0 ? {} : { jobFilter },
    ...platforms.length === 0 ? {} : { platforms },
    ...slowerThanMs === void 0 ? {} : { slowerThanMs }
  });
  if (wanted !== void 0 && stats.length === 0) {
    throw notFoundError(
      `no manifest matching "${wanted}" in manifests.json for ${file.date}`,
      "The name is matched as a substring. Run `fx-tests manifests` with no argument to see the slowest manifests, or widen the filters."
    );
  }
  const sorted = sortManifests(stats, sort);
  const limit = context.globals.limit ?? DEFAULT_LIMIT5;
  const shown = wanted === void 0 ? applyLimit(sorted, limit) : sorted;
  const result = {
    manifest: wanted ?? null,
    metadata: {
      date: file.date,
      weekday: weekdayOfDate(file.date),
      repository: file.repository,
      generatedAt: file.generatedAt,
      processedJobCount: file.processedJobCount,
      failedJobCount: file.failedJobCount,
      dataSource: context.source.name
    },
    zeroDurations: zeroDurationCensus(file),
    sort,
    rowCount: sorted.length,
    rows: shown.map(toRowJson2)
  };
  if (context.globals.format === "json") {
    emit(context, toJson(result));
    return;
  }
  emit(
    context,
    context.globals.format === "markdown" ? renderMarkdown5(result) : renderText5(result)
  );
}
function readSort4(args) {
  const value = stringOption(args, "sort") ?? "median";
  const allowed = ["median", "p95", "max", "runs", "total", "name"];
  if (!allowed.includes(value)) {
    throw usageError(`--sort expects one of ${allowed.join(", ")}, got "${value}"`);
  }
  return value;
}
function readDuration(value) {
  if (value === void 0) {
    return void 0;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
  if (match === null) {
    throw usageError(
      `--slower-than expects a duration like 500ms, 30s, 5m or 1h, got "${value}"`
    );
  }
  const amount = Number(match[1]);
  switch (match[2]) {
    case "ms":
      return amount;
    case "m":
      return amount * 6e4;
    case "h":
      return amount * 36e5;
    // A bare number is seconds — see the doc comment.
    case "s":
    case void 0:
    default:
      return amount * 1e3;
  }
}
function weekdayOfDate(date) {
  const match = /\(([A-Za-z]+)\)$/.exec(dateWithWeekday(date));
  return match?.[1] ?? null;
}
function toRowJson2(row) {
  return {
    manifest: row.manifest,
    runCount: row.runCount,
    durations: row.durations,
    platforms: row.platforms,
    skippedOn: row.skippedOn,
    configs: row.configs.map((config) => ({
      configuration: config.configuration,
      runCount: config.runCount,
      skipped: config.skipped,
      durations: config.durations
    }))
  };
}
function renderText5(result) {
  const lines = [];
  lines.push(...headerLines4(result));
  lines.push("");
  if (result.rows.length === 0) {
    lines.push("No manifest matched.");
    lines.push("");
    lines.push(...footerLines2());
    return joinLines(lines);
  }
  if (result.manifest !== null && result.rows.length === 1) {
    lines.push(...renderOneManifest(result.rows[0]));
    lines.push("");
    lines.push(...footerLines2());
    return joinLines(lines);
  }
  const sortColumn = result.sort === "name" ? "Manifest" : result.sort;
  const column = (header, rest = {}) => ({
    header,
    ...rest,
    ...header === sortColumn ? { sort: result.sort === "name" ? "asc" : "desc" } : {}
  });
  lines.push(
    ...tableSection(
      [
        // A manifest is a path too, and `fx-tests manifests <path>`
        // takes it, so it gets the same auto-sized path column.
        column("Manifest", { path: true }),
        column("runs", { align: "right" }),
        column("median", { align: "right" }),
        column("p95", { align: "right" }),
        column("max", { align: "right" }),
        column("total", { align: "right" })
      ],
      result.rows.map((row) => [
        row.manifest,
        count(row.runCount),
        duration(row.durations?.median),
        duration(row.durations?.p95),
        duration(row.durations?.max),
        duration(row.durations?.total)
      ]),
      { total: result.rowCount, shown: result.rows.length }
    )
  );
  const skippedEverywhere = result.rows.filter((row) => row.durations === null);
  if (skippedEverywhere.length > 0) {
    lines.push("");
    lines.push(
      `  ${skippedEverywhere.length} of these ran on no configuration at all (every duration zero), so they have no runtime \u2014 not a runtime of zero.`
    );
  }
  lines.push("");
  lines.push(...footerLines2());
  return joinLines(lines);
}
function renderOneManifest(row) {
  const lines = [];
  lines.push(row.manifest);
  const ran = row.configs.filter((config) => !config.skipped);
  if (ran.length === 0) {
    lines.push(
      "  Skipped on every configuration it appears on: every duration recorded was zero,"
    );
    lines.push("  which means it did not run there rather than that it ran instantly.");
  } else {
    lines.push(
      `  Runs on ${ran.length} configuration${ran.length === 1 ? "" : "s"}` + (row.platforms.length === 0 ? "" : `, ${row.platforms.length} platform${row.platforms.length === 1 ? "" : "s"}: ` + row.platforms.map((entry) => `${entry.platform} (${entry.configCount})`).join(", "))
    );
  }
  if (row.skippedOn.length > 0) {
    lines.push(
      `  Skipped on ${row.skippedOn.length} configuration${row.skippedOn.length === 1 ? "" : "s"} (all durations zero): ` + truncate(row.skippedOn.slice(0, 4).join(", "), 100) + (row.skippedOn.length > 4 ? `, and ${row.skippedOn.length - 4} more` : "")
    );
  }
  if (ran.length > 0) {
    lines.push("");
    lines.push(
      ...tableSection(
        [
          // A configuration name is what `--config` takes, so it is
          // an identifier to copy rather than prose: same auto-sized
          // treatment as a path, and it is slash-separated too. A
          // tail cut here produced
          // `…/debug-mochitest-devtools-chr…`, which names nothing.
          { header: "Configuration", path: true },
          { header: "runs", align: "right" },
          // Ordered by median duration, as the ranking above is.
          { header: "median", align: "right", sort: "desc" },
          { header: "p95", align: "right" },
          { header: "max", align: "right" }
        ],
        ran.map((config) => [
          config.configuration,
          count(config.runCount),
          duration(config.durations?.median),
          duration(config.durations?.p95),
          duration(config.durations?.max)
        ]),
        { total: ran.length, shown: ran.length }
      )
    );
  }
  return lines.filter((line) => line !== null);
}
function headerLines4(result) {
  const { metadata, zeroDurations } = result;
  const lines = [];
  lines.push(
    `manifests, ${dateWithWeekday(metadata.date)} \u2014 ${metadata.repository}, ${count(metadata.processedJobCount)} jobs (${count(metadata.failedJobCount)} failed)`
  );
  const pct = zeroDurations.totalRuns === 0 ? 0 : zeroDurations.zeroRuns / zeroDurations.totalRuns * 100;
  lines.push(
    `  ${count(zeroDurations.zeroRuns)} of ${count(zeroDurations.totalRuns)} runs (${pct.toFixed(1)}%) recorded a zero duration. A manifest whose durations are all`
  );
  lines.push(
    `  zero on a config was skipped there, not run instantly \u2014 ${count(zeroDurations.skippedPairs)} of ${count(zeroDurations.totalPairs)} (manifest, config) pairs.`
  );
  return lines;
}
function footerLines2() {
  return [
    "This file has per-manifest durations, not per-test ones, so it narrows a job timeout",
    "to a manifest and a config but cannot say whether that is one slow test or a thousand",
    "cheap ones. Use `fx-tests test <path> --durations` on the tests in the manifest for that."
  ];
}
var duration = formatDurationPadded;
function renderMarkdown5(result) {
  const lines = [];
  lines.push(heading(`Manifest timings \u2014 ${dateWithWeekday(result.metadata.date)}`, 1));
  lines.push("");
  for (const line of headerLines4(result).slice(1)) {
    lines.push(line.trim());
  }
  lines.push("");
  if (result.rows.length === 0) {
    lines.push("No manifest matched.");
    return joinLines(lines);
  }
  if (result.manifest !== null && result.rows.length === 1) {
    const row = result.rows[0];
    lines.push(heading(row.manifest));
    lines.push("");
    const ran = row.configs.filter((config) => !config.skipped);
    lines.push(
      ...table2(
        [
          { header: "Configuration" },
          { header: "runs", align: "right" },
          { header: "median", align: "right" },
          { header: "p95", align: "right" },
          { header: "max", align: "right" }
        ],
        ran.map((config) => [
          config.configuration,
          count(config.runCount),
          duration(config.durations?.median),
          duration(config.durations?.p95),
          duration(config.durations?.max)
        ])
      )
    );
    if (row.skippedOn.length > 0) {
      lines.push("");
      lines.push(
        `**Skipped on ${row.skippedOn.length} configurations** (all durations zero): ` + row.skippedOn.join(", ")
      );
    }
  } else {
    lines.push(
      ...table2(
        [
          { header: "Manifest" },
          { header: "runs", align: "right" },
          { header: "median", align: "right" },
          { header: "p95", align: "right" },
          { header: "max", align: "right" }
        ],
        result.rows.map((row) => [
          row.manifest,
          count(row.runCount),
          duration(row.durations?.median),
          duration(row.durations?.p95),
          duration(row.durations?.max)
        ])
      )
    );
    lines.push(moreLine2(result.rowCount, result.rows.length));
  }
  lines.push("");
  lines.push(...footerLines2());
  return joinLines(lines);
}

// lib/formats/stats.ts
function statsRows(file) {
  const count2 = file.dates.length;
  const series = {
    totalTestRuns: file.totalTestRuns,
    failedTestRuns: file.failedTestRuns,
    skippedTestRuns: file.skippedTestRuns,
    processedJobCount: file.processedJobCount,
    failedJobs: file.failedJobs,
    ignoredJobs: file.ignoredJobs,
    invalidJobs: file.invalidJobs,
    ...file.markerCounts
  };
  const misaligned = Object.entries(series).filter(([, values]) => values.length !== count2);
  if (misaligned.length > 0) {
    throw new Error(
      `stats series are misaligned: ${count2} dates but ` + misaligned.map(([key, values]) => `${key}=${values.length}`).join(", ")
    );
  }
  const kinds = Object.keys(file.markerCounts);
  return file.dates.map((date, i) => ({
    date,
    totalTestRuns: file.totalTestRuns[i],
    failedTestRuns: file.failedTestRuns[i],
    skippedTestRuns: file.skippedTestRuns[i],
    processedJobCount: file.processedJobCount[i],
    failedJobs: file.failedJobs[i],
    ignoredJobs: file.ignoredJobs[i],
    invalidJobs: file.invalidJobs[i],
    markerCounts: Object.fromEntries(kinds.map((kind) => [kind, file.markerCounts[kind][i]]))
  }));
}

// lib/query/summary.ts
var DEFAULT_SUMMARY_DAYS = 7;
function computeSummary(file, options = {}) {
  const days = options.days ?? DEFAULT_SUMMARY_DAYS;
  if (days < 1) {
    throw new Error(`summary period must be at least one day, got ${days}`);
  }
  const rows2 = statsRows(file);
  if (rows2.length === 0) {
    throw new Error("stats file covers no dates");
  }
  let end = rows2.length - 1;
  if (options.endDate !== void 0) {
    end = rows2.findIndex((row) => row.date === options.endDate);
    if (end === -1) {
      throw new Error(
        `stats file has no date ${options.endDate} (covers ${rows2[0].date} \u2026 ${rows2[rows2.length - 1].date})`
      );
    }
  }
  const currentStart = Math.max(0, end - days + 1);
  const current = summarizeRows(rows2.slice(currentStart, end + 1));
  const priorEnd = currentStart - 1;
  const priorStart = priorEnd - days + 1;
  const prior = priorStart >= 0 && priorEnd >= priorStart ? summarizeRows(rows2.slice(priorStart, priorEnd + 1)) : null;
  return {
    harness: file.metadata.harness,
    current,
    prior,
    delta: {
      testFailureRate: difference(current.testFailureRate, prior?.testFailureRate),
      jobFailureRate: difference(current.jobFailureRate, prior?.jobFailureRate),
      skipRate: difference(current.skipRate, prior?.skipRate),
      invalidJobRate: difference(current.invalidJobRate, prior?.invalidJobRate)
    }
  };
}
function summarizeRows(rows2) {
  const period = {
    startDate: rows2[0]?.date ?? "",
    endDate: rows2[rows2.length - 1]?.date ?? "",
    dayCount: rows2.length,
    totalTestRuns: 0,
    failedTestRuns: 0,
    skippedTestRuns: 0,
    processedJobCount: 0,
    failedJobs: 0,
    invalidJobs: 0,
    testFailureRate: null,
    jobFailureRate: null,
    skipRate: null,
    invalidJobRate: null
  };
  for (const row of rows2) {
    period.totalTestRuns += row.totalTestRuns;
    period.failedTestRuns += row.failedTestRuns;
    period.skippedTestRuns += row.skippedTestRuns;
    period.processedJobCount += row.processedJobCount;
    period.failedJobs += row.failedJobs;
    period.invalidJobs += row.invalidJobs;
  }
  period.testFailureRate = rate(period.failedTestRuns, period.totalTestRuns);
  period.jobFailureRate = rate(
    period.failedJobs,
    period.processedJobCount + period.invalidJobs
  );
  period.skipRate = rate(period.skippedTestRuns, period.totalTestRuns);
  period.invalidJobRate = rate(period.invalidJobs, period.processedJobCount);
  return period;
}
function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator * 100 : null;
}
function difference(current, prior) {
  return current === null || prior === null || prior === void 0 ? null : current - prior;
}

// cli/commands/summary.ts
var SUMMARY_OPTIONS = {
  days: {
    type: "number",
    placeholder: "<n>",
    describe: "Period length in days. Default 7; a multiple of 7 is strongly preferred."
  }
};
async function runSummary(context, args) {
  const days = numberOption(args, "days");
  if (days !== void 0 && days < 1) {
    throw usageError(`--days expects at least 1, got ${days}`);
  }
  if (args.positionals.length > 0) {
    throw usageError(`summary takes no arguments, got "${args.positionals[0]}"`);
  }
  if (context.globals.config.length > 0 || context.globals.excludeConfig.length > 0) {
    throw usageError(
      "--config cannot be applied to summary: it reads pre-aggregated tree-wide totals from {harness}-stats.json, which records no job names",
      "Use `fx-tests test <path> --config` for one test, which reads a bucket file."
    );
  }
  const harnesses = context.globals.harness !== void 0 ? [context.globals.harness] : ["xpcshell", "mochitest"];
  const results = [];
  for (const harness of harnesses) {
    progress(context, `Reading ${harness}-stats.json\u2026`);
    const file = await fetchJson(context.source, {
      index: timingsIndex(harness),
      filename: `${harness}-stats.json`
    });
    const summary = computeSummary(file, days === void 0 ? {} : { days });
    results.push({
      harness,
      generatedAt: file.metadata.generatedAt,
      current: summary.current,
      prior: summary.prior,
      delta: summary.delta
    });
  }
  if (context.globals.format === "json") {
    emit(context, toJson({ harnesses: results }));
    return;
  }
  emit(
    context,
    context.globals.format === "markdown" ? renderMarkdown6(results) : renderText6(results)
  );
}
function rows(entry) {
  return [
    {
      label: "test failure rate",
      value: entry.current.testFailureRate,
      change: entry.delta.testFailureRate
    },
    {
      label: "job failure rate",
      value: entry.current.jobFailureRate,
      change: entry.delta.jobFailureRate
    },
    { label: "skip rate", value: entry.current.skipRate, change: entry.delta.skipRate },
    {
      label: "invalid job rate",
      value: entry.current.invalidJobRate,
      change: entry.delta.invalidJobRate
    }
  ];
}
function renderText6(results) {
  const lines = [];
  for (const entry of results) {
    const { current, prior } = entry;
    const header = `${entry.harness.padEnd(10)} (${current.dayCount}d ending ${dateWithWeekday(current.endDate)})`;
    lines.push(
      prior === null ? header : `${header}          vs prior ${prior.dayCount}d`
    );
    for (const row of rows(entry)) {
      const value = percent(row.value, 2).padEnd(10);
      lines.push(`  ${row.label.padEnd(22)}${value}${prior === null ? "" : `    ${delta(row.change)}`}`);
    }
    if (prior === null) {
      lines.push(
        `  (no prior ${current.dayCount}-day period in the file, so no comparison)`
      );
    }
    lines.push("");
  }
  return joinLines(lines);
}
function renderMarkdown6(results) {
  const lines = [];
  for (const entry of results) {
    const { current, prior } = entry;
    lines.push(
      heading(
        `${entry.harness} \u2014 ${current.dayCount}d ending ${dateWithWeekday(current.endDate)}`
      )
    );
    lines.push("");
    const columns = [
      { header: "Metric" },
      { header: "Rate", align: "right" }
    ];
    if (prior !== null) {
      columns.push({ header: `vs prior ${prior.dayCount}d`, align: "right" });
    }
    lines.push(
      ...table2(
        columns,
        rows(entry).map(
          (row) => prior === null ? [row.label, percent(row.value, 2)] : [row.label, percent(row.value, 2), delta(row.change)]
        )
      )
    );
    lines.push("");
  }
  return joinLines(lines);
}

// lib/model/execution.ts
function executionModeOf(status) {
  return splitExecutionMode(status).mode ?? "unrecorded";
}
function hasModeAxis(statuses) {
  for (const status of statuses) {
    if (splitExecutionMode(status).mode !== null) {
      return true;
    }
  }
  return false;
}
function emptyModeBreakdown() {
  return { parallel: 0, sequential: 0, unrecorded: 0 };
}
function addToModeBreakdown(breakdown, status, count2) {
  breakdown[executionModeOf(status)] += count2;
}
function countRerunsByTask(entries) {
  const perTask = /* @__PURE__ */ new Map();
  let runs = 0;
  for (const entry of entries) {
    if (entry.taskIds === void 0) {
      continue;
    }
    for (const taskId of entry.taskIds) {
      perTask.set(taskId, (perTask.get(taskId) ?? 0) + 1);
      runs += 1;
    }
  }
  let jobsWithRerun = 0;
  for (const count2 of perTask.values()) {
    if (count2 > 1) {
      jobsWithRerun += 1;
    }
  }
  return { jobs: perTask.size, runs, jobsWithRerun };
}

// lib/query/coverage.ts
function coveragePlatforms(coverage) {
  const byPlatform = /* @__PURE__ */ new Map();
  for (const config of coverage.configs) {
    const platform = operatingSystemOf(config.jobName);
    let entry = byPlatform.get(platform);
    if (entry === void 0) {
      entry = { platform, ranCount: 0, skippedCount: 0 };
      byPlatform.set(platform, entry);
    }
    if (config.runCount > 0) {
      entry.ranCount++;
    } else {
      entry.skippedCount++;
    }
  }
  return [...byPlatform.values()].sort(
    (a, b) => b.ranCount + b.skippedCount - (a.ranCount + a.skippedCount) || a.platform.localeCompare(b.platform)
  );
}
function emptyRow(jobName) {
  return {
    jobName,
    state: "ok",
    runCount: 0,
    passCount: 0,
    failCount: 0,
    timeoutCount: 0,
    crashCount: 0,
    expectedFailCount: 0,
    skipCount: 0,
    runIfSkipCount: 0,
    skipMessages: /* @__PURE__ */ new Map()
  };
}
function coverageOf(file, testId, options = {}) {
  const rows2 = /* @__PURE__ */ new Map();
  const row = (rawJobName) => {
    const jobName = stripChunkSuffix(rawJobName);
    let existing = rows2.get(jobName);
    if (existing === void 0) {
      existing = emptyRow(jobName);
      rows2.set(jobName, existing);
    }
    return existing;
  };
  for (const entry of file.runsOfTest(testId)) {
    if (!inDayRange(entry.day, options.dayRange)) {
      continue;
    }
    const { kind } = classifyStatus(entry.status);
    const targets = [];
    if (entry.jobName !== void 0) {
      targets.push({ jobName: entry.jobName, count: entry.count });
    } else if (entry.taskIdIndexes !== void 0) {
      for (const taskIdIndex of entry.taskIdIndexes) {
        const jobName = file.jobNameOfTaskIndex(taskIdIndex);
        if (jobName !== null) {
          targets.push({ jobName, count: 1 });
        }
      }
    }
    for (const target of targets) {
      if (options.jobFilter !== void 0 && !options.jobFilter(target.jobName)) {
        continue;
      }
      const r = row(target.jobName);
      switch (kind) {
        case "pass":
          r.passCount += target.count;
          break;
        case "fail":
          r.failCount += target.count;
          break;
        case "timeout":
          r.timeoutCount += target.count;
          break;
        case "crash":
          r.crashCount += target.count;
          break;
        case "expected-fail":
          r.expectedFailCount += target.count;
          break;
        case "unknown":
          break;
        case "skip": {
          if (skipReason(entry.message) === "run-if") {
            r.runIfSkipCount += target.count;
          } else {
            r.skipCount += target.count;
            if (entry.message) {
              const display = displaySkipMessage(entry.message);
              r.skipMessages.set(
                display,
                (r.skipMessages.get(display) ?? 0) + target.count
              );
            }
          }
          break;
        }
      }
    }
  }
  for (const r of rows2.values()) {
    r.runCount = r.passCount + r.failCount + r.timeoutCount + r.crashCount + r.expectedFailCount;
    r.state = stateOf(r);
  }
  const configs = [...rows2.values()].sort(
    (a, b) => b.runCount - a.runCount || a.jobName.localeCompare(b.jobName)
  );
  return {
    configs,
    attributedPasses: file.family === "bucket" || file.family === "daily"
  };
}
function stateOf(r) {
  if (r.runCount === 0) {
    if (r.skipCount === 0 && r.runIfSkipCount > 0) {
      return "not-applicable";
    }
    return "skipped";
  }
  const nonPass = r.failCount + r.timeoutCount + r.crashCount;
  if (nonPass === 0) {
    return "ok";
  }
  return nonPass === r.runCount ? "perma-fail" : "intermittent";
}
function platformsInFile(file) {
  const platforms = /* @__PURE__ */ new Set();
  const add = (jobName) => {
    const os = operatingSystemOf(stripChunkSuffix(jobName));
    if (os !== "unknown") {
      platforms.add(os);
    }
  };
  for (let testId = 0; testId < file.testCount; testId++) {
    for (const entry of file.runsOfTest(testId)) {
      if (entry.jobName !== void 0) {
        add(entry.jobName);
      } else if (entry.taskIdIndexes !== void 0) {
        for (const taskIdIndex of entry.taskIdIndexes) {
          const jobName = file.jobNameOfTaskIndex(taskIdIndex);
          if (jobName !== null) {
            add(jobName);
          }
        }
      }
    }
  }
  return platforms;
}
function platformsCovered(coverage) {
  const byOs = /* @__PURE__ */ new Map();
  for (const config of coverage.configs) {
    if (config.runCount === 0) {
      continue;
    }
    const os = operatingSystemOf(config.jobName);
    byOs.set(os, (byOs.get(os) ?? 0) + 1);
  }
  return byOs;
}
function operatingSystemOf(jobName) {
  const slash = jobName.indexOf("/");
  const platform = slash === -1 ? jobName : jobName.slice(0, slash);
  if (platform.includes("android")) return "android";
  if (platform.includes("linux")) return "linux";
  if (platform.includes("win")) return "windows";
  if (platform.includes("macos") || platform.includes("osx")) return "mac";
  return "unknown";
}

// lib/query/test-issues.ts
var FAILURE_NO_MESSAGE = "Failure details not recorded (likely Android or platform logging issue)";
var CRASH_NO_SIGNATURE = "Crash signature not recorded";
var TIMEOUT_MESSAGE = "Test exceeded time limit";
function buildTestIssues(file, testId, stats, options = {}) {
  const issues = [];
  for (const [message, count2] of sortedByCountDesc(skipCountsByMessage(file, testId, options))) {
    issues.push({ count: count2, type: "SKIP", message });
  }
  let namedFailures = 0;
  for (const [message, count2] of sortedByCountDesc(
    failureCountsByMessage(file, testId, options)
  )) {
    issues.push({ count: count2, type: "FAIL", message });
    namedFailures += count2;
  }
  if (stats.failCount > namedFailures) {
    issues.push({
      count: stats.failCount - namedFailures,
      type: "FAIL",
      message: FAILURE_NO_MESSAGE
    });
  }
  let namedCrashes = 0;
  for (const [signature, count2] of sortedByCountDesc(
    crashCountsBySignature(file, testId, options)
  )) {
    issues.push({ count: count2, type: "CRASH", message: signature });
    namedCrashes += count2;
  }
  if (stats.crashCount > namedCrashes) {
    issues.push({
      count: stats.crashCount - namedCrashes,
      type: "CRASH",
      message: CRASH_NO_SIGNATURE
    });
  }
  if (stats.timeoutCount > 0) {
    issues.push({ count: stats.timeoutCount, type: "TIMEOUT", message: TIMEOUT_MESSAGE });
  }
  issues.sort((a, b) => b.count - a.count);
  return issues;
}
function sortedByCountDesc(counts) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
function included(file, entry, options) {
  if (!inDayRange(entry.day, options.dayRange)) {
    return false;
  }
  if (options.jobFilter === void 0) {
    return true;
  }
  const jobName = jobNameOfEntry(file, entry);
  return jobName === null ? false : options.jobFilter(jobName);
}
function skipCountsByMessage(file, testId, options) {
  const counts = /* @__PURE__ */ new Map();
  for (const entry of file.runsOfTest(testId)) {
    if (classifyStatus(entry.status).kind !== "skip") {
      continue;
    }
    if (!included(file, entry, options)) {
      continue;
    }
    if (entry.message === void 0 || entry.message === null) {
      continue;
    }
    if (skipReason(entry.message) === "run-if") {
      continue;
    }
    const message = displaySkipMessage(entry.message);
    counts.set(message, (counts.get(message) ?? 0) + entry.count);
  }
  return counts;
}
function failureCountsByMessage(file, testId, options) {
  const counts = /* @__PURE__ */ new Map();
  for (const entry of file.runsOfTest(testId)) {
    if (classifyStatus(entry.status).kind !== "fail") {
      continue;
    }
    if (!included(file, entry, options)) {
      continue;
    }
    if (entry.message === void 0 || entry.message === null) {
      continue;
    }
    counts.set(entry.message, (counts.get(entry.message) ?? 0) + entry.count);
  }
  return counts;
}
function crashCountsBySignature(file, testId, options) {
  const counts = /* @__PURE__ */ new Map();
  for (const entry of file.runsOfTest(testId)) {
    if (classifyStatus(entry.status).kind !== "crash") {
      continue;
    }
    if (!included(file, entry, options)) {
      continue;
    }
    if (entry.crashSignature === void 0 || entry.crashSignature === null) {
      continue;
    }
    counts.set(entry.crashSignature, (counts.get(entry.crashSignature) ?? 0) + entry.count);
  }
  return counts;
}

// cli/commands/test.ts
var TEST_OPTIONS = {
  coverage: {
    type: "boolean",
    describe: "Every config the test ran on, passing ones included."
  },
  executions: {
    type: "boolean",
    describe: "Break failures down by rerun and by execution mode."
  },
  "recent-days": {
    type: "number",
    placeholder: "<n>",
    describe: "Override the automatically-sized recent window."
  },
  "task-ids": {
    type: "boolean",
    describe: "Print the task IDs behind each failure, and the minidump IDs of any crashes."
  },
  profiles: {
    type: "boolean",
    describe: "Print raw profile artifact URLs for each failure."
  },
  durations: {
    type: "boolean",
    describe: "Per-config run-time distribution from the pass durations."
  },
  history: { type: "boolean", describe: "A per-day sparkline of pass/fail counts." }
};
var DEFAULT_LIMIT6 = 10;
async function lookUpTest(context, testPath) {
  if (context.loadTimingFile !== void 0) {
    const { harness } = resolveHarness(testPath, context.globals.harness);
    const loaded = await context.loadTimingFile(harness, testPath);
    const identity = loaded.decoded.findTest(testPath);
    if (identity === null) {
      throw notFoundError(
        `the injected ${harness} file does not hold ${testPath}`,
        "This is the test-only loadTimingFile seam; production walks the resolution ladder."
      );
    }
    return { harness, decoded: loaded.decoded, file: loaded.raw, identity };
  }
  const loaders = testLookupLoaders(context);
  progress(context, `Looking up ${testPath}\u2026`);
  const resolution = await resolveTest(testPath, context.globals.harness, loaders);
  if (resolution.kind === "found") {
    if (resolution.resolvedFrom !== null) {
      notice(
        context,
        `Resolved "${resolution.resolvedFrom}" to the one test matching it: ${resolution.testPath}`
      );
    }
    if (resolution.viaOtherHarness) {
      notice(
        context,
        `Found in ${resolution.harness} data, not the ${otherHarness(resolution.harness)} the filename suggests.`
      );
    }
    return {
      harness: resolution.harness,
      decoded: resolution.file.decoded,
      file: resolution.file.raw,
      identity: resolution.identity
    };
  }
  if (resolution.kind === "not-in-file") {
    throw notFoundError(
      `${resolution.testPath} is a test in the tree-wide data, but it is not in the ${resolution.searched.join(" or ")} file that should describe it` + (loaders.missingFiles.length === 0 ? "." : ` (${loaders.missingFiles.join(", ")} not published).`),
      context.globals.harness === void 0 ? "The two families are published separately, so this is usually a window they disagree on. Retry later." : `Drop --harness ${context.globals.harness}: the test may not run under it.`
    );
  }
  if (resolution.kind === "ambiguous") {
    const shown = applyLimit(resolution.candidates, context.globals.limit ?? DEFAULT_LIMIT6);
    const hidden = resolution.total - shown.length;
    throw notFoundError(
      `"${resolution.query}" is not a test path, and ${resolution.total} tests match it. Nothing was measured; pick one:
` + shown.map((candidate) => `  ${candidate}`).join("\n") + (hidden === 0 ? "" : `
  \u2026 and ${hidden} more not shown` + (resolution.truncated ? ` (${CANDIDATE_LIMIT} candidates is the most this message collects; narrow the fragment to see the rest)` : " (--limit 0 for all)")),
      "Add more of the path to narrow it \u2014 every space-separated word has to appear somewhere in it."
    );
  }
  const searched = resolution.searched.join(" and ");
  if (resolution.allTests === null) {
    throw notFoundError(
      `Not in the ${searched} bucket files for this path` + (loaders.missingFiles.length === 0 ? "" : ` (${loaders.missingFiles.join(", ")} not published)`) + `, and the test list could not be read, so no search was made: ${resolution.query}`,
      "This says nothing about the test \u2014 retry to search the full test list, or pass the path exactly as it appears in the tree."
    );
  }
  throw notFoundError(
    `No test path in the ${searched} 21-day data contains "${resolution.query}", so this reports nothing about the test itself.`,
    "It may have been renamed, added after the window started, or never run in CI. Check the spelling, or pass a longer fragment of the path."
  );
}
async function runTest(context, args) {
  const testPath = args.positionals[0];
  if (testPath === void 0) {
    throw usageError(
      "test requires a path",
      "Usage: fx-tests test <path>, e.g. fx-tests test netwerk/test/unit/test_bug1195415.js"
    );
  }
  if (args.positionals.length > 1) {
    throw usageError(
      `test takes one path, got ${args.positionals.length}: ${args.positionals.join(", ")}`
    );
  }
  const { harness, decoded, file, identity } = await lookUpTest(context, testPath);
  const window = resolveDayWindow(context.globals, decoded);
  const jobFilter = configFilter(context.globals.config, context.globals.excludeConfig);
  const hasConfigFilter = context.globals.config.length > 0 || context.globals.excludeConfig.length > 0;
  if (hasConfigFilter && !canAttributeConfigs(decoded)) {
    throw usageError(
      `--config cannot be applied to this ${harness} file: it records no job names, so every configuration filter over it matches nothing`,
      "This is a property of the file, not of the test. The 64-bucket files that back --config are what `--data-source central` serves by default."
    );
  }
  const statsOptions = {
    ...window.range === null ? {} : { dayRange: window.range },
    ...hasConfigFilter ? { jobFilter } : {}
  };
  const totals = computeTestStats(decoded, identity.testId, statsOptions);
  const recentDays = numberOption(args, "recent-days");
  const configs = computeConfigStats(decoded, identity.testId, {
    ...window.range === null ? {} : { dayRange: window.range },
    ...recentDays === void 0 ? {} : { recentDays },
    ...hasConfigFilter ? { jobFilter } : {}
  });
  const entries = [...decoded.runsOfTest(identity.testId)].filter(
    (entry) => inDayRange(entry.day, window.range ?? void 0)
  );
  const filteredEntries = hasConfigFilter ? entries.flatMap((entry) => {
    const narrowed = narrowEntryToConfig(decoded, entry, jobFilter);
    return narrowed === null ? [] : [narrowed];
  }) : entries;
  const messages = [...failureMessageCounts(decoded, identity.testId, statsOptions)].map(([message, count2]) => ({ message: message ?? "(no message recorded)", count: count2 })).sort((a, b) => b.count - a.count);
  const crashSignatures = [...crashSignatureCounts(decoded, identity.testId, statsOptions)].map(([signature, count2]) => ({
    signature: signature ?? "(no signature recorded)",
    count: count2
  })).sort((a, b) => b.count - a.count);
  const skips = collectSkips(filteredEntries);
  const failingConfigs = configs.filter((config) => config.failCount > 0);
  const verdict = computeVerdict(totals, failingConfigs, filteredEntries, decoded);
  const coverage = coverageOf(decoded, identity.testId, {
    ...window.range === null ? {} : { dayRange: window.range },
    ...hasConfigFilter ? { jobFilter } : {}
  });
  const result = {
    test: identity.name,
    path: identity.fullPath,
    component: identity.component,
    harness,
    metadata: {
      family: decoded.family,
      generatedAt: file.metadata.generatedAt,
      startDate: window.startDate,
      endDate: window.endDate,
      dayCount: window.dayCount,
      singleDay: window.singleDay,
      dataSource: context.source.name
    },
    configFilter: hasConfigFilter ? {
      include: [...context.globals.config],
      exclude: [...context.globals.excludeConfig]
    } : null,
    totals,
    verdict,
    configs: failingConfigs,
    canAttributeConfigs: canAttributeConfigs(decoded),
    recentWindow: configs.length === 0 || window.singleDay ? null : { days: configs[0].recentDays, minRuns: 20 },
    reach: buildReach(decoded, coverage),
    // `statsOptions` is the same day and config filter the header totals
    // used, so the list and the totals cover one population.
    issues: buildTestIssues(decoded, identity.testId, totals, statsOptions),
    messages,
    crashSignatures,
    skips
  };
  if (boolOption(args, "coverage")) {
    result.coverage = buildCoverage(coverage);
  }
  if (boolOption(args, "executions")) {
    result.executions = buildExecutions(decoded, filteredEntries);
  }
  if (boolOption(args, "durations")) {
    result.durations = buildDurations(decoded, filteredEntries);
  }
  if (boolOption(args, "history")) {
    result.history = buildHistory(decoded, filteredEntries, window);
  }
  if (boolOption(args, "task-ids")) {
    result.taskIds = buildTaskIds(file, decoded, filteredEntries, window);
  }
  if (boolOption(args, "profiles")) {
    result.profiles = buildProfiles(decoded, filteredEntries);
  }
  if (context.globals.format === "json") {
    emit(context, toJson(result));
    return;
  }
  const limit = context.globals.limit ?? DEFAULT_LIMIT6;
  emit(
    context,
    context.globals.format === "markdown" ? renderMarkdown7(result, limit) : renderText7(result, limit)
  );
}
function jobNameOf(file, entry) {
  if (entry.jobName !== void 0) {
    return entry.jobName;
  }
  const first = entry.taskIdIndexes?.[0];
  return first === void 0 ? null : file.jobNameOfTaskIndex(first);
}
function collectSkips(entries) {
  const counts = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (classifyStatus(entry.status).kind !== "skip") {
      continue;
    }
    const message = entry.message ?? "(no reason recorded)";
    counts.set(message, (counts.get(message) ?? 0) + entry.count);
  }
  return [...counts].map(([message, count2]) => ({ message, count: count2 })).sort((a, b) => b.count - a.count);
}
function computeVerdict(totals, failingConfigs, entries, file) {
  const notes = [];
  if (totals.runCount === 0) {
    return {
      kind: totals.skipCount > 0 ? "skipped-everywhere" : "no-data",
      summary: totals.skipCount > 0 ? `skipped everywhere in this window (${count(totals.skipCount)} skipped runs, no runs at all).` : "no runs recorded in this window.",
      notes
    };
  }
  const permaFails = failingConfigs.filter((config) => config.failRate >= 100);
  const worst = failingConfigs[0];
  const modeNote = modeSkewNote(entries, file);
  if (modeNote !== null) {
    notes.push(modeNote);
  }
  const rerunNote = rerunNoteOf(entries);
  if (rerunNote !== null) {
    notes.push(rerunNote);
  }
  if (permaFails.length > 0) {
    return {
      kind: "perma-fail",
      summary: `perma-fail. Never passed on ${permaFails.length} configuration${permaFails.length === 1 ? "" : "s"}: ` + permaFails.slice(0, 3).map((config) => `${config.jobName} (${config.failCount}/${config.runCount})`).join(", ") + (permaFails.length > 3 ? `, and ${permaFails.length - 3} more` : "") + ". Use --coverage for every config it runs on.",
      notes
    };
  }
  if (failingConfigs.length === 0) {
    return {
      kind: "passing",
      summary: `passing. ${count(totals.passCount)} of ${count(totals.runCount)} runs passed` + (totals.expectedFailCount > 0 ? `, plus ${count(totals.expectedFailCount)} expected failures` : "") + ".",
      notes
    };
  }
  return {
    kind: "intermittent",
    summary: `intermittent. Fails on ${failingConfigs.length} configuration${failingConfigs.length === 1 ? "" : "s"}; ` + (worst === void 0 ? "" : `worst is ${worst.jobName} at ${percent(worst.failRate)} (${worst.failCount}/${worst.runCount})`) + ".",
    notes
  };
}
function modeSkewNote(entries, file) {
  if (!hasModeAxis(file.statuses)) {
    return null;
  }
  const failures = emptyModeBreakdown();
  const runs = emptyModeBreakdown();
  for (const entry of entries) {
    const { kind } = classifyStatus(entry.status);
    if (kind === "skip" || kind === "unknown") {
      continue;
    }
    addToModeBreakdown(runs, entry.status, entry.count);
    if (kind === "fail" || kind === "timeout" || kind === "crash") {
      addToModeBreakdown(failures, entry.status, entry.count);
    }
  }
  const total = failures.parallel + failures.sequential;
  if (total < 5) {
    return null;
  }
  if (failures.parallel >= total * 0.8 && runs.sequential >= 20) {
    const parallelRate = runs.parallel > 0 ? failures.parallel / runs.parallel * 100 : 0;
    const sequentialRate = runs.sequential > 0 ? failures.sequential / runs.sequential * 100 : 0;
    return `Fails almost only in parallel: ${failures.parallel} of ${total} mode-recorded failures, ${percent(parallelRate)} of parallel runs against ${percent(sequentialRate)} of sequential ones (--executions for the breakdown).`;
  }
  if (failures.sequential >= total * 0.8 && runs.parallel >= 20) {
    return `Fails almost only in sequential execution: ${failures.sequential} of ${total} mode-recorded failures (--executions for the breakdown).`;
  }
  return null;
}
function rerunNoteOf(entries) {
  const failing = entries.filter((entry) => {
    const { kind } = classifyStatus(entry.status);
    return kind === "fail" || kind === "timeout" || kind === "crash";
  });
  const reruns = countRerunsByTask(failing);
  if (reruns.jobsWithRerun === 0 || reruns.jobs === 0) {
    return null;
  }
  return `${reruns.jobsWithRerun} of ${reruns.jobs} failing jobs saw the failure more than once, which within a job is a harness rerun (--executions for the breakdown).`;
}
function buildCoverage(coverage) {
  const platforms = platformsCovered(coverage);
  return {
    attributedPasses: coverage.attributedPasses,
    configs: coverage.configs.map((config) => ({
      jobName: config.jobName,
      state: config.state,
      runCount: config.runCount,
      passCount: config.passCount,
      failCount: config.failCount + config.timeoutCount + config.crashCount,
      skipCount: config.skipCount,
      skipMessages: [...config.skipMessages].map(([message, count2]) => ({
        message,
        count: count2
      }))
    })),
    platforms: [...platforms].map(([platform, configCount]) => ({
      platform,
      configCount
    })),
    scheduledPlatforms: coveragePlatforms(coverage)
  };
}
function buildReach(file, coverage) {
  if (!coverage.attributedPasses) {
    return null;
  }
  const platforms = platformsCovered(coverage);
  const ranOn = coverage.configs.filter((config) => config.runCount > 0);
  const absentPlatforms = [...platformsInFileCache(file)].filter((platform) => !platforms.has(platform)).sort();
  return {
    configCount: ranOn.length,
    platforms: [...platforms].map(([platform, configCount]) => ({
      platform,
      configCount
    })),
    absentPlatforms
  };
}
var platformCache = /* @__PURE__ */ new WeakMap();
function platformsInFileCache(file) {
  let platforms = platformCache.get(file);
  if (platforms === void 0) {
    platforms = platformsInFile(file);
    platformCache.set(file, platforms);
  }
  return platforms;
}
function buildExecutions(file, entries) {
  const failing = entries.filter((entry) => {
    const { kind } = classifyStatus(entry.status);
    return kind === "fail" || kind === "timeout" || kind === "crash";
  });
  const reruns = countRerunsByTask(failing);
  if (!hasModeAxis(file.statuses)) {
    return {
      modeAxis: null,
      reruns: { jobs: reruns.jobs, runs: reruns.runs, jobsWithRerun: reruns.jobsWithRerun }
    };
  }
  const failures = emptyModeBreakdown();
  const runs = emptyModeBreakdown();
  for (const entry of entries) {
    const { kind } = classifyStatus(entry.status);
    if (kind === "skip" || kind === "unknown") {
      continue;
    }
    addToModeBreakdown(runs, entry.status, entry.count);
    if (kind === "fail" || kind === "timeout" || kind === "crash") {
      addToModeBreakdown(failures, entry.status, entry.count);
    }
  }
  const rateOf = (fails, total) => total > 0 ? fails / total * 100 : null;
  return {
    modeAxis: {
      failures,
      runs,
      failRate: {
        parallel: rateOf(failures.parallel, runs.parallel),
        sequential: rateOf(failures.sequential, runs.sequential),
        unrecorded: rateOf(failures.unrecorded, runs.unrecorded)
      }
    },
    reruns: { jobs: reruns.jobs, runs: reruns.runs, jobsWithRerun: reruns.jobsWithRerun }
  };
}
function buildDurations(file, entries) {
  const byJob = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (entry.durations === void 0 || entry.durations.length === 0) {
      continue;
    }
    const jobName = jobNameOf(file, entry);
    if (jobName === null) {
      continue;
    }
    const list = byJob.get(jobName) ?? [];
    list.push(...entry.durations);
    byJob.set(jobName, list);
  }
  const rows2 = [];
  for (const [jobName, durations] of byJob) {
    durations.sort((a, b) => a - b);
    rows2.push({
      jobName,
      runCount: durations.length,
      min: durations[0],
      median: quantile2(durations, 0.5),
      p95: quantile2(durations, 0.95),
      max: durations[durations.length - 1]
    });
  }
  return rows2.sort((a, b) => b.median - a.median || a.jobName.localeCompare(b.jobName));
}
function quantile2(sorted, q) {
  if (sorted.length === 0) {
    throw new Error("quantile of an empty array");
  }
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
function buildHistory(file, entries, window) {
  const days = file.days;
  if (days === null) {
    return [];
  }
  const from = window.range?.from ?? 0;
  const to = window.range?.to ?? days - 1;
  const rows2 = /* @__PURE__ */ new Map();
  for (let day = from; day <= to; day++) {
    rows2.set(day, {
      date: dateOfDayIndex(file.endDate, days, day),
      pass: 0,
      fail: 0,
      timeout: 0,
      crash: 0,
      skip: 0
    });
  }
  for (const entry of entries) {
    if (entry.day === null) {
      continue;
    }
    const row = rows2.get(entry.day);
    if (row === void 0) {
      continue;
    }
    const { kind } = classifyStatus(entry.status);
    switch (kind) {
      case "pass":
      case "expected-fail":
        row.pass += entry.count;
        break;
      case "fail":
        row.fail += entry.count;
        break;
      case "timeout":
        row.timeout += entry.count;
        break;
      case "crash":
        row.crash += entry.count;
        break;
      case "skip":
        row.skip += entry.count;
        break;
      case "unknown":
        break;
    }
  }
  return [...rows2.values()];
}
function buildTaskIds(raw, file, entries, window) {
  const rows2 = [];
  const days = file.days;
  for (const entry of entries) {
    const { kind } = classifyStatus(entry.status);
    if (kind !== "fail" && kind !== "timeout" && kind !== "crash") {
      continue;
    }
    if (entry.taskIds === void 0) {
      continue;
    }
    entry.taskIds.forEach((raw2, i) => {
      const { taskId, retryId } = parseTaskId(raw2);
      const taskIdIndex = entry.taskIdIndexes?.[i];
      const row = {
        taskId,
        retryId,
        jobName: taskIdIndex === void 0 ? null : file.jobNameOfTaskIndex(taskIdIndex),
        chunk: taskIdIndex === void 0 || raw.taskInfo === void 0 ? null : chunkOfTask(raw, taskIdIndex),
        status: entry.status,
        day: entry.day === null || days === null ? null : dateOfDayIndex(file.endDate, days, entry.day),
        message: entry.message ?? null
      };
      const minidumpId = entry.minidumps?.[i];
      if (minidumpId) {
        row.minidumpId = minidumpId;
        row.crashCommand = `fx-tests crash ${taskId}.${retryId} ${minidumpId}`;
      }
      rows2.push(row);
    });
  }
  void window;
  return rows2;
}
function buildProfiles(file, entries) {
  const rows2 = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    const { kind } = classifyStatus(entry.status);
    if (kind !== "fail" && kind !== "timeout" && kind !== "crash") {
      continue;
    }
    if (entry.taskIds === void 0) {
      continue;
    }
    entry.taskIds.forEach((rawTaskId, i) => {
      const { taskId, retryId } = parseTaskId(rawTaskId);
      const key = `${taskId}.${retryId}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const taskIdIndex = entry.taskIdIndexes?.[i];
      const row = {
        taskId,
        retryId,
        jobName: taskIdIndex === void 0 ? null : file.jobNameOfTaskIndex(taskIdIndex),
        resourceUsage: resourceUsageProfileUrl(taskId, retryId)
      };
      const testProfile = uploadedProfileUrl(taskId, retryId, entry.message);
      if (testProfile !== null) {
        row.testProfile = testProfile;
      }
      rows2.push(row);
    });
  }
  return rows2;
}
function renderText7(result, limit) {
  const lines = [];
  const { metadata, totals } = result;
  lines.push(`${result.test} \u2014 ${dirOf(result.path)}`);
  if (result.component !== null) {
    lines.push(`Component: ${result.component}`);
  }
  lines.push(
    `Data: ${result.harness}, ${describeWindow2(metadata)}, generated ${metadata.generatedAt}`
  );
  const filterLine = describeConfigFilter(result.configFilter);
  if (filterLine !== null) {
    lines.push(filterLine);
  }
  lines.push("");
  lines.push(
    `  ${count(totals.runCount)} runs   ${count(totals.passCount)} pass (${percent(totals.passRate, 2)})   ${count(totals.failCount)} fail   ${count(totals.timeoutCount)} timeout   ${count(totals.crashCount)} crash   ${count(totals.skipCount)} skip`
  );
  if (totals.expectedFailCount > 0) {
    lines.push(`  ${count(totals.expectedFailCount)} expected failures`);
  }
  if (totals.unknownCount > 0) {
    lines.push(
      `  ${count(totals.unknownCount)} runs of an unrecognized status (not counted as pass or fail)`
    );
  }
  lines.push("");
  lines.push(`Verdict: ${result.verdict.summary}`);
  for (const note of result.verdict.notes) {
    lines.push(`  ${note}`);
  }
  const reachLine = describeReach(result.reach);
  if (reachLine !== null) {
    lines.push("");
    lines.push(reachLine);
  }
  if (result.configs.length > 0) {
    lines.push("");
    const shown = applyLimit(result.configs, limit);
    const header = result.recentWindow === null ? "Failing configurations" : `Failing configurations (recent = last ${result.recentWindow.days}d, sized so the sparsest config has ${result.recentWindow.minRuns}+ runs)`;
    lines.push(header);
    lines.push(
      ...table(
        [
          { header: "Configuration" },
          { header: "fail rate", align: "right" },
          { header: "fails", align: "right" },
          { header: "recent", align: "right" },
          { header: "runs", align: "right" }
        ],
        shown.map((config) => [
          config.jobName,
          percent(config.failRate),
          String(config.failCount),
          // `null` prints as `—`, not `0.0%`: "too few runs to say"
          // and "no failures" are different claims and the column
          // must not conflate them.
          percent(config.recentFailRate),
          String(config.runCount)
        ])
      )
    );
    lines.push(moreLine(result.configs.length, shown.length));
  } else if (totals.failCount + totals.timeoutCount + totals.crashCount > 0) {
    lines.push("");
    lines.push(
      result.canAttributeConfigs ? "  (no failing configuration in this window, though the totals show failures \u2014" : "  (this file does not attribute runs to configurations, so the failing-config"
    );
    lines.push(
      result.canAttributeConfigs ? "   the failures could not be attributed to a job)" : "   table cannot be built from it)"
    );
  }
  if (result.issues.length > 0) {
    lines.push("");
    lines.push("Issues");
    const shown = applyLimit(result.issues, limit);
    for (const entry of shown) {
      lines.push(
        `  ${String(entry.count).padStart(5)}x  ${entry.type.padEnd(7)} ${truncate(oneLine3(entry.message), 92)}`
      );
    }
    lines.push(moreLine(result.issues.length, shown.length));
  } else if (result.configFilter !== null) {
    lines.push("");
    lines.push("Issues");
    lines.push(`  ${emptyIssuesUnderFilter()}`);
  }
  if (result.coverage !== void 0) {
    lines.push("");
    lines.push(...renderCoverageText(result.coverage, limit));
  }
  if (result.executions !== void 0) {
    lines.push("");
    lines.push(...renderExecutionsText(result.executions));
  }
  if (result.durations !== void 0) {
    lines.push("");
    lines.push("Durations (ms, from passing runs)");
    const shown = applyLimit(result.durations, limit);
    lines.push(
      ...table(
        [
          { header: "Configuration" },
          { header: "runs", align: "right" },
          { header: "min", align: "right" },
          { header: "median", align: "right" },
          { header: "p95", align: "right" },
          { header: "max", align: "right" }
        ],
        shown.map((row) => [
          row.jobName,
          String(row.runCount),
          String(Math.round(row.min)),
          String(Math.round(row.median)),
          String(Math.round(row.p95)),
          String(Math.round(row.max))
        ])
      )
    );
    lines.push(moreLine(result.durations.length, shown.length));
  }
  if (result.history !== void 0) {
    lines.push("");
    lines.push("History (pass/fail per day)");
    for (const row of result.history) {
      const bar = row.fail + row.timeout + row.crash > 0 ? "!" : "\xB7";
      lines.push(
        `  ${dateWithWeekday(row.date)}  ${bar}  ${String(row.pass).padStart(5)} pass  ${String(row.fail).padStart(4)} fail  ${String(row.timeout).padStart(3)} timeout  ${String(row.crash).padStart(3)} crash  ${String(row.skip).padStart(5)} skip`
      );
    }
  }
  if (result.taskIds !== void 0) {
    lines.push("");
    lines.push("Task IDs");
    const shown = applyLimit(result.taskIds, limit);
    for (const row of shown) {
      lines.push(
        `  ${row.taskId}.${row.retryId}  ${row.status.padEnd(18)} ${row.day ?? "\u2014"}  ${row.jobName ?? "(unknown job)"}` + (row.chunk === null ? "" : ` chunk ${row.chunk}`)
      );
      if (row.crashCommand !== void 0) {
        lines.push(`    ${row.crashCommand}`);
      }
    }
    lines.push(moreLine(result.taskIds.length, shown.length));
    const crashRows = shown.filter((row) => row.status.startsWith("CRASH"));
    if (crashRows.length > 0 && crashRows.every((row) => row.minidumpId === void 0)) {
      lines.push(
        "  (no minidump was uploaded for these crashes, so there is nothing to read)"
      );
    }
  }
  if (result.profiles !== void 0) {
    lines.push("");
    lines.push("Profiles (raw artifact URLs, for profiler-cli)");
    const shown = applyLimit(result.profiles, limit);
    for (const row of shown) {
      lines.push(`  ${row.taskId}.${row.retryId}  ${row.jobName ?? "(unknown job)"}`);
      lines.push(`    resource-usage: ${row.resourceUsage}`);
      if (row.testProfile !== void 0) {
        lines.push(`    test profile:   ${row.testProfile}`);
      }
    }
    lines.push(moreLine(result.profiles.length, shown.length));
    if (shown.every((row) => row.testProfile === void 0)) {
      lines.push(
        "  (these are resource-usage profiles; per-test profiles: fx-tests try <rev> --profiles)"
      );
    }
  }
  return joinLines(lines);
}
function renderCoverageText(coverage, limit) {
  const lines = [];
  if (!coverage.attributedPasses) {
    return [
      "Coverage is not available from this file: it does not attribute passing runs",
      "to a configuration, so the table would show only the failing configs."
    ];
  }
  lines.push("Coverage");
  const shown = applyLimit(coverage.configs, limit);
  lines.push(
    ...table(
      [
        { header: "Configuration" },
        { header: "runs", align: "right" },
        { header: "pass", align: "right" },
        { header: "fail", align: "right" },
        { header: "skip", align: "right" },
        { header: "status" }
      ],
      shown.map((config) => [
        config.jobName,
        String(config.runCount),
        String(config.passCount),
        String(config.failCount),
        String(config.skipCount),
        coverageStatusLabel(config)
      ])
    )
  );
  lines.push(moreLine(coverage.configs.length, shown.length));
  for (const config of shown) {
    for (const skip of config.skipMessages) {
      lines.push(`      ${config.jobName}: ${truncate(oneLine3(skip.message), 80)}`);
    }
  }
  if (coverage.platforms.length > 0) {
    lines.push("");
    lines.push(
      `${coverage.configs.length} configs, ${coverage.platforms.length} platforms: ` + coverage.platforms.map((entry) => `${entry.platform} (${entry.configCount})`).join(", ")
    );
  }
  const ran = coverage.configs.filter((config) => config.runCount > 0).length;
  const skippedOnly = coverage.configs.filter(
    (config) => config.runCount === 0 && config.skipCount > 0
  ).length;
  const notApplicable = coverage.configs.filter(
    (config) => config.state === "not-applicable"
  ).length;
  const alsoSkipped = coverage.configs.filter(
    (config) => config.runCount > 0 && config.skipCount > 0
  ).length;
  const summary = [
    `${ran} ran`,
    skippedOnly > 0 ? `${skippedOnly} only ever skipped` : null,
    notApplicable > 0 ? `${notApplicable} not applicable (run-if)` : null
  ].filter((part) => part !== null);
  lines.push(`States: ${summary.join(", ")}`);
  if (alsoSkipped > 0) {
    lines.push(
      `${alsoSkipped} of the ${ran} configs that ran it also skipped it on other days \u2014 see the skip column.`
    );
  }
  lines.push(...renderScheduledPlatforms(coverage));
  return lines.filter((line) => line !== null);
}
function renderScheduledPlatforms(coverage) {
  if (coverage.scheduledPlatforms.length === 0) {
    return [];
  }
  const lines = ["", "Scheduled on:"];
  for (const entry of coverage.scheduledPlatforms) {
    const total = entry.ranCount + entry.skippedCount;
    const verdict = entry.ranCount === 0 ? " \u2014 scheduled here, but skipped on every config" : entry.skippedCount > 0 ? ` \u2014 ${entry.skippedCount} scheduled but skipped` : "";
    lines.push(`  ${entry.platform.padEnd(8)} ${entry.ranCount}/${total} ran${verdict}`);
  }
  return lines;
}
function coverageStatusLabel(config) {
  if (config.runCount > 0 && config.skipCount > 0) {
    return `${config.state} +skipped`;
  }
  return config.state;
}
function renderExecutionsText(executions) {
  const lines = ["Executions"];
  const { reruns } = executions;
  if (reruns.jobs === 0) {
    lines.push("  No failing runs with task attribution, so no rerun analysis.");
  } else {
    lines.push(
      `  ${reruns.runs} failing runs across ${reruns.jobs} jobs; ${reruns.jobsWithRerun} of those jobs saw the failure more than once.`
    );
    lines.push(
      "  A repeat within one job is a harness rerun. The aggregates record no order,"
    );
    lines.push(
      "  so this counts repetition rather than labelling a run initial or rerun."
    );
  }
  lines.push("");
  if (executions.modeAxis === null) {
    lines.push("  By execution mode: not recorded for this harness.");
    lines.push(
      "  The -PARALLEL/-SEQUENTIAL status suffixes are xpcshell-only, so there is"
    );
    lines.push("  no parallel-vs-sequential split to report here.");
    return lines;
  }
  const { failures, runs, failRate } = executions.modeAxis;
  lines.push("  By execution mode");
  lines.push(
    ...table(
      [
        { header: "mode" },
        { header: "failures", align: "right" },
        { header: "runs", align: "right" },
        { header: "rate", align: "right" }
      ],
      [
        ["parallel", String(failures.parallel), String(runs.parallel), percent(failRate.parallel)],
        [
          "sequential",
          String(failures.sequential),
          String(runs.sequential),
          percent(failRate.sequential)
        ],
        [
          "not recorded",
          String(failures.unrecorded),
          String(runs.unrecorded),
          percent(failRate.unrecorded)
        ]
      ],
      "    "
    )
  );
  lines.push(
    '    "not recorded" is its own bucket, not the sum of the other two: plain PASS'
  );
  lines.push("    coexists with PASS-PARALLEL and PASS-SEQUENTIAL in the same file.");
  lines.push("");
  lines.push(
    "  The two blocks partition the same failures two ways; they are not additive."
  );
  return lines;
}
function renderMarkdown7(result, limit) {
  const lines = [];
  const { metadata, totals } = result;
  lines.push(heading(`${result.test}`, 1));
  lines.push("");
  lines.push(`${code(result.path)}`);
  if (result.component !== null) {
    lines.push("");
    lines.push(`**Component:** ${result.component}`);
  }
  lines.push("");
  lines.push(
    `**Data:** ${result.harness}, ${describeWindow2(metadata)}, generated ${metadata.generatedAt}`
  );
  const filterLine = describeConfigFilter(result.configFilter);
  if (filterLine !== null) {
    lines.push("");
    lines.push(`**${filterLine}**`);
  }
  lines.push("");
  lines.push(
    ...table2(
      [
        { header: "runs", align: "right" },
        { header: "pass", align: "right" },
        { header: "fail", align: "right" },
        { header: "timeout", align: "right" },
        { header: "crash", align: "right" },
        { header: "skip", align: "right" }
      ],
      [
        [
          count(totals.runCount),
          `${count(totals.passCount)} (${percent(totals.passRate, 2)})`,
          count(totals.failCount),
          count(totals.timeoutCount),
          count(totals.crashCount),
          count(totals.skipCount)
        ]
      ]
    )
  );
  lines.push("");
  lines.push(`**Verdict:** ${result.verdict.summary}`);
  for (const note of result.verdict.notes) {
    lines.push("");
    lines.push(note);
  }
  const reachLine = describeReach(result.reach);
  if (reachLine !== null) {
    lines.push("");
    lines.push(reachLine);
  }
  if (result.configs.length > 0) {
    lines.push("");
    lines.push(heading("Failing configurations"));
    lines.push("");
    const shown = applyLimit(result.configs, limit);
    lines.push(
      ...table2(
        [
          { header: "Configuration" },
          { header: "fail rate", align: "right" },
          { header: "fails", align: "right" },
          { header: "recent", align: "right" },
          { header: "runs", align: "right" }
        ],
        shown.map((config) => [
          config.jobName,
          percent(config.failRate),
          String(config.failCount),
          percent(config.recentFailRate),
          String(config.runCount)
        ])
      )
    );
    lines.push(moreLine2(result.configs.length, shown.length));
  }
  if (result.issues.length > 0) {
    lines.push("");
    lines.push(heading("Issues"));
    lines.push("");
    const shown = applyLimit(result.issues, limit);
    lines.push(
      ...table2(
        [
          { header: "count", align: "right" },
          { header: "kind" },
          { header: "message" }
        ],
        shown.map((entry) => [String(entry.count), entry.type, oneLine3(entry.message)])
      )
    );
    lines.push(moreLine2(result.issues.length, shown.length));
  } else if (result.configFilter !== null) {
    lines.push("");
    lines.push(heading("Issues"));
    lines.push("");
    lines.push(emptyIssuesUnderFilter());
  }
  if (result.coverage !== void 0) {
    lines.push("");
    lines.push(heading("Coverage"));
    lines.push("");
    if (!result.coverage.attributedPasses) {
      lines.push(
        "Not available from this file: it does not attribute passing runs to a configuration."
      );
    } else {
      const shown = applyLimit(result.coverage.configs, limit);
      lines.push(
        ...table2(
          [
            { header: "Configuration" },
            { header: "runs", align: "right" },
            { header: "pass", align: "right" },
            { header: "fail", align: "right" },
            { header: "skip", align: "right" },
            { header: "status" }
          ],
          shown.map((config) => [
            config.jobName,
            String(config.runCount),
            String(config.passCount),
            String(config.failCount),
            String(config.skipCount),
            config.state
          ])
        )
      );
      lines.push(moreLine2(result.coverage.configs.length, shown.length));
      if (result.coverage.scheduledPlatforms.length > 0) {
        lines.push("");
        lines.push(
          ...table2(
            [
              { header: "Platform scheduled on" },
              { header: "ran", align: "right" },
              { header: "skipped", align: "right" }
            ],
            result.coverage.scheduledPlatforms.map((entry) => [
              entry.platform,
              String(entry.ranCount),
              String(entry.skippedCount)
            ])
          )
        );
        lines.push("");
        lines.push(
          "Every platform this test is scheduled on has a row above. A platform with no row is one CI does not run this test on."
        );
      }
    }
  }
  if (result.executions !== void 0) {
    lines.push("");
    lines.push(heading("Executions"));
    lines.push("");
    lines.push(...renderExecutionsText(result.executions).slice(1).map((line) => line.trim()));
  }
  return joinLines(lines);
}
function describeReach(reach) {
  if (reach === null || reach.configCount === 0) {
    return null;
  }
  const platforms = reach.platforms.map((entry) => `${entry.platform} (${entry.configCount})`).join(", ");
  const absent = reach.absentPlatforms.length === 0 ? "" : ` \u2014 not ${reach.absentPlatforms.join(", ")}; see --coverage`;
  return `Runs on ${reach.configCount} configs across ${platforms}${absent}`;
}
function emptyIssuesUnderFilter() {
  return "(no issues on the configurations this filter matched)";
}
function describeConfigFilter(filter) {
  if (filter === null) {
    return null;
  }
  const parts = [];
  if (filter.include.length > 0) {
    parts.push(`matching ${filter.include.join(", ")}`);
  }
  if (filter.exclude.length > 0) {
    parts.push(`excluding ${filter.exclude.join(", ")}`);
  }
  return `Filtered: every count below covers only configurations ${parts.join(", ")}`;
}
function describeWindow2(metadata) {
  if (metadata.singleDay) {
    return `${dateWithWeekday(metadata.endDate)} only`;
  }
  return `${metadata.dayCount} days (${dateWithWeekday(metadata.startDate)} \u2026 ${dateWithWeekday(metadata.endDate)})`;
}
function dirOf(path) {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "." : path.slice(0, slash);
}
function oneLine3(value) {
  return value.replace(/\s*\r?\n\s*/g, " \u23CE ").trim();
}

// lib/query/flakiness-rate.ts
var MIN_RECENT_RUNS = 100;
var HISTORY_DAYS = 21;
var MAX_TOOLTIP_CONFIGS = 4;
function pickHeadlineRate(stats, configs) {
  const overall = overallRate(stats);
  const rateOf = (config) => config.recentSameMsgFailRate !== null ? {
    rate: config.recentSameMsgFailRate,
    runs: config.recentRunCount,
    days: config.recentDays,
    recent: true,
    scope: "config"
  } : {
    rate: config.sameMsgFailRate,
    runs: config.runCount,
    recent: false,
    scope: "config"
  };
  const score = (rate2) => rate2.runs > 0 ? rate2.rate - 100 / Math.sqrt(rate2.runs) : 0;
  let best = null;
  let bestScore = -Infinity;
  for (const config of configs ?? []) {
    const rate2 = rateOf(config);
    const current = score(rate2);
    if (best === null || current > bestScore) {
      best = { ...rate2, jobName: config.jobName };
      bestScore = current;
    }
  }
  if (best === null || best.rate === 0) {
    return { rate: overall, runs: stats.runCount, scope: "overall" };
  }
  return { ...best, scope: "config", lowConfidence: best.runs < MIN_RECENT_RUNS };
}
function overallRate(stats) {
  return stats.runCount > 0 ? (stats.failCount + stats.crashCount + stats.timeoutCount) / stats.runCount * 100 : 0;
}
function formatFailRate(rate2) {
  return `${rate2.toFixed(1)}%`;
}
function dayCount(days) {
  return days === 1 ? "the last day" : `the last ${days} days`;
}
function flakinessTooltip(stats, configs, headline, hasMatchingMessage, totalDays) {
  const overall = overallRate(stats);
  const all = totalDays || HISTORY_DAYS;
  const lines = [];
  lines.push(
    hasMatchingMessage ? "This failure already happens without your changes." : "This exact failure was never seen in history \u2014 it looks new.",
    ""
  );
  if (headline.scope === "config") {
    const span = headline.recent === true ? dayCount(headline.days) : `${all} days`;
    lines.push(
      `It fails this way ${formatFailRate(headline.rate)} of the time over ${span} on` + (headline.lowConfidence === true ? ` (only ${headline.runs} runs, so approximate)` : ""),
      `${headline.jobName}`
    );
  }
  const rateFor = (config) => config.recentSameMsgFailRate !== null ? { rate: config.recentSameMsgFailRate, runs: config.recentRunCount } : { rate: config.sameMsgFailRate, runs: config.runCount };
  const shown = (configs ?? []).map((config) => ({
    ...rateFor(config),
    jobName: config.jobName,
    recentDays: config.recentDays
  })).filter((config) => config.rate > 0).sort((a, b) => b.rate - a.rate);
  if (shown.length > 0) {
    lines.push("", `Same failure over ${dayCount(shown[0].recentDays)}, by configuration:`);
    for (const config of shown.slice(0, MAX_TOOLTIP_CONFIGS)) {
      lines.push(`  ${formatFailRate(config.rate)} of ${config.runs} runs \u2014 ${config.jobName}`);
    }
    const hidden = shown.length - MAX_TOOLTIP_CONFIGS;
    if (hidden > 0) {
      lines.push(`  and ${hidden} more configuration${hidden === 1 ? "" : "s"}`);
    }
  }
  lines.push(
    "",
    `Any failure, all platforms, ${all} days: ${formatFailRate(overall)} of ${stats.runCount} runs.`
  );
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n");
}

// lib/model/failure-message.ts
function normalizeMessage(message) {
  if (message === null || message === void 0) {
    return null;
  }
  return message.replace(/\r\n/g, "\n").replace(/task_\d+/g, "task_id").replace(/\nRejection date: [^\n]+/g, "").replace(/Test ran for \d+s/g, "Test ran for Xs");
}

// lib/model/test-path.ts
var MANIFEST_PREFIX = /^[^:]+\.(?:toml|ini):/;
function stripManifestPrefix(id) {
  return id.replace(MANIFEST_PREFIX, "").replace(/\s+\(finished\)$/, "").trim();
}
function isTestFilePath(path) {
  return /\.(js|html|xhtml)$/.test(path);
}
function normalizeTestPath(id) {
  if (id === null || id === void 0 || id === "") {
    return null;
  }
  const path = stripManifestPrefix(id);
  return isTestFilePath(path) ? path : null;
}
function describeTestPathDrop(id) {
  return id === null || id === void 0 || id === "" ? "no-id" : "not-a-test-path";
}

// lib/model/try-jobs.ts
var SUPPORTED_HARNESSES = ["mochitest", "xpcshell"];
function isTestJob(jobName) {
  return SUPPORTED_HARNESSES.some((harness) => jobName.includes(harness));
}
var FAILURE_STATUSES = /* @__PURE__ */ new Set([
  "FAIL",
  "TIMEOUT",
  "CRASH",
  "ERROR",
  "UNEXPECTED-PASS"
]);
function baseStatus(status) {
  return status.replace(/-(PARALLEL|SEQUENTIAL)$/, "");
}
function isFailureStatus(status) {
  return FAILURE_STATUSES.has(baseStatus(status));
}
function runKeyOf(run2) {
  return `${run2.taskId}.${run2.retryId}`;
}
function runOutcomes(execsByRun, failedJobNames, runsPerJobName, isRerun) {
  const outcomes = {
    failedTwice: 0,
    passedOnRetry: 0,
    failedOnce: 0,
    passed: 0,
    notAnalyzed: 0
  };
  for (const jobName of failedJobNames) {
    const runs = execsByRun.get(jobName);
    for (const execs of runs?.values() ?? []) {
      const failed = execs.filter((exec) => isFailureStatus(exec.status));
      if (failed.length === 0) {
        outcomes.passed++;
      } else if (execs.some((exec) => isRerun(exec) && exec.status.startsWith("PASS"))) {
        outcomes.passedOnRetry++;
      } else if (failed.length > 1) {
        outcomes.failedTwice++;
      } else {
        outcomes.failedOnce++;
      }
    }
    outcomes.notAnalyzed += Math.max(0, (runsPerJobName.get(jobName) ?? 0) - (runs?.size ?? 0));
  }
  return outcomes;
}
function selectTryJobs(jobs, options) {
  const failedTestJobs = [];
  const successfulTestJobs = [];
  const otherFailedJobs = [];
  const runsPerJobName = /* @__PURE__ */ new Map();
  for (const job of jobs) {
    if (job.state !== "completed") {
      continue;
    }
    if (isTestJob(job.jobName)) {
      runsPerJobName.set(job.jobName, (runsPerJobName.get(job.jobName) ?? 0) + 1);
      if (job.result === "testfailed") {
        failedTestJobs.push(job);
      } else if (job.result === "success") {
        successfulTestJobs.push(job);
      }
    } else if (FAILED_JOB_RESULTS.has(job.result)) {
      otherFailedJobs.push(job);
    }
  }
  return {
    failedTestJobs,
    successfulTestJobs,
    otherFailedJobs,
    jobsToProcess: options.readPassingJobs ? failedTestJobs.concat(successfulTestJobs) : [...failedTestJobs],
    readPassingJobs: options.readPassingJobs,
    runsPerJobName,
    successfulJobNames: new Set(successfulTestJobs.map((job) => job.jobName))
  };
}

// cli/commands/try.ts
var MESSAGE_CAP = 20;
var TRY_OPTIONS = {
  project: {
    type: "string",
    placeholder: "<try|autoland|\u2026>",
    describe: "The Treeherder repository the push is on. Default try."
  },
  "perma-only": {
    type: "boolean",
    describe: "Only the perma-fail section \u2014 the highest-signal output."
  },
  "all-jobs": {
    type: "boolean",
    // Says what it fetches, what that buys, and what it costs. The page's
    // tooltip is the model ("Also fetch profiles of test jobs that
    // ultimately succeeded, so tests that failed initially but passed on
    // retry surface too"); the cost clause is added because a terminal
    // gives no other warning before a run that reads tens of times more
    // artifacts. Kept to one line because the help printer does not wrap.
    describe: "Also read profiles of test jobs that SUCCEEDED, so a test that failed then passed on retry surfaces. Reads every test job: much slower."
  },
  "other-jobs": {
    type: "boolean",
    describe: "List the non-test job failures (builds, lint) the header already counts."
  },
  test: {
    type: "string",
    placeholder: "<path>",
    describe: "Report one test per configuration: ran/pass/fail/skip/timeout. Needs --all-jobs for the pass counts."
  },
  "task-ids": { type: "boolean", describe: "Print the task IDs behind each failure." },
  profiles: { type: "boolean", describe: "Print raw profile artifact URLs." },
  messages: {
    type: "boolean",
    describe: `Print every failure message per row, not just the first (cap ${MESSAGE_CAP}).`
  },
  concurrency: {
    type: "number",
    placeholder: "<n>",
    describe: "How many job profiles to fetch at once. Default 8."
  }
};
var DEFAULT_LIMIT7 = 10;
var PERMA_FAIL_DESCRIPTION = "failed in every run of at least one configuration here. Each row says what central shows on that same configuration.";
var DEFAULT_CONCURRENCY = 8;
async function runTry(context, args) {
  const revision = args.positionals[0];
  if (revision === void 0) {
    throw usageError(
      "try requires a revision",
      "Usage: fx-tests try <revision>, e.g. fx-tests try 4f2c1a9e8b3d"
    );
  }
  if (args.positionals.length > 1) {
    throw usageError(`try takes one revision, got ${args.positionals.length}`);
  }
  const treeherder = context.treeherder;
  if (treeherder === void 0) {
    throw new Error("try needs a Treeherder client but none was supplied");
  }
  const fetchUrl = context.fetchUrl;
  if (fetchUrl === void 0) {
    throw new Error("try needs a URL fetcher but none was supplied");
  }
  if (context.globals.config.length > 0 || context.globals.excludeConfig.length > 0) {
    throw usageError(
      "--config cannot be applied to try: this command classifies a test across the configurations a push ran, so filtering the job set would change what each section means rather than narrow it",
      "The per-row config names and central comparison are already per configuration. For one test on one configuration over central, use `fx-tests test <path> --config <substring>`."
    );
  }
  const project = stringOption(args, "project") ?? "try";
  progress(context, `Looking up ${revision} on ${project}\u2026`);
  const push = await treeherder.findPush(project, revision);
  progress(context, `Fetching jobs for push ${push.pushId}\u2026`);
  const jobs = await treeherder.jobsOfPush(push.pushId);
  const selection = selectTryJobs(jobs, {
    readPassingJobs: boolOption(args, "all-jobs")
  });
  const { failedTestJobs, successfulTestJobs, otherFailedJobs, jobsToProcess } = selection;
  const { readPassingJobs, runsPerJobName } = selection;
  let timings = [];
  if (jobsToProcess.length > 0) {
    progress(
      context,
      `Reading ${jobsToProcess.length} job profiles (one per ${readPassingJobs ? "completed test job, passing ones included" : "failed test job"})\u2026`
    );
    timings = await collectTimings(
      context,
      jobsToProcess,
      fetchUrl,
      Number(args.options.get("concurrency") ?? DEFAULT_CONCURRENCY)
    );
  }
  const testPath = stringOption(args, "test");
  if (testPath !== void 0) {
    emit(
      context,
      renderTestReport(
        context,
        push.revision,
        project,
        testPath,
        timings,
        runsPerJobName,
        readPassingJobs
      )
    );
    return;
  }
  const failures = aggregateFailures(timings, runsPerJobName);
  if (failures.length > 0) {
    progress(context, `Comparing ${failures.length} failing tests against central\u2026`);
    await attachCentralHistory(context, failures);
  }
  const asJson = context.globals.format === "json";
  const withTaskIds = asJson || boolOption(args, "task-ids");
  const withProfiles = asJson || boolOption(args, "profiles");
  attachProvenance(failures, timings, withTaskIds, withProfiles);
  const blamed = new Set(
    timings.filter((timing) => isFailureStatus(timing.status)).map(runKeyOf)
  );
  const unblamedJobCount = failedTestJobs.filter((job) => !blamed.has(runKeyOf(job))).length;
  const result = {
    revision: push.revision,
    pushId: push.pushId,
    project,
    treeherderUrl: treeherderPushUrl(project, push.revision),
    jobCount: jobs.length,
    failedJobCount: failedTestJobs.length + otherFailedJobs.length,
    profilesRead: jobsToProcess.length,
    readPassingJobs,
    passingTestJobCount: successfulTestJobs.length,
    unblamedJobCount,
    otherFailedJobs: otherFailedJobs.map((job) => ({
      jobName: job.jobName,
      taskId: job.taskId,
      result: job.result
    })),
    permaFails: failures.filter(isPermaFail),
    knownIntermittents: failures.filter(
      (failure) => !isPermaFail(failure) && isKnownOnCentral(failure)
    ),
    newIntermittents: failures.filter(
      (failure) => !isPermaFail(failure) && !isKnownOnCentral(failure)
    )
  };
  if (context.globals.format === "json") {
    emit(context, toJson(result));
    return;
  }
  const limit = context.globals.limit ?? DEFAULT_LIMIT7;
  emit(
    context,
    context.globals.format === "markdown" ? renderMarkdown8(result, limit, boolOption(args, "perma-only"), boolOption(args, "other-jobs")) : renderText8(
      result,
      limit,
      boolOption(args, "perma-only"),
      boolOption(args, "other-jobs"),
      boolOption(args, "messages")
    )
  );
}
function isPermaFail(failure) {
  return failure.everyRunFailed;
}
function isKnownOnCentral(failure) {
  return failure.central !== null && failure.central.failCount > 0;
}
function isStreamedProfile(bytes2) {
  const head = new TextDecoder().decode(bytes2.subarray(0, 64 * 1024));
  const newline = head.indexOf("\n");
  if (newline < 0) {
    return false;
  }
  const rest = head.slice(newline + 1).trim();
  try {
    JSON.parse(head.slice(0, newline));
  } catch {
    return false;
  }
  return rest.startsWith("{");
}
async function collectTimings(context, jobs, fetchUrl, concurrency) {
  const timings = [];
  const dropped = [];
  const queue = [...jobs];
  let done = 0;
  let missing = 0;
  let streamed = 0;
  const worker = async () => {
    for (; ; ) {
      const job = queue.shift();
      if (job === void 0) {
        return;
      }
      const url = resourceUsageProfileUrl(job.taskId, job.retryId);
      let bytes2 = null;
      try {
        bytes2 = await fetchUrl(url);
      } catch {
        bytes2 = null;
      }
      done++;
      if (bytes2 === null) {
        missing++;
      } else if (isStreamedProfile(bytes2)) {
        streamed++;
      } else {
        try {
          const profile = JSON.parse(new TextDecoder().decode(bytes2));
          timings.push(...parseTestMarkers(profile, job, dropped));
        } catch {
          missing++;
        }
      }
      if (done % 10 === 0) {
        progress(context, `  \u2026${done}/${jobs.length} profiles`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker)
  );
  if (streamed > 0) {
    warn(
      context,
      `${streamed} of ${jobs.length} jobs were killed for exceeding their maximum duration, so only a streamed profile exists for them and this tool does not read that format; failures in those jobs are not in this report`
    );
  }
  if (missing > 0) {
    warn(
      context,
      `${missing} of ${jobs.length} job profiles could not be read; failures in those jobs are not in this report`
    );
  }
  if (dropped.length > 0) {
    const shown = [...new Set(dropped.map((entry) => `${entry.status} ${entry.id}`))];
    warn(
      context,
      `${dropped.length} failing marker${dropped.length === 1 ? "" : "s"} named no test path and are not in this report (a crash recorded against a manifest has no path to compare against central): ${shown.slice(0, 5).join(", ")}` + (shown.length > 5 ? `, and ${shown.length - 5} more` : "")
    );
  }
  return timings;
}
var DROP_WORTH_REPORTING = /* @__PURE__ */ new Set(["FAIL", "TIMEOUT", "CRASH", "ERROR"]);
function parseTestMarkers(profile, job, dropped = []) {
  const thread = profile?.threads?.[0];
  const markers = thread?.markers;
  const stringArray = thread?.stringArray;
  if (markers?.data === void 0 || markers.name === void 0 || stringArray === void 0) {
    return [];
  }
  const length = markers.length ?? markers.data.length;
  const startTime = markers.startTime ?? [];
  const endTime = markers.endTime ?? [];
  const rangesOf = (text) => {
    const ranges = [];
    for (let i = 0; i < length; i++) {
      const data = markers.data[i];
      if (data?.type === "Text" && data.text === text) {
        ranges.push({ start: startTime[i] ?? 0, end: endTime[i] ?? 0 });
      }
    }
    return ranges;
  };
  const parallelRanges = rangesOf("parallel");
  const retryRanges = rangesOf("retry");
  const overlaps = (start, end, ranges) => ranges.some((range) => start < range.end && end > range.start);
  const crashMarkers = [];
  for (let i = 0; i < length; i++) {
    const data = markers.data[i];
    if (data?.type !== "Crash" || data.test === void 0) {
      continue;
    }
    crashMarkers.push({
      testPath: data.test,
      start: startTime[i] ?? 0,
      signature: data.signature ?? null,
      minidump: data.minidump ?? null,
      reason: data.reason ?? null,
      consumed: false
    });
  }
  const failStringId = stringArray.indexOf("FAIL");
  const errorStringId = stringArray.indexOf("ERROR");
  const testStatusMarkers = [];
  for (let i = 0; i < length; i++) {
    const nameId = markers.name[i];
    if (nameId !== failStringId && nameId !== errorStringId) {
      continue;
    }
    const data = markers.data[i];
    if (data?.type !== "TestStatus" || data.test === void 0) {
      continue;
    }
    const message = normalizeMessage(data.message ?? null);
    if (message === null) {
      continue;
    }
    testStatusMarkers.push({
      test: data.test,
      time: startTime[i] ?? 0,
      message,
      statusName: stringArray[nameId] ?? "FAIL"
    });
  }
  testStatusMarkers.sort((a, b) => a.time - b.time);
  const messagesInRange = (test, start, end) => testStatusMarkers.filter(
    (marker) => marker.test === test && marker.time >= start && marker.time <= end
  ).map((marker) => ({ message: marker.message, status: marker.statusName }));
  const testStringId = stringArray.indexOf("test");
  const timings = [];
  for (let i = 0; i < length; i++) {
    if (markers.name[i] !== testStringId) {
      continue;
    }
    const data = markers.data[i];
    if (data?.type !== "Test") {
      continue;
    }
    const fullTestId = data.test ?? data.name ?? "";
    const path = normalizeTestPath(fullTestId);
    if (path === null) {
      const status2 = data.status ?? "";
      if (DROP_WORTH_REPORTING.has(status2)) {
        dropped.push({
          kind: "Test",
          id: fullTestId,
          reason: describeTestPathDrop(fullTestId),
          status: status2
        });
      }
      continue;
    }
    const start = startTime[i] ?? 0;
    const end = endTime[i] ?? 0;
    let status = data.status ?? "UNKNOWN";
    if (status === "FAIL" && data.color === "green") {
      status = "EXPECTED-FAIL";
    } else if (status === "PASS" && data.expected !== void 0 && data.expected !== "PASS") {
      status = "UNEXPECTED-PASS";
    } else if (["TIMEOUT", "FAIL", "CRASH", "PASS"].includes(status) && parallelRanges.length > 0) {
      status += overlaps(start, end, parallelRanges) ? "-PARALLEL" : "-SEQUENTIAL";
    }
    let message = normalizeMessage(data.message ?? null);
    let partitioned = { messages: [], profileFilenames: [] };
    if (status.startsWith("FAIL") || status.startsWith("TIMEOUT") || status === "ERROR") {
      partitioned = partitionMarkerMessages(messagesInRange(fullTestId, start, end));
      message = partitioned.messages[0] ?? message;
    }
    if (status.startsWith("CRASH")) {
      const matching = crashMarkers.find(
        (crash) => !crash.consumed && crash.testPath === fullTestId && crash.start >= start && crash.start <= end
      );
      if (matching !== void 0) {
        matching.consumed = true;
        message ??= normalizeMessage(matching.signature);
      }
    }
    timings.push({
      path,
      status,
      message,
      messages: partitioned.messages,
      profileFilenames: partitioned.profileFilenames,
      jobName: job.jobName,
      taskId: job.taskId,
      retryId: job.retryId,
      isRerun: retryRanges.length > 0 && overlaps(start, end, retryRanges)
    });
  }
  for (const crash of crashMarkers) {
    if (crash.consumed) {
      continue;
    }
    const path = normalizeTestPath(crash.testPath);
    if (path === null) {
      dropped.push({
        kind: "Crash",
        id: crash.testPath,
        reason: describeTestPathDrop(crash.testPath),
        status: "CRASH"
      });
      continue;
    }
    timings.push({
      path,
      status: "CRASH",
      message: normalizeMessage(crash.signature ?? crash.reason),
      // The harness uploads a per-test profile from a failure handler that
      // a crash never reaches.
      messages: [],
      profileFilenames: [],
      jobName: job.jobName,
      taskId: job.taskId,
      retryId: job.retryId,
      isRerun: false
    });
  }
  return timings;
}
function aggregateFailures(timings, runsPerJobName) {
  const passedOnRerunByRun = /* @__PURE__ */ new Map();
  for (const timing of timings) {
    if (!timing.isRerun || !timing.status.startsWith("PASS")) {
      continue;
    }
    const key = runKeyOf(timing);
    let set = passedOnRerunByRun.get(key);
    if (set === void 0) {
      set = /* @__PURE__ */ new Set();
      passedOnRerunByRun.set(key, set);
    }
    set.add(timing.path);
  }
  const byTest = /* @__PURE__ */ new Map();
  for (const timing of timings) {
    if (!isFailureStatus(timing.status)) {
      continue;
    }
    let entry = byTest.get(timing.path);
    if (entry === void 0) {
      entry = {
        path: timing.path,
        failureCount: 0,
        failedRunsByJobName: /* @__PURE__ */ new Map(),
        passedOnRerunConfigs: /* @__PURE__ */ new Set(),
        messages: /* @__PURE__ */ new Map(),
        otherMessages: /* @__PURE__ */ new Map(),
        statuses: /* @__PURE__ */ new Set(),
        modes: /* @__PURE__ */ new Set()
      };
      byTest.set(timing.path, entry);
    }
    entry.failureCount++;
    let runs = entry.failedRunsByJobName.get(timing.jobName);
    if (runs === void 0) {
      runs = /* @__PURE__ */ new Set();
      entry.failedRunsByJobName.set(timing.jobName, runs);
    }
    runs.add(runKeyOf(timing));
    entry.statuses.add(baseStatus(timing.status));
    if (timing.message !== null) {
      entry.messages.set(timing.message, (entry.messages.get(timing.message) ?? 0) + 1);
    }
    for (const message of timing.messages) {
      entry.otherMessages.set(message, (entry.otherMessages.get(message) ?? 0) + 1);
    }
    if (passedOnRerunByRun.get(runKeyOf(timing))?.has(timing.path) === true) {
      entry.passedOnRerunConfigs.add(timing.jobName);
    }
    const suffix = /-(PARALLEL|SEQUENTIAL)$/.exec(timing.status)?.[1];
    entry.modes.add(suffix ?? "UNRECORDED");
  }
  const execsByTest = /* @__PURE__ */ new Map();
  for (const timing of timings) {
    if (!byTest.has(timing.path)) {
      continue;
    }
    let byJob = execsByTest.get(timing.path);
    if (byJob === void 0) {
      byJob = /* @__PURE__ */ new Map();
      execsByTest.set(timing.path, byJob);
    }
    let byRun = byJob.get(timing.jobName);
    if (byRun === void 0) {
      byRun = /* @__PURE__ */ new Map();
      byJob.set(timing.jobName, byRun);
    }
    const key = runKeyOf(timing);
    let execs = byRun.get(key);
    if (execs === void 0) {
      execs = [];
      byRun.set(key, execs);
    }
    execs.push(timing);
  }
  const failures = [];
  for (const entry of byTest.values()) {
    const jobNames = [...entry.failedRunsByJobName.keys()];
    const totalJobs = jobNames.reduce(
      (sum, jobName) => sum + (runsPerJobName.get(jobName) ?? 0),
      0
    );
    const execsByJobName = execsByTest.get(entry.path);
    let totalRuns2 = 0;
    for (const jobName of jobNames) {
      const runs = execsByJobName?.get(jobName);
      for (const execs of runs?.values() ?? []) {
        totalRuns2 += execs.length;
      }
      totalRuns2 += Math.max(0, (runsPerJobName.get(jobName) ?? 0) - (runs?.size ?? 0));
    }
    const failedRuns = new Set(
      [...entry.failedRunsByJobName.values()].flatMap((runs) => [...runs])
    ).size;
    const permaFailingConfigs = jobNames.filter((jobName) => {
      if (entry.passedOnRerunConfigs.has(jobName)) {
        return false;
      }
      const runsOfConfig = runsPerJobName.get(jobName) ?? 0;
      const failed = entry.failedRunsByJobName.get(jobName)?.size ?? 0;
      return runsOfConfig > 0 && failed >= runsOfConfig;
    });
    const passedOnRerunConfigs = [...entry.passedOnRerunConfigs].sort();
    const outcomes = runOutcomes(
      execsByJobName ?? /* @__PURE__ */ new Map(),
      jobNames,
      runsPerJobName,
      (timing) => timing.isRerun
    );
    failures.push({
      path: entry.path,
      jobNames: jobNames.sort(),
      failureCount: entry.failureCount,
      failedRuns,
      totalRuns: totalRuns2,
      totalJobs,
      outcomes,
      everyRunFailed: permaFailingConfigs.length > 0,
      permaFailingConfigs: permaFailingConfigs.sort(),
      passedOnRerun: passedOnRerunConfigs.length > 0,
      passedOnRerunConfigs,
      messages: [...entry.messages].sort((a, b) => b[1] - a[1]).map(([message]) => message),
      allMessages: [...entry.otherMessages].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([message, count2]) => ({ message, count: count2 })),
      // A timeout or a crash records no message anywhere — not in the
      // push and not in the aggregates (`FORMATS.md`) — so for those the
      // status kind is the comparison and it is a valid one. For a plain
      // FAIL with no message there is nothing to compare at all.
      // `has`, not a `startsWith` scan: the set holds base statuses now,
      // so the prefix test that tolerated `TIMEOUT-PARALLEL` is no
      // longer standing in for an exact comparison.
      messageComparable: entry.messages.size > 0 || entry.statuses.has("TIMEOUT") || entry.statuses.has("CRASH"),
      statuses: [...entry.statuses].sort(),
      parallelOnly: entry.modes.size === 1 && entry.modes.has("PARALLEL"),
      central: null
    });
  }
  return failures.sort(
    (a, b) => b.failureCount - a.failureCount || a.path.localeCompare(b.path)
  );
}
async function attachCentralHistory(context, failures) {
  const wanted = /* @__PURE__ */ new Map();
  for (const failure of failures) {
    const harness = detectHarness(failure.path);
    const suffix = bucketFileSuffix(bucketIndexForPath(failure.path));
    const key = `${harness}-${suffix}`;
    let group = wanted.get(key);
    if (group === void 0) {
      group = { harness, suffix, failures: [] };
      wanted.set(key, group);
    }
    group.failures.push(failure);
  }
  for (const group of wanted.values()) {
    let file;
    try {
      file = await fetchJson(context.source, {
        index: timingsIndex(group.harness),
        filename: `${group.harness}-${group.suffix}.json`
      });
    } catch (error) {
      warn(
        context,
        `could not read central history for ${group.harness}-${group.suffix}.json: ${error.message}`
      );
      continue;
    }
    const decoded = decodeBucket(file);
    for (const failure of group.failures) {
      const identity = decoded.findTest(failure.path);
      if (identity === null) {
        continue;
      }
      const stats = computeTestStats(decoded, identity.testId);
      const messageOptions = {
        tryMessages: failure.messages,
        // A timeout or a crash records no message at all
        // (`FORMATS.md`), so for those the status kind stands in for
        // one — otherwise every timeout would count as a different
        // failure from the timeout on central.
        matchAnyTimeout: failure.statuses.includes("TIMEOUT"),
        matchAnyCrash: failure.statuses.includes("CRASH")
      };
      const configs = computeConfigStats(decoded, identity.testId, messageOptions);
      const hereConfigs = computeConfigStats(decoded, identity.testId, {
        ...messageOptions,
        jobNames: failure.jobNames.map(stripChunkSuffix),
        minRecentRuns: MIN_RECENT_RUNS
      });
      const headline = pickHeadlineRate(stats, hereConfigs);
      const failCount = stats.failCount + stats.timeoutCount + stats.crashCount;
      const sameMessageFailCount = configs.reduce(
        (sum, config) => sum + config.sameMsgFailCount,
        0
      );
      const worst = configs.find((config) => config.failCount > 0) ?? null;
      const permaConfigNames = new Set(
        failure.permaFailingConfigs.map(stripChunkSuffix)
      );
      const permaConfigs = configs.filter(
        (config) => permaConfigNames.has(config.jobName)
      );
      const sameMessageFailCountOnPermaConfigs = permaConfigs.length === 0 ? null : permaConfigs.reduce((sum, config) => sum + config.sameMsgFailCount, 0);
      failure.central = {
        runCount: stats.runCount,
        failCount,
        failRate: stats.runCount > 0 ? failCount / stats.runCount * 100 : null,
        sameMessageFailCount,
        sameMessageFailRate: stats.runCount > 0 ? sameMessageFailCount / stats.runCount * 100 : null,
        sameMessageFailCountOnPermaConfigs,
        headline,
        // Over `hereConfigs`, to agree with the rates it quotes.
        explanation: flakinessTooltip(
          stats,
          hereConfigs,
          headline,
          hereConfigs.some((config) => config.sameMsgFailCount > 0),
          decoded.days ?? void 0
        ),
        configsInHistory: hereConfigs.length,
        worstConfig: worst === null ? null : {
          jobName: worst.jobName,
          failRate: worst.failRate,
          sameMsgFailRate: worst.sameMsgFailRate
        },
        known: true
      };
    }
  }
}
function attachProvenance(failures, timings, withTaskIds, withProfiles) {
  const byPath = /* @__PURE__ */ new Map();
  for (const timing of timings) {
    if (!isFailureStatus(timing.status)) {
      continue;
    }
    const list = byPath.get(timing.path) ?? [];
    list.push(timing);
    byPath.set(timing.path, list);
  }
  for (const list of byPath.values()) {
    list.sort(
      (a, b) => a.jobName.localeCompare(b.jobName) || a.taskId.localeCompare(b.taskId) || a.retryId - b.retryId
    );
  }
  for (const failure of failures) {
    const list = byPath.get(failure.path) ?? [];
    if (withTaskIds) {
      failure.taskIds = list.map((timing) => ({
        taskId: timing.taskId,
        retryId: timing.retryId,
        jobName: timing.jobName
      }));
    }
    if (withProfiles) {
      const seen = /* @__PURE__ */ new Set();
      failure.profiles = [];
      for (const timing of list) {
        const key = runKeyOf(timing);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const row = {
          taskId: timing.taskId,
          retryId: timing.retryId,
          resourceUsage: resourceUsageProfileUrl(timing.taskId, timing.retryId)
        };
        const urls = timing.profileFilenames.map(
          (filename) => testInfoArtifactUrl(timing.taskId, timing.retryId, filename)
        );
        if (urls.length > 0) {
          row.testProfiles = urls;
          row.testProfile = urls[0];
        }
        failure.profiles.push(row);
      }
    }
  }
}
function centralLine(failure) {
  const central = failure.central;
  if (central === null) {
    return "No central data for this test in the 21-day window";
  }
  if (central.failCount === 0) {
    return `Never failed on central in 21 days (0/${central.runCount} runs)`;
  }
  const overall = `${percent(central.failRate)} on central (${central.failCount}/${central.runCount})`;
  if (!failure.messageComparable) {
    return `${overall}; this push recorded no failure message, so it cannot be compared`;
  }
  return `${overall}, ${percent(central.sameMessageFailRate)} with the same message (${central.sameMessageFailCount})`;
}
function centralHeadlineLines(failure, indent) {
  const central = failure.central;
  if (central === null) {
    return [];
  }
  const where = central.headline.scope === "config" ? `on ${centralScopeCell(failure)}` : "across every configuration";
  const lines = [
    `${indent}central ${percent(central.headline.rate)} ${where} (${central.headline.runs} runs)`
  ];
  if (central.configsInHistory === 0) {
    lines.push(
      `${indent}  central never ran this test on ${failure.jobNames.length === 1 ? "the configuration" : `any of the ${failure.jobNames.length} configurations`} this push used, so the rate above is the whole-test one`
    );
  }
  for (const line of central.explanation.split("\n")) {
    lines.push(line === "" ? "" : `${indent}  ${line}`);
  }
  return lines;
}
function centralScopeCell(failure) {
  if (failure.central === null) {
    return "n/a";
  }
  const { headline } = failure.central;
  return headline.scope === "config" ? headline.jobName ?? "" : "all configs";
}
function preExistingLine(failure) {
  const central = failure.central;
  if (central === null) {
    return null;
  }
  const onPermaConfigs = central.sameMessageFailCountOnPermaConfigs;
  if (onPermaConfigs === null || onPermaConfigs === 0) {
    return null;
  }
  const configs = failure.permaFailingConfigs.length === 1 ? failure.permaFailingConfigs[0] : `the ${failure.permaFailingConfigs.length} configs it failed every run on`;
  return `Pre-existing: central already fails the same way on ${configs} (${onPermaConfigs} times in 21 days) \u2014 probably not yours.`;
}
function outcomesLine(failure) {
  const { failedTwice, passedOnRetry, failedOnce, passed, notAnalyzed } = failure.outcomes;
  const parts = [];
  const runs = (n) => `${n} run${n === 1 ? "" : "s"}`;
  if (failedTwice > 0) {
    parts.push(`${runs(failedTwice)} failed, then failed again on rerun`);
  }
  if (passedOnRetry > 0) {
    parts.push(`${runs(passedOnRetry)} failed, then passed on rerun`);
  }
  if (failedOnce > 0) {
    parts.push(`${runs(failedOnce)} failed, not rerun`);
  }
  if (passed > 0) {
    parts.push(`${runs(passed)} passed`);
  }
  if (notAnalyzed > 0) {
    parts.push(`${runs(notAnalyzed)} not read`);
  }
  return parts.length > 1 ? `    Of those runs: ${parts.join("; ")}.` : null;
}
function rerunLine(failure) {
  const configs = failure.passedOnRerunConfigs;
  if (configs.length === 0) {
    return null;
  }
  const where = configs.length === 1 ? configs[0] : `${configs.length} of them: ${configs.slice(0, 3).join(", ")}` + (configs.length > 3 ? `, +${configs.length - 3} more` : "");
  return `Passed when the harness reran it in the same job on ${where} \u2014 intermittent there.`;
}
function sameMessageCell(failure) {
  if (failure.central === null) {
    return "n/a";
  }
  if (!failure.messageComparable) {
    return "?";
  }
  return percent(failure.central.sameMessageFailRate);
}
function preExistingCell(failure) {
  if (failure.central === null || !failure.messageComparable) {
    return "\u2014";
  }
  const onPermaConfigs = failure.central.sameMessageFailCountOnPermaConfigs;
  if (onPermaConfigs === null) {
    return "\u2014";
  }
  return onPermaConfigs > 0 ? `yes (${onPermaConfigs})` : "no";
}
function universeLine(result) {
  if (result.passingTestJobCount === 0) {
    return null;
  }
  if (result.readPassingJobs) {
    return `Read ${result.profilesRead} test job profiles, including the ${result.passingTestJobCount} that passed (--all-jobs).`;
  }
  return `Read ${result.profilesRead} failed test job profiles. The ${result.passingTestJobCount} test jobs that passed were not read, so a test that failed and then passed on retry is not here; --all-jobs reads them too.`;
}
function renderTestReport(context, revision, project, testPath, timings, runsPerJobName, readPassingJobs) {
  const exact = timings.filter((timing) => timing.path === testPath);
  const matching = exact.length > 0 ? exact : timings.filter((timing) => timing.path.endsWith(`/${testPath}`));
  const resolved = new Set(matching.map((timing) => timing.path));
  const lines = [];
  if (resolved.size > 1) {
    lines.push(`${resolved.size} tests in this push end with ${testPath}:`);
    for (const path2 of [...resolved].sort()) {
      lines.push(`  ${path2}`);
    }
    lines.push("Pass one of them to --test.");
    return joinLines(lines);
  }
  const attemptsByRun = /* @__PURE__ */ new Map();
  for (const timing of matching) {
    const key = runKeyOf(timing);
    const list = attemptsByRun.get(key) ?? [];
    list.push(timing);
    attemptsByRun.set(key, list);
  }
  const byConfig = /* @__PURE__ */ new Map();
  for (const attempts of attemptsByRun.values()) {
    const jobName = attempts[0].jobName;
    let row = byConfig.get(jobName);
    if (row === void 0) {
      row = { jobName, jobs: 0, passed: 0, passedOnRetry: 0, failed: 0 };
      byConfig.set(jobName, row);
    }
    row.jobs++;
    if (!attempts.some((attempt) => isFailureStatus(attempt.status))) {
      row.passed++;
    } else if (attempts.some((attempt) => attempt.isRerun && attempt.status.startsWith("PASS"))) {
      row.passedOnRetry++;
    } else {
      row.failed++;
    }
  }
  const configs = [...byConfig.values()].sort((a, b) => a.jobName.localeCompare(b.jobName));
  const path = [...resolved][0] ?? testPath;
  if (!readPassingJobs) {
    for (const row of configs) {
      row.jobs = runsPerJobName.get(row.jobName) ?? row.jobs;
    }
  }
  if (context.globals.format === "json") {
    const json = { revision, project, test: path, readPassingJobs, configs };
    return toJson(json);
  }
  lines.push(`Try push ${revision.slice(0, 12)} (${project}) \u2014 ${path}`);
  if (!readPassingJobs) {
    lines.push(
      "Only the failed jobs were downloaded, so a pass the harness rescued on a retry is invisible here. jobs and failed are exact; the rest are bounds."
    );
  }
  lines.push(treeherderPushUrl(project, revision));
  lines.push("");
  if (configs.length === 0) {
    lines.push(
      readPassingJobs ? "No run of this test was found in any of the job profiles read. Either it did not run on this push, or the path does not match one." : 'This test failed in none of the failed jobs read. That is not the same as "it passed" and not the same as "it did not run" \u2014 neither question can be answered without --all-jobs.'
    );
    return joinLines(lines);
  }
  if (readPassingJobs) {
    lines.push("Every job run that ran this test, counted once by how it ended.");
    lines.push("");
    lines.push(
      ...table(
        [
          { header: "configuration" },
          { header: "jobs", align: "right" },
          { header: "passed", align: "right" },
          { header: "passed on retry", align: "right" },
          { header: "failed", align: "right" }
        ],
        configs.map((row) => [
          row.jobName,
          String(row.jobs),
          String(row.passed),
          String(row.passedOnRetry),
          String(row.failed)
        ])
      )
    );
    return joinLines(lines);
  }
  lines.push(
    ...table(
      [
        { header: "configuration" },
        { header: "jobs", align: "right" },
        { header: "failed", align: "right" },
        { header: "passed on retry", align: "right" },
        { header: "passed", align: "right" }
      ],
      configs.map((row) => [
        row.jobName,
        String(row.jobs),
        String(row.failed),
        `\u2265${row.passedOnRetry}`,
        `\u2264${row.jobs - row.failed - row.passedOnRetry}`
      ])
    )
  );
  return joinLines(lines);
}
function renderText8(result, limit, permaOnly, otherJobs, allMessages) {
  const lines = [];
  lines.push(
    `Try push ${result.revision.slice(0, 12)} (${result.project}) \u2014 ${result.jobCount} jobs, ${result.failedJobCount} failed`
  );
  lines.push("Compared against 21 days of mozilla-central history.");
  lines.push(universeLine(result));
  lines.push(result.treeherderUrl);
  if (result.permaFails.length === 0 && result.knownIntermittents.length === 0 && result.newIntermittents.length === 0) {
    lines.push("");
    lines.push("No test-level failures found.");
    if (result.unblamedJobCount > 0) {
      lines.push(
        `${result.unblamedJobCount} failed test jobs had no test-level failure attributed to them (harness crash, or no profile).`
      );
    }
    if (result.otherFailedJobs.length > 0) {
      lines.push(
        `${result.otherFailedJobs.length} non-test jobs failed (--other-jobs to list them).`
      );
    }
    return joinLines(lines);
  }
  lines.push("");
  lines.push(...section(
    "PERMA-FAILS",
    result.permaFails,
    PERMA_FAIL_DESCRIPTION,
    limit,
    allMessages
  ));
  if (!permaOnly) {
    lines.push("");
    lines.push(
      ...compactSection(
        "KNOWN INTERMITTENTS",
        result.knownIntermittents,
        "also fail on central; likely not yours.",
        limit
      )
    );
    lines.push("");
    lines.push(
      ...compactSection(
        "NEW INTERMITTENTS",
        result.newIntermittents,
        "failed here, never on central. Worth a look.",
        limit
      )
    );
  }
  if (result.unblamedJobCount > 0) {
    lines.push("");
    lines.push(
      `${result.unblamedJobCount} failed test jobs had no test-level failure attributed`
    );
    lines.push(
      "  to them \u2014 a harness crash, or a profile that could not be read. Check them on"
    );
    lines.push("  Treeherder; this command cannot say what failed in them.");
  }
  if (otherJobs && result.otherFailedJobs.length > 0) {
    lines.push("");
    lines.push(`OTHER FAILED JOBS (${result.otherFailedJobs.length})`);
    const shown = applyLimit(result.otherFailedJobs, limit);
    for (const job of shown) {
      lines.push(`  ${job.result.padEnd(10)} ${job.jobName}  ${job.taskId}`);
    }
    lines.push(moreLine(result.otherFailedJobs.length, shown.length));
  } else if (result.otherFailedJobs.length > 0) {
    lines.push("");
    lines.push(
      `${result.otherFailedJobs.length} non-test jobs also failed (--other-jobs to list).`
    );
  }
  return joinLines(lines);
}
function messageLines(failure, allMessages) {
  const format = (message) => `    ${truncate(message.replace(/\s*\n\s*/g, " \u23CE "), 110)}`;
  const all = failure.allMessages;
  if (allMessages) {
    const counted = new Map(all.map((entry) => [entry.message, entry.count]));
    const ordered = [...all];
    for (const message of failure.messages) {
      if (!counted.has(message)) {
        counted.set(message, 0);
        ordered.push({ message, count: 0 });
      }
    }
    if (ordered.length === 0) {
      return [];
    }
    const shown2 = ordered.slice(0, MESSAGE_CAP);
    const lines2 = shown2.map(
      (entry) => (
        // Blank rather than `0x` for a row with no per-execution count, since
        // `0x` would read as "never seen".
        `    ${(entry.count > 0 ? `${entry.count}x` : "").padStart(4)} ${truncate(
          entry.message.replace(/\s*\n\s*/g, " \u23CE "),
          106
        )}`
      )
    );
    if (ordered.length > shown2.length) {
      lines2.push(
        `    (${ordered.length - shown2.length} more messages, not shown: the cap is ${MESSAGE_CAP} per row)`
      );
    }
    return lines2;
  }
  const shown = failure.messages.slice(0, 2);
  const lines = shown.map(format);
  const union = /* @__PURE__ */ new Set([
    ...failure.messages,
    ...all.map((entry) => entry.message)
  ]);
  for (const message of shown) {
    union.delete(message);
  }
  if (union.size > 0) {
    lines.push(
      `    (+${union.size} more message${union.size === 1 ? "" : "s"} for this test; --messages to see them)`
    );
  }
  return lines;
}
function section(title, failures, description, limit, allMessages) {
  const lines = [`${title} (${failures.length}) \u2014 ${description}`];
  if (failures.length === 0) {
    lines.push("  (none)");
    return lines;
  }
  const shown = applyLimit(failures, limit);
  for (const failure of shown) {
    lines.push("");
    lines.push(`  ${failure.path}`);
    const runWord = failure.totalRuns === 1 ? "run" : "runs";
    const jobWord = failure.totalJobs === 1 ? "job run" : "job runs";
    lines.push(
      `    ${failure.failureCount} ${failure.failureCount === 1 ? "failure" : "failures"} in ${failure.totalRuns} ${runWord}, across ${failure.totalJobs} ${jobWord} on ${failure.jobNames.length === 1 ? failure.jobNames[0] : `${failure.jobNames.length} configs`}`
    );
    const outcomes = outcomesLine(failure);
    if (outcomes !== null) {
      lines.push(outcomes);
    }
    if (failure.jobNames.length > 1) {
      for (const jobName of failure.jobNames.slice(0, 4)) {
        lines.push(`      ${jobName}`);
      }
      if (failure.jobNames.length > 4) {
        lines.push(`      \u2026 ${failure.jobNames.length - 4} more configs`);
      }
    }
    if (failure.permaFailingConfigs.length > 0 && failure.permaFailingConfigs.length < failure.jobNames.length) {
      const every = failure.permaFailingConfigs;
      lines.push(
        every.length === 1 ? `    Failed every run on ${every[0]}` : `    Failed every run on ${every.length} of them: ${every.slice(0, 3).join(", ")}` + (every.length > 3 ? `, +${every.length - 3} more` : "")
      );
    }
    lines.push(...centralHeadlineLines(failure, "    "));
    lines.push(`    ${centralLine(failure)}`);
    const preExisting = preExistingLine(failure);
    if (preExisting !== null) {
      lines.push(`    ${preExisting}`);
    }
    const rerun = rerunLine(failure);
    if (rerun !== null) {
      lines.push(`    ${rerun}`);
    }
    if (failure.parallelOnly) {
      lines.push(
        "    Only failed under parallel execution \u2014 likely racing with its neighbours."
      );
    }
    lines.push(...messageLines(failure, allMessages));
    lines.push(...provenanceLines(failure, "    "));
  }
  const more = moreLine(failures.length, shown.length);
  if (more !== null) {
    lines.push(more);
  }
  return lines;
}
function compactSection(title, failures, description, limit) {
  const lines = [`${title} (${failures.length}) \u2014 ${description}`];
  if (failures.length === 0) {
    lines.push("  (none)");
    return lines;
  }
  const shown = applyLimit(failures, limit);
  const rendered = tableWithPaths(
    [
      // The column the rows are ordered by. Without it the ordering
      // is unexplained — the reader sees a list that is not
      // alphabetical and has nothing to read it against.
      { header: "#", align: "right", sort: "desc" },
      // Path-aware: the column sizes itself to the longest path here, so
      // in normal use nothing is cut at all. If one ever exceeds the cap,
      // the leading directories go rather than the filename, and the
      // recovery block below prints it whole. See `tableWithPaths()`.
      { header: "test", path: true },
      { header: "here", align: "right" },
      // Measured on the configurations this push ran, so it is
      // comparable with `here`.
      { header: "central", align: "right" },
      { header: "same msg", align: "right" }
    ],
    shown.map((failure) => [
      String(failure.failureCount),
      failure.path,
      // The page's ratio: failing EXECUTIONS over total executions
      // (`old/try.html:1798`, `site/try.ts:1409`). The numerator was
      // distinct job runs and the denominator job runs — two wrong
      // quantities that agreed with each other.
      `${failure.failureCount}/${failure.totalRuns}`,
      failure.central === null ? "n/a" : percent(failure.central.headline.rate),
      sameMessageCell(failure)
    ])
  );
  lines.push(...rendered.lines);
  for (const failure of shown) {
    lines.push(`    ${basename(failure.path)}: ${configsPhrase(failure)}`);
    if (failure.passedOnRerun) {
      lines.push("      passed on harness rerun");
    }
    lines.push(...centralHeadlineLines(failure, "      "));
    lines.push(...provenanceLines(failure, "      "));
  }
  lines.push(...fullPathLines(rendered.shortenedPaths));
  const more = moreLine(failures.length, shown.length);
  if (more !== null) {
    lines.push(more);
  }
  return lines;
}
function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}
function configsPhrase(failure) {
  const names = failure.jobNames;
  const [only] = names;
  if (names.length === 1 && only !== void 0) {
    return only;
  }
  return `${names.length} configs: ${names.slice(0, 3).join(", ")}` + (names.length > 3 ? `, +${names.length - 3} more` : "");
}
var PROVENANCE_ROWS = 5;
function provenanceLines(failure, indent) {
  const lines = [];
  if (failure.taskIds !== void 0) {
    for (const entry of failure.taskIds.slice(0, PROVENANCE_ROWS)) {
      lines.push(`${indent}task ${entry.taskId}.${entry.retryId}  ${entry.jobName}`);
    }
    const hidden = failure.taskIds.length - PROVENANCE_ROWS;
    if (hidden > 0) {
      lines.push(`${indent}\u2026 ${hidden} more task${hidden === 1 ? "" : "s"}`);
    }
  }
  if (failure.profiles !== void 0) {
    for (const entry of failure.profiles.slice(0, PROVENANCE_ROWS)) {
      lines.push(`${indent}profile ${entry.resourceUsage}`);
      for (const url of entry.testProfiles ?? []) {
        lines.push(`${indent}test profile ${url}`);
      }
    }
    const hidden = failure.profiles.length - PROVENANCE_ROWS;
    if (hidden > 0) {
      lines.push(`${indent}\u2026 ${hidden} more profile${hidden === 1 ? "" : "s"}`);
    }
  }
  return lines;
}
function renderMarkdown8(result, limit, permaOnly, otherJobs) {
  const lines = [];
  lines.push(heading(`Try push ${result.revision.slice(0, 12)} (${result.project})`, 1));
  lines.push("");
  lines.push(
    `${result.jobCount} jobs, ${result.failedJobCount} failed. Compared against 21 days of mozilla-central history.`
  );
  const universe = universeLine(result);
  if (universe !== null) {
    lines.push("");
    lines.push(`_${universe}_`);
  }
  lines.push("");
  lines.push(`[View on Treeherder](${result.treeherderUrl})`);
  const sections = permaOnly ? [["Perma-fails", result.permaFails, PERMA_FAIL_DESCRIPTION]] : [
    ["Perma-fails", result.permaFails, PERMA_FAIL_DESCRIPTION],
    ["Known intermittents", result.knownIntermittents, "Also fail on central; likely not yours."],
    ["New intermittents", result.newIntermittents, "Failed here, never on central."]
  ];
  for (const [title, failures, description] of sections) {
    lines.push("");
    lines.push(heading(`${title} (${failures.length})`));
    lines.push("");
    lines.push(`_${description}_`);
    lines.push("");
    if (failures.length === 0) {
      lines.push("None.");
      continue;
    }
    const shown = applyLimit(failures, limit);
    lines.push(
      ...table2(
        [
          // The ranking column, so a table pasted into a bug shows
          // what its order means.
          { header: "#", align: "right" },
          { header: "Test" },
          { header: "Configs", align: "right" },
          { header: "Here", align: "right" },
          { header: "Central", align: "right" },
          // A table pasted into a bug carries no tooltip, so the
          // configuration the rate was measured on has to be a column.
          { header: "Central measured on" },
          { header: "Same message", align: "right" },
          // The text renderer says this in a sentence per row. A
          // Markdown table pasted into a bug needs it just as much —
          // without it the perma-fail table reads as a list of
          // regressions, and on autoland push 7c06165ae50f70 that
          // would be 48 of 51 rows misread.
          { header: "Pre-existing?" },
          { header: "Message" }
        ],
        shown.map((failure) => [
          String(failure.failureCount),
          failure.path,
          String(failure.jobNames.length),
          `${failure.failureCount}/${failure.totalRuns}`,
          failure.central === null ? "n/a" : percent(failure.central.headline.rate),
          centralScopeCell(failure),
          sameMessageCell(failure),
          preExistingCell(failure),
          truncate(failure.messages[0] ?? "", 120)
        ])
      )
    );
    lines.push(moreLine2(failures.length, shown.length));
  }
  if (otherJobs && result.otherFailedJobs.length > 0) {
    lines.push("");
    lines.push(heading(`Other failed jobs (${result.otherFailedJobs.length})`));
    lines.push("");
    lines.push(
      ...table2(
        [{ header: "Result" }, { header: "Job" }, { header: "Task" }],
        applyLimit(result.otherFailedJobs, limit).map((job) => [
          job.result,
          job.jobName,
          job.taskId
        ])
      )
    );
  }
  return joinLines(lines);
}

// cli/main.ts
var COMMANDS = [
  {
    name: "test",
    summary: "Everything about one test: is it failing, where, and since when.",
    usage: "fx-tests test <path> [options]",
    options: TEST_OPTIONS,
    run: runTest
  },
  {
    name: "try",
    summary: "Triage a Try push: which failures are caused by the patch.",
    usage: "fx-tests try <revision> [options]",
    options: TRY_OPTIONS,
    run: runTry
  },
  {
    name: "issues",
    summary: "What is failing right now, across the tree.",
    usage: "fx-tests issues [options]",
    options: ISSUES_OPTIONS,
    run: runIssues
  },
  {
    name: "failures",
    summary: "Failing runs grouped by message \u2014 the one-bug-many-tests view.",
    usage: "fx-tests failures [options]",
    options: FAILURES_OPTIONS,
    run: runFailures
  },
  {
    name: "crashes",
    summary: "Crashes grouped by signature, with the minidumps to read them.",
    usage: "fx-tests crashes [options]",
    options: CRASHES_OPTIONS,
    run: runCrashes
  },
  {
    name: "skips",
    summary: "What is disabled and where. Excludes run-if by default.",
    usage: "fx-tests skips [options]",
    options: SKIPS_OPTIONS,
    run: runSkips
  },
  {
    name: "flaky",
    summary: "Which folder to book a flakiness burndown on, ranked. With a path, its tests.",
    usage: "fx-tests flaky [path] [options]",
    options: FLAKY_OPTIONS,
    notes: FLAKY_NOTES,
    run: runFlaky
  },
  {
    name: "intermittent",
    summary: "The sheriff-annotated top offenders, tree-wide, with bug numbers.",
    usage: "fx-tests intermittent [--harness <h>] [--bug <id>] [options]",
    options: INTERMITTENT_OPTIONS,
    extraHarnessValues: ["unknown"],
    rejectsGlobals: [
      {
        names: ["data-source"],
        message: "--data-source cannot be applied to intermittent: the ranking comes from Treeherder\u2019s sheriff annotations, which are tree-wide, and neither try nor a local directory has an equivalent of them",
        hint: "Use --tree to choose a repository, and --bug <id> to drill into one bug."
      }
    ],
    notes: INTERMITTENT_NOTES,
    run: runIntermittent
  },
  {
    name: "errors",
    summary: "What is loudest in the test logs on one day. Defaults to mochitest.",
    usage: "fx-tests errors [options]",
    options: ERRORS_OPTIONS,
    rejectsGlobals: [
      {
        names: ["since"],
        message: "--since does not apply to errors: the files are per-date, with no multi-day aggregate",
        hint: "Use --day <date> for one day, and run the command twice to compare two days."
      }
    ],
    run: runErrors
  },
  {
    name: "manifests",
    summary: "Which manifest is eating a job\u2019s time budget, and on which configs.",
    usage: "fx-tests manifests [name] [options]",
    options: MANIFESTS_OPTIONS,
    rejectsGlobals: [
      {
        names: ["day", "since"],
        message: "manifests.json covers a single day and has no day axis, so --day and --since do not apply",
        hint: "The file the index publishes is the latest one; its date is in the output header."
      }
    ],
    run: runManifests
  },
  {
    name: "crash",
    summary: "Read a processed crash or hang dump: signature, reason, thread stacks.",
    usage: "fx-tests crash <taskId>[.<retryId>] <minidumpId> [options]",
    options: CRASH_OPTIONS,
    run: runCrash
  },
  {
    name: "summary",
    summary: "The 7-day topline rates, per harness, against the prior period.",
    usage: "fx-tests summary [options]",
    options: SUMMARY_OPTIONS,
    run: runSummary
  },
  {
    name: "guide",
    summary: "What this data can and cannot tell you. Read this first.",
    usage: "fx-tests guide",
    options: GUIDE_OPTIONS,
    run: runGuide
  },
  {
    name: "dates",
    summary: "Which dates have published data.",
    usage: "fx-tests dates [options]",
    options: {},
    run: runDates
  },
  {
    name: "cache",
    summary: "Inspect or clear the on-disk cache.",
    usage: "fx-tests cache [--clear] [--size]",
    options: CACHE_OPTIONS,
    // Bound in `run()`, which is where the cache is constructed.
    run: async () => {
      throw new Error("cache is dispatched separately");
    }
  }
];
var COMMAND_NAMES = COMMANDS.map((command) => command.name);
var REJECTED_GLOBALS = Object.fromEntries(
  COMMANDS.map((command) => [
    command.name,
    (command.rejectsGlobals ?? []).flatMap((group) => group.names)
  ])
);
var PLANNED_COMMANDS = {};
var VERSION = "0.0.0";
async function run(options) {
  const { streams } = options;
  try {
    return await dispatch(options);
  } catch (error) {
    if (error instanceof CliError) {
      streams.err(`fx-tests: ${error.message}
`);
      if (error.hint !== void 0) {
        streams.err(`${error.hint}
`);
      }
      return error.exitCode;
    }
    if (error instanceof DataFileNotFoundError) {
      streams.err(`fx-tests: ${error.message}
`);
      return ExitCode.NotFound;
    }
    if (error instanceof DataFetchError) {
      streams.err(`fx-tests: ${error.message}
`);
      return ExitCode.Upstream;
    }
    if (error instanceof PushNotFoundError) {
      streams.err(`fx-tests: ${error.message}
`);
      return ExitCode.NotFound;
    }
    if (error instanceof TreeherderError) {
      streams.err(`fx-tests: ${error.message}
`);
      return ExitCode.Upstream;
    }
    if (error instanceof IntermittentsError) {
      streams.err(`fx-tests: ${error.message} from ${error.url}
`);
      return ExitCode.Upstream;
    }
    throw error;
  } finally {
    resetTruncation();
  }
}
async function dispatch(options) {
  artifactHits = 0;
  artifactMisses = 0;
  const argv = [...options.argv];
  const { streams } = options;
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    streams.out(topLevelHelp());
    return ExitCode.Success;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    streams.out(`${options.version ?? VERSION}
`);
    return ExitCode.Success;
  }
  const commandName = argv[0];
  if (commandName.startsWith("-")) {
    throw usageError(
      `expected a command, got the option ${commandName}`,
      "Usage: fx-tests <command> [options]. Run --help for the list."
    );
  }
  const command = COMMANDS.find((candidate) => candidate.name === commandName);
  if (command === void 0) {
    const planned = PLANNED_COMMANDS[commandName];
    if (planned !== void 0) {
      throw usageError(
        `\`${commandName}\` (${planned}) is specified in docs/CLI.md but not implemented yet`,
        "Implemented so far: " + COMMANDS.map((c) => c.name).join(", ") + "."
      );
    }
    throw usageError(
      `unknown command "${commandName}"`,
      "Available: " + COMMANDS.map((c) => c.name).join(", ") + ". Run --help for details."
    );
  }
  const specs = { ...GLOBAL_OPTION_SPECS, ...command.options };
  const args = parseArgs(argv.slice(1), specs);
  if (boolOption(args, "help")) {
    streams.out(commandHelp(command, specs));
    return ExitCode.Success;
  }
  const globals = readGlobalOptions(args, options.env ?? {}, command.extraHarnessValues ?? []);
  for (const rejected of command.rejectsGlobals ?? []) {
    if (rejected.names.some((name) => args.options.has(name))) {
      throw usageError(rejected.message, rejected.hint);
    }
  }
  configureTruncation({ format: globals.format, fullMessages: globals.fullMessages });
  if (globals.dataSource === "local" && options.source === void 0) {
    throw usageError(
      "--data-source local is not supported by the CLI",
      "The dashboards read ./data/ relative to the page. Use --data-source central or try."
    );
  }
  const cache = options.cache ?? diskCache(
    globals.cacheDir === void 0 ? {} : { directory: globals.cacheDir }
  );
  const context = {
    globals,
    streams,
    source: options.source ?? buildSource(globals, cache, streams),
    ...options.treeherder === void 0 ? { treeherder: buildTreeherder(globals, cache, streams, options.httpFetch ?? nodeFetch2) } : { treeherder: options.treeherder },
    ...options.intermittents === void 0 ? {
      intermittents: buildIntermittents(
        globals,
        cache,
        streams,
        options.httpFetch ?? nodeFetch2
      )
    } : { intermittents: options.intermittents },
    // Per-task artifacts keep their own **error handling** — an expired
    // artifact is exit 4 while a missing index file is exit 2, which is
    // `PLAN.md` §4's new dependency shape — but they are cached, on their
    // own terms. `cli/cache.ts` has the reasoning; the short form is that a
    // completed task's artifact is immutable, so it is a better caching
    // candidate than the nightly aggregates rather than a worse one, and
    // not caching it made `try` re-download 828 MB on every run.
    //
    // Both wrappers are skipped under `--no-cache`, and both take whatever
    // `--cache-dir` resolved to, because `cache` is the one object built
    // from those two globals.
    ...options.fetchUrl === void 0 ? {
      fetchUrl: buildArtifactFetcher(
        globals,
        cache,
        streams,
        options.httpFetchUrl ?? nodeFetchBytes
      )
    } : { fetchUrl: options.fetchUrl },
    // Injected so `fx-tests crash` is testable without a network.
    ...options.taskArtifacts === void 0 ? {
      taskArtifacts: buildTaskArtifacts(
        globals,
        cache,
        streams,
        options.httpFetch ?? nodeFetch2
      )
    } : { taskArtifacts: options.taskArtifacts },
    ...options.loadTimingFile === void 0 ? {} : { loadTimingFile: options.loadTimingFile }
  };
  if (command.name === "cache") {
    await runCache(context, args, cache);
    return ExitCode.Success;
  }
  await command.run(context, args);
  reportArtifactCacheUse(globals, streams);
  if (!globals.noCache) {
    try {
      await cache.pruneTaskArtifacts();
    } catch {
    }
  }
  return ExitCode.Success;
}
function buildArtifactFetcher(globals, cache, streams, http) {
  if (globals.noCache) {
    return http;
  }
  return cachedArtifactFetcher(http, cache, {
    onHit: () => {
      artifactHits++;
    },
    onMiss: () => {
      artifactMisses++;
    },
    onWarning: (message) => streams.err(`warning: ${message}
`)
  });
}
var artifactHits = 0;
var artifactMisses = 0;
function reportArtifactCacheUse(globals, streams) {
  const total = artifactHits + artifactMisses;
  if (total === 0 || !wantsProgress(globals)) {
    return;
  }
  streams.err(
    artifactMisses === 0 ? `All ${total} job profiles came from the cache; nothing was downloaded.
` : artifactHits === 0 ? `Downloaded ${total} job profiles; a second run will read them from the cache.
` : `Read ${artifactHits} of ${total} job profiles from the cache, downloaded ${artifactMisses}.
`
  );
}
function buildTreeherder(globals, cache, streams, http) {
  const client = treeherderClient({ fetch: http });
  if (globals.noCache) {
    return client;
  }
  return cachedTreeherderJobs(client, cache, {
    onWarning: (message) => streams.err(`warning: ${message}
`)
  });
}
function buildIntermittents(globals, cache, streams, http) {
  const client = intermittentsClient({ fetch: http });
  if (globals.noCache) {
    return client;
  }
  return cachedIntermittents(client, cache, {
    onWarning: (message) => streams.err(`warning: ${message}
`)
  });
}
function buildTaskArtifacts(globals, cache, streams, http) {
  const source = taskArtifactSource({ fetch: http });
  if (globals.noCache) {
    return source;
  }
  return cachedTaskArtifactSource(source, cache, (name) => taskArtifactUrl2(name), {
    onWarning: (message) => streams.err(`warning: ${message}
`)
  });
}
function buildSource(globals, cache, streams) {
  const http = httpSource({
    fetch: nodeFetch2,
    repository: globals.dataSource === "try" ? "try" : "mozilla-central"
  });
  if (globals.noCache) {
    return http;
  }
  return cachedSource(http, cache, {
    onMiss: wantsProgress(globals) ? (name) => streams.err(`Fetching ${name.filename}\u2026
`) : void 0,
    onWarning: (message) => streams.err(`warning: ${message}
`)
  });
}
async function nodeFetch2(url) {
  const response = await fetch(url);
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    arrayBuffer: () => response.arrayBuffer()
  };
}
async function nodeFetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  return new Uint8Array(await response.arrayBuffer());
}
function topLevelHelp() {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const lines = [
    "fx-tests \u2014 command-line access to the Firefox test-health data",
    "",
    "Usage: fx-tests <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    // Omitted entirely when everything `CLI.md` documents has landed, which
    // it now has. An empty "Planned:" heading reads as a rendering fault.
    ...Object.keys(PLANNED_COMMANDS).length === 0 ? [] : ["", "Planned (docs/CLI.md, not implemented yet):", `  ${Object.keys(PLANNED_COMMANDS).join(", ")}`],
    "",
    "New here? Run `fx-tests guide` \u2014 it covers what this data cannot tell you.",
    "Run `fx-tests <command> --help` for a command\u2019s options.",
    "Global options are documented in docs/CLI.md.",
    ""
  ];
  return lines.join("\n");
}
function commandHelp(command, specs) {
  const rejected = new Set(
    (command.rejectsGlobals ?? []).flatMap((group) => group.names)
  );
  const names = Object.entries(specs).filter(([name]) => !rejected.has(name)).map(([name, spec]) => {
    const placeholder = spec.placeholder === void 0 ? "" : ` ${spec.placeholder}`;
    return { flag: `--${name}${placeholder}`, describe: spec.describe };
  });
  const width = Math.max(...names.map((entry) => entry.flag.length));
  return [
    `${command.usage}`,
    "",
    command.summary,
    "",
    "Options:",
    ...names.map((entry) => `  ${entry.flag.padEnd(width)}  ${entry.describe}`),
    // The standing definitions, for a command that would otherwise print
    // them on every run. See `CommandSpec.notes`.
    ...command.notes === void 0 ? [] : ["", ...command.notes],
    "",
    `Cache: ${defaultCacheDir()}`,
    ""
  ].join("\n");
}

// cli/bin/fx-tests.ts
var exitCode = await run({
  argv: process.argv.slice(2),
  env: process.env,
  streams: {
    out(text) {
      process.stdout.write(text);
    },
    err(text) {
      process.stderr.write(text);
    }
  }
});
process.exitCode = exitCode;
//# sourceMappingURL=fx-tests.js.map
