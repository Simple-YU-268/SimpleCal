# Open-source adoption

## Implemented

- Workbox Window (MIT): service-worker registration and explicit activation.
  Existing same-origin cache rules remain in place until production update
  and offline regression tests cover their replacement.
- Playwright Test (Apache-2.0): desktop and mobile Chromium settings checks.
  Run `npm run test:e2e` from `code/web`. Currently uses installed Edge;
  this is not a physical iPhone or WebKit test.
- Floating UI DOM (MIT): date-picker positioning, viewport collision handling,
  and scroll/resize tracking. Cleanup runs when the picker closes.

All browser dependencies are bundled locally; no runtime CDN is used.

## Remaining work, in order

1. Production worker fixture now verifies two-version activation, a missing
   required bundle rejecting installation, offline startup, and another tab
   retaining unsaved input. Desktop and mobile Chromium runs pass. The fixture
   uses synthetic HTML. A separate test loads the real application update-banner
   module and checks blocked refresh, user-confirmed activation, other-tab
   notification and preserved draft input. Six desktop/mobile browser cases pass.
   Interrupted transfers and actual full-build upgrades remain.
   Complete those before replacing custom caching with Workbox precaching.
2. Add real backend login, event save, and update acceptance browser tests.
   The current settings fixture deliberately uses an in-memory store.
3. Extend Floating UI to other popovers after keyboard/focus regression checks.
4. Compare recurrence against a standard implementation using a shared corpus:
   DST, all-day dates, WKST, EXDATE, overridden instances and lunar recurrence.
   Do not replace the stored recurrence representation without compatibility tests.

## Dependency security

The initial install reported eight development dependency advisories;
`npm audit --omit=dev` reported no production advisories. Review development
advisories separately before upgrading the test/build toolchain.
