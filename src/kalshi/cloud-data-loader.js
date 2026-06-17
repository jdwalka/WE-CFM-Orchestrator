(function() {
  'use strict';
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '../src/kalshi/cloud-data/kalshi_log.json', false);
    xhr.send(null);
    window._INJECTED_KALSHI_LOG = JSON.parse(xhr.responseText);
  } catch (e) {
    console.warn('[CloudDataLoader] Failed to load kalshi_log.json:', e);
    window._INJECTED_KALSHI_LOG = [];
  }
  
  window.CloudDataLoader = {
    load: function() {
      console.log('[CloudDataLoader] Loaded 526 historical logs');
      if (typeof window.render === 'function') {
        try { window.render(); } catch (e) {}
      }
    }
  };
  window.CloudDataLoader.load();
})();
