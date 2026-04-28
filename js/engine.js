// =============================================================================
// HABIT BUILDER ENGINE
// =============================================================================
//
// Pure-function engine for a habit-tracking system with a compounding-
// multiplier mechanic. Application-neutral: tracks tasks, accounts, credits,
// and multipliers without caring what the credits are eventually spent on.
//
// Architecture in one paragraph:
// The source of truth is an event log. Every action (tick a task, create an
// account, transfer credits, etc.) is an event. State (current multipliers,
// account balances, habituation status) is never stored. It is derived by
// replaying the event log through the replay function. Backfilling is just
// inserting an event with an earlier `at` timestamp into the log; the replay
// handles it the same way as any other event. This file is environment-agnostic.
// It runs in Node and in the browser without modification.
//
// Vocabulary:
//   - account: a container with a multiplier, a current balance, and a
//     lifetime-earned total. Exactly one is active at any time.
//   - credits: the unit. Tasks produce credits. Credits land in accounts.
//   - current balance: spendable amount in an account right now.
//   - lifetime earned: running total ever credited to an account.
//     Decreases only on outgoing transfers.
//   - multiplier: per-account number, floor 1.0, no ceiling. Grows on
//     compounding days, holds on maintenance days, freezes on first skip
//     day, decays on subsequent skip days.
//   - habituation: a task is habituated once its global tick count reaches
//     the habit threshold. Habituation date is fixed by the recordedAt of
//     the crossing tick, not by its `at`.
//   - earning minimum: day-level threshold. Below this point total, no
//     credits flow at all.
//   - multiplier minimum: day-level threshold. Below this point total,
//     non-habituated credits flow at flat rate (no multiplier applied).
//
// All times are ISO 8601 with timezone offset. Day boundaries are local
// midnight in the timezone of the recordedAt of each event. For v1 the
// engine assumes a single consistent timezone across the whole log; mixing
// timezones will produce well-defined but possibly surprising results.
//
// =============================================================================


// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

// EngineError is thrown for invalid events or invariant violations during
// replay/applyEvent. These are programming bugs, not user-recoverable
// errors. The action layer is expected to produce only valid events; if an
// EngineError fires it indicates a contract violation by a caller. Not
// exported — no one outside the engine catches these. They propagate up
// and surface in the console, which is the desired behavior for bugs.
class EngineError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}


// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const MULTIPLIER_FLOOR = 1.0;
export const DEFAULT_HABIT_THRESHOLD = 66;
export const DEFAULT_INCREMENT = 0.02;
export const DEFAULT_EARNING_MINIMUM = 1;
export const DEFAULT_MULTIPLIER_MINIMUM = 3;


// -----------------------------------------------------------------------------
// Day boundary helpers
// -----------------------------------------------------------------------------

// Returns a YYYY-MM-DD string in local time. Same concept and logic as
// format.dayKey; duplicated here to keep the engine self-contained
// (no imports). Two timestamps on the same local date produce the same key.
export function dayKey(input) {
  const d = input instanceof Date ? input : new Date(input);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Returns an ISO timestamp at the next local midnight after the given timestamp.
// Used to synthesize MIDNIGHT events between real events.
export function nextMidnight(isoString) {
  const d = new Date(isoString);
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}

// Returns true iff a is strictly before b.
function isBefore(a, b) {
  return new Date(a).getTime() < new Date(b).getTime();
}


// -----------------------------------------------------------------------------
// Pure scoring functions
// -----------------------------------------------------------------------------

// Classifies a day given the ticks that landed on it, the earning minimum,
// and the multiplier minimum in effect on that day.
//
// Returns: 'compounding' | 'maintenance' | 'skipped' | 'unclassified'
//
// Rules (single source of truth — used by both replay and the frontend):
//   - skipped:     total points < earning minimum (or no minimums set)
//                  Day is empty or below the earning floor.
//                  Multiplier freezes (first in row) / decays (subsequent).
//   - maintenance: total >= earning minimum, but non-habituated < mult min
//                  Day shows up but does not compound.
//                  Multiplier holds, skip counter resets.
//   - compounding: non-habituated points >= multiplier minimum
//                  Day grows the multiplier.
//
// 'unclassified' means no multiplier minimum was set yet on this day. The
// engine makes no judgment and the multiplier does not move.
export function classifyDay(ticksOnDay, earningMinimum, multiplierMinimum) {
  if (multiplierMinimum === null || multiplierMinimum === undefined) {
    return 'unclassified';
  }
  if (multiplierMinimum <= 0) {
    throw new EngineError('INVALID_MULTIPLIER_MINIMUM',
      'Multiplier minimum must be a positive number');
  }

  let habituatedPoints = 0;
  let nonHabituatedPoints = 0;

  for (const tick of ticksOnDay) {
    if (tick.habituated) {
      habituatedPoints += tick.weight;
    } else {
      nonHabituatedPoints += tick.weight;
    }
  }

  const totalPoints = habituatedPoints + nonHabituatedPoints;
  const effectiveEarnMin = earningMinimum ?? 0;

  if (nonHabituatedPoints >= multiplierMinimum) {
    return 'compounding';
  }
  if (totalPoints >= effectiveEarnMin && totalPoints > 0) {
    return 'maintenance';
  }
  return 'skipped';
}

// Public: classify any day given the current engine state.
//
// For past days the engine has already classified at midnight; we just look
// up the cached classification. For today (or any day the engine hasn't
// processed yet), we compute it on the fly using the same rules.
//
// This is the single source of truth for day classification. Both the
// calendar and any other UI surface that needs "what kind of day is this"
// should call this function.
//
// Returns: 'compounding' | 'maintenance' | 'skipped' | 'unclassified'
export function classifyDayFromState(state, dayKeyStr) {
  // Past day, already processed by replay → use cached classification.
  if (state.dayClassifications && state.dayClassifications[dayKeyStr] !== undefined) {
    return state.dayClassifications[dayKeyStr];
  }

  // Day not yet processed (typically today). Build the same tick shape that
  // classifyDay expects from the engine's per-day tick storage.
  const ticksMap = (state.dayTicks && state.dayTicks[dayKeyStr]) || {};
  const ticksOnDay = [];
  for (const taskId in ticksMap) {
    if (!ticksMap[taskId]) continue;
    const task = state.tasks[taskId];
    if (!task) continue;
    // Habituated for this tick: task habituated strictly before this day.
    // We use the day boundary as the comparison point — same logic as the
    // tick-time check in applyEvent, just without a precise `at` time.
    const habituatedForDay =
      task.habituatedAt !== null &&
      task.habituatedAt !== undefined &&
      isBefore(task.habituatedAt, `${dayKeyStr}T00:00:00.000`);
    ticksOnDay.push({
      weight: task.weight,
      habituated: habituatedForDay,
    });
  }
  return classifyDay(ticksOnDay, state.earningMinimum, state.multiplierMinimum);
}

// Updates the multiplier and skip counter at a midnight transition,
// given the classification of the day that just ended.
//
// Returns: { multiplier, skipCounter }
//
// Rules:
//   - compounding: multiplier += increment, skipCounter -> 0
//   - maintenance: multiplier unchanged, skipCounter -> 0
//   - first skipped day in a row: multiplier unchanged (frozen),
//     skipCounter -> 1
//   - subsequent skipped days: multiplier -= increment (clamped at floor),
//     skipCounter += 1
//   - unclassified: no-op (no minimum was set, so no judgment is made)
export function updateMultiplier(prevMultiplier, prevSkipCounter, classification, increment) {
  if (classification === 'unclassified') {
    return {
      multiplier: prevMultiplier,
      skipCounter: prevSkipCounter,
    };
  }

  if (classification === 'compounding') {
    return {
      multiplier: prevMultiplier + increment,
      skipCounter: 0,
    };
  }

  if (classification === 'maintenance') {
    return {
      multiplier: prevMultiplier,
      skipCounter: 0,
    };
  }

  if (classification === 'skipped') {
    const newSkipCounter = prevSkipCounter + 1;
    if (newSkipCounter === 1) {
      // First skip in a row: freeze. The "never skip twice" buffer.
      return {
        multiplier: prevMultiplier,
        skipCounter: newSkipCounter,
      };
    }
    // Second skip onward: decay, clamped at floor.
    const decayed = prevMultiplier - increment;
    return {
      multiplier: decayed < MULTIPLIER_FLOOR ? MULTIPLIER_FLOOR : decayed,
      skipCounter: newSkipCounter,
    };
  }

  throw new EngineError('UNKNOWN_CLASSIFICATION',
    `classifyDay returned unexpected value: ${classification}`);
}

// Computes credit contribution for a single tick.
//
// Habituated ticks always credit flat (just their weight).
// Non-habituated ticks credit weight * multiplier when the day's total
// reached multiplier minimum, else flat.
export function tickCredits(weight, habituated, multiplierAtMoment, dayCrossedMultiplierMin) {
  if (habituated) {
    return weight;
  }
  if (dayCrossedMultiplierMin) {
    return weight * multiplierAtMoment;
  }
  return weight;
}

// Walks one day's ticks and produces a list of credit entries.
// Each entry: { at, accountId, credits }.
//
// Earning minimum gates whether the day produces any entries. If the day's
// total points (habituated + non-habituated) never reaches earning minimum,
// Compute per-tick credit entries for a day, given the day's classification.
// Single source of truth for what each classification awards:
//   - skipped:     no credits (returns []).
//   - maintenance: every tick credits at face value (×1.0).
//   - compounding: non-habituated ticks credit at × multiplier-at-moment;
//                  habituated ticks always credit at face value, regardless.
// Habituated ticks never compound. Multiplier is read per-tick rather than
// per-day so that mid-day account switches credit through the right value.
//
// Day classification comes from classifyDay so the credit gate and the
// classification rule cannot drift.
export function computeCreditsForDay(ticksOnDay, earningMinimum, multiplierMinimum) {
  if (ticksOnDay.length === 0) return [];

  const classification = classifyDay(ticksOnDay, earningMinimum, multiplierMinimum);
  if (classification === 'skipped' || classification === 'unclassified') {
    return [];
  }

  const compounding = classification === 'compounding';

  const entries = [];
  for (const tick of ticksOnDay) {
    const credits = tickCredits(
      tick.weight,
      tick.habituated,
      tick.multiplierAtMoment,
      compounding
    );
    entries.push({
      at: tick.at,
      accountId: tick.activeAccountIdAtMoment,
      credits,
    });
  }
  return entries;
}


// -----------------------------------------------------------------------------
// Validators
// -----------------------------------------------------------------------------

// Validates one event in isolation (shape and field constraints).
// Cross-event validation (does the account exist, is the task archived, etc.)
// happens during replay where we have context.
export function validateEvent(event) {
  if (!event.type) {
    throw new EngineError('MISSING_TYPE', 'Event must have a type');
  }
  if (!event.recordedAt) {
    throw new EngineError('MISSING_RECORDED_AT',
      `Event of type ${event.type} must have a recordedAt timestamp`);
  }

  switch (event.type) {
    case 'EARNING_MINIMUM_SET':
    case 'MULTIPLIER_MINIMUM_SET': {
      if (typeof event.minimum !== 'number' || event.minimum <= 0) {
        throw new EngineError('INVALID_MINIMUM',
          `${event.type} requires a positive minimum`);
      }
      break;
    }
    case 'HABIT_THRESHOLD_SET': {
      if (typeof event.threshold !== 'number' || event.threshold <= 0 || !Number.isInteger(event.threshold)) {
        throw new EngineError('INVALID_THRESHOLD',
          'HABIT_THRESHOLD_SET requires a positive integer threshold');
      }
      break;
    }
    case 'INCREMENT_SET': {
      if (typeof event.increment !== 'number' || event.increment <= 0) {
        throw new EngineError('INVALID_INCREMENT',
          'INCREMENT_SET requires a positive increment');
      }
      break;
    }
    case 'TASK_CREATED': {
      if (!event.taskId || !event.name || typeof event.weight !== 'number' || event.weight <= 0) {
        throw new EngineError('INVALID_TASK',
          'TASK_CREATED requires taskId, name, and positive weight');
      }
      break;
    }
    case 'TASK_EDITED': {
      if (!event.taskId) {
        throw new EngineError('INVALID_TASK_EDIT', 'TASK_EDITED requires taskId');
      }
      if (event.weight !== undefined && (typeof event.weight !== 'number' || event.weight <= 0)) {
        throw new EngineError('INVALID_TASK_EDIT', 'Weight must be positive');
      }
      break;
    }
    case 'TASK_ARCHIVED': {
      if (!event.taskId) {
        throw new EngineError('INVALID_TASK_ARCHIVE', 'TASK_ARCHIVED requires taskId');
      }
      break;
    }
    case 'TASK_TICKED': {
      if (!event.taskId || !event.at) {
        throw new EngineError('INVALID_TICK',
          'TASK_TICKED requires taskId and at timestamp');
      }
      break;
    }
    case 'TASK_UNTICKED': {
      if (!event.taskId || !event.at) {
        throw new EngineError('INVALID_UNTICK',
          'TASK_UNTICKED requires taskId and at timestamp');
      }
      break;
    }
    case 'ACCOUNT_CREATED': {
      if (!event.accountId || !event.name) {
        throw new EngineError('INVALID_ACCOUNT',
          'ACCOUNT_CREATED requires accountId and name');
      }
      break;
    }
    case 'ACCOUNT_RENAMED': {
      if (!event.accountId || !event.name) {
        throw new EngineError('INVALID_ACCOUNT_RENAME',
          'ACCOUNT_RENAMED requires accountId and name');
      }
      break;
    }
    case 'ACCOUNT_ARCHIVED': {
      if (!event.accountId) {
        throw new EngineError('INVALID_ACCOUNT_ARCHIVE',
          'ACCOUNT_ARCHIVED requires accountId');
      }
      break;
    }
    case 'ACCOUNT_ACTIVATED': {
      if (!event.accountId) {
        throw new EngineError('INVALID_ACCOUNT_ACTIVATION',
          'ACCOUNT_ACTIVATED requires accountId');
      }
      break;
    }
    case 'CREDITS_TRANSFERRED': {
      if (!event.fromAccountId || !event.toAccountId ||
          typeof event.amount !== 'number' || event.amount <= 0) {
        throw new EngineError('INVALID_TRANSFER',
          'CREDITS_TRANSFERRED requires fromAccountId, toAccountId, and positive amount');
      }
      if (event.fromAccountId === event.toAccountId) {
        throw new EngineError('INVALID_TRANSFER',
          'Cannot transfer credits to the same account');
      }
      break;
    }
    case 'SESSION_GRANTED': {
      if (!event.accountId || typeof event.amount !== 'number' || event.amount <= 0) {
        throw new EngineError('INVALID_SESSION_GRANT',
          'SESSION_GRANTED requires accountId and positive amount');
      }
      break;
    }
    default:
      throw new EngineError('UNKNOWN_EVENT_TYPE', `Unknown event type: ${event.type}`);
  }
}


// -----------------------------------------------------------------------------
// Replay
// -----------------------------------------------------------------------------

// Replays an event log to produce derived state.
//
// Approach:
//   1. Validate all events.
//   2. Sort by effective time (TASK_TICKED uses `at`, everything else uses
//      `recordedAt`). This puts backfilled ticks where they actually belong
//      in the timeline.
//   3. Pre-pass for tasks and accounts. Before the main walk, scan the
//      unsorted events and register every task and account in the state.
//      We need this because step 2 sorts ticks by their `at` field, which
//      may place a backfilled tick *before* the TASK_CREATED event that
//      created the task. Without the pre-pass, the backfilled tick would
//      reference a non-existent task and throw. With the pre-pass, the
//      task object is already in state.tasks when the backfilled tick is
//      applied; the later TASK_CREATED event is then a no-op for state
//      mutation (its `if (!state.tasks[event.taskId])` guard skips). Same
//      logic for accounts and ACCOUNT_CREATED. We also pre-set the
//      active account to the first account that ever gets activated, so
//      a backfilled tick before any ACCOUNT_ACTIVATED still credits to
//      a valid account.
//   4. Walk events in sorted order, synthesizing midnight transitions
//      between them. Maintain a running state: tasks, accounts,
//      multipliers, balances, tick counts, habituation dates, skip
//      counters, the active account, the current earning minimum,
//      multiplier minimum, increment, and habit threshold.
//   5. At each midnight: classify the day that just ended (using the data
//      gathered for that day) and update multiplier and skip counter for
//      the account that was active at the moment of the midnight. Credits
//      were already applied as ticks arrived (instant credit, see
//      settleDayCredits); midnight only seals the classification and moves
//      the multiplier.
//
// Options:
//   - now: ISO timestamp to use as "now" for processing midnights past the
//     last event. Defaults to wall-clock current time. Scenarios pin this
//     so tests are deterministic. The engine processes midnights strictly
//     before `now`; the day containing `now` is not closed.
//
// Returns the full derived state.
export function replay(events, options) {
  const opts = options || {};
  for (const event of events) {
    validateEvent(event);
  }

  // Sort by effective time. TASK_TICKED and TASK_UNTICKED use `at`,
  // others use `recordedAt`.
  const sorted = [...events].sort((a, b) => {
    const ta = (a.type === 'TASK_TICKED' || a.type === 'TASK_UNTICKED') ? a.at : a.recordedAt;
    const tb = (b.type === 'TASK_TICKED' || b.type === 'TASK_UNTICKED') ? b.at : b.recordedAt;
    return new Date(ta).getTime() - new Date(tb).getTime();
  });

  const state = {
    // Settings
    earningMinimum: null,
    multiplierMinimum: null,
    increment: DEFAULT_INCREMENT,
    habitThreshold: DEFAULT_HABIT_THRESHOLD,

    // Tasks: taskId -> { name, weight, archived, tickCount, habituatedAt }
    // tickCount counts every tick (including backfills, by recordedAt order).
    // habituatedAt is the recordedAt of the tick that crossed the threshold,
    // null until then. Once set, never changes.
    // archived is a soft-flag — task is hidden from active views but its
    // history is preserved. Archived tasks cannot be ticked.
    tasks: {},

    // Accounts: accountId -> { name, archived, multiplier, currentBalance,
    //                          lifetimeEarned, skipCounter }
    // archived works the same as for tasks: hidden from active views but
    // history (balance, classifications) preserved. The currently active
    // account cannot be archived.
    accounts: {},

    // Active account at the latest moment seen so far in the replay.
    activeAccountId: null,

    // Per-day buckets of ticks for classification at midnight.
    // dayKey -> { activeAccountId, ticks: [{...}] }
    // We bucket by the day the tick's `at` falls on.
    pendingDays: {},

    // dayTicks: dayKey -> { taskId: true } — flattened view of which tasks
    // are ticked on each day. Updated as ticks arrive and as days are
    // processed. The frontend reads this for "is task X ticked on day Y".
    dayTicks: {},

    // dayClassifications: dayKey -> 'compounding' | 'maintenance' | 'skipped'
    // Set when each day is processed at midnight. The frontend reads this
    // for the calendar view.
    dayClassifications: {},

    // dayMultipliers: dayKey -> accountId -> multiplier-at-day-start.
    // Captured before each midnight transition. Lets the frontend show the
    // correct multiplier when navigating to a past date.
    dayMultipliers: {},

    // dayCredits: dayKey -> accountId -> credits-earned-by-that-account-that-day.
    // Populated at midnight from the day's tick credit entries. Each tick
    // credits whichever account was active at the moment of the tick, so a
    // single day can have credits split across multiple accounts. The
    // frontend reads this on past dates to disclose who actually received
    // the day's credits, even when the user has since switched accounts.
    dayCredits: {},

    // The earliest recordedAt of any event in the log — the "bigbang" of
    // this user's tracked universe. Frontend uses this to disable date
    // navigation before this point. Null when the log is empty.
    firstEventAt: null,
  };

  // Find bigbang: earliest recordedAt of any event. We scan the unsorted
  // events array — every event has a recordedAt regardless of type.
  for (const event of events) {
    if (state.firstEventAt === null || event.recordedAt < state.firstEventAt) {
      state.firstEventAt = event.recordedAt;
    }
  }

  // Pre-pass: register tasks and accounts up front so a backfilled tick
  // whose `at` falls before the entity's TASK_CREATED / ACCOUNT_CREATED
  // can still find it. Without this, sort-by-`at` would put the tick
  // before the creation in the timeline and the lookup would fail.
  //
  // The user's intent ("I did this thing on Apr 27") is preserved — the
  // task simply exists from the start of the replay. The TASK_CREATED
  // event itself still runs in the main loop in its sorted position; its
  // applyEvent treats a re-create of an already-known task as a no-op
  // (the registration here already wrote the canonical fields).
  //
  // We also pre-set activeAccountId to the first account that ever gets
  // activated in the log, so a tick backfilled before any ACCOUNT_ACTIVATED
  // event still credits to a valid account.
  let firstActivatedAccountId = null;
  for (const event of events) {
    if (event.type === 'TASK_CREATED' && !state.tasks[event.taskId]) {
      state.tasks[event.taskId] = {
        name: event.name,
        weight: event.weight,
        archived: false,
        tickCount: 0,
        habituatedAt: null,
      };
    } else if (event.type === 'ACCOUNT_CREATED' && !state.accounts[event.accountId]) {
      state.accounts[event.accountId] = {
        name: event.name,
        archived: false,
        multiplier: 1.0,
        currentBalance: 0,
        lifetimeEarned: 0,
        skipCounter: 0,
      };
    } else if (event.type === 'ACCOUNT_ACTIVATED' && firstActivatedAccountId === null) {
      firstActivatedAccountId = event.accountId;
    }
  }
  if (firstActivatedAccountId !== null) {
    state.activeAccountId = firstActivatedAccountId;
  }

  // Walk sorted events, synthesizing midnight transitions between them.
  let lastTime = null;

  for (const event of sorted) {
    const eventTime = (event.type === 'TASK_TICKED' || event.type === 'TASK_UNTICKED')
      ? event.at
      : event.recordedAt;

    // Synthesize midnight transitions between lastTime and eventTime.
    if (lastTime !== null) {
      processMidnightsBetween(state, lastTime, eventTime);
    }

    applyEvent(state, event);
    lastTime = eventTime;
  }

  // Synthesize midnights from lastTime up to `now` so today's classification
  // is included if appropriate. Scenario runner pins `now` for determinism;
  // production callers can omit it to use wall-clock time.
  if (lastTime !== null) {
    const now = opts.now || new Date().toISOString();
    processMidnightsBetween(state, lastTime, now);
  }

  return state;
}

// Settle the credits for one day to match its current eligibility.
// Single source of truth for "what should be credited to balance for this
// day right now" is computeCreditsForDay (which calls classifyDay).
//
// Each call recomputes the day's eligible credits from its tick bucket and
// applies the delta vs whatever has already been credited, kept in
// state.dayCredits[dayK]. Net effect:
//   - First tick that crosses earningMinimum → credits jump from 0 to face value
//   - Tick that crosses multiplierMinimum → credits jump up by the multiplier bonus
//     on every non-hab point ticked so far
//   - Untick that drops below a threshold → credits retract by the delta
//   - Same-day reordering, backfill, anything: just settles to truth
//
// Called from TASK_TICKED and TASK_UNTICKED for the day they affected.
function settleDayCredits(state, dayK) {
  const bucket = state.pendingDays[dayK];
  const ticks = bucket ? bucket.ticks : [];
  const eligible = computeCreditsForDay(
    ticks,
    state.earningMinimum,
    state.multiplierMinimum
  );

  // Sum eligible per account.
  const eligiblePerAccount = {};
  for (const entry of eligible) {
    eligiblePerAccount[entry.accountId] =
      (eligiblePerAccount[entry.accountId] ?? 0) + entry.credits;
  }

  // Already-applied per account for this day.
  const applied = state.dayCredits[dayK] ?? {};

  // Walk the union of accounts that need adjustment.
  const accountIds = new Set([
    ...Object.keys(eligiblePerAccount),
    ...Object.keys(applied),
  ]);

  for (const accountId of accountIds) {
    const want = eligiblePerAccount[accountId] ?? 0;
    const have = applied[accountId] ?? 0;
    const delta = want - have;
    if (delta === 0) continue;
    const account = state.accounts[accountId];
    if (account) {
      account.currentBalance += delta;
      account.lifetimeEarned += delta;
    }
    if (want === 0) {
      // Drop the entry rather than store a 0.
      if (state.dayCredits[dayK]) {
        delete state.dayCredits[dayK][accountId];
      }
    } else {
      if (!state.dayCredits[dayK]) state.dayCredits[dayK] = {};
      state.dayCredits[dayK][accountId] = want;
    }
  }

  // Clean up empty per-day record.
  if (state.dayCredits[dayK] && Object.keys(state.dayCredits[dayK]).length === 0) {
    delete state.dayCredits[dayK];
  }
}


// At each midnight, the day that just ended gets classified and the multiplier
// of the account that was active during that day updates.
function processMidnightsBetween(state, fromIso, toIso) {
  let cursor = nextMidnight(fromIso);
  while (isBefore(cursor, toIso) || cursor === toIso) {
    // Process the day that ended at `cursor` (i.e. yesterday relative to cursor).
    const yesterdayKey = dayKey(new Date(new Date(cursor).getTime() - 1).toISOString());
    processDayEnd(state, yesterdayKey, cursor);
    cursor = nextMidnight(cursor);
  }
}

// Re-settle every pending day's credits. Called after any settings change so
// today's bucket reflects the new rules immediately. In normal use only one
// bucket exists (today's); during replay of historical settings events the
// bucket is whichever day the walk is currently inside, and any past pending
// bucket is about to be drained at its midnight transition anyway, so a
// redundant settle here is harmless.
function resettleAllPending(state) {
  for (const dayK of Object.keys(state.pendingDays)) {
    settleDayCredits(state, dayK);
  }
}

// Process the end of a day: classify it, update multiplier on the account
// that is active at the moment of the midnight transition (not the account
// that was active at day-start). Credit application is NOT done here —
// credits are applied instantly via settleDayCredits whenever a tick is
// added or removed. processDayEnd only writes classification, multiplier
// snapshot, and updates the running multiplier for tomorrow.
function processDayEnd(state, dayK, midnightIso) {
  const bucket = state.pendingDays[dayK];

  // Snapshot the multiplier-during-day for every account, BEFORE updating.
  // The multiplier in force during a day is the multiplier at day-start,
  // which equals the running multiplier just before this midnight's update.
  // The frontend reads this when displaying past dates.
  if (!state.dayMultipliers[dayK]) state.dayMultipliers[dayK] = {};
  for (const [accountId, account] of Object.entries(state.accounts)) {
    state.dayMultipliers[dayK][accountId] = account.multiplier;
  }

  // The multiplier-bearing account at midnight is the one currently active
  // in the running state.
  const activeAtMidnight = state.activeAccountId;

  // Classify the day.
  const ticks = bucket ? bucket.ticks : [];
  const classification = classifyDay(ticks, state.earningMinimum, state.multiplierMinimum);
  state.dayClassifications[dayK] = classification;

  // Update multiplier and skip counter on the account active at midnight.
  if (activeAtMidnight && state.accounts[activeAtMidnight]) {
    const account = state.accounts[activeAtMidnight];
    const updated = updateMultiplier(
      account.multiplier,
      account.skipCounter,
      classification,
      state.increment
    );
    account.multiplier = updated.multiplier;
    account.skipCounter = updated.skipCounter;
  }

  // Clear the bucket. Credits for this day are already settled in dayCredits;
  // future ticks landing on this day via backfill will re-trigger
  // settleDayCredits and adjust correctly.
  delete state.pendingDays[dayK];
}

// Apply a single event to mutable state. Pure with respect to the events array
// (does not modify it), but mutates the state object for performance.
function applyEvent(state, event) {
  switch (event.type) {
    case 'EARNING_MINIMUM_SET':
      state.earningMinimum = event.minimum;
      resettleAllPending(state);
      break;

    case 'MULTIPLIER_MINIMUM_SET':
      state.multiplierMinimum = event.minimum;
      resettleAllPending(state);
      break;

    case 'HABIT_THRESHOLD_SET':
      state.habitThreshold = event.threshold;
      resettleAllPending(state);
      break;

    case 'INCREMENT_SET':
      state.increment = event.increment;
      resettleAllPending(state);
      break;

    case 'TASK_CREATED': {
      // The pre-pass in replay() may have already registered this task so
      // that backfilled ticks (sorted by `at` before this event) can find
      // it. In that case we leave the task object alone — it already
      // carries the same canonical fields, plus any tickCount / habituatedAt
      // accumulated from backfilled ticks earlier in the sorted timeline.
      if (!state.tasks[event.taskId]) {
        state.tasks[event.taskId] = {
          name: event.name,
          weight: event.weight,
          archived: false,
          tickCount: 0,
          habituatedAt: null,
        };
      }
      break;
    }

    case 'TASK_EDITED': {
      const task = state.tasks[event.taskId];
      if (!task) {
        throw new EngineError('UNKNOWN_TASK',
          `Task ${event.taskId} does not exist`);
      }
      if (task.archived) {
        throw new EngineError('TASK_ARCHIVED',
          `Task ${event.taskId} is archived`);
      }
      if (event.name !== undefined) task.name = event.name;
      if (event.weight !== undefined) task.weight = event.weight;
      break;
    }

    case 'TASK_ARCHIVED': {
      const task = state.tasks[event.taskId];
      if (!task) {
        throw new EngineError('UNKNOWN_TASK',
          `Task ${event.taskId} does not exist`);
      }
      task.archived = true;
      break;
    }

    case 'TASK_TICKED': {
      const task = state.tasks[event.taskId];
      if (!task) {
        throw new EngineError('UNKNOWN_TASK',
          `Task ${event.taskId} does not exist`);
      }
      if (task.archived) {
        throw new EngineError('TASK_ARCHIVED',
          `Cannot tick archived task ${event.taskId}`);
      }

      // Increment the global tick counter.
      task.tickCount += 1;

      // If this tick crosses the threshold, set habituation date.
      // Habituation date uses recordedAt of the crossing tick (sticky).
      if (task.habituatedAt === null && task.tickCount >= state.habitThreshold) {
        task.habituatedAt = event.recordedAt;
      }

      // Bucket the tick into the day it landed on (by `at`).
      // An active account is required: ticking with no account would
      // produce credits with no destination, which is invalid.
      if (!state.activeAccountId) {
        throw new EngineError('NO_ACTIVE_ACCOUNT',
          'Cannot tick a task before activating an account');
      }
      const k = dayKey(event.at);
      if (!state.pendingDays[k]) {
        state.pendingDays[k] = {
          ticks: [],
        };
      }

      // Habituated for this tick? Use strictly-before rule on the `at` timestamp.
      const habituated =
        task.habituatedAt !== null && isBefore(task.habituatedAt, event.at);

      // The multiplier in force at this moment is the multiplier of the
      // currently-active account, since multipliers only change at midnight
      // and we are inside the same day as the most recent midnight processing.
      const activeAccount = state.activeAccountId
        ? state.accounts[state.activeAccountId]
        : null;
      const multiplierAtMoment = activeAccount ? activeAccount.multiplier : 1.0;

      state.pendingDays[k].ticks.push({
        at: event.at,
        taskId: event.taskId,
        weight: task.weight,
        habituated,
        multiplierAtMoment,
        activeAccountIdAtMoment: state.activeAccountId,
      });

      // Maintain the dayTicks lookup the frontend reads.
      if (!state.dayTicks[k]) state.dayTicks[k] = {};
      state.dayTicks[k][event.taskId] = true;

      // Instant credit: settle this day's eligible credits to balance.
      settleDayCredits(state, k);
      break;
    }

    case 'TASK_UNTICKED': {
      const task = state.tasks[event.taskId];
      if (!task) {
        throw new EngineError('UNKNOWN_TASK',
          `Task ${event.taskId} does not exist`);
      }
      const k = dayKey(event.at);
      const bucket = state.pendingDays[k];
      if (bucket) {
        let removeIdx = -1;
        for (let i = bucket.ticks.length - 1; i >= 0; i--) {
          const t = bucket.ticks[i];
          if (t.taskId === event.taskId && !isBefore(event.at, t.at)) {
            removeIdx = i;
            break;
          }
        }
        if (removeIdx !== -1) {
          bucket.ticks.splice(removeIdx, 1);
          task.tickCount -= 1;
          // If the un-tick drops the count back below the habituation threshold,
          // un-habituate the task. Habituation is only valid as long as the
          // tick count actually meets the threshold.
          if (task.habituatedAt !== null && task.tickCount < state.habitThreshold) {
            task.habituatedAt = null;
          }
          // Remove from dayTicks if no more ticks of this task remain on this day.
          const stillTicked = bucket.ticks.some(t => t.taskId === event.taskId);
          if (!stillTicked && state.dayTicks[k]) {
            delete state.dayTicks[k][event.taskId];
            if (Object.keys(state.dayTicks[k]).length === 0) {
              delete state.dayTicks[k];
            }
          }
          // Instant credit: re-settle this day's credits after removing the tick.
          // The day may drop into a lower classification (e.g. compounding -> maintenance,
          // or maintenance -> skipped), in which case credits are clawed back.
          settleDayCredits(state, k);
        }
      }
      break;
    }

    case 'ACCOUNT_CREATED': {
      // Pre-pass in replay() may have already registered this account.
      // Leave it alone if so — its balance/multiplier may have already
      // been mutated by events sorted earlier in the timeline.
      if (!state.accounts[event.accountId]) {
        state.accounts[event.accountId] = {
          name: event.name,
          archived: false,
          multiplier: 1.0,
          currentBalance: 0,
          lifetimeEarned: 0,
          skipCounter: 0,
        };
      }
      break;
    }

    case 'ACCOUNT_RENAMED': {
      const account = state.accounts[event.accountId];
      if (!account) {
        throw new EngineError('UNKNOWN_ACCOUNT',
          `Account ${event.accountId} does not exist`);
      }
      account.name = event.name;
      break;
    }

    case 'ACCOUNT_ARCHIVED': {
      const account = state.accounts[event.accountId];
      if (!account) {
        throw new EngineError('UNKNOWN_ACCOUNT',
          `Account ${event.accountId} does not exist`);
      }
      // The action layer is expected to refuse archive when the account is
      // active or is the only non-archived one; this is a defensive check
      // for malformed event logs.
      if (state.activeAccountId === event.accountId) {
        throw new EngineError('ACCOUNT_ACTIVE',
          `Cannot archive the active account ${event.accountId}`);
      }
      account.archived = true;
      break;
    }

    case 'ACCOUNT_ACTIVATED': {
      const account = state.accounts[event.accountId];
      if (!account) {
        throw new EngineError('UNKNOWN_ACCOUNT',
          `Account ${event.accountId} does not exist`);
      }
      if (account.archived) {
        throw new EngineError('ACCOUNT_ARCHIVED',
          `Cannot activate archived account ${event.accountId}`);
      }
      state.activeAccountId = event.accountId;
      break;
    }

    case 'CREDITS_TRANSFERRED': {
      const fromAcc = state.accounts[event.fromAccountId];
      const toAcc = state.accounts[event.toAccountId];
      if (!fromAcc) {
        throw new EngineError('UNKNOWN_ACCOUNT',
          `From-account ${event.fromAccountId} does not exist`);
      }
      if (!toAcc) {
        throw new EngineError('UNKNOWN_ACCOUNT',
          `To-account ${event.toAccountId} does not exist`);
      }
      // Note: balance is allowed to go negative here. Normal flows pre-check
      // sufficient balance in the action layer; the only path to negative is
      // retroactive untick of past ticks whose credits were already moved or
      // spent, in which case "you spent energy you didn't have" is the
      // correct reading and the user's recovery path is to tick more.
      fromAcc.currentBalance -= event.amount;
      fromAcc.lifetimeEarned -= event.amount;
      toAcc.currentBalance += event.amount;
      toAcc.lifetimeEarned += event.amount;
      break;
    }

    case 'SESSION_GRANTED': {
      const account = state.accounts[event.accountId];
      if (!account) {
        throw new EngineError('UNKNOWN_ACCOUNT',
          `Account ${event.accountId} does not exist`);
      }
      // Note: balance is allowed to go negative here. See CREDITS_TRANSFERRED.
      // Lifetime earned does not decrease on session grants — that records
      // what the user has spent, which doesn't unhappen.
      account.currentBalance -= event.amount;
      break;
    }
  }
}


// -----------------------------------------------------------------------------
// Note: this module uses ES module exports. To use it from Node (e.g. for
// the original scenario test runner that uses CommonJS require), wrap or
// convert the runner accordingly, or keep a separate copy of the engine.
// -----------------------------------------------------------------------------
