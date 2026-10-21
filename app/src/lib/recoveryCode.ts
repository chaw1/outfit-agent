/** Recovery codes contain twelve letters/digits in three groups; never persist them locally. */
export function normalizeRecoveryCode(value: string): string { return value.trim().toLowerCase(); }
export function isRecoveryCode(value: unknown): value is string { return typeof value === 'string' && /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i.test(value.trim()); }
