# Docker Logging Policy

This policy caps Docker container log growth to prevent disk pressure on the host.

## Daemon-wide (recommended)

Edit `/etc/docker/daemon.json` on the host:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

Then restart Docker:

```bash
sudo systemctl restart docker
```

Notes:
- Existing containers pick up daemon changes on restart/recreate.
- These caps are safe defaults for most workloads.

## Compose overrides (in-repo)

All services in `docker-compose.yml` include:

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

Compose-level configuration ensures consistent behavior even if daemon defaults differ.


