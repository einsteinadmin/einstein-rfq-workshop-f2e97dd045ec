/* =====================================================================
 * Einstein "Suggest a change" widget
 * Drop-in script for internal HTML tools.
 *
 * Usage (one line in any tool):
 *   <script src="../suggest-widget/widget.js" data-tool-id="bandwidth-model"></script>
 *
 * Configure (optional — overrides script data-attributes):
 *   <script>
 *     window.EINSTEIN_SUGGEST_CONFIG = {
 *       webhookUrl: 'https://hooks.slack.com/services/...',   // Phase 0: direct to Slack
 *       workerUrl:  'https://suggest-api.einsteinmoving.com', // Phase 1: AI-mediated
 *       toolId:     'bandwidth-model',
 *       toolName:   'Bandwidth Model'                          // human-friendly label
 *     };
 *   </script>
 *
 * Phase 0 (today): posts JSON directly to a Slack incoming webhook.
 * Phase 1 (later): posts to Cloudflare Worker which calls Anthropic to
 *   structure the suggestion, then posts to Slack. Same widget — only
 *   the endpoint changes.
 *
 * Submissions that fail (no config, network error, CORS) are saved to
 * localStorage under key "einstein-suggest-widget-queue" so nothing is
 * ever lost. Cameron + Albert can sync them on the next session.
 * ===================================================================== */

(function () {
  'use strict';

  if (window.__einsteinSuggestWidgetLoaded) return;
  window.__einsteinSuggestWidgetLoaded = true;

  // -------------------------------------------------------------------
  // CONFIG resolution
  // -------------------------------------------------------------------
  var scriptEl = document.currentScript || (function () {
    var s = document.getElementsByTagName('script');
    return s[s.length - 1];
  })();

  var userConfig = window.EINSTEIN_SUGGEST_CONFIG || {};
  var dataAttrs = scriptEl && scriptEl.dataset ? scriptEl.dataset : {};

  var CONFIG = {
    webhookUrl: userConfig.webhookUrl || dataAttrs.webhookUrl || '',
    workerUrl: userConfig.workerUrl || dataAttrs.workerUrl || '',
    toolId: userConfig.toolId || dataAttrs.toolId || 'unknown-tool',
    toolName: userConfig.toolName || dataAttrs.toolName || (document.title || 'Einstein tool'),
    channel: userConfig.channel || dataAttrs.channel || '#tool-feedback'
  };

  var QUEUE_KEY = 'einstein-suggest-widget-queue';
  var NAME_KEY = 'einstein-suggest-widget-name';

  // -------------------------------------------------------------------
  // STYLES (scoped under .esw- prefix to avoid collisions)
  // -------------------------------------------------------------------
  var CSS = [
    '.esw-fab {',
    '  position: fixed; right: 24px; bottom: 24px;',
    '  width: 56px; height: 56px; border-radius: 50%;',
    '  background: #EF8B22; color: #fff; border: 0;',
    '  display: flex; align-items: center; justify-content: center;',
    '  font-size: 26px; line-height: 1;',
    '  cursor: pointer; z-index: 9999;',
    '  box-shadow: 0 4px 12px rgba(239,139,34,0.35);',
    '  transition: transform 0.15s ease, box-shadow 0.15s ease;',
    '  font-family: inherit;',
    '}',
    '.esw-fab:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(239,139,34,0.45); }',
    '.esw-fab:focus-visible { outline: 3px solid #0979C3; outline-offset: 2px; }',

    '.esw-overlay {',
    '  position: fixed; inset: 0; background: rgba(26,26,26,0.45);',
    '  display: none; align-items: center; justify-content: center;',
    '  z-index: 10000; padding: 16px;',
    '  font-family: "Roboto", system-ui, sans-serif;',
    '  -webkit-font-smoothing: antialiased;',
    '}',
    '.esw-overlay.esw-open { display: flex; }',

    '.esw-modal {',
    '  background: #fff; border-radius: 12px;',
    '  width: 100%; max-width: 480px; padding: 24px;',
    '  box-shadow: 0 12px 40px rgba(0,0,0,0.18);',
    '  max-height: 90vh; overflow-y: auto;',
    '  color: #1A1A1A;',
    '}',
    '.esw-head {',
    '  display: flex; align-items: flex-start; justify-content: space-between;',
    '  gap: 12px; margin-bottom: 4px;',
    '}',
    '.esw-title { margin: 0; font-size: 18px; font-weight: 500; letter-spacing: -0.01em; }',
    '.esw-sub { color: #6B7280; font-size: 13px; margin: 4px 0 18px; }',
    '.esw-close {',
    '  background: transparent; border: 0; cursor: pointer;',
    '  font-size: 22px; line-height: 1; color: #6B7280; padding: 4px;',
    '  border-radius: 4px;',
    '}',
    '.esw-close:hover { color: #1A1A1A; background: #F2F4F6; }',

    '.esw-field { margin-bottom: 14px; }',
    '.esw-label {',
    '  display: block; font-size: 12px; font-weight: 500;',
    '  color: #4A4A4A; margin-bottom: 6px;',
    '  letter-spacing: 0.02em;',
    '}',
    '.esw-input, .esw-textarea, .esw-select {',
    '  width: 100%; box-sizing: border-box;',
    '  border: 1px solid #D6D6D6; border-radius: 6px;',
    '  padding: 9px 12px; font-size: 14px; font-family: inherit;',
    '  color: #1A1A1A; background: #fff;',
    '  transition: border-color 0.15s, box-shadow 0.15s;',
    '}',
    '.esw-input:focus, .esw-textarea:focus, .esw-select:focus {',
    '  outline: 0; border-color: #0979C3;',
    '  box-shadow: 0 0 0 3px rgba(9,121,195,0.15);',
    '}',
    '.esw-textarea { resize: vertical; min-height: 96px; font-family: inherit; }',
    '.esw-count { font-size: 11px; color: #9CA3AF; margin-top: 4px; text-align: right; }',
    '.esw-req { color: #C62828; margin-left: 2px; }',

    '.esw-actions {',
    '  display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px;',
    '}',
    '.esw-btn {',
    '  border: 1px solid #D6D6D6; background: #fff;',
    '  border-radius: 6px; padding: 9px 16px;',
    '  font-size: 13px; font-family: inherit; color: #4A4A4A;',
    '  cursor: pointer; transition: all 0.15s;',
    '}',
    '.esw-btn:hover { background: #F2F4F6; }',
    '.esw-btn-primary {',
    '  background: #0979C3; color: #fff; border-color: #0979C3;',
    '}',
    '.esw-btn-primary:hover { background: #086aa8; border-color: #086aa8; }',
    '.esw-btn-primary:disabled {',
    '  background: #9CA3AF; border-color: #9CA3AF; cursor: not-allowed;',
    '}',

    '.esw-spinner {',
    '  display: inline-block; width: 14px; height: 14px;',
    '  border: 2px solid rgba(255,255,255,0.4); border-top-color: #fff;',
    '  border-radius: 50%; animation: esw-spin 0.7s linear infinite;',
    '  vertical-align: middle; margin-right: 8px;',
    '}',
    '@keyframes esw-spin { to { transform: rotate(360deg); } }',

    '.esw-status {',
    '  text-align: center; padding: 24px 8px 8px;',
    '}',
    '.esw-status-icon {',
    '  width: 48px; height: 48px; border-radius: 50%;',
    '  display: flex; align-items: center; justify-content: center;',
    '  margin: 0 auto 14px; font-size: 26px;',
    '}',
    '.esw-status-icon.esw-ok { background: #E8F5E9; color: #2E7D32; }',
    '.esw-status-icon.esw-warn { background: #FEF3C7; color: #92400E; }',
    '.esw-status-icon.esw-err { background: #FDECEA; color: #C62828; }',
    '.esw-status-title { font-size: 16px; font-weight: 500; margin: 0 0 6px; }',
    '.esw-status-msg { color: #6B7280; font-size: 13px; margin: 0; line-height: 1.55; }',

    '.esw-queue-note {',
    '  margin-top: 14px; padding: 10px 12px;',
    '  background: #FFF3E5; border-left: 3px solid #EF8B22;',
    '  border-radius: 4px; font-size: 12px; color: #4A4A4A;',
    '}',

    '@media (max-width: 520px) {',
    '  .esw-fab { right: 16px; bottom: 16px; }',
    '  .esw-modal { padding: 20px; border-radius: 10px; }',
    '}'
  ].join('\n');

  // -------------------------------------------------------------------
  // DOM helpers
  // -------------------------------------------------------------------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') {
          node.addEventListener(k.slice(2), attrs[k]);
        } else if (attrs[k] === true) {
          node.setAttribute(k, '');
        } else if (attrs[k] !== false && attrs[k] != null) {
          node.setAttribute(k, attrs[k]);
        }
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function injectStyles() {
    if (document.getElementById('esw-styles')) return;
    var s = document.createElement('style');
    s.id = 'esw-styles';
    s.appendChild(document.createTextNode(CSS));
    document.head.appendChild(s);

    // Load Roboto only if the host page doesn't already have it.
    var hasRoboto = Array.prototype.some.call(
      document.querySelectorAll('link[href*="fonts.googleapis.com"]'),
      function (l) { return l.href.indexOf('Roboto') !== -1; }
    );
    if (!hasRoboto) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500&display=swap';
      document.head.appendChild(link);
    }
  }

  // -------------------------------------------------------------------
  // Section detection — pull h1/h2 (and h3 if sparse) from the page
  // -------------------------------------------------------------------
  function detectSections() {
    var headings = document.querySelectorAll('h1, h2');
    var seen = {};
    var sections = [];
    Array.prototype.forEach.call(headings, function (h) {
      var text = (h.textContent || '').trim().replace(/\s+/g, ' ');
      if (!text || text.length > 80) return;
      if (seen[text]) return;
      seen[text] = true;
      sections.push(text);
    });
    // If we got <3 sections, also pull h3.
    if (sections.length < 3) {
      Array.prototype.forEach.call(document.querySelectorAll('h3'), function (h) {
        var text = (h.textContent || '').trim().replace(/\s+/g, ' ');
        if (!text || text.length > 80 || seen[text]) return;
        seen[text] = true;
        sections.push(text);
      });
    }
    return sections.slice(0, 20);
  }

  // -------------------------------------------------------------------
  // Queue helpers (graceful offline / no-config fallback)
  // -------------------------------------------------------------------
  function queueGet() {
    try {
      var raw = localStorage.getItem(QUEUE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function queuePush(payload) {
    try {
      var q = queueGet();
      q.push(payload);
      localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
      return true;
    } catch (e) { return false; }
  }

  // -------------------------------------------------------------------
  // Submission — Phase 1 (Worker) if configured, else Phase 0 (Slack direct)
  // -------------------------------------------------------------------
  function buildSlackPayload(payload) {
    // Rich Slack blocks — readable in the channel and easy to scan.
    var fields = [
      { type: 'mrkdwn', text: '*Tool:*\n' + payload.toolName + ' (`' + payload.toolId + '`)' },
      { type: 'mrkdwn', text: '*From:*\n' + payload.submitter },
      { type: 'mrkdwn', text: '*Section:*\n' + (payload.section || '_unspecified_') },
      { type: 'mrkdwn', text: '*Severity:*\n' + (payload.severity || '_unspecified_') }
    ];
    var blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Tool suggestion: ' + payload.toolName, emoji: true }
      },
      { type: 'section', fields: fields },
      { type: 'section', text: { type: 'mrkdwn', text: '*Suggestion:*\n' + payload.change } }
    ];
    if (payload.pageUrl) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '<' + payload.pageUrl + '|' + payload.pageUrl + '>' }]
      });
    }
    return {
      text: 'New tool suggestion from ' + payload.submitter + ' on ' + payload.toolName,
      blocks: blocks
    };
  }

  function submit(payload, done) {
    // Prefer Worker if configured (Phase 1: AI structuring + central CORS handling).
    if (CONFIG.workerUrl) {
      fetch(CONFIG.workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        if (!res.ok) throw new Error('Worker returned ' + res.status);
        return res.json().catch(function () { return {}; });
      }).then(function (body) {
        done(null, body);
      }).catch(function (err) {
        // Fall through to queue
        queuePush(payload);
        done(err);
      });
      return;
    }

    // Phase 0: post directly to Slack webhook. Slack's incoming webhook
    // endpoint is CORS-permissive when Content-Type is text/plain (their
    // documented quirk). We use that to avoid the preflight.
    if (CONFIG.webhookUrl && CONFIG.webhookUrl !== '__PLACEHOLDER__') {
      fetch(CONFIG.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: JSON.stringify(buildSlackPayload(payload))
      }).then(function (res) {
        if (!res.ok) throw new Error('Slack returned ' + res.status);
        done(null, { ok: true });
      }).catch(function (err) {
        queuePush(payload);
        done(err);
      });
      return;
    }

    // No endpoint configured — queue and tell the user.
    var ok = queuePush(payload);
    done(ok ? { queued: true } : new Error('Could not save locally'));
  }

  // -------------------------------------------------------------------
  // UI assembly
  // -------------------------------------------------------------------
  var state = {
    overlay: null,
    modal: null,
    lastFocused: null,
    keydownHandler: null
  };

  function openModal() {
    state.lastFocused = document.activeElement;
    if (!state.overlay) buildModal();
    state.overlay.classList.add('esw-open');
    // Focus first field after a tick so screen readers register the open state.
    setTimeout(function () {
      var first = state.modal.querySelector('select, input, textarea');
      if (first) first.focus();
    }, 30);
    state.keydownHandler = function (e) {
      if (e.key === 'Escape') closeModal();
      if (e.key === 'Tab') trapFocus(e);
    };
    document.addEventListener('keydown', state.keydownHandler);
  }

  function closeModal() {
    if (!state.overlay) return;
    state.overlay.classList.remove('esw-open');
    document.removeEventListener('keydown', state.keydownHandler);
    resetModalBody();
    if (state.lastFocused && state.lastFocused.focus) state.lastFocused.focus();
  }

  function trapFocus(e) {
    var focusables = state.modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      last.focus(); e.preventDefault();
    } else if (!e.shiftKey && document.activeElement === last) {
      first.focus(); e.preventDefault();
    }
  }

  function buildModal() {
    var overlay = el('div', { class: 'esw-overlay', role: 'presentation',
      onclick: function (e) { if (e.target === overlay) closeModal(); } });
    var modal = el('div', {
      class: 'esw-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'esw-title'
    });
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.modal = modal;
    renderForm();
  }

  function resetModalBody() {
    if (state.modal) renderForm();
  }

  function renderForm() {
    state.modal.innerHTML = '';

    var sections = detectSections();
    var savedName = '';
    try { savedName = localStorage.getItem(NAME_KEY) || ''; } catch (e) {}

    var head = el('div', { class: 'esw-head' }, [
      el('h2', { id: 'esw-title', class: 'esw-title', text: 'Suggest a change' }),
      el('button', {
        class: 'esw-close',
        type: 'button',
        'aria-label': 'Close',
        onclick: closeModal,
        html: '&times;'
      })
    ]);
    var sub = el('p', {
      class: 'esw-sub',
      text: 'Goes to ' + CONFIG.channel + ' — Cameron + Albert review every one.'
    });

    // Section dropdown
    var sectionSelect = el('select', { class: 'esw-select', id: 'esw-section', name: 'section' }, [
      el('option', { value: '', text: 'Pick a section (or leave blank)' })
    ]);
    sections.forEach(function (s) {
      sectionSelect.appendChild(el('option', { value: s, text: s }));
    });
    sectionSelect.appendChild(el('option', { value: 'Other', text: 'Other / general' }));

    // Textarea
    var textarea = el('textarea', {
      class: 'esw-textarea',
      id: 'esw-change',
      name: 'change',
      rows: 4,
      required: true,
      'aria-required': 'true',
      placeholder: 'What would you change, add, or fix?'
    });
    var count = el('div', { class: 'esw-count', id: 'esw-count', text: '0 characters' });
    textarea.addEventListener('input', function () {
      count.textContent = textarea.value.length + ' characters';
    });

    // Name
    var nameInput = el('input', {
      class: 'esw-input',
      id: 'esw-name',
      name: 'submitter',
      type: 'text',
      required: true,
      'aria-required': 'true',
      placeholder: 'First name + last initial works',
      value: savedName
    });

    // Severity
    var sevSelect = el('select', { class: 'esw-select', id: 'esw-severity', name: 'severity' }, [
      el('option', { value: '', text: 'Pick one (optional)' }),
      el('option', { value: 'Cosmetic', text: 'Cosmetic — looks off' }),
      el('option', { value: 'Functional', text: 'Functional — something broken or unclear' }),
      el('option', { value: 'Strategic', text: 'Strategic — bigger idea worth discussing' })
    ]);

    var submitBtn = el('button', {
      class: 'esw-btn esw-btn-primary',
      type: 'submit',
      text: 'Send suggestion'
    });
    var cancelBtn = el('button', {
      class: 'esw-btn',
      type: 'button',
      text: 'Cancel',
      onclick: closeModal
    });

    var form = el('form', {
      class: 'esw-form',
      novalidate: true,
      onsubmit: function (e) {
        e.preventDefault();
        if (!textarea.value.trim()) { textarea.focus(); return; }
        if (!nameInput.value.trim()) { nameInput.focus(); return; }

        try { localStorage.setItem(NAME_KEY, nameInput.value.trim()); } catch (err) {}

        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="esw-spinner"></span>Sending';

        var payload = {
          toolId: CONFIG.toolId,
          toolName: CONFIG.toolName,
          section: sectionSelect.value,
          change: textarea.value.trim(),
          submitter: nameInput.value.trim(),
          severity: sevSelect.value,
          pageUrl: window.location.href,
          userAgent: navigator.userAgent,
          submittedAt: new Date().toISOString()
        };

        submit(payload, function (err, result) {
          if (err) {
            showStatus('warn', 'Saved locally',
              'Could not reach the live channel right now. Your suggestion is saved on this device and we will sync it on the next session.');
          } else if (result && result.queued) {
            showStatus('warn', 'Saved locally',
              'No live channel is wired up yet, so we saved your suggestion on this device. Cameron will sync it when the channel is connected.');
          } else {
            showStatus('ok', 'Got it',
              'Cameron + Albert will see this in ' + CONFIG.channel + '.');
            setTimeout(closeModal, 2800);
          }
        });
      }
    }, [
      el('div', { class: 'esw-field' }, [
        el('label', { class: 'esw-label', for: 'esw-section', text: 'What part of this tool?' }),
        sectionSelect
      ]),
      el('div', { class: 'esw-field' }, [
        el('label', { class: 'esw-label', for: 'esw-change', html: 'What would you change?<span class="esw-req" aria-hidden="true">*</span>' }),
        textarea,
        count
      ]),
      el('div', { class: 'esw-field' }, [
        el('label', { class: 'esw-label', for: 'esw-name', html: 'Your name<span class="esw-req" aria-hidden="true">*</span>' }),
        nameInput
      ]),
      el('div', { class: 'esw-field' }, [
        el('label', { class: 'esw-label', for: 'esw-severity', text: 'Severity (optional)' }),
        sevSelect
      ]),
      el('div', { class: 'esw-actions' }, [cancelBtn, submitBtn])
    ]);

    state.modal.appendChild(head);
    state.modal.appendChild(sub);
    state.modal.appendChild(form);
  }

  function showStatus(kind, title, msg) {
    state.modal.innerHTML = '';
    var iconChar = kind === 'ok' ? '✓' : (kind === 'warn' ? '!' : '✕');
    var iconClass = 'esw-status-icon ' + (kind === 'ok' ? 'esw-ok' : kind === 'warn' ? 'esw-warn' : 'esw-err');
    state.modal.appendChild(el('div', { class: 'esw-status' }, [
      el('div', { class: iconClass, text: iconChar }),
      el('h3', { class: 'esw-status-title', text: title }),
      el('p', { class: 'esw-status-msg', text: msg }),
      kind === 'warn'
        ? el('div', { class: 'esw-queue-note',
            text: 'Stored in this browser under "einstein-suggest-widget-queue". Safe to close the tab.' })
        : null,
      el('div', { class: 'esw-actions', style: 'justify-content: center;' }, [
        el('button', { class: 'esw-btn', type: 'button', text: 'Close', onclick: closeModal })
      ])
    ]));
  }

  // -------------------------------------------------------------------
  // FAB (floating action button)
  // -------------------------------------------------------------------
  function buildFab() {
    if (document.getElementById('esw-fab')) return;
    var btn = el('button', {
      id: 'esw-fab',
      class: 'esw-fab',
      type: 'button',
      'aria-label': 'Suggest a change to this tool',
      title: 'Suggest a change',
      onclick: openModal,
      html: '&#128172;' // speech balloon
    });
    document.body.appendChild(btn);
  }

  // -------------------------------------------------------------------
  // Public API — for programmatic open + queue inspection
  // -------------------------------------------------------------------
  window.EinsteinSuggestWidget = {
    open: openModal,
    close: closeModal,
    config: function () { return Object.assign({}, CONFIG); },
    queue: queueGet,
    clearQueue: function () { try { localStorage.removeItem(QUEUE_KEY); } catch (e) {} }
  };

  // -------------------------------------------------------------------
  // INIT
  // -------------------------------------------------------------------
  function init() {
    injectStyles();
    buildFab();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
