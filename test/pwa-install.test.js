'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../lib/pwa-install');

describe('PWA install hints', () => {
  it('shows Install only when beforeinstallprompt fired and the app is not installed', () => {
    assert.equal(P.shouldShowInstallHint({ hasBeforeInstallPrompt: true, standalone: false }), true);
    assert.equal(P.shouldShowInstallHint({ hasBeforeInstallPrompt: true, standalone: true }), false);
    assert.equal(P.shouldShowInstallHint({ hasBeforeInstallPrompt: false, standalone: false }), false);
    assert.equal(P.shouldShowInstallHint({}), false);
  });

  it('shows the iOS add-to-home-screen line on iPhone/iPad Safari, not once installed', () => {
    assert.equal(P.shouldShowIosA2hs({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', standalone: false }), true);
    assert.equal(P.shouldShowIosA2hs({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', standalone: false }), true);
    assert.equal(P.shouldShowIosA2hs({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', standalone: true }), false);
    assert.equal(P.shouldShowIosA2hs({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      navigator: { platform: 'MacIntel', maxTouchPoints: 5 },
      standalone: false
    }), true);
    assert.equal(P.shouldShowIosA2hs({
      userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0',
      standalone: false
    }), false);
  });
});

describe('placeholder app icons', () => {
  it('are PNG files at the install sizes', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    for (const name of ['icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png']) {
      const buf = fs.readFileSync(path.join(__dirname, '..', 'icons', name));
      assert.deepEqual(buf.subarray(0, 4), png);
      assert.ok(buf.length > 200);
    }
  });
});

describe('dark/light contrast tokens', () => {
  function srgbToLin(c) {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  }
  function lum(rgb) {
    return 0.2126 * srgbToLin(rgb[0]) + 0.7152 * srgbToLin(rgb[1]) + 0.0722 * srgbToLin(rgb[2]);
  }
  function contrast(a, b) {
    const hi = Math.max(lum(a), lum(b));
    const lo = Math.min(lum(a), lum(b));
    return (hi + 0.05) / (lo + 0.05);
  }
  function composite(fg, bg, alpha) {
    return fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]);
  }

  it('muted text meets 4.5:1 on dark and light chrome', () => {
    const darkBg = [8, 15, 30];
    const darkMuted = composite([255, 255, 255], darkBg, 0.68);
    assert.ok(contrast(darkMuted, darkBg) >= 4.5, 'dark --text-muted');

    const lightBg = [232, 240, 251];
    const lightMuted = composite([20, 30, 60], lightBg, 0.68);
    assert.ok(contrast(lightMuted, lightBg) >= 4.5, 'light --text-muted');
  });
});

describe('service worker update policy', () => {
  it('uses a versioned cache, skipWaiting, and clients.claim', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
    assert.match(src, /hero-shell-v\d+/);
    assert.match(src, /hero-forecast-v\d+/);
    assert.match(src, /skipWaiting\(/);
    assert.match(src, /clients\.claim\(/);
    assert.match(src, /Update policy/);
    assert.match(src, /cache-first/);
    assert.match(src, /network-first|network first/i);
    assert.match(src, /isForecastNavigation/);
    assert.match(src, /spray-map/);
  });
});
