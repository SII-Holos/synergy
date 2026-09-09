#!/bin/sh
set -e

if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove synergy /opt/Synergy/resources/synergy/bin/synergy >/dev/null 2>&1 || true
  update-alternatives --remove synergy-desktop /opt/Synergy/synergy-desktop >/dev/null 2>&1 || true
else
  if [ -L /usr/bin/synergy ] && [ "$(readlink /usr/bin/synergy)" = "/opt/Synergy/resources/synergy/bin/synergy" ]; then
    rm -f /usr/bin/synergy
  fi
  if [ -L /usr/bin/synergy-desktop ] && [ "$(readlink /usr/bin/synergy-desktop)" = "/opt/Synergy/synergy-desktop" ]; then
    rm -f /usr/bin/synergy-desktop
  fi
fi

if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications || true
fi

APPARMOR_TARGET="/etc/apparmor.d/io.holosai.synergy"
if [ -f "$APPARMOR_TARGET" ]; then
  if command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser -R "$APPARMOR_TARGET" || true
  fi
  rm -f "$APPARMOR_TARGET" || true
fi

exit 0
