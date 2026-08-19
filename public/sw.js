/* Legacy service worker (no longer used). Attachment previews are authorized via a path-scoped cookie now.
 * This file only exists so browsers that still have the old worker registered update to this one, which
 * unregisters itself and passes all requests through untouched. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.registration.unregister().then(() => self.clients.claim()));
});
