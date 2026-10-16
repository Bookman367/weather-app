// ============================================================
// Home-screen install hints
//
// Chrome/Edge (Android, some desktop): show Install only after
// beforeinstallprompt. iOS Safari never fires that event — show a
// one-line Add to Home Screen tip instead.
// ============================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof root === 'object' && root) {
    root.PwaInstall = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function readUA(env) {
    if (env && env.userAgent) return String(env.userAgent);
    if (typeof navigator !== 'undefined' && navigator.userAgent) return String(navigator.userAgent);
    return '';
  }

  function isIos(env) {
    const ua = readUA(env);
    if (/iphone|ipod|ipad/i.test(ua)) return true;
    const nav = (env && env.navigator) || (typeof navigator !== 'undefined' ? navigator : null);
    // iPadOS 13+ reports as Macintosh
    if (nav && nav.platform === 'MacIntel' && Number(nav.maxTouchPoints) > 1) return true;
    return false;
  }

  function isStandalone(env) {
    if (env && Object.prototype.hasOwnProperty.call(env, 'standalone')) {
      return !!env.standalone;
    }
    const win = (env && env.window) || (typeof window !== 'undefined' ? window : null);
    if (!win) return false;
    if (win.navigator && win.navigator.standalone === true) return true;
    if (typeof win.matchMedia === 'function') {
      try {
        if (win.matchMedia('(display-mode: standalone)').matches) return true;
        if (win.matchMedia('(display-mode: fullscreen)').matches) return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  // Only when the browser actually offered an install prompt.
  function shouldShowInstallHint(env) {
    const e = env || {};
    if (isStandalone(e)) return false;
    return e.hasBeforeInstallPrompt === true;
  }

  // iOS has no beforeinstallprompt. Hide once the app is on the home screen.
  function shouldShowIosA2hs(env) {
    const e = env || {};
    if (isStandalone(e)) return false;
    return isIos(e);
  }

  return {
    isIos,
    isStandalone,
    shouldShowInstallHint,
    shouldShowIosA2hs
  };
}));
