# Condition-Based Waiting

Flaky tests often guess at timing with arbitrary delays. This creates race conditions that pass on fast machines and fail under load.

**Core principle:** Wait for the actual condition you care about, not a guess about how long it takes.

## When to Use

Use when tests have `setTimeout` / `sleep`, are flaky, timeout in parallel, or wait for async work.

Don't use when testing actual timing behavior (debounce, throttle). If you must use an arbitrary timeout, document WHY.

## Core Pattern

```
# BAD: guessing at timing
sleep(50)
assert get_result() is not None

# GOOD: wait for the condition
wait_until(lambda: get_result() is not None, timeout_ms=5000)
assert get_result() is not None
```

## Quick Patterns

| Scenario | Pattern |
|----------|---------|
| Wait for event | wait until the event appears |
| Wait for state | wait until machine.state == ready |
| Wait for count | wait until items.length >= 5 |
| Wait for file | wait until the path exists |

Always include a timeout with a clear error. Poll about every 10ms. Read fresh state inside the loop.

## When Arbitrary Timeout IS Correct

First wait for the triggering condition, then wait a documented interval based on known timing (not a guess), with a comment explaining WHY.
