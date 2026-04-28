// ============================================================================
// actions.js
// ----------------------------------------------------------------------------
// User-facing verbs. Each action constructs an engine event (or several) and
// appends it to the state log, then triggers a re-render. This is the only
// file (alongside state.js) that mutates the world.
//
// Events use the engine's vocabulary:
//   EARNING_MINIMUM_SET, MULTIPLIER_MINIMUM_SET, INCREMENT_SET,
//   HABIT_THRESHOLD_SET, TASK_CREATED, TASK_EDITED, TASK_ARCHIVED,
//   TASK_TICKED, TASK_UNTICKED, ACCOUNT_CREATED, ACCOUNT_RENAMED,
//   ACCOUNT_ARCHIVED, ACCOUNT_ACTIVATED, CREDITS_TRANSFERRED,
//   SESSION_GRANTED.
//
// Every event has a `recordedAt`. TASK_TICKED and TASK_UNTICKED also have
// an `at` (the semantic time the tick happened, which can be backdated).
// ============================================================================

import { appendEvent, appendEvents, reset, replaceEvents, getState } from './state.js';
import { renderAll } from './main.js';
import { dateFromKey, dayKey, todayKey } from './format.js';
import { classifyDayFromState } from './engine.js';
import { playCrossing } from './render/today.js';

function nowIso() {
  return new Date().toISOString();
}

// Build an `at` timestamp for a tick on a given calendar day.
//
// Live tick (today): `at` is the actual moment of recording. This makes the
// tick's effective time align with reality, so it sorts after any earlier
// events of the day (settings changes, account switches) instead of being
// pinned to a fixed past time.
//
// Backfill (past day): `at` is set to the last possible instant of that
// day (23:59:59.999 local). A backfill says "I did this sometime during
// day X, by now I'm sure of it" — end-of-day is the most accurate claim
// and ensures the backfill sorts after any live ticks that genuinely
// happened during day X in real time.
//
// Both branches still resolve to the same calendar day via `dayKey()`.
function atFromDayKey(dayKeyStr) {
  if (dayKeyStr === todayKey()) {
    return nowIso();
  }
  const d = dateFromKey(dayKeyStr);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

// --- Tasks ---

export function createTask(name, weight) {
  const taskId = 't_' + Date.now();
  appendEvent({ type: 'TASK_CREATED', recordedAt: nowIso(), taskId, name, weight });
  renderAll();
  return taskId;
}

export function editTask(taskId, fields) {
  appendEvent({ type: 'TASK_EDITED', recordedAt: nowIso(), taskId, ...fields });
  renderAll();
}

export function archiveTask(taskId) {
  appendEvent({ type: 'TASK_ARCHIVED', recordedAt: nowIso(), taskId });
  renderAll();
}

// --- Accounts ---

export function createAccount(name) {
  const accountId = 'a_' + Date.now();
  const events = [{ type: 'ACCOUNT_CREATED', recordedAt: nowIso(), accountId, name }];
  // First account auto-activates.
  const state = getState();
  if (!state.activeAccountId) {
    events.push({ type: 'ACCOUNT_ACTIVATED', recordedAt: nowIso(), accountId });
  }
  appendEvents(events);
  renderAll();
  return accountId;
}

export function editAccount(accountId, fields) {
  // The engine only supports renames; ignore other fields.
  if (fields.name !== undefined) {
    appendEvent({ type: 'ACCOUNT_RENAMED', recordedAt: nowIso(), accountId, name: fields.name });
    renderAll();
  }
}

export function setActiveAccount(accountId) {
  appendEvent({ type: 'ACCOUNT_ACTIVATED', recordedAt: nowIso(), accountId });
  renderAll();
}

// Archive an account. Returns:
//   { ok: true } on success
//   { ok: false, reason: 'active' } if the account is currently active
//   { ok: false, reason: 'only' } if it's the only non-archived account
// The caller (settings UI) is expected to translate `reason` into a message.
export function archiveAccount(accountId) {
  const state = getState();
  const account = state.accounts[accountId];
  if (!account) return { ok: false, reason: 'unknown' };
  if (account.archived) return { ok: true };

  if (state.activeAccountId === accountId) {
    return { ok: false, reason: 'active' };
  }

  const liveAccounts = Object.values(state.accounts).filter(a => !a.archived);
  if (liveAccounts.length <= 1) {
    return { ok: false, reason: 'only' };
  }

  appendEvent({ type: 'ACCOUNT_ARCHIVED', recordedAt: nowIso(), accountId });
  renderAll();
  return { ok: true };
}

// --- Settings ---

// The engine has separate events per setting. We accept a partial object
// for ergonomics and emit one event per key.
export function setSettings(partialSettings) {
  const events = [];
  const recordedAt = nowIso();
  if (partialSettings.earningMinimum !== undefined) {
    events.push({ type: 'EARNING_MINIMUM_SET', recordedAt, minimum: partialSettings.earningMinimum });
  }
  if (partialSettings.multiplierMinimum !== undefined) {
    events.push({ type: 'MULTIPLIER_MINIMUM_SET', recordedAt, minimum: partialSettings.multiplierMinimum });
  }
  if (partialSettings.increment !== undefined) {
    events.push({ type: 'INCREMENT_SET', recordedAt, increment: partialSettings.increment });
  }
  if (partialSettings.habitThreshold !== undefined) {
    events.push({ type: 'HABIT_THRESHOLD_SET', recordedAt, threshold: partialSettings.habitThreshold });
  }
  if (events.length > 0) {
    appendEvents(events);
    renderAll();
  }
}

// --- Ticks ---

// Toggle a task tick on a given calendar date (YYYY-MM-DD).
// Looks at current state to decide tick vs untick. The `at` timestamp is
// derived per atFromDayKey: for today it is now (live tick), for past
// dates it is 23:59:59.999 of that day (backfill). `recordedAt` is always
// now — the wall-clock moment of the tap.
//
// Backfill is allowed onto any date at or after the bigbang day (the
// local calendar day of the earliest event in the log). Dates before
// bigbang don't make sense — there was no system to track against — so
// the UI hides them and we silently refuse them here as a defensive
// guard.
//
// After the tick is applied, we detect whether the day's classification
// crossed a threshold (skipped→maintenance, skipped→compounding, or
// maintenance→compounding) and queue a celebration animation for the
// next render. Forward direction only — unticking that drops a class
// doesn't celebrate.
export function toggleTick(taskId, dayKeyStr) {
  const stateBefore = getState();

  // Bigbang guard: refuse ticks dated before the user's first event.
  if (stateBefore.firstEventAt) {
    const bigbangDayKey = dayKey(new Date(stateBefore.firstEventAt));
    if (dayKeyStr < bigbangDayKey) {
      return;
    }
  }

  const ticks = stateBefore.dayTicks[dayKeyStr] || {};
  const isOn = !!ticks[taskId];

  // Capture pre-state for crossing detection (tick only — not untick).
  let prevClassification = null;
  let balanceBefore = 0;
  if (!isOn) {
    prevClassification = classifyDayFromState(stateBefore, dayKeyStr);
    const account = stateBefore.accounts[stateBefore.activeAccountId];
    balanceBefore = account ? account.currentBalance : 0;
  }

  const at = atFromDayKey(dayKeyStr);
  const recordedAt = nowIso();
  appendEvent({
    type: isOn ? 'TASK_UNTICKED' : 'TASK_TICKED',
    recordedAt,
    at,
    taskId,
  });

  // Detect upward crossing on tick (forward only — unticks don't celebrate
  // a regression). Compare today's classification before vs after using
  // classifyDayFromState (single source of truth) and the active account's
  // balance delta. Render first so the bar DOM exists, then play.
  let crossing = null;
  if (!isOn && prevClassification !== null) {
    const stateAfter = getState();
    const newClassification = classifyDayFromState(stateAfter, dayKeyStr);
    const accountAfter = stateAfter.accounts[stateAfter.activeAccountId];
    const delta = (accountAfter ? accountAfter.currentBalance : 0) - balanceBefore;

    if (delta > 0) {
      // Compounding supersedes maintenance — a tick that jumps from
      // skipped straight to compounding fires the louder animation only.
      if (newClassification === 'compounding' && prevClassification !== 'compounding') {
        crossing = { kind: 'compounding', delta };
      } else if (newClassification === 'maintenance' && prevClassification === 'skipped') {
        crossing = { kind: 'maintenance', delta };
      }
    }
  }

  renderAll();

  if (crossing) {
    // Bar DOM is freshly painted; one RAF lets layout settle before we
    // measure for the flash overlay.
    requestAnimationFrame(() => playCrossing(crossing.kind, crossing.delta));
  }
}

// --- Transfers and grants ---

export function transferCredits(fromAccountId, toAccountId, amount) {
  appendEvent({
    type: 'CREDITS_TRANSFERRED',
    recordedAt: nowIso(),
    fromAccountId,
    toAccountId,
    amount,
  });
  renderAll();
}

export function grantToSession(accountId, amount) {
  appendEvent({
    type: 'SESSION_GRANTED',
    recordedAt: nowIso(),
    accountId,
    amount,
  });
  renderAll();
}

// --- Bulk operations (test data, wipe) ---

export function wipeAllData() {
  reset();
  renderAll();
}

export function replaceAllEvents(eventLog) {
  replaceEvents(eventLog);
  renderAll();
}
