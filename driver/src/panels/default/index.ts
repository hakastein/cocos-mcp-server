/* eslint-disable vue/one-component-per-file */

import { readFileSync } from 'fs-extra';
import { join } from 'path';
import { createApp, App, defineComponent, ref, computed, onMounted, watch } from 'vue';
import type { DriverSettings } from '../../types';

const panelDataMap = new WeakMap<any, App>();

module.exports = Editor.Panel.define({
    listeners: {
        show() { },
        hide() { },
    },
    template: readFileSync(join(__dirname, '../../../static/template/default/index.html'), 'utf-8'),
    style: readFileSync(join(__dirname, '../../../static/style/default/index.css'), 'utf-8'),
    $: {
        app: '#app',
        panelTitle: '#panelTitle',
    },
    ready() {
        if (!this.$.app) return;

        const app = createApp({});
        app.config.compilerOptions.isCustomElement = (tag) => tag.startsWith('ui-');

        app.component('McpServerApp', defineComponent({
            setup() {
                const listening = ref(false);
                const pipePath = ref('');
                const project = ref('');
                const settings = ref<DriverSettings>({ enableDebugLog: false });
                const settingsChanged = ref(false);

                const statusClass = computed(() => ({
                    'status-running': listening.value,
                    'status-stopped': !listening.value
                }));

                const saveSettings = async () => {
                    try {
                        await Editor.Message.request(
                            'cocos-mcp-server', 'update-settings', { ...settings.value });
                        settingsChanged.value = false;
                    } catch (error) {
                        console.error('[cocos-cli Panel] Failed to save settings:', error);
                    }
                };

                const copyPipePath = async () => {
                    try {
                        await navigator.clipboard.writeText(pipePath.value);
                    } catch (error) {
                        console.error('[cocos-cli Panel] Failed to copy pipe path:', error);
                    }
                };

                watch(settings, () => { settingsChanged.value = true; }, { deep: true });

                const poll = async () => {
                    try {
                        const status = await Editor.Message.request(
                            'cocos-mcp-server', 'get-driver-status');
                        if (!status) return;
                        listening.value = status.listening;
                        pipePath.value = status.pipePath;
                        project.value = status.project;
                        if (status.settings) settings.value = { ...status.settings };
                    } catch (error) {
                        console.error('[cocos-cli Panel] Failed to poll driver status:', error);
                    }
                };

                onMounted(() => { poll(); setInterval(poll, 2000); });

                return {
                    listening, pipePath, project, settings, settingsChanged,
                    statusClass, saveSettings, copyPipePath
                };
            },
            template: readFileSync(join(__dirname, '../../../static/template/vue/mcp-server-app.html'), 'utf-8'),
        }));

        app.mount(this.$.app);
        panelDataMap.set(this, app);
    },
    beforeClose() { },
    close() {
        panelDataMap.get(this)?.unmount();
    },
});
