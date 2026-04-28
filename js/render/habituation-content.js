// ============================================================================
// habituation-content.js
// ----------------------------------------------------------------------------
// All user-facing copy and visuals related to the habituation moment. Pulled
// out of render code so wording lives in one place — both the today-of-
// habituation sheet (main.js) and the next-day bar-explainer sheet
// (render/today.js) read from here.
// ============================================================================

import { escapeHtml } from '../format.js';

// Stylized illustration of the split-bar layout. Generic, not data-driven.
// Uses the same colors as the live bars for visual continuity.
export function splitBarsIllustration() {
  return `
    <svg class="hab-illustration" viewBox="0 0 280 110" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Two stacked progress bars">
      <text x="0" y="12" class="hab-illus-label">TOTAL</text>
      <rect x="0" y="20" width="280" height="10" rx="0" class="hab-illus-bar-bg"/>
      <rect x="0" y="20" width="180" height="10" rx="0" class="hab-illus-fill-cream"/>
      <line x1="80" y1="16" x2="80" y2="34" class="hab-illus-milestone"/>
      <text x="80" y="46" class="hab-illus-marker" text-anchor="start">MAINT</text>

      <text x="0" y="72" class="hab-illus-label">NEW HABITS</text>
      <rect x="0" y="80" width="280" height="10" rx="0" class="hab-illus-bar-bg"/>
      <rect x="0" y="80" width="140" height="10" rx="0" class="hab-illus-fill-green"/>
      <line x1="120" y1="76" x2="120" y2="94" class="hab-illus-milestone"/>
      <text x="120" y="106" class="hab-illus-marker" text-anchor="start">COMPOUND</text>
    </svg>
  `;
}

// One-line summary of how new vs old habits relate to the multiplier.
// Used in both sheet variants so the same idea is phrased the same way.
export const OLD_VS_NEW_LINE =
  'Your old habits will still help keep your maintenance up; but only your new habits grow your multiplier.';

// Sentence describing what becomes of the just-habituated tasks. Variant
// for singular / plural.
export function flatPointsLine(taskCount) {
  const subject = taskCount === 1 ? 'This habit' : 'These habits';
  const possessive = taskCount === 1 ? 'Its' : 'Their';
  return `${subject} will count toward maintenance, but no longer toward the multiplier. ${possessive} points will flow flat instead of multiplied.`;
}

// Habit-formation sheet body. Used by main.js when one or more tasks just
// crossed the habituation threshold.
//
// Two variants:
//   - first-ever habituation: heavier introduction with the bar illustration
//     and the old-vs-new framing
//   - subsequent habituations: just the celebration and the flat-points note
export function habituationSheetHtml(tasks, isFirstEver) {
  const heading = tasks.length === 1
    ? 'You have formed a new habit'
    : `You have formed ${tasks.length} new habits`;

  const taskList = tasks.map(t =>
    `<div class="hab-task">${escapeHtml(t.name)} <span class="hab-weight">${t.weight} ${t.weight === 1 ? 'pt' : 'pts'}</span></div>`
  ).join('');

  const explainer = isFirstEver
    ? `
      <p class="hab-explanation">
        From tomorrow, the Today page splits into two bars. ${OLD_VS_NEW_LINE}
      </p>
      ${splitBarsIllustration()}
      <p class="hab-explanation">${flatPointsLine(tasks.length)}</p>
    `
    : `
      <p class="hab-explanation">${flatPointsLine(tasks.length)}</p>
    `;

  return `
    <div class="sheet-title">${heading}</div>
    <div class="sheet-subject">Congratulations.</div>
    <div class="hab-task-list">${taskList}</div>
    ${explainer}
    <div class="sheet-actions">
      <button class="btn btn-primary" data-act="ok">Got it</button>
    </div>
  `;
}

// Bar-explainer sheet body. Fired on first render of the Today page after
// habituation has rolled into a new day. Shown once ever.
export function barsExplainerSheetHtml() {
  return `
    <div class="sheet-title">The bars have changed</div>
    <div class="sheet-subject">Your foundation is taking shape.</div>
    <p class="hab-explanation">
      Now that you have habits, the Today page shows two bars instead of one.
    </p>
    ${splitBarsIllustration()}
    <p class="hab-explanation">
      <strong>Total</strong> tracks all your points against the maintenance
      threshold. Reach it and the day counts as maintenance — your multiplier
      holds.
    </p>
    <p class="hab-explanation">
      <strong>New habits</strong> tracks only your unhabituated points against
      the compounding threshold. Reach it and the day compounds — your
      multiplier grows. ${OLD_VS_NEW_LINE}
    </p>
    <div class="sheet-actions">
      <button class="btn btn-primary" data-act="bars-ok">Got it</button>
    </div>
  `;
}
