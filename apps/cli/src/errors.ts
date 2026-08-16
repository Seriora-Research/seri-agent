// A caught value is `unknown`, not `Error` — anything can be thrown, including a bare string or a
// non-Error object from a dependency that doesn't follow the convention. Stringifying rather than
// rejecting a non-Error throw keeps every catch site that only wants a displayable message from
// having to repeat this same instanceof check by hand.
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
