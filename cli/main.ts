/**
 * Command dispatch, and the process-level concerns `bin/fx-tests.ts` needs but
 * commands must not have.
 *
 * Split from `bin/` so that `run()` is callable from a test with injected
 * streams and an injected `DataSource`, and returns an exit code rather than
 * calling `process.exit`. Every command test in this repo goes through here,
 * which is what makes the dispatch, the global-option validation and the exit
 * codes tested rather than merely present.
 */

import { GLOBAL_OPTION_SPECS, readGlobalOptions } from './options.ts';
import { type OptionSpecs, parseArgs, boolOption } from './args.ts';
import {
    type DiskCache,
    cachedArtifactFetcher,
    cachedIntermittents,
    cachedSource,
    cachedTaskArtifactSource,
    cachedTreeherderJobs,
    defaultCacheDir,
    diskCache,
} from './cache.ts';
import type { CommandContext, OutputStreams } from './context.ts';
import { wantsProgress } from './context.ts';
import { configureTruncation, resetTruncation } from './format/text.ts';
import { CliError, ExitCode, type ExitCodeValue, usageError } from './errors.ts';
import { CACHE_OPTIONS, runCache } from './commands/cache.ts';
import { CRASH_OPTIONS, runCrash } from './commands/crash.ts';
import { runDates } from './commands/dates.ts';
import { ERRORS_OPTIONS, runErrors } from './commands/errors.ts';
import { FLAKY_NOTES, FLAKY_OPTIONS, runFlaky } from './commands/flaky.ts';
import { GUIDE_OPTIONS, runGuide } from './commands/guide.ts';
import {
    CRASHES_OPTIONS,
    FAILURES_OPTIONS,
    ISSUES_NOTES,
    ISSUES_OPTIONS,
    SKIPS_OPTIONS,
    runCrashes,
    runFailures,
    runIssues,
    runSkips,
} from './commands/issues.ts';
import {
    INTERMITTENT_NOTES,
    INTERMITTENT_OPTIONS,
    runIntermittent,
} from './commands/intermittent.ts';
import { MANIFESTS_OPTIONS, runManifests } from './commands/manifests.ts';
import { SUMMARY_OPTIONS, runSummary } from './commands/summary.ts';
import { TEST_OPTIONS, runTest } from './commands/test.ts';
import { TASK_OPTIONS, runTask } from './commands/task.ts';
import { TRY_NOTES, TRY_OPTIONS, runTry } from './commands/try.ts';
import { IntermittentsError, intermittentsClient } from '../lib/sources/intermittents.ts';
import { LandingJobNotFoundError, LandoError, landoClient } from '../lib/sources/lando.ts';
import {
    DataFetchError,
    DataFileNotFoundError,
    type DataSource,
} from '../lib/sources/source.ts';
import { type FetchLike, httpSource, taskArtifactSource, taskArtifactUrl } from '../lib/sources/http.ts';
import { PushNotFoundError, TreeherderError, treeherderClient } from '../lib/sources/treeherder.ts';

/** Globals a command refuses unconditionally, and what it says instead. */
interface RejectedGlobals {
    /** Long names, without the leading dashes. */
    names: readonly string[];
    message: string;
    hint: string;
}

/** One command's registration. */
interface CommandSpec {
    name: string;
    summary: string;
    usage: string;
    options: OptionSpecs;
    /** Globals this command refuses: omitted from `--help`, refused by `dispatch()`. */
    rejectsGlobals?: readonly RejectedGlobals[];
    /**
     * Extra `--harness` values this command accepts beyond the two harnesses.
     *
     * Only `intermittent`, which classifies a bug as mochitest, xpcshell or
     * `unknown` and takes the third on the same flag rather than on a second
     * one. Declared here so the shared validator does not reject it first.
     */
    extraHarnessValues?: readonly string[];
    /**
     * Standing definitions printed after the options, for a command whose output
     * would otherwise have to carry them on every run.
     *
     * Only `flaky` has these today. Its preamble had grown to 13 of 24 lines —
     * definitions of "flaky" and "skipped", why the window is a whole number of
     * weeks, that two columns overlap — none of which varies between two
     * invocations, so a reader wants them once and the primary consumer here is
     * an agent that pays for them every time. `--help` is where a reader asks
     * for them once.
     */
    notes?: readonly string[];
    run(context: CommandContext, args: ReturnType<typeof parseArgs>): Promise<void>;
}

/** Commands implemented in step 4. Step 5 adds the rest. */
const COMMANDS: CommandSpec[] = [
    {
        name: 'test',
        summary: 'Everything about one test: is it failing, where, and since when.',
        usage: 'fx-tests test <path> [options]',
        options: TEST_OPTIONS,
        run: runTest,
    },
    {
        name: 'try',
        summary: 'Triage a Try push: which failures are caused by the patch.',
        usage: 'fx-tests try <revision|treeherder-url|landoCommitID> [options]',
        options: TRY_OPTIONS,
        notes: TRY_NOTES,
        run: runTry,
    },
    {
        name: 'task',
        // "What happened", not "what failed": the command reports every
        // outcome the profile recorded — the header counts PASS, SKIP and
        // EXPECTED-FAIL alongside the failures, and `--passed` lists them —
        // so a summary saying "failed" is narrower than the command.
        summary: 'What happened in one job, read from its resource-usage profile.',
        usage: 'fx-tests task <taskId>[.<retryId>] [options]',
        options: TASK_OPTIONS,
        rejectsGlobals: [
            {
                names: ['day', 'since', 'harness', 'data-source'],
                message:
                    'these globals do not apply to task: the report is one job’s profile, ' +
                    'so there is no date window to choose, no harness to select and no ' +
                    'aggregate to read it from',
                hint: 'The job’s date, harness and repository are facts about the task ID you ' +
                    'passed. For the aggregates, use `fx-tests test <path>`.',
            },
            {
                // Declared rather than thrown from the command body, which is
                // what the other commands refusing `--config` do and what left
                // both flags listed in `task --help` while the command exited 1
                // on them. Declaring it is what makes `commandHelp()` filter
                // them out, so the help stops promising flags that do not work.
                names: ['config', 'exclude-config'],
                message:
                    '--config cannot be applied to task: a task is one configuration, so ' +
                    'there is nothing here to filter',
                hint: 'The configuration is named in the header. For one test across ' +
                    'configurations, use `fx-tests test <path> --config <substring>`.',
            },
        ],
        run: runTask,
    },
    {
        name: 'issues',
        summary: 'What is failing right now, across the tree.',
        usage: 'fx-tests issues [options]',
        options: ISSUES_OPTIONS,
        notes: ISSUES_NOTES,
        run: runIssues,
    },
    {
        name: 'failures',
        summary: 'Failing runs grouped by message — the one-bug-many-tests view.',
        usage: 'fx-tests failures [options]',
        options: FAILURES_OPTIONS,
        run: runFailures,
    },
    {
        name: 'crashes',
        summary: 'Crashes grouped by signature, with the minidumps to read them.',
        usage: 'fx-tests crashes [options]',
        options: CRASHES_OPTIONS,
        run: runCrashes,
    },
    {
        name: 'skips',
        summary: 'What is disabled and where. Excludes run-if by default.',
        usage: 'fx-tests skips [options]',
        options: SKIPS_OPTIONS,
        run: runSkips,
    },
    {
        name: 'flaky',
        summary: 'Which folder to book a flakiness burndown on, ranked. With a path, its tests.',
        usage: 'fx-tests flaky [path] [options]',
        options: FLAKY_OPTIONS,
        notes: FLAKY_NOTES,
        run: runFlaky,
    },
    {
        name: 'intermittent',
        summary: 'The sheriff-annotated top offenders, tree-wide, with bug numbers.',
        usage: 'fx-tests intermittent [--harness <h>] [--bug <id>] [options]',
        options: INTERMITTENT_OPTIONS,
        extraHarnessValues: ['unknown'],
        rejectsGlobals: [
            {
                names: ['data-source'],
                message:
                    '--data-source cannot be applied to intermittent: the ranking comes from ' +
                    'Treeherder’s sheriff annotations, which are tree-wide, and neither try nor a ' +
                    'local directory has an equivalent of them',
                hint: 'Use --tree to choose a repository, and --bug <id> to drill into one bug.',
            },
        ],
        notes: INTERMITTENT_NOTES,
        run: runIntermittent,
    },
    {
        name: 'errors',
        summary: 'What is loudest in the test logs on one day. Defaults to mochitest.',
        usage: 'fx-tests errors [options]',
        options: ERRORS_OPTIONS,
        rejectsGlobals: [
            {
                names: ['since'],
                message:
                    '--since does not apply to errors: the files are per-date, with no multi-day aggregate',
                hint: 'Use --day <date> for one day, and run the command twice to compare two days.',
            },
        ],
        run: runErrors,
    },
    {
        name: 'manifests',
        summary: 'Which manifest is eating a job’s time budget, and on which configs.',
        usage: 'fx-tests manifests [name] [options]',
        options: MANIFESTS_OPTIONS,
        rejectsGlobals: [
            {
                names: ['day', 'since'],
                message:
                    'manifests.json covers a single day and has no day axis, so --day and --since do not apply',
                hint: 'The file the index publishes is the latest one; its date is in the output header.',
            },
        ],
        run: runManifests,
    },
    {
        name: 'crash',
        summary: 'Read a processed crash or hang dump: signature, reason, thread stacks.',
        usage: 'fx-tests crash <taskId>[.<retryId>] <minidumpId> [options]',
        options: CRASH_OPTIONS,
        run: runCrash,
    },
    {
        name: 'summary',
        summary: 'The 7-day topline rates, per harness, against the prior period.',
        usage: 'fx-tests summary [options]',
        options: SUMMARY_OPTIONS,
        run: runSummary,
    },
    {
        name: 'guide',
        summary: 'What this data can and cannot tell you. Read this first.',
        usage: 'fx-tests guide',
        options: GUIDE_OPTIONS,
        run: runGuide,
    },
    {
        name: 'dates',
        summary: 'Which dates have published data.',
        usage: 'fx-tests dates [options]',
        options: {},
        run: runDates,
    },
    {
        name: 'cache',
        summary: 'Inspect or clear the on-disk cache.',
        usage: 'fx-tests cache [--clear] [--size]',
        options: CACHE_OPTIONS,
        // Bound in `run()`, which is where the cache is constructed.
        run: async () => {
            throw new Error('cache is dispatched separately');
        },
    },
];

/**
 * Every implemented command's name.
 *
 * Exported so `test/framing.test.ts` can drive its completeness check off the
 * real list rather than a copy: a command that lands without a framing entry —
 * without anyone having decided whether it has a corresponding dashboard page —
 * is exactly what that check exists to catch, and a hand-maintained list in the
 * test would not catch it.
 */
export const COMMAND_NAMES: readonly string[] = COMMANDS.map((command) => command.name);

/** Which globals each command refuses, by command name. For the tests. */
export const REJECTED_GLOBALS: Record<string, readonly string[]> = Object.fromEntries(
    COMMANDS.map((command) => [
        command.name,
        (command.rejectsGlobals ?? []).flatMap((group) => group.names),
    ])
);

/**
 * Commands `CLI.md` specifies that step 5 will add.
 *
 * Exported so a test can assert the *behaviour* — a documented but unlanded
 * command says so rather than "unknown command" — without naming a specific
 * one. A test pinned to a name fails the day someone implements it, which is
 * the wrong signal entirely; this list shrank twice while step 4 was being
 * reviewed.
 */
export const PLANNED_COMMANDS: Record<string, string> = {};

/** What `run()` needs from its caller. */
export interface RunOptions {
    argv: readonly string[];
    streams: OutputStreams;
    /**
     * Overrides the data source. Tests pass a `memorySource`; the real CLI
     * leaves it undefined and gets an HTTP source wrapped in the disk cache.
     */
    source?: DataSource | undefined;
    /** Overrides the cache, for tests and for `--cache-dir`. */
    cache?: DiskCache | undefined;
    /** Overrides Treeherder, for `fx-tests try` tests. */
    treeherder?: CommandContext['treeherder'];
    /** Overrides Lando, for the `fx-tests try <landoCommitID>` tests. */
    lando?: CommandContext['lando'];
    /** Overrides the intermittents API, for `fx-tests intermittent` tests. */
    intermittents?: CommandContext['intermittents'];
    /**
     * Replaces per-URL artifact fetching outright, cache and all.
     *
     * What most `fx-tests try` tests want: they are asserting on
     * classification, not on caching, and a fetcher handed in here is the one
     * the command calls.
     */
    fetchUrl?: CommandContext['fetchUrl'];
    /**
     * Replaces only the **HTTP** half of artifact fetching, leaving the disk
     * cache in place above it.
     *
     * The seam that makes the caching itself testable. `fetchUrl` above cannot
     * do it: overriding the whole thing removes the cache, so a test using it
     * proves nothing about whether a warm run re-downloads — which is the
     * regression this exists to pin. Production leaves it unset and gets
     * Node's `fetch`.
     */
    httpFetchUrl?: ((url: string) => Promise<Uint8Array | null>) | undefined;
    /**
     * Replaces Node's `fetch` underneath everything the CLI builds itself,
     * leaving each wrapper's caching in place.
     *
     * The same seam as `httpFetchUrl` for the sources that take a `FetchLike`
     * rather than a URL fetcher: `fx-tests crash`'s artifact source and
     * Treeherder. `taskArtifacts` and `treeherder` above replace the whole
     * object and so remove the cache with it, which is fine for a test about
     * what a command *computes* and useless for one about what it *fetches*.
     */
    httpFetch?: FetchLike | undefined;
    /** Overrides the per-task artifact source, for `fx-tests crash` tests. */
    taskArtifacts?: CommandContext['taskArtifacts'];
    /**
     * Test-only: overrides how `fx-tests test` loads a timing file.
     *
     * See `LoadedTimingFile` in `cli/context.ts`. Production leaves it unset.
     */
    loadTimingFile?: CommandContext['loadTimingFile'];
    /**
     * The environment the agent check reads. Defaults to **empty**, not
     * `process.env`: the tests call `run()` in-process, so the ambient one would
     * make the progress assertions fail under a coding agent and pass for a
     * human. The entry point passes the real one.
     */
    env?: Record<string, string | undefined> | undefined;
    /** The version reported by `--version`. */
    version?: string | undefined;
}

/** The package version, as `--version` reports it. */
export const VERSION = '0.0.0';

/**
 * Runs one invocation and returns its exit code.
 *
 * Never throws for an expected failure: a `CliError` becomes a message on
 * stderr and its code. An unexpected error is re-thrown with its stack, since
 * that is a bug and a stack is what a bug report needs.
 */
export async function run(options: RunOptions): Promise<ExitCodeValue> {
    const { streams } = options;
    try {
        return await dispatch(options);
    } catch (error) {
        if (error instanceof CliError) {
            streams.err(`fx-tests: ${error.message}\n`);
            if (error.hint !== undefined) {
                streams.err(`${error.hint}\n`);
            }
            return error.exitCode;
        }
        // The library's error types carry the same distinction `CLI.md`'s exit
        // codes do, so they are mapped here rather than caught in every
        // command. A 404 on an index file is data that was never published
        // (exit 2); a transport failure or a 5xx is "try again" (exit 3).
        if (error instanceof DataFileNotFoundError) {
            streams.err(`fx-tests: ${error.message}\n`);
            return ExitCode.NotFound;
        }
        if (error instanceof DataFetchError) {
            streams.err(`fx-tests: ${error.message}\n`);
            return ExitCode.Upstream;
        }
        // A Lando ID that does not exist is an answer, not a fault: exit 2,
        // the same code a revision with no push gets.
        if (error instanceof LandingJobNotFoundError) {
            streams.err(`fx-tests: ${error.message}\n`);
            return ExitCode.NotFound;
        }
        if (error instanceof LandoError) {
            streams.err(`fx-tests: ${error.message}\n`);
            return ExitCode.Upstream;
        }
        if (error instanceof PushNotFoundError) {
            streams.err(`fx-tests: ${error.message}\n`);
            return ExitCode.NotFound;
        }
        if (error instanceof TreeherderError) {
            streams.err(`fx-tests: ${error.message}\n`);
            return ExitCode.Upstream;
        }
        // A last resort: `fx-tests intermittent` maps these itself, since a 400
        // there means an unknown tree and is exit 1. One reaching here is a
        // transport or parse failure on a request the command did not wrap.
        if (error instanceof IntermittentsError) {
            streams.err(`fx-tests: ${error.message} from ${error.url}\n`);
            return ExitCode.Upstream;
        }
        throw error;
    } finally {
        // Load-bearing: `run()` is called many times in one process, and left
        // set, a `--markdown` run turns truncation off for every run after it.
        resetTruncation();
    }
}

/** Parses, builds the context, and hands off to a command. */
async function dispatch(options: RunOptions): Promise<ExitCodeValue> {
    artifactHits = 0;
    artifactMisses = 0;
    const argv = [...options.argv];
    const { streams } = options;

    // `--version` and a bare `--help` are answered before a command is
    // required, because both are reasonable things to ask with no command.
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
        streams.out(topLevelHelp());
        return ExitCode.Success;
    }
    if (argv[0] === '--version' || argv[0] === '-v') {
        streams.out(`${options.version ?? VERSION}\n`);
        return ExitCode.Success;
    }

    const commandName = argv[0]!;
    if (commandName.startsWith('-')) {
        throw usageError(
            `expected a command, got the option ${commandName}`,
            'Usage: fx-tests <command> [options]. Run --help for the list.'
        );
    }

    const command = COMMANDS.find((candidate) => candidate.name === commandName);
    if (command === undefined) {
        const planned = PLANNED_COMMANDS[commandName];
        if (planned !== undefined) {
            // A command `CLI.md` documents but that is not built yet gets its
            // own message. "Unknown command" would be wrong — the user read
            // the spec correctly — and would send them looking for a typo.
            throw usageError(
                `\`${commandName}\` (${planned}) is specified in docs/CLI.md but not implemented yet`,
                'Implemented so far: ' + COMMANDS.map((c) => c.name).join(', ') + '.'
            );
        }
        throw usageError(
            `unknown command "${commandName}"`,
            'Available: ' + COMMANDS.map((c) => c.name).join(', ') + '. Run --help for details.'
        );
    }

    const specs: OptionSpecs = { ...GLOBAL_OPTION_SPECS, ...command.options };
    const args = parseArgs(argv.slice(1), specs);

    if (boolOption(args, 'help')) {
        streams.out(commandHelp(command, specs));
        return ExitCode.Success;
    }

    const globals = readGlobalOptions(args, options.env ?? {}, command.extraHarnessValues ?? []);

    // Must stay after `readGlobalOptions`, which validates every global's value:
    // refusing first masks a typo'd `--harness` behind a complaint about an
    // unrelated flag the caller may not have meant to pass. Nothing is fetched
    // in between, so moving it earlier buys nothing.
    for (const rejected of command.rejectsGlobals ?? []) {
        if (rejected.names.some((name) => args.options.has(name))) {
            throw usageError(rejected.message, rejected.hint);
        }
    }

    configureTruncation({ format: globals.format, fullMessages: globals.fullMessages });

    if (globals.dataSource === 'local' && options.source === undefined) {
        // Deliberately refused rather than silently reading `./data/`: the
        // dashboards' `?data-source=local` reads files served next to the
        // page, which has no CLI equivalent, and guessing a directory would
        // read someone else's data without saying so.
        throw usageError(
            '--data-source local is not supported by the CLI',
            'The dashboards read ./data/ relative to the page. Use --data-source central or try.'
        );
    }

    const cache =
        options.cache ??
        diskCache(
            globals.cacheDir === undefined ? {} : { directory: globals.cacheDir }
        );

    const context: CommandContext = {
        globals,
        streams,
        source: options.source ?? buildSource(globals, cache, streams),
        ...(options.treeherder === undefined
            ? { treeherder: buildTreeherder(globals, cache, streams, options.httpFetch ?? nodeFetch) }
            : { treeherder: options.treeherder }),
        ...(options.lando === undefined
            ? { lando: landoClient({ fetch: options.httpFetch ?? nodeFetch }) }
            : { lando: options.lando }),
        ...(options.intermittents === undefined
            ? {
                  intermittents: buildIntermittents(
                      globals,
                      cache,
                      streams,
                      options.httpFetch ?? nodeFetch
                  ),
              }
            : { intermittents: options.intermittents }),
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
        ...(options.fetchUrl === undefined
            ? {
                  fetchUrl: buildArtifactFetcher(
                      globals,
                      cache,
                      streams,
                      options.httpFetchUrl ?? nodeFetchBytes
                  ),
              }
            : { fetchUrl: options.fetchUrl }),
        // Injected so `fx-tests crash` is testable without a network.
        ...(options.taskArtifacts === undefined
            ? {
                  taskArtifacts: buildTaskArtifacts(
                      globals,
                      cache,
                      streams,
                      options.httpFetch ?? nodeFetch
                  ),
              }
            : { taskArtifacts: options.taskArtifacts }),
        ...(options.loadTimingFile === undefined
            ? {}
            : { loadTimingFile: options.loadTimingFile }),
    };

    if (command.name === 'cache') {
        await runCache(context, args, cache);
        return ExitCode.Success;
    }

    await command.run(context, args);
    reportArtifactCacheUse(globals, streams);

    // Task artifacts are the only entries nothing supersedes — a new push adds
    // 46 more profiles rather than replacing any — so the budget is enforced
    // here, after the answer has been printed. Deliberately after: eviction is
    // housekeeping, and a full or read-only cache directory must not turn a
    // successful command into a failure.
    if (!globals.noCache) {
        try {
            await cache.pruneTaskArtifacts();
        } catch {
            // Same reasoning as a failed cache write: slower, not broken.
        }
    }
    return ExitCode.Success;
}

/**
 * The per-URL artifact fetcher `fx-tests try` uses, cached unless
 * `--no-cache`.
 *
 * The progress line names the task rather than the URL: 46 of these scroll
 * past and the 90-character queue prefix is the same on every one.
 */
function buildArtifactFetcher(
    globals: ReturnType<typeof readGlobalOptions>,
    cache: DiskCache,
    streams: OutputStreams,
    http: (url: string) => Promise<Uint8Array | null>
): (url: string) => Promise<Uint8Array | null> {
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
        onWarning: (message) => streams.err(`warning: ${message}\n`),
    });
}

/**
 * How many artifacts this run read from disk, and how many it downloaded.
 *
 * Module state, which is worth justifying rather than leaving as a smell:
 * `run()` is single-invocation per process and the counters are reset at the
 * top of `dispatch()`, so the alternative — threading a counter through
 * `CommandContext` into `try.ts` — would add a field to the interface every
 * command shares in order to report on something only one of them does.
 */
let artifactHits = 0;
let artifactMisses = 0;

/**
 * Says where this run's artifacts came from, once the answer is known.
 *
 * The progress line cannot: it is printed before the first fetch, so it says
 * "Reading 46 job profiles" whether they come from the network or from disk.
 * Saying which afterwards is what answers "is the cache working?" without
 * anyone having to instrument a fetch — the question this whole change was
 * reported as.
 *
 * Silent when nothing was read, so every other command is unaffected.
 */
function reportArtifactCacheUse(globals: ReturnType<typeof readGlobalOptions>, streams: OutputStreams): void {
    const total = artifactHits + artifactMisses;
    if (total === 0 || !wantsProgress(globals)) {
        return;
    }
    streams.err(
        artifactMisses === 0
            ? `All ${total} job profiles came from the cache; nothing was downloaded.\n`
            : artifactHits === 0
              ? `Downloaded ${total} job profiles; a second run will read them from the cache.\n`
              : `Read ${artifactHits} of ${total} job profiles from the cache, ` +
                `downloaded ${artifactMisses}.\n`
    );
}

/**
 * Treeherder, with a **settled** push's job list cached unless `--no-cache`.
 *
 * Only the job list, and only once every job of the push has finished. See
 * `cachedTreeherderJobs` for why the push lookup is left uncached and why the
 * condition is settledness rather than a TTL.
 */
function buildTreeherder(
    globals: ReturnType<typeof readGlobalOptions>,
    cache: DiskCache,
    streams: OutputStreams,
    http: FetchLike
): NonNullable<CommandContext['treeherder']> {
    const client = treeherderClient({ fetch: http });
    if (globals.noCache) {
        return client;
    }
    return cachedTreeherderJobs(client, cache, {
        onWarning: (message) => streams.err(`warning: ${message}\n`),
    });
}

/**
 * Treeherder's intermittents endpoints and Bugzilla, cached unless
 * `--no-cache`.
 *
 * Cached on a one-hour TTL rather than the aggregates' twelve: these are live
 * queries with no `generatedAt` to key on. See `QUERY_KIND` in `cli/cache.ts`.
 */
function buildIntermittents(
    globals: ReturnType<typeof readGlobalOptions>,
    cache: DiskCache,
    streams: OutputStreams,
    http: FetchLike
): NonNullable<CommandContext['intermittents']> {
    const client = intermittentsClient({ fetch: http });
    if (globals.noCache) {
        return client;
    }
    return cachedIntermittents(client, cache, {
        onWarning: (message) => streams.err(`warning: ${message}\n`),
    });
}

/** The `fx-tests crash` artifact source, cached unless `--no-cache`. */
function buildTaskArtifacts(
    globals: ReturnType<typeof readGlobalOptions>,
    cache: DiskCache,
    streams: OutputStreams,
    http: FetchLike
): DataSource {
    const source = taskArtifactSource({ fetch: http });
    if (globals.noCache) {
        return source;
    }
    // Keyed on the URL the source would have fetched, built by the source's
    // own function so the two cannot drift apart.
    return cachedTaskArtifactSource(source, cache, (name) => taskArtifactUrl(name), {
        onWarning: (message) => streams.err(`warning: ${message}\n`),
    });
}

/** The real data source: HTTP, wrapped in the disk cache unless `--no-cache`. */
function buildSource(
    globals: ReturnType<typeof readGlobalOptions>,
    cache: DiskCache,
    streams: OutputStreams
): DataSource {
    const http = httpSource({
        fetch: nodeFetch,
        repository: globals.dataSource === 'try' ? 'try' : 'mozilla-central',
    });
    if (globals.noCache) {
        return http;
    }
    return cachedSource(http, cache, {
        onMiss: wantsProgress(globals)
            ? (name) => streams.err(`Fetching ${name.filename}…\n`)
            : undefined,
        onWarning: (message) => streams.err(`warning: ${message}\n`),
    });
}

/** Node's `fetch`, narrowed to the `FetchLike` the library takes. */
async function nodeFetch(url: string): Promise<{
    ok: boolean;
    status: number;
    url: string;
    arrayBuffer(): Promise<ArrayBuffer>;
}> {
    const response = await fetch(url);
    return {
        ok: response.ok,
        status: response.status,
        url: response.url,
        arrayBuffer: () => response.arrayBuffer(),
    };
}

/** Fetches a URL's bytes, or `null` on 404. For `fx-tests try`'s profiles. */
async function nodeFetchBytes(url: string): Promise<Uint8Array | null> {
    const response = await fetch(url);
    if (!response.ok) {
        return null;
    }
    return new Uint8Array(await response.arrayBuffer());
}

/** The top-level `--help` text. */
export function topLevelHelp(): string {
    const width = Math.max(...COMMANDS.map((c) => c.name.length));
    const lines = [
        'fx-tests — command-line access to the Firefox test-health data',
        '',
        'Usage: fx-tests <command> [options]',
        '',
        'Commands:',
        ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
        // Omitted entirely when everything `CLI.md` documents has landed, which
        // it now has. An empty "Planned:" heading reads as a rendering fault.
        ...(Object.keys(PLANNED_COMMANDS).length === 0
            ? []
            : ['', 'Planned (docs/CLI.md, not implemented yet):', `  ${Object.keys(PLANNED_COMMANDS).join(', ')}`]),
        '',
        'New here? Run `fx-tests guide` — it covers what this data cannot tell you.',
        'Run `fx-tests <command> --help` for a command’s options.',
        'Global options are documented in docs/CLI.md.',
        '',
    ];
    return lines.join('\n');
}

/** One command's `--help` text. */
function commandHelp(command: CommandSpec, specs: OptionSpecs): string {
    const rejected = new Set(
        (command.rejectsGlobals ?? []).flatMap((group) => group.names)
    );
    const names = Object.entries(specs)
        .filter(([name]) => !rejected.has(name))
        .map(([name, spec]) => {
        const placeholder = spec.placeholder === undefined ? '' : ` ${spec.placeholder}`;
        return { flag: `--${name}${placeholder}`, describe: spec.describe };
    });
    const width = Math.max(...names.map((entry) => entry.flag.length));
    return [
        `${command.usage}`,
        '',
        command.summary,
        '',
        'Options:',
        ...names.map((entry) => `  ${entry.flag.padEnd(width)}  ${entry.describe}`),
        // The standing definitions, for a command that would otherwise print
        // them on every run. See `CommandSpec.notes`.
        ...(command.notes === undefined ? [] : ['', ...command.notes]),
        '',
        `Cache: ${defaultCacheDir()}`,
        '',
    ].join('\n');
}
