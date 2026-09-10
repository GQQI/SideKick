# Defense-in-Depth Validation

When you fix a bug caused by invalid data, adding validation at one place feels sufficient. That single check can be bypassed by different code paths, refactoring, or mocks.

**Core principle:** Validate at EVERY layer data passes through. Make the bug structurally impossible.

## The Four Layers

### Layer 1: Entry Point Validation
Reject obviously invalid input at the API boundary.

### Layer 2: Business Logic Validation
Ensure data makes sense for this operation.

### Layer 3: Environment Guards
Prevent dangerous operations in specific contexts (tests, production, temp dirs).

### Layer 4: Debug Instrumentation
Capture context for forensics (directory, cwd, stack) before the risky call.

## Applying the Pattern

1. Trace the data flow — where does the bad value originate? Where is it used?
2. Map all checkpoints
3. Add validation at each layer
4. Test each layer — try to bypass layer 1, verify layer 2 catches it

Don't stop at one validation point.
