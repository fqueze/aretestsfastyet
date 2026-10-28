/**
 * Assembles the publishable site out of the built pages and the repository.
 *
 * `npm run pages` builds the migrated pages in `site/` and copies the assets
 * *they* reference. That is not the site: the other pages were never migrated.
 * This step merges the two into one tree — see `docs/DEPLOY.md` §2.
 *
 * ## Why the file lists are derived and not written down
 *
 * "The seventeen" stops being seventeen the moment a page is migrated or added,
 * and a stale literal list in a deploy script fails by publishing the wrong
 * thing rather than by erroring. So:
 *
 * - the unmigrated pages are *whatever `*.html` is at the repository root* —
 *   which is exactly the unmigrated set, because migrating a page moves it into
 *   `site/`. That invariant is the
 *   assumption this rests on, and `checkArtifact` re-derives the counts from
 *   the same directories rather than comparing against a number.
 * - the assets are found by `findSiblingAssets`, the scanner the page build
 *   already uses, run over the unmigrated pages. Their set is *not* the built
 *   pages' set — the unmigrated ones need `favicon-screenshots.svg` and
 *   `common-test-data.js`, which `tools/build-pages.ts` does not copy.
 *
 * ## Why it fails loudly rather than publishing what it managed to copy
 *
 * Three defects in this project reached a green run by producing less than they
 * should have and saying nothing: a page build that exited 0 with no sources, a
 * committed data file that was never copied so the page's `fetch` 404'd into a
 * chart missing six months of history, and a unit test that asserted the
 * truncated result. A `cp` that copies nothing is the same shape. So every copy
 * here is counted, and `checkArtifact` re-reads the finished tree and resolves
 * every relative reference in every page against it — which catches the class,
 * not just the files that were missing on the day this was written.
 */

import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findSiblingAssets } from './page-assets.ts';

/**
 * Committed files a page fetches by relative path but no scanner can see.
 *
 * `findSiblingAssets` matches `fetch('./name.json')` with a literal argument.
 * `docs.html` fetches its markdown from a variable — `fetch(entry.file)` over a
 * table of paths — so the scan returns nothing for it and the page would deploy
 * with every document 404ing. It degrades quietly, like the backfill did.
 *
 * Listed by hand because there is no pattern to match, and kept short on
 * purpose: anything that *can* be derived is derived. A missing one is a hard
 * error, so this list going stale fails the build rather than the page.
 */
export const EXTRA_DATA = [
    'README.md',
    'docs/CLI.md',
    'docs/DEPLOY.md',
    'docs/PARITY.md',
    'docs/PLAN.md',
    'lib/formats/FORMATS.md',
];

/** A relative reference found in a page, and where it was found. */
interface Reference {
    /** The page it appeared in, relative to the artifact root. */
    page: string;
    /** The referenced path, relative to that page's directory. */
    target: string;
}

/**
 * Every relative reference a page makes that has to resolve to a file.
 *
 * Deliberately broader than `findSiblingAssets`, which answers "what does the
 * build copy" and so ignores `.html`. This answers "what would 404", which
 * includes the page links.
 *
 * Skipped, because none of them name a file in the artifact: absolute URLs and
 * protocol-relative ones, anchors and bare queries, `data:` URIs, and anything
 * containing a `${` template placeholder — those are computed at runtime from
 * data and cannot be resolved here.
 */
const REFERENCE = /(?:src|href)="([^"]+)"/g;

/**
 * A `fetch` of a literal sibling path, which no tag mentions.
 *
 * Markup alone is not enough, and this is the exact shape of the bug that
 * started all of this: `index.html` gets its backfill with
 * `fetch('./mochitest-stats-backfill.json')`, so a check that reads only
 * `src=` and `href=` calls the artifact complete with the file absent, and the
 * page quietly draws six months less history. Both `./name` and a bare `name`
 * are matched, so a page dropping the prefix does not blind the scanner.
 */
const FETCHED = /fetch\(\s*(["'`])(\.\/)?([\w.-]+\.(?:json|md|js|css|svg))\1\s*\)/g;

/**
 * Files a page asks the server for that this check knows may be absent.
 *
 * One entry, and it is not a workaround: no xpcshell backfill has ever existed,
 * because only the mochitest history needed repairing. The built `index.html`
 * fetches it anyway and handles the 404, which `site/index.ts` declares with a
 * `build-optional` marker. This check reads built pages, not their sources, so
 * the exemption is named here.
 */
const MAY_BE_ABSENT = new Set(['xpcshell-stats-backfill.json']);

export function findReferences(page: string, html: string): Reference[] {
    const found = new Map<string, Reference>();
    const want = (raw: string): void => {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|[#?])/i.test(raw)) return;
        if (raw.includes('${')) return;
        // A query or fragment is addressing state within the target, not a
        // different file: `green.html#mochitest` is a reference to green.html.
        const target = raw.replace(/[?#].*$/, '').replace(/^\.\//, '');
        if (target === '' || MAY_BE_ABSENT.has(target)) return;
        found.set(target, { page, target });
    };

    REFERENCE.lastIndex = 0;
    for (const match of html.matchAll(REFERENCE)) want(match[1]!);
    FETCHED.lastIndex = 0;
    for (const match of html.matchAll(FETCHED)) want(match[3]!);

    return [...found.values()].sort((a, b) => a.target.localeCompare(b.target));
}

/** What the assembly produced, for the log and for the caller's assertions. */
export interface Assembly {
    /** Pages built from `site/` and already present in the output. */
    built: string[];
    /** Unmigrated pages copied from the repository root. */
    unmigrated: string[];
    /** Shared assets and committed data copied beside them. */
    assets: string[];
}

/** Lists a directory's `.html` files, sorted, failing if there are none. */
async function pagesIn(dir: string, what: string): Promise<string[]> {
    const entries = await readdir(dir).catch((cause: unknown) => {
        throw new Error(`Cannot read ${what} at ${dir}`, { cause });
    });
    const pages = entries.filter((name) => name.endsWith('.html')).sort();
    if (pages.length === 0) {
        throw new Error(`No .html pages in ${dir}. Expected the ${what} to be there.`);
    }
    return pages;
}

/** The shared files the unmigrated pages need beside them. */
async function findSharedAssets(root: string, pages: readonly string[]): Promise<string[]> {
    const assets = new Set<string>();
    for (const page of pages) {
        const html = await readFile(join(root, page), 'utf8');
        for (const asset of findSiblingAssets(html)) {
            if (asset.required) assets.add(asset.name);
        }
    }
    return [...assets].sort();
}

/** Copies one file, failing with both paths named rather than a bare ENOENT. */
async function copy(from: string, to: string): Promise<void> {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to).catch((cause: unknown) => {
        throw new Error(`Cannot copy ${from} to ${to}`, { cause });
    });
}

/**
 * Merges the built pages and the unmigrated pages into `outDir`.
 *
 * `outDir` is expected to already hold the output of `npm run pages` and to
 * hold nothing else — see the note on freshness in `docs/DEPLOY.md` §2. This
 * adds to it; it never deletes, so a caller that reuses a directory publishes
 * whatever was left in it.
 */
export async function assemble(root: string, outDir: string): Promise<Assembly> {
    const built = await pagesIn(outDir, 'built pages');
    // The root's `*.html` are exactly the unmigrated pages: migrating one moves
    // its source into `site/`, so nothing that has been migrated is left here.
    const unmigrated = await pagesIn(root, 'unmigrated pages');

    const assets = [...(await findSharedAssets(root, unmigrated)), ...EXTRA_DATA].sort();

    for (const page of unmigrated) {
        await copy(join(root, page), join(outDir, page));
    }
    for (const asset of assets) {
        // The root already has whatever the built pages needed; this adds the
        // ones only the unmigrated pages reference, and overwrites the rest
        // with identical bytes from the same source.
        await copy(join(root, asset), join(outDir, asset));
    }

    // Without it Pages runs the tree through Jekyll, which drops files whose
    // name begins with `_`. Nothing here does today; the failure when something
    // does is a silent 404.
    await writeFile(join(outDir, '.nojekyll'), '');

    return { built, unmigrated, assets };
}

/**
 * Re-reads the finished artifact and fails if it is not a complete site.
 *
 * Separate from `assemble` and reading from disk rather than from what
 * `assemble` returned, on purpose: a check that trusts the assembler's own
 * account of its work cannot catch the assembler being wrong. This is the guard
 * against the failure this project keeps hitting — a step that copies less than
 * it should and reports success.
 */
export async function checkArtifact(root: string, outDir: string): Promise<string[]> {
    const problems: string[] = [];

    const expectedBuilt = (await pagesIn(join(root, 'site'), 'page sources')).length;
    const expectedUnmigrated = (await pagesIn(root, 'unmigrated pages')).length;

    // Reported, not thrown: an assembly that copied no pages at all is the most
    // complete version of the failure this function exists to catch, and it
    // should come out as the same kind of message as a partial one.
    const rootPages = (await readdir(outDir).catch(() => [])).filter((name) => name.endsWith('.html'));

    const wantRoot = expectedBuilt + expectedUnmigrated;
    if (rootPages.length !== wantRoot) {
        problems.push(
            `the artifact root has ${rootPages.length} pages, expected ${wantRoot} ` +
                `(${expectedBuilt} built from site/ plus ${expectedUnmigrated} unmigrated)`
        );
    }

    // The check that would have caught the backfill bug, stated as a property
    // rather than as a filename: everything every page asks for must be there.
    for (const page of rootPages) {
        const html = await readFile(join(outDir, page), 'utf8');
        for (const { target } of findReferences(page, html)) {
            const resolved = join(outDir, dirname(page), target);
            await readFile(resolved).catch(() => {
                problems.push(`${page} references ${target}, which is not in the artifact`);
            });
        }
    }

    for (const name of ['.nojekyll', ...EXTRA_DATA]) {
        await readFile(join(outDir, name)).catch(() => {
            problems.push(`${name} is missing from the artifact`);
        });
    }

    return problems;
}

/** `true` when this module is being run rather than imported. */
const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);

if (isMain) {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const outDir = process.env['FX_SITE_OUT'] ?? join(root, 'dist-site');

    const { built, unmigrated, assets } = await assemble(root, outDir);
    console.log(
        `Assembled ${outDir}: ${built.length} built, ${unmigrated.length} unmigrated, ` +
            `${assets.length} assets.`
    );

    const problems = await checkArtifact(root, outDir);
    if (problems.length > 0) {
        console.error(
            `The assembled site is incomplete, so it must not be published:\n` +
                problems.map((problem) => `  - ${problem}`).join('\n')
        );
        process.exit(1);
    }
    console.log('Every page and every reference it makes is present in the artifact.');
}
