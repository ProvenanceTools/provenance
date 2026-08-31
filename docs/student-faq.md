# Student FAQ

The student FAQ lives in the analyzer, at the public **`/faq`** route (for the
production deployment, <https://provenance.eecs.berkeley.edu/faq>). It needs no
sign-in, which is the point: students have no analyzer account, and the OAuth
`hd` check that guards every other route would turn the whole audience away.

The copy is **not** duplicated here. It lives in
[`packages/analyzer/src/views/faq/faq-content.ts`](../packages/analyzer/src/views/faq/faq-content.ts)
as structured data, and that module is the single source of truth. Edit the copy
there; the route, the contents rail, and the per-question anchors all derive from
it.

Each question carries a stable anchor, so staff can link a student to one answer
rather than the whole page:

```
https://provenance.eecs.berkeley.edu/faq#q-own-paste
```

Treat those ids as published URLs. Renaming one breaks links that may already be
sitting in a course announcement.

## Related

- [`student-faq-short.md`](student-faq-short.md) and
  [`student-faq-short.html`](student-faq-short.html) — a ~270-word condensation
  meant to be pasted into a course website, with a link back to `/faq`. This one
  **is** a separate copy, because its job is to be pasted rather than linked.
- [`student-guide.md`](student-guide.md) — installation, enrollment, and
  submission. The FAQ deliberately does not repeat setup instructions.
