# Writing Good Tests

Load this reference when writing or changing tests, adding mocks, or adding test helpers.

## Overview

A test exists to catch a specific break.

```
1. Every test names the break it catches
2. Every test exercises the real thing
```

## Principle 1: Name the Break

Before writing the test body, answer: what production change should make this test fail — and is that change a bug or a decision?

Derive expectations independently. Use literals and hand-checked fixtures. Never compute the expected value with the code under test.

No change detectors: don't assert a constant's exact value or exact error wording unless that wording is the contract. Test the behavior that depends on the decision.

Behavior, not text: don't grep source for a line. Run the code and assert outputs or side effects.

## Principle 2: Exercise the Real Thing

A mock assertion that only proves the mock is present says nothing about the component. Assert real behavior.

Mock at the right level: learn every side effect of the real method first; mock only the slow or external operation.

Mirror real data completely in fixtures. Partial mocks fail silently when downstream reads an omitted field.

Cleanup that only tests need lives in test utilities, never as a `destroy()` on the production class.

When mock setup outgrows the test logic, switch to an integration test with real components.

## The Mutation Check

Before finishing, mentally mutate the production code; at least one test should fail for each realistic mutation:

- Wrong constant or argument
- Wrong branch
- Missing state change
- Empty or default return
- Missing validation for empty / nil / malformed input
