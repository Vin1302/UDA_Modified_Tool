/**
 * DataBridge AI - Backend Server
 * Node.js + Express + Azure OpenAI
 * Runs on Azure VM, never exposes API keys to frontend
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const xlsx = require("xlsx");
const sql = require("mssql");
const { Pool } = require("pg");
const mysql = require("mysql2/promise");
const { AzureOpenAI } = require("openai");
const path = require("path");
const fs = require("fs");
const { pipeline } = require("stream");
const { promisify } = require("util");
const pipelineAsync = promisify(pipeline);

const app = express();
const PORT = process.env.PORT || 5000;
const upload = multer({ dest: "uploads/" });

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));
app.use(express.json({ limit: "10mb" }));

// Serve React build in production
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "../frontend/build")));
}

// ─── Azure OpenAI Client ───────────────────────────────────────────────────────
const DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o"; // your deployment name
const azureClient = new AzureOpenAI({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  deployment: DEPLOYMENT,
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-10-21",
});

// ─── In-memory store for uploaded mapping Excel ────────────────────────────────
// Reference mappings are session-scoped guidance only.  They are deliberately
// not sent anywhere for fine tuning or stored as "learned" model data.
let referenceMappings = [];
let activeLayout = [];
let activeLayouts = {};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*){0,2}$/;
const safeIdentifier = (value, label = "identifier") => {
  if (!IDENTIFIER.test(String(value || ""))) throw new Error(`Invalid ${label}`);
  return value;
};

function readSpecification(filePath) {
  const workbook = xlsx.readFile(filePath, { cellDates: true });
  const ignored = new Set(["coverpage", "instructions", "summary", "source", "db details", "keyinfo", "operator crossref"]);
  const targets = [];
  const references = [];

  for (const sheetName of workbook.SheetNames) {
    if (ignored.has(sheetName.toLowerCase())) continue;
    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "" });
    const headerRow = rows.findIndex(row => row.some(cell => /source column name|expected value|field name|target.*field/i.test(String(cell))));
    if (headerRow < 0) continue;
    const headers = rows[headerRow].map(value => String(value).trim());
    const targetIndex = headers.findIndex(h => /^(field name|target.*field|source column name|column name)$/i.test(h)) >= 0
      ? headers.findIndex(h => /^(field name|target.*field|source column name|column name)$/i.test(h))
      : 0;
    const typeIndex = headers.findIndex(h => /data\s*type/i.test(h));
    const descriptionIndex = headers.findIndex(h => /description|expected value/i.test(h));
    const requiredIndex = headers.findIndex(h => /mandatory|required/i.test(h));

    rows.slice(headerRow + 1).forEach(row => {
      const name = String(row[targetIndex] || "").trim();
      if (!name || /^(notes?|example|n\/a)$/i.test(name)) return;
      const target = {
        name: name.replace(/\s+/g, "_").toUpperCase(),
        type: String(typeIndex >= 0 ? row[typeIndex] : "TEXT") || "TEXT",
        required: /^(yes|y|true|mandatory|required)$/i.test(String(requiredIndex >= 0 ? row[requiredIndex] : "")),
        description: String(descriptionIndex >= 0 ? row[descriptionIndex] : ""),
        layout: sheetName,
      };
      targets.push(target);
      const example = {};
      headers.forEach((header, index) => { if (header && row[index] !== "") example[header] = row[index]; });
      if (Object.keys(example).length > 1) references.push({ layout: sheetName, ...example });
    });
  }
  return { targets, references, sheets: workbook.SheetNames };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Health check
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Upload training Excel
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/upload-mapping", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const parsed = readSpecification(req.file.path);
    if (!parsed.targets.length) return res.status(400).json({ error: "No target layout fields were found in this specification" });
    activeLayouts = parsed.targets.reduce((groups, target) => {
      (groups[target.layout] ||= []).push(target);
      return groups;
    }, {});
    activeLayout = parsed.targets;
    referenceMappings = parsed.references;
    fs.unlinkSync(req.file.path);
    res.json({ success: true,
      layouts: Object.entries(activeLayouts).map(([name, targetColumns]) => ({ name, targetColumns, referenceCount: referenceMappings.filter(x => x.layout === name).length })),
      referenceCount: referenceMappings.length, sheets: parsed.sheets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Test connection to any source
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/connect", async (req, res) => {
  const { sourceType, credentials } = req.body;
  try {
    switch (sourceType) {
      case "sqlserver":
      case "azure_sql": {
        const pool = await sql.connect({
          server: credentials.host || credentials.server,
          port: parseInt(credentials.port) || 1433,
          database: credentials.database,
          user: credentials.username,
          password: credentials.password,
          options: { encrypt: true, trustServerCertificate: true },
          connectionTimeout: 8000,
        });
        await pool.request().query("SELECT 1 AS test");
        await pool.close();
        break;
      }
      case "postgres": {
        const pgPool = new Pool({
          host: credentials.host, port: parseInt(credentials.port) || 5432,
          database: credentials.database, user: credentials.username,
          password: credentials.password, connectionTimeoutMillis: 8000,
          ssl: { rejectUnauthorized: false },
        });
        const client = await pgPool.connect();
        await client.query("SELECT 1");
        client.release();
        await pgPool.end();
        break;
      }
      case "mysql": {
        const conn = await mysql.createConnection({
          host: credentials.host, port: parseInt(credentials.port) || 3306,
          database: credentials.database, user: credentials.username,
          password: credentials.password, connectTimeout: 8000,
        });
        await conn.query("SELECT 1");
        await conn.end();
        break;
      }
      default:
        // For cloud sources (Azure Blob, S3, etc.) — validate fields only in this demo
        if (!credentials || Object.keys(credentials).length === 0) {
          return res.status(400).json({ error: "Missing credentials" });
        }
    }
    res.json({ success: true, message: `Connected to ${sourceType} successfully` });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Fetch source schema (columns)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/schema", async (req, res) => {
  const { sourceType, credentials, tableName, tableNames } = req.body;
  const requestedTables = Array.isArray(tableNames) && tableNames.length ? tableNames : String(tableName || "").split(",").map(x => x.trim()).filter(Boolean);
  try {
    let columns = [];
    switch (sourceType) {
      case "sqlserver":
      case "azure_sql": {
        const pool = await sql.connect({
          server: credentials.host || credentials.server,
          port: parseInt(credentials.port) || 1433,
          database: credentials.database,
          user: credentials.username, password: credentials.password,
          options: { encrypt: true, trustServerCertificate: true },
        });
        for (const tableName of requestedTables) {
          safeIdentifier(tableName, "table name");
          const bareTable = tableName.split(".").pop();
          const result = await pool.request().input("table", sql.NVarChar, bareTable)
            .query(`SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
                    FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @table ORDER BY ORDINAL_POSITION`);
          columns.push(...result.recordset.map(r => ({
          name: `${tableName}.${r.COLUMN_NAME}`,
          column: r.COLUMN_NAME, table: tableName,
          type: r.DATA_TYPE + (r.CHARACTER_MAXIMUM_LENGTH ? `(${r.CHARACTER_MAXIMUM_LENGTH})` : ""),
          nullable: r.IS_NULLABLE === "YES"
          })));
        }
        await pool.close();
        break;
      }
      case "postgres": {
        const pgPool = new Pool({
          host: credentials.host, port: parseInt(credentials.port) || 5432,
          database: credentials.database, user: credentials.username, password: credentials.password,
          ssl: { rejectUnauthorized: false },
        });
        const client = await pgPool.connect();
        for (const tableName of requestedTables) {
        safeIdentifier(tableName, "table name");
        const bareTable = tableName.split(".").pop();
        const result = await client.query(
          `SELECT column_name, data_type, character_maximum_length, is_nullable
           FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`,
          [bareTable]
        );
        columns.push(...result.rows.map(r => ({
          name: `${tableName}.${r.column_name}`,
          column: r.column_name, table: tableName,
          type: r.data_type + (r.character_maximum_length ? `(${r.character_maximum_length})` : ""),
          nullable: r.is_nullable === "YES"
        })));
        }
        client.release(); await pgPool.end();
        break;
      }
      default:
        columns = []; // For non-DB sources, return empty; UI handles manually
    }
    res.json({ success: true, columns });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: AI Column Mapping via Azure OpenAI
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/ai-mapping", async (req, res) => {
  const { sourceColumns, targetColumns, sourceTables, layoutName } = req.body;
  const effectiveTargets = activeLayouts[layoutName] || (activeLayout.length ? activeLayout : targetColumns);
  const layoutReferences = layoutName ? referenceMappings.filter(x => x.layout === layoutName) : referenceMappings;
  if (!process.env.AZURE_OPENAI_ENDPOINT || !process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_OPENAI_ENDPOINT.includes("YOUR-")) {
    return res.status(503).json({ success: false, error: "Azure OpenAI is not configured. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT in backend/.env, then restart the backend." });
  }

  const referenceContext = layoutReferences.length > 0
    ? `\nHistorical mapping assumptions for this layout (reference only; do not treat as ground truth):\n${JSON.stringify(layoutReferences.slice(0, 40), null, 2)}`
    : "";

  const prompt = `You are a senior data integration architect with expertise in ETL pipelines.
${referenceContext}

Map the latest uploaded target layout to the available source schema. A source may
come from a different table; identify every referenced table and request a join
plan whenever more than one table is required. Never invent a source column.

SOURCE COLUMNS: ${JSON.stringify(sourceColumns)}
SOURCE TABLES: ${JSON.stringify(sourceTables || [])}

TARGET COLUMNS (with types and descriptions):
${JSON.stringify(effectiveTargets, null, 2)}

Return ONLY a JSON object: {"mappings":[...],"joinPlan":{"required":boolean,"tables":[],"conditions":[],"notes":""}}.
Each mapping is {"target":"TARGET_COLUMN_NAME","source":"table.column_or_null","confidence":"high|medium|low","reason":"brief reason","transform":null}.

Rules:
- Every target column must have an entry
- Use null for source if no reasonable match exists
- high = direct/semantic match, medium = needs transform or partial match, low = guessed
- Do not provide executable SQL joins. The user must supply or approve join conditions before extraction.`;

  try {
    const response = await azureClient.chat.completions.create({
      model: DEPLOYMENT,
      messages: [
      { role: "system", content: "You are a data mapping expert. Return only valid JSON." },
      { role: "user", content: prompt }
      ],
      max_tokens: 2000, temperature: 0.1,
    });

    const text = response.choices[0].message.content.replace(/```json|```/g, "").trim();
    const result = JSON.parse(text);
    const mappings = Array.isArray(result) ? result : result.mappings;
    if (!Array.isArray(mappings)) throw new Error("Azure OpenAI returned an invalid mapping response");
    res.json({ success: true, mappings, joinPlan: result.joinPlan || { required: false, tables: [], conditions: [], notes: "" } });
  } catch (err) {
    console.error("Azure OpenAI mapping failed:", err);
    const detail = err?.error?.message || err?.response?.data?.error?.message || err.message;
    res.status(502).json({ success: false, error: `Azure OpenAI mapping failed: ${detail}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: AI Chat for mapping review
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/ai-chat", async (req, res) => {
  const { messages, mappings, sourceColumns, targetColumns } = req.body;

  const systemPrompt = `You are DataBridge AI, a data mapping assistant.
Current mappings: ${JSON.stringify(mappings)}
Source columns available: ${JSON.stringify(sourceColumns)}
Target columns: ${JSON.stringify(targetColumns.map(c => c.name))}
Help the user review, understand, and modify mappings. Be concise (max 3 sentences).`;

  try {
    const response = await azureClient.chat.completions.create({
      model: DEPLOYMENT,
      messages: [
      { role: "system", content: systemPrompt },
      ...messages
      ],
      max_tokens: 500, temperature: 0.3,
    });
    res.json({ success: true, reply: response.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Extract data and split into text files (SSE streaming)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/extract", async (req, res) => {
  const { sourceType, credentials, tableName, mappings, rowsPerFile, outputPrefix, delimiter, includeHeader, confirmed, fromClause } = req.body;
  if (!confirmed) return res.status(409).json({ error: "Mapping approval is required before extraction" });
  const delim = delimiter || "|";
  const rowLimit = Math.max(1, Number(rowsPerFile) || 10000);
  const sourceFrom = fromClause ? String(fromClause).trim() : safeIdentifier(tableName, "table name");
  if (fromClause && (!/^[A-Za-z0-9_.$\s=<>]+(?:\s+(?:INNER|LEFT|RIGHT|FULL|OUTER|JOIN|ON)\s+[A-Za-z0-9_.$\s=<>]+)*$/i.test(sourceFrom) || /(;|--|\/\*)/.test(sourceFrom))) {
    return res.status(400).json({ error: "Join clause contains unsupported characters. Review the confirmed join conditions." });
  }
  const outputDir = path.join(__dirname, "output");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  // SSE setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (msg) => res.write(`data: ${JSON.stringify({ log: msg })}\n\n`);
  const sendFile = (name) => res.write(`data: ${JSON.stringify({ file: name })}\n\n`);
  const done = () => res.write(`data: ${JSON.stringify({ done: true })}\n\n`);

  try {
    send("🔗 Connecting to data source...");

    // Build SELECT with transforms
    const selectClauses = mappings
      .filter(m => m.source)
      .map(m => {
        safeIdentifier(m.target, "target column");
        if (m.transform) return `${m.transform} AS ${m.target}`;
        safeIdentifier(m.source, "source column");
        return `${m.source} AS ${m.target}`;
      })
      .join(", ");

    if (!selectClauses) throw new Error("At least one confirmed source mapping is required");

    const outputValue = value => value === null || value === undefined ? "" : String(value)
      .replace(/[\r\n]/g, " ").replaceAll(delim, " ");
    const headerRow = mappings.map(m => outputValue(m.target)).join(delim);
    send("📋 Applying column mappings and SQL transforms...");

    let fileIndex = 1;
    let rowsWritten = 0;
    let currentFile = null;
    let currentStream = null;

    const openFile = () => {
      const fname = `${outputPrefix}${String(fileIndex).padStart(3, "0")}.txt`;
      const fpath = path.join(outputDir, fname);
      currentStream = fs.createWriteStream(fpath);
      if (includeHeader !== false) currentStream.write(headerRow + "\n");
      return fname;
    };

    const closeFile = (fname) => {
      return new Promise(resolve => { currentStream.end(resolve); });
    };

    // SQL Server extraction
    if (sourceType === "sqlserver" || sourceType === "azure_sql") {
      const pool = await sql.connect({
        server: credentials.host || credentials.server,
        port: parseInt(credentials.port) || 1433,
        database: credentials.database,
        user: credentials.username, password: credentials.password,
        options: { encrypt: true, trustServerCertificate: true },
      });

      let fname = openFile();
      send(`📦 Writing ${fname}...`);

      const request = pool.request();
      request.stream = true;
      request.query(`SELECT ${selectClauses} FROM ${sourceFrom}`);

      await new Promise((resolve, reject) => {
        request.on("row", async (row) => {
          const line = mappings.map(m => {
            const v = row[m.target];
            return outputValue(v);
          }).join(delim);
          currentStream.write(line + "\n");
          rowsWritten++;

          if (rowsWritten % rowLimit === 0) {
            await closeFile(fname);
            sendFile(fname);
            send(`✅ ${fname} — ${rowLimit.toLocaleString()} rows`);
            fileIndex++;
            fname = openFile();
            send(`📦 Writing ${fname}...`);
          }
        });
        request.on("done", async () => {
          await closeFile(fname);
          sendFile(fname);
          send(`✅ ${fname} — ${rowsWritten % rowLimit || rowLimit} rows`);
          resolve();
        });
        request.on("error", reject);
      });
      await pool.close();

    } else if (sourceType === "postgres") {
      const pgPool = new Pool({
        host: credentials.host, port: parseInt(credentials.port) || 5432,
        database: credentials.database, user: credentials.username, password: credentials.password,
        ssl: { rejectUnauthorized: false },
      });
      const client = await pgPool.connect();
      let fname = openFile();
      send(`📦 Writing ${fname}...`);

      const query = client.query(new (require("pg")).Cursor(`SELECT ${selectClauses} FROM ${sourceFrom}`));
      const readBatch = () => new Promise((res, rej) => query.read(500, (err, rows) => err ? rej(err) : res(rows)));

      let batch;
      while ((batch = await readBatch()) && batch.length > 0) {
        for (const row of batch) {
          const line = mappings.map(m => {
            const v = row[m.target.toLowerCase()];
            return outputValue(v);
          }).join(delim);
          currentStream.write(line + "\n");
          rowsWritten++;
          if (rowsWritten % rowLimit === 0) {
            await closeFile(fname); sendFile(fname);
            send(`✅ ${fname} — ${rowLimit.toLocaleString()} rows`);
            fileIndex++; fname = openFile();
            send(`📦 Writing ${fname}...`);
          }
        }
      }
      await closeFile(fname); sendFile(fname);
      client.release(); await pgPool.end();
    }

    send(`\n🎉 Extraction complete! ${fileIndex} file(s), ${rowsWritten.toLocaleString()} total rows.`);
    done();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    done();
  }
  res.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Download extracted file
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/download/:filename", (req, res) => {
  const fpath = path.join(__dirname, "output", req.params.filename);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: "File not found" });
  res.download(fpath);
});

// Catch-all for React in production
if (process.env.NODE_ENV === "production") {
  app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../frontend/build/index.html")));
}

app.listen(PORT, () => console.log(`✅ DataBridge AI server running on port ${PORT}`));
