## Recording your work with the Provenance Recorder

For some assignments this term you'll record your work with the **Provenance Recorder**, an editor plugin that keeps a tamper-evident log of _how_ your code comes together as you work. Your course reviews that log alongside your code, so your work can be judged as a process and not just a final file.

The recorder only runs inside assignment folders your course has authorized. In every other folder it does nothing — no recording, no network requests, and no change to how your editor behaves. Setup takes a few minutes, and you only do it once per computer.

Common questions — what it can and can't see, whether your normal workflow is a problem, what happens if something looks odd — are answered in the [student FAQ](student-faq.md).

> **What gets recorded?** Inside the assignment folder only: your edits, pastes, saves, terminal commands, and editor focus. Everything stays on your computer until you hand it in. The complete, itemized list is on the [extension's Marketplace page](https://marketplace.visualstudio.com/items?itemName=itsgeagle.provenance-recorder#what-it-records).

### Pick your editor

There are three recorders. They record the same events into the same format, and your course accepts any of them:

| Editor                                      | Where to get it                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **VS Code**                                 | [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=itsgeagle.provenance-recorder)          |
| **JetBrains** (IntelliJ, PyCharm, CLion, …) | [ProvenanceTools/provenance-jetbrains-recorder](https://github.com/ProvenanceTools/provenance-jetbrains-recorder) |
| **Neovim**                                  | [ProvenanceTools/provenance-neovim-recorder](https://github.com/ProvenanceTools/provenance-neovim-recorder)       |

The JetBrains and Neovim recorders ship their own install and setup instructions in their repositories. The rest of this guide walks through VS Code; the concepts — enrolling, opening the folder, checking the indicator, submitting — are the same everywhere.

### Two ways assignments are submitted

Your course will tell you which one an assignment uses, and it changes what you do at the end:

- **ZIP submission.** When you're done you run a command that seals your assignment files and the log into a single `.zip`, and you upload that.
- **Git submission.** There is no seal step. The hidden `.provenance/` folder is part of your repository: you **commit and push it** along with your code, and the graders read it out of the repo.

---

### Before you start

You'll need:

- **Visual Studio Code 1.100 or newer.** Check via **Code → About Visual Studio Code** (macOS) or **Help → About** (Windows/Linux). Update from <https://code.visualstudio.com> if you're behind. (On macOS, run VS Code from your **Applications** folder — launching a freshly downloaded copy from Downloads or a disk image can leave it read-only and unable to update or load the extension.)
- **The assignment folder** distributed for the assignment, or the repository you were told to clone. It contains a hidden `.provenance-manifest` file — that's what authorizes recording. If it's missing, recording can't start; re-download or re-clone the starter files.

### 1. Install the extension

The extension is on the Visual Studio Code Marketplace:

**<https://marketplace.visualstudio.com/items?itemName=itsgeagle.provenance-recorder>**

Install it from inside VS Code:

1. Open VS Code.
2. Click the **Extensions** icon in the left sidebar (four squares), or press **`⇧⌘X`** (macOS) / **`Ctrl+Shift+X`** (Windows/Linux).
3. Search for **`Provenance Recorder`**.
4. On the result published by **Aaryan Mehta (itsgeagle)**, click **Install**.

![Searching for "Provenance Recorder" in the VS Code Extensions panel](images/install-search.png)

> **One-line install:** Press **`⌘P`** / **`Ctrl+P`**, paste `ext install itsgeagle.provenance-recorder`, and press **Enter**.

The extension is free and makes no network requests while it is recording.

### 2. Enrol this computer

Enrolling is what lets your courses tell that the work in your recordings is yours. You do it **once per computer**, and the credential you get is **not tied to a course or a semester** — one is enough for everything you take, this term and later.

1. In VS Code, open the command palette (**`⇧⌘P`** / **`Ctrl+Shift+P`**) and run **Provenance: Show My Enrollment Key**. It copies your **public** key to the clipboard. (The private half is created on this machine and never leaves it — not to the page, not to any server.)
2. In a browser, go to your institution's Provenance site and open the **`/enroll`** page — for example `https://provenance.your-school.edu/enroll`. There is no course or semester in that URL. Sign in with your **university** account.
3. Paste your key, and copy the credential the page gives back.
4. Back in VS Code, run **Provenance: Import Enrollment Token** and paste it.

You don't have to be on a course roster yet — rosters usually arrive after the first submission, and the credential doesn't depend on one.

If you skip this, recording still works; the log just won't carry your identity, and your course may not be able to attribute it to you. Do it before you start the first assignment.

> **Working on more than one computer?** That is a normal, supported thing to do — see [Using a second computer](#using-a-second-computer) below. Do **not** copy your identity secret between machines.

### 3. Open your work

Open the assignment folder — or any folder **above** it — in VS Code:

- **File → Open Folder…**, then select the folder.

The recorder looks for `.provenance-manifest` anywhere beneath the folder you opened, so a parent folder works fine. If you keep all your coursework in one directory and open that, every assignment inside it is found, and two assignments open at once each record independently.

What does **not** work is opening a folder _inside_ the assignment — the manifest is then above you, outside the search, and nothing activates. If you're unsure, open the assignment folder itself.

### 4. Confirm it's recording

Look at the **status bar** along the bottom of the VS Code window:

![The status bar shows "Provenance: recording"](images/status-bar.png)

**If you see `Provenance: recording`, you're set.** That indicator is the only visible change — no popups, no toolbars, no slowdown. Write, save, run, and debug exactly as you normally would; IntelliSense, the integrated terminal, your keybindings, and your theme are all untouched.

If you **don't** see it, your work isn't being logged yet — see [Troubleshooting](#troubleshooting) below.

> A hidden `.provenance/` folder appears inside the assignment folder — that's where the log lives. Don't delete it and don't edit it. Whether you **commit** it depends on how the assignment is submitted; see step 6.

### 5. Work normally

Just do the assignment. The log is appended continuously, so you can:

- Close your editor and come back later — reopening the folder starts a new session that links to the previous one. Nothing is lost.
- Use the integrated terminal, run and debug code, install other extensions — all fine.

There's nothing to start or stop. As long as the status bar says `Provenance: recording`, you're covered.

### 6. Submit

#### If your assignment uses ZIP submission

1. Open the command palette: **`⇧⌘P`** (macOS) / **`Ctrl+Shift+P`** (Windows/Linux).
2. Type **`Prepare Submission Bundle`** and select **Provenance: Prepare Submission Bundle**.

![Running "Provenance: Prepare Submission Bundle" from the command palette](images/command-palette.png)

A sealed **`.zip`** is saved next to your assignment folder; VS Code shows you where. If more than one assignment is recording, you'll be asked which one to seal.

Upload **only that `.zip`** — nothing else. It already contains your assignment files as well as the log, so you don't submit your code separately.

#### If your assignment uses git submission

There is no seal command to run. `.provenance/` is part of the repository:

```sh
git add -A
git commit -m "..."
git push
```

Two things to watch:

- **Don't exclude it.** Make sure no `.gitignore` covers `.provenance/`. If part of the log never reaches the repo, that missing piece shows up as a gap in your record.
- **Push what you've done.** The recorder keeps a signed seal inside `.provenance/` up to date as you work, so whatever you push is always sealed — but only work you've actually pushed is in the record. Commit and push regularly rather than once at the end.

If you're working with a partner in one repository, both of you record into the same `.provenance/` folder, and both sets of logs travel with the repo. That's expected. Never delete or rewrite files there that aren't yours.

---

### Using a second computer

Work on a laptop and a desktop? Both are recognised as you, and setting up the second one is just step 2 again:

1. Install the recorder on the second computer.
2. Run **Provenance: Show My Enrollment Key** there — that machine generates **its own** key.
3. Go to `/enroll`, sign in with the same university account, and import the credential it gives back.

Each machine gets its own credential, both are grouped under the same identity, and you can swap between them freely.

**Do not copy your identity secret from one machine to the other.** The recorder has **Back Up / Restore Student Identity Secret** commands, but they exist for one purpose: keeping a backup (in your password manager) so you can recover a machine's identity if you lose it. There is no copy on any server, so that backup is the only recovery path — and moving the one value that can sign as you between computers, for a flow that doesn't need it, only puts it at risk.

### Troubleshooting

**The status bar doesn't say `Provenance: recording`.**
The recorder only activates for an authorized assignment folder. Check that:

- You opened the assignment folder itself, or a folder above it — **not** a folder inside it.
- The `.provenance-manifest` file is still present in the assignment folder.
- You installed the build the course expects. If the manifest's signature doesn't verify against your installed build, recording won't start — reinstall the version posted for this assignment.

**The "Prepare Submission Bundle" command isn't in the palette.**
The command only appears while the extension is active. Confirm the `Provenance: recording` indicator first (above). If your assignment uses git submission, there is nothing to run — commit and push instead.

**I closed my editor in the middle of the assignment — did I lose my log?**
No. The log is written continuously, not held until submission. Reopen the folder and keep working; the new session links to the previous one.

**Sealing the submission bundle failed.**
You'll see an error message. The usual cause is a partially-written log file, which the recorder repairs automatically on the next launch. Reopen the folder and run **Prepare Submission Bundle** again.

**I lost the computer my credential was on.**
If you took a backup with **Back Up Student Identity Secret**, restore it with **Restore Student Identity Secret**. If you didn't, just enrol the new machine at `/enroll` as in step 2 — you'll get a fresh credential under the same identity. Tell your course either way, so any recording made in between can be accounted for.

**Can I see exactly what was recorded?**
Yes. The files in the hidden `.provenance/` folder (`session-*.slog`) are plain newline-delimited JSON. Open them in any text editor and read every event as it was logged. Recording is fully transparent — there are no hidden signals.

### Privacy at a glance

- The log lives **only on your computer** until you hand it in — by uploading the sealed `.zip`, or by pushing your repository.
- The recorder makes **no network requests** while recording and sends nothing anywhere automatically. Enrolling is a manual copy-and-paste through your browser, and it happens outside the editor.
- It records **nothing outside the assignment folder** — other projects, your browser, your clipboard in general, and other apps are invisible to it.
- It does **not** record your name, email address, or IP address. Your credential identifies you to your institution through an opaque reference, not through any of those.

For the complete, itemized list of what is and isn't captured, see the [extension's Marketplace page](https://marketplace.visualstudio.com/items?itemName=itsgeagle.provenance-recorder#what-it-records).
