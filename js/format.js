// ============================================================================
// format.js
// ----------------------------------------------------------------------------
// Small pure helpers used across the app: date string conversion, number
// formatting, html escaping, month/day-of-week constants. No DOM access, no
// state access, no side effects. Same input always produces same output.
// ============================================================================

export const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Convert a Date or ISO string to a YYYY-MM-DD key in local time.
// Used as the canonical day identifier throughout the app: keys for
// per-day state maps (dayTicks, dayCredits, etc.), bucket lookups in
// the engine, and the date strip in the UI.
export function dayKey(input) {
  const d = input instanceof Date ? input : new Date(input);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Inverse of dayKey: parse a YYYY-MM-DD string back into a Date.
export function dateFromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayKey() {
  return dayKey(new Date());
}

// Human-readable label for a date, e.g. "Mon · Apr 27".
export function dateLabel(d) {
  return `${DAYS_OF_WEEK[d.getDay()]} · ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// Format a number for display. Integers stay integers; floats are rounded to
// `decimals` places and trailing zeros are stripped (so 1.10 becomes "1.1").
export function fmt(n, decimals = 2) {
  if (n === null || n === undefined) return '—';
  if (Number.isInteger(n)) return n.toString();
  return Number(n.toFixed(decimals)).toString();
}

// Escape a string for safe inclusion in HTML.
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
