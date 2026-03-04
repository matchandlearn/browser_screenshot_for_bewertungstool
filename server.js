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

  // 1) Cookie/Consent so gut wie möglich entfernen
  async function handleCookieOverlay(page) {
    // 1) Buttons klicken (best-effort)
    try {
      const candidates = [
        page.getByRole("button", { name: /alle akzeptieren/i }),
        page.getByRole("button", { name: /akzeptieren/i }),
        page.getByRole("button", { name: /zustimmen/i }),
        page.getByRole("button", { name: /einverstanden/i }),
        page.locator("#onetrust-accept-btn-handler"),
        page.locator('button:has-text("Alle akzeptieren")'),
        page.locator('button:has-text("Akzeptieren")'),
        page.locator('button:has-text("Zustimmen")'),
        page.locator('button:has-text("Einverstanden")'),
        page.locator('button:has-text("OK")'),
        page.locator('[data-testid*="accept"]'),
      ];

      for (const loc of candidates) {
        const el = loc.first();
        const visible = await el.isVisible({ timeout: 1200 }).catch(() => false);
        if (visible) {
          await el.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(250);
          break;
        }
      }
    } catch {
      // ignore
    }

    // 2) Hard-Remove falls es trotzdem blockiert (nur für Automation/Screenshot)
    try {
      await page.evaluate(() => {
        const textHints = [
          "Wir schätzen Ihre Privatsphäre",
          "Privatsphäre",
          "Cookies",
          "Konfigurieren",
          "Alle akzeptieren",
        ];

        const nodes = Array.from(document.querySelectorAll("div, section, aside, dialog"));
        for (const el of nodes) {
          const t = (el.textContent || "").trim();
          if (!t) continue;

          const looksLikeConsent = textHints.some((h) => t.includes(h));
          if (!looksLikeConsent) continue;

          const style = window.getComputedStyle(el);
          const isOverlay = style.position === "fixed" || style.position === "sticky";
          if (isOverlay) el.remove();
        }

        // häufig: Body wird "gelockt"
        document.documentElement.style.overflow = "auto";
        document.body.style.overflow = "auto";

        // manchmal liegt noch ein Backdrop drüber
        const backdrops = Array.from(
          document.querySelectorAll('[class*="backdrop"], [class*="overlay"], [id*="overlay"]')
        );
        for (const b of backdrops) {
          const st = window.getComputedStyle(b);
          if (st.position === "fixed" && st.zIndex && Number(st.zIndex) > 1000) {
            b.remove();
          }
        }
      });
    } catch {
      // ignore
    }
  }

  // Autocomplete/Overlay schließen, damit nichts Klicks blockiert
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

  // Häuser klicken (nur wenn kind === haeuser)
  async function clickHaeuser(page) {
    await closeOverlays(page);
    await handleCookieOverlay(page);

    const label = page.getByText("Häuser", { exact: true }).first();
    const container = label
      .locator("xpath=ancestor::div[contains(@class,'radio-button__visual') or contains(@class,'label-icon')]")
      .first();

    if (await container.isVisible({ timeout: 2500 }).catch(() => false)) {
      await container.scrollIntoViewIfNeeded().catch(() => {});
      await closeOverlays(page);
      await container.click({ timeout: 6000 }).catch(async () => {
        await container.click({ timeout: 6000, force: true }).catch(() => {});
      });
      return;
    }

    if (await label.isVisible({ timeout: 2000 }).catch(() => false)) {
      await label.scrollIntoViewIfNeeded().catch(() => {});
      await closeOverlays(page);
      await label.click({ timeout: 6000 }).catch(async () => {
        await label.click({ timeout: 6000, force: true }).catch(() => {});
      });
      return;
    }

    const fuzzy = page.locator("text=Häuser").first();
    await fuzzy.click({ timeout: 6000 }).catch(async () => {
      await fuzzy.click({ timeout: 6000, force: true }).catch(() => {});
    });
  }

  // Adressfeld finden
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

  // Warten bis Ergebnis "steht"
  async function waitForResultToSettle(page) {
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
      const dbg = await page.screenshot({ fullPage: true, type: "png" });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("X-Debug", "input_not_found");
      return res.status(200).send(dbg);
    }

    await input.click({ timeout: 3000 }).catch(() => {});
    await input.fill(address);
    await page.keyboard.press("Enter"); // genau wie du willst

    // Falls Cookie erst NACH Enter hochpoppt: einmal sofort versuchen
    await handleCookieOverlay(page);

    // 5) warten bis Ergebnis steht
    await waitForResultToSettle(page);

    // 6) LAST CLEANUP direkt vor Screenshot
    await handleCookieOverlay(page);
    
    // warte bis Karte wirklich im DOM ist (Mapbox)
    await page.waitForSelector("canvas", { timeout: 15000 }).catch(() => {});
    
    // dann 5 Sekunden Render-Puffer
    await page.waitForTimeout(5000);
    
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
