---
name: ogidoc
description: How to work inside Ogidoc, where a person and an agent build software by taking turns on one pseudocode file while the agent writes the real code underneath. Use when you are the agent in an Ogidoc session, or when someone wants to start one.
---

# Ogidoc

Ogidoc is a way to build software with a person without chatting. You and the
person share one plain-text file of pseudocode, the plan, and take turns editing it.
While the plan gets clearer, you build the real code underneath it. The person rarely
reads that code. They read the plan, and they run the result.

The person works close to the code. They decide the structure, the interfaces and
where each thing lives, often in something that reads like code but wouldn't compile.
Turning that into a program that runs is yours.

## The plan belongs to both of you

The person writes in whatever style they think in: lowercase prose, arrows,
something Python-shaped, half sentences. Follow their style. Write in it as if you
were the same author on a good day, and never reformat what they wrote into your own
notation. There is no syntax. Nothing in the file is reserved.

The plan says what the software does, at the level the person thinks about it. How it
is done stays in the code: file paths, commands, build and deploy tooling, which
helpers get reused, how the work is split into commits. Don't write those into the
plan, not even in parentheses. The person wants them handled, not shown. A real name
belongs in the plan only when it is the thing the line is about, like a table or a
component the person talks about too.

You edit the plan in place. You add detail under a line, sharpen a vague line, or
rewrite one that turned out wrong. Two kinds of line carry more than code:

- a **proposal**, for an idea that isn't code yet: a feature, a cut, a refactor;
- an **example**, a concrete input and output, which becomes a test.

You don't mark these with symbols. You write them as a person would, and you tell the
editor what each line is, so it can show it.

## Decide, then show the other ways

Work like a pair programmer who has the keyboard: make the call, build it, and show the
other ways right where they apply. Don't ask in prose.

Most decisions are yours, and the person never needs to see them: names, file layout,
test style, small refactors, how commits are split, anything cheap to change later.
Decide those and move on.

A few decisions are worth showing, because they are expensive to undo or the person
would notice them: a new dependency, a data model or schema, a public interface, where
a source of truth lives, behavior the person would see. For those, offer a **choice**:

- Build the option you think is best. When you are unsure, build the one that is
  cheapest to change later. Write it into the plan as usual. It is option 1.
- Give one to three real alternatives as the other options, written in the plan's
  style, each a line or a block of lines that would take its place.
- Keep going. A choice never holds up the turn.

The person cycles through the options in place, and can edit one like any other
line. If they switch to another option and hand over, build that one and offer the
rest again, with the new pick first. If they hand over and kept your pick, the
choice is settled: leave it out. They can also lock one in themselves, and then the
choice is gone before your turn; build what the plan says there.

**Comments** are the person's. They pin one to a line when they want to say something
about it. Answer in the thread, change the plan if the answer calls for it, and
resolve the thread once the answer is in the plan. You can't start one.

## Taking turns

Only one side edits at a time. When the person hands over to you, read what they changed.
Their edits are the message, and so are the options they picked and the comments they
left. A line they rewrote means your version was wrong.

A turn has no fixed size. The person and you both prefer small ones, because a small
turn can't hide an assumption. When the next piece is clear, build it. When the work
is simple and clear all the way, keep going. When you reach a decision worth showing,
build your pick and offer the others as a choice. When you reach something you can't
build without the person, like a credential or a fact only they know, build everything
around it and stop there; say what is missing in your summary.

## Building underneath

Each piece you build is a baby step in the TDD sense. Take a line you understand,
write a test that fails for the right reason, make it pass, tidy up. Examples in the
plan become test cases almost word for word. For other lines, pick the kind of test
the line deserves from context: a unit test, a render test, a query test.

Every line carries a build status, and the person trusts it more than anything else
on screen, so keep it honest:

- **built** means code exists for this line and a test covers it. A heading counts as
  built when everything under it is.
- **stale** means the line is new or changed since you last built it.
- **blocked** means the line waits on a comment the person opened.

When every line is built, no comment or choice is open, and the checks pass, the plan looks
finished, and that has to mean the software is finished.

## Boxes keep the plan short

When a piece is settled, move it out of the plan into a box. Give the box a name that
says what it does, put the settled lines inside it, and leave a short reference in the
plan where the lines were. The plan gets shorter and keeps only what is still open, so
decided things stop getting in the way. You decide when a piece is ready. The person
can open a box and edit inside it, and that is how they disagree with an abstraction.
Treat an edited box like any other change: rebuild what it now says.

When a line is about something that has a name in the codebase, use that name, so the
editor can link it to the code.

## Code you didn't write this turn

Code that changed outside a turn is the person's work. Build on it as it is, and don't
ask about it. Mention it in your summary only when it changed what you did.

## Starting a session

From the project directory:

    ogidoc feature.plan --agent claude --open   # or --agent pi

This opens the editor in the browser. If `ogidoc` is not on the path, install it
with `npm install -g github:brianjmeier/ogidoc`. The plan file and its boxes live
next to the code as plain text, so they diff in git like everything else.
