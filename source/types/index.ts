export interface MCPServerSettings {
    port: number;
    autoStart: boolean;
    enableDebugLog: boolean;
    maxConnections: number;
}

export interface ServerStatus {
    running: boolean;
    port: number;
    clients: number;
}
