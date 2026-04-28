// ============================================================================
// render/settings.js
// ----------------------------------------------------------------------------
// Renders the Settings page: numerical settings, task list, account list,
// active account selector, and the data-management block (export, import,
// wipe). All edits go through actions.
// ============================================================================

import { getState, getEvents } from '../state.js';
import * as actions from '../actions.js';
import { openSheet, closeSheet, showToast } from '../ui.js';
import { fmt, escapeHtml } from '../format.js';
import {
  DEFAULT_EARNING_MINIMUM,
  DEFAULT_MULTIPLIER_MINIMUM,
  DEFAULT_INCREMENT,
  DEFAULT_HABIT_THRESHOLD,
} from '../engine.js';

export function render() {
  const state = getState();
  const root = document.getElementById('settings-content');
  // Build a settings view from the engine's flat state. The engine doesn't
  // group settings under a `settings` key; for the form we conveniently
  // gather them into one object with sensible defaults for unset values.
  const s = {
    earningMinimum: state.earningMinimum ?? DEFAULT_EARNING_MINIMUM,
    multiplierMinimum: state.multiplierMinimum ?? DEFAULT_MULTIPLIER_MINIMUM,
    increment: state.increment ?? DEFAULT_INCREMENT,
    habitThreshold: state.habitThreshold ?? DEFAULT_HABIT_THRESHOLD,
  };

  const tasksHtml = Object.entries(state.tasks)
    .filter(([_, t]) => !t.archived)
    .sort((a, b) => {
      if (a[1].weight !== b[1].weight) return a[1].weight - b[1].weight;
      return a[1].name.localeCompare(b[1].name);
    })
    .map(([id, t]) => `
      <div class="item-row" data-edit-task="${id}">
        <span class="name">${escapeHtml(t.name)}</span>
        <span class="meta">${t.weight} ${t.weight === 1 ? 'pt' : 'pts'}</span>
      </div>
    `).join('');

  const liveAccounts = Object.entries(state.accounts).filter(([_, a]) => !a.archived);
  const accountOptions = liveAccounts.map(([id, a]) =>
    `<option value="${id}" ${id === state.activeAccountId ? 'selected' : ''}>${escapeHtml(a.name)}</option>`
  ).join('');

  const accountsHtml = liveAccounts.map(([id, a]) => `
    <div class="item-row" data-edit-account="${id}">
      <span class="name">${escapeHtml(a.name)}</span>
      <span class="meta">${id === state.activeAccountId ? 'active' : ''}</span>
    </div>
  `).join('');

  root.innerHTML = `
    <div class="settings-section">
      <div class="section-header"><h2>Numbers</h2></div>
      <div class="form-row">
        <div class="field-label">
          <span class="field-name">Maintenance threshold</span>
          <span class="field-hint">Below this, the day counts as skipped.</span>
        </div>
        <input type="number" min="1" step="1" value="${s.earningMinimum}" data-setting="earningMinimum" inputmode="numeric">
      </div>
      <div class="form-row">
        <div class="field-label">
          <span class="field-name">Compounding threshold</span>
          <span class="field-hint">At or above this from new-habit points, the day compounds.</span>
        </div>
        <input type="number" min="1" step="1" value="${s.multiplierMinimum}" data-setting="multiplierMinimum" inputmode="numeric">
      </div>
      <div class="form-row">
        <div class="field-label">
          <span class="field-name">Increment</span>
          <span class="field-hint">How much the multiplier grows per compounding day.</span>
        </div>
        <input type="number" min="0.001" step="0.001" value="${s.increment}" data-setting="increment" inputmode="decimal">
      </div>
      <div class="form-row">
        <div class="field-label">
          <span class="field-name">Habit threshold</span>
          <span class="field-hint">Ticks needed for a task to habituate.</span>
        </div>
        <input type="number" min="1" step="1" value="${s.habitThreshold}" data-setting="habitThreshold" inputmode="numeric">
      </div>
    </div>

    <div class="settings-section">
      <div class="section-header">
        <h2>Tasks</h2>
        <button class="btn-link" data-action="new-task">+ new task</button>
      </div>
      <div class="item-list">
        ${tasksHtml || '<p style="color: var(--paper-muted); font-size: 0.85rem; padding: 0.5rem 0;">No tasks yet.</p>'}
      </div>
    </div>

    <div class="settings-section">
      <div class="section-header">
        <h2>Accounts</h2>
        <button class="btn-link" data-action="new-account">+ new account</button>
      </div>
      <div class="form-row">
        <div class="field-label">
          <span class="field-name">Active account</span>
          <span class="field-hint">Where today's credits flow.</span>
        </div>
        <select id="set-active-account">${accountOptions}</select>
      </div>
      <div class="item-list">
        ${accountsHtml || '<p style="color: var(--paper-muted); font-size: 0.85rem; padding: 0.5rem 0;">No accounts yet.</p>'}
      </div>
    </div>

    <div class="dev-block">
      <span class="label-mini">Data</span>
      <p>Your data lives in this device's localStorage. Export to back up; import to restore.</p>
      <div class="dev-actions">
        <button class="btn" data-action="export-data">Export</button>
        <button class="btn" data-action="import-data">Import</button>
      </div>
      <div class="dev-actions">
        <button class="btn btn-danger" data-action="wipe">Wipe all</button>
      </div>
    </div>
    <input type="file" id="import-file-input" accept="application/json,.json" style="display:none">
  `;

  attachHandlers(root);
}

function attachHandlers(root) {
  // Numerical settings
  root.querySelectorAll('[data-setting]').forEach(el => {
    el.addEventListener('change', () => {
      const key = el.dataset.setting;
      const val = parseFloat(el.value);
      const state = getState();
      if (val > 0) {
        actions.setSettings({ [key]: val });
        const friendly = {
          earningMinimum: 'Maintenance threshold',
          multiplierMinimum: 'Compounding threshold',
          increment: 'Increment',
          habitThreshold: 'Habit threshold',
        }[key] || key;
        showToast(`${friendly} updated`);
      } else {
        showToast('Must be positive', true);
        // Revert input to current engine value
        const fallback = {
          earningMinimum: state.earningMinimum ?? DEFAULT_EARNING_MINIMUM,
          multiplierMinimum: state.multiplierMinimum ?? DEFAULT_MULTIPLIER_MINIMUM,
          increment: state.increment ?? DEFAULT_INCREMENT,
          habitThreshold: state.habitThreshold ?? DEFAULT_HABIT_THRESHOLD,
        };
        el.value = fallback[key];
      }
    });
  });

  // Active account picker
  const sel = root.querySelector('#set-active-account');
  if (sel) {
    sel.addEventListener('change', () => {
      actions.setActiveAccount(sel.value);
      const state = getState();
      showToast(`Active: ${state.accounts[sel.value].name}`);
    });
  }

  // Edit task / edit account rows
  root.querySelectorAll('[data-edit-task]').forEach(el => {
    el.addEventListener('click', () => openEditTaskSheet(el.dataset.editTask));
  });
  root.querySelectorAll('[data-edit-account]').forEach(el => {
    el.addEventListener('click', () => openEditAccountSheet(el.dataset.editAccount));
  });

  // Action buttons
  root.querySelectorAll('[data-action]').forEach(el => {
    const action = el.dataset.action;
    el.addEventListener('click', () => {
      switch (action) {
        case 'new-task':       openNewTaskSheet(); break;
        case 'new-account':    openNewAccountSheet(); break;
        case 'export-data':    handleExportData(); break;
        case 'import-data':    handleImportData(); break;
        case 'wipe':           handleWipe(); break;
      }
    });
  });
}

// =====================================================================
// Sheets
// =====================================================================

function openNewTaskSheet() {
  openSheet(`
    <div class="sheet-title">New task</div>
    <div class="sheet-form">
      <div class="form-row"><span class="field-name">Name</span><input type="text" id="new-name" placeholder="e.g. Walk 30 minutes"></div>
      <div class="form-row"><span class="field-name">Weight</span><input type="number" id="new-weight" min="1" value="1" inputmode="numeric"></div>
    </div>
    <div class="sheet-actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-primary" data-act="confirm">Add</button>
    </div>
  `);
  document.querySelector('[data-act="cancel"]').addEventListener('click', closeSheet);
  document.querySelector('[data-act="confirm"]').addEventListener('click', () => {
    const name = document.getElementById('new-name').value.trim();
    const weight = parseInt(document.getElementById('new-weight').value);
    if (!name || !weight || weight <= 0) return showToast('Name and positive weight required', true);
    actions.createTask(name, weight);
    closeSheet();
    showToast(`Added: ${name}`);
  });
  setTimeout(() => document.getElementById('new-name')?.focus(), 100);
}

function openEditTaskSheet(taskId) {
  const state = getState();
  const t = state.tasks[taskId];
  if (!t) return;
  const habituationLine = t.habituatedAt
    ? `<p style="font-size: 0.78rem; color: var(--green); margin: 0.25rem 0 0.5rem;">✓ Habituated</p>`
    : `<p style="font-size: 0.78rem; color: var(--paper-muted); margin: 0.25rem 0 0.5rem;">${t.tickCount} / ${state.habitThreshold ?? DEFAULT_HABIT_THRESHOLD} ticks toward habituation</p>`;
  openSheet(`
    <div class="sheet-title">Edit task</div>
    <div class="sheet-form">
      <div class="form-row"><span class="field-name">Name</span><input type="text" id="edit-name" value="${escapeHtml(t.name)}"></div>
      <div class="form-row"><span class="field-name">Weight</span><input type="number" id="edit-weight" min="1" value="${t.weight}" inputmode="numeric"></div>
    </div>
    ${habituationLine}
    <div class="sheet-actions">
      <button class="btn btn-danger" data-act="archive">Archive</button>
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-primary" data-act="save">Save</button>
    </div>
  `);
  document.querySelector('[data-act="cancel"]').addEventListener('click', closeSheet);
  document.querySelector('[data-act="archive"]').addEventListener('click', () => {
    if (!confirm('Archive this task? It stops appearing in your task list, but its history is preserved.')) return;
    actions.archiveTask(taskId);
    closeSheet();
    showToast('Task archived');
  });
  document.querySelector('[data-act="save"]').addEventListener('click', () => {
    const name = document.getElementById('edit-name').value.trim();
    const weight = parseInt(document.getElementById('edit-weight').value);
    if (!name || !weight || weight <= 0) return showToast('Name and positive weight required', true);
    actions.editTask(taskId, { name, weight });
    closeSheet();
    showToast('Task updated');
  });
}

function openNewAccountSheet() {
  openSheet(`
    <div class="sheet-title">New account</div>
    <div class="sheet-form">
      <div class="form-row"><span class="field-name">Name</span><input type="text" id="new-acc-name" placeholder="e.g. Ashen Wind"></div>
    </div>
    <div class="sheet-actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-primary" data-act="confirm">Add</button>
    </div>
  `);
  document.querySelector('[data-act="cancel"]').addEventListener('click', closeSheet);
  document.querySelector('[data-act="confirm"]').addEventListener('click', () => {
    const name = document.getElementById('new-acc-name').value.trim();
    if (!name) return showToast('Name required', true);
    actions.createAccount(name);
    closeSheet();
    showToast(`Added: ${name}`);
  });
  setTimeout(() => document.getElementById('new-acc-name')?.focus(), 100);
}

function openEditAccountSheet(accountId) {
  const state = getState();
  const a = state.accounts[accountId];
  if (!a) return;
  openSheet(`
    <div class="sheet-title">Edit account</div>
    <div class="sheet-form">
      <div class="form-row"><span class="field-name">Name</span><input type="text" id="edit-acc-name" value="${escapeHtml(a.name)}"></div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-danger" data-act="archive">Archive</button>
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-primary" data-act="save">Save</button>
    </div>
  `);
  document.querySelector('[data-act="cancel"]').addEventListener('click', closeSheet);
  document.querySelector('[data-act="archive"]').addEventListener('click', () => {
    // Precondition check via the action layer. archiveAccount returns
    // ok=false with a reason if the account is active or the only live one;
    // it doesn't append anything in those cases. If preconditions pass,
    // we prompt and call again to actually archive.
    if (state.activeAccountId === accountId) {
      showToast('This account is currently active. Switch to another account before archiving.', true);
      return;
    }
    const liveCount = Object.values(state.accounts).filter(x => !x.archived).length;
    if (liveCount <= 1) {
      showToast('Create another account first, then activate it, then you can archive this one.', true);
      return;
    }
    if (!confirm('Archive this account? It stops appearing in your account list, but its history is preserved.')) return;
    actions.archiveAccount(accountId);
    closeSheet();
    showToast('Account archived');
  });
  document.querySelector('[data-act="save"]').addEventListener('click', () => {
    const name = document.getElementById('edit-acc-name').value.trim();
    if (!name) return showToast('Name required', true);
    actions.editAccount(accountId, { name });
    closeSheet();
    showToast('Account updated');
  });
}

// =====================================================================
// Data actions (export, import, wipe)
// =====================================================================

function handleExportData() {
  const events = getEvents();
  const json = JSON.stringify(events, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const filename = `habits-export-${stamp}.json`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Release the blob URL on the next tick to avoid revoking it before the
  // browser's download stream kicks in.
  setTimeout(() => URL.revokeObjectURL(url), 0);

  showToast('Exported');
}

function handleImportData() {
  const input = document.getElementById('import-file-input');
  if (!input) return;
  // Reset value so picking the same file twice still triggers a change event.
  input.value = '';
  input.onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (err) {
        showToast('Invalid JSON file');
        return;
      }
      if (!Array.isArray(parsed)) {
        showToast('File does not contain an event list');
        return;
      }
      // Light shape check: every item should be an object with a `type` field.
      const looksValid = parsed.every(
        e => e && typeof e === 'object' && typeof e.type === 'string'
      );
      if (!looksValid) {
        showToast('File does not look like a habits export');
        return;
      }
      if (!confirm(`Replace current data with ${parsed.length} imported events?`)) return;
      actions.replaceAllEvents(parsed);
      showToast('Imported');
    };
    reader.onerror = () => showToast('Could not read file');
    reader.readAsText(file);
  };
  input.click();
}

function handleWipe() {
  if (!confirm('Erase all data and reset the app to a fresh-install state? This cannot be undone.')) return;
  actions.wipeAllData();
  showToast('All data wiped');
}
