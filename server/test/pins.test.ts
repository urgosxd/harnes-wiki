import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Pi's packages depend on each other with `^` ranges. If they resolve out of step,
 *  the SDK can pair one version's code with another version's types, which is the
 *  documented way this integration breaks. Every Pi package must be exact. */
test("every @earendil-works package is pinned to an exact version", () => {
  const pkg = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const pinned = { ...pkg.dependencies, ...pkg.devDependencies };
  const piPackages = Object.entries(pinned).filter(([name]) =>
    name.startsWith("@earendil-works/"),
  );

  assert.ok(piPackages.length > 0, "expected at least one @earendil-works dependency");

  const floating = piPackages.filter(([, range]) => !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(range));
  assert.deepEqual(
    floating,
    [],
    `these Pi packages are not exact: ${floating.map(([n, r]) => `${n}@${r}`).join(", ")}`,
  );
});

test("all installed @earendil-works packages share one version", () => {
  const pkg = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };

  const versions = new Set(
    Object.entries(pkg.dependencies ?? {})
      .filter(([name]) => name.startsWith("@earendil-works/"))
      .map(([, range]) => range),
  );

  assert.equal(
    versions.size,
    1,
    `Pi packages must move together, found: ${[...versions].join(", ")}`,
  );
});
