/**
 * faq-content.ts — the student FAQ copy, as data.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the student FAQ. `docs/student-faq.md`
 * is a pointer to the live route, not a second copy: the two drifted apart the moment
 * they both held the text, so only one of them does.
 *
 * The route (`/faq`) is PUBLIC and unauthenticated, because the audience cannot sign
 * in. Students have no analyzer account, and the OAuth `hd` check that guards every
 * other route would turn them away. Keep it out of `RequireAuth`.
 *
 * Inline formatting is modelled as spans rather than markup so the copy never needs
 * `dangerouslySetInnerHTML`. Anchors come from `id`, and course staff link students
 * to a single answer with `/faq#q-own-paste`, so treat an `id` as a published URL:
 * renaming one breaks links that already exist in course announcements.
 */

/** A run of answer text: plain, inline code, or bolded. */
export type Span = string | { code: string } | { strong: string };

/** One paragraph of an answer. `callout` renders as an accented aside. */
export type Block = { spans: Span[]; callout?: boolean };

export type FaqItem = {
  /** Stable anchor id. Treat as a published URL; see the module comment. */
  id: string;
  question: Span[];
  answer: Block[];
};

export type FaqSection = {
  id: string;
  /** Section heading. */
  title: string;
  /** Shorter label for the contents rail. */
  navLabel: string;
  /** Optional line under the heading. */
  note?: string;
  items: FaqItem[];
};

const p = (...spans: Span[]): Block => ({ spans });
const callout = (...spans: Span[]): Block => ({ spans, callout: true });

/** The "short version" panel above the sections. */
export const FAQ_SUMMARY: readonly string[] = [
  'It records how your code came together inside one folder. Not your browser, not your other projects, nothing outside that folder.',
  'It doesn’t look at your code and judge it. There’s no “is this AI-written?” detector in it.',
  'Nothing is automatic. A person reads the record before anything happens.',
  'Copying and pasting your own code is normal and is treated as normal.',
  'If you did the work, the record is the best evidence you have that you did it.',
];

export const FAQ_SECTIONS: readonly FaqSection[] = [
  {
    id: 'what-it-does',
    title: 'What it does',
    navLabel: 'What it does',
    items: [
      {
        id: 'q-what-recorded',
        question: ['What is it recording?'],
        answer: [
          p(
            'Inside the assignment folder: your edits, pastes, saves, terminal commands, and when the editor window was focused. It writes them to a log file on your own disk as you work.',
          ),
        ],
      },
      {
        id: 'q-ai-detector',
        question: ['Is it reading my code to decide whether it looks AI-generated?'],
        answer: [
          p(
            'No. There’s no classifier in it that looks at your code and scores it, and that’s deliberate. What it looks at is how a file got written: typed, pasted, or changed by something outside the editor.',
          ),
          p(
            'Two people who write the same function the same way produce the same kind of record, whether the function is elegant or awful.',
          ),
        ],
      },
      {
        id: 'q-grade',
        question: ['Does it affect my grade?'],
        answer: [
          p(
            'No. It doesn’t produce a score and nothing about it feeds into grading. It only comes up if a question comes up.',
          ),
        ],
      },
      {
        id: 'q-why',
        question: ['Why is my course doing this?'],
        answer: [
          p(
            'The alternative is guessing from the finished code. That punishes people who write clean code quickly, people whose solution looks like the common one, and people who studied together. How the work happened is better evidence than how the result looks.',
          ),
        ],
      },
      {
        id: 'q-keylogger',
        question: ['Is this a keylogger?'],
        answer: [
          p(
            'No. It uses the editor’s document-change events, which are diffs, not keystrokes. It has no hooks into your operating system and can’t see anything you type in another application. No screen recording, no screenshots, no camera, no audio.',
          ),
        ],
      },
    ],
  },
  {
    id: 'workflow',
    title: 'Your normal workflow is fine',
    navLabel: 'Your workflow',
    items: [
      {
        id: 'q-own-paste',
        question: ['Can I copy and paste my own code?'],
        answer: [
          p(
            { strong: 'Yes.' },
            ' Moving a function to another file, copying a block and tweaking it, cutting something and pasting it back somewhere else. All normal.',
          ),
          p(
            'When a paste shows up in the log, it gets checked against what you already wrote. If the text matches something you typed earlier, it’s treated as you rearranging your own work rather than code arriving from outside.',
          ),
        ],
      },
      {
        id: 'q-outside-paste',
        question: ['What about pasting from outside, like Stack Overflow or the course website?'],
        answer: [
          p(
            'It gets recorded. Recorded isn’t flagged, and flagged isn’t in trouble. Whether a source is allowed is your course’s policy; the log just says what happened.',
          ),
        ],
      },
      {
        id: 'q-refactor',
        question: ['I refactor a lot. Big reorganizations, moving things between files.'],
        answer: [p('Fine. Same as above, and it’s the most common benign pattern there is.')],
      },
      {
        id: 'q-formatter',
        question: ['I run a formatter on save.'],
        answer: [p('Fine. Reformatting shows up as reformatting.')],
      },
      {
        id: 'q-git',
        question: [{ code: 'git pull' }, ' rewrites my files.'],
        answer: [
          p('Expected. Changes made by tools outside the editor are recorded as exactly that.'),
        ],
      },
      {
        id: 'q-scratch',
        question: ['I write in a scratch file first, then move it into the real file.'],
        answer: [
          p(
            'Fine, as long as the scratch file is inside the assignment folder. Then the whole path is in the record.',
          ),
        ],
      },
      {
        id: 'q-restart',
        question: ['I deleted the file and started over.'],
        answer: [p('Fine. The record shows you deleted it and started over.')],
      },
      {
        id: 'q-fast',
        question: ['I write a lot of code very fast.'],
        answer: [
          p('Not a problem. Three hours of heavy typing reads as three hours of heavy typing.'),
        ],
      },
      {
        id: 'q-thinking',
        question: ['I thought about it for a week, then wrote it in one sitting.'],
        answer: [
          p(
            'The record can’t see you thinking. If you work it out on paper and then type the finished thing in ninety minutes, the log shows ninety minutes of typing. That’s a real limitation and it’s known.',
          ),
          p(
            'It’s also why a person reads anything unusual instead of a number deciding. “I worked it out away from the computer” is an ordinary explanation that gets accepted.',
          ),
        ],
      },
      {
        id: 'q-perform',
        question: ['Do I need to type slowly, or avoid pasting, or perform for it?'],
        answer: [
          p(
            'No. Working unnaturally to look good for a log makes your record less like how you actually work, which helps nobody. Just do the assignment.',
          ),
        ],
      },
      {
        id: 'q-which-editor',
        question: ['Which editor should I use?'],
        answer: [
          p(
            'One your course supports. There are recorders for VS Code, JetBrains, and Neovim, but your course decides which of them it accepts, so check before you start. Anything you write in an editor without a recorder isn’t recorded.',
          ),
        ],
      },
    ],
  },
  {
    id: 'recorded',
    title: 'What it records, and what it doesn’t',
    navLabel: 'What’s recorded',
    items: [
      {
        id: 'q-where',
        question: ['Where does the log go?'],
        answer: [
          p(
            'A hidden ',
            { code: '.provenance/' },
            ' folder inside the assignment folder, on your computer. Nothing leaves your machine until you hand it in, by uploading the sealed zip or pushing your repository.',
          ),
        ],
      },
      {
        id: 'q-network',
        question: ['Does it send anything anywhere while I’m working?'],
        answer: [p('No. There’s no code in it that talks to a network during a session.')],
      },
      {
        id: 'q-other-stuff',
        question: ['Can it see my other projects, my browser, or my clipboard?'],
        answer: [
          p(
            'No. It only activates inside a folder your course authorized, and only sees events in that folder. It doesn’t read your clipboard in general; it sees the text of a paste that lands in an assignment file.',
          ),
        ],
      },
      {
        id: 'q-name',
        question: ['Does the log have my name in it?'],
        answer: [
          p(
            'No name, no email, no IP address. Your identity is carried as an opaque reference your institution can resolve.',
          ),
        ],
      },
      {
        id: 'q-read-own',
        question: ['Can I read my own log?'],
        answer: [
          p(
            'Yes. The files in ',
            { code: '.provenance/' },
            ' are plain newline-delimited JSON. Open one in any text editor and read every event as it was written. Nothing in there is hidden from you.',
          ),
        ],
      },
      {
        id: 'q-slow',
        question: ['Does it slow my editor down?'],
        answer: [p('No. The status bar indicator is the only difference you should notice.')],
      },
      {
        id: 'q-retention',
        question: ['How long is my submission kept?'],
        answer: [
          p(
            'Your institution sets a retention period, after which the stored copy is deleted. Ask your course for the specific number.',
          ),
        ],
      },
    ],
  },
  {
    id: 'who-looks',
    title: 'Who looks at this',
    navLabel: 'Who sees it',
    items: [
      {
        id: 'q-reads',
        question: ['Does someone read my log?'],
        answer: [p('For most submissions, nobody ever opens it.')],
      },
      {
        id: 'q-automatic',
        question: ['Is anything automatic?'],
        answer: [
          p(
            'No. It doesn’t email your instructor, mark your submission, or file a report. It sorts submissions for staff to look at. That’s the extent of it.',
          ),
        ],
      },
      {
        id: 'q-auto-dq',
        question: ['Can I be automatically disqualified or reported?'],
        answer: [
          p(
            { strong: 'No.' },
            ' Nothing in it does anything to you on its own. Every outcome requires a person to read your record, decide it’s worth a conversation, and start one through your course’s normal academic integrity process.',
          ),
        ],
      },
      {
        id: 'q-odd',
        question: ['What if something in my record looks odd?'],
        answer: [
          p(
            'A person reads it and can step through what actually happened, in order. Usually the context is the explanation: the odd moment turns out to be a refactor, a ',
            { code: 'git pull' },
            ', or a formatter.',
          ),
        ],
      },
      {
        id: 'q-see-record',
        question: ['If I’m asked about my record, can I see it?'],
        answer: [
          p(
            'You already have it. Your copy of ',
            { code: '.provenance/' },
            ' is the same log that was submitted.',
          ),
        ],
      },
    ],
  },
  {
    id: 'why-it-helps',
    title: 'Why this is on your side',
    navLabel: 'Why it helps you',
    items: [
      {
        id: 'q-helps-me',
        question: ['How does this help me?'],
        answer: [
          p(
            'Without a record, suspicion rests on how the finished code looks: too clean, too fast, too close to the standard solution, too similar to the person you sat next to all semester. You’d have nothing to answer with except insisting you wrote it.',
          ),
          p(
            'The record shows the false starts, the bug you had for forty minutes, the variable you renamed three times. That’s hard to fake and hard to argue with.',
          ),
        ],
      },
      {
        id: 'q-more-data',
        question: ['Doesn’t more data just mean more ways to get caught?'],
        answer: [
          p(
            'If you did the work, it’s evidence you didn’t have before. If you didn’t, you’re where you would have been anyway.',
          ),
          p(
            'There’s also an effect across the whole class. When most submissions carry a clear record of ordinary work, staff don’t need to squint at everyone, and fewer people get pulled into a conversation over a hunch about their coding style.',
          ),
        ],
      },
      {
        id: 'q-surveillance',
        question: ['Isn’t this surveillance?'],
        answer: [
          p(
            'It records what you do in one folder, while you’re doing one assignment, into a file on your own computer that you can read. It doesn’t run anywhere else and doesn’t send anything on its own. You can still dislike it, but it’s narrower than the word suggests.',
          ),
        ],
      },
    ],
  },
  {
    id: 'partner',
    title: 'Working with a partner',
    navLabel: 'With a partner',
    items: [
      {
        id: 'q-shared-repo',
        question: ['We share one repository. Do we both record?'],
        answer: [
          p(
            'Yes. You both record into the same ',
            { code: '.provenance/' },
            ' folder and both sets of logs travel with the repo.',
          ),
          callout(
            { strong: 'Don’t delete or rewrite files in .provenance/ that aren’t yours.' },
            ' If your partner’s log is missing from a push, it looks like a gap in their record.',
          ),
        ],
      },
      {
        id: 'q-attribution',
        question: ['Will my partner’s work be attributed to me, or mine to them?'],
        answer: [
          p(
            'Some of the record is clearly per-person and some describes the repository as a whole. Anyone reading it can tell which is which.',
          ),
        ],
      },
      {
        id: 'q-pairing',
        question: ['We pair programmed on one laptop.'],
        answer: [
          p(
            'Then the log shows one machine doing all the work, which is accurate but incomplete. Mention it to your course so the record matches what happened.',
          ),
        ],
      },
    ],
  },
  {
    id: 'mess-up',
    title: 'Did I mess up?',
    navLabel: 'Did I mess up?',
    note: 'Say so early. A gap you mention is administrative; a gap found later is a conversation.',
    items: [
      {
        id: 'q-not-recording',
        question: [
          'I worked for an hour and the status bar never said ',
          { code: 'Provenance: recording' },
          '.',
        ],
        answer: [
          p(
            'That hour isn’t in the log. Usually the cause is opening a folder inside the assignment rather than the assignment folder itself or one above it. If it was a lot of work, tell your course. Nobody’s going to punish you for an install problem.',
          ),
        ],
      },
      {
        id: 'q-forgot',
        question: ['I forgot entirely and did a whole session without it.'],
        answer: [p('Same. Mention it.')],
      },
      {
        id: 'q-crash',
        question: ['My laptop died, or I force-quit the editor.'],
        answer: [
          p(
            'Nothing is lost. The log is written continuously, not held until you submit. Reopen the folder and keep going.',
          ),
        ],
      },
      {
        id: 'q-offline',
        question: ['I was on a plane with no internet.'],
        answer: [p('Fine. It doesn’t need a network.')],
      },
      {
        id: 'q-two-computers',
        question: ['I work on two computers.'],
        answer: [
          p('Supported. Set up each machine once. Don’t copy your identity secret between them.'),
        ],
      },
      {
        id: 'q-deleted',
        question: ['I deleted the ', { code: '.provenance/' }, ' folder.'],
        answer: [
          p('That work is gone from the record. Don’t try to rebuild it. Tell your course.'),
        ],
      },
      {
        id: 'q-edited-log',
        question: ['I think I edited or saved over something in ', { code: '.provenance/' }, '.'],
        answer: [
          p(
            'Tell your course and don’t try to repair it. The log is sealed, so an edit shows up as an edit however carefully it’s made. Reporting it makes it a non-event.',
          ),
        ],
      },
    ],
  },
];

/** Every anchor id on the page, for tests and for uniqueness checks. */
export const ALL_FAQ_IDS: readonly string[] = FAQ_SECTIONS.flatMap((s) => s.items.map((i) => i.id));
