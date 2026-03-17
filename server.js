const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const app = express();
const PORT = 3000;

const BASE_URL = "https://1ba5-171-76-85-123.ngrok-free.app";

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
    form_url: BASE_URL + "/form/" + id + "/" + formData.contact_id
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

  try {

    const formId = req.body.form_id;

    console.log("Form ID:", formId);

    const forms = readData();
    const form = forms.find(f => f.id === formId);

    if (form) {

      form.response = req.body;
      form.submitted_at = new Date().toISOString();

    }

    writeData(forms);

    console.log("Form saved successfully");

    /* ---------- PDF DIRECTORY ---------- */

    const pdfDir = path.join(__dirname, "pdf");

    if (!fs.existsSync(pdfDir)) {

      fs.mkdirSync(pdfDir, { recursive: true });
      console.log("PDF directory created");

    }

    const pdfPath = path.join(pdfDir, `intake_${formId}.pdf`);

    console.log("PDF path:", pdfPath);

    /* ---------- START PUPPETEER ---------- */

    console.log("Launching browser...");

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    const page = await browser.newPage();

    const contactId = form.prefill.contact_id;

    const url = `http://localhost:${PORT}/pdf-view/${formId}/${contactId}`;

    console.log("Opening page:", url);

    await page.goto(url, { waitUntil: "networkidle2" });

    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log("Generating PDF...");

    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      margin: {
        top: "20px",
        bottom: "20px",
        left: "20px",
        right: "20px"
      }
    });

    await browser.close();

    console.log("PDF created successfully:", pdfPath);

    res.send({
      success: true,
      message: "Form submitted successfully",
      pdf: `${BASE_URL}/pdf/intake_${formId}.pdf`
    });

  } catch (error) {

    console.error("PDF generation error:", error);

    res.status(500).send({
      success: false,
      error: error.message
    });

  }

});

/* ---------- START SERVER ---------- */

app.listen(PORT, () => {

  console.log("Server running on port " + PORT);

});