// Stage name lookup module — follows the two-level caching strategy from the build guide:
//
//   Level 1 — Stage field ID  (key: stage_field_id)
//     Cached permanently. Avoids scanning all Deals fields on every picklist refresh.
//
//   Level 2 — Stage picklist map  (key: stage_picklist_map)
//     Cached with 24hr TTL. Refreshed on expiry or when an unknown stage ID is encountered.
//
// Storage: extension storage (ZOHO.CRM.WIDGET.STORE) — org-scoped, Zoho-hosted.
// Falls back gracefully when storage is unavailable (local dev via ngrok sandbox).

var StageCache = (function () {
  'use strict';

  var FIELD_ID_KEY  = 'stage_field_id';
  var MAP_KEY       = 'stage_picklist_map';
  var TTL_MS        = 24 * 60 * 60 * 1000;

  // In-memory map for the current page load — avoids repeated storage reads.
  var _map = null;

  // ── Extension storage helpers ────────────────────────────────────────────────

  function storageAvailable() {
    return !!(ZOHO.CRM && ZOHO.CRM.WIDGET && ZOHO.CRM.WIDGET.STORE);
  }

  function storageGet(key) {
    if (!storageAvailable()) return Promise.resolve(null);
    return Promise.resolve(ZOHO.CRM.WIDGET.STORE.get({ key: key }))
      .then(function (res) {
        var raw = res && (res.value || res.Value);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
      })
      .catch(function (err) {
        console.warn('[StageCache] Storage read failed for "' + key + '":', err);
        return null;
      });
  }

  function storageSet(key, value) {
    if (!storageAvailable()) return Promise.resolve();
    return Promise.resolve(ZOHO.CRM.WIDGET.STORE.set({
      key: key,
      value: JSON.stringify(value)
    })).catch(function (err) {
      console.warn('[StageCache] Storage write failed for "' + key + '":', err);
    });
  }

  // ── CRM API — Call 1: find Stage field (paginated) ───────────────────────────

  function findStageField(page) {
    return ZOHO.CRM.META.getFields({ Entity: 'Deals', page: page, per_page: 200 })
      .then(function (response) {
        var fields = (response && response.fields) || [];
        var info   = response && response.info;

        for (var i = 0; i < fields.length; i++) {
          if (fields[i].api_name === 'Stage' || fields[i].field_label === 'Stage') {
            console.log('[StageCache] Stage field found on page', page, '— field ID:', fields[i].id);
            return fields[i];
          }
        }

        if (info && info.more_records) return findStageField(page + 1);

        return null;
      });
  }

  // ── CRM API — Call 2: extract picklist map from Stage field ──────────────────
  // pick_list_values are returned inline by getFields (no separate endpoint
  // needed in the SDK). The Stage field ID from Call 1 is cached permanently
  // so future map refreshes don't re-scan all fields if a targeted endpoint
  // becomes available via ZOHO.CRM.HTTP.

  function fetchAll() {
    console.log('[StageCache] Fetching Stage field and picklist from CRM…');
    return findStageField(1).then(function (stageField) {
      if (!stageField) throw new Error('[StageCache] Stage field not found in Deals fields.');

      var fieldId = stageField.id;
      var values  = stageField.pick_list_values || [];
      var map     = {};
      values.forEach(function (v) { map[v.id] = v.display_value; });

      console.log('[StageCache] Picklist map built (' + values.length + ' stages):');
      console.table(Object.keys(map).map(function (id) { return { id: id, stage: map[id] }; }));

      // Persist both levels to extension storage.
      return storageSet(FIELD_ID_KEY, fieldId)
        .then(function () {
          return storageSet(MAP_KEY, { map: map, timestamp: Date.now() });
        })
        .then(function () {
          console.log('[StageCache] Field ID and picklist map saved to extension storage.');
          return map;
        });
    });
  }

  // ── Core init + refresh ──────────────────────────────────────────────────────

  function refresh() {
    return fetchAll().then(function (freshMap) {
      _map = freshMap;
      return freshMap;
    });
  }

  function init() {
    if (_map) {
      console.log('[StageCache] Using in-memory map.');
      return Promise.resolve(_map);
    }

    return storageGet(MAP_KEY).then(function (stored) {
      var isStale = !stored || (Date.now() - stored.timestamp > TTL_MS);

      if (!isStale) {
        var ageMinutes = Math.round((Date.now() - stored.timestamp) / 60000);
        console.log('[StageCache] Loaded from extension storage (age: ' + ageMinutes + ' min).');
        _map = stored.map;
        return _map;
      }

      var reason = !storageAvailable()
        ? 'extension storage unavailable (local dev)'
        : !stored ? 'no cache found' : 'cache expired';

      console.log('[StageCache] ' + reason + ' — fetching from CRM.');
      return refresh();
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  function getStageNames(idArray) {
    return init().then(function (map) {
      var missedIds = idArray.filter(function (id) { return map[id] === undefined; });

      if (missedIds.length === 0) {
        return idArray.map(function (id) { return map[id]; });
      }

      // Unknown ID — a new stage was added to CRM after the map was built.
      console.warn('[StageCache] Cache miss for IDs:', missedIds, '— refreshing map.');
      return refresh().then(function (freshMap) {
        return idArray.map(function (id) { return freshMap[id] || 'Unknown Stage'; });
      });
    });
  }

  return { init: init, getStageNames: getStageNames };
})();


// ── Settings loader ──────────────────────────────────────────────────────────
// Reads from localStorage using the same key format as settings.js so both
// widgets stay in sync: sht_settings_{userId}

var SETTINGS_DEFAULTS = {
  showProbabilityBar: false,
  defaultRowsShown:   5,
  showDuration:       true,
  showModifiedBy:     true
};

var _settingsKey = null;

function getSettingsKey() {
  if (_settingsKey) return Promise.resolve(_settingsKey);
  return ZOHO.CRM.CONFIG.getCurrentUser()
    .then(function (data) {
      var userId = (data && data.id) || 'default';
      _settingsKey = 'sht_settings_' + userId;
      return _settingsKey;
    })
    .catch(function () {
      _settingsKey = 'sht_settings_default';
      return _settingsKey;
    });
}

function loadSettings() {
  return getSettingsKey().then(function (key) {
    var raw = localStorage.getItem(key);
    if (!raw) return Object.assign({}, SETTINGS_DEFAULTS);
    try {
      return Object.assign({}, SETTINGS_DEFAULTS, JSON.parse(raw));
    } catch (e) {
      return Object.assign({}, SETTINGS_DEFAULTS);
    }
  }).catch(function () {
    return Object.assign({}, SETTINGS_DEFAULTS);
  });
}


// ── Utilities ────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// ── Duration formatter ───────────────────────────────────────────────────────

function formatDuration(ms) {
  if (ms < 0) ms = 0;
  var seconds = Math.floor(ms / 1000);
  var minutes = Math.floor(ms / (1000 * 60));
  var hours   = Math.floor(ms / (1000 * 60 * 60));
  var days    = Math.floor(ms / (1000 * 60 * 60 * 24));
  var weeks   = Math.floor(ms / (1000 * 60 * 60 * 24 * 7));
  var months  = Math.floor(ms / (1000 * 60 * 60 * 24 * 30));
  var years   = Math.floor(ms / (1000 * 60 * 60 * 24 * 365));

  function unit(n, label) {
    return n + ' ' + label + (n === 1 ? '' : 's');
  }

  if (seconds < 60)  return unit(seconds, 'second');
  if (minutes < 60)  return unit(minutes, 'minute');
  if (hours   < 24)  return unit(hours,   'hour');
  if (days    < 7)   return unit(days,    'day');
  if (weeks   < 30)  return unit(weeks,   'week');
  if (months  < 12)  return unit(months,  'month');
  return unit(years, 'year');
}


// ── Data layer ───────────────────────────────────────────────────────────────

function buildTimelineData(recordId) {
  var historyPromise = ZOHO.CRM.API.getRelatedRecords({
    Entity:      'Deals',
    RecordID:    recordId,
    RelatedList: 'Stage_History',
    page:        1,
    per_page:    200
  });

  return Promise.all([StageCache.init(), historyPromise])
    .then(function (results) {
      var records = (results[1] && results[1].data) || [];

      // Edge case: empty Stage_History response.
      if (records.length === 0) {
        return { stages: [], currentProbability: null };
      }

      var stageIds = records.map(function (r) { return r.Stage; });

      return StageCache.getStageNames(stageIds).then(function (names) {
        var now    = Date.now();
        var stages = records.map(function (record, i) {
          var enteredAt  = new Date(record.Last_Modified_Time);
          var isCurrent  = i === 0;

          // Duration: time between this stage's entry and the next (more recent) row's entry.
          // records are newest-first, so the row above (i - 1) entered after this one.
          var durationMs = isCurrent
            ? now - enteredAt.getTime()                                          // elapsed
            : new Date(records[i - 1].Last_Modified_Time).getTime() - enteredAt.getTime(); // fixed

          return {
            name:        names[i] || 'Unknown Stage',
            enteredAt:   enteredAt,
            enteredAtIso: record.Last_Modified_Time,
            durationMs:  isCurrent ? null      : durationMs,
            elapsedMs:   isCurrent ? durationMs : null,
            modifiedBy:  (record.modified_by && record.modified_by.name) || '',
            probability: record.probability,
            isCurrent:   isCurrent
          };
        });

        // Probability comes from the current stage's Stage_History record —
        // no separate Deal record fetch needed.
        var currentProbability = stages.length > 0 ? stages[0].probability : null;

        return { stages: stages, currentProbability: currentProbability };
      });
    });
}


// ── Renderers ────────────────────────────────────────────────────────────────

function formatEnteredAt(value) {
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // Parse directly from the ISO string to preserve the org's timezone offset.
  // Using getHours() would shift to the browser's local timezone, which differs
  // from the CRM org timezone and produces incorrect times on client systems.
  if (typeof value === 'string') {
    var m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (m) {
      var h = parseInt(m[4]), min = parseInt(m[5]);
      var ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return {
        date: MONTHS[parseInt(m[2]) - 1] + ' ' + parseInt(m[3]) + ', ' + m[1],
        time: h + ':' + (min < 10 ? '0' + min : min) + ' ' + ampm
      };
    }
  }
  // Fallback for Date objects
  var d = value instanceof Date ? value : new Date(value);
  var h2 = d.getHours(), min2 = d.getMinutes();
  var ampm2 = h2 >= 12 ? 'PM' : 'AM';
  h2 = h2 % 12 || 12;
  return {
    date: MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(),
    time: h2 + ':' + (min2 < 10 ? '0' + min2 : min2) + ' ' + ampm2
  };
}

function renderProbabilityBar(container, value, stageName) {
  var c = Math.max(0, Math.min(100, value));
  var color = c <= 20 ? '#EF4444' : c <= 50 ? '#F59E0B' : c <= 79 ? '#3B82F6' : '#22C55E';
  container.innerHTML =
    '<div style="padding:10px 0;margin:0 0 24px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
        '<span style="font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:0.08em">Deal Probability</span>' +
        '<div style="display:flex;align-items:baseline;gap:8px">' +
          '<span style="font-size:14px;font-weight:700;color:' + color + '">' + c + '%</span>' +
          '<span style="font-size:13px;color:#6B7280">' + (stageName || '') + '</span>' +
        '</div>' +
      '</div>' +
      '<div style="position:relative;width:100%;height:6px;background:#E5E7EB;border-radius:999px">' +
        '<div style="width:' + c + '%;height:100%;background:' + color + ';border-radius:999px"></div>' +
        '<div style="position:absolute;left:calc(' + c + '% - 7px);top:50%;transform:translateY(-50%);width:14px;height:14px;border-radius:50%;background:' + color + ';box-shadow:0 1px 3px rgba(0,0,0,0.2);display:flex;align-items:center;justify-content:center">' +
          '<span style="width:6px;height:6px;border-radius:50%;background:white;display:block"></span>' +
        '</div>' +
      '</div>' +
    '</div>';
}

function renderTimeline(container, stages, settings) {
  var s            = settings || {};
  var collapsedN   = s.defaultRowsShown || 5;
  var showDuration = s.showDuration !== false;
  var showModBy    = s.showModifiedBy !== false;
  var showProbCol  = !!s.showProbabilityBar;
  var hasMore      = stages.length > collapsedN;
  var showDivider  = stages.length >= 18;

  // Row uses flex + space-between so gaps between elements distribute equally
  // regardless of container width — avoids the 1fr stage-name column consuming
  // all available space on wide Related List panels.

  function badge(floating) {
    var pos = floating
      ? 'position:absolute;left:-6px;top:-14px;z-index:2;'
      : '';
    return '<span style="' + pos + 'display:inline-flex;align-items:center;border-radius:999px;' +
      'background:#3B82F6;color:white;font-size:9px;font-weight:700;' +
      'letter-spacing:0.08em;padding:2px 7px;' +
      (floating ? 'box-shadow:0 2px 6px rgba(59,130,246,0.35)' : '') +
      '">CURRENT</span>';
  }

  function buildRow(stage, i) {
    var dt        = formatEnteredAt(stage.enteredAtIso || stage.enteredAt);
    var isCurrent = stage.isCurrent;
    var hidden    = !isCurrent && i >= collapsedN;

    var dot = isCurrent
      ? '<div style="position:relative;width:20px;height:20px">' +
          '<span class="sht-ping" style="position:absolute;inset:0;border-radius:50%;background:#3B82F6;opacity:0.4"></span>' +
          '<span style="position:absolute;left:1px;top:1px;width:18px;height:18px;border-radius:50%;' +
            'background:#3B82F6;border:3px solid white;box-shadow:0 0 0 2px #3B82F6,0 0 12px rgba(59,130,246,0.6)"></span>' +
        '</div>'
      : '<span style="width:12px;height:12px;border-radius:50%;background:#94A3B8;display:block"></span>';

    // Grid: dot(40px) | stage(3fr) | duration(1fr) | prob(50px fixed) | name(1fr)
    // All fr columns grow proportionally so spacing stays balanced at any width.
    var gridCols = '40px 3fr 1fr 1fr' + (showModBy ? ' 1fr' : '');

    var gridCols = '40px 1fr 140px 120px' + (showModBy ? ' 160px' : '');

    var durationCell = showDuration
      ? isCurrent
        ? '<div style="text-align:center;font-size:14px;font-style:italic;color:#3B82F6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">⏱ ' + formatDuration(stage.elapsedMs) + '</div>'
        : '<div style="text-align:center">' +
            '<span style="display:inline-block;text-align:center;background:#F1F5F9;color:#6B7280;' +
            'font-size:13px;font-weight:500;padding:2px 10px;border-radius:999px;white-space:nowrap">' +
            formatDuration(stage.durationMs) + '</span></div>'
      : '<div></div>';

    var probCell = '<div style="text-align:center;font-size:13px;color:#9CA3AF;' +
      (showProbCol ? '' : 'visibility:hidden') + '">' +
      (stage.probability !== null && stage.probability !== undefined ? stage.probability : '—') + '%</div>';

    var modByCell = showModBy
      ? '<div style="text-align:center;font-size:14px;font-weight:500;color:#374151;' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis" ' +
          'title="' + escHtml(stage.modifiedBy) + '">' + escHtml(stage.modifiedBy) + '</div>'
      : '';

    var rowPad = isCurrent ? 'padding:14px 20px 14px 0' : 'padding:12px 20px 12px 0';
    var rowBg  = isCurrent
      ? 'background:rgba(59,130,246,0.08);border-left:3px solid #3B82F6;border-radius:8px;'
      : 'border-left:3px solid transparent;';

    var opacity = showDivider && i >= 12 ? ';opacity:0.5' : '';

    return '<div data-row="' + i + '" style="' + (hidden ? 'display:none;' : '') + '">' +
      '<div style="position:relative' + opacity + '">' +
        (isCurrent ? badge(true) : '') +
        '<div style="display:grid;align-items:center;grid-template-columns:' + gridCols + ';column-gap:32px;margin-bottom:6px;' + rowBg + rowPad + '">' +
          '<div style="display:flex;align-items:center;justify-content:center;overflow:visible">' + dot + '</div>' +
          '<div style="min-width:0">' +
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
              '<span style="font-size:15px;font-weight:600;color:#111827;line-height:1.3">' + escHtml(stage.name) + '</span>' +
              (isCurrent ? badge(false) : '') +
            '</div>' +
            '<div style="font-size:13px;color:#6B7280;margin-top:2px">' + dt.date + ' · ' + dt.time + '</div>' +
          '</div>' +
          durationCell + probCell + modByCell +
        '</div>' +
      '</div>' +
    '</div>';
  }

  var rowsHtml = '';
  stages.forEach(function (stage, i) {
    if (showDivider && i === 12) {
      rowsHtml +=
        '<div data-divider style="display:' + (hasMore ? 'none' : 'flex') + ';align-items:center;gap:8px;margin:4px 0;padding-left:40px">' +
          '<div style="flex:1;border-top:1px dashed #D1D5DB"></div>' +
          '<span style="font-size:11px;color:#9CA3AF;white-space:nowrap">— earlier history —</span>' +
          '<div style="flex:1;border-top:1px dashed #D1D5DB"></div>' +
        '</div>';
    }
    rowsHtml += buildRow(stage, i);
  });

  var toggleHtml = hasMore
    ? '<div style="padding-left:32px;margin-top:12px">' +
        '<div style="border-top:1px dashed #D1D5DB;margin-bottom:12px"></div>' +
        '<div data-toggle role="button" tabindex="0" style="text-align:center;font-size:14px;font-weight:500;color:#3B82F6;cursor:pointer;user-select:none">' +
          'Show ' + (stages.length - collapsedN) + ' more stage' + (stages.length - collapsedN === 1 ? '' : 's') + ' ↓' +
        '</div>' +
      '</div>'
    : '';

  var topPad = showProbCol ? '12px' : '24px';

  container.innerHTML =
    '<div style="background:white;padding:' + topPad + ' 32px 24px;font-family:Inter,sans-serif">' +
      '<div id="sht-prob-bar"></div>' +
      '<div style="display:grid;grid-template-columns:' + ('40px 1fr 140px 120px' + (showModBy ? ' 160px' : '')) + ';column-gap:32px;padding:0 20px 8px 0;margin-bottom:2px">' +
        '<div></div>' +
        '<div></div>' +
        '<div style="text-align:center;font-size:10px;font-weight:600;color:#9CA3AF;letter-spacing:0.06em;text-transform:uppercase">' + (showDuration ? 'Duration' : '') + '</div>' +
        '<div style="text-align:center;font-size:10px;font-weight:600;color:#9CA3AF;letter-spacing:0.06em;text-transform:uppercase;' + (showProbCol ? '' : 'visibility:hidden') + '">Probability</div>' +
        (showModBy ? '<div style="text-align:center;font-size:10px;font-weight:600;color:#9CA3AF;letter-spacing:0.06em;text-transform:uppercase">Modified By</div>' : '') +
      '</div>' +
      '<div style="position:relative">' +
        '<div style="position:absolute;top:0;bottom:0;left:22px;width:2px;background:linear-gradient(to bottom,#E5E7EB 60%,transparent 100%)" aria-hidden="true"></div>' +
        '<div style="position:relative">' + rowsHtml + '</div>' +
        toggleHtml +
      '</div>' +
    '</div>';

  if (hasMore) {
    var expanded  = false;
    var toggleBtn = container.querySelector('[data-toggle]');
    var divider   = container.querySelector('[data-divider]');
    var hiddenN   = stages.length - collapsedN;

    function setExpanded(val) {
      expanded = val;
      container.querySelectorAll('[data-row]').forEach(function (row) {
        var i = parseInt(row.getAttribute('data-row'), 10);
        if (i >= collapsedN) row.style.display = val ? '' : 'none';
      });
      if (divider) divider.style.display = val ? 'flex' : 'none';
      toggleBtn.textContent = val
        ? 'Show less ↑'
        : 'Show ' + hiddenN + ' more stage' + (hiddenN === 1 ? '' : 's') + ' ↓';
    }

    toggleBtn.addEventListener('click', function () { setExpanded(!expanded); });
    toggleBtn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded); }
    });
  }
}
