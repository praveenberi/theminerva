/**
 * Spreadsheet apps run cells that start with = + - @ (or a tab/return) as formulas, which can leak data or run commands when
 * someone opens a downloaded file. Text that starts that way is prefixed with an apostrophe, the standard neutralisation.
 * Numbers are never touched: a negative number is not a formula.
 */
export const csvText = (raw: string): string => {
  const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

export const csvCell = (v: string | number | null | undefined): string => (v == null ? '' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : csvText(v));
export const csvRow = (values: (string | number | null | undefined)[]): string => values.map(csvCell).join(',');
