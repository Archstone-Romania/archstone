# Identity — who a call acts as

Archstone never resolves identity. **Your host does, and hands the result over.** This document
is what to wire, what Archstone guarantees about it, and what it deliberately refuses to do.

If you are evaluating Archstone for a regulated deployment, this is usually the first question
your security review asks — and the answer is smaller than expected, on purpose.

---

## The decision, stated plainly

> Archstone accepts an **opaque principal string** supplied by the host, and never parses,
> decodes, verifies, or interprets it. At any entry point. Ever.

Token validation — JWT signature checks, JWKS retrieval, session lookup, mTLS, an opaque token
introspection call — happens in your identity infrastructure, before Archstone is invoked. What
reaches Archstone is the *conclusion*: a string that means "this call acts as this subject".

Two reasons, and the second is the load-bearing one:

1. **We would be worse at it than you are.** Your IdP, your session store, your rotation policy,
   your revocation semantics. A compiler that re-implemented a subset of that would be a second,
   drifting source of truth about who your users are.
2. **The seam is synchronous, and verification is not.** `resolveCaller` is a synchronous
   function that has shipped since v0.4.0. JWKS retrieval is asynchronous and network-bound. In-core
   verification would either break that published signature or put an uncacheable network call
   in the hot path of a stateless edge runtime — on every invocation.

## What that means for SSO and SCIM

**Archstone has no SSO or SCIM feature, and will not grow one**, because there is no Archstone
account for an identity provider to federate into or a directory to provision. Your users
authenticate to *your* application; Archstone is a library inside it.

If a questionnaire asks "does the product support SAML/OIDC SSO?", the accurate answer is: the
application embedding Archstone does, using whatever it already uses, and Archstone consumes its
output. Nothing about a capability changes when you change IdP.

---

## Wiring it

### HTTP (`archstone serve --http`, or an embedded `mcpHandler`)

```ts
import { mcpHandler } from "@archstone/agent/mcp";

const handler = mcpHandler(archstone, {
  bearerToken: process.env.ARCHSTONE_HTTP_TOKEN,   // who may reach this endpoint at all
  resolveCaller: (request) => {
    // Your verification, your infrastructure. Whatever this returns is taken at face value.
    const claims = verifyAccessToken(request.headers.get("authorization"));
    return { principal: claims.sub, accessToken: claims.rawToken };
  },
});
```

Two orthogonal controls, and conflating them is the mistake worth avoiding:

| Control | Question it answers |
|---|---|
| `bearerToken` | May this client reach the MCP endpoint at all? |
| `resolveCaller` | Whose data does this already-authorized call act on? |

A caller that passes the bearer token can still supply no principal, or a wrong one. The second
control is where per-user authorization lives.

### Embedded SDK

```ts
await archstone.execute("bank.transfer", input, {
  caller: { principal: "user:alice", accessToken },
});
```

### `invoke.caller` on the HTTP path — a trap worth knowing

On the HTTP handler, a static `invoke.caller` is **overwritten** by `resolveCaller`'s result:
the handler builds `{ ...invoke, caller: resolveCaller?.(request) }`, and the explicit key wins
over the spread. With no `resolveCaller`, that means **no principal at all** — the call
fails closed, loudly, on the first attempt, with zero outbound requests.

That is deliberate (ADD-42 D-13). The alternative — merging a static caller in when
`resolveCaller` is absent — trades a loud outage for silent misattribution of every user's
actions to one service account, which is worse in exactly the deployments that care. Use
`resolveCaller` on HTTP, or nothing.

`serveStdio` is genuinely different: one process, one static caller, no per-request seam to
clobber. That is correct there and stays.

---

## Guarantees you can quote in a review

- **An absent principal is anonymous, not denied.** No sentinel string, no synthesized value.
  The teeth live in the capability's declared policy: a capability that must not serve anonymous
  callers declares `policies: [authenticated]`, and the denial is enforced at the evaluation
  point, before any connector work — no backend call, no credential read, no egress.
- **A `resolveCaller` that throws is a fail-closed denial**, not an escaping exception.
- **Principal and credential are two separate fields**, because the audit record must always
  record the first and must never record the second. Credentials are redacted out of records
  before emission; the principal is deliberately not, since a redacted principal makes the trail
  useless as evidence.
- **The principal is recorded verbatim** in every execution record, including denied attempts —
  which is what makes "who tried what, and what were they refused" answerable after the fact
  (`archstone audit --principal … --phase denied`).
- **Nothing about the principal reaches us.** Archstone performs no outbound call of its own; the
  records are written to a sink you supply, on infrastructure you run.

## What you still own

Issuing, rotating and revoking tokens; mapping your IdP's subject to the principal string you
want in the audit trail (stable ids age better than email addresses); and deciding whether a
capability may be invoked anonymously at all — which is a line in your manifest, not a setting
here.
