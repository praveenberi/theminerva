/** All money maths is done in integer cents to avoid floating point drift. */
export const toCents = (v: unknown): number => Math.round(Number(v) * 100);
export const fromCents = (c: number): number => Math.round(c) / 100;
export const pct = (cents: number, percent: number) => Math.round((cents * percent) / 100);
