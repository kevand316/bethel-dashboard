// lib/intake-link.js
// The texted intake link page (intake-link.html). Flow:
//   1. token from location.hash -> Edge Function intake-link {action:"open"}
//      -> short-lived Google Drive token + org name, homes, prefill
//   2. create (or, after a reload on this phone, reopen) the intake file in the
//      owner's Drive with lib/drive.js, and autosave with lib/intake-autosave.js
//   3. Submit -> final save, then {action:"complete"} so the link stops working
// The answers only ever go phone -> Google Drive.

(function () {
  const sb = window._supabase;
  const $ = (id) => document.getElementById(id);
  const token = decodeURIComponent((location.hash || "").replace(/^#/, ""));
  const fileKey = "houseboss.intakeLink." + token.slice(0, 16); // which Drive file this link started
  let meta = {};

  function notice(html) {
    $("ilNotice").innerHTML = html;
    $("ilNotice").hidden = false;
  }
  const expired = () => notice(`<h1>This link has expired</h1>Text <b>intake</b> to your organization's HouseBoss number for a new one.`);

  async function openToken() {
    if (!token) return null;
    const { data, error } = await sb.functions.invoke("intake-link", { body: { token, action: "open" } });
    if (error) {
      let code = "";
      try { code = (await error.context.json()).error; } catch (_) {}
      return { error: code || "network" };
    }
    window.drive.useToken(data.access_token, data.expires_in, { email: "" });
    return data;
  }

  const record = () => ({ ...meta, ...window.intakeForm.readForm($("ilFields")) });

  function progress() {
    const p = window.intakeForm.requiredProgress(record());
    $("ilProgress").style.width = p.pct + "%";
    $("ilMissing").hidden = true;
    $("ilSubmitAnyway").hidden = true;
  }

  function onStatus({ cls, text }) {
    $("ilStatus").textContent = text;
    $("ilStatus").className = "il-status intake-save-status " + cls;
  }

  function formatSsn(el) {
    const atEnd = el.selectionStart === el.value.length;
    const digits = el.value.replace(/\D/g, "").slice(0, 9);
    let out = digits;
    if (digits.length > 5) out = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
    else if (digits.length > 3) out = `${digits.slice(0, 3)}-${digits.slice(3)}`;
    if (out !== el.value) {
      el.value = out;
      if (atEnd) el.setSelectionRange(out.length, out.length);
    }
  }

  async function submit(force) {
    const missing = window.intakeForm.missingRequired(record());
    if (missing.length && !force) {
      $("ilMissing").textContent = `Still blank: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? `, and ${missing.length - 8} more` : ""}. Fill them in, or submit anyway.`;
      $("ilMissing").hidden = false;
      $("ilSubmitAnyway").hidden = false;
      return;
    }
    $("ilSubmit").disabled = true;
    window.intakeSave.markDirty();
    await window.intakeSave.flush();
    if (window.intakeSave.hasUnsavedWork()) {
      $("ilSubmit").disabled = false;
      $("ilMissing").textContent = "Not saved yet. Check your connection and press Submit again; nothing has been lost.";
      $("ilMissing").hidden = false;
      return;
    }
    await sb.functions.invoke("intake-link", { body: { token, action: "complete" } });
    window.intakeSave.detach();
    try { localStorage.removeItem(fileKey); } catch (_) {}
    $("ilForm").hidden = true;
    notice(`<h1>Submitted ✓</h1>The intake for <b>${window.intakeForm.displayName(record()).replace(/[<>&]/g, "")}</b> is saved to your organization's Google Drive. You can close this page.`);
  }

  async function start() {
    const opened = await openToken();
    if (!opened || opened.error === "expired") return expired();
    if (opened.error === "not_connected") {
      return notice(`<h1>Not available right now</h1>Your organization needs to turn texted intakes back on in HouseBoss.`);
    }
    if (opened.error) return notice(`<h1>Couldn't open the form</h1>Check your connection and reload this page.`);
    if (opened.org_name) $("ilOrg").textContent = `${opened.org_name} · Intake form`;

    // Token runs out after an hour: fetch a fresh one while the link is valid,
    // then let held saves continue. Nothing typed is lost meanwhile.
    window.drive.onNeedsReconnect(async () => {
      const again = await openToken();
      if (again && !again.error) window.intakeSave.resumeAfterReconnect();
    });

    let fileId = null;
    let revision = null;
    let rec = null;
    try { fileId = localStorage.getItem(fileKey); } catch (_) {}
    try {
      if (fileId) {
        const read = await window.drive.readIntake(fileId);
        rec = read.record;
        revision = read.revision;
      }
    } catch (_) { fileId = null; }
    if (!fileId) {
      rec = { ...window.intakeForm.blankRecord(), ...(opened.prefill || {}) };
      rec.intakeDate = new Date().toISOString().slice(0, 10);
      const created = await window.drive.createIntake(rec);
      fileId = created.fileId;
      revision = created.revision;
      try { localStorage.setItem(fileKey, fileId); } catch (_) {}
    }
    meta = { intakeDate: rec.intakeDate || "" };

    window.intakeForm.renderForm($("ilFields"), { homes: opened.homes || [] });
    window.intakeForm.writeForm($("ilFields"), rec);
    window.intakeSave.attach({ fileId, revision, getRecord: record, onStatus });
    $("ilNotice").hidden = true;
    $("ilForm").hidden = false;
    progress();
  }

  $("ilFields").addEventListener("input", (e) => {
    const el = e.target;
    if (!el.matches("[data-intake-field]")) return;
    if (el.dataset.format === "ssn") formatSsn(el);
    progress();
    window.intakeSave.markDirty();
  });
  $("ilFields").addEventListener("change", (e) => {
    if (e.target.matches("[data-intake-field]")) { progress(); window.intakeSave.markDirty(); }
  });
  // Section headers collapse and expand, as on the Intake tab.
  $("ilFields").addEventListener("click", (e) => {
    const head = e.target.closest("[data-intake-toggle]");
    if (head) head.closest(".if-section").classList.toggle("collapsed");
  });
  $("ilSubmit").addEventListener("click", () => submit(false));
  $("ilSubmitAnyway").addEventListener("click", () => submit(true));

  start().catch((e) => {
    console.warn("[intake-link]", e);
    notice(`<h1>Couldn't open the form</h1>${e && e.code === "drive_error" ? "Google Drive refused the request. " : ""}Check your connection and reload this page.`);
  });
})();
