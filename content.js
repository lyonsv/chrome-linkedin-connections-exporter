// Injected into the LinkedIn connections page by the popup.
// Scrolls / clicks "Show more results" until the whole list is loaded,
// harvesting each connection card as it appears, then downloads a CSV.
(() => {
  'use strict';
  if (window.__liConnectionsExporterLoaded) return;
  window.__liConnectionsExporterLoaded = true;

  const L = globalThis.LIExport;

  // ---- Tunables -----------------------------------------------------------
  const FIRST_CARDS_TIMEOUT_MS = 20000; // wait for initial list to render
  const GROWTH_TIMEOUT_MS = 10000; // wait per page for new cards
  const MAX_NO_GROWTH_ATTEMPTS = 6; // consecutive attempts with no new cards
  const PERSIST_INTERVAL_MS = 2000;
  const HEARTBEAT_INTERVAL_MS = 3000;

  // Text on buttons/lines that is UI chrome, not a person's title.
  const NOISE_LINE =
    /^[\u00B7\u2022\s]*(message|more|more actions|remove connection|follow|following|connect|pending|send|\d+(st|nd|rd|th)\+?|(1st|2nd|3rd\+?)( degree connection)?|degree connection|status is .*|verified|open to work|hiring|premium|view .*profile.*|connected.*|)$/i;

  class ExportError extends Error {
    constructor(code, message, details) {
      super(message);
      this.code = code;
      this.details = details || {};
    }
  }

  let running = false;
  let cancelRequested = false;
  const collected = new Map(); // profileUrl -> row
  let state = {};
  let lastPersist = 0;
  let lastHeartbeat = 0;

  // ---- Messaging ----------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'liexport:ping') {
      sendResponse({ ok: true, running });
    } else if (msg.type === 'liexport:start') {
      if (running) {
        sendResponse({ ok: false, error: 'An export is already running in this tab.' });
      } else {
        run();
        sendResponse({ ok: true });
      }
    } else if (msg.type === 'liexport:stop') {
      cancelRequested = true;
      sendResponse({ ok: true });
    }
  });

  window.addEventListener('pagehide', () => {
    if (!running) return;
    // Best effort: the write may not finish before the page unloads; the
    // popup also detects a stale heartbeat and reports it.
    setState({
      status: 'error',
      errorCode: 'PAGE_UNLOADED',
      error:
        'The LinkedIn tab was closed, reloaded or navigated away while the export was running. ' +
        `${collected.size} connections were collected before it stopped \u2014 use "Download CSV" to save them, then start again.`,
    }, true);
  });

  // ---- State persistence (read by the popup) ------------------------------
  function rowsArray() {
    return Array.from(collected.values());
  }

  function setState(patch, forcePersist = false) {
    state = { ...state, ...patch, collected: collected.size, heartbeat: Date.now() };
    const now = Date.now();
    if (forcePersist || now - lastPersist > PERSIST_INTERVAL_MS) {
      lastPersist = now;
      lastHeartbeat = now;
      return chrome.storage.local.set({ liexportState: state, liexportRows: rowsArray() }).catch(() => {});
    }
    if (now - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
      lastHeartbeat = now;
      return chrome.storage.local.set({ liexportState: state }).catch(() => {});
    }
    return Promise.resolve();
  }

  function addWarning(w) {
    const warnings = state.warnings || [];
    if (!warnings.includes(w)) setState({ warnings: [...warnings, w] }, true);
  }

  // ---- Utilities ----------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function clean(s) {
    return (s || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  }

  function lines(el) {
    const text = (el && (el.innerText || el.textContent)) || '';
    return text.split(/\n+/).map(clean).filter(Boolean);
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function checkCancelled() {
    if (cancelRequested) throw new ExportError('CANCELLED', 'Export stopped by you.');
  }

  function checkStillOnPage() {
    const path = location.pathname;
    if (/\/(checkpoint|login|authwall|uas\/login)/.test(path)) {
      throw new ExportError(
        'LOGGED_OUT',
        'LinkedIn redirected to a login / security checkpoint page. Complete the check in this tab, ' +
          'go back to the connections page, and start the export again.'
      );
    }
    if (!/\/mynetwork\/invite-connect\/connections/.test(path)) {
      throw new ExportError(
        'NAVIGATED_AWAY',
        `The tab navigated away from the connections page (now at ${path}). ` +
          'Return to https://www.linkedin.com/mynetwork/invite-connect/connections/ and start again.'
      );
    }
  }

  function detectRateLimitOrErrorBanner() {
    const body = clean(document.body ? document.body.innerText.slice(0, 20000) : '');
    if (/too many requests|you('|\u2019)ve reached the (weekly|commercial) .*limit|unusual activity/i.test(body)) {
      return 'LinkedIn is showing a rate-limit / unusual-activity message.';
    }
    if (/something went wrong\.? (please )?(try again|reload)/i.test(body)) {
      return 'LinkedIn is showing a "Something went wrong" message.';
    }
    return null;
  }

  // ---- DOM discovery ------------------------------------------------------
  function listRoot() {
    return document.querySelector('main') || document.body;
  }

  /**
   * Walk up from a profile link to the element that represents one
   * connection "card": the nearest ancestor that contains "Connected ..."
   * text and links to exactly one person.
   */
  function findCardContainer(anchor, root) {
    const slug = L.normalizeProfileUrl(anchor.href);
    let el = anchor.parentElement;
    for (let depth = 0; el && depth < 15; depth++, el = el.parentElement) {
      if (/Connected/.test(el.textContent || '')) {
        const urls = new Set();
        for (const a of el.querySelectorAll('a[href*="/in/"]')) {
          const u = L.normalizeProfileUrl(a.href);
          if (u) urls.add(u);
          if (urls.size > 1) break;
        }
        return urls.size === 1 && urls.has(slug) ? el : null;
      }
      if (el === root) break;
    }
    return null;
  }

  function extractName(card, anchors) {
    // 1. Known (legacy) LinkedIn class names
    const known = card.querySelector('.mn-connection-card__name, [class*="connection-card__name"]');
    if (known && clean(known.innerText || known.textContent)) return clean(known.innerText || known.textContent);

    // 2. First line of a profile link's text (the name link)
    for (const a of anchors) {
      const first = lines(a)[0];
      if (first && !NOISE_LINE.test(first) && first.length < 120) return first;
    }
    // 3. aria-label such as "View Jane Doe\u2019s profile"
    for (const a of anchors) {
      const label = clean(a.getAttribute('aria-label'));
      const m = label.match(/^View (.+?)[\u2019']s? profile/i);
      if (m) return m[1];
    }
    // 4. Profile photo alt text
    const img = card.querySelector('img[alt]');
    if (img) {
      const alt = clean(img.alt).replace(/^(photo of|profile (photo|picture) of)\s+/i, '').replace(/[\u2019']s? profile (photo|picture)$/i, '');
      if (alt && !/^(profile|photo|image)$/i.test(alt)) return alt;
    }
    return '';
  }

  function extractTitle(card, name) {
    const known = card.querySelector('.mn-connection-card__occupation, [class*="connection-card__occupation"]');
    if (known && clean(known.innerText || known.textContent)) return clean(known.innerText || known.textContent);

    const candidates = lines(card).filter(
      (l) => l !== name && !l.startsWith(name + ' ') && !NOISE_LINE.test(l) && !/^(he|she|they)\/\w+$/i.test(l)
    );
    return candidates[0] || '';
  }

  function extractConnectedText(card) {
    const known = card.querySelector('.time-badge, time');
    if (known && /connected/i.test(known.textContent || '')) return clean(known.textContent);
    // Smallest element whose own text starts with "Connected" (avoids gluing
    // on neighbouring inline text such as a "Message" button label).
    let best = null;
    for (const el of card.querySelectorAll('*')) {
      const t = clean(el.textContent);
      if (/^Connected\b/.test(t) && (!best || t.length < best.length)) best = t;
    }
    if (best && best.length < 60) return best;
    const line = lines(card).find((l) => /^connected\b/i.test(l));
    if (line) return line;
    const m = clean(card.textContent).match(/Connected (on [A-Za-z]+\.? \d{1,2},? \d{4}|[^\u00B7\u2022|]{1,30}?ago|today|yesterday)/i);
    return m ? clean(m[0]) : '';
  }

  /** Read all currently-rendered cards into `collected`. Returns stats for diagnostics. */
  function harvest() {
    const root = listRoot();
    const anchors = root.querySelectorAll('a[href*="/in/"]');
    const groups = new Map(); // url -> { card, anchors[] }
    let profileLinks = 0;

    for (const a of anchors) {
      const url = L.normalizeProfileUrl(a.href);
      if (!url) continue;
      profileLinks++;
      const existing = collected.get(url);
      if (existing && existing.name && existing.connectedText) continue; // already complete
      let g = groups.get(url);
      if (!g) {
        const card = findCardContainer(a, root);
        if (!card) continue;
        g = { card, anchors: [] };
        groups.set(url, g);
      }
      g.anchors.push(a);
    }

    for (const [url, { card, anchors: as }] of groups) {
      const name = extractName(card, as);
      const title = extractTitle(card, name);
      const connectedText = extractConnectedText(card);
      const parsed = L.parseConnectedDate(connectedText);
      const prev = collected.get(url) || {};
      collected.set(url, {
        name: name || prev.name || '',
        title: title || prev.title || '',
        connectedText: connectedText || prev.connectedText || '',
        connectedDate: (parsed && parsed.iso) || prev.connectedDate || '',
        connectedDateApproximate: parsed ? parsed.approximate : prev.connectedDateApproximate || false,
        profileUrl: url,
      });
      if (!state.sampleCardHtml) state.sampleCardHtml = card.outerHTML.slice(0, 4000);
    }
    return { profileLinks, cardsThisPass: groups.size };
  }

  function readExpectedTotal() {
    const root = listRoot();
    const re = /^([\d.,\s]+)\s+connections?$/i;
    for (const el of root.querySelectorAll('h1, h2, h3, header, p, span, div')) {
      if (el.children.length > 3) continue;
      const t = clean(el.textContent);
      if (t.length > 40) continue;
      const m = t.match(re);
      if (m) {
        const n = parseInt(m[1].replace(/[^\d]/g, ''), 10);
        if (n > 0) return n;
      }
    }
    return null;
  }

  function findLoadMoreButton() {
    const buttons = document.querySelectorAll('button, a[role="button"]');
    for (const b of buttons) {
      const t = clean(b.innerText || b.textContent);
      if (/^(show more results|load more|show more|see more)$/i.test(t) && !b.disabled && isVisible(b)) return b;
    }
    return null;
  }

  function getScrollParent(el) {
    for (let p = el && el.parentElement; p && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 10) return p;
    }
    return document.scrollingElement || document.documentElement;
  }

  function lastCardElement() {
    const anchors = listRoot().querySelectorAll('a[href*="/in/"]');
    return anchors.length ? anchors[anchors.length - 1] : null;
  }

  function loadMore(nudge) {
    const btn = findLoadMoreButton();
    if (btn) {
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return 'clicked "' + clean(btn.innerText || btn.textContent) + '"';
    }
    const last = lastCardElement();
    const scroller = getScrollParent(last);
    if (nudge) {
      // Scrolling up a bit and back down re-triggers lazy-load observers.
      scroller.scrollTop = Math.max(0, scroller.scrollTop - 1500);
    }
    setTimeout(() => {
      if (last) last.scrollIntoView({ block: 'end' });
      scroller.scrollTop = scroller.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    }, nudge ? 400 : 0);
    return 'scrolled';
  }

  async function waitFor(predicate, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      checkCancelled();
      if (predicate()) return true;
      await sleep(500);
      setState({});
    }
    return predicate();
  }

  async function waitWhileHidden() {
    if (!document.hidden) return;
    const prevPhase = state.phase;
    setState({ phase: 'Paused \u2014 Chrome slows down background tabs. Switch back to the LinkedIn tab to continue.' }, true);
    while (document.hidden) {
      checkCancelled();
      await sleep(1000);
      setState({});
    }
    setState({ phase: prevPhase }, true);
  }

  // ---- Post-run quality checks --------------------------------------------
  function qualityWarnings(rows) {
    const warnings = [];
    if (!rows.length) return warnings;
    const pct = (n) => Math.round((n / rows.length) * 100);
    const noName = rows.filter((r) => !r.name).length;
    const noDate = rows.filter((r) => !r.connectedText).length;
    const unparsedDate = rows.filter((r) => r.connectedText && !r.connectedDate).length;
    const noTitle = rows.filter((r) => !r.title).length;
    if (noName / rows.length > 0.05)
      warnings.push(`${pct(noName)}% of rows have no name \u2014 LinkedIn's HTML for the name may have changed.`);
    if (noDate / rows.length > 0.05)
      warnings.push(`${pct(noDate)}% of rows have no connection date \u2014 LinkedIn's HTML for the "Connected \u2026" text may have changed.`);
    if (unparsedDate / rows.length > 0.05)
      warnings.push(
        `${pct(unparsedDate)}% of connection dates couldn't be converted to a date (raw text is still in the "Connected (as shown)" column). ` +
          `Example: "${rows.find((r) => r.connectedText && !r.connectedDate).connectedText}".`
      );
    if (noTitle / rows.length > 0.3)
      warnings.push(`${pct(noTitle)}% of rows have no title \u2014 LinkedIn's HTML for the headline may have changed.`);
    if (rows.some((r) => r.connectedDateApproximate))
      warnings.push('Some dates were shown as relative ("3 weeks ago") and are approximate \u2014 see the "Date Is Approximate" column.');
    return warnings;
  }

  function downloadCsv(rows, partial) {
    const csv = L.toCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `linkedin-connections-${L.toIsoDate(new Date())}${partial ? '-PARTIAL' : ''}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---- Main --------------------------------------------------------------
  async function run() {
    running = true;
    cancelRequested = false;
    collected.clear();
    state = { status: 'running', phase: 'Starting\u2026', startedAt: Date.now(), warnings: [], error: null, errorCode: null, expectedTotal: null };
    await setState({}, true);

    try {
      checkStillOnPage();

      // 1. Wait for the first cards to render.
      setState({ phase: 'Waiting for the connections list to load\u2026' }, true);
      let stats = { profileLinks: 0, cardsThisPass: 0 };
      const found = await waitFor(() => {
        stats = harvest();
        return collected.size > 0;
      }, FIRST_CARDS_TIMEOUT_MS);

      if (!found) {
        const banner = detectRateLimitOrErrorBanner();
        throw new ExportError(
          'NO_CARDS_FOUND',
          banner
            ? `${banner} No connections could be read. Wait a while, reload the page, and try again.`
            : 'Could not find any connection cards on the page. LinkedIn has probably changed its page structure ' +
                '(or the page is not in English \u2014 the exporter looks for the "Connected \u2026" label on each card). ' +
                `Diagnostics: ${stats.profileLinks} profile links found on the page, but none sat inside a card containing "Connected" text.`,
          { profileLinks: stats.profileLinks }
        );
      }

      const expectedTotal = readExpectedTotal();
      setState({ expectedTotal }, true);
      if (!expectedTotal) {
        addWarning(
          'Could not read the total connection count from the page header, so the exporter cannot verify it reached the end of the list.'
        );
      }

      // 2. Paginate.
      let noGrowth = 0;
      let lastAction = '';
      while (true) {
        checkCancelled();
        checkStillOnPage();
        await waitWhileHidden();

        if (expectedTotal && collected.size >= expectedTotal) break;

        const before = collected.size;
        lastAction = loadMore(noGrowth > 0);
        setState({
          phase:
            noGrowth === 0
              ? `Loading more connections (${lastAction})\u2026`
              : `No new connections yet \u2014 retrying (${noGrowth}/${MAX_NO_GROWTH_ATTEMPTS})\u2026`,
        });

        const grew = await waitFor(() => {
          harvest();
          return collected.size > before;
        }, GROWTH_TIMEOUT_MS + noGrowth * 3000);

        if (grew) {
          noGrowth = 0;
          // Let any remaining cards in this batch render before the next request.
          await sleep(600);
          harvest();
        } else if (document.hidden) {
          continue; // don't count throttled background-tab time as a failure
        } else {
          noGrowth++;
          if (noGrowth >= MAX_NO_GROWTH_ATTEMPTS) break;
        }
        setState({});
      }

      // 3. Decide whether we really reached the end.
      harvest();
      const rows = rowsArray();
      const warnings = [...(state.warnings || []), ...qualityWarnings(rows)];
      let status = 'done';
      let error = null;
      let errorCode = null;

      const banner = detectRateLimitOrErrorBanner();
      const stillHasButton = !!findLoadMoreButton();
      // LinkedIn's header count often includes a few deactivated/hidden members, so allow a small gap.
      const tolerance = expectedTotal ? Math.max(3, Math.ceil(expectedTotal * 0.01)) : 0;

      if (expectedTotal && rows.length < expectedTotal - tolerance) {
        status = 'incomplete';
        errorCode = 'STOPPED_EARLY';
        error =
          `Pagination stopped early: collected ${rows.length} of ${expectedTotal} connections ` +
          `(${Math.round((rows.length / expectedTotal) * 100)}%). ` +
          (banner
            ? banner + ' '
            : stillHasButton
              ? 'The "Show more results" button is still on the page but stopped loading new people (LinkedIn may be throttling requests). '
              : 'No new connections loaded after several scroll attempts \u2014 LinkedIn may be throttling requests, or the way the list loads has changed. ') +
          'A partial CSV has been downloaded. Wait a few minutes and try again.';
      } else if (!expectedTotal && (stillHasButton || banner)) {
        status = 'incomplete';
        errorCode = 'STOPPED_EARLY';
        error =
          `Stopped after ${rows.length} connections but the list may not be finished. ` +
          (banner || 'A "Show more results" button is still visible but stopped loading new people.') +
          ' A partial CSV has been downloaded.';
      } else if (expectedTotal && rows.length < expectedTotal) {
        warnings.push(
          `Collected ${rows.length} of ${expectedTotal} \u2014 the small difference is normal (LinkedIn's count includes deactivated or hidden members).`
        );
      }

      setState({ status, error, errorCode, warnings, phase: status === 'done' ? 'Finished.' : 'Stopped early.', finishedAt: Date.now() }, true);
      downloadCsv(rows, status !== 'done');
    } catch (err) {
      const rows = rowsArray();
      if (err instanceof ExportError && err.code === 'CANCELLED') {
        setState({ status: 'cancelled', phase: 'Stopped.', error: `Stopped by you after ${rows.length} connections. Use "Download CSV" to save them.`, errorCode: 'CANCELLED' }, true);
      } else {
        const isKnown = err instanceof ExportError;
        setState({
          status: 'error',
          phase: 'Failed.',
          errorCode: isKnown ? err.code : 'UNEXPECTED',
          error:
            (isKnown ? err.message : `Unexpected error: ${err && err.message}. This usually means LinkedIn changed its page structure.`) +
            (rows.length ? ` ${rows.length} connections were collected before the failure; a partial CSV has been downloaded.` : ''),
          errorStack: err && err.stack ? String(err.stack).slice(0, 2000) : null,
          errorDetails: (err && err.details) || null,
        }, true);
        if (rows.length) downloadCsv(rows, true);
      }
    } finally {
      running = false;
    }
  }
})();
