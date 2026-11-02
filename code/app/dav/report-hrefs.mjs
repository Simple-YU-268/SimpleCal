import { pathFromPublicUrl } from '../lib/public-url.mjs';

// REPORT hrefs are resource identifiers, never outbound fetch targets. Resolve
// against the collection, validate before URL normalizes traversal, and leave
// account/collection membership checks to each adapter's typed router.
export function reportHrefPath(rawHref, { config, origin, collectionPath }) {
  const raw = String(rawHref).trim();
  if (!raw || /[\\\x00-\x20\x7f]/.test(raw)) return null;
  try {
    const localOrigin = new URL(origin).origin;
    for (const segment of raw.split(/[/?#]/)) {
      const decoded = decodeURIComponent(segment);
      if (decoded === '.' || decoded === '..' || /[\\/]/.test(decoded)) return null;
    }
    const url = new URL(raw, new URL(collectionPath, localOrigin));
    const publicUrl = config.publicBaseUrl ? new URL(config.publicBaseUrl) : null;
    if (!['http:', 'https:'].includes(url.protocol) || ![localOrigin, publicUrl?.origin].includes(url.origin)
      || url.username || url.password || url.search || url.hash) return null;
    // A root-relative public href can arrive on the internal origin behind a
    // reverse proxy. Recognize its explicit mount without trusting forwarded headers.
    const mount = publicUrl?.pathname.replace(/\/+$/, '');
    if (mount && (url.pathname === mount || url.pathname.startsWith(`${mount}/`))) {
      return url.pathname.slice(mount.length) || '/';
    }
    return pathFromPublicUrl(config, url);
  } catch {
    return null;
  }
}
