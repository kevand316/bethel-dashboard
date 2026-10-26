/** Main.gs: the 30-minute pipeline. Entry point: runPipeline (time trigger). */
const RUN_BUDGET_MS = 4.5 * 60 * 1000;     // Apps Script stops a run at 6 minutes
const OVERLAP_MS = 2 * 3600 * 1000;        // re-ask Vault for the last 2h each time; the log skips repeats

function runPipeline() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  const started = Date.now();
  try {
    const pendingId = P.getProperty('PENDING_EXPORT_ID');
    if (!pendingId) { startExport_(); return; }

    const exp = getExport_(pendingId);
    if (exp.status === 'IN_PROGRESS') return;
    if (exp.status !== 'COMPLETED') {
      clearExport_(pendingId);
      alert_('A Vault export did not complete (' + exp.status + '). The next run will try again.');
      return;
    }

    const calls = readExportCalls_(exp);
    const log = loadLog_();
    let finished = true;
    for (let i = 0; i < calls.length; i++) {
      if (log.isDone(calls[i].id)) continue;
      if (Date.now() - started > RUN_BUDGET_MS) { finished = false; break; }
      processCallSafely_(calls[i], log);
    }
    // Only move the window forward once every call in this export is handled.
    // Otherwise the next run picks up where this one stopped (same export).
    if (finished) {
      const end = new Date(P.getProperty('PENDING_EXPORT_END'));
      P.setProperty('WINDOW_START', new Date(end.getTime() - OVERLAP_MS).toISOString());
      clearExport_(pendingId);
    }
  } catch (e) {
    alert_('The call pipeline hit an error: ' + e.message);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function processCallSafely_(call, log) {
  const attempts = log.attempts(call.id) + 1;
  try {
    const result = processCall_(call);
    log.write(call, Object.assign({ status: 'done', attempts: attempts }, result));
    clearSteps_(call.id);
  } catch (e) {
    const giveUp = attempts >= 3;
    log.write(call, { status: giveUp ? 'failed' : 'retrying', attempts: attempts, error: String(e.message || e).slice(0, 500) });
    if (giveUp) alert_('A recorded call from ' + fmtTime_(call.when) + ' could not be processed after 3 tries. See the Calls Log.');
  }
}

function processCall_(call) {
  const ctx = {
    settings: readSettings_(),
    staff: readStaff_(),
    documents: readDocuments_(),
    rules: readRules_(),
  };
  const hb = hbCall_('open', {});                 // Drive pass + home names
  ctx.homes = hb.homes || [];
  ctx.staffName = (ctx.staff[(call.owner || '').toLowerCase()] || {}).name || call.owner || 'Staff';

  const ai = analyzeCall_(call, ctx);             // one Gemini call
  const out = { type: ai.callType, otherParty: partyLabel_(ai.otherParty), summary: ai.summary || '' };
  if (ai.callType === 'none') return out;

  if (ai.callType === 'intake') Object.assign(out, runIntake_(call, ai, ctx, hb));
  out.actions = runActions_(call, ai.actions || [], ctx);
  if (out.client || out.actions.length) sendCallSummary_(call, out, ctx);
  return out;
}

function partyLabel_(p) {
  p = p || {};
  return [p.name, p.organization].filter(Boolean).join(', ') || p.phone || '';
}
