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

    // 2) Adressfeld finden (robust)
    const inputCandidates = [
      'input[placeholder*="z.B."]',
      'input[placeholder*="Adresse"]',
      'input[type="search"]',
      'input[type="text"]',
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

    // 3) Wohnungen/Häuser wählen
    if (kind === "wohnungen") {
      await page.locator("text=Wohnungen").first().click({ timeout: 5000 });
    } else {
      await page.locator("text=Häuser").first().click({ timeout: 5000 });
    }

    // 4) Preise anzeigen
    await page.locator("text=Preise anzeigen").first().click({ timeout: 8000 });

    // 5) Kurze Wartezeit, damit Ergebnis initial lädt
    await page.waitForTimeout(1200);

    // 6) Cookie Banner handling (Homeday) - nach dem Ergebnis-Klick
    try {
      const acceptBtn = page.getByRole("button", { name: /alle akzeptieren/i });

      if (await acceptBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
        await acceptBtn.click({ timeout: 5000 });
        await page.waitForTimeout(500);
      } else {
        const fallbackSelectors = [
          'button:has-text("Alle akzeptieren")',
          'button:has-text("Akzeptieren")',
          'button:has-text("Einverstanden")',
          'button:has-text("Zustimmen")',
          'button:has-text("OK")',
          '[data-testid*="accept"]',
          "#onetrust-accept-btn-handler",
        ];

        for (const sel of fallbackSelectors) {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1200 }).catch(() => false)) {
            await el.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(500);
            break;
          }
        }
      }

      // Ultimativer Fallback: wenn Overlay trotzdem bleibt, entfernen (nur fürs Screenshot!)
      await page.evaluate(() => {
        const texts = ["Privatsphäre", "Cookies", "Konfigurieren", "Alle akzeptieren"];
        const candidates = Array.from(document.querySelectorAll("div, section, aside"));
        for (const el of candidates) {
          const t = (el.textContent || "").trim();
          if (t && texts.some((x) => t.includes(x))) {
            const style = window.getComputedStyle(el);
            if (style.position === "fixed" || style.position === "sticky") {
              el.remove();
            }
          }
        }
      });
    } catch {
      // ignoriere — Screenshot soll trotzdem durchlaufen
    }

    // 7) Signal: Preis €/m² sichtbar ODER Map vorhanden
    const signals = [
      'text=/€\\s*\\/\\s*m²/i',
      'text=/€\\/m²/i',
      "canvas",
      "text=mapbox",
    ];

    let signalOk = false;
    for (const s of signals) {
      try {
        await page.locator(s).first().waitFor({ state: "visible", timeout: 8000 });
        signalOk = true;
        break;
      } catch {}
    }

    // 8) Screenshot
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
