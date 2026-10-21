/* MMM-ClaudeUsage — front end */
Module.register("MMM-ClaudeUsage", {
  defaults: {
    credentialsFile: "~/.claude/.credentials.json",
    token: null, // or paste an OAuth access token here
    allowRefresh: false, // let the module refresh an expired token itself
    updateInterval: 5 * 60 * 1000,
    title: "Claude", // rendered as the native MM header (or set `header:` instead)
    columns: 2, // windows per row (1 = old vertical stack)
    width: null, // e.g. "260px"; null = fit the region
    // Which windows to show, in order. Unknown keys from the API are ignored.
    windows: ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"],
    labels: {
      five_hour: "5-hour",
      seven_day: "Weekly",
      seven_day_opus: "Opus wk",
      seven_day_sonnet: "Sonnet wk",
      seven_day_oauth_apps: "Apps wk",
      seven_day_cowork: "Cowork wk",
    },
    hideZero: false, // hide per-model rows that sit at 0%
    warnAt: 70,
    critAt: 90,
    showExtraUsage: true,
    staleAfter: 20 * 60 * 1000,
  },

  getStyles() {
    return ["MMM-ClaudeUsage.css"];
  },

  // Use MagicMirror's own header so it matches other modules' alignment/styling.
  getHeader() {
    return this.data.header || this.config.title || "";
  },

  start() {
    this.data_ = null;
    this.error = null;
    this.sendSocketNotification("CLAUDE_USAGE_INIT", {
      identifier: this.identifier,
      config: {
        credentialsFile: this.config.credentialsFile,
        token: this.config.token,
        allowRefresh: this.config.allowRefresh,
        updateInterval: this.config.updateInterval,
      },
    });
    // Re-render every minute so reset countdowns tick between polls.
    setInterval(() => this.updateDom(0), 60 * 1000);
  },

  socketNotificationReceived(n, p) {
    if (!p || p.identifier !== this.identifier) return;
    if (n === "CLAUDE_USAGE_DATA") {
      this.data_ = p;
      this.error = null;
      this.retryAt = null;
    }
    if (n === "CLAUDE_USAGE_ERROR") {
      this.error = p.message;
      this.retryAt = p.retryAt || null;
    }
    this.updateDom(300);
  },

  // Error text with a live countdown (re-rendered every minute).
  errorText() {
    if (!this.error) return "";
    if (!this.retryAt) return this.error;
    const left = this.retryAt - Date.now();
    return left > 0 ? `${this.error} — retry in ${this.fmtReset(new Date(this.retryAt).toISOString())}` : `${this.error} — retrying…`;
  },

  fmtReset(iso) {
    if (!iso) return "";
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return "resetting";
    const m = Math.round(ms / 60000);
    const d = Math.floor(m / 1440),
      h = Math.floor((m % 1440) / 60),
      mm = m % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${mm}m`;
    return `${mm}m`;
  },

  level(pct) {
    if (pct >= this.config.critAt) return "crit";
    if (pct >= this.config.warnAt) return "warn";
    return "ok";
  },

  getDom() {
    const root = document.createElement("div");
    root.className = "mmm-claude-usage";
    if (this.config.width) root.style.width = this.config.width;

    if (!this.data_) {
      const s = document.createElement("div");
      s.className = "cu-status dimmed small";
      s.textContent = this.errorText() || "Loading…";
      root.appendChild(s);
      return root;
    }

    const grid = document.createElement("div");
    grid.className = "cu-grid";
    grid.style.gridTemplateColumns = `repeat(${Math.max(1, this.config.columns)}, minmax(0, 1fr))`;
    root.appendChild(grid);

    const byKey = Object.fromEntries(this.data_.windows.map((w) => [w.key, w]));
    for (const key of this.config.windows) {
      const w = byKey[key];
      if (!w) continue;
      if (this.config.hideZero && key !== "five_hour" && key !== "seven_day" && w.utilization === 0) continue;

      const pct = Math.max(0, Math.min(100, w.utilization));
      const row = document.createElement("div");
      row.className = `cu-row cu-${this.level(pct)}`;
      row.innerHTML = `
        <div class="cu-head">
          <span class="cu-label">${this.config.labels[key] || key}</span>
          <span class="cu-pct">${Math.round(pct)}%</span>
        </div>
        <div class="cu-bar"><div class="cu-fill" style="width:${pct}%"></div></div>
        <div class="cu-reset">${w.resetsAt ? `resets ${this.fmtReset(w.resetsAt)}` : ""}</div>`;
      grid.appendChild(row);
    }

    const ex = this.data_.extra;
    if (this.config.showExtraUsage && ex && ex.is_enabled) {
      const e = document.createElement("div");
      e.className = "cu-extra small";
      const used = ex.used_credits != null ? (ex.used_credits / 100).toFixed(2) : "?";
      const lim = ex.monthly_limit != null ? (ex.monthly_limit / 100).toFixed(0) : "∞";
      e.textContent = `Extra usage: $${used} / $${lim}`;
      root.appendChild(e);
    }

    const age = Date.now() - this.data_.fetchedAt;
    if (this.error || age > this.config.staleAfter) {
      const s = document.createElement("div");
      s.className = "cu-status xsmall dimmed";
      s.textContent = this.error ? `⚠ ${this.errorText()}` : `stale · ${Math.round(age / 60000)}m old`;
      root.appendChild(s);
    }
    return root;
  },
});
