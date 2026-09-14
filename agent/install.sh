#!/bin/sh
# wharfinger-agent installer: downloads the release binary, verifies its
# sha256, writes the env file, and installs a systemd or OpenRC unit.
#
#   curl -fsSL https://github.com/Quad4-Software/Wharfinger/releases/latest/download/install.sh \
#     | sh -s -- --hub https://status.example.com --token st_... --key ...
#
# Idempotent: re-running upgrades the binary and restarts the service.
set -eu

REPO="${WHARFINGER_REPO:-Quad4-Software/Wharfinger}"
VERSION=""
HUB=""
TOKEN=""
KEY=""
NAME=""
INTERVAL="15s"
SELF_UPDATE=0
UPDATE_INTERVAL=""
UNINSTALL=0

usage() {
	cat <<'EOF'
Usage: install.sh --hub URL --token TOKEN [options]

  --hub URL            hub base URL, e.g. https://status.example.com
  --token TOKEN        registration bearer token from the admin panel
  --key KEY            hub ed25519 public key (GET /ingress/pubkey)
  --name NAME          display name override (defaults to hostname)
  --interval DUR       sample interval as a Go duration (default 15s)
  --version VER        release tag to install (default: latest)
  --self-update        enable the checksum-verified auto-updater
  --update-interval DUR  update check interval (default 24h, min 1m)
  --uninstall          remove the agent, unit, and env file
EOF
}

die() { echo "install: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
	case "$1" in
		--hub) HUB="${2:?--hub needs a value}"; shift 2 ;;
		--token) TOKEN="${2:?--token needs a value}"; shift 2 ;;
		--key) KEY="${2:?--key needs a value}"; shift 2 ;;
		--name) NAME="${2:?--name needs a value}"; shift 2 ;;
		--interval) INTERVAL="${2:?--interval needs a value}"; shift 2 ;;
		--version) VERSION="${2:?--version needs a value}"; shift 2 ;;
		--self-update) SELF_UPDATE=1; shift ;;
		--update-interval) UPDATE_INTERVAL="${2:?--update-interval needs a value}"; shift 2 ;;
		--uninstall) UNINSTALL=1; shift ;;
		-h|--help) usage; exit 0 ;;
		*) die "unknown flag $1" ;;
	esac
done

[ "$(id -u)" = "0" ] || die "must run as root"
command -v curl >/dev/null || die "curl required"

INIT=none
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
	INIT=systemd
elif command -v rc-service >/dev/null 2>&1; then
	INIT=openrc
fi

if [ "$UNINSTALL" = "1" ]; then
	case "$INIT" in
		systemd)
			systemctl disable --now wharfinger-agent 2>/dev/null || true
			rm -f /etc/systemd/system/wharfinger-agent.service
			systemctl daemon-reload
			;;
		openrc)
			rc-service wharfinger-agent stop 2>/dev/null || true
			rc-update del wharfinger-agent 2>/dev/null || true
			rm -f /etc/init.d/wharfinger-agent /etc/conf.d/wharfinger-agent
			;;
	esac
	rm -f /usr/local/bin/wharfinger-agent /etc/wharfinger-agent.env
	echo "install: wharfinger-agent removed"
	exit 0
fi

[ -n "$HUB" ] || die "--hub required (hub base URL)"
[ -n "$TOKEN" ] || die "--token required (from the Systems page)"
[ "$INIT" != "none" ] || die "no supported init system found (systemd or OpenRC)"

ARCH=$(uname -m)
case "$ARCH" in
	x86_64) ARCH=amd64 ;;
	aarch64|arm64) ARCH=arm64 ;;
	*) die "unsupported architecture $ARCH" ;;
esac

if [ -n "$VERSION" ]; then
	BASE="https://github.com/$REPO/releases/download/$VERSION"
else
	BASE="https://github.com/$REPO/releases/latest/download"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "install: downloading wharfinger-agent for linux/$ARCH"
curl -fsSL "$BASE/wharfinger-agent-linux-$ARCH" -o "$TMP/wharfinger-agent-linux-$ARCH"
curl -fsSL "$BASE/SHA256SUMS.txt" -o "$TMP/SHA256SUMS.txt"

# Verify the binary against the signed release checksums; the file
# keeps its release name so sha256sum -c can find it.
(cd "$TMP" && grep "wharfinger-agent-linux-$ARCH" SHA256SUMS.txt | sha256sum -c -) \
	|| die "checksum verification failed"

install -m 0755 "$TMP/wharfinger-agent-linux-$ARCH" /usr/local/bin/wharfinger-agent

umask 077
{
	echo "HUB_URL=$HUB"
	echo "TOKEN=$TOKEN"
	[ -n "$KEY" ] && echo "KEY=$KEY"
	[ -n "$NAME" ] && echo "SYSTEM_NAME=$NAME"
	echo "INTERVAL=$INTERVAL"
	[ "$SELF_UPDATE" = "1" ] && echo "SELF_UPDATE=1"
	[ -n "$UPDATE_INTERVAL" ] && echo "UPDATE_INTERVAL=$UPDATE_INTERVAL"
} > /etc/wharfinger-agent.env

case "$INIT" in
	systemd)
		curl -fsSL "$BASE/wharfinger-agent.service" -o /etc/systemd/system/wharfinger-agent.service \
			|| die "failed to download the systemd unit"
		systemctl daemon-reload
		systemctl enable --now wharfinger-agent
		;;
	openrc)
		curl -fsSL "$BASE/wharfinger-agent.openrc" -o /etc/init.d/wharfinger-agent \
			|| die "failed to download the OpenRC script"
		chmod 0755 /etc/init.d/wharfinger-agent
		# conf.d is sourced by the runscript; exports reach the daemon.
		printf 'export HUB_URL="%s"\nexport TOKEN="%s"\n' "$HUB" "$TOKEN" > /etc/conf.d/wharfinger-agent
		[ -n "$KEY" ] && printf 'export KEY="%s"\n' "$KEY" >> /etc/conf.d/wharfinger-agent
		[ -n "$NAME" ] && printf 'export SYSTEM_NAME="%s"\n' "$NAME" >> /etc/conf.d/wharfinger-agent
		printf 'export INTERVAL="%s"\n' "$INTERVAL" >> /etc/conf.d/wharfinger-agent
		[ "$SELF_UPDATE" = "1" ] && printf 'export SELF_UPDATE=1\n' >> /etc/conf.d/wharfinger-agent
		[ -n "$UPDATE_INTERVAL" ] && printf 'export UPDATE_INTERVAL="%s"\n' "$UPDATE_INTERVAL" >> /etc/conf.d/wharfinger-agent
		chmod 0600 /etc/conf.d/wharfinger-agent
		rc-update add wharfinger-agent default
		rc-service wharfinger-agent restart
		;;
esac

echo "install: wharfinger-agent installed and started (init: $INIT)"
echo "install: logs via 'journalctl -u wharfinger-agent -f' or /var/log/wharfinger-agent.log"
