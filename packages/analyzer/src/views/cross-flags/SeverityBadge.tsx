/**
 * SeverityBadge — the severity pill shared by the cross-flag list and detail
 * pages. Colours are semantic (high = red, medium = orange …), not brand.
 */

const SEVERITY_CLASSES: Record<string, string> = {
  high: 'border-red-200 bg-red-50 text-red-700',
  medium: 'border-orange-200 bg-orange-50 text-orange-700',
  low: 'border-yellow-200 bg-yellow-50 text-yellow-800',
  info: 'border-gray-200 bg-gray-50 text-gray-600',
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${
        SEVERITY_CLASSES[severity] ?? SEVERITY_CLASSES.info
      }`}
    >
      {severity}
    </span>
  );
}
