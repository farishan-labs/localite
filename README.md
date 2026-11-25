# localite

Deploy the current directory as a local HTTPS site at `https://<name>.local`.

## Usage

```bash
cd ~/dev/me
localite            # deploys to https://me.local
localite undeploy   # removes the deployment
localite list       # list deployments
```

## Requirements

Linux:
- nginx, mkcert, avahi-utils, systemctl
- mkcert CA installed (`mkcert -install`)

macOS:
- nginx, mkcert (`brew install nginx mkcert nss`)
- mkcert CA installed (`mkcert -install`) — may prompt for your password
- sudo access (localite updates `/etc/hosts` and reloads nginx)

## Notes (macOS)

`.local` is normally reserved for Bonjour/mDNS on macOS. localite avoids that
conflict by resolving each deployed name through `/etc/hosts` (127.0.0.1)
instead of mDNS, so `https://<name>.local` works reliably in the browser.

Existing Laravel Valet (`.test`) sites are left untouched; localite manages
its own `.local` sites alongside them.