import { listen } from '@tauri-apps/api/event';
import { useBridgeStore } from '../../stores/bridge';

/**
 * Picks up downloads sent from the browser extension. Started once the app's
 * settings are loaded, so requests that started the app wait until then.
 */
export async function startBrowserBridge(): Promise<void> {
  const bridgeStore = useBridgeStore();
  await listen('bridge_pending', () => {
    void bridgeStore.drain();
  });
  bridgeStore.startReporting();
  await bridgeStore.drain();
}
