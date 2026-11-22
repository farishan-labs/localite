#!/usr/bin/env node
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const DATA_DIR = join(HOME, ".local", "share", "localite");
const CERTS_DIR = join(DATA_DIR, "certs");
const REGISTRY_FILE = join(DATA_DIR, "registry.json");
const NGINX_DIR = join(HOME, ".valet", "Nginx");
const SYSTEMD_USER_DIR = join(HOME, ".config", "systemd", "user");

function ensureDirs() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(CERTS_DIR, { recursive: true });
  mkdirSync(NGINX_DIR, { recursive: true });
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

function nginxConfig(name, rootDir, certDir) {
  const domain = domainFor(name);
  return `server {
    listen 80;
    server_name ${domain};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
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
    error_log ${HOME}/.valet/Log/${domain}-error.log;
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

function deploy(nameOverride) {
  ensureDirs();
  for (const cmd of ["nginx", "mkcert", "avahi-publish-address", "systemctl"]) {
    if (!has(cmd === "avahi-publish-address" ? "avahi-publish-address" : cmd)) {
      // avahi-publish-address is part of avahi-utils; check binary
    }
  }
  if (!has("nginx")) throw new Error("nginx not found");
  if (!has("mkcert")) throw new Error("mkcert not found");
  if (!has("avahi-publish-address")) throw new Error("avahi-publish-address not found (install avahi-utils)");
  if (!has("systemctl")) throw new Error("systemctl not found");

  const name = sanitize(nameOverride || siteNameFromCwd());
  const domain = domainFor(name);
  const rootDir = resolve(process.cwd());
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
  writeFileSync(confPath, nginxConfig(name, rootDir, certDir));

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
  reg[name] = { domain, path: rootDir, deployedAt: new Date().toISOString() };
  writeRegistry(reg);

  console.log(`\n✓ Deployed ${rootDir}`);
  console.log(`  → https://${domain}/\n`);
}

function undeploy(nameOverride) {
  ensureDirs();
  const reg = readRegistry();
  // find by cwd if possible
  const cwd = resolve(process.cwd());
  let name = nameOverride ? sanitize(nameOverride) : null;
  if (!name) {
    // find registry entry whose path == cwd
    for (const [n, info] of Object.entries(reg)) {
      if (info.path === cwd) { name = n; break; }
    }
  }
  if (!name) name = siteNameFromCwd();

  const domain = domainFor(name);

  // nginx config
  const confPath = join(NGINX_DIR, domain);
  if (existsSync(confPath)) unlinkSync(confPath);

  // avahi service
  const svc = avahiServiceName(name);
  const svcPath = join(SYSTEMD_USER_DIR, svc);
  try { run(`systemctl --user stop ${svc}`); } catch {}
  try { run(`systemctl --user disable ${svc}`); } catch {}
  if (existsSync(svcPath)) unlinkSync(svcPath);
  try { run("systemctl --user daemon-reload"); } catch {}

  // registry
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
    console.log(`${name}.local  ${info.path}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);
  const nameFlagIdx = rest.indexOf("--name");
  const nameOverride = nameFlagIdx >= 0 ? rest[nameFlagIdx + 1] : null;

  try {
    if (!cmd || cmd === "deploy") {
      deploy(nameOverride);
    } else if (cmd === "undeploy") {
      undeploy(nameOverride);
    } else if (cmd === "list") {
      list();
    } else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
      console.log(`Usage:
  localite [--name <name>]        Deploy current directory to https://<name>.local
  localite undeploy [--name <name>]  Undeploy
  localite list                  List deployments
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
