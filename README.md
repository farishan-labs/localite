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

- nginx, mkcert, avahi-utils, systemctl
- mkcert CA installed (`mkcert -install`)
