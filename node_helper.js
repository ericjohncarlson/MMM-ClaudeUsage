/* MMM-ClaudeUsage — node_helper
 * Polls the (undocumented) Claude subscription usage endpoint that Claude Code's
 * /usage command uses, and pushes normalized windows to the front end.
 */
const NodeHelper = require("node_helper");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULTS = {
  apiUrl: "https://api.anthropic.com/api/oauth/usage",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", // Claude Code's public OAuth client
  betaHeader: "oauth-2025-04-20",
  credentialsFile: "~/.claude/.credentials.json",
  token: null,
  allowRefresh: false,
  updateInterval: 5 * 60 * 1000,
};

const CACHE_FILE = path.join(__dirname, ".token-cache.json");
const ENV_FILE = path.join(__dirname, ".env");
const STATE_FILE = path.join(__dirname, ".usage-state.json");
const MIN_INTERVAL = 5 * 60 * 1000;
// The only settings a socket client may supply. API/token URLs stay server-side so a
// rogue client can't point the helper (and our tokens) at another host.
const CLIENT_KEYS = ["credentialsFile", "token", "allowRefresh", "updateInterval"];
const MAX_BACKOFF = 60 * 60 * 1000;

// Minimal .env parser (no dependency). process.env wins, so docker env_file also works.
function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch (e) {
    /* no .env */
  }
  const get = (k) => process.env[k] || env[k] || null;
  const accessToken = get("CLAUDE_ACCESS_TOKEN");
  const refreshToken = get("CLAUDE_REFRESH_TOKEN");
  if (!accessToken && !refreshToken) return null;
  const exp = get("CLAUDE_TOKEN_EXPIRES_AT");
  return {
    accessToken,
    refreshToken,
    // No access token → force an immediate refresh.
    expiresAt: accessToken ? (exp ? Number(exp) : null) : 0,
    source: "env",
    // Only a token that lives in the .env file can be written back there.
    envFile: !process.env.CLAUDE_REFRESH_TOKEN && !!env.CLAUDE_REFRESH_TOKEN,
  };
}

// writeFileSync's mode only applies to new files, so tighten existing ones too.
function writePrivate(p, body) {
  fs.writeFileSync(p, body, { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch (e) {
    /* e.g. bind mount owned by another user */
  }
}

// Persist a rotated refresh token into .env so losing .token-cache.json is harmless.
// Drops any seeded access-token lines, which are stale after a refresh.
function writeEnvRefreshToken(rt) {
  let lines = [];
  try {
    lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  } catch (e) {
    /* new file */
  }
  const isVar = (l, k) => new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=`).test(l);
  let replaced = false;
  lines = lines
    .filter((l) => !isVar(l, "CLAUDE_ACCESS_TOKEN") && !isVar(l, "CLAUDE_TOKEN_EXPIRES_AT"))
    .map((l) => (isVar(l, "CLAUDE_REFRESH_TOKEN") ? ((replaced = true), `CLAUDE_REFRESH_TOKEN=${rt}`) : l));
  if (!replaced) lines.push(`CLAUDE_REFRESH_TOKEN=${rt}`);
  const body = lines.join("\n").replace(/\n*$/, "\n");
  const tmp = `${ENV_FILE}.tmp`;
  try {
    writePrivate(tmp, body);
    fs.renameSync(tmp, ENV_FILE);
  } catch (e) {
    writePrivate(ENV_FILE, body); // e.g. .env is itself a bind mount
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* ignore */
    }
  }
}

function expand(p) {
  return p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}

module.exports = NodeHelper.create({
  /* One poller per server process, shared by every browser client.
   * Page loads/reloads just get the last result — they never trigger an API call.
   * Last result + backoff are persisted, so container restarts don't either. */
  start() {
    this.ids = new Set();
    this.config = null;
    this.timer = null;
    this.state = Object.assign({ data: null, error: null, fetchedAt: 0, backoffUntil: 0, backoffMs: 0 }, readJson(STATE_FILE) || {});
    // Older versions baked the countdown into the saved message.
    if (this.state.error && this.state.error.startsWith("Rate limited")) this.state.error = "Rate limited";
  },

  socketNotificationReceived(notification, payload) {
    if (notification !== "CLAUDE_USAGE_INIT") return;
    this.ids.add(payload.identifier);
    this.broadcastState(); // serve whatever we have right away
    if (this.config) return; // config is fixed by the first client; later INITs can't change it

    const cfg = Object.assign({}, DEFAULTS);
    for (const k of CLIENT_KEYS) if (payload.config && payload.config[k] !== undefined) cfg[k] = payload.config[k];
    cfg.allowRefresh = cfg.allowRefresh === true;
    cfg.updateInterval = Math.max(MIN_INTERVAL, Number(cfg.updateInterval) || DEFAULTS.updateInterval);
    this.config = cfg;

    const due = Math.max(this.state.fetchedAt + cfg.updateInterval, this.state.backoffUntil);
    this.schedule(due - Date.now());
  },

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), Math.max(0, ms));
  },

  async run() {
    const cfg = this.config;
    const s = this.state;
    try {
      const data = await this.poll(cfg);
      Object.assign(s, { data, error: null, fetchedAt: data.fetchedAt, backoffUntil: 0, backoffMs: 0 });
      this.schedule(cfg.updateInterval);
    } catch (e) {
      if (e.rateLimited) {
        // Exponential: interval → 2x → 4x … capped at 1h; Retry-After wins if larger.
        s.backoffMs = Math.min(MAX_BACKOFF, Math.max(e.retryAfterMs || 0, s.backoffMs ? s.backoffMs * 2 : cfg.updateInterval));
        s.backoffUntil = Date.now() + s.backoffMs;
        s.error = "Rate limited";
        this.schedule(s.backoffMs);
      } else {
        s.error = e.message;
        this.schedule(cfg.updateInterval);
      }
      const until = s.backoffUntil > Date.now() ? ` — next try ${new Date(s.backoffUntil).toISOString()}` : "";
      console.error(`[MMM-ClaudeUsage] ${s.error}${until}`);
    }
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(s));
    } catch (e) {
      /* non-fatal */
    }
    this.broadcastState();
  },

  broadcastState() {
    for (const id of this.ids) {
      if (this.state.data) this.sendSocketNotification("CLAUDE_USAGE_DATA", { identifier: id, ...this.state.data });
      if (this.state.error) {
        this.sendSocketNotification("CLAUDE_USAGE_ERROR", {
          identifier: id,
          message: this.state.error,
          retryAt: this.state.backoffUntil > Date.now() ? this.state.backoffUntil : null,
        });
      }
    }
  },

  /* ---------- credentials ---------- */

  loadCreds(cfg) {
    if (cfg.token) return { accessToken: cfg.token, refreshToken: null, expiresAt: null, source: "config" };

    // Source priority: module .env / process env → Claude Code credentials file.
    let base = loadEnv();
    if (!base) {
      const file = readJson(expand(cfg.credentialsFile));
      const src = file && (file.claudeAiOauth || file);
      if (src && src.accessToken) base = { ...src, source: "file" };
    }

    // Our cache holds the current access token. Use it when it belongs to the
    // refresh token in .env; a newly pasted .env token discards the old cache.
    const cache = readJson(CACHE_FILE);
    const cacheMatchesEnv = base && base.source === "env" && cache && (cache.refreshToken === base.refreshToken || cache.seed === base.refreshToken);
    if (cache && cache.accessToken && (!base || cacheMatchesEnv || (base.source === "file" && (cache.expiresAt || 0) > (base.expiresAt || 0)))) {
      return { ...cache, source: "cache" };
    }
    if (!base) throw new Error(`No token: add CLAUDE_REFRESH_TOKEN to the module's .env or provide ${cfg.credentialsFile}`);
    return base;
  },

  async refresh(cfg, creds) {
    // Tokens from .env / our cache belong to this module, so refreshing them is always OK.
    // Tokens borrowed from Claude Code's file only refresh with explicit opt-in.
    const mayRefresh = cfg.allowRefresh || creds.source === "env" || creds.source === "cache";
    if (!mayRefresh || !creds.refreshToken) {
      throw new Error("OAuth token expired — update .env (or set allowRefresh: true)");
    }
    const res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: cfg.clientId,
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      const hint = res.status === 400 ? " — refresh token already used or revoked; paste a fresh one into .env" : "";
      throw new Error(`Token refresh failed: HTTP ${res.status}${hint}${body ? ` (${body})` : ""}`);
    }
    const j = await res.json();
    const next = {
      accessToken: j.access_token,
      refreshToken: j.refresh_token || creds.refreshToken,
      expiresAt: Date.now() + (j.expires_in || 3600) * 1000,
      seed: creds.source === "env" ? creds.refreshToken : creds.seed || null,
      envFile: !!creds.envFile,
    };
    // Rotated token goes back into .env (when it came from there) so the .env
    // always holds a valid token, even if the cache file is deleted.
    if (next.envFile && next.refreshToken !== creds.refreshToken) {
      try {
        writeEnvRefreshToken(next.refreshToken);
        next.seed = next.refreshToken;
      } catch (e) {
        console.error(`[MMM-ClaudeUsage] Could not update .env: ${e.message}`);
      }
    }
    // Written beside the module only — never touches Claude Code's credentials file.
    writePrivate(CACHE_FILE, JSON.stringify(next));
    return { ...next, source: "cache" };
  },

  /* ---------- polling ---------- */

  async callApi(cfg, accessToken) {
    return fetch(cfg.apiUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": cfg.betaHeader,
        "Content-Type": "application/json",
        "User-Agent": "MMM-ClaudeUsage/1.0",
      },
    });
  },

  async poll(cfg) {
    let creds = this.loadCreds(cfg);
    if (creds.expiresAt && creds.expiresAt - 60 * 1000 < Date.now()) creds = await this.refresh(cfg, creds);

    let res = await this.callApi(cfg, creds.accessToken);
    if (res.status === 401 && creds.refreshToken) {
      creds = await this.refresh(cfg, creds);
      res = await this.callApi(cfg, creds.accessToken);
    }
    if (res.status === 429) {
      const e = new Error("Rate limited");
      e.rateLimited = true;
      e.retryAfterMs = (parseInt(res.headers.get("retry-after"), 10) || 0) * 1000;
      throw e;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`Usage API HTTP ${res.status}${body ? `: ${body}` : ""}`);
    }

    const raw = await res.json();
    return { windows: this.normalize(raw), extra: raw.extra_usage || null, fetchedAt: Date.now() };
  },

  // Turn every { utilization, resets_at } object in the response into a row.
  normalize(raw) {
    const out = [];
    for (const [key, v] of Object.entries(raw || {})) {
      if (v && typeof v === "object" && typeof v.utilization === "number") {
        out.push({ key, utilization: v.utilization, resetsAt: v.resets_at || null });
      }
    }
    return out;
  },
});
