import type { BrowserStorage } from '../../src/storage.js';
import type { PlaintextExampleStorage } from '../../examples/browser/storage.ts';
declare global {
  var testStorage: BrowserStorage;
  var locked: boolean;
  var httpStorage: PlaintextExampleStorage;
  var httpLockAcquired: boolean;
}
export {};
