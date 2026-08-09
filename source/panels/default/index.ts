/* eslint-disable vue/one-component-per-file */

import { readFileSync } from 'fs-extra';
import { join } from 'path';
import { createApp, App, defineComponent, ref, computed, onMounted, watch } from 'vue';

const panelDataMap = new WeakMap<any, App>();

interface ServerSettings {
    port: number;
    autoStart: boolean;
    debugLog: boolean;
    maxConnections: number;
}

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
                const serverRunning = ref(false);
                const serverStatusText = ref('Stopped');
                const connectedClients = ref(0);
                const httpUrl = ref('');
                const isProcessing = ref(false);
                const settingsChanged = ref(false);

                const settings = ref<ServerSettings>({
                    port: 3000,
                    autoStart: false,
                    debugLog: false,
                    maxConnections: 10
                });

                const statusClass = computed(() => ({
                    'status-running': serverRunning.value,
                    'status-stopped': !serverRunning.value
                }));

                const toggleServer = async () => {
                    try {
                        if (serverRunning.value) {
                            await Editor.Message.request('cocos-mcp-server', 'stop-server');
                        } else {
                            const currentSettings = {
                                port: settings.value.port,
                                autoStart: settings.value.autoStart,
                                enableDebugLog: settings.value.debugLog,
                                maxConnections: settings.value.maxConnections
                            };
                            await Editor.Message.request('cocos-mcp-server', 'update-settings', currentSettings);
                            await Editor.Message.request('cocos-mcp-server', 'start-server');
                        }
                    } catch (error) {
                        console.error('[MCP Panel] Failed to toggle server:', error);
                    }
                };

                const saveSettings = async () => {
                    try {
                        const settingsData = {
                            port: settings.value.port,
                            autoStart: settings.value.autoStart,
                            enableDebugLog: settings.value.debugLog,
                            maxConnections: settings.value.maxConnections
                        };
                        await Editor.Message.request('cocos-mcp-server', 'update-settings', settingsData);
                        settingsChanged.value = false;
                    } catch (error) {
                        console.error('[MCP Panel] Failed to save settings:', error);
                    }
                };

                const copyUrl = async () => {
                    try {
                        await navigator.clipboard.writeText(httpUrl.value);
                    } catch (error) {
                        console.error('[MCP Panel] Failed to copy URL:', error);
                    }
                };

                watch(settings, () => { settingsChanged.value = true; }, { deep: true });

                onMounted(async () => {
                    try {
                        const status = await Editor.Message.request('cocos-mcp-server', 'get-server-status');
                        if (status?.settings) {
                            settings.value = {
                                port: status.settings.port ?? 3000,
                                autoStart: status.settings.autoStart ?? false,
                                debugLog: status.settings.enableDebugLog ?? false,
                                maxConnections: status.settings.maxConnections ?? 10
                            };
                        }
                    } catch (error) {
                        console.error('[MCP Panel] Failed to load server settings:', error);
                    }

                    setInterval(async () => {
                        try {
                            const result = await Editor.Message.request('cocos-mcp-server', 'get-server-status');
                            if (result) {
                                serverRunning.value = result.running;
                                serverStatusText.value = result.running ? 'Running' : 'Stopped';
                                connectedClients.value = result.clients ?? 0;
                                httpUrl.value = result.running ? `http://localhost:${result.port}` : '';
                                isProcessing.value = false;
                            }
                        } catch (error) {
                            console.error('[MCP Panel] Failed to poll server status:', error);
                        }
                    }, 2000);
                });

                return {
                    serverRunning,
                    serverStatusText,
                    connectedClients,
                    httpUrl,
                    isProcessing,
                    settings,
                    settingsChanged,
                    statusClass,
                    toggleServer,
                    saveSettings,
                    copyUrl
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
