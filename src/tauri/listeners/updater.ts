import { listen } from '@tauri-apps/api/event';
import { UpdaterDownloadProgressPayload } from '../types/updater';
import { useUpdaterStore } from '../../stores/updater';
import { useToastStore } from '../../stores/toast';
import { i18n } from '../../i18n';

export function registerUpdaterListeners() {
  const updaterStore = useUpdaterStore();

  void listen<UpdaterDownloadProgressPayload>('updater_download_progress', (event) => {
    updaterStore.processUpdaterDownloadProgress(event.payload);
  });

  void listen<void>(
    'updater_finished',
    () => {
      updaterStore.processUpdaterFinished();
    },
  );

  // The fork updates itself in the background; the new version runs after a restart.
  void listen<string>('app_update_installed', (event) => {
    useToastStore().showToast(
      i18n.global.t('settings.update.installedToast', { version: event.payload }),
      { style: 'success', duration: 8000 },
    );
  });

  void listen<string>(
    'updater_error',
    (event) => {
      updaterStore.processUpdaterError(event.payload);
    },
  );
}
