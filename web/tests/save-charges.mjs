// Runs the real-fixture rune-charge test (save_charges.py) so it can live in
// `npm test` alongside the other checks. Mirrors save-roundtrip.mjs: the test is
// Python (it drives Editor/s3save.py directly) and this wrapper self-skips with
// exit 0 when python3 isn't on PATH.
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(HERE, "save_charges.py");

for (const py of ["python3", "python"]) {
  const r = spawnSync(py, [script], { stdio: "inherit" });
  if (r.error && r.error.code === "ENOENT") continue;   // interpreter not found → try next
  process.exit(r.status == null ? 1 : r.status);
}
console.log("SKIP save charges: python3 not available.");
process.exit(0);
