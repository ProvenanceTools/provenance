/**
 * Label — a plain `<label>` with the form-field label style. No Radix dep.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn('text-sm font-medium leading-none text-gray-700', className)}
      {...props}
    />
  ),
);
Label.displayName = 'Label';

export { Label };
