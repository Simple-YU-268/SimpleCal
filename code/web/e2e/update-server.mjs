import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';

const worker = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
let version = 'one';
createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname.startsWith('/production/')) {
    const name = url.pathname.slice('/production/'.length) || 'index.html';
    if (name.includes('..')) { res.writeHead(400).end(); return; }
    const file = new URL(`../dist/${name}`, import.meta.url);
    if (!existsSync(file)) { res.writeHead(404).end(); return; }
    const mime = name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css'
      : name.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    const body = readFileSync(file);
    res.end(name === 'sw.js' ? body.toString().replace('simplecal-shell-v1', `simplecal-shell-production-${version}`) : body);
    return;
  }
  if (url.pathname === '/deploy') {
    version = url.searchParams.get('version') || 'one';
    res.end('ok');
  } else if (url.pathname === '/sw.js') {
    res.setHeader('Content-Type', 'application/javascript');
    res.end(worker.replace("simplecal-shell-v1", `simplecal-shell-test-${version}`));
  } else if (url.pathname === '/' || url.pathname === '/index.html') {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><body><h1>${version}</h1><script src="./assets/${version}.js"></script>
      <script type="module">
        import { watchForUpdates } from '/modules/live-update.js';
        const registration = await navigator.serviceWorker.register('/sw.js');
        watchForUpdates(registration);
      </script></body></html>`);
  } else if (['/modules/live-update.js', '/modules/dom.js'].includes(url.pathname)) {
    res.setHeader('Content-Type', 'application/javascript');
    res.end(readFileSync(new URL(`../src/js/${url.pathname.split('/').pop()}`, import.meta.url)));
  } else if (url.pathname.startsWith('/assets/')) {
    res.setHeader('Content-Type', 'application/javascript');
    if (url.pathname.includes('interrupted')) {
      res.setHeader('Content-Length', '100000');
      res.write('window.partialDownload = ');
      setTimeout(() => res.destroy(), 30);
    } else if (url.pathname.includes('broken')) { res.statusCode = 404; res.end(); }
    else res.end('window.assetLoaded = true;');
  } else {
    res.end('fixture');
  }
}).listen(5189, '127.0.0.1');
