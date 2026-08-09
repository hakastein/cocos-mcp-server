export interface ToolOk<T = unknown> { success: true; data: T; message?: string }
export interface ToolFail { success: false; error: { code: string; message: string; hint?: string } }
export type ToolResult<T = unknown> = ToolOk<T> | ToolFail;

export function ok<T>(data: T, message?: string): ToolOk<T> {
    return message === undefined ? { success: true, data } : { success: true, data, message };
}
export function fail(code: string, message: string, hint?: string): ToolFail {
    return { success: false, error: hint === undefined ? { code, message } : { code, message, hint } };
}
export function isOk<T>(result: ToolResult<T>): result is ToolOk<T> {
    return result.success;
}
