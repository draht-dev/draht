# Phase 22: Router Hardening - Implementation Decisions

## Provider Failure Simulation
- **Approach**: Inject error callbacks into the router for testing
- **Rationale**: Allows controlled failure scenarios without mocking @draht/ai internals or requiring real API keys

## Cost Tracking Accuracy
- **Definition**: Cost calculations must match COST_PER_MILLION lookup table exactly
- **Tolerance**: Only for floating-point precision (within 1%)
- **Missing models**: Use default rates { input: 3, output: 15 }
- **Test strategy**: Fixture-based tests with known token counts → expected costs

## Config Validation (R22-RTR.3)
Validation rejects:
- Empty provider/model strings
- Duplicate models in fallback chain
- Missing built-in roles (architect, implement, boilerplate, quick, review, docs)
- Invalid provider names (not in @draht/ai registry)
- Invalid model IDs for the given provider
- Circular fallback dependencies

**Validation timing**: Both load and save time (`loadConfig()` and `saveConfig()` validate)

**Error format**: Throw with detailed multi-line message listing all validation issues

## Streaming Fallback Testing
- **Scope**: Test both `stream()` and `streamSimple()` methods with fallback
- **Mid-stream failure**: Test partial response scenarios where primary provider emits events, then fails
- **Expected behavior**: Fallback provider picks up after partial response and continues streaming

## Test Structure
Integration tests will use error injection callbacks:
- Test 1: Primary fails before first event → fallback succeeds
- Test 2: Primary fails mid-stream → fallback continues
- Test 3: All providers fail → throws last error
- Test 4: Non-retryable error → throws immediately without fallback
- Test 5: Cost tracking accuracy with fixture data
- Test 6: Config validation rejects all invalid cases

## Domain Terms
No new domain terms identified. All concepts (ModelRouter, fallback chain, cost tracking, RouterConfig) already defined in DOMAIN.md.