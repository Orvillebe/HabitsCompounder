# Habits

Personal habit-tracking app with a compounding-multiplier mechanic. Static
site, no build step, deployable to GitHub Pages or any static host.

## Running

Because the app uses ES modules, it must be served over HTTP, not opened
directly with `file://`.

```
cd habits-app
npx serve
```

Then visit the URL printed (usually `http://localhost:3000`). On first load
the app will show "No account" — go to Settings, create an account, and
add some tasks to start.

## File structure

```
habits-app/
  index.html            — page structure only, links to css and js module
  styles.css            — all styling
  js/
    main.js             — entry point: init, hash routing, renderAll(),
                          habituation notification handler
    engine.js           — the replay engine (ES module)
    state.js            — runtime: holds event log + cached state, fires
                          listeners on habituation transitions
    actions.js          — verbs (toggleTick, transferCredits, ...) → events
    storage.js          — Storage interface, localStorage implementation
    format.js           — pure helpers (dates, numbers, escaping)
    ui.js               — UI-only state (selected date, view mode, sheets, toast)
    render/
      today.js          — Today page (date nav, progress, task list)
      earned.js         — Earned page (heaps + calendar)
      settings.js       — Settings page
```

## Architecture (git-like)

The source of truth is an **event log**. Every user action becomes an
immutable event appended to the log. State (multipliers, balances, ticks
per day) is **derived** from the event log by `engine.replay(events)` —
never stored, always recomputed.

Backfilling = inserting an event with an earlier semantic date (`at`
timestamp). The engine handles it the same as any other event; replay
produces the correct state, including retroactive recomputation of
multipliers and day classifications.

### Flow on every user action

1. Render layer detects a click → calls `actions.toggleTick(taskId, date)`.
2. **actions.js** constructs the event, calls `state.appendEvent(event)`.
3. **state.js** pushes to the log, calls `storage.saveEvents()`, calls
   `engine.replay()` to get the new state, caches it, fires habituation
   listeners if any task just transitioned.
4. Action calls `renderAll()`, which redraws the visible page.

No render function ever mutates state. No action ever touches the DOM.

## Today page: progress bar

The progress section on the Today page adapts to whether any tasks are
currently habituated.

**Single bar (no habituated tasks yet):** total points fill, three color
zones (rust below earn min, cream between, green at/above mult min), two
milestone markers.

**Split bars (any task habituated):**
- Top bar: total points, milestone earn min, rust → cream
- Bottom bar: non-habituated points only, milestone mult min, rust → green

Above the bar(s) is a calculation line showing how today's credits are
computed:
- Below earn min: `0 pts`
- Below mult min: `(2+3) = 5 pts`  (flat)
- At/above mult min: `1 + (2+3) × 1.20 = 7 pts`  (hab + non-hab × multiplier)

Habituated and non-habituated weights are summed into separate parenthesised
groups; only the non-hab group gets the multiplier.

## Habituation

When a task crosses the habituation threshold (default 66 ticks), the engine
sets `habituatedAt` and the frontend shows a celebration sheet. From the
following day, that task:
- Counts toward total points (and thus toward earn min and maintenance status)
- Does NOT count toward compounding (non-hab points must reach mult min on
  their own)
- Credits at flat rate (no multiplier)

Untick correctly drops habituation if the count falls back below threshold.

## Day classifications (from the engine)

| State | Definition | Multiplier behavior |
|---|---|---|
| Skipped | total points < earn min | First in row freezes, subsequent decay |
| Maintenance | total ≥ earn min but non-hab < mult min | Holds, skip counter resets |
| Compounding | non-hab points ≥ mult min | Grows by increment, skip counter resets |

## Event types (engine vocabulary)

| Event | Purpose |
|-------|---------|
| `EARNING_MINIMUM_SET` | Set the minimum daily points to earn anything |
| `MULTIPLIER_MINIMUM_SET` | Set the minimum daily points to grow multiplier |
| `INCREMENT_SET` | Set how much the multiplier grows per compounding day |
| `HABIT_THRESHOLD_SET` | Set ticks needed to habituate a task |
| `TASK_CREATED` / `TASK_EDITED` / `TASK_ARCHIVED` | Task lifecycle |
| `TASK_TICKED` | Tick a task (has both `at` and `recordedAt`) |
| `TASK_UNTICKED` | Reverse a previous tick on the same `at` |
| `ACCOUNT_CREATED` / `ACCOUNT_RENAMED` / `ACCOUNT_ARCHIVED` / `ACCOUNT_ACTIVATED` | Account lifecycle |
| `CREDITS_TRANSFERRED` | Move credits between accounts |
| `SESSION_GRANTED` | Spend credits from an account |

## Swapping pieces

- **localStorage → DB**: replace the `makeLocalStorageBackend()` factory
  in `storage.js` with a different implementation. The interface (`loadEvents`,
  `saveEvents`, `clear`) stays the same; nothing else changes.
- **Engine**: `engine.js` is a pure ES module with `replay(events) → state`.
  Replacing it requires only that the new version produces the same state
  shape and accepts the same event vocabulary.

## Notes

- The day classification logic follows the engine's strict definition of
  skipped/maintenance/compounding. With no habituated tasks, maintenance is
  rare (it requires habituated points to top up the day). To experience the
  full range of behaviors, lower the habit threshold in Settings (e.g. 10) so
  habituation triggers faster.
- `recordedAt` is always now (when the user actually performs the action).
  `at` is when the tick semantically happened — for backfilled ticks, `at` is
  in the past while `recordedAt` is now. This is the engine's git-like model.

## Future considerations

- **Unarchive.** Archived tasks and accounts are filtered from the UI but
  their data lives on in the event log. There's currently no way to bring
  one back through the UI; the workaround is to create a fresh task or
  account, which loses tick count and habituation continuity. If unarchive
  is needed later, it's a small addition: a new event type
  (`TASK_UNARCHIVED` / `ACCOUNT_UNARCHIVED`) that flips the flag back, plus
  a way to surface archived items in settings so the user can pick one to
  restore.

## Archive

Tasks and accounts can be **archived**. Archive is a soft flag
(`archived: true`); the underlying record stays in state, all historical
ticks remain attributed to the task, journal entries crediting an archived
account stay intact, and past day classifications don't shift. Archived
items are simply hidden from the active task / account lists.

Constraints on archiving an account:
- Refused if it's the currently active account (switch first).
- Refused if it's the only non-archived account (create another and
  activate it first).

The engine raises an `ACCOUNT_ARCHIVED` error if you ever try to activate
an archived account, and a `TASK_ARCHIVED` error on attempts to tick or
edit an archived task.

## Bigbang lockout

History only starts at the user's first event. The earliest `recordedAt`
in the log defines "bigbang day" (in local time). Date navigation cannot
go before this:
- Today page: the previous-day arrow disables on bigbang day.
- Earned calendar: dates before bigbang are faded and not tappable.
- `actions.toggleTick` defensively refuses ticks dated before bigbang.

This is by design. Pre-bigbang dates have no meaningful state to evaluate
against — there were no settings, no tasks, no account at those moments.

## Future considerations

**Unarchive.** Currently archive is one-way from the user's perspective:
once archived, the task or account stays archived, and the user has to
create a new one if they want similar functionality back. The data is
fully preserved in the event log, so an `UNARCHIVE` event type could be
added with minimal effort. The reason to defer is UX: where unarchiving
lives in the UI, how it interacts with habit tickCount continuity (an
unarchived task keeps its tickCount and habituation date — desirable for
streak continuity, but worth thinking through).
