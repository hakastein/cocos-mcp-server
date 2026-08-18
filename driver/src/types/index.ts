export interface DriverSettings {
    enableDebugLog: boolean;
}

export interface DriverStatus {
    listening: boolean;
    pipePath: string;
    project: string;
}
