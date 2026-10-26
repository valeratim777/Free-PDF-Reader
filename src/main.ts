import './styles.css';
import { App } from './app';

new App(document.getElementById('app')!).start();

// The Android and desktop apps ship their files locally; only the website needs offline caching.
const inShell = !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() || 'desktop' in window;
if (import.meta.env.PROD && 'serviceWorker' in navigator && !inShell && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
  });
}
