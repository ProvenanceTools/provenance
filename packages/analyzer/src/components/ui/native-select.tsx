/**
 * NativeSelect — a plain `<select>` styled to match `Input`.
 *
 * Deliberately native (not a Radix listbox): it keeps the platform's keyboard
 * and screen-reader behaviour, and `fireEvent.change` keeps working in tests.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export type NativeSelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
NativeSelect.displayName = 'NativeSelect';

export { NativeSelect };
