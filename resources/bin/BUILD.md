# Bundled AWG Binaries

This directory must contain two pre-compiled Linux x86_64 binaries before running `npm run build`:

| File | Source | Purpose |
|------|--------|---------|
| `awg` | amneziawg-tools | CLI configuration tool (equivalent to `wg`) |
| `awg-go` | amneziawg-go | Userspace AWG daemon (creates TUN interface, no kernel module needed) |

## How to build

You need a Linux x86_64 build machine (or Docker).

### awg (CLI tool)

```bash
git clone https://github.com/amnezia-vpn/amneziawg-tools.git
cd amneziawg-tools/src
make
# The fork builds the binary as `wg` — copy it as `awg`
cp wg /path/to/wiredog-vpn-linux/resources/bin/awg
```

### awg-go (userspace daemon)

```bash
git clone https://github.com/amnezia-vpn/amneziawg-go.git
cd amneziawg-go
go build -o awg-go .
# Binary is at: awg-go
cp awg-go /path/to/wiredog-vpn-linux/resources/bin/awg-go
```

Requires Go 1.21+. Both repos are MIT licensed.

## Verify

```bash
file resources/bin/awg      # should say: ELF 64-bit LSB executable, x86-64
file resources/bin/awg-go   # same
strip resources/bin/awg resources/bin/awg-go  # optional: reduce size
```

## Notes

- Both binaries are committed to this repo (they are platform-specific compiled artifacts).
- `awg-go` uses a Linux TUN device — no kernel module required.
- `awg-go` creates its control socket at `/var/run/wireguard/wg0.sock`.
  The systemd service and postinst script both ensure this path is writable.
