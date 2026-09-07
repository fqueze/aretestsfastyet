#!/bin/bash
# Mutation campaign for the try/try.html divergence fixes:
#
#   1. the default ordering — failing executions descending, as the page's
#      `{ column: 'count', ascending: false }` default sorts (old/try.html:744),
#      with a deterministic path tiebreak the page cannot have
#   2. the rerun sentence scoped to the configurations it applies to, so a
#      perma-fail row does not appear to contradict itself
#   3. the streamed-profile diagnostic — a job killed for exceeding its
#      maximum duration told apart from a genuine read failure
#
# Same rules as tools/mutations-trybugs.sh, and the same reason for being
# checked in: a mutation score nobody can reproduce is not a number. Each entry
# is one textual substitution that changes behaviour; `tools/mutate.sh` treats
# an absent or ambiguous pattern as a hard error and runs the whole suite.
#
# Usage: tools/mutations-try-ordering.sh [-k]   (-k stops at the first survivor)

cd "$(dirname "$0")/.." || exit 2
# See tools/node-env.sh: resolves node without naming a specific install.
. "$(dirname "$0")/node-env.sh"

STOP_ON_SURVIVOR=0
[ "${1:-}" = "-k" ] && STOP_ON_SURVIVOR=1

TOTAL=0
KILLED=0
SURVIVED=0
ERRORS=0
SURVIVOR_LIST=""

mutate() {
    TOTAL=$((TOTAL + 1))
    tools/mutate.sh "$1" "$2" "$3" "$4"
    case $? in
        0) KILLED=$((KILLED + 1)) ;;
        1)
            SURVIVED=$((SURVIVED + 1))
            SURVIVOR_LIST="${SURVIVOR_LIST}  $4 ($1)"$'\n'
            [ "$STOP_ON_SURVIVOR" = "1" ] && summary && exit 1
            ;;
        *) ERRORS=$((ERRORS + 1)) ;;
    esac
}

summary() {
    echo
    echo "===== try-ordering mutation campaign"
    echo "total     $TOTAL"
    echo "killed    $KILLED"
    echo "SURVIVED  $SURVIVED"
    echo "errors    $ERRORS"
    [ -n "$SURVIVOR_LIST" ] && printf '%s' "$SURVIVOR_LIST"
    return 0
}

# --- 1: the default ordering --------------------------------------------

# The whole fix: back to ranking on distinct failing job runs, which is what
# made the section order differ from the page's on every push where the
# harness reran a test.
mutate cli/commands/try.ts \
    '        (a, b) => b.failureCount - a.failureCount || a.path.localeCompare(b.path)' \
    '        (a, b) => b.failedRuns - a.failedRuns || a.path.localeCompare(b.path)' \
    'ranking is on job runs again, not on failing executions'

# The direction. Ascending puts the least interesting failure first.
mutate cli/commands/try.ts \
    '        (a, b) => b.failureCount - a.failureCount || a.path.localeCompare(b.path)' \
    '        (a, b) => a.failureCount - b.failureCount || a.path.localeCompare(b.path)' \
    'the count sorts ascending'

# The tiebreak, which is what makes the output reproducible.
mutate cli/commands/try.ts \
    '        (a, b) => b.failureCount - a.failureCount || a.path.localeCompare(b.path)' \
    '        (a, b) => b.failureCount - a.failureCount' \
    'ties are left in insertion order, as the page leaves them'

# The counter itself: one per failing execution, not one per test.
mutate cli/commands/try.ts \
    '        entry.failureCount++;' \
    '        entry.failureCount = 1;' \
    'every test reports a single failure'

# --- 2: the rerun sentence, scoped --------------------------------------

# The scoping, removed: back to a sentence that names no configuration.
mutate cli/commands/try.ts \
    '    return `Passed when the harness reran it in the same job on ${where} — intermittent there.`;' \
    '    return `Passed when the harness reran it in the same job — intermittent.`;' \
    'the rerun sentence names no configuration'

# Which configs go in the sentence. The accumulator is a Set, so membership
# is the whole answer; it used to be a Map<string, boolean> that only ever
# held true, and the filter over it survived mutation because it could not
# decide anything. Mutating the membership test is the real question.
mutate cli/commands/try.ts \
    '            if (entry.passedOnRerunConfigs.has(jobName)) {' \
    '            if (!entry.passedOnRerunConfigs.has(jobName)) {' \
    'the configs the rerun rescued and did not are swapped'

# The line is emitted at all.
mutate cli/commands/try.ts \
    '    if (configs.length === 0) {' \
    '    if (configs.length >= 0) {' \
    'the rerun line is never printed'

# Not mutated: an `|| failure.passedOnRerunConfigs.length > 0` clause on the
# "failed every run on" condition, so that a row naming where the rerun passed
# always also names where the test failed every run. It was tried and it
# survived, because it is unreachable: `passedOnRerunConfigs` is a subset of
# `jobNames` and `permaFailingConfigs` excludes every member of it, so a
# non-empty `passedOnRerunConfigs` already forces the strict inequality. The
# clause has been removed rather than pinned.

# The condition that does the work, which the above rests on.
mutate cli/commands/try.ts \
    '            failure.permaFailingConfigs.length < failure.jobNames.length' \
    '            failure.permaFailingConfigs.length <= failure.jobNames.length' \
    'the permanent configs are relisted when they are all of them'

# --- 3: the streamed-profile diagnostic ---------------------------------

# The detection, removed: a killed job is an unreadable profile again.
mutate cli/commands/try.ts \
    '            } else if (isStreamedProfile(bytes)) {' \
    '            } else if (false) {' \
    'a streamed profile is reported as a read failure'

# The two counts stay distinct. Merging them loses the distinction the whole
# change exists to make.
mutate cli/commands/try.ts \
    '                streamed++;' \
    '                missing++;' \
    'the streamed count is folded into the missing one'

# Not mutated: the `rest === ''` early return that used to sit here. A single
# document with a trailing newline leaves `rest` empty, and `''.startsWith('{')`
# is already false, so the guard decided nothing — no distinguishing input
# exists among 400,000 generated ones. It has been removed rather than pinned
# by a test that could only assert the same answer twice.

# The three below are in `lib/model/test-markers.ts`, not `try.ts`: the marker
# parser and `isStreamedProfile` moved there when `fx-tests task` needed the
# same read against a single task. The call site and the counter above are
# still `try.ts`'s, which is why this section now names two files.

# The first line has to be a complete document; a truncated one is a genuine
# read failure and must stay in the other bucket.
mutate lib/model/test-markers.ts \
    '        JSON.parse(head.slice(0, newline));' \
    '        JSON.parse("null");' \
    'a truncated first line still counts as streamed'

# What follows has to be another document.
mutate lib/model/test-markers.ts \
    "    return rest.startsWith('{');" \
    '    return true;' \
    'any trailing content counts as a second document'

# No newline at all is not the streamed shape.
mutate lib/model/test-markers.ts \
    '    if (newline < 0) {' \
    '    if (false) {' \
    'a single-line profile is examined as though it were streamed'

summary
exit $((SURVIVED > 0 ? 1 : 0))
