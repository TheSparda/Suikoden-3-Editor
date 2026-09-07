// Does the gate cover the save loader while the Python engine boots — and only that?
//
// Loading a memory card is inert until Pyodide is up — no reference tables, no decoder, a
// disabled file picker — and on a phone that is ten-plus seconds of a form that looks ready
// and isn't. So a gate covers that card. Nothing else needs Python (the ISO editor least of
// all), so the gate must NOT cover the rest of the app. Four properties are worth a test,
// because each fails silently: the gate must actually COVER the loader (a pretty overlay with
// a live picker underneath is the bug it exists to fix), it must leave the rest of the page
// CLICKABLE (the regression this scoping fixed: a full-screen block made a working ISO editor
// look dead), it must always come DOWN (Dismiss, Escape, and the ISO shortcut), and a boot
// FAILURE must say so instead of spinning forever.
//
// Self-skips (exit 0) when playwright-core or a Chromium binary isn't available.
//
//   node web/tests/boot-gate.mjs
//   PW_CHROMIUM=/path/to/chrome node web/tests/boot-gate.mjs
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromiumPath, chromiumNote } from "./chromium-path.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch { console.log("SKIP boot-gate: playwright-core not installed."); process.exit(0); }

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const srv = http.createServer((rq, rs) => {
  let p = decodeURIComponent(rq.url.split("?")[0]);
  if (p === "/") p = "/web/index.html";
  fs.readFile(path.join(REPO, p), (e, d) => {
    if (e) { rs.writeHead(404); rs.end(); return; }
    rs.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" }); rs.end(d);
  });
});
await new Promise((r) => srv.listen(0, r));
const base = `http://localhost:${srv.address().port}/web/index.html`;

let browser;
console.log(chromiumNote());
try { browser = await chromium.launch({ executablePath: chromiumPath() }); }
catch (e) { console.log("SKIP boot-gate: no Chromium (" + e.message.split("\n")[0] + ")."); srv.close(); process.exit(0); }

let fails = 0;
const check = (name, cond, extra = "") => { console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`); if (!cond) fails++; };

// A Pyodide that hangs until the test releases it — the whole point is the window where the
// engine is NOT ready, which a real (or instantly-stubbed) engine gives no time to inspect.
const HELD_ENGINE = `
  window.__release = null;
  const held = new Promise((res) => { window.__release = res; });
  window.loadPyodide = async () => {
    await held;
    return { FS: { writeFile() {}, readFile() { return new Uint8Array([0]); } },
             runPython(code) {
               if (code.includes('load_reference()')) return JSON.stringify({ items: [], skills: [],
                 charById: {}, charRoster: {}, charChoices: [] });
               return undefined;
             } };
  };`;
const DEAD_ENGINE = `window.loadPyodide = async () => { throw new Error("boom: no runtime"); };`;

async function open(script, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { console.log("  ! pageerror: " + e.message); fails++; });
  await page.route(/jsdelivr\.net/, (r) => r.abort());   // never fetch the real 10 MB runtime
  await page.addInitScript(script);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#bootOv", { timeout: 5000 }).catch(() => {});
  return page;
}
const gone = (page) => page.waitForSelector("#bootOv", { state: "detached", timeout: 3000 })
  .then(() => true).catch(() => false);

// ---- 1. it is up, and it really covers the loader ---------------------------
console.log("boot gate blocks the save loader while the engine loads:");
{
  const page = await open(HELD_ENGINE);
  // What does a click at each element's centre actually hit — the gate, or the element?
  const hitAt = (page, sel) => page.evaluate((s) => {
    const el = document.querySelector(s); if (!el) return "missing";
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && hit.closest("#bootOv") ? "gate" : (hit ? hit.id || hit.tagName : "nothing");
  }, sel);
  check("gate is up on load", !!(await page.$("#bootOv")));
  check("it is not a modal dialog (it blocks one card, not the app)",
    await page.getAttribute("#bootOv", "aria-modal") === null
    && await page.getAttribute("#bootOv", "role") !== "dialog");
  check("it lives inside the save loader card",
    await page.locator("#bootOv").evaluate((e) => !!e.closest("#loaderCard")));
  const covered = await hitAt(page, "#pickBtn");
  check("a click on 'Choose file…' lands on the gate, not the button", covered === "gate", String(covered));
  // …and the scoping half: everything Python does not gate must still take a click.
  for (const [what, sel] of [["the ISO Editor tab", '.mtab[data-mode="iso"]'],
                             ["the Save Editor tab", '.mtab[data-mode="save"]'],
                             ["the theme buttons", 'footer .tb[data-theme="parchment"]']]) {
    const hit = await hitAt(page, sel);
    check(`${what} is not covered`, hit !== "gate" && hit !== "missing", String(hit));
  }
  check("the picker is disabled underneath anyway", await page.isDisabled("#pickBtn"));
  // Progress: the first step is running, the later ones are not yet ticked.
  const steps = await page.evaluate(() => Array.from(document.querySelectorAll(".boot-steps li"))
    .map((li) => `${li.dataset.step}:${li.className || "-"}`));
  check("the running step is marked", steps[0] === "rt:on", steps.join(" "));
  check("later steps are not marked done", !steps.slice(1).some((s) => s.includes("done")), steps.join(" "));
  check("progress bar has a width", /%/.test(await page.getAttribute("#bootFill", "style") || ""));

  // ---- and it comes down by itself once the engine is up ----
  await page.evaluate(() => window.__release());
  check("gate goes away when the engine is ready", await gone(page));
  await page.waitForFunction(() => { const b = document.querySelector("#pickBtn"); return b && !b.disabled; },
    { timeout: 5000 }).catch(() => {});
  check("the picker is enabled once it is gone", !(await page.isDisabled("#pickBtn")));
  await page.context().close();
}

// ---- 2. the ISO editor is usable mid-boot ----------------------------------
// The ISO editor needs no Python. A gate that made that tab unreachable for the length of a
// Pyodide download would be a straight regression, so this is not optional polish. Two ways
// in: the mode tab itself (it is no longer under the gate) and the shortcut on the gate.
console.log("the ISO editor stays reachable while the engine loads:");
{
  const page = await open(HELD_ENGINE);
  await page.click('.mtab[data-mode="iso"]');   // the ordinary route, gate still up
  check("the tab switches with the gate still booting", !(await page.$("#bootOv.gone"))
    && await page.locator("#mode-iso").evaluate((e) => !e.classList.contains("hidden")));
  check("the ISO loader rendered", !!(await page.$("#isoRoot .card, #isoPick, #isoFileInput")));
  check("the gate went with the save tab it belongs to",
    await page.locator("#mode-save").evaluate((e) => e.classList.contains("hidden")));
  await page.context().close();
}
{
  const page = await open(HELD_ENGINE);
  await page.click("#bootIso");
  check("gate closes", await gone(page));
  check("ISO tab is showing", await page.locator("#mode-iso").evaluate((e) => !e.classList.contains("hidden")));
  check("save tab is hidden", await page.locator("#mode-save").evaluate((e) => e.classList.contains("hidden")));
  check("the ISO loader rendered", !!(await page.$("#isoRoot .card, #isoPick, #isoFileInput")));
  check("the engine is still booting behind it (picker still disabled)", await page.isDisabled("#pickBtn"));
  await page.context().close();
}

// ---- 3. Dismiss / Escape --------------------------------------------------
console.log("the gate can always be dismissed:");
{
  const page = await open(HELD_ENGINE);
  await page.click("#bootHide");
  check("Dismiss closes it", await gone(page));
  check("the save loader is visible underneath", !!(await page.$("#drop")));
  check("progress keeps reporting inline after dismissal",
    /Downloading|Loading|Parsing/.test(await page.textContent("#engineStatus")));
  await page.evaluate(() => window.__release());
  await page.waitForFunction(() => { const b = document.querySelector("#pickBtn"); return b && !b.disabled; },
    { timeout: 5000 }).catch(() => {});
  check("the engine still finishes and enables the picker", !(await page.isDisabled("#pickBtn")));
  await page.context().close();
}
{
  const page = await open(HELD_ENGINE);
  await page.keyboard.press("Escape");
  check("Escape closes it too", await gone(page));
  await page.context().close();
}

// ---- 4. a failed boot says so ---------------------------------------------
console.log("a failed boot reports itself instead of spinning:");
{
  const page = await open(DEAD_ENGINE);
  await page.waitForSelector("#bootRetry", { timeout: 5000 }).catch(() => {});
  check("gate stays up (the loader under it still cannot work)", !!(await page.$("#bootOv")));
  check("the reason is shown", /boom: no runtime/.test(await page.textContent("#bootMsg")));
  check("Retry is offered", !!(await page.$("#bootRetry")));
  check("Clear cache & reload is offered", !!(await page.$("#bootNuke")));
  check("the bar shows the error state",
    await page.locator("#bootFill").evaluate((e) => e.classList.contains("err")));
  check("the failing step is marked failed, not still spinning",
    await page.evaluate(() => { const li = document.querySelector(".boot-steps li.bad");
      return !!li && li.dataset.step === "rt" && !document.querySelector(".boot-steps li.on"); }));
  check("the ISO shortcut is still there", !!(await page.$("#bootIso")));
  check("it is still dismissible", (await page.click("#bootHide"), await gone(page)));
  check("the inline status also carries the failure",
    /Engine failed to start/.test(await page.textContent("#engineStatus")));
  await page.context().close();
}

// ---- 5. it fits the card it sits in ----------------------------------------
// The gate is absolutely positioned inside #loaderCard, so the card cannot grow to it — a
// CSS min-height does that instead. Phones are where it bites: the step notes wrap to two or
// three lines and the chips stack, so the gate is ~150px taller there than on a desktop.
// If the min-height ever falls behind the content, the gate quietly scrolls (or clips the
// Dismiss button) on exactly the devices least able to spare the room.
console.log("the gate fits inside the loader card at every width:");
for (const [label, width] of [["320px (small phone)", 320], ["390px (phone)", 390],
                              ["430px (large phone)", 430], ["820px (tablet)", 820],
                              ["1280px (desktop)", 1280]]) {
  const page = await open(HELD_ENGINE, { width, height: 900 });
  const m = await page.evaluate(() => {
    const ov = document.querySelector("#bootOv"), card = document.querySelector("#loaderCard");
    return { over: ov.scrollHeight - ov.clientHeight,
             slack: Math.round(card.getBoundingClientRect().height) - ov.scrollHeight };
  });
  check(`${label}: nothing is cut off`, m.over <= 1, `${m.over}px past the card`);
  await page.context().close();
}

await browser.close();
srv.close();
console.log(fails ? `\n${fails} boot-gate problem(s).` : "\nBoot gate OK.");
process.exit(fails ? 1 : 0);
