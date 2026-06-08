'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  document.getElementById('redirect-uri').textContent = redirectUri;

  chrome.storage.sync.get(['tenantId', 'clientId'], ({ tenantId, clientId }) => {
    if (tenantId) document.getElementById('tenant-id').value = tenantId;
    if (clientId) document.getElementById('client-id').value = clientId;
  });

  document.getElementById('save-btn').addEventListener('click', () => {
    const tenantId = document.getElementById('tenant-id').value.trim();
    const clientId = document.getElementById('client-id').value.trim();
    const errorMsg = document.getElementById('error-msg');
    const savedMsg = document.getElementById('saved-msg');

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(tenantId) || !uuidRe.test(clientId)) {
      errorMsg.textContent = 'Both fields must be valid GUIDs.';
      savedMsg.textContent = '';
      return;
    }
    errorMsg.textContent = '';

    chrome.storage.sync.set({ tenantId, clientId }, () => {
      savedMsg.textContent = 'Saved!';
      setTimeout(() => { savedMsg.textContent = ''; }, 2500);
      // Clear any cached tokens so next sign-in uses new config
      chrome.storage.local.remove(['accessToken', 'refreshToken', 'tokenExpiry', 'flowsCache', 'flowsLastUpdated']);
    });
  });

  document.getElementById('copy-btn').addEventListener('click', () => {
    const uri = document.getElementById('redirect-uri').textContent;
    navigator.clipboard.writeText(uri).then(() => {
      const btn = document.getElementById('copy-btn');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy URI'; }, 2000);
    });
  });
});
