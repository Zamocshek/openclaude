import os
import secrets
from typing import Any, Dict, Optional

import uvicorn
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, Response

import account_admin as aa
import assistant_memory as am
import operator_config as oc
import stat_report_renderer as sr
from runtime_config import (
    ensure_runtime_dirs,
    get_assistant_db_path,
    get_data_dir,
    get_log_file,
    get_session_dir,
)

ensure_runtime_dirs()

APP_NAME = "Telegram MCP Console"

app = FastAPI(title=APP_NAME, version="1.0.0")


def _web_token() -> str:
    return os.getenv("TELEGRAM_MCP_WEB_TOKEN", "").strip()


def _authorized(request: Request) -> bool:
    web_token = _web_token()
    if not web_token:
        return True
    auth = request.headers.get("authorization", "")
    if secrets.compare_digest(auth, f"Bearer {web_token}"):
        return True
    return secrets.compare_digest(request.query_params.get("token", ""), web_token)


def require_auth(request: Request) -> None:
    if not _authorized(request):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _row(row) -> Dict[str, Any]:
    return {k: row[k] for k in row.keys()}


async def _json_body(request: Request) -> Dict[str, Any]:
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON body") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="JSON body must be an object")
    return payload


def _required_text(payload: Dict[str, Any], field: str) -> str:
    value = payload.get(field)
    if value is None:
        raise HTTPException(status_code=400, detail=f"{field} is required")
    text = str(value).strip()
    if not text:
        raise HTTPException(status_code=400, detail=f"{field} must not be empty")
    return text


def _account_files() -> list[dict]:
    session_dir = get_session_dir()
    if not session_dir.exists():
        return []
    accounts = []
    for file in sorted(session_dir.glob("*.session")):
        name = file.stem
        cfg_path = session_dir / f"{name}.json"
        accounts.append(
            {
                "account_id": name,
                "session_file": file.name,
                "has_config": cfg_path.exists(),
                "size": file.stat().st_size,
                "updated_at": int(file.stat().st_mtime),
            }
        )
    return accounts


def _counts(account_id: str) -> dict:
    with am.connect() as conn:
        return {
            "chats": conn.execute(
                "SELECT COUNT(*) FROM assistant_chats WHERE account_id=?", (account_id,)
            ).fetchone()[0],
            "messages": conn.execute(
                "SELECT COUNT(*) FROM assistant_messages WHERE account_id=?", (account_id,)
            ).fetchone()[0],
            "pending": conn.execute(
                "SELECT COUNT(*) FROM assistant_pending_actions WHERE account_id=? AND status='pending'",
                (account_id,),
            ).fetchone()[0],
            "todos": conn.execute(
                "SELECT COUNT(*) FROM assistant_todos WHERE account_id=? AND status='open'",
                (account_id,),
            ).fetchone()[0],
            "reminders": conn.execute(
                "SELECT COUNT(*) FROM assistant_reminders WHERE account_id=? AND status='open'",
                (account_id,),
            ).fetchone()[0],
            "news_sources": conn.execute(
                "SELECT COUNT(*) FROM assistant_chats WHERE account_id=? AND is_news_source=1",
                (account_id,),
            ).fetchone()[0],
        }


@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    return INDEX_HTML


@app.get("/manifest.json")
async def manifest() -> JSONResponse:
    return JSONResponse(
        {
            "name": APP_NAME,
            "short_name": "Telegram MCP",
            "start_url": "/",
            "display": "standalone",
            "background_color": "#0f172a",
            "theme_color": "#0f172a",
            "icons": [],
        }
    )


@app.get("/sw.js")
async def service_worker() -> Response:
    return Response(
        "self.addEventListener('fetch', event => event.respondWith(fetch(event.request)));",
        media_type="application/javascript",
    )


@app.get("/api/status")
async def status(_: None = Depends(require_auth)) -> dict:
    account_ids = ["default"] + [a["account_id"] for a in _account_files()]
    memory = {}
    for account_id in account_ids:
        try:
            memory[account_id] = _counts(account_id)
        except Exception as exc:
            memory[account_id] = {"error": str(exc)}
    return {
        "ok": True,
        "auth_enabled": bool(_web_token()),
        "paths": {
            "data_dir": str(get_data_dir()),
            "session_dir": str(get_session_dir()),
            "assistant_db": str(get_assistant_db_path()),
            "log_file": str(get_log_file()),
        },
        "env": {
            "telegram_api_id": bool(os.getenv("TELEGRAM_API_ID")),
            "telegram_api_hash": bool(os.getenv("TELEGRAM_API_HASH")),
            "session_string": bool(os.getenv("TELEGRAM_SESSION_STRING")),
        },
        "accounts": _account_files(),
        "memory": memory,
    }


@app.get("/api/search")
async def search(
    q: str,
    account_id: str = "default",
    limit: int = 50,
    _: None = Depends(require_auth),
) -> dict:
    query = q.strip()
    if not query:
        raise HTTPException(status_code=400, detail="q must not be empty")
    with am.connect() as conn:
        rows = am.search_messages(conn, account_id, query, limit=limit)
    return {"ok": True, "hits": [_row(r) for r in rows]}


@app.get("/api/pending")
async def pending(account_id: Optional[str] = None, _: None = Depends(require_auth)) -> dict:
    with am.connect() as conn:
        rows = am.list_pending_actions(conn, account_id)
    return {"ok": True, "pending": [_row(r) for r in rows]}


@app.post("/api/pending/{action_id}/cancel")
async def cancel_pending(action_id: int, _: None = Depends(require_auth)) -> dict:
    with am.connect() as conn:
        action = am.get_pending_action(conn, action_id)
        if action is None:
            raise HTTPException(status_code=404, detail="Pending action not found")
        am.resolve_pending_action(conn, action_id, "cancelled")
        conn.commit()
    return {"ok": True, "action_id": action_id, "status": "cancelled"}


@app.get("/api/todos")
async def todos(
    account_id: str = "default",
    status: str = "open",
    _: None = Depends(require_auth),
) -> dict:
    with am.connect() as conn:
        rows = am.list_todos(conn, account_id, status=status)
    return {"ok": True, "todos": [_row(r) for r in rows]}


@app.post("/api/todos")
async def add_todo(request: Request, _: None = Depends(require_auth)) -> dict:
    payload = await _json_body(request)
    text = _required_text(payload, "text")
    with am.connect() as conn:
        todo_id = am.add_todo(
            conn,
            account_id=payload.get("account_id") or "default",
            text=text,
            peer_id=payload.get("peer_id"),
            peer_name=payload.get("peer_name"),
            direction=payload.get("direction") or "mine",
            deadline_at=payload.get("deadline_at"),
        )
        conn.commit()
    return {"ok": True, "todo_id": todo_id}


@app.post("/api/todos/{todo_id}/status")
async def todo_status(todo_id: int, request: Request, _: None = Depends(require_auth)) -> dict:
    payload = await _json_body(request)
    status_value = payload.get("status") or "done"
    with am.connect() as conn:
        ok = am.update_todo_status(conn, todo_id, status_value)
        conn.commit()
    return {"ok": ok, "todo_id": todo_id, "status": status_value}


@app.get("/api/reminders")
async def reminders(
    account_id: str = "default",
    status: str = "open",
    _: None = Depends(require_auth),
) -> dict:
    with am.connect() as conn:
        rows = am.list_reminders(conn, account_id, status=status)
    return {"ok": True, "reminders": [_row(r) for r in rows]}


@app.post("/api/reminders")
async def add_reminder(request: Request, _: None = Depends(require_auth)) -> dict:
    payload = await _json_body(request)
    text = _required_text(payload, "text")
    remind_at = _required_text(payload, "remind_at")
    with am.connect() as conn:
        reminder_id = am.add_reminder(
            conn,
            account_id=payload.get("account_id") or "default",
            text=text,
            remind_at=remind_at,
            peer_id=payload.get("peer_id"),
            peer_name=payload.get("peer_name"),
        )
        conn.commit()
    return {"ok": True, "reminder_id": reminder_id}


@app.get("/api/admin/accounts")
async def admin_accounts(_: None = Depends(require_auth)) -> dict:
    return {"ok": True, "accounts": aa.list_session_files()}


@app.get("/api/admin/config")
async def admin_config(_: None = Depends(require_auth)) -> dict:
    return {"ok": True, "config": oc.load_config(), "path": str(oc.config_path())}


@app.post("/api/admin/config")
async def update_admin_config(request: Request, _: None = Depends(require_auth)) -> dict:
    payload = await _json_body(request)
    patch = payload.get("config", payload)
    merge = bool(payload.get("merge", True))
    try:
        config = oc.update_config(patch, merge=merge)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "config": config, "path": str(oc.config_path())}


@app.post("/api/admin/config/reset")
async def reset_admin_config(_: None = Depends(require_auth)) -> dict:
    return {"ok": True, "config": oc.reset_config(), "path": str(oc.config_path())}


@app.get("/api/stat-reports/templates")
async def stat_report_templates(_: None = Depends(require_auth)) -> dict:
    return {"ok": True, **sr.templates_payload()}


@app.post("/api/stat-reports/render")
async def render_stat_report(request: Request, _: None = Depends(require_auth)) -> dict:
    payload = await _json_body(request)
    report = payload.get("report", payload)
    if not isinstance(report, dict):
        raise HTTPException(status_code=400, detail="report must be a JSON object")
    try:
        result = sr.render_stat_report(
            report,
            output_dir=payload.get("output_dir"),
            output_name=payload.get("output_name"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"ok": True, "result": result}


@app.post("/api/admin/accounts/import")
async def import_accounts(
    files: list[UploadFile] = File(...),
    overwrite: bool = Form(False),
    _: None = Depends(require_auth),
) -> dict:
    if not oc.web_flag("enable_session_import"):
        raise HTTPException(status_code=403, detail="Session import is disabled")
    imported = []
    max_upload_bytes = oc.max_upload_bytes()
    for upload in files:
        try:
            content = await upload.read(max_upload_bytes + 1)
            imported.append(
                aa.save_account_upload(
                    upload.filename or "",
                    content,
                    overwrite=overwrite,
                    max_upload_bytes=max_upload_bytes,
                )
            )
        except FileExistsError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        finally:
            await upload.close()
    return {"ok": True, "imported": imported, "accounts": aa.list_session_files()}


@app.get("/api/admin/accounts/{account_id}/inspect")
async def inspect_account(account_id: str, _: None = Depends(require_auth)) -> dict:
    try:
        return {"ok": True, "account": await aa.inspect_account(account_id)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/admin/accounts/{account_id}/dialogs")
async def account_dialogs(
    account_id: str,
    limit: int = 30,
    _: None = Depends(require_auth),
) -> dict:
    if not oc.feature("web_dialog_view"):
        raise HTTPException(status_code=403, detail="Dialog view is disabled")
    try:
        return {"ok": True, **await aa.list_dialogs(account_id, limit=limit)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/admin/accounts/{account_id}/send")
async def send_account_message(
    account_id: str,
    request: Request,
    _: None = Depends(require_auth),
) -> dict:
    if not oc.web_flag("enable_manual_reply"):
        raise HTTPException(status_code=403, detail="Manual replies are disabled")
    payload = await _json_body(request)
    peer_id = _required_text(payload, "peer_id")
    text = _required_text(payload, "text")
    reply_to = payload.get("reply_to_msg_id") or None
    try:
        result = await aa.send_message(
            account_id,
            peer_id,
            text,
            reply_to_msg_id=int(reply_to) if reply_to is not None else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "result": result}


@app.post("/api/admin/accounts/{account_id}/sync")
async def sync_account_dialogs(
    account_id: str,
    request: Request,
    _: None = Depends(require_auth),
) -> dict:
    if not oc.feature("web_dialog_sync"):
        raise HTTPException(status_code=403, detail="Dialog sync is disabled")
    payload = await _json_body(request)
    try:
        result = await aa.sync_dialogs_to_memory(
            account_id,
            limit=int(payload.get("limit") or 30),
            messages_per_dialog=int(payload.get("messages_per_dialog") or 0),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "result": result}


INDEX_HTML = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0f172a">
  <link rel="manifest" href="/manifest.json">
  <title>Telegram MCP Console</title>
  <style>
    :root { color-scheme: dark; --bg:#0b1020; --panel:#111827; --line:#263244; --text:#e5e7eb; --muted:#94a3b8; --accent:#38bdf8; --ok:#22c55e; --bad:#fb7185; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--text); }
    header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 20px; border-bottom:1px solid var(--line); background:#0f172a; position:sticky; top:0; z-index:2; }
    h1 { margin:0; font-size:18px; font-weight:700; }
    main { display:grid; grid-template-columns: 320px minmax(0,1fr); gap:16px; padding:16px; }
    section, aside { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
    h2 { margin:0 0 12px; font-size:14px; color:#cbd5e1; }
    button, input, select, textarea { border:1px solid var(--line); border-radius:6px; background:#0f172a; color:var(--text); padding:9px 10px; font:inherit; }
    button { cursor:pointer; background:#1e293b; }
    button:hover { border-color:var(--accent); }
    input, textarea, select { width:100%; }
    input[type="checkbox"] { width:auto; }
    input[type="file"] { padding:8px; }
    textarea { min-height:76px; resize:vertical; }
    .grid { display:grid; gap:12px; }
    .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .row > * { flex:1 1 120px; min-width:0; }
    .check { display:flex; gap:8px; align-items:center; color:var(--muted); font-size:12px; }
    .cards { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:10px; }
    .card { border:1px solid var(--line); border-radius:8px; padding:12px; background:#0f172a; }
    .card b { display:block; font-size:22px; margin-top:4px; }
    .muted { color:var(--muted); font-size:12px; }
    .ok { color:var(--ok); }
    .bad { color:var(--bad); }
    .pill { display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:999px; padding:2px 8px; margin:2px 4px 2px 0; color:var(--muted); font-size:12px; }
    .actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
    .actions button { flex:0 0 auto; padding:7px 9px; }
    .code-editor { min-height:220px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    pre { white-space:pre-wrap; word-break:break-word; background:#020617; border:1px solid var(--line); border-radius:8px; padding:12px; max-height:360px; overflow:auto; }
    .item { border-top:1px solid var(--line); padding:10px 0; }
    .item:first-child { border-top:0; }
    @media (max-width: 860px) { main { grid-template-columns: 1fr; } header { align-items:flex-start; flex-direction:column; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Telegram MCP Console</h1>
      <div class="muted">Local production dashboard for memory, accounts, pending actions, todos, reminders.</div>
    </div>
    <button onclick="loadAll()">Refresh</button>
  </header>
  <main>
    <aside class="grid">
      <section>
        <h2>Access</h2>
        <input id="token" placeholder="TELEGRAM_MCP_WEB_TOKEN if enabled">
      </section>
      <section>
        <h2>Account Admin</h2>
        <div class="grid">
          <input id="sessionFiles" type="file" multiple accept=".session,.json">
          <label class="check"><input id="overwriteSessions" type="checkbox"> overwrite existing files</label>
          <button onclick="uploadSessions()">Import Sessions</button>
          <div class="row">
            <button onclick="loadAdminAccounts()">Refresh</button>
            <button onclick="inspectAccount()">Check</button>
          </div>
          <div id="importStatus" class="muted"></div>
        </div>
      </section>
      <section>
        <h2>Settings</h2>
        <div class="grid">
          <input id="cfgDefaultAccount" placeholder="default account_id">
          <div class="row">
            <input id="cfgDialogLimit" placeholder="dialog limit">
            <input id="cfgSyncMessages" placeholder="sync messages">
          </div>
          <label class="check"><input id="cfgSessionImport" type="checkbox"> enable session import</label>
          <label class="check"><input id="cfgManualReply" type="checkbox"> enable manual replies</label>
          <label class="check"><input id="cfgRequireConfirm" type="checkbox"> require browser confirm</label>
          <button onclick="saveConfigForm()">Save Settings</button>
          <button onclick="loadConfig()">Reload Settings</button>
          <div id="configStatus" class="muted"></div>
        </div>
      </section>
      <section>
        <h2>Search Memory</h2>
        <div class="grid">
          <input id="account" value="default" placeholder="account_id">
          <input id="query" placeholder="Search cached messages">
          <button onclick="search()">Search</button>
        </div>
      </section>
      <section>
        <h2>Add Todo</h2>
        <div class="grid">
          <textarea id="todoText" placeholder="Todo text"></textarea>
          <button onclick="addTodo()">Add</button>
        </div>
      </section>
      <section>
        <h2>Add Reminder</h2>
        <div class="grid">
          <textarea id="remText" placeholder="Reminder text"></textarea>
          <input id="remAt" placeholder="2026-06-11T09:00:00+00:00">
          <button onclick="addReminder()">Add</button>
        </div>
      </section>
    </aside>
    <div class="grid">
      <section>
        <h2>Status</h2>
        <div id="statusCards" class="cards"></div>
        <pre id="paths"></pre>
      </section>
      <section>
        <h2>Accounts</h2>
        <div id="accounts"></div>
      </section>
      <section>
        <h2>Account Admin</h2>
        <div id="adminAccounts"></div>
        <pre id="accountInfo">Select an account and run Check.</pre>
      </section>
      <section>
        <h2>Dialogs</h2>
        <div class="row">
          <input id="dialogLimit" value="30" placeholder="limit">
          <input id="syncMessages" value="0" placeholder="messages per dialog">
          <button onclick="loadDialogs()">Load</button>
          <button onclick="syncDialogs()">Sync DB</button>
        </div>
        <div id="dialogs"></div>
      </section>
      <section>
        <h2>Reply</h2>
        <div class="grid">
          <input id="peerId" placeholder="peer id / username">
          <input id="replyToMsgId" placeholder="reply_to message id, optional">
          <textarea id="replyText" placeholder="Message text"></textarea>
          <button onclick="sendReply()">Send via selected account</button>
          <pre id="sendResult"></pre>
        </div>
      </section>
      <section>
        <h2>Operator Config</h2>
        <div class="grid">
          <textarea id="configJson" class="code-editor" spellcheck="false"></textarea>
          <div class="row">
            <button onclick="saveConfigJson()">Save JSON</button>
            <button onclick="resetConfig()">Reset Defaults</button>
          </div>
        </div>
      </section>
      <section>
        <h2>Pending Actions</h2>
        <div id="pending"></div>
      </section>
      <section>
        <h2>Todos</h2>
        <div id="todos"></div>
      </section>
      <section>
        <h2>Reminders</h2>
        <div id="reminders"></div>
      </section>
      <section>
        <h2>Search Results</h2>
        <div id="results"></div>
      </section>
    </div>
  </main>
  <script>
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    const el = id => document.getElementById(id);
    const token = () => el('token').value || localStorage.getItem('mcpToken') || '';
    el('token').addEventListener('change', () => localStorage.setItem('mcpToken', el('token').value));
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
    const idNum = value => Number.parseInt(value, 10) || 0;
    let operatorConfig = null;
    async function api(path, opts = {}) {
      const headers = opts.headers || {};
      if (token()) headers.Authorization = 'Bearer ' + token();
      if (opts.body && !(opts.body instanceof FormData) && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      const res = await fetch(path, {...opts, headers});
      if (res.status === 401) throw new Error('Unauthorized: set TELEGRAM_MCP_WEB_TOKEN');
      if (!res.ok) throw new Error((await res.json()).detail || ('HTTP ' + res.status));
      return res.json();
    }
    function item(html) { return `<div class="item">${html}</div>`; }
    function currentAccount() { return el('account').value.trim() || 'default'; }
    function selectAccount(accountId) {
      el('account').value = accountId || 'default';
      loadTodos().catch(() => {});
      loadReminders().catch(() => {});
    }
    function applyConfig(cfg, forceAccount = false) {
      operatorConfig = cfg;
      el('cfgDefaultAccount').value = cfg.default_account_id || 'default';
      el('cfgDialogLimit').value = cfg.web.default_dialog_limit;
      el('cfgSyncMessages').value = cfg.web.default_sync_messages_per_dialog;
      el('cfgSessionImport').checked = Boolean(cfg.web.enable_session_import);
      el('cfgManualReply').checked = Boolean(cfg.web.enable_manual_reply);
      el('cfgRequireConfirm').checked = Boolean(cfg.web.require_send_confirm);
      el('dialogLimit').value = cfg.web.default_dialog_limit;
      el('syncMessages').value = cfg.web.default_sync_messages_per_dialog;
      if (forceAccount || !el('account').value || el('account').value === 'default') {
        el('account').value = cfg.default_account_id || 'default';
      }
      el('configJson').value = JSON.stringify(cfg, null, 2);
    }
    async function loadConfig(forceAccount = false) {
      try {
        const d = await api('/api/admin/config');
        applyConfig(d.config, forceAccount);
        el('configStatus').textContent = 'Loaded from ' + d.path;
      } catch (e) {
        el('configStatus').textContent = e.message;
      }
    }
    async function saveConfigForm() {
      const patch = {
        default_account_id: el('cfgDefaultAccount').value.trim() || 'default',
        web: {
          default_dialog_limit: idNum(el('cfgDialogLimit').value) || 30,
          default_sync_messages_per_dialog: idNum(el('cfgSyncMessages').value),
          enable_session_import: el('cfgSessionImport').checked,
          enable_manual_reply: el('cfgManualReply').checked,
          require_send_confirm: el('cfgRequireConfirm').checked
        }
      };
      try {
        const d = await api('/api/admin/config', {method:'POST', body:JSON.stringify({config:patch, merge:true})});
        applyConfig(d.config, true);
        el('configStatus').textContent = 'Settings saved.';
      } catch (e) {
        el('configStatus').textContent = e.message;
      }
    }
    async function saveConfigJson() {
      try {
        const parsed = JSON.parse(el('configJson').value);
        const d = await api('/api/admin/config', {method:'POST', body:JSON.stringify({config:parsed, merge:false})});
        applyConfig(d.config, true);
        el('configStatus').textContent = 'JSON config saved.';
      } catch (e) {
        el('configStatus').textContent = e.message;
      }
    }
    async function resetConfig() {
      if (!confirm('Reset operator config to defaults?')) return;
      const d = await api('/api/admin/config/reset', {method:'POST'});
      applyConfig(d.config, true);
      el('configStatus').textContent = 'Defaults restored.';
    }
    async function loadAll() {
      try {
        await loadConfig();
        const s = await api('/api/status');
        const defaultCounts = s.memory[el('account').value] || s.memory.default || {};
        el('statusCards').innerHTML = Object.entries(defaultCounts).map(([k,v]) => `<div class="card"><span class="muted">${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
        el('paths').textContent = JSON.stringify({auth_enabled:s.auth_enabled, paths:s.paths, env:s.env}, null, 2);
        el('accounts').innerHTML = s.accounts.length ? s.accounts.map(a => item(`<b>${esc(a.account_id)}</b><div class="muted">${esc(a.session_file)} &middot; config:${esc(a.has_config)}</div>`)).join('') : '<div class="muted">No file sessions found.</div>';
        await loadPending(); await loadTodos(); await loadReminders(); await loadAdminAccounts();
      } catch (e) { el('paths').textContent = e.message; }
    }
    async function uploadSessions() {
      const input = el('sessionFiles');
      if (!input.files.length) {
        el('importStatus').textContent = 'Choose .session or .json files first.';
        return;
      }
      const body = new FormData();
      [...input.files].forEach(file => body.append('files', file));
      body.append('overwrite', el('overwriteSessions').checked ? 'true' : 'false');
      try {
        const d = await api('/api/admin/accounts/import', {method:'POST', body});
        el('importStatus').textContent = 'Imported: ' + d.imported.map(x => x.file.name).join(', ');
        input.value = '';
        renderAdminAccounts(d.accounts);
      } catch (e) {
        el('importStatus').textContent = e.message;
      }
    }
    function renderAdminAccounts(accounts) {
      el('adminAccounts').innerHTML = accounts.length ? accounts.map(a => {
        const memory = a.memory || {};
        const health = a.health ? `<span class="bad">${esc(a.health)}</span>` : '<span class="ok">session ok</span>';
        const id = esc(a.account_id);
        return item(`
          <b>${id}</b> ${health}<br>
          <span class="pill">chats ${esc(memory.chats ?? 0)}</span>
          <span class="pill">messages ${esc(memory.messages ?? 0)}</span>
          <span class="pill">todos ${esc(memory.todos ?? 0)}</span>
          <span class="pill">reminders ${esc(memory.reminders ?? 0)}</span>
          <div class="muted">${esc(a.session?.name || '')} &middot; config:${esc(Boolean(a.config))}</div>
          <div class="actions">
            <button data-account="${id}" onclick="selectAccount(this.dataset.account)">Use</button>
            <button data-account="${id}" onclick="selectAccount(this.dataset.account); inspectAccount()">Check</button>
            <button data-account="${id}" onclick="selectAccount(this.dataset.account); loadDialogs()">Dialogs</button>
          </div>
        `);
      }).join('') : '<div class="muted">No imported account sessions.</div>';
    }
    async function loadAdminAccounts() {
      try {
        const d = await api('/api/admin/accounts');
        renderAdminAccounts(d.accounts);
      } catch (e) {
        el('adminAccounts').innerHTML = `<div class="bad">${esc(e.message)}</div>`;
      }
    }
    async function inspectAccount() {
      el('accountInfo').textContent = 'Checking ' + currentAccount() + '...';
      try {
        const d = await api('/api/admin/accounts/' + encodeURIComponent(currentAccount()) + '/inspect');
        el('accountInfo').textContent = JSON.stringify(d.account, null, 2);
      } catch (e) {
        el('accountInfo').textContent = e.message;
      }
    }
    async function loadDialogs() {
      el('dialogs').innerHTML = '<div class="muted">Loading dialogs...</div>';
      try {
        const limit = Math.max(1, Math.min(idNum(el('dialogLimit').value) || 30, 100));
        const d = await api('/api/admin/accounts/' + encodeURIComponent(currentAccount()) + '/dialogs?limit=' + limit);
        if (d.error) {
          el('dialogs').innerHTML = `<div class="bad">${esc(d.error)}</div>`;
          return;
        }
        el('dialogs').innerHTML = d.dialogs.length ? d.dialogs.map(x => {
          const peerId = esc(x.id);
          const msgId = esc(x.last_message_id || '');
          const muted = x.muted ? '<span class="bad">muted</span>' : '<span class="ok">not muted</span>';
          return item(`
            <b>${esc(x.title)}</b> ${muted}<br>
            <span class="pill">${esc(x.entity_type)}</span>
            <span class="pill">id ${peerId}</span>
            <span class="pill">unread ${esc(x.unread_count)}</span>
            <span class="muted">${esc(x.last_message_date || '')}</span><br>
            ${esc(x.last_message || '')}
            <div class="actions">
              <button data-peer="${peerId}" data-msg="${msgId}" onclick="prepareReply(this.dataset.peer, this.dataset.msg)">Reply</button>
            </div>
          `);
        }).join('') : '<div class="muted">No dialogs returned.</div>';
      } catch (e) {
        el('dialogs').innerHTML = `<div class="bad">${esc(e.message)}</div>`;
      }
    }
    function prepareReply(peerId, msgId) {
      el('peerId').value = peerId || '';
      el('replyToMsgId').value = msgId || '';
      el('replyText').focus();
    }
    async function syncDialogs() {
      el('accountInfo').textContent = 'Syncing dialogs for ' + currentAccount() + '...';
      try {
        const d = await api('/api/admin/accounts/' + encodeURIComponent(currentAccount()) + '/sync', {
          method:'POST',
          body:JSON.stringify({
            limit: Math.max(1, Math.min(idNum(el('dialogLimit').value) || 30, 100)),
            messages_per_dialog: Math.max(0, Math.min(idNum(el('syncMessages').value) || 0, 50))
          })
        });
        el('accountInfo').textContent = JSON.stringify(d.result, null, 2);
        await loadAdminAccounts();
      } catch (e) {
        el('accountInfo').textContent = e.message;
      }
    }
    async function sendReply() {
      const peerId = el('peerId').value.trim();
      const text = el('replyText').value.trim();
      if (!peerId || !text) {
        el('sendResult').textContent = 'peer id and message text are required.';
        return;
      }
      if (!operatorConfig || operatorConfig.web.require_send_confirm) {
        if (!confirm('Send message via account ' + currentAccount() + '?')) return;
      }
      try {
        const payload = {peer_id: peerId, text};
        if (el('replyToMsgId').value.trim()) payload.reply_to_msg_id = idNum(el('replyToMsgId').value);
        const d = await api('/api/admin/accounts/' + encodeURIComponent(currentAccount()) + '/send', {method:'POST', body:JSON.stringify(payload)});
        el('sendResult').textContent = JSON.stringify(d.result, null, 2);
        el('replyText').value = '';
      } catch (e) {
        el('sendResult').textContent = e.message;
      }
    }
    async function loadPending() {
      const d = await api('/api/pending');
      el('pending').innerHTML = d.pending.length ? d.pending.map(p => {
        const id = idNum(p.id);
        const target = p.target_label || p.target_chat || '';
        return item(`<b>#${id}</b> ${esc(p.action_type)} -> ${esc(target)}<br><span class="muted">${esc(p.created_at)}</span><br><button onclick="cancelPending(${id})">Cancel</button>`);
      }).join('') : '<div class="muted">No pending actions.</div>';
    }
    async function cancelPending(id) { await api('/api/pending/' + id + '/cancel', {method:'POST'}); await loadPending(); }
    async function loadTodos() {
      const d = await api('/api/todos?account_id=' + encodeURIComponent(el('account').value));
      el('todos').innerHTML = d.todos.length ? d.todos.map(t => {
        const id = idNum(t.id);
        return item(`<b>#${id}</b> ${esc(t.text)}<div class="muted">${esc(t.peer_name || '')} ${esc(t.deadline_at || '')}</div><button onclick="todoDone(${id})">Done</button>`);
      }).join('') : '<div class="muted">No open todos.</div>';
    }
    async function todoDone(id) { await api('/api/todos/' + id + '/status', {method:'POST', body:JSON.stringify({status:'done'})}); await loadTodos(); }
    async function addTodo() {
      await api('/api/todos', {method:'POST', body:JSON.stringify({account_id:el('account').value, text:el('todoText').value})});
      el('todoText').value = ''; await loadTodos();
    }
    async function loadReminders() {
      const d = await api('/api/reminders?account_id=' + encodeURIComponent(el('account').value));
      el('reminders').innerHTML = d.reminders.length ? d.reminders.map(r => {
        const id = idNum(r.id);
        return item(`<b>#${id}</b> ${esc(r.text)}<div class="muted">${esc(r.remind_at)}</div>`);
      }).join('') : '<div class="muted">No open reminders.</div>';
    }
    async function addReminder() {
      await api('/api/reminders', {method:'POST', body:JSON.stringify({account_id:el('account').value, text:el('remText').value, remind_at:el('remAt').value})});
      el('remText').value = ''; await loadReminders();
    }
    async function search() {
      const d = await api('/api/search?account_id=' + encodeURIComponent(el('account').value) + '&q=' + encodeURIComponent(el('query').value));
      el('results').innerHTML = d.hits.length ? d.hits.map(h => {
        const title = h.chat_title || h.peer_id || '';
        const body = h.snippet || h.text || '';
        return item(`<b>${esc(title)}</b> <span class="muted">msg ${esc(h.message_id)} &middot; ${esc(h.date || '')}</span><br>${esc(body)}`);
      }).join('') : '<div class="muted">No hits.</div>';
    }
    loadAll();
  </script>
</body>
</html>"""


def main() -> None:
    host = os.getenv("TELEGRAM_MCP_WEB_HOST", "127.0.0.1")
    port = int(os.getenv("TELEGRAM_MCP_WEB_PORT", "8765"))
    uvicorn.run("web_app:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
