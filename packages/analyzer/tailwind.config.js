/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  /**
   * Explicitly class-driven, NOT the Tailwind default of `media`.
   *
   * The analyzer has no theme toggle and never sets a `dark` class, so the
   * intended appearance is light everywhere. Under the default, `dark:`
   * variants fire off the viewer's OS setting — and since only two of the
   * ~120 components in `src/` carry any `dark:` variants at all, a staff
   * member with their machine in dark mode saw those two go dark inside an
   * otherwise light page. Pinning the strategy makes the unused variants
   * inert instead of selectively active.
   */
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /**
         * UC Berkeley brand (brand.berkeley.edu/visual-identity/colors), the
         * analyzer's accent since issue #36 replaced the old Provenance orange.
         *
         * `berkeley-700` is Berkeley Blue (#002676) exactly; the other steps
         * are tints toward white (50–600) and a shade toward black (800),
         * numbered like Tailwind's own scales so each stands in for the
         * `orange-*` step it replaced. Text and focus rings stay at 400 and
         * above (≥ 4.4:1 on white); 50–300 are backgrounds and borders only.
         *
         * California Gold (#FDB515) is 1.78:1 on white, so on a light surface
         * it is never text and never the only cue for a state — just the
         * mark's accent link and decorative rules beside a text cue that
         * already carries the state.
         *
         * Orange is NOT retired: it still means severity "medium", paste
         * regions, a partial ingest, and a tainted reconstruction. Those are
         * semantic colours, not brand, and keep their `orange-*` classes.
         */
        berkeley: {
          50: '#f2f4f8',
          100: '#e0e5ef',
          200: '#c2cbde',
          300: '#8c9dc1',
          400: '#6178aa',
          500: '#385694',
          600: '#1a3c84',
          700: '#002676',
          800: '#001b53',
        },
        gold: {
          DEFAULT: '#fdb515',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [],
};
