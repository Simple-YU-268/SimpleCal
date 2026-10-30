// HTTP entity-tag conditions, independent of persistence and authentication.
// SimpleCal emits SHA-256 tags; parse quoted lists rather than splitting on commas
// so other legal opaque tags cannot alter list semantics.
function parseTags(value) {
  let rest = String(value).trim();
  if (rest === '*') return [{ wildcard: true }];
  const tags = [];
  while (rest) {
    const match = /^(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"/.exec(rest);
    if (!match) return null;
    tags.push({ weak: Boolean(match[1]), value: match[2] });
    rest = rest.slice(match[0].length).trim();
    if (!rest) break;
    if (!rest.startsWith(',') || !rest.slice(1).trim()) return null;
    rest = rest.slice(1).trim();
  }
  return tags.length ? tags : null;
}

export function checkEntityConditions(headers, existing, { read = false } = {}) {
  const etag = existing?.etag;
  // If-Match has precedence and uses strong comparison.
  if (headers['if-match'] !== undefined) {
    const tags = parseTags(headers['if-match']);
    if (!tags) return { status: 400, reason: 'invalid If-Match' };
    if (!existing || !tags.some((tag) => tag.wildcard || (!tag.weak && tag.value === etag))) {
      return { status: 412, reason: 'If-Match did not match the current resource' };
    }
  }
  // If-None-Match uses weak comparison for both read and write requests.
  if (headers['if-none-match'] !== undefined) {
    const tags = parseTags(headers['if-none-match']);
    if (!tags) return { status: 400, reason: 'invalid If-None-Match' };
    if (existing && tags.some((tag) => tag.wildcard || tag.value === etag)) {
      return { status: read ? 304 : 412, reason: 'If-None-Match matched the current resource' };
    }
  }
  return null;
}
