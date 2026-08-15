import { useState, useRef, useEffect } from "react";

const API = process.env.REACT_APP_API_URL || "http://localhost:5000";

const STEPS = ["Connect", "Schema", "AI Mapping", "Confirm", "Extract"];

const SOURCE_TYPES = [
  { id: "sqlserver",  label: "SQL Server",  icon: "🗄️",  fields: ["host","port","database","username","password","schema"] },
  { id: "postgres",   label: "PostgreSQL",  icon: "🐘",  fields: ["host","port","database","username","password","schema"] },
  { id: "mysql",      label: "MySQL",       icon: "🐬",  fields: ["host","port","database","username","password"] },
  { id: "azure_sql",  label: "Azure SQL",   icon: "☁️",  fields: ["server","database","username","password","tenantId"] },
  { id: "azure_blob", label: "Azure Blob",  icon: "📦",  fields: ["accountName","accountKey","containerName","blobPrefix"] },
  { id: "s3",         label: "AWS S3",      icon: "🪣",  fields: ["accessKeyId","secretAccessKey","region","bucket","prefix"] },
  { id: "oracle",     label: "Oracle DB",   icon: "🔴",  fields: ["host","port","serviceName","username","password"] },
  { id: "snowflake",  label: "Snowflake",   icon: "❄️",  fields: ["account","warehouse","database","schema","username","password"] },
  { id: "bigquery",   label: "BigQuery",    icon: "📊",  fields: ["projectId","datasetId","serviceAccountKey"] },
  { id: "api",        label: "REST API",    icon: "🔌",  fields: ["baseUrl","authType","apiKey","headers"] },
];

const FIELD_LABELS = {
  host:"Host / Server", port:"Port", database:"Database", username:"Username",
  password:"Password", schema:"Schema", server:"Azure Server FQDN",
  tenantId:"Tenant ID", accountName:"Storage Account Name", accountKey:"Account Key",
  containerName:"Container Name", blobPrefix:"Blob Prefix (optional)",
  accessKeyId:"AWS Access Key ID", secretAccessKey:"AWS Secret Key",
  region:"Region", bucket:"Bucket Name", prefix:"Prefix (optional)",
  serviceName:"Service Name", account:"Snowflake Account", warehouse:"Warehouse",
  projectId:"GCP Project ID", datasetId:"BigQuery Dataset ID",
  serviceAccountKey:"Service Account JSON", baseUrl:"Base URL",
  authType:"Auth Type", apiKey:"API Key", headers:"Custom Headers (JSON)"
};

const DEFAULT_TARGET_COLS = [
  { name:"CUSTOMER_ID",   type:"VARCHAR(50)",  required:true,  description:"Unique customer identifier" },
  { name:"FULL_NAME",     type:"VARCHAR(200)", required:true,  description:"Customer full name" },
  { name:"EMAIL_ADDRESS", type:"VARCHAR(150)", required:true,  description:"Primary email" },
  { name:"PHONE_NUMBER",  type:"VARCHAR(20)",  required:false, description:"Contact phone" },
  { name:"DATE_OF_BIRTH", type:"DATE",         required:false, description:"Customer DOB YYYY-MM-DD" },
  { name:"ADDRESS_LINE1", type:"VARCHAR(255)", required:false, description:"Street address" },
  { name:"CITY",          type:"VARCHAR(100)", required:false, description:"City" },
  { name:"COUNTRY_CODE",  type:"CHAR(2)",      required:true,  description:"ISO 2-letter country code" },
  { name:"ACCOUNT_STATUS",type:"VARCHAR(20)",  required:true,  description:"active/inactive/suspended" },
  { name:"CREATED_DATE",  type:"TIMESTAMP",    required:true,  description:"Account creation timestamp" },
];

export default function DataBridgeAI() {
  const [step, setStep] = useState(0);
  const [sourceType, setSourceType] = useState(null);
  const [connFields, setConnFields] = useState({});
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connError, setConnError] = useState("");
  const [tableName, setTableName] = useState("customers");
  const [targetCols, setTargetCols] = useState(DEFAULT_TARGET_COLS);
  const [layouts, setLayouts] = useState([]);
  const [selectedLayout, setSelectedLayout] = useState("");
  const [sourceSchema, setSourceSchema] = useState([]);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [newCol, setNewCol] = useState({ name:"", type:"VARCHAR(100)", required:false, description:"" });
  const [mappings, setMappings] = useState([]);
  const [joinPlan, setJoinPlan] = useState({ required:false, tables:[], conditions:[], notes:"" });
  const [joinClause, setJoinClause] = useState("");
  const [mappingConfirmed, setMappingConfirmed] = useState(false);
  const [aiThinking, setAiThinking] = useState(false);
  const [aiLog, setAiLog] = useState([]);
  const [rowsPerFile, setRowsPerFile] = useState(10000);
  const [outputPrefix, setOutputPrefix] = useState("extract_");
  const [delimiter, setDelimiter] = useState("|");
  const [includeHeader, setIncludeHeader] = useState(true);
  const [extractLog, setExtractLog] = useState([]);
  const [extractFiles, setExtractFiles] = useState([]);
  const [extractQuery, setExtractQuery] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [done, setDone] = useState(false);
  const [chat, setChat] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const chatRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [chat]);

  const src = SOURCE_TYPES.find(s => s.id === sourceType);

  const getSourceParts = (mapping) => {
    if (!mapping.source) return { table: "—", column: "—" };
    const known = sourceSchema.find(column => column.name === mapping.source);
    const parts = String(mapping.source).split(".");
    return {
      table: mapping.sourceTable || known?.table || (parts.length > 1 ? parts.slice(0, -1).join(".") : "—"),
      column: mapping.sourceColumn || known?.column || parts.at(-1),
    };
  };

  const setMappingSource = (index, source) => {
    const known = sourceSchema.find(column => column.name === source);
    const parts = String(source || "").split(".");
    setMappingConfirmed(false);
    setMappings(current => current.map((mapping, currentIndex) => currentIndex === index ? {
      ...mapping,
      source: source || null,
      sourceTable: source ? (known?.table || (parts.length > 1 ? parts.slice(0, -1).join(".") : null)) : null,
      sourceColumn: source ? (known?.column || parts.at(-1)) : null,
    } : mapping));
  };

  // ── Connect ─────────────────────────────────────────────────────────────────
  async function handleConnect() {
    setConnecting(true); setConnError("");
    try {
      const res = await fetch(`${API}/api/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceType, credentials: connFields })
      });
      const data = await res.json();
      if (data.success) setConnected(true);
      else setConnError(data.error || "Connection failed");
    } catch (e) { setConnError("Cannot reach backend server. Is it running?"); }
    setConnecting(false);
  }

  // ── Upload Excel ─────────────────────────────────────────────────────────────
  async function handleUpload(file) {
    const form = new FormData();
    form.append("file", file);
    setUploadMsg("Uploading...");
    try {
      const res = await fetch(`${API}/api/upload-mapping`, { method: "POST", body: form });
      const data = await res.json();
      if (data.success) {
        const loadedLayouts = data.layouts || [];
        setLayouts(loadedLayouts);
        setSelectedLayout(loadedLayouts[0]?.name || "");
        setTargetCols(loadedLayouts[0]?.targetColumns || []);
        setMappings([]); setMappingConfirmed(false);
        setUploadMsg(`✓ Loaded ${loadedLayouts.length} layouts. Select a tab to map each output separately.`);
      } else setUploadMsg(`Error: ${data.error}`);
    } catch { setUploadMsg("Upload failed — is server running?"); }
  }

  // ── Fetch source schema ──────────────────────────────────────────────────────
  async function fetchSchema() {
    setSchemaLoading(true);
    try {
      const res = await fetch(`${API}/api/schema`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceType, credentials: connFields, tableName })
      });
      const data = await res.json();
      if (data.success && data.columns.length > 0) setSourceSchema(data.columns);
    } catch {}
    setSchemaLoading(false);
  }

  // ── AI Mapping ───────────────────────────────────────────────────────────────
  async function runAIMapping() {
    setAiThinking(true); setAiLog([]);
    const steps = [
      "🔍 Analyzing target schema...",
      "📋 Reading source column metadata...",
      "🧠 Calling Azure OpenAI for semantic matching...",
      "📊 Applying historical training mappings...",
      "✅ Generating confidence scores..."
    ];
    for (const s of steps) {
      await new Promise(r => setTimeout(r, 500));
      setAiLog(p => [...p, s]);
    }
    const sourceColumns = sourceSchema.length > 0
      ? sourceSchema.map(c => c.name)
      : ["cust_id","first_name","last_name","email","mobile","dob","addr1","addr2","city_name","state","country","status_cd","created_at","updated_at","is_active","phone_no","zip_code"];

    try {
      const res = await fetch(`${API}/api/ai-mapping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceColumns, sourceTables: tableName.split(",").map(x=>x.trim()).filter(Boolean), targetColumns: targetCols, layoutName: selectedLayout })
      });
      const data = await res.json();
      if (data.success) {
        setMappings(data.mappings);
        setJoinPlan(data.joinPlan || { required:false, tables:[], conditions:[], notes:"" });
        setMappingConfirmed(false);
        setAiLog(p => [...p, "🎯 Mapping complete!"]);
      } else {
        setAiLog(p => [...p, `❌ Error: ${data.error}`]);
      }
    } catch (e) {
      setAiLog(p => [...p, `❌ Cannot reach backend: ${e.message}`]);
    }
    setAiThinking(false);
  }

  // ── Chat ─────────────────────────────────────────────────────────────────────
  async function sendChat() {
    if (!chatInput.trim() || chatLoading) return;
    const userMsg = chatInput.trim(); setChatInput("");
    const newMessages = [...chat, { role: "user", content: userMsg }];
    setChat(newMessages); setChatLoading(true);
    try {
      const res = await fetch(`${API}/api/ai-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages,
          mappings, sourceColumns: sourceSchema.map(c => c.name),
          targetColumns: targetCols
        })
      });
      const data = await res.json();
      setChat(p => [...p, { role: "assistant", content: data.reply || data.error }]);
    } catch { setChat(p => [...p, { role: "assistant", content: "Cannot reach backend server." }]); }
    setChatLoading(false);
  }

  // ── Extract ──────────────────────────────────────────────────────────────────
  async function startExtraction() {
    setExtracting(true); setExtractLog([]); setExtractFiles([]); setExtractQuery("");
    const res = await fetch(`${API}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceType, credentials: connFields, tableName, mappings, rowsPerFile, outputPrefix, delimiter, includeHeader, confirmed: mappingConfirmed, fromClause: joinClause })
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done: rdone, value } = await reader.read();
      if (rdone) break;
      const lines = decoder.decode(value).split("\n").filter(l => l.startsWith("data:"));
      for (const line of lines) {
        try {
          const obj = JSON.parse(line.slice(5));
          if (obj.log) setExtractLog(p => [...p, obj.log]);
          if (obj.file) setExtractFiles(p => [...p, obj.file]);
          if (obj.query) setExtractQuery(obj.query);
          if (obj.done) setDone(true);
          if (obj.error) setExtractLog(p => [...p, `❌ ${obj.error}`]);
        } catch {}
      }
    }
    setExtracting(false);
  }

  const stepDone = [connected, targetCols.length > 0, mappings.length > 0, mappings.length > 0, done];
  const selectLayout = (layout) => {
    setSelectedLayout(layout.name);
    setTargetCols(layout.targetColumns);
    setMappings([]); setJoinPlan({ required:false, tables:[], conditions:[], notes:"" });
    setMappingConfirmed(false); setDone(false);
  };

  // ── Styles ───────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily:"'IBM Plex Mono','Courier New',monospace", background:"#0a0e1a", minHeight:"100vh", color:"#e2e8f0" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=Space+Grotesk:wght@400;500;600&display=swap');
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-thumb{background:#2563eb44;border-radius:4px}
        .inp{background:#111827;border:1px solid #1e3a5f;color:#e2e8f0;padding:8px 12px;border-radius:6px;width:100%;font-family:inherit;font-size:13px;outline:none;transition:border-color .2s}
        .inp:focus{border-color:#2563eb}
        .btn{background:#1d4ed8;color:#fff;border:none;padding:10px 20px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;transition:background .2s,transform .1s}
        .btn:hover{background:#2563eb}
        .btn:disabled{opacity:.45;cursor:not-allowed}
        .btn-ghost{background:transparent;border:1px solid #1e3a5f;color:#94a3b8}
        .btn-ghost:hover{background:#111827;border-color:#2563eb;color:#e2e8f0}
        .btn-green{background:#16a34a}.btn-green:hover{background:#15803d}
        .card{background:#111827;border:1px solid #1e3a5f;border-radius:10px;padding:20px}
        .badge-high{background:#14532d22;color:#4ade80;border:1px solid #166534;padding:2px 8px;border-radius:4px;font-size:11px}
        .badge-med{background:#78350f22;color:#fbbf24;border:1px solid #92400e;padding:2px 8px;border-radius:4px;font-size:11px}
        .badge-low{background:#7f1d1d22;color:#f87171;border:1px solid #991b1b;padding:2px 8px;border-radius:4px;font-size:11px}
        .select{background:#0a0e1a;border:1px solid #1e3a5f;color:#e2e8f0;padding:6px 10px;border-radius:6px;font-family:inherit;font-size:12px;outline:none;width:100%}
        .tag{display:inline-block;background:#1e3a5f;color:#60a5fa;padding:3px 8px;border-radius:4px;font-size:11px;margin:2px;cursor:pointer}
        .tag:hover{background:#1d4ed8}
        .pulse{animation:pulse 1.5s infinite}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        .chat-user{background:#1d4ed8;color:#fff;padding:8px 12px;border-radius:10px 10px 2px 10px;font-size:13px;max-width:82%;align-self:flex-end}
        .chat-ai{background:#1e293b;border:1px solid #1e3a5f;color:#e2e8f0;padding:8px 12px;border-radius:10px 10px 10px 2px;font-size:13px;max-width:88%}
        .mrow{display:grid;grid-template-columns:1.2fr .55fr 1fr 1fr 1.1fr 1.5fr;gap:8px;align-items:start;padding:9px 0;border-bottom:1px solid #1e3a5f22}
        .mrow:last-child{border-bottom:none}
        .step-dot{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:#fff;cursor:pointer;transition:all .2s;flex-shrink:0}
      `}</style>

      {/* ── Header ── */}
      <div style={{ background:"#060a14", borderBottom:"1px solid #1e3a5f", padding:"13px 28px", display:"flex", alignItems:"center", gap:14 }}>
        <div style={{ width:36, height:36, background:"#1d4ed8", borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>⚡</div>
        <div>
          <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontSize:18, fontWeight:600, color:"#f1f5f9" }}>DataBridge AI</div>
          <div style={{ fontSize:11, color:"#4b6074" }}>Azure OpenAI · Secure Backend · Intelligent ETL Pipeline</div>
        </div>
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:6 }}>
          {STEPS.map((s, i) => (
            <div key={i} style={{ display:"flex", alignItems:"center", gap:5, opacity: i > step ? 0.3 : 1 }}>
              <div className="step-dot" style={{ background: stepDone[i] ? "#16a34a" : i===step ? "#1d4ed8" : "#1e293b", border:`1px solid ${stepDone[i]?"#16a34a":i===step?"#3b82f6":"#1e3a5f"}` }} onClick={() => i<=step && setStep(i)}>
                {stepDone[i] ? "✓" : i+1}
              </div>
              <span style={{ fontSize:11, color: i===step ? "#60a5fa" : "#4b6074" }}>{s}</span>
              {i < 4 && <span style={{ color:"#1e3a5f", fontSize:10, margin:"0 3px" }}>›</span>}
            </div>
          ))}
        </div>
      </div>

      <div style={{ maxWidth:1120, margin:"0 auto", padding:"28px 24px" }}>

        {/* ════════════════════════════════ STEP 0 ════════════════════════════════ */}
        {step === 0 && (
          <div>
            <h2 style={{ fontFamily:"'Space Grotesk',sans-serif", fontSize:22, fontWeight:600, color:"#f1f5f9", marginBottom:4 }}>Connect Data Source</h2>
            <p style={{ color:"#64748b", fontSize:13, marginBottom:22 }}>Credentials are sent only to your backend server — never exposed to the browser</p>

            <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:10, marginBottom:26 }}>
              {SOURCE_TYPES.map(s => (
                <div key={s.id} className="card" onClick={() => { setSourceType(s.id); setConnFields({}); setConnected(false); setConnError(""); }}
                  style={{ textAlign:"center", padding:"13px 8px", cursor:"pointer", border:`1px solid ${sourceType===s.id?"#2563eb":"#1e3a5f"}`, background:sourceType===s.id?"#0f172a":"#111827" }}>
                  <div style={{ fontSize:22, marginBottom:5 }}>{s.icon}</div>
                  <div style={{ fontSize:11, color:sourceType===s.id?"#60a5fa":"#94a3b8", fontWeight:500 }}>{s.label}</div>
                </div>
              ))}
            </div>

            {src && (
              <div className="card">
                <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontSize:15, fontWeight:600, color:"#e2e8f0", marginBottom:16 }}>
                  {src.icon} {src.label} Connection
                  {connected && <span className="badge-high" style={{ marginLeft:10 }}>● Connected</span>}
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap:14, marginBottom:16 }}>
                  {src.fields.map(f => (
                    <div key={f}>
                      <label style={{ fontSize:11, color:"#64748b", display:"block", marginBottom:5 }}>{FIELD_LABELS[f]||f}</label>
                      <input className="inp" type={["password","accountKey","secretAccessKey","apiKey"].includes(f)?"password":"text"}
                        placeholder={FIELD_LABELS[f]||f} value={connFields[f]||""}
                        onChange={e => setConnFields(p => ({...p,[f]:e.target.value}))} />
                    </div>
                  ))}
                </div>
                {connError && <div style={{ color:"#f87171", fontSize:12, marginBottom:12, padding:"8px 12px", background:"#7f1d1d22", borderRadius:6, border:"1px solid #7f1d1d" }}>❌ {connError}</div>}

                {/* Excel upload */}
                <div style={{ paddingTop:14, borderTop:"1px solid #1e3a5f", marginBottom:16 }}>
                  <label style={{ fontSize:11, color:"#64748b", display:"block", marginBottom:8 }}>📎 Upload latest ClaimSphere input specification (becomes the active output layout)</label>
                  <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                    <input ref={fileRef} type="file" accept=".xlsx,.xls,.xlsm,.csv" style={{ display:"none" }} onChange={e => e.target.files[0] && handleUpload(e.target.files[0])} />
                    <button className="btn btn-ghost" style={{ fontSize:12, padding:"7px 14px" }} onClick={() => fileRef.current.click()}>📤 Upload Excel</button>
                    {uploadMsg && <span style={{ fontSize:12, color: uploadMsg.startsWith("✓") ? "#4ade80" : "#f87171" }}>{uploadMsg}</span>}
                  </div>
                </div>

                <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                  <button className="btn" onClick={handleConnect} disabled={connecting||connected}>
                    {connecting ? <span className="pulse">Testing...</span> : connected ? "✓ Connected" : "Test & Connect"}
                  </button>
                  {connected && <button className="btn btn-green" onClick={() => setStep(1)}>Continue to Schema →</button>}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ════════════════════════════════ STEP 1 ════════════════════════════════ */}
        {step === 1 && (
          <div>
            <h2 style={{ fontFamily:"'Space Grotesk',sans-serif", fontSize:22, fontWeight:600, color:"#f1f5f9", marginBottom:4 }}>Define Extraction Schema</h2>
            <p style={{ color:"#64748b", fontSize:13, marginBottom:22 }}>Set target columns and optionally fetch source schema from your connected database</p>

            {layouts.length > 0 && <div className="card" style={{ marginBottom:16, padding:14 }}>
              <div style={{ fontSize:11, color:"#4b6074", marginBottom:10, textTransform:"uppercase", letterSpacing:".06em" }}>ClaimSphere output layouts ({layouts.length})</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:7 }}>
                {layouts.map(layout => <button key={layout.name} className="btn btn-ghost" onClick={()=>selectLayout(layout)} style={{ padding:"6px 10px", fontSize:11, borderColor:selectedLayout===layout.name?"#2563eb":undefined, color:selectedLayout===layout.name?"#60a5fa":undefined }}>
                  {layout.name} <span style={{ opacity:.65 }}>({layout.targetColumns.length})</span>
                </button>)}
              </div>
              <div style={{ fontSize:11, color:"#64748b", marginTop:9 }}>Map, review, confirm, and export one selected layout at a time. The target fields shown below belong only to <b style={{ color:"#94a3b8" }}>{selectedLayout}</b>.</div>
            </div>}

            <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr", gap:16, marginBottom:20 }}>
              <div className="card">
                <div style={{ fontSize:11, color:"#4b6074", marginBottom:14, textTransform:"uppercase", letterSpacing:"0.06em" }}>Target Column Layout {selectedLayout && `— ${selectedLayout}`}</div>
                <div style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr .5fr 2fr .4fr", gap:8, padding:"5px 0", borderBottom:"1px solid #1e3a5f", marginBottom:8 }}>
                  {["Name","Type","Req","Description",""].map(h => <div key={h} style={{ fontSize:10, color:"#4b6074", fontWeight:600, textTransform:"uppercase" }}>{h}</div>)}
                </div>
                {targetCols.map((col, i) => (
                  <div key={i} style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr .5fr 2fr .4fr", gap:8, padding:"7px 0", borderBottom:"1px solid #0f172a", alignItems:"center" }}>
                    <span style={{ fontSize:13, color:"#60a5fa", fontWeight:500 }}>{col.name}</span>
                    <span style={{ fontSize:11, color:"#94a3b8" }}>{col.type}</span>
                    <span>{col.required ? <span className="badge-high" style={{ fontSize:10, padding:"1px 5px" }}>REQ</span> : <span style={{ color:"#334155",fontSize:10 }}>opt</span>}</span>
                    <span style={{ fontSize:11, color:"#64748b" }}>{col.description}</span>
                    <button style={{ background:"none", border:"none", color:"#7f1d1d", cursor:"pointer", fontSize:14 }} onClick={() => setTargetCols(p => p.filter((_,j)=>j!==i))}>✕</button>
                  </div>
                ))}
                <div style={{ marginTop:14, paddingTop:14, borderTop:"1px solid #1e3a5f" }}>
                  <div style={{ fontSize:12, color:"#64748b", marginBottom:8 }}>+ Add column</div>
                  <div style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr auto 2fr auto", gap:8, alignItems:"center" }}>
                    <input className="inp" placeholder="COLUMN_NAME" value={newCol.name} onChange={e => setNewCol(p=>({...p,name:e.target.value}))} />
                    <select className="select" value={newCol.type} onChange={e => setNewCol(p=>({...p,type:e.target.value}))}>
                      {["VARCHAR(50)","VARCHAR(100)","VARCHAR(200)","VARCHAR(255)","INT","BIGINT","DECIMAL(18,2)","DATE","TIMESTAMP","BOOLEAN","TEXT","CHAR(2)"].map(t=><option key={t}>{t}</option>)}
                    </select>
                    <label style={{ fontSize:12, color:"#94a3b8", display:"flex", alignItems:"center", gap:4, cursor:"pointer" }}>
                      <input type="checkbox" checked={newCol.required} onChange={e=>setNewCol(p=>({...p,required:e.target.checked}))} />Req
                    </label>
                    <input className="inp" placeholder="Description" value={newCol.description} onChange={e => setNewCol(p=>({...p,description:e.target.value}))} />
                    <button className="btn" style={{ padding:"8px 12px", fontSize:12 }} onClick={() => {
                      if (!newCol.name.trim()) return;
                      setTargetCols(p=>[...p,{...newCol,name:newCol.name.toUpperCase().replace(/ /g,"_")}]);
                      setNewCol({name:"",type:"VARCHAR(100)",required:false,description:""});
                    }}>Add</button>
                  </div>
                </div>
              </div>

              <div className="card" style={{ height:"fit-content" }}>
                <div style={{ fontSize:11, color:"#4b6074", marginBottom:12, textTransform:"uppercase", letterSpacing:"0.06em" }}>Source Table Schema</div>
                <div style={{ marginBottom:10 }}>
                  <label style={{ fontSize:11, color:"#64748b", display:"block", marginBottom:5 }}>Source table(s)</label>
                  <input className="inp" value={tableName} onChange={e=>setTableName(e.target.value)} placeholder="e.g. member, enrollment" />
                  <div style={{ fontSize:10, color:"#4b6074", marginTop:5 }}>Enter one or more comma-separated tables. Joins require review and confirmation.</div>
                </div>
                <button className="btn btn-ghost" style={{ width:"100%", fontSize:12, marginBottom:12 }} onClick={fetchSchema} disabled={schemaLoading}>
                  {schemaLoading ? <span className="pulse">Fetching...</span> : "📋 Fetch Source Schema"}
                </button>
                {sourceSchema.length > 0 ? (
                  <div>
                    <div style={{ fontSize:11, color:"#4ade80", marginBottom:8 }}>✓ {sourceSchema.length} columns loaded</div>
                    <div style={{ maxHeight:200, overflowY:"auto" }}>
                      {sourceSchema.map(c => (
                        <div key={c.name} style={{ fontSize:11, display:"flex", justifyContent:"space-between", padding:"3px 0", borderBottom:"1px solid #0f172a", color:"#94a3b8" }}>
                          <span style={{ color:"#60a5fa" }}>{c.name}</span>
                          <span>{c.type}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize:11, color:"#334155", textAlign:"center", padding:"16px 0" }}>No schema loaded yet<br/>AI will use column name inference</div>
                )}
              </div>
            </div>

            <div style={{ display:"flex", gap:10 }}>
              <button className="btn btn-ghost" onClick={()=>setStep(0)}>← Back</button>
              <button className="btn" onClick={()=>setStep(2)}>Run AI Mapping →</button>
            </div>
          </div>
        )}

        {/* ════════════════════════════════ STEP 2 ════════════════════════════════ */}
        {step === 2 && (
          <div>
            <h2 style={{ fontFamily:"'Space Grotesk',sans-serif", fontSize:22, fontWeight:600, color:"#f1f5f9", marginBottom:4 }}>AI Column Mapping</h2>
            <p style={{ color:"#64748b", fontSize:13, marginBottom:22 }}>Mapping layout: <b style={{ color:"#60a5fa" }}>{selectedLayout || "custom layout"}</b>. Microsoft Foundry GPT-5.6 Sol uses historical assumptions only as reference.</p>

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:20 }}>
              <div className="card">
                <div style={{ fontSize:11, color:"#4b6074", marginBottom:10, textTransform:"uppercase", letterSpacing:"0.06em" }}>Source Columns</div>
                <div style={{ display:"flex", flexWrap:"wrap" }}>
                  {(sourceSchema.length>0 ? sourceSchema.map(c=>c.name) : ["cust_id","first_name","last_name","email","mobile","dob","addr1","city_name","country","status_cd","created_at","is_active","phone_no"]).map(c => <span key={c} className="tag">{c}</span>)}
                </div>
              </div>
              <div className="card">
                <div style={{ fontSize:11, color:"#4b6074", marginBottom:10, textTransform:"uppercase", letterSpacing:"0.06em" }}>Target Columns</div>
                <div style={{ display:"flex", flexWrap:"wrap" }}>
                  {targetCols.map(c => <span key={c.name} className="tag" style={{ background:"#0f2a14", color:"#4ade80" }}>{c.name}</span>)}
                </div>
              </div>
            </div>

            {!mappings.length ? (
              <div className="card" style={{ textAlign:"center", padding:40 }}>
                <div style={{ fontSize:40, marginBottom:14 }}>🧠</div>
                <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontSize:16, color:"#e2e8f0", marginBottom:8 }}>Ready for AI Analysis</div>
                <div style={{ fontSize:13, color:"#64748b", marginBottom:24 }}>Microsoft Foundry GPT-5.6 Sol will propose mappings from the latest layout and source schema.</div>
                <button className="btn" style={{ fontSize:14, padding:"12px 28px" }} onClick={runAIMapping} disabled={aiThinking}>
                  {aiThinking ? <span className="pulse">Analyzing...</span> : "⚡ Run AI Mapping"}
                </button>
                {aiLog.length > 0 && <div style={{ marginTop:20, textAlign:"left" }}>{aiLog.map((l,i)=><div key={i} style={{ fontSize:12, color:"#94a3b8", padding:"3px 0" }}>{l}</div>)}</div>}
              </div>
            ) : (
              <div className="card" style={{ marginBottom:20 }}>
                <div style={{ fontFamily:"'Space Grotesk',sans-serif", fontSize:13, fontWeight:600, color:"#94a3b8", marginBottom:14, textTransform:"uppercase", letterSpacing:"0.05em" }}>
                  Suggested Mappings
                  <button className="btn btn-ghost" style={{ fontSize:11, padding:"4px 10px", marginLeft:10 }} onClick={()=>{setMappings([]);setAiLog([])}}>↺ Redo</button>
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1.2fr .55fr 1fr 1fr 1.1fr 1.5fr", gap:8, padding:"5px 0", borderBottom:"1px solid #1e3a5f" }}>
                  {["Target","Confidence","Source Table","Source Column","Override","Transform"].map(h=><div key={h} style={{ fontSize:10,color:"#4b6074",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em" }}>{h}</div>)}
                </div>
                {mappings.map((m,i) => (
                  <div key={i} className="mrow">
                    <div>
                      <div style={{ fontSize:13,color:"#60a5fa",fontWeight:500 }}>{m.target}</div>
                      <div style={{ fontSize:10,color:"#334155",marginTop:2 }}>{m.reason}</div>
                    </div>
                    <span className={`badge-${m.confidence==="high"?"high":m.confidence==="medium"?"med":"low"}`}>{m.confidence}</span>
                    <div style={{ fontSize:12,color:"#e2e8f0",background:m.source?"#0f172a":"#1a0808",padding:"4px 8px",borderRadius:4,border:`1px solid ${m.source?"#1e3a5f":"#7f1d1d"}` }}>
                      {getSourceParts(m).table}
                    </div>
                    <div style={{ fontSize:12,color:"#e2e8f0",background:m.source?"#0f172a":"#1a0808",padding:"4px 8px",borderRadius:4,border:`1px solid ${m.source?"#1e3a5f":"#7f1d1d"}` }}>
                      {getSourceParts(m).column}
                    </div>
                    <select className="select" value={m.source||""} onChange={e=>setMappingSource(i, e.target.value)}>
                      <option value="">-- none --</option>
                      {(sourceSchema.length>0?sourceSchema.map(c=>c.name):["cust_id","first_name","last_name","email","mobile","dob","addr1","city_name","country","status_cd","created_at","is_active","phone_no"]).map(c=><option key={c}>{c}</option>)}
                    </select>
                    <input className="inp" style={{ fontSize:11 }} placeholder="SQL transform (optional)" value={m.transform||""} onChange={e=>{setMappingConfirmed(false);setMappings(p=>p.map((x,j)=>j===i?{...x,transform:e.target.value}:x))}} />
                  </div>
                ))}
              </div>
            )}

            <div style={{ display:"flex", gap:10 }}>
              <button className="btn btn-ghost" onClick={()=>setStep(1)}>← Back</button>
              {mappings.length>0 && <button className="btn" onClick={()=>{setChat([{role:"assistant",content:"I've completed the AI mapping. Would you like to review any specific mappings or request changes?"}]);setStep(3)}}>Review & Confirm →</button>}
            </div>
          </div>
        )}

        {/* ════════════════════════════════ STEP 3 ════════════════════════════════ */}
        {step === 3 && (
          <div>
            <h2 style={{ fontFamily:"'Space Grotesk',sans-serif", fontSize:22, fontWeight:600, color:"#f1f5f9", marginBottom:4 }}>Confirm Mappings</h2>
            <p style={{ color:"#64748b", fontSize:13, marginBottom:22 }}>Chat with the AI to review or adjust mappings before extraction begins</p>

            <div style={{ display:"grid", gridTemplateColumns:"1.1fr 1fr", gap:20 }}>
              <div>
                <div className="card" style={{ marginBottom:14 }}>
                  <div style={{ fontSize:11, color:"#4b6074", marginBottom:14, textTransform:"uppercase", letterSpacing:"0.06em" }}>Mapping Summary</div>
                  <div style={{ display:"flex", gap:14, marginBottom:16 }}>
                    {[
                      { label:"High", n:mappings.filter(m=>m.confidence==="high").length, color:"#4ade80" },
                      { label:"Medium", n:mappings.filter(m=>m.confidence==="medium").length, color:"#fbbf24" },
                      { label:"Low/None", n:mappings.filter(m=>m.confidence==="low"||!m.source).length, color:"#f87171" },
                    ].map(s=>(
                      <div key={s.label} style={{ background:"#0a0e1a", padding:"10px 14px", borderRadius:8, flex:1, textAlign:"center" }}>
                        <div style={{ fontSize:22, fontWeight:600, color:s.color }}>{s.n}</div>
                        <div style={{ fontSize:10, color:"#64748b", marginTop:2 }}>{s.label}</div>
                      </div>
                    ))}
                  </div>
                  {mappings.map((m,i)=>(
                    <div key={i} style={{ display:"flex", alignItems:"center", gap:8, padding:"5px 0", borderBottom:"1px solid #0f172a" }}>
                      <div style={{ width:7, height:7, borderRadius:"50%", background:m.confidence==="high"?"#16a34a":m.confidence==="medium"?"#d97706":"#dc2626", flexShrink:0 }} />
                      <span style={{ fontSize:12, color:"#60a5fa", flex:1 }}>{m.target}</span>
                      <span style={{ fontSize:11, color:"#94a3b8" }}>→</span>
                      <span style={{ fontSize:12, color:m.source?"#e2e8f0":"#7f1d1d", flex:1 }}>{m.source||"unmapped"}</span>
                      {m.transform && <span style={{ fontSize:10, color:"#64748b", background:"#0f172a", padding:"2px 5px", borderRadius:3 }}>fx</span>}
                    </div>
                  ))}
                </div>
                <div style={{ display:"flex", gap:10 }}>
                  <button className="btn btn-ghost" onClick={()=>setStep(2)}>← Edit</button>
                  {joinPlan.required && <div style={{ marginBottom:12, padding:10, background:"#2a1f0f", border:"1px solid #92400e", borderRadius:6, fontSize:11, color:"#fbbf24" }}>
                    <div style={{ fontWeight:600, marginBottom:5 }}>Multiple source tables detected — review joins before extraction</div>
                    <div style={{ marginBottom:6 }}>{joinPlan.notes || "Confirm the proposed relationship, then provide the approved FROM/JOIN clause."}</div>
                    <input className="inp" value={joinClause} onChange={e=>{setMappingConfirmed(false);setJoinClause(e.target.value)}} placeholder="e.g. member INNER JOIN enrollment ON member.id = enrollment.member_id" />
                  </div>}
                  <button className="btn btn-green" onClick={()=>{setMappingConfirmed(true);setStep(4)}} disabled={joinPlan.required && !joinClause.trim()}>✓ Confirm mappings & extract →</button>
                </div>
              </div>

              <div className="card" style={{ display:"flex", flexDirection:"column", height:520 }}>
                <div style={{ fontSize:11, color:"#4b6074", marginBottom:12, textTransform:"uppercase", letterSpacing:"0.06em" }}>🤖 AI Mapping Assistant</div>
                <div ref={chatRef} style={{ flex:1, overflowY:"auto", display:"flex", flexDirection:"column", gap:10, marginBottom:12, paddingRight:4 }}>
                  {chat.map((m,i)=>(
                    <div key={i} style={{ display:"flex", justifyContent:m.role==="user"?"flex-end":"flex-start" }}>
                      <div className={m.role==="user"?"chat-user":"chat-ai"}>{m.content}</div>
                    </div>
                  ))}
                  {chatLoading && <div style={{ display:"flex" }}><div className="chat-ai pulse">Thinking...</div></div>}
                </div>
                <div style={{ display:"flex", gap:8 }}>
                  <input className="inp" placeholder="Ask about mappings..." value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat()} />
                  <button className="btn" style={{ padding:"8px 14px", flexShrink:0 }} onClick={sendChat} disabled={chatLoading}>→</button>
                </div>
                <div style={{ marginTop:8, display:"flex", flexWrap:"wrap", gap:4 }}>
                  {["Why is this low confidence?","Show unmapped columns","What transforms are applied?","Suggest better mapping for EMAIL"].map(q=>(
                    <span key={q} className="tag" style={{ fontSize:10 }} onClick={()=>setChatInput(q)}>{q}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ════════════════════════════════ STEP 4 ════════════════════════════════ */}
        {step === 4 && (
          <div>
            <h2 style={{ fontFamily:"'Space Grotesk',sans-serif", fontSize:22, fontWeight:600, color:"#f1f5f9", marginBottom:4 }}>Extract & Split Files</h2>
            <p style={{ color:"#64748b", fontSize:13, marginBottom:22 }}>Configure output format, then stream data from source to split text files</p>

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:20 }}>
              <div className="card">
                <div style={{ fontSize:11, color:"#4b6074", marginBottom:16, textTransform:"uppercase", letterSpacing:"0.06em" }}>Extraction Settings</div>

                <div style={{ marginBottom:14 }}>
                  <label style={{ fontSize:12, color:"#94a3b8", display:"block", marginBottom:6 }}>Rows per file</label>
                  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                    <input type="range" min={1000} max={100000} step={1000} value={rowsPerFile} onChange={e=>setRowsPerFile(+e.target.value)} style={{ flex:1 }} />
                    <span style={{ fontSize:14, color:"#60a5fa", fontWeight:500, minWidth:72 }}>{rowsPerFile.toLocaleString()}</span>
                  </div>
                </div>

                <div style={{ marginBottom:14 }}>
                  <label style={{ fontSize:12, color:"#94a3b8", display:"block", marginBottom:6 }}>Output file prefix</label>
                  <input className="inp" value={outputPrefix} onChange={e=>setOutputPrefix(e.target.value)} placeholder="extract_" />
                </div>

                <div style={{ marginBottom:14 }}>
                  <label style={{ fontSize:12, color:"#94a3b8", display:"block", marginBottom:6 }}>Delimiter</label>
                  <select className="select" value={delimiter} onChange={e=>setDelimiter(e.target.value)}>
                    <option value="|">Pipe ( | )</option>
                    <option value=",">Comma ( , )</option>
                    <option value={"\t"}>Tab</option>
                    <option value="~">Tilde ( ~ )</option>
                  </select>
                </div>

                <div style={{ marginBottom:20 }}>
                  <label style={{ fontSize:12, color:"#94a3b8", display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}>
                    <input type="checkbox" checked={includeHeader} onChange={e=>setIncludeHeader(e.target.checked)} />
                    Include header row in each file
                  </label>
                </div>

                <div style={{ background:"#0a0e1a", padding:"12px 16px", borderRadius:8, marginBottom:20, fontFamily:"monospace", fontSize:11, color:"#4ade80", border:"1px solid #14532d" }}>
                  <div style={{ color:"#64748b", marginBottom:4 }}>// Preview</div>
                  <div>{outputPrefix}001.txt, {outputPrefix}002.txt ...</div>
                  <div style={{ color:"#334155" }}>{mappings.slice(0,3).map(m=>m.target).join(delimiter)}{delimiter}...</div>
                </div>

                {extractQuery && (
                  <div style={{ background:"#0a0e1a", padding:"12px 16px", borderRadius:8, marginBottom:20, border:"1px solid #1e3a5f" }}>
                    <div style={{ color:"#64748b", fontSize:11, marginBottom:7, textTransform:"uppercase", letterSpacing:"0.06em" }}>Query used for extraction</div>
                    <pre style={{ margin:0, whiteSpace:"pre-wrap", overflowWrap:"anywhere", color:"#93c5fd", fontSize:11, lineHeight:1.6 }}>{extractQuery}</pre>
                  </div>
                )}

                {!extracting && !done && (
                  <button className="btn btn-green" style={{ width:"100%", fontSize:14, padding:"12px" }} onClick={startExtraction}>▶ Start Extraction</button>
                )}
                {!extracting && !done && <button className="btn btn-ghost" style={{ width:"100%", marginTop:8, fontSize:13 }} onClick={()=>setStep(3)}>← Back</button>}
              </div>

              <div className="card" style={{ fontFamily:"monospace" }}>
                <div style={{ fontSize:11, color:"#4b6074", marginBottom:12, textTransform:"uppercase", letterSpacing:"0.06em" }}>
                  {extracting ? <span className="pulse">⟳ Extracting...</span> : done ? "✅ Complete" : "Extraction Log"}
                </div>
                {extractLog.length === 0 && !extracting && (
                  <div style={{ color:"#334155", fontSize:12, textAlign:"center", padding:"40px 0" }}>Log will stream here in real time</div>
                )}
                <div style={{ fontSize:12, lineHeight:2, maxHeight:320, overflowY:"auto" }}>
                  {extractLog.map((l,i)=>(
                    <div key={i} style={{ color:l.startsWith("✅")||l.startsWith("🎉")?"#4ade80":l.startsWith("❌")?"#f87171":"#94a3b8" }}>{l}</div>
                  ))}
                  {extracting && <div className="pulse" style={{ color:"#60a5fa" }}>Processing rows...</div>}
                </div>

                {extractFiles.length > 0 && (
                  <div style={{ marginTop:14, paddingTop:14, borderTop:"1px solid #1e3a5f" }}>
                    <div style={{ fontSize:11, color:"#4b6074", marginBottom:8 }}>DOWNLOAD FILES</div>
                    {extractFiles.map(f=>(
                      <a key={f} href={`${API}/api/download/${f}`} download style={{ display:"block", color:"#60a5fa", fontSize:12, padding:"4px 0", textDecoration:"none" }}>
                        ⬇ {f}
                      </a>
                    ))}
                  </div>
                )}

                {done && (
                  <div style={{ marginTop:16, padding:"14px 16px", background:"#0f2a14", border:"1px solid #14532d", borderRadius:8 }}>
                    <div style={{ fontSize:14, color:"#4ade80", fontWeight:600, marginBottom:8, fontFamily:"'Space Grotesk',sans-serif" }}>🎉 Pipeline Complete!</div>
                    <button className="btn" style={{ fontSize:12, padding:"8px 14px" }} onClick={()=>{setStep(0);setConnected(false);setSourceType(null);setMappings([]);setExtractLog([]);setExtractFiles([]);setExtractQuery("");setDone(false);setChat([])}}>
                      ↺ New Extraction
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
