/** Money is stored in paise as integers and only ever formatted at the edge. */
export function formatRupees(paise: number): string {
  const rupees = paise / 100;
  const text = Number.isInteger(rupees) ? String(rupees) : rupees.toFixed(2);
  return `₹${text}`;
}

/** "a, b and c" - used for guest-facing prose only. */
export function joinWords(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Tags are stored as snake_case; guests should not read snake_case. */
export function humanTag(tag: string): string {
  return tag.replace(/_/g, ' ');
}
