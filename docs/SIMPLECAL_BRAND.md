# SimpleCal visual identity

The SimpleCal mark is original vector geometry: an open **C**, a sun-yellow date point and two calendar bindings. It is designed to remain legible at favicon size and does not contain the earlier project's “Cal” lettering or blue gradient.

The primary mark uses deep indigo `#3B54C4`, warm white `#FCFFF9`, indigo ink `#3B54C4` for the open C, periwinkle `#A9BEE4` for the calendar bindings and sun yellow `#FFD94D` for the date point. The binding colour must stay lighter than the tile or the calendar stops reading as a calendar. Rose and jade belong to the calendar's supporting palette rather than crowding the small mark. The deep ink is required for readability; do not replace it with white on the indigo ground.

- `code/web/public/simplecal-mark.svg`: primary 64-unit mark, transparent rounded outer corners.
- `code/web/public/simplecal-logo.svg`: primary mark alias for interface placement.
- `code/web/public/simplecal-mark-monochrome.svg`: one-color `currentColor` version for print and secondary use.
- PNG app icons use the same geometry. The generator renders every raster — 16/32/48px favicons, Apple touch icon and the PWA set — from the one vector mark, and embeds the exact 16/32/48px PNGs in the ICO, so a favicon and a 512px icon can never drift apart.
- Maskable and Apple icons use a full indigo ground and an 82% glyph scale to preserve the central safe area.

The primary mark should be used at 24px or larger in application chrome. The dedicated 16px favicon keeps the same silhouette without miniature lettering. Use at least one-sixth of the mark width as clear space; do not distort, rotate, outline, or add a glow.

Regeneration is development-only. Install `@resvg/resvg-js@2.6.2` in a temporary tooling directory, then run:

```powershell
node code/scripts/generate-brand.mjs --renderer <temporary-directory>/node_modules/@resvg/resvg-js
```

The application has no new runtime dependency. The generator also renders the 64/256px fnOS launcher assets. It preserves stable public icon filenames so existing favicon links, manifests and service-worker version stamping continue to work. The fnOS package uses the same vector mark rendered at 64px and 256px in `code/fnos/ICON.PNG`, `ICON_256.PNG`, and `app/ui/images/`.

`node code/scripts/check-icons.mjs` verifies frozen SHA-256 identities, dimensions and PNG format across web and fnOS assets, exact ICO layers, PWA icon declarations and any assembled output. Historical v6?v9 assets remain archival references and must differ from the replacement identity. Optional `--public <directory>` and `--fnos <directory>` arguments allow checking isolated build output. When intentionally revising artwork, regenerate the assets and review the frozen identities together.
