#!/usr/bin/env bash
# Download and build a static bwrap binary for Linux. Supports x86_64 and aarch64.
# Usage: ./scripts/download-bwrap.sh
set -euo pipefail
case "$(uname -s)" in
  Linux) ;;
  *) echo "download-bwrap.sh is Linux-only."; exit 0 ;;
esac


ARCH=$(uname -m)
TARGET_DIR="${HOME}/.synergy/sandbox-helper/bwrap"
BWRAP_BIN="${TARGET_DIR}/bwrap"

case "$ARCH" in
  x86_64)  RELEASE_ARCH="x86_64" ;;
  aarch64) RELEASE_ARCH="aarch64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    echo "Install bubblewrap via your package manager:"
    echo "  sudo apt install bubblewrap    # Debian/Ubuntu"
    echo "  sudo dnf install bubblewrap    # Fedora"
    echo "  brew install bubblewrap        # macOS (Homebrew)"
    exit 0
    ;;
esac

# Bubblewrap v0.11.2 source tarball (latest release as of 2026-04-23)
BWRAP_VER="0.11.2"
BWRAP_TARBALL="bubblewrap-${BWRAP_VER}.tar.xz"
BWRAP_URL="https://github.com/containers/bubblewrap/releases/download/v${BWRAP_VER}/${BWRAP_TARBALL}"
# SHA-256 of the source tarball (from release page)
EXPECTED_SHA256="69abc30005d2186baf7737feacd8da35633b93cf5af38838ecff17c5f8e924f6"

download_and_build() {
  mkdir -p "$TARGET_DIR"

  # Check for required tools
  local missing=""
  for tool in curl tar xz meson ninja gcc; do
    if ! command -v "$tool" &>/dev/null; then
      missing="${missing} ${tool}"
    fi
  done
  if [ -n "$missing" ]; then
    echo "Missing required tools:${missing}"
    return 1
  fi

  local tmpdir
  tmpdir="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmpdir'" EXIT

  local tarball="${tmpdir}/${BWRAP_TARBALL}"

  echo "Downloading bubblewrap ${BWRAP_VER} source from ${BWRAP_URL}..."

  if command -v curl &>/dev/null; then
    if ! curl -fSL --progress-bar -o "$tarball" "$BWRAP_URL"; then
      echo "Download failed (curl returned non-zero)."
      return 1
    fi
  else
    if ! wget -q --show-progress -O "$tarball" "$BWRAP_URL"; then
      echo "Download failed (wget returned non-zero)."
      return 1
    fi
  fi

  # Verify tarball hash
  echo "Verifying tarball checksum..."
  local actual_sha256
  actual_sha256="$(sha256sum "$tarball" 2>/dev/null | cut -d' ' -f1)"
  if [ -z "$actual_sha256" ]; then
    actual_sha256="$(shasum -a 256 "$tarball" 2>/dev/null | cut -d' ' -f1)"
  fi
  if [ -z "$actual_sha256" ]; then
    actual_sha256="$(openssl dgst -sha256 "$tarball" 2>/dev/null | cut -d' ' -f2)"
  fi

  if [ "$actual_sha256" != "$EXPECTED_SHA256" ]; then
    echo "Tarball hash mismatch!"
    echo "  Expected: ${EXPECTED_SHA256}"
    echo "  Got:      ${actual_sha256:-unavailable}"
    return 1
  fi
  echo "Tarball hash verified."

  # Extract
  echo "Extracting..."
  tar -xJf "$tarball" -C "$tmpdir"
  local srcdir="${tmpdir}/bubblewrap-${BWRAP_VER}"

  # Build
  echo "Building static bwrap..."
  if ! meson setup "${srcdir}/builddir" "$srcdir" \
       -Dbuildtype=release \
       -Ddefault_library=static \
       -Db_lto=true \
       --prefer-static; then
    echo "meson setup failed."
    return 1
  fi

  if ! meson compile -C "${srcdir}/builddir"; then
    echo "meson compile failed."
    return 1
  fi

  # Install
  cp "${srcdir}/builddir/bwrap" "$BWRAP_BIN"
  chmod +x "$BWRAP_BIN"
  echo "bwrap installed to ${BWRAP_BIN}"
  return 0
}

if download_and_build; then
  exit 0
else
  echo ""
  echo "Automatic build failed. Install bubblewrap via your package manager:"
  echo "  sudo apt install bubblewrap    # Debian/Ubuntu"
  echo "  sudo dnf install bubblewrap    # Fedora"
  echo "  brew install bubblewrap        # macOS (Homebrew)"
  echo ""
  echo "Or build from source manually:"
  echo "  git clone https://github.com/containers/bubblewrap"
  echo "  cd bubblewrap"
  echo "  meson setup builddir -Dbuildtype=release"
  echo "  meson compile -C builddir"
  echo "  cp builddir/bwrap ${BWRAP_BIN}"
  exit 1
fi
