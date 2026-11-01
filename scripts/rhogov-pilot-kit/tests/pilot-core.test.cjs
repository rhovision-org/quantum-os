const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/pilot-core.js');

const fixed = '2026-10-02T12:00:00.000Z';
const start = '2026-10-02T09:00:00.000Z';
const open = '2026-10-02T10:00:00.000Z';

function blankStarted() {
  const demo = C.demoPilot();
  const s = C.newPilot('live', start);
  s.draft = C.clone(demo.versions[0].protocol);
  s.draft.title = 'Local test pilot';
  s.draft.dataAudience = 'Facilitator and reviewer for 30 days';
  s.draft.approvalReference = 'test agreement reference';
  return C.startPilot(s, start);
}
function attempt(s, id, x, now) {
  return C.addAttempt(s, Object.assign({
    participantId: id, openedAt: open, durationSeconds: 200,
    outcome: 'recorded', assisted: false, blocker: 'none',
    evidence: 'observed', evidenceStatus: 'accepted',
    receiptUrl: '', note: '', consentConfirmed: true
  }, x || {}), now || fixed);
}

test('DEMO report is visibly synthetic and first retry cannot raise primary success', () => {
  const s = C.demoPilot();
  const e = C.evaluate(s, '2026-10-05T10:00:00.000Z');
  assert.equal(s.mode, 'demo');
  assert.equal(e.successes, 6);
  assert.equal(e.retries, 1);
  assert.equal(e.first.get('P07').id, 'A0007');
  assert.equal(e.first.get('P07').outcome, 'incomplete');
  assert.equal(e.blockers.find(x => x.step === 'faucet').count, 3);
  assert.match(C.reportMarkdown(s, '2026-10-05T10:00:00.000Z'), /DEMO — SYNTHETIC DATA/);
  assert.match(C.reportMarkdown(s, '2026-10-05T10:00:00.000Z'), /not a completed human trial/i);
});

test('an incomplete cohort remains collecting instead of becoming an early failure', () => {
  let s = blankStarted();
  for (const id of ['P01', 'P02', 'P03', 'P04']) {
    s = attempt(s, id, { outcome: 'incomplete', durationSeconds: 390, blocker: 'identity' });
  }
  const e = C.evaluate(s, fixed);
  assert.equal(e.successes, 0);
  assert.equal(e.missing, 6);
  assert.equal(e.targetAssessable, false);
  assert.equal(e.status, 'Review required');
  assert.ok(!e.triggers.some(x => x.code === 'target'));
  assert.ok(e.triggers.some(x => x.code === 'blocker:identity'));
});

test('only evidence-backed, unassisted first ballots within the limit qualify', () => {
  let s = blankStarted();
  for (let i = 1; i <= 10; i++) {
    s = attempt(s, 'P' + String(i).padStart(2, '0'), {
      assisted: i === 1, evidence: i === 2 ? 'self_report' : 'observed',
      outcome: i === 3 ? 'incomplete' : 'recorded',
      durationSeconds: i === 4 ? 301 : 200
    }, fixed);
  }
  const e = C.evaluate(s, '2026-10-16T09:00:00.000Z');
  assert.equal(e.successes, 6);
  assert.equal(e.resolved, 9);
  assert.equal(e.unknown, 1);
  assert.equal(e.targetAssessable, true);
  assert.ok(e.triggers.some(x => x.code === 'target'));
});

test('three distinct participants trigger a blocker; one participant retry counts once', () => {
  let s = blankStarted();
  s = attempt(s, 'P01', { outcome: 'incomplete', blocker: 'faucet' });
  s = attempt(s, 'P01', { outcome: 'incomplete', blocker: 'faucet', openedAt: '2026-10-02T10:15:00.000Z' });
  s = attempt(s, 'P02', { outcome: 'incomplete', blocker: 'faucet' });
  assert.equal(C.evaluate(s, fixed).blockers.find(x => x.step === 'faucet').count, 2);
  s = attempt(s, 'P03', { outcome: 'incomplete', blocker: 'faucet' });
  assert.ok(C.evaluate(s, fixed).triggers.some(x => x.code === 'blocker:faucet'));
});

test('start clock requires acknowledgements and effort cap triggers human review', () => {
  let s = C.newPilot('live', fixed);
  assert.throws(() => C.startPilot(s, fixed), /Complete the agreement/);
  s = blankStarted();
  s = C.addEffort(s, { person: 'reviewer', hours: 10, note: 'All trial work' }, fixed);
  const e = C.evaluate(s, fixed);
  assert.ok(e.triggers.some(x => x.code === 'effort'));
  assert.equal(e.deadline, '2026-10-16T09:00:00.000Z');
});

test('attempt cannot predates protocol start and checked receipt requires a link', () => {
  const s = blankStarted();
  assert.throws(() => attempt(s, 'P01', { openedAt: '2026-10-01T10:00:00.000Z' }), /predates/);
  assert.throws(() => attempt(s, 'P01', { evidence: 'receipt_checked' }), /need an evidence link/);
});

test('human continuation needs a real reference, bounded work, hours and a future review', () => {
  let s = blankStarted();
  const base = { reviewer: 'reviewer', outcome: 'continue', reason: 'rehearse a clearer invitation',
    reference: 'external decision #5', nextAction: 'One dry run', additionalHours: 2,
    nextReviewAt: '2026-10-10T10:00:00.000Z' };
  assert.throws(() => C.recordReview(s, Object.assign({}, base, { reference: '' }), fixed), /reference/);
  assert.throws(() => C.recordReview(s, Object.assign({}, base, { additionalHours: 0 }), fixed), /bounded next action/);
  s = C.recordReview(s, base, fixed);
  assert.equal(C.evaluate(s, fixed).status, 'Review recorded');
  assert.equal(C.evaluate(s, '2026-10-10T10:00:00.000Z').status, 'Review required');
  assert.ok(C.evaluate(s, '2026-10-10T10:00:00.000Z').triggers.some(x => x.code === 'next_date'));
});

test('evidence added after review makes its checkpoint stale without erasing it', () => {
  let s = blankStarted();
  s = C.recordReview(s, { reviewer: 'reviewer', outcome: 'amend', reason: 'rehearse',
    reference: 'decision #6', nextAction: 'One rehearsal', additionalHours: 2,
    nextReviewAt: '2026-10-10T10:00:00.000Z' }, fixed);
  s = attempt(s, 'P01', {}, fixed);
  assert.equal(s.reviews.length, 1);
  assert.equal(C.evaluate(s, fixed).reviewCurrent, false);
});

test('amendments are appended, keep the baseline immutable and preserve authorization', () => {
  let s = blankStarted();
  const next = C.clone(C.activeProtocol(s)); next.evidencePlan += ' Include local-accessibility note.';
  s = C.amend(s, next, 'Clarify what the reviewer can see.', 'external vote #7', fixed);
  assert.equal(s.versions.length, 2);
  assert.equal(s.versions[1].previous, 'V1');
  assert.equal(s.versions[1].authorization, 'external vote #7');
  const changedTarget = C.clone(C.activeProtocol(s)); changedTarget.successTarget = 6;
  assert.throws(() => C.amend(s, changedTarget, 'change goal', 'new vote', fixed), /original measurement rules/);
});

test('a blank JSON export round-trips; malformed and cross-schema backups fail before import', () => {
  const s = C.newPilot('live', fixed);
  const loaded = C.parseImport(JSON.stringify(s));
  assert.equal(loaded.mode, 'live');
  assert.equal(loaded.startedAt, null);
  assert.equal(loaded.attempts.length, 0);
  assert.throws(() => C.parseImport('{"schema":"wrong"}'), /Unsupported backup format/);
  assert.throws(() => C.parseImport('not json'), /not valid JSON/);
  assert.throws(() => C.parseImport('{"schema":"rhogov-pilot/1","mode":"live"}'), /Pilot ID must be text/);
  assert.throws(() => C.safeUrl('javascript:alert(1)'), /http\(s\)/);
});

test('timer persists its invitation-open time across reload and returns elapsed seconds', () => {
  let s = blankStarted();
  s = C.startTimer(s, 'P01', '2026-10-02T10:00:00.000Z');
  s = C.stopTimer(s, '2026-10-02T10:03:17.000Z');
  const recovered = C.parseImport(JSON.stringify(s));
  assert.equal(recovered.activeTimer.participantId, 'P01');
  assert.equal(C.timerSeconds(recovered), 197);
});

test('scheduled review after an earlier human review raises a fresh signal', () => {
  let s = blankStarted();
  s = C.recordReview(s, { reviewer: 'reviewer', outcome: 'continue', reason: 'continue after rehearsal',
    reference: 'decision #8', nextAction: 'Do one bounded rehearsal', additionalHours: 1,
    nextReviewAt: '2026-10-10T10:00:00.000Z' }, fixed);
  assert.equal(C.evaluate(s, fixed).status, 'Review recorded');
  assert.ok(C.evaluate(s, '2026-10-10T10:00:00.000Z').triggers.some(x => x.code === 'next_date'));
});
