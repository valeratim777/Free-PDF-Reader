// The phone's Back button (or back gesture). Inside a document it closes whatever
// is open on top — a dialog, a menu, a panel, a tool — and then the document itself
// (asking whether to save), returning to the start screen. On the start screen the
// Android app goes to the background, like other apps do.
import { desktopBridge, isNativeApp } from './native';

let sync: () => void = () => {};

/**
 * `handle` closes the topmost thing and returns false when there was nothing left
 * to close. `wanted` says whether Back should stay inside the app (a document is open).
 */
export async function installBackButton(handle: () => Promise<boolean>, wanted: () => boolean): Promise<void> {
  if (isNativeApp()) {
    const { App } = await import('@capacitor/app');
    await App.addListener('backButton', () => {
      void handle().then((done) => {
        if (!done) void App.minimizeApp().catch(() => App.exitApp());
      });
    });
    return;
  }
  if (desktopBridge()) return;

  // Browsers (the installed web app on a phone): while a document is open there is one
  // extra history entry, so Back runs `handle` instead of leaving the page.
  let armed = false;
  let skip = 0;
  const arm = () => {
    if (armed) return;
    history.pushState({ prBack: 1 }, '');
    armed = true;
  };
  sync = () => {
    if (wanted()) arm();
    else if (armed) {
      armed = false;
      skip++;
      history.back();
    }
  };
  window.addEventListener('popstate', () => {
    if (skip) {
      skip--;
      return;
    }
    if (!armed) return;
    armed = false;
    // Keep a guard entry while the question "save changes?" is on screen.
    if (wanted()) arm();
    void handle().then(() => sync());
  });
  sync();
}

/** Call when a document opens or closes, so the browser's Back works as described above. */
export function syncBackButton(): void {
  sync();
}
