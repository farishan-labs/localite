# localite

Deploy the current directory as a local HTTPS site.

- **Linux**: `https://<name>.local` via nginx + mkcert + avahi (mDNS) + systemd.
- **macOS**: `https://<name>.test` via Laravel Valet (nginx + dnsmasq + Valet certs).

## Usage

```
cd ~/dev/me
localite            # Linux: https://me.local  /  macOS: https://me.test
localite undeploy   # removes the deployment
localite list       # list deployments
```

## Requirements

**Linux:** nginx, mkcert, avahi-utils, systemctl — and `mkcert -install`.

**macOS:** Laravel Valet (`valet` on PATH) — localite delegates to it rather
than re-implementing nginx/avahi. Install Valet first: https://laravel.com/docs/valet