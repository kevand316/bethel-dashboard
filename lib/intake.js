// lib/intake.js
// Controller for the Intake tab. Owns the three states the tab can be in:
//
//   1. GATE     — Google Drive is not connected, so there is nowhere to save.
//                 The form is not merely disabled, it is not rendered. An
//                 operator cannot begin typing a client's SSN into a form that
//                 has no destination.
//   2. LIST     — connected; shows the intakes in the operator's Drive folder.
//   3. FORM     — one intake open, autosaving to Drive on every change.
//
// Depends on lib/drive.js, lib/intake-autosave.js, lib/intake-form.js.
// Exposes window.intake.

(function () {
  const $ = (id) => document.getElementById(id);

  let allIntakes = []; // last list read from Drive
  let openFileId = null; // the intake currently on screen
  let openRecord = null; // its last known record
  let listFilter = "";

  // Values that belong to the record but have no input on the form — currently
  // just the intake date. readForm() only knows about fields, so without keeping
  // these aside every autosave would quietly strip them and the Drive file would
  // lose the date out of its name.
  let openMeta = {};

  // ── state switching ────────────────────────────────────────────────────────
  function show(which) {
    for (const pane of ["gate", "list", "form"]) {
      const el = $("intake-" + pane);
      if (el) el.classList.toggle("active", pane === which);
    }
  }

  function setNotice(text, kind) {
    const el = $("intake-notice");
    if (!el) return;
    el.textContent = text || "";
    el.className = "intake-notice" + (text ? " show " + (kind || "info") : "");
  }

  // ── gate ───────────────────────────────────────────────────────────────────
  function renderGate() {
    const configured = window.drive.isConfigured();
    const remembered = window.drive.getRemembered();

    $("intake-gate-unconfigured").style.display = configured ? "none" : "";
    $("intake-gate-connect").style.display = configured ? "" : "none";

    // Someone who has connected before, but whose Google session has lapsed,
    // gets "Reconnect <their email>" rather than a bare Connect button — so they
    // know which account this dashboard expects.
    const known = $("intake-known-account");
    connectButtonLabel();
    if (remembered?.email) {
      known.style.display = "";
      known.textContent = "Last connected as " + remembered.email;
    } else {
      known.style.display = "none";
    }
    show("gate");
  }

  function connectButtonLabel() {
    $("intake-connect-btn").textContent = window.drive.getRemembered()?.email
      ? "Reconnect Google Drive"
      : "Connect Google Drive";
  }

  async function connect() {
    const btn = $("intake-connect-btn");
    btn.disabled = true;
    btn.textContent = "Waiting for Google...";
    setNotice("");
    try {
      const account = await window.drive.connect();
      setNotice("");
      // Reconnecting from inside an open intake must leave the operator exactly
      // where they were. Sending them back to the list would make them find and
      // reopen the form they are already halfway through filling in.
      if (openFileId) {
        $("intake-account-email").textContent = account?.email || "";
        window.intakeSave.resumeAfterReconnect();
      } else {
        await enterList(account);
      }
    } catch (e) {
      setNotice(e.message || "Could not connect to Google Drive.", "error");
      // Same reasoning: a failed reconnect must not throw away the open form.
      if (!openFileId) renderGate();
    } finally {
      btn.disabled = false;
      // renderGate() would normally do this, but it is skipped while an intake
      // is open — leaving the gate button stuck on "Waiting for Google...".
      connectButtonLabel();
    }
  }

  async function disconnect() {
    // Unsaved work would have nowhere to go the moment the token is revoked, so
    // get it into Drive first and let the operator abort if it cannot be saved.
    if (window.intakeSave.hasUnsavedWork()) {
      await window.intakeSave.flush();
      if (window.intakeSave.hasUnsavedWork()) {
        setNotice(
          "There are unsaved changes that could not be saved. Disconnect cancelled.",
          "error"
        );
        return;
      }
    }
    window.intakeSave.detach();
    window.drive.disconnect();
    openFileId = null;
    openRecord = null;
    allIntakes = [];
    renderGate();
  }

  // ── list ───────────────────────────────────────────────────────────────────
  async function enterList(account) {
    const acct = account || window.drive.getAccount();
    $("intake-account-email").textContent = acct?.email || "";
    show("list");
    await refreshList();
  }

  async function refreshList() {
    const body = $("intake-list-body");
    body.innerHTML = '<div class="intake-empty">Loading from Google Drive...</div>';
    try {
      allIntakes = await window.drive.listIntakes();
      renderList();
    } catch (e) {
      if (e.code === "needs_reconnect") return renderGate();
      body.innerHTML = "";
      setNotice(e.message || "Could not read your Drive folder.", "error");
    }
  }

  function renderList() {
    const body = $("intake-list-body");
    const q = listFilter.trim().toLowerCase();
    const rows = q ? allIntakes.filter((r) => r.clientName.toLowerCase().includes(q)) : allIntakes;

    $("intake-count").textContent = allIntakes.length
      ? `${allIntakes.length} intake${allIntakes.length === 1 ? "" : "s"} in Google Drive`
      : "";

    if (!rows.length) {
      body.innerHTML = `<div class="intake-empty">${
        allIntakes.length
          ? "No intakes match that search."
          : "No intakes yet. Start one and it saves straight to your Google Drive."
      }</div>`;
      return;
    }

    body.innerHTML = rows
      .map(
        (r) => `
      <div class="intake-row" data-file-id="${r.fileId}">
        <div class="intake-row-main">
          <div class="intake-row-name">${escapeHtml(r.clientName)}</div>
          <div class="intake-row-meta">Last saved ${formatWhen(r.modifiedTime)}</div>
        </div>
        ${r.status ? `<span class="intake-status intake-status-${slug(r.status)}">${escapeHtml(r.status)}</span>` : ""}
        <button class="intake-row-open" data-action="open">Open</button>
        <button class="intake-row-del" data-action="delete" title="Move to Google Drive trash">✕</button>
      </div>
    `
      )
      .join("");
  }

  function slug(s) {
    return String(s)
      .toLowerCase()
      .replace(/[^a-z]+/g, "-");
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  function formatWhen(iso) {
    if (!iso) return "unknown";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "unknown";
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  // ── form ───────────────────────────────────────────────────────────────────
  function formContainer() {
    return $("intake-form-fields");
  }

  function currentRecord() {
    return { ...openMeta, ...window.intakeForm.readForm(formContainer()) };
  }

  function onStatus({ cls, text, detail, state }) {
    const el = $("intake-save-status");
    if (el) {
      el.textContent = text;
      el.className = "intake-save-status " + cls;
    }
    $("intake-conflict-bar").style.display = state === "conflict" ? "" : "none";
    $("intake-held-bar").style.display = state === "held" ? "" : "none";
    if (detail && (state === "error" || state === "held" || state === "conflict")) {
      setNotice(detail, state === "error" ? "error" : "warn");
    } else if (state === "saved") {
      setNotice("");
    }
  }

  async function openIntake(fileId) {
    setNotice("");
    try {
      const { record, version } = await window.drive.readIntake(fileId);
      openFileId = fileId;
      openRecord = record;
      // Intakes written before the date was recorded keep whatever they have;
      // there is nothing sensible to invent for them.
      openMeta = { intakeDate: record?.intakeDate || "" };
      mountForm(record);
      window.intakeSave.attach({ fileId, version, getRecord: currentRecord, onStatus });
      show("form");
    } catch (e) {
      if (e.code === "needs_reconnect") return renderGate();
      setNotice(e.message || "Could not open that intake.", "error");
    }
  }

  async function newIntake() {
    setNotice("");
    const record = window.intakeForm.blankRecord();
    // Stamp the intake date up front so the Drive file has a real name from the
    // first save, rather than a folder full of "Unnamed intake".
    record.intakeDate = new Date().toISOString().slice(0, 10);
    openMeta = { intakeDate: record.intakeDate };
    try {
      // Create in Drive immediately. An intake that exists only in the browser
      // is one closed tab away from being lost, and there is no local draft to
      // fall back on by design.
      const { fileId, version } = await window.drive.createIntake(record);
      openFileId = fileId;
      openRecord = record;
      mountForm(record);
      window.intakeSave.attach({ fileId, version, getRecord: currentRecord, onStatus });
      show("form");
      const first = formContainer().querySelector("input, select, textarea");
      if (first) first.focus();
    } catch (e) {
      if (e.code === "needs_reconnect") return renderGate();
      setNotice(e.message || "Could not start a new intake in Google Drive.", "error");
    }
  }

  function mountForm(record) {
    const container = formContainer();
    // Property names come from the operator's own Overview tab, so the Preferred
    // Home dropdown lists their homes rather than a hard-coded set of ours.
    // `homes` is a top-level `let` in index.html, which lives in the global
    // lexical scope — reachable as a bare identifier but NOT as window.homes.
    const list = typeof homes !== "undefined" && Array.isArray(homes) ? homes : [];
    window.intakeForm.renderForm(container, {
      homes: list.map((h) => h.name).filter(Boolean),
    });
    window.intakeForm.writeForm(container, record);
    $("intake-form-title").textContent = window.intakeForm.displayName(record);
    updateProgress();
  }

  async function closeIntake() {
    await window.intakeSave.flush();
    if (window.intakeSave.hasUnsavedWork()) {
      setNotice("Still trying to save. Stay on this page until it says SAVED TO DRIVE.", "warn");
      return;
    }
    window.intakeSave.detach();
    openFileId = null;
    openRecord = null;
    await enterList();
  }

  async function deleteIntake(fileId, clientName) {
    if (!confirmDelete(clientName)) return;
    try {
      await window.drive.trashIntake(fileId);
      setNotice(
        `${clientName} moved to your Google Drive trash — recoverable there for 30 days.`,
        "info"
      );
      await refreshList();
    } catch (e) {
      if (e.code === "needs_reconnect") return renderGate();
      setNotice(e.message || "Could not remove that intake.", "error");
    }
  }

  // Kept as a seam so tests can bypass the browser dialog.
  function confirmDelete(clientName) {
    return window.confirm(
      `Move "${clientName}" to your Google Drive trash?\n\n` +
        `It stays recoverable in Drive for 30 days.`
    );
  }

  // ── progress + live updates ────────────────────────────────────────────────
  function updateProgress() {
    const record = currentRecord();
    openRecord = record;

    const overall = window.intakeForm.requiredProgress(record);
    $("intake-progress-fill").style.width = overall.pct + "%";
    $("intake-progress-text").textContent =
      `${overall.done} of ${overall.total} required fields complete`;

    for (const s of window.intakeForm.sectionProgress(record)) {
      const badge = $("if-badge-" + s.key);
      if (!badge) continue;
      badge.textContent = s.complete ? "Complete" : `${s.done}/${s.total}`;
      badge.className = "if-section-badge" + (s.complete ? " complete" : "");
    }

    $("intake-form-title").textContent = window.intakeForm.displayName(record);
  }

  function onFormInput(e) {
    const el = e.target;
    if (!el.matches("[data-intake-field]")) return;
    if (el.dataset.format === "ssn") formatSsn(el);
    updateProgress();
    window.intakeSave.markDirty();
  }

  // Formats as the operator types, but never fights the caret: reformatting only
  // happens at the end of the value, which is where typing actually occurs.
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

  // ── printing ───────────────────────────────────────────────────────────────
  // Local device only. Nothing leaves the browser: this is the print dialog, so
  // the operator can hand someone a paper packet or keep their own PDF without
  // a second copy of the record being created anywhere we control.
  function printIntake() {
    const record = currentRecord();
    const stamp = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    $("intake-print-header").textContent =
      `${window.intakeForm.displayName(record)} · Intake Form · ${stamp}`;

    // Every section must be expanded, or collapsed ones print blank.
    formContainer()
      .querySelectorAll(".if-section")
      .forEach((s) => s.classList.remove("collapsed"));

    // The dashboard prints landscape, which suits wide tables and ruins a form.
    // @page cannot be scoped to a selector, so override it with a later rule for
    // the duration of this print and take it back out afterwards.
    const pageStyle = document.createElement("style");
    pageStyle.textContent = "@page { size: portrait; margin: 0.5in; }";
    document.head.appendChild(pageStyle);

    document.querySelectorAll(".view").forEach((v) => v.classList.remove("print-active"));
    $("view-intake").classList.add("print-active");
    document.body.classList.add("printing-intake");

    setTimeout(() => {
      window.print();
      window.addEventListener(
        "afterprint",
        () => {
          $("view-intake").classList.remove("print-active");
          document.body.classList.remove("printing-intake");
          pageStyle.remove();
        },
        { once: true }
      );
    }, 150);
  }

  // ── wiring ─────────────────────────────────────────────────────────────────
  function bind() {
    $("intake-connect-btn").addEventListener("click", connect);
    $("intake-disconnect-btn").addEventListener("click", disconnect);
    $("intake-new-btn").addEventListener("click", newIntake);
    $("intake-refresh-btn").addEventListener("click", refreshList);
    $("intake-back-btn").addEventListener("click", closeIntake);
    $("intake-print-btn").addEventListener("click", printIntake);
    $("intake-reconnect-btn").addEventListener("click", connect);
    $("intake-override-btn").addEventListener("click", () => {
      window.intakeSave.overrideConflict();
      $("intake-conflict-bar").style.display = "none";
    });
    $("intake-reload-btn").addEventListener("click", () => {
      if (openFileId) openIntake(openFileId);
    });

    $("intake-search").addEventListener("input", (e) => {
      listFilter = e.target.value;
      renderList();
    });

    $("intake-list-body").addEventListener("click", (e) => {
      const row = e.target.closest(".intake-row");
      if (!row) return;
      const action = e.target.closest("[data-action]")?.dataset.action;
      const fileId = row.dataset.fileId;
      const name = allIntakes.find((r) => r.fileId === fileId)?.clientName || "this intake";
      if (action === "delete") deleteIntake(fileId, name);
      else openIntake(fileId);
    });

    // One delegated listener covers every field, including ones re-rendered
    // when a different intake is opened.
    const form = formContainer();
    form.addEventListener("input", onFormInput);
    form.addEventListener("change", onFormInput);
    form.addEventListener("click", (e) => {
      const head = e.target.closest("[data-intake-toggle]");
      if (head) head.parentElement.classList.toggle("collapsed");
    });

    window.drive.onNeedsReconnect(() => {
      // Do not yank the operator out of a half-typed form. The held banner
      // appears above it; the gate is only for when nothing is open.
      if (!openFileId) renderGate();
    });
  }

  // ── entry point ────────────────────────────────────────────────────────────
  async function init(session) {
    bind();
    window.drive.init(session.user.id);
    if (!window.drive.isConfigured()) return renderGate();

    // Try to pick the Google connection back up without making them click.
    const account = await window.drive.resume();
    if (account) await enterList(account);
    else renderGate();
  }

  window.intake = {
    init,
    refreshList,
    openIntake,
    newIntake,
    closeIntake,
    printIntake,
    updateProgress,
    getOpenFileId: () => openFileId,
    _setConfirmDelete: (fn) => {
      confirmDelete = fn;
    },
  };
})();
