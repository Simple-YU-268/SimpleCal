"""Capture synthetic CalDAV HTTP exchanges from an isolated Radicale install.

Run with a Python environment containing radicale; writes HAR + package identity.
No production server or credentials are used. The temporary store is removed.
"""
import argparse
import hashlib
import http.client
import importlib.metadata
import json
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from wsgiref.simple_server import make_server, WSGIRequestHandler
from xml.sax.saxutils import escape

from radicale import Application, config


class QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    entries = []
    with tempfile.TemporaryDirectory(prefix="simplecal-radicale-") as data:
        settings = config.load([])
        settings.update({"auth": {"type": "none"},
                         "storage": {"filesystem_folder": data}}, "probe")
        server = make_server("127.0.0.1", 0, Application(settings), handler_class=QuietHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_port}"

        def request(method, path, body="", headers=None):
            headers = {"Content-Type": "application/xml; charset=utf-8", **(headers or {})}
            raw = body.encode("utf-8")
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=10)
            started = datetime.now(timezone.utc).isoformat()
            connection.request(method, path, raw, headers)
            response = connection.getresponse()
            content = response.read()
            result_headers = dict(response.getheaders())
            entries.append({"startedDateTime": started, "time": 0,
                "request": {"method": method, "url": origin + path, "httpVersion": "HTTP/1.1",
                    "headers": [{"name": k, "value": v} for k, v in headers.items()],
                    "queryString": [], "cookies": [], "headersSize": -1, "bodySize": len(raw),
                    "postData": {"mimeType": headers["Content-Type"], "text": body}},
                "response": {"status": response.status, "statusText": response.reason,
                    "httpVersion": "HTTP/1.1", "headers": [{"name": k, "value": v} for k, v in result_headers.items()],
                    "cookies": [], "content": {"size": len(content), "mimeType": result_headers.get("Content-Type", ""),
                        "text": content.decode("utf-8")}, "redirectURL": "", "headersSize": -1, "bodySize": len(content)},
                "cache": {}, "timings": {"send": 0, "wait": 0, "receive": 0}})
            connection.close()
            print(method, path, response.status)
            return response.status, result_headers, content.decode("utf-8")

        try:
            request("MKCOL", "/probe/")
            for name in ("one", "two"):
                request("MKCALENDAR", f"/probe/{name}/")
            ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SimpleCal//Probe//EN\r\nBEGIN:VEVENT\r\nUID:sample\r\nDTSTAMP:20261030T000000Z\r\nDTSTART:20261030T090000Z\r\nDTEND:20261030T100000Z\r\nSUMMARY:Synthetic probe\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
            for name in ("one", "two"):
                status, _, _ = request("PUT", f"/probe/{name}/sample.ics", ics,
                    {"Content-Type": "text/calendar", "If-None-Match": "*"})
                if status != 201:
                    raise RuntimeError(f"fixture creation failed: {status}")
            _, headers, _ = request("GET", "/probe/one/sample.ics")
            etag = next(v for k, v in headers.items() if k.lower() == "etag")
            for method, conditions in (("GET", {"If-None-Match": etag}),
                                       ("HEAD", {"If-None-Match": etag}),
                                       ("GET", {"If-Match": '"stale"'})):
                request(method, "/probe/one/sample.ics", headers=conditions)
            for href in ("/probe/one/sample.ics", "/probe/two/sample.ics",
                         "https://outside.invalid/probe/one/sample.ics"):
                request("REPORT", "/probe/one/", '<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><D:href>' + escape(href) + '</D:href></C:calendar-multiget>')
            request("REPORT", "/probe/one/", '<D:sync-collection xmlns:D="DAV:"><D:sync-token/><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>')
        finally:
            server.shutdown()
            thread.join()
            server.server_close()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"log": {"version": "1.2", "creator": {"name": "SimpleCal CalDAV probe", "version": "1"}, "entries": entries}}, indent=2), encoding="utf-8")
    distribution = importlib.metadata.distribution("radicale")
    identity = {"name": "Radicale", "version": distribution.version,
                "har_sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
                "files": {str(p): hashlib.sha256(Path(distribution.locate_file(p)).read_bytes()).hexdigest()
                          for p in distribution.files if str(p).endswith(".py")}}
    args.output.with_suffix(".identity.json").write_text(json.dumps(identity, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
