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

  try {
    browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      locale: "de-DE",
    });

    const page = await context.newPage();

    // 1) Seite öffnen
    await page.goto("https://www.homeday.de/preisatlas/", { waitUntil: "domcontentloaded" });

    // 2) Cookie/Overlay best-effort (wenn vorhanden)
    const cookieSelectors = [
      'button:has-text("Alle akzeptieren")',
      'button:has-text("Akzeptieren")',
      'button:has-text("Zustimmen")',
      'button:has-text("Einverstanden")',
      'button:has-text("OK")'
    ];

    for (const sel of cookieSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        try { await btn.click({ timeout: 1500 }); break; } catch {}
      }
    }

    // 3) Adressfeld finden (robust)
    const inputCandidates = [
      'input[placeholder*="z.B."]',
      'input[placeholder*="Adresse"]',
      'input[type="search"]',
      'input[type="text"]'
    ];

    let input = null;
    for (const sel of inputCandidates) {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        try {
          await loc.click({ timeout: 2000 });
          input = loc;
          break;
        } catch {}
      }
    }
    if (!input) throw new Error("Adress-Eingabefeld nicht gefunden.");

    await input.fill(address);

    // Autocomplete: Enter + optional erster Vorschlag
    await page.keyboard.press("Enter");
    try {
      const firstSuggestion = page.locator('[role="listbox"] [role="option"]').first();
      if (await firstSuggestion.count()) {
        await firstSuggestion.click({ timeout: 2000 });
      }
    } catch {}

    // 4) Wohnungen/Häuser wählen
    if (kind === "wohnungen") {
      await page.locator('text=Wohnungen').first().click({ timeout: 5000 });
    } else {
      await page.locator('text=Häuser').first().click({ timeout: 5000 });
    }

    // 5) Preise anzeigen
    await page.locator('text=Preise anzeigen').first().click({ timeout: 8000 });

    // 6) Kurze Wartezeit (du willst bewusst "einfach warten und screenshotten")
    await page.waitForTimeout(2500);

    // 7) “Signal”, dass Ergebnis da ist: Preisformat €/m² sichtbar ODER Map vorhanden
    // (dein Screenshot zeigt "7.050 €/m²" und Mapbox-Karte)
    const signals = [
      'text=/€\\s*\\/\\s*m²/i',
      'text=/€\\/m²/i',
      'canvas', // Map oft canvas
      'text=mapbox'
    ];

    let signalOk = false;
    for (const s of signals) {
      try {
        await page.locator(s).first().waitFor({ state: "visible", timeout: 8000 });
        signalOk = true;
        break;
      } catch {}
    }

    // Wenn das Signal nicht kommt, trotzdem Screenshot liefern (Debug)
    const buffer = await page.screenshot({ fullPage: true, type: "png" });

    res.setHeader("Content-Type", "image/png");
    if (!signalOk) res.setHeader("X-Debug", "result_signal_not_confirmed");
    return res.status(200).send(buffer);

  } catch (e) {
    return res.status(500).json({ error: e.message || "unknown error" });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`listening on ${PORT}`));
