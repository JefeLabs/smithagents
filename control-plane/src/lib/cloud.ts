/**
 * Cloud mode is not implemented. The hosted switchboard is what will make operator
 * identity meaningful; until then this is false and the avatar never renders.
 *
 * Deliberately a constant rather than a query: there is no endpoint to ask, and
 * inventing one would build the seam twice. Everything downstream reads the flag,
 * never the literal, so making it real later is a one-line change here.
 *
 * The `: boolean` annotation is load-bearing, not noise. Without it the type is the
 * literal `false`, so a future `if (CLOUD_MODE) { … }` narrows its body to `never`:
 * tsc and biome both accept whatever is written in there, dead, unchecked, and
 * looking live. Widening the type keeps those branches honestly type-checked while
 * the value stays false.
 */
import { isCloud } from "../api/origin";

export const CLOUD_MODE: boolean = isCloud();
