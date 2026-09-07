/**
 * Exit codes, and the errors that carry them.
 *
 * `CLI.md`'s table is the contract, and the 3/4 split is the part with real
 * consequences: a script needs to tell "try again in a minute" from "this
 * crash dump is never coming back". Collapsing them — which is what a bare
 * `process.exit(1)` on any failure does — makes retry logic impossible to
 * write correctly.
 *
 * Every command signals a non-zero exit by throwing one of these rather than
 * calling `process.exit`, so that `bin/fx-tests.ts` is the only place that
 * knows about the process at all. That is what lets a test run a command and
 * assert on the code without spawning anything.
 */

import { IntermittentsError, TREE_GROUPS } from '../lib/sources/intermittents.ts';

/** `CLI.md`'s exit-code table, as a type. */
export const ExitCode = {
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
    Gone: 4,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * An error that names the exit code it should produce.
 *
 * The message is printed to stderr as-is, so it is written for a human: it
 * should say what was looked for and, where there is one, what to try next.
 * `CliError` is not for programming mistakes — those should throw a plain
 * `Error` and surface with a stack, because a stack is what a bug report needs.
 */
export class CliError extends Error {
    readonly exitCode: ExitCodeValue;
    /** An optional second paragraph: the suggested next step. */
    readonly hint: string | undefined;

    constructor(exitCode: ExitCodeValue, message: string, hint?: string) {
        super(message);
        this.name = 'CliError';
        this.exitCode = exitCode;
        this.hint = hint;
    }
}

/** A usage error — exit 1. */
export function usageError(message: string, hint?: string): CliError {
    return new CliError(ExitCode.Usage, message, hint);
}

/** A not-found error — exit 2. */
export function notFoundError(message: string, hint?: string): CliError {
    return new CliError(ExitCode.NotFound, message, hint);
}

/** A transient upstream failure — exit 3. */
export function upstreamError(message: string, hint?: string): CliError {
    return new CliError(ExitCode.Upstream, message, hint);
}

/** Permanently missing data — exit 4. */
export function goneError(message: string, hint?: string): CliError {
    return new CliError(ExitCode.Gone, message, hint);
}

/**
 * Turns a Treeherder or Bugzilla failure into the CLI's exit codes.
 *
 * A 400 from those endpoints is almost always a `tree` they do not know — that
 * is the one thing `validate_tree` rejects — so it becomes a usage error naming
 * the groups they do accept, rather than exit 3 telling the user to retry a
 * request that will fail identically forever.
 *
 * Here rather than in `cli/commands/intermittent.ts` because `fx-tests test`
 * now makes the same two requests and needs the same mapping. It stays in
 * `cli/` — its whole job is producing exit codes, which is a CLI concern that
 * `lib/` must not know about — but in the module that owns the error
 * constructors it calls, so a second command imports it from there rather than
 * from another command.
 */
export async function withUpstreamErrors<T>(
    work: () => Promise<T>,
    tree: string
): Promise<T> {
    try {
        return await work();
    } catch (error) {
        if (error instanceof IntermittentsError) {
            if (error.status === 400) {
                throw usageError(
                    `Treeherder rejected the query, which for these endpoints means an unknown ` +
                        `tree: "${tree}"`,
                    `--tree takes a repository name (autoland, mozilla-central, …), a repo group ` +
                        `(${TREE_GROUPS.join(', ')}), or all.`
                );
            }
            throw upstreamError(
                `${error.message} from ${error.url}`,
                'Treeherder’s intermittents API and Bugzilla are both live services; retrying may work.'
            );
        }
        throw error;
    }
}
