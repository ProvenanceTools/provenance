/**
 * Avatar text for the account menu: "Aaryan Mehta" → "AM", a one-word name →
 * its first letter, no name → the email's first letter.
 *
 * The server stores no profile photo, so initials are the avatar. Decorative
 * only — the account-menu trigger's aria-label carries the account's name.
 */
export function initials(displayName: string | null, email: string): string {
  const words = (displayName ?? '')
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  const first = words[0];
  if (first === undefined) return email.charAt(0).toUpperCase();
  const last = words.length > 1 ? (words[words.length - 1] ?? '') : '';
  return (first.charAt(0) + last.charAt(0)).toUpperCase();
}
