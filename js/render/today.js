// ============================================================================
// render/today.js
// ----------------------------------------------------------------------------
// Renders the Today page: account header, date nav, progress bar, task list.
// Reads from state. Handler events trigger actions; never mutates directly.
// ============================================================================

import { getState } from '../state.js';
import * as actions from '../actions.js';
import { getSelectedDate, setSelectedDate, goTo } from '../ui.js';
import { dayKey, dateFromKey, todayKey, dateLabel, fmt, escapeHtml } from '../format.js';
import { DEFAULT_EARNING_MINIMUM, DEFAULT_MULTIPLIER_MINIMUM, classifyDayFromState } from '../engine.js';

// --- Threshold-crossing celebration ---
//
// When a tick crosses today's classification upward into maintenance or
// compounding, the action layer renders first, then calls playCrossing
// once the bar DOM is in place. Same animation parameterized by `kind`
// (CSS class drives color); no module state, no queue.

const CROSSING_LABELS = {
  maintenance: 'Maintenance',
  compounding: 'Compounding',
};

export function playCrossing(kind, delta) {
  const label = CROSSING_LABELS[kind];
  if (!label) return;

  const root = document.getElementById('working-content');
  if (!root) return;
  const marker = root.querySelector(`.prog-milestone[data-threshold="${kind}"]`);
  if (!marker) return;
  const bar = marker.closest('.prog-bar-base');
  if (!bar) return;

  // Flash overlay sized to the current fill width. Measured from layout,
  // not by parsing inline styles, so it stays correct even if the bar
  // markup changes shape.
  const barRect = bar.getBoundingClientRect();
  const zones = bar.querySelectorAll(
    '.prog-zone-pre-earn, .prog-zone-earning, .prog-zone-compounding'
  );
  let fillRight = barRect.left;
  for (const z of zones) {
    const r = z.getBoundingClientRect();
    if (r.right > fillRight) fillRight = r.right;
  }
  const fillPct = barRect.width > 0
    ? Math.max(0, Math.min(100, ((fillRight - barRect.left) / barRect.width) * 100))
    : 0;

  const flash = document.createElement('div');
  flash.className = `bar-flash crossing-${kind}`;
  flash.style.width = fillPct + '%';
  bar.appendChild(flash);
  // Two RAFs ensure initial styles paint before the transition.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    flash.classList.add('fade');
  }));
  setTimeout(() => flash.remove(), 700);

  spawnSparkle(marker, kind);
  showCrossingToast(`${label} +${fmt(delta)}`, kind);
}

function spawnSparkle(anchor, kind) {
  const stage = document.getElementById('working-content');
  if (!stage) return;
  const stageRect = stage.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const cx = anchorRect.left - stageRect.left + anchorRect.width / 2;
  const cy = anchorRect.top - stageRect.top + anchorRect.height / 2;

  for (let i = 0; i < 10; i++) {
    const dot = document.createElement('div');
    dot.className = `sparkle-dot crossing-${kind}`;
    dot.style.left = cx + 'px';
    dot.style.top = cy + 'px';
    stage.appendChild(dot);
    const angle = (Math.PI * 2 * i) / 10 + (Math.random() - 0.5) * 0.3;
    const dist = 18 + Math.random() * 20;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      dot.style.transform = `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px)`;
      dot.style.opacity = '0';
    }));
    setTimeout(() => dot.remove(), 750);
  }
}

function showCrossingToast(text, kind) {
  const toast = document.createElement('div');
  toast.className = `crossing-toast crossing-${kind}`;
  toast.textContent = text;
  document.body.appendChild(toast);
  // Force reflow so the show class triggers a transition from the initial state.
  void toast.offsetWidth;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 350);
  }, 1400);
}

export function render() {
  const state = getState();
  const root = document.getElementById('working-content');
  const account = state.accounts[state.activeAccountId];

  if (!account) {
    root.innerHTML = `
      <div class="working-header">
        <div class="account-strip">
          <span class="account-name" style="color: var(--paper-muted);">No account</span>
        </div>
      </div>
      ${renderDateNav()}
      <div class="empty-state">
        <span class="label">Setup needed</span>
        <p>Set an active account in settings to start ticking tasks.</p>
        <button class="btn-link" data-go="settings">Go to settings →</button>
      </div>
    `;
    attachDateNavHandlers(root);
    attachNonAccountHandlers(root);
    return;
  }

  const selectedDate = getSelectedDate();
  const viewingToday = selectedDate === todayKey();
  const earningMinimum = state.earningMinimum ?? DEFAULT_EARNING_MINIMUM;
  const multiplierMinimum = state.multiplierMinimum ?? DEFAULT_MULTIPLIER_MINIMUM;
  const dateLabelStr = viewingToday ? 'Today' : dateLabel(dateFromKey(selectedDate));
  const ticksThisDay = state.dayTicks[selectedDate] || {};

  // Compute habituated vs non-habituated points for the selected day.
  // A task is "habituated for this day" if its habituatedAt is strictly before
  // the day starts. This uses 00:00 of the selected day as the boundary;
  // it's a display approximation, not the engine's per-tick rule.
  const dayStart = (() => {
    const d = dateFromKey(selectedDate);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  })();
  let habPoints = 0;
  let nonHabPoints = 0;
  for (const id in ticksThisDay) if (ticksThisDay[id]) {
    const t = state.tasks[id];
    if (!t) continue;
    if (t.habituatedAt && t.habituatedAt < dayStart) {
      habPoints += t.weight;
    } else {
      nonHabPoints += t.weight;
    }
  }
  const totalPoints = habPoints + nonHabPoints;

  // Classification and crediting come from the engine — single source of
  // truth for the rules. Reached flags are derivations of the classification,
  // not re-encodings of the threshold logic.
  const classification = classifyDayFromState(state, selectedDate);
  const reachedEarn = classification === 'maintenance' || classification === 'compounding';
  const reachedCompounding = classification === 'compounding';

  // The multiplier in force on the selected date. For today (not yet
  // processed at midnight) this is the current account multiplier. For
  // past days the engine recorded the day-start value in dayMultipliers.
  const multiplierForDay = (state.dayMultipliers
    && state.dayMultipliers[selectedDate]
    && state.dayMultipliers[selectedDate][state.activeAccountId] !== undefined)
    ? state.dayMultipliers[selectedDate][state.activeAccountId]
    : account.multiplier;

  // Credits earned on the selected day for the active account — read from
  // the engine's per-day per-account ledger, which settleDayCredits keeps
  // in sync as ticks happen.
  const credits = state.dayCredits?.[selectedDate]?.[state.activeAccountId] ?? 0;

  // Whether any task was already habituated as of the start of the selected
  // day (controls split-bar layout). On past dates from before any
  // habituation, this is false → single bar is shown.
  const anyHabituated = Object.values(state.tasks)
    .some(t => !t.archived && t.habituatedAt && t.habituatedAt < dayStart);

  // Build the calculation line.
  const calculation = buildCalculation(
    state, ticksThisDay, dayStart, reachedEarn, reachedCompounding, multiplierForDay, credits
  );

  // On past dates, surface where the day's credits actually went if the
  // currently active account isn't a recipient. This avoids the misread
  // where the header says "Acc 2" but the day's points actually went to
  // Acc 1 (or another account that was active that day). We also show each
  // recipient's multiplier at the start of that day, so the user can see
  // why the credits totalled what they totalled.
  const dayCreditsForDate = state.dayCredits?.[selectedDate] ?? {};
  const dayMultipliersForDate = state.dayMultipliers?.[selectedDate] ?? {};
  const recipientIds = Object.keys(dayCreditsForDate);
  const showCreditDisclosure =
    !viewingToday &&
    recipientIds.length > 0 &&
    !(state.activeAccountId in dayCreditsForDate);
  const creditDisclosureLine = showCreditDisclosure
    ? `<div class="credit-disclosure">Credits went to ${recipientIds
        .map(id => {
          const name = escapeHtml(state.accounts[id]?.name ?? '(removed)');
          const mult = dayMultipliersForDate[id];
          return mult !== undefined
            ? `${name} (×${fmt(mult)})`
            : name;
        })
        .join(', ')}</div>`
    : '';

  root.innerHTML = `
    <div class="working-header">
      <div class="account-strip">
        <span class="account-name">${escapeHtml(account.name)}</span>
        <span class="multiplier">×${fmt(multiplierForDay)}</span>
      </div>
      ${creditDisclosureLine}
    </div>
    ${renderDateNav()}
    <div class="progress">
      <div class="prog-meta-row">
        <span class="label-mini">${dateLabelStr}</span>
        <div class="prog-earned-block">
          <span class="prog-earned-label">Total earned</span>
          <span class="prog-calc">${calculation}</span>
        </div>
      </div>
      ${anyHabituated
        ? renderSplitBars(totalPoints, nonHabPoints, earningMinimum, multiplierMinimum, reachedEarn, reachedCompounding)
        : renderSingleBar(totalPoints, earningMinimum, multiplierMinimum, reachedEarn, reachedCompounding)}
    </div>
    ${renderTaskList(state, ticksThisDay, dayStart)}
  `;

  attachDateNavHandlers(root);
  attachTaskHandlers(root, account);
  attachNonAccountHandlers(root);

  // First render after habituation has rolled into a new day: explain the
  // split bars in context. Fires only when viewing today (not when the user
  // is browsing past dates) and only once ever.
  maybeShowBarsExplainer(state, dayStart);
}

const BARS_EXPLAINER_KEY = 'habits-bars-explainer-shown-v1';

function maybeShowBarsExplainer(state, dayStart) {
  if (getSelectedDate() !== todayKey()) return;
  if (localStorage.getItem(BARS_EXPLAINER_KEY)) return;
  // Need at least one task that habituated before today's start.
  const hasHabBeforeToday = Object.values(state.tasks).some(
    t => !t.archived && t.habituatedAt && t.habituatedAt < dayStart
  );
  if (!hasHabBeforeToday) return;

  // Set the flag now, before showing. The sheet can be dismissed via the OK
  // button, the overlay, or any future close path — once the user has seen
  // it, we're done. Writing on dismissal would re-fire the sheet on every
  // render until they happen to use the OK button.
  localStorage.setItem(BARS_EXPLAINER_KEY, '1');
  showBarsExplainerSheet();
}

function showBarsExplainerSheet() {
  // Imported lazily so we don't touch the DOM on hot paths.
  Promise.all([
    import('../ui.js'),
    import('./habituation-content.js'),
  ]).then(([{ openSheet, closeSheet }, { barsExplainerSheetHtml }]) => {
    openSheet(barsExplainerSheetHtml());
    document.querySelector('[data-act="bars-ok"]').addEventListener('click', closeSheet);
  });
}

// Build the calculation string shown above the bars.
// Format: "(a+b) + (c+d) × 1.20 = 9.4 pts"  (in mult regime, mixed)
//         "(a+b+c) = 6 pts"                 (flat regime)
//         "0 pts"                           (below earn min)
// Single-tick groups don't get parens; empty groups are dropped.
function buildCalculation(state, ticks, dayStart, reachedEarn, reachedCompounding, multiplier, credits) {
  if (!reachedEarn) return '0 pts';

  // Collect weights of ticked tasks today, split into hab and non-hab.
  const habWeights = [];
  const nonHabWeights = [];
  for (const id in ticks) if (ticks[id]) {
    const t = state.tasks[id];
    if (!t) continue;
    if (t.habituatedAt && t.habituatedAt < dayStart) {
      habWeights.push(t.weight);
    } else {
      nonHabWeights.push(t.weight);
    }
  }

  // Sort each group ascending so the formula reads small-to-large within a group.
  habWeights.sort((a, b) => a - b);
  nonHabWeights.sort((a, b) => a - b);

  const fmtGroup = ws => ws.length === 1 ? `${ws[0]}` : `(${ws.join('+')})`;
  const parts = [];
  if (habWeights.length > 0) parts.push(fmtGroup(habWeights));
  if (nonHabWeights.length > 0) {
    const nhStr = fmtGroup(nonHabWeights);
    parts.push(reachedCompounding ? `${nhStr} × ${fmt(multiplier)}` : nhStr);
  }
  const formula = parts.join(' + ');
  const total = fmt(credits, credits % 1 === 0 ? 0 : 1);
  return `${formula} = <strong>${total}</strong> pts`;
}

// Single-bar layout (no habituated tasks yet).
// Total points fill, with both milestones on one bar.
function renderSingleBar(totalPoints, earningMinimum, multiplierMinimum, reachedEarn, reachedCompounding) {
  const barMax = multiplierMinimum > 0 ? multiplierMinimum * 2 : 1;
  const earningMinimumPct = Math.min(100, (earningMinimum / barMax) * 100);
  const multiplierMinimumPct = Math.min(100, (multiplierMinimum / barMax) * 100);
  const fillPct = Math.min(100, (totalPoints / barMax) * 100);

  // Color zones inside the fill: rust below earn min, cream between, green at/above mult min.
  const preEarnEnd = Math.min(fillPct, earningMinimumPct);
  const earningEndPct = Math.min(fillPct, multiplierMinimumPct);
  const compoundingEndPct = fillPct;

  // Caption is centered on the fill end (where the fill meets the empty
  // portion). clamp() keeps it from clipping off either edge of the bar.
  // Half-width is ~55px, derived from the caption's typical width (~110px).
  const captionLeftStyle = `left: clamp(55px, ${fillPct}%, calc(100% - 55px))`;

  return `
    <div class="prog-caption-track">
      <div class="prog-ticked-caption" style="${captionLeftStyle}"><span class="num">${totalPoints}</span> ${totalPoints === 1 ? 'point' : 'points'} ticked</div>
    </div>
    <div class="prog-track-wrap">
      <div class="prog-bar-base">
        <div class="prog-zone-pre-earn" style="left:0; width:${preEarnEnd}%"></div>
        <div class="prog-zone-earning" style="left:${preEarnEnd}%; width:${earningEndPct - preEarnEnd}%"></div>
        <div class="prog-zone-compounding" style="left:${earningEndPct}%; width:${compoundingEndPct - earningEndPct}%"></div>
        <div class="prog-milestone ${reachedEarn ? 'passed' : ''}" data-threshold="maintenance" style="left:${earningMinimumPct}%"></div>
        <div class="prog-milestone ${reachedCompounding ? 'passed' : ''}" data-threshold="compounding" style="left:${multiplierMinimumPct}%"></div>
      </div>
      <div class="prog-milestone-label" style="left:${earningMinimumPct}%">maint <span class="num">${earningMinimum}</span></div>
      <div class="prog-milestone-label" style="left:${multiplierMinimumPct}%">compound <span class="num">${multiplierMinimum}</span></div>
    </div>
  `;
}

// Split-bar layout (any task habituated).
// Top bar: total points, milestone earn min, rust→cream
// Bottom bar: non-habituated points, milestone mult min, rust→green
function renderSplitBars(totalPoints, nonHabPoints, earningMinimum, multiplierMinimum, reachedEarn, reachedCompounding) {
  // Top bar scales 0 to earningMinimum*2 (so the milestone sits at half).
  const topMax = earningMinimum > 0 ? earningMinimum * 2 : 1;
  const topFillPct = Math.min(100, (totalPoints / topMax) * 100);
  const earningMinimumPct = Math.min(100, (earningMinimum / topMax) * 100);

  // Bottom bar scales 0 to multiplierMinimum*2.
  const botMax = multiplierMinimum > 0 ? multiplierMinimum * 2 : 1;
  const botFillPct = Math.min(100, (nonHabPoints / botMax) * 100);
  const multiplierMinimumPct = Math.min(100, (multiplierMinimum / botMax) * 100);

  return `
    <div class="prog-stack">
      <div class="prog-row">
        <span class="prog-row-label">total<br><span class="prog-row-num">${totalPoints}</span></span>
        <div class="prog-track-wrap split">
          <div class="prog-bar-base">
            <div class="prog-zone-pre-earn" style="left:0; width:${Math.min(topFillPct, earningMinimumPct)}%"></div>
            <div class="prog-zone-earning" style="left:${Math.min(topFillPct, earningMinimumPct)}%; width:${Math.max(0, topFillPct - earningMinimumPct)}%"></div>
            <div class="prog-milestone ${reachedEarn ? 'passed' : ''}" data-threshold="maintenance" style="left:${earningMinimumPct}%"></div>
          </div>
          <div class="prog-milestone-label" style="left:${earningMinimumPct}%">maint <span class="num">${earningMinimum}</span></div>
        </div>
      </div>
      <div class="prog-row">
        <span class="prog-row-label">new habits<br><span class="prog-row-num">${nonHabPoints}</span></span>
        <div class="prog-track-wrap split">
          <div class="prog-bar-base">
            <div class="prog-zone-pre-earn" style="left:0; width:${Math.min(botFillPct, multiplierMinimumPct)}%"></div>
            <div class="prog-zone-compounding" style="left:${Math.min(botFillPct, multiplierMinimumPct)}%; width:${Math.max(0, botFillPct - multiplierMinimumPct)}%"></div>
            <div class="prog-milestone ${reachedCompounding ? 'passed' : ''}" data-threshold="compounding" style="left:${multiplierMinimumPct}%"></div>
          </div>
          <div class="prog-milestone-label" style="left:${multiplierMinimumPct}%">compound <span class="num">${multiplierMinimum}</span></div>
        </div>
      </div>
    </div>
  `;
}

// Single source of truth for whether each date nav arrow is disabled.
// Both renderDateNav (visual) and attachDateNavHandlers (behavior) read
// from these so they can't drift apart.
function isPrevDisabled(state, selectedDate) {
  // No events ever recorded means there's no past to navigate to. Once
  // there's a first event, the calendar day of that event is "bigbang"
  // and we lock at or before that day.
  if (!state.firstEventAt) return true;
  const bigbangKey = dayKey(new Date(state.firstEventAt));
  return selectedDate <= bigbangKey;
}

function isNextDisabled(selectedDate) {
  return selectedDate >= todayKey();
}

function renderDateNav() {
  const selectedDate = getSelectedDate();
  const state = getState();
  const isTod = selectedDate === todayKey();
  const labelText = isTod ? 'Today' : dateLabel(dateFromKey(selectedDate));
  const prevDisabled = isPrevDisabled(state, selectedDate);
  const nextDisabled = isNextDisabled(selectedDate);

  return `
    <div class="date-nav">
      <div class="date-nav-arrow ${prevDisabled ? 'disabled' : ''}" data-direction="prev" title="Previous day">
        <svg viewBox="0 0 24 24"><polyline points="15 6 9 12 15 18"/></svg>
      </div>
      <div class="date-nav-label ${isTod ? 'is-today' : ''}">${labelText}</div>
      <div class="date-nav-arrow ${nextDisabled ? 'disabled' : ''}" data-direction="next" title="Next day">
        <svg viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18"/></svg>
      </div>
    </div>
  `;
}

function renderTaskList(state, ticksThisDay, dayStart) {
  const tasks = Object.entries(state.tasks)
    .filter(([_, t]) => !t.archived)
    .sort((a, b) => {
      if (a[1].weight !== b[1].weight) return a[1].weight - b[1].weight;
      return a[1].name.localeCompare(b[1].name);
    });

  if (tasks.length === 0) {
    return `
      <div class="empty-state">
        <span class="label">No tasks yet</span>
        <p>Create some in settings to start.</p>
        <button class="btn-link" data-go="settings">Go to settings →</button>
      </div>
    `;
  }

  // Group tasks by weight.
  const groups = {};
  for (const [id, t] of tasks) {
    if (!groups[t.weight]) groups[t.weight] = [];
    groups[t.weight].push([id, t]);
  }
  const sortedWeights = Object.keys(groups).map(Number).sort((a, b) => a - b);
  for (const w of sortedWeights) {
    groups[w].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }
  return sortedWeights.map(w => {
    const groupTasks = groups[w].map(([id, t]) => {
      const checked = !!ticksThisDay[id];
      // Habituation as seen on the selected date, not "now". A task ticked
      // on April 10 isn't habituated yet if its habituatedAt is April 23.
      const habituated = !!t.habituatedAt && t.habituatedAt < dayStart;
      return `
        <div class="task ${checked ? 'checked' : ''} ${habituated ? 'habituated' : ''}" data-task-id="${id}">
          <div class="checkbox"></div>
          <div class="task-body">
            <span class="task-name">${escapeHtml(t.name)}</span>
            ${habituated ? '<span class="task-habituated-mark">✓</span>' : ''}
          </div>
        </div>
      `;
    }).join('');
    return `
      <div class="task-group-header">${w} ${w === 1 ? 'pt' : 'pts'}</div>
      ${groupTasks}
    `;
  }).join('');
}

function attachDateNavHandlers(root) {
  root.querySelectorAll('.date-nav-arrow[data-direction]').forEach(el => {
    el.addEventListener('click', () => {
      // The .disabled class is the single source of truth. renderDateNav
      // applies it via isPrevDisabled / isNextDisabled.
      if (el.classList.contains('disabled')) return;
      const dir = el.dataset.direction;
      const d = dateFromKey(getSelectedDate());
      d.setDate(d.getDate() + (dir === 'next' ? 1 : -1));
      setSelectedDate(dayKey(d));
      render();
    });
  });
  // Tap the date label to jump back to today.
  const label = root.querySelector('.date-nav-label');
  if (label && !label.classList.contains('is-today')) {
    label.addEventListener('click', () => {
      setSelectedDate(todayKey());
      render();
    });
  }
}

function attachTaskHandlers(root, account) {
  root.querySelectorAll('.task[data-task-id]').forEach(el => {
    const id = el.dataset.taskId;
    el.addEventListener('click', () => {
      const date = getSelectedDate();
      actions.toggleTick(id, date);
      // No toast: the bar fill and calculation line above the bar give
      // immediate visual feedback. Backfilled days show via the date nav.
    });
  });
}

function attachNonAccountHandlers(root) {
  root.querySelectorAll('[data-go]').forEach(el => {
    el.addEventListener('click', () => goTo(el.dataset.go));
  });
}
