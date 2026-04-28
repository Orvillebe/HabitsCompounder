// ============================================================================
// state.js
// ----------------------------------------------------------------------------
// The runtime: holds the current event log and the current derived state in
// memory. The only place where appendEvent happens; everywhere else reads via
// getState() / getEvents().
//
// On init: load events from storage, replay through engine.
// On appendEvent: push event, save to storage, replay, cache new state.
// Detects newly-habituated tasks by diffing pre/post state and notifies any
// registered listener so the UI can show a celebration sheet.
// ============================================================================

import { storage } from './storage.js';
import { replay } from './engine.js';

let events = [];
let cachedState = null;

// Listeners called after replay with the list of taskIds that just became
// habituated (transitioned from habituatedAt: null to a value).
const habituationListeners = [];

export function onHabituation(listener) {
  habituationListeners.push(listener);
}

// Build a set of currently-habituated task IDs from a state.
function habituatedSet(state) {
  const set = new Set();
  if (!state || !state.tasks) return set;
  for (const [id, t] of Object.entries(state.tasks)) {
    if (t.habituatedAt) set.add(id);
  }
  return set;
}

// Called after every replay. Detects newly habituated tasks (those that have
// habituatedAt set in the new state but didn't in the old state) and fires
// listeners. The first replay (init) has no "previous state" so doesn't fire.
function detectHabituationDelta(prevState, newState) {
  if (!prevState) return; // first replay; nothing to compare
  const before = habituatedSet(prevState);
  const after = habituatedSet(newState);
  const newlyHabituated = [];
  for (const id of after) {
    if (!before.has(id)) newlyHabituated.push(id);
  }
  if (newlyHabituated.length > 0) {
    // First-ever habituation event = nothing was habituated before this batch.
    const isFirstEver = before.size === 0;
    for (const listener of habituationListeners) {
      try { listener(newlyHabituated, newState, isFirstEver); }
      catch (e) { console.error('Habituation listener failed:', e); }
    }
  }
}

export function init() {
  events = storage.loadEvents();
  cachedState = replay(events);
}

export function getState() {
  return cachedState;
}

export function getEvents() {
  return events;
}

// Append a new event to the log. Persists, replays, and updates the cached
// state. Callers should re-render after this returns.
export function appendEvent(event) {
  const prevState = cachedState;
  events.push(event);
  storage.saveEvents(events);
  cachedState = replay(events);
  detectHabituationDelta(prevState, cachedState);
}

// Append multiple events as one logical operation. Saves once, replays once.
export function appendEvents(newEvents) {
  const prevState = cachedState;
  for (const event of newEvents) events.push(event);
  storage.saveEvents(events);
  cachedState = replay(events);
  detectHabituationDelta(prevState, cachedState);
}

// Wipe all events (used by "wipe data" in settings).
export function reset() {
  events = [];
  storage.clear();
  cachedState = replay(events);
}

// Replace the entire event log (used by "load test data"). Skips habituation
// notification since this is a bulk reset, not a real moment of transition.
export function replaceEvents(newEvents) {
  events = newEvents.slice();
  storage.saveEvents(events);
  cachedState = replay(events);
}
