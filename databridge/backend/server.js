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
const OpenAI = require("openai");
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
function normalizeAzureEndpoint(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    // Foundry's portal can copy an endpoint with a route already appended.
    // Keep only protocol and host so every API request starts from one known base.
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, "").replace(/\/(?:openai\/v1|models)$/, "");
  }
}
const azureEndpoint = normalizeAzureEndpoint(process.env.AZURE_OPENAI_ENDPOINT);
// Foundry's OpenAI-compatible v1 API uses no dated api-version parameter.
const azureClient = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${azureEndpoint}/openai/v1/`,
});
const RAG_STORE_PATH = path.join(__dirname, "data", "approved-mappings.json");

function readRagStore() {
  try { return JSON.parse(fs.readFileSync(RAG_STORE_PATH, "utf8")); } catch { return []; }
}
function cosineSimilarity(a, b) {
  let dot = 0, aNorm = 0, bNorm = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aNorm += a[i] ** 2; bNorm += b[i] ** 2; }
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm) || 1);
}
async function embedMappingText(text) {
  const model = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;
  if (!model) return null;
  if (!azureEndpoint || !process.env.AZURE_OPENAI_API_KEY) {
    throw new Error("Azure endpoint and API key are required for RAG embeddings.");
  }

  // This Foundry project uses the current OpenAI-compatible v1 embedding API.
  // The older Model Inference preview API is not supported by all Foundry projects.
  const response = await fetch(`${azureEndpoint}/openai/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": process.env.AZURE_OPENAI_API_KEY,
    },
    body: JSON.stringify({ model, input: [text] }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Embeddings request failed (${response.status}): ${detail || response.statusText}`);
  }
  const body = await response.json();
  const embedding = body?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error("Embeddings response contained no vector.");
  return embedding;
}
function mappingMemoryText(targetColumns, sourceColumns) {
  return `Target layout: ${targetColumns.map(x => x.name).join(", ")}\nSource schema: ${sourceColumns.join(", ")}`;
}
async function retrieveApprovedMappings(targetColumns, sourceColumns) {
  const embedding = await embedMappingText(mappingMemoryText(targetColumns, sourceColumns));
  if (!embedding) return [];
  return readRagStore()
    .filter(item => Array.isArray(item.embedding))
    .map(item => ({ ...item, score: cosineSimilarity(embedding, item.embedding) }))
    .filter(item => item.score >= 0.72)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ embedding: _embedding, ...item }) => item);
}
async function saveApprovedMapping({ sourceType, tableName, targetColumns, mappings }) {
  const approvedMappings = mappings.filter(mapping => mapping.source);
  if (!approvedMappings.length) return;
  const sourceColumns = approvedMappings.map(mapping => mapping.source);
  const embedding = await embedMappingText(mappingMemoryText(targetColumns, sourceColumns));
  if (!embedding) return;
  const store = readRagStore();
  store.push({ id: Date.now().toString(), createdAt: new Date().toISOString(), sourceType, tableName, targetColumns, mappings: approvedMappings, embedding });
  fs.mkdirSync(path.dirname(RAG_STORE_PATH), { recursive: true });
  fs.writeFileSync(RAG_STORE_PATH, JSON.stringify(store.slice(-500), null, 2));
}

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

const mappingResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "claimsphere_column_mapping",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mappings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              target: { type: "string" },
              source: { anyOf: [{ type: "string" }, { type: "null" }] },
              sourceTable: { anyOf: [{ type: "string" }, { type: "null" }] },
              sourceColumn: { anyOf: [{ type: "string" }, { type: "null" }] },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              reason: { type: "string" },
              transform: { type: "null" },
            },
            required: ["target", "source", "sourceTable", "sourceColumn", "confidence", "reason", "transform"],
          },
        },
        joinPlan: {
          type: "object",
          additionalProperties: false,
          properties: {
            required: { type: "boolean" },
            tables: { type: "array", items: { type: "string" } },
            conditions: { type: "array", items: { type: "string" } },
            notes: { type: "string" },
          },
          required: ["required", "tables", "conditions", "notes"],
        },
      },
      required: ["mappings", "joinPlan"],
    },
  },
};

function normalizeMappingSource(mapping) {
  const source = typeof mapping.source === "string" && mapping.source.trim() ? mapping.source.trim() : null;
  const parts = source ? source.split(".") : [];
  const sourceColumn = mapping.sourceColumn || (parts.length ? parts.at(-1) : null);
  const sourceTable = mapping.sourceTable || (parts.length > 1 ? parts.slice(0, -1).join(".") : null);
  return {
    ...mapping,
    source: source || (sourceTable && sourceColumn ? `${sourceTable}.${sourceColumn}` : sourceColumn),
    sourceTable,
    sourceColumn,
  };
}

function mappingTargetKey(value) {
  return String(value || "").trim().replace(/\s+/g, "_").toUpperCase();
}

function alignMappingsToLayout(mappings, targets) {
  const returnedByTarget = new Map(mappings.map(mapping => [mappingTargetKey(mapping.target), mapping]));
  return targets
    .filter(target => target?.name)
    .map(target => normalizeMappingSource(returnedByTarget.get(mappingTargetKey(target.name)) || {
      target: target.name,
      source: null,
      sourceTable: null,
      sourceColumn: null,
      confidence: "low",
      reason: "No matching source column returned by the AI.",
      transform: null,
    }))
    .map(mapping => ({ ...mapping, target: mappingTargetKey(mapping.target) }));
}

function buildSelectExpression(mapping, targetType, sourceType) {
  const source = safeIdentifier(mapping.source, "source column");
  const target = safeIdentifier(mapping.target, "target column");
  const type = String(targetType || "").toLowerCase();
  if (/date|time/.test(type)) {
    if (sourceType === "postgres") return `TO_CHAR(${source}, 'YYYY-MM-DD') AS ${target}`;
    if (sourceType === "mysql") return `DATE_FORMAT(${source}, '%Y-%m-%d') AS ${target}`;
    return `CONVERT(CHAR(10), ${source}, 23) AS ${target}`;
  }
  if (/char|text|string/.test(type)) return `CAST(${source} AS VARCHAR(4000)) AS ${target}`;
  return `${source} AS ${target}`;
}

function readSpecification(filePath) {
  const workbook = xlsx.readFile(filePath, { cellDates: true });
  const ignored = new Set(["coverpage", "instructions", "summary", "source", "db details", "keyinfo", "operator crossref"]);
  const targets = [];
  const references = [];

  for (const sheetName of workbook.SheetNames) {
    if (ignored.has(sheetName.toLowerCase())) continue;
    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "" });
    const isTargetHeader = value => /^(field(?:\s+(?:header|column))?\s+name|target.*field|source column name|column name)$/i.test(String(value).trim());
    const headerRow = rows.findIndex(row => row.some(isTargetHeader) && row.some(cell => /^(data\s*type|description|expected value)$/i.test(String(cell).trim())));
    if (headerRow < 0) continue;
    const headers = rows[headerRow].map(value => String(value).trim());
    const targetIndex = headers.findIndex(isTargetHeader) >= 0
      ? headers.findIndex(isTargetHeader)
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
        const tables = requestedTables.length ? requestedTables : (await pool.request().query(`
          SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS name
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_SCHEMA, TABLE_NAME`)).recordset.map(row => row.name);
        for (const tableName of tables) {
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
  let ragContext = "";
  try {
    const examples = await retrieveApprovedMappings(effectiveTargets, sourceColumns);
    if (examples.length) ragContext = `\nPreviously user-approved mappings (reference only; verify against the current schema):\n${JSON.stringify(examples, null, 2)}`;
  } catch (err) {
    console.warn("RAG retrieval skipped:", err.message);
  }

  const prompt = `You are a senior data integration architect with expertise in ETL pipelines.
${referenceContext}${ragContext}

Map the latest uploaded target layout to the available source schema. A source may
come from a different table; identify every referenced table and request a join
plan whenever more than one table is required. Never invent a source column.

SOURCE COLUMNS: ${JSON.stringify(sourceColumns)}
SOURCE TABLES: ${JSON.stringify(sourceTables || [])}

TARGET COLUMNS (with types and descriptions):
${JSON.stringify(effectiveTargets, null, 2)}

Return a mapping for every target. For each matched source, populate source, sourceTable, and sourceColumn using the exact values from SOURCE COLUMNS. Use null for all three when there is no match.

Rules:
- Every target column must have an entry
- Use null for source if no reasonable match exists
- high = direct/semantic match, medium = needs transform or partial match, low = guessed
- Always set transform to null. The backend applies any required SQL casts and date formatting.
- Do not provide executable SQL joins. The user must supply or approve join conditions before extraction.`;

  try {
    const response = await azureClient.chat.completions.create({
      model: DEPLOYMENT,
      messages: [
      { role: "system", content: "You are a data mapping expert. Return only valid JSON." },
      { role: "user", content: prompt }
      ],
      response_format: mappingResponseFormat,
      max_completion_tokens: 16000,
    });

    const choice = response.choices[0];
    if (choice.finish_reason === "length") {
      throw new Error("The mapping response reached its output limit. Reduce the number of source columns or target fields and retry.");
    }
    const text = choice.message.content;
    if (!text) throw new Error("Azure OpenAI returned an empty mapping response");
    const result = JSON.parse(text);
    const mappings = Array.isArray(result) ? result : result.mappings;
    if (!Array.isArray(mappings)) throw new Error("Azure OpenAI returned an invalid mapping response");
    res.json({
      success: true,
      mappings: alignMappingsToLayout(mappings, effectiveTargets),
      joinPlan: result.joinPlan || { required: false, tables: [], conditions: [], notes: "" },
    });
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
      max_completion_tokens: 500,
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
  const { sourceType, credentials, tableName, mappings, targetColumns, rowsPerFile, outputPrefix, delimiter, includeHeader, confirmed, fromClause } = req.body;
  if (!confirmed) return res.status(409).json({ error: "Mapping approval is required before extraction" });
  const delim = delimiter || "|";
  const rowLimit = Math.max(1, Number(rowsPerFile) || 10000);
  const mappedTables = [...new Set((mappings || []).filter(mapping => mapping.source).map(mapping => {
    if (mapping.sourceTable) return mapping.sourceTable;
    const parts = String(mapping.source).split(".");
    return parts.length > 1 ? parts.slice(0, -1).join(".") : "";
  }).filter(Boolean))];
  if (!fromClause && mappedTables.length > 1) {
    return res.status(400).json({ error: "Mappings use multiple source tables. Enter and confirm a JOIN clause before extraction." });
  }
  const sourceFrom = fromClause ? String(fromClause).trim() : safeIdentifier(mappedTables[0] || tableName, "table name");
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
  const sendQuery = (query) => res.write(`data: ${JSON.stringify({ query })}\n\n`);
  const done = () => res.write(`data: ${JSON.stringify({ done: true })}\n\n`);

  try {
    send("🔗 Connecting to data source...");

    // Build a SELECT that preserves every target column in the chosen output layout.
    const targetTypes = new Map((Array.isArray(targetColumns) ? targetColumns : activeLayout)
      .map(target => [mappingTargetKey(target.name), target.type]));
    const selectClauses = mappings
      .map(m => m.source
        ? buildSelectExpression(m, targetTypes.get(mappingTargetKey(m.target)), sourceType)
        : `NULL AS ${safeIdentifier(m.target, "target column")}`)
      .join(", ");

    if (!selectClauses) throw new Error("No target columns are available for extraction. Re-upload the output layout and run AI mapping again.");
    const extractionQuery = `SELECT ${selectClauses} FROM ${sourceFrom}`;
    sendQuery(extractionQuery);

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
      request.query(extractionQuery);

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

      const query = client.query(new (require("pg")).Cursor(extractionQuery));
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
    try {
      await saveApprovedMapping({
        sourceType,
        tableName: fromClause || tableName,
        targetColumns: Array.isArray(targetColumns) ? targetColumns : activeLayout,
        mappings,
      });
      if (process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT) send("🧠 Saved the approved mapping to RAG memory.");
    } catch (ragError) {
      console.warn("RAG save skipped:", ragError.message);
      send("⚠ Extraction succeeded, but the approved mapping could not be saved to RAG memory.");
    }
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
