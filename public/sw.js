// Minimal service worker — enables "Add to Home Screen" installability.
// Deliberately does not cache API responses (leads/tasks/etc change constantly);
// this is just enough for the browser to consider the app installable.
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => self.clients.claim());
self.addEventListener("fetch", () => {}); // presence of a fetch handler is required for installability
