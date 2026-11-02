---
name: reuse-checkout
description: Reuse Checkout plugin. New threads default to reusing the project's existing Project checkout environment. Use when the user asks why the new-thread environment picker preselects an existing checkout, how to opt out for one thread, or how to turn the behavior off.
---

# Reuse Checkout

When a new-thread composer opens for a project, the plugin looks up that
project's ready Project checkout environments and sets the environment picker
to reuse one. It prefers the machine already selected, then the most recently
used environment.

- It applies once per draft and project. Picking another environment by hand
  sticks until the draft is submitted or the project changes.
- A draft that already reuses an environment, such as one opened from a
  thread's "new thread here" action, is left alone.
- With no existing checkout environment, the picker keeps BB's default; the
  first thread creates the checkout and later threads reuse it.
- Reloading the window forgets which drafts were already defaulted, so an open
  draft can be defaulted again once.

Turn it off with `bb plugin disable reuse-checkout`. It has no settings.
