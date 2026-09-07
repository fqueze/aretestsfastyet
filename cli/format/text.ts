/**
 * Plain-text output primitives.
 *
 * `CLI.md`'s design goal is "output for reading, not parsing": compact, no
 * colour required, no ASCII-art tables that wrap at 80 columns. So the table
 * here is space-aligned columns with no borders, which degrades gracefully
 * when a cell is too wide instead of breaking the frame.
 *
 * The other rule this module enforces is **context-window frugality**: a
 * truncated list says what it truncated. `… 47 more (--limit 0 for all)` is
 * one line and it is the difference between a caller knowing there is more and
 * a caller concluding there is not.
 */

/** A column of a text table. */
export interface Column {
    header: string;
    /** Right-align, for numbers. Default left. */
    align?: 'left' | 'right';
    /**
     * Truncate cells to this width, with an ellipsis. Omit for no limit.
     *
     * Only the message column normally needs one, and `CLI.md` is explicit
     * that truncation must be visible — the `…` is that signal.
     */
    maxWidth?: number;
    /**
     * Treat cells as slash-separated paths.
     *
     * A path is an identifier to copy, not prose to skim, so it gets rules a
     * message column does not:
     *
     * - **The width is measured, not declared.** The column grows to the
     *   longest path actually in the rows being printed, up to
     *   `PATH_COLUMN_CAP`. A caller does not pass `maxWidth` for a path column
     *   and cannot get it wrong. The hardcoded 56 and 62 this replaced were
     *   discarding information for no benefit: measured over real `issues`
     *   output the widest path at the default limit is 97 characters and the
     *   p90 is 81, so both constants were truncating the common case.
     * - **The cut, when the cap does bite, comes off the front**, so the
     *   basename survives (`truncatePath()`).
     * - **Whatever is still shortened is recoverable**: `tableWithPaths()`
     *   collects it for the full-path block. With auto-sizing that is a rare
     *   fallback rather than the normal path.
     */
    path?: boolean;
    /**
     * Mark this column as the one the rows are ordered by.
     *
     * The header gets a `▼`/`▲` suffix, because a ranked list that does not
     * say what it is ranked by is indistinguishable from an arbitrary one —
     * which is exactly how `issues`, correctly sorted by rate, was read as
     * "a few random tests, without sorting".
     */
    sort?: 'desc' | 'asc';
}

/**
 * The most characters a path column may take, when auto-sizing is not enough.
 *
 * Chosen from the measured distribution rather than from tradition: over the
 * whole `xpcshell-issues.json` file (4,054 rows) the longest test path is 125
 * characters, and at the default 20-row limit it is 97. 128 therefore clears
 * every real path in the data, and exists only so that one pathological value
 * cannot push the numeric columns off a terminal — not as a routine limit.
 */
export const PATH_COLUMN_CAP = 128;

// `--full-messages` opts out, so a long path widens its row and no `full paths`
// recovery block is emitted — nothing was shortened to recover.
function pathColumnCap(): number {
    return widthScale === null ? Number.POSITIVE_INFINITY : PATH_COLUMN_CAP;
}

/**
 * A rendered table plus the full values of whatever its path columns shortened.
 *
 * The two travel together deliberately. The bug this replaced was one command
 * doing truncation *and* recovery while four did only truncation, so recovery
 * lived in a command and could be forgotten. Here the renderer that shortens a
 * path is the same code that reports it, and a caller that renders a table gets
 * the recovered paths whether or not it remembered to want them.
 */
/**
 * Options for the renderers that take them.
 */
export interface TableOptions {
    /**
     * Shrink the table's budgeted columns until the line fits the terminal.
     *
     * Opt-in, and that is the point. Per-column `maxWidth` budgets are scaled
     * against a 90-column baseline, so on a wide terminal they widen and on a
     * narrow one they shrink — but nothing checks that they *add up*, and three
     * columns each budgeted near the width give a line twice the width.
     *
     * This is the backstop for that, and it is off by default because it
     * re-cuts cells the caller already sized: a command whose layout is already
     * balanced does not need it, and applying it everywhere silently shortened
     * a `(+N more messages)` hint in `fx-tests try` and pushed a duration
     * column out of `fx-tests manifests`. A caller turns it on for a table it
     * has measured.
     */
    fit?: boolean;
}

export interface TableWithPaths {
    /** The table's lines, header first. */
    lines: string[];
    /**
     * Full values of the cells a path column shortened, in row order and
     * de-duplicated. Empty when nothing was cut.
     */
    shortenedPaths: string[];
}

/**
 * Renders aligned columns.
 *
 * The last column is not padded, so a long message does not leave trailing
 * spaces on every line.
 */
export function table(
    columns: readonly Column[],
    rows: readonly (readonly string[])[],
    indent = '  ',
    options: TableOptions = {}
): string[] {
    return tableWithPaths(columns, rows, indent, options).lines;
}

/**
 * Renders aligned columns and reports the paths it shortened.
 *
 * Use this — or `tableSection()`, which also prints the recovery block —
 * wherever a column is a path. `table()` is the same renderer for the tables
 * that have none.
 */
export function tableWithPaths(
    columns: readonly Column[],
    rows: readonly (readonly string[])[],
    indent = '  ',
    options: TableOptions = {}
): TableWithPaths {
    if (rows.length === 0) {
        return { lines: [], shortenedPaths: [] };
    }
    const shortened: string[] = [];
    // A path column sizes itself to the widest path it is actually given,
    // capped. Measuring beats declaring: the constants this replaced (56, 62)
    // were narrower than the real data's p90 of 81, so they truncated the
    // common case for no benefit, and every command had to remember its own.
    const pathWidths = columns.map((column, i) =>
        column.path === true
            ? Math.min(
                  pathColumnCap(),
                  Math.max(0, ...rows.map((row) => (row[i] ?? '').length))
              )
            : undefined
    );
    const cells = rows.map((row) =>
        row.map((cell, i) => {
            const column = columns[i];
            const max = column?.path === true ? pathWidths[i] : column?.maxWidth;
            if (max === undefined) {
                return cell;
            }
            if (column?.path !== true) {
                return truncate(cell, max);
            }
            const cut = truncatePath(cell, max);
            // Recorded from the comparison, not from a length test the caller
            // repeats: whether the cell was shortened is something only the
            // truncation knows, and re-deriving it elsewhere is how the two
            // halves drifted apart in the first place.
            if (cut !== cell && !shortened.includes(cell)) {
                shortened.push(cell);
            }
            return cut;
        })
    );
    const headers = columns.map(headerLabel);
    const widths = fitToWidth(
        columns,
        columns.map((_column, i) =>
            Math.max(headers[i]!.length, ...cells.map((row) => (row[i] ?? '').length))
        ),
        indent.length,
        options.fit === true
    );
    // Re-cut against the fitted widths: `widths` is what each column will
    // actually occupy, and a cell wider than its column is what pushes the line
    // over. Path columns keep their tail-preserving cut.
    for (const [r, row] of cells.entries()) {
        for (let i = 0; i < columns.length; i++) {
            const cell = row[i] ?? '';
            const width = widths[i]!;
            if (cell.length <= width) {
                continue;
            }
            if (columns[i]?.path === true) {
                row[i] = truncatePath(cell, width);
                // The **original**, not `cell`: by here `cell` may already be
                // the first pass's shortened form, and recovery exists to give
                // back the full path. Recording the cut version would put a
                // second, still-shortened entry in the block.
                const original = rows[r]![i] ?? '';
                if (!shortened.includes(original)) {
                    shortened.push(original);
                }
                continue;
            }
            row[i] = truncateTo(cell, width);
        }
    }

    const line = (values: readonly string[]): string => {
        const parts: string[] = [];
        for (let i = 0; i < columns.length; i++) {
            const value = values[i] ?? '';
            const isLast = i === columns.length - 1;
            if (isLast) {
                parts.push(columns[i]!.align === 'right' ? value.padStart(widths[i]!) : value);
            } else {
                parts.push(
                    columns[i]!.align === 'right'
                        ? value.padStart(widths[i]!)
                        : value.padEnd(widths[i]!)
                );
            }
        }
        return (indent + parts.join('  ')).trimEnd();
    };

    return { lines: [line(headers), ...cells.map(line)], shortenedPaths: shortened };
}

/**
 * Shrinks the widest columns until the whole line fits the terminal.
 *
 * Per-column `maxWidth` budgets are the caller's statement of intent — how much
 * a column deserves relative to its neighbours — but nothing was checking that
 * they *add up*. Three columns each budgeted just under the width produce a line
 * twice the width, which is how this table reached 162 characters at
 * `COLUMNS=80`.
 *
 * So the budgets stay, and this is the backstop underneath them: take the
 * measured widths, and while the line is too long, shave a character off
 * whichever column is currently widest. Taking from the widest is what protects
 * the narrow columns — `count` and `bug` are never touched, because they are
 * never the widest — without the caller having to rank them.
 *
 * `MIN_CELL_WIDTH` stops a column being shaved to nothing: past that the line is
 * allowed to overflow, because a table of ellipses answers no question. Returns
 * the measured widths unchanged when truncation is off (`--markdown`, `--json`,
 * `--full-messages`), which is what keeps those formats uncut.
 */
function fitToWidth(
    columns: readonly Column[],
    measured: readonly number[],
    indentWidth: number,
    enabled: boolean
): number[] {
    const limit = renderWidth();
    const widths = [...measured];
    if (!enabled || limit === null) {
        return widths;
    }
    // Only columns the caller marked shrinkable — a `maxWidth` budget or a path
    // — may be shaved. The others hold values whose text *is* the answer: a
    // duration, a percentage, a count, an em dash meaning "not recorded". Cut
    // those and the cell stops meaning anything, which is worse than a line
    // that wraps in the terminal.
    const shrinkable = columns
        .map((column, i) => (column.maxWidth !== undefined || column.path === true ? i : -1))
        .filter((i) => i >= 0);
    if (shrinkable.length === 0) {
        return widths;
    }
    // Two spaces between columns, plus the indent.
    const overhead = indentWidth + Math.max(0, columns.length - 1) * 2;
    const total = (): number => widths.reduce((sum, width) => sum + width, overhead);
    while (total() > limit) {
        let widest = -1;
        for (const i of shrinkable) {
            if (widest === -1 || widths[i]! > widths[widest]!) {
                widest = i;
            }
        }
        if (widest === -1 || widths[widest]! <= MIN_CELL_WIDTH) {
            // Every shrinkable column is at the floor; overflowing beats
            // rendering a grid of ellipses.
            break;
        }
        widths[widest]!--;
    }
    return widths;
}

/**
 * The narrowest a column may be shaved to before the line is left to overflow.
 *
 * Twelve characters is enough for `…/browser_x.js` to still identify a row.
 */
const MIN_CELL_WIDTH = 12;

/**
 * A column's header, with the sort marker when it is the ordering column.
 *
 * `▼` for descending, `▲` for ascending — one character, no legend needed, and
 * it appears in the same place a reader is already looking to find out what the
 * column means.
 */
function headerLabel(column: Column): string {
    if (column.sort === undefined) {
        return column.header;
    }
    return `${column.header} ${column.sort === 'desc' ? '▼' : '▲'}`;
}

/**
 * Two columns with no header, the left padded to the widest cell — measured, not
 * a constant, which only lines up while the truncation width is fixed.
 */
export function labelledLines(
    rows: readonly (readonly [string, string])[],
    indent = '  '
): string[] {
    const width = Math.max(0, ...rows.map(([label]) => label.length));
    return rows.map(([label, value]) => `${indent}${label.padEnd(width)}  ${value}`.trimEnd());
}

/**
 * The full-path recovery block: the paths a table shortened, ready to copy.
 *
 * The table keeps the basename so rows can be told apart and grepped for, but
 * `fx-tests test <path>` takes the whole path, and output that cannot feed the
 * next command is the defect this exists to prevent. Returns no lines when
 * nothing was cut.
 */
export function fullPathLines(shortenedPaths: readonly string[], indent = '  '): string[] {
    if (shortenedPaths.length === 0) {
        return [];
    }
    return [
        `${indent}full paths (${shortenedPaths.length} shortened above):`,
        ...shortenedPaths.map((path) => `${indent}  ${path}`),
    ];
}

/**
 * A table, its `… n more` line and its full-path recovery block, in order.
 *
 * The single entry point for "print a table of rows, some of which are paths".
 * Truncation and recovery cannot be separated here: a caller gets both or
 * neither, which is the structural version of the convention that four
 * commands failed to follow.
 */
export function tableSection(
    columns: readonly Column[],
    rows: readonly (readonly string[])[],
    options: { total: number; shown: number; indent?: string; fit?: boolean }
): string[] {
    const indent = options.indent ?? '  ';
    const rendered = tableWithPaths(columns, rows, indent, { fit: options.fit === true });
    const lines = [...rendered.lines];
    const more = moreLine(options.total, options.shown, indent);
    if (more !== null) {
        lines.push(more);
    }
    lines.push(...fullPathLines(rendered.shortenedPaths, indent));
    return lines;
}

/**
 * The width every `truncate()` budget was written for; they are scaled against
 * the real width rather than rewritten, each encoding its line's other columns.
 */
const BASELINE_WIDTH = 90;

/** A floor, so a very narrow window cuts messages to something still readable. */
const MIN_WIDTH = 60;

/**
 * The factor every `truncate()` budget is multiplied by, or `null` for none.
 *
 * Module state, so this **assumes one `run()` at a time**: overlapping ones share
 * it and a text command would truncate a `--markdown` run's cells. To lift that,
 * move this and `artifactHits` in `cli/main.ts` into the context.
 */
let widthScale: number | null = 1;

/** Configures truncation for this invocation. */
export function configureTruncation(options: {
    format: 'text' | 'json' | 'markdown';
    fullMessages: boolean;
}): void {
    if (options.format !== 'text' || options.fullMessages) {
        widthScale = null;
        return;
    }
    widthScale = Math.max(MIN_WIDTH, terminalWidth()) / BASELINE_WIDTH;
}

/**
 * The terminal width to scale to: `COLUMNS`, then the TTY, then the baseline.
 *
 * `COLUMNS` comes first because `process.stdout.columns` is `undefined` whenever
 * stdout is a pipe, which is every agent invocation and every `> file`.
 */
function terminalWidth(): number {
    const fromEnv = Number(process.env['COLUMNS']);
    if (Number.isFinite(fromEnv) && fromEnv > 0) {
        return fromEnv;
    }
    const fromTty = process.stdout.columns;
    if (typeof fromTty === 'number' && fromTty > 0) {
        return fromTty;
    }
    return BASELINE_WIDTH;
}

/**
 * The width a text table may occupy, or `null` when truncation is off.
 *
 * `null` under `--markdown`, `--json` and `--full-messages`, which is what keeps
 * a table that must not be cut from being cut.
 */
export function renderWidth(): number | null {
    return widthScale === null ? null : Math.max(MIN_WIDTH, terminalWidth());
}

/** Resets truncation to the default. Called per invocation by `run()`. */
export function resetTruncation(): void {
    widthScale = 1;
}

/** Scales a column budget to the configured width. `0` means no limit. */
function scaled(maxWidth: number): number {
    if (widthScale === null || maxWidth <= 0) {
        return 0;
    }
    return Math.max(1, Math.round(maxWidth * widthScale));
}

/**
 * Truncates to an **absolute** width, with a trailing `…`.
 *
 * `truncate()` scales its argument against the baseline; this does not, because
 * `fitToWidth` has already resolved a real width for the real terminal.
 */
function truncateTo(value: string, width: number): string {
    if (width <= 0 || value.length <= width) {
        return value;
    }
    return `${value.slice(0, Math.max(0, width - 1))}…`;
}

/** Truncates with a trailing `…`. `maxWidth` is a `BASELINE_WIDTH` budget. */
export function truncate(value: string, maxWidth: number): string {
    const limit = scaled(maxWidth);
    if (limit <= 0 || value.length <= limit) {
        return value;
    }
    return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * How to render a list of messages so a reader learns **what failed** and
 * **how the rows differ**, without a second command.
 *
 * ## Why one line per message cannot work
 *
 * `truncate()` per message produced the defect item 15 reported: 25 rows of
 * `browser_switchTabPermissionPrompt.js`'s `Issues` block cut at the same
 * column and reduced to 3 distinct lines on screen, reading as 25 failure
 * modes. The first fix elided the shared head so the differing tail showed —
 * and made it worse, because what survived was a stack location with no
 * failure message at all. A reader learned neither what failed nor, usefully,
 * how the rows differed.
 *
 * The constraint is arithmetic, measured on that test: the messages are **353
 * characters**, the 19 rows of one group share a **238-character prefix**, and
 * across all rows the common prefix is **0**. Against ~90 columns no
 * single-line layout can carry both the message and the discriminator. So the
 * message gets more than one line.
 *
 * ## The shape
 *
 * Rows that share a long prefix become a group. The group's first row prints
 * its message **wrapped in full**, and the rest print only what distinguishes
 * them:
 *
 * ```
 *  1.  113x  FAIL  Uncaught exception in test - [Exception... "Component returned
 *                  failure code: 0x80520015 (NS_ERROR_FILE_ACCESS_DENIED) …
 *                  :: _internalMaybeFixupLoadURI :: line 10875"  data: no]
 *  2.   66x  FAIL  ↑ same, but line 10651"  data: no]
 *  3.   52x  FAIL  ↑ same, but line 10643"  data: no]
 * ```
 *
 * The message is shown once, in full, and the near-identical rows collapse to
 * one line each stating their difference. That is item 15's "keep the common
 * prefix on the first row, elide it on the rest" — honoured better by a full
 * first row than by 22 truncations of it.
 *
 * A row sharing no useful prefix with anything is its own group of one, so it
 * prints its message wrapped in full too. Nothing is truncated, which is the
 * point: `--json` and `--full-messages` are no longer needed to find out what
 * failed.
 */
export interface MessageGroupLine {
    /** The row this line belongs to, as an index into the input. */
    index: number;
    /** The text, already wrapped to fit. Blank for a continuation's indent. */
    text: string;
    /** Whether this is the row's first line — the one that carries the label. */
    first: boolean;
}

/**
 * The minimum shared prefix, in characters, before two rows are called a group.
 *
 * Below this the "same, but …" line would be longer than simply printing the
 * message, and would also be lying about how alike the rows are. 60 characters
 * is roughly two thirds of a default-width line: enough that the shared part
 * genuinely dominates.
 */
const GROUP_PREFIX_MIN = 60;

/**
 * Groups messages by shared prefix and renders each group as described above.
 *
 * `width` is the room available for the message text — the caller's line width
 * less its own label and indent. `null` means do not wrap, which is what
 * `--markdown`, `--json` and `--full-messages` pass through `renderWidth()`.
 */
export function messageLines(
    messages: readonly string[],
    width: number | null
): MessageGroupLine[] {
    const out: MessageGroupLine[] = [];
    // The row each row is "same, but" against: the nearest earlier row sharing
    // at least GROUP_PREFIX_MIN characters. Nearest rather than best, so the
    // reference is always a line the reader has just read.
    const leaderOf = new Map<number, number>();
    for (let i = 0; i < messages.length; i++) {
        for (let j = i - 1; j >= 0; j--) {
            // Chain to the group's own leader, never to a follower, so a
            // follower's one-line form is never the reference for another row.
            if (leaderOf.has(j)) {
                continue;
            }
            if (commonPrefixLength([messages[i]!, messages[j]!]) >= GROUP_PREFIX_MIN) {
                leaderOf.set(i, j);
                break;
            }
        }
    }

    for (let i = 0; i < messages.length; i++) {
        const leader = leaderOf.get(i);
        if (leader === undefined) {
            // A group leader, or a row with no relatives: the whole message,
            // wrapped, never cut.
            for (const [n, text] of wrapText(messages[i]!, width).entries()) {
                out.push({ index: i, text, first: n === 0 });
            }
            continue;
        }
        // A follower: only the part that differs from its leader. The cut goes
        // back far enough to keep the differing *phrase*, not just the token:
        // the shared prefix of `line 10875` and `line 10651` ends inside the
        // number, and backing up one word gives `10651"` — a bare number with
        // nothing saying it is a line number. Two words back keeps `line
        // 10651"`, which reads.
        const shared = commonPrefixLength([messages[i]!, messages[leader]!]);
        const cut = wordsBefore(messages[i]!, shared, 2);
        const difference = messages[i]!.slice(cut).trimStart();
        const label = `↑ same as ${leader + 1}, but `;
        const lines = wrapText(
            difference,
            width === null ? null : Math.max(MIN_DIFFERENCE_WIDTH, width - label.length)
        );
        out.push({ index: i, text: label + (lines[0] ?? ''), first: true });
        for (const text of lines.slice(1)) {
            out.push({ index: i, text, first: false });
        }
    }
    return out;
}

/**
 * The narrowest a difference may be wrapped to before it is left to overflow.
 *
 * A difference squeezed below this is the discriminator itself being broken up,
 * which is the failure this whole function exists to prevent.
 */
const MIN_DIFFERENCE_WIDTH = 24;
/** The length of the prefix every one of `values` shares. */
function commonPrefixLength(values: readonly string[]): number {
    const first = values[0] ?? '';
    let length = first.length;
    for (const value of values.slice(1)) {
        let i = 0;
        while (i < length && i < value.length && value[i] === first[i]) {
            i++;
        }
        length = i;
    }
    return length;
}

/** `at`, backed up to just after the last space before it. `0` when there is none. */
function wordBoundaryBefore(value: string, at: number): number {
    const space = value.lastIndexOf(' ', Math.max(0, at - 1));
    return space < 0 ? 0 : space + 1;
}

/**
 * `at`, backed up past `count` word boundaries.
 *
 * Not `wordBoundaryBefore` applied twice: that has a fixed point, because the
 * second call searches from `at - 1`, lands on the very space the first call
 * stepped over, and returns the same offset. Stepping one further left each
 * time is what makes the second word actually come along.
 */
function wordsBefore(value: string, at: number, count: number): number {
    let cut = at;
    for (let n = 0; n < count && cut > 0; n++) {
        cut = wordBoundaryBefore(value, cut - 1);
    }
    return cut;
}

/**
 * Truncates a slash-separated path by dropping **leading directories**.
 *
 * `truncate()` cuts the tail, which for a path removes the only part that
 * identifies it. `browser/extensions/formautofill/test/browser/browser_ml_heu…`
 * cannot be pasted into `fx-tests test`, cannot be grepped for, and cannot be
 * told apart from its neighbours — and feeding the next command is what this
 * output is for. The basename is what a reader recognises and what every other
 * command accepts as an argument, so it is the part that survives.
 *
 * The result is `…/` plus as many trailing segments as fit:
 *
 * ```
 * …/test/browser/browser_ml_heuristics.js
 * ```
 *
 * A basename longer than the budget on its own is still cut from the tail —
 * there is nothing else to drop — but that is a rare filename, not the common
 * case of a deep directory. Paths that fit are returned untouched, so the
 * `…/` prefix is itself the signal that something was dropped.
 */
export function truncatePath(value: string, maxWidth: number): string {
    if (maxWidth <= 0 || value.length <= maxWidth) {
        return value;
    }
    const segments = value.split('/');
    // Grow the tail one segment at a time while it still fits under the
    // budget, which the `…/` prefix eats two characters of.
    let kept = '';
    for (let i = segments.length - 1; i >= 0; i--) {
        const candidate = segments.slice(i).join('/');
        if (candidate.length + 2 > maxWidth) {
            break;
        }
        kept = candidate;
    }
    if (kept === '') {
        // Not even the basename fits. Keep its tail rather than its head: a
        // filename's distinguishing part is usually at the end
        // (`…_forms.html` vs `…_form.html`).
        const basename = segments[segments.length - 1] ?? value;
        return `…${basename.slice(Math.max(0, basename.length - (maxWidth - 1)))}`;
    }
    return `…/${kept}`;
}

/**
 * The "… n more" line for a truncated list, or `null` when nothing was cut.
 *
 * `CLI.md` specifies both the wording and the reason: an agent pasting output
 * into a prompt has to know the list is partial, and the flag that lifts the
 * limit belongs in the same line as the count.
 */
export function moreLine(total: number, shown: number, indent = '  '): string | null {
    const hidden = total - shown;
    if (hidden <= 0) {
        return null;
    }
    return `${indent}… ${hidden} more (--limit 0 for all)`;
}

/**
 * Applies a limit, returning the rows to show.
 *
 * `0` means everything, per `CLI.md`. `undefined` means the command's default,
 * which is the caller's to supply — a limit of "whatever the command thinks"
 * cannot live here.
 */
export function applyLimit<T>(items: readonly T[], limit: number | undefined): T[] {
    if (limit === undefined || limit === 0) {
        return [...items];
    }
    return items.slice(0, limit);
}

/**
 * Cuts one hand-built line's variable part to the terminal.
 *
 * For output assembled by hand rather than by `table()` — a count column and a
 * name, say — which otherwise misses the clamp the table applies. `prefixWidth`
 * is what the fixed part already occupies.
 *
 * Returns the text unchanged when truncation is off, so `--markdown` and
 * `--full-messages` stay whole.
 */
export function fitLine(value: string, prefixWidth = 0): string {
    const width = renderWidth();
    if (width === null) {
        return value;
    }
    return truncateTo(value, Math.max(MIN_CELL_WIDTH, width - prefixWidth));
}

/**
 * Greedy word wrap to a width, defaulting to the terminal's.
 *
 * Moved here from `cli/commands/guide.ts`, whose copy was justified as "local
 * and minimal because only the exit-code table needs it". That stopped being
 * true: a command's header prose has the same problem, and it is worse there,
 * because a header sentence is the *first* thing printed and was the longest
 * line in the output on a narrow terminal.
 *
 * Returns the text unwrapped when truncation is off, so `--markdown` and
 * `--full-messages` keep whole sentences on one line.
 */
export function wrapText(text: string, width: number | null = renderWidth()): string[] {
    if (width === null || width <= 0) {
        return [text];
    }
    const lines: string[] = [];
    let current = '';
    for (const word of text.split(' ')) {
        if (current === '') {
            current = word;
        } else if (current.length + 1 + word.length <= width) {
            current += ` ${word}`;
        } else {
            lines.push(current);
            current = word;
        }
    }
    if (current !== '') {
        lines.push(current);
    }
    return lines;
}

/** A percentage with one decimal, or `—` when there is no rate to state. */
export function percent(value: number | null | undefined, digits = 1): string {
    if (value === null || value === undefined) {
        return '—';
    }
    return `${value.toFixed(digits)}%`;
}

/** A signed percentage-point delta, or `=` when it is zero, `—` when unknown. */
export function delta(value: number | null | undefined, digits = 2): string {
    if (value === null || value === undefined) {
        return '—';
    }
    if (Math.abs(value) < 0.005) {
        return '=';
    }
    return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

/** A count with thousands separators. */
export function count(value: number): string {
    return value.toLocaleString('en-US');
}

/**
 * A date with its weekday.
 *
 * Every command that names a date prints the weekday with it, because
 * `CLI.md` and `FORMATS.md` both make the same point: push volume drops
 * several-fold at weekends (measured 2.6×), so an absolute count from a
 * Saturday is not comparable with one from a Thursday. The weekday is the
 * cheapest possible warning about that, and it is why this is a shared
 * function rather than each command formatting a date its own way.
 */
export function dateWithWeekday(date: string): string {
    const weekday = weekdayOf(date);
    return weekday === null ? date : `${date} (${weekday})`;
}

/** The weekday name of a `YYYY-MM-DD` date, or `null` if it is not one. */
export function weekdayOf(date: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return null;
    }
    // Parsed as UTC deliberately: these dates are calendar labels from the
    // data, not instants, and a local-time parse shifts them by a day for
    // anyone west of UTC.
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][parsed.getUTCDay()]!;
}

/** Whether a date falls on a Saturday or Sunday. */
export function isWeekend(date: string): boolean {
    const weekday = weekdayOf(date);
    return weekday === 'Sat' || weekday === 'Sun';
}

/** Joins sections, collapsing runs of blank lines. */
export function joinLines(lines: readonly (string | null)[]): string {
    const out: string[] = [];
    for (const line of lines) {
        if (line === null) {
            continue;
        }
        if (line === '' && (out.length === 0 || out[out.length - 1] === '')) {
            continue;
        }
        out.push(line);
    }
    while (out.length > 0 && out[out.length - 1] === '') {
        out.pop();
    }
    return out.join('\n');
}

/** A byte count in the largest unit that keeps it readable. */
export function bytes(value: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let scaled = value;
    let unit = 0;
    while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024;
        unit++;
    }
    return `${unit === 0 ? scaled : scaled.toFixed(1)} ${units[unit]}`;
}
