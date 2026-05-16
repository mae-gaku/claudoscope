// Claudoscope dashboard frontend
// Subscribes to /api/stream (SSE) and renders charts + tables using Chart.js.

(() => {
  const $ = (id) => document.getElementById(id);

  const palette = {
    accent: '#ff8c42',
    accent2: '#ffb070',
    blue: '#5aa9ff',
    purple: '#b58bff',
    teal: '#38c4d3',
    good: '#38d39f',
    warn: '#f5b955',
    bad: '#ff5d6c',
    muted: '#8a93a6',
    grid: 'rgba(255,255,255,0.06)',
  };

  const fmt = {
    num(n) {
      if (n == null) return '0';
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
      if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
      return String(Math.round(n));
    },
    usd(n) {
      if (!n) return '$0.00';
      if (n < 0.01) return '$' + n.toFixed(4);
      if (n < 1) return '$' + n.toFixed(3);
      return '$' + n.toFixed(2);
    },
    relTime(ts) {
      const diff = Math.max(0, Date.now() - ts);
      if (diff < 60_000) return Math.floor(diff / 1000) + 's ago';
      if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
      if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
      return Math.floor(diff / 86_400_000) + 'd ago';
    },
    clock(ts) {
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    },
    cwd(p) {
      if (!p) return '—';
      const parts = p.split('/').filter(Boolean);
      if (parts.length <= 2) return p;
      return '…/' + parts.slice(-2).join('/');
    },
  };

  // ---- Chart.js global defaults ----
  Chart.defaults.color = palette.muted;
  Chart.defaults.borderColor = palette.grid;
  Chart.defaults.font.family =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  Chart.defaults.animation.duration = 300;

  // ---- Charts ----
  const charts = {};

  function buildCharts() {
    charts.timeline = new Chart($('chart-timeline'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Input',
            data: [],
            borderColor: palette.blue,
            backgroundColor: hexA(palette.blue, 0.15),
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          },
          {
            label: 'Output',
            data: [],
            borderColor: palette.accent,
            backgroundColor: hexA(palette.accent, 0.15),
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          },
          {
            label: 'Cache',
            data: [],
            borderColor: palette.purple,
            backgroundColor: hexA(palette.purple, 0.1),
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          },
        ],
      },
      options: lineOpts({ stacked: true, yFmt: (v) => fmt.num(v) }),
    });

    charts.cost = new Chart($('chart-cost'), {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            type: 'bar',
            label: 'Messages',
            yAxisID: 'y1',
            data: [],
            backgroundColor: hexA(palette.teal, 0.5),
            borderColor: palette.teal,
            borderWidth: 1,
          },
          {
            type: 'line',
            label: 'Cost (USD)',
            yAxisID: 'y',
            data: [],
            borderColor: palette.good,
            backgroundColor: hexA(palette.good, 0.2),
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { color: palette.grid }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
          y: {
            position: 'left',
            grid: { color: palette.grid },
            ticks: { callback: (v) => fmt.usd(v) },
          },
          y1: {
            position: 'right',
            grid: { display: false },
            ticks: { callback: (v) => fmt.num(v) },
          },
        },
        plugins: {
          legend: { labels: { boxWidth: 12, boxHeight: 8 } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = ctx.parsed.y;
                if (ctx.dataset.yAxisID === 'y') return `Cost: ${fmt.usd(v)}`;
                return `${ctx.dataset.label}: ${fmt.num(v)}`;
              },
            },
          },
        },
      },
    });

    charts.tools = new Chart($('chart-tools'), {
      type: 'bar',
      data: { labels: [], datasets: [{ label: 'Calls', data: [], backgroundColor: palette.accent }] },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: palette.grid }, ticks: { callback: (v) => fmt.num(v) } },
          y: { grid: { display: false } },
        },
      },
    });

    charts.gauge = new Chart($('chart-gauge'), {
      type: 'doughnut',
      data: {
        labels: ['used', 'remaining'],
        datasets: [
          {
            data: [0, 100],
            backgroundColor: [palette.accent, '#232a3a'],
            borderColor: '#161b27',
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        cutout: '74%',
        rotation: -90,
        circumference: 360,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
      },
    });

    charts.models = new Chart($('chart-models'), {
      type: 'doughnut',
      data: {
        labels: [],
        datasets: [
          {
            data: [],
            backgroundColor: [palette.accent, palette.blue, palette.purple, palette.teal, palette.good, palette.warn],
            borderColor: '#161b27',
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 12, boxHeight: 8 } },
          tooltip: { callbacks: { label: (c) => `${c.label}: ${fmt.usd(c.parsed)}` } },
        },
      },
    });
  }

  function lineOpts({ yFmt }) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 12, boxHeight: 8 } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${yFmt(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: { grid: { color: palette.grid }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { stacked: true, grid: { color: palette.grid }, ticks: { callback: yFmt } },
      },
    };
  }

  function hexA(hex, a) {
    const m = hex.replace('#', '');
    const r = parseInt(m.substring(0, 2), 16);
    const g = parseInt(m.substring(2, 4), 16);
    const b = parseInt(m.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  let latestSnap = null;
  let latestUsage = null;

  // ---- Render snapshot ----
  function render(snap) {
    latestSnap = snap;
    if (!snap || !snap.totals) return;
    const t = snap.totals;
    const l5 = snap.last5h || {};
    const plan = snap.plan || { name: 'api', label: 'API', budget: 0 };

    $('kpi-cost').textContent = fmt.usd(t.cost);
    $('kpi-cost-sub').textContent =
      `${snap.byModel?.length || 0} model${(snap.byModel?.length || 0) === 1 ? '' : 's'} · API-equivalent`;

    const totalTok = (t.tokens.input || 0) + (t.tokens.output || 0) + (t.tokens.cache_read || 0) + (t.tokens.cache_write || 0);
    $('kpi-tokens').textContent = fmt.num(totalTok);
    $('kpi-tokens-sub').textContent =
      `in ${fmt.num(t.tokens.input)} · out ${fmt.num(t.tokens.output)} · cache ${fmt.num(
        (t.tokens.cache_read || 0) + (t.tokens.cache_write || 0)
      )}`;

    $('kpi-active').textContent = String(t.activeSessions || 0);
    $('kpi-active-sub').textContent = `of ${t.sessions} total · last 5 min`;

    $('kpi-tools').textContent = fmt.num(t.toolCalls);
    $('kpi-tools-sub').textContent = `${fmt.num(t.toolErrors)} errors`;

    $('last-update').textContent = `updated ${fmt.clock(snap.generatedAt || Date.now())}`;

    renderGauge(l5, plan, latestUsage);
    renderApiCost(t, l5, snap.timeline || []);
    renderTimeline(snap.timeline || []);
    renderCost(snap.timeline || []);
    renderTools(snap.byTool || []);
    renderModels(snap.byModel || []);
    renderSessions(snap.sessions || [], snap.activeSessions || []);
    renderProjects(snap.byProject || []);
  }

  function renderGauge(l5, plan, usage) {
    // Prefer Anthropic's official 5h utilization when we have it (real source of truth).
    const liveAvailable = usage && usage.available && usage.fiveHour;
    const pct = liveAvailable
      ? Math.max(0, Math.min(100, usage.fiveHour.utilization || 0))
      : Math.max(0, Math.min(100, l5.usedPct || 0));

    const pctEl = $('gauge-pct');
    pctEl.textContent = pct.toFixed(pct >= 10 ? 0 : 1) + '%';
    pctEl.className = 'gauge-pct' + (pct >= 90 ? ' bad' : pct >= 70 ? ' warn' : '');

    if (liveAvailable) {
      const resets = usage.fiveHour.resets_at ? new Date(usage.fiveHour.resets_at) : null;
      const sub = resets ? `resets ${formatLocalTime(resets)}` : 'live from Anthropic';
      $('gauge-sub').textContent = sub;
      const subLabel = (usage.subscriptionType ? `Claude ${usage.subscriptionType[0].toUpperCase() + usage.subscriptionType.slice(1)}` : plan.label);
      $('plan-label').textContent = `${subLabel} · live`;
    } else {
      const used = l5.cost || 0;
      const budget = plan.budget || 0;
      $('gauge-sub').textContent =
        budget > 0 ? `${fmt.usd(used)} / ${fmt.usd(budget)} (est.)` : `${fmt.usd(used)} (est.)`;
      $('plan-label').textContent = `${plan.label || plan.name} · estimate`;
    }

    $('gauge-msgs').textContent = fmt.num(l5.messages || 0);
    $('gauge-tools').textContent = fmt.num(l5.toolCalls || 0);
    $('gauge-tokens').textContent = fmt.num(l5.tokensTotal || 0);
    $('gauge-limits').textContent = fmt.num(l5.limitHits || 0);

    const remaining = Math.max(0, 100 - pct);
    const color = pct >= 90 ? palette.bad : pct >= 70 ? palette.warn : palette.accent;
    charts.gauge.data.datasets[0].data = [pct, remaining];
    charts.gauge.data.datasets[0].backgroundColor = [color, '#232a3a'];
    charts.gauge.update('none');

    renderQuotaBars(usage);
  }

  function renderQuotaBars(usage) {
    const setBar = (fillId, pctId, val) => {
      const fill = $(fillId);
      const text = $(pctId);
      if (val == null) {
        fill.style.width = '0%';
        fill.className = 'quota-fill';
        text.textContent = '—';
        return;
      }
      const v = Math.max(0, Math.min(100, val));
      fill.style.width = v + '%';
      fill.className = 'quota-fill' + (v >= 90 ? ' bad' : v >= 70 ? ' warn' : '');
      text.textContent = v.toFixed(v >= 10 ? 0 : 1) + '%';
    };

    if (!usage || !usage.available) {
      setBar('quota-7d-fill', 'quota-7d-pct', null);
      setBar('quota-opus-fill', 'quota-opus-pct', null);
      return;
    }
    setBar('quota-7d-fill', 'quota-7d-pct', usage.sevenDay?.utilization);
    // Show whichever 7-day-by-model bucket is non-null
    const opus = usage.sevenDayOpus?.utilization;
    const sonnet = usage.sevenDaySonnet?.utilization;
    if (opus != null) {
      $('quota-opus-label').textContent = '7d Opus';
      setBar('quota-opus-fill', 'quota-opus-pct', opus);
    } else if (sonnet != null) {
      $('quota-opus-label').textContent = '7d Sonnet';
      setBar('quota-opus-fill', 'quota-opus-pct', sonnet);
    } else {
      $('quota-opus-label').textContent = '7d (model)';
      setBar('quota-opus-fill', 'quota-opus-pct', null);
    }
  }

  function formatLocalTime(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderApiCost(totals, l5, timeline) {
    const last60mCost = timeline.reduce((s, b) => s + (b.cost || 0), 0);
    $('api-5h').textContent = fmt.usd(l5.cost || 0);
    $('api-60m').textContent = fmt.usd(last60mCost);
    $('api-life').textContent = fmt.usd(totals.cost || 0);
    const avg = totals.assistantMessages > 0 ? totals.cost / totals.assistantMessages : 0;
    $('api-avg').textContent = totals.assistantMessages
      ? `${fmt.usd(avg)} × ${fmt.num(totals.assistantMessages)} msg`
      : '—';
    $('api-limits').textContent = fmt.num(totals.limitHits || 0);
  }

  function renderTimeline(buckets) {
    const labels = buckets.map((b) => fmt.clock(b.t));
    const ds = charts.timeline.data.datasets;
    ds[0].data = buckets.map((b) => b.tokens_in ?? 0);
    ds[1].data = buckets.map((b) => b.tokens_out ?? 0);
    ds[2].data = buckets.map((b) => b.tokens_cache ?? 0);
    charts.timeline.data.labels = labels;
    charts.timeline.update('none');
    const total = buckets.reduce((s, b) => s + b.tokens, 0);
    $('timeline-info').textContent = `${fmt.num(total)} tok / 60min`;
  }

  function renderCost(buckets) {
    const labels = buckets.map((b) => fmt.clock(b.t));
    charts.cost.data.labels = labels;
    charts.cost.data.datasets[0].data = buckets.map((b) => b.messages);
    charts.cost.data.datasets[1].data = buckets.map((b) => b.cost);
    charts.cost.update('none');
    const totalCost = buckets.reduce((s, b) => s + b.cost, 0);
    const totalMsg = buckets.reduce((s, b) => s + b.messages, 0);
    $('cost-info').textContent = `${fmt.usd(totalCost)} · ${fmt.num(totalMsg)} msg / 60min`;
  }

  function renderTools(tools) {
    const top = tools.slice(0, 12);
    charts.tools.data.labels = top.map((t) => t.name);
    charts.tools.data.datasets[0].data = top.map((t) => t.calls);
    charts.tools.update('none');
  }

  function renderModels(models) {
    charts.models.data.labels = models.map((m) => shortModel(m.model));
    charts.models.data.datasets[0].data = models.map((m) => +m.cost.toFixed(4));
    charts.models.update('none');
  }

  function shortModel(m) {
    if (!m) return 'unknown';
    return m
      .replace('claude-', '')
      .replace(/-20\d{6}$/, '')
      .replace(/^anthropic\//, '');
  }

  function renderSessions(sessions, activeList) {
    const activeIds = new Set(activeList.map((s) => s.sessionId));
    const list = $('sessions-list');
    const items = sessions.slice(0, 18);
    list.innerHTML = items
      .map((s) => {
        const live = activeIds.has(s.sessionId);
        const tok =
          (s.tokens.input || 0) +
          (s.tokens.output || 0) +
          (s.tokens.cache_read || 0) +
          (s.tokens.cache_write || 0);
        const lastMsg = escapeHtml((s.lastUserText || s.lastAssistantText || '').slice(0, 220));
        return `
          <div class="session-card ${live ? 'live' : ''}">
            <div>
              ${live ? '<span class="badge live">live</span>' : '<span class="badge">idle</span>'}
              ${s.lastTool ? `<span class="badge tool">${escapeHtml(s.lastTool)}</span>` : ''}
              <span class="muted">${fmt.relTime(s.lastTs)}</span>
            </div>
            <div class="cwd">${escapeHtml(fmt.cwd(s.cwd))}${
          s.gitBranch ? ` <span class="muted">@ ${escapeHtml(s.gitBranch)}</span>` : ''
        }</div>
            ${lastMsg ? `<div class="last-msg">${lastMsg}</div>` : ''}
            <div class="meta">
              <span>${fmt.num(s.messages)} msg</span>
              <span>${fmt.num(s.toolCalls)} tools</span>
              <span>${fmt.num(tok)} tok</span>
              <span>${fmt.usd(s.cost)}</span>
            </div>
          </div>
        `;
      })
      .join('');
    $('sessions-info').textContent = `${activeList.length} live · ${sessions.length} total`;
  }

  function renderProjects(projects) {
    const tbody = $('projects-table').querySelector('tbody');
    tbody.innerHTML = projects
      .slice(0, 20)
      .map(
        (p) => `
        <tr>
          <td title="${escapeHtml(p.cwd)}">${escapeHtml(fmt.cwd(p.cwd))}</td>
          <td class="num">${fmt.num(p.sessions)}</td>
          <td class="num">${fmt.num(p.messages)}</td>
          <td class="num">${fmt.num(p.toolCalls)}</td>
          <td class="num">${fmt.num(p.tokens)}</td>
          <td class="num">${fmt.usd(p.cost)}</td>
        </tr>`
      )
      .join('');
  }

  // ---- Live event stream ----
  const MAX_EVENTS = 200;
  const eventBuffer = [];

  function pushEvents(events) {
    for (const ev of events) eventBuffer.push(ev);
    while (eventBuffer.length > MAX_EVENTS) eventBuffer.shift();
    renderEvents();
  }

  function renderEvents() {
    const wrap = $('event-stream');
    // Render newest first
    const rows = [...eventBuffer]
      .slice(-80)
      .reverse()
      .map((ev) => {
        const kind = ev.kind || ev.type || 'other';
        let detail = '';
        if (kind === 'user_message') detail = ev.text || '(user input)';
        else if (kind === 'assistant_message') {
          const tools = (ev.tools || []).map((t) => t.name).join(', ');
          detail = tools ? `→ ${tools}` : ev.text || '(assistant)';
          if (ev.model) detail = `[${shortModel(ev.model)}] ${detail}`;
        } else if (kind === 'tool_result') {
          const errs = (ev.toolResults || []).filter((r) => r.is_error).length;
          detail = errs
            ? `${ev.toolResults.length} result(s), ${errs} error`
            : `${ev.toolResults.length} result(s)`;
        } else if (kind === 'permission_mode') {
          detail = `mode = ${ev.mode}`;
        } else {
          detail = '';
        }
        return `<div class="ev-row">
          <span class="ev-time">${fmt.clock(ev.ts)}</span>
          <span class="ev-kind ${kind}">${kind}</span>
          <span class="ev-detail">${escapeHtml(detail)}</span>
        </div>`;
      })
      .join('');
    wrap.innerHTML = rows;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // ---- SSE connection ----
  let sse = null;
  function connect() {
    setConn(false);
    sse = new EventSource('/api/stream');
    sse.addEventListener('open', () => setConn(true));
    sse.addEventListener('snapshot', (e) => {
      try {
        render(JSON.parse(e.data));
      } catch (err) {
        console.error('snapshot parse', err);
      }
    });
    sse.addEventListener('events', (e) => {
      try {
        pushEvents(JSON.parse(e.data));
      } catch (err) {
        console.error('events parse', err);
      }
    });
    sse.addEventListener('usage', (e) => {
      try {
        latestUsage = JSON.parse(e.data);
        if (latestSnap) render(latestSnap);
      } catch (err) {
        console.error('usage parse', err);
      }
    });
    sse.addEventListener('companion', (e) => {
      try {
        renderCompanion(JSON.parse(e.data));
      } catch (err) {
        console.error('companion parse', err);
      }
    });
    sse.addEventListener('error', () => {
      setConn(false);
      // EventSource auto-reconnects; nothing to do.
    });
  }

  function setConn(ok) {
    $('conn-dot').className = 'dot ' + (ok ? 'dot-on' : 'dot-off');
    $('conn-label').textContent = ok ? 'connected' : 'reconnecting…';
  }

  // ---- Companion (zero-LLM AI pet) ----
  const FACES = {
    idle:    ['(◕ᴗ◕)', '(･ω･)', '(￣▽￣)'],
    happy:   ['(✿◕‿◕)', '(◕▽◕)', '(*˘︶˘*)'],
    excited: ['\\(^▽^)/', '٩(◕‿◕)۶', '(★^O^★)'],
    sleepy:  ['(￣ρ￣)..zZ', '(꒪ω꒪)…zZ', '(˘ω˘)zz'],
    sulking: ['(>﹏<)', '(￣^￣)', '(꒡⌓꒡)'],
    hungry:  ['(´；ω；｀)', '(◞‸◟)', '(╥﹏╥)'],
    sad:     ['(；_；)', '( ´_ゝ`)', '(=﹏=)'],
  };

  function pickFace(state) {
    const list = FACES[state] || FACES.idle;
    return list[Math.floor(Math.random() * list.length)];
  }

  let currentCompanion = null;
  let companionUiReady = false;

  function expForLevel(L) {
    return Math.floor(100 * Math.pow(L, 1.4));
  }

  function stateLabel(s) {
    return ({
      idle: 'idle',
      happy: 'happy ✨',
      excited: 'excited!',
      sleepy: 'sleepy 💤',
      sulking: 'sulking…',
      hungry: 'hungry',
      sad: 'sad',
    })[s] || s || 'idle';
  }

  function setBarFill(barId, valId, val, max) {
    const v = Math.max(0, Math.min(max, val || 0));
    $(barId).style.width = (v / max * 100) + '%';
    $(valId).textContent = Math.round(v) + '%';
  }

  function renderCompanion(c) {
    if (!c) return;
    currentCompanion = c;
    const face = pickFace(c.state);
    $('companion-face').textContent = face;
    $('companion-face-mini').textContent = face;
    $('companion-name').textContent = c.name || 'Claudie';
    $('companion-lvl').textContent = `Lv.${c.level}`;
    const stEl = $('companion-state');
    stEl.textContent = stateLabel(c.state);
    stEl.className = 'companion-state ' + (c.state || 'idle');

    const xpCur = expForLevel(c.level);
    const xpNxt = expForLevel(c.level + 1);
    const xpPct = Math.max(0, Math.min(100, ((c.exp - xpCur) / (xpNxt - xpCur)) * 100));

    setBarFill('bar-hp', 'bar-hp-val', c.hp, 100);
    setBarFill('bar-sat', 'bar-sat-val', c.satiety, 100);
    setBarFill('bar-mood', 'bar-mood-val', c.mood, 100);
    setBarFill('bar-xp', 'bar-xp-val', xpPct, 100);

    $('stat-know').textContent = fmt.num(c.knowledge);
    $('stat-create').textContent = fmt.num(c.creativity);
    $('stat-affect').textContent = fmt.num(c.affection);
    $('stat-branch').textContent = c.evolutionBranch || 'baby';

    const recent = (c.recent || []).slice(-6).reverse();
    $('companion-recent').innerHTML =
      recent.map((r) => `<div>${fmt.clock(r.ts)} ${escapeHtml(r.msg)}</div>`).join('') ||
      '<div style="opacity:0.5">…</div>';
  }

  function setupCompanionUI() {
    if (companionUiReady) return;
    companionUiReady = true;
    const widget = $('companion');
    if (localStorage.getItem('companion.expanded') === '1') widget.classList.remove('collapsed');
    $('companion-toggle').addEventListener('click', () => {
      widget.classList.remove('collapsed');
      localStorage.setItem('companion.expanded', '1');
    });
    $('companion-close').addEventListener('click', () => {
      widget.classList.add('collapsed');
      localStorage.setItem('companion.expanded', '0');
    });
    $('companion-pet').addEventListener('click', async () => {
      widget.classList.add('petted');
      setTimeout(() => widget.classList.remove('petted'), 700);
      try {
        const c = await fetch('/api/companion/pet', { method: 'POST' }).then((r) => r.json());
        renderCompanion(c);
      } catch {}
    });
    $('companion-rename').addEventListener('click', async () => {
      const name = prompt('New name?', currentCompanion?.name || 'Claudie');
      if (!name) return;
      try {
        const c = await fetch('/api/companion/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        }).then((r) => r.json());
        renderCompanion(c);
      } catch {}
    });
  }

  // ---- Boot ----
  async function boot() {
    buildCharts();
    setupCompanionUI();
    try {
      const [snap, evs, usage, companion] = await Promise.all([
        fetch('/api/snapshot').then((r) => r.json()),
        fetch('/api/events?limit=120').then((r) => r.json()),
        fetch('/api/usage').then((r) => r.json()).catch(() => null),
        fetch('/api/companion').then((r) => r.json()).catch(() => null),
      ]);
      latestUsage = usage;
      render(snap);
      pushEvents(evs);
      if (companion) renderCompanion(companion);
    } catch (err) {
      console.error('initial load', err);
    }
    connect();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
