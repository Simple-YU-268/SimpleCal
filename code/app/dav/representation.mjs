import { checkEntityConditions } from './preconditions.mjs';

// One read contract for CalDAV objects, collection exports and CardDAV.
// Adapters supply their version validator and retain authentication/access checks.
export function conditionalRepresentation(headers, { content, etag, ...metadata }) {
  const responseHeaders = { ...metadata, ETag: `"${etag}"` };
  const failure = checkEntityConditions(headers, { etag }, { read: true });
  // On 304, Content-Length (if sent) describes the selected 200 representation,
  // not the empty wire body (RFC 9110 section 8.6).
  if (failure?.status === 304) responseHeaders['Content-Length'] = Buffer.byteLength(content, 'utf8');
  return { status: failure?.status || 200, headers: responseHeaders,
    body: failure ? (failure.status === 304 ? '' : `${failure.reason}\n`) : content };
}
