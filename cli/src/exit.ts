export const EXIT = {
    OK: 0,
    FAILED: 1,
    USAGE: 2,
    NO_EDITOR: 3,
    PROTOCOL: 4
} as const;

export type ExitCode = typeof EXIT[keyof typeof EXIT];
