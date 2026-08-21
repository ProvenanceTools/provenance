# Provenance

The Provenance extension keeps an honesty log of how your code came together while you work on a course assignment. You submit it alongside your code so your work can be reviewed as a process, not just a final file.

It only runs in assignment folders that have been authorized for recording. In every other folder, the extension does nothing.

## Quick start

1. **Install** the extension (via the marketplace, or by running **Extensions: Install from VSIX…** if you were given a `.vsix` directly).
2. **Open the assignment folder** in VS Code — the one you were given for the assignment, which contains a `.provenance-manifest` file.
3. **Look for `Provenance: recording`** in the status bar at the bottom. If you see it, you're good. Edit, save, and run code normally.
4. **When you're done**, open the command palette (`⇧⌘P` on macOS, `Ctrl+Shift+P` on Windows/Linux) and run **Provenance: Prepare Submission Bundle**. A `.zip` file is saved next to your assignment folder.
5. **Upload that `.zip`** along with your code per the assignment's submission instructions.

If you don't see `Provenance: recording` in the status bar, your work isn't being logged. See [Troubleshooting](#troubleshooting) below.

## What you'll see

- A `Provenance: recording` indicator in the status bar whenever the extension is active. That's the only visible UI change. No popups, no toolbars, no slowdowns.
- A hidden `.provenance/` folder inside the assignment workspace where the log lives. It's normal — don't delete it and don't edit it.

  Whether you **commit** it depends on how the assignment is submitted, and your course will tell you which it is:
  - **ZIP submission** — run **Provenance: Prepare Submission Bundle** when you're done and upload the `.zip`. The seal command packages `.provenance/` for you, so there's no need to commit it.
  - **Git submission** — there is no seal step. `.provenance/` **must be committed and pushed** along with your code; the graders read it out of your repository. The extension keeps a signed seal inside that folder up to date as you work, so whatever you push is always sealed. Make sure nothing in your `.gitignore` excludes `.provenance/` — if part of the log doesn't reach the repo, the missing piece shows up as a gap in your record.

The extension does not change your editor settings, your keybindings, or how VS Code looks. Auto-complete, IntelliSense, linting, debugging, the integrated terminal — all of it works exactly the same.

## What it records

Recording is meant to be fully transparent — there are no hidden signals. While you work in an authorized assignment folder, the extension writes a timestamped, tamper-evident log of the editing process. Here is **everything** it captures:

**Your files and edits**

- The full text of every edit you make in the assignment files — the exact characters inserted or deleted, and where. This includes the literal content you type.
- The contents of the assignment files: when a file is opened, its full text is recorded (for files up to 64 KB; larger files are recorded as a cryptographic hash plus a line count only).
- A cryptographic hash of each file every time you save.

**Pastes**

- Every paste into an assignment file: its location, length, a hash, and the pasted text itself — the full content, or its beginning and end for very large pastes. This is what makes it possible to tell which code came from outside your own typing (for example, from a reference page or another file).

**Where your attention is**

- Which file is focused, and when you switch between files.
- Your cursor position and any text you select.
- When the VS Code window gains or loses focus, and how long you've been idle (sampled on a periodic heartbeat).

**Terminal**

- Commands you run in VS Code's integrated terminal, including the command text and its exit code, plus which shell you're using.

**Your environment**

- The full list of VS Code extensions you have installed, including which are enabled, and a note whenever an extension activates.
- Your VS Code version and operating-system platform, and the recorder's own version.
- A one-way fingerprint of your machine — not your name, email, or IP address, just a value used to notice if a single submission was recorded across different computers.

**Changes made outside your typing**

- When an assignment file changes by something other than your keystrokes — a formatter, a script, git, or an external editor — the extension records the before/after hashes, the size of the change, and (for small files) the new contents.
- Git operations such as commits.

**Session and integrity bookkeeping**

- Session boundaries (start, end, and the links between sessions when you reopen the folder), the assignment manifest's signature, and a per-session signing key used to make the log tamper-evident.
- Internal health signals: clock changes, paste anomalies, breaks in the log's hash chain, and any time the recorder enters a degraded mode or recovers a corrupted log.

The log is stored **only on your computer** until you upload the sealed `.zip` yourself. The extension makes **no network requests**. Nothing is sent anywhere automatically.

## What it does **not** record

- Anything outside the assignment folder. Other projects, your downloads, your browser — invisible to the extension.
- Anything you type in another application (chat, a terminal outside VS Code, a browser, etc.).
- Your clipboard in general. The only paste contents recorded are pastes that actually land inside an assignment file.
- Your account name, email address, or IP address.
- Anything at all when no `.provenance-manifest` file is present, or when its signature doesn't match the expected signing key.

## Troubleshooting

**Status bar doesn't say `Provenance: recording`.**
The extension only activates when the assignment workspace's `.provenance-manifest` file is present and carries a valid signature. Check that you opened the assignment folder itself (not a parent of it), and that the `.provenance-manifest` file is still there. If the indicator still doesn't appear, the manifest's signature most likely doesn't match the extension build you've installed — reinstall the build you were given for this assignment.

**The "Prepare Submission Bundle" command doesn't appear in the palette.**
The command is only available when the extension is active. Confirm the status bar indicator first.

**I closed VS Code mid-assignment — did I lose my work log?**
No. The log is appended continuously as you work, not buffered until submission. Reopen the folder and keep going; the new session links to the previous one in the log.

**Submission bundle failed to seal.**
You'll get an error message. The most common cause is a corrupted `.provenance/session-…slog` file, which the extension also tries to recover automatically on the next launch. Reopen the folder and try sealing again.

**Can I see what's being recorded?**
Yes — the `.provenance/session-*.slog` files are plain newline-delimited JSON. You can open them in any text editor and read every event exactly as it was logged.
