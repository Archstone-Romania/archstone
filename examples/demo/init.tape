# The launch GIF: `archstone init` against a real OpenAPI document.
#
# Render from the REPOSITORY ROOT, after `cd archstone && pnpm build`:
#
#     vhs archstone/examples/demo/init.tape
#
# Root-relative on purpose: GitHub Actions runs from the checkout root, and a tape that only
# worked from one of the two would drift out of sync with the workflow that renders it.
#
# The spec it reads is `examples/demo/stays-openapi.yaml`, which describes
# `examples/demo/mock-stays-server.mjs` — the demo's own backend. The manifest it produces is
# compared against the hand-written `examples/manifests/tourism/` by
# `packages/init/test/second-oracle.test.ts`, so the *compile* path this GIF walks is covered
# by the suite.
#
# WHAT THE SUITE DOES NOT COVER, AND WHY THIS FILE IS FRAGILE ON PURPOSE: the answers below are
# positional. They are Enters and words fed to whatever the gate asks, in order. Add, remove or
# reorder a prompt and the GIF still renders — it just renders something wrong, silently, which
# is the same failure class this increment spent three rounds eliminating from the compiler.
# There is no assertion that can catch it; a human has to watch the result. Re-render and LOOK
# at it whenever `packages/cli/src/init.ts`'s gate changes.

Output archstone/docs/init.gif

Set Shell bash
Set FontSize 17
Set Width 1080
Set Height 720
Set Padding 22
Set Theme { "background": "#131110", "foreground": "#EEE8DB", "cursor": "#E9A23B", "black": "#131110", "red": "#D98A22", "green": "#E9A23B", "yellow": "#E9A23B", "blue": "#A79D8B", "magenta": "#E9A23B", "cyan": "#A79D8B", "white": "#EEE8DB", "brightBlack": "#6E6656", "brightGreen": "#FFC873", "brightYellow": "#FFC873", "brightWhite": "#FFFFFF" }

# Staging, hidden: a scratch directory, the spec, and an `archstone` on PATH pointing at the
# built CLI. Nothing here is part of the story being told.
Hide
Type `export CLI="$PWD/archstone/packages/cli/dist/index.js" && export D=$(mktemp -d) && cp archstone/examples/demo/stays-openapi.yaml "$D/openapi.yaml" && printf '#!/bin/sh\nexec node "$CLI" "$@"\n' > "$D/archstone" && chmod +x "$D/archstone" && export PATH="$D:$PATH" && cd "$D" && export PS1='\[\e[33m\]$\[\e[0m\] ' && clear`
Enter
Sleep 3s
Show

Type "archstone init openapi.yaml --out wanderlust --company wanderlust --domain tourism"
Sleep 700ms
Enter
Sleep 5s

# Company id — the default came from --company
Enter
Sleep 800ms
Type "Wanderlust Travel"
Enter
Sleep 800ms
# Domain — default from --domain
Enter
Sleep 800ms
# Env var holding the base URL — default derived from the company id
Enter
Sleep 1200ms

# The one candidate: keep it, name it, and confirm the effect. The effect is the only answer
# here with no default, deliberately: it is the difference between looking up a price and
# charging a card.
Type "y"
Enter
Sleep 800ms
Type "tourism.search"
Enter
Sleep 800ms
Type "read"
Enter
Sleep 700ms
# Resource name — blank derives it from the source
Enter
Sleep 4s

Type "clear"
Enter
Sleep 400ms

# The payoff: what it wrote. Business shape only, with its own provenance in the header.
Type "cat wanderlust/tourism.search.capability.yaml"
Sleep 500ms
Enter
Sleep 6s
