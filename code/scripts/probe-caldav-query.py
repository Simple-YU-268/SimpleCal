"""Record Radicale's responses to the SimpleCal query contract fixture set.

Run inside an isolated Python environment containing the desired Radicale
version. The output directory receives HTTP HAR, observed result UIDs and
installed package identities. Only synthetic data and a temporary loopback
WSGI server are used. The probe records differences without asserting that
the reference server is correct.
"""
import argparse
import hashlib
import http.client
import importlib.metadata
import json
import sys
import tempfile
import threading
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from wsgiref.simple_server import WSGIRequestHandler, make_server

from radicale import Application, config


DAV = "DAV:"
CAL = "urn:ietf:params:xml:ns:caldav"
FIXTURES = [
    {"uid": "alpha", "summary": "Team Planning", "start": "20261030T090000Z", "end": "20261030T100000Z",
     "extra": ["LOCATION:Studio", 'ATTENDEE;CN="Alice Example":mailto:alice@example.test']},
    {"uid": "beta", "summary": "Budget Review", "start": "20261030T120000Z", "end": "20261030T130000Z",
     "extra": ['ATTENDEE;CN="Bob Example":mailto:bob@example.test']},
    {"uid": "gamma", "summary": r"team\, Roadmap", "start": "20261102T090000Z", "end": "20261102T100000Z",
     "extra": ["LOCATION:Remote"]},
]


class QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass


def property_filter(name, content=""):
    return f'<C:prop-filter name="{name}">{content}</C:prop-filter>'


def text_match(text, attributes=""):
    return f"<C:text-match {attributes}>{text}</C:text-match>"


def query(conditions):
    return (f'<C:calendar-query xmlns:C="{CAL}" xmlns:D="{DAV}">'
            '<D:prop><D:getetag/><C:calendar-data/></D:prop>'
            '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">'
            + conditions + '</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>')


def cases():
    # Expected UIDs mirror dav-query-contract.test.mjs; observed UIDs below are
    # extracted from the reference's calendar-data, not copied from this table.
    time_range = '<C:time-range start="20261030T083000Z" end="20261030T110000Z"/>'
    return [
        ("SUMMARY ASCII case folding", property_filter("SUMMARY", text_match("TEAM", 'collation="i;ascii-casemap"')), ["alpha", "gamma"]),
        ("SUMMARY octet comparison", property_filter("SUMMARY", text_match("Team", 'collation="i;octet"')), ["alpha"]),
        ("SUMMARY negation", property_filter("SUMMARY", text_match("team", 'negate-condition="yes"')), ["beta"]),
        ("property present", property_filter("LOCATION"), ["alpha", "gamma"]),
        ("property absent", property_filter("LOCATION", "<C:is-not-defined/>"), ["beta"]),
        ("multiple property filters are conjunctive", property_filter("SUMMARY", text_match("team"))
         + property_filter("LOCATION", text_match("Remote")), ["gamma"]),
        ("parameter text matching", property_filter("ATTENDEE", '<C:param-filter name="CN">'
         + text_match("alice") + '</C:param-filter>'), ["alpha"]),
        ("parameter absent", property_filter("ATTENDEE", '<C:param-filter name="ROLE"><C:is-not-defined/></C:param-filter>'), ["alpha", "beta"]),
        ("parameter present", property_filter("ATTENDEE", '<C:param-filter name="CN"/>'), ["alpha", "beta"]),
        ("time range", time_range, ["alpha"]),
        ("time and property are conjunctive", time_range + property_filter("SUMMARY", text_match("Budget")), []),
        ("iCalendar TEXT escape decoding", property_filter("SUMMARY", text_match("team, Roadmap")), ["gamma"]),
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_directory", type=Path)
    args = parser.parse_args()
    entries = []
    observations = []
    with tempfile.TemporaryDirectory(prefix="simplecal-query-reference-") as data:
        settings = config.load([])
        settings.update({"auth": {"type": "none"}, "storage": {"filesystem_folder": data}}, "query probe")
        server = make_server("127.0.0.1", 0, Application(settings), handler_class=QuietHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_port}"

        def request(method, resource, body="", headers=None):
            headers = {"Content-Type": "application/xml; charset=utf-8", **(headers or {})}
            raw = body.encode("utf-8")
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=10)
            try:
                started = datetime.now(timezone.utc).isoformat()
                connection.request(method, resource, raw, headers)
                response = connection.getresponse()
                content = response.read()
                response_headers = dict(response.getheaders())
                entries.append({"startedDateTime": started, "time": 0,
                    "request": {"method": method, "url": origin + resource, "httpVersion": "HTTP/1.1",
                        "headers": [{"name": k, "value": v} for k, v in headers.items()],
                        "queryString": [], "cookies": [], "headersSize": -1, "bodySize": len(raw),
                        "postData": {"mimeType": headers["Content-Type"], "text": body}},
                    "response": {"status": response.status, "statusText": response.reason,
                        "httpVersion": "HTTP/1.1", "headers": [{"name": k, "value": v} for k, v in response_headers.items()],
                        "cookies": [], "content": {"size": len(content), "mimeType": response_headers.get("Content-Type", ""),
                            "text": content.decode("utf-8")}, "redirectURL": "", "headersSize": -1, "bodySize": len(content)},
                    "cache": {}, "timings": {"send": 0, "wait": 0, "receive": 0}})
                return response.status, content.decode("utf-8"), len(entries) - 1
            finally:
                connection.close()

        try:
            for method, resource in (("MKCOL", "/probe/"), ("MKCALENDAR", "/probe/calendar/")):
                status, text, _ = request(method, resource)
                if status != 201:
                    raise RuntimeError(f"{method} fixture creation failed: {status} {text}")
            for event in FIXTURES:
                content = "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SimpleCal//Query Contract//EN",
                    "BEGIN:VEVENT", f'UID:{event["uid"]}', "DTSTAMP:20261030T000000Z", f'DTSTART:{event["start"]}',
                    f'DTEND:{event["end"]}', f'SUMMARY:{event["summary"]}', *event["extra"],
                    "END:VEVENT", "END:VCALENDAR", ""])
                status, text, _ = request("PUT", f'/probe/calendar/{event["uid"]}.ics', content,
                    {"Content-Type": "text/calendar", "If-None-Match": "*"})
                if status != 201:
                    raise RuntimeError(f"PUT fixture failed: {status} {text}")
            for label, condition, expected in cases():
                status, text, ordinal = request("REPORT", "/probe/calendar/", query(condition))
                uids = []
                parse_error = None
                try:
                    for element in ET.fromstring(text).iter(f"{{{CAL}}}calendar-data"):
                        lines = (element.text or "").replace("\r\n ", "").splitlines()
                        uids.extend(line[4:] for line in lines if line.startswith("UID:"))
                except ET.ParseError as error:
                    parse_error = str(error)
                observed = {"case": label, "har_ordinal": ordinal, "status": status, "uids": sorted(set(uids)),
                            "expected_simplecal_uids": expected,
                            "matches_expected": status == 207 and sorted(set(uids)) == expected}
                if parse_error:
                    observed["xml_parse_error"] = parse_error
                observations.append(observed)
                print(json.dumps(observed))
        finally:
            server.shutdown()
            thread.join()
            server.server_close()
    args.output_directory.mkdir(parents=True, exist_ok=True)
    har_path = args.output_directory / "radicale-query.har"
    har_path.write_text(json.dumps({"log": {"version": "1.2",
        "creator": {"name": "SimpleCal query differential probe", "version": "1"}, "entries": entries}}, indent=2), encoding="utf-8")
    distribution = importlib.metadata.distribution("radicale")
    identity = {"name": "Radicale", "version": distribution.version, "python": sys.version,
                "har_sha256": hashlib.sha256(har_path.read_bytes()).hexdigest(),
                "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "packages": {item.metadata["Name"]: item.version for item in importlib.metadata.distributions()},
                "files": {str(p): hashlib.sha256(Path(distribution.locate_file(p)).read_bytes()).hexdigest()
                          for p in distribution.files if str(p).endswith(".py")}}
    (args.output_directory / "radicale-query.identity.json").write_text(json.dumps(identity, indent=2), encoding="utf-8")
    (args.output_directory / "radicale-query.results.json").write_text(json.dumps({
        "reference": {"name": "Radicale", "version": distribution.version}, "har_sha256": identity["har_sha256"],
        "fixtures": FIXTURES, "results": observations}, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
