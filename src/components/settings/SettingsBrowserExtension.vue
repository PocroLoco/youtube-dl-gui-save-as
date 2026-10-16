<template>
  <base-fieldset
      :legend="t('settings.browserExtension.legend')"
      :label="t('settings.browserExtension.legendLabel')"
  >
    <ol class="list-decimal ml-5 mt-2 text-sm leading-relaxed">
      <li>{{ t('settings.browserExtension.step1') }}</li>
      <li>{{ t('settings.browserExtension.step2') }}</li>
      <li>{{ t('settings.browserExtension.step3') }}</li>
    </ol>
    <div class="flex items-center gap-3 mt-3">
      <button type="button" class="btn btn-sm btn-primary" :disabled="!info?.path" @click="reveal">
        {{ t('settings.browserExtension.show') }}
      </button>
      <span v-if="info?.version" class="label">{{ t('settings.browserExtension.version', { version: info.version }) }}</span>
    </div>
    <p v-if="info?.path" class="label mt-2 break-all select-all">{{ info.path }}</p>
    <p class="label mt-1 whitespace-normal">{{ t('settings.browserExtension.hint') }}</p>
  </base-fieldset>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from 'vue-i18n';
import BaseFieldset from '../base/BaseFieldset.vue';

type ExtensionFolderInfo = { path?: string; version?: string };

const { t } = useI18n();
const info = ref<ExtensionFolderInfo>();

onMounted(async () => {
  try {
    info.value = await invoke<ExtensionFolderInfo>('extension_folder_info');
  } catch (e) {
    console.warn('Could not read the extension folder', e);
  }
});

async function reveal() {
  try {
    await invoke('extension_folder_reveal');
  } catch (e) {
    console.warn('Could not show the extension folder', e);
  }
}
</script>
