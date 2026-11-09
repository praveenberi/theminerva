/** Meat / seafood a dish contains — shown as small icons on the menu. Keys must match server/src/routes/menu.ts. */
export const PROTEINS = [
  { key: 'chicken', label: 'Chicken', icon: '🐔' },
  { key: 'pork', label: 'Pork', icon: '🐖' },
  { key: 'beef', label: 'Beef', icon: '🐄' },
  { key: 'lamb', label: 'Lamb / mutton', icon: '🐑' },
  { key: 'goat', label: 'Goat', icon: '🐐' },
  { key: 'duck', label: 'Duck', icon: '🦆' },
  { key: 'turkey', label: 'Turkey', icon: '🦃' },
  { key: 'fish', label: 'Fish', icon: '🐟' },
  { key: 'prawn', label: 'Prawn', icon: '🦐' },
  { key: 'crab', label: 'Crab', icon: '🦀' },
  { key: 'squid', label: 'Squid / octopus', icon: '🦑' },
  { key: 'egg', label: 'Egg', icon: '🥚' },
  { key: 'other', label: 'Other meat', icon: '🍖' },
] as const;

export type ProteinKey = (typeof PROTEINS)[number]['key'];
export const proteinInfo = (k: string) => PROTEINS.find((p) => p.key === k);
