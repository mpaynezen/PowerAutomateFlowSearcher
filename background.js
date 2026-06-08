const FLOW_API_BASE = 'https://api.flow.microsoft.com';
const API_VERSION = '2016-11-01';
const FLOW_SCOPE = 'https://service.flow.microsoft.com/.default offline_access';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ─── PKCE helpers ────────────────────────────────────────────────────────────

function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

async function generateCodeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ─── Config / storage helpers ────────────────────────────────────────────────

function getConfig() {
  return chrome.storage.sync.get(['tenantId', 'clientId']);
}

function getLocalStorage(keys) {
  return chrome.storage.local.get(keys);
}

function setLocalStorage(data) {
  return chrome.storage.local.set(data);
}

// ─── Token management ────────────────────────────────────────────────────────

async function getValidToken() {
  const { accessToken, refreshToken, tokenExpiry } = await getLocalStorage([
    'accessToken', 'refreshToken', 'tokenExpiry'
  ]);

  if (accessToken && tokenExpiry > Date.now()) return accessToken;
  if (refreshToken) return tryRefresh(refreshToken);
  return authorizeUser();
}

async function tryRefresh(refreshToken) {
  const { tenantId, clientId } = await getConfig();
  if (!tenantId || !clientId) throw new Error('CONFIG_MISSING');

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: FLOW_SCOPE,
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  if (!res.ok) {
    await chrome.storage.local.remove(['accessToken', 'refreshToken', 'tokenExpiry']);
    return authorizeUser();
  }

  const data = await res.json();
  await storeTokens(data, refreshToken);
  return data.access_token;
}

async function authorizeUser() {
  const { tenantId, clientId } = await getConfig();
  if (!tenantId || !clientId) throw new Error('CONFIG_MISSING');

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;

  const authUrl = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', FLOW_SCOPE);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', 'select_account');

  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true }, url => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(url);
    });
  });

  const params = new URL(responseUrl).searchParams;
  if (params.get('state') !== state) throw new Error('State mismatch — possible CSRF');

  const code = params.get('code');
  if (!code) throw new Error('No authorization code in redirect');

  const tokenBody = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    { method: 'POST', body: tokenBody, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  if (!tokenRes.ok) {
    const err = await tokenRes.json().catch(() => ({}));
    throw new Error(err.error_description || `Token exchange failed (${tokenRes.status})`);
  }

  const tokenData = await tokenRes.json();
  await storeTokens(tokenData, null);
  return tokenData.access_token;
}

async function storeTokens(data, fallbackRefreshToken) {
  const expiry = Date.now() + (data.expires_in - 60) * 1000;
  await setLocalStorage({
    accessToken: data.access_token,
    refreshToken: data.refresh_token || fallbackRefreshToken,
    tokenExpiry: expiry,
  });
}

// ─── Power Automate API ──────────────────────────────────────────────────────

async function apiGet(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error('TOKEN_EXPIRED');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchAllFlows(token) {
  const envsData = await apiGet(
    `${FLOW_API_BASE}/providers/Microsoft.ProcessSimple/environments?api-version=${API_VERSION}`,
    token
  );
  const environments = envsData.value || [];

  if (environments.length === 0) {
    throw new Error('No Power Automate environments found for this account.');
  }

  const allFlows = [];
  const envErrors = [];

  for (const env of environments) {
    const envId = env.name;
    const envName = env.properties?.displayName || envId;

    let url = `${FLOW_API_BASE}/providers/Microsoft.ProcessSimple/environments/${envId}/flows?api-version=${API_VERSION}&$top=50`;

    while (url) {
      let page;
      try {
        page = await apiGet(url, token);
      } catch (err) {
        envErrors.push(`[${envName}] ${err.message}`);
        break;
      }

      for (const flow of page.value || []) {
        allFlows.push(extractFlowData(flow, envId, envName));
      }

      // API returns either nextLink or @odata.nextLink
      url = page.nextLink || page['@odata.nextLink'] || null;
    }
  }

  if (allFlows.length === 0) {
    const detail = envErrors.length
      ? `API errors:\n${envErrors.join('\n')}`
      : `Checked ${environments.length} environment(s) but found no flows. Make sure Flows.Read.All is consented.`;
    throw new Error(detail);
  }

  if (envErrors.length) {
    // Partial success — return flows but attach warnings
    return { flows: allFlows, warnings: envErrors };
  }

  return { flows: allFlows, warnings: [] };
}

async function diagnose(token) {
  const result = { environments: [], errors: [] };
  try {
    const envsData = await apiGet(
      `${FLOW_API_BASE}/providers/Microsoft.ProcessSimple/environments?api-version=${API_VERSION}`,
      token
    );
    for (const env of envsData.value || []) {
      const envEntry = { id: env.name, name: env.properties?.displayName || env.name, flowCount: null, error: null };
      try {
        const flowsData = await apiGet(
          `${FLOW_API_BASE}/providers/Microsoft.ProcessSimple/environments/${env.name}/flows?api-version=${API_VERSION}&$top=50`,
          token
        );
        envEntry.flowCount = (flowsData.value || []).length;
        envEntry.hasMore = !!(flowsData.nextLink || flowsData['@odata.nextLink']);
      } catch (err) {
        envEntry.error = err.message;
      }
      result.environments.push(envEntry);
    }
  } catch (err) {
    result.errors.push(`Environments fetch failed: ${err.message}`);
  }
  return result;
}

function extractFlowData(flow, envId, envName) {
  const props = flow.properties || {};
  const definition = props.definition || {};
  const connectionRefs = props.connectionReferences || definition.connectionReferences || {};

  const connectors = [
    ...new Set(
      Object.values(connectionRefs)
        .map(ref => formatConnectorName(ref?.api?.name || ref?.apiDefinition?.displayName))
        .filter(Boolean)
    ),
  ];

  const actions = extractActionNames(definition.actions || {});

  return {
    id: flow.name,
    name: props.displayName || flow.name,
    state: props.state || 'unknown',
    envId,
    envName,
    url: `https://make.powerautomate.com/environments/${envId}/flows/${flow.name}/details`,
    connectors,
    actions,
    lastModified: props.lastModifiedTime || props.createdTime || null,
  };
}

function extractActionNames(actions, depth = 0) {
  if (!actions || depth > 8) return [];
  const names = [];

  for (const [name, action] of Object.entries(actions)) {
    names.push(formatActionName(name));
    if (action.actions) names.push(...extractActionNames(action.actions, depth + 1));
    if (action.else?.actions) names.push(...extractActionNames(action.else.actions, depth + 1));
    if (action.default?.actions) names.push(...extractActionNames(action.default.actions, depth + 1));
    if (action.cases) {
      for (const branch of Object.values(action.cases)) {
        if (branch.actions) names.push(...extractActionNames(branch.actions, depth + 1));
      }
    }
  }

  return [...new Set(names)];
}

function formatConnectorName(apiName) {
  if (!apiName) return null;
  return apiName
    .replace(/^shared_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

function formatActionName(name) {
  return name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case 'GET_STATUS': {
      const { accessToken, tokenExpiry, flowsLastUpdated } = await getLocalStorage([
        'accessToken', 'tokenExpiry', 'flowsLastUpdated'
      ]);
      return {
        isSignedIn: !!(accessToken && tokenExpiry > Date.now()),
        flowsLastUpdated: flowsLastUpdated || null,
      };
    }

    case 'SIGN_IN': {
      await getValidToken();
      return { ok: true };
    }

    case 'SIGN_OUT': {
      await chrome.storage.local.remove([
        'accessToken', 'refreshToken', 'tokenExpiry', 'flowsCache', 'flowsLastUpdated'
      ]);
      return { ok: true };
    }

    case 'GET_FLOWS': {
      const { flowsCache, flowsLastUpdated } = await getLocalStorage(['flowsCache', 'flowsLastUpdated']);
      const isStale = !flowsLastUpdated || (Date.now() - flowsLastUpdated) > CACHE_TTL_MS;

      if (flowsCache) {
        // Return cache immediately; refresh in background if stale
        if (isStale) {
          handleRefreshFlows().catch(console.error);
        }
        return { flows: flowsCache, lastUpdated: flowsLastUpdated, fromCache: true, syncing: isStale };
      }

      // No cache yet — must wait for the initial fetch
      return handleRefreshFlows();
    }

    case 'REFRESH_FLOWS': {
      return handleRefreshFlows();
    }

    case 'DIAGNOSE': {
      const token = await getValidToken();
      return diagnose(token);
    }

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

async function handleRefreshFlows() {
  const token = await getValidToken();
  const { flows, warnings } = await fetchAllFlows(token);
  const now = Date.now();
  await setLocalStorage({ flowsCache: flows, flowsLastUpdated: now });
  return { flows, warnings, lastUpdated: now, fromCache: false };
}

// ─── Diagnose handler (for debugging) ───────────────────────────────────────
