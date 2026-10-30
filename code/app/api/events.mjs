// Ordinary user API; this adapter never accepts an AI token as authorization.
function json(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length, 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  // Drain oversized bodies so a structured 413 can be returned on this connection.
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 1024 * 1024) chunks.push(chunk);
  }
  if (size > 1024 * 1024) throw Object.assign(new Error('请求体超过 1 MB'), { status: 413, code: 'too_large' });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求体须为有效 JSON'), { status: 400, code: 'invalid_json' }); }
}

export function createEventsApi({ events }) {
  async function handle(req, res, url) {
    const match = /^\/api\/v1\/calendars\/([^/]+)\/events(?:\/([^/]+))?\/?$/.exec(url.pathname);
    if (!match) return json(res, 404, { ok: false, code: 'not_found' });
    try {
      let calendarId, id;
      try { calendarId = decodeURIComponent(match[1]); id = match[2] ? decodeURIComponent(match[2]) : undefined; }
      catch { throw Object.assign(new Error('路径编码无效'), { status: 400, code: 'invalid_id' }); }
      const allowed = id ? ['GET', 'PATCH', 'DELETE'] : ['GET', 'POST'];
      if (!allowed.includes(req.method)) return json(res, 405, { ok: false, code: 'method_not_allowed' }, { Allow: allowed.join(', ') });
      if (req.method === 'GET' && !id) {
        if (url.search) return json(res, 400, { ok: false, code: 'unsupported_query', message: '当前列表返回系列主事件，不支持查询参数' });
        return json(res, 200, { ok: true, items: await events.list(calendarId) });
      }
      if (req.method === 'DELETE') {
        await events.remove(calendarId, id, req.headers['if-match']);
        return json(res, 200, { ok: true });
      }
      let result;
      if (req.method === 'GET') result = await events.get(calendarId, id);
      else {
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') return json(res, 415, { ok: false, code: 'unsupported_media_type' });
        const body = await readBody(req);
        result = req.method === 'POST' ? await events.create(calendarId, body)
          : await events.patch(calendarId, id, body, req.headers['if-match']);
      }
      const headers = { ETag: result.etag };
      if (req.method === 'POST') headers.Location = `/api/v1/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(result.event.id)}`;
      return json(res, req.method === 'POST' ? 201 : 200, { ok: true, ...result }, headers);
    } catch (err) {
      if (!err.status) throw err;
      return json(res, err.status, { ok: false, code: err.code || 'invalid_event', message: err.message });
    }
  }
  return { handle };
}
