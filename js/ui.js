// ============================================================================
// ui.js
// ----------------------------------------------------------------------------
// UI-only state and helpers: the currently selected date on the Today page,
// the current view on the Earned page (heaps vs calendar), the calendar's
// current month, and the sheet/toast primitives.
//
// This is in-memory only and resets on page reload, by design — the URL hash
// is the only navigation state we persist across sessions.
// ============================================================================

import { todayKey } from './format.js';

// Selected date on Today page.
let _selectedDate = todayKey();
export function getSelectedDate() { return _selectedDate; }
export function setSelectedDate(date) { _selectedDate = date; }

// Earned page view: 'heaps' or 'calendar'.
let _earnedView = 'heaps';
export function getEarnedView() { return _earnedView; }
export function setEarnedView(view) { _earnedView = view; }

// Currently displayed month on the calendar view.
const _today = new Date();
let _calendarMonth = { year: _today.getFullYear(), month: _today.getMonth() };
export function getCalendarMonth() { return _calendarMonth; }
export function setCalendarMonth(year, month) { _calendarMonth = { year, month }; }

// --- Sheet helpers ---

export function openSheet(html) {
  document.getElementById('sheet-content').innerHTML = html;
  document.getElementById('sheet').classList.add('active');
  document.getElementById('sheet-overlay').classList.add('active');
}

export function closeSheet() {
  document.getElementById('sheet').classList.remove('active');
  document.getElementById('sheet-overlay').classList.remove('active');
}

// --- Toast ---

let _toastTimeout = null;

export function showToast(message, isError = false) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = message;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  if (_toastTimeout) clearTimeout(_toastTimeout);
  _toastTimeout = setTimeout(() => t.classList.remove('show'), 2000);
}

// --- Hash navigation ---

export function goTo(pageName) {
  location.hash = pageName;
}
