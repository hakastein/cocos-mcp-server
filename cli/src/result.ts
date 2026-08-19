export interface ToolOk<T = unknown> { success: true; data: T; message?: string }
export interface ToolFail { success: false; error: { code: string; message: string; hint?: string }; data?: unknown }
export type ToolResult<T = unknown> = ToolOk<T> | ToolFail;

export function ok<T>(data: T, message?: string): ToolOk<T> {
    return message === undefined ? { success: true, data } : { success: true, data, message };
}
export function fail(code: string, message: string, hint?: string, data?: unknown): ToolFail {
    const error = hint === undefined ? { code, message } : { code, message, hint };
    return data === undefined ? { success: false, error } : { success: false, error, data };
}
export function isOk<T>(result: ToolResult<T>): result is ToolOk<T> {
    return result.success;
}
