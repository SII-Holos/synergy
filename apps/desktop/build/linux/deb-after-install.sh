#!/bin/sh
set -e

DESKTOP_TARGET="/opt/Synergy/synergy-desktop"
CLI_TARGET="/opt/Synergy/resources/synergy/bin/synergy"
SANDBOX="/opt/Synergy/chrome-sandbox"
APPARMOR_SOURCE="/opt/Synergy/io.holosai.synergy"
APPARMOR_TARGET="/etc/apparmor.d/io.holosai.synergy"

if [ -f "$SANDBOX" ] && [ ! -L "$SANDBOX" ]; then
  chown root:root "$SANDBOX"
  chmod 4755 "$SANDBOX"
fi

if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove synergy /opt/Synergy/synergy >/dev/null 2>&1 || true
  if [ -e "$DESKTOP_TARGET" ]; then
    update-alternatives --install /usr/bin/synergy-desktop synergy-desktop "$DESKTOP_TARGET" 100
  fi
  if [ -e "$CLI_TARGET" ]; then
    update-alternatives --install /usr/bin/synergy synergy "$CLI_TARGET" 100
  fi
else
  if [ -L /usr/bin/synergy ] && [ "$(readlink /usr/bin/synergy)" = "/opt/Synergy/synergy" ]; then
    rm -f /usr/bin/synergy
  fi
  [ -e "$DESKTOP_TARGET" ] && ln -sfn "$DESKTOP_TARGET" /usr/bin/synergy-desktop
  [ -e "$CLI_TARGET" ] && ln -sfn "$CLI_TARGET" /usr/bin/synergy
fi

if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications || true
fi

if [ -d /etc/apparmor.d ] && [ -f "$APPARMOR_SOURCE" ]; then
  cp -f "$APPARMOR_SOURCE" "$APPARMOR_TARGET" || true
  if command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser -r "$APPARMOR_TARGET" || true
  fi
fi

exit 0
