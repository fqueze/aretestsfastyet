/**
 * `fx-tests guide` — orientation for an agent, in one read.
 *
 * The reason this exists is that the traps in this data are not discoverable
 * from `--help`. That the errors files are per-date with no aggregate, that a
 * manifest's all-zero durations mean skipped rather than instant, that
 * `issues.json` cannot attribute a failure to a configuration, that a test's
 * overall failure rate understates a single-config perma-fail: an agent that
 * reads this first stops re-deriving them, and one that does not will
 * confidently get them wrong.
 *
 * ## Why the facts are data and the prose is not
 *
 * `CLI.md` is explicit, and it is the whole design of this file:
 *
 * > **Its factual claims should be test assertions, not prose to remember to
 * > update.** "Review it when caveats change" is the mitigation that always
 * > fails.
 *
 * So everything mechanically checkable — which command reads which file, that
 * `errors` defaults to mochitest, what each exit code means, which flags exist
 * — lives in the exported tables below rather than in a string. `test/guide.test.ts`
 * asserts each entry against the **behaviour**: it dispatches the command, reads
 * the real option specs, compares against `ExitCode`. A guide that drifts from
 * the code fails the suite rather than quietly misleading a reader.
 *
 * What stays hand-written is the part no test can check: why a trap matters,
 * and how to approach an investigation. That prose is the reason to have a
 * guide at all — it is also the part that goes stale most slowly, because it
 * describes the shape of the data rather than the shape of the code.
 *
 * ## Properties, not snapshots
 *
 * A first version of this file ran to 242 lines and documented **the state of
 * the deployment on the day it was written**: that the errors files existed for
 * "about 5 of the 21 dates", that a measured day had 71,272 zero durations out
 * of 433,836, that `run-if` skips were 63.6% of one day's total. Every one of
 * those drifts, none of them would ever be updated, and the review that caught
 * it put the objection exactly right: the error-file generator had landed five
 * days earlier, so what?
 *
 * A fact that will be wrong next month is worse in a guide than a fact left
 * out, because the guide's whole claim on the reader is that it is the thing to
 * trust first. So the rule applied throughout is:
 *
 *  - **State the shape, not the measurement.** "Errors data covers fewer days
 *    than the timing data" is durable; "about five of twenty-one" is a reading.
 *  - **Where a number must be current, get it at runtime.** `fx-tests errors`
 *    discovers and prints its own window, so the guide points at the command
 *    instead of quoting it.
 *  - **Keep implementation detail only where it changes what the reader does.**
 *    Which JSON file a command opens is internal. That `test` reads one small
 *    per-test file is worth saying, because it is why `--day` is free.
 *
 * The traps that survived are the ones `CLI.md` names as the reason `guide`
 * exists: they are not discoverable from `--help`, they have been got wrong in
 * practice, and each is a property of how the data is produced rather than of
 * what it currently contains.
 *
 * Kept well under `profiler-cli guide`'s ~400 lines, per `CLI.md`, and well
 * under half the length of that first version: the target is a guide someone
 * finishes, not one that merely fits a budget.
 */

import { ExitCode } from '../errors.ts';
import type { OptionSpecs, ParsedArgs } from '../args.ts';
import { type CommandContext, emit } from '../context.ts';
import { usageError } from '../errors.ts';
import { toJson } from '../format/json.ts';
import { joinLines, wrapText } from '../format/text.ts';

/** `guide` takes no options of its own. */
export const GUIDE_OPTIONS: OptionSpecs = {};

/**
 * What one command reads and answers.
 *
 * `reads` is the **file family**, not a filename, and it is asserted against
 * the names the command actually requests from the data source. `defaultsTo`
 * is only set where the default is surprising.
 */
export interface CommandFact {
    name: string;
    /**
     * The file family the command reads.
     *
     * **Not printed in the text guide**, and deliberately so: a review found
     * the per-command `reads {harness}-{bucket}.json` annotations were
     * implementation detail the reader could not act on, and they doubled the
     * length of the command list to say it.
     *
     * Kept as data because it is still true, still checked against the files
     * the command actually requests, and still worth exposing under `--json`
     * for a tool deciding what to prefetch. A fact being unhelpful in prose is
     * not a reason to stop asserting it.
     */
    reads: string;
    answers: string;
    /** Set where the harness default is not the usual `xpcshell`. */
    defaultHarness?: string;
    /** The default row limit, where the command has one. */
    defaultLimit?: number;
}

/**
 * The per-command table.
 *
 * Every field here is checked by `test/guide.test.ts` against the running
 * code — the command is dispatched against a recording source and the file it
 * asks for is compared with `reads`, the harness it reports with
 * `defaultHarness`, the rows it emits with `defaultLimit`.
 */
export const COMMAND_FACTS: readonly CommandFact[] = [
    {
        name: 'test',
        reads: '{harness}-{bucket}.json',
        answers: 'Is this one test failing, where, since when, and where does it run at all?',
        defaultLimit: 10,
    },
    {
        name: 'try',
        reads: 'Treeherder + {harness}-{bucket}.json',
        answers: 'Which failures in my push are mine, and which already fail on central?',
    },
    {
        name: 'issues',
        reads: '{harness}-issues.json',
        answers: 'What is failing across the tree?',
        defaultLimit: 20,
    },
    {
        name: 'failures',
        reads: '{harness}-issues.json',
        answers: 'Which message is behind many failures? The one-bug-many-tests view.',
        defaultLimit: 20,
    },
    {
        name: 'crashes',
        reads: '{harness}-issues.json',
        answers: 'Which crash signatures are happening, and in how many tests?',
        defaultLimit: 20,
    },
    {
        name: 'skips',
        reads: '{harness}-issues.json',
        answers: 'What is disabled, where, and why?',
        defaultLimit: 20,
    },
    {
        name: 'flaky',
        reads: '{harness}-issues.json',
        answers: 'Which folder should I book a flakiness-burndown session on?',
        defaultLimit: 20,
    },
    {
        name: 'intermittent',
        reads: 'Treeherder /api/failures/ + /api/failuresbybug/ + Bugzilla /rest/bug',
        answers:
            'Which annotated intermittents cost sheriffs the most, tree-wide, and with which bug?',
        defaultHarness: 'mochitest',
        defaultLimit: 20,
    },
    {
        name: 'errors',
        reads: '{harness}-{date}-errors.json',
        answers: 'What is loudest in the logs? Is this message ambient or specific to one test?',
        defaultHarness: 'mochitest',
        defaultLimit: 20,
    },
    {
        name: 'manifests',
        reads: 'manifests.json',
        answers: 'Which manifest is eating a job’s time budget, and on which configs?',
        defaultLimit: 10,
    },
    {
        name: 'crash',
        reads: 'a task’s minidump-stackwalk artifact',
        answers: 'What crashed or deadlocked, and where?',
    },
    {
        name: 'summary',
        reads: '{harness}-stats.json',
        answers: 'The 7-day topline rates, against the prior period.',
    },
    {
        name: 'dates',
        reads: 'index.json',
        answers: 'Which dates have published data?',
    },
    {
        name: 'cache',
        reads: 'the local cache',
        answers: 'What is cached, and how much space is it using?',
    },
];

/** One exit code and what it means. Asserted against `ExitCode`. */
export interface ExitCodeFact {
    code: number;
    meaning: string;
}

/**
 * The exit-code table.
 *
 * A contract a script branches on, so the numbers are pinned against
 * `cli/errors.ts` rather than retyped. The 3/4 split is the one with real
 * consequences and the only one with a producer worth naming.
 */
export const EXIT_CODE_FACTS: readonly ExitCodeFact[] = [
    { code: ExitCode.Success, meaning: 'Success.' },
    { code: ExitCode.Usage, meaning: 'Usage error: a bad flag, a missing argument, or a flag this file cannot answer.' },
    { code: ExitCode.NotFound, meaning: 'Not found: no such test, no data for that date or revision.' },
    {
        code: ExitCode.Upstream,
        meaning: 'Upstream temporarily unavailable — network, 5xx, a 403. Retrying may work.',
    },
    {
        code: ExitCode.Gone,
        meaning:
            'Data permanently gone: an expired or never-uploaded Taskcluster artifact. ' +
            'Only `fx-tests crash` produces this. Retrying will not help.',
    },
];

/** A trap: a claim about the data that is easy to get wrong, and its cost. */
export interface TrapFact {
    /** A short slug, so a test can name the trap it is checking. */
    id: string;
    title: string;
    /** What goes wrong if you do not know it. */
    body: string[];
}

/**
 * The traps.
 *
 * Each one is a thing that has actually been got wrong — in this repo, in
 * `FORMATS.md`'s corrections, or in a review of this CLI. The prose is
 * hand-written because "why this matters" is not checkable; the *numbers* in it
 * are measurements, and `test/guide.test.ts` checks the ones that are also
 * asserted elsewhere so the two cannot drift apart.
 */
export const TRAPS: readonly TrapFact[] = [
    {
        id: 'perma-fail-rate',
        title: 'An overall failure rate hides a single-config perma-fail',
        body: [
            'A test failing **every time** on one platform and passing everywhere else still',
            'reads as a low single-digit percentage overall, because the rate divides failures',
            'from every config by runs from every config. So a small overall rate is not',
            'evidence a test is healthy, and `fx-tests test` leads with a verdict and a',
            'per-config table rather than one number.',
        ],
    },
    {
        id: 'manifest-zero-durations',
        title: 'All-zero manifest durations mean skipped, not instant',
        body: [
            'A manifest whose durations are **all zero** on a configuration was skipped there;',
            'it did not run in no time. Read as real durations, every skipped config becomes',
            'the fastest in the table, which exactly inverts "which config is worst". The rule',
            'is `every`, not `any` — some zero and some non-zero means it ran, and those zeros',
            'finished under the timer’s resolution.',
        ],
    },
    {
        id: 'profiles-not-derivable',
        title: 'A per-test profile URL cannot be guessed',
        body: [
            'The **resource-usage** profile is one per job at a fixed path derivable from the',
            'task ID — that is the one showing whether a timeout was the test being slow or the',
            'machine saturated. The **per-test failure profile** is different: uploaded only',
            'when a test fails, and named only in the failure message ("profile uploaded in',
            'profile_<name>.json"). Where none was named, no URL exists to construct.',
        ],
    },
    {
        id: 'errors-window',
        title: 'Errors data covers fewer days than everything else',
        body: [
            'A date in `fx-tests dates` does **not** mean it has errors data, and which dates do',
            'changes — so do not carry a number for it. `fx-tests errors` discovers and prints',
            'its own window, and a date outside it is exit 2 listing the ones that work. This',
            'bounds the "was this error already there when the test was passing?" comparison:',
            'both days have to be days with errors data.',
        ],
    },
    {
        id: 'errors-harness',
        title: '`errors` defaults to mochitest, and the xpcshell file is a biased sample',
        body: [
            'Every other command defaults to xpcshell; `errors` does not, and the reason is not',
            'size. xpcshell runs its tests in parallel, so stdout cannot be streamed as it is',
            'produced and is replayed **only when a test fails** — the xpcshell errors file is',
            'failing tests’ output and nothing else. That is a biased population, not a smaller',
            'sample of the same one: ranking it answers "what do failing tests print", not',
            '"what is noisy in CI", which is what a reader of a ranking assumes.',
        ],
    },
    {
        id: 'issues-attribution',
        title: '`issues.json` cannot tell you which configuration failed',
        body: [
            'The tree-wide aggregate discarded all attribution — no task IDs, no job names, no',
            'minidump IDs — so "which config?" has no answer there, which is not the same as',
            'the answer being "none". `issues`, `failures`, `crashes` and `skips` therefore',
            '**refuse** `--config` and `--minidumps` rather than return an empty table, because',
            'a filter that silently matches nothing looks exactly like a clean tree. Use',
            '`fx-tests test <path>` for per-config detail.',
        ],
    },
    {
        id: 'annotations-are-not-failures',
        title: '`intermittent` counts sheriff annotations, not failures',
        body: [
            'A row is a bug a **sheriff** attached to failing jobs, so an untriaged failure has',
            'no row: this ranks what costs sheriffs time, while `issues`/`flaky` rank what fails',
            'most. A bug belongs to a harness when its summary names a test that harness runs;',
            'one naming no known test — a [taskcluster:error], a suite this tool does not read —',
            'is `unknown`. --harness picks one of the three, and omitting it ranks them all.',
        ],
    },
    {
        id: 'weekend-volume',
        title: 'Weekend counts are a fraction of weekday counts',
        body: [
            'Push volume drops several-fold at weekends, so an absolute count from a Saturday',
            'is not comparable with one from a Thursday. Every command prints the weekday next',
            'to a date for this reason. Compare like with like, and prefer rates to counts.',
        ],
    },
    {
        id: 'run-if',
        title: '`run-if` is not a disabled test, and skip counts are not comparable across files',
        body: [
            'A `skip-if` means the test should run here and is turned off — usually work someone',
            'owes. A `run-if` means it is scoped to another platform, so not running here is the',
            'annotation working; `fx-tests skips` excludes those by default.',
            '',
            'The aggregates drop `run-if` skips upstream and the daily files keep them, so a',
            'skip count from one family must not be compared with one from the other. Nor added:',
            'the aggregates and the bucket files re-encode the *same* runs, so summing across',
            'them multiplies the population by the number of encodings.',
        ],
    },
    {
        id: 'hang-not-type',
        title: 'A hang is not distinguishable from a crash by its crash type',
        body: [
            'A minidump is also how a hung process is diagnosed, and `crash_info.type` will not',
            'tell you which you have: a real hang reports `EXC_SOFTWARE / SIGABRT`, exactly as',
            'an ordinary abort. The evidence is breakpad’s own frames on top of a thread that',
            'was otherwise waiting. For a hang use `--all-threads` — a deadlock is diagnosed by',
            'breadth across threads, not depth in one.',
        ],
    },
];

/** A worked investigation. Prose by design: none of it is checkable. */
interface Workflow {
    title: string;
    steps: string[];
}

const WORKFLOWS: readonly Workflow[] = [
    {
        title: 'A test failed on my Try push',
        steps: [
            'fx-tests try <revision> --perma-only',
            '    Tests that failed every run of some configuration. Read the Pre-existing line',
            '    on each: without it the row is probably yours, with it central already fails',
            '    the same way on that same config and it probably is not.',
            '',
            'fx-tests try <revision> --all-jobs',
            '    Reads the passing test jobs too. A test that failed and then passed when the',
            '    harness reran it leaves the job GREEN, so the default run never sees it — it',
            '    is missing, not ranked low. Costs one profile per test job on the push rather',
            '    than one per failed job, so reach for it when burning down flakiness.',
            '',
            'fx-tests test <path>',
            '    Whether it already fails on central, and how. Two things change the reading:',
            '    that it passed when the harness reran it in the same job, and that it fails',
            '    only in parallel — the second points at a race with its neighbours.',
            '',
            'fx-tests test <path> --coverage',
            '    Before concluding a platform is unaffected, check the test runs there at all.',
            '    "No Android row" and "passes on Android" look identical without this.',
        ],
    },
    {
        // The single most useful flag in this CLI, by the report of five agents
        // who used it, and it appeared nowhere in this guide. Kept to one line
        // because the guide has a hard 200-line budget and `--history` earns
        // its place by being run, not by being described.
        title: 'Is this failure getting worse, and since when',
        steps: [
            'fx-tests test <path> --history',
            '    Per-day pass and fail counts — the only time axis, and what dates a regression.',
        ],
    },
    {
        title: 'A job is timing out',
        steps: [
            'fx-tests manifests --job <config> --sort median',
            '    Narrows it to a manifest. Remember the all-zero rule: a manifest with no',
            '    duration shown did not run there.',
            '',
            'fx-tests test <path> --durations',
            '    Whether that manifest is one slow test or a thousand cheap ones. The manifest',
            '    view has no per-test durations and cannot tell you.',
            '',
            'fx-tests test <path> --profiles',
            '    Separates "the test is slow" from "the machine was saturated". Feed the raw',
            '    URL to profiler-cli.',
        ],
    },
    {
        title: 'Reduce CI log noise',
        steps: [
            'fx-tests errors',
            '    A handful of messages are most of the volume, so the top of the list is most',
            '    of the work. Read the `tests` column too: a message in thousands of tests is',
            '    ambient, one in a single test is a candidate cause for that test.',
            '',
            'fx-tests errors --message "<text>"',
            '    Lists the tests emitting one message, so you can tell which of those it is.',
            '',
            'fx-tests errors --day <a> ... then --day <b>',
            '    A single day cannot say whether an error was already there when the test was',
            '    passing. Two days can — both weekdays, and both days that have errors data.',
        ],
    },
    {
        title: 'A test is crashing',
        steps: [
            'fx-tests test <path> --task-ids',
            '    The configs and signatures, plus a task ID and, where the dump was uploaded, a',
            '    minidump ID. A crash whose dump was never uploaded still counts as a crash.',
            '',
            'fx-tests crash <taskId> <minidumpId>',
            '    Signature, crash reason, faulting address, crashing thread. A null pointer',
            '    flagged with an offset means that offset is the field being dereferenced.',
        ],
    },
];

/** Runs the command. */
export function runGuide(context: CommandContext, args: ParsedArgs): Promise<void> {
    if (args.positionals.length > 0) {
        throw usageError(
            `guide takes no arguments, got "${args.positionals[0]}"`,
            'Run `fx-tests guide` and read all of it.'
        );
    }
    if (context.globals.format === 'json') {
        // The tables, so a tool can consume the same facts the prose states.
        emit(
            context,
            toJson({
                commands: COMMAND_FACTS,
                exitCodes: EXIT_CODE_FACTS,
                traps: TRAPS.map((trap) => ({ id: trap.id, title: trap.title })),
            })
        );
        return Promise.resolve();
    }
    emit(context, render());
    return Promise.resolve();
}

/** The whole guide. */
export function render(): string {
    const lines: (string | null)[] = [];

    lines.push('fx-tests — what this data can and cannot tell you');
    lines.push('');
    lines.push('Read this once before using the other commands. The traps below are not');
    lines.push('discoverable from --help, and every one of them has been got wrong in practice.');
    lines.push('');
    lines.push('Everything is read-only. There is no writing to CI, Bugzilla or Treeherder.');

    lines.push('');
    lines.push('THE COMMANDS');
    lines.push('');
    // Just the question each one answers. Which JSON file it opens is internal
    // and was cut: it told the reader nothing they could act on, and it was
    // three of the twelve entries' entire second line.
    const width = Math.max(...COMMAND_FACTS.map((fact) => fact.name.length));
    for (const fact of COMMAND_FACTS) {
        lines.push(`  ${fact.name.padEnd(width)}  ${fact.answers}`);
        if (fact.defaultHarness !== undefined) {
            // The one per-command note that survived, because it is the only
            // one that changes what the reader should type. Its own line
            // rather than a suffix: the answer it hangs off is already 80
            // columns wide.
            lines.push(
                `  ${' '.repeat(width)}  defaults to --harness ${fact.defaultHarness} — see TRAPS`
            );
        }
    }

    lines.push('');
    lines.push('THE WINDOW');
    lines.push('');
    lines.push('The index publishes a rolling window of recent days; `fx-tests dates` says');
    lines.push('which. Older data still exists in Taskcluster but nothing here reaches it, so a');
    lines.push('date outside the window is exit 2 naming the window.');
    lines.push('');
    lines.push('Inside it, --day and --since filter a file the command already reads rather than');
    lines.push('fetching a different one, so a narrower question is not a slower one. `errors`');
    lines.push('and `manifests` are per-date files and are the exception — see TRAPS.');

    lines.push('');
    lines.push('TRAPS');
    for (const trap of TRAPS) {
        lines.push('');
        lines.push(`  ${trap.title}`);
        for (const line of trap.body) {
            lines.push(line === '' ? '' : `    ${line}`);
        }
    }

    lines.push('');
    lines.push('WORKED INVESTIGATIONS');
    for (const workflow of WORKFLOWS) {
        lines.push('');
        lines.push(`  ${workflow.title}`);
        for (const step of workflow.steps) {
            lines.push(step === '' ? '' : `    ${step}`);
        }
    }

    lines.push('');
    lines.push('EXIT CODES');
    lines.push('');
    // Wrapped: `ExitCode.Gone`'s meaning is 130 characters and ran off the
    // right of an 80-column terminal, which is where a guide is read.
    for (const fact of EXIT_CODE_FACTS) {
        const [first, ...rest] = wrapText(fact.meaning, 74);
        lines.push(`  ${fact.code}  ${first ?? ''}`);
        for (const line of rest) {
            lines.push(`     ${line}`);
        }
    }
    lines.push('');
    lines.push('  The 3/4 split lets a script tell "try again in a minute" from "this dump is');
    lines.push('  never coming back". `fx-tests try` exits 0 whether or not it found failures:');
    lines.push('  the failures are the answer, not an error.');

    lines.push('');
    lines.push('OUTPUT');
    lines.push('');
    lines.push('  --json for a stable shape, --markdown for pasting into a bug. Only requested');
    lines.push('  data goes to stdout and everything else to stderr, so piping behaves.');
    lines.push('');
    lines.push('  Lists are truncated by default and say so (`… 47 more (--limit 0 for all)`).');
    lines.push('  If a list looks short, check for that line before believing it is complete.');
    lines.push('');
    lines.push('  Messages are cut to the terminal width, and the cut takes the end — which is');
    lines.push('  often the discriminator. COLUMNS widens it; --full-messages turns it off, as');
    lines.push('  does --markdown, which never truncates.');

    return joinLines(lines);
}
