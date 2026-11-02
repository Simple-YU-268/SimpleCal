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
- Docker Compose (Apache-2.0) plus plain Bash for the health-gated production
  upgrade in `deploy/upgrade.sh`: build first, validate the image version,
  switch only the application service, and restore the previous image when the
  health check fails. `deploy/test-upgrade.sh` injects the failures.

All browser dependencies are bundled locally; no runtime CDN is used.

## Remaining work, in order

1. Production worker fixture now verifies two-version activation, a missing
   required bundle rejecting installation, offline startup, and another tab
   retaining unsaved input. Desktop and mobile Chromium runs pass. The fixture
   uses synthetic HTML. A separate test loads the real application update-banner
   module and checks blocked refresh, user-confirmed activation, other-tab
   notification and preserved draft input. Six desktop/mobile browser cases pass.
   Interrupted transfers are covered as well. A third fixture builds the real
   application twice with different JavaScript and CSS content and asserts the
   upgraded page only references the new build, keeps a single cache without
   stale assets, and still opens offline. Ten desktop/mobile browser cases pass.
2. Add real backend login, event save, and update acceptance browser tests.
   The settings fixture still uses an in-memory store, but the product backend
   now runs inside the end-to-end suite: `e2e/backend-server.mjs` starts
   `code/app/server.mjs` with a throwaway data directory, and
   `e2e/real-backend.spec.js` covers login, event creation, a reload read-back
   (including a server-side check of the stored event), renaming, deletion and
   sign-out on desktop and mobile.
3. Extend Floating UI to other popovers after keyboard/focus regression checks.
4. Compare recurrence against a standard implementation using a shared corpus:
   DST, all-day dates, WKST, EXDATE, overridden instances and lunar recurrence.
   Do not replace the stored recurrence representation without compatibility tests.

## Dependency security

`npm audit` reports no advisories. The eight development advisories in Vite,
Vitest, PostCSS and nanoid were removed by upgrading the toolchain to
Vite 8.3.5 and Vitest 4.1.12. Production dependencies were never affected:
`npm ls --omit=dev` only contains Floating UI DOM and Workbox Window.

## Workbox precaching evaluation

Not migrated yet, and the custom worker keeps ownership of the cache rules.

- The current worker already refuses to install unless every JavaScript and CSS
  file referenced by `index.html` is fully cached, so a partial download cannot
  leave a half-updated shell behind.
- Workbox precaching would require a build-time manifest (workbox-build) and
  would replace the hand-written worker in `public/sw.js`. That adds a build
  dependency and bundle size without changing the user-visible behaviour that
  the update tests verify.
- Revisit when the shell starts precaching additional heavy resources (fonts,
  images, embedded widgets) or when revision-based caching becomes necessary.
- User confirmation before activation and the open-editor guard stay in the
  application layer (`src/js/live-update.js`) either way.
