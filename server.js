const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;

const BASE_URL = "https://8920-171-76-84-113.ngrok-free.app";

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));

const FILE = path.join(__dirname, "forms.json");

/* ---------- JSON HELPERS ---------- */

function readData() {
  try {
    if (!fs.existsSync(FILE)) {
      fs.writeFileSync(FILE, "[]");
    }
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (err) {
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

  res.json({
    form_id: id,
    form_url: BASE_URL + "/form/" + id
  });

});

/* ---------- LOAD FORM PAGE ---------- */

app.get("/form/:id", (req, res) => {

  const id = req.params.id;

  const forms = readData();

  const record = forms.find(f => f.id === id);

  if (!record) {
    return res.send("Invalid form link");
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

/* ---------- SUBMIT FORM ---------- */

app.post("/submit", (req, res) => {

  const formId = req.body.form_id;

  const forms = readData();

  const form = forms.find(f => f.id === formId);

  if (form) {
    form.response = req.body;
    form.submitted_at = new Date().toISOString();
  }

  writeData(forms);

  res.send("Form submitted successfully");

});

/* ---------- START SERVER ---------- */

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
