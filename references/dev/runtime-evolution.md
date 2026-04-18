# Runtime Evolution Notes

This file is part of `web-backlinker-v3-operator`.

It is the retained development reference for V3 runtime evolution.
It replaces the former development-phase sibling skills that separately described:
- retry/classifier phase rollout
- terminal/classifier phase changes

Those names are no longer active skill entry points.
The underlying development knowledge is preserved here as one merged reference.

## Purpose

Use this file when you are changing BacklinkHelper's runtime behavior rather than simply operating one task.
Typical topics include:
- finalize-time classification
- retry / rerun semantics
- queue repartition behavior
- terminal vs non-terminal outcome boundaries
- status/reporting alignment with business truth

Do not read this file for ordinary single-task operator execution unless the run reveals a real runtime-design problem.

## Core principle

Push truth from the earliest authoritative layer forward:
1. execution / finalize decides the best available terminal or wait truth
2. artifacts preserve that structured truth
3. queue / repartition consumes the structured truth
4. status / reporting reflects business outcome instead of raw mechanical state

Do not start from the reporter and work backwards.

## Typical maintenance questions

When changing the runtime, ask in this order:
- Is the wrong decision being made in execution/finalize?
- Is the decision correct but not being serialized clearly enough?
- Is queue logic ignoring valid classifier output?
- Is reporting flattening distinct outcomes into the same bucket?

## Boundary

This is a retained dev/maintenance reference inside the V3 package.
It is not a standalone run skill.
If work is purely operational, stay in the normal V3 references instead.
