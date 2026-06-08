'use strict';

let allFlows = [];
let searchTimer = null;
const activeFilters = new Set(['name', 'connector', 'action']);

// ─── Utilities ────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlight(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
}

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (response?.error) return reject(new Error(response.error));
      resolve(response);
    });
  });
}

// ─── Status bar ───────────────────────────────────────────────────────────────

let statusTimer = null;
function setStatus(msg, type = 'info') {
  clearTimeout(statusTimer);
  hide('error-box');
  const bar = $('status-bar');
  bar.textContent = msg;
  bar.className = `status-bar status-${type}`;
  bar.classList.remove('hidden');
  if (type !== 'error') {
    statusTimer = setTimeout(() => bar.classList.add('hidden'), 3000);
  }
}

function setError(msg) {
  clearTimeout(statusTimer);
  hide('status-bar');
  const box = $('error-box');
  $('error-text').textContent = msg;
  box.classList.remove('hidden');
}

// ─── View transitions ─────────────────────────────────────────────────────────

function showAuth() {
  hide('loading-section');
  hide('results-section');
  show('auth-section');
}

function showLoading(text = 'Loading flows…') {
  hide('auth-section');
  hide('results-section');
  $('loading-text').textContent = text;
  show('loading-section');
}

function showResults() {
  hide('auth-section');
  hide('loading-section');
  show('results-section');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  hide('auth-section');
  hide('loading-section');
  hide('results-section');

  try {
    const status = await sendMessage({ type: 'GET_STATUS' });
    if (!status.isSignedIn) return showAuth();
    await loadFlows(false);
  } catch (err) {
    handleError(err);
  }
}

// ─── Flow loading ─────────────────────────────────────────────────────────────

async function loadFlows(forceRefresh) {
  // Only show the full loading screen when we have no cache to display
  if (forceRefresh) {
    setSyncing(true);
  } else {
    showLoading('Loading flows…');
  }

  try {
    const res = await sendMessage({ type: forceRefresh ? 'REFRESH_FLOWS' : 'GET_FLOWS' });
    allFlows = res.flows || [];
    updateFooter(res.lastUpdated);
    showResults();
    renderResults(getCurrentQuery());

    if (res.syncing) {
      // Cache returned, background refresh is running — show subtle indicator
      setSyncing(true);
      setStatus(`Showing cached results, syncing…`, 'info');
    } else {
      setSyncing(false);
      const label = res.fromCache ? 'Loaded from cache' : 'Flows updated';
      setStatus(`${label} — ${allFlows.length} flow${allFlows.length !== 1 ? 's' : ''}`, 'success');
    }

    if (res.warnings?.length) {
      console.warn('PA Flow Search warnings:', res.warnings);
    }
  } catch (err) {
    setSyncing(false);
    handleError(err);
  }
}

function setSyncing(active) {
  $('refresh-btn').classList.toggle('syncing', active);
}

function handleError(err) {
  const msg = err.message || String(err);
  if (msg === 'CONFIG_MISSING') {
    showAuth();
    setStatus('Configure your Azure AD settings first.', 'error');
  } else if (msg.includes('did not approve') || msg.includes('canceled') || msg.includes('user_cancelled')) {
    showAuth();
  } else if (msg.includes('TOKEN_EXPIRED')) {
    showAuth();
    setStatus('Session expired. Please sign in again.', 'error');
  } else {
    showAuth();
    setError(msg);
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function getCurrentQuery() {
  return $('search-input').value.trim().toLowerCase();
}

function renderResults(query) {
  const filtered = query ? filterFlows(query) : allFlows;
  const meta = $('results-meta');
  const list = $('results-list');

  meta.textContent = query
    ? `${filtered.length} of ${allFlows.length} flows`
    : `${allFlows.length} flow${allFlows.length !== 1 ? 's' : ''}`;

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state">${query ? 'No flows match your search.' : 'No flows found.'}</div>`;
    return;
  }

  list.innerHTML = filtered.map(flow => renderFlowCard(flow, query)).join('');
}

function renderFlowCard(flow, query) {
  const nameQ = activeFilters.has('name') ? query : '';
  const connQ = activeFilters.has('connector') ? query : '';

  const stateClass = flow.state === 'Started' ? 'state-on'
    : flow.state === 'Suspended' ? 'state-suspended'
    : 'state-off';
  const stateLabel = flow.state === 'Started' ? 'On'
    : flow.state === 'Suspended' ? 'Paused'
    : 'Off';

  const pills = flow.connectors.slice(0, 6).map(c =>
    `<span class="pill">${highlight(c, connQ)}</span>`
  ).join('');
  const morePill = flow.connectors.length > 6
    ? `<span class="pill pill-more">+${flow.connectors.length - 6}</span>`
    : '';

  const url = escapeHtml(flow.url);

  return `
    <div class="flow-card" data-url="${url}" role="button" tabindex="0">
      <div class="flow-header">
        <span class="flow-name">${highlight(flow.name, nameQ)}</span>
        <span class="state-badge ${stateClass}">${stateLabel}</span>
      </div>
      <div class="flow-env">${escapeHtml(flow.envName)}</div>
      ${pills || morePill ? `<div class="flow-pills">${pills}${morePill}</div>` : ''}
    </div>`;
}

// ─── Search logic ─────────────────────────────────────────────────────────────

function filterFlows(query) {
  return allFlows.filter(flow => {
    if (activeFilters.has('name') && flow.name.toLowerCase().includes(query)) return true;
    if (activeFilters.has('connector') && flow.connectors.some(c => c.toLowerCase().includes(query))) return true;
    if (activeFilters.has('action') && flow.actions.some(a => a.toLowerCase().includes(query))) return true;
    return false;
  });
}

// ─── Footer ───────────────────────────────────────────────────────────────────

function updateFooter(ts) {
  $('last-updated').textContent = ts
    ? `Updated ${new Date(ts).toLocaleTimeString()}`
    : '';
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  init();

  $('dismiss-error').addEventListener('click', () => hide('error-box'));

  $('sign-in-btn').addEventListener('click', async () => {
    showLoading('Signing in…');
    try {
      await sendMessage({ type: 'SIGN_IN' });
      await loadFlows(false);
    } catch (err) {
      handleError(err);
    }
  });

  $('settings-link').addEventListener('click', e => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  $('settings-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());

  $('refresh-btn').addEventListener('click', () => loadFlows(true));

  $('sign-out-btn').addEventListener('click', async () => {
    await sendMessage({ type: 'SIGN_OUT' });
    allFlows = [];
    $('search-input').value = '';
    showAuth();
    setStatus('Signed out', 'info');
  });

  $('search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderResults(e.target.value.trim().toLowerCase()), 180);
  });

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = btn.dataset.filter;
      if (activeFilters.has(f) && activeFilters.size > 1) {
        activeFilters.delete(f);
        btn.classList.remove('active');
      } else if (!activeFilters.has(f)) {
        activeFilters.add(f);
        btn.classList.add('active');
      }
      renderResults(getCurrentQuery());
    });
  });

  // Auto-update when background refresh writes new cache
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.flowsCache?.newValue) return;
    allFlows = changes.flowsCache.newValue;
    const ts = changes.flowsLastUpdated?.newValue ?? Date.now();
    updateFooter(ts);
    renderResults(getCurrentQuery());
    setSyncing(false);
    setStatus(`Flows updated — ${allFlows.length} flow${allFlows.length !== 1 ? 's' : ''}`, 'success');
  });

  // Open flow on card click or Enter
  document.getElementById('results-list').addEventListener('click', e => {
    const card = e.target.closest('.flow-card');
    if (card?.dataset.url) chrome.tabs.create({ url: card.dataset.url });
  });

  document.getElementById('results-list').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const card = e.target.closest('.flow-card');
      if (card?.dataset.url) chrome.tabs.create({ url: card.dataset.url });
    }
  });
});
