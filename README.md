# WireDog VPN - Linux Application

Copyright (c) 2026 WireDog Technologies

[![License: GPLv3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![Electron](https://img.shields.io/badge/Electron-latest-blue.svg)](https://www.electronjs.org)
[![Platform: Linux](https://img.shields.io/badge/Platform-Linux-orange.svg)](https://www.linux.org)

## Features

- **WireGuard VPN Protocol** - Modern, efficient, and secure VPN implementation
- **Secure Authentication** - Email/password and anonymous account options
- **Kill Switch** - Prevents data leaks if VPN connection drops
- **Split Tunneling** - Route only selected traffic through the VPN
- **DNS & IPv6 Leak Protection** - Ensures all traffic stays private
- **Server Selection** - Choose from multiple VPN servers with favorites/recents
- **Subscription Management** - Built-in subscription validation and management
- **Privileged Backend Service** - Isolated root-level daemon via systemd, minimal attack surface
- **On-Device Logging** - Privacy-respecting debug logs with PII redaction

## Requirements

- **OS**: Linux (Debian/Ubuntu-based distributions recommended)
- **Node.js**: 18 or later
- **wireguard-tools**: `wg` binary must be installed (`sudo apt install wireguard-tools`)
- **iptables**: For kill switch and firewall rules
- **dpkg** and **fakeroot**: For building the `.deb` package

## Development Setup

### 1. Install system dependencies

```bash
sudo apt install wireguard-tools iptables
```

### 2. Install Node dependencies

```bash
npm install
cd service && npm install && cd ..
```

### 3. Build the backend service

```bash
npm run build:service
```

### 4. Start the app (frontend + Electron)

```bash
npm run dev
```

### 5. Start the backend service in a separate terminal (required for VPN functionality)

```bash
sudo NODE_ENV=development node service/dist/index.js
```

### 6. Rebuild the service after changes to `service/src/`

```bash
cd service && npm run build
```

## Production Build

### Build the `.deb` package

```bash
npm run build:production
```

This runs all steps in sequence:
1. Compiles the backend service TypeScript (`service/dist/index.js`)
2. Bundles the Vite/React frontend (`dist/`)
3. Packages everything into a `.deb` via electron-builder

Output: `release/WireDog-VPN-<version>.deb`

## Project Structure

```
wiredog-vpn-linux/
├── electron/                 # Electron main process
├── src/                      # React frontend (TypeScript + Vite)
│   ├── components/           # Reusable UI components
│   ├── pages/                # Application pages/views
│   ├── hooks/                # React hooks
│   └── lib/                  # Utilities and helpers
├── service/                  # Privileged backend daemon (Node.js + TypeScript)
│   └── src/                  # VPN management, iptables, WireGuard IPC
├── debian/                   # Debian package configuration
├── polkit/                   # Polkit policy files
└── docs/                     # Documentation
```

## Security Issues

**Do not open public GitHub issues for security vulnerabilities.**

If you believe you have found a security vulnerability, please email support@wiredogvpn.com with a description of the vulnerability, steps to reproduce, potential impact, and suggested fix if available.

## License

Licensed under the **GNU General Public License v3 (GPLv3)**. See [`LICENSE`](LICENSE) for details.

This project relies on WireGuard and other open-source tools. See [`ACKNOWLEDGMENTS.md`](ACKNOWLEDGMENTS.md) for full attribution.

## Questions?

- Open a [GitHub Issue](https://github.com/[fill]/wiredog-vpn-linux/issues)
- Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution guidelines
