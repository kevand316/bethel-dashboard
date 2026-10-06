// lib/ai-edit.js
// Edit with AI bar, top of every tab (plans/edit-with-ai.md). The user types a request; the ai-edit
// function returns proposed changes from a fixed set of types; this file checks them
// against the live roster, previews them in plain words, and on Apply hands the
// result to index.html's setHomes(), which saves through persistData() — the same
// autosave path as any typed edit. Nothing is saved anywhere else.
//
// Exposes window.aiEdit = { init(), applyChanges(homes, changes) }.

(function () {
  const sb = window._supabase;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const STATUS = { occupied: 'Occupied', recup: 'Recuperative Care', vacant: 'Vacant', manager: 'House Lead' };

  let history = [];    // { from: 'user' | 'assistant', text }
  let pending = null;  // { changes, lines } awaiting Apply
  let undo = null;     // { before, after } JSON of homes around the last Apply
  let busy = false;

  // ── Pure: apply changes to a copy of homes ─────────────────────────────────
  // Returns { homes, lines } or throws Error with a plain-language reason. Either
  // every change applies or none does.
  function applyChanges(source, changes) {
    if (!Array.isArray(changes) || !changes.length) throw new Error('There are no changes to apply.');
    const homes = JSON.parse(JSON.stringify(source));
    const lines = [];
    const removals = []; // beds are removed last so earlier bed numbers still mean what they meant

    const amountOf = (c, fallback) => {
      const v = c.amount == null ? fallback : Number(c.amount);
      if (!Number.isFinite(v) || v < 0 || v > 10_000_000) throw new Error(`"${c.amount}" isn't a usable dollar amount.`);
      return Math.round(v * 100) / 100;
    };
    const findHome = (c) => {
      let h = c.home_id != null ? homes.find((x) => Number(x.id) === Number(c.home_id)) : null;
      if (!h && c.home_name) h = homes.find((x) => norm(x.name) === norm(c.home_name));
      if (!h) throw new Error(`I couldn't find the home "${c.home_name || c.home_id}".`);
      if (!Array.isArray(h.expenses)) h.expenses = [];
      if (!Array.isArray(h.beds)) h.beds = [];
      return h;
    };
    const findExpense = (h, name) => {
      const e = h.expenses.find((x) => norm(x.name) === norm(name));
      if (!e) throw new Error(`${h.name} has no expense called "${name}".`);
      return e;
    };
    const findBed = (h, id) => {
      const b = h.beds.find((x) => Number(x.id) === Number(id));
      if (!b) throw new Error(`${h.name} has no bed ${id}.`);
      return b;
    };
    const addCat = (h, cat) => {
      if (!Array.isArray(h.catOrder)) h.catOrder = [];
      if (!h.catOrder.includes(cat)) h.catOrder.push(cat);
    };
    const count = (c) => {
      const n = c.count == null ? 1 : Number(c.count);
      if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error(`"${c.count}" isn't a usable number of beds.`);
      return n;
    };
    const text = (s, what) => {
      const v = String(s ?? '').trim();
      if (!v) throw new Error(`The ${what} is missing.`);
      return v.slice(0, 200);
    };
    // Same rule as the bed editor: a paying bed at $3,000+ is recuperative care.
    const fixStatus = (b) => {
      if (b.status === 'occupied' && b.rate >= 3000) b.status = 'recup';
      if (b.status === 'recup' && b.rate < 3000) b.status = 'occupied';
    };

    for (const c of changes) {
      switch (c && c.type) {
        case 'add_expense': {
          const h = findHome(c);
          const name = text(c.expense_name, 'expense name');
          const cat = String(c.category || '').trim().slice(0, 60) || 'Other';
          const amount = amountOf(c, 0);
          h.expenses.push({ cat, name, amount });
          addCat(h, cat);
          lines.push(`${h.name}: add expense ${name} (${cat}), ${money(amount)}/mo`);
          break;
        }
        case 'update_expense': {
          const h = findHome(c);
          const e = findExpense(h, c.expense_name);
          const was = `${e.name} ${money(e.amount)}`;
          if (c.amount != null) e.amount = amountOf(c);
          if (c.new_name) e.name = text(c.new_name, 'new name');
          if (c.category) { e.cat = String(c.category).trim().slice(0, 60); addCat(h, e.cat); }
          lines.push(`${h.name}: ${was} → ${e.name} ${money(e.amount)}/mo${c.category ? ` (${e.cat})` : ''}`);
          break;
        }
        case 'remove_expense': {
          const h = findHome(c);
          const e = findExpense(h, c.expense_name);
          h.expenses.splice(h.expenses.indexOf(e), 1);
          if (!h.expenses.some((x) => x.cat === e.cat) && Array.isArray(h.catOrder)) {
            h.catOrder = h.catOrder.filter((x) => x !== e.cat);
          }
          lines.push(`${h.name}: remove expense ${e.name} (${money(e.amount)}/mo)`);
          break;
        }
        case 'set_startup_cost': {
          const h = findHome(c);
          const was = h.startupCost || 0;
          h.startupCost = amountOf(c);
          lines.push(`${h.name}: startup cost ${money(was)} → ${money(h.startupCost)}`);
          break;
        }
        case 'add_home': {
          const name = text(c.home_name, 'home name');
          if (homes.some((x) => norm(x.name) === norm(name))) throw new Error(`There's already a home called "${name}".`);
          const n = count(c);
          const rate = amountOf(c, 850);
          const id = homes.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;
          homes.push({
            id, name, address: name, startupCost: 0, expenses: [], catOrder: [],
            beds: Array.from({ length: n }, (_, i) => ({ id: i + 1, status: 'vacant', name: '', rate, moveIn: '' })),
          });
          lines.push(`Add home ${name} with ${n} bed${n === 1 ? '' : 's'} at ${money(rate)}`);
          break;
        }
        case 'rename_home': {
          const h = findHome(c);
          const name = text(c.new_name, 'new name');
          lines.push(`Rename ${h.name} → ${name}`);
          h.name = name; h.address = name;
          break;
        }
        case 'add_beds': {
          const h = findHome(c);
          const n = count(c);
          const rate = amountOf(c, 850);
          for (let i = 0; i < n; i++) h.beds.push({ id: h.beds.length + 1, status: 'vacant', name: '', rate, moveIn: '' });
          lines.push(`${h.name}: add ${n} vacant bed${n === 1 ? '' : 's'} at ${money(rate)}`);
          break;
        }
        case 'update_bed': {
          const h = findHome(c);
          const b = findBed(h, c.bed_id);
          const parts = [];
          if (c.status != null) {
            if (!STATUS[c.status]) throw new Error(`"${c.status}" isn't a bed status.`);
            b.status = c.status; parts.push(STATUS[c.status]);
          }
          if (c.resident_name != null) {
            b.name = String(c.resident_name).trim().slice(0, 200);
            parts.push(b.name ? `resident ${b.name}` : 'no resident');
          }
          if (c.amount != null) { b.rate = amountOf(c); parts.push(`${money(b.rate)}/mo`); }
          if (c.move_in != null) {
            if (c.move_in && !/^\d{4}-\d{2}-\d{2}$/.test(c.move_in)) throw new Error(`"${c.move_in}" isn't a date.`);
            b.moveIn = c.move_in; parts.push(c.move_in ? `moved in ${c.move_in}` : 'no move-in date');
          }
          // Naming someone on a vacant bed is a move-in, not a name on an empty bed.
          if (c.status == null && b.status === 'vacant' && b.name) { b.status = 'occupied'; parts.unshift('Occupied'); }
          if (b.status === 'vacant') { b.name = ''; b.moveIn = ''; }
          if (!parts.length) throw new Error(`Nothing to change on ${h.name} bed ${b.id}.`);
          fixStatus(b);
          lines.push(`${h.name}, bed ${b.id}: ${parts.join(', ')}`);
          break;
        }
        case 'remove_bed': {
          const h = findHome(c);
          const b = findBed(h, c.bed_id);
          removals.push({ h, b });
          lines.push(`${h.name}: remove bed ${b.id}`);
          break;
        }
        default:
          throw new Error(`"${c && c.type}" isn't a change I can make.`);
      }
    }

    for (const { h, b } of removals) {
      if (b.status !== 'vacant' || String(b.name || '').trim()) {
        throw new Error(`${h.name} bed ${b.id} has ${b.name || 'someone'} in it. Move them out before removing the bed.`);
      }
      h.beds.splice(h.beds.indexOf(b), 1);
    }
    for (const { h } of removals) {
      if (!h.beds.length) throw new Error(`${h.name} would have no beds left. Every home needs at least one.`);
      h.beds.forEach((b, i) => { b.id = i + 1; });
    }
    return { homes, lines };
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    const log = $('aiLog');
    $('aiThread').hidden = !history.length;
    log.innerHTML = history.map((m) => `<div class="ai-msg ai-${m.from}">${esc(m.text)}</div>`).join('');
    const card = $('aiPreview');
    if (pending) {
      card.hidden = false;
      card.innerHTML = `<div class="ai-preview-title">${pending.lines.length} change${pending.lines.length === 1 ? '' : 's'} — nothing is saved until you press Apply</div>
        <ul class="ai-lines">${pending.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
        <div class="tm-row">
          <button class="btn btn-gold tm-btn" id="aiApply" type="button">Apply</button>
          <button class="btn btn-ghost tm-btn" id="aiCancel" type="button">Cancel</button>
        </div>`;
    } else if (undo) {
      card.hidden = false;
      card.innerHTML = `<div class="tm-row"><span class="ai-done">Applied ✓</span>
        <button class="btn btn-ghost tm-btn" id="aiUndo" type="button">Undo</button></div>`;
    } else {
      card.hidden = true;
      card.innerHTML = '';
    }
    $('aiSend').disabled = busy;
    $('aiSend').textContent = busy ? 'Thinking…' : 'Send';
    log.scrollTop = log.scrollHeight;
  }

  function say(from, text) { history.push({ from, text }); }

  async function send() {
    const input = $('aiInput');
    const message = input.value.trim();
    if (!message || busy) return;
    if (!window.isDataLoaded()) { say('assistant', 'Your dashboard is still loading. Try again in a moment.'); render(); return; }
    busy = true; pending = null; undo = null;
    say('user', message);
    input.value = '';
    render();
    try {
      const { data, error } = await sb.functions.invoke('ai-edit', {
        body: { message, history: history.slice(0, -1).slice(-10), homes: window.homes },
      });
      let res = data;
      if (error) {
        try { res = await error.context.json(); } catch (_) { res = null; }
        throw new Error(res?.error || "The AI didn't answer. Try again in a moment.");
      }
      if (res?.changes?.length) {
        try {
          const { lines } = applyChanges(window.homes, res.changes);
          pending = { changes: res.changes, lines };
          say('assistant', res.reply || 'Here is what I would change.');
        } catch (e) {
          say('assistant', `${res.reply ? res.reply + ' ' : ''}But I can't apply it: ${e.message}`);
        }
      } else {
        say('assistant', res?.reply || "I'm not sure what to change. Can you say it another way?");
      }
    } catch (e) {
      say('assistant', e.message);
    }
    busy = false;
    render();
  }

  function apply() {
    if (!pending) return;
    if (!window.isDataLoaded()) { say('assistant', 'Your dashboard is still loading. Try again in a moment.'); render(); return; }
    let result;
    // Re-run against the roster as it is NOW: it may have changed since the preview
    // (another device, a texted move-in), and those edits must not be lost.
    try { result = applyChanges(window.homes, pending.changes); } catch (e) {
      pending = null;
      say('assistant', `Something changed since I suggested that, so I stopped: ${e.message}`);
      render();
      return;
    }
    const before = JSON.stringify(window.homes);
    window.setHomes(result.homes);
    undo = { before, after: JSON.stringify(window.homes) };
    pending = null;
    say('assistant', `Done. ${result.lines.length} change${result.lines.length === 1 ? '' : 's'} saving now — watch the save light up top.`);
    render();
  }

  function undoLast() {
    if (!undo) return;
    if (JSON.stringify(window.homes) !== undo.after) {
      undo = null;
      say('assistant', "Things changed after that edit, so I won't undo it automatically — undoing could erase the newer change. Tell me what to put back.");
      render();
      return;
    }
    window.setHomes(JSON.parse(undo.before));
    undo = null;
    say('assistant', 'Undone. Everything is back the way it was.');
    render();
  }

  function wire() {
    $('aiSend').addEventListener('click', send);
    $('aiInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });
    $('aiPreview').addEventListener('click', (e) => {
      if (e.target.closest('#aiApply')) apply();
      else if (e.target.closest('#aiCancel')) { pending = null; say('assistant', 'Okay, nothing changed.'); render(); }
      else if (e.target.closest('#aiUndo')) undoLast();
    });
    // Folds the bar back to one line. A waiting preview is dropped (nothing was
    // saved); a finished Apply stays saved — Clear only forgets the conversation.
    $('aiClear').addEventListener('click', () => { history = []; pending = null; undo = null; render(); });
    render();
  }

  window.aiEdit = { init: wire, applyChanges };
})();
