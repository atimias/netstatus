'use strict';

// dns.lookup działa w puli wątków libuv (domyślnie 4) – przy wielu nazwach to wąskie gardło
process.env.UV_THREADPOOL_SIZE ||= '32';

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns');
const { execFile } = require('child_process');

const ROOT = __dirname;
const HOSTS_FILE = path.join(ROOT, 'hosts.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DNS_CACHE_FILE = path.join(ROOT, 'dns-cache.json');

const DEFAULTS = {
  port: 80,          // port TCP testowany na każdym hoście
  listenPort: 3000,  // port, na którym nasłuchuje strona www
  listenHost: '0.0.0.0', // adres nasłuchu ('127.0.0.1' = tylko lokalnie)
  interval: 5000,    // co ile ms powtarzać sprawdzanie
  pingTimeout: 1000, // ms
  tcpTimeout: 1000,  // ms
  concurrency: 64,   // ile hostów sprawdzać równolegle
  dnsTtl: 3600,      // s – po tym czasie nazwa jest odświeżana w tle (stary IP używany do tego czasu)
  dnsTimeout: 3000,  // ms – limit czasu pierwszego rozwiązania nazwy
};

// ---------- wczytywanie plików ----------

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg.listenPort == null && cfg.httpPort != null) cfg.listenPort = cfg.httpPort; // stara nazwa
    return { ...DEFAULTS, ...cfg };
  } catch (err) {
    console.error(`[config] ${err.message} – używam wartości domyślnych`);
    return { ...DEFAULTS };
  }
}

// hosts.json: jeden host (IP lub nazwa) na linię; puste linie i "# komentarze" są pomijane.
// Akceptowana jest też tablica JSON: ["1.2.3.4", "example.com"].
function loadHosts() {
  let raw;
  try {
    raw = fs.readFileSync(HOSTS_FILE, 'utf8');
  } catch (err) {
    console.error(`[hosts] ${err.message}`);
    return [];
  }
  let list;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) list = parsed.map(String);
  } catch { /* nie JSON – format linia po linii */ }
  if (!list) list = raw.split(/\r?\n/);
  const seen = new Set();
  return list
    .map((l) => l.replace(/#.*/, '').trim().replace(/^["',\s]+|["',\s]+$/g, ''))
    .filter((h) => h && !seen.has(h) && seen.add(h));
}

// ---------- testy ----------

function ping(host, timeoutMs) {
  const win = process.platform === 'win32';
  const mac = process.platform === 'darwin';
  const args = win
    ? ['-n', '1', '-w', String(timeoutMs), host]
    : mac
      ? ['-n', '-c', '1', '-W', String(timeoutMs), host]
      : ['-n', '-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host];
  const started = Date.now();
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: timeoutMs + 1500, windowsHide: true }, (err, stdout) => {
      const out = String(stdout || '');
      // Windows zwraca kod 0 także dla "Destination host unreachable", więc sprawdzamy TTL
      const up = !err && (!win || /TTL=/i.test(out));
      const m = out.match(/time[=<]\s*([\d.]+)\s*ms/i);
      resolve({ up, ms: up ? (m ? parseFloat(m[1]) : Date.now() - started) : null });
    });
  });
}

function tcpCheck(host, port, timeoutMs) {
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      sock.destroy();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ open, ms: open ? Math.round(ms * 10) / 10 : null });
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

// ---------- cache DNS ----------
// Nazwa jest rozwiązywana raz, potem ping i TCP idą bezpośrednio na IP.
// Cache trafia do dns-cache.json, więc po restarcie nie trzeba czekać na DNS.

const dnsCache = new Map(); // nazwa -> { ip, resolvedAt }
const dnsPending = new Map(); // nazwa -> Promise
let dnsSaveTimer = null;

try {
  for (const [name, e] of Object.entries(JSON.parse(fs.readFileSync(DNS_CACHE_FILE, 'utf8')))) {
    if (e && net.isIP(e.ip)) dnsCache.set(name, e);
  }
} catch { /* brak pliku – pusty cache */ }

function saveDnsCache() {
  clearTimeout(dnsSaveTimer);
  dnsSaveTimer = setTimeout(() => {
    fs.writeFile(DNS_CACHE_FILE, JSON.stringify(Object.fromEntries(dnsCache), null, 2) + '\n', (err) => {
      if (err) console.error(`[dns] zapis cache: ${err.message}`);
    });
  }, 1000);
}

function lookup(name, timeoutMs) {
  if (dnsPending.has(name)) return dnsPending.get(name);
  let timer;
  const p = Promise.race([
    dns.promises.lookup(name).then((r) => r.address),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
  ])
    .then((ip) => {
      const prev = dnsCache.get(name);
      dnsCache.set(name, { ip, resolvedAt: Date.now() });
      if (!prev || prev.ip !== ip) saveDnsCache();
      return ip;
    })
    .finally(() => {
      clearTimeout(timer);
      dnsPending.delete(name);
    });
  dnsPending.set(name, p);
  return p;
}

// Zwraca IP (albo null, gdy nazwy nie da się rozwiązać).
async function resolveHost(host, cfg) {
  if (net.isIP(host)) return host;
  const cached = dnsCache.get(host);
  if (cached) {
    if (Date.now() - cached.resolvedAt > cfg.dnsTtl * 1000) {
      // odświeżenie w tle; w razie błędu zostaje stary adres
      lookup(host, cfg.dnsTimeout).catch(() => {});
    }
    return cached.ip;
  }
  try {
    return await lookup(host, cfg.dnsTimeout);
  } catch {
    return null;
  }
}

// ---------- stan + pętla sprawdzania ----------

const state = {
  port: null,
  interval: null,
  hosts: {},  // host -> { host, ip, ping, pingMs, tcp, tcpMs, checkedAt, changedAt }
  order: [],
  lastRun: null,
};
const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function snapshot() {
  return {
    port: state.port,
    interval: state.interval,
    lastRun: state.lastRun,
    hosts: state.order.map((h) => state.hosts[h]),
  };
}

async function checkHost(host, cfg) {
  const ip = await resolveHost(host, cfg);
  const [p, t] = ip
    ? await Promise.all([ping(ip, cfg.pingTimeout), tcpCheck(ip, cfg.port, cfg.tcpTimeout)])
    : [{ up: false, ms: null }, { open: false, ms: null }];
  const prev = state.hosts[host];
  if (!prev) return; // host usunięty w trakcie sprawdzania
  const changed = prev.ping !== p.up || prev.tcp !== t.open;
  Object.assign(prev, {
    ip: net.isIP(host) ? null : ip,
    ping: p.up,
    pingMs: p.ms,
    tcp: t.open,
    tcpMs: t.ms,
    checkedAt: Date.now(),
    changedAt: changed ? Date.now() : prev.changedAt,
  });
  broadcast('host', prev);
}

async function runCycle() {
  const cfg = loadConfig();
  const hosts = loadHosts();

  const listChanged =
    hosts.length !== state.order.length || hosts.some((h, i) => h !== state.order[i]);
  const portChanged = state.port !== cfg.port;
  if (listChanged || portChanged) {
    const next = {};
    for (const h of hosts) {
      const old = state.hosts[h];
      if (!old) {
        const cached = net.isIP(h) ? null : dnsCache.get(h);
        next[h] = { host: h, ip: cached ? cached.ip : null, ping: null, pingMs: null, tcp: null, tcpMs: null, checkedAt: null, changedAt: null };
      } else if (portChanged) {
        // ping zostaje, wynik portu jest nieaktualny
        next[h] = { ...old, tcp: null, tcpMs: null };
      } else {
        next[h] = old;
      }
    }
    state.hosts = next;
    state.order = hosts;
  }
  state.port = cfg.port;
  state.interval = cfg.interval;
  if (listChanged || portChanged) broadcast('snapshot', snapshot());

  // równoległe sprawdzanie z limitem
  const queue = [...hosts];
  const workers = Array.from({ length: Math.min(cfg.concurrency, queue.length) }, async () => {
    while (queue.length) await checkHost(queue.shift(), cfg);
  });
  await Promise.all(workers);

  state.lastRun = Date.now();
  broadcast('cycle', { lastRun: state.lastRun });
  return cfg;
}

async function loop() {
  let cfg = DEFAULTS;
  try {
    cfg = await runCycle();
  } catch (err) {
    console.error('[cycle]', err);
  }
  setTimeout(loop, Math.max(500, cfg.interval));
}

// ---------- serwer HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(snapshot()));
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`retry: 2000\nevent: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ka = setInterval(() => res.write(': ka\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ka);
      clients.delete(res);
    });
    return;
  }

  const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const startCfg = loadConfig();
const listenPort = Number(process.env.PORT) || startCfg.listenPort;
server.on('error', (err) => {
  console.error(`[http] nie mogę nasłuchiwać na ${startCfg.listenHost}:${listenPort} – ${err.message}`);
  process.exit(1);
});
server.listen(listenPort, startCfg.listenHost, () => {
  console.log(`netstatus: http://localhost:${listenPort} (nasłuch ${startCfg.listenHost}:${listenPort})`);
  loop();
});
