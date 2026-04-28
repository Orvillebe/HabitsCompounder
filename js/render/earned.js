// ============================================================================
// render/earned.js
// ----------------------------------------------------------------------------
// Renders the Earned page: page-level toggle between Heaps and Calendar.
//
// Heaps view: per-account block with multiplier headline, Spendable / Total
// earned heaps, and Transfer / Grant action buttons.
//
// Calendar view: a single month grid showing each day classified by its
// earnings (skipped / maintenance / compounding). Tapping a day jumps to the
// Today page with that day selected.
// ============================================================================

import { getState } from '../state.js';
import * as actions from '../actions.js';
import {
  getEarnedView, setEarnedView,
  getCalendarMonth, setCalendarMonth,
  setSelectedDate, openSheet, closeSheet, showToast, goTo,
} from '../ui.js';
import { dayKey, todayKey, fmt, escapeHtml, MONTHS } from '../format.js';
import { classifyDayFromState } from '../engine.js';

// =====================================================================
// Heap rendering
// =====================================================================

const HEAP = {
  COIN_HEIGHT: 6,
  COIN_GAP: 1,
  HEAP_PADDING: 8,
  COLUMN_GAP: 6,
};

function coinsPerColumn(viewportEl) {
  const usable = viewportEl.clientHeight - HEAP.HEAP_PADDING * 2;
  return Math.max(4, Math.floor(usable / (HEAP.COIN_HEIGHT + HEAP.COIN_GAP)));
}

function computeColumnWidth(viewportEl, numColumns) {
  const usableWidth = viewportEl.clientWidth - HEAP.HEAP_PADDING * 2;
  const targetWidth = (usableWidth - (numColumns - 1) * HEAP.COLUMN_GAP) / numColumns;
  return Math.max(8, targetWidth);
}

function coinWidthFor(points, columnWidth, refMaxPoints) {
  const ratio = refMaxPoints > 0 ? Math.min(1, points / refMaxPoints) : 0;
  const scale = 0.3 + ratio * 0.7;
  return Math.max(6, columnWidth * scale);
}

// Build the per-account day arrays from the engine state.
// Returns { lifetimeDays, balanceDays } per account.
//   lifetimeDays: every day that earned credits, oldest first.
//   balanceDays: the most recent days summing roughly to the spendable balance
//                (FIFO mental model: oldest spent first).
//
// Reads from state.dayCredits, which is the engine's authoritative per-day
// per-account credit ledger. It's kept in sync by settleDayCredits as ticks
// happen during the day, and freezes at end-of-day for past dates.
function buildHeapsFromState(state) {
  // Walk dayCredits, building per-account day arrays.
  const perAccountDays = {}; // accountId -> [{ date, points }, ...] oldest first
  if (state.dayCredits) {
    const sortedDates = Object.keys(state.dayCredits).sort();
    for (const date of sortedDates) {
      const perAccount = state.dayCredits[date];
      for (const [accountId, points] of Object.entries(perAccount)) {
        if (points <= 0) continue;
        if (!perAccountDays[accountId]) perAccountDays[accountId] = [];
        perAccountDays[accountId].push({ date, points });
      }
    }
  }

  // For each account, compute balanceDays: most recent days summing to balance.
  const byAccount = {};
  for (const [accountId, account] of Object.entries(state.accounts || {})) {
    const lifetimeDays = perAccountDays[accountId] || [];
    // newest-first, then take prefix summing to currentBalance
    const newestFirst = [...lifetimeDays].reverse();
    const balance = Math.max(0, account.currentBalance);
    const balanceDays = [];
    let sum = 0;
    for (const d of newestFirst) {
      if (sum >= balance) break;
      balanceDays.push(d);
      sum += d.points;
    }
    byAccount[accountId] = {
      lifetimeDays: newestFirst,    // newest-first (matches what the heap renderer expects)
      balanceDays,                  // newest-first, prefix summing to balance
    };
  }

  return byAccount;
}

function packIntoColumns(coins, perColumn) {
  const columns = [];
  let current = [];
  for (const c of coins) {
    current.push(c);
    if (current.length >= perColumn) {
      columns.push(current);
      current = [];
    }
  }
  if (current.length > 0) columns.push(current);
  return columns;
}

function makeHeapColumn(coins, columnWidth, refMaxPoints) {
  const col = document.createElement('div');
  col.className = 'heap-column';
  col.style.width = columnWidth + 'px';
  for (const coin of coins) {
    const c = document.createElement('div');
    c.className = 'coin';
    c.style.width = coinWidthFor(coin.points, columnWidth, refMaxPoints) + 'px';
    col.appendChild(c);
  }
  return col;
}

function renderBalanceHeap(viewportEl, trackEl, days) {
  trackEl.innerHTML = '';
  if (days.length === 0) return;
  const perCol = coinsPerColumn(viewportEl);
  const columns = packIntoColumns(days, perCol);
  const numCols = Math.max(1, columns.length);
  const columnWidth = computeColumnWidth(viewportEl, numCols);
  const refMax = Math.max(...days.map(d => d.points));
  const reversed = [...columns].reverse();
  reversed.forEach(col => trackEl.appendChild(makeHeapColumn(col, columnWidth, refMax)));
}

function renderLifetimeHeap(viewportEl, trackEl, days) {
  trackEl.innerHTML = '';
  if (days.length === 0) return;
  const perCol = coinsPerColumn(viewportEl);
  const columns = packIntoColumns(days, perCol);
  const numCols = columns.length;
  const fitAllWidth = computeColumnWidth(viewportEl, numCols);
  const usableWidth = viewportEl.clientWidth - HEAP.HEAP_PADDING * 2;
  const minVisibleCols = 3;
  const widthForMinVisible = (usableWidth - (minVisibleCols - 1) * HEAP.COLUMN_GAP) / minVisibleCols;
  const columnWidth = numCols <= minVisibleCols ? fitAllWidth : widthForMinVisible;
  const refMax = Math.max(...days.map(d => d.points));
  columns.forEach(col => trackEl.appendChild(makeHeapColumn(col, columnWidth, refMax)));
}

// (heap day data now comes from buildHeapsFromState which derives from the engine's journal)

// =====================================================================
// Calendar rendering
// =====================================================================

// Day classification comes from the engine — single source of truth.
// classifyDayFromState handles both past (cached) and today (computed)
// using identical rules.

function renderCalendarGrid(state) {
  const { year, month } = getCalendarMonth();
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // Start week on Monday (European convention).
  const startingDow = (firstDay.getDay() + 6) % 7;
  const todayK = todayKey();
  const bigbangKey = state.firstEventAt
    ? dayKey(new Date(state.firstEventAt))
    : null;

  const dowLabels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  let html = `<div class="calendar-grid">`;
  for (const d of dowLabels) html += `<div class="calendar-dow">${d}</div>`;
  for (let i = 0; i < startingDow; i++) html += `<div class="calendar-cell empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, month, d);
    const key = dayKey(dt);
    const isFuture = key > todayK;
    const isPreBigbang = bigbangKey !== null && key < bigbangKey;
    let cls = '';
    let dataAttr = '';
    if (isFuture || isPreBigbang) {
      // Pre-bigbang and future days share the same treatment: faded and
      // not tappable. The user has no system state at those moments.
      cls = 'future';
    } else {
      cls = classifyDayFromState(state, key);
      dataAttr = `data-cal-date="${key}"`;
    }
    if (key === todayK) cls += ' is-today';
    html += `<div class="calendar-cell ${cls}" ${dataAttr}>${d}</div>`;
  }
  html += `</div>`;
  return html;
}

function renderViewToggle() {
  const view = getEarnedView();
  return `
    <div class="view-toggle-bar">
      <div class="view-toggle">
        <button class="${view === 'heaps' ? 'active' : ''}" data-view="heaps">Heaps</button>
        <button class="${view === 'calendar' ? 'active' : ''}" data-view="calendar">Calendar</button>
      </div>
    </div>
  `;
}

function renderMonthNav() {
  const { year, month } = getCalendarMonth();
  const label = `${MONTHS[month]} ${year}`;
  const today = new Date();
  const onCurrentMonth = year === today.getFullYear() && month === today.getMonth();

  // Disable prev arrow when going one month back would land entirely
  // before bigbang. Bigbang's calendar month is the earliest month the
  // user can navigate to.
  const state = getState();
  const bigbangKey = state.firstEventAt
    ? dayKey(new Date(state.firstEventAt))
    : null;
  let atOrBeforeBigbangMonth = false;
  if (bigbangKey) {
    const [by, bm] = bigbangKey.split('-').map(Number);
    const bigbangYear = by;
    const bigbangMonth = bm - 1;
    atOrBeforeBigbangMonth =
      year < bigbangYear ||
      (year === bigbangYear && month <= bigbangMonth);
  }

  return `
    <div class="month-nav">
      <div class="month-nav-arrow ${atOrBeforeBigbangMonth ? 'disabled' : ''}" data-month-dir="prev" title="Previous month">
        <svg viewBox="0 0 24 24"><polyline points="15 6 9 12 15 18"/></svg>
      </div>
      <div class="month-nav-label">${label}</div>
      <div class="month-nav-arrow ${onCurrentMonth ? 'disabled' : ''}" data-month-dir="next" title="Next month">
        <svg viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18"/></svg>
      </div>
    </div>
  `;
}

function renderCalendarLegend() {
  return `
    <div class="calendar-legend">
      <div class="legend-item"><div class="legend-swatch skipped"></div>Skipped</div>
      <div class="legend-item"><div class="legend-swatch maintenance"></div>Maintenance</div>
      <div class="legend-item"><div class="legend-swatch compounding"></div>Compounding</div>
    </div>
  `;
}

// =====================================================================
// Page render
// =====================================================================

export function render() {
  const state = getState();
  const root = document.getElementById('balances-content');
  const accounts = Object.entries(state.accounts);

  if (accounts.length === 0) {
    root.innerHTML = `
      <div class="empty-state">
        <span class="label">No accounts</span>
        <p>Create some in settings.</p>
        <button class="btn-link" data-go="settings">Go to settings →</button>
      </div>
    `;
    root.querySelectorAll('[data-go]').forEach(el =>
      el.addEventListener('click', () => goTo(el.dataset.go)));
    return;
  }

  const view = getEarnedView();

  if (view === 'calendar') {
    root.innerHTML = `
      ${renderViewToggle()}
      ${renderMonthNav()}
      ${renderCalendarLegend()}
      <div class="calendar-region">
        ${renderCalendarGrid(state)}
      </div>
    `;
  } else {
    root.innerHTML = `
      ${renderViewToggle()}
      <div class="balances-list">
        ${accounts.map(([id, account]) => `
          <div class="acct-block ${id === state.activeAccountId ? 'active' : ''}">
            <div class="acct-header">
              <span class="acct-name">${escapeHtml(account.name)}</span>
            </div>
            <div class="acct-mult-row">
              <span class="mult-display"><span class="x">×</span>${fmt(account.multiplier)}</span>
              <span class="mult-meta">grown <span class="num">+${fmt(account.multiplier - 1, 2)}</span> from baseline</span>
            </div>
            <div class="heap-region">
              <div class="heap-zone balance-zone">
                <div class="zone-header">
                  <span class="zone-label">Spendable</span>
                  <span class="zone-value">${fmt(account.currentBalance, 1)}</span>
                </div>
                <div class="heap-viewport">
                  <div class="heap-track" data-heap-balance="${id}"></div>
                </div>
              </div>
              <div class="heap-zone lifetime-zone">
                <div class="zone-header">
                  <span class="zone-label">Total earned</span>
                  <span class="zone-value">${fmt(account.lifetimeEarned, 1)}</span>
                </div>
                <div class="heap-viewport">
                  <div class="heap-track" data-heap-lifetime="${id}"></div>
                </div>
              </div>
            </div>
            <div class="actions-row">
              <button class="btn" data-transfer="${id}">Transfer</button>
              <button class="btn" data-grant="${id}">Grant session</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  attachToggleHandlers(root);
  attachMonthNavHandlers(root);
  attachCalendarCellHandlers(root);
  attachAccountActionHandlers(root, state);

  // Heaps render after DOM is in place so viewport sizes are known.
  if (view === 'heaps') {
    const heaps = buildHeapsFromState(state);
    requestAnimationFrame(() => {
      accounts.forEach(([id, account]) => {
        const balanceTrack = root.querySelector(`[data-heap-balance="${id}"]`);
        const lifetimeTrack = root.querySelector(`[data-heap-lifetime="${id}"]`);
        if (!balanceTrack || !lifetimeTrack) return;
        const balanceViewport = balanceTrack.parentElement;
        const lifetimeViewport = lifetimeTrack.parentElement;
        const days = heaps[id] || { balanceDays: [], lifetimeDays: [] };
        renderBalanceHeap(balanceViewport, balanceTrack, days.balanceDays);
        renderLifetimeHeap(lifetimeViewport, lifetimeTrack, days.lifetimeDays);
      });
    });
  }
}

function attachToggleHandlers(root) {
  root.querySelectorAll('.view-toggle button[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.view;
      if (v === getEarnedView()) return;
      setEarnedView(v);
      render();
    });
  });
}

function attachMonthNavHandlers(root) {
  root.querySelectorAll('.month-nav-arrow[data-month-dir]').forEach(el => {
    el.addEventListener('click', () => {
      if (el.classList.contains('disabled')) return;
      const dir = el.dataset.monthDir;
      const delta = dir === 'next' ? 1 : -1;
      let { year, month } = getCalendarMonth();
      month += delta;
      if (month > 11) { year++; month = 0; }
      if (month < 0) { year--; month = 11; }
      const today = new Date();
      if (year > today.getFullYear() || (year === today.getFullYear() && month > today.getMonth())) return;
      setCalendarMonth(year, month);
      render();
    });
  });
}

function attachCalendarCellHandlers(root) {
  root.querySelectorAll('.calendar-cell[data-cal-date]').forEach(el => {
    el.addEventListener('click', () => {
      setSelectedDate(el.dataset.calDate);
      goTo('working');
    });
  });
}

function attachAccountActionHandlers(root, state) {
  root.querySelectorAll('[data-transfer]').forEach(el => {
    el.addEventListener('click', () => openTransferSheet(el.dataset.transfer, state));
  });
  root.querySelectorAll('[data-grant]').forEach(el => {
    el.addEventListener('click', () => openGrantSheet(el.dataset.grant, state));
  });
  root.querySelectorAll('[data-go]').forEach(el => {
    el.addEventListener('click', () => goTo(el.dataset.go));
  });
}

// =====================================================================
// Sheets: transfer and grant
// =====================================================================

function openTransferSheet(fromId, state) {
  const fromAcc = state.accounts[fromId];
  const others = Object.entries(state.accounts).filter(([id]) => id !== fromId);
  if (others.length === 0) {
    showToast('No other account to transfer to', true);
    return;
  }
  openSheet(`
    <div class="sheet-title">Transfer credits</div>
    <div class="sheet-subject">From ${escapeHtml(fromAcc.name)}</div>
    <div class="sheet-form">
      <div class="form-row">
        <span class="field-name">To</span>
        <select id="transfer-to">${others.map(([id, a]) => `<option value="${id}">${escapeHtml(a.name)}</option>`).join('')}</select>
      </div>
      <div class="form-row">
        <span class="field-name">Amount (balance: ${fmt(fromAcc.currentBalance, 1)})</span>
        <input type="number" id="transfer-amount" min="0" step="0.1" inputmode="decimal" placeholder="0">
      </div>
    </div>
    <div class="sheet-actions">
      <button class="btn" data-action="cancel">Cancel</button>
      <button class="btn btn-primary" data-action="confirm">Transfer</button>
    </div>
  `);
  document.querySelector('[data-action="cancel"]').addEventListener('click', closeSheet);
  document.querySelector('[data-action="confirm"]').addEventListener('click', () => {
    const toId = document.getElementById('transfer-to').value;
    const amount = parseFloat(document.getElementById('transfer-amount').value);
    if (!amount || amount <= 0) return showToast('Enter a positive amount', true);
    if (amount > fromAcc.currentBalance) return showToast('Insufficient balance', true);
    actions.transferCredits(fromId, toId, amount);
    closeSheet();
    showToast(`Transferred ${fmt(amount, 1)}`);
  });
}

function openGrantSheet(accountId, state) {
  const account = state.accounts[accountId];
  openSheet(`
    <div class="sheet-title">Grant to session</div>
    <div class="sheet-subject">${escapeHtml(account.name)}</div>
    <div class="sheet-form">
      <div class="form-row">
        <span class="field-name">Amount (balance: ${fmt(account.currentBalance, 1)})</span>
        <input type="number" id="grant-amount" min="0" step="0.1" inputmode="decimal" placeholder="0">
      </div>
    </div>
    <p style="font-size: 0.78rem; color: var(--paper-muted); line-height: 1.4; margin-top: 0.5rem;">
      Granted credits leave the account permanently in v1.
    </p>
    <div class="sheet-actions">
      <button class="btn" data-action="cancel">Cancel</button>
      <button class="btn btn-primary" data-action="confirm">Grant</button>
    </div>
  `);
  document.querySelector('[data-action="cancel"]').addEventListener('click', closeSheet);
  document.querySelector('[data-action="confirm"]').addEventListener('click', () => {
    const amount = parseFloat(document.getElementById('grant-amount').value);
    if (!amount || amount <= 0) return showToast('Enter a positive amount', true);
    if (amount > account.currentBalance) return showToast('Insufficient balance', true);
    actions.grantToSession(accountId, amount);
    closeSheet();
    showToast(`Granted ${fmt(amount, 1)}`);
  });
}

// Re-render heaps on resize so they rescale to new viewport widths.
window.addEventListener('resize', () => {
  if (document.querySelector('.acct-block')) render();
});
