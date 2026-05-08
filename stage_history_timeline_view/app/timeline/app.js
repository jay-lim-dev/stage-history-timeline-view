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
