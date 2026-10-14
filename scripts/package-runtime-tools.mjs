import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

// Preserve the installed, lockfile-resolved migration tools without shipping
// unrelated development tools (including native CLI binaries) in production.
const source = resolve(process.argv[2] ?? ".");
const destination = resolve(process.argv[3] ?? ".runtime-tools");
const modules = join(source, "node_modules");
const visited = new Set();

function findPackage(name, parent) {
  let current = parent;
  while (current === source || current.startsWith(`${source}${sep}`)) {
    const candidate = join(current, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (current === source) break;
    current = dirname(current);
  }
  return undefined;
}

function copyPackage(name, parent = source, optional = false) {
  const directory = findPackage(name, parent);
  if (!directory) {
    if (optional) return; // Platform-specific binaries may be absent.
    throw new Error(`Missing runtime-tool dependency: ${name}`);
  }
  if (visited.has(directory)) return;
  visited.add(directory);

  const packagePath = relative(modules, directory);
  if (packagePath.startsWith(`..${sep}`) || packagePath === "..") {
    throw new Error(`Dependency is outside the installed module tree: ${name}`);
  }
  const target = join(destination, "node_modules", packagePath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(directory, target, { recursive: true });

  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const optionalDependencies = manifest.optionalDependencies ?? {};
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    copyPackage(dependency, directory, dependency in optionalDependencies);
  }
  for (const dependency of Object.keys(optionalDependencies)) {
    copyPackage(dependency, directory, true);
  }
}

// Drizzle's database driver is an optional peer, so include it explicitly.
for (const name of ["drizzle-kit", "tsx", "drizzle-orm", "pg"]) copyPackage(name);
console.log(`Packaged ${visited.size} installed migration-tool dependencies.`);
