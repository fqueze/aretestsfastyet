/**
 * `fx-tests guide`, checked against the behaviour it describes.
 *
 * `CLI.md` asks for exactly this and gives the reason:
 *
 * > **Its factual claims should be test assertions, not prose to remember to
 * > update.** "Review it when caveats change" is the mitigation that always
 * > fails.
 *
 * So these tests do not check that the guide *says* something. They take each
 * mechanically-checkable claim and verify it against the running code: the
 * command is dispatched and the file it requests is compared with the file the
 * guide names, the exit codes are compared with `ExitCode`, the flags with the
 * real option specs, the defaults with what a real invocation produces.
 *
 * A guide that drifts from the code fails here rather than quietly misleading
 * whoever reads it — which, since the guide exists to be read *first*, is the
 * worst possible thing for it to do.
 *
 * The prose that remains unchecked is the prose no test could check: why a trap
 * matters, and how to approach an investigation.
 */

import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    type DataFileName,
    type DataSource,
    DataFileNotFoundError,
} from '../lib/sources/source.ts';
import { ExitCode } from '../cli/errors.ts';
import { captureStreams } from '../cli/context.ts';
import { diskCache } from '../cli/cache.ts';
import { GLOBAL_OPTION_SPECS } from '../cli/options.ts';
import { COMMAND_NAMES, run } from '../cli/main.ts';
import {
    COMMAND_FACTS,
    EXIT_CODE_FACTS,
    TRAPS,
    render,
} from '../cli/commands/guide.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

const FILES: Record<string, string> = {
    'xpcshell-timings/index.json': 'index.json',
    'mochitest-timings/index.json': 'index.json',
    'xpcshell-timings/xpcshell-issues.json': 'xpcshell-issues.json',
    'xpcshell-timings/xpcshell-00.json': 'xpcshell-00.json',
    'mochitest-timings/mochitest-00.json': 'mochitest-00.json',
    'xpcshell-timings/xpcshell-stats.json': 'xpcshell-stats.json',
    'mochitest-timings/mochitest-stats.json': 'mochitest-stats.json',
    'xpcshell-timings/xpcshell-2026-08-03-errors.json': 'xpcshell-2026-08-03-errors.json',
    'mochitest-timings/mochitest-2026-08-03-errors.json': 'mochitest-2026-08-03-errors.json',
    'manifest-timings/manifests.json': 'manifests.json',
};

function recordingSource(): DataSource & { requested: string[] } {
    const requested: string[] = [];
    return {
        name: 'fixtures',
        requested,
        async fetch(name: DataFileName): Promise<Uint8Array> {
            const key = `${name.index}/${name.filename}`;
            requested.push(key);
            const local = FILES[key];
            if (local === undefined) {
                throw new DataFileNotFoundError(name);
            }
            return new Uint8Array(await readFile(new URL(local, FIXTURES)));
        },
    };
}

async function invoke(
    argv: string[],
    overrides: Partial<Parameters<typeof run>[0]> = {}
): Promise<{ code: number; stdout: string; stderr: string; requested: string[] }> {
    const streams = captureStreams();
    const source = (overrides.source as DataSource & { requested: string[] }) ?? recordingSource();
    const code = await run({
        argv,
        streams,
        source,
        cache: diskCache({ directory: join(tmpdir(), 'fx-tests-never-used'), ttlMs: 0 }),
        ...overrides,
    });
    return {
        code,
        stdout: streams.stdout,
        stderr: streams.stderr,
        requested: (source as DataSource & { requested: string[] }).requested,
    };
}

// --- the guide runs ------------------------------------------------------

test('guide prints and is not empty', async () => {
    const { code, stdout } = await invoke(['guide']);
    assert.equal(code, ExitCode.Success);
    assert.ok(stdout.length > 2000, 'the guide should be substantial');
    assert.match(stdout, /TRAPS/);
    assert.match(stdout, /EXIT CODES/);
    assert.match(stdout, /WORKED INVESTIGATIONS/);
});

test('guide stays well under 400 lines', async () => {
    // `CLI.md`: "well under `profiler-cli guide`'s ~400 lines — long enough to
    // convey the traps, short enough that reading it is cheap". A guide nobody
    // finishes is a guide nobody reads.
    //
    // The upper bound is 200 rather than 400 because 400 turned out not to
    // bind: a 242-line version passed it and was still judged too long in
    // review. A budget that never fails is not a budget.
    const { stdout } = await invoke(['guide']);
    const lines = stdout.split('\n').length;
    assert.ok(lines < 200, `the guide is ${lines} lines; the budget is 200`);
    assert.ok(lines > 100, `the guide is only ${lines} lines — too short to cover the traps`);
});

test('the guide states no measurement that will drift', async () => {
    // The review finding this enforces: the guide documented the state of the
    // deployment on the day it was written — "the errors files exist for only
    // about 5 of the 21 dates", "71,272 of 433,836 runs", "63.6% of all
    // skipped runs", "103.2M markers". Every one of those is a reading, not a
    // property, and none would ever have been updated. The objection
    // generalises past the one item, so the check does too.
    //
    // A guide whose facts rot is worse than a shorter one, because its whole
    // claim on the reader is to be trusted first.
    const text = render();
    const forbidden: { pattern: RegExp; why: string }[] = [
        { pattern: /\b\d{1,3},\d{3}\b/, why: 'a raw measured count' },
        { pattern: /\b\d+\.\d+M\b/, why: 'a measured marker total' },
        { pattern: /\b\d+\.\d+%/, why: 'a percentage measured on one day' },
        { pattern: /\b\d+ (?:of|out of) (?:the )?\d+ dates\b/, why: 'a date census' },
        { pattern: /\babout (?:five|a sixth|\d+) of\b/, why: 'a hedged snapshot count' },
        { pattern: /\b\d+ ?(?:MB|megabytes)\b/, why: 'a file size' },
        { pattern: /\bmeasured on one day\b/i, why: 'a one-day measurement' },
    ];
    for (const { pattern, why } of forbidden) {
        const match = pattern.exec(text);
        assert.equal(
            match,
            null,
            `the guide states ${why} (${JSON.stringify(match?.[0])}), which will be wrong ` +
                `next month and will not be updated. State the shape of the fact, or get ` +
                `the number from the data at runtime.`
        );
    }
});

test('the guide does not print which file each command reads', async () => {
    // Cut in review as implementation detail the reader could not act on. The
    // facts are still asserted and still in `--json`; they are just not prose.
    const { stdout } = await invoke(['guide']);
    assert.doesNotMatch(stdout, /reads \{harness\}/);
    assert.doesNotMatch(stdout, /\{bucket\}/);
    // …but the table they came from is intact, so the round-trip check above
    // still has something to check.
    assert.ok(COMMAND_FACTS.every((fact) => fact.reads.length > 0));
});

test('the guide keeps every trap CLI.md says it exists for', async () => {
    // The shortening must not have cut the reason to have the guide. CLI.md
    // names four traps explicitly, and three more are the ones this project
    // has actually got wrong.
    const { stdout } = await invoke(['guide']);
    for (const required of [
        /overall failure rate hides a single-config perma-fail/,
        /[Aa]ll-zero manifest durations mean skipped/,
        /profile URL cannot be guessed/,
        /xpcshell file is a biased sample/,
        /[Ww]eekend counts are a fraction/,
        /`run-if` is not a disabled test/,
    ]) {
        assert.match(stdout, required, `the rewrite dropped a trap CLI.md asks for`);
    }
});

test('the errors-window trap points at the command instead of quoting a count', async () => {
    // The specific item the review objected to, and the shape of the fix:
    // where a fact has to be current, the guide sends the reader to the data
    // rather than restating a number that was true once.
    const trap = TRAPS.find((entry) => entry.id === 'errors-window')!;
    const body = trap.body.join(' ');
    assert.doesNotMatch(trap.title, /\b\d+\b/, 'the title must not pin a date count');
    assert.match(body, /fx-tests errors/, 'it must name the command that knows');

    // And the command really does report its own window, so the redirection
    // is not a promise the code fails to keep.
    const { stderr, code } = await invoke(['errors', '--day', '2026-07-20']);
    assert.equal(code, ExitCode.NotFound);
    assert.match(stderr, /dates in the window/);
});

test('guide takes no arguments', async () => {
    const { code, stderr } = await invoke(['guide', 'errors']);
    assert.equal(code, ExitCode.Usage);
    assert.match(stderr, /takes no arguments/);
});

// --- the facts are checked against behaviour -----------------------------

test('every command the guide describes exists and is dispatchable', async () => {
    // A guide naming a command that does not exist is worse than one omitting
    // it: the reader tries it and gets "unknown command".
    for (const fact of COMMAND_FACTS) {
        const { code, stdout } = await invoke([fact.name, '--help']);
        assert.equal(code, ExitCode.Success, `${fact.name} --help should succeed`);
        assert.ok(stdout.includes(fact.name), `${fact.name} --help should name itself`);
    }
});

test('every dispatchable command is described by the guide', async () => {
    // The other direction, which is the one that rots: a command added without
    // a guide entry is invisible to a reader who was told to read the guide.
    const { stdout } = await invoke(['--help']);
    const listed = [...stdout.matchAll(/^ {2}(\w[\w-]*) {2,}\S/gm)].map((match) => match[1]!);
    const described = new Set(COMMAND_FACTS.map((fact) => fact.name));
    for (const name of listed) {
        if (name === 'guide') {
            continue; // The guide does not need to describe itself.
        }
        assert.ok(described.has(name), `${name} is a command but the guide does not describe it`);
    }
    assert.ok(listed.length > 5, 'the help parse found suspiciously few commands');
});

test('the file each command is said to read is the file it asks for', async () => {
    // The claim most likely to go stale, and the one a reader most relies on.
    //
    // The check is a **round trip**: the guide's `reads` string is turned back
    // into a filename pattern by substituting the placeholders it uses, and
    // that pattern is matched against the filenames the command actually
    // requested. An earlier version compared loosely — "does the guide's string
    // contain something like this" — and two mutations survived it, one saying
    // `errors` reads the issues file and one saying `manifests` reads the stats
    // file. Both are exactly the error this test exists to catch, so the
    // comparison is now derived from `reads` alone.
    const cases: { name: string; argv: string[] }[] = [
        { name: 'test', argv: ['test', 'dom/indexedDB/test/unit/test_rename_objectStore_errors.js', '--json'] },
        { name: 'issues', argv: ['issues', '--json', '--limit', '1'] },
        { name: 'failures', argv: ['failures', '--json', '--limit', '1'] },
        { name: 'crashes', argv: ['crashes', '--json', '--limit', '1'] },
        { name: 'skips', argv: ['skips', '--json', '--limit', '1'] },
        { name: 'errors', argv: ['errors', '--json', '--limit', '1'] },
        { name: 'manifests', argv: ['manifests', '--json', '--limit', '1'] },
        { name: 'summary', argv: ['summary', '--json'] },
        { name: 'dates', argv: ['dates', '--json'] },
    ];
    for (const testCase of cases) {
        const fact = COMMAND_FACTS.find((f) => f.name === testCase.name);
        assert.ok(fact !== undefined, `the guide does not describe ${testCase.name}`);
        const { code, requested } = await invoke(testCase.argv);
        assert.equal(code, ExitCode.Success, `${testCase.name} failed`);

        const pattern = readsPattern(fact.reads);
        assert.ok(
            requested.some((name) => pattern.test(name.split('/').pop()!)),
            `the guide says ${testCase.name} reads "${fact.reads}" (${pattern}), ` +
                `but it actually read ${requested.join(', ')}`
        );
    }
});

/**
 * Turns a guide `reads` string into a filename pattern.
 *
 * The placeholders are the guide's own vocabulary — `{harness}`, `{date}`,
 * `{bucket}` — and everything else has to match literally. Deriving the pattern
 * from the guide's string rather than writing it alongside is what makes the
 * assertion a round trip: there is no second copy of the answer to keep in
 * sync, so a wrong `reads` value cannot agree with a matching wrong regex.
 */
function readsPattern(reads: string): RegExp {
    // `try` names two sources; the filename check applies to the latter.
    const filename = reads.split(' + ').pop()!.trim();
    const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = escaped
        .replace(/\\\{harness\\\}/g, '(?:xpcshell|mochitest)')
        .replace(/\\\{date\\\}/g, '\\d{4}-\\d{2}-\\d{2}')
        .replace(/\\\{bucket\\\}/g, '[0-9a-f]{2}');
    return new RegExp(`^${body}$`);
}

test('the guide is right that errors defaults to mochitest', async () => {
    const fact = COMMAND_FACTS.find((f) => f.name === 'errors')!;
    assert.equal(fact.defaultHarness, 'mochitest');
    // Against the behaviour, not against the string: run it with no --harness
    // and see which file it reads.
    const { requested } = await invoke(['errors', '--json', '--limit', '1']);
    assert.ok(requested.some((name) => name.includes('mochitest-') && name.includes('-errors.')));
    assert.ok(!requested.some((name) => name.includes('xpcshell-') && name.includes('-errors.')));
});

test('the guide is right about which commands have a surprising harness default', async () => {
    // `errors` and `intermittent` should carry `defaultHarness`. If another
    // command's default changed and the guide were not updated, this notices.
    //
    // `intermittent` defaults to mochitest for a different reason from
    // `errors`: its harness filter is a per-bug scan rather than a file choice,
    // so "both harnesses" would double the requests and leave a row's count
    // ambiguous. The default is checked against behaviour below.
    const surprising = COMMAND_FACTS.filter((fact) => fact.defaultHarness !== undefined);
    assert.deepEqual(surprising.map((fact) => fact.name), ['intermittent', 'errors']);

    // …and the ordinary default really is xpcshell for a tree-wide command.
    const { requested } = await invoke(['issues', '--json', '--limit', '1']);
    assert.ok(requested.some((name) => name.includes('xpcshell-issues.json')));
});

test('every default row limit the guide states is the real one', async () => {
    // Checked by asking for the default and for `--limit 0`, and comparing.
    const cases: Record<string, string[]> = {
        errors: ['errors', '--json'],
        issues: ['issues', '--json'],
        failures: ['failures', '--json'],
        crashes: ['crashes', '--json'],
        skips: ['skips', '--json'],
        manifests: ['manifests', '--json'],
    };
    for (const [name, argv] of Object.entries(cases)) {
        const fact = COMMAND_FACTS.find((f) => f.name === name)!;
        assert.ok(fact.defaultLimit !== undefined, `the guide states no default limit for ${name}`);
        const all = await invoke([...argv, '--limit', '0']);
        const total = (JSON.parse(all.stdout)['rows'] as unknown[]).length;
        const byDefault = await invoke(argv);
        const shown = (JSON.parse(byDefault.stdout)['rows'] as unknown[]).length;
        // Only meaningful where the fixture has more rows than the limit;
        // otherwise the default is not exercised and the check is skipped
        // rather than passed vacuously.
        if (total > fact.defaultLimit!) {
            assert.equal(
                shown,
                fact.defaultLimit,
                `${name} shows ${shown} rows by default, but the guide says ${fact.defaultLimit}`
            );
        } else {
            assert.equal(shown, total, `${name} truncated below its own default`);
        }
    }
});

test('the exit codes the guide lists are the ones the code defines', async () => {
    // Pinned against `ExitCode` rather than retyped, and checked to be
    // complete: a new code added without a guide entry fails here.
    const documented = new Set(EXIT_CODE_FACTS.map((fact) => fact.code));
    for (const [name, code] of Object.entries(ExitCode)) {
        assert.ok(documented.has(code), `exit code ${code} (${name}) is not in the guide`);
    }
    assert.equal(documented.size, Object.keys(ExitCode).length);
    // The guide prints them.
    const { stdout } = await invoke(['guide']);
    for (const fact of EXIT_CODE_FACTS) {
        assert.match(stdout, new RegExp(`^\\s+${fact.code}\\s+\\S`, 'm'));
    }
});

test('the guide is right that only crash produces exit 4', async () => {
    // The claim with real consequences for a script, so it is checked rather
    // than asserted. `crash` on a missing artifact is the producer.
    const artifacts: DataSource = {
        name: 'none',
        fetch(name) {
            return Promise.reject(new DataFileNotFoundError(name));
        },
    };
    const gone = await invoke(['crash', 'TASK', 'DUMP'], { taskArtifacts: artifacts });
    assert.equal(gone.code, ExitCode.Gone);

    // And a missing *index* file is exit 2, not 4 — the distinction the guide
    // draws between "never published" and "expired artifact".
    const empty: DataSource = {
        name: 'empty',
        fetch(name) {
            return Promise.reject(new DataFileNotFoundError(name));
        },
    };
    const missing = await invoke(['errors'], { source: empty });
    assert.notEqual(missing.code, ExitCode.Gone);
});

test('every flag the guide mentions in a workflow actually exists', async () => {
    // The workflows are prose, but the command lines in them are not: a reader
    // will paste them. Every `--flag` in the rendered guide has to be real.
    const text = render();
    const flags = new Set([...text.matchAll(/(?:^|\s)(--[a-z][a-z-]+)/g)].map((m) => m[1]!));
    // Collect every flag the CLI accepts anywhere, by asking each registered
    // command for its own `--help`.
    //
    // Derived from `COMMAND_NAMES` rather than from a hand-written list of
    // modules, because the list drifted: it omitted `flaky.ts` and then
    // `intermittent.ts`, so a workflow naming one of their flags would have
    // failed this check for the wrong reason — "no command accepts --scan" when
    // one does. Driving it off the dispatch table means a new command's flags
    // are in scope the moment it lands.
    const known = new Set(Object.keys(GLOBAL_OPTION_SPECS).map((name) => `--${name}`));
    for (const name of COMMAND_NAMES) {
        const { stdout: help } = await invoke([name, '--help']);
        for (const match of help.matchAll(/^ {2}(--[a-z][a-z-]*)/gm)) {
            known.add(match[1]!);
        }
    }
    for (const flag of flags) {
        assert.ok(known.has(flag), `the guide mentions ${flag}, which no command accepts`);
    }
    // Sanity: the scan found flags at all, so an empty set cannot pass.
    assert.ok(flags.size > 8, `only found ${flags.size} flags in the guide`);
});

test('the traps have distinct ids and non-empty bodies', () => {
    const ids = TRAPS.map((trap) => trap.id);
    assert.equal(new Set(ids).size, ids.length, 'trap ids must be distinct');
    for (const trap of TRAPS) {
        assert.ok(trap.title.length > 10, `${trap.id} has no real title`);
        assert.ok(trap.body.some((line) => line.length > 0), `${trap.id} has an empty body`);
    }
    // The traps `CLI.md` names explicitly as the reason `guide` exists.
    for (const required of [
        'errors-window',
        'manifest-zero-durations',
        'profiles-not-derivable',
        'perma-fail-rate',
    ]) {
        assert.ok(ids.includes(required), `the guide dropped the ${required} trap`);
    }
});

test('the errors-window trap matches what the command actually does', async () => {
    // The trap says a date inside the 21-day window can still have no errors
    // data, and that asking for one exits 2 naming the dates that do. Checked
    // against the behaviour: 2026-07-20 is in `index.json` and has no fixture.
    const { code, stderr } = await invoke(['errors', '--day', '2026-07-20']);
    assert.equal(code, ExitCode.NotFound);
    assert.match(stderr, /not published/);
    assert.match(stderr, /dates in the window/);
    // …and a date that does have data works, so the trap is about the window
    // and not about the flag being broken.
    const ok = await invoke(['errors', '--day', '2026-08-03', '--json', '--limit', '1']);
    assert.equal(ok.code, ExitCode.Success);
});

test('the issues-attribution trap matches what the commands actually refuse', async () => {
    // The trap says `--config` and `--minidumps` are refused on issues.json
    // rather than returning nothing. Both halves checked.
    const config = await invoke(['issues', '--config', 'linux']);
    assert.equal(config.code, ExitCode.Usage);
    const minidumps = await invoke(['crashes', '--minidumps']);
    assert.equal(minidumps.code, ExitCode.Usage);
    // And the trap is in the guide under the id the test names.
    assert.ok(TRAPS.some((trap) => trap.id === 'issues-attribution'));
});

test('the manifest-zero-durations trap matches the rule the command applies', async () => {
    const { stdout } = await invoke(['manifests', '--json', '--limit', '0']);
    const result = JSON.parse(stdout) as {
        zeroDurations: { zeroRuns: number; totalRuns: number };
        rows: { durations: unknown }[];
    };
    // The trap claims zero durations are common and mean skipped. Both are
    // checkable: the census is non-zero, and such rows carry no statistics.
    assert.ok(result.zeroDurations.zeroRuns > 0);
    const skipped = result.rows.filter((row) => row.durations === null);
    assert.ok(skipped.length > 0, 'the fixture must have a manifest skipped everywhere');
});

test('guide --json exposes the same facts the prose is built from', async () => {
    const { stdout } = await invoke(['guide', '--json']);
    const result = JSON.parse(stdout) as {
        commands: { name: string }[];
        exitCodes: { code: number }[];
        traps: { id: string }[];
    };
    // One source of truth: the JSON is the tables, and the text is rendered
    // from the same tables, so they cannot disagree.
    assert.deepEqual(
        result.commands.map((c) => c.name),
        COMMAND_FACTS.map((c) => c.name)
    );
    assert.deepEqual(
        result.exitCodes.map((c) => c.code),
        EXIT_CODE_FACTS.map((c) => c.code)
    );
    assert.deepEqual(result.traps.map((t) => t.id), TRAPS.map((t) => t.id));
});

test('the rendered guide contains each command and each trap title', async () => {
    const { stdout } = await invoke(['guide']);
    for (const fact of COMMAND_FACTS) {
        assert.ok(stdout.includes(fact.name), `the guide does not print ${fact.name}`);
        assert.ok(stdout.includes(fact.answers), `the guide does not print ${fact.name}'s answer`);
    }
    for (const trap of TRAPS) {
        assert.ok(stdout.includes(trap.title), `the guide does not print "${trap.title}"`);
    }
});

/**
 * The `intermittent` pointers on `issues --help` and `flaky --help` resolve, and
 * each describes the command it prints on.
 *
 * Two regressions, both of which happened:
 *
 * 1. The notes quote the guide trap's title so a reader can find it — `fx-tests
 *    guide` takes no topic argument and text mode renders `trap.title`, never
 *    `trap.id`, so the title is the only handle a text-mode reader has. Nothing
 *    asserted the quoted string matched, leaving a retitle free to silently
 *    break both pointers. This reads the title out of `TRAPS` rather than
 *    repeating the literal, so a retitle updates the expectation and cannot
 *    drift from it.
 * 2. The two notes shipped **byte-identical**, `flaky`'s being `issues`'
 *    sentence copied whole. It read "rather than the failures counted here",
 *    which is false of `flaky`: that command ranks TESTS carrying a flaky
 *    verdict — 1 or 0 per test on the per-test view — while `issues` ranks the
 *    fail+timeout+crash+skip union, whose top rows are routinely all skips. A
 *    contrast sentence that misdescribes its own command defeats its purpose,
 *    so the nouns are asserted per command and the two are asserted to differ.
 */
test('the `intermittent` pointer resolves and names each command’s own unit', async () => {
    const trap = TRAPS.find((t) => t.id === 'annotations-are-not-failures');
    assert.ok(trap, 'the annotations-are-not-failures trap is gone; the pointers name it');

    const { stdout: guide } = await invoke(['guide']);
    assert.ok(guide.includes(trap.title), 'the guide does not print the title the pointers quote');

    const nouns: Record<string, string> = {
        issues: 'the issues counted here',
        flaky: 'the tests counted flaky here',
    };
    const sentences: string[] = [];
    for (const [command, noun] of Object.entries(nouns)) {
        const { stdout } = await invoke([command, '--help']);
        // Unwrapped: the notes are hard-wrapped, so a phrase spanning a line
        // break is not a substring of the raw help text.
        const flat = stdout.replace(/\s+/g, ' ');
        assert.ok(
            flat.includes('`fx-tests intermittent` ranks'),
            `${command} --help does not point at intermittent`
        );
        assert.ok(
            flat.includes(noun),
            `${command} --help does not describe what ${command} itself counts ("${noun}")`
        );
        assert.ok(
            flat.includes(trap.title),
            `${command} --help does not quote the trap title verbatim, so the pointer dead-ends`
        );
        const sentence = flat.slice(flat.indexOf('`fx-tests intermittent` ranks'));
        sentences.push(sentence.slice(0, sentence.indexOf('".') + 2));
    }
    assert.notEqual(
        sentences[0],
        sentences[1],
        'issues and flaky carry the same sentence again; they count different things'
    );
});
