const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
require("dotenv").config();
const AWS = require("aws-sdk");
const app = express();
const PORT = 3000;

const BASE_URL = "http://18.206.96.210:3000";

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_KEY,
  region: process.env.AWS_REGION
});

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
app.post("/submit", async (req, res) => {
  console.log("=== FORM SUBMIT RECEIVED ===");

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

    // Save response
    form.response = req.body;
    form.submitted_at = new Date().toISOString();
    writeData(forms);
    console.log("Form saved successfully");

    console.log("Launching browser...");
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    const page = await browser.newPage();

    const source = form.response || form.prefill || {};
    const ghlContactId = source.contact_id || (form.prefill && form.prefill.contact_id) || null;

    const url = ghlContactId
      ? `http://localhost:${PORT}/pdf-view/${formId}/${ghlContactId}`
      : `http://localhost:${PORT}/pdf-view/${formId}`;

    console.log("Opening page:", url);
    await page.goto(url, { waitUntil: "networkidle2" });

    await new Promise(resolve => setTimeout(resolve, 2000));

    await page.addStyleTag({
      content: `
        @page { size: A4; margin: 12mm; }
        .page {
          page-break-after: always;
          page-break-inside: avoid;
          break-inside: avoid;
          -webkit-column-break-after: always;
          -webkit-region-break-inside: avoid;
        }
        body { margin: 0; padding: 12px; -webkit-print-color-adjust: exact; }
        .header { margin-bottom: 8px; }
        .section-title { margin: 8px 0; }
        .row { margin-bottom: 4px; }
        .line { min-height: 14px; margin-bottom: 6px; }
        .page:last-child { page-break-after: auto; }
        .checkbox, .checkbox-right { line-height: 1; vertical-align: middle; }
      `
    });

    await page.emulateMediaType('screen');

    console.log("Generating PDF...");

    // 🔥 CHANGE: generate buffer instead of file
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: "20px",
        bottom: "20px",
        left: "20px",
        right: "20px"
      }
    });

    await browser.close();
    browser = null;

    // 🔥 CHANGE: upload to S3 instead of local file
    console.log("Uploading PDF to S3...");

    const uploadResult = await s3.upload({
      Bucket: process.env.S3_BUCKET,
      Key: `intake_${formId}.pdf`,
      Body: pdfBuffer,
      ContentType: "application/pdf"
    }).promise();

    console.log("S3 Upload success:", uploadResult.Location);

    const pdfLink = uploadResult.Location;

    // webhook payload (UNCHANGED)
    const webhookPayload = {
      form_id: formId,
      ghl_contactId: ghlContactId,
      pdf_link: pdfLink
    };

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
      timeout: 10000
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

      reqHook.write(bodyString);
      reqHook.end();
    });

    console.log("Webhook result:", webhookResult);

    const finalResponse = {
      success: true,
      message: `Form ${formId} submitted and PDF generated successfully.`,
      pdf_link: pdfLink,
      ghl_contactId: ghlContactId
    };

    // ✅ HTML success page PRESERVED (you said this was missing before)
    if ((req.headers.accept || "").includes("text/html")) {
      const html = `
        <!doctype html>
        <html>
          <head>
            <meta charset="utf-8" />
            <title>Submission Successful</title>
            <style>
              body { font-family: Arial; padding:30px; background:#f6f8fa; }
              .card { max-width:700px; margin:40px auto; background:#fff; padding:24px; border-radius:8px; }
              a.button { padding:10px 14px; background:#1a73e8; color:#fff; text-decoration:none; }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>Form submitted successfully ✅</h1>
              <p>${finalResponse.message}</p>
              <a href="${finalResponse.pdf_link}" target="_blank" class="button">Open PDF</a>
            </div>
          </body>
        </html>
      `;
      return res.send(html);
    }

    return res.json(finalResponse);

  } catch (error) {
    console.error("PDF generation error:", error);

    try { if (browser) await browser.close(); } catch {}

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