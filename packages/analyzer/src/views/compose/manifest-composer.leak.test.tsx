/**
 * THE KEY-CONTAINMENT GATE for the manifest composer.
 *
 * The composer asks course staff to open, in a browser, the one file they were
 * told never to move. The page promises the key stays local. This file is what
 * makes that promise checkable instead of rhetorical, in two layers.
 *
 * **Structural.** The source of both composer files is read and scanned, with
 * comments stripped, for every exfiltration primitive the browser offers:
 * `fetch`, `XMLHttpRequest`, `sendBeacon`, `localStorage`, `sessionStorage`,
 * `indexedDB`, `document.cookie`, and `console.*`. The comment strip matters —
 * both files DISCUSS these APIs at length, and a scan that could not tell
 * prose from code would either fail permanently or be softened until it caught
 * nothing. The stripper has its own test below.
 *
 * A structural scan alone is not enough (a leak can be spelled indirectly), and
 * a behavioural test alone is not enough (a path not exercised is not covered).
 * Both, or neither is worth much.
 *
 * **Behavioural.** A real keypair, a real certificate and a real root key are
 * driven through the actual view to a successful signature — so the private key
 * demonstrably WAS used — and then every channel out of the page is searched
 * for its hex: every `fetch` argument, every `Storage.setItem`, every
 * `sendBeacon`, `document.cookie`, every `console` argument, every blob handed
 * to `URL.createObjectURL`, and the rendered DOM including attribute values.
 *
 * The assertion is on the KEY HEX specifically, not on some proxy. If the key
 * ever reaches one of those channels, the string is there to find.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ManifestComposerView } from './ManifestComposerView.js';
import { makeCourseCert, makeKeypair } from './composer.fixture.js';

// Read through Vite's `?raw` rather than `node:fs`: the analyzer's ESLint
// config bans `node:*` imports outright, and this suite runs in jsdom. The
// precedent is `views/heuristics/heuristics-doc-sync.test.ts`, which reads a
// markdown file the same way and for the same reason.
import composerSource from './manifest-composer.ts?raw';
import viewSource from './ManifestComposerView.tsx?raw';

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

/**
 * Remove `/* … *\/` blocks and `// …` line comments.
 *
 * Deliberately simple: it is applied only to the two composer source files,
 * which contain no string literal holding `//` or `/*`. `is honest about the
 * files it is used on` below pins that assumption — if either file ever grows
 * such a literal, that test fails rather than this stripper quietly eating
 * code.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * A `File` whose `.text()` resolves — jsdom 25 implements `File` but not
 * `Blob.prototype.text`, which every browser has had since 2019 and which the
 * view uses. Stubbing the one method the component calls is more honest than
 * contorting the component into `FileReader` for the test's benefit.
 *
 * `onRead` counts reads, for the test that asserts the keypair file is not
 * opened until Sign.
 */
function jsonFile(name: string, text: string, onRead?: () => void): File {
  const file = new File([text], name, { type: 'application/json' });
  Object.defineProperty(file, 'text', {
    value: () => {
      onRead?.();
      return Promise.resolve(text);
    },
  });
  return file;
}

// Same gap, other end: the blob handed to `URL.createObjectURL` has to be read
// back to prove the key is not in the downloaded file. jsdom has `FileReader`
// but not `Blob.prototype.text`.
if (typeof Blob.prototype.text !== 'function') {
  Object.defineProperty(Blob.prototype, 'text', {
    configurable: true,
    value(this: Blob) {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    },
  });
}

const SOURCES = {
  'manifest-composer.ts': composerSource,
  'ManifestComposerView.tsx': viewSource,
} as const;

/**
 * Every way a browser page can move bytes off the machine or persist them.
 *
 * `console` is on the list because a browser console is a log: staff screen-
 * share it, extensions read it, and a crash reporter that ever gets added would
 * hoover it up.
 */
const FORBIDDEN = [
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'document.cookie',
  'sendBeacon',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'console.',
  'fetch(',
  'apiFetch',
] as const;

describe('structural containment', () => {
  it('is honest about the files it is used on — no string literal hides a comment marker', () => {
    for (const [name, source] of Object.entries(SOURCES)) {
      // Any `//` or `/*` outside a comment would make the stripper eat code.
      // In these files every occurrence is a comment opener, so after stripping
      // there is none left at all.
      expect(stripComments(source), name).not.toMatch(/\/\/|\/\*/);
    }
  });

  it('the stripper removes comments and keeps code', () => {
    expect(stripComments('a; // localStorage\nb;').includes('localStorage')).toBe(false);
    expect(stripComments('/* localStorage */ c;').includes('localStorage')).toBe(false);
    expect(stripComments('/* x */ localStorage;').includes('localStorage')).toBe(true);
  });

  it('neither composer file contains an exfiltration or persistence primitive', () => {
    for (const [name, source] of Object.entries(SOURCES)) {
      const code = stripComments(source);
      for (const token of FORBIDDEN) {
        expect(code, `${name} must not use ${token}`).not.toContain(token);
      }
    }
  });

  it('the pure module imports nothing but log-core', () => {
    const code = stripComments(SOURCES['manifest-composer.ts']);
    const specifiers = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect([...new Set(specifiers)]).toEqual(['@provenance/log-core']);
  });

  it('the view imports no API client and no data-fetching layer', () => {
    const code = stripComments(SOURCES['ManifestComposerView.tsx']);
    const specifiers = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/api\/|queries|@tanstack/);
    }
  });
});

// ---------------------------------------------------------------------------
// Behavioural containment
// ---------------------------------------------------------------------------

type Channels = {
  fetchArgs: unknown[];
  storageWrites: unknown[];
  consoleArgs: unknown[];
  beaconArgs: unknown[];
  blobs: Blob[];
};

describe('behavioural containment', () => {
  let channels: Channels;
  let restore: (() => void)[];

  beforeEach(() => {
    channels = { fetchArgs: [], storageWrites: [], consoleArgs: [], beaconArgs: [], blobs: [] };
    restore = [];

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((...args: unknown[]) => {
      channels.fetchArgs.push(args);
      return Promise.reject(new Error('no network in this test'));
    }) as unknown as typeof fetch;
    restore.push(() => {
      globalThis.fetch = realFetch;
    });

    const realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key: string, value: string) {
      channels.storageWrites.push([key, value]);
      return realSetItem.call(this, key, value);
    };
    restore.push(() => {
      Storage.prototype.setItem = realSetItem;
    });

    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      const spy = vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        channels.consoleArgs.push(args);
      });
      restore.push(() => spy.mockRestore());
    }

    (navigator as unknown as { sendBeacon?: unknown }).sendBeacon = (...args: unknown[]) => {
      channels.beaconArgs.push(args);
      return true;
    };

    // jsdom has no object-URL support; the stub is also how the blob is captured.
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = (blob: Blob) => {
      channels.blobs.push(blob);
      return 'blob:stub';
    };
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = () => undefined;
  });

  afterEach(() => {
    for (const undo of restore.reverse()) undo();
    document.cookie = '';
  });

  it('never lets the course private key reach a request, storage, a log, the DOM, or the file', async () => {
    const root = await makeKeypair(0x51);
    const rootPrivate = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      rootPrivate[i] = Number.parseInt(root.privateKeyHex.slice(i * 2, i * 2 + 2), 16);
    }
    const course = await makeKeypair(0x22);
    const cert = await makeCourseCert({
      courseId: 'berkeley-cs61b',
      coursePubkeyHex: course.publicKeyHex,
      rootPrivateKey: rootPrivate,
    });

    render(<ManifestComposerView />);

    fireEvent.change(screen.getByTestId('composer-assignment-id'), {
      target: { value: 'proj2' },
    });
    fireEvent.change(screen.getByTestId('composer-semester'), { target: { value: 'fa26' } });
    fireEvent.change(screen.getByTestId('composer-issued-at'), {
      target: { value: '2026-09-08T00:00:00Z' },
    });
    fireEvent.change(screen.getByTestId('composer-files'), {
      target: { value: 'src/main.py' },
    });
    fireEvent.change(screen.getByTestId('composer-course-id'), {
      target: { value: 'berkeley-cs61b' },
    });

    fireEvent.change(screen.getByTestId('composer-cert-input'), {
      target: { files: [jsonFile('course-cert.json', cert.fileText)] },
    });
    await screen.findByTestId('composer-cert-summary');

    fireEvent.change(screen.getByTestId('composer-key-input'), {
      target: { files: [jsonFile('course-keypair.json', course.fileText)] },
    });

    fireEvent.change(screen.getByTestId('composer-root-pubkey'), {
      target: { value: root.publicKeyHex },
    });

    fireEvent.click(screen.getByTestId('composer-sign'));

    // The key really was used: a verified signature exists.
    await screen.findByTestId('composer-verified');
    expect(screen.getByTestId('composer-sig').textContent).toMatch(/^[0-9a-f]{128}$/);

    const secret = course.privateKeyHex;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    expect(JSON.stringify(channels.fetchArgs)).not.toContain(secret);
    expect(JSON.stringify(channels.storageWrites)).not.toContain(secret);
    expect(JSON.stringify(channels.consoleArgs)).not.toContain(secret);
    expect(JSON.stringify(channels.beaconArgs)).not.toContain(secret);
    expect(document.cookie).not.toContain(secret);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);

    expect(channels.blobs.length).toBeGreaterThan(0);
    for (const blob of channels.blobs) {
      expect(await blob.text()).not.toContain(secret);
    }

    expect(document.body.innerHTML).not.toContain(secret);
    for (const el of document.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        expect(attr.value).not.toContain(secret);
      }
      // React keeps <textarea> and <input> values off the DOM attribute; check
      // the live property too, which is what a serializer would read.
      const value = (el as Partial<HTMLInputElement>).value;
      if (typeof value === 'string') expect(value).not.toContain(secret);
    }
  });

  it('does not read the keypair file at all until Sign is pressed', async () => {
    const course = await makeKeypair(0x22);
    render(<ManifestComposerView />);

    let reads = 0;
    const file = jsonFile('course-keypair.json', course.fileText, () => {
      reads += 1;
    });

    fireEvent.change(screen.getByTestId('composer-key-input'), { target: { files: [file] } });
    await screen.findByTestId('composer-key-chosen');
    expect(reads).toBe(0);
  });

  it('refuses a keypair chosen in the certificate slot, and keeps nothing from it', async () => {
    const course = await makeKeypair(0x22);
    render(<ManifestComposerView />);

    fireEvent.change(screen.getByTestId('composer-cert-input'), {
      target: { files: [jsonFile('course-keypair.json', course.fileText)] },
    });

    const error = await screen.findByTestId('composer-cert-error');
    expect(error.textContent).toContain('PRIVATE KEY');
    expect(screen.queryByTestId('composer-cert-summary')).toBeNull();
    expect(document.body.innerHTML).not.toContain(course.privateKeyHex);

    // And it did not silently become a usable certificate.
    fireEvent.click(screen.getByTestId('composer-sign'));
    await waitFor(() => {
      expect(screen.queryByTestId('composer-result')).toBeNull();
    });
  });
});
