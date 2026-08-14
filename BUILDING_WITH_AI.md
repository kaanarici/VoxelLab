# Building VoxelLab With AI

I built VoxelLab to see how far current AI coding tools could carry a project
outside the usual territory of forms, dashboards, and small web utilities. I
am not a clinician or a medical-imaging specialist, and I did not begin with a
plan to turn this into a medical product.

I did not write the implementation code by hand. AI systems generated the
application code, tests, scripts, and much of the early documentation. I chose
the direction, reviewed the output, tested the product, and decided what to
keep, rewrite, narrow, or delete.

## What the Tools Were Good At

The tools made breadth cheap. They connected a browser viewer, an Electron
shell, Python utilities, several imaging formats, automated checks, demo data,
and release packaging much faster than I could have built those pieces alone.

They worked best when the task was concrete. A request such as "keep the newest
file selection when two imports overlap" produced useful code and a testable
outcome. A request for "production quality" usually produced more code,
broader claims, and no reliable definition of done.

## Where the Process Broke Down

The hardest problems were not syntax errors. They were plausible mistakes at
the boundaries between features:

- an older upload finishing after a newer one
- a sidecar attaching to the wrong active series
- unsupported geometry being treated as calibrated
- separate helpers implementing slightly different versions of the same rule
- documentation describing paths or capabilities that no longer existed

Those mistakes can survive a quick demo, especially when the interface looks
finished. The codebase also accumulated the familiar signs of unchecked code
generation: overlapping abstractions, defensive branches without a contract,
large files, and long explanations that made simple behavior harder to find.

## What Changed

The useful work came from reducing the project to explicit contracts. Geometry
now has shared JavaScript and Python implementations with common fixtures.
Unsupported inputs are expected to fail closed. Browser, Electron, Node, and
Python checks cover the strongest user paths. Features and claims were narrowed
when the evidence did not justify them.

Independent review mattered as much as generation. Asking another model to
look specifically for state-machine failures, stale paths, unsafe assumptions,
or duplicated policy found more than asking the same model whether its work was
good.

## What I Would Do Differently

I would start with fewer formats and one complete workflow: open, inspect,
measure, and export. I would write the state and geometry contracts before
adding optional processing. I would also require a failing test before fixing
any reported race or boundary bug.

Most importantly, I would involve a domain researcher much earlier. Automated
checks can prove that code follows a declared contract. They cannot decide
whether the contract matches the work a researcher actually needs to do.

## What This Repository Is

VoxelLab is a public research viewer and a record of this experiment. It is not
clinically validated, it does not cover every variant of its supported formats,
and it has no guaranteed support schedule. The [README](README.md) describes
the current supported boundary.

The result made me more optimistic about AI as implementation capacity and more
cautious about treating generated breadth as product quality. Generation was
the inexpensive part. Choosing a coherent scope, proving the behavior, and
removing what could not be trusted took most of the judgment.
