export const dashboardHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Odorik transcription spike</title>
  <style>
    :root { color-scheme: light; --ink:#17201b; --muted:#617068; --line:#dce5df; --accent:#1a6b46; --soft:#edf7f1; }
    * { box-sizing: border-box; }
    body { margin:0; font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--ink); background:#f7faf8; }
    main { width:min(960px,calc(100% - 32px)); margin:48px auto; }
    header { display:flex; justify-content:space-between; gap:24px; align-items:end; margin-bottom:28px; }
    h1 { margin:0; font-size:clamp(28px,5vw,48px); line-height:1.05; letter-spacing:-.04em; }
    header p { margin:10px 0 0; color:var(--muted); }
    .badge { white-space:nowrap; border:1px solid var(--line); border-radius:999px; padding:7px 12px; background:white; }
    .panel { background:white; border:1px solid var(--line); border-radius:18px; padding:20px; box-shadow:0 16px 50px rgba(27,58,40,.06); }
    .auth { display:grid; grid-template-columns:1fr auto; gap:10px; }
    input,button { font:inherit; border-radius:10px; padding:11px 13px; }
    input { border:1px solid #bdcbc2; min-width:0; }
    button { border:0; background:var(--accent); color:white; font-weight:700; cursor:pointer; }
    button:disabled { opacity:.6; cursor:wait; }
    #status { min-height:24px; margin:12px 2px 0; color:var(--muted); }
    .grid { display:grid; gap:14px; margin-top:18px; }
    article { border:1px solid var(--line); border-radius:14px; padding:18px; background:#fff; }
    article h2 { margin:0 0 4px; font-size:18px; }
    article .meta { color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
    article .summary { margin:14px 0 0; padding:12px 14px; background:var(--soft); border-radius:10px; }
    article details { margin-top:12px; }
    article pre { white-space:pre-wrap; font:14px/1.55 inherit; margin:10px 0 0; }
    .empty { color:var(--muted); text-align:center; padding:40px 20px; }
    @media (max-width:640px) { header{align-items:start;flex-direction:column}.auth{grid-template-columns:1fr}main{margin:28px auto} }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>Call transcription</h1>
      <p>Odorik → Cloud Storage → Gemini Flash-Lite → Firestore Enterprise</p>
    </div>
    <div class="badge" id="serviceBadge">Not connected</div>
  </header>
  <section class="panel">
    <div class="auth">
      <input id="token" type="password" autocomplete="off" placeholder="Dashboard access token">
      <button id="connect">Connect</button>
    </div>
    <div id="status" role="status">Enter the dashboard token to query the tRPC API.</div>
  </section>
  <section class="grid" id="calls"></section>
</main>
<script>
  const tokenInput = document.querySelector('#token');
  const connect = document.querySelector('#connect');
  const status = document.querySelector('#status');
  const calls = document.querySelector('#calls');
  const badge = document.querySelector('#serviceBadge');

  function unwrap(payload) {
    if (payload.error) throw new Error(payload.error.json?.message || payload.error.message || 'tRPC request failed');
    return payload.result?.data?.json ?? payload.result?.data;
  }
  async function trpc(path, input) {
    const query = input === undefined ? '' : '?input=' + encodeURIComponent(JSON.stringify({json: input}));
    const response = await fetch('/trpc/' + path + query, {
      headers: {'x-dashboard-token': tokenInput.value}
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.json?.message || 'Request failed (' + response.status + ')');
    return unwrap(payload);
  }
  function render(items) {
    calls.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'panel empty';
      empty.textContent = 'No recordings have been received yet.';
      calls.append(empty);
      return;
    }
    for (const call of items) {
      const article = document.createElement('article');
      const heading = document.createElement('h2');
      heading.textContent = call.from && call.to ? call.from + ' → ' + call.to : 'Call ' + call.id;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = [call.status, call.duration ? call.duration + ' seconds' : '', call.language || '', call.uploadedAt || call.createdAt || ''].filter(Boolean).join(' · ');
      article.append(heading, meta);
      if (call.summary) {
        const summary = document.createElement('div');
        summary.className = 'summary';
        summary.textContent = call.summary;
        article.append(summary);
      }
      if (call.transcript) {
        const details = document.createElement('details');
        const label = document.createElement('summary');
        label.textContent = 'Transcript';
        const transcript = document.createElement('pre');
        transcript.textContent = call.transcript;
        details.append(label, transcript);
        article.append(details);
      }
      calls.append(article);
    }
  }
  connect.addEventListener('click', async () => {
    connect.disabled = true;
    status.textContent = 'Connecting to tRPC…';
    try {
      const health = await trpc('system.health');
      const items = await trpc('calls.list', {limit: 20});
      badge.textContent = health.model + ' · ' + health.databaseEdition;
      status.textContent = 'Connected. ' + items.length + ' call record' + (items.length === 1 ? '' : 's') + ' loaded.';
      render(items);
    } catch (error) {
      badge.textContent = 'Connection failed';
      status.textContent = error instanceof Error ? error.message : String(error);
      calls.replaceChildren();
    } finally {
      connect.disabled = false;
    }
  });
</script>
</body>
</html>`;

