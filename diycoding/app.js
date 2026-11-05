/* r/DIYaesthetics coding site. Plain JavaScript, no build step. */
(() => {
  "use strict";
  const CFG = window.APP_CONFIG;
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  const $app = document.getElementById("app");

  const S = {
    email: null,
    isAdmin: false,
    codes: [],                 // from codes.json
    sample: [],                // [{position, unit}]
    byId: new Map(),           // unit id -> index in sample
    myCodes: new Map(),        // unit id -> {code_key: bool}
    myStatus: new Map(),       // unit id -> {done, note}
    signed: new Map(),         // storage path -> signed url
    filter: "todo",
    gallery: 0,
  };

  // ---------- small helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDate = (t) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
  let toastTimer;
  function toast(msg, isError = false) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.className = "toast" + (isError ? " error" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 1500);
  }
  function md(text) {
    if (!text) return "";
    const html = window.marked ? window.marked.parse(text, { breaks: true, gfm: true }) : esc(text).replace(/\n/g, "<br>");
    const clean = window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
    return clean.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
  }
  async function fetchAll(makeQuery) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await makeQuery().range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) return out;
    }
  }
  function doneCount() {
    let n = 0;
    for (const { unit } of S.sample) if (S.myStatus.get(unit.id)?.done) n++;
    return n;
  }
  function updatePill() {
    document.getElementById("progress-pill").textContent = `${doneCount()} / ${S.sample.length} done`;
  }

  // ---------- startup ----------
  async function boot() {
    const { data } = await sb.auth.getSession();
    if (!data.session) return renderLogin();
    S.email = (data.session.user.email || "").toLowerCase();
    try {
      await loadData();
    } catch (e) {
      console.error(e);
      $app.innerHTML = `<div class="card narrow"><h2>Could not load the coding data</h2><p>${esc(e.message || e)}</p><p><button class="btn" id="lo">Log out</button></p></div>`;
      document.getElementById("lo").onclick = logout;
      return;
    }
    if (S.notCoder) {
      $app.innerHTML = `<div class="card narrow"><h2>Not on the coder list</h2><p>You are logged in as <b>${esc(S.email)}</b>, but that email is not in the project's coder list. Ask the project lead to add you.</p><p><button class="btn" id="lo">Log out</button></p></div>`;
      document.getElementById("lo").onclick = logout;
      return;
    }
    document.getElementById("nav").hidden = false;
    document.getElementById("who").textContent = S.email;
    document.getElementById("admin-link").hidden = !S.isAdmin;
    updatePill();
    route();
  }

  async function loadData() {
    const codesResp = await fetch("codes.json", { cache: "no-store" });
    S.codes = (await codesResp.json()).codes;

    const me = await sb.from("coders").select("email,is_admin").eq("email", S.email).maybeSingle();
    if (me.error) throw me.error;
    if (!me.data) { S.notCoder = true; return; }
    S.isAdmin = !!me.data.is_admin;

    const rows = await fetchAll(() =>
      sb.from("samples")
        .select("position, units(id,unit_type,subreddit,author,created_utc,title,body,permalink,url,domain,flair,score,num_comments,media,media_kind,removed)")
        .eq("sample_name", CFG.sampleName)
        .order("position"));
    S.sample = rows.filter((r) => r.units).map((r) => ({ position: r.position, unit: r.units }));
    S.byId = new Map(S.sample.map((r, i) => [r.unit.id, i]));

    const codes = await fetchAll(() => sb.from("codes").select("unit_id,code_key,value").eq("coder_email", S.email));
    S.myCodes = new Map();
    for (const c of codes) {
      if (!S.myCodes.has(c.unit_id)) S.myCodes.set(c.unit_id, {});
      S.myCodes.get(c.unit_id)[c.code_key] = c.value;
    }
    const status = await fetchAll(() => sb.from("unit_status").select("unit_id,done,note").eq("coder_email", S.email));
    S.myStatus = new Map(status.map((s) => [s.unit_id, { done: s.done, note: s.note || "" }]));
  }

  async function logout() {
    await sb.auth.signOut();
    location.hash = "#/";
    location.reload();
  }
  document.getElementById("logout").onclick = logout;

  // ---------- login ----------
  function renderLogin() {
    $app.innerHTML = `
      <form class="card narrow login" id="login">
        <h2>Coder log in</h2>
        <label>Email <input type="email" name="email" autocomplete="username" required></label>
        <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
        <button class="btn primary" type="submit">Log in</button>
        <p class="error" id="login-err" hidden></p>
      </form>`;
    document.getElementById("login").onsubmit = async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const btn = ev.target.querySelector("button");
      btn.disabled = true;
      const { error } = await sb.auth.signInWithPassword({ email: f.get("email").trim(), password: f.get("password") });
      btn.disabled = false;
      if (error) {
        const e = document.getElementById("login-err");
        e.textContent = error.message;
        e.hidden = false;
        return;
      }
      boot();
    };
  }

  // ---------- routing ----------
  function route() {
    if (!S.email || S.notCoder) return;
    const h = location.hash || "#/";
    const m = h.match(/^#\/post\/(.+)$/);
    if (m) return renderPost(decodeURIComponent(m[1]));
    if (h === "#/admin" && S.isAdmin) return renderAdmin();
    renderList();
  }
  window.addEventListener("hashchange", () => { S.gallery = 0; route(); });

  // ---------- list ----------
  function renderList() {
    if (!S.sample.length) {
      $app.innerHTML = `<div class="card narrow"><h2>No posts yet</h2><p>The sample "${esc(CFG.sampleName)}" has no posts in the database. The project lead loads them with build_sample.py.</p></div>`;
      return;
    }
    const items = S.sample.filter(({ unit }) => {
      const d = !!S.myStatus.get(unit.id)?.done;
      return S.filter === "all" || (S.filter === "done" ? d : !d);
    });
    const nextTodo = S.sample.find(({ unit }) => !S.myStatus.get(unit.id)?.done);
    $app.innerHTML = `
      <section class="list-head">
        <div>
          <h1>Sample: ${esc(CFG.sampleName)}</h1>
          <p class="muted">${doneCount()} of ${S.sample.length} posts marked complete. Every coder sees the same posts in the same order.</p>
        </div>
        ${nextTodo ? `<a class="btn primary" href="#/post/${encodeURIComponent(nextTodo.unit.id)}">${doneCount() ? "Continue coding" : "Start coding"}</a>` : `<span class="pill ok">All done</span>`}
      </section>
      <div class="tabs">
        ${["todo", "done", "all"].map((f) => `<button data-f="${f}" class="${S.filter === f ? "on" : ""}">${{ todo: "To do", done: "Complete", all: "All" }[f]}</button>`).join("")}
      </div>
      <ol class="post-list">
        ${items.map(({ position, unit }) => {
          const st = S.myStatus.get(unit.id);
          const n = unit.media?.length || 0;
          const yes = Object.entries(S.myCodes.get(unit.id) || {}).filter(([, v]) => v).length;
          return `<li><a href="#/post/${encodeURIComponent(unit.id)}">
            <span class="pos">${position}</span>
            <span class="t">${esc(unit.title)}</span>
            <span class="meta">${n ? `${n} image${n > 1 ? "s" : ""}` : unit.media_kind === "link" ? "link" : "text"}</span>
            <span class="st ${st?.done ? "done" : ""}">${st?.done ? `✓ ${yes} code${yes === 1 ? "" : "s"}` : "to do"}</span>
          </a></li>`;
        }).join("") || `<li class="muted empty">Nothing here.</li>`}
      </ol>`;
    $app.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => { S.filter = b.dataset.f; renderList(); }));
  }

  // ---------- post view ----------
  async function signUrls(paths) {
    const need = paths.filter((p) => p && !S.signed.has(p));
    if (!need.length) return;
    const { data, error } = await sb.storage.from(CFG.imageBucket).createSignedUrls(need, 60 * 60 * 6);
    if (error) { console.warn(error); return; }
    for (const d of data || []) if (d.signedUrl) S.signed.set(d.path, d.signedUrl);
  }
  const imgSrc = (m) => (m.path && S.signed.get(m.path)) || m.src;

  function mediaHtml(u) {
    const media = u.media || [];
    let out = "";
    if (u.media_kind === "video") out += `<p class="notice">This post has a video. Open it on Reddit to watch.${media.length ? " A still frame is shown below." : ""}</p>`;
    if (u.media_kind === "link" && u.url) out += `<p class="notice">Link post: <a href="${esc(u.url)}" target="_blank" rel="noopener noreferrer">${esc(u.domain || u.url)}</a></p>`;
    if (!media.length) return out;
    const i = Math.min(S.gallery, media.length - 1);
    const m = media[i];
    out += `<div class="gallery">
      <img src="${esc(imgSrc(m))}" alt="Post image ${i + 1}" data-full="${esc(imgSrc(m))}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'img-missing',textContent:'Image no longer available'}))">
      ${media.length > 1 ? `
        <button class="g-nav prev" ${i === 0 ? "disabled" : ""} aria-label="Previous image">‹</button>
        <button class="g-nav next" ${i === media.length - 1 ? "disabled" : ""} aria-label="Next image">›</button>
        <span class="g-count">${i + 1} / ${media.length}</span>` : ""}
    </div>`;
    if (media.length > 1) out += `<div class="thumbs">${media.map((mm, k) => `<button data-g="${k}" class="${k === i ? "on" : ""}"><img src="${esc(imgSrc(mm))}" alt="" loading="lazy"></button>`).join("")}</div>`;
    return out;
  }

  async function renderPost(id) {
    const idx = S.byId.get(id);
    if (idx === undefined) { $app.innerHTML = `<div class="card narrow"><p>That post is not in this sample.</p><a href="#/">Back to list</a></div>`; return; }
    const { position, unit: u } = S.sample[idx];
    await signUrls((u.media || []).map((m) => m.path));
    if (location.hash !== `#/post/${encodeURIComponent(id)}`) return; // user moved on while loading
    const mine = S.myCodes.get(u.id) || {};
    const st = S.myStatus.get(u.id) || { done: false, note: "" };
    const prev = S.sample[idx - 1], next = S.sample[idx + 1];

    $app.innerHTML = `
      <div class="post-layout">
        <article class="card post">
          <div class="post-meta">
            <b>r/${esc(u.subreddit || "DIYaesthetics")}</b> · Posted by u/${esc(u.author)} · ${fmtDate(u.created_utc)}
            ${u.flair ? `<span class="flair">${esc(u.flair)}</span>` : ""}
          </div>
          <h1 class="post-title">${esc(u.title)}</h1>
          ${u.removed ? `<p class="notice">This post was removed or deleted on Reddit; whatever remains is shown.</p>` : ""}
          <div class="media">${mediaHtml(u)}</div>
          <div class="post-body">${md(u.body)}</div>
          <div class="post-foot">
            <span>▲ ${u.score ?? "?"}</span><span>💬 ${u.num_comments ?? "?"} comments</span>
            <a href="${esc(u.permalink)}" target="_blank" rel="noopener noreferrer">Open on Reddit ↗</a>
            <span class="muted">${esc(u.id)}</span>
          </div>
        </article>

        <aside class="card coder">
          <div class="coder-head">
            <span>Post ${position} of ${S.sample.length}</span>
            ${st.done ? `<span class="pill ok">Complete</span>` : `<span class="pill">To do</span>`}
          </div>
          <div class="codes">
            ${S.codes.map((c, k) => `
              <button class="code ${mine[c.key] ? "yes" : ""}" role="switch" aria-checked="${!!mine[c.key]}" data-key="${esc(c.key)}">
                <span class="sw"></span>
                <span class="txt"><span class="lbl">${k < 9 ? `<kbd>${k + 1}</kbd>` : ""}${esc(c.label)}</span><span class="def">${esc(c.definition || "")}</span></span>
              </button>`).join("")}
          </div>
          <label class="note">Note (optional)<textarea id="note" rows="3" placeholder="Anything unclear about this post">${esc(st.note)}</textarea></label>
          <button class="btn primary wide" id="complete">${st.done ? "Save and go to next" : "Mark complete and go to next"} <kbd>Enter</kbd></button>
          ${st.done ? `<button class="link-btn" id="reopen">Mark as not complete</button>` : ""}
          <div class="pager">
            ${prev ? `<a href="#/post/${encodeURIComponent(prev.unit.id)}">← Previous</a>` : "<span></span>"}
            <a href="#/">List</a>
            ${next ? `<a href="#/post/${encodeURIComponent(next.unit.id)}">Next →</a>` : "<span></span>"}
          </div>
          <p class="hint muted">Unchecked codes are saved as 0 when you mark the post complete. Keys: 1–9 toggle codes, ← → move between posts.</p>
        </aside>
      </div>`;

    // media interactions
    const bindMedia = () => {
      const box = $app.querySelector(".media");
      box.querySelectorAll(".g-nav").forEach((b) => (b.onclick = () => { S.gallery += b.classList.contains("next") ? 1 : -1; box.innerHTML = mediaHtml(u); bindMedia(); }));
      box.querySelectorAll(".thumbs button").forEach((b) => (b.onclick = () => { S.gallery = +b.dataset.g; box.innerHTML = mediaHtml(u); bindMedia(); }));
      const img = box.querySelector(".gallery img");
      if (img) img.onclick = () => openLightbox(img.dataset.full);
    };
    bindMedia();

    $app.querySelectorAll(".code").forEach((b) => (b.onclick = () => toggleCode(u.id, b.dataset.key, b)));
    const note = document.getElementById("note");
    let noteTimer;
    note.oninput = () => { clearTimeout(noteTimer); noteTimer = setTimeout(() => saveStatus(u.id, { note: note.value }), 800); };
    note.onblur = () => { clearTimeout(noteTimer); if ((S.myStatus.get(u.id)?.note || "") !== note.value) saveStatus(u.id, { note: note.value }); };
    document.getElementById("complete").onclick = () => complete(u.id, note.value);
    const re = document.getElementById("reopen");
    if (re) re.onclick = async () => { await saveStatus(u.id, { done: false }); renderPost(u.id); };
    window.scrollTo(0, 0);
  }

  async function toggleCode(unitId, key, btn) {
    const mine = S.myCodes.get(unitId) || {};
    const value = !mine[key];
    mine[key] = value;
    S.myCodes.set(unitId, mine);
    btn.classList.toggle("yes", value);
    btn.setAttribute("aria-checked", value);
    const { error } = await sb.from("codes").upsert(
      { unit_id: unitId, coder_email: S.email, code_key: key, value, updated_at: new Date().toISOString() },
      { onConflict: "unit_id,coder_email,code_key" });
    if (error) {
      mine[key] = !value;
      btn.classList.toggle("yes", !value);
      btn.setAttribute("aria-checked", !value);
      toast("Not saved: " + error.message, true);
    } else toast("Saved");
  }

  async function saveStatus(unitId, patch) {
    const cur = S.myStatus.get(unitId) || { done: false, note: "" };
    const next = { ...cur, ...patch };
    const { error } = await sb.from("unit_status").upsert(
      { unit_id: unitId, coder_email: S.email, done: next.done, note: next.note || null, updated_at: new Date().toISOString() },
      { onConflict: "unit_id,coder_email" });
    if (error) { toast("Not saved: " + error.message, true); return false; }
    S.myStatus.set(unitId, next);
    updatePill();
    return true;
  }

  async function complete(unitId, noteText) {
    const btn = document.getElementById("complete");
    if (btn) btn.disabled = true;
    const mine = S.myCodes.get(unitId) || {};
    const now = new Date().toISOString();
    const rows = S.codes.map((c) => ({ unit_id: unitId, coder_email: S.email, code_key: c.key, value: !!mine[c.key], updated_at: now }));
    const { error } = await sb.from("codes").upsert(rows, { onConflict: "unit_id,coder_email,code_key" });
    if (error) { toast("Not saved: " + error.message, true); if (btn) btn.disabled = false; return; }
    for (const r of rows) mine[r.code_key] = r.value;
    S.myCodes.set(unitId, mine);
    if (!(await saveStatus(unitId, { done: true, note: noteText }))) { if (btn) btn.disabled = false; return; }
    toast("Complete");
    const i = S.byId.get(unitId);
    const after = S.sample.slice(i + 1).concat(S.sample.slice(0, i)).find(({ unit }) => !S.myStatus.get(unit.id)?.done);
    location.hash = after ? `#/post/${encodeURIComponent(after.unit.id)}` : "#/";
    if (!after) { S.filter = "all"; toast("You have finished every post in this sample."); }
  }

  function openLightbox(src) {
    const lb = document.getElementById("lightbox");
    lb.querySelector("img").src = src;
    lb.hidden = false;
  }
  document.getElementById("lightbox").onclick = () => (document.getElementById("lightbox").hidden = true);

  document.addEventListener("keydown", (ev) => {
    if (!document.getElementById("lightbox").hidden && ev.key === "Escape") { document.getElementById("lightbox").hidden = true; return; }
    if (!location.hash.startsWith("#/post/")) return;
    const tag = (ev.target.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "input" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (/^[1-9]$/.test(ev.key)) {
      const b = $app.querySelectorAll(".code")[+ev.key - 1];
      if (b) { ev.preventDefault(); b.click(); }
    } else if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      const links = $app.querySelectorAll(".pager a");
      const a = [...links].find((l) => l.textContent.includes(ev.key === "ArrowRight" ? "Next" : "Previous"));
      if (a) { ev.preventDefault(); location.hash = a.getAttribute("href"); }
    } else if (ev.key === "Enter" && tag !== "button" && tag !== "a") {
      const b = document.getElementById("complete");
      if (b && !b.disabled) { ev.preventDefault(); b.click(); }
    }
  });

  // ---------- admin ----------
  async function renderAdmin() {
    $app.innerHTML = `<p class="muted center">Loading everyone's codes…</p>`;
    let coders, status, codes;
    try {
      coders = await fetchAll(() => sb.from("coders").select("email,name,is_admin").order("email"));
      status = await fetchAll(() => sb.from("unit_status").select("unit_id,coder_email,done,note,updated_at"));
      codes = await fetchAll(() => sb.from("codes").select("unit_id,coder_email,code_key,value,updated_at"));
    } catch (e) {
      $app.innerHTML = `<div class="card narrow"><p class="error">${esc(e.message || e)}</p></div>`;
      return;
    }
    const inSample = (id) => S.byId.has(id);
    status = status.filter((s) => inSample(s.unit_id));
    codes = codes.filter((c) => inSample(c.unit_id));

    const doneBy = new Map(); // unit -> Set(coder)
    for (const s of status) if (s.done) { if (!doneBy.has(s.unit_id)) doneBy.set(s.unit_id, new Set()); doneBy.get(s.unit_id).add(s.coder_email); }
    const val = new Map(); // `${unit}|${coder}|${key}` -> bool
    for (const c of codes) val.set(`${c.unit_id}|${c.coder_email}|${c.code_key}`, c.value);
    const keys = [...S.codes.map((c) => c.key), ...[...new Set(codes.map((c) => c.code_key))].filter((k) => !S.codes.some((c) => c.key === k))];

    // pairwise percent agreement per code, over posts that 2+ coders completed
    const agree = keys.map((k) => {
      let pairs = 0, same = 0, units = 0;
      for (const [uid, set] of doneBy) {
        const cs = [...set];
        if (cs.length < 2) continue;
        units++;
        for (let a = 0; a < cs.length; a++) for (let b = a + 1; b < cs.length; b++) {
          const va = val.get(`${uid}|${cs[a]}|${k}`), vb = val.get(`${uid}|${cs[b]}|${k}`);
          if (va === undefined || vb === undefined) continue;
          pairs++; if (va === vb) same++;
        }
      }
      return { k, units, pct: pairs ? (100 * same) / pairs : null };
    });

    const label = (k) => S.codes.find((c) => c.key === k)?.label || `${k} (no longer in codes.json)`;
    $app.innerHTML = `
      <div class="card">
        <h1>Admin</h1>
        <h3>Progress on sample "${esc(CFG.sampleName)}" (${S.sample.length} posts)</h3>
        <table class="tbl"><thead><tr><th>Coder</th><th>Complete</th><th>Last activity</th></tr></thead><tbody>
          ${coders.map((c) => {
            const mineS = status.filter((s) => s.coder_email === c.email.toLowerCase());
            const last = mineS.map((s) => s.updated_at).sort().pop();
            return `<tr><td>${esc(c.name || c.email)}${c.is_admin ? ' <span class="muted">(admin)</span>' : ""}<br><span class="muted">${esc(c.email)}</span></td><td>${mineS.filter((s) => s.done).length} / ${S.sample.length}</td><td>${last ? new Date(last).toLocaleString() : "–"}</td></tr>`;
          }).join("")}
        </tbody></table>

        <h3>Export</h3>
        <p class="muted">Wide: one row per post and coder, one 0/1 column per code. Long: one row per post, coder, and code. Both include only saved answers; codes left untouched on posts that are not marked complete are blank.</p>
        <p><button class="btn primary" id="exp-wide">Download wide CSV</button> <button class="btn" id="exp-long">Download long CSV</button></p>

        <h3>Quick agreement check</h3>
        <p class="muted">Raw pairwise percent agreement among coders who marked a post complete. This is only for monitoring; compute kappa or alpha from the export.</p>
        <table class="tbl"><thead><tr><th>Code</th><th>Posts with 2+ coders</th><th>Agreement</th></tr></thead><tbody>
          ${agree.map((a) => `<tr><td>${esc(label(a.k))}</td><td>${a.units}</td><td>${a.pct == null ? "–" : a.pct.toFixed(0) + "%"}</td></tr>`).join("")}
        </tbody></table>
      </div>`;

    const meta = (uid) => S.sample[S.byId.get(uid)];
    document.getElementById("exp-long").onclick = () => {
      const rows = [["sample", "position", "unit_id", "permalink", "coder_email", "code_key", "value", "updated_at"]];
      for (const c of codes.sort((a, b) => meta(a.unit_id).position - meta(b.unit_id).position || a.coder_email.localeCompare(b.coder_email))) {
        const m = meta(c.unit_id);
        rows.push([CFG.sampleName, m.position, c.unit_id, m.unit.permalink, c.coder_email, c.code_key, c.value ? 1 : 0, c.updated_at]);
      }
      downloadCsv(rows, `diyaesthetics_${CFG.sampleName}_long.csv`);
    };
    document.getElementById("exp-wide").onclick = () => {
      const st = new Map(status.map((s) => [`${s.unit_id}|${s.coder_email}`, s]));
      const pairs = new Set([...status.map((s) => `${s.unit_id}|${s.coder_email}`), ...codes.map((c) => `${c.unit_id}|${c.coder_email}`)]);
      const rows = [["sample", "position", "unit_id", "permalink", "title", "coder_email", "complete", ...keys, "note", "updated_at"]];
      const sorted = [...pairs].map((p) => p.split("|")).sort((a, b) => meta(a[0]).position - meta(b[0]).position || a[1].localeCompare(b[1]));
      for (const [uid, coder] of sorted) {
        const m = meta(uid), s = st.get(`${uid}|${coder}`);
        rows.push([CFG.sampleName, m.position, uid, m.unit.permalink, m.unit.title, coder, s?.done ? 1 : 0,
          ...keys.map((k) => { const v = val.get(`${uid}|${coder}|${k}`); return v === undefined ? "" : v ? 1 : 0; }),
          s?.note || "", s?.updated_at || ""]);
      }
      downloadCsv(rows, `diyaesthetics_${CFG.sampleName}_wide.csv`);
    };
  }

  function downloadCsv(rows, name) {
    const cell = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const blob = new Blob(["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); a.remove();
  }

  sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") { S.email = null; } });
  boot();
})();
