import type { EditorApi } from './editor-api';
import type { SceneScriptClient } from './scene-script-client';
import type { PreviewLogStore } from './preview-log-store';
import type { MCPServerSettings } from './types';

export interface ToolContext {
    editor: EditorApi;
    sceneScript: SceneScriptClient;
    logs: PreviewLogStore;
    settings: MCPServerSettings;
}
