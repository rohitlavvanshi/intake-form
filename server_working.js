// server.js
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

const RESPONSE_FILE = path.join(__dirname, "responses.json");
const LINK_FILE = path.join(__dirname, "form_links.json");

/* ---------- JSON HELPERS ---------- */
function readJSON(file) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, "[]", "utf8");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error("readJSON error:", err);
    return [];
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

/* ---------- UNIQUE 5 DIGIT ID ---------- */
function generateUniqueFormId() {
  const links = readJSON(LINK_FILE);
  const ids = links.map(function (l) { return l.id; });
  let id;
  do {
    id = Math.floor(10000 + Math.random() * 90000).toString();
  } while (ids.includes(id));
  return id;
}

/* ---------- CREATE FORM LINK ---------- */
app.post("/create-form-link", function (req, res) {
  try {
    const formData = req.body;
    const id = generateUniqueFormId();
    const links = readJSON(LINK_FILE);
    links.push({ id: id, data: formData });
    writeJSON(LINK_FILE, links);
    res.json({ form_id: id, form_url: BASE_URL + "/form/" + id });
  } catch (err) {
    console.error("POST /create-form-link error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

/* ---------- SERVE FORM PAGE (unchanged) ---------- */
app.get("/form/:id", function (req, res) {
  // Serve the static HTML page. Client script will fetch /api/form/:id
  res.sendFile(path.join(__dirname, "public/index.html"));
});

/* ---------- PREFILL API: return JSON for a form id ---------- */
app.get("/api/form/:id", function (req, res) {
  try {
    const id = req.params.id;
    const links = readJSON(LINK_FILE);
    const record = links.find(function (x) { return x.id === id; });
    if (!record) return res.status(404).json({ error: "form not found" });
    // send only record.data
    res.json(record.data);
  } catch (err) {
    console.error("GET /api/form/:id error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

/* ---------- SUBMIT FORM ---------- */
app.post("/submit", function (req, res) {
  try {
    const responses = readJSON(RESPONSE_FILE);
    responses.push({ timestamp: new Date().toISOString(), data: req.body });
    writeJSON(RESPONSE_FILE, responses);
    res.send("Form submitted successfully");
  } catch (err) {
    console.error("POST /submit error:", err);
    res.status(500).send("internal server error");
  }
});

/* ---------- START SERVER ---------- */
app.listen(PORT, function () {
  console.log("Server running on port " + PORT);
});
