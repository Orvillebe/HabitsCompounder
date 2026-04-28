// ============================================================================
// main.js
// ----------------------------------------------------------------------------
// Application entry point. Initializes state from storage, sets up hash
// routing between the three pages, registers the habituation notification
// handler, and exposes renderAll() for actions to call after they emit events.
// ============================================================================

import * as state from './state.js';
import * as actions from './actions.js';
import * as today from './render/today.js';
import * as earned from './render/earned.js';
import * as settings from './render/settings.js';
import { closeSheet, openSheet } from './ui.js';
import { habituationSheetHtml } from './render/habituation-content.js';
import {
  DEFAULT_EARNING_MINIMUM,
  DEFAULT_MULTIPLIER_MINIMUM,
  DEFAULT_INCREMENT,
  DEFAULT_HABIT_THRESHOLD,
} from './engine.js';

// Top-level render: dispatches to the active page's render function.
export function renderAll() {
  const hash = (location.hash || '#working').slice(1);
  showPage(hash);
}

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.navbar a').forEach(a => a.classList.remove('active'));

  const page = document.getElementById('page-' + name);
  const link = document.querySelector(`.navbar a[data-page="${name}"]`);
  if (page) page.classList.add('active');
  if (link) link.classList.add('active');

  switch (name) {
    case 'working':  today.render(); break;
    case 'balances': earned.render(); break;
    case 'settings': settings.render(); break;
    default:         today.render();
  }
}

// Habituation celebration sheet. Fired when one or more tasks just crossed
// the habituation threshold. Multiple at once are batched into one sheet.
//
// The sheet body and copy live in habituation-content.js so the same
// wording is shared with the next-day bar-explainer sheet.
function showHabituationSheet(taskIds, newState, isFirstEver) {
  const tasks = taskIds.map(id => newState.tasks[id]).filter(Boolean);
  if (tasks.length === 0) return;

  openSheet(habituationSheetHtml(tasks, isFirstEver));
  document.querySelector('[data-act="ok"]').addEventListener('click', closeSheet);
}

// --- Init ---

function init() {
  state.init();
  // Seed default settings on first run. If the event log is empty, fire
  // the four settings events so bigbang day already has working values
  // for day classification and credit math. Once seeded, these are
  // ordinary events in the log — user changes in Settings overwrite them
  // in the normal way.
  if (state.getEvents().length === 0) {
    actions.setSettings({
      earningMinimum: DEFAULT_EARNING_MINIMUM,
      multiplierMinimum: DEFAULT_MULTIPLIER_MINIMUM,
      increment: DEFAULT_INCREMENT,
      habitThreshold: DEFAULT_HABIT_THRESHOLD,
    });
  }
  state.onHabituation(showHabituationSheet);
  document.getElementById('sheet-overlay').addEventListener('click', closeSheet);
  window.addEventListener('hashchange', renderAll);
  renderAll();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
