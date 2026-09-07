/**
 * The message and dropped-marker lines a per-test failure row prints.
 *
 * Shared by `fx-tests try` and `fx-tests task`, which render the same rows out
 * of the same markers — one aggregated across a push, one within a single job.
 * They were two copies for exactly one commit and had already drifted in two
 * places (a `counted.set(message, 0)` that one had and the other did not, and
 * an empty-list guard likewise), neither reachable yet, which is what dead
 * divergence looks like on day one.
 *
 * This lives in `cli/format/` rather than `lib/`: `lib/` is the code `cli/` and
 * `site/` share, and the dashboards render none of this — they have a table
 * cell and a tooltip where the CLI has indented lines. `lib/model/` still owns
 * the *data* (`marker-messages.ts` partitions the profile notices out of a
 * failure's messages); this owns only how the result is laid out in a terminal.
 *
 * The parameters are structural — `messages` and `allMessages`, not a
 * `TryFailure` or a `TaskFailure` — so neither command's row type is imported
 * here and neither can drag the other's fields in.
 */

import { truncate } from './text.ts';

/**
 * How many messages one row prints under `--messages`.
 *
 * Stated in the output when it bites, so a reader is never left to wonder
 * whether a row had more. One definition rather than one per command: the two
 * both name the number in their `--messages` help text, and a cap that differed
 * from the help would be a lie in the place a reader checks first.
 */
export const MESSAGE_CAP = 20;

/** The message fields a row needs to render, from either command's failure type. */
export interface MessageBearing {
    /** One entry per failing execution, most common first. */
    messages: readonly string[];
    /** Every message the failing executions logged, with a count each. */
    allMessages: readonly { message: string; count: number }[];
}

/** A newline-bearing message on one line, with the breaks made visible. */
function flatten(message: string): string {
    return message.replace(/\s*\n\s*/g, ' ⏎ ');
}

/**
 * Every message on a row, or the two most common plus how many more.
 *
 * `messages` and `allMessages` are **not nested** — a synthetic crash's
 * signature and a `Test`-marker message are in `messages` only — so both the
 * list and the count are taken over their union rather than by subtracting one
 * from the other. Subtracting undercounts.
 */
export function messageLines(failure: MessageBearing, allMessages: boolean): string[] {
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
        const shown = ordered.slice(0, MESSAGE_CAP);
        const lines = shown.map(
            (entry) =>
                // Blank rather than `0x` for a row with no per-execution count,
                // since `0x` would read as "never seen".
                `    ${(entry.count > 0 ? `${entry.count}x` : '').padStart(4)} ` +
                truncate(flatten(entry.message), 106)
        );
        if (ordered.length > shown.length) {
            lines.push(
                `    (${ordered.length - shown.length} more messages, not shown: the cap is ` +
                    `${MESSAGE_CAP} per row)`
            );
        }
        return lines;
    }
    // The headline stays `messages`: it is one entry per failing execution, so
    // it ranks by how many executions reported each message. Ranking on
    // `allMessages` promotes whichever message repeats most *within* an
    // execution instead.
    const shown = failure.messages.slice(0, 2);
    const lines = shown.map((message) => `    ${truncate(flatten(message), 110)}`);
    const union = new Set<string>([...failure.messages, ...all.map((entry) => entry.message)]);
    for (const message of shown) {
        union.delete(message);
    }
    if (union.size > 0) {
        lines.push(
            `    (+${union.size} more message${union.size === 1 ? '' : 's'} for this test; ` +
                `--messages to see them)`
        );
    }
    return lines;
}

/** A failing marker whose id yielded no test path, as the warning names it. */
export interface DroppedForReport {
    /** `''` when the marker named no test at all. */
    id: string;
    status: string;
}

/**
 * How many failing markers named no test path, and which — the warning body.
 *
 * A crash recorded against a `.toml` manifest is real and has no path to put in
 * a row. The ids print rather than only being counted, because the useful
 * question is which shape dropped. The **sentence around** this differs between
 * the two commands and is deliberately theirs: for a push these are a footnote,
 * for a single job they can be most of the answer.
 */
export function droppedMarkerSummary(
    dropped: readonly DroppedForReport[],
    limit = 5
): { count: number; shown: string } {
    const ids = [...new Set(dropped.map((entry) => `${entry.status} ${entry.id}`))];
    return {
        count: dropped.length,
        shown:
            ids.slice(0, limit).join(', ') +
            (ids.length > limit ? `, and ${ids.length - limit} more` : ''),
    };
}
