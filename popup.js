'use strict';

const CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
const STALL_MS = 45000; // no heartbeat for this long while "running" => content script died

const $ = (id) => document.getElementById(id);
let tab = null;

function isConnectionsPage(url) {
  return /^https:\/\/www\.linkedin\.com\/mynetwork\/invite-connect\/connections/.test(url || '');
}

async function getStored() {
  return chrome.storage.local.get(['liexportState', 'liexportRows']);
}

function show(el, visible) {
  el.hidden = !visible;
}

function render({ liexportState: s, liexportRows: rows }) {
  rows = rows || [];
  s = s || null;

  const stalled = s && s.status === 'running' && Date.now() - (s.heartbeat || 0) > STALL_MS;
  const running = s && s.status === 'running' && !stalled;
  const count = s ? s.collected || rows.length : 0;

  $('count').textContent = count.toLocaleString();
  $('total').textContent = s && s.expectedTotal ? ` / ${s.expectedTotal.toLocaleString()}` : '';
  $('bar-fill').style.width = s && s.expectedTotal ? Math.min(100, (count / s.expectedTotal) * 100) + '%' : running ? '100%' : '0';
  $('phase').textContent = stalled ? 'Stalled.' : s ? s.phase || '' : 'Ready.';

  let errorText = null;
  if (stalled) {
    errorText =
      `The export stopped responding (no update for ${Math.round((Date.now() - s.heartbeat) / 1000)}s). ` +
      'The LinkedIn tab was probably closed, reloaded, or navigated away. ' +
      `${rows.length} connections were saved \u2014 click "Download CSV" to get them, then start again.`;
  } else if (s && s.error && s.status !== 'running') {
    errorText = s.error;
  }
  $('error').textContent = errorText || '';
  show($('error'), !!errorText);

  const done = s && s.status === 'done';
  $('success').textContent = done ? `Done! Exported ${rows.length.toLocaleString()} connections. The CSV has been downloaded.` : '';
  show($('success'), done);

  const warnings = (s && s.warnings) || [];
  $('warnings').replaceChildren(...warnings.map((w) => Object.assign(document.createElement('li'), { textContent: w })));
  show($('warnings'), warnings.length > 0 && !running);

  show($('start'), !running);
  $('start').textContent = s && s.status && s.status !== 'running' ? 'Start again' : 'Start export';
  $('start').disabled = !tab || !isConnectionsPage(tab.url);
  show($('stop'), running);
  show($('download'), rows.length > 0 && !running);
  show($('copy-diag'), !!s && (s.status === 'error' || s.status === 'incomplete' || stalled || warnings.length > 0));
}

async function refresh() {
  render(await getStored());
}

async function sendToTab(message) {
  return chrome.tabs.sendMessage(tab.id, message);
}

async function ensureContentScript() {
  try {
    const res = await sendToTab({ type: 'liexport:ping' });
    if (res && res.ok) return;
  } catch (e) {
    /* not injected yet */
  }
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib.js', 'content.js'] });
}

function showError(msg) {
  $('error').textContent = msg;
  show($('error'), true);
}

$('start').addEventListener('click', async () => {
  $('start').disabled = true;
  try {
    await ensureContentScript();
    const res = await sendToTab({ type: 'liexport:start' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'The page did not respond.');
  } catch (e) {
    showError(
      `Couldn't start the export: ${e.message}. Try reloading the LinkedIn tab and opening this popup again.`
    );
    $('start').disabled = false;
  }
});

$('stop').addEventListener('click', async () => {
  try {
    await sendToTab({ type: 'liexport:stop' });
  } catch (e) {
    showError(`Couldn't reach the LinkedIn tab to stop it (${e.message}). It may already have stopped.`);
  }
});

$('download').addEventListener('click', async () => {
  const { liexportState: s, liexportRows: rows } = await getStored();
  if (!rows || !rows.length) return;
  const partial = !s || s.status !== 'done';
  const blob = new Blob([LIExport.toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `linkedin-connections-${LIExport.toIsoDate(new Date())}${partial ? '-PARTIAL' : ''}.csv`,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});

$('copy-diag').addEventListener('click', async () => {
  const { liexportState: s, liexportRows: rows } = await getStored();
  const diag = {
    extensionVersion: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    tabUrl: tab && tab.url,
    state: s,
    rowCount: (rows || []).length,
    sampleRows: (rows || []).slice(0, 3),
  };
  await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
  $('copy-diag').textContent = 'Copied!';
});

$('open-page').addEventListener('click', async () => {
  if (tab) await chrome.tabs.update(tab.id, { url: CONNECTIONS_URL });
  else await chrome.tabs.create({ url: CONNECTIONS_URL });
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.liexportState || changes.liexportRows)) refresh();
});

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onPage = tab && isConnectionsPage(tab.url);
  const stored = await getStored();
  // Show the main panel if on the right page, or if there's a previous result to download.
  show($('wrong-page'), !onPage);
  show($('main'), onPage || !!(stored.liexportRows && stored.liexportRows.length));
  render(stored);
  // Re-render periodically so stall detection kicks in even without storage changes.
  setInterval(refresh, 5000);
})();
