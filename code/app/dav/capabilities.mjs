// One descriptive surface for methods and reports actually implemented here.
// This is not a claim of complete RFC conformance or support for DAV locks.
export const DAV_METHODS = Object.freeze(['OPTIONS', 'GET', 'HEAD', 'PUT', 'DELETE', 'MOVE',
  'PROPFIND', 'PROPPATCH', 'REPORT', 'MKCALENDAR']);
export const ALLOW_HEADER = DAV_METHODS.join(', ');
export const DAV_HEADER = '1, 3, calendar-access, sync-collection';
export const DAV_REPORTS = Object.freeze(['C:calendar-query', 'C:calendar-multiget',
  'D:sync-collection', 'C:free-busy-query']);
export function supportedReportSetXml() {
  return '<D:supported-report-set>' + DAV_REPORTS.map((name) =>
    `<D:supported-report><D:report><${name}/></D:report></D:supported-report>`).join('')
    + '</D:supported-report-set>';
}
