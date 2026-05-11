'use strict';

var DEFAULTS = {
  showProbabilityBar: false,
  defaultRowsShown:   5,
  showDuration:       true,
  showModifiedBy:     true
};

// ── Storage helpers (localStorage namespaced by user ID) ─────────────────────
// ZOHO.CRM.WIDGET.STORE is not implemented in the CRM SDK — localStorage is
// the reliable alternative. Namespaced by user ID so different org installs
// on the same browser don't share state.

var _storageKey = null;

function getStorageKey() {
  if (_storageKey) return Promise.resolve(_storageKey);
  return ZOHO.CRM.CONFIG.getCurrentUser()
    .then(function (data) {
      var userId = (data && data.id) || 'default';
      _storageKey = 'sht_settings_' + userId;
      return _storageKey;
    })
    .catch(function () {
      _storageKey = 'sht_settings_default';
      return _storageKey;
    });
}

function loadFromStorage() {
  return getStorageKey().then(function (key) {
    var raw = localStorage.getItem(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  });
}

function saveToStorage(data) {
  return getStorageKey().then(function (key) {
    localStorage.setItem(key, JSON.stringify(data));
  });
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderForm(settings) {
  var app = document.getElementById('app');

  app.innerHTML =
    '<div class="page-header">' +
      '<div class="page-title">Stage History Timeline</div>' +
      '<div class="page-subtitle">Configure how the timeline displays on Deal records.</div>' +
    '</div>' +

    '<div class="card">' +

      // Probability Bar
      '<div class="setting-row">' +
        '<div>' +
          '<div class="setting-label">Probability Bar</div>' +
          '<div class="setting-description">Show a deal probability bar above the timeline.</div>' +
        '</div>' +
        '<label class="toggle">' +
          '<input type="checkbox" id="showProbabilityBar"' + (settings.showProbabilityBar ? ' checked' : '') + '>' +
          '<span class="toggle-track"></span>' +
        '</label>' +
      '</div>' +

      // Default Rows Shown
      '<div class="setting-row">' +
        '<div>' +
          '<div class="setting-label">Default Rows Shown</div>' +
          '<div class="setting-description">Number of stage rows visible before the "Show more" link appears (3–10).</div>' +
        '</div>' +
        '<input type="number" id="defaultRowsShown" class="number-input" min="3" max="10" value="' + settings.defaultRowsShown + '">' +
      '</div>' +

      // Show Duration
      '<div class="setting-row">' +
        '<div>' +
          '<div class="setting-label">Show Duration</div>' +
          '<div class="setting-description">Display the time spent in each past stage.</div>' +
        '</div>' +
        '<label class="toggle">' +
          '<input type="checkbox" id="showDuration"' + (settings.showDuration ? ' checked' : '') + '>' +
          '<span class="toggle-track"></span>' +
        '</label>' +
      '</div>' +

      // Show Modified By
      '<div class="setting-row">' +
        '<div>' +
          '<div class="setting-label">Show Modified By</div>' +
          '<div class="setting-description">Display the name of the rep who moved the deal to each stage.</div>' +
        '</div>' +
        '<label class="toggle">' +
          '<input type="checkbox" id="showModifiedBy"' + (settings.showModifiedBy ? ' checked' : '') + '>' +
          '<span class="toggle-track"></span>' +
        '</label>' +
      '</div>' +

    '</div>' +

    '<div class="actions">' +
      '<button id="btn-save" class="btn-save">Save Settings</button>' +
      '<span id="feedback" class="feedback"></span>' +
    '</div>';

  document.getElementById('btn-save').addEventListener('click', function () {
    handleSave();
  });
}

function handleSave() {
  var saveBtn  = document.getElementById('btn-save');
  var feedback = document.getElementById('feedback');

  var rowsInput = document.getElementById('defaultRowsShown');
  var rows = parseInt(rowsInput.value, 10);
  if (isNaN(rows) || rows < 3 || rows > 10) {
    rowsInput.focus();
    feedback.textContent = 'Default Rows must be a number between 3 and 10.';
    feedback.className = 'feedback feedback--error';
    return;
  }

  var data = {
    showProbabilityBar: document.getElementById('showProbabilityBar').checked,
    defaultRowsShown:   rows,
    showDuration:       document.getElementById('showDuration').checked,
    showModifiedBy:     document.getElementById('showModifiedBy').checked
  };

  saveBtn.disabled  = true;
  saveBtn.textContent = 'Saving…';
  feedback.textContent = '';
  feedback.className = 'feedback';

  saveToStorage(data)
    .then(function () {
      feedback.textContent = '✓ Settings saved.';
      feedback.className = 'feedback feedback--success';
    })
    .catch(function (err) {
      feedback.textContent = 'Failed to save: ' + (err && err.message ? err.message : 'unknown error');
      feedback.className = 'feedback feedback--error';
    })
    .finally(function () {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Settings';
    });
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
  var app = document.getElementById('app');
  app.innerHTML = '<div class="state-loading">Loading settings…</div>';

  loadFromStorage()
    .then(function (stored) {
      var settings = Object.assign({}, DEFAULTS, stored || {});
      renderForm(settings);
    })
    .catch(function () {
      app.innerHTML = '<div class="state-error">Failed to load settings.</div>';
    });
}

// PageLoad fires when embedded in CRM. DOMContentLoaded is the fallback for
// direct URL access (local dev) where the SDK event never fires.
ZOHO.embeddedApp.on('PageLoad', function () { init(); });
ZOHO.embeddedApp.init();

document.addEventListener('DOMContentLoaded', function () {
  setTimeout(function () {
    if (!document.getElementById('app').hasChildNodes()) init();
  }, 800);
});
