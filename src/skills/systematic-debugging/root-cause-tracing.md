# Root Cause Tracing

Trace a bad value backward through the call stack until you find where it originated. Fix the source, not the symptom.

## When to load

Use this when the error is deep in the stack, the failing line looks "correct", or a bad argument / empty path / wrong type appeared with no local explanation.

## Procedure

1. Write down the bad value and the frame where you first see it (file, function, line).
2. Ask: who called this, and what did they pass?
3. Open that caller. Repeat until the value is created, defaulted, or transformed incorrectly.
4. Confirm with one more reproduction after you name the source — logging at the origin, not only at the crash.
5. Fix at the origin. Add a guard at the crash site only as defense-in-depth (see `defense-in-depth.md`).

## Stop conditions

- You found the first assignment / default / parse that produced the bad value.
- You proved the value is correct at origin and corrupted at a specific boundary (then that boundary is the source).
- Three hops up still have no evidence — add logs at each hop and re-run once before guessing.

## Do not

- Patch a null check at the bottom and call it done.
- Restart from a new theory every time you see a similar symptom.
- Change multiple layers in one attempt.
