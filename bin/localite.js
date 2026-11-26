#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir, platform } from "node:os";

const IS_MAC = platform() === "darwin";

const HOME = homedir();
const DATA_DIR = join(HOME, ".local", "share", "localite");
const CERTS_DIR = join(DATA_DIR, "certs");
const REGISTRY_FILE = join(DATA_DIR, "registry.json");
const NGINX_DIR = IS_MAC
  ? join(HOME, ".config", "valet", "Nginx")
  : join(HOME, ".valet", "Nginx");
const LOG_DIR = IS_MAC
  ? join(HOME, ".config", "valet", "Log")
  : join(HOME, ".valet", "Log");
const SYSTEMD_USER_DIR = join(HOME, ".config", "systemd", "user");

function ensureDirs() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(CERTS_DIR, { recursive: true });
  mkdirSync(NGINX_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
}

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: opts.stdio ?? "pipe", encoding: "utf8", ...opts });
}

function has(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function sanitize(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50) || "site";
}

function siteNameFromCwd() {
  return sanitize(basename(process.cwd()));
}

function domainFor(name) {
  return `${name}.local`;
}

function readRegistry() {
  if (!existsSync(REGISTRY_FILE)) return {};
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeRegistry(reg) {
  writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2) + "\n");
}

function nginxConfig(name, rootDir, certDir, proxyPort = null) {
  const domain = domainFor(name);
  const upstream = proxyPort ? `http://127.0.0.1:${proxyPort}` : null;
  if (proxyPort) {
    return `server {
    listen ${IS_MAC ? "127.0.0.1:80" : "80"};
    server_name ${domain};
    return 301 https://$host$request_uri;
}

server {
    listen ${IS_MAC ? "127.0.0.1:443 ssl" : "443 ssl"};\n    http2 on;
    server_name ${domain};

    ssl_certificate ${certDir}/cert.pem;
    ssl_certificate_key ${certDir}/key.pem;

    location / {
        proxy_pass ${upstream};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }

    access_log off;
    error_log ${LOG_DIR}/${domain}-error.log;
}
`;
  }
  return `server {
    listen ${IS_MAC ? "127.0.0.1:80" : "80"};
    server_name ${domain};
    return 301 https://$host$request_uri;
}

server {
    listen ${IS_MAC ? "127.0.0.1:443 ssl" : "443 ssl"};\n    http2 on;
    server_name ${domain};

    root ${rootDir};
    index index.html index.htm;

    ssl_certificate ${certDir}/cert.pem;
    ssl_certificate_key ${certDir}/key.pem;

    location / {
        try_files $uri $uri/ =404;
    }

    autoindex on;

    access_log off;
    error_log ${LOG_DIR}/${domain}-error.log;
}
`;
}

function avahiServiceName(name) {
  return `localite-${name}.service`;
}

function avahiUnit(name) {
  const domain = domainFor(name);
  return `[Unit]
Description=Publish ${domain} via mDNS (localite)
After=avahi-daemon.service

[Service]
Type=simple
ExecStart=/usr/bin/avahi-publish-address -R ${domain} 127.0.0.1
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

// ---------- macOS helpers ----------

function macEnsureHostsEntry(domain) {
  let content = "";
  try { content = readFileSync("/etc/hosts", "utf8"); } catch {}
  const already = content.split("\n").some((l) => l.split(/\s+/).includes(domain));
  if (already) return;
  console.log(`  adding ${domain} to /etc/hosts (requires sudo)...`);
  try {
    run(`sh -c 'echo "127.0.0.1 ${domain}" | sudo tee -a /etc/hosts'`, { stdio: "inherit" });
  } catch (e) {
    console.error("  ! Could not update /etc/hosts automatically.");
    console.error(`    Run manually: echo "127.0.0.1 ${domain}" | sudo tee -a /etc/hosts`);
  }
}

function macRemoveHostsEntry(domain) {
  try {
    run(`sudo sed -i '' '/[[:space:]]${domain}\\([[:space:]]\\|$/d' /etc/hosts`, { stdio: "inherit" });
  } catch (e) {
    console.error("  ! Could not remove /etc/hosts entry automatically.");
    console.error(`    Run manually: sudo sed -i '' '/ ${domain}/d' /etc/hosts`);
  }
}

function macEnsureMkcertCA() {
  if (!has("mkcert")) throw new Error("mkcert not found; install with: brew install mkcert nss");
  let caroot;
  try { caroot = run("mkcert -CAROOT").trim(); } catch { caroot = join(HOME, ".local", "share", "mkcert"); }
  const caCert = join(caroot, "rootCA.pem");
  if (!existsSync(caCert)) {
    console.log("  installing mkcert local CA (may prompt for password)...");
    try { run("mkcert -install", { stdio: "inherit" }); }
    catch (e) {
      console.error("  ! mkcert -install failed. Run manually: mkcert -install");
    }
  }
}

function macReloadNginx() {
  try { run("sudo nginx -t", { stdio: "inherit" }); }
  catch (e) { console.error("  nginx config test failed; see output above"); }
  try { run("sudo nginx -s reload", { stdio: "inherit" }); }
  catch (e) {
    try { run("sudo brew services restart nginx", { stdio: "inherit" }); }
    catch (e2) { console.error("  ! Could not reload nginx. Run: sudo nginx -s reload"); }
  }
}

// ---------- commands ----------

function deploy(nameOverride, proxyPort = null) {
  if (IS_MAC) {
    if (!has("nginx")) throw new Error("nginx not found; install with: brew install nginx");
    if (!has("mkcert")) throw new Error("mkcert not found; install with: brew install mkcert nss");
    ensureDirs();
    const name = sanitize(nameOverride || siteNameFromCwd());
    const domain = domainFor(name);
    const rootDir = proxyPort ? null : resolve(process.cwd());
    const certDir = join(CERTS_DIR, domain);
    mkdirSync(certDir, { recursive: true });

    console.log("Ensuring mkcert CA is installed...");
    macEnsureMkcertCA();

    const certFile = join(certDir, "cert.pem");
    const keyFile = join(certDir, "key.pem");
    if (!existsSync(certFile) || !existsSync(keyFile)) {
      run(`mkcert -cert-file ${certFile} -key-file ${keyFile} ${domain} localhost 127.0.0.1 ::1`);
    }

    const confPath = join(NGINX_DIR, domain);
    writeFileSync(confPath, nginxConfig(name, rootDir, certDir, proxyPort));

    console.log("Updating /etc/hosts...");
    macEnsureHostsEntry(domain);

    const reg = readRegistry();
    reg[name] = { domain, path: rootDir, proxyPort: proxyPort ? Number(proxyPort) : null, deployedAt: new Date().toISOString() };
    writeRegistry(reg);

    console.log("Reloading nginx...");
    macReloadNginx();

    const label = proxyPort ? `proxy -> 127.0.0.1:${proxyPort}` : rootDir;
    console.log(`\n✓ Deployed ${label}`);
    console.log(`  → https://${domain}/\n`);
    return;
  }

  // Linux
  ensureDirs();
  if (!has("nginx")) throw new Error("nginx not found");
  if (!has("mkcert")) throw new Error("mkcert not found");
  if (!has("avahi-publish-address")) throw new Error("avahi-publish-address not found (install avahi-utils)");
  if (!has("systemctl")) throw new Error("systemctl not found");

  const name = sanitize(nameOverride || siteNameFromCwd());
  const domain = domainFor(name);
  const rootDir = proxyPort ? null : resolve(process.cwd());
  const certDir = join(CERTS_DIR, domain);
  mkdirSync(certDir, { recursive: true });

  // cert
  const certFile = join(certDir, "cert.pem");
  const keyFile = join(certDir, "key.pem");
  if (!existsSync(certFile) || !existsSync(keyFile)) {
    run(`mkcert -cert-file ${certFile} -key-file ${keyFile} ${domain} localhost 127.0.0.1 ::1`);
  }

  // nginx config
  const confPath = join(NGINX_DIR, domain);
  writeFileSync(confPath, nginxConfig(name, rootDir, certDir, proxyPort));

  // avahi service
  const svc = avahiServiceName(name);
  const svcPath = join(SYSTEMD_USER_DIR, svc);
  writeFileSync(svcPath, avahiUnit(name));
  run("systemctl --user daemon-reload");
  run(`systemctl --user enable ${svc}`);
  try { run(`systemctl --user restart ${svc}`); } catch { run(`systemctl --user start ${svc}`); }

  // nginx reload
  run("systemctl reload nginx");

  // registry
  const reg = readRegistry();
  reg[name] = { domain, path: rootDir, proxyPort: proxyPort ? Number(proxyPort) : null, deployedAt: new Date().toISOString() };
  writeRegistry(reg);

  const label = proxyPort ? `proxy -> 127.0.0.1:${proxyPort}` : rootDir;
  console.log(`\n✓ Deployed ${label}`);
  console.log(`  → https://${domain}/\n`);
}

function undeploy(nameOverride) {
  if (IS_MAC) {
    if (!has("nginx")) throw new Error("nginx not found");
    ensureDirs();
    const reg = readRegistry();
    let name = nameOverride ? sanitize(nameOverride) : null;
    if (!name) {
      const cwd = resolve(process.cwd());
      for (const [n, info] of Object.entries(reg)) {
        if (info.path === cwd) { name = n; break; }
      }
    }
    if (!name) name = siteNameFromCwd();

    const domain = domainFor(name);

    const confPath = join(NGINX_DIR, domain);
    if (existsSync(confPath)) unlinkSync(confPath);

    macRemoveHostsEntry(domain);

    if (reg[name]) delete reg[name];
    writeRegistry(reg);

    console.log("Reloading nginx...");
    try { macReloadNginx(); } catch {}

    console.log(`\n✓ Undeployed ${domain}\n`);
    return;
  }

  ensureDirs();
  const reg = readRegistry();
  const cwd = resolve(process.cwd());
  let name = nameOverride ? sanitize(nameOverride) : null;
  if (!name) {
    for (const [n, info] of Object.entries(reg)) {
      if (info.path === cwd) { name = n; break; }
    }
  }
  if (!name) name = siteNameFromCwd();

  const domain = domainFor(name);

  const confPath = join(NGINX_DIR, domain);
  if (existsSync(confPath)) unlinkSync(confPath);

  const svc = avahiServiceName(name);
  const svcPath = join(SYSTEMD_USER_DIR, svc);
  try { run(`systemctl --user stop ${svc}`); } catch {}
  try { run(`systemctl --user disable ${svc}`); } catch {}
  if (existsSync(svcPath)) unlinkSync(svcPath);
  try { run("systemctl --user daemon-reload"); } catch {}

  if (reg[name]) delete reg[name];
  writeRegistry(reg);

  try { run("systemctl reload nginx"); } catch {}

  console.log(`\n✓ Undeployed ${domain}\n`);
}

function list() {
  const reg = readRegistry();
  const entries = Object.entries(reg);
  if (entries.length === 0) {
    console.log("No localite deployments.");
    return;
  }
  for (const [name, info] of entries) {
    const extra = info.proxyPort ? `  -> 127.0.0.1:${info.proxyPort}` : `  ${info.path}`;
    console.log(`${name}.local${extra}`);
  }
}

function reload() {
  if (IS_MAC) {
    try {
      run("sudo -n nginx -s reload", { stdio: "inherit" });
    } catch {
      // fall back to a macOS password prompt
      run(`osascript -e 'do shell script "nginx -s reload" with administrator privileges'`, { stdio: "inherit" });
    }
  } else {
    try {
      run("systemctl --user reload nginx", { stdio: "inherit" });
    } catch {
      run("sudo nginx -s reload", { stdio: "inherit" });
    }
  }
  console.log("webserver reloaded");
}

function main() {
  const args = process.argv.slice(2);
  let cmd = args[0];
  let rest = args.slice(1);
  if (cmd && cmd.startsWith("-")) {
    rest = args; // flags first => deploy
    cmd = null;
  }
  const nameFlagIdx = rest.indexOf("--name");
  const nameOverride = nameFlagIdx >= 0 ? rest[nameFlagIdx + 1] : null;
  const proxyFlagIdx = rest.indexOf("--proxy");
  const proxyPort = proxyFlagIdx >= 0 ? rest[proxyFlagIdx + 1] : null;

  try {
    if (!cmd || cmd === "deploy") {
      deploy(nameOverride, proxyPort);
    } else if (cmd === "undeploy") {
      undeploy(nameOverride);
    } else if (cmd === "list") {
      list();
    } else if (cmd === "reload") {
      reload();
    } else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
      console.log(`Usage:
  localite [--name <name>] [--proxy <port>]   Deploy current directory (or proxy a port)
                                  (Linux: https://<name>.local via nginx/avahi)
                                  (macOS: https://<name>.local via nginx/mkcert + /etc/hosts)
  localite undeploy [--name <name>]              Undeploy
  localite list                                  List deployments
  localite reload                                Reload webserver backend (nginx)
  Examples:
    localite --name me
    localite --name cockpit --proxy 7777
`);
    } else {
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}


main();