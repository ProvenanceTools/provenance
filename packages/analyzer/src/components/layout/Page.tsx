/**
 * Page layout primitives for the server-mode analyzer.
 *
 * The analyzer has two page widths, and only two:
 *
 * - **Workspace** pages (Cohort, Tuning, the submission drill-in) are dense,
 *   data-first views. They render full-bleed and own their own chrome — they
 *   do NOT use `PageContainer`.
 * - **Every other page** (Ingest, Unmatched, Roster, Members, Assignments,
 *   Cross-Flags, Settings, API tokens, Admin, Home) renders inside
 *   `PageContainer`, which pins one max width, one gutter, and one vertical
 *   rhythm, and opens with a `PageHeader`.
 *
 * Before this existed each view picked its own wrapper (`max-w-2xl`, `4xl`,
 * `5xl`, `6xl`, full-bleed `p-4`), so the content column jumped as staff moved
 * between nav tabs. A new page should reach for these, not a bespoke wrapper.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';

// ---------------------------------------------------------------------------
// PageContainer
// ---------------------------------------------------------------------------

export function PageContainer({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'children'>) {
  return (
    <div className={cn('mx-auto w-full max-w-6xl space-y-6 px-6 py-8', className)} {...rest}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PageHeader
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  meta,
  actions,
  eyebrow,
}: {
  /** The page's single `<h1>`. */
  title: ReactNode;
  /** One sentence under the title explaining what the page is for. */
  description?: ReactNode;
  /** Small inline detail beside the title, e.g. a count ("700 entries"). */
  meta?: ReactNode;
  /** Right-aligned primary actions. */
  actions?: ReactNode;
  /** Small line above the title, e.g. a back link. */
  eyebrow?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      {eyebrow && <div className="text-sm text-muted-foreground">{eyebrow}</div>}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-gray-900">{title}</h1>
            {meta && <span className="text-sm text-muted-foreground">{meta}</span>}
          </div>
          {description && <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel — a titled card section within a page
// ---------------------------------------------------------------------------

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  flush = false,
  ...rest
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /**
   * Render the body edge-to-edge (no padding) — for a table that should meet
   * the card border. The header, if any, keeps its padding.
   */
  flush?: boolean;
} & Omit<React.HTMLAttributes<HTMLElement>, 'className' | 'children' | 'title'>) {
  const hasHeader = title !== undefined || description !== undefined || actions !== undefined;
  return (
    <Card className={cn('overflow-hidden', className)} {...rest}>
      {hasHeader && (
        <div
          className={cn(
            'flex flex-wrap items-start justify-between gap-3 px-5 pt-4',
            flush ? 'border-b pb-4' : 'pb-0',
          )}
        >
          <div className="min-w-0 space-y-0.5">
            {title !== undefined && (
              <h2 className="text-base font-semibold text-gray-900">{title}</h2>
            )}
            {description !== undefined && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn(flush ? '' : 'p-5', bodyClassName)}>{children}</div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// EmptyState — the "nothing here yet" message inside a panel or table
// ---------------------------------------------------------------------------

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-1 px-6 py-10 text-center', className)}>
      <p className="text-sm font-medium text-gray-900">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
