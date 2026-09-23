// @archstone/init — Postgres adapter, contract-recording gate (ADR-0012 D-10 / BR-20)
//
// "A SQL capability is never proposed with a contract but no isolation test" — extends
// internal ADD-37 Challenge 2 item 3's existing "contract is all-or-nothing" rule with a
// SECOND all-or-nothing axis specific to `sql`: a contract additionally requires a
// `negativeIdentity` to be recordable at all. Pure decision function — no fs, no network; the
// host decides whether/how to actually record a fixture based on this answer.

export interface NegativeIdentityAvailable {
  principal: string;
}

/**
 * Should `init` record a `contract:` (and its accompanying golden fixture) for a proposed
 * `sql`-bound capability? `false` whenever no second identity is available — non-interactive
 * mode with none supplied, or a human declining to provide one — in which case `init` records
 * NO `contract:` at all for that capability (BR-20), never a testable-looking one with no
 * isolation proof.
 */
export function canRecordSqlContract(negativeIdentity: NegativeIdentityAvailable | undefined): boolean {
  return negativeIdentity !== undefined && negativeIdentity.principal.length > 0;
}
