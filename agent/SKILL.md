---
name: underpaint
description: How to work inside Underpaint, where a person and an agent build software by taking turns on one pseudocode file while the agent writes the real code underneath. Use when you are the agent in an Underpaint session, or when someone wants to start one.
---

# Underpaint

Underpaint is a way to build software with a person without chatting. You and the
person share one plain-text file of pseudocode, the plan, and take turns editing it.
While the plan gets clearer, you build the real code underneath it. The person rarely
reads that code. They read the plan, and they run the result.

Painters start with a rough layer called the underpainting and keep painting until it
is the finished picture. Here the rough layer is the only part the person touches.
The finished work goes on underneath it, and that part is yours.

## The plan belongs to both of you

The person writes in whatever style they think in: lowercase prose, arrows,
something Python-shaped, half sentences. Follow their style. Write in it as if you
were the same author on a good day, and never reformat what they wrote into your own
notation. There is no syntax. Nothing in the file is reserved.

You edit the plan in place. You add detail under a line, sharpen a vague line, or
rewrite one that turned out wrong. There is no reply box, so anything you want to say
goes into the plan next to the line it is about:

- a **question**, when you can't go further without the person;
- an **answer**, under a question the person asked you;
- a **proposal**, for an idea that isn't code yet: a feature, a cut, a refactor;
- an **example**, a concrete input and output, which becomes a test.

You don't mark these with symbols. You write them as a person would, and you tell the
editor what each line is, so it can show it.

## Taking turns

Only one side holds the pen. When the person passes it to you, read what they changed.
Their edits are the message. A deleted question means it was answered somewhere
nearby. A line they rewrote means your version was wrong.

A turn has no fixed size. The person and you both prefer small ones, because a small
turn can't hide an assumption. When the next piece is clear, build it. When the work
is simple and clear all the way, keep going. When you reach something you would have
to guess, don't guess. Either stop there, or build everything around it that doesn't
depend on it and leave the open decision as a question. Some turns build nothing and
only ask. That is a good turn.

## Building underneath

Each piece you build is a baby step in the TDD sense. Take a line you understand,
write a test that fails for the right reason, make it pass, tidy up. Examples in the
plan become test cases almost word for word. For other lines, pick the kind of test
the line deserves from context: a unit test, a render test, a query test. If you can't
tell, ask.

Every line carries a build status, and the person trusts it more than anything else
on screen, so keep it honest:

- **built** means code exists for this line and a test covers it. A heading counts as
  built when everything under it is.
- **stale** means the line is new or changed since you last built it.
- **blocked** means the line waits on an open question.

When every line is built, nothing is open, and the checks pass, the plan looks
finished, and that has to mean the software is finished.

## Boxes keep the plan short

When a piece is settled, move it out of the plan into a box. Give the box a name that
says what it does, put the settled lines inside it, and leave a short reference in the
plan where the lines were. The plan gets shorter and keeps only what is still open, so
decided things stop getting in the way. You decide when a piece is ready. The person
can open a box and edit inside it, and that is how they disagree with an abstraction.
Treat an edited box like any other change: rebuild what it now says.

Use the real names of the codebase once you know them. Name tables, components and
functions as they are actually called, and the editor will recognize them.

## Code you didn't write this turn

If code under the plan changed outside a turn, don't quietly rewrite the plan or the
code to match. Ask about it with a question on the line it affects.

## Starting a session

From the project directory, with the `underpaint` command on the path (run `npm link`
inside the `underpaint` package once):

    underpaint feature.plan --agent claude --open   # or --agent pi

This opens the editor in the browser. Without `npm link`, run
`node path/to/underpaint/bin/underpaint.js` the same way. The plan file and its boxes live next to the
code as plain text, so they diff in git like everything else.
