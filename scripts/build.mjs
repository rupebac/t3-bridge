import { access, chmod, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const compiler = resolve(dirname(require.resolve("typescript/package.json")), "bin/tsc");
await rm(resolve(root, "dist"), { recursive: true, force: true });
execFileSync(process.execPath, [compiler, "-p", resolve(root, "tsconfig.build.json")], {
  cwd: root,
  stdio: "inherit",
});
const cli = resolve(root, "dist/cli.js");
try {
  await access(cli);
  await chmod(cli, 0o755);
} catch {
  // The CLI entrypoint is added with the serve command.
}
