/**
 * What a command is given: where to write, where to read data from, and the
 * globals.
 *
 * This is the seam that makes every command testable without a network or a
 * process. `PLAN.md` §3 step 4 asks for "each command against fixtures via the
 * fake source, asserting on `--json` output", and that is only possible if a
 * command never reaches for `process.stdout` or global `fetch` itself.
 *
 * The `stdout`/`stderr` split is a contract rather than a convenience:
 * `CLI.md` says only the requested data goes to stdout, so `> out.md` and a
 * pipe into `jq` both behave. Progress, warnings and the data's provenance all
 * go to stderr. A command that writes a progress line to stdout breaks a
 * pipeline in a way that is only visible to whoever is on the other end of it.
 */

import type { DecodedTimingFile } from '../lib/formats/decode.ts';
import type { DataSource } from '../lib/sources/source.ts';
import type { IntermittentsClient } from '../lib/sources/intermittents.ts';
import type { LandoClient } from '../lib/sources/lando.ts';
import type { TreeherderClient } from '../lib/sources/treeherder.ts';
import type { GlobalOptions } from './options.ts';

/** A loaded timing file, whichever family it came from. */
export interface LoadedTimingFile {
    /** The raw file, for the metadata and the fields only some families have. */
    raw: { metadata: { generatedAt: string }; taskInfo?: { chunks?: (number | null)[] } };
    decoded: DecodedTimingFile;
}

/** Where a command writes. */
export interface OutputStreams {
    /** The requested data. Nothing else. */
    out(text: string): void;
    /** Progress, diagnostics, provenance. */
    err(text: string): void;
}

/** Everything a command needs from the outside world. */
export interface CommandContext {
    globals: GlobalOptions;
    streams: OutputStreams;
    /**
     * The source for published index files.
     *
     * Already wrapped in the disk cache unless `--no-cache`, so a command
     * never knows whether it was served from disk. That is deliberate: the
     * cache must not be able to change what a command computes.
     */
    source: DataSource;
    /**
     * A source for a specific task's own artifacts, for `--profiles` and
     * `fx-tests crash`. Separate from `source` because the failure modes
     * differ — an expired artifact is exit 4, a missing index file is not.
     */
    taskArtifacts?: DataSource | undefined;
    /** Treeherder, for `fx-tests try`. Absent when a command does not need it. */
    treeherder?: TreeherderClient | undefined;
    /**
     * Lando, for the `landoCommitID` `fx-tests try` accepts in place of a
     * revision.
     *
     * Its own client rather than a method on `treeherder`: it is a different
     * host, and Treeherder's push API cannot answer the question — it accepts
     * `lando_commit_id`, echoes it back and ignores it. See
     * `lib/sources/lando.ts`.
     */
    lando?: LandoClient | undefined;
    /**
     * The intermittents endpoints plus Bugzilla, for `fx-tests intermittent`.
     *
     * Separate from `treeherder`: a different caching rule, and it reaches
     * Bugzilla, which the push client does not.
     */
    intermittents?: IntermittentsClient | undefined;
    /**
     * Overrides how a test's timing file is loaded.
     *
     * Exists for one reason, and it is worth stating rather than leaving as an
     * unexplained hook: `fx-tests test` always reads a **bucket** file, which
     * can attribute runs to configurations, so the branches that handle a file
     * that *cannot* — `issues.json`, which has no `taskInfo` — are unreachable
     * from the command's own code path. A mutation replacing
     * `canAttributeConfigs(decoded)` with a literal `true` therefore survived
     * the whole suite.
     *
     * Those branches stop being unreachable the moment step 5's `issues`,
     * `failures`, `crashes` and `skips` land, since all four read that family.
     * Rather than let the guard go live untested, this seam lets a test drive
     * the command over a file with no attribution today.
     *
     * Production never sets it.
     */
    loadTimingFile?:
        | ((harness: string, testPath: string) => Promise<LoadedTimingFile>)
        | undefined;

    /**
     * Raw HTTP, for the artifacts `fx-tests try` reads per job.
     *
     * `try` fetches one profile per failed job from
     * `firefoxci.taskcluster-artifacts.net`, which is not an index artifact
     * and not a `DataSource` name. Injected so no test hits the network.
     */
    fetchUrl?: ((url: string) => Promise<Uint8Array | null>) | undefined;
}

/** Whether progress is wanted: not `--quiet`, and not an agent caller. */
export function wantsProgress(globals: GlobalOptions): boolean {
    if (globals.quiet) {
        return false;
    }
    return globals.progress || !globals.agent;
}

/** Writes a progress line, unless suppressed. See `wantsProgress`. */
export function progress(context: CommandContext, message: string): void {
    if (wantsProgress(context.globals)) {
        context.streams.err(`${message}\n`);
    }
}

/** Writes a warning. Warnings ignore `--quiet` — they are not progress. */
export function warn(context: CommandContext, message: string): void {
    context.streams.err(`warning: ${message}\n`);
}

/**
 * Writes an unprefixed notice that changes what the output means — the answer
 * is about a different test from the one asked for. Not progress: it survives
 * `--quiet` and an agent caller, for the same reason `warn` does.
 */
export function notice(context: CommandContext, message: string): void {
    context.streams.err(`${message}\n`);
}

/** Writes the command's output, ensuring exactly one trailing newline. */
export function emit(context: CommandContext, text: string): void {
    if (text.length === 0) {
        return;
    }
    context.streams.out(text.endsWith('\n') ? text : `${text}\n`);
}

/** Collects output into strings, for tests. */
export function captureStreams(): OutputStreams & { stdout: string; stderr: string } {
    const captured = {
        stdout: '',
        stderr: '',
        out(text: string): void {
            captured.stdout += text;
        },
        err(text: string): void {
            captured.stderr += text;
        },
    };
    return captured;
}
