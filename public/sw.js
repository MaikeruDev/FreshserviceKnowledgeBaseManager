/* Fresh Knowledge Manager – service worker
 * Purpose: <img src="/api/fs/attachment/<id>"> cannot carry custom headers, but the server needs the
 * Freshservice credentials (which live ONLY in this browser) to fetch the attachment. This worker
 * adds the credential headers to those image requests. Nothing is cached, nothing leaves the browser
 * except towards the app's own origin.
 */
const DB_NAME = "fkm";
const STORE = "kv";
const CREDS_KEY = "creds";
let memo = null; // last known creds (fast path)

function readCreds() {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction(STORE, "readonly");
          const get = tx.objectStore(STORE).get(CREDS_KEY);
          get.onsuccess = () => resolve(get.result || null);
          get.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      };
    } catch {
      resolve(null);
    }
  });
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "creds") memo = event.data.creds || null;
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/api/fs/attachment/")) return;
  event.respondWith(
    (async () => {
      const creds = memo || (memo = await readCreds());
      const headers = new Headers();
      if (creds) {
        const map = { freshserviceDomain: "x-fs-domain", freshserviceApiKey: "x-fs-key", freshserviceWorkspaceId: "x-fs-workspace" };
        for (const [k, h] of Object.entries(map)) if (creds[k]) headers.set(h, encodeURIComponent(creds[k]));
      }
      // build a fresh same-origin request: <img> requests are "no-cors" and would drop custom headers
      return fetch(new Request(event.request.url, { method: "GET", headers, mode: "same-origin", credentials: "same-origin" }));
    })()
  );
});
