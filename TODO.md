# TODO

_Last updated: 2026-06-15._

## Highest-priority project work

1. **Fix lint-blocking errors.**
   - Move direct `Date.now()` usage out of render/async component paths in:
     - `src/app/(dashboard)/email/analytics/page.tsx`
     - `src/app/(dashboard)/email/sends/page.tsx`
   - Escape the quoted helper text in `src/components/health-banner.tsx`.

2. **Clean up warning-level dead code.**
   - Remove or use the unused `bounces` value in the analytics page.
   - Simplify the sends-page fallback mapping so the discarded `_last_queued` helper field does not create an unused variable warning.

3. **Add a smoke test suite.**
   - `npm test` currently has no matching test files, so queue/email regressions are not protected by automated tests.
   - Minimum coverage should include queue chunking, status transitions, fallback query behavior, and guarded send-monitor behavior.

4. **Centralize time-window calculations.**
   - The 30-day and 90-day ISO date windows are duplicated inline.
   - Prefer a small deterministic helper that accepts a base timestamp and returns the needed cutoff strings.
   - Validate UTC/DST boundary behavior for `created_at` and `received_at` filters.

5. **Harden fallback analytics limits.**
   - Analytics and sends fallbacks cap scans at 5,000 queue rows.
   - Add a visible truncated-results indicator or replace the bounded scan with cursor-based pagination so large campaigns do not silently undercount.

## Verification commands

Run these before considering the cleanup complete:

```bash
npm run lint
npm test
npm run build
```
