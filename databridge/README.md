# DataBridge AI — Complete Setup & Execution Guide

## Architecture Overview

```
Browser (React UI)
      │  HTTP requests to /api/*
      ▼
Nginx (port 80)  ──────────────────────────────────┐
      │                                             │
      ├── Static files → /frontend/build            │
      │                                             │
      └── /api/* → Node.js backend (port 5000)      │
                        │                           │
                        ├── Azure OpenAI API  ◄─────┘
                        ├── SQL Server / PostgreSQL / MySQL
                        └── Output text files (./output/)
```

**Your API key lives only on the backend server. It is never sent to the browser.**

---

## Prerequisites

| Tool | Required | Download |
|------|----------|----------|
| VS Code | ✅ Yes | https://code.visualstudio.com |
| Node.js 22+ | ✅ Yes | https://nodejs.org |
| Git | ✅ Yes | https://git-scm.com |
| Azure OpenAI resource | ✅ Yes | Azure Portal |
| Docker Desktop | ⚪ Optional | https://docker.com |

---

## Option A — Run Locally via VS Code (Development)

This is the easiest way to get started and test everything.

### Step 1 — Open the project in VS Code

1. Open VS Code
2. Go to **File → Open Folder**
3. Select the `databridge` folder

### Step 2 — Install VS Code Extensions (recommended)

Open Extensions panel (Ctrl+Shift+X) and install:
- **ES7+ React/Redux/React-Native snippets**
- **Prettier - Code formatter**
- **REST Client** (for testing API endpoints)
- **DotENV** (for .env syntax highlighting)

### Step 3 — Configure Azure OpenAI credentials

In VS Code, open the **Terminal** (Ctrl+` backtick):

```bash
cd backend
cp .env.example .env
```

Now open `.env` in VS Code and fill in:

```env
AZURE_OPENAI_ENDPOINT=https://YOUR-RESOURCE.openai.azure.com
AZURE_OPENAI_API_KEY=your_key_here
AZURE_OPENAI_DEPLOYMENT=your_model_deployment
```

**Where to find these values:**
1. Go to https://portal.azure.com
2. Search for "Azure OpenAI"
3. Click your OpenAI resource
4. Left menu → "Keys and Endpoint" → copy Key 1 and Endpoint
5. Left menu → "Model deployments" → note the deployment NAME you created

### Step 4 — Start the Backend

In VS Code Terminal:

```bash
cd backend
npm install
npm run dev
```

You should see:
```
✅ DataBridge AI server running on port 5000
```

**Keep this terminal open.** Open a second terminal for the next step.

### Step 5 — Start the React Frontend

In a NEW terminal tab (click the + icon in VS Code terminal):

```bash
cd frontend
npm install
npm start
```

Your browser will automatically open at **http://localhost:3000**

The React app proxies all `/api` calls to `localhost:5000` automatically (configured in `frontend/package.json`).

### Step 6 — Use the Application

1. **Connect tab** — Select your source type (SQL Server, PostgreSQL, etc.)
2. Fill in connection credentials → click **Test & Connect**
3. Upload your mapping Excel file (optional but improves AI accuracy)
4. **Schema tab** — Review or edit the target extraction columns
5. Enter the source table name → click **Fetch Source Schema**
6. **AI Mapping tab** — Click **Run AI Mapping** — Azure OpenAI maps the columns
7. Review confidence scores, override any mapping with the dropdown
8. **Confirm tab** — Chat with the AI assistant to verify or adjust mappings
9. **Extract tab** — Set rows per file → click **Start Extraction**
10. Download the generated `.txt` files

---

## Option B — Run on Azure VM (Production)

### Step 1 — Create an Azure VM

1. Go to https://portal.azure.com
2. Create Resource → Virtual Machine
3. Recommended settings:
   - **OS**: Ubuntu Server 22.04 LTS
   - **Size**: Standard_B2s (2 vCPUs, 4GB RAM) or larger
   - **Authentication**: SSH public key (recommended) or password
   - **Inbound ports**: Allow HTTP (80), HTTPS (443), SSH (22)

### Step 2 — Connect to your VM

On your local machine (Windows: use PowerShell or PuTTY):

```bash
ssh azureuser@YOUR_VM_PUBLIC_IP
```

### Step 3 — Upload the project to the VM

**Option A — Git (recommended):**
```bash
# On VM:
git clone https://your-repo-url/databridge.git
cd databridge
```

**Option B — SCP from your local machine:**
```bash
# On your local machine:
scp -r ./databridge azureuser@YOUR_VM_IP:~/
```

**Option C — VS Code Remote SSH:**
1. Install extension: **Remote - SSH**
2. Ctrl+Shift+P → "Remote-SSH: Connect to Host"
3. Enter: `azureuser@YOUR_VM_IP`
4. Edit files directly on the VM from VS Code!

### Step 4 — Run the deployment script

```bash
cd ~/databridge
chmod +x scripts/deploy.sh
sudo bash scripts/deploy.sh
```

This automatically installs Node.js, Nginx, PM2, and builds the frontend.

### Step 5 — Set environment variables

```bash
sudo nano /var/www/databridge/backend/.env
```

Fill in your Azure OpenAI credentials, then save (Ctrl+X, Y, Enter).

```bash
pm2 restart databridge-api
```

### Step 6 — Open in browser

Navigate to: `http://YOUR_VM_PUBLIC_IP`

---

## Option C — Docker (Easiest for Production)

If you have Docker Desktop installed:

### Step 1 — Create the .env file

```bash
cd databridge/backend
cp .env.example .env
# Edit .env with your credentials
```

### Step 2 — Build and run

```bash
cd databridge
docker-compose up --build
```

That's it. Open http://localhost in your browser.

### Stop Docker containers

```bash
docker-compose down
```

---

## Folder Structure

```
databridge/
├── backend/
│   ├── server.js          ← Express API server (Node.js)
│   ├── package.json       ← Backend dependencies
│   ├── .env.example       ← Copy to .env and fill in keys
│   ├── Dockerfile         ← Docker image for backend
│   └── output/            ← Extracted .txt files saved here
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx        ← Main React UI (all 5 steps)
│   │   └── index.js       ← React entry point
│   ├── public/
│   │   └── index.html
│   ├── package.json       ← Frontend dependencies
│   └── Dockerfile         ← Docker image for frontend
│
├── nginx/
│   └── databridge.conf    ← Nginx reverse proxy config
│
├── scripts/
│   └── deploy.sh          ← One-click VM deployment script
│
└── docker-compose.yml     ← Run everything with Docker
```

---

## API Endpoints (Backend)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/health | Health check |
| POST | /api/connect | Test DB/cloud connection |
| POST | /api/upload-mapping | Upload training Excel |
| POST | /api/schema | Fetch source table columns |
| POST | /api/ai-mapping | Run Azure OpenAI column mapping |
| POST | /api/ai-chat | Chat with mapping assistant |
| POST | /api/extract | Stream extraction (SSE) |
| GET | /api/download/:file | Download extracted file |

---

## Adding More Database Types

To add Oracle, Snowflake, or BigQuery support in `backend/server.js`:

```bash
# Oracle
npm install oracledb

# Snowflake
npm install snowflake-sdk

# BigQuery
npm install @google-cloud/bigquery
```

Then add a new `case` block in the `/api/connect` and `/api/extract` routes.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Cannot reach backend` in UI | Backend not running — run `npm run dev` in `/backend` |
| Azure OpenAI 401 error | Wrong API key or endpoint in `.env` |
| Azure OpenAI 404 error | Deployment name in `.env` doesn't match Azure Studio |
| DB connection refused | Check firewall rules — Azure SQL needs port 1433 open |
| Blank page at localhost:3000 | Frontend not built — run `npm install` then `npm start` |
| `EACCES` port 80 error | Use `sudo` or run on port 3000 locally |
| PM2 not found on VM | Run `npm install -g pm2` |

---

## Security Notes

- Never commit `.env` to Git — it's in `.gitignore`
- Use Azure Key Vault for production secret management
- Enable HTTPS with Let's Encrypt: `certbot --nginx -d yourdomain.com`
- Set up Azure VM Network Security Group to restrict port 5000 (backend should only be accessible via Nginx)

---

## Customizing the Mapping Excel Format

The training Excel should have these columns (headers in row 1):

| source_column | target_column | transform | confidence | notes |
|---------------|---------------|-----------|------------|-------|
| cust_id | CUSTOMER_ID | | high | direct match |
| first_name | FULL_NAME | CONCAT(first_name,' ',last_name) | medium | combine fields |

The AI uses these historical mappings to improve future suggestions for similar schemas.
