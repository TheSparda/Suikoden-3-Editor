// Runs the save-engine round-trip test (save_roundtrip.py) so it can live in `npm test`
// alongside the JS checks. The save engine is Python (Editor/s3save.py — the same module the
// web app runs in Pyodide), so the test itself is Python; this wrapper just invokes it and
// self-skips (exit 0) when python3 isn't on PATH, mirroring e2e.mjs's skip-clean behavior.
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(HERE, "save_roundtrip.py");

for (const py of ["python3", "python"]) {
  const r = spawnSync(py, [script], { stdio: "inherit" });
  if (r.error && r.error.code === "ENOENT") continue;   // interpreter not found → try next
  process.exit(r.status == null ? 1 : r.status);
}
console.log("SKIP save round-trip: python3 not available.");
process.exit(0);
