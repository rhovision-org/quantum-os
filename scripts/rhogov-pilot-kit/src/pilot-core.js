(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PilotCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SCHEMA = 'rhogov-pilot/1';
  const STEPS = [
    ['none', 'No blocker'], ['identity', 'Identity setup'], ['faucet', 'Test REV / faucet'],
    ['eligibility', 'Membership / voter eligibility'], ['comprehension', 'Understanding the task'],
    ['submission', 'Ballot submission'], ['network', 'Network / service'], ['other', 'Other (manual review)']
  ];
  const OUTCOMES = ['recorded', 'incomplete', 'withdrawn', 'unknown'];
  const EVIDENCE = ['receipt_checked', 'observed', 'self_report', 'unknown'];
  const RULE_FIELDS = ['cohortSize', 'successTarget', 'maxMinutes', 'blockerThreshold', 'effortCapHours', 'durationDays'];
  const TEXT_FIELDS = ['title', 'purpose', 'authorizedAction', 'owner', 'evidenceLead', 'reviewer',
    'network', 'contracts', 'electorate', 'approvalReference', 'scope', 'expectedResult', 'dissent', 'evidencePlan', 'dataAudience'];
  const FIELD_LABELS = {
    title: 'Pilot name', purpose: 'Purpose / research question', authorizedAction: 'Authorized action',
    owner: 'Pilot owner', evidenceLead: 'Evidence lead', reviewer: 'Independent reviewer',
    network: 'Network / environment', contracts: 'Contract addresses', electorate: 'Electorate and eligibility',
    approvalReference: 'Group approval reference', scope: 'Boundaries and limits',
    expectedResult: 'Expected result', dissent: 'Dissent and remaining concern',
    evidencePlan: 'Evidence and observation plan', dataAudience: 'Raw log audience and retention'
  };
  const REQUIRED_FIELDS = ['title', 'purpose', 'authorizedAction', 'owner', 'evidenceLead', 'reviewer',
    'network', 'contracts', 'electorate', 'approvalReference', 'scope', 'expectedResult', 'evidencePlan', 'dataAudience'];
  const SOURCES = {
    proposal: 'https://github.com/rhovision-org/quantum-os/issues/242',
    guide: 'https://github.com/rhovision-org/rhogov/blob/main/docs/user-guide.md',
    eies: 'https://digitalcommons.njit.edu/ccccreports/28/'
  };
  const clone = function (value) { return JSON.parse(JSON.stringify(value)); };
  const assert = function (ok, message) { if (!ok) throw new Error(message); };
  const object = function (x) { return x && typeof x === 'object' && !Array.isArray(x); };
  const text = function (x, name, max) {
    assert(typeof x === 'string' && x.length <= (max || 20000), name + ' must be text within the length limit.');
  };
  const number = function (x, min, max, name, integer) {
    assert(typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max &&
      (!integer || Number.isInteger(x)), name + ' is outside its allowed range.');
  };
  const date = function (x, name) {
    assert(typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(x) &&
      Number.isFinite(Date.parse(x)), name + ' must be a UTC timestamp.');
  };
  const iso = function (now) {
    const d = new Date(now === undefined ? Date.now() : now);
    assert(Number.isFinite(d.getTime()), 'Invalid time.');
    return d.toISOString();
  };
  const uid = function () {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return 'pilot-' + crypto.randomUUID();
    return 'pilot-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  };
  function safeUrl(value) {
    if (value === '') return '';
    text(value, 'Link', 2000);
    let u;
    try { u = new URL(value); } catch (_) { throw new Error('Use a full https:// or http:// link.'); }
    assert((u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname && !u.username && !u.password,
      'Links must use http(s), with no credentials in the URL.');
    return u.href;
  }
  function defaultProtocol() {
    return {
      title: 'RhoGov — Decisions That Learn',
      purpose: 'Can a newcomer on a phone understand a meaningful decision and make a first contribution?',
      authorizedAction: 'Run one low-impact decision on the playground with test REV, then show what changed.',
      owner: '', evidenceLead: '', reviewer: '', decisionUrl: SOURCES.proposal, inviteUrl: '',
      network: '', contracts: '', electorate: '', approvalReference: '',
      scope: 'One invitation, one short explanation, one decision, one visible follow-up. Recruitment and scheduling count toward team effort.',
      expectedResult: 'At least 7 of 10 consenting newcomers have a valid ballot recorded within 5 minutes without individual assistance.',
      dissent: 'Identity setup, faucet availability, voter eligibility or unclear instructions may block participation.',
      evidencePlan: 'Use P01–P10. Time starts when the invitation opens, including setup and eligibility waits. Record every attempt, assistance, withdrawals and unknowns. Check ballot evidence; retain missing and disputed observations. Assess the earliest opened attempt per participant.',
      dataAudience: '',
      cohortSize: 10, successTarget: 7, maxMinutes: 5, blockerThreshold: 3, effortCapHours: 10, durationDays: 14,
      agreementConfirmed: false, visibilityConfirmed: false
    };
  }
  function newPilot(mode, now) {
    const t = iso(now);
    return { schema: SCHEMA, id: uid(), mode: mode || 'live', createdAt: t, updatedAt: t,
      draft: defaultProtocol(), startedAt: null, versions: [], activeVersionId: null,
      attempts: [], effort: [], reviews: [], activeTimer: null };
  }
  function validateProtocol(p) {
    assert(object(p), 'Missing protocol.');
    TEXT_FIELDS.forEach(function (k) { text(p[k], 'Protocol: ' + k); });
    ['decisionUrl', 'inviteUrl'].forEach(function (k) { safeUrl(p[k]); });
    number(p.cohortSize, 1, 50, 'Cohort size', true);
    number(p.successTarget, 1, p.cohortSize, 'Success target', true);
    number(p.maxMinutes, 0.5, 120, 'Time limit');
    number(p.blockerThreshold, 1, p.cohortSize, 'Blocker threshold', true);
    number(p.effortCapHours, 0.25, 1000, 'Effort cap');
    number(p.durationDays, 1, 365, 'Duration', true);
    assert(typeof p.agreementConfirmed === 'boolean' && typeof p.visibilityConfirmed === 'boolean',
      'Agreement and visibility acknowledgements must be true/false.');
    return p;
  }
  function readiness(p) {
    const missing = REQUIRED_FIELDS.filter(function (k) { return !p[k].trim(); });
    if (!p.inviteUrl) missing.push('inviteUrl');
    if (!p.agreementConfirmed) missing.push('agreementConfirmed');
    if (!p.visibilityConfirmed) missing.push('visibilityConfirmed');
    return missing;
  }
  const activeProtocol = function (s) {
    return s.versions.length ? s.versions[s.versions.length - 1].protocol : s.draft;
  };
  const baselineProtocol = function (s) { return s.versions.length ? s.versions[0].protocol : s.draft; };
  function cohort(s) {
    return Array.from({ length: baselineProtocol(s).cohortSize }, function (_, i) {
      return 'P' + String(i + 1).padStart(2, '0');
    });
  }
  function sameRules(a, b) { return RULE_FIELDS.every(function (k) { return a[k] === b[k]; }); }
  function uniqueIds(items, name) {
    const ids = new Set();
    items.forEach(function (r) {
      assert(object(r), name + ' contains an invalid record.');
      text(r.id, name + ' ID', 100);
      assert(r.id.length > 0 && !ids.has(r.id), 'Duplicate or empty ' + name + ' ID: ' + r.id);
      ids.add(r.id);
    });
  }
  function validate(s) {
    assert(object(s) && s.schema === SCHEMA, 'Unsupported backup format. Expected ' + SCHEMA + '.');
    text(s.id, 'Pilot ID', 100); assert(s.id.length > 0, 'Missing pilot ID.');
    assert(['live', 'demo'].includes(s.mode), 'Backup must declare live or demo mode.');
    date(s.createdAt, 'Created time'); date(s.updatedAt, 'Updated time');
    validateProtocol(s.draft);
    ['versions', 'attempts', 'effort', 'reviews'].forEach(function (k) {
      assert(Array.isArray(s[k]) && s[k].length <= (k === 'reviews' ? 50 : 1000), k + ' exceeds the record limit.');
      uniqueIds(s[k], k);
    });
    if (s.startedAt === null) {
      assert(s.versions.length === 0 && s.activeVersionId === null && s.attempts.length === 0,
        'An unstarted pilot cannot contain frozen versions or attempts.');
    } else {
      date(s.startedAt, 'Agreed start');
      assert(s.versions.length > 0 && s.activeVersionId === s.versions[s.versions.length - 1].id,
        'Active protocol version is missing or inconsistent.');
      s.versions.forEach(function (v, i) {
        assert(v.id === 'V' + (i + 1) && v.previous === (i ? 'V' + i : null), 'Broken protocol version chain.');
        date(v.lockedAt, 'Version time'); text(v.reason, 'Version reason'); text(v.authorization, 'Version authorization');
        validateProtocol(v.protocol);
        assert(readiness(v.protocol).length === 0, 'Frozen protocol is incomplete.');
        assert(sameRules(v.protocol, s.versions[0].protocol), 'Baseline measurement rules cannot change within a pilot.');
      });
    }
    const participants = new Set(cohort(s));
    const versionIds = new Set(s.versions.map(function (v) { return v.id; }));
    s.attempts.forEach(function (a) {
      assert(participants.has(a.participantId), 'Attempt references an unknown participant: ' + a.participantId);
      assert(versionIds.has(a.protocolVersion), 'Attempt references an unknown protocol version.');
      date(a.openedAt, 'Invitation opened'); date(a.recordedAt, 'Attempt recorded');
      assert(Date.parse(a.openedAt) >= Date.parse(s.startedAt), 'An attempt predates the agreed start.');
      assert(Date.parse(a.openedAt) <= Date.parse(a.recordedAt), 'An attempt cannot open after it was recorded.');
      if (a.durationSeconds !== null) number(a.durationSeconds, 0, 604800, 'Duration in seconds');
      assert(OUTCOMES.includes(a.outcome), 'Unknown attempt outcome.');
      assert(EVIDENCE.includes(a.evidence), 'Unknown evidence source.');
      assert(['accepted', 'disputed'].includes(a.evidenceStatus), 'Unknown evidence status.');
      assert(typeof a.assisted === 'boolean' && a.consentConfirmed === true, 'Every attempt needs recording consent and an assistance flag.');
      assert(STEPS.some(function (p) { return p[0] === a.blocker; }), 'Unknown blocking step.');
      text(a.note, 'Attempt note'); safeUrl(a.receiptUrl);
      if (a.evidence === 'receipt_checked') assert(a.receiptUrl.length > 0, 'Checked receipts need an evidence link.');
    });
    s.effort.forEach(function (e) {
      date(e.recordedAt, 'Effort time'); text(e.person, 'Effort role', 200); text(e.note, 'Effort note');
      number(e.hours, 0.01, 1000, 'Team hours');
    });
    s.reviews.forEach(function (r) {
      date(r.recordedAt, 'Review time'); text(r.reviewer, 'Review owner', 200); text(r.reason, 'Review reason');
      text(r.reference, 'Review reference', 2000); text(r.nextAction, 'Next action');
      text(r.evidenceFingerprint, 'Review checkpoint', 100);
      assert(['continue', 'amend', 'complete', 'stop'].includes(r.outcome), 'Unknown human review outcome.');
      assert(object(r.snapshot), 'Review checkpoint summary is missing.');
      assert(r.protocolVersion === null || versionIds.has(r.protocolVersion), 'Review references an unknown version.');
      if (r.nextReviewAt !== null) date(r.nextReviewAt, 'Next review');
      number(r.additionalHours, 0, 1000, 'Future effort authorization');
    });
    if (s.activeTimer !== null) {
      assert(object(s.activeTimer) && participants.has(s.activeTimer.participantId) && s.startedAt !== null,
        'Invalid active timer.');
      date(s.activeTimer.openedAt, 'Timer start');
      assert(Date.parse(s.activeTimer.openedAt) >= Date.parse(s.startedAt), 'Timer predates the pilot.');
      if (s.activeTimer.stoppedAt !== null) {
        date(s.activeTimer.stoppedAt, 'Timer stop');
        assert(Date.parse(s.activeTimer.stoppedAt) >= Date.parse(s.activeTimer.openedAt), 'Timer cannot end before it starts.');
      }
    }
    return s;
  }
  function parseImport(raw) {
    assert(typeof raw === 'string' && raw.length <= 2 * 1024 * 1024, 'Backup is too large (maximum 2 MB).');
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { throw new Error('This file is not valid JSON. Your current pilot has not changed.'); }
    validate(parsed);
    return clone(parsed);
  }
  function touch(s, now) { s.updatedAt = iso(now); return validate(s); }
  function saveDraft(s, p, now) {
    assert(s.versions.length === 0, 'The protocol is frozen. Add a linked amendment instead.');
    validateProtocol(p);
    const n = clone(s); n.draft = clone(p); return touch(n, now);
  }
  function startPilot(s, now) {
    assert(!s.startedAt, 'This pilot has already started.');
    assert(readiness(s.draft).length === 0, 'Complete the agreement fields and acknowledgements before starting.');
    const n = clone(s); n.startedAt = iso(now);
    n.versions.push({ id: 'V1', previous: null, lockedAt: n.startedAt, reason: 'Initial agreed protocol',
      authorization: n.draft.approvalReference, protocol: clone(n.draft) });
    n.activeVersionId = 'V1'; return touch(n, now);
  }
  function amend(s, p, reason, authorization, now) {
    assert(s.startedAt, 'Start and freeze the initial protocol before amending.');
    assert(!isClosed(s), 'This pilot is closed. Start a separate pilot for further work.');
    validateProtocol(p);
    assert(readiness(p).length === 0, 'The amendment must include all agreement fields.');
    assert(sameRules(p, baselineProtocol(s)), 'Keep original measurement rules. Use a separate pilot to change targets or limits.');
    assert(reason.trim() && authorization.trim(), 'Record the amendment reason and its agreed authorization.');
    const n = clone(s); const id = 'V' + (n.versions.length + 1);
    n.versions.push({ id: id, previous: n.activeVersionId, lockedAt: iso(now), reason: reason,
      authorization: authorization, protocol: clone(p) });
    n.activeVersionId = id; return touch(n, now);
  }
  function nextId(items, prefix) {
    let i = items.length + 1;
    const ids = new Set(items.map(function (x) { return x.id; }));
    while (ids.has(prefix + String(i).padStart(4, '0'))) i++;
    return prefix + String(i).padStart(4, '0');
  }
  function isClosed(s) {
    const r = s.reviews[s.reviews.length - 1];
    return !!r && (r.outcome === 'complete' || r.outcome === 'stop');
  }
  function addAttempt(s, data, now) {
    assert(s.startedAt, 'Agree and start the protocol before recording attempts.');
    assert(!isClosed(s), 'This pilot is closed; export its record or start a new pilot.');
    const n = clone(s);
    n.attempts.push({
      id: nextId(n.attempts, 'A'), protocolVersion: n.activeVersionId,
      participantId: data.participantId, openedAt: data.openedAt, recordedAt: iso(now),
      durationSeconds: data.durationSeconds, outcome: data.outcome, assisted: data.assisted,
      blocker: data.blocker, evidence: data.evidence, evidenceStatus: data.evidenceStatus,
      receiptUrl: data.receiptUrl || '', note: data.note || '', consentConfirmed: data.consentConfirmed
    });
    if (n.activeTimer && n.activeTimer.participantId === data.participantId) n.activeTimer = null;
    return touch(n, now);
  }
  function addEffort(s, data, now) {
    assert(!isClosed(s), 'This pilot is closed.');
    const n = clone(s);
    n.effort.push({ id: nextId(n.effort, 'E'), recordedAt: iso(now),
      person: data.person, hours: data.hours, note: data.note || '' });
    assert(data.person.trim(), 'Name the role or pseudonym logging team effort.');
    return touch(n, now);
  }
  function startTimer(s, participantId, now) {
    assert(s.startedAt && !isClosed(s), 'Start an open pilot before timing an invitation.');
    assert(s.activeTimer === null, 'Finish or discard the current timer first.');
    assert(cohort(s).includes(participantId), 'Choose a cohort participant.');
    const n = clone(s);
    n.activeTimer = { participantId: participantId, openedAt: iso(now), stoppedAt: null };
    return touch(n, now);
  }
  function stopTimer(s, now) {
    assert(s.activeTimer && !s.activeTimer.stoppedAt, 'No running timer.');
    const n = clone(s); n.activeTimer.stoppedAt = iso(now); return touch(n, now);
  }
  function discardTimer(s, now) { const n = clone(s); n.activeTimer = null; return touch(n, now); }
  function timerSeconds(s, now) {
    if (!s.activeTimer) return null;
    return Math.max(0, Math.round((Date.parse(s.activeTimer.stoppedAt || iso(now)) - Date.parse(s.activeTimer.openedAt)) / 1000));
  }
  function firstAttempts(s) {
    const sorted = s.attempts.slice().sort(function (a, b) {
      return Date.parse(a.openedAt) - Date.parse(b.openedAt) ||
        Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a.id.localeCompare(b.id);
    });
    const byParticipant = new Map();
    sorted.forEach(function (a) { if (!byParticipant.has(a.participantId)) byParticipant.set(a.participantId, a); });
    return byParticipant;
  }
  function backed(a) { return a.evidenceStatus === 'accepted' && ['receipt_checked', 'observed'].includes(a.evidence); }
  function qualifies(a, p) {
    return a.outcome === 'recorded' && backed(a) && !a.assisted &&
      a.durationSeconds !== null && a.durationSeconds <= p.maxMinutes * 60;
  }
  function conclusive(a) {
    if (a.evidenceStatus === 'disputed' || a.evidence === 'unknown' || a.outcome === 'unknown') return false;
    if (a.outcome !== 'recorded') return true;
    return backed(a) && a.durationSeconds !== null;
  }
  function fingerprint(s) {
    const raw = JSON.stringify([s.startedAt, s.versions, s.attempts, s.effort]);
    let h = 2166136261;
    for (let i = 0; i < raw.length; i++) h = Math.imul(h ^ raw.charCodeAt(i), 16777619);
    return 'checkpoint-' + (h >>> 0).toString(16).padStart(8, '0');
  }
  function evaluate(s, now) {
    const p = baselineProtocol(s), first = firstAttempts(s);
    const primary = cohort(s).map(function (id) { return first.get(id); }).filter(Boolean);
    const successes = primary.filter(function (a) { return qualifies(a, p); }).length;
    const resolved = primary.filter(conclusive).length;
    const verifiedBallots = primary.filter(function (a) { return a.outcome === 'recorded' && backed(a); }).length;
    const reportedBallots = primary.filter(function (a) { return a.outcome === 'recorded' && !backed(a); }).length;
    const assisted = primary.filter(function (a) { return a.assisted; }).length;
    const withdrawals = primary.filter(function (a) { return a.outcome === 'withdrawn'; }).length;
    const missing = p.cohortSize - primary.length;
    const unknown = primary.length - resolved;
    const teamHours = s.effort.reduce(function (sum, e) { return sum + e.hours; }, 0);
    const blockers = STEPS.filter(function (x) { return x[0] !== 'none'; }).map(function (step) {
      const affected = new Set(s.attempts.filter(function (a) {
        return a.blocker === step[0] && a.evidenceStatus === 'accepted' && a.evidence !== 'unknown';
      }).map(function (a) { return a.participantId; }));
      return { step: step[0], label: step[1], count: affected.size, participants: Array.from(affected).sort() };
    });
    const deadline = s.startedAt ? iso(Date.parse(s.startedAt) + p.durationDays * 86400000) : null;
    const due = !!deadline && Date.parse(iso(now)) >= Date.parse(deadline);
    const targetAssessable = !!s.startedAt && (due || resolved === p.cohortSize);
    const triggers = [];
    blockers.forEach(function (b) {
      if (b.step !== 'other' && b.count >= p.blockerThreshold)
        triggers.push({ code: 'blocker:' + b.step, title: b.label + ' needs review',
          detail: b.count + ' distinct participants reported this step (' + b.participants.join(', ') + '). Repeated attempts count once.' });
    });
    if (teamHours >= p.effortCapHours)
      triggers.push({ code: 'effort', title: 'Team effort cap reached',
        detail: formatNumber(teamHours) + ' of ' + p.effortCapHours + ' team hours used. Further trial work needs human authorization.' });
    if (due) triggers.push({ code: 'date', title: 'Scheduled review is due',
      detail: p.durationDays + ' days from the agreed start, on ' + deadline + '.' });
    if (targetAssessable && successes < p.successTarget)
      triggers.push({ code: 'target', title: 'Completion target not demonstrated',
        detail: successes + '/' + p.cohortSize + ' qualifying first attempts; target ' + p.successTarget + '. ' +
          missing + ' missing and ' + unknown + ' unresolved first-attempt outcomes remain visible.' });
    const latestReview = s.reviews[s.reviews.length - 1] || null;
    const nextReviewDue = !!latestReview && !!latestReview.nextReviewAt &&
      Date.parse(iso(now)) >= Date.parse(latestReview.nextReviewAt);
    if (nextReviewDue) triggers.push({ code: 'next_date', title: 'Linked next-action review is due',
      detail: 'The latest human decision set a further review on ' + latestReview.nextReviewAt + '.' });
    const dateAfterReview = !!latestReview && due && Date.parse(latestReview.recordedAt) < Date.parse(deadline);
    const reviewCurrent = !!latestReview && latestReview.evidenceFingerprint === fingerprint(s) &&
      !dateAfterReview && !nextReviewDue;
    const status = isClosed(s) ? 'Closed' : reviewCurrent ? 'Review recorded' :
      triggers.length ? 'Review required' : s.startedAt ? 'Collecting' : 'Draft';
    return { p: p, first: first, primary: primary, successes: successes, resolved: resolved,
      verifiedBallots: verifiedBallots, reportedBallots: reportedBallots, assisted: assisted,
      withdrawals: withdrawals, missing: missing, unknown: unknown, retries: s.attempts.length - primary.length,
      teamHours: teamHours, blockers: blockers, deadline: deadline, due: due, triggers: triggers,
      targetAssessable: targetAssessable, status: status, latestReview: latestReview, reviewCurrent: reviewCurrent };
  }
  function recordReview(s, data, now) {
    assert(s.startedAt || s.effort.length, 'Start a pilot or record preparation effort before a review.');
    assert(!isClosed(s), 'This pilot already has a closure record.');
    assert(data.reviewer.trim() && data.reason.trim() && data.reference.trim(), 'A review needs a reviewer, reason and decision reference.');
    assert(!s.activeTimer, 'Finish or discard the timer before recording a review.');
    assert(['continue', 'amend', 'complete', 'stop'].includes(data.outcome), 'Choose a review outcome.');
    if (['continue', 'amend'].includes(data.outcome)) {
      assert(data.nextAction.trim() && data.additionalHours > 0 && data.nextReviewAt,
        'Continuation needs a bounded next action, additional effort allowance and next review date.');
      assert(Date.parse(data.nextReviewAt) > Date.parse(iso(now)), 'The next review must be in the future.');
    }
    const e = evaluate(s, now), n = clone(s);
    n.reviews.push({ id: nextId(n.reviews, 'R'), recordedAt: iso(now), protocolVersion: n.activeVersionId,
      reviewer: data.reviewer, outcome: data.outcome, reason: data.reason, reference: data.reference,
      nextAction: data.nextAction || '', nextReviewAt: data.nextReviewAt || null,
      additionalHours: data.additionalHours || 0, evidenceFingerprint: fingerprint(s),
      snapshot: { successes: e.successes, cohort: e.p.cohortSize, missing: e.missing, unknown: e.unknown,
        attempts: s.attempts.length, teamHours: e.teamHours, triggers: e.triggers.map(function (x) { return x.code; }) } });
    return touch(n, now);
  }
  function formatNumber(n) { return Number(n.toFixed(2)).toString(); }
  function duration(n) { return n === null ? 'Unknown' : Math.floor(n / 60) + ':' + String(Math.round(n % 60)).padStart(2, '0'); }
  function md(x) { return String(x).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'); }
  function protocolMarkdown(p, blank) {
    const value = function (v) { return v.trim() ? v : '[fill by team agreement]'; };
    const lines = ['# RhoGov Pilot — ' + (blank ? 'Blank experiment template' : 'Agreed protocol'), '',
      'Linked proposal: ' + SOURCES.proposal, '',
      '## Action and agreement', ''];
    TEXT_FIELDS.forEach(function (k) { lines.push('**' + FIELD_LABELS[k] + ':** ' + value(p[k]), ''); });
    lines.push('**Decision / proposal link:** ' + value(p.decisionUrl), '',
      '**Participant invitation:** ' + value(p.inviteUrl), '',
      '**Agreed start (UTC):** [record when the team agrees; issue creation is not the start]', '',
      '**Recording agreement:** [record informed consent and the audience for raw attempt logs]', '',
      '**Public ballot visibility explained:** [yes / pending]', '',
      '## Preregistered assessment', '',
      '- Cohort: ' + p.cohortSize + ' consenting newcomers; pseudonyms P01 onward.',
      '- Completion target: ' + p.successTarget + '/' + p.cohortSize + ' evidence-backed valid ballots, without individual assistance, within ' + p.maxMinutes + ' minutes.',
      '- Primary attempt: earliest invitation-open timestamp for each participant; recorded time, then attempt ID break ties. Keep all retries.',
      '- Time includes identity, funding, eligibility and waiting from the invitation opening.',
      '- Review if at least ' + p.blockerThreshold + ' distinct participants encounter the same named blocking step.',
      '- Effort cap: ' + p.effortCapHours + ' total team hours, including recruitment, preparation and review.',
      '- Review date: ' + p.durationDays + ' days after the agreed start.',
      '- Missing, self-reported and disputed evidence remain explicit. They do not count as demonstrated success.',
      '- Target shortfall is assessed when all primary outcomes are resolved or the scheduled review is due; an incomplete cohort is not an early failure.',
      '', '## Human review', '',
      '**Reviewer and approval method:** [agree before the pilot]', '',
      '**Outcome:** [continue / amend / complete / stop]', '',
      '**Reason and decision reference:** [link to the actual review decision]', '',
      '**If continuing:** [bounded next action, additional hours, next review date]', '',
      '## EIES2 connection', '',
      'Jim Whitescarver co-authored EIES 2: A Distributed Architecture for Supporting Group Work (1992). This kit applies the abstract’s ideas of incremental development, interoperable protocols, and research alongside operational use: one versioned JSON decision record, one real low-impact task, one review.',
      'Source basis is the published abstract and NJIT catalog record, not the full report: ' + SOURCES.eies,
      '', 'The monitor is advisory. It neither casts ballots nor enforces chain permissions. Checked receipts and observed ballots need the team’s chosen network and finality rule.', '');
    return lines.join('\n');
  }
  function reportMarkdown(s, now) {
    validate(s);
    const e = evaluate(s, now), p = activeProtocol(s);
    const title = s.mode === 'demo' ? 'DEMO — SYNTHETIC DATA — RhoGov pilot report' : 'RhoGov pilot report';
    const lines = ['# ' + title, ''];
    if (s.mode === 'demo') lines.push('> DEMO ONLY. Every participant, timestamp, role, observation and review in this file is synthetic. This is not a completed human trial and supplies no evidence of RhoGov performance.', '');
    lines.push('**Pilot:** ' + md(p.title), '**ID:** ' + s.id, '**Generated (UTC):** ' + iso(now),
      '**Mode:** ' + s.mode, '**Status:** ' + e.status, '**Proposal:** ' + SOURCES.proposal,
      '**Agreed start:** ' + (s.startedAt || 'Not agreed / not started'),
      '**Scheduled review:** ' + (e.deadline || 'Not scheduled'), '',
      '## Evidence summary', '',
      '| Measure | Recorded value |', '|---|---|',
      '| Qualifying first attempts | ' + e.successes + '/' + e.p.cohortSize + ' (target ' + e.p.successTarget + ') |',
      '| Evidence-backed ballots on first attempts | ' + e.verifiedBallots + ' |',
      '| Ballots reported without accepted supporting evidence | ' + e.reportedBallots + ' |',
      '| Assisted first attempts | ' + e.assisted + ' |',
      '| Withdrawals on first attempts | ' + e.withdrawals + ' |',
      '| No first-attempt record | ' + e.missing + ' |',
      '| Unresolved first-attempt evidence | ' + e.unknown + ' |',
      '| Retained retries | ' + e.retries + ' |',
      '| Total team effort | ' + formatNumber(e.teamHours) + ' / ' + e.p.effortCapHours + ' hours |', '',
      e.targetAssessable ? 'The target is assessable at this checkpoint. A shortfall means the criterion is not demonstrated; it does not identify a single cause.' :
        'The completion target is still collecting evidence. Pending participants are not classified as failed attempts.',
      '', '## Review conditions observed', '');
    if (!e.triggers.length) lines.push('No configured review condition has been observed at this checkpoint.');
    else e.triggers.forEach(function (t) { lines.push('- **' + t.title + ':** ' + t.detail); });
    lines.push('', '## Named blockers', '', '| Step | Distinct participants | IDs |', '|---|---:|---|');
    e.blockers.filter(function (b) { return b.count > 0; }).forEach(function (b) {
      lines.push('| ' + b.label + ' | ' + b.count + ' | ' + b.participants.join(', ') + ' |');
    });
    if (!e.blockers.some(function (b) { return b.count > 0; })) lines.push('| None reported with known, accepted evidence | 0 | — |');
    lines.push('', '“Other” notes are reviewed manually; unrelated notes do not automatically constitute the same blocking step.', '',
      '## Cohort and primary attempts', '',
      '| Participant | Primary attempt | Outcome | Time m:ss | Assisted | Evidence | Qualifies |', '|---|---|---|---|---|---|---|');
    cohort(s).forEach(function (id) {
      const a = e.first.get(id);
      lines.push(a ? '| ' + id + ' | ' + a.id + ' | ' + a.outcome + ' | ' + duration(a.durationSeconds) + ' | ' +
        (a.assisted ? 'Yes' : 'No') + ' | ' + a.evidence + ' / ' + a.evidenceStatus + ' | ' +
        (qualifies(a, e.p) ? 'Yes' : 'Not demonstrated') + ' |' : '| ' + id + ' | — | No record | Unknown | Unknown | Missing | Pending |');
    });
    lines.push('', '## All retained attempts', '',
      '| ID / version | Participant | Invitation opened UTC | Seconds | Outcome | Assistance | Blocker | Evidence | Receipt link | Note |',
      '|---|---|---|---:|---|---|---|---|---|---|');
    s.attempts.forEach(function (a) {
      lines.push('| ' + a.id + ' / ' + a.protocolVersion + ' | ' + a.participantId + ' | ' + a.openedAt + ' | ' +
        (a.durationSeconds === null ? 'Unknown' : a.durationSeconds) + ' | ' + a.outcome + ' | ' + (a.assisted ? 'Yes' : 'No') +
        ' | ' + a.blocker + ' | ' + a.evidence + ' / ' + a.evidenceStatus + ' | ' + md(a.receiptUrl || '—') + ' | ' + md(a.note || '—') + ' |');
    });
    if (!s.attempts.length) lines.push('| No attempt data yet | | | | | | | | | |');
    lines.push('', '## Team effort ledger', '', '| ID | Role / pseudonym | Hours | Note |', '|---|---|---:|---|');
    s.effort.forEach(function (x) { lines.push('| ' + x.id + ' | ' + md(x.person) + ' | ' + formatNumber(x.hours) + ' | ' + md(x.note) + ' |'); });
    lines.push('', '## Protocol history', '');
    if (!s.versions.length) lines.push('Draft only. No approval or agreed start is claimed.');
    s.versions.forEach(function (v) {
      lines.push('### ' + v.id + (v.previous ? ' (amends ' + v.previous + ')' : ' (baseline)'), '',
        '**Frozen:** ' + v.lockedAt, '**Reason:** ' + md(v.reason), '**Authorization reference:** ' + md(v.authorization), '');
      TEXT_FIELDS.forEach(function (k) { lines.push('**' + FIELD_LABELS[k] + ':** ' + md(v.protocol[k] || '—')); });
      lines.push('**Invitation:** ' + (v.protocol.inviteUrl || '—'), '**Decision:** ' + (v.protocol.decisionUrl || '—'), '');
    });
    lines.push('Baseline assessment stays fixed: ' + e.p.successTarget + '/' + e.p.cohortSize + ', ' + e.p.maxMinutes + ' minutes, ' +
      e.p.blockerThreshold + ' participants per named blocker, ' + e.p.effortCapHours + ' hours, ' + e.p.durationDays + ' days.', '',
      '## Human review records', '');
    if (!s.reviews.length) lines.push('No human continuation, amendment or closure decision has been recorded.');
    s.reviews.forEach(function (r) {
      lines.push('### ' + r.id + ' — ' + r.outcome, '', '**Time:** ' + r.recordedAt,
        '**Reviewer:** ' + md(r.reviewer), '**Decision reference:** ' + md(r.reference), '**Reason:** ' + md(r.reason),
        '**Evidence checkpoint:** ' + r.evidenceFingerprint + ' (' + r.snapshot.attempts + ' attempts; ' + formatNumber(r.snapshot.teamHours) + ' hours)',
        '**Next action:** ' + md(r.nextAction || 'None recorded'), '**Additional effort authorized:** ' + r.additionalHours + ' hours',
        '**Next review:** ' + (r.nextReviewAt || 'None recorded'), '');
    });
    if (s.reviews.length && !e.reviewCurrent) lines.push('Evidence has changed since the latest human review; that review applies to its recorded checkpoint.', '');
    lines.push('## Interpretation and architecture', '',
      'This is a small feasibility pilot, not evidence that collective intelligence has improved. Timings and evidence labels are facilitator-entered and are not independently attested. “Observed” means the facilitator reported seeing a recorded ballot; “receipt_checked” means the facilitator reported checking the linked receipt against the agreed network. Neither label automatically proves chain finality.',
      'Review signals are advisory. The kit does not submit chain actions, connect a wallet, stop a contract, or enforce future authorization. A review record preserves the human decision and its limits.',
      'The original record stays visible while future action can be reconsidered. Protocol amendments append a linked version; repeated attempts never replace the original assessment. Local JSON backups support an explicit future adapter to Quantum-OS without claiming existing integration.',
      '', '## EIES2 grounding', '',
      'James Whitescarver co-authored EIES 2: A Distributed Architecture for Supporting Group Work (1992). The published abstract describes an incremental, decentralized environment connecting research and operational use through interoperable application protocols. This kit applies those ideas through a versioned protocol, a useful real decision, and an evidence-to-review loop.',
      'Source basis: the published abstract and NJIT repository record, not the full report. ' + SOURCES.eies,
      '', '## References', '', '- Published proposal: ' + SOURCES.proposal,
      '- RhoGov guide: ' + SOURCES.guide, '- EIES2 (1992) repository record: ' + SOURCES.eies, '');
    return lines.join('\n');
  }
  function demoPilot() {
    let s = newPilot('demo', '2026-10-01T09:00:00.000Z'); s.id = 'pilot-DEMO-synthetic';
    Object.assign(s.draft, {
      title: 'DEMO · A newcomer’s first RhoGov decision',
      owner: 'DEMO pilot owner', evidenceLead: 'DEMO facilitator', reviewer: 'DEMO independent reviewer',
      network: 'DEMO playground — no real network activity',
      contracts: 'DEMO placeholders — replace with verified contract addresses',
      electorate: 'DEMO P01–P10; consent and voter-roll eligibility are simulated',
      dataAudience: 'DEMO synthetic data only. No real participant details.',
      approvalReference: 'DEMO synthetic agreement (not an authorization)',
      inviteUrl: SOURCES.guide, agreementConfirmed: true, visibilityConfirmed: true
    });
    s = startPilot(s, '2026-10-01T09:00:00.000Z');
    const times = [188, 244, 296, 201, 278, 180, 360, 410, 420, 250];
    for (let i = 0; i < 10; i++) {
      const opened = iso(Date.parse('2026-10-03T09:00:00.000Z') + i * 1800000);
      s = addAttempt(s, { participantId: 'P' + String(i + 1).padStart(2, '0'), openedAt: opened,
        durationSeconds: times[i], outcome: i < 6 || i === 9 ? 'recorded' : 'incomplete',
        assisted: i === 9, blocker: i >= 6 && i <= 8 ? 'faucet' : 'none',
        evidence: 'observed', evidenceStatus: 'accepted', receiptUrl: '', consentConfirmed: true,
        note: i === 9 ? 'DEMO: individual help was required; completion is assisted.' :
          i >= 6 ? 'DEMO: could not obtain test REV in the first attempt.' : 'DEMO: facilitator saw a recorded ballot. No real ballot exists.'
      }, iso(Date.parse(opened) + (times[i] + 60) * 1000));
    }
    s = addAttempt(s, { participantId: 'P07', openedAt: '2026-10-04T09:00:00.000Z', durationSeconds: 240,
      outcome: 'recorded', assisted: false, blocker: 'none', evidence: 'observed', evidenceStatus: 'accepted',
      receiptUrl: '', note: 'DEMO retry succeeds. The first attempt remains primary.', consentConfirmed: true
    }, '2026-10-04T09:05:00.000Z');
    s = addEffort(s, { person: 'DEMO planning', hours: 2, note: 'Agreement and recruitment' }, '2026-10-04T10:00:00.000Z');
    s = addEffort(s, { person: 'DEMO rehearsal', hours: 2, note: 'Invitation and voter eligibility rehearsal' }, '2026-10-04T10:00:00.000Z');
    s = addEffort(s, { person: 'DEMO facilitation', hours: 2.5, note: 'Attempt recording and review preparation' }, '2026-10-04T10:00:00.000Z');
    s = recordReview(s, { reviewer: 'DEMO independent reviewer', outcome: 'amend',
      reason: 'DEMO: 6/10 qualifying first attempts; P07–P09 share a faucet blocker. Fix the invitation and rehearse funding before wider invitations.',
      reference: 'DEMO synthetic review — no real team approval', nextAction: 'Rehearse a verified test-REV path and draft a clearer invitation.',
      nextReviewAt: '2026-10-14T09:00:00.000Z', additionalHours: 2
    }, '2026-10-05T09:00:00.000Z');
    return s;
  }
  return { SCHEMA: SCHEMA, STEPS: STEPS, OUTCOMES: OUTCOMES, EVIDENCE: EVIDENCE, SOURCES: SOURCES,
    TEXT_FIELDS: TEXT_FIELDS, FIELD_LABELS: FIELD_LABELS, RULE_FIELDS: RULE_FIELDS, clone: clone, iso: iso, safeUrl: safeUrl,
    newPilot: newPilot, defaultProtocol: defaultProtocol, validate: validate, validateProtocol: validateProtocol,
    readiness: readiness, cohort: cohort, activeProtocol: activeProtocol, baselineProtocol: baselineProtocol,
    parseImport: parseImport, saveDraft: saveDraft, startPilot: startPilot, amend: amend,
    addAttempt: addAttempt, addEffort: addEffort, recordReview: recordReview, isClosed: isClosed,
    startTimer: startTimer, stopTimer: stopTimer, discardTimer: discardTimer, timerSeconds: timerSeconds,
    firstAttempts: firstAttempts, qualifies: qualifies, evaluate: evaluate, fingerprint: fingerprint,
    duration: duration, formatNumber: formatNumber, protocolMarkdown: protocolMarkdown,
    reportMarkdown: reportMarkdown, demoPilot: demoPilot };
});
