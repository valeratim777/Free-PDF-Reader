// The Android app reads aloud with the phone's own speech engine, so the neural
// voice engine used on computers (public/speech, ~29 MB) is left out of the APK.
// Runs after `cap sync android`.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(root, 'android', 'app', 'src', 'main', 'assets', 'public', 'speech'), { recursive: true, force: true });
console.log('speech engine left out of the Android app');
