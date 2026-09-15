/**
 * Builds the migrated dashboard pages in `site/` into self-contained HTML.
 *
 * ## Why a build exists here at all, when the other pages have none
 *
 * The dashboards are served exactly as they appear in the tree, and that is
 * worth keeping: editing a page and reloading it is the whole loop, with no
 * toolchain between the author and the browser. The migrated pages give that
 * up for one thing only — being able to `import` the typed, tested code in
 * `lib/` instead of carrying a fourth copy of it inline.
 *
 * The unmigrated pages are untouched by this script. It reads `site/` and
 * writes `dist-site/`; it never opens a page in the repository root, and
 * nothing it writes lands on top of one. A page is migrated exactly when its
 * source moves into `site/`, so there is no state where the same page has two
 * live definitions.
 *
 * ## Why the output is a single file with everything inlined
 *
 * A page that loads a shared `.js` alongside it can be served a stale copy of
 * one and a fresh copy of the other — the CDN caches them independently, and
 * this project has already lost time to exactly that (a deployed page throwing
 * `ReferenceError` from a cached shared script that no longer matched). Inlining
 * makes a page atomic: one request, one version, no skew possible between the
 * markup and the code it depends on.
 *
 * It also keeps the deployed artefact the same *kind* of thing as the pages it
 * sits next to — a static HTML file with its CSS and JS inside it — so the
 * migration does not change how the site is served.
 *
 * ## What is *not* inlined, and why that needs its own scan
 *
 * The shared `.js`, the CSS and the committed data files stay separate files
 * and are copied next to the built page. Which ones a page needs is worked out
 * by `tools/page-assets.ts`, over both the markup and the bundled code — see
 * that file for the bug that forced the second half of that.
 */

import { build, transformSync } from 'esbuild';
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type SiblingAsset, findSiblingAssets } from './page-assets.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(root, 'site');
// Overridable so the freshness check can build to a scratch directory, the
// same arrangement `tools/build-cli.ts` uses.
const outDir = process.env['FX_PAGES_BUILD_OUT'] ?? join(root, 'dist-site');

/**
 * The marker a source page uses to say "the bundle goes here".
 *
 * A page writes `<script type="module" src="./main.ts"></script>` and the build
 * replaces that whole tag with an inline `<script type="module">` holding the
 * bundled result. Matching a real script tag rather than a bespoke comment
 * keeps the source page well-formed HTML, so an editor treats it as a page and
 * the markup can be diffed against the built output.
 *
 * That is a statement about the *markup*, not about the page working: the
 * source page cannot be loaded from the tree, because its entry point is a
 * `.ts` file that a server labels `video/mp2t` and the browser then refuses as
 * a module. Editing a page in `site/` means re-running `npm run pages`. This
 * paragraph replaces a pointer to a "note on the development loop at the bottom
 * of this file" that was never written, and which a reader followed to the
 * opposite conclusion.
 */
const MODULE_SCRIPT = /<script\s+type="module"\s+src="\.\/([\w.-]+\.ts)"\s*><\/script>/g;

/**
 * A page's Web Worker entry points, declared by the page's own markup.
 *
 * A page writes `<!-- worker: ./try-flakiness-worker.ts -->` and the build
 * bundles that entry separately, then makes the bundled source available to the
 * page's module as a string on `globalThis.__workers`. The page builds its
 * `Blob` from that string.
 *
 * ## Why a worker cannot simply be imported
 *
 * A `new Worker(new URL('./w.ts', import.meta.url))` would be a second request
 * for a second file, which is exactly the CDN-skew problem the single-file
 * output exists to prevent (see the note at the top of this file). So the
 * worker's code has to travel *inside* the page, as text.
 *
 * That leaves the question of where the text comes from, and the answer cannot
 * be `.toString()` on the imported functions — which is what `try.html` does
 * today (`old/try.html:2584`) and what forced this build change. `.toString()`
 * returns the *bundled* source of a function: esbuild has renamed its
 * identifiers, and its transitive dependencies are other renamed functions that
 * a `.toString()` of the top one does not include. The concatenated program
 * would reference names that do not exist in the worker's scope and throw
 * `ReferenceError` on the first message — silently, because the page's `catch`
 * treats a worker error as "no history for these tests".
 *
 * Giving the worker its own entry point makes esbuild's job the ordinary one:
 * it follows the imports, inlines the bodies, and emits a self-contained
 * program. `checkWorkerSelfContained` asserts that it really is.
 */
const WORKER_DIRECTIVE = /<!--\s*worker:\s*\.\/([\w.-]+\.ts)\s*-->/g;

/** The global the built page reads its worker sources off. */
const WORKER_GLOBAL = '__workers';

interface BuiltPage {
    name: string;
    bytes: number;
    inlined: number;
    assets: string[];
    /** `name -> bundled bytes`, for the build log. */
    workers: [string, number][];
}

/** One esbuild run: the program, and every source that went into it. */
interface Bundle {
    code: string;
    /** Repo-relative paths, as esbuild's metafile reports them. */
    inputs: string[];
}

/**
 * Bundles one TypeScript entry point into a single string of browser JS.
 *
 * `format: 'esm'` and no `platform: 'node'`: these run in a browser, so a
 * `lib/` module that reached for a node builtin must fail the build here rather
 * than at page load. Nothing in `lib/model` or `lib/formats` imports one today,
 * which is what makes them shareable at all.
 */
async function bundleEntry(entry: string, format: 'esm' | 'iife' = 'esm'): Promise<Bundle> {
    const result = await build({
        entryPoints: [entry],
        bundle: true,
        // Names every file that went into the bundle, which is how the sibling
        // scan finds the `build-optional` markers: esbuild strips ordinary
        // comments, so they have to be read back out of the sources, and only
        // esbuild knows which sources those were.
        metafile: true,
        // Workers are created from a Blob with no `type: 'module'`, so they are
        // *classic* workers and an `export` at top level is a syntax error in
        // one. `iife` is what makes the bundle a plain program; the page's own
        // script stays `esm` because it is inlined into a module script tag.
        format,
        target: 'es2022',
        platform: 'browser',
        write: false,
        // Not minified, for the same reason the CLI is not: these are read by
        // people debugging a dashboard, and the bytes saved are not worth a
        // stack trace nobody can follow. The pages are small and gzip well.
        minify: false,
        // Inlined into HTML, where a `//# sourceMappingURL` pointing at a file
        // that will not be deployed is worse than no source map at all.
        sourcemap: false,
        external: [],
        logLevel: 'silent',
    });
    const [file] = result.outputFiles ?? [];
    if (file === undefined) {
        throw new Error(`esbuild produced no output for ${entry}`);
    }
    return { code: file.text, inputs: Object.keys(result.metafile.inputs) };
}

/** Builds one page, returning what it produced. */
async function buildPage(name: string): Promise<BuiltPage> {
    const source = await readFile(join(sourceDir, name), 'utf8');

    // Workers first: their source becomes a string constant the page's own
    // bundle reads, so it has to exist before that bundle is spliced in.
    WORKER_DIRECTIVE.lastIndex = 0;
    const workerNames = [...source.matchAll(WORKER_DIRECTIVE)].map((match) => match[1]!);
    const workerSources = await Promise.all(
        workerNames.map((worker) => bundleEntry(join(sourceDir, worker), 'iife'))
    );
    for (const [index, worker] of workerNames.entries()) {
        checkWorkerSelfContained(name, worker, workerSources[index]!.code);
    }
    const workers: [string, number][] = workerNames.map((worker, index) => [
        worker,
        workerSources[index]!.code.length,
    ]);

    let inlined = 0;
    const replacements: Promise<Bundle>[] = [];
    // `String.replace` cannot await, so collect the bundles first and splice
    // them in afterwards. The regex is stateful (`g`), hence the explicit reset.
    MODULE_SCRIPT.lastIndex = 0;
    const entries = [...source.matchAll(MODULE_SCRIPT)];
    for (const match of entries) {
        replacements.push(bundleEntry(join(sourceDir, match[1]!)));
    }
    const bundles = await Promise.all(replacements);

    // The prelude that carries the worker sources into the page's module scope.
    // `JSON.stringify` is what makes an arbitrary program safe to embed in a
    // string literal — it escapes the quotes, the backslashes and the newlines,
    // and `checkSafe` separately asserts no `</script` survives anywhere in the
    // emitted script.
    const workerPrelude =
        workerNames.length === 0
            ? ''
            : `globalThis.${WORKER_GLOBAL} = {\n` +
              workerNames
                  .map(
                      (worker, index) =>
                          `  ${JSON.stringify(worker)}: ${JSON.stringify(workerSources[index]!.code)},`
                  )
                  .join('\n') +
              '\n};\n';

    let output = source;
    for (const [index, match] of entries.entries()) {
        // No escaping pass here: esbuild already emits `<\/script>` for a
        // `</script>` in a string literal, and re-escaping what it produced was
        // both dead code and — when the round-trip guard below undid it — a
        // build failure on any page whose source contains the literal. What is
        // left is the check that this holds, in `checkSafe`.
        //
        // **The replacement is a function, and that is load-bearing.** Passing
        // the bundle as a *string* makes `String.replace` read `$&`, `` $` ``,
        // `$'` and `$1` in it as replacement patterns: a page whose code
        // contained `'\\$&'` — an ordinary thing to write, since it is how a
        // regex replacement refers to the whole match — had the `<script>` tag
        // itself substituted into that string literal, and the built page threw
        // `SyntaxError: missing ) after argument list` at load. A function
        // replacement is inserted verbatim, with no pattern expansion.
        //
        // `checkSafe` did not catch it: it wraps the bundle in an *async*
        // arrow before parsing, and the corruption happened to leave something
        // that parsed in that position while failing as a module. It now
        // parses the emitted script as written, below.
        const replacement =
            `<script type="module">\n${workerPrelude}${bundles[index]!.code}\n</script>`;
        output = output.replace(match[0], () => replacement);
        inlined++;
    }

    if (inlined === 0) {
        // A page in `site/` that inlines nothing is almost certainly a typo in
        // the script tag rather than a page that genuinely needs no code — and
        // it would deploy as a blank dashboard.
        throw new Error(
            `${name} has no <script type="module" src="./*.ts"> tag, so nothing was inlined. ` +
                'A migrated page is expected to import from lib/; check the tag spelling.'
        );
    }

    // Every source that went into any of this page's bundles, for the
    // `build-optional` markers esbuild strips out of the generated code.
    const inputs = [...new Set([...bundles, ...workerSources].flatMap((bundle) => bundle.inputs))];
    const sources = await Promise.all(inputs.map((input) => readFile(join(root, input), 'utf8')));

    // Validate before writing, not after. Writing first means a build that
    // fails still replaces the previous good artefact with the broken one, so
    // the deploy ships it and the non-zero exit is the only clue. That applies
    // to the sibling check too: a page whose data file is missing is broken,
    // and must not overwrite the working copy of itself.
    checkSafe(name, [...bundles, ...workerSources].map((bundle) => bundle.code));
    // And again on the spliced result, which is what actually gets served.
    checkSpliced(name, output);
    const assets = await resolveAssets(name, output, sources);
    await writeFile(join(outDir, name), output);
    await copyAssets(assets);
    return { name, bytes: output.length, inlined, assets: assets.map((a) => a.name), workers };
}

/**
 * Fails the build if a worker bundle still needs something from outside itself.
 *
 * This is the check that the worker problem is actually solved. A worker created
 * from a `Blob` runs as a classic script with no module loader and no access to
 * the page's scope, so a surviving `import` is not a slow path — it is a
 * `SyntaxError` at worker construction, which surfaces as an `error` event the
 * page turns into "no data for these tests".
 *
 * Both directions are checked because they fail differently: an `import` means
 * esbuild did not bundle (wrong format or an `external`), while an `export`
 * means it emitted an ES module, which a classic worker also refuses to parse.
 */
function checkWorkerSelfContained(page: string, worker: string, bundle: string): void {
    // Anchored to a line start, so `import(` inside a string or a comment
    // mentioning the word does not trip it. esbuild emits statements at column
    // zero of their own line in the `iife` output.
    const bare = /^(?:import|export)\b/m.exec(bundle);
    if (bare !== null) {
        const line = bundle.slice(0, bare.index).split('\n').length;
        throw new Error(
            `${page}: the worker bundle ${worker} still has a top-level ` +
                `'${bare[0]}' at line ${line}. A Blob worker is a classic script — it ` +
                'cannot resolve an import and cannot parse an export, so this would fail ' +
                'at worker construction and the page would silently show no data. ' +
                'Check that the entry point is bundled with format: iife and no externals.'
        );
    }
}

/**
 * Works out which siblings this page needs and checks they all exist.
 *
 * A missing one is a hard error rather than a warning, and the reason is the
 * whole point of `tools/page-assets.ts`: the symptom of a page that cannot load
 * `shared.js` is a dashboard that renders its markup and then does nothing, and
 * the symptom of one that cannot load its committed data file is worse still —
 * `site/index.ts` treats a 404 backfill as "there is no backfill" and drew six
 * months less history for a week without anything failing.
 *
 * Returns the assets that should actually be copied: everything required, plus
 * the `build-optional` ones that happen to exist.
 */
async function resolveAssets(
    name: string,
    html: string,
    sources: readonly string[]
): Promise<SiblingAsset[]> {
    const wanted = findSiblingAssets(html, sources);
    const present: SiblingAsset[] = [];
    for (const asset of wanted) {
        try {
            await access(join(root, asset.name));
        } catch (error) {
            if (!asset.required) {
                // Declared `build-optional` at the fetch site and genuinely
                // absent — nothing to copy, and the page already handles the
                // 404 it will get.
                continue;
            }
            throw new Error(
                `${name} references ${asset.name}, which is not in the repository root: ` +
                    `${String(error)}. If the page fetches it and it is allowed to be ` +
                    "missing, put a `// build-optional:` comment before the fetch."
            );
        }
        present.push(asset);
    }
    return present;
}

/** Copies the resolved siblings next to the built page. */
async function copyAssets(assets: readonly SiblingAsset[]): Promise<void> {
    for (const asset of assets) {
        await copyFile(join(root, asset.name), join(outDir, asset.name));
    }
}

/**
 * Fails the build if an inlined bundle would not survive being put inside HTML.
 *
 * The CLI build has an equivalent guard for a reason that applies here twice
 * over: it once emitted a file with two shebang lines, reported success, and
 * shipped something Node refused to parse. A page is worse — the only symptom
 * of a bundle mangled on its way into the HTML is a blank dashboard and a
 * console error nobody is watching for.
 *
 * Two distinct checks, because they fail differently:
 *
 * 1. **No unescaped `</script>`.** This is the one that silently truncates: the
 *    HTML parser closes the tag at the first occurrence wherever it appears,
 *    leaving valid-looking markup whose script stops mid-statement. esbuild
 *    escapes these itself, so this asserts that guarantee rather than
 *    re-implementing it — an earlier version escaped again and then "verified"
 *    the result by undoing esbuild's escaping, which failed every build of a
 *    page whose source contained the literal string.
 * 2. **The bundle parses.** Catches a corrupt splice from any other cause.
 */
function checkSpliced(name: string, html: string): void {
    // Every inline module script in the built page, checked **as it will be
    // served**. `checkSafe` runs on the bundles before they are spliced in, so
    // by construction it cannot see a splice that corrupted one — which is
    // exactly the bug that shipped: a `'\\$&'` in a page's own source made
    // `String.replace` substitute the matched `<script>` tag into a string
    // literal, and the page threw `SyntaxError` at load with every test and the
    // build itself green.
    const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
    if (scripts.length === 0) {
        throw new Error(`${name}: no inline module script in the built page`);
    }
    for (const [index, script] of scripts.entries()) {
        const code = script[1]!;
        try {
            // Parsed the way the browser will treat it: as a module, not as a
            // function body. That distinction is the point — `new Function`
            // wraps its argument, which both changes what is legal (`import` is
            // a syntax error in a function body and fine in a module) and is
            // what let the corrupted script through.
            parseAsModule(code);
        } catch (error) {
            throw new Error(
                `${name}: inline script ${index + 1} of ${scripts.length} does not parse as ` +
                    `served: ${String(error)}`
            );
        }
    }
}

/**
 * Parses source as an ES module, throwing on a syntax error.
 *
 * Done with esbuild rather than with `new Function`, which builds a *function
 * body* and so asks the wrong question: `import` is illegal there and legal in
 * a module, and a corruption can leave something that parses as a function body
 * while failing as a module — which is precisely what happened. esbuild is
 * already a dependency and is the thing that produced the code, and it parses
 * without executing.
 */
function parseAsModule(code: string): void {
    transformSync(code, { loader: 'js', format: 'esm' });
}

function checkSafe(name: string, bundles: readonly string[]): void {
    for (const bundle of bundles) {
        // Deliberately assembled so this source file does not itself contain
        // the literal sequence it is looking for.
        const closing = '</' + 'script';
        const at = bundle.indexOf(closing);
        if (at !== -1) {
            throw new Error(
                `${name}: the bundle contains an unescaped ${closing}>, which would close the ` +
                    `tag early and truncate the page's script (at offset ${at}: ` +
                    `${JSON.stringify(bundle.slice(Math.max(0, at - 40), at + 40))}). esbuild ` +
                    'normally escapes this; something downstream of it has not.'
            );
        }
        try {
            // `new Function` parses without executing. The async wrapper is
            // what lets a bundle using top-level await through — esbuild emits
            // one for any page that fetches its data at module scope.
            new Function(`return async () => {${bundle}}`);
        } catch (error) {
            throw new Error(`${name}: the inlined bundle does not parse: ${String(error)}`);
        }
    }
}

// An empty `site/` was a valid state while the migration had not started. It is
// not one now: nine pages are checked in, so finding none means a broken
// checkout or a wrong path, and the deploy must not treat that as success.
// Exiting 0 here once let a typo in this file — `join(root, 'next')` surviving
// the rename to `site/` — print "nothing to build" and report success.
const entries = await readdir(sourceDir).catch((cause: unknown) => {
    throw new Error(`Cannot read the page sources at ${sourceDir}`, { cause });
});
const sources = entries.filter((name) => name.endsWith('.html'));
if (sources.length === 0) {
    throw new Error(`No .html pages in ${sourceDir}. Expected the migrated pages to be there.`);
}

await mkdir(outDir, { recursive: true });
const built: BuiltPage[] = [];
for (const name of sources) {
    built.push(await buildPage(name));
}
for (const page of built) {
    const kb = (page.bytes / 1024).toFixed(1);
    const assets = page.assets.length > 0 ? `, ${page.assets.length} assets copied` : '';
    const workers = page.workers
        .map(([worker, bytes]) => `, ${worker} worker ${(bytes / 1024).toFixed(1)} kB`)
        .join('');
    console.log(
        `Built ${join(outDir, page.name)} (${kb} kB, ${page.inlined} script inlined${workers}${assets})`
    );
}
