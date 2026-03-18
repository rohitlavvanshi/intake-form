const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const app = express();
const PORT = 3000;

const BASE_URL = "http://18.206.96.210:3000";

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));

/* serve generated PDFs */
app.use("/pdf", express.static(path.join(__dirname, "pdf")));

const FILE = path.join(__dirname, "forms.json");

/* ---------- JSON HELPERS ---------- */

function readData() {

  try {

    if (!fs.existsSync(FILE)) {
      fs.writeFileSync(FILE, "[]");
    }

    return JSON.parse(fs.readFileSync(FILE, "utf8"));

  } catch (err) {

    console.error("READ ERROR:", err);
    return [];

  }

}

function writeData(data) {

  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

}

/* ---------- GENERATE UNIQUE 5 DIGIT ID ---------- */

function generateUniqueFormId() {

  const forms = readData();
  const ids = forms.map(f => f.id);

  let id;

  do {

    id = Math.floor(10000 + Math.random() * 90000).toString();

  } while (ids.includes(id));

  return id;

}

/* ---------- CREATE FORM LINK ---------- */

app.post("/create-form-link", (req, res) => {

  console.log("Creating form link");

  const formData = req.body;
  const id = generateUniqueFormId();

  const forms = readData();

  forms.push({
    id: id,
    prefill: formData,
    response: null,
    created_at: new Date().toISOString(),
    submitted_at: null
  });

  writeData(forms);

  console.log("Form created:", id);

  res.json({
    form_id: id,
    form_link: BASE_URL + "/form/" + id + "/" + formData.contact_id
  });

});

/* ---------- LOAD FORM PAGE ---------- */

app.get("/form/:id/:contact_id", (req, res) => {

  const id = req.params.id;
  const contactId = req.params.contact_id;

  console.log("Loading form:", id);

  const forms = readData();
  const record = forms.find(f => f.id === id);

  if (!record) {
    return res.send("Invalid form link");
  }

  /* CONTACT VALIDATION */

  if (!record.prefill || record.prefill.contact_id !== contactId) {
    return res.status(403).send("Unauthorized access");
  }

  let html = fs.readFileSync(
    path.join(__dirname, "public/index.html"),
    "utf8"
  );

  const script = `
<script>

const PREFILL_DATA = ${JSON.stringify(record.prefill)};

window.addEventListener("DOMContentLoaded", function(){

    Object.keys(PREFILL_DATA).forEach(function(key){

        const elements = document.querySelectorAll('[name="'+key+'"]');

        if(!elements.length) return;

        elements.forEach(function(el){

            const value = PREFILL_DATA[key];

            if(el.type === "checkbox"){

                if(value === "yes" || value === true){
                    el.checked = true;
                }

            }
            else{

                el.value = value;

            }

        });

    });

});

</script>
`;

  html = html.replace("</body>", script + "</body>");

  res.send(html);

});

/* ---------- PDF VIEW (HTML FOR PDF GENERATION) ---------- */

app.get("/pdf-view/:id/:contact_id", (req, res) => {

  const formId = req.params.id;
  const contactId = req.params.contact_id;

  console.log("Rendering PDF view for:", formId);

  const forms = readData();
  const record = forms.find(f => f.id === formId);

  if (!record) {
    return res.send("Form not found");
  }

  /* CONTACT VALIDATION */

  if (!record.prefill || record.prefill.contact_id !== contactId) {
    return res.status(403).send("Unauthorized access");
  }

  const d = record.response || record.prefill || {};

  console.log("DATA SENT TO TEMPLATE:", d);

  try {

    const html = fs.readFileSync(
      path.join(__dirname, "pdf-template.html"),
      "utf8"
    );

    const rendered = new Function("d", `
      return \`${html}\`;
    `);

    res.send(rendered(d));

  } catch (error) {

    console.error("PDF TEMPLATE ERROR:", error);
    res.send("PDF template rendering failed");

  }

});

/* ---------- SUBMIT FORM ---------- */
/* ---------- SUBMIT FORM ---------- */
app.post("/submit", async (req, res) => {
  console.log("=== FORM SUBMIT RECEIVED ===");

  // webhook (prefer environment override)
  const WEBHOOK_URL = "https://n8n.storyroi.com/webhook/mapDatawithGHL";

  let browser = null;

  try {
    const formId = req.body.form_id;
    console.log("Form ID:", formId);

    const forms = readData();
    const form = forms.find(f => f.id === formId);

    if (!form) {
      console.warn("Submit attempted for non-existent form:", formId);
      if ((req.headers.accept || "").includes("text/html")) {
        return res.status(404).send(`<h1>Form not found</h1><p>Form ID ${formId} does not exist.</p>`);
      }
      return res.status(404).json({ success: false, message: `Form ${formId} not found` });
    }

    // Save response & timestamp
    form.response = req.body;
    form.submitted_at = new Date().toISOString();
    writeData(forms);
    console.log("Form saved successfully");

    // ensure pdf dir exists
    const pdfDir = path.join(__dirname, "pdf");
    if (!fs.existsSync(pdfDir)) {
      fs.mkdirSync(pdfDir, { recursive: true });
      console.log("PDF directory created");
    }

    const pdfPath = path.join(pdfDir, `intake_${formId}.pdf`);
    console.log("PDF path:", pdfPath);

    // Launch Puppeteer
    console.log("Launching browser...");
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    const page = await browser.newPage();

    // Resolve contact id from prefills/responses (map to ghl_contactId)
    const source = form.response || form.prefill || {};
    const ghlContactId = source.contact_id || (form.prefill && form.prefill.contact_id) || null;

    // Build pdf-view url with contact validation path
    const url = ghlContactId
      ? `http://localhost:${PORT}/pdf-view/${formId}/${ghlContactId}`
      : `http://localhost:${PORT}/pdf-view/${formId}`;

    console.log("Opening page:", url);
    await page.goto(url, { waitUntil: "networkidle2" });

    // small pause to allow any JS rendering
    await new Promise(resolve => setTimeout(resolve, 2000));

    // --- INJECT PRINT CSS TO CONTROL PAGINATION & REDUCE EMPTY GAPS ---
    // This makes sure your `.page` wrappers behave as page-break boundaries,
    // and reduces large bottom spacing by telling browsers to avoid large forced breaks.
    await page.addStyleTag({
      content: `
        /* Ensure @page rules are respected; preferCSSPageSize will pick these up */
        @page { size: A4; margin: 12mm; }

        /* Make each .page a hard break and avoid breaking inside */
        .page {
          page-break-after: always;
          page-break-inside: avoid;
          break-inside: avoid;
          -webkit-column-break-after: always;
          -webkit-region-break-inside: avoid;
        }

        /* Prevent huge vertical gaps: prefer compact spacing for sections */
        body { margin: 0; padding: 12px; -webkit-print-color-adjust: exact; }
        .header { margin-bottom: 8px; }
        .section-title { margin: 8px 0; }
        .row { margin-bottom: 4px; }
        .line { min-height: 14px; margin-bottom: 6px; }

        /* Small tweak for last .page so it doesn't add an extra blank page */
        .page:last-child { page-break-after: auto; }

        /* Optional: ensure checkboxes and small boxes don't create extra height */
        .checkbox, .checkbox-right { line-height: 1; vertical-align: middle; }
      `
    });

    // Emulate screen so layout matches what you see in the browser
    await page.emulateMediaType('screen');

    console.log("Generating PDF...");
    await page.pdf({
      path: pdfPath,
      // keep A4 but prefer CSS @page size so injected @page works
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: "20px",
        bottom: "20px",
        left: "20px",
        right: "20px"
      },
      preferCSSPageSize: true   // IMPORTANT: honor @page rules and our .page wrappers
    });

    console.log("PDF created successfully:", pdfPath);

    // close browser now that PDF is created
    await browser.close();
    browser = null;

    // Build minimal webhook payload (only allowed fields)
    const pdfLink = `${BASE_URL}/pdf/intake_${formId}.pdf`;
    const webhookPayload = {
      form_id: formId,
      ghl_contactId: ghlContactId,
      pdf_link: pdfLink
    };

    // POST to webhook using Node's http/https to ensure it's a POST (no GET)
    const webhookUrlObj = new URL(WEBHOOK_URL);
    const isHttps = webhookUrlObj.protocol === "https:";
    const httpLib = isHttps ? require("https") : require("http");

    const bodyString = JSON.stringify(webhookPayload);
    const requestOptions = {
      hostname: webhookUrlObj.hostname,
      port: webhookUrlObj.port || (isHttps ? 443 : 80),
      path: webhookUrlObj.pathname + (webhookUrlObj.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyString),
        "User-Agent": "intake-form-app/1.0"
      },
      timeout: 10000 // 10s timeout for webhook
    };

    console.log("Posting webhook (POST) to:", WEBHOOK_URL);
    const webhookResult = await new Promise((resolve) => {
      const reqHook = httpLib.request(requestOptions, (hookRes) => {
        let respChunks = [];
        hookRes.on("data", (chunk) => respChunks.push(chunk));
        hookRes.on("end", () => {
          const respBody = Buffer.concat(respChunks).toString("utf8");
          resolve({ status: hookRes.statusCode, body: respBody, headers: hookRes.headers });
        });
      });

      reqHook.on("error", (err) => {
        console.error("Webhook request error:", err);
        resolve({ error: String(err) });
      });

      reqHook.on("timeout", () => {
        console.error("Webhook request timed out");
        reqHook.destroy();
        resolve({ error: "timeout" });
      });

      // write payload and end
      reqHook.write(bodyString);
      reqHook.end();
    });

    console.log("Webhook result:", webhookResult);

    // Final response format requested
    const finalResponse = {
      success: true,
      message: `Form ${formId} submitted and PDF generated successfully.`,
      pdf_link: pdfLink,
      ghl_contactId: ghlContactId
    };

    // If the request wants HTML, show friendly success page
    if ((req.headers.accept || "").includes("text/html")) {
      const html = `
        <!doctype html>
        <html>
          <head>
            <meta charset="utf-8" />
            <title>Submission Successful</title>
            <style>
              body { font-family: Arial, Helvetica, sans-serif; padding:30px; background:#f6f8fa; color:#222; }
              .card { max-width:700px; margin:40px auto; background:#fff; padding:24px; border-radius:8px; box-shadow:0 6px 24px rgba(0,0,0,0.08); }
              a.button { display:inline-block; margin-top:12px; padding:10px 14px; background:#1a73e8; color:#fff; text-decoration:none; border-radius:6px; }
              .meta { margin-top:14px; color:#555; font-size:14px; }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>Form submitted successfully ✅</h1>
              <p>${finalResponse.message}</p>
              <p class="meta"><strong>GHL Contact ID:</strong> ${finalResponse.ghl_contactId || "N/A"}</p>
              <p class="meta"><strong>PDF:</strong> <a href="${finalResponse.pdf_link}" target="_blank" class="button">Open generated PDF</a></p>
              <p class="meta">You may close this window.</p>
            </div>
          </body>
        </html>
      `;
      return res.send(html);
    }

    // Otherwise return JSON (only the requested fields)
    return res.json(finalResponse);

  } catch (error) {
    console.error("PDF generation error:", error);

    // Ensure browser closed
    try { if (browser) await browser.close(); } catch (closeErr) { console.error("Error closing browser:", closeErr); }

    return res.status(500).json({
      success: false,
      message: "Failed to generate PDF for the submitted form.",
      error: error.message
    });
  }
});
/* ---------- START SERVER ---------- */

app.listen(PORT, () => {

  console.log("Server running on port " + PORT);

});