// PWA (M5): installable app window + cached game/model files for a faster start.
// Production builds only — during `npm run dev` a service worker would serve stale files and
// make changes look like they didn't apply.

export function registerPwa(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((e) => {
      // the game works the same without it
      console.warn('service worker registration failed', e);
    });
  });
}
