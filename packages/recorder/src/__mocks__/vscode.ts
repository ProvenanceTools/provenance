/**
 * Minimal vscode module mock for unit tests.
 * Provides only the surface area used by the recorder's source files.
 * CLAUDE.md: "Do not write tests that exercise VS Code APIs from unit tests. Mock at the seam."
 */

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ExtensionKind {
  UI = 1,
  Workspace = 2,
}

export const version = '1.97.0';

const noopDisposable = { dispose: () => undefined };

export const window = {
  createStatusBarItem: (_alignment?: StatusBarAlignment, _priority?: number) => ({
    text: '',
    tooltip: '',
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
  // Used by heartbeat and doc-wiring for focus-change subscription.
  onDidChangeWindowState: (_handler: (_state: { focused: boolean }) => void) => noopDisposable,
  // Used by heartbeat for active-editor-change subscription.
  onDidChangeActiveTextEditor: (_handler: () => void) => noopDisposable,
  // Used by doc-wiring for selection-change subscription.
  onDidChangeTextEditorSelection: (_handler: (_event: unknown) => void) => noopDisposable,
  // Used by terminal-wiring.ts (Phase 8).
  onDidOpenTerminal: (_handler: (_terminal: unknown) => void) => noopDisposable,
  onDidCloseTerminal: (_handler: (_terminal: unknown) => void) => noopDisposable,
  // VS Code 1.93+ API — omitted by default; tests that need it can add it via vi.mock.
  onDidStartTerminalShellExecution: undefined as undefined,
  onDidEndTerminalShellExecution: undefined as undefined,
  // Mock: active editor is always undefined in unit tests.
  activeTextEditor: undefined as undefined,
  // Window state: always focused in unit tests.
  state: { focused: true },
  // Notification surface used by the seal command and the inactive-workspace stub.
  showWarningMessage: (_message: string, ..._items: unknown[]) => Promise.resolve(undefined),
};

export const workspace = {
  workspaceFolders: undefined as unknown as unknown[],
  // Used by heartbeat and doc-wiring for text-document-change subscription.
  onDidChangeTextDocument: (_handler: (_event: unknown) => void) => noopDisposable,
  // Used by doc-wiring for open/save/close subscriptions.
  onDidOpenTextDocument: (_handler: (_doc: unknown) => void) => noopDisposable,
  onDidSaveTextDocument: (_handler: (_doc: unknown) => void) => noopDisposable,
  onDidCloseTextDocument: (_handler: (_doc: unknown) => void) => noopDisposable,
  // Used for building relative paths.
  asRelativePath: (uri: { fsPath: string }) => uri.fsPath,
  // Used by fs-watcher.ts. Default returns a no-op watcher; tests override via vi.mock.
  createFileSystemWatcher: (_pattern: unknown) => _defaultFsWatcher,
  // Already-open documents at extension activation time. Default empty; tests
  // that exercise the synthetic-open path stub this via vi.mock.
  textDocuments: [] as readonly unknown[],
  // Used by git-wiring to read the `git.path` setting when resolving the git
  // executable. Default: nothing configured, i.e. the bare PATH lookup. Tests
  // that care inject `readConfiguredGitPath` rather than mutating this.
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string): T | undefined => undefined,
  }),
};

export const extensions = {
  // Returns undefined by default. Tests that need a specific extension can
  // override via vi.spyOn(extensions, 'getExtension').mockReturnValue(...).
  getExtension: (_id: string): undefined => undefined,
  // Empty array by default. Tests can replace this via vi.spyOn or pass
  // getExtensions as a dep injection (preferred — avoids global mutation).
  all: [] as readonly import('vscode').Extension<unknown>[],
};

export const commands = {
  registerCommand: (_id: string, _handler: () => unknown) => ({ dispose: () => undefined }),
  executeCommand: (_id: string, ..._args: unknown[]) => Promise.resolve(undefined),
};

// Expose the class shape that extension.ts uses; tests replace it via ActivateDeps.
export class Uri {
  static file(p: string): Uri {
    return new Uri(p);
  }
  constructor(public fsPath: string) {}
}

// Used by fs-watcher.ts.
export class RelativePattern {
  constructor(
    public base: unknown,
    public pattern: string,
  ) {}
}

// Default no-op FileSystemWatcher (tests replace via workspace.createFileSystemWatcher stub).
export const _defaultFsWatcher = {
  onDidChange: (_handler: (_uri: unknown) => void) => ({ dispose: () => undefined }),
  onDidCreate: (_handler: (_uri: unknown) => void) => ({ dispose: () => undefined }),
  onDidDelete: (_handler: (_uri: unknown) => void) => ({ dispose: () => undefined }),
  dispose: () => undefined,
};
