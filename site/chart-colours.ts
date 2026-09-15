/**
 * The one copy of the dashboards' issue-type chart palette.
 *
 * ## Why this file exists
 *
 * The same four colours — failure orange, timeout amber, crash red, skip grey —
 * were written out independently in `common-charts.js:305-317`,
 * `site/test.ts`, `site/issues.ts` and `site/tests.ts`. Four copies of one
 * decision, and they had already drifted: `tests.html` used the solid hue as a
 * bar's *fill* where the other pages use it as the border and fill with the
 * same hue at `0.7` alpha, which made the same series visibly more saturated on
 * one page than on another.
 *
 * ## Why not CSS variables
 *
 * They were the obvious answer and they do not fit. These values are consumed
 * by Chart.js as JavaScript strings — `backgroundColor` takes an *array* of
 * them, one per bar, which is how the selected day range is shaded — so a CSS
 * custom property would have to be read back with `getComputedStyle` on every
 * render, for every series, and parsed into that array. That is slower, it
 * fails silently to a transparent bar when a variable is missing or a
 * stylesheet has not loaded, and it puts the palette somewhere the type
 * checker cannot see it.
 *
 * A module gives what the CSS variable was wanted for — one definition, changed
 * in one place — and the build inlines it into each page, so there is no extra
 * request and no skew between a page and its palette.
 *
 * The CSS **rules** that colour a stat cell (`.stat-value.fail` and friends)
 * stay in each page's stylesheet: those are text colours on table cells, not
 * chart series, and nothing reads them from JavaScript.
 *
 * ## The shape
 *
 * Each entry is the pair the charts actually need: a translucent `bg` for the
 * bar and a solid `border` of the same hue. Keeping them together is the point
 * — the drift above was exactly a fill and a border coming apart.
 */

/** A bar's fill and its border. */
export interface ChartColour {
    /** The fill, `rgba(…)` so `withAlpha` can restate it. */
    bg: string;
    /** The border, the same hue at full strength. */
    border: string;
}

/**
 * The issue-type palette, verbatim from `old/test.html:1578`.
 *
 * `flaky` is not an issue type: it is `flaky.html`'s orange, for the
 * tests-per-day series, and it lives here so a page drawing both kinds of chart
 * has one import rather than two sources of colour.
 */
export const CHART_COLOURS = {
    fail: { bg: 'rgba(255, 140, 0, 0.7)', border: '#ff8c00' },
    timeout: { bg: 'rgba(255, 193, 7, 0.7)', border: '#ffc107' },
    crash: { bg: 'rgba(220, 53, 69, 0.7)', border: '#dc3545' },
    skip: { bg: 'rgba(108, 117, 125, 0.7)', border: '#6c757d' },
    /**
     * Flaky, for a per-*test* count rather than a per-occurrence one.
     *
     * **The same orange as `fail`**, deliberately. `flaky.html` used `#e8834a`
     * — a distinct, slightly redder orange — and putting the two charts in one
     * box made the mismatch obvious: the failures band and the flaky band mean
     * the same thing counted two ways, so two near-identical oranges read as a
     * mistake rather than as a distinction. Unified on the `fail` hue, which
     * is what `test.html`, `issues.html` and the drilldown pages already use;
     * `flaky.html` moved to it too.
     */
    flaky: { bg: 'rgba(255, 140, 0, 0.7)', border: '#ff8c00' },
} as const satisfies Record<string, ChartColour>;

/**
 * The solid hues, for the non-chart uses: a table's colour band, a tile's
 * left border, a legend swatch.
 *
 * Exported separately because those want the opaque colour rather than the
 * chart pair, and because `flaky.html`'s tiles and folder bars are CSS
 * classes — see that page's stylesheet, which carries the same values.
 */
export const SOLID = {
    flaky: '#ff8c00',
    stable: '#5cb85c',
    skipped: '#9b9b9b',
} as const;

/** Which palette entries exist. */
export type ChartColourName = keyof typeof CHART_COLOURS;

/**
 * The same colour at a different alpha.
 *
 * Derived rather than written out, so a faded bar is the same hue as its solid
 * form by construction. Two hand-written constants are how a highlight ends up
 * a slightly different colour from the thing it highlights.
 */
export function withAlpha(colour: string, alpha: number): string {
    return colour.replace(/[\d.]+\)$/, `${alpha})`);
}
