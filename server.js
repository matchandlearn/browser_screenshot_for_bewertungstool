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

  // --- helper: Cookie/Consent so gut wie möglich entfernen ---
  async function handleCookieOverlay(page) {
    try {
      const acceptBtn = page.getByRole("button", { name: /alle akzeptieren/i });

      if (await acceptBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await acceptBtn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300);
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
          await page.waitForTimeout(300);
          return;
        }
      }

      // Ultimativer Fallback: Overlay entfernen (nur für Screenshot/Automation)
      await page.evaluate(() => {
        const texts = ["Privatsphäre", "Cookies", "Konfigurieren", "Alle akzeptieren"];
        const nodes = Array.from(document.querySelectorAll("div, section, aside"));
        for (const el of nodes) {
          const t = (el.textContent || "").trim();
          if (!t) continue;
          if (!texts.some((x) => t.includes(x))) continue;

          const style = window.getComputedStyle(el);
          if (style.position === "fixed" || style.position === "sticky") {
            el.remove();
          }
        }
      });
    } catch {
      // egal – wir wollen trotzdem weiterlaufen
    }
  }

  // --- helper: Objektart sicher klicken ---
  async function selectKind(page, kind) {
    const targetText = kind === "wohnungen" ? "Wohnungen" : "Häuser";

    // 1) bevorzugt: vom Text zum klickbaren Container hoch
    const label = page.getByText(targetText, { exact: true }).first();
    const container = label.locator(
      "xpath=ancestor::div[contains(@class,'radio-button__visual') or contains(@class,'label-icon')]"
    ).first();

    if (await container.isVisible({ timeout: 3000 }).catch(() => false)) {
      await container.click({ timeout: 4000 });
      return;
    }

    // 2) fallback: direkt Text
    if (await label.isVisible({ timeout: 2000 }).catch(() => false)) {
      await label.click({ timeout: 4000 });
      return;
    }

    // 3) letzter fallback
    await page.locator(`text=${targetText}`).first().click({ timeout: 4000 });
  }

  try {
    browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      locale: "de-DE",
    });

    const page = await context.newPage();

    // 1) Seite öffnen (etwas stabiler)
    await page.goto("https://www.homeday.de/preisatlas/", { waitUntil: "domcontentloaded" });

    // Cookie direkt am Anfang weg
    await handleCookieOverlay(page);

    // 2) Objektart wählen (BEVOR Adresse)
    await selectKind(page, kind);

    // 3) Adressfeld finden (robust + warten + retry)
    const inputCandidates = [
      () => page.getByPlaceholder(/z\.?\s*b\.?/i).first(), // "z.B. ..."
      () => page.getByPlaceholder(/adresse/i).first(),
      () => page.getByRole("textbox").first(),
      () => page.locator('input[type="search"]').first(),
    ];

    let input = null;

    for (let attempt = 1; attempt <= 3 && !input; attempt++) {
      await page.waitForTimeout(500);
      await handleCookieOverlay(page);

      for (const makeLoc of inputCandidates) {
        const loc = makeLoc();
        const visible = await loc.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          input = loc;
          break;
        }
      }

      if (!input) {
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      }
    }

    if (!input) {
      // Debug-Screenshot (PNG) statt Hard-Fail
      const dbg = await page.screenshot({ fullPage: true, type: "png" });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("X-Debug", "input_not_found");
      return res.status(200).send(dbg);
    }

    // 4) Adresse eintragen
    await input.click({ timeout: 2000 });
    await input.fill(address);
    await page.waitForTimeout(250);

    // 5) Suggestion bevorzugen: ArrowDown + Enter
    const firstOption = page.locator('[role="listbox"] [role="option"]').first();
    const hasSuggestions = await firstOption.isVisible({ timeout: 2500 }).catch(() => false);

    if (hasSuggestions) {
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
    } else {
      await page.keyboard.press("Enter");
    }

    // 6) Wichtig: nach Enter nochmal Objektart setzen (Homeday resetet gern)
    await page.waitForTimeout(300);
    await selectKind(page, kind);

    await handleCookieOverlay(page);

    // 7) Preise anzeigen
    await page.locator("text=Preise anzeigen").first().click({ timeout: 8000 });

    await page.waitForTimeout(600);
    await handleCookieOverlay(page);

    // 8) Signal: Preis €/m² sichtbar ODER Map vorhanden
    const signals = ['text=/€\\s*\\/\\s*m²/i', "canvas", "text=mapbox"];
    let signalOk = false;

    for (const s of signals) {
      try {
        await page.locator(s).first().waitFor({ state: "visible", timeout: 10000 });
        signalOk = true;
        break;
      } catch {}
    }

    // 9) Screenshot
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
