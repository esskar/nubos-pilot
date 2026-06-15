---
name: np-dependency-audit
description: "Quality bar for changes that add or upgrade a third-party dependency — a new package/library, a version bump, or an edit to a manifest (package.json, composer.json, go.mod, Cargo.toml, requirements/pyproject, Gemfile, pom/gradle) or its lockfile. Triggered for executor work that touches dependency declarations or lockfiles. Encodes supply-chain and dependency-hygiene rules the change MUST satisfy before commit, not a document to author. Language- and ecosystem-agnostic."
user-invocable: false
---

# Dependency Audit

Every dependency you add is a permanent liability you now maintain and a new surface for a supply-chain attack. The bar is not "does it work" — it is "is this dependency justified, vetted, pinned, and minimal." Apply it to the manifest/lockfile change you are about to commit.

## Before editing

- Check what's already in the tree and prior decisions: `node .nubos-pilot/bin/np-tools.cjs knowledge-search "dependency for <need>" --task $TASK_ID`. A capability already pulled in transitively, or a deliberately-rejected package, beats a new top-level dep.

## Justify it

- **Default to no.** Could a few lines of your own code cover the need? Trivial things (padding, slug, uuid, simple debounce) are not worth a dependency and its update treadmill.
- **Prefer the standard library / platform.** Reach for a dependency only when it earns its keep over what the language or runtime already gives you.
- **Don't duplicate the tree.** If something equivalent is already a dependency, use it instead of adding a second one for the same job.

## Vet it before adding

- **Maintained and alive** — recent commits/releases, issues being addressed, not a one-commit abandonware repo.
- **Healthy adoption** — real usage, not a near-zero-install package that happens to match the name you typed.
- **Sane license** — compatible with the project's licensing; no copyleft/unknown license slipping into a proprietary build.
- **No known critical vulnerabilities** in the version you pick (run the ecosystem's audit/advisory check).
- **Exact name, no typosquat** — verify the precise package identifier and namespace/scope; a transposed letter or look-alike org is a known attack.
- **Wary of install hooks** — postinstall/build scripts run arbitrary code on every machine that installs; treat their presence as a reason to look closer, not a default to accept.

## Minimize the surface

- A small package that drags in 50 transitive sub-deps is a big dependency — judge the whole subtree, not the top-level line.
- Avoid pulling a heavy framework-grade dep for one function.

## Pin and record

- **Pin the version and commit the lockfile** so every build resolves identically — no floating ranges that silently upgrade a transitive package under you.
- **An upgrade is a change, not a chore.** Read the changelog for breaking changes, and confirm the bump does not introduce a vulnerable or yanked transitive version.
- **Stay SBOM-aware** — know what actually ships; don't leave dead or unused deps declared.

## Verification bar (must hold before commit)

- The dependency is justified (own code / stdlib / existing dep was considered and rejected for a reason) — not added on reflex.
- It is vetted: maintained, adopted, license-clean, free of known critical CVEs in the pinned version, exact-name-verified, install-hooks reviewed.
- Version is pinned and the lockfile is committed; the transitive surface was weighed, not ignored.
- For an upgrade: changelog read for breaking changes, and no vulnerable transitive version pulled in.
- Anything the new dep can reach (network, filesystem, credentials, deserialization) is treated as new attack surface — pair with [np-secure-design] for what it touches and [np-secure-code-review] for how it's wired in.
