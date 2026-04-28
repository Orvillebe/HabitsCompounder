// ============================================================================
// storage.js
// ----------------------------------------------------------------------------
// Persistence layer. The rest of the app talks to a single Storage interface
// with two operations: save the event log, load the event log. The default
// implementation uses localStorage; a future implementation could write to
// IndexedDB or a remote DB without any other file changing.
//
// The interface intentionally only handles events. State is never persisted —
// it is always derived by replaying events through the engine on load.
// ============================================================================

const STORAGE_KEY = 'habits-events-v2';

// Storage interface (informal):
//   loadEvents(): Event[]   — returns all events in order, or [] if none.
//   saveEvents(events): void — persists the entire event log.
//   clear(): void           — removes everything (used by "wipe data").

// The localStorage implementation. Stringifies the array as JSON.
function makeLocalStorageBackend() {
  return {
    loadEvents() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        console.error('storage.loadEvents failed:', err);
        return [];
      }
    },
    saveEvents(events) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
      } catch (err) {
        console.error('storage.saveEvents failed:', err);
      }
    },
    clear() {
      try {
        // Wipe everything the app owns in localStorage: the event log plus
        // any UI flags (one-time explainers, etc.). Any key with the
        // `habits-` prefix is ours.
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('habits-')) keys.push(k);
        }
        for (const k of keys) localStorage.removeItem(k);
      } catch (err) {
        console.error('storage.clear failed:', err);
      }
    },
  };
}

// The single storage instance the app uses. Swap this line to replace
// localStorage with a different backend (e.g. IndexedDB, remote DB).
export const storage = makeLocalStorageBackend();
