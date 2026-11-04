// Shared helpers used by both the content script and the popup.
// Pure functions only (no DOM access) so they can be unit-tested in Node.
(function (root) {
  'use strict';

  const CSV_COLUMNS = [
    { key: 'name', header: 'Name' },
    { key: 'title', header: 'Title' },
    { key: 'connectedDate', header: 'Connection Date' },
    { key: 'connectedDateApproximate', header: 'Date Is Approximate' },
    { key: 'connectedText', header: 'Connected (as shown on LinkedIn)' },
    { key: 'profileUrl', header: 'Profile URL' },
  ];

  function csvEscape(value) {
    let s = value === undefined || value === null ? '' : String(value);
    // Guard against spreadsheet formula injection (a title like "=HYPERLINK(...)").
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(rows) {
    const lines = [CSV_COLUMNS.map((c) => csvEscape(c.header)).join(',')];
    for (const row of rows) {
      lines.push(
        CSV_COLUMNS.map((c) => {
          let v = row[c.key];
          if (typeof v === 'boolean') v = v ? 'yes' : 'no';
          return csvEscape(v);
        }).join(',')
      );
    }
    // BOM so Excel opens UTF-8 names (accents, non-Latin scripts) correctly.
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function toIsoDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /**
   * Parse LinkedIn's "Connected ..." text into an ISO date.
   * Handles both absolute ("Connected on March 5, 2024") and relative
   * ("Connected 3 weeks ago") formats. Relative dates are flagged approximate.
   * Returns { iso, approximate } or null if it can't be parsed.
   */
  function parseConnectedDate(text, now = new Date()) {
    if (!text) return null;
    let t = String(text).replace(/\s+/g, ' ').trim();
    t = t.replace(/^connected\s*/i, '').replace(/^on\s+/i, '').trim();
    if (!t) return null;

    // Relative formats
    if (/^(today|just now)$/i.test(t)) return { iso: toIsoDate(now), approximate: false };
    if (/^yesterday$/i.test(t)) {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return { iso: toIsoDate(d), approximate: false };
    }
    const rel = t.match(/^(\d+|an?|one)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i);
    if (rel) {
      const n = /^(an?|one)$/i.test(rel[1]) ? 1 : parseInt(rel[1], 10);
      const unit = rel[2].toLowerCase();
      const d = new Date(now);
      if (unit === 'day') d.setDate(d.getDate() - n);
      else if (unit === 'week') d.setDate(d.getDate() - 7 * n);
      else if (unit === 'month') d.setMonth(d.getMonth() - n);
      else if (unit === 'year') d.setFullYear(d.getFullYear() - n);
      // seconds/minutes/hours => today
      const approximate = unit === 'week' || unit === 'month' || unit === 'year';
      return { iso: toIsoDate(d), approximate };
    }

    // Absolute formats, e.g. "March 5, 2024", "Mar 5, 2024", "5 March 2024"
    const months = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
    };
    let m = t.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
    let y, mo, day;
    if (m) {
      mo = months[m[1].slice(0, m[1].toLowerCase().startsWith('sept') ? 4 : 3).toLowerCase()];
      day = parseInt(m[2], 10);
      y = parseInt(m[3], 10);
    } else if ((m = t.match(/^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/))) {
      day = parseInt(m[1], 10);
      mo = months[m[2].slice(0, 3).toLowerCase()];
      y = parseInt(m[3], 10);
    } else if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
      return { iso: t, approximate: false };
    }
    if (mo !== undefined && y && day >= 1 && day <= 31) {
      return { iso: `${y}-${pad(mo + 1)}-${pad(day)}`, approximate: false };
    }
    return null;
  }

  /** Normalise any LinkedIn profile link to https://www.linkedin.com/in/<slug>/ */
  function normalizeProfileUrl(href) {
    if (!href) return null;
    try {
      const u = new URL(href, 'https://www.linkedin.com');
      if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
      const m = u.pathname.match(/^\/in\/([^/?#]+)/);
      if (!m) return null;
      return `https://www.linkedin.com/in/${m[1]}/`;
    } catch (e) {
      return null;
    }
  }

  root.LIExport = { CSV_COLUMNS, csvEscape, toCsv, parseConnectedDate, normalizeProfileUrl, toIsoDate };
})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined') module.exports = globalThis.LIExport;
