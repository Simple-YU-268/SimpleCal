export function normalizePublicBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); }
  catch { throw new Error('CALDAV_PUBLIC_BASE_URL must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('CALDAV_PUBLIC_BASE_URL must not contain credentials, query, fragment, or a non-HTTP scheme');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function publicHref(config, href) {
  const value = String(href || '');
  if (!config.publicBaseUrl || /^https?:\/\//i.test(value)) return value;
  return `${config.publicBaseUrl}${value.startsWith('/') ? value : `/${value}`}`;
}

export function pathFromPublicUrl(config, url) {
  if (!config.publicBaseUrl) return url.pathname;
  const base = new URL(config.publicBaseUrl);
  if (url.origin !== base.origin) return url.pathname;
  const prefix = base.pathname.replace(/\/+$/, '');
  if (!prefix) return url.pathname;
  if (url.pathname === prefix) return '/';
  if (!url.pathname.startsWith(`${prefix}/`)) return null;
  return url.pathname.slice(prefix.length) || '/';
}
