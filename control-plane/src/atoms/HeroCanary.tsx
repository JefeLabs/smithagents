import { Button } from "@heroui/react";
import { NumberValue } from "@heroui-pro/react";

/**
 * Phase 0 canary. Delete this file and its test at the start of Phase 1 — the real
 * migrated surfaces take over its job.
 *
 * It exists because Phase 0's other three tasks all pass with a completely broken
 * HeroUI install: nothing imports HeroUI, so a missing package, an unresolved
 * stylesheet, or an un-downloaded Pro payload stays invisible until the middle of
 * Phase 1, where a pipeline bug and a migration bug look identical.
 *
 * One component from each package, deliberately:
 *   - Button  (@heroui/react)     — OSS, proves the free package and its BEM CSS.
 *   - NumberValue (@heroui-pro/react) — Pro, proves the licensed payload actually
 *     downloaded. That package publishes as a 20KB stub with no exports; its
 *     postinstall authenticates and fetches the real ~3.9M build. pnpm blocks
 *     postinstall scripts by default, so without `allowBuilds` this import resolves
 *     to nothing.
 *
 * HeroUI v3 needs no provider, and uses onPress rather than onClick.
 */
export function HeroCanary() {
  return (
    <>
      <Button>Canary</Button>
      <NumberValue value={42} />
    </>
  );
}
