const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/screenshot", async (req, res) => {
  const address = (req.body?.address || "").trim();
  const kind = (req.body?.kind || "haeuser").toLowerCase(); // "haeuser" | "wohnungen"

  if (!address) return res.status(400).json({ error: "address required" });
  if (!["haeuser", "wohnungen"].includes(kind)) {
    return res.status(400).json({ error: "kind must be 'haeuser' or 'wohnungen'" });
  }

  let browser;

  // --- Cookie/Consent best-effort entfernen ---
  async function handleCookieOverlay(page) {
    try {
      const acceptBtn = page.getByRole("button", { name: /alle akzeptieren/i });
      if (await acceptBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await acceptBtn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(250);
        return;
      }

      const fallbackSelectors = [
        'button:has-text("Alle akzeptieren")',
        'button:has-text("Akzeptieren")',
        'button:has-text("Einverstanden")',
        'button:has-text("Zustimmen")',
        'button:has-text("OK")',
        "#onetrust-accept-btn-handler",
        '[data-testid*="accept"]',
      ];

      for (const sel of fallbackSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
          await el.click({ timeout: 2500 }).catch(() => {});
          await page.waitForTimeout(250);
          return;
        }
      }

      // Ultimativer Fallback: Overlay entfernen (nur Automation)
      await page.evaluate(() => {
        const texts = ["Privatsphäre", "Cookies", "Konfigurieren", "Alle akzeptieren"];
        const nodes = Array.from(document.querySelectorAll("div, section, aside"));
        for (const el of nodes) {
          const t = (el.textContent || "").trim();
          if (!t) continue;
          if (!texts.some((x) => t.includes(x))) continue;
          const style = window.getComputedStyle(el);
          if (style.position === "fixed" || style.position === "sticky") el.remove();
        }
      });
    } catch {
      // ignore
    }
  }

  // --- Robust: Autocomplete/Overlay schließen, damit nichts Klicks blockiert ---
  async function closeOverlays(page) {
    try {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(80);
      await page.mouse.click(10, 10).catch(() => {}); // blur
      await page.waitForTimeout(80);
    } catch {
      // ignore
    }
  }

  // --- Robust: Häuser klicken (nur wenn kind === haeuser) ---
  async function clickHaeuser(page) {
    // sehr wichtig: alles schließen, damit nichts pointer events interceptet
    await closeOverlays(page);
    await handleCookieOverlay(page);

    const label = page.getByText("Häuser", { exact: true }).first();

    // klickbarer Container (aus deinem DOM-Snippet: .label-icon.radio-button__visual)
    const container = label
      .locator("xpath=ancestor::div[contains(@class,'radio-button__visual') or contains(@class,'label-icon')]")
      .first();

    // Versuch 1: Container normal
    if (await container.isVisible({ timeout: 2500 }).catch(() => false)) {
      await container.scrollIntoViewIfNeeded().catch(() => {});
      await closeOverlays(page);
      await container.click({ timeout: 6000 }).catch(async () => {
        // Notfall: force (wenn wieder was interceptet)
        await container.click({ timeout: 6000, force: true }).catch(() => {});
      });
      return;
    }

    // Versuch 2: Label normal/force
    if (await label.isVisible({ timeout: 2000 }).catch(() => false)) {
      await label.scrollIntoViewIfNeeded().catch(() => {});
      await closeOverlays(page);
      await label.click({ timeout: 6000 }).catch(async () => {
        await label.click({ timeout: 6000, force: true }).catch(() => {});
      });
      return;
    }

    // Letzter Fallback
    const fuzzy = page.locator("text=Häuser").first();
    await fuzzy.click({ timeout: 6000 }).catch(async () => {
      await fuzzy.click({ timeout: 6000, force: true }).catch(() => {});
    });
  }

  // --- Robust: Adressfeld finden ---
  async function findAddressInput(page) {
    const candidates = [
      () => page.getByPlaceholder(/z\.?\s*b\.?/i).first(), // "z.B. ..."
      () => page.getByPlaceholder(/adresse/i).first(),
      () => page.locator('input[type="search"]').first(),
      () => page.getByRole("textbox").first(),
      () => page.locator("input").first(),
    ];

    for (let attempt = 1; attempt <= 3; attempt++) {
      await handleCookieOverlay(page);
      await closeOverlays(page);

      for (const make of candidates) {
        const loc = make();
        if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) return loc;
      }

      await page.waitForTimeout(400);
    }

    return null;
  }

  // --- Einfaches "warten bis geladen" ohne weitere Aktionen ---
  async function waitForResultToSettle(page) {
    // domcontentloaded triggert bei SPA manchmal nicht neu -> deshalb:
    // - kurz networkidle versuchen
    // - und/oder ein Ergebnis-Signal (€/m² oder canvas) abwarten
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});

    const signals = [
      page.locator('text=/€\\s*\\/\\s*m²/i').first(),
      page.locator("canvas").first(),
      page.locator("text=mapbox").first(),
    ];

    for (const s of signals) {
      const ok = await s.isVisible({ timeout: 5000 }).catch(() => false);
      if (ok) break;
    }

    // kleiner Puffer für Rendering
    await page.waitForTimeout(600);
  }

  try {
    browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      locale: "de-DE",
    });

    const page = await context.newPage();

    // 1) Seite öffnen
    await page.goto("https://www.homeday.de/preisatlas/", { waitUntil: "domcontentloaded" });

    // 2) Cookie weg
    await handleCookieOverlay(page);

    // 3) Wenn Häuser: erst Häuser klicken
    if (kind === "haeuser") {
      await clickHaeuser(page);
    }

    // 4) Adresse rein + Enter
    const input = await findAddressInput(page);
    if (!input) {
      // Debug Screenshot statt “blind” fail
      const dbg = await page.screenshot({ fullPage: true, type: "png" });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("X-Debug", "input_not_found");
      return res.status(200).send(dbg);
    }

    await input.click({ timeout: 3000 }).catch(() => {});
    await input.fill(address);
    await page.keyboard.press("Enter"); // GENAU wie du willst: direkt Enter

    // 5) Cookie kann nach Enter wieder auftauchen
    await handleCookieOverlay(page);

    // 6) warten + screenshot
    await waitForResultToSettle(page);

    const buffer = await page.screenshot({ fullPage: true, type: "png" });
    res.setHeader("Content-Type", "image/png");
    return res.status(200).send(buffer);

  } catch (e) {
    return res.status(500).json({ error: e.message || "unknown error" });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`listening on ${PORT}`));
