# Support

## Getting help

- **Questions, bugs, feature ideas** — [open an issue](https://github.com/Archstone-Romania/archstone/issues).
- **Security vulnerabilities** — do **not** open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Commercial support** (a named counterparty, response times, backports on a version you pin) —
  `hello@archstone.dev`.

Everything Archstone compiles and runs is Apache-2.0 and always will be. `archstone build` and
`archstone serve` never require a network call, an account or a key — pin a version, vendor your
manifest, and it keeps working with no relationship to us.

---

## Which versions are supported

| Line | Meaning | Receives |
|---|---|---|
| **Current** | The latest minor | Features, fixes, security |
| **Maintenance** | The previous minor | Security fixes and fail-closed correctness defects |
| **LTS** | A minor designated under a commercial agreement | Security fixes and fail-closed correctness defects for the agreed window |
| **End of life** | Everything older | Nothing. The code keeps working — it cannot be switched off remotely — but we do not fix it |

### Today

| Line | Version | Status |
|---|---|---|
| Current | `0.12.x` | ✅ Supported |
| Maintenance | `0.11.x` | ✅ Security and fail-closed fixes |
| LTS | — | None designated yet |
| End of life | `≤ 0.10.x` | ⛔ |

---

## What gets backported

To Maintenance and to every designated LTS line:

- Security fixes.
- **Fail-closed correctness defects** — a governance path that permits what it should deny.
- Contract-integrity defects — a response that should have failed closed passing through, or an
  audit record that misattributes or omits an attempt.
- Data loss or corruption in anything you persist (the compiled IR artifact, audit records).

Not backported: features, new emitters or CDL primitives, performance work, CLI ergonomics,
dependency bumps without an advisory, refactors. Those live on Current — upgrading is the way to
get them.

---

## Pre-1.0, and what is stable anyway

The packages are `0.x`: **a minor release may contain breaking changes**, and each one states
them in [CHANGELOG.md](CHANGELOG.md).

Two things are more stable than that number suggests, and they are the two you author against:

- **CDL.** A primitive that ships is permanent — removing or redefining one is a breaking change
  we do not make. A capability you can express today stays expressible in later versions without
  new primitives.
- **Your compiled IR.** `archstone build` writes an artifact you commit to your own repository
  and rebuild in your own CI. An upgrade that changes it shows up as a diff in your pipeline,
  before production, not as a surprise after.

---

## npm dist-tags

| Tag | Points at |
|---|---|
| `latest` | The Current line — what `npm install @archstone/cli` gives you |
| `lts-<major>.<minor>` | The head of that LTS line, e.g. `lts-0.11` |

A backport is **never** published as `latest`, so a patch on an older line can never change what
a default install resolves to.
