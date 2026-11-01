(function () {
  'use strict';
  const C = window.PilotCore;
  const $ = function (q, r) { return (r || document).querySelector(q); };
  const root = $('#workspace'), modeBar = $('#mode-bar'), storageStatus = $('#storage-status');
  const storageBase = 'rhogov-pilot-kit:v1:';
  let state, mode = 'demo', tab = 'overview', timerHandle = null, toastHandle = null;
  let volatileStorage = false, storageWarning = '', integrityWarning = '', externalConflict = false, lastSavedRaw = '';
  let protocolBuffer = null, protocolDirty = false, amending = false;
  let attemptScratch = null, effortScratch = null, reviewScratch = null, reportCache = '';
  const $all = function (q, r) { return Array.from((r || document).querySelectorAll(q)); };
  const esc = function (x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  }); };
  const key = function (s) { return storageBase + s.mode + ':' + s.id; };
  const activeKey = function (m) { return storageBase + 'active:' + m; };
  function toast(message, error) {
    const el = $('#toast'); el.textContent = message; el.classList.toggle('error', !!error);
    el.classList.add('show'); clearTimeout(toastHandle);
    toastHandle = setTimeout(function () { el.classList.remove('show'); }, 3200);
  }
  function setSaveStatus(label, problem) {
    storageStatus.textContent = label; storageStatus.classList.toggle('red', !!problem);
  }
  function writePilot(next) {
    C.validate(next);
    state = next;
    try {
      if (!volatileStorage) {
        const json = JSON.stringify(state);
        if (externalConflict) throw new Error('This pilot changed in another browser tab. Reload it before saving more changes.');
        const prior = localStorage.getItem(key(state));
        if (lastSavedRaw && prior && prior !== lastSavedRaw) {
          externalConflict = true;
          throw new Error('Another browser tab changed this pilot. Reload its latest record before continuing.');
        }
        localStorage.setItem(key(state), json);
        localStorage.setItem(activeKey(mode), state.id);
        lastSavedRaw = json;
        setSaveStatus('Saved on this device');
      } else {
        setSaveStatus('Temporary session', true);
      }
      storageWarning = '';
    } catch (err) {
      setSaveStatus('Save needs attention', true);
      if (!volatileStorage) storageWarning = err.message;
      else storageWarning = 'Browser storage is unavailable. Export a JSON backup before closing this tab.';
    }
    render();
  }
  function listLivePilots() {
    if (volatileStorage) return state && mode === 'live' ? [state] : [];
    const prefix = storageBase + 'live:';
    const results = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k.indexOf(prefix) !== 0 || k === activeKey('live')) continue;
        try {
          const s = C.parseImport(localStorage.getItem(k));
          if (s.mode === 'live') results.push(s);
        } catch (_) {}
      }
    } catch (_) {}
    if (state && mode === 'live' && !results.some(function (x) { return x.id === state.id; })) results.push(state);
    return results.sort(function (a, b) { return Date.parse(b.updatedAt) - Date.parse(a.updatedAt); });
  }
  function loadStored(id, m) {
    if (m === 'demo' && (!id || id === 'pilot-DEMO-synthetic')) {
      try {
        const raw = localStorage.getItem(storageBase + 'demo:pilot-DEMO-synthetic');
        if (raw) return { state: C.parseImport(raw), raw: raw };
      } catch (err) { integrityWarning = 'The stored Demo workspace could not be validated; its data was left untouched. ' + err.message; }
      const demo = C.demoPilot();
      return { state: demo, raw: '' };
    }
    if (!id) return null;
    try {
      const raw = localStorage.getItem(storageBase + m + ':' + id);
      if (!raw) return null;
      const s = C.parseImport(raw);
      if (s.mode !== m) throw new Error('Stored workspace mode does not match its key.');
      return { state: s, raw: raw };
    } catch (err) {
      integrityWarning = 'A saved pilot could not be validated; the stored file was left unchanged. ' + err.message;
      return null;
    }
  }
  function activate(m, createNew) {
    if (tab !== 'overview' && ((tab === 'protocol' && protocolDirty) || (tab === 'attempts' && attemptScratch) ||
      (tab === 'review' && reviewScratch) || (tab === 'attempts' && effortScratch))) {
      if (!confirm('Discard unsaved form edits before switching workspaces?')) return;
    }
    const oldMode = mode; mode = m;
    protocolBuffer = null; protocolDirty = false; amending = false;
    attemptScratch = null; effortScratch = null; reviewScratch = null; externalConflict = false;
    if (createNew && m === 'live') {
      if (oldMode === 'live' && state && (state.startedAt || state.attempts.length || state.effort.length) &&
        !confirm('Start a new blank pilot? Your existing pilot will remain saved and available through its JSON backup.')) {
        mode = oldMode; return;
      }
      state = C.newPilot('live'); lastSavedRaw = '';
      writePilot(state); return;
    }
    let activeId = 'pilot-DEMO-synthetic';
    try { activeId = localStorage.getItem(activeKey(m)) || activeId; } catch (_) {}
    const loaded = loadStored(activeId, m);
    if (loaded) { state = loaded.state; lastSavedRaw = loaded.raw; }
    else {
      state = m === 'demo' ? C.demoPilot() : C.newPilot('live');
      lastSavedRaw = '';
      if (integrityWarning) state.id = 'pilot-recovered-' + Date.now().toString(36);
      try { if (!volatileStorage) localStorage.setItem(activeKey(m), state.id); } catch (_) {}
      if (integrityWarning) { render(); return; }
      writePilot(state); return;
    }
    try { if (!volatileStorage) localStorage.setItem(activeKey(m), state.id); } catch (_) {}
    render();
  }
  function formValues(form) {
    const data = {};
    new FormData(form).forEach(function (v, k) { data[k] = v; });
    $all('[type=checkbox][name]', form).forEach(function (x) { data[x.name] = x.checked; });
    return data;
  }
  function toLocal(utc) {
    const d = new Date(utc); if (!Number.isFinite(d.getTime())) return '';
    const shifted = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return shifted.toISOString().slice(0, 16);
  }
  function fromLocal(local) {
    if (!local) return null;
    const d = new Date(local);
    if (!Number.isFinite(d.getTime())) throw new Error('Enter a valid date and time.');
    return d.toISOString();
  }
  function n(v) { return v.trim() === '' ? null : Number(v); }
  function renderMode() {
    const demo = mode === 'demo';
    const picker = demo ? '' : '<label class="sr-only" for="live-picker">Switch between saved live pilots</label><select id="live-picker" class="live-picker" aria-label="Saved live pilots">' +
      listLivePilots().map(function (s) { return '<option value="' + esc(s.id) + '"' + (state && s.id === state.id ? ' selected' : '') +
        '>' + esc(s.draft.title || 'Untitled pilot') + ' · ' + esc(s.startedAt ? 'started ' + new Date(s.startedAt).toLocaleDateString() : 'draft') + '</option>'; }).join('') +
      '</select>';
    modeBar.className = 'mode-bar' + (demo ? '' : ' live');
    modeBar.innerHTML = '<div><strong>' + (demo ? 'DEMO · SYNTHETIC' : 'LIVE PILOT · LOCAL DATA') +
      '</strong>' + (demo ? 'Every participant and result is fictional. No chain or network was contacted.' :
        'Participant records stay in this browser. No account, wallet or network connection.') + '</div>' +
      '<div class="mode-actions">' + (demo
        ? '<button class="button subtle" data-action="switch-live">Open live workspace</button><button class="button" data-action="new-live">Start blank pilot →</button>'
        : picker + '<button class="button subtle" data-action="switch-demo">View synthetic demo</button>') + '</div>';
  }
  function renderNavigation() {
    $all('[data-tab]').forEach(function (b) {
      const selected = b.dataset.tab === tab;
      b.classList.toggle('active', selected);
      if (selected) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }
  function render() {
    if (!state) return;
    renderMode(); renderNavigation();
    const warning = $('#persistent-warning');
    warning.classList.toggle('hidden', !(storageWarning || integrityWarning));
    warning.textContent = storageWarning || integrityWarning;
    if (!volatileStorage && !storageWarning && !externalConflict) setSaveStatus('Saved on this device');
    if (externalConflict) setSaveStatus('Changed in another tab', true);
    const pages = { overview: renderOverview, protocol: renderProtocol, attempts: renderAttempts,
      review: renderReview, report: renderReport };
    pages[tab]();
    clearInterval(timerHandle);
    if (tab === 'attempts' && state.activeTimer && !state.activeTimer.stoppedAt) {
      timerHandle = setInterval(function () {
        const t = $('#timer-display'); if (t) t.textContent = C.duration(C.timerSeconds(state));
      }, 1000);
    }
  }
  function go(next) {
    if (tab === 'protocol' && protocolDirty && !confirm('Discard unsaved experiment-card edits?')) return;
    if (tab === 'attempts' && (attemptScratch || effortScratch) && !confirm('Discard unsaved attempt or effort form edits?')) return;
    if (tab === 'review' && reviewScratch && !confirm('Discard unsaved review form edits?')) return;
    tab = next; protocolBuffer = null; protocolDirty = false; amending = false;
    attemptScratch = null; effortScratch = null; reviewScratch = null;
    render(); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function pageHeader(eyebrow, title, subtitle, action) {
    return '<header class="page-header"><div><span class="eyebrow">' + esc(eyebrow) + '</span><h1>' + esc(title) +
      '</h1><p>' + esc(subtitle) + '</p></div>' + (action || '') + '</header>';
  }
  function metric(label, value, note, cls) {
    return '<div class="metric"><div class="metric-label">' + label + '</div><div class="metric-value ' + (cls || '') +
      '">' + value + '</div><div class="metric-note">' + note + '</div></div>';
  }
  function statusClass(e) { return ['Review required'].includes(e.status) ? 'amber' : e.status === 'Closed' ? 'red' : 'violet'; }
  function blockersUi(e) {
    const rows = e.blockers.filter(function (b) { return b.count > 0; });
    if (!rows.length) return '<div class="empty">No repeated blockers have been recorded.</div>';
    return rows.map(function (b) {
      const over = b.step !== 'other' && b.count >= e.p.blockerThreshold;
      return '<div class="blocker"><div class="blocker-top"><strong>' + esc(b.label) + (over ? ' <span class="pill warn">review threshold</span>' : '') +
        '</strong><span>' + b.count + ' / ' + e.p.cohortSize + '</span></div><div class="track"><span class="' +
        (over ? 'warn' : '') + '" style="width:' + Math.min(100, b.count / e.p.cohortSize * 100) + '%"></span></div>' +
        '<div class="blocker-meta"><span>' + esc(b.participants.join(', ')) + '</span><span>' +
        (b.step === 'other' ? 'manual grouping' : e.p.blockerThreshold + ' participants triggers review') + '</span></div></div>';
    }).join('');
  }
  function cohortTiles(e) {
    return C.cohort(state).map(function (id) {
      const a = e.first.get(id);
      let cl = '', label = a ? a.outcome : 'pending';
      if (a && C.qualifies(a, e.p)) { cl = 'success'; label = 'unassisted'; }
      else if (a && a.assisted) { cl = 'assisted'; label = 'assisted'; }
      else if (a && a.blocker !== 'none') { cl = 'blocked'; label = esc(a.blocker); }
      else if (a && a.evidenceStatus === 'disputed') label = 'disputed';
      else if (a && a.outcome === 'recorded' && !C.qualifies(a, e.p)) label = 'not qualified';
      return '<div class="cohort-tile ' + cl + '"><b>' + id + '</b><small>' + label + '</small></div>';
    }).join('');
  }
  function renderOverview() {
    const e = C.evaluate(state), demo = mode === 'demo';
    const targetValue = e.successes + '<small>/' + e.p.cohortSize + '</small>';
    const deadlineNote = e.deadline ? (e.due ? 'Review date has arrived' : 'Review due ' + esc(new Date(e.deadline).toLocaleDateString())) : 'Begins only after team agreement';
    let body = '<section class="hero"><div><span class="eyebrow">A TWO-WEEK GOVERNANCE EXPERIMENT</span><h1>Make a decision<br><em>that can learn.</em></h1><p>Agree to a bounded action. Keep the concern visible. See what the evidence says before deciding what happens next.</p><div class="hero-actions"><button class="button" data-go="' +
      (state.startedAt ? 'attempts' : 'protocol') + '">' + (state.startedAt ? 'Record a participant attempt' : 'Complete the experiment card') +
      ' <span aria-hidden="true">→</span></button><button class="button subtle" data-go="report">Open the report</button></div></div>' +
      '<div class="decision-object"><span class="tag">THE PILOT OBJECT</span><h2>' + esc(C.activeProtocol(state).title) +
      '</h2><div class="object-line"><div><b>' + e.p.durationDays + 'd</b><span>review window</span></div><div><b>' + e.p.cohortSize +
      '</b><span>newcomers</span></div><div><b>' + e.p.effortCapHours + 'h</b><span>effort cap</span></div></div>' +
      '<div class="object-flow"><strong>AGREE</strong><span>→</span><strong>ACT</strong><span>→</span><strong>OBSERVE</strong><span>→</span><strong>REVIEW</strong></div></div></section>' +
      '<section class="metrics">' + metric('QUALIFYING · FIRST ATTEMPT', targetValue,
        e.successes + ' demonstrated · target ' + e.p.successTarget + ' · evidence-backed, no help, under ' + e.p.maxMinutes + ' min', 'violet') +
      metric('PRIMARY COHORT COVERED', (e.p.cohortSize - e.missing) + '<small>/' + e.p.cohortSize + '</small>',
        e.missing + ' without a first record · ' + e.unknown + ' unresolved', '') +
      metric('TEAM EFFORT', C.formatNumber(e.teamHours) + '<small>/' + C.formatNumber(e.p.effortCapHours) + ' h</small>',
        e.teamHours >= e.p.effortCapHours ? 'Cap reached · future work awaits review' : 'Recruitment, setup and review included', '') +
      metric('PILOT STATUS', esc(e.status), deadlineNote, statusClass(e)) + '</section>' +
      '<div class="section-heading"><div><h2>What the evidence says</h2><p>One record per person for the success target. Every retry remains in the ledger.</p></div><button class="button ghost compact" data-go="attempts">Full attempt log →</button></div>' +
      '<section class="grid-two"><div class="panel"><h3>Cohort · primary attempts</h3><p>Earliest invitation opening is the preregistered primary attempt. Empty tiles mean pending—not failed.</p><div class="cohort-grid">' +
      cohortTiles(e) + '</div><div class="cohort-legend"><span><i class="legend-dot"></i>Unassisted qualifying</span><span><i class="legend-dot blocked"></i>Blocking step reported</span><span><i class="legend-dot assisted"></i>Assisted</span></div></div>' +
      '<div class="panel"><div class="section-heading"><h3>Recurring friction</h3><span class="pill">distinct people</span></div>' + blockersUi(e) +
      '<div class="callout"><strong>Decision quality starts before the vote.</strong><p>Evidence can challenge the execution plan without erasing the group’s original decision.</p></div></div></section>' +
      '<section class="section-heading"><div><h2>The two-week loop</h2><p>Each step leaves a record the next person can inspect.</p></div></section>' +
      '<section class="roadmap"><article class="roadmap-card"><span class="step-number">01 · AGREE</span><h3>Freeze the experiment</h3><p>Action, roles, electorate, evidence and review conditions become V1.</p><button class="button ghost" data-go="protocol">Open card →</button></article>' +
      '<article class="roadmap-card"><span class="step-number">02 · ACT</span><h3>Invite one newcomer</h3><p>Use an actual low-impact decision and include setup time in the clock.</p><button class="button ghost" data-go="attempts">Log an attempt →</button></article>' +
      '<article class="roadmap-card"><span class="step-number">03 · OBSERVE</span><h3>Keep friction visible</h3><p>Record assistance, withdrawals, missing proof, retries and team effort.</p><button class="button ghost" data-go="attempts">View the ledger →</button></article>' +
      '<article class="roadmap-card"><span class="step-number">04 · REVIEW</span><h3>Authorize a next step</h3><p>People decide continue, amend, complete or stop. The monitor cannot act.</p><button class="button ghost" data-go="review">Record a review →</button></article></section>' +
      '<section class="architecture"><div><span class="tiny-label">THE PRODUCT PROMISE</span><h3>Make a decision together, try it within clear limits, and keep a say in what happens next.</h3><p>One shared experience can serve RhoGov’s first-time user and Quantum-OS’s research question: does explicit review help a group adapt while participants still feel agency?</p></div><div><span class="tiny-label">THE 1992 CONNECTION</span><h3>Incremental research. Interoperable decisions.</h3><p>EIES2 connected research to operational group work and designed for incremental, distributed collaboration. This pilot starts with a versioned portable record and one real activity—then measures whether the workflow merits deeper integration.</p><p><a href="https://digitalcommons.njit.edu/ccccreports/28/" target="_blank" rel="noopener noreferrer">Jim Whitescarver et al. · EIES 2 (1992) ↗</a></p></div></section>';
    if (e.triggers.length) {
      body = '<div class="signal-list" style="margin-bottom:22px">' + e.triggers.map(function (t) {
        return '<div class="signal"><span class="signal-icon" aria-hidden="true">◇</span><div><h3>' + esc(t.title) +
          '</h3><p>' + esc(t.detail) + '</p></div></div>';
      }).join('') + '<button class="button subtle compact" data-go="review">Review evidence →</button></div>' + body;
    } else if (!state.startedAt) {
      body = '<div class="notice"><strong>The 14-day clock has not started.</strong> It begins only when the team agrees and you freeze V1. The proposal date is not a pilot start date.</div>' + body;
    }
    root.innerHTML = body;
  }
  function value(p, field, useBuffer) {
    const v = useBuffer ? protocolBuffer : p;
    return v && v[field] != null ? String(v[field]) : '';
  }
  function input(field, label, p, opts) {
    const o = opts || {}, id = 'f-' + field, val = value(p, field, !!protocolBuffer);
    let control;
    if (o.options) {
      control = '<select id="' + id + '" name="' + field + '"' + (o.disabled ? ' disabled' : '') + '>' +
        o.options.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (String(x[0]) === val ? ' selected' : '') + '>' + esc(x[1]) + '</option>'; }).join('') + '</select>';
    } else if (o.checkbox) {
      control = '<input id="' + id + '" name="' + field + '" type="checkbox" value="true"' +
        (val === 'true' ? ' checked' : '') + (o.disabled ? ' disabled' : '') + '>';
    } else if (o.textarea) {
      control = '<textarea id="' + id + '" name="' + field + '" maxlength="20000" rows="' + (o.rows || 4) +
        '"' + (o.disabled ? ' disabled' : '') + '>' + esc(val) + '</textarea>';
    } else {
      control = '<input id="' + id + '" name="' + field + '" type="' + (o.type || 'text') +
        '" value="' + esc(val) + '" maxlength="' + (o.maxlength || 2000) + '"' +
        (o.min != null ? ' min="' + o.min + '"' : '') + (o.max != null ? ' max="' + o.max + '"' : '') +
        (o.step ? ' step="' + o.step + '"' : '') + (o.disabled ? ' disabled' : '') +
        (o.required ? ' required' : '') + (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '') + '>';
    }
    return '<div class="field ' + (o.full ? 'full' : '') + '"><label for="' + id + '">' + esc(label) +
      (o.hint ? ' <span>' + esc(o.hint) + '</span>' : '') + '</label>' + control +
      (o.help ? '<small>' + esc(o.help) + '</small>' : '') + '</div>';
  }
  function numberInput(field, label, p, range, hint, disabled) {
    return input(field, label, p, { type: 'number', min: range[0], max: range[1], step: range[2],
      hint: hint, disabled: disabled, required: true });
  }
  function sectionTitle(n, title, caption) {
    return '<div class="form-section-title"><span>' + n + '</span><div><h2>' + title +
      '</h2>' + (caption ? '<small class="subtle-text">' + caption + '</small>' : '') + '</div></div>';
  }
  function renderProtocol() {
    const frozen = !!state.startedAt, p = C.activeProtocol(state);
    const editingAmendment = frozen && amending;
    if (frozen && !protocolBuffer && editingAmendment) protocolBuffer = C.clone(p);
    const edit = !frozen || editingAmendment, pSource = protocolBuffer || p;
    const disabledRules = frozen;
    let body = pageHeader('01 · BEFORE THE CLOCK', 'Experiment card', frozen ?
      'V1 is frozen. Record changes as linked amendments; preserve the original measurement rules.' :
      'Agree the action and measurement rules first. The 14-day clock begins only when you freeze V1.',
      frozen ? '<span class="pill success">' + esc(state.activeVersionId) + ' · FROZEN</span>' : '');
    if (frozen) body += '<div class="notice"><strong>Measurement contract locked:</strong> ' + state.versions[0].protocol.successTarget +
      '/' + state.versions[0].protocol.cohortSize + ' people, within ' + state.versions[0].protocol.maxMinutes +
      ' minutes; review at ' + state.versions[0].protocol.blockerThreshold + ' people with one blocker, ' +
      state.versions[0].protocol.effortCapHours + ' hours, or ' + state.versions[0].protocol.durationDays + ' days. ' +
      'You may clarify the action and evidence plan, but changing these targets requires a separate pilot.' +
      (editingAmendment ? ' Add a reason and the external authorization reference below.' : '') + '</div>';
    body += '<form id="protocol-form" class="panel" novalidate>' +
      '<section class="form-section">' + sectionTitle('A', 'The decision', 'Make the authorized action easy to understand.') +
      '<div class="form-grid">' + input('title', 'Short name', pSource, { full: true, required: true, maxlength: 250 }) +
      input('purpose', 'What question are we answering?', pSource, { textarea: true, full: true }) +
      input('authorizedAction', 'Action the group authorizes', pSource, { textarea: true, full: true,
        help: 'Name what the group may do, who it affects and what the result changes.' }) +
      input('scope', 'Boundary and limits', pSource, { textarea: true, full: true }) +
      input('expectedResult', 'Expected result', pSource, { textarea: true, full: true }) +
      input('dissent', 'Concern or dissent to keep visible', pSource, { textarea: true, full: true,
        help: 'Keep value disagreements in words; metrics are not required for every concern.' }) +
      '</div></section>' +
      '<section class="form-section">' + sectionTitle('B', 'People and authorization', 'Use role names and decision links. Attempt logs use pseudonyms only.') +
      '<div class="form-grid">' + input('owner', 'Pilot owner', pSource, { required: true }) +
      input('evidenceLead', 'Evidence lead', pSource, { required: true }) +
      input('reviewer', 'Reviewer', pSource, { required: true, help: 'Independent of the proposer when possible.' }) +
      input('electorate', 'Who may participate / vote?', pSource, { textarea: true, required: true,
        help: 'Record electorate, voter-roll rule and the identity boundary.' }) +
      input('dataAudience', 'Who may access raw attempt logs, and for how long?', pSource, { textarea: true, required: true,
        help: 'Set log access and a retention or deletion date by agreement.' }) +
      input('approvalReference', 'Group approval reference', pSource, { full: true, required: true,
        help: 'Link or identify the actual agreement and its date. This card does not create approval.' }) +
      input('decisionUrl', 'Decision / proposal link', pSource, { type: 'url', full: true, placeholder: 'https://…' }) +
      input('inviteUrl', 'Participant invitation link', pSource, { type: 'url', full: true, required: true,
        placeholder: 'https://…', help: 'The timer starts when you launch this invitation; eligibility waits count.' }) +
      '</div></section>' +
      '<section class="form-section">' + sectionTitle('C', 'Network and evidence', 'Make the execution context reproducible.') +
      '<div class="form-grid">' + input('network', 'Network and environment', pSource, { required: true,
        help: 'Example: playground / test network. Never enter a wallet secret.' }) +
      input('contracts', 'Contract addresses', pSource, { textarea: true, required: true,
        help: 'Paste verified addresses, or explicitly say what will be checked before the first invitation.' }) +
      input('evidencePlan', 'What will be observed and how?', pSource, { textarea: true, full: true, rows: 5, required: true,
        help: 'Say how receipts are checked, who sees raw logs, and how unknown or disputed evidence is handled.' }) +
      '</div></section>' +
      '<section class="form-section">' + sectionTitle('D', 'Preregister the test', 'These rules are fixed at V1 so the target cannot move after results arrive.') +
      '<div class="form-grid three">' + numberInput('cohortSize', 'Consenting newcomers', pSource, [1, 50, 1], 'P01–P' + String(pSource.cohortSize).padStart(2, '0'), disabledRules) +
      numberInput('successTarget', 'Target · qualifying people', pSource, [1, pSource.cohortSize, 1], 'of the cohort', disabledRules) +
      numberInput('maxMinutes', 'Time limit · minutes', pSource, [0.5, 120, 0.5], 'invitation through ballot', disabledRules) +
      numberInput('blockerThreshold', 'Same blocker · people', pSource, [1, pSource.cohortSize, 1], 'distinct participants', disabledRules) +
      numberInput('effortCapHours', 'Team effort cap · hours', pSource, [0.25, 1000, 0.25], 'including recruitment and review', disabledRules) +
      numberInput('durationDays', 'Review window · days', pSource, [1, 365, 1], 'after agreed start', disabledRules) +
      '</div><div class="callout"><strong>One person, one primary attempt.</strong><p>The earliest invitation opening determines success. Later attempts are retained and never replace the first. Assistance or unverified ballot reports do not count as qualifying success.</p></div></section>' +
      '<section class="checks"><label class="check"><input type="checkbox" name="agreementConfirmed" value="true"' +
      (pSource.agreementConfirmed ? ' checked' : '') + (frozen ? ' disabled' : '') +
      '> The group has actually approved this low-impact action, its named owner, cohort, network, resource cap and review rules. I recorded the decision reference above.</label>' +
      '<label class="check"><input type="checkbox" name="visibilityConfirmed" value="true"' +
      (pSource.visibilityConfirmed ? ' checked' : '') + (frozen ? ' disabled' : '') +
      '> Participants will be told what a public RhoGov ballot reveals, what this attempt log records and who can read it. I will obtain consent before recording each attempt.</label></section>';
    if (editingAmendment) body += '<section class="form-section gap-top"><div class="form-grid">' +
      input('amendmentReason', 'Why is this amendment needed?', {}, { textarea: true, full: true, required: true }) +
      input('amendmentAuthorization', 'New group authorization reference', {}, { full: true, required: true,
        help: 'Link to the separate decision approving this amendment.' }) + '</div></section>';
    body += '<div class="form-actions"><p>' + (frozen ?
      'This creates a linked protocol version. Existing decisions and the original target stay visible.' :
      'Draft changes stay on this device. Start the two-week clock only after team agreement.') +
      '</p><div class="action-group">' + (frozen && !editingAmendment ?
        '<button type="button" class="button subtle" data-action="new-amendment">Create linked amendment</button>' :
        '<button type="submit" class="button" name="formAction" value="' + (editingAmendment ? 'amend' : frozen ? 'save' : 'save') + '">' +
        (editingAmendment ? 'Save amendment' : frozen ? 'Save draft' : 'Save card') + '</button>' +
        (!frozen ? '<button type="submit" class="button green" name="formAction" value="start">Freeze V1 & start the clock →</button>' :
          '<button type="button" class="button subtle" data-action="cancel-amendment">Cancel amendment</button>') +
        (!frozen ? '<button type="button" class="button ghost" data-action="load-template">Reset to proposal defaults</button>' : '')) +
        '</div></div></form>';
    if (frozen) {
      body += '<section class="panel gap-top"><h3>Immutable protocol history</h3><p>Every amendment retains the exact prior protocol and its approval reference.</p>';
      state.versions.slice().reverse().forEach(function (v) {
        body += '<details><summary>' + esc(v.id + (v.previous ? ' · amends ' + v.previous : ' · baseline')) + ' · ' + esc(new Date(v.lockedAt).toLocaleString()) +
          ' · ' + esc(v.reason) + '</summary><div class="callout"><p><strong>Authorization:</strong> ' +
          (v.authorization.indexOf('http') === 0 ? '<a href="' + esc(C.safeUrl(v.authorization)) + '" target="_blank" rel="noopener noreferrer">' + esc(v.authorization) + ' ↗</a>' : esc(v.authorization)) +
          '</p></div><table class="table-pair">' +
          C.TEXT_FIELDS.map(function (f) { return '<tr><td>' + esc(f) + '</td><td>' + esc(v.protocol[f] || '—') + '</td></tr>'; }).join('') +
          '<tr><td>Review rules</td><td>' + v.protocol.successTarget + '/' + v.protocol.cohortSize + ' · ' + v.protocol.maxMinutes + 'm · ' +
          v.protocol.blockerThreshold + ' blockers · ' + v.protocol.effortCapHours + 'h · ' + v.protocol.durationDays + 'd</td></tr></table></details>';
      });
      body += '</section>';
    }
    root.innerHTML = body;
    if (protocolBuffer && $('#protocol-form')) {
      const f = $('#protocol-form');
      Object.keys(protocolBuffer).forEach(function (k) {
        if (k === 'agreementConfirmed' || k === 'visibilityConfirmed') {
          const x = f.elements[k]; if (x) x.checked = !!protocolBuffer[k];
        } else if (f.elements[k] && !['amendmentReason', 'amendmentAuthorization'].includes(k)) f.elements[k].value = protocolBuffer[k];
      });
    }
  }
  function options(list, chosen, firstLabel) {
    return '<option value="">' + esc(firstLabel || 'Choose…') + '</option>' +
      list.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (x[0] === chosen ? ' selected' : '') + '>' + esc(x[1]) + '</option>'; }).join('');
  }
  function attemptRows() {
    if (!state.attempts.length) return '<div class="empty"><b>No attempts recorded</b>Logs stay in this browser. A person is counted once for the preregistered success target.</div>';
    return '<div class="table-wrap ledger"><table class="table-wide"><thead><tr><th>ID / VERSION</th><th>PERSON</th><th>OPENED</th><th>TIME</th><th>OUTCOME</th><th>HELP</th><th>BLOCKER</th><th>EVIDENCE</th></tr></thead><tbody>' +
      state.attempts.slice().reverse().map(function (a) {
        const primary = C.firstAttempts(state).get(a.participantId)?.id === a.id;
        return '<tr><td><span class="mono">' + esc(a.id) + '</span><small>' + esc(a.protocolVersion) + (primary ? ' · primary' : ' · retry') + '</small></td>' +
          '<td>' + esc(a.participantId) + '</td><td><span class="mono">' + esc(new Date(a.openedAt).toLocaleString()) + '</span></td>' +
          '<td>' + esc(C.duration(a.durationSeconds)) + '</td><td>' + esc(a.outcome) + '</td><td>' + (a.assisted ? 'Yes' : 'No') +
          '</td><td>' + esc(a.blocker === 'none' ? '—' : (C.STEPS.find(function (x) { return x[0] === a.blocker; }) || [])[1]) +
          '</td><td><span class="pill">' + esc(a.evidence) + '</span><small>' + esc(a.evidenceStatus) +
          (a.receiptUrl ? ' · <a href="' + esc(C.safeUrl(a.receiptUrl)) + '" target="_blank" rel="noopener noreferrer">receipt ↗</a>' : '') +
          '</small>' + (a.note ? '<small>' + esc(a.note) + '</small>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function attemptFormValues() {
    const raw = attemptScratch || {};
    const opened = state.activeTimer ? state.activeTimer.openedAt : raw.openedLocal || toLocal(C.iso());
    const durationMin = state.activeTimer ? C.timerSeconds(state) / 60 : (raw.durationMin || '');
    const pid = state.activeTimer ? state.activeTimer.participantId : raw.participantId || '';
    const timerRunning = !!(state.activeTimer && !state.activeTimer.stoppedAt);
    const timerDone = !!(state.activeTimer && state.activeTimer.stoppedAt);
    return '<form id="attempt-form" novalidate><div class="form-grid">' +
      '<div class="field"><label for="a-participant">Pseudonymous participant ID</label><select id="a-participant" name="participantId" required ' +
      (timerRunning || timerDone ? 'disabled' : '') + '>' + options(C.cohort(state).map(function (x) { return [x, x]; }), pid, 'Choose P01–P' + String(C.baselineProtocol(state).cohortSize).padStart(2, '0')) + '</select>' +
      '<small>No names, emails, wallet secrets or private keys.</small></div>' +
      '<div class="field"><label for="a-opened">Invitation opened <span>(device local time)</span></label><input id="a-opened" name="openedLocal" type="datetime-local" value="' +
      esc(state.activeTimer ? toLocal(opened) : opened) + '" required ' + (state.activeTimer ? 'readonly' : '') + '><small>Include identity, funding and eligibility waits.</small></div>' +
      '<div class="field"><label for="a-duration">Elapsed minutes <span>(including setup)</span></label><input id="a-duration" name="durationMin" type="number" min="0" step="0.01" value="' +
      (durationMin === '' ? '' : esc(C.formatNumber(durationMin))) + '" placeholder="e.g. 3.75" ' +
      (state.activeTimer ? 'readonly' : '') + '><small>A timer starts with the invitation. Manual entries are facilitator-reported.</small></div>' +
      '<div class="field"><label for="a-outcome">Attempt outcome</label><select id="a-outcome" name="outcome" required>' +
      options(C.OUTCOMES.map(function (x) { return [x, x === 'recorded' ? 'Ballot recorded' : x.charAt(0).toUpperCase() + x.slice(1)]; }), raw.outcome || '', 'Choose…') + '</select></div>' +
      '<div class="field"><label for="a-assisted">Individual help needed?</label><select id="a-assisted" name="assisted" required>' +
      options([['false', 'No individual assistance'], ['true', 'Yes · assisted']], raw.assisted || '', 'Choose…') + '</select></div>' +
      '<div class="field"><label for="a-blocker">Main blocking step encountered</label><select id="a-blocker" name="blocker" required>' +
      options(C.STEPS.map(function (x) { return [x[0], x[1]]; }), raw.blocker || 'none', 'Choose…') + '</select>' +
      '<small>Choose the preregistered step. “Other” is reviewed manually.</small></div>' +
      '<div class="field"><label for="a-evidence">Ballot evidence source</label><select id="a-evidence" name="evidence" required>' +
      options(C.EVIDENCE.map(function (x) { return [x, ({ receipt_checked: 'Receipt checked by facilitator', observed: 'Facilitator observed recorded ballot', self_report: 'Participant self-report only', unknown: 'Unknown / unavailable' })[x]]; }), raw.evidence || '', 'Choose…') + '</select></div>' +
      '<div class="field"><label for="a-status">Evidence status</label><select id="a-status" name="evidenceStatus" required>' +
      options([['accepted', 'Not disputed · source stated above'], ['disputed', 'Disputed / unresolved']], raw.evidenceStatus || 'accepted', 'Choose…') + '</select></div>' +
      '<div class="field full"><label for="a-receipt">Receipt / evidence link <span>(never a secret)</span></label><input id="a-receipt" name="receiptUrl" type="url" value="' +
      esc(raw.receiptUrl || '') + '" placeholder="https://…"><small>Required for “Receipt checked”. Note the network/finality rule used in the evidence plan.</small></div>' +
      '<div class="field full"><label for="a-note">Context note <span>(brief, factual; avoid personal data)</span></label><textarea id="a-note" name="note" maxlength="3000" rows="3">' +
      esc(raw.note || '') + '</textarea></div></div>' +
      '<label class="check" style="margin:16px 0"><input type="checkbox" name="consentConfirmed" value="true"' + (raw.consentConfirmed ? ' checked' : '') + ' required>' +
      ' This participant agreed to the attempt log and understands the agreed audience for public ballot records.</label>' +
      '<div class="form-actions"><p>“Observed” and “receipt checked” are facilitator labels, not independent attestation. This app has no chain connection.</p>' +
      '<div class="action-group"><button class="button" type="submit">Save attempt →</button></div></div></form>';
  }
  function effortRows() {
    if (!state.effort.length) return '<div class="empty">Preparation, recruitment, rehearsal and reviews all count toward the cap.</div>';
    return '<div class="table-wrap"><table><thead><tr><th>TIME</th><th>ROLE / PSEUDONYM</th><th>HOURS</th><th>NOTE</th></tr></thead><tbody>' +
      state.effort.slice().reverse().map(function (x) { return '<tr><td>' + esc(new Date(x.recordedAt).toLocaleString()) + '</td><td>' +
        esc(x.person) + '</td><td>' + C.formatNumber(x.hours) + '</td><td>' + esc(x.note || '—') + '</td></tr>'; }).join('') +
      '</tbody></table></div>';
  }
  function renderAttempts() {
    const e = C.evaluate(state), p = C.activeProtocol(state), locked = !state.startedAt || C.isClosed(state);
    const timerUi = state.activeTimer ? '<div class="timer"><div class="timer-header"><div><div class="timer-title">INVITATION TIMER · ' +
      esc(state.activeTimer.participantId) + (state.activeTimer.stoppedAt ? ' · STOPPED' : ' · RUNNING') +
      '</div><div class="timer-value mono" id="timer-display">' + C.duration(C.timerSeconds(state)) + '</div></div>' +
      (!state.activeTimer.stoppedAt ? '<button class="button" type="button" data-action="stop-timer">Stop timer</button>' :
        '<button class="button ghost" type="button" data-action="discard-timer">Discard timer</button>') +
      '</div><p>Timer starts when you open the invitation; it remains saved if this page reloads. A facilitator-entered time is not independently attested.</p></div>' :
      '<div class="timer"><div class="timer-header"><div><div class="timer-title">START WHEN THE INVITATION OPENS</div>' +
      '<div class="inline-note">Select a participant and confirm recording consent in the form first.</div></div>' +
      '<button class="button subtle" type="button" data-action="start-timer" ' + (locked ? 'disabled' : '') + '>Open invitation & start timer ↗</button></div>' +
      '<p>Opens the agreed invitation in a new tab. Timer starts on click and includes setup and any wait for eligibility.</p></div>';
    let body = pageHeader('02 · EXECUTION', 'Attempt log', 'Record what happened as it happened. Keep retries, withdrawals and incomplete evidence visible. ' +
      (state.startedAt ? '' : 'Freeze the experiment card before inviting anyone.'));
    if (C.isClosed(state)) body += '<div class="notice danger"><strong>This pilot is closed.</strong> Its history remains available to inspect and export; start a separate pilot for new work.</div>';
    body += '<div class="grid-two forms"><section class="panel"><div class="section-heading"><div><h2>Participant attempt</h2><p>' +
      esc(p.inviteUrl ? 'Agreed invitation: ' + p.inviteUrl : 'No invitation is recorded yet.') + '</p></div><span class="pill">' +
      esc(state.activeVersionId || 'DRAFT') + '</span></div>' + timerUi +
      (locked ? '<div class="notice">' + (state.startedAt ? 'A closed pilot cannot accept new attempts.' : 'Freeze V1 first. Attempt records will reference the agreed protocol version.') +
        ' <button class="button ghost compact" data-go="protocol">Open experiment card</button></div>' : attemptFormValues()) + '</section>' +
      '<section class="panel"><div class="section-heading"><div><h2>First attempt per person</h2><p>“Qualifying” follows the preregistered rule exactly.</p></div><span class="pill">' +
      e.successes + ' / ' + e.p.cohortSize + ' qualifying</span></div><div class="cohort-grid">' + cohortTiles(e) +
      '</div><div class="callout amber-line"><strong>Keep all attempts.</strong><p>Only the earliest invitation opening determines the acceptance measure. A retry can show recovery, but it cannot erase the first attempt.</p></div>' +
      blockersUi(e) + '</section></div>' +
      '<section class="panel gap-top"><div class="section-heading"><div><h2>Attempt ledger · ' + state.attempts.length + ' records</h2><p>Chronological provenance is retained across protocol amendments.</p></div><span class="pill">' +
      e.retries + ' retries</span></div>' + attemptRows() + '</section>' +
      '<section class="panel gap-top"><div class="section-heading"><div><h2>Team effort · ' + C.formatNumber(e.teamHours) +
      ' / ' + C.formatNumber(e.p.effortCapHours) + ' hours</h2><p>Recruiting, scheduling, setup and review are included.</p></div></div>' +
      (effortScratch ? '' : '') + '<form id="effort-form" class="form-grid mobile-pair"><div class="field"><label for="e-person">Role / pseudonym</label>' +
      '<input id="e-person" name="person" maxlength="200" placeholder="e.g. facilitator" required value="' + esc((effortScratch || {}).person || '') + '"></div>' +
      '<div class="field"><label for="e-hours">Hours</label><input id="e-hours" name="hours" type="number" min="0.01" max="1000" step="0.01" required value="' +
      esc((effortScratch || {}).hours || '') + '"></div><div class="field full"><label for="e-note">What work was done?</label><input id="e-note" name="note" maxlength="3000" value="' +
      esc((effortScratch || {}).note || '') + '"></div><div class="field full"><button class="button subtle" type="submit">Add effort entry</button></div></form><div class="ledger">' +
      effortRows() + '</div></section>';
    root.innerHTML = body;
  }
  function humanReviewRows() {
    if (!state.reviews.length) return '<div class="empty"><b>No human review recorded</b>The monitor can raise a signal. Only the group can authorize what happens next.</div>';
    return state.reviews.slice().reverse().map(function (r) {
      return '<article class="review-record"><span class="tiny-label">' + esc(r.id + ' · ' + new Date(r.recordedAt).toLocaleString()) + '</span><h3>' +
        esc(r.outcome.toUpperCase()) + '</h3><p><strong>Reviewer:</strong> ' + esc(r.reviewer) + '<br><strong>Decision reference:</strong> ' +
        esc(r.reference) + '<br><strong>Reason:</strong> ' + esc(r.reason) + '<br><strong>Evidence checkpoint:</strong> ' +
        esc(r.evidenceFingerprint) + ' · ' + r.snapshot.attempts + ' attempt(s) · ' + C.formatNumber(r.snapshot.teamHours) + ' team hours' +
        '<br><strong>Next action:</strong> ' + esc(r.nextAction || 'None recorded') + '<br><strong>Additional effort allowed:</strong> ' +
        C.formatNumber(r.additionalHours) + ' hour(s)<br><strong>Next review:</strong> ' + esc(r.nextReviewAt || 'Not scheduled') + '</p></article>';
    }).join('');
  }
  function renderReview() {
    const e = C.evaluate(state), locked = C.isClosed(state);
    const signals = e.triggers.length ? '<div class="signal-list">' + e.triggers.map(function (t) {
      return '<div class="signal"><span class="signal-icon" aria-hidden="true">◇</span><div><h3>' + esc(t.title) +
        '</h3><p>' + esc(t.detail) + '</p></div></div>';
    }).join('') + '</div>' : '<div class="notice success"><strong>No current review trigger.</strong> The monitoring clock follows the agreed start; opening this page does not initiate a review.</div>';
    const future = reviewScratch || {};
    let body = pageHeader('03 · HUMAN AUTHORITY', 'Review what happens next', 'Signals identify evidence that deserves attention. This page records a team decision; it never pauses a contract or authorizes a chain action.');
    body += signals + '<div class="grid-two equal gap-top"><section class="panel"><h3>At this checkpoint</h3><table class="table-pair"><tbody>' +
      '<tr><td>Human-readable status</td><td><span class="pill ' + (e.triggers.length ? 'warn' : 'success') + '">' + esc(e.status) + '</span></td></tr>' +
      '<tr><td>Qualifying first attempts</td><td>' + e.successes + ' / ' + e.p.cohortSize + ' · target ' + e.p.successTarget +
      '</td></tr><tr><td>Missing / unresolved</td><td>' + e.missing + ' missing · ' + e.unknown + ' unresolved</td></tr>' +
      '<tr><td>Verified / self-reported ballots</td><td>' + e.verifiedBallots + ' / ' + e.reportedBallots + '</td></tr>' +
      '<tr><td>Repeated blocker</td><td>' + (e.blockers.filter(function (b) { return b.count >= e.p.blockerThreshold && b.step !== 'other'; }).map(function (b) { return esc(b.label + ' (' + b.count + ')'); }).join(', ') || 'None above threshold') + '</td></tr>' +
      '<tr><td>Effort</td><td>' + C.formatNumber(e.teamHours) + ' / ' + e.p.effortCapHours + ' hours</td></tr>' +
      '<tr><td>Review deadline</td><td>' + (e.deadline ? esc(new Date(e.deadline).toLocaleString()) : 'Clock not started') + '</td></tr>' +
      '<tr><td>Evidence checkpoint</td><td class="mono">' + esc(C.fingerprint(state)) + '</td></tr></tbody></table>' +
      '<p>This is descriptive evidence. It does not tell the group which values to prioritize.</p></section>' +
      '<section class="panel"><h3>Review has three different jobs</h3><div class="callout"><strong>Continue</strong><p>Approve a bounded next action, additional hours, and another review date.</p></div><div class="callout"><strong>Amend</strong><p>Link the new authorization and keep the earlier protocol and decision intact.</p></div><div class="callout"><strong>Complete or stop</strong><p>Close this pilot while recording obligations and what remains unknown.</p></div></section></div>' +
      '<section class="panel gap-top"><div class="section-heading"><div><h2>Record a group decision</h2><p>A signed-attribution observation is still not proof of an external outcome.</p></div></div>' +
      (locked ? '<div class="notice danger"><strong>This pilot is closed.</strong> Export its final history before starting a separate pilot.</div>' :
        '<form id="review-form" class="form-grid"><div class="field"><label for="r-outcome">Human decision</label><select id="r-outcome" name="outcome" required>' +
        options([['continue', 'Continue · bounded next action'], ['amend', 'Amend · new linked authorization'], ['complete', 'Complete this pilot'], ['stop', 'Stop further work']], future.outcome || '', 'Choose the group decision…') + '</select></div>' +
        '<div class="field"><label for="r-reviewer">Reviewer / role</label><input id="r-reviewer" name="reviewer" required maxlength="200" value="' + esc(future.reviewer || '') + '"></div>' +
        '<div class="field full"><label for="r-reason">Reason, including dissent or unresolved uncertainty</label><textarea id="r-reason" name="reason" required maxlength="10000">' + esc(future.reason || '') + '</textarea></div>' +
        '<div class="field full"><label for="r-reference">External authorization / decision reference</label><input id="r-reference" name="reference" required maxlength="2000" placeholder="https://… or agreed record ID" value="' + esc(future.reference || '') + '"><small>Evidence checkpoint: ' + esc(C.fingerprint(state)) + '</small></div>' +
        '<div class="field full"><label for="r-next">Bounded next action <span>(required for Continue or Amend)</span></label><textarea id="r-next" name="nextAction" maxlength="5000">' + esc(future.nextAction || '') + '</textarea></div>' +
        '<div class="field"><label for="r-hours">Additional hours authorized</label><input id="r-hours" name="additionalHours" type="number" min="0" max="1000" step="0.25" value="' + esc(future.additionalHours || '0') + '"></div>' +
        '<div class="field"><label for="r-date">Next review date <span>(device local time)</span></label><input id="r-date" name="nextReviewAtLocal" type="datetime-local" value="' + esc(future.nextReviewAtLocal || '') + '"></div>' +
        '<div class="field full"><button class="button" type="submit">Record human decision →</button><small>Stored as an append-only review checkpoint. Continue/Amend require a future date and positive additional-hour allowance.</small></div></form>') +
      '</section><section class="gap-top"><div class="section-heading"><div><h2>Human decision history</h2><p>Later evidence can make an earlier review stale; the earlier checkpoint remains visible.</p></div></div>' +
      humanReviewRows() + '</section>';
    root.innerHTML = body;
  }
  function download(name, content, type) {
    const blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function reportText() { return C.reportMarkdown(state, Date.now()); }
  function renderReport() {
    const e = C.evaluate(state), isDemo = mode === 'demo';
    const report = reportText(); reportCache = report;
    root.innerHTML = pageHeader('04 · SHAREABLE OUTPUT', 'Report & exports', 'Produce a report that preserves uncertainty, dissent, retries and the limits of the evidence.') +
      (isDemo ? '<div class="notice"><strong>Demo report · synthetic only.</strong> The included P01–P10, observations and review were generated for illustration. No participant or live result is represented.</div>' : '') +
      '<section class="export-grid"><article class="export-card"><span class="export-icon" aria-hidden="true">▤</span><h2>' +
      (isDemo ? 'Download synthetic report' : 'Export Markdown report') + '</h2><p>' + (isDemo ? 'Clearly watermarked sample for reviewing the report structure.' : 'GitHub-ready report generated from the active pilot and its evidence.') +
      '</p><button class="button" data-action="report-download">Download .md ↓</button></article>' +
      '<article class="export-card"><span class="export-icon" aria-hidden="true">{ }</span><h2>JSON backup</h2><p>Complete portable workspace, including attempts, protocol history and review checkpoints.</p><button class="button subtle" data-action="backup">Download JSON ↓</button></article>' +
      '<article class="export-card"><span class="export-icon" aria-hidden="true">▧</span><h2>Blank experiment card</h2><p>Protocol template and acceptance rules, with all approvals and results unset.</p><div class="action-group"><button class="button subtle" data-action="template-download">Markdown ↓</button><button class="button ghost" data-action="template-json">JSON ↓</button></div></article></section>' +
      '<div class="section-heading"><div><h2>Report preview</h2><p>' + e.successes + ' qualifying first attempts · ' + e.missing + ' missing · ' + e.unknown + ' unresolved · ' +
      C.formatNumber(e.teamHours) + ' team hours</p></div><button class="button ghost compact" data-action="copy-report">Copy Markdown</button></div>' +
      '<pre class="report-preview" id="report-preview">' + esc(report) + '</pre>' +
      '<details><summary>Portable decision format · JSON</summary><p>The tool accepts and validates a versioned local JSON workspace. Quantum-OS or RhoGov adapters are a future integration; this export does not post to either system.</p></details>';
  }
  function blankTemplateJson() {
    const s = C.newPilot('live');
    return JSON.stringify(s, null, 2) + '\n';
  }
  function backupJson() { return JSON.stringify(state, null, 2) + '\n'; }
  function saveAsDownloaded() {
    const stamp = new Date().toISOString().slice(0, 10);
    download((mode === 'demo' ? 'DEMO-SYNTHETIC-' : '') + 'RhoGov-Pilot-' + stamp + '.json', backupJson(), 'application/json');
    toast('JSON backup downloaded. Keep it private: it contains your complete attempt log.');
  }
  function safeSlug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'pilot'; }
  function formToProtocol(d) {
    const p = C.clone(protocolBuffer || C.activeProtocol(state));
    C.TEXT_FIELDS.forEach(function (k) { if (d[k] !== undefined) p[k] = d[k]; });
    p.decisionUrl = d.decisionUrl || ''; p.inviteUrl = d.inviteUrl || '';
    C.RULE_FIELDS.forEach(function (k) { if (d[k] !== undefined) p[k] = Number(d[k]); });
    p.agreementConfirmed = d.agreementConfirmed === true; p.visibilityConfirmed = d.visibilityConfirmed === true;
    C.validateProtocol(p); return p;
  }
  function rememberForm(form, target) { if (form) target = formValues(form); return target; }
  function snapshotCurrentForms() {
    if (tab === 'attempts') {
      const a = $('#attempt-form'); if (a) attemptScratch = formValues(a);
      const f = $('#effort-form'); if (f) effortScratch = formValues(f);
    } else if (tab === 'review') {
      const f = $('#review-form'); if (f) reviewScratch = formValues(f);
    } else if (tab === 'protocol' && protocolDirty && $('#protocol-form')) {
      const d = formValues($('#protocol-form'));
      try { protocolBuffer = formToProtocol(d); } catch (_) {}
    }
  }
  function captureRawForms() {
    if (tab === 'attempts') {
      if ($('#attempt-form')) attemptScratch = formValues($('#attempt-form'));
      if ($('#effort-form')) effortScratch = formValues($('#effort-form'));
    } else if (tab === 'review' && $('#review-form')) reviewScratch = formValues($('#review-form'));
  }
  function processProtocol(form, action) {
    const d = formValues(form);
    const p = formToProtocol(d);
    try {
      if (action === 'amend') {
        const next = C.amend(state, p, d.amendmentReason || '', d.amendmentAuthorization || '', Date.now());
        protocolBuffer = null; protocolDirty = false; amending = false; writePilot(next);
        toast('Linked protocol amendment saved.');
      } else if (!state.startedAt) {
        let next = C.saveDraft(state, p, Date.now());
        if (action === 'start') next = C.startPilot(next, Date.now());
        protocolBuffer = null; protocolDirty = false; writePilot(next);
        toast(action === 'start' ? 'V1 frozen. The 14-day clock has started.' : 'Experiment card saved on this device.');
      } else {
        protocolBuffer = null; protocolDirty = false; writePilot(C.saveDraft(state, p, Date.now()));
        toast('Draft details updated.');
      }
    } catch (err) { toast(err.message, true); }
  }
  function stopOtherDrafts(nextTab) {
    if (tab === 'protocol' && protocolDirty && nextTab !== 'protocol' &&
      !confirm('Discard the unsaved experiment card?')) return false;
    return true;
  }
  function currentFormEvent(e) {
    const action = e.submitter && e.submitter.value || '';
    const form = e.target;
    if (form.id === 'protocol-form') { e.preventDefault(); processProtocol(form, action); return; }
    if (form.id === 'attempt-form') {
      e.preventDefault(); const d = formValues(form);
      try {
        if (!d.consentConfirmed) throw new Error('Confirm this participant agreed to the attempt log before saving.');
        const data = { participantId: d.participantId, openedAt: fromLocal(d.openedLocal),
          durationSeconds: n(d.durationMin) === null ? null : Math.round(Number(d.durationMin) * 60),
          outcome: d.outcome, assisted: d.assisted === 'true', blocker: d.blocker,
          evidence: d.evidence, evidenceStatus: d.evidenceStatus, receiptUrl: d.receiptUrl || '',
          note: d.note || '', consentConfirmed: true };
        if (!data.openedAt) throw new Error('Record when the invitation opened.');
        if (data.outcome === 'recorded' && data.durationSeconds === null) throw new Error('A recorded ballot needs an elapsed time, even if unknown times out of target.');
        if (data.evidence === 'receipt_checked' && !data.receiptUrl) throw new Error('Add the receipt link if selecting “Receipt checked”.');
        const next = C.addAttempt(state, data, Date.now());
        attemptScratch = null; writePilot(next); toast('Attempt saved. Earlier records and retries are intact.');
      } catch (err) { toast(err.message, true); }
      return;
    }
    if (form.id === 'effort-form') {
      e.preventDefault(); const d = formValues(form);
      try {
        const next = C.addEffort(state, { person: d.person, hours: Number(d.hours), note: d.note }, Date.now());
        effortScratch = null; writePilot(next); toast('Team effort recorded.');
      } catch (err) { toast(err.message, true); }
      return;
    }
    if (form.id === 'review-form') {
      e.preventDefault(); const d = formValues(form);
      try {
        const next = C.recordReview(state, { reviewer: d.reviewer, outcome: d.outcome, reason: d.reason,
          reference: d.reference, nextAction: d.nextAction, additionalHours: Number(d.additionalHours || 0),
          nextReviewAt: fromLocal(d.nextReviewAtLocal) }, Date.now());
        reviewScratch = null; writePilot(next); toast('Human review decision appended to the record.');
      } catch (err) { toast(err.message, true); }
    }
  }
  function formInputEvent(e) {
    if (tab === 'protocol' && e.target.closest('#protocol-form')) {
      protocolDirty = true;
      const raw = formValues($('#protocol-form'));
      try { protocolBuffer = formToProtocol(raw); } catch (_) {
        if (!protocolBuffer) protocolBuffer = C.clone(C.activeProtocol(state));
        C.TEXT_FIELDS.forEach(function (k) { if (raw[k] !== undefined) protocolBuffer[k] = raw[k]; });
        C.RULE_FIELDS.forEach(function (k) { if (raw[k] !== undefined && raw[k] !== '') protocolBuffer[k] = Number(raw[k]); });
        protocolBuffer.agreementConfirmed = raw.agreementConfirmed === true;
        protocolBuffer.visibilityConfirmed = raw.visibilityConfirmed === true;
        ['decisionUrl', 'inviteUrl'].forEach(function (k) { if (raw[k] !== undefined) protocolBuffer[k] = raw[k]; });
      }
    }
    if (e.target.closest('#attempt-form')) attemptScratch = formValues($('#attempt-form'));
    if (e.target.closest('#effort-form')) effortScratch = formValues($('#effort-form'));
    if (e.target.closest('#review-form')) reviewScratch = formValues($('#review-form'));
  }
  function startTimerFromForm() {
    const form = $('#attempt-form');
    if (!form) { toast('Open the attempt log and choose a participant first.', true); return; }
    const d = formValues(form);
    if (!d.participantId || !d.consentConfirmed) { toast('Choose a participant and confirm recording consent first.', true); return; }
    const link = C.activeProtocol(state).inviteUrl;
    if (!link) { toast('Add and freeze an invitation link first.', true); return; }
    try {
      window.open(C.safeUrl(link), '_blank', 'noopener,noreferrer');
      const next = C.startTimer(state, d.participantId, Date.now());
      attemptScratch = d; attemptScratch.openedLocal = toLocal(next.activeTimer.openedAt);
      writePilot(next); toast('Timer started. The invitation opened in a new tab.');
    } catch (err) { toast(err.message, true); }
  }
  function importWorkspace(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('Backup exceeds the 2 MB limit; no data changed.', true); return; }
    const reader = new FileReader();
    reader.onerror = function () { toast('Could not read that backup; current pilot is unchanged.', true); };
    reader.onload = function () {
      try {
        const next = C.parseImport(String(reader.result));
        if (next.mode !== mode) throw new Error('This file is a ' + next.mode + ' workspace. Switch to that mode before importing it.');
        next.id = 'pilot-import-' + Date.now().toString(36);
        next.updatedAt = C.iso();
        C.validate(next);
        if (state && (state.startedAt || state.attempts.length || state.effort.length) &&
          !confirm('Import this as a separate pilot? Your current pilot will remain saved.')) return;
        externalConflict = false; lastSavedRaw = '';
        writePilot(next); toast('Backup validated and imported as a separate pilot.');
      } catch (err) { toast(err.message + ' Your current pilot has not changed.', true); }
    };
    reader.readAsText(file);
  }
  root.addEventListener('click', function (ev) {
    const t = ev.target.closest('button, [data-go]'); if (!t) return;
    if (t.dataset.tab) { if (tab !== t.dataset.tab) go(t.dataset.tab); return; }
    if (t.dataset.go) { go(t.dataset.go); return; }
    const act = t.dataset.action;
    if (act === 'switch-live') activate('live', false);
    else if (act === 'new-live') activate('live', true);
    else if (act === 'switch-demo') activate('demo', false);
    else if (act === 'new-amendment') { amending = true; protocolBuffer = C.clone(C.activeProtocol(state)); protocolDirty = false; render(); }
    else if (act === 'cancel-amendment') { amending = false; protocolBuffer = null; protocolDirty = false; render(); }
    else if (act === 'load-template') {
      if (protocolDirty && !confirm('Replace the unsaved card with the proposal’s starting values?')) return;
      protocolBuffer = C.defaultProtocol(); protocolDirty = true; render();
    } else if (act === 'start-timer') startTimerFromForm();
    else if (act === 'stop-timer') {
      captureRawForms();
      try { writePilot(C.stopTimer(state, Date.now())); toast('Timer stopped. Save the attempt to retain it in the ledger.'); }
      catch (err) { toast(err.message, true); }
    } else if (act === 'discard-timer') {
      captureRawForms();
      if (!confirm('Discard this stopped timer? You can type the elapsed time manually.')) return;
      try { writePilot(C.discardTimer(state, Date.now())); attemptScratch = null; }
      catch (err) { toast(err.message, true); }
    } else if (act === 'backup') saveAsDownloaded();
    else if (act === 'report-download') {
      download((mode === 'demo' ? 'DEMO-SYNTHETIC-' : '') + 'RhoGov-Pilot-Report.md', reportText(), 'text/markdown;charset=utf-8');
      toast(mode === 'demo' ? 'Synthetic report downloaded. It is clearly watermarked.' : 'Report downloaded.');
    } else if (act === 'template-download') download('RhoGov-Blank-Experiment-Template.md',
      C.protocolMarkdown(C.defaultProtocol(), true), 'text/markdown;charset=utf-8');
    else if (act === 'template-json') download('RhoGov-Blank-Experiment-Template.json',
      blankTemplateJson(), 'application/json');
    else if (act === 'copy-report') navigator.clipboard.writeText(reportText()).then(function () { toast('Markdown copied.'); },
      function () { toast('Clipboard is unavailable; download the report instead.', true); });
  });
  $('#navigation').addEventListener('click', function (ev) {
    const b = ev.target.closest('[data-tab]'); if (b && tab !== b.dataset.tab) go(b.dataset.tab);
  });
  document.addEventListener('submit', currentFormEvent);
  document.addEventListener('input', formInputEvent);
  document.addEventListener('change', formInputEvent);
  $('#import-file').addEventListener('change', function (ev) {
    importWorkspace(ev.target.files && ev.target.files[0]); ev.target.value = '';
  });
  $('#mode-bar').addEventListener('click', function (ev) {
    const b = ev.target.closest('[data-action]'); if (!b) return;
    if (b.dataset.action === 'switch-live') activate('live', false);
    if (b.dataset.action === 'switch-demo') activate('demo', false);
    if (b.dataset.action === 'new-live') activate('live', true);
  });
  $('#mode-bar').addEventListener('change', function (ev) {
    const picker = ev.target.closest('#live-picker');
    if (!picker || !picker.value || state.id === picker.value) return;
    if ((tab === 'protocol' && protocolDirty) || ((tab === 'attempts') && (attemptScratch || effortScratch)) ||
        (tab === 'review' && reviewScratch)) {
      if (!confirm('Discard unsaved form edits before switching pilots?')) { picker.value = state.id; return; }
    }
    const loaded = loadStored(picker.value, 'live');
    if (!loaded) { toast('Could not load that saved pilot; current workspace is unchanged.', true); picker.value = state.id; return; }
    state = loaded.state; lastSavedRaw = loaded.raw; externalConflict = false;
    protocolBuffer = null; protocolDirty = false; amending = false;
    attemptScratch = null; effortScratch = null; reviewScratch = null; tab = 'overview';
    try { if (!volatileStorage) localStorage.setItem(activeKey('live'), state.id); } catch (_) {}
    render();
  });
  document.querySelector('.top-actions [data-action="backup"]').addEventListener('click', saveAsDownloaded);
  document.querySelector('.top-actions').insertAdjacentHTML('beforeend',
    '<button class="button ghost compact" type="button" data-action="import">Import JSON ↑</button>');
  document.querySelector('[data-action="import"]').addEventListener('click', function () { $('#import-file').click(); });
  window.addEventListener('storage', function (ev) {
    if (!state || ev.key !== key(state) || ev.newValue === lastSavedRaw) return;
    externalConflict = true;
    storageWarning = 'Another browser tab changed this pilot. Your tab will not overwrite it. Download your current report, then reload the saved workspace.';
    render();
  });
  window.addEventListener('beforeunload', function (ev) {
    if (protocolDirty || (!volatileStorage && state && localStorage.getItem(key(state)) !== lastSavedRaw)) {
      ev.preventDefault(); ev.returnValue = '';
    }
  });
  try {
    localStorage.setItem(storageBase + 'probe', '1'); localStorage.removeItem(storageBase + 'probe');
  } catch (_) {
    volatileStorage = true;
    storageWarning = 'Browser storage is unavailable. This workspace will not persist when the tab closes; download a JSON backup before leaving.';
  }
  mode = 'demo';
  const initial = loadStored('pilot-DEMO-synthetic', 'demo');
  state = initial.state; lastSavedRaw = initial.raw;
  if (integrityWarning) state.id = 'pilot-demo-recovered-' + Date.now().toString(36);
  if (!volatileStorage && !lastSavedRaw) {
    try { lastSavedRaw = JSON.stringify(state); localStorage.setItem(key(state), lastSavedRaw); } catch (_) {}
  }
  render();
})();
